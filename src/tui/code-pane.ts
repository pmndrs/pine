import os from "node:os";
import path from "node:path";
import { type Component, ScrollView, truncateToWidth, visibleWidth, VStack, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TranscriptEntry } from "../types.ts";
import { errText, programName, since } from "../util.ts";
import type { Client } from "./client.ts";
import { highlightCode } from "./highlight.ts";
import { halfBlocks, isImageFile, prepare } from "./picture.ts";
import { c } from "./theme.ts";

// The pane beside a conversation: what changed in its folder according to git, the files there,
// and what the agent's tool calls printed. It only shows; nothing in it changes a file or reaches
// a model. Everything is read through the control API, so it works the same on an attached daemon.

export type PaneView = "changes" | "files" | "output" | "running";
export const PANE_VIEWS: PaneView[] = ["changes", "files", "output", "running"];

/** The conversation a pane shows. */
export interface PaneTarget {
	agent: string;
	session: string;
}

interface Row {
	text: string;
	/** Put in front of the first line when the text is wrapped; the lines below it are indented as far. */
	gutter?: string;
	/** Long text continues on the next line instead of being cut. */
	wrap?: boolean;
	run?: () => void;
}

interface Call {
	task: number;
	/** Which of the task's tool calls this is, counted from 0. */
	n: number;
	entry: TranscriptEntry;
}

interface State {
	view: PaneView;
	loading?: string;
	error?: string;
	changes?: Awaited<ReturnType<Client["changes"]>>;
	/** The file whose diff is shown, from the top of the repository. */
	diff?: { file: string; lines?: string[]; truncated?: boolean };
	root?: string;
	dirs: Map<string, Array<{ name: string; dir: boolean; size: number }>>;
	expanded: Set<string>;
	file?: { path: string; rows?: Row[] };
	calls?: Call[];
	/** The call whose output is shown. */
	call?: { task: number; n: number };
	/** What the conversation's commands left running. */
	programs?: Awaited<ReturnType<Client["programs"]>>;
	/** A program that was just asked to stop: shown as stopping until it is gone from the list. */
	stopping?: Set<number>;
}

const tilde = (p: string) => (p === os.homedir() ? "~" : p.startsWith(`${os.homedir()}/`) ? `~${p.slice(os.homedir().length)}` : p);
const plain = (s: string) => s.replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const took = (ms?: number) => (ms === undefined ? "" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** The lines of a diff as git prints it, in colours, without the lines that only name the file. */
export function diffLines(diff: string): string[] {
	const out: string[] = [];
	for (const raw of diff.replace(/\n$/, "").split("\n")) {
		const line = plain(raw);
		if (/^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index)/.test(line)) continue;
		if (line.startsWith("@@")) out.push(c.cyan(line));
		else if (line.startsWith("+")) out.push(c.green(line));
		else if (line.startsWith("-")) out.push(c.red(line));
		else if (/^(rename |Binary files |\\ )/.test(line)) out.push(c.gray(line));
		else out.push(line);
	}
	return out;
}

/** Lines that react to a click, each cut to the width or, where it says so, wrapped. */
class Rows implements Component {
	rows: Row[] = [];
	private owner: number[] = [];
	private cache?: { width: number; rows: Row[]; lines: string[] };

	invalidate(): void {
		this.cache = undefined;
	}

	handleMouse(e: any) {
		const row = this.rows[this.owner[e.y]];
		if (!row?.run || e.button !== "left" || (e.type !== "press" && e.type !== "click" && e.type !== "release")) return undefined;
		if (e.type === "click") row.run();
		return { handled: true, render: true };
	}

	render(width: number): string[] {
		if (this.cache?.width === width && this.cache.rows === this.rows) return this.cache.lines;
		const lines: string[] = [];
		this.owner = [];
		this.rows.forEach((row, i) => {
			const gutter = row.gutter ?? "";
			const room = Math.max(8, width - 1 - visibleWidth(gutter));
			const parts = row.wrap && visibleWidth(row.text) > room ? wrapTextWithAnsi(row.text, room) : [truncateToWidth(row.text, room)];
			parts.forEach((part, n) => {
				lines.push(` ${n === 0 ? gutter : " ".repeat(visibleWidth(gutter))}${part}`);
				this.owner.push(i);
			});
		});
		this.cache = { width, rows: this.rows, lines };
		return lines;
	}
}

export class CodePane {
	/** What goes into the layout. */
	readonly component: VStack;
	private client: Client;
	private redraw: () => void;
	private close: () => void;
	private target: () => PaneTarget | undefined;
	private states = new Map<string, State>();
	private rows = new Rows();
	private scroll: ScrollView;
	private hits: Array<{ from: number; to: number; run(): void }> = [];
	private timer?: NodeJS.Timeout;
	private width = 60;
	/** Counts loads, so that an answer that arrives late does not overwrite a newer one. */
	private turn = 0;

	constructor(opts: { client: Client; redraw: () => void; close: () => void; target: () => PaneTarget | undefined }) {
		this.client = opts.client;
		this.redraw = opts.redraw;
		this.close = opts.close;
		this.target = opts.target;
		this.scroll = new ScrollView(this.rows, { follow: "none", overscroll: "contain", scrollbar: "auto" });
		const head: Component = {
			invalidate() {},
			render: (w) => this.renderHead(w),
			handleMouse: (e) => {
				if (e.y !== 0 || e.button !== "left" || (e.type !== "press" && e.type !== "click" && e.type !== "release")) return undefined;
				const hit = this.hits.find((h) => e.x >= h.from && e.x < h.to);
				if (!hit) return undefined;
				if (e.type === "click") hit.run();
				return { handled: true, render: true };
			},
		};
		this.component = new VStack([
			{ component: head, basis: "auto", grow: 0, shrink: 0 },
			{ component: this.scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		]);
	}

	private get state(): State | undefined {
		const t = this.target();
		if (!t) return undefined;
		const key = `${t.agent}:${t.session}`;
		let s = this.states.get(key);
		if (!s) {
			if (this.states.size > 40) this.states.clear();
			s = { view: "changes", dirs: new Map(), expanded: new Set([""]) };
			this.states.set(key, s);
		}
		return s;
	}

	get view(): PaneView {
		return this.state?.view ?? "changes";
	}

	/** Show one of the views, from its top level. Without a view: whatever was shown last, read again. */
	show(view?: PaneView): void {
		const s = this.state;
		if (!s) return this.build();
		if (view) {
			s.view = view;
			s.diff = undefined;
			s.file = undefined;
			s.call = undefined;
		}
		this.scroll.scrollToStart();
		void this.load(true);
	}

	/** The conversation shown changed its folder: what was read from the old one is not shown any more. */
	forget(target: PaneTarget): void {
		const view = this.states.get(`${target.agent}:${target.session}`)?.view;
		this.states.delete(`${target.agent}:${target.session}`);
		if (view && this.state) this.state.view = view;
		this.show();
	}

	/** Something happened that may have changed what is shown (a tool ran, a task ended): read it again in a moment. */
	touch(): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => void this.load(false), 350);
		this.timer.unref?.();
	}

	stop(): void {
		clearTimeout(this.timer);
	}

	// ---- reading ---------------------------------------------------------------------------------

	private async load(visibly: boolean): Promise<void> {
		const t = this.target();
		const s = this.state;
		if (!t || !s) return this.build();
		const turn = ++this.turn;
		if (visibly) {
			s.loading = "reading …";
			this.build();
		}
		try {
			if (s.view === "changes") {
				const changes = await this.client.changes(t.agent, t.session);
				const diff = s.diff ? await this.client.diff(t.agent, t.session, s.diff.file).catch(() => undefined) : undefined;
				if (turn !== this.turn) return;
				s.changes = changes;
				s.root = changes.root;
				if (s.diff) Object.assign(s.diff, { lines: diff ? diffLines(diff.diff) : [], truncated: diff?.truncated });
			} else if (s.view === "files") {
				const dirs = new Map<string, Array<{ name: string; dir: boolean; size: number }>>();
				for (const dir of [...s.expanded].sort()) {
					const got = await this.client.tree(t.agent, t.session, dir).catch(() => undefined);
					if (got) dirs.set(dir, got.entries);
				}
				const root = s.root ?? (await this.client.folder(t.agent, t.session).then((f) => f.folder ?? f.workspace).catch(() => undefined));
				const file = s.file ? await this.fileRows(t, s.file.path) : undefined;
				if (turn !== this.turn) return;
				s.dirs = dirs;
				s.root = root;
				if (s.file) s.file.rows = file;
			} else if (s.view === "running") {
				const programs = await this.client.programs(t.agent, t.session);
				if (turn !== this.turn) return;
				s.programs = programs;
				if (s.stopping) for (const id of [...s.stopping]) if (!programs.some((p) => p.id === id)) s.stopping.delete(id);
			} else {
				const tasks = (await this.client.history(t.agent, t.session, 8)).filter((x) => x.depth === 0).reverse();
				const calls: Call[] = [];
				for (const task of tasks) {
					if (task.meta?.stats && !task.meta.stats.tools.length) continue;
					const got = await this.client.output(task.id).catch(() => undefined);
					let n = 0;
					for (const entry of got?.entries ?? []) if (entry.kind === "tool") calls.push({ task: task.id, n: n++, entry });
				}
				if (turn !== this.turn) return;
				s.calls = calls;
			}
			s.error = undefined;
		} catch (e) {
			if (turn !== this.turn) return;
			s.error = errText(e);
		}
		s.loading = undefined;
		this.build();
	}

	private async fileRows(t: PaneTarget, file: string): Promise<Row[]> {
		if (isImageFile(file)) {
			const got = await this.client.workspaceImage(t.agent, file, t.session).catch(() => undefined);
			if (!got) return [{ text: c.gray("this picture cannot be shown") }];
			const p = await prepare(got.bytes, got.mime, path.basename(file));
			// As half blocks: a real picture can only be drawn at the left edge of the screen.
			const blocks = p.pixels ? halfBlocks(p.pixels, Math.max(8, Math.min(this.width - 3, 80)), 30) : [];
			return [...blocks.map((text) => ({ text })), { text: c.gray(`${p.widthPx}×${p.heightPx}`) }];
		}
		const got = await this.client.file(t.agent, t.session, file);
		if (got.binary || got.text === undefined) return [{ text: c.gray(`a binary file, ${size(got.size)}`) }];
		const lines = highlightCode(plain(got.text.replace(/\n$/, "")), path.extname(file).slice(1) || path.basename(file).toLowerCase());
		const digits = String(lines.length).length;
		const rows: Row[] = lines.map((text, i) => ({ text, gutter: c.gray(`${String(i + 1).padStart(digits)} `), wrap: true }));
		if (got.truncated) rows.push({ text: c.gray(`… the first 256 KB of ${size(got.size)}`) });
		return rows;
	}

	// ---- drawing ---------------------------------------------------------------------------------

	private go(change: (s: State) => void, top = true): void {
		const s = this.state;
		if (!s) return;
		change(s);
		if (top) this.scroll.scrollToStart();
		void this.load(false);
		this.build();
	}

	private back(label: string, undo: (s: State) => void): Row {
		return { text: `${c.accent("‹ back")} ${c.gray("·")} ${c.bold(label)}`, run: () => this.go(undo) };
	}

	private build(): void {
		const s = this.state;
		const rows: Row[] = [];
		if (!s) rows.push({ text: c.gray("Switch to a conversation tab: this pane shows the folder a conversation works in."), wrap: true });
		else if (s.error) rows.push({ text: c.red(s.error), wrap: true });
		else if (s.view === "changes") this.changesRows(s, rows);
		else if (s.view === "files") this.filesRows(s, rows);
		else if (s.view === "running") this.runningRows(s, rows);
		else this.outputRows(s, rows);
		this.rows.rows = rows;
		this.redraw();
	}

	private changesRows(s: State, rows: Row[]): void {
		const ch = s.changes;
		if (!ch) return void rows.push({ text: c.gray(s.loading ?? "") });
		if (!ch.repo) return void rows.push({ text: c.gray("This folder is not in a git repository, so there are no changes to show. Files lists what is in it."), wrap: true });
		if (s.diff) {
			const file = s.diff.file;
			const entry = ch.files.find((f) => f.path === file);
			rows.push(this.back(file, (x) => (x.diff = undefined)));
			if (entry) rows.push({ text: c.gray(`${STATUS[entry.status] ?? entry.status}${counts(entry) ? ` · ${counts(entry)}` : ""}`) });
			rows.push({ text: "" });
			if (!s.diff.lines) rows.push({ text: c.gray("reading …") });
			else if (!s.diff.lines.length) rows.push({ text: c.gray(entry ? "nothing to show for this file (a folder, or a binary file)" : "no difference to the last commit any more") });
			else for (const text of s.diff.lines) rows.push({ text, wrap: true });
			if (s.diff.truncated) rows.push({ text: c.gray("… the diff goes on; this is its first 200 000 characters") });
			return;
		}
		if (!ch.files.length) return void rows.push({ text: c.gray("Nothing has changed since the last commit.") });
		const letter: Record<string, (x: string) => string> = { M: c.yellow, A: c.green, "?": c.green, D: c.red, R: c.cyan };
		for (const f of ch.files) {
			const n = counts(f);
			rows.push({ text: `${(letter[f.status] ?? c.gray)(f.status === "?" ? "+" : f.status)} ${plain(f.path)}${n ? `  ${n}` : ""}`, run: () => this.go((x) => (x.diff = { file: f.path })) });
		}
		if (ch.more) rows.push({ text: c.gray("… and more; the first 300 are listed") });
	}

	private filesRows(s: State, rows: Row[]): void {
		if (s.file) {
			rows.push(this.back(s.file.path, (x) => (x.file = undefined)));
			rows.push({ text: "" });
			rows.push(...(s.file.rows ?? [{ text: c.gray("reading …") }]));
			return;
		}
		if (!s.dirs.has("")) return void rows.push({ text: c.gray(s.loading ?? "this folder cannot be read") });
		const walk = (dir: string, depth: number) => {
			for (const e of s.dirs.get(dir) ?? []) {
				const rel = dir ? `${dir}/${e.name}` : e.name;
				const pad = "  ".repeat(depth);
				if (e.dir) {
					const open = s.expanded.has(rel);
					rows.push({ text: `${pad}${c.accent(open ? "▾" : "▸")} ${c.bold(plain(e.name))}/`, run: () => this.go((x) => void (open ? x.expanded.delete(rel) : x.expanded.add(rel)), false) });
					if (open) walk(rel, depth + 1);
				} else rows.push({ text: `${pad}  ${plain(e.name)} ${c.gray(size(e.size))}`, run: () => this.go((x) => (x.file = { path: rel })) });
			}
		};
		walk("", 0);
		if (!rows.length) rows.push({ text: c.gray("This folder is empty.") });
	}

	/** A server or another program that the conversation's commands started and that is still there, each with a way to stop it. */
	private runningRows(s: State, rows: Row[]): void {
		if (!s.programs) return void rows.push({ text: c.gray(s.loading ?? "") });
		if (!s.programs.length) return void rows.push({ text: c.gray("Nothing is running. A server or another program that this conversation's commands start and leave running is listed here, and can be stopped from here."), wrap: true });
		for (const p of s.programs) {
			const stopping = s.stopping?.has(p.id);
			rows.push({ text: `${stopping ? c.yellow("●") : c.green("●")} ${c.bold(plain(programName(p.command, 200)))}`, wrap: true });
			rows.push({ text: c.gray(`  ${[p.ports.length ? `port ${p.ports.join(", ")}` : "", `running for ${since(p.seconds)}`, p.processes > 1 ? `${p.processes} processes` : ""].filter(Boolean).join(" · ")}`) });
			if (stopping) rows.push({ text: c.gray("  stopping …") });
			else rows.push({ text: `  ${c.red("■ stop")}`, run: () => void this.stopProgram(p.id) });
			rows.push({ text: "" });
		}
	}

	private async stopProgram(id: number): Promise<void> {
		const t = this.target();
		const s = this.state;
		if (!t || !s) return;
		(s.stopping ??= new Set()).add(id);
		this.build();
		try {
			await this.client.stopProgram(t.agent, t.session, id);
		} catch (e) {
			s.stopping.delete(id);
			s.error = errText(e);
		}
		// It ends a moment after it was asked to.
		this.touch();
		setTimeout(() => void this.load(false), 2500).unref?.();
	}

	private outputRows(s: State, rows: Row[]): void {
		if (!s.calls) return void rows.push({ text: c.gray(s.loading ?? "") });
		const mark = (e: TranscriptEntry) => (e.ok === undefined ? c.yellow("●") : e.ok ? c.green("✓") : c.red("✗"));
		const open = s.call && s.calls.find((x) => x.task === s.call!.task && x.n === s.call!.n);
		if (open) {
			const e = open.entry;
			rows.push(this.back(e.tool ?? "tool", (x) => (x.call = undefined)));
			rows.push({ text: `${mark(e)} ${c.gray(`task #${open.task}${e.ms !== undefined ? ` · ${took(e.ms)}` : ""}${e.ok === undefined ? " · still running" : ""}`)}` });
			if (e.subject) rows.push({ text: c.yellow(plain(e.subject).replace(/\n/g, " ")), wrap: true });
			rows.push({ text: "" });
			const text = plain(e.result ?? "");
			const body = /^diff --git /m.test(text) ? diffLines(text) : text.split("\n");
			if (!text.trim()) rows.push({ text: c.gray(e.ok === undefined ? "no output yet" : "(no output)") });
			else for (const line of body.slice(0, 4000)) rows.push({ text: e.ok === false ? c.red(line) : line, wrap: true });
			if (body.length > 4000) rows.push({ text: c.gray(`… ${body.length - 4000} more lines`) });
			return;
		}
		if (!s.calls.length) return void rows.push({ text: c.gray("No tool has run in this conversation yet. What the agent's commands and other tools print is listed here."), wrap: true });
		// The newest on top: that is the one looked for.
		[...s.calls].reverse().forEach((call) => {
			const e = call.entry;
			rows.push({ text: `${mark(e)} ${c.bold(e.tool ?? "")} ${c.gray(plain(e.subject ?? "").replace(/\s+/g, " "))}${e.ms !== undefined ? c.gray(`  ${took(e.ms)}`) : ""}`, run: () => this.go((x) => (x.call = { task: call.task, n: call.n })) });
		});
	}

	private renderHead(width: number): string[] {
		this.width = width;
		const s = this.state;
		let text = " ";
		let at = 1;
		this.hits = [];
		const add = (styled: string, run?: () => void) => {
			const w = visibleWidth(styled);
			if (run) this.hits.push({ from: at, to: at + w, run });
			text += styled;
			at += w;
		};
		for (const view of PANE_VIEWS) {
			const label = ` ${view[0].toUpperCase()}${view.slice(1)} `;
			add(s?.view === view ? c.bgAccent(label) : c.gray(label), () => this.show(view));
			add(" ");
		}
		const right = [
			{ styled: c.gray(" ↻ "), run: () => this.show() },
			{ styled: c.gray(" × "), run: () => this.close() },
		];
		const rightWidth = right.reduce((n, r) => n + visibleWidth(r.styled), 0);
		text += " ".repeat(Math.max(0, width - at - rightWidth));
		at = Math.max(at, width - rightWidth);
		for (const r of right) add(r.styled, r.run);
		const where = s?.root ? tilde(s.root) : "";
		const ch = s?.view === "changes" ? s.changes : undefined;
		// What is asked for first comes first; the folder's name is what gets cut when the pane is narrow.
		const info = [...(ch?.repo ? [`${ch.branch || "no branch"}`, ch.files.length ? `${ch.files.length}${ch.more ? "+" : ""} changed` : "clean"] : []), ...(s?.view === "output" && s.calls ? [`${s.calls.length} tool call${s.calls.length === 1 ? "" : "s"}`] : []), ...(s?.view === "running" && s.programs ? [s.programs.length ? `${s.programs.length} running` : "nothing running"] : []), where].filter(Boolean).join(" · ");
		return [truncateToWidth(text, width), truncateToWidth(` ${c.gray(info)}`, width), c.gray("─".repeat(width))];
	}
}

const STATUS: Record<string, string> = { M: "changed", A: "added", D: "deleted", R: "renamed", "?": "new, not tracked by git yet" };

function counts(f: { added?: number; removed?: number }): string {
	return [f.added ? c.green(`+${f.added}`) : "", f.removed ? c.red(`−${f.removed}`) : ""].filter(Boolean).join(" ");
}
