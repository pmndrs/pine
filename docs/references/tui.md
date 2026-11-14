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
 pine  1 ★ main ×  2 main·notes × ⠹  3 events ×  +                 ▤ code  ← tabs, and the code pane's button
──────────────────────────────────────────────────────────────────────────
 what is on the front page of example.com?                                 ← you

 ▸ 2 tool calls so far · browser_navigate · delegate · 1 thought · click to see all  ← this turn's work; click to open
 ▸ thought for 6s · click to read                                          ← what the model thought; click to open
 ✓ browser_navigate https://example.com 1.2 s                              ← tool call, finished
 ● delegate scout                                                          ← tool call, running
   ↳ scout delegated task #8: summarise the page ▸ open                    ← work handed on; click to look at it
   ✓ scout delegated task #8 answered (3.4 s, 2 tool calls) ▸ open

 The page is IANA's placeholder for documentation examples ...             ← answer, streamed

 ⠹ working · 12s · 2 tool calls · 1 sub-task running · 2140↑ (92% cached) 96↓ · ↑ 1.4k t/s ↓ 42 t/s · esc to stop
──────────────────────────────────────────────────────────────────────────
 /mo                                                                       ← input
──────────────────────────────────────────────────────────────────────────
 → model       [provider/id] — Show or switch this agent's model          ← command suggestions
 main · main · no folder · dev/claude-haiku · reasoning off · auto · context 12% · ↑ 1.4k t/s ↓ 42 t/s      /help
```

`pine .` or `pine <folder>` opens the same UI with one more tab: a conversation that works in
that folder. That, and the pane that shows git changes, files and tool output beside a
conversation, are described in [coding.md](coding.md).

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
| The folder next to it (`no folder`, or a path) | The folder this conversation works in: none, where pine was started, one in use elsewhere, or one you pick. See [coding.md](coding.md) |
| The `🎤` at the right end of the input (on a Mac) | Starts dictating the message, like `ctrl+r`. While it listens it is highlighted, and a click ends the listening. See [Dictating a message](#dictating-a-message) |
| `▤ code` at the right end of the tab bar | Opens or closes the code pane: changes (git), files, tool output and what the agent left running. In the pane: its four views, `↻` to read again, `×` to close, any file, folder or tool call to open it, `‹ back` to return |
| The model | The models you have credentials for |
| `reasoning <level>` | How much the model thinks before answering: off, minimal, low, medium, high, xhigh, max |
| The mode (`auto`, `safe`, `manual`, `bypass`, `plan`) | The five modes |
| A button in an approval dialog | Allow once, Always here, Deny or Later |
| Anywhere beside an open list | It closes. The click does nothing else |
| Anywhere beside an approval dialog or a question | Nothing: it stays open until you answer it or put it off with `esc` |
| A `▸ 12 tool calls` line | Everything the agent did in that turn opens: every tool call, thought and sub-task, and what it wrote in between. A click on the line, or on `▴ close` at the end, closes it again. See [The tool calls of a turn](#the-tool-calls-of-a-turn) |
| A `▸ thinking` or `▸ thought for` line, or the lines under it | What the model thought opens in full. A click anywhere on the open text closes it again. See [What a model thinks](#what-a-model-thinks) |
| A web address in the conversation | It opens in your browser |
| A picture | It is enlarged; a second click shrinks it again |
| A video's picture | It is enlarged or shrunk; playback carries on |
| `▶ play` / `‖ pause` under a video | Plays or pauses it. `▸ open in player` opens it in the system's player |
| `▸ load picture` in front of a web address | The picture at that address is fetched and shown |
| The `×` after an attached file | The file is removed again |

The lists are filtered as you type; `enter` picks, `esc` closes, and a click on an entry picks
it. The same lists open from the keyboard with `/agent`, `/sessions`, `/model`, `/reasoning` and
`/mode` and `/folder` without an argument.

The bar also shows `context 37%`: how full the conversation's context window is. It turns
yellow from 65% and red from 85%. Nothing needs doing when it fills up: pi summarises the older
part of the conversation by itself and carries on (the figure then drops). `/reset` empties it.
Next to it, `cache 94%` is the share of the last request that the model server took from its
prompt cache instead of reading it again; it appears once the server reports the figure. Both
are shown from the first answer on, and from the last one when you reopen a conversation.
A yellow `outside content` at the end of the bar means that the conversation has read something
from outside (a web page, an event): see [security.md](security.md) for what changes then.
The wheel scrolls the conversation.

Web addresses are always printed in full, also for a link an agent wrote as "[click here](...)":
what you see is what a click opens. A long address that wraps over several lines opens whole,
whichever line you click. Only `http` and `https` addresses open.

Because the UI uses the mouse, dragging over text selects and copies it through the UI. Hold
Option (Terminal, iTerm) or Shift (most others) while dragging to use the terminal's own
selection instead.

## Pointing at a file

Type `@` and a few letters in a message: a list offers the files of the folder the conversation
works in (the folder you opened for it, else the agent's workspace) whose name fits, the best
match first. Letters in order are enough: `@agts` finds `src/agents.ts`. `enter` or `tab` takes
one. Add lines by hand if you mean a part of it: `@src/agents.ts#120-160`, or `#120` for one
line.

| What you write | What the agent gets |
|---|---|
| `@src/agents.ts` | Your message as written, and a line from pine after it that names the file and tells the agent to read it before answering |
| `@src/agents.ts#120-160` | The same, with the lines |
| `@somebody` in a sentence | Nothing extra: only a name the list offered counts as a file |

The file itself is not attached: the agent reads it with its own tools, in its sandbox. In a
git repository the list holds what git knows or would add (ignored files are left out);
elsewhere hidden folders and `node_modules` are skipped.

## Attachments

Drag files from Finder onto the terminal. They appear above the input:

```
 attached: contract.pdf 212 KB ×  site-plan.png 1.4 MB ×
```

and go out with your next message. `/attach <path>` does the same from the keyboard,
`/detach` removes them all, `/detach 2` the second. `/paste` attaches the picture that is on
the clipboard, a screenshot for example (a terminal's own paste carries text only); `ctrl+v`
does the same in terminals that pass that key on.

What the agent gets: the files are saved into `inbox/` in its workspace, the message says which
files arrived, and images are also shown to the model directly if the model accepts images. Up
to 10 files of at most 20 MB each, about 48 MB together per message. An image over 10 MB is
saved but not shown to the model.

A folder dropped on the terminal is not attached: it is opened for the conversation, as with
`/folder` ([coding.md](coding.md)).

## Tabs

A tab is one conversation: an agent and a session. The first tab is the main agent's `main`
session. A `★` in a tab means its conversation is kept for good: an agent's main conversation,
or one you pinned. A dot next to a tab means something arrived while you were elsewhere, a
spinner that the agent is working, `!` that it waits for your approval.

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
same conversation tabs are open, in the same order, with the same one in front (the events tab
and task tabs are not reopened). Closing a tab does not end its conversation: it stays in the
agent's list (`/sessions`, or a click on the conversation's name in the bottom bar) and opens
again from there. A conversation in which nothing has been said yet is not in the list.

The main agent can do the same when you ask it ("open the books agent's invoice conversation
in a tab", "pin this", "close that tab"): see "Conversations and tabs" in
[setup.md](setup.md). A tab it opens appears behind the one you are in, marked as new, and
never takes your place; a rename, a closed tab and a removed conversation show at once.

The list does not grow without end. A conversation is removed by itself, with everything said
in it, once nothing has been said in it for 7 days (`limits.conversationDays`; `0` keeps
everything). These stay however old they are: each agent's main conversation, a pinned one,
one that is open in a tab, and one that is subscribed to an event source or has a schedule of
its own. The list says for each which it is: `the agent's own, always kept`, `pinned`, `open in
a tab`, `kept`, or when it goes (`goes in 5 days`, `goes in 20 h`, `goes soon`).

| In the list | Does |
|---|---|
| `enter`, or a click on a name | Opens the conversation in a tab |
| `pin` / `unpin` at the end of a row, or `ctrl+p` | Pins it, or takes the pin off. A pinned one has a `★` in front and comes first, and its tab has the `★` too |
| `×` at the end, or `ctrl+x` | Removes it for good. It asks once more (`remove? ×`); the second click or key does it. A conversation that is working is not removed |
| `reset` at the end of the agent's `main` conversation, or `ctrl+x` on it | Starts that conversation over, as `/reset` does. It asks once more (`reset? ×`). The agent's own conversation cannot be removed and never goes by itself, so it has a `★`, here and on its tab, and no `pin`: `/pin` in it only says that it always stays |

Removing cannot be undone: the history, what the conversation may do without asking, what it
listens to and whatever was set up for it alone (event sources, schedules, MCP servers, skills,
its folder) all go. A new conversation of the same name starts empty.

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
| `/undo` | Take back your last message: what it started is stopped, the files it changed in the conversation's folder are restored, the conversation forgets it and what followed, and its text is in the input again to change and send. Again for the message before it. See [coding.md](coding.md) for what is and is not restored |
| `/redo` | Bring back what the last `/undo` took, files and conversation. Works until you send a new message |
| `/compact` | Shorten this conversation: its earlier part becomes a summary the model writes, the most recent part stays as it is. Frees the model's context without forgetting what was agreed; useful with a small local model. It waits its turn like a message. pi also does this by itself when the context fills up |
| `/notify [on\|off]` | A bell and a notification when the agent is done, stops with an error, needs your approval or asks you something while the terminal's window is not in front. On by default; the setting is remembered. The notification goes through the terminal (Ghostty, iTerm, Kitty and others show it as a system notification; Terminal.app only rings the bell). Its text is pine's own ("pine: main is done"), never the agent's |
| `/copy` | Copy the agent's last answer to the clipboard, as it wrote it (Markdown) |
| `/export [copy] [full]` | Save this conversation as a Markdown file in the folder pine was started in (`pine-<agent>-<conversation>-<date>.md`). `copy` puts it on the clipboard instead; `full` adds what the agent thought and which tools it called |
| `/folder [path\|none]` | Open a folder of yours for this conversation: the agent's tools start there and may read and change it. `none` closes it again; without an argument, a list. See [coding.md](coding.md) |
| `/code [changes\|turn\|files\|output\|running\|off]` | Open the code pane beside the conversation, on that view; without an argument it opens and closes. `turn` shows what your last message changed |
| `/stop` | Stop what the agent is doing |
| `/goal [objective\|pause\|resume\|clear]` | Goal mode: with an objective, the agent keeps working by itself, round after round, until a judge says the objective is met. Without an argument it shows the goal and where it stands; `pause`, `resume` and `clear` do what they say. See "Goals" below |
| `/model [provider/id]` | Switch the agent's model. Without an argument, a list to search and pick from; or type a few letters after it: `/model deepseek` |
| `/reasoning [level]` | Set how much the model thinks before answering; without an argument, choose from a list. Saved like the model. A model that cannot reason ignores it |
| `/voice [language]` | Dictate the message instead of typing it; `ctrl+r` does the same. On a Mac. With a language (`/voice de-DE`) it listens for that one from then on. See [Dictating a message](#dictating-a-message) |
| `/mode [auto\|safe\|manual\|bypass\|plan]` | Set how much this agent does without asking; without an argument, choose from a list. See [Modes](#modes) |
| `/attach <path>`, `/detach [n]` | Attach files to the next message, or remove them |
| `/paste` | Attach the picture that is on the clipboard (a screenshot, for example) to the next message. `ctrl+v` does the same in terminals that pass that key on. Text is pasted with the terminal's own paste |
| `/mcp`, `/mcp login [name]` | List the MCP servers with their state and whom each is for: all agents, one agent, or one conversation (`only this conversation`, or `only the conversation notes of main, not this one`: a server added in one conversation is missing in the agent's others, see [mcp.md](mcp.md)). `/mcp login` signs in to a remote one through the browser. Without a name: the only remote server, or a list to choose from |
| `/status` | Model slots, running tasks, live sessions |
| `/sources` | Event sources: what can wake an agent, whether it runs, who is subscribed |
| `/subscribe [local\|agent\|global] <source> [what to do]`, `/unsubscribe [local\|agent\|global] <source>` | Wake on a source's events, or stop that. Without a scope it means this tab's conversation, and that subscription ends when the tab is closed; in an agent's main conversation it is the agent's own and stays. See [sources.md](sources.md) |
| `/tasks` | Recent tasks of this tab's agent |
| `/task <id>` | Open a tab on one task and see what it did, step by step. Meant for sub-agents and delegated tasks |
| `/events` | The live event log in its own tab |
| `/approve [id] [always]`, `/deny [id]` | Answer an approval request; `always` stops the question for the rest of the conversation |
| `/state [pattern]` | Shared state |
| `/emit <topic> [json]` | Publish an event as yourself |
| `/clear` | Clear the view (the conversation is kept) |
| `/quit`, `/exit` | Leave. The tabs open again at the next start |

A model you pick is saved as that agent's model (`model` in its `agent.json`) and is still set
after a restart. A mode you pick is saved the same way when it is `auto`, `safe` or `manual`. `bypass`
and `plan` are for now: they last until pine restarts, so an agent never comes back up in
bypass unless its `agent.json` says so.

## Goals

`/goal <objective>` gives the conversation a goal: the objective goes out as your message, and
each time the agent ends a turn pine asks a judge whether the objective is met and, if not,
calls the agent again. You do not have to answer "shall I go on?". How it works, when it stops
and what limits it has is in [agents.md](agents.md), "Goal mode".

While a goal is being worked on, the status line starts with it:

```
 ⠹ goal · round 3 of 20 · working · 41s · 6 tool calls · esc to stop
 ◎ goal · round 3 of 20 · checking whether it is met · esc to pause
```

and the conversation gets a line for every verdict, with the judge's reason under it:

```
 ◎ goal set: main works on it until it is met, for at most 20 rounds
 ◎ goal not met yet: round 2 of 20 starts
   the tests were not run
 ‖ goal stopped after 2 rounds: main needs something from you. Answer it, then /goal resume
   it needs to know which of the two databases to migrate
 ✓ goal met after 4 rounds
   all tests pass and the README has the command
```

`‖` is a goal that waits for you: paused, blocked, or at its limit. `/goal resume` goes on,
`/goal clear` takes it off. `esc` stops the round that is running and pauses the goal (between
two rounds, while the judge is asked, it pauses the goal before the next one starts), and so
does a message you type: write what you have to say, then `/goal resume`. The judge's reason is
shown to you and never to the agent. The UI only asks the daemon: a goal set here is the same
one another UI on the same daemon shows.

## Keys

| Key | Does |
|---|---|
| `enter` | Send. While the agent is working, the message is given to that work and read at its next step, so a correction lands without stopping anything. If the work ends or is stopped before reading it, it is answered next |
| `alt+enter` | Send, but let the message wait its turn: it is answered as work of its own when the agent is done with what it is doing |
| `shift+enter` | New line |
| `up` / `down` | Earlier inputs |
| `esc` | Stop what the agent is doing; the conversation shows `■ stopped`. A goal that was being worked on is paused (`/goal resume` goes on). A message you typed while it worked is not stopped with it: it is answered next, and for three seconds a second `esc` leaves it alone (the status line says so). After that `esc` stops it like anything else. While a list or dialog is open, `esc` only closes that |
| `shift+tab` | Next mode for this agent: auto, plan, safe, manual, bypass (while the input is empty) |
| `tab` | Next tab (while the input is empty) |
| `alt+1` ... `alt+9` | Go to that tab |
| `ctrl+t`, `ctrl+w` | New conversation; close the tab |
| `ctrl+g` | Open or close the code pane |
| `ctrl+r` | Dictate the message: start listening, and end it again. While it listens, `enter` ends it too and `esc` throws away what was heard |
| `ctrl+v` | Attach the picture that is on the clipboard, like `/paste` (in terminals that pass the key on) |
| `pgup` / `pgdn`, mouse wheel | Scroll |
| `ctrl+c` | Clear the input; twice on an empty input quits |
| `ctrl+d` | Quit (while the input is empty) |

## Dictating a message

You can say a message instead of typing it. Click the `🎤` at the right end of the input, or
press `ctrl+r` (or type `/voice`), speak, and press `enter` when you are done:

```
 ● listening · speak · enter when you are done · esc to throw it away
──────────────────────────────────────────────────────────────────
 About the scans: which bill is due first                              🎤 ← appears as you speak
```

| | |
|---|---|
| Where the words go | Into the input, after what you had typed, word by word as they are recognised |
| `enter` or `ctrl+r` while it listens | Ends the listening. The text stays in the input for you to read and correct |
| `enter` again | Sends it, like any message you typed |
| `esc` while it listens | Throws away what was heard; what you had typed is there again |
| A key that types, or backspace, while it listens | Ends the listening too, and the key is typed: what was heard stays, and nothing more is put into the input. Dictating never holds the input |
| `enter` or `ctrl+r` while it is still getting ready | Ends it. If it has not begun to listen after twenty seconds it ends by itself and says why that may be (the system waiting for your answer about the microphone) |
| Language | The one your Mac is set to. `/voice de-DE` (or `fr-FR`, `es-ES`, ...) listens for another from then on, until the UI is closed |

Nothing that was heard is sent by itself: it is text in the input until you press `enter`, so
a word the Mac misheard, or something somebody else said in the room, never reaches an agent
unread.

**It works on a Mac, and on the Mac itself.** The words are recognised by the speech
recognition macOS has on the device; nothing is sent to a server, pine's or anybody's. On
macOS 26 and later this needs no setting. The first time you use a language that the Mac has
no speech model for yet, the system fetches one (the status line says so), which needs the
network once. Before macOS 26 it needs Dictation switched on in System Settings > Keyboard,
with the language added there.

The first time, macOS asks whether **pine voice** may use the microphone. That is a small
helper pine builds on your Mac with Apple's command line developer tools (`xcode-select
--install` if they are missing; pine says so), and it is all the dialog is about: your
terminal app is not given the microphone. After an update of pine the helper is built anew,
and macOS may ask once more.

**On Linux, and anywhere that is not macOS, there is no voice input.** The input has no
microphone there, `ctrl+r` and `/voice` answer with one line that says so, and everything
else works as before. Nothing is installed,
built or started for it.

When it does not work, the line that appears says why and what to do:

| It says | What to do |
|---|---|
| `pine may not use the microphone` | System Settings > Privacy & Security > Microphone: switch on **pine voice** |
| `this Mac has no microphone to listen with` | Connect one, or choose one in System Settings > Sound > Input |
| `this Mac has no speech recognition for <language>` | Use a language it lists, with `/voice <language>` |
| `the system could not fetch its speech model` | The Mac needs the network once for a new language |
| `speech recognition is switched off on this Mac` | Before macOS 26 only: turn on Dictation in System Settings > Keyboard > Dictation |
| `Voice input needs Apple's command line developer tools` | `xcode-select --install`, then try again |

## Modes

The bottom bar shows the agent's mode; click it, press `shift+tab`, or use `/mode` to change it.

| Mode | What you will notice |
|---|---|
| `auto` | The agent works without asking and without a sandbox: it has your whole account and the network, and keeps them after reading the web. It asks before a critical action, and after outside content before it sends something out. What the main agent starts in |
| `safe` | The agent works without asking inside its sandbox: its own folders, no network. It asks when it wants something outside ("read access to ~/dev/gonzo, reason: ..."), before a critical action, and after outside content before it sends something out. What every other agent starts in. Shown in green |
| `plan` | The agent looks, reads, searches the web and asks, and changes nothing: no file is written, no command that changes something runs, nothing is sent, and you are not asked about any of it. Its answer is a plan. Read it, say what should be different, then switch to another mode (`/mode auto`, or a click on the mode in the bottom bar; `shift+tab` goes on to `safe`): the agent is told that planning is over and carries it out. While it plans, the agent reaches what the mode it had before reaches. Good with a small model: you see what it is about to do before it does it. Shown in magenta |
| `manual` | Inside its sandbox, and a dialog before every command, edit or message, until you answer "Always here" for that tool or server |
| `bypass` | No sandbox and no dialogs. The agent can read and change files anywhere in your account and use the network, and nothing is checked. Shown in red |

Bypass and outside content do not mix by default. If a conversation in bypass reads a web page
or another outside source, a yellow note appears, the bar shows `bypass (paused)`, and the agent
works as in `auto` mode: it asks before a critical action and before it sends something out. Choosing bypass in such a conversation asks you which you want: a
new, clean conversation in bypass (recommended), or bypass here anyway. The agent is told its
mode every turn, so it knows when something it refused earlier has become possible.

[security.md](security.md) has the exact rules.

## Approvals

When an agent wants to do something that needs your say (see [security.md](security.md)), a
dialog opens over the conversation with the agent, the tool and its arguments, and the reason.
When several requests wait at once, each gets its dialog in turn: the next one opens when you
answer the one before it or put it off.

| Key | Answer |
|---|---|
| `a` or `y` | Allow once. Where a yes already holds for the whole conversation (access to a folder or the network, a local address in the browser, an app) the button reads "Allow", and the dialog says what the yes holds for |
| `s` | Always here: allow, and do not ask again in this conversation about this MCP server (or this tool, such as `bash`). For a critical action it covers that kind of critical action, not the whole shell. Not offered for actions you configured to ask every time |
| `d` or `n` | Deny |
| `esc` | Later: the request stays open until `security.approvalTimeout` (5 minutes) has passed and then counts as denied. Until then the status line keeps reminding you, `enter` on an empty line opens the dialog again, and `/approve` or `/deny` answer it A question in a tab that is not in front opens no dialog there: that tab gets a `!` in the tab bar, and the status line of the tab you are in says which tab waits (`alt+<n>` goes there) |

When the action needs something only you have (a bot's token, a device's password), the dialog
has a field for it. Type or paste it: a secret is shown as dots, goes into pine's `.env` and is
never seen by the agent or its model. (Pairing a Telegram account uses the same dialog for the
six-digit code the bot sent to your phone; the code is shown as you type and is not stored.)
`enter` saves and allows, `tab` and `shift+tab` or the arrow keys move between fields, `ctrl+u`
empties one, `esc` leaves it for later, and `/approve` opens the dialog again. The letter keys
are part of what you type there, so `a` and `d` are not shortcuts in this dialog; Deny is a
button to click.

If Telegram is set up, the same request arrives there too; whichever answer comes first counts.
A request with a field to fill in is not sent to Telegram.

### The agent's list of steps

For work with several steps an agent can keep a list (its `todo` tool). It appears in the
conversation and is updated in place: `✓` done, `◐` in work, `☐` still to do, with a count
above it; the status line says `step 2 of 5` while the agent works. The list belongs to the
conversation: it is still there when the UI opens again, the agent is reminded of what is open
with your next message, and `/reset` clears it. In the conversation the list is soon far above,
behind the work itself. The code pane (`▤ code`, `ctrl+g`) keeps it in view:
while the pane is open the steps stand at its top, in every view, up to six at a time with the
one in work among them.

### When the agent asks you something

An agent that cannot go on without your decision asks with its `question` tool. A dialog shows
the question and the answers it offers, the one it recommends first. A digit, `enter` on the
highlighted line or a click picks one; anything you type instead is your own answer, sent with
`enter`. `esc` leaves it for later (`/approve` opens it again, `/deny` tells the agent that
there is no answer, and it goes on with an assumption that it names). If Telegram is set up, a
question with answers to pick from arrives there too, with a button for each. The tool is
there in every mode, `plan` too, and not in a run that an outside event started.

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
character per column is shown as written too. Code is coloured with the terminal's own sixteen
colours; the accent and the background of your own messages come from the 256-colour palette.
`NO_COLOR` turns colours off.

## Pictures

Pictures are drawn in the conversation:

- pictures you attach to a message (drag a file onto the terminal, or `/attach`),
- pictures that arrive with an event: a photo you send on Telegram, an image a camera saved
  into a watched folder,
- pictures a tool returns: a browser screenshot, an image file the agent reads, an image from an
  MCP server (the agent knows that you have seen these and does not show them again),
- pictures the agent points at in its answer with `![caption](path)`, where the path is a file
  in its workspace (png, jpg, gif or webp).

How they look depends on the terminal. kitty, Ghostty, WezTerm and Warp (every terminal that
is recognised as speaking the Kitty graphics protocol) get the real picture. Every other
terminal (Apple's Terminal, iTerm2, anything inside tmux) gets a thumbnail made of
coloured half blocks, two pixels per character. The half-block thumbnail and the conversion of
jpg, gif and webp use macOS's `sips`, and `ffmpeg` on Linux; without either only png files
show, and only on a terminal with real pictures.

A terminal draws a real picture above all text. While a menu or a dialog lies over a picture or
a video, that one is therefore drawn with half blocks, so the menu is whole; the real picture
returns when the menu closes. The same holds while the code pane is open beside the
conversation: a real picture can only be drawn at the left edge of a full line.

A thumbnail is at most 44 characters wide and 14 lines high. Click it to enlarge it, click again
to shrink it. When you reopen a conversation, the pictures that came with a message and those
an answer points at are there again; pictures a tool returned are shown again in the task's own
tab (`/task <id>`).

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

Playback is ten frames a second, without sound. On kitty, Ghostty, WezTerm and Warp the frames are
real pictures (up to 480 pixels wide as a thumbnail, 720 enlarged); every other terminal gets
half blocks, as for pictures. One video plays at a time. Playing in place needs
`ffmpeg` (`brew install ffmpeg`); without it there is the still (from Quick Look) and the
player. A video at a web address waits for a click, like a picture.

**Sound** is played by pine itself, in the conversation: there is no service and no MCP server
for it. An agent points at a sound file in its workspace the way it points at a picture,
`![caption](hello.wav)` (wav, mp3, m4a, ogg, flac or aiff, up to 100 MB), and the conversation
shows one line for it:

```
 ‖ pause · ♪ hello world · 0:01 / 0:03   ▸ open in player
```

- A sound that arrives while you are looking at the conversation is played at once, like a
  video; one from earlier in a conversation you reopen waits for a click.
- `‖ pause` / `▶ play`: click to pause and to go on from there. At the end the line is back at
  the start. One sound plays at a time: starting another stops the first.
- `▸ open in player` hands the file to the system's player.

It plays on the computer the terminal UI runs on, through what is there anyway: on macOS the
system's own audio player (driven through `osascript`, nothing to install); on Linux the first
of `ffplay` (part of ffmpeg), `mpv`, `pw-play`, `paplay` and `aplay` that is installed. Without
any of them the line says so and `▸ open in player` still works. A pause is exact with the
macOS player, `ffplay` and `mpv`, which can start in the middle of a file; the other three are
held where they are instead. The player runs confined like the picture converters: no network,
and it writes nowhere. A sound at a web address waits for a click on `▸ load sound https://...`, for the
same reason a picture does. Speech, music and other sound a remote server made is fetched
first (see "Files and pictures from a remote server" in [mcp.md](mcp.md)); a video still plays
without its sound in the conversation.

All of this is display. The model is never sent the drawing; it gets the actual picture if it
can look at images, exactly as before.

## The tool calls of a turn

Between your message and the answer an agent thinks, calls tools, writes a sentence about what
it does next and hands work to others. The conversation keeps all of that together and folds it
into one line when the turn is over, so that long work does not push your message and the
answer far apart:

| When | What is shown |
|---|---|
| While the agent works | `▸ 6 tool calls so far · bash ×4 · read ×2 · 1 thought · click to see all`, and under it the last six lines: the call that runs (`●`) and the ones that just ended (`✓`, `✗`) |
| When the turn is over | One line, `▸ 12 tool calls · bash ×6 · read ×4 · edit · +1 more · 2 thoughts · 1 failed · 48s · click to open`, with the answer under it |
| After a click on that line, at either time | `▾` and everything in the order it happened, as it is: a call with how long it took, a failed one with the start of its error, a thought to click, the lines of a sub-task with `▸ open`, the words the agent wrote in between. What you opened stays open when the turn ends |
| After a click on the first line again, or on `▴ close` at the end | The one line again, brought into view |
| A turn with a single tool call or thought | That call or thought itself, with no line above it |

The first line says how many tool calls there were, names the three tools that were called
most (`+N more` for the rest), then how many thoughts, how many calls failed, and how long it
all took.

Words the agent writes and then goes on working ("Let me look at the tests first.") are not its
answer. They are folded in with the tool calls: one grey line while the agent works, the whole
text when the line is opened. The text after which nothing more happens is the answer and
stays in the conversation.

Some things are never folded away, because they are for you: a request for your approval, a
question of the agent's, a message you typed while it worked, the agent's list of steps, and a
picture a tool returned. They stand where they happened. The tool calls before one of them
become one line at that point, and the ones after it are a block of their own.

Like thoughts, tool calls are shown while pine runs. After the UI is opened again an earlier
turn is your message and the answer; the tool calls of the last messages are in the code pane's
Output view ([coding.md](coding.md)). A tab on one task (`▸ open`, `/task <id>`) is there to
show that task's work, and shows every call by itself.

## What a model thinks

A model that reasons before it answers (`/reasoning`, and a model that can) sends its thoughts
ahead of the answer. The conversation shows them like this:

| When | What is shown |
|---|---|
| While the model thinks | `▸ thinking 4s` and under it the last four lines of the thought, moving as it goes on |
| When the thinking ends | One line, `▸ thought for 12s`. The answer or the tool call follows under it |
| When that call of the model has ended | The line also says how fast the model was: `▸ thought for 12s · ↑ 1.4k t/s ↓ 42 t/s`. See [How fast the model is](#how-fast-the-model-is) |
| After a click on it, at either time | `▾` and the whole thought, however long. One that you opened stays open when the thinking ends |
| After a click anywhere on the open thought | The one line again. Every line of it closes it, so you do not have to scroll back to its beginning; the line that is left is brought into view |

A thought is folded in with [the tool calls of a turn](#the-tool-calls-of-a-turn). With tool
calls around it, it is among their last lines while the agent works, and a click on it there
opens all of them, since a few last lines would cut an open thought off. When the turn is over
it is inside the one line that is left; a thought in a turn without tool calls stays a line of
its own.

Thoughts are shown while pine runs and are not kept in the conversation's list: after the UI is
opened again, the earlier answers are there and the thoughts are not. A sub-agent's or a
delegated task's thoughts are in its own tab (`▸ open`), each as a `▸ thought` line to click.
A model that does not send what it thinks (some hosted ones send nothing, or only a summary)
shows `thinking` in the status line and no thought.

### How fast the model is

pine measures every call of the model and shows two figures, in tokens a second (`t/s`):

| Figure | What it is |
|---|---|
| `↑ 1.4k t/s` | Prompt processing: how fast the model read the part of the conversation it had not seen before. Measured from the moment the call went out to the first token that came back. What the server took from its cache is not counted |
| `↓ 42 t/s` | Generation: how fast it wrote, thinking included. Measured from the first token to the end of the call |

The arrows are the ones of the token counts beside them: up is what went to the model, down is
what came back. Where they are shown:

| Where | Which call |
|---|---|
| On the `▸ thought for` line | The call of the model that this thought was part of |
| In the status line, while the agent works | The call that ended last |
| In the bottom bar, after `context` and `cache` | The last task as a whole, over all its calls (tokens over time, not the mean of the rates). It stays there when the work is done, also for a model that shows no thoughts |
| In a sub-task's own tab (`▸ open`), in its last line `── done · 12.3 s · 2 tool calls · 30205↑ 180↓ · ↑ 1.4k t/s ↓ 42 t/s ──` | That task as a whole |

pine's log has them with every task as well.

A figure is left out where it would say nothing: `↑` when fewer than 200 new tokens were read
(after a cache hit the wait is the round trip, not the model), `↓` when the answer was a few
tokens or arrived in one piece. pine times the calls itself, so this works with any model
server; a server's own figures can differ a little, because pine's include the way there and
back.

Because a click on an open thought closes it, dragging over it does not select text through
the UI. Hold Option (Terminal, iTerm) or Shift (most others) while dragging to select it with
the terminal instead.

## Sub-agents and delegated tasks

When an agent starts a sub-agent or hands a task to another agent, the conversation shows a
`↳` line for it, the tool calls it makes (indented), and a line when it answers, all among
[the tool calls of the turn](#the-tool-calls-of-a-turn). Its own
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
| A model server of your own (llama.cpp, vLLM, LM Studio) | `pine model add studio http://127.0.0.1:8080`, then `/model studio/<model>` |

`pine login` uses pi's own sign-in and stores the credential in `auth.json` in pine's home,
mode 600, where agents cannot read it. The key you type is not echoed.

## Notes

- The UI needs the control API (`http` in `pine.json`), because it is a client of the daemon like
  the other commands.
- Quitting an attached UI leaves the daemon running. Quitting an embedded one stops it; queued
  tasks run the next time a daemon starts.
- The UI is one of several ways in. Everything it does goes through the same events, tasks and
  approvals as Telegram or `pine send`.
