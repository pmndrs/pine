import fs from "node:fs";
import path from "node:path";
import { check, makeEnv, newSession, saveResults, sleep, types } from "./lib.mjs";
import { mockMsg, textOf } from "./mock.mjs";

const env = await makeEnv("queue");
const life = (events) => types(events).filter((t) => /^(agent_|turn_|tool_execution_(start|end)|queue_update|compaction|auto_retry)/.test(t));
const userTexts = (req) => req.body.messages.filter((m) => m.role === "user").map((m) => textOf(m.content).replace(/<<MOCK.*>>/s, "<directive>"));

await check("Q1", "What happens when prompt() is called while a run is in progress?", async (note) => {
	const s = await newSession(env);
	const p = s.session.prompt(mockMsg([{ delayMs: 400, text: "slow answer" }]));
	await sleep(100);
	note("isStreaming while running", s.session.isStreaming);
	let err;
	try {
		await s.session.prompt("second prompt without behavior");
	} catch (e) {
		err = e.message;
	}
	note("plain prompt() error", err);
	let viaOption;
	try {
		await s.session.prompt("second prompt as followUp", { streamingBehavior: "followUp" });
		viaOption = "accepted";
	} catch (e) {
		viaOption = `rejected: ${e.message}`;
	}
	note("prompt() with streamingBehavior:'followUp'", viaOption);
	await p;
	await s.session.waitForIdle();
	note("final text", s.session.getLastAssistantText());
	s.session.dispose();
	return err ? "rejects unless queue mode given" : "UNEXPECTED: accepted";
});

await check("Q2", "Where does steer() land when the agent is in the middle of a tool call?", async (note) => {
	env.mock.reset();
	const s = await newSession(env);
	const p = s.session.prompt(
		mockMsg([
			{ tools: [{ name: "bash", args: { command: "sleep 1; echo first-tool-done" } }] },
			{ tools: [{ name: "bash", args: { command: "echo second-tool-should-be-skipped" } }] },
			{ text: "original plan finished" },
		]),
	);
	await sleep(400);
	const disp = await s.session.steer("STEER: stranger at the door");
	note("steer() returned", disp);
	await p;
	await s.session.waitForIdle();
	note("lifecycle", life(s.events));
	note("requests", env.mock.state.requests.length);
	note("user messages in request 2", userTexts(env.mock.state.requests[1]));
	note("roles in request 2", env.mock.state.requests[1].body.messages.map((m) => m.role));
	note("final text", s.session.getLastAssistantText());
	note("prompt() resolved after steer handled", true);
	const ranSecond = JSON.stringify(env.mock.state.requests.map((r) => r.body.messages)).includes("second-tool-should-be-skipped\\n");
	note("second planned tool executed", ranSecond);
	s.session.dispose();
	return "steer lands after the current tool call, before the next model request";
});

await check("Q3", "Where does followUp() land, and does prompt() wait for it?", async (note) => {
	env.mock.reset();
	const s = await newSession(env);
	let promptResolvedAt;
	const t0 = Date.now();
	const p = s.session
		.prompt(mockMsg([{ tools: [{ name: "bash", args: { command: "sleep 0.5; echo t1" } }] }, { tools: [{ name: "bash", args: { command: "echo t2" } }] }, { text: "original plan finished" }]))
		.then(() => (promptResolvedAt = Date.now() - t0));
	await sleep(200);
	note("followUp() #1 returned", await s.session.followUp("FOLLOWUP-ONE"));
	note("followUp() #2 returned", await s.session.followUp("FOLLOWUP-TWO"));
	await p;
	const settledBefore = types(s.events).filter((t) => t === "agent_settled").length;
	await s.session.waitForIdle();
	note("lifecycle", life(s.events));
	note("agent_end count", types(s.events).filter((t) => t === "agent_end").length);
	note("agent_settled count when prompt() resolved", settledBefore);
	note("requests", env.mock.state.requests.length);
	note("user messages per request", env.mock.state.requests.map(userTexts));
	note("final text", s.session.getLastAssistantText());
	s.session.dispose();
	return "measured";
});

await check("Q4", "Does abort() stop a stalled model stream and leave the session usable?", async (note) => {
	env.mock.reset();
	const s = await newSession(env);
	let outcome;
	const p = s.session.prompt(mockMsg([{ stall: true }])).then(
		() => (outcome = "resolved"),
		(e) => (outcome = `rejected: ${e.message}`),
	);
	await sleep(300);
	const t0 = Date.now();
	await s.session.abort();
	note("abort() took ms", Date.now() - t0);
	await p;
	note("prompt() outcome", outcome);
	await sleep(400);
	note("server saw connection closed", env.mock.state.requests[0].aborted);
	note("lifecycle", life(s.events));
	note("agent_settled.aborted", s.events.find((e) => e.type === "agent_settled")?.aborted);
	const last = s.session.messages.at(-1);
	note("last message", { role: last?.role, stopReason: last?.stopReason, errorMessage: last?.errorMessage });
	await s.session.prompt("after abort");
	note("next prompt after abort", s.session.getLastAssistantText());
	note("roles sent after abort", env.mock.state.requests.at(-1).body.messages.map((m) => m.role));
	s.session.dispose();
	return s.session.getLastAssistantText() === "ECHO[after abort]" ? "works" : "FAILED";
});

await check("Q5", "Does abort() kill a long-running bash tool (and its children)?", async (note) => {
	const s = await newSession(env);
	const pidFile = path.join(s.cwd, "pid.txt");
	const p = s.session.prompt(mockMsg([{ tools: [{ name: "bash", args: { command: `echo $$ > pid.txt; sleep 60 & echo $! > child.txt; wait` } }] }])).catch((e) => e);
	for (let i = 0; i < 40 && !fs.existsSync(path.join(s.cwd, "child.txt")); i++) await sleep(50);
	await sleep(100);
	const pid = Number(fs.readFileSync(pidFile, "utf8"));
	const child = Number(fs.readFileSync(path.join(s.cwd, "child.txt"), "utf8"));
	const alive = (n) => {
		try {
			process.kill(n, 0);
			return true;
		} catch {
			return false;
		}
	};
	note("before abort: shell alive / child alive", [alive(pid), alive(child)]);
	const t0 = Date.now();
	await s.session.abort();
	await p;
	note("abort() took ms", Date.now() - t0);
	await sleep(300);
	note("after abort: shell alive / child alive", [alive(pid), alive(child)]);
	const res = [alive(pid), alive(child)];
	if (alive(child)) process.kill(child, "SIGKILL");
	s.session.dispose();
	return !res[0] && !res[1] ? "kills the whole process tree" : res[0] ? "SHELL SURVIVES" : "CHILD SURVIVES";
});

await check("Q6", "Does dispose() during a run stop it cleanly?", async (note) => {
	env.mock.reset();
	const s = await newSession(env);
	let outcome;
	const p = s.session.prompt(mockMsg([{ stall: true }])).then(
		() => (outcome = "resolved"),
		(e) => (outcome = `rejected: ${e.message}`),
	);
	await sleep(400);
	s.session.dispose();
	await Promise.race([p, sleep(3000)]);
	await sleep(400);
	note("prompt() outcome after dispose", outcome ?? "still pending after 3 s");
	note("server saw connection closed", env.mock.state.requests[0]?.aborted);
	note("events after dispose", types(s.events).filter((t) => /agent_/.test(t)));
	return outcome ? "run ends" : "PROMISE HANGS";
});

await check("Q7", "How do non-user events enter the context (sendCustomMessage), and what does the model see?", async (note) => {
	env.mock.reset();
	const s = await newSession(env);
	await s.session.sendCustomMessage({ customType: "bus-event", content: "EVENT cam/front/motion threat=low", display: true, details: { topic: "cam/front/motion" } }, { triggerTurn: false });
	note("requests after silent event (triggerTurn:false)", env.mock.state.requests.length);
	await s.session.sendCustomMessage({ customType: "bus-event", content: "EVENT printer/finished job=benchy", display: true }, { triggerTurn: true });
	await s.session.waitForIdle();
	note("requests after triggering event", env.mock.state.requests.length);
	const req = env.mock.state.requests.at(-1);
	note("messages the model received", req?.body.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: textOf(m.content).slice(0, 80) })));
	note("final text", s.session.getLastAssistantText());
	s.session.dispose();
	return "measured";
});

saveResults("t02.json");
await env.mock.close();
process.exit(0);
