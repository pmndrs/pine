import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { sandboxAvailable } from "../src/security.ts";
import { MAX_FILE, Snapshots } from "../src/snapshots.ts";
import { PineTui } from "../src/tui/app.ts";
import { Client } from "../src/tui/client.ts";
import { harness, type Harness, MCP_STUB, mockMsg, sleep, until } from "./support/harness.ts";
import { FakeTerminal } from "./support/terminal.ts";

// Everything here writes files through git in a sandbox, so it needs one.
const mac = { skip: !sandboxAvailable() };
const call = (name: string, args: any) => ({ name, args });
const bash = (command: string) => call("bash", { command });

/** A folder somewhere in the account, as the owner would open one for a conversation. */
function project(t: { after(fn: () => void): void }, repo = false): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".pine-test-undo-")));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "notes.txt"), "NOTES-1\n");
	fs.writeFileSync(path.join(dir, "src", "app.ts"), "export const answer = 41;\n");
	if (repo) {
		const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
		git("init", "-q", "-b", "main");
		git("add", ".");
		git("commit", "-q", "-m", "first");
	}
	return dir;
}

const read = (dir: string, file: string) => (fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), "utf8") : undefined);
/** What the owner wrote in a conversation, oldest first, as a UI would list it. */
const said = (h: Harness, session: string) => h.pine.tasks.list({ agent: "main", session }).filter((t) => t.kind === "prompt").reverse().map((t) => t.prompt.replace(/<<MOCK[\s\S]*?>>/, "").trim());
/** What the model was sent as the conversation, in the last request. */
const context = (h: Harness) => h.mock.state.requests.at(-1).body.messages.filter((m: any) => m.role === "user").map((m: any) => JSON.stringify(m.content)).join("\n");

const apps: PineTui[] = [];
after(async () => {
	for (const app of apps) await app.stop().catch(() => {});
});

test("undo: the last message is taken back with its files, redo brings both back, and a second undo goes further", mac, async (t) => {
	const dir = project(t, true);
	const h = await harness({ agents: { main: {} } });
	await h.pine.agents.setFolder("main", "proj", dir);
	const say = (text: string, steps?: any[]) => h.pine.agents.run({ agent: "main", prompt: steps ? `${text} ${mockMsg(steps)}` : text, session: "proj", trust: "owner" });

	await say("FIRST change the notes", [{ tools: [bash("echo NOTES-2 > notes.txt; echo made > first.txt")] }]);
	await say("SECOND rewrite the app", [{ tools: [call("write", { path: "src/app.ts", content: "export const answer = 42;\n" }), bash("rm notes.txt; mkdir -p deep/er; echo x > deep/er/new.txt")] }]);
	assert.equal(read(dir, "src/app.ts"), "export const answer = 42;\n");
	assert.deepEqual(said(h, "proj"), ["FIRST change the notes", "SECOND rewrite the app"]);
	const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString();

	// The last message: its three changes are gone, what the first one did stays.
	const undone = await h.pine.agents.undo("main", "proj");
	assert.ok(undone.prompt.startsWith("SECOND rewrite the app"), undone.prompt);
	assert.deepEqual({ changed: undone.restored?.changed, removed: undone.restored?.removed, back: undone.restored?.back }, { changed: 1, removed: 1, back: 1 });
	assert.deepEqual([...undone.restored!.files].sort(), ["deep/er/new.txt", "notes.txt", "src/app.ts"]);
	assert.equal(undone.restored!.root, dir);
	assert.deepEqual([undone.redo, undone.more, undone.stopped], [1, true, 0]);
	assert.equal(read(dir, "src/app.ts"), "export const answer = 41;\n");
	assert.equal(read(dir, "notes.txt"), "NOTES-2\n");
	assert.equal(read(dir, "first.txt"), "made\n");
	assert.ok(!fs.existsSync(path.join(dir, "deep")), "a folder that held only what the message made is gone with it");
	assert.deepEqual(said(h, "proj"), ["FIRST change the notes"]);
	// The owner's own repository was not touched: no commit, nothing staged, no trace in .git.
	assert.equal(execFileSync("git", ["-C", dir, "rev-parse", "HEAD"]).toString(), head);
	assert.equal(execFileSync("git", ["-C", dir, "diff", "--cached", "--name-only"]).toString(), "");
	assert.ok(!execFileSync("git", ["-C", dir, "for-each-ref"]).toString().includes("pine"));

	// Redo: files and conversation are as the message had left them.
	const redone = await h.pine.agents.redo("main", "proj");
	assert.ok(redone.prompt.startsWith("SECOND"));
	assert.equal(redone.redo, 0);
	assert.equal(read(dir, "src/app.ts"), "export const answer = 42;\n");
	assert.equal(read(dir, "notes.txt"), undefined);
	assert.equal(read(dir, "deep/er/new.txt"), "x\n");
	assert.deepEqual(said(h, "proj"), ["FIRST change the notes", "SECOND rewrite the app"]);
	await assert.rejects(h.pine.agents.redo("main", "proj"), /nothing to bring back/);

	// Twice: one message further back each time, and redo returns in the opposite order.
	await h.pine.agents.undo("main", "proj");
	const first = await h.pine.agents.undo("main", "proj");
	assert.ok(first.prompt.startsWith("FIRST"));
	assert.deepEqual([first.redo, first.more], [2, false]);
	assert.equal(read(dir, "notes.txt"), "NOTES-1\n");
	assert.equal(read(dir, "first.txt"), undefined);
	assert.deepEqual(said(h, "proj"), []);
	await assert.rejects(h.pine.agents.undo("main", "proj"), /no message of yours/);
	assert.ok((await h.pine.agents.redo("main", "proj")).prompt.startsWith("FIRST"));
	assert.equal(read(dir, "notes.txt"), "NOTES-2\n");
	assert.equal(read(dir, "src/app.ts"), "export const answer = 41;\n");
	assert.ok((await h.pine.agents.redo("main", "proj")).prompt.startsWith("SECOND"));
	assert.equal(read(dir, "src/app.ts"), "export const answer = 42;\n");

	// The model is shown the conversation as it stands: after an undo, without the message taken back.
	await h.pine.agents.undo("main", "proj");
	await say("THIRD instead");
	assert.ok(context(h).includes("FIRST change the notes") && context(h).includes("THIRD instead") && !context(h).includes("SECOND rewrite"), context(h));
	// A new message makes the undo final.
	await assert.rejects(h.pine.agents.redo("main", "proj"), /nothing to bring back/);
	assert.equal(read(dir, "src/app.ts"), "export const answer = 41;\n");
	// The same words sent again are a new message: what is shown of it is its own work, not that of the one taken back.
	const shown = (id: number) => h.pine.agents.transcript(id)!.entries.filter((e) => e.kind === "tool").map((e) => e.subject);
	h.mock.state.scripts.job = [{ tools: [bash("echo one > job.txt")] }];
	const one = await say("DO the job @@REF:job@@");
	await say("AND then");
	assert.deepEqual(shown(one.id), ["echo one > job.txt"]);
	await h.pine.agents.undo("main", "proj");
	await h.pine.agents.undo("main", "proj");
	h.mock.state.scripts.job = [{ tools: [bash("echo two > job.txt")] }];
	const two = await say("DO the job @@REF:job@@");
	assert.deepEqual(shown(two.id), ["echo two > job.txt"]);
	await h.close();
});

test("undo: what lies outside the folder stays, a link out of it is not followed, ignored and large files are left alone", mac, async (t) => {
	const dir = project(t, true);
	const outside = project(t);
	fs.writeFileSync(path.join(outside, "victim.txt"), "OUTSIDE-ORIGINAL\n");
	fs.writeFileSync(path.join(dir, "src", "victim.txt"), "inside\n");
	fs.writeFileSync(path.join(dir, ".gitignore"), "ignored/\n");
	fs.mkdirSync(path.join(dir, "ignored"));
	fs.writeFileSync(path.join(dir, "ignored", "cache.txt"), "cache-1\n");
	// The repository's own configuration names programs for git to run. None of it may run.
	const marker = path.join(outside, "ran");
	fs.appendFileSync(path.join(dir, ".git", "config"), `[core]\n\tfsmonitor = touch ${marker} #\n\thooksPath = ${outside}\n[filter "x"]\n\tclean = touch ${marker} #\n\tsmudge = touch ${marker} #\n`);
	fs.writeFileSync(path.join(dir, ".gitattributes"), "* filter=x\n*.txt text eol=crlf\n");
	fs.writeFileSync(path.join(outside, "post-checkout"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
	const h = await harness({ agents: { main: {} } });
	await h.pine.agents.setFolder("main", "proj", dir);
	// The agent is given the place beside the folder too, as an owner who trusts it might.
	h.pine.bus.subscribe("approval/requested", (e) => void h.pine.approvals.decide((e.payload as any).id, true, "test"));
	const big = "x".repeat(MAX_FILE + 10);
	fs.writeFileSync(path.join(dir, "big.bin"), big);

	// One message: changes in the folder, in an ignored folder, in a large file and outside the
	// folder, and it swaps a folder of the project for a link that leads out of it.
	await h.pine.agents.run({
		agent: "main", session: "proj", trust: "owner",
		prompt: `TRICKY ${mockMsg([
			{ tools: [call("request_access", { path: outside, write: true, reason: "test" })] },
			{ tools: [bash(`echo NOTES-2 > notes.txt; echo cache-2 > ignored/cache.txt; echo more | tee -a big.bin; echo written-outside > ${outside}/made.txt; rm -r src; ln -s ${outside}/src src`)] },
		])}`,
	});
	assert.equal(read(outside, "made.txt"), "written-outside\n", h.toolResults().join("\n"));
	assert.ok(fs.lstatSync(path.join(dir, "src")).isSymbolicLink());
	fs.writeFileSync(path.join(outside, "src", "victim.txt"), "OUTSIDE-ORIGINAL\n");

	const r = await h.pine.agents.undo("main", "proj");
	assert.equal(r.note, undefined);
	// In the folder: back, byte for byte, although the folder says text files get other line ends.
	assert.equal(read(dir, "notes.txt"), "NOTES-1\n");
	assert.ok(fs.lstatSync(path.join(dir, "src")).isDirectory(), "the link is gone and the folder is a folder again");
	assert.equal(read(dir, "src/app.ts"), "export const answer = 41;\n");
	assert.equal(read(dir, "src/victim.txt"), "inside\n");
	// Outside: the file of the same name that the link led to is as it was, and what the command wrote there stays.
	assert.equal(read(outside, "src/victim.txt"), "OUTSIDE-ORIGINAL\n");
	assert.equal(read(outside, "made.txt"), "written-outside\n");
	// Not recorded, so not touched.
	assert.equal(read(dir, "ignored/cache.txt"), "cache-2\n");
	assert.equal(read(dir, "big.bin"), `${big}more\n`);
	assert.ok(!fs.existsSync(marker), "nothing the repository's configuration or attributes name was run");
	// The states are kept in pine's own data folder, which no agent can write.
	const kept = fs.readdirSync(path.join(h.pine.cfg.dataDir, "snapshots"));
	assert.equal(kept.length, 1);
	assert.equal(fs.readFileSync(path.join(h.pine.cfg.dataDir, "snapshots", kept[0], "pine-folder"), "utf8"), dir);

	// And back again: the link is a link again, and still nothing outside was written.
	await h.pine.agents.redo("main", "proj");
	assert.ok(fs.lstatSync(path.join(dir, "src")).isSymbolicLink());
	assert.equal(read(dir, "notes.txt"), "NOTES-2\n");
	assert.equal(read(outside, "src/victim.txt"), "OUTSIDE-ORIGINAL\n");
	assert.ok(!fs.existsSync(marker));
	await h.close();
});

test("snapshots: a restore sets only the files it is asked for, never through a link, and its git cannot write beside the folder", mac, async (t) => {
	const dir = project(t);
	const outside = project(t);
	fs.writeFileSync(path.join(outside, "app.ts"), "OUTSIDE\n");
	const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pine-snap-")));
	t.after(() => fs.rmSync(store, { recursive: true, force: true }));
	const snaps = new Snapshots(store);
	const before = await snaps.take(dir);
	fs.writeFileSync(path.join(dir, "src", "app.ts"), "export const answer = 42;\n");
	fs.writeFileSync(path.join(dir, "new.txt"), "new\n");
	const after = await snaps.take(dir);
	assert.deepEqual(await snaps.changed(dir, before, after), [{ path: "new.txt", status: "A", added: 1, removed: 0 }, { path: "src/app.ts", status: "M", added: 1, removed: 1 }]);
	assert.ok((await snaps.diff(dir, before, after, "src/app.ts"))!.diff.includes("+export const answer = 42;"));
	assert.equal((await snaps.diff(dir, before, after, "../../etc/hosts"))?.diff ?? "", "");

	// The folder is swapped for a link out of it after the last state was taken.
	fs.rmSync(path.join(dir, "src"), { recursive: true });
	fs.symlinkSync(outside, path.join(dir, "src"));
	const done = await snaps.restore(dir, before, { within: [before, after] });
	assert.deepEqual(done.files.map((f) => `${f.status} ${f.path}`).sort(), ["A src/app.ts", "D new.txt"], "seen from the folder as it was found: one file comes back, one goes");
	assert.equal(read(outside, "app.ts"), "OUTSIDE\n");
	assert.equal(read(dir, "src/app.ts"), "export const answer = 41;\n");
	assert.ok(fs.lstatSync(path.join(dir, "src")).isDirectory());
	assert.equal(read(dir, "new.txt"), undefined);

	// What the owner changed since, in a file the two states do not differ in, stays.
	fs.writeFileSync(path.join(dir, "notes.txt"), "OWNER-EDIT\n");
	await snaps.restore(dir, after, { only: done.paths });
	assert.equal(read(dir, "src/app.ts"), "export const answer = 42;\n");
	assert.equal(read(dir, "notes.txt"), "OWNER-EDIT\n");

	// A file that grew too large is in no state from then on: no restore puts an old version over it or deletes it.
	const small = await snaps.take(dir);
	fs.writeFileSync(path.join(dir, "new.txt"), "y".repeat(MAX_FILE + 1));
	fs.writeFileSync(path.join(dir, "src", "app.ts"), "export const answer = 43;\n");
	const large = await snaps.take(dir);
	assert.deepEqual(large.skipped, ["new.txt"]);
	const back = await snaps.restore(dir, small, { within: [small, large] });
	assert.deepEqual(back.left, ["new.txt"]);
	assert.equal(fs.statSync(path.join(dir, "new.txt")).size, MAX_FILE + 1);
	assert.equal(read(dir, "src/app.ts"), "export const answer = 42;\n");
	await snaps.restore(dir, large, { only: [...back.paths, "new.txt"], avoid: [small] });
	assert.equal(fs.statSync(path.join(dir, "new.txt")).size, MAX_FILE + 1);
	assert.equal(read(dir, "src/app.ts"), "export const answer = 43;\n");

	// Whatever git were talked into, the sandbox it runs in lets it write the folders named and nothing else.
	const { git } = await import("../src/workspace-view.ts");
	assert.notEqual((await git(dir, ["init", "-q", path.join(outside, "made-by-git")], { write: [dir] })).code, 0);
	assert.ok(!fs.existsSync(path.join(outside, "made-by-git")));
	assert.notEqual((await git(dir, ["init", "-q", path.join(dir, "made-by-git")])).code, 0, "without a folder named it can only look");
	assert.equal((await git(dir, ["init", "-q", path.join(dir, "made-by-git")], { write: [dir] })).code, 0);
});

test("undo: what runs is stopped first, sub-agents belong to the message that started them, and history stays gone after a restart", mac, async () => {
	const h = await harness({ pine: { http: { port: 0 } }, agents: { main: { files: { "plan.md": "PLAN-1\n" } } } });
	const ws = h.workspace("main");
	let client = new Client(`http://127.0.0.1:${h.pine.http!.port}`, h.pine.token);
	// The agent's own workspace is no repository: it is recorded all the same.
	h.mock.state.scripts.child = [{ tools: [bash("echo by-child > child.txt")] }, { text: "child done" }];
	await client.ask("main", `KEEP this one ${mockMsg([{ tools: [bash("echo kept > kept.txt")] }, { text: "kept" }])}`, "main");
	const { task } = await client.prompt("main", `LONG job ${mockMsg([{ tools: [bash("echo PLAN-2 > plan.md"), call("subagent", { tasks: ["@@REF:child@@"] })] }, { tools: [bash("sleep 30")] }])}`, "main");
	await until(() => fs.existsSync(path.join(ws, "child.txt")) && h.toolResults().some((x) => x.includes("child done")), 8000, "the sub-agent's file and its answer");
	await until(() => h.pine.agents.status().running.some((r) => r.task === task), 2000, "the long command");
	await sleep(200);

	const r = await client.undo("main", "main");
	assert.ok(r.prompt.startsWith("LONG job"));
	assert.equal(r.stopped, 1);
	assert.equal(h.pine.agents.status().running.length, 0, "nothing is left running");
	assert.equal(read(ws, "plan.md"), "PLAN-1\n");
	assert.equal(read(ws, "child.txt"), undefined, "what its sub-agent made is gone with it");
	assert.equal(read(ws, "kept.txt"), "kept\n");
	assert.deepEqual(said(h, "main"), ["KEEP this one"]);
	assert.equal(h.pine.tasks.list({ limit: 100 }).filter((t) => t.kind === "subagent").length, 0, "the sub-agent's task left the list with it");
	assert.equal((await client.history("main", "main")).length, 1);

	// After a restart: the message is still gone from the list, and it can still be brought back.
	await h.restart();
	client = new Client(`http://127.0.0.1:${h.pine.http!.port}`, h.pine.token);
	assert.deepEqual(said(h, "main"), ["KEEP this one"]);
	const redone = await client.redo("main", "main");
	assert.ok(redone.prompt.startsWith("LONG job"));
	assert.equal(read(ws, "plan.md"), "PLAN-2\n");
	assert.equal(read(ws, "child.txt"), "by-child\n");
	assert.deepEqual(said(h, "main"), ["KEEP this one", "LONG job"]);
	assert.equal(h.pine.tasks.list({ limit: 100 }).filter((t) => t.kind === "subagent").length, 1);
	// Taken back once more, and after another restart the model is not shown it either.
	await client.undo("main", "main");
	await h.restart();
	await h.pine.agents.run({ agent: "main", prompt: "AFTER the restart", trust: "owner" });
	assert.ok(context(h).includes("KEEP this one") && context(h).includes("AFTER the restart") && !context(h).includes("LONG job"), context(h));
	assert.deepEqual(said(h, "main"), ["KEEP this one", "AFTER the restart"]);
	await assert.rejects(h.pine.agents.redo("main", "main"), /nothing to bring back/);
	await h.close();
});

test("undo: only the owner's own messages are taken back, and what was allowed while one was worked on goes with it", mac, async (t) => {
	const dir = project(t);
	const feed = { command: process.execPath, args: [MCP_STUB], env: { MCP_LABEL: "feed" }, taints: true };
	const h = await harness({ pine: { http: { port: 0 } }, agents: { main: { agent: { mcp: { feed } } } } });
	h.pine.bus.subscribe("approval/requested", (e) => void h.pine.approvals.decide((e.payload as any).id, true, "test", true));
	const say = (text: string, steps: any[], trust: "owner" | "untrusted" = "owner") => h.pine.agents.run({ agent: "main", session: "s", trust, prompt: `${text} ${mockMsg(steps)}` });
	const tainted = () => h.pine.agents.kv.get<string>("taint:main:s") ?? undefined;
	const look = [{ tools: [call("read", { path: path.join(dir, "notes.txt") })] }];

	await say("CLEAN first", [{ text: "ok" }]);
	// This message reads outside content and is given a folder: both came with it.
	await say("READS outside", [{ tools: [call("mcp__feed__echo", { text: "from outside" }), call("request_access", { path: dir, reason: "the notes" })] }, ...look]);
	assert.ok(h.toolResults().at(-1)!.includes("NOTES-1"), h.toolResults().join("\n"));
	assert.ok(tainted(), "the conversation is marked");
	// What outside content started runs in a conversation of its own and is not the owner's to undo.
	await say("FROM outside", [{ text: "noted" }], "untrusted");

	const r = await h.pine.agents.undo("main", "s");
	assert.ok(r.prompt.startsWith("READS outside"), "the run that outside content started is not what undo takes back");
	assert.equal(h.pine.tasks.list({ agent: "main", session: "s~u" }).length, 1, "and it stays");
	assert.equal(tainted(), undefined, "the mark came with the message and went with it");
	await say("LOOK again", look);
	assert.match(h.toolResults().at(-1)!, /outside the paths this agent may read/, "the access given while the message was worked on is taken back with it");
	assert.equal(h.pine.agents.status().sessions.find((x) => x.session === "s")?.tainted, undefined);
	assert.equal(tainted(), undefined);

	// A mark that was there before the message stays when the message is taken back.
	await say("READS more", [{ tools: [call("mcp__feed__echo", { text: "again" })] }]);
	await say("LATER", [{ text: "ok" }]);
	await h.pine.agents.undo("main", "s");
	assert.ok(tainted(), "still marked: what marked it is still part of the conversation");

	// No tool for it: an agent cannot take anything back, and the API wants the owner's token.
	const req = h.mock.state.requests.at(-1);
	assert.ok(!h.toolsOffered(req).some((n: string) => /undo|redo/.test(n)), h.toolsOffered(req).join(" "));
	assert.equal((await fetch(`http://127.0.0.1:${h.pine.http!.port}/agents/main/undo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
	await h.close();
});

test("undo: work handed to another agent belongs to the message that started it, and a message that changed nothing still leaves the conversation", mac, async (t) => {
	const dir = project(t);
	const h = await harness({ pine: { main: "main" }, agents: { main: { agent: { delegates: ["helper"] } }, helper: {} } });
	await h.pine.agents.setFolder("main", "talk", dir);
	const say = (text: string, steps?: any[]) => h.pine.agents.run({ agent: "main", prompt: steps ? `${text} ${mockMsg(steps)}` : text, session: "talk", trust: "owner" });
	const kinds = () => h.pine.tasks.list({ limit: 100 }).map((x) => x.kind).sort();

	// A message that is only answered: no tool ran, so the folder was never looked at.
	await say("JUST talk");
	assert.equal(fs.existsSync(path.join(h.pine.cfg.dataDir, "snapshots")), false, "nothing is recorded for a message that runs no tool");
	const talk = await h.pine.agents.undo("main", "talk");
	assert.deepEqual([talk.restored?.changed, talk.restored?.removed, talk.restored?.back, talk.note], [0, 0, 0, undefined]);
	assert.deepEqual(said(h, "talk"), []);
	await h.pine.agents.redo("main", "talk");
	assert.deepEqual(said(h, "talk"), ["JUST talk"]);

	// The helper works in the conversation's folder after the message that asked it has been answered; its answer arrives as a message later.
	h.mock.state.scripts.slow = [{ delayMs: 80, tools: [bash("echo by-helper > helped.txt")] }, { text: "HELPER-ANSWER" }];
	await say("HAND it on", [{ tools: [call("delegate", { agent: "helper", task: "@@REF:slow@@", wait: false })] }, { text: "handed on" }]);
	await until(() => h.pine.tasks.list({ agent: "main", session: "talk" }).some((x) => x.kind === "notify" && x.status === "done"), 5000, "the helper's answer");
	assert.equal(read(dir, "helped.txt"), "by-helper\n");
	assert.deepEqual(kinds(), ["delegate", "notify", "prompt", "prompt"]);

	const r = await h.pine.agents.undo("main", "talk");
	assert.ok(r.prompt.startsWith("HAND it on"));
	assert.equal(read(dir, "helped.txt"), undefined, "what the helper made for that message is gone with it");
	assert.deepEqual(kinds(), ["prompt"], "and so are its task and the answer that came back");
	await h.pine.agents.redo("main", "talk");
	assert.equal(read(dir, "helped.txt"), "by-helper\n");
	assert.deepEqual(kinds(), ["delegate", "notify", "prompt", "prompt"]);

	// It follows the conversation when that gets another name, and ends when the conversation is reset.
	await h.pine.agents.undo("main", "talk");
	await h.pine.agents.renameSession("main", "talk", "chat");
	await h.pine.agents.redo("main", "chat");
	assert.equal(read(dir, "helped.txt"), "by-helper\n");
	assert.ok((await h.pine.agents.undo("main", "chat")).prompt.startsWith("HAND it on"));
	await h.pine.agents.resetSession("main", "chat");
	await assert.rejects(h.pine.agents.redo("main", "chat"), /nothing to bring back/);
	await h.close();
});

test("undo: a message that still waits its turn is withdrawn, and what runs before it goes on", mac, async () => {
	const h = await harness({ pine: { http: { port: 0 } }, agents: { main: {} } });
	const client = new Client(`http://127.0.0.1:${h.pine.http!.port}`, h.pine.token);
	const first = await client.prompt("main", `BUSY ${mockMsg([{ delayMs: 400, text: "busy done" }])}`, "main");
	await until(() => h.pine.agents.status().running.length === 1, 3000, "the first message to be worked on");
	await client.prompt("main", "WAITING behind it", "main");
	const r = await client.undo("main", "main");
	assert.deepEqual([r.prompt, r.waiting, r.stopped, r.redo], ["WAITING behind it", true, 0, 0]);
	assert.equal((await h.pine.agents.wait(first.task)).text, "busy done", "the message before it was not stopped");
	assert.deepEqual(said(h, "main"), ["BUSY"]);
	assert.equal(h.mock.state.requests.length, 1, "the withdrawn message never reached the model");
	await h.close();
});

test("snapshots: nothing in the folder or in the owner's git settings makes git run a program or change a byte", mac, async (t) => {
	const dir = project(t);
	const elsewhere = project(t);
	const marker = path.join(elsewhere, "ran");
	// Settings of the owner's own: a filter program, a file system monitor, hooks.
	fs.writeFileSync(path.join(elsewhere, ".gitconfig"), `[filter "x"]\n\tclean = touch ${marker} #\n\tsmudge = touch ${marker} #\n\trequired = true\n[core]\n\tfsmonitor = touch ${marker} #\n\thooksPath = ${elsewhere}\n\tautocrlf = true\n\texcludesFile = ${elsewhere}/ignore\n`);
	fs.writeFileSync(path.join(elsewhere, "ignore"), "notes.txt\n");
	for (const hook of ["post-checkout", "post-index-change", "pre-auto-gc"]) fs.writeFileSync(path.join(elsewhere, hook), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
	// And the folder asks for all of it.
	fs.writeFileSync(path.join(dir, ".gitattributes"), "* filter=x text eol=crlf ident\n");
	fs.writeFileSync(path.join(dir, "crlf.txt"), "one\r\ntwo\n$Id$\n");
	const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pine-snap-")));
	t.after(() => fs.rmSync(store, { recursive: true, force: true }));
	const home = process.env.HOME;
	process.env.HOME = elsewhere;
	try {
		const snaps = new Snapshots(store);
		const before = await snaps.take(dir);
		fs.writeFileSync(path.join(dir, "crlf.txt"), "changed\n");
		fs.writeFileSync(path.join(dir, "notes.txt"), "NOTES-2\n");
		const after = await snaps.take(dir);
		assert.equal((await snaps.changed(dir, before, after)).length, 2);
		await snaps.restore(dir, before, { within: [before, after] });
		assert.equal(read(dir, "crlf.txt"), "one\r\ntwo\n$Id$\n", "byte for byte what it was");
		assert.equal(read(dir, "notes.txt"), "NOTES-1\n");
		// Tidying: a state that is still referred to survives it, and the place of a folder that is gone is removed.
		const places = fs.readdirSync(store);
		const old = new Date(Date.now() - 3 * 86_400_000);
		for (const file of [".", "pine-tidied", "index"]) fs.utimesSync(path.join(store, places[0], file), old, old);
		await snaps.prune(new Map([[dir, new Set([before.tree])]]));
		assert.equal((await snaps.changed(dir, before, before)).length, 0);
		fs.writeFileSync(path.join(dir, "notes.txt"), "NOTES-3\n");
		await snaps.restore(dir, before, { only: ["notes.txt"] });
		assert.equal(read(dir, "notes.txt"), "NOTES-1\n", "the state that was kept can still be gone back to");
		for (const file of [".", "pine-tidied", "index"]) fs.utimesSync(path.join(store, places[0], file), old, old);
		await snaps.prune(new Map());
		assert.deepEqual(fs.readdirSync(store), []);
		// A place that is being made this moment has nothing in it yet and is not taken for an abandoned one.
		fs.mkdirSync(path.join(store, "0".repeat(24)));
		await snaps.prune(new Map());
		assert.deepEqual(fs.readdirSync(store), ["0".repeat(24)]);
	} finally {
		process.env.HOME = home;
	}
	assert.ok(!fs.existsSync(marker), "no filter, monitor or hook was run");
});

test("snapshots: a folder inside a repository follows the ignore rules above it, unless the repository ignores the folder itself", mac, async (t) => {
	const store = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pine-snap-")));
	t.after(() => fs.rmSync(store, { recursive: true, force: true }));
	const snaps = new Snapshots(store);
	const changedIn = async (top: string, rules: string) => {
		const pkg = path.join(top, "packages", "app");
		fs.mkdirSync(path.join(pkg, "node_modules", "dep"), { recursive: true });
		fs.writeFileSync(path.join(top, ".gitignore"), rules);
		fs.writeFileSync(path.join(top, ".git", "info", "exclude"), "*.log\n");
		fs.writeFileSync(path.join(pkg, "index.ts"), "one\n");
		fs.writeFileSync(path.join(pkg, "node_modules", "dep", "index.js"), "dep-1\n");
		fs.writeFileSync(path.join(pkg, "debug.log"), "log-1\n");
		const before = await snaps.take(pkg);
		fs.writeFileSync(path.join(pkg, "index.ts"), "two\n");
		fs.writeFileSync(path.join(pkg, "node_modules", "dep", "index.js"), "dep-2\n");
		fs.writeFileSync(path.join(pkg, "debug.log"), "log-2\n");
		// Beside the folder, in the same repository: not the folder's business.
		fs.writeFileSync(path.join(top, "notes.txt"), "NOTES-2\n");
		const after = await snaps.take(pkg);
		const files = (await snaps.changed(pkg, before, after)).map((f) => f.path).sort();
		await snaps.restore(pkg, before, { within: [before, after] });
		assert.equal(read(pkg, "index.ts"), "one\n");
		assert.equal(read(top, "notes.txt"), "NOTES-2\n");
		return files;
	};
	// Paths are counted from the folder, and what the top of the repository says to leave out is left out.
	assert.deepEqual(await changedIn(project(t, true), "node_modules/\n"), ["index.ts"]);
	// A repository that ignores the folder altogether (a home folder kept in git) has no say in it.
	assert.deepEqual(await changedIn(project(t, true), "*\n"), ["debug.log", "index.ts", "node_modules/dep/index.js"]);
});

test("tui: /undo says what was taken back and puts the message into the input, /redo brings it back, and the code pane shows what the last message changed", mac, async (t) => {
	const dir = project(t, true);
	const h = await harness({ pine: { main: "main", http: { port: 0 } }, agents: { main: {} } });
	const client = new Client(`http://127.0.0.1:${h.pine.http!.port}`, h.pine.token);
	await client.setFolder("main", "main", dir);
	const term = new FakeTerminal(150, 44);
	const app = new PineTui({ client, terminal: term, mode: "test", cwd: dir });
	apps.push(app);
	await app.start();
	const text = () => app.screen().join("\n");
	const sees = (what: string | RegExp, ms = 5000) => until(() => (typeof what === "string" ? text().includes(what) : what.test(text())), ms, `the screen to show ${what}\n--- screen ---\n${text()}`);
	const send = async (line: string) => {
		term.type(line);
		term.type(["\r"]);
		await sleep(15);
	};
	const click = async (needle: string) => {
		await sees(needle);
		const lines = app.screen();
		const y = lines.findIndex((l) => l.includes(needle));
		term.click(lines[y].lastIndexOf(needle) + 1, y);
		await sleep(15);
	};
	const name = path.basename(dir);
	// An answer on a line of its own: the message that asked for it contains the same words.
	const answer = (word: string) => new RegExp(`^ ${word}$`, "m");

	await send(`ONE ${mockMsg([{ tools: [bash("echo made > one.txt")] }, { text: "ANSWER-ONE" }])}`);
	await sees(answer("ANSWER-ONE"));
	// The end of the message is text that only the input can show: the line about what was taken back quotes just its beginning.
	await send(`TWO ${mockMsg([{ tools: [bash("echo NOTES-2 > notes.txt; echo new > fresh.txt; rm src/app.ts")] }, { text: "ANSWER-TWO" }])} TAIL-OF-TWO`);
	await sees(answer("ANSWER-TWO"));

	// The pane: what the last message changed, as a list and as a diff, whatever the last commit was.
	await send("/code turn");
	await sees("by your last message");
	await sees(/\+ fresh\.txt\s+\+1/);
	await sees(/M notes\.txt\s+\+1 −1/);
	await sees(/D src\/app\.ts\s+−1/);
	await sees("3 changed by your last message");
	assert.ok(!/\+ one\.txt/.test(text()), "what an earlier message made is not this one's");
	await click("M notes.txt");
	await sees("+NOTES-2");
	assert.ok(text().includes("-NOTES-1") && text().includes("‹ back · notes.txt"));
	await click("‹ back");
	await click("▸ since the last commit");
	await sees(/\+ one\.txt/);
	await send("/code off");

	// /undo: said plainly, files restored, the message back in the input.
	await send("/undo");
	await sees("↶ taken back: “TWO");
	await sees(`3 files restored in ~/${name}`);
	await sees("1 changed back, 1 removed, 1 brought back");
	await sees("not taken back: what commands did outside this folder");
	await sees("/redo brings it back, until you send a new message");
	await sees("TAIL-OF-TWO");
	assert.ok(!answer("ANSWER-TWO").test(text()) && answer("ANSWER-ONE").test(text()), "the conversation shows what is left of it");
	assert.equal(read(dir, "notes.txt"), "NOTES-1\n");
	assert.equal(read(dir, "fresh.txt"), undefined);
	assert.equal(read(dir, "src/app.ts"), "export const answer = 41;\n");
	assert.equal(read(dir, "one.txt"), "made\n");

	// /redo: the input is emptied first (ctrl+c), then everything is as the message left it.
	term.type(["\x03"]);
	await send("/redo");
	await sees("↷ brought back: “TWO");
	await sees(`3 files in ~/${name} are again as the message left them`);
	await sees(answer("ANSWER-TWO"));
	assert.equal(read(dir, "notes.txt"), "NOTES-2\n");
	assert.equal(read(dir, "src/app.ts"), undefined);
	await send("/redo");
	await sees("there is nothing to bring back");

	// /undo twice goes one message further each time; the message that returns to the input is the earlier one.
	await send("/undo");
	await sees("/undo again takes back the message before it");
	term.type(["\x03"]);
	await send("/undo");
	await sees("↶ taken back: “ONE");
	await sees(`1 file restored in ~/${name}`);
	assert.equal(read(dir, "one.txt"), undefined);
	assert.ok(!answer("ANSWER-ONE").test(text()));
	// Sent again from the input, changed or not, it is a new message, and the undo is final.
	term.type(["\r"]);
	await sees(answer("ANSWER-ONE"));
	assert.equal(read(dir, "one.txt"), "made\n");
	await send("/redo");
	await sees("there is nothing to bring back");
	await send("/undo");
	await until(() => read(dir, "one.txt") === undefined && !answer("ANSWER-ONE").test(text()), 5000, "the second message to be taken back");
	term.type(["\x03"]);
	await send("/undo");
	await sees("there is no message of yours in this conversation to take back");
	await app.stop();
	await h.close();
});
