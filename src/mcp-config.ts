import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type McpServerConfig, mcpTaints, type PineConfig, toPiMcp } from "./config.ts";

/** Change a JSON configuration file in place, keeping what is not touched (including ${NAME} placeholders). */
export function editJson(file: string, change: (json: any) => void): void {
	const json = JSON.parse(fs.readFileSync(file, "utf8"));
	change(json);
	const mode = fs.statSync(file).mode & 0o777;
	fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, { mode });
}

const fileFor = (cfg: PineConfig, agentId?: string) => (agentId ? path.join(cfg.agents[agentId].dir, "agent.json") : path.join(cfg.home, "pine.json"));

export function validateServer(cfg: PineConfig, name: string, server: McpServerConfig, agentId?: string): void {
	if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) throw new Error(`"${name}" is not a usable server name (letters, digits, - and _)`);
	if (agentId && !cfg.agents[agentId]) throw new Error(`unknown agent "${agentId}"`);
	if (!server.url && !server.command && !server.pine) throw new Error("an MCP server needs a url, a command, or the name of a bundled server");
	if (server.url) {
		let url: URL;
		try {
			url = new URL(server.url);
		} catch {
			throw new Error(`"${server.url}" is not a valid URL`);
		}
		if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("a remote MCP server must use https");
	}
}

/**
 * Add or replace an MCP server: in pine.json for everyone, or in one agent's agent.json. The file
 * and the loaded configuration are both updated; sessions pick the server up when they next start.
 */
export function addServer(cfg: PineConfig, name: string, server: McpServerConfig, agentId?: string): void {
	validateServer(cfg, name, server, agentId);
	editJson(fileFor(cfg, agentId), (json) => {
		json.mcp ??= {};
		json.mcp[name] = server;
	});
	(agentId ? cfg.agents[agentId].mcp : cfg.mcp)[name] = server;
}

export function removeServer(cfg: PineConfig, name: string, agentId?: string): boolean {
	const target = agentId ? cfg.agents[agentId]?.mcp : cfg.mcp;
	if (!target || !(name in target)) return false;
	editJson(fileFor(cfg, agentId), (json) => {
		delete json.mcp?.[name];
		// Nothing is left behind: an empty list of servers is no entry at all.
		if (json.mcp && !Object.keys(json.mcp).length) delete json.mcp;
	});
	delete target[name];
	return true;
}

export interface ServerInfo {
	name: string;
	/** "global", or the id of the agent that owns it. */
	scope: string;
	/** Agents that end up with it. */
	agents: string[];
	target: string;
	remote: boolean;
	taints: boolean;
	approve: string;
	enabled: boolean;
}

export function listServers(cfg: PineConfig): ServerInfo[] {
	const describe = (s: McpServerConfig) => s.url ?? (s.pine ? `bundled: ${s.pine}` : [s.command, ...(s.args ?? [])].join(" "));
	const out: ServerInfo[] = [];
	for (const [name, s] of Object.entries(cfg.mcp)) {
		const agents = Object.values(cfg.agents).filter((a) => {
			if (name in a.mcp) return false;
			const scope = s.agents ?? ["*"];
			return a.globalMcp === true ? scope.includes("*") || scope.includes(a.id) : Array.isArray(a.globalMcp) && a.globalMcp.includes(name);
		});
		out.push({ name, scope: "global", agents: agents.map((a) => a.id), target: describe(s), remote: Boolean(s.url), taints: mcpTaints(s), approve: s.approve ?? "never", enabled: s.enabled !== false });
	}
	for (const a of Object.values(cfg.agents)) for (const [name, s] of Object.entries(a.mcp)) out.push({ name, scope: a.id, agents: [a.id], target: describe(s), remote: Boolean(s.url), taints: mcpTaints(s), approve: s.approve ?? "never", enabled: s.enabled !== false });
	return out;
}

export function findServer(cfg: PineConfig, name: string, agentId?: string): McpServerConfig | undefined {
	if (agentId) return cfg.agents[agentId]?.mcp[name];
	return cfg.mcp[name] ?? Object.values(cfg.agents).map((a) => a.mcp[name]).find(Boolean);
}

/**
 * Run pi's own `mcp` command (list, login, logout) for the given servers. pi keeps OAuth tokens per
 * server name and URL in its agent folder; pine points that folder at data/pi, which is where the
 * daemon's sessions look too. The servers are written to a temporary mcp.json there, because the
 * command only knows that file. The daemon's sessions never read that file (see createMcpExtension
 * in agents.ts), so it cannot hand a server to an agent that is not meant to have it.
 */
export function piMcp(cfg: PineConfig, servers: Record<string, McpServerConfig>, args: string[], opts: { capture?: boolean; onOutput?: (text: string) => void } = {}): Promise<{ code: number; out: string }> {
	const dir = path.join(cfg.dataDir, "pi");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, "mcp.json");
	const mcpServers = Object.fromEntries(Object.entries(servers).map(([name, s]) => [name, toPiMcp(name, s)]));
	fs.writeFileSync(file, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
	const cli = path.join(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle", "cli.js");
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [cli, "mcp", ...args], {
			cwd: dir,
			env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
			stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
		});
		let out = "";
		const take = (d: Buffer) => {
			out += d;
			opts.onOutput?.(d.toString("utf8"));
		};
		child.stdout?.on("data", take);
		child.stderr?.on("data", take);
		const done = (code: number) => {
			fs.rmSync(file, { force: true });
			resolve({ code, out });
		};
		child.on("error", (e) => ((out += e.message), done(1)));
		child.on("close", (code) => done(code ?? 1));
	});
}

/** Connection state of every configured server, as pi reports it ("connected", "needs sign-in", an error). */
export async function serverStates(cfg: PineConfig): Promise<Record<string, string>> {
	const all: Record<string, McpServerConfig> = {};
	for (const a of Object.values(cfg.agents)) Object.assign(all, a.mcp);
	Object.assign(all, cfg.mcp);
	const enabled = Object.fromEntries(Object.entries(all).filter(([, s]) => s.enabled !== false));
	if (!Object.keys(enabled).length) return {};
	const { out } = await piMcp(cfg, enabled, ["list"], { capture: true });
	const states: Record<string, string> = {};
	for (const line of out.split("\n")) {
		const m = line.match(/^([A-Za-z0-9_-]+): (.+?)(?: \([^)]*\))?$/);
		if (m && m[1] in enabled) states[m[1]] = m[2];
	}
	return states;
}
