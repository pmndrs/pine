import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { check, makeEnv, newSession, saveResults, sleep, toolNames, types } from "./lib.mjs";
import { mockMsg, textOf } from "./mock.mjs";

const env = await makeEnv("tools");
const lastToolMsgs = (mock) => mock.state.requests.at(-1).body.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));

await check("T1", "Do customTools passed to createAgentSession reach the model and execute with session context?", async (note) => {
	env.mock.reset();
	const published = [];
	const publishEvent = defineTool({
		name: "publish_event",
		label: "Publish event",
		description: "Publish an event on the bus",
		parameters: Type.Object({ topic: Type.String(), payload: Type.Optional(Type.String()) }),
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			published.push({ ...params, cwd: ctx.cwd, hasUI: ctx.hasUI, ctxKeys: Object.keys(ctx).slice(0, 30), hasSignal: !!signal });
			return { content: [{ type: "text", text: `published ${params.topic}` }], details: { ok: true } };
		},
	});
	const s = await newSession(env, { customTools: [publishEvent] });
	await s.session.prompt(mockMsg([{ tools: [{ name: "publish_event", args: { topic: "agent/kevin/said", payload: "hi" } }] }]));
	note("tools declared to model", toolNames(env.mock.state.requests[0]));
	note("schema sent", env.mock.state.requests[0].body.tools.find((t) => t.function.name === "publish_event")?.function.parameters);
	note("tool received", published[0]);
	note("final text", s.session.getLastAssistantText());
	s.session.dispose();
	return published.length === 1 && published[0].cwd === s.cwd ? "works" : "FAILED";
});

await check("T2", "Can an inline extension gate tool calls (block dangerous bash) without any UI?", async (note) => {
	env.mock.reset();
	const seen = [];
	const gate = (pi) => {
		pi.on("tool_call", async (event, ctx) => {
			seen.push({ tool: event.toolName, input: event.input, hasUI: ctx.hasUI });
			if (event.toolName === "bash" && /rm -rf|sudo/.test(event.input.command)) return { block: true, reason: "blocked by policy: destructive command" };
		});
	};
	const s = await newSession(env, { loader: { extensionFactories: [gate] } });
	fs.writeFileSync(path.join(s.cwd, "precious.txt"), "keep me");
	await s.session.prompt(mockMsg([{ tools: [{ name: "bash", args: { command: "rm -rf precious.txt" } }, { name: "bash", args: { command: "echo harmless" } }] }]));
	note("gate saw", seen);
	note("tool results returned to model", lastToolMsgs(env.mock));
	note("file survived", fs.existsSync(path.join(s.cwd, "precious.txt")));
	s.session.dispose();
	return fs.existsSync(path.join(s.cwd, "precious.txt")) ? "works" : "FAILED";
});

await check("T3", "How are malformed tool calls from a weak model handled (bad JSON, unknown tool, wrong arguments)?", async (note) => {
	const cases = {
		"invalid JSON arguments": { name: "bash", rawArgs: '{"command": "echo hi"' },
		"unknown tool name": { name: "run_shell", args: { command: "echo hi" } },
		"missing required argument": { name: "bash", args: { cmd: "echo hi" } },
		"wrong argument type": { name: "bash", args: { command: 42 } },
		"arguments as JSON string of JSON": { name: "bash", rawArgs: JSON.stringify(JSON.stringify({ command: "echo double-encoded" })) },
		"empty arguments": { name: "bash", rawArgs: "" },
	};
	let allContinue = true;
	for (const [label, call] of Object.entries(cases)) {
		env.mock.reset();
		const s = await newSession(env);
		let threw;
		try {
			await s.session.prompt(mockMsg([{ tools: [call] }]));
		} catch (e) {
			threw = e.message;
		}
		const toolMsgs = env.mock.state.requests.length > 1 ? lastToolMsgs(env.mock) : [];
		note(label, { requests: env.mock.state.requests.length, threw, toolResultToModel: toolMsgs.map((t) => t.slice(0, 220)), final: s.session.getLastAssistantText()?.slice(0, 60) });
		allContinue &&= env.mock.state.requests.length === 2 && !threw;
		s.session.dispose();
	}
	return allContinue ? "every case is reported back to the model and the run continues" : "some cases end the run";
});

await check("T4", "Are several tool calls in one assistant message executed in parallel?", async (note) => {
	env.mock.reset();
	const s = await newSession(env);
	const t0 = Date.now();
	await s.session.prompt(mockMsg([{ tools: [1, 2, 3].map((i) => ({ name: "bash", args: { command: `sleep 1; echo done-${i}` } })) }]));
	const ms = Date.now() - t0;
	note("3 x sleep 1 took ms", ms);
	note("tool results", lastToolMsgs(env.mock));
	note("execution events", s.events.filter((e) => /tool_execution_(start|end)/.test(e.type)).map((e) => `${e.type}@${e.at - t0}`));
	s.session.dispose();
	return ms < 2000 ? "parallel" : "sequential";
});

await check("T5", "Does a tool allowlist hold when the model calls a tool that was not offered?", async (note) => {
	env.mock.reset();
	const s = await newSession(env, { tools: ["read"] });
	fs.writeFileSync(path.join(s.cwd, "victim.txt"), "x");
	await s.session.prompt(mockMsg([{ tools: [{ name: "bash", args: { command: "rm victim.txt" } }, { name: "write", args: { path: "new.txt", content: "y" } }] }]));
	note("tools declared", toolNames(env.mock.state.requests[0]));
	note("tool results", lastToolMsgs(env.mock));
	const ok = fs.existsSync(path.join(s.cwd, "victim.txt")) && !fs.existsSync(path.join(s.cwd, "new.txt"));
	note("filesystem untouched", ok);
	const none = await newSession(env, { noTools: "all" });
	env.mock.reset();
	await none.session.prompt("no tools at all");
	note("noTools:'all' → tools field in request", env.mock.state.requests[0].body.tools ?? "absent");
	note("noTools reply (mock answers summary when no tools)", none.session.getLastAssistantText());
	s.session.dispose();
	none.session.dispose();
	return ok ? "allowlist enforced" : "NOT ENFORCED";
});

await check("T6", "How is huge tool output handled before it goes back to the model?", async (note) => {
	env.mock.reset();
	const s = await newSession(env);
	await s.session.prompt(mockMsg([{ tools: [{ name: "bash", args: { command: "yes 0123456789abcdef | head -c 3000000" } }] }]));
	const out = lastToolMsgs(env.mock)[0];
	note("bytes produced", 3000000);
	note("chars sent to model", out.length);
	note("tail of what the model got", out.slice(-260));
	s.session.dispose();
	return out.length < 200000 ? "truncated" : "NOT truncated";
});

await check("T7", "Does bash have a default timeout, and does a per-call timeout work?", async (note) => {
	env.mock.reset();
	const s = await newSession(env);
	const schema = (await (async () => {
		await s.session.prompt("schema probe");
		return env.mock.state.requests[0].body.tools.find((t) => t.function.name === "bash").function.parameters;
	})());
	note("bash parameters", schema);
	env.mock.reset();
	const t0 = Date.now();
	await s.session.prompt(mockMsg([{ tools: [{ name: "bash", args: { command: "sleep 20; echo late", timeout: 1 } }] }]));
	note("sleep 20 with timeout:1 took ms", Date.now() - t0);
	note("tool result", lastToolMsgs(env.mock));
	s.session.dispose();
	return Date.now() - t0 < 5000 ? "per-call timeout works" : "timeout ignored";
});

await check("T8", "What happens when a custom tool throws?", async (note) => {
	env.mock.reset();
	const boom = defineTool({
		name: "boom",
		label: "Boom",
		description: "Always fails",
		parameters: Type.Object({}),
		execute: async () => {
			throw new Error("database is on fire");
		},
	});
	const s = await newSession(env, { customTools: [boom] });
	let threw;
	try {
		await s.session.prompt(mockMsg([{ tools: [{ name: "boom", args: {} }] }]));
	} catch (e) {
		threw = e.message;
	}
	note("prompt() threw", threw ?? false);
	note("tool result to model", lastToolMsgs(env.mock));
	note("isError on tool_execution_end", s.events.find((e) => e.type === "tool_execution_end")?.isError);
	s.session.dispose();
	return !threw && env.mock.state.requests.length === 2 ? "error text goes to the model, run continues" : "RUN BROKE";
});

await check("T9", "Do images reach the model (camera snapshot use case)?", async (note) => {
	env.mock.reset();
	const s = await newSession(env);
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	await s.session.prompt("what is in this picture", { images: [{ type: "image", data: png, mimeType: "image/png" }] });
	const user = env.mock.state.requests[0].body.messages.find((m) => m.role === "user");
	note("user content part types", Array.isArray(user.content) ? user.content.map((p) => p.type) : typeof user.content);
	note("image part shape", Array.isArray(user.content) ? JSON.stringify(user.content.find((p) => p.type !== "text")).slice(0, 90) : null);
	env.mock.reset();
	fs.writeFileSync(path.join(s.cwd, "snap.png"), Buffer.from(png, "base64"));
	await s.session.prompt(mockMsg([{ tools: [{ name: "read", args: { path: "snap.png" } }] }]));
	const msgs = env.mock.state.requests.at(-1).body.messages;
	note("after read(snap.png): roles and part types", msgs.slice(-2).map((m) => ({ role: m.role, parts: Array.isArray(m.content) ? m.content.map((p) => p.type) : "string" })));
	s.session.dispose();
	return Array.isArray(user.content) && user.content.some((p) => p.type === "image_url") ? "sent as image_url" : "NOT SENT";
});

saveResults("t03.json");
await env.mock.close();
process.exit(0);
