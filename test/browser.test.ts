import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ALWAYS_BLOCKED, ASK_HINT, CORE_TOOLS, inlineFiles, relay, startGuardProxy, toolAllowed, vet } from "../mcp/browser.ts";
import { browserSession } from "../src/agents.ts";
import { localTarget } from "../src/net.ts";
import { effectiveMcp, loadConfig, mcpTaints, toPiMcp } from "../src/config.ts";
import { harness, mockMsg, notesOf, until } from "./support/harness.ts";

test("browser: tools that run code or read local files are never offered", () => {
	for (const name of ALWAYS_BLOCKED) for (const tools of ["core", "all", [name]] as const) assert.equal(toolAllowed(name, { tools: tools as any }), false, `${name} with ${tools}`);
	assert.ok(ALWAYS_BLOCKED.includes("browser_run_code_unsafe") && ALWAYS_BLOCKED.includes("browser_file_upload"));
	assert.ok(toolAllowed("browser_navigate", {}) && toolAllowed("browser_snapshot", {}) && CORE_TOOLS.includes("browser_click"));
	assert.equal(toolAllowed("browser_evaluate", {}), false, "not in the core set");
	assert.ok(toolAllowed("browser_take_screenshot", {}) && toolAllowed("browser_console_messages", {}), "an agent that builds a page can look at it and see why it fails");
	assert.equal(toolAllowed("browser_evaluate", { tools: "all" }), true);
	assert.equal(toolAllowed("browser_evaluate", { tools: "all", block: ["browser_evaluate"] }), false);
	assert.equal(toolAllowed("browser_click", { tools: ["browser_navigate"] }), false);
});

test("browser: destinations are vetted before the browser may connect", async () => {
	for (const host of ["127.0.0.1", "localhost", "printer.local", "10.0.0.5", "192.168.1.1", "169.254.169.254", "[::1]", "[fd00::1]", "nas.internal"]) await assert.rejects(() => vet(host, {}), /private address|local name/, host);
	assert.equal(await vet("93.184.216.34", {}), "93.184.216.34");
	assert.equal(await vet("127.0.0.1", { allowPrivate: true }), "127.0.0.1");
	await assert.rejects(() => vet("93.184.216.34", { denyHosts: ["93.184.216.34"] }), /deny list/);
	await assert.rejects(() => vet("93.184.216.34", { allowHosts: ["example.org"] }), /not on the allow list/);
	await assert.rejects(() => vet("tracker.ads.example", { denyHosts: ["ads.example"] }), /deny list/);
});

test("browser: the guard proxy lets vetted traffic through and refuses the rest, for http and for tunnels", async (t) => {
	const target = http.createServer((_req, res) => res.end("LOCAL-SERVICE-SECRET"));
	await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
	const port = (target.address() as net.AddressInfo).port;
	t.after(() => target.close());

	const viaProxy = (proxyPort: number) =>
		new Promise<{ status: number; body: string }>((resolve, reject) => {
			const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: `http://127.0.0.1:${port}/x`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
				let body = "";
				res.on("data", (d) => (body += d)).on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			});
			req.on("error", reject).end();
		});
	const tunnel = (proxyPort: number) =>
		new Promise<string>((resolve) => {
			const s = net.connect(proxyPort, "127.0.0.1", () => s.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`));
			let data = "";
			let sent = false;
			s.on("data", (d) => {
				data += d;
				if (!sent && data.includes("200 Connection Established")) {
					sent = true;
					s.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
				}
			});
			s.on("close", () => resolve(data));
		});

	const strict = await startGuardProxy({});
	t.after(() => strict.close());
	const refused = await viaProxy(strict.port);
	assert.equal(refused.status, 403);
	assert.ok(!refused.body.includes("LOCAL-SERVICE-SECRET") && /not reachable from the browser/.test(refused.body));
	const refusedTunnel = await tunnel(strict.port);
	assert.ok(/^HTTP\/1.1 403/.test(refusedTunnel) && !refusedTunnel.includes("LOCAL-SERVICE-SECRET"));
	assert.equal(strict.refused.length, 2);

	const open = await startGuardProxy({ allowPrivate: true });
	t.after(() => open.close());
	assert.deepEqual(await viaProxy(open.port), { status: 200, body: "LOCAL-SERVICE-SECRET" });
	assert.ok((await tunnel(open.port)).includes("LOCAL-SERVICE-SECRET"));
});

test("browser: a local address opens only where the owner allowed that host and port", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-browser-local-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const localFile = path.join(dir, "allowed.json");
	const serve = async (text: string) => {
		const s = http.createServer((_req, res) => res.end(text));
		await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
		t.after(() => s.close());
		return (s.address() as net.AddressInfo).port;
	};
	const [dev, other] = [await serve("DEV-SERVER-PAGE"), await serve("OTHER-LOCAL-SECRET")];
	const get = (proxyPort: number, port: number) =>
		new Promise<{ status: number; body: string }>((resolve, reject) => {
			const req = http.request({ host: "127.0.0.1", port: proxyPort, path: `http://127.0.0.1:${port}/`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
				let body = "";
				res.on("data", (d) => (body += d)).on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			});
			req.on("error", reject).end();
		});
	const tunnel = (proxyPort: number, port: number) =>
		new Promise<string>((resolve) => {
			const s = net.connect(proxyPort, "127.0.0.1", () => s.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\n`));
			let data = "";
			let sent = false;
			s.on("data", (d) => {
				data += d;
				if (!sent && data.includes("200 Connection Established")) {
					sent = true;
					s.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
				}
			});
			s.on("close", () => resolve(data));
		});

	const proxy = await startGuardProxy({ localFile });
	t.after(() => proxy.close());
	// No yes yet (the file is not there): refused, and the agent is told how the owner gets asked.
	const before = await get(proxy.port, dev);
	assert.equal(before.status, 403);
	assert.ok(before.body.includes(ASK_HINT) && !before.body.includes("DEV-SERVER-PAGE"), before.body);

	// The yes applies at once, to that host and port and to nothing else.
	fs.writeFileSync(localFile, JSON.stringify([`127.0.0.1:${dev}`]));
	assert.deepEqual(await get(proxy.port, dev), { status: 200, body: "DEV-SERVER-PAGE" });
	assert.ok((await tunnel(proxy.port, dev)).includes("DEV-SERVER-PAGE"));
	assert.equal((await get(proxy.port, other)).status, 403);
	assert.ok(!(await tunnel(proxy.port, other)).includes("OTHER-LOCAL-SECRET"));
	await assert.rejects(() => vet("127.0.0.1", { localFile }), /private address/, "no port, no exception");
	await assert.rejects(() => vet("localhost", { localFile }, dev), /local name/, "another name for the same machine was not allowed");
	await assert.rejects(() => vet("127.0.0.1", { localFile, denyHosts: ["127.0.0.1"] }, dev), /deny list/, "the owner's host lists come first");
	await assert.rejects(() => vet("127.0.0.1", { localFile, allowHosts: ["example.org"] }, dev), /allow list/);

	// Taken back (a reset removes the file), or a file that is not a list: closed again.
	fs.writeFileSync(localFile, JSON.stringify({ [`127.0.0.1:${dev}`]: true }));
	assert.equal((await get(proxy.port, dev)).status, 403);
	fs.rmSync(localFile);
	assert.equal((await get(proxy.port, dev)).status, 403);

	// Without the file option (a run started from outside) there is nobody to ask, and no hint.
	const strict = await startGuardProxy({});
	t.after(() => strict.close());
	assert.ok(!(await get(strict.port, dev)).body.includes(ASK_HINT));
});

test("browser: only a host that is local by its own name can be asked about", () => {
	const key = (url: string) => localTarget(url)?.key;
	assert.equal(key("http://localhost:5173/app?x=1"), "localhost:5173");
	assert.equal(key("localhost:5173"), "localhost:5173", "written the way people say it");
	assert.equal(key("http://LOCALHOST/"), "localhost:80");
	assert.equal(key("https://192.168.1.247/"), "192.168.1.247:443");
	assert.equal(key("http://127.1:8080/"), "127.0.0.1:8080", "the address the browser would connect to, not the spelling");
	assert.equal(key("http://[::1]:3000/"), "[::1]:3000");
	assert.equal(key("http://printer.local:631/"), "printer.local:631");
	for (const url of ["https://example.com/", "http://93.184.216.34:5173/", "http://nas.home/", "http://localhost.evil.example/", "file:///etc/passwd", "javascript:alert(1)", "", "not a url"]) assert.equal(localTarget(url), undefined, url);
	assert.equal(localTarget(undefined), undefined);
});

test("browser: opening a local address asks the owner, and the yes holds for that conversation only", { timeout: 60_000 }, async (t) => {
	const target = http.createServer((_req, res) => res.end("DEV"));
	await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
	t.after(() => target.close());
	const port = (target.address() as net.AddressInfo).port;
	// No browser is started: the program it would run does not exist. What is tested is who gets asked.
	const h = await harness({ pine: { http: { port: 0 }, mcp: { browser: { pine: "browser", options: { executablePath: "/nonexistent/browser" } } } }, agents: { main: { agent: { untrusted: { mcp: ["browser"] } } } } });
	let answer = false;
	const asked: any[] = [];
	h.pine.bus.subscribe("approval/requested", (e) => {
		asked.push(e.payload);
		h.pine.approvals.decide((e.payload as any).id, answer, "test");
	});
	const open = (url: string, o: Record<string, unknown> = {}) => h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: [{ name: "mcp__browser__browser_navigate", args: { url } }] }]), trust: "owner", ...o } as any);
	const file = (session = "main") => path.join(h.pine.cfg.dataDir, "browser-local", `${encodeURIComponent(`main:${session}`)}.json`);
	const url = `http://127.0.0.1:${port}/`;

	// A no: the call does not happen and nothing is opened.
	await open(url);
	assert.equal(asked.length, 1);
	assert.ok(asked[0].summary.includes(url) && asked[0].summary.includes(`127.0.0.1:${port}`) && asked[0].why.includes("for this conversation"), JSON.stringify(asked[0]));
	assert.equal(asked[0].remember, undefined);
	assert.match(h.toolResults().at(-1)!, /not approved \(test\)\. The browser cannot open/);
	assert.ok(!fs.existsSync(file()));

	// A yes: written where the guard reads it, and not asked again.
	answer = true;
	await open(url);
	assert.equal(asked.length, 2);
	assert.ok(!asked[1].why.includes("Careful"));
	assert.deepEqual(JSON.parse(fs.readFileSync(file(), "utf8")), [`127.0.0.1:${port}`]);
	assert.ok(!/not approved/.test(h.toolResults().at(-1)!));
	await open(`${url}other/page`);
	assert.equal(asked.length, 2, "the same host and port");

	// Another port, another conversation: asked again. A public address: never.
	await open(`http://127.0.0.1:${port + 1}/`);
	assert.equal(asked.length, 3);
	assert.ok(asked[2].why.includes("Careful: this conversation has read outside content"), "by now the browser has been used here");
	await open(url, { session: "second" });
	assert.equal(asked.length, 4);
	assert.deepEqual(JSON.parse(fs.readFileSync(file("second"), "utf8")), [`127.0.0.1:${port}`]);
	await open("https://example.com/", { session: "third" });
	assert.equal(asked.length, 4);

	// pine's own control port is not put to the owner at all.
	const control = h.pine.cfg.http!.port;
	assert.ok(control > 0);
	await open(`http://localhost:${control}/api/status`);
	assert.match(h.toolResults().at(-1)!, /pine's own control port/);
	assert.equal(asked.length, 4);

	// A run that outside content started cannot ask, and its browser has no list to read.
	await open(url, { trust: "untrusted", session: "outside" });
	assert.equal(asked.length, 4);
	assert.ok(!/not found|not approved/.test(h.toolResults().at(-1)!), "it has the browser, and the guard is what refuses");
	assert.ok(!fs.existsSync(file("outside")) && !fs.existsSync(file("outside~u")));

	// A reset takes the yes back; so does a restart.
	await h.pine.agents.resetSession("main", "main");
	assert.ok(!fs.existsSync(file()));
	assert.ok(fs.existsSync(file("second")));
	await h.restart();
	assert.ok(!fs.existsSync(file("second")));
	await h.close();
});

test("browser: page snapshots written to the scratch folder are put into the result; other files are not", (t) => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pine-browser-test-"));
	t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
	fs.writeFileSync(path.join(scratch, "page.yml"), '- heading "Hello" [ref=e2]\n- button "Go" [ref=e3]\n');
	fs.writeFileSync(path.join(scratch, "big.yml"), "x".repeat(5000));
	const out = inlineFiles(`### Snapshot\n- [Snapshot](${path.join(scratch, "page.yml")})\n- [Secrets](/etc/hosts)\n- [Snapshot](${path.join(scratch, "big.yml")}#L1)`, scratch, 1000);
	assert.ok(out.includes('Snapshot:\n- heading "Hello" [ref=e2]\n- button "Go" [ref=e3]'));
	assert.ok(out.includes("[Secrets](/etc/hosts)"), "a link outside the scratch folder stays a link");
	assert.ok(out.includes("[cut: 4000 more characters"));
});

test("browser: a screenshot's bytes are not put into the result as text", (t) => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pine-browser-test-"));
	t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
	const shot = path.join(scratch, "page.png");
	fs.writeFileSync(shot, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR-and-more".repeat(50))]));
	const out = inlineFiles(`### Result\n- [Screenshot of viewport](${shot})`, scratch);
	assert.equal(out, `### Result\n- Screenshot of viewport: saved as ${fs.realpathSync(shot)}`);
});

// A stand-in for Playwright's server: it says whether it has a window, keeps cookies only when
// they are handed over in a file, and fails where the test tells it to.
const FAKE_BROWSER = `
import fs from "node:fs";
import readline from "node:readline";
const [mode, log, ...flags] = process.argv.slice(2);
const note = (line) => fs.appendFileSync(log, line + "\\n");
note("start " + mode);
let tabs = ["about:blank"], at = 0, cookies = "none", shots = 0;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const page = () => "### Page\\n- Page URL: " + tabs[at] + "\\n- window: " + mode + "\\n- cookies: " + cookies;
// What the owner does in the window meanwhile: lines "goto <address>" and "newtab <address>" in a file beside the log.
const owner = () => {
	if (!fs.existsSync(log + ".owner")) return;
	for (const line of fs.readFileSync(log + ".owner", "utf8").split("\\n").filter(Boolean)) {
		const [what, where] = line.split(" ");
		if (what === "goto") tabs[at] = where;
		else tabs.push(where);
	}
	fs.rmSync(log + ".owner");
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const m = JSON.parse(line);
	if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
	if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: ["browser_navigate", "browser_take_screenshot", "browser_storage_state", "browser_cookie_list", "browser_run_code_unsafe"].map((name) => ({ name, inputSchema: { type: "object" } })) } });
	if (m.method !== "tools/call") return;
	const a = m.params.arguments ?? {};
	const reply = (text, isError) => send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } });
	owner();
	if (m.params.name !== "browser_tabs" || a.action !== "list") note(m.params.name + (a.url ? " " + a.url : "") + (a.action ? " " + a.action + (a.index ?? "") : ""));
	switch (m.params.name) {
		case "browser_navigate":
			if (mode === "headed" && flags.includes("no-screen")) return reply("### Error\\nError: browserType.launch: Missing X server or $DISPLAY", true);
			tabs[at] = a.url;
			return reply(page());
		case "browser_tabs":
			if (a.action === "select") at = a.index;
			if (a.action === "new") at = tabs.push(a.url ?? "about:blank") - 1;
			return reply("### Result\\n" + tabs.map((u, i) => "- " + i + ":" + (i === at ? " (current)" : "") + " [Page " + i + "](" + u + ")").join("\\n"));
		case "browser_snapshot":
			return reply(page() + "\\n### Snapshot\\n- heading of " + tabs[at]);
		case "login":
			cookies = "session=abc";
			return reply(page());
		case "browser_storage_state":
			fs.writeFileSync(a.filename, cookies);
			return reply("saved");
		case "browser_set_storage_state":
			cookies = fs.readFileSync(a.filename, "utf8");
			return reply("restored");
		case "browser_take_screenshot":
			return ++shots === 1 ? reply("### Error\\nTimeoutError: browserBackend.callTool: Timeout 5000ms exceeded.\\n  - waiting for fonts to load...", true) : reply("### Result\\n- shot " + shots);
		case "browser_close":
			return reply("closed");
	}
	reply("ok");
});
`;

async function fakeBrowser(t: { after(fn: () => void): void }, o: Record<string, unknown>, ...flags: string[]) {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pine-browser-test-"));
	const script = path.join(scratch, "fake.mjs");
	const log = path.join(scratch, "log.txt");
	fs.writeFileSync(script, FAKE_BROWSER);
	const got = new Map<unknown, any>();
	let ended = false;
	const server = relay(o as any, {
		launch: (headed) => spawn(process.execPath, [script, headed ? "headed" : "hidden", log, ...flags], { stdio: ["pipe", "pipe", "inherit"] }),
		send: (msg: any) => void got.set(msg.id, msg),
		scratch,
		refused: [],
		ended: () => void (ended = true),
	});
	t.after(() => (server.child().kill(), fs.rmSync(scratch, { recursive: true, force: true })));
	let id = 0;
	const rpc = async (method: string, params?: unknown) => {
		const n = ++id;
		server.line(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
		await until(() => got.has(n), 5000, `an answer to ${method} ${JSON.stringify(params)}`);
		return got.get(n);
	};
	const call = async (name: string, args: unknown = {}) => {
		const r = (await rpc("tools/call", { name, arguments: args })).result;
		return { text: r.content.map((p: any) => p.text).join("\n") as string, failed: r.isError === true };
	};
	await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } });
	return { rpc, call, scratch, log: () => fs.readFileSync(log, "utf8").trim().split("\n"), ended: () => ended, owner: (...lines: string[]) => fs.writeFileSync(`${log}.owner`, lines.join("\n")) };
}

test("browser: with a window the owner uses it too: the agent is moved to the page they opened and does not leave a page it has not seen", async (t) => {
	const b = await fakeBrowser(t, { window: true, tools: "all" });
	await b.call("browser_navigate", { url: "https://en.wikipedia.org/" });
	await b.call("browser_show");

	// The owner goes to a shop in the tab that is open. The agent, told to search, tries to go to a search engine.
	b.owner("goto https://shop.example/");
	const stopped = await b.call("browser_navigate", { url: "https://search.example/?q=shampoo" });
	assert.ok(stopped.text.startsWith("Not done: the browser is not where you left it.") && stopped.text.includes("Page 0 (https://shop.example/)") && stopped.text.includes("- heading of https://shop.example/"), stopped.text);
	assert.ok(!b.log().includes("browser_navigate https://search.example/?q=shampoo"), "the owner's page was not left");
	// It has seen the page now: the same call again is its decision, and is carried out.
	assert.match((await b.call("browser_navigate", { url: "https://shop.example/s?k=shampoo" })).text, /Page URL: https:\/\/shop\.example\/s\?k=shampoo/);

	// The owner opens another tab. A look goes through, on that tab, and says so; so does what follows.
	b.owner("newtab https://mail.example/inbox");
	const looked = await b.call("browser_snapshot");
	assert.ok(looked.text.startsWith("The browser has changed since you last looked") && looked.text.includes("Page 1 (https://mail.example/inbox)") && looked.text.includes("- heading of https://mail.example/inbox"), looked.text);
	assert.ok(b.log().includes("browser_tabs select1"), "the agent was moved to the owner's tab");
	assert.ok(!(await b.call("browser_snapshot")).text.startsWith("The browser has changed"), "nothing changed since: no note");

	// A page that moves within itself is the same page; the agent's own new tab is its own doing.
	b.owner("goto https://mail.example/inbox#message-4");
	assert.match((await b.call("browser_click", { ref: "e1" })).text, /^ok$/);
	await b.call("browser_tabs", { action: "new", url: "https://search.example/" });
	assert.match((await b.call("browser_navigate", { url: "https://search.example/?q=x" })).text, /Page URL: https:\/\/search\.example\/\?q=x/);

	// Without a window nobody else is in the browser, and nothing is compared.
	await b.call("browser_hide");
	b.owner("goto https://elsewhere.example/");
	assert.match((await b.call("browser_navigate", { url: "https://search.example/?q=y" })).text, /Page URL: https:\/\/search\.example\/\?q=y/);
});

test("browser: in the owner's conversation the agent puts the browser on the screen and takes it off, on the same page with the same login", async (t) => {
	const b = await fakeBrowser(t, { window: true, tools: [...CORE_TOOLS, "login"] });
	const names = (await b.rpc("tools/list")).result.tools.map((x: any) => x.name);
	assert.deepEqual(names, ["browser_navigate", "browser_take_screenshot", "browser_show", "browser_hide"], "the window tools are offered; what reads cookies or runs code is not");

	// Nothing open yet: showing it still opens a window, on an empty page.
	assert.match((await b.call("browser_hide")).text, /has no window/);
	const empty = await b.call("browser_show");
	assert.ok(!empty.failed && empty.text.includes("now a window on your owner's screen") && empty.text.includes("- window: headed"), empty.text);
	assert.match((await b.call("browser_show")).text, /already a window/);
	assert.ok(!(await b.call("browser_hide")).failed);

	// A page and a login, without a window. Shown: the same page, the login still there. Hidden again: the same.
	await b.call("browser_navigate", { url: "https://shop.example/account" });
	assert.match((await b.call("login")).text, /window: hidden\n- cookies: session=abc/);
	const shown = await b.call("browser_show");
	assert.ok(shown.text.includes("- Page URL: https://shop.example/account\n- window: headed\n- cookies: session=abc"), shown.text);
	const hidden = await b.call("browser_hide");
	assert.ok(hidden.text.startsWith("The window is closed.") && hidden.text.includes("- Page URL: https://shop.example/account\n- window: hidden\n- cookies: session=abc"), hidden.text);
	assert.deepEqual(fs.readdirSync(b.scratch).filter((f) => f.startsWith("state-")), [], "the file that carried the login is gone");
	assert.equal(b.ended(), false, "a browser that was replaced does not end the server");
	assert.deepEqual(b.log().filter((l) => l.startsWith("start")), ["start hidden", "start headed", "start hidden", "start headed", "start hidden"]);

	// The tools pine uses for this itself stay closed to the agent.
	for (const name of ["browser_storage_state", "browser_set_storage_state", "browser_cookie_list", "browser_run_code_unsafe"]) assert.match((await b.call(name, { filename: "/etc/hosts" })).text, /is not available/);
});

test("browser: no window for a run started from outside; a machine without a screen says so and carries on; a screenshot that timed out is taken again", async (t) => {
	// What pine passes for a run that the owner did not start.
	const outside = await fakeBrowser(t, { window: false });
	assert.deepEqual((await outside.rpc("tools/list")).result.tools.map((x: any) => x.name), ["browser_navigate", "browser_take_screenshot"]);
	assert.match((await outside.call("browser_show")).text, /browser_show is not available/);
	assert.deepEqual(outside.log(), ["start hidden"], "nothing was started for it");
	assert.ok(!toolAllowed("browser_show", {}) && !toolAllowed("browser_show", { tools: "all" }) && toolAllowed("browser_show", { window: true }) && !toolAllowed("browser_show", { window: true, block: ["browser_show"] }));
	assert.ok(!toolAllowed("browser_cookie_list", { tools: "all" }) && toolAllowed("browser_cookie_list", { tools: "all", caps: "storage" }), "cookie tools only where the owner asked for them");

	const b = await fakeBrowser(t, { window: true }, "no-screen");
	await b.call("browser_navigate", { url: "https://example.com/" });
	const refused = await b.call("browser_show");
	assert.ok(refused.failed && refused.text.includes("A window could not be opened on this computer") && refused.text.includes("Missing X server") && refused.text.includes("- Page URL: https://example.com/\n- window: hidden"), refused.text);
	assert.match((await b.call("browser_hide")).text, /has no window/);

	const shot = await b.call("browser_take_screenshot");
	assert.ok(!shot.failed && shot.text.includes("shot 2"), shot.text);
	assert.equal(b.log().filter((l) => l === "browser_take_screenshot").length, 2);
});

test("browser: the bundled server is configured like the others and marks sessions as tainted", async () => {
	const h = await harness({ pine: { mcp: { browser: { pine: "browser", options: { headed: true } } } }, agents: { main: {} }, start: false });
	const cfg = loadConfig(h.home);
	const server = effectiveMcp(cfg, cfg.agents.main).browser;
	assert.equal(mcpTaints(server), true);
	const pi = toPiMcp("browser", server) as any;
	assert.ok(pi.args[0].endsWith("mcp/browser.ts"));
	assert.deepEqual(JSON.parse(pi.env.PINE_MCP_OPTIONS), { headed: true });
	// What pine adds for a conversation wins over the options: a run started from outside gets no window and no local addresses.
	const set = { ...server, options: { window: true, localFile: "/tmp/anything" } };
	assert.deepEqual(JSON.parse((toPiMcp("browser", set, browserSession(false, "/home/allowed.json")) as any).env.PINE_MCP_OPTIONS), { window: false, localFile: null });
	assert.deepEqual(JSON.parse((toPiMcp("browser", set, browserSession(true, "/home/allowed.json")) as any).env.PINE_MCP_OPTIONS), { window: true, localFile: "/home/allowed.json" });
	await h.close();
});

test("browser: an agent whose browser is on the owner's screen is told that the owner uses it too", async () => {
	// Started with a window by the configuration; no page is opened, so no browser starts here.
	const h = await harness({ pine: { mcp: { browser: { pine: "browser", options: { headed: true } } } }, agents: { main: {} } });
	await h.pine.agents.run({ agent: "main", prompt: "hello", trust: "owner" });
	const note = notesOf(h.mock.state.requests.at(-1)).join("\n");
	assert.ok(note.includes("Your browser is a window on your owner's screen right now, and they use it too.") && note.includes("not with a web search") && note.includes("browser_snapshot first"), note);
	// A run from outside has no window to share.
	await h.pine.agents.run({ agent: "main", prompt: "an event", trust: "untrusted" });
	assert.ok(!notesOf(h.mock.state.requests.at(-1)).join("\n").includes("Your browser is a window"));
	await h.close();

	// Without a window there is nothing to say.
	const hidden = await harness({ pine: { mcp: { browser: { pine: "browser" } } }, agents: { main: {} } });
	await hidden.pine.agents.run({ agent: "main", prompt: "hello", trust: "owner" });
	assert.ok(!notesOf(hidden.mock.state.requests.at(-1)).join("\n").includes("Your browser is a window"));
	await hidden.close();
});

// Starts a real browser and uses the network: only with PINE_LIVE=1.
test("live: an agent opens a page in the bundled browser", { skip: process.env.PINE_LIVE !== "1", timeout: 60_000 }, async (t) => {
	const dev = http.createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<title>Dev server</title><h1>DEV-SERVER-PAGE</h1>"));
	await new Promise<void>((r) => dev.listen(0, "127.0.0.1", r));
	t.after(() => dev.close());
	const devUrl = `http://127.0.0.1:${(dev.address() as net.AddressInfo).port}/`;
	const h = await harness({ pine: { mcp: { browser: { pine: "browser" } } }, agents: { main: {} } });
	// The owner allows the dev server and nothing else.
	const asked: any[] = [];
	h.pine.bus.subscribe("approval/requested", (e) => {
		asked.push(e.payload);
		h.pine.approvals.decide((e.payload as any).id, (e.payload as any).summary.includes(devUrl), "test");
	});
	const r = await h.pine.agents.run({
		agent: "main",
		prompt: mockMsg([{ tools: [{ name: "mcp__browser__browser_navigate", args: { url: "https://example.com" } }, { name: "mcp__browser__browser_navigate", args: { url: `http://127.0.0.1:${h.mock.port}/v1/models` } }, { name: "mcp__browser__browser_run_code_unsafe", args: { code: "1" } }, { name: "mcp__browser__browser_navigate", args: { url: devUrl } }] }]),
		trust: "owner",
	});
	assert.equal(r.status, "done");
	const [page, local, code, allowed] = h.toolResults();
	assert.ok(page.includes("Page Title: Example Domain") && page.includes('link "Learn more"'), page);
	assert.ok(/not approved/.test(local) && !local.includes("mock-model"), local);
	assert.match(code, /not found|not available/);
	assert.ok(allowed.includes("DEV-SERVER-PAGE"), allowed);
	assert.equal(asked.length, 2);
	assert.ok(/mcp__browser__browser_navigate returned outside content/.test(h.pine.agents.status().sessions[0].tainted ?? ""));
	await h.close();
});
