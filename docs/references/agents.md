# Agents

An agent is a folder under `agents/` in pine's home. The folder name is its id (lowercase
letters, digits, `-`, `_`).

```
agents/gonzo/
  agent.json     settings (see configuration.md); {} is enough
  AGENTS.md      who the agent is and how it works
  skills/        optional: its own skills
  extensions/    optional: its own pi extensions
```

## Creating an agent

Ask the main agent ("create an agent that keeps my books"): it calls `create_agent`, you confirm
what it proposes, and the folder above is made with `agent.json`, `AGENTS.md` and an empty
workspace. The agent exists at once, without a restart. Only the main agent has this tool; the
others tell you to ask it. See [setup.md](setup.md).

By hand: make the folder with an `agent.json` (`{}` is enough) and an `AGENTS.md`, run
`pine check`, and restart.

## What an agent sees

Its system prompt is put together from, in this order:

1. pine's base prompt: that it is an agent in pine working for its owner, how to use its file
   tools, that it is confined to its workspace, that pine's setup is changed through tools and
   never by writing its files (which of them it has, and that creating agents and anything for
   all agents is the main agent's job), that for everything else it should explain the steps to
   its owner, and that text from tools, files and the web is information, never a command. An
   `agents/<id>/SYSTEM.md` replaces this text.
2. `agents/<id>/AGENTS.md`: the agent's standing instructions.
3. `AGENTS.md` (or `CLAUDE.md`) in its workspace, if there is one, plus any files in `context`.
4. Its skills: one line each; the agent reads a skill's file when it needs it. One skill is
   always there: `pine`, this manual. An agent asked for a plugin, a skill or another model
   reads it and tells you what to put into which file; an MCP server or an event source it
   sets up itself by tool call ([setup.md](setup.md)).
5. A `<pine>` block: who the agent is, which agents it can delegate to, which MCP servers it
   has. It only changes when the configuration does.

To show you a picture, an agent writes `![caption](path)` in its answer, with a file from its
workspace. The terminal UI draws it (see [tui.md](tui.md)); pine's base prompt tells every agent
this. A picture from the web it downloads first and then shows the file. A video file is shown
the same way and can be played in the conversation.

Nothing in the system prompt changes from one turn to the next. That is deliberate: a model
server keeps what it has already read (the prompt cache) only as long as the beginning of the
prompt is identical, and on a local model a miss means reading the whole conversation again
before the first word of the answer. What does change, pine puts in front of your message
instead, in a `<pine-note>`: the local time and date, the mode, whether its shell has network
access, the shared state listed in `state.inject`, and whether the session has to be careful
with outside content. The note is only added when something other than the time of day has
changed since the last one. Text that arrives from elsewhere cannot fake a note; the tag is
rewritten on the way in.

The bottom bar of the terminal UI shows `cache N%` after an answer: the share of the input the
model server took from its cache. In a running conversation it should be above 90%.

The details of how pine works are not in the prompt; they are in the manual, which the agent
reads when a question calls for it. That keeps the prompt short for small models.

Nothing from your own home folder leaks in: pi would normally also pick up `~/.agents/skills`
and instruction files in the folders above the workspace; pine filters those out. Edits to the
instruction files take effect on the agent's next task.

## Workspaces

Point `workspace` at the folder the agent should work in, typically an existing repository:

```json
{ "description": "The house: contracts, utilities, solar", "workspace": "~/dev/house" }
```

The agent's shell and file tools can read and write there and nowhere else in your home. Each
agent also has a private home folder (`sandbox/<id>/`), which is what `~` means inside its
shell. Agents cannot read each other's workspaces; they talk through `delegate`.

Two agents may share a workspace if you give them the same path. They can then overwrite each
other's files.

A single conversation can work somewhere else without any of this: `pine <folder>`, or the
folder in the bottom bar of the terminal UI, opens a folder of yours for that one conversation.
Its tools then start there and may change what is in it, and the folder's `AGENTS.md` applies
next to the agent's own. See [coding.md](coding.md).

## Sessions

A session is one conversation with history.

| You pass | What happens |
|---|---|
| nothing | The agent's `main` session: one long conversation, compacted by pi when it fills up |
| a name, for example `tg-123456` or `case-okapi` | A separate named conversation |
| `new` | A fresh conversation that is thrown away after the task |

Routes pick the session with `"session"`, the CLI with `--session`. Telegram chats use
`tg-<chat id>`. Runs started by untrusted events use a twin of the session with `~u` appended,
so they never see or extend your own conversation.

Tasks for one session queue up. With `"whenBusy": "steer"` on a route or Telegram account, a new
message is instead shown to the agent in the middle of what it is doing.

`pine reset <agent> [session]` (or `/reset` in the terminal UI or in Telegram) starts a session
over. The old history is kept on disk next to it with a `.reset-<time>` suffix for
`limits.eventRetentionDays`. What the conversation was subscribed to on its own ends with the
reset.

A named conversation does not stay for ever. One that is not an agent's `main`, not pinned, not
open in a tab of the terminal UI and not subscribed to an event source is removed with its
history after `limits.conversationDays` (7) without a message. That holds for every named
conversation: one you opened in the terminal UI, a Telegram chat's (`tg-<chat id>`), a
delegation thread's, one a route names. Pin the ones to keep (`/pin`, or the list of
conversations in the terminal UI; see [tui.md](tui.md)), or set `limits.conversationDays` to
`0` to keep them all. MCP servers and event sources that were set up for one conversation go
with it ([setup.md](setup.md)).

## Handing work to another agent

The `delegate` tool exists for an agent when its `delegates` list is not empty. The main agent
(`"main"` in `pine.json`) may delegate to everyone by default.

```json
{ "delegates": ["gonzo", "scout"] }
```

What the model sees:

```
delegate(agent, task, wait?, thread?)
```

- The other agent gets only the task text, prefixed with who sent it. It runs in its own
  workspace with its own tools and instructions.
- By default the caller waits and gets the answer as the tool's result.
- `wait: false` returns at once; the answer arrives later as a new message in the caller's
  session.
- Each delegation starts the other agent fresh. `thread: "okapi"` instead continues a named
  conversation with it, so it remembers earlier tasks of that thread.
- An agent already waiting further up the chain cannot be called again, and chains stop at
  `limits.maxDelegationDepth`. The model gets an error it can act on.

Write `description` for the delegating model: it is the only thing it knows about the other
agent. "Contract law; knows the case files in its workspace" works;
"Gonzo" does not.

## Sub-agents

`subagent(tasks: string[])` runs up to `subagents.maxParallel` copies of the same agent at once.
Each copy has the agent's workspace, instructions and tools but an empty conversation, cannot
delegate or spawn further, and returns only its final answer. Use it for searches and checks
that would otherwise fill the context:

> Find every clause about notice periods in `contracts/`. Use sub-agents, one per file.

A sub-agent works under the permissions of the conversation that started it: access you granted
there and your "always" answers apply to it, and what it is granted applies to the conversation.
It has the agent's MCP servers (unless `subagents.mcp` is `false`) and all its tools, or the
ones listed in `subagents.tools`.

Sub-agents count against the model slots. With fewer slots than sub-agents they queue; nothing
deadlocks, because the waiting parent lends out its own slot.

A sub-agent is a task like any other, with its own number and its own session, and its work can
be looked at while it runs and afterwards:

- In the terminal UI, the conversation shows a line when one starts and when it answers. A click
  on either opens a tab with what it was given, what it thought and wrote, and every tool call
  with the start of its result. `/task <id>` opens the same tab; the agent list (click the agent
  name in the bottom bar) lists the ones this conversation started.
- `pine tasks` lists them, `pine task <id>` shows the task and its result, and
  `GET /tasks/<id>/transcript` on the control API returns the steps.
- The session file itself stays in `agents/<id>/sessions/_tasks/<task id>/`.

The same works for a task that was delegated to another agent.

## Shared state

Small facts that several agents and routes need: who is home, the mode of the house, the state
of the printer.

- Routes write it: `"set": { "house/mode": "{{payload.value}}" }`.
- Agents read it with `state_get` and write it with `state_set`, within `state.read` and
  `state.write`.
- `state.inject` shows keys to an agent in every turn, always current, without growing the
  conversation:

```json
{ "state": { "inject": ["house/#"], "write": ["house/#"] } }
```

State values are shown to agents as facts, not as instructions, and are cut to 200 characters.
Do not route untrusted text into a key that agents see.

## What an agent's answer does

- The final text of a task is its result. If the task has a reply target, it is sent there.
- `NO_REPLY` as the whole answer sends nothing.
- A failed task (model error, timeout, cancelled) sends "`<agent>` could not finish: ..." to
  the reply target, so you are not left waiting.

## Checking on agents

```bash
bin/pine status
```

```bash
bin/pine tasks --agent gonzo
```

```bash
bin/pine events --topic "agent/#" -f
```

`pine task <id>` shows one task in full: prompt, result, error, trust, and statistics (turns,
tokens, which tools it called, how long it took).
