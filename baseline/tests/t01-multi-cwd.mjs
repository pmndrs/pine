import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, DECOY, listFiles, makeEnv, mkdir, newSession, saveResults, sleep, systemOf, types, write } from "./lib.mjs";
import { mockMsg, textOf } from "./mock.mjs";

const env = await makeEnv("multicwd");
const procCwd = process.cwd();

function agentRepo(name) {
	const cwd = mkdir("multicwd", "repos", name);
	write(path.join(cwd, "AGENTS.md"), `# ${name}\nMARKER-AGENTS-${name.toUpperCase()}\n`);
	write(path.join(cwd, "fact.txt"), `fact-of-${name}\n`);
	return cwd;
}

await check("A1", "Can several sessions with different cwd run concurrently in one process, each seeing only its own repo?", async (note) => {
	const names = ["gonzo", "home", "para"];
	const sessions = [];
	for (const n of names) sessions.push({ n, ...(await newSession(env, { cwd: agentRepo(n) })) });
	env.mock.reset();
	await Promise.all(
		sessions.map((s) =>
			s.session.prompt(
				mockMsg(
					[
						{ delayMs: 300, tools: [{ name: "bash", args: { command: "pwd" } }, { name: "read", args: { path: "fact.txt" } }] },
						{ delayMs: 300, tools: [{ name: "write", args: { path: "out.txt", content: `written-by-${s.n}` } }] },
					],
					`I am ${s.n}. `,
				),
			),
		),
	);
	let ok = true;
	for (const s of sessions) {
		const mine = env.mock.state.requests.filter((r) => r.body.messages.some((m) => m.role === "user" && textOf(m.content).includes(`I am ${s.n}.`)));
		const sys = systemOf(mine[0]);
		const own = sys.includes(`MARKER-AGENTS-${s.n.toUpperCase()}`);
		const foreign = names.filter((o) => o !== s.n && sys.includes(`MARKER-AGENTS-${o.toUpperCase()}`));
		const final = s.session.getLastAssistantText() ?? "";
		const pwdOk = final.includes(s.cwd);
		const readOk = final.includes(`fact-of-${s.n}`);
		const wrote = fs.existsSync(path.join(s.cwd, "out.txt")) && fs.readFileSync(path.join(s.cwd, "out.txt"), "utf8");
		const sysCwd = sys.includes(s.cwd);
		note(s.n, { requests: mine.length, ownAgentsMd: own, foreignAgentsMd: foreign, bashPwdIsOwnCwd: pwdOk, relativeReadOk: readOk, relativeWrite: wrote, cwdInSystemPrompt: sysCwd });
		ok &&= own && foreign.length === 0 && pwdOk && readOk && wrote === `written-by-${s.n}`;
	}
	note("process.cwd() unchanged", process.cwd() === procCwd);
	note("peak concurrent model requests", env.mock.state.maxInflight);
	note("stray out.txt in process cwd", fs.existsSync(path.join(procCwd, "out.txt")));
	for (const s of sessions) s.session.dispose();
	return ok && process.cwd() === procCwd ? "works" : "FAILED";
});

await check("A2", "Do event streams stay separate between concurrent sessions?", async (note) => {
	const a = await newSession(env, { cwd: agentRepo("alpha") });
	const b = await newSession(env, { cwd: agentRepo("beta") });
	await Promise.all([
		a.session.prompt(mockMsg([{ delayMs: 100, text: "ALPHA-ANSWER", chunkDelayMs: 5 }])),
		b.session.prompt(mockMsg([{ delayMs: 100, text: "BETA-ANSWER", chunkDelayMs: 5 }])),
	]);
	const txt = (ev) => JSON.stringify(ev.filter((e) => e.type === "message_end"));
	const aLeak = txt(a.events).includes("BETA-ANSWER");
	const bLeak = txt(b.events).includes("ALPHA-ANSWER");
	note("alpha saw beta output", aLeak);
	note("beta saw alpha output", bLeak);
	note("alpha settled events", types(a.events).filter((t) => t === "agent_settled").length);
	a.session.dispose();
	b.session.dispose();
	return !aLeak && !bLeak ? "isolated" : "LEAK";
});

await check("A3", "Can two sessions in one process use different agent dirs (models, user-level AGENTS.md)?", async (note) => {
	const env2 = await makeEnv("multicwd-second", { mock: env.mock });
	write(path.join(env.agentDir, "AGENTS.md"), "USER-LEVEL-MARKER-ONE\n");
	write(path.join(env2.agentDir, "AGENTS.md"), "USER-LEVEL-MARKER-TWO\n");
	const a = await newSession(env, { cwd: agentRepo("one") });
	const b = await newSession(env2, { cwd: agentRepo("two") });
	env.mock.reset();
	await a.session.prompt("first agentdir");
	await b.session.prompt("second agentdir");
	const [ra, rb] = env.mock.state.requests;
	const res = {
		aHasOne: systemOf(ra).includes("USER-LEVEL-MARKER-ONE"),
		aHasTwo: systemOf(ra).includes("USER-LEVEL-MARKER-TWO"),
		bHasTwo: systemOf(rb).includes("USER-LEVEL-MARKER-TWO"),
		bHasOne: systemOf(rb).includes("USER-LEVEL-MARKER-ONE"),
	};
	note("system prompt markers", res);
	a.session.dispose();
	b.session.dispose();
	fs.rmSync(path.join(env.agentDir, "AGENTS.md"));
	return res.aHasOne && !res.aHasTwo && res.bHasTwo && !res.bHasOne ? "works" : "FAILED";
});

await check("A4", "Where do persistent session files go, and are they grouped per cwd?", async (note) => {
	const cwdA = agentRepo("persist-a");
	const cwdB = agentRepo("persist-b");
	const a = await newSession(env, { cwd: cwdA, inMemory: false });
	const b = await newSession(env, { cwd: cwdB, inMemory: false });
	await a.session.prompt("persist a");
	await b.session.prompt("persist b");
	note("session file a", a.session.sessionFile?.replace(env.agentDir, "<agentDir>"));
	note("session file b", b.session.sessionFile?.replace(env.agentDir, "<agentDir>"));
	const first = fs.readFileSync(a.session.sessionFile, "utf8").split("\n").filter(Boolean);
	note("jsonl entry types", first.map((l) => JSON.parse(l).type));
	note("jsonl header", JSON.parse(first[0]));
	a.session.dispose();
	b.session.dispose();
	return path.dirname(a.session.sessionFile) !== path.dirname(b.session.sessionFile) ? "per-cwd directories" : "shared directory";
});

await check("A5", "What does a session cost in one process (creation time, memory) at 1, 10 and 50 sessions?", async (note) => {
	global.gc?.();
	const rss0 = process.memoryUsage().rss;
	const heap0 = process.memoryUsage().heapUsed;
	const held = [];
	const cwd = agentRepo("scale");
	const marks = {};
	const t0 = Date.now();
	for (let i = 1; i <= 50; i++) {
		held.push(await newSession(env, { cwd }));
		if (i === 1 || i === 10 || i === 50) {
			global.gc?.();
			marks[i] = { ms: Date.now() - t0, rssMB: +((process.memoryUsage().rss - rss0) / 1048576).toFixed(1), heapMB: +((process.memoryUsage().heapUsed - heap0) / 1048576).toFixed(1) };
		}
	}
	note("cumulative cost by session count", marks);
	env.mock.reset();
	const t1 = Date.now();
	await Promise.all(held.map((s, i) => s.session.prompt(mockMsg([{ delayMs: 200, text: `answer-${i}` }]))));
	note("50 concurrent prompts wall ms (model delay 200 ms)", Date.now() - t1);
	note("peak concurrent model requests", env.mock.state.maxInflight);
	note("all answered correctly", held.every((s, i) => s.session.getLastAssistantText() === `answer-${i}`));
	for (const s of held) s.session.dispose();
	return "measured";
});

await check("A6", "Does anything get written outside the explicit agentDir (decoy global dir, ~/.pi)?", async (note) => {
	note("files in decoy PI_CODING_AGENT_DIR", listFiles(DECOY));
	note("~/.pi exists", fs.existsSync(path.join(os.homedir(), ".pi")));
	return listFiles(DECOY).length === 0 && !fs.existsSync(path.join(os.homedir(), ".pi")) ? "nothing leaked" : "LEAKED";
});

saveResults("t01.json");
await env.mock.close();
await sleep(50);
process.exit(0);
