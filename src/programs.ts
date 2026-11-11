// What an agent's commands left running: a development server, a watcher, a build that was put
// into the background. A command's shell is the leader of a process group of its own, and what it
// starts stays in that group. So the daemon notes the group of every command, per conversation,
// and a program that is still there after its command's shell has gone is one that was left
// running. Nothing here depends on what the agent says it started.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { bin, shq } from "./security.ts";

export interface Program {
	/** The process group. What `stop` takes. */
	id: number;
	/** The command line of the program, as the system shows it. */
	command: string;
	/** How many processes belong to it. */
	processes: number;
	/** TCP ports it listens on. */
	ports: number[];
	/** How long it has been running. */
	seconds: number;
}

interface Row {
	pid: number;
	group: number;
	seconds: number;
	command: string;
}

/** "[[days-]hours:]minutes:seconds", as ps prints how long a process has run. */
export function elapsed(text: string): number {
	const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
	return m ? Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]) : 0;
}

/** Every process of this machine with its group. Empty when ps cannot be asked. */
function processes(): Row[] {
	let out = "";
	try {
		out = execFileSync(bin("ps"), ["-Ao", "pid=,pgid=,etime=,command="], { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return [];
	}
	const rows: Row[] = [];
	for (const line of out.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		if (m) rows.push({ pid: Number(m[1]), group: Number(m[2]), seconds: elapsed(m[3]), command: m[4] });
	}
	return rows;
}

/** The TCP ports each of these processes listens on. lsof where there is one (macOS, most Linux systems), ss otherwise. */
function listening(pids: number[]): Map<number, number[]> {
	const found = new Map<number, number[]>();
	const add = (pid: number, port: number) => {
		if (!pids.includes(pid) || !(port > 0)) return;
		const list = found.get(pid) ?? [];
		if (!list.includes(port)) list.push(port);
		found.set(pid, list);
	};
	if (!pids.length) return found;
	const run = (program: string, args: string[]) => {
		try {
			return execFileSync(program, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
		} catch (e) {
			// lsof ends with an error when one of the processes has nothing open; what it printed still counts.
			return String((e as { stdout?: unknown }).stdout ?? "");
		}
	};
	// Neither lies where commands usually do.
	const tool = (name: string) => ["/usr/sbin", "/usr/bin", "/sbin", "/bin", "/usr/local/bin"].map((d) => path.join(d, name)).find((f) => fs.existsSync(f));
	const lsof = tool("lsof");
	if (lsof) {
		let pid = 0;
		for (const line of run(lsof, ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pids.join(","), "-Fpn"]).split("\n")) {
			if (line.startsWith("p")) pid = Number(line.slice(1));
			else if (line.startsWith("n")) add(pid, Number(line.slice(line.lastIndexOf(":") + 1)));
		}
		return found;
	}
	const ss = tool("ss");
	for (const line of ss ? run(ss, ["-ltnpH"]).split("\n") : []) {
		// "LISTEN 0 511 *:5173 *:* users:(("node",pid=123,fd=20))": the fourth column is where it listens.
		const local = line.trim().split(/\s+/)[3] ?? "";
		const port = Number(local.slice(local.lastIndexOf(":") + 1));
		for (const m of line.matchAll(/pid=(\d+)/g)) add(Number(m[1]), port);
	}
	return found;
}

export class Programs {
	private dir: string;

	/** `dir` lies in pine's home, where no agent can write: an agent cannot put a group on a list. */
	constructor(dir: string) {
		this.dir = dir;
		fs.mkdirSync(dir, { recursive: true });
	}

	private file(conversation: string): string {
		return path.join(this.dir, encodeURIComponent(conversation));
	}

	/**
	 * Shell text to put in front of a command of this conversation, before its sandbox: the
	 * shell notes its own process group. It runs with the daemon's rights, so it is fixed text.
	 */
	note(conversation: string): string {
		return `echo "$$" >> ${shq(this.file(conversation))}; `;
	}

	private groups(conversation: string): number[] {
		try {
			return [...new Set(fs.readFileSync(this.file(conversation), "utf8").split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 1))];
		} catch {
			return [];
		}
	}

	/** What this conversation's commands left running. Groups with nothing left in them are forgotten on the way. */
	list(conversation: string): Program[] {
		const groups = this.groups(conversation);
		if (!groups.length) return [];
		const all = processes();
		// ps could not be asked: nothing can be said, and nothing is forgotten.
		if (!all.length) return [];
		const alive: number[] = [];
		const left: Array<{ id: number; rows: Row[] }> = [];
		for (const id of groups) {
			const rows = all.filter((r) => r.group === id);
			if (!rows.length) continue;
			alive.push(id);
			// While the shell that leads the group is there, its command is still being run.
			if (!rows.some((r) => r.pid === id)) left.push({ id, rows });
		}
		if (alive.length !== groups.length) {
			if (alive.length) fs.writeFileSync(this.file(conversation), `${alive.join("\n")}\n`);
			else fs.rmSync(this.file(conversation), { force: true });
		}
		const ports = listening(left.flatMap((p) => p.rows.map((r) => r.pid)));
		return left.map(({ id, rows }) => {
			// The program is what listens; failing that, what has been there longest.
			const main = rows.find((r) => ports.has(r.pid)) ?? [...rows].sort((a, b) => b.seconds - a.seconds || a.pid - b.pid)[0];
			return { id, command: main.command, processes: rows.length, ports: [...new Set(rows.flatMap((r) => ports.get(r.pid) ?? []))].sort((a, b) => a - b), seconds: Math.max(...rows.map((r) => r.seconds)) };
		});
	}

	/** Stop one of this conversation's programs: asked first, and ended a moment later if it is still there. */
	stop(conversation: string, id: number): boolean {
		if (!this.list(conversation).some((p) => p.id === id)) return false;
		const signal = (name: NodeJS.Signals) => {
			try {
				process.kill(-id, name);
				return true;
			} catch {
				return false;
			}
		};
		if (!signal("SIGTERM")) return false;
		setTimeout(() => {
			if (this.list(conversation).some((p) => p.id === id)) signal("SIGKILL");
		}, 2000).unref?.();
		return true;
	}

	/** Stop everything a conversation left running: it is being reset or removed. */
	stopAll(conversation: string): number {
		const running = this.list(conversation);
		for (const p of running) this.stop(conversation, p.id);
		return running.length;
	}
}
