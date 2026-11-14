// What a tool call is.
//
// One function sorts every tool call into a class, and the gate (src/agents.ts) decides per
// class and mode. What is critical is put to the owner in every conversation; after outside
// content, so is what sends something out. No model judges an action.
import os from "node:os";
import path from "node:path";
import { reaches, verbs } from "./access.ts";
import { isInside, ownFileOf, realish, type Roots, tilde } from "./security.ts";

/**
 * look:     only reads. Never asked about.
 * local:    changes something inside the agent's own folders (or the folder opened for the conversation).
 * reach:    acts beyond them: a shell that reaches the account or the network, a file elsewhere, a download.
 * send:     tells somebody or something outside: a message, an event, a server's tool that acts, another agent that can.
 * own:      the agent's memory and instructions, which are read into every later conversation.
 * critical: what makes other programs run or opens the account: shell startup files, keys, hooks; and destroying a lot at once.
 * setup:    changes pine itself. Such a tool asks the owner by its own rules.
 */
export type ActionClass = "look" | "local" | "reach" | "send" | "own" | "critical" | "setup";

/** Tools that only look. */
/** Tools that carry a call out as a nested call of another tool (src/catalogue.ts). */
export const ROUTERS = new Set<string>();
export const LOOK_TOOLS = ["read", "grep", "find", "ls", "state_get", "sources", "tool_search", "manual", "schedules", "mcp_servers", "skills", "stop_program", "question", "todo", "agents", "settings", "routes", "find_tools"];
/** Tools that change pine's setup or ask for access. Each asks the owner where it matters, so the gate does not ask again. */
export const SETUP_TOOLS = ["request_access", "add_mcp_server", "remove_mcp_server", "add_source", "remove_source", "add_source_type", "remove_source_type", "add_skill", "remove_skill", "add_schedule", "remove_schedule", "create_agent", "update_agent", "remove_agent", "set_setting", "add_route", "remove_route", "add_model_server", "remove_model_server"];

/**
 * Files and folders in the owner's home that make other programs run, or that are the keys to
 * the account. Writing one is never routine, whatever the conversation has read.
 */
const PROTECTED_HOME = [
	".zshrc", ".zshenv", ".zprofile", ".zlogin", ".bashrc", ".bash_profile", ".bash_login", ".profile", ".envrc",
	".config/fish", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".config/gcloud", ".docker/config.json", ".netrc", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pypirc",
	".gitconfig", ".config/git", "Library/LaunchAgents", ".config/systemd", ".config/autostart",
];
/** Parts of a path that mean the same anywhere: a repository's hooks and configuration run programs for whoever uses git there. */
const PROTECTED_ANYWHERE = /(^|\/)\.git\/(hooks(\/|$)|config$)|(^|\/)\.husky(\/|$)/;
/** The same names as they appear in a command line. */
const PROTECTED_IN_COMMAND = /(^|[\s"'=/~])(\.(zshrc|zshenv|zprofile|bashrc|bash_profile|profile|netrc|npmrc|pypirc|gitconfig)\b|\.ssh\/|\.gnupg\/|\.aws\/|\.kube\/|LaunchAgents\/|\.git\/hooks\/|\.git\/config\b|authorized_keys\b)/;

/** Whether a file is one of the protected ones. */
export function isProtectedPath(p: string): boolean {
	const home = realish(os.homedir());
	if (PROTECTED_ANYWHERE.test(p)) return true;
	return PROTECTED_HOME.some((rel) => isInside(path.join(home, rel), p));
}

/** Commands that only look, as far as their name says. */
const READ_ONLY = new Set(["ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "date", "whoami", "id", "uname", "hostname", "which", "type", "file", "stat", "du", "df", "ps", "lsof", "env", "printenv", "grep", "rg", "find", "fd", "tree", "sort", "uniq", "cut", "tr", "diff", "cmp", "basename", "dirname", "realpath", "true", "test", "sleep", "jq", "nproc", "uptime"]);
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "blame", "ls-files", "rev-parse", "describe", "shortlog", "remote", "branch", "tag", "stash list"]);

/**
 * Whether a command line only looks. Deliberately narrow: anything that could write (a
 * redirect, a substitution, an option that runs or deletes) is not one. A wrong "no" costs a
 * question; a wrong "yes" would let an action through unseen.
 */
export function readOnlyCommand(command: string): boolean {
	const text = command.trim();
	if (!text || /[<>`]|\$\(|\$\{|\n/.test(text)) return false;
	for (const part of text.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
		const words = part.trim().split(/\s+/);
		const name = words[0]?.split("/").pop() ?? "";
		if (!name) return false;
		if (name === "git") {
			const sub = words.slice(1).find((w) => !w.startsWith("-")) ?? "";
			if (!READ_ONLY_GIT.has(sub)) return false;
			// "git branch -D x", "git remote add", "git tag -d": the same word, another thing.
			if (/\s(-[dDmM]\b|--delete\b|--force\b|add\b|remove\b|rm\b|set-url\b|rename\b)/.test(part)) return false;
			continue;
		}
		if (!READ_ONLY.has(name)) return false;
		if (name === "find" && /\s-(delete|exec|execdir|ok|fprint)/.test(part)) return false;
		if ((name === "sort" || name === "tree" || name === "uniq") && /\s-o\b|\s--output/.test(part)) return false;
		if (name === "env" && words.length > 1) return false;
	}
	return true;
}

/** Why a command line is critical, or undefined. Patterns, so they are a net and not a wall: what they catch is put to the owner. */
export function criticalCommand(command: string): string | undefined {
	const c = command;
	if (/\b(curl|wget|fetch)\b[^|;&\n]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(python\d?|node|perl|ruby)\b/.test(c)) return "downloads a program and runs it in one step";
	if (/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]*\s+)*["']?(\/|~|\$HOME|\/Users\/[^/\s"']+|\/home\/[^/\s"']+)\/?["']?(\s|$)/.test(c)) return "deletes a home folder or the whole disk";
	if (/\bgit\s+push\b[^\n;&|]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/.test(c)) return "rewrites what was pushed (force push)";
	if (/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s+\.|restore\s+\.)/.test(c)) return "throws away changes that were not committed";
	if (/\bsudo\b/.test(c)) return "runs with administrator rights";
	if (!readOnlyCommand(c) && PROTECTED_IN_COMMAND.test(c)) return "touches a file that makes other programs run or holds the keys to the account";
	if (/\b(chmod|chown)\s+-[a-zA-Z]*R[a-zA-Z]*\s+\S+\s+(\/|~|\$HOME)\/?(\s|$)/.test(c)) return "changes the permissions of a whole home folder or disk";
	if (/\blaunchctl\s+(load|bootstrap|submit)\b|\bsystemctl\s+(--user\s+)?enable\b|\bcrontab\s+(?!-l\b)\S/.test(c)) return "installs something that keeps running or starts by itself";
	return undefined;
}

/**
 * What a shell without a sandbox ("auto" and "bypass" mode) is refused because it is pine's own:
 * pine's home (configuration, secrets, the other agents' folders), writing pine's program files,
 * the pine program, and pine's control port. In a sandbox the operating system keeps these closed. Here it is this reading
 * of the command line, so it is a net and not a wall: what a script or a variable holds is not
 * seen, and a command that walks a whole folder is not followed into it.
 */
export function pineOwn(command: string, o: { home: string; own: string[]; code: string; cwd: string; ownerHome: string; port?: number }): string | undefined {
	const where = { cwd: o.cwd, shellHome: o.ownerHome, ownerHome: o.ownerHome };
	const closed = (p: string) => isInside(o.home, p) && !o.own.some((r) => isInside(r, p));
	// A path with ".." is read from where the shell starts. After a "cd" that is no longer where
	// the command is, so only what stands up to the first one is read that way.
	const moved = /(^|[;&|(\n])\s*(cd|pushd)\s+("[^"]*"|'[^']*'|[^\s;&|)]+)/.exec(command);
	const start = moved ? command.slice(0, moved.index + moved[0].length) : command;
	const named = [...reaches(command, where).filter((r) => !r.text.startsWith("..")), ...reaches(start, where).filter((r) => r.text.startsWith(".."))];
	const hit = named.find((r) => closed(realish(r.path)));
	if (hit) return `${hit.text} is part of pine itself, which is closed to every agent in every mode`;
	// pine's program files can be read. What a command plainly writes there (a redirect, touch, rm, cp to it) is not run.
	const written = named.find((r) => r.write && isInside(o.code, realish(r.path)));
	if (written) return `${written.text} is part of pine's own code, which agents cannot change`;
	if (verbs(command).some((v) => v === "pine" || v === "pine.js") || /(^|[\s"'/])bin\/pine\.js(\s|$)/.test(command)) return "the pine program is your owner's way to run and change pine, and not for agents";
	if (o.port && new RegExp(`(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[?::1\\]?)(:|\\s+)${o.port}\\b`).test(command)) return `port ${o.port} on this computer is pine's own control port, which is closed to every agent`;
	return undefined;
}

/** What an agent is told when `pineOwn` refuses a command. */
export const pineOwnRefusal = (why: string) => `Not run: ${why}. Do not look for another way. What pine holds for you, your tools tell you (sources, schedules, mcp_servers, skills, manual).`;

export interface ActionContext {
	roots: Roots;
	/** What a relative path is relative to. */
	cwd: string;
	/** Whether this session's shell reaches beyond the agent's own folders: the account, the network, or no sandbox at all. */
	shellReaches: boolean;
	/** For a tool of an MCP server: whether the server says it only reads, and whether its acting tools are to be looked at. */
	mcp?: { readOnly: boolean; watched: boolean };
	/** For a tool of the bundled app control server: whether it only looks at an app. */
	app?: { look: boolean };
	/** Whether the agent's configuration counts this tool as sending something out (`approveWhenTainted`). */
	sends: boolean;
	/** Whether the agent a task is handed to can send things out. */
	canSendOut(agent: string): boolean;
	/** Whether an address is one the agent can read anyway. */
	reachable(url: unknown): boolean;
	/** For a shell without a sandbox: why a command is critical because of what it names (pine's own program files), or undefined. */
	names?(command: string): string | undefined;
}

export interface Action {
	cls: ActionClass;
	/** What makes it that class, when that needs saying. */
	note?: string;
}

/** Sort a tool call into its class. The one place that knows. */
export function classify(tool: string, input: any, ctx: ActionContext): Action {
	// A tool that only hands the call on to the tool that is meant: that call is the one that is looked at.
	if (ROUTERS.has(tool)) return { cls: "look" };
	if (ctx.sends) return { cls: "send" };
	if (tool === "add_skill") return { cls: "own", note: "a skill is part of what the agent is told" };
	// Subscribing changes what wakes the agent. The gate asks about it where the conversation has read outside content.
	if (SETUP_TOOLS.includes(tool) || tool === "subscribe" || tool === "unsubscribe") return { cls: "setup" };
	if (LOOK_TOOLS.includes(tool)) return { cls: "look" };
	// App control. Looking at an app only reads. Acting in one is what the owner said yes to, app by
	// app, for the conversation: it is not asked about click by click. An owner who wants each
	// action looked at sets "approve" on the server.
	if (ctx.app) return ctx.app.look ? { cls: "look" } : ctx.mcp?.watched ? { cls: "send", note: "a tool of a server that acts on your behalf" } : { cls: "local", note: "acts in an app the owner allowed for this conversation" };
	if (ctx.mcp) return ctx.mcp.readOnly ? { cls: "look" } : ctx.mcp.watched ? { cls: "send", note: "a tool of a server that acts on your behalf" } : { cls: "local" };
	if (tool === "bash") {
		const command = String(input?.command ?? "");
		const critical = criticalCommand(command) ?? (readOnlyCommand(command) ? undefined : ctx.names?.(command));
		if (critical) return { cls: "critical", note: critical };
		if (readOnlyCommand(command)) return { cls: "look" };
		return { cls: ctx.shellReaches ? "reach" : "local" };
	}
	if (tool === "write" || tool === "edit") {
		const given = typeof input?.path === "string" && input.path ? input.path : ".";
		if (ownFileOf(ctx.roots, given, ctx.cwd)) return { cls: "own", note: "the agent's own memory or instructions" };
		const target = tilde(given);
		const p = realish(path.isAbsolute(target) ? target : path.join(ctx.cwd, target));
		if (isProtectedPath(p)) return { cls: "critical", note: "a file that makes other programs run or holds the keys to the account" };
		const mine = [ctx.roots.workspace, ctx.roots.sandboxHome, ...(ctx.roots.folder ? [ctx.roots.folder] : [])];
		return { cls: mine.some((r) => isInside(r, p)) ? "local" : "reach" };
	}
	if (tool === "download") return { cls: ctx.reachable(input?.url) ? "local" : "reach" };
	if (tool === "delegate") return { cls: ctx.canSendOut(String(input?.agent ?? "")) ? "send" : "local", note: "hands a task to an agent that can send things out" };
	return { cls: "local" };
}

/** What an agent is told when it tries to act while its owner has it planning. */
export const PLAN_REFUSAL =
	"Not done: you are in plan mode. In plan mode you look, read, search and ask, and nothing is changed, run or sent. Do not try another way to do it. When you have seen enough, answer with your plan: what you would do, in which order, in which files, and what could go wrong. Your owner reads it and switches the mode when it is to be carried out.";
