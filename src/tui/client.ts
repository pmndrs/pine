import type { PineEvent, Task, TaskResult, TranscriptEntry } from "../types.ts";
import type { TurnView, UndoResult } from "../undo.ts";

/** One conversation of an agent. `expires`: when it is removed by itself unless something more is said in it. */
export interface Conversation {
	session: string;
	tasks: number;
	last: number;
	pinned: boolean;
	open: boolean;
	expires?: number;
	/** The folder opened for it, if any. */
	folder?: string;
}

/** The goal of a conversation, as the daemon keeps it (src/goals.ts). `reason` is the judge's line: text to show, nothing more. */
export interface GoalInfo {
	agent: string;
	session: string;
	objective: string;
	status: "active" | "paused" | "met" | "blocked" | "limit";
	round: number;
	until: number;
	note: string;
	reason?: string;
}

export interface AgentInfo {
	id: string;
	main: boolean;
	description: string;
	workspace: string;
	model: string;
	mode: "manual" | "safe" | "auto" | "bypass" | "plan";
	thinking: string;
	delegates: string[];
}

/** Talks to a pine daemon over its control API. */
export class Client {
	base: string;
	private token: string;

	constructor(base: string, token: string) {
		this.base = base.replace(/\/$/, "");
		this.token = token;
	}

	private async call<T>(method: string, url: string, body?: unknown): Promise<T> {
		const res = await fetch(this.base + url, {
			method,
			headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		const json: any = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
		return json as T;
	}

	/** A picture from the daemon, or undefined when there is none (or it is not an image). */
	private async picture(method: string, url: string, body?: unknown): Promise<{ mime: string; bytes: Buffer } | undefined> {
		const res = await fetch(this.base + url, {
			method,
			headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		if (res.status === 404) return undefined;
		if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).error ?? `HTTP ${res.status}`);
		return { mime: res.headers.get("content-type") ?? "", bytes: Buffer.from(await res.arrayBuffer()) };
	}
	toolImage = (id: string) => this.picture("GET", `/media/tool/${encodeURIComponent(id)}`);
	taskImage = (task: number, n: number) => this.picture("GET", `/tasks/${task}/images/${n}`);
	workspaceImage = (agent: string, file: string, session?: string) => this.picture("GET", `/agents/${encodeURIComponent(agent)}/image?path=${encodeURIComponent(file)}${session ? `&session=${encodeURIComponent(session)}` : ""}`);
	fetchImage = (url: string) => this.picture("POST", "/images/fetch", { url });

	sources = () => this.get<any[]>("/sources");
	subscribeTo = (agent: string, source: string, details: Record<string, unknown> = {}) => this.post<any>(`/agents/${agent}/subscribe`, { source, ...details });
	unsubscribeFrom = (agent: string, source: string, session?: string) => this.post<{ unsubscribed: boolean; sessions: string[] }>(`/agents/${agent}/unsubscribe`, { source, session });
	subscribeAll = (source: string, details: Record<string, unknown> = {}) => this.post<any>("/subscribe", { source, ...details });
	unsubscribeAll = (source: string) => this.post<{ unsubscribed: boolean }>("/unsubscribe", { source });
	/** Tell the daemon a conversation was closed here; returns the sources it was subscribed to on its own. */
	closeSession = (agent: string, session: string) => this.post<{ unsubscribed: string[] }>(`/agents/${agent}/close`, { session });

	get = <T>(url: string) => this.call<T>("GET", url);
	post = <T>(url: string, body: unknown = {}) => this.call<T>("POST", url, body);

	agents = () => this.get<AgentInfo[]>("/agents");
	status = () => this.get<any>("/status");
	models = () => this.get<string[]>("/models");
	sessions = (agent: string) => this.get<Conversation[]>(`/agents/${agent}/sessions`);
	removeSession = (agent: string, session: string) => this.post<{ removed: boolean; unsubscribed: string[]; sources: string[]; servers: string[] }>(`/agents/${agent}/remove`, { session });
	renameSession = (agent: string, session: string, to: string) => this.post<{ session: string }>(`/agents/${agent}/rename`, { session, to });
	pinSession = (agent: string, session: string, pinned: boolean) => this.post<{ pinned: boolean }>(`/agents/${agent}/pin`, { session, pinned });
	folder = (agent: string, session: string) => this.get<{ folder?: string; workspace: string }>(`/agents/${agent}/folder?session=${encodeURIComponent(session)}`);
	programs = (agent: string, session: string) => this.get<Array<{ id: number; command: string; processes: number; ports: number[]; seconds: number; background?: boolean; output?: string }>>(`/agents/${agent}/programs?session=${encodeURIComponent(session)}`);
	goal = (agent: string, session: string) => this.get<{ goal?: GoalInfo }>(`/agents/${agent}/goal?session=${encodeURIComponent(session)}`);
	/** Set a goal (`objective`), or pause, resume or clear the one there is (`action`). */
	setGoal = (agent: string, session: string, what: { objective: string } | { action: "pause" | "resume" | "clear" }) => this.post<{ goal?: GoalInfo; cleared?: boolean }>(`/agents/${agent}/goal`, { session, ...what });
	stopProgram = (agent: string, session: string, id: number) => this.post<{ stopped: boolean }>(`/agents/${agent}/programs/stop`, { session, id });
	folders = (agent: string) => this.get<Array<{ session: string; folder: string }>>(`/agents/${agent}/folders`);
	setFolder = (agent: string, session: string, folder: string | null) => this.post<{ folder?: string }>(`/agents/${agent}/folder`, { session, folder });
	changes = (agent: string, session: string) => this.get<{ root: string; repo: boolean; branch?: string; files: Array<{ path: string; status: string; added?: number; removed?: number }>; more: boolean }>(`/agents/${agent}/view/changes?session=${encodeURIComponent(session)}`);
	diff = (agent: string, session: string, file: string) => this.get<{ diff: string; truncated: boolean }>(`/agents/${agent}/view/diff?session=${encodeURIComponent(session)}&path=${encodeURIComponent(file)}`);
	tree = (agent: string, session: string, dir: string) => this.get<{ entries: Array<{ name: string; dir: boolean; size: number }>; more: boolean }>(`/agents/${agent}/view/tree?session=${encodeURIComponent(session)}&path=${encodeURIComponent(dir)}`);
	file = (agent: string, session: string, file: string) => this.get<{ text?: string; size: number; binary: boolean; truncated: boolean }>(`/agents/${agent}/view/file?session=${encodeURIComponent(session)}&path=${encodeURIComponent(file)}`);
	/** Take back the owner's last message in a conversation, and bring back what was taken back last. */
	undo = (agent: string, session: string) => this.post<UndoResult>(`/agents/${agent}/undo`, { session });
	redo = (agent: string, session: string) => this.post<UndoResult>(`/agents/${agent}/redo`, { session });
	/** What the last message changed in the conversation's folder, and one file's difference over it. */
	turn = (agent: string, session: string) => this.get<TurnView>(`/agents/${agent}/view/turn?session=${encodeURIComponent(session)}`);
	turnDiff = (agent: string, session: string, file: string) => this.get<{ diff: string; truncated: boolean }>(`/agents/${agent}/view/turndiff?session=${encodeURIComponent(session)}&path=${encodeURIComponent(file)}`);
	output = (task: number) => this.get<{ task: Task; entries: TranscriptEntry[] }>(`/tasks/${task}/transcript?full=1`);
	tabs = () => this.get<{ tabs: Array<{ agent: string; session: string }>; active: number; code?: boolean; notify?: boolean }>("/ui/tabs");
	saveTabs = (tabs: Array<{ agent: string; session: string }>, active: number, code = false, notify = true) => this.post<{ ok: boolean }>("/ui/tabs", { tabs, active, code, notify });
	history = (agent: string, session: string, limit = 30) => this.get<Task[]>(`/tasks?agent=${encodeURIComponent(agent)}&session=${encodeURIComponent(session)}&limit=${limit}`);
	prompt = (agent: string, prompt: string, session: string, attachments?: Array<{ name: string; data: string }>, whenBusy: "steer" | "queue" = "queue", mentions?: string[]) => this.post<{ task: number; steered?: number }>(`/agents/${agent}/prompt`, { prompt, session, wait: false, attachments, whenBusy, mentions });
	/** Files of a conversation's folder whose path fits what was typed. */
	find = (agent: string, session: string, q: string) => this.get<{ files: string[] }>(`/agents/${agent}/view/find?session=${encodeURIComponent(session)}&q=${encodeURIComponent(q)}`);
	ask = (agent: string, prompt: string, session: string) => this.post<TaskResult>(`/agents/${agent}/prompt`, { prompt, session });
	transcript = (task: number) => this.get<{ task: Task; entries: TranscriptEntry[] }>(`/tasks/${task}/transcript`);
	cancel = (task: number) => this.post<{ cancelled: boolean }>(`/tasks/${task}/cancel`);
	reset = (agent: string, session: string) => this.post<{ reset: boolean }>(`/agents/${agent}/reset`, { session });
	todos = (agent: string, session: string) => this.get<Array<{ text: string; status: "pending" | "in_progress" | "done" }>>(`/agents/${agent}/todos?session=${encodeURIComponent(session)}`);
	compact = (agent: string, session: string) => this.post<{ task: number }>(`/agents/${agent}/compact`, { session });
	setThinking = (agent: string, level: string) => this.post<{ level: string }>(`/agents/${agent}/thinking`, { level });
	setMode = (agent: string, mode: string, anyway?: string) => this.post<{ mode: string }>(`/agents/${agent}/mode`, { mode, session: anyway, anyway: anyway !== undefined });
	setModel = (agent: string, model: string) => this.post<{ model: string }>(`/agents/${agent}/model`, { model });
	approvals = () => this.get<any[]>("/approvals");
	decide = (id: string, allow: boolean, always = false, values?: Record<string, string>) => this.post<{ decided: boolean }>(`/approvals/${id}`, { allow, always, values });
	emit = (topic: string, payload: unknown) => this.post<{ id: number }>("/events", { topic, payload });
	state = (pattern = "#") => this.get<Array<{ key: string; value: unknown }>>(`/state?key=${encodeURIComponent(pattern)}`);

	/** Live events. Reconnects until the returned function is called. */
	subscribe(onEvent: (e: PineEvent) => void, onState: (connected: boolean) => void = () => {}): () => void {
		const abort = new AbortController();
		const loop = async () => {
			while (!abort.signal.aborted) {
				try {
					const res = await fetch(`${this.base}/events/stream?topic=%23`, { headers: { authorization: `Bearer ${this.token}` }, signal: abort.signal });
					if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
					onState(true);
					let buf = "";
					const decoder = new TextDecoder();
					for await (const chunk of res.body as any) {
						buf += decoder.decode(chunk, { stream: true });
						for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
							const block = buf.slice(0, i);
							buf = buf.slice(i + 2);
							if (!block.startsWith("data: ")) continue;
							try {
								onEvent(JSON.parse(block.slice(6)));
							} catch {
								// A malformed frame is skipped; the stream goes on.
							}
						}
					}
				} catch {
					// fall through to the retry
				}
				if (abort.signal.aborted) return;
				onState(false);
				await new Promise((r) => setTimeout(r, 1000));
			}
		};
		void loop();
		return () => abort.abort();
	}
}
