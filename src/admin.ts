// What the main agent administers besides what every agent sets up for itself: the agents
// themselves and pine's settings. Nothing here is free text into a file. A change is a few named
// values, each checked on its own; it is written, the whole configuration is read back through
// the normal loader, and what does not pass is undone. The tools that call this are in
// src/tools.ts, and each of them asks the owner first.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_TOOLS } from "./agent-admin.ts";
import { type AgentConfig, loadConfig, mainAgentId, type Mode, MODES, PINE_ROOT, type PineConfig, RESERVED_TOPICS, type RouteConfig, unsandboxed } from "./config.ts";
import { unsetEnv } from "./env-file.ts";
import { editJson } from "./mcp-config.ts";
import { isInside, realish } from "./security.ts";
import type { Kv, TaskStore } from "./store.ts";
import { errText, matchesAny, parseDuration } from "./util.ts";

export const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// ---- an agent's own settings ---------------------------------------------------------------------

/** What can be changed about an agent. Everything is optional; what is left out stays. */
export interface AgentChange {
	description?: string;
	/** The whole new text of its instruction file (AGENTS.md in its workspace). */
	instructions?: string;
	/** "default" goes back to pine's default model. */
	model?: string;
	thinking?: string;
	/** A mode, or "default" for what pine gives an agent that names none (auto for the main agent, safe for the others). */
	mode?: string;
	tools?: string[];
	/** Agents it may hand work to; "*" is every agent. */
	delegates?: string[];
	network?: boolean;
	/** Folders outside its workspace it may read from now on. */
	read?: string[];
	/** Folders outside its workspace it may read and change from now on. */
	write?: string[];
	/** Folders to take out of both lists again. */
	forget?: string[];
}

const folder = (given: string) => {
	const text = given.trim();
	const full = text === "~" ? os.homedir() : text.startsWith("~/") ? path.join(os.homedir(), text.slice(2)) : text;
	if (!path.isAbsolute(full)) throw new Error(`"${given}" is not a full path. A folder is given from the root, for example ${path.join(os.homedir(), "Documents")}`);
	return realish(full);
};

/**
 * Check a change to an agent and say what it does, line by line, with what makes it wider.
 * Nothing is written. Throws with what is wrong and how it would be right.
 */
export function checkAgentChange(cfg: PineConfig, agent: AgentConfig, change: AgentChange, models: string[]): { lines: string[]; warnings: string[]; json: (raw: any) => void; instructions?: string } {
	const lines: string[] = [];
	const warnings: string[] = [];
	const steps: Array<(raw: any) => void> = [];
	const main = agent.id === mainAgentId(cfg);
	if (change.description !== undefined) {
		const text = change.description.replace(/\s+/g, " ").trim();
		if (!text) throw new Error("a description is one line on what the agent is for; it cannot be empty");
		lines.push(`description: ${text}`);
		steps.push((raw) => (raw.description = text));
	}
	if (change.model !== undefined) {
		const none = change.model === "default" || change.model === "";
		if (!none && !models.includes(change.model)) throw new Error(`there is no model "${change.model}". Models: ${models.slice(0, 40).join(", ")}`);
		lines.push(`model: ${agent.model ?? `${cfg.defaults.model} (the default)`} -> ${none ? `${cfg.defaults.model} (the default)` : change.model}`);
		steps.push((raw) => (none ? delete raw.model : (raw.model = change.model)));
	}
	if (change.thinking !== undefined) {
		if (!THINKING.includes(change.thinking)) throw new Error(`"thinking" is one of ${THINKING.join(", ")}`);
		lines.push(`reasoning: ${agent.thinking} -> ${change.thinking}`);
		steps.push((raw) => (raw.thinking = change.thinking));
	}
	if (change.mode !== undefined) {
		if (change.mode !== "default" && !MODES.includes(change.mode as Mode)) throw new Error(`"mode" is one of ${MODES.join(", ")}, or default`);
		const next = change.mode === "default" ? (cfg.defaults.mode ?? (main ? "auto" : "safe")) : (change.mode as Mode);
		lines.push(`mode: ${agent.mode} -> ${next}${change.mode === "default" ? " (the default)" : ""}`);
		if (next === "bypass") warnings.push("in bypass mode it never asks, and its shell reaches your whole account and the network");
		else if (next === "auto" && !unsandboxed(agent.level)) warnings.push("in auto mode its shell and file tools work without a sandbox: they reach your whole user account and the network in your own conversations");
		steps.push((raw) => {
			if (change.mode === "default") delete raw.mode;
			else raw.mode = change.mode;
			// What said this before the mode did. Left in place, it would decide again.
			if (raw.sandbox && typeof raw.sandbox === "object") delete raw.sandbox.scope;
		});
	}
	if (change.tools !== undefined) {
		const unknown = change.tools.filter((t) => !AGENT_TOOLS.includes(t));
		if (unknown.length) throw new Error(`unknown tool${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}. An agent can have: ${AGENT_TOOLS.join(", ")}`);
		lines.push(`built-in tools: ${(agent.tools ?? AGENT_TOOLS).join(", ")} -> ${change.tools.join(", ") || "none"}`);
		steps.push((raw) => (raw.tools = change.tools));
	}
	if (change.delegates !== undefined) {
		const unknown = change.delegates.filter((d) => d !== "*" && (!cfg.agents[d] || d === agent.id));
		if (unknown.length) throw new Error(`"delegates" names ${unknown.join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not another agent. Agents: ${Object.keys(cfg.agents).filter((id) => id !== agent.id).join(", ") || "none"}; "*" is every agent`);
		lines.push(`may hand work to: ${agent.delegates.join(", ") || "nobody"} -> ${change.delegates.join(", ") || "nobody"}`);
		steps.push((raw) => (raw.delegates = change.delegates));
	}
	if (change.network !== undefined) {
		lines.push(`network from its shell: ${agent.sandbox.network ? "yes" : "no"} -> ${change.network ? "yes" : "no"}`);
		if (change.network && !agent.sandbox.network) warnings.push("with the network its commands can send what it reads anywhere");
		steps.push((raw) => {
			raw.sandbox = typeof raw.sandbox === "object" && raw.sandbox ? raw.sandbox : {};
			if (change.network) raw.sandbox.network = true;
			else delete raw.sandbox.network;
		});
	}
	const closed = (p: string) => {
		const about = (root: string) => isInside(root, p) || isInside(p, root);
		const other = Object.values(cfg.agents).find((a) => a.id !== agent.id && isInside(realish(a.workspace), p));
		if (other) return `that is the workspace of the agent ${other.id}; agents exchange work with delegate, not through each other's files`;
		if (about(realish(cfg.home))) return "pine's own folder stays closed to every agent";
		if (about(realish(PINE_ROOT))) return "pine's own code is not given to an agent";
		return Object.values(cfg.agents).some((a) => a.id !== agent.id && about(realish(a.workspace))) ? "another agent's workspace lies in it" : undefined;
	};
	const adds = { read: (change.read ?? []).map(folder), write: (change.write ?? []).map(folder) };
	const drops = (change.forget ?? []).map(folder);
	for (const kind of ["read", "write"] as const) {
		for (const p of adds[kind]) {
			const no = closed(p);
			if (no) throw new Error(`${p} cannot be opened for ${agent.id}: ${no}`);
			if (!fs.existsSync(p)) throw new Error(`${p} does not exist. Give a folder that is there`);
			lines.push(`may ${kind === "write" ? "read and change" : "read"}: ${p}`);
		}
	}
	for (const p of drops) {
		if (![...agent.sandbox.read, ...agent.sandbox.write].some((x) => realish(x) === p)) throw new Error(`${agent.id} has no folder ${p} to forget. It has: ${[...new Set([...agent.sandbox.read, ...agent.sandbox.write])].join(", ") || "none"}`);
		lines.push(`no longer: ${p}`);
	}
	if (adds.read.length || adds.write.length || drops.length) {
		steps.push((raw) => {
			raw.sandbox = typeof raw.sandbox === "object" && raw.sandbox ? raw.sandbox : {};
			const next = (list: unknown, add: string[]) => [...new Set([...(Array.isArray(list) ? list.map(String) : []), ...add])].filter((x) => !drops.includes(realish(path.resolve(agent.dir, x))));
			const read = next(raw.sandbox.read, adds.read);
			const write = next(raw.sandbox.write, adds.write);
			if (read.length) raw.sandbox.read = read;
			else delete raw.sandbox.read;
			if (write.length) raw.sandbox.write = write;
			else delete raw.sandbox.write;
		});
	}
	const instructions = change.instructions?.trim();
	if (change.instructions !== undefined) {
		if (!instructions) throw new Error("instructions cannot be empty: they are who the agent is and how it works");
		lines.push(`instructions (its AGENTS.md) replaced by:\n${instructions.length > 1200 ? `${instructions.slice(0, 1200)}...` : instructions}`);
	}
	if (!lines.length) throw new Error("nothing to change: give at least one of description, instructions, model, thinking, mode, tools, delegates, network, read, write, forget");
	return { lines, warnings, json: (raw) => steps.forEach((s) => s(raw)), instructions };
}

/**
 * Write a checked change and take it over. The agent's file is read back through the loader
 * with everything else: if the configuration does not load, the file is as it was and nothing
 * has changed.
 */
export function applyAgentChange(cfg: PineConfig, agent: AgentConfig, checked: { json: (raw: any) => void; instructions?: string }): void {
	const file = path.join(agent.dir, "agent.json");
	const before = fs.readFileSync(file, "utf8");
	try {
		editJson(file, checked.json);
		const fresh = loadConfig(cfg.home).agents[agent.id];
		if (!fresh) throw new Error("the agent was not found after the change");
		// The same object stays: sessions, sources and schedules hold on to it.
		Object.assign(agent, fresh);
	} catch (e) {
		fs.writeFileSync(file, before);
		throw new Error(`not changed: ${errText(e)}`);
	}
	if (checked.instructions !== undefined) {
		// The workspace is the agent's to write. A file of that name is taken away and a new one
		// made, never written through: what lies there could be a link to somewhere else.
		const target = path.join(agent.workspace, "AGENTS.md");
		fs.rmSync(target, { force: true });
		fs.writeFileSync(target, `${checked.instructions}\n`, { mode: 0o600, flag: "wx" });
	}
}

/** The parts of the configuration that name an agent and stand in the way of removing it, or are corrected when it goes. */
export function namedBy(cfg: PineConfig, id: string): { routes: string[]; delegators: string[]; sources: string[]; servers: string[] } {
	return {
		routes: cfg.routes.filter((r) => r.agent === id).map((r) => r.name),
		delegators: Object.values(cfg.agents).filter((a) => a.id !== id && a.delegates.includes(id)).map((a) => a.id),
		sources: Object.entries(cfg.sources).filter(([, s]) => s.agents?.includes(id)).map(([name]) => name),
		servers: Object.entries(cfg.mcp).filter(([, s]) => s.agents?.includes(id)).map(([name]) => name),
	};
}

/** Take an agent's name out of the lists that name it: other agents' delegates, and the sources and servers of all agents that are only for some. */
export function unname(cfg: PineConfig, id: string): void {
	const named = namedBy(cfg, id);
	for (const other of named.delegators) {
		const a = cfg.agents[other];
		a.delegates = a.delegates.filter((d) => d !== id);
		editJson(path.join(a.dir, "agent.json"), (raw) => {
			if (Array.isArray(raw.delegates)) raw.delegates = raw.delegates.filter((d: unknown) => d !== id);
		});
	}
	if (named.sources.length || named.servers.length) {
		editJson(path.join(cfg.home, "pine.json"), (raw) => {
			for (const name of named.sources) if (Array.isArray(raw.sources?.[name]?.agents)) raw.sources[name].agents = raw.sources[name].agents.filter((a: unknown) => a !== id);
			for (const name of named.servers) if (Array.isArray(raw.mcp?.[name]?.agents)) raw.mcp[name].agents = raw.mcp[name].agents.filter((a: unknown) => a !== id);
		});
		for (const name of named.sources) cfg.sources[name].agents = cfg.sources[name].agents!.filter((a) => a !== id);
		for (const name of named.servers) cfg.mcp[name].agents = cfg.mcp[name].agents!.filter((a) => a !== id);
	}
}

/**
 * Take what is left of an agent out of pine's files and store, so that nothing of it remains:
 * the routes that wake it, its name in the lists of others, the secrets pine kept for its
 * sources and servers, what is stored under its name (marks, lists, turns, tasks, pins, open
 * tabs), the recorded states of its folders, its private home and its folder. This is the part
 * that needs no running daemon: `AgentManager.removeAgent` stops what runs and then calls it,
 * and `pine agent remove` calls it alone when no daemon runs.
 *
 * The folder is moved aside first and the configuration that is left is read back. If that
 * does not load, the folder stays in `removed/` and `problem` says why. With `keepFiles` it
 * stays there on purpose. A workspace outside pine's home is the owner's folder and is left.
 */
export function eraseAgent(cfg: PineConfig, store: { kv: Kv; tasks: TaskStore }, id: string, keepFiles = false): { routes: string[]; kept?: string; workspaceLeft?: string; problem?: string } {
	const agent = cfg.agents[id];
	if (!agent) throw new Error(`there is no agent "${id}"`);
	if (id === mainAgentId(cfg)) throw new Error("the main agent administers pine and cannot be removed");
	// The keys pine put into .env for its sources and servers. One the owner wrote there under a name of their own stays.
	let raw = "";
	try {
		raw = fs.readFileSync(path.join(agent.dir, "agent.json"), "utf8");
	} catch {
		// no file, no keys
	}
	unsetEnv(cfg.home, [...new Set([...raw.matchAll(/\$\{(PINE_(?:SOURCE|MCP)_[A-Z0-9_]+)\}/g)].map((m) => m[1]))]);
	const routes = cfg.routes.filter((r) => r.agent === id).map((r) => r.name);
	for (const name of routes) dropRoute(cfg, name);
	unname(cfg, id);
	for (const prefix of ["taint", "keep", "folder", "todos", "turns", "undone"]) store.kv.forget(`${prefix}:${id}:`);
	for (const key of store.kv.keys("timer:")) if (key.endsWith(`@${id}`)) store.kv.set(key, null);
	for (const key of store.kv.keys("source:")) if (key.slice("source:".length).split(":")[0].endsWith(`@${id}`)) store.kv.forget(key);
	const pinned = store.kv.get<string[]>("conversations:pinned");
	if (Array.isArray(pinned) && pinned.some((x) => x.startsWith(`${id}:`))) store.kv.set("conversations:pinned", pinned.filter((x) => !x.startsWith(`${id}:`)));
	const ui = store.kv.get<{ tabs?: Array<{ agent: string }> }>("ui:tabs");
	if (ui && Array.isArray(ui.tabs) && ui.tabs.some((t) => t.agent === id)) store.kv.set("ui:tabs", { ...ui, tabs: ui.tabs.filter((t) => t.agent !== id) });
	store.tasks.forgetAgent(id);
	// What was recorded of its folders for undo.
	const workspace = realish(agent.workspace);
	const dir = realish(agent.dir);
	const snapshots = path.join(cfg.dataDir, "snapshots");
	for (const name of fs.existsSync(snapshots) ? fs.readdirSync(snapshots) : []) {
		let root = "";
		try {
			root = fs.readFileSync(path.join(snapshots, name, "pine-folder"), "utf8").trim();
		} catch {
			continue;
		}
		if (isInside(workspace, root) || isInside(dir, root)) fs.rmSync(path.join(snapshots, name), { recursive: true, force: true });
	}
	for (const base of [path.join(cfg.dataDir, "programs"), path.join(cfg.dataDir, "browser-local")]) {
		for (const name of fs.existsSync(base) ? fs.readdirSync(base) : []) if (decodeURIComponent(name).startsWith(`${id}:`)) fs.rmSync(path.join(base, name), { recursive: true, force: true });
	}
	// What its event sources kept on disk ("name@agent").
	const kept = path.join(cfg.dataDir, "sources");
	for (const name of fs.existsSync(kept) ? fs.readdirSync(kept) : []) if (name.endsWith(`@${id}`)) fs.rmSync(path.join(kept, name), { recursive: true, force: true });
	const outside = !isInside(dir, workspace);
	const aside = path.join(cfg.home, "removed", `${id}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
	fs.mkdirSync(path.dirname(aside), { recursive: true, mode: 0o700 });
	fs.renameSync(agent.dir, aside);
	delete cfg.agents[id];
	fs.rmSync(path.join(cfg.home, "sandbox", id), { recursive: true, force: true });
	let problem: string | undefined;
	try {
		loadConfig(cfg.home);
	} catch (e) {
		problem = errText(e);
	}
	const keep = keepFiles || problem !== undefined;
	if (!keep) {
		fs.rmSync(aside, { recursive: true, force: true });
		// The folder that held it for a moment, if nothing else is kept there.
		if (!fs.readdirSync(path.dirname(aside)).length) fs.rmdirSync(path.dirname(aside));
	}
	return { routes, kept: keep ? aside : undefined, workspaceLeft: outside ? agent.workspace : undefined, problem };
}

// ---- routes --------------------------------------------------------------------------------------

/** A route as the main agent proposes it: a few named values, the same ones `pine.json` takes. */
export interface RouteInput {
	name: string;
	/** Topic patterns it listens to, separated by commas. */
	on: string;
	/** Only events that match, as JSON: {"payload.open": true}. */
	when?: string;
	throttle?: string;
	debounce?: string;
	/** Wake an agent with a prompt. */
	agent?: string;
	prompt?: string;
	session?: string;
	/** Write shared state, as JSON: {"house/mode": "{{payload.value}}"}. */
	set?: string;
	publish_topic?: string;
	publish_payload?: string;
	/** One model call without tools. */
	call_prompt?: string;
	call_system?: string;
	call_model?: string;
	trust?: string;
}

const object = (text: string | undefined, what: string): Record<string, unknown> | undefined => {
	if (text === undefined || text.trim() === "") return undefined;
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		throw new Error(`"${what}" must be JSON, for example {"payload.open": true}`);
	}
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`"${what}" must be a JSON object, for example {"payload.open": true}`);
	return v as Record<string, unknown>;
};

/** Check a proposed route and say what it does, line by line. Nothing is written. */
export function checkRoute(cfg: PineConfig, input: RouteInput, models: string[]): { entry: Record<string, unknown>; lines: string[]; wider?: string } {
	const name = String(input.name ?? "").trim();
	if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name)) throw new Error(`"${name}" is not a usable route name: lowercase letters, digits, - and _, starting with a letter`);
	if (cfg.routes.some((r) => r.name === name)) throw new Error(`a route called "${name}" exists already. remove_route takes it out; then add it again with what you want changed`);
	const on = String(input.on ?? "").split(",").map((x) => x.trim()).filter(Boolean);
	if (!on.length) throw new Error('"on" is the topic the route listens to, for example source/house/message. The sources tool shows a source\'s topic');
	const entry: Record<string, unknown> = { name, on: on.length === 1 ? on[0] : on };
	const lines = [`on ${on.join(", ")}`];
	const when = object(input.when, "when");
	if (when) {
		entry.when = when;
		lines.push(`only when ${JSON.stringify(when)}`);
	}
	for (const [key, given] of [["throttleMs", input.throttle], ["debounceMs", input.debounce]] as const) {
		if (given === undefined || given === "") continue;
		try {
			if (!(parseDuration(given) > 0)) throw new Error("not a time");
		} catch {
			throw new Error(`"${key === "throttleMs" ? "throttle" : "debounce"}" is a time such as 10s or 5m`);
		}
		entry[key] = given;
		lines.push(key === "throttleMs" ? `after one event, ignore the next for ${given}` : `wait until ${given} have passed without a new event, then handle the last one`);
	}
	const set = object(input.set, "set");
	if (set) {
		entry.set = set;
		lines.push(`set shared state: ${JSON.stringify(set)}`);
	}
	if (input.call_prompt) {
		if (input.call_model && !models.includes(input.call_model)) throw new Error(`there is no model "${input.call_model}". Models: ${models.slice(0, 40).join(", ")}`);
		entry.call = { ...(input.call_model ? { model: input.call_model } : {}), ...(input.call_system ? { system: input.call_system } : {}), prompt: input.call_prompt };
		lines.push(`one model call without tools${input.call_model ? ` (${input.call_model})` : ""}: ${input.call_prompt}`);
	} else if (input.call_system || input.call_model) throw new Error('a model call needs "call_prompt": what the model is asked');
	if (input.publish_topic) {
		const topic = input.publish_topic.trim();
		if (matchesAny(RESERVED_TOPICS, topic)) throw new Error(`"${topic}" is a topic only pine itself publishes on. Pick one of your own, for example cam/classified`);
		let payload: unknown;
		if (input.publish_payload !== undefined && input.publish_payload !== "") {
			try {
				payload = JSON.parse(input.publish_payload);
			} catch {
				payload = input.publish_payload;
			}
		}
		entry.publish = { topic, ...(payload !== undefined ? { payload } : {}) };
		lines.push(`publish the event ${topic}${payload !== undefined ? ` with ${JSON.stringify(payload)}` : ""}${topic.startsWith("out/") ? " (this sends through a source)" : ""}`);
	} else if (input.publish_payload) throw new Error('publishing needs "publish_topic"');
	if (input.agent) {
		if (!cfg.agents[input.agent]) throw new Error(`there is no agent "${input.agent}". Agents: ${Object.keys(cfg.agents).join(", ")}`);
		if (entry.call) throw new Error("a route makes a model call or wakes an agent, not both. Let the call publish its result, and a second route wake the agent on that topic");
		entry.agent = input.agent;
		if (input.prompt) entry.prompt = input.prompt;
		if (input.session) entry.session = input.session;
		lines.push(`wake the agent ${input.agent}${input.session ? ` (conversation: ${input.session})` : ""}${input.prompt ? ` with: ${input.prompt}` : " with the event"}`);
	} else if (input.prompt || input.session) throw new Error('"prompt" and "session" belong to "agent": name the agent the route wakes');
	if (!entry.set && !entry.call && !entry.publish && !entry.agent) throw new Error("a route has to do something: give at least one of agent (wake an agent), set (write shared state), publish_topic (publish another event), call_prompt (one model call)");
	let wider: string | undefined;
	if (input.trust !== undefined && input.trust !== "") {
		if (input.trust !== "owner" && input.trust !== "untrusted") throw new Error('"trust" is owner or untrusted. Leave it out: an event keeps the trust it came with');
		entry.trust = input.trust;
		if (input.trust === "owner") {
			lines.push("treat every event on it as your own words");
			wider = `events on ${on.join(", ")} are then treated as coming from you: whoever can make such an event gets the agent's full tool set`;
		}
	}
	return { entry, lines, wider };
}

/** Write a checked route into pine.json and take it over. If the configuration does not load with it, the file is as it was. */
export function addRoute(cfg: PineConfig, entry: Record<string, unknown>): RouteConfig {
	const file = path.join(cfg.home, "pine.json");
	const before = fs.readFileSync(file, "utf8");
	try {
		editJson(file, (raw) => {
			raw.routes = Array.isArray(raw.routes) ? raw.routes : [];
			raw.routes.push(entry);
		});
		const made = loadConfig(cfg.home).routes.find((r) => r.name === entry.name);
		if (!made) throw new Error("the route was not found after writing it");
		cfg.routes.push(made);
		return made;
	} catch (e) {
		fs.writeFileSync(file, before);
		throw new Error(`not added: ${errText(e)}`);
	}
}

/** Take a route out of pine.json by its name. The routes that stay keep their names, also those that had none of their own. */
export function dropRoute(cfg: PineConfig, name: string): boolean {
	if (!cfg.routes.some((r) => r.name === name)) return false;
	editJson(path.join(cfg.home, "pine.json"), (raw) => {
		if (!Array.isArray(raw.routes)) return;
		const named = raw.routes.map((r: any, i: number) => (r && typeof r === "object" && r.name === undefined ? { name: `route${i}`, ...r } : r));
		raw.routes = named.filter((r: any) => r?.name !== name);
		if (!raw.routes.length) delete raw.routes;
	});
	cfg.routes.splice(0, cfg.routes.length, ...cfg.routes.filter((r) => r.name !== name));
	return true;
}

/** The routes as a list for the agent. */
export function routesText(cfg: PineConfig): string {
	const does = (r: RouteConfig) =>
		[r.set ? `sets ${JSON.stringify(r.set)}` : "", r.call ? `asks a model: ${r.call.prompt}` : "", r.publish ? `publishes ${r.publish.topic}` : "", r.agent ? `wakes ${r.agent}${r.session ? ` (conversation: ${r.session})` : ""}${r.prompt ? ` with: ${r.prompt}` : ""}` : ""].filter(Boolean).join("; ");
	return cfg.routes.map((r) => `- ${r.name}: on ${r.on.join(", ")}${r.when ? ` when ${JSON.stringify(r.when)}` : ""}${r.throttleMs ? ` · at most one per ${ms(r.throttleMs)}` : ""}${r.debounceMs ? ` · after ${ms(r.debounceMs)} of quiet` : ""}${r.trust === "owner" ? " · its events count as the owner's words" : ""}\n    ${does(r)}`).join("\n");
}

/** What an agent has, as its files say it: what goes with it when it is removed. */
export function holdingsOf(cfg: PineConfig, id: string): { conversations: string[]; sources: string[]; servers: string[]; schedules: string[]; skills: string[]; routes: string[]; files: number; outside: boolean } {
	const agent = cfg.agents[id];
	if (!agent) throw new Error(`there is no agent "${id}"`);
	const names = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith(".")) : []);
	return {
		conversations: names(path.join(agent.dir, "sessions")).filter((n) => !/\.reset-\d+$/.test(n) && !n.endsWith("~u") && !n.startsWith("_t")).sort((a, b) => Number(b === "main") - Number(a === "main") || a.localeCompare(b)),
		sources: Object.keys(agent.sources),
		servers: Object.keys(agent.mcp),
		schedules: agent.schedules.map((s) => s.name),
		skills: names(path.join(agent.dir, "skills")),
		routes: cfg.routes.filter((r) => r.agent === id).map((r) => r.name),
		files: countFiles(agent.workspace),
		outside: !isInside(realish(agent.dir), realish(agent.workspace)),
	};
}

/** How many files lie in a folder, without following links. Stops counting at a limit. */
export function countFiles(dir: string, limit = 5000): number {
	let n = 0;
	const walk = (d: string) => {
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (n >= limit) return;
			if (e.isDirectory()) walk(path.join(d, e.name));
			else n++;
		}
	};
	walk(dir);
	return n;
}

// ---- pine's settings -----------------------------------------------------------------------------

interface Setting {
	about: string;
	/** What a value has to be. */
	kind: "model" | "boolean" | "duration" | { one: string[] } | { from: number; to: number };
	/** What is in force now, in the words the setting is written in. */
	now(cfg: PineConfig): string;
	/** Whether a new value holds at once. Otherwise it is saved and holds from the next start of pine. */
	live: boolean;
	/** What a value gives up, if it gives something up: said to the owner with the question. */
	wider?(value: unknown): string | undefined;
}

const ms = (n: number) => (n % 60_000 === 0 ? `${n / 60_000}m` : n % 1000 === 0 ? `${n / 1000}s` : `${n}ms`);

/**
 * The settings in pine.json that the main agent can change. Not here on purpose: the control
 * API (address, port, token), secrets, and the lists that have tools of their own (sources, MCP
 * servers, skills, schedules, source types, model servers, agents).
 */
export const SETTINGS: Record<string, Setting> = {
	"defaults.model": { about: "The model of every agent that has none of its own, as provider/model.", kind: "model", now: (c) => String(c.defaults.model ?? "none"), live: true },
	"defaults.thinking": { about: "How much an agent reasons before it answers, unless it says otherwise.", kind: { one: THINKING }, now: (c) => c.defaults.thinking, live: true },
	"defaults.mode": {
		about: "The mode of every agent that names none: auto (no sandbox: your whole account and the network; critical actions are checked), safe (in the sandbox: its own folders), manual (in the sandbox, every action waits), bypass (no sandbox, nothing waits), plan (nothing is done). Not set: auto for the main agent, safe for the others.",
		kind: { one: [...MODES] },
		now: (c) => c.defaults.mode ?? "not set (main: auto, others: safe)",
		live: true,
		wider: (v) => (v === "bypass" ? "in bypass mode no agent asks, and every agent's shell reaches your whole account and the network" : v === "auto" ? "every agent that names no mode then works without a sandbox: its shell and file tools reach your whole account and the network" : undefined),
	},
	"defaults.bashTimeoutSec": { about: "Seconds after which a shell command is ended.", kind: { from: 5, to: 86_400 }, now: (c) => String(c.defaults.bashTimeoutSec), live: false },
	"defaults.taskTimeoutSec": { about: "Seconds after which a task is ended.", kind: { from: 30, to: 604_800 }, now: (c) => String(c.defaults.taskTimeoutSec), live: false },
	"limits.maxConcurrentRuns": { about: "How many agents work at the same time. On one local model, more than it can serve side by side only makes each slower.", kind: { from: 1, to: 64 }, now: (c) => String(c.limits.maxConcurrentRuns), live: false },
	"limits.maxDelegationDepth": { about: "How many times a task can be handed on from agent to agent.", kind: { from: 0, to: 10 }, now: (c) => String(c.limits.maxDelegationDepth), live: true },
	"limits.maxDownloadMb": { about: "The largest file the download tool fetches, in megabytes.", kind: { from: 1, to: 100_000 }, now: (c) => String(c.limits.maxDownloadMb), live: true },
	"defaults.judge": { about: "The model that judges whether a goal is met, as provider/model. Not set: the agent's own.", kind: "model", now: (c) => c.defaults.judge ?? "not set (the agent's own model)", live: true },
	"security.askAccess": { about: "Whether pine asks your owner itself when a call of an agent needs a file or folder outside its sandbox, or the network.", kind: "boolean", now: (c) => String(c.security.askAccess), live: true },
	"security.approvalTimeout": { about: "How long a question to your owner waits before it counts as not answered, for example 5m.", kind: "duration", now: (c) => ms(c.security.approvalTimeoutMs), live: false },
	"security.taint": {
		about: "How long a conversation counts as having read outside content: session (until it is reset), run (for that one task), off (never).",
		kind: { one: ["session", "run", "off"] },
		now: (c) => c.security.taint,
		live: true,
		wider: (v) => (v === "off" ? "with off, outside content is never marked, and nothing that depends on the mark protects you" : v === "run" ? "with run, the mark is gone with the next message although what was read is still in the conversation" : undefined),
	},
	"security.bypassWhenTainted": {
		about: "Whether bypass mode stays in force in a conversation that has read outside content.",
		kind: "boolean",
		now: (c) => String(c.security.bypassWhenTainted),
		live: true,
		wider: (v) => (v === true ? "an agent in bypass mode then acts without any question on whatever a web page or a message told it" : undefined),
	},
};

const kindText = (k: Setting["kind"]) => (k === "model" ? "a model, as provider/model" : k === "boolean" ? "true or false" : k === "duration" ? "a time such as 90s or 5m" : "one" in k ? k.one.join(", ") : `a number from ${k.from} to ${k.to}`);

/** The settings as a list for the agent: name, what is in force, what it is. */
export function settingsText(cfg: PineConfig): string {
	return Object.entries(SETTINGS)
		.map(([key, s]) => `${key} = ${s.now(cfg)}\n    ${s.about} Value: ${kindText(s.kind)}.${s.live ? "" : " A change holds from the next start of pine."}`)
		.join("\n");
}

/** Check a value for a setting. "default" (or nothing) means: take the entry out, so that pine's default holds. */
export function checkSetting(cfg: PineConfig, key: string, given: unknown, models: string[]): { key: string; setting: Setting; value: unknown; text: string; wider?: string } {
	const setting = SETTINGS[key];
	if (!setting) throw new Error(`there is no setting "${key}" that you can change. The settings tool lists them: ${Object.keys(SETTINGS).join(", ")}. What an agent has (sources, MCP servers, skills, schedules) and the agents themselves are changed with their own tools.`);
	const raw = typeof given === "string" ? given.trim() : given;
	if (raw === undefined || raw === null || raw === "" || raw === "default") return { key, setting, value: undefined, text: "pine's default" };
	const k = setting.kind;
	let value: unknown;
	if (k === "model") {
		if (!models.includes(String(raw))) throw new Error(`there is no model "${raw}". Models: ${models.slice(0, 40).join(", ")}`);
		value = String(raw);
	} else if (k === "boolean") {
		if (raw !== true && raw !== false && raw !== "true" && raw !== "false") throw new Error(`${key} is true or false`);
		value = raw === true || raw === "true";
	} else if (k === "duration") {
		let n = Number.NaN;
		try {
			n = parseDuration(String(raw));
		} catch {
			// said below
		}
		if (!(n >= 1000)) throw new Error(`${key} is a time of at least a second, for example 90s or 5m`);
		value = String(raw);
	} else if ("one" in k) {
		if (!k.one.includes(String(raw))) throw new Error(`${key} is one of: ${k.one.join(", ")}`);
		value = String(raw);
	} else {
		const n = Number(raw);
		if (!Number.isInteger(n) || n < k.from || n > k.to) throw new Error(`${key} is a whole number from ${k.from} to ${k.to}`);
		value = n;
	}
	return { key, setting, value, text: String(value), wider: setting.wider?.(value) };
}

/**
 * Write a checked setting into pine.json and take it over. The file is read back through the
 * loader; if the configuration does not load, the file is as it was.
 */
export function applySetting(cfg: PineConfig, checked: { key: string; setting: Setting; value: unknown }): void {
	const file = path.join(cfg.home, "pine.json");
	const before = fs.readFileSync(file, "utf8");
	const [section, name] = checked.key.split(".");
	let fresh: PineConfig;
	try {
		editJson(file, (raw) => {
			raw[section] = typeof raw[section] === "object" && raw[section] ? raw[section] : {};
			if (checked.value === undefined) delete raw[section][name];
			else raw[section][name] = checked.value;
		});
		fresh = loadConfig(cfg.home);
	} catch (e) {
		fs.writeFileSync(file, before);
		throw new Error(`not changed: ${errText(e)}`);
	}
	if (!checked.setting.live) return;
	Object.assign(cfg.defaults, fresh.defaults);
	Object.assign(cfg.limits, fresh.limits);
	// What a question to the owner waits is read once at the start: it keeps its value until then.
	Object.assign(cfg.security, { ...fresh.security, approvalTimeoutMs: cfg.security.approvalTimeoutMs });
	// What an agent takes from the defaults when it does not say.
	if (checked.key === "defaults.thinking") for (const a of Object.values(cfg.agents)) a.thinking = fresh.agents[a.id]?.thinking ?? a.thinking;
	if (checked.key === "defaults.mode") for (const a of Object.values(cfg.agents)) Object.assign(a, { mode: fresh.agents[a.id]?.mode ?? a.mode, level: fresh.agents[a.id]?.level ?? a.level, modeSet: fresh.agents[a.id]?.modeSet ?? a.modeSet });
}
