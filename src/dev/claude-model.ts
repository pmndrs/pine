// Development model server: an OpenAI-compatible /v1/chat/completions endpoint whose answers come
// from `claude -p`. It lets pine (and pi) run against a capable model before a local one is set
// up. Each request starts one `claude` process, so it is slow and uses your Claude plan; do not
// point a production daemon at it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const RULES = `You are standing in for a language model behind an OpenAI-style chat completions API. An agent harness sends you its system prompt, the tools it offers and the conversation so far. Your only job is to write the next assistant message.

You have no tools of your own in this role. The tools listed in <tools> belong to the harness: you ask for them in your reply, the harness runs them and sends the conversation back with the results in <tool_result> blocks.

Reply with exactly one JSON object and nothing else (no prose before or after, no code fence):

{"text": "<what the assistant says, may be empty>", "tool_calls": [{"name": "<tool name>", "arguments": { ... }}]}

- "arguments" must match the tool's parameter schema.
- Every tool in <tools> is available. Use them the way the harness system prompt expects: act, do not ask for permission to use a tool the role is meant to use.
- Several calls in one reply are fine. Never state the outcome of a call before you have seen its <tool_result>.
- When the task is done or needs no tool, put the answer in "text" and use "tool_calls": [].
- Pictures of the conversation are attached to this message, in order. Where one belongs, the conversation says [picture 1], [picture 2] and so on.

Play the role the harness system prompt defines.`;

/** The model's reply is one JSON object; tolerate a code fence or stray text around it. */
export function parseReply(raw: string): { text: string; tool_calls: Array<{ name: string; arguments: unknown }> } {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start >= 0 && end > start) {
		try {
			const o = JSON.parse(raw.slice(start, end + 1));
			if (o && typeof o === "object" && ("text" in o || "tool_calls" in o)) {
				return { text: String(o.text ?? ""), tool_calls: Array.isArray(o.tool_calls) ? o.tool_calls.filter((c: any) => c && typeof c.name === "string") : [] };
			}
		} catch {
			// fall through: treat the whole reply as text
		}
	}
	return { text: raw.trim(), tool_calls: [] };
}

/** A picture of a request, as `claude` takes it. */
export interface Picture {
	media_type: string;
	data: string;
}

/**
 * The prompt for a request. Pictures cannot be part of a text: each leaves a mark where it
 * stood and is added to `pictures`, which go along with the prompt in the same order.
 */
export function buildPrompt(body: any, pictures: Picture[] = []): string {
	const textOf = (content: any): string =>
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.map((p) => {
							if (p.type === "text") return p.text;
							const m = p.type === "image_url" ? /^data:([^;,]+);base64,(.+)$/s.exec(String(p.image_url?.url ?? "")) : null;
							if (!m) return `[${p.type} omitted]`;
							pictures.push({ media_type: m[1], data: m[2] });
							return `[picture ${pictures.length}]`;
						})
						.join("")
				: "";
	const messages: any[] = body.messages ?? [];
	const system = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n\n");
	const tools = (body.tools ?? []).map((t: any) => ({ name: t.function?.name ?? t.name, description: t.function?.description ?? t.description, parameters: t.function?.parameters ?? t.parameters }));
	const turns = messages
		.filter((m) => m.role !== "system" && m.role !== "developer")
		.map((m) => {
			if (m.role === "tool") return `<tool_result id="${m.tool_call_id ?? ""}">\n${textOf(m.content)}\n</tool_result>`;
			if (m.role === "assistant") {
				const calls = (m.tool_calls ?? []).map((c: any) => `<tool_call id="${c.id}" name="${c.function?.name}">${c.function?.arguments ?? "{}"}</tool_call>`).join("\n");
				return `<assistant>\n${[textOf(m.content), calls].filter(Boolean).join("\n")}\n</assistant>`;
			}
			return `<user>\n${textOf(m.content)}\n</user>`;
		});
	return `<harness_system_prompt>\n${system}\n</harness_system_prompt>\n\n<tools>\n${JSON.stringify(tools, null, 1)}\n</tools>\n\n<conversation>\n${turns.join("\n")}\n</conversation>\n\nWrite the next assistant message now, as the single JSON object described in your instructions.`;
}

export interface ClaudeModelOptions {
	port?: number;
	host?: string;
	/** Model alias passed to `claude --model`. Default "haiku". */
	model?: string;
	/** How many `claude` processes may run at once. Default 3. */
	concurrency?: number;
	claudePath?: string;
	log?: (line: string) => void;
}

export async function startClaudeModel(opts: ClaudeModelOptions = {}) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pine-claude-model-"));
	const max = opts.concurrency ?? 3;
	const log = opts.log ?? (() => {});
	let active = 0;
	const queue: Array<() => void> = [];
	const stats = { requests: 0, failures: 0 };
	const take = () => (active < max ? (active++, Promise.resolve()) : new Promise<void>((r) => queue.push(r)));
	const give = () => {
		const next = queue.shift();
		if (next) next();
		else active--;
	};

	const ask = (prompt: string, model: string, signal: AbortSignal, pictures: Picture[] = []) =>
		new Promise<ReturnType<typeof parseReply>>((resolve, reject) => {
			// A prompt with pictures goes in as a message of parts, and the answer comes back as a stream of lines whose last one is the result.
			const format = pictures.length ? ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] : ["--output-format", "json"];
			const child = spawn(
				opts.claudePath ?? "claude",
				["-p", "--model", model, ...format, "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", "", "--disable-slash-commands", "--system-prompt", RULES],
				{ cwd, stdio: ["pipe", "pipe", "pipe"] },
			);
			let out = "";
			let err = "";
			child.stdout.on("data", (d) => (out += d));
			child.stderr.on("data", (d) => (err += d));
			const onAbort = () => child.kill("SIGKILL");
			signal.addEventListener("abort", onAbort, { once: true });
			child.on("error", reject);
			child.on("close", (code) => {
				signal.removeEventListener("abort", onAbort);
				if (signal.aborted) return reject(new Error("aborted"));
				try {
					const json = pictures.length ? out.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).findLast((m) => m?.type === "result") : JSON.parse(out);
					if (!json) throw new Error("no result in the output");
					if (json.is_error) throw new Error(String(json.result ?? "claude reported an error"));
					resolve(parseReply(String(json.result ?? "")));
				} catch (e) {
					reject(new Error(`claude -p failed (exit ${code}): ${(e as Error).message} ${err.slice(0, 300)}`));
				}
			});
			child.stdin.on("error", () => {});
			child.stdin.end(pictures.length ? `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }, ...pictures.map((p) => ({ type: "image", source: { type: "base64", ...p } }))] } })}\n` : prompt);
		});

	const server = http.createServer(async (req, res) => {
		if (req.method === "GET") {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ object: "list", data: ["haiku", "sonnet", "opus"].map((id) => ({ id: `claude-${id}`, object: "model" })) }));
		}
		let raw = "";
		for await (const c of req) raw += c;
		let body: any;
		try {
			body = JSON.parse(raw);
		} catch {
			res.writeHead(400, { "content-type": "application/json" });
			return res.end(JSON.stringify({ error: { message: "invalid JSON" } }));
		}
		const abort = new AbortController();
		res.on("close", () => !res.writableEnded && abort.abort());
		const model = /^(claude-)?(haiku|sonnet|opus|fable)$/.test(String(body.model)) ? String(body.model).replace(/^claude-/, "") : (opts.model ?? "haiku");
		const pictures: Picture[] = [];
		const prompt = buildPrompt(body, pictures);
		stats.requests++;
		const t0 = Date.now();
		await take();
		let answer: Awaited<ReturnType<typeof ask>>;
		try {
			answer = await ask(prompt, model, abort.signal, pictures);
		} catch (e) {
			stats.failures++;
			give();
			if (abort.signal.aborted) return;
			log(`request failed: ${(e as Error).message}`);
			res.writeHead(500, { "content-type": "application/json" });
			return res.end(JSON.stringify({ error: { message: (e as Error).message, type: "server_error" } }));
		}
		give();
		const calls = answer.tool_calls
			.map((c, i) => ({ index: i, id: `call_${stats.requests}_${i}`, type: "function", function: { name: c.name, arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}) } }));
		log(`${model} ${Date.now() - t0} ms: ${calls.length ? calls.map((c) => c.function.name).join(", ") : `text (${answer.text.length} chars)`}`);
		const usage = { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: Math.ceil((answer.text.length + JSON.stringify(calls).length) / 4), total_tokens: 0 };
		usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
		const id = `chatcmpl-claude-${stats.requests}`;
		const base = { id, created: Math.floor(Date.now() / 1000), model: body.model };
		const finish = calls.length ? "tool_calls" : "stop";
		if (!body.stream) {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: answer.text, ...(calls.length ? { tool_calls: calls.map(({ index: _i, ...c }) => c) } : {}) }, finish_reason: finish }], usage }));
		}
		const chunk = (delta: unknown, finish_reason: string | null = null, extra = {}) => res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		chunk({ role: "assistant", content: "" });
		for (let i = 0; i < answer.text.length; i += 80) chunk({ content: answer.text.slice(i, i + 80) });
		for (const c of calls) chunk({ tool_calls: [c] });
		chunk({}, finish, { usage });
		res.write("data: [DONE]\n\n");
		res.end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", (e: NodeJS.ErrnoException) => reject(e.code === "EADDRINUSE" ? new Error(`port ${opts.port} is already in use; pick another with --port and set the same port in models.json`) : e));
		server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve);
	});
	const port = (server.address() as any).port;
	return {
		port,
		baseUrl: `http://127.0.0.1:${port}/v1`,
		stats,
		close: () =>
			new Promise<void>((r) => {
				server.closeAllConnections?.();
				server.close(() => r());
				fs.rmSync(cwd, { recursive: true, force: true });
			}),
	};
}
