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
	hyperlink,
	ScrollView,
	setCapabilities,
	sliceByColumn,
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
import { errText, expandHome } from "../util.ts";
import type { AgentInfo, Client, Conversation } from "./client.ts";
import { isImageFile, isVideoFile, mimeOf, Picture, picturesAsText, picturesIn, prepare, prepareVideo, Slot, stopVideos, Video } from "./picture.ts";
import { Answer, c, editorTheme, selectTheme, SPINNER } from "./theme.ts";

interface Tab {
	id: number;
	/** "task" shows the work of one sub-agent or delegated task; it takes no messages. */
	kind: "chat" | "events" | "task";
	agent: string;
	session: string;
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
 * escaped or the path in quotes, sometimes as file:// URLs. Returns the files only when every
 * piece of the text is an existing file; otherwise the text is ordinary input.
 */
export function droppedFiles(text: string): string[] | null {
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
			if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) return null;
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

const SCOPES = ["local", "agent", "global"];
const SCOPE_HELP: Record<string, string> = { local: "only this conversation, until it is closed", agent: "the agent, in its main conversation", global: "every agent" };

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
	{ value: "manual", label: "manual", description: "asks before every action" },
	{ value: "bypass", label: "bypass", description: "never asks; reaches your whole account" },
];

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

type ApprovalAnswer = "allow" | "always" | "deny" | "later";

/** Modal question for one approval request. */
class ApprovalDialog implements Component {
	private req: any;
	private done: (answer: ApprovalAnswer) => void;
	private choice = 0;
	private options: Array<{ answer: ApprovalAnswer; label: string }>;
	private buttons: Array<{ row: number; from: number; to: number; answer: ApprovalAnswer }> = [];

	constructor(req: any, done: (answer: ApprovalAnswer) => void) {
		this.req = req;
		this.done = done;
		this.options = [
			{ answer: "allow", label: "Allow once (a)" },
			// Only where the daemon offers it: not for actions that are configured to ask every time.
			...(req.remember ? [{ answer: "always" as const, label: "Always here (s)" }] : []),
			{ answer: "deny", label: "Deny (d)" },
			{ answer: "later", label: "Later (esc)" },
		];
	}

	invalidate(): void {}

	handleMouse(e: any) {
		const b = this.buttons.find((x) => e.y === x.row && e.x >= x.from && e.x < x.to);
		if (b && e.type === "click" && e.button === "left") this.done(b.answer);
		return { handled: true };
	}

	handleInput(data: string): void {
		const n = this.options.length;
		if (data === "a" || data === "y") return this.done("allow");
		if (data === "s" && this.req.remember) return this.done("always");
		if (data === "d" || data === "n") return this.done("deny");
		if (matchesKey(data, "escape")) return this.done("later");
		if (matchesKey(data, "left") || matchesKey(data, "up") || matchesKey(data, "shift+tab")) this.choice = (this.choice + n - 1) % n;
		else if (matchesKey(data, "right") || matchesKey(data, "down") || matchesKey(data, "tab")) this.choice = (this.choice + 1) % n;
		else if (matchesKey(data, "enter")) return this.done(this.options[this.choice].answer);
	}

	render(width: number): string[] {
		const inner = Math.max(20, width - 4);
		const body = [
			c.bold(c.yellow("Approval needed")),
			"",
			`${c.gray("agent ")} ${this.req.agent} ${c.gray(`(task #${this.req.task})`)}`,
			`${c.gray("action")} ${c.bold(String(this.req.tool))}`,
			...String(this.req.summary ?? "").split("\n").slice(0, 8).flatMap((l) => wrapTextWithAnsi(`  ${l}`, inner)).slice(0, 12),
			"",
			...wrapTextWithAnsi(c.gray(`Why you are asked: ${this.req.why}`), inner),
			...(this.req.remember ? wrapTextWithAnsi(c.gray(`"Always here" stops asking about ${this.req.remember} in this conversation.`), inner) : []),
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
 * The screen, with one addition: while a menu or question is open, a click next to it goes to the
 * app (which closes the menu) instead of to whatever lies underneath.
 */
class Screen extends TuiAltScreen {
	onOutside?: (e: any) => boolean;
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

	constructor(opts: TuiOptions) {
		this.opts = opts;
		this.client = opts.client;
		this.tui = new Screen(opts.terminal, false, undefined, {
			mouse: true,
			openUrl: (url) => this.open(url),
			// With the mouse in use by the UI, selecting text is the UI's job too: what you drag over is copied.
			copyOnSelect: true,
			copySelection: (text) =>
				new Promise((resolve) => {
					const child = spawn(process.platform === "darwin" ? "pbcopy" : "xclip", process.platform === "darwin" ? [] : ["-selection", "clipboard"], { stdio: ["pipe", "ignore", "ignore"] });
					child.on("error", (e) => resolve(e.message));
					child.on("close", (code) => resolve(code === 0 ? true : `copy failed (${code})`));
					child.stdin.end(text);
				}),
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
		this.defineCommands();
		this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(this.commands, process.cwd(), null));
		this.tui.addInputListener((data) => (this.onKey(data) ? { consume: true } : undefined));
		// A menu or question is modal: a click beside it closes it (a question stays open for later,
		// as with esc) and does not reach the tabs and the bar underneath. The wheel still scrolls.
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
		const saved = await this.client.tabs().catch(() => ({ tabs: [] as Array<{ agent: string; session: string }>, active: 0 }));
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
		this.saveTabs();
		void this.refreshTaints();
	}

	/** Remember which conversations are open, so that the next start opens the same tabs. */
	private saveTabs(): void {
		if (this.restoring || this.stopped) return;
		const chats = this.tabs.filter((t) => t.kind === "chat");
		void this.client.saveTabs(chats.map((t) => ({ agent: t.agent, session: t.session })), Math.max(0, chats.indexOf(this.active))).catch(() => {});
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		clearInterval(this.spinner);
		clearTimeout(this.noticeTimer);
		// Leaving keeps every conversation as it is: the same tabs open again next time.
		this.unsubscribe?.();
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
		const doc = new Container();
		const scroll = new ScrollView(doc, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" });
		const tab: Tab = {
			id: this.nextTabId++, kind, agent, session, doc, scroll,
			layout: new VStack([
				{ component: this.header, basis: "auto", grow: 0, shrink: 0 },
				{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{ component: this.dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			]),
			roots: new Set(), running: new Set(), awaiting: [], blocks: new Map(), tools: new Map(), streamed: new Map(), approvals: new Map(), baseDepth: 0, children: new Map(),
			unread: false, startedAt: 0, toolCalls: 0, tokens: { input: 0, output: 0, cached: 0 }, thinking: false, lines: [], attachments: [], pauseNoted: false,
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
		this.say(tab, c.gray(`${c.bold(agent)}${info?.description ? ` · ${info.description}` : ""}\nsession ${session} · model ${info?.model ?? "?"} · type a message, / for commands, or click the bar below`));
		try {
			const history = (await this.client.history(agent, session)).filter((t) => t.depth === 0).reverse();
			if (history.length) this.say(tab, c.gray(`── earlier in this session (${history.length}) ──`));
			for (const t of history) this.renderPast(tab, t);
			this.takeStats(tab, history.at(-1)?.meta?.stats);
			if (history.length) this.say(tab, c.gray("── now ──"));
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
		if (e.kind === "thinking") return void this.say(tab, c.gray(`thinking: ${short(oneLine(e.text ?? ""), 400)}`));
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
		return new Video(await prepareVideo(file, name), () => this.tui.requestRender(), (f) => (this.opts.openFile ?? ((x: string) => void spawn("open", [x], { stdio: "ignore", detached: true }).on("error", () => {})))(f));
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
				this.picture(tab, name, () => this.client.workspaceImage(agent, ref.target), `(no picture at ${ref.target} in the workspace)`, live);
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
		const body = prompt.replace(/^\[You are subscribed to[\s\S]*?\]\n\n/, "").replace(/^\[event on [^\n]*\]\n/, "").replace(/^Event [^\n]*:\n/, "");
		this.say(tab, `${c.yellow("⚡")} ${c.bold(label)}\n${c.gray(`  ${short(oneLine(body), 300)}`)}`);
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

	private renderPast(tab: Tab, t: Task): void {
		if (t.kind === "event" && t.meta?.label) this.eventLine(tab, t.meta.label, t.prompt);
		else this.user(tab, t.prompt, t.kind === "prompt" ? undefined : t.kind);
		(t.meta?.images ?? []).forEach((_, i) => this.picture(tab, `attached picture ${i + 1}`, () => this.client.taskImage(t.id, i)));
		if (t.status === "done") {
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
			const files = droppedFiles(paste[1]);
			if (files) return files.forEach((f) => this.attachFile(f)), true;
		}
		const empty = this.editor.getText().length === 0;
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
		if (matchesKey(data, "tab") && empty) return this.cycle(1), true;
		// As in Claude Code and opencode: shift+tab steps through the modes.
		if (matchesKey(data, "shift+tab") && empty && this.active.kind === "chat") {
			const info = this.agents.find((a) => a.id === this.active.agent);
			const order = ["auto", "manual", "bypass"];
			return void this.setMode(this.active, order[(order.indexOf(info?.mode ?? "auto") + 1) % order.length]).catch((e) => this.flash(errText(e))), true;
		}
		if (matchesKey(data, "ctrl+t")) return void this.run("new"), true;
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
		(this.opts.openUrl ?? ((u) => void spawn("open", [u], { stdio: "ignore", detached: true }).on("error", () => {})))(url);
		this.flash(`opened ${short(url, 90)}`, 2500);
	}

	private async submit(raw: string): Promise<void> {
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
			const { task } = await this.client.prompt(tab.agent, text, tab.session, attachments.length ? attachments : undefined);
			this.adopt(tab, task);
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
		if (!MODE_ITEMS.some((m) => m.value === mode)) return this.flash("modes: manual, auto, bypass");
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
		const note = mode === "bypass" ? c.yellow(" Nothing waits for approval now, and its shell and file tools reach your whole account and the network.") : "";
		this.say(t, `${c.gray(`${t.agent} is now in`)} ${c.bold(mode)} ${c.gray("mode (until the daemon restarts; set \"mode\" in agent.json to keep it).")}${note}`);
		await this.refreshTaints();
	}

	private adopt(tab: Tab, task: number): void {
		if (tab.roots.has(task)) return;
		tab.roots.add(task);
	}

	private async stopRunning(tab: Tab): Promise<void> {
		for (const id of tab.running) await this.client.cancel(id).catch(() => {});
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
				name: "mode", description: "How much this agent may do without asking", argumentHint: "[manual|auto|bypass]",
				getArgumentCompletions: (prefix) =>
					[
						{ value: "manual", label: "manual", description: "ask before every action" },
						{ value: "auto", label: "auto", description: "work inside the sandbox, ask for the rest" },
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
					this.say(t, list.map((x) => `${c.bold(x.name)}${x.scope === "global" ? "" : c.gray(` (of ${x.scope})`)} ${c.gray(x.type)} ${x.error ? c.red(`not running: ${x.error}`) : x.running ? c.green("running") : c.gray("idle")}${x.description ? c.gray(` · ${x.description}`) : ""}\n${c.gray(`  subscribers: ${x.subscribers.join(", ") || "none"} · ${x.last ? `last event ${new Date(x.last.ts).toLocaleTimeString("sv-SE")}, ${x.events} since start` : "no events since start"}`)}`).join("\n"));
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
			["enter", "send"], ["shift+enter", "new line"], ["esc", "stop the agent"], ["tab", "next tab (when the input is empty)"], ["shift+tab", "next mode: auto, manual, bypass (when the input is empty)"],
			["alt+1..9", "go to tab"], ["ctrl+t", "new conversation"], ["ctrl+w", "close tab"], ["pgup / pgdn", "scroll"], ["mouse", "click a tab, its ×, +, a web address, or agent / conversation / model / reasoning / mode in the bottom bar; drop files to attach"], ["ctrl+c twice, ctrl+d", "quit"],
		].map(([k, d]) => `  ${c.accent(k.padEnd(22))} ${d}`);
		this.say(this.active, [c.bold("Commands"), ...cmds, "", c.bold("Keys"), ...keys].join("\n"));
	}

	// ---- approvals -------------------------------------------------------------------------------

	private ask(tab: Tab, req: any): void {
		if (this.dialog || tab !== this.active) return;
		const dialog = new ApprovalDialog(req, (answer) => {
			this.closeDialog();
			if (answer === "later") return; // the status line keeps saying that an approval is open
			void this.client.decide(req.id, answer !== "deny", answer === "always").catch((e) => this.flash(errText(e)));
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
				const card = this.say(tab, `${c.yellow("⚠ approval needed")} ${c.bold(p.tool)} ${c.gray(short(oneLine(String(p.summary ?? "")), 120))}\n${c.gray(`  ${p.why} · /approve${p.remember ? ", /approve always" : ""} or /deny`)}`);
				tab.approvals.set(p.id, { card, req: p });
				this.ask(tab, p);
			} else if (e.topic === "approval/decided") {
				for (const tab of this.tabs) {
					const a = tab.approvals.get(p.id);
					if (!a) continue;
					a.card.setText(`${p.allow ? c.green("✓ allowed") : c.red("✗ denied")} ${c.bold(a.req.tool)} ${c.gray(`(${p.by})${p.always ? ` · ${p.remember} will not ask again in this conversation` : ""}`)}`);
					tab.approvals.delete(p.id);
				}
				if (this.dialog?.id === p.id) this.closeDialog();
				this.tui.requestRender();
			}
			return;
		}
		if (ns !== "agent") return;

		// A tab on one task follows that task and whatever it starts itself.
		for (const t of this.tabs) {
			if (t.kind !== "task") continue;
			if (kind === "started" && p.parent !== undefined && t.roots.has(p.parent)) t.roots.add(p.task);
			if (t.roots.has(p.task)) this.live(t, kind, p, (p.depth ?? 0) - t.baseDepth);
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
			if (i >= 0) tab.awaiting.splice(i, 1);
			else if (!tab.roots.has(p.task)) {
				if (p.kind === "event" && p.label) this.eventLine(tab, String(p.label), String(p.prompt ?? ""));
				else this.user(tab, String(p.prompt ?? ""), p.kind === "prompt" ? "elsewhere" : p.kind);
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
			case "thinking":
				tab.thinking = true;
				break;
			case "delta": {
				tab.thinking = false;
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
				if (tab.blocks.has(p.task)) {
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
				if (p.status === "done") {
					// Streaming normally showed the answer already; this covers a missed stream.
					if (!block && !tab.streamed.get(p.task) && p.text) {
						this.add(tab, new Answer(p.text));
						this.answerPictures(tab, p.agent, p.text);
					}
				} else this.say(tab, c.red(`✗ ${p.status}${p.error ? `: ${p.error}` : ""}`));
				tab.streamed.delete(p.task);
				if (tab.kind === "task") this.say(tab, c.gray(this.taskSummary(p.status, p.stats)));
				else void this.refreshTaints();
				break;
			}
		}
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
		this.headerHits = line.hits;
		const right = this.connected ? "" : c.red(" reconnecting… ");
		return [truncateToWidth(line.text + " ".repeat(Math.max(0, width - line.width - visibleWidth(right))) + right, width), c.gray("─".repeat(width))];
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
			const parts = [t.thinking ? "thinking" : "working", `${secs}s`, ...(t.toolCalls ? [`${t.toolCalls} tool call${t.toolCalls === 1 ? "" : "s"}`] : []), ...(helpers ? [`${helpers} sub-task${helpers === 1 ? "" : "s"} running`] : []), ...(t.tokens.output ? [`${t.tokens.input + t.tokens.cached}↑${t.tokens.cached ? ` (${Math.round((100 * t.tokens.cached) / (t.tokens.input + t.tokens.cached))}% cached)` : ""} ${t.tokens.output}↓`] : []), "esc to stop"];
			line = `${c.yellow(SPINNER[this.frame % SPINNER.length])} ${c.gray(parts.join(" · "))}`;
		}
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
			.add(c.gray(info?.model ?? ""), () => void this.pickModel())
			.add(c.gray(" · "))
			.add(c.gray(`reasoning ${info?.thinking ?? "off"}`), () => void this.pickReasoning())
			.add(c.gray(" · "))
			.add(mode === "bypass" ? c.red(modeText) : mode === "manual" ? c.cyan(modeText) : c.gray(modeText), () => void this.pickMode());
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
