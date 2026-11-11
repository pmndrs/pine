import crypto from "node:crypto";
import http from "node:http";
import type { AgentManager } from "./agents.ts";
import { mainAgentId, type PineConfig } from "./config.ts";
import { type Approvals, timingSafeEqual } from "./security.ts";
import type { Bus, State, TaskStore } from "./store.ts";
import { addServer, listServers, removeServer } from "./mcp-config.ts";
import { changes, diffOf, listDir, readText } from "./workspace-view.ts";
import type { SourceHost } from "./sources.ts";
import { errText, type Logger, topicMatches } from "./util.ts";

const MAX_BODY = 1024 * 1024;

class HttpError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/**
 * Control API and webhooks. Every request except /health and /hook/* needs the bearer token.
 * Requests that come from a web page (an Origin header, a foreign Host) are refused, so a site
 * open in a browser on this machine cannot drive the daemon.
 */
export class HttpServer {
	private cfg: PineConfig;
	private bus: Bus;
	private state: State;
	private tasks: TaskStore;
	private manager: AgentManager;
	private approvals: Approvals;
	private log: Logger;
	private token: string;
	private server?: http.Server;
	private hits = new Map<string, number[]>();
	port = 0;

	private sources?: SourceHost;

	constructor(deps: { cfg: PineConfig; bus: Bus; state: State; tasks: TaskStore; manager: AgentManager; approvals: Approvals; sources?: SourceHost; log: Logger; token: string }) {
		this.sources = deps.sources;
		this.cfg = deps.cfg;
		this.bus = deps.bus;
		this.state = deps.state;
		this.tasks = deps.tasks;
		this.manager = deps.manager;
		this.approvals = deps.approvals;
		this.log = deps.log;
		this.token = deps.token;
	}

	async start(): Promise<void> {
		const { host, port } = this.cfg.http!;
		this.server = http.createServer((req, res) => void this.handle(req, res));
		this.server.requestTimeout = 30_000;
		this.server.headersTimeout = 10_000;
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(port, host, resolve);
		});
		this.port = (this.server.address() as any).port;
		// With port 0 the system picked one. Others ask the configuration where the control port is
		// (the browser gate never opens it).
		this.cfg.http!.port = this.port;
		this.log.info(`http listening on ${host}:${this.port}`);
	}

	async stop(): Promise<void> {
		this.server?.closeAllConnections?.();
		await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const send = (status: number, body: unknown) => {
			if (res.headersSent) return;
			res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
			res.end(JSON.stringify(body));
		};
		const sendPicture = (p: { mime: string; bytes: Buffer } | undefined) => {
			if (!p) return send(404, { error: "no such picture" });
			res.writeHead(200, { "content-type": p.mime, "content-length": p.bytes.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
			res.end(p.bytes);
		};
		try {
			const url = new URL(req.url ?? "/", "http://pine.local");
			const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
			const method = req.method ?? "GET";

			if (method === "GET" && url.pathname === "/health") return send(200, { ok: true });
			if (parts[0] === "hook" && parts.length === 2 && method === "POST") return send(202, await this.hook(parts[1], req));

			this.guardBrowser(req);
			const auth = req.headers.authorization ?? "";
			if (!auth.startsWith("Bearer ") || !timingSafeEqual(auth.slice(7), this.token)) throw new HttpError(401, "missing or wrong bearer token");

			if (method === "GET") {
				const q = url.searchParams;
				const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
				if (url.pathname === "/status") return send(200, { ...this.manager.status(), agents: Object.keys(this.cfg.agents), approvals: this.approvals.pending().length, bypassWhenTainted: this.cfg.security.bypassWhenTainted });
				if (url.pathname === "/agents") return send(200, Object.values(this.cfg.agents).map((a) => ({ id: a.id, main: a.id === mainAgentId(this.cfg), description: a.description, workspace: a.workspace, model: a.model ?? this.cfg.defaults.model, thinking: a.thinking, mode: a.mode, delegates: a.delegates })));
				if (url.pathname === "/tasks") return send(200, this.tasks.list({ agent: q.get("agent") ?? undefined, session: q.get("session") ?? undefined, status: (q.get("status") as any) ?? undefined, limit: num("limit") }));
				if (url.pathname === "/models") return send(200, await this.manager.availableModels());
				if (url.pathname === "/mcp") return send(200, listServers(this.cfg));
				if (url.pathname === "/sources") return send(200, this.sources?.list() ?? []);
				if (parts[0] === "agents" && parts[2] === "sources" && parts.length === 3) {
					if (!this.cfg.agents[parts[1]]) throw new HttpError(404, "no such agent");
					return send(200, this.sources?.available(parts[1]) ?? []);
				}
				if (parts[0] === "agents" && parts[2] === "sessions" && parts.length === 3) {
					if (!this.cfg.agents[parts[1]]) throw new HttpError(404, "no such agent");
					return send(200, this.manager.conversations(parts[1]));
				}
				if (url.pathname === "/ui/tabs") return send(200, this.manager.uiTabs());
				if (parts[0] === "tasks" && parts[2] === "transcript" && parts.length === 3) {
					const t = this.manager.transcript(Number(parts[1]), q.get("full") === "1");
					return t ? send(200, t) : send(404, { error: "no such task" });
				}
				// Pictures for a UI to show. They are never sent to a model from here.
				if (parts[0] === "media" && parts[1] === "tool" && parts.length === 3) return sendPicture(this.manager.toolImage(parts[2]));
				if (parts[0] === "tasks" && parts[2] === "images" && parts.length === 4) return sendPicture(this.manager.taskImage(Number(parts[1]), Number(parts[3])));
				if (parts[0] === "agents" && parts[2] === "image" && parts.length === 3) return sendPicture(this.manager.workspaceImage(parts[1], q.get("path") ?? "", q.get("session") ?? undefined));
				// The folder a conversation works in, and what a UI shows of it: files, and what git says changed.
				if (parts[0] === "agents" && parts[2] === "folder" && parts.length === 3) {
					if (!this.cfg.agents[parts[1]]) throw new HttpError(404, "no such agent");
					return send(200, { folder: this.manager.folderOf(parts[1], q.get("session") ?? "main"), workspace: this.cfg.agents[parts[1]].workspace });
				}
				// What a conversation's commands left running, for a UI to show and to stop.
				if (parts[0] === "agents" && parts[2] === "programs" && parts.length === 3) {
					if (!this.cfg.agents[parts[1]]) throw new HttpError(404, "no such agent");
					return send(200, this.manager.programsOf(parts[1], q.get("session") ?? "main"));
				}
				// What the reviewer blocked in a conversation, for a UI to show and the owner to allow.
				if (parts[0] === "agents" && parts[2] === "blocked" && parts.length === 3) {
					if (!this.cfg.agents[parts[1]]) throw new HttpError(404, "no such agent");
					return send(200, this.manager.blockedOf(parts[1], q.get("session") ?? "main"));
				}
				if (parts[0] === "agents" && parts[2] === "folders" && parts.length === 3) {
					if (!this.cfg.agents[parts[1]]) throw new HttpError(404, "no such agent");
					return send(200, this.manager.folders(parts[1]));
				}
				if (parts[0] === "agents" && parts[2] === "view" && parts.length === 4) {
					const root = this.manager.viewRoot(parts[1], q.get("session") ?? "main");
					if (!root) throw new HttpError(404, "no such agent");
					const rel = q.get("path") ?? "";
					const found = parts[3] === "changes" ? { root, ...(await changes(root)) } : parts[3] === "diff" ? await diffOf(root, rel) : parts[3] === "tree" ? listDir(root, rel) : parts[3] === "file" ? readText(root, rel) : undefined;
					if (!found) throw new HttpError(404, "nothing there");
					return send(200, found);
				}
				if (parts[0] === "tasks" && parts.length === 2) {
					const t = this.tasks.get(Number(parts[1]));
					return t ? send(200, t) : send(404, { error: "no such task" });
				}
				if (url.pathname === "/events") return send(200, this.bus.query({ topic: q.get("topic") ?? undefined, after: num("after"), limit: num("limit") }));
				if (url.pathname === "/events/stream") return this.stream(req, res, q.get("topic") ?? "#");
				if (url.pathname === "/state") return send(200, this.state.list(q.get("key") ?? "#"));
				if (url.pathname === "/approvals") return send(200, this.approvals.pending());
				throw new HttpError(404, "not found");
			}

			if (method !== "POST") throw new HttpError(405, "method not allowed");
			// A message may carry attached files; everything else stays small.
			const isPrompt = parts[0] === "agents" && parts[2] === "prompt" && parts.length === 3;
			const body = (await this.json(req, isPrompt ? 64 * MAX_BODY : MAX_BODY)) as any;
			if (url.pathname === "/images/fetch") {
				if (typeof body.url !== "string") throw new HttpError(400, "url required");
				try {
					return sendPicture(await this.manager.fetchImage(body.url));
				} catch (e) {
					throw new HttpError(502, errText(e));
				}
			}
			if (url.pathname === "/events") {
				if (typeof body.topic !== "string") throw new HttpError(400, "topic required");
				const e = this.bus.publish(body.topic, body.payload ?? null, { source: "api", trust: body.trust === "untrusted" ? "untrusted" : "owner" });
				return send(202, { id: e.id });
			}
			if (parts[0] === "agents" && parts[2] === "prompt" && parts.length === 3) {
				if (typeof body.prompt !== "string" || !body.prompt) throw new HttpError(400, "prompt required");
				const task = this.manager.submit({ agent: parts[1], prompt: body.prompt, session: body.session, trust: "owner", kind: "prompt", priority: 10, attachments: Array.isArray(body.attachments) ? body.attachments : undefined });
				if (body.wait === false) return send(202, { task: task.id });
				res.setTimeout(0);
				req.on("close", () => !res.writableEnded && body.cancelOnDisconnect && this.manager.cancel(task.id));
				return send(200, await this.manager.wait(task.id));
			}
			if (url.pathname === "/models/refresh") {
				// The owner added or removed a model server with the pine command.
				await this.manager.reloadModels();
				return send(200, { ok: true });
			}
			if (url.pathname === "/mcp/refresh") {
				await this.manager.refreshSessions();
				return send(200, { ok: true });
			}
			if (url.pathname === "/mcp") {
				// The owner adds or removes a server while the daemon runs; sessions pick it up when next used.
				if (typeof body.name !== "string") throw new HttpError(400, "name required");
				const agent = typeof body.agent === "string" ? body.agent : undefined;
				if (body.remove === true) {
					if (!removeServer(this.cfg, body.name, agent)) throw new HttpError(404, "no such server");
				} else {
					if (!body.server || typeof body.server !== "object") throw new HttpError(400, "server required");
					if (JSON.stringify(body.server).includes("${")) throw new HttpError(400, "a server that refers to ${NAME} values is read from the file at startup: add it with the daemon stopped, or restart afterwards");
					addServer(this.cfg, body.name, body.server, agent);
				}
				await this.manager.refreshSessions(agent ? [agent] : undefined);
				return send(200, { ok: true });
			}
			if (parts[0] === "agents" && parts[2] === "mode" && parts.length === 3) {
				this.manager.setMode(parts[1], body.mode, body.anyway === true && typeof body.session === "string" ? body.session : undefined);
				return send(200, { mode: body.mode });
			}
			if (parts[0] === "agents" && parts[2] === "thinking" && parts.length === 3) {
				this.manager.setThinking(parts[1], String(body.level));
				return send(200, { level: body.level });
			}
			if (parts[0] === "agents" && parts[2] === "model" && parts.length === 3) {
				if (typeof body.model !== "string") throw new HttpError(400, "model required");
				await this.manager.setModel(parts[1], body.model);
				return send(200, { model: body.model });
			}
			if (parts[0] === "agents" && (parts[2] === "subscribe" || parts[2] === "unsubscribe") && parts.length === 3) {
				if (!this.sources) throw new HttpError(404, "not found");
				if (!this.cfg.agents[parts[1]]) throw new HttpError(404, "no such agent");
				if (typeof body.source !== "string" || !body.source) throw new HttpError(400, "source required");
				try {
					if (parts[2] === "unsubscribe") {
						const sessions = await this.sources.unsubscribe(parts[1], body.source, typeof body.session === "string" ? body.session : undefined);
						return send(200, { unsubscribed: sessions.length > 0, sessions });
					}
					const { source: _s, ...details } = body;
					return send(200, await this.sources.subscribe(parts[1], body.source, details));
				} catch (e) {
					throw new HttpError(400, errText(e));
				}
			}
			// For all agents.
			if ((url.pathname === "/subscribe" || url.pathname === "/unsubscribe") && this.sources) {
				if (typeof body.source !== "string" || !body.source) throw new HttpError(400, "source required");
				try {
					if (url.pathname === "/unsubscribe") return send(200, { unsubscribed: await this.sources.unsubscribeAll(body.source) });
					const { source: _s, ...details } = body;
					return send(200, await this.sources.subscribeAll(body.source, details));
				} catch (e) {
					throw new HttpError(400, errText(e));
				}
			}
			// A conversation was closed in a UI: what it was subscribed to on its own ends with it.
			if (parts[0] === "agents" && parts[2] === "close" && parts.length === 3) {
				if (!this.cfg.agents[parts[1]]) throw new HttpError(404, "no such agent");
				return send(200, { unsubscribed: (await this.sources?.closeSession(parts[1], String(body.session ?? ""))) ?? [] });
			}
			// The tabs a UI has open, kept so that it opens with the same ones next time.
			if (url.pathname === "/ui/tabs") return send(200, (this.manager.saveUiTabs(body.tabs, body.active, body.code), { ok: true }));
			if (parts[0] === "agents" && parts[2] === "folder" && parts.length === 3) {
				if (!this.cfg.agents[parts[1]]) throw new HttpError(404, "no such agent");
				try {
					return send(200, await this.manager.setFolder(parts[1], String(body.session ?? "main"), typeof body.folder === "string" && body.folder ? body.folder : null));
				} catch (e) {
					throw new HttpError(409, errText(e));
				}
			}
			if (parts[0] === "agents" && ["remove", "rename", "pin"].includes(parts[2]) && parts.length === 3) {
				if (!this.cfg.agents[parts[1]]) throw new HttpError(404, "no such agent");
				if (typeof body.session !== "string" || !body.session) throw new HttpError(400, "session: the conversation's name");
				try {
					if (parts[2] === "pin") return send(200, { pinned: this.manager.pinSession(parts[1], body.session, body.pinned !== false) });
					if (parts[2] === "rename") return send(200, await this.manager.renameSession(parts[1], body.session, String(body.to ?? "")));
					return send(200, await this.manager.removeSession(parts[1], body.session));
				} catch (e) {
					throw new HttpError(409, errText(e));
				}
			}
			if (parts[0] === "agents" && parts[2] === "blocked" && parts[3] === "allow" && parts.length === 4) {
				if (!this.cfg.agents[parts[1]]) throw new HttpError(404, "no such agent");
				return send(200, { allowed: this.manager.allowBlocked(parts[1], String(body.session ?? "main"), String(body.id ?? "")) });
			}
			if (parts[0] === "agents" && parts[2] === "programs" && parts[3] === "stop" && parts.length === 4) {
				if (!this.cfg.agents[parts[1]]) throw new HttpError(404, "no such agent");
				return send(200, { stopped: this.manager.stopProgram(parts[1], String(body.session ?? "main"), Number(body.id)) });
			}
			if (parts[0] === "agents" && parts[2] === "reset" && parts.length === 3) return send(200, { reset: await this.manager.resetSession(parts[1], body.session) });
			if (parts[0] === "tasks" && parts[2] === "cancel" && parts.length === 3) return send(200, { cancelled: this.manager.cancel(Number(parts[1])) });
			if (parts[0] === "approvals" && parts.length === 2) {
				const values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? (body.values as Record<string, string>) : undefined;
				const missing = body.allow === true ? this.approvals.missing(parts[1], values) : [];
				if (missing.length) throw new HttpError(400, `this request needs you to enter ${missing.join(", ")}: answer it in the terminal UI, where it is typed without being shown`);
				return send(200, { decided: this.approvals.decide(parts[1], body.allow === true, "api", body.always === true, values) });
			}
			if (url.pathname === "/state") {
				if (typeof body.key !== "string") throw new HttpError(400, "key required");
				this.state.set(body.key, body.value ?? null, { source: "api" });
				return send(200, { ok: true });
			}
			throw new HttpError(404, "not found");
		} catch (e) {
			const status = e instanceof HttpError ? e.status : /unknown agent|too many queued|does not accept|invalid topic|invalid state key|busy|is not defined in models.json|mode must be one of|at most 10 files|larger than 20 MB|inbox folder|can attach files|usable server name|MCP server needs|not a valid URL|must use https|reasoning level must be/.test(errText(e)) ? 400 : 500;
			if (status === 500) this.log.error("http request failed", e);
			send(status, { error: status === 500 ? "internal error" : errText(e) });
		}
	}

	/** DNS rebinding and cross-site requests: only accept a loopback (or configured) Host, never an Origin. */
	private guardBrowser(req: http.IncomingMessage): void {
		if (req.headers.origin || req.headers["sec-fetch-site"]) throw new HttpError(403, "requests from web pages are not accepted");
		const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
		const allowed = ["127.0.0.1", "localhost", "::1", this.cfg.http!.host];
		if (!allowed.includes(host)) throw new HttpError(403, "unexpected Host header");
	}

	private async raw(req: http.IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const c of req) {
			size += c.length;
			if (size > limit) throw new HttpError(413, "body too large");
			chunks.push(c);
		}
		return Buffer.concat(chunks);
	}

	private async json(req: http.IncomingMessage, limit = MAX_BODY): Promise<unknown> {
		if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "content-type must be application/json");
		const buf = await this.raw(req, limit);
		try {
			return buf.length ? JSON.parse(buf.toString("utf8")) : {};
		} catch {
			throw new HttpError(400, "invalid JSON");
		}
	}

	/** A webhook: outside content by definition, so the event is untrusted whatever it says. */
	private async hook(name: string, req: http.IncomingMessage): Promise<{ id: number }> {
		const hook = this.cfg.http!.hooks[name];
		// A running event source of type webhook (or one of your own) takes requests under its name.
		const sourceHook = hook ? undefined : this.sources?.hookFor(name);
		if (!hook && !sourceHook) throw new HttpError(404, "not found");
		const now = Date.now();
		const recent = (this.hits.get(name) ?? []).filter((t) => now - t < 60_000);
		if (recent.length >= 120) throw new HttpError(429, "too many requests");
		recent.push(now);
		this.hits.set(name, recent);

		const body = await this.raw(req);
		if (sourceHook) {
			try {
				await sourceHook({ headers: req.headers, body });
			} catch (e) {
				throw new HttpError(typeof (e as any)?.status === "number" ? (e as any).status : 500, typeof (e as any)?.status === "number" ? errText(e) : "internal error");
			}
			return { id: 0 };
		}
		if (!hook) throw new HttpError(404, "not found");
		if (hook.secret) {
			const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
			const sig = String(req.headers["x-hub-signature-256"] ?? req.headers["x-signature"] ?? "").replace(/^sha256=/, "");
			const expected = crypto.createHmac("sha256", hook.secret).update(body).digest("hex");
			if (!(bearer && timingSafeEqual(bearer, hook.secret)) && !(sig && timingSafeEqual(sig, expected))) throw new HttpError(401, "bad signature");
		}
		let payload: unknown;
		try {
			payload = JSON.parse(body.toString("utf8"));
		} catch {
			payload = { text: body.toString("utf8") };
		}
		const e = this.bus.publish(hook.topic, payload, { source: "http", trust: "untrusted" });
		return { id: e.id };
	}

	private stream(req: http.IncomingMessage, res: http.ServerResponse, pattern: string): void {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
		res.write(": connected\n\n");
		const off = this.bus.subscribe("#", (e) => {
			if (topicMatches(pattern, e.topic)) res.write(`data: ${JSON.stringify(e)}\n\n`);
		}, "http-stream");
		const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
		req.on("close", () => {
			off();
			clearInterval(ping);
		});
	}
}
