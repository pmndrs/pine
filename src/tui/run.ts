import fs from "node:fs";
import path from "node:path";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { loadConfig, type PineConfig } from "../config.ts";
import { findServer, listServers, piMcp, serverStates } from "../mcp-config.ts";
import { PineTui } from "./app.ts";
import { Client } from "./client.ts";

const reachable = async (url: string) => {
	try {
		return (await fetch(url, { signal: AbortSignal.timeout(800) })).ok;
	} catch {
		return false;
	}
};

/**
 * Open the terminal UI. It attaches to a running daemon; if none answers, it starts one inside
 * this process (logging to data/pine.log) and stops it again on exit.
 */
export async function runTui(cfg: PineConfig): Promise<void> {
	if (!cfg.http) throw new Error("the terminal UI needs the control API; remove \"http\": false from pine.json");
	if (!process.stdout.isTTY || !process.stdin.isTTY) throw new Error("the terminal UI needs an interactive terminal");
	const base = `http://${cfg.http.host === "0.0.0.0" ? "127.0.0.1" : cfg.http.host}:${cfg.http.port}`;
	const cleanup: Array<() => Promise<void> | void> = [];
	let token: string;
	let mode = "attached";

	if (await reachable(`${base}/health`)) {
		const tokenFile = path.join(cfg.dataDir, "http-token");
		token = cfg.http.token ?? fs.readFileSync(tokenFile, "utf8").trim();
	} else {
		// A provider called "dev" is the claude -p stand-in; bring it up too if nothing serves it.
		try {
			const models = JSON.parse(fs.readFileSync(path.join(cfg.home, "models.json"), "utf8"));
			const dev = models.providers?.dev?.baseUrl as string | undefined;
			const uses = [cfg.defaults.model, ...Object.values(cfg.agents).map((a) => a.model)].some((m) => m?.startsWith("dev/"));
			if (dev && uses && !(await reachable(`${dev}/models`))) {
				const { startClaudeModel } = await import("../dev/claude-model.ts");
				const server = await startClaudeModel({ port: Number(new URL(dev).port) });
				cleanup.push(() => server.close());
				mode = "embedded daemon + claude -p";
			}
		} catch {
			// No models.json or no dev provider: nothing to start.
		}
		const { startPine } = await import("../pine.ts");
		const pine = await startPine({ config: cfg, logFile: path.join(cfg.dataDir, "pine.log") });
		cleanup.push(() => pine.stop());
		token = pine.token;
		if (mode === "attached") mode = "embedded daemon";
	}

	const done = Promise.withResolvers<void>();
	const app = new PineTui({
		client: new Client(base, token),
		terminal: new ProcessTerminal(),
		mode,
		mcp: {
			// Read the files again each time: the daemon may have added a server since this UI started.
			list: async (states = true) => {
				const now = loadConfig(cfg.home);
				if (!states) return listServers(now).map((s) => ({ ...s, state: s.enabled ? undefined : "disabled" }));
				const found = await serverStates(now);
				return listServers(now).map((s) => ({ ...s, state: s.enabled ? (found[s.name] ?? (s.remote ? "unknown" : "local")) : "disabled" }));
			},
			login: async (name, onOutput) => {
				const now = loadConfig(cfg.home);
				const server = findServer(now, name);
				if (!server?.url) return onOutput(server ? `"${name}" is a local server and has no sign-in` : `no server "${name}"`), 1;
				return (await piMcp(now, { [name]: server }, ["login", name], { capture: true, onOutput })).code;
			},
		},
		onQuit: async () => {
			for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch(() => {});
			done.resolve();
		},
	});
	process.on("SIGTERM", () => void app.stop());
	try {
		await app.start();
	} catch (e) {
		await app.stop();
		throw e;
	}
	await done.promise;
	process.exit(0);
}
