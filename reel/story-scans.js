// A second film: an agent for the owner's bills. A folder of scans becomes an event source, a letter
// arrives, and the agent answers with everything needed to pay it. The letter and all its numbers
// are made up (bill/water-bill.pdf, drawn from bill/water-bill.html). Rendered with `node reel/render.mjs --story scans`.

// ---- helpers (as in story.js) ----------------------------------------------------------------------

let TAB = "main";
const MODEL = "local/flashnext";
const newTab = (key, agent, session, folder = "") => ({ key, agent, session, folder, doc: [], running: false, toolCalls: 0, context: 0, startedAt: 0 });
function intro(key, about) {
	inst((st) => {
		const tb = tabOf(st, key);
		tb.doc.push({ k: "text", s: `⟦b.d|${tb.agent}⟧⟦d| · ${about}⟧` });
		tb.doc.push({ k: "text", gap: false, s: `⟦d|session ${tb.session} · model ${MODEL} · type a message, / for commands, or click the bar below⟧` });
	});
}
function typeIn(s, cps = 27) { keySounds(s, cps); op(s.length / cps, (st, p) => { st.input = s.slice(0, Math.round(p * s.length)); }); }
function send(s) {
	const k = TAB, t0 = T, id = uid();
	inst((st) => { const tb = tabOf(st, k); st.input = ""; tb.doc.push({ k: "user", id, s }); tb.running = true; tb.startedAt = t0; tb.toolCalls = 0; });
}
const cell = (col, row) => ({ x: ORIGIN.x + col * CW, y: ORIGIN.y + (row + 0.5) * RH });
const onWindow = (dur = 0.9) => shot(960, 556, 1.1, dur);
const wide = (dur = 1) => shot(960, 540, 1, dur);
const onInput = (z = 1.5, dur = 0.8) => focus(cell(z > 1.4 ? 41 : 46, ROWS - 3), z, dur, 0.5, 0.76);
function say(s, o = {}) {
	onInput(o.z);
	wait(0.3);
	// A long line: the camera moves along with the caret while it is typed, so its end is in the picture.
	if (o.follow) focus(cell(s.length + 2, ROWS - 3), o.z, s.length / (o.cps || 27), 0.8, 0.76);
	typeIn(s, o.cps);
	wait(o.pause ?? 0.3);
	sound("enter");
	send(s);
	onWindow(0.9);
	wait(0.3);
}
function tap(p, effect, o = {}) {
	if (!o.still) focus(p, o.z ?? 1.6, o.move ?? 0.8, o.ax ?? 0.5, o.ay ?? 0.5);
	moveTo(p, o.move ?? 0.8);
	wait(o.hover ?? 0.28);
	click(effect);
	wait(o.after ?? 0.55);
}
function toolStart(name, subj, gap = true) {
	const k = TAB, id = uid();
	inst((st) => { const tb = tabOf(st, k); tb.doc.push({ k: "tool", id, name, subj, state: "run", gap }); tb.toolCalls++; });
	return (ms) => inst((st) => { const b = blockOf(st, id); b.state = "ok"; b.ms = ms; });
}
function tool(name, subj, secs, ms, gap = true) { const end = toolStart(name, subj, gap); wait(secs); end(ms); wait(0.07); }
function answer(lines, cps = 300) {
	const segs = lines.map((l) => (l === "" ? { gap: true, cells: [] } : typeof l === "object" ? { pre: true, cells: L(l.pre) } : l.startsWith("- ") ? { cells: L(`⟦a|-⟧ ${l.slice(2)}`), hang: 2 } : { cells: L(l) }));
	const total = segs.reduce((n, s) => n + s.cells.length, 0);
	const k = TAB, id = uid();
	op(total / cps, (st, p) => { tabOf(st, k).doc.push({ k: "md", id, segs, total, p }); });
}
function push(block) { const k = TAB; inst((st) => { tabOf(st, k).doc.push(block); }); }
function done(context, outside) { const k = TAB; inst((st) => { const tb = tabOf(st, k); tb.running = false; tb.context = context; if (outside) tb.outside = true; }); }
function event(label, s) { const k = TAB, t0 = T; inst((st) => { const tb = tabOf(st, k); tb.doc.push({ k: "event", label, s }); tb.running = true; tb.startedAt = t0; tb.toolCalls = 0; }); wait(0.3); }
function table(head, rows) {
	const all = [head, ...rows], widths = head.map((_, i) => Math.max(...all.map((r) => r[i].replace(/⟦[^|]*\||⟧/g, "").length)));
	const line = (l, m, r) => ({ pre: `${l}${widths.map((w) => "─".repeat(w + 2)).join(m)}${r}` });
	const row = (r, bold) => ({ pre: `│${r.map((s, i) => ` ${bold ? `⟦b|${s}⟧` : s}${" ".repeat(widths[i] - s.replace(/⟦[^|]*\||⟧/g, "").length)} `).join("│")}│` });
	const out = [line("┌", "┬", "┐"), row(head, true)];
	for (const r of rows) out.push(line("├", "┼", "┤"), row(r));
	return [...out, line("└", "┴", "┘")];
}
/** A question is put to the owner; the camera goes to it, the pointer to its first button. */
function confirm(overlay, words, read = 2.3) {
	inst((st) => { st.overlay = overlay; });
	if (words) caption(words, read + 2.2);
	focus({ x: 960, y: ORIGIN.y + 13.5 * RH }, 1.5, 0.7);
	wait(read);
	pointerShow({ x: 1180, y: 720 });
	moveTo(find("Allow once (a)"), 0.55);
	wait(0.12);
	click((st) => { st.overlay = null; });
	onWindow(0.7);
	wait(0.4);
	pointerHide();
}

const LETTER = "~/Documents/scans/water-bill.pdf";
/** How much quicker the film plays than it is written (SPEED, set at the end). */
const SPEED_FILM = 1.07;

// ---- 0. a title ----------------------------------------
mark("title");
pace(1);

// Pine is open and framed before the first frame, under a black card: no shell, no camera move.
at(-0.1);
inst((st) => { st.card = 1; st.cardText = "<b>pine</b> is a reactive event bus for agents"; st.mode = "pine"; st.title = "pine"; st.model = MODEL; st.tabs = [newTab("main", "main", "main")]; st.active = 0; });
intro("main", "Your main agent");
onWindow(0.01);
at(0);
wait(2.6);
op(0.7, (st, p) => { st.card = 1 - p; });

// ---- 1. the main agent makes a new one ----------------------------------------
mark("a new agent");
pace(0.75);

wait(0.2);
caption("In pine just tell the agent what to do", 4.6);
say("new agent: mrbanks, same model", { cps: 19 });
tool("create_agent", "mrbanks", 1.2, "1.5 s");
answer(["⟦y|mrbanks⟧ is live. Find it under the agent's name in the bar below."], 110);
done(4);
focus(find("is live. Find it", { dx: 14 * CW }), 1.7, 0.7);
wait(1.5);

// The agent's name in the bar lists the agents; a click opens the new one in a tab.
caption("Agents run in tabs", 3.8);
pointerShow({ x: 620, y: 700 });
tap(find("main", { nth: 99 }), (st) => { st.overlay = { k: "pick", title: "Agent", sel: 0, items: [{ label: "main", desc: "Your main agent" }, { label: "mrbanks", desc: "Personal finance assistant" }] }; }, { z: 1.6, ay: 0.7, after: 0.5 });
focus({ x: 960, y: ORIGIN.y + 13.5 * RH }, 1.5, 0.8);
wait(0.6);
tap(find("mrbanks  Personal", { dx: -3.5 * CW }), (st) => { st.overlay = null; st.tabs.push(newTab("banks", "mrbanks", "main")); st.active = 1; }, { still: true, move: 0.6, after: 0.3 });
intro("banks", "Personal finance assistant: budgets, tracking expenses, bills");
pointerHide();
onWindow(0.8);
wait(0.6);

// ---- 2. a folder becomes an event source ----------------------------------------
mark("a folder of scans becomes an event source");
pace(0.78);

TAB = "banks";
caption("Connect to events by simply telling it to", 7.2);
say("watch ~/Documents/scans. for every new file: brief description, payment details, add to TODO.md", { cps: 25, z: 1.35, pause: 0.5, follow: true });
tool("add_source", "scans", 1.0, "1.9 s");
// The job goes into the agent's own AGENTS.md, which pine reads into every conversation it has.
caption("Specific instructions go into AGENTS.md", 5.6);
tool("edit", "AGENTS.md", 0.6, "21 ms");
answer([
	"Watching ⟦y|~/Documents/scans⟧, and I saved the job to my ⟦y|AGENTS.md⟧, so I keep it in every conversation:",
	{ pre: "⟦d|AGENTS.md⟧" },
	{ pre: "⟦d|│⟧ ⟦b|## Scans⟧" },
	{ pre: "⟦d|│⟧ For every new file in ~/Documents/scans: a brief description," },
	{ pre: "⟦d|│⟧ the payment details, and an entry in TODO.md." },
], 130);
done(6);
focus(find("AGENTS.md", { nth: 3, dx: 26 * CW, dy: 1 * RH }), 1.5, 0.9);
wait(1.9);

// ---- 3. a letter is scanned ----------------------------------------
mark("a letter arrives");
pace(0.85);

onWindow(0.8);
wait(0.4);
// The letter goes through the scanner: the clip is cut in over the whole picture, with its own sound.
pace(1);
{
	// assets/scan/: the frames of the clip (IMG_2557, colour-corrected) and its sound.
	const FRAMES = 435;
	const clip = (show, t0) => ({ show, src: "scan", frames: FRAMES, fps: 30, t0 });
	const t0 = T + 0.4, play = (FRAMES / 30) * SPEED_FILM;
	op(0.4, (st, p) => { st.clip = clip(p, t0); });
	SFX.push({ t: t0, k: "file", f: "assets/scan/scan.wav", gain: 1 });
	caption("Bills 😖", play / 2);
	captions.push({ from: T + (play / 2) * PACE, to: T + (play + 0.4) * PACE, s: "RICOH ScanSnap, configured to ~/Documents/scans" });
	op(play - 0.4, (st) => { st.clip = clip(1, t0); });
	op(0.5, (st, p) => { st.clip = clip(1 - p, t0); });
}
pace(0.85);
onWindow(0.8);
wait(0.4);
// What the folder source reports, as pine shows it: the event's topic and its data.
event("scans: source/scans@mrbanks/added", `{ "path": "${LETTER}", "file": "water-bill.pdf", "size": 190465 }`);
focus({ x: ORIGIN.x + 46 * CW, y: find("source/scans@mrbanks/added").y + 0.5 * RH }, 1.4, 0.9);
wait(2.4);

// ---- 4. the agent does its job ----------------------------------------
mark("mrbanks at work");
caption("Incoming events wake the agent", 4.6);
// Framed from the left edge of the window, so that the tool lines are whole.
focus({ x: ORIGIN.x + 46 * CW, y: find("source/scans@mrbanks/added").y + 6 * RH }, 1.3, 0.8);
tool("bash", `pdftotext ${LETTER}`, 0.7, "120 ms");
tool("read", LETTER, 0.7, "1.1 s", false);
push({ k: "img", srcs: ["../bill/water-bill-page1.png", "../bill/water-bill-page2.png"], cols: 18, rows: 12, gap: false, cap: "⟦d|water-bill.pdf · 2 pages · click to enlarge⟧" });
wait(0.2);
focus(find("2 pages · click to enlarge", { dx: 10 * CW, dy: -5.5 * RH }), 1.5, 0.9);
wait(1.5);
tool("edit", "TODO.md", 0.6, "18 ms");

// ---- 5. the outcome ----------------------------------------
mark("the outcome");
pace(0.8);

onWindow(0.8);
caption("It has come up with a result", 8.5);
answer([
	"⟦b|New scan: water bill from Stadtwerke Musterstadt⟧",
	"",
	"Annual water statement 2025/26 for Lindenallee 14: 119 m³, 714.41 € in charges, 495.00 € prepaid. ⟦b|219.41 € due by 26 Nov 2026.⟧",
	"",
	...table(["Field", "Value"], [
		["Payee", "Stadtwerke Musterstadt GmbH"],
		["Bank", "Sparkasse Musterstadt"],
		["IBAN", "DE89 3704 0044 0532 0130 00"],
		["BIC", "COBADEFFXXX"],
		["Amount", "⟦b|219.41 €⟧"],
		["Due date", "26 Nov 2026"],
		["Reference", "WA-2026-104233"],
	]),
	"",
	"New prepayment: ⟦b|49.00 €⟧ a month from 15 Dec 2026 (was 45.00 €). Added to ⟦y|TODO.md⟧.",
], 260);
done(15, true);
focus(find("Payee", { dx: 20 * CW, dy: 6 * RH }), 1.42, 1.0);
wait(2.6);

// ---- 6. the list, in Finder ----------------------------------------
mark("TODO.md in Finder");
pace(0.85);

{
	const rows = [
		{ name: "AGENTS.md", date: "Today at 18:02", size: "412 bytes", kind: "Markdown" },
		{ name: "TODO.md", date: "Today at 18:21", size: "1 KB", kind: "Markdown" },
	];
	const text = [
		'<span class="hd"># TODO</span>',
		"",
		'<span class="dn">- [x] Electricity, October: 71.00 € · paid 3 Nov</span>',
		"- [ ] Car insurance: 412.80 € by 30 Nov · ref KFZ-88213",
		"- [ ] Dentist: 86.40 € by 4 Dec · ref R-2026-0912",
		'<span class="nw">- [ ] Water bill: 219.41 € by 26 Nov · ref WA-2026-104233</span>',
		'<span class="nw">      Stadtwerke Musterstadt · IBAN DE89 3704 0044 0532 0130 00</span>',
	].join("\n");
	shot(960, 490, 1.5, 0.8);
	op(0.6, (st, p) => { st.finder = { show: p, sel: -1, rows, ql: 0, text }; st.winDim = 0.5 * p; });
	caption("And it added it to TODO.md", 6.2);
	pointerShow({ x: 1100, y: 640 });
	moveTo({ x: 718, y: 301 }, 0.7);
	wait(0.2);
	click((st) => { st.finder.sel = 1; });
	wait(0.45);
	sound("key");
	op(0.35, (st, p) => { st.finder.ql = p; });
	pointerHide();
	wait(3.6);
}

// ---- 7. the end ----------------------------------------
mark("the end");
pace(1);

shot(960, 540, 1, 0.9);
op(0.8, (st, p) => { st.outro = p; });
wait(2.3);
SPEED = SPEED_FILM;
const DURATION = T / SPEED;
