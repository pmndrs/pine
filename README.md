<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo-light.svg" alt="pine" width="360">
  </picture>
</h1>

<div align="center">
<code>
+ Opencode like CLI, everything's interactive + support for images, videos
+ OpenClaw automation, without the weight & complexity
+ PI coding agent for basic turns, auto compact and model providers
-------------------------------------------------------------------
= PINE
</code>
</div>
<br/>

```bash
npm install -g @pmndrs/pine
```

This is a small daemon that runs AI agents _reactively_. Some things it does very differently:

- **Letting agents react to external events**: chat, FTP, webhooks, MQTT, web addresses, schedules, etc. In a simple, modular way, and without configs. Agents can subscribe to any installed event source and react accordingly, or list available sources and unsubscribe. Event sources are simple to create, it's a \*.ts service with a schema. This allows you to create full automation workflows by just stating what you want: "watch my security cam, ring the alarm if someone enters while i'm away".
- **No configs**: you tell the (main) agent what you want. It operated through safe tool calls. Main agent can create other agents, global MCPs, event sources, skills, schedules, etc. Other agents can create these either for local conversations or their scope. No agent will touch or bypass into user config.
- **Discovery**: PINE ships a scripted BM25 instruction MCP, and a synonym thesaurus. All agents in it should know how it works in and out, and should be able to surface any api or internal detail.
- **A CLI that feels new**. Like a desktop UI. Interactive tabs, buttons, scroll regions. Images and videos are actually shown, formats markdown. Drag and drop files with real thumbails - and yes it's running in your shell (all Kitty shells, GHOSTTY et al, with lower quality fallbacks for old terminals).
- **All basics inbuilt**: computer use, tool calls, internet, browsing and operating live websites
- **Coding assistance**: diffs, output files, git integration, current folders ...
- **Orchestrating agents**, sub-agents, ... well, yes it does that. In an intuitive way. A pinned tab is a persistent agent. Create an agent, open a tab, rename it, tell it its basic instructions (these go into AGENTS.md), connect it to event sources, for instance Telegram if you want to chat abroad, pin it, close the tab if you want (you find it back in the running sessions), you're done.

> [!IMPORTANT]
> Until now this is macos (linux and docker in testing) only, due to some TUI specifics and sandboxing. Windows users can try docker. It remains open what exactly is necessary to make it run completely in Windows.

<br/>

<table>
  <tr>
    <td align="center" width="50%">
      <br />
      <img src="docs/images/meme.png" width="100%" alt="pine searches the web, downloads a picture and shows it in the terminal"><br/>
      <sub>Support for images</sub>
    </td>
    <td align="center" width="50%">
      <br />
      <img src="docs/images/video.gif" width="100%" alt="pine fetches a video from the web and plays it in the terminal"><br/>
      <sub>Support for videos</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <br />
      <img src="docs/images/drop.png" width="100%" alt="A picture dropped into the terminal, shown as a thumbnail, and the agent's answer about it"><br/>
      <sub>Drag and drop</sub>
    </td>
    <td align="center" width="50%">
      <br />
      <img src="docs/images/watch.png" width="100%" alt="Asked to watch a folder, the agent sets up an event source; a file changes, it wakes up and shows the git diff"><br/>
      <sub>Event sources (file watchers, ...)</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <br />
      <img src="docs/images/tabs.png" width="100%" alt="Tabs for several agents and conversations, with the list of conversations: pinned ones stay, the others clean themselves up"><br/>
      <sub>UI can be navigated by clicking</sub>
    </td>
    <td align="center" width="50%">
      <br />
      <img src="docs/images/flipper.png" width="100%" alt="pine drives a Flipper Zero through an MCP server"><br/>
      <sub>Support for MCPs and skills</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <br />
      <img src="docs/images/code.png" width="100%" alt="The code pane beside a conversation: the git diff of a file the agent just changed"><br/>
      <sub>Code assistance</sub>
    </td>
    <td align="center" width="50%">
      <br />
      <img src="docs/images/folder.png" width="100%" alt="pine started in a project folder: the agent inspects it, and the folder menu lists the folders a conversation can work in"><br/>
      <sub>Current folders</sub>
    </td>
  </tr>
</table>

<br/>

```
                  you:  terminal UI · Telegram
                               │
                               ▼
 wake it                 ┌───────────┐            it uses
 events ───────────────► │           │ ◄───────── MCP servers
   Telegram · MQTT · FTP │           │ ◄───────── skills
   webhooks · folders    │   agent   │
   web addresses         │           │
   commands · etc *      │           │
 schedules ────────────► │           │
   repeating · once      └─────┬─────┘
                               │  delegate ──► other agents
                               │  subagent ──► with distinct prompts, in parallel
                               ▼
                 answers · messages · actions

 Events, schedules, MCPs and skills can be set up by asking:
 for the current conversation, agent scope, or globally
 (main agent only) for all agents.

 * New event types that agents can subscribe to can be created easily.
```

## Quick start

Sets everything up: the browser the web tools drive, and your user folder (`~/.pine`).

```bash
pine init
```

Checks the setup: validates the configuration, lists each agent with its model, tools and MCP
servers, and prints security notes if something is open that should not be.

```bash
pine check
```

Opens the terminal UI. If no daemon is running, it starts one inside and stops it when you quit.

```bash
pine
```

Runs the daemon as a service, without the UI, so agents keep reacting to events with no terminal
open. `pine` then attaches to it. To have it start at login, see
[operations.md](docs/references/operations.md).

```bash
pine start
```

Connect your subscriptions, orlocal llm servers. Switch with `/model` in the UI:

```bash
pine login opencode-go
```

`pine login anthropic` and `pine login openai-codex` use a Claude or ChatGPT subscription; a
local llama-server goes into `~/.pine/models.json`. See
[operations.md](docs/references/operations.md) and [tui.md](docs/references/tui.md).

To work on a project, start it in that folder. The agent gets that folder for the
conversation, and `▤ code` (or `ctrl+g`) opens a pane with git changes and diffs, the files and
the output of its tool calls ([coding.md](docs/references/coding.md)):

```bash
pine .
```

To get a newer version later, with whatever it needs:

```bash
pine update
```

## Documentation

Start at [docs/SKILL.md](docs/SKILL.md); it indexes everything.

| To do this                                                                              | Read                                                         |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Understand how the pieces fit                                                           | [overview.md](docs/references/overview.md)                   |
| Use the terminal UI                                                                     | [tui.md](docs/references/tui.md)                             |
| Work on a project: `pine .`, the code pane with git changes, files and tool output      | [coding.md](docs/references/coding.md)                       |
| Install, run, use the CLI, run it as a service                                          | [operations.md](docs/references/operations.md)               |
| Write `pine.json` and `agent.json`                                                      | [configuration.md](docs/references/configuration.md)         |
| Let agents set things up by tool call instead of editing files                          | [setup.md](docs/references/setup.md)                         |
| Set up agents, delegation and sub-agents                                                | [agents.md](docs/references/agents.md)                       |
| Route events, schedules, model calls                                                    | [events.md](docs/references/events.md)                       |
| Event sources: Telegram, folders, MQTT, web addresses, commands, webhooks, FTP          | [sources.md](docs/references/sources.md)                     |
| MCP servers, web search, command tools                                                  | [mcp.md](docs/references/mcp.md)                             |
| Know what is protected and what is not                                                  | [security.md](docs/references/security.md)                   |
| Work on pine itself                                                                     | [AGENTS.md](AGENTS.md), [stack.md](docs/references/stack.md) |
