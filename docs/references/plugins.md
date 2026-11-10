# Plugins, extensions and skills

Three ways to extend what agents can do, from pine-specific to pi-native:

| | What it is | Use it for |
|---|---|---|
| **Plugin** | A module that gets pine's API | Bringing events in (adapters), sending things out, giving agents tools that need the daemon |
| **pi extension** | pi's own plug-in format, runs inside each session | Changing how a session behaves: hooks on turns and tool calls, extra tools, custom compaction |
| **Skill** | A folder with a `SKILL.md` | Knowledge and procedures an agent reads when it needs them |

Each can be global or belong to one agent:

| | Global | One agent |
|---|---|---|
| Plugin | `plugins` in `pine.json` | `plugins` in `agent.json` |
| pi extension | `extensions` in `pine.json` | `agents/<id>/extensions/*.ts`, or `extensions` in `agent.json` |
| Skill | folders listed in `skills` in `pine.json` | `agents/<id>/skills/<name>/SKILL.md`, or `skills` in `agent.json` |

`"globalPlugins": false` in an `agent.json` keeps the tools and session extensions of global
plugins away from that agent.

Plugins and extensions are code that runs inside the daemon with all its rights. They are
loaded only from pine's home, which agents cannot write to. Never load one from a workspace.

> For events from outside (folders, MQTT, webhooks, FTP uploads, timers) see
> [sources.md](sources.md): sources are configured by name, start when an agent subscribes, and
> need no route. The plugins here are for what goes both ways or adds tools.

## Built-in plugins

### Telegram

```json
{ "use": "pine:telegram", "options": {
    "accounts": {
      "main":  { "token": "${TELEGRAM_MAIN_TOKEN}",  "allow": [123456789], "agent": "main" },
      "house": { "token": "${TELEGRAM_HOUSE_TOKEN}", "allow": [123456789], "agent": "house", "whenBusy": "steer" }
    }
} }
```

| Option | Meaning |
|---|---|
| `token` | The bot token from BotFather. Keep it in `.env`. |
| `allow` | Telegram user ids that may talk to the bot. Required; the first one is the owner, who receives approval requests and `telegram_send` messages. Everyone else is ignored without an answer. |
| `chats` | Group chat ids where allow-listed users may talk to the bot. |
| `agent` | Send messages straight to this agent, one session per chat (`tg-<chat id>`). Without it, write a route for `telegram/<account>/message`. Like every named conversation, a chat's is removed after `limits.conversationDays` without a message unless it is pinned ([agents.md](agents.md)). |
| `whenBusy` | `queue` (default) or `steer`: show a new message to the agent while it is still working on the previous one. |
| `approvals` | Whether approval requests are asked through this bot. Default: the first account. |

What it does:

- **In:** `telegram/<account>/message` with `{ chatId, userId, username, name, text, messageId, images? }`.
  Photos are saved under `data/media/telegram/` and passed to models that accept images.
- **Out:** an event on `out/telegram/<account>` with `{ text, chatId? }` is sent as a message.
  Without `chatId` it goes to the owner. Chats that are not on `allow` or `chats` are refused,
  whatever asks.
- **In the chat:** `/reset` (or `/new`) starts a fresh conversation, `/stop` aborts the running
  task, `/allow` and `/deny` answer the open approval request (the buttons under the request do
  the same, and offer "Always: ..." where that is possible).
- **Tool for agents:** `telegram_send(text)` messages the owner without having been asked
  (several accounts: `telegram_send_<account>`).
- While an agent works on a message, the chat shows "typing".

Find your user id by messaging the bot and looking at the daemon log at `logLevel: "debug"`:
`ignored message from user <id>`.

### MQTT

```json
{ "use": "pine:mqtt", "options": {
    "url": "mqtt://192.168.1.10:1883", "username": "pine", "password": "${MQTT_PASSWORD}",
    "subscribe": [
      { "topic": "house/#" },
      { "topic": "bambu/+/report", "minIntervalMs": 30000, "persist": false }
    ],
    "publish": ["house/+/set", "zigbee2mqtt/+/set"]
} }
```

| Option | Meaning |
|---|---|
| `subscribe[].topic` | MQTT topic filter. |
| `subscribe[].as` | Bus topic template. Default `mqtt/{{topic}}`. |
| `subscribe[].minIntervalMs` | Drop messages on the same topic that follow sooner than this. For chatty telemetry. |
| `subscribe[].persist` | `false` keeps the events out of the log. |
| `subscribe[].trust` | `"owner"` only for a broker that nobody and nothing else can publish to. |
| `publish` | MQTT topics that may be published to. Empty: nothing can be sent. |

- **In:** `mqtt/<topic>` with `{ topic, value }`; `value` is parsed JSON when the message is
  JSON, otherwise text.
- **Out:** an event on `out/mqtt` with `{ topic, message, retain?, qos? }`.
- **Tool for agents:** `mqtt_publish(topic, message)`, limited to the `publish` list. Needs
  approval once the session has seen outside content.

### watch

```json
{ "use": "pine:watch", "options": {
    "watches": [ { "name": "cam", "dir": "~/Cameras/incoming", "pattern": "\\.(jpg|mp4)$", "settleMs": 1500 } ]
} }
```

Publishes `file/<name>/added` with `{ path, file, size, images? }` once a new file has stopped
growing. Image files are attached, so a route's `call` or agent can look at them. Point a
camera's FTP upload, a scanner or a download folder at the directory. It is for routes; for an
agent that is to be woken by new files, use a `folder` source ([sources.md](sources.md)).

## Writing a plugin

A plugin is a `.ts` or `.js` file whose default export receives pine's API:

```ts
// ~/.pine/plugins/printer.ts
import type { PineApi } from "/path/to/pine/src/plugins.ts";

export default function printer(pine: PineApi) {
	// 1. Bring something in.
	const timer = setInterval(async () => {
		const res = await fetch(`http://${pine.options.host}/status`).catch(() => undefined);
		if (res?.ok) pine.bus.publish("printer/status", await res.json(), { persist: false });
	}, 30_000);
	pine.onStop(() => clearInterval(timer));

	// 2. React to events without a model.
	pine.bus.subscribe("printer/status", (e) => {
		const s = e.payload as any;
		if (s.state === "FINISH" && pine.state.get("printer/state") !== "FINISH") {
			pine.bus.publish("out/telegram/main", { text: `Print finished: ${s.file}` });
		}
		pine.state.set("printer/state", s.state, { source: "printer" });
	});

	// 3. Give agents a tool.
	pine.tool({
		name: "printer_pause",
		description: "Pause the 3D printer.",
		parameters: { type: "object", properties: {} },
		execute: async () => {
			await fetch(`http://${pine.options.host}/pause`, { method: "POST" });
			return "paused";
		},
	});
}
```

```json
"plugins": [{ "use": "./plugins/printer.ts", "options": { "host": "192.168.1.50" } }]
```

The API:

| Member | Purpose |
|---|---|
| `name` | The name the plugin was loaded as: the built-in's name, or the file name without its extension |
| `options` | The `options` object from the configuration |
| `agent` | Set when the plugin was listed in an `agent.json`: its tools and extensions then reach only that agent |
| `log` | `debug`, `info`, `warn`, `error` |
| `bus.publish(topic, payload, opts)` | Publish. `opts`: `trust` (`"untrusted"` unless you authenticated the owner), `persist`, `reply`, `cause` |
| `bus.subscribe(pattern, handler)` | React to events. A handler that throws is logged and does not affect others |
| `state.get / set / list` | Shared state |
| `kv.get / set` | Private storage of the plugin (cursors, last-seen ids) |
| `agents.submit / run / wait / cancel / reset / list / running` | Give agents tasks directly |
| `complete({ prompt, system, model, images })` | One model call without tools |
| `tool({ name, description, parameters, execute, taints })` | A tool for the agents in scope. The name is lowercase letters, digits and `_`. `execute(params, ctx)` returns the text the model sees. `taints: true` if the result is outside content |
| `extend((pi, agent) => ...)` | Add a pi extension to the sessions of the agents in scope |
| `approvals.pending() / decide(id, allow, by, always?)` | Build another way to answer approval requests |
| `media(dir)` | Declare a folder whose images events may refer to by path |
| `secret(value)` | Keep a value out of events, messages and logs |
| `onStop(fn)` | Clean up when the daemon stops |
| `home`, `dataDir` | Paths |

Rules of thumb:

- Publish what happened, not what should be done. Let routes decide.
- Say `trust: "owner"` only for input you authenticated as the owner's. A sensor reading, a
  mail, a chat message from someone else is `untrusted`.
- An adapter that sends things out checks its own allow-list. An agent's `publish` list says
  which topics it may use; your plugin decides which recipients are acceptable.
- A tool whose result comes from outside (mail bodies, web pages, tickets) sets `taints: true`.

## pi extensions

Any pi extension works in pine sessions. One that adds a line to every system prompt:

```ts
// ~/.pine/agents/gonzo/extensions/citations.ts
export default function (pi) {
	pi.on("before_agent_start", async (event) => ({ systemPrompt: `${event.systemPrompt}\n\nCite the paragraph for every legal claim.` }));
}
```

Files in `agents/<id>/extensions/` are found automatically; list others under `extensions`.
pi's extension guide is in `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`.
Things that need a terminal UI (dialogs, widgets) have no effect in the daemon.

`.pi/extensions/` in a workspace is deliberately not loaded; see `trustWorkspace` in
[configuration.md](configuration.md).

## Skills

A skill is a folder with a `SKILL.md` that starts with a name and a description:

```markdown
---
name: inverter
description: Read and interpret the inverter's daily export. Use for questions about solar yield.
---

1. The exports are in `data/inverter/YYYY-MM.csv` ...
```

The agent sees the description in its system prompt and reads the file when the task calls for
it. Put skills for one agent in `agents/<id>/skills/`, skills for all in a folder listed under
`skills` in `pine.json`.
