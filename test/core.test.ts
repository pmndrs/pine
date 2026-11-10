import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ConfigError, effectiveMcp, loadConfig } from "../src/config.ts";
import { Limiter } from "../src/limiter.ts";
import { parseCron } from "../src/timers.ts";
import { matchWhen, parseDuration, render, renderDeep, topicMatches } from "../src/util.ts";
import { harness, sleep } from "./support/harness.ts";

test("topic patterns follow MQTT rules", () => {
	assert.ok(topicMatches("cam/+/motion", "cam/front/motion"));
	assert.ok(!topicMatches("cam/+/motion", "cam/front/door/motion"));
	assert.ok(topicMatches("cam/#", "cam/front/door/motion"));
	assert.ok(topicMatches("cam/#", "cam"));
	assert.ok(topicMatches("#", "anything/at/all"));
	assert.ok(!topicMatches("cam/front", "cam/front/motion"));
});

test("templates and filters", () => {
	const ctx = { payload: { text: "hi", n: 3, nested: { a: [1, 2] } }, topic: "t/x" };
	assert.equal(render("{{payload.text}} on {{topic}} {{payload.missing}}|{{payload.nested}}", ctx), 'hi on t/x |{"a":[1,2]}');
	assert.deepEqual(renderDeep({ a: "{{payload.n}}", b: ["x{{payload.n}}"] }, ctx), { a: 3, b: ["x3"] });
	assert.ok(matchWhen({ "payload.n": 3, "payload.text": { regex: "^h" } }, ctx));
	assert.ok(!matchWhen({ "payload.n": { gt: 3 } }, ctx));
	assert.ok(matchWhen({ "payload.missing": { exists: false }, "payload.n": { in: [1, 3] } }, ctx));
	assert.equal(parseDuration("15m"), 900_000);
});

test("cron expressions", () => {
	const at = (s: string) => new Date(s);
	assert.ok(parseCron("0 9 * * *")(at("2026-11-10T09:00:00")));
	assert.ok(!parseCron("0 9 * * *")(at("2026-11-10T09:01:00")));
	assert.ok(parseCron("*/15 8-18 * * 1-5")(at("2026-11-10T08:45:00")));
	assert.ok(!parseCron("*/15 8-18 * * 1-5")(at("2026-11-08T08:45:00"))); // a Sunday
	assert.ok(parseCron("0 9 * * 2,5")(at("2026-11-10T09:00:00"))); // a Tuesday
	assert.ok(parseCron("0 0 1 * 7")(at("2026-11-08T00:00:00"))); // day-of-month OR Sunday
	assert.throws(() => parseCron("61 * * * *"));
});

test("the limiter orders by priority and lends a slot while a run waits for others", async () => {
	const lim = new Limiter(1);
	const order: string[] = [];
	const parent = await lim.acquire(0);
	const low = lim.acquire(0).then((s) => (order.push("low"), s.release()));
	const high = lim.acquire(5).then((s) => (order.push("high"), s.release()));
	// The parent waits for two "children" at once; both need the single slot.
	await parent.suspend(async () => {
		await Promise.all([low, high]);
	});
	assert.deepEqual(order, ["high", "low"]);
	assert.equal(lim.stats.active, 1);
	parent.release();
	assert.equal(lim.stats.active, 0);
});

test("configuration problems are reported together and name the file", async () => {
	const h = await harness({ agents: { main: {} }, start: false });
	fs.writeFileSync(path.join(h.home, "pine.json"), JSON.stringify({ main: "nobody", routes: [{ on: "x", agent: "ghost" }, { on: "y" }], mcp: { bad: {} }, http: { hooks: { open: {} } }, plugins: [{}] }));
	fs.writeFileSync(path.join(h.home, "agents", "main", "agent.json"), JSON.stringify({ delegates: ["ghost"], token: "${PINE_TEST_UNSET_VAR}" }));
	assert.throws(() => loadConfig(h.home), (e: any) => {
		assert.ok(e instanceof ConfigError);
		const all = e.problems.join("\n");
		for (const expected of ['main agent "nobody"', 'unknown agent "ghost"', "needs one of agent, call, publish, set", 'mcp.bad needs "command", "url" or "pine"', "PINE_TEST_UNSET_VAR is not set", 'needs a "secret"', 'needs "use"', "no model"]) assert.ok(all.includes(expected), `missing: ${expected}\n${all}`);
		return true;
	});
	await h.close();
});

test("secrets from .env fill the configuration but never enter the process environment", async () => {
	const h = await harness({
		pine: { mcp: { g: { command: "x", env: { KEY: "${PINE_TEST_SECRET}" } } } },
		agents: { main: {} },
		files: { ".env": "PINE_TEST_SECRET=s3cr3t-value-123\n" },
		start: false,
	});
	const cfg = loadConfig(h.home);
	assert.equal(cfg.mcp.g.env?.KEY, "s3cr3t-value-123");
	assert.equal(process.env.PINE_TEST_SECRET, undefined);
	assert.ok(cfg.secrets.includes("s3cr3t-value-123"));
	await h.close();
});

test("MCP servers: global ones reach the agents they name, own ones only their agent", async () => {
	const h = await harness({
		pine: { mcp: { everyone: { command: "a" }, onlyb: { command: "b", agents: ["b"] }, off: { command: "c", enabled: false } } },
		agents: { a: { agent: { mcp: { mine: { command: "d" } } } }, b: { agent: { globalMcp: ["everyone"] } }, c: { agent: { globalMcp: false, mcp: { everyone: { command: "override" } } } } },
		start: false,
	});
	const cfg = loadConfig(h.home);
	assert.deepEqual(Object.keys(effectiveMcp(cfg, cfg.agents.a)).sort(), ["everyone", "mine"]);
	assert.deepEqual(Object.keys(effectiveMcp(cfg, cfg.agents.b)), ["everyone"]);
	assert.deepEqual(effectiveMcp(cfg, cfg.agents.c), { everyone: { command: "override" } });
	await h.close();
});

test("events are stored, delivered by pattern, and a failing subscriber does not affect others", async () => {
	const h = await harness({ agents: { main: {} } });
	const { bus } = h.pine;
	const seen: string[] = [];
	bus.subscribe("cam/+/motion", () => {
		throw new Error("boom");
	});
	bus.subscribe("cam/#", (e) => void seen.push(e.topic));
	const first = bus.publish("cam/front/motion", { n: 1 }, { source: "test" });
	const second = bus.publish("cam/front/idle", { n: 2 }, { source: "test", cause: first, hop: true });
	bus.publish("telemetry/x", 1, { persist: false });
	await bus.drain();
	assert.deepEqual(seen, ["cam/front/motion", "cam/front/idle"]);
	assert.equal(second.cause, first.id);
	assert.equal(second.hops, 1);
	assert.equal(first.trust, "untrusted");
	assert.deepEqual(bus.query({ topic: "cam/#" }).map((e) => e.id), [first.id, second.id]);
	assert.equal(bus.query({ topic: "telemetry/#" }).length, 0);
	assert.throws(() => bus.publish("cam/+/x"));
	assert.ok(h.logs.some((l) => l.includes("boom")));
	await h.close();
});

test("shared state: writes are events, deletes work, patterns list", async () => {
	const h = await harness({ agents: { main: {} } });
	const { state, bus } = h.pine;
	state.set("house/mode", "away", { source: "test" });
	state.set("house/mode", "away", { source: "test" }); // unchanged: no second event
	state.set("house/door", { open: true });
	assert.equal(state.get("house/mode"), "away");
	assert.deepEqual(state.list("house/#").map((s) => s.key), ["house/door", "house/mode"]);
	assert.equal(bus.query({ topic: "state/house/mode" }).length, 1);
	state.set("house/door", null);
	assert.equal(state.get("house/door"), undefined);
	await sleep(10);
	await h.close();
});

test("the claude -p stand-in: conversation rendering and reply parsing", async () => {
	const { buildPrompt, parseReply } = await import("../src/dev/claude-model.ts");
	const prompt = buildPrompt({
		messages: [
			{ role: "system", content: "SYS" },
			{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:..." } }] },
			{ role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
			{ role: "tool", tool_call_id: "c1", content: "a.txt" },
		],
		tools: [{ type: "function", function: { name: "bash", description: "run", parameters: { type: "object" } } }],
	});
	for (const part of ["<harness_system_prompt>\nSYS", '"name": "bash"', "<user>\nhi[image_url omitted]", '<tool_call id="c1" name="bash">{"command":"ls"}</tool_call>', '<tool_result id="c1">\na.txt']) assert.ok(prompt.includes(part), part);
	assert.deepEqual(parseReply('{"text":"","tool_calls":[{"name":"bash","arguments":{"command":"ls"}}]}'), { text: "", tool_calls: [{ name: "bash", arguments: { command: "ls" } }] });
	assert.deepEqual(parseReply('```json\n{"text":"done","tool_calls":[]}\n```'), { text: "done", tool_calls: [] });
	assert.deepEqual(parseReply("plain words, no JSON"), { text: "plain words, no JSON", tool_calls: [] });
	assert.deepEqual(parseReply('{"unrelated": 1}'), { text: '{"unrelated": 1}', tool_calls: [] });
});
