import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { getCapabilities, setCapabilities } from "@earendil-works/pi-tui";
import { PineTui } from "../src/tui/app.ts";
import { Client } from "../src/tui/client.ts";
import { halfBlocks, parseBmp, picturesIn, prepare, scaled } from "../src/tui/picture.ts";
import { harness, mockMsg, sleep, until } from "./support/harness.ts";
import { png } from "./support/png.ts";
import { FakeTerminal, KEY } from "./support/terminal.ts";

/** Pictures need a converter: sips on macOS, ffmpeg elsewhere. */
const mac = { skip: process.platform !== "darwin" && !["/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].some((f) => fs.existsSync(f)) };
const owner = { trust: "owner" as const };
const apps: PineTui[] = [];
after(async () => {
	for (const app of apps) await app.stop().catch(() => {});
});

test("pictures: which ones an answer points at", () => {
	const refs = picturesIn("Here ![the chart](out/chart.png) and ![](https://example.com/a%20b.jpg?x=1 \"title\"), twice ![again](out/chart.png).\n\n```md\n![in code](no.png)\n```\nAnd `![inline](no2.png)`, ![d](data:image/png;base64,AAAA), ![odd](javascript:alert(1)), ![f](file:///tmp/my%20pic.png)");
	assert.deepEqual(refs, [
		{ caption: "the chart", target: "out/chart.png", remote: false },
		{ caption: "", target: "https://example.com/a%20b.jpg?x=1", remote: true },
		{ caption: "f", target: "/tmp/my pic.png", remote: false },
	]);
	assert.equal(picturesIn(Array.from({ length: 20 }, (_, i) => `![p](p${i}.png)`).join(" ")).length, 6, "an answer cannot flood the screen");
});

test("pictures: a picture becomes half blocks that keep its colours and shape", mac, async () => {
	const p = await prepare(png(64, 40), "image/png", "two halves");
	assert.equal(`${p.widthPx}x${p.heightPx}`, "64x40");
	assert.ok(p.pixels && p.pixels.width === 64 && p.pixels.height === 40, "small pictures are not enlarged");
	const lines = halfBlocks(p.pixels!, 32, 14);
	assert.equal(lines.length, 10, "32 cells wide, two pixel rows per line");
	assert.ok(lines.every((l) => l.split("▀").length - 1 === 32));
	assert.ok(lines[0].startsWith(" \x1b[38;2;220;40;40m\x1b[48;2;220;40;40m▀") && lines[0].includes("\x1b[38;2;40;60;220m\x1b[48;2;40;60;220m▀\x1b[0m"), JSON.stringify(lines[0].slice(0, 80)));
	assert.equal(halfBlocks(p.pixels!, 100, 5).length, 5, "the height limit wins and the width follows");
	assert.ok(halfBlocks(p.pixels!, 8, 14, false)[0].includes("\x1b[38;5;"), "256 colours where true colour is missing");
	// Something that is not a picture, and a broken file: no drawing, no crash.
	assert.equal((await prepare(Buffer.from("not a picture at all"), "image/png", "x")).pixels, undefined);
	assert.equal(parseBmp(Buffer.from("BM")), undefined);
});

// Where there is no sips (Linux), ffmpeg makes the copies. Runs wherever ffmpeg is installed.
const hasFfmpeg = { skip: !["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", ...(process.env.PATH ?? "").split(":")].some((d) => fs.existsSync(path.join(d, "ffmpeg"))) };
test("pictures: ffmpeg converts where sips is missing", hasFfmpeg, async (t) => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pine-pic-test-")));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, "in"), png(64, 40));
	assert.ok(await scaled(dir, path.join(dir, "in"), 64, "bmp", "ffmpeg"));
	const same = parseBmp(fs.readFileSync(path.join(dir, "out.bmp")))!;
	assert.equal(`${same.width}x${same.height}`, "64x40");
	assert.deepEqual([...same.rgb.subarray(0, 3)], [220, 40, 40], "the colours and which way is up survive");
	assert.deepEqual([...same.rgb.subarray((39 * 64 + 63) * 3, (39 * 64 + 63) * 3 + 3)], [40, 60, 220]);
	assert.ok(await scaled(dir, path.join(dir, "in"), 32, "bmp", "ffmpeg"));
	const small = parseBmp(fs.readFileSync(path.join(dir, "out.bmp")))!;
	assert.equal(`${small.width}x${small.height}`, "32x20", "scaled by its longer side, the shape kept");
	assert.ok((await scaled(dir, path.join(dir, "in"), 32, "png", "ffmpeg")) && fs.readFileSync(path.join(dir, "out.png")).subarray(1, 4).toString() === "PNG");
	fs.writeFileSync(path.join(dir, "bad"), "not a picture at all");
	assert.equal(await scaled(dir, path.join(dir, "bad"), 32, "bmp", "ffmpeg"), false);
});

test("pictures: the daemon serves pictures to a UI and nothing else", async (t) => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pine-pic-test-")));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(dir, "outside.png"), png());
	const h = await harness({ pine: { http: { port: 0 } }, agents: { main: { files: { "pic.png": png().toString("latin1"), "notes.txt": "private notes" } } } });
	const ws = h.workspace("main");
	fs.writeFileSync(path.join(ws, "pic.png"), png());
	fs.writeFileSync(path.join(ws, "fake.png"), "this only has the name of a picture");
	fs.symlinkSync(path.join(dir, "outside.png"), path.join(ws, "link.png"));
	const client = new Client(`http://127.0.0.1:${h.pine.http!.port}`, h.pine.token);

	const ok = await client.workspaceImage("main", "pic.png");
	assert.ok(ok && ok.mime === "image/png" && ok.bytes.equals(png()));
	for (const bad of ["notes.txt", "fake.png", "link.png", path.join(dir, "outside.png"), "../../pine.json", "missing.png", ""]) assert.equal(await client.workspaceImage("main", bad), undefined, bad);
	assert.equal(await client.workspaceImage("nobody", "pic.png"), undefined);
	const anonymous = await fetch(`http://127.0.0.1:${h.pine.http!.port}/agents/main/image?path=pic.png`);
	assert.equal(anonymous.status, 401);

	// A picture a tool returned is kept and served by id; ids cannot wander off.
	fs.writeFileSync(path.join(ws, "shot.png"), png(32, 20));
	const events: any[] = [];
	h.pine.bus.subscribe("agent/main/tool", (e) => void events.push(e.payload));
	await h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: [{ name: "read", args: { path: "shot.png" } }] }]), ...owner });
	const end = events.find((e) => e.phase === "end");
	assert.equal(end.images?.length, 1, JSON.stringify(end));
	const kept = await client.toolImage(end.images[0]);
	assert.ok(kept && kept.bytes.equals(png(32, 20)));
	for (const bad of ["..%2F..%2Fhttp-token", "nothing-0-0", "a/b"]) assert.equal(await client.toolImage(bad), undefined, bad);
	const steps = h.pine.agents.transcript(h.pine.tasks.list({})[0].id)!.entries;
	assert.deepEqual(steps.find((s) => s.kind === "tool")?.images, end.images, "the same picture is listed in the task's transcript");

	// A picture that came with a message.
	const sent = h.pine.agents.submit({ agent: "main", prompt: "look", trust: "owner", attachments: [{ name: "photo.png", data: png(16, 16).toString("base64") }] });
	await h.pine.agents.wait(sent.id);
	if (h.pine.tasks.get(sent.id)!.meta.images?.length) assert.ok((await client.taskImage(sent.id, 0))!.bytes.equals(png(16, 16)));
	assert.equal(await client.taskImage(sent.id, 5), undefined);

	// Web pictures are fetched for the owner only from public https addresses.
	await assert.rejects(client.fetchImage(`http://127.0.0.1:${h.pine.http!.port}/health`), /only https/);
	await assert.rejects(client.fetchImage("https://127.0.0.1/x.png"), /private and local/);
	await assert.rejects(client.fetchImage("https://localhost/x.png"), /private and local/);
	await h.close();
});

async function open(spec: Parameters<typeof harness>[0]) {
	const h = await harness({ ...spec, pine: { main: "main", http: { port: 0 }, ...(spec.pine ?? {}) } });
	const term = new FakeTerminal(110, 44);
	const app = new PineTui({ client: new Client(`http://127.0.0.1:${h.pine.http!.port}`, h.pine.token), terminal: term });
	apps.push(app);
	await app.start();
	const text = () => app.screen().join("\n");
	const send = async (line: string) => {
		term.type(line);
		term.type([KEY.enter]);
		await sleep(15);
	};
	const sees = (what: string | RegExp, ms = 5000) => until(() => (typeof what === "string" ? text().includes(what) : what.test(text())), ms, `the screen to show ${what}\n--- screen ---\n${text()}`);
	return { h, term, app, text, send, sees, close: async () => (await app.stop(), await h.close()) };
}

test("pictures: an agent is told, in the tool's answer, that the picture a server made is already shown", async (t) => {
	const { httpMcp } = await import("./support/http-mcp.ts");
	const stub = await httpMcp({ picture: png(32, 20) });
	t.after(() => stub.close());
	const h = await harness({ agents: { main: { agent: { mcp: { media: { url: stub.url } } } } } });
	const events: any[] = [];
	h.pine.bus.subscribe("agent/main/tool", (e) => void events.push(e.payload));
	const told = /\[pine: your owner already sees the picture that came with this answer, above your reply\. Do not put it into your reply: no !\[\.\.\.\]\(\.\.\.\) and no link to it\. Fetch it with the download tool only if your owner asks for it as a file\.\]$/;

	// The answer of a server's tool that came with a picture says so, and the picture is the one shown.
	await h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: [{ name: "mcp__media__lookup", args: { q: "a shiba" } }] }]), ...owner });
	assert.match(h.toolResults().at(-1)!, /^looked up: a shiba/);
	assert.match(h.toolResults().at(-1)!, told);
	assert.equal(events.find((e) => e.phase === "end").images?.length, 1);

	// A picture the agent looked at itself is not one it was handed for its owner: nothing is added.
	fs.writeFileSync(path.join(h.workspace("main"), "shot.png"), png(32, 20));
	await h.pine.agents.run({ agent: "main", prompt: mockMsg([{ tools: [{ name: "read", args: { path: "shot.png" } }] }]), ...owner });
	assert.doesNotMatch(h.toolResults().at(-1)!, /\[pine: /);

	// An answer that goes to a chat: nothing was drawn there, so nothing is claimed.
	await h.pine.agents.run({ agent: "main", session: "chat", prompt: mockMsg([{ tools: [{ name: "mcp__media__lookup", args: { q: "a cat" } }] }]), reply: { topic: "out/chat" }, ...owner });
	assert.match(h.toolResults().at(-1)!, /^looked up: a cat/);
	assert.doesNotMatch(h.toolResults().at(-1)!, /\[pine: /);
	await h.close();
});

test("tui: pictures from a tool, in an answer and attached to a message are drawn; a web picture waits for a click", mac, async () => {
	const t = await open({ agents: { main: {} } });
	await t.sees("type a message");
	const ws = t.h.workspace("main");
	fs.writeFileSync(path.join(ws, "chart.png"), png(64, 40));

	// The agent reads a picture (a tool result) and points at it in its answer. A picture on the web is only named.
	await t.send(mockMsg([{ tools: [{ name: "read", args: { path: "chart.png" } }] }]));
	await t.sees("from read · 64×40 · click to enlarge");
	await t.send(mockMsg([{ text: "Here it is: ![the chart](chart.png) and one from the web ![logo](https://example.com/logo.png) and ![gone](nope.png)" }]));
	await t.sees("the chart · 64×40 · click to enlarge");
	await t.sees("▸ load picture https://example.com/logo.png");
	await t.sees("(no picture at nope.png in the workspace)");
	const blocks = (s: string) => s.split("▀").length - 1;
	const thumbnails = blocks(t.text());
	assert.ok(thumbnails >= 44 * 14 && thumbnails % 44 === 0, `thumbnails are 44 cells wide and at most 14 lines high (${thumbnails})`);
	assert.ok(!t.text().includes("logo ·"), "nothing was fetched from the web");
	const requests = t.h.mock.state.requests;
	assert.ok(!JSON.stringify(requests.at(-1).body.messages.filter((m: any) => m.role !== "tool")).includes("▀"), "the model is not shown the drawing");

	// A click enlarges, another shrinks.
	const row = () => t.app.screen().findIndex((l) => l.includes("the chart · 64×40"));
	t.term.click(5, row() - 3);
	await t.sees("the chart · 64×40 · click to shrink");
	assert.ok(blocks(t.text()) > thumbnails, "the enlarged picture takes more room");
	t.term.click(5, row() - 3);
	await t.sees("the chart · 64×40 · click to enlarge");

	// A dropped picture shows under the message it goes out with, and again when the conversation is reopened.
	const photo = path.join(fs.realpathSync(os.tmpdir()), `pine-photo-${Date.now()}.png`);
	fs.writeFileSync(photo, png(40, 40, [10, 200, 90], [10, 200, 90]));
	t.term.paste(photo);
	await t.sees("attached:");
	await t.send("what is this");
	await t.sees(`${path.basename(photo)} · 40×40 · click to enlarge`);
	await t.sees("ECHO[what is this");
	fs.rmSync(photo);
	await t.app.stop();
	const again = new PineTui({ client: t.app.client, terminal: new FakeTerminal(110, 60) });
	apps.push(again);
	await again.start();
	await until(() => again.screen().join("\n").includes("the chart · 64×40"), 5000, "the answer's picture after reopening");
	await again.stop();
	await t.h.close();
});

test("tui: on a terminal with the Kitty graphics protocol the real picture is sent", mac, async () => {
	const before = getCapabilities();
	setCapabilities({ ...before, images: "kitty" });
	try {
		const t = await open({ agents: { main: {} } });
		await t.sees("type a message");
		fs.writeFileSync(path.join(t.h.workspace("main"), "chart.png"), png(64, 40));
		await t.send(mockMsg([{ text: "![the chart](chart.png)" }]));
		await t.sees("the chart · 64×40 · click to enlarge");
		t.app.screen();
		assert.ok(t.term.written.includes("\x1b_G"), "a Kitty graphics command was written");
		assert.ok(!t.text().includes("▀"));
		await t.close();
	} finally {
		setCapabilities(before);
	}
});

test("tui: a menu opened over a real picture is not covered by it; the picture is drawn as text until the menu closes", mac, async () => {
	const before = getCapabilities();
	setCapabilities({ ...before, images: "kitty" });
	try {
		const t = await open({ agents: { main: {} } });
		await t.sees("type a message");
		fs.writeFileSync(path.join(t.h.workspace("main"), "chart.png"), png(64, 40));
		await t.send(mockMsg([{ text: "![the chart](chart.png)" }]));
		await t.sees("the chart · 64×40 · click to enlarge");
		const raw = () => (t.app.screen(), t.app.tui.getScreenLines());
		const real = (lines: string[]) => lines.filter((l) => l.includes("\x1b_G")).length;
		assert.equal(real(raw()), 1, "the real picture is on screen");
		assert.ok(!t.text().includes("▀"));

		// The list of conversations opens in the middle of the screen, across the picture.
		await t.send("/sessions");
		await t.sees("│ Conversations of main");
		const under = raw();
		assert.equal(real(under), 0, "no real picture lies under the menu");
		const shown = t.app.screen();
		assert.ok(shown.some((l) => l.includes("▀") && /[╭│]/.test(l)), "the menu really is over the picture, which is still there as text");
		const title = shown.findIndex((l) => l.includes("Conversations of main"));
		const bottom = shown.findIndex((l) => l.includes("╰"));
		assert.ok(shown.slice(title, bottom).every((l) => (l.match(/│/g) ?? []).length === 2), "every line of the menu is whole");

		// Closing the menu brings the real picture back.
		t.term.type([KEY.esc]);
		await until(() => !t.text().includes("Conversations of main"), 3000, "the menu to close");
		assert.equal(real(raw()), 1, "the real picture is back");
		assert.ok(!t.text().includes("▀"));
		await t.close();
	} finally {
		setCapabilities(before);
	}
});

const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].find((f) => fs.existsSync(f));

test("tui: a video plays by itself when it arrives, at the size it is shown; pause, play, enlarge and the player are separate clicks", { skip: !ffmpeg }, async () => {
	const { execFileSync } = await import("node:child_process");
	const opened: string[] = [];
	const h = await harness({ pine: { main: "main", http: { port: 0 } }, agents: { main: {} } });
	const term = new FakeTerminal(110, 60);
	const client = new Client(`http://127.0.0.1:${h.pine.http!.port}`, h.pine.token);
	const app = new PineTui({ client, terminal: term, openFile: (f) => void opened.push(f) });
	apps.push(app);
	await app.start();
	const text = () => app.screen().join("\n");
	const sees = (what: string | RegExp, ms = 6000) => until(() => (typeof what === "string" ? text().includes(what) : what.test(text())), ms, `the screen to show ${what}\n${text()}`);
	const ws = h.workspace("main");
	// A second and a half of a test pattern, 160 by 90.
	execFileSync(ffmpeg!, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10", "-t", "1.5", "-pix_fmt", "yuv420p", path.join(ws, "clip.mp4")]);
	fs.writeFileSync(path.join(ws, "fake.mp4"), "this is only named like a video");

	// The daemon serves real video files from the workspace, and nothing that only has the name.
	assert.equal((await client.workspaceImage("main", "clip.mp4"))?.mime, "video/mp4");
	assert.equal(await client.workspaceImage("main", "fake.mp4"), undefined);

	const blocks = () => text().split("▀").length - 1;
	const caption = () => app.screen().find((l) => l.includes("test pattern ·")) ?? "";
	const row = () => app.screen().findIndex((l) => l.includes("test pattern ·"));
	const clickWord = (word: string) => term.click(caption().indexOf(word) + 1, row());

	// It arrives and plays by itself, in the room a thumbnail takes.
	term.type(mockMsg([{ text: "Here is the clip: ![test pattern](clip.mp4)" }]));
	term.type([KEY.enter]);
	await sees(/‖ pause · test pattern · 0:00 \/ 0:01 · no sound · click the picture to enlarge\s+▸ open in player/);
	await until(() => blocks() > 0, 3000, "a frame");
	const small = blocks();
	assert.ok(small <= 44 * 14 && small % 44 === 0, `frames are thumbnail-sized (${small})`);

	// Pause holds the frame; play goes on from there.
	clickWord("‖ pause");
	await sees(/▶ play · test pattern · 0:00 \/ 0:01/);
	const held = text();
	await sleep(350);
	assert.equal(text(), held, "nothing moves while it is paused");
	clickWord("▶ play");
	await sees("‖ pause");
	await sees(/▶ play · test pattern · 0:01 · click the picture to enlarge/, 8000);
	assert.equal(blocks(), small, "at the end the still is back, the same size");

	// A click on the picture enlarges it and does not start it. Play then plays it large.
	term.click(6, row() - 2);
	await sees("click the picture to shrink");
	await until(() => blocks() > small, 3000, "the larger still");
	assert.match(caption(), /▶ play/);
	const large = blocks();
	clickWord("▶ play");
	await sees("‖ pause");
	await until(() => /0:00 \/ 0:01/.test(caption()) && blocks() >= large, 3000, "large frames");
	// Shrinking while it plays keeps it playing.
	term.click(6, row() - 2);
	await sees("click the picture to enlarge");
	assert.match(caption(), /‖ pause|▶ play/);
	await sees(/▶ play · test pattern · 0:01 · click the picture to enlarge/, 8000);

	// "open in player" hands over a file with the video in it.
	clickWord("open in player");
	await until(() => opened.length === 1, 2000, "the player to be asked");
	assert.ok(fs.readFileSync(opened[0]).equals(fs.readFileSync(path.join(ws, "clip.mp4"))));
	const kept = opened[0];
	await app.stop();
	assert.ok(!fs.existsSync(kept), "the copy made for playing is removed when the UI closes");

	// Reopened later, the video is there but waits for a click.
	const again = new PineTui({ client, terminal: new FakeTerminal(110, 60) });
	apps.push(again);
	await again.start();
	await until(() => again.screen().join("\n").includes("▶ play · test pattern · 0:01"), 6000, "the video after reopening");
	await sleep(300);
	assert.ok(!again.screen().join("\n").includes("‖ pause"));
	await again.stop();
	await h.close();
});

test("tui: on a terminal with the Kitty graphics protocol a video plays as real pictures, each frame replacing the last", { skip: !ffmpeg }, async () => {
	const { execFileSync } = await import("node:child_process");
	const { pngFromRgb } = await import("../src/tui/picture.ts");
	// The frame encoder writes a valid png: a decoder reads it back with the right size.
	const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pine-png-"));
	fs.writeFileSync(path.join(dir, "f.png"), pngFromRgb(new Uint8Array(6 * 4 * 3).fill(200), 6, 4));
	assert.equal(execFileSync(path.join(path.dirname(ffmpeg!), "ffprobe"), ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", path.join(dir, "f.png")]).toString().trim(), "6,4");
	fs.rmSync(dir, { recursive: true, force: true });

	const before = getCapabilities();
	setCapabilities({ ...before, images: "kitty" });
	try {
		const t = await open({ agents: { main: {} } });
		await t.sees("type a message");
		execFileSync(ffmpeg!, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10", "-t", "1", "-pix_fmt", "yuv420p", path.join(t.h.workspace("main"), "clip.mp4")]);
		await t.send(mockMsg([{ text: "![test pattern](clip.mp4)" }]));
		await t.sees("‖ pause · test pattern");
		// A menu over a paused frame: the frame is drawn as text under it, and is a real picture again afterwards.
		const raw = () => (t.app.screen(), t.app.tui.getScreenLines());
		t.term.click(2, t.app.screen().findIndex((l) => l.includes("‖ pause · test pattern")));
		await t.sees(/▶ play · test pattern · 0:0\d \/ /);
		assert.ok(raw().some((l) => l.includes("\x1b_G")), "the paused frame is a real picture");
		await t.send("/sessions");
		await t.sees("│ Conversations of main");
		const under = raw();
		const shown = t.app.screen();
		assert.ok(shown.some((l) => l.includes("▀") && /[╭│]/.test(l)), "the menu is over the video");
		assert.ok(!under.some((l) => l.includes("\x1b_G")) && t.text().includes("▀"), "the frame is text while the menu is over it");
		t.term.type([KEY.esc]);
		await until(() => !t.text().includes("Conversations of main"), 3000, "the menu to close");
		assert.ok(raw().some((l) => l.includes("\x1b_G")) && !t.text().includes("▀"), "the real frame is back");
		t.term.click(2, t.app.screen().findIndex((l) => l.includes("▶ play · test pattern")));
		// Count the pictures sent while it plays, and under which image ids.
		const sent = new Map<string, number>();
		let seen = 0;
		const collect = () => {
			t.app.screen();
			const fresh = t.term.written.slice(seen);
			seen = t.term.written.length;
			for (const m of fresh.matchAll(/\x1b_Ga=T[^;]*?i=(\d+)/g)) sent.set(m[1], (sent.get(m[1]) ?? 0) + 1);
			assert.ok(!t.text().includes("▀"), "no half blocks on a terminal that shows real pictures");
		};
		await until(() => (collect(), t.text().includes("▶ play · test pattern · 0:01")), 8000, "the video to play to its end");
		const most = Math.max(...sent.values());
		assert.ok(most >= 5, `frames were sent as pictures under one image id (${[...sent.values()].join(", ")})`);
		await t.close();
	} finally {
		setCapabilities(before);
	}
});
