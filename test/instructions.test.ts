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

test("instructions: a conversation that has read outside content cannot rewrite what goes into the prompt", mac, async () => {
	const h = await harness({ files: { "USER.md": "OWNER-V1\n" }, agents: { main: { agent: { mcp: { feed } }, files: { "SOUL.md": "SOUL-V1\n", "MEMORY.md": "MEMORY-V1\n" } } } });
	const ws = h.workspace("main"), user = path.join(h.home, "USER.md");
	await h.pine.agents.run({
		agent: "main",
		prompt: mockMsg([
			{ tools: [call("mcp__feed__echo", { text: "x" })] },
			{ tools: [call("write", { path: "MEMORY.md", content: "EVIL" }), call("write", { path: "SOUL.md", content: "EVIL" }), call("write", { path: user, content: "EVIL" }), call("bash", { command: `echo EVIL | tee MEMORY.md SOUL.md ${user}; echo fine | tee notes.md` })] },
		]),
		...owner,
	});
	const out = h.toolResults().slice(-4);
	for (const r of out.slice(0, 3)) assert.match(r, /holds agent instructions and cannot be changed in a run that has handled outside content/);
	assert.ok(refused.test(out[3]) && out[3].includes("fine"), out[3]);
	assert.deepEqual([fs.readFileSync(path.join(ws, "MEMORY.md"), "utf8"), fs.readFileSync(path.join(ws, "SOUL.md"), "utf8"), fs.readFileSync(user, "utf8")], ["MEMORY-V1\n", "SOUL-V1\n", "OWNER-V1\n"]);
	assert.equal(fs.readFileSync(path.join(ws, "notes.md"), "utf8"), "fine\n", "ordinary notes can still be written");
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
