# Events, routes and schedules

> To let an agent react to a folder, a device, a web request or a clock, you usually do not
> need this page: configure a [source](sources.md) and have the agent subscribe. Routes are for
> rules of your own: setting state, chaining events, single model calls.

## Topics

A topic is a slash-separated name. Patterns use `+` for exactly one level and `#` for the rest:

| Pattern | Matches |
|---|---|
| `cam/front/motion` | only that topic |
| `cam/+/motion` | `cam/front/motion`, `cam/back/motion` |
| `mqtt/#` | everything below `mqtt`, and `mqtt` itself |
| `#` | everything |

Where events come from:

| Source | Topics | Trust |
|---|---|---|
| Telegram plugin | `telegram/<account>/message` | owner (only allow-listed users are heard at all) |
| MQTT plugin | `mqtt/<mqtt topic>` | untrusted |
| watch plugin | `file/<name>/added` | untrusted |
| Webhook `POST /hook/<name>` | `hook/<name>` (or the hook's `topic`) | untrusted |
| Event sources ([sources.md](sources.md)) | `source/<name>/<event>`, or `source/<name>@<agent>/<event>` for an agent's own | untrusted; owner for a `timer` and for a source marked `"trust": "owner"` |
| `pine emit`, `POST /events` | whatever you name | owner |
| Schedules | `timer/<name>` | owner |
| Agents (`publish_event`) | topics in the agent's `publish` list | owner, or untrusted if the run was restricted |
| pine | `agent/...`, `state/...`, `approval/...`, `pine/...` | untrusted |

Watch them:

```bash
bin/pine events -f
```

```bash
bin/pine events --topic "mqtt/#" --limit 50
```

## Routes

A route is an entry in `routes` in `pine.json`.

```json
{
  "name": "front-door",
  "on": "mqtt/house/door/front",
  "when": { "payload.value.open": true, "state.house/mode": "away" },
  "throttleMs": "5m",
  "agent": "house",
  "prompt": "The front door was opened at {{time}} while the house is in away mode.",
  "session": "new",
  "reply": { "topic": "out/telegram/main" }
}
```

| Key | Meaning |
|---|---|
| `name` | For logs and errors. Default `route<n>`. |
| `on` | A topic pattern or a list of them. |
| `when` | A filter; every entry must hold. See below. |
| `debounceMs` | Wait until no matching event has arrived for this long, then handle the last one. For bursts (a camera uploading five images). |
| `throttleMs` | Handle one event, then ignore matching ones for this long. For repeating alarms. |
| `key` | Template for what counts as "the same" for debounce and throttle. Default `{{topic}}`. |
| `set` | Write shared state: `{ "house/mode": "{{payload.value}}" }`. An empty value deletes the key. |
| `publish` | Publish another event: `{ "topic": "...", "payload": {...} }`. Without `payload` the original payload is passed on; after a `call` it is `{ "text": <the answer>, "of": <the original payload> }`. |
| `call` | One model call: `{ "prompt": "...", "system": "...", "model": "provider/id" }`. Its answer is `{{result}}`. |
| `agent` | Give an agent a task. |
| `prompt` | The task text. Default: the payload's `text`, or the payload as JSON. |
| `session` | Session key template. Default `main`. `new` for one-off work. |
| `whenBusy` | `queue` (default) or `steer`. |
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
  { "on": "mqtt/house/mode", "set": { "house/mode": "{{payload.value}}" } },

  { "on": "file/cam/added",
    "debounceMs": "4s",
    "call": { "system": "You look at one camera image. Answer in one line: PERSON, VEHICLE, ANIMAL or NOTHING, then a short description.",
              "prompt": "Camera file {{payload.file}}" },
    "publish": { "topic": "cam/classified", "payload": { "file": "{{payload.file}}", "verdict": "{{result}}" } } },

  { "on": "cam/classified",
    "when": { "payload.verdict": { "regex": "^(PERSON|VEHICLE)" }, "state.house/mode": "away" },
    "agent": "house", "session": "new",
    "prompt": "Camera saw: {{payload.verdict}} ({{payload.file}}). The house is in away mode.",
    "reply": { "topic": "out/telegram/main" } }
]
```

The first route never calls the model. The second makes one call per burst of images (a `call`
receives the event's images if the model accepts them). Only a person or a vehicle while nobody
is home reaches an agent.

Text from untrusted events is prefixed for the agent with a line saying where it came from and
that it is data, and is cut at `limits.maxEventChars`. That line is a courtesy; the protection
is that the run has fewer tools (see [security.md](security.md)).

## Schedules

```json
"schedules": [
  { "name": "morning", "cron": "30 7 * * 1-5", "payload": { "what": "morning brief" } },
  { "name": "printer-check", "every": "10m" },
  { "name": "backup-report", "cron": "0 9 * * *", "catchUp": true }
]
```

| Key | Meaning |
|---|---|
| `name` | Required. The event is published on `timer/<name>` unless `topic` says otherwise. |
| `cron` | Five fields, local time: minute, hour, day of month, month, day of week (0 or 7 is Sunday). Lists, ranges and steps work: `*/15 8-18 * * 1-5`. |
| `every` | A fixed interval instead of `cron`. |
| `payload` | Fields added to the event's payload (`name`, `scheduled` are always there). |
| `catchUp` | Fire once at startup if a cron time passed while the daemon was down. |

A schedule only publishes an event. Pair it with a route:

```json
{ "on": "timer/morning", "agent": "main", "session": "new",
  "prompt": "Prepare the morning brief: calendar, open tasks, anything the house agent recorded overnight. Reply NO_REPLY if there is nothing worth reading.",
  "reply": { "topic": "out/telegram/main" } }
```

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
