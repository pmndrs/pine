if (process.argv.includes("--mode")) {
	// Reached when something re-spawns *this host script* as if it were the pi CLI.
	console.log(JSON.stringify({ type: "WRONG-BINARY", argv: process.argv.slice(2, 8) }));
	process.exit(3);
}
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { defineTool, RpcClient } from "@earendil-works/pi-coding-agent";
import { check, HERE, makeEnv, mkdir, newSession, saveResults, sleep, write } from "./lib.mjs";
import { mockMsg, textOf } from "./mock.mjs";

const run = promisify(execFile);
const PKG = path.join(HERE, "..", "node_modules", "@earendil-works", "pi-coding-agent");
const CLI = path.join(PKG, "dist", "bundle", "cli.js");
const env = await makeEnv("sub");
const childEnv = { ...process.env, PI_CODING_AGENT_DIR: env.agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
const lastToolMsgs = (mock) => mock.state.requests.at(-1).body.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));
const repo = (name) => {
	const cwd = mkdir("sub", "repos", name);
	write(path.join(cwd, "AGENTS.md"), `MARKER-${name.toUpperCase()}\n`);
	return cwd;
};
const rssMB = async (pid) => +(Number((await run("ps", ["-o", "rss=", "-p", String(pid)])).stdout.trim()) / 1024).toFixed(0);

// An in-process "ask another agent" tool: each call runs a fresh child session in that agent's repo.
const children = [];
const delegate = defineTool({
	name: "delegate",
	label: "Delegate",
	description: "Ask another agent",
	parameters: Type.Object({ agent: Type.String(), task: Type.String() }),
	execute: async (_id, params, signal) => {
		const child = await newSession(env, { cwd: repo(params.agent) });
		children.push({ agent: params.agent, child });
		const onAbort = () => child.session.abort();
		signal?.addEventListener("abort", onAbort);
		try {
			await child.session.prompt(params.task);
			return { content: [{ type: "text", text: `[${params.agent}] ${child.session.getLastAssistantText()}` }], details: {} };
		} finally {
			signal?.removeEventListener("abort", onAbort);
			child.session.dispose();
		}
	},
});

await check("SA1", "In-process sub-agent: can a tool run a child session in another repo while the parent run is waiting?", async (note) => {
	env.mock.reset();
	const parent = await newSession(env, { cwd: repo("main"), customTools: [delegate] });
	env.mock.state.scripts.childpwd = [{ tools: [{ name: "bash", args: { command: "pwd" } }] }];
	const childTask = "CHILD-TASK @@REF:childpwd@@";
	await parent.session.prompt(mockMsg([{ tools: [{ name: "delegate", args: { agent: "gonzo", task: childTask } }] }], "PARENT-SECRET-CONTEXT "));
	const reqs = env.mock.state.requests;
	const childReqs = reqs.filter((r) => JSON.stringify(r.body.messages[0]).includes("MARKER-GONZO"));
	const parentReqs = reqs.filter((r) => JSON.stringify(r.body.messages[0]).includes("MARKER-MAIN"));
	note("requests parent/child", [parentReqs.length, childReqs.length]);
	note("child saw parent context", childReqs.some((r) => JSON.stringify(r.body.messages).includes("PARENT-SECRET-CONTEXT")));
	note("child ran in its own repo", parent.session.getLastAssistantText()?.includes(path.join("repos", "gonzo")));
	note("what the parent model got back", lastToolMsgs({ state: { requests: parentReqs } })[0]?.slice(0, 200));
	note("child tools offered", childReqs[0].body.tools.map((t) => t.function.name));
	parent.session.dispose();
	return parentReqs.length === 2 && childReqs.length === 2 ? "works" : "FAILED";
});

await check("SA2", "Do several in-process sub-agents run in parallel, and does aborting the parent stop them?", async (note) => {
	env.mock.reset();
	const parent = await newSession(env, { cwd: repo("main"), customTools: [delegate] });
	const slow = (n) => {
		env.mock.state.scripts[`slow_${n}`] = [{ delayMs: 800, text: `answer from ${n}` }];
		return `@@REF:slow_${n}@@`;
	};
	const t0 = Date.now();
	await parent.session.prompt(mockMsg([{ tools: ["gonzo", "home", "para"].map((a) => ({ name: "delegate", args: { agent: a, task: slow(a) } })) }]));
	note("3 children x 800 ms model delay took ms", Date.now() - t0);
	note("results", lastToolMsgs(env.mock));
	note("peak concurrent model requests", env.mock.state.maxInflight);

	env.mock.reset();
	children.length = 0;
	env.mock.state.scripts.stall = [{ stall: true }];
	const p = parent.session.prompt(mockMsg([{ tools: [{ name: "delegate", args: { agent: "kevin", task: "@@REF:stall@@" } }] }]));
	await sleep(400);
	note("before abort: open model requests", env.mock.state.inflight);
	await parent.session.abort();
	await p;
	await sleep(400);
	note("after parent abort: child request closed on server", env.mock.state.requests.filter((r) => r.aborted).length);
	note("after parent abort: open model requests", env.mock.state.inflight);
	parent.session.dispose();
	return env.mock.state.inflight === 0 ? "parallel, abort propagates (via the tool's signal)" : "CHILD KEEPS RUNNING";
});

await check("SA3", "Does the shipped sub-agent example extension work when loaded into an SDK host?", async (note) => {
	env.mock.reset();
	write(path.join(env.agentDir, "agents", "scout.md"), "---\nname: scout\ndescription: recon\ntools: read, bash\nmodel: mock-model\n---\nYou are a scout. MARKER-SCOUT-PROMPT\n");
	const prevDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = env.agentDir; // the example resolves agents via the global getAgentDir()
	let s;
	try {
		s = await newSession(env, { cwd: repo("main"), loader: { additionalExtensionPaths: [path.join(PKG, "examples", "extensions", "subagent", "index.ts")] } });
		note("extension load errors", s.extensionsResult?.errors?.map((e) => e.error?.slice?.(0, 160) ?? String(e).slice(0, 160)) ?? []);
		await s.session.prompt("probe");
		note("subagent tool declared", env.mock.state.requests[0].body.tools.map((t) => t.function.name));
		env.mock.reset();
		await s.session.prompt(mockMsg([{ tools: [{ name: "subagent", args: { agent: "scout", task: "say hello from the scout" } }] }]));
		note("tool result", lastToolMsgs(env.mock)[0]?.slice(0, 400));
		note("requests seen by model server", env.mock.state.requests.length);
		note("child request had scout prompt", env.mock.state.requests.some((r) => JSON.stringify(r.body.messages[0]).includes("MARKER-SCOUT-PROMPT")));
	} finally {
		process.env.PI_CODING_AGENT_DIR = prevDir;
		s?.session.dispose();
	}
	return lastToolMsgs(env.mock)[0]?.includes("WRONG-BINARY") || !env.mock.state.requests.some((r) => JSON.stringify(r.body.messages[0]).includes("MARKER-SCOUT-PROMPT")) ? "BROKEN in an SDK host (re-spawns the host script as if it were pi)" : "works";
});

const oneShot = (cwd, prompt, stdin, limitMs) =>
	new Promise((resolve) => {
		const t0 = Date.now();
		const p = spawn("/usr/bin/time", ["-l", process.execPath, CLI, "--mode", "json", "-p", "--no-session", "--provider", "mock", "--model", "mock-model", prompt], { cwd, env: childEnv, stdio: [stdin, "pipe", "pipe"] });
		let out = "";
		let err = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (err += d));
		const timer = setTimeout(() => {
			spawn("pkill", ["-P", String(p.pid)]);
			resolve({ hung: true, ms: Date.now() - t0, out, err });
		}, limitMs);
		p.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ hung: false, code, ms: Date.now() - t0, out, err });
		});
	});

await check("SA4", "CLI one-shot (`pi --mode json -p`): does it work against the same config, and what does a process cost?", async (note) => {
	env.mock.reset();
	const cwd = repo("oneshot");
	const r = await oneShot(cwd, mockMsg([{ tools: [{ name: "bash", args: { command: "pwd" } }] }]), "ignore", 30000);
	const events = r.out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
	note("stdin ignored: wall ms for a 2-request run", r.ms);
	note("peak RSS MB", +(Number(r.err.match(/(\d+)\s+maximum resident set size/)?.[1] ?? 0) / 1048576).toFixed(0));
	note("event types", [...new Set(events.map((e) => e.type))]);
	note("final assistant text", events.filter((e) => e.type === "message_end" && e.message?.role === "assistant").at(-1)?.message.content?.map((c) => c.text).join("").slice(0, 120));
	note("AGENTS.md of cwd loaded", JSON.stringify(env.mock.state.requests[0]?.body.messages[0] ?? "").includes("MARKER-ONESHOT"));
	env.mock.reset();
	const h = await oneShot(cwd, "hello", "pipe", 8000);
	note("stdin left as an open pipe (default for child_process)", h.hung ? `HANGS: no model request after ${h.ms} ms (requests: ${env.mock.state.requests.length})` : `completed in ${h.ms} ms`);
	return r.hung ? "FAILED" : "works when stdin is closed";
});

await check("SA5", "RPC mode (one pi process per agent): prompt, steer, follow-up, abort, state and cost?", async (note) => {
	env.mock.reset();
	const cwd = repo("rpc");
	const client = new RpcClient({ cliPath: CLI, cwd, env: childEnv, provider: "mock", model: "mock-model", args: ["--no-session"] });
	const t0 = Date.now();
	await client.start();
	const state0 = await client.getState();
	note("start + first get_state ms", Date.now() - t0);
	note("state keys", Object.keys(state0));
	const events = [];
	client.onEvent((e) => events.push(e));
	const ev1 = await client.promptAndWait("hello rpc");
	note("promptAndWait event types", [...new Set(ev1.map((e) => e.type))]);
	note("last assistant text", await client.getLastAssistantText());
	const pid = client.process?.pid ?? client["process"]?.pid;
	if (pid) note("RSS MB of the pi process (idle after one prompt)", await rssMB(pid));

	events.length = 0;
	const disp = await client.prompt(mockMsg([{ tools: [{ name: "bash", args: { command: "sleep 1; echo t1" } }] }, { text: "plan done" }]));
	await sleep(300);
	note("prompt disposition", disp);
	note("steer disposition", await client.steer("RPC-STEER"));
	note("followUp disposition", await client.followUp("RPC-FOLLOWUP"));
	await client.waitForIdle(15000);
	note("user messages the model saw, in order", env.mock.state.requests.at(-1).body.messages.filter((m) => m.role === "user").map((m) => textOf(m.content).replace(/<<MOCK.*>>/s, "<directive>")));
	note("final text", await client.getLastAssistantText());

	const settled = new Promise((r) => client.onEvent((e) => e.type === "agent_settled" && r(e)));
	const p = client.prompt(mockMsg([{ stall: true }]));
	await sleep(300);
	const ta = Date.now();
	await client.abort();
	note("abort() ms", Date.now() - ta);
	note("agent_settled after abort", await Promise.race([settled.then((e) => ({ aborted: e.aborted, ms: Date.now() - ta })), sleep(3000).then(() => "none within 3 s")]));
	await p.catch(() => {});
	const state1 = await client.getState();
	note("isStreaming after abort", state1.isStreaming);
	await client.stop();
	return "works";
});

await check("SA6", "Crash isolation: what does the host see when an agent process is killed mid-run, and can it resume?", async (note) => {
	env.mock.reset();
	const cwd = repo("crash");
	const sessionDir = mkdir("sub", "crash-sessions");
	const mk = (extra) => new RpcClient({ cliPath: CLI, cwd, env: childEnv, provider: "mock", model: "mock-model", args: ["--session-dir", sessionDir, ...extra] });
	const a = mk([]);
	await a.start();
	await a.promptAndWait("remember: the code word is OKAPI");
	const pid = a.process?.pid ?? a["process"]?.pid;
	const stalled = a.prompt(mockMsg([{ tools: [{ name: "bash", args: { command: "sleep 30" } }] }])).then(() => "accepted", (e) => `rejected: ${e.message}`);
	await sleep(500);
	process.kill(pid, "SIGKILL");
	note("prompt() after SIGKILL", await Promise.race([stalled, sleep(3000).then(() => "pending")]));
	note("next command on dead process", await Promise.race([a.getState().then(() => "answered", (e) => `rejected: ${e.message.slice(0, 120)}`), sleep(3000).then(() => "HANGS (no rejection after 3 s)")]));
	await a.stop().catch(() => {});
	note("session files on disk", fs.readdirSync(sessionDir, { recursive: true }).filter((f) => String(f).endsWith(".jsonl")).length);

	env.mock.reset();
	const b = mk(["--continue"]);
	await b.start();
	await b.promptAndWait("what was the code word?");
	const msgs = env.mock.state.requests[0].body.messages;
	note("roles replayed after restart", msgs.map((m) => m.role));
	note("history survived the crash", JSON.stringify(msgs).includes("OKAPI"));
	await b.stop();
	return JSON.stringify(msgs).includes("OKAPI") ? "host survives, session resumes from disk" : "FAILED";
});

saveResults("t06.json");
await env.mock.close();
process.exit(0);
