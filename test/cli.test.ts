import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { harness, until } from "./support/harness.ts";

const run = promisify(execFile);
// "pine init" also fetches the browser, which a test must not do.
process.env.PINE_SKIP_DOWNLOADS = "1";
const CLI = path.resolve(import.meta.dirname, "../src/cli.ts");
const freePort = () =>
	new Promise<number>((resolve) => {
		const s = net.createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address() as net.AddressInfo;
			s.close(() => resolve(port));
		});
	});

test("pine init creates a private home that passes pine check", async (t) => {
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pine-init-")), "home");
	t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
	const init = await run(process.execPath, [CLI, "init", dir]);
	assert.match(init.stdout, /pine\.json/);
	assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
	for (const f of ["pine.json", "models.json", ".env"]) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
	const check = await run(process.execPath, [CLI, "check", "--home", dir]);
	for (const part of ["agent main (main)", "mcp        web, browser", "model      dev/claude-haiku", "No security notes."]) assert.ok(check.stdout.includes(part), `${part}\n${check.stdout}`);
	assert.equal(fs.readdirSync(path.join(dir, "agents")).join(), "main", "the example starts with one agent");
	const again = await run(process.execPath, [CLI, "init", dir]);
	assert.match(again.stdout, /nothing changed/);
});

test("the command line drives a running daemon", async (t) => {
	const port = await freePort();
	const h = await harness({ pine: { http: { port }, logLevel: "warn" }, agents: { main: {} }, start: false });
	const daemon = spawn(process.execPath, [CLI, "start", "--home", h.home], { stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	daemon.stderr.on("data", (d) => (stderr += d));
	t.after(() => daemon.kill("SIGKILL"));
	const pine = async (...args: string[]) => (await run(process.execPath, [CLI, ...args, "--home", h.home])).stdout.trim();
	await until(async () => (await fetch(`http://127.0.0.1:${port}/health`).catch(() => undefined))?.ok, 8000, `the daemon to listen (${stderr})`);

	assert.equal(await pine("send", "main", "hello", "from", "the", "shell"), "ECHO[hello from the shell]");
	assert.match(await pine("send", "main", "queued", "--no-wait", "--session", "side"), /task #2 queued/);
	assert.match(await pine("emit", "test/topic", '{"n":1}'), /event #\d+/);
	assert.match(await pine("events", "--topic", "test/#"), /test\/topic\s+owner\s+api\s+\{"n":1\}/);
	assert.deepEqual(JSON.parse(await pine("agents")).map((a: any) => a.id), ["main"]);
	assert.equal(JSON.parse(await pine("status")).limiter.max, 2);
	await until(async () => /#2 .* done .* main\/side/.test(await pine("tasks")), 5000, "task 2 in the task list");
	assert.equal(JSON.parse(await pine("task", "1")).result, "ECHO[hello from the shell]");
	assert.equal(await pine("approvals"), "nothing waits for approval");
	assert.deepEqual(JSON.parse(await pine("reset", "main")), { reset: true });
	await assert.rejects(() => pine("send", "nobody", "x"), /unknown agent "nobody"/);

	const stopped = new Promise((r) => daemon.once("exit", r));
	daemon.kill("SIGTERM");
	assert.equal(await stopped, 0, "SIGTERM shuts the daemon down cleanly");
	await assert.rejects(() => pine("status"), /no daemon answers/);
	await h.close();
});

test("pine login stores a provider key privately and makes its models available", async (t) => {
	const { login } = await import("../src/login.ts");
	const { loadConfig } = await import("../src/config.ts");
	const h = await harness({ agents: { main: {} }, start: false });
	const said: string[] = [];
	const asked: string[] = [];
	const models = await login(loadConfig(h.home), "opencode-go", "api_key", {
		text: async (m) => (asked.push(m), ""),
		secret: async (m) => (asked.push(m), "sk-test-not-a-real-key-123456"),
		say: (l) => void said.push(l),
		open: () => {},
	});
	const file = path.join(h.home, "auth.json");
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.ok(JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8"))["opencode-go"]).includes("sk-test-not-a-real-key-123456"));
	assert.ok(models.includes("opencode-go/deepseek-v4.1-flash"), models.slice(0, 5).join(","));
	assert.ok(said.join("\n").includes("Stored the key for opencode-go") && !said.join("\n").includes("sk-test"), "the key is never echoed");
	await assert.rejects(() => login(loadConfig(h.home), "no-such-provider"), /unknown provider/);
	await h.close();
});

test("the key prompt stays visible, says the input is hidden, and never echoes it", async () => {
	const { readSecret } = await import("../src/login.ts");
	const { PassThrough } = await import("node:stream");
	const input = new PassThrough();
	const output = new PassThrough();
	let shown = "";
	output.on("data", (d) => (shown += d));
	const pending = readSecret("Enter OpenCode API key", input, output);
	input.write("sk-abX");
	input.write("\x7f"); // backspace
	input.write("c-123\r");
	assert.equal(await pending, "sk-abc-123");
	assert.equal(shown, "Enter OpenCode API key (input is hidden; paste or type it, then press enter): \n");
	const cancelled = readSecret("Key", input, output);
	input.write("abc\x03");
	await assert.rejects(cancelled, /cancelled/);
});

test("pine update knows how pine was installed and which version is newer; pine version says both", async () => {
	const { installKind, newer } = await import("../src/update.ts");
	const root = path.resolve(import.meta.dirname, "..");
	// A git clone that runs its sources is a checkout, wherever npm keeps its global packages.
	assert.equal(installKind(root, "/usr/local/lib/node_modules"), "checkout");
	// Inside npm's global folder it is a global install; anywhere else a dependency of some project.
	const global = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pine-global-")));
	const pkg = path.join(global, "@pmndrs", "pine");
	fs.mkdirSync(path.join(pkg, "src"), { recursive: true });
	fs.writeFileSync(path.join(pkg, "src", "cli.js"), "");
	assert.equal(installKind(pkg, global), "global");
	assert.equal(installKind(pkg, path.join(global, "elsewhere")), "local");
	assert.equal(installKind(pkg, undefined), "local");
	fs.rmSync(global, { recursive: true, force: true });

	assert.deepEqual([newer("0.1.1", "0.1.0"), newer("0.10.0", "0.9.9"), newer("1.0.0", "0.99.99"), newer("0.1.0", "0.1.0"), newer("0.1.0", "0.2.0")], [true, true, true, false, false]);

	const version = await run(process.execPath, [CLI, "version"]);
	assert.match(version.stdout, /^pine \d+\.\d+\.\d+ \(checkout in /);
});
