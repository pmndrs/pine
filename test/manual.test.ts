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
		["my owner wants an agent deleted together with its folder", /^(setup#(changing-and-removing-an-agent|the-main-agent-administers-pine|the-tools)|pine#if-you-are-an-agent-running-inside-pine)/],
		["give another agent a different model and let it read a folder", /^setup#(changing-and-removing-an-agent|the-main-agent-administers-pine|the-tools)/],
		["set up a schedule for another agent instead of for myself", /^setup#(the-main-agent-administers-pine|the-tools|who-can-set-up-what)/],
		["add a rule that wakes an agent only when the door opens while nobody is home", /^(events#|setup#routes)/],
		["remove an agent from the command line", /^(operations#|setup#changing-and-removing-an-agent)/],
		["update an agent's settings from the command line", /^(setup#(the-main-agent-administers-pine|changing-and-removing-an-agent)|operations#commands)/],
		["switch the reviewer off for all agents", /^(setup#(pine-s-settings|the-tools|the-main-agent-administers-pine)|configuration#|security#)/],
		["my owner was asked to let me read a folder although I never asked for it", /^(security#(when-a-call-needs-something-outside|modes-how-much-an-agent-does-without-asking)|operations#problems)/],
		["ls says no such file for a folder in my owner's home that I wrote with ~", /^(security#when-a-call-needs-something-outside|operations#problems)/],
		["a command was refused a file it did not name, what happens then", /^security#when-a-call-needs-something-outside/],
		["how do I turn off the question pine asks itself when a command needs a folder outside the sandbox", /^(configuration#pine-json|security#when-a-call-needs-something-outside)/],
		["how do I see what the model was thinking before it answered", /^tui#what-a-model-thinks/],
		["the context window is nearly full, how do I shorten the conversation", /^tui#(commands|mouse)/],
		["save the conversation as a file", /^tui#commands/],
		["keep track of the steps of a long task so I do not lose my place", /^(setup#the-tools|tui#the-agent-s-list-of-steps)/],
		["let my owner choose between two options before I go on", /^(setup#the-tools|tui#when-the-agent-asks)/],
		["can the agent only propose what it would do, without changing any file yet", /^(tui#modes|security#|configuration#)/],
		["how do I point the agent at one file and a few lines of it", /^tui#pointing-at-a-file/],
		["tell me with a sound when the agent has finished", /^tui#commands/],
		["open the browser so my owner can see it and log in", /^mcp#seeing-the-browser/],
		["is the browser headless", /^mcp#(seeing-the-browser|bundled-browser)/],
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
		["the agent messed up my files with its last change, how do I get them back the way they were", /^coding#(taking-a-message-back|what-is-restored)/],
		["revert what the agent just did and ask again differently", /^(coding#(taking-a-message-back|what-is-restored)|tui#commands\/undo)/],
		["/redo", /redo$/],
		["what is manual auto bypass mode", /^(security#modes|tui#modes)/],
		["mqtt publish to a device", /^sources#(mqtt|sending-through-a-source)/],
		["poll failed looks back off", /^sources#looking-again-and-again/],
		["create a new agent", /^(setup#creating-an-agent|agents#creating-an-agent)/],
		["what happens when a conversation is removed", /^(setup#|tui#|agents#sessions)/],
		["connect an mcp server", /^(mcp#|setup#)/],
		["which mcp servers do you have", /^(setup#the-tools|setup#what-an-agent-has|mcp)/],
		["list what I have been given", /^setup#what-an-agent-has/],
		["the server shows as connected but the agent says it does not have its tools", /^(mcp#|setup#the-tools)/],
		["the tool gave a file path but cp says no such file or directory", /^mcp#files-and-pictures-from-a-remote-server$/],
		["copy the file a remote mcp server made into my workspace", /^(mcp#files-and-pictures-from-a-remote-server|setup#the-tools)/],
		["play audio so that I can hear it", /^(tui#|agents#)/],
		["can pine play speech or music", /^(tui#|agents#)/],
		["install a local mcp server with npx command", /^(mcp#adding-a-server|setup#the-tools)/],
		["look at my dev server on localhost in the browser", /^mcp#local-addresses$/],
		["click a button in an application on my mac", /^(computer|mcp#bundled-computer)/],
		["control the desktop and use native programs", /^(computer|mcp#bundled-computer)/],
		["read what a window of TextEdit shows as text", /^computer#(two-ways-to-work|the-tools)/],
		["app_click", /^computer#the-tools\/app-click$/],
		["macos does not let pine operate apps accessibility permission", /^computer#(what-macos-has-to-be-told-once|when-something-does-not-work)/],
		["screen recording permission for screenshots", /^computer#(what-macos-has-to-be-told-once|when-something-does-not-work)/],
		["why does my agent not have the tools to operate apps", /^computer#(who-has-it|when-something-does-not-work)/],
		["how often am I asked before the agent uses an app", /^(computer#what-the-owner-is-asked|security#)/],
		["model cannot see pictures leave out screenshot tools", /^computer#options/],
		["app control on linux", /^(computer|mcp#bundled-computer)/],
		["swift compiler missing xcode command line tools", /^computer#(the-helper-and-what-it-needs|when-something-does-not-work)/],
		["kill operation not permitted cannot stop dev server it started", /^(operations#|security#the-whole-account)/],
		["let the agent work in my other projects and home folder", /^(security#(the-whole-account|3)|configuration#.*scope)/],
		["asked whether it keeps my whole account after reading a web page", /^(security#(after-outside-content-the-reviewer|the-whole-account)|tui#modes)/],
		["agent limited to its workspace after it read the web how do I give it back its rights", /^(security#after-outside-content-the-reviewer|operations#problems)/],
		["why was my command blocked by the reviewer and how do I allow it", /^(security#after-outside-content-the-reviewer|operations#problems|coding#the-code-pane)/],
		["security.review", /^configuration#.*security-review$/],
		["which model checks the agent's actions", /^(configuration#.*security-reviewer$|security#after-outside-content-the-reviewer)/],
		["defaults.mode", /^configuration#.*defaults-mode$/],
		// The mode is what says whether an agent works in a sandbox: asked by somebody who does not know that.
		["switch the sandbox off for an agent", /^(security#(3-the-sandbox|modes)|configuration#containment\/(mode|sandbox)|tui#modes)/],
		["which mode keeps an agent inside its own folders", /^(security#(3-the-sandbox|modes)|tui#modes)/],
		["give another agent my whole account like the main agent has", /^(setup#changing-and-removing-an-agent|security#(the-whole-account|modes|3-the-sandbox)|tui#modes|computer#who-has-it)/],
		["can an agent read pine's .env or token when it has no sandbox", /^security#(the-whole-account|pine-s-own-files-without-a-sandbox)/],
		["pine in docker without a sandbox what happens to the agents", /^(operations#in-a-container|security#(3-the-sandbox|on-linux))/],
		["which servers did the agent leave running and how do I stop them", /^(coding#what-an-agent-left-running|coding#the-code-pane|setup#the-tools)/],
		["stop_program", /stop-program$/],
		["run a long build without waiting for it to finish", /^coding#commands-in-the-background/],
		["run a command async and be notified when it finishes", /^coding#commands-in-the-background/],
		["command takes longer than the time limit", /^coding#commands-in-the-background/],
		["background", /^coding#commands-in-the-background\/background$/],
		["mcp server needs an api key", /^(mcp#adding-a-server|setup#the-tools)/],
		["cannot write MEMORY.md holds agent instructions outside content", /^(security#(4-taint-and-approvals|after-outside-content-the-reviewer)|agents#)/],
		["new mcp tools not visible need a new chat", /^(mcp#adding-a-server|setup#)/],
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
		// Goal mode, asked for by somebody who does not know what it is called.
		["make the agent keep working by itself until the job is finished without me saying go on", /^(agents#goal-mode|tui#goals)/],
		["work autonomously towards an objective overnight", /^(agents#goal-mode|tui#goals)/],
		["the agent stops after each step and asks shall I go on", /^(agents#goal-mode|tui#goals|operations#problems)/],
		["who checks whether the objective is reached", /^(agents#goal-mode|tui#goals)/],
		["/goal", /^(agents#goal-mode|tui#goals|tui#commands\/goal)/],
		["limits.goalRounds", /^configuration#.*limits-goalrounds$/],
		["limits.goalIdleRounds", /^configuration#.*limits-goalidlerounds$/],
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
