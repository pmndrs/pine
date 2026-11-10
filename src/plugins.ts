import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentManager, PluginTool, SessionContributions, SubmitOptions } from "./agents.ts";
import type { AgentConfig, PineConfig, PluginRef } from "./config.ts";
import { type Approvals, realish, type Redactor } from "./security.ts";
import type { Bus, Kv, State } from "./store.ts";
import type { PineEvent, PublishOptions, Task, TaskResult } from "./types.ts";
import { errText, type Logger, resolvePath } from "./util.ts";

/** What a plugin gets. A plugin is a module whose default export is `(pine) => void | Promise<void>`. */
export interface PineApi {
	/** Name the plugin was loaded as. */
	name: string;
	options: Record<string, any>;
	/** Set when the plugin was listed in an agent.json: it then only serves that agent. */
	agent?: string;
	home: string;
	dataDir: string;
	log: Logger;
	bus: {
		/** Publish an event. `trust` defaults to "untrusted"; say "owner" only for input you authenticated as the owner's. */
		publish(topic: string, payload?: unknown, opts?: Omit<PublishOptions, "source">): PineEvent;
		subscribe(pattern: string | string[], handler: (e: PineEvent) => void | Promise<void>): () => void;
	};
	state: State;
	/** Private storage of this plugin. */
	kv: { get<T = unknown>(key: string): T | undefined; set(key: string, value: unknown): void };
	agents: {
		list(): AgentConfig[];
		submit(o: SubmitOptions): Task;
		run(o: SubmitOptions): Promise<TaskResult>;
		wait(id: number): Promise<TaskResult>;
		cancel(id: number): boolean;
		reset(agent: string, session?: string): Promise<boolean>;
		running(): Array<{ task: number; agent: string; session: string }>;
	};
	approvals: Pick<Approvals, "decide" | "pending">;
	/** One model call without tools or history. */
	complete(o: CompleteOptions): Promise<string>;
	/** Give agents in scope a tool. */
	tool(tool: PluginTool): void;
	/** Add a pi extension to every session of the agents in scope. */
	extend(factory: (pi: any, agent: AgentConfig) => void | Promise<void>): void;
	/** Declare a directory this plugin stores images in, so events may refer to files there by path. */
	media(dir: string): void;
	/** Keep this value out of events and messages. */
	secret(value: string | undefined): void;
	onStop(fn: () => void | Promise<void>): void;
}

export interface CompleteOptions {
	prompt: string;
	system?: string;
	model?: string;
	images?: Array<{ data: string; mimeType: string }>;
	signal?: AbortSignal;
}

export type PinePlugin = (pine: PineApi) => void | Promise<void>;

const BUILTIN = ["telegram", "mqtt", "watch"];

export class PluginHost implements SessionContributions {
	private cfg: PineConfig;
	private log: Logger;
	private tools: Array<{ scope: string; tool: PluginTool; plugin: string }> = [];
	private extensions: Array<{ scope: string; factory: (pi: any, agent: AgentConfig) => void | Promise<void> }> = [];
	private stops: Array<{ name: string; fn: () => void | Promise<void> }> = [];
	loaded: Array<{ name: string; scope: string }> = [];
	mediaRoots: string[] = [];

	constructor(cfg: PineConfig, log: Logger) {
		this.cfg = cfg;
		this.log = log;
	}

	private inScope(scope: string, agentId: string): boolean {
		return scope === "*" ? this.cfg.agents[agentId]?.globalPlugins !== false : scope === agentId;
	}

	extensionsFor(agentId: string) {
		return this.extensions.filter((e) => this.inScope(e.scope, agentId)).map((e) => e.factory);
	}

	toolsFor(agentId: string) {
		return this.tools.filter((t) => this.inScope(t.scope, agentId)).map((t) => t.tool);
	}

	async loadAll(deps: { bus: Bus; state: State; kv: Kv; manager: AgentManager; approvals: Approvals; redactor: Redactor; complete: (o: CompleteOptions) => Promise<string> }): Promise<void> {
		const refs: Array<{ ref: PluginRef; scope: string }> = [
			...this.cfg.plugins.map((ref) => ({ ref, scope: "*" })),
			...Object.values(this.cfg.agents).flatMap((a) => a.plugins.map((ref) => ({ ref, scope: a.id }))),
		];
		for (const { ref, scope } of refs) {
			const builtin = ref.use.startsWith("pine:") ? ref.use.slice(5) : undefined;
			if (builtin && !BUILTIN.includes(builtin)) throw new Error(`unknown built-in plugin "${ref.use}" (have: ${BUILTIN.map((b) => `pine:${b}`).join(", ")})`);
			const file = builtin ? path.join(import.meta.dirname, "plugins", `${builtin}.ts`) : resolvePath(ref.use, ref.base);
			const name = builtin ?? path.basename(file).replace(/\.[cm]?[jt]s$/, "");
			let mod: any;
			try {
				mod = await import(pathToFileURL(file).href);
			} catch (e) {
				throw new Error(`plugin ${ref.use} failed to load: ${errText(e)}`);
			}
			const setup: PinePlugin | undefined = typeof mod.default === "function" ? mod.default : undefined;
			if (!setup) throw new Error(`plugin ${ref.use} has no default export function`);
			const log = this.log.child(scope === "*" ? name : `${name}@${scope}`);
			const prefix = `plugin:${name}:${scope}:`;
			const api: PineApi = {
				name,
				options: ref.options,
				agent: scope === "*" ? undefined : scope,
				home: this.cfg.home,
				dataDir: this.cfg.dataDir,
				log,
				bus: {
					publish: (topic, payload, opts) => deps.bus.publish(topic, payload, { ...opts, source: name }),
					subscribe: (pattern, handler) => deps.bus.subscribe(pattern, handler, `plugin:${name}`),
				},
				state: deps.state,
				kv: { get: (k) => deps.kv.get(prefix + k), set: (k, v) => deps.kv.set(prefix + k, v) },
				agents: {
					list: () => Object.values(this.cfg.agents),
					submit: (o) => deps.manager.submit(o),
					run: (o) => deps.manager.run(o),
					wait: (id) => deps.manager.wait(id),
					cancel: (id) => deps.manager.cancel(id),
					reset: (agent, session) => deps.manager.resetSession(agent, session),
					running: () => deps.manager.status().running,
				},
				approvals: { decide: (id, allow, by, always) => deps.approvals.decide(id, allow, by, always), pending: () => deps.approvals.pending() },
				complete: deps.complete,
				tool: (tool) => {
					if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) throw new Error(`plugin ${name}: invalid tool name "${tool.name}"`);
					this.tools.push({ scope, tool, plugin: name });
				},
				extend: (factory) => void this.extensions.push({ scope, factory }),
				media: (dir) => void this.mediaRoots.push(realish(dir)),
				secret: (value) => deps.redactor.add([value]),
				onStop: (fn) => void this.stops.push({ name, fn }),
			};
			await setup(api);
			this.loaded.push({ name, scope });
			log.info(`loaded${scope === "*" ? "" : ` for agent ${scope}`}`);
		}
	}

	async stopAll(): Promise<void> {
		for (const { name, fn } of this.stops.reverse()) {
			try {
				await fn();
			} catch (e) {
				this.log.warn(`plugin ${name} failed to stop`, errText(e));
			}
		}
		this.stops = [];
	}
}
