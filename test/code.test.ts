import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { PineTui } from "../src/tui/app.ts";
import { Client } from "../src/tui/client.ts";
import { diffLines } from "../src/tui/code-pane.ts";
import { harness, mockMsg, notesOf, sleep, until, refused } from "./support/harness.ts";
import { FakeTerminal } from "./support/terminal.ts";
import { sandboxAvailable } from "../src/security.ts";

const owner = { trust: "owner" as const };
const mac = { skip: !sandboxAvailable() };
const call = (name: string, args: any) => ({ name, args });
const CTRL_G = "\x07";

/** A project folder somewhere in the account, outside every agent's reach until it is opened for a conversation. */
function project(t: { after(fn: () => void): void }, repo = true): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".pine-test-project-")));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "notes.txt"), "PROJECT-NOTES\n");
	fs.writeFileSync(path.join(dir, "src", "app.ts"), "export const answer = 41;\nexport const name = \"app\";\n");
	if (repo) {
		const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
		git("init", "-q", "-b", "main");
		git("add", ".");
		git("commit", "-q", "-m", "first");
	}
	return dir;
}

const apps: PineTui[] = [];
after(async () => {
	for (const app of apps) await app.stop().catch(() => {});
});

test("folder: a conversation that is given a folder works there; no other conversation and no outside content does", mac, async (t) => {
	const dir = project(t, false);
	fs.writeFileSync(path.join(dir, "AGENTS.md"), "FOLDER-RULES: tabs, not spaces\n");
	const theirs = project(t, false);
	const h = await harness({ agents: { main: {}, other: { agent: { workspace: theirs } } } });
	const run = (steps: any[], session: string, trust: "owner" | "untrusted" = "owner") => h.pine.agents.run({ agent: "main", prompt: mockMsg(steps), session, trust });
	const look = [{ tools: [call("bash", { command: `pwd; cat ${dir}/notes.txt` })] }];

	await run(look, "proj");
	assert.match(h.toolResults().at(-1)!, refused, "closed before it is opened");

	assert.deepEqual(await h.pine.agents.setFolder("main", "proj", dir), { folder: dir });
	await run([{ tools: [call("bash", { command: "pwd; cat notes.txt; echo made-here > made.txt" }), call("read", { path: "notes.txt" }), call("write", { path: "src/new.ts", content: "export {};\n" })] }], "proj");
	const out = h.toolResults().slice(-3);
	assert.ok(out[0].includes(dir) && out[0].includes("PROJECT-NOTES"), `its tools start in the folder: ${out[0]}`);
	assert.ok(out[1].includes("PROJECT-NOTES"), out[1]);
	assert.equal(fs.readFileSync(path.join(dir, "made.txt"), "utf8"), "made-here\n");
	assert.equal(fs.readFileSync(path.join(dir, "src", "new.ts"), "utf8"), "export {};\n");
	const req = h.mock.state.requests.at(-1);
	assert.ok(notesOf(req).join("\n").includes(`Your owner opened the folder ${dir}`), "the agent is told where it works");
	assert.ok(h.system(req).includes("FOLDER-RULES") && h.system(req).includes("PERSONA-MAIN"), "the folder's instruction file applies, and the agent's own still does");

	// The agent's other conversations, and this one when it handles outside content, have none of it.
	await run(look, "main");
	assert.match(h.toolResults().at(-1)!, refused);
	await run([{ tools: [call("read", { path: path.join(dir, "notes.txt") })] }], "proj", "untrusted");
	assert.ok(!h.toolResults().at(-1)!.includes("PROJECT-NOTES") && !notesOf(h.mock.state.requests.at(-1)).join("\n").includes("Your owner opened the folder"), `a folder is opened for the owner's conversation, not for what outside content says in it: ${h.toolResults().at(-1)}`);

	// What it can never be: pine's own files, the program, another agent's workspace, something that is not a folder.
	await assert.rejects(h.pine.agents.setFolder("main", "proj", h.home), /pine's own folder/);
	await assert.rejects(h.pine.agents.setFolder("main", "proj", path.dirname(h.home)), /pine's own folder/);
	await assert.rejects(h.pine.agents.setFolder("main", "proj", path.resolve(import.meta.dirname, "..", "src")), /pine's own code/);
	await assert.rejects(h.pine.agents.setFolder("main", "proj", path.join(theirs, "src")), /workspace of the agent other/);
	await assert.rejects(h.pine.agents.setFolder("main", "proj", path.join(dir, "notes.txt")), /is not a folder/);
	assert.equal(h.pine.agents.folderOf("main", "proj"), dir, "a refused change leaves what was");

	// It belongs to the conversation: listed with it, renamed with it, gone with it.
	assert.deepEqual(h.pine.agents.folders("main"), [{ session: "proj", folder: dir }]);
	assert.equal(h.pine.agents.conversations("main").find((x) => x.session === "proj")?.folder, dir);
	await h.pine.agents.renameSession("main", "proj", "work");
	assert.deepEqual(h.pine.agents.folders("main"), [{ session: "work", folder: dir }]);
	await h.pine.agents.setFolder("main", "work", null);
	await run(look, "work");
	assert.match(h.toolResults().at(-1)!, refused, "closed again from the next message on");
	await h.pine.agents.setFolder("main", "work", dir);
	await h.pine.agents.removeSession("main", "work");
	assert.deepEqual(h.pine.agents.folders("main"), []);
	await h.close();
});

test("folder: a task handed to another agent is done in the conversation's folder, for that one run", mac, async (t) => {
	const dir = project(t, false);
	const h = await harness({ agents: { main: { agent: { delegates: ["helper"] } }, helper: {} } });
	await h.pine.agents.setFolder("main", "main", dir);
	h.mock.state.scripts.helper = [{ tools: [call("read", { path: "notes.txt" }), call("bash", { command: "pwd; echo by-helper | tee from-helper.txt" })] }];
	const hand = (args: Record<string, unknown>) => h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: [call("delegate", { agent: "helper", task: "@@REF:helper@@", ...args })] }]), ...owner });

	// The specialist sees the project it is asked about, and its work lands there.
	await hand({});
	const seen = h.requestsFor("PERSONA-HELPER").at(-1);
	assert.ok(h.toolResults(seen)[0].includes("PROJECT-NOTES"), h.toolResults(seen)[0]);
	assert.ok(h.toolResults(seen)[1].includes(dir));
	assert.equal(fs.readFileSync(path.join(dir, "from-helper.txt"), "utf8"), "by-helper\n");
	assert.ok(notesOf(h.requestsFor("PERSONA-HELPER")[0]).join("\n").includes(`opened the folder ${dir}`));

	// A conversation the other agent keeps (a thread) does not: it would keep the folder for good.
	fs.rmSync(path.join(dir, "from-helper.txt"));
	await hand({ thread: "books" });
	const kept = h.requestsFor("PERSONA-HELPER").at(-1);
	assert.match(h.toolResults(kept)[0], /ENOENT|no such file/i);
	assert.ok(!fs.existsSync(path.join(dir, "from-helper.txt")));
	// And by itself the helper has no folder at all.
	await h.pine.agents.run({ agent: "helper", prompt: mockMsg([{ tools: [call("read", { path: path.join(dir, "notes.txt") })] }]), ...owner });
	assert.match(h.toolResults().at(-1)!, /outside the paths this agent may read/);
	await h.close();
});

test("code view: changes, diffs, files and file text of a conversation's folder, and nothing outside it", mac, async (t) => {
	const dir = project(t);
	const outside = project(t, false);
	const h = await harness({ pine: { http: { port: 0 } }, agents: { main: { files: { "own.txt": "in the workspace\n" } } } });
	const client = new Client(`http://127.0.0.1:${h.pine.http!.port}`, h.pine.token);
	await client.setFolder("main", "proj", dir);

	// A repository must not get to run anything because it was looked at.
	const marker = path.join(outside, "ran");
	fs.appendFileSync(path.join(dir, ".git", "config"), `[diff]\n\texternal = touch ${marker} #\n[core]\n\tfsmonitor = touch ${marker} #\n[diff "x"]\n\ttextconv = touch ${marker} #\n`);
	fs.writeFileSync(path.join(dir, ".gitattributes"), "*.ts diff=x\n");

	fs.writeFileSync(path.join(dir, "src", "app.ts"), "export const answer = 42;\nexport const name = \"app\";\nexport const more = true;\n");
	fs.writeFileSync(path.join(dir, "fresh.md"), "# new\n\ntext\n");
	fs.rmSync(path.join(dir, "notes.txt"));
	fs.symlinkSync(path.join(outside, "notes.txt"), path.join(dir, "leak.txt"));
	fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([1, 2, 0, 3]));

	const ch = await client.changes("main", "proj");
	assert.equal(ch.root, dir);
	assert.ok(ch.repo && ch.branch === "main");
	const byPath = Object.fromEntries(ch.files.map((f) => [f.path, f]));
	assert.deepEqual(byPath["src/app.ts"], { path: "src/app.ts", status: "M", added: 2, removed: 1 });
	assert.deepEqual(byPath["notes.txt"], { path: "notes.txt", status: "D", added: 0, removed: 1 });
	assert.deepEqual(byPath["fresh.md"], { path: "fresh.md", status: "?", added: 3 });

	const diff = await client.diff("main", "proj", "src/app.ts");
	assert.ok(diff.diff.includes("-export const answer = 41;") && diff.diff.includes("+export const answer = 42;"), diff.diff);
	assert.ok((await client.diff("main", "proj", "fresh.md")).diff.includes("+# new"), "a file git does not know yet is all new");
	assert.ok(!fs.existsSync(marker), "nothing the repository's configuration names was run");
	await assert.rejects(client.diff("main", "proj", "../../etc/hosts"), /nothing there|404/);

	const names = (await client.tree("main", "proj", "")).entries.map((e) => `${e.name}${e.dir ? "/" : ""}`);
	assert.deepEqual(names, ["src/", ".gitattributes", "blob.bin", "fresh.md"], "folders first; git's own folder and a link that leads out are left out");
	assert.deepEqual((await client.tree("main", "proj", "src")).entries.map((e) => e.name), ["app.ts"]);
	assert.equal((await client.file("main", "proj", "fresh.md")).text, "# new\n\ntext\n");
	assert.deepEqual(await client.file("main", "proj", "blob.bin"), { size: 4, binary: true, truncated: false });
	for (const bad of ["leak.txt", "../notes.txt", path.join(outside, "notes.txt"), "src"]) await assert.rejects(client.file("main", "proj", bad), /nothing there|404/, bad);
	await assert.rejects(client.tree("main", "proj", ".."), /nothing there|404/);

	// A conversation without a folder shows the agent's own workspace, which is no repository here.
	assert.deepEqual((await client.tree("main", "main", "")).entries.map((e) => e.name), ["own.txt"]);
	assert.equal((await client.changes("main", "main")).repo, false);
	assert.equal((await fetch(`http://127.0.0.1:${h.pine.http!.port}/agents/main/view/tree?session=proj`)).status, 401);
	await h.close();
});

test("code pane: diff lines are coloured and the lines that only name the file are left out", () => {
	const lines = diffLines("diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n\\ No newline at end of file\n");
	assert.deepEqual(lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")), ["@@ -1,2 +1,2 @@", "-old", "+new", " same", "\\ No newline at end of file"]);
});

test("tui: the code pane shows changes, files and tool output; the folder is set from the bar and with pine <folder>", mac, async (t) => {
	const dir = project(t);
	const second = project(t, false);
	const h = await harness({ pine: { main: "main", http: { port: 0 } }, agents: { main: {} } });
	const term = new FakeTerminal(130, 36);
	const client = new Client(`http://127.0.0.1:${h.pine.http!.port}`, h.pine.token);
	let chosen: string | undefined = second;
	const app = new PineTui({ client, terminal: term, mode: "test", cwd: dir, chooseFolder: async () => chosen });
	apps.push(app);
	await app.start();
	const text = () => app.screen().join("\n");
	const sees = (what: string | RegExp, ms = 4000) => until(() => (typeof what === "string" ? text().includes(what) : what.test(text())), ms, `the screen to show ${what}\n--- screen ---\n${text()}`);
	const send = async (line: string) => {
		term.type(line);
		term.type(["\r"]);
		await sleep(15);
	};
	const click = async (needle: string, nth = 1) => {
		await sees(needle);
		const lines = app.screen();
		const rows = lines.map((l, i) => (l.includes(needle) ? i : -1)).filter((i) => i >= 0);
		const y = rows[Math.min(nth, rows.length) - 1];
		term.click(lines[y].lastIndexOf(needle) + 1, y);
		await sleep(15);
	};

	// pine <folder>: a conversation of the main agent, named after the folder, that works there.
	await app.openFolder(dir);
	const name = path.basename(dir).replace(/^\.+/, "").slice(0, 24).replace(/[-.]+$/, "");
	await sees(`2 main·${name.slice(0, 16)}`);
	await sees(`works in ~/${path.basename(dir)}`);
	assert.deepEqual(await client.folders("main"), [{ session: name, folder: dir }]);
	await app.openFolder(dir);
	assert.equal((text().split("\n")[0].match(/main·/g) ?? []).length, 1, "the same folder again opens the same conversation, not another");
	assert.match(app.screen().at(-1)!, new RegExp(`main · ${name} · ~/${path.basename(dir).replace(/\./g, "\\.")} · mock/m`), "the bar at the bottom names the folder");

	// The agent changes a file there; the pane lists it and shows the diff.
	await send(mockMsg([{ tools: [call("bash", { command: "printf 'export const answer = 42;\\n' > src/app.ts; echo BUILD-OUTPUT-LINE" })] }, { text: "changed" }]));
	await sees("changed");
	assert.ok(!text().includes("Changes"), "closed until it is asked for");
	await click("▤ code");
	await sees(/Changes\s+Files\s+Output/);
	await sees(/M src\/app\.ts\s+\+1 −2/);
	await sees(/main · 1 changed/);
	assert.ok(text().includes("│") && text().includes("ECHO") === false && text().includes("changed"), "the conversation stays beside it");
	await click("src/app.ts");
	await sees("+export const answer = 42;");
	assert.ok(text().includes("-export const answer = 41;") && text().includes("‹ back · src/app.ts"));

	// It follows what the agent does: the next change is there without asking.
	await send(mockMsg([{ tools: [call("bash", { command: "printf 'export const answer = 43;\\n' > src/app.ts" })] }, { text: "again" }]));
	await sees("+export const answer = 43;");
	await click("‹ back");
	await sees(/M src\/app\.ts/);

	// Files: a tree that opens on a click, and a file with its text.
	await click(" Files ");
	await sees("▸ src/");
	await sees(/notes\.txt 14 B/);
	await click("▸ src/");
	await sees(/app\.ts 2\d B/);
	await click("app.ts");
	await sees(/1 export const answer = 43;/);
	await click("‹ back");

	// Output: every tool call of the conversation, with all it printed.
	await click(" Output ");
	await sees(/✓ bash printf 'export const answer = 42/);
	await sees(/2 tool calls/);
	await click("answer = 42");
	await sees("BUILD-OUTPUT-LINE");

	// Closed with the same button, with ctrl+g and with /code; it is remembered for the next start.
	const paneOpen = () => /Changes\s+Files\s+Output/.test(text());
	await click("▤ code");
	await until(() => !paneOpen());
	term.type([CTRL_G]);
	await until(paneOpen);
	await until(async () => (await client.tabs()).code === true);
	await send("/code off");
	await until(() => !paneOpen());
	await sleep(30);
	assert.equal((await client.tabs()).code, false);
	await send("/code files");
	await sees("▾ src/");

	// The folder menu: no folder, where pine was started, folders in use, or one that is picked.
	await click(`~/${path.basename(dir)}`, 99);
	await sees(`Folder for main·${name}`);
	await sees(/No folder\s+main's own workspace/);
	await click("Pick a folder");
	await sees(`this conversation now works in ~/${path.basename(second)}`);
	await sees(/This folder is not in a git|notes\.txt 14 B/);
	assert.equal(h.pine.agents.folderOf("main", name), second);
	await send("/folder none");
	await sees("works in main's own workspace again");
	assert.match(app.screen().at(-1)!, new RegExp(`main · ${name} · no folder · mock/m`));
	await send(`/folder ${h.home}`);
	await sees("the folder was not changed: that is pine's own folder");
	chosen = undefined;
	// A folder dropped on the terminal is opened; a file dropped there is attached, as before.
	term.paste(dir);
	await sees(`this conversation now works in ~/${path.basename(dir)}`);
	term.paste(path.join(dir, "notes.txt"));
	await sees(/attached: notes\.txt/);
	await send("/detach");

	// In a narrow terminal the pane takes the whole width.
	await app.stop();
	const narrow = new PineTui({ client, terminal: new FakeTerminal(70, 24), mode: "test" });
	apps.push(narrow);
	await narrow.start();
	await until(() => /M src\/app\.ts/.test(narrow.screen().join("\n")), 4000, `the pane to be open again\n${narrow.screen().join("\n")}`);
	assert.ok(!narrow.screen().join("\n").includes("earlier in this session"), "only the pane, where both do not fit");
	await narrow.stop();
	await h.close();
});
