import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createManual, loadManual, partsOf, showRead, showSearch, stem } from "../src/manual.ts";
import { harness, mockMsg } from "./support/harness.ts";

const run = promisify(execFile);
const CLI = path.resolve(import.meta.dirname, "../src/cli.ts");
const DOCS = path.resolve(import.meta.dirname, "../docs");

test("manual: a file is cut into a part per heading and a part per row that describes a named thing", () => {
	const parts = partsOf(
		"demo",
		"---\nname: demo\n---\n\n# Demo\n\nIntro.\n\n## Keys\n\n| Key | Default | Meaning |\n|---|---|---|\n| `bashTimeoutSec` | `300` | Longest shell command. |\n| plain | x | not a named thing |\n\n```md\n## not a heading\n```\n\n### Deeper\n\nText.\n\n## Keys\n\nAgain.\n",
	);
	assert.deepEqual(parts.map((p) => [p.id, p.kind, p.path.join(" › ")]), [
		["demo", "section", "Demo"],
		["demo#keys", "section", "Demo › Keys"],
		["demo#keys/bashtimeoutsec", "row", "Demo › Keys › bashTimeoutSec"],
		["demo#deeper", "section", "Demo › Keys › Deeper"],
		["demo#keys-2", "section", "Demo › Keys"],
	]);
	assert.equal(parts[2].text, "`bashTimeoutSec`\nDefault: `300`\nMeaning: Longest shell command.");
	assert.ok(parts[1].text.includes("## not a heading"), "a heading inside a code block is text");
	assert.deepEqual(parts[1].children, ["demo#deeper"]);
	assert.deepEqual(["subscribes", "subscribed", "subscribing", "subscribe"].map(stem), ["subscrib", "subscrib", "subscrib", "subscrib"]);
	assert.deepEqual(["schedules", "scheduled", "scheduling", "policies", "boxes"].map(stem), ["schedul", "schedul", "schedul", "policy", "box"]);
});

test("manual: questions in an agent's own words find the part of pine's manual that answers them", () => {
	const manual = createManual(loadManual(DOCS));
	assert.ok(manual.parts.length > 300, `${manual.parts.length} parts`);
	const top = (q: string, n = 3) => manual.search(q, n).hits.map((h) => h.id);
	// [what is asked, a part that must be among the first three]
	const cases: Array<[string, RegExp]> = [
		["telegram pairing code", /^sources#telegram$/],
		["remind me every morning at seven", /^events#(ask-the-agent|in-the-files|schedules)/],
		["cron job", /^(events#|operations#coming-from-openclaw)/],
		["set a reminder in 20 minutes", /^events#ask-the-agent/],
		["bashTimeoutSec", /^configuration#.*bashtimeoutsec$/],
		["bashtimeoutsec", /^configuration#.*bashtimeoutsec$/],
		["add_schedule", /add-schedule$|^events#ask-the-agent/],
		["who may set something up for all agents", /^setup(#who-can-set-up-what|#three-scopes)?$|^sources#ask-the-agent$/],
		["where do passwords and tokens go", /^sources#secrets|^configuration#secrets/],
		["watch a website for a price", /^sources#http$/],
		["run a command again and again to check disk space", /^sources#command$/],
		["device with its own protocol new kind of source", /^sources#(a-source-type-of-your-own|ask-the-main-agent)/],
		["what counts as outside content", /^security#|^sources#trust/],
		["approval dialog always allow in this conversation", /^(security#4|tui#approvals)/],
		["write down how to do something as a skill", /^agents#(skills|ask-the-agent)/],
		["sub-agents in parallel", /^agents#sub-agents/],
		["hand work to another agent", /^agents#handing-work-to-another-agent/],
		["open a project folder for a conversation", /^coding#a-folder-for-a-conversation/],
		["what is manual auto bypass mode", /^(security#modes|tui#modes)/],
		["mqtt publish to a device", /^sources#(mqtt|sending-through-a-source)/],
		["poll failed looks back off", /^sources#looking-again-and-again/],
		["create a new agent", /^(setup#creating-an-agent|agents#creating-an-agent)/],
		["what happens when a conversation is removed", /^(setup#|tui#|agents#sessions)/],
		["connect an mcp server", /^(mcp#|setup#)/],
		["look at my dev server on localhost in the browser", /^mcp#local-addresses$/],
		["browser refused not reachable local address", /^(mcp#local-addresses|operations#)/],
		// The first words of agents that knew nothing about pine, from runs with puzzles.
		["stretch reminder working days 6 pm recurring", /^events#ask-the-agent/],
		["nag stretch 6 pm every working day reminder", /^events#ask-the-agent/],
		["telegram stranger unknown sender bot owner connected", /^sources#telegram$/],
		["one-off reminder missed pine not running startup", /^events#(ask-the-agent|in-the-files)/],
		["watcher all agents main agent", /^setup#(who-can-set-up-what|three-scopes)|^sources#ask-the-agent/],
		["shell command timeout default seconds per agent", /^configuration#/],
		["skill single conversation location on disk", /^(setup#what-is-written|agents#)/],
		["code pane open terminal columns beside conversation", /^coding#the-code-pane/],
		["web address watch failed checks unreachable down up", /^sources#http/],
		["pine schedules list scheduled command", /^(operations#commands|events#ask-the-agent)/],
		["shell command list every skill list scheduled tasks", /^operations#commands/],
		["conversation removed renamed sources set up for one conversation", /^setup#(three-scopes|what-is-written)/],
		["sub-agents helpers run at the same time default concurrency", /^(agents#sub-agents|configuration#working-with-other-agents)/],
		["model runs agent no model named default model", /^configuration#/],
		["notify owner phone message away push", /^sources#(telegram|sending-through-a-source)/],
		["autonomy levels without asking", /^(security#modes|tui#modes)/],
		["drag folder onto terminal window drop", /^(coding#a-folder-for-a-conversation|tui#attachments)/],
	];
	const missed = cases.filter(([q, want]) => !top(q).some((id) => want.test(id))).map(([q]) => `${q} → ${top(q).join(", ")}`);
	assert.deepEqual(missed, []);

	// A row answers by itself; a section with the sentence that matched.
	const key = manual.search("bashTimeoutSec").hits[0];
	assert.match(key.line, /`bashTimeoutSec` · Default: from `defaults` · Meaning: Longest shell command\./);
	assert.match(manual.search("looking again failed look").hits[0].line, /failed look/i);
	// Nothing found is said as what it is, and never as "pine cannot".
	assert.match(showSearch(manual, ["zzzqqq"]), /nothing in the manual has these words\. That does not mean pine cannot do it/);
	assert.equal(manual.search("the of and").hits.length, 0);
	// Reading: a part in full with what lies below it, a long one in pages, a wrong id with what is close.
	const read = showRead(manual, ["sources#telegram"]);
	assert.ok(read.startsWith("## sources#telegram   (sources.md › The built-in types › telegram)") && read.includes("six-digit code"));
	assert.match(showRead(manual, ["configuration#tools-and-extensions/bashtimeoutsec"]), /\(This is one row of a table in configuration#tools-and-extensions\. Read that part for what stands around it\.\)$/);
	assert.match(showRead(manual, ["sources"]), /Parts below this one: sources#a-first-example, sources#configuring-sources/);
	const long = createManual(partsOf("long", `# Long\n\n${Array.from({ length: 300 }, (_, i) => `Paragraph ${i} of a long part.\n`).join("\n")}`));
	assert.match(showRead(long, ["long"]), /^## long   \(long\.md › Long, page 1 of 2\)[\s\S]*\(continues: read long@2\)$/);
	assert.match(showRead(long, ["long@2"]), /page 2 of 2\)[\s\S]*Paragraph 299 of a long part\.$/);
	assert.match(showRead(manual, ["telegram"]), /^## sources#telegram/, "the last piece of an id is enough when it is the only one");
	assert.match(showRead(manual, ["sources#telegramm"]), /"sources#telegramm" is not a part of the manual\. Close to it: [^\n]*sources#telegram/);
	assert.match(manual.contents(), /^pine: pine\n[\s\S]*\nsources: Event sources and subscriptions\n    sources#a-first-example/);
});

test("manual: every agent has it as a tool instead of a skill in its prompt, and pine manual is the same search in a shell", async () => {
	const h = await harness({ pine: { main: "main", sourceTypes: { bell: "./sources/bell.ts" } }, files: { "sources/bell.ts": `export const type = { summary: "a doorbell on the network", options: { type: "object", properties: { url: { type: "string", description: "its address" } }, required: ["url"] } };\nexport default function () {}\n` }, agents: { main: {} } });
	const call = (args: any) => ({ name: "manual", args });
	await h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: [call({ search: "telegram pairing code" }), call({ search: ["doorbell", "bashTimeoutSec"] }), call({ read: "sources#telegram" }), call({})] }]), trust: "owner" });
	const [one, two, read, all] = h.toolResults().slice(-4);
	assert.match(one, /^"telegram pairing code": \d of \d+ parts, the best first\n1\. sources#telegram /);
	assert.match(two, /"doorbell": [^\n]*\n1\. source-type#bell   \(this pine › bell, registered in this pine\)\n   `bell`: a doorbell on the network · Options: url \(required\): its address/, "what this installation has beyond the manual is found too");
	assert.match(two, /"bashTimeoutSec": [^\n]*\n1\. configuration#/);
	assert.ok(read.startsWith("## sources#telegram") && all.startsWith("The parts of pine's manual."));
	const req = h.mock.state.requests[0];
	assert.ok(h.toolsOffered(req).includes("manual"));
	assert.ok(!h.system(req).includes("<name>pine</name>"), "the manual is not carried in the prompt");
	assert.ok(h.system(req).length < 9000, `the fixed part of a prompt stays small: ${h.system(req).length}`);
	await h.close();

	const found = await run(process.execPath, [CLI, "manual", "telegram", "pairing"]);
	assert.match(found.stdout, /^"telegram pairing": \d of \d+ parts, the best first\n1\. sources#telegram /);
	const part = await run(process.execPath, [CLI, "manual", "--read", "sources#telegram"]);
	assert.ok(part.stdout.startsWith("## sources#telegram"));
});
