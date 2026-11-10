import type { PineConfig, ScheduleConfig } from "./config.ts";
import type { Bus, Kv } from "./store.ts";
import type { Logger } from "./util.ts";

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

/** Publishes `timer/<name>` events from the `schedules` section. Schedules are written by the owner, so the events are trusted. */
export class Timers {
	private cfg: PineConfig;
	private bus: Bus;
	private kv: Kv;
	private log: Logger;
	private handles: NodeJS.Timeout[] = [];

	constructor(cfg: PineConfig, bus: Bus, kv: Kv, log: Logger) {
		this.cfg = cfg;
		this.bus = bus;
		this.kv = kv;
		this.log = log;
	}

	start(): void {
		const crons = this.cfg.schedules.filter((s) => s.cron).map((s) => ({ s, match: parseCron(s.cron!) }));
		for (const { s, match } of crons) {
			const last = this.kv.get<number>(`timer:${s.name}`);
			if (s.catchUp && last !== undefined) {
				const now = minuteOf(Date.now());
				for (let m = Math.max(last + 1, now - 7 * 24 * 60); m < now; m++) {
					if (!match(new Date(m * 60_000))) continue;
					this.log.info(`schedule ${s.name}: catching up a run missed at ${new Date(m * 60_000).toISOString()}`);
					this.fire(s, m * 60_000, true);
					break;
				}
			}
		}
		const tick = () => {
			const now = Date.now();
			for (const { s, match } of crons) {
				if (this.kv.get<number>(`timer:${s.name}`) === minuteOf(now) || !match(new Date(now))) continue;
				this.fire(s, now, false);
			}
		};
		if (crons.length) {
			tick();
			this.handles.push(setInterval(tick, 15_000));
		}
		for (const s of this.cfg.schedules.filter((x) => x.every)) this.handles.push(setInterval(() => this.fire(s, Date.now(), false), s.every));
		for (const h of this.handles) h.unref?.();
	}

	stop(): void {
		for (const h of this.handles) clearInterval(h);
		this.handles = [];
	}

	fire(s: ScheduleConfig, at: number, late: boolean): void {
		this.kv.set(`timer:${s.name}`, minuteOf(Date.now()));
		const extra = s.payload && typeof s.payload === "object" && !Array.isArray(s.payload) ? s.payload : s.payload !== undefined ? { value: s.payload } : {};
		this.bus.publish(s.topic, { name: s.name, scheduled: new Date(at).toISOString(), late: late || undefined, ...extra }, { source: "timer", trust: "owner" });
	}
}
