# pine

This is a small daemon that runs several AI agents. A "harness". Yes, you've heard that before.

I needed something that ...

- Orchestrates agents, well, boring
- That lets agents react to any external event: chat messages, FTP, webhooks, MQTT, a timer, etc, in a simple modular way.
- That has no configs that agents can mess up (OC, Hermes, looking at you). Only MAIN agent can create other agents. MAIN can create global MCPs, global event sources, etc. Other agents can only create these either for their local conversation or scope. You configure by telling MAIN what you want. It has to go through its administrative tool calls, it won't touch main config, tokens, etc. No agent can bypass into that.
- Has a CLI that does not suck. That feels like a desktop UI, with interactive tabs, buttons, scroll regions, etc. That is able to show images, videos, formats markdown, etc. That can drag and drop files and images (with thumbnails) - and yes in a shell.
- Computer use, tool calls, internet, browsing and operating live website inbuilt.

Basically OpenCode with a nicer GUI + Openclaw without the bloat and configs + [pi coding agent](https://pi.dev) for basic turns, auto compact and hosted model providers.

```
 Telegram ─┐                                   ┌─ rule: set state, publish
 MQTT ─────┤                                   │
 files ────┼─► event log ─► routes ────────────┼─ one model call
 webhooks ─┤   (SQLite)     filter, debounce   │
 schedules ┘       ▲                           └─ agent turn (pi session)
                   │                                │  delegate ─► other agents
                   └──── answers, agent events ◄────┘  subagent ─► parallel copies
```

## Quick start

Requires Node 24 or newer and macOS (for the sandbox).

```bash
npm install
```

```bash
bin/pine browser-install
```

```bash
bin/pine init
```

```bash
bin/pine
```

That is a home in `~/.pine` with one agent, `main`, and the terminal UI talking to it. Out of
the box the model is Claude through `claude -p`, so Claude Code has to be installed and signed
in. To use something else, sign in and switch with `/model` in the UI:

```bash
bin/pine login opencode-go
```

`pine login anthropic` and `pine login openai-codex` use a Claude or ChatGPT subscription; a
local llama-server goes into `~/.pine/models.json`. To run pine without the UI, as a service:
`bin/pine start`. See [operations.md](docs/references/operations.md) and
[tui.md](docs/references/tui.md).

## Documentation

Start at [docs/SKILL.md](docs/SKILL.md); it indexes everything.

| To do this                                                                              | Read                                                         |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Understand how the pieces fit                                                           | [overview.md](docs/references/overview.md)                   |
| Use the terminal UI                                                                     | [tui.md](docs/references/tui.md)                             |
| Install, run, use the CLI, run it as a service                                          | [operations.md](docs/references/operations.md)               |
| Write `pine.json` and `agent.json`                                                      | [configuration.md](docs/references/configuration.md)         |
| Let agents set things up by tool call instead of editing files                          | [setup.md](docs/references/setup.md)                         |
| Set up agents, delegation and sub-agents                                                | [agents.md](docs/references/agents.md)                       |
| Route events, schedules, model calls                                                    | [events.md](docs/references/events.md)                       |
| Event sources agents subscribe to: folders, MQTT devices, webhooks, FTP uploads, timers | [sources.md](docs/references/sources.md)                     |
| Telegram, MQTT publishing, your own plugins                                             | [plugins.md](docs/references/plugins.md)                     |
| MCP servers, web search, command tools                                                  | [mcp.md](docs/references/mcp.md)                             |
| Know what is protected and what is not                                                  | [security.md](docs/references/security.md)                   |
| Work on pine itself                                                                     | [AGENTS.md](AGENTS.md), [stack.md](docs/references/stack.md) |

## Tests

```bash
npm test
```

About ten seconds: every test runs against a scripted model server, nothing leaves the
machine. `npm run test:live` adds a run against a real model through `claude -p` and one with
the real browser.
`npm run check` type-checks. `npm run baseline` re-runs the 59 checks that chart how the pi SDK
behaves when embedded ([baseline/RESULTS.md](baseline/RESULTS.md)).

## Status

Version 0.1. Verified against a scripted model and against Claude through `claude -p`. Not yet
run against llama.cpp, a quantised local model, or a hosted provider signed in with
`pine login`; see the open points at the end of [stack.md](docs/references/stack.md).
