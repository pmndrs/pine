import assert from "node:assert/strict";
import { after, test } from "node:test";
import { elapsed } from "../src/programs.ts";
import { sandboxAvailable } from "../src/security.ts";
import { PineTui } from "../src/tui/app.ts";
import { Client } from "../src/tui/client.ts";
import { programName, since } from "../src/util.ts";
import { harness, mockMsg, notesOf, sleep, until } from "./support/harness.ts";
import { FakeTerminal } from "./support/terminal.ts";

const owner = { trust: "owner" as const };
const mac = { skip: !sandboxAvailable() };
const call = (name: string, args: any) => ({ name, args });
/** A program that stays: the way an agent starts a development server and returns. */
const leave = (seconds: number) => `nohup sleep ${seconds} >/dev/null 2>&1 &`;

const apps: PineTui[] = [];
after(async () => {
	for (const app of apps) await app.stop().catch(() => {});
});

test("programs: how one is named and how long it has run", () => {
	assert.deepEqual(["00:07", "12:30", "01:02:03", "2-00:00:01"].map(elapsed), [7, 750, 3723, 172801]);
	assert.equal(programName("node /Users/x/project/node_modules/.bin/vite --port 5173 --host"), "vite --port 5173 --host");
	assert.equal(programName("/usr/bin/python3 -m http.server 8000"), "python3 -m http.server 8000");
	assert.equal(programName("sleep 60"), "sleep 60");
	assert.equal(programName(`node ${"a".repeat(100)}`, 20).length, 20);
	assert.deepEqual([5, 61, 3600, 7800].map(since), ["5 s", "1 min", "1 h", "2 h 10 min"]);
});

test("programs: what a command leaves running is listed for its conversation, the agent is told, and the owner or the agent stops it", mac, async (t) => {
	// The agent as pine ships it: with the owner's account, so that a server of its own can listen.
	const h = await harness({ pine: { defaults: { mode: undefined }, http: { port: 0 } }, agents: { main: {} } });
	const list = (session = "main") => h.pine.agents.programsOf("main", session);
	t.after(() => {
		for (const session of ["main", "other"]) for (const p of list(session)) h.pine.agents.stopProgram("main", session, p.id);
	});
	const run = (steps: any[], session?: string) => h.pine.agents.run({ agent: "main", prompt: mockMsg(steps), ...(session ? { session } : {}), ...owner });
	const server = `nohup ${process.execPath} -e "require('http').createServer().listen(0, '127.0.0.1')" >/dev/null 2>&1 &`;

	// A command that ends leaves nothing; one that puts a program into the background leaves that.
	await run([{ tools: [call("bash", { command: "echo done" })] }]);
	assert.deepEqual(list(), []);
	await run([{ tools: [call("bash", { command: server })] }, { tools: [call("bash", { command: leave(301) })] }]);
	await until(() => list().length === 2 && list().some((p) => p.ports.length === 1), 5000, "both programs, one of them listening");
	const [web, sleeper] = [list().find((p) => p.ports.length)!, list().find((p) => !p.ports.length)!];
	assert.ok(web.command.includes("createServer") && web.ports[0] > 0 && web.processes === 1, JSON.stringify(web));
	assert.ok(sleeper.command.includes("sleep 301"), JSON.stringify(sleeper));
	assert.deepEqual(list("other"), [], "another conversation has none of it");

	// The agent knows without looking, and has a tool for it.
	await run([{ tools: [call("stop_program", {})] }, { tools: [call("stop_program", { id: sleeper.id }), call("stop_program", { id: 1 })] }]);
	const note = notesOf(h.mock.state.requests.at(-1)).join("\n");
	assert.ok(note.includes("Programs your commands left running") && note.includes("sleep 301") && note.includes(`port ${web.ports[0]}`) && note.includes(`(id ${sleeper.id})`), note);
	const out = h.toolResults().slice(-3);
	assert.ok(out[0].includes(`id ${web.id}`) && out[0].includes("sleep 301"), out[0]);
	assert.match(out[1], new RegExp(`Stopped the program ${sleeper.id}`));
	assert.match(out[2], /there is no running program with the id 1/);
	await until(() => list().length === 1, 5000, "the stopped one to be gone");

	// The owner's side: the control API lists and stops, and only what belongs to that conversation.
	const base = `http://127.0.0.1:${h.pine.http!.port}`;
	const headers = { authorization: `Bearer ${h.pine.token}`, "content-type": "application/json" };
	const got = (await (await fetch(`${base}/agents/main/programs?session=main`, { headers })).json()) as any[];
	assert.deepEqual(got.map((p) => p.id), [web.id]);
	assert.equal((await fetch(`${base}/agents/main/programs?session=main`)).status, 401);
	const stop = async (session: string, id: number) => ((await (await fetch(`${base}/agents/main/programs/stop`, { method: "POST", headers, body: JSON.stringify({ session, id }) })).json()) as any).stopped;
	assert.equal(await stop("other", web.id), false, "not through another conversation");
	assert.equal(await stop("main", process.pid), false, "and nothing that no command of the conversation started");
	assert.equal(await stop("main", web.id), true);
	await until(() => list().length === 0, 5000, "the server to be gone");

	// Resetting a conversation stops what it left running.
	await run([{ tools: [call("bash", { command: leave(302) })] }], "other");
	await until(() => list("other").length === 1);
	await h.pine.agents.resetSession("main", "other");
	await until(() => list("other").length === 0, 5000, "the program of the reset conversation to be gone");
	await h.close();
});

test("tui: the code pane lists what the agent left running and stops it on a click", mac, async (t) => {
	// With the owner's account, as pine ships the main agent. (In the workspace sandbox Linux ends
	// what a command leaves behind together with the command; see security.md, "On Linux".)
	const h = await harness({ pine: { main: "main", defaults: { mode: undefined }, http: { port: 0 } }, agents: { main: {} } });
	t.after(() => {
		for (const p of h.pine.agents.programsOf("main", "main")) h.pine.agents.stopProgram("main", "main", p.id);
	});
	const term = new FakeTerminal(130, 36);
	const client = new Client(`http://127.0.0.1:${h.pine.http!.port}`, h.pine.token);
	const app = new PineTui({ client, terminal: term, mode: "test" });
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

	await send("/code running");
	await sees(/Changes\s+Files\s+Output\s+Running/);
	await sees("Nothing is running.");
	await send(mockMsg([{ tools: [call("bash", { command: leave(303) })] }, { text: "started" }]));
	await sees("started");
	// It follows what the agent does, like the other views.
	await sees("● sleep 303");
	await sees(/running for \d+ s/);
	await sees("1 running");
	await click("■ stop");
	await sees("Nothing is running.");
	assert.deepEqual(await client.programs("main", "main"), []);
	await h.close();
});
