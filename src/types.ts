/** Where a handler's answer should go: an event on `topic` whose payload is `payload` plus `text`. */
export interface ReplyTarget {
	topic: string;
	payload?: Record<string, unknown>;
}

export interface PineEvent {
	/** Row id in the event log; 0 for events published with `persist: false`. */
	id: number;
	ts: number;
	topic: string;
	/** Who published it: a plugin name, "router", "timer", "http", or "agent:<id>". */
	source: string;
	payload: unknown;
	/** Id of the event that led to this one. */
	cause?: number;
	/** How many agent or router steps separate this event from an outside trigger. */
	hops: number;
	reply?: ReplyTarget;
	/**
	 * "owner": the content was written by a person the configuration names as owner (an
	 * allow-listed chat user, the authenticated control API, a schedule). Everything else is
	 * "untrusted": data that may try to give instructions.
	 */
	trust: Trust;
}

export type Trust = "owner" | "untrusted";

export interface PublishOptions {
	source?: string;
	cause?: PineEvent | null;
	reply?: ReplyTarget;
	/** false keeps the event out of the log (telemetry, progress). Subscribers still get it. */
	persist?: boolean;
	/** Set when the publisher is acting for an agent or a route, so loops can be cut. */
	hop?: boolean;
	/** Default "untrusted". */
	trust?: Trust;
}

export type TaskStatus = "pending" | "running" | "done" | "failed" | "cancelled";
export type TaskKind = "event" | "prompt" | "delegate" | "subagent" | "notify";

export interface ImageRef {
	/** Absolute file path, or base64 data when `data` is set. */
	path?: string;
	data?: string;
	mimeType: string;
}

export interface TaskMeta {
	images?: ImageRef[];
	/** Deliver the result to this agent session as a new message when the task ends. */
	notify?: { agent: string; session: string };
	/** Agents above this task in the delegation chain, outermost first. */
	chain?: string[];
	/** The task at the top of this task's delegation tree (its own id for a top-level task). */
	root?: number;
	/** Child sessions of a sub-agent get no delegation tools and an optional narrower tool list. */
	leaf?: boolean;
	tools?: string[];
	label?: string;
	/** Trust of whatever started this task. Children inherit the weaker of theirs and their parent's. */
	trust?: Trust;
	/** The session that created this task had already seen outside content. */
	tainted?: string;
	/** `input` is what the model server had to read anew; `cached` is what it took from its prompt cache. */
	stats?: { input: number; output: number; cached?: number; turns: number; tools: string[]; ms: number; context?: ContextUse };
}

/** How full a session's context window is. `percent` is missing right after a compaction. */
export interface ContextUse {
	tokens?: number;
	window: number;
	percent?: number;
}

export interface Task {
	id: number;
	agent: string;
	/** Session key. Ephemeral sessions use "_t<id>". */
	session: string;
	kind: TaskKind;
	prompt: string;
	status: TaskStatus;
	priority: number;
	created: number;
	started?: number;
	finished?: number;
	result?: string;
	error?: string;
	event?: number;
	hops: number;
	parent?: number;
	depth: number;
	reply?: ReplyTarget;
	meta: TaskMeta;
}

/** One step of a task as its session recorded it: what it was given, what it wrote, what it called. */
export interface TranscriptEntry {
	kind: "user" | "text" | "thinking" | "tool";
	text?: string;
	tool?: string;
	subject?: string;
	/** For a tool call: missing while it runs. */
	ok?: boolean;
	/** Pictures the tool returned, by the id the control API serves them under (GET /media/tool/<id>). */
	images?: string[];
	ms?: number;
	result?: string;
}

export interface TaskResult {
	id: number;
	agent: string;
	status: TaskStatus;
	text: string;
	error?: string;
	/** Set when the run handled outside content; the reason names the first source. */
	tainted?: string;
}
