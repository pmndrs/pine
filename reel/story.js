// The reel's script: what is typed, what the agents answer, where the pointer goes.
// Each call adds to the timeline at the current time T and moves T on.

// ---- helpers ---------------------------------------------------------------------------------------

let TAB = "main";
const newTab = (key, agent, session, folder = "") => ({ key, agent, session, folder, doc: [], running: false, toolCalls: 0, context: 0, startedAt: 0 });
function intro(key, about, model = "dev/claude-haiku") {
	inst((st) => {
		const tb = tabOf(st, key);
		tb.doc.push({ k: "text", s: `⟦b.d|${tb.agent}⟧⟦d| · ${about}⟧` });
		tb.doc.push({ k: "text", gap: false, s: `⟦d|session ${tb.session} · model ${model}${tb.folder ? ` · works in ${tb.folder}` : ""} · type a message, / for commands, or click the bar below⟧` });
	});
}
function typeIn(s, cps = 27) { keySounds(s, cps); op(s.length / cps, (st, p) => { st.input = s.slice(0, Math.round(p * s.length)); }); }
function send(s, attached) {
	const k = TAB, t0 = T, id = uid();
	inst((st) => {
		const tb = tabOf(st, k);
		st.input = "";
		st.attach = [];
		tb.doc.push({ k: "user", id, s, attached });
		tb.running = true;
		tb.startedAt = t0;
		tb.toolCalls = 0;
	});
}
/** A point of the terminal: the left edge of a cell's column, the middle of its row. */
const cell = (col, row) => ({ x: ORIGIN.x + col * CW, y: ORIGIN.y + (row + 0.5) * RH });
const wide = (dur = 1) => shot(960, 540, 1, dur);
/** The window fills the picture. */
const onWindow = (dur = 0.9) => shot(960, 556, 1.1, dur);
/** Close on the line that is typed into, with the end of the conversation above it. */
const onInput = (z = 1.5, dur = 0.8) => focus(cell(z > 1.4 ? 41 : 46, ROWS - 3), z, dur, 0.5, 0.76);
/** A message is typed and sent: the camera goes to the input for the typing and back to the window for the answer. */
function say(s, o = {}) {
	onInput(o.z);
	wait(0.3);
	typeIn(s, o.cps);
	wait(o.pause ?? 0.3);
	sound("enter");
	send(s, o.attached);
	onWindow(0.9);
	wait(0.3);
}
/** Move the pointer to a point and click it, with the camera close on that point (`still`: the camera stays where it is). */
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
function shellType(s, cps = 9) { keySounds(s, cps); op(s.length / cps, (st, p) => { st.shell.typed = s.slice(0, Math.round(p * s.length)); }); }
function shellRun(prompt, busy = false) { sound("enter"); inst((st) => { st.shell.lines.push(`${st.shell.prompt} ⟦a|❯⟧ ${st.shell.typed}`); st.shell.typed = ""; if (prompt) st.shell.prompt = prompt; st.shell.busy = busy; }); }
function table(head, rows) {
	const all = [head, ...rows], widths = head.map((_, i) => Math.max(...all.map((r) => r[i].replace(/⟦[^|]*\||⟧/g, "").length)));
	const line = (l, m, r) => ({ pre: `${l}${widths.map((w) => "─".repeat(w + 2)).join(m)}${r}` });
	const row = (r, bold) => ({ pre: `│${r.map((s, i) => ` ${bold ? `⟦b|${s}⟧` : s}${" ".repeat(widths[i] - s.replace(/⟦[^|]*\||⟧/g, "").length)} `).join("│")}│` });
	const out = [line("┌", "┬", "┐"), row(head, true)];
	for (const r of rows) out.push(line("├", "┼", "┤"), row(r));
	return [...out, line("└", "┴", "┘")];
}
const code = (lang, lines) => [{ pre: `⟦d|${lang}⟧` }, ...lines.map((s) => ({ pre: `⟦d|│⟧ ${s}` }))];
function drop(kind, src, name, size, to) {
	wide(0.8);
	wait(0.2);
	pointerShow({ x: 1960, y: 760 });
	inst((st) => { st.drag = { kind, src, name, p: 1 }; });
	// The camera comes closer as the file arrives, so that the drop is not missed.
	wait(0.15);
	shot(to.x + 120, to.y - 40, 1.28, 1.25);
	moveTo(to, 1.25);
	wait(0.3);
	sound("release");
	op(0.2, (st, p) => { st.drag = { kind, src, name, p: 1 - p }; });
	inst((st) => { st.drag = null; st.attach = [{ name, size }]; });
	wait(0.35);
	pointerHide();
}

// ---- what the mocked windows hold ------------------------------------------------------------------

const PANE = {
	info: { changes: "main · 3 changed · ~/dev/flipper", files: "~/dev/flipper", output: "5 tool calls · ~/dev/flipper" },
	changes: ["⟦y|M⟧ README.md  ⟦g|+1⟧", "⟦y|M⟧ src/subghz.ts  ⟦g|+12⟧ ⟦rd|−1⟧", "⟦g|+⟧ test/scan.test.ts  ⟦g|+8⟧"],
	"changes:diff": [
		"⟦a|‹ back⟧ ⟦d|·⟧ ⟦b|src/subghz.ts⟧", "⟦d|changed · ⟧⟦g|+12⟧ ⟦rd|−1⟧", "",
		"⟦c|@@ -4,6 +6,15 @@⟧",
		" /** Listen on one frequency. */",
		"⟦rd|-export function listen(hz: number, ms = 200) {⟧",
		"⟦g|+export function listen(hz: number, ms = 100) {⟧",
		"   return radio.listen(hz, { ms });",
		" }",
		"",
		"⟦g|+/** The strongest signal in a band. */⟧",
		"⟦g|+export async function scan([lo, hi]: number[]) {⟧",
		"⟦g|+  const hits: Reading[] = [];⟧",
		"⟦g|+  for (let hz = lo; hz <= hi; hz += STEP) {⟧",
		"⟦g|+    hits.push(await listen(hz));⟧",
		"⟦g|+  }⟧",
		"⟦g|+  return hits.sort((a, b) => b.dbm - a.dbm)[0];⟧",
		"⟦g|+}⟧",
	],
	files: ["⟦a|▸⟧ ⟦b|src⟧/", "⟦a|▸⟧ ⟦b|test⟧/", "  README.md ⟦d|379 B⟧", "  package.json ⟦d|96 B⟧"],
	"files:open": ["⟦a|▾⟧ ⟦b|src⟧/", "    gpio.ts ⟦d|153 B⟧", "    infrared.ts ⟦d|481 B⟧", "    radio.ts ⟦d|356 B⟧", "    subghz.ts ⟦d|683 B⟧", "⟦a|▸⟧ ⟦b|test⟧/", "  README.md ⟦d|379 B⟧", "  package.json ⟦d|96 B⟧"],
	output: ["⟦g|✓⟧ ⟦b|bash⟧ ⟦d|node --test  149 ms⟧", "⟦g|✓⟧ ⟦b|edit⟧ ⟦d|README.md  43 ms⟧", "⟦g|✓⟧ ⟦b|write⟧ ⟦d|test/scan.test.ts  25 ms⟧", "⟦g|✓⟧ ⟦b|edit⟧ ⟦d|src/subghz.ts  44 ms⟧", "⟦g|✓⟧ ⟦b|read⟧ ⟦d|src/subghz.ts  40 ms⟧"],
	"output:call": [
		"⟦a|‹ back⟧ ⟦d|·⟧ ⟦b|bash⟧", "⟦g|✓⟧ ⟦d|task #12 · 149 ms⟧", "⟦y|node --test⟧", "",
		"✔ a learned button is replayed (0.4ms)", "✔ scan finds the remote at 433.92 MHz (1.1ms)", "✔ listen reports the frequency it tuned (0.3ms)", "✔ busy is true where the remote sends (0.2ms)",
		"ℹ tests 4", "ℹ suites 0", "ℹ pass 4", "ℹ fail 0", "ℹ cancelled 0", "ℹ skipped 0", "ℹ todo 0", "ℹ duration_ms 81.3",
	],
};

const VS = {
	add: " Works from anywhere.",
	lines: [
		'<span class="hd"># flipper</span>', "", "Small tools for a Flipper Zero, driven over the gateway.", "",
		'<span class="bl">-</span> <span class="cd">`listen(hz)`</span>: the signal on one Sub-GHz frequency',
		'<span class="bl">-</span> <span class="cd">`busy(hz)`</span>: whether something is sending there',
		'<span class="bl">-</span> <span class="cd">`scan([lo, hi])`</span>: the strongest signal in a band',
		'<span class="bl">-</span> <span class="cd">`learn`</span> / <span class="cd">`replay`</span>: infrared remotes',
		'<span class="bl">-</span> <span class="cd">`temperature(raw)`</span>: the probe on pin A7',
		"", 'Run the tests with <span class="cd">`npm test`</span>.',
	],
};

// ---- 1. a shell; pine starts ----------------------------------------
mark("a shell; pine starts");

at(0.4);
focus(cell(12, 1), 1.5, 0.01, 0.3, 0.3);
shellType("pine", 7);
wait(0.3);
shellRun();
inst((st) => { st.mode = "pine"; st.title = "pine"; st.tabs = [newTab("main", "main", "main")]; st.active = 0; });
intro("main", "Your main agent");
wide(1.0);
wait(0.8);

// ---- 2. a picture from the web ----------------------------------------
mark("a picture from the web");
pace(0.7);

TAB = "main";
say("show me the this is fine meme");
tool("mcp__web__search", '"this is fine" meme original image', 0.5, "947 ms");
tool("download", "https://i.kym-cdn.com/entries/icons/original/000/018/012/this_is_fine.jpeg", 0.4, "285 ms");
answer(["Here it is: the dog from KC Green's ⟦it|Gunshow⟧ comic, \"On Fire\" (2013)."], 150);
caption("Pictures and video, shown in the terminal", 8.5);
push({ k: "img", src: "meme.jpg", cols: 44, rows: 12, alt: "This is fine", cap: "⟦d|This is fine · 300×168 · click to enlarge⟧" });
done(5, true);
wait(0.3);
focus(find("This is fine", { nth: 2, dy: 6.5 * RH, dx: 12 * CW }), 1.55, 1.0);
wait(1.4);

// ---- 3. a video ----------------------------------------
mark("a video");
pace(0.7);

say("and will smith eating spaghetti, the ai one");
tool("mcp__web__search", "Will Smith eating spaghetti AI video", 0.45, "771 ms");
tool("download", "https://archive.org/download/will-smith-eating-spaghetti-again-aigener-8-1080p.mp4", 0.5, "3.4 s");
answer(["Here it is, the AIGener8 remake from archive.org. It plays right here."], 150);
{
	const t0 = T;
	const clock = (s) => `0:${String(Math.min(36, Math.floor(s))).padStart(2, "0")}`;
	push({ k: "vid", src: "spag", frames: 40, cols: 44, rows: 14, t0, alt: "Will Smith eating spaghetti", cap: (s) => `⟦a|‖ pause⟧ ⟦d|· Will Smith eating spaghetti · ${clock(s + 1)} / 0:36 · no sound · click the picture to enlarge⟧` });
}
done(6, true);
wait(0.3);
focus(find("Will Smith eating spaghetti", { nth: 2, dy: 7.5 * RH, dx: 6 * CW }), 1.55, 1.0);
wait(2.1);

// ---- 4. a file dropped on the terminal ----------------------------------------
mark("a file dropped on the terminal");
pace(0.72);

caption("Drop a file to attach it", 4.6);
drop("img", "cones.jpg", "pine-1.jpg", "164 KB", { x: 940, y: 600 });
say("what's that", { attached: ["pine-1.jpg"], cps: 18 });
push({ k: "img", src: "cones.jpg", cols: 38, rows: 14, gap: false, cap: "⟦d|pine-1.jpg · 700×525 · click to enlarge⟧" });
wait(0.3);
answer(["Three pine cones on a few sprigs of pine needles. The scales are wide open, so they are dry, mature and have already shed their seeds."], 170);
done(17, true);
wait(1.1);

// ---- 6. code: pine in a project folder, and the pane ----------------------------------------
mark("code: pine in a project folder, and the pane");
pace(0.71);

inst((st) => { st.mode = "shell"; st.title = "~ — zsh"; });
focus(cell(14, 2), 1.55, 0.9, 0.32, 0.3);
wait(0.6);
shellType("cd dev/flipper", 15);
wait(0.2);
shellRun("⟦b.c|~/dev/flipper⟧ ⟦d|main⟧");
wait(0.3);
caption("pine .  works in the current folder", 4.2);
shellType("pine .", 8);
wait(0.35);
shellRun();
inst((st) => { st.mode = "pine"; st.title = "pine"; st.tabs.push(newTab("flipper", "main", "flipper", "~/dev/flipper")); st.active = 1; });
intro("flipper", "Your main agent");
onWindow(1.0);
wait(0.6);

TAB = "flipper";
say("add a scan() that finds the strongest signal in a band", { cps: 36 });
tool("read", "src/subghz.ts", 0.3, "40 ms");
tool("edit", "src/subghz.ts", 0.3, "44 ms");
tool("write", "test/scan.test.ts", 0.22, "25 ms", false);
tool("edit", "README.md", 0.22, "43 ms", false);
tool("bash", "node --test", 0.5, "149 ms");
answer(["Added ⟦y|scan([lo, hi])⟧ to ⟦y|src/subghz.ts⟧. It listens every 20 kHz across the band and returns the strongest reading. A new test covers it; all 4 tests pass."], 200);
done(6);
wait(0.7);

const onPane = (dur = 0.9, z = 1.42) => focus({ x: 1310, y: 440 }, z, dur);
pointerShow({ x: 1240, y: 560 });
wait(0.15);
tap(find("▤ code"), (st) => { st.pane.open = true; }, { z: 1.7, move: 0.6, hover: 0.2, after: 0.3 });
caption("Git changes, diffs, files and tool output", 10.5);
onPane(0.8, 1.35);
wait(0.6);
// Inside the pane the camera stays put: the clicks are close enough to follow, and it goes quicker.
const inPane = { still: true, move: 0.45, hover: 0.18 };
tap(find("src/subghz.ts", { minCol: 50 }), (st) => { st.pane.sub = "diff"; }, { ...inPane, after: 1.7 });
tap(find(" Files ", { minCol: 50 }), (st) => { st.pane.view = "files"; st.pane.sub = ""; }, { ...inPane, after: 0.35 });
tap(find("src", { minCol: 50 }), (st) => { st.pane.sub = "open"; }, { ...inPane, move: 0.35, after: 0.7 });
tap(find(" Output ", { minCol: 50 }), (st) => { st.pane.view = "output"; st.pane.sub = ""; }, { ...inPane, after: 0.35 });
tap(find("node --test", { minCol: 50 }), (st) => { st.pane.sub = "call"; }, { ...inPane, move: 0.35, after: 1.4 });
tap(find("▤ code"), (st) => { st.pane.open = false; st.pane.view = "changes"; st.pane.sub = ""; }, { z: 1.5, move: 0.6, hover: 0.2, after: 0.25 });
pointerHide();
onWindow(0.8);
wait(0.35);

// ---- 7. an event source: the folder is watched, a file changes in an editor ----------------------------------------
mark("an event source: the folder is watched, a file changes in an editor");
pace(0.75);

say("watch this folder. show me the diff for every change", { cps: 36 });
tool("add_source", "flipper", 0.4, "61 ms");
answer(["Done. I'm watching ⟦y|~/dev/flipper⟧ from this conversation and will show you the diff for every change."], 200);
done(7);
wait(0.6);

wide(0.8);
op(0.5, (st, p) => { st.vs.show = p; st.winDim = p; });
wait(0.3);
focus({ x: 1230, y: 372 }, 1.6, 0.9);
wait(0.7);
keySounds(VS.add, VS.add.length / 1.5);
op(1.5, (st, p) => { st.vs.typed = Math.round(p * VS.add.length); st.vs.dirty = p > 0; st.vs.typing = p < 1; });
wait(0.45);
sound("key");
inst((st) => { st.vs.dirty = false; });
wait(0.6);
wide(0.8);
op(0.45, (st, p) => { st.vs.show = 1 - p; st.winDim = 1 - p; });
caption("Event sources wake agents", 5.2);
onWindow(0.9);
wait(0.3);
event("source/flipper", "README.md changed in ~/dev/flipper");
tool("bash", "git diff -U0", 0.4, "22 ms");
answer([{ pre: "⟦d|diff⟧" }, { pre: "⟦d|│⟧ ⟦c|@@ -3 +3 @@⟧" }, { pre: "⟦d|│⟧ ⟦rd|-Small tools for a Flipper Zero, driven over the gateway.⟧" }, { pre: "⟦d|│⟧ ⟦g|+Small tools for a Flipper Zero, driven over the gateway. Works from anywhere.⟧" }], 320);
done(8);
focus(find("source/flipper", { dx: 28 * CW, dy: 4 * RH }), 1.45, 1.0);
wait(2.0);

// ---- 8. a fridge: an event source by asking, an agent that keeps the freezer stocked ----------------------------------------
mark("a fridge: an event source by asking, an agent that keeps the freezer stocked");
pace(0.79);

// In a conversation of its own: the main one has read a page from the web by now, and from such a
// conversation no program can be put into pine.
// A click on the + in the tab bar opens one; pine gives it a name of its own.
onWindow(0.8);
pointerShow({ x: 760, y: 420 });
tap(find(" + "), (st) => { st.tabs.push(newTab("fridge", "main", "smf3k20x")); st.active = 2; }, { z: 1.5, after: 0.3 });
pointerHide();
intro("fridge", "Your main agent");
TAB = "fridge";
onWindow(0.9);
wait(0.7);
caption("A new device: its protocol, and one sentence", 7.5);
drop("pdf", "", "fridge-protocol.pdf", "212 KB", { x: 880, y: 640 });
say("bought a fridge. here's its protocol, make an event source", { attached: ["fridge-protocol.pdf"], cps: 25, pause: 0.7 });
/** A question is put to the owner; the camera goes to it, the pointer to its first button. */
const confirm = (overlay, words, read = 2.3, back = cell(34, 9)) => {
	inst((st) => { st.overlay = overlay; });
	if (words) caption(words, read + 3.2);
	focus({ x: 960, y: ORIGIN.y + 13.5 * RH }, 1.5, 1.0);
	wait(read);
	pointerShow({ x: 1180, y: 720 });
	moveTo(find("Allow once (a)"), 0.9);
	wait(0.4);
	click((st) => { st.overlay = null; });
	// Back to the tool calls, where the one that waited now finishes.
	focus(back, 1.38, 0.7, 0.5, 0.5);
	wait(0.4);
	pointerHide();
};
// No type of source speaks this fridge's protocol, so the agent writes one. The tool calls are the story here.
focus(cell(34, 9), 1.38, 0.9, 0.5, 0.5);
tool("read", "inbox/fridge-protocol.pdf", 0.8, "12 ms");
tool("write", "types/fridge.ts", 1.1, "31 ms", false);
{
	const end = toolStart("add_source_type", "fridge", false);
	wait(0.7);
	confirm({ k: "approve", agent: "main", task: 31, tool: "add_source_type", summary: ['register the source type "fridge" from ~/.pine/agents/main/workspace/types/fridge.ts (74 lines)', "This is a program. Once registered it runs inside pine itself, with your rights and outside any sandbox, whenever a source of this type runs.", "It uses: node:net.", "Read the file before you say yes. pine keeps a copy of it exactly as it is now."], why: "this puts a program into pine that runs with your rights" }, "A new kind of source is a program, so you see it first", 3.4);
	end("96 ms");
	wait(0.6);
}
{
	const end = toolStart("add_source", "fridge", false);
	wait(0.6);
	confirm({ k: "approve", agent: "main", task: 31, tool: "add_source", summary: ['add event source "fridge" (fridge) for ALL agents', "It will: connect to fridge.local:4070 and report the door, the temperature and what is on each shelf."], why: "this adds a source of events to pine's configuration" }, "What is for all agents asks you too", 1.7);
	end("84 ms");
	wait(0.5);
	onWindow(0.9);
}
wait(0.3);
answer(["⟦y|fridge⟧ is an event source now. It reports the door, the temperature and what is on each shelf. Any agent can subscribe to it."], 110);
done(4);
focus(find("is an event source now", { dx: 18 * CW, dy: -2 * RH }), 1.45, 1.0);
wait(1.8);

caption("Another agent takes it from there", 9.5);
say("create an agent pizzapizza that keeps the freezer stocked", { cps: 30, pause: 0.6 });
{
	// An agent is made by asking the main one. You see what it will be before it exists.
	const end = toolStart("create_agent", "pizzapizza");
	wait(0.6);
	confirm({ k: "approve", agent: "main", task: 32, tool: "create_agent", summary: ['create the agent "pizzapizza": Keeps the freezer stocked', "Model: dev/claude-haiku (the default) · tools: read, bash, edit, write, grep, find, ls", "Instructions:", "You are pizzapizza. You keep the freezer stocked: watch what the fridge reports and reorder what has run out."], why: "this adds an agent to pine: a folder of its own under agents/pizzapizza, working inside its own sandbox like every agent" }, null, 2.2, find("create_agent", { dx: 16 * CW }));
	end("118 ms");
	wait(0.4);
	onWindow(0.8);
}
answer(["⟦y|pizzapizza⟧ exists now. You find it under the agent's name in the bar below."], 120);
done(6);
wait(1.2);
// The agent's name in the bar lists the agents; a click opens the new one in a tab.
pointerShow({ x: 620, y: 700 });
tap(find("main", { nth: 99 }), (st) => { st.overlay = { k: "pick", title: "Agent", sel: 0, items: [{ label: "main", desc: "Your main agent" }, { label: "pizzapizza", desc: "Keeps the freezer stocked" }] }; }, { z: 1.6, ay: 0.7, after: 0.5 });
focus({ x: 960, y: ORIGIN.y + 13.5 * RH }, 1.5, 0.8);
wait(0.7);
tap(find("pizzapizza  Keeps", { dx: -3.5 * CW }), (st) => { st.overlay = null; st.tabs.push(newTab("pizza", "pizzapizza", "main")); st.active = 3; }, { still: true, move: 0.6, after: 0.3 });
pointerHide();
intro("pizza", "Keeps the freezer stocked");
onWindow(0.9);
wait(0.6);
TAB = "pizza";
say("watch the fridge. when the pizza is gone, buy new", { cps: 25, pause: 0.7 });
tool("subscribe", "fridge", 0.7, "9 ms");
answer(["Watching. When the fridge reports no pizza left, I order two more."], 110);
done(3);
focus(cell(34, 8), 1.45, 1.0);
wait(1.6);
onWindow(0.9);
wait(0.5);
caption("Days later, the fridge reports", 6.0);
event("source/fridge", "shelf 2 · pizza 0 of 2");
focus(cell(34, 12), 1.45, 1.0);
wait(1.0);
tool("mcp__shop__order", "2 × Pizza Margherita", 0.9, "1.3 s");
answer(["Ordered 2 × Margherita. They arrive tomorrow between 17:00 and 19:00."], 100);
done(4);
wait(1.9);

// ---- 9. telegram: the owner's number, and pine running without the UI ----------------------------------------
mark("telegram: the owner's number, and pine running without the UI");
pace(0.79);

onWindow(0.8);
pointerShow({ x: 620, y: 380 });
tap(find("1 main"), (st) => { st.active = 0; }, { z: 1.5, after: 0.4 });
pointerHide();
TAB = "main";
caption("Reachable when you are away", 9);
say("watch telegram under my number. that's me. you're my assistant now, and my recipient when i'm away", { cps: 30, z: 1.26, pause: 0.8 });
{
	// The bot's token is not said in the conversation: pine asks for it in a field of its own.
	const end = toolStart("add_source", "telegram");
	wait(0.7);
	const ask = (value) => ({
		k: "approve", agent: "main", task: 44, tool: "add_source",
		summary: ['add event source "telegram" (telegram) for agent main (all its conversations), and subscribe to it', "It will: connect to Telegram as your bot and wait for messages; listen to nobody until you have paired your own account; take what that account writes as coming from you; send answers back to that chat, and nowhere else."],
		why: "this adds a source of events to pine's configuration",
		fields: [{ label: "token: the bot's token, which @BotFather gives when a bot is made with /newbot (123456789:AA...)", value }],
	});
	inst((st) => { st.overlay = ask(""); });
	caption("A token is typed into pine, never into the chat", 7.6);
	focus({ x: 960, y: ORIGIN.y + 14 * RH }, 1.45, 1.0);
	wait(2.2);
	// Pasted: there at once, as dots.
	focus({ x: 960, y: find("Type or paste it here").y - 2.5 * RH }, 1.6, 0.9);
	wait(0.5);
	sound("key");
	inst((st) => { st.overlay = ask("x".repeat(46)); });
	wait(1.9);
	sound("enter");
	inst((st) => { st.overlay = null; });
	wait(0.3);
	end("48 ms");
	onWindow(0.9);
}
{
	// And the account is tied to the bot by a code that only its owner's phone shows.
	answer(["The bot is running. Write to it from your phone; it answers with a code, and pine asks you for it here."], 110);
	focus(find("The bot is running", { dx: 22 * CW }), 1.3, 1.0, 0.5, 0.6);
	wait(2.3);
	const pair = (value) => ({
		k: "approve", agent: "telegram (event source)", tool: "telegram",
		summary: ["let the Telegram account of Sam (@sam, Telegram id 5550142) talk to your agents as you through the bot @sams_pine_bot", 'It just wrote: "hi"', "The bot sent that account a code. If the account is yours, the code is on your phone now."],
		why: "what this account writes will count as your own words. Only the code proves that the account is yours",
		fields: [{ label: "code: the six digits the bot just sent to that account in Telegram", value, secret: false }],
	});
	inst((st) => { st.overlay = pair(""); });
	caption("Paired by a code that only your phone shows", 6.4);
	focus({ x: 960, y: ORIGIN.y + 14 * RH }, 1.45, 1.0);
	wait(2.0);
	focus({ x: 960, y: find("Type it here and press enter").y - 2.5 * RH }, 1.6, 0.9);
	wait(0.4);
	keySounds("481203", 6);
	op(1.0, (st, p) => { st.overlay = pair("481203".slice(0, Math.round(p * 6))); });
	wait(0.7);
	sound("enter");
	inst((st) => { st.overlay = null; });
	onWindow(0.9);
	answer(["Paired. Messages from that account reach me as you. While you're away I answer there, and whatever is meant for you goes to that chat."], 110);
	done(22);
	focus(find("Messages from that account", { dx: 22 * CW }), 1.26, 1.0, 0.5, 0.6);
	wait(2.4);
}

inst((st) => { st.mode = "shell"; st.title = "~ — zsh"; st.shell.prompt = "⟦b.c|~⟧"; st.shell.lines = ["⟦b.c|~⟧ ⟦a|❯⟧ pine"]; });
focus(cell(26, 2), 1.55, 0.9, 0.42, 0.3);
wait(0.6);
caption("Runs as a service", 4.4);
shellType("pine start", 8);
wait(0.4);
shellRun(null, true);
wait(0.4);
inst((st) => { st.shell.lines.push("⟦d|2026-11-11T16:58:02.114Z⟧ ⟦g|INFO ⟧ [pine] pine is up: 2 agents, 0 routes, 3 event sources (3 running)"); });
focus(cell(44, 3), 1.4, 0.9, 0.5, 0.3);
wait(1.5);

wide(1.0);
op(0.8, (st, p) => { st.phone.show = p; st.winDim = 0.4 * p; st.winShift = -160 * ease(p); st.winScale = 0.13 * ease(p); });
wait(0.3);
shot(1152, 540, 1.22, 1.1);
{
	const msg = (m, dur = 0.3) => op(dur, (st, p) => { st.phone.msgs.push({ ...m, p }); }, true);
	const typing = (dur) => op(dur, (st, p, s) => { if (p < 1) st.phone.msgs.push({ typing: true, p: clamp(s / 0.2) }); });
	const write = (s) => { keySounds(s, 17, "tap"); op(s.length / 17, (st, p) => { st.phone.input = s.slice(0, Math.round(p * s.length)); }); wait(0.35); sound("tap"); inst((st) => { st.phone.input = ""; }); };
	wait(0.7);
	write("landed. anything while i was in the air?");
	msg({ me: true, html: "landed. anything while i was in the air?", time: "17:42" });
	wait(0.8);
	typing(1.3);
	msg({ html: "Welcome back. Two things:\n• pizzapizza ordered 2 × Margherita for tomorrow evening\n• flipper: README.md changed, tests pass", time: "17:42" });
	wait(2.7);
	write("send me the diff");
	msg({ me: true, html: "send me the diff", time: "17:43" });
	wait(0.7);
	typing(1.1);
	msg({ html: 'README.md, one line:<pre><span class="h">@@ -3 +3 @@</span>\n<span class="n">-…driven over the gateway.</span>\n<span class="p">+…driven over the gateway.</span>\n<span class="p">+ Works from anywhere.</span></pre>', time: "17:43" });
	wait(3.0);
}

// ---- 10. the end ----------------------------------------
mark("the end");
pace(1);

wide(0.9);
op(0.8, (st, p) => { st.outro = p; });
wait(2.3);
// Played slightly quicker than written.
SPEED = 1.07;
const DURATION = T / SPEED;
