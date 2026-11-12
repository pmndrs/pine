import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	Editor,
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	type OverlayHandle,
	fuzzyFilter,
	getCapabilities,
	HStack,
	hyperlink,
	ScrollView,
	setCapabilities,
	sliceByColumn,
	type AutocompleteItem,
	type AutocompleteProvider,
	type SelectItem,
	SelectList,
	type SlashCommand,
	Spacer,
	stripTerminalSequences,
	type Terminal,
	Text,
	truncateToWidth,
	TuiAltScreen,
	visibleWidth,
	VStack,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { TranscriptEntry } from "../types.ts";
import type { PineEvent, Task } from "../types.ts";
import { errText, expandHome, openInSystem } from "../util.ts";
import type { AgentInfo, Client, Conversation, GoalInfo } from "./client.ts";
import { CodePane, PANE_VIEWS, type PaneView } from "./code-pane.ts";
import { redoText, undoText } from "./undo.ts";
import { isImageFile, isVideoFile, mimeOf, Picture, picturesAsText, picturesIn, prepare, prepareVideo, Slot, stopVideos, Video } from "./picture.ts";
import { Answer, c, editorTheme, selectTheme, SPINNER } from "./theme.ts";

interface Tab {
	id: number;
	/** "task" shows the work of one sub-agent or delegated task; it takes no messages. */
	kind: "chat" | "events" | "task";
	agent: string;
	session: string;
	/** The folder of the owner's that this conversation works in, if one was opened for it. */
	folder?: string;
	/** The goal set for this conversation with /goal, as the daemon last reported it. */
	goal?: GoalInfo;
	/** For a task tab: the task it shows, and how deep that task sits under its conversation. */
	task?: number;
	baseDepth: number;
	/** Sub-agents and delegated tasks started from this tab, by task id. */
	children: Map<number, { agent: string; kind: string; label: string; running: boolean }>;
	doc: Container;
	scroll: ScrollView;
	layout: VStack;
	/** Top-level tasks shown in this tab, and the ones still running. */
	roots: Set<number>;
	running: Set<number>;
	/** Prompts sent from here whose task has not reported in yet. */
	awaiting: string[];
	/** The assistant message currently being streamed, per task. */
	blocks: Map<number, { md: Answer; text: string }>;
	/** What a task's model is thinking right now, per task. */
	thoughts: Map<number, Thought>;
	tools: Map<string, { line: Text; label: string }>;
	/** Text of the message a task streamed last, so a finished task's answer is not shown twice. */
	streamed: Map<number, string>;
	approvals: Map<string, { card: Text; req: any }>;
	unread: boolean;
	startedAt: number;
	toolCalls: number;
	tokens: { input: number; output: number; cached: number };
	thinking: boolean;
	lines: string[];
	log?: Text;
	/** How full the conversation's context window is, in percent, once known. */
	context?: number;
	/** Share of the last task's input that came from the model server's prompt cache, in percent. */
	cacheShare?: number;
	/** Files waiting to go out with the next message. */
	attachments: Array<{ path: string; name: string; size: number }>;
	/** The "bypass is paused here" note was shown already. */
	pauseNoted: boolean;
	/** The agent's last answer as it wrote it, for /copy. */
	lastAnswer?: string;
	/** The agent's list of steps as it is shown: the block, the task that wrote it, and the steps. */
	todo?: { block: Text; task: number; items: Array<{ text: string; status: string }> };
	/** Files of the conversation's folder that the "@" list offered here: what a mention in a message is checked against. */
	files: Set<string>;
	/** When esc last stopped something here, how many typed messages were waiting then, and the tasks they became. */
	stopped?: { at: number; waiting: number; spared: Set<number> };
}

/** Below this many columns the code pane takes the whole width instead of half of it. */
const SIDE_BY_SIDE = 100;

const RULE = Array.from({ length: 400 }, () => c.gray("│"));

const tilde = (p: string) => (p === os.homedir() ? "~" : p.startsWith(`${os.homedir()}/`) ? `~${p.slice(os.homedir().length)}` : p);

/** The library's name for "this component lays out children". */
const LAYOUT = Symbol.for("@earendil-works/pi-tui/layout-node");

/**
 * A conversation with the code pane beside it. The pane gets half the width (the library's own
 * sharing of free room is not an even split), or all of it where two halves would be too narrow.
 */
class Split extends HStack {
	private side: Component;
	private columns: () => number;
	constructor(main: Component, rule: Component, side: Component, open: () => boolean, columns: () => number) {
		super([
			{ component: main, basis: 0, grow: 1, shrink: 1, minSize: 1, visible: (v) => !(open() && v.width < SIDE_BY_SIDE) },
			{ component: rule, basis: 1, grow: 0, shrink: 0, visible: (v) => open() && v.width >= SIDE_BY_SIDE },
			{ component: side, basis: 0, grow: 1, shrink: 1, minSize: 1, visible: () => open() },
		]);
		this.side = side;
		this.columns = columns;
	}
	[LAYOUT](): any {
		const node = (HStack.prototype as any)[LAYOUT].call(this);
		const width = this.columns();
		if (width < SIDE_BY_SIDE) return node;
		const side = Math.max(44, Math.min(96, Math.floor(width / 2)));
		return { ...node, entries: node.entries.map((e: any) => (e.component === this.side ? { ...e, basis: side, grow: 0, shrink: 0 } : e)) };
	}
}

/**
 * What a conversation shows. A real picture can only be drawn at the left edge of a full line;
 * with a pane beside the conversation it would lie across that pane, so pictures are drawn as
 * text for as long as the pane is there.
 */
class Doc extends Container {
	asText: () => boolean = () => false;
	override render(width: number): string[] {
		const lines = super.render(width);
		return this.asText() ? picturesAsText(lines, () => true) : lines;
	}
}

/** A stretch of one screen line that reacts to a click. Columns are zero-based, `to` is exclusive. */
interface Hit {
	from: number;
	to: number;
	run(): void;
}

/** A one-line (or few-line) piece of chrome whose first line has clickable stretches. */
function clickable(render: (width: number) => string[], hits: () => Hit[], row = 0): Component {
	return {
		invalidate() {},
		render,
		handleMouse(e) {
			if (e.y !== row || e.button !== "left" || (e.type !== "press" && e.type !== "click" && e.type !== "release")) return undefined;
			const hit = hits().find((h) => e.x >= h.from && e.x < h.to);
			if (!hit) return undefined; // leave everything else to text selection
			if (e.type === "click") hit.run();
			return { handled: true, render: true };
		},
	};
}

/** Builds a line from pieces and remembers where the clickable ones ended up. */
class Line {
	text = "";
	width = 0;
	hits: Hit[] = [];
	add(styled: string, run?: () => void): this {
		const w = visibleWidth(styled);
		if (run) this.hits.push({ from: this.width, to: this.width + w, run });
		this.text += styled;
		this.width += w;
		return this;
	}
}

const MAX_ATTACHMENT = 20 * 1024 * 1024;

const URL_CHARS = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;

export interface LinkSpan {
	line: number;
	from: number;
	to: number;
	url: string;
}

/**
 * Web addresses in a block of plain screen lines, with the cells each one covers. A long address
 * is wrapped over several lines; a line that runs to the right edge is read together with the next,
 * and every piece of the address points to the whole of it.
 */
export function findLinks(lines: string[], width: number): LinkSpan[] {
	const full = (l: string) => visibleWidth(l.replace(/\s+$/, "")) >= width - 2;
	const out: LinkSpan[] = [];
	for (let first = 0; first < lines.length; ) {
		// One logical run: `first` and the lines it wraps into.
		const parts: Array<{ line: number; start: number; pad: number; text: string }> = [];
		let text = "";
		let i = first;
		for (; i < lines.length; i++) {
			const line = lines[i].replace(/\s+$/, "");
			const pad = i === first ? 0 : line.length - line.replace(/^ +/, "").length;
			parts.push({ line: i, start: text.length, pad, text: line.slice(pad) });
			text += line.slice(pad);
			if (!full(lines[i])) break;
		}
		for (const m of text.matchAll(/https?:\/\/[^\s<>"`]+/g)) {
			let url = m[0];
			while (url.length && (!URL_CHARS.test(url.at(-1)!) || /[.,;:!?'")\]]/.test(url.at(-1)!))) {
				// Closing punctuation belongs to the sentence, unless the address itself opened the bracket.
				if (url.at(-1) === ")" && url.split("(").length > url.split(")").length - 1) break;
				url = url.slice(0, -1);
			}
			if (url.length < 10) continue;
			const end = m.index + url.length;
			for (const part of parts) {
				const a = Math.max(m.index, part.start);
				const z = Math.min(end, part.start + part.text.length);
				if (a >= z) continue;
				const before = " ".repeat(part.pad) + part.text.slice(0, a - part.start);
				out.push({ line: part.line, from: visibleWidth(before), to: visibleWidth(before) + visibleWidth(part.text.slice(a - part.start, z - part.start)), url });
			}
		}
		first = Math.min(i, lines.length - 1) + 1;
	}
	return out;
}

/** The address under a cell, if any. */
export function urlAt(lines: string[], y: number, x: number, width: number): string | undefined {
	return findLinks(lines, width).find((l) => l.line === y && x >= l.from && x < l.to)?.url;
}

/**
 * Makes the web addresses in a component clickable. The text is not changed: an address is
 * always shown in full, and what is shown is what a click opens.
 */
class Linked implements Component {
	inner: Component;
	constructor(inner: Component) {
		this.inner = inner;
	}
	invalidate(): void {
		this.inner.invalidate();
	}
	handleMouse(e: any) {
		return this.inner.handleMouse?.(e);
	}
	render(width: number): string[] {
		const lines = this.inner.render(width);
		const spans = findLinks(lines.map((l) => stripTerminalSequences(l)), width);
		if (!spans.length) return lines;
		const out = [...lines];
		// Right to left, so earlier columns stay valid while a line is being rebuilt.
		for (const sp of spans.sort((p, q) => q.line - p.line || q.from - p.from)) {
			const line = out[sp.line];
			const total = visibleWidth(line);
			out[sp.line] = `${sliceByColumn(line, 0, sp.from)}${hyperlink(sliceByColumn(line, sp.from, sp.to - sp.from), sp.url)}${sliceByColumn(line, sp.to, Math.max(0, total - sp.to))}`;
		}
		return out;
	}
}

/**
 * Text that a terminal pastes when files are dropped on it: one or more paths, with spaces
 * escaped or the path in quotes, sometimes as file:// URLs. Returns the files (with `folders`: the folders) only when every
 * piece of the text is an existing one; otherwise the text is ordinary input.
 */
export function droppedFiles(text: string, folders = false): string[] | null {
	const tokens: string[] = [];
	let cur = "";
	let quote = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = "";
			else cur += ch;
		} else if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "\\" && i + 1 < text.length) cur += text[++i];
		else if (/\s/.test(ch)) {
			if (cur) tokens.push(cur);
			cur = "";
		} else cur += ch;
	}
	if (cur) tokens.push(cur);
	if (!tokens.length) return null;
	const files: string[] = [];
	for (const t of tokens) {
		let file = t;
		try {
			if (t.startsWith("file://")) file = decodeURIComponent(new URL(t).pathname);
		} catch {
			return null;
		}
		file = expandHome(file);
		try {
			const stat = path.isAbsolute(file) ? fs.statSync(file) : undefined;
			if (!stat || !(folders ? stat.isDirectory() : stat.isFile())) return null;
		} catch {
			return null;
		}
		files.push(file);
	}
	return files;
}

/**
 * Entries that match what was typed: every word must occur somewhere in the name or description,
 * in any position ("dee" finds opencode-go/deepseek-v4.1-flash). If nothing matches that way,
 * fall back to loose matching so a typo still finds something.
 */
export function searchItems(items: SelectItem[], query: string): SelectItem[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return items;
	const text = (x: SelectItem) => `${x.label} ${x.description ?? ""}`.toLowerCase();
	const hits = items.filter((x) => words.every((w) => text(x).includes(w)));
	if (!hits.length) return fuzzyFilter(items, query, (x) => x.label);
	// Names that start with the query, or have it right after a separator, come first.
	const rank = (x: SelectItem) => (x.label.toLowerCase().startsWith(words[0]) ? 0 : new RegExp(`[/._ -]${words[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(x.label.toLowerCase()) ? 1 : 2);
	return hits.map((x, i) => ({ x, i })).sort((p, q) => rank(p.x) - rank(q.x) || p.i - q.i).map((p) => p.x);
}

/** A line of the conversation that does something when it is clicked. */
class Button implements Component {
	private text: Text;
	private run: () => void;
	constructor(text: Text, run: () => void) {
		this.text = text;
		this.run = run;
	}
	setText(text: string): void {
		this.text.setText(text);
	}
	invalidate(): void {
		this.text.invalidate();
	}
	render(width: number): string[] {
		return this.text.render(width);
	}
	handleMouse(e: any) {
		if (e.button !== "left" || (e.type !== "press" && e.type !== "click" && e.type !== "release")) return undefined;
		if (e.type === "click") this.run();
		return { handled: true, render: true };
	}
}

/**
 * "@" in the input offers the files of the folder the conversation works in, found by a few
 * letters of their name; everything else is the library's own completion (commands and their
 * arguments). The files are the daemon's to list: the UI is only a client.
 */
class Mentions implements AutocompleteProvider {
	triggerCharacters = ["@"];
	private inner: AutocompleteProvider;
	private find: (query: string) => Promise<string[]>;
	constructor(inner: AutocompleteProvider, find: (query: string) => Promise<string[]>) {
		this.inner = inner;
		this.find = find;
	}
	/** What was typed after an "@" that begins a word, up to the cursor. */
	private typed(lines: string[], line: number, col: number): string | undefined {
		return (lines[line] ?? "").slice(0, col).match(/(?:^|\s)@([^\s@#]*)$/)?.[1];
	}
	async getSuggestions(lines: string[], line: number, col: number, options: { signal: AbortSignal; force?: boolean }) {
		const typed = this.typed(lines, line, col);
		if (typed === undefined) return this.inner.getSuggestions(lines, line, col, options);
		const files = await this.find(typed).catch(() => [] as string[]);
		if (options.signal.aborted || !files.length) return null;
		return { items: files.map((f) => ({ value: `@${f}`, label: f.slice(f.lastIndexOf("/") + 1), description: f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : undefined })), prefix: `@${typed}` };
	}
	applyCompletion(lines: string[], line: number, col: number, item: AutocompleteItem, prefix: string) {
		if (!item.value.startsWith("@") || this.typed(lines, line, col) === undefined) return this.inner.applyCompletion(lines, line, col, item, prefix);
		const text = lines[line] ?? "";
		const start = col - prefix.length;
		const next = [...lines];
		next[line] = `${text.slice(0, start)}${item.value} ${text.slice(col).replace(/^ /, "")}`;
		return { lines: next, cursorLine: line, cursorCol: start + item.value.length + 1 };
	}
	shouldTriggerFileCompletion(lines: string[], line: number, col: number): boolean {
		return this.typed(lines, line, col) !== undefined || (this.inner.shouldTriggerFileCompletion?.(lines, line, col) ?? false);
	}
}

/** The files a message points at: every "@path" in it, with the lines after a "#" if any ("src/a.ts#20-45"). */
export function mentionsIn(text: string): string[] {
	return [...new Set([...text.matchAll(/(?:^|\s)@([^\s@#]+(?:#\d+(?:-\d+)?)?)/g)].map((m) => m[1].replace(/[.,;:!?)]+$/, "")))];
}

/** For this long after esc stopped something, esc does not stop what started since. */
const STOP_GRACE = 3000;
/** A round of a goal: pine calling the agent again (src/goals.ts). Only pine makes a task of this kind. */
const isGoalRound = (kind: unknown, label: unknown) => kind === "notify" && typeof label === "string" && label.startsWith("goal: ");

/** How many lines of a thought are shown while it is being thought. */
const PEEK = 4;

/**
 * What a model thought before it answered. While it thinks, its last few lines are shown. A click
 * opens all of it, and a click anywhere on it closes it again, so there is nothing small to find
 * after scrolling. A thought that was not opened becomes one line when the thinking ends.
 */
class Thought implements Component {
	open = false;
	done = false;
	/** The width it was last drawn at, for working out where it lies in the conversation. */
	width = 80;
	private text = "";
	private started = Date.now();
	private ms?: number;
	private toggled: (thought: Thought) => void;
	private wrapped?: { width: number; lines: string[] };

	constructor(toggled: (thought: Thought) => void) {
		this.toggled = toggled;
	}

	append(text: string): void {
		this.text += text;
		this.wrapped = undefined;
	}

	/** The thinking is over. `ms` is how long it took; `null` when nobody knows (a thought read back from a session). */
	finish(ms?: number | null): void {
		if (this.done) return;
		this.done = true;
		this.ms = ms === null ? undefined : (ms ?? Date.now() - this.started);
	}

	invalidate(): void {
		this.wrapped = undefined;
	}

	private lines(width: number): string[] {
		if (this.wrapped?.width !== width) {
			// A model's text, shown as it is: nothing in it may move the cursor or colour the screen.
			const clean = stripTerminalSequences(this.text).replace(/\t/g, "  ").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
			this.wrapped = { width, lines: clean ? wrapTextWithAnsi(clean, Math.max(10, width - 4)) : [] };
		}
		return this.wrapped.lines;
	}

	render(width: number): string[] {
		this.width = width;
		const all = this.lines(width);
		const secs = Math.max(1, Math.round((this.done ? (this.ms ?? 0) : Date.now() - this.started) / 1000));
		const took = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
		const what = this.done ? (this.ms === undefined ? "thought" : `thought for ${took}`) : `thinking ${took}`;
		const body = (lines: string[]) => lines.map((l) => ` ${c.gray(`│ ${l}`)}`);
		if (this.open) return [` ${c.gray(`▾ ${what} · click anywhere on it to close`)}`, ...body(all), ...(all.length > PEEK ? [` ${c.gray("▴ close")}`] : [])];
		const head = ` ${c.gray(`▸ ${what}${all.length ? " · click to read" : ""}`)}`;
		return this.done ? [head] : [head, ...body(all.slice(-PEEK))];
	}

	handleMouse(e: any) {
		if (e.button !== "left" || (e.type !== "press" && e.type !== "click" && e.type !== "release")) return undefined;
		if (e.type === "click") {
			this.open = !this.open;
			this.toggled(this);
		}
		return { handled: true, render: true };
	}
}

const SCOPES = ["local", "agent", "global"];
const SCOPE_HELP: Record<string, string> = { local: "only this conversation, until it is closed", agent: "the agent, in its main conversation", global: "every agent" };

const PANE_HELP: Record<string, string> = { changes: "what git says changed in the folder, with the diff of each file", files: "the files of the folder", output: "what the agent's tool calls printed", running: "servers and other programs the agent left running, each with a way to stop it", blocked: "what pine's reviewer did not let the agent do, each with a way to allow it", turn: "what your last message changed in the folder (what /undo would restore)", off: "close the pane" };

const childKind = (kind: string) => (kind === "subagent" ? "sub-agent" : kind === "delegate" ? "delegated task" : kind);

/** A list to choose from, opened over the conversation. Type to narrow it down. */
class Picker implements Component {
	private title: string;
	private items: SelectItem[];
	private list!: SelectList;
	private filter = "";
	private done: (value: string | undefined) => void;

	constructor(title: string, items: SelectItem[], done: (value: string | undefined) => void, current?: string) {
		this.title = title;
		this.items = items;
		this.done = done;
		this.build(current);
	}

	/** The list component only matches from the start of a value, so the narrowing is done here. */
	private build(current?: string): void {
		const shown = searchItems(this.items, this.filter);
		// Give the names the room they need, so descriptions are not cut short by an empty column.
		const primary = Math.min(44, Math.max(10, ...this.items.map((x) => visibleWidth(x.label))) + 2);
		this.list = new SelectList(shown, 12, selectTheme, { minPrimaryColumnWidth: primary, maxPrimaryColumnWidth: primary });
		const i = shown.findIndex((x) => x.value === current);
		if (i >= 0) this.list.setSelectedIndex(i);
		this.list.onSelect = (item) => this.done(item.value);
		this.list.onCancel = () => this.done(undefined);
	}

	invalidate(): void {
		this.list.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) return this.done(undefined);
		if (matchesKey(data, "backspace")) this.filter = this.filter.slice(0, -1);
		else if (data.length === 1 && data >= " " && data !== "\x7f") this.filter += data;
		else return this.list.handleInput(data);
		this.build();
	}

	handleMouse(e: any) {
		// The list starts below the top border, the title and the filter line, one column in.
		const r = this.list.handleMouse({ ...e, x: e.x - 2, y: e.y - 3 });
		return r ?? { handled: true };
	}

	render(width: number): string[] {
		const inner = Math.max(20, width - 4);
		const pad = (l: string) => `${c.gray("│")} ${truncateToWidth(l, inner)}${" ".repeat(Math.max(0, inner - visibleWidth(truncateToWidth(l, inner))))} ${c.gray("│")}`;
		return [
			c.gray(`╭${"─".repeat(inner + 2)}╮`),
			pad(c.bold(this.title)),
			pad(`${c.accent(">")} ${this.filter}${c.gray(this.filter ? "" : "type to search · enter picks · esc closes")}`),
			...this.list.render(inner).map(pad),
			c.gray(`╰${"─".repeat(inner + 2)}╯`),
		];
	}
}

const since = (ms: number) => {
	const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
	return min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
};
const until = (ms: number) => {
	const hours = Math.round((ms - Date.now()) / 3_600_000);
	return hours < 1 ? "goes soon" : hours < 48 ? `goes in ${hours} h` : `goes in ${Math.round(hours / 24)} days`;
};

interface ConversationActions {
	open(session: string): void;
	fresh(): void;
	/** Set or take off the pin; resolves with what it is now. */
	pin(conv: Conversation): Promise<boolean>;
	/** Remove for good; resolves with whether it is gone. */
	remove(conv: Conversation): Promise<boolean>;
	close(): void;
	redraw(): void;
}

/**
 * An agent's conversations, opened over the screen: open one, pin it so that it stays, or remove
 * it with the × at its end (asked twice, because it cannot be undone). Type to narrow the list.
 */
class ConversationList implements Component {
	private title: string;
	private items: Conversation[];
	private act: ConversationActions;
	private filter = "";
	/** 0 is "+ new conversation", the conversations follow. */
	private selected = 0;
	private top = 0;
	/** The conversation whose × was clicked once. */
	private asked?: string;
	/** Where the words "pin" and "×" of each row on screen are: columns from, to (inclusive). */
	private hits = new Map<number, { pin: [number, number]; x: [number, number] }>();
	private static ROWS = 12;

	constructor(title: string, items: Conversation[], current: string, act: ConversationActions) {
		this.title = title;
		this.items = items;
		this.act = act;
		this.selected = Math.max(0, items.findIndex((x) => x.session === current) + 1);
	}

	invalidate(): void {}

	private shown(): Conversation[] {
		const f = this.filter.toLowerCase();
		return f ? this.items.filter((x) => x.session.toLowerCase().includes(f)) : this.items;
	}

	private get conv(): Conversation | undefined {
		return this.shown()[this.selected - 1];
	}

	private async pin(conv: Conversation): Promise<void> {
		if (conv.session === "main") return;
		conv.pinned = await this.act.pin(conv);
		this.act.redraw();
	}

	private async remove(conv: Conversation): Promise<void> {
		if (conv.session === "main") return;
		if (this.asked !== conv.session) {
			this.asked = conv.session;
			return this.act.redraw();
		}
		this.asked = undefined;
		if (await this.act.remove(conv)) {
			this.items = this.items.filter((x) => x !== conv);
			this.selected = Math.min(this.selected, this.shown().length);
		}
		this.act.redraw();
	}

	handleInput(data: string): void {
		const count = this.shown().length + 1;
		if (matchesKey(data, "escape")) return this.act.close();
		if (matchesKey(data, "up")) this.selected = (this.selected - 1 + count) % count;
		else if (matchesKey(data, "down")) this.selected = (this.selected + 1) % count;
		else if (matchesKey(data, "enter")) return this.selected === 0 ? this.act.fresh() : this.conv && this.act.open(this.conv.session);
		else if (matchesKey(data, "ctrl+p")) return void (this.conv && this.pin(this.conv));
		else if (matchesKey(data, "ctrl+x")) return void (this.conv && this.remove(this.conv));
		else if (matchesKey(data, "backspace")) (this.filter = this.filter.slice(0, -1)), (this.selected = 0);
		else if (data.length === 1 && data >= " " && data !== "\x7f") (this.filter += data), (this.selected = this.shown().length ? 1 : 0);
		else return;
		this.asked = undefined;
		this.act.redraw();
	}

	handleMouse(e: any) {
		const count = this.shown().length + 1;
		if (e.type === "wheel" && e.wheelDelta) {
			this.selected = Math.max(0, Math.min(count - 1, this.selected + (e.wheelDelta < 0 ? -1 : 1)));
			return { handled: true, render: true };
		}
		if (e.button !== "left" || e.type !== "click") return { handled: true };
		// Rows start below the border, the title and the filter line; their text starts two columns in.
		const index = this.top + e.y - 3;
		if (e.y < 3 || index < 0 || index >= count || e.y - 3 >= ConversationList.ROWS) return { handled: true };
		this.selected = index;
		const conv = this.conv;
		const hit = this.hits.get(index);
		const within = (zone?: [number, number]) => zone !== undefined && e.x >= zone[0] && e.x <= zone[1];
		if (!conv) this.act.fresh();
		else if (within(hit?.x)) void this.remove(conv);
		else if (within(hit?.pin)) void this.pin(conv);
		else this.act.open(conv.session);
		return { handled: true, render: true };
	}

	render(width: number): string[] {
		const inner = Math.max(20, width - 4);
		this.hits.clear();
		const pad = (l: string) => `${c.gray("│")} ${truncateToWidth(l, inner)}${" ".repeat(Math.max(0, inner - visibleWidth(truncateToWidth(l, inner))))} ${c.gray("│")}`;
		const shown = this.shown();
		const rows = ConversationList.ROWS;
		this.top = Math.max(0, Math.min(this.selected - Math.floor(rows / 2), shown.length + 1 - rows));
		const name = Math.min(28, Math.max(10, ...shown.map((x) => visibleWidth(x.session)))) + 1;
		const lines: string[] = [];
		for (let i = this.top; i < Math.min(shown.length + 1, this.top + rows); i++) {
			const on = i === this.selected;
			if (i === 0) {
				lines.push(pad(on ? c.accent("  + new conversation") : "  + new conversation"));
				continue;
			}
			const conv = shown[i - 1];
			const main = conv.session === "main";
			const state = main ? "the agent's own, always kept" : conv.pinned ? "pinned" : conv.open ? "open in a tab" : conv.expires ? until(conv.expires) : "kept";
			const mark = conv.pinned ? c.accent("★") : " ";
			const label = short(conv.session, name - 1).padEnd(name);
			const left = `${mark} ${on ? c.accent(label) : label} ${c.gray(`${conv.tasks} message${conv.tasks === 1 ? "" : "s"} · ${since(conv.last)} · ${state}`)}`;
			// At the end of the row, the two things that can be done to it, as words to click.
			const pin = main ? "" : conv.pinned ? "unpin" : "pin";
			const x = main ? "" : this.asked === conv.session ? "remove? ×" : "×";
			const right = main ? "" : `${c.accent(pin)}   ${this.asked === conv.session ? c.red(x) : c.gray(x)}`;
			const room = inner - visibleWidth(right) - 2;
			const cut = truncateToWidth(left, room);
			lines.push(pad(`${cut}${" ".repeat(Math.max(0, room - visibleWidth(cut)))}  ${right}`));
			// Columns as a click reports them: the border and a space come first. A click just beside a word counts too.
			const end = 2 + inner - 1;
			if (!main) this.hits.set(i, { x: [end - x.length, end], pin: [end - x.length - 3 - pin.length, end - x.length - 2] });
		}
		return [
			c.gray(`╭${"─".repeat(inner + 2)}╮`),
			pad(c.bold(this.title)),
			pad(`${c.accent(">")} ${this.filter}${c.gray(this.filter ? "" : "type to search · enter opens · ctrl+p pins · ctrl+x removes · esc closes")}`),
			...lines,
			pad(c.gray(`pin keeps a conversation for good · × removes it now${shown.length + 1 > rows ? ` · ${shown.length} in all` : ""}`)),
			c.gray(`╰${"─".repeat(inner + 2)}╯`),
		];
	}
}

interface Command extends SlashCommand {
	run(args: string): void | Promise<void>;
}

const REASONING_ITEMS: SelectItem[] = [
	{ value: "off", label: "off", description: "answer straight away" },
	{ value: "minimal", label: "minimal" },
	{ value: "low", label: "low" },
	{ value: "medium", label: "medium" },
	{ value: "high", label: "high", description: "think longer before answering" },
	{ value: "xhigh", label: "xhigh" },
	{ value: "max", label: "max", description: "as much as the model allows" },
];

const MODE_ITEMS: SelectItem[] = [
	{ value: "auto", label: "auto", description: "works inside its sandbox, asks for the rest" },
	{ value: "plan", label: "plan", description: "looks, reads and asks, changes nothing: you get a plan first" },
	{ value: "manual", label: "manual", description: "asks before every action" },
	{ value: "bypass", label: "bypass", description: "never asks; reaches your whole account" },
];

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

type ApprovalAnswer = "allow" | "always" | "deny" | "later";

/** Modal question for one approval request. */
class ApprovalDialog implements Component {
	private req: any;
	private done: (answer: ApprovalAnswer, values?: Record<string, string>) => void;
	private choice = 0;
	private options: Array<{ answer: ApprovalAnswer; label: string }>;
	private buttons: Array<{ row: number; from: number; to: number; answer: ApprovalAnswer }> = [];
	/**
	 * Values the request needs from the owner and that no model may see: a password, a token. They
	 * are typed here without being shown, and go from this dialog straight to the daemon.
	 */
	private fields: Array<{ name: string; label: string; value: string; secret: boolean }>;
	private field = 0;

	constructor(req: any, done: (answer: ApprovalAnswer, values?: Record<string, string>) => void) {
		this.req = req;
		this.done = done;
		this.fields = (Array.isArray(req.inputs) ? req.inputs : []).map((i: any) => ({ name: String(i.name), label: String(i.label ?? i.name), value: "", secret: i.secret !== false }));
		this.options = this.fields.length
			? [
					{ answer: "allow", label: "Save and allow (enter)" },
					{ answer: "deny", label: "Deny" },
					{ answer: "later", label: "Later (esc)" },
				]
			: [
					{ answer: "allow", label: "Allow once (a)" },
					// Only where the daemon offers it: not for actions that are configured to ask every time.
					...(req.remember ? [{ answer: "always" as const, label: "Always here (s)" }] : []),
					{ answer: "deny", label: "Deny (d)" },
					{ answer: "later", label: "Later (esc)" },
				];
	}

	private answer(answer: ApprovalAnswer): void {
		if (answer !== "allow" || !this.fields.length) return this.done(answer);
		// A yes needs every value: go to the first one that is still empty.
		const empty = this.fields.findIndex((f) => !f.value.trim());
		if (empty >= 0) return void (this.field = empty);
		this.done("allow", Object.fromEntries(this.fields.map((f) => [f.name, f.value.trim()])));
	}

	invalidate(): void {}

	handleMouse(e: any) {
		const b = this.buttons.find((x) => e.y === x.row && e.x >= x.from && e.x < x.to);
		if (b && e.type === "click" && e.button === "left") this.answer(b.answer);
		return { handled: true, render: true };
	}

	handleInput(data: string): void {
		if (this.fields.length) return this.typed(data);
		const n = this.options.length;
		if (data === "a" || data === "y") return this.done("allow");
		if (data === "s" && this.req.remember) return this.done("always");
		if (data === "d" || data === "n") return this.done("deny");
		if (matchesKey(data, "escape")) return this.done("later");
		if (matchesKey(data, "left") || matchesKey(data, "up") || matchesKey(data, "shift+tab")) this.choice = (this.choice + n - 1) % n;
		else if (matchesKey(data, "right") || matchesKey(data, "down") || matchesKey(data, "tab")) this.choice = (this.choice + 1) % n;
		else if (matchesKey(data, "enter")) return this.done(this.options[this.choice].answer);
	}

	/** Keys while a value is being typed: every printable key is part of the value, so there are no letter shortcuts. */
	private typed(data: string): void {
		const f = this.fields[this.field];
		const paste = data.match(/\x1b\[200~([\s\S]*?)\x1b\[201~/);
		if (paste) return void (f.value += paste[1].replace(/[\r\n\t]/g, "").trim());
		if (matchesKey(data, "escape")) return this.done("later");
		if (matchesKey(data, "enter")) return this.answer("allow");
		if (matchesKey(data, "tab") || matchesKey(data, "down")) this.field = (this.field + 1) % this.fields.length;
		else if (matchesKey(data, "shift+tab") || matchesKey(data, "up")) this.field = (this.field + this.fields.length - 1) % this.fields.length;
		else if (matchesKey(data, "backspace")) f.value = f.value.slice(0, -1);
		else if (matchesKey(data, "ctrl+u")) f.value = "";
		else if (data.length === 1 && data >= " " && data !== "\x7f") f.value += data;
	}

	render(width: number): string[] {
		const inner = Math.max(20, width - 4);
		const inputs = this.fields.flatMap((f, i) => [
			...wrapTextWithAnsi(c.bold(f.label), inner),
			// A secret is never shown: a dot for each character, so that you see it arrive.
			`${i === this.field ? c.accent(">") : " "} ${c.yellow(f.secret ? "•".repeat(Math.min(f.value.length, inner - 6)) : f.value.slice(-(inner - 6)))}${i === this.field ? c.inverse(" ") : ""}`,
		]);
		const body = [
			c.bold(c.yellow(this.fields.length ? "Approval needed, and something only you have" : "Approval needed")),
			"",
			`${c.gray("agent ")} ${this.req.agent}${this.req.task ? ` ${c.gray(`(task #${this.req.task})`)}` : ""}`,
			`${c.gray("action")} ${c.bold(String(this.req.tool))}`,
			...String(this.req.summary ?? "").split("\n").slice(0, 8).flatMap((l) => wrapTextWithAnsi(`  ${l}`, inner)).slice(0, 12),
			"",
			...wrapTextWithAnsi(c.gray(`Why you are asked: ${this.req.why}`), inner),
			...(this.req.remember ? wrapTextWithAnsi(c.gray(`"Always here" stops asking about ${this.req.remember} in this conversation.`), inner) : []),
			...(inputs.length ? ["", ...inputs, ...wrapTextWithAnsi(c.gray(this.fields.some((f) => f.secret) ? "Type or paste it here. It is not shown, goes into pine's .env file, and never reaches the agent or its model." : "Type it here and press enter. Without it, this cannot be allowed."), inner)] : []),
			"",
		];
		// The buttons, wrapped onto a second line in a narrow window. Their places are kept for clicks:
		// two columns of border and padding, then the labels.
		const rows: string[] = [""];
		this.buttons = [];
		let col = 0;
		this.options.forEach((o, i) => {
			const w = o.label.length + 2;
			if (col > 0 && col + w > inner) {
				rows.push("");
				col = 0;
			}
			rows[rows.length - 1] += `${i === this.choice ? c.bgAccent(` ${o.label} `) : ` ${o.label} `}  `;
			this.buttons.push({ row: 1 + body.length + rows.length - 1, from: 2 + col, to: 2 + col + w, answer: o.answer });
			col += w + 2;
		});
		body.push(...rows);
		const pad = (l: string) => `${c.yellow("│")} ${l}${" ".repeat(Math.max(0, inner - visibleWidth(l)))} ${c.yellow("│")}`;
		return [c.yellow(`╭${"─".repeat(inner + 2)}╮`), ...body.map((l) => pad(truncateToWidth(l, inner))), c.yellow(`╰${"─".repeat(inner + 2)}╯`)];
	}
}

/**
 * A question of the agent's (its `question` tool): the answers it offers, one to a line, and a
 * line for the owner's own words. Arrows and enter or a click pick an answer, a digit picks by
 * number; anything typed is an answer of the owner's own.
 */
class QuestionDialog implements Component {
	private req: any;
	private done: (answer: string | undefined, dismissed?: boolean) => void;
	private choices: string[];
	private at = 0;
	private own = "";
	private rows: Array<{ row: number; index: number }> = [];

	constructor(req: any, done: (answer: string | undefined, dismissed?: boolean) => void) {
		this.req = req;
		this.done = done;
		this.choices = (Array.isArray(req.choices) ? req.choices : []).map((x: unknown) => String(x));
	}

	invalidate(): void {}

	handleMouse(e: any) {
		const hit = this.rows.find((r) => r.row === e.y);
		if (hit && e.type === "click" && e.button === "left") this.done(this.choices[hit.index]);
		return { handled: true, render: true };
	}

	handleInput(data: string): void {
		const paste = data.match(/\x1b\[200~([\s\S]*?)\x1b\[201~/);
		if (paste) return void (this.own += paste[1].replace(/[\r\n\t]+/g, " ").trim());
		if (matchesKey(data, "escape")) return this.done(undefined);
		if (matchesKey(data, "enter")) {
			if (this.own.trim()) return this.done(this.own.trim());
			return this.choices.length ? this.done(this.choices[this.at]) : undefined;
		}
		if (matchesKey(data, "up") || matchesKey(data, "shift+tab")) this.at = (this.at + Math.max(1, this.choices.length) - 1) % Math.max(1, this.choices.length);
		else if (matchesKey(data, "down") || matchesKey(data, "tab")) this.at = (this.at + 1) % Math.max(1, this.choices.length);
		else if (matchesKey(data, "backspace")) this.own = this.own.slice(0, -1);
		else if (matchesKey(data, "ctrl+u")) this.own = "";
		else if (!this.own && /^[1-9]$/.test(data) && Number(data) <= this.choices.length) return this.done(this.choices[Number(data) - 1]);
		else if (data.length === 1 && data >= " " && data !== "\x7f") this.own += data;
	}

	render(width: number): string[] {
		const inner = Math.max(20, width - 4);
		const body = [c.bold(c.accent(`${this.req.agent} asks`)), "", ...String(this.req.summary ?? "").split("\n").flatMap((l) => wrapTextWithAnsi(l, inner)).slice(0, 14), ""];
		this.rows = [];
		this.choices.forEach((choice, i) => {
			this.rows.push({ row: 1 + body.length, index: i });
			const label = truncateToWidth(`${i + 1}  ${choice}`, inner - 2);
			body.push(i === this.at && !this.own ? c.bgAccent(` ${label} `) : ` ${label}`);
		});
		body.push("", `${c.gray(this.choices.length ? "or in your own words:" : "your answer:")} ${c.yellow(this.own.slice(-(inner - 26)))}${c.inverse(" ")}`, "", c.gray(this.choices.length ? "enter or a click answers · 1-9 picks by number · esc: later" : "enter answers · esc: later"));
		const pad = (l: string) => `${c.accent("│")} ${l}${" ".repeat(Math.max(0, inner - visibleWidth(l)))} ${c.accent("│")}`;
		return [c.accent(`╭${"─".repeat(inner + 2)}╮`), ...body.map((l) => pad(truncateToWidth(l, inner))), c.accent(`╰${"─".repeat(inner + 2)}╯`)];
	}
}

/**
 * The screen, with one addition: while a menu or question is open, a click next to it goes to the
 * app (which closes the menu) instead of to whatever lies underneath.
 */
class Screen extends TuiAltScreen {
	onOutside?: (e: any) => boolean;
	/** The terminal said that its window came to the front, or went from it. */
	onFocus?: (focused: boolean) => void;

	constructor(...args: ConstructorParameters<typeof TuiAltScreen>) {
		super(...args);
		// The library takes these two reports for itself before anything else sees them; it is asked first here.
		const own = (this as any).handleViewportInput;
		if (typeof own === "function") {
			(this as any).handleViewportInput = (data: string) => {
				if (data === "\x1b[I" || data === "\x1b[O") this.onFocus?.(data === "\x1b[I");
				return own.call(this, data);
			};
		}
	}

	protected override dispatchMouseToOverlay(event: any): any {
		const r = super.dispatchMouseToOverlay(event);
		return !r.hit && this.onOutside?.(event) ? { hit: true } : r;
	}

	/**
	 * A real picture is drawn above all text, so it would lie across a menu opened over it. Pictures
	 * that a menu or dialog covers are drawn as text for as long as it is there.
	 */
	protected override compositeOverlays(lines: string[], width: number, height: number): string[] {
		const out = super.compositeOverlays(lines, width, height);
		const boxes: Array<{ row: number; col: number; width: number; height: number }> = (this as any).renderedOverlayLayouts ?? [];
		if (!boxes.length) return out;
		// Overlays are placed from the top of the visible screen; `lines` may be longer than that.
		const top = Math.max(0, out.length - height);
		const asText = picturesAsText(lines, (row, col, w, h) => boxes.some((b) => row < top + b.row + b.height && top + b.row < row + h && col < b.col + b.width && b.col < col + w));
		return asText === lines ? out : super.compositeOverlays(asText, width, height);
	}
}

export interface TuiOptions {
	client: Client;
	terminal: Terminal;
	/** Called once when the user quits. */
	onQuit?: () => void | Promise<void>;
	/** Shown in the footer, for example "embedded daemon". */
	mode?: string;
	/** Hands a video file to a player when "open in player" is clicked. Default: the system's player. */
	openFile?: (file: string) => void;
	/** Opens a web address when it is clicked. Default: the system's browser. */
	openUrl?: (url: string) => void;
	/** Saves the picture that is on the clipboard as a file and resolves with its path, or with nothing when there is none. Default: the system's clipboard. */
	clipboardImage?: () => Promise<string | undefined>;
	/** Puts text on the clipboard; resolves with true, or with what went wrong. Default: the system's clipboard program. */
	copy?: (text: string) => Promise<true | string>;
	/** Lets the user pick a folder; resolves with nothing when they do not. Default: the system's folder chooser (macOS). */
	chooseFolder?: () => Promise<string | undefined>;
	/** The folder pine was started in, offered in the folder menu. Default: the process's. */
	cwd?: string;
	/** MCP server administration that needs this machine: connection states and browser sign-in. */
	mcp?: {
		/** The configured servers. `states` also asks each one whether it connects, which takes a moment. */
		list(states?: boolean): Promise<Array<{ name: string; scope: string; agents: string[]; target: string; state?: string }>>;
		login(name: string, onOutput: (text: string) => void): Promise<number>;
	};
}

/** The terminal UI: one tab per conversation, a live event tab, slash commands, approval prompts. */
export class PineTui {
	client: Client;
	tui: Screen;
	private editor: Editor;
	private header: Component;
	private status: Component;
	private footer: Component;
	private dock: VStack;
	private tabs: Tab[] = [];
	private active!: Tab;
	private nextTabId = 1;
	private agents: AgentInfo[] = [];
	private commands: Command[] = [];
	private connected = false;
	private notice = "";
	private noticeTimer?: NodeJS.Timeout;
	private spinner?: NodeJS.Timeout;
	private frame = 0;
	private unsubscribe?: () => void;
	private dialog?: { id: string; handle: OverlayHandle; dismiss(): void };
	/** When a menu or question last closed. A key that closed it is not also a key for what lies under it. */
	private dialogClosedAt = 0;
	/** Videos fetched from the daemon, as files for ffmpeg and the player. Removed when the UI closes. */
	private mediaDir?: string;
	private mediaCount = 0;
	private headerHits: Hit[] = [];
	private footerHits: Hit[] = [];
	private attachHits: Hit[] = [];
	private attach: Component;
	private sessionModes = new Map<string, string>();
	private lastCtrlC = 0;
	private taints = new Map<string, string>();
	private bypassWhenTainted = false;
	private opts: TuiOptions;
	private stopped = false;
	/** While the tabs of last time are being opened again. */
	private restoring = false;
	/** The pane beside a conversation: changes, files, tool output. */
	private code: CodePane;
	private codeOpen = false;
	private codeRule: Component = { invalidate() {}, render: () => RULE };
	/** Whether the terminal's window is in front (terminals that do not say are taken to be). */
	private focused = true;
	/** Whether to call for attention when something ends or waits while the window is not in front. */
	private notify = true;

	constructor(opts: TuiOptions) {
		this.opts = opts;
		this.client = opts.client;
		this.tui = new Screen(opts.terminal, false, undefined, {
			mouse: true,
			openUrl: (url) => this.open(url),
			// With the mouse in use by the UI, selecting text is the UI's job too: what you drag over is copied.
			copyOnSelect: true,
			copySelection: (text) => this.copyText(text),
		});
		this.editor = new Editor(this.tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 });
		this.editor.onSubmit = (text) => void this.submit(text);
		this.header = clickable((w) => this.renderHeader(w), () => this.headerHits);
		this.status = { invalidate: () => {}, render: (w) => this.renderStatus(w) };
		this.attach = clickable((w) => this.renderAttachments(w), () => this.attachHits);
		this.footer = clickable((w) => this.renderFooter(w), () => this.footerHits);
		this.dock = new VStack([
			{ component: this.status, shrink: 1, minSize: 0 },
			{ component: this.attach, shrink: 1, minSize: 0 },
			{ component: this.editor, shrink: 1, minSize: 3 },
			{ component: this.footer, shrink: 1, minSize: 0 },
		]);
		this.code = new CodePane({
			client: this.client,
			redraw: () => this.tui.requestRender(),
			close: () => this.showCode(false),
			target: () => (this.active?.kind === "chat" ? { agent: this.active.agent, session: this.active.session } : undefined),
		});
		this.defineCommands();
		this.editor.setAutocompleteProvider(
			new Mentions(new CombinedAutocompleteProvider(this.commands, process.cwd(), null), async (query) => {
				const t = this.active;
				if (t?.kind !== "chat") return [];
				const files = (await this.client.find(t.agent, t.session, query)).files;
				for (const f of files) t.files.add(f);
				return files;
			}),
		);
		this.tui.addInputListener((data) => (this.onKey(data) ? { consume: true } : undefined));
		// A menu or question is modal: a click beside it closes it (a question stays open for later,
		// as with esc) and does not reach the tabs and the bar underneath. The wheel still scrolls.
		this.tui.onFocus = (focused) => void (this.focused = focused);
		this.tui.onOutside = (e) => {
			if (!this.dialog || e.type === "wheel") return false;
			if (e.type === "click" && e.button === "left") this.dialog.dismiss();
			return true;
		};
		// Addresses are always printed in full, so what is clicked is what is opened; a link whose text
		// hides its target would be an easy trick for a web page to play through an agent's answer.
		setCapabilities({ ...getCapabilities(), hyperlinks: false });

	}

	async start(): Promise<void> {
		this.agents = await this.client.agents();
		if (!this.agents.length) throw new Error("the daemon has no agents");
		const first = this.agents.find((a) => a.main) ?? this.agents[0];
		this.unsubscribe = this.client.subscribe(
			(e) => this.onEvent(e),
			(up) => {
				this.connected = up;
				this.tui.requestRender();
			},
		);
		this.tui.start();
		this.spinner = setInterval(() => {
			if (!this.tabs.some((t) => t.running.size)) return;
			this.frame++;
			this.tui.requestRender();
		}, 120);
		this.spinner.unref?.();
		// The same tabs as last time, in the same order.
		const saved = await this.client.tabs().catch(() => ({ tabs: [] as Array<{ agent: string; session: string }>, active: 0, code: false, notify: true }));
		this.notify = saved.notify !== false;
		const again = saved.tabs.filter((t) => this.agents.some((a) => a.id === t.agent));
		this.restoring = true;
		try {
			if (!again.length) await this.openTab(first.id, "main");
			for (const t of again) await this.openTab(t.agent, t.session);
			const chats = this.tabs.filter((t) => t.kind === "chat");
			if (again.length && chats[saved.active]) this.activate(chats[saved.active]);
		} finally {
			this.restoring = false;
		}
		if (saved.code) this.showCode(true);
		this.saveTabs();
		void this.refreshTaints();
	}

	/** Remember which conversations are open, so that the next start opens the same tabs. */
	private saveTabs(): void {
		if (this.restoring || this.stopped) return;
		const chats = this.tabs.filter((t) => t.kind === "chat");
		void this.client.saveTabs(chats.map((t) => ({ agent: t.agent, session: t.session })), Math.max(0, chats.indexOf(this.active)), this.codeOpen, this.notify).catch(() => {});
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		clearInterval(this.spinner);
		clearTimeout(this.noticeTimer);
		// Leaving keeps every conversation as it is: the same tabs open again next time.
		this.unsubscribe?.();
		this.code.stop();
		stopVideos();
		if (this.mediaDir) fs.rmSync(this.mediaDir, { recursive: true, force: true });
		this.tui.stop();
		await this.opts.onQuit?.();
	}

	/** What is on screen, without colours. For tests and debugging. */
	screen(): string[] {
		this.tui.renderNow(true);
		return this.tui.getScreenLines().map((l) => stripTerminalSequences(l).replace(/\s+$/, ""));
	}

	// ---- tabs ------------------------------------------------------------------------------------

	private newTab(kind: Tab["kind"], agent: string, session: string): Tab {
		const doc = new Doc();
		const scroll = new ScrollView(doc, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" });
		// A conversation can have the code pane beside it: half the width each, or the pane alone where that is too narrow.
		const beside = kind === "chat";
		doc.asText = () => beside && this.codeOpen;
		const body = beside ? new Split(scroll, this.codeRule, this.code.component, () => this.codeOpen, () => this.opts.terminal.columns) : scroll;
		const tab: Tab = {
			id: this.nextTabId++, kind, agent, session, doc, scroll,
			layout: new VStack([
				{ component: this.header, basis: "auto", grow: 0, shrink: 0 },
				{ component: body, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{ component: this.dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			]),
			roots: new Set(), running: new Set(), awaiting: [], blocks: new Map(), thoughts: new Map(), tools: new Map(), streamed: new Map(), approvals: new Map(), baseDepth: 0, children: new Map(),
			unread: false, startedAt: 0, toolCalls: 0, tokens: { input: 0, output: 0, cached: 0 }, thinking: false, lines: [], attachments: [], pauseNoted: false, files: new Set(),
		};
		this.tabs.push(tab);
		return tab;
	}

	async openTab(agent: string, session: string): Promise<void> {
		const existing = this.tabs.find((t) => t.kind === "chat" && t.agent === agent && t.session === session);
		if (existing) return this.activate(existing);
		if (!this.agents.some((a) => a.id === agent)) this.agents = await this.client.agents().catch(() => this.agents);
		if (!this.agents.some((a) => a.id === agent)) return this.flash(`there is no agent called ${agent}`);
		const tab = this.newTab("chat", agent, session);
		this.activate(tab);
		this.saveTabs();
		const info = this.agents.find((a) => a.id === agent);
		tab.folder = (await this.client.folder(agent, session).catch(() => undefined))?.folder;
		tab.goal = (await this.client.goal(agent, session).catch(() => undefined))?.goal;
		this.say(tab, c.gray(`${c.bold(agent)}${info?.description ? ` · ${info.description}` : ""}\nsession ${session} · model ${info?.model ?? "?"}${tab.folder ? ` · works in ${tilde(tab.folder)}` : ""} · type a message, / for commands, or click the bar below`));
		try {
			const history = (await this.client.history(agent, session)).filter((t) => t.depth === 0).reverse();
			if (history.length) this.say(tab, c.gray(`── earlier in this session (${history.length}) ──`));
			for (const t of history) this.renderPast(tab, t);
			this.takeStats(tab, history.at(-1)?.meta?.stats);
			// What the agent listed for itself and has not finished is still its plan.
			const steps = await this.client.todos(agent, session).catch(() => []);
			if (steps.some((t) => t.status !== "done")) this.showSteps(tab, -1, steps);
			if (history.length) this.say(tab, c.gray("── now ──"));
			if (tab.goal) this.say(tab, this.goalLine(tab.goal, true));
		} catch (e) {
			this.say(tab, c.red(`could not load history: ${errText(e)}`));
		}
		this.tui.requestRender();
	}

	/**
	 * Open a tab on one task, typically a sub-agent: what it was given, what it thought and wrote,
	 * every tool call with the start of its result. A running task is followed live.
	 */
	async openTask(id: number): Promise<void> {
		const existing = this.tabs.find((t) => t.kind === "task" && t.task === id);
		if (existing) return this.activate(existing);
		let data: Awaited<ReturnType<Client["transcript"]>>;
		try {
			data = await this.client.transcript(id);
		} catch (e) {
			return this.flash(`task #${id}: ${errText(e)}`);
		}
		const { task, entries } = data;
		const tab = this.newTab("task", task.agent, task.session);
		tab.task = id;
		tab.baseDepth = task.depth;
		tab.roots.add(id);
		this.activate(tab);
		const who = task.kind === "subagent" ? `sub-agent of ${task.agent}` : task.kind === "delegate" ? `${task.agent}, on a task from ${task.meta.chain?.at(-1) ?? "another agent"}` : task.agent;
		const live = task.status === "running" || task.status === "pending";
		this.say(tab, c.gray(`${c.bold(who)} · task #${id}${task.parent !== undefined ? ` · started by task #${task.parent}` : ""} · ${task.status}\nsession ${task.session} · this tab shows the work and takes no messages${live ? " · esc stops this task" : ""}`));
		if (entries.length) for (const e of entries) this.renderEntry(tab, e);
		else {
			// No session file (not started yet, or cleared): what the task list knows.
			this.user(tab, task.prompt, "task");
			if (task.result) this.add(tab, new Answer(task.result));
		}
		if (live) {
			tab.running.add(id);
			tab.startedAt = task.started ?? Date.now();
		} else this.say(tab, c.gray(this.taskSummary(task.status, task.meta.stats, task.error)));
		tab.scroll.scrollToEnd();
		this.tui.requestRender();
	}

	private taskSummary(status: string, stats: Task["meta"]["stats"], error?: string): string {
		const parts = [status, ...(stats ? [`${Math.round(stats.ms / 100) / 10} s`, `${stats.tools.length} tool call${stats.tools.length === 1 ? "" : "s"}`, `${stats.input + (stats.cached ?? 0)}↑ ${stats.output}↓`] : []), ...(error ? [error] : [])];
		return `── ${parts.join(" · ")} ──`;
	}

	private renderEntry(tab: Tab, e: TranscriptEntry): void {
		if (e.kind === "user") return this.user(tab, e.text ?? "", "task");
		if (e.kind === "text") {
			this.add(tab, new Answer(e.text ?? ""));
			return this.answerPictures(tab, tab.agent, e.text, false);
		}
		if (e.kind === "thinking") {
			const thought = this.thought(tab);
			thought.append(e.text ?? "");
			return thought.finish(null);
		}
		const mark = e.ok === undefined ? c.yellow("●") : e.ok ? c.green("✓") : c.red("✗");
		const took = e.ms !== undefined ? c.gray(` ${e.ms < 1000 ? `${Math.round(e.ms)} ms` : `${(e.ms / 1000).toFixed(1)} s`}`) : "";
		const result = e.result ? `\n  ${(e.ok === false ? c.red : c.gray)(short(oneLine(e.result), 240))}` : "";
		this.say(tab, `${mark} ${c.bold(e.tool ?? "")}${e.subject ? ` ${c.gray(short(oneLine(e.subject), 100))}` : ""}${took}${result}`, false);
		for (const id of e.images ?? []) this.picture(tab, `from ${e.tool}`, () => this.client.toolImage(id));
	}

	private openEvents(): void {
		let tab = this.tabs.find((t) => t.kind === "events");
		if (!tab) {
			tab = this.newTab("events", "events", "");
			tab.log = new Text(c.gray("Live events. Agent text deltas are left out."), 1, 0);
			tab.doc.addChild(tab.log);
		}
		this.activate(tab);
	}

	private activate(tab: Tab): void {
		this.active = tab;
		tab.unread = false;
		this.tui.setLayoutRoot(tab.layout);
		this.tui.setFocus(this.editor);
		tab.scroll.scrollToEnd();
		if (this.codeOpen) this.code.show();
		this.tui.requestRender();
		this.saveTabs();
		const waiting = [...tab.approvals.values()][0];
		if (waiting && !this.dialog) this.ask(tab, waiting.req);
	}

	private cycle(by: number): void {
		const i = this.tabs.indexOf(this.active);
		this.activate(this.tabs[(i + by + this.tabs.length) % this.tabs.length]);
	}

	/**
	 * The tab of a conversation other than an agent's main one is closed: what it was subscribed to
	 * on its own ends, the conversation itself stays in the agent's list. (The main conversation is
	 * the agent; its subscriptions stay.)
	 */
	private async endLocal(tab: Tab, say = true): Promise<void> {
		if (tab.kind !== "chat" || tab.session === "main" || this.tabs.some((t) => t !== tab && t.kind === "chat" && t.agent === tab.agent && t.session === tab.session)) return;
		const ended = (await this.client.closeSession(tab.agent, tab.session).catch(() => ({ unsubscribed: [] as string[] }))).unsubscribed;
		if (ended.length && say) this.flash(`closed ${tab.agent}·${tab.session}: its subscription${ended.length === 1 ? "" : "s"} to ${ended.join(", ")} ended with it`, 6000);
	}

	private closeTab(tab: Tab): void {
		if (this.tabs.length === 1) return this.flash("the last tab stays open; /quit leaves");
		const i = this.tabs.indexOf(tab);
		this.tabs.splice(i, 1);
		void this.endLocal(tab);
		if (this.active === tab) this.activate(this.tabs[Math.max(0, i - 1)]);
		else this.tui.requestRender();
		this.saveTabs();
	}

	// ---- the code pane and the folder of a conversation -------------------------------------------

	/** Open or close the pane beside the conversation, optionally on one of its views. */
	private showCode(open: boolean, view?: PaneView): void {
		this.codeOpen = open;
		if (open) this.code.show(view);
		// Pictures change between real ones and text with the pane; what was drawn is drawn anew.
		for (const t of this.tabs) t.doc.invalidate();
		this.tui.requestRender(true);
		this.saveTabs();
	}

	/** Give a conversation a folder to work in, or with `null` take it back to the agent's own workspace. */
	private async setFolder(tab: Tab, folder: string | null): Promise<void> {
		if (tab.kind !== "chat") return;
		let now: string | undefined;
		try {
			now = (await this.client.setFolder(tab.agent, tab.session, folder ? path.resolve(expandHome(folder)) : null)).folder;
		} catch (e) {
			return void this.say(tab, c.red(`the folder was not changed: ${errText(e)}`));
		}
		for (const t of this.tabs) if (t.kind === "chat" && t.agent === tab.agent && t.session === tab.session) t.folder = now;
		this.say(tab, now
			? `${c.gray("this conversation now works in")} ${c.bold(tilde(now))}${c.gray(`: ${tab.agent}'s tools start there and may read and change what is in it, from your next message on.`)}`
			: c.gray(`this conversation works in ${tab.agent}'s own workspace again; the folder is closed to it from your next message on.`));
		this.code.forget({ agent: tab.agent, session: tab.session });
		this.tui.requestRender();
	}

	private async pickFolder(): Promise<void> {
		const t = this.active;
		if (t.kind !== "chat") return;
		const here = path.resolve(this.opts.cwd ?? process.cwd());
		const used = await this.client.folders(t.agent).catch(() => [] as Array<{ session: string; folder: string }>);
		const items: SelectItem[] = [{ value: "none", label: "No folder", description: `${t.agent}'s own workspace` }];
		if (t.folder) items.push({ value: t.folder, label: tilde(t.folder), description: "this conversation's folder" });
		// A home folder holds pine's own files and is refused anyway, so it is not offered.
		if (here !== t.folder && here !== os.homedir() && here !== "/") items.push({ value: here, label: tilde(here), description: "where pine was started" });
		for (const u of used) if (!items.some((i) => i.value === u.folder) && items.length < 9) items.push({ value: u.folder, label: tilde(u.folder), description: `also open in ${u.session}` });
		items.push({ value: "pick", label: "Pick a folder …", description: "choose one, or type /folder <path>" });
		const chosen = await this.pick(`Folder for ${t.agent}·${t.session}`, items, t.folder ?? "none");
		if (!chosen || chosen === (t.folder ?? "none")) return;
		if (chosen !== "pick") return this.setFolder(t, chosen === "none" ? null : chosen);
		const picked = await (this.opts.chooseFolder ?? chooseFolder)();
		// The window of the chooser took the keyboard; the screen is drawn anew when it is back.
		this.tui.requestRender(true);
		if (picked) await this.setFolder(t, picked);
		else if (process.platform !== "darwin" && !this.opts.chooseFolder) this.flash("type /folder <path> to open a folder", 6000);
	}

	/**
	 * `pine <folder>`: a tab on the conversation that works in that folder. The one that already
	 * does is opened again; otherwise the main agent gets a new conversation named after the folder.
	 */
	async openFolder(dir: string): Promise<void> {
		const agent = (this.agents.find((a) => a.main) ?? this.agents[0]).id;
		let full = path.resolve(expandHome(dir));
		try {
			full = fs.realpathSync(full);
		} catch {
			return void this.say(this.active, c.red(`${dir} is not a folder`));
		}
		const used = await this.client.folders(agent).catch(() => [] as Array<{ session: string; folder: string }>);
		const have = used.find((u) => u.folder === full);
		if (have) return this.openTab(agent, have.session);
		const taken = new Set(["main", ...used.map((u) => u.session), ...(await this.client.sessions(agent).catch(() => [] as Conversation[])).map((x) => x.session)]);
		const base = (path.basename(full).replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "folder").slice(0, 24);
		let name = base;
		for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
		try {
			await this.client.setFolder(agent, name, full);
		} catch (e) {
			return void this.say(this.active, c.red(`${tilde(full)} was not opened: ${errText(e)}`));
		}
		await this.openTab(agent, name);
	}

	// ---- transcript ------------------------------------------------------------------------------

	private add(tab: Tab, component: Component, gap = true): void {
		if (gap && tab.doc.children.length) tab.doc.addChild(new Spacer(1));
		tab.doc.addChild(new Linked(component));
		if (tab !== this.active) tab.unread = true;
		this.tui.requestRender();
	}

	private say(tab: Tab, text: string, gap = true): Text {
		const t = new Text(text, 1, 0);
		this.add(tab, t, gap);
		return t;
	}

	/** A place for what a model thinks. Opening and closing it keeps it in the window. */
	private thought(tab: Tab): Thought {
		const thought = new Thought((t) => {
			const scroll = tab.scroll;
			if (t.open) {
				// It grows downwards from its first line. A window that follows the end would run after
				// the end and take that line out of sight, so it stays where it is.
				if (scroll.isFollowingEnd && this.rowOf(tab) - scroll.viewportHeight > this.rowOf(tab, t)) scroll.scrollTo(scroll.scrollTop, { disableFollow: true });
			} else {
				// Closed from far down in it: the one line that is left must not end up above the window.
				const top = this.rowOf(tab, t);
				if (top < scroll.scrollTop) scroll.scrollTo(top);
			}
			this.tui.requestRender();
		});
		this.add(tab, thought);
		return thought;
	}

	/** The row of the conversation at which a component begins; without one, how many rows there are. */
	private rowOf(tab: Tab, inner?: Thought): number {
		let width = inner?.width;
		if (width === undefined) for (const child of tab.doc.children) if (child instanceof Linked && child.inner instanceof Thought) width = child.inner.width;
		let row = 0;
		for (const child of tab.doc.children) {
			if (inner && child instanceof Linked && child.inner === inner) return row;
			row += child.render(width ?? 80).length;
		}
		return row;
	}

	/** A task's model stopped thinking: what it thought is closed, or stays open if somebody opened it. */
	private endThought(tab: Tab, task: number, ms?: number): void {
		tab.thoughts.get(task)?.finish(ms);
		tab.thoughts.delete(task);
	}

	/** The agent's list of steps (its `todo` tool), drawn: done, in work, still to do. */
	private stepsText(items: Array<{ text: string; status: string }>): string {
		const done = items.filter((t) => t.status === "done").length;
		const lines = items.map((t) => (t.status === "done" ? `${c.green("✓")} ${c.gray(t.text)}` : t.status === "in_progress" ? `${c.yellow("◐")} ${c.bold(t.text)}` : `${c.gray("☐")} ${t.text}`));
		return [c.gray(`steps · ${done} of ${items.length} done`), ...lines].join("\n");
	}

	/** Show the list where the conversation is: the same block while one task keeps changing it, a new one for the next task. */
	private showSteps(tab: Tab, task: number, items: Array<{ text: string; status: string }>): void {
		if (!items.length) return void (tab.todo = undefined);
		if (tab.todo?.task === task) tab.todo.block.setText(this.stepsText(items));
		else tab.todo = { block: this.say(tab, this.stepsText(items)), task, items };
		tab.todo.items = items;
	}

	/** A line that opens something on a click. */
	private button(tab: Tab, text: string, run: () => void, gap = false): Button {
		const b = new Button(new Text(text, 1, 0), run);
		this.add(tab, b, gap);
		return b;
	}

	/**
	 * Reserve a place for a picture and fill it once the picture is fetched and prepared, so it lands
	 * where it belongs however long that takes. Display only: nothing here reaches a model.
	 */
	private picture(tab: Tab, name: string, load: () => Promise<{ mime: string; bytes: Buffer } | undefined>, missing?: string, live = true): Slot {
		const slot = new Slot();
		// Not through add(): picture lines are not text, and are not searched for web addresses.
		tab.doc.addChild(slot);
		// A video that arrives while you are looking starts by itself; one from earlier in the conversation waits for a click.
		void this.fill(slot, name, load, missing, () => live && this.active === tab);
		return slot;
	}

	private async fill(slot: Slot, name: string, load: () => Promise<{ mime: string; bytes: Buffer } | undefined>, missing?: string, autoplay: () => boolean = () => true): Promise<void> {
		try {
			const got = await load();
			if (got?.mime.startsWith("video/")) {
				const video = await this.video(this.keepVideo(got.bytes, got.mime, name), name);
				slot.inner = video;
				if (autoplay()) video.play();
			}
			else if (got) slot.inner = new Picture(await prepare(got.bytes, got.mime, name));
			else slot.inner = missing ? new Text(c.gray(missing), 1, 0) : undefined;
		} catch (e) {
			slot.inner = new Text(c.gray(`(picture ${name}: ${errText(e)})`), 1, 0);
		}
		this.tui.requestRender();
	}

	/** A video that came over the API needs to be a file for ffmpeg and for the player. Kept until the UI closes. */
	private keepVideo(bytes: Buffer, mime: string, name: string): string {
		this.mediaDir ??= fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pine-media-"));
		const ext = mime === "video/webm" ? ".webm" : mime === "video/quicktime" ? ".mov" : ".mp4";
		const file = path.join(this.mediaDir, `${this.mediaCount++}-${name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-60) || "video"}${/\.\w{2,5}$/.test(name) ? "" : ext}`);
		fs.writeFileSync(file, bytes, { mode: 0o600 });
		return file;
	}

	private async video(file: string, name: string): Promise<Video> {
		return new Video(await prepareVideo(file, name), () => this.tui.requestRender(), (f) => (this.opts.openFile ?? openInSystem)(f));
	}

	/**
	 * The pictures an answer points at with ![caption](target). A file in the agent's workspace is
	 * shown at once. A web address is not fetched until it is clicked: an address can carry
	 * information out, and an answer may repeat what a web page told the agent to write.
	 */
	private answerPictures(tab: Tab, agent: string, text: string | undefined, live = true): void {
		for (const ref of picturesIn(text ?? "")) {
			const name = ref.caption || path.basename(ref.target.split("?")[0]) || "picture";
			if (!ref.remote) {
				this.picture(tab, name, () => this.client.workspaceImage(agent, ref.target, tab.kind === "chat" ? tab.session : undefined), `(no picture at ${ref.target} in the ${tab.folder ? "folder or the " : ""}workspace)`, live);
				continue;
			}
			let slot: Slot | undefined;
			this.button(tab, `${c.accent("▸ load picture")} ${c.gray(ref.target)}`, () => {
				if (!slot) return;
				slot.inner = new Text(c.gray("loading …"), 1, 0);
				this.tui.requestRender();
				void this.fill(slot, name, () => this.client.fetchImage(ref.target), "(that address is not a picture)");
			});
			slot = new Slot();
			tab.doc.addChild(slot);
		}
	}

	/** An event that woke the agent, shown as what it is and not as something you typed: the source, and the start of what it reported. */
	private eventLine(tab: Tab, label: string, prompt: string): void {
		const body = prompt.replace(/^\[(?:You are subscribed to|Your owner wrote|Somebody wrote|It is time for your schedule)[\s\S]*?\]\n\n/, "").replace(/^\[event on [^\n]*\]\n/, "").replace(/^Event [^\n]*:\n/, "");
		// Paths under the user's home are shown the short way, as one would type them.
		this.say(tab, `${c.yellow("⚡")} ${c.bold(label)}\n${c.gray(`  ${short(oneLine(body).replaceAll(os.homedir(), "~"), 300)}`)}`);
	}

	private user(tab: Tab, text: string, from?: string): void {
		this.add(tab, new Text(`${from ? c.gray(`[${from}] `) : ""}${text}`, 1, 0, c.bgUser));
	}

	/** Context and cache figures of a finished task, for the bottom bar. */
	private takeStats(tab: Tab, stats: Task["meta"]["stats"]): void {
		if (!stats) return;
		if (stats.context?.percent !== undefined) tab.context = stats.context.percent;
		const total = stats.input + (stats.cached ?? 0);
		// Shown once the server has reported cached input at least once; many servers report nothing,
		// and a permanent "0%" would say something that is not known.
		if (total > 0 && (stats.cached || tab.cacheShare !== undefined)) tab.cacheShare = Math.round((100 * (stats.cached ?? 0)) / total);
	}

	/**
	 * /undo and /redo. The daemon does it; here the conversation is shown anew, since the lines on
	 * screen are not its history any more, with what happened said below it. After an undo the
	 * message's text is in the input again, to be changed and sent.
	 */
	private async undo(redo: boolean): Promise<void> {
		const tab = this.active;
		if (tab.kind !== "chat") return this.flash("switch to a conversation tab first");
		const r = redo ? await this.client.redo(tab.agent, tab.session) : await this.client.undo(tab.agent, tab.session);
		tab.doc.clear();
		for (const live of [tab.roots, tab.running, tab.blocks, tab.thoughts, tab.tools, tab.streamed, tab.children]) live.clear();
		tab.awaiting = [];
		tab.thinking = false;
		const history = (await this.client.history(tab.agent, tab.session).catch(() => [] as Task[])).filter((t) => t.depth === 0).reverse();
		if (history.length) this.say(tab, c.gray(`── earlier in this session (${history.length}) ──`));
		for (const t of history) this.renderPast(tab, t);
		this.say(tab, redo ? redoText(r) : undoText(r));
		if (!redo && tab === this.active) this.editor.setText(r.prompt);
		tab.scroll.scrollToEnd();
		if (this.codeOpen && tab === this.active) this.code.touch();
		void this.refreshTaints();
		this.tui.requestRender();
	}

	private renderPast(tab: Tab, t: Task): void {
		if (t.meta?.compact) return void this.say(tab, c.gray(`⟲ ${t.status === "done" ? t.result : `shortening the conversation: ${t.status}${t.error ? ` (${t.error})` : ""}`}`));
		if (t.kind === "event" && t.meta?.label) this.eventLine(tab, t.meta.label, t.prompt);
		else if (isGoalRound(t.kind, t.meta?.label)) this.say(tab, c.gray(`↻ ${t.meta.label}`));
		else this.user(tab, t.prompt, t.kind === "prompt" ? undefined : t.kind);
		(t.meta?.images ?? []).forEach((_, i) => this.picture(tab, `attached picture ${i + 1}`, () => this.client.taskImage(t.id, i)));
		// It was read by work that was already running; the answer is that work's.
		if (t.meta?.steered !== undefined) return;
		if (t.status === "done") {
			if (t.result) tab.lastAnswer = t.result;
			this.add(tab, new Answer(t.result || "(no answer)"));
			this.answerPictures(tab, t.agent, t.result, false);
		}
		else if (t.status === "failed" || t.status === "cancelled") this.say(tab, c.red(`✗ ${t.status}${t.error ? `: ${t.error}` : ""}`));
		else this.say(tab, c.gray(`… ${t.status}`));
	}

	private flash(text: string, ms = 4000): void {
		this.notice = text;
		clearTimeout(this.noticeTimer);
		this.noticeTimer = setTimeout(() => {
			this.notice = "";
			this.tui.requestRender();
		}, ms);
		this.noticeTimer.unref?.();
		this.tui.requestRender();
	}

	// ---- input -----------------------------------------------------------------------------------

	/** Keys the app handles before the editor sees them. Returns true when the key is used up. */
	private onKey(data: string): boolean {
		if (this.dialog) return false;
		// Terminals that report key releases send one for the key that just closed a menu, and repeats
		// while it is held. Neither is a new key press: esc that closes a menu must not also stop the task.
		if (isKeyRelease(data)) return false;
		if (matchesKey(data, "escape") && (isKeyRepeat(data) || Date.now() - this.dialogClosedAt < 250)) return true;
		// Files dropped on the terminal arrive as pasted paths. Take them as attachments.
		const paste = data.match(/\x1b\[200~([\s\S]*?)\x1b\[201~/);
		if (paste && this.active.kind === "chat") {
			// One folder dropped on the terminal: that is the folder this conversation is to work in.
			const folder = droppedFiles(paste[1], true);
			if (folder?.length === 1) return void this.setFolder(this.active, folder[0]), true;
			const files = droppedFiles(paste[1]);
			if (files) return files.forEach((f) => this.attachFile(f)), true;
		}
		const empty = this.editor.getText().length === 0;
		// A terminal pastes text only. Where it passes ctrl+v on, a picture on the clipboard is attached; text is pasted as ever.
		if (matchesKey(data, "ctrl+v") && this.active.kind === "chat") void this.clipboardImage().then((file) => file && this.attachFile(file));
		// Enter gives a message to the work that is running; alt+enter makes it wait until that work is done.
		if (matchesKey(data, "alt+enter") && !empty && !this.editor.isShowingAutocomplete()) return void this.submit(this.editor.getText(), "queue"), true;
		if (matchesKey(data, "ctrl+c")) {
			if (!empty) {
				this.editor.setText("");
				this.tui.requestRender();
				return true;
			}
			if (Date.now() - this.lastCtrlC < 1500) return void this.stop(), true;
			this.lastCtrlC = Date.now();
			this.flash("press ctrl+c again to quit", 1500);
			return true;
		}
		if (matchesKey(data, "ctrl+d") && empty) return void this.stop(), true;
		if (this.editor.isShowingAutocomplete()) {
			// A command typed in full and without arguments runs on enter, even if the suggestion list
			// has not caught up with fast typing. With arguments, enter belongs to the list: it picks
			// the highlighted suggestion.
			const text = this.editor.getText();
			if (matchesKey(data, "enter") && /^\/\S+$/.test(text) && this.commands.some((x) => x.name === text.slice(1))) return void this.submit(text), true;
			// Picking an argument (a model, an agent, a session) also runs the command: one enter, not two.
			if (matchesKey(data, "enter") && /^\/\S+\s/.test(text)) {
				setImmediate(() => {
					const picked = this.editor.getText();
					// If the editor already sent the line, it is empty by now and nothing happens here.
					if (!this.editor.isShowingAutocomplete() && picked.startsWith("/")) void this.submit(picked);
				});
			}
			return false;
		}
		if (matchesKey(data, "escape") && this.active.running.size) return void this.stopRunning(this.active), true;
		// Between two rounds of a goal nothing runs, but the next round is about to start: esc holds it back.
		if (matchesKey(data, "escape") && this.active.goal?.status === "active") return void this.goal("pause").catch((e) => this.flash(errText(e))), true;
		if (matchesKey(data, "tab") && empty) return this.cycle(1), true;
		// As in Claude Code and opencode: shift+tab steps through the modes.
		if (matchesKey(data, "shift+tab") && empty && this.active.kind === "chat") {
			const info = this.agents.find((a) => a.id === this.active.agent);
			const order = ["auto", "plan", "manual", "bypass"];
			return void this.setMode(this.active, order[(order.indexOf(info?.mode ?? "auto") + 1) % order.length]).catch((e) => this.flash(errText(e))), true;
		}
		if (matchesKey(data, "ctrl+t")) return void this.run("new"), true;
		if (matchesKey(data, "ctrl+g")) return this.showCode(!this.codeOpen), true;
		if (matchesKey(data, "ctrl+w")) return this.closeTab(this.active), true;
		for (let n = 1; n <= 9; n++) {
			if (matchesKey(data, `alt+${n}` as any) && this.tabs[n - 1]) return this.activate(this.tabs[n - 1]), true;
		}
		if (matchesKey(data, "pageUp")) return void this.active.scroll.scrollBy(-Math.max(1, this.active.scroll.viewportHeight - 2)), this.tui.requestRender(), true;
		if (matchesKey(data, "pageDown")) return void this.active.scroll.scrollBy(Math.max(1, this.active.scroll.viewportHeight - 2)), this.tui.requestRender(), true;
		return false;
	}

	/** A click on a web address. Only the web: nothing an answer contains may launch a program or open a file. */
	private open(url: string): void {
		if (!/^https?:\/\//i.test(url)) return;
		(this.opts.openUrl ?? openInSystem)(url);
		this.flash(`opened ${short(url, 90)}`, 2500);
	}

	/**
	 * Send what was typed. While the agent works, a message goes into that work at its next step
	 * ("steer"), so a correction lands without stopping anything; "queue" keeps it for afterwards.
	 */
	private async submit(raw: string, whenBusy: "steer" | "queue" = "steer"): Promise<void> {
		const text = raw.trim();
		if (!text) return;
		this.editor.addToHistory(text);
		this.editor.setText("");
		if (text.startsWith("/")) return this.run(text.slice(1));
		const tab = this.active;
		if (tab.kind !== "chat") return this.flash(tab.kind === "task" ? "this tab shows one task's work and takes no messages; write in the conversation tab" : "this tab only shows events; switch to a conversation tab to write");
		const files = tab.attachments.splice(0);
		this.user(tab, files.length ? `${text}\n${c.gray(`attached: ${files.map((f) => f.name).join(", ")}`)}` : text);
		for (const f of files.filter((x) => isImageFile(x.name))) this.picture(tab, f.name, async () => ({ mime: mimeOf(f.name), bytes: await fs.promises.readFile(f.path) }));
		for (const f of files.filter((x) => isVideoFile(x.name))) {
			// Played from where it lies; nothing is copied.
			const slot = new Slot();
			tab.doc.addChild(slot);
			void this.video(f.path, f.name).then((v) => ((slot.inner = v), this.active === tab && v.play(), this.tui.requestRender())).catch(() => {});
		}
		tab.awaiting.push(text);
		tab.scroll.scrollToEnd();
		try {
			const attachments = files.map((f) => ({ name: f.name, data: fs.readFileSync(f.path).toString("base64") }));
			const busy = tab.running.size > 0;
			// Only what the list offered counts as a file: "@somebody" in a sentence is not one.
			const mentions = mentionsIn(text).filter((m) => tab.files.has(m.split("#")[0]));
			const { task, steered } = await this.client.prompt(tab.agent, text, tab.session, attachments.length ? attachments : undefined, whenBusy, mentions.length ? mentions : undefined);
			this.adopt(tab, task);
			if (steered !== undefined) {
				tab.awaiting = tab.awaiting.filter((p) => p !== text);
				this.flash("given to the agent while it works (alt+enter makes a message wait its turn instead)", 2500);
			} else if (busy) this.flash("waits its turn: it is answered when the work that is running is done", 2500);
		} catch (e) {
			tab.awaiting = tab.awaiting.filter((p) => p !== text);
			tab.attachments.unshift(...files);
			this.say(tab, c.red(`✗ not sent: ${errText(e)}`));
		}
	}

	private attachFile(file: string): void {
		const tab = this.active;
		if (tab.kind !== "chat") return this.flash("switch to a conversation tab to attach files");
		try {
			const full = path.resolve(expandHome(file));
			const stat = fs.statSync(full);
			if (!stat.isFile()) return this.flash(`${file} is not a file`);
			if (stat.size > MAX_ATTACHMENT) return this.flash(`${path.basename(full)} is larger than 20 MB`);
			if (tab.attachments.length >= 10) return this.flash("at most 10 files per message");
			if (!tab.attachments.some((a) => a.path === full)) tab.attachments.push({ path: full, name: path.basename(full), size: stat.size });
			this.tui.requestRender();
		} catch {
			this.flash(`cannot read ${file}`);
		}
	}

	/** Open a list over the conversation and resolve with what was chosen. */
	private pick(title: string, items: SelectItem[], current?: string): Promise<string | undefined> {
		if (this.dialog) return Promise.resolve(undefined);
		return new Promise((resolve) => {
			const picker = new Picker(title, items, (value) => {
				this.closeDialog();
				resolve(value);
			}, current);
			const handle = this.tui.showOverlay(picker, { anchor: "center", width: "64%", minWidth: 44, maxHeight: "80%" });
			handle.focus();
			this.dialog = { id: `pick:${title}`, handle, dismiss: () => (this.closeDialog(), resolve(undefined)) };
			this.tui.requestRender();
		});
	}

	private async pickAgent(): Promise<void> {
		// Below the agents: what this conversation has started, so a sub-agent can be found and looked at.
		const helpers = [...this.active.children].reverse().slice(0, 8).map(([id, x]) => ({ value: `task:${id}`, label: `↳ #${id} ${childKind(x.kind)}`, description: `${x.running ? "running" : "finished"} · ${x.agent} · ${x.label}` }));
		// Asked anew each time: the main agent can create agents while pine runs.
		this.agents = await this.client.agents().catch(() => this.agents);
		const id = await this.pick("Agent", [...this.agents.map((a) => ({ value: a.id, label: a.id, description: a.description || a.model })), ...helpers], this.active.agent);
		if (id?.startsWith("task:")) await this.openTask(Number(id.slice(5)));
		else if (id) await this.openTab(id, "main");
	}

	private async pickSession(): Promise<void> {
		const t = this.active;
		if (t.kind !== "chat") return;
		if (this.dialog) return;
		const agent = t.agent;
		const isOpen = (session: string) => this.tabs.some((x) => x.kind === "chat" && x.agent === agent && x.session === session);
		const list = (await this.client.sessions(agent).catch(() => [] as Conversation[])).map((s) => ({ ...s, open: isOpen(s.session) }));
		const close = () => this.closeDialog();
		const view = new ConversationList(`Conversations of ${agent}`, list, t.session, {
			open: (session) => (close(), void this.openTab(agent, session)),
			fresh: () => (close(), void this.run("new")),
			pin: async (conv) => {
				try {
					return (await this.client.pinSession(agent, conv.session, !conv.pinned)).pinned;
				} catch (e) {
					this.flash(errText(e));
					return conv.pinned;
				}
			},
			remove: async (conv) => {
				let gone: { unsubscribed: string[]; sources: string[]; servers: string[] };
				try {
					gone = await this.client.removeSession(agent, conv.session);
				} catch (e) {
					this.flash(errText(e), 6000);
					return false;
				}
				// A tab that showed it has nothing left to show.
				const showing = this.tabs.filter((x) => x.kind === "chat" && x.agent === agent && x.session === conv.session);
				for (const tab of showing) this.tabs.splice(this.tabs.indexOf(tab), 1);
				if (showing.includes(this.active)) {
					close();
					if (this.tabs.length) this.activate(this.tabs[0]);
					else await this.openTab(agent, "main");
				}
				this.saveTabs();
				// What was set up for it alone went with it; say so, since it is gone for good.
				const with_ = [...(gone.sources.length ? [`its event source${gone.sources.length === 1 ? "" : "s"} ${gone.sources.join(", ")}`] : gone.unsubscribed.length ? [`its subscription${gone.unsubscribed.length === 1 ? "" : "s"} to ${gone.unsubscribed.join(", ")}`] : []), ...(gone.servers.length ? [`its MCP server${gone.servers.length === 1 ? "" : "s"} ${gone.servers.join(", ")}`] : [])];
				this.flash(`removed the conversation ${conv.session} of ${agent}${with_.length ? `, with ${with_.join(" and ")}` : ""}`, with_.length ? 7000 : 4000);
				return true;
			},
			close,
			redraw: () => this.tui.requestRender(),
		});
		const handle = this.tui.showOverlay(view, { anchor: "center", width: "72%", minWidth: 50, maxHeight: "80%" });
		handle.focus();
		this.dialog = { id: "conversations", handle, dismiss: close };
		this.tui.requestRender();
	}

	private async pickModel(): Promise<void> {
		const t = this.active;
		if (t.kind !== "chat") return;
		const info = this.agents.find((a) => a.id === t.agent)!;
		const models = await this.client.models();
		const model = await this.pick(`Model for ${t.agent}`, models.map((m) => ({ value: m, label: m })), info.model);
		if (model) await this.run(`model ${model}`);
	}

	private async pickReasoning(): Promise<void> {
		const t = this.active;
		if (t.kind !== "chat") return;
		const info = this.agents.find((a) => a.id === t.agent)!;
		const level = await this.pick(`Reasoning for ${t.agent}`, REASONING_ITEMS, info.thinking);
		if (level) await this.run(`reasoning ${level}`);
	}

	private async pickMode(): Promise<void> {
		const t = this.active;
		if (t.kind !== "chat") return;
		const info = this.agents.find((a) => a.id === t.agent)!;
		const mode = await this.pick(`Mode for ${t.agent}`, MODE_ITEMS, info.mode);
		if (mode) await this.setMode(t, mode);
	}

	private isTainted(t: Tab): boolean {
		return this.taints.has(`${t.agent}:${t.session}`);
	}

	private async setMode(t: Tab, mode: string): Promise<void> {
		const info = this.agents.find((a) => a.id === t.agent)!;
		if (!MODE_ITEMS.some((m) => m.value === mode)) return this.flash("modes: auto, plan, manual, bypass");
		let anyway: string | undefined;
		await this.refreshTaints();
		if (mode === "bypass" && this.isTainted(t) && !this.bypassWhenTainted) {
			// Bypass normally stops applying once a conversation has read outside content. Make that a choice, not a surprise.
			const choice = await this.pick("This conversation has read outside content", [
				{ value: "new", label: "Bypass in a new, clean conversation", description: "recommended" },
				{ value: "anyway", label: "Bypass here anyway", description: "what it read could steer an agent with your whole account" },
				{ value: "cancel", label: "Cancel" },
			]);
			if (!choice || choice === "cancel") return;
			if (choice === "anyway") anyway = t.session;
			else {
				await this.client.setMode(t.agent, mode);
				info.mode = "bypass";
				await this.openTab(t.agent, `s${Date.now().toString(36)}`);
				return void this.say(this.active, `${c.gray(`${t.agent} is in`)} ${c.bold("bypass")} ${c.gray("mode in this new conversation.")}${c.yellow(" Nothing waits for approval, and its shell and file tools reach your whole account and the network.")}`);
			}
		}
		await this.client.setMode(t.agent, mode, anyway);
		info.mode = mode as any;
		t.pauseNoted = false;
		const note = mode === "bypass" ? c.yellow(" Nothing waits for approval now, and its shell and file tools reach your whole account and the network.") : mode === "plan" ? c.gray(" It looks, reads and asks, and changes nothing: ask for what you want, read its plan, then switch to auto to have it carried out.") : "";
		this.say(t, `${c.gray(`${t.agent} is now in`)} ${c.bold(mode)} ${c.gray("mode (until the daemon restarts; set \"mode\" in agent.json to keep it).")}${note}`);
		await this.refreshTaints();
	}

	private adopt(tab: Tab, task: number): void {
		if (tab.roots.has(task)) return;
		tab.roots.add(task);
	}

	/**
	 * Call for the owner's attention while they are looking at something else: the terminal's bell
	 * and a notification through the terminal (OSC 9, which Ghostty, iTerm and others show as a
	 * system notification). The text is pine's own; nothing an agent or a page wrote goes into it.
	 */
	private attention(text: string): void {
		if (!this.notify || this.focused || this.stopped) return;
		this.opts.terminal.write(`\x07\x1b]9;${text.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120)}\x1b\\`);
	}

	/**
	 * The picture on the clipboard (a screenshot, say), saved as a file to attach. A terminal pastes
	 * text only, so the clipboard is asked directly, on the machine the UI runs on.
	 */
	private clipboardImage(): Promise<string | undefined> {
		if (this.opts.clipboardImage) return this.opts.clipboardImage();
		const file = path.join(os.tmpdir(), `pine-paste-${Date.now().toString(36)}.png`);
		const kept = () => {
			try {
				return fs.statSync(file).size > 0 ? file : (fs.rmSync(file, { force: true }), undefined);
			} catch {
				return undefined;
			}
		};
		return new Promise((resolve) => {
			if (process.platform === "darwin") {
				// The path is pine's own, made above; nothing typed or received goes into the script.
				const script = ["set png to (the clipboard as «class PNGf»)", `set f to open for access POSIX file "${file}" with write permission`, "write png to f", "close access f"];
				const child = spawn("/usr/bin/osascript", script.flatMap((line) => ["-e", line]), { stdio: "ignore" });
				child.on("error", () => resolve(undefined));
				child.on("close", () => resolve(kept()));
				return;
			}
			const [cmd, ...args] = process.env.WAYLAND_DISPLAY ? ["wl-paste", "-t", "image/png"] : ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"];
			const child = spawn(cmd, args, { stdio: ["ignore", fs.openSync(file, "w"), "ignore"] });
			child.on("error", () => resolve(kept()));
			child.on("close", () => resolve(kept()));
		});
	}

	private copyText(text: string): Promise<true | string> {
		if (this.opts.copy) return this.opts.copy(text);
		return new Promise((resolve) => {
			const [copy, ...args] = process.platform === "darwin" ? ["pbcopy"] : process.env.WAYLAND_DISPLAY ? ["wl-copy"] : ["xclip", "-selection", "clipboard"];
			const child = spawn(copy, args, { stdio: ["pipe", "ignore", "ignore"] });
			child.on("error", (e) => resolve(e.message));
			child.on("close", (code) => resolve(code === 0 ? true : `copy failed (${code})`));
			child.stdin.end(text);
		});
	}

	/**
	 * The conversation as Markdown: what was said, in order. With `full`, also what the agent thought
	 * and which tools it called, read from each task's record.
	 */
	private async markdownOf(tab: Tab, full: boolean): Promise<string> {
		const tasks = (await this.client.history(tab.agent, tab.session, 500)).filter((t) => t.depth === 0).reverse();
		const out = [`# ${tab.agent} · ${tab.session}`, "", `Exported from pine on ${new Date().toLocaleString("sv-SE")}.`];
		for (const t of tasks) {
			if (t.meta?.compact) {
				out.push("", "---", "", `*${t.result || "The earlier part of the conversation was summarised here."}*`);
				continue;
			}
			out.push("", t.kind === "prompt" ? (t.meta?.steered !== undefined ? "## You, while the agent worked" : "## You") : `## ${t.kind === "event" ? `Event${t.meta?.label ? `: ${t.meta.label}` : ""}` : `pine (${t.kind})`}`, "", t.prompt.trim());
			if (t.meta?.steered !== undefined) continue;
			if (full) {
				const steps = (await this.client.transcript(t.id).catch(() => undefined))?.entries ?? [];
				for (const e of steps) {
					if (e.kind === "thinking" && e.text?.trim()) out.push("", "<details><summary>Thinking</summary>", "", e.text.trim(), "", "</details>");
					else if (e.kind === "tool") out.push("", `- ${e.ok === false ? "✗" : "✓"} \`${e.tool}\`${e.subject ? ` ${oneLine(e.subject)}` : ""}${e.ok === false && e.result ? `: ${short(oneLine(e.result), 300)}` : ""}`);
				}
			}
			out.push("", `## ${t.agent}`, "", t.status === "done" ? t.result?.trim() || "(no answer)" : `*${t.status}${t.error && t.error !== t.status ? `: ${t.error}` : ""}*`);
		}
		return `${out.join("\n")}\n`;
	}

	/**
	 * esc stops what is running. A message typed while the agent worked starts the moment that
	 * work stops, and the status line says "working" again: a second esc, pressed because nothing
	 * seemed to happen, would stop that message too. So for a few seconds after a stop, esc leaves
	 * alone a message that was waiting when it was pressed.
	 */
	private async stopRunning(tab: Tab): Promise<void> {
		const recent = tab.stopped && Date.now() - tab.stopped.at < STOP_GRACE ? tab.stopped : undefined;
		const ids = [...tab.running].filter((id) => !recent?.spared.has(id));
		if (!ids.length) return this.flash("stopped. This is your next message being answered; esc again in a moment stops it too", 4000);
		tab.stopped = { at: Date.now(), waiting: tab.awaiting.length, spared: recent?.spared ?? new Set() };
		for (const id of ids) await this.client.cancel(id).catch(() => {});
		this.flash("stopping…", 1500);
	}

	// ---- commands --------------------------------------------------------------------------------

	private defineCommands(): void {
		const agentIds = (prefix: string) => this.agents.filter((a) => a.id.startsWith(prefix)).map((a) => ({ value: a.id, label: a.id, description: a.description }));
		const chat = (): Tab | undefined => (this.active.kind === "chat" ? this.active : (this.flash("switch to a conversation tab first"), undefined));
		this.commands = [
			{ name: "help", description: "Commands and keys", run: () => this.help() },
			{
				name: "new", description: "New conversation with this agent in a new tab", argumentHint: "[name]",
				run: (args) => this.openTab(this.active.kind === "chat" ? this.active.agent : this.agents[0].id, args.trim() || `s${Date.now().toString(36)}`),
			},
			{
				name: "agent", description: "Open a tab with another agent", argumentHint: "<id> [session]", getArgumentCompletions: agentIds,
				run: (args) => {
					const [id, session] = args.trim().split(/\s+/);
					if (!id) return this.pickAgent();
					if (!this.agents.some((a) => a.id === id)) return this.flash(`no agent "${id}"`);
					return this.openTab(id, session || "main");
				},
			},
			{
				name: "sessions", description: "List this agent's conversations, or open one", argumentHint: "[name]",
				getArgumentCompletions: async (prefix) => {
					const t = this.active;
					if (t.kind !== "chat") return null;
					return (await this.client.sessions(t.agent).catch(() => [])).filter((s) => s.session.startsWith(prefix)).map((s) => ({ value: s.session, label: s.session, description: `${s.tasks} messages` }));
				},
				run: async (args) => {
					const t = chat();
					if (!t) return;
					if (args.trim()) return this.openTab(t.agent, args.trim());
					return this.pickSession();
				},
			},
			{ name: "tab", description: "Go to tab number", argumentHint: "<n>", run: (args) => (this.tabs[Number(args) - 1] ? this.activate(this.tabs[Number(args) - 1]) : this.flash("no such tab")) },
			{ name: "close", description: "Close this tab (the conversation stays in the list)", run: () => this.closeTab(this.active) },
			{
				name: "rename", description: "Give this conversation, and its tab, another name", argumentHint: "<name>",
				run: async (args) => {
					const t = chat();
					if (!t) return;
					if (!args.trim()) return this.flash("usage: /rename <name>");
					const was = t.session;
					const now = (await this.client.renameSession(t.agent, was, args.trim())).session;
					for (const tab of this.tabs) if (tab.kind === "chat" && tab.agent === t.agent && tab.session === was) tab.session = now;
					this.saveTabs();
					await this.refreshTaints();
					this.say(t, c.gray(`this conversation is now called ${c.bold(now)}`));
				},
			},
			{
				name: "pin", description: "Keep this conversation however long it is not used; /unpin takes that back",
				run: async () => {
					const t = chat();
					if (!t) return;
					if (t.session === "main") return this.flash("the main conversation always stays");
					await this.client.pinSession(t.agent, t.session, true);
					this.say(t, c.gray("pinned: this conversation stays until you remove it"));
				},
			},
			{
				name: "unpin", description: "Let this conversation go when it has not been used for a while",
				run: async () => {
					const t = chat();
					if (!t) return;
					await this.client.pinSession(t.agent, t.session, false);
					this.say(t, c.gray("not pinned any more: it is removed by itself once it is neither open nor used for some days"));
				},
			},
			{
				name: "reset", description: "Forget this conversation and start fresh",
				run: async () => {
					const t = chat();
					if (!t) return;
					await this.client.reset(t.agent, t.session);
					t.doc.clear();
					t.roots.clear();
					t.context = undefined;
					t.cacheShare = undefined;
					this.taints.delete(`${t.agent}:${t.session}`);
					this.say(t, c.gray("fresh conversation"));
				},
			},
			{ name: "undo", description: "Take back your last message: its files are restored, the conversation forgets it, its text returns to the input", run: () => this.undo(false) },
			{ name: "redo", description: "Bring back what the last /undo took, until you send a new message", run: () => this.undo(true) },
			{
				name: "folder", description: "The folder this conversation works in: open one, or none", argumentHint: "[path|none]",
				run: async (args) => {
					const t = chat();
					if (!t) return;
					const wanted = args.trim();
					if (!wanted) return this.pickFolder();
					return this.setFolder(t, /^(none|off|-)$/i.test(wanted) ? null : (droppedFiles(wanted, true)?.[0] ?? wanted));
				},
			},
			{
				name: "code", description: "The pane beside the conversation: changes (git), files, tool output", argumentHint: "[changes|files|output|off]",
				getArgumentCompletions: (prefix) => [...PANE_VIEWS, "turn", "off"].filter((v) => v.startsWith(prefix.trim())).map((v) => ({ value: v, label: v, description: PANE_HELP[v] })),
				run: (args) => {
					const word = args.trim().toLowerCase();
					if (word && word !== "off" && word !== "turn" && !PANE_VIEWS.includes(word as PaneView)) return this.flash("usage: /code [changes|turn|files|output|running|blocked|off]");
					if (this.active.kind !== "chat") return this.flash("switch to a conversation tab first");
					// What the last message changed: the changes view, counted from before that message.
					if (word === "turn") return this.showCode(true), this.code.showTurn();
					// Without a word it opens and closes, like the button and ctrl+g.
					this.showCode(word ? word !== "off" : !this.codeOpen, word && word !== "off" ? (word as PaneView) : undefined);
				},
			},
			{
				name: "goal", description: "Keep the agent working until something is reached; /goal alone shows where it stands", argumentHint: "[objective|pause|resume|clear]",
				getArgumentCompletions: (prefix) =>
					[
						{ value: "pause", label: "pause", description: "no further rounds until /goal resume" },
						{ value: "resume", label: "resume", description: "go on with a goal that stopped" },
						{ value: "clear", label: "clear", description: "take the goal off this conversation" },
					].filter((w) => prefix.trim() !== "" && w.value.startsWith(prefix.trim().toLowerCase())),
				run: (args) => this.goal(args.trim()),
			},
			{ name: "stop", description: "Stop what the agent is doing (also: esc)", run: () => (this.active.running.size ? this.stopRunning(this.active) : this.flash("nothing is running")) },
			{
				name: "model", description: "Show or switch this agent's model", argumentHint: "[provider/id]",
				getArgumentCompletions: async (prefix) => (await this.client.models().catch(() => [])).filter((m) => m.includes(prefix)).slice(0, 50).map((m) => ({ value: m, label: m })),
				run: async (args) => {
					const t = chat();
					if (!t) return;
					const info = this.agents.find((a) => a.id === t.agent)!;
					if (!args.trim()) return this.pickModel();
					await this.client.setModel(t.agent, args.trim());
					info.model = args.trim();
					this.say(t, c.gray(`${t.agent} now uses ${c.bold(info.model)} (saved as its model)`));
				},
			},
			{
				name: "reasoning", description: "How much this agent's model thinks before it answers", argumentHint: "[off|minimal|low|medium|high|xhigh|max]",
				getArgumentCompletions: (prefix) => REASONING_ITEMS.filter((x) => x.value.startsWith(prefix.trim())),
				run: async (args) => {
					const t = chat();
					if (!t) return;
					const level = args.trim();
					if (!level) return this.pickReasoning();
					await this.client.setThinking(t.agent, level);
					this.agents.find((a) => a.id === t.agent)!.thinking = level;
					this.say(t, c.gray(`${t.agent} now reasons at level ${c.bold(level)} (saved; a model that cannot reason ignores it)`));
				},
			},
			{
				name: "mode", description: "How much this agent may do without asking", argumentHint: "[auto|plan|manual|bypass]",
				getArgumentCompletions: (prefix) =>
					[
						{ value: "manual", label: "manual", description: "ask before every action" },
						{ value: "auto", label: "auto", description: "work freely within the agent's reach, ask for the rest" },
						{ value: "bypass", label: "bypass", description: "never ask; shell and files reach your whole account" },
					].filter((m) => m.value.startsWith(prefix.trim())),
				run: async (args) => {
					const t = chat();
					if (!t) return;
					return args.trim() ? this.setMode(t, args.trim()) : this.pickMode();
				},
			},
			{
				name: "attach", description: "Attach a file to your next message (or drop it on the terminal)", argumentHint: "<path>",
				run: (args) => (args.trim() ? (droppedFiles(args.trim()) ?? [args.trim()]).forEach((f) => this.attachFile(f)) : this.flash("usage: /attach <path>, or drag a file onto the terminal")),
			},
			{
				name: "detach", description: "Remove attached files", argumentHint: "[n]",
				run: (args) => {
					const t = this.active;
					if (args.trim()) t.attachments.splice(Number(args) - 1, 1);
					else t.attachments = [];
					this.tui.requestRender();
				},
			},
			{
				name: "status", description: "Running tasks and live sessions",
				run: async () => {
					const s = await this.client.status();
					const lines = [
						`${c.gray("model slots")} ${s.limiter.active}/${s.limiter.max} busy, ${s.limiter.waiting} waiting`,
						...s.running.map((r: any) => `${c.yellow("●")} task #${r.task} ${r.agent}/${r.session} ${c.gray(r.kind)}`),
						...s.sessions.map((x: any) => `${c.gray("session")} ${x.agent}/${x.session}${x.busy ? c.yellow(" busy") : ""}${x.tainted ? c.yellow(` tainted: ${x.tainted}`) : ""}`),
					];
					this.say(this.active, lines.join("\n"));
				},
			},
			{
				name: "sources", description: "Event sources: what can wake an agent, and who is subscribed",
				run: async () => {
					const list = await this.client.sources();
					const t = this.active;
					if (!list.length) return void this.say(t, c.gray(`no event sources configured. They go into "sources" in pine.json (for every agent) or an agent.json; docs/references/sources.md has the types.`));
					this.say(t, list.map((x) => `${c.bold(x.name)}${x.scope === "global" ? "" : c.gray(` (of ${x.scope})`)} ${c.gray(x.type)} ${x.error ? c.red(`not running: ${x.error}`) : x.running ? c.green("running") : c.gray("idle")}${x.description ? c.gray(` · ${x.description}`) : ""}${x.status ? `\n  ${x.status}` : ""}\n${c.gray(`  subscribers: ${x.subscribers.join(", ") || "none"} · ${x.last ? `last event ${new Date(x.last.ts).toLocaleTimeString("sv-SE")}, ${x.events} since start` : "no events since start"}`)}`).join("\n"));
					this.say(t, c.gray("/subscribe <source> [what to do] wakes this tab's agent on its events · /unsubscribe <source> stops that"), false);
				},
			},
			{
				name: "subscribe", description: "Wake on an event source: this conversation (local), the agent, or all agents (global)", argumentHint: "[local|agent|global] <source> [what to do]",
				getArgumentCompletions: async (prefix) => {
					const words = prefix.split(/\s+/);
					const scoped = SCOPES.includes(words[0]);
					if (words.length > (scoped ? 2 : 1)) return null;
					const typed = scoped ? (words[1] ?? "") : words[0];
					const lead = scoped ? `${words[0]} ` : "";
					const sources = (await this.client.sources().catch(() => [])).filter((x) => String(x.name).startsWith(typed)).map((x) => ({ value: `${lead}${x.name} `, label: x.name, description: `${x.type}${x.description ? ` · ${x.description}` : ""}` }));
					return scoped ? sources : [...SCOPES.filter((x) => x.startsWith(typed)).map((x) => ({ value: `${x} `, label: x, description: SCOPE_HELP[x] })), ...sources];
				},
				run: async (args) => {
					const t = chat();
					if (!t) return;
					const words = args.trim().split(/\s+/).filter(Boolean);
					// Said without a scope, it means here: this conversation. In an agent's main conversation that is the agent.
					const scope = SCOPES.includes(words[0]) ? words.shift()! : "local";
					const [source, ...note] = words;
					if (!source) return this.flash("usage: /subscribe [local|agent|global] <source> [what the agent should do]  (see /sources)");
					const details = { note: note.join(" ") || undefined };
					if (scope === "global") {
						const info = await this.client.subscribeAll(source, details);
						return void this.say(t, `${c.green("✓")} ${c.gray(`all agents are subscribed to ${source} (${info.running ? "running" : "not running"}). Each event wakes ${info.agents.join(", ") || "nobody yet"}, each in its main conversation.`)}`);
					}
					const local = scope === "local" && t.session !== "main";
					const info = await this.client.subscribeTo(t.agent, source, { ...details, session: local ? t.session : "main" });
					this.say(t, `${c.green("✓")} ${c.bold(t.agent)} ${c.gray(`is subscribed to ${source} (${info.running ? "running" : "not running"}). ${local ? "Each event arrives here, in this conversation, and wakes it. Closing this conversation ends the subscription." : `Each event arrives in its main conversation${t.session === "main" ? ", here," : ""} and wakes it.`}`)}`);
				},
			},
			{
				name: "unsubscribe", description: "End a subscription of this conversation, the agent, or all agents", argumentHint: "[local|agent|global] <source>",
				getArgumentCompletions: async (prefix) => (prefix.trim().includes(" ") ? null : (await this.client.sources().catch(() => [])).filter((x) => String(x.name).startsWith(prefix.trim()) && x.subscribers.length).map((x) => ({ value: x.name, label: x.name, description: `${x.type} · subscribed: ${x.subscribers.join(", ")}` }))),
				run: async (args) => {
					const t = chat();
					if (!t) return;
					const words = args.trim().split(/\s+/).filter(Boolean);
					const scope = SCOPES.includes(words[0]) ? words.shift()! : t.session === "main" ? "agent" : "local";
					const source = words[0];
					if (!source) return this.flash("usage: /unsubscribe [local|agent|global] <source>");
					if (scope === "global") return void this.say(t, c.gray((await this.client.unsubscribeAll(source)).unsubscribed ? `all agents: no longer subscribed to ${source}` : `there was no subscription of all agents to ${source}`));
					const session = scope === "agent" ? "main" : t.session;
					const r = await this.client.unsubscribeFrom(t.agent, source, session);
					const what = session === "main" ? t.agent : "this conversation";
					this.say(t, c.gray(r.unsubscribed ? `${what} is no longer subscribed to ${source}` : `${what} was not subscribed to ${source} on its own (see /sources for who is)`));
				},
			},
			{
				name: "mcp", description: "MCP servers: list them, or sign in to one", argumentHint: "[login [name]]",
				getArgumentCompletions: async (prefix) => {
					if (!prefix.startsWith("login ")) return [{ value: "login ", label: "login", description: "sign in to a remote server through the browser" }].filter((x) => x.value.startsWith(prefix));
					// Only the names here: asking every server for its state would take seconds.
					const servers = (await this.opts.mcp?.list(false).catch(() => [])) ?? [];
					const typed = prefix.slice(6).trim();
					return servers.filter((sv) => /^https?:/.test(sv.target) && sv.name.includes(typed)).map((sv) => ({ value: `login ${sv.name}`, label: sv.name, description: sv.target }));
				},
				run: async (args) => {
					const t = this.active;
					const mcp = this.opts.mcp;
					if (!mcp) return this.flash("not available in this UI; use pine mcp in a shell");
					const [sub, given] = args.trim().split(/\s+/);
					const table = (servers: Awaited<ReturnType<typeof mcp.list>>, checking: boolean) =>
						servers.length
							? servers.map((sv) => `${c.bold(sv.name.padEnd(14))} ${(/^connected/.test(sv.state ?? "") ? c.green : /sign-in/.test(sv.state ?? "") ? c.yellow : c.gray)((sv.state ?? (checking ? "checking…" : "")).padEnd(16))} ${c.gray(sv.scope === "global" ? `all agents: ${sv.agents.join(", ") || "nobody"}` : `only ${sv.scope}`)}\n${" ".repeat(15)}${c.gray(sv.target)}`).join("\n")
							: c.gray("no MCP servers configured");
					if (!sub) {
						// Show what is configured at once; whether each server connects arrives a moment later.
						const line = this.say(t, table(await mcp.list(false), true));
						void mcp.list(true).then((servers) => (line.setText(table(servers, false)), this.tui.requestRender())).catch(() => {});
						return;
					}
					if (sub !== "login") return this.flash("usage: /mcp, or /mcp login [name]");
					let name: string | undefined = given;
					if (!name) {
						const remote = (await mcp.list(false)).filter((sv) => /^https?:/.test(sv.target));
						if (!remote.length) return this.flash("no remote MCP server is configured");
						name = remote.length === 1 ? remote[0].name : await this.pick("Sign in to which server?", remote.map((sv) => ({ value: sv.name, label: sv.name, description: sv.target })));
						if (!name) return;
					}
					const line = this.say(t, c.gray(`signing in to ${name}… your browser opens the sign-in page`));
					let shown = "";
					const code = await mcp.login(name, (text) => {
						shown += text;
						line.setText(c.gray(shown.trim()));
						this.tui.requestRender();
					});
					if (code !== 0) return void this.say(t, c.red(`sign-in to ${name} did not complete`), false);
					await this.client.post("/mcp/refresh").catch(() => {});
					this.say(t, `${c.green("✓")} signed in to ${c.bold(name)}${c.gray(". Its tools are available from your next message.")}`, false);
				},
			},
			{ name: "events", description: "Open the live event log", run: () => this.openEvents() },
			{
				name: "tasks", description: "Recent tasks of this agent",
				run: async () => {
					const t = this.active;
					const tasks = await this.client.get<Task[]>(`/tasks?limit=15${t.kind === "chat" ? `&agent=${t.agent}` : ""}`);
					this.say(t, tasks.reverse().map((x) => `${c.gray(`#${String(x.id).padEnd(4)}`)} ${(x.status === "done" ? c.green : x.status === "failed" ? c.red : c.yellow)(x.status.padEnd(9))} ${`${x.agent}/${x.session}`.padEnd(20)} ${c.gray(short(oneLine(x.meta?.label ?? x.prompt), 60))}`).join("\n") || c.gray("no tasks"));
					this.say(t, c.gray("/task <id> opens one and shows what it did"), false);
				},
			},
			{
				name: "task", description: "Show what one task did, step by step (a sub-agent, for example)", argumentHint: "<id>",
				getArgumentCompletions: async (prefix) => {
					const tasks = await this.client.get<Task[]>("/tasks?limit=40").catch(() => []);
					return tasks.filter((x) => String(x.id).startsWith(prefix.trim())).map((x) => ({ value: String(x.id), label: `#${x.id}`, description: `${x.depth > 0 ? childKind(x.kind) : x.kind} · ${x.agent} · ${x.status} · ${short(oneLine(x.meta?.label ?? x.prompt), 50)}` }));
				},
				run: (args) => (/^\d+$/.test(args.trim()) ? this.openTask(Number(args.trim())) : this.flash("usage: /task <id>  (the ids are in /tasks)")),
			},
			{ name: "approve", description: "Allow the action that waits for approval", argumentHint: "[id] [always]", run: (args) => this.answer(args.trim(), true) },
			{ name: "deny", description: "Refuse the action that waits for approval", argumentHint: "[id]", run: (args) => this.answer(args.trim(), false) },
			{
				name: "state", description: "Shared state", argumentHint: "[key pattern]",
				run: async (args) => {
					const rows = await this.client.state(args.trim() || "#");
					this.say(this.active, rows.map((r) => `${c.bold(r.key)} = ${JSON.stringify(r.value)}`).join("\n") || c.gray("nothing stored"));
				},
			},
			{
				name: "emit", description: "Publish an event as yourself", argumentHint: "<topic> [json]",
				run: async (args) => {
					const m = args.trim().match(/^(\S+)\s*([\s\S]*)$/);
					if (!m) return this.flash("usage: /emit <topic> [json]");
					const r = await this.client.emit(m[1], m[2] ? JSON.parse(m[2]) : null);
					this.flash(`event #${r.id} published on ${m[1]}`);
				},
			},
			{
				name: "paste", description: "Attach the picture that is on the clipboard (a screenshot, for example) to your next message",
				run: async () => {
					if (!chat()) return;
					const file = await this.clipboardImage();
					if (file) this.attachFile(file);
					else this.flash("there is no picture on the clipboard (text is pasted with your terminal's own paste)");
				},
			},
			{
				name: "notify", description: "Bell and notification when the agent is done or needs you while the terminal is not in front", argumentHint: "[on|off]",
				getArgumentCompletions: (prefix) => ["on", "off"].filter((x) => x.startsWith(prefix.trim())).map((x) => ({ value: x, label: x })),
				run: (args) => {
					const want = args.trim();
					if (want && want !== "on" && want !== "off") return this.flash("usage: /notify [on|off]");
					if (want) {
						this.notify = want === "on";
						this.saveTabs();
					}
					this.flash(this.notify ? "notifications are on: a bell and a notification when the agent is done, fails or needs your approval while this window is not in front" : "notifications are off");
				},
			},
			{
				name: "compact", description: "Shorten this conversation: its earlier part becomes a summary, which frees the model's context",
				run: async () => {
					const t = chat();
					if (t) this.adopt(t, (await this.client.compact(t.agent, t.session)).task);
				},
			},
			{
				name: "copy", description: "Copy the agent's last answer to the clipboard",
				run: async () => {
					const t = chat();
					if (!t) return;
					if (!t.lastAnswer) return this.flash("there is no answer to copy yet");
					const done = await this.copyText(t.lastAnswer);
					this.flash(done === true ? `copied the last answer (${t.lastAnswer.length} characters)` : `not copied: ${done}`);
				},
			},
			{
				name: "export", description: "Save this conversation as Markdown, or copy it", argumentHint: "[copy] [full]",
				getArgumentCompletions: (prefix) => [{ value: "copy", label: "copy", description: "to the clipboard instead of a file" }, { value: "full", label: "full", description: "with thinking and tool calls" }].filter((x) => x.value.startsWith(prefix.trim().split(/\s+/).at(-1) ?? "")),
				run: async (args) => {
					const t = chat();
					if (!t) return;
					const words = args.trim().split(/\s+/).filter(Boolean);
					const unknown = words.find((w) => w !== "copy" && w !== "full");
					if (unknown) return this.flash(`usage: /export [copy] [full] (not "${unknown}")`);
					const text = await this.markdownOf(t, words.includes("full"));
					if (words.includes("copy")) {
						const done = await this.copyText(text);
						return this.flash(done === true ? `copied the conversation as Markdown (${text.length} characters)` : `not copied: ${done}`);
					}
					const stamp = new Date().toLocaleString("sv-SE").replace(/[-:]/g, "").replace(" ", "-").slice(0, 13);
					const file = path.join(this.opts.cwd ?? process.cwd(), `pine-${`${t.agent}-${t.session}`.replace(/[^A-Za-z0-9._-]+/g, "_")}-${stamp}.md`);
					await fs.promises.writeFile(file, text, { flag: "wx" }).catch(async () => fs.promises.writeFile(file.replace(/\.md$/, `-${Date.now() % 1000}.md`), text));
					this.say(t, c.gray(`saved this conversation as ${tilde(file)}`));
				},
			},
			{ name: "clear", description: "Clear this tab's view (the conversation is kept)", run: () => (this.active.doc.clear(), this.tui.requestRender()) },
			{ name: "quit", description: "Leave", run: () => this.stop() },
			{ name: "exit", description: "Leave", run: () => this.stop() },
		];
	}

	private async run(input: string): Promise<void> {
		const m = input.match(/^(\S+)\s*([\s\S]*)$/);
		const cmd = m && this.commands.find((x) => x.name === m[1]);
		if (!cmd) return this.flash(`unknown command /${m?.[1] ?? ""} · /help lists them`);
		try {
			await cmd.run(m![2] ?? "");
		} catch (e) {
			this.say(this.active, c.red(`/${cmd.name}: ${errText(e)}`));
		}
	}

	private help(): void {
		const cmds = this.commands.filter((x) => x.name !== "exit").map((x) => `  ${c.accent(`/${x.name}`)}${x.argumentHint ? c.gray(` ${x.argumentHint}`) : ""}${" ".repeat(Math.max(1, 24 - x.name.length - (x.argumentHint?.length ?? -1) - 2))}${x.description}`);
		const keys = [
			["enter", "send; while the agent works, the message goes into that work at its next step"], ["alt+enter", "send, but let it wait until the agent is done with what it is doing"], ["shift+enter", "new line"], ["esc", "stop the agent"], ["tab", "next tab (when the input is empty)"], ["shift+tab", "next mode: auto, plan, manual, bypass (when the input is empty)"],
			["alt+1..9", "go to tab"], ["ctrl+t", "new conversation"], ["ctrl+w", "close tab"], ["ctrl+g", "open or close the code pane (changes, files, tool output)"], ["pgup / pgdn", "scroll"], ["mouse", "click a tab, its ×, +, ▤ code, a web address, a thought (to open it, and anywhere on it to close it), or agent / conversation / folder / model / reasoning / mode in the bottom bar; drop files to attach"], ["ctrl+c twice, ctrl+d", "quit"],
		].map(([k, d]) => `  ${c.accent(k.padEnd(22))} ${d}`);
		this.say(this.active, [c.bold("Commands"), ...cmds, "", c.bold("Keys"), ...keys].join("\n"));
	}

	// ---- approvals -------------------------------------------------------------------------------

	private ask(tab: Tab, req: any): void {
		if (this.dialog || tab !== this.active) return;
		const dialog =
			req.tool === "question"
				? new QuestionDialog(req, (answer) => {
						this.closeDialog();
						if (answer === undefined) return; // later: the status line keeps saying that something waits
						void this.client.decide(req.id, true, false, { answer }).catch((e) => this.flash(errText(e)));
					})
				: new ApprovalDialog(req, (answer, values) => {
						this.closeDialog();
						if (answer === "later") return; // the status line keeps saying that an approval is open
						void this.client.decide(req.id, answer !== "deny", answer === "always", values).catch((e) => this.flash(errText(e)));
					});
		const handle = this.tui.showOverlay(dialog, { anchor: "center", width: "76%", minWidth: 40 });
		handle.focus();
		this.dialog = { id: req.id, handle, dismiss: () => this.closeDialog() };
		this.tui.requestRender();
	}

	private closeDialog(): void {
		this.dialog?.handle.hide();
		this.dialog = undefined;
		this.dialogClosedAt = Date.now();
		this.tui.setFocus(this.editor);
		this.tui.requestRender();
	}

	private async answer(args: string, allow: boolean): Promise<void> {
		const words = args.split(/\s+/).filter(Boolean);
		const always = allow && words.includes("always");
		const id = words.find((w) => w !== "always") ?? "";
		const pending = await this.client.approvals();
		const target = id || (pending.length === 1 ? pending[0].id : "");
		if (!target) return this.flash(pending.length ? `several requests wait: ${pending.map((p) => p.id).join(", ")}` : "nothing waits for approval");
		// One that needs a value from you is answered in its dialog, where the value is typed without being shown.
		const req = pending.find((p) => p.id === target);
		if (allow && req?.inputs?.length) return this.ask(this.active, req);
		const r = await this.client.decide(target, allow, always);
		if (!r.decided) this.flash("that request was already answered");
	}

	// ---- events ----------------------------------------------------------------------------------

	private tabFor(p: any): Tab | undefined {
		if (p?.root !== undefined) {
			const byRoot = this.tabs.find((t) => t.kind === "chat" && t.roots.has(p.root));
			if (byRoot) return byRoot;
		}
		return undefined;
	}

	private onEvent(e: PineEvent): void {
		const p = (e.payload ?? {}) as any;
		const [ns, , kind] = e.topic.split("/");
		this.logEvent(e);

		if (ns === "approval") {
			if (e.topic === "approval/requested") {
				const tab = this.tabFor(p) ?? this.active;
				// A question of the agent's is not a permission: it is shown as what it is.
				const card =
					p.tool === "question"
						? this.say(tab, `${c.accent("? the agent asks")} ${short(oneLine(String(p.summary ?? "")), 300)}\n${c.gray("  answer it in the dialog, or with /approve")}`)
						: this.say(tab, `${c.yellow("⚠ approval needed")} ${c.bold(p.tool)} ${c.gray(short(oneLine(String(p.summary ?? "")), 120))}\n${c.gray(`  ${p.why} · ${p.inputs?.length ? "it needs something only you have: /approve opens the dialog to enter it" : `/approve${p.remember ? ", /approve always" : ""}`} or /deny`)}`);
				tab.approvals.set(p.id, { card, req: p });
				this.attention(p.tool === "question" ? `pine: ${tab.agent} has a question for you` : `pine: ${tab.agent} needs your approval`);
				this.ask(tab, p);
			} else if (e.topic === "approval/decided") {
				for (const tab of this.tabs) {
					const a = tab.approvals.get(p.id);
					if (!a) continue;
					if (a.req.tool === "question") a.card.setText(`${c.accent("?")} ${short(oneLine(String(a.req.summary ?? "")), 300)}\n${c.gray(`  ${p.allow ? `answered (${p.by})` : `no answer (${p.by})`}`)}`);
					else a.card.setText(`${p.allow ? c.green("✓ allowed") : c.red("✗ denied")} ${c.bold(a.req.tool)} ${c.gray(`(${p.by})${p.always ? ` · ${p.remember} will not ask again in this conversation` : ""}`)}`);
					tab.approvals.delete(p.id);
				}
				if (this.dialog?.id === p.id) this.closeDialog();
				this.tui.requestRender();
			}
			return;
		}
		if (ns !== "agent") return;
		if (kind === "goal") return this.goalEvent(p);

		// A tab on one task follows that task and whatever it starts itself.
		for (const t of this.tabs) {
			if (t.kind !== "task") continue;
			if (kind === "started" && p.parent !== undefined && t.roots.has(p.parent)) t.roots.add(p.task);
			if (t.roots.has(p.task)) this.live(t, kind, p, (p.depth ?? 0) - t.baseDepth);
		}

		if (kind === "steered") {
			// A message that went into running work: ours is on screen already, somebody else's is shown.
			const tab = this.tabs.find((t) => t.kind === "chat" && t.agent === p.agent && t.session === p.session);
			if (!tab || tab.roots.has(p.by)) return;
			tab.roots.add(p.by);
			const i = tab.awaiting.findIndex((a) => String(p.prompt ?? "").startsWith(a));
			if (i >= 0) tab.awaiting.splice(i, 1);
			else this.user(tab, String(p.prompt ?? ""), p.kind === "prompt" ? "elsewhere" : p.kind);
			this.tui.requestRender();
			return;
		}

		if (kind === "started" && p.depth === 0) {
			// A top-level task: ours (sent from a tab) or someone else's in a session a tab shows.
			let tab = this.tabFor(p) ?? this.tabs.find((t) => t.kind === "chat" && t.agent === p.agent && t.session === p.session);
			if (!tab) {
				// An event woke the agent in a conversation nobody is looking at: say so where that agent is on screen.
				const home = p.kind === "event" ? this.tabs.find((t) => t.kind === "chat" && t.agent === p.agent) : undefined;
				if (home) this.button(home, `${c.yellow("⚡")} ${c.gray(`an event woke ${p.agent} in the conversation`)} ${c.bold(String(p.session))} ${c.accent("▸ open")}`, () => void this.openTab(p.agent, String(p.session)), true);
				return;
			}
			const i = tab.awaiting.findIndex((a) => String(p.prompt ?? "").startsWith(a));
			if (i >= 0) {
				tab.awaiting.splice(i, 1);
				// It waited behind work that esc just stopped: the next esc is not meant for it.
				if (tab.stopped && tab.stopped.waiting > 0 && Date.now() - tab.stopped.at < STOP_GRACE) {
					tab.stopped.waiting--;
					tab.stopped.spared.add(p.task);
				}
			} else if (p.compact) {
				this.say(tab, c.gray("⟲ shortening the conversation: its earlier part becomes a summary…"));
			} else if (p.requeued) {
				// A message that was given to work which ended, or was stopped, before reading it. It is on
				// screen already and is answered now; an esc pressed for the old work is not meant for it.
				if (tab.stopped && Date.now() - tab.stopped.at < STOP_GRACE) tab.stopped.spared.add(p.task);
			} else if (!tab.roots.has(p.task)) {
				if (p.kind === "event" && p.label) this.eventLine(tab, String(p.label), String(p.prompt ?? ""));
				// A round of a goal was announced by the goal's own line; its text is the same every round.
				else if (!isGoalRound(p.kind, p.label)) this.user(tab, String(p.prompt ?? ""), p.kind === "prompt" ? "elsewhere" : p.kind);
				// What came with it and was not typed here: a photo sent on Telegram, a picture a camera saved.
				for (let n = 0; n < Number(p.images ?? 0); n++) this.picture(tab, `picture ${n + 1}`, () => this.client.taskImage(p.task, n));
			}
			tab.roots.add(p.task);
			tab.running.add(p.task);
			if (tab.running.size === 1) {
				tab.startedAt = Date.now();
				tab.toolCalls = 0;
				tab.tokens = { input: 0, output: 0, cached: 0 };
			}
			this.tui.requestRender();
			return;
		}
		const tab = this.tabFor(p);
		if (tab) this.live(tab, kind, p, p.depth ?? 0);
	}

	// ---- goal mode ---------------------------------------------------------------------------------
	// The daemon keeps the goal and decides everything about it; here it is asked for, and shown.

	/** One line on where a goal stands, with the judge's reason under it; `full` adds the objective. */
	private goalLine(g: GoalInfo, full = false): string {
		const mark = g.status === "met" ? c.green("✓") : g.status === "active" ? c.accent("◎") : c.yellow("‖");
		const more = [...(g.reason ? [short(oneLine(g.reason), 200)] : []), ...(full ? [`the goal: ${short(oneLine(g.objective), 300)}`] : [])];
		return `${mark} ${c.bold("goal")} ${c.gray(g.note)}${more.map((m) => `\n${c.gray(`  ${m}`)}`).join("")}`;
	}

	/** The daemon reports on a goal: it was set, a round was judged, it stopped or was cleared. */
	private goalEvent(p: any): void {
		for (const tab of this.tabs) {
			if (tab.kind !== "chat" || tab.agent !== p.agent || tab.session !== p.session) continue;
			tab.goal = p.event === "cleared" ? undefined : (p as GoalInfo);
			this.say(tab, this.goalLine(p as GoalInfo));
			if (tab !== this.active) tab.unread = true;
		}
		this.tui.requestRender();
	}

	/** /goal: show it, set it, or pause, resume or clear it. All of it is the daemon's doing. */
	private async goal(arg: string): Promise<void> {
		const t = this.active;
		if (t.kind !== "chat") return this.flash("switch to a conversation tab first");
		const word = arg.toLowerCase();
		if (!arg) {
			t.goal = (await this.client.goal(t.agent, t.session)).goal;
			return void this.say(t, t.goal ? this.goalLine(t.goal, true) : c.gray("this conversation has no goal · /goal <what should be reached> sets one, and the agent works until it is met"));
		}
		if (word === "pause" || word === "resume" || word === "clear") {
			// What changes is drawn when the daemon reports it.
			const done = await this.client.setGoal(t.agent, t.session, { action: word });
			if (word === "clear" && !done.cleared) this.flash("this conversation has no goal");
			return;
		}
		// The first round is the objective itself, sent as a message of yours.
		this.user(t, arg);
		t.awaiting.push(arg);
		t.scroll.scrollToEnd();
		try {
			await this.client.setGoal(t.agent, t.session, { objective: arg });
		} catch (e) {
			t.awaiting = t.awaiting.filter((a) => a !== arg);
			this.say(t, c.red(`✗ no goal set: ${errText(e)}`));
		}
	}

	/** Show one live event of a task in a tab. `depth` is counted from what the tab shows: 0 is its own task. */
	private live(tab: Tab, kind: string, p: any, depth: number): void {
		const indent = "  ".repeat(Math.max(0, depth));
		const open = c.accent("▸ open");

		switch (kind) {
			case "started":
				if (depth <= 0) {
					tab.running.add(p.task);
					tab.startedAt = Date.now();
					break;
				}
				tab.children.set(p.task, { agent: p.agent, kind: p.kind, label: short(oneLine(String(p.label ?? p.prompt ?? "")), 60), running: true });
				this.button(tab, `${indent}${c.magenta("↳")} ${c.bold(p.agent)} ${c.gray(`${childKind(p.kind)} #${p.task}: ${short(oneLine(String(p.label ?? p.prompt ?? "")), 80)}`)} ${open}`, () => void this.openTask(p.task));
				break;
			case "thinking": {
				if (p.phase === "end") {
					tab.thinking = false;
					this.endThought(tab, p.task, p.ms);
					break;
				}
				tab.thinking = true;
				if (depth > 0 || !p.text) break; // a child's thoughts stay with the child, like its prose
				let thought = tab.thoughts.get(p.task);
				if (!thought) tab.thoughts.set(p.task, (thought = this.thought(tab)));
				thought.append(p.text);
				break;
			}
			case "todos":
				this.showSteps(tab, p.task, Array.isArray(p.items) ? p.items : []);
				break;
			case "delta": {
				tab.thinking = false;
				this.endThought(tab, p.task);
				if (depth > 0) break; // a child's prose stays with the child (its own tab shows it); its answer reaches the parent as a tool result
				let block = tab.blocks.get(p.task);
				if (!block) {
					block = { md: new Answer(""), text: "" };
					tab.blocks.set(p.task, block);
					this.add(tab, block.md);
				}
				block.text += p.text;
				block.md.setText(block.text);
				break;
			}
			case "message":
				this.endThought(tab, p.task);
				if (tab.blocks.has(p.task)) {
					if (depth === 0) tab.lastAnswer = tab.blocks.get(p.task)!.text;
					tab.streamed.set(p.task, tab.blocks.get(p.task)!.text);
					this.answerPictures(tab, p.agent, tab.blocks.get(p.task)!.text);
				}
				tab.blocks.delete(p.task);
				if (depth === 0) {
					tab.tokens = { input: p.input ?? 0, output: p.output ?? 0, cached: p.cached ?? 0 };
					if (p.context?.percent !== undefined) tab.context = p.context.percent;
				}
				break;
			case "tool": {
				tab.thinking = false;
				this.endThought(tab, p.task);
				tab.blocks.delete(p.task);
				tab.streamed.delete(p.task);
				const key = `${p.task}:${p.call}`;
				const label = `${c.bold(p.tool)}${p.subject ? ` ${c.gray(short(oneLine(p.subject), 100))}` : ""}`;
				if (p.phase === "start") {
					tab.toolCalls++;
					tab.tools.set(key, { line: this.say(tab, `${indent}${c.yellow("●")} ${label}`, depth === 0 && !tab.tools.size), label });
				} else {
					const t = tab.tools.get(key);
					const took = p.ms !== undefined ? c.gray(` ${p.ms < 1000 ? `${Math.round(p.ms)} ms` : `${(p.ms / 1000).toFixed(1)} s`}`) : "";
					const failed = p.ok ? "" : `\n${indent}  ${c.red(short(oneLine(String(p.preview ?? "")), 160))}`;
					const text = `${indent}${p.ok ? c.green("✓") : c.red("✗")} ${t?.label ?? label}${took}${failed}`;
					// A call that began before this tab was opened has no line of its own yet.
					if (t) t.line.setText(text);
					else this.say(tab, text, false);
					tab.tools.delete(key);
					for (const id of (p.images ?? []) as string[]) this.picture(tab, `from ${p.tool}`, () => this.client.toolImage(id));
				}
				break;
			}
			case "done":
			case "failed": {
				const block = tab.blocks.get(p.task);
				tab.blocks.delete(p.task);
				this.endThought(tab, p.task);
				if (depth > 0) {
					const child = tab.children.get(p.task);
					if (child) child.running = false;
					const n = p.stats?.tools?.length ?? 0;
					const how = p.status === "done" ? `${childKind(p.kind ?? child?.kind ?? "task")} #${p.task} answered (${Math.round((p.stats?.ms ?? 0) / 100) / 10} s${n ? `, ${n} tool call${n === 1 ? "" : "s"}` : ""})` : `${childKind(p.kind ?? child?.kind ?? "task")} #${p.task} ${p.status}: ${p.error ?? ""}`;
					this.button(tab, `${indent}${p.status === "done" ? c.green("✓") : c.red("✗")} ${c.bold(p.agent)} ${c.gray(how)} ${open}`, () => void this.openTask(p.task));
					break;
				}
				tab.running.delete(p.task);
				tab.thinking = false;
				this.takeStats(tab, p.stats);
				if (p.status !== "cancelled" && !tab.running.size) this.attention(`pine: ${tab.agent} ${p.status === "done" ? "is done" : "stopped with an error"}`);
				if (p.status === "done") {
					// Streaming normally showed the answer already; this covers a missed stream.
					if (p.text) tab.lastAnswer = p.text;
					if (!block && !tab.streamed.get(p.task) && p.text) {
						this.add(tab, new Answer(p.text));
						this.answerPictures(tab, p.agent, p.text);
					}
				} else if (p.status === "cancelled") this.say(tab, c.gray("■ stopped"));
				else this.say(tab, c.red(`✗ ${p.status}${p.error && p.error !== p.status ? `: ${p.error}` : ""}`));
				tab.streamed.delete(p.task);
				if (tab.kind === "task") this.say(tab, c.gray(this.taskSummary(p.status, p.stats)));
				else void this.refreshTaints();
				break;
			}
		}
		// A tool that finished may have changed files, and a finished task has new output to show.
		if (this.codeOpen && tab === this.active && ((kind === "tool" && p.phase !== "start") || kind === "done" || kind === "failed")) this.code.touch();
		if (tab !== this.active) tab.unread = true;
		this.tui.requestRender();
	}

	private logEvent(e: PineEvent): void {
		const tab = this.tabs.find((t) => t.kind === "events");
		if (!tab?.log || /\/(delta|thinking|message)$/.test(e.topic)) return;
		const time = new Date(e.ts).toLocaleTimeString("sv-SE");
		tab.lines.push(`${c.gray(time)} ${(e.trust === "owner" ? c.green : c.gray)(e.trust === "owner" ? "owner" : "other")} ${c.bold(e.topic)} ${c.gray(short(JSON.stringify(e.payload ?? null), 160))}`);
		if (tab.lines.length > 400) tab.lines.splice(0, tab.lines.length - 400);
		tab.log.setText(tab.lines.join("\n"));
		if (tab === this.active) this.tui.requestRender();
	}

	private async refreshTaints(): Promise<void> {
		try {
			const s = await this.client.status();
			this.taints.clear();
			this.sessionModes.clear();
			this.bypassWhenTainted = s.bypassWhenTainted === true;
			for (const x of s.sessions) {
				const open = this.tabs.find((t) => t.kind === "chat" && t.agent === x.agent && t.session === x.session);
				if (open && x.context?.percent !== undefined) open.context = x.context.percent;
				if (x.tainted) this.taints.set(`${x.agent}:${x.session}`, x.tainted);
				this.sessionModes.set(`${x.agent}:${x.session}`, x.mode);
			}
			for (const [id, mode] of Object.entries<string>(s.modes ?? {})) {
				const info = this.agents.find((a) => a.id === id);
				if (info) info.mode = mode as any;
			}
			// Bypass that stopped applying must not go unnoticed.
			for (const t of this.tabs) {
				if (t.kind !== "chat" || t.pauseNoted || !this.bypassPaused(t)) continue;
				t.pauseNoted = true;
				this.say(t, c.yellow(`bypass is paused in this conversation: it has read outside content (${this.taints.get(`${t.agent}:${t.session}`)}).\n`) + c.gray("The agent is back inside its sandbox and asks before sending things out. /mode bypass offers a clean conversation or bypass here anyway; /reset starts over."));
			}
			this.tui.requestRender();
		} catch {
			// The footer just keeps its last state.
		}
	}

	private bypassPaused(t: Tab): boolean {
		const info = this.agents.find((a) => a.id === t.agent);
		return info?.mode === "bypass" && this.sessionModes.get(`${t.agent}:${t.session}`) === "auto";
	}

	// ---- chrome ----------------------------------------------------------------------------------

	private renderHeader(width: number): string[] {
		const line = new Line().add(c.bold(c.accent(" pine ")));
		this.tabs.forEach((t, i) => {
			const name = t.kind === "events" ? "events" : t.kind === "task" ? `${t.agent}↳#${t.task}` : t.session === "main" ? t.agent : `${t.agent}·${t.session}`;
			const mark = t.running.size ? c.yellow(SPINNER[this.frame % SPINNER.length]) : t.approvals.size ? c.yellow("!") : t.unread ? c.accent("•") : " ";
			const label = ` ${i + 1} ${short(name, 22)} `;
			line.add(t === this.active ? c.bgAccent(label) : c.gray(label), () => this.activate(t));
			line.add(t === this.active ? c.bgAccent("×") : c.gray("×"), () => this.closeTab(t));
			line.add(`${mark} `);
		});
		line.add(c.gray(" + "), () => void this.run("new"));
		// At the right edge, and always in view however many tabs there are: the button of the code pane.
		const right = new Line().add(this.connected ? "" : c.red(" reconnecting… "));
		if (this.active.kind === "chat") right.add(this.codeOpen ? c.bgAccent(" ▤ code ") : c.gray(" ▤ code "), () => this.showCode(!this.codeOpen));
		const room = Math.max(0, width - right.width);
		const at = Math.max(0, width - right.width);
		this.headerHits = [...line.hits.filter((h) => h.from < room).map((h) => ({ ...h, to: Math.min(h.to, room) })), ...right.hits.map((h) => ({ ...h, from: h.from + at, to: h.to + at }))];
		const left = truncateToWidth(line.text, room);
		return [truncateToWidth(left + " ".repeat(Math.max(0, room - visibleWidth(left))) + right.text, width), c.gray("─".repeat(width))];
	}

	private renderAttachments(width: number): string[] {
		const t = this.active;
		if (!t.attachments.length) return (this.attachHits = []), [];
		const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
		const line = new Line().add(c.gray(" attached: "));
		t.attachments.forEach((a, i) => {
			line.add(`${c.bold(short(a.name, 28))} ${c.gray(kb(a.size))} `);
			line.add(c.gray("× "), () => {
				t.attachments.splice(i, 1);
				this.tui.requestRender();
			});
			line.add(" ");
		});
		this.attachHits = line.hits;
		return [truncateToWidth(line.text, width)];
	}

	private renderStatus(width: number): string[] {
		const t = this.active;
		let line = "";
		if (this.notice) line = c.yellow(this.notice);
		else if (t.approvals.size) line = c.yellow("waiting for your approval · /approve or /deny");
		else if (t.running.size) {
			const secs = Math.max(0, Math.round((Date.now() - t.startedAt) / 1000));
			const helpers = [...t.children.values()].filter((x) => x.running).length;
			const steps = t.todo?.items.length ? [`step ${Math.min(t.todo.items.length, t.todo.items.filter((x) => x.status === "done").length + 1)} of ${t.todo.items.length}`] : [];
			const parts = [t.thinking ? "thinking" : "working", `${secs}s`, ...steps, ...(t.toolCalls ? [`${t.toolCalls} tool call${t.toolCalls === 1 ? "" : "s"}`] : []), ...(helpers ? [`${helpers} sub-task${helpers === 1 ? "" : "s"} running`] : []), ...(t.tokens.output ? [`${t.tokens.input + t.tokens.cached}↑${t.tokens.cached ? ` (${Math.round((100 * t.tokens.cached) / (t.tokens.input + t.tokens.cached))}% cached)` : ""} ${t.tokens.output}↓`] : []), "esc to stop"];
			// A goal: which round this is, so that work that goes on by itself is seen to.
			if (t.goal?.status === "active") parts.unshift(`goal · round ${t.goal.round} of ${t.goal.until}`);
			line = `${c.yellow(SPINNER[this.frame % SPINNER.length])} ${c.gray(parts.join(" · "))}`;
		} else if (t.goal?.status === "active") line = c.gray(`◎ goal · round ${t.goal.round} of ${t.goal.until} · checking whether it is met · esc to pause`);
		return [truncateToWidth(` ${line}`, width)];
	}

	private renderFooter(width: number): string[] {
		const t = this.active;
		if (t.kind !== "chat") return (this.footerHits = []), [truncateToWidth(c.gray(t.kind === "task" ? ` task #${t.task} of ${t.agent} · read-only · ctrl+w closes this tab` : " live events"), width)];
		const info = this.agents.find((a) => a.id === t.agent);
		const taint = this.taints.get(`${t.agent}:${t.session}`);
		const mode = info?.mode ?? "auto";
		const modeText = `${mode}${this.bypassPaused(t) ? " (paused)" : ""}`;
		// Each part opens its list on a click: agent, conversation, model, mode.
		const line = new Line()
			.add(" ")
			.add(c.bold(t.agent), () => void this.pickAgent())
			.add(c.gray(" · "))
			.add(c.gray(t.session), () => void this.pickSession())
			.add(c.gray(" · "))
			.add(t.folder ? c.cyan(short(tilde(t.folder), 34)) : c.gray("no folder"), () => void this.pickFolder())
			.add(c.gray(" · "))
			.add(c.gray(info?.model ?? ""), () => void this.pickModel())
			.add(c.gray(" · "))
			.add(c.gray(`reasoning ${info?.thinking ?? "off"}`), () => void this.pickReasoning())
			.add(c.gray(" · "))
			.add(mode === "bypass" ? c.red(modeText) : mode === "manual" ? c.cyan(modeText) : mode === "plan" ? c.magenta(modeText) : c.gray(modeText), () => void this.pickMode());
		// How full the context window is. pi compacts the conversation by itself when it gets close to full.
		if (t.context !== undefined) line.add(c.gray(" · ")).add((t.context >= 85 ? c.red : t.context >= 65 ? c.yellow : c.gray)(`context ${t.context}%`));
		// How much of the last request the model server took from its cache. Low figures on a local model mean slow turns.
		if (t.cacheShare !== undefined) line.add(c.gray(" · ")).add((t.cacheShare < 50 ? c.yellow : c.gray)(`cache ${t.cacheShare}%`));
		if (taint) line.add(c.yellow(" · outside content"));
		this.footerHits = line.hits;
		const right = c.gray("/help ");
		const gap = Math.max(1, width - line.width - visibleWidth(right));
		return [truncateToWidth(line.text + " ".repeat(gap) + right, width)];
	}
}

/** The system's own window for choosing a folder. Resolves with nothing when it is closed without a choice, or where there is none. */
function chooseFolder(): Promise<string | undefined> {
	if (process.platform !== "darwin") return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const child = spawn("/usr/bin/osascript", ["-e", 'POSIX path of (choose folder with prompt "A folder for this conversation")'], { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.on("error", () => resolve(undefined));
		child.on("close", (code) => resolve(code === 0 && out.trim() ? out.trim() : undefined));
	});
}
