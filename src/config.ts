import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { ReplyTarget } from "./types.ts";
import { expandHome, parseDuration, resolvePath, type LogLevel } from "./util.ts";

/** One MCP server, in the shape of an `mcpServers` entry of pi's mcp.json, plus `agents` for global servers. */
export interface McpServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	exposure?: "direct" | "codemode" | "deferred" | "hidden";
	toolExposure?: Record<string, string>;
	description?: string;
	enabled?: boolean;
	timeout?: number;
	/** Global servers only: which agents get it. Default ["*"]. */
	agents?: string[];
	/** Use a server that ships with pine ("web", "browser", "commands") instead of command/url. */
	pine?: string;
	options?: Record<string, unknown>;
	/** Its results are outside content: a session that calls it counts as tainted. */
	taints?: boolean;
	/** When calls need the owner's approval. Default "never" ("tainted" for servers flagged sensitive by the docs). */
	approve?: "never" | "tainted" | "always";
	/** An agent's own servers only: the one conversation that gets it. Written by add_mcp_server for a server added for a conversation; it is removed with that conversation. */
	session?: string;
	[key: string]: unknown;
}

/**
 * A source of outside events: a watched folder, an MQTT broker, a webhook, an FTP drop, a web
 * address, or your own module. Like an MCP server it only is there; nothing happens until an agent
 * subscribes to it. The remaining keys are the options of its type.
 */
export interface SourceConfig {
	/** A built-in type (see SOURCE_TYPES) ... */
	type?: string;
	/** ... or the path of a module whose default export is `(source) => void`. */
	use?: string;
	/** Where relative paths in the entry are resolved from. */
	base: string;
	/** One line for agents and people: what this source reports. */
	description?: string;
	/** Global sources only: the agents that may subscribe. Default: all. */
	agents?: string[];
	/** An agent's own sources only: the one conversation it was set up for. Other conversations do not see it, and it is removed with that conversation. */
	session?: string;
	/** Who its events speak for. "untrusted" (default): outside content, the subscriber wakes with its reduced tool set. "owner": your own device or schedule. */
	trust: "owner" | "untrusted";
	/** "subscribed" (default): runs only while an agent is subscribed. "always": runs from start, for routes that use its events. */
	start: "subscribed" | "always";
	enabled: boolean;
	options: Record<string, any>;
}

export const SOURCE_TYPES = ["folder", "mqtt", "webhook", "ftp", "telegram", "http", "command"];

/**
 * A subscription: one conversation of an agent listens to one source, and each event of the source
 * arrives there as a message and wakes the agent into a turn. Several conversations of the same
 * agent can listen to the same source, each with its own note.
 */
export interface SubscriptionConfig {
	source: string;
	/** What the agent wants to do when it is woken, in its own or your words. Given to it with every event. */
	note?: string;
	/** Only events that match (same filter as routes; keys such as "event" and "payload.x"). */
	when?: Record<string, unknown>;
	/** Wait for quiet, then handle only the last event. */
	debounceMs?: number;
	/** Handle one event, then ignore the source for this long. Default 10 s, so a chatty device cannot keep a model busy. */
	throttleMs: number;
	/** Whether that is the default, as opposed to something the subscription said. A source somebody writes through is not held back by the default: every message counts. */
	throttleDefault?: boolean;
	/** The conversation that listens: the one the agent subscribed in. "main" unless said otherwise ("on-<source>" with `separate`). */
	session: string;
	/**
	 * true: wake it in a conversation of its own ("on-<source>", or `session`) instead, and for a
	 * source that is not yours with the reduced tool set. For sources that carry strangers' text.
	 */
	separate: boolean;
	/** Replaces the standard text the agent is woken with. Templates as in routes. */
	prompt?: string;
}

export interface RouteConfig {
	name: string;
	on: string[];
	when?: Record<string, unknown>;
	/** Wait for this long without a new matching event, then handle only the last one. */
	debounceMs?: number;
	/** Handle the first event, then ignore matching events for this long. */
	throttleMs?: number;
	/** Template for the debounce/throttle bucket. Default: the event topic. */
	key?: string;
	/** Write world state: key template -> value template. */
	set?: Record<string, unknown>;
	/** Publish another event. With `call`, `{{result}}` holds the model's answer. */
	publish?: { topic: string; payload?: unknown };
	/** One model call without tools or history. */
	call?: { model?: string; system?: string; prompt: string };
	/** Full agent turn. */
	agent?: string;
	prompt?: string;
	session?: string;
	whenBusy?: "queue" | "steer";
	priority?: number;
	/** Where the agent's final answer goes. Default: the event's own reply target. false: nowhere. */
	reply?: ReplyTarget | false;
	/** Override the event's trust. "owner" gives events on this route the agent's full tool set. */
	trust?: "owner" | "untrusted";
	/** Text put in front of the event for the agent, outside the "this is data" frame. Set by subscriptions, not in pine.json. */
	preface?: string;
	/**
	 * Set by subscriptions: the event is delivered into the subscriber's own conversation, with its
	 * usual tools, as outside content. The conversation is marked with this reason, as it would be
	 * after reading a web page.
	 */
	taint?: string;
	/** Short line for listings and the UI. Template. */
	label?: string;
}

/**
 * Something that happens at a time: every so often, at set times, or once. With a `task` it wakes
 * an agent to do that task; without one it only publishes an event for a route to pick up.
 *
 * Like sources, servers and skills, a schedule is for all agents (pine.json), for one agent
 * (agent.json) or for one conversation of an agent (agent.json, with `session`).
 */
export interface ScheduleConfig {
	name: string;
	/** Five-field cron expression in local time. */
	cron?: string;
	/** Fixed interval such as "15m", in milliseconds. */
	every?: number;
	/** Once, at this moment (milliseconds since 1970). The schedule is removed when it has fired. */
	at?: number;
	/** What the agent is to do when it fires, written to the agent. */
	task?: string;
	/** The conversation that is woken. Leaving it out is the agent as such: its main conversation. */
	session?: string;
	topic: string;
	payload?: unknown;
	/** Fire once at startup when a cron time passed while the daemon was down. */
	catchUp: boolean;
}

export interface HookConfig {
	topic: string;
	/** Shared secret: accepted as `Authorization: Bearer <secret>` or as an HMAC-SHA256 of the body in `X-Hub-Signature-256` / `X-Signature`. */
	secret?: string;
}

/**
 * How much an agent may do without asking.
 * manual: every action that changes or sends something waits for approval.
 * auto:   works freely inside its sandbox; asks for what the rules single out, and for access beyond it.
 * bypass: never asks, and its shell and file tools reach the whole user account (pine's own home and code stay closed).
 */
export type Mode = "manual" | "auto" | "bypass";
export const MODES: Mode[] = ["manual", "auto", "bypass"];

export interface SandboxConfig {
	enabled: boolean;
	/** Shell commands may open network connections. */
	network: boolean;
	/** Extra paths the agent may read / write, besides its workspace. */
	read: string[];
	write: string[];
	/** Allow the shared temp directories (/tmp and the user's temp dir). */
	sharedTmp: boolean;
	env: Record<string, string>;
}

/** What a run triggered by an untrusted event may use. */
export interface UntrustedProfile {
	tools: string[];
	mcp: string[];
	delegates: string[];
	publish: string[];
	stateWrite: boolean;
	subagents: boolean;
}

export interface AgentConfig {
	id: string;
	/** pi agent dir of this agent: AGENTS.md, skills/, extensions/, settings.json, sessions/. */
	dir: string;
	description: string;
	workspace: string;
	model?: string;
	thinking: string;
	/** Allowlist of pi built-in tools. Undefined keeps pi's default set. */
	tools?: string[];
	mcp: Record<string, McpServerConfig>;
	/** Which global MCP servers this agent gets: all that list it (true), none (false), or these names. */
	globalMcp: boolean | string[];
	/** Event sources only this agent can subscribe to. */
	sources: Record<string, SourceConfig>;
	/** What this agent's conversations are subscribed to: its own sources or global ones. */
	subscribe: SubscriptionConfig[];
	/** What this agent does at set times: for the agent as such, or (with `session`) for one conversation. */
	schedules: ScheduleConfig[];
	extensions: string[];
	skills: string[];
	/** Extra instruction files loaded into the system prompt, besides AGENTS.md in the agent dir and the workspace. */
	context: string[];
	/** Agents this one may hand tasks to. "*" means every other agent. */
	delegates: string[];
	subagents: { enabled: boolean; maxParallel: number; tools?: string[]; mcp: boolean };
	/** Topics the publish_event tool may publish to. */
	publish: string[];
	state: { read: string[]; write: string[]; inject: string[] };
	trustWorkspace: boolean;
	mode: Mode;
	sandbox: SandboxConfig;
	/** Tool calls that always need the owner's approval: "tool" or "tool:argument-glob". */
	approve: string[];
	/** Tool calls that need approval once the session has seen outside content. */
	approveWhenTainted: string[];
	/** Profile for runs triggered by untrusted events; false refuses such runs. */
	untrusted: UntrustedProfile | false;
	bashTimeoutSec: number;
	bashDeny: string[];
	taskTimeoutSec: number;
	idleMs: number;
	settings: Record<string, unknown>;
}

export interface PineConfig {
	home: string;
	dataDir: string;
	logLevel: LogLevel;
	main?: string;
	defaults: { model?: string; thinking: string; mode: Mode; bashTimeoutSec: number; taskTimeoutSec: number; idleMs: number; settings: Record<string, unknown> };
	limits: {
		maxConcurrentRuns: number;
		maxDelegationDepth: number;
		/** Largest file the download tool fetches. */
		maxDownloadMb: number;
		maxEventHops: number;
		modelHeadersTimeoutMs: number;
		modelStreamIdleMs: number;
		eventRetentionDays: number;
		/** A conversation that is not pinned, not open in a tab and not subscribed to anything is removed after this many days without a message. 0: never. */
		conversationDays: number;
		maxQueuedPerAgent: number;
		maxEventChars: number;
	};
	security: {
		approvalTimeoutMs: number;
		/** How long a session stays tainted after it saw outside content. */
		taint: "session" | "run" | "off";
		/** Tool name globs whose results are outside content, besides MCP servers marked `taints`. */
		taintTools: string[];
		/** Keep bypass mode in force after a session has seen outside content. Off: such a session asks again. */
		bypassWhenTainted: boolean;
	};
	/** Values that must never leave the daemon in events or messages. */
	secrets: string[];
	mcp: Record<string, McpServerConfig>;
	/** Event sources every agent can subscribe to (or the agents an entry lists). */
	sources: Record<string, SourceConfig>;
	/** Source types of your own, besides the built-in ones: type name -> the module that implements it. */
	sourceTypes: Record<string, string>;
	/** Subscriptions for everyone: each agent that can use the source is woken in its main conversation. */
	subscribe: SubscriptionConfig[];
	extensions: string[];
	skills: string[];
	routes: RouteConfig[];
	schedules: ScheduleConfig[];
	http?: { host: string; port: number; token?: string; hooks: Record<string, HookConfig> };
	agents: Record<string, AgentConfig>;
}

export class ConfigError extends Error {
	problems: string[];
	constructor(problems: string[]) {
		super(`Invalid pine configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
		this.problems = problems;
	}
}

/** The pine checkout: bundled MCP servers and source types live here. */
export const PINE_ROOT = path.resolve(import.meta.dirname, "..");
/**
 * How pine's own module files end: ".ts" in a checkout, where Node runs the sources as they are,
 * ".js" in the published package, which holds them compiled (Node does not run TypeScript from
 * inside node_modules). Used wherever pine names one of its own files at run time.
 */
export const EXT = import.meta.filename.endsWith(".ts") ? ".ts" : ".js";

export const defaultHome = () => path.resolve(expandHome(process.env.PINE_HOME ?? "~/.pine"));

const readJson = (file: string, problems: string[]): any => {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		problems.push(`${file}: ${(e as Error).message}`);
		return {};
	}
};

/** Replace ${VAR} and ${VAR:-fallback} in every string of a JSON value. */
function interpolate(value: any, where: string, problems: string[], env: Record<string, string | undefined>): any {
	if (typeof value === "string") {
		return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, fallback) => {
			const v = env[name] ?? fallback;
			if (v === undefined) problems.push(`${where}: environment variable ${name} is not set`);
			return v ?? "";
		});
	}
	if (Array.isArray(value)) return value.map((v, i) => interpolate(v, `${where}[${i}]`, problems, env));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, `${where}.${k}`, problems, env)]));
	return value;
}

/**
 * pine had plugins once: modules listed under "plugins". What they did is done by event sources
 * now, which agents set up themselves. An empty list in an older file is ignored; one that still
 * names something is a problem to fix, with a pointer to what took its place.
 */
const noPlugins = (list: unknown, where: string, problems: string[]): void => {
	if (Array.isArray(list) && list.length) problems.push(`${where}: plugins are gone. Telegram, MQTT and watched folders are event sources now, which an agent sets up when you ask it to ("watch telegram", "watch ~/Scans"); see docs/references/sources.md. Take the "plugins" entry out`);
};

const strings = (v: unknown, fallback: string[]): string[] => (Array.isArray(v) ? v.map(String) : fallback);
const paths = (v: unknown, base: string): string[] => strings(v, []).map((p) => resolvePath(p, base));

function loadAgent(id: string, dir: string, raw: any, cfg: PineConfig, problems: string[]): AgentConfig {
	const where = `agents/${id}/agent.json`;
	noPlugins(raw.plugins, `${where}: plugins`, problems);
	const workspace = raw.workspace ? resolvePath(raw.workspace, dir) : path.join(dir, "workspace");
	if (!raw.workspace) fs.mkdirSync(workspace, { recursive: true });
	else if (!fs.existsSync(workspace)) problems.push(`${where}: workspace ${workspace} does not exist`);
	const sub = raw.subagents === false ? { enabled: false } : raw.subagents === true || raw.subagents === undefined ? {} : raw.subagents;
	const state = raw.state ?? {};
	return {
		id,
		dir,
		description: raw.description ?? "",
		workspace,
		model: raw.model,
		thinking: raw.thinking ?? cfg.defaults.thinking,
		tools: Array.isArray(raw.tools) ? raw.tools.map(String) : undefined,
		mcp: raw.mcp ?? {},
		globalMcp: raw.globalMcp ?? true,
		sources: loadSources(raw.sources, dir, `${where}: sources`, problems, Object.keys(cfg.sourceTypes)),
		subscribe: loadSubscriptions(raw.subscribe, `${where}: subscribe`, problems),
		schedules: loadSchedules(raw.schedules, problems, where, id),
		extensions: paths(raw.extensions, dir),
		skills: paths(raw.skills, dir),
		context: paths(raw.context, dir),
		delegates: strings(raw.delegates, id === cfg.main ? ["*"] : []),
		subagents: { enabled: sub.enabled ?? true, maxParallel: sub.maxParallel ?? 4, tools: sub.tools, mcp: sub.mcp ?? true },
		publish: strings(raw.publish, []),
		state: { read: strings(state.read, ["#"]), write: strings(state.write, [`agent/${id}/#`]), inject: strings(state.inject, []) },
		trustWorkspace: raw.trustWorkspace === true,
		mode: raw.mode ?? cfg.defaults.mode,
		sandbox: {
			enabled: raw.sandbox !== false && raw.sandbox?.enabled !== false,
			network: raw.sandbox?.network === true,
			read: paths(raw.sandbox?.read, dir),
			write: paths(raw.sandbox?.write, dir),
			sharedTmp: raw.sandbox?.sharedTmp !== false,
			env: raw.sandbox?.env ?? {},
		},
		approve: strings(raw.approve, []),
		approveWhenTainted: strings(raw.approveWhenTainted, ["publish_event", "send"]),
		untrusted:
			raw.untrusted === false
				? false
				: {
						tools: strings(raw.untrusted?.tools, ["read", "grep", "find", "ls"]),
						mcp: strings(raw.untrusted?.mcp, []),
						delegates: strings(raw.untrusted?.delegates, []),
						publish: strings(raw.untrusted?.publish, []),
						stateWrite: raw.untrusted?.stateWrite === true,
						subagents: raw.untrusted?.subagents === true,
					},
		bashTimeoutSec: raw.bashTimeoutSec ?? cfg.defaults.bashTimeoutSec,
		bashDeny: strings(raw.bashDeny, []),
		taskTimeoutSec: raw.taskTimeoutSec ?? cfg.defaults.taskTimeoutSec,
		idleMs: raw.idleMs !== undefined ? parseDuration(raw.idleMs) : cfg.defaults.idleMs,
		settings: { ...cfg.defaults.settings, ...(raw.settings ?? {}) },
	};
}

function loadRoutes(raw: unknown, problems: string[]): RouteConfig[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		problems.push("pine.json: routes must be an array");
		return [];
	}
	return raw.flatMap((r, i) => {
		const where = `pine.json: routes[${i}]`;
		if (!r || (typeof r.on !== "string" && !Array.isArray(r.on))) {
			problems.push(`${where}: needs "on" (topic pattern)`);
			return [];
		}
		if (!r.agent && !r.call && !r.publish && !r.set) problems.push(`${where}: needs one of agent, call, publish, set`);
		if (r.agent && r.call) problems.push(`${where}: use either agent or call, not both`);
		if (r.call && typeof r.call.prompt !== "string") problems.push(`${where}: call needs "prompt"`);
		if (r.publish && typeof r.publish.topic !== "string") problems.push(`${where}: publish needs "topic"`);
		return [
			{
				...r,
				name: r.name ?? `route${i}`,
				on: Array.isArray(r.on) ? r.on : [r.on],
				debounceMs: r.debounceMs !== undefined ? parseDuration(r.debounceMs) : undefined,
				throttleMs: r.throttleMs !== undefined ? parseDuration(r.throttleMs) : undefined,
			},
		];
	});
}

/** `file`: where the list stands. `agent`: the agent it belongs to, whose schedules need a task and are published under its name. */
function loadSchedules(raw: unknown, problems: string[], file = "pine.json", agent?: string): ScheduleConfig[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		problems.push(`${file}: schedules must be an array`);
		return [];
	}
	return raw.flatMap((s, i) => {
		const where = `${file}: schedules[${i}]`;
		if (!s?.name) {
			problems.push(`${where}: needs "name"`);
			return [];
		}
		if (!/^[a-z][a-z0-9_-]{0,39}$/.test(s.name)) problems.push(`${where}: a schedule's name is lowercase letters, digits, - and _`);
		if ([s.cron, s.every, s.at].filter((x) => x !== undefined).length !== 1) problems.push(`${where}: needs exactly one of cron, every, at`);
		const task = typeof s.task === "string" && s.task.trim() ? s.task.trim() : undefined;
		if (agent && !task) problems.push(`${where}: needs "task": what the agent is to do when it fires`);
		let every: number | undefined;
		let at: number | undefined;
		try {
			every = s.every !== undefined ? parseDuration(s.every) : undefined;
			if (s.at !== undefined) {
				at = typeof s.at === "number" ? s.at : Date.parse(String(s.at));
				if (!Number.isFinite(at)) throw new Error(`"${s.at}" is not a time. Write it as 2026-12-24T17:00`);
			}
		} catch (e) {
			problems.push(`${where}: ${(e as Error).message}`);
		}
		const key = agent ? `${s.name}@${agent}` : s.name;
		// A task that was due while pine was not running is still worth doing; an event for a route is not repeated unless asked.
		return [{ name: s.name, cron: s.cron, every, at, task, session: typeof s.session === "string" && s.session ? s.session : undefined, topic: s.topic ?? `timer/${key}`, payload: s.payload, catchUp: s.catchUp === undefined ? Boolean(task) : s.catchUp === true }];
	});
}

/** Read `<home>/pine.json`, `<home>/.env` and every `<home>/agents/<id>/agent.json`. Throws ConfigError. */
export function loadConfig(home = defaultHome()): PineConfig {
	const problems: string[] = [];
	home = path.resolve(expandHome(home));
	const file = path.join(home, "pine.json");
	if (!fs.existsSync(file)) throw new ConfigError([`${file} not found. Run "pine init ${home}" to create a home directory.`]);

	// Secrets from .env are used to fill in the configuration only. They are not exported to the
	// process environment, so agent shells and MCP servers do not inherit them.
	const envFile = path.join(home, ".env");
	const fileEnv = fs.existsSync(envFile) ? (parseEnv(fs.readFileSync(envFile, "utf8")) as Record<string, string>) : {};
	const env = { ...process.env, PINE_HOME: home, PINE_ROOT, ...fileEnv };

	const raw = interpolate(readJson(file, problems), "pine.json", problems, env);
	noPlugins(raw?.plugins, "pine.json: plugins", problems);
	const d = raw.defaults ?? {};
	// Source types of the owner's own: a name and the module behind it.
	const sourceTypes: Record<string, string> = {};
	for (const [name, file] of Object.entries(raw.sourceTypes && typeof raw.sourceTypes === "object" ? raw.sourceTypes : {})) {
		if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name) || SOURCE_TYPES.includes(name)) problems.push(`pine.json: sourceTypes.${name}: a type name is lowercase letters, digits, - and _, and not one of the built-in types`);
		else if (typeof file !== "string" || !file) problems.push(`pine.json: sourceTypes.${name} must be the path of a module`);
		else sourceTypes[name] = resolvePath(file, home);
	}
	const l = raw.limits ?? {};
	const cfg: PineConfig = {
		home,
		dataDir: resolvePath(raw.dataDir ?? "data", home),
		logLevel: raw.logLevel ?? "info",
		main: raw.main,
		defaults: {
			model: d.model,
			thinking: d.thinking ?? "off",
			mode: d.mode ?? "auto",
			bashTimeoutSec: d.bashTimeoutSec ?? 300,
			taskTimeoutSec: d.taskTimeoutSec ?? 1800,
			idleMs: parseDuration(d.idleMs ?? "15m"),
			settings: d.settings ?? {},
		},
		limits: {
			maxConcurrentRuns: l.maxConcurrentRuns ?? 2,
			maxDelegationDepth: l.maxDelegationDepth ?? 3,
			maxDownloadMb: l.maxDownloadMb ?? 200,
			maxEventHops: l.maxEventHops ?? 8,
			modelHeadersTimeoutMs: parseDuration(l.modelHeadersTimeoutMs ?? "10m"),
			modelStreamIdleMs: parseDuration(l.modelStreamIdleMs ?? "5m"),
			eventRetentionDays: l.eventRetentionDays ?? 30,
			conversationDays: l.conversationDays ?? 7,
			maxQueuedPerAgent: l.maxQueuedPerAgent ?? 50,
			maxEventChars: l.maxEventChars ?? 20_000,
		},
		security: {
			approvalTimeoutMs: parseDuration(raw.security?.approvalTimeout ?? "5m"),
			taint: raw.security?.taint ?? "session",
			taintTools: strings(raw.security?.taintTools, []),
			bypassWhenTainted: raw.security?.bypassWhenTainted === true,
		},
		secrets: Object.values(fileEnv).filter((v) => v.length >= 8),
		mcp: raw.mcp ?? {},
		sources: loadSources(raw.sources, home, "pine.json: sources", problems, Object.keys(sourceTypes)),
		sourceTypes,
		subscribe: loadSubscriptions(raw.subscribe, "pine.json: subscribe", problems),
		extensions: paths(raw.extensions, home),
		skills: paths(raw.skills, home),
		routes: loadRoutes(raw.routes, problems),
		schedules: loadSchedules(raw.schedules, problems),
		http: raw.http === false ? undefined : { host: raw.http?.host ?? "127.0.0.1", port: raw.http?.port ?? 7463, token: raw.http?.token, hooks: {} },
		agents: {},
	};
	if (cfg.http) {
		for (const [name, h] of Object.entries<any>(raw.http?.hooks ?? {})) {
			if (!/^[A-Za-z0-9_-]+$/.test(name)) problems.push(`pine.json: invalid hook name "${name}"`);
			if (!h?.secret && h?.open !== true) problems.push(`pine.json: http.hooks.${name} needs a "secret" (or "open": true to accept anyone who can reach the port)`);
			cfg.http.hooks[name] = { topic: h?.topic ?? `hook/${name}`, secret: h?.secret || undefined };
		}
		if (cfg.http.token) cfg.secrets.push(cfg.http.token);
	}

	const agentsDir = path.join(home, "agents");
	for (const entry of fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir, { withFileTypes: true }) : []) {
		const dir = path.join(agentsDir, entry.name);
		const agentFile = path.join(dir, "agent.json");
		if (!entry.isDirectory() || !fs.existsSync(agentFile)) continue;
		if (!/^[a-z0-9][a-z0-9_-]*$/.test(entry.name)) {
			problems.push(`agents/${entry.name}: agent ids are lowercase letters, digits, "-" and "_"`);
			continue;
		}
		const rawAgent = interpolate(readJson(agentFile, problems), `agents/${entry.name}/agent.json`, problems, env);
		cfg.agents[entry.name] = loadAgent(entry.name, dir, rawAgent, cfg, problems);
	}

	const ids = Object.keys(cfg.agents);
	if (ids.length === 0) problems.push(`no agents found in ${agentsDir} (each agent is a folder with an agent.json)`);
	if (cfg.main && !cfg.agents[cfg.main]) problems.push(`pine.json: main agent "${cfg.main}" does not exist`);
	for (const a of Object.values(cfg.agents)) {
		if (!MODES.includes(a.mode)) problems.push(`agents/${a.id}/agent.json: mode must be one of ${MODES.join(", ")} (got "${a.mode}")`);
		if (!(a.model ?? cfg.defaults.model)) problems.push(`agents/${a.id}/agent.json: no model (set "model" or defaults.model in pine.json)`);
		for (const t of a.delegates) if (t !== "*" && !cfg.agents[t]) problems.push(`agents/${a.id}/agent.json: delegates names unknown agent "${t}"`);
		if (Array.isArray(a.globalMcp)) for (const n of a.globalMcp) if (!cfg.mcp[n]) problems.push(`agents/${a.id}/agent.json: globalMcp names unknown server "${n}"`);
		for (const n of Object.keys(a.mcp)) if (!/^[A-Za-z0-9_-]+$/.test(n)) problems.push(`agents/${a.id}/agent.json: invalid MCP server name "${n}"`);
		for (const p of [...a.extensions, ...a.skills, ...a.context]) if (!fs.existsSync(p)) problems.push(`agents/${a.id}/agent.json: ${p} does not exist`);
		for (const sub of a.subscribe) if (!sourceFor(cfg, a.id, sub.source)) problems.push(`agents/${a.id}/agent.json: subscribe names "${sub.source}", which is not a source this agent can use`);
	}
	for (const sub of cfg.subscribe) if (!cfg.sources[sub.source]) problems.push(`pine.json: subscribe names "${sub.source}", which is not a source in pine.json (a subscription for all agents needs a source all agents can use)`);
	for (const [name, src] of Object.entries(cfg.sources)) for (const a of src.agents ?? []) if (a !== "*" && !cfg.agents[a]) problems.push(`pine.json: sources.${name}.agents names unknown agent "${a}"`);
	for (const [name, s] of Object.entries(cfg.mcp)) {
		if (!/^[A-Za-z0-9_-]+$/.test(name)) problems.push(`pine.json: invalid MCP server name "${name}"`);
		for (const a of s.agents ?? []) if (a !== "*" && !cfg.agents[a]) problems.push(`pine.json: mcp.${name}.agents names unknown agent "${a}"`);
	}
	for (const p of [...cfg.extensions, ...cfg.skills]) if (!fs.existsSync(p)) problems.push(`pine.json: ${p} does not exist`);
	for (const r of cfg.routes) if (r.agent && !cfg.agents[r.agent]) problems.push(`pine.json: route "${r.name}" names unknown agent "${r.agent}"`);
	for (const [where, servers] of [["pine.json", cfg.mcp] as const, ...Object.values(cfg.agents).map((a) => [`agents/${a.id}/agent.json`, a.mcp] as const)]) {
		for (const [name, s] of Object.entries(servers)) {
			if (s.pine && !BUNDLED[s.pine]) problems.push(`${where}: mcp.${name}.pine "${s.pine}" is not a bundled server (have: ${Object.keys(BUNDLED).join(", ")})`);
			if (!s.pine && !s.command && !s.url) problems.push(`${where}: mcp.${name} needs "command", "url" or "pine"`);
		}
	}

	if (problems.length) throw new ConfigError(problems);
	return cfg;
}

/** MCP servers an agent ends up with: its own, plus the global ones that include it. Own entries win. */
/** The main agent: the one pine.json names; without that entry the one called "main", else the first one. */
/**
 * The files in an agent's workspace that are part of its prompt, in the order they enter it. They
 * are the agent's own: it reads them as its instructions and keeps them up to date itself.
 * AGENTS.md is how it works, SOUL.md who it is, MEMORY.md what should outlive a conversation.
 */
export const WORKSPACE_FILES = ["AGENTS.md", "SOUL.md", "MEMORY.md"];

/** What all agents know about the owner: one file in pine's home, in every agent's prompt, kept by the main agent. */
export const userFile = (cfg: PineConfig): string => path.join(cfg.home, "USER.md");

/**
 * Where skills lie that were set up by tool call. The place says whom a skill is for: all agents,
 * one agent, or one conversation of an agent. All of it is inside pine's home, which agents read
 * but do not write.
 */
export const globalSkillsDir = (cfg: Pick<PineConfig, "home">) => path.join(cfg.home, "skills");
export const agentSkillsDir = (agent: Pick<AgentConfig, "dir">) => path.join(agent.dir, "skills");
export const conversationsDir = (agent: Pick<AgentConfig, "dir">) => path.join(agent.dir, "conversations");

export function mainAgentId(cfg: PineConfig): string {
	return cfg.main ?? (cfg.agents.main ? "main" : Object.keys(cfg.agents)[0]);
}

/**
 * The MCP servers an agent has. `session`: the conversation asked for, which also gets the servers
 * that were added for it alone; without it, every server the agent has in any conversation.
 */
export function effectiveMcp(cfg: PineConfig, agent: AgentConfig, session?: string): Record<string, McpServerConfig> {
	const out: Record<string, McpServerConfig> = {};
	for (const [name, server] of Object.entries(cfg.mcp)) {
		const scope = server.agents ?? ["*"];
		const listed = scope.includes("*") || scope.includes(agent.id);
		const wanted = agent.globalMcp === true ? listed : Array.isArray(agent.globalMcp) ? agent.globalMcp.includes(name) : false;
		if (wanted && server.enabled !== false) out[name] = server;
	}
	for (const [name, server] of Object.entries(agent.mcp)) if (server.enabled !== false && (!server.session || session === undefined || server.session === session)) out[name] = server;
	return out;
}

const BUNDLED: Record<string, { file: string; taints: boolean }> = {
	web: { file: `mcp/web${EXT}`, taints: true },
	browser: { file: `mcp/browser${EXT}`, taints: true },
	commands: { file: `mcp/commands${EXT}`, taints: false },
};

/** Turn a pine MCP entry into what pi's registerMcpServer() accepts. */
export function toPiMcp(name: string, server: McpServerConfig, extraOptions: Record<string, unknown> = {}): Record<string, unknown> {
	const { agents: _a, pine, options, taints: _t, approve: _ap, session: _s, ...rest } = server;
	if (!pine) return { exposure: "direct", ...rest };
	const bundled = BUNDLED[pine];
	if (!bundled) throw new Error(`mcp.${name}: unknown bundled server "${pine}" (have: ${Object.keys(BUNDLED).join(", ")})`);
	return {
		exposure: "direct",
		...rest,
		command: process.execPath,
		args: [path.join(PINE_ROOT, bundled.file)],
		env: { ...(rest.env ?? {}), PINE_MCP_OPTIONS: JSON.stringify({ ...(options ?? {}), ...extraOptions }) },
	};
}

const SOURCE_KEYS = ["type", "use", "description", "agents", "trust", "start", "enabled", "session"];

function loadSources(raw: unknown, base: string, where: string, problems: string[], own: string[] = []): Record<string, SourceConfig> {
	const types = [...SOURCE_TYPES, ...own];
	const out: Record<string, SourceConfig> = {};
	if (raw === undefined || raw === null) return out;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		problems.push(`${where} must be an object of named sources`);
		return out;
	}
	for (const [name, v] of Object.entries<any>(raw)) {
		if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name)) problems.push(`${where}.${name}: a source name is lowercase letters, digits, - and _`);
		if (!v || typeof v !== "object") {
			problems.push(`${where}.${name} must be an object`);
			continue;
		}
		if (!v.type === !v.use) problems.push(`${where}.${name} needs either "type" (${types.join(", ")}) or "use" (a module of your own)`);
		// Times are not a source any more: a schedule does what a timer source and a subscription did together.
		if (v.type === "timer") problems.push(`${where}.${name}: there is no "timer" source any more. Something that happens at a time is a schedule: ask the agent ("every morning at seven, ..."), or write { "name": "${name}", ${v.cron ? `"cron": "${v.cron}"` : `"every": "${v.every ?? "1h"}"`}, "task": "what to do" } under "schedules" and remove this source and its subscriptions`);
		else if (v.type && !types.includes(v.type)) problems.push(`${where}.${name}: unknown type "${v.type}" (have: ${types.join(", ")})`);
		if (v.trust !== undefined && v.trust !== "owner" && v.trust !== "untrusted") problems.push(`${where}.${name}: trust is "owner" or "untrusted"`);
		if (v.start !== undefined && v.start !== "subscribed" && v.start !== "always") problems.push(`${where}.${name}: start is "subscribed" or "always"`);
		out[name] = {
			type: v.type,
			use: v.use,
			base,
			description: typeof v.description === "string" ? v.description : undefined,
			agents: Array.isArray(v.agents) ? v.agents.map(String) : undefined,
			session: typeof v.session === "string" && v.session ? v.session : undefined,
			// What a source reports was produced by someone or something else, unless the owner says it is theirs.
			trust: v.trust ?? "untrusted",
			start: v.start ?? "subscribed",
			enabled: v.enabled !== false,
			options: Object.fromEntries(Object.entries(v).filter(([k]) => !SOURCE_KEYS.includes(k))),
		};
	}
	return out;
}

/**
 * The forms "subscribe" may have in a file, as a plain list of entries:
 * `["camera", "printer"]`, `{ "camera": { "note": ... } }`, or the form pine itself writes,
 * `[{ "source": "camera", "session": "main", "note": ... }]`, which is the only one that can
 * say that two conversations listen to the same source.
 */
export function rawSubscriptions(raw: unknown): Array<Record<string, any>> {
	if (Array.isArray(raw)) return raw.map((item) => (typeof item === "string" ? { source: item } : item && typeof item === "object" ? { ...item } : { source: String(item) }));
	if (raw && typeof raw === "object") return Object.entries<any>(raw as object).map(([name, v]) => ({ ...(v && typeof v === "object" ? v : {}), source: name }));
	return [];
}

function loadSubscriptions(raw: unknown, where: string, problems: string[]): SubscriptionConfig[] {
	const out: SubscriptionConfig[] = [];
	if (raw === undefined || raw === null) return out;
	if (typeof raw !== "object") {
		problems.push(`${where} must be a list of source names, a list of entries, or an object`);
		return out;
	}
	for (const entry of rawSubscriptions(raw)) {
		try {
			const sub = subscriptionFrom(entry);
			if (out.some((x) => x.source === sub.source && x.session === sub.session)) problems.push(`${where}: "${sub.source}" is listed twice for the conversation "${sub.session}"`);
			else out.push(sub);
		} catch (e) {
			problems.push(`${where}.${entry.source ?? "?"}: ${(e as Error).message}`);
		}
	}
	return out;
}

export function subscriptionFrom(v: Record<string, any>): SubscriptionConfig {
	if (typeof v.source !== "string" || !v.source) throw new Error(`an entry needs "source": the name of the source`);
	if (v.when !== undefined && (typeof v.when !== "object" || v.when === null || Array.isArray(v.when))) throw new Error(`"when" must be an object of conditions`);
	const separate = v.separate === true;
	return {
		source: v.source,
		session: typeof v.session === "string" && v.session ? v.session : separate ? `on-${v.source}` : "main",
		note: typeof v.note === "string" && v.note.trim() ? v.note.trim().slice(0, 2000) : undefined,
		when: v.when,
		debounceMs: v.debounce !== undefined ? parseDuration(v.debounce) : undefined,
		throttleMs: parseDuration(v.throttle ?? "10s"),
		throttleDefault: v.throttle === undefined ? true : undefined,
		separate,
		prompt: typeof v.prompt === "string" ? v.prompt : undefined,
	};
}

/** The source an agent means by a name: its own first, then a global one it is allowed to use. */
export function sourceFor(cfg: PineConfig, agentId: string, name: string): { source: SourceConfig; key: string; scope: string } | undefined {
	const agent = cfg.agents[agentId];
	if (agent?.sources[name]) return { source: agent.sources[name], key: `${name}@${agentId}`, scope: agentId };
	const global = cfg.sources[name];
	if (global && (!global.agents || global.agents.includes("*") || global.agents.includes(agentId))) return { source: global, key: name, scope: "global" };
	return undefined;
}

export const mcpTaints = (server: McpServerConfig) => server.taints ?? (server.pine ? (BUNDLED[server.pine]?.taints ?? false) : false);

/** Agents `from` may delegate to. */
export function delegateTargets(cfg: PineConfig, from: AgentConfig): AgentConfig[] {
	const all = from.delegates.includes("*");
	return Object.values(cfg.agents).filter((a) => a.id !== from.id && (all || from.delegates.includes(a.id)));
}
