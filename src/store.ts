import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PineEvent, PublishOptions, Task, TaskStatus } from "./types.ts";
import { errText, topicMatches, type Logger } from "./util.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, topic TEXT NOT NULL, source TEXT NOT NULL,
  payload TEXT, cause INTEGER, hops INTEGER NOT NULL DEFAULT 0, reply TEXT, trust TEXT NOT NULL DEFAULT 'untrusted'
);
CREATE INDEX IF NOT EXISTS events_topic ON events(topic, id);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT, ts INTEGER NOT NULL, source TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, session TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL,
  status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, started INTEGER, finished INTEGER,
  result TEXT, error TEXT, event INTEGER, hops INTEGER NOT NULL DEFAULT 0, parent INTEGER, depth INTEGER NOT NULL DEFAULT 0,
  reply TEXT, meta TEXT
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, id);
`;

export function openDb(dataDir: string): DatabaseSync {
	fs.mkdirSync(dataDir, { recursive: true });
	const db = new DatabaseSync(path.join(dataDir, "pine.db"));
	db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
	db.exec(SCHEMA);
	return db;
}

const parse = (s: unknown) => (typeof s === "string" && s.length ? JSON.parse(s) : undefined);

type Handler = (event: PineEvent) => void | Promise<void>;

/** Append-only event log with in-process subscriptions. Everything that happens goes through here. */
export class Bus {
	private db: DatabaseSync;
	private log: Logger;
	private subs = new Set<{ pattern: string; handler: Handler; name: string }>();
	private pending = new Set<Promise<void>>();
	/** Applied to every payload before it is stored or delivered. */
	redact?: <T>(payload: T) => T;

	constructor(db: DatabaseSync, log: Logger) {
		this.db = db;
		this.log = log;
	}

	/**
	 * Take a secret out of what is already stored. A token the owner typed into a conversation
	 * ("here is the bot's token") was in events and tasks before anyone knew it was one.
	 */
	scrub(secret: string): void {
		if (secret.length < 8) return;
		this.db.prepare("UPDATE events SET payload = replace(payload, ?, '[redacted]') WHERE instr(payload, ?) > 0").run(secret, secret);
		for (const col of ["prompt", "result", "error", "meta"]) this.db.prepare(`UPDATE tasks SET ${col} = replace(${col}, ?, '[redacted]') WHERE instr(${col}, ?) > 0`).run(secret, secret);
	}

	publish(topic: string, payload: unknown = null, opts: PublishOptions = {}): PineEvent {
		if (!topic || /[+#]/.test(topic)) throw new Error(`invalid topic: ${JSON.stringify(topic)}`);
		const cause = opts.cause ?? undefined;
		const event: PineEvent = {
			id: 0,
			ts: Date.now(),
			topic,
			source: opts.source ?? "pine",
			payload,
			cause: cause?.id || undefined,
			hops: (cause?.hops ?? 0) + (opts.hop ? 1 : 0),
			reply: opts.reply,
			trust: opts.trust ?? "untrusted",
		};
		if (this.redact) event.payload = this.redact(event.payload);
		if (opts.persist !== false) {
			const r = this.db
				.prepare("INSERT INTO events (ts, topic, source, payload, cause, hops, reply, trust) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
				.run(event.ts, topic, event.source, JSON.stringify(event.payload ?? null), event.cause ?? null, event.hops, event.reply ? JSON.stringify(event.reply) : null, event.trust);
			event.id = Number(r.lastInsertRowid);
		}
		for (const sub of this.subs) {
			if (!topicMatches(sub.pattern, topic)) continue;
			const p = Promise.resolve()
				.then(() => sub.handler(event))
				.catch((e) => this.log.error(`subscriber ${sub.name} failed on ${topic}`, errText(e)))
				.finally(() => this.pending.delete(p));
			this.pending.add(p);
		}
		return event;
	}

	/** Handlers run asynchronously after publish() returns; a throwing handler is logged, never rethrown. */
	subscribe(pattern: string | string[], handler: Handler, name = "anonymous"): () => void {
		const entries = (Array.isArray(pattern) ? pattern : [pattern]).map((p) => ({ pattern: p, handler, name }));
		for (const e of entries) this.subs.add(e);
		return () => {
			for (const e of entries) this.subs.delete(e);
		};
	}

	/** Resolve with the next event matching `pattern` (and `filter`), or reject after `timeoutMs`. */
	waitFor(pattern: string, filter: (e: PineEvent) => boolean = () => true, timeoutMs = 10_000): Promise<PineEvent> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				off();
				reject(new Error(`no event on ${pattern} within ${timeoutMs} ms`));
			}, timeoutMs);
			const off = this.subscribe(pattern, (e) => {
				if (!filter(e)) return;
				clearTimeout(timer);
				off();
				resolve(e);
			});
		});
	}

	/** Wait until every handler started so far has finished. */
	async drain(): Promise<void> {
		while (this.pending.size) await Promise.allSettled([...this.pending]);
	}

	get(id: number): PineEvent | undefined {
		const row = this.db.prepare("SELECT * FROM events WHERE id = ?").get(id);
		return row ? this.fromRow(row) : undefined;
	}

	query(q: { topic?: string; after?: number; limit?: number } = {}): PineEvent[] {
		const limit = Math.min(q.limit ?? 100, 1000);
		// Patterns are matched in JS; a literal prefix narrows the scan.
		const prefix = q.topic ? q.topic.split(/[+#]/)[0] : "";
		const rows = q.after !== undefined
			? this.db.prepare("SELECT * FROM events WHERE id > ? AND topic LIKE ? ESCAPE '\\' ORDER BY id ASC LIMIT ?").all(q.after, `${prefix.replace(/[\\%_]/g, "\\$&")}%`, limit * 20)
			: this.db.prepare("SELECT * FROM events WHERE topic LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?").all(`${prefix.replace(/[\\%_]/g, "\\$&")}%`, limit * 20);
		const events = rows.map((r) => this.fromRow(r)).filter((e) => !q.topic || topicMatches(q.topic, e.topic)).slice(0, limit);
		return q.after !== undefined ? events : events.reverse();
	}

	prune(olderThanMs: number): number {
		return Number(this.db.prepare("DELETE FROM events WHERE ts < ?").run(Date.now() - olderThanMs).changes);
	}

	private fromRow(r: any): PineEvent {
		return { id: r.id, ts: r.ts, topic: r.topic, source: r.source, payload: parse(r.payload) ?? null, cause: r.cause ?? undefined, hops: r.hops, reply: parse(r.reply), trust: r.trust === "owner" ? "owner" : "untrusted" };
	}
}

/** Shared world state: small JSON values under slash-separated keys. Every write is also an event on `state/<key>`. */
export class State {
	private db: DatabaseSync;
	private bus: Bus;

	constructor(db: DatabaseSync, bus: Bus) {
		this.db = db;
		this.bus = bus;
	}

	get<T = unknown>(key: string): T | undefined {
		const row = this.db.prepare("SELECT value FROM state WHERE key = ?").get(key) as any;
		return row ? (parse(row.value) as T) : undefined;
	}

	set(key: string, value: unknown, opts: { source?: string; cause?: PineEvent | null } = {}): void {
		if (!key || /[+#]/.test(key)) throw new Error(`invalid state key: ${JSON.stringify(key)}`);
		const previous = this.get(key);
		if (value === undefined || value === null) this.db.prepare("DELETE FROM state WHERE key = ?").run(key);
		else this.db.prepare("INSERT INTO state (key, value, ts, source) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, ts = excluded.ts, source = excluded.source").run(key, JSON.stringify(value), Date.now(), opts.source ?? "pine");
		if (JSON.stringify(previous) !== JSON.stringify(value ?? undefined)) this.bus.publish(`state/${key}`, { value: value ?? null, previous: previous ?? null }, { source: opts.source ?? "pine", cause: opts.cause, hop: Boolean(opts.cause) });
	}

	list(patterns: string | string[] = "#"): Array<{ key: string; value: unknown; ts: number; source: string }> {
		const list = Array.isArray(patterns) ? patterns : [patterns];
		return (this.db.prepare("SELECT * FROM state ORDER BY key").all() as any[])
			.filter((r) => list.some((p) => topicMatches(p, r.key)))
			.map((r) => ({ key: r.key, value: parse(r.value), ts: r.ts, source: r.source }));
	}
}

/** Private key-value storage for sources and the daemon (cursors, last-run times). No events. */
export class Kv {
	private db: DatabaseSync;
	constructor(db: DatabaseSync) {
		this.db = db;
	}
	get<T = unknown>(key: string): T | undefined {
		const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as any;
		return row ? (parse(row.value) as T) : undefined;
	}
	set(key: string, value: unknown): void {
		this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
	}
	/** The keys that start with a prefix. */
	keys(prefix: string): string[] {
		return (this.db.prepare("SELECT key FROM kv WHERE substr(key, 1, ?) = ? ORDER BY key").all(prefix.length, prefix) as any[]).map((r) => r.key);
	}
}

export class TaskStore {
	private db: DatabaseSync;
	constructor(db: DatabaseSync) {
		this.db = db;
	}

	insert(t: Omit<Task, "id">): Task {
		const r = this.db
			.prepare("INSERT INTO tasks (agent, session, kind, prompt, status, priority, created, event, hops, parent, depth, reply, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(t.agent, t.session, t.kind, t.prompt, t.status, t.priority, t.created, t.event ?? null, t.hops, t.parent ?? null, t.depth, t.reply ? JSON.stringify(t.reply) : null, JSON.stringify(t.meta ?? {}));
		return { ...t, id: Number(r.lastInsertRowid) };
	}

	update(id: number, patch: Partial<Pick<Task, "status" | "started" | "finished" | "result" | "error" | "session" | "meta">>): void {
		const cols = Object.keys(patch) as Array<keyof typeof patch>;
		if (!cols.length) return;
		const values = cols.map((c) => (c === "meta" ? JSON.stringify(patch.meta) : ((patch[c] as any) ?? null)));
		this.db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...values, id);
	}

	get(id: number): Task | undefined {
		const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
		return row ? this.fromRow(row) : undefined;
	}

	list(q: { status?: TaskStatus; agent?: string; session?: string; limit?: number } = {}): Task[] {
		const where: string[] = [];
		const args: any[] = [];
		if (q.status) where.push("status = ?"), args.push(q.status);
		if (q.agent) where.push("agent = ?"), args.push(q.agent);
		if (q.session) where.push("session = ?"), args.push(q.session);
		const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
		return this.db.prepare(sql).all(...args, Math.min(q.limit ?? 50, 1000)).map((r) => this.fromRow(r));
	}

	/** Named sessions of an agent that have had tasks, most recently used first. */
	sessions(agent: string): Array<{ session: string; tasks: number; last: number }> {
		return (this.db.prepare("SELECT session, COUNT(*) AS tasks, MAX(created) AS last FROM tasks WHERE agent = ? AND session NOT LIKE '\\_t%' ESCAPE '\\' GROUP BY session ORDER BY last DESC").all(agent) as any[]).map((r) => ({ session: r.session, tasks: r.tasks, last: r.last }));
	}

	/** Delete everything said in these conversations of an agent, with all the work they started. */
	forget(agent: string, sessions: string[]): number {
		if (!sessions.length) return 0;
		const marks = sessions.map(() => "?").join(", ");
		const sql = `WITH RECURSIVE gone(id) AS (SELECT id FROM tasks WHERE agent = ? AND session IN (${marks}) UNION SELECT t.id FROM tasks t JOIN gone g ON t.parent = g.id) DELETE FROM tasks WHERE id IN (SELECT id FROM gone)`;
		return Number(this.db.prepare(sql).run(agent, ...sessions).changes);
	}

	/** Give a conversation's tasks another conversation name. */
	rename(agent: string, from: string, to: string): void {
		this.db.prepare("UPDATE tasks SET session = ? WHERE agent = ? AND session = ?").run(to, agent, from);
	}

	byStatus(status: TaskStatus): Task[] {
		return this.db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY id ASC").all(status).map((r) => this.fromRow(r));
	}

	private fromRow(r: any): Task {
		return {
			id: r.id, agent: r.agent, session: r.session, kind: r.kind, prompt: r.prompt, status: r.status, priority: r.priority, created: r.created,
			started: r.started ?? undefined, finished: r.finished ?? undefined, result: r.result ?? undefined, error: r.error ?? undefined,
			event: r.event ?? undefined, hops: r.hops, parent: r.parent ?? undefined, depth: r.depth, reply: parse(r.reply), meta: parse(r.meta) ?? {},
		};
	}
}
