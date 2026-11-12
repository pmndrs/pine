// Draws the reel frame by frame in a headless browser and hands the frames to ffmpeg.
//
//   node reel/render.mjs                    the whole film -> reel/pine-reel.mp4
//   node reel/render.mjs --at 3.2,12,40     single frames  -> reel/frames/<seconds>.png
//   node reel/render.mjs --from 20 --to 30  a part of it   -> reel/pine-reel-part.mp4
//   node reel/render.mjs --at 1 --sound     only the sound -> reel/sfx.wav
// The whole film also gets its sound: one small sound per key and click, made by sound.py.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "../node_modules/playwright-core/index.mjs";

const dir = import.meta.dirname;
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const FPS = Number(arg("fps") ?? 30);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => { console.error("page error:", e.message); process.exitCode = 1; });
await page.goto(`file://${path.join(dir, "reel.html")}`);
// Everything a frame may show is loaded before the first one is drawn.
await page.evaluate(async () => {
	await document.fonts.load('24px "JBM"');
	await document.fonts.load('700 24px "JBM"');
	await document.fonts.ready;
	const names = ["meme.jpg", "cones.jpg", "logo.svg", "wallpaper.jpg", ...Array.from({ length: 40 }, (_, i) => `spag-${String(i).padStart(2, "0")}.jpg`)];
	window.keep = await Promise.all(names.map((n) => new Promise((done) => { const im = new Image(); im.onload = im.onerror = () => done(im); im.src = `assets/${n}`; })));
});
const duration = await page.evaluate(() => DURATION);
// When each key and each click happens, in film time; the sounds are made from that list.
const writeCues = async () => {
	const cues = await page.evaluate(() => SFX.map((s) => ({ t: s.t / SPEED, k: s.k })).sort((a, b) => a.t - b.t));
	fs.writeFileSync(path.join(dir, "sfx.json"), JSON.stringify({ duration, cues }));
};
const draw = async (t) => {
	await page.evaluate(async (time) => { renderAt(time); await Promise.all([...document.images].map((im) => im.decode().catch(() => {}))); }, t);
};

if (arg("at")) {
	fs.mkdirSync(path.join(dir, "frames"), { recursive: true });
	for (const s of arg("at").split(",")) {
		await draw(Number(s));
		await page.screenshot({ path: path.join(dir, "frames", `${Number(s).toFixed(2).padStart(6, "0")}.png`) });
	}
	console.log((await page.evaluate(() => MARKS.map(([t, name]) => `${(t / SPEED).toFixed(1).padStart(5)}  ${name}`))).join("\n"));
	console.log(`duration ${duration.toFixed(2)} s`);
	// With --sound, only the sound is made, to listen to it without drawing the film.
	if (process.argv.includes("--sound")) {
		await writeCues();
		await new Promise((done) => spawn("python3", [path.join(dir, "sound.py"), path.join(dir, "sfx.json"), path.join(dir, "sfx.wav")], { stdio: "inherit" }).on("close", done));
	}
} else {
	const from = Number(arg("from") ?? 0), to = Math.min(duration, Number(arg("to") ?? duration));
	const out = path.join(dir, arg("from") || arg("to") ? "pine-reel-part.mp4" : "pine-reel.mp4");
	const ffmpeg = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
	const frames = Math.round((to - from) * FPS);
	for (let i = 0; i < frames; i++) {
		await draw(from + i / FPS);
		const png = await page.screenshot({ type: "png" });
		if (!ffmpeg.stdin.write(png)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
		if (i % 150 === 0) console.log(`${(from + i / FPS).toFixed(1)} / ${to.toFixed(1)} s`);
	}
	ffmpeg.stdin.end();
	await new Promise((r) => ffmpeg.on("close", r));
	if (!arg("from") && !arg("to") && !process.argv.includes("--silent")) {
		await writeCues();
		const run = (cmd, args) => new Promise((done, fail) => spawn(cmd, args, { stdio: "inherit" }).on("close", (code) => (code ? fail(new Error(`${cmd} ended with ${code}`)) : done())));
		await run("python3", [path.join(dir, "sound.py"), path.join(dir, "sfx.json"), path.join(dir, "sfx.wav")]);
		const silent = path.join(dir, "pine-reel-silent.mp4");
		fs.renameSync(out, silent);
		await run("ffmpeg", ["-y", "-loglevel", "error", "-i", silent, "-i", path.join(dir, "sfx.wav"), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out]);
		fs.rmSync(silent);
	}
	console.log(`${out}  ${(to - from).toFixed(1)} s, ${frames} frames`);
}
await browser.close();
