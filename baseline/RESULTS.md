# pi baseline — `@earendil-works/pi-coding-agent` 1.5.1

Run on 2026-11-10, Node 26.7, macOS (M4 Pro). 59 checks in 10 suites, all against a scripted
OpenAI-compatible mock server (`tests/mock.mjs`). No real model was involved, so this charts the
harness, not model quality. Re-run with `./run-all.sh`; raw output is in `results/*.log`.

## The questions that were open

| Question | Result | Check |
|---|---|---|
| Several sessions with different `cwd` in one process | Works. Each session got its own AGENTS.md, its own bash/read/write root, its own event stream; `process.cwd()` never changed. 3 concurrent runs, 3 concurrent model requests. | A1, A2 |
| Different agent dirs per session in one process | Works for models, settings, user-level AGENTS.md and skills. Does **not** apply to `mcp.json` or default session storage (see gotchas). | A3, M0b, C5 |
| Cost of a session in-process | 50 sessions: 54 ms to create, about 8 MB RSS in total. 50 concurrent prompts completed in one model round-trip. | A5 |
| Cost of a session as its own `pi` process | About 120 MB RSS idle, about 200 ms to start. | SA4, SA5 |
| Sub-agents | Not built in. An in-process child session started from a custom tool works: isolated context, own repo, parallel children, parent abort propagates through the tool's `signal`. The shipped `examples/extensions/subagent` is **broken in an SDK host**. | SA1–SA3 |
| MCP | Built in since this line of releases, but opt-in for SDK sessions. stdio and streamable HTTP both work; direct, codemode and deferred exposure all work; crash recovery works. | M0–M8 |
| Auto-compaction | Works on threshold and on a llama-server style overflow error (compact, then retry). | C1, C2 |
| Retry | 500, 429 and 503 retry with backoff; 400 does not. `prompt()` never throws on model failure. | C3, C4 |
| Steering and follow-up | Work as documented, in SDK and RPC. | Q1–Q3, SA5 |
| Resume after restart or crash | Works from the JSONL file, including after `SIGKILL` of an RPC process. | C5, SA6 |

## Gotchas that change the daemon design

1. **Project trust defaults to on in the SDK.** `SettingsManager.create()` and `.inMemory()` default
   `projectTrusted` to `true`. A `.pi/extensions/*.ts` in the agent's repo is executed inside the
   host process, and `.pi/settings.json` is applied, with no prompt. An agent that can write files
   in its own repo can therefore run code in the daemon on the next session load. Pass
   `{ projectTrusted: false }` — then only `AGENTS.md` loads from the repo. (C6, C6b)
2. **A stream that goes silent after the headers hangs.** `httpIdleTimeoutMs` covers "no response
   headers" (timed out at 1.5 s when set to 1500) but not "headers, then nothing": still hanging
   when the test gave up after 6 s. The CLI installs an undici dispatcher for this; the SDK does
   not export it. Installing `undici.setGlobalDispatcher(new Agent({ bodyTimeout }))` in the host
   fixed it. (C8)
3. **`session.dispose()` leaks MCP server processes.** stdio servers were still alive 1.5 s after
   dispose. `AgentSessionRuntime.dispose()` stops them (it emits `session_shutdown`). (M4, M4b)
4. **`mcp.json` is read from the global agent dir, not the session's `agentDir`.** Per-agent
   servers need `pi.registerMcpServer()` from an inline extension, or a project `.pi/mcp.json`
   (which needs trust, see 1). (M0b, M4)
5. **`SessionManager.create(cwd)` stores under the global agent dir**, in a per-cwd folder,
   ignoring the `agentDir` passed to `createAgentSession`. Pass `sessionDir` explicitly. (C5, A4)
6. **bash has no default timeout.** The schema says so; a per-call `timeout` works, but only if the
   model sets it. An unattended run needs a host-side cap (a `tool_call` handler can mutate
   `event.input.timeout`). (T7)
7. **`pi -p` hangs when stdin is an open pipe.** With `child_process` defaults it waited on stdin
   and never sent a model request (8 s, then killed). Spawn with stdin ignored. (SA4)
8. **`AGENTS.md` is read once.** An edit was not seen on the next prompt; `session.reload()` picks
   it up and keeps history. Matters for agents that edit their own instructions or memory. (X5)
9. **`prompt()` resolves even when the model call failed.** Check the last message's `stopReason`
   (`error`, `aborted`) and `errorMessage`. (C3, C4, Q4)

## Things that worked better than expected

- **Malformed tool calls** (broken JSON, unknown tool, missing argument, double-encoded arguments,
  empty arguments) all come back to the model as a readable error and the run continues. A numeric
  `command` was coerced to a string and executed. (T3)
- **Tool gating without UI**: a `tool_call` handler returning `{ block: true, reason }` blocks the
  call and the reason goes to the model. It also sees MCP calls made from inside a codemode script.
  A handler that throws blocks the call (fails closed). (T2, M8, X7)
- **Tool allowlist is enforced**, not just hidden: calling an unlisted tool returns "not found". (T5)
- **Tool calls in one assistant message run in parallel**: 3 × `sleep 1` took 1.0 s. (T4)
- **Abort kills the whole bash process tree** and closes the HTTP request to the model server. (Q4, Q5)
- **Output truncation**: 3 MB of bash output reached the model as 34 KB plus a path to the full log;
  a 60 KB MCP result as 20 KB plus a path. (T6, M1)
- **Events as context**: `sendCustomMessage(..., { triggerTurn })` reaches the model as a user
  message; `triggerTurn: false` stores it silently until the next run. While the session is busy the
  default is steer; `followUp` and `nextTurn` also work. (Q7, X3)
- **Shared event bus is native**: pass one `createEventBus()` to every session's resource loader
  and `pi.events` is shared; one agent's tool woke another agent's session. (X2)
- **Per-turn world state**: a `before_agent_start` handler can rewrite the system prompt each run
  without leaving stale state in history. (X4)
- **Single model call without a session**: `modelRuntime.completeSimple(model, context)`, images
  included. (X1)
- **Thinking**: `reasoning_content` deltas are parsed into thinking blocks and replayed on the next
  request. With `compat.thinkingFormat: "deepseek"` the request carries `thinking: {type: "enabled"}`. (X6)
- **Long sessions**: 300 turns with compaction grew the heap by 2.6 MB; session file 1 MB. (X8)
- **Nothing was written to `~/.pi`** or the decoy global dir by the SDK suites. (A6)

## Request shape pi sends (relevant for llama-server)

`model, messages, stream, stream_options, store, max_completion_tokens, tools` and, for reasoning
models, `reasoning_effort`. Each of `store`, the max-tokens field name, and the thinking format has a
`compat` switch in `models.json`. After an aborted run the next request contains two consecutive
user messages (the aborted assistant message is not replayed).

## Not covered

- Any real model: tool-call reliability of a 2–3-bit DeepSeek quant, real token counts, speed.
- A real llama-server: its handling of `store`, `max_completion_tokens`, consecutive user messages,
  and the chat template's tool-call format. pi's built-in `llama.cpp` router provider was not tested.
- The `anthropic-messages` path against llama-server's `/v1/messages`.
- MCP OAuth, MCP resources, and codemode's classifier and image-model calls.
- Sandboxing or containerised tool execution (`docs/containerization.md`).
- Bun as host runtime.
