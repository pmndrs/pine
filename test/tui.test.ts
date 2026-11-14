import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { PineTui, searchItems, urlAt } from "../src/tui/app.ts";
import { Client } from "../src/tui/client.ts";
import { harness, type Harness, MCP_STUB, mockMsg, notesOf, sleep, until } from "./support/harness.ts";
import { FakeTerminal, KEY } from "./support/terminal.ts";
import { sandboxAvailable } from "../src/security.ts";

// A failed assertion skips the test's own cleanup; an open UI would keep its event stream alive.
const apps: PineTui[] = [];
after(async () => {
	for (const app of apps) await app.stop().catch(() => {});
});

async function open(spec: Parameters<typeof harness>[0], size: [number, number] = [110, 30], extra: Partial<ConstructorParameters<typeof PineTui>[0]> = {}) {
	const h = await harness({ ...spec, pine: { main: "main", http: { port: 0 }, ...(spec.pine ?? {}) } });
	const term = new FakeTerminal(...size);
	let quit = false;
	const app = new PineTui({ client: new Client(`http://127.0.0.1:${h.pine.http!.port}`, h.pine.token), terminal: term, mode: "test", onQuit: () => void (quit = true), ...extra });
	apps.push(app);
	await app.start();
	const text = () => app.screen().join("\n");
	const send = async (line: string) => {
		term.type(line);
		term.type([KEY.enter]);
		await sleep(15);
	};
	const sees = (what: string | RegExp, ms = 4000) => until(() => (typeof what === "string" ? text().includes(what) : what.test(text())), ms, `the screen to show ${what}\n--- screen ---\n${text()}`);
	const close = async () => {
		await app.stop();
		await h.close();
	};
	return { h, term, app, text, send, sees, close, quit: () => quit };
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const done = (h: Harness, n: number) => until(() => h.pine.tasks.list({ status: "done" }).length >= n, 4000, `${n} finished tasks`);

test("tui: a conversation streams in, tools and delegated work are shown, and history returns on reopen", async () => {
	const t = await open({ agents: { main: { agent: { description: "front desk" } }, gonzo: { agent: { description: "law" } } } });
	await t.sees("main · front desk");
	assert.match(t.text(), /^ pine\s+1 main/m);

	await t.send("hello there");
	await t.sees("ECHO[hello there]");
	assert.equal(count(t.text(), "ECHO[hello there]"), 1, "a streamed answer is shown once");

	t.h.mock.state.scripts.child = [{ tools: [{ name: "bash", args: { command: "echo child-ran" } }] }];
	await t.send(mockMsg([{ text: "Let me check.", tools: [{ name: "bash", args: { command: "echo one" } }, { name: "delegate", args: { agent: "gonzo", task: "@@REF:child@@" } }] }, { text: "# Result\n\nAll **done**: item `a`" }]));
	await t.sees("All done: item a");
	await done(t.h, 3);
	// What it did on the way is one line under the message, and a click on that line shows all of it.
	await t.sees(/▸ 3 tool calls · bash ×2 · delegate · \d+s · click to open/);
	assert.ok(!t.text().includes("✓ bash echo one"), t.text());
	t.term.click(6, t.app.screen().findIndex((l) => l.includes("▸ 3 tool calls")));
	await t.sees("▾ 3 tool calls");
	const screen = t.text();
	for (const part of ["Let me check.", "✓ bash echo one", "✓ delegate gonzo", "↳ gonzo delegated task #3:", "✓ bash echo child-ran", "✓ gonzo delegated task #3 answered", "▸ open", "Result"]) assert.ok(screen.includes(part), `${part}\n${screen}`);
	assert.equal(count(screen, "All done: item a"), 1);
	assert.equal(count(screen, "**done**"), 1, "markdown is rendered; the raw form appears only in the prompt that was typed");
	assert.ok(!/working ·/.test(screen), "the status line is quiet when nothing runs");

	// A message that reaches the same session from somewhere else appears too.
	await t.h.pine.agents.run({ agent: "main", prompt: "sent from the api", trust: "owner" });
	await t.sees("[elsewhere] sent from the api");
	await t.sees("ECHO[sent from the api]");

	// Close the UI, open a new one: the conversation is still there.
	await t.app.stop();
	const again = new PineTui({ client: t.app.client, terminal: new FakeTerminal(110, 40) });
	await again.start();
	await until(() => again.screen().join("\n").includes("── now ──"));
	const restored = again.screen().join("\n");
	assert.ok(restored.includes("earlier in this session (3)") && restored.includes("ECHO[hello there]") && restored.includes("ECHO[sent from the api]"), restored);
	await again.stop();
	await t.h.close();
});

test("tui: tabs, slash commands and keys", async () => {
	const t = await open({ agents: { main: {}, gonzo: { agent: { description: "law" } } } });
	await t.sees("type a message");

	t.term.type("/");
	await t.sees(/help\s+Commands and keys/);
	t.term.type([KEY.esc]);
	t.term.type([KEY.ctrlC]);
	await t.send("/help");
	await t.sees("ctrl+t                 new conversation");
	await t.send("/nonsense");
	await t.sees("unknown command /nonsense");

	await t.send("/new notes");
	await t.sees(/1 main ×\s+2 main·notes ×/);
	await t.send("only in notes");
	await t.sees("ECHO[only in notes]");
	assert.equal(t.h.pine.tasks.list({})[0].session, "notes");

	t.term.type([KEY.tab]);
	await sleep(20);
	assert.ok(!t.text().includes("only in notes"), "each tab has its own transcript");
	t.term.type([KEY.tab]);
	await t.sees("only in notes");

	await t.send("/agent gonzo");
	await t.sees("gonzo · law");
	assert.match(t.text(), /3 gonzo/);
	await t.send("/model nope/nothing");
	await t.sees('model "nope/nothing" is not defined');

	// Modes: by command and by shift+tab; the bar at the bottom always shows the mode.
	await t.sees(/gonzo · main · no folder · mock\/m · reasoning off · safe/);
	t.term.type([KEY.shiftTab]);
	await t.sees("gonzo is now in manual mode");
	await t.sees(/gonzo · main · no folder · mock\/m · reasoning off · manual/);
	await t.send("/mode plan");
	await t.sees("gonzo is now in plan mode");
	await t.sees(/gonzo · main · no folder · mock\/m · reasoning off · plan/);
	assert.equal(t.h.pine.cfg.agents.gonzo.level, "manual", "plan lies on top of the mode the agent had: its sandbox stays that mode's");
	t.term.type([KEY.shiftTab]);
	await t.sees("gonzo is now in safe mode");
	await t.sees(/gonzo · main · no folder · mock\/m · reasoning off · safe/);
	await t.send("/mode bypass");
	await t.sees("gonzo is now in bypass mode");
	await t.sees(/gonzo · main · no folder · mock\/m · reasoning off · bypass/);
	assert.equal(t.h.pine.cfg.agents.gonzo.mode, "bypass");
	assert.equal(t.h.pine.cfg.agents.main.mode, "safe", "the mode belongs to one agent");
	await t.send("/mode auto");
	await t.sees("gonzo is now in auto mode");
	await t.send("/mode safe");
	await until(() => t.h.pine.cfg.agents.gonzo.mode === "safe");

	await t.send("/events");
	await t.sees(/4 events/);
	t.term.type([KEY.alt(1)]);
	await sleep(20);
	await t.send("ping");
	await done(t.h, 2);
	t.term.type([KEY.alt(4)]);
	await t.sees("agent/main/done");
	await t.send("typing here goes nowhere");
	await t.sees("this tab only shows events");

	t.term.type([KEY.ctrlW]);
	await sleep(20);
	assert.ok(!/4 events/.test(t.text()));
	t.term.type([KEY.alt(1)]);
	await t.send("/status");
	await t.sees("model slots 0/2 busy");
	await t.send("/reset");
	await t.sees("fresh conversation");
	await t.send("after reset");
	await t.sees("ECHO[after reset]");
	assert.equal(t.h.mock.state.requests.at(-1).body.messages.filter((m: any) => m.role === "user").length, 1, "the agent really started over");

	t.term.type([KEY.ctrlC]);
	await t.sees("press ctrl+c again to quit");
	assert.equal(t.quit(), false);
	t.term.type([KEY.ctrlC]);
	await until(() => t.quit());
	await t.h.close();
});

test("tui: enter on a highlighted suggestion picks it and runs the command", async () => {
	const t = await open({ agents: { main: {}, gonzo: { agent: { description: "law" } }, golem: { agent: { description: "clay" } } } });
	await t.sees("type a message");

	// Two agents match "go"; the second one is chosen with the arrow key.
	t.term.type("/agent go");
	await t.sees(/→ golem\s+clay/);
	t.term.type([KEY.down]);
	await t.sees(/→ gonzo\s+law/);
	t.term.type([KEY.enter]);
	await t.sees("gonzo · law");
	assert.match(t.text(), /2 gonzo/);
	assert.ok(!t.text().includes('no agent "go"'), "the typed fragment is not what gets run");

	// The same for a model: type a fragment, pick from the list.
	t.term.type("/model mo");
	await t.sees(/→ mock\/m/);
	t.term.type([KEY.enter]);
	await t.sees("gonzo now uses mock/m (saved as its model)");
	assert.ok(!t.text().includes("is not defined in models.json"));
	assert.equal(JSON.parse(fs.readFileSync(path.join(t.h.home, "agents", "gonzo", "agent.json"), "utf8")).model, "mock/m", "the choice is written to the agent's configuration");
	assert.equal(JSON.parse(fs.readFileSync(path.join(t.h.home, "agents", "gonzo", "agent.json"), "utf8")).description, "law", "and the rest of the file is kept");

	// An argument typed out in full needs one enter as well, list or no list.
	t.term.type("/agent main");
	await t.sees(/→ main/);
	t.term.type([KEY.enter]);
	await until(() => /^ main$/m.test(t.app.screen()[2] ?? ""), 2000, "the main tab to be in front");
	t.term.type([KEY.alt(2)]);

	// Tab completes without running, so the argument can still be edited.
	t.term.type("/agent gol");
	await t.sees(/→ golem\s+clay/);
	t.term.type([KEY.tab]);
	await sleep(40);
	assert.ok(!/3 golem/.test(t.text()), "tab only completes");
	t.term.type([KEY.enter]);
	await t.sees("golem · clay");
	await t.close();
});

test("tui: esc stops a running task; an approval is asked in a dialog and answered with a key", async () => {
	const t = await open({ agents: { main: { agent: { approve: ["bash:*rm *"] } } } });
	await t.sees("type a message");

	await t.send(mockMsg([{ tools: [{ name: "bash", args: { command: "sleep 5; echo never" } }] }]));
	await t.sees(/working · \d+s/);
	await t.sees("● bash sleep 5");
	t.term.type([KEY.esc]);
	await t.sees("■ stopped");
	assert.ok(!/working ·/.test(t.text()));

	// A message typed while the agent works starts when that work is stopped. A second esc, pressed
	// because the status line says "working" again, does not take that message with it.
	await t.send(mockMsg([{ tools: [{ name: "bash", args: { command: "sleep 5; echo never" } }] }]));
	await t.sees("● bash sleep 5");
	await t.send(mockMsg([{ delayMs: 600, text: "This is the answer to the correction." }]));
	t.term.type([KEY.esc]);
	await until(() => count(t.text(), "■ stopped") === 2, 4000, "the running work to stop");
	await until(() => t.h.pine.tasks.list({ status: "running" }).length === 1, 2000, "the waiting message to start");
	t.term.type([KEY.esc]);
	await t.sees("This is your next message being answered");
	await t.sees("This is the answer to the correction.");
	assert.equal(count(t.text(), "■ stopped"), 2, "the correction was not stopped");

	const risky = mockMsg([{ tools: [{ name: "bash", args: { command: "touch f; rm f; echo gone" } }] }]);
	await t.send(risky);
	await t.sees("│ Approval needed");
	assert.ok(t.text().includes("bash: touch f; rm f; echo gone") && t.text().includes("this action always needs your approval"));
	t.term.type("hello"); // typing goes to the dialog, not the editor, while it is open
	t.term.type("d");
	await t.sees("✗ denied bash");
	await t.sees("not approved");
	assert.ok(!t.text().includes("│ Approval needed"));

	await t.send(risky);
	await t.sees("│ Approval needed");
	// A click beside the question does not make it vanish: unanswered, it would count as a no when its time is up.
	t.term.click(2, 2);
	await sleep(80);
	assert.ok(t.text().includes("│ Approval needed"), "still open after a click beside it");
	// Put off with esc, it is still waiting, and enter on an empty line opens it again.
	t.term.type([KEY.esc]);
	await t.sees("waiting for your approval · enter opens the question");
	assert.ok(!t.text().includes("│ Approval needed"));
	t.term.type([KEY.enter]);
	await t.sees("│ Approval needed");
	t.term.type([KEY.esc]);
	await t.sees("waiting for your approval");
	// From another tab the question is not out of sight: its tab is marked, and the status line says where it waits.
	t.term.type([KEY.ctrlT]);
	await t.sees(/1 main ×!/);
	await t.sees(/tab 1 \(main\) is waiting for your approval · alt\+1 goes there/);
	t.term.type([KEY.alt(1)]);
	await t.sees("│ Approval needed");
	t.term.type([KEY.esc]);
	await t.sees("waiting for your approval · enter opens the question");
	await t.send("/approve");
	await t.sees("✓ allowed bash");
	await t.sees("FINAL:: gone");
	await t.close();
});

test("tui: the mouse works on tabs, their close buttons, the bottom bar and the lists it opens", async () => {
	const t = await open({ agents: { main: {}, gonzo: { agent: { description: "law" } } } });
	await t.sees("type a message");
	const last = () => t.app.screen().length - 1;
	/** Click on a piece of text in a screen line (the first line that contains it, or a given row). */
	const click = async (needle: string, row?: number, offset = 1) => {
		const lines = t.app.screen();
		const y = row ?? lines.findIndex((l) => l.includes(needle));
		assert.ok(y >= 0 && lines[y].includes(needle), `"${needle}" is on screen\n${lines.join("\n")}`);
		t.term.click(lines[y].indexOf(needle) + offset, y);
		await sleep(30);
	};

	// The tab bar: + opens a conversation, a tab's name brings it forward, its × closes it.
	await click("+", 0, 0);
	await t.sees(/1 main ×\s+2 main·s\w+ ×/);
	await click("1 main", 0);
	await t.send("in the first tab");
	await t.sees("ECHO[in the first tab]");
	const bar = t.app.screen()[0];
	t.term.click(bar.indexOf("×", bar.indexOf("2 main")), 0);
	await until(() => !/2 main/.test(t.app.screen()[0]), 2000, "the second tab to close");

	// The bottom bar: agent, conversation, model and mode each open a list.
	await click("mock/m", last());
	await t.sees("│ Model for main");
	t.term.type([KEY.esc]);
	await until(() => !t.text().includes("Model for main"));

	await click("safe", last());
	await t.sees("│ Mode for main");
	await click("asks before every action");
	await t.sees("main is now in manual mode");
	await t.sees(/main · main · no folder · mock\/m · reasoning off · manual/);

	await click("main", last());
	await t.sees("│ Agent");
	t.term.type("nzo"); // typing narrows the list, matching anywhere in the name
	await until(() => !/→ main/.test(t.text()) && /→ gonzo/.test(t.text()), 2000, "the list to narrow to gonzo");
	t.term.type(["\x7f", "\x7f", "\x7f"]);
	await t.sees(/main\s/);
	t.term.type("law"); // or in the description
	t.term.type([KEY.enter]);
	await t.sees("gonzo · law");

	// The commands without an argument open the same lists.
	await t.send("/sessions");
	await t.sees("│ Conversations of gonzo");
	await click("+ new conversation");
	await t.sees(/3 gonzo·s\w+/);
	await t.close();
});

test("tui: dropped files are attached, shown, removable, and arrive in the agent's inbox", async (t0) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine drop "));
	t0.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
	fs.writeFileSync(path.join(dir, "shot one.png"), png);
	fs.writeFileSync(path.join(dir, "notes.txt"), "the notes\n");
	fs.writeFileSync(path.join(dir, "extra.txt"), "x");
	const esc = (p: string) => p.replace(/ /g, "\\ ");
	const t = await open({ agents: { main: {} } });
	await t.sees("type a message");

	// Terminals paste dropped files as paths: escaped, quoted, or as file:// URLs.
	t.term.paste(`${esc(path.join(dir, "shot one.png"))} '${path.join(dir, "notes.txt")}'`);
	t.term.paste(`file://${encodeURI(path.join(dir, "extra.txt"))}`);
	await t.sees(/attached: shot one\.png 1 KB ×\s+notes\.txt 1 KB ×\s+extra\.txt 1 KB ×/);
	const row = t.app.screen().findIndex((l) => l.includes("attached:"));
	t.term.click(t.app.screen()[row].lastIndexOf("×"), row);
	await until(() => !t.text().includes("extra.txt"), 2000, "the third file to be removed");

	// Pasted text that is not a list of files is ordinary input.
	t.term.paste("look at /no/such/file please");
	await t.sees("look at /no/such/file please");
	t.term.type([KEY.ctrlC]);

	await t.send("what is in these?");
	await t.sees("attached: shot one.png, notes.txt");
	await t.sees("ECHO[what is in these?");
	assert.ok(!t.app.screen().some((l) => /KB ×/.test(l)), "the attachment line is empty again");
	const inbox = path.join(t.h.workspace("main"), "inbox");
	const saved = fs.readdirSync(inbox).sort();
	assert.equal(saved.length, 2);
	assert.ok(saved.some((f) => f.endsWith("-notes.txt")) && saved.some((f) => f.endsWith("-shot_one.png")), saved.join());
	assert.equal(fs.readFileSync(path.join(inbox, saved.find((f) => f.endsWith("notes.txt"))!), "utf8"), "the notes\n");
	const content = t.h.mock.state.requests.at(-1).body.messages.find((m: any) => m.role === "user").content;
	assert.equal(content.filter((p: any) => p.type === "image_url").length, 1, "the image is shown to a model that accepts images");
	assert.match(content.find((p: any) => p.type === "text").text, /files attached by your owner, saved in your workspace: inbox\/\w+-shot_one\.png, inbox\/\w+-notes\.txt; the images are also shown to you/);

	// /attach does the same from the keyboard.
	await t.send(`/attach ${esc(path.join(dir, "extra.txt"))}`);
	await t.sees(/attached: extra\.txt/);
	await t.send("/detach");
	await until(() => !t.app.screen().some((l) => /KB ×/.test(l)));
	await t.close();
});

test("tui: bypass in a conversation that has read outside content is a choice, and a pause is announced", { skip: !sandboxAvailable() }, async () => {
	const feed = { command: process.execPath, args: [MCP_STUB], env: { MCP_LABEL: "feed" }, taints: true };
	const t = await open({ agents: { main: { agent: { mcp: { feed }, mode: "bypass" } } } });
	await t.sees(/main · main · no folder · mock\/m · reasoning off · bypass/);
	const outside = path.join(os.homedir(), ".zshenv-does-not-matter");

	// Bypass from the configuration: it applies until the conversation reads outside content, then says so.
	await t.send(mockMsg([{ tools: [{ name: "mcp__feed__echo", args: { text: "x" } }] }]));
	await t.sees("bypass is paused in this conversation");
	await t.sees(/bypass \(paused\).* · outside content/);
	await t.send("and now?");
	await t.sees("ECHO[and now?]");
	assert.ok(notesOf(t.h.mock.state.requests.at(-1)).at(-1)!.includes("it is paused in this conversation"), "the agent knows too, and can say why something is refused");

	// Asking for bypass again offers the two ways on: a clean conversation, or here anyway.
	await t.send("/mode bypass");
	await t.sees("│ This conversation has read outside content");
	await t.sees("Bypass in a new, clean conversation");
	t.term.type([KEY.down, KEY.enter]);
	await t.sees("main is now in bypass mode");
	await until(() => !/paused/.test(t.app.screen().at(-1)!), 2000, "the pause to lift");
	await t.send(mockMsg([{ tools: [{ name: "read", args: { path: outside } }] }]));
	await t.sees(/✗ read .*zshenv-does-not-matter/);
	assert.ok(!t.h.toolResults().at(-1)!.includes("outside the paths"), "the sandbox no longer refuses: the file simply does not exist");
	assert.ok(notesOf(t.h.mock.state.requests.at(-1)).at(-1)!.includes("Mode: bypass."), "and the agent is told");

	// A reset clears the choice together with the taint.
	await t.send("/reset");
	await t.sees("fresh conversation");
	await t.close();
});

test("tui: list search finds text anywhere in a name, ranks sensible matches first, and forgives a typo", () => {
	const models = ["anthropic/claude-haiku-5-5", "opencode-go/deepseek-v4-pro", "opencode-go/deepseek-v4.1-flash", "opencode-go/kimi-k3", "opencode/deepseek-v4.1-flash-free", "deepseek/deepseek-chat"].map((m) => ({ value: m, label: m }));
	const find = (q: string) => searchItems(models, q).map((m) => m.value);
	assert.deepEqual(find("dee"), ["deepseek/deepseek-chat", "opencode-go/deepseek-v4-pro", "opencode-go/deepseek-v4.1-flash", "opencode/deepseek-v4.1-flash-free"]);
	assert.deepEqual(find("go flash"), ["opencode-go/deepseek-v4.1-flash"], "several words must all occur");
	assert.deepEqual(find("KIMI"), ["opencode-go/kimi-k3"], "case does not matter");
	assert.deepEqual(find(""), models.map((m) => m.value));
	assert.ok(find("haiku55").includes("anthropic/claude-haiku-5-5"), "loose matching when nothing contains the text");
	assert.deepEqual(searchItems([{ value: "a", label: "auto", description: "works inside its sandbox" }, { value: "b", label: "bypass", description: "never asks" }], "never").map((x) => x.value), ["b"], "descriptions are searched too");
});

test("tui: /mcp lists the servers with their state and signs in to one", async () => {
	const signIns: string[] = [];
	const t = await open({ agents: { main: {} } }, [110, 30], {
		mcp: {
			list: async () => [
				{ name: "gateway", scope: "global", agents: ["main"], target: "https://gateway.example/d/abc/mcp", state: signIns.length ? "connected" : "needs sign-in" },
				{ name: "web", scope: "global", agents: ["main"], target: "bundled: web", state: "connected" },
				{ name: "cad", scope: "main", session: "side", agents: ["main"], target: "npx -y cad-mcp", state: "connected" },
				{ name: "here", scope: "main", session: "main", agents: ["main"], target: "npx -y here-mcp", state: "connected" },
				{ name: "mine", scope: "main", agents: ["main"], target: "npx -y mine-mcp", state: "connected" },
			],
			login: async (name, onOutput) => {
				onOutput(`Sign in to MCP server "${name}" in your browser:\nhttps://gateway.example/authorize?x=1\n`);
				signIns.push(name);
				return name === "gateway" ? 0 : 1;
			},
		},
	});
	await t.sees("type a message");
	await t.send("/mcp");
	await t.sees(/gateway\s+needs sign-in\s+all agents: main/);
	await t.sees(/web\s+connected/);
	// A server that one conversation has alone is not shown as the agent's.
	await t.sees(/cad\s+connected\s+only the conversation side of main, not this one/);
	await t.sees(/here\s+connected\s+only this conversation/);
	await t.sees(/mine\s+connected\s+only main\n/);

	const live = t.h.pine.agents.status().sessions.length;
	await t.h.pine.agents.run({ agent: "main", prompt: "warm", trust: "owner" });
	assert.equal(t.h.pine.agents.status().sessions.length, live + 1);
	await t.send("/mcp login gateway");
	await t.sees("https://gateway.example/authorize?x=1");
	await t.sees("✓ signed in to gateway");
	await until(() => t.h.pine.agents.status().sessions.length === 0, 2000, "open sessions to be refreshed so they see the new tools");
	await t.send("/mcp login other");
	await t.sees("sign-in to other did not complete");
	assert.deepEqual(signIns, ["gateway", "other"]);

	// Typing "/mcp login " offers the remote servers; without a name the only remote one is taken.
	t.term.type("/mcp login ");
	await t.sees(/→ gateway\s+https:\/\/gateway\.example/);
	assert.ok(!/→ web/.test(t.text()) && !/^\s+web\s+bundled/m.test(t.app.screen().slice(-8).join("\n")), "a bundled server has no sign-in");
	t.term.type([KEY.enter]);
	await until(() => signIns.length === 3, 2000, "the suggested server to be signed in to");
	await t.send("/mcp login");
	await until(() => signIns.length === 4, 2000, "the only remote server to be used");
	assert.deepEqual(signIns.slice(2), ["gateway", "gateway"]);
	await t.close();
});

test("tui: a click on a web address opens it, also when the address wraps over lines", async () => {
	const opened: string[] = [];
	const long = `https://auth.example.com/authorize?client_id=pine&redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback&state=${"abcdef0123456789".repeat(8)}&scope=read`;
	const t = await open({ agents: { main: {} } }, [100, 30], { openUrl: (u) => void opened.push(u) });
	await t.sees("type a message");
	await t.send(mockMsg([{ text: `See https://example.com/docs/page?x=1, or the [manual](https://example.org/manual). Sign in here: ${long}` }]));
	// The typed message shows the same text; wait for the answer, which is its second appearance.
	await done(t.h, 1);
	await until(() => count(t.text(), "&scope=read") >= 2, 4000, "the answer to be on screen");

	const lines = () => t.app.screen();
	const clickOn = async (needle: string, offset = 3, nth = 1) => {
		const hits = lines().flatMap((l, y) => (l.includes(needle) ? [y] : []));
		const y = hits[nth - 1];
		assert.ok(y !== undefined, `"${needle}" is on screen (occurrence ${nth})`);
		t.term.click(lines()[y].indexOf(needle) + offset, y);
		await sleep(20);
	};
	// The prompt line shows the same addresses; click the ones in the answer (second occurrence).
	await clickOn("https://example.com/docs", 3, 2);
	assert.equal(opened.at(-1), "https://example.com/docs/page?x=1", "the comma after it is not part of the address");
	await clickOn("example.org/manual", 3, 2);
	assert.equal(opened.at(-1), "https://example.org/manual", "a markdown link shows its target, and that is what opens");
	await t.sees("opened https://example.org/manual");

	// The long one covers several screen lines: a click on a later line still gives the whole address.
	const tail = lines().findLastIndex((l) => l.includes("&scope=read"));
	assert.ok(tail > 0 && !lines()[tail].includes("https://"), "the address is wrapped");
	t.term.click(lines()[tail].indexOf("&scope=read") + 2, tail);
	await sleep(20);
	assert.equal(opened.at(-1), long);

	const before = opened.length;
	await clickOn("Sign in here", 2, 2);
	assert.equal(opened.length, before, "a click on ordinary text opens nothing");
	await t.close();
});

test("tui: finding the address under a click", () => {
	const w = 40;
	assert.equal(urlAt([" see https://a.example/x?y=1. next"], 0, 10, w), "https://a.example/x?y=1");
	assert.equal(urlAt([" see https://a.example/x?y=1. next"], 0, 2, w), undefined);
	assert.equal(urlAt([" (https://en.wikipedia.org/wiki/Pi_(letter))"], 0, 12, w), "https://en.wikipedia.org/wiki/Pi_(letter)");
	assert.equal(urlAt([" https://a.example/path, https://b.example/"], 0, 30, 60), "https://b.example/");
	const wrapped = [" text before https://long.example/aaaaaa", " bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", " cccc and more text"];
	assert.equal(urlAt(wrapped, 1, 5, w), "https://long.example/aaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbcccc");
	assert.equal(urlAt(wrapped, 2, 3, w), "https://long.example/aaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbcccc");
	assert.equal(urlAt(wrapped, 2, 12, w), undefined);
	assert.equal(urlAt([" ftp://x.example/ file:///etc/hosts javascript:alert(1)"], 0, 8, 80), undefined, "only http and https");
});

test("tui: reasoning level and context use are shown in the bottom bar; the level is set by click, list or command", async () => {
	const t = await open({ agents: { main: { agent: { description: "front desk" } } }, model: { reasoning: true, contextWindow: 20000 }, mockOptions: { prefixCache: true } });
	await t.sees("type a message");
	const bar = () => t.app.screen().at(-1)!;
	assert.match(bar(), /main · main · no folder · mock\/m · reasoning off · safe/);
	assert.ok(!/context|cache/.test(bar()), "no figures before the model has answered once");
	assert.ok(!/embedded|test ·/.test(bar()), "the bar holds only what is about the conversation");

	await t.send("hello");
	await t.sees("ECHO[hello]");
	await until(() => /context \d+%/.test(bar()), 2000, "the context figure");
	const first = Number(bar().match(/context (\d+)%/)![1]);
	assert.ok(first > 0 && first < 100, `a plausible share of a 20000 token window: ${first}%`);
	await t.send(`a longer message ${"that takes up room ".repeat(60)}`);
	await until(() => Number(bar().match(/context (\d+)%/)?.[1] ?? 0) > first, 3000, "the figure to grow with the conversation");
	// The second message found the first one in the model server's cache.
	await until(() => /cache \d+%/.test(bar()), 2000, "the cache figure");
	assert.ok(Number(bar().match(/cache (\d+)%/)![1]) >= 60, bar());

	// A UI opened later shows the figures straight away, from the last task.
	const later = new PineTui({ client: t.app.client, terminal: new FakeTerminal(120, 30) });
	apps.push(later);
	await later.start();
	await until(() => /context \d+% · cache \d+%/.test(later.screen().at(-1)!), 2000, "the figures in a newly opened UI");
	await later.stop();

	// Click the level in the bar, pick from the list.
	t.term.click(bar().indexOf("reasoning off") + 3, t.app.screen().length - 1);
	await t.sees("│ Reasoning for main");
	const row = t.app.screen().findIndex((l) => /think longer before answering/.test(l));
	t.term.click(t.app.screen()[row].indexOf("high") + 1, row);
	await t.sees("main now reasons at level high");
	assert.match(bar(), /reasoning high/);
	const file = path.join(t.h.home, "agents", "main", "agent.json");
	assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { description: "front desk", thinking: "high" }, "saved, like the model");

	// The model is asked accordingly from the next message on, in the same conversation.
	await t.send("think about it");
	await t.sees("ECHO[think about it]");
	assert.equal(t.h.mock.state.requests.at(-1).body.reasoning_effort, "high");
	assert.equal(t.h.mock.state.requests[0].body.reasoning_effort, undefined);
	assert.equal(t.h.mock.state.requests.at(-1).body.messages.filter((m: any) => m.role === "user").length, 3);

	await t.send("/reasoning low");
	await t.sees("main now reasons at level low");
	await t.send("/reasoning turbo");
	await t.sees("reasoning level must be one of");
	await t.send("/reasoning");
	await t.sees("│ Reasoning for main");
	t.term.type([KEY.esc]);
	await t.send("/reset");
	await until(() => !/context/.test(bar()), 2000, "the figure to go with the conversation");
	await t.close();
});

test("tui: esc or a click beside a menu closes only the menu; an approval can cover the rest of the conversation", async () => {
	const t = await open({ agents: { main: {} } });
	await t.sees("type a message");
	const last = () => t.app.screen().length - 1;
	const clickOn = async (needle: string, row: number) => {
		const line = t.app.screen()[row];
		assert.ok(line.includes(needle), `"${needle}" in "${line}"`);
		t.term.click(line.indexOf(needle) + 1, row);
		await sleep(30);
	};

	// A task runs; a menu is opened over it and closed with esc. Terminals that report key releases
	// send one after the press: neither may reach the task underneath.
	await t.send(mockMsg([{ tools: [{ name: "bash", args: { command: "sleep 0.7; echo survived" } }] }]));
	await t.sees(/working · \d+s/);
	await clickOn("mock/m", last());
	await t.sees("│ Model for main");
	t.term.type(["\x1b[27u", "\x1b[27;1:3u"]);
	await until(() => !t.text().includes("Model for main"), 2000, "the menu to close");

	// A click beside the menu closes it too, and is not a click on what lies underneath (here: "+", a new tab).
	await clickOn("reasoning off", last());
	await t.sees("│ Reasoning");
	await clickOn("+", 0);
	await until(() => !t.text().includes("│ Reasoning"), 2000, "the menu to close");
	assert.ok(!/2 main/.test(t.app.screen()[0]), "no tab was opened by the click that closed the menu");
	await t.sees("FINAL:: survived");
	assert.ok(!t.text().includes("cancelled"));

	// Manual mode asks; "always here" answers for the rest of the conversation.
	t.h.pine.agents.setMode("main", "manual");
	await t.send(mockMsg([{ tools: [{ name: "bash", args: { command: "echo one" } }] }]));
	await t.sees("│ Approval needed");
	assert.ok(t.text().includes("Always here (s)") && /stops asking about bash in this conversation/.test(t.text()), t.text());
	const row = t.app.screen().findIndex((l) => l.includes("Always here (s)"));
	t.term.click(t.app.screen()[row].indexOf("Always here") + 2, row);
	await t.sees("bash will not ask again in this conversation");
	await t.sees("FINAL:: one");
	await t.send(mockMsg([{ tools: [{ name: "bash", args: { command: "echo two" } }] }]));
	await t.sees("FINAL:: two");
	assert.ok(!t.text().includes("│ Approval needed"));
	await t.close();
});

test("tui: a sub-agent's work opens in a tab of its own, while it runs and afterwards", async () => {
	const t = await open({ agents: { main: {} } }, [120, 40]);
	await t.sees("type a message");
	const clickLine = async (needle: string) => {
		const lines = t.app.screen();
		const y = lines.findIndex((l) => l.includes(needle));
		assert.ok(y >= 0, `"${needle}" is on screen\n${lines.join("\n")}`);
		t.term.click(lines[y].indexOf(needle) + 1, y);
		await sleep(30);
	};
	t.h.mock.state.scripts.sub = [{ text: "Looking into it.", tools: [{ name: "bash", args: { command: "sleep 0.4; echo sub-ran" } }] }, { text: "SUB-ANSWER" }];
	await t.send(mockMsg([{ tools: [{ name: "subagent", args: { tasks: ["@@REF:sub@@"] } }] }, { text: "parent done" }]));

	// While it runs: the conversation names it, counts it, and a click on its line opens it.
	await t.sees("↳ main sub-agent #2:");
	await t.sees("1 sub-task running");
	await clickLine("sub-agent #2:");
	await t.sees("sub-agent of main · task #2 · started by task #1 · running");
	assert.match(t.app.screen()[0], /2 main↳#2/);
	await t.sees("SUB-ANSWER");
	await t.sees(/── done · [\d.]+ s · 1 tool call/);
	assert.ok(t.text().includes("bash sleep 0.4; echo sub-ran"), t.text());
	await t.send("can you hear me");
	await t.sees("takes no messages");

	// Afterwards: the conversation shows how it ended; the agent list has it; /task opens it from the record.
	t.term.type([KEY.alt(1)]);
	await t.sees("parent done");
	await t.sees(/▸ 2 tool calls · subagent · bash · \d+s · click to open/);
	t.term.click(6, t.app.screen().findIndex((l) => l.includes("▸ 2 tool calls")));
	await t.sees("✓ main sub-agent #2 answered");
	t.term.type([KEY.alt(2), KEY.ctrlW]);
	await until(() => !/main↳#2/.test(t.app.screen()[0]), 2000, "the task tab to close");
	const footer = t.app.screen().length - 1;
	t.term.click(t.app.screen()[footer].indexOf("main") + 1, footer);
	await t.sees("│ Agent");
	await t.sees("↳ #2 sub-agent");
	t.term.type([KEY.esc]);
	await t.send("/task 2");
	await t.sees("sub-agent of main · task #2 · started by task #1 · done");
	const view = t.text();
	for (const part of ["[task]", "Looking into it.", "✓ bash sleep 0.4; echo sub-ran", "sub-ran", "SUB-ANSWER", "── done ·", "task #2 of main · read-only"]) assert.ok(view.includes(part), `${part}\n${view}`);
	await t.close();
});

test("tui: an event from a subscribed source arrives in the conversation the agent subscribed in", async () => {
	// A source of the test's own that reports by itself, again and again.
	const CLOCK = `export default function (source: any) {\n\tconst timer = setInterval(() => source.emit("tick", { scheduled: new Date().toISOString() }), 400);\n\tsource.onStop(() => clearInterval(timer));\n}\n`;
	const t = await open({ pine: { sources: { clock: { use: "./sources/clock.ts", trust: "owner", description: "a tick every second" } } }, files: { "sources/clock.ts": CLOCK }, agents: { main: {} } });
	await t.sees("type a message");
	await t.send("/sources");
	await t.sees(/clock custom idle · a tick every second/);
	await t.send("/subscribe clock say tock");
	await t.sees("main is subscribed to clock (running). Each event arrives in its main conversation, here, and wakes it.");
	// The tick shows up here as an event, not as something typed, and the agent answers it here.
	await t.sees("⚡ clock: source/clock/tick", 5000);
	await t.sees(/ECHO\[\[You are subscribed to the event source "clock"/, 5000);
	assert.ok(t.text().includes('"scheduled"'), "with the start of what the source reported");
	assert.match(t.app.screen()[0], /^ pine\s+1 main ×\s+\+/, "no other conversation was opened for it");
	await t.send("/unsubscribe clock");
	await t.sees("main is no longer subscribed to clock");

	// In another tab the same words mean that conversation only, and closing the tab ends it.
	await t.send("/new side");
	await t.sees(/2 main·side ×/);
	await t.send("/subscribe clock say tock here");
	await t.sees("Each event arrives here, in this conversation, and wakes it.");
	await t.sees("Closing this conversation ends the subscription.");
	assert.deepEqual(t.h.pine.cfg.agents.main.subscribe.map((x) => `${x.source}@${x.session}`), ["clock@side"]);
	await t.sees("⚡ clock: source/clock/tick", 5000);
	t.term.type([KEY.ctrlW]);
	await t.sees("closed main·side: its subscription to clock ended with it");
	assert.deepEqual(t.h.pine.cfg.agents.main.subscribe, []);
	assert.equal(t.h.pine.sources.list()[0].running, false);
	await t.close();
});

test("tui: the same tabs open again next time; the list of conversations pins, removes and says what goes by itself; /rename", async () => {
	const t = await open({ agents: { main: {} } });
	await t.sees("type a message");
	await t.send("/new side");
	await t.sees(/2 main·side ×/);
	await t.send("hello side");
	await t.sees("ECHO[hello side");
	await t.send("/new scratch");
	await t.send("temp");
	await t.sees("ECHO[temp");
	await t.send("/rename notes");
	await t.sees("this conversation is now called notes");
	await t.sees(/3 main·notes ×/);
	assert.equal(t.h.pine.tasks.list({ agent: "main", session: "notes" }).length, 1);

	// A closed tab's conversation stays in the list, with the time it has left.
	t.term.type([KEY.ctrlW]);
	await until(() => !/main·notes/.test(t.app.screen()[0]), 2000, "the tab to close");
	await t.send("/sessions");
	await t.sees("│ Conversations of main");
	await t.sees(/side\s+1 message · just now · open in a tab\s+pin   ×/);
	await t.sees(/notes\s+1 message · just now · goes in 7 days\s+pin   ×/);
	const row = (what: RegExp) => t.app.screen().findIndex((l) => what.test(l));
	const at = (what: RegExp, mark: string) => [t.app.screen()[row(what)].lastIndexOf(mark), row(what)] as [number, number];

	// "pin" pins, "unpin" takes it back.
	t.term.click(...at(/│\s+notes /, "pin"));
	await t.sees(/★ notes\s+1 message · just now · pinned\s+unpin   ×/);
	assert.equal(t.h.pine.agents.conversations("main").find((x) => x.session === "notes")!.expires, undefined);
	t.term.click(...at(/★ notes/, "unpin"));
	await t.sees(/│\s+notes\s+1 message · just now · goes in 7 days/);

	// The × removes, and asks once more first.
	t.term.click(...at(/│\s+notes /, "×"));
	await t.sees("remove? ×");
	assert.equal(t.h.pine.tasks.list({ agent: "main", session: "notes" }).length, 1, "one click removes nothing");
	t.term.click(...at(/│\s+notes /, "×"));
	await t.sees("removed the conversation notes of main");
	assert.ok(!/│\s+notes /.test(t.text()));
	assert.equal(t.h.pine.tasks.list({ agent: "main", session: "notes" }).length, 0);

	t.term.type([KEY.esc]);

	// Leave and come back: the same two tabs, the same one in front.
	await t.app.stop();
	const again = new PineTui({ client: t.app.client, terminal: new FakeTerminal(110, 30) });
	apps.push(again);
	await again.start();
	await until(() => /1 main ×\s+2 main·side ×/.test(again.screen()[0]) && again.screen().join("\n").includes("ECHO[hello side"), 4000, `both tabs again, with the second in front\n${again.screen().join("\n")}`);
	await again.stop();
	await t.h.close();
});

test("tui: the agent's own conversation is kept without a pin, and reset where the others are removed", async () => {
	const t = await open({ agents: { main: {} } });
	await t.sees("type a message");
	await t.send("remember this");
	await t.sees("ECHO[remember this]");
	await t.send("/sessions");
	await t.sees("│ Conversations of main");
	// It cannot be removed and never goes: its row has the mark of a kept one, and "reset" where the others have "×".
	await t.sees(/★ main\s+1 message · just now · the agent's own, always kept\s+reset │/);
	const row = () => t.app.screen().findIndex((l) => /★ main /.test(l));
	t.term.click(t.app.screen()[row()].lastIndexOf("reset") + 1, row());
	await t.sees("reset? ×");
	assert.equal(t.h.pine.tasks.list({ agent: "main", session: "main" }).length, 1, "asked first, as with a removal");
	t.term.click(t.app.screen()[row()].lastIndexOf("reset? ×") + 1, row());
	await t.sees("the main conversation of main starts fresh");
	t.term.type([KEY.esc]);
	await t.sees("fresh conversation");
	assert.ok(!t.text().includes("ECHO[remember this]"), "what was said is gone from the tab");
	await t.h.close();
});

test("tui: the tab of a pinned conversation has the mark it has in the list", async () => {
	const t = await open({ agents: { main: {} } });
	await t.sees("type a message");
	await t.send("/new side");
	await t.sees(/2 main·side ×/);
	await t.send("hello side");
	await t.sees("ECHO[hello side]");
	await t.send("/pin");
	await t.sees(/2 ★ main·side ×/);
	assert.ok(/1 main ×/.test(t.app.screen()[0]), "the agent's own conversation is its plain name");
	await t.send("/unpin");
	await t.sees(/2 main·side ×/);
	// Pinned in the list of conversations, the tab follows; and the mark is there again at the next start.
	await t.send("/sessions");
	await t.sees("│ Conversations of main");
	const row = () => t.app.screen().findIndex((l) => /│\s+side /.test(l));
	t.term.click(t.app.screen()[row()].lastIndexOf("pin") + 1, row());
	await t.sees(/★ side\s/);
	t.term.type([KEY.esc]);
	await t.sees(/2 ★ main·side ×/);
	await t.app.stop();
	const again = new PineTui({ client: t.app.client, terminal: new FakeTerminal(110, 30) });
	apps.push(again);
	await again.start();
	await until(() => /2 ★ main·side ×/.test(again.screen()[0]), 4000, `the mark after a restart\n${again.screen()[0]}`);
	await again.stop();
	await t.h.close();
});

test("tui: an answer's markdown is drawn, not shown raw: code in colour without its backticks, diffs red and green, tables aligned, headings without #", async () => {
	const { Answer } = await import("../src/tui/theme.ts");
	const { highlightCode, languageOf } = await import("../src/tui/highlight.ts");
	const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
	const draw = (text: string, width = 70) => new Answer(text).render(width);

	// A diff: removed lines red, added lines green, and no line of backticks around it.
	const diff = draw("Here:\n\n```diff\n--- a/README.md\n+++ b/README.md\n@@ -1,4 +1,4 @@\n-# Weather Stationn\n+# Weather Station\n\n Turn a sensor\n```\n\ndone");
	assert.deepEqual(plain(diff), [" Here:", "", " diff", " │ --- a/README.md", " │ +++ b/README.md", " │ @@ -1,4 +1,4 @@", " │ -# Weather Stationn", " │ +# Weather Station", " │", " │  Turn a sensor", "", " done"]);
	assert.ok(diff.some((l) => l.includes("\x1b[31m-# Weather Stationn")) && diff.some((l) => l.includes("\x1b[32m+# Weather Station")));

	// Code in a language it knows is coloured; one it does not know, or none, is left as it is.
	assert.deepEqual(highlightCode("const a = 1; // one", "ts"), ["\x1b[35mconst\x1b[39m a = \x1b[33m1\x1b[39m; \x1b[90m// one\x1b[39m"]);
	assert.deepEqual(highlightCode("/* a\nb */ x", "js"), ["\x1b[90m/* a\x1b[39m", "\x1b[90mb */\x1b[39m x"], "a colour that spans lines is closed and opened again on each");
	assert.deepEqual(highlightCode("if (a < b && c) {}", "nosuchlanguage"), ["if (a < b && c) {}"]);
	assert.deepEqual(highlightCode('<a href="x">&amp;</a>', undefined), ['<a href="x">&amp;</a>']);
	assert.ok(highlightCode('{"a": "<b>&"}', "json")[0].includes('"<b>&"'), "what the highlighter escaped is the original text again");
	assert.deepEqual([languageOf("tsx"), languageOf("sh"), languageOf("yml"), languageOf("patch"), languageOf(""), languageOf("prose")], ["typescript", "sh", "yml", "patch", undefined, undefined]);
	assert.deepEqual(plain(draw("```\nno language\n```\n\n~~~py\nprint(1)\n~~~")), [" │ no language", "", " py", " │ print(1)"]);
	assert.deepEqual(plain(draw("1. step\n   ```sh\n   npm test\n   ```\n2. next")), [" 1. step", "    sh", "    │ npm test", " 2. next"]);

	// A table: its columns set as its second line says, a <br> in a cell is a line break.
	assert.deepEqual(plain(draw("| Name | Value | Notes |\n|---|---:|:---:|\n| alpha | 1 | x |\n| beta | 22 | one<br>and two |")), [
		" ┌───────┬───────┬─────────┐",
		" │ Name  │ Value │  Notes  │",
		" ├───────┼───────┼─────────┤",
		" │ alpha │     1 │    x    │",
		" ├───────┼───────┼─────────┤",
		" │ beta  │    22 │   one   │",
		" │       │       │ and two │",
		" └───────┴───────┴─────────┘",
	]);

	// Headings of every level without their #, lists, quotes and inline styles.
	assert.deepEqual(plain(draw("# One\n## Two\n### Three\n#### Four\n\n- a\n  - [x] done\n\n> said\n\n**bold** `code` ~~gone~~")), [" One", "", " Two", "", " Three", "", " Four", "", " - a", "     - [x] done", "", " │ said", "", " bold code gone"]);

	// And on screen, in an answer that arrives piece by piece.
	const t = await open({ agents: { main: {} } });
	await t.sees("type a message");
	await t.send(mockMsg([{ text: "The fix:\n\n```diff\n-old line\n+new line\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |" }]));
	await t.sees("│ +new line");
	await t.sees("│ 1 │ 2 │");
	assert.ok(!t.app.screen().some((l) => /^\s*```/.test(l)), "no line of raw backticks");
	await t.sees(/^ diff$/m);
	assert.ok(t.app.tui.getScreenLines().some((l) => l.includes("\x1b[31m-old line")), "the removed line is red");
	await t.close();
});

test("tui: how fast the model read and wrote is shown beside its thought, in the status line while it works, and in the bottom bar after", async () => {
	const t = await open({ agents: { main: {} }, model: { reasoning: true } }, [120, 40]);
	await t.sees("type a message");
	const rate = String.raw`[\d.]+k? t\/s`;
	// A server that takes a while over the prompt and then writes for a while.
	await t.send(mockMsg([{ delayMs: 160, reasoning: "weigh it up\nthen decide", reasoningHoldMs: 320, tools: [{ name: "bash", args: { command: "sleep 0.5; echo measured" } }] }, { delayMs: 120, chunkDelayMs: 30, text: "The answer, at some length, so that there is something to time: forty-two." }]));
	await t.sees(new RegExp(`▸ thought for \\d+s · ↑ ${rate} ↓ ${rate} · click to read`));
	// While it goes on working: the last call's figures, after the token counts.
	await t.sees(new RegExp(`working · \\d+s · 1 tool call · \\d+↑[^·]* \\d+↓ · ↑ ${rate} ↓ ${rate} · esc to stop`));
	await t.sees("forty-two.");
	// When the work is done the bottom bar keeps them: the task as a whole.
	const bar = new RegExp(`reasoning \\w+ · \\w+ · context \\d+%[^/]* · ↑ ${rate} ↓ ${rate} `);
	await until(() => !/working ·/.test(t.text()), 5000, "the work to be done");
	await t.sees(bar);
	// An answer that comes at once says nothing about speed: nothing new is shown, and the last figures stay.
	const before = bar.exec(t.text())![0];
	await t.send(mockMsg([{ text: "ok" }]));
	await t.sees(/^ ok$/m);
	assert.ok(t.text().includes(before), t.text());
	await t.close();
});

test("tui: what a model thinks is a few lines while it thinks and one line after; a click opens it and a click anywhere on it closes it", async () => {
	const t = await open({ agents: { main: {} }, model: { reasoning: true } }, [110, 40]);
	await t.sees("type a message");
	const rows = () => t.app.screen();
	// A line of the thought itself, not of the typed message that scripted it.
	const thought = (n: number) => rows().some((l) => l.startsWith(` │ step-${n} `));
	const rowOf = (what: string) => rows().findIndex((l) => l.includes(what));
	const steps = (n: number) => Array.from({ length: n }, (_, i) => `step-${i + 1} of the plan`).join("\n");

	// While it thinks: the last few lines, and how long it has been at it.
	await t.send(mockMsg([{ reasoning: steps(8), reasoningHoldMs: 500, text: "The answer is 4." }]));
	await t.sees(/▸ thinking \d+s · click to read/);
	await until(() => thought(8), 2000, "the end of the thought");
	assert.ok(thought(5) && !thought(4), `only the last four lines\n${t.text()}`);

	// Nobody opened it: one line once the answer begins.
	await t.sees("The answer is 4.");
	await t.sees(/▸ thought for \d+s(?: · [^·]+t\/s)? · click to read/);
	assert.ok(!thought(8) && !/thinking \d+s/.test(t.text()), `closed to one line\n${t.text()}`);

	// A click opens all of it; a click in the middle of it closes it.
	t.term.click(6, rowOf("▸ thought for"));
	await until(() => thought(1) && thought(8), 2000, "the whole thought");
	assert.match(t.text(), /▾ thought for \d+s(?: · [^·]+t\/s)? · click anywhere on it to close/);
	t.term.click(30, rows().findIndex((l) => l.startsWith(" │ step-4 ")));
	await until(() => !thought(4), 2000, "the thought to close");
	assert.match(t.text(), /▸ thought for \d+s/);
	assert.ok(t.text().includes("The answer is 4."));

	// Opened while it thinks: it stays open when the thinking ends.
	await t.send(mockMsg([{ reasoning: steps(6).replaceAll("step", "move"), reasoningHoldMs: 500, text: "Second answer." }]));
	await t.sees(/▸ thinking \d+s/);
	t.term.click(6, rowOf("▸ thinking"));
	await t.sees(/▾ thinking \d+s · click anywhere on it to close/);
	await t.sees("Second answer.");
	await t.sees(/▾ thought for \d+s/);
	assert.ok(rows().some((l) => l.startsWith(" │ move-1 ")), `still open\n${t.text()}`);
	t.term.click(6, rowOf("▾ thought for"));
	await until(() => !rows().some((l) => l.startsWith(" │ move-1 ")), 2000, "the second thought to close");

	// A thought longer than the window, closed from far down in it: the line that is left is in view.
	await t.send(mockMsg([{ reasoning: steps(90).replaceAll("step", "long"), text: "Third answer." }]));
	await t.sees("Third answer.");
	const closed = rows().flatMap((l, y) => (/▸ thought for/.test(l) ? [y] : [])).at(-1)!;
	t.term.click(6, closed);
	await until(() => rows().some((l) => l.startsWith(" │ long-1 ")), 2000, "the long thought to open");
	assert.ok(rows().some((l) => l.includes("▾ thought for")), `its first line stays in view when it opens\n${t.text()}`);
	t.term.type(["\x1b[6~", "\x1b[6~"]);
	await until(() => !rows().some((l) => l.includes("▾ thought for")) && rows().some((l) => /^ │ long-\d+ /.test(l)), 2000, "the window to be inside the thought");
	t.term.click(30, rows().findIndex((l) => /^ │ long-\d+ /.test(l)) + 3);
	await until(() => !rows().some((l) => /^ │ long-\d+ /.test(l)), 2000, "the long thought to close");
	const left = rows().findIndex((l) => /▸ thought for/.test(l));
	assert.ok(left >= 0 && rowOf("Third answer.") > left, `the one line that is left is in view, with the answer under it\n${t.text()}`);
	await t.close();
});

test("tui: what an agent does in a turn is a few lines while it works and one line after; a click opens all of it", async () => {
	const t = await open({ agents: { main: {} } }, [110, 50]);
	await t.sees("type a message");
	const rows = () => t.app.screen();
	const rowOf = (what: string) => rows().findIndex((l) => l.includes(what));
	// A line of the conversation, not of the typed message that scripted it.
	const line = (what: string) => rows().some((l) => l.trim() === what);
	const echo = (n: number) => ({ tools: [{ name: "bash", args: { command: `echo step-${n}` } }] });

	await t.send(mockMsg([{ text: "First I look around.", ...echo(1) }, ...[2, 3, 4, 5, 6, 7, 8].map(echo), { tools: [{ name: "read", args: { path: "no-such-file.txt" } }] }, { tools: [{ name: "bash", args: { command: "sleep 0.6; echo last" } }] }, { text: "All of it is done." }]));

	// While it works: what there is so far in one line, and the last few lines under it.
	await t.sees("● bash sleep 0.6");
	assert.match(t.text(), /▸ 10 tool calls so far · bash ×9 · read · 1 failed · click to see all/);
	assert.ok(t.text().includes("✓ bash echo step-8") && t.text().includes("✗ read no-such-file.txt"), t.text());
	assert.ok(!t.text().includes("✓ bash echo step-5") && !line("First I look around."), `only the last lines\n${t.text()}`);

	// The answer is there: one line is left of the way to it, and it names what failed.
	await until(() => line("All of it is done."), 4000, "the answer");
	await t.sees(/▸ 10 tool calls · bash ×9 · read · 1 failed · \d+s · click to open/);
	assert.ok(!t.text().includes("✓ bash") && !t.text().includes("✗ read"), `closed to one line\n${t.text()}`);

	// A click opens it: every call, and the words the agent wrote before it went on working.
	t.term.click(6, rowOf("▸ 10 tool calls"));
	await t.sees(/▾ 10 tool calls · bash ×9 · read · 1 failed · \d+s · click here to close/);
	for (const part of ["✓ bash echo step-1", "✓ bash echo step-5", "✗ read no-such-file.txt", "✓ bash sleep 0.6; echo last", "▴ close"]) assert.ok(t.text().includes(part), `${part}\n${t.text()}`);
	assert.ok(line("First I look around.") && line("All of it is done."), t.text());
	assert.ok(rowOf("✓ bash echo step-1") < rowOf("✓ bash echo step-8") && rowOf("▴ close") < rows().findIndex((l) => l.trim() === "All of it is done."), `in the order it happened, above the answer\n${t.text()}`);

	// The line at its end closes it again.
	t.term.click(4, rowOf("▴ close"));
	await until(() => !t.text().includes("✓ bash echo step-1"), 2000, "the work to close");
	assert.match(t.text(), /▸ 10 tool calls · /);

	// One call is shown as it is: a line that stands for one line helps nobody.
	await t.send(mockMsg([{ tools: [{ name: "bash", args: { command: "echo alone" } }] }, { text: "Short work." }]));
	await until(() => line("Short work."), 4000, "the second answer");
	await t.sees(/✓ bash echo alone/);
	assert.ok(!/▸ 1 tool call/.test(t.text()), t.text());
	await t.close();
});

test("tui: a thought opens together with the tool calls around it, and what comes between tool calls keeps its place", async () => {
	const t = await open({ agents: { main: { agent: { approve: ["bash:*rm *"] } } }, model: { reasoning: true } }, [110, 50]);
	await t.sees("type a message");
	const rows = () => t.app.screen();
	const rowOf = (what: string | RegExp) => rows().findIndex((l) => (typeof what === "string" ? l.includes(what) : what.test(l)));

	// A thought read while the agent works: the last few lines would cut it off, so all of the turn's work is shown.
	await t.send(mockMsg([{ reasoning: "weigh-1 the options\nweigh-2 the options", tools: [{ name: "bash", args: { command: "sleep 0.8; echo weighed" } }] }, { text: "Weighed." }]));
	await t.sees("● bash sleep 0.8");
	assert.match(t.text(), /▸ 1 tool call so far · bash · 1 thought · click to see all/);
	t.term.click(6, rowOf("▸ thought for"));
	await t.sees(/▾ 1 tool call so far · bash · 1 thought · click here to close/);
	assert.ok(rows().some((l) => l.startsWith(" │ weigh-1 ")), t.text());
	// It was opened, so it stays open when the turn is over. Closing the work closes the thought with it.
	await until(() => rows().some((l) => l.trim() === "Weighed."), 4000, "the answer");
	await t.sees(/▾ 1 tool call · bash · 1 thought · \d+s · click here to close/);
	t.term.click(6, rowOf("▾ 1 tool call"));
	await until(() => !rows().some((l) => l.startsWith(" │ weigh-1 ")), 2000, "the work to close");
	t.term.click(6, rowOf("▸ 1 tool call"));
	await t.sees(/▸ thought for \d+s/);
	assert.ok(!rows().some((l) => l.startsWith(" │ weigh-1 ")), `the thought is closed inside\n${t.text()}`);
	t.term.click(6, rowOf("▾ 1 tool call"));

	// A question to the owner stands between the tool calls before it and the ones after it.
	await t.send(mockMsg([{ tools: [{ name: "bash", args: { command: "echo before-1" } }] }, { tools: [{ name: "bash", args: { command: "echo before-2" } }] }, { tools: [{ name: "bash", args: { command: "touch f; rm f; echo asked" } }] }, { tools: [{ name: "bash", args: { command: "echo after-1" } }] }, { tools: [{ name: "bash", args: { command: "echo after-2" } }] }, { text: "Asked and done." }]));
	await t.sees("│ Approval needed");
	t.term.type("a");
	await t.sees("✓ allowed bash");
	await until(() => rows().some((l) => l.trim() === "Asked and done."), 4000, "the answer");
	await t.sees(/▸ 3 tool calls · bash ×3 · \d+s · click to open/);
	await t.sees(/▸ 2 tool calls · bash ×2 · \d+s · click to open/);
	assert.ok(rowOf(/▸ 3 tool calls · bash ×3/) < rowOf("✓ allowed bash") && rowOf("✓ allowed bash") < rowOf(/▸ 2 tool calls · bash ×2/), `in the order it happened\n${t.text()}`);
	await t.close();
});

test("tui: a message typed while the agent works goes into that work; alt+enter makes it wait its turn", async () => {
	const t = await open({ agents: { main: {} } });
	await t.sees("type a message");

	// The agent runs a command; the correction arrives while it runs and is read at the next step.
	await t.send(mockMsg([{ tools: [{ name: "bash", args: { command: "sleep 0.4; echo first" } }] }, { text: "SECOND-STEP" }]));
	await t.sees("● bash sleep 0.4");
	await t.send("no, do it the other way");
	await t.sees("given to the agent while it works");
	// The model gets it inside that work, after the command's result, and answers it there.
	await t.sees("ECHO[no, do it the other way]");
	await done(t.h, 2);
	const all = t.h.pine.tasks.list({});
	assert.equal(all.find((x) => x.prompt === "no, do it the other way")!.meta.steered, all.find((x) => x.prompt.includes("sleep 0.4; echo first"))!.id, "it belongs to the work that was running");
	assert.equal(all.length, 2, "no work of its own was started for it");
	assert.ok(t.h.mock.state.requests.some((r: any) => r.body.messages.at(-1).role === "user" && JSON.stringify(r.body.messages.at(-1)).includes("no, do it the other way") && r.body.messages.some((m: any) => m.role === "tool")), "the correction reached the model in the same conversation, after the tool result");
	assert.equal(t.app.screen().filter((l) => l.trim() === "no, do it the other way").length, 1, `the message is shown once\n${t.text()}`);

	// alt+enter: the message waits, and is answered as work of its own when the first is done.
	await t.send(mockMsg([{ tools: [{ name: "bash", args: { command: "sleep 0.4; echo again" } }] }, { text: "THIRD-DONE" }]));
	await t.sees("● bash sleep 0.4; echo again");
	t.term.type("and this afterwards");
	t.term.type(["\x1b\r"]);
	await t.sees("waits its turn");
	await t.sees("THIRD-DONE");
	await t.sees("ECHO[and this afterwards]");
	assert.equal(t.h.pine.tasks.list({}).find((x) => x.prompt === "and this afterwards")!.meta.steered, undefined);

	// After reopening, the steered message is in the history without an answer of its own.
	await t.app.stop();
	const again = new PineTui({ client: t.app.client, terminal: new FakeTerminal(110, 50) });
	apps.push(again);
	await again.start();
	await until(() => again.screen().join("\n").includes("── now ──"));
	const restored = again.screen().join("\n");
	assert.ok(restored.includes("no, do it the other way") && !restored.includes("steered into task"), restored);
	await again.stop();
	await t.h.close();
});

test("tui: /compact shortens the conversation, /copy takes the last answer, /export writes the conversation as Markdown", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-export-"));
	const copied: string[] = [];
	// Compaction keeps the most recent part as it is; here that is made small, so that a few exchanges are enough to
	// shorten. (The setting has to survive pi reading its settings again, which it does with every new session.)
	const t = await open({ agents: { main: { agent: { settings: { compaction: { keepRecentTokens: 20 } } } } }, model: { reasoning: true } }, [110, 40], { cwd: dir, copy: async (text) => (copied.push(text), true) });
	await t.sees("type a message");
	await t.send("/copy");
	await t.sees("there is no answer to copy yet");
	await t.send("/compact");
	await t.sees("Nothing to shorten yet");

	await t.send(mockMsg([{ reasoning: "weighing it up", tools: [{ name: "bash", args: { command: "echo ran" } }] }, { text: "The **first** answer." }]));
	await t.sees("The first answer.");
	await t.send("second question");
	await t.sees("ECHO[second question]");
	await done(t.h, 2);

	// The last answer as the agent wrote it, not as it is drawn.
	await t.send("/copy");
	await t.sees("copied the last answer");
	assert.deepEqual(copied, ["ECHO[second question]"]);

	// To a file where pine was started, and to the clipboard; "full" adds thinking and tool calls.
	await t.send("/export");
	await t.sees("saved this conversation as");
	const files = fs.readdirSync(dir).filter((f) => /^pine-main-main-\d{8}-\d{4}\.md$/.test(f));
	assert.equal(files.length, 1, fs.readdirSync(dir).join(", "));
	const plain = fs.readFileSync(path.join(dir, files[0]), "utf8");
	assert.ok(plain.startsWith("# main · main\n") && plain.includes("## You\n\nsecond question\n\n## main\n\nECHO[second question]") && plain.includes("The **first** answer.") && !plain.includes("<details>") && !plain.includes("`bash`"), plain);
	await t.send("/export copy full");
	await t.sees("copied the conversation as Markdown");
	assert.ok(copied[1].includes("<details><summary>Thinking</summary>\n\nweighing it up") && copied[1].includes("- ✓ `bash` echo ran"), copied[1]);
	await t.send("/export pdf");
	await t.sees('usage: /export [copy] [full] (not "pdf")');

	// The earlier part becomes a summary; it waits its turn like a message and says what it did.
	await t.send(`one more ${"long question with many words ".repeat(10)}`);
	await done(t.h, 4);
	const before = t.h.mock.state.requests.length;
	await t.send("/compact");
	await t.sees("⟲ shortening the conversation");
	await t.sees(/The earlier part of this conversation is now a summary: about \d+ tokens before/);
	assert.ok(t.h.mock.state.requests.length > before, "the model wrote the summary");
	await t.send("third question");
	await t.sees("ECHO[third question]");
	const sent = JSON.stringify(t.h.mock.state.requests.at(-1).body.messages);
	assert.ok(sent.includes("SUMMARY-OK") && !sent.includes("The **first** answer."), "the model now gets the summary in place of the earlier messages");
	fs.rmSync(dir, { recursive: true, force: true });
	await t.close();
});

test("tui: a bell and a notification when the agent is done or needs approval while the terminal is not in front", async () => {
	const t = await open({ agents: { main: { agent: { approve: ["bash:*rm *"] } } } });
	await t.sees("type a message");
	const calls = () => [...(t.term as any).written.matchAll(/\x07\x1b\]9;([^\x1b]*)\x1b\\/g)].map((m) => m[1]);

	// In front: nothing.
	await t.send("hello");
	await t.sees("ECHO[hello]");
	await done(t.h, 1);
	assert.deepEqual(calls(), []);

	// The window loses the focus: the end of the work is announced, in pine's words and not the agent's.
	t.term.type(["\x1b[O"]);
	await t.send("again");
	await done(t.h, 2);
	await until(() => calls().length === 1, 2000, "a notification");
	assert.deepEqual(calls(), ["pine: main is done"]);

	// So is a question that waits for the owner, and a failure. A stop by the owner is not.
	await t.send(mockMsg([{ tools: [{ name: "bash", args: { command: "touch f; rm f" } }] }]));
	await until(() => calls().includes("pine: main needs your approval"), 3000, "the approval to be announced");
	t.term.type("d");
	await done(t.h, 3);
	await until(() => calls().length === 3, 2000, "the end of that work");

	// Switched off, and remembered by the daemon for the next time the UI opens.
	await t.send("/notify off");
	await t.sees("notifications are off");
	await t.send("quiet");
	await done(t.h, 4);
	await sleep(100);
	assert.equal(calls().length, 3);
	await until(() => t.h.pine.agents.uiTabs().notify === false, 2000, "the setting to be saved");
	await t.send("/notify on");
	await t.sees("notifications are on");
	t.term.type(["\x1b[I"]);
	await t.send("back in front");
	await done(t.h, 5);
	await sleep(100);
	assert.equal(calls().length, 3, "nothing while the window is in front");
	await t.close();
});

test("tui: @ in the input finds a file of the conversation's folder by a few letters, and the agent is told which file and lines", async () => {
	const t = await open({ agents: { main: {} } });
	await t.sees("type a message");
	const ws = t.h.workspace("main");
	fs.mkdirSync(path.join(ws, "src/deep"), { recursive: true });
	fs.mkdirSync(path.join(ws, "node_modules/pkg"), { recursive: true });
	for (const f of ["src/agents.ts", "src/deep/agenda.md", "src/router.ts", "README.md", "node_modules/pkg/agents.js"]) fs.writeFileSync(path.join(ws, f), "x\n");

	// The daemon finds them: the name first, letters in order count, what a walk skips stays out.
	const client = t.app.client;
	assert.deepEqual((await client.find("main", "main", "agents")).files, ["src/agents.ts"]);
	assert.deepEqual((await client.find("main", "main", "agen")).files, ["src/agents.ts", "src/deep/agenda.md"]);
	assert.deepEqual((await client.find("main", "main", "rtr")).files, ["src/router.ts"]);
	assert.deepEqual((await client.find("main", "main", "../")).files, [], "nothing outside the folder");

	// In the input: the list opens after "@", enter takes the file, and lines can be added by hand.
	t.term.type("look at @agen");
	await t.sees("agents.ts");
	await t.sees("agenda.md");
	t.term.type([KEY.enter]);
	await until(() => t.text().includes("look at @src/agents.ts"), 2000, `the file in the input\n${t.text()}`);
	t.term.type(["\x7f"]);
	t.term.type("#3-9 and at @nobody please");
	t.term.type([KEY.esc]);
	t.term.type([KEY.enter]);
	await t.sees("ECHO[");
	await done(t.h, 1);
	const sent = JSON.stringify(t.h.mock.state.requests.at(-1).body.messages.at(-1));
	assert.ok(sent.includes("look at @src/agents.ts#3-9 and at @nobody please") && sent.includes("[your owner points at this file in your working folder: src/agents.ts (lines 3 to 9). Read it before you answer.]"), sent);
	assert.ok(!sent.includes("nobody ("), "a name that is no file of the folder is left as it is");

	// The note is the owner's to cause: a message from outside that claims files gets none.
	t.h.pine.agents.submit({ agent: "main", prompt: "see @src/router.ts", trust: "untrusted", mentions: ["src/router.ts"] });
	await until(() => t.h.pine.tasks.list({ status: "done" }).length >= 2, 4000, "the outside run");
	assert.ok(!t.h.mock.state.requests.some((r: any) => JSON.stringify(r.body.messages).includes("points at this file in your working folder: src/router.ts")));
	await t.close();
});

test("tui: /paste and ctrl+v attach the picture that is on the clipboard", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-paste-test-"));
	const shot = path.join(dir, "shot.png");
	fs.writeFileSync(shot, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
	let onClipboard: string | undefined;
	const t = await open({ agents: { main: {} } }, [110, 30], { clipboardImage: async () => onClipboard });
	await t.sees("type a message");
	await t.send("/paste");
	await t.sees("there is no picture on the clipboard");
	onClipboard = shot;
	await t.send("/paste");
	await t.sees("shot.png");
	// ctrl+v, where the terminal passes it on, does the same with what is on the clipboard then.
	const second = path.join(dir, "second.png");
	fs.copyFileSync(shot, second);
	onClipboard = second;
	t.term.type(["\x16"]);
	await t.sees("second.png");
	fs.rmSync(dir, { recursive: true, force: true });
	await t.close();
});

test("tui: an agent's question is a dialog with its answers to pick from; a number, a click or the owner's own words answer it", async () => {
	const t = await open({ agents: { main: { agent: { mode: "plan" } } } });
	await t.sees("type a message");
	const ask = (choices?: string[]) => mockMsg([{ tools: [{ name: "question", args: { question: "Which way shall I do it?", ...(choices ? { choices } : {}) } }] }]);

	// By number. It is there in plan mode too: asking changes nothing.
	await t.send(ask(["The quick way", "The careful way"]));
	await t.sees("main asks");
	assert.ok(t.text().includes("1  The quick way") && t.text().includes("2  The careful way") && t.text().includes("or in your own words:"), t.text());
	t.term.type("2");
	await t.sees("FINAL:: Your owner answered: The careful way");
	await t.sees("answered (api)");
	assert.ok(!t.text().includes("approval needed"), "a question is not shown as a permission");

	// In the owner's own words, and with a click.
	await t.send(ask(["Yes", "No"]));
	await t.sees("1  Yes");
	t.term.type("only for the first file");
	t.term.type([KEY.enter]);
	await t.sees("FINAL:: Your owner answered: only for the first file");
	await t.send(ask(["Left", "Right"]));
	await t.sees("1  Left");
	const row = t.app.screen().findIndex((l) => l.includes("1  Left"));
	t.term.click(t.app.screen()[row].indexOf("1  Left") + 2, row);
	await t.sees("FINAL:: Your owner answered: Left");

	// Without answers to pick from it is a line to type into; esc leaves it for later, and no answer is said plainly.
	await t.send(ask());
	await t.sees("your answer:");
	t.term.type([KEY.esc]);
	await t.sees("? the agent asks Which way shall I do it?");
	await t.send("/deny");
	await t.sees("Your owner did not answer");

	// A run that the owner did not start has nobody to ask: the tool is not there.
	await t.h.pine.agents.run({ agent: "main", prompt: ask(["a", "b"]), trust: "untrusted" });
	assert.match(t.h.toolResults().at(-1)!, /Tool question not found/);
	await t.close();
});

test("tui: the agent's list of steps is shown and kept up to date, and the agent is reminded of what is open", async () => {
	const t = await open({ agents: { main: {} } }, [110, 40]);
	await t.sees("type a message");
	const list = (...status: string[]) => ({ name: "todo", args: { items: ["read the code", "change it", "run the tests"].map((text, i) => ({ text, status: status[i] })) } });
	await t.send(mockMsg([{ tools: [list("in_progress", "pending", "pending")] }, { tools: [list("done", "in_progress", "pending")] }, { text: "Two steps to go." }]));
	await t.sees("Two steps to go.");
	await done(t.h, 1);
	const screen = t.text();
	assert.ok(screen.includes("steps · 1 of 3 done") && screen.includes("✓ read the code") && screen.includes("◐ change it") && screen.includes("☐ run the tests"), screen);
	assert.equal(count(screen, "steps · "), 1, "one list, updated in place");
	// In the code pane the steps stay at the top, in every view, however far the conversation has moved on.
	await t.send("/code output");
	await until(() => count(t.text(), "steps · 1 of 3 done") === 2, 4000, `the steps in the pane too\n${t.text()}`);
	assert.equal(count(t.text(), "◐ change it"), 2);
	await t.send("/code files");
	await sleep(150);
	assert.equal(count(t.text(), "steps · 1 of 3 done"), 2, "also in another view");
	await t.send("/code off");
	await until(() => count(t.text(), "steps · 1 of 3 done") === 1, 4000, "the pane to close");
	assert.match(t.h.toolResults().at(-1)!, /- \[x\] read the code\n- \[~\] change it\n- \[ \] run the tests\n2 of 3 still to do\./);

	// With the next message the agent is shown what is still open.
	await t.send("go on");
	await t.sees("ECHO[go on]");
	const note = notesOf(t.h.mock.state.requests.at(-1)).join("\n");
	assert.ok(note.includes("Your list of steps in this conversation") && note.includes("- [~] change it"), note);

	// It is the conversation's: there after the UI opens again, gone after a reset. A run from outside has no such tool.
	assert.equal((await t.app.client.todos("main", "main")).length, 3);
	await t.send("/reset");
	await t.sees("fresh conversation");
	assert.deepEqual(await t.app.client.todos("main", "main"), []);
	await t.h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: [list("pending", "pending", "pending")] }]), trust: "untrusted" });
	assert.match(t.h.toolResults().at(-1)!, /Tool todo not found/);
	await t.close();
});
