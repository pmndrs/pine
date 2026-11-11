import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EXT, loadConfig, mainAgentId, type PineConfig, rawSubscriptions, type RouteConfig, type SourceConfig, sourceFor, SOURCE_TYPES, type SubscriptionConfig, subscriptionFrom } from "./config.ts";
import crypto from "node:crypto";
import os from "node:os";
import { Value } from "typebox/value";
import { parseEnv } from "node:util";
import { setEnv, unsetEnv } from "./env-file.ts";
import { editJson } from "./mcp-config.ts";
import type { SourcePlan, SourceType } from "./source-types.ts";
import type { Router } from "./router.ts";
import { type Approvals, realish, type Redactor, bin, rootsFor, sandboxArgv, sandboxAvailable, sandboxGuard, shellEnv } from "./security.ts";
import type { Bus, Kv } from "./store.ts";
import type { PineEvent } from "./types.ts";
import { errText, type Logger, parseDuration, resolvePath } from "./util.ts";

/**
 * Event sources and the subscriptions to them.
 *
 * A source is to events what an MCP server is to tools: a named thing in the configuration, global
 * (pine.json) or one agent's own (agent.json), that can report what happens somewhere else: a file
 * arrives, a device says something, a web service calls, a clock strikes. Being configured does
 * nothing. A source starts when the first conversation subscribes to it. A subscription belongs to
 * one conversation of one agent: each event arrives there as a message and wakes the agent into a
 * turn, and what it does with it is in its instructions and in the note it left when it subscribed.
 * Another conversation of the same agent is not subscribed until it subscribes itself. When the
 * last subscriber leaves, the source stops.
 *
 * Events are published as source/<name>/<event> (source/<name>@<agent>/<event> for an agent's own
 * source), so the event log, routes and the UI see them like any other event.
 */

/** What a source module gets. A source is a module whose default export is `(source) => void | Promise<void>`. */
export interface SourceApi {
	/** The name it has in the configuration. */
	name: string;
	/** What it is called in events and addresses: its name, or name@agent for an agent's own source. */
	key: string;
	options: Record<string, any>;
	/** Folder that relative paths in the options are meant from. */
	base: string;
	/** A folder of its own for whatever it has to keep (received files, for example). */
	dataDir: string;
	log: Logger;
	/**
	 * Report that something happened. `event` is a short word such as "added" or "message".
	 * With `reply`, the answer of an agent that is woken by this event comes back to `onSend`, with
	 * the fields given here (a chat to answer in, for example) next to its `text`.
	 */
	emit(event: string, payload?: Record<string, unknown>, opts?: { persist?: boolean; reply?: Record<string, unknown> }): PineEvent;
	/**
	 * For a source that can also send: called with an agent's answer to one of its events, and with
	 * what an agent sends through it on its own. Return a short line on what was done; throw to
	 * refuse. The source decides where things may go: it never sends anywhere it was not set up for.
	 */
	onSend(handler: (message: Record<string, any>) => void | string | Promise<void | string>): void;
	/**
	 * Say in one line how things stand, for whoever lists the sources: who it is connected to,
	 * what it is waiting for. Call it again when that changes.
	 */
	status(line: string): void;
	/** Look at events of the system (read only): "agent/+/started", "approval/requested", ... */
	on(pattern: string | string[], handler: (e: PineEvent) => void | Promise<void>): void;
	/** Approval requests: put a question of its own to the owner, see the open ones, pass on the owner's answer. */
	approvals: {
		/** Ask the owner in pine's UI. Resolves with their answer; no answer in time counts as no. */
		ask(summary: string, why: string): Promise<boolean>;
		/**
		 * The same, with fields the owner has to fill in (`secret: false` for one that may be shown
		 * while it is typed). `by` says who answered: "timeout" when nobody did.
		 */
		request(summary: string, why: string, inputs: Array<{ name: string; label: string; secret?: boolean }>): Promise<{ allow: boolean; by: string; values?: Record<string, string> }>;
		pending(): Array<{ id: string; agent: string; tool: string; summary: string; why: string; remember?: string; task: number }>;
		decide(id: string, allow: boolean, by: string, always?: boolean): boolean;
	};
	/**
	 * Look at something again and again, for what cannot report by itself: a web address, a
	 * command, a mailbox. `look` runs once right away and then every `every` ("30s", "5m"), never
	 * twice at the same time, a little earlier or later each round so that sources do not all fire
	 * together. A look that throws is a failed look: the pause grows with each one in a row, and
	 * whoever lists the sources sees since when it fails and why. One poll per source; it stops
	 * with the source, and `signal` is aborted then.
	 *
	 * A look that finds nothing new does nothing at all: no event, nothing stored, nobody woken.
	 */
	poll(every: string | number, look: (signal: AbortSignal) => void | Promise<void>): void;
	/**
	 * Compare a value with what was there at the last look, and remember it. Returns what it was
	 * before when it differs. The first look returns nothing: it is the starting point, not a
	 * change. `slot` keeps several values apart.
	 */
	changed<T = unknown>(value: T, slot?: string): { previous: T } | undefined;
	/**
	 * Run a shell command with the rights of the agent this source belongs to (the main agent for
	 * a source of all agents): in that agent's sandbox, from its workspace, without its owner's
	 * environment. It can do nothing that agent's own shell could not. `output` is what it printed,
	 * errors included. Throws when it cannot be started or takes longer than `timeoutMs` (30 s).
	 */
	exec(command: string, opts?: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal }): Promise<{ code: number; output: string; truncated: boolean }>;
	/** Private storage that survives restarts. */
	kv: { get<T = unknown>(key: string): T | undefined; set(key: string, value: unknown): void };
	/** Keep this value out of events and messages. */
	secret(value: string | undefined): void;
	/** Image files in this folder may be shown to a model when an event names them in `images`. */
	media(dir: string): void;
	/** Receive POST /hook/<name> on the control API's port. Throw `refuse(status, message)` to turn a request away. */
	http(handler: (req: { headers: Record<string, string | string[] | undefined>; body: Buffer }) => void | Promise<void>): void;
	onStop(fn: () => void | Promise<void>): void;
}

export type PineSource = (source: SourceApi) => void | Promise<void>;

/** What pine's .env holds, read when asked: an entry the owner just added counts at once. */
function envFile(home: string): Record<string, string> {
	try {
		return parseEnv(fs.readFileSync(path.join(home, ".env"), "utf8")) as Record<string, string>;
	} catch {
		return {};
	}
}

/** An error a webhook handler throws to answer with that HTTP status. */
export function refuse(status: number, message: string): Error {
	return Object.assign(new Error(message), { status });
}

export interface SourceInfo {
	name: string;
	/** "global", or the agent it belongs to. */
	scope: string;
	type: string;
	description?: string;
	trust: string;
	running: boolean;
	error?: string;
	/** What the source says about itself while it runs: who it is connected to, what it waits for. */
	status?: string;
	/** Who listens: "agent" for its main conversation, "agent/conversation" for another. */
	subscribers: string[];
	/** Topic prefix of its events. */
	topic: string;
	last?: { ts: number; topic: string };
	events: number;
}

interface Running {
	stops: Array<() => void | Promise<void>>;
	hook?: (req: { headers: Record<string, string | string[] | undefined>; body: Buffer }) => void | Promise<void>;
	send?: (message: Record<string, any>) => void | string | Promise<void | string>;
}

/** The settings every source has, whatever its type. A type's options cannot have these names. */
const RESERVED_OPTIONS = ["type", "use", "description", "agents", "trust", "start", "enabled", "session"];

/** How a source that polls is doing: when it last looked, and since when looks fail. */
interface Polling {
	ok?: number;
	fails: number;
	since?: number;
	error?: string;
}

/** The longest pause between two looks of a source whose looks keep failing (or its own interval, if that is longer). */
const POLL_BACKOFF_MAX = 15 * 60_000;

const clock = (ts: number) => new Date(ts).toTimeString().slice(0, 8);

/** Where the answers to a source's events are published; the source host passes them to the source. */
const outTopic = (key: string) => `out/source/${key}`;

export class SourceHost {
	private cfg: PineConfig;
	private bus: Bus;
	private kv: Kv;
	private redactor: Redactor;
	private router: Router;
	private log: Logger;
	private httpEnabled: boolean;
	private running = new Map<string, Running>();
	private starting = new Map<string, Promise<void>>();
	private errors = new Map<string, string>();
	private statuses = new Map<string, string>();
	private polls = new Map<string, Polling>();
	private seen = new Map<string, { ts: number; topic: string; count: number }>();
	private off?: () => void;
	private offOut?: () => void;
	private approvals?: Approvals;
	private globalRoutes: string[] = [];
	mediaRoots: string[] = [];
	/** Every source type there is: pine's own and the ones pine.json registers. `type` is what the module says about itself. */
	private types = new Map<string, { file: string; type?: SourceType }>();

	constructor(deps: { cfg: PineConfig; bus: Bus; kv: Kv; redactor: Redactor; router: Router; log: Logger; http: boolean; approvals?: Approvals }) {
		this.approvals = deps.approvals;
		this.cfg = deps.cfg;
		this.bus = deps.bus;
		this.kv = deps.kv;
		this.redactor = deps.redactor;
		this.router = deps.router;
		this.log = deps.log;
		this.httpEnabled = deps.http;
	}

	/** Every configured source with its key: global ones by name, an agent's own as name@agent. */
	private all(): Array<{ key: string; name: string; scope: string; source: SourceConfig }> {
		return [
			...Object.entries(this.cfg.sources).map(([name, source]) => ({ key: name, name, scope: "global", source })),
			...Object.values(this.cfg.agents).flatMap((a) => Object.entries(a.sources).map(([name, source]) => ({ key: `${name}@${a.id}`, name, scope: a.id, source }))),
		];
	}

	private subscribersOf(key: string): string[] {
		const own = Object.values(this.cfg.agents).flatMap((a) => a.subscribe.filter((sub) => sourceFor(this.cfg, a.id, sub.source)?.key === key).map((sub) => (sub.session === "main" ? a.id : `${a.id}/${sub.session}`)));
		return this.cfg.subscribe.some((sub) => sub.source === key) ? ["all agents", ...own] : own;
	}

	/** The agents a subscription for everyone reaches: those that can use the source and have no entry of their own for their main conversation. */
	private reached(sub: SubscriptionConfig): string[] {
		return Object.values(this.cfg.agents)
			.filter((a) => sourceFor(this.cfg, a.id, sub.source)?.scope === "global" && !a.subscribe.some((x) => x.source === sub.source && x.session === sub.session))
			.map((a) => a.id);
	}

	/** (Re)build the routes of the subscriptions for everyone. Called whenever any subscription changes, since an agent's own entry takes the place of the general one. */
	private wireGlobal(): void {
		for (const name of this.globalRoutes) this.router.remove(name);
		this.globalRoutes = [];
		for (const sub of this.cfg.subscribe) {
			const source = this.cfg.sources[sub.source];
			if (!source) continue;
			for (const agentId of this.reached(sub)) {
				const route = { ...this.route(agentId, sub.source, source, sub), name: `sub:*:${agentId}:${sub.source}` };
				this.router.add(route);
				this.globalRoutes.push(route.name);
			}
		}
	}

	/** Read what each source type says about itself. A type whose module does not load is left out, with a line in the log. */
	private async loadTypes(): Promise<void> {
		const files: Record<string, string> = { ...Object.fromEntries(SOURCE_TYPES.map((t) => [t, path.join(import.meta.dirname, "sources", `${t}${EXT}`)])), ...this.cfg.sourceTypes };
		for (const [name, file] of Object.entries(files)) {
			try {
				const mod: any = await import(pathToFileURL(file).href);
				const type: SourceType | undefined = mod.type && typeof mod.type === "object" && mod.type.options ? mod.type : undefined;
				this.types.set(name, { file, type });
				if (!type && !SOURCE_TYPES.includes(name)) this.log.warn(`source type ${name}: ${file} exports no "type" with a schema of its options, so agents cannot set one up by tool call`);
			} catch (e) {
				this.log.error(`source type ${name} could not be loaded from ${file}: ${errText(e)}`);
			}
		}
	}

	/** The source types an agent can set up by tool call: name, what it is for, and the schema of its options. */
	typeList(): Array<{ name: string; summary: string; options: any }> {
		return [...this.types].flatMap(([name, t]) => (t.type ? [{ name, summary: t.type.summary, options: t.type.options }] : []));
	}

	/** Where the source types that were registered while pine ran are kept: in pine's home, which no agent can write. */
	private typeDir = () => path.join(this.cfg.home, "sources");

	/** The registered source types that are not pine's own, with what uses each. */
	ownTypes(): Array<{ name: string; file: string; summary?: string; usedBy: string[] }> {
		return Object.entries(this.cfg.sourceTypes).map(([name, file]) => ({ name, file, summary: this.types.get(name)?.type?.summary, usedBy: this.all().filter((s) => s.source.type === name).map((s) => s.key) }));
	}

	/**
	 * Register a new source type from the text of its module. The text is copied into pine's home
	 * first, and it is that copy that is loaded and runs from then on: what an agent wrote and the
	 * owner confirmed cannot be changed afterwards. A module that does not load or does not describe
	 * itself is not registered, and nothing of it stays.
	 *
	 * This runs the module inside the daemon. Whoever calls it has the owner's yes for exactly this text.
	 */
	async addType(name: string, code: string): Promise<{ name: string; summary: string; options: string; file: string }> {
		if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name)) throw new Error(`"${name}" is not a usable type name: lowercase letters, digits, - and _, starting with a letter`);
		if (SOURCE_TYPES.includes(name)) throw new Error(`"${name}" is one of pine's own types`);
		if (this.cfg.sourceTypes[name]) throw new Error(`a source type "${name}" is registered already. Remove it first (remove_source_type) to put another in its place`);
		fs.mkdirSync(this.typeDir(), { recursive: true, mode: 0o700 });
		// The name carries what is in it: Node loads a file once, so a later version must be another file.
		const file = path.join(this.typeDir(), `${name}.${crypto.createHash("sha256").update(code).digest("hex").slice(0, 10)}.ts`);
		fs.writeFileSync(file, code, { mode: 0o600 });
		let type: SourceType;
		try {
			const mod: any = await import(pathToFileURL(file).href);
			if (typeof mod.default !== "function") throw new Error("it has no default export function, which is what starts a source");
			type = mod.type;
			if (!type || typeof type !== "object" || typeof type.summary !== "string" || !type.summary.trim()) throw new Error('it exports no "type" with a "summary": one line on what such a source reports');
			const schema: any = type.options;
			if (!schema || schema.type !== "object" || typeof schema.properties !== "object") throw new Error('its "type.options" must be a JSON schema of an object: { type: "object", properties: { ... } }');
			const taken = Object.keys(schema.properties).filter((k) => RESERVED_OPTIONS.includes(k));
			if (taken.length) throw new Error(`an option cannot be called ${taken.join(", ")}: every source has a setting of that name already`);
			if (type.plan !== undefined && typeof type.plan !== "function") throw new Error('"type.plan" must be a function');
			describeOptions(schema);
		} catch (e) {
			fs.rmSync(file, { force: true });
			throw new Error(`the module is not a source type: ${errText(e)}`);
		}
		editJson(path.join(this.cfg.home, "pine.json"), (json) => {
			json.sourceTypes = { ...(json.sourceTypes ?? {}), [name]: `./sources/${path.basename(file)}` };
		});
		this.cfg.sourceTypes[name] = file;
		this.types.set(name, { file, type });
		this.log.info(`source type ${name} registered (${file})`);
		return { name, summary: type.summary, options: describeOptions(type.options), file };
	}

	/** Take a registered source type out again. Not while a source of that type exists. */
	removeType(name: string): void {
		if (SOURCE_TYPES.includes(name)) throw new Error(`"${name}" is one of pine's own types and stays`);
		const file = this.cfg.sourceTypes[name];
		if (!file) throw new Error(`there is no registered source type "${name}". Registered: ${Object.keys(this.cfg.sourceTypes).join(", ") || "none"}`);
		const used = this.all().filter((s) => s.source.type === name).map((s) => s.name);
		if (used.length) throw new Error(`the source${used.length === 1 ? "" : "s"} ${used.join(", ")} ${used.length === 1 ? "is" : "are"} of that type. Remove ${used.length === 1 ? "it" : "them"} first`);
		editJson(path.join(this.cfg.home, "pine.json"), (json) => {
			delete json.sourceTypes?.[name];
			if (json.sourceTypes && !Object.keys(json.sourceTypes).length) delete json.sourceTypes;
		});
		// Only the copy pine made itself, which carries the text's hash in its name. A module the owner
		// registered by hand is theirs to delete, also when it lies in the same folder.
		if (path.dirname(file) === this.typeDir() && new RegExp(`^${name}\\.[0-9a-f]{10}\\.ts$`).test(path.basename(file))) fs.rmSync(file, { force: true });
		delete this.cfg.sourceTypes[name];
		this.types.delete(name);
		this.log.info(`source type ${name} removed`);
	}

	/** The name a secret option of a source gets in .env. */
	/** A value the owner typed into a dialog is a secret from here on: kept out of events and logs. */
	keepOut(values: string[]): void {
		this.redactor.add(values.filter(Boolean));
	}

	private envName(name: string, agentId: string | undefined, option: string): string {
		return `PINE_SOURCE_${[name, ...(agentId ? [agentId] : []), option].join("_").replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
	}

	/**
	 * Work out what setting up a source of a type with these options would mean. The options are
	 * checked against the schema the type exposes, then the type itself says what it would do.
	 * Nothing is written.
	 */
	propose(agentId: string, name: string, typeName: string, raw: unknown, forAll = false, ask: string[] = []): SourcePlan & { secrets: string[]; needs: Array<{ name: string; label: string }> } {
		const agent = this.cfg.agents[agentId];
		if (!agent) throw new Error(`unknown agent "${agentId}"`);
		const known = this.typeList();
		const type = this.types.get(typeName)?.type;
		if (!type) throw new Error(`unknown type "${typeName}". Types: ${known.map((t) => t.name).join(", ")}`);
		let options: any = raw ?? {};
		if (typeof options === "string") {
			try {
				options = JSON.parse(options);
			} catch {
				throw new Error(`"options" must be an object, for example ${JSON.stringify(example(type.options))}`);
			}
		}
		if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error(`"options" must be an object, for example ${JSON.stringify(example(type.options))}`);
		// A secret is not the agent's to give: one that is required and missing, or that the agent
		// names in `ask`, the owner types into pine's own dialog. Until then it is simply not there.
		const props: Record<string, any> = (type.options as any).properties ?? {};
		const secretKeys = Object.keys(props).filter((k) => props[k]?.secret === true);
		const unknownAsk = ask.filter((k) => !secretKeys.includes(k));
		if (unknownAsk.length) throw new Error(`"ask" is for the secret options of a ${typeName} source (${secretKeys.join(", ") || "it has none"}), not for ${unknownAsk.join(", ")}`);
		options = { ...options };
		for (const k of secretKeys) if (options[k] === "" || options[k] === null) delete options[k];
		const needs = secretKeys.filter((k) => options[k] === undefined && (ask.includes(k) || ((type.options as any).required ?? []).includes(k))).map((k) => ({ name: k, label: `${k}: ${props[k].description ?? "a secret"}` }));
		// One that is in pine's .env already is given by name; its value is looked up here, for the type to check, and never shown.
		const refs: Record<string, string> = {};
		for (const k of secretKeys) {
			const m = typeof options[k] === "string" ? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(options[k]) : null;
			if (!m) continue;
			const value = envFile(this.cfg.home)[m[1]];
			if (!value) throw new Error(`there is no ${m[1]} in pine's .env file. Your owner adds a line ${m[1]}=... to ${path.join(this.cfg.home, ".env")}, or you leave "${k}" out and pine asks them for it`);
			refs[k] = options[k];
			options[k] = value;
		}
		const wrong = [...Value.Errors(type.options, options)]
			.flatMap((e: any) => {
				if (e.keyword === "boolean") return [];
				if (e.keyword === "additionalProperties") return [`there is no option ${(e.params?.additionalProperties ?? []).join(", ")}`];
				if (e.keyword === "required") {
					const absent = ((e.params?.requiredProperties ?? []) as string[]).filter((k) => !needs.some((n) => n.name === k));
					return absent.length ? [`${absent.join(", ")} is missing`] : [];
				}
				return [`${String(e.instancePath ?? "").replace(/^\//, "") || "options"} ${e.message}`];
			})
			.slice(0, 6);
		if (wrong.length) throw new Error(`these options do not fit a ${typeName} source: ${wrong.join("; ")}. It takes: ${describeOptions(type.options)}`);
		const setup = {
			name,
			key: forAll ? name : `${name}@${agent.id}`,
			agent: agent.id,
			workspace: agent.workspace,
			home: this.cfg.home,
			resolve: (p: string) => realish(p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.isAbsolute(p) ? p : path.join(agent.workspace, p)),
			random: (bytes: number) => crypto.randomBytes(bytes).toString("base64url"),
			envName: (option: string) => this.envName(name, forAll ? undefined : agent.id, option),
		};
		const plan = type.plan ? type.plan(options, setup) : { options, does: [`start a ${typeName} source with ${JSON.stringify(redact(type.options, options))}`], opens: true };
		// What came from .env stays there: the entry keeps the name, not the value.
		plan.options = { ...plan.options, ...refs };
		const secrets = Object.entries<any>(props).filter(([key, schema]) => schema?.secret === true && typeof plan.options[key] === "string" && plan.options[key] && !refs[key]).map(([key]) => key);
		return { ...plan, secrets, needs };
	}

	async start(): Promise<void> {
		await this.loadTypes();
		this.off = this.bus.subscribe("source/#", (e) => {
			const key = e.topic.split("/")[1];
			const s = this.seen.get(key);
			this.seen.set(key, { ts: e.ts, topic: e.topic, count: (s?.count ?? 0) + 1 });
		}, "sources");
		// An agent's answer to a source's event, on its way back out through that source.
		this.offOut = this.bus.subscribe("out/source/+", async (e) => {
			const key = e.topic.split("/")[2];
			const send = this.running.get(key)?.send;
			if (!send) return;
			try {
				await send((e.payload ?? {}) as Record<string, any>);
			} catch (err) {
				this.log.warn(`source ${key} could not send`, errText(err));
			}
		}, "sources-out");
		for (const agent of Object.values(this.cfg.agents)) {
			for (const sub of agent.subscribe) {
				const found = sourceFor(this.cfg, agent.id, sub.source);
				if (found) this.router.add(this.route(agent.id, found.key, found.source, sub));
			}
		}
		this.wireGlobal();
		for (const { key, source } of this.all()) {
			if (source.enabled && (source.start === "always" || this.subscribersOf(key).length)) await this.ensure(key);
		}
	}

	async stop(): Promise<void> {
		this.off?.();
		this.offOut?.();
		for (const key of [...this.running.keys()]) await this.halt(key);
	}

	private routeName = (agentId: string, sub: Pick<SubscriptionConfig, "source" | "session">) => `sub:${agentId}:${sub.source}:${sub.session}`;

	/** What a subscription amounts to: this source's events become turns of that agent in that conversation. */
	private route(agentId: string, key: string, source: SourceConfig, sub: SubscriptionConfig): RouteConfig {
		const name = sub.source;
		const what = `${source.type ?? "custom"}${source.description ? `: ${source.description}` : ""}`;
		const type = source.type ? this.types.get(source.type)?.type : undefined;
		// Somebody writing to the agent through the source: their words are the message, not a report about one.
		const talk = type?.talks
			? {
					prompt: sub.prompt ?? "{{payload.text}}",
					label: `${name}: {{payload.name}}`,
					preface: `[${source.trust === "owner" ? "Your owner wrote" : "Somebody wrote"} this to you through "${name}" (${what}). Your answer is sent back there, so write it for that reader.${sub.note ? ` Your note for this subscription: ${sub.note}` : ""}]`,
				}
			: {};
		return {
			name: this.routeName(agentId, sub),
			on: [`source/${key}/#`],
			when: sub.when,
			debounceMs: sub.debounceMs,
			throttleMs: type?.talks && sub.throttleDefault ? undefined : sub.throttleMs || undefined,
			// One bucket per subscription, whatever the event is called.
			key: "subscription",
			agent: agentId,
			session: sub.session,
			prompt: sub.prompt,
			preface: `[You are subscribed to the event source "${name}" (${what}), and it has just reported the event below.${sub.note ? ` Your note for this subscription: ${sub.note}` : " Act on it as your instructions say."} If nothing needs doing, say so in one line.]`,
			label: `${name}: {{topic}}`,
			...talk,
			// Where an answer goes is the event's to say: a source that can send asks for it, the others do not.
			// The agent subscribed in a conversation with its owner, and that is where it is woken, with
			// the tools it has there. What a source that is not the owner's reports is outside content
			// in that conversation, like a page the agent read. `separate` keeps such events out of it:
			// then the event's own trust decides, which means a conversation and a tool set apart.
			...(sub.separate ? {} : { trust: "owner" as const, taint: source.trust === "owner" ? undefined : `an event from the source "${name}"` }),
		};
	}

	private async ensure(key: string): Promise<void> {
		if (this.running.has(key)) return;
		const pending = this.starting.get(key);
		if (pending) return pending;
		const entry = this.all().find((s) => s.key === key);
		if (!entry || !entry.source.enabled) return;
		const job = this.launch(entry.key, entry.name, entry.source)
			.then(() => void this.errors.delete(key))
			.catch((e) => {
				// A source that cannot start must not take the daemon down: the rest keeps working, and the reason is shown.
				this.errors.set(key, errText(e));
				this.log.warn(`source ${key} could not start`, errText(e));
			})
			.finally(() => this.starting.delete(key));
		this.starting.set(key, job);
		return job;
	}

	private async launch(key: string, name: string, source: SourceConfig): Promise<void> {
		const known = source.type ? (this.types.get(source.type)?.file ?? (SOURCE_TYPES.includes(source.type) ? path.join(import.meta.dirname, "sources", `${source.type}${EXT}`) : this.cfg.sourceTypes[source.type])) : undefined;
		if (source.type && !known) throw new Error(`there is no source type "${source.type}"`);
		const file = known ?? resolvePath(String(source.use), source.base);
		const mod: any = await import(pathToFileURL(file).href);
		const setup: PineSource | undefined = typeof mod.default === "function" ? mod.default : undefined;
		if (!setup) throw new Error(`${file} has no default export function`);
		const dataDir = path.join(this.cfg.dataDir, "sources", key.replace(/[^A-Za-z0-9_@.-]/g, "_"));
		fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		const run: Running = { stops: [] };
		const prefix = `source:${key}:`;
		const api: SourceApi = {
			name,
			key,
			options: source.options,
			base: source.base,
			dataDir,
			log: this.log.child(key),
			emit: (event, payload, opts) => {
				if (!/^[a-z][a-z0-9_-]{0,39}$/.test(event)) throw new Error(`source ${key}: "${event}" is not a usable event name`);
				return this.bus.publish(`source/${key}/${event}`, payload ?? {}, { source: `source:${key}`, trust: source.trust, persist: opts?.persist, reply: opts?.reply ? { topic: outTopic(key), payload: opts.reply } : undefined });
			},
			onSend: (handler) => void (run.send = handler),
			status: (line) => void this.statuses.set(key, String(line).slice(0, 300)),
			on: (pattern, handler) => void run.stops.push(this.bus.subscribe(pattern, async (e) => {
				try {
					await handler(e);
				} catch (err) {
					this.log.warn(`source ${key} failed on ${e.topic}`, errText(err));
				}
			}, `source:${key}`)),
			approvals: {
				ask: async (summary, why) => (this.approvals ? (await this.approvals.request({ agent: `${name} (event source)`, task: 0, tool: source.type ?? name, summary, why })).allow : false),
				request: async (summary, why, inputs) => (this.approvals ? this.approvals.request({ agent: `${name} (event source)`, task: 0, tool: source.type ?? name, summary, why, inputs }) : { allow: false, by: "nobody" }),
				pending: () => this.approvals?.pending() ?? [],
				decide: (id, allow, by, always) => this.approvals?.decide(id, allow, by, always) ?? false,
			},
			poll: (every, look) => {
				const ms = parseDuration(every);
				if (!(ms > 0)) throw new Error(`source ${key}: "${every}" is not an interval to look at`);
				if (this.polls.has(key)) throw new Error(`source ${key}: a source polls one thing`);
				const state: Polling = { fails: 0 };
				this.polls.set(key, state);
				const abort = new AbortController();
				let timer: NodeJS.Timeout | undefined;
				const round = async () => {
					try {
						await look(abort.signal);
						if (abort.signal.aborted) return;
						if (state.fails) api.log.info(`works again after ${state.fails} failed ${state.fails === 1 ? "look" : "looks"}`);
						Object.assign(state, { ok: Date.now(), fails: 0, since: undefined, error: undefined });
					} catch (e) {
						if (abort.signal.aborted) return;
						// Said once, not at every round: the status line carries it from here.
						if (!state.fails) api.log.warn("could not look", errText(e));
						Object.assign(state, { fails: state.fails + 1, since: state.since ?? Date.now(), error: errText(e).slice(0, 200) });
					}
					const wait = state.fails ? Math.min(ms * 2 ** Math.min(state.fails, 12), Math.max(ms, POLL_BACKOFF_MAX)) : ms;
					timer = setTimeout(round, wait * (0.9 + Math.random() * 0.2));
					timer.unref?.();
				};
				run.stops.push(() => {
					abort.abort();
					clearTimeout(timer);
					this.polls.delete(key);
				});
				// Not awaited: a slow first look must not hold up the start of everything else.
				timer = setTimeout(round, 0);
			},
			changed: (value, slot = "") => {
				const k = `${prefix}seen:${slot}`;
				const before = this.kv.get<{ value: any }>(k);
				if (before && JSON.stringify(before.value) === JSON.stringify(value)) return undefined;
				this.kv.set(k, { value });
				return before ? { previous: before.value } : undefined;
			},
			exec: (command, opts) => this.exec(key, command, opts),
			kv: { get: (k) => this.kv.get(prefix + k), set: (k, v) => this.kv.set(prefix + k, v) },
			secret: (value) => this.redactor.add([value]),
			media: (dir) => void this.mediaRoots.push(realish(dir)),
			http: (handler) => {
				if (!this.httpEnabled) throw new Error("this source receives web requests, which needs the control API (\"http\" in pine.json) to be on");
				run.hook = handler;
			},
			onStop: (fn) => void run.stops.push(fn),
		};
		try {
			await setup(api);
		} catch (e) {
			for (const fn of run.stops.reverse()) await Promise.resolve(fn()).catch(() => {});
			throw e;
		}
		this.running.set(key, run);
		this.log.info(`source ${key} started`);
	}

	/** A source's shell command, run the way the shell of the agent it belongs to would run it. */
	private exec(key: string, command: string, opts: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {}): Promise<{ code: number; output: string; truncated: boolean }> {
		const agent = this.cfg.agents[key.includes("@") ? key.slice(key.lastIndexOf("@") + 1) : mainAgentId(this.cfg)];
		if (!agent) return Promise.reject(new Error("the agent this source belongs to is gone"));
		const roots = rootsFor(this.cfg, agent);
		// Where the agent's own shell is withheld because nothing could confine it, a source's command is not run either.
		if (agent.sandbox.enabled && !sandboxAvailable()) return Promise.reject(new Error("there is no sandbox on this platform to run the command in, so it is not run"));
		// The variant of a run that has read outside content: what is read into the agent's prompt stays as it is.
		const argv = agent.sandbox.enabled ? [...sandboxArgv(this.cfg, agent, roots, "restricted"), bin("bash"), "-c", command] : [bin("bash"), "-c", command];
		// On Linux a protected file that did not exist cannot be forbidden, only taken away again.
		const guard = agent.sandbox.enabled ? sandboxGuard(roots, "restricted") : undefined;
		const max = opts.maxBytes ?? 256 * 1024;
		const timeoutMs = opts.timeoutMs ?? 30_000;
		return new Promise((resolve, reject) => {
			if (opts.signal?.aborted) return reject(new Error("stopped"));
			const child = spawn(argv[0], argv.slice(1), { cwd: roots.workspace, env: shellEnv(agent, roots, {}), stdio: ["ignore", "pipe", "pipe"], detached: true });
			const chunks: Buffer[] = [];
			let size = 0;
			let why = "";
			// The whole group: a command that started others must not leave them behind.
			const kill = (reason: string) => {
				why ||= reason;
				try {
					process.kill(-child.pid!, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			};
			const take = (d: Buffer) => {
				if (size < max) chunks.push(d.subarray(0, max - size));
				size += d.length;
				if (size > max * 4) kill("");
			};
			child.stdout.on("data", take);
			child.stderr.on("data", take);
			const timer = setTimeout(() => kill(`it took longer than ${timeoutMs / 1000} s`), timeoutMs);
			const stop = () => kill("stopped");
			opts.signal?.addEventListener("abort", stop, { once: true });
			const done = () => {
				clearTimeout(timer);
				opts.signal?.removeEventListener("abort", stop);
			};
			child.on("error", (e) => (done(), reject(new Error(`could not be started: ${errText(e)}`))));
			child.on("close", (code) => {
				done();
				guard?.restore();
				if (why) return reject(new Error(why));
				resolve({ code: code ?? 1, output: Buffer.concat(chunks).toString("utf8"), truncated: size > max });
			});
		});
	}

	private async halt(key: string): Promise<void> {
		const run = this.running.get(key);
		if (!run) return;
		this.running.delete(key);
		this.statuses.delete(key);
		for (const fn of run.stops.reverse()) {
			try {
				await fn();
			} catch (e) {
				this.log.warn(`source ${key} failed to stop`, errText(e));
			}
		}
		this.log.info(`source ${key} stopped`);
	}

	/**
	 * The sources an agent can send through, with what sending does. A global one or its own;
	 * one that was set up for a single conversation only from there.
	 */
	senders(agentId: string, session = "main"): Array<{ name: string; type: string; sends: string }> {
		return this.available(agentId, session).flatMap((s) => {
			const sends = this.types.get(s.type)?.type?.sends;
			return sends ? [{ name: s.name, type: s.type, sends }] : [];
		});
	}

	/** Send something out through a source, started if it is not running. Throws with the source's own reason if it refuses. */
	async send(agentId: string, name: string, message: Record<string, any>, session = "main"): Promise<string> {
		if (!this.senders(agentId, session).some((s) => s.name === name)) throw new Error(`"${name}" is not a source you can send through. ${this.senders(agentId, session).map((s) => `${s.name}: ${s.sends}`).join("; ") || "There is none."}`);
		const found = sourceFor(this.cfg, agentId, name)!;
		await this.ensure(found.key);
		const send = this.running.get(found.key)?.send;
		if (!send) throw new Error(`${name} is not running${this.errors.get(found.key) ? `: ${this.errors.get(found.key)}` : ""}`);
		return String((await send(message)) ?? "sent");
	}

	/** The handler for POST /hook/<key>, if a running source takes web requests under that name. */
	hookFor(key: string) {
		return this.running.get(key)?.hook;
	}

	/** What a running source says about itself; for one that polls, with when it last looked or since when that fails. */
	private statusOf(key: string): string | undefined {
		const poll = this.polls.get(key);
		const looked = !poll ? "" : poll.fails ? `failing since ${clock(poll.since!)} (${poll.fails} ${poll.fails === 1 ? "look" : "looks"}): ${poll.error}` : poll.ok ? `last looked ${clock(poll.ok)}` : "looking for the first time";
		return [looked, this.statuses.get(key)].filter(Boolean).join(". ") || undefined;
	}

	list(): SourceInfo[] {
		return this.all().map(({ key, name, scope, source }) => {
			const seen = this.seen.get(key);
			return {
				name,
				scope,
				type: source.type ?? "custom",
				description: source.description,
				trust: source.trust,
				running: this.running.has(key),
				error: this.errors.get(key) ?? (source.enabled ? undefined : "disabled"),
				status: this.running.has(key) ? this.statusOf(key) : undefined,
				subscribers: this.subscribersOf(key),
				topic: `source/${key}`,
				last: seen ? { ts: seen.ts, topic: seen.topic } : undefined,
				events: seen?.count ?? 0,
			};
		});
	}

	/**
	 * The sources an agent can subscribe to, as seen from one of its conversations, with everything
	 * that would wake it: `local` this conversation, `agent` its main conversation, `global` a
	 * subscription for all agents, `elsewhere` its other conversations.
	 */
	available(agentId: string, session = "main"): Array<{ name: string; type: string; description?: string; local?: SubscriptionConfig; agent?: SubscriptionConfig; global?: SubscriptionConfig; elsewhere: string[] }> {
		const agent = this.cfg.agents[agentId];
		if (!agent) return [];
		const names = new Set([...Object.keys(agent.sources), ...Object.keys(this.cfg.sources)]);
		return [...names].flatMap((name) => {
			const found = sourceFor(this.cfg, agentId, name);
			if (!found || !found.source.enabled) return [];
			// A source set up for one conversation is that conversation's.
			if (found.source.session && found.source.session !== session) return [];
			const subs = agent.subscribe.filter((x) => x.source === name);
			return [
				{
					name,
					type: found.source.type ?? "custom",
					description: found.source.description,
					local: session === "main" ? undefined : subs.find((x) => x.session === session),
					agent: subs.find((x) => x.session === "main"),
					global: found.scope === "global" ? this.cfg.subscribe.find((x) => x.source === name) : undefined,
					elsewhere: subs.filter((x) => x.session !== session && x.session !== "main").map((x) => x.session),
				},
			];
		});
	}

	/**
	 * Add a source to the configuration while the daemon runs: to one agent's agent.json, or to
	 * pine.json for everyone. `entry` is what goes into the file. The file is written first and then
	 * read back through the normal loader, so a new source is checked exactly like one that was
	 * there at start; if it does not pass, the file is put back as it was.
	 * `read` also lets that agent read the folder (for a folder source outside its workspace).
	 */
	add(agentId: string | undefined, name: string, entry: Record<string, unknown>, read?: string, secrets: string[] = []): SourceConfig {
		const agent = agentId ? this.cfg.agents[agentId] : undefined;
		if (agentId && !agent) throw new Error(`unknown agent "${agentId}"`);
		if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name)) throw new Error(`"${name}" is not a usable source name: lowercase letters, digits, - and _, starting with a letter`);
		if (this.cfg.sources[name] || Object.values(this.cfg.agents).some((a) => a.sources[name])) throw new Error(`a source named "${name}" exists already; pick another name, or subscribe to that one`);
		const file = agent ? path.join(agent.dir, "agent.json") : path.join(this.cfg.home, "pine.json");
		const before = fs.readFileSync(file, "utf8");
		// Read access to a watched folder is an agent's: for a source of all agents, the main agent's, which set it up.
		const reader = read ? (agent ?? this.cfg.agents[mainAgentId(this.cfg)]) : undefined;
		const readerFile = reader ? path.join(reader.dir, "agent.json") : undefined;
		const readerBefore = readerFile && readerFile !== file ? fs.readFileSync(readerFile, "utf8") : undefined;
		const grant = (json: any) => {
			json.sandbox = { ...(json.sandbox ?? {}) };
			json.sandbox.read = [...new Set([...(json.sandbox.read ?? []), read])];
		};
		// A secret goes into .env; the configuration only refers to it by name.
		const kept: Record<string, string> = {};
		entry = { ...entry };
		for (const key of secrets) {
			const env = this.envName(name, agentId, key);
			kept[env] = String(entry[key]);
			entry[key] = `\${${env}}`;
			// From here on it is a secret: kept out of what follows, and taken out of what was stored when it was said.
			this.redactor.add([kept[env]]);
			this.bus.scrub(kept[env]);
		}
		setEnv(this.cfg.home, kept);
		editJson(file, (json) => {
			json.sources = { ...(json.sources ?? {}), [name]: entry };
			if (read && readerFile === file) grant(json);
		});
		if (readerFile && readerFile !== file) editJson(readerFile, grant);
		let fresh: PineConfig;
		try {
			fresh = loadConfig(this.cfg.home);
		} catch (e) {
			fs.writeFileSync(file, before);
			if (readerFile && readerBefore !== undefined) fs.writeFileSync(readerFile, readerBefore);
			unsetEnv(this.cfg.home, Object.keys(kept));
			throw new Error(errText(e).replace(/^[\s\S]*?sources/, "sources"));
		}
		const parsed = agent ? fresh.agents[agent.id].sources[name] : fresh.sources[name];
		if (agent) agent.sources[name] = parsed;
		else this.cfg.sources[name] = parsed;
		if (reader) reader.sandbox.read = fresh.agents[reader.id].sandbox.read;
		this.log.info(`source ${name} added ${agent ? `for ${agent.id}` : "for all agents"} (${parsed.type ?? "custom"})`);
		return parsed;
	}

	/**
	 * Take a source out of the configuration while the daemon runs: it stops, whoever was subscribed
	 * to it is unsubscribed, and its entry is deleted. For a watched folder outside the agent's
	 * workspace, the read access that came with it goes too, unless another source still needs it.
	 */
	async remove(agentId: string | undefined, name: string): Promise<{ removed: boolean; unsubscribed: string[] }> {
		const agent = agentId ? this.cfg.agents[agentId] : undefined;
		if (agentId && !agent) throw new Error(`unknown agent "${agentId}"`);
		const source = agent ? agent.sources[name] : this.cfg.sources[name];
		if (!source) return { removed: false, unsubscribed: [] };
		const key = agent ? `${name}@${agent.id}` : name;
		const unsubscribed = this.subscribersOf(key);
		if (agent) await this.unsubscribe(agent.id, name);
		else {
			await this.unsubscribeAll(name);
			for (const a of Object.values(this.cfg.agents)) if (sourceFor(this.cfg, a.id, name)?.key === key) await this.unsubscribe(a.id, name);
		}
		await this.halt(key);
		// What it kept for itself goes with it: a source of the same name set up later starts from nothing (nobody paired, no place in a queue).
		this.kv.forget(`source:${key}:`);
		const dir = source.type === "folder" && typeof source.options.dir === "string" ? resolvePath(source.options.dir, source.base) : undefined;
		// Whose read access came with it: the agent's own, or the main agent's for a source of all agents.
		const reader = agent ?? this.cfg.agents[mainAgentId(this.cfg)];
		const stillWatched = (a: typeof agent) => [...Object.entries(a?.sources ?? {}), ...Object.entries(this.cfg.sources)].some(([n, x]) => n !== name && x.type === "folder" && typeof x.options.dir === "string" && resolvePath(x.options.dir, x.base) === dir);
		const revoke = (json: any) => {
			if (!reader || !dir || stillWatched(reader) || !Array.isArray(json.sandbox?.read)) return;
			json.sandbox.read = json.sandbox.read.filter((x: string) => resolvePath(x, reader.dir) !== dir);
			if (!json.sandbox.read.length) delete json.sandbox.read;
			if (!Object.keys(json.sandbox).length) delete json.sandbox;
		};
		const names = new Set<string>();
		editJson(agent ? path.join(agent.dir, "agent.json") : path.join(this.cfg.home, "pine.json"), (json) => {
			// The secrets pine put into .env for it go too.
			for (const value of Object.values(json.sources?.[name] ?? {})) {
				const m = typeof value === "string" ? /^\$\{(PINE_SOURCE_[A-Z0-9_]+)\}$/.exec(value) : null;
				if (m) names.add(m[1]);
			}
			delete json.sources?.[name];
			if (json.sources && !Object.keys(json.sources).length) delete json.sources;
			if (agent) revoke(json);
		});
		if (!agent && reader && dir) editJson(path.join(reader.dir, "agent.json"), revoke);
		unsetEnv(this.cfg.home, [...names]);
		if (agent) delete agent.sources[name];
		else delete this.cfg.sources[name];
		if (reader && dir && !stillWatched(reader)) reader.sandbox.read = reader.sandbox.read.filter((x) => x !== dir);
		this.log.info(`source ${name} removed ${agent ? `from ${agent.id}` : "for all agents"}`);
		return { removed: true, unsubscribed };
	}

	/** The sources that were set up for one conversation of an agent. */
	boundTo(agentId: string, session: string): string[] {
		return Object.entries(this.cfg.agents[agentId]?.sources ?? {}).filter(([, s]) => s.session === session).map(([name]) => name);
	}

	/** Agents were added or removed: who a subscription for everyone reaches has changed. */
	agentsChanged(): void {
		this.wireGlobal();
	}

	/** The keys of a subscription that are written to a file. */
	private clean(name: string, raw: Record<string, unknown>): Record<string, unknown> {
		return { source: name, ...Object.fromEntries(Object.entries(raw).filter(([k, v]) => ["note", "when", "debounce", "throttle", "session", "separate", "prompt"].includes(k) && v !== undefined && v !== "" && v !== false && !(k === "session" && v === "main"))) };
	}

	private same(sub: Pick<SubscriptionConfig, "source" | "session">) {
		return (x: Record<string, any>) => {
			try {
				const other = subscriptionFrom(x);
				return other.source === sub.source && other.session === sub.session;
			} catch {
				return false;
			}
		};
	}

	/**
	 * Subscribe one conversation of an agent to a source and keep that in its agent.json, so it
	 * holds across restarts. `raw` is what goes into the file: session (default "main", which is the
	 * agent as such), note, when, debounce, throttle, separate, prompt. Subscribing the same
	 * conversation again replaces its entry.
	 */
	async subscribe(agentId: string, name: string, raw: Record<string, unknown> = {}): Promise<SourceInfo & { session: string }> {
		const agent = this.cfg.agents[agentId];
		if (!agent) throw new Error(`unknown agent "${agentId}"`);
		const found = sourceFor(this.cfg, agentId, name);
		if (!found) throw new Error(`"${name}" is not an event source ${agentId} can use. Available: ${this.available(agentId).map((s) => s.name).join(", ") || "none"}`);
		if (!found.source.enabled) throw new Error(`the source "${name}" is disabled in the configuration`);
		const clean = this.clean(name, raw);
		const sub = subscriptionFrom(clean);
		if (found.source.session && found.source.session !== sub.session) throw new Error(`the source "${name}" was set up for the conversation "${found.source.session}" of ${agentId} alone`);
		editJson(path.join(agent.dir, "agent.json"), (json) => {
			json.subscribe = [...rawSubscriptions(json.subscribe).filter((x) => !this.same(sub)(x)), clean];
		});
		agent.subscribe = [...agent.subscribe.filter((x) => !(x.source === sub.source && x.session === sub.session)), sub];
		this.router.add(this.route(agentId, found.key, found.source, sub));
		this.wireGlobal();
		await this.ensure(found.key);
		this.log.info(`${agentId} subscribed its conversation "${sub.session}" to ${found.key}`);
		return { ...this.started(found.key), session: sub.session };
	}

	/** Subscribe every agent that can use a source of pine.json: each is woken in its main conversation. Kept in pine.json. */
	async subscribeAll(name: string, raw: Record<string, unknown> = {}): Promise<SourceInfo & { agents: string[] }> {
		const source = this.cfg.sources[name];
		if (!source) throw new Error(`"${name}" is not a source in pine.json. A subscription for all agents needs a source that all agents can use`);
		if (!source.enabled) throw new Error(`the source "${name}" is disabled in the configuration`);
		const { session: _session, ...rest } = raw;
		const clean = this.clean(name, rest);
		const sub = subscriptionFrom(clean);
		editJson(path.join(this.cfg.home, "pine.json"), (json) => {
			json.subscribe = [...rawSubscriptions(json.subscribe).filter((x) => x.source !== name), clean];
		});
		this.cfg.subscribe = [...this.cfg.subscribe.filter((x) => x.source !== name), sub];
		this.wireGlobal();
		await this.ensure(name);
		this.log.info(`all agents are subscribed to ${name}`);
		return { ...this.started(name), agents: this.reached(sub) };
	}

	private started(key: string): SourceInfo {
		const info = this.list().find((s) => s.topic === `source/${key}`)!;
		if (info.error) throw new Error(`subscribed, but the source could not start: ${info.error}`);
		return info;
	}

	/** End the subscription of one conversation, or with no `session` of all of that agent's conversations. Returns the conversations that were subscribed. */
	async unsubscribe(agentId: string, name: string, session?: string): Promise<string[]> {
		const agent = this.cfg.agents[agentId];
		if (!agent) return [];
		const gone = agent.subscribe.filter((x) => x.source === name && (session === undefined || x.session === session));
		if (!gone.length) return [];
		const found = sourceFor(this.cfg, agentId, name);
		editJson(path.join(agent.dir, "agent.json"), (json) => {
			json.subscribe = rawSubscriptions(json.subscribe).filter((x) => !gone.some((g) => this.same(g)(x)));
			if (!json.subscribe.length) delete json.subscribe;
		});
		agent.subscribe = agent.subscribe.filter((x) => !gone.includes(x));
		for (const g of gone) this.router.remove(this.routeName(agentId, g));
		this.wireGlobal();
		if (found) await this.settle(found.key);
		this.log.info(`${agentId} unsubscribed ${gone.map((g) => `"${g.session}"`).join(", ")} from ${found?.key ?? name}`);
		return gone.map((g) => g.session);
	}

	async unsubscribeAll(name: string): Promise<boolean> {
		if (!this.cfg.subscribe.some((x) => x.source === name)) return false;
		editJson(path.join(this.cfg.home, "pine.json"), (json) => {
			json.subscribe = rawSubscriptions(json.subscribe).filter((x) => x.source !== name);
			if (!json.subscribe.length) delete json.subscribe;
		});
		this.cfg.subscribe = this.cfg.subscribe.filter((x) => x.source !== name);
		this.wireGlobal();
		await this.settle(name);
		this.log.info(`the subscription of all agents to ${name} ended`);
		return true;
	}

	/**
	 * A conversation was closed or reset: what it was subscribed to on its own goes with it. An
	 * agent's main conversation is the agent as such and keeps its subscriptions.
	 */
	async closeSession(agentId: string, session: string): Promise<string[]> {
		const agent = this.cfg.agents[agentId];
		if (!agent || session === "main") return [];
		const names = [...new Set(agent.subscribe.filter((x) => x.session === session).map((x) => x.source))];
		for (const name of names) await this.unsubscribe(agentId, name, session);
		return names;
	}

	/** A conversation got another name: what it was subscribed to on its own follows it. */
	async renameSession(agentId: string, from: string, to: string): Promise<void> {
		const agent = this.cfg.agents[agentId];
		if (!agent) return;
		const file = path.join(agent.dir, "agent.json");
		// Sources that were set up for it are now set up for the new name.
		const bound = this.boundTo(agentId, from);
		if (bound.length) {
			editJson(file, (json) => {
				for (const name of bound) if (json.sources?.[name]) json.sources[name].session = to;
			});
			for (const name of bound) agent.sources[name].session = to;
		}
		if (!agent.subscribe.some((x) => x.session === from)) return;
		const written = rawSubscriptions(JSON.parse(fs.readFileSync(file, "utf8")).subscribe).filter((x) => {
			try {
				return subscriptionFrom(x).session === from;
			} catch {
				return false;
			}
		});
		for (const raw of written) {
			await this.unsubscribe(agentId, raw.source, from);
			await this.subscribe(agentId, raw.source, { ...raw, session: to });
		}
	}

	/** Stop a source that nobody listens to any more. */
	private async settle(key: string): Promise<void> {
		const source = this.all().find((x) => x.key === key)?.source;
		if (source && source.start !== "always" && !this.subscribersOf(key).length) await this.halt(key);
	}
}

/** A type's options in one line, for a tool description or an error: name, whether it is needed, what it is. */
export function describeOptions(schema: any): string {
	const required: string[] = schema?.required ?? [];
	const props = Object.entries<any>(schema?.properties ?? {});
	if (!props.length) return "no options";
	// A secret is never the agent's to ask for or to pass on.
	return props.map(([key, p]) => (p.secret === true ? `${key} (a secret${required.includes(key) ? ", required: leave it out and pine asks your owner for it" : `: name it in "ask" if one is needed`}): ${p.description ?? "a secret"}` : `${key}${required.includes(key) ? " (required)" : ""}: ${p.description ?? p.type ?? "a value"}`)).join("; ");
}

/** The required options with placeholder values, to show what a call looks like. */
function example(schema: any): Record<string, unknown> {
	return Object.fromEntries((schema?.required ?? []).map((key: string) => [key, schema.properties?.[key]?.type === "number" ? 0 : "..."]));
}

/** The options without the values of secret ones, for a line a person reads. */
function redact(schema: any, options: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(options).map(([key, value]) => [key, schema?.properties?.[key]?.secret === true ? "***" : value]));
}
