import fs from "node:fs";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { check, makeEnv, mkdir, newSession, saveResults, sleep, systemOf, write } from "./lib.mjs";
import { mockMsg } from "./mock.mjs";

async function stallCase(env, settings, step, giveUpMs = 6000) {
	env.mock.reset();
	const s = await newSession(env, { settings: { retry: { enabled: false }, ...settings } });
	const t0 = Date.now();
	let outcome = "resolved";
	try {
		await Promise.race([s.session.prompt(mockMsg([step])), sleep(giveUpMs).then(() => { throw new Error("STILL HANGING"); })]);
	} catch (e) {
		outcome = e.message;
	}
	const last = s.session.messages.at(-1);
	const res = { ms: Date.now() - t0, outcome, last: { role: last?.role, stopReason: last?.stopReason, error: last?.errorMessage?.slice(0, 100) } };
	await s.session.abort().catch(() => {});
	s.session.dispose();
	return res;
}

await check("C8", "Is a hung model request detected in an SDK session (no headers / headers then silence)?", async (note) => {
	const env = await makeEnv("timeouts");
	note("no response headers, httpIdleTimeoutMs=1500", await stallCase(env, { httpIdleTimeoutMs: 1500 }, { delayMs: 60000, text: "late" }));
	note("no response headers, retry.provider.timeoutMs=1500", await stallCase(env, { retry: { enabled: false, provider: { timeoutMs: 1500 } } }, { delayMs: 60000, text: "late" }));
	note("headers then silence, httpIdleTimeoutMs=1500", await stallCase(env, { httpIdleTimeoutMs: 1500 }, { stall: true }));
	const undici = await import("undici");
	const previous = undici.getGlobalDispatcher();
	undici.setGlobalDispatcher(new undici.Agent({ bodyTimeout: 1500, headersTimeout: 1500 }));
	note("headers then silence, host installs undici Agent{bodyTimeout:1500}", await stallCase(env, {}, { stall: true }));
	note("no response headers, host installs undici Agent{headersTimeout:1500}", await stallCase(env, {}, { delayMs: 60000, text: "late" }));
	undici.setGlobalDispatcher(previous);
	await env.mock.close();
	return "measured";
});

await check("C6b", "Can an SDK session refuse project-supplied code and settings (projectTrusted:false)?", async (note) => {
	const env = await makeEnv("trust2");
	const cwd = mkdir("trust2", "repo");
	write(path.join(cwd, "AGENTS.md"), "MARK-REPO-AGENTS\n");
	write(path.join(cwd, ".pi", "APPEND_SYSTEM.md"), "MARK-PI-APPEND-SYSTEM\n");
	write(path.join(cwd, ".pi", "skills", "inverter", "SKILL.md"), "---\nname: inverter\ndescription: MARK-PI-SKILL inverter handling\n---\nbody\n");
	write(path.join(cwd, ".agents", "skills", "deeds", "SKILL.md"), "---\nname: deeds\ndescription: MARK-AGENTS-SKILL land registry\n---\nbody\n");
	write(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ shellCommandPrefix: "echo PREFIX-FROM-PROJECT-SETTINGS;" }));
	write(path.join(cwd, ".pi", "extensions", "evil.ts"), `import fs from "node:fs"; export default function(pi){ fs.writeFileSync(${JSON.stringify(path.join(cwd, "EXTENSION-RAN"))}, "1"); }`);
	const marks = ["MARK-REPO-AGENTS", "MARK-PI-APPEND-SYSTEM", "MARK-PI-SKILL", "MARK-AGENTS-SKILL"];
	const { createAgentSession, DefaultResourceLoader, SessionManager } = await import("@earendil-works/pi-coding-agent");
	for (const trusted of [true, false]) {
		env.mock.reset();
		fs.rmSync(path.join(cwd, "EXTENSION-RAN"), { force: true });
		const settingsManager = SettingsManager.create(cwd, env.agentDir, { projectTrusted: trusted });
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: env.agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({ cwd, agentDir: env.agentDir, model: env.model, modelRuntime: env.modelRuntime, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd) });
		await session.prompt(mockMsg([{ tools: [{ name: "bash", args: { command: "echo real-command" } }] }]));
		const sys = systemOf(env.mock.state.requests[0]);
		note(`projectTrusted:${trusted}`, {
			inSystemPrompt: marks.filter((m) => sys.includes(m)),
			projectExtensionRan: fs.existsSync(path.join(cwd, "EXTENSION-RAN")),
			projectSettingsApplied: (session.getLastAssistantText() ?? "").includes("PREFIX-FROM-PROJECT-SETTINGS"),
		});
		session.dispose();
	}
	await env.mock.close();
	return "measured";
});

saveResults("t04b.json");
process.exit(0);
