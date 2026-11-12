import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AgentConfig, agentSkillsDir, conversationsDir, globalSkillsDir, mainAgentId, PINE_ROOT, type PineConfig, sandboxScope, userFile, WORKSPACE_FILES } from "./config.ts";
import { bwrapArgs, Guard, helperArgs, jailed, type Protected, protectedNow, SESSIONS } from "./sandbox-linux.ts";
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
	/**
	 * The owner let this conversation change the agent's own files (MEMORY.md, AGENTS.md, SOUL.md,
	 * and USER.md for the main agent) although it has read outside content.
	 */
	ownOpen?: boolean;
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
 * open:       the whole user account, except pine's home and pine's own code: bypass mode, and
 *             an agent whose scope is the account in a conversation of its owner's.
 * open-restricted: the same reach, in a conversation that has read outside content and that the
 *             owner let keep it. What is read into the agent's prompt stays as it is.
 */
export type SandboxVariant = "normal" | "restricted" | "open" | "open-restricted";
export const isOpen = (v: SandboxVariant | boolean): v is "open" | "open-restricted" => v === "open" || v === "open-restricted";

/** pine's own program files. Never writable by an agent, in any mode. */
const PINE_CODE = realish(PINE_ROOT);

/** Why a file tool may not touch `target`, or undefined when it may. */
/**
 * "~" in a path a model gave a file tool: the owner's home folder, in every scope. pi's read,
 * write and edit take it that way, so the check and the other file tools must as well, or a
 * path would be judged as one file and opened as another. (An agent in the workspace scope
 * reaches its own private home by its full path.)
 */
export function tilde(target: string): string {
	return target === "~" ? os.homedir() : target.startsWith("~/") ? path.join(os.homedir(), target.slice(2)) : target;
}

export function checkPath(roots: Roots, kind: "read" | "write", given: string, cwd: string, variant: SandboxVariant | boolean): string | undefined {
	const target = tilde(given);
	const p = realish(path.isAbsolute(target) ? target : path.join(cwd, target));
	const restricted = variant === true || variant === "restricted" || variant === "open-restricted";
	if (roots.secrets.some((s) => isInside(s, p))) return `${target} is not accessible to agents`;
	if (isOpen(variant)) {
		if (isInside(roots.home, p) && !(kind === "read" ? roots.ownedRead : roots.ownedWrite).some((r) => isInside(r, p))) return `${target} is part of pine's own configuration, which stays closed in every mode`;
		if (kind === "write" && isInside(PINE_CODE, p)) return `${target} is part of pine's own code, which agents cannot change`;
		if (kind === "write" && restricted) return ownRules(roots, target, p);
		return undefined;
	}
	if (roots.others.some((o) => isInside(o, p))) return `${target} belongs to another agent; ask that agent instead`;
	// Inside pine's home only the agent's own folders count, even if a shared temp root would cover the path.
	const inHome = isInside(roots.home, p);
	const allowed = kind === "read" ? (inHome ? roots.ownedRead : roots.read) : inHome ? roots.ownedWrite : roots.write;
	if (!allowed.some((r) => isInside(r, p))) return `${target} is outside the paths this agent may ${kind} (workspace: ${roots.workspace}). If you need it, call request_access with the path and the reason; your owner decides.`;
	return kind === "write" && restricted ? ownRules(roots, target, p) : undefined;
}

/** What a run that has handled outside content may not write in the agent's own folders, however far it reaches otherwise. */
function ownRules(roots: Roots, target: string, p: string): string | undefined {
	// Its own files, when the owner has said so for this conversation.
	if (roots.ownOpen && ownFiles(roots).includes(p)) return undefined;
	const mine = [roots.workspace, ...(roots.folder !== undefined ? [roots.folder] : [])];
	if (mine.some((r) => isGitRunPath(r, p))) return `${target} is part of a repository's hooks or configuration, which make git run programs, and cannot be changed in a run that has handled outside content`;
	if (mine.some((r) => isInstructionPath(r, p)) || isOwnFile(roots, p)) return `${target} holds agent instructions and cannot be changed in a run that has handled outside content`;
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

/** The files an agent keeps itself: its memory and instructions at the top of its workspace, and for the main agent what is known about the owner. */
export function ownFiles(roots: Roots): string[] {
	return [...WORKSPACE_FILES.map((f) => path.join(roots.workspace, f)), ...(roots.ownedWrite.includes(roots.userFile) ? [roots.userFile] : [])];
}

/** The own file a path given to a file tool means, if it means one. */
export function ownFileOf(roots: Roots, given: string, cwd: string): string | undefined {
	const target = tilde(given);
	const p = realish(path.isAbsolute(target) ? target : path.join(cwd, target));
	return ownFiles(roots).includes(p) ? p : undefined;
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
	const restricted = variant === true || variant === "restricted" || variant === "open-restricted";
	// What is read into the prompt cannot be rewritten by a run that outside content may steer.
	const frozen = () => {
		const out = [`(deny file-write* ${[roots.userFile, ...WORKSPACE_FILES.map((f) => path.join(roots.workspace, f))].map((f) => `(literal ${q(f)})`).join(" ")})`];
		for (const dir of [roots.workspace, ...(roots.folder ? [roots.folder] : [])]) {
			out.push(`(deny file-write* (regex #"^${rx(dir)}/(.*/)?(${INSTRUCTION_FILES.map(rx).join("|")})$") (regex #"^${rx(dir)}/${GIT_RUNS_PROFILE}") ${subpaths(INSTRUCTION_DIRS.map((d) => path.join(dir, d)))})`);
		}
		// The owner let this conversation keep its own files: exactly those, by name, and nothing
		// that was not the agent's to write before. The last rule that matches a file decides.
		if (roots.ownOpen) out.push(`(allow file-write* ${ownFiles(roots).map((f) => `(literal ${q(f)})`).join(" ")})`);
		return out;
	};
	if (isOpen(variant)) {
		// The owner's own rights: bypass mode, or an agent whose scope is the account. What stays
		// closed is what would let an agent rewrite the system that runs it: pine's home
		// (configuration, secrets) and pine's code.
		return `${[
			"(version 1)",
			"(allow default)",
			`(deny file-read* file-write* (subpath ${q(roots.home)}))`,
			`(allow file-read-metadata (subpath ${q(roots.home)}))`,
			`(allow file-read* ${subpaths(roots.ownedRead.filter((r) => isInside(roots.home, r)))})`,
			`(allow file-write* ${subpaths(roots.ownedWrite.filter((r) => isInside(roots.home, r)))})`,
			`(deny file-read* file-write* ${subpaths(roots.secrets)})`,
			`(deny file-write* (subpath ${q(PINE_CODE)}))`,
			...(restricted ? frozen() : []),
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
	if (restricted) lines.push(...frozen());
	if (agent.sandbox.network || network) {
		// The network is addresses. A socket file is another program on this machine (a terminal
		// multiplexer, an ssh agent, an editor's helper: some run commands for whoever connects),
		// and stays closed. Two exceptions: the system's name lookup, and socket files in the
		// agent's own folders, which are its own programs talking to each other. Shared temp is
		// not one of those folders: that is where the other programs' sockets lie.
		const temp = [realish(os.tmpdir()), "/private/tmp"];
		lines.push(
			'(allow network-outbound (remote ip "*:*"))',
			'(allow network-inbound (local ip "*:*"))',
			'(allow network-bind (local ip "*:*"))',
			'(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
			`(allow network* ${subpaths(roots.write.filter((w) => !temp.includes(w)))})`,
			"(allow system-socket)",
			'(allow mach-lookup (global-name "com.apple.trustd.agent") (global-name "com.apple.trustd") (global-name "com.apple.SystemConfiguration.configd") (global-name "com.apple.SystemConfiguration.DNSConfiguration") (global-name "com.apple.dnssd.service") (global-name "com.apple.networkd") (global-name "com.apple.symptomsd"))',
		);
	}
	return `${lines.join("\n")}\n`;
}

/** Where a system program lies on this machine: the same few folders on macOS and Linux, never the agent's PATH. */
export function bin(name: string): string {
	return ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].map((d) => path.join(d, name)).find((f) => fs.existsSync(f)) ?? name;
}

let kind: "macos" | "linux" | null | undefined;
let bwrap = "";
let whyNot = "";
let bwrapSaid = "";
let userNamespacesRestricted = false;

/**
 * The rights a container has to be started with for a sandbox to work inside it: to create
 * namespaces, to give a sandbox without network its loopback interface, and past Docker's own
 * system call filter and AppArmor profile, which forbid the mounts. An ordinary user in the
 * container needs one more, to mount the sandbox's own /proc. (Each was tried by leaving it out.)
 */
export const containerFlags = (root = process.getuid?.() === 0) =>
	`--cap-add SYS_ADMIN --cap-add NET_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined${root ? "" : " --security-opt systempaths=unconfined"}`;

/** Whether pine runs inside a container (Docker, Podman, Kubernetes). */
export function inContainer(): boolean {
	const reads = (file: string) => {
		try {
			return fs.readFileSync(file, "utf8");
		} catch {
			return "";
		}
	};
	return fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv") || /docker|containerd|kubepods|lxc/.test(reads("/proc/1/cgroup"));
}

/**
 * Which sandbox this machine has: Apple's sandbox-exec on macOS, bubblewrap on Linux. On Linux
 * it is tried once, because bubblewrap can be installed and still not be allowed to work (a
 * system that has switched off user namespaces for ordinary users, some containers).
 */
export function sandboxKind(): "macos" | "linux" | undefined {
	if (kind !== undefined) return kind ?? undefined;
	kind = null;
	if (process.platform === "darwin") {
		if (fs.existsSync("/usr/bin/sandbox-exec")) kind = "macos";
		else whyNot = "sandbox-exec is missing";
	} else if (process.platform === "linux") {
		bwrap = [...(process.env.PATH ?? "").split(":").filter((d) => path.isAbsolute(d)), "/usr/bin", "/bin", "/usr/local/bin"].map((d) => path.join(d, "bwrap")).find((f) => fs.existsSync(f)) ?? "";
		if (!bwrap) whyNot = 'bubblewrap is not installed (the program is bwrap). Run "pine init": it installs it';
		else {
			try {
				const probe = jailed(bwrap, [...helperArgs([]), bin("true")], false);
				execFileSync(probe[0], probe.slice(1), { stdio: ["ignore", "ignore", "pipe"], timeout: 10_000 });
				kind = "linux";
			} catch (e) {
				// What bubblewrap itself said, not the command line it was given.
				const said = String((e as { stderr?: unknown }).stderr ?? "").trim().split("\n")[0] || (e instanceof Error ? e.message.split("\n")[0].slice(0, 120) : String(e));
				let apparmor = false;
				try {
					apparmor = fs.readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim() === "1";
				} catch {}
				bwrapSaid = said;
				userNamespacesRestricted = apparmor;
				const why = inContainer()
					? `This is a container that was started without the rights for one. Start it with: docker run ${containerFlags()} ...`
					: apparmor
						? 'AppArmor keeps it from creating user namespaces. Run "pine init": it adds the rule that allows it'
						: "Ordinary users may not create user namespaces here (a system that has switched them off)";
				whyNot = `bubblewrap is installed (${bwrap}) but cannot make a sandbox here ("${said}"). ${why}`;
			}
		}
	} else whyNot = `no sandbox is implemented for ${process.platform}`;
	return kind ?? undefined;
}

/**
 * What the try on Linux found, for setting the sandbox up (src/sandbox-setup.ts): where bwrap
 * is, whether it could make a sandbox, what it said when not, and whether AppArmor is why.
 */
export function sandboxFound(): { bwrap: string; works: boolean; said: string; apparmor: boolean } {
	const works = sandboxKind() === "linux";
	return { bwrap, works, said: bwrapSaid, apparmor: userNamespacesRestricted };
}

/** Look again: something that was missing may have been installed since. */
export function sandboxRecheck(): void {
	kind = undefined;
	bwrap = whyNot = bwrapSaid = "";
	userNamespacesRestricted = false;
}

export const sandboxAvailable = () => sandboxKind() !== undefined;
/** Why this machine has no sandbox, in words for the owner. */
export const sandboxMissing = () => (sandboxKind() ? "" : whyNot);

/** What a run that has handled outside content must not change, as the Linux sandbox needs it said. */
const protectedOf = (roots: Roots): Protected => ({
	roots: [roots.workspace, ...(roots.folder ? [roots.folder] : [])],
	files: [roots.userFile, ...WORKSPACE_FILES.map((f) => path.join(roots.workspace, f))],
	names: INSTRUCTION_FILES,
	dirs: INSTRUCTION_DIRS.filter((d) => !d.includes("/")),
	open: roots.ownOpen ? ownFiles(roots) : [],
});

/**
 * What to put in front of a command so that it runs with an agent's limits: the same rules on
 * both systems, said to Apple's sandbox as a profile and to bubblewrap as mounts. Made anew for
 * every command, because on Linux what exists at that moment is part of it.
 */
export function sandboxArgv(cfg: PineConfig, agent: AgentConfig, roots: Roots, variant: SandboxVariant | boolean, network = false): string[] {
	if (sandboxKind() !== "linux") return ["/usr/bin/sandbox-exec", "-p", sandboxProfile(cfg, agent, roots, variant, network)];
	const v: SandboxVariant = variant === true ? "restricted" : variant === false ? "normal" : variant;
	const net = agent.sandbox.network || network;
	// With the whole account it is the owner's own session. Otherwise sockets between programs go with the network, as on macOS.
	return jailed(
		bwrap,
		bwrapArgs({
			userHome: realish(os.homedir()),
			pineHome: roots.home,
			pineCode: PINE_CODE,
			read: roots.read,
			write: roots.write,
			ownedRead: roots.ownedRead,
			ownedWrite: roots.ownedWrite,
			closed: isOpen(v) ? roots.secrets : [...roots.secrets, ...roots.others, ...SESSIONS],
			network: net,
			variant: isOpen(v) ? "open" : v,
			frozen: v === "restricted" || v === "open-restricted" ? protectedNow(protectedOf(roots)) : undefined,
		}),
		isOpen(v) || net,
	);
}

/**
 * On Linux, mounts cannot forbid making a file of a protected name. Take this before a command
 * in the restricted variant and call `restore` after it: what the command made although it may
 * not is removed again. On macOS the profile forbids it outright and there is nothing to do.
 */
export function sandboxGuard(roots: Roots, variant: SandboxVariant | boolean): Guard | undefined {
	return sandboxKind() === "linux" && (variant === true || variant === "restricted" || variant === "open-restricted") ? new Guard(protectedOf(roots)) : undefined;
}

/**
 * What to put in front of a helper that works on things from anywhere (git looking at a folder,
 * a picture converter): it may read, write only in `write`, and has no network. Undefined where
 * there is no sandbox.
 */
export function helperArgv(write: string[] = []): string[] | undefined {
	const k = sandboxKind();
	if (k === "linux") return jailed(bwrap, helperArgs(write), false);
	if (k === "macos") return ["/usr/bin/sandbox-exec", "-p", `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* ${subpaths(write)} (literal "/dev/null"))`];
	return undefined;
}

/** Names of environment variables that look like they hold a credential. The ssh agent's socket is an address, not one. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;
const secretName = (k: string) => SECRET_NAME.test(k) && k !== "SSH_AUTH_SOCK";

/**
 * Environment for an agent's shell: nothing from the daemon except what a shell needs, and a
 * home of its own. With the whole account (`wide`) it is the owner's own home and environment,
 * so that git, ssh, npm and the owner's toolchains behave as in their terminal; what looks like
 * a credential by its name is still left out, and so is what belongs to the daemon.
 */
export function shellEnv(agent: AgentConfig, roots: Roots, sessionEnv: NodeJS.ProcessEnv, wide = false): NodeJS.ProcessEnv {
	const keep = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "USER", "LOGNAME", "SHELL"];
	const env: NodeJS.ProcessEnv = {};
	if (wide) {
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !secretName(k) && !/^(PI|PINE)_/.test(k)) env[k] = v;
		for (const [k, v] of Object.entries(sessionEnv)) if (k.startsWith("PI_") && !secretName(k)) env[k] = v;
		env.HOME = os.homedir();
		env.PINE_AGENT = agent.id;
		return { ...env, ...agent.sandbox.env };
	}
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
	if (!sandboxAvailable()) out.push(`no sandbox on this machine: ${sandboxMissing()}. Agents with the sandbox on get no shell, and command sources do not run; an agent with "sandbox": false runs its shell with the daemon's full permissions`);
	const homeMode = mode(cfg.home);
	if (homeMode !== undefined && homeMode & 0o077) out.push(`pine's home is open to other users (mode ${homeMode.toString(8)}); run: chmod 700 ${cfg.home}`);
	for (const a of Object.values(cfg.agents)) {
		const tools = a.tools ?? ["read", "bash", "edit", "write"];
		if (!a.sandbox.enabled && tools.includes("bash")) out.push(`agent ${a.id}: sandbox is off and bash is enabled; its commands can read and change anything the daemon user can`);
		if (a.sandbox.enabled && a.sandbox.network && tools.includes("bash")) out.push(`agent ${a.id}: shell has network access; a prompt injection could send workspace files anywhere (approval is required once the session has seen outside content)`);
		if (a.mode === "bypass") out.push(`agent ${a.id}: bypass mode. It never asks, and its shell reaches your whole account and the network${cfg.security.bypassWhenTainted ? ", even after it has read outside content (security.bypassWhenTainted)" : " (it asks again once a session has read outside content)"}`);
		// The main agent has the account unless told otherwise; that is how pine comes, and not a note. Another agent has it by somebody's choice.
		if (a.sandbox.enabled && a.mode !== "bypass" && a.id !== mainAgentId(cfg) && sandboxScope(cfg, a) === "account" && tools.includes("bash")) out.push(`agent ${a.id}: its shell and file tools reach your whole account and the network in your own conversations (scope "account"); once a conversation has read outside content you are asked whether it keeps that`);
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
	// A source type is a program inside the daemon, whoever wrote it. So is a module a single source names with "use".
	for (const [name, file] of Object.entries(cfg.sourceTypes)) out.push(`source type "${name}": ${file} runs inside pine with your rights, outside any sandbox`);
	for (const [where, sources] of [["pine.json", cfg.sources] as const, ...Object.values(cfg.agents).map((a) => [`agent ${a.id}`, a.sources] as const)]) {
		for (const [name, s] of Object.entries(sources)) {
			if (s.use) out.push(`${where}: the source "${name}" runs the module ${s.use} inside pine with your rights, outside any sandbox`);
			if (s.type === "webhook" && s.options.open === true) out.push(`${where}: the webhook source "${name}" has no secret; anyone who can reach the port can make it report`);
		}
	}
	for (const r of cfg.routes) if (r.trust === "owner") out.push(`route "${r.name}" treats events on ${r.on.join(", ")} as coming from you; whoever can publish there gets the agent's full tool set`);
	return out;
}
