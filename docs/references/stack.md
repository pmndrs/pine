# Technology and internals

## What pine is made of

| Piece | Role | Notes |
|---|---|---|
| Node 24+ | Runtime | Runs the TypeScript sources directly in a checkout (type stripping); the npm package holds them compiled to JavaScript (`npm run build`). No bundler. |
| `@earendil-works/pi-coding-agent` 1.5.1 | The agent loop | Sessions, model calls, tool execution, compaction, retries, MCP client, skills, extensions. pine embeds it through its SDK. |
| `node:sqlite` | Storage | One file, `data/pine.db`: events, tasks, shared state, and what pine keeps for itself (what sources remember, when schedules last fired, which conversations have read outside content, their folders, pins, goals and lists of steps, what `/undo` can take back, the open tabs). WAL mode. |
| `undici` | HTTP client behind `fetch` | pine installs timeouts for the model servers' connection pools; the `web` MCP server, the `download` tool and the `http` source use it for address checks at connect time. |
| `@earendil-works/pi-mcp` | MCP naming | pi's MCP package; pine uses its function that turns a server name into the prefix of its tool names. |
| `mqtt` | MQTT client | Only loaded when an `mqtt` source starts. |
| `@earendil-works/pi-tui` | Terminal UI toolkit | pi's own: full-screen layout, editor with completion, Markdown rendering. Used by `src/tui/`. |
| `highlight.js` | Code colours | Colours code blocks in the terminal UI. |
| `@playwright/mcp` | Browser automation | Started as a child of `mcp/browser.ts`, which filters its tools and proxies its traffic. `pine init` downloads the browser it drives. |
| `sandbox-exec`, `bwrap` | Containment | The system's sandbox: Apple's on macOS, driven by a generated profile; bubblewrap on Linux, driven by generated mounts. One set of rules for both (`src/security.ts`, `src/sandbox-linux.ts`). |
| `git` | Changes, diffs and undo | The system's own. The code pane asks it what changed in a folder, and `/undo` keeps the states of a folder as git trees in `data/snapshots`. It always runs inside a sandbox, without network and with everything a repository's settings could make it start turned off; only undo may write, and only pine's own snapshot folder and the conversation's folder (`src/workspace-view.ts`, `src/snapshots.ts`). |
| `swiftc` | App control on macOS | `mcp/computer.swift`, the helper that reads windows and sends clicks and keys, is compiled on the Mac it runs on the first time it is needed, and kept in pine's home. Needs Apple's command line developer tools (`xcode-select --install`). See [computer.md](computer.md). |
| `sips`, `ffmpeg` | Pictures and video in the terminal UI | Convert what is shown: `sips` on macOS; `ffmpeg`, if installed, for video and on Linux. Both run confined, without network. |
| `osascript`; `ffplay`, `mpv`, `pw-play`, `paplay`, `aplay` | Sound in the terminal UI | Plays a sound file an answer points at: on macOS the system's audio player (AVFoundation, through a script `osascript` runs), on Linux the first of the others that is installed. Runs confined, without network. A pause ends the player and play starts one from that place; `pw-play`, `paplay` and `aplay` cannot start in the middle and are held instead (SIGSTOP). |
| `typebox` | Tool parameter schemas | The same library pi uses. |
| `claude -p` | Development model | Optional; used by `pine dev-model`, by the terminal UI when the home's model is `dev/...` (the example home), and by the live tests. |

Development only: `typescript` (type check, and compiling the npm package), `@types/node`, `aedes` (an MQTT broker for the tests).

## Why pi, and how it is embedded

pi supplies the part that is hard to get right and the same for every agent: the turn loop,
tool-call parsing and repair, context compaction, retry on server errors, session files, MCP.
pine adds what a daemon with several agents needs around it.

Every agent session is a pi `AgentSessionRuntime` created in `AgentManager.createLive()`:

- its own `cwd` (the workspace, or the folder you opened for the conversation) and `agentDir` (`agents/<id>/`), so instructions, skills,
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
| `npm test` | More than 250 tests in about ten seconds, files in parallel. The ones whose name starts with `live:` are skipped | The scripted model server in `baseline/tests/mock.mjs` |
| `npm run test:live` | The `live:` tests of `test/live.test.ts`, `test/browser.test.ts` and `test/computer.test.ts`: delegation to a specialist that reads its files, then a hostile event; an agent that sets up, uses and removes an MCP server, a skill, an event source and a schedule when asked in plain words; an agent driving the real browser; and, on a Mac, app control with the real helper (its own demo window, and TextEdit when the terminal has the grants) | A real model through `claude -p`; Chromium and the network |
| `npm run baseline` | 59 checks of pi itself | The scripted model server |

The scripted server answers according to a directive embedded in the prompt
(`<<MOCK {"steps":[...]}>>`), which makes every tool call in a test deterministic. Tests start a
whole daemon in-process on a temp home, and real pieces where it matters: a real sandbox, a real
MQTT broker, real MCP server processes, a fake Telegram API on localhost. App control is tested
on a stand-in for its helper, a script that speaks the helper's protocol, so no test of the
ordinary suite touches a real app or needs macOS. The terminal UI is
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
6. **Linux.** The whole suite has run on Ubuntu 24.04 on arm64 (in a VM). `pine init` was run
   there on a machine without bubblewrap (it installed it, wrote and loaded the AppArmor
   rule), and in a bare `node:24` container with pine installed from its npm package (it
   installed bubblewrap and the browser's libraries; the browser then started). Not run:
   x86-64 (the system call filter has that processor's numbers, untested), other
   distributions and their package managers (dnf, yum, pacman, zypper, apk: the commands are
   written, none was run), Podman, and the terminal UI in a real Linux terminal (only through
   the suite's fake terminal). With the network
   granted, Linux still lets a command reach socket files in the temp folders, which macOS
   refuses. There is no sandbox
   on other systems; the shell tool is withheld there.
7. **Not built:** a Slack source, a web dashboard, voice. Slack would be a source type like
   `telegram`: one that talks and can send.
