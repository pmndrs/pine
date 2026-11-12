import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Agent, Pool, setGlobalDispatcher } from "undici";
import { AgentManager } from "./agents.ts";
import { loadConfig, type PineConfig } from "./config.ts";
import { modelOrigins } from "./models.ts";
import { HttpServer } from "./http.ts";
import type { CompleteOptions } from "./router.ts";
import { Router } from "./router.ts";
import { SourceHost } from "./sources.ts";
import { Approvals, audit, Redactor } from "./security.ts";
import { Bus, Kv, openDb, State, TaskStore } from "./store.ts";
import { Scheduler } from "./timers.ts";
import { createLogger, errText, type Logger } from "./util.ts";

export interface Pine {
	cfg: PineConfig;
	bus: Bus;
	state: State;
	tasks: TaskStore;
	agents: AgentManager;
	approvals: Approvals;
	sources: SourceHost;
	schedules: Scheduler;
	http?: HttpServer;
	/** Bearer token of the control API. */
	token: string;
	warnings: string[];
	complete(o: CompleteOptions): Promise<string>;
	stop(): Promise<void>;
}

/**
 * pi does not time out a model stream that goes quiet after its headers. Give the model servers
 * their own connection pools with header and idle timeouts; everything else keeps the defaults.
 */
function installModelTimeouts(cfg: PineConfig): void {
	setGlobalDispatcher(
		new Agent({
			factory: (origin, opts) =>
				new Pool(origin, modelOrigins.has(String(origin)) ? { ...opts, headersTimeout: cfg.limits.modelHeadersTimeoutMs, bodyTimeout: cfg.limits.modelStreamIdleMs } : opts),
		}),
	);
}

function controlToken(cfg: PineConfig): string {
	if (cfg.http?.token) return cfg.http.token;
	const file = path.join(cfg.dataDir, "http-token");
	if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
	const token = crypto.randomBytes(24).toString("base64url");
	fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
	return token;
}

export async function startPine(opts: { home?: string; config?: PineConfig; log?: Logger; http?: boolean; logFile?: string } = {}): Promise<Pine> {
	const cfg = opts.config ?? loadConfig(opts.home);
	const redactor = new Redactor();
	redactor.add(cfg.secrets);
	// With a log file (the terminal UI owns the screen) nothing is written to stderr.
	if (opts.logFile) fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
	const sink = opts.logFile ? (line: string) => fs.appendFileSync(opts.logFile!, `${redactor.text(line)}\n`) : (line: string) => void process.stderr.write(`${redactor.text(line)}\n`);
	const log = opts.log ?? createLogger(cfg.logLevel, "pine", sink);

	// The daemon must not pick up the settings, extensions or MCP servers of a pi you use by hand.
	process.env.PI_CODING_AGENT_DIR = path.join(cfg.dataDir, "pi");
	process.env.PI_SKIP_VERSION_CHECK = "1";
	process.env.PI_TELEMETRY = "0";
	process.env.PI_OFFLINE ??= "1";
	fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	for (const dir of [cfg.home, cfg.dataDir, path.join(cfg.home, "sandbox")]) {
		fs.mkdirSync(dir, { recursive: true });
		if (dir !== cfg.home) fs.chmodSync(dir, 0o700);
	}
	installModelTimeouts(cfg);

	const db = openDb(cfg.dataDir);
	const bus = new Bus(db, log.child("bus"));
	const token = controlToken(cfg);
	redactor.add([token]);
	bus.redact = (p) => redactor.deep(p);
	const state = new State(db, bus);
	const kv = new Kv(db);
	const tasks = new TaskStore(db);
	const approvals = new Approvals(bus, log.child("approvals"), cfg.security.approvalTimeoutMs);
	const agents = new AgentManager({ cfg, bus, state, kv, tasks, approvals, log: log.child("agents") });

	const complete = async (o: CompleteOptions): Promise<string> => {
		const model = agents.resolveModel(o.model ?? cfg.defaults.model ?? Object.values(cfg.agents)[0].model!);
		const content: any[] = [{ type: "text", text: o.prompt }, ...(o.images ?? []).map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }))];
		const slot = await agents.limiter.acquire(5);
		try {
			const msg: any = await agents.models.completeSimple(model, { systemPrompt: o.system, messages: [{ role: "user", content, timestamp: Date.now() }] } as any, { signal: o.signal, sessionId: "pine-call" } as any);
			if (msg.stopReason === "error" || msg.stopReason === "aborted") throw new Error(msg.errorMessage ?? `model call ${msg.stopReason}`);
			return (msg.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
		} finally {
			slot.release();
		}
	};

	await agents.init();
	// eslint-disable-next-line prefer-const
	let sources: SourceHost;
	const router = new Router({ cfg, bus, state, manager: agents, complete, log: log.child("router"), mediaRoots: () => sources.mediaRoots });
	sources = new SourceHost({ cfg, bus, kv, redactor, router, log: log.child("sources"), http: Boolean(cfg.http && opts.http !== false), approvals });
	agents.sources = sources;
	agents.router = router;
	router.start();
	await sources.start();
	const timers = new Scheduler(cfg, bus, kv, log.child("timers"), router);
	agents.schedules = timers;
	timers.start();
	const pruned = bus.prune(cfg.limits.eventRetentionDays * 86_400_000);
	if (pruned) log.info(`removed ${pruned} events older than ${cfg.limits.eventRetentionDays} days`);
	agents.pruneMedia(cfg.limits.eventRetentionDays * 86_400_000);
	const tidy = () =>
		void agents
			.pruneConversations()
			.then((n) => n && log.info(`removed ${n} conversation${n === 1 ? "" : "s"} not used for ${cfg.limits.conversationDays} days`))
			.catch((e) => log.warn(`could not tidy conversations: ${errText(e)}`));
	tidy();
	const pruner = setInterval(() => {
		bus.prune(cfg.limits.eventRetentionDays * 86_400_000);
		agents.pruneMedia(cfg.limits.eventRetentionDays * 86_400_000);
		tidy();
	}, 6 * 3_600_000);
	pruner.unref();

	let http: HttpServer | undefined;
	if (cfg.http && opts.http !== false) {
		http = new HttpServer({ cfg, bus, state, tasks, manager: agents, approvals, sources, log: log.child("http"), token });
		await http.start();
	}

	const warnings = audit(cfg);
	for (const w of warnings) log.warn(`security: ${w}`);
	bus.publish("pine/started", { agents: Object.keys(cfg.agents) }, { source: "pine" });
	const src = sources.list();
	log.info(`pine is up: ${Object.keys(cfg.agents).length} agents, ${cfg.routes.length} routes, ${src.length} event sources (${src.filter((s) => s.running).length} running)`);

	let stopped = false;
	return {
		cfg, bus, state, tasks, agents, approvals, sources, schedules: timers, http, token, warnings, complete,
		async stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(pruner);
			timers.stop();
			await sources.stop();
			router.stop();
			await http?.stop();
			await agents.stop();
			await bus.drain();
			db.close();
		},
	};
}
