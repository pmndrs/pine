# Working on pine

pine is an event-driven multi-agent daemon on top of the pi coding agent SDK. Read
[docs/SKILL.md](docs/SKILL.md) for the index of the documentation; this file covers what you need
to change the code.

## Commands

| Command | What it does |
|---|---|
| `npm test` | All tests against the scripted model server. About ten seconds. Run it after every change. |
| `npm run build` | Makes the npm package in `build/`: the sources compiled to JavaScript at the same paths, plus docs and examples. Node runs TypeScript directly in a checkout but not inside `node_modules`, so only the package is compiled. Code that names one of pine's own module files at run time uses `EXT` from `src/config.ts` (".ts" or ".js"). |
| `npm run release` | What the Release workflow runs on every push to `main` (`.github/workflows/release.yml`): works out the next version, builds, publishes to npm, and marks the release with a tag. `node scripts/release.mjs --dry-run` shows the version and checks the package without publishing. The checkout's `package.json` is marked private so that the sources are never published uncompiled. |
| `npm run check` | Type check (`tsc --noEmit`). |
| `npm run test:live` | End-to-end through `claude -p`, plus the real browser and, on a Mac, the real app control helper. Slow, uses a Claude plan and the network. Run it when you change prompts, tool descriptions, `src/dev/claude-model.ts`, `mcp/browser.ts`, `mcp/computer.ts` or `mcp/computer.swift`. The tests that operate TextEdit skip themselves unless the terminal app they run in has the Accessibility and Screen Recording grants. |
| `npm run baseline` | The 59 pi SDK checks in `baseline/`. Run it after upgrading pi. |
| `node src/cli.ts <command>` | The CLI without installing it. |

There is no build step. Node runs the TypeScript directly (the one compiled part, the app
control helper `mcp/computer.swift`, is built by pine on the Mac it runs on, on first use), so:

- only erasable syntax: no `enum`, no `namespace`, no constructor parameter properties;
- relative imports carry the `.ts` extension;
- `import type` for types.

## Layout

```
src/
  cli.ts            command line; the only file that calls process.exit
  pine.ts           startPine(): builds and wires everything, returns a handle with stop()
  config.ts         loads and validates pine.json, agent.json, .env; all defaults live here
  store.ts          SQLite: event log (Bus), shared state (State), private storage (Kv), tasks
  agents.ts         AgentManager: task queue, pi sessions, conversations, the policy gate, the download tool, context block
  tools.ts          the tools pine gives an agent: delegate, subagent, publish_event, send, request_access, state_get,
                    state_set, question, todo, stop_program, manual; the lists of what it has (sources, schedules,
                    mcp_servers, skills); and the setup tools (subscribe, unsubscribe, add_/remove_ source, source_type,
                    mcp_server, skill, schedule, model_server; create_agent)
  agent-admin.ts    create_agent: checks a proposed agent and writes its folder
  admin.ts          what only the main agent administers: a change to an agent (`checkAgentChange`), pine's settings
                    (`SETTINGS`), routes (`checkRoute`), and everything that goes with a removed agent (`eraseAgent`)
  security.ts       the sandbox's rules (macOS profile; `sandboxArgv` for either system), the level an agent works at (`levelOf`), path checks, approvals, redaction, configuration audit
  sandbox-linux.ts  the same rules as bubblewrap mounts; what a mount cannot forbid is removed after the command (`Guard`)
  sandbox-setup.ts  what `pine init` does on Linux: installs bubblewrap, the AppArmor rule and the browser's libraries after one yes
  sandbox-fs.ts     read/write/edit/grep/find/ls executed inside the sandbox (as they are, in a mode that has none)
  access.ts         what a call needs beyond its sandbox, found so that the owner can be asked: the paths a command
                    names (`reaches`), the system's reports of what a sandbox refused (`Denials`, macOS), a failed command's words
  sources.ts        event sources and subscriptions: starts a source on its first subscriber, turns a subscription into a route
  manual.ts         pine's manual made searchable: docs/ cut into parts, BM25 over them, synonyms; the `manual` tool and `pine manual`
  skills.ts         skills by tool call: where one lies says whom it is for (all agents, an agent, a conversation)
  source-types.ts   what a source type module declares: summary, options schema, plan()
  sources/          the built-in source types: folder, mqtt, webhook, ftp, telegram, http, command
  watching.ts       what the polling types share: picking a value, line differences, a page's text
  env-file.ts       sets and removes entries in .env (secrets of sources that agents set up)
  update.ts         `pine update`: brings pine up to date the way it was installed (git or npm) and fetches what the new version needs
  net.ts            address guard (no private ranges) and fetchToFile, used by the download tool and mcp/web.ts
  router.ts         routes: filter, debounce, set / publish / call / agent
  timers.ts         the scheduler: cron, intervals and one-offs; a schedule with a task wakes an agent
  goals.ts          goal mode (`/goal`): a conversation's objective, the judge that says whether it is met, the task that calls the agent again
  programs.ts       what a conversation's commands left running: found by process group, listed, stopped;
                    commands in the background: started, found again after a restart, seen to end
  background.ts     what an agent reads about commands in the background: the shell tool's words, the message when one has ended
  actions.ts        what a tool call is (`classify`), the protected paths, and what a shell without a sandbox is refused (`pineOwn`)
  computer.ts       app control: who gets the server (`computerSession`) and which app a call is about (`appTarget`); shared by the gate, classify() and the server
  workspace-view.ts what the code pane reads: git changes and diffs (git contained in a sandbox), folder listings, file text
  snapshots.ts      the state of a folder as a git tree in a git directory of pine's own: recorded, compared, restored
  undo.ts           taking back the owner's last message: turns and their steps, what waits for a redo, pi's session file
  http.ts           control API and webhooks
  limiter.ts        model slots with priority
  login.ts          `pine login`: pi's sign-in flows, stored in <home>/auth.json
  models.ts         pi's model runtime on pine's home; fills a "$NAME" key in models.json from .env;
                    model servers of the owner's own: asking one what it serves, adding and removing it
  mcp-config.ts     add/remove/list MCP servers in the files; runs pi's `mcp` CLI for state and OAuth sign-in
  tui/              terminal UI: app.ts (tabs, commands, rendering), client.ts (API + event stream), run.ts,
                    code-pane.ts (the pane beside a conversation: changes, files, tool output),
                    undo.ts (what the conversation says after /undo and /redo),
                    theme.ts (colours, markdown), highlight.ts (code colours),
                    picture.ts (pictures, video and sound: conversion with sips or ffmpeg, Kitty-protocol or half-block drawing, the system's player for sound)
  types.ts, util.ts shared types; topics, templates, filters, durations, logger
  dev/claude-model.ts   OpenAI-compatible server backed by `claude -p` (development only)
mcp/                bundled MCP servers (separate processes): web, browser, commands, computer; lib.ts is what they share
                    (computer.swift is the macOS helper of computer.ts: accessibility tree, mouse and key events, pictures; it decides nothing)
examples/home/      what `pine init` copies
test/               node:test files; support/harness.ts builds a temp home and a daemon
baseline/           pi SDK behaviour checks and their results; the mock model server lives here
docs/               SKILL.md index and references/
```

## What agents know about pine

An agent is told little about pine in its prompt and looks the rest up: its `manual` tool
searches `docs/` (`src/manual.ts`), cut into a part per heading and a part per table row that
describes a named thing. For a change this means:

- What an agent has to know to use a feature goes into `docs/references/`. What is not there,
  agents do not know. Do not put it into the base prompt instead.
- A thing with a name (a key, a tool, a command, an option) gets a row in a table whose first
  cell is that name in backticks. Such a row is found by the name alone.
- Words people use for it that the manual does not use go into `SYNONYMS` in `src/manual.ts`.
- `test/manual.test.ts` holds questions and the part that has to answer each. Add one for a new
  feature, in the words of somebody who does not know what it is called.

## Rules that keep it safe

These are invariants. A change that breaks one needs a test that shows why it is still safe.

1. **Nothing an agent can write is ever executed or trusted by the daemon.** Agents write only
   to their workspace, their sandbox home and temp. Extensions, `agent.json` and
   `pine.json` live elsewhere in pine's home, which the sandbox closes: in `safe` and `manual`
   mode, and in every run started from outside. In `auto` and `bypass` mode there is no
   sandbox (rule 2), and pine's home and code are kept from the agent by `checkPath` for the
   file tools and by `pineOwn` in `src/actions.ts` for the shell. `pineOwn` reads the command
   line: it is a net, said to be one in the manual, and not a wall. Do not widen what those
   two let through. Agents change
   configuration only through the setup tools in `src/tools.ts`. There are four things an
   agent can be given, each with the same three scopes (a conversation, the agent, all agents):
   events (`add_source`, `remove_source`, `subscribe`, `unsubscribe`), MCP servers
   (`add_mcp_server`, `remove_mcp_server`; `mcp_servers` lists them), skills (`add_skill`, `remove_skill`) and schedules
   (`add_schedule`, `remove_schedule`); the main
   agent also has `create_agent`, `add_source_type` and `remove_source_type`, and `add_model_server` and
   `remove_model_server`. What an agent has of the four it is told by a tool, never by a file:
   `sources`, `mcp_servers`, `skills`, `schedules`; a new kind of thing gets its list too. Each validates its input, writes only
   the entry it is for, and asks the owner where `docs/references/setup.md` says so. A server
   is a remote URL, or a command that runs where the commands of the agent that uses it run
   (`sandboxed`, set by `add_mcp_server` and wrapped where the session registers it): inside
   that agent's sandbox in `safe` and `manual` mode, with the owner's rights in `auto` and
   `bypass`, which the owner's dialog says. Never a program with the daemon's environment,
   and never through a shell. Global scope, agent creation and new source types are
   refused to every agent but the main one. Removing something must leave things as they were
   before it was added.
   The main agent is pine's administrator: besides `create_agent` it has `agents`,
   `update_agent`, `remove_agent`, `settings`, `set_setting`, `routes`, `add_route` and
   `remove_route` (`src/admin.ts`). An agent that is removed leaves nothing: `eraseAgent` is the
   one place that knows what carries an agent's name (routes, lists of others, secrets, stored
   keys, folders under `data/`, its folder and private home), for the tool, the control API and
   `pine agent remove` alike, and `test/admin.test.ts` looks for anything named after a removed
   agent. Whatever is added to pine that is kept by agent goes into `eraseAgent` too. Each change is
   a few named values that are checked one by one, never text into a file; it is put to the
   owner in every mode; the configuration is read back through `loadConfig` and the file put
   back if it does not load; and the ones that change something are refused in a tainted
   conversation without asking. A new setting gets an entry in `SETTINGS` with what a value has
   to be, never a way to write a key by name. For another agent the main agent uses the tools
   that agent has itself (`FOR_ANY_AGENT`, the end of `pineTools`): the call is handed to that
   agent's own tool with a stand-in for its conversation, so there is one implementation and
   one set of rules. Do not write a second road for "the admin does X to agent Y". What takes
   something away from another agent asks the owner in every case. A new kind of thing an agent can set up follows the same scopes and
   wording (`scopeOf`, `forWhom`, `whoIs` in `src/tools.ts`), not rules of its own.
   What an agent writes and pine reads back is text for its own prompt, never code or
   configuration: `AGENTS.md`, `SOUL.md` and `MEMORY.md` at the top of its workspace, and for
   the main agent `USER.md` in pine's home, the one file there an agent may write. A
   conversation of the owner's writes them also after it has handled outside content, and
   nothing checks what it writes there: the manual says so under "What is not solved"
   (`ownFiles` and `roots.ownOpen` in `src/security.ts` open exactly these files in the
   sandbox, and nothing else that is read as instructions). A run started from outside never does.
   Skills are instructions too, and need no configuration entry: where the folder lies says
   whom it is for (`src/skills.ts`). They are written by `add_skill` into pine's home, which
   the agent reads and cannot write. In a tainted conversation `add_skill` is put to the
   owner with its instructions, as `add_schedule` does with a task.
2. **The mode says whether there is a sandbox, and where there is one the OS enforces file
   access, not a path check.** One setting says how much an agent asks and how far it reaches
   (`Level` in `src/config.ts`): `safe` and `manual` work in the sandbox, `auto` and `bypass`
   without one, with the owner's whole account, in the owner's own conversations only
   (`live.wide()`, from `effectiveLevel()` in `src/agents.ts`). `plan` lies on top of a level
   (`AgentConfig.level`). A run started from outside is held to `safe` whatever the agent's
   mode. Do not add a second setting that decides the sandbox, and do not add another way to
   work without one.
   In the sandbox, shell commands and all six file tools run behind `sandboxArgv()`:
   `sandbox-exec` with the profile from `sandboxProfile()` on macOS, `bwrap` with the mounts
   from `bwrapArgs()` on Linux. A rule goes into both or into neither, and a helper that
   touches bytes from anywhere goes behind `helperArgv()`; nothing else names either program.
   What the OS enforces there depends on what the conversation has read: `live.variant()`
   picks the normal or restricted profile for each call, and access the owner granted with
   `request_access` is written into that session's profiles. `checkPath()` only produces a
   clear error early there; do not rely on it. Never add a tool that reads or writes files in
   the daemon process on a path the model chose.
   Without a sandbox (`live.variant()` is `open` or `open-restricted`, and the session's
   `jail` is an empty prefix) the same tools run as they are. pine's home and pine's code stay
   closed all the same, by `checkPath` and `pineOwn` (rule 1); after outside content the file
   tools refuse what is read as instructions, and nothing looks at the shell (rule 5).
   App control (`mcp/computer.ts`) is the same reach by another road: it acts in the owner's
   apps, outside any sandbox. So it follows the modes without a sandbox and adds nothing to
   them: `computerSession()` gives the server only to an agent in `auto` or `bypass` mode, in
   the owner's own conversations, and the gate refuses it where `live.wide()` is false.
   A conversation that has read outside content keeps what its mode gives it: outside
   content takes no reach away. What changes is what is asked (rule 5). A run started from
   outside never has any of it.
   On a machine without a sandbox `safe` cannot be had. `levelOf()` in `src/security.ts`
   gives an agent whose mode nobody chose `auto` there, and `audit()` names it; an agent that
   was set to `safe` gets no shell (the gate), and a run started from outside gets none
   (`profileFor`). Never start a shell for a run from outside where there is no sandbox, and
   never move an agent that was set to `safe` out of it.
   What a call needs beyond its sandbox, pine asks the owner for (`seek` in `coreExtension`):
   before the call for what a file tool is given or a command names (`reaches` in
   `src/access.ts`), after a command for what the system reports the sandbox refused it
   (`Denials`: a text of the command's own in the profile, read back from the macOS log). Both
   only find whom to ask and what to say. The answer is a grant like `request_access` gives
   (`live.grant`), which the sandbox enforces, or a no that is kept for the conversation
   (`AgentManager.refused`). Nothing they find allows or refuses a call by itself, a run
   started from outside is never asked about, and what no answer can open (pine's home, pine's
   code, another agent's files: `grantable`) is never put to the owner.
3. **Trust comes from where an event entered, never from what it says.** Out of the box three
   things publish `trust: "owner"`: a Telegram account the owner paired in pine (or listed), the
   authenticated control API, and a schedule. Everything else is `untrusted`
   unless the configuration opts in (`trust` on a route or on a source). A source type may vouch
   for its sender (`owner` in its plan), which the owner is told before confirming. `audit()`
   reports the opt-ins on routes and on sources other than Telegram. A schedule acts in the
   owner's name, so one made from a tainted conversation is always put to the owner with its
   task (`add_schedule`). Time is the scheduler's business (`src/timers.ts`): there is no timer
   source, and nothing else should fire on a clock of its own. Children
   inherit the weaker trust (`AgentManager.submit`).
   A goal (`src/goals.ts`) calls an agent again in the owner's name too. Only the owner sets,
   resumes or clears one, through the control API; there is no tool for it, and a run started
   from outside has none. The task that continues the agent holds the owner's objective and
   fixed text of pine's (`continuePrompt`), never a word of the agent's answer or of the
   judge's reason: the answer may repeat outside content, and the judge has read it. No
   verdict pauses the goal; it never counts as "go on".
4. **Untrusted runs get their capabilities by registration.** Tools and MCP servers that the
   untrusted profile does not list are not registered in that session at all, and the session
   key gets `~u` so history is never shared with the owner's session. The app control server
   is never registered for such a run, whatever the profile lists (`profileFor`).
5. **Every tool call passes `tool_call` in `coreExtension()`, and has a class.** That is where
   deny patterns, the bash time limit, path checks, taint marking and approvals happen.
   `classify()` in `src/actions.ts` is the one place that says what a call is (look, local,
   reach, send, own, critical, setup); the gate decides by class and mode. A new tool gets its
   class there, not a check of its own somewhere else: one that sends information out is
   added to the default `approveWhenTainted` list in `config.ts` (class `send`), one that only
   reads to `LOOK_TOOLS`. No model judges a call: pine has no reviewer, and
   none is to be added. What asks is the owner, and the list is short on purpose: a `critical`
   call in every conversation, a `send` call (and `subscribe`) after outside content, the
   owner's own `approve` list, and everything in manual mode. "Always here" is offered wherever
   the same question would come again; for a critical call it is kept by the kind of action
   (`action.note`), not for the whole tool. Do not make `reach`, `local` or `own` ask outside
   manual mode. A tool of the app control server has its class from `ctx.app`: looking is
   `look`, acting is `local`, so that a click is not asked about. What stands in for that is
   the owner's yes per app (rule 13); do not take one away without the other.
6. **Secrets stay in `.env`.** They are interpolated into the configuration and never exported to
   `process.env`; `shellEnv()` builds the environment for child processes from an allow-list.
   With the whole account it is the owner's own environment instead, without the daemon's
   variables and without anything whose name looks like a credential.
   Anything a source holds should be registered with `source.secret()` so it is redacted from
   events and logs. A secret an agent passes to `add_source` was typed into a conversation
   first: `SourceHost.add` redacts it from then on and scrubs it from stored events and tasks.
   The way that avoids this is the default: a tool leaves the secret out, the approval request
   lists it under `inputs`, and the owner's answer brings the value straight to the tool
   (`ApprovalDecision.values`, never in an event). A new tool that needs a secret does the same.
   A remote MCP server's `headers` are its key. Besides the server's own calls they go with one
   thing: a `download` of an address that one of that server's tools returned in the same
   conversation, as it was returned (`noteLinks` and `keyFor` in `coreExtension`). Not with an
   address the agent wrote itself, not along a redirect, and not for a server that `taints`.
7. **A source that sends decides where to.** Telegram sends only to the owner's chat; MQTT
   publishes only to `publish` topics. Do not move those checks into routes, prompts or the
   `send` tool. There is one way to connect pine to something outside, in or out: a source
   type in `src/sources/` with a schema. Do not add a second mechanism beside it.
   A type that has to go and look uses `source.poll` and `source.changed`, never timers of its
   own: the first look reports nothing, an unchanged look does nothing, a failed look backs off
   and shows in the status. A status line is read by agents without the outside-content mark,
   so it never repeats outside text (`harmless()` in `watching.ts`). A type that runs a command
   uses `source.exec`, which is the sandbox of the agent the source belongs to.
   A new type is a program inside the daemon: `add_source_type` is the main agent's, refuses in
   a tainted conversation, asks the owner in every mode, and runs the copy pine took, not the
   agent's file. Keep all four.
8. **Web access never reaches the local network.** The `http` source does only for an address
   the owner confirmed as local; a public one goes through `publicOnlyAgent`. `mcp/web.ts` checks addresses when it
   connects; `mcp/browser.ts` sends all browser traffic through its guard proxy and withholds the
   Playwright tools in `ALWAYS_BLOCKED`. When Playwright MCP is upgraded, list its tools again
   and add anything that runs code in the server or reads local files.
   The browser has no window unless the owner's conversation asks for one (`browser_show`,
   `browser_hide` in `mcp/browser.ts`): the daemon says which sessions may (`window`, set where
   the server is registered, never for a run started from outside), and the guard proxy and
   the blocked tools are the same with a window as without.
   The browser has one exception, and it is the owner's: when an agent itself opens an address
   that is local by its own name (`localTarget` in `src/net.ts`), the gate in `coreExtension`
   asks, and a yes allows that host and port for the conversation (`AgentManager.allowLocal`
   writes it into pine's home, where the guard reads it and no agent can write). Nothing a page
   reaches by itself is asked about, a run started from outside cannot ask, a name that needs a
   lookup cannot be allowed, and pine's control port is refused without a question.
9. **The terminal UI shows where a link goes.** Markdown is rendered with hyperlinks off, so a
   link's target is printed next to its text, and `Linked` makes only printed `http(s)`
   addresses clickable. Do not render agent output in a way that hides a link's target.
10. **The terminal UI is only a client.** It uses the control API like the CLI; it must not reach
   into the daemon, so that attached and embedded modes behave the same.
11. **Only the owner opens a folder for a conversation, and looking at one runs nothing.**
   `setFolder` in `src/agents.ts` is reached from the control API only; there is no tool for it.
   It refuses pine's home, pine's code and other agents' workspaces in either direction, and a
   run started by outside content does not get the folder. A task one agent hands to another
   (`delegate`, without a thread) is done in the conversation's folder for that one run
   (`TaskMeta.folder`); a conversation the other agent keeps never gets it that way. `src/workspace-view.ts` serves the
   code pane: every path is resolved and must stay inside the folder, and `git` runs behind
   `helperArgv()` without write access or network and with everything a repository's
   configuration could make it start turned off. Keep new git calls on that `git()` helper.
   Undo is the owner's in the same way (`AgentManager.undo` and `.redo`, `src/undo.ts`): the
   control API only, no tool, and only a message the owner typed is taken back
   (`ownerMessage`), never a run that outside content started. It is the one place where the
   daemon's side writes a folder. `src/snapshots.ts` records the folder as git trees in a git
   directory under `data/snapshots`, which no agent can write, and restores through the same
   `git()` helper with `write` naming that directory and the folder: the sandbox keeps it
   inside, not a path check. That git reads neither the folder's settings nor the owner's
   (`GIT_CONFIG_GLOBAL`), and its `info/attributes` turns off filters and text conversion. A
   restore sets only paths that two recorded trees differ in, through git, which does not
   write through a link. Taking a message back puts the conversation's outside-content mark
   and what the owner allowed it (`setRights`) back to what they were before that message,
   never to more.

12. **What an agent left running is found by the daemon, not reported by the agent.** Every
   shell command notes its process group before its sandbox starts (`Programs.note`, fixed
   text that runs with the daemon's rights: nothing an agent wrote goes into it), in a file in
   pine's home that no agent can write. A program is one of a conversation's when its group is
   on that conversation's list and the shell that led the group is gone. `stop` ends only such
   a group, for the control API and for the agent's `stop_program` alike: never a process id
   somebody names.
   A command the agent puts into the background (`background` on the shell tool) is started by
   the daemon itself (`Programs.start`): the shell that waits for it is fixed text (`WATCH`),
   the agent's command is one argument of the shell inside the conversation's sandbox, and the
   group is noted from what the system said at the start. While that shell lives the command
   counts as running, and it is known by its command line, which names the record pine keeps
   in its home. Its output is the agent's file: the daemon reads the end of it through the
   agent's sandbox (`tailOf` in `src/background.ts`) and hands it to the conversation as
   quoted output inside a message of pine's own (`endedNotice`), in a `notify` task, which is
   never taken for the owner's words. A run started from outside has no `background`
   (the gate refuses it), and on Linux neither has a conversation that read outside content:
   what `Guard` takes away after a command protects nothing while a command runs on.

13. **App control acts in the app that was named, and the owner said yes to that app.** The
   gate asks once per app in a conversation, by the name in the call (`appTarget` in
   `src/computer.ts`; the yes is kept in `AgentManager.grants`, like a local address of the
   browser). `mcp/computer.ts` makes the name true: a reference has to belong to that app, a
   position has to lie in one of its windows (`landsIn`), keys are sent to its process alone. It never
   clicks, types or presses in the app pine itself runs in, where the owner answers pine's
   questions. There is no list of forbidden apps, on purpose: do not add one. The helper only
   does what it is told; a check that decides who may do what belongs in `computer.ts`, where
   the tests reach it with a stand-in for the helper. On a system that is not macOS the server
   is not registered, and started by hand it offers nothing and says so.

## pi behaviours pine depends on

The baseline suite found these; each has a mitigation in the code. Re-check them when you
upgrade pi (`npm run baseline`, then `npm test`).

| pi behaviour | Where pine handles it |
|---|---|
| SDK sessions trust the project by default | `SettingsManager.create(..., { projectTrusted: agent.trustWorkspace })` in `agents.ts` |
| A stream that goes silent after its headers hangs | `installModelTimeouts()` in `pine.ts` |
| `session.dispose()` leaves MCP servers running | sessions are `AgentSessionRuntime`s; `dispose()` goes through the runtime |
| `mcp.json` is read from the global agent dir | `pi.registerMcpServer()` per session; `PI_CODING_AGENT_DIR` points into `data/pi`; `createMcpExtension({ loadConfig })` returns nothing, so no file there can add a server. `pine mcp login` writes a temporary `mcp.json` there for pi's CLI |
| Sessions default to the global agent dir | explicit `sessionDir` under `agents/<id>/sessions/` |
| bash has no default timeout | the gate caps `input.timeout` at `bashTimeoutSec` |
| bash ends a command at its timeout (`killProcessTree` in its `exec`) and cannot let go of one that is running: it owns the process and the pipes its output comes through | a command for the background never goes through pi's tool: `Programs.start` runs it, and the timeout message tells the agent to start it that way (`TIMEOUT_HINT`) |
| `AGENTS.md` is read once | `refresh()` reloads when a file's mtime changed |
| pi looks for instruction files in the working folder and the folders above it | `agentsFilesOverride` ignores what pi found and hands it `instructionFiles()`: the owner's `agents/<id>/AGENTS.md`, the agent's own `AGENTS.md`, `SOUL.md`, `MEMORY.md` (`WORKSPACE_FILES` in `src/config.ts`) and the home's `USER.md` |
| `prompt()` resolves on model failure | `execute()` inspects the last assistant message |
| A session opened from its file stands at the last entry written; `branch()` moves it in memory only | `rewind()` in `undo.ts` works on the closed session and appends an entry of pine's own (`pine-undo`, no message) at the place it went back to |
| Skills and `AGENTS.md` are discovered in the user's home and above the workspace | `skillsOverride` / `agentsFilesOverride` keep only configured locations |
| `tools: [...]` is a strict allow-list that hides extension tools | `excludeTools` for built-ins instead |
| The default system prompt describes a coding assistant inside pi and points at pi's manuals | `systemPromptOverride` supplies `BASE_PROMPT`; `docs/` is searched by every agent with the `manual` tool |

## Releases

Every push to `main` is a release. Its version follows from the commit messages since the last
one (`scripts/version.mjs`, tested in `test/release.test.ts`):

| A commit since the last release | Raises |
|---|---|
| has `BREAKING CHANGE` in its message, or `!` before the colon of its subject (`feat!: ...`) | the major number (the minor one while pine is below 1.0.0) |
| has a subject that starts with `feat:` or `feat(scope):` | the minor number |
| anything else | the patch number |

So an ordinary push is a patch release, and the subject line is how you say that it is more.
To pick a version by hand, set it in `package.json`: it is used as it is while it is ahead of
what the commits call for. A commit message that contains `[skip release]` publishes nothing.

Publishing needs no stored secret: on npmjs.com the package names this repository and
`release.yml` as a trusted publisher. A repository secret `NPM_TOKEN` is used instead if one exists.

## Tests

- Every test builds its own home in a temp folder with `harness()` and talks to the scripted
  model server from `baseline/tests/mock.mjs`. A prompt containing `<<MOCK {"steps":[...]}>>`
  scripts the model's next replies; `@@REF:name@@` refers to `mock.state.scripts[name]` (use it
  for child agents). Without a directive the model echoes.
- Do not put `>>` inside a directive (use `tee` instead of `>>` in shell commands); the directive
  ends at the first `>>`.
- Keep tests fast: no sleeps above a few hundred milliseconds, no network, no real model. Time
  limits accept fractions (`taskTimeoutSec: 0.25`).
- Test files run in parallel. Use port 0 and temp folders; never a fixed port or a shared path.
- UI tests type, click (`term.click(x, y)`) and drop files (`term.paste(path)`) on `FakeTerminal`
  and assert on `app.screen()`. Send keys one at a time
  (`term.type("text")` does) and wait with `sees()`, not with sleeps.
- `pine init` downloads the browser. A test that runs it sets `PINE_SKIP_DOWNLOADS=1` (see
  `test/cli.test.ts`); the variable exists for tests only and is not a user option.
- `npm test` passes `--test-force-exit`, so a leaked handle cannot hang the run; a test that
  fails must still not leave a daemon behind (see the `after` hooks in `test/support/harness.ts`).
- App control is tested on a stand-in for its helper (`FAKE_HELPER` in `test/computer.test.ts`),
  a script that speaks the helper's protocol and runs on any system; the server's `helper`
  option names it. No test in the ordinary suite touches a real app or needs macOS. The `live:`
  tests build the real helper and drive its own demo window (`--demo`), which needs no grant.
- A model call pine makes itself, without tools (the judge of goal mode), is scripted with the
  mock's `withoutTools` option: see `judged()` in `test/goals.test.ts`.
- pine's own question for what a call needs outside the sandbox (`security.askAccess`) is off in
  `harness()`, so that a test about the sandbox meets the sandbox and not a question. The tests
  about it (`test/access.test.ts`) turn it on, set `HOME` to a folder of their own for "the
  owner's files", and say what "the system reports" through a stand-in for the log (`standIn`).
- A new security property needs a test that fails without the code that provides it.

## Style

- Plain TypeScript, tabs, no framework. Prefer one clear function over an abstraction used once.
- Comments explain why, not what. Error messages say what to do next.
- Text an agent will read (tool descriptions, refusals, the `<pine>` block) is written for a
  small local model: short, concrete, no jargon.
- Nothing that changes from turn to turn goes into the system prompt (no clock, no counters):
  the model server's cache only covers a prompt whose beginning is unchanged, and on a local
  model a miss means reading the whole conversation again. Turn-dependent facts go into the
  `<pine-note>` that `contextNote()` puts in front of the incoming message. The two cache tests
  in `test/agents.test.ts` fail when a request stops being an extension of the one before; the
  mock's `prefixCache` option reports cached tokens the way a server would, and `strip` removes
  the notes from what the mock echoes.
- Permissions belong to a conversation, not to a session object: `Live.perm` is the key
  ("agent:session"), a sub-agent has its conversation's key, and `AgentManager.grants` and
  `.allowed` are looked up by it. Anything new that the owner can allow "for this conversation"
  goes there, so sub-agents get it and a reset clears it.
- Whatever the daemon writes on an agent's behalf goes into place through `sandboxExec`, never
  with `fs` on a path the agent chose: a path check in this process can be raced with a link.
- The UI shows what an answer points at, and answers can carry text from outside. It must never
  fetch a web address because an answer contains it (pictures load on a click), and endpoints
  that take a path from an answer serve only what they are for.
- A source only reports (`emit`); it never starts agent work itself. Waking an agent is the
  subscription's job, which is a route added at runtime (`SourceHost.route`). Keep new source
  types free of agent, session or prompt logic, and make them start nothing until `setup` runs:
  an unsubscribed source must cost nothing and listen to nothing.
- The approval gate lives in one place, the `tool_call` handler in `coreExtension`
  (`src/agents.ts`). Plan mode comes before all of it: a call that is not class `look` is
  refused there and never asked about. Before that, for a shell without a sandbox, what is pine's own
  (`pineOwn`) is refused in every mode, bypass included. Then the order: bypass, then what is configured to always ask, then
  what is critical, then what never asks (read-only tools, a remembered "always"), then manual
  mode, then what sends something out after outside content.
- Keep the documentation in `docs/references/` in step with behaviour changes, and add new
  files to the tables in `docs/SKILL.md` and `README.md`. Agents read these files to answer
  their owners' questions about pine, so a wrong sentence there becomes a wrong answer.
