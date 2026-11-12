// What an agent's commands left running: a development server, a watcher, a build that was put
// into the background. A command's shell is the leader of a process group of its own, and what it
// starts stays in that group. So the daemon notes the group of every command, per conversation,
// and a program that is still there after its command's shell has gone is one that was left
// running. Nothing here depends on what the agent says it started.
//
// A command can also be put into the background on purpose (the shell tool's `background`).
// Then the daemon starts it itself, in the sandbox of its conversation, keeps a record of it in
// pine's home and sees it end, so that its conversation can be told how. See `start`.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { bin, shq } from "./security.ts";
import type { ReplyTarget } from "./types.ts";

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
	/** A command started in the background that is still being run. Its conversation is told when it ends. */
	background?: boolean;
	/** For such a command: the file its output goes to, in the agent's own temp folder. */
	output?: string;
}

/** A command started in the background, from its start until its conversation has been told how it ended. */
export interface Background {
	/** Its process group: the id of the program, as for everything else here. */
	id: number;
	/** The name of its files: the record in pine's home and the output in the agent's folder. */
	token: string;
	/** The conversation that started it ("agent:session"), which is told when it ends. */
	conversation: string;
	agent: string;
	/** The command as the agent gave it. Shown, never run from here again. */
	command: string;
	/** Where its output goes. The agent's file: the daemon reads it only through the agent's sandbox. */
	output: string;
	started: number;
	/** Where the answer of the task that started it goes. The answer about its end goes there too. */
	reply?: ReplyTarget;
	/** What the conversation had read from outside when it started the command, if anything. */
	tainted?: string;
	/** Who stopped it. The agent knows what it stopped itself, and a conversation that was reset is told nothing. */
	stopped?: "owner" | "agent" | "reset";
	/** Set when it has ended. With neither a code nor a signal, how it ended is not known (pine was not running). */
	ended?: { code?: number; signal?: string; seconds?: number };
}

/** How many commands one conversation may have in the background at a time. */
export const MAX_BACKGROUND = 8;
/** Commands that end within this time of each other are told in one message. */
const TELL_AFTER_MS = 300;
/** How often a command that an earlier daemon started is looked at. One that this daemon started says so itself. */
const LOOK_EVERY_MS = 2000;

/**
 * What starts a background command and waits for it, with the daemon's rights. It is fixed text:
 * whatever differs from one command to the next is an argument, and the agent's command is one
 * argument of the shell that runs inside the sandbox (`RUN`). When the command has ended, this
 * shell writes the exit code into pine's home, so that a daemon started later knows it too.
 * A stop is a signal to the whole group. `trap :` lets this shell outlive it and note how the
 * command ended; for what it starts the signal has its usual meaning again.
 */
const WATCH = 'trap : TERM; note=$1; shift; "$@"; code=$?; echo "$code" > "$note"; exit "$code"';
/** Inside the sandbox, fixed as well: the output file is made there, so the system decides where it may lie. */
const RUN = 'mkdir -p "$1" && exec "$0" -c "$3" > "$1/$2" 2>&1';

function isThere(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// Not allowed to signal it: something is there, though it is not ours.
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
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
	/** Background commands by token: those being run, and those that have ended and were not told yet. */
	private jobs = new Map<string, Background>();
	/** Those of them that an earlier daemon started: this one is not their parent and has to look. */
	private adopted = new Set<string>();
	private telling = new Map<string, NodeJS.Timeout>();
	private looking?: NodeJS.Timeout;
	private closed = false;
	private count = 0;
	/** Called a moment after background commands of a conversation have ended: `ended` has them. */
	onEnded?: (conversation: string) => void;

	/** `dir` lies in pine's home, where no agent can write: an agent cannot put a group on a list. */
	constructor(dir: string) {
		this.dir = dir;
		// (A conversation's key has a colon in it, so no list is called "background".)
		fs.mkdirSync(path.join(dir, "background"), { recursive: true });
	}

	private file(conversation: string): string {
		return path.join(this.dir, encodeURIComponent(conversation));
	}

	/** A background command's files in pine's home: what is known about it (json), and how it ended (exit). */
	private record(token: string, kind: "json" | "exit"): string {
		return path.join(this.dir, "background", `${token}.${kind}`);
	}

	private save(job: Background): void {
		fs.writeFileSync(this.record(job.token, "json"), JSON.stringify(job));
	}

	private drop(job: Background): void {
		this.jobs.delete(job.token);
		this.adopted.delete(job.token);
		for (const kind of ["json", "exit"] as const) fs.rmSync(this.record(job.token, kind), { force: true });
	}

	/**
	 * Start a command in the background. `prefix` is the sandbox of its conversation ([] where
	 * there is none) and `dir` a folder of the agent's own for the output. The shell leads a
	 * group of its own, and the daemon notes that group itself, from what the system said when
	 * it started the shell. Returns at once.
	 */
	start(o: { conversation: string; agent: string; command: string; prefix: string[]; cwd: string; env: NodeJS.ProcessEnv; dir: string; reply?: ReplyTarget; tainted?: string }): Background {
		if (this.running(o.conversation).length >= MAX_BACKGROUND) throw new Error(`${MAX_BACKGROUND} commands of this conversation are running in the background already. Stop one with stop_program, or go on when one has ended.`);
		const token = `${Date.now().toString(36)}${(this.count++).toString(36)}`;
		const shell = bin("bash");
		const child = spawn(shell, ["-c", WATCH, "pine-background", this.record(token, "exit"), ...o.prefix, shell, "-c", RUN, shell, o.dir, `${token}.log`, o.command], { cwd: o.cwd, env: o.env, detached: true, stdio: "ignore" });
		child.on("error", () => {});
		if (!child.pid) throw new Error(`the command could not be started in ${o.cwd}`);
		// The daemon does not wait for it, and it goes on when the daemon stops.
		child.unref();
		const job: Background = { id: child.pid, token, conversation: o.conversation, agent: o.agent, command: o.command, output: path.join(o.dir, `${token}.log`), started: Date.now(), reply: o.reply, tainted: o.tainted };
		this.jobs.set(token, job);
		this.save(job);
		fs.appendFileSync(this.file(o.conversation), `${child.pid}\n`);
		child.once("exit", (code, signal) => this.settle(job, { code: code ?? undefined, signal: signal ?? undefined, seconds: Math.round((Date.now() - job.started) / 1000) }));
		return job;
	}

	/** The background commands of a conversation that are still being run. */
	running(conversation: string): Background[] {
		return [...this.jobs.values()].filter((j) => j.conversation === conversation && !j.ended);
	}

	/** Those that have ended and that the conversation has not been told about, in the order they were started. */
	ended(conversation: string): Background[] {
		return [...this.jobs.values()].filter((j) => j.conversation === conversation && j.ended);
	}

	/** The conversation has been told about these: they are forgotten. */
	told(jobs: Background[]): void {
		for (const job of jobs) this.drop(job);
	}

	private settle(job: Background, ended: NonNullable<Background["ended"]>): void {
		// A daemon that has stopped notes nothing more: the next one finds the exit code its shell wrote.
		if (this.closed || job.ended || this.jobs.get(job.token) !== job) return;
		this.adopted.delete(job.token);
		job.ended = ended;
		// What the agent stopped itself, the tool has told it. A conversation that was reset is told nothing.
		if (job.stopped === "agent" || job.stopped === "reset") return this.drop(job);
		// Kept until the conversation has been told, also over a restart.
		this.save(job);
		fs.rmSync(this.record(job.token, "exit"), { force: true });
		this.remind(job.conversation);
	}

	/** The conversation has nothing to do any more: if commands of its own ended while it worked, it is told now. */
	nudge(conversation: string): void {
		if (this.jobs.size && this.ended(conversation).length) this.remind(conversation);
	}

	/** Tell the conversation in a moment: what else ends until then goes into the same message. */
	private remind(conversation: string): void {
		if (this.closed) return;
		clearTimeout(this.telling.get(conversation));
		const timer = setTimeout(() => {
			this.telling.delete(conversation);
			this.onEnded?.(conversation);
		}, TELL_AFTER_MS);
		timer.unref?.();
		this.telling.set(conversation, timer);
	}

	/**
	 * After a restart: take up the background commands that the daemon before this one knew. One
	 * that is still there is listed again and looked at until it ends. One that ended meanwhile
	 * is told now. A daemon calls this once, when `onEnded` is set.
	 */
	adopt(every = LOOK_EVERY_MS): void {
		const all = processes();
		let names: string[] = [];
		try {
			names = fs.readdirSync(path.join(this.dir, "background")).filter((n) => n.endsWith(".json"));
		} catch {
			// nothing was kept
		}
		for (const name of names) {
			let job: Background;
			try {
				job = JSON.parse(fs.readFileSync(path.join(this.dir, "background", name), "utf8"));
			} catch {
				continue;
			}
			if (!job?.token || this.jobs.has(job.token)) continue;
			// ps could not be asked: whether it is still there cannot be said now. Its record stays for the next start.
			if (!job.ended && !all.length) continue;
			this.jobs.set(job.token, job);
			if (job.ended) {
				this.remind(job.conversation);
				continue;
			}
			// Still the shell that was started for it: its command line names this record. A
			// process that merely has the same number is something else.
			const leader = all.find((r) => r.pid === job.id);
			if (leader?.group === job.id && leader.command.includes(job.token)) this.adopted.add(job.token);
			this.look(job);
		}
		if (this.adopted.size && !this.closed) {
			this.looking = setInterval(() => {
				for (const token of [...this.adopted]) this.look(this.jobs.get(token)!);
				if (!this.adopted.size) clearInterval(this.looking);
			}, every);
			this.looking.unref?.();
		}
	}

	/** Has a command that an earlier daemon started ended? Its shell wrote the exit code before it went. */
	private look(job: Background): void {
		const there = this.adopted.has(job.token) && isThere(job.id);
		let code: number | undefined;
		let seconds: number | undefined;
		try {
			const note = this.record(job.token, "exit");
			const text = fs.readFileSync(note, "utf8").trim();
			if (/^\d+$/.test(text)) {
				code = Number(text);
				seconds = Math.max(0, Math.round((fs.statSync(note).mtimeMs - job.started) / 1000));
			}
		} catch {
			// no note: still being run, or ended by a signal that its shell did not outlive
		}
		if (code !== undefined || !there) this.settle(job, { code, seconds });
	}

	/** A conversation got another name: what it left running and what it has in the background go with it. */
	rename(from: string, to: string): void {
		try {
			fs.renameSync(this.file(from), this.file(to));
		} catch {
			// it had noted nothing
		}
		for (const job of this.jobs.values()) {
			if (job.conversation !== from) continue;
			job.conversation = to;
			this.save(job);
		}
		if (this.telling.has(from)) {
			clearTimeout(this.telling.get(from));
			this.telling.delete(from);
			this.remind(to);
		}
	}

	/** The daemon stops. What is in the background goes on, and what is known about it stays for the next start. */
	close(): void {
		this.closed = true;
		for (const timer of this.telling.values()) clearTimeout(timer);
		this.telling.clear();
		clearInterval(this.looking);
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
		const left: Array<{ id: number; rows: Row[]; job?: Background }> = [];
		const background = new Map(this.running(conversation).map((j) => [j.id, j]));
		for (const id of groups) {
			const rows = all.filter((r) => r.group === id);
			if (!rows.length) continue;
			alive.push(id);
			// While the shell that leads the group is there, its command is still being run: that
			// is nothing left running, unless the command was put into the background.
			// That one is known by its shell, whose command line names the record pine keeps of it.
			const leader = rows.find((r) => r.pid === id);
			const job = background.get(id);
			if (!leader) left.push({ id, rows });
			else if (job && leader.command.includes(job.token)) left.push({ id, rows, job });
		}
		if (alive.length !== groups.length) {
			if (alive.length) fs.writeFileSync(this.file(conversation), `${alive.join("\n")}\n`);
			else fs.rmSync(this.file(conversation), { force: true });
		}
		const ports = listening(left.flatMap((p) => p.rows.map((r) => r.pid)));
		return left.map(({ id, rows, job }) => {
			// The program is what listens; failing that, what has been there longest.
			const main = rows.find((r) => ports.has(r.pid)) ?? [...rows].sort((a, b) => b.seconds - a.seconds || a.pid - b.pid)[0];
			const program = { id, command: main.command, processes: rows.length, ports: [...new Set(rows.flatMap((r) => ports.get(r.pid) ?? []))].sort((a, b) => a - b), seconds: Math.max(...rows.map((r) => r.seconds)) };
			// A background command is named by what the agent ran, and the shell that waits for it is not counted.
			return job ? { ...program, command: job.command, processes: Math.max(1, rows.length - 1), background: true, output: job.output } : program;
		});
	}

	/**
	 * Stop one of this conversation's programs: asked first, and ended a moment later if it is still there.
	 * `by` says who stops a background command, which decides whether its conversation is told.
	 */
	stop(conversation: string, id: number, by: "owner" | "agent" | "reset" = "owner"): boolean {
		if (!this.list(conversation).some((p) => p.id === id)) return false;
		const job = this.running(conversation).find((j) => j.id === id);
		const signal = (name: NodeJS.Signals) => {
			try {
				process.kill(-id, name);
				return true;
			} catch {
				return false;
			}
		};
		if (!signal("SIGTERM")) return false;
		if (job) {
			job.stopped = by;
			this.save(job);
		}
		setTimeout(() => {
			if (this.list(conversation).some((p) => p.id === id)) signal("SIGKILL");
		}, 2000).unref?.();
		return true;
	}

	/** Stop everything a conversation left running: it is being reset or removed. */
	stopAll(conversation: string): number {
		const running = this.list(conversation);
		for (const p of running) this.stop(conversation, p.id, "reset");
		// Nothing is told to a conversation that is no longer what it was.
		for (const job of [...this.jobs.values()]) {
			if (job.conversation !== conversation) continue;
			if (job.ended) this.drop(job);
			else {
				job.stopped = "reset";
				this.save(job);
			}
		}
		clearTimeout(this.telling.get(conversation));
		this.telling.delete(conversation);
		return running.length;
	}
}
