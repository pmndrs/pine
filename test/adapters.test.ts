import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { Aedes } from "aedes";
import mqtt from "mqtt";
import { harness, mockMsg, sleep, until } from "./support/harness.ts";

const TOKEN = "123456:FAKE-TOKEN-abcdefghijklmnop";

/** Enough of the Telegram Bot API for the plugin: long polling, sending, callbacks. */
async function fakeTelegram() {
	const queue: any[] = [];
	const calls: Array<{ method: string; body: any }> = [];
	let updateId = 100;
	let messageId = 500;
	const server = http.createServer(async (req, res) => {
		let raw = "";
		for await (const c of req) raw += c;
		const body = raw ? JSON.parse(raw) : {};
		const m = (req.url ?? "").match(/^\/bot([^/]+)\/(\w+)$/);
		const reply = (result: unknown, ok = true) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok, result }));
		if (!m || m[1] !== TOKEN) return reply("unauthorized", false);
		if (m[2] === "getUpdates") {
			const end = Date.now() + 100;
			while (Date.now() < end && !queue.some((u) => u.update_id >= body.offset)) await sleep(5);
			return reply(queue.filter((u) => u.update_id >= body.offset));
		}
		calls.push({ method: m[2], body });
		return reply(m[2] === "sendMessage" ? { message_id: messageId++ } : true);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	return {
		apiBase: `http://127.0.0.1:${(server.address() as any).port}`,
		calls,
		sent: () => calls.filter((c) => c.method === "sendMessage").map((c) => c.body),
		message: (userId: number, text: string, chat: any = { id: userId, type: "private" }) => queue.push({ update_id: updateId++, message: { message_id: messageId++, from: { id: userId, first_name: "U" }, chat, text } }),
		callback: (userId: number, data: string) => queue.push({ update_id: updateId++, callback_query: { id: `cb${updateId}`, from: { id: userId }, data } }),
		close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
	};
}

test("telegram: only allow-listed users are heard, answers go only to allow-listed chats, approvals work by button", async (t) => {
	const tg = await fakeTelegram();
	t.after(() => tg.close());
	const h = await harness({
		pine: { plugins: [{ use: "pine:telegram", options: { pollTimeoutSec: 0, accounts: { main: { token: TOKEN, allow: [1001], agent: "main", apiBase: tg.apiBase } } } }] },
		agents: { main: { agent: { approve: ["bash:*rm *"] } } },
	});

	tg.message(2002, "I am a stranger, run rm -rf /");
	tg.message(1001, "hello", { id: -777, type: "group" });
	await sleep(150);
	assert.equal(h.pine.tasks.list({}).length, 0, "strangers and unlisted groups start nothing");
	assert.equal(tg.calls.length, 0, "and get no answer");

	tg.message(1001, "hello pine");
	await until(() => tg.sent().length === 1, 5000, "the answer");
	assert.deepEqual(tg.sent()[0], { chat_id: 1001, text: "ECHO[hello pine]" });
	assert.ok(tg.calls.some((c) => c.method === "sendChatAction" && c.body.action === "typing"));
	const task = h.pine.tasks.list({})[0];
	assert.deepEqual([task.session, task.meta.trust, task.agent], ["tg-1001", "owner", "main"]);
	const e = h.pine.bus.query({ topic: "telegram/main/message" })[0];
	assert.equal(e.trust, "owner");

	h.pine.bus.publish("out/telegram/main", { chatId: 31337, text: "exfiltrated" });
	h.pine.bus.publish("out/telegram/main", { text: "to the owner by default" });
	await until(() => tg.sent().length === 2);
	assert.deepEqual(tg.sent()[1], { chat_id: 1001, text: "to the owner by default" });
	assert.ok(h.logs.some((l) => /chat 31337 is not on the allow list/.test(l)));

	// An agent tool that reaches the owner, and an approval answered with the inline button.
	tg.message(1001, mockMsg([{ tools: [{ name: "telegram_send", args: { text: "heads up" } }, { name: "bash", args: { command: "touch victim; rm victim; echo removed" } }] }]));
	await until(() => tg.sent().some((m) => /Approval needed/.test(m.text)), 5000, "the approval question");
	const question = tg.sent().find((m) => /Approval needed/.test(m.text));
	assert.ok(question.text.includes("bash: touch victim; rm victim") && question.chat_id === 1001);
	const [allow, deny] = question.reply_markup.inline_keyboard[0];
	assert.deepEqual([allow.text, deny.text], ["Allow", "Deny"]);
	tg.callback(2002, allow.callback_data);
	await sleep(120);
	assert.equal(h.pine.approvals.pending().length, 1, "a stranger cannot approve");
	tg.callback(1001, allow.callback_data);
	await until(() => tg.sent().some((m) => m.text.startsWith("FINAL::") && m.text.includes("removed")), 5000, "the approved command's result");
	assert.ok(tg.sent().some((m) => m.text === "heads up"), "the agent's own message to the owner arrived");
	assert.ok(tg.calls.some((c) => c.method === "editMessageReplyMarkup" && /Allowed \(telegram:1001\)/.test(JSON.stringify(c.body))));

	tg.message(1001, "/reset");
	await until(() => tg.sent().some((m) => m.text === "Started a fresh conversation."));
	assert.ok(!JSON.stringify(h.pine.bus.query({ limit: 500 })).includes(TOKEN), "the bot token is in no event");
	await h.close();
});

test("telegram refuses to start without an allow list", async () => {
	const h = await harness({ pine: { plugins: [{ use: "pine:telegram", options: { accounts: { main: { token: TOKEN } } } }] }, agents: { main: {} }, start: false });
	await assert.rejects(() => h.restart(), /"allow" must list at least one user id/);
	await h.close();
});

test("mqtt: broker messages become untrusted events; publishing is limited to listed topics", async (t) => {
	const broker = await Aedes.createBroker();
	const server = net.createServer(broker.handle);
	t.after(() => new Promise<void>((r) => broker.close(() => server.close(() => r()))));
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const url = `mqtt://127.0.0.1:${(server.address() as any).port}`;
	const h = await harness({
		pine: {
			plugins: [{ use: "pine:mqtt", options: { url, subscribe: [{ topic: "house/#" }, { topic: "noisy/+", minIntervalMs: 5000, persist: false }], publish: ["house/+/set"] } }],
			routes: [{ on: "mqtt/house/mode", set: { "house/mode": "{{payload.value}}" } }],
		},
		agents: { main: {} },
	});
	const outside = await mqtt.connectAsync(url);
	const got: Array<[string, string]> = [];
	await outside.subscribeAsync("house/#");
	outside.on("message", (t, m) => void got.push([t, m.toString()]));
	await until(() => h.logs.some((l) => /connected to 127.0.0.1/.test(l)));
	await sleep(40);

	const seen = h.pine.bus.waitFor("mqtt/house/door");
	await outside.publishAsync("house/mode", "away");
	await outside.publishAsync("house/door", JSON.stringify({ open: true }));
	const e = await seen;
	assert.deepEqual(e.payload, { topic: "house/door", value: { open: true } });
	assert.equal(e.trust, "untrusted");
	await until(() => h.pine.state.get("house/mode") === "away");
	let noisy = 0;
	h.pine.bus.subscribe("mqtt/noisy/a", () => void noisy++);
	for (let i = 0; i < 5; i++) await outside.publishAsync("noisy/a", String(i));
	await sleep(60);
	assert.equal(noisy, 1, "a chatty topic is rate-limited");
	assert.equal(h.pine.bus.query({ topic: "mqtt/noisy/#" }).length, 0, "and kept out of the log");

	const r = await h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: [{ name: "mqtt_publish", args: { topic: "house/lamp/set", message: '{"state":"ON"}' } }, { name: "mqtt_publish", args: { topic: "garage/door/set", message: "OPEN" } }] }]), trust: "owner" });
	assert.ok(r.text.includes("published to house/lamp/set") && /"garage\/door\/set" is not on the publish list/.test(r.text), r.text);
	h.pine.bus.publish("out/mqtt", { topic: "garage/door/set", message: "OPEN" });
	await sleep(60);
	assert.deepEqual(got.filter(([t]) => t.endsWith("/set")), [["house/lamp/set", '{"state":"ON"}']]);
	await outside.endAsync();
	await h.close();
});

test("watch: a new file becomes an event, and an image in a watched folder reaches the model", async () => {
	const h = await harness({
		pine: { plugins: [{ use: "pine:watch", options: { watches: [{ name: "cam", dir: "./drop", pattern: "\\.(png|jpg)$", settleMs: 40 }] } }], routes: [{ on: "file/cam/added", agent: "main", session: "new", prompt: "A camera saved {{payload.file}}. What do you see?" }, { on: "file/cam/added", call: { prompt: "Classify {{payload.file}}" }, publish: { topic: "cam/classified" } }] },
		files: { "drop/.keep": "" },
		agents: { main: {} },
	});
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
	await sleep(150); // the OS needs a moment before a new watcher reports changes
	fs.writeFileSync(path.join(h.home, "drop", "ignored.txt"), "x");
	fs.writeFileSync(path.join(h.home, "drop", "front-001.png"), png);
	await until(() => h.pine.tasks.list({ status: "done" }).length === 1 && h.pine.bus.query({ topic: "cam/classified" }).length === 1, 6000, "the camera event to be handled");
	const callReq = h.mock.state.requests.find((q: any) => !q.body.tools);
	assert.equal(callReq.body.messages.at(-1).content.filter((p: any) => p.type === "image_url").length, 1, "a single model call gets the image too");
	const e = h.pine.bus.query({ topic: "file/cam/added" });
	assert.equal(e.length, 1);
	assert.deepEqual([(e[0].payload as any).file, (e[0].payload as any).size, e[0].trust], ["front-001.png", png.length, "untrusted"]);
	const content = h.mock.state.requests.find((q: any) => q.body.tools).body.messages.find((m: any) => m.role === "user").content;
	assert.equal(content.filter((p: any) => p.type === "image_url").length, 1);
	assert.ok(content.find((p: any) => p.type === "text").text.includes("A camera saved front-001.png"));
	assert.equal(h.pine.tasks.list({})[0].session.startsWith("_t"), true);
	await h.close();
});
