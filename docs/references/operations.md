# Running pine

## Requirements

- macOS, or Linux with [bubblewrap](https://github.com/containers/bubblewrap) installed
  (`apt install bubblewrap`). The agent sandbox is built on `sandbox-exec` and on `bwrap`;
  without one of them pine starts, but withholds the shell tool, and `pine check` says why.
  See [security.md](security.md), "On Linux".
- Optional: `ffmpeg` for videos in the terminal UI (on Linux also for pictures other than
  png); on Linux `xclip` or `wl-copy` for copying a selection.
- Node 24 or newer. From a checkout Node runs the TypeScript sources directly; the npm package
  holds them compiled.
- A model that supports tool calls: a hosted provider pi knows (sign in with `pine login`), or
  your own model server with an OpenAI-compatible chat completions endpoint.

## Install

```bash
npm install -g @pmndrs/pine
```

That puts the `pine` command on your PATH. The package holds pine compiled to JavaScript,
because Node does not run TypeScript from inside `node_modules`.

To work on pine itself, use a checkout instead. `bin/pine` runs the sources as they are and
installs the dependencies the first time; `npm link` puts that copy on your PATH:

```bash
git clone https://github.com/pmndrs/pine ~/dev/pine
```

```bash
~/dev/pine/bin/pine init
```

## First start

```bash
pine init
```

sets everything up in one step:

- From a fresh checkout, `bin/pine` first installs pine's dependencies (`npm install`), once.
- It copies the example home to `~/.pine`: one agent, `main`, with web search and the browser, a
  `models.json`, an empty `.env`. Nothing is overwritten if you run it again.
- It downloads the Chromium build the bundled browser tools drive (about 600 MB, into
  Playwright's cache). A second run finds it there and takes a moment. If the download fails,
  everything else is set up and `pine init` can simply be run again.

```bash
pine
```

opens the terminal UI ([tui.md](tui.md)) and, since no daemon is running yet, starts one inside
it. That is the quickest way to try things. For a daemon that keeps running without a terminal:

```bash
pine check
```

```bash
pine start
```

and from another terminal `pine` (attaches to it) or
`pine send main "Say hello and list your tools."`.

### Choosing a model

The example home uses `dev/claude-haiku`: an OpenAI-compatible endpoint whose answers come from
`claude -p`, so it needs Claude Code installed and signed in. The UI starts it on demand; for
`pine start`, run it yourself:

```bash
pine dev-model
```

Every model call starts a `claude` process: expect about five seconds per call and usage on
your Claude plan. It is for trying things out, not for a daemon that runs all day.

For a hosted provider, sign in once and pick a model:

```bash
pine login opencode-go
```

```bash
pine login anthropic
```

```bash
pine login openai-codex
```

The first asks for an API key (typed without echo); the other two open a browser sign-in for a
Claude or ChatGPT subscription. Credentials go to `~/.pine/auth.json` (mode 600). Then set
`defaults.model` in `pine.json`, for example `"opencode-go/deepseek-v4.1-flash"`, or switch in
the UI with `/model`. `pine login <unknown>` lists every provider pi knows.

### With llama.cpp

Start the server with tool-call support and a context that matches `models.json`:

```bash
llama-server -m /path/to/model.gguf --jinja -c 65536 -np 2 --port 8080
```

`-np` (parallel slots) should equal `limits.maxConcurrentRuns`. The context is shared between
slots, so each run gets `c / np` tokens; put that number into `contextWindow`.

## Updating

```bash
pine update
```

brings pine itself up to date and fetches what the new version needs. What it does depends on
how pine got onto the machine, which `pine version` tells you:

| Installed | `pine update` |
|---|---|
| with `npm install -g` | Asks npm for the latest version. If there is one, installs it (`npm install -g @pmndrs/pine@latest`). |
| as a checkout (`git clone`) | Fetches from the repository the checkout follows and moves it forward, then runs `npm install`. Only ever a fast-forward: if commits or changes of your own are in the way, nothing is changed and it says so. |
| as a dependency inside a project | Tells you the command to run in that project; that project decides its version. |

Afterwards it makes sure the browser the web tools drive matches the new version, which is a
download only when that version changed.

`pine update --check` changes nothing and says whether there is something newer.

A pine that is running keeps the old version until it is restarted: quit the terminal UI and
open it again, or restart the daemon (if it runs at login as a LaunchAgent:
`launchctl kickstart -k gui/$(id -u)/com.pine.daemon`).
Your home folder (`~/.pine`) is not touched by an update. When a new version adds something to
the example home, `pine init` copies the files you do not have yet and overwrites nothing.

## Commands

| Command | What it does |
|---|---|
| `pine`, `pine tui` | The terminal UI; starts a daemon inside if none is running |
| `pine .`, `pine <folder>` | The terminal UI with one more tab: a conversation of the main agent that works in that folder (the one from last time, if there is one). A first word that is a command stays a command. See [coding.md](coding.md) |
| `pine login <provider>`, `pine logout <provider>` | Sign in to a model provider. `--api-key` or `--oauth` force the kind of sign-in |
| `pine init [dir]` | Set pine up: a home directory from the example and the browser its web tools drive. Safe to run again |
| `pine update [--check]` | Bring pine up to date. `--check` only says whether there is something newer. See "Updating" |
| `pine version` | Which version this is and how it is installed |
| `pine browser-install` | Fetch the browser again. `pine init` and `pine update` do this already |
| `pine check` | Validate the configuration; show each agent's workspace, model, tools, MCP servers; list security notes |
| `pine start` | Run the daemon in the foreground. Ctrl-C or SIGTERM stops it cleanly |
| `pine dev-model [--port 7464] [--model haiku]` | The `claude -p` model server |
| `pine status` | Running tasks, live sessions (and whether they are tainted), model slots |
| `pine agents` | Configured agents |
| `pine send <agent> <text...>` | Give an agent a task as yourself and print the answer. `--session <key>`, `--no-wait` |
| `pine emit <topic> [json]` | Publish an event as yourself |
| `pine events` | The event log. `--topic <pattern>`, `--limit <n>`, `-f` to follow |
| `pine tasks` | Recent tasks. `--agent <id>`, `--status pending\|running\|done\|failed\|cancelled` |
| `pine task <id>` | One task in full |
| `pine cancel <id>` | Stop a task |
| `pine state [pattern]` | Shared state |
| `pine sources` | Lists the event sources: running or idle, who is subscribed, last event; for one that polls (`http`, `command`), when it last looked or since when that fails |
| `pine subscribe <agent> <source> [--session name] [--note text] [--throttle 5m] [--when json] [--separate]`, `pine unsubscribe <agent> <source> [--session name]` | Wake an agent on a source's events (with `--session`: only that conversation), or stop that |
| `pine subscribe --global <source> [--note text] ...`, `pine unsubscribe --global <source>` | The same for every agent that can use the source |
| `pine approvals`, `pine approve <id> [--always]`, `pine deny <id>` | Answer approval requests; `--always` stops the question for the rest of that conversation |
| `pine reset <agent> [session]` | Start a conversation over; also clears its taint |
| `pine mode <agent> [manual\|auto\|bypass]` | Show or change an agent's mode until the daemon restarts |
| `pine mcp list` | MCP servers, who gets them, whether they connect |
| `pine skills` | Lists every skill: whom it is for (all agents, an agent, one conversation) and where it lies |
| `pine schedules` | Lists what is scheduled: for whom, when, and the task |
| `pine manual <words>`, `pine manual --read <id>` | Search this manual the way the agents do, or read one part of it in full |
| `pine mcp add <name> <url>`, `pine mcp add <name> -- <command...>` | Add a remote or a local server. `--agent <id>` for one agent |
| `pine mcp remove <name> [--agent <id>]` | Remove a server from `pine.json`, or from that agent's `agent.json` |
| `pine mcp login <name>`, `pine mcp logout <name>` | Sign in to a remote server through the browser, or forget its tokens |

All take `--home <dir>`; the default is `$PINE_HOME` or `~/.pine`. The commands from `status`
down to `mode` talk to the running daemon over its control API on `127.0.0.1:7463`, using the
token in `data/http-token`. The `pine mcp` commands work on the files, and `add` and `remove`
also tell a running daemon, so the change applies at once. `pine help` prints the list.

## Running at login

On macOS, [examples/launchd/com.pine.daemon.plist](../../examples/launchd/com.pine.daemon.plist)
is a LaunchAgent that starts pine at login and restarts it when it exits. Follow the three
steps at its top. Logs then go to `~/.pine/data/pine.log`.

On Linux, [examples/systemd/pine.service](../../examples/systemd/pine.service) is a systemd
user service that does the same. Follow the steps at its top. Logs go to the journal
(`journalctl --user -u pine`).

Both run as you, in your login session. To separate the agents from your files more
strongly, create a dedicated user, keep pine's home and the agents' workspaces there, and
install the service for that user.

## The control API

For scripts and other programs. Every request needs `Authorization: Bearer <token>`; POST bodies
are JSON with `Content-Type: application/json`.

| Request | Purpose |
|---|---|
| `GET /health` | Liveness (no token) |
| `GET /status`, `/agents`, `/approvals` | As the CLI commands |
| `GET /models` | Models that have credentials, as `provider/id` |
| `GET /mcp` | Configured MCP servers |
| `POST /mcp` `{ name, server, agent? }` or `{ name, remove: true, agent? }` | Add or remove a server while the daemon runs |
| `POST /mcp/refresh` | Close idle sessions so they start again with the current servers |
| `GET /agents/<id>/sessions` | The agent's conversations: name, number of messages, last use, whether pinned or open in a tab, and when one will be removed by itself |
| `POST /agents/<id>/pin` `{ session, pinned? }` | Pin a conversation so that it is kept, or with `pinned: false` take the pin off |
| `POST /agents/<id>/rename` `{ session, to }` | Give a conversation another name; its history, pin, subscriptions and what was set up for it follow |
| `POST /agents/<id>/remove` `{ session }` | Remove a conversation for good, with its history and what was set up for it alone. Not the main one, and not while it is working |
| `GET /ui/tabs`, `POST /ui/tabs` `{ tabs, active, code? }` | The tabs the terminal UI has open (`tabs` is a list of `{ agent, session }`) and whether its code pane was open, kept so that it opens the same way next time |
| `GET /agents/<id>/folder?session=`, `GET /agents/<id>/folders`, `POST /agents/<id>/folder` `{ session, folder }` | The folder a conversation works in; every conversation of the agent that has one; open a folder for a conversation (`folder: null` closes it). Refused for pine's home, pine's program and other agents' workspaces, and while the conversation is working |
| `GET /agents/<id>/view/changes?session=`, `/view/diff?session=&path=`, `/view/tree?session=&path=`, `/view/file?session=&path=` | What the code pane shows of a conversation's folder (or of the agent's workspace): what git says changed, one file's diff, what is in a folder, a file's text. Read-only, and nothing outside that folder |
| `POST /agents/<id>/model` `{ model }` | Switch an agent's model and save it in its `agent.json` |
| `POST /agents/<id>/thinking` `{ level }` | Set an agent's reasoning level and save it in its `agent.json` |
| `POST /agents/<id>/mode` `{ mode, session?, anyway? }` | Switch an agent's mode until the daemon restarts. `anyway: true` with a `session` keeps bypass in force in that conversation although it has read outside content |
| `GET /tasks?agent=&session=&status=&limit=`, `GET /tasks/<id>` | Tasks |
| `GET /tasks/<id>/transcript` | What a task did, step by step: the text it was given, what it wrote, its tool calls with the start of each result. With `?full=1`: with the whole result of each call, up to 200 000 characters |
| `GET /events?topic=&after=&limit=` | Event log; `after=<id>` pages forward |
| `GET /events/stream?topic=` | Live events as server-sent events |
| `GET /state?key=` | Shared state |
| `POST /events` `{ topic, payload }` | Publish an event (as owner; `"trust": "untrusted"` to lower it) |
| `POST /agents/<id>/prompt` `{ prompt, session?, wait?, attachments? }` | Give a task. Waits for the result unless `wait` is false. `attachments` is a list of `{ name, data }` with base64 data; the files are saved to `inbox/` in the agent's workspace |
| `POST /agents/<id>/reset` `{ session? }` | Reset a session. What it was subscribed to on its own ends too |
| `GET /media/tool/<id>` | A picture a tool returned. The ids are in the `images` field of `agent/<id>/tool` events and of transcript steps |
| `GET /tasks/<id>/images/<n>` | The n-th picture that came with a task (an attachment, a Telegram photo) |
| `GET /agents/<id>/image?path=&session=` | A picture or video file in that agent's workspace or, with `session`, in the folder opened for that conversation. Anything that is not an image or video file in there is "not found" |
| `POST /images/fetch` `{ url }` | Fetch a picture or video from the web for display: https and public addresses only; pictures up to 20 MB, videos up to 100 MB |
| `GET /sources`, `GET /agents/<id>/sources` | Event sources and their state; the ones that agent can subscribe to |
| `POST /agents/<id>/subscribe` `{ source, session?, note?, when?, throttle?, debounce?, separate? }`, `POST /agents/<id>/unsubscribe` `{ source, session? }` | Change an agent's subscriptions (written to its `agent.json`); `session` makes it one conversation's |
| `POST /subscribe` `{ source, note?, ... }`, `POST /unsubscribe` `{ source }` | The subscription of all agents (written to `pine.json`) |
| `POST /agents/<id>/close` `{ session }` | A conversation's tab was closed in a UI: ends what it was subscribed to on its own. The conversation itself is kept |
| `POST /tasks/<id>/cancel` | Cancel |
| `POST /approvals/<id>` `{ allow, always?, values? }` | Answer an approval. A request that lists `inputs` (a token, a password) is only allowed together with `values: { <name>: "..." }`; the terminal UI has a field for them |
| `POST /state` `{ key, value }` | Write state; `null` deletes |
| `POST /hook/<name>` | Webhook: a hook from `http.hooks` ([events.md](events.md)) or a running `webhook` source ([sources.md](sources.md)). No token; each has its own secret, unless a hook is declared `"open": true` |

## Day to day

- **See what is happening:** `pine events -f` in a terminal. Add `--topic "agent/#"` for agent
  activity only; tool calls appear live on `agent/<id>/tool`.
- **Why did it answer that?** `pine task <id>` shows the prompt as the agent received it, the
  tools it called and the result. The full transcript is the newest `.jsonl` under
  `~/.pine/agents/<id>/sessions/<session>/`.
- **Change instructions:** tell the agent ("from now on ..."); it writes that into `AGENTS.md` in
  its workspace. Or edit the file yourself. Either applies to the next message. What all agents
  should know about you goes into `USER.md` in pine's home, which the main agent keeps.
- **Change configuration:** edit `pine.json` or `agent.json`, run `pine check`, restart the
  daemon. Queued tasks survive the restart. MCP servers, event sources, subscriptions and new
  agents need neither an edit nor a restart: ask an agent ([setup.md](setup.md)), or use
  `pine mcp add` and `pine subscribe`.
- **An agent is stuck:** `pine status`, then `pine cancel <id>`.
- **An agent keeps asking for approval:** its session is tainted. `/reset` or `pine reset`.
- **Back up:** the home directory. `data/pine.db` holds events and tasks, `agents/*/sessions`
  the conversations. Workspaces are wherever you put them.

## Problems

| Symptom | Likely cause |
|---|---|
| `pine.json not found` | Wrong home. Pass `--home` or set `PINE_HOME`. |
| `model "x/y" is not defined in models.json` | `defaults.model` or an agent's `model` does not match `provider/id`. `/model` in the UI lists what is available. |
| A task fails with 401 or "API key" | The provider's credential is missing or expired. `pine login <provider>` again. |
| The browser tools fail with "Executable doesn't exist" | Run `pine init` again (or `pine browser-install`): the browser is missing or pine was updated to a newer one. |
| The browser cannot open `localhost` or a page says "not reachable from the browser" | Local addresses need your yes. The agent opens the address with `browser_navigate` and you are asked; see "Local addresses" in [mcp.md](mcp.md). A server the agent started itself also needs network access for its shell. |
| The UI says "reconnecting…" | The daemon it was attached to stopped. Start it again; the UI picks it up. |
| `no daemon answers on http://127.0.0.1:7463` | The daemon is not running, or `http.port` differs from what the CLI reads in this home. |
| A task fails with a connection error | The model server is down or `baseUrl` is wrong. `curl <baseUrl>/models` should answer. |
| A task fails after minutes with a timeout | The model stopped streaming (`limits.modelStreamIdleMs`) or took too long to start (`limits.modelHeadersTimeoutMs`); raise them for a slow model. |
| The agent says a file is "not permitted" | It is outside what the agent reaches. The main agent has your whole account (`sandbox.scope`), but not in a conversation that has read outside content unless you said yes to the question; other agents have their workspace. An agent can ask you with `request_access`; to open a folder for good, use `sandbox.read` / `sandbox.write`. |
| The agent cannot stop a program it started (`kill: Operation not permitted`) | In the workspace scope every command has a sandbox of its own and cannot signal what an earlier one started. An agent with the scope `account` can. Otherwise stop it yourself. |
| `git` complains about identity | In the workspace scope the agent's shell has its own empty home. Run `git config --global user.name ...` once through the agent, or set it per repository. |
| A command needs the network | `sandbox.network: true` for that agent, or better a `commands` tool for that one command. |
| Telegram bot does not react | `pine sources`: is the `telegram` source running, and is a conversation subscribed? A new bot waits to be paired: write to it, and type the code it sends you into the question in the terminal UI (`pine sources` says whom it listens to). Otherwise another program polls the same bot token. |
| An event arrives but no task starts | See "When nothing happens" in [events.md](events.md) for routes and in [sources.md](sources.md) for subscriptions. |
| The first answer after a pause is slow | The session was closed after `idleMs` and is being resumed; MCP servers start again. |

## Coming from OpenClaw

| OpenClaw | pine |
|---|---|
| Agents in `openclaw.json` with `workspace-*` folders | One folder per agent under `agents/`; `workspace` points at the repository |
| Telegram `bindings` | A `telegram` source the agent sets up when you ask it to, and is subscribed to |
| `SOUL.md`, `AGENTS.md`, `MEMORY.md` | The same three names in the agent's workspace, read into its prompt and written by the agent |
| `USER.md` | One `USER.md` in pine's home for all agents, kept by the main agent |
| `IDENTITY.md`, `TOOLS.md`, daily memory files | Not read by pine. Fold what matters into `SOUL.md`, `AGENTS.md` or `MEMORY.md`; other notes are ordinary files in the workspace |
| Cron jobs | A schedule: ask the agent ("every morning at seven ..."), or write it under `schedules` with a `task` |
| Heartbeat | Usually not needed: an event source wakes the agent when something happens, and looking again and again (`http`, `command`) costs no model turn. For a real one, a schedule with `every` whose task ends in "reply NO_REPLY if nothing needs attention" |
| `/hooks/*` mappings | A `webhook` source the agent subscribes to, or `http.hooks` plus a route |
| Managed extensions that watch something and message Telegram themselves | An event source the agent subscribes to (a folder, an FTP drop, MQTT), and the `send` tool for what it reports to you on Telegram. The agent then knows what happened |
| Skills | Skills, same format |
