# The terminal UI

```bash
pine
```

opens a full-screen chat with your agents (`pine tui` is the same). If a daemon is already
running it attaches to it; otherwise it starts one inside the same process, logs to
`data/pine.log`, and stops it again when you quit. With the example home it also starts the
`claude -p` stand-in model when nothing else serves it, so a fresh `pine init` followed by
`pine` works without further setup, given Claude Code is installed and signed in.

```
 pine  1 main   2 main·notes ⠹  3 events                                   ← tabs
──────────────────────────────────────────────────────────────────────────
 what is on the front page of example.com?                                 ← you

 ● browser_navigate https://example.com                                    ← tool call, running
 ✓ browser_navigate https://example.com 1.2 s                              ← finished
   ↳ scout delegated task #8: summarise the page ▸ open                    ← work handed on; click to look at it
   ✓ scout delegated task #8 answered (3.4 s, 2 tool calls) ▸ open

 The page is IANA's placeholder for documentation examples ...             ← answer, streamed

 ⠹ working · 12s · 2 tool calls · 1 sub-task running · 2140↑ (92% cached) 96↓ · esc to stop
──────────────────────────────────────────────────────────────────────────
 /mo                                                                       ← input
──────────────────────────────────────────────────────────────────────────
 → model       [provider/id] — Show or switch this agent's model          ← command suggestions
 main · main · dev/claude-haiku · reasoning off · auto · context 12% · cache 94%      /help
```

## Mouse

Everything in the two bars reacts to a click.

| Click | What happens |
|---|---|
| A tab | It comes forward |
| The `×` after a tab's name | The tab closes. The conversation is kept; what it was subscribed to on its own ends (not for an agent's main conversation) |
| `+` at the end of the tab bar | A new conversation with the same agent |
| The agent name in the bottom bar | A list of agents; picking one opens its tab. Below them: the sub-agents and delegated tasks this conversation started; picking one opens its work |
| A `↳ ... ▸ open` line in the conversation | A tab with that sub-agent's or delegated task's work |
| The conversation name next to it | This agent's conversations, and "+ new conversation" |
| The model | The models you have credentials for |
| `reasoning <level>` | How much the model thinks before answering: off, minimal, low, medium, high, xhigh, max |
| The mode (`auto`, `manual`, `bypass`) | The three modes |
| A button in an approval dialog | Allow once, Always here, Deny or Later |
| Anywhere beside an open list or dialog | It closes (an approval stays open for later). The click does nothing else |
| A web address in the conversation | It opens in your browser |
| A picture | It is enlarged; a second click shrinks it again |
| A video's picture | It is enlarged or shrunk; playback carries on |
| `▶ play` / `‖ pause` under a video | Plays or pauses it. `▸ open in player` opens it in the system's player |
| `▸ load picture` in front of a web address | The picture at that address is fetched and shown |
| The `×` after an attached file | The file is removed again |

The lists are filtered as you type; `enter` picks, `esc` closes, and a click on an entry picks
it. The same lists open from the keyboard with `/agent`, `/sessions`, `/model`, `/reasoning` and
`/mode` without an argument.

The bar also shows `context 37%`: how full the conversation's context window is. It turns
yellow from 65% and red from 85%. Nothing needs doing when it fills up: pi summarises the older
part of the conversation by itself and carries on (the figure then drops). `/reset` empties it.
Next to it, `cache 94%` is the share of the last request that the model server took from its
prompt cache instead of reading it again; it appears once the server reports the figure. Both
are shown from the first answer on, and from the last one when you reopen a conversation.
The wheel scrolls the conversation.

Web addresses are always printed in full, also for a link an agent wrote as "[click here](...)":
what you see is what a click opens. A long address that wraps over several lines opens whole,
whichever line you click. Only `http` and `https` addresses open.

Because the UI uses the mouse, dragging over text selects and copies it through the UI. Hold
Option (Terminal, iTerm) or Shift (most others) while dragging to use the terminal's own
selection instead.

## Attachments

Drag files from Finder onto the terminal. They appear above the input:

```
 attached: contract.pdf 212 KB ×  site-plan.png 1.4 MB ×
```

and go out with your next message. `/attach <path>` does the same from the keyboard,
`/detach` removes them all, `/detach 2` the second.

What the agent gets: the files are saved into `inbox/` in its workspace, the message says which
files arrived, and images are also shown to the model directly if the model accepts images. Up
to 10 files of at most 20 MB each per message.

## Tabs

A tab is one conversation: an agent and a session. The first tab is the main agent's `main`
session. A dot next to a tab means something arrived while you were elsewhere, a spinner that
the agent is working, `!` that it waits for your approval.

| Do this | With |
|---|---|
| New conversation with the same agent | `ctrl+t` or `/new [name]` |
| Talk to another agent | `/agent <id> [session]` |
| Reopen an earlier conversation | `/sessions <name>` (`/sessions` lists them) |
| Next tab | `tab` while the input is empty |
| Go to tab n | `alt+1` ... `alt+9`, or `/tab n` |
| Close a tab | `ctrl+w` or `/close` (the conversation stays in the list; the last tab stays open) |
| Give a conversation, and its tab, another name | `/rename <name>` |
| Keep a conversation for good | `/pin`, or `pin` in the list |
| Watch everything that happens | `/events` |

**Tabs and conversations.** A tab shows one conversation. When you quit and start again, the
same tabs are open, in the same order, with the same one in front. Closing a tab does not end
its conversation: it stays in the agent's list (`/sessions`, or a click on the conversation's
name in the bottom bar) and opens again from there.

The list does not grow without end. A conversation is removed by itself, with everything said
in it, once nothing has been said in it for 7 days (`limits.conversationDays`; `0` keeps
everything). These stay however old they are: each agent's main conversation, a pinned one,
one that is open in a tab, and one that is subscribed to an event source. The list says for
each which it is: `pinned`, `open in a tab`, or `goes in 5 days`.

| In the list | Does |
|---|---|
| `enter`, or a click on a name | Opens the conversation in a tab |
| `pin` / `unpin` at the end of a row, or `ctrl+p` | Pins it, or takes the pin off. A pinned one has a `★` in front and comes first |
| `×` at the end, or `ctrl+x` | Removes it for good. It asks once more (`remove? ×`); the second click or key does it. A conversation that is working is not removed |

Removing cannot be undone: the history, what the conversation may do without asking and what
it listens to all go. A new conversation of the same name starts empty.

Opening a conversation shows its recent history. Messages that reach the same session from
somewhere else (Telegram, `pine send`, a route) appear in the tab as well.

## Commands

Type `/` and the list appears; keep typing to narrow it, `enter` runs the command.

| Command | What it does |
|---|---|
| `/help` | Commands and keys |
| `/new [name]` | New conversation in a new tab |
| `/agent [id] [session]` | Open a tab with an agent; without an id, choose from a list |
| `/sessions [name]` | Open one of this agent's conversations; without a name, choose from a list |
| `/tab <n>`, `/close` | Switch to, or close, a tab |
| `/rename <name>` | Another name for this conversation and its tab. Its history, pin and subscriptions go with it. Not for an agent's main conversation |
| `/pin`, `/unpin` | Keep this conversation however long it is unused, or let it go again |
| `/reset` | Forget this conversation and start fresh (also clears "has seen outside content") |
| `/stop` | Stop what the agent is doing |
| `/model [provider/id]` | Switch the agent's model. Without an argument, a list to search and pick from; or type a few letters after it: `/model deepseek` |
| `/reasoning [level]` | Set how much the model thinks before answering; without an argument, choose from a list. Saved like the model. A model that cannot reason ignores it |
| `/mode [manual\|auto\|bypass]` | Set how much this agent does without asking; without an argument, choose from a list |
| `/attach <path>`, `/detach [n]` | Attach files to the next message, or remove them |
| `/mcp`, `/mcp login [name]` | List the MCP servers with their state; sign in to a remote one through the browser. Without a name: the only remote server, or a list to choose from |
| `/status` | Model slots, running tasks, live sessions |
| `/sources` | Event sources: what can wake an agent, whether it runs, who is subscribed |
| `/subscribe [local\|agent\|global] <source> [what to do]`, `/unsubscribe [local\|agent\|global] <source>` | Wake on a source's events, or stop that. Without a scope it means this tab's conversation, and that subscription ends when the tab is closed. See [sources.md](sources.md) |
| `/tasks` | Recent tasks of this tab's agent |
| `/task <id>` | Open a tab on one task and see what it did, step by step. Meant for sub-agents and delegated tasks |
| `/events` | The live event log in its own tab |
| `/approve [id] [always]`, `/deny [id]` | Answer an approval request; `always` stops the question for the rest of the conversation |
| `/state [pattern]` | Shared state |
| `/emit <topic> [json]` | Publish an event as yourself |
| `/clear` | Clear the view (the conversation is kept) |
| `/quit`, `/exit` | Leave. The tabs open again at the next start |

A model you pick is saved as that agent's model (`model` in its `agent.json`) and is still set
after a restart. A mode is different on purpose: it lasts until the daemon restarts, so an agent
never comes back up in bypass unless its `agent.json` says so.

## Keys

| Key | Does |
|---|---|
| `enter` | Send |
| `shift+enter` | New line |
| `up` / `down` | Earlier inputs |
| `esc` | Stop the agent. While a list or dialog is open, it only closes that |
| `shift+tab` | Next mode for this agent: auto, manual, bypass (while the input is empty) |
| `pgup` / `pgdn`, mouse wheel | Scroll |
| `ctrl+c` | Clear the input; twice on an empty input quits |
| `ctrl+d` | Quit (while the input is empty) |

## Modes

The bottom bar shows the agent's mode; click it, press `shift+tab`, or use `/mode` to change it.

| Mode | What you will notice |
|---|---|
| `auto` | The agent works without asking. It asks when it wants something outside its sandbox ("read access to ~/dev/gonzo, reason: ...") or, after the conversation has read the web or other outside content, before it sends something out or acts on the world |
| `manual` | A dialog before every command, edit or message, until you answer "Always here" for that tool or server |
| `bypass` | No dialogs. The agent can read and change files anywhere in your account and use the network. Shown in red |

Bypass and outside content do not mix by default. If a conversation in bypass reads a web page
or another outside source, a yellow note appears, the bar shows `bypass (paused)`, and the agent
is back inside its sandbox. Choosing bypass in such a conversation asks you which you want: a
new, clean conversation in bypass (recommended), or bypass here anyway. The agent is told its
mode every turn, so it knows when something it refused earlier has become possible.

[security.md](security.md) has the exact rules.

## Approvals

When an agent wants to do something that needs your say (see [security.md](security.md)), a
dialog opens over the conversation with the agent, the tool and its arguments, and the reason.

| Key | Answer |
|---|---|
| `a` or `y` | Allow this once |
| `s` | Always here: allow, and do not ask again in this conversation about this MCP server (or this tool, such as `bash`). Not offered for actions you configured to ask every time |
| `d` or `n` | Deny |
| `esc` | Decide later; the status line keeps reminding you, and `/approve` or `/deny` answer it |

If Telegram is set up, the same request arrives there too; whichever answer comes first counts.

## How answers are drawn

An answer is markdown, and it is drawn, not shown as written:

| In the answer | On screen |
|---|---|
| A code block | A bar down its left side with the language above it, without the lines of backticks. Code in a language it knows is coloured (about 190 languages, by the name after the backticks) |
| A `diff` or `patch` block | Removed lines red, added lines green |
| A code block without a language | The same bar, no colours: guessing the language would colour plain text at random |
| A table | A grid. Columns follow the alignment of the table's second line (`---:` right, `:---:` centred); a `<br>` in a cell is a line break; cells wrap when the table is wider than the terminal |
| Headings | Bold and in colour, without their `#`; the first level is underlined |
| Lists, task lists, quotes, rules, links, bold, italic, strikethrough, inline code | As such |

Shown as written: other HTML tags and footnotes. A table too wide to fit even with one
character per column is shown as written too. Colours are the terminal's own sixteen, and
`NO_COLOR` turns them off.

## Pictures

Pictures are drawn in the conversation:

- pictures you attach to a message (drag a file onto the terminal, or `/attach`),
- pictures a tool returns: a browser screenshot, an image file the agent reads, an image from an
  MCP server,
- pictures the agent points at in its answer with `![caption](path)`, where the path is a file
  in its workspace (png, jpg, gif or webp).

How they look depends on the terminal. kitty, Ghostty and WezTerm get the real picture. Every
other terminal (Apple's Terminal, iTerm2, anything inside tmux) gets a thumbnail made of
coloured half blocks, two pixels per character. The half-block thumbnail and the conversion of
jpg, gif and webp use macOS's `sips`; on another system only png files show, and only on a
terminal with real pictures.

A terminal draws a real picture above all text. While a menu or a dialog lies over a picture or
a video, that one is therefore drawn with half blocks, so the menu is whole; the real picture
returns when the menu closes.

A thumbnail is at most 44 characters wide and 14 lines high. Click it to enlarge it, click again
to shrink it. Pictures are also there when you reopen a conversation and in a task's own tab.

A picture at a web address is not fetched by itself. The answer shows
`▸ load picture https://...` and the picture loads when you click that. The reason is the same
as for links: an address can carry information out, and an answer may repeat what a web page
told the agent to write.

**Video** works the same way: a video you attach, or one the agent points at with
`![caption](clip.mp4)` (mp4, mov or webm in its workspace, up to 100 MB). A video that arrives
while you are looking at the conversation starts playing by itself; one from earlier in a
conversation you reopen shows a still and waits. The line under it has the controls:

```
 ‖ pause · clip · 0:07 / 0:42 · no sound · click the picture to enlarge   ▸ open in player
```

- `‖ pause` / `▶ play`: click to pause and to go on. At the end it starts over from the still.
- The picture itself: click to enlarge, click again to shrink. It plays at the size it is shown
  in, and changing the size does not start, stop or rewind it.
- `▸ open in player` hands the file to the system's player, for full quality and sound.

Playback is ten frames a second, without sound. On kitty, Ghostty and WezTerm the frames are
real pictures (up to 480 pixels wide as a thumbnail, 720 enlarged); every other terminal gets
half blocks, as for pictures. One video plays at a time. Playing in place needs
`ffmpeg` (`brew install ffmpeg`); without it there is the still (from Quick Look) and the
player. A video at a web address waits for a click, like a picture.

All of this is display. The model is never sent the drawing; it gets the actual picture if it
can look at images, exactly as before.

## Sub-agents and delegated tasks

When an agent starts a sub-agent or hands a task to another agent, the conversation shows a
`↳` line for it, the tool calls it makes (indented), and a line when it answers. Its own
thinking and prose are not mixed into the conversation. To see them, click the line (or use
`/task <id>`): a tab opens with the task it was given in full, its thinking, what it wrote, and
every tool call with the start of the result. A running task is followed live, and `esc` in
that tab stops only that task. The tab is read-only; `ctrl+w` closes it.

## Models to try it with

The footer shows the model of the tab's agent.

| You have | Do |
|---|---|
| Claude Code installed | Nothing: the example home uses `dev/claude-haiku`, the `claude -p` stand-in. About five seconds per model call. |
| An OpenCode Zen or Go key | `pine login opencode` or `pine login opencode-go`, paste the key, then `/model opencode-go/deepseek-v4.1-flash` |
| A Claude or ChatGPT subscription | `pine login anthropic` or `pine login openai-codex` (signs in through the browser), then `/model` |
| A local llama-server | Edit `models.json`, then `/model local/<id>` |

`pine login` uses pi's own sign-in and stores the credential in `auth.json` in pine's home,
mode 600, where agents cannot read it. The key you type is not echoed.

## Notes

- The UI needs the control API (`http` in `pine.json`), because it is a client of the daemon like
  the other commands.
- Quitting an attached UI leaves the daemon running. Quitting an embedded one stops it; queued
  tasks run the next time a daemon starts.
- The UI is one of several ways in. Everything it does goes through the same events, tasks and
  approvals as Telegram or `pine send`.
