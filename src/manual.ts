import fs from "node:fs";
import path from "node:path";

// pine's manual, made searchable.
//
// An agent has to know pine well: its tools, its configuration, what a source type takes, what
// asks the owner and why. All of that is written down in docs/, about 200 KB of it, and none of
// it belongs into every prompt. So the manual is cut into small parts (one per heading, and one
// per row of a table that describes a key, a tool or a command), and an agent searches them:
// a few ranked parts with the line that matched, then the one part it needs.
//
// Ranking is BM25 over four fields of a part (its title, the headings above it, the code terms
// in it, its text). Words an agent would use and the manual does not ("cron job", "reminder",
// "permission") reach the manual's own words through a list of synonyms, which count half.
// A part that matches only some of the words keeps that share of its score.

export interface Part {
	/** What it is read by: "sources#telegram", or "configuration#agent-json/globalmcp" for a row. */
	id: string;
	kind: "section" | "row";
	/** The file it is from, without ".md". */
	file: string;
	/** The headings it stands under, its own last. */
	path: string[];
	title: string;
	text: string;
	/** For a section: the sections directly under it. */
	children: string[];
	/** Counts for more than its words alone: what this installation really has, against what the manual gives as an example. */
	boost?: number;
	/** What it is, for a part that is not from the manual's files ("registered in this pine"). */
	note?: string;
}

/** Words that say the same thing in pine. Each line is one group; a word of a group finds the others, at half weight. */
const SYNONYMS: string[][] = [
	["schedule", "cron", "timer", "reminder", "remind", "alarm", "recurring", "periodic", "daily", "hourly", "interval", "heartbeat", "clock", "time"],
	["source", "watch", "monitor", "observe", "listen", "trigger", "event", "sensor", "feed"],
	["subscribe", "subscription", "listen", "follow", "wake", "notify", "notification"],
	["unsubscribe", "stop", "mute", "silence"],
	["mcp", "server", "connector", "integration", "plugin", "extension", "tool"],
	["skill", "procedure", "howto", "recipe", "playbook", "instruction", "knowhow"],
	["secret", "token", "password", "key", "credential", "apikey", "env"],
	["approve", "approval", "permission", "confirm", "consent", "ask", "allow", "deny", "dialog", "prompt", "question"],
	["sandbox", "isolation", "confine", "restrict", "jail", "permission", "access"],
	["conversation", "session", "tab", "chat", "thread"],
	["undo", "redo", "revert", "rollback", "rewind", "restore", "checkpoint", "snapshot", "unsend", "mistake"],
	["taint", "tainted", "outside", "untrusted", "injection", "external", "hostile"],
	["trust", "owner", "trusted", "yours"],
	["scope", "local", "global"],
	["global", "everyone", "all", "shared", "every"],
	["agent", "assistant", "bot", "persona"],
	["subagent", "delegate", "delegation", "handoff", "child", "spawn"],
	["model", "llm", "provider", "inference", "endpoint"],
	["telegram", "messenger", "phone", "chat", "bot"],
	["pair", "pairing", "link", "connect", "bind"],
	["webhook", "hook", "callback", "http", "post"],
	["http", "url", "website", "web", "page", "site", "address", "poll", "scrape"],
	["command", "shell", "bash", "script", "terminal", "cli"],
	["background", "detach", "async", "asynchronous", "nohup", "meanwhile", "wait", "await", "blocking"],
	["folder", "directory", "dir", "path", "file"],
	["mqtt", "broker", "iot", "device", "topic", "publish"],
	["send", "message", "notify", "reply", "answer", "push", "output"],
	["memory", "remember", "note", "persist", "recall"],
	["instruction", "persona", "soul", "prompt", "system", "identity", "rule"],
	["config", "configuration", "setting", "option", "json", "setup", "configure"],
	["install", "setup", "init", "start", "launch", "run", "boot", "service", "daemon"],
	["remove", "delete", "uninstall", "drop", "clear"],
	["speed", "fast", "slow", "tps", "throughput", "performance"],
	["add", "create", "new", "register", "make", "define"],
	["list", "show", "status", "overview", "inspect"],
	["mode", "auto", "safe", "manual", "bypass", "autonomy"],
	["container", "docker", "podman", "kubernetes"],
	["goal", "objective", "target", "aim", "mission", "autonomous", "autonomously", "unattended", "nonstop", "overnight"],
	["error", "problem", "fail", "broken", "troubleshoot", "debug", "wrong", "stuck"],
	["log", "history", "audit", "record", "trace"],
	["image", "picture", "photo", "screenshot", "video", "media"],
	["sound", "audio", "speech", "voice", "music", "hear", "wav", "mp3"],
	["dictate", "dictating", "dictation", "microphone", "talk", "talking", "speak", "speaking"],
	["browser", "web", "playwright", "page", "search"],
	["show", "visible", "headed", "headless", "window", "watch", "see"],
	["plan", "propose", "proposal", "outline", "preview", "dry"],
	["todo", "step", "checklist", "track", "progress", "tasklist"],
	["question", "choose", "choice", "decide", "decision", "pick", "option"],
	["export", "save", "transcript", "markdown", "copy"],
	["notify", "notification", "bell", "sound", "alert", "ping", "finished", "done"],
	["compact", "shorten", "summarise", "summarize", "full"],
	["app", "application", "program", "desktop", "mac", "macos", "computer", "gui", "native"],
	["click", "press", "tap", "mouse", "pointer", "button", "control", "operate", "drive", "automate"],
	["type", "typing", "keystroke", "hotkey", "shortcut", "keyboard"],
	["accessibility", "outline", "snapshot", "grant", "privacy"],
	["code", "repository", "repo", "git", "diff", "project"],
	["route", "rule", "pipeline", "automation"],
	["state", "variable", "store", "value"],
	["limit", "quota", "budget", "timeout", "throttle", "debounce", "rate"],
	["network", "internet", "online", "egress"],
	["read", "write", "edit", "access", "permission"],
	["ui", "tui", "interface", "terminal", "screen", "keyboard", "shortcut", "key"],
	["type", "kind", "module", "custom", "own"],
];

const SYNONYM_MAP = new Map<string, Set<string>>();

const STOP = new Set(
	"a an the and or of to in on for with by is are be how do does i my me it its that this from as at into onto via can could should would will what which when where who why you your we our there here if then than so not no yes get got use using make want need about have has mean means meaning explain tell please exactly actually just set up one thing things happen happens some any each also".split(" "),
);

/** Words of a text: camelCase, snake_case and punctuation split, lowercased. */
function words(text: string): string[] {
	return String(text ?? "")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/** A word without its ending, so that subscribe, subscribes, subscribed and subscribing are one word. Rough, and the same for both sides. */
export function stem(word: string): string {
	let w = word;
	if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
	else if (w.length > 4 && /(x|ch|sh|ss)es$/.test(w)) w = w.slice(0, -2);
	else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) w = w.slice(0, -1);
	if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
	else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
	if (w.length > 3 && /([bdfglmnprt])\1$/.test(w)) w = w.slice(0, -1);
	if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
	return w;
}

for (const group of SYNONYMS) {
	const stems = group.map(stem);
	for (const s of stems) {
		const set = SYNONYM_MAP.get(s) ?? new Set<string>();
		for (const other of stems) if (other !== s) set.add(other);
		SYNONYM_MAP.set(s, set);
	}
}

const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/`/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "") || "x";

/** The first code term of a table cell, or the cell as it reads. */
const cellKey = (cell: string) => (/`([^`]+)`/.exec(cell)?.[1] ?? cell).trim();

/** Cut one Markdown file into its parts: a section per heading (three levels), a row per table line that describes a named thing. */
export function partsOf(file: string, source: string): Part[] {
	const out: Part[] = [];
	const taken = new Set<string>();
	const unique = (id: string) => {
		let n = id;
		for (let i = 2; taken.has(n); i++) n = `${id}-${i}`;
		taken.add(n);
		return n;
	};
	const lines = source.replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
	const stack: Part[] = [];
	let current: Part | undefined;
	let fenced = false;
	let table: { header: string[] } | undefined;
	const open = (level: number, title: string) => {
		while (stack.length >= level) stack.pop();
		const parent = stack.at(-1);
		const part: Part = { id: unique(level === 1 ? file : `${file}#${slug(title)}`), kind: "section", file, path: [...(parent?.path ?? []), title], title, text: "", children: [] };
		parent?.children.push(part.id);
		out.push(part);
		stack.push(part);
		current = part;
	};
	for (const line of lines) {
		if (/^\s*```/.test(line)) fenced = !fenced;
		const heading = fenced ? null : /^(#{1,3})\s+(.+?)\s*$/.exec(line);
		if (heading) {
			table = undefined;
			open(heading[1].length, heading[2].replace(/`/g, ""));
			continue;
		}
		if (!current) {
			// What stands before the first heading, if anything does.
			if (!line.trim()) continue;
			open(1, file);
		}
		current!.text += `${line}\n`;
		// A table row about a named thing (a key, a tool, a command) is also a part of its own.
		const cells = !fenced && /^\s*\|.*\|\s*$/.test(line) ? line.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim()) : undefined;
		if (!cells) {
			table = undefined;
			continue;
		}
		if (!table) {
			table = { header: cells };
			continue;
		}
		if (cells.every((c) => /^:?-+:?$/.test(c) || c === "")) continue;
		if (!/`[^`]+`/.test(cells[0]) || cells.length < 2) continue;
		const key = cellKey(cells[0]);
		const told = cells
			.slice(1)
			.map((c, i) => (c ? `${table!.header[i + 1] && !/^\s*$/.test(table!.header[i + 1]) ? `${table!.header[i + 1]}: ` : ""}${c}` : ""))
			.filter(Boolean)
			.join("\n");
		out.push({ id: unique(`${current!.id}${current!.id.includes("#") ? "/" : "#"}${slug(key)}`), kind: "row", file, path: [...current!.path, cells[0].replace(/`/g, "")], title: cells[0].replace(/`/g, ""), text: `${cells[0]}\n${told}\n`, children: [] });
	}
	for (const p of out) p.text = p.text.replace(/^\n+|\n+$/g, "");
	return out;
}

/** Read the manual from pine's docs folder: SKILL.md and everything in references/. */
export function loadManual(docsDir: string): Part[] {
	const refs = path.join(docsDir, "references");
	const files = [
		...(fs.existsSync(path.join(docsDir, "SKILL.md")) ? [["pine", path.join(docsDir, "SKILL.md")]] : []),
		...(fs.existsSync(refs) ? fs.readdirSync(refs).filter((f) => f.endsWith(".md")).sort().map((f) => [f.slice(0, -3), path.join(refs, f)]) : []),
	];
	return files.flatMap(([name, file]) => partsOf(name, fs.readFileSync(file, "utf8")));
}

interface Indexed {
	part: Part;
	fields: Array<{ tf: Map<string, number>; len: number }>;
	/** Every two words that stand next to each other in it, and those of its title. */
	pairs: Set<string>;
	titlePairs: Set<string>;
	/** It names a tool an agent has: this is something the agent can do itself, not only something to tell its owner. */
	tool: boolean;
}

/** The names of the tools pine gives its agents, as the manual writes them. */
const TOOL = /^(?:(?:add|remove)_[a-z_]+|subscribe|unsubscribe|send|schedules|sources|manual|create_agent|update_agent|set_setting|agents|settings|routes|delegate|subagent|request_access|publish_event|state_[gs]et)$/;

/** title, the headings above, code terms, text: how much a hit in each counts, and how strongly its length is held against it. */
const FIELDS = [
	{ weight: 3, b: 0.4 },
	{ weight: 1.5, b: 0.4 },
	{ weight: 2, b: 0.6 },
	{ weight: 1, b: 0.75 },
];
const K1 = 1.2;
const PAGE = 6000;

export interface Hit {
	id: string;
	where: string;
	kind: Part["kind"];
	chars: number;
	note?: string;
	/** The line of the part that says most about the query. */
	line: string;
	score: number;
}

export interface Manual {
	parts: Part[];
	search(query: string, limit?: number): { query: string; total: number; hits: Hit[] };
	read(id: string): { part: Part; page: number; pages: number; text: string } | { unknown: string; near: string[] };
	contents(): string;
}

export function createManual(parts: Part[]): Manual {
	const tf = (list: string[]) => list.reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map<string, number>());
	// A name written in one piece ("bashTimeoutSec", "add_source") is also found when typed in one piece.
	const withJoined = (text: string) => [...words(text), ...(text.match(/[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+|[A-Z][a-z0-9]+)+/g) ?? []).map((t) => t.replace(/[^A-Za-z0-9]/g, "").toLowerCase())];
	const df = new Map<string, number>();
	const sums = FIELDS.map(() => 0);
	const index: Indexed[] = parts.map((part) => {
		const code = (part.text.match(/`[^`\n]{1,48}`/g) ?? []).join(" ");
		const texts = [withJoined(part.title), words(part.path.slice(0, -1).join(" ") + " " + part.file), withJoined(code), words(part.text)].map((list) => list.map(stem));
		const fields = texts.map((list) => ({ tf: tf(list), len: list.length }));
		for (const w of new Set(texts.flat())) df.set(w, (df.get(w) ?? 0) + 1);
		fields.forEach((f, i) => (sums[i] += f.len));
		const running = [...texts[0], ...texts[3]].filter((w) => !STOP.has(w));
		const pairs = new Set(running.slice(1).map((w, i) => `${running[i]} ${w}`));
		const heading = texts[0].filter((w) => !STOP.has(w));
		const titlePairs = new Set(heading.slice(1).map((w, i) => `${heading[i]} ${w}`));
		const tool = (part.text.match(/`[a-z_]+`/g) ?? []).some((c) => TOOL.test(c.slice(1, -1)));
		return { part, fields, pairs, titlePairs, tool };
	});
	const n = index.length || 1;
	const avg = sums.map((s) => s / n || 1);
	const idf = (w: string) => Math.log(1 + (n - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
	const byId = new Map(parts.map((p) => [p.id, p]));
	const where = (p: Part) => `${p.note ? p.file : `${p.file}.md`} › ${p.path.slice(p.path.length > 1 ? 1 : 0).join(" › ")}`;

	const score = (entry: Indexed, word: string) => {
		let combined = 0;
		entry.fields.forEach((f, i) => {
			const count = f.tf.get(word);
			if (count) combined += (FIELDS[i].weight * count) / (1 - FIELDS[i].b + (FIELDS[i].b * f.len) / avg[i]);
		});
		return combined ? (idf(word) * combined * (K1 + 1)) / (combined + K1) : 0;
	};

	/** What a part says about the query, in a line: for a row all of it, for a section the sentence in which most of the query's words stand. */
	const bestLine = (part: Part, own: Set<string>, all: Set<string>) => {
		const flat = (t: string) => t.replace(/\s+/g, " ").replace(/^\|\s*|\s*\|$/g, "").trim();
		const cut = (t: string) => (t.length > 300 ? `${t.slice(0, 298)}…` : t);
		if (part.kind === "row") return cut(flat(part.text.split("\n").join(" · ")));
		// The manual's lines are broken for reading; a sentence runs across them.
		const pieces: string[] = [];
		for (const block of part.text.split(/\n\s*\n/)) {
			const lines = block.split("\n").filter((l) => l.trim() && !/^\s*[|:\- ]+$/.test(l) && !l.trim().startsWith("```"));
			if (!lines.length) continue;
			// A table, a list or code: every line stands for itself. Running text: sentence by sentence.
			if (lines.some((l) => /^\s*(\||[-*] |\d+\. |>|[{}"\[\]]|\/\/)/.test(l)) || block.includes("```")) pieces.push(...lines.map(flat));
			else pieces.push(...flat(lines.join(" ")).split(/(?<=[.!?])\s+(?=[A-Z"`(\[])/));
		}
		let at = 0;
		let most = -1;
		pieces.forEach((piece, i) => {
			const seen = new Set(words(piece).map(stem));
			const hits = [...seen].reduce((n, w) => n + (own.has(w) ? 2 : all.has(w) ? 1 : 0), 0);
			if (hits > most) {
				most = hits;
				at = i;
			}
		});
		let line = pieces[at] ?? "";
		// One sentence is seldom the whole answer: what follows it comes along while there is room.
		for (let i = at + 1; i < pieces.length && line.length + pieces[i].length < 380; i++) line += ` ${pieces[i]}`;
		return line.length > 420 ? `${line.slice(0, 418)}…` : line;
	};

	return {
		parts,
		search(query, limit = 6) {
			const direct = [...new Set(words(query).filter((w) => !STOP.has(w)).map(stem))];
			if (!direct.length) return { query, total: 0, hits: [] };
			// [word, weight, the query word it stands for]
			const weighted: Array<[string, number, number]> = direct.map((w, i) => [w, 1, i]);
			// A name typed in one piece.
			const joined = query.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
			direct.forEach((w, i) => {
				for (const syn of SYNONYM_MAP.get(w) ?? []) if (!direct.includes(syn)) weighted.push([syn, 0.5, i]);
			});
			const terms = new Set(weighted.map(([w]) => w));
			const own = new Set(direct);
			const hits = index
				.map((entry) => {
					let total = 0;
					const own = new Set<number>();
					const viaSynonym = new Set<number>();
					for (const [w, weight, origin] of weighted) {
						const s = score(entry, w);
						if (!s) continue;
						total += weight * s;
						(weight === 1 ? own : viaSynonym).add(origin);
					}
					if (!total) return undefined;
					const covered = own.size + [...viaSynonym].filter((o) => !own.has(o)).length * 0.5;
					// Soft "and": a part that has half of the words keeps half of its score.
					total *= covered / direct.length;
					// A title that says what was asked, in the query's words or in the manual's own for them.
					const title = entry.fields[0].tf;
					const named = direct.filter((w) => title.has(w) || [...(SYNONYM_MAP.get(w) ?? [])].some((syn) => title.has(syn))).length;
					if (named === direct.length) total += direct.length === entry.fields[0].len ? 4 : 2.5;
					else total += (named / direct.length) * 1.5;
					if (joined.length > 5 && title.has(stem(joined))) total += 4;
					// A question in several words asks how something is; the section explains it, a row only names it.
					if (direct.length >= 3 && entry.part.kind === "section") total *= 1.25;
					// Two words asked for together and standing together ("all agents", "outside content") say more than each alone.
					// In a title they name the thing itself: "pine schedules", "code pane".
					for (let i = 1; i < direct.length; i++) {
						const pair = `${direct[i - 1]} ${direct[i]}`;
						if (entry.titlePairs.has(pair)) total += 4;
						else if (entry.pairs.has(pair)) total += 1.2;
					}
					// Whoever searches here is an agent: what it can do with a tool of its own comes before what it can only pass on.
					if (entry.tool) total *= 1.15;
					total *= entry.part.boost ?? 1;
					return { entry, total };
				})
				.filter((x): x is { entry: Indexed; total: number } => Boolean(x))
				.sort((a, b) => b.total - a.total || a.entry.part.id.length - b.entry.part.id.length || a.entry.part.id.localeCompare(b.entry.part.id));
			// A row and the section it stands in say the same thing twice: the better one of the two is enough.
			const shown: typeof hits = [];
			for (const h of hits) {
				const p = h.entry.part;
				const sectionOf = (x: Part) => (x.kind === "row" ? x.id.slice(0, x.id.lastIndexOf(x.id.includes("/") ? "/" : "#")) : x.id);
				if (shown.some((s) => s.entry.part.kind !== p.kind && sectionOf(s.entry.part) === sectionOf(p))) continue;
				// What is far behind the best is noise: a part that only shares one common word with the query.
				if (shown.length && h.total < hits[0].total * 0.3) break;
				shown.push(h);
				if (shown.length >= limit) break;
			}
			return { query, total: hits.length, hits: shown.map(({ entry, total }) => ({ id: entry.part.id, where: where(entry.part), kind: entry.part.kind, chars: entry.part.text.length, note: entry.part.note, line: bestLine(entry.part, own, terms), score: Math.round(total * 100) / 100 })) };
		},
		read(wanted) {
			const m = /^(.*?)(?:@(\d+))?$/.exec(String(wanted ?? "").trim())!;
			const raw = m[1].replace(/\.md(?=#|$)/, "");
			const lower = raw.toLowerCase();
			const part = byId.get(raw) ?? byId.get(lower) ?? (() => {
				// Only the last piece given ("telegram"): fine when one part ends that way.
				const tail = parts.filter((p) => p.id.split(/[#/]/).at(-1) === slug(lower));
				const sections = tail.filter((p) => p.kind === "section");
				return sections.length === 1 ? sections[0] : tail.length === 1 ? tail[0] : undefined;
			})();
			if (!part) {
				const want = slug(lower.split(/[#/]/).at(-1) ?? lower);
				const near = parts.filter((p) => p.id.includes(want) || (p.id.split(/[#/]/).at(-1)!.length > 3 && want.includes(p.id.split(/[#/]/).at(-1)!))).slice(0, 8).map((p) => p.id);
				return { unknown: wanted, near };
			}
			const pages = paginate(part.text, PAGE);
			const page = Math.min(pages.length, Math.max(1, Number(m[2] ?? 1)));
			return { part, page, pages: pages.length, text: pages[page - 1] };
		},
		contents() {
			const tops = parts.filter((p) => p.kind === "section" && p.path.length === 1);
			return tops.map((t) => `${t.id}: ${t.title}\n${t.children.map((c) => `    ${c}`).join("\n")}`).join("\n");
		},
	};
}

let cached: { stamp: string; manual: Manual } | undefined;

/**
 * pine's manual, read once and again only when a file of it has changed. `extra` are parts that
 * are not in the files: what this installation has beyond the manual, such as source types of its own.
 */
export function pineManual(docsDir: string, extra: Part[] = []): Manual {
	const refs = path.join(docsDir, "references");
	const stamp = [path.join(docsDir, "SKILL.md"), ...(fs.existsSync(refs) ? fs.readdirSync(refs).map((f) => path.join(refs, f)) : [])].map((f) => `${f}:${fs.statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0}`).join("|");
	if (!cached || cached.stamp !== stamp) cached = { stamp, manual: createManual(loadManual(docsDir)) };
	return extra.length ? createManual([...cached.manual.parts, ...extra]) : cached.manual;
}

/** Cut a long text into pages at a blank line, so that a paragraph or a table row stays whole where it can. */
function paginate(text: string, size: number): string[] {
	const pages: string[] = [];
	let rest = text;
	while (rest.length > size) {
		const window = rest.slice(0, size);
		let cut = window.lastIndexOf("\n\n");
		if (cut < size * 0.4) cut = window.lastIndexOf("\n");
		if (cut <= 0) cut = size;
		pages.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n+/, "");
	}
	pages.push(rest);
	return pages;
}

/** What a search answers with, as text for a model or a shell. */
export function showSearch(manual: Manual, queries: string[], limit = 6): string {
	const out: string[] = [];
	for (const q of queries) {
		const r = manual.search(q, queries.length > 1 ? Math.min(limit, 4) : limit);
		if (!r.hits.length) {
			out.push(`"${q}": nothing in the manual has these words. That does not mean pine cannot do it: say it with other words (the manual says "event source" for what watches something, "schedule" for what happens at a time, "approval" for what asks the owner, "conversation" for a session or tab), or look at the list of its parts with an empty search.`);
			continue;
		}
		out.push(`"${q}": ${r.hits.length} of ${r.total} parts, the best first`);
		r.hits.forEach((h, i) => out.push(`${i + 1}. ${h.id}   (${h.where}${h.note ? `, ${h.note}` : h.kind === "section" ? `, ${h.chars} characters` : ", one row of a table"})\n   ${h.line}`));
	}
	out.push(`Read a part in full by its id (the first word of an entry), several at once if you like. A line above is only the line that matched: read the part before you rely on it.`);
	return out.join("\n");
}

/** One or several parts in full, within what fits into one answer. */
export function showRead(manual: Manual, ids: string[], budget = 14_000): string {
	const out: string[] = [];
	let used = 0;
	for (const id of ids.slice(0, 8)) {
		const r = manual.read(id);
		if ("unknown" in r) {
			out.push(`"${id}" is not a part of the manual.${r.near.length ? ` Close to it: ${r.near.join(", ")}.` : ""} Search for it instead.`);
			continue;
		}
		if (used && used + r.text.length > budget) {
			out.push(`(not shown, to keep this answer short: ${id}. Read it on its own.)`);
			continue;
		}
		used += r.text.length;
		const p = r.part;
		const head = `## ${p.id}   (${p.note ? p.file : `${p.file}.md`} › ${p.path.slice(p.path.length > 1 ? 1 : 0).join(" › ")}${r.pages > 1 ? `, page ${r.page} of ${r.pages}` : ""})`;
		const more = r.page < r.pages ? `\n\n(continues: read ${p.id}@${r.page + 1})` : "";
		const below = p.children.length && r.page === r.pages ? `\n\nParts below this one: ${p.children.join(", ")}` : "";
		// A row is one line of a table: what the table is about, and what holds for all of its rows, stands in the part around it.
		const around = p.kind === "row" && !p.note ? `\n\n(This is one row of a table in ${p.id.slice(0, p.id.lastIndexOf(p.id.includes("/") ? "/" : "#"))}. Read that part for what stands around it.)` : "";
		out.push(`${head}\n\n${r.text || "(nothing but the parts below it)"}${more}${below}${around}`);
	}
	return out.join("\n\n");
}
