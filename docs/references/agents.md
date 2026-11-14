# Agents

An agent is a folder under `agents/` in pine's home. The folder name is its id (lowercase
letters, digits, `-`, `_`, starting with a letter or digit; `create_agent` wants a letter first
and 2 to 31 characters).

```
agents/gonzo/
  agent.json     settings (see configuration.md); {} is enough
  workspace/     where it works, and the files it keeps itself:
    AGENTS.md      its purpose and how it works
    SOUL.md        who it is: character and tone
    MEMORY.md      what should outlive a conversation
  skills/        its own skills, one folder each; the agent adds them with add_skill
  conversations/ what was set up for one conversation alone (its skills); made when needed
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

To change an agent later (its model, its tools, its reach, a folder it may use, its
instructions) or to remove it, ask the main agent as well: `update_agent` and `remove_agent`,
described in [setup.md](setup.md) under "Changing and removing an agent". Nobody has to edit
`agent.json` or delete a folder by hand.

## The files an agent keeps itself

An agent's instructions are files in its workspace, and the agent can write them. Together
with one file about you they are read into its prompt with every conversation:

| File | Holds | Who writes it |
|---|---|---|
| `workspace/AGENTS.md` | Its purpose and how it works. You shape it by telling the agent ("your purpose is ...", "from now on answer in tables") | The agent, and you |
| `workspace/SOUL.md` | Who it is: character and tone | The agent, and you. For another agent, the main agent: tell it how that agent should be or sound, and it replaces the file with `update_agent` (`soul`) |
| `workspace/MEMORY.md` | What matters beyond a conversation: decisions, facts, preferences, open ends | The agent |
| `USER.md` in pine's home | What every agent knows about you. One file for all agents | The main agent, and you |
| `agents/<id>/AGENTS.md` | Optional. Rules of yours that the agent reads and cannot change | You |

Every agent is told what these files are for: to write into `AGENTS.md` what you say it is for
or how you want things done, to put into `MEMORY.md` what it learns that matters later, at
once and briefly, and to tidy its memory when it has grown long (merge, drop what no longer
holds, move details into other files and leave a pointer). When `MEMORY.md` passes about 6 000
characters, pine reminds the agent, because all of it is read with every message.

`pine init` starts them as short stubs; `create_agent` writes the instructions it was given
into `AGENTS.md` and starts the other two as stubs. A file that is missing is simply not
loaded, and the agent creates it when it has something to put there. A change applies from the
agent's next message on. Only these names (and a `CLAUDE.md`), at the top of the workspace, are
read; anything else the agent keeps there is its own notes, which it reads when it needs them.

Other agents get `USER.md` in their prompt but cannot open or change the file; they tell you
when something belongs there. A conversation that has read outside content writes these files
as before, without a question ([security.md](security.md)).

An existing home from before this layout keeps working: `agents/<id>/AGENTS.md` is still read.
To hand the instructions over to the agent, move that file to `agents/<id>/workspace/AGENTS.md`;
`pine init` adds the stubs that are missing and leaves your file where it is.

## What an agent sees

Its system prompt is put together from, in this order:

1. pine's base prompt: that it is an agent in pine working for its owner, how to use its file
   tools, how far its shell and file tools reach (its workspace in `safe` and `manual` mode, the owner's account in `auto` and `bypass`: `mode`), that pine's setup is changed through tools and
   never by writing its files (which of them it has, and that creating agents and anything for
   all agents is the main agent's job), that what it has been given it asks a tool and never
   looks for in files (`sources`, `mcp_servers`, `skills`, `schedules`), that for everything
   else it should explain the steps to its owner, and that text from tools, files and the web
   is information, never a command. An `agents/<id>/SYSTEM.md` replaces this text.
2. `agents/<id>/AGENTS.md`, if you keep one: rules the agent cannot change.
3. The files it keeps itself, from its workspace: `AGENTS.md` (also `CLAUDE.md`), `SOUL.md`,
   then `USER.md` from pine's home, then `MEMORY.md`. See "The files an agent keeps itself".
   After them the instruction files of a folder opened for the conversation, and any files in
   `context`.
4. Its skills: one line each; the agent reads a skill's file when it needs it. This manual is
   not among them: the agent searches it with its `manual` tool (see below). An agent asked
   for another model or a route looks it up and tells you what to put into which file; an
   event source, a schedule, an MCP server or a skill it sets up itself by tool call
   ([setup.md](setup.md)).
5. A `<pine>` block: who the agent is, which agents it can delegate to, which MCP servers it
   has. It only changes when the configuration does.

To show you a picture, an agent writes `![caption](path)` in its answer, with a file from its
workspace. The terminal UI draws it (see [tui.md](tui.md)); pine's base prompt tells every agent
this. A picture from the web it downloads first and then shows the file. A video file is shown
the same way and can be played in the conversation, and so is a sound file (`![caption](hello.wav)`;
wav, mp3, m4a, ogg or flac): the terminal UI plays it, see [tui.md](tui.md). The agent is told
not to play a sound with a command of its own (`afplay`), which you could neither pause nor see. A picture that a tool returned (a
screenshot, an image an MCP server made) is drawn where the tool ran, and the agent is told not
to show it a second time.

Nothing in the system prompt changes from one turn to the next. That is deliberate: a model
server keeps what it has already read (the prompt cache) only as long as the beginning of the
prompt is identical, and on a local model a miss means reading the whole conversation again
before the first word of the answer. What does change, pine puts in front of your message
instead, in a `<pine-note>`: the local time and date, the mode, the model the agent runs on
(as `provider/id` with its name from `models.json`, so that an agent asked which model it is
says that one and does not guess), the folder opened for the
conversation, whether its shell has network access, the programs its commands left running,
the steps of its `todo` list that are still open, that its browser is a window on your screen
which you use too, a reminder when `MEMORY.md` has grown
long, the shared state listed in `state.inject`, and whether the session has to be careful
with outside content. The note is only added when something other than the time of day has
changed since the last one. Text that arrives from elsewhere cannot fake a note; the tag is
rewritten on the way in.

The details of how pine works are not in the prompt; they are in this manual, which the agent
searches when a question calls for it. That keeps the prompt short for small models.

### How tools are declared

Every tool an agent has is declared to the model with each request: its name, what it does and
what it takes. The main agent has about eighty tools, and declared one by one they are about
25 000 tokens, which a local model reads before the first word of a new conversation. So pine
declares them in **families** (`catalogue`), which is about 11 000:

- What nearly every task uses is declared by itself, with a short description: `read`, `bash`,
  `edit`, `write`, `grep`, `find`, `ls`, `download`, `delegate`, `subagent`, `todo`,
  `question`, `manual`, and the two web tools.
- Everything else is grouped. A family is one declared tool that takes an `action` and the
  arguments of that action, and its description has one line for each action.

| Family | Its actions |
|---|---|
| `pine_sources` | `sources`, `subscribe`, `unsubscribe`, `add_source`, `send`, `remove_source`, `publish_event`, and for the main agent `add_source_type`, `remove_source_type` |
| `pine_schedules` | `schedules`, `add_schedule`, `remove_schedule` |
| `pine_mcp` | `mcp_servers`, `add_mcp_server`, `remove_mcp_server`, and the three tools for a server's resources |
| `pine_skills` | `skills`, `add_skill`, `remove_skill` |
| `pine_agents` | The main agent's: `agents`, `create_agent`, `update_agent`, `remove_agent` |
| `pine_settings` | The main agent's: `settings`, `set_setting`, `routes`, `add_route`, `remove_route`, `add_model_server`, `remove_model_server` |
| `pine_other` | `request_access`, `stop_program`, `state_get`, `state_set` |
| One for each MCP server, named after the server (`browser`, `media`, `home_link`) | The server's tools under their own names (`browser_navigate`, `browser_click`) |

An action has the name its tool has everywhere in this manual. Where the manual says "call
`add_source`", an agent with families calls `pine_sources` with `action: "add_source"` and the
same arguments; a tool of an MCP server, `mcp__browser__browser_navigate` in the manual, is
`browser` with `action: "browser_navigate"`. Nothing else is different. The call is carried
out by the tool that is meant, so modes, approvals, an `approve` or `deny` list, plan mode and
the rules after outside content all see `add_source` or `mcp__browser__browser_navigate`, and
so does the terminal UI.

| Name | What it is |
|---|---|
| `catalogue` | In `agent.json`: `families` or `full`, for that agent. Not set: `defaults.catalogue`. |
| `defaults.catalogue` | In `pine.json`: how the tools of every agent that names nothing are declared. `families` (the default): grouped, as above. `full`: every tool by itself with its whole description, as before; about two and a half times as much to read at the start of a conversation. The main agent changes it with `set_setting`; it holds from the next start of pine. |
| `find_tools` | A tool every agent with families has. `names`: actions or a whole family. Answers with everything about them: each argument, its limits, examples. For the rare case that the line in the family is not enough. |

What keeps a short declaration from costing calls:

- The arguments of a family are typed, with the values an argument can take listed, so a model
  server that holds a model to the declared arguments (llama.cpp does) cannot be given an
  argument that does not exist.
- A call that is nearly right is carried out as meant: a name with capitals or spaces becomes
  the name it stands for, a number or a list written as text is read as one, `path` for a
  folder source's `dir`, a setting named by its last word, an action asked of the wrong family.
- A call with wrong arguments comes back with the whole description of that action, so the
  next call is right.

A run that an outside event started is declared its few tools as before, each by itself.
An `agents/<id>/SYSTEM.md` and a list in `tools` work with either setting.

### What the model server keeps

A model server keeps what it has read of a request, and reads only what is new in the next one,
as long as the next one begins the same. On a local model that is the difference between an
answer that starts at once and one that starts after the whole conversation was read again.
With families, pine builds every request so that its beginning does not change:

| Part of the request | Stays the same |
|---|---|
| The tools | Always in one order and with fixed wording, for every conversation of the agent. Nothing in a description names what changes (which agents there are, which sources): that is in the note. |
| The system prompt | pine's own text only, the same for every conversation of the agent, today and after a restart. |
| The instruction files (`AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`, a folder's) | They open the conversation as a first message of their own, in `<instructions>`, as they were when the conversation began. What is added to one later, the agent is told once, in the note in front of the next message ("New in your MEMORY.md since this conversation began"). A file that lost or changed lines is taken anew: that conversation is read again once, the tools and pine's text before it are not. |
| What changes (agents to hand work to, event sources to subscribe to, the time) | In the `<pine-note>` in front of a message, only when it changed. |

So a line the agent writes into `MEMORY.md`, an agent that is created or removed, a schedule,
a new MCP server for another conversation, and a restart of pine all cost nothing: the next
message is read on top of what the server has. What still costs a reading is what truly is
new: the first conversation after the model was loaded, a tool that was added to this
conversation, and a conversation that was compacted.

A llama.cpp server keeps one conversation in each of its slots (`-np`). pine asks the server
how many it has and names the slot with each request (`id_slot`):

- A conversation goes back to the slot it was in, also after a restart of pine.
- One that has none takes a slot pine filled for it (below), else an empty one, else the slot
  that is cheapest to read again. It never takes a slot in which a request is under way.
- A run started from outside is named a slot too, so that it does not take yours.
- When the server has kept nothing of a long conversation, it was started anew; pine then
  takes its other slots for empty as well.

Another kind of server is never sent a slot.

| Setting | Default | Meaning |
|---|---|---|
| `limits.warmSlots` | `true` | Filling idle slots. When pine has left a llama.cpp server alone for a moment, it has each slot that holds nothing read what a conversation of the agent that used the server last begins with: its tools, pine's text, its instruction files as they are now. The next new conversation of that agent, and a sub-agent, is given such a slot and has only its own message to be read. One slot at a time, only while no agent is at work with that model, and never when the model is not loaded (so it is never what loads a model). A filled slot is filled again when the instruction files changed. `false` turns it off. The main agent changes it with `set_setting`, at once. |
| `limits.warmAfterMs` | `3000` | How long the model server has to have been left alone before a slot is filled, in milliseconds. |

A sub-agent is declared exactly the tools and the text its conversation is declared, also the
ones that are not its to use (`subagent`, `delegate`, what only a conversation sets up): asked
for one of those it is told "You are a sub-agent: this is not yours to do." That way a
sub-agent begins with what the model server has read already, and only its task is new.

What pine cannot help:

- A server that is stopped and started again (a scheduler that makes room for another model)
  has read nothing. llama.cpp can save a slot and bring it back (`--slot-save-path`); a
  scheduler has to do that around the stop.
- With more conversations at work at once than the server has slots, one of them loses its
  place. Give the server at least as many slots as `limits.maxConcurrentRuns`, and one more
  if sub-agents are used a lot.
- A model that cannot go back part of the way in what it has read (llama.cpp says "forcing
  full prompt re-processing" in its log) reads a conversation from its beginning when it was
  pushed out of its slot. Slots are what prevents that.

The bottom bar of the terminal UI shows `cache N%` after an answer: the share of the input the
model server took from its cache. In a running conversation it should be above 90%.

### The manual tool

Every agent has a `manual` tool (not in a run that an outside event started). It holds the
whole of this manual, cut into small parts: one
for each heading, and one for each row of a table that describes a named thing (a
configuration key, a tool, a command, an option).

| Call | Answers with |
|---|---|
| `manual` `search: "<a few words>"` | The parts that fit best, each with its id and the sentence that matched. Several queries can be given at once, one thing each. |
| `manual` `read: "<id of a part>"` | That part in full; several ids at once. A long part comes in pages (the id with `@2`, `@3`). |
| `manual` with neither | The list of the manual's parts. |

A search is by words, not by exact wording. Words an agent or you would use and the manual
does not ("cron job", "reminder", "permission", "watcher") find the manual's own words through
a list of synonyms. A source type that was registered in this installation is found as well,
with its options. When nothing matches, the answer says so and suggests other words; it never
says that pine cannot do something.

`pine manual <words>` is the same search in a shell (without the source types registered in
an installation), and `pine manual --read <id>` reads a part: a quick way to see what an agent
would find. One call takes up to 6 queries and reads up to 8 parts.

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
Its tools then start there and may change what is in it, and the folder's `AGENTS.md` (or
`CLAUDE.md`) applies next to the agent's own. See [coding.md](coding.md).

## Sessions

A session is one conversation with history.

| You pass | What happens |
|---|---|
| nothing | The agent's `main` session: one long conversation, compacted by pi when it fills up |
| a name, for example `tg-123456` or `case-okapi` | A separate named conversation |
| `new` | A fresh conversation for that one task; it is not continued |

Routes pick the session with `"session"`, the CLI with `--session`. What you write on Telegram
arrives in the conversation that subscribed to the Telegram source. Runs started by untrusted
events use a twin of the session with `~u` appended,
so they never see or extend your own conversation.

Tasks for one session queue up. With `"whenBusy": "steer"` on a route, a new message is instead
shown to the agent in the middle of what it is doing: it reads it at its next step. The terminal
UI sends your own messages this way (`alt+enter` makes one wait its turn). A steered message
that the work did not get to read, because it ended or was stopped first, is answered next as
work of its own.

`pine reset <agent> [session]` (or `/reset` in the terminal UI) starts a session
over. The old history is kept on disk next to it with a `.reset-<time>` suffix for
`limits.eventRetentionDays`. What the conversation was subscribed to on its own ends with the
reset.

A named conversation does not stay for ever. One that is not an agent's `main`, not pinned, not
open in a tab of the terminal UI, not subscribed to an event source and without a schedule of
its own is removed with its history after `limits.conversationDays` (7) without a message. That holds for every named
conversation: one you opened in the terminal UI, a delegation thread's, one a route names. Pin the ones to keep (`/pin`, or the list of
conversations in the terminal UI; see [tui.md](tui.md)), or set `limits.conversationDays` to
`0` to keep them all. Everything that was set up for one conversation alone goes with it: its
event sources and subscriptions, schedules, MCP servers and skills ([setup.md](setup.md)).

## Goal mode

Normally an agent ends its turn and waits for your next message, also when the work is not
finished: "the first part is done, shall I go on?". With a goal it keeps working by itself.
You say once what should be reached, and pine calls the agent again each time it ends a turn,
until the objective is met:

```
/goal all tests in ~/dev/shop pass and the README says how to run them
```

That is typed in the terminal UI, in the conversation that should do the work. The objective
is sent as your message, and from then on:

1. The agent works and ends its turn, as always. That is one **round**.
2. pine asks a **judge** one question: is the objective met? The judge is a short model call
   without tools. It is shown your objective and the agent's last answer, and replies with one
   word and one line of reason.
3. `CONTINUE`: the agent is called again in the same conversation, with your objective and the
   note that it is not met yet. `MET`: the goal is done. `BLOCKED`: the agent needs something
   only you can give (a decision, a sign-in, an approval that was refused), and the goal stops
   until you have answered and typed `/goal resume`.

The conversation shows a line for each verdict with the judge's reason, and the status line
shows the round the goal is in.

| Command | What it does |
|---|---|
| `/goal <objective>` | Sets the goal of this conversation and starts on it. A goal that was there is replaced. At most 2000 characters: put details into a file and name the file. |
| `/goal` | Shows the goal and where it stands: the round, the last verdict and its reason. |
| `/goal pause` | No further rounds. A round that is running ends by itself; `esc` stops it at once. |
| `/goal resume` | Goes on with a goal that stopped: paused, blocked, at its limit, or called met too early. |
| `/goal clear` | Takes the goal off the conversation. |

A goal stops by itself, and says why, in these cases:

| What happened | What the goal does |
|---|---|
| The judge says "met" | It is done. `/goal resume` if you do not agree. |
| The judge says "blocked" | It stops. Answer what the agent asked, then `/goal resume`. |
| The judge gave no verdict (it did not answer in time, or not with one of the three words) | It is paused. No verdict never counts as "go on". |
| It has had its rounds | It stops after `limits.goalRounds` rounds (20). `/goal resume` gives it as many again. |
| Several rounds in a row ended "not met" without a single tool call | It is paused after `limits.goalIdleRounds` such rounds (3): the agent is going in circles. |
| You wrote a message of your own in the conversation, typed or through Telegram | It is paused, so that your message is not overruled by the next round. |
| You stopped the agent (esc, `/stop`), or a round failed | It is paused. |
| pine was stopped or restarted | It is paused. The goal itself is kept; nothing goes on unseen after a restart. |
| The conversation was reset or removed | The goal is gone with it. |

A goal belongs to one conversation and is kept in pine's store, so it is still there after a
restart. Only you set one: there is no tool for it, so an agent cannot give itself a goal, more
rounds, or a different objective. If your owner asks you, as an agent, to "keep going until it
is done", tell them to type `/goal` with what they want reached. Other programs use
`POST /agents/<id>/goal` of the control API ([operations.md](operations.md)).

The judge uses the model in `defaults.judge` if one is set, else the agent's own, and the
time limit `limits.goalJudgeTimeout`. It only decides
whether the agent is called again. What the agent may do in a round is decided as in any other
task, by its mode and the approvals ([security.md](security.md), "A goal goes on
in your name").

On a local model each round costs a full turn, and the judge's call pushes the agent's
conversation out of a model server's cache unless the judge has a model of its own
(`defaults.judge`). Say in the objective how to tell that it is reached ("the tests pass",
"the file exists and has all twelve entries"): the judge sees only the agent's answer, not the
files.

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

`subagent(tasks: string[])` runs up to `subagents.maxParallel` copies of the same agent at once
(4 unless the agent's `agent.json` says otherwise).
Each copy has the agent's workspace, instructions and tools but an empty conversation, cannot
delegate or spawn further, and returns only its final answer. Use it for searches and checks
that would otherwise fill the context:

> Find every clause about notice periods in `contracts/`. Use sub-agents, one per file.

A sub-agent works under the permissions of the conversation that started it: access you granted
there and your "always" answers apply to it, and what it is granted applies to the conversation.
It has the agent's MCP servers (unless `subagents.mcp` is `false`) and all its tools, or the
ones listed in `subagents.tools`.

A sub-agent is declared the same tools and text as its conversation, so that the model server
has read its beginning already ("What the model server keeps").

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
- `NO_REPLY` (or `SILENT`) as the whole answer sends nothing.
- A failed task (model error, timeout) sends "`<agent>` could not finish: ..." to the reply
  target, so you are not left waiting. A cancelled task sends nothing.

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
it. Files the instructions refer to (a script, a template) lie beside the `SKILL.md`.

### Ask the agent

> Remember how to do this: make a skill for filing invoices.

That is how something gets written down as a skill: the agent calls `add_skill` with a name,
the description and the instructions, and optionally a folder of its workspace whose files go
along. pine writes the skill; the agent has it from its
next message on. Asking again under the same name replaces it, and `remove_skill` deletes it.

Like an event source or an MCP server, a skill is for the conversation it was asked for in,
for the agent, or for all agents ([setup.md](setup.md)):

| Said | Who gets it | You are asked |
|---|---|---|
| "make a skill for this" in a side conversation | That conversation; it goes when the conversation is removed | No |
| the same in the agent's main conversation, or "for you as an agent" | Every conversation of that agent | Only from a side conversation |
| "for all agents" | Every agent. Only the main agent can do this | Yes |

A name is used once among everything that would stand beside the skill, so no conversation
ever has two skills of one name.

A skill is part of what an agent is told, like its `AGENTS.md`. It is therefore written by
pine, in pine's home where the agent reads but does not write. From a conversation that has
read outside content it is not written unseen: it is put to you first, with its
instructions. What is a fact and not a way of
doing something belongs into the agent's `MEMORY.md`.

### Put it there yourself

A folder with a `SKILL.md` in one of these places is a skill, with no entry anywhere:

| Folder | For |
|---|---|
| `~/.pine/skills/<name>/` | all agents |
| `~/.pine/agents/<id>/skills/<name>/` | that agent |

What lies in these two folders an agent can also replace (`add_skill` under the same name) and
remove (`remove_skill`), whoever put it there.

A skill that lies somewhere else is named under `skills` in `pine.json` (for all) or in an
`agent.json` (for that agent). Agents can use those and cannot replace or remove them.

A skill's name is lowercase letters, digits and single hyphens, at most 64 characters; `pine`
is taken. The description may have 1024 characters, the instructions 40 000. Files that go
along: at most 200 and 4 MB together, real files only (a link is refused).

`pine skills` lists every skill, whom it is for and where it lies. An agent lists its own with
its `skills` tool: the skills the conversation has, whom each is for, and those that only
another conversation of the same agent has ([setup.md](setup.md), "What an agent has").

## Checking on agents

```bash
pine status
```

```bash
pine tasks --agent gonzo
```

```bash
pine events --topic "agent/#" -f
```

`pine task <id>` shows one task in full: prompt, result, error, trust, and statistics (turns,
tokens, which tools it called, how long it took).
