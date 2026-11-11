import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AgentConfig, agentSkillsDir, conversationsDir, globalSkillsDir, mainAgentId, PINE_ROOT, type PineConfig, userFile, WORKSPACE_FILES } from "./config.ts";
import type { Bus } from "./store.ts";
import { type Logger, truncate } from "./util.ts";

/** realpath of the deepest existing ancestor, plus the part that does not exist yet. Defeats symlink escapes. */
export function realish(p: string): string {
	let cur = path.resolve(p);
	const rest: string[] = [];
	for (;;) {
		try {
			return path.join(fs.realpathSync(cur), ...rest.reverse());
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return path.resolve(p);
			rest.push(path.basename(cur));
			cur = parent;
		}
	}
}

export const isInside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** Files that steer an agent or the daemon. A run that has seen outside content must not change them. */
const INSTRUCTION_FILES = ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "SYSTEM.md"];
const INSTRUCTION_DIRS = [".pi", ".agents", ".git/hooks"];

export interface Roots {
	workspace: string;
	/** Private HOME and TMPDIR of the agent's shell commands. */
	sandboxHome: string;
	/** pine's home directory: off limits except for the parts listed in ownedRead / ownedWrite. */
	home: string;
	read: string[];
	write: string[];
	/** The agent's own roots, without the shared temp directories. */
	ownedRead: string[];
	ownedWrite: string[];
	/**
	 * Where this session's shell and file tools start. The agent's workspace, or the folder the
	 * owner opened for the conversation, which is then readable and writable like the workspace.
	 */
	cwd: string;
	/** The folder the owner opened for the conversation, if any. Its instruction files are guarded like the workspace's. */
	folder?: string;
	/** USER.md in pine's home: what all agents know about the owner. Only the main agent may write it. */
	userFile: string;
	/** Read access is refused here even when a broader rule would allow it. */
	secrets: string[];
	/** Workspaces of the other agents. Agents exchange information through delegation, not through each other's files. */
	others: string[];
}

export function rootsFor(cfg: PineConfig, agent: AgentConfig): Roots {
	const sandboxHome = path.join(cfg.home, "sandbox", agent.id);
	fs.mkdirSync(path.join(sandboxHome, "tmp"), { recursive: true });
	const workspace = realish(agent.workspace);
	const home = realish(cfg.home);
	const tmp = agent.sandbox.sharedTmp ? [...new Set([realish(os.tmpdir()), "/private/tmp"])] : [];
	// pine's manual is readable by every agent, so it can explain how its owner changes the setup.
	// The one file of pine's home that an agent may touch: what is known about the owner, and only for the main agent.
	const user = path.join(home, path.basename(userFile(cfg)));
	const keepsUser = agent.id === mainAgentId(cfg) ? [user] : [];
	// Skills are read, never written, by the agent they are for: its own, its conversations', and those for all agents.
	const skills = [agentSkillsDir(agent), conversationsDir(agent), globalSkillsDir(cfg), ...cfg.skills, ...agent.skills].map(realish);
	const ownedRead = [...new Set([workspace, realish(sandboxHome), realish(path.join(PINE_ROOT, "docs")), ...skills, ...agent.sandbox.read.map(realish), ...keepsUser])];
	const ownedWrite = [...new Set([workspace, realish(sandboxHome), ...agent.sandbox.write.map(realish), ...keepsUser])];
	return {
		workspace,
		cwd: workspace,
		sandboxHome: realish(sandboxHome),
		home,
		read: [...ownedRead, ...tmp],
		write: [...ownedWrite, ...tmp],
		ownedRead,
		ownedWrite,
		userFile: user,
		secrets: [path.join(home, ".env"), path.join(home, "auth.json"), path.join(home, "models.json"), path.join(home, "pine.json"), realish(cfg.dataDir)],
		others: Object.values(cfg.agents)
			.filter((a) => a.id !== agent.id)
			.map((a) => realish(a.workspace))
			.filter((w) => ![...ownedRead, ...ownedWrite].some((own) => isInside(own, w) || isInside(w, own))),
	};
}

/**
 * Which sandbox applies to a call.
 * normal:     the agent's own folders.
 * restricted: the same, and its instruction files are read-only (the run has handled outside content).
 * open:       bypass mode: the whole user account, except pine's home and pine's own code.
 */
export type SandboxVariant = "normal" | "restricted" | "open";

/** pine's own program files. Never writable by an agent, in any mode. */
const PINE_CODE = realish(PINE_ROOT);

/** Why a file tool may not touch `target`, or undefined when it may. */
export function checkPath(roots: Roots, kind: "read" | "write", target: string, cwd: string, variant: SandboxVariant | boolean): string | undefined {
	const p = realish(path.isAbsolute(target) ? target : path.join(cwd, target));
	const restricted = variant === true || variant === "restricted";
	if (roots.secrets.some((s) => isInside(s, p))) return `${target} is not accessible to agents`;
	if (variant === "open") {
		if (isInside(roots.home, p) && !(kind === "read" ? roots.ownedRead : roots.ownedWrite).some((r) => isInside(r, p))) return `${target} is part of pine's own configuration, which stays closed in every mode`;
		if (kind === "write" && isInside(PINE_CODE, p)) return `${target} is part of pine's own code, which agents cannot change`;
		return undefined;
	}
	if (roots.others.some((o) => isInside(o, p))) return `${target} belongs to another agent; ask that agent instead`;
	// Inside pine's home only the agent's own folders count, even if a shared temp root would cover the path.
	const inHome = isInside(roots.home, p);
	const allowed = kind === "read" ? (inHome ? roots.ownedRead : roots.read) : inHome ? roots.ownedWrite : roots.write;
	if (!allowed.some((r) => isInside(r, p))) return `${target} is outside the paths this agent may ${kind} (workspace: ${roots.workspace}). If you need it, call request_access with the path and the reason; your owner decides.`;
	const mine = [roots.workspace, ...(roots.folder !== undefined ? [roots.folder] : [])];
	if (kind === "write" && restricted && mine.some((r) => isGitRunPath(r, p))) return `${target} is part of a repository's hooks or configuration, which make git run programs, and cannot be changed in a run that has handled outside content`;
	if (kind === "write" && restricted && (mine.some((r) => isInstructionPath(r, p)) || isOwnFile(roots, p))) return `${target} holds agent instructions and cannot be changed in a run that has handled outside content`;
	return undefined;
}

export function isInstructionPath(workspace: string, p: string): boolean {
	if (!isInside(workspace, p)) return false;
	const rel = path.relative(workspace, p);
	return INSTRUCTION_FILES.includes(path.basename(p)) || INSTRUCTION_DIRS.some((d) => rel === d || rel.startsWith(d + path.sep));
}

/** Whether a path is one of the files that are read into the agent's prompt from its workspace, or the owner's file in pine's home. */
export function isOwnFile(roots: Roots, p: string): boolean {
	return p === roots.userFile || (path.dirname(p) === roots.workspace && WORKSPACE_FILES.includes(path.basename(p)));
}

/** Whether a path in one of the agent's folders is a repository's hooks or configuration, or the repository's own folder. */
export function isGitRunPath(root: string, p: string): boolean {
	return isInside(root, p) && GIT_RUNS.test(`/${path.relative(root, p)}`);
}

/**
 * The parts of a repository that make git run programs: its hooks and its configuration (which
 * can name a hooks folder, a pager, a file system monitor, an ssh command), also of submodules
 * and of repositories further down. What is put there runs with the owner's rights the next
 * time they use git, so a run that has handled outside content cannot change them, nor move
 * the repository's folder aside to put another in its place.
 */
const GIT_RUNS = /\/\.git(\/(modules\/.+\/)?(hooks(\/.*)?|config))?$/;
const GIT_RUNS_PROFILE = String.raw`(.*/)?\.git(/(modules/.+/)?(hooks(/.*)?|config))?$`;

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const rx = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const subpaths = (list: string[]) => list.map((p) => `(subpath ${q(p)})`).join(" ");

/**
 * macOS sandbox profile for everything an agent does on the file system: its shell commands and
 * its file tools. Nothing is allowed unless a rule here allows it; for file rules the last match wins.
 *
 * Allowed: running programs, reading outside the user's home, writing in the agent's own folders
 * and temp. Not allowed: the user's home, pine's home (secrets, configuration, other agents),
 * other processes (signals, their arguments and environment), launching apps, AppleScript,
 * the keychain, the clipboard, and the network unless the agent's configuration turns it on.
 */
export function sandboxProfile(_cfg: PineConfig, agent: AgentConfig, roots: Roots, variant: SandboxVariant | boolean, network = false): string {
	const userHome = realish(os.homedir());
	const restricted = variant === true || variant === "restricted";
	if (variant === "open") {
		// Bypass mode. The owner has said: act with my rights. What stays closed is what would let an
		// agent rewrite the system that runs it: pine's home (configuration, secrets) and pine's code.
		return `${[
			"(version 1)",
			"(allow default)",
			`(deny file-read* file-write* (subpath ${q(roots.home)}))`,
			`(allow file-read-metadata (subpath ${q(roots.home)}))`,
			`(allow file-read* ${subpaths(roots.ownedRead.filter((r) => isInside(roots.home, r)))})`,
			`(allow file-write* ${subpaths(roots.ownedWrite.filter((r) => isInside(roots.home, r)))})`,
			`(deny file-read* file-write* ${subpaths(roots.secrets)})`,
			`(deny file-write* (subpath ${q(PINE_CODE)}))`,
		].join("\n")}\n`;
	}
	const lines = [
		"(version 1)",
		"(deny default)",
		"(allow process-exec)",
		"(allow process-fork)",
		"(allow signal (target same-sandbox))",
		"(allow process-info* (target same-sandbox))",
		"(allow sysctl-read)",
		"(allow ipc-posix-shm-read*)",
		"(allow ipc-posix-sem)",
		"(allow pseudo-tty)",
		'(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.DirectoryService.libinfo.v1") (global-name "com.apple.system.notification_center") (global-name "com.apple.system.logger") (global-name "com.apple.logd") (global-name "com.apple.bsd.dirhelper"))',
		'(allow file-ioctl (regex #"^/dev/tty") (literal "/dev/null"))',
		"(allow file-read*)",
		`(allow file-write* ${subpaths(roots.write)} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
		`(deny file-read* (subpath ${q(userHome)}))`,
		`(allow file-read-metadata (subpath ${q(userHome)}))`,
		`(allow file-read* ${subpaths(roots.read)})`,
		// pine's home is closed wherever it lies, except for this agent's own folders.
		`(deny file-read* file-write* (subpath ${q(roots.home)}))`,
		`(allow file-read-metadata (subpath ${q(roots.home)}))`,
		`(allow file-read* ${subpaths(roots.ownedRead)})`,
		`(allow file-write* ${subpaths(roots.ownedWrite)})`,
		`(deny file-read* file-write* ${subpaths([...roots.secrets, ...roots.others])})`,
	];
	if (restricted) {
		// What is read into the prompt cannot be rewritten by a run that outside content may steer.
		lines.push(`(deny file-write* ${[roots.userFile, ...WORKSPACE_FILES.map((f) => path.join(roots.workspace, f))].map((f) => `(literal ${q(f)})`).join(" ")})`);
		for (const dir of [roots.workspace, ...(roots.folder ? [roots.folder] : [])]) {
			lines.push(`(deny file-write* (regex #"^${rx(dir)}/(.*/)?(${INSTRUCTION_FILES.map(rx).join("|")})$") (regex #"^${rx(dir)}/${GIT_RUNS_PROFILE}") ${subpaths(INSTRUCTION_DIRS.map((d) => path.join(dir, d)))})`);
		}
	}
	if (agent.sandbox.network || network) {
		lines.push(
			"(allow network*)",
			"(allow system-socket)",
			'(allow mach-lookup (global-name "com.apple.trustd.agent") (global-name "com.apple.trustd") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.SystemConfiguration.DNSConfiguration") (global-name "com.apple.dnssd.service") (global-name "com.apple.networkd") (global-name "com.apple.symptomsd"))',
		);
	}
	return `${lines.join("\n")}\n`;
}

export const sandboxAvailable = () => process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");

/** Environment for an agent's shell: nothing from the daemon except what a shell needs. */
export function shellEnv(agent: AgentConfig, roots: Roots, sessionEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const keep = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "USER", "LOGNAME", "SHELL"];
	const env: NodeJS.ProcessEnv = {};
	for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
	for (const [k, v] of Object.entries(sessionEnv)) if (k.startsWith("PI_") && !/KEY|TOKEN|SECRET|AUTH/i.test(k)) env[k] = v;
	env.HOME = roots.sandboxHome;
	env.TMPDIR = path.join(roots.sandboxHome, "tmp");
	env.GIT_CONFIG_GLOBAL = path.join(roots.sandboxHome, ".gitconfig");
	env.PINE_AGENT = agent.id;
	return { ...env, ...agent.sandbox.env };
}

export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Glob with `*` only, anchored. */
export function globMatch(pattern: string, value: string): boolean {
	return new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*")}$`).test(value);
}

/** "tool" or "tool:argument-glob". The argument is the command, topic, agent or path the call is about. */
export function matchesToolPattern(patterns: readonly string[], tool: string, subject: string): boolean {
	return patterns.some((pat) => {
		const i = pat.indexOf(":");
		return i < 0 ? globMatch(pat, tool) : globMatch(pat.slice(0, i), tool) && globMatch(pat.slice(i + 1), subject);
	});
}

/** The part of a tool call a person needs to see to judge it. */
export function toolSubject(tool: string, input: any): string {
	if (!input || typeof input !== "object") return "";
	const v = tool === "download" ? input.url : tool === "send" ? input.source : (input.command ?? input.topic ?? input.agent ?? input.path ?? input.url ?? input.key ?? input.query);
	return typeof v === "string" ? v : "";
}

export interface ApprovalRequest {
	id: string;
	agent: string;
	task: number;
	/** The task at the top of the delegation tree this request belongs to. */
	root?: number;
	tool: string;
	summary: string;
	why: string;
	expires: number;
	/** What "always" would cover for the rest of the conversation, e.g. "all home-link tools". Absent: the question is asked every time. */
	remember?: string;
	/**
	 * Values only the owner has and that must not pass through a model: a password, a token. The
	 * owner types them where the question is shown. A yes without them is not a yes.
	 */
	inputs?: Array<{ name: string; label: string; secret?: boolean }>;
}

export interface ApprovalDecision {
	allow: boolean;
	by: string;
	/** Allowed, and not to be asked again in this conversation. */
	always?: boolean;
	/** What the owner typed for the request's `inputs`. Never published as an event. */
	values?: Record<string, string>;
}

/** Human-in-the-loop gate. Requests are events; anything that can reach the owner may answer them. */
export class Approvals {
	private bus: Bus;
	private log: Logger;
	private timeoutMs: number;
	private open = new Map<string, { req: ApprovalRequest; resolve: (r: ApprovalDecision) => void; timer: NodeJS.Timeout }>();

	constructor(bus: Bus, log: Logger, timeoutMs: number) {
		this.bus = bus;
		this.log = log;
		this.timeoutMs = timeoutMs;
	}

	request(r: Omit<ApprovalRequest, "id" | "expires">, signal?: AbortSignal): Promise<ApprovalDecision> {
		const req: ApprovalRequest = { ...r, summary: truncate(r.summary, 1500), id: crypto.randomBytes(4).toString("hex"), expires: Date.now() + this.timeoutMs };
		return new Promise((resolve) => {
			const finish = (allow: boolean, by: string, always = false, values?: Record<string, string>) => {
				const entry = this.open.get(req.id);
				if (!entry) return;
				clearTimeout(entry.timer);
				this.open.delete(req.id);
				const remembered = allow && always && req.remember !== undefined;
				// What the owner typed goes to whoever asked, and nowhere else: not into this event.
				this.bus.publish("approval/decided", { id: req.id, allow, by, agent: req.agent, tool: req.tool, always: remembered || undefined, remember: remembered ? req.remember : undefined }, { source: "approvals" });
				resolve({ allow, by, always: remembered, values: allow ? values : undefined });
			};
			const timer = setTimeout(() => finish(false, "timeout"), this.timeoutMs);
			timer.unref?.();
			this.open.set(req.id, { req, resolve: ({ allow, by, always, values }) => finish(allow, by, always, values), timer });
			signal?.addEventListener("abort", () => finish(false, "aborted"), { once: true });
			this.log.info(`approval ${req.id} requested: ${req.agent} wants ${req.tool} (${req.why})`);
			this.bus.publish("approval/requested", req, { source: "approvals" });
		});
	}

	/** The fields of an open request that a yes has to come with and that `values` does not have. */
	missing(id: string, values?: Record<string, string>): string[] {
		return (this.open.get(id)?.req.inputs ?? []).filter((i) => !String(values?.[i.name] ?? "").trim()).map((i) => i.name);
	}

	/** Returns false when the id is unknown or already answered, or when a yes lacks what the request asks the owner to type. */
	decide(id: string, allow: boolean, by: string, always = false, values?: Record<string, string>): boolean {
		const entry = this.open.get(id);
		if (!entry) return false;
		if (allow && this.missing(id, values).length) return false;
		const wanted = new Set((entry.req.inputs ?? []).map((i) => i.name));
		entry.resolve({ allow, by, always, values: values ? Object.fromEntries(Object.entries(values).filter(([k]) => wanted.has(k)).map(([k, v]) => [k, String(v).trim()])) : undefined });
		return true;
	}

	pending(): ApprovalRequest[] {
		return [...this.open.values()].map((e) => e.req);
	}

	denyAll(by: string): void {
		for (const id of [...this.open.keys()]) this.decide(id, false, by);
	}
}

/** Replaces known secret values in text that leaves the daemon. */
export class Redactor {
	private secrets: string[] = [];
	add(values: Iterable<string | undefined>): void {
		for (const v of values) if (v && v.length >= 8 && !this.secrets.includes(v)) this.secrets.push(v);
		this.secrets.sort((a, b) => b.length - a.length);
	}
	text(s: string): string {
		for (const secret of this.secrets) if (s.includes(secret)) s = s.split(secret).join("[redacted]");
		return s;
	}
	deep<T>(v: T): T {
		if (!this.secrets.length) return v;
		if (typeof v === "string") return this.text(v) as T;
		if (Array.isArray(v)) return v.map((x) => this.deep(x)) as T;
		if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.deep(x)])) as T;
		return v;
	}
}

export const timingSafeEqual = (a: string, b: string) => {
	const ha = crypto.createHash("sha256").update(a).digest();
	const hb = crypto.createHash("sha256").update(b).digest();
	return crypto.timingSafeEqual(ha, hb);
};

/** Things about a configuration that weaken its defences. Shown by `pine check` and at startup. */
export function audit(cfg: PineConfig): string[] {
	const out: string[] = [];
	const mode = (p: string) => {
		try {
			return fs.statSync(p).mode & 0o777;
		} catch {
			return undefined;
		}
	};
	for (const f of [".env", "auth.json", "models.json", "pine.json"]) {
		const m = mode(path.join(cfg.home, f));
		if (m !== undefined && m & 0o077) out.push(`${f} is readable by other users (mode ${m.toString(8)}); run: chmod 600 ${path.join(cfg.home, f)}`);
	}
	if (!sandboxAvailable()) out.push("no OS sandbox on this platform: agent shell commands run with the daemon's full permissions");
	for (const a of Object.values(cfg.agents)) {
		const tools = a.tools ?? ["read", "bash", "edit", "write"];
		if (!a.sandbox.enabled && tools.includes("bash")) out.push(`agent ${a.id}: sandbox is off and bash is enabled; its commands can read and change anything the daemon user can`);
		if (a.sandbox.enabled && a.sandbox.network && tools.includes("bash")) out.push(`agent ${a.id}: shell has network access; a prompt injection could send workspace files anywhere (approval is required once the session has seen outside content)`);
		if (a.mode === "bypass") out.push(`agent ${a.id}: bypass mode. It never asks, and its shell reaches your whole account and the network${cfg.security.bypassWhenTainted ? ", even after it has read outside content (security.bypassWhenTainted)" : " (it asks again once a session has read outside content)"}`);
		if (a.trustWorkspace) out.push(`agent ${a.id}: trustWorkspace is on; code in ${a.workspace}/.pi/extensions runs inside the daemon`);
		if (isInside(realish(a.workspace), realish(cfg.home))) out.push(`agent ${a.id}: the workspace contains pine's home directory`);
		if (a.untrusted && a.untrusted.tools.some((t) => ["bash", "write", "edit"].includes(t))) out.push(`agent ${a.id}: runs triggered by untrusted events may use ${a.untrusted.tools.filter((t) => ["bash", "write", "edit"].includes(t)).join(", ")}`);
	}
	if (cfg.http && !["127.0.0.1", "localhost", "::1"].includes(cfg.http.host)) out.push(`http listens on ${cfg.http.host}; anyone who can reach it and knows the token controls every agent. Prefer loopback plus a tunnel.`);
	for (const [name, h] of Object.entries(cfg.http?.hooks ?? {})) if (!h.secret) out.push(`http hook "${name}" has no secret; anyone who can reach the port can publish ${h.topic}`);
	// A source whose events count as the owner's words: fine for a paired Telegram account, a risk for anything others can feed.
	for (const [where, sources] of [["pine.json", cfg.sources] as const, ...Object.values(cfg.agents).map((a) => [`agent ${a.id}`, a.sources] as const)]) {
		for (const [name, s] of Object.entries(sources)) if (s.trust === "owner" && s.type !== "telegram") out.push(`${where}: what the source "${name}" (${s.type ?? "custom"}) reports is treated as coming from you; whoever can feed it gets an agent's full tool set`);
	}
	// A source type is a program inside the daemon, whoever wrote it.
	for (const [name, file] of Object.entries(cfg.sourceTypes)) out.push(`source type "${name}": ${file} runs inside pine with your rights, outside any sandbox`);
	for (const r of cfg.routes) if (r.trust === "owner") out.push(`route "${r.name}" treats events on ${r.on.join(", ")} as coming from you; whoever can publish there gets the agent's full tool set`);
	return out;
}
