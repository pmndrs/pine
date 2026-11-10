import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { createEventBus, defineTool } from "@earendil-works/pi-coding-agent";
import { check, makeEnv, mkdir, newSession, saveResults, sleep, systemOf, types, write } from "./lib.mjs";
import { mockMsg, startMock, textOf } from "./mock.mjs";

const env = await makeEnv("misc");
const users = (req) => req.body.messages.filter((m) => m.role === "user").map((m) => textOf(m.content).replace(/<<MOCK.*>>/s, "<directive>").slice(0, 90));

await check("X1", "Tier-1 handler: can the host make one plain model call (with an image) without an agent session?", async (note) => {
	const mock = await startMock({ directivesWithoutTools: true });
	const e = await makeEnv("misc-plain", { mock });
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
	const t0 = Date.now();
	const msg = await e.modelRuntime.completeSimple(e.model, {
		systemPrompt: "You classify camera frames. Answer with one word.",
		messages: [{ role: "user", content: [{ type: "text", text: "threat level?" }, { type: "image", data: png, mimeType: "image/png" }], timestamp: Date.now() }],
	});
	const req = mock.state.requests[0];
	note("ms", Date.now() - t0);
	note("reply", { stopReason: msg.stopReason, text: msg.content?.map((c) => c.text).join(""), usage: msg.usage && { input: msg.usage.input, output: msg.usage.output } });
	note("request", { roles: req.body.messages.map((m) => m.role), userParts: req.body.messages.at(-1).content.map?.((p) => p.type), tools: req.body.tools ?? "absent", keys: Object.keys(req.body) });
	await mock.close();
	return msg.stopReason === "stop" ? "works via modelRuntime.completeSimple()" : "FAILED";
});

await check("X2", "Agent-to-agent trigger: can one session's tool wake another session through a shared in-process event bus?", async (note) => {
	env.mock.reset();
	const bus = createEventBus();
	const publish = (pi) =>
		pi.registerTool(
			defineTool({
				name: "publish_event",
				label: "Publish",
				description: "Publish an event",
				parameters: Type.Object({ topic: Type.String(), text: Type.String() }),
				execute: async (_id, p) => {
					pi.events.emit(p.topic, { text: p.text });
					return { content: [{ type: "text", text: `published to ${p.topic}` }], details: {} };
				},
			}),
		);
	const subscribe = (topic) => (pi) =>
		pi.events.on(topic, (data) => {
			pi.sendMessage({ customType: "bus-event", content: `EVENT ${topic}: ${data.text}`, display: true }, { triggerTurn: true });
		});
	const kevin = await newSession(env, { cwd: mkdir("misc", "kevin"), loader: { eventBus: bus, extensionFactories: [publish] } });
	const gonzo = await newSession(env, { cwd: mkdir("misc", "gonzo"), loader: { eventBus: bus, extensionFactories: [subscribe("legal/question")] } });
	await kevin.session.bindExtensions({});
	await gonzo.session.bindExtensions({});
	await kevin.session.prompt(mockMsg([{ tools: [{ name: "publish_event", args: { topic: "legal/question", text: "may the neighbour film our driveway?" } }] }]));
	await sleep(200);
	await gonzo.session.waitForIdle();
	note("kevin final", kevin.session.getLastAssistantText());
	note("gonzo was triggered", types(gonzo.events).includes("agent_start"));
	note("gonzo answered", gonzo.session.getLastAssistantText());
	note("pi.events is the bus passed to the loader", true);
	kevin.session.dispose();
	gonzo.session.dispose();
	return gonzo.session.getLastAssistantText()?.includes("may the neighbour") ? "works" : "FAILED";
});

await check("X3", "What happens to an injected event when the target session is busy?", async (note) => {
	const outcomes = {};
	for (const deliverAs of [undefined, "steer", "followUp", "nextTurn"]) {
		env.mock.reset();
		const s = await newSession(env);
		const p = s.session.prompt(mockMsg([{ tools: [{ name: "bash", args: { command: "sleep 0.6; echo busy-done" } }] }, { text: "busy run finished" }]));
		await sleep(200);
		let threw;
		try {
			await s.session.sendCustomMessage({ customType: "bus-event", content: `EVENT-${deliverAs ?? "default"}`, display: true }, { triggerTurn: true, ...(deliverAs ? { deliverAs } : {}) });
		} catch (e) {
			threw = e.message.slice(0, 120);
		}
		await p;
		await s.session.waitForIdle();
		const after = env.mock.state.requests.length;
		await s.session.prompt("next user prompt");
		outcomes[deliverAs ?? "default"] = { threw: threw ?? false, requestsInBusyRun: after, final: undefined, perRequestUsers: env.mock.state.requests.map(users) };
		s.session.dispose();
	}
	for (const [k, v] of Object.entries(outcomes)) note(`deliverAs: ${k}`, v);
	return "measured";
});

await check("X4", "Per-turn world state: can an extension add live state to the prompt without growing the history?", async (note) => {
	env.mock.reset();
	let mode = "home";
	const state = (pi) =>
		pi.on("before_agent_start", async (event) => ({ systemPrompt: `${event.systemPrompt}\n\n<world_state>house_mode=${mode}</world_state>` }));
	const s = await newSession(env, { loader: { extensionFactories: [state] } });
	await s.session.bindExtensions({});
	await s.session.prompt("turn one");
	mode = "away";
	await s.session.prompt("turn two");
	const [r1, r2] = env.mock.state.requests;
	note("turn 1 system prompt has", systemOf(r1).match(/<world_state>.*<\/world_state>/)?.[0]);
	note("turn 2 system prompt has", systemOf(r2).match(/<world_state>.*<\/world_state>/)?.[0]);
	note("turn 2 non-system messages", r2.body.messages.filter((m) => m.role !== "system").length);
	note("stale state left in history", JSON.stringify(r2.body.messages.slice(1)).includes("house_mode=home"));
	s.session.dispose();
	return systemOf(r2).includes("house_mode=away") && !systemOf(r2).includes("house_mode=home") ? "works" : "FAILED";
});

await check("X5", "Are edits to AGENTS.md picked up by a long-lived session?", async (note) => {
	env.mock.reset();
	const cwd = mkdir("misc", "reload");
	write(path.join(cwd, "AGENTS.md"), "VERSION-ONE\n");
	const s = await newSession(env, { cwd });
	await s.session.prompt("first");
	write(path.join(cwd, "AGENTS.md"), "VERSION-TWO\n");
	await s.session.prompt("second");
	note("next prompt after edit sees", systemOf(env.mock.state.requests[1]).includes("VERSION-TWO") ? "VERSION-TWO" : "VERSION-ONE (stale)");
	let reloadErr;
	try {
		await s.session.reload();
	} catch (e) {
		reloadErr = e.message;
	}
	await s.session.prompt("third");
	note("after session.reload()", reloadErr ? `reload threw: ${reloadErr}` : systemOf(env.mock.state.requests[2]).includes("VERSION-TWO") ? "VERSION-TWO" : "VERSION-ONE (stale)");
	note("history kept across reload (messages in request 3)", env.mock.state.requests[2].body.messages.length);
	s.session.dispose();
	return "measured";
});

await check("X6", "Thinking models: is reasoning_content parsed, what is requested, and is it replayed?", async (note) => {
	const e = await makeEnv("misc-think", { modelOverrides: { reasoning: true } });
	for (const [label, compat] of Object.entries({ "no compat (auto)": undefined, "compat.thinkingFormat=deepseek": { thinkingFormat: "deepseek" } })) {
		const e2 = compat ? await makeEnv(`misc-think-${compat.thinkingFormat}`, { mock: e.mock, modelOverrides: { reasoning: true, compat } }) : e;
		e.mock.reset();
		const s = await newSession(e2, { thinkingLevel: "medium" });
		await s.session.prompt(mockMsg([{ reasoning: "let me think about the tool", tools: [{ name: "bash", args: { command: "echo x" } }] }, { reasoning: "now answer", text: "final answer" }]));
		const [r1, r2] = e.mock.state.requests;
		const extra = Object.fromEntries(Object.entries(r1.body).filter(([k]) => !["model", "messages", "stream", "stream_options", "tools", "store"].includes(k)));
		const asst = r2.body.messages.find((m) => m.role === "assistant");
		note(label, {
			thinkingRelatedRequestFields: extra,
			thinkingEvents: [...new Set(s.events.filter((ev) => ev.type === "message_update").map((ev) => ev.assistantMessageEvent.type))],
			storedBlocks: s.session.messages.filter((m) => m.role === "assistant").map((m) => m.content.map((c) => c.type)),
			replayedAssistantKeys: Object.keys(asst),
			replayedReasoning: asst.reasoning_content ?? asst.reasoning ?? (typeof asst.content === "string" ? asst.content.slice(0, 60) : JSON.stringify(asst.content)?.slice(0, 80)),
		});
		s.session.dispose();
	}
	await e.mock.close();
	return "measured";
});

await check("X7", "Does a throwing extension handler or a rejected custom tool take the host down?", async (note) => {
	env.mock.reset();
	const errors = [];
	const bad = (pi) => {
		pi.on("tool_call", async () => {
			throw new Error("handler exploded");
		});
		pi.on("turn_end", () => {
			throw new Error("sync handler exploded");
		});
	};
	const s = await newSession(env, { loader: { extensionFactories: [bad] } });
	await s.session.bindExtensions({ onError: (e) => errors.push(`${e.event}: ${e.error}`) });
	let threw;
	try {
		await s.session.prompt(mockMsg([{ tools: [{ name: "bash", args: { command: "echo should-this-run" } }] }]));
	} catch (e) {
		threw = e.message;
	}
	note("prompt() threw", threw ?? false);
	note("errors reported to host (bindExtensions onError)", errors);
	note("tool result the model got", env.mock.state.requests.at(-1).body.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content)));
	note("host still alive, session answers", (await s.session.prompt("still there?"), s.session.getLastAssistantText()));
	s.session.dispose();
	return "measured";
});

await check("X8", "Long-lived session: does memory grow over 300 turns with compaction on?", async (note) => {
	const e = await makeEnv("misc-long", { modelOverrides: { contextWindow: 16000, maxTokens: 1000 } });
	const s = await newSession(e, { inMemory: false, settings: { compaction: { enabled: true, reserveTokens: 4000, keepRecentTokens: 3000 } } });
	s.events.length = 0;
	global.gc?.();
	const base = process.memoryUsage();
	const marks = {};
	const t0 = Date.now();
	for (let i = 1; i <= 300; i++) {
		await s.session.prompt(`event ${i}: ${"sensor reading ".repeat(120)}`);
		s.events.length = 0;
		e.mock.state.requests.length = 0;
		if (i % 100 === 0) {
			global.gc?.();
			const m = process.memoryUsage();
			marks[i] = { heapMB: +((m.heapUsed - base.heapUsed) / 1048576).toFixed(1), rssMB: +((m.rss - base.rss) / 1048576).toFixed(1), ctxTokens: s.session.getContextUsage()?.tokens, messagesInSession: s.session.messages.length };
		}
	}
	note("growth over baseline", marks);
	note("ms per turn (mock model)", +((Date.now() - t0) / 300).toFixed(1));
	note("session file MB", +(fs.statSync(s.session.sessionFile).size / 1048576).toFixed(2));
	s.session.dispose();
	await e.mock.close();
	return "measured";
});

saveResults("t07.json");
await env.mock.close();
process.exit(0);
