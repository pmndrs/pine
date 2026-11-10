# Changing the setup: tool calls, not files

pine's configuration is a few small JSON files, and they stay small because agents never write
them. In every mode, bypass included, pine's home folder is closed to an agent's shell and file
tools. What an agent may set up, it sets up by calling a tool. The tool checks what it is given,
asks you where that matters, and writes exactly the lines that are needed; when the thing is
removed, those lines go again and nothing is left behind (no empty lists, no stale access).

You can still edit the files yourself, and the `pine` command changes them for you. This page
is about what agents can do.

## Who can set up what

| What | For one conversation | For the agent | For all agents |
|---|---|---|---|
| A remote MCP server | any agent (`add_mcp_server`) | any agent, when you say so | **only the main agent** |
| An event source (folder, timer, MQTT, webhook, FTP) | any agent (`add_source`) | any agent, when you say so | **only the main agent** |
| A subscription to a source | any agent (`subscribe`) | any agent, when you say so | **only the main agent** |
| A new agent | | | **only the main agent** (`create_agent`) |

The main agent is the one `pine.json` names with `"main"`; without that entry it is the agent
called `main`, or else the first one. The other agents do not have `create_agent`, and they
are refused when they ask for the global scope. Their instructions tell them who can do it, so
an agent you ask for something that is not its to do sends you to the main agent instead of
trying.

## Three scopes

| Scope | Who gets it | It lasts |
|---|---|---|
| **conversation** (`local`, the default) | The conversation it was asked for in, and the sub-agents that conversation starts. Other conversations of the same agent do not see it. | Until that conversation is removed (by you, or by itself when unused; see [tui.md](tui.md)). Subscriptions also end when its tab is closed or it is reset. |
| **agent** | Every conversation of that agent. A subscription wakes its main conversation. | Until it is removed. |
| **global** | Every agent. | Until the main agent or you remove it. |

"Connect this server", "watch that folder", "subscribe to it", said in any conversation, means
that conversation. An agent passes a wider scope only when you say so in so many words ("for
you as an agent", "always"; "for all agents"). In an agent's main conversation there is no
difference between the first two: the main conversation is the agent.

## What you are asked

| An agent wants to | You are asked |
|---|---|
| Add an MCP server | Always, in every mode. The dialog names the server, its URL and who gets it. |
| Add a source that opens something new (a folder outside its workspace, a broker, a port), is to be trusted as yours, or is for all agents | Yes, with what it will do in plain words. A timer, or a folder inside its own workspace, is not asked about. |
| Subscribe the conversation it is in | No. |
| Subscribe the agent as such from another conversation, or all agents | Yes. Deny it if you meant this conversation only. |
| End a subscription of its own agent | No. |
| Remove a server or a source that is the conversation's own | No. |
| Remove a server or a source of the agent (from another conversation than its main one) or of all agents | Yes. |
| Create an agent | Always. The dialog shows its id, description, model, tools and instructions. |

In manual mode, and in a conversation that has read outside content, the questions that are
otherwise skipped are asked too (ending a subscription: in manual mode only). Runs with the
reduced tool set, which outside events start through a route or a subscription marked
`separate`, have none of these tools, and neither have sub-agents.

## The tools

| Tool | Does |
|---|---|
| `add_mcp_server` `name` `url` [`description`] [`scope`] | Proposes a remote MCP server (https). A local one, a program that runs with your rights, is yours to add: `pine mcp add`. |
| `remove_mcp_server` `name` | Takes a server out again. |
| `sources` | Lists the event sources this conversation can use and who is subscribed. |
| `add_source` `name` `type` `description` [`options`] [`scope`] [`note`] [`throttle`] [`own`] | Sets up a source; with a note it subscribes at once. `options` is an object with the options of the chosen type ([sources.md](sources.md)). `own: true` marks it as your own device or folder, whose events are trusted. |
| `subscribe` `source` [`scope`] [`note`] [`when`] [`throttle`], `unsubscribe` `source` [`scope`] | Starts or ends being woken by a source. For `unsubscribe` the scope can also be `all`: everything the agent has on that source. |
| `remove_source` `name` | Stops a source, unsubscribes everyone from it and deletes it. For a watched folder, the read access that came with it goes too. |
| `create_agent` `id` `description` `instructions` [`model`] [`tools`] | Main agent only. See below. |

Everything takes effect without a restart. An agent has new MCP tools from its next message on.

## Creating an agent

Ask the main agent: "create an agent that keeps my books". It calls `create_agent` with an id,
one line on what the agent is for, its instructions, and optionally a model and a list of
built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`; all of them by default).
What cannot work (a bad id, a name that is taken, an unknown tool or model) is said before you
are asked anything. After your yes:

```
agents/books/
  agent.json     { "description": "...", "tools": [...] }  and "model" if one was named
  AGENTS.md      the instructions
  workspace/     empty
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
// agents/main/agent.json after: a server for the agent, a source and a subscription for the conversation "taxes"
{
  "description": "Your main agent",
  "mcp": { "notes": { "url": "https://mcp.example.com/mcp", "approve": "tainted" } },
  "sources": { "scans": { "type": "folder", "description": "what the scanner saves", "session": "taxes", "dir": "/Users/me/Scans" } },
  "sandbox": { "read": ["/Users/me/Scans"] },
  "subscribe": [{ "source": "scans", "note": "Say which document arrived.", "session": "taxes" }]
}
```

Remove the conversation "taxes" and the source, the subscription and the read access are gone;
the file is as it was before, with the server left. Rename the conversation and the entries
follow its new name.

## What stays yours

An agent's built-in tools, model, plugins, skills, its sandbox settings, routes and schedules,
local MCP servers, and removing agents: these are changed in the files or with the `pine`
command, and most need a restart. See [configuration.md](configuration.md),
[agents.md](agents.md), [mcp.md](mcp.md) and [sources.md](sources.md).
