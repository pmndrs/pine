# Changing the setup: tool calls, not files

pine's configuration is a few small JSON files, and they stay small because agents never write
them. In every mode, bypass included, pine's home folder is closed to an agent's shell and file
tools. What an agent may set up, it sets up by calling a tool. The tool checks what it is given,
asks you where that matters, and writes exactly the lines that are needed; when the thing is
removed, those lines go again and nothing is left behind (no empty lists, no stale access).

Four things reach an agent from outside its conversation, and all four are set up the same
way, with the same three scopes:

- **Events**: what happens elsewhere wakes the agent ([sources.md](sources.md)).
- **Schedules**: the time wakes the agent, with a task ([events.md](events.md)).
- **MCP servers**: tools the agent can call ([mcp.md](mcp.md)).
- **Skills**: how something is done, written down once ([agents.md](agents.md)).

The main agent can set each of them up for one conversation, for itself, or for all agents.
Every other agent can do so for one conversation or for itself.

You can still edit the files yourself, and the `pine` command changes them for you. This page
is about what agents can do.

## Who can set up what

| What | For one conversation | For the agent | For all agents |
|---|---|---|---|
| An event source (folder, MQTT, web address, command, webhook, FTP, Telegram) | any agent (`add_source`) | any agent, when you say so | **only the main agent** |
| A subscription to a source | any agent (`subscribe`) | any agent, when you say so | **only the main agent** |
| A schedule | any agent (`add_schedule`) | any agent, when you say so | **only the main agent** |
| An MCP server, remote or local | any agent (`add_mcp_server`) | any agent, when you say so | **only the main agent** |
| A skill | any agent (`add_skill`) | any agent, when you say so | **only the main agent** |
| A new agent | | | **only the main agent** (`create_agent`) |
| Changing an agent, removing an agent | | | **only the main agent** (`update_agent`, `remove_agent`), you confirm every time |
| pine's settings | | | **only the main agent** (`set_setting`), you confirm every time |
| A route (a rule of your own) | | | **only the main agent** (`add_route`, `remove_route`), you confirm every time |
| Any of the first five rows, for another agent | | **only the main agent** (the same tools, with `agent`) | |
| A new type of event source (a program) | | | **only the main agent** (`add_source_type`), you confirm every time |
| A model server of your own (llama.cpp, vLLM, LM Studio, ...) | | | **only the main agent** (`add_model_server`), you confirm every time |

The main agent is the one `pine.json` names with `"main"`; without that entry it is the agent
called `main`, or else the first one. It is pine's administrator: what you want changed about
pine, you ask it for, and it does it with tools that check what they are given, instead of
you or an agent editing files. See "The main agent administers pine" below. The other agents do not have `create_agent`,
`update_agent`, `remove_agent`, `agents`, `settings`, `set_setting`, `routes`, `add_route`,
`remove_route`, `add_source_type`, `remove_source_type`, `add_model_server` or `remove_model_server`,
and they are refused when they ask for the global scope. Their instructions tell them who can do it, so
an agent you ask for something that is not its to do sends you to the main agent instead of
trying.

## Three scopes

| Scope | Who gets it | It lasts |
|---|---|---|
| **conversation** (`local`, the default) | The conversation it was asked for in, and the sub-agents that conversation starts. Other conversations of the same agent do not see it. | Until that conversation is removed (by you, or by itself when unused; see [tui.md](tui.md)). Subscriptions also end when its tab is closed or it is reset. |
| **agent** | Every conversation of that agent. A subscription wakes its main conversation. | Until it is removed. |
| **global** | Every agent. | Until the main agent or you remove it. |

When a conversation is removed, everything that was set up for it alone is removed with it:
its event sources and subscriptions, its schedules, its MCP servers and its skills. When it is
renamed, all of that follows it to the new name. What was set up for the agent or for all
agents is not touched by either.

"Connect this server", "watch that folder", "subscribe to it", "remind me at five", "make a
skill for this", said in any conversation, means that conversation. An agent passes a wider scope only when you say so in so many words ("for
you as an agent", "always"; "for all agents"). In an agent's main conversation there is no
difference between the first two: the main conversation is the agent.

## What you are asked

| An agent wants to | You are asked |
|---|---|
| Add an MCP server | Always, in every mode. The dialog names the server, its URL or its command, and who gets it. For a command it also says what the program will reach. |
| Add a source that opens something new (a folder outside its workspace, a broker, a port), is to be trusted as yours, or is for all agents | Yes, with what it will do in plain words. A folder inside its own workspace is not asked about. |
| Subscribe the conversation it is in | No. |
| Subscribe the agent as such from another conversation, or all agents | Yes. Deny it if you meant this conversation only. |
| End a subscription of its own agent | No. |
| Schedule something for the conversation it is in, or for itself from its main conversation | No. |
| Schedule something for the agent from another conversation, or for all agents | Yes, with the times and the task. |
| Add or replace a skill for the conversation it is in, or for itself from its main conversation | No. Its instructions are its own to write, as its `AGENTS.md` is. |
| Add or replace a skill for the agent from another conversation, or for all agents | Yes. The dialog shows the description and the instructions. |
| Remove a server, a source, a schedule or a skill that is the conversation's own | No. |
| Remove a server, a source, a schedule or a skill of the agent (from another conversation than its main one) or of all agents | Yes. |
| Create an agent | Always. The dialog shows its id, description, model, tools and instructions. |
| Register a new type of event source | Always, in every mode. The dialog says that it is a program, how long it is, what it imports and where the file is. |
| Take a source type out again | Yes. |
| End a subscription for all agents | No (the main agent only). |
| Add a model server | Always, in every mode: the address before any request goes there, and in a second dialog its key if it wants one. See "Adding a model server". |
| Remove a model server | Yes. |

In manual mode, and in a conversation that has read outside content, the questions that are
otherwise skipped are asked too (ending a subscription: in manual mode only).

In plan mode nothing is set up: every tool that adds, removes, subscribes or sends is refused
there without a question, and the agent says what it would set up. The tools that only list
(`sources`, `schedules`, `mcp_servers`, `skills`) work in every mode and are never asked about.

In a conversation that has read outside content two things are stricter, because what they
write is read back as instructions or runs as a program. `add_skill` is checked by the
reviewer like a write to the agent's memory ([security.md](security.md), "After outside
content: the reviewer"; with `security.review: "ask"` it shows you the skill instead).
`add_source_type` and `add_model_server` are refused: start a new conversation for it.

Runs with the reduced tool set, which outside events start through a route or a subscription
marked `separate`, have none of these tools, and neither have sub-agents.

## What an agent has

An agent cannot read pine's configuration: the files are closed to it. What it has been given
it asks a tool, one for each kind of thing. Each of these lists what the conversation has, whom
each thing is for (this conversation, the agent, all agents), and what only another
conversation of the same agent has. So "which MCP servers do you have", "which skills do you
have", "what are you subscribed to" and "what is scheduled" are answered by a tool call, never
by a guess and never by looking for a file.

| What you ask about | The tool that lists it |
|---|---|
| MCP servers: which are connected, which the agent has | `mcp_servers` |
| Skills: what the agent knows how to do | `skills` |
| Events: sources, and who is subscribed and woken | `sources` |
| Schedules: what happens at set times | `schedules` |

Which model the agent runs on is told to it with your message, so it needs no tool for that.

## The tools

| Tool | Does |
|---|---|
| **Events** | |
| `sources` | Lists the event sources this conversation can use and who is subscribed. |
| `add_source` `name` `type` `description` [`options`] [`scope`] [`note`] [`throttle`] [`own`] [`ask`] | Sets up a source; with a note it subscribes at once. `options` is an object with the options of the chosen type ([sources.md](sources.md)). `own: true` marks it as your own device or folder, whose events are trusted. `ask` names secret options that you are to type into the dialog. |
| `subscribe` `source` [`scope`] [`note`] [`when`] [`throttle`], `unsubscribe` `source` [`scope`] | Starts or ends being woken by a source. For `unsubscribe` the scope can also be `all`: everything the agent has on that source. |
| `send` `source` [`text`] [`data`] | Sends something out through a source that can send (Telegram, MQTT). |
| `remove_source` `name` | Stops a source, unsubscribes everyone from it and deletes it. For a watched folder, the read access that came with it goes too. |
| `add_source_type` `name` `file`, `remove_source_type` `name` | Main agent only. Registers a module the agent wrote as a new type of source, or takes one out. |
| **Schedules** | |
| `schedules` | Lists what is scheduled for the agent and when each is next due. |
| `add_schedule` `name` `task` + one of `cron`, `every`, `at`, `in` [`scope`] | Does the task at set times, every so often, or once. One that happens once removes itself. |
| `remove_schedule` `name` | Ends a schedule. |
| **MCP servers** | |
| `mcp_servers` | Lists the MCP servers this conversation has: whom each is for (this conversation, the agent, all agents) and whether its tools are in the agent's tool list (connected) or missing (it did not start, or it needs a sign-in). It also names servers that only another conversation of the agent has, which this one cannot use. This is how an agent answers "which MCP servers do you have": the configuration files are closed to it. |
| `add_mcp_server` `name` `url` or `command` [`secrets`] [`description`] [`scope`] | Proposes an MCP server: a remote one by its https `url`, or a local one by the line that starts it (one program with its arguments, nothing else). A local one runs inside the sandbox of the agent that uses it. `secrets` names the keys it needs; you type them into the dialog. A name can be used once. One exception: a server that only one conversation of the agent has is made the agent's by adding it again under its name with `scope: "agent"`, from that conversation or from another; you are asked, the new entry takes the place of the old one, and then all the agent's conversations have it. See [mcp.md](mcp.md). |
| `remove_mcp_server` `name` | Takes a server out again. A server that belongs to another conversation is removed there, or with that conversation. |
| **Asking, and keeping track** | |
| `question` `question` [`choices`] | Asks your owner one question when you cannot go on without their decision, with two to six short answers to pick from (the one you recommend first). They pick one in a dialog, or on Telegram with a button, or answer in their own words; you get the answer back as the tool's result. No answer is said plainly: go on with a reasonable assumption and say which. It changes nothing, so it also works in plan mode. Not for permission to act (that is asked by itself), and not there in a run your owner did not start |
| `todo` `items` | Your own list of the steps of a task that has several. Send the whole list every time, each step with a status: `pending`, `in_progress` (one at a time) or `done`. Your owner sees it in the conversation and in the status line ("step 2 of 5"), and with their next message you are shown what is still open, so you can pick the work up where it stood. It belongs to the conversation and goes when that is reset. An empty list clears it. At most 30 steps. Not there in a run your owner did not start |
| **Programs** | |
| `stop_program` [`id`] | Stops a program that one of the conversation's commands left running, such as a development server, or one the agent started in the background (`background: true`). Without `id` it lists them. Never asks: it only ends what the agent started. Only an agent with `bash` has it. See [coding.md](coding.md). |
| **Skills** | |
| `skills` | Lists the skills this conversation has and whom each is for (this conversation, the agent, all agents), and names skills that only another conversation of the agent has. This is how an agent answers "which skills do you have". |
| `add_skill` `name` `description` `instructions` [`files`] [`scope`] | Writes a skill; the same name in the same place replaces it. `files` is a folder in the agent's workspace whose contents go along. |
| `remove_skill` `name` | Deletes a skill in pine's own skill folders (`skills/`, `agents/<id>/skills/`, a conversation's), also one you put there by hand. A skill in a folder named under `skills` in a configuration file is yours to remove. |
| **Agents** | |
| `create_agent` `id` `description` `instructions` [`model`] [`tools`] | Main agent only. See below. Changing and removing one, and pine's settings: "The main agent administers pine". |
| **Model servers** | |
| `add_model_server` `name` `url` [`context`] | Main agent only. Adds a model server of your own by its address; pine asks the server for its models. See "Adding a model server". |
| `remove_model_server` `name` | Main agent only. Takes one out again, with the key pine keeps for it. Refused while an agent, the default or the reviewer uses one of its models. You are asked. |
| **Not setup: the other tools pine gives an agent** | |
| `request_access` [`path`] [`write`] [`network`] [`account`] `reason` | Asks you for access the conversation does not have: a file or folder outside the workspace (`path`; with `write: true` also to change it), the network from the shell (`network: true`), or its full rights back after you limited the conversation (`account: true`). You decide; a yes holds for the conversation until it is reset or pine restarts. pine's home is never granted. An agent does not have to call it: when a file tool or a shell command needs something outside, pine asks you the same question itself. See "When a call needs something outside" and "Modes" in [security.md](security.md). |
| `delegate` `agent` `task` [`wait`] [`thread`] | Hands a task to another agent and gets its answer. Only there when the agent's `delegates` list is not empty. See [agents.md](agents.md). |
| `subagent` `tasks` | Runs several copies of the agent side by side, one task each, and returns their answers. See [agents.md](agents.md). |
| `download` `url` `path` | Fetches a file from a web address into the workspace, byte for byte. It is how an agent gets a file that a remote MCP server made: by the link in the tool's answer, never by a file path from it. See "Downloads" in [security.md](security.md) and "Files and pictures from a remote server" in [mcp.md](mcp.md). |
| `publish_event` `topic` [`text`] [`data`] | Publishes an event on a topic of the agent's `publish` list. Without that list the tool is not there. See [events.md](events.md). |
| `state_get` `key`, `state_set` `key` `value` | Read and write shared state, within `state.read` and `state.write`. See "Shared state" in [agents.md](agents.md). |
| `manual` [`search`] [`read`] | Searches and reads this manual. See "The manual tool" in [agents.md](agents.md). |

The built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) are chosen with
`tools` in `agent.json`; the shell tool's `background` is described in [coding.md](coding.md).
The tools of MCP servers are in [mcp.md](mcp.md). A run that an outside event started has
`state_get` and what its `untrusted` profile lists, and none of the others.

Everything takes effect without a restart. An agent has new MCP tools and new skills from its
next message on, in the same conversation. After `add_mcp_server` that next message is pine's
own: the agent is called again at once and goes on with the new tools.

## Adding a model server

Tell the main agent: "add my llama server at http://100.64.0.7:8080 as studio". It calls
`add_model_server` with the name and the address, and then:

1. You are shown the address and confirm it. This is asked every time, in every mode: an agent
   that is given one of the server's models sends its whole conversation there. Until you say
   yes, no request goes to that address.
2. pine asks the server which models it has, how much context one request gets, whether it
   reads pictures and, for a model that thinks, which thinking levels it knows (from
   llama.cpp's `/props`; other servers say less).
3. If the server wants a key, a second dialog asks you to type it. It goes into `.env` as
   `PINE_MODEL_<NAME>_API_KEY`; the agent and its model never see it. A key the server does not
   accept is not kept.
4. The entry is written to `models.json`, and the models are there at once: choose one with
   `/model studio/<model>`, or have the main agent give it to a new agent.

Where a server does not say how much context its models get, the agent is told so and asks you
for the number. The name cannot be one a provider already has (`anthropic`, `openai`, ...), so
no stored key can be pointed at another address. You can do the same yourself with
`pine model add <name> <address>` ([operations.md](operations.md)); what is written is described
in [configuration.md](configuration.md), "models.json".

## Creating an agent

Ask the main agent: "create an agent that keeps my books". It calls `create_agent` with an id,
one line on what the agent is for, its instructions, and optionally a model and a list of
built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`; all of them by default).
What cannot work (a bad id, a name that is taken, an unknown tool or model) is said before you
are asked anything. After your yes:

```
agents/books/
  agent.json     { "description": "...", "tools": [...] }  and "model" if one was named
  workspace/
    AGENTS.md    the instructions; the new agent can change them itself from then on
    SOUL.md      a stub
    MEMORY.md    a stub
```

Nothing else is written into `agent.json`; every other setting is pine's default. The agent
exists at once: it is in the terminal UI's agent list (`/agent books`), `pine send books ...`
reaches it, and the main agent can hand it work with `delegate`. It starts with no MCP servers
and no event sources of its own, and sets those up itself when you ask it to.

## The main agent administers pine

The point of pine is that nobody has to edit its configuration, you included. The main agent
is the administrator: it has tools for everything that can be set up, each tool takes a few
named values and checks them, what it writes is read back through the same loader pine starts
with, and a change that does not load is undone. So a wrong value is an error message to the
agent, not a pine that does not start.

| What | Tools of the main agent |
|---|---|
| Agents | `agents` (list), `create_agent`, `update_agent`, `remove_agent` |
| What an agent has: event sources, subscriptions, MCP servers, skills, schedules | The tools every agent has for itself, with `agent` for another agent, and with `scope: "global"` for all agents |
| Types of event source, model servers | `add_source_type`, `remove_source_type`, `add_model_server`, `remove_model_server` |
| pine's settings | `settings` (list), `set_setting` |
| Routes: rules of your own in pine.json | `routes` (list), `add_route`, `remove_route` |

The ones only it has:

| Tool | Does |
|---|---|
| `agents` [`id`] | Lists the agents: what each is for, its model, reasoning, mode and reach, and what it has (conversations, event sources, MCP servers, schedules, skills, files in its workspace). With `id`, one agent in full, with its workspace and its instructions. Asks nobody. |
| `update_agent` `id` [`description`] [`instructions`] [`model`] [`thinking`] [`mode`] [`tools`] [`delegates`] [`scope`] [`network`] [`read`] [`write`] [`forget`] | Changes an agent's settings; only what is given changes. You see the change line by line and confirm it. See "Changing and removing an agent". |
| `remove_agent` `id` [`keep_files`] | Removes an agent for good, with everything it has. You see what goes and confirm it. See "Changing and removing an agent". |
| `settings` | Lists the settings it can change, with what is in force and what each means. Asks nobody. |
| `set_setting` `key` `value` | Changes one setting in `pine.json`; `"default"` takes the entry out. You see the old and the new value and confirm. See "pine's settings". |
| `agent`, `conversation` (parameters) | Every tool under event sources, MCP servers, skills and schedules above takes `agent`: the call is then done for that agent, as if it had made it in its main conversation. With `conversation`, for one of its conversations. See "The main agent administers pine". |

**For another agent.** "Add a schedule for books: every Monday at eight, sum up the week" is
one call of the main agent: `add_schedule` with `agent: "books"`. It is carried out by that
agent's own tool, under that agent's own rules, as if the agent had been asked in its main
conversation: the same checks, the same questions to you, the same entry in its `agent.json`.
The listing tools (`sources`, `mcp_servers`, `skills`, `schedules`) take `agent` too, which is
how the main agent sees what another agent has. Something that only one conversation of an
agent has is reached with `conversation` and its name. Taking something away from another
agent (`remove_source`, `remove_mcp_server`, `remove_skill`, `remove_schedule`, `unsubscribe`)
asks you every time, and the question says that the main agent asks.

**Not from a conversation that has read outside content.** `update_agent`, `remove_agent`,
`set_setting`, `add_route` and `remove_route` are refused there without a question to you: a web page that says "remove the
agent" or "switch the reviewer off" must not get as far as your approval dialog. A new
conversation, or `/reset`, does it.

## Changing and removing an agent

`update_agent` changes what is given and leaves the rest:

| Value | What it is |
|---|---|
| `description` | One line on what the agent is for |
| `instructions` | The whole new text of its `AGENTS.md`. It replaces the file, so the main agent reads the present text first (`agents` with `id`) |
| `model`, `thinking`, `mode` | Its model (`"default"` for pine's default), how much it reasons, and `manual`, `auto`, `bypass` or `plan` |
| `tools` | Its built-in tools, all of them: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |
| `delegates` | The agents it may hand work to, all of them; `*` is every agent |
| `scope`, `network` | How far its shell and file tools reach (`workspace`, `account`, `default`), and whether its shell may use the network |
| `read`, `write`, `forget` | Folders outside its workspace that it may read, or read and change, from now on; and folders to take away again. This is how a folder is opened for an agent for good |

You see every line of the change before it is made, with a note where it gives the agent more
(the account, the network, bypass mode). It holds from the agent's next message on. pine's own
folder, pine's code and another agent's workspace are refused as folders. `pine agent update
<id>` does the same from a shell, each value a flag (`--model`, `--tools`, `--scope`, ...); a
model change needs a running daemon, which checks the model exists ([operations.md](operations.md)).

`remove_agent` takes an agent out of pine, and nothing of it is left. You are shown what goes
with it: its conversations, event sources, MCP servers, schedules, skills, the routes that wake
it, and how many files lie in its workspace. After your yes:

- its work is stopped, and each conversation, source, schedule, server and skill is removed the
  way it would be removed one by one (a source stops, its secrets leave `.env`);
- the routes in `pine.json` that wake it are taken out, and they stop at once;
- the lists that name it are corrected: other agents' `delegates`, a server or source of all
  agents that was only for some;
- what pine stored under its name goes: its tasks, the outside-content marks and answers of
  its conversations, pins and open tabs, the recorded states of its folders, what its sources
  kept;
- its folder `agents/<id>` (workspace, conversations, skills) and its private home
  `sandbox/<id>` are deleted.

An agent of the same name made later starts from nothing. With `keep_files` the folder alone
is not deleted but moved to `removed/<id>-<time>` in pine's home, where nothing reads it. One
thing is left as it is: a workspace that you put outside pine's home, which is your folder.
What stays in any case is the past: the event log and pine's log name the agent where it
acted. The main agent cannot remove itself. `pine agent remove <id>` does the same from a
shell, with or without a running daemon ([operations.md](operations.md)).

## Routes

A route is a rule of your own in `pine.json`: when an event arrives, and a condition holds,
write shared state, ask a model once, publish another event, or wake an agent
([events.md](events.md)). Most wishes need none, because a subscription is a route pine makes
for you. The main agent has three tools for the ones you do want:

| Tool | Does |
|---|---|
| `routes` | Lists the routes: what each listens to, its condition, and what it does. Asks nobody. |
| `add_route` `name` `on` [`when`] [`agent` `prompt` `session`] [`set`] [`publish_topic` `publish_payload`] [`call_prompt` `call_system` `call_model`] [`throttle`] [`debounce`] [`trust`] | Adds a route. Each value is checked (a name that is free, an agent and a model that exist, JSON where JSON is wanted, a time, at least one thing to do, no topic that only pine publishes on). You see it line by line and confirm, and it acts from then on, without a restart. |
| `remove_route` `name` | Takes one out. You confirm; it stops at once. To change a route, remove it and add it again. |

`trust: "owner"` makes every event on the route count as your own words, which gives whoever
can cause such an event the agent's full tools. The question to you says so. Where a reply is
to go (`reply`), `whenBusy`, `priority` and `key` are not offered by the tool: write those in
`pine.json`. Like the other administration tools, the two that change something are refused in
a conversation that has read outside content.

## pine's settings

`settings` lists what `set_setting` can change, with what is in force:

| Setting | What it is |
|---|---|
| `defaults.model`, `defaults.thinking`, `defaults.mode`, `defaults.scope` | What an agent gets that does not say otherwise: model, reasoning, mode, reach |
| `defaults.bashTimeoutSec`, `defaults.taskTimeoutSec` | Seconds a shell call and a task may run. From the next start |
| `limits.maxConcurrentRuns` | How many agents work at the same time. From the next start |
| `limits.maxDelegationDepth`, `limits.maxDownloadMb` | How often a task is handed on, and the largest download |
| `security.review`, `security.reviewer`, `security.reviewTimeout` | What happens after outside content, and who reviews |
| `security.askAccess` | Whether pine asks you itself when a call needs something outside the sandbox |
| `security.taint`, `security.bypassWhenTainted`, `security.approvalTimeout` | How long outside content counts, whether bypass survives it, and how long a question to you waits (from the next start) |

A value is checked for what it has to be (a model that exists, one of a few words, a number in
a range, a time), you see the old and the new value, and where the new one gives something up
the question says so. `"default"` as the value takes the entry out of `pine.json`. Most
settings hold at once; the ones marked hold from the next start of pine, and the agent tells
you so. Not settable by any agent: the control API (address, port, token) and secrets.

## What is written

These are the only entries the tools make. A thing made for one conversation carries that
conversation's name as `session`, which is how pine knows whose it is and when to remove it.

```jsonc
// agents/main/agent.json after: a server and a schedule for the agent, a source and a subscription for the conversation "taxes"
{
  "description": "Your main agent",
  "mcp": { "notes": { "url": "https://mcp.example.com/mcp", "approve": "tainted" } },
  "sources": { "scans": { "type": "folder", "description": "what the scanner saves", "session": "taxes", "dir": "/Users/me/Scans" } },
  "sandbox": { "read": ["/Users/me/Scans"] },
  "subscribe": [{ "source": "scans", "note": "Say which document arrived.", "session": "taxes" }],
  "schedules": [{ "name": "brief", "cron": "30 7 * * 1-5", "task": "Prepare the morning brief." }]
}
```

Remove the conversation "taxes" and the source, the subscription and the read access are gone;
the file is as it was before, with the server and the schedule left. Rename the conversation and the entries
follow its new name.

A skill needs no entry at all. Where its folder lies says whom it is for:

```
~/.pine/
  skills/<name>/                                   all agents
  agents/<id>/skills/<name>/                       that agent
  agents/<id>/conversations/<session>/skills/<name>/   that one conversation
```

Each holds a `SKILL.md` and the files that went along. Agents read these folders and cannot
write them; pine writes them when `add_skill` is called. Removing a skill deletes its folder,
and the folders above it that it leaves empty. `pine skills` lists every skill with whom it is
for.

## What stays yours

The control API and its token, secrets in `.env`, a route's `reply`, local MCP servers that are to run
outside an agent's sandbox, the options of a server once it is added, and source types you
write yourself: these are changed in the files or with the `pine` command, and most need a
restart. Everything else the main agent changes for you. See [configuration.md](configuration.md),
[agents.md](agents.md), [mcp.md](mcp.md) and [sources.md](sources.md).
