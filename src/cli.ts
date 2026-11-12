#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { ConfigError, defaultHome, effectiveMcp, loadConfig, mainAgentId, PINE_ROOT, type PineConfig, sandboxScope } from "./config.ts";
import { audit } from "./security.ts";
import { pineManual, showRead, showSearch } from "./manual.ts";
import { modelKeys } from "./models.ts";
import { allSkills, listSkills } from "./skills.ts";
import { whenText } from "./timers.ts";
import { expandHome } from "./util.ts";

const HELP = `pine - PI neural engine

Start here
  pine                            open the terminal UI (same as "pine tui")
  pine . | pine <folder>          the same, with a tab on that folder: a conversation of the main agent that
                                  works there (the one from last time, if there is one)
  pine tui                        chat with your agents; starts a daemon inside if none is running
  pine login <provider>           sign in to a model provider (OpenCode, Claude, ChatGPT, ...)
  pine logout <provider>
  pine model add <name> <address> [--context tokens] [--reasoning | --no-reasoning]
                                  add a model server of your own (llama.cpp, vLLM, LM Studio, ...): pine asks
                                  it for its models, and for its key if it wants one
  pine model list | pine model remove <name>

Daemon
  pine init [dir] [--yes]         set pine up: a home directory (default ~/.pine) from the example, the browser
                                  its web tools use, and on Linux the sandbox (asks before it runs anything
                                  as administrator; --yes skips the question). Safe to run again
  pine check                      validate the configuration and list what it sets up
  pine start                      run the daemon in the foreground
  pine dev-model [--port 7464] [--model haiku]
                                  OpenAI-compatible model server backed by "claude -p" (development only)
  pine update [--check]           bring pine up to date (npm for an install, git for a checkout) with what the
                                  new version needs; --check only says whether there is something newer
  pine version                    which version this is and how it is installed
  pine browser-install            fetch the browser again (pine init and pine update do this)

Talking to a running daemon
  pine status                     running tasks, live sessions, queue
  pine agents                     configured agents
  pine send <agent> <text...>     give an agent a task and print its answer
       [--session <key>] [--no-wait]
  pine emit <topic> [json]        publish an event
  pine events [--topic <pattern>] [--limit n] [-f]
                                  show the event log; -f follows live
  pine tasks [--agent id] [--status s]    recent tasks
  pine task <id>                  one task in full
  pine cancel <id>                stop a task
  pine state [key-pattern]        shared state
  pine approvals                  open approval requests
  pine approve <id> [--always] | pine deny <id>     --always: do not ask again in that conversation
  pine reset <agent> [session]    forget a conversation (also clears its taint)
  pine mode <agent> [manual|auto|bypass]
                                  show or change how much an agent may do without asking

Event sources
  pine sources                    configured sources, whether they run, who is subscribed, last event
  pine subscribe <agent> <source> [--session name] [--note text] [--throttle 5m] [--when json] [--separate]
                                  wake that agent whenever the source reports something: in its main
                                  conversation, or only the conversation named with --session
  pine subscribe --global <source> [--note text] ...
                                  wake every agent that can use the source
  pine unsubscribe <agent> <source> [--session name]   |   pine unsubscribe --global <source>

Schedules, skills, the manual
  pine schedules                  what is scheduled: for whom, when, and the task
  pine skills                     every skill: whom it is for and where it lies
  pine manual <words>             search pine's manual, as the agents do; --read <id> shows a part in full

MCP servers
  pine mcp list                   configured servers, who gets them, and whether they connect
  pine mcp add <name> <https-url> [--agent id] [--taints] [--approve always|tainted] [--timeout seconds]
  pine mcp add <name> [--agent id] -- <command> [args...]
  pine mcp remove <name> [--agent id]
  pine mcp login <name>           sign in to a remote server through the browser (OAuth)
  pine mcp logout <name>

Options
  --home <dir>                    home directory (default $PINE_HOME or ~/.pine)
`;

function parseArgs(argv: string[]) {
	const flags: Record<string, string | boolean> = {};
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-f") flags.follow = true;
		else if (a.startsWith("--no-")) flags[a.slice(5)] = false;
		else if (a.startsWith("--")) flags[a.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") && !["follow", "json", "api-key", "oauth", "taints", "offline", "always", "separate", "global", "yes"].includes(a.slice(2)) ? argv[++i] : true;
		else rest.push(a);
	}
	return { flags, rest };
}

function copyDir(from: string, to: string, skip: (dst: string) => boolean = () => false): string[] {
	const created: string[] = [];
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		const src = path.join(from, entry.name);
		const dst = path.join(to, entry.name === ".env.example" ? ".env" : entry.name);
		if (entry.isDirectory()) {
			fs.mkdirSync(dst, { recursive: true });
			created.push(...copyDir(src, dst, skip));
		} else if (!fs.existsSync(dst) && !skip(dst)) {
			fs.copyFileSync(src, dst);
			fs.chmodSync(dst, 0o600);
			created.push(dst);
		}
	}
	return created;
}

function client(cfg: PineConfig) {
	if (!cfg.http) throw new Error("http is disabled in pine.json, so there is no control API to talk to");
	const tokenFile = path.join(cfg.dataDir, "http-token");
	const token = cfg.http.token ?? (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "");
	const base = `http://${cfg.http.host === "0.0.0.0" ? "127.0.0.1" : cfg.http.host}:${cfg.http.port}`;
	const call = async (method: string, url: string, body?: unknown) => {
		let res: Response;
		try {
			res = await fetch(base + url, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
		} catch {
			throw new Error(`no daemon answers on ${base}. Start it with "pine start".`);
		}
		const json: any = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
		return json;
	};
	return { base, token, get: (u: string) => call("GET", u), post: (u: string, b: unknown = {}) => call("POST", u, b) };
}

const when = (ts: number) => new Date(ts).toLocaleString("sv-SE");
const line = (e: any) => `${when(e.ts)}  #${String(e.id).padEnd(5)} ${e.topic.padEnd(34)} ${e.trust === "owner" ? "owner    " : "untrusted"} ${e.source.padEnd(14)} ${JSON.stringify(e.payload).slice(0, 160)}`;

/** pine mcp list | add | remove | login | logout */
async function mcpCommand(cfg: PineConfig, argv: string[], out: (v: unknown) => void): Promise<void> {
	const { addServer, findServer, listServers, piMcp, removeServer, serverStates } = await import("./mcp-config.ts");
	// Everything after "--" is the command line of a local server.
	const dashes = argv.indexOf("--");
	const command = dashes >= 0 ? argv.slice(dashes + 1) : [];
	const { flags, rest } = parseArgs((dashes >= 0 ? argv.slice(0, dashes) : argv).filter((a, i, all) => !(a === "--home" || all[i - 1] === "--home")));
	const sub = rest.shift() ?? "list";
	const agent = typeof flags.agent === "string" ? flags.agent : undefined;
	// A running daemon applies the change at once; without one the files are edited and it applies at the next start.
	const live = async (body: unknown): Promise<boolean> => {
		try {
			const api = client(cfg);
			if (!(await fetch(`${api.base}/health`, { signal: AbortSignal.timeout(800) })).ok) return false;
			await api.post("/mcp", body);
			return true;
		} catch (e) {
			if (e instanceof Error && !/no daemon|fetch failed|HTTP 404|not found|aborted|timeout/i.test(e.message)) throw e;
			return false;
		}
	};
	switch (sub) {
		case "list": {
			const servers = listServers(cfg);
			if (!servers.length) return out("no MCP servers configured");
			const states = flags.offline ? {} : await serverStates(cfg);
			for (const s of servers) out(`${s.name.padEnd(14)} ${(s.enabled ? (states[s.name] ?? (s.remote ? "?" : "local")) : "disabled").padEnd(16)} ${s.scope === "global" ? `all: ${s.agents.join(", ") || "nobody"}` : `only ${s.scope}`}\n${" ".repeat(15)}${s.target}${s.taints ? "  [outside content]" : ""}${s.approve !== "never" ? `  [approval: ${s.approve}]` : ""}`);
			return;
		}
		case "add": {
			const name = rest[0];
			const url = rest[1];
			if (!name || (!url && !command.length)) throw new Error("usage: pine mcp add <name> <https-url> [--agent id] [--taints] [--approve always|tainted] [--timeout seconds] [--description text]\n       pine mcp add <name> [--agent id] -- <command> [args...]");
			const server: any = url ? { url } : { command: command[0], args: command.slice(1) };
			if (typeof flags.description === "string") server.description = flags.description;
			if (flags.taints === true) server.taints = true;
			if (flags.timeout !== undefined) {
				if (!(Number(flags.timeout) > 0)) throw new Error("--timeout takes a number of seconds, for example --timeout 180");
				server.timeout = Number(flags.timeout);
			}
			if (typeof flags.approve === "string") server.approve = flags.approve;
			if (typeof flags.exposure === "string") server.exposure = flags.exposure;
			if (!(await live({ name, server, agent }))) addServer(cfg, name, server, agent);
			out(`Added "${name}" ${agent ? `for agent ${agent}` : "for all agents"}.${url ? ` If it requires sign-in: pine mcp login ${name}` : ""}`);
			return;
		}
		case "remove": {
			if (!rest[0]) throw new Error("usage: pine mcp remove <name> [--agent id]");
			if (!(await live({ name: rest[0], agent, remove: true })) && !removeServer(cfg, rest[0], agent)) throw new Error(`no server "${rest[0]}"${agent ? ` on agent ${agent}` : " in pine.json"}`);
			return out(`Removed "${rest[0]}".`);
		}
		case "login":
		case "logout": {
			const name = rest[0];
			const server = name ? findServer(cfg, name, agent) : undefined;
			if (!name || !server) throw new Error(name ? `no server "${name}". pine mcp list shows what is configured.` : `usage: pine mcp ${sub} <name>`);
			if (!server.url) throw new Error(`"${name}" is a local server; only remote servers have a sign-in`);
			const { code } = await piMcp(cfg, { [name]: server }, [sub, name]);
			if (code === 0 && sub === "login") {
				// Sessions that started before the sign-in do not have the server's tools yet.
				try {
					await client(cfg).post("/mcp/refresh");
				} catch {
					// No daemon running: nothing to refresh.
				}
			}
			process.exitCode = code;
			return;
		}
		default:
			throw new Error(`unknown: pine mcp ${sub}. Use list, add, remove, login or logout.`);
	}
}

/**
 * Download the Chromium build the bundled browser tools drive. It has to match the Playwright
 * version pine ships with, so that copy's own installer is used. Quick when it is there already.
 */
async function installBrowser(): Promise<number> {
	const { spawnSync } = await import("node:child_process");
	const { createRequire } = await import("node:module");
	const cli = path.join(path.dirname(createRequire(import.meta.url).resolve("playwright-core")), "cli.js");
	return spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" }).status ?? 1;
}

const COMMANDS = new Set(["agents", "approvals", "approve", "browser-install", "cancel", "check", "deny", "dev-model", "emit", "events", "help", "init", "login", "logout", "manual", "mcp", "mode", "model", "reset", "schedules", "send", "skills", "sources", "start", "state", "status", "subscribe", "task", "tasks", "tui", "unsubscribe", "update", "version"]);

/** Whether a first argument means a folder to open: something written as a path, or the name of a folder here that is not a command. */
function folderArgument(word: string | undefined, cwd = process.cwd()): string | undefined {
	if (!word || COMMANDS.has(word)) return undefined;
	const full = path.resolve(cwd, expandHome(word));
	const isDir = (() => {
		try {
			return fs.statSync(full).isDirectory();
		} catch {
			return false;
		}
	})();
	if (isDir) return full;
	// Written as a path but not there: an error about the folder says more than "unknown command".
	if (/^(\.{1,2}|~)($|\/)|\//.test(word)) throw new Error(`${word} is not a folder`);
	return undefined;
}

async function main(): Promise<void> {
	const { flags, rest } = parseArgs(process.argv.slice(2));
	let cmd = rest.shift();
	// "pine ." and "pine ~/dev/project" open the terminal UI with a tab on that folder.
	let folder = folderArgument(cmd);
	if (folder) cmd = "tui";
	else if (cmd === "tui") folder = folderArgument(rest[0]);
	const home = path.resolve(expandHome(typeof flags.home === "string" ? flags.home : defaultHome()));
	const out = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

	if (cmd === "help" || flags.help || (!cmd && !process.stdout.isTTY)) return out(HELP);

	if (cmd === "manual") {
		// The same search the agents use, for you and for trying out what they would find.
		const manual = pineManual(path.join(PINE_ROOT, "docs"));
		if (typeof flags.read === "string") return out(showRead(manual, flags.read.split(",")));
		if (!rest.length) return out(`The parts of pine's manual. Search it (pine manual telegram pairing), or read a part (pine manual --read sources#telegram).\n${manual.contents()}`);
		return out(showSearch(manual, [rest.join(" ")]));
	}


	if (cmd === "init") {
		const target = path.resolve(expandHome(rest[0] ?? home));
		fs.mkdirSync(target, { recursive: true, mode: 0o700 });
		fs.chmodSync(target, 0o700);
		// A home from before instructions moved into the workspace keeps them where they are: with
		// a second AGENTS.md in the workspace the agent would have both.
		const kept: string[] = [];
		const created = copyDir(path.join(PINE_ROOT, "examples", "home"), target, (dst) => {
			const old = path.join(path.dirname(path.dirname(dst)), "AGENTS.md");
			const twice = path.basename(dst) === "AGENTS.md" && path.basename(path.dirname(dst)) === "workspace" && fs.existsSync(old);
			if (twice) kept.push(old);
			return twice;
		});
		out(created.length ? `Created in ${target}:\n${created.map((f) => `  ${path.relative(target, f)}`).join("\n")}` : `${target} already has every example file; nothing changed.`);
		for (const old of kept) out(`\n${path.relative(target, old)} stays where it is: there the agent reads it but cannot change it. To let the agent keep its own instructions, move it to ${path.relative(target, path.join(path.dirname(old), "workspace", "AGENTS.md"))}.`);
		// Everything the built-in tools need comes with it, so that what is set up also works. The
		// browser is the one large piece; a second run finds it there and takes a moment.
		// (PINE_SKIP_DOWNLOADS is for pine's own tests, which must not fetch 600 MB.)
		let noBrowser = 0;
		if (!process.env.PINE_SKIP_DOWNLOADS) {
			out("\nGetting the browser the built-in web tools drive (about 600 MB, once) ...");
			noBrowser = await installBrowser();
		}
		// On Linux the sandbox needs a package and, on some systems, a rule only an administrator
		// can load; the browser needs system libraries. pine says what it would run and does it
		// after one yes; nothing is left to a manual.
		let noSandbox = false;
		if (process.platform === "linux") {
			const { setUpSandbox } = await import("./sandbox-setup.ts");
			noSandbox = !(await setUpSandbox({
				out,
				yes: flags.yes === true,
				confirm: async (question) => {
					if (!process.stdin.isTTY) return undefined;
					const readline = await import("node:readline");
					const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
					const answer = await new Promise<string>((resolve) => rl.question(`${question} [Y/n] `, resolve));
					rl.close();
					return !/^n/i.test(answer.trim());
				},
			}));
		}
		if (noBrowser !== 0) {
			out(`\nThe browser could not be downloaded (exit ${noBrowser}). Everything else is set up; web search and page reading work without it. Run "pine init" again when you are online to get it.`);
			process.exitCode = 1;
			return;
		}
		out(`\nReady. Start with: pine${target === defaultHome() ? "" : ` --home ${target}`}\nThe example uses Claude through "claude -p". For another model: pine login <provider>, then /model in the UI.${noSandbox ? "\nThe sandbox is not set up (see above): until it is, agents get no shell. pine check says where it stands." : ""}`);
		return;
	}

	if (cmd === "browser-install") process.exit(await installBrowser());

	if (cmd === "version" || flags.version === true) {
		const { installed } = await import("./update.ts");
		const me = installed();
		return out(`pine ${me.version} (${me.kind === "checkout" ? `checkout in ${me.root}` : me.kind === "global" ? "installed with npm" : `a dependency in ${me.root}`})`);
	}

	if (cmd === "update") {
		const { update } = await import("./update.ts");
		process.exit(await update({ check: flags.check === true, out, browser: !process.env.PINE_SKIP_DOWNLOADS }));
	}

	if (cmd === "dev-model") {
		const { startClaudeModel } = await import("./dev/claude-model.ts");
		const server = await startClaudeModel({ port: Number(flags.port ?? 7464), model: typeof flags.model === "string" ? flags.model : "haiku", log: (l) => console.error(`${new Date().toISOString()} ${l}`) });
		out(`claude -p model server on ${server.baseUrl} (model ids: claude-haiku, claude-sonnet, claude-opus). Ctrl-C to stop.`);
		process.on("SIGINT", () => void server.close().then(() => process.exit(0)));
		return;
	}

	if ((!cmd || cmd === "tui") && !fs.existsSync(path.join(home, "pine.json"))) return out(`No pine home at ${home} yet. Create one with:\n\n  pine init\n\n${HELP}`);
	const cfg = loadConfig(home);

	if (!cmd || cmd === "tui") {
		const { runTui } = await import("./tui/run.ts");
		return runTui(cfg, { folder });
	}

	if (cmd === "login" || cmd === "logout") {
		const { login, logout } = await import("./login.ts");
		if (!rest[0]) throw new Error(`usage: pine ${cmd} <provider>   (for example opencode-go, opencode, anthropic, openai-codex)`);
		if (cmd === "login") await login(cfg, rest[0], flags["api-key"] === true ? "api_key" : flags.oauth === true ? "oauth" : undefined);
		else await logout(cfg, rest[0]);
		return;
	}

	if (cmd === "mcp") return mcpCommand(cfg, process.argv.slice(process.argv.indexOf("mcp") + 1), out);

	if (cmd === "model") {
		const { addModelServer, checkServerName, listModelServers, lookAt, modelKeyName, removeModelServer, serverUrl } = await import("./models.ts");
		const sub = rest.shift() ?? "list";
		const sized = (m: { contextWindow?: number; images: boolean; reasoning: boolean }) => `${m.contextWindow ? `${m.contextWindow} tokens of context` : "context not given"}, ${m.images ? "text and pictures" : "text"}${m.reasoning ? ", thinks" : ""}`;
		// A running daemon reads the file again at once; without one it is read at the next start.
		const refreshed = async (): Promise<boolean> => {
			try {
				const api = client(cfg);
				if (!(await fetch(`${api.base}/health`, { signal: AbortSignal.timeout(800) })).ok) return false;
				await api.post("/models/refresh");
				return true;
			} catch {
				return false;
			}
		};
		if (sub === "list") {
			const servers = listModelServers(cfg.home);
			if (!servers.length) return out("no model servers of your own. Add one with: pine model add <name> <address>   (for example: pine model add studio http://127.0.0.1:8080)");
			for (const s of servers) {
				out(`${s.name}  ${s.baseUrl}  key: ${s.key}`);
				for (const m of s.models) out(`    ${s.name}/${m.id}  ${sized(m)}`);
			}
			return;
		}
		if (sub === "add") {
			const [name, address] = rest;
			if (!name || !address) throw new Error("usage: pine model add <name> <address> [--context tokens] [--reasoning | --no-reasoning]\n       for example: pine model add studio http://127.0.0.1:8080");
			const baseUrl = serverUrl(address);
			const { knownProviders, readSecret } = await import("./login.ts");
			checkServerName(name, await knownProviders(cfg));
			let look = await lookAt(baseUrl);
			let key: string | undefined;
			if (look.locked) {
				key = await readSecret(`${new URL(baseUrl).host} wants a key. API key`);
				process.stdin.pause();
				if (!key) throw new Error("no key given; nothing was added");
				look = await lookAt(baseUrl, key);
				if (look.locked) throw new Error("the server did not accept that key; nothing was added");
			}
			const context = flags.context === undefined ? undefined : Number(flags.context);
			const models = addModelServer(cfg.home, { name, baseUrl, key, models: look.models, context, reasoning: typeof flags.reasoning === "boolean" ? flags.reasoning : undefined });
			const live = await refreshed();
			out(`Added "${name}" at ${baseUrl}`);
			for (const m of listModelServers(cfg.home).find((s) => s.name === name)?.models ?? []) out(`    ${name}/${m.id}  ${sized(m)}`);
			if (key) out(`Its key is in ${path.join(cfg.home, ".env")} as ${modelKeyName(name)}.`);
			return out(`${live ? "The running pine has it now." : "pine has it when it next starts."} Choose a model with /model ${models[0]} in the terminal UI.`);
		}
		if (sub === "remove") {
			if (!rest[0]) throw new Error("usage: pine model remove <name>");
			if (!removeModelServer(cfg, rest[0])) throw new Error(`no model server "${rest[0]}". pine model list shows what there is.`);
			await refreshed();
			return out(`Removed "${rest[0]}".`);
		}
		throw new Error(`unknown: pine model ${sub}. Use add, list or remove.`);
	}

	if (cmd === "schedules") {
		const list = [...cfg.schedules.map((s) => ({ s, whom: s.task ? "all agents" : `event ${s.topic} only` })), ...Object.values(cfg.agents).flatMap((a) => a.schedules.map((s) => ({ s, whom: s.session ? `conversation ${s.session} of ${a.id}` : `agent ${a.id}` })))];
		if (!list.length) return out("nothing is scheduled. An agent schedules something when you ask it to (\"every morning at seven ...\", \"remind me at five\"), or write it under \"schedules\"; see docs/references/events.md");
		for (const { s, whom } of list) {
			out(`${s.name}  ${whom}  ${whenText(s)}`);
			if (s.task) out(`    ${s.task}`);
		}
		return;
	}

	if (cmd === "skills") {
		const list = allSkills(cfg);
		if (!list.length) return out("no skills yet. An agent writes one when you ask it to (\"make a skill for this\"), or put a folder with a SKILL.md into the skills folder of pine's home or of an agent; see docs/references/agents.md");
		for (const s of list) {
			out(`${s.name}  ${s.scope === "global" ? "all agents" : s.scope === "agent" ? `agent ${s.agent}` : `conversation ${s.session} of ${s.agent}`}${s.managed ? "" : "  [yours, from the configuration]"}`);
			out(`    ${s.description}`);
			out(`    ${s.dir}`);
		}
		return;
	}

	if (cmd === "check") {
		out(`home       ${cfg.home}`);
		out(`http       ${cfg.http ? `${cfg.http.host}:${cfg.http.port}, hooks: ${Object.keys(cfg.http.hooks).join(", ") || "none"}` : "off"}`);
		out(`global mcp ${Object.keys(cfg.mcp).join(", ") || "none"}`);
		out(`routes     ${cfg.routes.length}, schedules ${cfg.schedules.length}`);
		for (const a of Object.values(cfg.agents)) {
			out(`\nagent ${a.id}${a.id === mainAgentId(cfg) ? " (main)" : ""}: ${a.description || "no description"}`);
			out(`  workspace  ${a.workspace}`);
			out(`  model      ${a.model ?? cfg.defaults.model}`);
			out(`  tools      ${(a.tools ?? ["read", "bash", "edit", "write"]).join(", ")}`);
			out(`  mcp        ${Object.keys(effectiveMcp(cfg, a)).join(", ") || "none"}`);
			// App control is given by where pine runs and how far the agent reaches, not by the list above alone.
			if (Object.values(effectiveMcp(cfg, a)).some((s) => s.pine === "computer")) {
				out(`  apps       ${process.platform !== "darwin" ? "not on this system: app control works on macOS only" : sandboxScope(cfg, a) !== "account" ? "no: app control is for an agent that reaches your whole account" : "it can operate the apps on this Mac in your own conversations; you are asked once per app"}`);
			}
			out(`  skills     ${listSkills(cfg, a, "main").map((s) => s.name).join(", ") || "none"}`);
			out(`  delegates  ${a.delegates.join(", ") || "none"}; sub-agents ${a.subagents.enabled ? `up to ${a.subagents.maxParallel}` : "off"}`);
			out(`  mode       ${a.mode}`);
			// What that means for this agent, so that nobody has to read code to know.
			const reach = sandboxScope(cfg, a) === "account" ? "your whole account and the network" : `its own folder${a.sandbox.network ? " and the network" : ""}`;
			const after = cfg.security.taint === "off" ? "nothing changes" : cfg.security.review === "model" ? "it keeps that; what reaches out, sends or changes its memory is checked by the reviewer" : cfg.security.review === "ask" ? "it loses that until you say, once, that the conversation keeps it" : "it keeps that, and nothing is checked";
			out(`  reaches    ${a.sandbox.enabled ? reach : "everything the daemon can (no sandbox)"}`);
			out(`  after outside content: ${a.mode === "bypass" && cfg.security.bypassWhenTainted ? "nothing changes (bypass)" : after}`);
			out(`  sandbox    ${a.sandbox.enabled ? `on, network ${a.sandbox.network ? "allowed" : "blocked"}` : "OFF"}; untrusted events: ${a.untrusted === false ? "refused" : a.untrusted.tools.join(", ") || "no tools"}`);
		}
		const keys = modelKeys(cfg.home).problems;
		if (keys.length) out(`\nModel notes:\n${keys.map((k) => `  ! ${k}`).join("\n")}`);
		const warnings = audit(cfg);
		out(warnings.length ? `\nSecurity notes:\n${warnings.map((w) => `  ! ${w}`).join("\n")}` : "\nNo security notes.");
		return;
	}

	if (cmd === "start") {
		const { startPine } = await import("./pine.ts");
		// One misbehaving extension or MCP client must not take every agent down with it.
		process.on("unhandledRejection", (e) => console.error(`${new Date().toISOString()} ERROR [pine] unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : e}`));
		process.on("uncaughtException", (e) => console.error(`${new Date().toISOString()} ERROR [pine] uncaught exception: ${e.stack ?? e.message}`));
		const pine = await startPine({ config: cfg });
		const stop = (sig: string) => {
			console.error(`\n${sig} received, stopping`);
			void pine.stop().then(() => process.exit(0));
			setTimeout(() => process.exit(1), 10_000).unref();
		};
		process.on("SIGINT", () => stop("SIGINT"));
		process.on("SIGTERM", () => stop("SIGTERM"));
		return;
	}

	const api = client(cfg);
	const qs = (o: Record<string, unknown>) => {
		const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== true && v !== false);
		return p.length ? `?${p.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")}` : "";
	};
	switch (cmd) {
		case "status":
			return out(await api.get("/status"));
		case "agents":
			return out(await api.get("/agents"));
		case "send": {
			const agent = rest.shift();
			if (!agent || !rest.length) throw new Error("usage: pine send <agent> <text...>");
			const r = await api.post(`/agents/${agent}/prompt`, { prompt: rest.join(" "), session: flags.session, wait: flags.wait !== false });
			if (flags.wait === false) return out(`task #${r.task} queued`);
			if (r.status !== "done") throw new Error(`task #${r.id} ${r.status}: ${r.error ?? ""}`);
			return out(r.text);
		}
		case "emit": {
			if (!rest[0]) throw new Error("usage: pine emit <topic> [json]");
			const r = await api.post("/events", { topic: rest[0], payload: rest[1] !== undefined ? JSON.parse(rest[1]) : null });
			return out(`event #${r.id}`);
		}
		case "events": {
			const events: any[] = await api.get(`/events${qs({ topic: flags.topic, limit: flags.limit ?? 30 })}`);
			for (const e of events) out(line(e));
			if (!flags.follow) return;
			const res = await fetch(`${api.base}/events/stream${qs({ topic: flags.topic })}`, { headers: { authorization: `Bearer ${api.token}` } });
			let buf = "";
			for await (const chunk of res.body as any) {
				buf += Buffer.from(chunk).toString("utf8");
				for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
					const block = buf.slice(0, i);
					buf = buf.slice(i + 2);
					if (block.startsWith("data: ")) out(line(JSON.parse(block.slice(6))));
				}
			}
			return;
		}
		case "tasks": {
			const tasks: any[] = await api.get(`/tasks${qs({ agent: flags.agent, status: flags.status, limit: flags.limit ?? 20 })}`);
			for (const t of tasks.reverse()) out(`#${String(t.id).padEnd(5)} ${when(t.created)}  ${t.status.padEnd(9)} ${`${t.agent}/${t.session}`.padEnd(26)} ${t.kind.padEnd(9)} ${String(t.meta?.label ?? t.prompt).replace(/\s+/g, " ").slice(0, 90)}`);
			return;
		}
		case "task":
			return out(await api.get(`/tasks/${rest[0]}`));
		case "cancel":
			return out(await api.post(`/tasks/${rest[0]}/cancel`));
		case "state":
			for (const s of (await api.get(`/state${qs({ key: rest[0] })}`)) as any[]) out(`${s.key} = ${JSON.stringify(s.value)}   (${when(s.ts)}, ${s.source})`);
			return;
		case "sources": {
			const list: any[] = await api.get("/sources");
			if (!list.length) return out(`no event sources configured (add "sources" to pine.json or an agent.json; see docs/references/sources.md)`);
			for (const s of list) {
				out(`${s.name}${s.scope === "global" ? "" : ` (of ${s.scope})`}  ${s.type}  ${s.error ? `not running: ${s.error}` : s.running ? "running" : "idle, nobody is subscribed"}${s.trust === "owner" ? "  [yours]" : ""}`);
				if (s.description) out(`    ${s.description}`);
				if (s.status) out(`    ${s.status}`);
				out(`    subscribers: ${s.subscribers.join(", ") || "none"} · ${s.last ? `last event ${when(s.last.ts)} (${s.last.topic}), ${s.events} since start` : "no events since start"}`);
			}
			return;
		}
		case "subscribe":
		case "unsubscribe": {
			const details = { note: flags.note, throttle: flags.throttle, separate: flags.separate === true, when: typeof flags.when === "string" ? JSON.parse(flags.when) : undefined };
			if (flags.global === true) {
				if (!rest[0]) throw new Error(`usage: pine ${cmd} --global <source>`);
				if (cmd === "unsubscribe") return out(((await api.post("/unsubscribe", { source: rest[0] })) as any).unsubscribed ? `all agents: no longer subscribed to ${rest[0]}` : `there was no subscription of all agents to ${rest[0]}`);
				const all: any = await api.post("/subscribe", { source: rest[0], ...details });
				return out(`all agents are subscribed to ${rest[0]} (${all.running ? "running" : "not running"}); it wakes ${all.agents.join(", ") || "nobody yet"}, each in its main conversation`);
			}
			if (!rest[0] || !rest[1]) throw new Error(`usage: pine ${cmd} <agent> <source>${cmd === "subscribe" ? " [--session name] [--note text] [--throttle 5m] [--when json]" : " [--session name]"}\n       pine ${cmd} --global <source>`);
			if (cmd === "unsubscribe") {
				const r: any = await api.post(`/agents/${rest[0]}/unsubscribe`, { source: rest[1], session: typeof flags.session === "string" ? flags.session : undefined });
				return out(r.unsubscribed ? `${rest[0]} is no longer subscribed to ${rest[1]}${r.sessions.some((x: string) => x !== "main") ? ` (conversations: ${r.sessions.join(", ")})` : ""}` : `${rest[0]} was not subscribed to ${rest[1]}`);
			}
			const info: any = await api.post(`/agents/${rest[0]}/subscribe`, { source: rest[1], session: flags.session, ...details });
			return out(`${rest[0]} is subscribed to ${rest[1]} (${info.running ? "running" : "not running"}); each event wakes it in its conversation "${info.session}"`);
		}
		case "approvals": {
			const list: any[] = await api.get("/approvals");
			if (!list.length) return out("nothing waits for approval");
			for (const a of list) out(`${a.id}  ${a.agent} (task #${a.task}) wants ${a.summary.split("\n")[0]}\n      why: ${a.why}\n      expires ${when(a.expires)}`);
			return;
		}
		case "approve":
		case "deny":
			return out(await api.post(`/approvals/${rest[0]}`, { allow: cmd === "approve", always: flags.always === true }));
		case "mode": {
			if (!rest[0]) throw new Error("usage: pine mode <agent> [manual|auto|bypass]");
			if (rest[1]) return out(await api.post(`/agents/${rest[0]}/mode`, { mode: rest[1] }));
			const agent = ((await api.get("/agents")) as any[]).find((a) => a.id === rest[0]);
			if (!agent) throw new Error(`unknown agent "${rest[0]}"`);
			return out(agent.mode);
		}
		case "reset":
			if (!rest[0]) throw new Error("usage: pine reset <agent> [session]");
			return out(await api.post(`/agents/${rest[0]}/reset`, { session: rest[1] }));
		default:
			throw new Error(`unknown command "${cmd}". Run "pine help".`);
	}
}

main().catch((e) => {
	console.error(e instanceof ConfigError ? e.message : `pine: ${e instanceof Error ? e.message : e}`);
	process.exit(1);
});
