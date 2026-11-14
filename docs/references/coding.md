# Working on code

Two things turn a conversation into a place to work on a project: a **folder** that is opened
for it, and the **code pane** beside it that shows what git says changed there, the files, and
what the agent's tool calls printed. A message whose result you do not want is taken back
with `/undo`, files included.

```bash
cd ~/dev/shop
pine .
```

![The code pane beside a conversation, showing the diff of a file the agent changed](../images/code.png)

## A folder for a conversation

An agent works in its own workspace. A conversation can be given a folder of yours on top of
that: a repository, a project. From its next message on

- the agent's shell and file tools start in that folder (a relative path means a path there),
- it may read and change what is in it, like its own workspace,
- the folder's instruction files (`AGENTS.md`, `CLAUDE.md`) apply, next to the agent's own,
- the agent is told which folder it works in and that its own workspace is still there.

Everything else stays as it is: for an agent in the sandbox (`safe` or `manual` mode) the rest
of your home is closed and the network is closed unless you opened it, and the agent's mode
decides what it asks before doing.

The main agent works in `auto` mode and reaches your whole account anyway (see "Modes" in
[security.md](security.md)), so it can work on a project without a folder being opened.
Opening one still does two things for it: its tools start there, and the folder's instruction
files apply.

The folder belongs to that one conversation. Another conversation of the same agent does not
have it. Sub-agents it starts do, and so does another agent for the length of one task that
is handed to it from this conversation (`delegate` without a thread): a specialist has to see
the project it is asked about. A conversation that other agent keeps does not get it. It stays until
you take it away or remove the conversation, also across restarts. A renamed conversation
keeps it.

There are four ways to open one:

| | |
|---|---|
| `pine .` or `pine <folder>` | Starts the terminal UI with the tabs of last time and one more on that folder: a conversation of the main agent, named after the folder. If a conversation already works there, that one is opened again |
| The folder in the bottom bar | Click it (`no folder`, or the folder's path) for a list: no folder, this conversation's folder, the folder pine was started in (unless that is your home folder), folders other conversations of this agent use, and "Pick a folder …", which opens the system's folder chooser on macOS |
| `/folder <path>`, `/folder none` | The same by command (`off` and `-` mean `none` too). `/folder` alone opens the list |
| Drag a folder onto the terminal | It becomes the folder of the conversation in front. (A file dropped there is attached to your next message, as always) |

![The folder menu over a conversation that works in a project folder](../images/folder.png)

Only you can do this. There is no tool for it: an agent cannot open a folder for itself, and
nothing an agent reads can.

A folder is refused when it is, contains or lies in pine's home (your home folder contains it,
if pine's home is `~/.pine`), pine's own program, or another agent's workspace. It cannot be
changed while the conversation is working.

For a project an agent should always work in, without opening anything, set `workspace` in its
`agent.json` instead ([agents.md](agents.md)).

## The code pane

`▤ code` at the right end of the tab bar, `ctrl+g` or `/code` opens a pane beside the
conversation; the same closes it. It shows the conversation's folder, or the agent's workspace
when no folder is open. In a terminal of 100 columns or more it takes half the width (at most
96 columns); in a narrower one it takes the place of the conversation until it is closed.

```
 pine  1 ★ main ×  2 main·shop ×   +                                                ▤ code
───────────────────────────────────────────────────────────────────────────────────────────
 make the total include shipping          │  Changes  Files  Output  Running           ↻  ×
                                          │ main · 2 changed · ~/dev/shop
 ✓ edit src/cart.ts 12 ms                 │─────────────────────────────────────────────────
 ✓ bash npm test 2.1 s                    │ M src/cart.ts  +4 −1
                                          │ + src/shipping.ts  +12
 The total now includes shipping ...      │
```

| View | Shows | A click |
|---|---|---|
| **Changes** | What differs from the last commit: changed (`M`), added (`A`), new (`+`), deleted (`D`) and renamed (`R`) files with the lines added and removed, and the branch. Its first line switches to **by your last message**: the same list and diffs, counted from before your last message instead of from the last commit | on a file shows its diff, added lines green and removed ones red; `‹ back` returns to the list; `▸ by your last message` and `▸ since the last commit` switch between the two |
| **Files** | The folder as a tree | on a folder opens or closes it; on a file shows its text with line numbers and colours, or a picture as a picture |
| **Output** | Every tool call of the conversation's last 8 messages, newest first: the tool, what it was called with, how long it took | on a call shows everything it printed, not only the first lines the conversation shows |
| **Running** | What the conversation's commands started and left running: a development server, a watcher. Each with its command, the ports it listens on and how long it has run. A command the agent put into the background is listed too, with the file its output goes to | on `■ stop` ends it |

The pane follows the agent: when a tool call finishes, what is shown is read again, so a diff
grows while the agent edits. `↻` reads it again by hand, `×` closes the pane. The wheel scrolls
whichever side the pointer is over. Whether the pane was open is remembered for the next start.

`/code changes`, `/code files`, `/code output` and `/code running` open it on that view;
`/code turn` opens the changes of your last message; `/code off` closes it.

### What an agent left running

An agent that works on a web page starts its development server and leaves it running
(`npm run dev &`). pine notes every command's process group and so knows what is still there
when a command has ended, whatever the agent says about it. For each conversation:

- **Running** in the code pane lists it, and `■ stop` ends it (asked first, ended two seconds
  later if it is still there).
- The agent is told in its next message what it left running and on which ports, and has
  `stop_program` to end one. Ask it: "stop the servers you started".
- Resetting or removing the conversation stops what it left running. Quitting pine does not:
  the programs are listed again at the next start. `/undo` does not either: it stops the
  agent's work on a message, not a server that work started.

A program that detaches itself completely (a daemon that starts a session of its own) is not
found this way. On Linux, in the sandbox (`safe` or `manual` mode), nothing outlives its
command in the first place; a server there is started in the background (next section), or
by an agent in `auto` mode.

### Commands in the background

A shell command is waited for until it ends, and it is stopped when it reaches the time limit
(`bashTimeoutSec`). A long-running build, a test run, an install or a server does not fit
into that. Such a command the agent starts in the background: it does not wait for it to
finish, goes on working meanwhile, and is told when the command is done. For this the agent's
shell tool takes `background`:

| Name | What it does |
|---|---|
| `background` | An argument of the `bash` tool. With `background: true` the command is started and the call returns at once, with the command's id and the file its output goes to. The agent does not wait for it: pine tells the conversation when the command has ended. The time limit does not apply to it. |
| `timeout` | An argument of the `bash` tool: how many seconds a command that is waited for may take. Never more than `bashTimeoutSec`. It does not apply to a command in the background. |

The agent's `stop_program` tool ends a command in the background before it ends by itself, by
its id; without an id it lists what is running, with each output file. A command that was
waited for and reached the time limit is stopped as before; the agent is then told that
`background: true` would have given it the time.

What happens, step by step:

- The command runs in the same sandbox as every other command of that conversation, and starts
  in the same folder. It cannot do anything in the background that it could not do otherwise.
- Everything it prints goes to a file in the agent's own temp folder
  (`sandbox/<agent>/tmp/background/<name>.log` in pine's home). The agent reads it with its
  ordinary file tools, also while the command runs. pine does not delete these files.
- When the command ends, the conversation that started it gets a message from pine, not from
  you: the id, the command, how it ended (the exit code, a signal, or that you stopped it), how
  long it ran, and its last lines. The agent then goes on with the task, and you get its answer
  where you got the others (the terminal UI, Telegram).
- Commands that end while the agent is at work, or within a moment of each other, are told in
  one message, when the agent has nothing else to do.
- A command that ends and leaves a program running (`npm run dev &`) is told as ended, and the
  message says that something is still running. It is then listed like anything else an agent
  left running.
- While such a command runs and the agent's turn is over, the status line under the
  conversation says so (`● a command runs in the background: brew install ... · 3 min`), so
  that a long install does not look like a hang. It says the same for a server or another
  program that was left running.
- **Running** in the code pane lists a command in the background with its output file, and
  `■ stop` ends it. The agent is then told that you stopped it. What the agent stops itself
  with `stop_program` it is not told again.
- Resetting or removing the conversation ends its background commands, and nothing is told.
- Quitting pine does not end them. At the next start a command that is still running is listed
  again and told when it ends; one that ended while pine was not running is told at once, with
  its exit code. (Only when it was ended from outside while pine was away, with a signal it
  could not outlive, the message says that how it ended is not known.)

What the commands print is shown to the agent as output, every line marked, and never as
something you said. If the conversation had read outside content when it started the command,
the message about its end counts as outside content too.

Limits: at most 8 commands of one conversation run in the background at a time. A run that an
outside event started cannot use `background`, and neither can a run of its own (the session
`new`, or a task that another agent handed over without a thread): there is no conversation
of yours that could be told. A sub-agent can; the conversation it works for is told. On Linux
a conversation that has read outside content cannot either ([security.md](security.md), "On
Linux"). A command that was waited for and reached the time limit is not moved into the
background: it is stopped, and has to be started again with `background: true`.

Apart from that stop, the pane only shows. It changes no file, runs no command of the project and sends nothing to a
model. Long lines wrap. A file is shown up to 256 KB, a diff up to 200 000 characters, a tool's
output up to 200 000 characters and 4000 lines; binary files are named, not shown. Changes
lists the first 300 files, and Files shows up to 500 entries of a folder.

While the pane is open, pictures and videos in the conversation are drawn with coloured half
blocks also on terminals that can show real pictures. A terminal draws a real picture only at
the left edge of a full line, where it would lie across the pane.

## Taking a message back

`/undo` takes back your last message in a conversation, with everything it led to:

1. What is still running is stopped: the agent's own work, its sub-agents, and what it handed
   to other agents for that message.
2. The files of the conversation's folder go back to what they were before the message was
   worked on (the agent's workspace when no folder is open).
3. The conversation forgets the message and what followed it: the answer, the tool calls, and
   whatever else arrived in the conversation since (an answer that came back from another
   agent, a schedule that ran there).
4. The message's text is put back into the input, to be changed and sent again.

`/undo` again takes back the message before that one. `/redo` brings back what the last
`/undo` took, files and conversation; after several undos, one message at a time. It works
until something new is said in the conversation: a new message makes the undo final.

| Command | What it does |
|---|---|
| `/undo` | Take back your last message in this conversation: stop its work, restore the files it changed, make the conversation forget it and what followed, and put its text back into the input. A mistake of the agent's is undone this way |
| `/redo` | Bring back what the last `/undo` took, files and conversation. Works until a new message is sent |
| `/code turn` | Show in the code pane what your last message changed in the folder, as a list and as diffs: what `/undo` would restore |

The conversation says each time what happened: which message was taken back, how many files
were restored and which, what was left alone, and how to bring it back.

```
 ↶ taken back: “make the total include shipping”
   2 files restored in ~/dev/shop (1 changed back, 1 removed): src/cart.ts, src/shipping.ts
   not taken back: what commands did outside this folder, files git ignores or that are over 2 MB, and anything that was sent out
   the message is in the input again, to change and send
   /redo brings it back, until you send a new message
```

### What is restored, and what is not

pine records the folder before the first tool call of a message and again when its work ends.
A message that is only answered records nothing. The first record of a large folder takes a
moment, because every file is read once; after that only what changed is looked at. An undo sets the files that differ between
the two back to how they were before. Files the message's work did not change are left as
they are, so what you changed elsewhere in the folder since then stays. What changed in the
folder while the message was being worked on counts as its work, whoever changed it: you in
an editor, or another conversation in the same folder.

Not recorded, and so never restored:

- Files the folder's ignore rules leave out: its `.gitignore` files, those above it in its
  repository, and the repository's `info/exclude`. That is `node_modules`, build output and
  the like. Your global git ignore file does not count.
- Files larger than 2 MB. An undo names the ones it left alone.
- A git repository inside the folder (a clone, a submodule).
- A folder in which more than 50 000 files or 512 MB are new or changed at once. Then no
  file is restored, and the undo says so; the conversation is taken back all the same.

An undo cannot take back at all:

- what commands did outside the folder: a package installed for your account, a file written
  somewhere else, a row in a database;
- commits, branches and everything else inside `.git`: the files you see are restored, the
  repository's history is not touched;
- anything that was sent out: a message, a request to a web service, an event;
- what the agent set up in pine with its tools (a source, a schedule, an MCP server, a
  skill): ask it to remove that, or remove it yourself.

What the conversation was allowed while the message was worked on goes with the message: an
"always" in an approval dialog, access given with `request_access`, and the outside-content
mark, if this was the message that brought outside content in. The conversation is then what
it was before the message, as far as pine can make it so. A redo brings these back too.

Only you can undo, in the terminal UI or through the control API. No agent has a tool for
it. What an outside event started in a conversation is not a message of yours and is not
what `/undo` takes back. A message that still waits behind another one is withdrawn, and
what runs before it goes on.

The states are kept in pine's home under `data/snapshots`: git trees in a git directory of
pine's own for each folder. Your own repository, its index and its history are never
touched, and a folder that is no repository is recorded the same way. Recording needs git
and pine's sandbox (macOS, or Linux with bubblewrap); without them an undo takes back the
conversation and says that no file was restored. pine keeps the last 40 messages of a
conversation undoable, and removes states that no message refers to after a few days. What
was said in a message that was taken back stays in the conversation's session file on disk,
unused and not shown to the model, until the conversation is reset or removed.

## What it is safe against

- **Looking is not running.** A repository can name programs for git to start: a diff driver, a
  text converter, hooks, a file system monitor. The pane runs git in a sandbox that can write
  nothing and has no network, and with those features switched off, so a folder you only opened
  to look at cannot make anything run.
- **Nothing outside the folder.** Paths are resolved with their links and must stay inside the
  folder; a link that leads out of it is neither listed nor opened.
- **An undo writes the folder and nothing else.** The files are put back by git, which runs
  in a sandbox that can write the folder and pine's own record of it, has no network, and
  reads neither the folder's git settings nor yours: no hook, filter or line-ending rule
  applies, and a file comes back byte for byte. A folder that an agent swapped for a link to
  somewhere else is made a folder again; nothing is written through the link.
- **A folder is for your conversation, not for what arrives in it.** A run that an outside
  event started, not you, does not get the folder: it works in the agent's own workspace. A
  conversation of yours that has read outside content (a web page) keeps the folder, with the
  two limits below. See [security.md](security.md).
- **Instruction files.** `AGENTS.md` and `CLAUDE.md` of an opened folder are instructions to
  the agent, like those of its workspace. Open folders you trust as much as you trust their
  authors with your agent. Once a conversation has read outside content, its file tools no
  longer change these files, and in `safe` and `manual` mode the sandbox refuses a shell
  command that writes them as well. In `auto` mode nothing checks a shell command for them.
- **Git hooks and configuration.** What lies in `.git/hooks` and `.git/config` runs with your
  rights the next time you use git in that folder. A conversation that has read outside content
  can still commit and branch there, but its file tools do not change those, and in `safe` and
  `manual` mode the sandbox refuses a shell command that writes them as well. One that has read none can, like
  the rest of the folder: it acts on what you told it.

## From a script

The control API ([operations.md](operations.md)) has the same things:

| Request | Purpose |
|---|---|
| `GET /agents/<id>/folder?session=` | The folder of a conversation, and the agent's workspace |
| `GET /agents/<id>/folders` | Every conversation of the agent that has a folder |
| `POST /agents/<id>/folder` `{ session, folder }` | Open a folder for a conversation; `folder: null` closes it |
| `GET /agents/<id>/view/changes?session=` | What git says changed in the conversation's folder |
| `GET /agents/<id>/view/diff?session=&path=` | The diff of one file (path from the top of the repository) |
| `GET /agents/<id>/view/tree?session=&path=` | What is in one folder (path from the conversation's folder) |
| `GET /agents/<id>/view/file?session=&path=` | A file's text |
| `GET /agents/<id>/view/find?session=&q=` | The files of the conversation's folder whose name fits a few letters: what `@` offers |
| `GET /tasks/<id>/transcript?full=1` | A task's steps with the whole output of each tool call |
| `GET /agents/<id>/programs?session=`, `POST /agents/<id>/programs/stop` `{ session, id }` | What the conversation's commands left running, background commands among them, and stopping one |
| `POST /agents/<id>/undo` `{ session }` | Take back your last message in a conversation. The answer has the message's text (`prompt`), what was restored (`restored`: `root`, the counts `changed`, `removed` and `back`, the first `files`, and `left` for files too large to record), a `note` when no file was restored, `stopped`, how many messages a redo can bring back (`redo`), and whether there is another message to take back (`more`) |
| `POST /agents/<id>/redo` `{ session }` | Bring back what the last undo took. The same answer |
| `GET /agents/<id>/view/turn?session=` | What your last message changed in the conversation's folder: `files` with their line counts, or a `note` saying why there is nothing |
| `GET /agents/<id>/view/turndiff?session=&path=` | The difference of one file over your last message (path from the conversation's folder) |
