// What the source types that look at something again and again (http, command) have in common:
// picking the part that counts out of what they got, and saying what changed in it.

const LINES = 30;
const LINE = 300;
const VALUE = 4000;

export const clip = (s: string, n = VALUE) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A value as an event carries it: text and large structures cut to a sensible length. */
export function shown(value: unknown): unknown {
	if (typeof value === "string") return clip(value);
	const json = JSON.stringify(value) ?? "null";
	return json.length > VALUE ? clip(json) : value;
}

/**
 * A value as a status line may say it. A status line is read by agents without the mark that
 * outside content gets, so it only repeats what cannot carry a sentence: a number, an amount, one word.
 */
export function harmless(value: unknown): string {
	if (value === null || value === undefined) return "nothing";
	const s = typeof value === "string" ? value : JSON.stringify(value);
	return /^[\d.,:%€$£+\- ]{1,24}$/.test(s) || /^[\w.-]{1,32}$/.test(s) ? s : `a value of ${s.length} characters`;
}

/** A regular expression an agent or owner wrote, or an error that says what is wrong with it. */
export function pattern(source: string): RegExp {
	try {
		return new RegExp(source, "m");
	} catch (e) {
		throw new Error(`"match" is not a regular expression: ${e instanceof Error ? e.message : e}`);
	}
}

/** What a pattern finds in a text: its first group if it has one, else the whole match. Nothing found is null. */
export function found(re: RegExp, text: string): string | null {
	const m = re.exec(text);
	return m ? clip((m[1] ?? m[0]).trim()) : null;
}

/** The lines that are new and the lines that are gone between two texts, a handful of each. */
export function lineDiff(before: string, now: string): { added: string[]; removed: string[]; more?: number } {
	const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
	const a = lines(before);
	const b = lines(now);
	const had = new Set(a);
	const has = new Set(b);
	const added = b.filter((l) => !had.has(l));
	const removed = a.filter((l) => !has.has(l));
	const more = Math.max(0, added.length - LINES) + Math.max(0, removed.length - LINES);
	return { added: added.slice(0, LINES).map((l) => clip(l, LINE)), removed: removed.slice(0, LINES).map((l) => clip(l, LINE)), ...(more ? { more } : {}) };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", euro: "€", pound: "£", copy: "©", ndash: "–", mdash: "—", hellip: "…" };

/** What a reader of a web page sees, line by line: no scripts, no styles, no markup. */
export function pageText(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<(br|hr)\b[^>]*>|<\/(p|div|li|tr|h[1-6]|section|article|table|ul|ol|dd|dt|header|footer|main|nav|blockquote|pre|title)\s*>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, name: string) => {
			if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? all;
			const code = name[1].toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
		})
		.split("\n")
		.map((l) => l.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.join("\n");
}
