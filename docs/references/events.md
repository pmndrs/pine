# Events, routes and schedules

> To let an agent react to a folder, a device or a web request, you usually do not need this
> page: ask it, or configure a [source](sources.md) and have the agent subscribe. To have it do
> something at a time, ask it too: see "Schedules" below. Routes are for rules of your own:
> setting state, chaining events, single model calls.

## Topics

A topic is a slash-separated name. Patterns use `+` for exactly one level and `#` for the rest:

| Pattern | Matches |
|---|---|
| `cam/front/motion` | only that topic |
| `cam/+/motion` | `cam/front/motion`, `cam/back/motion` |
| `source/#` | everything below `source`, and `source` itself |
| `#` | everything |

Where events come from:

| Source | Topics | Trust |
|---|---|---|
| Webhook `POST /hook/<name>` | `hook/<name>` (or the hook's `topic`) | untrusted |
| Event sources ([sources.md](sources.md)) | `source/<name>/<event>`, or `source/<name>@<agent>/<event>` for an agent's own | untrusted; owner for a source whose entry says `"trust": "owner"` (`add_source` writes that for `telegram`, whose account you pair) |
| `pine emit`, `POST /events` | whatever you name | owner |
| Schedules | `timer/<name>`, or `timer/<name>@<agent>` for an agent's own | owner |
| Agents (`publish_event`) | topics in the agent's `publish` list | owner, or untrusted if the run was restricted |
| pine | `agent/...`, `state/...`, `approval/...`, `pine/...` | untrusted |

Watch them:

```bash
pine events -f
```

```bash
pine events --topic "source/#" --limit 50
```

## Routes

A route is an entry in `routes` in `pine.json`.

```json
{
  "name": "front-door",
  "on": "source/house/message",
  "when": { "payload.topic": "house/door/front", "payload.value.open": true, "state.house/mode": "away" },
  "throttleMs": "5m",
  "agent": "house",
  "prompt": "The front door was opened at {{time}} while the house is in away mode.",
  "session": "new",
  "reply": { "topic": "out/source/telegram" }
}
```

Here `house` is an `mqtt` source and `telegram` a `telegram` source, both in `pine.json`
([sources.md](sources.md)). For a source an agent set up for itself the topic carries the
agent's name: `out/source/telegram@main`.
A route does not subscribe to anything, so a source it relies on needs `"start": "always"`
unless a conversation is subscribed to it anyway.

| Key | Meaning |
|---|---|
| `name` | For logs and errors. Default `route<n>`. |
| `on` | A topic pattern or a list of them. |
| `when` | A filter; every entry must hold. See below. |
| `debounceMs` | Wait until no matching event has arrived for this long, then handle the last one. For bursts (a camera uploading five images). |
| `throttleMs` | Handle one event, then ignore matching ones for this long. For repeating alarms. |
| `key` | Template for what counts as "the same" for debounce and throttle. Default `{{topic}}`. |
| `set` | Write shared state: `{ "house/mode": "{{payload.value}}" }`. `null`, or a value that is exactly one `{{path}}` that finds nothing, deletes the key. |
| `publish` | Publish another event: `{ "topic": "...", "payload": {...} }`. Without `payload` the original payload is passed on; after a `call` it is `{ "text": <the answer>, "of": <the original payload> }`. |
| `call` | One model call: `{ "prompt": "...", "system": "...", "model": "provider/id" }`. Its answer is `{{result}}`. |
| `agent` | Give an agent a task. |
| `prompt` | The task text. Default: the payload's `text`, or the payload as JSON. |
| `session` | Session key template. Default `main`. `new` for one-off work. |
| `whenBusy` | `queue` (default): the task waits until the conversation is free. `steer`: if the conversation is working, the text is given to that work, which reads it at its next step; if that work ends first, it is done next as a task of its own. See "Sessions" in [agents.md](agents.md). |
| `priority` | Higher runs first when model slots are scarce. Default 10 for owner events, 0 otherwise. |
| `reply` | Where the agent's answer goes: `{ "topic": "...", "payload": {...} }`. Default: the event's own reply target. `false`: nowhere. |
| `trust` | Override the event's trust. `"owner"` gives events on this route the agent's full tool set: only for sources nobody else can write to. `pine check` lists such routes. |

A route needs at least one of `set`, `publish`, `call`, `agent`. They run in the order `set`,
`call`, `publish`, `agent`, so one route can classify with `call` and pass the result on with
`publish`. `call` and `agent` cannot be in the same route: publish the result and let a second
route start the agent, as in the example below.

### Templates

`{{path}}` is replaced in `prompt`, `session`, `key`, `set`, `publish`, `reply` and `call`.

| Path | Value |
|---|---|
| `payload`, `payload.a.b` | The event's payload or a field of it |
| `topic`, `source`, `id`, `ts`, `time` | Event fields; `time` is local, `YYYY-MM-DD HH:MM:SS` |
| `state.<key>` | Shared state, for example `{{state.house/mode}}` |
| `result` | The answer of the route's `call` |

A value that is exactly one `{{path}}` keeps its type (a number stays a number); inside longer
text, objects become JSON and missing values become empty.

### Filters

`when` maps a path to a value (equality) or to conditions:

```json
{
  "payload.value.temperature": { "gt": 30 },
  "payload.value.room": { "in": ["kitchen", "boiler"] },
  "payload.text": { "regex": "^alarm", "flags": "i" },
  "state.house/mode": { "ne": "home" },
  "payload.value.battery": { "exists": true }
}
```

Conditions: `eq`, `ne`, `in`, `gt`, `gte`, `lt`, `lte`, `exists`, `contains`, `regex` (with
optional `flags`).

### The cheapest handler that is enough

A full agent turn costs seconds of model time. Most events do not need one.

```json
[
  { "on": "source/house/message", "when": { "payload.topic": "house/mode" }, "set": { "house/mode": "{{payload.value}}" } },

  { "on": "source/cam/added",
    "debounceMs": "4s",
    "call": { "system": "You look at one camera image. Answer in one line: PERSON, VEHICLE, ANIMAL or NOTHING, then a short description.",
              "prompt": "Camera file {{payload.file}}" },
    "publish": { "topic": "cam/classified", "payload": { "file": "{{payload.file}}", "verdict": "{{result}}" } } },

  { "on": "cam/classified",
    "when": { "payload.verdict": { "regex": "^(PERSON|VEHICLE)" }, "state.house/mode": "away" },
    "agent": "house", "session": "new",
    "prompt": "Camera saw: {{payload.verdict}} ({{payload.file}}). The house is in away mode.",
    "reply": { "topic": "out/source/telegram" } }
]
```

The first route never calls the model. The second makes one call per burst of images (a `call`
receives the event's images if the model accepts them). Only a person or a vehicle while nobody
is home reaches an agent.

Text from untrusted events is prefixed for the agent with a line saying where it came from and
that it is data, and is cut at `limits.maxEventChars`. That line is a courtesy; the protection
is that the run has fewer tools (see [security.md](security.md)).

## Schedules

A schedule is something that happens because of the time: again and again, or once. It is the
fourth thing an agent can be given by asking, next to event sources, MCP servers and skills,
and it has the same three scopes ([setup.md](setup.md)).

### Ask the agent

> Every weekday at seven, check my mail and tell me on Telegram what matters.

> Remind me at five to call the dentist.

> In twenty minutes, look whether the build is through.

The agent calls its `add_schedule` tool with a name, the time and the task in its own words:
`cron` for set times ("every weekday at six in the evening" is `"0 18 * * 1-5"`), `every` for an
interval, `at` or `in` for a reminder that happens once. When it is time, it is woken with that
task, also when you are not there, and does it. What it starts
counts as your wish: the agent has its usual tools, and nothing is marked as outside content.

| Said | Who is woken | You are asked |
|---|---|---|
| in a side conversation | That conversation; the schedule goes when the conversation is removed | No |
| in the agent's main conversation, or "as an agent" | The agent's main conversation | Only from a side conversation |
| "all agents" | Every agent, each in its main conversation. Only the main agent can do this | Yes |

In a conversation that has read outside content you are asked in every case, and the dialog
shows the task: what a web page says must not become something that is done every hour.

| Tool | |
|---|---|
| `schedules` | What is scheduled for this agent, in which conversation, and when each is next due. |
| `add_schedule` `name` `task` + one of `cron`, `every`, `at`, `in` [`scope`] | Schedules it. `cron`: set times; `every`: an interval, at least a minute; `at`: once, at a local time (`2026-12-24 17:00`); `in`: once, after this long (`20m`). |
| `remove_schedule` `name` | Ends one. This conversation's own goes without a question. |

A schedule that happens once removes itself when it has fired. A one-off, or a `cron` schedule
with a task, that was due while pine was not running is done once when pine starts again (a
`cron` time only if it lies no more than seven days back), and the agent is told that it comes
late. An `every` schedule simply starts counting again. `pine
schedules` lists everything that is scheduled.

A name is unique among all schedules; a task has at most 4000 characters; an interval an agent
sets is at least a minute; a time in the past is refused. In manual mode you are asked for
every `add_schedule` and `remove_schedule`.

### In the files

```json
"schedules": [
  { "name": "brief", "cron": "30 7 * * 1-5", "task": "Prepare the morning brief and send it to me on Telegram." },
  { "name": "dentist", "at": "2026-11-12T17:00", "task": "Remind me to call the dentist." },
  { "name": "printer-check", "every": "10m" }
]
```

In an `agent.json` this is that agent's schedule (add `"session": "<conversation>"` for one
conversation, otherwise its main one). In `pine.json` a schedule with a task wakes every
agent; one without a task only publishes an event.

| Key | Meaning |
|---|---|
| `name` | Required. Starts with a lowercase letter, then lowercase letters, digits, `-` and `_`; 40 characters at most. The event is published on `timer/<name>` (`timer/<name>@<agent>` for an agent's own) unless `topic` says otherwise. |
| `cron` | Five fields, local time: minute, hour, day of month, month, day of week (0 or 7 is Sunday). Lists, ranges and steps work: `*/15 8-18 * * 1-5`. |
| `every` | A fixed interval instead. |
| `at` | Once, at this local time. The entry is removed when it has fired. If pine was not running at that time, it fires when pine starts again, and the agent is told that it comes late. |
| `task` | What the agent is to do. Required in an `agent.json`. |
| `topic` | The topic the event is published on, instead of `timer/<name>`. |
| `session` | In an `agent.json`: the conversation that is woken. Default: the main one. |
| `payload` | Fields added to the event's payload (`name` and `scheduled` are always there; `late` when it comes late, `task` when it has one). |
| `catchUp` | For `cron`: fire once at startup if a time passed while the daemon was down (in the last seven days), marked as late. Default: `true` with a task, `false` without. (`at` always catches up; `every` never does.) |

### Schedules and routes

Every schedule also publishes an event, trusted as yours, so a route can act on it. For a
schedule without a task that is all it does:

```json
{ "on": "timer/printer-check", "call": { "prompt": "..." } }
```

A route is the way to do something other than an agent's turn at a time: set state, publish,
or one model call without tools. For "wake the agent and let it do this", give the schedule a
task instead; no route is needed.

## Webhooks

```json
"http": { "hooks": { "doorbell": { "secret": "${DOORBELL_SECRET}" } } }
```

`POST http://127.0.0.1:7463/hook/doorbell` then publishes `hook/doorbell` with the request body
as payload (parsed JSON, or `{ "text": ... }`). The caller proves itself with either

- `Authorization: Bearer <secret>`, or
- an HMAC-SHA256 of the body with the secret, hex-encoded, in `X-Hub-Signature-256: sha256=<hex>`
  (the GitHub convention) or `X-Signature`.

A hook needs a secret; `"open": true` instead of a secret accepts anyone who can reach the port
and is reported by `pine check`. Unknown hook names get 404. Each hook accepts at most 120
requests a minute and bodies up to 1 MB. Webhook events are untrusted even when the signature
is right: the signature says who sent it, not that its content is safe to obey.

To receive webhooks from outside your network, put a tunnel or reverse proxy in front and
forward only `/hook/`.

A hook here only publishes an event; a route decides what happens. For a webhook that wakes an
agent directly, use a source of type `webhook` ([sources.md](sources.md)): it answers under
`/hook/` too, while an agent is subscribed. A hook in `http.hooks` with the same name comes
first.

## When nothing happens

1. `pine events --topic "<pattern>"`: did the event arrive, and on which topic?
2. `pine tasks`: was a task created? `pine task <id>` shows its prompt, result and error.
3. `pine events --topic "pine/#"`: `pine/route-failed` carries the reason a route could not act,
   for example an agent that refuses untrusted events or a full queue.
4. Daemon log (stderr): a line `dropped ... after N hops` means a loop was cut.
5. A filter that never matches is usually a wrong path: look at the real payload in step 1.
