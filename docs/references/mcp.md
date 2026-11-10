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
| `globalMcp: ["web"]` | Exactly these global servers. |
| A server in `agent.json` with a global server's name | Replaces the global one for this agent. |
| `"enabled": false` | Switches a server off without deleting it. |

`pine check` prints the resulting list per agent.

## Adding a server

Three ways, all ending in the same entry in `pine.json` (for everyone) or an `agent.json`:

**Ask an agent.** "Connect this MCP server: https://mcp.example.com/mcp". The agent calls
`add_mcp_server`; you get an approval dialog with the name, the URL and who gets it. Said just
like that, it is for the conversation you are in: only that conversation has the server's
tools, and the server is removed with the conversation (in an agent's main conversation it is
the agent's, in all its conversations). Say "for you as an agent" to keep it for the agent from
any conversation, and ask the **main agent** for "all agents": only it can add or remove a
server for everyone. `remove_mcp_server` takes a server out again. See [setup.md](setup.md).
If you allow it, the server is written to the configuration and its tools are there from your
next message, without a restart. This works for remote servers (an https URL) only: a local
server is a program that runs with your rights, and that stays something you add yourself. The
question comes in every mode, bypass included, because it changes pine itself.

Your yes makes it a server of yours: using it does not mark the conversation as having read
outside content. It is written with `"approve": "tainted"`, which only matters after the
conversation has read something from outside (a web page, say): from then on the server's tools
that act ask once, and "Always here" in that dialog settles it for the conversation. Its
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
`--timeout <seconds>`, `--description "..."`. A remote server needs an https URL (http only for
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
| `session` | In an `agent.json` only, written by `add_mcp_server`: the one conversation the server was added for. Other conversations of the agent do not get it, and it is removed with that conversation. |
| `taints` | `true` when the server returns content written by others (web pages, mail, tickets, chat). A session that calls it becomes tainted. Default `false`, `true` for the bundled `web` and `browser`. |
| `approve` | `"always"`: every call needs your approval, each time. `"tainted"`: once the session has seen outside content, the server's tools that act need approval (its read-only tools do not), and you can answer "always in this conversation"; use it for servers that change things or send things out. Default `"never"`. |

Each session starts its own copy of a local server and stops it when the session closes. A
local server is a normal process of yours: it is not sandboxed, and what it can reach, agents
can reach through it. Give it the narrowest credentials that do the job.

pi's `mcp.json` files are not read. The daemon points pi at an empty configuration folder so
that servers you set up for your own interactive pi do not appear in agents.

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
| `allowHosts` | all | Only these hosts (and their subdomains) can be fetched. |
| `denyHosts` | none | These cannot. |
| `allowPrivate` | `false` | Allow addresses on your own network. Leave it off. |
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
| `cwd`, `env` | Working folder (default: the agent's workspace) and extra environment. |
| `sandbox` | `true` runs the command inside the agent's sandbox. Default `false`: these are your commands, and most need the network. |
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

Run `pine browser-install` once to download the browser itself.

The tools appear as `mcp__browser__browser_navigate`, `..._snapshot`, `..._click`, `..._type`,
`..._fill_form`, `..._press_key`, `..._select_option`, `..._hover`, `..._wait_for`, `..._find`,
`..._tabs`, `..._navigate_back`, `..._handle_dialog`, `..._close`. A page is read as a
snapshot: a text outline in which every element has a reference the click and type tools take.

| Option | Default | Meaning |
|---|---|---|
| `headed` | `false` | Show the browser window, so you can watch. |
| `profile` | none | A folder for a persistent profile: cookies and logins survive. Without it every session starts clean. |
| `tools` | `"core"` | `"core"`: the fourteen tools above. `"all"`: everything Playwright offers that is not blocked. Or a list of names. |
| `block` | `[]` | Further tool names to withhold. |
| `allowHosts`, `denyHosts` | none | Limit where the browser may go. Subdomains are included. |
| `allowPrivate` | `false` | Allow addresses on your own network. Leave it off. |
| `browser` | `chromium` | `chrome` or `msedge` use an installed browser instead of Playwright's Chromium. |
| `executablePath`, `viewport`, `caps`, `extraArgs` | | Passed on to Playwright MCP. |

What the guard does:

- **No local network.** Everything the browser requests goes through a proxy inside the guard,
  which refuses loopback, private and link-local addresses, judged on the address it actually
  connects to. A page cannot reach your router, your NAS, the model server or pine's control
  port, whether by link, redirect, script or DNS trick. `file:` URLs are blocked by Playwright.
- **No code on your machine.** `browser_run_code_unsafe` (runs code in the server process),
  `browser_file_upload` and `browser_drop` (hand local files to a page) and `browser_install`
  are removed from the tool list and refused if called, whatever `tools` says.
- **One step at a time.** Calls a model issues in parallel are run one after another; a browser
  has one page in front.
- **Snapshots inline.** Playwright writes snapshots to files; the guard puts their content into
  the tool result (cut at 24,000 characters; `browser_find` locates things on longer pages).

A browser is the widest door for outside content: sessions that use it are tainted, and with a
`profile` it is signed in as you wherever you signed in. Treat a persistent profile like a
password; do not give it to an agent that also handles untrusted events.

## Telegram, MQTT and other outputs

Sending a Telegram message or an MQTT command is offered to agents as plain tools
(`telegram_send`, `mqtt_publish`) by the plugins that own those connections, not as MCP servers:
the daemon already holds the connection, and the plugin enforces who may be messaged and which
topics may be written. See [plugins.md](plugins.md).
