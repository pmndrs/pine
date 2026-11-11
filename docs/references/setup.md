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
| A remote MCP server | any agent (`add_mcp_server`) | any agent, when you say so | **only the main agent** |
| A skill | any agent (`add_skill`) | any agent, when you say so | **only the main agent** |
| A new agent | | | **only the main agent** (`create_agent`) |
| A new type of event source (a program) | | | **only the main agent** (`add_source_type`), you confirm every time |

The main agent is the one `pine.json` names with `"main"`; without that entry it is the agent
called `main`, or else the first one. The other agents do not have `create_agent` or
`add_source_type`, and they are refused when they ask for the global scope. Their instructions tell them who can do it, so
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
| Add an MCP server | Always, in every mode. The dialog names the server, its URL and who gets it. |
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

In manual mode, and in a conversation that has read outside content, the questions that are
otherwise skipped are asked too (ending a subscription: in manual mode only).

Two things are not asked but refused in a conversation that has read outside content, because
what they write is read back as instructions or runs as a program: `add_skill` and
`add_source_type`. Start a new conversation for them.
 Runs with the
reduced tool set, which outside events start through a route or a subscription marked
`separate`, have none of these tools, and neither have sub-agents.

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
| `add_mcp_server` `name` `url` [`description`] [`scope`] | Proposes a remote MCP server (https). A local one, a program that runs with your rights, is yours to add: `pine mcp add`. |
| `remove_mcp_server` `name` | Takes a server out again. |
| **Skills** | |
| `add_skill` `name` `description` `instructions` [`files`] [`scope`] | Writes a skill; the same name in the same place replaces it. `files` is a folder in the agent's workspace whose contents go along. |
| `remove_skill` `name` | Deletes a skill that was added by tool call. One you put there yourself is yours to remove. |
| **Agents** | |
| `create_agent` `id` `description` `instructions` [`model`] [`tools`] | Main agent only. See below. |

Everything takes effect without a restart. An agent has new MCP tools and new skills from its
next message on.

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

Agents are not removed by tool call: an agent's folder holds its workspace and everything said
to it. To remove one, stop pine and delete `agents/<id>`.

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

An agent's built-in tools, model, its sandbox settings, routes, local MCP
servers, source types you write yourself, and removing agents: these are changed in the files
or with the `pine` command, and most need a restart. See [configuration.md](configuration.md),
[agents.md](agents.md), [mcp.md](mcp.md) and [sources.md](sources.md).
