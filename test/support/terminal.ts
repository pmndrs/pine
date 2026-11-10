import type { Terminal } from "@earendil-works/pi-tui";

/** A terminal that exists only in memory: tests type into it and read the screen from the TUI. */
export class FakeTerminal implements Terminal {
	columns: number;
	rows: number;
	written = "";
	private onInput?: (data: string) => void;

	constructor(columns = 100, rows = 30) {
		this.columns = columns;
		this.rows = rows;
	}

	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}
	stop(): void {
		this.onInput = undefined;
	}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.written += data;
		if (this.written.length > 200_000) this.written = this.written.slice(-100_000);
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}

	/** Left-click the cell at zero-based column x, row y. */
	click(x: number, y: number): void {
		this.onInput?.(`\x1b[<0;${x + 1};${y + 1}M`);
		this.onInput?.(`\x1b[<0;${x + 1};${y + 1}m`);
	}

	/** What a terminal sends when text is pasted or files are dropped on it. */
	paste(text: string): void {
		this.onInput?.(`\x1b[200~${text}\x1b[201~`);
	}

	/** Press keys one at a time. A string is typed character by character; an array is sent as raw sequences. */
	type(keys: string | string[]): void {
		for (const k of Array.isArray(keys) ? keys : [...keys]) this.onInput?.(k);
	}
}

export const KEY = { enter: "\r", esc: "\x1b", tab: "\t", shiftTab: "\x1b[Z", ctrlC: "\x03", ctrlD: "\x04", ctrlT: "\x14", ctrlW: "\x17", down: "\x1b[B", up: "\x1b[A", alt: (n: number) => `\x1b${n}` };
