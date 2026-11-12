import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { FileChange, Snap, Snapshots } from "./snapshots.ts";
import type { PineConfig } from "./config.ts";
import type { Bus, Kv, TaskStore } from "./store.ts";
import type { Task } from "./types.ts";
import { errText, type Logger } from "./util.ts";

// Taking back the owner's last message: what is kept so that it can be done, and the two parts of
// doing it that need no knowledge of running sessions: the files and pi's session file.
// `AgentManager.undo` and `.redo` (src/agents.ts) stop what runs, call these, and put the
// conversation's rights back. Only the control API reaches them.
//
// A turn is one message of the owner's with everything it led to: its own run, the sub-agents and
// handed-on tasks it started, and whatever else ran in the conversation until the next message.
// For each turn pine keeps where the conversation stood before it, and the state of the folder
// before and after each stretch of work in it (a step): from the first tool call of the message's
// own run to its end, and the same for every later task. What changed in the folder between two
// steps (the owner at work in an editor) belongs to no step and is not taken back.

/** The outside-content mark of a conversation and the owner's yes to it, as the store holds them. */
export interface Marks {
	taint?: string;
	keep?: boolean;
}

export interface Turn {
	/** The owner's message. */
	task: number;
	/**
	 * pi's session file, by its name in the conversation's session folder (the folder is renamed
	 * with the conversation), and the entry the conversation stood at before the message (null: at
	 * its very beginning).
	 */
	file?: string;
	leaf?: string | null;
	/** The folder the conversation worked in: the one opened for it, else the agent's workspace. */
	root: string;
	/** The work done in the turn, oldest first. None: no tool has run, so nothing was changed. */
	steps: Step[];
	/** Why the folder could not be recorded. */
	problem?: string;
	marks: Marks;
}

/** One stretch of work in a turn: the message's own run with what it started, or a task that came later. */
export interface Step {
	task: number;
	/** The folder before the first tool call. */
	before: Snap;
	/** The folder when the work ended. Missing while it runs, or when it was cut short. */
	after?: Snap;
}

/** A message that was taken back, with what a redo needs. */
export interface Undone {
	task: number;
	rows: Task[];
	turn?: Turn;
	/** Where the conversation stood when the message was taken back. */
	file?: string;
	leaf?: string | null;
	/** The folder as it was then, and the files that were set back. */
	cur?: Snap;
	paths?: string[];
	marks: Marks;
}

/** What happened to the files of the folder. */
export interface Restored {
	root: string;
	/** Changed files that have their earlier content again, files that are gone again, and deleted files that are back. */
	changed: number;
	removed: number;
	back: number;
	/** The first of them, by name. */
	files: string[];
	/** Too large to be recorded: left as they are. */
	left: string[];
}

export interface UndoResult {
	task: number;
	/** The message as the owner wrote it. */
	prompt: string;
	/** How many running tasks were stopped first. */
	stopped: number;
	/** The message still waited its turn: it was withdrawn, and there is nothing else to say about it. */
	waiting?: boolean;
	restored?: Restored;
	/** Why no file was touched although the message may have changed some. */
	note?: string;
	/** How many messages a redo can bring back, and whether there is another one to take back. */
	redo: number;
	more: boolean;
}

export interface TurnView {
	task?: number;
	prompt?: string;
	root?: string;
	files: FileChange[];
	more: boolean;
	note?: string;
}

const KEEP_TURNS = 40;
const KEEP_UNDONE = 20;

/**
 * A message the owner typed into a conversation: the only thing undo takes back. Not one that
 * was steered into a running task: that is part of the task's turn and has no run of its own.
 */
export const ownerMessage = (t: Task) => t.kind === "prompt" && t.meta.trust === "owner" && t.parent === undefined && !t.session.startsWith("_t") && !t.session.endsWith("~u") && !t.meta.label?.startsWith("steered into");

/** The message without what pine added to it at the time. */
export const typed = (prompt: string) => prompt.replace(/\n\n\[files attached by your owner, saved in your workspace: [^\]]*\]$/, "");

const tally = (root: string, files: FileChange[], left: string[]): Restored => ({
	root,
	// Seen from the folder as it was: a file the message made is removed, one it deleted comes back.
	changed: files.filter((f) => f.status === "M").length,
	removed: files.filter((f) => f.status === "D").length,
	back: files.filter((f) => f.status === "A").length,
	files: files.slice(0, 20).map((f) => f.path),
	left,
});

export class Turns {
	private kv: Kv;
	private tasks: TaskStore;
	private snapshots: Snapshots;
	private log: Logger;
	/** Tasks whose turn has its "before" (or is getting it): asked with every tool call, so answered from here. */
	private seen = new Map<number, Promise<void>>();
	/**
	 * What a conversation was allowed before each message and when it was taken back, as far as
	 * the daemon holds that in memory only (see `AgentManager.rightsOf`). Gone with a restart, as
	 * those rights are.
	 */
	private rights = new Map<string, unknown>();

	constructor(deps: { kv: Kv; tasks: TaskStore; snapshots: Snapshots; log: Logger }) {
		this.kv = deps.kv;
		this.tasks = deps.tasks;
		this.snapshots = deps.snapshots;
		this.log = deps.log;
	}

	of(agent: string, session: string): Turn[] {
		return this.kv.get<Turn[]>(`turns:${agent}:${session}`) ?? [];
	}

	undone(agent: string, session: string): Undone[] {
		return this.kv.get<Undone[]>(`undone:${agent}:${session}`) ?? [];
	}

	private save(agent: string, session: string, turn: Turn): void {
		const list = this.of(agent, session);
		const i = list.findIndex((t) => t.task === turn.task);
		if (i >= 0) list[i] = turn;
		else list.push(turn);
		this.kv.set(`turns:${agent}:${session}`, list.slice(-KEEP_TURNS));
	}

	/** The turn a task's work belongs to: that of the owner's message at the top of it, else the last one of its conversation. */
	private turnOf(task: Task): { agent: string; session: string; turn: Turn; step: number } | undefined {
		// Sub-agents and tasks handed on are part of the work of the task at the top of them.
		const top = task.meta.root === undefined || task.meta.root === task.id ? task : this.tasks.get(task.meta.root);
		if (!top || top.meta.trust !== "owner" || top.parent !== undefined || top.session.startsWith("_t") || top.session.endsWith("~u")) return undefined;
		// The owner's message itself, or something that followed it in the conversation: an answer
		// that came back later, an event, a schedule. Each is a step of its own in that turn.
		const turn = ownerMessage(top) ? this.of(top.agent, top.session).find((t) => t.task === top.id) : this.of(top.agent, top.session).at(-1);
		return turn && { agent: top.agent, session: top.session, turn, step: top.id };
	}

	/**
	 * A task is about to be worked on in a conversation. Whatever was taken back there is now final:
	 * the conversation goes on from where it stood, and a redo would put the old continuation over
	 * the new one. A message of the owner's begins a turn.
	 */
	starting(task: Task, at: { file?: string; leaf: string | null; root: string; marks: Marks; rights: unknown }): void {
		if (task.session.startsWith("_t")) return;
		if (this.undone(task.agent, task.session).length) this.kv.set(`undone:${task.agent}:${task.session}`, null);
		if (!ownerMessage(task)) return;
		this.save(task.agent, task.session, { task: task.id, file: at.file && path.basename(at.file), leaf: at.leaf, root: at.root, steps: [], marks: at.marks });
		this.remember(task.id, "before", at.rights);
	}

	remember(task: number, when: "before" | "after", rights: unknown): void {
		this.rights.set(`${task}:${when}`, rights);
		if (this.rights.size > 400) for (const key of [...this.rights.keys()].slice(0, 200)) this.rights.delete(key);
	}

	recall(task: number, when: "before" | "after"): unknown {
		return this.rights.get(`${task}:${when}`);
	}

	/**
	 * Before a tool call: the first one of a turn records the folder as it is. Until a tool runs
	 * nothing can have changed there, so a message that is only answered costs nothing.
	 */
	touching(task: Task): Promise<void> {
		let p = this.seen.get(task.id);
		if (!p) {
			// Never a reason for a tool call to fail.
			p = this.record(task, "before").catch((e) => this.log.warn(`undo: task #${task.id}`, errText(e)));
			this.seen.set(task.id, p);
			if (this.seen.size > 500) for (const id of [...this.seen.keys()].slice(0, 250)) this.seen.delete(id);
		}
		return p;
	}

	/** A task ended. If it ran tools, the folder as it is now is what its turn left behind. */
	async ended(task: Task, tools: number): Promise<void> {
		this.seen.delete(task.id);
		if (tools > 0) await this.record(task, "after").catch((e) => this.log.warn(`undo: task #${task.id}`, errText(e)));
	}

	private async record(task: Task, which: "before" | "after"): Promise<void> {
		const at = this.turnOf(task);
		if (!at || at.turn.problem) return;
		const id = at.step;
		const known = at.turn.steps.some((s) => s.task === id);
		if (which === "before" ? known : !known) return;
		let snap: Snap | undefined;
		let problem: string | undefined;
		try {
			snap = await this.snapshots.take(at.turn.root);
		} catch (e) {
			problem = errText(e);
			this.log.warn(`the folder ${at.turn.root} was not recorded ${which} task #${task.id}: undo will not restore files there`, problem);
		}
		// Read again: the turn may have been taken back, or written by another task, while git ran.
		const turn = this.of(at.agent, at.session).find((t) => t.task === at.turn.task);
		if (!turn) return;
		const step = turn.steps.find((s) => s.task === id);
		if (snap && which === "before" && !step) turn.steps.push({ task: id, before: snap });
		else if (snap && step) step.after = snap;
		// Without a "before" there is nothing to go back to. A missed "after" only means the present is taken for it.
		else if (!snap && which === "before") turn.problem = problem;
		this.save(at.agent, at.session, turn);
	}

	/** Take a turn out of the list (its message is being taken back). */
	drop(agent: string, session: string, task: number): void {
		this.kv.set(`turns:${agent}:${session}`, this.of(agent, session).filter((t) => t.task !== task));
	}

	putBack(agent: string, session: string, turn: Turn): void {
		this.save(agent, session, turn);
		this.kv.set(`turns:${agent}:${session}`, this.of(agent, session).sort((a, b) => a.task - b.task));
	}

	park(agent: string, session: string, rec: Undone): number {
		const list = [...this.undone(agent, session), rec].slice(-KEEP_UNDONE);
		this.kv.set(`undone:${agent}:${session}`, list);
		return list.length;
	}

	/** The message taken back last, taken off the list. */
	unpark(agent: string, session: string): { rec?: Undone; left: number } {
		const list = this.undone(agent, session);
		const rec = list.pop();
		this.kv.set(`undone:${agent}:${session}`, list.length ? list : null);
		return { rec, left: list.length };
	}

	/** A conversation was reset or removed: nothing of it can be taken back or brought back any more. */
	forget(agent: string, session: string): void {
		this.kv.set(`turns:${agent}:${session}`, null);
		this.kv.set(`undone:${agent}:${session}`, null);
	}

	rename(agent: string, from: string, to: string): void {
		const turns = this.kv.get<Turn[]>(`turns:${agent}:${from}`);
		const undone = this.kv.get<Undone[]>(`undone:${agent}:${from}`);
		this.forget(agent, from);
		if (turns) this.kv.set(`turns:${agent}:${to}`, turns);
		// The tasks that wait for a redo go back into the list under the name the conversation has then.
		for (const u of undone ?? []) for (const row of u.rows) if (row.agent === agent && row.session === from) row.session = to;
		if (undone) this.kv.set(`undone:${agent}:${to}`, undone);
	}

	/**
	 * The files of a turn back to what they were before it. Only files the turn's work changed are
	 * set, and only where they are not like that already: what the owner changed elsewhere in the
	 * folder since stays. `started`: whether the message was worked on at all.
	 */
	async back(turn: Turn | undefined, started: boolean): Promise<{ restored?: Restored; note?: string; cur?: Snap; paths?: string[] }> {
		if (!turn) return started ? { note: "the folder was not recorded for this message, so no file was restored" } : {};
		if (turn.problem) return { note: `the folder was not recorded for this message (${turn.problem}), so no file was restored` };
		// No tool ran: there is nothing the message could have changed.
		if (!turn.steps.length) return { restored: tally(turn.root, [], []) };
		if (!fs.existsSync(turn.root)) return { note: `${turn.root} is not there any more, so no file was restored` };
		let cur: Snap | undefined;
		const files = new Map<string, FileChange>();
		const paths = new Set<string>();
		const left = new Set<string>();
		try {
			// The last step first, each back to its own beginning: a file two steps changed ends at the earlier one's.
			for (const step of [...turn.steps].reverse()) {
				// A step that was stopped just now has no "after": the present is it.
				const after = step.after ?? (await this.snapshots.take(turn.root));
				const done = await this.snapshots.restore(turn.root, step.before, { within: [step.before, after] });
				cur ??= done.cur;
				for (const f of done.files) files.set(f.path, f);
				for (const p of done.paths) paths.add(p);
				for (const p of done.left) left.add(p);
			}
			return { restored: tally(turn.root, [...files.values()], [...left]), cur, paths: [...paths] };
		} catch (e) {
			this.log.warn(`undo: the files in ${turn.root} were not restored`, errText(e));
			// What a step already set back can still be brought back by a redo.
			return { note: `${files.size ? "not all files were restored" : "the files were not restored"}: ${errText(e)}`, cur, paths: [...paths] };
		}
	}

	/** The same files as the message had left them: a redo. */
	async again(rec: Undone): Promise<{ restored?: Restored; note?: string }> {
		const root = rec.turn?.root;
		if (!root || !rec.cur) return {};
		if (!rec.paths?.length) return { restored: tally(root, [], []) };
		if (!fs.existsSync(root)) return { note: `${root} is not there any more, so no file was restored` };
		try {
			const done = await this.snapshots.restore(root, rec.cur, { only: rec.paths, avoid: (rec.turn?.steps ?? []).flatMap((s) => [s.before, ...(s.after ? [s.after] : [])]) });
			return { restored: tally(root, done.files, done.left) };
		} catch (e) {
			this.log.warn(`redo: the files in ${root} were not restored`, errText(e));
			return { note: `the files were not restored: ${errText(e)}` };
		}
	}

	/** The two states between which the last message of a conversation lies, if the folder was recorded. */
	private async span(agent: string, session: string, running: (task: number) => boolean): Promise<{ head: TurnView; turn?: Turn; from?: Snap; to?: Snap }> {
		const turn = this.of(agent, session).at(-1);
		const task = turn && this.tasks.get(turn.task);
		if (!turn || !task) return { head: { files: [], more: false, note: "No message of yours has been worked on in this conversation since pine keeps track of that. What the next one changes is listed here." } };
		const head: TurnView = { task: turn.task, prompt: typed(task.prompt).slice(0, 200), root: turn.root, files: [], more: false };
		if (turn.problem) return { head: { ...head, note: `The folder was not recorded for this message: ${turn.problem}.` } };
		if (!turn.steps.length) return { head };
		const last = turn.steps.at(-1)!;
		// While it is being worked on, what it has changed so far.
		const to = running(last.task) || !last.after ? await this.snapshots.take(turn.root) : last.after;
		return { head, turn, from: turn.steps[0].before, to };
	}

	/** What the last message of a conversation changed in its folder. `running`: whether a task is still being worked on. */
	async view(agent: string, session: string, running: (task: number) => boolean): Promise<TurnView> {
		try {
			const at = await this.span(agent, session, running);
			if (!at.turn || !at.from || !at.to) return at.head;
			const files = await this.snapshots.changed(at.turn.root, at.from, at.to);
			return { ...at.head, files: files.slice(0, 300), more: files.length > 300 };
		} catch (e) {
			return { files: [], more: false, note: errText(e) };
		}
	}

	/** The difference of one file over the last message. */
	async viewDiff(agent: string, session: string, running: (task: number) => boolean, file: string): Promise<{ diff: string; truncated: boolean } | undefined> {
		const at = await this.span(agent, session, running).catch(() => undefined);
		return at?.turn && at.from && at.to ? this.snapshots.diff(at.turn.root, at.from, at.to, file) : undefined;
	}

	/** Every state that is still referred to, by folder: the rest can be dropped. */
	kept(): Map<string, Set<string>> {
		const out = new Map<string, Set<string>>();
		const add = (root: string | undefined, ...snaps: Array<Snap | undefined>) => {
			if (!root) return;
			if (!out.has(root)) out.set(root, new Set());
			for (const s of snaps) if (s) out.get(root)!.add(s.tree);
		};
		for (const key of this.kv.keys("turns:")) for (const t of this.kv.get<Turn[]>(key) ?? []) add(t.root, ...t.steps.flatMap((s) => [s.before, s.after]));
		for (const key of this.kv.keys("undone:")) for (const u of this.kv.get<Undone[]>(key) ?? []) add(u.turn?.root, u.cur, ...(u.turn?.steps ?? []).flatMap((s) => [s.before, s.after]));
		return out;
	}
}

// ---- taking back, and bringing back ---------------------------------------------------------------

/** What `AgentManager` lends to the two functions below. */
export interface UndoHost {
	cfg: PineConfig;
	kv: Kv;
	tasks: TaskStore;
	bus: Bus;
	turns: Turns;
	log: Logger;
	cancel(id: number): boolean;
	wait(id: number): Promise<unknown>;
	/** Run when nothing runs in the conversation, with its session closed, and before whatever is sent later. */
	quiet<T>(agent: string, session: string, fn: () => Promise<T>): Promise<T>;
	/** What the conversation may do without asking, as far as it is held in memory: a copy, and putting one back. */
	rights(perm: string): unknown;
	setRights(perm: string, rights: unknown): void;
	/** A task is gone from the list: nothing kept in memory about it is of use any more. */
	forgetTask(id: number): void;
}

const NOTHING_TO_REDO = "there is nothing to bring back: /redo takes back the last /undo, until a new message is sent";

/**
 * Take back the owner's last message in a conversation, with everything that followed it there.
 * In this order: what runs is stopped; the session file is put back to before the message; the
 * files go back; its tasks leave the task list, from which history is shown, and wait in private
 * storage for a redo; the conversation's outside-content mark and what the owner allowed in it
 * are again what they were before the message, because what gave rise to them is gone, as after
 * a reset.
 */
export async function undoMessage(h: UndoHost, agentId: string, key: string): Promise<UndoResult> {
	const mine = () => h.tasks.list({ agent: agentId, session: key, limit: 1000 });
	const msg = mine().find(ownerMessage);
	if (!msg) throw new Error("there is no message of yours in this conversation to take back");
	// One that still waits its turn has done nothing and is nowhere but in the list: it is withdrawn,
	// without waiting for what runs before it, and there is nothing a redo could bring back.
	if (msg.status === "pending") {
		h.cancel(msg.id);
		for (const t of h.tasks.take([msg.id])) h.forgetTask(t.id);
		h.log.info(`conversation ${agentId}:${key}: the owner withdrew message #${msg.id} before it was worked on`);
		return { task: msg.id, prompt: typed(msg.prompt), stopped: 0, waiting: true, redo: h.turns.undone(agentId, key).length, more: mine().some(ownerMessage) };
	}
	// Its own run, what came after it in the conversation, and the work those started anywhere.
	const later = new Set(mine().filter((t) => t.id >= msg.id).map((t) => t.id));
	const active = [...h.tasks.byStatus("running"), ...h.tasks.byStatus("pending")].filter((t) => later.has(t.id) || later.has(t.meta.root ?? t.id));
	for (const t of active) h.cancel(t.id);
	return h.quiet(agentId, key, async () => {
		await Promise.all(active.map((t) => h.wait(t.id).catch(() => undefined)));
		// Exactly what was there when the owner asked: a message sent since then waits behind this and is not part of it.
		const rows = mine().filter((t) => later.has(t.id));
		const now = rows.find((t) => t.id === msg.id);
		if (!now) throw new Error("that message was taken back already");
		const perm = `${agentId}:${key}`;
		const turn = h.turns.of(agentId, key).find((t) => t.task === msg.id);
		const started = now.started !== undefined;
		// The conversation first: if its file cannot be put back, nothing has been changed yet and the owner is told.
		// Without a record of where it stood (a message from before pine kept one), it is looked for by its text.
		const dir = path.join(h.cfg.agents[agentId].dir, "sessions", key);
		const stood = started ? rewind(turn?.file ? path.join(dir, turn.file) : sessionFile(dir), turn ? turn.leaf : undefined, now.prompt, msg.id) : undefined;
		const files = await h.turns.back(turn, started);
		const taken = h.tasks.take(rows.map((t) => t.id));
		for (const t of taken) h.forgetTask(t.id);
		const marks: Marks = { taint: h.kv.get<string>(`taint:${perm}`) ?? undefined, keep: h.kv.get(`keep:${perm}`) === true };
		h.turns.remember(msg.id, "after", h.rights(perm));
		if (turn) {
			h.turns.drop(agentId, key, msg.id);
			h.kv.set(`taint:${perm}`, turn.marks.taint ?? null);
			h.kv.set(`keep:${perm}`, turn.marks.keep ? true : null);
			h.setRights(perm, h.turns.recall(msg.id, "before"));
		}
		const redo = h.turns.park(agentId, key, { task: msg.id, rows: taken, turn, file: stood && path.basename(stood.file), leaf: stood?.leaf, cur: files.cur, paths: files.paths, marks });
		const stopped = active.filter((t) => t.status === "running").length;
		h.log.info(`conversation ${perm}: the owner took back message #${msg.id}${stopped ? `, ${stopped} running task${stopped === 1 ? "" : "s"} stopped` : ""}${files.restored ? `, ${files.restored.changed + files.restored.removed + files.restored.back} files restored in ${files.restored.root}` : ""}${files.note ? ` (${files.note})` : ""}`);
		h.bus.publish(`agent/${agentId}/undone`, { agent: agentId, session: key, message: msg.id, tasks: taken.length, files: files.restored ? files.restored.changed + files.restored.removed + files.restored.back : undefined }, { source: "pine" });
		return { task: msg.id, prompt: typed(now.prompt), stopped, restored: files.restored, note: files.note, redo, more: mine().some(ownerMessage) };
	});
}

/** Bring back the message that was taken back last: its files, its place in the conversation, its tasks, and what was allowed. */
export async function redoMessage(h: UndoHost, agentId: string, key: string): Promise<UndoResult> {
	const mine = () => h.tasks.list({ agent: agentId, session: key, limit: 1000 });
	if (!h.turns.undone(agentId, key).length) throw new Error(NOTHING_TO_REDO);
	// A message that waits to be worked on makes the undo final the moment it starts; it already counts.
	if (mine().some((t) => t.status === "pending" || t.status === "running")) throw new Error("something new is being worked on in this conversation, so what was taken back stays taken back");
	return h.quiet(agentId, key, async () => {
		const { rec, left } = h.turns.unpark(agentId, key);
		if (!rec) throw new Error(NOTHING_TO_REDO);
		const perm = `${agentId}:${key}`;
		forward(rec.file && path.join(h.cfg.agents[agentId].dir, "sessions", key, rec.file), rec.leaf, rec.task);
		const files = await h.turns.again(rec);
		h.tasks.putBack(rec.rows);
		if (rec.turn) {
			h.turns.putBack(agentId, key, rec.turn);
			h.kv.set(`taint:${perm}`, rec.marks.taint ?? null);
			h.kv.set(`keep:${perm}`, rec.marks.keep ? true : null);
			h.setRights(perm, h.turns.recall(rec.task, "after"));
		}
		const msg = rec.rows.find((t) => t.id === rec.task);
		h.log.info(`conversation ${perm}: the owner brought back message #${rec.task}${files.restored ? `, ${files.restored.changed + files.restored.removed + files.restored.back} files restored in ${files.restored.root}` : ""}${files.note ? ` (${files.note})` : ""}`);
		h.bus.publish(`agent/${agentId}/redone`, { agent: agentId, session: key, message: rec.task, tasks: rec.rows.length, files: files.restored ? files.restored.changed + files.restored.removed + files.restored.back : undefined }, { source: "pine" });
		return { task: rec.task, prompt: typed(msg?.prompt ?? ""), stopped: 0, restored: files.restored, note: files.note, redo: left, more: mine().some(ownerMessage) };
	});
}

// ---- pi's session file ---------------------------------------------------------------------------
// A session is a tree of entries in one file, and the conversation is the path from its newest
// entry to the root. pi can go back to an earlier entry (`branch`), but only in memory: a session
// opened from the file stands at the last entry written. So going back is made to last by
// writing an entry there: one of pine's own, which is no message and is not sent to the model.
// The entries that were left stay in the file as a branch nobody stands on, which is what lets a
// redo return to them. The session must not be open while this is done.

/**
 * The lines of a session file that are the conversation as it stands: the entries on the way
 * from the newest one to the first. In a file in which nothing was taken back that is all of them.
 */
export function onBranch(lines: string[]): string[] {
	const entries = lines.map((line) => {
		try {
			const e = JSON.parse(line);
			return e && typeof e.id === "string" && e.type !== "session" ? e : undefined;
		} catch {
			return undefined;
		}
	});
	const byId = new Map<string, any>(entries.filter(Boolean).map((e) => [e.id, e]));
	const kept = new Set<string>();
	for (let at = entries.findLast(Boolean); at && !kept.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) kept.add(at.id);
	return lines.filter((_, i) => !entries[i] || kept.has(entries[i].id));
}

/** The newest session file of a conversation, as pi would continue it. */
export function sessionFile(dir: string): string | undefined {
	try {
		const newest = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().at(-1);
		return newest && path.join(dir, newest);
	} catch {
		return undefined;
	}
}

/**
 * Put a conversation back to before a message. `leaf` is where it stood then, when that is known;
 * otherwise the message is looked for by its text. Returns where it stood until now, or undefined
 * when the file holds nothing of that message (it was never worked on).
 */
export function rewind(file: string | undefined, leaf: string | null | undefined, prompt: string, task: number): { file: string; leaf: string | null } | undefined {
	if (!file || !fs.existsSync(file)) return undefined;
	const sm = SessionManager.open(file);
	const from = sm.getLeafId();
	let to = leaf;
	if (to === undefined) {
		const needle = prompt.slice(0, 200);
		const said = sm.getBranch().filter((e: any) => e.type === "message" && e.message?.role === "user" && textOf(e.message.content).includes(needle)).at(-1);
		if (!said) return undefined;
		to = said.parentId ?? null;
	}
	if (to !== null && !sm.getEntry(to)) return undefined;
	// Already there: the message was queued behind this point and never reached the file.
	if (to === from) return undefined;
	if (to === null) sm.resetLeaf();
	else sm.branch(to);
	sm.appendCustomEntry("pine-undo", { task });
	return { file, leaf: from };
}

/** Put a conversation back to where it stood before `rewind`. */
export function forward(file: string | undefined, leaf: string | null | undefined, task: number): boolean {
	if (!file || !leaf || !fs.existsSync(file)) return false;
	const sm = SessionManager.open(file);
	if (!sm.getEntry(leaf)) return false;
	sm.branch(leaf);
	sm.appendCustomEntry("pine-redo", { task });
	return true;
}

const textOf = (content: unknown): string => (typeof content === "string" ? content : Array.isArray(content) ? content.filter((x: any) => x?.type === "text").map((x: any) => x.text).join("\n") : "");
