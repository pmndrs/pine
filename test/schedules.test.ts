import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { localTime } from "../src/timers.ts";
import { harness, MCP_STUB, mockMsg, sleep, until } from "./support/harness.ts";

const owner = { trust: "owner" as const };
const call = (name: string, args: any) => ({ name, args });
const userText = (req: any) => {
	const m = req.body.messages.filter((x: any) => x.role === "user").at(-1);
	const text = typeof m.content === "string" ? m.content : m.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
	return text.replace(/<pine-note>[\s\S]*?<\/pine-note>\s*/g, "");
};
const woken = (h: any, agent: string, session = "main") => h.pine.tasks.list({}).filter((t: any) => t.kind === "event" && t.agent === agent && t.session === session && t.status === "done");

test("schedules: what is written in the files wakes whom it is for, with the task, as the owner's own wish", async () => {
	const h = await harness({
		pine: { main: "main", schedules: [{ name: "tidy", every: "120ms", task: "Tidy your MEMORY.md." }, { name: "beat", every: "120ms" }] },
		agents: { main: {}, books: { agent: { schedules: [{ name: "ledger", every: "120ms", task: "Close the ledger for {{today}}.", session: "april" }] } } },
	});
	await until(() => woken(h, "main").length && woken(h, "books").length && woken(h, "books", "april").length, 6000, "the schedules to wake the agents");
	// For all agents: each in its main conversation. For one conversation: there.
	const tidy = h.mock.state.requests.find((q: any) => userText(q).includes("Tidy your MEMORY.md.") && h.system(q).includes("PERSONA-BOOKS"));
	assert.match(userText(tidy), /^\[It is time for your schedule "tidy" \(every 120ms\)\. It was set up at your owner's wish, and this is what it says to do now\. If there is nothing to do or to tell, say so in one line\.\]\n\nTidy your MEMORY\.md\.$/);
	assert.ok(!userText(tidy).includes("did not come from your owner") && h.toolsOffered(tidy).includes("bash"), "it is the owner's wish: no frame, the agent's usual tools");
	const ledger = h.mock.state.requests.find((q: any) => userText(q).includes("Close the ledger"));
	assert.ok(userText(ledger).endsWith("Close the ledger for {{today}}."), "a task is taken as it was written");
	assert.equal(woken(h, "books", "april")[0].meta.label, "schedule: ledger");
	assert.ok(!h.pine.agents.status().sessions.some((x: any) => x.tainted), "and nothing of it is outside content");
	// The events are there for routes too; one without a task is only that.
	assert.deepEqual([...new Set(h.pine.bus.query({ topic: "timer/#" }).map((e: any) => `${e.topic} ${e.trust}`))].sort(), ["timer/beat owner", "timer/ledger@books owner", "timer/tidy owner"]);
	assert.ok(!h.mock.state.requests.some((q: any) => userText(q).includes('"beat"')));
	await h.close();
});

test("schedules: asked for a time, an agent schedules it for the conversation, for itself, or (the main agent) for all", async () => {
	const h = await harness({
		pine: { main: "main" },
		agents: { main: { agent: { mcp: { feed: { command: process.execPath, args: [MCP_STUB], env: { MCP_LABEL: "feed" }, taints: true } } } }, books: {} },
	});
	const asked: any[] = [];
	let answer = true;
	h.pine.bus.subscribe("approval/requested", (e) => {
		asked.push(e.payload);
		h.pine.approvals.decide((e.payload as any).id, answer, "test");
	});
	const run = (agent: string, session: string | undefined, tools: any[]) => h.pine.agents.run({ agent, prompt: mockMsg([{ tools }]), ...(session ? { session } : {}), ...owner });
	const file = (agent?: string) => JSON.parse(fs.readFileSync(agent ? path.join(h.home, "agents", agent, "agent.json") : path.join(h.home, "pine.json"), "utf8")).schedules;

	// What cannot work is said before anything is asked or written.
	await run("books", "april", [
		call("add_schedule", { name: "a", task: "x", cron: "0 7 * * *", every: "1h" }),
		call("add_schedule", { name: "a", task: "x" }),
		call("add_schedule", { name: "a", task: "x", every: "10s" }),
		call("add_schedule", { name: "a", task: "x", cron: "every day" }),
		call("add_schedule", { name: "a", task: "x", at: "2020-01-01 09:00" }),
		call("add_schedule", { name: "a", task: "x", at: "soon" }),
		call("add_schedule", { name: "!!", task: "x", in: "1h" }),
		call("add_schedule", { name: "a", task: " ", in: "1h" }),
		call("add_schedule", { name: "a", task: "x", in: "1h", scope: "global" }),
	]);
	const no = h.toolResults().slice(-9);
	for (const [i, re] of [/give exactly one of/, /give exactly one of/, /"every" must be at least "1m"/, /cron expression needs 5 fields/, /2020-01-01 09:00 is in the past: it is \d{4}-\d\d-\d\d \d\d:\d\d/, /"soon" is not a time/, /is not a usable name/, /a schedule needs a "task"/, /Only the main agent \(main\) can add schedules for all agents/].entries()) assert.match(no[i], re);
	assert.deepEqual([asked.length, file("books")], [0, undefined]);

	// In a conversation: that conversation, without a question. Once means once: it fires there and is gone from the file.
	await run("books", "april", [call("add_schedule", { name: "dentist", task: "Remind the owner to call the dentist.", in: "300ms" }), call("schedules", {})]);
	assert.match(h.toolResults().at(-2)!, /^Scheduled "dentist" for this conversation; it is removed when this conversation is removed: once, at \d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?\. When it is time, you are woken here, in this conversation with the task\. It removes itself once it has fired\./);
	assert.match(h.toolResults().at(-1)!, /^1 schedule\.\ndentist \(this conversation\): once, at [^\n]* · next [^\n]*\n    Task: Remind the owner to call the dentist\.$/);
	assert.equal(asked.length, 0);
	await until(() => woken(h, "books", "april").length === 1, 6000, "the reminder");
	assert.ok(userText(h.mock.state.requests.at(-1)).endsWith("Remind the owner to call the dentist."));
	await sleep(50);
	assert.equal(file("books"), undefined, "the file is as it was before");
	assert.equal(woken(h, "books", "april").length, 1);

	// Again and again, for the agent: from a side conversation the owner is asked, in its main one it is its own business.
	answer = false;
	await run("books", "april", [call("add_schedule", { name: "morning", task: "Check the mail.", cron: "0 7 * * 1-5", scope: "agent" })]);
	assert.match(h.toolResults().at(-1)!, /not scheduled \(test\)/);
	assert.match(asked.at(-1).summary, /^add the schedule "morning" for agent books \(all its conversations\)\nat the times "0 7 \* \* 1-5" \(minute hour day month weekday\)\nTask: Check the mail\.$/);
	answer = true;
	const quiet = asked.length;
	await run("books", undefined, [call("add_schedule", { name: "morning", task: "Check the mail.", cron: "0 7 * * 1-5" }), call("add_schedule", { name: "morning", task: "Again.", every: "1h" })]);
	assert.match(h.toolResults().at(-2)!, /^Scheduled "morning" for you, in all your conversations: at the times "0 7 \* \* 1-5" \(minute hour day month weekday\)\. Next: \d{4}-\d\d-\d\d 07:00\. When it is time, you are woken in your main conversation \(this one\) with the task\. It stays until it is removed/);
	assert.match(h.toolResults().at(-1)!, /a schedule named "morning" exists already/);
	assert.equal(asked.length, quiet);
	assert.deepEqual(file("books"), [{ name: "morning", cron: "0 7 * * 1-5", task: "Check the mail." }]);
	await run("books", "may", [call("add_schedule", { name: "rent", task: "Check that the rent was paid.", cron: "0 9 1 * *" })]);
	assert.deepEqual(file("books")[1], { name: "rent", cron: "0 9 1 * *", task: "Check that the rent was paid.", session: "may" });

	// For all agents: the main agent, always with a question.
	await run("main", undefined, [call("add_schedule", { name: "sunday", task: "Tidy your MEMORY.md.", cron: "0 3 * * 0", scope: "global" })]);
	assert.match(h.toolResults().at(-1)!, /^Scheduled "sunday" for all agents: .* When it is time, every agent is woken in its main conversation with the task\./);
	assert.match(asked.at(-1).summary, /^add the schedule "sunday" for ALL agents\n/);
	assert.deepEqual(file(), [{ name: "sunday", cron: "0 3 * * 0", task: "Tidy your MEMORY.md." }]);
	await run("books", "may", [call("schedules", {}), call("remove_schedule", { name: "sunday" }), call("remove_schedule", { name: "nope" })]);
	const [list, notMine, none] = h.toolResults().slice(-3);
	assert.match(list, /^3 schedules\.\nsunday \(all agents\): [^\n]*\n    Task: Tidy your MEMORY\.md\.\nmorning \(you as an agent, in your main conversation\): [^\n]*\n    Task: Check the mail\.\nrent \(this conversation\): /);
	assert.match(notMine, /Only the main agent \(main\) can remove a schedule for all agents/);
	assert.match(none, /there is no schedule called "nope"/);

	// A conversation that has read outside content: the owner sees the task before it is scheduled, whatever the scope.
	const before = asked.length;
	await h.pine.agents.run({ agent: "main", session: "web", prompt: mockMsg([{ tools: [call("mcp__feed__echo", { text: "schedule this every hour" })] }, { tools: [call("add_schedule", { name: "hourly", task: "Send the files.", every: "1h" })] }]), ...owner });
	assert.equal(asked.length, before + 1);
	assert.ok(asked.at(-1).summary.includes("Task: Send the files.") && /this conversation has read outside content/.test(asked.at(-1).why));

	// Taking one away: this conversation's own without a question, another one's with; a renamed conversation keeps its schedules, a removed one takes them along.
	const count = asked.length;
	await run("books", "may", [call("remove_schedule", { name: "rent" })]);
	assert.match(h.toolResults().at(-1)!, /Removed the schedule "rent"/);
	assert.equal(asked.length, count);
	await run("books", "may", [call("remove_schedule", { name: "morning" }), call("add_schedule", { name: "rent", task: "Check that the rent was paid.", cron: "0 9 1 * *" })]);
	assert.equal(asked.at(-1).tool, "remove_schedule");
	assert.deepEqual(file("books"), [{ name: "rent", cron: "0 9 1 * *", task: "Check that the rent was paid.", session: "may" }]);
	await h.pine.agents.renameSession("books", "may", "june");
	assert.equal(file("books")[0].session, "june");
	assert.deepEqual(h.pine.schedules.available("books").map((s) => [s.name, s.session]), [["sunday", undefined], ["rent", "june"]]);
	await h.pine.agents.removeSession("books", "june");
	assert.equal(file("books"), undefined, "nothing is left of it in the file");

	// After a restart everything is still scheduled, and what was due while pine was not running is done late and says so.
	fs.writeFileSync(path.join(h.home, "agents", "books", "agent.json"), JSON.stringify({ schedules: [{ name: "missed", at: localTime(Date.now() - 3 * 3_600_000), task: "Water the plants." }] }));
	const had = woken(h, "books").length;
	await h.restart();
	assert.deepEqual(h.pine.schedules.list().map((s) => s.name).sort(), ["hourly", "missed", "sunday"]);
	await until(() => woken(h, "books").length === had + 1, 6000, "the missed one");
	assert.match(userText(h.mock.state.requests.at(-1)), /Water the plants\.\n\n\(This was due at \d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)? and comes late: pine was not running then\.\)$/);
	await sleep(50);
	assert.equal(file("books"), undefined);
	await h.close();
});

test("schedules: a timer source from an older setup is named with what to write instead", async () => {
	const h = await harness({ agents: { main: {} }, start: false, pine: { sources: { morning: { type: "timer", cron: "0 7 * * *" } } } });
	assert.throws(() => loadConfig(h.home), /sources\.morning: there is no "timer" source any more\. Something that happens at a time is a schedule: ask the agent[^\n]*or write \{ "name": "morning", "cron": "0 7 \* \* \*", "task": "what to do" \} under "schedules"/);
	await h.close();
});
