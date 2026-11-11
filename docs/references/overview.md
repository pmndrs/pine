# How pine works

## The picture

You talk to an agent, in the terminal UI or on Telegram. An agent is given four things, each by
asking it: two that wake it, and two that it uses while it works.

```
                  you:  terminal UI · Telegram
                               │
                               ▼
 wake it                 ┌───────────┐            it uses
 events ───────────────► │           │ ◄───────── MCP servers
   Telegram · MQTT · FTP │           │ ◄───────── skills
   webhooks · folders    │   agent   │
   web addresses         │           │
   commands · etc        │           │
 schedules ────────────► │           │
   repeating · once      └─────┬─────┘
                               │  delegate ──► other agents
                               │  subagent ──► with distinct prompts, in parallel
                               ▼
                 answers · messages · actions
```

| Given | What it is | Tools | More |
|---|---|---|---|
| Events | Something that happens elsewhere wakes the agent: a file arrives, a device reports, a web address changes, you write on Telegram | `add_source`, `subscribe`, `send` | [sources.md](sources.md) |
| Schedules | The time wakes the agent, with a task: at set times, every so often, or once | `add_schedule` | [events.md](events.md) |
| MCP servers | Tools from outside that the agent can call | `add_mcp_server` | [mcp.md](mcp.md) |
| Skills | How something is done, written down once | `add_skill` | [agents.md](agents.md) |

Each of the four is set up for the conversation it was asked for in, for the agent, or (by the
main agent only) for all agents. Only the main agent creates other agents and registers new
types of event source. See [setup.md](setup.md).

How pine itself works is not in an agent's prompt. An agent looks it up with its `manual`
tool, which searches these pages ([agents.md](agents.md)).

## Inside the daemon

Underneath, everything is an event in one log, and three things turn events into work:
subscriptions, schedules with a task, and routes.

```
      what wakes an agent                       the daemon                        model server
┌────────────────────────────────┐   ┌──────────────────────────────┐      ┌──────────────────┐
│ event sources                  │   │  event log (SQLite)          │      │ llama-server or  │
│  telegram  a bot, long polling │──►│  topic · payload · trust     │      │ any OpenAI-style │
│  mqtt      a broker            │   │        │                     │      │ endpoint         │
│  folder    new, changed files  │   │        ▼                     │      └────────▲─────────┘
│  webhook   calls from services │   │  subscriptions, schedules    │               │
│  ftp       uploads             │   │  with a task, and routes     │               │ model slots
│  http      an address, polled  │   │   when · debounce · throttle │               │ (priority queue)
│  command   run again and again │   │        │                     │               │
│ schedules  cron · every · at   │   │        │                     │               │
└────────────────────────────────┘   │        ├─ set state          │               │
            ▲                        │        ├─ publish event      │               │
            │   answers, and what    │        ├─ one model call ────┼───────────────┤
            │   agents send          │        │                     │               │
            └────────────────────────┤        └─ agent task         │               │
                                     │             │                │               │
                                     │   ┌─────────▼────────────┐   │               │
                                     │   │ task queue (SQLite)  │   │               │
                                     │   │ one lane per session │   │               │
                                     │   └─────────┬────────────┘   │               │
                                     │   ┌─────────▼────────────┐   │               │
                                     │   │ pi session           │───┼───────────────┘
                                     │   │  workspace, AGENTS.md│   │
                                     │   │  tools, MCP, skills  │   │
                                     │   │  policy gate         │   │
                                     │   └──┬───────────────┬───┘   │
                                     │      │ delegate      │ subagent
                                     │      ▼               ▼       │
                                     │  other agents    copies of itself
                                     └──────────────────────────────┘
```

## Events

Everything that happens is an event. An event has:

| Field | Meaning |
|---|---|
| `id`, `ts` | Position in the log and time |
| `topic` | For example `source/telegram/message`, `source/house/message`, `agent/gonzo/done` |
| `source` | Who published it: `source:<name>` (`source:<name>@<agent>` for an agent's own source), `http`, `api`, `timer`, `route:<name>`, `router`, `agent:<id>`, `approvals`, `pine` |
| `payload` | Any JSON |
| `trust` | `owner` or `untrusted`; set by the publisher according to how the content arrived |
| `cause`, `hops` | The event that led to this one, and how many agent or route steps lie between it and an outside trigger |
| `reply` | Optional: the topic and fields an answer should be published with |

Events are stored in `data/pine.db` and pruned after `limits.eventRetentionDays`. A source can
report noisy telemetry without storing it.

Topics pine itself uses:

| Topic | Published when |
|---|---|
| `agent/<id>/started`, `agent/<id>/done`, `agent/<id>/failed` | A task starts or ends |
| `agent/<id>/tool` | A tool call starts or ends (live only, not stored) |
| `agent/<id>/delta`, `agent/<id>/thinking`, `agent/<id>/message` | Streamed answer text, the start of a thinking phase, the end of a model message with token counts (live only) |
| `state/<key>` | Shared state changes |
| `timer/<name>` | A schedule fires (`timer/<name>@<agent>` for an agent's own; `topic` on the schedule overrides it) |
| `source/<name>/<event>` | An event source reports something (`source/<name>@<agent>/<event>` for an agent's own source) |
| `out/source/<name>` | An answer on its way out through a source that can send |
| `hook/<name>` | A hook under `http.hooks` in `pine.json` was called (a `webhook` source reports `source/<name>/received` instead) |
| `approval/requested`, `approval/decided` | An approval is asked for or answered |
| `pine/started`, `pine/route-failed` | Daemon lifecycle and route errors |

Agents cannot publish on `agent/`, `approval/`, `pine/`, `state/` or `timer/`.

## From event to work

Three things start work, and the first two need nothing written by hand:

- **A subscription.** An agent subscribes a conversation to an event source (a folder, an MQTT
  device, a web address, a command, a webhook, an FTP drop, Telegram). Each event the source
  reports arrives in that conversation as a message and starts a turn. A source that nobody is
  subscribed to is not running, unless it has `"start": "always"`. See [sources.md](sources.md).
- **A schedule with a task.** When it is time, the agent is woken with the task, in the
  conversation the schedule belongs to. See [events.md](events.md).
- **A route.** A rule you write in `pine.json`: it names topic patterns and what to do. It can
  combine the first of these with one of the other two:
  1. **Rule.** Write shared state (`set`) or publish another event (`publish`). No model.
  2. **One model call** (`call`). No tools, no history: classify an image, summarise a reading.
     The answer can be published as a new event.
  3. **Agent turn** (`agent`). A task in an agent's session with its tools.

  Most events a route handles should stop at 1 or 2. See [events.md](events.md).

## Tasks, sessions, slots

A task is a prompt for one agent in one session. Tasks for the same session run one after another;
different sessions run side by side, limited by `limits.maxConcurrentRuns` model slots. A run
that only waits (for a delegated task, for sub-agents, for an approval) gives its slot up
meanwhile, so a chain of agents works even with one slot.

A session is a pi `AgentSession`: the model loop, tool calls, compaction and retries are pi's.
Named sessions are stored as JSONL under `agents/<id>/sessions/<key>/` and survive restarts.
`"session": "new"` gives a fresh one that is closed when the task ends. A live session is
closed after `idleMs` without work and resumed from disk when needed. A named session other
than `main` that is not pinned, not open in a tab of the terminal UI, not subscribed to a
source and without a schedule of its own is removed after `limits.conversationDays` (7; `0`:
never) without a message. A run that an outside event started works in a session of its own,
`<name>~u`, so its history is never shared with yours.

When the daemon restarts, queued tasks run; a task that was running is marked failed
("interrupted by a daemon restart") because its tool calls may already have had effects.

## Answers

When a task ends, pine publishes `agent/<id>/done` or `agent/<id>/failed`. If the task has a
reply target, the final text is also published there, for example on `out/source/telegram` with
the chat id, and the Telegram source sends it. An agent that answers exactly `NO_REPLY` (or
`SILENT`) sends nothing, which is how routine checks stay quiet. A task that failed sends a
line saying so; a cancelled one sends nothing.

## Agents working together

- `delegate` gives another agent a task. That agent runs it in its own workspace with its own
  tools and sees only the task text. By default the caller waits for the answer; with
  `wait: false` the answer arrives later as a message in the caller's session.
- `subagent` runs several copies of the same agent in parallel, each with its own task and an
  empty context, and returns their final answers. It keeps large searches out of the caller's
  context.
- Shared state (`state_get`, `state_set`) holds small facts such as `house/mode` that every agent
  can read and that can be shown to an agent in every turn.
- `publish_event` lets an agent put an event on a topic you allowed, which routes then act on.
- `send` lets an agent reach out through a source that can send: a message to you on Telegram,
  a command to a device over MQTT.

Loops are cut: a delegation chain cannot revisit an agent or exceed
`limits.maxDelegationDepth`, and events more than `limits.maxEventHops` steps away from an
outside trigger are not routed.

## Trust

How content entered decides what it can do. See [security.md](security.md) for all of it.

| Content | Arrives as | Runs with |
|---|---|---|
| Your message in the terminal UI or from your paired Telegram account, `pine send`, a schedule (yours, or one an agent made at your wish) | `owner` | The agent's full tool set, in the named session |
| A webhook, an MQTT message, a new file, handled by a route | `untrusted` | The agent's `untrusted` profile (read-only tools by default), in a separate session |
| An event of a source a conversation is subscribed to | framed as data; taints that conversation unless the source is marked as yours | The conversation's own tool set, but sending information out needs your approval. With `"separate": true` on the subscription: as the row above |
| A web page, or the result of an MCP server marked `taints`, read during your own request | taints the session | Full tool set and full rights; from then on a reviewer checks what reaches out, sends something or changes the agent's memory |
