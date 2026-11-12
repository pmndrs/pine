# MCP servers

pi has MCP built in; pine decides which agent gets which server. Tools appear to the model as
`mcp__<server>__<tool>`. Characters such as `-` in a server's name become `_` there: the server
`home-link` offers `mcp__home_link__status`. Use the tool-name form in `approve`
patterns; the server's own `taints` and `approve` settings apply either way.

## Global and per agent

Global servers go in `pine.json`:

```json
"mcp": {
  "web":     { "pine": "web", "agents": ["scout"] },
  "calendar": { "command": "npx", "args": ["-y", "some-calendar-mcp"], "env": { "TOKEN": "${CALENDAR_TOKEN}" } },
  "docs":    { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }, "agents": ["main", "gonzo"] }
}
```

Servers of one agent go in its `agent.json`:

```json
{ "mcp": { "library": { "command": "library-mcp", "args": ["--stdio"] } } }
```

Who gets what:

| Setting | Effect |
|---|---|
| `agents` on a global server | Which agents get it. Default: all (`["*"]`). |
| `globalMcp: true` in `agent.json` (default) | The agent gets every global server that includes it. |
| `globalMcp: false` | No global servers. |
| `globalMcp: ["web"]` | Exactly these global servers, whether or not their `agents` list names this agent. |
| A server in `agent.json` with a global server's name | Replaces the global one for this agent (an entry with `"enabled": false` does not: the global server stays). |
| `"enabled": false` | Switches a server off without deleting it. |

`pine check` prints the resulting list per agent.

## Adding a server

Three ways, all ending in the same entry in `pine.json` (for everyone) or an `agent.json`:

**Ask an agent.** "Connect this MCP server: https://mcp.example.com/mcp", or "look at
example.com and install their MCP server". The agent calls `add_mcp_server` with the server's
URL, or for a local server with the command that starts it (`npx -y @example/mcp@latest`); you
get an approval dialog with the name, the URL or the command, and who gets it. Said just
like that, it is for the conversation you are in: only that conversation has the server's
tools, and the server is removed with the conversation (in an agent's main conversation it is
the agent's, in all its conversations). Say "for you as an agent" to keep it for the agent from
any conversation, and ask the **main agent** for "all agents": only it can add or remove a
server for everyone. `remove_mcp_server` takes a server out again. See [setup.md](setup.md).
If you allow it, the server is written to the configuration, without a restart. The agent
does not have the new tools in the turn in which it added the server, so pine calls it again
by itself as soon as that turn ends, in the same conversation, and it goes on with the tools.
You do not have to send a message, and there is no need for a new conversation. The question comes in every mode, bypass included, because
it changes pine itself.

A **local server** is a program that somebody else wrote and that keeps running while the agent
works. One that an agent adds therefore runs inside the sandbox of the agent that uses it
(`"sandboxed": true` in its entry): it reaches what that agent's shell reaches and nothing
more. For the main agent that is your account and the network, with your home folder; for
another agent its workspace, its private home folder and the network. pine's home stays closed
to it either way, and it gets nothing of the daemon's environment. The dialog shows the exact
command and says which of the two it is. Read the command: it is what will run. The command is
one program with its arguments; shell operators (`&&`, a pipe, `$(...)`) are refused. Where
the machine has no sandbox, an agent cannot add a local server at all.

If a local server needs a sign-in, its documentation names a command for it (often the same
command with `login` at the end). The agent runs that in its shell and gives you the link it
prints. If it needs a key or token in its environment, the agent names the variable
(`secrets`, for example `EXAMPLE_API_KEY`) and never the key: the dialog has a field for it,
you type it there, and pine keeps it in `.env` and takes it out again with the server.

Your yes makes it a server of yours: using it does not mark the conversation as having read
outside content. It is written with `"approve": "tainted"`, which only matters after the
conversation has read something from outside (a web page, say): from then on the server's tools
that act ask each time, until you answer "Always here" in that dialog, which settles it for the
conversation. Its
read-only tools never ask. If the server itself returns other people's text (mail, tickets, a
web search), add `"taints": true` to its entry; if you want no questions at all, remove
`approve`.

**From a shell.**

```bash
pine mcp add docs https://mcp.example.com/mcp
```

```bash
pine mcp add library --agent gonzo -- /usr/local/bin/library-mcp --stdio
```

Options: `--agent <id>` (only that agent), `--taints`, `--approve always|tainted`,
`--timeout <seconds>`, `--description "..."`, `--exposure direct|codemode|deferred|hidden`.
`pine mcp list --offline` lists without connecting. A remote server needs an https URL (http only for
`localhost`). If a daemon is running the change applies at once; otherwise at the next start.
`pine mcp remove <name>` takes it out again (`--agent <id>` for one in an `agent.json`), and
`pine mcp list` shows every server, who gets it, and whether it connects:

```
notes          needs sign-in    all: main
               https://gateway.example/d/abc/mcp  [outside content]  [approval: tainted]
web            connected        all: main
               bundled: web  [outside content]
```

**By hand.** Edit the file as described below, run `pine check`, restart.

## Signing in (OAuth)

A remote server that answers "unauthorized" and supports OAuth needs you to sign in once:

```bash
pine mcp login notes
```

or `/mcp login notes` in the terminal UI. Your browser opens the server's sign-in page; when
you approve, pine stores the tokens in `data/pi/mcp-auth.json` (closed to agents) and refreshes
them on its own afterwards. Open conversations get the server's tools from their next message.
`pine mcp logout <name>` deletes the tokens.

The sign-in is pi's: it follows the server's OAuth metadata and registers itself as a client.
For servers that need a pre-registered client or a particular client name, add an `oauth`
block to the entry (`clientId`, `clientSecret`, `callbackPort`, `clientName`,
`clientRegistration`); pi's `docs/mcp.md` describes each. A server that takes a fixed token
instead needs no sign-in: put `"headers": { "Authorization": "Bearer ${TOKEN}" }` in the entry
and the token in `.env`.

## Server entries

An entry has the shape of an `mcpServers` entry in pi's `mcp.json`:

| Key | Meaning |
|---|---|
| `command`, `args`, `env`, `cwd` | A local server started as a child process (stdio). |
| `url`, `headers` | A remote server (streamable HTTP). |
| `exposure` | How tools reach the model. pine's default is `direct`: every tool is declared. `codemode` offers one scripting tool instead, `deferred` makes tools searchable, `hidden` hides them. Use `deferred` or `codemode` for servers with dozens of tools. |
| `toolExposure` | Per-tool override, for example `{ "delete_*": "hidden" }`. |
| `description` | One sentence for the model about what the server offers. |
| `url` (remote servers) | Also decides where the `download` tool fetches from without asking: addresses on the same scheme, host and port. A server that hands out download links for its files on its own host works with it out of the box. |
| `timeout` | Seconds one call to this server may take before the agent is told it timed out. Default 60. Raise it for a server with slow tools, e.g. `"timeout": 180`. |

and the keys pine adds (besides `agents` and `enabled` from the table at the top):

| Key | Meaning |
|---|---|
| `pine` | Use a server that ships with pine (`"web"`, `"browser"` or `"commands"`), configured through `options`. |
| `sandboxed` | For a local server: `true` runs its program inside the sandbox of the agent that uses it, with that agent's home folder and environment, instead of as a process of yours. Written by `add_mcp_server` for every local server an agent adds. Add it to a server of your own to hold it the same way; take it out only if you trust the program with your account and pine's home. |
| `session` | In an `agent.json` only, written by `add_mcp_server`: the one conversation the server was added for. Other conversations of the agent do not get it, and it is removed with that conversation. |
| `taints` | `true` when the server returns content written by others (web pages, mail, tickets, chat). A session that calls it becomes tainted. Default `false`, `true` for the bundled `web` and `browser`. |
| `approve` | `"always"`: every call needs your approval, each time (except in bypass mode, where nothing asks). `"tainted"`: once the session has seen outside content, the server's tools that act need approval (its read-only tools do not), and you can answer "always in this conversation"; use it for servers that change things or send things out. Default `"never"`. |

Each session starts its own copy of a local server and stops it when the session closes. A
local server that you added yourself (`pine mcp add <name> -- <command>`, or an entry you
wrote) is a normal process of yours: it is not sandboxed, and what it can reach, agents can
reach through it. Give it the narrowest credentials that do the job, or set `"sandboxed": true`.
One that an agent added is sandboxed from the start.

pi's `mcp.json` files are not read. The daemon gives pi a folder of its own (`data/pi`) and
agent sessions load no MCP configuration file, so servers you set up for your own interactive
pi do not appear in agents.

## Bundled: web

Search and page reading without a browser.

```json
"web": { "pine": "web", "options": { "braveApiKey": "${BRAVE_API_KEY:-}" }, "agents": ["scout"] }
```

| Tool | What it does |
|---|---|
| `mcp__web__search(query, count?)` | Web search. Uses the Brave Search API when `braveApiKey` is set, otherwise DuckDuckGo's HTML page (fine for light use; it may rate-limit). |
| `mcp__web__fetch(url, max_chars?, start?)` | Fetches a page and returns its text. `start` continues a long page. |

| Option | Default | Meaning |
|---|---|---|
| `braveApiKey` | none | Brave Search API key. |
| `allowHosts` | all | Only these hosts (and their subdomains) can be fetched. Without `braveApiKey` the search is such a fetch too: add `duckduckgo.com`. |
| `denyHosts` | none | These cannot. |
| `allowPrivate` | `false` | Allow every address on this computer and your own network, without asking. Leave it off: one local address at a time is allowed by answering a question, see "Local addresses" below. |
| `maxBytes` | 2 MB | Cut-off for one response. |
| `maxUrlLength` | 2000 | Longer URLs are refused, which limits how much can be smuggled out in one. |
| `timeoutMs` | 20000 | Per request. |

It only speaks http and https, follows redirects itself and checks every hop, and refuses
loopback, private, link-local and similar addresses at the moment the connection is made. A page
therefore cannot send an agent to your router, your NAS or pine's own control port. Results are
wrapped in markers that say they are outside content, and the server is marked `taints`.

Once you have agents with private files, move `web` and `browser` to a research agent that has
nothing private in its workspace and let the others delegate to it.
[security.md](security.md) explains why.

## Bundled: commands

Turns fixed commands into typed tools, so an agent that should "check the printer" does not
need a shell for it.

```json
"tools": { "pine": "commands", "agents": ["house"], "options": { "commands": {
  "printer_status": {
    "description": "Current state of the Bambu printer as JSON",
    "run": ["/opt/homebrew/bin/mosquitto_sub", "-h", "192.168.1.50", "-t", "device/{{serial}}/report", "-C", "1", "-W", "5"],
    "params": { "serial": { "description": "Printer serial", "pattern": "[0-9A-Z]{15}" } },
    "timeoutSec": 10
  },
  "disk_usage": { "description": "Free space on the data volume", "run": ["/bin/df", "-h", "/Volumes/data"] }
} } }
```

| Key | Meaning |
|---|---|
| `description` | What the model reads. |
| `run` | Program and arguments. `{{name}}` inserts a parameter. |
| `params.<name>` | `type` (`string`, `number`, `boolean`), `description`, `enum`, `pattern` (must match the whole value), `default`, `required` (default true). |
| `timeoutSec` | Default 30. |
| `cwd`, `env` | Working folder (default: where the conversation's tools start: the agent's workspace, or the folder opened for the conversation) and extra environment. |
| `sandbox` | `true` runs the command inside the agent's sandbox (the variant in which instruction files are read-only). It has no effect for an agent with `"sandbox": false` or on a machine without a working sandbox. Default `false`: these are your commands, and most need the network. |
| `maxOutput` | Characters of output returned. Default 30000. |

Arguments are passed as a list, never through a shell: a parameter value of `x; rm -rf ~` is one
harmless argument. A value that starts with `-` is refused unless the parameter is a number or
has a `pattern` or `enum`, so the model cannot turn a value into an option. Constrain parameters
with `pattern` or `enum` wherever you can.

Mark a commands server `"approve": "tainted"` if any of its commands changes something.

## Bundled: browser

A real browser, for pages that need JavaScript, clicks, forms or a login. It is Microsoft's
Playwright MCP server with a guard around it.

```json
"browser": { "pine": "browser", "options": { "headed": false } }
```

`pine init` downloads the browser itself; `pine browser-install` fetches it again after an update.

The tools appear as `mcp__browser__browser_navigate`, `..._snapshot`, `..._click`, `..._type`,
`..._fill_form`, `..._press_key`, `..._select_option`, `..._hover`, `..._wait_for`, `..._find`,
`..._tabs`, `..._navigate_back`, `..._handle_dialog`, `..._close`, `..._take_screenshot`,
`..._console_messages`. A page is read as a snapshot: a text outline in which every element has
a reference the click and type tools take. To see what a page looks like, the agent takes a
screenshot, which a model that can see pictures gets as a picture; to see why a page it built
does not work, it reads the page's console messages.

### Seeing the browser, and logging in yourself

The browser has no window: the agent works in it unseen. When you want to watch, or a page
needs you (a login, a captcha, a payment to confirm), ask the agent to show the browser. It
has two more tools for that in your own conversations, and nothing in the configuration has to
change:

| Tool | What it does |
|---|---|
| `mcp__browser__browser_show` | The browser becomes a window on the screen of the computer pine runs on, on the page the agent is on, with the same logins. You can click and type in it; the agent goes on working in the same window. Takes about a second |
| `mcp__browser__browser_hide` | The window closes and the browser goes on without one, on the same page, with the same logins |

- The page is loaded again when the window appears or goes, so text typed into a form is lost
  and has to be typed again. Cookies and the site's stored data are kept; where several tabs
  were open, the one in front comes back.
- What you log in to in the window, the agent is logged in to as well: it is one browser.
  Without `profile` the logins last as long as that conversation's browser runs: at the
  latest until pine restarts or the conversation is reset. With `profile` they are kept.
- A run that was started from outside (an event, a message from somebody else) does not have
  these tools and cannot put a window on your screen.
- On a machine without a screen (a server, Docker) no window can open. The agent is told so
  and carries on without one.
- `"block": ["browser_show", "browser_hide"]` takes the tools away. `"headed": true` starts the
  browser with a window every time.

| Option | Default | Meaning |
|---|---|---|
| `headed` | `false` | `true`: the browser has a window from the start, in every conversation. To see it now and then, ask the agent instead (`browser_show`). |
| `profile` | none | A folder for a persistent profile: cookies and logins survive. Without it every session starts clean. |
| `images` | `true` | `false`: a screenshot comes back without its picture. Set it for a model that cannot see pictures. |
| `tools` | `"core"` | `"core"`: the sixteen tools above. `"all"`: everything Playwright offers that is not blocked. Or a list of names. |
| `block` | `[]` | Further tool names to withhold. |
| `allowHosts`, `denyHosts` | none | Limit where the browser may go. Subdomains are included. |
| `allowPrivate` | `false` | Allow every address on this computer and your own network, without asking. Leave it off: one local address at a time is allowed by answering a question, see "Local addresses" below. |
| `browser` | `chromium` | `chrome` or `msedge` use an installed browser instead of Playwright's Chromium. |
| `executablePath`, `viewport`, `caps`, `extraArgs` | | Passed on to Playwright MCP. With `"caps": "storage"` and `"tools": "all"` the agent also gets the tools that read and change cookies. |

What the guard does:

- **No local network, unless you say yes.** Everything the browser requests goes through a
  proxy inside the guard, which refuses loopback, private and link-local addresses, judged on
  the address it actually connects to. A page cannot reach your router, your NAS, the model
  server or pine's control port, whether by link, redirect, script or DNS trick. The one
  exception is an address you allowed for a conversation ("Local addresses" below). `file:`
  URLs are blocked by Playwright.
- **No code on your machine.** `browser_run_code_unsafe` (runs code in the server process),
  `browser_file_upload` and `browser_drop` (hand local files to a page), `browser_install`, and
  `browser_storage_state` and `browser_set_storage_state` (write and read a file of cookies)
  are removed from the tool list and refused if called, whatever `tools` says. Tools that a
  page itself declares (WebMCP) are not collected.
- **One step at a time.** Calls a model issues in parallel are run one after another; a browser
  has one page in front.
- **Snapshots inline.** Playwright writes snapshots to files; the guard puts their content into
  the tool result (cut at 24,000 characters; `browser_find` locates things on longer pages).
  A screenshot comes as a picture, with the name of the file it was saved as. One that gives
  up because the page is still loading its fonts is taken a second time.

A browser is the widest door for outside content: sessions that use it are tainted, and with a
`profile` it is signed in as you wherever you signed in. Treat a persistent profile like a
password; do not give it to an agent that also handles untrusted events.

### Local addresses

An agent that builds a web page wants to look at it: a development server on
`http://localhost:5173`, or a device at `http://192.168.1.20`. The browser cannot reach those by
itself. When the agent opens one with `browser_navigate`, pine asks the owner first, like any
approval. The agent does not call another tool for this and does not need `request_access`: it
opens the address and waits.

- A yes allows that host and that port, for that conversation and its sub-agents, until the
  conversation is reset or the daemon restarts. `localhost:5173` and `127.0.0.1:5173` are two
  questions; so are two ports.
- A no blocks the call. The agent should not try another spelling of the address, or start a
  browser of its own from the shell instead.
- Only what the agent itself opens is asked about. What a page loads, links or redirects to on
  another local address is refused. If the page really needs it (an API on another port), the
  agent opens that address with `browser_navigate` once, which asks.
- Asked about are addresses that are local by their own name: `localhost`, names ending in
  `.localhost`, `.local` or `.internal`, and IP addresses in private ranges. A name that only
  turns out to be local when it is looked up (`nas.home`) is refused without a question; for
  that the owner sets `allowPrivate`.
- pine's own control port is never opened, and never asked about.
- In bypass mode there is no question. A run that an event from outside started cannot ask at
  all. In a conversation that has read outside content the question says so.
- `allowHosts` and `denyHosts` still apply.

A server the agent starts from its own shell (`npm run dev`) can only listen on a port when the
shell has network access. The main agent has it (the scope `account`); an agent in the
workspace scope needs `request_access` with `network: true`, or `sandbox.network`. Start the
server in the background and give it a moment before opening the page. An agent with the
scope `account` can also stop it again with `kill`; in the workspace scope a command cannot
stop what an earlier command started.

## Telegram, MQTT and other outputs

Sending a Telegram message or an MQTT command is not an MCP server. Both are event sources
that can also send, and an agent uses its `send` tool for them: the daemon already holds the
connection, and the source decides who may be messaged and which topics may be written. See
"Sending through a source" in [sources.md](sources.md).
