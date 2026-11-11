import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { loadConfig } from "../src/config.ts";
import os from "node:os";
import { addServer, listServers, piMcp, removeServer, serverStates, splitCommand } from "../src/mcp-config.ts";
import { sandboxAvailable } from "../src/security.ts";
import { harness, mockMsg } from "./support/harness.ts";
import { httpMcp } from "./support/http-mcp.ts";

const run = promisify(execFile);
const CLI = path.resolve(import.meta.dirname, "../src/cli.ts");
const owner = { trust: "owner" as const };
const call = (name: string, args: any) => ({ name, args });
const mcpTools = (h: any, req: any) => h.toolsOffered(req).filter((t: string) => t.startsWith("mcp__"));

test("mcp servers can be added and removed in the files without losing what else is there", async () => {
	const h = await harness({
		pine: { mcp: { keep: { command: "x", env: { KEY: "${PINE_TEST_KEEP:-fallback}" } } }, routes: [{ on: "a/b", publish: { topic: "c/d" } }] },
		agents: { main: {}, gonzo: { agent: { description: "law" } } },
		start: false,
	});
	const cfg = loadConfig(h.home);
	addServer(cfg, "docs", { url: "https://mcp.example.com/mcp", taints: true });
	addServer(cfg, "own", { command: "/bin/echo", args: ["hi"] }, "gonzo");
	const raw = JSON.parse(fs.readFileSync(path.join(h.home, "pine.json"), "utf8"));
	assert.deepEqual(raw.mcp.docs, { url: "https://mcp.example.com/mcp", taints: true });
	assert.equal(raw.mcp.keep.env.KEY, "${PINE_TEST_KEEP:-fallback}", "placeholders are kept as written");
	assert.equal(raw.routes.length, 1);
	assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, "agents", "gonzo", "agent.json"), "utf8")).mcp.own.command, "/bin/echo");

	const fresh = listServers(loadConfig(h.home));
	assert.deepEqual(fresh.map((s) => [s.name, s.scope, s.agents.join("+")]), [["keep", "global", "gonzo+main"], ["docs", "global", "gonzo+main"], ["own", "gonzo", "gonzo"]]);
	assert.equal(fresh.find((s) => s.name === "docs")!.taints, true);

	for (const [name, server, why] of [["bad name", { url: "https://x.example/mcp" }, /usable server name/], ["plain", { url: "http://example.com/mcp" }, /must use https/], ["nothing", {}, /needs a url/], ["junk", { url: "not a url" }, /not a valid URL/]] as const) assert.throws(() => addServer(cfg, name, server as any), why);
	assert.throws(() => addServer(cfg, "x", { url: "https://x.example/mcp" }, "nobody"), /unknown agent/);

	assert.equal(removeServer(cfg, "docs"), true);
	assert.equal(removeServer(cfg, "docs"), false);
	assert.deepEqual(Object.keys(loadConfig(h.home).mcp), ["keep"]);
	await h.close();
});

test("an agent proposes a remote server, the owner confirms, and it works without a restart", async (t) => {
	const stub = await httpMcp();
	t.after(() => stub.close());
	const h = await harness({ pine: { main: "main", routes: [{ on: "hook/in", agent: "main" }] }, agents: { main: { agent: { mode: "bypass" } }, gonzo: {} } });
	const asked: any[] = [];
	let allow = false;
	h.pine.bus.subscribe("approval/requested", (e) => {
		asked.push(e.payload);
		h.pine.approvals.decide((e.payload as any).id, allow, "test");
	});
	const propose = mockMsg([{ tools: [call("add_mcp_server", { name: "notes", url: stub.url, description: "the owner's notes", scope: "global" })] }]);

	// Refused: nothing changes, and the agent is told how the owner can do it.
	const no = await h.pine.agents.run({ agent: "main", prompt: propose, ...owner });
	assert.match(no.text, /not added \(test\).*pine mcp add notes/);
	assert.equal(asked.length, 1, "asked even in bypass mode: this changes pine itself");
	assert.ok(asked[0].summary.includes(`add MCP server "notes" for ALL agents`) && asked[0].summary.includes(stub.url));
	assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, "pine.json"), "utf8")).mcp, undefined);

	// Confirmed: written to pine.json and usable from the next message. The owner's yes makes it their
	// server: it does not mark the conversation as having read outside content.
	allow = true;
	const yes = await h.pine.agents.run({ agent: "main", prompt: propose, ...owner });
	assert.match(yes.text, /Your owner confirmed it\. Added "notes" for all agents.*names start with mcp__notes__.*\/mcp login notes/);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.home, "pine.json"), "utf8")).mcp.notes, { url: stub.url, description: "the owner's notes", approve: "tainted" });
	const used = await h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: [call("mcp__notes__lookup", { q: "grundbuch" })] }]), ...owner });
	assert.equal(used.text, "FINAL:: looked up: grundbuch");
	assert.equal(h.pine.agents.status().sessions.find((s) => s.session === "main")?.tainted, undefined);
	assert.equal(asked.length, 2, "and using it asks nothing");
	assert.equal(h.mock.state.requests.at(-1).body.messages.filter((m: any) => m.role === "user").length, 3, "the conversation went on; only its tools changed");
	await h.pine.agents.run({ agent: "gonzo", prompt: "hi", ...owner });
	assert.deepEqual(mcpTools(h, h.requestsFor("PERSONA-GONZO")[0]), ["mcp__notes__lookup"], "everyone means the other agents too");

	// Guard rails: no duplicates, https only, and never from a run that an outside event started.
	const again = await h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: [call("add_mcp_server", { name: "notes", url: stub.url }), call("add_mcp_server", { name: "plain", url: "http://evil.example/mcp" })] }]), ...owner });
	assert.match(again.text, /exists already/);
	assert.match(again.text, /must use https/);
	assert.equal(asked.length, 2, "invalid proposals do not reach the owner");
	h.pine.bus.publish("hook/in", { text: mockMsg([{ tools: [call("add_mcp_server", { name: "evil", url: "https://evil.example/mcp", scope: "global" })] }]) }, { source: "http" });
	await h.pine.bus.waitFor("agent/main/done", (e) => (e.payload as any).session === "main~u");
	assert.equal(h.toolResults().at(-1), "Tool add_mcp_server not found");
	assert.equal(asked.length, 2);
	await h.close();
});

test("pine mcp: add, list and remove from the shell, applied to a running daemon at once", async (t) => {
	const stub = await httpMcp();
	const locked = await httpMcp({ token: "secret" });
	t.after(() => Promise.all([stub.close(), locked.close()]));
	const h = await harness({ pine: { http: { port: 0 } }, agents: { main: {}, gonzo: {} }, start: false });
	const pine = async (...args: string[]) => (await run(process.execPath, [CLI, "mcp", "--home", h.home, ...args])).stdout.trim();

	// No daemon: the files are edited.
	assert.match(await pine("add", "open", stub.url, "--taints", "--approve", "tainted", "--timeout", "180"), /Added "open" for all agents/);
	assert.match(await pine("add", "locked", locked.url, "--agent", "gonzo"), /Added "locked" for agent gonzo/);
	assert.match(await pine("add", "local", "--", "/bin/echo", "--flag", "x"), /Added "local"/);
	const cfg = loadConfig(h.home);
	assert.deepEqual(cfg.mcp.local, { command: "/bin/echo", args: ["--flag", "x"] });
	assert.deepEqual(cfg.mcp.open, { url: stub.url, taints: true, timeout: 180, approve: "tainted" });
	assert.match(await pine("list", "--offline"), /open\s+\?\s+all: gonzo, main\n\s+http:\/\/127.*\[outside content\]\s+\[approval: tainted\]/);

	// What pi reports for each server; the helper file it needs is gone afterwards.
	assert.equal(removeServer(cfg, "local"), true);
	const states = await serverStates(cfg);
	assert.match(states.open, /connected/);
	assert.match(states.locked, /needs sign-in|unauthorized|401|failed/i);
	assert.ok(!fs.existsSync(path.join(h.home, "data", "pi", "mcp.json")));
	assert.equal((await piMcp(cfg, { open: cfg.mcp.open }, ["list"], { capture: true })).code, 0);

	// A file left in pi's folder, by a crash or by anyone, does not give agents a server.
	fs.mkdirSync(path.join(h.home, "data", "pi"), { recursive: true });
	fs.writeFileSync(path.join(h.home, "data", "pi", "mcp.json"), JSON.stringify({ mcpServers: { planted: { url: stub.url, exposure: "direct" } } }));
	await h.restart();
	await h.pine.agents.run({ agent: "main", prompt: "hi", ...owner });
	assert.deepEqual(mcpTools(h, h.mock.state.requests.at(-1)), ["mcp__open__lookup"]);

	// With a daemon running the change applies at once, to live sessions too.
	const port = h.pine.http!.port;
	const raw = JSON.parse(fs.readFileSync(path.join(h.home, "pine.json"), "utf8"));
	fs.writeFileSync(path.join(h.home, "pine.json"), JSON.stringify({ ...raw, http: { port } }));
	fs.rmSync(path.join(h.home, "data", "pi", "mcp.json"));
	assert.match(await pine("add", "second", stub.url), /Added "second"/);
	await h.pine.agents.run({ agent: "main", prompt: "again", ...owner });
	assert.deepEqual(mcpTools(h, h.mock.state.requests.at(-1)).sort(), ["mcp__open__lookup", "mcp__second__lookup"]);
	assert.match(await pine("remove", "second"), /Removed "second"/);
	await h.pine.agents.run({ agent: "main", prompt: "and again", ...owner });
	assert.deepEqual(mcpTools(h, h.mock.state.requests.at(-1)), ["mcp__open__lookup"]);
	await assert.rejects(() => pine("login", "nope"), /no server "nope"/);
	await h.close();
});

test("a server's timeout sets how long one of its calls may take", async (t) => {
	const stub = await httpMcp({ delayMs: 500 });
	t.after(() => stub.close());
	const h = await harness({ agents: { main: { agent: { mcp: { hasty: { url: stub.url, timeout: 0.15 }, patient: { url: stub.url, timeout: 5 } } } } } });
	const r = await h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: [call("mcp__hasty__lookup", { q: "a" }), call("mcp__patient__lookup", { q: "b" })] }]), ...owner });
	const out = h.toolResults();
	assert.match(out[0], /timed out after 150ms/);
	assert.equal(out[1], "looked up: b");
	assert.equal(r.status, "done");
	await h.close();
});

test("setup by tool call: for the conversation by default, for the agent when asked, for everyone only by the main agent; and it is taken away again", async (t) => {
	const stub = await httpMcp();
	t.after(() => stub.close());
	const project = fs.mkdtempSync(path.join(fs.realpathSync(process.env.HOME!), ".pine-test-setup-"));
	t.after(() => fs.rmSync(project, { recursive: true, force: true }));
	const h = await harness({ pine: { main: "main" }, agents: { main: {}, gonzo: {} } });
	const asked: any[] = [];
	h.pine.bus.subscribe("approval/requested", (e) => {
		asked.push(e.payload);
		h.pine.approvals.decide((e.payload as any).id, true, "test");
	});
	const run = (agent: string, session: string, steps: any[]) => h.pine.agents.run({ agent, prompt: mockMsg(steps), session, ...owner });
	const file = (agent = "main") => JSON.parse(fs.readFileSync(path.join(h.home, "agents", agent, "agent.json"), "utf8"));
	const pristine = file();
	const offered = (agent: string, session: string) => run(agent, session, [{ text: "ok" }]).then(() => h.toolsOffered(h.mock.state.requests.at(-1)));

	// A server asked for in a side conversation is that conversation's: nothing else gets its tools.
	let r = await run("main", "side", [{ tools: [call("add_mcp_server", { name: "notes", url: stub.url })] }]);
	assert.match(r.text, /Added "notes" for this conversation; it is removed when this conversation is removed\./);
	assert.match(asked[0].summary, /^add MCP server "notes" for this conversation of main only\n/);
	assert.deepEqual(file().mcp.notes, { url: stub.url, approve: "tainted", session: "side" });
	assert.ok((await offered("main", "side")).includes("mcp__notes__lookup"));
	assert.ok(!(await offered("main", "main")).some((x: string) => x.startsWith("mcp__notes")), "the main conversation does not get a side conversation's server");
	assert.ok(!(await offered("main", "other")).some((x: string) => x.startsWith("mcp__notes")));

	// Its own conversation removes it without a question; another conversation is told whose it is.
	r = await run("main", "other", [{ tools: [call("remove_mcp_server", { name: "notes" })] }]);
	assert.match(r.text, /"notes" belongs to your conversation "side"/);
	r = await run("main", "side", [{ tools: [call("remove_mcp_server", { name: "notes" })] }]);
	assert.match(r.text, /Removed the MCP server "notes"\./);
	assert.equal(asked.length, 1, "removing its own server asks nobody");
	assert.deepEqual(file(), pristine, "removed, and no empty entry left");

	// The same for an event source: made in a conversation, seen only there, gone with the conversation, and nothing is left in the file.
	r = await run("main", "side", [{ tools: [call("add_mcp_server", { name: "notes", url: stub.url }), call("add_source", { name: "proj", type: "folder", options: { dir: project }, description: "the project", note: "say what changed" })] }]);
	assert.match(r.text, /Added the event source "proj" \(folder\)\. It is this conversation's own: it is removed when this conversation is removed\. Subscribed to proj \(local\)/);
	assert.deepEqual([file().sources.proj.session, file().subscribe, file().sandbox.read], ["side", [{ source: "proj", note: "say what changed", session: "side" }], [project]]);
	r = await run("main", "other", [{ tools: [call("sources", {}), call("subscribe", { source: "proj" })] }]);
	assert.match(h.toolResults().at(-2)!, /No event sources exist yet/);
	assert.match(h.toolResults().at(-1)!, /"proj" is not an event source main can use|set up for the conversation "side"/);
	assert.deepEqual(await h.pine.agents.removeSession("main", "side"), { removed: true, unsubscribed: ["proj"], sources: ["proj"], servers: ["notes"] });
	assert.deepEqual(file(), pristine, "the conversation left nothing behind in the agent's file: no empty lists, no access that came with the folder");

	// For the agent as such, said in the main conversation; a side conversation that removes it asks the owner.
	r = await run("main", "main", [{ tools: [call("add_mcp_server", { name: "notes", url: stub.url }), call("add_source", { name: "proj", type: "folder", options: { dir: project }, description: "the project" })] }]);
	assert.match(r.text, /Added "notes" for you, in all your conversations/);
	assert.equal(file().mcp.notes.session, undefined);
	assert.ok((await offered("main", "third")).includes("mcp__notes__lookup"));
	const before = asked.length;
	r = await run("main", "third", [{ tools: [call("remove_source", { name: "proj" }), call("remove_mcp_server", { name: "notes" })] }]);
	assert.match(r.text, /Removed the MCP server "notes"/);
	assert.deepEqual(asked.slice(before).map((a) => a.summary.split("\n")[0]), ['remove the event source "proj" of agent main', 'remove the MCP server "notes" of agent main']);
	assert.deepEqual(file(), pristine, "and again the file is as it was, the read access that came with the folder included");

	// What is for all agents is the main agent's. Another agent is not offered it, is refused, and knows whom to send its owner to.
	r = await run("gonzo", "main", [{ tools: [call("add_mcp_server", { name: "shared", url: stub.url, scope: "global" })] }]);
	assert.match(r.text, /Only the main agent \(main\) can add MCP servers for all agents\. Tell your owner/);
	const gonzo = h.mock.state.requests.at(-1);
	assert.ok(!h.toolsOffered(gonzo).includes("create_agent") && h.toolsOffered(gonzo).includes("add_mcp_server"));
	assert.ok(h.system(gonzo).includes("Creating agents, and anything that is for all agents, is the main agent's job (its id is main): you have no tools for it."));
	r = await run("main", "main", [{ tools: [call("add_mcp_server", { name: "shared", url: stub.url, scope: "global" })] }]);
	assert.match(r.text, /Added "shared" for all agents/);
	assert.ok((await offered("gonzo", "main")).includes("mcp__shared__lookup"));
	r = await run("gonzo", "main", [{ tools: [call("remove_mcp_server", { name: "shared" })] }]);
	assert.match(r.text, /Only the main agent \(main\) can remove an MCP server for all agents/);
	r = await run("main", "main", [{ tools: [call("remove_mcp_server", { name: "shared" })] }]);
	assert.match(r.text, /Removed the MCP server "shared"/);
	assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, "pine.json"), "utf8")).mcp?.shared, undefined);
	await h.close();
});

test("the main agent creates an agent by tool call: the owner confirms, it exists at once, and its file holds only what was asked", async () => {
	const h = await harness({ pine: { main: "main" }, agents: { main: {} } });
	const asked: any[] = [];
	let allow = false;
	h.pine.bus.subscribe("approval/requested", (e) => {
		asked.push(e.payload);
		h.pine.approvals.decide((e.payload as any).id, allow, "test");
	});
	const run = (agent: string, steps: any[]) => h.pine.agents.run({ agent, prompt: mockMsg(steps), ...owner });
	const dir = path.join(h.home, "agents", "research");
	const make = call("create_agent", { id: "research", description: "Looks things up and reports with sources", instructions: "You are RESEARCH-PERSONA. You look things up and report what you found, with where you found it.", tools: "read, grep, find, ls" });

	// Not without the owner.
	let r = await run("main", [{ tools: [make] }]);
	assert.match(r.text, /not created \(test\)/);
	assert.match(asked[0].summary, /^create the agent "research": Looks things up and reports with sources\nModel: .* \(the default\) · tools: read, grep, find, ls\nInstructions:\nYou are RESEARCH-PERSONA\./);
	assert.ok(!fs.existsSync(dir) && !h.pine.cfg.agents.research);

	// What cannot work is said before anyone is asked, and leaves nothing behind.
	r = await run("main", [{ tools: [call("create_agent", { id: "Bad Name", description: "x", instructions: "y" }), call("create_agent", { id: "ops", description: "x", instructions: "y", tools: "read, teleport" }), call("create_agent", { id: "main", description: "x", instructions: "y" })] }]);
	allow = true;
	assert.match(h.toolResults().at(-3)!, /not a usable agent id/);
	assert.match(h.toolResults().at(-2)!, /unknown tool teleport\. An agent can have: read, bash, edit, write, grep, find, ls/);
	assert.match(h.toolResults().at(-1)!, /an agent called main exists already/);
	assert.equal(asked.length, 1, "what cannot work is not put to the owner");
	assert.deepEqual(fs.readdirSync(path.join(h.home, "agents")).sort(), ["main"]);

	// Confirmed: the folder, its files, and an agent that answers and that main can hand work to.
	r = await run("main", [{ tools: [make] }]);
	assert.match(r.text, /The agent research exists now.*\/agent research.*delegate from your next message on/);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "agent.json"), "utf8")), { description: "Looks things up and reports with sources", tools: ["read", "grep", "find", "ls"] });
	// Its instructions are in its workspace, where it can change them, with the stubs of the files it keeps itself.
	assert.match(fs.readFileSync(path.join(dir, "workspace", "AGENTS.md"), "utf8"), /^You are RESEARCH-PERSONA\./);
	assert.deepEqual(fs.readdirSync(path.join(dir, "workspace")).sort(), ["AGENTS.md", "MEMORY.md", "SOUL.md"]);
	assert.deepEqual(fs.readdirSync(dir).sort(), ["agent.json", "workspace"]);
	const answer = await run("research", [{ text: "here" }]);
	assert.equal(answer.text, "here");
	const research = h.requestsFor("RESEARCH-PERSONA")[0];
	assert.deepEqual(h.toolsOffered(research).filter((x: string) => ["read", "bash", "edit", "write", "grep", "find", "ls"].includes(x)).sort(), ["find", "grep", "ls", "read"]);
	assert.ok(!h.toolsOffered(research).includes("create_agent") && h.system(research).includes("is the main agent's job (its id is main)"));
	h.mock.state.scripts.found = [{ text: "FOUND-IT" }];
	r = await run("main", [{ tools: [call("delegate", { agent: "research", task: "look it up @@REF:found@@" })] }]);
	assert.match(r.text, /\[research\] FOUND-IT/);

	// It is there after a restart, like any agent.
	await h.restart();
	assert.equal((h.pine.cfg.agents as any).research.description, "Looks things up and reports with sources");
	await h.close();
});

/** A local MCP server in one file: `peek` reads a file, `home` says where its home is. Both show what the process may reach. */
const LOCAL_SERVER = `import fs from "node:fs";
import readline from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	if (msg.id === undefined) return;
	const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
	if (msg.method === "initialize") return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "local", version: "1" } });
	if (msg.method === "ping") return reply({});
	const tool = (name) => ({ name, description: name, inputSchema: { type: "object", properties: { path: { type: "string" } } }, annotations: { readOnlyHint: true } });
	if (msg.method === "tools/list") return reply({ tools: [tool("peek"), tool("home")] });
	if (msg.method === "tools/call") {
		let text;
		try { text = msg.params.name === "home" ? "HOME=" + process.env.HOME + " TOKEN=" + process.env.PINE_TEST_LOCAL_TOKEN : fs.readFileSync(msg.params.arguments.path, "utf8"); } catch (e) { text = "FAILED " + e.code; }
		return reply({ content: [{ type: "text", text }] });
	}
	send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
});
`;

test("a command line is a program and its arguments; what only a shell understands is refused", () => {
	assert.deepEqual(splitCommand("npx -y @classcad/mcp@latest"), ["npx", "-y", "@classcad/mcp@latest"]);
	assert.deepEqual(splitCommand(`  node  "my server.js" --name 'a b' --empty "" `), ["node", "my server.js", "--name", "a b", "--empty", ""]);
	assert.deepEqual(splitCommand(""), []);
	for (const line of ["npx x && rm -rf ~", "npx x | tee log", "npx x; id", "npx $(id)", "npx `id`", "npx x > out"]) assert.throws(() => splitCommand(line), /no shell runs this/, line);
	assert.throws(() => splitCommand('node "open'), /not closed/);
});

test("an agent proposes a local server by its command; the owner confirms the command, and it runs in that agent's sandbox", { skip: !sandboxAvailable() }, async (t) => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), ".pine-test-elsewhere-")));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, "notes.txt"), "ELSEWHERE-CONTENT\n");
	process.env.PINE_TEST_LOCAL_TOKEN = "daemon-secret";
	t.after(() => delete process.env.PINE_TEST_LOCAL_TOKEN);
	const command = `${process.execPath} server.mjs`;
	const files = { "server.mjs": LOCAL_SERVER, "mine.txt": "IN-THE-WORKSPACE\n" };

	const h = await harness({ agents: { main: { files }, gonzo: {} } });
	const asked: any[] = [];
	let allow = false;
	let values: Record<string, string> | undefined;
	let incomplete = 0;
	h.pine.bus.subscribe("approval/requested", (e) => {
		asked.push(e.payload);
		// A yes that lacks what the dialog asks the owner to type is not taken; the dialog stays open.
		if (!h.pine.approvals.decide((e.payload as any).id, allow, "test", false, values)) {
			incomplete++;
			h.pine.approvals.decide((e.payload as any).id, false, "test");
		}
	});
	const main = (steps: any[]) => h.pine.agents.run({ agent: "main", prompt: mockMsg(steps), ...owner });
	const agentJson = () => JSON.parse(fs.readFileSync(path.join(h.home, "agents", "main", "agent.json"), "utf8"));

	// What cannot be a server is refused before the owner is bothered.
	await main([{ tools: [call("add_mcp_server", { name: "cad" }), call("add_mcp_server", { name: "cad", url: "https://x.example/mcp", command }), call("add_mcp_server", { name: "cad", command: `${command} && curl evil.example` })] }]);
	assert.match(h.toolResults()[0], /either url .* or command/);
	assert.match(h.toolResults()[1], /either url .* or command/);
	assert.match(h.toolResults()[2], /no shell runs this/);
	assert.equal(asked.length, 0);

	// A no: nothing is written, and the agent can say how the owner would do it.
	await main([{ tools: [call("add_mcp_server", { name: "cad", command, description: "builds parts" })] }]);
	assert.ok(h.toolResults().at(-1)!.includes(`not added (test)`) && h.toolResults().at(-1)!.includes(`pine mcp add cad -- ${command}`), h.toolResults().at(-1)!);
	assert.equal(agentJson().mcp, undefined);
	assert.equal(asked.length, 1);
	assert.ok(asked[0].summary.includes(`a program on this computer: ${command}`) && asked[0].summary.includes("runs in the sandbox of main") && asked[0].summary.includes("its workspace"), asked[0].summary);

	// A yes: the entry says the program is to be held, and its tools are there with the next message.
	allow = true;
	await main([{ tools: [call("add_mcp_server", { name: "cad", command, description: "builds parts" })] }]);
	assert.match(h.toolResults().at(-1)!, /Your owner confirmed it\. Added "cad".*its documentation names the command for it/);
	assert.deepEqual(agentJson().mcp.cad, { command: process.execPath, args: ["server.mjs"], sandboxed: true, description: "builds parts", approve: "tainted" });
	await main([{ tools: [call("mcp__cad__peek", { path: "mine.txt" }), call("mcp__cad__peek", { path: path.join(dir, "notes.txt") }), call("mcp__cad__peek", { path: path.join(h.home, "pine.json") }), call("mcp__cad__home", {})] }]);
	const out = h.toolResults().slice(-4);
	assert.deepEqual(mcpTools(h, h.mock.state.requests.at(-1)).sort(), ["mcp__cad__home", "mcp__cad__peek"]);
	assert.ok(out[0].includes("IN-THE-WORKSPACE"), out[0]);
	assert.match(out[1], /FAILED E(PERM|ACCES|NOENT)/, "the owner's files are as closed to it as to the agent's shell");
	assert.match(out[2], /FAILED E(PERM|ACCES|NOENT)/, "and so is pine's own configuration");
	assert.ok(out[3].includes(`HOME=${path.join(h.home, "sandbox", "main")}`) && out[3].includes("TOKEN=undefined"), `the agent's home, and nothing of the daemon's environment: ${out[3]}`);

	// A key the server needs is typed by the owner into the dialog: the model names it and never sees it.
	await main([{ tools: [call("add_mcp_server", { name: "keyed", url: "https://x.example/mcp", secrets: ["PINE_TEST_LOCAL_TOKEN"] }), call("add_mcp_server", { name: "keyed", command, secrets: ["sk-live 123"] })] }]);
	assert.match(h.toolResults().at(-2)!, /secrets are for a local server/);
	assert.match(h.toolResults().at(-1)!, /not the name of an environment variable.*never the key itself/);
	// A yes without the key is not a yes.
	await main([{ tools: [call("add_mcp_server", { name: "keyed", command, secrets: ["PINE_TEST_LOCAL_TOKEN"] })] }]);
	assert.equal(agentJson().mcp.keyed, undefined);
	assert.equal(incomplete, 1);
	values = { PINE_TEST_LOCAL_TOKEN: "typed-by-the-owner" };
	await main([{ tools: [call("add_mcp_server", { name: "keyed", command, secrets: ["PINE_TEST_LOCAL_TOKEN"] })] }]);
	values = undefined;
	assert.deepEqual(asked.at(-1).inputs, [{ name: "PINE_TEST_LOCAL_TOKEN", label: "PINE_TEST_LOCAL_TOKEN (the server reads it from its environment)", secret: true }]);
	assert.ok(asked.at(-1).summary.includes("It needs PINE_TEST_LOCAL_TOKEN, which you type here"), asked.at(-1).summary);
	assert.deepEqual(agentJson().mcp.keyed.env, { PINE_TEST_LOCAL_TOKEN: "${PINE_MCP_KEYED_MAIN_PINE_TEST_LOCAL_TOKEN}" }, "the entry has the name, not the key");
	const envFile = () => fs.readFileSync(path.join(h.home, ".env"), "utf8");
	assert.ok(envFile().includes("PINE_MCP_KEYED_MAIN_PINE_TEST_LOCAL_TOKEN=typed-by-the-owner"));
	assert.ok(!JSON.stringify(h.mock.state.requests.map((r: any) => r.body)).includes("typed-by-the-owner"), "the model was never shown it");
	await main([{ tools: [call("mcp__keyed__home", {})] }]);
	assert.ok(h.toolResults().at(-1)!.includes("TOKEN=") && !h.toolResults().at(-1)!.includes("TOKEN=undefined") && !h.toolResults().at(-1)!.includes("daemon-secret"), `the server has the key: ${h.toolResults().at(-1)}`);
	await main([{ tools: [call("remove_mcp_server", { name: "keyed" })] }]);
	assert.ok(!envFile().includes("PINE_MCP_KEYED"), "and it goes with the server");

	// Another agent cannot add one for everybody, and removing it leaves nothing behind.
	await h.pine.agents.run({ agent: "gonzo", prompt: mockMsg([{ tools: [call("add_mcp_server", { name: "all", command, scope: "global" })] }]), ...owner });
	assert.match(h.toolResults().at(-1)!, /Only the main agent/);
	await main([{ tools: [call("remove_mcp_server", { name: "cad" })] }]);
	assert.equal(agentJson().mcp, undefined);
	await h.close();

	// For an agent with the owner's account, the program reaches the account too, and still not pine's home.
	const wide = await harness({ pine: { defaults: { scope: undefined } }, agents: { main: { files } } });
	wide.pine.bus.subscribe("approval/requested", (e) => {
		asked.push(e.payload);
		wide.pine.approvals.decide((e.payload as any).id, true, "test");
	});
	const run = (steps: any[]) => wide.pine.agents.run({ agent: "main", prompt: mockMsg(steps), ...owner });
	await run([{ tools: [call("add_mcp_server", { name: "cad", command })] }]);
	assert.ok(asked.at(-1).summary.includes("your whole account"), asked.at(-1).summary);
	await run([{ tools: [call("mcp__cad__peek", { path: path.join(dir, "notes.txt") }), call("mcp__cad__peek", { path: path.join(wide.home, "pine.json") }), call("mcp__cad__home", {})] }]);
	const reach = wide.toolResults().slice(-3);
	assert.ok(reach[0].includes("ELSEWHERE-CONTENT"), reach[0]);
	assert.match(reach[1], /FAILED E(PERM|ACCES|NOENT)/);
	assert.ok(reach[2].includes(`HOME=${os.homedir()}`) && reach[2].includes("TOKEN=undefined"), reach[2]);
	await wide.close();
});
