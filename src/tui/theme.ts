import { type EditorTheme, Markdown, type MarkdownTheme, type SelectListTheme, visibleWidth } from "@earendil-works/pi-tui";
import { highlightCode } from "./highlight.ts";

const on = !process.env.NO_COLOR;
const sgr = (open: string, close: string) => (s: string) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : s);

/** Plain 16/256-colour styling, so the UI follows the terminal's own palette. */
export const c = {
	bold: sgr("1", "22"),
	dim: sgr("2", "22"),
	italic: sgr("3", "23"),
	underline: sgr("4", "24"),
	inverse: sgr("7", "27"),
	strike: sgr("9", "29"),
	red: sgr("31", "39"),
	green: sgr("32", "39"),
	yellow: sgr("33", "39"),
	blue: sgr("34", "39"),
	magenta: sgr("35", "39"),
	cyan: sgr("36", "39"),
	gray: sgr("90", "39"),
	accent: sgr("38;5;114", "39"),
	bgPanel: sgr("48;5;236", "49"),
	bgUser: sgr("48;5;237", "49"),
	bgAccent: sgr("48;5;114;30", "49;39"),
};

export const selectTheme: SelectListTheme = {
	selectedPrefix: c.accent,
	selectedText: (s) => c.bold(c.accent(s)),
	description: c.gray,
	scrollInfo: c.gray,
	noMatch: c.gray,
};

export const editorTheme: EditorTheme = { borderColor: c.gray, selectList: selectTheme };

/** Marks a line that only held a code block's backticks. A private-use character: no text contains it. */
const FENCE = "\uE000";

export const markdownTheme: MarkdownTheme = {
	// From the third level on, the library puts the "###" in front as a piece of its own. It is markup, so it is left out.
	heading: (s) => (/^(?:\x1b\[[0-9;]*m)*#{3,6} (?:\x1b\[[0-9;]*m)*$/.test(s) ? "" : c.bold(c.accent(s))),
	link: c.cyan,
	linkUrl: c.gray,
	code: c.yellow,
	codeBlock: (s) => s,
	// A code block is a bar down its left side with its language above it. The lines of backticks
	// around it are markup, not content: the opening one becomes the language, the others are
	// marked here and left out by Answer below.
	codeBlockBorder: (s) => {
		const lang = s.replace(/^[`~]+/, "").trim();
		return lang ? c.gray(lang) : FENCE;
	},
	codeBlockIndent: c.gray("│ "),
	highlightCode,
	quote: c.italic,
	quoteBorder: c.gray,
	hr: c.gray,
	listBullet: c.accent,
	bold: c.bold,
	italic: c.italic,
	strikethrough: c.strike,
	underline: c.underline,
};

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Markdown from an agent or a tool, drawn: headings, lists, tables, quotes, and code in colour. */
export class Answer extends Markdown {
	private from?: string[];
	private drawn: string[] = [];

	constructor(text: string) {
		super(text, 1, 0, markdownTheme);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines !== this.from) {
			this.from = lines;
			this.drawn = lines.some((l) => l.includes(FENCE)) ? lines.filter((l) => !l.includes(FENCE)) : lines;
		}
		return this.drawn;
	}
}

// Two things the library's tables leave out, added where it wraps a cell's text to its column:
// a <br>, which models write for a line break inside a cell, becomes that break; and a column
// that the table's second line aligns to the right ("---:") or centres (":---:") is set that way.
const proto = Markdown.prototype as any;
const wrapCell = proto.wrapCellText as ((text: string, width: number, stylePrefix?: string) => string[]) | undefined;
const drawTable = proto.renderTable as ((token: any, ...rest: unknown[]) => string[]) | undefined;
const inline = proto.renderInlineTokens as ((...args: unknown[]) => string) | undefined;
const BR = /\s*<br\s*\/?>\s*/i;
if (wrapCell && drawTable && inline) {
	const own = Answer.prototype as any;
	own.renderTable = function (this: any, token: any, ...rest: unknown[]): string[] {
		// The library first reads every cell once to size the columns, then once more, cell after
		// cell and row by row, to draw them. Counting says which of the two it is doing, and which
		// column a cell is in.
		const cells = (token?.header?.length ?? 0) + (token?.rows ?? []).reduce((n: number, row: unknown[]) => n + row.length, 0);
		this.table = { align: Array.isArray(token?.align) ? token.align : [], columns: token?.header?.length || 1, cell: 0, sizing: cells, depth: 0 };
		try {
			return drawTable.call(this, token, ...rest);
		} finally {
			this.table = undefined;
		}
	};
	own.renderInlineTokens = function (this: any, ...args: unknown[]): string {
		const table = this.table;
		if (!table) return inline.apply(this, args);
		table.depth++;
		let text: string;
		try {
			text = inline.apply(this, args);
		} finally {
			table.depth--;
		}
		if (table.depth > 0 || table.sizing <= 0) return text;
		table.sizing--;
		// A cell with line breaks is as wide as its longest line, not as all of them in a row.
		return BR.test(text) ? text.split(BR).reduce((a, b) => (visibleWidth(b) > visibleWidth(a) ? b : a)) : text;
	};
	own.wrapCellText = function (this: any, text: string, width: number, stylePrefix?: string): string[] {
		const lines = text.split(BR).flatMap((part) => wrapCell.call(this, part, width, stylePrefix));
		const side = this.table ? this.table.align[this.table.cell++ % this.table.columns] : undefined;
		if (side !== "right" && side !== "center") return lines;
		return lines.map((line) => {
			const free = Math.max(0, width - visibleWidth(line));
			return " ".repeat(side === "right" ? free : Math.floor(free / 2)) + line;
		});
	};
}
