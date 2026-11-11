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
| `npm run test:live` | End-to-end through `claude -p`, plus the real browser. Slow, uses a Claude plan and the network. Run it when you change prompts, tool descriptions, `src/dev/claude-model.ts` or `mcp/browser.ts`. |
| `npm run baseline` | The 59 pi SDK checks in `baseline/`. Run it after upgrading pi. |
| `node src/cli.ts <command>` | The CLI without installing it. |

There is no build step. Node runs the TypeScript directly, so:

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
  tools.ts          delegate, subagent, publish_event, request_access, state_get, state_set, and the setup tools
                    (add_mcp_server, remove_mcp_server, sources, subscribe, unsubscribe, add_source, remove_source, create_agent)
  agent-admin.ts    create_agent: checks a proposed agent and writes its folder
  security.ts       sandbox profile, path checks, approvals, redaction, configuration audit
  sandbox-fs.ts     read/write/edit/grep/find/ls executed through sandbox-exec
  sources.ts        event sources and subscriptions: starts a source on its first subscriber, turns a subscription into a route
  skills.ts         skills by tool call: where one lies says whom it is for (all agents, an agent, a conversation)
  source-types.ts   what a source type module declares: summary, options schema, plan()
  sources/          the built-in source types: folder, mqtt, webhook, ftp, timer, telegram, http, command
  watching.ts       what the polling types share: picking a value, line differences, a page's text
  env-file.ts       sets and removes entries in .env (secrets of sources that agents set up)
  net.ts            address guard (no private ranges) and fetchToFile, used by the download tool and mcp/web.ts
  router.ts         routes: filter, debounce, set / publish / call / agent
  timers.ts         schedules (cron and intervals)
  workspace-view.ts what the code pane reads: git changes and diffs (git contained in a sandbox), folder listings, file text
  http.ts           control API and webhooks
  limiter.ts        model slots with priority
  login.ts          `pine login`: pi's sign-in flows, stored in <home>/auth.json
  mcp-config.ts     add/remove/list MCP servers in the files; runs pi's `mcp` CLI for state and OAuth sign-in
  tui/              terminal UI: app.ts (tabs, commands, rendering), client.ts (API + event stream), run.ts,
                    code-pane.ts (the pane beside a conversation: changes, files, tool output),
                    theme.ts (colours, markdown), highlight.ts (code colours),
                    picture.ts (pictures and video: conversion with sips, Kitty-protocol or half-block drawing)
  types.ts, util.ts shared types; topics, templates, filters, durations, logger
  dev/claude-model.ts   OpenAI-compatible server backed by `claude -p` (development only)
mcp/                bundled MCP servers (separate processes): web, browser, commands
examples/home/      what `pine init` copies
test/               node:test files; support/harness.ts builds a temp home and a daemon
baseline/           pi SDK behaviour checks and their results; the mock model server lives here
docs/               SKILL.md index and references/
```

## Rules that keep it safe

These are invariants. A change that breaks one needs a test that shows why it is still safe.

1. **Nothing an agent can write is ever executed or trusted by the daemon.** Agents write only
   to their workspace, their sandbox home and temp. Extensions, `agent.json` and
   `pine.json` live elsewhere in pine's home, which the sandbox closes. Agents change
   configuration only through the setup tools in `src/tools.ts`. There are three things an
   agent can be given, each with the same three scopes (a conversation, the agent, all agents):
   events (`add_source`, `remove_source`, `subscribe`, `unsubscribe`), MCP servers
   (`add_mcp_server`, `remove_mcp_server`) and skills (`add_skill`, `remove_skill`); the main
   agent also has `create_agent` and `add_source_type`. Each validates its input, writes only
   the entry it is for, and asks the owner where `docs/references/setup.md` says so. A server
   is a remote URL, never a command. Global scope, agent creation and new source types are
   refused to every agent but the main one. Removing something must leave things as they were
   before it was added. A new kind of thing an agent can set up follows the same scopes and
   wording (`scopeOf`, `forWhom`, `whoIs` in `src/tools.ts`), not rules of its own.
   What an agent writes and pine reads back is text for its own prompt, never code or
   configuration: `AGENTS.md`, `SOUL.md` and `MEMORY.md` at the top of its workspace, and for
   the main agent `USER.md` in pine's home, the one file there an agent may write. A run that
   has handled outside content cannot write any of them (`isOwnFile` in `src/security.ts`).
   Skills are instructions too, and need no configuration entry: where the folder lies says
   whom it is for (`src/skills.ts`). They are written by `add_skill` into pine's home, which
   the agent reads and cannot write, and `add_skill` refuses in a tainted conversation.
2. **File access is enforced by the OS, not by a path check.** (What the OS enforces depends on
   the mode: `live.variant()` picks the normal, restricted or open profile for each call, and
   access the owner granted with `request_access` is written into that session's profiles.)
   In every variant pine's home and pine's code stay closed. Shell commands and all six file
   tools run through `sandbox-exec` with the profile from `sandboxProfile()`. `checkPath()` only
   produces a clear error early; do not rely on it. Never add a tool that reads or writes files in
   the daemon process on a path the model chose.
3. **Trust comes from where an event entered, never from what it says.** Out of the box four
   things publish `trust: "owner"`: a Telegram account the owner paired in pine (or listed), the
   authenticated control API, a schedule, and a `timer` source. Everything else is `untrusted`
   unless the configuration opts in (`trust` on a route or on a source). A source type may vouch
   for its sender (`owner` in its plan), which the owner is told before confirming. `audit()`
   reports the opt-ins on routes and on sources other than timers and Telegram. Children
   inherit the weaker trust (`AgentManager.submit`).
4. **Untrusted runs get their capabilities by registration.** Tools and MCP servers that the
   untrusted profile does not list are not registered in that session at all, and the session
   key gets `~u` so history is never shared with the owner's session.
5. **Every tool call passes `tool_call` in `coreExtension()`.** That is where deny patterns, the
   bash time limit, path checks, taint marking and approvals happen. New tools need no extra work
   to be covered, but a tool that sends information out should be added to the default
   `approveWhenTainted` list in `config.ts`.
6. **Secrets stay in `.env`.** They are interpolated into the configuration and never exported to
   `process.env`; `shellEnv()` builds the environment for child processes from an allow-list.
   Anything a source holds should be registered with `source.secret()` so it is redacted from
   events and logs. A secret an agent passes to `add_source` was typed into a conversation
   first: `SourceHost.add` redacts it from then on and scrubs it from stored events and tasks.
   The way that avoids this is the default: a tool leaves the secret out, the approval request
   lists it under `inputs`, and the owner's answer brings the value straight to the tool
   (`ApprovalDecision.values`, never in an event). A new tool that needs a secret does the same.
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
9. **The terminal UI shows where a link goes.** Markdown is rendered with hyperlinks off, so a
   link's target is printed next to its text, and `Linked` makes only printed `http(s)`
   addresses clickable. Do not render agent output in a way that hides a link's target.
10. **The terminal UI is only a client.** It uses the control API like the CLI; it must not reach
   into the daemon, so that attached and embedded modes behave the same.
11. **Only the owner opens a folder for a conversation, and looking at one runs nothing.**
   `setFolder` in `src/agents.ts` is reached from the control API only; there is no tool for it.
   It refuses pine's home, pine's code and other agents' workspaces in either direction, and a
   run started by outside content does not get the folder. `src/workspace-view.ts` serves the
   code pane: every path is resolved and must stay inside the folder, and `git` runs through
   `sandbox-exec` without write access or network and with everything a repository's
   configuration could make it start turned off. Keep new git calls on that `git()` helper.

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
| `AGENTS.md` is read once | `refresh()` reloads when a file's mtime changed |
| pi looks for instruction files in the working folder and the folders above it | `agentsFilesOverride` ignores what pi found and hands it `instructionFiles()`: the owner's `agents/<id>/AGENTS.md`, the agent's own `AGENTS.md`, `SOUL.md`, `MEMORY.md` (`WORKSPACE_FILES` in `src/config.ts`) and the home's `USER.md` |
| `prompt()` resolves on model failure | `execute()` inspects the last assistant message |
| Skills and `AGENTS.md` are discovered in the user's home and above the workspace | `skillsOverride` / `agentsFilesOverride` keep only configured locations |
| `tools: [...]` is a strict allow-list that hides extension tools | `excludeTools` for built-ins instead |
| The default system prompt describes a coding assistant inside pi and points at pi's manuals | `systemPromptOverride` supplies `BASE_PROMPT`; `docs/` is offered to every agent as the `pine` skill |

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
  (`src/agents.ts`). Order: bypass, then what is configured to always ask, then what never asks
  (read-only tools, a remembered "always"), then manual mode, then the taint rules.
- Keep the documentation in `docs/references/` in step with behaviour changes, and add new
  files to the tables in `docs/SKILL.md` and `README.md`. Agents read these files to answer
  their owners' questions about pine, so a wrong sentence there becomes a wrong answer.
