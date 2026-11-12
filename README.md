<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo-light.svg" alt="pine" width="360">
  </picture>
</h1>

```bash
npm install -g @pmndrs/pine
```

### PINE makes AI reactive

Most harnesses just do input chat: "Do this do that". And maybe a scheduler: "Do it tomorrow". In PINE agents react to any stimuli. From watching folders, commands, websites, ftp endpoints, webhooks, to any other event source. You can hook them up and let them react to and operate your physical devices in the house, or digital assets.

PINE of course also handles regular chat, coding, tasks and orchestration. Agents carry memory and so on. All the basic stuff is in there, too.

### Some design choices

- **Event-driven architecture:** Agents subscribe to events and react. An event source is just a `*.ts` service with a schema. Tell the agent what you want and they subscribe: "Watch ~/documents/scans, for every new file: extract summaries and payment details, if present"
- **No configs:** Tell the main agent what you want. It configures PINE, creates agents, MCPs, event sources, skills and schedules through administrative tool calls, never touches user config, never messes it up or breaks it.
- **Self-discovery:** A built-in BM25 instruction MCP lets agents look up any API or internal detail on demand, without carrying docs in context.
- **A CLI that feels like a desktop app:** Tabs, buttons, scroll regions, inline images and video, and drag-and-drop with thumbnails. Works in Kitty-protocol terminals like Ghostty, with fallbacks for older ones.
- **Built in:** Computer use, web browsing, coding tools, diffs and git.
- **Orchestration:** Agents can delegate, create sub-agents in parallel. A pinned tab simply persists an agent and its task. Name it, give it instructions, chat with it or subscribe it to events.

> [!IMPORTANT]
> pine runs on macOS and Linux; `pine init` sets up what it needs. Windows users can try [Docker](#docker). It remains open what exactly is necessary to make it run completely in Windows.

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

Sets everything up: the browser the web tools drive, and your user folder (`~/.pine`). On Linux
also the sandbox agents work in; it shows what it would install and asks once.

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

Connect your subscriptions, or local llm servers. Switch with `/model` in the UI:

```bash
pine login opencode-go
```

`pine login anthropic` and `pine login openai-codex` use a Claude or ChatGPT subscription. A
model server of your own (llama.cpp, vLLM, LM Studio) is added by its address, with
`pine model add studio http://127.0.0.1:8080`, or by asking the main agent. See
[operations.md](docs/references/operations.md) and [tui.md](docs/references/tui.md).

To work on a project, start it in that folder. The agent gets that folder for the
conversation, and `▤ code` (or `ctrl+g`) opens a pane with git changes and diffs, the files and
the output of its tool calls. `/undo` takes your last message back, with the files it changed
([coding.md](docs/references/coding.md)):

```bash
pine .
```

To get a newer version later, with whatever it needs:

```bash
pine update
```

## Docker

Agents run their commands in a sandbox, and a container may only make one when it is started
with the rights for it:

```bash
docker run -it --cap-add SYS_ADMIN --cap-add NET_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined -v pine:/root/.pine node:24 bash
```

| Part | What it is for |
| --- | --- |
| `--cap-add SYS_ADMIN` | lets the sandbox create its namespaces |
| `--cap-add NET_ADMIN` | lets a sandbox without network have its own loopback interface |
| `--security-opt seccomp=unconfined` | Docker's system call filter forbids the sandbox's change of root |
| `--security-opt apparmor=unconfined` | Docker's AppArmor profile forbids its mounts |
| `-v pine:/root/.pine` | keeps pine's home (configuration, conversations) when the container is replaced |

Inside, it is the same as anywhere:

```bash
npm install -g @pmndrs/pine
```

```bash
pine init
```

`pine init` installs what the image lacks (bubblewrap, the browser's system libraries) and says
so if a right is missing. With pine as an ordinary user in the container instead of root, add
`--security-opt systempaths=unconfined`. `--privileged` works in place of all of them.

## Documentation

Start at [docs/SKILL.md](docs/SKILL.md); it indexes everything.

| To do this                                                                              | Read                                                         |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Understand how the pieces fit                                                           | [overview.md](docs/references/overview.md)                   |
| Use the terminal UI                                                                     | [tui.md](docs/references/tui.md)                             |
| Work on a project: `pine .`, the code pane with git changes, files and tool output, `/undo` | [coding.md](docs/references/coding.md)                       |
| Install, run, use the CLI, run it as a service                                          | [operations.md](docs/references/operations.md)               |
| Write `pine.json` and `agent.json`                                                      | [configuration.md](docs/references/configuration.md)         |
| Let agents set things up by tool call instead of editing files                          | [setup.md](docs/references/setup.md)                         |
| Set up agents, delegation and sub-agents                                                | [agents.md](docs/references/agents.md)                       |
| Route events, schedules, model calls                                                    | [events.md](docs/references/events.md)                       |
| Event sources: Telegram, folders, MQTT, web addresses, commands, webhooks, FTP          | [sources.md](docs/references/sources.md)                     |
| MCP servers, web search, command tools                                                  | [mcp.md](docs/references/mcp.md)                             |
| Let an agent operate the apps on your Mac                                               | [computer.md](docs/references/computer.md)                   |
| Know what is protected and what is not                                                  | [security.md](docs/references/security.md)                   |
| Work on pine itself                                                                     | [AGENTS.md](AGENTS.md), [stack.md](docs/references/stack.md) |
