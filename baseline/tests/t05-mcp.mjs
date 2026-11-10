import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createCodemodeExtension, createMcpExtension, createToolSearchExtension } from "@earendil-works/pi-coding-agent";
import { check, HERE, makeEnv, mkdir, newSession, saveResults, sleep, systemOf, toolNames, write } from "./lib.mjs";
import { mockMsg, textOf } from "./mock.mjs";

const SERVER = path.join(HERE, "mcp-stdio-server.mjs");
const stdio = (extra = {}, env = {}) => ({ command: process.execPath, args: [SERVER], env: { MCP_LABEL: "test", ...env }, ...extra });
const mcpLoader = (more = []) => ({ extensionFactories: [createCodemodeExtension({ mode: "on" }), createToolSearchExtension(), createMcpExtension(), ...more] });
const lastToolMsgs = (mock) => mock.state.requests.at(-1).body.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
// The built-in MCP extension reads mcp.json from the global agent dir only (see M0b), so sessions
// with their own agentDir register the servers from <agentDir>/mcp.json through the public API.
const registerFrom = (env) => (pi) => {
	const file = path.join(env.agentDir, "mcp.json");
	if (!fs.existsSync(file)) return;
	for (const [name, cfg] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers ?? {})) pi.registerMcpServer(name, cfg);
};
async function mcpSession(env, opts = {}) {
	const s = await newSession(env, { ...opts, loader: { ...mcpLoader([registerFrom(env), ...(opts.extra ?? [])]), ...(opts.loader ?? {}) } });
	await s.session.bindExtensions({});
	return s;
}

await check("M0", "Without the MCP extension, does an SDK session see mcp.json at all?", async (note) => {
	const env = await makeEnv("mcp0", { mcp: { mcpServers: { test: stdio({ exposure: "direct" }) } } });
	const s = await newSession(env);
	await s.session.prompt("probe");
	note("tools declared", toolNames(env.mock.state.requests[0]));
	s.session.dispose();
	await env.mock.close();
	return toolNames(env.mock.state.requests[0]).some((n) => n.startsWith("mcp__")) ? "loaded" : "not loaded — MCP is opt-in for SDK sessions";
});

await check("M0b", "Which mcp.json does the MCP extension read in an SDK session: the session's agentDir, the global agent dir, or the project?", async (note) => {
	const { DECOY } = await import("./lib.mjs");
	const env = await makeEnv("mcp0b", { mcp: { mcpServers: { fromsessiondir: stdio({ exposure: "direct" }) } } });
	write(path.join(DECOY, "mcp.json"), JSON.stringify({ mcpServers: { fromglobaldir: stdio({ exposure: "direct" }) } }));
	const cwd = mkdir("mcp0b", "repo");
	write(path.join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { fromproject: stdio({ exposure: "direct" }) } }));
	const s = await newSession(env, { cwd, loader: mcpLoader() });
	await s.session.bindExtensions({});
	await s.session.prompt("probe");
	const servers = [...new Set(toolNames(env.mock.state.requests[0]).filter((n) => n.startsWith("mcp__")).map((n) => n.split("__")[1]))];
	note("servers whose tools were declared", servers);
	s.session.dispose();
	fs.rmSync(path.join(DECOY, "mcp.json"));
	await env.mock.close();
	return servers.includes("fromsessiondir") ? "session agentDir honoured" : "session agentDir IGNORED for mcp.json";
});

await check("M1", "stdio MCP server with direct exposure: declared, callable, result returned?", async (note) => {
	const env = await makeEnv("mcp1", { mcp: { mcpServers: { test: stdio({ exposure: "direct" }) } } });
	const s = await mcpSession(env);
	const t0 = Date.now();
	await s.session.prompt(mockMsg([{ tools: [{ name: "mcp__test__echo", args: { text: "hello mcp" } }, { name: "mcp__test__big", args: {} }] }]));
	note("first prompt ms (includes server connect)", Date.now() - t0);
	note("tools declared", toolNames(env.mock.state.requests[0]));
	note("mcp tool schema sent", env.mock.state.requests[0].body.tools.find((t) => t.function.name === "mcp__test__echo")?.function);
	const res = lastToolMsgs(env.mock);
	note("echo result", res[0]);
	note("60 KB result reaches model as chars", res[1]?.length);
	note("60 KB result tail", res[1]?.slice(-160));
	s.session.dispose();
	await env.mock.close();
	return res[0]?.includes("echo(test): hello mcp") ? "works" : "FAILED";
});

await check("M2", "Default (codemode) exposure: what is declared, and can a script call the MCP tool?", async (note) => {
	const env = await makeEnv("mcp2", { mcp: { mcpServers: { test: stdio() } } });
	const s = await mcpSession(env);
	await s.session.prompt("warm up so servers connect");
	await sleep(500);
	env.mock.reset();
	const script = `const r = await tools.mcp__test__echo({ text: "from script" });\nconst who = await tools.mcp__test__whoami({});\nreturn { echo: r.content[0].text, who: JSON.parse(who.content[0].text).label };`;
	const declared = () => env.mock.state.requests[0].body.tools;
	await s.session.prompt(mockMsg([{ tools: [{ name: "codemode", args: { code: script } }] }]));
	note("tools declared", declared().map((t) => t.function?.name ?? t.name ?? t.type));
	note("codemode declaration", JSON.stringify(declared().find((t) => (t.function?.name ?? t.name) === "codemode")).slice(0, 420));
	note("mcp section in system prompt", (systemOf(env.mock.state.requests[0]).match(/<mcp_servers>[\s\S]*?<\/mcp_servers>/) ?? ["(none)"])[0].slice(0, 300));
	note("codemode({code}) result", lastToolMsgs(env.mock)[0]?.slice(0, 300));
	env.mock.reset();
	await s.session.prompt(mockMsg([{ tools: [{ name: "codemode", rawArgs: script }] }]));
	note("codemode(raw JS as arguments) result", lastToolMsgs(env.mock)[0]?.slice(0, 300));
	s.session.dispose();
	await env.mock.close();
	return "measured";
});

await check("M3", "Deferred exposure: does tool_search load the tool for the next model call?", async (note) => {
	const env = await makeEnv("mcp3", { mcp: { mcpServers: { test: stdio({ exposure: "deferred" }) } } });
	const s = await mcpSession(env);
	await s.session.prompt("warm up");
	await sleep(500);
	env.mock.reset();
	await s.session.prompt(mockMsg([{ tools: [{ name: "tool_search", args: { query: "echo text back" } }] }, { tools: [{ name: "mcp__test__echo", args: { text: "after search" } }] }]));
	note("declared before search", toolNames(env.mock.state.requests[0]));
	note("tool_search schema", env.mock.state.requests[0].body.tools.find((t) => t.function?.name === "tool_search")?.function.parameters);
	note("tool_search result", env.mock.state.requests[1].body.messages.at(-1).content?.slice?.(0, 300));
	note("declared after search", toolNames(env.mock.state.requests[1]));
	note("call result", lastToolMsgs(env.mock).at(-1));
	s.session.dispose();
	await env.mock.close();
	return lastToolMsgs(env.mock).at(-1)?.includes("after search") ? "works" : "FAILED";
});

await check("M4", "Per-agent MCP servers: separate processes per session, own cwd/env, killed on dispose?", async (note) => {
	const env = await makeEnv("mcp4");
	const pidFile = path.join(mkdir("mcp4"), "pids.txt");
	const reg = (label) => (pi) => pi.registerMcpServer("own", stdio({ exposure: "direct" }, { MCP_LABEL: label, MCP_SECRET: `secret-${label}`, MCP_PID_FILE: pidFile }));
	const a = await mcpSession(env, { cwd: mkdir("mcp4", "gonzo"), extra: [reg("gonzo")] });
	const b = await mcpSession(env, { cwd: mkdir("mcp4", "kevin"), extra: [reg("kevin")] });
	await a.session.prompt(mockMsg([{ tools: [{ name: "mcp__own__whoami", args: {} }] }]));
	const whoA = JSON.parse(a.session.getLastAssistantText().replace("FINAL:: ", ""));
	await b.session.prompt(mockMsg([{ tools: [{ name: "mcp__own__whoami", args: {} }] }]));
	const whoB = JSON.parse(b.session.getLastAssistantText().replace("FINAL:: ", ""));
	note("session gonzo sees", { ...whoA, cwdIsSessionCwd: whoA.cwd === a.cwd });
	note("session kevin sees", { ...whoB, cwdIsSessionCwd: whoB.cwd === b.cwd });
	note("server processes started", fs.readFileSync(pidFile, "utf8").trim().split("\n").length);
	a.session.dispose();
	await sleep(1500);
	note("after dispose(gonzo): gonzo server alive / kevin server alive", [alive(whoA.pid), alive(whoB.pid)]);
	b.session.dispose();
	await sleep(1500);
	note("after dispose(kevin): kevin server alive", alive(whoB.pid));
	const leaked = [whoA.pid, whoB.pid].filter(alive);
	for (const p of leaked) process.kill(p, "SIGKILL");
	await env.mock.close();
	return whoA.pid !== whoB.pid && whoA.label === "gonzo" && whoB.label === "kevin" ? (leaked.length ? "isolated, but SERVER PROCESS LEAKS after dispose" : "isolated and cleaned up") : "FAILED";
});

await check("M5", "What happens when an MCP server crashes mid-session?", async (note) => {
	const env = await makeEnv("mcp5", { mcp: { mcpServers: { test: stdio({ exposure: "direct" }) } } });
	const s = await mcpSession(env);
	await s.session.prompt(mockMsg([{ tools: [{ name: "mcp__test__crash", args: {} }] }]));
	note("result of the crashing call", lastToolMsgs(env.mock)[0]?.slice(0, 200));
	await s.session.prompt(mockMsg([{ tools: [{ name: "mcp__test__echo", args: { text: "after crash" } }] }]));
	note("next call after crash", lastToolMsgs(env.mock).at(-1)?.slice(0, 200));
	note("tools still declared", toolNames(env.mock.state.requests.at(-1)).filter((n) => n.startsWith("mcp__")));
	s.session.dispose();
	await env.mock.close();
	return lastToolMsgs(env.mock).at(-1)?.includes("after crash") ? "reconnects on next call" : "does not recover";
});

await check("M6", "Streamable HTTP MCP server (remote style) with direct exposure?", async (note) => {
	const calls = [];
	const srv = http.createServer(async (req, res) => {
		if (req.method !== "POST") return res.writeHead(405).end();
		let raw = "";
		for await (const c of req) raw += c;
		const msg = JSON.parse(raw);
		calls.push({ method: msg.method, auth: req.headers.authorization });
		if (msg.id === undefined) return res.writeHead(202).end();
		const result =
			msg.method === "initialize"
				? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "http-mock", version: "1" } }
				: msg.method === "tools/list"
					? { tools: [{ name: "lookup", description: "Look something up", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] }
					: msg.method === "tools/call"
						? { content: [{ type: "text", text: `http-lookup: ${msg.params.arguments?.q}` }] }
						: {};
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	process.env.MCP_HTTP_TOKEN = "tok-123";
	const env = await makeEnv("mcp6", { mcp: { mcpServers: { remote: { url: `http://127.0.0.1:${srv.address().port}/mcp`, headers: { Authorization: "Bearer ${MCP_HTTP_TOKEN}" }, exposure: "direct" } } } });
	const s = await mcpSession(env);
	await s.session.prompt(mockMsg([{ tools: [{ name: "mcp__remote__lookup", args: { q: "grundbuch" } }] }]));
	note("tools declared", toolNames(env.mock.state.requests[0]).filter((n) => n.startsWith("mcp__")));
	note("result", lastToolMsgs(env.mock)[0]);
	note("server saw methods", calls.map((c) => c.method));
	note("env-interpolated auth header arrived", calls[0]?.auth);
	s.session.dispose();
	srv.closeAllConnections();
	srv.close();
	await env.mock.close();
	return lastToolMsgs(env.mock)[0]?.includes("http-lookup: grundbuch") ? "works" : "FAILED";
});

await check("M7", "Slow or broken MCP servers: how long does the first prompt wait, and is the session still usable?", async (note) => {
	const env = await makeEnv("mcp7", {
		mcp: { mcpServers: { slow: stdio({ exposure: "direct" }, { MCP_START_DELAY_MS: "3000", MCP_LABEL: "slow" }), broken: { command: "/nonexistent/binary", args: [], exposure: "direct" }, fine: stdio({ exposure: "direct" }, { MCP_LABEL: "fine" }) } },
	});
	const s = await mcpSession(env);
	const t0 = Date.now();
	await s.session.prompt("first prompt");
	note("first prompt ms", Date.now() - t0);
	note("mcp tools declared on first prompt", [...new Set(toolNames(env.mock.state.requests[0]).filter((n) => n.startsWith("mcp__")).map((n) => n.split("__")[1]))]);
	note("answer", s.session.getLastAssistantText());
	s.session.dispose();
	await env.mock.close();
	return "measured";
});

await check("M8", "Do tool_call gates see MCP calls, including calls made from inside a codemode script?", async (note) => {
	const env = await makeEnv("mcp8", { mcp: { mcpServers: { test: stdio() } } });
	const seen = [];
	const gate = (pi) =>
		pi.on("tool_call", async (event) => {
			seen.push(event.toolName);
			if (event.toolName === "mcp__test__crash") return { block: true, reason: "destructive MCP tool blocked" };
		});
	const s = await mcpSession(env, { extra: [gate] });
	await s.session.prompt("warm up");
	await sleep(500);
	await s.session.prompt(mockMsg([{ tools: [{ name: "codemode", args: { code: `const a = await tools.mcp__test__echo({text:"ok"});\ntry { await tools.mcp__test__crash({}); return "CRASH WENT THROUGH"; } catch (e) { return "blocked: " + e.message; }` } }] }]));
	note("gate saw tool calls", seen);
	note("script result", lastToolMsgs(env.mock)[0]?.slice(0, 240));
	s.session.dispose();
	await env.mock.close();
	return seen.includes("mcp__test__crash") ? "gates apply inside scripts" : "SCRIPT CALLS BYPASS THE GATE";
});

saveResults("t05.json");
process.exit(0);
