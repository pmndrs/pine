import { check, makeEnv, newSession, saveResults, systemOf, toolNames, types } from "./lib.mjs";
import { mockMsg } from "./mock.mjs";

const env = await makeEnv("smoke");

await check("S1", "Does a custom openai-completions provider from models.json work end to end?", async (note) => {
	const s = await newSession(env);
	await s.session.prompt("hello there");
	const req = env.mock.state.requests[0];
	note("last assistant text", s.session.getLastAssistantText());
	note("request url", req.url);
	note("auth header", req.auth);
	note("model sent", req.body.model);
	note("stream", req.body.stream);
	note("request keys", Object.keys(req.body));
	note("tools declared", toolNames(req));
	note("system prompt chars", systemOf(req).length);
	note("roles", req.body.messages.map((m) => m.role));
	note("event types", [...new Set(types(s.events))]);
	note("active tools", s.session.getActiveToolNames());
	s.session.dispose();
	return s.session.getLastAssistantText()?.startsWith("ECHO[") ? "works" : "FAILED";
});

await check("S2", "Does one prompt run a model → tool → model loop on its own?", async (note) => {
	env.mock.reset();
	const s = await newSession(env);
	await s.session.prompt(mockMsg([{ tools: [{ name: "bash", args: { command: "echo tool-ran-$((6*7))" } }] }]));
	note("requests made", env.mock.state.requests.length);
	note("final text", s.session.getLastAssistantText());
	note("event sequence", types(s.events).filter((t) => !/update|message_start|message_end|entry_appended/.test(t)));
	note("tool message sent back", env.mock.state.requests[1]?.body.messages.at(-1));
	s.session.dispose();
	return s.session.getLastAssistantText()?.includes("tool-ran-42") ? "works" : "FAILED";
});

saveResults("t00.json");
await env.mock.close();
process.exit(0);
