import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ALWAYS_BLOCKED, CORE_TOOLS, inlineFiles, startGuardProxy, toolAllowed, vet } from "../mcp/browser.ts";
import { effectiveMcp, loadConfig, mcpTaints, toPiMcp } from "../src/config.ts";
import { harness, mockMsg } from "./support/harness.ts";

test("browser: tools that run code or read local files are never offered", () => {
	for (const name of ALWAYS_BLOCKED) for (const tools of ["core", "all", [name]] as const) assert.equal(toolAllowed(name, { tools: tools as any }), false, `${name} with ${tools}`);
	assert.ok(ALWAYS_BLOCKED.includes("browser_run_code_unsafe") && ALWAYS_BLOCKED.includes("browser_file_upload"));
	assert.ok(toolAllowed("browser_navigate", {}) && toolAllowed("browser_snapshot", {}) && CORE_TOOLS.includes("browser_click"));
	assert.equal(toolAllowed("browser_evaluate", {}), false, "not in the core set");
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

test("browser: the bundled server is configured like the others and marks sessions as tainted", async () => {
	const h = await harness({ pine: { mcp: { browser: { pine: "browser", options: { headed: true } } } }, agents: { main: {} }, start: false });
	const cfg = loadConfig(h.home);
	const server = effectiveMcp(cfg, cfg.agents.main).browser;
	assert.equal(mcpTaints(server), true);
	const pi = toPiMcp("browser", server) as any;
	assert.ok(pi.args[0].endsWith("mcp/browser.ts"));
	assert.deepEqual(JSON.parse(pi.env.PINE_MCP_OPTIONS), { headed: true });
	await h.close();
});

// Starts a real browser and uses the network: only with PINE_LIVE=1.
test("live: an agent opens a page in the bundled browser", { skip: process.env.PINE_LIVE !== "1", timeout: 60_000 }, async () => {
	const h = await harness({ pine: { mcp: { browser: { pine: "browser" } } }, agents: { main: {} } });
	const r = await h.pine.agents.run({
		agent: "main",
		prompt: mockMsg([{ tools: [{ name: "mcp__browser__browser_navigate", args: { url: "https://example.com" } }, { name: "mcp__browser__browser_navigate", args: { url: `http://127.0.0.1:${h.mock.port}/v1/models` } }, { name: "mcp__browser__browser_run_code_unsafe", args: { code: "1" } }] }]),
		trust: "owner",
	});
	assert.equal(r.status, "done");
	const [page, local, code] = h.toolResults();
	assert.ok(page.includes("Page Title: Example Domain") && page.includes('link "Learn more"'), page);
	assert.ok(/403|refused|private address/.test(local) && !local.includes("mock-model"), local);
	assert.match(code, /not found|not available/);
	assert.ok(/mcp__browser__browser_navigate returned outside content/.test(h.pine.agents.status().sessions[0].tainted ?? ""));
	await h.close();
});
