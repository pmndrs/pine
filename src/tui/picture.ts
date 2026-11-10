import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { allocateImageId, type Component, getCapabilities, getCellDimensions, getImageDimensions, Image, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { c } from "./theme.ts";

/**
 * Pictures in the conversation. Display only: nothing here is sent to a model.
 *
 * Two ways to draw one. A terminal with the Kitty graphics protocol (kitty, Ghostty, WezTerm) gets
 * the real picture. Every other terminal gets coloured half blocks: each character cell shows two
 * pixels, one as the colour of "▀" and one as its background. For that the picture has to be
 * decoded and scaled, which macOS's own `sips` does; it also turns jpg, gif and webp into the png
 * the Kitty protocol wants.
 */

export interface Pixels {
	width: number;
	height: number;
	/** width * height * 3 bytes, rows from the top. */
	rgb: Uint8Array;
}

export interface Prepared {
	name: string;
	widthPx: number;
	heightPx: number;
	/** Base64 png, scaled down to at most 1200 pixels on its longer side. */
	png?: string;
	/** A small copy for the half-block drawing. */
	pixels?: Pixels;
}

const SIPS = "/usr/bin/sips";
const hasSips = process.platform === "darwin" && fs.existsSync(SIPS);

const TMP = fs.realpathSync(os.tmpdir());

/**
 * Start a converter (sips, ffmpeg) on bytes that can come from anywhere: it gets no network and
 * may write only in the temp folder (sips keeps scratch files of its own there).
 */
function confined(command: string, args: string[], stdio: "ignore" | "pipe", cwd = TMP): ChildProcess {
	if (process.platform !== "darwin") return spawn(command, args, { cwd, stdio: ["ignore", stdio, "ignore"] });
	const profile = `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath "${TMP.replace(/["\\]/g, "\\$&")}") (literal "/dev/null"))`;
	return spawn("/usr/bin/sandbox-exec", ["-p", profile, command, ...args], { cwd, stdio: ["ignore", stdio, "ignore"] });
}

function sips(dir: string, args: string[]): Promise<boolean> {
	return new Promise((resolve) => {
		const child = confined(SIPS, args, "ignore", dir);
		const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
		child.on("error", () => (clearTimeout(timer), resolve(false)));
		child.on("close", (code) => (clearTimeout(timer), resolve(code === 0)));
	});
}

/** Read an uncompressed 24 or 32 bit BMP, the simplest format sips writes. Transparent parts are shown on dark grey. */
export function parseBmp(b: Buffer): Pixels | undefined {
	if (b.length < 54 || b.toString("latin1", 0, 2) !== "BM") return undefined;
	const offset = b.readUInt32LE(10);
	const width = b.readInt32LE(18);
	const rawHeight = b.readInt32LE(22);
	const height = Math.abs(rawHeight);
	const bpp = b.readUInt16LE(28);
	const compression = b.readUInt32LE(30);
	if (width <= 0 || height <= 0 || width > 4096 || height > 4096 || (bpp !== 24 && bpp !== 32) || (compression !== 0 && compression !== 3)) return undefined;
	const bytes = bpp / 8;
	const stride = Math.ceil((width * bytes) / 4) * 4;
	if (b.length < offset + stride * height) return undefined;
	// Where each channel sits in a pixel. With "bitfields" the header says; otherwise it is blue, green, red(, alpha).
	const at = (mask: number, fallback: number) => (mask === 0xff ? 0 : mask === 0xff00 ? 1 : mask === 0xff0000 ? 2 : mask === 0xff000000 ? 3 : fallback);
	const fields = compression === 3 && b.length >= 70;
	const r = fields ? at(b.readUInt32LE(54), 2) : 2;
	const g = fields ? at(b.readUInt32LE(58), 1) : 1;
	const bl = fields ? at(b.readUInt32LE(62), 0) : 0;
	const a = bpp === 32 ? (fields ? at(b.readUInt32LE(66), 3) : 3) : -1;
	const rgb = new Uint8Array(width * height * 3);
	for (let y = 0; y < height; y++) {
		const row = offset + (rawHeight < 0 ? y : height - 1 - y) * stride;
		for (let x = 0; x < width; x++) {
			const p = row + x * bytes;
			const alpha = a >= 0 ? b[p + a] / 255 : 1;
			const o = (y * width + x) * 3;
			rgb[o] = Math.round(b[p + r] * alpha + 30 * (1 - alpha));
			rgb[o + 1] = Math.round(b[p + g] * alpha + 30 * (1 - alpha));
			rgb[o + 2] = Math.round(b[p + bl] * alpha + 30 * (1 - alpha));
		}
	}
	return { width, height, rgb };
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Make a picture ready to draw. Returns what could be made: without sips (not macOS) a png still
 * shows on a Kitty-protocol terminal, and anything else is shown as a line of text.
 */
export function prepare(bytes: Buffer, mime: string, name: string): Promise<Prepared> {
	// One at a time: a page full of pictures should not start a dozen converters at once.
	const job = queue.then(() => convert(bytes, mime, name));
	queue = job.catch(() => {});
	return job;
}

async function convert(bytes: Buffer, mime: string, name: string): Promise<Prepared> {
	const dims = getImageDimensions(bytes.subarray(0, 512 * 1024).toString("base64"), mime) ?? { widthPx: 0, heightPx: 0 };
	const out: Prepared = { name, widthPx: dims.widthPx, heightPx: dims.heightPx };
	if (!hasSips) {
		if (mime === "image/png") out.png = bytes.toString("base64");
		return out;
	}
	const dir = fs.mkdtempSync(path.join(TMP, "pine-pic-"));
	try {
		const source = path.join(dir, "in");
		fs.writeFileSync(source, bytes, { mode: 0o600 });
		const kitty = getCapabilities().images === "kitty";
		// sips scales to the size it is given, also upwards; a small picture stays as small as it is.
		const longest = Math.max(dims.widthPx, dims.heightPx) || 1200;
		const fit = (limit: number) => String(Math.min(limit, longest));
		if (kitty && (await sips(dir, ["-s", "format", "png", "-Z", fit(1200), source, "--out", path.join(dir, "out.png")]))) out.png = fs.readFileSync(path.join(dir, "out.png")).toString("base64");
		// The small copy is made in both cases: it is cheap, and it is what shows if the real picture cannot.
		if (await sips(dir, ["-s", "format", "bmp", "-Z", fit(240), source, "--out", path.join(dir, "out.bmp")])) out.pixels = parseBmp(fs.readFileSync(path.join(dir, "out.bmp")));
	} catch {
		// shown as text
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	return out;
}

/** Average colour of a rectangle of the source, for scaling down without speckle. */
function sample(p: Pixels, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
	const ax = Math.max(0, Math.min(p.width - 1, Math.floor(x0)));
	const bx = Math.max(ax + 1, Math.min(p.width, Math.ceil(x1)));
	const ay = Math.max(0, Math.min(p.height - 1, Math.floor(y0)));
	const by = Math.max(ay + 1, Math.min(p.height, Math.ceil(y1)));
	let r = 0;
	let g = 0;
	let b = 0;
	for (let y = ay; y < by; y++) {
		for (let x = ax; x < bx; x++) {
			const o = (y * p.width + x) * 3;
			r += p.rgb[o];
			g += p.rgb[o + 1];
			b += p.rgb[o + 2];
		}
	}
	const n = (bx - ax) * (by - ay);
	return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

const cube = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));

/** Draw a picture with half blocks, at most `maxCols` cells wide and `maxRows` lines high. */
export function halfBlocks(p: Pixels, maxCols: number, maxRows: number, trueColor = true): string[] {
	// A character cell is about twice as high as wide, so half a cell is about a square pixel.
	let cols = Math.max(1, Math.min(maxCols, p.width));
	let rows = Math.max(1, Math.ceil((cols * p.height) / p.width / 2));
	if (rows > maxRows) {
		rows = Math.max(1, maxRows);
		cols = Math.max(1, Math.min(maxCols, Math.round((rows * 2 * p.width) / p.height)));
	}
	const sx = p.width / cols;
	const sy = p.height / (rows * 2);
	const paint = ([r, g, b]: [number, number, number], back: boolean) => (trueColor ? `\x1b[${back ? 48 : 38};2;${r};${g};${b}m` : `\x1b[${back ? 48 : 38};5;${16 + 36 * cube(r) + 6 * cube(g) + cube(b)}m`);
	const lines: string[] = [];
	for (let y = 0; y < rows; y++) {
		let line = " ";
		for (let x = 0; x < cols; x++) line += `${paint(sample(p, x * sx, y * 2 * sy, (x + 1) * sx, (y * 2 + 1) * sy), false)}${paint(sample(p, x * sx, (y * 2 + 1) * sy, (x + 1) * sx, (y * 2 + 2) * sy), true)}▀`;
		lines.push(`${line}\x1b[0m`);
	}
	return lines;
}

// ---- pictures under menus -----------------------------------------------------------------------
// A terminal draws a real picture on a layer of its own, above the text. A menu that opens over
// one is text, so the picture would lie across it. While something covers a picture, the screen
// therefore draws that picture as half blocks, which are text like the menu, and puts the menu on
// top; the real picture is back as soon as nothing covers it.

interface DrawsAsText {
	/** The picture with this image id as text, `cols` cells wide and exactly as many lines as the real one takes. */
	blocks(id: number, cols: number): string[];
}
const drawn = new Map<number, WeakRef<DrawsAsText>>();
function drawsAsText(id: number | undefined, owner: DrawsAsText): void {
	if (id === undefined || drawn.get(id)?.deref() === owner) return;
	if (drawn.size > 400) for (const [key, ref] of drawn) if (!ref.deref()) drawn.delete(key);
	drawn.set(id, new WeakRef(owner));
}

/** Half blocks in the room of a real picture: at most `cols` cells wide, exactly `rows` lines. */
function inPlaceOf(pixels: Pixels | undefined, cols: number, rows: number): string[] {
	const lines = pixels && rows > 0 ? halfBlocks(pixels, Math.max(1, cols - 1), rows, getCapabilities().trueColor) : [];
	while (lines.length < rows) lines.push("");
	return lines;
}

/**
 * The lines of a screen, with every real picture that `covered` says something lies over drawn as
 * text instead. `covered` gets the picture's place: its first line and column, its width and height.
 * Returns the same array when no picture is covered.
 */
export function picturesAsText(lines: string[], covered: (row: number, col: number, width: number, height: number) => boolean): string[] {
	let out = lines;
	for (let row = 0; row < lines.length; row++) {
		if (!lines[row].includes("\x1b_G")) continue;
		const controls = /\x1b_G([^;]*);/.exec(lines[row])?.[1];
		if (controls === undefined) continue;
		const value = (key: string) => {
			const m = new RegExp(`(?:^|,)${key}=(\\d+)`).exec(controls);
			return m ? Number(m[1]) : undefined;
		};
		const cols = value("c") ?? 1;
		const rows = value("r") ?? 1;
		if (!covered(row, 0, cols, rows)) continue;
		const whole = drawn.get(value("i") ?? 0)?.deref()?.blocks(value("i") ?? 0, cols) ?? [];
		// A picture that the top of the view cuts off shows its lower lines, any other its upper ones.
		const text = (value("y") ?? 0) > 0 ? whole.slice(-rows) : whole.slice(0, rows);
		if (out === lines) out = [...lines];
		for (let i = 0; i < rows && row + i < out.length; i++) out[row + i] = text[i] ?? "";
	}
	return out;
}

/** One picture in the conversation: a thumbnail that a click enlarges and a second click shrinks again. */
export class Picture implements Component {
	private p: Prepared;
	private large = false;
	private images = new Map<boolean, Image>();
	private cache?: { key: string; lines: string[] };

	constructor(prepared: Prepared) {
		this.p = prepared;
	}

	invalidate(): void {
		this.cache = undefined;
		for (const image of this.images.values()) image.invalidate();
	}

	handleMouse(e: any) {
		if (e.button !== "left" || (e.type !== "press" && e.type !== "click" && e.type !== "release")) return undefined;
		if (e.type === "click") {
			this.large = !this.large;
			this.invalidate();
		}
		return { handled: true, render: true };
	}

	/** The drawing itself, without a caption: the real picture where the terminal can show one, half blocks otherwise, nothing if neither works. */
	body(width: number, large = this.large): string[] {
		const caps = getCapabilities();
		const maxCols = Math.max(4, Math.min(width - 2, large ? 140 : 44));
		const maxRows = large ? 48 : 14;
		if (caps.images === "kitty" && this.p.png) {
			let image = this.images.get(large);
			if (!image) {
				image = new Image(this.p.png, "image/png", { fallbackColor: c.gray }, { maxWidthCells: maxCols, maxHeightCells: maxRows, filename: this.p.name });
				this.images.set(large, image);
			}
			const lines = image.render(width);
			drawsAsText(image.getImageId(), this);
			return lines;
		}
		return this.p.pixels ? halfBlocks(this.p.pixels, maxCols, maxRows, caps.trueColor) : [];
	}

	blocks(id: number, cols: number): string[] {
		const image = [...this.images.values()].find((i) => i.getImageId() === id);
		return inPlaceOf(this.p.pixels, cols, (image as any)?.cachedLines?.length ?? 0);
	}

	render(width: number): string[] {
		const caps = getCapabilities();
		const key = `${width}:${this.large}:${caps.images}`;
		if (this.cache?.key === key) return this.cache.lines;
		const size = this.p.widthPx ? ` · ${this.p.widthPx}×${this.p.heightPx}` : "";
		const body = this.body(width);
		const caption = body.length ? `${this.p.name}${size} · click to ${this.large ? "shrink" : "enlarge"}` : `[picture: ${this.p.name}${size}; it cannot be drawn in this terminal]`;
		const lines = [...body, truncateToWidth(c.gray(` ${caption}`), width)];
		this.cache = { key, lines };
		return lines;
	}
}

/** A place in the conversation that is filled in later, so a picture lands where it belongs however long it takes to load. */
export class Slot implements Component {
	inner?: Component;
	invalidate(): void {
		this.inner?.invalidate();
	}
	handleMouse(e: any) {
		return this.inner?.handleMouse?.(e);
	}
	render(width: number): string[] {
		return this.inner ? this.inner.render(width) : [];
	}
}

// ---- video ---------------------------------------------------------------------------------------
// A video shows its first moment as a picture. A click plays it in place, drawn with half blocks
// (which every terminal can do, frame after frame) and without sound; "open in player" hands the
// file to the system's player for the real thing. Decoding is ffmpeg's job; without ffmpeg there is
// a still from Quick Look and the player.

const findTool = (name: string) => [...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map((d) => path.join(d, name)).find((f) => d_exists(f));
function d_exists(f: string): boolean {
	try {
		return fs.statSync(f).isFile();
	} catch {
		return false;
	}
}
const FFMPEG = findTool("ffmpeg");
const FFPROBE = findTool("ffprobe");
/** Whether videos can be played in the conversation (ffmpeg is installed). */
export const canPlayVideo = Boolean(FFMPEG);

const finished = (child: ChildProcess, ms: number) =>
	new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => child.kill("SIGKILL"), ms);
		child.on("error", () => (clearTimeout(timer), resolve(false)));
		child.on("close", (code) => (clearTimeout(timer), resolve(code === 0)));
	});

export interface PreparedVideo {
	file: string;
	name: string;
	seconds?: number;
	poster: Prepared;
}

/** Get a video file ready to show: a still from its start, and how long it runs. */
export async function prepareVideo(file: string, name: string): Promise<PreparedVideo> {
	const dir = fs.mkdtempSync(path.join(TMP, "pine-pic-"));
	let poster: Prepared = { name, widthPx: 0, heightPx: 0 };
	let seconds: number | undefined;
	try {
		const still = path.join(dir, "poster.png");
		if (FFMPEG) await finished(confined(FFMPEG, ["-loglevel", "error", "-y", "-i", file, "-frames:v", "1", "-vf", "scale='min(1200,iw)':-2", still], "ignore"), 20_000);
		if (!d_exists(still) && process.platform === "darwin") {
			// Quick Look writes "<file name>.png" into the folder it is given.
			await finished(confined("/usr/bin/qlmanage", ["-t", "-s", "1200", "-o", dir, file], "ignore"), 20_000);
			const made = fs.readdirSync(dir).find((f) => f.endsWith(".png"));
			if (made) fs.renameSync(path.join(dir, made), still);
		}
		if (d_exists(still)) poster = await prepare(fs.readFileSync(still), "image/png", name);
		if (FFPROBE) {
			const probe = confined(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], "pipe");
			let out = "";
			probe.stdout?.on("data", (d) => (out += d));
			if (await finished(probe, 10_000)) seconds = Number.parseFloat(out) || undefined;
		}
	} catch {
		// shown without a still
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	return { file, name, seconds, poster };
}

/** A png from raw pixels (3 bytes each, rows from the top): what the Kitty graphics protocol takes. Fast, lightly compressed. */
export function pngFromRgb(rgb: Uint8Array, width: number, height: number): Buffer {
	const stride = width * 3;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
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
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", zlib.deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

const FPS = 10;
let playing: Video | undefined;

/**
 * One video in the conversation. It plays at the size it is shown in. The picture itself is the
 * size switch (click to enlarge, click to shrink), the first word of the caption is play and pause.
 *
 * Frames are drawn the way pictures are: as real images where the terminal has the Kitty graphics
 * protocol (each frame replaces the last under one image id), as half blocks everywhere else.
 */
export class Video implements Component {
	private v: PreparedVideo;
	private still: Picture;
	private redraw: () => void;
	private open: (file: string) => void;
	private child?: ChildProcess;
	private ticker?: NodeJS.Timeout;
	private frame?: Pixels;
	/** The current frame as a real image, on terminals that can show one. */
	private shown?: Image;
	private imageId = allocateImageId();
	private paused = false;
	private large = false;
	/** Seconds of the video shown so far. */
	private position = 0;
	private width = 80;
	private captionRow = -1;
	/** The lines the frame takes on screen. */
	private shownRows = 0;
	private playTo = -1;
	private openFrom = -1;

	constructor(video: PreparedVideo, redraw: () => void, open: (file: string) => void) {
		this.v = video;
		this.still = new Picture(video.poster);
		this.redraw = redraw;
		this.open = open;
	}

	invalidate(): void {
		this.still.invalidate();
	}

	get state(): "idle" | "playing" | "paused" {
		return !this.child ? "idle" : this.paused ? "paused" : "playing";
	}

	/** The cells a frame fills: the same room the still takes at the current size, in the video's own shape. */
	private size(): { cols: number; rows: number } {
		const maxCols = Math.max(8, Math.min(this.width - 2, this.large ? 140 : 44));
		const maxRows = this.large ? 48 : 14;
		const shape = this.v.poster.widthPx && this.v.poster.heightPx ? this.v.poster.heightPx / this.v.poster.widthPx : 9 / 16;
		const rows = Math.max(1, Math.ceil((maxCols * shape) / 2));
		return rows <= maxRows ? { cols: maxCols, rows } : { cols: Math.max(8, Math.min(maxCols, Math.round((maxRows * 2) / shape))), rows: maxRows };
	}

	/**
	 * The pixels to decode a frame at. For half blocks: one pixel per half cell. For real images: as
	 * many pixels as those cells have on screen, up to a width that a terminal takes ten times a second.
	 */
	private pixels(real: boolean): { cols: number; rows: number; width: number; height: number } {
		const { cols, rows } = this.size();
		if (!real) return { cols, rows, width: cols, height: rows * 2 };
		const cell = getCellDimensions();
		const shape = this.v.poster.widthPx && this.v.poster.heightPx ? this.v.poster.heightPx / this.v.poster.widthPx : 9 / 16;
		const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
		const width = even(Math.min(cols * cell.widthPx, this.large ? 720 : 480, this.v.poster.widthPx || 720));
		return { cols, rows, width, height: even(width * shape) };
	}

	/** Play, or go on after a pause. At the end it starts over. */
	play(): void {
		if (!FFMPEG) return;
		if (this.child) {
			this.paused = false;
			return this.redraw();
		}
		if (playing && playing !== this) playing.stop();
		playing = this;
		this.start(0, false);
	}

	pause(): void {
		if (!this.child || this.paused) return;
		this.paused = true;
		this.redraw();
	}

	/** Decode from `from` seconds on, at the current size. `hold`: show one frame and stay paused there. */
	private start(from: number, hold: boolean): void {
		this.child?.kill("SIGKILL");
		clearInterval(this.ticker);
		const real = getCapabilities().images === "kitty";
		const { cols, rows, width, height } = this.pixels(real);
		const size = width * height * 3;
		// ffmpeg decodes as fast as it can; the pace is kept here. A few frames are held ready, and
		// ffmpeg waits (its output pipe fills up) while there are enough, which is also what a pause is.
		const child = confined(FFMPEG!, ["-loglevel", "error", ...(from > 0 ? ["-ss", from.toFixed(2)] : []), "-i", this.v.file, "-an", "-vf", `fps=${FPS},scale=${width}:${height}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], "pipe");
		this.child = child;
		this.position = from;
		this.paused = hold;
		let wanted = hold ? 1 : 0;
		const ready: Uint8Array[] = [];
		let pending: Buffer = Buffer.alloc(0);
		let ended = false;
		child.stdout?.on("data", (d: Buffer) => {
			pending = pending.length ? Buffer.concat([pending, d]) : d;
			while (pending.length >= size) {
				ready.push(new Uint8Array(pending.subarray(0, size)));
				pending = pending.subarray(size);
			}
			if (ready.length > 8) child.stdout?.pause();
		});
		child.on("error", () => (ended = true));
		child.on("close", () => (ended = true));
		const ticker = setInterval(() => {
			if (this.child !== child) return clearInterval(ticker);
			if (this.paused && !wanted) return;
			const rgb = ready.shift();
			if (rgb) {
				this.frame = { width, height, rgb };
				// The same image id every time: the terminal replaces the picture in place.
				this.shown = real ? new Image(pngFromRgb(rgb, width, height).toString("base64"), "image/png", { fallbackColor: c.gray }, { maxWidthCells: cols, maxHeightCells: rows, imageId: this.imageId }, { widthPx: width, heightPx: height }) : undefined;
				if (wanted) wanted--;
				else this.position += 1 / FPS;
				this.redraw();
			} else if (ended) this.stop();
			if (ready.length < 4) child.stdout?.resume();
		}, 1000 / FPS);
		ticker.unref?.();
		this.ticker = ticker;
		this.redraw();
	}

	/** Back to the still. */
	stop(): void {
		const child = this.child;
		clearInterval(this.ticker);
		this.child = undefined;
		this.frame = undefined;
		this.shown = undefined;
		this.paused = false;
		this.position = 0;
		if (playing === this) playing = undefined;
		child?.kill("SIGKILL");
		this.redraw();
	}

	private resize(): void {
		this.large = !this.large;
		this.still.invalidate();
		// A video that is running or paused carries on where it is, at the new size.
		if (this.child) this.start(this.position, this.paused);
		else this.redraw();
	}

	handleMouse(e: any) {
		if (e.button !== "left" || (e.type !== "press" && e.type !== "click" && e.type !== "release")) return undefined;
		if (e.type === "click") {
			if (e.y !== this.captionRow) this.resize();
			else if (this.openFrom >= 0 && e.x >= this.openFrom) this.open(this.v.file);
			else if (e.x <= this.playTo) this.state === "playing" ? this.pause() : this.play();
		}
		return { handled: true, render: true };
	}

	blocks(_id: number, cols: number): string[] {
		return inPlaceOf(this.frame, cols, this.shownRows);
	}

	render(width: number): string[] {
		this.width = width;
		if (this.shown) drawsAsText(this.imageId, this);
		const body = this.shown ? this.shown.render(width) : this.frame ? halfBlocks(this.frame, this.frame.width, this.frame.height / 2, getCapabilities().trueColor) : this.still.body(width, this.large);
		const control = !FFMPEG ? "" : this.state === "playing" ? "‖ pause" : "▶ play";
		const total = this.v.seconds ? clock(this.v.seconds) : "";
		const time = this.child ? `${clock(this.position)}${total ? ` / ${total}` : ""} · no sound` : total;
		const left = ` ${control ? `${c.accent(control)} ` : ""}${c.gray(`${control ? "· " : ""}${this.v.name}${time ? ` · ${time}` : ""} · click the picture to ${this.large ? "shrink" : "enlarge"}`)}`;
		this.captionRow = body.length;
		this.shownRows = body.length;
		this.playTo = control ? 1 + visibleWidth(control) : -1;
		this.openFrom = visibleWidth(left) + 3;
		return [...body, truncateToWidth(`${left}   ${c.accent("▸ open in player")}`, width)];
	}
}

/** Stop whatever video is playing, for example when the UI closes. */
export function stopVideos(): void {
	playing?.stop();
}

const VIDEO_FILE = /\.(mp4|m4v|mov|webm|mkv)$/i;
export const isVideoFile = (name: string) => VIDEO_FILE.test(name);

const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;
export const isImageFile = (name: string) => IMAGE_FILE.test(name);
export const mimeOf = (name: string) => (/\.png$/i.test(name) ? "image/png" : /\.jpe?g$/i.test(name) ? "image/jpeg" : /\.gif$/i.test(name) ? "image/gif" : /\.webp$/i.test(name) ? "image/webp" : "");

export interface PictureRef {
	caption: string;
	target: string;
	remote: boolean;
}

/** The pictures an answer points at with ![caption](target). Code blocks are left alone. */
export function picturesIn(markdown: string, max = 6): PictureRef[] {
	const text = markdown.replace(/```[\s\S]*?(```|$)/g, "").replace(/`[^`\n]*`/g, "");
	const found: PictureRef[] = [];
	for (const m of text.matchAll(/!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g)) {
		let target = m[2];
		if (/^data:/i.test(target)) continue;
		const remote = /^https?:\/\//i.test(target);
		if (!remote) {
			if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^file:/i.test(target)) continue;
			target = target.replace(/^file:\/\//i, "");
			try {
				target = decodeURIComponent(target);
			} catch {
				// keep it as written
			}
		}
		if (!found.some((f) => f.target === target)) found.push({ caption: m[1].trim(), target, remote });
		if (found.length >= max) break;
	}
	return found;
}
