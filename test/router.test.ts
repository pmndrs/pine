import assert from "node:assert/strict";
import { test } from "node:test";
import { harness, mockMsg, notesOf, sleep, textOf, until } from "./support/harness.ts";

const users = (req: any) => req.body.messages.filter((m: any) => m.role === "user").map((m: any) => textOf(m.content));

test("an event becomes an agent turn and the answer goes back where the event says", async () => {
	const h = await harness({
		pine: {
			routes: [
				{ on: "chat/+/message", agent: "main", session: "chat-{{payload.chat}}" },
				{ on: "sensor/#", when: { "payload.value": { gt: 30 } }, agent: "main", prompt: "Sensor {{topic}} reads {{payload.value}}", session: "new", reply: { topic: "out/alerts", payload: { level: "warn", sensor: "{{topic}}" } } },
			],
		},
		agents: { main: {} },
	});
	const replies: any[] = [];
	h.pine.bus.subscribe("out/#", (e) => void replies.push({ topic: e.topic, ...(e.payload as any), hops: e.hops, cause: e.cause }));

	const msg = h.pine.bus.publish("chat/a/message", { chat: 42, text: "hello from the owner" }, { source: "test", trust: "owner", reply: { topic: "out/chat/a", payload: { chat: 42 } } });
	await until(() => replies.length === 1);
	assert.deepEqual(replies[0], { topic: "out/chat/a", chat: 42, text: "ECHO[hello from the owner]", agent: "main", task: 1, hops: 1, cause: msg.id });
	assert.deepEqual(users(h.mock.state.requests[0]), ["hello from the owner"], "owner text is passed on as it is");
	assert.equal(h.pine.tasks.get(1)!.session, "chat-42");

	h.pine.bus.publish("sensor/boiler", { value: 20 }, { source: "test" });
	h.pine.bus.publish("sensor/boiler", { value: 45 }, { source: "test" });
	await until(() => replies.length === 2);
	assert.equal(replies[1].topic, "out/alerts");
	assert.equal(replies[1].sensor, "sensor/boiler");
	const sensorPrompt = users(h.mock.state.requests.at(-1))[0];
	assert.match(sensorPrompt, /^\[event on sensor\/boiler from test at \d\d:\d\d:\d\d; this did not come from your owner\./);
	assert.ok(sensorPrompt.endsWith("Sensor sensor/boiler reads 45"));
	assert.equal(h.pine.tasks.list({}).length, 2, "the reading of 20 was filtered out");
	await h.close();
});

test("debounce handles only the last event of a burst; throttle only the first", async () => {
	const h = await harness({
		pine: {
			routes: [
				{ name: "burst", on: "cam/+/motion", debounceMs: 80, publish: { topic: "seen/debounced", payload: { n: "{{payload.n}}", cam: "{{topic}}" } } },
				{ name: "first", on: "door/bell", throttleMs: 300, publish: { topic: "seen/throttled", payload: "{{payload}}" } },
			],
		},
		agents: { main: {} },
	});
	for (const n of [1, 2, 3]) {
		h.pine.bus.publish("cam/front/motion", { n });
		h.pine.bus.publish("door/bell", { n });
		await sleep(15);
	}
	h.pine.bus.publish("cam/back/motion", { n: 9 });
	await sleep(160);
	const debounced = h.pine.bus.query({ topic: "seen/debounced" }).map((e) => e.payload);
	assert.deepEqual(debounced, [{ n: 3, cam: "cam/front/motion" }, { n: 9, cam: "cam/back/motion" }]);
	assert.deepEqual(h.pine.bus.query({ topic: "seen/throttled" }).map((e) => e.payload), [{ n: 1 }]);
	await h.close();
});

test("rules write shared state, agents see it each turn, and one model call can classify an event", async () => {
	const h = await harness({
		pine: {
			routes: [
				{ on: "mqtt/house/mode", set: { "house/mode": "{{payload.value}}" } },
				{ on: "cam/front/snapshot", call: { system: "Classify.", prompt: "What is in {{payload.file}}? Mode: {{state.house/mode}}" }, publish: { topic: "cam/front/classified" } },
			],
		},
		agents: { main: { agent: { state: { inject: ["house/#"] } } } },
	});
	h.pine.bus.publish("mqtt/house/mode", { value: "away" });
	await until(() => h.pine.state.get("house/mode") === "away");
	await h.pine.agents.run({ agent: "main", prompt: "one", trust: "owner" });
	h.pine.state.set("house/mode", "home");
	await h.pine.agents.run({ agent: "main", prompt: "two", trust: "owner" });
	const [r1, r2] = h.requestsFor("PERSONA-MAIN");
	assert.ok(notesOf(r1).at(-1)!.includes('- house/mode = "away"'));
	assert.ok(notesOf(r2).at(-1)!.includes('- house/mode = "home"') && !notesOf(r2).at(-1)!.includes('"away"'), "the latest note carries the current state");
	assert.equal(h.system(r2), h.system(r1), "and the system prompt did not change for it");

	const classified = h.pine.bus.waitFor("cam/front/classified");
	const snap = h.pine.bus.publish("cam/front/snapshot", { file: "a.jpg" });
	const e = await classified;
	assert.ok(/^SUMMARY-OK/.test((e.payload as any).text), "the mock answers plain calls with a summary marker");
	assert.equal(e.cause, snap.id);
	const call = h.mock.state.requests.at(-1);
	assert.equal(call.body.tools, undefined, "a call has no tools");
	assert.ok(users(call)[0].includes("What is in a.jpg? Mode: home"));
	await h.close();
});

test("an agent that keeps triggering itself through events is cut off", async () => {
	const again = mockMsg([{ tools: [{ name: "publish_event", args: { topic: "loop/ping", text: "again" } }] }]);
	const h = await harness({
		pine: { limits: { maxEventHops: 4 }, routes: [{ on: "loop/ping", agent: "main", session: "new", prompt: again, trust: "owner" }] },
		agents: { main: { agent: { publish: ["loop/#"] } } },
	});
	h.pine.bus.publish("loop/ping", { text: "start" }, { trust: "owner" });
	await until(() => h.logs.some((l) => /dropped loop\/ping .* after \d+ hops/.test(l)), 8000, "the loop to be cut");
	await sleep(60);
	const pings = h.pine.bus.query({ topic: "loop/ping" });
	assert.ok(pings.length >= 3 && pings.length <= 6, `loop stopped after ${pings.length} events`);
	assert.equal(h.pine.agents.status().running.length, 0);
	await h.close();
});

test("schedules publish timer events that routes pick up as the owner's own", async () => {
	const h = await harness({
		pine: { schedules: [{ name: "tick", every: "60ms", payload: { what: "check" } }], routes: [{ on: "timer/tick", agent: "main", session: "new", prompt: "Routine check ({{payload.what}})" }] },
		agents: { main: {} },
	});
	await until(() => h.pine.tasks.list({ status: "done" }).length >= 2, 4000, "two scheduled runs");
	const e = h.pine.bus.query({ topic: "timer/tick" })[0];
	assert.equal(e.trust, "owner");
	assert.equal((e.payload as any).name, "tick");
	assert.deepEqual(users(h.mock.state.requests[0]), ["Routine check (check)"]);
	await h.close();
});
