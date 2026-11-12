// What a command reaches for beyond its sandbox, and how the owner comes to be asked about it.
//
// The sandbox refuses inside the system. The program is told "Operation not permitted", or
// finds nothing where it looked, and reports that in words of its own: "No such file",
// "Could not resolve host", or nothing at all. An agent that reads those words has to guess
// that it was its sandbox, and has to think of asking; a small model does neither. So pine
// finds out itself, in two ways: before a command runs, from the paths its text names
// (`reaches`); and after it has run, on macOS, from the system's own reports of what the
// sandbox refused (`Denials`). Neither decides anything. What they find becomes a question to
// the owner (in src/agents.ts), and a yes becomes a grant like the one `request_access` gives,
// which the sandbox then enforces.
import { type ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "./util.ts";

/** One thing the sandbox refused a command: "file-read-data /Users/x/notes", "mach-lookup com.apple.windowserver". */
export interface Denial {
	process: string;
	op: string;
	target: string;
}

/** What a conversation would need to be given: a path to read or to write, or the network for its shell. */
export interface Want {
	kind: "read" | "write" | "network";
	path?: string;
}
export const wantKey = (w: Want) => `${w.kind}:${w.path ?? ""}`;
export const wantText = (w: Want) => (w.kind === "network" ? "use the network" : `${w.kind === "write" ? "write" : "read"} ${w.path}`);

/**
 * The shell that keeps the log reader: fixed text. It ends the reader when its own input closes,
 * which is when pine is gone, however pine went.
 */
const KEEP = '"$@" & pid=$!; trap "kill $pid 2>/dev/null" EXIT; cat > /dev/null';

export interface DenialTools {
	/** The command that prints the system's reports that contain `needle`, one JSON object a line with the report in `eventMessage`. Undefined: not on this system. */
	stream(needle: string): string[] | undefined;
	/** A command that makes the system report one denial that carries `tag`. `about` is the command the mark comes after. */
	mark(tag: string, about: string): string[] | undefined;
}

/**
 * The system's reports of what the sandbox refused, by command. macOS writes one to its log for
 * every refusal, with a text the profile chose (`with message`): each command gets a text of its
 * own, and pine reads the log for them. After a command pine makes one refusal itself (the mark)
 * and waits until it sees that one, so "nothing was reported" is known and not assumed.
 *
 * Reading the log costs a few percent of a processor for as long as it goes on, whatever is
 * asked of it. So the reader runs while commands run and a little longer (`idleMs`), and is
 * started again, in some ten milliseconds, by the next command.
 */
export class Denials {
	private log: Logger;
	private tools: DenialTools;
	private base = `pine-${crypto.randomBytes(6).toString("hex")}`;
	private n = 0;
	private child?: ChildProcess;
	private state: "idle" | "ready" | "off" = "idle";
	private starting?: Promise<boolean>;
	private starts = 0;
	private seen = new Map<string, Denial[]>();
	private marks = new Map<string, () => void>();
	/** Commands that have a tag and have not been collected: while there is one, the reader stays. */
	private open = new Set<string>();
	private idle?: NodeJS.Timeout;
	private idleMs: number;

	constructor(log: Logger, tools: DenialTools, idleMs = 20_000) {
		this.log = log;
		this.tools = tools;
		this.idleMs = idleMs;
	}

	/** Whether refusals are being read. Starts the reader on first use; false where there is none. */
	ready(): Promise<boolean> {
		if (this.state === "ready") return Promise.resolve(true);
		if (this.state === "off") return Promise.resolve(false);
		this.starting ??= this.start().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	/** The text for the next command's profile. Every tag is given back with `collect` or `drop`. */
	tag(): string {
		const tag = `${this.base}:c:${++this.n}`;
		this.open.add(tag);
		clearTimeout(this.idle);
		return tag;
	}

	/** What the sandbox refused the command with this tag. Call it once, after the command has ended. */
	async collect(tag: string): Promise<Denial[]> {
		if (this.state === "ready") await this.mark(tag, 1500);
		const got = this.seen.get(tag) ?? [];
		this.drop(tag);
		return got;
	}

	/** A command whose refusals nobody will ask for. */
	drop(tag: string): void {
		this.seen.delete(tag);
		this.open.delete(tag);
		if (this.open.size || this.state !== "ready") return;
		clearTimeout(this.idle);
		this.idle = setTimeout(() => {
			if (this.open.size || this.state !== "ready") return;
			this.state = "idle";
			this.end();
		}, this.idleMs);
		this.idle.unref?.();
	}

	stop(): void {
		this.state = "off";
		clearTimeout(this.idle);
		this.end();
	}

	private end(): void {
		const child = this.child;
		this.child = undefined;
		child?.stdin?.end();
		child?.kill();
		for (const done of [...this.marks.values()]) done();
	}

	private async start(): Promise<boolean> {
		const argv = this.tools.stream(`${this.base}:`);
		if (!argv || this.starts >= 3) {
			this.state = "off";
			return false;
		}
		this.starts++;
		let child: ChildProcess;
		try {
			child = spawn("/bin/sh", ["-c", KEEP, "sh", ...argv], { stdio: ["pipe", "pipe", "ignore"] });
		} catch {
			this.state = "off";
			return false;
		}
		this.child = child;
		let alive = true;
		let buf = "";
		child.stdin?.on("error", () => {});
		child.stdout?.on("data", (d: Buffer) => {
			buf += d.toString("utf8");
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				this.line(buf.slice(0, i));
				buf = buf.slice(i + 1);
			}
		});
		const gone = () => {
			if (!alive) return;
			alive = false;
			if (this.child === child) {
				this.child = undefined;
				// The reader can end for reasons of its own. The next command starts it again, a few times.
				if (this.state === "ready") this.state = "idle";
			}
			for (const done of [...this.marks.values()]) done();
		};
		child.on("error", gone);
		child.on("close", gone);
		// The reader says nothing when it has begun to read. A mark that comes back does.
		for (let i = 0; i < 40 && alive && this.state === "idle"; i++) {
			if (await this.mark("", 150)) {
				this.state = "ready";
				this.starts = 0;
				return true;
			}
		}
		if (this.state === "idle") {
			this.state = "off";
			this.log.info("the system's reports of what a sandbox refused cannot be read here; an agent whose command is refused something is told less about it");
		}
		if (this.child === child) this.end();
		return false;
	}

	/** Make one refusal and wait until it is reported: everything refused before it has been read by then. */
	private mark(about: string, ms: number): Promise<boolean> {
		const tag = `${this.base}:m:${++this.n}`;
		const argv = this.tools.mark(tag, about);
		if (!argv) return Promise.resolve(false);
		return new Promise((resolve) => {
			let over = false;
			const done = (ok = false) => {
				if (over) return;
				over = true;
				clearTimeout(timer);
				this.marks.delete(tag);
				resolve(ok);
			};
			const timer = setTimeout(done, ms);
			this.marks.set(tag, () => done(this.seen.delete(tag)));
			try {
				spawn(argv[0], argv.slice(1), { stdio: "ignore" }).on("error", () => done());
			} catch {
				done();
			}
		});
	}

	private line(line: string): void {
		if (!line.startsWith("{")) return;
		let message: unknown;
		try {
			message = JSON.parse(line).eventMessage;
		} catch {
			return;
		}
		if (typeof message !== "string") return;
		const lines = message.trim().split("\n");
		const tag = lines.at(-1)!.trim();
		if (!tag.startsWith(`${this.base}:`)) return;
		const m = /Sandbox: (.+?)\(\d+\) deny\(\d+\) (\S+)(?: (.*))?$/.exec(lines[0]);
		if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value!);
		const list = this.seen.get(tag) ?? [];
		if (m && list.length < 400) list.push({ process: m[1], op: m[2], target: (m[3] ?? "").trim() });
		this.seen.set(tag, list);
		this.marks.get(tag)?.();
	}
}

// ---- before a command runs: the paths its text names ---------------------------------------------

/** A path a command line names. */
export interface Reach {
	/** The path as the shell will take it, absolute. A pattern is cut back to the folder it looks in. */
	path: string;
	/** Whether the command looks like it writes there: the target of a redirect, or an argument of a command that makes, moves or removes. */
	write: boolean;
	/** Written with ~ or $HOME: the same path in the owner's home, which is not where the shell of an agent with a home of its own looks. */
	owner?: string;
	/** As it was written, for telling the agent. */
	text: string;
}

const WRITES_ALL = new Set(["touch", "mkdir", "rm", "rmdir", "mv", "tee", "chmod", "chown", "truncate", "unzip"]);
const WRITES_LAST = new Set(["cp", "ln", "install", "rsync"]);
const WRAPPERS = new Set(["sudo", "env", "time", "nohup", "command", "exec", "nice"]);

interface Word {
	text: string;
	redirect: boolean;
}

/** A command line as simple commands of words. Quotes are taken off; what is substituted at run time is left as it is written. */
function words(command: string): Word[][] {
	const out: Word[][] = [[]];
	let cur = "";
	let has = false;
	let redirect = false;
	const push = () => {
		if (has) out.at(-1)!.push({ text: cur, redirect });
		if (has) redirect = false;
		cur = "";
		has = false;
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "'") {
			const end = command.indexOf("'", i + 1);
			cur += command.slice(i + 1, end < 0 ? command.length : end);
			has = true;
			i = end < 0 ? command.length : end;
		} else if (ch === '"') {
			has = true;
			for (i++; i < command.length && command[i] !== '"'; i++) {
				if (command[i] === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1])) i++;
				cur += command[i];
			}
		} else if (ch === "\\" && i + 1 < command.length) {
			cur += command[++i];
			has = true;
		} else if (ch === ">") {
			// "2>" and "&>": what stands in front of the sign is not a word.
			if (/^(\d*|&)$/.test(cur)) {
				cur = "";
				has = false;
			} else push();
			if (command[i + 1] === ">") i++;
			// ">&2" names no file.
			redirect = command[i + 1] !== "&";
			if (!redirect) i++;
		} else if (ch === "<") {
			push();
			redirect = false;
		} else if (ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")" || ch === "\n") {
			push();
			redirect = false;
			if (out.at(-1)!.length) out.push([]);
		} else if (ch === " " || ch === "\t") push();
		else {
			cur += ch;
			has = true;
		}
	}
	push();
	return out.filter((c) => c.length);
}

/** The program each simple command of a command line starts, without its folder ("git", "npm"). Quoted text is not taken for a command. */
export function verbs(command: string): string[] {
	return words(command.length > 20_000 ? command.slice(0, 20_000) : command).map((simple) => {
		const args = simple.filter((w) => !w.redirect);
		let first = 0;
		while (first < args.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[first].text) || WRAPPERS.has(args[first].text))) first++;
		return path.basename(args[first]?.text ?? "");
	});
}

/**
 * The paths a command line names that are written out: absolute ones, and ones in a home folder
 * (~, $HOME). This is reading, not running: what a variable or a script holds is not seen, and
 * need not be, because the sandbox decides what the command reaches. It is only how pine knows
 * whom to ask before the command fails.
 */
export function reaches(command: string, where: { cwd: string; shellHome: string; ownerHome: string }): Reach[] {
	const out: Reach[] = [];
	for (const simple of words(command.length > 20_000 ? command.slice(0, 20_000) : command)) {
		const args = simple.filter((w) => !w.redirect);
		let first = 0;
		while (first < args.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[first].text) || WRAPPERS.has(args[first].text))) first++;
		const verb = path.basename(args[first]?.text ?? "");
		const named: Array<{ reach: Reach; redirect: boolean }> = [];
		for (const w of simple) {
			if (!w.redirect && w === args[first]) continue;
			// "--output=/a/b" names /a/b.
			let text = w.redirect ? w.text : (/^--?[A-Za-z][\w-]*=(.+)$/.exec(w.text)?.[1] ?? w.text);
			let home = false;
			const tilde = /^(~|\$HOME|\$\{HOME\})(\/|$)/.exec(text);
			if (tilde) {
				home = true;
				text = text.slice(tilde[1].length).replace(/^\//, "");
			} else if (text.startsWith("../") || text === "..") text = path.join(where.cwd, text);
			else if (!text.startsWith("/")) continue;
			// A pattern, or a name made at run time: the folder it is looked for in.
			const parts = text.split("/");
			const cut = parts.findIndex((p) => /[*?[{$`]/.test(p));
			const rest = (cut < 0 ? parts : parts.slice(0, cut)).join("/");
			if (!home && (rest === "" || rest === "/")) continue;
			const full = (home ? path.join(where.shellHome, rest) : path.normalize(rest)).replace(/(.)\/+$/, "$1");
			if (full.startsWith("/dev/") || full === "/dev" || full.startsWith("/proc/")) continue;
			const reach: Reach = { path: full, write: w.redirect || WRITES_ALL.has(verb), text: w.text };
			if (home) reach.owner = path.join(where.ownerHome, rest).replace(/(.)\/+$/, "$1");
			named.push({ reach, redirect: w.redirect });
		}
		// "cp a b" writes b: the last thing it is given, if that is one of the paths.
		const target = WRITES_LAST.has(verb) ? args.slice(first + 1).filter((w) => !w.text.startsWith("-")).at(-1) : undefined;
		const last = target ? named.find((x) => !x.redirect && x.reach.text === target.text) : undefined;
		if (last) last.reach.write = true;
		out.push(...named.map((x) => x.reach));
	}
	// One entry a path; a write counts for the path.
	const by = new Map<string, Reach>();
	for (const r of out) {
		const had = by.get(r.path);
		if (had) had.write ||= r.write;
		else by.set(r.path, r);
	}
	return [...by.values()].slice(0, 40);
}

// ---- after a command has run ---------------------------------------------------------------------

/** Words a failed step leaves in the output of a command that still ended well ("... | tail", "... || true"). */
const FAILED = /\b(error|failed|failure|fatal|cannot|can't|could not|couldn't|unable to|not permitted|permission denied|denied|not found|no such file|no matching|timed out|unreachable|refused)\b/i;
export const looksFailed = (output: string) => FAILED.test(output);

const NOT_PERMITTED = /Operation not permitted|Permission denied|Read-only file system/;
/** What a program says when it has no network: it cannot look a name up, or cannot reach an address. */
const NO_NETWORK =
	/Could not resolve host|Couldn't resolve host|Temporary failure in name resolution|Name or service not known|nodename nor servname provided|No address associated with hostname|Network is unreachable|getaddrinfo (ENOTFOUND|EAI_AGAIN)|failed to lookup address|unable to resolve host|dial tcp: lookup |NameResolutionError|Failed to establish a new connection|ENETUNREACH/i;

/**
 * Where the system reports nothing (Linux, or the reader is not running): what the output of a
 * failed command says. Weaker than a report: a program that keeps quiet tells nothing.
 */
export function fromOutput(output: string): { paths: string[]; network: boolean } {
	const paths = new Set<string>();
	for (const line of output.split("\n")) {
		if (!NOT_PERMITTED.test(line)) continue;
		for (const m of line.matchAll(/(?:^|[\s'"`:=(])(\/[^\s'"`:,;()]+)/g)) paths.add(m[1].replace(/[.]+$/, ""));
	}
	return { paths: [...paths].slice(0, 20), network: NO_NETWORK.test(output) };
}

/** Refusals every command meets and none needs: the system's tracing and logging, asked for by its libraries. */
const NOISE_TARGET = /^\/dev\/|^path:\/dev\/|^com\.apple\.(diagnosticd|logd|system\.logger|analyticsd|system\.notification_center)$/;

export interface Refused {
	/** Files and folders, by what was tried. A path is listed under write when both were. */
	read: string[];
	write: string[];
	/** The command tried to reach an address or to look a name up. */
	network: boolean;
	/** Services of the system it asked for and did not get. */
	services: string[];
}

/** The system's reports for one command, sorted: which paths, whether the network, which services. */
export function sortDenials(denials: Denial[]): Refused {
	const read = new Set<string>();
	const write = new Set<string>();
	const services = new Set<string>();
	let network = false;
	for (const d of denials) {
		if (NOISE_TARGET.test(d.target)) continue;
		if (d.op.startsWith("network")) {
			// A socket file is another program on this machine; the name lookup's is how every program
			// finds an address. A socket on no port in particular is a program talking to itself.
			if (d.target.endsWith("/mDNSResponder") || (!d.target.startsWith("/") && !(d.op === "network-bind" && /:0$/.test(d.target)))) network = true;
		} else if (d.op.startsWith("file-write") && d.target.startsWith("/")) write.add(d.target);
		else if (d.op.startsWith("file-read") && d.target.startsWith("/")) read.add(d.target);
		else if (d.op === "mach-lookup" && d.target) services.add(d.target);
	}
	return { read: [...read].filter((p) => !write.has(p)), write: [...write], network, services: [...services] };
}

const isInside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * Many refusals become few questions: a refused path that lies in something the command named is
 * that thing, and several in one folder are the folder.
 */
export function gather(paths: string[], named: string[]): string[] {
	const out = new Set<string>();
	for (const p of paths) out.add(named.filter((n) => isInside(n, p)).sort((a, b) => b.length - a.length)[0] ?? p);
	const byParent = new Map<string, string[]>();
	for (const p of out) byParent.set(path.dirname(p), [...(byParent.get(path.dirname(p)) ?? []), p]);
	for (const [parent, list] of byParent) {
		if (list.length < 3 || named.some((n) => list.includes(n))) continue;
		for (const p of list) out.delete(p);
		out.add(parent);
	}
	// What lies in something else that is asked for needs no line of its own.
	return [...out].filter((p) => ![...out].some((o) => o !== p && isInside(o, p)));
}

/** Whether a path exists, as far as the daemon can tell without opening anything. */
export function there(p: string): boolean {
	try {
		fs.lstatSync(p);
		return true;
	} catch {
		return false;
	}
}
