import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function expandHome(p: string): string {
	return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Resolve a config path: `~` expands, relative paths are relative to `base`. */
export function resolvePath(p: string, base: string): string {
	const e = expandHome(p);
	return path.isAbsolute(e) ? e : path.resolve(base, e);
}

/** MQTT-style topic match: `+` is one level, a trailing `#` is the rest (including nothing). */
export function topicMatches(pattern: string, topic: string): boolean {
	if (pattern === "#" || pattern === topic) return true;
	const p = pattern.split("/");
	const t = topic.split("/");
	for (let i = 0; i < p.length; i++) {
		if (p[i] === "#") return i === p.length - 1;
		if (i >= t.length) return false;
		if (p[i] !== "+" && p[i] !== t[i]) return false;
	}
	return p.length === t.length;
}

export const matchesAny = (patterns: readonly string[], topic: string) => patterns.some((p) => topicMatches(p, topic));

export function getPath(obj: unknown, dotted: string): unknown {
	let cur: any = obj;
	for (const key of dotted.split(".")) {
		if (cur == null) return undefined;
		cur = cur[key];
	}
	return cur;
}

const asText = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** Replace `{{a.b}}` with values from `ctx`. Objects render as JSON, missing values as "". */
export function render(template: string, ctx: unknown): string {
	return template.replace(/\{\{\s*([\w.$/-]+)\s*\}\}/g, (_m, p) => asText(getPath(ctx, p)));
}

/** Render every string inside a JSON-like value. A string that is exactly one `{{path}}` keeps the value's type. */
export function renderDeep(value: unknown, ctx: unknown): unknown {
	if (typeof value === "string") {
		const whole = value.match(/^\{\{\s*([\w.$/-]+)\s*\}\}$/);
		return whole ? getPath(ctx, whole[1]) : render(value, ctx);
	}
	if (Array.isArray(value)) return value.map((v) => renderDeep(v, ctx));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, ctx)]));
	return value;
}

/**
 * Declarative filter. Keys are dotted paths into `ctx`; a plain value means equality, an object
 * may use eq, ne, in, gt, gte, lt, lte, exists, contains, regex. All keys must match.
 */
export function matchWhen(when: Record<string, unknown> | undefined, ctx: unknown): boolean {
	if (!when) return true;
	for (const [key, cond] of Object.entries(when)) {
		const v = getPath(ctx, key) as any;
		if (cond === null || typeof cond !== "object" || Array.isArray(cond)) {
			if (JSON.stringify(v) !== JSON.stringify(cond)) return false;
			continue;
		}
		const c = cond as Record<string, any>;
		if ("eq" in c && JSON.stringify(v) !== JSON.stringify(c.eq)) return false;
		if ("ne" in c && JSON.stringify(v) === JSON.stringify(c.ne)) return false;
		if ("in" in c && !(Array.isArray(c.in) && c.in.some((x: unknown) => JSON.stringify(x) === JSON.stringify(v)))) return false;
		if ("gt" in c && !(v > c.gt)) return false;
		if ("gte" in c && !(v >= c.gte)) return false;
		if ("lt" in c && !(v < c.lt)) return false;
		if ("lte" in c && !(v <= c.lte)) return false;
		if ("exists" in c && (v !== undefined && v !== null) !== Boolean(c.exists)) return false;
		if ("contains" in c && !(typeof v === "string" || Array.isArray(v) ? v.includes(c.contains) : false)) return false;
		if ("regex" in c && !(typeof v === "string" && new RegExp(c.regex, c.flags ?? "").test(v))) return false;
	}
	return true;
}

/** "90s", "15m", "2h", "1d" or a number of milliseconds. */
export function parseDuration(v: string | number): number {
	if (typeof v === "number") return v;
	const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
	if (!m) throw new Error(`invalid duration: ${v}`);
	return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? "ms"]!;
}

/** A string that is safe as one path component: no dots, no separators, never empty. */
export const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80) || "_";

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s);

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
const LEVELS: LogLevel[] = ["debug", "info", "warn", "error", "silent"];

export interface Logger {
	debug(msg: string, extra?: unknown): void;
	info(msg: string, extra?: unknown): void;
	warn(msg: string, extra?: unknown): void;
	error(msg: string, extra?: unknown): void;
	child(scope: string): Logger;
}

export function createLogger(level: LogLevel = "info", scope = "pine", sink: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): Logger {
	const min = LEVELS.indexOf(level);
	const emit = (lvl: LogLevel) => (msg: string, extra?: unknown) => {
		if (LEVELS.indexOf(lvl) < min) return;
		const tail = extra === undefined ? "" : ` ${extra instanceof Error ? (extra.stack ?? extra.message) : typeof extra === "string" ? extra : JSON.stringify(extra)}`;
		sink(`${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${msg}${tail}`);
	};
	return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error"), child: (s) => createLogger(level, `${scope}:${s}`, sink) };
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Hand a file or a web address to the system: the program the owner set for it opens it. Only ever on the owner's click. */
export function openInSystem(target: string): void {
	spawn(process.platform === "darwin" ? "open" : "xdg-open", [target], { stdio: "ignore", detached: true })
		.on("error", () => {})
		.unref();
}
