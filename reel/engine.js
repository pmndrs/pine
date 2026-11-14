// The reel's engine: a terminal drawn on a character grid, a timeline of small steps that build
// the state of everything on screen, a mouse pointer with a camera that leans towards it, and
// the mocked windows around it. Everything on screen is a pure function of the time: renderAt(t)
// draws second t, so the film can be captured frame by frame.

const CW = 14.4, RH = 30, COLS = 100, ROWS = 28;
const WIN = { x: 218, y: 52, w: 22 + COLS * CW + 22, h: 50 + ROWS * RH + 22 };
const ORIGIN = { x: WIN.x + 22, y: WIN.y + 50 };
const $ = (id) => document.getElementById(id);
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const lerp = (a, b, p) => a + (b - a) * p;

// ---- text as cells -------------------------------------------------------------------------------

/** "plain ⟦b.y|bold yellow⟧ plain" as cells: one character and its classes each. */
function L(s) {
	const out = [];
	const re = /⟦([^|⟧]*)\|([^⟧]*)⟧/g;
	let i = 0, m;
	const add = (text, c) => { for (const ch of text) out.push({ ch, c }); };
	while ((m = re.exec(s))) {
		if (m.index > i) add(s.slice(i, m.index), "");
		add(m[2], m[1].split(".").join(" "));
		i = re.lastIndex;
	}
	if (i < s.length) add(s.slice(i), "");
	return out;
}
const sp = (n, c = "") => Array.from({ length: Math.max(0, n) }, () => ({ ch: " ", c }));
const text = (cells) => cells.map((x) => x.ch).join("");
const withClass = (cells, c) => cells.map((x) => ({ ch: x.ch, c: `${x.c} ${c}`.trim() }));
const fit = (cells, w, c = "") => (cells.length >= w ? cells.slice(0, w) : [...cells, ...sp(w - cells.length, c)]);

/** Break cells into lines of at most `width`, at spaces; later lines start `hang` cells in. */
function wrap(cells, width, hang = 0) {
	const lines = [];
	let line = [], word = [];
	const room = () => width - (lines.length ? hang : 0);
	const flush = () => {
		if (!word.length) return;
		if (line.length && line.length + word.length > room()) {
			while (line.length && line[line.length - 1].ch === " ") line.pop();
			lines.push(line);
			line = [];
		}
		while (word.length > room()) {
			lines.push(word.splice(0, room()));
		}
		line.push(...word);
		word = [];
	};
	for (const cell of cells) {
		if (cell.ch === " ") {
			flush();
			if (line.length) line.push(cell);
		} else word.push(cell);
	}
	flush();
	while (line.length && line[line.length - 1].ch === " ") line.pop();
	lines.push(line);
	return lines.map((l, i) => (i && hang ? [...sp(hang), ...l] : l));
}

const BOX = { "─": "L R", "│": "U D", "╭": "R D", "┌": "R D", "╮": "L D", "┐": "L D", "╰": "R U", "└": "R U", "╯": "L U", "┘": "L U", "├": "U D R", "┤": "U D L", "┬": "L R D", "┴": "L R U", "┼": "L R U D" };
const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function rowHTML(cells) {
	let html = "", run = "", cls = null;
	const flush = () => {
		if (run) html += `<span class="${cls}">${escape(run)}</span>`;
		run = "";
	};
	for (let i = 0; i < cells.length; i++) {
		const { ch, c } = cells[i];
		if (ch === "─") {
			// A run of line cells is one piece, so that no gaps show between cells.
			let n = 1;
			while (i + n < cells.length && cells[i + n].ch === "─" && cells[i + n].c === c) n++;
			flush();
			cls = null;
			html += `<i class="bx L R ${c}" style="width:${(n * CW).toFixed(2)}px"> </i>`;
			i += n - 1;
			continue;
		}
		if (ch.charCodeAt(0) < 127 && ch.length === 1) {
			if (c !== cls) flush(), (cls = c);
			run += ch;
			continue;
		}
		flush();
		cls = null;
		if (BOX[ch]) html += `<i class="bx ${BOX[ch]} ${c}"> </i>`;
		else if (ch === "█") html += `<i class="blk ${c}"> </i>`;
		else html += `<i class="${c}">${escape(ch)}</i>`;
	}
	flush();
	return html;
}

// ---- the timeline --------------------------------------------------------------------------------

const ops = [];
let T = 0, seq = 0, sorted = false;
const uid = () => `b${++seq}`;
const at = (t) => (T = t);
/** How long everything written from here on takes, as a factor: below 1 is quicker. Set per scene. */
let PACE = 1;
const pace = (f) => (PACE = f);
const wait = (d) => (T += d * PACE);
/** Something that takes `dur` seconds; fn gets the state, how far it is (0..1) and the seconds since it began. */
function op(dur, fn, parallel = false) {
	dur *= PACE;
	ops.push({ at: T, dur, fn, n: ops.length });
	sorted = false;
	if (!parallel) T += dur;
}
const inst = (fn) => op(0, fn);

function initial() {
	return {
		mode: "shell", title: "~ — zsh",
		shell: { lines: [], prompt: "⟦b.c|~⟧", typed: "", busy: false },
		tabs: [], active: 0, input: "", attach: [], pane: { open: false, view: "changes", sub: "" }, overlay: null,
		vs: { show: 0, typed: 0, dirty: false }, phone: { show: 0, msgs: [], input: "" }, drag: null, outro: 0, winDim: 0, winShift: 0, card: 0, cardText: "", finder: { show: 0, sel: -1, rows: [], ql: 0, text: "" },
	};
}

function stateAt(t) {
	if (!sorted) ops.sort((a, b) => a.at - b.at || a.n - b.n), (sorted = true);
	const st = initial();
	st.t = t;
	for (const o of ops) {
		if (o.at > t) break;
		o.fn(st, o.dur ? clamp((t - o.at) / o.dur) : 1, t - o.at);
	}
	return st;
}

// ---- the pine screen -----------------------------------------------------------------------------

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const rule = (w, c = "d") => L(`⟦${c}|${"─".repeat(w)}⟧`);
const tabOf = (st, key) => st.tabs.find((x) => x.key === key);
const blockOf = (st, id) => { for (const tb of st.tabs) { const b = tb.doc.find((x) => x.id === id); if (b) return b; } };

/** One block of a conversation as lines of `w` cells. */
function blockLines(b, w, t) {
	const inner = w - 2;
	const pad = (cells, c = "") => fit([...sp(1, c), ...cells], w, c);
	switch (b.k) {
		case "text":
			return wrap(L(b.s), inner, b.hang || 0).map((l) => pad(l));
		case "user": {
			const lines = wrap(L(b.s), inner).map((l) => pad(withClass(l, "U"), "U"));
			for (const a of b.attached || []) lines.push(pad(L(`⟦d.U|attached: ${a}⟧`), "U"));
			return lines;
		}
		case "tool": {
			const mark = b.state === "ok" ? "⟦g|✓⟧" : "⟦am|●⟧";
			return wrap(L(`${mark} ⟦b|${b.name}⟧${b.subj ? ` ⟦d|${b.subj}⟧` : ""}${b.state === "ok" && b.ms ? ` ⟦d|${b.ms}⟧` : ""}`), inner).map((l) => pad(l));
		}
		case "md": {
			// Streamed: only the first `shown` characters of all its segments are there yet.
			let left = Math.ceil(b.total * b.p);
			const lines = [];
			for (const seg of b.segs) {
				if (left <= 0) break;
				if (seg.gap) { lines.push(sp(w)); continue; }
				const cells = seg.cells.slice(0, left);
				left -= seg.cells.length;
				if (seg.pre) lines.push(pad(cells));
				else lines.push(...wrap(cells, inner, seg.hang || 0).map((l) => pad(l)));
			}
			return lines.length ? lines : [sp(w)];
		}
		case "pre":
			return b.lines.map((s) => pad(L(s)));
		case "img":
		case "vid": {
			const lines = [];
			if (b.alt) lines.push(pad(L(b.alt)));
			lines.push(Object.assign(sp(w), { img: b }));
			for (let i = 1; i < b.rows; i++) lines.push(sp(w));
			lines.push(pad(L(typeof b.cap === "function" ? b.cap(t - b.t0) : b.cap)));
			return lines;
		}
		case "event":
			return [pad(L(`⟦am|⚡⟧ ⟦b|${b.label}⟧`)), ...wrap(L(`⟦d|${b.s}⟧`), inner - 2).map((l) => pad([...sp(2), ...l]))];
	}
	return [];
}

function docLines(tab, w, t) {
	const lines = [];
	tab.doc.forEach((b, i) => {
		if (i && b.gap !== false) lines.push(sp(w));
		lines.push(...blockLines(b, w, t));
	});
	return lines;
}

function boxed(lines, w, c = "d") {
	const inner = w - 4;
	return [L(`⟦${c}|╭${"─".repeat(w - 2)}╮⟧`), ...lines.map((l) => [...L(`⟦${c}|│⟧ `), ...fit(l, inner), ...L(` ⟦${c}|│⟧`)]), L(`⟦${c}|╰${"─".repeat(w - 2)}╯⟧`)];
}

function overlayLines(o) {
	if (o.k === "pick") {
		const w = 64, col = Math.max(...o.items.map((x) => x.label.length)) + 2;
		const rows = o.items.map((x, i) => (i === o.sel ? L(`⟦a|→ ⟧⟦b.a|${x.label.padEnd(col)}⟧⟦b.a|${x.desc || ""}⟧`) : L(`  ${x.label.padEnd(col)}⟦d|${x.desc || ""}⟧`)));
		return { w, lines: boxed([L(`⟦b|${o.title}⟧`), L("⟦a|>⟧ ⟦d|type to search · enter picks · esc closes⟧"), ...rows], w) };
	}
	if (o.k === "convs") {
		const w = 78, inner = w - 4, name = Math.max(10, ...o.items.map((x) => x.session.length)) + 1;
		const rows = [L("  + new conversation")];
		o.items.forEach((x, i) => {
			const left = L(`${x.pinned ? "⟦a|★⟧" : " "} ${i === o.sel ? `⟦a|${x.session.padEnd(name)}⟧` : x.session.padEnd(name)} ⟦d|${x.info}⟧`);
			const right = x.main ? [] : L(`⟦a|${x.pinned ? "unpin" : "pin"}⟧   ⟦d|×⟧`);
			rows.push([...fit(left, inner - right.length - 2), ...sp(2), ...right]);
		});
		return { w, lines: boxed([L(`⟦b|${o.title}⟧`), L("⟦a|>⟧ ⟦d|type to search · enter opens · ctrl+p pins · ctrl+x removes · esc closes⟧"), ...rows, L("⟦d|pin keeps a conversation for good · × removes it now⟧")], w) };
	}
	if (o.k === "approve") {
		const w = 76, inner = w - 4;
		const indented = (str) => wrap(L(str), inner - 2).map((l) => [...sp(2), ...l]);
		// A request that needs something only the owner has: a field for it, dots for a secret.
		const fields = (o.fields || []).flatMap((f) => [...wrap(L(`⟦b|${f.label}⟧`), inner), L(`⟦a|>⟧ ⟦y|${f.secret === false ? f.value : "•".repeat(f.value.length)}⟧⟦A| ⟧`)]);
		const hint = !o.fields ? [] : wrap(L(`⟦d|${o.fields.some((f) => f.secret !== false) ? "Type or paste it here. It is not shown, goes into pine's .env file, and never reaches the agent or its model." : "Type it here and press enter. Without it, this cannot be allowed."}⟧`), inner);
		const body = [
			L(`⟦b.am|${o.fields ? "Approval needed, and something only you have" : "Approval needed"}⟧`), [],
			L(`⟦d|agent ⟧ ${o.agent}${o.task ? ` ⟦d|(task #${o.task})⟧` : ""}`), L(`⟦d|action⟧ ⟦b|${o.tool}⟧`), ...o.summary.flatMap(indented), [],
			...wrap(L(`⟦d|Why you are asked: ${o.why}⟧`), inner),
			...(fields.length ? [[], ...fields, ...hint] : []), [],
			L(o.fields ? "⟦A| Save and allow (enter) ⟧   Deny    Later (esc)   " : "⟦A| Allow once (a) ⟧   Deny (d)    Later (esc)   "),
		];
		return { w, lines: boxed(body, w, "am") };
	}
	return { w: 0, lines: [] };
}

function paneLines(st, w, h) {
	const p = st.pane, data = PANE;
	const tabs = ["changes", "files", "output"].map((v) => (p.view === v ? `⟦A| ${v[0].toUpperCase()}${v.slice(1)} ⟧` : `⟦d| ${v[0].toUpperCase()}${v.slice(1)} ⟧`)).join(" ");
	const head = L(` ${tabs}`);
	const right = L("⟦d| ↻  × ⟧");
	const lines = [[...fit(head, w - right.length), ...right], fit(L(` ⟦d|${(data.info || {})[p.view] || ""}⟧`), w), rule(w)];
	const body = (data[`${p.view}${p.sub ? `:${p.sub}` : ""}`] || []).map((s) => fit([...sp(1), ...L(s)], w));
	return [...lines, ...body].slice(0, h).concat(Array.from({ length: Math.max(0, h - 3 - body.length) }, () => sp(w)));
}

function pineScreen(st) {
	const grid = [], images = [];
	const tab = st.tabs[st.active];
	// the tab bar
	let head = L("⟦b.a| pine ⟧");
	st.tabs.forEach((x, i) => {
		const on = i === st.active;
		const name = x.session === "main" ? x.agent : `${x.agent}·${x.session}`;
		head.push(...L(on ? `⟦A| ${i + 1} ${name} ×⟧` : `⟦d| ${i + 1} ${name} ×⟧`));
		head.push(...(x.running ? L(`⟦am|${SPIN[Math.floor(st.t * 9) % SPIN.length]}⟧ `) : x.unread && !on ? L("⟦a|•⟧ ") : sp(2)));
	});
	head.push(...L("⟦d| + ⟧"));
	const code = L(st.pane.open ? "⟦A| ▤ code ⟧" : "⟦d| ▤ code ⟧");
	grid.push([...fit(head, COLS - code.length), ...code], rule(COLS));
	// the dock: status, attachments, input, bar
	const dock = [];
	const helpers = tab.running ? `⟦am|${SPIN[Math.floor(st.t * 9) % SPIN.length]}⟧ ⟦d|working · ${Math.max(0, Math.floor(st.t - tab.startedAt))}s${tab.toolCalls ? ` · ${tab.toolCalls} tool call${tab.toolCalls === 1 ? "" : "s"}` : ""} · esc to stop⟧` : st.notice ? `⟦am|${st.notice}⟧` : "";
	dock.push(fit(L(` ${helpers}`), COLS));
	if (st.attach.length) dock.push(fit(L(`⟦d| attached: ⟧${st.attach.map((a) => `⟦b|${a.name}⟧ ⟦d|${a.size} × ⟧`).join(" ")}`), COLS));
	const typed = [];
	for (let i = 0; i <= st.input.length; i += COLS - 3) typed.push(st.input.slice(i, i + COLS - 3));
	dock.push(rule(COLS));
	typed.forEach((s, i) => dock.push(fit(L(` ${s}${i === typed.length - 1 ? "█" : ""}`), COLS)));
	dock.push(rule(COLS));
	const bar = L(` ⟦b|${tab.agent}⟧⟦d| · ${tab.session} · ⟧${tab.folder ? `⟦c|${tab.folder}⟧` : "⟦d|no folder⟧"}⟦d| · ${st.model || "dev/claude-haiku"} · reasoning off · auto${tab.context ? ` · context ${tab.context}%` : ""}⟧${tab.outside ? "⟦y| · outside content⟧" : ""}`);
	dock.push(bar.length > COLS - 7 ? fit(bar, COLS) : [...fit(bar, COLS - 6), ...L("⟦d|/help ⟧")]);
	// the conversation, and the pane beside it
	const h = ROWS - 2 - dock.length;
	const w = st.pane.open ? 49 : COLS;
	const all = docLines(tab, w, st.t);
	const start = Math.max(0, all.length - h);
	all.forEach((line, i) => { if (line.img) images.push({ b: line.img, row: i - start }); });
	const shown = all.slice(start);
	const pane = st.pane.open ? paneLines(st, COLS - 50, h) : null;
	for (let r = 0; r < h; r++) {
		const left = shown[r] || sp(w);
		grid.push(pane ? [...fit(left, 49), ...L("⟦d|│⟧"), ...pane[r]] : left);
	}
	grid.push(...dock);
	if (st.overlay) {
		const o = overlayLines(st.overlay);
		const col = Math.floor((COLS - o.w) / 2), row = Math.max(2, Math.floor((ROWS - o.lines.length) / 2));
		o.lines.forEach((l, i) => grid[row + i].splice(col, o.w, ...fit(l, o.w)));
		// What the box covers is not drawn as a picture where it lies across it.
		st.overlayBox = { col, row, w: o.w, h: o.lines.length };
	}
	return { grid, images, bodyTop: 2, bodyRows: h, bodyCols: w };
}

function shellScreen(st) {
	const grid = [sp(COLS)];
	for (const s of st.shell.lines) for (let cells = L(s); cells.length || !grid.done; cells = cells.slice(COLS - 2)) {
		grid.push(fit([...sp(1), ...cells.slice(0, COLS - 2)], COLS));
		if (cells.length <= COLS - 2) break;
	}
	if (!st.shell.busy) grid.push(fit(L(` ${st.shell.prompt} ⟦a|❯⟧ ${st.shell.typed}█`), COLS));
	while (grid.length < ROWS) grid.push(sp(COLS));
	return { grid: grid.slice(-ROWS), images: [], bodyTop: 0, bodyRows: ROWS, bodyCols: COLS };
}

const screenOf = (st) => (st.mode === "pine" ? pineScreen(st) : shellScreen(st));

/** Where a piece of text is on screen at time t, as a point in the window: its middle. */
function find(needle, opts = {}) {
	const scr = screenOf(stateAt(opts.t ?? T));
	const hits = [];
	scr.grid.forEach((cells, row) => {
		const line = text(cells);
		for (let col = line.indexOf(needle); col >= 0; col = line.indexOf(needle, col + 1)) if (col >= (opts.minCol || 0)) hits.push({ row, col });
	});
	const hit = hits[(opts.nth ?? 1) - 1] ?? hits[hits.length - 1];
	if (!hit) throw new Error(`"${needle}" is not on screen at ${(opts.t ?? T).toFixed(2)}s`);
	return { x: ORIGIN.x + (hit.col + needle.length / 2) * CW + (opts.dx || 0), y: ORIGIN.y + (hit.row + 0.5) * RH + (opts.dy || 0) };
}

// ---- pointer and camera --------------------------------------------------------------------------

const keys = [], clicks = [], seen = [], captions = [], cam = [], MARKS = [], SFX = [];
/** A dice that falls the same way at every render, so that the typing sounds the same each time. */
let seed = 11;
const dice = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
/**
 * The sound of `s` being typed from now on, `cps` characters a second. The text may appear faster
 * than anyone types; the keys are heard at the pace of a hand, about ten a second and never
 * evenly. One sound per character at thirty a second is not typing but a purr.
 */
function keySounds(s, cps, kind = "key") {
	const dur = (s.length / cps) * PACE;
	for (let t = 0.02 + dice() * 0.03; t < dur || t < 0.06; ) {
		const ch = s[Math.min(s.length - 1, Math.floor((t / dur) * s.length))];
		SFX.push({ t: T + t, k: ch === " " ? `${kind}-space` : kind });
		// Mostly quick, now and then the short stop of a finger looking for its key.
		t += Math.max(1 / cps, dice() < 0.12 ? 0.17 + dice() * 0.08 : 0.068 + dice() * 0.07);
	}
}
const sound = (k, dt = 0) => SFX.push({ t: T + dt * PACE, k });
const mark = (name) => MARKS.push([T, name]);
const pointerAt = (t) => {
	if (!keys.length) return { x: 960, y: 540 };
	if (t <= keys[0].t) return keys[0];
	for (let i = 1; i < keys.length; i++) {
		if (t <= keys[i].t) {
			const a = keys[i - 1], b = keys[i], p = ease(clamp((t - b.t0) / Math.max(0.001, b.t - b.t0)));
			// A slight arc, as a hand moves.
			const bow = Math.sin(p * Math.PI) * Math.min(26, Math.hypot(b.x - a.x, b.y - a.y) * 0.06);
			return { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p) - bow };
		}
	}
	return keys[keys.length - 1];
};
const envelope = (t, list, ramp) => list.reduce((v, s) => Math.max(v, Math.min(clamp((t - s.from) / ramp), clamp((s.to - t) / ramp))), 0);
function pointerShow(p) { keys.push({ t: T, t0: T, x: p.x, y: p.y }); seen.push({ from: T, to: 1e9 }); }
function pointerHide() { seen[seen.length - 1].to = T; }
function moveTo(p, dur = 0.5) { dur *= PACE; keys.push({ t0: T, t: T + dur, x: p.x, y: p.y }); T += dur; }
function click(effect, pause = 0.12) { clicks.push(T); sound("click"); wait(pause); if (effect) inst(effect); }
function caption(s, dur) { captions.push({ from: T, to: T + dur * PACE, s }); }
/**
 * The camera: from now on it moves to look at (x, y) with this zoom, taking `dur` seconds. The
 * point is kept inside the picture: the camera never shows what lies beyond the stage.
 */
function shot(x, y, z = 1, dur = 0.9) {
	cam.push({ t: T, dur: Math.max(0.01, dur * PACE), z, x: clamp(x, 960 / z, 1920 - 960 / z), y: clamp(y, 540 / z, 1080 - 540 / z) });
}
/** Look at a point so that it lies at (ax, ay) of the picture, 0..1 each; the middle by default. */
function focus(p, z, dur = 0.9, ax = 0.5, ay = 0.5) { shot(p.x - (ax - 0.5) * 1920 / z, p.y - (ay - 0.5) * 1080 / z, z, dur); }
function cameraAt(t) {
	const step = (from, k, time) => { const p = ease(clamp((time - k.t) / k.dur)); return { x: lerp(from.x, k.x, p), y: lerp(from.y, k.y, p), z: lerp(from.z, k.z, p) }; };
	let from = { x: 960, y: 540, z: 1 }, v = from;
	for (let i = 0; i < cam.length && cam[i].t <= t; i++) {
		// Each move starts from wherever the camera was when it began.
		if (i) from = step(from, cam[i - 1], cam[i].t);
		v = step(from, cam[i], t);
	}
	return v;
}

// ---- drawing -------------------------------------------------------------------------------------

let SPEED = 1;
function renderAt(seconds) {
	const t = seconds * SPEED;
	const st = stateAt(t);
	const scr = screenOf(st);
	$("title").textContent = st.title;
	$("term").innerHTML = scr.grid.map((cells, r) => `<div class="r" style="top:${r * RH}px">${rowHTML(cells)}</div>`).join("");
	const imgs = $("imgs");
	imgs.style.top = `${50 + scr.bodyTop * RH}px`;
	imgs.style.width = `${scr.bodyCols * CW}px`;
	imgs.style.height = `${scr.bodyRows * RH}px`;
	const box = st.mode === "pine" && st.overlay ? st.overlayBox : null;
	imgs.innerHTML = scr.images.map(({ b, row }) => {
		const top = row * RH, wpx = b.cols * CW, hpx = b.rows * RH;
		// A menu over a picture: the part under it is cut away, the menu's cells are drawn in the grid.
		const clip = box ? `clip-path: polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${(box.col * CW)}px ${((box.row - scr.bodyTop) * RH - top)}px, ${(box.col * CW)}px ${((box.row + box.h - scr.bodyTop) * RH - top)}px, ${((box.col + box.w) * CW)}px ${((box.row + box.h - scr.bodyTop) * RH - top)}px, ${((box.col + box.w) * CW)}px ${((box.row - scr.bodyTop) * RH - top)}px, ${(box.col * CW)}px ${((box.row - scr.bodyTop) * RH - top)}px);` : "";
		if (b.k === "vid") {
			const n = Math.floor(Math.max(0, t - b.t0) * 10) % b.frames;
			const side = hpx;
			return `<div style="left:0;top:${top}px;width:${wpx}px;height:${hpx}px;background:#000;${clip}"><img src="assets/${b.src}-${String(n).padStart(2, "0")}.jpg" style="left:${(wpx - side) / 2}px;top:0;width:${side}px;height:${side}px"></div>`;
		}
		// Several pictures in one block (the pages of a document) stand side by side, two cells apart.
		return (b.srcs || [b.src]).map((src, i) => `<img src="assets/${src}" style="left:${i * (wpx + 2 * CW)}px;top:${top}px;width:${wpx}px;height:${hpx}px;${clip}">`).join("");
	}).join("");

	// window: dimmed and moved aside when something else is in front
	const win = $("win");
	win.style.left = `${WIN.x + st.winShift}px`;
	win.style.top = `${WIN.y}px`;
	win.style.width = `${WIN.w}px`;
	win.style.height = `${WIN.h}px`;
	win.style.filter = st.winDim ? `brightness(${1 - 0.45 * st.winDim})` : "";
	win.style.transformOrigin = "0 50%";
	win.style.transform = st.winScale ? `scale(${1 - st.winScale})` : "";

	// the editor
	const vs = $("vs");
	vs.style.display = st.vs.show > 0.001 ? "block" : "none";
	if (st.vs.show > 0.001) {
		const p = ease(st.vs.show);
		vs.style.opacity = p;
		vs.style.transform = `translate(${(1 - p) * 60}px, ${(1 - p) * 90}px) scale(${0.94 + 0.06 * p})`;
		const add = VS.add.slice(0, st.vs.typed);
		$("vsed").innerHTML = VS.lines.map((s, i) => `<div class="${i === 2 ? "cur" : ""} ${i === 2 && st.vs.typed ? "chg" : ""}"><n>${i + 1}</n>${s}${i === 2 ? `${escape(add)}${Math.floor(t * 2.2) % 2 || st.vs.typing ? '<span class="caret"></span>' : ""}` : ""}</div>`).join("");
		$("vsdot").textContent = st.vs.dirty ? "●" : "×";
		$("vsfile").className = st.vs.typed ? "sel mod" : "sel";
		$("vsfile").lastChild.textContent = st.vs.typed && !st.vs.dirty ? "M" : st.vs.typed ? "M" : "";
		$("vscol").textContent = 57 + add.length;
	}

	// the phone
	const ph = $("phone");
	ph.style.display = st.phone.show > 0.001 ? "block" : "none";
	if (st.phone.show > 0.001) {
		const p = ease(st.phone.show);
		ph.style.transform = `translate(${(1 - p) * 520}px, ${(1 - p) * 30}px) rotate(${(1 - p) * 4}deg)`;
		$("msgs").innerHTML = st.phone.msgs.map((m) => {
			const a = ease(clamp(m.p * 1.0));
			const style = `opacity:${a};transform:translateY(${(1 - a) * 22}px) scale(${0.96 + 0.04 * a});transform-origin:${m.me ? "100% 100%" : "0 100%"}`;
			if (m.typing) return `<div class="msg in ty" style="${style}">•••</div>`;
			return `<div class="msg ${m.me ? "out" : "in"}" style="${style}">${m.html}<small>${m.time}${m.me ? " ✓✓" : ""}</small></div>`;
		}).join("");
		$("phin").textContent = st.phone.input || "Message";
		$("phin").className = st.phone.input ? "has" : "";
		$("phtime").textContent = st.phone.clock || "17:42";
	}

	// Finder, and Quick Look over it
	const fd = $("finder"), fs = st.finder;
	fd.style.display = fs.show > 0.001 ? "block" : "none";
	if (fs.show > 0.001) {
		const p = ease(fs.show);
		fd.style.opacity = p;
		fd.style.transform = `translate(${(1 - p) * 40}px, ${(1 - p) * 70}px) scale(${0.95 + 0.05 * p})`;
		$("frows").innerHTML = fs.rows.map((r, i) => `<div class="fr${i === fs.sel ? " sel" : ""}" style="top:${86 + i * 30}px"><span style="left:8px"><i class="ic${r.dir ? " dir" : ""}"></i>${r.name}</span><span class="c2">${r.date}</span><span class="c3">${r.size}</span><span class="c4">${r.kind}</span></div>`).join("");
	}
	const ql = $("ql");
	ql.style.display = fs.ql > 0.001 ? "block" : "none";
	if (fs.ql > 0.001) {
		const p = ease(fs.ql);
		ql.style.opacity = p;
		ql.style.transform = `scale(${0.6 + 0.4 * p})`;
		$("qltext").innerHTML = fs.text;
	}

	// a clip filmed on a phone, cut in over the whole picture: its frames are pictures in assets/<src>/,
	// 001.jpg on, at `fps` frames a second of the finished film
	const clip = $("clip");
	const cs = st.clip;
	clip.style.display = cs && cs.show > 0.001 ? "block" : "none";
	if (cs && cs.show > 0.001) {
		clip.style.opacity = ease(cs.show);
		const s = Math.max(0, t - cs.t0) / SPEED;
		const n = Math.round(clamp(s * cs.fps, 0, cs.frames - 1)) + 1;
		clip.firstChild.src = `assets/${cs.src}/${String(n).padStart(3, "0")}.jpg`;
		clip.firstChild.style.transform = `scale(${1.0 + 0.04 * clamp(s / (cs.frames / cs.fps))})`;
	}

	// pointer, what it drags, the ring of a click
	const vis = envelope(t, seen, 0.18);
	const pt = pointerAt(t);
	const cur = $("cursor");
	cur.style.opacity = vis;
	const sinceClick = Math.min(...clicks.map((c) => (t >= c ? t - c : 9)), 9);
	const press = sinceClick < 0.16 ? 1 - 0.14 * Math.sin((sinceClick / 0.16) * Math.PI) : 1;
	cur.style.transform = `translate(${pt.x - 5}px, ${pt.y - 3}px) scale(${press})`;
	const ring = $("ring");
	ring.style.opacity = sinceClick < 0.42 ? (1 - sinceClick / 0.42) * 0.9 : 0;
	ring.style.transform = `translate(${pt.x}px, ${pt.y}px) scale(${0.25 + 0.9 * ease(clamp(sinceClick / 0.42))})`;
	const drag = $("drag");
	drag.style.display = st.drag ? "block" : "none";
	if (st.drag) {
		const a = st.drag.p ?? 1;
		drag.style.opacity = a;
		drag.style.transform = `translate(${pt.x - 60}px, ${pt.y - 46}px) scale(${(0.55 + 0.45 * a) * 1.45}) rotate(-4deg)`;
		drag.innerHTML = `${st.drag.kind === "pdf" ? '<div class="doc"></div>' : `<div class="thumb" style="background-image:url(assets/${st.drag.src})"></div>`}<span class="name">${st.drag.name}</span>`;
	}

	// the camera
	const view = cameraAt(t);
	$("world").style.transform = `translate(${960 - view.x * view.z}px, ${540 - view.y * view.z}px) scale(${view.z})`;

	const cap = captions.map((c) => ({ c, v: Math.min(clamp((t - c.from) / 0.35), clamp((c.to - t) / 0.35)) })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v)[0];
	$("caption").innerHTML = cap ? `<span>${escape(cap.c.s)}</span>` : "";
	$("caption").style.opacity = cap ? ease(cap.v) : 0;
	$("card").style.display = st.card > 0.001 ? "flex" : "none";
	$("card").style.opacity = st.card;
	$("cardtext").innerHTML = st.cardText;
	$("outro").style.opacity = ease(st.outro);
	$("outro").style.display = st.outro > 0.001 ? "flex" : "none";
	return st;
}
