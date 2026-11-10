import type { PineEvent, Task, TaskResult, TranscriptEntry } from "../types.ts";

/** One conversation of an agent. `expires`: when it is removed by itself unless something more is said in it. */
export interface Conversation {
	session: string;
	tasks: number;
	last: number;
	pinned: boolean;
	open: boolean;
	expires?: number;
}

export interface AgentInfo {
	id: string;
	main: boolean;
	description: string;
	workspace: string;
	model: string;
	mode: "manual" | "auto" | "bypass";
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
	workspaceImage = (agent: string, file: string) => this.picture("GET", `/agents/${encodeURIComponent(agent)}/image?path=${encodeURIComponent(file)}`);
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
	tabs = () => this.get<{ tabs: Array<{ agent: string; session: string }>; active: number }>("/ui/tabs");
	saveTabs = (tabs: Array<{ agent: string; session: string }>, active: number) => this.post<{ ok: boolean }>("/ui/tabs", { tabs, active });
	history = (agent: string, session: string, limit = 30) => this.get<Task[]>(`/tasks?agent=${encodeURIComponent(agent)}&session=${encodeURIComponent(session)}&limit=${limit}`);
	prompt = (agent: string, prompt: string, session: string, attachments?: Array<{ name: string; data: string }>) => this.post<{ task: number }>(`/agents/${agent}/prompt`, { prompt, session, wait: false, attachments });
	ask = (agent: string, prompt: string, session: string) => this.post<TaskResult>(`/agents/${agent}/prompt`, { prompt, session });
	transcript = (task: number) => this.get<{ task: Task; entries: TranscriptEntry[] }>(`/tasks/${task}/transcript`);
	cancel = (task: number) => this.post<{ cancelled: boolean }>(`/tasks/${task}/cancel`);
	reset = (agent: string, session: string) => this.post<{ reset: boolean }>(`/agents/${agent}/reset`, { session });
	setThinking = (agent: string, level: string) => this.post<{ level: string }>(`/agents/${agent}/thinking`, { level });
	setMode = (agent: string, mode: string, anyway?: string) => this.post<{ mode: string }>(`/agents/${agent}/mode`, { mode, session: anyway, anyway: anyway !== undefined });
	setModel = (agent: string, model: string) => this.post<{ model: string }>(`/agents/${agent}/model`, { model });
	approvals = () => this.get<any[]>("/approvals");
	decide = (id: string, allow: boolean, always = false) => this.post<{ decided: boolean }>(`/approvals/${id}`, { allow, always });
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
