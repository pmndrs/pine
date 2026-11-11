---
name: pine
description: Run, configure and extend pine, the event-driven multi-agent daemon built on the pi coding agent SDK. Use when setting up agents and their workspaces, routing events (Telegram, MQTT, files, webhooks, schedules) to agents, subscribing agents to event sources (Telegram, folders, MQTT, webhooks, FTP uploads, timers), adding MCP servers, reaching agents on Telegram, delegating between agents, reviewing what is protected against prompt injection, or changing pine's code.
---

# pine

pine (PI neural engine) is one process that hosts several pi agent sessions and an event log.
Adapters and event sources turn the outside world into events; routes and subscriptions turn
events into work; agents answer, act, hand tasks to each other, and publish events of their own.

Three things to know before anything else:

1. **Configuration lives in a home directory**, by default `~/.pine`: `pine.json` (global),
   `models.json` (pi's model file), `.env` (secrets), and one folder per agent under `agents/`.
2. **An agent is a folder**: `agents/<id>/agent.json` and a workspace. In the workspace lie the
   files the agent keeps itself and that are read into its prompt: `AGENTS.md` (its purpose),
   `SOUL.md` (who it is), `MEMORY.md` (its memory). `USER.md` in the home is what all agents
   know about you. The workspace is wherever `workspace` points, for example a repository.
3. **Where content came from decides what it may do.** Your own messages get the agent's full
   tool set. Anything else is data. An event from outside runs with a reduced tool set in a
   separate session; an event from a source a conversation subscribed to arrives in that
   conversation, framed as data, and marks it as having read outside content. Either way nothing
   is sent out without your approval.

## If you are an agent running inside pine

You can read this manual. pine's configuration lives in its home folder (`~/.pine` unless your
owner chose another), which is closed to you on purpose: you never write those files. Some things
you set up by calling a tool, described below and in [references/setup.md](references/setup.md):
remote MCP servers, event sources and subscriptions, for the conversation you are in or for
yourself as an agent. Creating agents and anything for all agents is the main agent's job; if
you are not the main agent, send your owner to it. For everything else your owner asks about (a
skill, a schedule, a route, your built-in tools or model):

1. Read the reference for it from the table below. The files are in `references/` next to this
   one; use their absolute paths.
2. Tell your owner what to put where: usually a few lines of JSON in `pine.json` (for everyone)
   or `agents/<your id>/agent.json` (for you), then `pine check`, then a restart of the daemon
   (quitting and reopening the terminal UI restarts an embedded one).
3. Do not try to edit those files or work around the restriction. Say plainly that this is a
   step for them.

One thing you can start yourself: when your owner asks you to install or connect a remote MCP
server and gives you its https URL, call `add_mcp_server` with a short name and that URL. Leave
the scope out: the server is then for the conversation you are in (in your main conversation:
for you as an agent). Pass `scope: "agent"` only if they said it is for you in general, and, as
the main agent, `scope: "global"` only if they said "for all agents". They get a dialog and
confirm it. `remove_mcp_server` takes one out again. Do not probe the URL first; an
"unauthorized" answer only means the server wants a sign-in, which your owner does afterwards
with `/mcp login <name>` in the terminal UI or `pine mcp login <name>` in a shell. Tell them
that. A local server (a command to run) is theirs to add: `pine mcp add <name> -- <command>`.

Another: when your owner asks you to watch something or to react when something happens, call
your `sources` tool: it lists what you can subscribe to and what you are subscribed to (use it
too when your owner asks what you are watching). If one fits, subscribe to it with a note that
says what you are to do; whoever is subscribed is woken with that note whenever it reports
something. A subscription is for the conversation it is asked for in: that one is woken, and the
subscription goes when the conversation is closed, reset or removed. So leave the scope out.
Only when your owner says in so many words that it is for more do you pass one: agent (your
main conversation is woken instead, and it stays) or, if you are the main agent, global (all
agents); your owner is then asked to confirm. Do not pick a wider scope yourself; if you think
they want one, ask. You can end anything your own agent is subscribed to from any of its
conversations (`unsubscribe` with scope `agent` or `all`). If none fits,
set one up with `add_source` (a folder to watch, a time, an MQTT device, a webhook, an FTP drop);
your owner confirms it where that is needed. `remove_source` deletes one for good. Do not go
looking in pine's home folder for what is configured: `sources` tells you.

If you are the main agent and your owner asks for a new agent, call `create_agent` with an id,
one line on what it is for, and its instructions written to the agent itself ("You are ..."):
its job, what it should and should not do, how it reports. Your owner confirms it, and the agent
exists at once.

Things you can do yourself: work in your workspace, keep notes there, use the tools you have,
hand work to the agents listed in your prompt, and write shared state under your own keys.

## Which file to read

| You want to | Read |
|---|---|
| See how events, routes, tasks and sessions fit together | [references/overview.md](references/overview.md) |
| Chat with agents in the terminal: tabs, slash commands, approvals, switching models | [references/tui.md](references/tui.md) |
| Work on a project: `pine .`, a folder for a conversation, the code pane with git changes, files and tool output | [references/coding.md](references/coding.md) |
| Install it, start it, use the CLI, run it at login, find out why something did not happen | [references/operations.md](references/operations.md) |
| Look up a key in `pine.json`, `agent.json`, `models.json` or `.env` | [references/configuration.md](references/configuration.md) |
| Know what agents can set up by tool call, for whom, and what you are asked: MCP servers, event sources, new agents | [references/setup.md](references/setup.md) |
| Add an agent, give it a workspace, tools and a persona; delegation, sub-agents, sessions, shared state | [references/agents.md](references/agents.md) |
| Let an agent react to the outside world and reach out: Telegram, a watched folder, MQTT devices, webhooks, FTP uploads from cameras, timers; subscribing, unsubscribing, sending | [references/sources.md](references/sources.md) |
| Write rules for events yourself: set state, publish, single model calls, schedules, debounce | [references/events.md](references/events.md) |
| Add MCP servers globally or per agent; web search, page reading and the bundled browser; turn shell commands into tools | [references/mcp.md](references/mcp.md) |
| Understand the defences against outside abuse and prompt injection, and their limits | [references/security.md](references/security.md) |
| Know the technology underneath and the pi behaviours pine works around; open points | [references/stack.md](references/stack.md) |
| Change pine's code | [../AGENTS.md](../AGENTS.md) |

## The shortest working setup

```bash
npm install -g @pmndrs/pine
```

```bash
pine init
```

```bash
pine
```

One agent, `main`, with web search and a browser, and the terminal UI to talk to it. Everything
below is added on top of that when you need it.

`~/.pine/pine.json`:

```json
{
  "main": "main",
  "defaults": { "model": "local/deepseek-v4.1-flash" }
}
```

Telegram as a second way in is set up by asking the main agent: "watch Telegram, here is the
bot's token". See [references/sources.md](references/sources.md).

`~/.pine/agents/gonzo/agent.json`, a second agent, a specialist the main agent can hand work to
(create the folder and a `workspace` folder in it; an `AGENTS.md` in the workspace says what
the agent is for). Or ask the main agent to create one: it calls `create_agent`, and no restart is needed.

```json
{
  "description": "Contract law; knows the case files",
  "workspace": "~/dev/gonzo"
}
```

```bash
pine check
```

```bash
pine start
```

`main` sees `gonzo` in its list of agents and can call `delegate`. `pine events -f` shows everything as it happens.

## Vocabulary

| Term | Meaning |
|---|---|
| event | One record in the log: topic, payload, source, trust, cause |
| topic | Slash-separated name, matched with `+` (one level) and `#` (the rest) |
| route | A rule in `pine.json` that reacts to topics |
| source | A named thing that reports events from outside: a folder, an MQTT broker, a webhook, an FTP drop, a timer. It runs only while something is subscribed to it |
| subscription | A conversation of an agent listens to a source: each event arrives there as a message and wakes the agent |
| task | One piece of work for one agent; has a status, a result and statistics |
| session | A conversation of one agent with history. The manual also says "conversation". Named ones are kept until removed (unused ones after `limits.conversationDays`); `new` is one-off |
| owner | You. Content is "owner" only when it entered through a channel that authenticated you |
| untrusted | Everything else: data that may contain instructions it has no right to give |
| tainted | A session that has seen outside content (a web page, an MCP result, an untrusted task) |
| approval | Your yes or no to one tool call, asked in the terminal UI and over Telegram, or answered with `pine approve` |
| extension | A pi extension: pi's own plug-in format, usable in pine sessions |
