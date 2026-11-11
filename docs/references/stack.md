# Technology and internals

## What pine is made of

| Piece | Role | Notes |
|---|---|---|
| Node 24+ | Runtime | Runs the TypeScript sources directly (type stripping). No build, no bundler. |
| `@earendil-works/pi-coding-agent` 1.5.1 | The agent loop | Sessions, model calls, tool execution, compaction, retries, MCP client, skills, extensions. pine embeds it through its SDK. |
| `node:sqlite` | Storage | One file, `data/pine.db`: events, tasks, shared state, storage of sources. WAL mode. |
| `undici` | HTTP client behind `fetch` | pine installs timeouts for the model servers' connection pools; the `web` MCP server uses it for address checks at connect time. |
| `@earendil-works/pi-mcp` | MCP naming | pi's MCP package; pine uses its function that turns a server name into the prefix of its tool names. |
| `mqtt` | MQTT client | Only loaded when an `mqtt` source starts. |
| `@earendil-works/pi-tui` | Terminal UI toolkit | pi's own: full-screen layout, editor with completion, Markdown rendering. Used by `src/tui/`. |
| `highlight.js` | Code colours | Colours code blocks in the terminal UI. |
| `@playwright/mcp` | Browser automation | Started as a child of `mcp/browser.ts`, which filters its tools and proxies its traffic. `pine init` downloads the browser it drives. |
| `sandbox-exec` | Containment | macOS's sandbox, driven by a generated profile per agent. |
| `typebox` | Tool parameter schemas | The same library pi uses. |
| `claude -p` | Development model | Optional; used by `pine dev-model`, by the terminal UI when the home's model is `dev/...` (the example home), and by the live test. |

Development only: `typescript` (type check), `aedes` (an MQTT broker for the tests).

## Why pi, and how it is embedded

pi supplies the part that is hard to get right and the same for every agent: the turn loop,
tool-call parsing and repair, context compaction, retry on server errors, session files, MCP.
pine adds what a daemon with several agents needs around it.

Every agent session is a pi `AgentSessionRuntime` created in `AgentManager.createLive()`:

- its own `cwd` (the workspace) and `agentDir` (`agents/<id>/`), so instructions, skills,
  settings and session files are per agent, all in one process;
- pi's MCP, code-mode and tool-search extensions when the agent has MCP servers;
- pine's core extension (`coreExtension()`), which registers the agent's MCP servers, replaces
  the shell and file tools with sandboxed ones, adds the `download` tool, appends the `<pine>`
  block to the system prompt (the same text every turn), and gates every tool call;
- the tools from `tools.ts`.

A session costs little: the baseline measured about 8 MB for 50 sessions in one process.

## What the baseline found

Before pine was written, 59 checks charted how pi 1.5.1 behaves when embedded
([baseline/RESULTS.md](../../baseline/RESULTS.md)). The findings that shaped the design:

| Finding | Consequence in pine |
|---|---|
| Sessions with different working folders and agent folders work side by side in one process | One process, no worker per agent |
| Embedded sessions trust the workspace by default and would run `.pi/extensions` from it | `trustWorkspace` defaults to false |
| A model stream that goes silent after its headers hangs forever | Idle and header timeouts on the model servers' connections |
| `session.dispose()` leaves MCP server processes running | Sessions are closed through their runtime |
| The MCP extension reads `mcp.json` from pi's global folder, not the session's | Servers are registered per session from pine's configuration; pi's global folder is redirected |
| Session files default to pi's global folder | Explicit session folders per agent |
| The shell tool has no default time limit | A limit the model cannot raise |
| Instruction files are read once | Reload when a file changed |
| `prompt()` resolves even when the model call failed | The result is read from the last assistant message |
| No built-in sub-agents; the shipped example breaks when embedded | `delegate` and `subagent` are pine tools running child sessions in-process |
| Malformed tool calls come back to the model as readable errors | Nothing to do; it is why a weaker local model is workable |
| Tool calls in one assistant message run in parallel | Slots are lent out per waiting call, not per run |
| pi also discovers skills and instruction files in the user's home | Filtered to configured locations |

Run `npm run baseline` after upgrading pi and compare with `RESULTS.md`.

## The request pi sends

`model, messages, stream, stream_options, store, max_completion_tokens, tools`, and
`reasoning_effort` for reasoning models. Each of `store`, the max-tokens field and the thinking
format has a `compat` switch in `models.json`. After an aborted run the next request contains
two consecutive user messages.

## Tests

| Suite | Runs | Against |
|---|---|---|
| `npm test` | 119 tests (two of them only run with `test:live`) in about ten seconds, files in parallel | The scripted model server in `baseline/tests/mock.mjs` |
| `npm run test:live` | Delegation to a specialist that reads its files, then a hostile event; and an agent driving the real browser | A real model through `claude -p`; Chromium and the network |
| `npm run baseline` | 59 checks of pi itself | The scripted model server |

The scripted server answers according to a directive embedded in the prompt
(`<<MOCK {"steps":[...]}>>`), which makes every tool call in a test deterministic. Tests start a
whole daemon in-process on a temp home, and real pieces where it matters: a real sandbox, a real
MQTT broker, real MCP server processes, a fake Telegram API on localhost. The terminal UI is
driven through an in-memory terminal (`test/support/terminal.ts`) and asserted on what its
screen shows.

## Open points

Not verified yet, in rough order of importance:

1. **A real llama-server.** Whether it accepts `store` and `max_completion_tokens` (the example
   `models.json` switches both off), two consecutive user messages after an abort, and how its
   chat template renders tool calls. pi's built-in llama.cpp router provider was not tried.
2. **A quantised local model.** How reliably a 2 to 3 bit quantisation of a large model calls
   tools, follows the `delegate` protocol, and resists text that tells it what to do. The live
   test passes with Claude Haiku, which says little about that.
3. **Hosted providers.** `pine login` was tested with a made-up key only. No request has gone
   through OpenCode, Anthropic or OpenAI from pine yet, and the browser sign-in flows
   (`anthropic`, `openai-codex`) have not been run. OpenCode Go rejected a request without a
   session id during a probe; agent sessions send one, single model calls from routes now do too.
4. **Throughput.** `maxConcurrentRuns` against llama-server's parallel slots, and the latency
   of sub-agents when slots are scarce.
5. **Long uptimes.** Weeks of running: database growth, session file growth, MCP servers that
   die and reconnect.
6. **Other platforms.** There is no sandbox outside macOS; the shell tool is withheld there.
7. **Not built:** a Slack adapter, a web dashboard, voice. A Slack adapter would be a source
   type like `telegram`: one that talks and can send.
