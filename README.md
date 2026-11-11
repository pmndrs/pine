<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo-light.svg" alt="pine" width="360">
  </picture>
</h1>

This is a small daemon that runs several AI agents. A "harness". Yes, you've heard that before.

We needed something different:

- Orchestrating agents, ... well, boring. Yes it does that.
- Letting agents react to any external event: chat, FTP, webhooks, MQTT, timers, etc, in a simple modular way. Without configs. Agents can subscribe to any installed event source and react accordingly. List available sources and unsubscribe. Event sources are simple to create (it's a \*.ts service with a schema). Basically this allows you to create full automation workflows and with complete ease.
- No configs that agents can mess up (OC, Hermes, looking at you). Only MAIN agent can create other agents. MAIN can create global MCPs, global event sources, etc. Other agents can only create these either for their local conversation or scope. You configure by telling agents what you want. MAIN has special administrative tool calls. No agent will touch or bypass into user config (your tokens), etc.
- A CLI that doesn't suck. That feels like a desktop UI, with interactive tabs, buttons, scroll regions, etc. That is able to show images, videos, formats markdown, etc. That can drag and drop files and images (with thumbnails) - and yes in a shell.
- Basics inbuilt: computer use, tool calls, internet, browsing and operating live websites
- Doesn't do unintuitive. If it's running it's on. If it isn't it isn't.

Basically OpenCode with a nicer GUI + Openclaw without the bloat and configs + [pi coding agent](https://pi.dev) for basic turns, auto compact and hosted model providers.

<p align="center">
  <img src="docs/images/meme.png" width="49%" alt="pine searches the web, downloads a picture and shows it in the terminal">
  <img src="docs/images/video.gif" width="49%" alt="pine fetches a video from the web and plays it in the terminal">
</p>
<p align="center">
  <img src="docs/images/drop.png" width="49%" alt="A picture dropped into the terminal, shown as a thumbnail, and the agent's answer about it">
  <img src="docs/images/watch.png" width="49%" alt="Asked to watch a folder, the agent sets up an event source; a file changes, it wakes up and shows the git diff">
</p>
<p align="center">
  <img src="docs/images/tabs.png" width="49%" alt="Tabs for several agents and conversations, with the list of conversations: pinned ones stay, the others clean themselves up">
  <img src="docs/images/flipper.png" width="49%" alt="pine drives a Flipper Zero through an MCP server">
</p>
<p align="center"><sub>Pictures and video from the web · drag and drop · subscribing to a folder and waking on a change · tabs, agents and conversations · MCP tools</sub></p>

```
 Telegram ─┐                                   ┌─ rule: set state, publish
 MQTT ─────┤                                   │
 files ────┼─► event log ─► routes ────────────┼─ one model call
 webhooks ─┤   (SQLite)     filter, debounce   │
 schedules ┘       ▲                           └─ agent turn (pi session)
       ...         │                                │  delegate ─► other agents
                   └──── answers, agent events ◄────┘  subagent ─► parallel copies
```

## Quick start

Requires Node 24 or newer and macOS (for the sandbox).

```bash
npm install -g @pmndrs/pine
```

Sets everything up: the browser the web tools drive, and your user folder (`~/.pine`).

```bash
pine init
```

```bash
pine
```

That is a home in `~/.pine` with one agent, `main`, and the terminal UI talking to it. Out of
the box the model is Claude through `claude -p`, so Claude Code has to be installed and signed
in. To use something else, sign in and switch with `/model` in the UI:

```bash
pine login opencode-go
```

`pine login anthropic` and `pine login openai-codex` use a Claude or ChatGPT subscription; a
local llama-server goes into `~/.pine/models.json`. To run pine without the UI, as a service:
`pine start`. See [operations.md](docs/references/operations.md) and
[tui.md](docs/references/tui.md).

To get a newer version later, with whatever it needs:

```bash
pine update
```

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
