# Sandbox and modes: one dial instead of three

Draft of 2026-11-12. It records what a comparison of pine with opencode and Claude Code found,
and the change that follows from it.

**State:** the four modes are implemented (see "What was built" at the end). The "smaller
changes" are not.

## What was found

| | pine today | Claude Code | opencode |
|---|---|---|---|
| OS sandbox | Always on; without one an agent gets no shell | Opt-in, off by default | None, by design |
| What it wraps | Shell, all six file tools, agent-added MCP servers | Shell commands only | n/a |
| Files outside the start folder | Main agent: whole account. Others: refused, owner asked | Asked, by a check in the harness | Allowed without asking |
| A model that reviews actions | After outside content; a few critical patterns always | In auto mode, every action that is not a read | None |
| In Docker | Needs `SYS_ADMIN`, `NET_ADMIN`, seccomp and AppArmor off | Sandbox optional | Nothing needed |

- The sandbox primitives (`sandbox-exec`, bubblewrap) are the same ones Claude Code uses. What
  differs is that pine's is mandatory and has no fallback.
- opencode's `SECURITY.md` calls its permission system "a UX feature", not isolation, and
  names Docker as the way to get a wall.
- pine's reviewer and Claude Code's auto-mode classifier are the same design: shown the
  owner's messages and the action, never a tool result; after 3 blocks in a row or 20 in all
  the owner is asked.

Measured on macOS, with the profiles pine builds itself:

| | Whole-account profile (main) | Workspace profile (other agents) |
|---|---|---|
| git, npm, curl, cargo, `gh` | work | no network; cargo broken (toolchain is in the owner's home); `gh` logged out; no git identity |
| `ps`, `top`, `sudo` | refused: macOS runs no setuid program inside any sandbox, also an allow-all one | refused |
| A program that applies a sandbox of its own | refused (`sandbox_apply: Operation not permitted`) | refused |
| pine's home | closed | closed |

So the whole-account profile closes pine's home and costs `ps`, `sudo`, nested sandboxes and
the bubblewrap dependency on Linux. `docs/references/security.md` already says that a program
the agent starts outside the sandbox reads pine's home anyway.

## The proposal

Today three settings together say what an agent may do: its mode (`manual`, `auto`, `bypass`,
`plan`), its scope (`sandbox.scope`: `account` or `workspace`) and `security.review`. The
proposal folds the sandbox into the mode, so that there is one dial:

| Mode | Sandbox | Asks the owner |
|---|---|---|
| `bypass` | off | never |
| `auto` | off | for critical actions; after outside content the reviewer checks what reaches out, sends or changes the agent's memory, as today |
| `safe` | on | for critical actions, and for what a call needs outside the sandbox (as today) |
| `manual` | on where there is one | for every change |

Defaults: `auto` for the main agent, `safe` for every other agent, and any agent can be
switched to `auto`. That is what the default scopes give today, minus the whole-account
profile.

How today's settings map:

| Today | Becomes |
|---|---|
| scope `account`, mode `auto` | `auto` |
| scope `workspace`, mode `auto` | `safe` |
| mode `manual`, either scope | `manual` |
| mode `bypass` | `bypass` |
| `"sandbox": false` | gone: that is `auto` or `bypass` |
| `sandbox.scope` | gone: the mode says it |

### What holds in every mode

1. **A run that outside content started is always sandboxed and has the reduced tool set**,
   whatever the agent's mode. (Today: "runs as auto, in the workspace scope".) On a machine
   without a sandbox it keeps the read-only tools with the path check in the daemon and never
   gets a shell, which is what happens today.
2. **Trust by origin, tool registration, taint and the gate do not change.** None of them
   depends on the OS sandbox.
3. **On a machine without a sandbox** (a container, a Linux without user namespaces) `safe`
   cannot be had. An agent whose mode nobody set, which is every newly created one, runs in
   `auto` there, and `pine check` says so: in a container the container is the wall. An agent
   that was set to `safe` by hand gets no shell, and `pine check` says why; it is not moved to
   `auto` silently. `bypass`, `auto` and `manual` work as everywhere. The README names the
   capability flags only for those who want `safe` inside a container.

### pine's home without the OS

In `auto` and `bypass` nothing of the OS keeps the agent's shell out of pine's home. What that
exposes: `.env`, `data/http-token` (who holds it can answer approvals and change modes),
`pine.json`, `agent.json`, extensions. What stands in instead:

- File tools: `checkPath`, in the daemon, as on a machine without a sandbox today.
- Shell: a command that names pine's home, the `pine` program or the control port is class
  `critical` with a fixed refusal, not a question. A pattern, so a net and not a wall.
- The reviewer's first hard rule ("reading or changing pine's own files") after outside content.

This is the same footing Claude Code (without its sandbox) and opencode stand on. It is weaker
than today, and it is the price of the whole proposal.

## What is gained and lost

Gained:

- `ps`, `top`, `sudo`, SwiftPM, Homebrew builds and other programs that sandbox themselves
  work for the main agent.
- Linux and Docker work out of the box for `auto`. bubblewrap, the AppArmor rule and the
  container flags are needed only for `safe`.
- One dial. `sandbox.scope`, the `open` and `open-restricted` profile variants, and most of
  `keepWide` go away.
- In `auto` the file tools need not start a process per call.

Lost:

- The OS no longer closes pine's home to the main agent (above). Rule 1 of `AGENTS.md`
  ("nothing an agent can write is ever executed or trusted by the daemon") then holds by the
  OS only in `safe`, `manual` and event-started runs.
- After outside content the instruction files and git hooks are no longer frozen by the OS in
  `auto`. File tools keep the path check; the shell is left to the reviewer.

## Why not remove the sandbox altogether, as opencode does

opencode is right for what it is: someone sits at it, and text from outside arrives only in a
task they started and watch. pine differs in three ways:

- Text arrives unattended (Telegram, webhooks, MQTT, watched folders) and starts runs.
- Agents persist. What an injection writes into memory or a schedule is there tomorrow.
- "Use Docker" fits a coding session with one repository mounted. The main agent is meant to
  act on the owner's real account, which a container takes away.

So the sandbox stays for the two cases where it is the only wall: event-started runs that
have more than the read-only tools, and agents that are to be kept inside one folder (`safe`).

## Smaller changes, independent of the above

1. **Reviewer model.** By default the agent's own model reviews. On a local model that is a
   second inference per action and pushes the conversation out of the server's cache. Default
   `security.reviewer` to a small separate model where one is configured.
2. **Telegram messages of the paired owner count as the owner's words** for the reviewer.
   Today they do not, so after a web search a task given on Telegram is blocked on every
   "only if you asked for exactly this" rule.
3. **`add_mcp_server` writes `approve: "tainted"` on every server** (`src/tools.ts:632`). A
   server that also `taints` then asks, or is reviewed, on every call after its first. About
   30 of the 39 approval prompts in the log of 10 and 11 November were one such server.
4. **The start folder.** An agent starts in its own workspace under pine's home, so every
   real task is "outside". Worth making the folder of a conversation more prominent.

## Where the code changes

| File | Change |
|---|---|
| `src/config.ts` | `Mode` gets `safe`; `sandbox.scope` and `"sandbox": false` are gone; defaults |
| `src/agents.ts` | `live.wide()` and `live.variant()` follow the mode: no jail in `bypass` and `auto`, a jail in `safe`, `manual` and every event-started run. `effectiveMode()` returns `safe` for a run from outside. The gate's order stays |
| `src/security.ts`, `src/sandbox-linux.ts` | The `open` and `open-restricted` variants go |
| `src/actions.ts` | Critical patterns for pine's home, the `pine` program and the control port |
| `src/computer.ts` | App control follows `auto` and `bypass` instead of the scope `account` |
| `docs/references/security.md`, `configuration.md`, `README.md`, `AGENTS.md` | Rules 1 and 2 reworded; the Docker section; the mode table |
| `test/` | Tests of the open profile; new ones that fail without the pattern guard on pine's home |

## Open questions

1. **`plan`.** It answers another question (whether anything is done yet) and fits no rung.
   Leaning: a toggle on top of any mode, not a fifth mode.
2. **What replaces `security.review: "ask"`** (lose the account after outside content until the
   owner says yes). It is the same as dropping from `auto` to `safe`. Leaning: one setting,
   "after outside content: review (default), drop to safe, or nothing".
3. **Does `bypass` still pause after outside content** (`bypassWhenTainted`)? Leaning: keep
   the pause; it is the one case where bypass meets a hostile page.
4. **The home folder in `safe`.** Today the owner's home is unreadable and `$HOME` is a
   private folder, which hides toolchains and git identity. An earlier idea was to make the
   owner's real home readable and read-only. Against it: programs write caches there (npm,
   cargo, pip), and an agent in `safe` that has web tools could then leak the owner's files
   instead of only its workspace. Leaning: leave `safe` as it is, since whoever needs the
   owner's toolchains now has `auto`, and open single folders with `sandbox.read`.
5. **The name `safe`.** It promises more than a sandbox gives. `sandbox` or `boxed` say what
   it is.

## Not checked

Nothing was run on Linux or in Docker. Claude Code's behaviour is from its documentation,
opencode's from its source at `f179e6e5` (and tag `v1.19.5` for the older defaults). Codex was
not looked at.

## What was built

The four modes as proposed, with these decisions on the open questions:

| Question | What was done |
|---|---|
| `plan` | Still a mode you pick, but it lies on top of a level: `AgentConfig.level` keeps the mode beneath it, which decides the sandbox while the agent plans |
| `security.review: "ask"` | Unchanged. For an agent in `auto` mode it now means "back into the sandbox until the owner says yes" |
| `bypass` after outside content | Still pauses, and paused it is `auto` |
| The home folder in `safe` | Unchanged |
| The name | `safe` |

Beyond the proposal:

- A shell without a sandbox is refused what is pine's own by `pineOwn` in `src/actions.ts`:
  paths in pine's home, plain writes into pine's program, the `pine` program, the control port.
  This holds in `bypass` too.
- `"sandbox": false`, `sandbox.scope` and `defaults.scope` are gone. A configuration that
  still has one does not load, and the error says which mode to set instead.
- A local MCP server that an agent in `auto` mode adds runs without a sandbox, with the
  owner's rights. Its dialog says so.
- In `auto` mode with `security.review: "ask"`, after the owner's yes, nothing keeps a shell
  command from instruction files or git hooks. The file tools still refuse them.
- `command` sources still run only in a sandbox, so they do not run in a plain container.
- App control goes to agents in `auto` and `bypass` mode only; `manual` no longer has it.

## After that: no reviewer

The reviewer was removed altogether on 2026-11-13. On a local model it cost a second model
call for every shell command after outside content, and it blocked ordinary work (saving a
file into the agent's own workspace, a note in its memory). What `auto` and `safe` do now:

- A critical action asks the owner, in every conversation; "always" covers that kind of action.
- After outside content, sending something out asks the owner.
- Everything else runs, the shell and the agent's own memory included.

Gone with it: `security.review`, `security.reviewer`, `security.reviewTimeout`,
`security.rules`, the one question about keeping the account (`"ask"`), the Blocked list in
the code pane and its two endpoints. The judge of goals has its own settings now:
`defaults.judge` and `limits.goalJudgeTimeout`. Of the "smaller changes" above, 1 and 2 no
longer apply.
