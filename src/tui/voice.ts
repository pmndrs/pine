// Dictating a message: the terminal UI's side of voice input.
//
// The words are recognised on the owner's own Mac by the system's speech recognition, through a
// small helper (voice.swift) that this file builds with `swiftc` on first use and keeps. Nothing
// is sent anywhere, and nothing of this runs in the daemon: the microphone is where the owner
// sits, which is where the UI runs.
//
// On a system that is not macOS there is no such recognition to use. Then nothing is built and
// nothing is started: `voiceTools()` says why in a sentence, and the UI shows that sentence.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const VOICE_SOURCE = path.join(import.meta.dirname, "voice.swift");

/**
 * What the helper says when the system asks the owner whether it may listen. A program without
 * these words is ended by the system the moment it asks for the microphone.
 */
const INFO = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.pine.voice</string>
<key>CFBundleName</key><string>pine voice</string>
<key>NSMicrophoneUsageDescription</key><string>pine listens while you dictate a message.</string>
<key>NSSpeechRecognitionUsageDescription</key><string>pine turns what you say into text for the message you are writing. The words are recognised on this Mac.</string>
</dict></plist>
`;

export const NOT_HERE = "Voice input needs a Mac: it uses the speech recognition that macOS has on the device. On this system pine works as before, by typing.";
export const NO_COMPILER = "Voice input needs Apple's command line developer tools, once, to build its helper, and they are not installed on this Mac. Install them by typing this into a terminal: xcode-select --install (macOS then shows a window to confirm). Then try again.";

type Run = (file: string, args: string[], ms: number) => Promise<{ code: number; stdout: string; stderr: string }>;

const runProgram: Run = (file, args, ms) =>
	new Promise((resolve) => {
		execFile(file, args, { timeout: ms, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ code: err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
	});

/**
 * The helper as a program: built from its source the first time, then found again by the
 * source's hash, so an update of pine builds a new one. Rejects with a sentence for the owner.
 */
export async function buildVoice(dir: string, source: string = VOICE_SOURCE, run: Run = runProgram): Promise<string> {
	const file = path.join(dir, `pine-voice-${createHash("sha256").update(fs.readFileSync(source)).update(INFO).digest("hex").slice(0, 12)}`);
	if (fs.existsSync(file)) return file;
	// /usr/bin/swiftc exists on every Mac, but without the tools it only opens a window that offers to install them.
	const tools = await run("/usr/bin/xcode-select", ["-p"], 10_000);
	if (tools.code !== 0 || !fs.existsSync(tools.stdout.trim())) throw new Error(NO_COMPILER);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	const info = `${tmp}.plist`;
	fs.writeFileSync(info, INFO);
	// Its reasons for listening are put into the program itself, where the system looks for them.
	const built = await run("/usr/bin/swiftc", ["-swift-version", "5", "-O", "-o", tmp, source, "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", info], 300_000);
	fs.rmSync(info, { force: true });
	if (built.code !== 0 || !fs.existsSync(tmp)) {
		fs.rmSync(tmp, { force: true });
		const why = built.stderr.split("\n").filter((l) => /error/i.test(l)).slice(0, 3).join(" | ") || built.stderr.trim().split("\n").slice(-2).join(" | ");
		throw new Error(`pine could not build its helper for voice input (${why.slice(0, 400) || "the compiler gave no reason"}). Apple's command line developer tools may be missing a part or need an update: xcode-select --install, or Software Update.`);
	}
	// Whole or not at all: another window of pine may be building the same program at this moment.
	fs.renameSync(tmp, file);
	for (const old of fs.readdirSync(dir)) if (old.startsWith("pine-voice-") && path.join(dir, old) !== file && !old.includes(".tmp")) fs.rmSync(path.join(dir, old), { force: true });
	return file;
}

/** How the UI gets something that listens. A test puts a stand-in here. */
export interface VoiceTools {
	/** Why there is no voice input here, in a sentence for the owner. Undefined: there is. */
	unavailable?: string;
	/** The command that listens: it writes what it hears as lines of JSON and ends when its input is closed. May take a while the first time (the helper is built). */
	program(): Promise<string[]>;
}

/** Voice input as this system has it: the helper on a Mac, a sentence everywhere else. */
export function voiceTools(platform: string = process.platform, dir = path.join(os.homedir(), "Library", "Caches", "pine-voice")): VoiceTools {
	if (platform !== "darwin") return { unavailable: NOT_HERE, program: () => Promise.reject(new Error(NOT_HERE)) };
	let built: Promise<string> | undefined;
	return { program: async () => [await (built ??= buildVoice(dir).catch((e) => ((built = undefined), Promise.reject(e))))] };
}

export interface Heard {
	/** Listening has begun. */
	ready?(): void;
	/** Everything heard so far. The end of it may still change. */
	partial(text: string): void;
	/** The system is fetching its speech model for the language, which it does once. */
	model?(state: string): void;
	/** Over: the whole text, or why it could not be done. Called once. */
	done(text: string | undefined, error?: string): void;
}

/**
 * One time of listening. `stop()` says "that was all": the helper finishes what it heard and
 * `done` gets the text. `cancel()` ends it and gives nothing.
 */
export class Listening {
	private child?: ChildProcess;
	private over = false;
	private last = "";
	private heard: Heard;

	constructor(command: string[], language: string | undefined, heard: Heard) {
		this.heard = heard;
		let child: ChildProcess;
		try {
			child = spawn(command[0], [...command.slice(1), ...(language ? ["--locale", language] : [])], { stdio: ["pipe", "pipe", "ignore"] });
		} catch (e) {
			this.end(undefined, `voice input could not be started (${e instanceof Error ? e.message : String(e)})`);
			return;
		}
		this.child = child;
		let buf = "";
		child.stdin?.on("error", () => {});
		child.stdout?.on("data", (d: Buffer) => {
			buf += d.toString("utf8");
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				this.line(buf.slice(0, i));
				buf = buf.slice(i + 1);
			}
		});
		child.on("error", (e) => this.end(undefined, `voice input could not be started (${e.message})`));
		// Ended without a last word: what was heard up to then is what there is.
		child.on("close", () => this.end(this.last || undefined, this.last ? undefined : "voice input ended without having heard anything"));
	}

	get active(): boolean {
		return !this.over;
	}

	stop(): void {
		this.child?.stdin?.end();
		// A helper that does not come to an end is ended, and what it had heard is kept.
		setTimeout(() => this.cancel(true), 8000).unref?.();
	}

	cancel(keep = false): void {
		if (this.over) return;
		const text = keep ? this.last : "";
		this.child?.kill();
		this.end(text || undefined, text || !keep ? undefined : "voice input did not finish");
	}

	private end(text: string | undefined, error?: string): void {
		if (this.over) return;
		this.over = true;
		this.heard.done(text, error);
	}

	private line(line: string): void {
		if (this.over || !line.startsWith("{")) return;
		let m: any;
		try {
			m = JSON.parse(line);
		} catch {
			return;
		}
		// Words from a microphone are text for a message, and are shown as text: nothing in them may move the cursor.
		const text = typeof m.text === "string" ? m.text.replace(/[\x00-\x1f\x7f]/g, " ").replace(/ {2,}/g, " ").trim() : "";
		if (m.type === "ready") this.heard.ready?.();
		else if (m.type === "model") this.heard.model?.(String(m.state ?? ""));
		else if (m.type === "partial") {
			this.last = text;
			this.heard.partial(text);
		} else if (m.type === "final") {
			this.child?.kill();
			this.end(text || undefined, text ? undefined : "nothing was heard");
		} else if (m.type === "error") {
			this.child?.kill();
			this.end(undefined, String(m.message ?? "voice input failed"));
		}
	}
}
