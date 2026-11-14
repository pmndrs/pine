import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { harness, mockMsg, sleep, until } from "./support/harness.ts";
import { httpMcp } from "./support/http-mcp.ts";

const owner = { trust: "owner" as const };
const call = (name: string, args: any = {}) => ({ name, args });
const userText = (req: any) => {
	const m = req.body.messages.filter((x: any) => x.role === "user").at(-1);
	const text = typeof m.content === "string" ? m.content : m.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
	return text.replace(/<pine-note>[\s\S]*?<\/pine-note>\s*/g, "");
};

// The four things an agent can be given. For each: what it has is listed by a tool, it is added
// by a tool, it does what it is for, and it is removed by a tool, after which the list and the
// agent's file are as they were. Nothing of it needs a look into pine's files.
test("given: an MCP server, a skill, an event source and a schedule are each listed, added, used and removed by tool call", async (t) => {
	const stub = await httpMcp();
	t.after(() => stub.close());
	const h = await harness({ pine: { main: "main" }, agents: { main: {} } });
	const asked: any[] = [];
	h.pine.bus.subscribe("approval/requested", (e) => {
		asked.push(e.payload);
		h.pine.approvals.decide((e.payload as any).id, true, "test");
	});
	const idle = () => until(() => !h.pine.tasks.list({}).some((x: any) => x.status === "pending" || x.status === "running"), 6000, "the agent to be done");
	const run = async (tools: any[]) => {
		const r = await h.pine.agents.run({ agent: "main", session: "work", prompt: mockMsg([{ tools }]), ...owner });
		return { text: r.text, results: h.toolResults() };
	};
	const woken = () => h.pine.tasks.list({}).filter((x: any) => x.kind === "event" && x.agent === "main" && x.session === "work" && x.status === "done");
	const file = () => JSON.parse(fs.readFileSync(path.join(h.home, "agents", "main", "agent.json"), "utf8"));
	const pristine = file();
	const lists = [call("mcp_servers"), call("skills"), call("sources"), call("schedules")];
	const empty = [/^This conversation has no MCP servers\./, /^This conversation has no skills\./, /^No event sources exist yet/, /^Nothing is scheduled\./];

	// The agent has all four lists, and the prompt tells it to ask them.
	let r = await run(lists);
	r.results.slice(-4).forEach((result: string, i: number) => assert.match(result, empty[i]));
	const first = h.mock.state.requests.at(-1);
	for (const name of ["mcp_servers", "skills", "sources", "schedules"]) assert.ok(h.toolsOffered(first).includes(name), name);
	assert.match(h.system(first), /What you have of each, and whom it is for, a tool tells you: sources \(event sources and subscriptions\), mcp_servers, skills, schedules\.|What you have of each, pine_list tells you: when your owner asks about one of them, ask for that one list and answer from it, and never guess it\./);

	// ---- an MCP server
	r = await run([call("add_mcp_server", { name: "notes", url: stub.url, description: "the owner's notes" })]);
	assert.match(r.text, /Added "notes" for this conversation/);
	await idle();
	r = await run([call("mcp_servers"), call("mcp__notes__lookup", { q: "rent" })]);
	assert.match(r.results.at(-2)!, /^Your MCP servers in this conversation:\n- notes \(http[^)]*\): the owner's notes\n    only this conversation has it; connected, 1 tool in your tool list, starting with mcp__notes__/);
	assert.match(r.results.at(-1)!, /looked up: rent/);
	r = await run([call("remove_mcp_server", { name: "notes" })]);
	assert.match(r.results.at(-1)!, /Removed the MCP server "notes"\./);
	assert.match((await run([call("mcp_servers")])).results.at(-1)!, empty[0]);
	r = await run([call("mcp__notes__lookup", { q: "rent" })]);
	assert.match(r.results.at(-1)!, /Tool mcp__notes__lookup not found/, "and its tools are gone with it");

	// ---- a skill
	r = await run([call("add_skill", { name: "invoices", description: "File an invoice. Use when a PDF invoice arrives.", instructions: "1. Read the total.\n2. Move it to books/." })]);
	const at = /It is at (\S+\/SKILL\.md)\./.exec(r.results.at(-1)!)?.[1];
	assert.ok(at, String(r.results.at(-1)));
	r = await run([call("skills"), call("read", { path: at })]);
	assert.match(r.results.at(-2)!, /^Your skills in this conversation[^\n]*:\n- invoices: File an invoice\. Use when a PDF invoice arrives\.\n    only this conversation has it\n/);
	assert.match(r.results.at(-1)!, /1\. Read the total\./, "the agent reads its instructions when a task calls for it");
	assert.match(h.system(h.mock.state.requests.at(-1)), /<name>invoices<\/name>/, "and its name and line are in front of it");
	r = await run([call("remove_skill", { name: "invoices" })]);
	assert.match(r.results.at(-1)!, /Removed the skill "invoices"/);
	assert.match((await run([call("skills")])).results.at(-1)!, empty[1]);
	assert.ok(!fs.existsSync(at!));

	// ---- an event source, and being woken by it
	const inbox = path.join(h.workspace("main"), "inbox");
	fs.mkdirSync(inbox);
	r = await run([call("add_source", { name: "papers", type: "folder", options: { dir: "inbox", settle: "50ms" }, description: "scanned papers", note: "Say which paper arrived.", throttle: "0s" })]);
	assert.match(r.results.at(-1)!, /Added the event source "papers" \(folder\)\. It is this conversation's own/);
	r = await run([call("sources")]);
	assert.match(r.results.at(-1)!, /papers \(folder: scanned papers\) - [^\n]*\n    local: THIS conversation is subscribed and is woken here\. Note: Say which paper arrived\./);
	await sleep(150);
	fs.writeFileSync(path.join(inbox, "bill.pdf"), "%PDF");
	await until(() => woken().length === 1, 6000, "the file to wake the conversation");
	const heard = h.mock.state.requests.find((q: any) => userText(q).includes("bill.pdf"));
	assert.ok(heard && userText(heard).includes("Say which paper arrived."), "woken with the event and the note");
	r = await run([call("remove_source", { name: "papers" })]);
	assert.match(r.results.at(-1)!, /Removed the event source "papers"/);
	assert.match((await run([call("sources")])).results.at(-1)!, empty[2]);
	fs.writeFileSync(path.join(inbox, "late.pdf"), "%PDF");
	await sleep(400);
	assert.equal(woken().length, 1, "a removed source wakes nobody");

	// ---- a schedule
	await run([call("add_schedule", { name: "ping", task: "Say that it is time.", every: "1m" })]);
	r = await run([call("schedules")]);
	assert.match(r.results.at(-1)!, /^1 schedule\.\n/);
	assert.match(r.results.at(-1)!, /ping \(this conversation\): every 1m[^\n]*\n    Task: Say that it is time\./);
	await run([call("add_schedule", { name: "soon", task: "Remind the owner of the dentist.", in: "300ms" })]);
	await until(() => woken().length === 2, 6000, "the reminder");
	assert.ok(h.mock.state.requests.some((q: any) => userText(q).endsWith("Remind the owner of the dentist.")), "woken with the task");
	await idle();
	r = await run([call("remove_schedule", { name: "ping" })]);
	assert.match(r.results.at(-1)!, /ping/);
	assert.match((await run([call("schedules")])).results.at(-1)!, empty[3], "the one removed is gone, and the one that fired removed itself");

	// Everything is as it was. A server is always put to the owner; the rest was the conversation's
	// own business until the file from the folder arrived: that is outside content, and from
	// then on what changes the setup is the owner's to confirm.
	assert.deepEqual(file(), pristine);
	assert.deepEqual(asked.map((a) => `${a.tool}: ${String(a.summary).split("\n")[0]}`), [
		'add_mcp_server: add MCP server "notes" for this conversation of main only',
		'remove_source: remove the event source "papers" of agent main',
		'add_schedule: add the schedule "ping" for this conversation of main only',
		'add_schedule: add the schedule "soon" for this conversation of main only',
		'remove_schedule: remove the schedule "ping" of agent main',
	]);
	await h.close();
});
