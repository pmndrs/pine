import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { harness, MCP_STUB, mockMsg, notesOf, refused } from "./support/harness.ts";
import { sandboxAvailable } from "../src/security.ts";

const owner = { trust: "owner" as const };
const mac = { skip: !sandboxAvailable() };
const call = (name: string, args: any) => ({ name, args });
const feed = { command: process.execPath, args: [MCP_STUB], env: { MCP_LABEL: "feed" }, taints: true };

test("instructions: an agent's own files and the owner's file are read into its prompt, in a fixed order", async () => {
	const h = await harness({
		files: { "USER.md": "OWNER-FACTS likes short answers\n" },
		agents: {
			main: { files: { "AGENTS.md": "WS-HOW\n", "SOUL.md": "WS-SOUL\n", "MEMORY.md": "WS-MEMORY\n", "TOOLS.md": "NOT-A-PROMPT-FILE\n", "notes/SOUL.md": "NESTED-SOUL\n" } },
			gonzo: { files: { "SOUL.md": "GONZO-SOUL\n" } },
		},
	});
	await h.pine.agents.run({ agent: "main", prompt: "hello", ...owner });
	await h.pine.agents.run({ agent: "gonzo", prompt: "hello", ...owner });
	const main = h.system(h.requestsFor("PERSONA-MAIN")[0]);
	const gonzo = h.system(h.requestsFor("PERSONA-GONZO")[0]);
	const order = ["PERSONA-MAIN", "WS-HOW", "WS-SOUL", "OWNER-FACTS", "WS-MEMORY"].map((x) => main.indexOf(x));
	assert.ok(order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1])), `what the owner alone can change first, memory last: ${order}`);
	assert.ok(!main.includes("NOT-A-PROMPT-FILE") && !main.includes("NESTED-SOUL"), "only the named files, and only at the top of the workspace");
	assert.ok(gonzo.includes("OWNER-FACTS") && gonzo.includes("GONZO-SOUL") && !gonzo.includes("WS-SOUL"), "every agent knows the owner; each has its own soul");
	// Each agent is told what the files are for and who keeps the owner's.
	assert.ok(main.includes("MEMORY.md: your memory") && main.includes("AGENTS.md: your purpose and how you work") && main.includes(`${path.join(h.home, "USER.md")}; you are the one who keeps it`));
	assert.ok(gonzo.includes("(USER.md) is kept by main for all agents") && !gonzo.includes("you are the one who keeps it"));
	await h.close();
});

test("instructions: an agent writes its own files and sees them from its next message on; the owner's file is the main agent's", mac, async () => {
	const h = await harness({ files: { "USER.md": "# User\n" }, agents: { main: {}, gonzo: {} } });
	const user = path.join(h.home, "USER.md");
	const run = (agent: string, tools: any[]) => h.pine.agents.run({ agent, prompt: mockMsg([{ tools }]), ...owner });

	await run("main", [call("write", { path: "AGENTS.md", content: "PURPOSE: keep the books\n" }), call("write", { path: "MEMORY.md", content: "REMEMBERED: the tax year ends in June\n" }), call("bash", { command: "echo 'SOUL: dry humour' | tee SOUL.md" }), call("edit", { path: user, edits: [{ oldText: "# User\n", newText: "# User\n\nOWNER: Alex, prefers tables\n" }] })]);
	const ws = h.workspace("main");
	assert.equal(fs.readFileSync(path.join(ws, "MEMORY.md"), "utf8"), "REMEMBERED: the tax year ends in June\n", h.toolResults().join(" | "));
	assert.match(fs.readFileSync(user, "utf8"), /OWNER: Alex, prefers tables/, h.toolResults().join(" | "));
	await h.pine.agents.run({ agent: "main", prompt: "and now?", ...owner });
	// With families a conversation keeps the instructions it began with (it knows what it wrote itself): the next
	// conversation is the one that begins with the files as they are now.
	if (h.families) await h.pine.agents.run({ agent: "main", session: "next", prompt: "hello", ...owner });
	const now = h.system(h.mock.state.requests.at(-1));
	for (const part of ["PURPOSE: keep the books", "REMEMBERED: the tax year ends in June", "SOUL: dry humour", "OWNER: Alex, prefers tables"]) assert.ok(now.includes(part), part);

	// Another agent reads what main wrote about the owner, and cannot change it.
	await run("gonzo", [call("write", { path: user, content: "OWNER: someone else\n" }), call("bash", { command: `echo evil | tee ${user}; cat ${user}` })]);
	const out = h.toolResults().slice(-2);
	assert.match(out[0], /outside the paths this agent may write/);
	assert.ok(refused.test(out[1]) && !out[1].includes("OWNER: Alex"), `neither written nor read as a file: ${out[1]}`);
	assert.ok(h.system(h.mock.state.requests.at(-1)).includes("OWNER: Alex, prefers tables"), "it is in its prompt all the same");
	assert.match(fs.readFileSync(user, "utf8"), /OWNER: Alex/);
	// The rest of pine's home stays closed to the main agent too.
	await run("main", [call("write", { path: path.join(h.home, "NOTES.md"), content: "x" }), call("read", { path: path.join(h.home, "pine.json") })]);
	assert.ok(h.toolResults().slice(-2).every((r) => /outside the paths|not accessible to agents/.test(r)), h.toolResults().slice(-2).join(" | "));
	await h.close();
});

test("instructions: a conversation that has read outside content still keeps the agent's own files, and only those", mac, async () => {
	const h = await harness({ files: { "USER.md": "OWNER-V1\n" }, agents: { main: { agent: { mcp: { feed } }, files: { "SOUL.md": "SOUL-V1\n", "MEMORY.md": "MEMORY-V1\n" } } } });
	const ws = h.workspace("main"), user = path.join(h.home, "USER.md");
	const asked: any[] = [];
	h.pine.bus.subscribe("approval/requested", (e) => void asked.push(e.payload));
	const run = (tools: any[]) => h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools }]), ...owner });
	await run([call("mcp__feed__echo", { text: "x" })]);
	await run([call("write", { path: "MEMORY.md", content: "LEARNED: the server is installed\n" }), call("edit", { path: "MEMORY.md", edits: [{ oldText: "installed", newText: "installed and signed in" }] }), call("write", { path: user, content: "OWNER-V2\n" })]);
	await run([call("bash", { command: "echo MORE | tee -a MEMORY.md; echo EVIL | tee CLAUDE.md .pi" }), call("write", { path: "CLAUDE.md", content: "EVIL" })]);
	assert.equal(asked.length, 0, "its own memory is its own: nobody is asked");
	assert.equal(fs.readFileSync(path.join(ws, "MEMORY.md"), "utf8"), "LEARNED: the server is installed and signed in\nMORE\n");
	assert.equal(fs.readFileSync(user, "utf8"), "OWNER-V2\n");
	// Only its own files: what else would be read as instructions stays as it is.
	assert.match(h.toolResults().at(-1)!, /holds agent instructions/);
	assert.ok(!fs.existsSync(path.join(ws, "CLAUDE.md")) && !fs.existsSync(path.join(ws, ".pi")));
	await h.close();
});

test("instructions: an agent is reminded to tidy a memory that has grown long", async () => {
	const h = await harness({ agents: { main: { files: { "MEMORY.md": `# Memory\n${"- a thing worth keeping\n".repeat(320)}` } }, gonzo: { files: { "MEMORY.md": "# Memory\n- one thing\n" } } } });
	await h.pine.agents.run({ agent: "main", prompt: "hello", ...owner });
	assert.match(notesOf(h.mock.state.requests.at(-1)).join("\n"), /Your MEMORY\.md has grown to about 8 thousand characters.*Tidy it when this task is done/);
	await h.pine.agents.run({ agent: "gonzo", prompt: "hello", ...owner });
	assert.doesNotMatch(notesOf(h.mock.state.requests.at(-1)).join("\n"), /MEMORY\.md has grown/);
	await h.close();
});
