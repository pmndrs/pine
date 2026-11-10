# How pine works

## The picture

```
            adapters (plugins)                  the daemon                        model server
 ┌────────────────────────────────┐   ┌──────────────────────────────┐      ┌──────────────────┐
 │ telegram   long polling        │   │  event log (SQLite)          │      │ llama-server or  │
 │ mqtt       broker subscription │──►│  topic · payload · trust     │      │ any OpenAI-style │
 │ watch      new files           │   │        │                     │      │ endpoint         │
 │ http       webhooks, API       │   │        ▼                     │      └────────▲─────────┘
 │ timers     cron, intervals     │   │  routes                      │               │
 └────────────────────────────────┘   │   when · debounce · throttle │               │ model slots
             ▲                        │        │                     │               │ (priority queue)
             │                        │        ├─ set state          │               │
             │   out/telegram/...     │        ├─ publish event      │               │
             │   out/mqtt             │        ├─ one model call ────┼───────────────┤
             └────────────────────────┤        └─ agent task         │               │
                                      │             │                │               │
                                      │   ┌─────────▼────────────┐   │               │
                                      │   │ task queue (SQLite)  │   │               │
                                      │   │ one lane per session │   │               │
                                      │   └─────────┬────────────┘   │               │
                                      │   ┌─────────▼────────────┐   │               │
                                      │   │ pi session           │───┼───────────────┘
                                      │   │  workspace, AGENTS.md│   │
                                      │   │  tools, MCP, plugins │   │
                                      │   │  policy gate         │   │
                                      │   └──┬───────────────┬───┘   │
                                      │      │ delegate      │ subagent
                                      │      ▼               ▼       │
                                      │  other agents    parallel copies
                                      └──────────────────────────────┘
```

## Events

Everything that happens is an event. An event has:

| Field | Meaning |
|---|---|
| `id`, `ts` | Position in the log and time |
| `topic` | For example `telegram/main/message`, `mqtt/house/door`, `agent/gonzo/done` |
| `source` | Who published it: a plugin name, `source:<name>`, `http`, `api`, `timer`, `route:<name>`, `agent:<id>` |
| `payload` | Any JSON |
| `trust` | `owner` or `untrusted`; set by the publisher according to how the content arrived |
| `cause`, `hops` | The event that led to this one, and how many agent or route steps lie between it and an outside trigger |
| `reply` | Optional: the topic and fields an answer should be published with |

Events are stored in `data/pine.db` and pruned after `limits.eventRetentionDays`. Adapters can
publish noisy telemetry without storing it.

Topics pine itself uses:

| Topic | Published when |
|---|---|
| `agent/<id>/started`, `agent/<id>/done`, `agent/<id>/failed` | A task starts or ends |
| `agent/<id>/tool` | A tool call starts or ends (live only, not stored) |
| `agent/<id>/delta`, `agent/<id>/thinking`, `agent/<id>/message` | Streamed answer text, the start of a thinking phase, the end of a model message with token counts (live only) |
| `state/<key>` | Shared state changes |
| `timer/<name>` | A schedule fires |
| `hook/<name>` | A webhook was accepted |
| `source/<name>/<event>` | An event source reports something (`source/<name>@<agent>/<event>` for an agent's own source) |
| `approval/requested`, `approval/decided` | An approval is asked for or answered |
| `pine/started`, `pine/route-failed` | Daemon lifecycle and route errors |

Agents cannot publish on `agent/`, `approval/`, `pine/`, `state/` or `timer/`.

## From event to work

A route names topic patterns and what to do. It can do several things at once, cheapest first:

1. **Rule.** Write shared state (`set`) or publish another event (`publish`). No model.
2. **One model call** (`call`). No tools, no history: classify an image, summarise a reading.
   The answer can be published as a new event.
3. **Agent turn** (`agent`). A task in an agent's session with its tools.

Most events should stop at 1 or 2. See [events.md](events.md).

The common case needs no route: an agent subscribes to an event source (a folder, an MQTT
device, a webhook, an FTP drop, a timer), and each event the source reports arrives in the
subscribed conversation as a message and starts a turn. A source that nobody is subscribed to
is not running. See [sources.md](sources.md).

## Tasks, sessions, slots

A task is a prompt for one agent in one session. Tasks for the same session run one after another;
different sessions run side by side, limited by `limits.maxConcurrentRuns` model slots. A run
that only waits (for a delegated task, for sub-agents, for an approval) gives its slot up
meanwhile, so a chain of agents works even with one slot.

A session is a pi `AgentSession`: the model loop, tool calls, compaction and retries are pi's.
Named sessions are stored as JSONL under `agents/<id>/sessions/<key>/` and survive restarts.
`"session": "new"` gives a fresh one that is closed when the task ends. A live session is
closed after `idleMs` without work and resumed from disk when needed. A named session other
than `main` that is not pinned, not open in a tab of the terminal UI and not subscribed to a
source is removed after `limits.conversationDays` (7) without a message.

When the daemon restarts, queued tasks run; a task that was running is marked failed
("interrupted by a daemon restart") because its tool calls may already have had effects.

## Answers

When a task ends, pine publishes `agent/<id>/done` or `agent/<id>/failed`. If the task has a
reply target, the final text is also published there, for example on `out/telegram/main` with
the chat id, and the Telegram plugin sends it. An agent that answers exactly `NO_REPLY` sends
nothing, which is how routine checks stay quiet.

## Agents working together

- `delegate` gives another agent a task. That agent runs it in its own workspace with its own
  tools and sees only the task text. By default the caller waits for the answer; with
  `wait: false` the answer arrives later as a message in the caller's session.
- `subagent` runs several copies of the same agent in parallel, each with an empty context, and
  returns their final answers. It keeps large searches out of the caller's context.
- Shared state (`state_get`, `state_set`) holds small facts such as `house/mode` that every agent
  can read and that can be shown to an agent in every turn.
- `publish_event` lets an agent put an event on a topic you allowed, which routes and plugins
  then act on.

Loops are cut: a delegation chain cannot revisit an agent or exceed
`limits.maxDelegationDepth`, and events more than `limits.maxEventHops` steps away from an
outside trigger are not routed.

## Trust

How content entered decides what it can do. See [security.md](security.md) for all of it.

| Content | Arrives as | Runs with |
|---|---|---|
| Your Telegram message, `pine send`, a schedule you wrote | `owner` | The agent's full tool set, in the named session |
| A webhook, an MQTT message, a new file, another bot, handled by a route | `untrusted` | The agent's `untrusted` profile (read-only tools by default), in a separate session |
| An event of a source a conversation is subscribed to | framed as data; taints that conversation unless the source is marked as yours | The conversation's own tool set, but sending information out needs your approval. With `"separate": true` on the subscription: as the row above |
| A web page, or the result of an MCP server marked `taints`, read during your own request | taints the session | Full tool set, but sending information out needs your approval |
