import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import { available, BUILDING, buildHelper, computer, grantText, NO_COMPILER, type Node, outline, parseKeys, pickWindow, PICTURE_TOOLS, TOOLS, toolsOffered, toScreen, unavailable } from "../mcp/computer.ts";
import { classify } from "../src/actions.ts";
import { APP_LOOK, appTarget, computerSession } from "../src/computer.ts";
import { effectiveMcp, loadConfig, mcpTaints, toPiMcp } from "../src/config.ts";
import { startClaudeModel } from "../src/dev/claude-model.ts";
import { rootsFor } from "../src/security.ts";
import { harness, mockMsg, until } from "./support/harness.ts";

// ---- what needs no helper ------------------------------------------------------------------------

test("computer: a window becomes an outline a small model can read, with a reference on what can be used", () => {
	const window: Node = {
		role: "AXWindow",
		title: "Untitled",
		children: [
			{ role: "AXStaticText", value: "Untitled" },
			{ role: "AXButton", subrole: "AXCloseButton", ref: "e1", press: true },
			{
				role: "AXToolbar",
				children: [
					{ role: "AXGroup", children: [{ role: "AXButton", title: "Bold", ref: "e2", press: true, children: [{ role: "AXStaticText", value: "Bold" }] }] },
					{ role: "AXPopUpButton", desc: "Font", value: "Helvetica", ref: "e3", press: true },
					{ role: "AXCheckBox", title: "Wrap", value: 1, ref: "e4", press: true },
					{ role: "AXButton", title: "Send", ref: "e5", press: true, disabled: true },
				],
			},
			{ role: "AXScrollArea", children: [{ role: "AXTextArea", ref: "e6", edit: true, focused: true, value: "Dear Ada,\nthe figures are attached.\n", more: 120 }] },
			{ role: "AXTextField", subrole: "AXSearchField", ref: "e7", edit: true, placeholder: "Search" },
			{ role: "AXGroup", children: [{ role: "AXGroup" }] },
			{ role: "AXTable", children: [{ role: "AXRow", ref: "e8", selected: true, children: [{ role: "AXCell", children: [{ role: "AXStaticText", value: "notes.txt" }] }, { role: "AXCell", children: [{ role: "AXStaticText", value: "4 KB" }] }] }] },
		],
	};
	const text = outline(window);
	assert.equal(
		text,
		[
			"- close button [ref=e1]",
			"- toolbar",
			'  - button "Bold" [ref=e2]',
			'  - pop-up button "Font" [ref=e3]: "Helvetica"',
			'  - checkbox "Wrap" [ref=e4] (checked)',
			'  - button "Send" [ref=e5] (disabled)',
			"- text area [ref=e6] (focused), holds:",
			"    Dear Ada,",
			"    the figures are attached.",
			"    [120 more characters are not shown]",
			'- search field [ref=e7] (empty, shows "Search")',
			"- row [ref=e8] (selected)",
			'  - text "notes.txt"',
			'  - text "4 KB"',
		].join("\n"),
	);
	assert.ok(!text.includes("Untitled"), "the title bar says what the heading of the result says already");
	const long = outline({ role: "AXWindow", children: Array.from({ length: 400 }, (_, i) => ({ role: "AXButton", title: `Button number ${i}`, ref: `e${i}`, press: true })) }, 2000);
	assert.ok(long.length < 2300 && /\[cut: 3\d\d more lines\./.test(long), long.slice(-200));
	assert.equal(outline({ role: "AXWindow" }), "(the window is empty)");
});

test("computer: keys and shortcuts are read the way people write them", () => {
	assert.deepEqual(parseKeys("cmd+s"), [{ key: "s", mods: ["cmd"] }]);
	assert.deepEqual(parseKeys("Command+Shift+Z"), [{ key: "z", mods: ["cmd", "shift"] }]);
	assert.deepEqual(parseKeys("cmd+a delete, Enter"), [{ key: "a", mods: ["cmd"] }, { key: "delete", mods: [] }, { key: "return", mods: [] }]);
	assert.deepEqual(parseKeys("ctrl+option+Page_Down esc"), [{ key: "pagedown", mods: ["ctrl", "alt"] }, { key: "escape", mods: [] }]);
	assert.deepEqual(parseKeys("cmd++ ctrl+- +"), [{ key: "+", mods: ["cmd"] }, { key: "-", mods: ["ctrl"] }, { key: "+", mods: [] }]);
	assert.throws(() => parseKeys("hello"), /"hello" is not a key\..*To type text, use app_type/);
	assert.throws(() => parseKeys("hyper+s"), /"hyper" in "hyper\+s" is not a modifier key/);
	assert.throws(() => parseKeys(""), /Say which key/);
});

test("computer: a position in a picture becomes the right point on the screen", () => {
	// A Retina window, 800 by 600 points at 100, 50, sent as a picture of 1280 by 960 pixels.
	const retina = { width: 1280, height: 960, x: 100, y: 50, w: 800, h: 600 };
	assert.deepEqual(toScreen(retina, 0, 0), { x: 100.3, y: 50.3 });
	assert.deepEqual(toScreen(retina, 640, 480), { x: 500.3, y: 350.3 });
	assert.deepEqual(toScreen(retina, 1279, 959), { x: 899.7, y: 649.7 }, "the last pixel is still inside the window");
	// A second display to the left of the main one and above it: its points are negative.
	const second = { width: 1280, height: 800, x: -1920, y: -200, w: 1920, h: 1200 };
	assert.deepEqual(toScreen(second, 0, 0), { x: -1919.2, y: -199.2 });
	assert.deepEqual(toScreen(second, 640, 400), { x: -959.2, y: 400.8 });
	// A picture that is larger than what it shows (never made here, but a ratio is a ratio).
	assert.deepEqual(toScreen({ width: 200, height: 100, x: 0, y: 0, w: 100, h: 50 }, 100, 50), { x: 50.3, y: 25.3 });
});

test("computer: a window is found by its number or by a part of its title", () => {
	const windows = [{ index: 1, ref: "w1", title: "Untitled" }, { index: 2, ref: "w2", title: "Letter to Ada.rtf" }, { index: 3, ref: "w3", title: "ada", minimized: true }];
	assert.equal(pickWindow(windows, undefined), undefined, "nothing asked for: the front one");
	assert.equal(pickWindow(windows, "")?.ref, undefined);
	assert.equal(pickWindow(windows, 2)?.ref, "w2");
	assert.equal(pickWindow(windows, "2")?.ref, "w2");
	assert.equal(pickWindow(windows, "letter")?.ref, "w2");
	assert.equal(pickWindow(windows, "Ada")?.ref, "w3", "the whole title before a part of one");
	assert.throws(() => pickWindow(windows, "invoice"), /There is no window "invoice"\. The windows are: 1 "Untitled", 2 "Letter to Ada\.rtf", 3 "ada" \(minimized\)\./);
	assert.throws(() => pickWindow([], 1), /has no window open/);
});

test("computer: on a system that is not macOS nothing is offered, and a call is answered in plain words", async (t) => {
	for (const system of ["linux", "win32", "freebsd"]) {
		assert.deepEqual(toolsOffered({}, system), [], system);
		assert.equal(available({}, system), false);
	}
	assert.match(unavailable("linux"), /^App control is not available on this system \(Linux\)\. It works on macOS only\./);
	assert.equal(computerSession({ owner: true, level: "auto", dataDir: "/home/x/data", platform: "linux" }), undefined, "the daemon does not start the server there");
	assert.equal(toolsOffered({}, "darwin").length, TOOLS.length);
	// A stand-in for the helper runs anywhere: that is how the rest of this file runs on Linux.
	assert.ok(available({ helper: "/x" }, "linux") && computerSession({ owner: true, level: "auto", dataDir: "/d", platform: "linux", standIn: true }));

	// The server as a process. Where it has no helper to build, this is the whole of it.
	if (process.platform === "darwin") return;
	const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../mcp/computer.ts")], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, PINE_MCP_OPTIONS: "{}" } });
	t.after(() => child.kill());
	const lines: any[] = [];
	child.stdout.on("data", (d) => lines.push(...String(d).split("\n").filter(Boolean).map((l) => JSON.parse(l))));
	for (const [id, method, params] of [[1, "initialize", {}], [2, "tools/list", {}], [3, "tools/call", { name: "app_click", arguments: { app: "TextEdit", x: 1, y: 1 } }]] as const) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	await until(() => lines.length === 3, 5000, "the server's answers");
	assert.match(lines[0].result.instructions, /not available on this system/);
	assert.deepEqual(lines[1].result.tools, []);
	assert.ok(lines[2].result.isError && /App control is not available on this system \(Linux\)/.test(lines[2].result.content[0].text), JSON.stringify(lines[2]));
});

test("computer: a model that cannot see gets no tools that need eyes; the owner can leave tools out", () => {
	const names = (o: Record<string, unknown>) => toolsOffered(o, "darwin").map((t) => t.name);
	assert.deepEqual(names({}), ["apps", "app_open", "app_snapshot", "app_press", "app_set_text", "app_menu", "app_screenshot", "app_click", "app_drag", "app_scroll", "app_type", "app_key"]);
	assert.deepEqual(names({ images: false }), ["apps", "app_open", "app_snapshot", "app_press", "app_set_text", "app_menu", "app_type", "app_key"]);
	assert.ok(PICTURE_TOOLS.every((t) => !names({ images: false }).includes(t)));
	assert.deepEqual(names({ block: ["app_type", "app_key", "app_drag"] }).length, 9);
	// What only looks says so, which is what lets it through unasked in manual mode.
	assert.deepEqual(TOOLS.filter((t) => (t as any).annotations?.readOnlyHint).map((t) => t.name), APP_LOOK);
	for (const t of TOOLS) assert.ok(t.description.length < 330, `${t.name}: a description a small model reads every turn stays short`);
});

test("computer: the helper is built once, and a Mac without the compiler is told what to install", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-computer-build-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const source = path.join(dir, "helper.swift");
	fs.writeFileSync(source, "print(1)\n");
	const out = path.join(dir, "bin");
	const ran: string[] = [];
	const tools = (code: number, compile: (target: string) => { code: number; stderr: string }) => async (file: string, args: string[]) => {
		ran.push(path.basename(file));
		if (file.endsWith("xcode-select")) return { code, stdout: code ? "" : `${dir}\n`, stderr: code ? "xcode-select: error: unable to get active developer directory" : "" };
		return { stdout: "", ...compile(args[args.indexOf("-o") + 1]) };
	};
	const works = (target: string) => (fs.writeFileSync(target, "#!/bin/sh\n"), { code: 0, stderr: "" });

	// No developer tools: no compiler is started (it would only open a window), and the message says what to type.
	await assert.rejects(() => buildHelper(out, source, tools(2, works)), (e: Error) => e.message === NO_COMPILER && /xcode-select --install/.test(e.message) && !/at .*\(.*:\d+/.test(e.message));
	assert.deepEqual(ran, ["xcode-select"]);
	// A compiler that fails: its reason, not a stack trace.
	await assert.rejects(() => buildHelper(out, source, tools(0, () => ({ code: 1, stderr: "helper.swift:1:1: error: no such module 'AppKit'\nnote: something\n" }))), /pine could not build its helper for app control \(helper\.swift:1:1: error: no such module 'AppKit'\)\. Tell your owner/);
	assert.deepEqual(fs.existsSync(out) ? fs.readdirSync(out) : [], [], "nothing half-built is left");

	const built = await buildHelper(out, source, tools(0, works));
	assert.match(path.basename(built), /^pine-computer-[0-9a-f]{12}$/);
	ran.length = 0;
	assert.equal(await buildHelper(out, source, tools(0, works)), built);
	assert.deepEqual(ran, [], "the second time it is only found");
	// Another source (an update of pine) is another program, and the old one goes.
	fs.writeFileSync(source, "print(2)\n");
	const next = await buildHelper(out, source, tools(0, works));
	assert.notEqual(next, built);
	assert.deepEqual(fs.readdirSync(out), [path.basename(next)]);
});

test("computer: looking at an app is a look, acting in an allowed one is not asked about again", async () => {
	const h = await harness({ agents: { main: {} }, start: false });
	const cfg = loadConfig(h.home);
	const roots = rootsFor(cfg, cfg.agents.main);
	const base = { roots, cwd: roots.workspace, shellReaches: true, sends: false, canSendOut: () => true, reachable: () => false };
	const cls = (app: { look: boolean }, mcp = { readOnly: false, watched: false }) => classify("mcp__computer__x", {}, { ...base, app, mcp } as any).cls;
	assert.equal(cls({ look: true }), "look");
	assert.equal(cls({ look: false }), "local", "local is never asked about, whatever the conversation has read");
	assert.equal(cls({ look: false }, { readOnly: false, watched: true }), "send", 'an owner who sets "approve" on the server gets every action looked at');
	assert.equal(cls({ look: true }, { readOnly: false, watched: true }), "look");
	await h.close();
});

test("computer: which app a call is about, and who gets the server at all", () => {
	assert.deepEqual(appTarget("app_click", { app: " TextEdit ", x: 1, y: 2 }), { key: "app:textedit", name: "TextEdit" });
	assert.equal(appTarget("app_type", { app: "TEXTEDIT" })?.key, "app:textedit", "one yes for one app, however it is spelled");
	assert.equal(appTarget("apps", {}), undefined, "listing what runs is not asked about");
	assert.deepEqual(appTarget("app_screenshot", {}), { key: "screen", name: "the whole screen" });
	assert.equal(appTarget("app_screenshot", { app: "Mail" })?.key, "app:mail");
	assert.equal(appTarget("app_click", { x: 1, y: 2 }), undefined, "no app named: the server refuses the call");
	assert.equal(appTarget("app_press", { app: 7 }), undefined);

	const on = { owner: true, level: "auto" as const, dataDir: "/home/pine/data", platform: "darwin" };
	assert.deepEqual(computerSession(on), { helperDir: "/home/pine/data/computer" });
	assert.equal(computerSession({ ...on, owner: false }), undefined, "never a run started from outside");
	assert.equal(computerSession({ ...on, level: "safe" }), undefined, "never an agent that works in its sandbox");
});

// ---- the server's logic, on a stand-in for the helper --------------------------------------------

// Two apps and the terminal pine runs in. TextEdit's window is 640 by 400 points at 100, 50; a
// picture of it is 1280 by 800 pixels. Everything right of x = 1000 on the screen belongs to Notes.
const FAKE_HELPER = `
import fs from "node:fs";
import readline from "node:readline";
const [log, ...flags] = process.argv.slice(2);
const note = (line) => fs.appendFileSync(log, line + "\\n");
note("start");
const apps = { textedit: { name: "TextEdit", pid: 100, bundle: "com.apple.TextEdit" }, notes: { name: "Notes", pid: 200, bundle: "com.apple.Notes" }, terminal: { name: "Terminal", pid: 300, bundle: "com.apple.Terminal", host: !flags.includes("no-host") } };
const windows = { 100: [{ index: 1, ref: "w1", title: "Untitled", main: true, x: 100, y: 50, w: 640, h: 400 }, { index: 2, ref: "w2", title: "Letter.rtf", x: 300, y: 300, w: 400, h: 300 }], 200: [{ index: 1, ref: "w3", title: "Notes", x: 1000, y: 0, w: 800, h: 600 }], 300: [{ index: 1, ref: "w4", title: "pine", x: 0, y: 700, w: 800, h: 400 }], 400: [] };
const refs = { e2: 100, e3: 100, e9: 100, e20: 200, e30: 300, m11: 100, m12: 100, m14: 100 };
let text = "Hello";
let front = 0, moved = false;
const granted = (kind) => !flags.includes("no-" + kind) || fs.existsSync(log + ".granted");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const m = JSON.parse(line);
	const ok = (r = {}) => send({ id: m.id, ok: true, ...r });
	const fail = (code, error = "") => send({ id: m.id, ok: false, code, error });
	const info = (a) => ({ host: false, hidden: false, ...a, front: front === a.pid });
	const input = ["at", "click", "drag", "scroll", "type", "key"].includes(m.cmd);
	if ((input || ["windows", "tree", "menu"].includes(m.cmd)) && !granted("access")) return fail("accessibility");
	switch (m.cmd) {
		case "status":
			if (m.ask) note("status ask=" + m.ask);
			return ok({ accessibility: granted("access"), screen: granted("screen"), host: flags.includes("no-host") ? undefined : info(apps.terminal) });
		case "apps":
			return ok({ accessibility: granted("access"), apps: Object.values(apps).map((a) => ({ ...info(a), ...(granted("access") ? { windows: windows[a.pid] } : {}) })), displays: [{ index: 1, x: 0, y: 0, w: 2560, h: 1440, main: true }, { index: 2, x: -1920, y: 0, w: 1920, h: 1080 }] });
		case "find": {
			const a = apps[String(m.app).toLowerCase()];
			return ok(a ? { running: true, ...info(a) } : { running: false });
		}
		case "open": {
			const key = String(m.app).toLowerCase();
			if (apps[key]) return ok({ ...info(apps[key]), launched: false });
			if (key !== "calculator") return fail("not_found", "Unable to find application named '" + m.app + "'");
			apps.calculator = { name: "Calculator", pid: 400, bundle: "com.apple.calculator" };
			note("open " + m.app);
			return ok({ ...info(apps.calculator), launched: true });
		}
		case "activate":
			note("activate " + m.pid + (m.ref ? " " + m.ref : ""));
			if (flags.includes("stuck")) return ok({ front: false });
			front = m.pid;
			return ok({ front: true });
		case "windows":
			return ok({ windows: windows[m.pid] ?? [] });
		case "frame": {
			const w = Object.values(windows).flat().find((x) => x.ref === m.ref);
			if (!w || flags.includes("closed")) return fail("gone");
			return ok(moved ? { x: w.x + 500, y: w.y + 100, w: w.w, h: w.h } : { x: w.x, y: w.y, w: w.w, h: w.h });
		}
		case "tree": {
			const all = windows[m.pid] ?? [];
			const w = all[(m.window ?? 1) - 1];
			if (!w) return ok({ windows: all });
			const root = m.pid === 100
				? { role: "AXWindow", title: w.title, children: [{ role: "AXButton", title: "Bold", ref: "e3", press: true }, { role: "AXImage", desc: "Seal", ref: "e9", press: true }, { role: "AXScrollArea", children: [{ role: "AXTextArea", ref: "e2", edit: true, value: text }] }] }
				: { role: "AXWindow", title: w.title, children: [{ role: "AXButton", title: m.pid === 300 ? "Allow" : "New Note", ref: m.pid === 300 ? "e30" : "e20", press: true }] };
			return ok({ windows: all, window: w, root, cut: false });
		}
		case "whose":
			if (!refs[m.ref]) return fail("gone");
			return ok({ pid: refs[m.ref], role: m.ref.startsWith("m") ? "AXMenuItem" : m.ref === "e2" ? "AXTextArea" : m.ref === "e9" ? "AXImage" : "AXButton", title: { e3: "Bold", e9: "Seal", e20: "New Note", e30: "Allow" }[m.ref] });
		case "press":
			if (!refs[m.ref]) return fail("gone");
			if (m.ref === "e9") return ok({ done: false, x: 400, y: 200 });
			note("press " + m.ref);
			return ok({ done: true, ...(m.ref === "m12" ? { unsure: true } : {}) });
		case "set":
			if (flags.includes("typed-only")) return ok({ done: false, x: 400, y: 250 });
			note("set " + m.ref + " " + JSON.stringify(m.text));
			text = m.text;
			return ok({ done: true });
		case "menu":
			if (!m.ref) return ok({ items: [{ ref: "m0", title: "Apple", submenu: true }, { ref: "m1", title: "File", submenu: true }, { ref: "m2", title: "Format", submenu: true }] });
			if (m.ref === "m1") return ok({ items: [{ ref: "m11", title: "New", shortcut: "cmd+n" }, { ref: "m12", title: "Save…", shortcut: "cmd+s" }, { ref: "m13", title: "Open Recent", submenu: true }, { ref: "m14", title: "Revert To", disabled: true }] });
			if (m.ref === "m13") return ok({ items: [{ ref: "m131", title: "Letter.rtf" }] });
			return ok({ items: [{ ref: "m21", title: "Wrap to Page", mark: "✓" }] });
		case "at":
			return ok(m.x < 1000 ? { pid: 100, name: "TextEdit", role: "AXButton", title: "Bold", wpid: 100, wname: "TextEdit" } : { pid: 200, name: "Notes", role: "AXGroup", wpid: 200, wname: "Notes" });
		case "click":
			note("click " + m.x + "," + m.y + " " + m.button + " x" + m.count);
			return ok();
		case "drag":
			note("drag " + m.x + "," + m.y + " to " + m.x2 + "," + m.y2);
			return ok();
		case "scroll":
			note("scroll " + m.x + "," + m.y + " dx=" + m.dx + " dy=" + m.dy);
			return ok();
		case "type":
			note("type " + JSON.stringify(m.text) + " to=" + m.pid + " front=" + front);
			return ok();
		case "key":
			note("key " + [...m.mods, m.key].join("+") + " to=" + m.pid + " front=" + front);
			return ok();
		case "shot": {
			if (!granted("screen")) return fail("screen");
			if (flags.includes("after-shot-moved") && (!flags.includes("menu-open") || front === m.pid)) moved = true;
			const file = m.dir + "/shot-" + Date.now() + ".jpg";
			const real = flags.find((f) => f.startsWith("picture="));
			if (real) fs.copyFileSync(real.slice(8), file);
			else fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
			note("shot " + (m.ref ?? "display " + (m.display ?? 1)) + " edge=" + m.edge);
			if (m.ref) {
				const w = Object.values(windows).flat().find((x) => x.ref === m.ref);
				// A menu hangs out of the window, to the left and below: the picture is of that part of the screen.
				if (flags.includes("menu-open")) return front === m.pid ? ok({ file, width: (w.w + 40) * 2, height: (w.h + 100) * 2, x: w.x - 40, y: w.y, w: w.w + 40, h: w.h + 100, wx: w.x, wy: w.y, more: true }) : fail("behind");
				return ok({ file, width: w.w * 2, height: w.h * 2, x: w.x, y: w.y, w: w.w, h: w.h, wx: w.x, wy: w.y });
			}
			return (m.display ?? 1) === 2 ? ok({ file, width: 1280, height: 720, x: -1920, y: 0, w: 1920, h: 1080, display: 2, displays: 2 }) : ok({ file, width: 1280, height: 720, x: 0, y: 0, w: 2560, h: 1440, display: 1, displays: 2 });
		}
	}
	fail("failed", "unknown command " + m.cmd);
});
`;

function fakeHelper(t: { after(fn: () => void): void }, o: Record<string, unknown> = {}, ...flags: string[]) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-computer-test-"));
	const script = path.join(dir, "helper.mjs");
	const log = path.join(dir, "log.txt");
	const scratch = path.join(dir, "scratch");
	fs.mkdirSync(scratch);
	fs.writeFileSync(script, FAKE_HELPER);
	fs.writeFileSync(log, "");
	const server = computer(o as any, { launch: async () => spawn(process.execPath, [script, log, ...flags], { stdio: ["pipe", "pipe", "pipe"] }), scratch });
	t.after(() => (server.close(), fs.rmSync(dir, { recursive: true, force: true })));
	const lines = () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
	return {
		script,
		log,
		scratch,
		lines,
		/** What reached the machine: everything but looking and bringing forward. */
		did: () => lines().filter((l) => !/^(start|activate|shot|status)/.test(l)),
		call: async (name: string, args: Record<string, unknown> = {}) => {
			const r = await server.call(name, args);
			return typeof r === "string" ? r : r.map((p) => (p.type === "text" ? p.text : `[${p.mimeType} ${p.data}]`)).join("\n");
		},
		fails: async (name: string, args: Record<string, unknown> = {}) => {
			try {
				await server.call(name, args);
			} catch (e) {
				return (e as Error).message;
			}
			throw new Error(`${name} ${JSON.stringify(args)} was expected to be refused`);
		},
		server,
	};
}

test("computer: by outline. An app's window is read as text and its controls are used by reference", async (t) => {
	const c = fakeHelper(t);
	const apps = await c.call("apps");
	assert.equal(apps, 'Running apps:\n- TextEdit: windows 1 "Untitled", 2 "Letter.rtf"\n- Notes: window 1 "Notes"\n- Terminal (pine runs in it): window 1 "pine"\n\nScreens: 1 (2560 by 1440, main), 2 (1920 by 1080)');

	const snap = await c.call("app_snapshot", { app: "textedit" });
	assert.ok(snap.startsWith('TextEdit, window 1 "Untitled". Other windows: 2 "Letter.rtf".\nControls with [ref=...] can be used'), snap);
	assert.ok(snap.endsWith('- button "Bold" [ref=e3]\n- image "Seal" [ref=e9]\n- text area [ref=e2]: "Hello"'), snap);
	assert.match(await c.call("app_snapshot", { app: "TextEdit", window: "letter" }), /^TextEdit, window 2 "Letter\.rtf"\. Other windows: 1 "Untitled"\./);
	assert.match(await c.fails("app_snapshot", { app: "TextEdit", window: "invoice" }), /There is no window "invoice"/);

	assert.equal(await c.call("app_set_text", { app: "TextEdit", ref: "e2", text: "Dear Ada" }), 'The text area in TextEdit now holds "Dear Ada".');
	assert.match(await c.call("app_press", { app: "TextEdit", ref: "[ref=e3]" }), /^Pressed the button "Bold" in TextEdit\. Take a new app_snapshot/);
	assert.ok((await c.call("app_snapshot", { app: "TextEdit" })).endsWith('- text area [ref=e2]: "Dear Ada"'), "the result is read back");
	assert.deepEqual(c.did(), ['set e2 "Dear Ada"', "press e3"]);

	// A control with nothing to press by name is clicked in its middle, in the app, in front.
	assert.match(await c.call("app_press", { app: "TextEdit", ref: "e9" }), /^Clicked the image "Seal" in TextEdit\./);
	assert.deepEqual(c.lines().slice(-2), ["activate 100", "click 400,200 undefined xundefined"]);
	// A field that cannot be written into directly: clicked, everything selected, typed over.
	const typed = fakeHelper(t, {}, "typed-only");
	await typed.call("app_set_text", { app: "TextEdit", ref: "e2", text: "x" });
	assert.deepEqual(typed.did(), ["click 400,250 undefined xundefined", "key cmd+a to=100 front=100", 'type "x" to=100 front=100']);

	// A reference from before the window changed, or no reference at all.
	assert.match(await c.fails("app_press", { app: "TextEdit", ref: "e77" }), /That reference does not exist any more: the window has changed\. Take a new app_snapshot/);
	assert.match(await c.fails("app_press", { app: "TextEdit" }), /Say which control/);
	assert.match(await c.fails("app_snapshot", { app: "Pages" }), /Pages is not running\. Open it with app_open/);
	assert.match(await c.fails("app_snapshot", {}), /Say which app/);
	assert.match(await c.call("app_snapshot", { app: "Calculator" }).catch((e) => e.message), /Calculator is not running/);
	assert.match(await c.call("app_open", { app: "Calculator.app" }), /^Calculator was opened and is in front\. It has no window open\./);
	assert.match(await c.call("app_snapshot", { app: "Calculator" }), /^Calculator has no window open\..*app_menu/);
	assert.match(await c.call("app_open", { app: "notes" }), /^Notes was already running and is in front\. Its window: 1 "Notes"\./);
	assert.match(await c.fails("app_open", { app: "Nope" }), /No app called "Nope" was found on this Mac/);
	assert.match(await c.fails("app_open", { app: "/tmp/evil.app" }), /Give the app's name, for example Safari, not a path/);
});

test("computer: menus are listed level by level and an entry is picked by its path", async (t) => {
	const c = fakeHelper(t);
	assert.equal(await c.call("app_menu", { app: "TextEdit" }), 'The menus of TextEdit:\n- File >\n- Format >\nGive path to look into one or to pick an entry. Example: path "File > Save".');
	assert.equal(await c.call("app_menu", { app: "TextEdit", path: "file" }), '"file" in TextEdit holds:\n- New   cmd+n\n- Save…   cmd+s\n- Open Recent >\n- Revert To (not available now)');
	assert.equal(await c.call("app_menu", { app: "TextEdit", path: "Format" }), '"Format" in TextEdit holds:\n- Wrap to Page (ticked)');
	assert.deepEqual(c.did(), [], "looking into menus presses nothing");
	assert.equal(await c.call("app_menu", { app: "TextEdit", path: "File > New" }), 'Picked "File > New" in TextEdit.');
	assert.match(await c.call("app_menu", { app: "TextEdit", path: "File > Save..." }), /^Picked "File > Save\.\.\." in TextEdit\. The app has not answered yet, which often means a dialog has opened\./);
	assert.deepEqual(c.did(), ["press m11", "press m12"]);
	assert.match(await c.fails("app_menu", { app: "TextEdit", path: "File > Export" }), /There is no "Export" in "File"\. There is:\n- New/);
	assert.match(await c.fails("app_menu", { app: "TextEdit", path: "Edit > Copy" }), /There is no "Edit" in the menu bar of TextEdit/);
	assert.match(await c.fails("app_menu", { app: "TextEdit", path: "File > New > Blank" }), /"File > New" is an entry, not a menu/);
	assert.match(await c.fails("app_menu", { app: "TextEdit", path: "File > Revert To" }), /is not available right now/);
	assert.deepEqual(c.did(), ["press m11", "press m12"]);
});

test("computer: by picture. A position in the picture the model was given is clicked at the right point of the screen", async (t) => {
	const c = fakeHelper(t, { imageSize: 1000 });
	// No picture yet: there is nothing a position could mean.
	assert.match(await c.fails("app_click", { app: "TextEdit", x: 10, y: 10 }), /you have not taken one yet\. Take one with app_screenshot first/);

	const shot = await c.call("app_screenshot", { app: "TextEdit" });
	assert.ok(shot.startsWith('Picture of TextEdit, window 1 "Untitled": 1280 by 800 pixels. For app_click, app_drag and app_scroll, x and y are pixels in this picture, counted from its top left corner (x from 0 to 1279, y from 0 to 799).'), shot);
	assert.ok(shot.endsWith(`[image/jpeg ${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64")}]`), "the picture itself goes to the model");
	assert.deepEqual(fs.readdirSync(c.scratch), [], "and does not stay on the disk");
	assert.equal(c.lines().at(-1), "shot w1 edge=1000");

	// The window is 640 points wide at x = 100, the picture 1280 pixels: half a point per pixel.
	assert.match(await c.call("app_click", { app: "TextEdit", x: 640, y: 400 }), /^Clicked the button "Bold" at 640, 400 in TextEdit\./);
	assert.deepEqual(c.lines().slice(-2), ["activate 100 w1", "click 420.3,250.3 left x1"]);
	await c.call("app_click", { app: "TextEdit", x: 0, y: 0, count: 2 });
	assert.equal(c.lines().at(-1), "click 100.3,50.3 left x2");
	assert.match(await c.call("app_click", { app: "TextEdit", x: 1279, y: 799, button: "right" }), /^Right-clicked/);
	assert.equal(c.lines().at(-1), "click 739.8,449.8 right x1");
	await c.call("app_drag", { app: "TextEdit", x: 100, y: 100, to_x: 300, to_y: 500 });
	assert.equal(c.lines().at(-1), "drag 150.3,100.3 to 250.3,300.3");
	assert.match(await c.call("app_scroll", { app: "TextEdit", x: 640, y: 400, direction: "down" }), /^Scrolled down by 5 lines/);
	assert.equal(c.lines().at(-1), "scroll 420.3,250.3 dx=0 dy=-5");
	await c.call("app_scroll", { app: "TextEdit", x: 640, y: 400, direction: "left", amount: 2 });
	assert.equal(c.lines().at(-1), "scroll 420.3,250.3 dx=2 dy=0");

	// Outside the picture, or not numbers.
	assert.match(await c.fails("app_click", { app: "TextEdit", x: 1280, y: 10 }), /outside the last picture, which is 1280 by 800 pixels: x goes from 0 to 1279/);
	assert.match(await c.fails("app_click", { app: "TextEdit", x: "left", y: 10 }), /x and y must be numbers/);
	assert.match(await c.fails("app_scroll", { app: "TextEdit", x: 1, y: 1, direction: "sideways" }), /direction is up, down, left or right/);

	// The whole screen, and a second screen left of the main one.
	const screen = await c.call("app_screenshot");
	assert.match(screen, /^Picture of the whole screen 1 of 2: 1280 by 720 pixels\./);
	await c.call("app_click", { app: "TextEdit", x: 200, y: 100 });
	assert.equal(c.lines().at(-1), "click 401,201 left x1", "a pixel of this picture is two points of the screen");
	await c.call("app_screenshot", { screen: 2 });
	await c.call("app_click", { app: "TextEdit", x: 0, y: 0 });
	assert.equal(c.lines().at(-1), "click -1919.2,0.8 left x1");

	// A window that was moved after its picture was taken is clicked where it is now.
	const moved = fakeHelper(t, {}, "after-shot-moved");
	await moved.call("app_screenshot", { app: "TextEdit" });
	await moved.call("app_click", { app: "TextEdit", x: 640, y: 400 });
	assert.equal(moved.lines().at(-1), "click 920.3,350.3 left x1");

	// With a menu open the picture holds more than the window, and a window alone cannot be
	// photographed: the app comes to the front first, and positions count from where the picture starts.
	const menu = fakeHelper(t, {}, "menu-open");
	assert.match(await menu.call("app_screenshot", { app: "TextEdit" }), /^Picture of TextEdit, window 1 "Untitled", and what is open over it: 1360 by 1000 pixels\./);
	assert.deepEqual(menu.lines().slice(-3), ["shot w1 edge=1280", "activate 100 w1", "shot w1 edge=1280"]);
	await menu.call("app_click", { app: "TextEdit", x: 80, y: 0 });
	assert.equal(menu.lines().at(-1), "click 100.3,50.3 left x1", "40 points of menu lie left of the window");
	const both = fakeHelper(t, {}, "menu-open", "after-shot-moved");
	await both.call("app_screenshot", { app: "TextEdit" });
	await both.call("app_click", { app: "TextEdit", x: 80, y: 0 });
	assert.equal(both.lines().at(-1), "click 600.3,150.3 left x1");
	const closed = fakeHelper(t, {}, "closed");
	await closed.call("app_screenshot", { app: "TextEdit" });
	assert.match(await closed.fails("app_click", { app: "TextEdit", x: 640, y: 400 }), /The window in the last picture is gone\. Take a new app_screenshot/);
});

test("computer: an action lands in the app that was named, or not at all", async (t) => {
	const c = fakeHelper(t);
	// A reference of another app's control.
	assert.match(await c.fails("app_press", { app: "TextEdit", ref: "e20" }), /The reference e20 is not a control of TextEdit/);
	assert.match(await c.fails("app_set_text", { app: "Notes", ref: "e2", text: "x" }), /The reference e2 is not a control of Notes/);
	// A position in a picture of another app.
	await c.call("app_screenshot", { app: "TextEdit" });
	assert.match(await c.fails("app_click", { app: "Notes", x: 10, y: 10 }), /The last picture shows TextEdit, not Notes\. Take a picture of Notes first/);
	// A position on the whole screen where another app's window is.
	await c.call("app_screenshot");
	assert.match(await c.fails("app_click", { app: "TextEdit", x: 600, y: 100 }), /At that position is Notes, not TextEdit, so nothing was done\..*To act in Notes, name it as app/);
	assert.match(await c.fails("app_drag", { app: "TextEdit", x: 600, y: 100, to_x: 10, to_y: 10 }), /At that position is Notes, not TextEdit/);
	assert.match(await c.fails("app_scroll", { app: "TextEdit", x: 600, y: 100, direction: "down" }), /At that position is Notes/);
	assert.match(await c.call("app_click", { app: "Notes", x: 600, y: 100 }), /^Clicked the group at 600, 100 in Notes/);
	// Keys are sent to the app that was named and to no other, after it was brought to the front.
	await c.call("app_type", { app: "Notes", text: "Milk\nEggs" });
	await c.call("app_key", { app: "TextEdit", keys: "cmd+a delete" });
	assert.deepEqual(c.lines().slice(-5), ["activate 200", 'type "Milk\\nEggs" to=200 front=200', "activate 100", "key cmd+a to=100 front=100", "key delete to=100 front=100"]);
	assert.deepEqual(c.did().filter((l) => l.startsWith("click")), ["click 1201,201 left x1"], "nothing was clicked for any of the refusals");

	// An app that cannot be brought forward is not typed at.
	const stuck = fakeHelper(t, {}, "stuck");
	assert.match(await stuck.fails("app_type", { app: "TextEdit", text: "x" }), /TextEdit could not be brought to the front, so nothing was done in it/);
	assert.match(await stuck.fails("app_key", { app: "TextEdit", keys: "return" }), /could not be brought to the front/);
	assert.deepEqual(stuck.did(), []);
});

test("computer: pine does not click or type in the app it runs in, where its own questions are answered", async (t) => {
	const c = fakeHelper(t);
	// Looking is allowed.
	assert.match(await c.call("app_snapshot", { app: "Terminal" }), /- button "Allow" \[ref=e30\]/);
	assert.match(await c.call("app_screenshot", { app: "Terminal" }), /^Picture of Terminal/);
	assert.match(await c.call("app_menu", { app: "Terminal", path: "File" }), /holds:/);
	const refusal = /Terminal is the app pine itself runs in\. pine does not click, type or press there: that is where your owner answers pine's questions\. You can look at it \(app_snapshot, app_screenshot\)\. To run a command, use your own shell\./;
	for (const [name, args] of [
		["app_press", { ref: "e30" }],
		["app_set_text", { ref: "e30", text: "y" }],
		["app_type", { text: "y\n" }],
		["app_key", { keys: "return" }],
		["app_click", { x: 10, y: 10 }],
		["app_drag", { x: 10, y: 10, to_x: 20, to_y: 20 }],
		["app_scroll", { x: 10, y: 10, direction: "down" }],
		["app_menu", { path: "File > New" }],
	] as const) assert.match(await c.fails(name, { app: "terminal", ...args }), refusal, name);
	assert.deepEqual(c.did(), [], "nothing reached it");
	// Where pine does not run in an app with windows (a server, a service), there is no such app.
	const none = fakeHelper(t, {}, "no-host");
	assert.match(await none.call("app_type", { app: "Terminal", text: "ls" }), /^Typed 2 characters into Terminal/);
});

test("computer: a missing grant is said in plain words, with where to click, and macOS is asked to show its window once", async (t) => {
	const c = fakeHelper(t, {}, "no-access", "no-screen");
	const access = await c.fails("app_snapshot", { app: "TextEdit" });
	assert.equal(access, 'macOS does not let pine operate apps yet. Your owner has to allow it, once: open System Settings > Privacy & Security > Accessibility and switch on "Terminal", the app pine runs in. macOS has just put a window on their screen that leads there. Nothing was done. Tell your owner this, and try again when they say it is done.');
	const again = await c.fails("app_type", { app: "TextEdit", text: "x" });
	assert.ok(again.includes("System Settings > Privacy & Security > Accessibility") && !again.includes("has just put a window"), `macOS is not made to ask a second time: ${again}`);
	const screen = await c.fails("app_screenshot", { app: "TextEdit" });
	assert.ok(screen.includes("macOS does not let pine operate apps yet"), "a window's picture needs the window, which needs the same grant");
	const whole = await c.fails("app_screenshot");
	assert.match(whole, /^macOS does not let pine take pictures of the screen yet\. .*System Settings > Privacy & Security > Screen & System Audio Recording \(on older systems: Screen Recording\) and switch on "Terminal", the app pine runs in\. .*read windows with app_snapshot, which needs no picture\.$/);
	assert.deepEqual(c.lines().filter((l) => l.startsWith("status ask")), ["status ask=accessibility", "status ask=screen"]);
	assert.deepEqual(c.did(), []);
	// Without the grant the apps are still listed, without their windows, and it says why.
	const apps = await c.call("apps");
	assert.ok(apps.startsWith("Running apps:\n- TextEdit\n- Notes\n- Terminal (pine runs in it)\n") && apps.includes("\n\nThe windows are not listed: macOS does not let pine operate apps yet."), apps);
	// An app can be opened without it.
	assert.match(await c.call("app_open", { app: "Calculator" }), /^Calculator was opened and is in front\. Read a window with app_snapshot/);

	// Each refusal ended the helper: the one started for the next call sees what the owner has switched on since.
	const starts = c.lines().filter((l) => l === "start").length;
	assert.ok(starts >= 4, `${starts} helpers were started`);
	fs.writeFileSync(`${c.log}.granted`, "");
	assert.match(await c.call("app_snapshot", { app: "TextEdit" }), /- button "Bold"/);
	assert.match(await c.call("app_screenshot"), /^Picture of the whole screen/);

	assert.match(grantText("accessibility", undefined, false), /switch on the app pine runs in \(the terminal app pine was started from\)\./);
});

test("computer: a helper that is still being built, cannot be started, or dies says so and the next call starts anew", async (t) => {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pine-computer-test-"));
	t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
	let release!: (e: Error) => void;
	let launches = 0;
	const slow = computer({}, { scratch, patience: 30, launch: () => (++launches === 1 ? new Promise((_, reject) => (release = reject)) : Promise.reject(new Error("no compiler here"))) });
	await assert.rejects(() => slow.call("apps", {}), (e: Error) => e.message === BUILDING);
	await assert.rejects(() => slow.call("apps", {}), (e: Error) => e.message === BUILDING);
	assert.equal(launches, 1, "the build that is running is waited for, not started again");
	release(new Error("the build failed"));
	await new Promise((r) => setImmediate(r));
	await assert.rejects(() => slow.call("apps", {}), /no compiler here/);
	assert.equal(launches, 2, "after a failure the next call tries again");

	// A helper that ends in the middle of a call.
	let n = 0;
	const dying = computer({}, { scratch, launch: async () => spawn(process.execPath, ["-e", ++n === 1 ? 'process.stdin.once("data", () => { console.error("Segmentation fault"); process.exit(3); })' : 'process.stdin.on("data", (d) => console.log(JSON.stringify({ id: JSON.parse(String(d)).id, ok: true, apps: [] })))'], { stdio: ["pipe", "pipe", "pipe"] }) });
	t.after(() => dying.close());
	await assert.rejects(() => dying.call("apps", {}), /pine's helper for app control stopped: Segmentation fault\. Try once more\./);
	assert.equal(await dying.call("apps", {}), "Running apps:\n(none)");
	await assert.rejects(() => dying.call("app_fly", {}), /The tool app_fly is not available/);
	const blind = computer({ images: false }, { scratch, launch: async () => spawn(process.execPath, ["-e", ""]) });
	await assert.rejects(() => blind.call("app_click", { app: "TextEdit", x: 1, y: 1 }), /The tool app_click is not available/);
});

// ---- in the daemon -------------------------------------------------------------------------------

test("computer: the bundled server is configured like the others and marks sessions as tainted", async () => {
	const h = await harness({ pine: { mcp: { computer: { pine: "computer", options: { images: false, helperDir: "/tmp/anything" } } } }, agents: { main: {} }, start: false });
	const cfg = loadConfig(h.home);
	const server = effectiveMcp(cfg, cfg.agents.main).computer;
	assert.equal(mcpTaints(server), true, "what a screen shows was written by others");
	// Where the helper is kept is pine's to say, whatever the options say.
	const pi = toPiMcp("computer", server, computerSession({ owner: true, level: "auto", dataDir: cfg.dataDir, platform: "darwin" })) as any;
	assert.ok(pi.args[0].endsWith("mcp/computer.ts"));
	assert.deepEqual(JSON.parse(pi.env.PINE_MCP_OPTIONS), { images: false, helperDir: path.join(cfg.dataDir, "computer") });
	// The example home has it, and loads on any system.
	const example = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../examples/home/pine.json"), "utf8"));
	assert.equal(example.mcp.computer.pine, "computer");
	assert.ok(fs.existsSync(path.resolve(import.meta.dirname, "../mcp/computer.swift")));
	await h.close();
});

/** A daemon whose main agent has app control on a stand-in helper. `log` is what reached the machine. */
async function withApps(t: { after(fn: () => void): void }, pine: Record<string, unknown> = {}, main: Record<string, unknown> = {}, ...flags: string[]) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-computer-test-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const script = path.join(dir, "helper.mjs");
	const log = path.join(dir, "log.txt");
	fs.writeFileSync(script, FAKE_HELPER);
	fs.writeFileSync(log, "");
	const reviews: string[] = [];
	const h = await harness({
		// The main agent as pine ships it: auto mode, the owner's account.
		pine: { defaults: { mode: undefined }, mcp: { computer: { pine: "computer", options: { helper: [process.execPath, script, log, ...flags] } } }, ...pine },
		agents: { main: { agent: { untrusted: { tools: ["read"], mcp: ["computer"] }, ...main } }, clerk: { agent: {} } },
		mockOptions: {
			withoutTools: ({ user }: { user: string }) => {
				if (!user.includes("ALLOW or BLOCK?")) return "SUMMARY-OK";
				reviews.push(user);
				return "ALLOW";
			},
		},
	});
	const asked: any[] = [];
	const answer: { allow: boolean; always?: boolean } = { allow: true };
	h.pine.bus.subscribe("approval/requested", (e) => {
		asked.push(e.payload);
		h.pine.approvals.decide((e.payload as any).id, answer.allow, "test", answer.always === true);
	});
	const use = (calls: Array<[string, Record<string, unknown>?]>, o: Record<string, unknown> = {}) => h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: calls.map(([name, args]) => ({ name: `mcp__computer__${name}`, args: args ?? {} })) }]), trust: "owner", ...o } as any);
	const did = () => fs.readFileSync(log, "utf8").trim().split("\n").filter((l) => l && !/^(start|activate|shot|status)/.test(l));
	return { h, asked, answer, use, did, reviews };
}

test("computer: only the owner's own conversations of an agent that reaches the account get app control", { timeout: 60_000 }, async (t) => {
	const { h, use, did } = await withApps(t);
	const offered = (req: any) => h.toolsOffered(req).filter((n: string) => n.startsWith("mcp__computer__"));
	await use([["apps"]]);
	assert.equal(offered(h.requestsFor("PERSONA-MAIN").at(-1)).length, TOOLS.length, "the owner's conversation with the main agent has it");
	assert.match(h.toolResults().at(-1)!, /^Running apps:\n- TextEdit/);

	// A run that outside content started: the server is not registered, although the agent's profile for such runs lists it.
	await h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: [{ name: "mcp__computer__app_type", args: { app: "TextEdit", text: "pwned" } }] }]), trust: "untrusted", session: "outside" } as any);
	const outside = h.requestsFor("PERSONA-MAIN").at(-1);
	assert.deepEqual(offered(outside), []);
	assert.ok(h.toolsOffered(outside).includes("read"), "it has what its profile gives it otherwise");
	assert.ok(!/Typed/.test(h.toolResults().at(-1) ?? ""), h.toolResults().at(-1) ?? "");

	// An agent that is kept to its workspace: the same server is in its configuration, and it gets none of it.
	await h.pine.agents.run({ agent: "clerk", prompt: mockMsg([{ tools: [{ name: "mcp__computer__app_type", args: { app: "TextEdit", text: "hello" } }] }]), trust: "owner" } as any);
	const clerk = h.requestsFor("PERSONA-CLERK").at(-1);
	assert.deepEqual(offered(clerk), []);
	const told = h.families ? 'computer (one tool, "computer"' : "computer (mcp__computer__)";
	assert.ok(!h.system(clerk).includes(told) && h.system(h.requestsFor("PERSONA-MAIN")[0]).includes(told), "nor is it told about a server it does not have");
	assert.deepEqual(did(), [], "nothing was typed anywhere");
	await h.close();
});

test("computer: the owner is asked once per app in a conversation, and after the yes nothing is asked click by click", { timeout: 60_000 }, async (t) => {
	const { h, asked, answer, use, did, reviews } = await withApps(t);

	// Listing what runs is not asked about. The first call that names an app is, whether it looks or acts.
	await use([["apps"]]);
	assert.equal(asked.length, 0);
	answer.allow = false;
	await use([["app_type", { app: "TextEdit", text: "hello" }]]);
	assert.equal(asked.length, 1);
	assert.ok(asked[0].summary.startsWith('operate the app TextEdit\napp_type {"app":"TextEdit","text":"hello"}'), asked[0].summary);
	assert.ok(asked[0].why.includes("A yes holds for this app in this conversation") && asked[0].remember === "every app", JSON.stringify(asked[0]));
	assert.match(h.toolResults().at(-1)!, /not approved \(test\)\. You may not operate TextEdit in this conversation\. Do not retry/);
	assert.deepEqual(did(), [], "a no means nothing happens in the app");

	// A yes: this call runs, and so does everything after it in that app, without a question.
	answer.allow = true;
	await use([["app_snapshot", { app: "TextEdit" }]]);
	assert.equal(asked.length, 2);
	assert.match(h.toolResults().at(-1)!, /- text area \[ref=e2\]: "Hello"/);
	await use([["app_set_text", { app: "textedit", ref: "e2", text: "Dear Ada" }], ["app_press", { app: "TextEdit", ref: "e3" }], ["app_type", { app: "TextEdit", text: "!" }], ["app_key", { app: "TextEdit", keys: "cmd+s" }], ["app_menu", { app: "TextEdit", path: "File > New" }]]);
	await use([["app_screenshot", { app: "TextEdit" }], ["app_click", { app: "TextEdit", x: 640, y: 400 }]]);
	assert.equal(asked.length, 2, "not asked again");
	assert.deepEqual(did(), ['set e2 "Dear Ada"', "press e3", 'type "!" to=100 front=100', "key cmd+s to=100 front=100", "press m11", "click 420.3,250.3 left x1"]);
	const marks = h.pine.agents.status().sessions.map((s) => `${s.session}: ${s.tainted}`);
	assert.ok(marks.some((m) => /^main: mcp__computer__\w+ returned outside content/.test(m)), `what a window shows is outside content (${marks.join("; ")})`);
	assert.deepEqual(reviews, [], "by now the conversation has read outside content, and no model was asked about an action in the app");

	// Another app: asked. The whole screen: asked, once. The careful note is there now.
	await use([["app_press", { app: "Notes", ref: "e20" }]]);
	assert.equal(asked.length, 3);
	assert.ok(asked[2].summary.startsWith("operate the app Notes") && asked[2].why.includes("Careful: this conversation has read outside content"));
	await use([["app_screenshot"], ["app_screenshot", { screen: 2 }]]);
	assert.equal(asked.length, 4);
	assert.ok(asked[3].summary.startsWith("look at the whole screen") && asked[3].why.includes("shows every app that is open"));

	// Another conversation knows nothing of it. Nor does this one after a reset.
	await use([["app_press", { app: "TextEdit", ref: "e3" }]], { session: "second" });
	assert.equal(asked.length, 5);
	await h.pine.agents.resetSession("main", "main");
	await use([["app_press", { app: "TextEdit", ref: "e3" }]]);
	assert.equal(asked.length, 6);

	// "Always": no question for any app in that conversation any more.
	answer.always = true;
	await use([["app_press", { app: "TextEdit", ref: "e3" }]], { session: "third" });
	assert.equal(asked.length, 7);
	await use([["app_press", { app: "Notes", ref: "e20" }], ["app_screenshot"], ["app_type", { app: "Notes", text: "x" }]], { session: "third" });
	assert.equal(asked.length, 7);
	assert.deepEqual(did().slice(-2), ["press e20", 'type "x" to=200 front=200']);
	assert.deepEqual(reviews, []);
	await h.close();
});

test("computer: bypass asks nothing; an agent in its sandbox has no app control", { timeout: 60_000 }, async (t) => {
	const bypass = await withApps(t, {}, { mode: "bypass" });
	await bypass.use([["app_press", { app: "TextEdit", ref: "e3" }]]);
	assert.equal(bypass.asked.length, 0);
	assert.deepEqual(bypass.did(), ["press e3"]);
	await bypass.h.close();

	// Manual and safe mode work inside the sandbox, and app control lies outside any sandbox: such an agent has none of it.
	for (const mode of ["manual", "safe"]) {
		const boxed = await withApps(t, {}, { mode });
		await boxed.use([["app_press", { app: "TextEdit", ref: "e3" }]]);
		assert.deepEqual(boxed.h.toolsOffered(boxed.h.requestsFor("PERSONA-MAIN").at(-1)).filter((n: string) => n.startsWith("mcp__computer__")), [], mode);
		assert.deepEqual([boxed.asked.length, boxed.did()], [0, []], mode);
		// Switched to auto while it runs, its next message has the tools: the session is made anew.
		boxed.h.pine.agents.setMode("main", "auto");
		await boxed.use([["apps"]]);
		assert.equal(boxed.h.toolsOffered(boxed.h.requestsFor("PERSONA-MAIN").at(-1)).filter((n: string) => n.startsWith("mcp__computer__")).length, TOOLS.length, mode);
		await boxed.h.close();
	}
});

// ---- the real helper, on a Mac --------------------------------------------------------------------

const live = process.env.PINE_LIVE === "1" && process.platform === "darwin";

// Builds the real helper and drives the real server logic against the helper's own demo window.
// A process may read its own accessibility tree without the owner's grant, so this runs on a Mac
// where nothing was granted; mouse and keyboard events and pictures are not part of it.
test("live: the real helper reads and operates a window by outline", { skip: !live, timeout: 300_000 }, async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-computer-live-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const program = await buildHelper(path.join(dir, "bin"));
	const server = computer({}, { scratch: dir, launch: async () => spawn(program, ["--demo"], { stdio: ["pipe", "pipe", "pipe"] }) });
	t.after(() => server.close());
	const call = async (name: string, args: Record<string, unknown> = {}) => String(await server.call(name, args));

	assert.match(await call("apps"), /- Pine Demo.*: window 1 "Pine Demo"/);
	const before = await call("app_snapshot", { app: "Pine Demo" });
	assert.match(before, /^Pine Demo, window 1 "Pine Demo"\./);
	const ref = (line: RegExp) => before.match(line)?.[1] ?? assert.fail(`${line} in\n${before}`);
	const field = ref(/- text field \[ref=(e\d+)\].*empty, shows "A word"/);
	const shout = ref(/- button "Shout" \[ref=(e\d+)\]/);
	const loud = ref(/- checkbox "Loud" \[ref=(e\d+)\] \(not checked\)/);
	assert.match(before, /- text "Nothing yet"/);

	assert.equal(await call("app_set_text", { app: "Pine Demo", ref: field, text: "pine" }), 'The text field in Pine Demo now holds "pine".');
	assert.match(await call("app_press", { app: "pine demo", ref: loud }), /^Pressed the checkbox "Loud" in Pine Demo/);
	assert.match(await call("app_press", { app: "Pine Demo", ref: shout }), /^Pressed the button "Shout" in Pine Demo/);
	const after = await call("app_snapshot", { app: "Pine Demo" });
	assert.match(after, /- text "PINE!!!"/, "the result is read back");
	assert.ok(after.includes(`- text field [ref=${field}]`) && after.includes(`- checkbox "Loud" [ref=${loud}] (checked)`), "a control keeps its reference");

	assert.match(await call("app_menu", { app: "Pine Demo" }), /^The menus of Pine Demo:\n- Demo >/);
	assert.match(await call("app_menu", { app: "Pine Demo", path: "Demo" }), /- Reset {3}cmd\+r/);
	assert.equal(await call("app_menu", { app: "Pine Demo", path: "Demo > Reset" }), 'Picked "Demo > Reset" in Pine Demo.');
	assert.match(await call("app_snapshot", { app: "Pine Demo" }), /- text "Nothing yet"/);
});

// The whole way without a real model: the daemon, its gate, the server as pi starts it, the real
// helper and a real window. The scripted model can name the references because a fresh helper
// numbers what it meets in order: the window, then its text field, button and checkbox. (The
// list of all apps comes last: with the Accessibility grant it numbers their windows too.)
test("live: through the daemon, the real helper operates a real window and the result is read back", { skip: !live, timeout: 300_000 }, async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-computer-live-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const program = await buildHelper(path.join(dir, "bin"));
	const h = await harness({ pine: { defaults: { mode: undefined }, mcp: { computer: { pine: "computer", options: { helper: [program, "--demo"] } } } }, agents: { main: {} } });
	const asked: string[] = [];
	h.pine.bus.subscribe("approval/requested", (e) => {
		asked.push(String((e.payload as any).summary).split("\n")[0]);
		h.pine.approvals.decide((e.payload as any).id, true, "test");
	});
	const app = "Pine Demo";
	const call = (name: string, args: Record<string, unknown> = {}) => ({ name: `mcp__computer__${name}`, args });
	const r = await h.pine.agents.run({
		agent: "main",
		prompt: mockMsg([
			{ tools: [call("app_open", { app }), call("app_snapshot", { app })] },
			{ tools: [call("app_set_text", { app, ref: "e2", text: "pine" }), call("app_press", { app, ref: "e4" }), call("app_press", { app, ref: "e3" }), call("app_menu", { app, path: "Demo" }), call("app_snapshot", { app }), call("apps")] },
		]),
		trust: "owner",
	});
	assert.equal(r.status, "done", String(r.error));
	const out = h.toolResults();
	assert.match(out[0], /^Pine Demo was already running and is in front\. Its window: 1 "Pine Demo"\./);
	assert.match(out[1], /- text field \[ref=e2\].*\n- button "Shout" \[ref=e3\]\n- checkbox "Loud" \[ref=e4\] \(not checked\)\n- text "Nothing yet"/);
	assert.equal(out[2], 'The text field in Pine Demo now holds "pine".');
	assert.match(out[3], /^Pressed the checkbox "Loud" in Pine Demo/);
	assert.match(out[4], /^Pressed the button "Shout" in Pine Demo/);
	assert.match(out[5], /"Demo" in Pine Demo holds:\n- Reset {3}cmd\+r/);
	assert.match(out[6], /- text field \[ref=e2\].*: "pine"\n- button "Shout" \[ref=e3\]\n- checkbox "Loud" \[ref=e4\] \(checked\)\n- text "PINE!!!"/);
	assert.match(out[7], /- Pine Demo.*: window 1 "Pine Demo"/);
	assert.deepEqual(asked, ["operate the app Pine Demo"], "one question for the one app");
	assert.match(h.pine.agents.status().sessions[0].tainted ?? "", /returned outside content/);
	await h.close();
});

/**
 * A real model for the tests below: `claude -p` (see src/dev/claude-model.ts), or, with
 * PINE_LIVE_BASE_URL, an OpenAI-compatible server such as a local llama.cpp
 * (PINE_LIVE_KEY: its key; PINE_LIVE_MODEL: the model's name there; PINE_LIVE_SEES=1 if it takes pictures).
 */
async function liveModel(t: { after(fn: () => unknown): void }): Promise<{ mock: any; sees: boolean }> {
	const base = process.env.PINE_LIVE_BASE_URL;
	if (!base) {
		const model = await startClaudeModel({ model: process.env.PINE_LIVE_MODEL ?? "haiku", log: (l) => process.env.PINE_TEST_LOG && console.error(l) });
		t.after(() => model.close());
		return { mock: { baseUrl: model.baseUrl, port: model.port, state: { requests: [] } }, sees: true };
	}
	const target = new URL(base);
	// The harness writes a model file without a key: this hands requests on with one.
	const proxy = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c)).on("end", () => {
			let body = Buffer.concat(chunks);
			try {
				if (process.env.PINE_LIVE_MODEL && body.length) body = Buffer.from(JSON.stringify({ ...JSON.parse(body.toString()), model: process.env.PINE_LIVE_MODEL }));
			} catch {
				// not JSON: as it is
			}
			const up = http.request({ host: target.hostname, port: target.port || 80, method: req.method, path: req.url, headers: { ...req.headers, host: target.host, "content-length": String(body.length), ...(process.env.PINE_LIVE_KEY ? { authorization: `Bearer ${process.env.PINE_LIVE_KEY}` } : {}) } }, (r) => {
				res.writeHead(r.statusCode ?? 502, r.headers);
				r.pipe(res);
			});
			up.on("error", () => res.writeHead(502).end());
			up.end(body);
		});
	});
	await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
	t.after(() => (proxy.closeAllConnections(), proxy.close()));
	const port = (proxy.address() as net.AddressInfo).port;
	return { mock: { baseUrl: `http://127.0.0.1:${port}${target.pathname.replace(/\/$/, "")}`, port, state: { requests: [] } }, sees: process.env.PINE_LIVE_SEES === "1" };
}

/** A daemon with a real model whose main agent has app control and nothing else to act with. */
async function liveAgent(t: { after(fn: () => unknown): void }, mock: any, options: Record<string, unknown>) {
	const h = await harness({
		mock,
		model: { contextWindow: 120000, maxTokens: 4096, input: ["text", "image"] },
		pine: { defaults: { mode: undefined }, mcp: { computer: { pine: "computer", options } } },
		agents: { main: { agent: { tools: ["read"], taskTimeoutSec: 600 }, persona: "You operate apps on your owner's Mac for them, with the tools whose names start with mcp__computer__. Do what is asked, step by step, and report what you found.\n" } },
	});
	const asked: string[] = [];
	const used: string[] = [];
	h.pine.bus.subscribe("approval/requested", (e) => {
		asked.push(String((e.payload as any).summary).split("\n")[0]);
		h.pine.approvals.decide((e.payload as any).id, true, "test");
	});
	h.pine.bus.subscribe("agent/main/tool", (e) => void ((e.payload as any).phase === "start" && used.push(String((e.payload as any).tool).replace("mcp__computer__", ""))));
	return { h, asked, used };
}

/** A picture of flat colours, as a PNG. */
function png(width: number, height: number, rects: Array<{ x: number; y: number; w: number; h: number; rgb: [number, number, number] }>): Buffer {
	const row = width * 3 + 1;
	const raw = Buffer.alloc(row * height, 255);
	for (let y = 0; y < height; y++) {
		raw[y * row] = 0;
		for (const r of rects) if (y >= r.y && y < r.y + r.h) for (let x = r.x; x < r.x + r.w; x++) raw.set(r.rgb, y * row + 1 + x * 3);
	}
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const out = Buffer.alloc(body.length + 8);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(zlib.crc32(body) >>> 0, body.length + 4);
		return out;
	};
	const head = Buffer.alloc(13);
	head.writeUInt32BE(width, 0);
	head.writeUInt32BE(height, 4);
	head.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("live: an agent reads a real window by outline, writes into it, presses its button and reads the result back", { skip: !live, timeout: 600_000 }, async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-computer-live-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const program = await buildHelper(path.join(dir, "bin"));
	const { mock } = await liveModel(t);
	// The helper's own demo window: real accessibility, and no grant needed for it.
	const { h, asked, used } = await liveAgent(t, mock, { helper: [program, "--demo"], images: false });
	const r = await h.pine.agents.run({ agent: "main", prompt: 'An app called "Pine Demo" is running on this Mac. Read its window. Put the word pine into its text field, tick the checkbox Loud, press the button Shout. Then read the window again and tell me exactly what text it shows below the button now.', trust: "owner" });
	assert.equal(r.status, "done", String(r.error));
	assert.match(r.text, /PINE!!!/, `${r.text}\n(used: ${used.join(", ")})`);
	assert.deepEqual(asked, ["operate the app Pine Demo"], "asked once, for the one app");
	for (const name of ["app_snapshot", "app_set_text", "app_press"]) assert.ok(used.includes(name), `${name} in ${used.join(", ")}`);
	assert.ok(used.filter((n) => n === "app_snapshot").length >= 2, "it read the result back");
	await h.close();
});

test("live: an agent that sees clicks what it was asked to click in a picture, and the click lands at the right point of the screen", { skip: !live, timeout: 600_000 }, async (t) => {
	const { mock, sees } = await liveModel(t);
	if (!sees) return t.skip("the model does not take pictures (PINE_LIVE_SEES=1 says that it does)");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-computer-live-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	// The stand-in's TextEdit window is 640 by 400 points at 100, 50 on the screen; its picture is 1280 by 800 pixels.
	const blue = { x: 800, y: 500, w: 320, h: 120 };
	fs.writeFileSync(path.join(dir, "window.png"), png(1280, 800, [{ ...blue, rgb: [20, 60, 220] }, { x: 100, y: 100, w: 200, h: 100, rgb: [220, 30, 30] }]));
	fs.writeFileSync(path.join(dir, "helper.mjs"), FAKE_HELPER);
	fs.writeFileSync(path.join(dir, "log.txt"), "");
	const { h, asked, used } = await liveAgent(t, mock, { helper: [process.execPath, path.join(dir, "helper.mjs"), path.join(dir, "log.txt"), `picture=${path.join(dir, "window.png")}`], block: ["app_snapshot", "app_press", "app_set_text", "app_menu"] });
	const r = await h.pine.agents.run({ agent: "main", prompt: "Take a picture of the window of the app TextEdit. It shows a blue rectangle and a red rectangle on white. Click once in the middle of the blue rectangle, then tell me the position you clicked.", trust: "owner" });
	assert.equal(r.status, "done", String(r.error));
	const clicks = fs.readFileSync(path.join(dir, "log.txt"), "utf8").split("\n").filter((l) => l.startsWith("click ")).map((l) => l.split(" ")[1].split(",").map(Number));
	assert.ok(clicks.length >= 1, `no click (used: ${used.join(", ")}; said: ${r.text})`);
	// Half a point per pixel, from 100, 50.
	const [x, y] = clicks.at(-1)!;
	assert.ok(x > 100 + blue.x / 2 && x < 100 + (blue.x + blue.w) / 2 && y > 50 + blue.y / 2 && y < 50 + (blue.y + blue.h) / 2, `clicked the screen at ${x}, ${y}, outside the blue rectangle (${r.text})`);
	assert.deepEqual(asked, ["operate the app TextEdit"]);
	assert.ok(used.includes("app_screenshot") && used.includes("app_click"));
	await h.close();
});

/** What macOS has granted the app these tests run in, asked of the real helper. */
async function granted(program: string): Promise<{ accessibility: boolean; screen: boolean }> {
	const child = spawn(program, [], { stdio: ["pipe", "pipe", "ignore"] });
	try {
		const line = await new Promise<string>((resolve, reject) => {
			child.stdout.once("data", (d) => resolve(String(d)));
			child.once("error", reject);
			child.stdin.write('{"id":1,"cmd":"status"}\n');
		});
		return JSON.parse(line.split("\n")[0]);
	} finally {
		child.kill();
	}
}

// The two tests below operate the real TextEdit on the screen of whoever runs them. They need what
// app control needs: the terminal app they are started from must have the Accessibility grant, and
// for pictures the Screen Recording grant. Without it they skip and say so.
for (const way of ["outline", "picture"] as const) {
	test(`live: an agent opens TextEdit, writes into a new document and reads it back, by ${way}`, { skip: !live, timeout: 900_000 }, async (t) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-computer-live-"));
		t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
		const program = await buildHelper(path.join(dir, "bin"));
		const has = await granted(program);
		if (!has.accessibility) return t.skip("the app this runs in has no Accessibility grant (System Settings > Privacy & Security > Accessibility)");
		if (way === "picture" && !has.screen) return t.skip("the app this runs in has no Screen Recording grant (System Settings > Privacy & Security > Screen & System Audio Recording)");
		const { mock, sees } = await liveModel(t);
		if (way === "picture" && !sees) return t.skip("the model does not take pictures (PINE_LIVE_SEES=1 says that it does)");

		const token = `pine was here ${Math.random().toString(36).slice(2, 8)}`;
		// By outline the model gets no pictures; by picture it gets nothing that works by reference.
		const { h, asked, used } = await liveAgent(t, mock, way === "outline" ? { helper: program, images: false } : { helper: program, block: ["app_snapshot", "app_press", "app_set_text"] });
		// Whatever the agent did, look for ourselves afterwards, and put the document away again.
		const own = computer({}, { scratch: dir, launch: async () => spawn(program, [], { stdio: ["pipe", "pipe", "pipe"] }) });
		t.after(async () => {
			try {
				if (String(await own.call("app_snapshot", { app: "TextEdit" })).includes(token)) {
					await own.call("app_key", { app: "TextEdit", keys: "cmd+w" });
					await new Promise((r) => setTimeout(r, 800));
					const sheet = String(await own.call("app_snapshot", { app: "TextEdit" }));
					const no = sheet.match(/- button "(?:Delete|Don.t Save)" \[ref=(e\d+)\]/)?.[1];
					if (no) await own.call("app_press", { app: "TextEdit", ref: no });
				}
			} catch {
				// the document stays open; nothing else depends on it
			}
			own.close();
		});

		const how =
			way === "outline"
				? "Work by outline: read the window with app_snapshot and write with app_set_text, using the reference of the document's text area."
				: "Work by picture: look with app_screenshot, click into the middle of the document's text with app_click, then type with app_type.";
		const r = await h.pine.agents.run({ agent: "main", prompt: `Open the app TextEdit. Make a new empty document in it: press cmd+n with app_key (if a window for choosing a file is in the way, this also gets you past it). ${how} The document must hold exactly this text: ${token}\nThen look at the document again and tell me, word for word, what it holds.`, trust: "owner" });
		assert.equal(r.status, "done", String(r.error));
		assert.ok(r.text.includes(token), `the agent read back: ${r.text}\n(used: ${used.join(", ")})`);
		assert.match(String(await own.call("app_snapshot", { app: "TextEdit" })), new RegExp(token), "the text is really in TextEdit's window");
		assert.deepEqual(asked, ["operate the app TextEdit"], "asked once, for the one app");
		for (const name of way === "outline" ? ["app_open", "app_snapshot", "app_set_text"] : ["app_open", "app_screenshot", "app_click", "app_type"]) assert.ok(used.includes(name), `${name} in ${used.join(", ")}`);
		await h.close();
	});
}
