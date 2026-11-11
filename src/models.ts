import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PineConfig } from "./config.ts";
import { setEnv, unsetEnv } from "./env-file.ts";
import { errText } from "./util.ts";

// models.json is pi's file, and pi fills a "$NAME" in it from the process environment. pine's
// secrets are in .env and are kept out of that environment on purpose (agent shells and MCP
// servers would inherit them). So a provider's API key that names an .env entry is filled in
// here and handed to pi as a key it holds in memory: it is in no file and in no environment.

/** pi's form for a value: "$NAME" or "${NAME}" is a variable, "$$" a dollar sign, "$!" an exclamation mark. */
const REF = /\$(?:([$!])|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

const namesIn = (value: string): string[] => [...new Set([...value.matchAll(REF)].map((m) => m[2] ?? m[3]).filter(Boolean))];

function read<T>(make: () => T, otherwise: T): T {
	try {
		return make();
	} catch {
		return otherwise;
	}
}

/**
 * The API keys that models.json takes from pine's .env file, by provider, and what is wrong:
 * a name that is nowhere, or a header that names an .env entry (pi reads headers itself, so
 * only `apiKey` can).
 */
export function modelKeys(home: string): { keys: Record<string, string>; problems: string[] } {
	const keys: Record<string, string> = {};
	const problems: string[] = [];
	// A missing or broken models.json is reported where pi loads it.
	const providers = read(() => JSON.parse(fs.readFileSync(path.join(home, "models.json"), "utf8")).providers, undefined) ?? {};
	const envFile = path.join(home, ".env");
	const fileEnv = read(() => parseEnv(fs.readFileSync(envFile, "utf8")) as Record<string, string>, {});
	const known = (name: string) => fileEnv[name] || process.env[name] || undefined;

	for (const [id, provider] of Object.entries<any>(providers)) {
		for (const [header, value] of Object.entries<unknown>(provider?.headers ?? {})) {
			const named = typeof value === "string" && !value.startsWith("!") ? namesIn(value).filter((name) => fileEnv[name] && !process.env[name]) : [];
			if (named.length) problems.push(`models.json: provider "${id}", header "${header}" names ${named.join(", ")} from .env. Only "apiKey" is filled in from .env`);
		}
		const raw = provider?.apiKey;
		// "!command" is a program pi runs, and a key without a name in it is the key itself.
		if (typeof raw !== "string" || raw.startsWith("!")) continue;
		const names = namesIn(raw);
		if (!names.length) continue;
		const missing = names.filter((name) => !known(name));
		if (missing.length) {
			problems.push(`models.json: provider "${id}" takes its key from ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not in ${envFile}. Its models are not available until you add ${missing.length === 1 ? "a line" : "lines"} ${missing.map((name) => `${name}=...`).join(", ")} there`);
			continue;
		}
		// pi fills in what the environment alone answers.
		if (!names.some((name) => fileEnv[name])) continue;
		keys[id] = raw.replace(REF, (_all, escaped, braced, bare) => escaped ?? known(braced ?? bare)!);
	}
	return { keys, problems };
}

/**
 * Where the model servers of models.json are. The daemon gives requests to these their own
 * timeouts (pi has none for a stream that goes quiet), so one that is added later is put here
 * before the first request to it.
 */
export const modelOrigins = new Set<string>();

function noteOrigins(home: string): void {
	const providers = read(() => JSON.parse(fs.readFileSync(path.join(home, "models.json"), "utf8")).providers, undefined) ?? {};
	for (const p of Object.values<any>(providers)) {
		const origin = typeof p?.baseUrl === "string" ? read(() => new URL(p.baseUrl).origin, undefined) : undefined;
		if (origin) modelOrigins.add(origin);
	}
}

/** pi's model runtime on pine's home, with the keys from .env in place. */
export async function modelRuntime(home: string, warn: (problem: string) => void = () => {}): Promise<ModelRuntime> {
	noteOrigins(home);
	// Loaded here so that commands which only look at the keys (pine check) do not load pi.
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const runtime = await ModelRuntime.create({ authPath: path.join(home, "auth.json"), modelsPath: path.join(home, "models.json") });
	const { keys, problems } = modelKeys(home);
	for (const [provider, key] of Object.entries(keys)) await runtime.setRuntimeApiKey(provider, key);
	for (const problem of problems) warn(problem);
	return runtime;
}

// Model servers of the owner's own (llama.cpp, vLLM, LM Studio, anything that speaks OpenAI's
// chat API): added and removed by command or by the main agent's tool, never by editing
// models.json. What can be asked of the server is asked of it: which models it has, how much
// context each gets, whether it reads pictures.

export interface ServerModel {
	id: string;
	/** Tokens of context one request gets, where the server says. */
	contextWindow?: number;
	images: boolean;
	reasoning: boolean;
	/**
	 * For a model that thinks, on a server that says so (llama.cpp): the levels of effort its chat
	 * template tells apart, lowest first. Its own default is not among them.
	 */
	efforts?: string[];
}

/** What a server answered: its models, or that it wants a key first. */
export type Look = { locked: true } | { locked: false; models: ServerModel[] };

const MODEL_ID = /^[A-Za-z0-9._:@/+=,()[\]-]{1,160}$/;
const SERVER_NAME = /^[a-z][a-z0-9-]{0,30}$/;

/** The name under which a server's key is kept in .env. */
export const modelKeyName = (name: string) => `PINE_MODEL_${name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_API_KEY`;

/** The address as it goes into models.json: http or https, no sign-in in it, "/v1" where no path is given. */
export function serverUrl(text: string): string {
	const url = read(() => new URL(text.trim()), undefined);
	if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) throw new Error(`"${text}" is not the address of a model server. Give it as http://host:port, for example http://127.0.0.1:8080`);
	if (url.username || url.password) throw new Error("the address must not contain a user name or password; a server's key is asked for separately and kept in .env");
	if (url.search || url.hash) throw new Error("the address must not contain a query or a fragment");
	const pathname = url.pathname.replace(/\/+$/, "");
	return `${url.origin}${pathname || "/v1"}`;
}

export function checkServerName(name: string, taken: readonly string[]): void {
	if (!SERVER_NAME.test(name)) throw new Error(`"${name}" is not a usable name for a model server: lowercase letters, digits and -, starting with a letter (for example studio)`);
	if (taken.includes(name)) throw new Error(`a model provider called "${name}" exists already; pick another name`);
}

/** The levels of effort a request can name, lowest first. */
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * What is sent for each of pi's thinking levels, for a model whose template knows `efforts`.
 * Without this a level the template does not know is answered with the template's default,
 * which is often its highest, and "off" sends nothing at all, so thinking stays on.
 *  - off: "none", which is how llama.cpp turns thinking off.
 *  - a level the template knows: itself.
 *  - a level it does not know: the next one up that it does (never less than was asked for).
 *  - a level above all it knows is left out: pi lowers xhigh and max to the highest there is,
 *    and "high" goes as it is, to the template's own default.
 */
export function effortMap(efforts: string[]): Record<string, string> {
	const map: Record<string, string> = { off: "none" };
	const known = EFFORTS.filter((level) => efforts.includes(level));
	for (const level of EFFORTS) {
		const next = known.find((k) => EFFORTS.indexOf(k) >= EFFORTS.indexOf(level));
		if (next) map[level] = next;
	}
	return map;
}

const positive = (n: unknown): number | undefined => (typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined);

/**
 * Ask a server what it serves. Nothing follows a redirect: the address the owner agreed to is
 * the only one that gets a request, and the only one that sees the key.
 */
export async function lookAt(baseUrl: string, key?: string): Promise<Look> {
	modelOrigins.add(new URL(baseUrl).origin);
	const get = async (url: string) => {
		try {
			return await fetch(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, redirect: "error", signal: AbortSignal.timeout(10_000) });
		} catch (e) {
			throw new Error(`no model server answers at ${url} (${errText((e as any)?.cause ?? e)})`);
		}
	};
	const res = await get(`${baseUrl}/models`);
	if (res.status === 401 || res.status === 403) return { locked: true };
	const body: any = res.ok ? await res.json().catch(() => undefined) : undefined;
	const list: any[] | undefined = Array.isArray(body?.data) ? body.data : undefined;
	if (!list) throw new Error(`${baseUrl}/models did not answer with a list of models${res.ok ? "" : ` (HTTP ${res.status})`}. A server that speaks OpenAI's API has one there; check the address and its path`);

	// llama.cpp says in /props what one request really gets: the context of a slot, and whether it reads pictures.
	let props: any;
	if (baseUrl.endsWith("/v1") && list.length === 1) {
		const r = await get(`${baseUrl.slice(0, -3)}/props`).catch(() => undefined);
		props = r?.ok ? await r.json().catch(() => undefined) : undefined;
	}
	const models: ServerModel[] = [];
	for (const m of list.slice(0, 100)) {
		// A name is shown to agents and written into the file, so it is a name and nothing else.
		if (typeof m?.id !== "string" || !MODEL_ID.test(m.id)) continue;
		const caps = props?.chat_template_caps;
		const reasoning = caps?.supports_reasoning_effort === true;
		models.push({
			id: m.id,
			contextWindow: positive(props?.default_generation_settings?.n_ctx) ?? positive(m.max_model_len) ?? positive(m.context_length) ?? positive(m.context_window),
			images: props?.modalities?.vision === true || (Array.isArray(m.architecture?.input_modalities) && m.architecture.input_modalities.includes("image")),
			reasoning,
			// Only the names pine knows are kept: what a server says goes into a file.
			...(reasoning ? { efforts: EFFORTS.filter((level) => Array.isArray(caps.reasoning_effort_levels) && caps.reasoning_effort_levels.includes(level)) } : {}),
		});
	}
	if (!models.length) throw new Error(`${baseUrl} lists no model with a usable name${list.length ? ` (it has ${list.length}, named with spaces or other characters; llama-server takes a plain name with --alias)` : ""}`);
	return { locked: false, models };
}

export interface NewServer {
	name: string;
	baseUrl: string;
	/** The server's key. It goes into .env; the file gets its name. */
	key?: string;
	models: ServerModel[];
	/** For models whose context the server does not say. */
	context?: number;
	/** Overrides what the server says about thinking. */
	reasoning?: boolean;
}

const modelsFile = (home: string) => path.join(home, "models.json");

function editModels(home: string, change: (providers: Record<string, any>) => void): void {
	const file = modelsFile(home);
	const json = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
	json.providers ??= {};
	change(json.providers);
	fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, { mode: 0o600 });
}

/** Write a server into models.json, and its key into .env. Returns its models as "provider/id". */
export function addModelServer(home: string, server: NewServer): string[] {
	const unsized = server.models.filter((m) => !m.contextWindow && !server.context).map((m) => m.id);
	if (unsized.length) throw new Error(`the server does not say how much context ${unsized.length === 1 ? `its model ${unsized[0]} gets` : "its models get"}. Give it: the number of tokens one request may use (what the server was started with)`);
	if (server.context !== undefined && !positive(server.context)) throw new Error("the context is a whole number of tokens, for example 65536");
	const entry = {
		name: `${server.name} (${new URL(server.baseUrl).host})`,
		baseUrl: server.baseUrl,
		api: "openai-completions",
		apiKey: server.key ? `$${modelKeyName(server.name)}` : "none",
		models: server.models.map((m) => {
			const contextWindow = server.context ?? m.contextWindow!;
			const reasoning = server.reasoning ?? m.reasoning;
			// Where the server said which levels the model knows, the level chosen in pine is the one it gets.
			const mapped = reasoning && m.efforts !== undefined;
			return {
				id: m.id,
				contextWindow,
				maxTokens: Math.min(8192, Math.floor(contextWindow / 2)),
				input: m.images ? ["text", "image"] : ["text"],
				...(reasoning ? { reasoning: true } : {}),
				...(mapped ? { thinkingLevelMap: effortMap(m.efforts!) } : {}),
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				// What a plain server may reject is not sent.
				compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: reasoning, ...(mapped ? { thinkingFormat: "openai" } : {}), maxTokensField: "max_tokens" },
			};
		}),
	};
	// Checked before anything is written: the key of a server that is there must not be touched.
	const there = read(() => JSON.parse(fs.readFileSync(modelsFile(home), "utf8")).providers, undefined) ?? {};
	if (there[server.name]) throw new Error(`a model provider called "${server.name}" exists already; pick another name`);
	if (server.key) setEnv(home, { [modelKeyName(server.name)]: server.key });
	try {
		editModels(home, (providers) => {
			providers[server.name] = entry;
		});
	} catch (e) {
		if (server.key) unsetEnv(home, [modelKeyName(server.name)]);
		throw e;
	}
	return entry.models.map((m) => `${server.name}/${m.id}`);
}

/** Who has a model of this server set: agents, the default, the reviewer. */
export function modelServerUsers(cfg: PineConfig, name: string): string[] {
	const of = (ref: string | undefined) => typeof ref === "string" && ref.startsWith(`${name}/`);
	return [
		...Object.values(cfg.agents).filter((a) => of(a.model)).map((a) => `agent ${a.id}`),
		...(of(cfg.defaults.model) ? [`the default model (${Object.values(cfg.agents).filter((a) => !a.model).map((a) => a.id).join(", ") || "no agent right now"})`] : []),
		...(of(cfg.security.reviewer) ? ["the reviewer (security.reviewer)"] : []),
	];
}

/** Take a server out of models.json again, with the key pine keeps for it. False when there is none of that name. */
export function removeModelServer(cfg: PineConfig, name: string): boolean {
	const providers = read(() => JSON.parse(fs.readFileSync(modelsFile(cfg.home), "utf8")).providers, undefined) ?? {};
	if (!providers[name]) return false;
	const users = modelServerUsers(cfg, name);
	if (users.length) throw new Error(`"${name}" is in use by ${users.join(", ")}. Give ${users.length === 1 ? "it" : "them"} another model first (/model in the terminal UI)`);
	const key = modelKeyName(name);
	// The key pine put into .env goes too. One the owner named themselves stays.
	const ours = [`$${key}`, `\${${key}}`].includes(providers[name].apiKey);
	editModels(cfg.home, (all) => {
		delete all[name];
	});
	if (ours) unsetEnv(cfg.home, [key]);
	return true;
}

export interface ServerInfo {
	name: string;
	baseUrl: string;
	/** Where its key comes from, in words. */
	key: string;
	models: Array<{ id: string; contextWindow?: number; images: boolean; reasoning: boolean }>;
}

/** The model servers in models.json. */
export function listModelServers(home: string): ServerInfo[] {
	const providers = read(() => JSON.parse(fs.readFileSync(modelsFile(home), "utf8")).providers, undefined) ?? {};
	return Object.entries<any>(providers).filter(([, p]) => typeof p?.baseUrl === "string").map(([name, p]) => {
		const raw = typeof p.apiKey === "string" ? p.apiKey : "";
		const names = raw.startsWith("!") ? [] : namesIn(raw);
		return {
			name,
			baseUrl: p.baseUrl,
			key: raw.startsWith("!") ? "from a command" : names.length ? `${names.join(", ")} in .env` : !raw || raw === "none" ? "none" : "written in models.json",
			models: (Array.isArray(p.models) ? p.models : []).filter((m: any) => typeof m?.id === "string").map((m: any) => ({ id: m.id, contextWindow: positive(m.contextWindow), images: Array.isArray(m.input) && m.input.includes("image"), reasoning: m.reasoning === true })),
		};
	});
}
