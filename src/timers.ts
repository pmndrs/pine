import fs from "node:fs";
import path from "node:path";
import { loadConfig, type PineConfig, type RouteConfig, type ScheduleConfig } from "./config.ts";
import { editJson } from "./mcp-config.ts";
import type { Router } from "./router.ts";
import type { Bus, Kv } from "./store.ts";
import { errText, type Logger } from "./util.ts";

type Field = Set<number> | null; // null: any value

function parseField(expr: string, min: number, max: number): Field {
	if (expr === "*") return null;
	const out = new Set<number>();
	for (const part of expr.split(",")) {
		const m = part.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
		if (!m) throw new Error(`invalid cron field "${expr}"`);
		const step = m[3] ? Number(m[3]) : 1;
		const from = m[1] === "*" ? min : Number(m[1]);
		const to = m[1] === "*" ? max : m[2] !== undefined ? Number(m[2]) : m[3] ? max : from;
		if (from < min || to > max || from > to || step < 1) throw new Error(`cron field "${expr}" out of range ${min}-${max}`);
		for (let v = from; v <= to; v += step) out.add(v);
	}
	return out;
}

/** Five fields: minute hour day-of-month month day-of-week (0 or 7 is Sunday). Local time. */
export function parseCron(expr: string): (d: Date) => boolean {
	const f = expr.trim().split(/\s+/);
	if (f.length !== 5) throw new Error(`cron expression needs 5 fields: "${expr}"`);
	const minute = parseField(f[0], 0, 59);
	const hour = parseField(f[1], 0, 23);
	const dom = parseField(f[2], 1, 31);
	const month = parseField(f[3], 1, 12);
	const dowRaw = parseField(f[4], 0, 7);
	const dow = dowRaw && new Set([...dowRaw].map((d) => d % 7));
	return (d) => {
		if (minute && !minute.has(d.getMinutes())) return false;
		if (hour && !hour.has(d.getHours())) return false;
		if (month && !month.has(d.getMonth() + 1)) return false;
		const domOk = !dom || dom.has(d.getDate());
		const dowOk = !dow || dow.has(d.getDay());
		// As in cron: when both day fields are restricted, either may match.
		return dom && dow ? domOk || dowOk : domOk && dowOk;
	};
}

const minuteOf = (ms: number) => Math.floor(ms / 60_000);
/** A moment as it is written into a file and shown to people: local time, to the minute or second. */
export const localTime = (ms: number) => {
	const d = new Date(ms);
	const two = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}${d.getSeconds() ? `:${two(d.getSeconds())}` : ""}`;
};
const span = (ms: number) => (ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : ms % 60_000 === 0 ? `${ms / 60_000}m` : ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`);
/** When a schedule fires, in words. */
export const whenText = (s: Pick<ScheduleConfig, "cron" | "every" | "at">) => (s.cron ? `at the times "${s.cron}" (minute hour day month weekday)` : s.every ? `every ${span(s.every)}` : `once, at ${localTime(s.at!).replace("T", " ")}`);

export interface ScheduleInfo {
	name: string;
	/** "global", or the agent it belongs to. */
	scope: string;
	/** The conversation it wakes, for an agent's own. */
	session?: string;
	when: string;
	task?: string;
	/** The next time it fires, if that can be said. */
	next?: number;
	topic: string;
}

interface Entry {
	key: string;
	name: string;
	scope: string;
	s: ScheduleConfig;
}

/**
 * The scheduler: everything in pine that happens because of the time.
 *
 * A schedule fires at set times (cron), every so often, or once. Firing publishes an event on
 * `timer/<name>` (`timer/<name>@<agent>` for an agent's own). A schedule with a task also wakes
 * whoever it is for with that task: one conversation of an agent, an agent's main conversation,
 * or every agent. Schedules are made by the owner, in the files or by asking an agent, so what
 * they start counts as the owner's wish.
 */
export class Scheduler {
	private cfg: PineConfig;
	private bus: Bus;
	private kv: Kv;
	private router?: Router;
	private log: Logger;
	private handles: NodeJS.Timeout[] = [];
	private routes: string[] = [];
	private crons = new Map<string, (d: Date) => boolean>();

	constructor(cfg: PineConfig, bus: Bus, kv: Kv, log: Logger, router?: Router) {
		this.cfg = cfg;
		this.bus = bus;
		this.kv = kv;
		this.log = log;
		this.router = router;
	}

	/** Every schedule with its key: those for all agents by name, an agent's own as name@agent. */
	private all(): Entry[] {
		return [...this.cfg.schedules.map((s) => ({ key: s.name, name: s.name, scope: "global", s })), ...Object.values(this.cfg.agents).flatMap((a) => a.schedules.map((s) => ({ key: `${s.name}@${a.id}`, name: s.name, scope: a.id, s })))];
	}

	private match(expr: string): (d: Date) => boolean {
		let m = this.crons.get(expr);
		if (!m) this.crons.set(expr, (m = parseCron(expr)));
		return m;
	}

	start(): void {
		const now = minuteOf(Date.now());
		for (const e of this.all()) {
			const last = this.kv.get<number>(`timer:${e.key}`);
			if (!e.s.cron || !e.s.catchUp || last === undefined) continue;
			for (let m = Math.max(last + 1, now - 7 * 24 * 60); m < now; m++) {
				if (!this.match(e.s.cron)(new Date(m * 60_000))) continue;
				this.log.info(`schedule ${e.key}: catching up a run missed at ${new Date(m * 60_000).toISOString()}`);
				this.fire(e, m * 60_000, true);
				break;
			}
		}
		this.wire();
		this.arm();
	}

	stop(): void {
		for (const h of this.handles) clearTimeout(h);
		this.handles = [];
		for (const name of this.routes) this.router?.remove(name);
		this.routes = [];
	}

	/** A schedule with a task wakes whoever it is for: the routes that do so, rebuilt whenever a schedule or the list of agents changes. */
	private wire(): void {
		if (!this.router) return;
		for (const name of this.routes) this.router.remove(name);
		this.routes = [];
		for (const e of this.all()) {
			if (!e.s.task) continue;
			for (const agent of e.scope === "global" ? Object.keys(this.cfg.agents) : [e.scope]) {
				const route: RouteConfig = {
					name: `schedule:${agent}:${e.key}`,
					on: [e.s.topic],
					agent,
					session: e.s.session ?? "main",
					// The task as it was written, and a word on it when it comes late. Not a template of its own: braces in a task stay braces.
					prompt: "{{payload.task}}{{payload.note}}",
					preface: `[It is time for your schedule "${e.name}" (${whenText(e.s)}). It was set up at your owner's wish, and this is what it says to do now. If there is nothing to do or to tell, say so in one line.]`,
					label: `schedule: ${e.name}`,
					trust: "owner",
				};
				this.router.add(route);
				this.routes.push(route.name);
			}
		}
	}

	/** Set the clocks: one look every quarter minute for the cron times, an interval for each "every", a timeout for each "at". */
	private arm(): void {
		for (const h of this.handles) clearTimeout(h);
		this.handles = [];
		const entries = this.all();
		const tick = () => {
			const now = Date.now();
			for (const e of this.all()) {
				if (!e.s.cron || this.kv.get<number>(`timer:${e.key}`) === minuteOf(now) || !this.match(e.s.cron)(new Date(now))) continue;
				this.fire(e, now, false);
			}
		};
		if (entries.some((e) => e.s.cron)) {
			tick();
			this.handles.push(setInterval(tick, 15_000));
		}
		for (const e of entries.filter((x) => x.s.every)) this.handles.push(setInterval(() => this.fire(e, Date.now(), false), e.s.every));
		for (const e of entries.filter((x) => x.s.at !== undefined)) {
			const due = () => {
				const wait = e.s.at! - Date.now();
				// A timeout cannot be longer than about 24 days; one further away is looked at again then.
				if (wait > 2 ** 31 - 1) return void this.handles.push(setTimeout(due, 2 ** 31 - 1).unref());
				this.handles.push(
					setTimeout(() => {
						if (!this.all().some((x) => x.key === e.key && x.s === e.s)) return;
						// More than a minute after its time: pine was not running then.
						this.fire(e, e.s.at!, Date.now() - e.s.at! > 60_000);
						this.drop(e.scope === "global" ? undefined : e.scope, e.name);
					}, Math.max(0, wait)).unref(),
				);
			};
			due();
		}
		for (const h of this.handles) h.unref?.();
	}

	private fire(e: Entry, at: number, late: boolean): void {
		const s = e.s;
		this.kv.set(`timer:${e.key}`, minuteOf(Date.now()));
		const extra = s.payload && typeof s.payload === "object" && !Array.isArray(s.payload) ? s.payload : s.payload !== undefined ? { value: s.payload } : {};
		const note = late ? `\n\n(This was due at ${localTime(at).replace("T", " ")} and comes late: pine was not running then.)` : undefined;
		this.bus.publish(s.topic, { name: s.name, scheduled: new Date(at).toISOString(), late: late || undefined, ...(s.task ? { task: s.task, note } : {}), ...extra }, { source: "timer", trust: "owner" });
	}

	/** The next time a schedule fires. For an interval, counted from now. */
	private next(e: Entry): number | undefined {
		if (e.s.at !== undefined) return e.s.at;
		if (e.s.every) return Date.now() + e.s.every;
		const match = this.match(e.s.cron!);
		const start = minuteOf(Date.now()) + 1;
		// Far enough for anything a cron line can say, leap days aside.
		for (let m = start; m < start + 366 * 24 * 60; m++) if (match(new Date(m * 60_000))) return m * 60_000;
		return undefined;
	}

	private info(e: Entry): ScheduleInfo {
		return { name: e.name, scope: e.scope, session: e.scope === "global" ? undefined : (e.s.session ?? "main"), when: whenText(e.s), task: e.s.task, next: this.next(e), topic: e.s.topic };
	}

	list(): ScheduleInfo[] {
		return this.all().map((e) => this.info(e));
	}

	/** What one agent has: its own schedules, in whichever conversation, and those for all agents that carry a task. */
	available(agentId: string): ScheduleInfo[] {
		return this.all().filter((e) => e.scope === agentId || (e.scope === "global" && e.s.task)).map((e) => this.info(e));
	}

	/** Check a schedule that is to be added, before anybody is asked: its name, and that its times can be read. Returns it as it goes into the file. */
	check(raw: { name: string; task: string; cron?: string; every?: string; at?: string | number; session?: string }): Record<string, unknown> {
		const name = String(raw.name ?? "").trim();
		if (!/^[a-z][a-z0-9_-]{0,39}$/.test(name)) throw new Error(`"${name}" is not a usable name: lowercase letters, digits, - and _, starting with a letter (for example morning, dentist)`);
		if (this.all().some((e) => e.name === name)) throw new Error(`a schedule named "${name}" exists already; pick another name, or remove that one first`);
		const task = String(raw.task ?? "").trim();
		if (!task) throw new Error(`a schedule needs a "task": what you are to do when it is time, written so that it is enough on its own`);
		if (task.length > 4000) throw new Error("that task is too long for a schedule (4000 characters at most). Write the procedure down as a skill and name it in the task");
		if (raw.cron) parseCron(raw.cron);
		return { name, ...(raw.cron ? { cron: raw.cron.trim() } : {}), ...(raw.every ? { every: raw.every } : {}), ...(raw.at !== undefined ? { at: typeof raw.at === "number" ? localTime(raw.at) : raw.at } : {}), task, ...(raw.session && raw.session !== "main" ? { session: raw.session } : {}) };
	}

	private file = (agentId?: string) => (agentId ? path.join(this.cfg.agents[agentId].dir, "agent.json") : path.join(this.cfg.home, "pine.json"));

	/**
	 * Add a schedule while pine runs: to one agent's agent.json, or to pine.json for all agents.
	 * The file is written and read back through the normal loader, so it is checked like one that
	 * was there at the start; if it does not pass, the file is put back as it was.
	 */
	add(agentId: string | undefined, entry: Record<string, unknown>): ScheduleInfo {
		const agent = agentId ? this.cfg.agents[agentId] : undefined;
		if (agentId && !agent) throw new Error(`unknown agent "${agentId}"`);
		const file = this.file(agentId);
		const before = fs.readFileSync(file, "utf8");
		editJson(file, (json) => {
			json.schedules = [...(Array.isArray(json.schedules) ? json.schedules : []), entry];
		});
		let fresh: PineConfig;
		try {
			fresh = loadConfig(this.cfg.home);
		} catch (e) {
			fs.writeFileSync(file, before);
			throw new Error(errText(e).replace(/^[\s\S]*?schedules\[\d+\]: /, ""));
		}
		const list = agent ? fresh.agents[agent.id].schedules : fresh.schedules;
		const made = list.find((s) => s.name === entry.name)!;
		if (agent) agent.schedules.push(made);
		else this.cfg.schedules.push(made);
		this.wire();
		this.arm();
		this.log.info(`schedule ${made.name} added ${agent ? `for ${agent.id}${made.session ? `/${made.session}` : ""}` : "for all agents"} (${whenText(made)})`);
		return this.info({ key: agent ? `${made.name}@${agent.id}` : made.name, name: made.name, scope: agent?.id ?? "global", s: made });
	}

	/** Take a schedule out of the configuration, leaving the file as it was before it was added. */
	private drop(agentId: string | undefined, name: string): boolean {
		const agent = agentId ? this.cfg.agents[agentId] : undefined;
		const list = agent ? agent.schedules : this.cfg.schedules;
		const at = list.findIndex((s) => s.name === name);
		if (at < 0) return false;
		list.splice(at, 1);
		editJson(this.file(agentId), (json) => {
			json.schedules = (Array.isArray(json.schedules) ? json.schedules : []).filter((s: any) => s?.name !== name);
			if (!json.schedules.length) delete json.schedules;
		});
		this.kv.set(`timer:${agent ? `${name}@${agent.id}` : name}`, null);
		this.wire();
		return true;
	}

	remove(agentId: string | undefined, name: string): boolean {
		const done = this.drop(agentId, name);
		if (done) {
			this.arm();
			this.log.info(`schedule ${name} removed ${agentId ? `from ${agentId}` : "for all agents"}`);
		}
		return done;
	}

	/** A conversation was removed: what was scheduled for it alone goes with it. */
	closeSession(agentId: string, session: string): string[] {
		const names = (this.cfg.agents[agentId]?.schedules ?? []).filter((s) => s.session === session).map((s) => s.name);
		for (const name of names) this.drop(agentId, name);
		if (names.length) this.arm();
		return names;
	}

	/** A conversation got another name: its schedules follow it. */
	renameSession(agentId: string, from: string, to: string): void {
		const agent = this.cfg.agents[agentId];
		if (!agent?.schedules.some((s) => s.session === from)) return;
		editJson(this.file(agentId), (json) => {
			for (const s of Array.isArray(json.schedules) ? json.schedules : []) if (s?.session === from) s.session = to;
		});
		for (const s of agent.schedules) if (s.session === from) s.session = to;
		this.wire();
	}

	/** Agents were added or removed: whom a schedule for all agents wakes has changed. */
	agentsChanged(): void {
		this.wire();
	}
}
