import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "../src/tui/client.ts";
import { PineTui } from "../src/tui/app.ts";
import { buildVoice, Listening, NO_COMPILER, NOT_HERE, VOICE_SOURCE, voiceTools } from "../src/tui/voice.ts";
import { harness, sleep, until } from "./support/harness.ts";
import { FakeTerminal, KEY } from "./support/terminal.ts";

const CTRL_R = "\x12";
const tmp = (t: { after(fn: () => void): void }) => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pine-voice-")));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
};

// A stand-in for the helper, for any system: it "hears" the lines of a script, one every few
// milliseconds, and ends with the last word when its input is closed, as the helper does.
const HELPER = `const [script, log] = process.argv.slice(1);
const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const steps = JSON.parse(require("fs").readFileSync(script, "utf8"));
if (log) require("fs").appendFileSync(log, process.argv.slice(3).join(" ") + "\\n");
let heard = "", i = 0;
const timer = setInterval(() => { const s = steps[i++]; if (!s) return clearInterval(timer); if (s.text !== undefined) heard = s.text; say(s); if (s.type === "error" || s.type === "final") process.exit(s.type === "error" ? 1 : 0); if (s.die) process.exit(3); }, 25);
process.stdin.on("data", () => {});
process.stdin.on("end", () => { clearInterval(timer); setTimeout(() => { say({ type: "final", text: heard }); process.exit(0); }, 40); });`;
function standIn(dir: string, steps: any[], log?: string) {
	const script = path.join(dir, `steps-${Math.random().toString(36).slice(2)}.json`);
	fs.writeFileSync(script, JSON.stringify(steps));
	return [process.execPath, "-e", HELPER, script, ...(log ? [log] : [])];
}
const heard = (command: string[], language?: string) => {
	const log: string[] = [];
	let result: { text?: string; error?: string } | undefined;
	const l = new Listening(command, language, { ready: () => log.push("ready"), model: (s) => log.push(`model ${s}`), partial: (t) => log.push(`partial ${t}`), done: (text, error) => (result = { text, error }) });
	return { l, log, done: async () => (await until(() => result, 5000, "listening to end"), result!) };
};

test("voice: on a system that is not macOS there is no voice input, said in a sentence, and nothing is built or started", async (t) => {
	const dir = tmp(t);
	for (const platform of ["linux", "win32", "freebsd"]) {
		const tools = voiceTools(platform, dir);
		assert.equal(tools.unavailable, NOT_HERE);
		await assert.rejects(() => tools.program(), /Voice input needs a Mac/);
	}
	assert.deepEqual(fs.readdirSync(dir), [], "nothing was written");
	assert.equal(voiceTools("darwin", dir).unavailable, undefined);
	assert.ok(fs.existsSync(VOICE_SOURCE), "the helper's source ships with pine");
});

test("voice: the helper is built once, with its reasons for listening inside it, and a Mac without the tools is told what to install", async (t) => {
	const dir = tmp(t);
	const source = path.join(dir, "voice.swift");
	fs.writeFileSync(source, "// one");
	const calls: string[][] = [];
	const tools = path.join(dir, "CommandLineTools");
	const run = (compiles: boolean, installed = true) => async (file: string, args: string[]) => {
		calls.push([path.basename(file), ...args]);
		if (file.endsWith("xcode-select")) return installed ? (fs.mkdirSync(tools, { recursive: true }), { code: 0, stdout: `${tools}\n`, stderr: "" }) : { code: 2, stdout: "", stderr: "no developer tools" };
		const info = args[args.indexOf("__info_plist") + 2];
		// What the system shows the owner when it asks is in the program at the moment it is linked.
		assert.match(fs.readFileSync(info, "utf8"), /NSMicrophoneUsageDescription[\s\S]*NSSpeechRecognitionUsageDescription[\s\S]*recognised on this Mac/);
		if (compiles) fs.writeFileSync(args[args.indexOf("-o") + 1], "binary");
		return compiles ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "voice.swift:3:1: error: cannot find 'Speech' in scope\nnote: x" };
	};
	const out = path.join(dir, "built");
	await assert.rejects(() => buildVoice(out, source, run(true, false)), (e: Error) => e.message === NO_COMPILER);
	await assert.rejects(() => buildVoice(out, source, run(false)), /could not build its helper for voice input \(voice\.swift:3:1: error: cannot find 'Speech' in scope\)/);
	assert.deepEqual(fs.existsSync(out) ? fs.readdirSync(out) : [], [], "a build that failed leaves nothing");
	const first = await buildVoice(out, source, run(true));
	assert.match(path.basename(first), /^pine-voice-[0-9a-f]{12}$/);
	const link = calls.at(-1)!;
	assert.deepEqual(link.slice(0, 5), ["swiftc", "-swift-version", "5", "-O", "-o"]);
	assert.deepEqual(link.slice(7, 14), ["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker"]);
	const n = calls.length;
	assert.equal(await buildVoice(out, source, run(true)), first);
	assert.equal(calls.length, n, "found again, not built again");
	// Another source (an update of pine) is another program, and the old one goes.
	fs.writeFileSync(source, "// two");
	const second = await buildVoice(out, source, run(true));
	assert.notEqual(second, first);
	assert.deepEqual(fs.readdirSync(out), [path.basename(second)]);
});

test("voice: what is heard arrives as it is heard, ends when the listening is ended, and is text and nothing else", async (t) => {
	const dir = tmp(t);
	const log = path.join(dir, "args.log");
	// Said so far, then all of it when the input is closed. The language goes to the helper.
	let h = heard(standIn(dir, [{ type: "ready" }, { type: "partial", text: "list the" }, { type: "partial", text: "list the bills" }], log), "de-DE");
	await until(() => h.log.includes("partial list the bills"), 3000, "the words");
	assert.deepEqual(h.log, ["ready", "partial list the", "partial list the bills"]);
	assert.ok(h.l.active);
	h.l.stop();
	assert.deepEqual(await h.done(), { text: "list the bills", error: undefined });
	assert.ok(!h.l.active);
	assert.equal(fs.readFileSync(log, "utf8").trim(), "--locale de-DE");
	// Words from a microphone are shown in a terminal: nothing in them moves the cursor or colours the screen.
	h = heard(standIn(dir, [{ type: "partial", text: "delete\x1b[2J all\nof  it\x07" }]));
	await until(() => h.log.length === 1, 3000, "the words");
	assert.equal(h.log[0], "partial delete [2J all of it");
	h.l.cancel();
	assert.deepEqual(await h.done(), { text: undefined, error: undefined }, "thrown away: nothing comes of it");
	// It cannot listen: the helper's sentence is what the owner reads.
	h = heard(standIn(dir, [{ type: "model", state: "downloading" }, { type: "error", code: "microphone", message: "pine may not use the microphone. Allow it in System Settings." }]));
	assert.deepEqual(await h.done(), { text: undefined, error: "pine may not use the microphone. Allow it in System Settings." });
	assert.deepEqual(h.log, ["model downloading"]);
	// A helper that ends without a last word: what it had heard is kept.
	h = heard(standIn(dir, [{ type: "partial", text: "half a sentence", die: true }]));
	assert.deepEqual(await h.done(), { text: "half a sentence", error: undefined });
	// And a program that is not there is an error, not a crash.
	h = heard([path.join(dir, "no-such-program")]);
	assert.match((await h.done()).error!, /voice input could not be started/);
});

test("voice: ctrl+r dictates into the message, after what was typed; enter ends the listening and sends nothing; esc throws it away; without a Mac it says so", async (t) => {
	const dir = tmp(t);
	const h = await harness({ pine: { main: "main", http: { port: 0 } }, agents: { main: {} } } as any);
	const open = async (voice: any) => {
		const term = new FakeTerminal(110, 30);
		const app = new PineTui({ client: new Client(`http://127.0.0.1:${h.pine.http!.port}`, h.pine.token), terminal: term, mode: "test", voice });
		await app.start();
		const text = () => app.screen().join("\n");
		const sees = (what: string | RegExp, ms = 4000) => until(() => (typeof what === "string" ? text().includes(what) : what.test(text())), ms, `the screen to show ${what}\n--- screen ---\n${text()}`);
		return { term, app, text, sees };
	};
	const said = [{ type: "ready" }, { type: "partial", text: "which bill" }, { type: "partial", text: "which bill is due first" }];
	let ui = await open({ program: async () => standIn(dir, said) });
	await ui.sees("type a message");
	const tasks = () => h.pine.tasks.list({}).length;

	ui.term.type("About the scans:");
	ui.term.type([CTRL_R]);
	await ui.sees("● listening · speak · enter when you are done · esc to throw it away");
	await ui.sees("About the scans: which bill is due first");
	// Enter ends the listening. The words stay in the input to be read; nothing has been sent.
	ui.term.type([KEY.enter]);
	await until(() => !/listening|finishing/.test(ui.text()), 4000, "the listening to end");
	await ui.sees("About the scans: which bill is due first");
	await sleep(150);
	assert.equal(tasks(), 0, "what was heard is not sent by itself");
	// It is text like typed text: more is typed, and enter sends it.
	ui.term.type("?");
	ui.term.type([KEY.enter]);
	await ui.sees("ECHO[About the scans: which bill is due first?]");
	assert.equal(tasks(), 1);

	// The microphone at the right end of the input does the same with a click: one starts the listening, one ends it.
	const mic = () => {
		const lines = ui.app.screen();
		const y = lines.findIndex((l) => l.includes("🎤"));
		assert.ok(y >= 0, `a microphone on the screen\n${ui.text()}`);
		return { y, x: lines[y].indexOf("🎤"), line: lines[y] };
	};
	assert.ok(!ui.app.screen()[0].includes("🎤"), "not in the tab bar");
	assert.match(mic().line, /^ {10,}🎤$/, "at the right end of the input's line, which is empty");
	assert.match(ui.app.screen()[mic().y - 1], /^─+$/, "the line above the input runs on over it");
	ui.term.click(mic().x, mic().y);
	await ui.sees("● listening · speak");
	await until(() => /^ which bill is due first +🎤$/.test(mic().line), 3000, "the words in the input, the microphone after them");
	// (One cell further: two clicks on one spot are a double click, which is no second click.)
	ui.term.click(mic().x + 1, mic().y);
	await until(() => !/● (listening|finishing)/.test(ui.text()), 4000, "the click to end the listening");
	await sleep(120);
	assert.equal(tasks(), 1, "and it sends nothing either");
	ui.term.type([KEY.enter]);
	await ui.sees("ECHO[which bill is due first]");

	// Thrown away with esc: what was typed before is there again, and nothing of what was heard.
	ui.term.type("keep this");
	ui.term.type([CTRL_R]);
	await ui.sees("keep this which bill is due first");
	ui.term.type([KEY.esc]);
	await until(() => !ui.text().includes("listening"), 3000, "the listening to end");
	await sleep(120);
	assert.ok(/^ keep this +🎤$/.test(ui.app.screen().find((l) => l.includes("keep this")) ?? "") && !ui.text().includes("keep this which"), ui.text());
	assert.equal(tasks(), 2);
	await ui.app.stop();

	// It cannot listen: the reason is shown, and the input is as it was.
	ui = await open({ program: async () => standIn(dir, [{ type: "error", code: "microphone", message: "pine may not use the microphone. Allow it in System Settings > Privacy & Security > Microphone." }]) });
	await ui.sees("type a message");
	ui.term.type("typed");
	ui.term.type([CTRL_R]);
	await ui.sees("pine may not use the microphone. Allow it in System Settings");
	assert.ok(ui.text().includes("typed"));
	await ui.app.stop();

	// Not a Mac: the key and the command say so, nothing is started, and pine goes on working.
	let started = 0;
	const linux = voiceTools("linux", dir);
	ui = await open({ ...linux, program: () => (started++, linux.program()) });
	await ui.sees("type a message");
	assert.ok(ui.text().includes("▤ code") && !ui.text().includes("🎤"), "no microphone is offered where there is none to use");
	ui.term.type([CTRL_R]);
	await ui.sees("Voice input needs a Mac");
	ui.term.type("/voice");
	ui.term.type([KEY.enter]);
	await ui.sees("Voice input needs a Mac");
	assert.equal(started, 0);
	ui.term.type("still here");
	ui.term.type([KEY.enter]);
	await ui.sees("ECHO[still here]");
	await ui.app.stop();
	await h.close();
});

test("voice: dictating never holds the input: a typed key ends it, and so does enter before it has begun to listen", async (t) => {
	const dir = tmp(t);
	const h = await harness({ pine: { main: "main", http: { port: 0 } }, agents: { main: {} } } as any);
	const open = async (voice: any) => {
		const term = new FakeTerminal(110, 30);
		const app = new PineTui({ client: new Client(`http://127.0.0.1:${h.pine.http!.port}`, h.pine.token), terminal: term, mode: "test", voice });
		await app.start();
		const text = () => app.screen().join("\n");
		const sees = (what: string | RegExp, ms = 4000) => until(() => (typeof what === "string" ? text().includes(what) : what.test(text())), ms, `the screen to show ${what}\n--- screen ---\n${text()}`);
		return { term, app, text, sees };
	};
	// It goes on hearing, word after word. What is typed meanwhile must not be overwritten by the next word.
	const talking = [{ type: "ready" }, { type: "partial", text: "one" }, ...Array.from({ length: 40 }, (_, i) => ({ type: "partial", text: `one two ${i}` }))];
	let ui = await open({ program: async () => standIn(dir, talking) });
	await ui.sees("type a message");
	ui.term.type([CTRL_R]);
	await ui.sees("● listening");
	await ui.sees(/one two \d+ +🎤/);
	ui.term.type("!");
	await until(() => !/● (listening|finishing)/.test(ui.text()), 3000, "the typed key to end the listening");
	const typed = ui.app.screen().find((l) => l.includes("!")) ?? "";
	assert.match(typed, /one two \d+!/, "what was heard stays, and the key is typed after it");
	await sleep(250);
	assert.ok((ui.app.screen().find((l) => l.includes("!")) ?? "") === typed, "and nothing that is heard later is put over it");
	ui.term.type([KEY.enter]);
	await ui.sees(/ECHO\[one two \d+!\]/);
	await ui.app.stop();

	// A helper that never gets to listen (the system is waiting for an answer about the microphone): enter gets out of it.
	ui = await open({ program: async () => [process.execPath, "-e", "setInterval(() => {}, 1000)"] });
	await ui.sees("type a message");
	ui.term.type([CTRL_R]);
	await ui.sees("● getting ready to listen");
	ui.term.type([KEY.enter]);
	await until(() => !ui.text().includes("getting ready to listen"), 3000, "enter to end what never began");
	ui.term.type("still here");
	ui.term.type([KEY.enter]);
	await ui.sees("ECHO[still here]");
	await ui.app.stop();
	await h.close();
});

test("live: voice: the real helper recognises a spoken sentence on this Mac", { skip: process.platform !== "darwin" || !process.env.PINE_LIVE }, async (t) => {
	const dir = tmp(t);
	const { execFileSync } = await import("node:child_process");
	const audio = path.join(dir, "said.aiff");
	execFileSync("/usr/bin/say", ["-o", audio, "Please list the bills in my scans folder."]);
	const program = await voiceTools().program();
	const h = heard([...program, "--file", audio], "en-US");
	const got = await h.done();
	assert.match(got.text ?? `error: ${got.error}`, /list the bills in my scans folder/i);
});
