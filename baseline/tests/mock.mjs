// Scripted OpenAI-compatible chat/completions server.
// The last user message may carry a directive:  <<MOCK {"steps":[ ... ]}>>
//   step = { tools:[{name,args}|{name,rawArgs}], text?, delayMs?, chunkDelayMs?, stall? } | { text }
// Step index = number of assistant messages after the directive message.
// Without a directive the server echoes the last user text. Requests without tools get a summary reply.
import http from "node:http";

const textOf = (content) =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("")
			: "";

export async function startMock(opts = {}) {
	const state = {
		requests: [],
		failNext: [], // [{status, body, headers?}] consumed one per request
		inflight: 0,
		maxInflight: 0,
		closed: 0,
		scripts: {}, // name -> steps, referenced from a prompt as @@REF:name@@
	};

	const server = http.createServer(async (req, res) => {
		// opts.props: what a llama.cpp server says about itself at /props (how many slots it has).
		// A `status` in it is the answer's status: 503 is what a scheduler in front of the server says while no model is loaded.
		if (req.method === "GET" && opts.props && req.url.endsWith("/props")) {
			res.writeHead(opts.props.status ?? 200, { "content-type": "application/json" });
			res.end(JSON.stringify(opts.props));
			return;
		}
		if (req.method === "GET") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
			return;
		}
		let raw = "";
		for await (const c of req) raw += c;
		let body;
		try {
			body = JSON.parse(raw);
		} catch {
			body = { _unparsed: raw };
		}
		const entry = { t: Date.now(), url: req.url, auth: req.headers.authorization, body, reply: null, aborted: false };
		// opts.onRequest: a host's view of the request it sent (the harness of pine's tests keeps the wire form beside it).
		opts.onRequest?.(entry);
		state.requests.push(entry);
		state.inflight++;
		state.maxInflight = Math.max(state.maxInflight, state.inflight);
		let done = false;
		const finish = () => {
			if (!done) {
				done = true;
				state.inflight--;
			}
		};
		res.on("close", () => {
			if (!res.writableEnded) {
				entry.aborted = true;
				state.closed++;
			}
			finish();
		});

		const fail = state.failNext.shift();
		if (fail) {
			entry.reply = { fail };
			res.writeHead(fail.status, { "content-type": "application/json", ...(fail.headers ?? {}) });
			res.end(typeof fail.body === "string" ? fail.body : JSON.stringify(fail.body ?? { error: { message: "mock failure" } }));
			return;
		}

		const messages = body.messages ?? [];
		let lastUserIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				lastUserIdx = i;
				break;
			}
		}
		// opts.strip: text a host adds to user messages (pine's notes) that the script should not see.
		const lastUserText = (lastUserIdx >= 0 ? textOf(messages[lastUserIdx].content) : "").replace(opts.strip ?? /(?!)/, "");
		const after = messages.slice(lastUserIdx + 1);
		const assistantCount = after.filter((m) => m.role === "assistant").length;
		const toolResults = after.filter((m) => m.role === "tool").map((m) => textOf(m.content));

		let step;
		const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
		const m = lastUserText.match(/<<MOCK (.*?)>>/s);
		const ref = m ? null : lastUserText.match(/@@REF:(\w+)@@/);
		if (ref && hasTools) {
			step = (state.scripts[ref[1]] ?? [{ text: `UNKNOWN-REF ${ref[1]}` }])[assistantCount] ?? {
				text: `FINAL:: ${toolResults.map((t) => t.slice(0, 2000)).join(" || ")}`,
			};
		} else if (!hasTools && typeof opts.withoutTools === "function") {
			// A host that makes plain model calls of its own (a reviewer) scripts their answers here.
			const system = messages.find((x) => x.role === "system" || x.role === "developer");
			step = { text: String(opts.withoutTools({ system: system ? textOf(system.content) : "", user: lastUserText, body })) };
		} else if (!hasTools && !opts.directivesWithoutTools) {
			step = { text: `SUMMARY-OK chars=${raw.length}` };
		} else if (m) {
			let directive;
			try {
				directive = JSON.parse(m[1]);
			} catch (e) {
				directive = { steps: [{ text: `BAD-DIRECTIVE ${e.message}` }] };
			}
			step = directive.steps[assistantCount] ?? {
				text: `FINAL:: ${toolResults.map((t) => t.slice(0, 2000)).join(" || ")}`,
			};
		} else {
			step = { text: `ECHO[${lastUserText.slice(0, 300)}]` };
		}
		entry.reply = step;

		const id = `chatcmpl-${state.requests.length}`;
		const chunk = (delta, finish_reason = null, extra = {}) =>
			`data: ${JSON.stringify({
				id,
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: body.model,
				choices: [{ index: 0, delta, finish_reason }],
				...extra,
			})}\n\n`;
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

		if (step.delayMs) await sleep(step.delayMs);
		if (res.destroyed) return;
		// A request that is not to be streamed (a host that has a slot read a beginning ahead of time) is answered in one piece.
		if (body.stream === false) {
			if (opts.prefixCache) (state.seen ??= []).push(JSON.stringify(body.tools ?? []) + JSON.stringify(body.messages ?? []).slice(0, -1));
			const read = Math.ceil(raw.length / 4);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ id, object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: (step.text ?? "").slice(0, 1) }, finish_reason: "length" }], usage: { prompt_tokens: read, completion_tokens: 1, total_tokens: read + 1 } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		res.write(chunk({ role: "assistant", content: "" }));
		if (step.stall) return; // never finishes; client must abort

		if (step.reasoning) {
			for (let i = 0; i < step.reasoning.length; i += 24) res.write(chunk({ reasoning_content: step.reasoning.slice(i, i + 24) }));
			// A model that is still thinking: nothing more comes for this long.
			if (step.reasoningHoldMs) await sleep(step.reasoningHoldMs);
			if (res.destroyed) return;
		}
		const text = step.text ?? "";
		for (let i = 0; i < text.length; i += 24) {
			if (res.destroyed) return;
			res.write(chunk({ content: text.slice(i, i + 24) }));
			if (step.chunkDelayMs) await sleep(step.chunkDelayMs);
		}
		const tools = step.tools ?? [];
		tools.forEach((t, index) => {
			res.write(
				chunk({
					tool_calls: [
						{
							index,
							id: t.id ?? `call_${state.requests.length}_${index}`,
							type: "function",
							function: { name: t.name, arguments: t.rawArgs ?? JSON.stringify(t.args ?? {}) },
						},
					],
				}),
			);
		});
		const promptTokens = opts.promptTokens ? opts.promptTokens(body, raw) : Math.ceil(raw.length / 4);
		// opts.prefixCache: behave like a server with a prompt cache. The part of this request that an
		// earlier request already started with, tools first and then the messages, counts as cached.
		let cachedTokens = 0;
		if (opts.prefixCache) {
			const wire = JSON.stringify(body.tools ?? []) + JSON.stringify(body.messages ?? []).slice(0, -1);
			for (const earlier of state.seen ?? []) {
				let n = 0;
				const max = Math.min(wire.length, earlier.length);
				while (n < max && wire.charCodeAt(n) === earlier.charCodeAt(n)) n++;
				cachedTokens = Math.max(cachedTokens, Math.floor(n / 4));
			}
			(state.seen ??= []).push(wire);
			cachedTokens = Math.min(cachedTokens, promptTokens);
		}
		const completionTokens = Math.ceil((text.length + JSON.stringify(tools).length) / 4);
		res.write(
			chunk({}, tools.length ? "tool_calls" : (step.finishReason ?? "stop"), {
				usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, ...(opts.prefixCache ? { prompt_tokens_details: { cached_tokens: cachedTokens } } : {}) },
			}),
		);
		res.write("data: [DONE]\n\n");
		res.end();
	});

	await new Promise((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
	const port = server.address().port;
	return {
		port,
		baseUrl: `http://127.0.0.1:${port}/v1`,
		state,
		reset() {
			state.requests.length = 0;
			state.failNext.length = 0;
			state.maxInflight = 0;
			state.closed = 0;
		},
		close: () =>
			new Promise((r) => {
				server.closeAllConnections?.();
				server.close(r);
			}),
	};
}

export const mockMsg = (steps, prefix = "") => `${prefix}<<MOCK ${JSON.stringify({ steps })}>>`;
export { textOf };
