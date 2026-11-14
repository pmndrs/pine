# Running pine

## Requirements

- macOS or Linux. The agent sandbox is built on the system's own: `sandbox-exec` on macOS,
  [bubblewrap](https://github.com/containers/bubblewrap) on Linux, which `pine init` installs
  and sets up. Agents in `safe` and `manual` mode work in it; an agent in `auto` mode (the
  main agent, as pine comes) needs none. Without a sandbox pine starts and works: agents
  whose mode you did not choose work in `auto`, one you set to `safe` has no shell, and `pine check`
  says why. See [security.md](security.md), "On Linux".
- Optional: `ffmpeg` for videos in the terminal UI (on Linux also for pictures other than
  png, and its `ffplay` for sound; `mpv`, `pw-play`, `paplay` or `aplay` do as well. macOS plays
  sound with what it has); on Linux `xclip`, or on Wayland `wl-copy` and `wl-paste`, for copying a selection and
  pasting a picture.
- Node 24 or newer. From a checkout Node runs the TypeScript sources directly; the npm package
  holds them compiled.
- A model that supports tool calls: a hosted provider pi knows (sign in with `pine login`), or
  your own model server with an OpenAI-compatible chat completions endpoint (add it with
  `pine model add`).

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
- It copies the example home to `~/.pine`: one agent, `main`, with web search, the browser and,
  on a Mac, app control ([computer.md](computer.md)), a `models.json`, an empty `.env`. Nothing
  is overwritten if you run it again.
- On Linux it makes the sandbox work. If bubblewrap is missing it installs the package (apt,
  dnf, yum, pacman, zypper or apk), and on Ubuntu 24.04 and later it writes and loads the
  AppArmor rule bubblewrap needs there. It shows the commands first and asks once; they run
  with `sudo`, which asks for your password itself. `pine init --yes` does not ask, for a
  script or a container build. Where pine cannot do it (no `sudo`, a container without the
  rights), it says what would; pine runs either way: until then agents whose mode you did
  not choose work in `auto` mode, without a sandbox, and one you set to `safe` has no shell.
  The same question covers the system libraries the browser needs, which a server or a
  container image lacks (installed with apt, through Playwright).
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

### With a model server of your own

llama.cpp, vLLM, LM Studio and anything else that speaks OpenAI's chat API is added by its
address, on this machine or another one:

```bash
pine model add studio http://127.0.0.1:8080
```

pine asks the server which models it has, how much context one request gets and whether it
reads pictures, and writes the entry into `models.json`. If the server wants a key (llama-server
started with `--api-key`), it asks you for it without showing it and keeps it in `.env`. A
running pine has the models at once; choose one with `/model studio/<model>`.

- `--context <tokens>` gives the context where the server does not say it (llama.cpp does).
- `--reasoning` or `--no-reasoning` overrides what the server says about a thinking model.
- For a thinking model on llama.cpp, pine also writes which thinking level is sent for each of
  its own (`thinkingLevelMap`), from the levels the server says the model's chat template tells
  apart. So "off" really turns thinking off, and a level the model does not know becomes the
  next one up that it does know, not silently its default. See [configuration.md](configuration.md), "Thinking
  levels".
- `pine model list` shows the servers with their models; `pine model remove <name>` takes one
  out again, with its key, unless an agent still uses it.
- The main agent can do the same when you ask it to ([setup.md](setup.md), "Adding a model
  server").

For llama.cpp, start the server with tool-call support:

```bash
llama-server -m /path/to/model.gguf --jinja -c 65536 -np 2 --port 8080
```

`-np` (parallel slots) should equal `limits.maxConcurrentRuns`. The context is shared between
slots, so each run gets `c / np` tokens; that is the number the server reports and pine writes
down. Add `--alias <name>` to give the model a plain name: without it the name is the path of
the model file.

## In a container

A container needs nothing special:

```bash
docker run -it -v pine:/root/.pine node:24 bash
```

Inside, `npm install -g @pmndrs/pine` and `pine init` as anywhere. `-v pine:/root/.pine`
keeps pine's home when the container is replaced. A container started like this cannot make
a sandbox, and need not: the container is the wall around pine, every agent whose mode you
did not choose works in `auto` mode inside it, and `pine check` says so. An agent you set to
`safe` has no shell there, and runs that events from outside start have none.

| In a container | Without the rights for a sandbox | With them |
|---|---|---|
| An agent whose mode you did not choose | Works in `auto` mode: no sandbox, the container's whole file system and network | The main agent in `auto`, the others in `safe`, as on any machine |
| An agent you set to `safe` | No shell; its file tools work | Works in its sandbox |
| A run that an event from outside started | No shell | Works in the sandbox |
| A `command` source | Is not run | Runs in the sandbox |

To have `safe` mode in a container, start it with the rights for a sandbox. They take away
most of what Docker itself protects:

```bash
docker run -it --cap-add SYS_ADMIN --cap-add NET_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined -v pine:/root/.pine node:24 bash
```

`pine init` then installs bubblewrap and the browser's libraries, which the image does not
have, and names the flags if one is missing. What each flag is for, and the one more an
ordinary user in the container needs, is in [security.md](security.md), "On Linux".

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

What you type in a shell. Every command is the `pine` program with a word after it.

| Command | What it does |
|---|---|
| `pine`, `pine tui` | The terminal UI; starts a daemon inside if none is running |
| `pine .`, `pine <folder>` | The terminal UI with one more tab: a conversation of the main agent that works in that folder (the one from last time, if there is one). A first word that is a command stays a command. See [coding.md](coding.md) |
| `pine login <provider>`, `pine logout <provider>` | Sign in to a model provider. `--api-key` or `--oauth` force the kind of sign-in |
| `pine model add <name> <address>`, `pine model list`, `pine model remove <name>` | Add a model server of your own by its address, list them, take one out. `--context <tokens>`, `--reasoning`, `--no-reasoning` for what the server does not say. See "With a model server of your own" |
| `pine init [dir] [--yes]` | Set pine up: a home directory from the example, the browser its web tools drive and, on Linux, the sandbox (asks before running anything as administrator; `--yes` skips the question). Safe to run again |
| `pine update [--check]` | Bring pine up to date. `--check` only says whether there is something newer. See "Updating" |
| `pine version`, `pine --version` | Which version this is and how it is installed |
| `pine help`, `pine --help` | Prints the list of commands |
| `pine browser-install` | Fetch the browser again. `pine init` and `pine update` do this already |
| `pine check` | Validate the configuration; show each agent's workspace, model, tools, MCP servers; list security notes |
| `pine start` | Run the daemon in the foreground. Ctrl-C or SIGTERM stops it cleanly |
| `pine dev-model [--port 7464] [--model haiku]` | The `claude -p` model server |
| `pine status` | Running tasks, live sessions (and whether they are tainted), model slots |
| `pine agents` | Configured agents, as the daemon has them (JSON) |
| `pine agent list` | The agents, readable: what each is for, model, reasoning, mode, reach, and what it has (conversations, sources, MCP servers, schedules, skills, routes that wake it, files in its workspace). Read from the files; needs no daemon |
| `pine agent add <id> --description "..." [--instructions "..."] [--instructions-file <file>] [--model provider/model] [--tools read,bash,...]` | Create an agent, as `create_agent` does: its folder with `agent.json` and a workspace with its instructions. Without instructions it starts from its description. A running daemon has it at once; without one it is there at the next start |
| `pine agent update <id> [--description ...] [--instructions ... \| --instructions-file <file>] [--soul ... \| --soul-file <file>] [--model ...\|default] [--thinking ...] [--mode auto\|safe\|manual\|bypass\|plan\|default] [--tools read,bash,...] [--delegates id,id\|*] [--network \| --no-network] [--read /p,/p] [--write /p] [--forget /p]` | Change an agent's settings, as `update_agent` does: give only what changes, the rest stays. It holds from the agent's next message on. A running daemon applies it at once; without one the files are changed and it is there at the next start, except a model change, which needs the daemon (it checks the model exists) |
| `pine agent remove <id> [--keep-files] [--yes]` | Remove an agent and everything it has, so that nothing of it is left: conversations, sources, schedules, servers, skills, the routes that wake it, what pine stored under its name, its folder and its private home. It lists what goes and asks before it deletes; `--yes` answers for a script. `--keep-files` moves the folder to `removed/` in pine's home instead of deleting it. Through a running daemon when there is one, in the files when not. See "Changing and removing an agent" in [setup.md](setup.md) |
| `pine send <agent> <text...>` | Give an agent a task as yourself and print the answer. `--session <key>`, `--no-wait` |
| `pine emit <topic> [json]` | Publish an event as yourself |
| `pine events` | The event log. `--topic <pattern>`, `--limit <n>` (30), `-f` to follow |
| `pine tasks` | Recent tasks. `--agent <id>`, `--status pending\|running\|done\|failed\|cancelled`, `--limit <n>` (20) |
| `pine task <id>` | One task in full |
| `pine cancel <id>` | Stop a task |
| `pine state [pattern]` | Shared state |
| `pine sources` | Lists the event sources: running or idle, who is subscribed, last event; for one that polls (`http`, `command`), when it last looked or since when that fails |
| `pine subscribe <agent> <source> [--session name] [--note text] [--throttle 5m] [--when json] [--separate]`, `pine unsubscribe <agent> <source> [--session name]` | Wake an agent on a source's events (with `--session`: only that conversation), or stop that |
| `pine subscribe --global <source> [--note text] ...`, `pine unsubscribe --global <source>` | The same for every agent that can use the source |
| `pine approvals`, `pine approve <id> [--always]`, `pine deny <id>` | Answer approval requests; `--always` stops the question for the rest of that conversation |
| `pine reset <agent> [session]` | Start a conversation over; also clears its taint |
| `pine mode <agent> [auto\|safe\|manual\|bypass\|plan]` | Show or change an agent's mode. `auto`, `safe` and `manual` are saved in its `agent.json` and hold after a restart; `bypass` and `plan` hold until pine restarts. `auto` and `bypass` work without a sandbox, `safe` and `manual` in one. `plan`: the agent only looks and answers with a plan. See "Modes" in [security.md](security.md) |
| `pine mcp list` | MCP servers, who gets them (all agents, one agent, or one conversation of an agent), whether they connect. `--offline` lists without connecting |
| `pine skills` | Lists every skill: whom it is for (all agents, an agent, one conversation) and where it lies |
| `pine schedules` | Lists what is scheduled: for whom, when, and the task |
| `pine manual <words>`, `pine manual --read <id>` | Search this manual the way the agents do, or read one part of it in full (several ids with commas). Without words: the list of its parts |
| `pine mcp add <name> <url>`, `pine mcp add <name> -- <command...>` | Add a remote or a local server. `--agent <id>` for one agent; `--taints`, `--approve always\|tainted`, `--timeout <seconds>`, `--description <text>`, `--exposure <how>` as in [mcp.md](mcp.md) |
| `pine mcp remove <name> [--agent <id>]` | Remove a server from `pine.json`, or from that agent's `agent.json` |
| `pine mcp login <name>`, `pine mcp logout <name>` | Sign in to a remote server through the browser, or forget its tokens |

All take `--home <dir>`; the default is `$PINE_HOME` or `~/.pine`. The commands from `status`
down to `mode` talk to the running daemon over its control API on `127.0.0.1:7463`, using the
token in `data/http-token`. The `pine mcp` and `pine model` commands work on the files, and `add` and `remove`
also tell a running daemon, so the change applies at once. `pine schedules`, `pine skills`,
`pine check` and `pine manual` only read the files and need no daemon. `pine help` prints the
list.

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
| `POST /agents` `{ id, description, instructions, model?, tools? }`, `POST /agents/<id>/update` `{ description?, instructions?, model?, thinking?, mode?, tools?, delegates?, scope?, network?, read?, write?, forget? }`, `POST /agents/<id>/erase` `{ agent, keepFiles? }` | Create an agent, change its settings, or remove one with everything it has, while the daemon runs (`erase` repeats the id in `agent`: removing an agent is not done by a mistyped address). What `pine agent add`, `pine agent update` and `pine agent remove` call |
| `POST /models/refresh` | Read `models.json` and `.env` again, after a model server was added or removed in the files. `pine model add` and `pine model remove` call it |
| `GET /agents/<id>/sessions` | The agent's conversations: name, number of messages, last use, whether pinned or open in a tab, the folder opened for it, and when one will be removed by itself |
| `POST /agents/<id>/pin` `{ session, pinned? }` | Pin a conversation so that it is kept, or with `pinned: false` take the pin off |
| `POST /agents/<id>/rename` `{ session, to }` | Give a conversation another name; its history, pin, subscriptions and what was set up for it follow |
| `POST /agents/<id>/remove` `{ session }` | Remove a conversation for good, with its history and what was set up for it alone. Not the main one, and not while it is working |
| `GET /ui/tabs`, `POST /ui/tabs` `{ tabs, active, code?, notify? }` | The tabs the terminal UI has open (`tabs` is a list of `{ agent, session }`, 50 at most), whether its code pane was open (`code`) and whether it calls for attention with a bell (`notify`, set with `/notify`), kept so that it opens the same way next time. `code` and `notify` stay as they were when left out. A conversation that is open in a tab is not removed for being unused |
| `GET /agents/<id>/folder?session=`, `GET /agents/<id>/folders`, `POST /agents/<id>/folder` `{ session, folder }` | The folder a conversation works in; every conversation of the agent that has one; open a folder for a conversation (`folder: null` closes it). Refused for pine's home, pine's program and other agents' workspaces, and while the conversation is working |
| `GET /agents/<id>/goal?session=`, `POST /agents/<id>/goal` `{ session, objective }` or `{ session, action }` | Goal mode. `GET` returns `{ goal }` with the objective, `status` (`active`, `paused`, `met`, `blocked`, `limit`), the round, pine's note on what happened last and the judge's reason; no goal: `{}`. `objective` sets the conversation's goal and starts on it; `action` is `pause`, `resume` or `clear`. Every change is also an event on `agent/<id>/goal`. See "Goal mode" in [agents.md](agents.md) |
| `GET /agents/<id>/programs?session=`, `POST /agents/<id>/programs/stop` `{ session, id }` | What a conversation's commands left running (command, ports, how long), and stopping one of them. A command the agent started in the background is among them while it runs, with `background: true` and `output` (the file its output goes to). Only a program of that conversation can be stopped. |
| `GET /agents/<id>/view/changes?session=`, `/view/diff?session=&path=`, `/view/tree?session=&path=`, `/view/file?session=&path=`, `/view/find?session=&q=` | What the code pane shows of a conversation's folder (or of the agent's workspace): what git says changed, one file's diff, what is in a folder, a file's text, the files whose name fits a few letters. Read-only, and nothing outside that folder |
| `GET /agents/<id>/view/turn?session=`, `/view/turndiff?session=&path=` | What your last message in a conversation changed in its folder, which is what `/undo` would take back: `{ task, prompt, root, files, more, note? }` (at most 300 files; `note` says why there is nothing to show), and one file's diff over that message. While the message is still being worked on: what it has changed so far. See [coding.md](coding.md) |
| `POST /agents/<id>/model` `{ model }` | Switch an agent's model and save it in its `agent.json` |
| `GET /agents/<id>/todos?session=` | The list of steps the agent keeps in that conversation |
| `POST /agents/<id>/compact` `{ session? }` | Shorten a conversation: its earlier part becomes a summary. Queued like a message; answers with the task's id |
| `POST /agents/<id>/thinking` `{ level }` | Set an agent's reasoning level and save it in its `agent.json` |
| `POST /agents/<id>/mode` `{ mode, session?, anyway? }` | Switch an agent's mode (`auto`, `safe`, `manual`, `bypass` or `plan`). `auto`, `safe` and `manual` are saved and hold after a restart; `bypass` and `plan` hold until the daemon restarts. `anyway: true` with a `session` keeps bypass in force in that conversation although it has read outside content |
| `GET /tasks?agent=&session=&status=&limit=`, `GET /tasks/<id>` | Tasks |
| `GET /tasks/<id>/transcript` | What a task did, step by step: the text it was given, what it wrote, its tool calls with the start of each result. With `?full=1`: with the whole result of each call, up to 200 000 characters |
| `GET /events?topic=&after=&limit=` | Event log; `after=<id>` pages forward |
| `GET /events/stream?topic=` | Live events as server-sent events |
| `GET /state?key=` | Shared state |
| `POST /events` `{ topic, payload }` | Publish an event (as owner; `"trust": "untrusted"` to lower it) |
| `POST /agents/<id>/prompt` `{ prompt, session?, wait?, attachments?, whenBusy?, mentions? }` | Give a task. Waits for the result unless `wait` is false. With `"whenBusy": "steer"`, a message for a conversation that is working is given to that work instead of waiting behind it (the answer then carries `steered`, the id of that task). `mentions` lists files of the conversation's folder that the message points at with `@` (`"src/a.ts"`, `"src/a.ts#20-45"`); the agent is told to read them. `attachments` is a list of `{ name, data }` with base64 data, at most 10 files of 20 MB each; the files are saved to `inbox/` in the agent's workspace. With `"cancelOnDisconnect": true` the task is cancelled when the caller closes the connection while it waits |
| `POST /agents/<id>/reset` `{ session? }` | Reset a session. What it was subscribed to on its own ends too |
| `POST /agents/<id>/undo` `{ session? }`, `POST /agents/<id>/redo` `{ session? }` | Take back the owner's last message in a conversation, with the files it changed, or bring back what the last undo took. See [coding.md](coding.md) |
| `GET /media/tool/<id>` | A picture a tool returned. The ids are in the `images` field of `agent/<id>/tool` events and of transcript steps |
| `GET /tasks/<id>/images/<n>` | The n-th picture that came with a task (an attachment, a Telegram photo) |
| `GET /agents/<id>/image?path=&session=` | A picture, video or sound file in that agent's workspace or, with `session`, in the folder opened for that conversation. Anything that is not an image, video or sound file in there is "not found" |
| `POST /images/fetch` `{ url }` | Fetch a picture, video or sound from the web for display: https and public addresses only; pictures up to 20 MB, videos and sound up to 100 MB |
| `GET /sources`, `GET /agents/<id>/sources` | Event sources and their state; the ones that agent can subscribe to |
| `POST /agents/<id>/subscribe` `{ source, session?, note?, when?, throttle?, debounce?, separate? }`, `POST /agents/<id>/unsubscribe` `{ source, session? }` | Change an agent's subscriptions (written to its `agent.json`); `session` makes it one conversation's |
| `POST /subscribe` `{ source, note?, ... }`, `POST /unsubscribe` `{ source }` | The subscription of all agents (written to `pine.json`) |
| `POST /agents/<id>/close` `{ session }` | A conversation's tab was closed in a UI: ends what it was subscribed to on its own. The conversation itself is kept |
| `POST /tasks/<id>/cancel` | Cancel |
| `POST /approvals/<id>` `{ allow, always?, values? }` | Answer an approval. A request that lists `inputs` (a token, a password) is only allowed together with `values: { <name>: "..." }`; the terminal UI has a field for them. A question an agent asks with its `question` tool is such a request (`tool: "question"`, with the answers it offers in `choices`): answer it with `values: { "answer": "..." }`, or with `allow: false` for no answer |
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
- **An agent keeps asking for approval:** it is in manual mode (`pine mode <agent> auto`, or
  the mode in the bottom bar of the terminal UI), or the question names a tool on its `approve`
  list. Sending something out also asks after a conversation has read outside content (it is
  tainted): "Always here" in the dialog covers that tool for the conversation, and `/reset`
  or `pine reset` starts a clean one.
- **Back up:** the home directory. `data/pine.db` holds events and tasks, `agents/*/sessions`
  the conversations. Workspaces are wherever you put them.

## Problems

| Symptom | Likely cause |
|---|---|
| `pine.json not found` | Wrong home. Pass `--home` or set `PINE_HOME`. |
| `model "x/y" is not defined in models.json` | `defaults.model` or an agent's `model` does not match `provider/id`. `/model` in the UI lists what is available. |
| A model of your own server is missing from `/model` | The server wants a key and `models.json` names one that is not in `.env`. `pine check` lists it under "Model notes"; add the line to `.env` and restart, or remove the server and add it again with `pine model add`. |
| `pine model add` says "no model server answers" | Nothing listens at that address, or it is not reachable from this machine (a firewall, a VPN that is off). `curl <address>/v1/models` shows what the server says. |
| An answer starts late: the model reads the whole conversation again after you were in another tab or conversation, or after a restart | The model server has kept nothing of the conversation. With a llama.cpp server pine keeps each conversation in a slot of its own; give the server enough slots (`-np`), and a folder for them (`--slot-save-path`), so that a conversation that has to leave its slot is read back from a file (`limits.slotPages`). A scheduler that stops and starts the model makes it forget everything unless it saves the slots. See [agents.md](agents.md), "What the model server keeps". |
| The first message of a new conversation takes long, and the tools take too many tokens of the prompt | The model reads every tool's declaration first. `defaults.catalogue` `families` (the default) declares them grouped and short; `limits.warmSlots` has an idle slot read that beginning ahead of time. See [agents.md](agents.md), "How tools are declared". |
| A task fails with 401 or "API key" | The provider's credential is missing or expired. `pine login <provider>` again. |
| The browser tools fail with "Executable doesn't exist" | Run `pine init` again (or `pine browser-install`): the browser is missing or pine was updated to a newer one. |
| The browser cannot open `localhost` or a page says "not reachable from the browser" | Local addresses need your yes. The agent opens the address with `browser_navigate` and you are asked; see "Local addresses" in [mcp.md](mcp.md). A server the agent started itself also needs network access for its shell. |
| The agent says macOS does not let pine operate apps, or take pictures of the screen | macOS has to be told once: System Settings > Privacy & Security > Accessibility (and Screen & System Audio Recording for pictures), switch on the terminal app pine runs in. See "What macOS has to be told, once" in [computer.md](computer.md). |
| The agent has no tools to click or type in apps | App control is for an agent that reaches your whole account, in your own conversations, on macOS. `pine check` says which under `apps`. See [computer.md](computer.md). |
| The UI says "reconnecting…" | The daemon it was attached to stopped. Start it again; the UI picks it up. |
| `no daemon answers on http://127.0.0.1:7463` | The daemon is not running, or `http.port` differs from what the CLI reads in this home. |
| A task fails with a connection error | The model server is down or `baseUrl` is wrong. `curl <baseUrl>/models` should answer. |
| A task fails after minutes with a timeout | The model stopped streaming (`limits.modelStreamIdleMs`) or took too long to start (`limits.modelHeadersTimeoutMs`); raise them for a slow model. |
| The agent stops after every step and asks whether it should go on | That is how a turn ends. Give the conversation a goal: `/goal <what should be reached>` in the terminal UI, and it is called again until a judge says the goal is met ("Goal mode" in [agents.md](agents.md)). |
| A goal is paused with "gave no verdict" | The judge did not answer in time (`limits.goalJudgeTimeout`) or not with MET, CONTINUE or BLOCKED. `/goal resume` goes on; if it happens often, give the judge a model that follows a format (`defaults.judge`). |
| The agent says a file is "not permitted" | It is outside what the agent reaches. The main agent works in `auto` mode and has your whole account; other agents work in `safe` mode, in a sandbox, and have their workspace (`mode`: `pine mode <agent> auto` gives another agent the account). pine's own home is closed to every agent in every mode. After outside content the main agent keeps that reach, except for files that are read as instructions (the `AGENTS.md` of the folder it works in, for example). You are asked when a call needs something outside (by pine, or by the agent with `request_access`); if you said no, pine does not ask again in that conversation. To open a folder for good, use `sandbox.read` / `sandbox.write`. |
| An approval `request_access` appears that the agent did not ask for | pine asked on the agent's behalf: a file tool or a shell command needed a file or folder outside the agent's sandbox, or the network. The first lines say what, the line `for:` which call. Yes holds for that conversation; no is remembered there. See "When a call needs something outside" in [security.md](security.md). |
| An agent says "No such file" for a folder in your home that exists (`~/Documents/scans`) | In the shell of an agent in the sandbox (`safe` or `manual` mode) `~` is its own private home (`sandbox/<id>/` in pine's home), not yours. pine catches this where the path is written out in the command, asks you for the folder in your home, and tells the agent to use the full path. Tell the agent the full path (`/Users/you/Documents/scans`) if it built the name some other way. |
| The agent cannot stop a program it started (`kill: Operation not permitted`) | In the sandbox (`safe` or `manual` mode) every command has a sandbox of its own and cannot signal what an earlier one started. The agent's `stop_program` tool works in every mode, and so does `■ stop` under Running in the code pane. |
| `git` complains about identity | In the sandbox (`safe` or `manual` mode) the agent's shell has its own empty home. Run `git config --global user.name ...` once through the agent, or set it per repository. |
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
