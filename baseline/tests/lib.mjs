import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { startMock } from "./mock.mjs";

process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_TELEMETRY = "0";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORK = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-baseline-")));
// Decoy global agent dir: anything that ignores an explicit agentDir lands here instead of ~/.pi.
export const DECOY = path.join(WORK, "decoy-agent");
fs.mkdirSync(DECOY, { recursive: true });
process.env.PI_CODING_AGENT_DIR = DECOY;
export function listFiles(dir) {
	const out = [];
	const walk = (d) => {
		for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
			const f = path.join(d, e.name);
			if (e.isDirectory()) walk(f);
			else out.push(path.relative(dir, f));
		}
	};
	walk(dir);
	return out;
}

export function mkdir(...parts) {
	const p = path.join(WORK, ...parts);
	fs.mkdirSync(p, { recursive: true });
	return fs.realpathSync(p);
}
export function write(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

// An isolated agent dir (never touches ~/.pi) wired to a mock server.
export async function makeEnv(name, { mock, modelOverrides = {}, settings, mcp } = {}) {
	mock ??= await startMock();
	const agentDir = mkdir(name, "agent");
	write(
		path.join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					mock: {
						name: "Mock",
						baseUrl: mock.baseUrl,
						api: "openai-completions",
						apiKey: "sk-mock",
						models: [
							{
								id: "mock-model",
								name: "Mock Model",
								contextWindow: 128000,
								maxTokens: 4096,
								input: ["text", "image"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								...modelOverrides,
							},
						],
					},
				},
			},
			null,
			2,
		),
	);
	if (settings) write(path.join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
	if (mcp) write(path.join(agentDir, "mcp.json"), JSON.stringify(mcp, null, 2));
	const modelRuntime = await ModelRuntime.create({
		authPath: path.join(agentDir, "auth.json"),
		modelsPath: path.join(agentDir, "models.json"),
	});
	const model = modelRuntime.getModel("mock", "mock-model");
	if (!model) throw new Error(`mock model not registered: ${modelRuntime.getError?.()}`);
	return { name, mock, agentDir, modelRuntime, model };
}

export async function newSession(env, { cwd, inMemory = true, settings, loader, ...rest } = {}) {
	cwd ??= mkdir(env.name, "cwd");
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, ...(settings ?? {}) });
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: env.agentDir, settingsManager, ...(loader ?? {}) });
	await resourceLoader.reload();
	const created = await createAgentSession({
		cwd,
		agentDir: env.agentDir,
		model: env.model,
		modelRuntime: env.modelRuntime,
		thinkingLevel: "off",
		settingsManager,
		resourceLoader,
		sessionManager: inMemory ? SessionManager.inMemory(cwd) : SessionManager.create(cwd, path.join(env.agentDir, "sessions")),
		...rest,
	});
	const events = [];
	created.session.subscribe((e) => events.push({ at: Date.now(), ...e }));
	return { ...created, events, cwd, settingsManager, resourceLoader };
}

export const types = (events) => events.map((e) => e.type);
export const systemOf = (req) => {
	const m = (req.body.messages ?? []).find((x) => x.role === "system" || x.role === "developer");
	return m ? (typeof m.content === "string" ? m.content : JSON.stringify(m.content)) : "";
};
export const toolNames = (req) => (req.body.tools ?? []).map((t) => t.function?.name ?? t.name);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- result recording -------------------------------------------------------------------------
export const results = [];
export async function check(id, question, fn) {
	const started = Date.now();
	const rec = { id, question, verdict: "?", findings: [], ms: 0 };
	const note = (label, value) => rec.findings.push({ label, value });
	try {
		const verdict = await fn(note);
		rec.verdict = verdict ?? "ok";
	} catch (e) {
		rec.verdict = "ERROR";
		rec.findings.push({ label: "threw", value: String(e?.stack ?? e).split("\n").slice(0, 6).join("\n") });
	}
	rec.ms = Date.now() - started;
	results.push(rec);
	console.log(`\n## ${id} — ${question}\n   verdict: ${rec.verdict} (${rec.ms} ms)`);
	for (const f of rec.findings) {
		const v = typeof f.value === "string" ? f.value : (JSON.stringify(f.value) ?? "undefined");
		console.log(`   - ${f.label}: ${v.length > 700 ? `${v.slice(0, 700)}…` : v}`);
	}
	return rec;
}
export function saveResults(file) {
	write(path.join(HERE, "..", "results", file), JSON.stringify(results, null, 2));
}
