# App control: operating the apps on a Mac

The bundled MCP server `computer` lets an agent use the apps on the computer pine runs on, the
way a person at the screen does: open an app, read a window, press a button, fill in a field,
pick from a menu, click, type. It is for things that have no command line and no web page: a
note in Notes, a setting in an app, a document in TextEdit, an app the owner built and wants
tried out.

It works on macOS only. On Linux and Windows the server is not started and the tools are not
there; `pine check` says so on the agent's `apps` line.

```json
"computer": { "pine": "computer" }
```

`pine init` writes this entry into `pine.json`. To take app control away, remove the entry or
set `"enabled": false` on it.

## Who has it

If an agent does not have the tools to operate apps in its list, the reason is in this table:
who may operate apps, and who may not.

| Who | App control |
|---|---|
| The main agent, in a conversation with its owner | Yes. The owner is asked once per app (below) |
| Another agent whose mode is `auto` or `bypass`, in a conversation with its owner | Yes, the same way |
| An agent that works in its sandbox: `safe` or `manual` mode (every agent but the main one, unless configured otherwise) | No. The tools are not in its list. Operating apps is acting with the owner's whole account, which such an agent does not have |
| A run that an event from outside started (a mail, a webhook, a message from somebody else) | Never, whatever the agent's `untrusted` profile lists |
| Sub-agents of a conversation that has it | Yes, when the agent's `subagents.mcp` is on; they share the conversation's answers |

An agent without the tools cannot get them by asking: `request_access` does not give app
control. The owner gives it by putting the agent in `auto` mode (`/mode auto`, or `mode` in
its `agent.json`; [security.md](security.md), "The whole account"). To be asked about every
action in an app, not once per app, set `"approve": "always"` on the server.

## Two ways to work

The tools serve a model that only reads text and a model that can see pictures.

**By outline** (any model). `app_snapshot` returns a window as indented text taken from the
accessibility tree, the description every Mac app keeps of its own windows for screen readers:

```
TextEdit, window 1 "Untitled".
Controls with [ref=...] can be used: app_press presses one, app_set_text writes into a text field.

- close button [ref=e4]
- toolbar
  - button "Bold" [ref=e7]
  - pop-up button "Font" [ref=e8]: "Helvetica"
- text area [ref=e2] (focused): "Dear Ada"
```

A control that can be used has a reference. `app_press` presses one, `app_set_text` writes into
a text field, `app_menu` picks from the menu bar by name. A control keeps its reference from
one snapshot to the next for as long as it exists. After something has changed (a dialog
opened, another view), take a new snapshot.

**By picture** (a model that can see). `app_screenshot` returns a picture of a window, or of
the whole screen, and says how large the picture is. `app_click`, `app_drag` and `app_scroll`
take positions in that picture: `x` and `y` are pixels counted from its top left corner. pine
turns them into the right point on the screen, whatever the display's resolution and wherever
the window is, also on a second display. A window that was moved after its picture was taken
is clicked where it is now.

A picture of a window shows that window alone, also while another app covers it, and taking it
does not bring the app to the front. When the app has something open over the window (a menu, a
sheet, a bubble), the picture holds that too, also where it reaches beyond the window, and the
answer says "and what is open over it". For such a picture the app is brought to the front, and
what lies beside the app on the screen is left grey: a picture of one app does not show another.

**For both.** `app_type` types text where the cursor is, `app_key` presses a key or a
shortcut, `app_open` starts an app or brings it to the front, `apps` lists what is running.

Use the outline wherever it works: it is exact, small, and needs no eyes. Take a picture when
the outline does not show what matters (a drawing, a map, a custom view, an app that describes
its window poorly), or to check what something looks like.

## The tools

They appear as `mcp__computer__apps`, `mcp__computer__app_open` and so on. Every tool but
`apps` takes `app`: the app's name as `apps` lists it (`TextEdit`). Capital letters do not
matter; a bundle id (`com.apple.TextEdit`) works too.

| Tool | What it does |
|---|---|
| `apps` | Lists the running apps and their windows, the one in front first, and the screens when there are several. Not asked about |
| `app_open` | Opens an app by name, or brings it to the front when it runs already. A window that was put away into the Dock comes back. Takes a name, not a path |
| `app_snapshot` | Reads a window as an outline with references. `window`: its number or a part of its title when the app has several; otherwise the front one. Long windows are cut at 24,000 characters; tables show their visible rows |
| `app_press` | Presses the control with the reference `ref`: a button, a checkbox, a link, a tab. A row of a list is selected. A control that has nothing to press by name is clicked in its middle |
| `app_set_text` | Makes the text field with the reference `ref` hold `text`, replacing what was in it. A search or address field acts only on the return key: `app_key` with `return` afterwards |
| `app_menu` | Brings the app to the front and picks an entry from its menu bar: `path` is the menu names from the top down, separated by ` > ` (`File > Save`, `Format > Font > Bold`). Without `path` it lists the menus, with the name of a menu what is in it, with shortcuts |
| `app_screenshot` | Takes a picture of an app's window (`app`, and `window` like `app_snapshot`), or of the whole screen without `app` (`screen`: which one, when there are several). The answer gives the picture's size in pixels. An open menu or sheet of the app is in the picture; other apps are not |
| `app_click` | Clicks at `x`, `y` in the last picture. `count`: 2 for a double click, 3 for a triple one. `button`: `"right"` for the context menu |
| `app_drag` | Presses the mouse button at `x`, `y` in the last picture, moves to `to_x`, `to_y` and lets go |
| `app_scroll` | Turns the scroll wheel over `x`, `y` in the last picture. `direction`: `up`, `down`, `left` or `right`. `amount`: lines, 5 unless given |
| `app_type` | Types `text` on the keyboard into the app, where its cursor is. A line break presses the return key, which in a chat app sends the message. The app treats it as typing: it may capitalize or correct words as it does for a person. `app_set_text` writes exactly |
| `app_key` | Presses a key or shortcut in the app: `return`, `tab`, `escape`, `space`, `delete`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `f1` to `f12`, a single character, or these with `cmd`, `ctrl`, `alt`, `shift`, `fn` in front (`cmd+s`, `cmd+shift+z`). Several, separated by spaces, are pressed in order. The keyboard layout in use is respected |

Calls run one after another: there is one mouse and one keyboard. While an agent works in an
app, the app is in front on the owner's screen and the pointer moves; the owner sees all of it
and can take over at any time.

## What the owner is asked

App control acts as the owner, so the owner says where.

- **Once per app, per conversation.** The first call that names an app, whether it looks or
  acts, is put to the owner: "operate the app TextEdit". A yes holds for that app in that
  conversation and its sub-agents until the conversation is reset or the daemon restarts. After
  it, nothing the agent does in that app is asked about again, and nothing is put to the
  reviewer click by click.
- **"Always here"** in the dialog stops the question for every app in that conversation.
- **The whole screen** (`app_screenshot` without `app`) is asked about once per conversation
  in the same way: such a picture shows every app that is open.
- **`apps`** is not asked about.
- A **no** blocks the call. The agent says what it wanted to do and does not try another way.
- In **bypass** mode nothing is asked. In **manual** mode every action waits for a go-ahead as
  all actions do there; looking (`apps`, `app_snapshot`, `app_screenshot`) does not, once the
  app was allowed. In **plan** mode the agent only looks, after the same yes per app; every
  other tool here (`app_open`, `app_press`, `app_set_text`, `app_menu` also when it would only
  list, clicking, typing) is refused without a question.
- To be asked about every call to these tools, set `"approve": "always"` on the server
  ([mcp.md](mcp.md)).

What a window shows was written by whoever wrote the mail, the page or the document in it: it
is outside content. A conversation that has used app control is marked like one that has used
the browser ([security.md](security.md), "Taint and approvals"). With `security.review: "ask"` such a
conversation is asked once whether it keeps its full rights; app control is part of them, and
after a no the tools refuse.

The action lands in the app that was named, or not at all: a reference has to belong to that
app, a position has to lie in one of its windows (otherwise the answer says which app is
there), and keys are sent to that app's process and to no other, after it was brought to the
front: if the owner clicks into another window while the agent types, the rest of the text
does not end up there.

pine does not click, type or press in **the app pine itself runs in** (the terminal app the
daemon was started from): that is where the owner answers pine's questions. Looking at it is
allowed. To run a command, an agent uses its own shell.

There is no list of forbidden apps. An app that can run commands or show files (a terminal, the
Finder, an editor) reaches everything the owner reaches, including what the sandbox keeps from
the agent's shell. The yes for such an app is the owner's decision to make.

## What macOS has to be told, once

macOS lets a program operate other apps only when the owner has allowed it, per app that asks.
What asks here is the app pine runs in: the terminal app the daemon was started from (Terminal,
iTerm, Ghostty, an editor's terminal).

| Grant | Needed for | Where |
|---|---|---|
| Accessibility | Everything but `apps` and `app_open`: reading windows, pressing, clicking, typing | System Settings > Privacy & Security > Accessibility: switch on the app pine runs in |
| Screen Recording | `app_screenshot` | System Settings > Privacy & Security > Screen & System Audio Recording (older systems: Screen Recording): switch on the app pine runs in. macOS then wants that app quit and opened again, so pine has to be started again too |

When a grant is missing, the tool's answer says which one and where to click, and macOS puts
its own window on the screen that leads to the switch. The agent tells the owner and tries
again when they say it is done. Without Screen Recording, `app_snapshot` and everything that
works by reference still work.

## The helper, and what it needs

Node cannot reach the accessibility API or make mouse and key events. A small program does
that: `mcp/computer.swift`, which ships with pine as source. The first time app control is
used pine compiles it with Apple's `swiftc` and keeps the result in its home
(`data/computer/`); that takes up to half a minute, once, and again after an update of pine
that changes the helper. A call that arrives while it is being built is answered with "try
again in a moment".

The compiler comes with Apple's command line developer tools, which a Mac that has `git`
already has. Where they are missing, the tool's answer says so and what to type:

```bash
xcode-select --install
```

The helper is pine's only compiled part. It decides nothing: which app may be operated and
what an answer says is pine's.

## Options

Under `options` of the server's entry.

| Option | Default | Meaning |
|---|---|---|
| `images` | `true` | `false`: for a model that cannot see pictures. `app_screenshot`, `app_click`, `app_drag` and `app_scroll` are not offered, which leaves eight tools that work by outline |
| `imageSize` | `1280` | The longer side of a picture in pixels. Pictures are scaled down to it (and to about 1.15 million pixels) so that a model is sent what it will actually look at; positions are mapped back whatever the size |
| `block` | none | Tools to leave out, by name: `["app_type", "app_key"]` |

`description`, `enabled`, `agents`, `approve` and `timeout` work as for every MCP server
([mcp.md](mcp.md)).

## When something does not work

| What the agent is told | What it means |
|---|---|
| "macOS does not let pine operate apps yet" | The Accessibility grant is missing (above) |
| "macOS does not let pine take pictures of the screen yet" | The Screen Recording grant is missing (above) |
| "App control needs Apple's command line developer tools" | The compiler is missing: `xcode-select --install` |
| "pine is building its helper" | The first use; try again in a moment |
| "That reference does not exist any more" | The window changed since the snapshot: take a new `app_snapshot` |
| "At that position is ..., not ..." | Another app's window is where the click would land: take a new `app_screenshot`, or name that app |
| "... is the app pine itself runs in" | pine does not act in its own terminal app |
| "... could not be brought to the front" | Something holds the screen: a system dialog, an app in full screen |
| "not approved" | The owner said no to that app in this conversation |
| "Not done: you are in plan mode" | The agent's mode is `plan`: it may look at apps and acts in none. The owner switches the mode when the plan is to be carried out |
| "Operating apps uses your owner's whole account, which this conversation does not have" | `security.review` is `"ask"`, the conversation has read outside content, and the owner has not said that it keeps its full rights |
| The tools are not in the agent's list | The agent is in `safe` or `manual` mode (it works in its sandbox), the run was started from outside, the system is not macOS, or the server is not configured |

An app that draws its window itself (some games, some cross-platform apps) describes little
of it: the outline is short or empty. Use pictures there. Apps built on a browser (Slack,
Visual Studio Code) describe their windows once they are asked, which pine does; the first
snapshot of such an app can be thinner than the second.
