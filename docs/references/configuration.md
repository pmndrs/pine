# Configuration

Everything pine needs is in its home directory: `~/.pine` by default, or `$PINE_HOME`, or
`--home <dir>` on the command line.

```
~/.pine/
  pine.json            global settings, routes, schedules, global MCP servers and event sources
  models.json          optional: your own model servers, in pi's format
  .env                 secrets, referenced from the JSON files as ${NAME}
  auth.json            provider credentials, written by `pine login`
  USER.md              what all agents know about you; in every agent's prompt, kept by the main agent
  agents/
    main/
      agent.json       this agent's settings
      workspace/       its working folder, unless agent.json points elsewhere
        AGENTS.md      its purpose and how it works  ┐ read into its prompt,
        SOUL.md        who it is                     │ written by the agent itself
        MEMORY.md      what should outlive a talk    ┘ (agents.md)
      AGENTS.md        optional: rules of yours the agent cannot change
      skills/          skills only this agent has
      extensions/      pi extensions only this agent loads
      sessions/        conversation history (written by pine)
  skills/              skills for all agents, once pine.json lists the folder
  sandbox/             per-agent private home and generated sandbox profiles (written by pine)
  data/                event log, task queue, media, control token, files of event sources (written by pine)
```

`pine check` validates all of it, prints what each agent ends up with, and lists anything that
weakens the defences. Problems are reported together, each with the file it is in.

Paths in `pine.json` are relative to the home directory; paths in `agent.json` are relative to
that agent's folder. `~` works in both.

## Secrets

Write `${NAME}` or `${NAME:-fallback}` anywhere in a string in `pine.json` or `agent.json`.
Values come from `<home>/.env` first, then from the environment of the daemon. A missing
variable without a fallback is a configuration error.

`.env` is read by pine only. Its values are not exported to the daemon's environment, so
agent shells and MCP servers do not inherit them; they are also removed from events, messages
and log lines if they ever appear there (values of 8 characters or more). Keep the file at
mode 600 (`pine init` sets that).

pine writes to `.env` itself in one case: when an agent sets up an event source that has a
password or secret, the value is stored there as `PINE_SOURCE_<NAME>_<AGENT>_<OPTION>` (without
the agent for a source of all agents), and the configuration holds only the `${...}` reference.
Removing the source removes the entry. See [sources.md](sources.md).

## pine.json

```json
{
  "main": "main",
  "logLevel": "info",
  "defaults": { "model": "local/deepseek-v4.1-flash", "thinking": "off" },
  "limits": { "maxConcurrentRuns": 2 },
  "security": { "approvalTimeout": "5m" },
  "http": { "host": "127.0.0.1", "port": 7463, "hooks": {} },
  "mcp": {},
  "sources": {},
  "sourceTypes": {},
  "subscribe": [],
  "extensions": [],
  "skills": [],
  "routes": [],
  "schedules": []
}
```

| Key | Default | Meaning |
|---|---|---|
| `main` | none | Id of the main agent. It may delegate to every other agent unless its `agent.json` says otherwise, and it is the only one that can create agents and set things up for all agents ([setup.md](setup.md)). Without this key, the agent called `main` (or else the first one) has those setup rights, but nobody delegates by default. |
| `logLevel` | `info` | `debug`, `info`, `warn`, `error`, `silent`. Logs go to stderr; a daemon started inside the terminal UI logs to `data/pine.log`. |
| `dataDir` | `data` | Where the database, media and control token live. |
| `defaults.model` | none | `provider/model-id` from `models.json`, for agents that name none. |
| `defaults.thinking` | `off` | Reasoning level for models that can reason: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `defaults.mode` | `auto` | `manual`, `auto` or `bypass`: how much agents do without asking. See [security.md](security.md). |
| `defaults.bashTimeoutSec` | `300` | Longest a shell command may run. The model cannot raise it. |
| `defaults.taskTimeoutSec` | `1800` | Longest a task may run before it is aborted. |
| `defaults.idleMs` | `15m` | A live session without work is closed after this (and resumed from disk later). |
| `defaults.settings` | `{}` | pi settings applied to every agent, for example `{ "compaction": { "reserveTokens": 8000 } }`. |
| `limits.maxConcurrentRuns` | `2` | Model slots: how many runs talk to the model server at once. Match it to the server's parallel slots. |
| `limits.maxDelegationDepth` | `3` | How deep a chain of delegations may go. |
| `limits.maxDownloadMb` | `200` | Largest file the `download` tool fetches. |
| `limits.maxEventHops` | `8` | Events further than this from an outside trigger are not routed. |
| `limits.maxQueuedPerAgent` | `50` | New tasks are refused when an agent has this many waiting. |
| `limits.maxEventChars` | `20000` | Longest prompt built from an untrusted event. |
| `limits.modelHeadersTimeoutMs` | `10m` | How long the model server may take to start answering. |
| `limits.modelStreamIdleMs` | `5m` | How long a started answer may go silent before the request is dropped. |
| `limits.eventRetentionDays` | `30` | Older events are deleted, and so are the copies kept of conversations that were reset. |
| `limits.conversationDays` | `7` | A conversation in which nothing was said for this long is removed with its history, unless it is an agent's main conversation, pinned, open in a tab, or subscribed to an event source. `0`: never. |
| `security.approvalTimeout` | `5m` | An unanswered approval request counts as "no" after this. |
| `security.taint` | `session` | How long a session stays tainted: until reset (`session`), until the task ends (`run`), or never (`off`). See [security.md](security.md). |
| `security.taintTools` | `[]` | Tool name globs whose results count as outside content, besides MCP servers marked `taints`. |
| `security.bypassWhenTainted` | `false` | Keep bypass mode in force in a session that has read outside content. Off, such a session asks again. |
| `http` | on, loopback, port 7463 | Control API and webhooks. `false` turns it off (the CLI's client commands then do not work). |
| `http.token` | generated | Bearer token of the control API. When unset, pine generates one into `data/http-token`. |
| `http.hooks.<name>` | none | A webhook at `POST /hook/<name>`: `{ "secret": "...", "topic": "hook/<name>" }`. See [events.md](events.md). For a webhook an agent subscribes to, use a `webhook` source instead. |
| `mcp` | `{}` | Global MCP servers. See [mcp.md](mcp.md). |
| `sources` | `{}` | Event sources every agent can subscribe to. See [sources.md](sources.md). |
| `sourceTypes` | `{}` | Source types of your own: a name and the module that implements it, e.g. `{ "doorbell": "./sources/doorbell.ts" }`. The module says which options it takes, and agents can then set up sources of that type by tool call. The main agent adds entries here with `add_source_type`, pointing at the copy pine keeps in `sources/` of its home. |
| `subscribe` | `[]` | Subscriptions for all agents: every agent that can use the source is woken in its main conversation. |
| `extensions` | `[]` | Paths of pi extensions loaded into every agent's sessions. |
| `skills` | `[]` | Further folders of skills for every agent, for skills that lie outside pine's home. Not needed for `skills/` in pine's home: what is there is for every agent without an entry, and so is what the main agent adds with `add_skill`. Agents cannot replace or remove a skill that is named here. |
| `routes` | `[]` | See [events.md](events.md). |
| `schedules` | `[]` | What happens at a time. One with a `task` wakes every agent with it; one without only publishes an event. The main agent adds entries with `add_schedule`. See [events.md](events.md). |

Durations are a number of milliseconds or a string such as `"90s"`, `"15m"`, `"2h"`, `"1d"`.

## agent.json

Every key is optional; `{}` is a valid agent.

```json
{
  "description": "Contract law; knows the case files",
  "workspace": "~/dev/gonzo",
  "model": "local/deepseek-v4.1-flash",
  "tools": ["read", "bash", "edit", "write", "grep", "find", "ls"],
  "mcp": { "library": { "command": "library-mcp" } },
  "globalMcp": ["web"],
  "delegates": [],
  "subagents": { "maxParallel": 3 },
  "sandbox": { "network": false, "read": ["~/Documents/law-library"] }
}
```

### Identity and model

| Key | Default | Meaning |
|---|---|---|
| `description` | empty | One line other agents see when they choose whom to delegate to. Write it for them. |
| `workspace` | `agents/<id>/workspace` | The agent's working folder. `AGENTS.md`, `SOUL.md` and `MEMORY.md` at its top are the agent's instructions and are loaded into its prompt. Must exist when you set it. |
| `context` | `[]` | Further instruction files to load into the system prompt. |
| `model`, `thinking` | from `defaults` | Per-agent model and thinking level. |
| `settings` | from `defaults.settings` | pi settings for this agent. `agents/<id>/settings.json` is honoured as well. |
| `taskTimeoutSec`, `idleMs` | from `defaults` | Per-agent overrides. |

### Tools and extensions

| Key | Default | Meaning |
|---|---|---|
| `tools` | `read`, `bash`, `edit`, `write` | Which of pi's built-in tools the agent gets: any of `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. |
| `mcp` | `{}` | MCP servers only this agent has. An entry with the name of a global server replaces it for this agent. An entry with `"session": "<conversation>"` was added for that conversation alone and is removed with it ([setup.md](setup.md)). |
| `globalMcp` | `true` | `true`: every global server that includes this agent. `false`: none. A list of names: exactly those. |
| `sources` | `{}` | Event sources only this agent can subscribe to. An entry with `"session": "<conversation>"` was set up for that conversation alone and is removed with it. See [sources.md](sources.md). |
| `subscribe` | `[]` | What this agent is subscribed to: a list of names, an object with `note`, `when`, `throttle`, `debounce` per source, or a list of entries with `source` and, for one conversation only, `session`. The agent's `subscribe` tool and `pine subscribe` write here. |
| `schedules` | `[]` | What this agent does at set times: `{ "name", "cron" or "every" or "at", "task" }`, with `"session": "<conversation>"` for one conversation. The agent adds entries with `add_schedule`. See [events.md](events.md). |
| `extensions`, `skills` | `[]` | Further pi extension files and skill folders for this agent. Its own `skills/` folder needs no entry. |
| `bashTimeoutSec` | from `defaults` | Longest shell command. |
| `bashDeny` | `[]` | Regular expressions; a shell command matching one is refused. A convenience, not a boundary: the sandbox is the boundary. |

### Working with other agents

| Key | Default | Meaning |
|---|---|---|
| `delegates` | `["*"]` for the main agent, else `[]` | Agents this one may hand tasks to. |
| `subagents` | on, 4 in parallel | `false`, or `{ "maxParallel": 4, "tools": [...], "mcp": true }`. `tools` narrows what sub-agents get. |
| `publish` | `[]` | Topic patterns the `publish_event` tool may publish on. Empty: the agent has no such tool. |
| `state.read` | `["#"]` | State keys the agent may read. |
| `state.write` | `["agent/<id>/#"]` | State keys the agent may write. |
| `state.inject` | `[]` | State keys shown to the agent in every turn. |

### Containment

| Key | Default | Meaning |
|---|---|---|
| `mode` | from `defaults` | `manual`: every action waits for approval. `auto`: works inside the sandbox and asks for the rest. `bypass`: never asks, and reaches your whole account. |
| `sandbox` | on | `false` runs shell and file tools with the daemon's full rights. Do not, unless the machine itself is disposable. |
| `sandbox.network` | `false` | Shell commands may use the network. |
| `sandbox.read`, `sandbox.write` | `[]` | Further folders the agent may read / write, besides its workspace. |
| `sandbox.sharedTmp` | `true` | Allow `/tmp` and the user's temp folder. |
| `sandbox.env` | `{}` | Extra environment variables for the agent's shell. Do not put secrets here; the agent can read them. |
| `trustWorkspace` | `false` | `true` lets pi load `.pi/extensions`, `.pi/settings.json` and skills from the workspace. That is code execution inside the daemon for whoever can write there, the agent included. |
| `approve` | `[]` | Tool calls that always need your approval: `"tool"` or `"tool:argument-glob"`, for example `"bash:*git push*"`. |
| `approveWhenTainted` | `["publish_event", "send"]` | Tool calls that need approval once the session has seen outside content. |
| `untrusted` | read-only profile | What a run started by an untrusted event may use: `{ "tools": ["read","grep","find","ls"], "mcp": [], "delegates": [], "publish": [], "stateWrite": false, "subagents": false }`. `false` refuses such runs. |

## models.json

This is pi's own file; pine passes it through. It is only needed for model servers of your own:
pi already knows the hosted providers (OpenCode, Anthropic, OpenAI and many more), and
`pine login <provider>` supplies their credentials. The entry `pine init` writes for llama.cpp:

```json
{
  "providers": {
    "local": {
      "name": "llama-server",
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "none",
      "models": [
        {
          "id": "deepseek-v4.1-flash",
          "contextWindow": 65536,
          "maxTokens": 8192,
          "input": ["text"],
          "reasoning": true,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "compat": { "supportsStore": false, "supportsDeveloperRole": false, "maxTokensField": "max_tokens", "thinkingFormat": "deepseek" }
        }
      ]
    }
  }
}
```

- Refer to a model as `provider/id`, here `local/deepseek-v4.1-flash`.
- `contextWindow` must match what the server was started with (`-c`), or compaction triggers at
  the wrong time.
- Add `"image"` to `input` only for a model that accepts images; agents then receive the
  pictures that Telegram and watched folders deliver.
- The `compat` flags stop pi from sending fields a plain llama-server may reject. They have not
  been verified against a real llama-server yet; see [stack.md](stack.md).
- pi's documentation for this file is in
  `node_modules/@earendil-works/pi-coding-agent/docs/models-configuration.md`.
