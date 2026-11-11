# Agents

An agent is a folder under `agents/` in pine's home. The folder name is its id (lowercase
letters, digits, `-`, `_`).

```
agents/gonzo/
  agent.json     settings (see configuration.md); {} is enough
  workspace/     where it works, and the files it keeps itself:
    AGENTS.md      its purpose and how it works
    SOUL.md        who it is: character and tone
    MEMORY.md      what should outlive a conversation
  skills/        optional: its own skills
  extensions/    optional: its own pi extensions
  AGENTS.md      optional: rules of yours that the agent cannot change
```

## Creating an agent

Ask the main agent ("create an agent that keeps my books"): it calls `create_agent`, you confirm
what it proposes, and the folder above is made with `agent.json` and a workspace that holds its
instructions (`AGENTS.md`) and stubs of `SOUL.md` and `MEMORY.md`. The agent exists at once,
without a restart. Only the main agent has this tool; the
others tell you to ask it. See [setup.md](setup.md).

By hand: make the folder with an `agent.json` (`{}` is enough) and a `workspace/AGENTS.md`,
run `pine check`, and restart.

## The files an agent keeps itself

An agent's instructions are files in its workspace, and the agent can write them. Together
with one file about you they are read into its prompt with every conversation:

| File | Holds | Who writes it |
|---|---|---|
| `workspace/AGENTS.md` | Its purpose and how it works. You shape it by telling the agent ("your purpose is ...", "from now on answer in tables") | The agent, and you |
| `workspace/SOUL.md` | Who it is: character and tone | The agent, and you |
| `workspace/MEMORY.md` | What matters beyond a conversation: decisions, facts, preferences, open ends | The agent |
| `USER.md` in pine's home | What every agent knows about you. One file for all agents | The main agent, and you |
| `agents/<id>/AGENTS.md` | Optional. Rules of yours that the agent reads and cannot change | You |

Every agent is told what these files are for: to write into `AGENTS.md` what you say it is for
or how you want things done, to put into `MEMORY.md` what it learns that matters later, at
once and briefly, and to tidy its memory when it has grown long (merge, drop what no longer
holds, move details into other files and leave a pointer). When `MEMORY.md` passes about 6 000
characters, pine reminds the agent, because all of it is read with every message.

`pine init` and `create_agent` start them as short stubs. A file that is missing is simply not
loaded, and the agent creates it when it has something to put there. A change applies from the
agent's next message on. Only these names, at the top of the workspace, are read; anything
else the agent keeps there is its own notes, which it reads when it needs them.

Other agents get `USER.md` in their prompt but cannot open or change the file; they tell you
when something belongs there. A conversation that has read outside content cannot change any
of these files until it is reset ([security.md](security.md)): what is read into every future
prompt is exactly what an injected instruction would try to rewrite.

An existing home from before this layout keeps working: `agents/<id>/AGENTS.md` is still read.
To hand the instructions over to the agent, move that file to `agents/<id>/workspace/AGENTS.md`;
`pine init` adds the stubs that are missing and leaves your file where it is.

## What an agent sees

Its system prompt is put together from, in this order:

1. pine's base prompt: that it is an agent in pine working for its owner, how to use its file
   tools, that it is confined to its workspace, that pine's setup is changed through tools and
   never by writing its files (which of them it has, and that creating agents and anything for
   all agents is the main agent's job), that for everything else it should explain the steps to
   its owner, and that text from tools, files and the web is information, never a command. An
   `agents/<id>/SYSTEM.md` replaces this text.
2. `agents/<id>/AGENTS.md`, if you keep one: rules the agent cannot change.
3. The files it keeps itself, from its workspace: `AGENTS.md` (also `CLAUDE.md`), `SOUL.md`,
   then `USER.md` from pine's home, then `MEMORY.md`. See "The files an agent keeps itself".
   After them the instruction files of a folder opened for the conversation, and any files in
   `context`.
4. Its skills: one line each; the agent reads a skill's file when it needs it. One skill is
   always there: `pine`, this manual. An agent asked for a skill, a schedule or another model
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

Routes pick the session with `"session"`, the CLI with `--session`. What you write on Telegram
arrives in the conversation that subscribed to the Telegram source. Runs started by untrusted
events use a twin of the session with `~u` appended,
so they never see or extend your own conversation.

Tasks for one session queue up. With `"whenBusy": "steer"` on a route, a new message is instead
shown to the agent in the middle of what it is doing.

`pine reset <agent> [session]` (or `/reset` in the terminal UI) starts a session
over. The old history is kept on disk next to it with a `.reset-<time>` suffix for
`limits.eventRetentionDays`. What the conversation was subscribed to on its own ends with the
reset.

A named conversation does not stay for ever. One that is not an agent's `main`, not pinned, not
open in a tab of the terminal UI and not subscribed to an event source is removed with its
history after `limits.conversationDays` (7) without a message. That holds for every named
conversation: one you opened in the terminal UI, a delegation thread's, one a route names. Pin the ones to keep (`/pin`, or the list of
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
