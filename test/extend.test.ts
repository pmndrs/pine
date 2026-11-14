import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildArgv } from "../mcp/commands.ts";
import { htmlToText, isPrivateAddress } from "../mcp/web.ts";
import { harness, MCP_STUB, mockMsg, sleep, until } from "./support/harness.ts";

const owner = { trust: "owner" as const };
const stub = (label: string, extra: Record<string, unknown> = {}) => ({ command: process.execPath, args: [MCP_STUB], env: { MCP_LABEL: label }, ...extra });
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const mcpTools = (h: any, req: any) => h.toolsOffered(req).filter((t: string) => t.startsWith("mcp__")).map((t: string) => t.split("__")[1]).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i).sort();

test("MCP servers: global and per-agent, and their processes end with the session", async () => {
	const h = await harness({
		pine: { mcp: { shared: stub("shared"), lawonly: stub("lawonly", { agents: ["gonzo"] }) } },
		agents: { main: { agent: { mcp: { mine: stub("mine") } } }, gonzo: {}, bare: { agent: { globalMcp: false } } },
	});
	const whoami = (server: string) => mockMsg([{ tools: [{ name: `mcp__${server}__whoami`, args: {} }] }]);
	const a = await h.pine.agents.run({ agent: "main", prompt: whoami("mine"), ...owner });
	const persistentPid = JSON.parse(a.text.replace("FINAL:: ", "")).pid;
	assert.equal(JSON.parse(a.text.replace("FINAL:: ", "")).label, "mine");
	assert.deepEqual(mcpTools(h, h.requestsFor("PERSONA-MAIN")[0]), ["mine", "shared"]);

	const b = await h.pine.agents.run({ agent: "gonzo", prompt: whoami("lawonly"), session: "new", ...owner });
	const ephemeralPid = JSON.parse(b.text.replace("FINAL:: ", "")).pid;
	assert.deepEqual(mcpTools(h, h.requestsFor("PERSONA-GONZO")[0]), ["lawonly", "shared"]);

	await h.pine.agents.run({ agent: "bare", prompt: "hello", ...owner });
	assert.deepEqual(mcpTools(h, h.requestsFor("PERSONA-BARE")[0]), []);

	await until(() => !alive(ephemeralPid), 3000, "the one-off session's MCP server to exit");
	assert.ok(alive(persistentPid), "a named session keeps its servers while it is live");
	await h.close();
	await until(() => !alive(persistentPid), 3000, "the MCP server to exit when the daemon stops");
});

test("pi extensions and skills come from the configuration, never from the workspace", async () => {
	const ext = (mark: string) => `export default function (pi) { pi.on("before_agent_start", async (e) => ({ systemPrompt: e.systemPrompt + "\\n${mark}" })); }`;
	const skill = (name: string, mark: string) => `---\nname: ${name}\ndescription: ${mark}\n---\nbody\n`;
	const h = await harness({
		pine: { extensions: ["./ext/global.ts"], skills: ["./skills"] },
		files: { "ext/global.ts": ext("GLOBAL-PI-EXT"), "skills/common/SKILL.md": skill("common", "MARK-GLOBAL-SKILL") },
		agents: {
			main: {},
			gonzo: {
				dirFiles: { "extensions/own.ts": ext("GONZO-PI-EXT"), "skills/deeds/SKILL.md": skill("deeds", "MARK-GONZO-SKILL") },
				files: {
					".pi/extensions/evil.ts": `import fs from "node:fs"; export default function () { fs.writeFileSync(${JSON.stringify("__MARK__")}, "1"); }`,
					".pi/skills/planted/SKILL.md": skill("planted", "MARK-PLANTED-SKILL"),
					".pi/APPEND_SYSTEM.md": "MARK-PLANTED-SYSTEM\n",
				},
			},
		},
		start: false,
	});
	const marker = path.join(h.home, "extension-ran");
	const evil = path.join(h.home, "agents", "gonzo", "workspace", ".pi", "extensions", "evil.ts");
	fs.writeFileSync(evil, fs.readFileSync(evil, "utf8").replace("__MARK__", marker));
	await h.restart();
	await h.pine.agents.run({ agent: "main", prompt: "hi", ...owner });
	await h.pine.agents.run({ agent: "gonzo", prompt: "hi", ...owner });
	const main = h.system(h.requestsFor("PERSONA-MAIN")[0]);
	const gonzo = h.system(h.requestsFor("PERSONA-GONZO")[0]);
	assert.ok(main.includes("GLOBAL-PI-EXT") && main.includes("MARK-GLOBAL-SKILL") && !main.includes("GONZO-PI-EXT") && !main.includes("MARK-GONZO-SKILL"));
	assert.ok(gonzo.includes("GLOBAL-PI-EXT") && gonzo.includes("GONZO-PI-EXT") && gonzo.includes("MARK-GLOBAL-SKILL") && gonzo.includes("MARK-GONZO-SKILL"));
	assert.ok(!gonzo.includes("MARK-PLANTED-SKILL") && !gonzo.includes("MARK-PLANTED-SYSTEM"), "workspace-supplied skills and prompts are ignored");
	assert.ok(!fs.existsSync(marker), "code planted in the workspace did not run inside the daemon");
	await h.close();
});

test("bundled commands server: fixed commands as tools, parameters cannot inject", async () => {
	const cmd = { description: "x", run: ["/bin/echo", "said:", "{{what}}", "--mode={{mode}}"], params: { what: {}, mode: { enum: ["a", "b"], default: "a" } } };
	assert.deepEqual(buildArgv(cmd, { what: "hi; rm -rf /" }), ["/bin/echo", "said:", "hi; rm -rf /", "--mode=a"]);
	assert.throws(() => buildArgv(cmd, { what: "--version" }), /must not start with "-"/);
	assert.throws(() => buildArgv(cmd, { what: "x", mode: "c" }), /must be one of/);
	assert.throws(() => buildArgv(cmd, {}), /"what" is required/);
	assert.throws(() => buildArgv({ description: "", run: ["x", "{{n}}"], params: { n: { type: "number" } } }, { n: "1; ls" }), /must be a number/);
	assert.throws(() => buildArgv({ description: "", run: ["x", "{{id}}"], params: { id: { pattern: "[a-z0-9]+" } } }, { id: "abc/../.." }), /invalid format/);

	const h = await harness({
		pine: { mcp: { tools: { pine: "commands", options: { commands: { say: cmd, where: { description: "print the working directory", run: ["/bin/pwd"] }, sleepy: { description: "slow", run: ["/bin/sleep", "5"], timeoutSec: 0.2 } } } } } },
		agents: { main: {} },
	});
	const r = await h.pine.agents.run({
		agent: "main",
		prompt: mockMsg([{ tools: [{ name: "mcp__tools__say", args: { what: "$(id) `id` ; id" } }, { name: "mcp__tools__where", args: {} }, { name: "mcp__tools__say", args: { what: "-n" } }, { name: "mcp__tools__sleepy", args: {} }] }]),
		...owner,
	});
	const [say, where, dash, slow] = h.toolResults();
	assert.equal(say, "said: $(id) `id` ; id --mode=a");
	assert.equal(where, h.workspace("main"));
	assert.ok(/must not start with "-"/.test(dash), dash);
	assert.ok(/stopped after 0.2 s/.test(slow), slow);
	assert.equal(r.status, "done");
	await h.close();
});

test("bundled web server: refuses private addresses, and using it taints the session", async () => {
	for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.10", "172.16.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) assert.ok(isPrivateAddress(ip), ip);
	for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) assert.ok(!isPrivateAddress(ip), ip);
	// 192.0.x.x: two blocks are set aside and stay closed; the rest is public (iana.org, a large hosting network).
	for (const ip of ["192.0.0.1", "192.0.0.170", "192.0.2.44"]) assert.ok(isPrivateAddress(ip), ip);
	for (const ip of ["192.0.43.8", "192.0.78.13", "192.0.1.1"]) assert.ok(!isPrivateAddress(ip), ip);
	const page = htmlToText("<html><head><title>A &amp; B</title><script>evil()</script><style>p{}</style></head><body><h1>Head</h1><p>one<br>two</p><ul><li>item</li></ul><!-- hidden --></body></html>");
	assert.equal(page.title, "A & B");
	assert.equal(page.text, "Head\none\ntwo\n- item");

	const h = await harness({ pine: { mcp: { web: { pine: "web" } } }, agents: { main: { agent: { publish: ["out/#"] } } } });
	const urls = [`http://127.0.0.1:${h.mock.port}/v1/models`, `http://localhost:${h.mock.port}/v1/models`, "file:///etc/passwd", "http://user:pw@example.com/", `http://2130706433:${h.mock.port}/`, "http://[::1]/"];
	await h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: urls.map((url) => ({ name: "mcp__web__fetch", args: { url } })) }]), ...owner });
	const results = h.toolResults();
	assert.equal(results.length, urls.length);
	for (const [i, r] of results.entries()) assert.ok(/private|only http and https|credentials|not fetched/.test(r), `${urls[i]} -> ${r}`);
	assert.equal(h.mock.state.requests.filter((q: any) => q.url === "/v1/models").length, 0, "nothing reached the local server");
	const session = h.pine.agents.status().sessions.find((s) => s.agent === "main")!;
	assert.ok(/mcp__web__fetch returned outside content/.test(session.tainted ?? ""), String(session.tainted));
	await sleep(10);
	await h.close();
});
