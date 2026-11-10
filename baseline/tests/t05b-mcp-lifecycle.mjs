import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, createMcpExtension, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { check, HERE, makeEnv, mkdir, saveResults, sleep } from "./lib.mjs";
import { mockMsg } from "./mock.mjs";

const SERVER = path.join(HERE, "mcp-stdio-server.mjs");
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

await check("M4b", "Does AgentSessionRuntime.dispose() stop a session's MCP server processes (plain session.dispose() does not)?", async (note) => {
	const env = await makeEnv("mcp4b");
	const cwd = mkdir("mcp4b", "repo");
	const reg = (pi) => pi.registerMcpServer("own", { command: process.execPath, args: [SERVER], exposure: "direct", env: { MCP_LABEL: "rt" } });
	const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: env.agentDir,
			modelRuntime: env.modelRuntime,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
			resourceLoaderOptions: { extensionFactories: [createMcpExtension(), reg] },
		});
		return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: env.model, thinkingLevel: "off" })), services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir: env.agentDir, sessionManager: SessionManager.inMemory(cwd) });
	await runtime.session.bindExtensions({});
	await runtime.session.prompt(mockMsg([{ tools: [{ name: "mcp__own__whoami", args: {} }] }]));
	const who = JSON.parse(runtime.session.getLastAssistantText().replace("FINAL:: ", ""));
	note("server pid alive before dispose", alive(who.pid));
	const t0 = Date.now();
	await runtime.dispose();
	note("runtime.dispose() ms", Date.now() - t0);
	await sleep(500);
	note("server pid alive after runtime.dispose()", alive(who.pid));
	const leaked = alive(who.pid);
	if (leaked) process.kill(who.pid, "SIGKILL");
	await env.mock.close();
	return leaked ? "STILL LEAKS" : "cleaned up";
});

await check("M4c", "If the host process dies, do stdio MCP servers die with it?", async (note) => {
	const dir = mkdir("mcp4c");
	const pidFile = path.join(dir, "pids.txt");
	const child = path.join(dir, "host.mjs");
	fs.writeFileSync(
		child,
		`import { spawn } from "node:child_process";
const p = spawn(process.execPath, [${JSON.stringify(SERVER)}], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, MCP_PID_FILE: ${JSON.stringify(pidFile)} } });
p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\\n");
setTimeout(() => process.kill(process.pid, "SIGKILL"), 400);`,
	);
	const host = spawn(process.execPath, [child], { stdio: "ignore" });
	await new Promise((r) => host.on("exit", r));
	await sleep(800);
	const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
	note("server alive after host SIGKILL", alive(pid));
	const a = alive(pid);
	if (a) process.kill(pid, "SIGKILL");
	return a ? "orphaned" : "exits when stdin closes (server-dependent)";
});

saveResults("t05b.json");
process.exit(0);
