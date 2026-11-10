import fs from "node:fs";
import path from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { check, DECOY, listFiles, makeEnv, mkdir, newSession, saveResults, sleep, systemOf, types, write } from "./lib.mjs";
import { mockMsg, startMock, textOf } from "./mock.mjs";

const life = (events) => types(events).filter((t) => /^(agent_|compaction|auto_retry)/.test(t));
const nonSystem = (req) => req.body.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, text: textOf(m.content).slice(0, 70) }));

await check("C1", "Does auto-compaction trigger on a small context window, and what does the model see afterwards?", async (note) => {
	const env = await makeEnv("compact", { modelOverrides: { contextWindow: 8000, maxTokens: 1000 } });
	const s = await newSession(env, { settings: { compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1500 } } });
	const filler = (i) => `Turn ${i}. ${"lorem ipsum dolor sit amet ".repeat(220)}`; // ~1500 tokens
	const perTurn = [];
	for (let i = 1; i <= 6; i++) {
		const before = env.mock.state.requests.length;
		await s.session.prompt(filler(i));
		await s.session.waitForIdle();
		const reqs = env.mock.state.requests.slice(before);
		perTurn.push({ turn: i, requests: reqs.length, summaryRequests: reqs.filter((r) => !r.body.tools).length, ctx: s.session.getContextUsage()?.tokens ?? null });
	}
	note("per turn", perTurn);
	note("lifecycle", life(s.events));
	const comp = s.events.filter((e) => e.type === "compaction_start" || e.type === "compaction_end").map((e) => ({ type: e.type, reason: e.reason, aborted: e.aborted, err: e.errorMessage, tokensBefore: e.result?.tokensBefore }));
	note("compaction events", comp);
	const sumReq = env.mock.state.requests.find((r) => !r.body.tools);
	note("summary request", sumReq ? { messages: sumReq.body.messages.length, chars: JSON.stringify(sumReq.body).length, max_tokens: sumReq.body.max_completion_tokens ?? sumReq.body.max_tokens, systemStart: systemOf(sumReq).slice(0, 120) } : "none");
	note("messages in the last real request", nonSystem(env.mock.state.requests.filter((r) => r.body.tools).at(-1)));
	note("context usage now", s.session.getContextUsage());
	s.session.dispose();
	await env.mock.close();
	return comp.some((c) => c.type === "compaction_end" && !c.aborted && !c.err) ? "compacts automatically" : "NO COMPACTION";
});

await check("C2", "Does a llama-server style context-overflow error trigger compact-and-retry?", async (note) => {
	const env = await makeEnv("overflow", { modelOverrides: { contextWindow: 128000 } });
	const s = await newSession(env, { settings: { compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1500 } } });
	for (let i = 0; i < 4; i++) await s.session.prompt(`history ${i} ${"padding words here ".repeat(300)}`);
	env.mock.reset();
	env.mock.state.failNext.push({
		status: 400,
		body: { error: { code: 400, message: "the request exceeds the available context size, try increasing it", type: "exceed_context_size_error", n_prompt_tokens: 9000, n_ctx: 8192 } },
	});
	let threw;
	try {
		await s.session.prompt("this one overflows the real server window");
	} catch (e) {
		threw = e.message;
	}
	await s.session.waitForIdle();
	note("prompt() threw", threw ?? false);
	note("lifecycle", life(s.events.slice(-40)));
	note("compaction events", s.events.filter((e) => /compaction/.test(e.type)).map((e) => ({ type: e.type, reason: e.reason, willRetry: e.willRetry, err: e.errorMessage })));
	note("requests after the failing prompt", env.mock.state.requests.map((r) => (r.reply?.fail ? "400 overflow" : r.body.tools ? "normal" : "summary")));
	note("final text", s.session.getLastAssistantText()?.slice(0, 80));
	const last = s.session.messages.at(-1);
	note("last message", { role: last.role, stopReason: last.stopReason, errorMessage: last.errorMessage?.slice(0, 120) });
	s.session.dispose();
	await env.mock.close();
	return s.events.some((e) => e.type === "compaction_start" && e.reason === "overflow") ? "recovers by compacting" : "no overflow recovery";
});

await check("C3", "How are transient server errors (500, 429) retried, and what does a hard failure look like to the host?", async (note) => {
	const env = await makeEnv("retry");
	const retry = { enabled: true, maxRetries: 3, baseDelayMs: 50, maxAgentDelayMs: 500 };
	for (const [label, fails] of Object.entries({
		"two 500s then ok": [{ status: 500, body: { error: { message: "internal error" } } }, { status: 500, body: { error: { message: "internal error" } } }],
		"429 then ok": [{ status: 429, body: { error: { message: "rate limited" } }, headers: { "retry-after": "0" } }],
		"503 loading model then ok": [{ status: 503, body: { error: { message: "Loading model", type: "unavailable_error", code: 503 } } }],
		"400 bad request (not transient)": [{ status: 400, body: { error: { message: "tool_choice is not supported" } } }],
		"five 500s (retries exhausted)": Array(5).fill({ status: 500, body: { error: { message: "internal error" } } }),
	})) {
		env.mock.reset();
		env.mock.state.failNext.push(...fails);
		const s = await newSession(env, { settings: { retry } });
		let threw;
		const t0 = Date.now();
		try {
			await s.session.prompt("please answer");
		} catch (e) {
			threw = e.message;
		}
		await s.session.waitForIdle();
		const last = s.session.messages.at(-1);
		note(label, {
			requests: env.mock.state.requests.length,
			ms: Date.now() - t0,
			promptThrew: threw ?? false,
			retries: s.events.filter((e) => e.type === "auto_retry_start").map((e) => `#${e.attempt}/${e.maxAttempts} in ${e.delayMs}ms`),
			agentEnds: s.events.filter((e) => e.type === "agent_end").map((e) => `willRetry=${e.willRetry}`),
			settled: s.events.filter((e) => e.type === "agent_settled").length,
			last: { role: last.role, stopReason: last.stopReason, error: last.errorMessage?.slice(0, 90) },
			answer: s.session.getLastAssistantText()?.slice(0, 30),
		});
		s.session.dispose();
	}
	await env.mock.close();
	return "measured";
});

await check("C4", "What happens when the model server is down or goes silent?", async (note) => {
	const env = await makeEnv("down");
	const sDown = await newSession(env, { settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 50, maxAgentDelayMs: 200 } } });
	await env.mock.close();
	let threw;
	const t0 = Date.now();
	try {
		await sDown.session.prompt("anyone there?");
	} catch (e) {
		threw = e.message;
	}
	await sDown.session.waitForIdle();
	const last = sDown.session.messages.at(-1);
	note("server down", { ms: Date.now() - t0, promptThrew: threw ?? false, retries: sDown.events.filter((e) => e.type === "auto_retry_start").length, last: { role: last.role, stopReason: last.stopReason, error: last.errorMessage?.slice(0, 120) } });
	sDown.session.dispose();

	const env2 = await makeEnv("silent");
	const sIdle = await newSession(env2, { settings: { retry: { enabled: false }, httpIdleTimeoutMs: 1500 } });
	const t1 = Date.now();
	let threw2;
	try {
		await Promise.race([sIdle.session.prompt(mockMsg([{ stall: true }])), sleep(8000).then(() => { throw new Error("TEST-GAVE-UP after 8 s"); })]);
	} catch (e) {
		threw2 = e.message;
	}
	const last2 = sIdle.session.messages.at(-1);
	note("stream goes silent, httpIdleTimeoutMs=1500", { ms: Date.now() - t1, promptThrew: threw2 ?? false, last: { role: last2.role, stopReason: last2.stopReason, error: last2.errorMessage?.slice(0, 120) } });
	note("default httpIdleTimeoutMs", "300000 (5 min) per docs/settings.md");
	await sIdle.session.abort().catch(() => {});
	sIdle.session.dispose();
	await env2.mock.close();
	return "measured";
});

await check("C5", "Does a persisted session resume after dispose (daemon restart), and where is it stored by default?", async (note) => {
	const env = await makeEnv("persist");
	const cwd = mkdir("persist", "repo");
	const mk = async (sessionManager) => {
		const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: env.agentDir, settingsManager });
		await resourceLoader.reload();
		return (await createAgentSession({ cwd, agentDir: env.agentDir, model: env.model, modelRuntime: env.modelRuntime, thinkingLevel: "off", settingsManager, resourceLoader, sessionManager })).session;
	};
	const first = await mk(SessionManager.create(cwd));
	await first.prompt("remember the code word: PLATYPUS");
	await first.prompt(mockMsg([{ tools: [{ name: "bash", args: { command: "echo tool-in-history" } }] }]));
	const file = first.sessionFile;
	note("default session file", file?.replace(DECOY, "<PI_CODING_AGENT_DIR>").replace(env.agentDir, "<agentDir option>"));
	note("createAgentSession({agentDir}) decides session location", file?.startsWith(env.agentDir));
	first.dispose();

	env.mock.reset();
	const resumed = await mk(SessionManager.continueRecent(cwd));
	note("continueRecent picked the same file", resumed.sessionFile === file);
	await resumed.prompt("what was the code word?");
	const req = env.mock.state.requests[0];
	note("roles replayed to the model", req.body.messages.map((m) => m.role));
	note("history contains code word", JSON.stringify(req.body.messages).includes("PLATYPUS"));
	resumed.dispose();

	const opened = await mk(SessionManager.open(file));
	note("SessionManager.open(file) message count", opened.messages.length);
	opened.dispose();
	const other = SessionManager.continueRecent(mkdir("persist", "other-repo"));
	note("continueRecent in a different cwd starts fresh", other.getSessionFile?.() !== file);
	await env.mock.close();
	return JSON.stringify(req.body.messages).includes("PLATYPUS") ? "resumes with full history" : "FAILED";
});

await check("C6", "Which project files load in an SDK session without a trust decision (AGENTS.md, CLAUDE.md, .pi/*, skills)?", async (note) => {
	const env = await makeEnv("trust");
	const parent = mkdir("trust", "parent");
	const cwd = mkdir("trust", "parent", "repo");
	write(path.join(parent, "AGENTS.md"), "MARK-PARENT-AGENTS\n");
	write(path.join(cwd, "AGENTS.md"), "MARK-REPO-AGENTS\n");
	write(path.join(cwd, "CLAUDE.md"), "MARK-REPO-CLAUDE\n");
	write(path.join(cwd, ".pi", "APPEND_SYSTEM.md"), "MARK-PI-APPEND-SYSTEM\n");
	write(path.join(cwd, ".pi", "skills", "inverter", "SKILL.md"), "---\nname: inverter\ndescription: MARK-PI-SKILL inverter handling\n---\nSkill body MARK-SKILL-BODY\n");
	write(path.join(cwd, ".agents", "skills", "deeds", "SKILL.md"), "---\nname: deeds\ndescription: MARK-AGENTS-SKILL land registry\n---\nbody\n");
	write(path.join(cwd, ".pi", "extensions", "evil.ts"), `import fs from "node:fs"; export default function(pi){ fs.writeFileSync(${JSON.stringify(path.join(cwd, "EXTENSION-RAN"))}, "1"); }`);
	write(path.join(env.agentDir, "skills", "global", "SKILL.md"), "---\nname: global\ndescription: MARK-USER-SKILL always there\n---\nbody\n");
	const marks = ["MARK-PARENT-AGENTS", "MARK-REPO-AGENTS", "MARK-REPO-CLAUDE", "MARK-PI-APPEND-SYSTEM", "MARK-PI-SKILL", "MARK-AGENTS-SKILL", "MARK-USER-SKILL", "MARK-SKILL-BODY"];
	const probe = async (label, extra) => {
		env.mock.reset();
		fs.rmSync(path.join(cwd, "EXTENSION-RAN"), { force: true });
		const s = await newSession(env, { cwd, ...extra });
		await s.session.prompt("probe");
		const sys = systemOf(env.mock.state.requests[0]);
		note(label, { inSystemPrompt: marks.filter((m) => sys.includes(m)), projectExtensionRan: fs.existsSync(path.join(cwd, "EXTENSION-RAN")) });
		s.session.dispose();
	};
	await probe("default (no trust decision)");
	write(path.join(env.agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
	await probe("agentDir settings.json defaultProjectTrust:'always' (in-memory SettingsManager)");
	env.mock.reset();
	fs.rmSync(path.join(cwd, "EXTENSION-RAN"), { force: true });
	{
		const settingsManager = SettingsManager.create(cwd, env.agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: env.agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({ cwd, agentDir: env.agentDir, model: env.model, modelRuntime: env.modelRuntime, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd) });
		await session.prompt("probe");
		const sys = systemOf(env.mock.state.requests[0]);
		note("defaultProjectTrust:'always' with file-backed SettingsManager", { inSystemPrompt: marks.filter((m) => sys.includes(m)), projectExtensionRan: fs.existsSync(path.join(cwd, "EXTENSION-RAN")) });
		session.dispose();
	}
	await env.mock.close();
	return "measured";
});

await check("C7", "Is the default system prompt usable for a non-coding agent, and can it be replaced or appended?", async (note) => {
	const env = await makeEnv("sysprompt");
	const cwd = mkdir("sysprompt", "repo");
	write(path.join(cwd, "AGENTS.md"), "MARK-AGENTS\n");
	const s1 = await newSession(env, { cwd });
	await s1.session.prompt("probe");
	const def = systemOf(env.mock.state.requests[0]);
	note("default system prompt (first 400 chars)", def.slice(0, 400));
	note("default length chars", def.length);
	s1.session.dispose();
	env.mock.reset();
	const s2 = await newSession(env, { cwd, loader: { systemPrompt: "You are gonzo, a legal aid agent. REPLACED-MARK", appendSystemPrompt: ["APPENDED-MARK current house mode: away"] } });
	await s2.session.prompt("probe");
	const rep = systemOf(env.mock.state.requests[0]);
	note("replaced prompt", { length: rep.length, hasReplaced: rep.includes("REPLACED-MARK"), hasAppended: rep.includes("APPENDED-MARK"), stillHasAgentsMd: rep.includes("MARK-AGENTS"), stillHasDefault: rep.includes(def.slice(0, 60)) });
	note("replaced prompt text", rep.slice(0, 500));
	s2.session.dispose();
	await env.mock.close();
	return "measured";
});

saveResults("t04.json");
process.exit(0);
