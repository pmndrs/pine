// A short catalogue of tools.
//
// An agent with a browser, a media server and web search has 81 tools. Declared one by one, as
// pi does it, they cost a local model about 21,000 tokens before the first word, and most
// conversations use four or five of them. Here the same tools reach the model as 25 declarations:
//
//   - What nearly every conversation uses stays a tool of its own, said shortly (shortTool).
//   - Every other group of tools is ONE declared tool, a family: the tools of an MCP server,
//     pine's tools for event sources, for schedules, and so on (families). It takes an "action",
//     the name of the tool that is meant, and that tool's arguments, typed as the tool has them:
//     a model server holds the model to declared arguments, and that is what keeps calls right.
//     Measured on a local model, families with typed arguments had no call refused for its
//     arguments in 74 tasks; the same tools behind one untyped "call this tool" had one in ten.
//   - A call that is nearly right is carried out as what was meant (ease, fit), and one that is
//     wrong comes back with the tool's whole text (helpOf), which is otherwise not sent at all.
//
// Nothing is taken out of pine by this. Every tool stays registered and active; only its
// declaration is left out of the request. A call through a family is carried out by pi as a
// nested call of the tool that is meant, under its own name, so it passes the gate in
// coreExtension like a call the model made itself: class, approvals, outside-content mark.
//
// And nothing here names what exists right now (which agents, which sources): the declarations
// are the same in every conversation of an agent, in one order, which is what lets a model
// server keep what it has read (see steady() in agents.ts).
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ROUTERS } from "./actions.ts";
import { SETTINGS } from "./admin.ts";

export const FIND_TOOLS = "find_tools";

/** Tools that stay declared by themselves: what almost every conversation uses. */
export const DECLARED = ["read", "bash", "edit", "write", "grep", "find", "ls", "delegate", "subagent", "todo", "question", "manual", "download", FIND_TOOLS];
/** Of pine's bundled MCP servers, those whose tools stay declared by themselves (by the `pine` name of the server). */
export const DECLARED_SERVERS = ["web"];

/** pine's own tools by what they are about: a family each. */
/**
 * The lists: what there is of a kind. They are one declared tool of their own, which takes several at
 * once. In a family beside the actions that change things, "add this and show me what there is"
 * was two calls of one tool, and a model sends two calls of one tool in two answers about half the
 * time; as two tools it sends them in one, as it does when every tool is declared by itself.
 */
const LISTS = ["sources", "schedules", "mcp_servers", "skills", "agents", "settings", "routes"];

const GROUPS: Array<[id: string, name: string, about: string, tools: string[]]> = [
	["lists", "pine_list", "What there is: the lists of what you have and of what pine has. Use it when your owner asks what you are watching, what is scheduled, which servers, skills or agents there are, or how pine is set up", LISTS],
	[
		"sources",
		"pine_sources",
		"Event sources: things outside pine that report something and wake you (a folder, a web page, a command, MQTT, a webhook, Telegram). Use it when your owner wants something watched or reacted to.",
		["subscribe", "unsubscribe", "add_source", "send", "remove_source", "publish_event", "add_source_type", "remove_source_type"],
	],
	["schedules", "pine_schedules", "Schedules: do something at a set time, once or again and again (reminders, daily checks).", ["add_schedule", "remove_schedule"]],
	["mcp", "pine_mcp", "MCP servers: connect and remove servers that give you more tools.", ["add_mcp_server", "remove_mcp_server", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]],
	["skills", "pine_skills", "Skills: written-down ways of doing something, which you follow later.", ["add_skill", "remove_skill"]],
	["agents", "pine_agents", "pine's agents: create, change and remove them.", ["create_agent", "update_agent", "remove_agent"]],
	[
		"settings",
		"pine_settings",
		"Changes to pine's settings, its routes (rules for events that arrive, such as: a source's events wake another agent) and its model servers.",
		["set_setting", "add_route", "remove_route", "add_model_server", "remove_model_server"],
	],
	["other", "pine_other", "Other tools of pine.", ["request_access", "stop_program", "state_get", "state_set"]],
];

/**
 * What a tool does, in the one line a family has for it. Written from the tool's own description
 * and kept true to it: a line that promises what the tool does not do costs a call (add_source
 * subscribes only with a note, and a line that said "you are subscribed at once" had every
 * agent subscribe a second time). A line keeps what the description says about where the
 * tool's work ends and what is used instead: with "create a new agent" and nothing more, a
 * model went on to do the new agent's job, and with a route described as "wake another agent"
 * it added routes where a subscription was meant. What an argument means is in ARG_HINT.
 */
const BRIEF: Record<string, string> = {
	sources: "your event sources and subscriptions: the answer to what you are watching or subscribed to",
	subscribe: "be woken by an event source that exists already and that you are not subscribed to yet (sources lists them)",
	unsubscribe: "end a subscription: you are no longer woken, the source stays",
	add_source:
		'set up something new to watch; with a "note" you are subscribed to it at once, without subscribe. When another agent is to be the one that is woken, give "agent" here: a source of your own cannot be handed to it afterwards. "type" and its "options": folder {dir, mask?, pattern?, ignore?, recursive?}; http {url, every?, path?, match?, headers?, local?} (a page or a value in it that changes); command {run, every?, match?, timeout?} (what a command prints); mqtt {url, topics, publish?, username?}; webhook {open?}; ftp {port, user?, allow?}; telegram {allow?, approvals?}. Tokens and passwords are left out: pine asks your owner for them',
	send: "send something out through a source that can send (a message to your owner on Telegram, a command over MQTT); an answer to a message that came in through a source goes back by itself",
	remove_source: "remove an event source for good, when your owner no longer wants it watched at all (to only stop being woken: unsubscribe)",
	publish_event: "publish an event on pine's bus",
	add_source_type: "bring in a new kind of event source (a module)",
	remove_source_type: "remove a kind of event source",
	schedules: "what is scheduled for you, and when each is next due",
	add_schedule: "do a task at a time, once or again and again (reminders, daily checks); give exactly one of cron, every, at, in",
	remove_schedule: "remove a schedule (to change one: remove it and add it again)",
	mcp_servers: "your MCP servers, whom each is for and whether its tools are in your tool list",
	add_mcp_server: "propose an MCP server when your owner asks to install or connect one, by web address or by command; your owner decides",
	remove_mcp_server: "disconnect an MCP server",
	list_mcp_resources: "list the resources of MCP servers",
	list_mcp_resource_templates: "list the resource templates of MCP servers",
	read_mcp_resource: "read a resource of an MCP server",
	skills: "your skills and whom each is for",
	add_skill: 'write down how something is done, so that you can do it again without being told ("remember how to do this"); the same name replaces it. A fact belongs into MEMORY.md instead',
	remove_skill: "remove a skill (to change one: add it again under the same name)",
	agents: "pine's agents: what each is for, its model, mode, reach and what it has; with \"id\", one agent in full with its instructions",
	create_agent: "create a new agent when your owner asks for one: it has a job, a workspace and instructions of its own, and exists at once. Its job goes into its instructions and is its own from then on: do not start on it yourself",
	update_agent: "change an agent when your owner asks: what it is for, its instructions, model, reasoning, mode, tools, whom it may hand work to, its reach. Give only what changes",
	remove_agent: "remove an agent for good, with everything it has and its folders",
	settings: "pine's settings with what is in force: the answer to how pine is set up",
	set_setting: "change one of pine's settings; key as settings lists it, e.g. defaults.model, defaults.bashTimeoutSec",
	routes: "pine's routes: rules for what happens when an event arrives. What agents subscribe to is not here (that is sources)",
	add_route: 'add a rule for arriving events, only for what a subscription or a schedule cannot do: write shared state from an event (set), publish another event, wake an agent only when a condition holds (when). For an agent to react to a source, add_source or subscribe with "agent" instead',
	remove_route: "remove a route",
	add_model_server: "add a model server your owner names (an OpenAI-compatible address); not for looking: agents shows which models are in use",
	remove_model_server: "remove a model server",
	request_access: "ask your owner for a folder outside your workspace, or for network in your shell",
	stop_program: "stop a program one of your commands left running",
	state_get: "read shared state (facts agents and devices keep)",
	state_set: "store a fact in shared state",
};

/** The tools of pine's bundled browser, said shortly and with what a model gets wrong (a target is a reference from the page text). */
const BROWSER_BRIEF: Record<string, string> = {
	browser_navigate: "open a web address; the answer is the page as text with references to its elements",
	browser_snapshot: "the page as text, with a reference for each element (what click and type take as target)",
	browser_click: "click an element; target is its reference from the page text",
	browser_type: "type text into a field; target is its reference; submit presses Enter after it",
	browser_fill_form: "fill several fields at once",
	browser_select_option: "pick an option in a dropdown",
	browser_press_key: "press a key, e.g. Enter, Escape, ArrowDown",
	browser_hover: "move the pointer over an element",
	browser_find: "search the page text for words or a regular expression",
	browser_wait_for: "wait for text to appear or to go, or for a number of seconds",
	browser_navigate_back: "go back one page",
	browser_tabs: "list, open, close or select a tab",
	browser_take_screenshot: "a picture of the page or of one element",
	browser_console_messages: "what the page wrote to its console",
	browser_handle_dialog: "answer a dialog the page opened",
	browser_close: "close the page, when your owner asks for that (a page you have read can stay open)",
	browser_show: "show the browser as a window on your owner's screen",
	browser_hide: "take the browser's window off your owner's screen again",
};

/** What an argument is, in a few words, where its name and type do not say it. From the tool's own words for it. */
const ARG_HINT: Record<string, string> = {
	"add_schedule.name": "short, like morning-mail",
	"add_schedule.task": "what you are to do then, complete on its own",
	"add_schedule.cron": 'five fields, local time: "0 7 * * 1-5" is weekdays at 7',
	"add_schedule.every": '"15m", "2h"',
	"add_schedule.at": 'once, local time: "2026-12-24 17:00"',
	"add_schedule.in": 'once, after: "20m", "2h"',
	"add_source.description": "one line: what it reports",
	"add_source.options": 'the options of the type, e.g. {"dir": "~/Scans", "mask": "*.pdf"}',
	"add_source.note": "what you are to do when it reports something; with it you are subscribed at once",
	"add_source.own": "true only if your owner said nobody else can put content there",
	"add_source.ask": "names of secret options pine is to ask your owner for",
	"subscribe.note": "what you are to do when it reports something",
	"subscribe.when": 'JSON filter, e.g. {"payload.value.state":"FINISH"}',
	"subscribe.throttle": 'ignore it for this long after an event, e.g. "5m"',
	"send.data": 'further fields as JSON, e.g. {"topic": "lamp/set", "message": "on"}',
	"add_mcp_server.command": 'for a local server: "npx -y some-package"',
	"add_mcp_server.url": "for a remote server: its https address",
	"add_mcp_server.secrets": "NAMES of environment variables it reads keys from",
	"add_skill.instructions": "the steps, in Markdown, written to yourself",
	"add_skill.description": "what it is for and when to use it",
	"add_skill.files": "a folder in your workspace that goes along",
	"create_agent.instructions": 'who it is and how it works, written to the agent itself ("You are ..."): its job, what it should and should not do, how it reports. This becomes its instruction file',
	"create_agent.description": "one line: what it is for. Other agents read it when they decide whom to hand work to",
	"create_agent.model": "provider/model; leave out for pine's default",
	"update_agent.instructions": "the whole new text, which replaces what is there: read the present text first (pine_list: agents with id)",
	"agents.id": "with agents: one agent in full",
	"update_agent.description": "one line: what it is for",
	"update_agent.soul": "the whole new text of its SOUL.md (character and tone), when your owner speaks of how it should be or sound",
	"update_agent.model": 'provider/model, or "default"',
	"update_agent.tools": "all its built-in tools, separated by commas",
	"update_agent.delegates": 'the agents it may hand work to, separated by commas; "*" is all',
	"update_agent.read": "folders outside its workspace it may read, full paths",
	"update_agent.write": "folders outside its workspace it may change, full paths",
	"update_agent.forget": "folders to take away from it again",
	"remove_agent.keep_files": "true to keep its folder",
	"set_setting.value": 'as text; "default" removes the entry',
	"add_route.on": "the topic it listens to, as sources shows it",
	"add_route.when": "JSON filter on the event",
	"add_route.agent": "the agent to wake",
	"add_route.prompt": "what that agent is told",
	"add_route.set": 'shared state to write, as JSON: {"house/mode": "{{payload.value}}"}',
	"add_model_server.url": "the server's address, e.g. http://127.0.0.1:8080",
	"request_access.path": "absolute path of the file or folder",
	"request_access.write": "true to also change files there",
	"request_access.network": "true for network in your shell instead of a path",
};

/** Arguments whose values are a fixed few, which the tools say in words: declared as choices, the model is held to them. */
const CHOICES: Record<string, string[]> = {
	"update_agent.mode": ["auto", "safe", "manual", "bypass", "plan", "default"],
	"update_agent.thinking": ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};

/** What a sub-agent is told when it calls what is not its to do. */
export const NOT_A_SUBAGENTS = "You are a sub-agent: this is not yours to do. Say in your answer what should be done, and the conversation that started you sees to it.";

interface Tool {
	name: string;
	description: string;
	parameters: any;
}

const firstSentence = (text: string, max = 110): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	const end = flat.search(/[.:](\s|$)/);
	const s = end > 20 ? flat.slice(0, end) : flat;
	return s.length > max ? `${s.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : s;
};

/** A schema as a type in a few characters: string, "a"|"b", string[], {x: number, y?: string}. */
function typeOf(s: any, depth = 0): string {
	if (!s || typeof s !== "object") return "any";
	if (Array.isArray(s.enum)) return s.enum.map((v: unknown) => JSON.stringify(v)).join("|");
	if (s.const !== undefined) return JSON.stringify(s.const);
	const variants = s.anyOf ?? s.oneOf;
	if (Array.isArray(variants)) return [...new Set(variants.map((v: any) => typeOf(v, depth)))].join("|");
	if (s.type === "array") return `${typeOf(s.items, depth)}[]`;
	if (s.type === "object" || s.properties) {
		const props = Object.entries(s.properties ?? {});
		if (!props.length || depth > 1) return "object";
		const req = new Set<string>(s.required ?? []);
		return `{${props.map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${typeOf(v, depth + 1)}`).join(", ")}}`;
	}
	return Array.isArray(s.type) ? s.type.join("|") : (s.type ?? "any");
}

/** Everything about one tool, as text: for a call that got its arguments wrong, and for find_tools. */
export function helpOf(tool: Tool, short: string): string {
	const req = new Set<string>(tool.parameters?.required ?? []);
	const lines = [`## ${short}`, tool.description.trim()];
	const props = Object.entries(tool.parameters?.properties ?? {}) as Array<[string, any]>;
	if (!props.length) lines.push("Arguments: none.");
	else {
		lines.push("Arguments:");
		for (const [name, s] of props) {
			lines.push(`- ${name}${req.has(name) ? "" : " (optional)"}: ${typeOf(s)}${s?.description ? `. ${String(s.description).trim()}` : ""}${s?.default !== undefined ? ` Default: ${JSON.stringify(s.default)}.` : ""}`);
			// What an object or a list of objects holds, where its parts are described.
			const inner = s?.type === "array" ? s.items : s;
			for (const [k, v] of Object.entries(inner?.properties ?? {}) as Array<[string, any]>) if (v?.description) lines.push(`  - ${k}: ${String(v.description).trim()}`);
		}
	}
	return lines.join("\n");
}

// ---- The tools that stay declared by themselves, said shortly --------------------------------------

/** Short descriptions of the built-in tools and pine's everyday ones: enough to make the first call right. */
const SHORT: Record<string, string> = {
	read: "Read a file: text, or an image (jpg, png, gif, webp, bmp). Text is cut at 2000 lines or 50KB: use offset and limit for the rest.",
	bash: "Run a bash command in the current folder; returns stdout and stderr (long output is cut to its last 2000 lines, the whole is saved to a file).",
	edit: "Change a file by exact text replacement. Each edits[].oldText must match the file exactly and only once, edits must not overlap, and all changes to one file go into one call.",
	delegate: 'Hand a task to another agent and get its answer. It sees only what you write in "task", so include everything it needs.',
	subagent: "Run up to 4 independent sub-tasks in parallel. Each is a copy of you with an empty context and returns only its answer, so each task must be complete on its own. For research or checks that would fill your context.",
	todo: "Keep a short list of the steps of a task that has several. Send the whole list each time: at the start, when a step begins (in_progress, one at a time) and when one is done. Your owner sees it. An empty list clears it.",
	question: "Ask your owner one question you cannot go on without. Offer two to six short answers when you can, the one you recommend first. Not for permission: that is asked by itself.",
	manual: 'Search pine\'s own manual: how pine works and is set up (your tools, event sources and their options, schedules, MCP servers, skills, agents, every configuration key, modes and approvals, the sandbox, the terminal UI, the pine command). "search": short queries in plain words, one thing each. "read": ids of parts to read in full. Search first, then read the part that fits.',
};

/** Tools whose declaration is left as it is: their arguments are few, and what is said about them is short already. */
// (download: its description says which addresses this session may fetch from, which differs with the session.)
const AS_IS = ["write", "grep", "find", "ls", "download", FIND_TOOLS];

/** How many characters of an argument's description a short declaration keeps. */
const ARG_TEXT = 90;

/** The first sentence or two of a text, at most `max` characters. */
function lead(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	const sentences = flat.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [flat];
	let out = "";
	for (const s of sentences) {
		if (out && out.length + s.length > max) break;
		out += s;
		if (out.length >= max * 0.6) break;
	}
	out = out.trim() || flat;
	return out.length > max ? `${out.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : out;
}

/**
 * A parameter schema with what a model does not need taken out, and its texts cut to a clause.
 * `texts`: "all" keeps a short description of each argument, "first" its first sentence (pine's
 * own tools: what follows may name what exists right now), "none" drops them.
 */
function leanSchema(s: any, texts: "all" | "first" | "none", depth = 0): any {
	if (!s || typeof s !== "object") return s;
	if (Array.isArray(s)) return s.map((x) => leanSchema(x, texts, depth));
	const variants = (s.anyOf ?? s.oneOf) as any[] | undefined;
	if (variants) {
		const real = variants.filter((v) => v?.type !== "null");
		const consts = real.map((v) => v?.const);
		const rest = { ...s };
		delete rest.anyOf;
		delete rest.oneOf;
		if (real.length && consts.every((c) => typeof c === "string")) return leanSchema({ ...rest, type: "string", enum: consts }, texts, depth);
		if (real.length === 1) return leanSchema({ ...rest, ...real[0] }, texts, depth);
	}
	const out: any = {};
	for (const [k, v] of Object.entries(s)) {
		if (["$schema", "title", "additionalProperties", "patternProperties", "examples", "minItems", "maxItems", "minLength", "maxLength"].includes(k) || k.startsWith("x-")) continue;
		if (k === "default" && (v === null || depth > 0)) continue;
		if (k === "description") {
			if (texts !== "none" && typeof v === "string" && v.trim()) out.description = texts === "first" ? lead(v.split(/(?<=[.:])\s/)[0].replace(/:$/, "."), ARG_TEXT) : lead(v, depth > 1 ? 60 : ARG_TEXT);
			continue;
		}
		if (k === "properties" && v && typeof v === "object") out.properties = Object.fromEntries(Object.entries(v as object).map(([name, p]) => [name, leanSchema(p, texts, depth + 1)]));
		else if (k === "items" || k === "anyOf" || k === "oneOf") out[k] = leanSchema(v, texts, depth + 1);
		else out[k] = v;
	}
	return out;
}

/** One declaration, short. */
export function shortTool(name: string, description: string, parameters: any): { description: string; parameters: any } {
	if (AS_IS.includes(name)) return { description, parameters };
	// A session that may put a command into the background is told how; one that may not is not told of it.
	const more = name === "bash" && parameters?.properties?.background ? " For a command that takes long or does not end by itself (a build, tests, an install, a server) set background: true: the call returns at once and pine tells you when the command has ended." : "";
	return { description: `${SHORT[name] ?? lead(description, 200)}${more}`, parameters: leanSchema(parameters, name in SHORT ? "first" : "all") };
}

/** The order tools are declared in: see shortDeclarations. */
const FIRST = ["read", "bash", "edit", "write", "grep", "find", "ls", "download", "manual", "question", "todo", FIND_TOOLS];
const LAST = ["pine_list", "pine_other", "pine_mcp", "pine_skills", "pine_sources", "pine_schedules", "subagent", "delegate", "pine_agents", "pine_settings"];

/**
 * The request as it goes to the model server: every tool's declaration short, and all of them
 * in one order. `asIs` names tools whose declaration is somebody else's to write (the families).
 *
 * The order: pi declares tools in the order they became active, which differs between
 * conversations (one that goes on from its file, one that is new) and with the order MCP
 * servers connected in. The same tools then made a different request, and a model server read
 * all of it again. Here: first what every session on a model has in the same words (the
 * built-in tools, pine's everyday ones, the MCP servers), then what differs with who is asking
 * (a sub-agent has less, the main agent more), the most widely held first.
 */
export function shortDeclarations(payload: any, asIs: Set<string> = new Set()): any {
	if (!payload || !Array.isArray(payload.tools)) return payload;
	const nameOf = (t: any): string => t?.function?.name ?? t?.name ?? "";
	const rank = (t: any) => (FIRST.includes(nameOf(t)) ? FIRST.indexOf(nameOf(t)) : LAST.includes(nameOf(t)) ? 3000 + LAST.indexOf(nameOf(t)) : nameOf(t).startsWith("mcp__") ? 2000 : 1000);
	const ordered = [...payload.tools].sort((a: any, b: any) => rank(a) - rank(b) || (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0));
	return {
		...payload,
		tools: ordered.map((t: any) => {
			if (asIs.has(nameOf(t))) return t;
			if (t?.function?.name) return { ...t, function: { ...t.function, ...shortTool(t.function.name, t.function.description ?? "", t.function.parameters) } };
			if (t?.name && t.input_schema) {
				const s = shortTool(t.name, t.description ?? "", t.input_schema);
				return { ...t, description: s.description, input_schema: s.parameters };
			}
			return t;
		}),
	};
}

// ---- Arguments that are nearly right --------------------------------------------------------------
//
// A call that says what is meant in slightly other words is carried out, not sent back: every
// refusal for a detail costs a model call. Only what has one reading is taken that way.

/** Other names an option is given, by source type: what a model writes when it has not read the long description. */
const OTHER_NAMES: Record<string, Record<string, string>> = {
	"add_source.folder": { path: "dir", folder: "dir", directory: "dir", glob: "mask", filter: "mask", match: "mask", files: "mask" },
	"add_source.http": { address: "url", link: "url", uri: "url", interval: "every" },
	"add_source.command": { command: "run", cmd: "run", interval: "every" },
	"add_source.mqtt": { broker: "url", address: "url", topic: "topics" },
};
const SCOPES: Record<string, string> = { conversation: "local", this: "local", here: "local", session: "local", me: "agent", self: "agent", mine: "agent", all: "global", everyone: "global", everybody: "global" };
/** Tools that keep something under a name, with the argument that holds it and what joins its words. */
const NAMED: Record<string, [arg: string, joint: string]> = { add_schedule: ["name", "-"], add_source: ["name", "-"], add_route: ["name", "-"], create_agent: ["id", "-"], add_skill: ["name", "-"], add_mcp_server: ["name", "_"] };

/** Make arguments that have one reading into what the tool takes. Changes `args` in place and returns it. */
export function ease(name: string, args: any): any {
	if (!args || typeof args !== "object") return args;
	const local = name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
	if (local === "add_source") {
		if (typeof args.options === "string") {
			try {
				args.options = JSON.parse(args.options);
			} catch {
				// said as it is by the tool
			}
		}
		const other = OTHER_NAMES[`add_source.${args.type}`];
		if (other && args.options && typeof args.options === "object") {
			for (const [k, to] of Object.entries(other)) {
				if (k in args.options && !(to in args.options)) {
					args.options[to] = args.options[k];
					delete args.options[k];
				}
			}
		}
		// The type, left out, where the options say it: a folder is watched by "dir", a command by "run".
		if ((args.type === undefined || args.type === "") && args.options && typeof args.options === "object") {
			const by: Array<[string, string]> = [["dir", "folder"], ["run", "command"], ["topics", "mqtt"], ["url", "http"]];
			const fits = by.filter(([k]) => k in args.options && !(k === "url" && !/^https?:/i.test(String(args.options.url))));
			if (fits.length === 1) args.type = fits[0][1];
		}
		// Its name, left out: the last part of the folder or the host of the address, which is what an owner would call it.
		if ((args.name === undefined || args.name === "") && args.options && typeof args.options === "object") {
			const o = args.options;
			let from = "";
			if (typeof o.dir === "string") from = o.dir.replace(/\/+$/, "").split("/").pop() ?? "";
			else if (typeof o.url === "string") from = o.url.replace(/^[a-z]+:\/\//i, "").split(/[/:?]/)[0].replace(/^www\./, "");
			else if (typeof o.run === "string") from = o.run.trim().split(/\s+/)[0].split("/").pop() ?? "";
			const slug = from.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 40);
			if (slug) args.name = slug;
		}
		// What it reports, in a line: left out, it is said from what is watched. (A family cannot require an
		// argument of one action alone, and this is the one a model leaves out.)
		if ((args.description === undefined || args.description === "") && typeof args.type === "string") {
			const o = args.options && typeof args.options === "object" ? args.options : {};
			const what = [o.dir, o.url, o.run, o.topics, o.port].find((v) => v !== undefined && v !== "");
			args.description = `${args.type}${what === undefined ? "" : `: ${Array.isArray(what) ? what.join(", ") : String(what)}`}`.slice(0, 200);
		}
	}
	if (local === "create_agent" && typeof args.model === "string" && /^(default|pine'?s default|)$/i.test(args.model.trim())) delete args.model;
	// A setting by the end of its name, when only one ends so.
	if (local === "set_setting" && typeof args.key === "string" && !(args.key in SETTINGS)) {
		const fits = Object.keys(SETTINGS).filter((k) => k.toLowerCase().endsWith(`.${args.key.toLowerCase()}`) || k.toLowerCase() === args.key.toLowerCase());
		if (fits.length === 1) args.key = fits[0];
	}
	// A name as the owner would say it ("Check mail") is made into the form the tool keeps ("check-mail").
	const named = NAMED[local];
	if (named && typeof args[named[0]] === "string" && /[^a-z0-9_-]/.test(args[named[0]])) {
		const sep = named[1];
		const slug = args[named[0]].trim().toLowerCase().replace(/[^a-z0-9]+/g, sep).replace(new RegExp(`^[^a-z]+|\\${sep}+$`, "g"), "");
		if (slug) args[named[0]] = slug;
	}
	if (typeof args.scope === "string" && ["subscribe", "unsubscribe", "add_source", "add_schedule", "add_skill", "add_mcp_server"].includes(local) && SCOPES[args.scope.toLowerCase()]) args.scope = SCOPES[args.scope.toLowerCase()];
	return args;
}

/** Arguments made to fit a schema where the difference is one of form: a number as text, one value where a list is taken, a choice in other letters, an object as JSON text, a key in other spelling. */
export function fit(schema: any, args: any): any {
	if (!schema || typeof schema !== "object" || !args || typeof args !== "object" || Array.isArray(args)) return args;
	const props = (schema.properties ?? {}) as Record<string, any>;
	const plain = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
	for (const key of Object.keys(args)) {
		if (key in props) continue;
		const same = Object.keys(props).filter((p) => plain(p) === plain(key) && !(p in args));
		if (same.length === 1) {
			args[same[0]] = args[key];
			delete args[key];
		}
	}
	for (const [key, raw] of Object.entries(props)) {
		if (!(key in args)) continue;
		const variants = ((raw.anyOf ?? raw.oneOf) as any[] | undefined)?.filter((v) => v?.type !== "null");
		const s = variants?.length === 1 ? { ...raw, ...variants[0] } : raw;
		const choices: unknown[] | undefined = s.enum ?? (variants && variants.every((v) => typeof v?.const === "string") ? variants.map((v) => v.const) : undefined);
		let v = args[key];
		if (typeof v === "string") {
			const t = v.trim();
			if ((s.type === "number" || s.type === "integer") && t !== "" && !Number.isNaN(Number(t))) v = Number(t);
			else if (s.type === "boolean" && /^(true|false)$/i.test(t)) v = t.toLowerCase() === "true";
			else if ((s.type === "object" || s.type === "array") && /^[[{]/.test(t)) {
				try {
					v = JSON.parse(t);
				} catch {
					// left as it is
				}
			}
			if (typeof v === "string" && choices && !choices.includes(v)) {
				const hit = choices.filter((c) => typeof c === "string" && c.toLowerCase() === t.toLowerCase());
				if (hit.length === 1) v = hit[0];
			}
		}
		if (s.type === "array" && v !== undefined && v !== null && !Array.isArray(v)) v = [v];
		// A list where the tool takes its items in one text, separated by commas (pine's own tools do).
		if (s.type === "string" && Array.isArray(v) && v.every((x) => typeof x === "string")) v = v.join(", ");
		if (v === null && !(raw.anyOf ?? raw.oneOf ?? []).some((x: any) => x?.type === "null") && !(schema.required ?? []).includes(key)) {
			delete args[key];
			continue;
		}
		if (s.type === "object" && v && typeof v === "object") v = fit(s, v);
		args[key] = v;
	}
	return args;
}

/** Words of a failed call that mean "the arguments were wrong", as pi and pine's tools say it. */
const WRONG_ARGS = /^Validation failed for tool|do not fit|there is no (setting|option|source type)|is missing|must be one of|give exactly one|unknown (option|key|type)/i;

// ---- Families ----------------------------------------------------------------------------------

interface Family {
	id: string;
	name: string;
	about: string;
	/** For a server: the prefix its tools carry ("mcp__browser__"). */
	prefix?: string;
	/** For one of pine's bundled servers: which ("browser"). */
	kind?: string;
	members: Tool[];
	action: Map<string, Tool>;
	/** The name of the argument that says which tool is meant: "action", or another word where a member takes "action" itself. */
	key: string;
	schema: any;
	description: string;
}

/**
 * The families of a session: one tool per group, the tool that gives a tool's whole text, and
 * the extension that puts them into the request. `leaf`: the session is a sub-agent, which is
 * declared what its conversation is declared (so that the model server reads on from what it
 * has kept) and is told so when it calls what is not its to do.
 */
export function families(opts: { servers: Array<{ name: string; namespace: string; kind?: string; about?: string }>; leaf?: boolean }) {
	const fams = new Map<string, Family>();
	const taken = new Set<string>([...DECLARED, ...GROUPS.map(([, name]) => name)]);
	for (const [id, name, about] of GROUPS) fams.set(id, { id, name, about, members: [], action: new Map(), key: "action", schema: undefined, description: "" });
	for (const sv of opts.servers) {
		if (DECLARED_SERVERS.includes(sv.kind ?? "")) continue;
		// Named as the server's tools are: "my-notes", whose tools are mcp__my_notes__..., is "my_notes".
		const plain = sv.namespace.replace(/^mcp__/, "");
		const name = taken.has(plain) ? `mcp_${plain}` : plain;
		taken.add(name);
		fams.set(`server:${sv.name}`, { id: `server:${sv.name}`, name, about: sv.about ?? `The MCP server ${sv.name}.`, prefix: `${sv.namespace}__`, kind: sv.kind, members: [], action: new Map(), key: "action", schema: undefined, description: "" });
	}
	const own = new Map(GROUPS.flatMap(([id, , , names]) => names.map((n) => [n, id] as const)));
	const familyOf = (t: Tool): Family | undefined => {
		for (const f of fams.values()) if (f.prefix && t.name.startsWith(f.prefix)) return f;
		const id = own.get(t.name);
		return id ? fams.get(id) : undefined;
	};
	const names = new Set([...fams.values()].map((f) => f.name));
	let known: Tool[] = [];

	/** An argument as the family declares it: its type and choices, and a few words where they are needed. */
	const argOf = (f: Family, t: Tool, k: string, v: any): any => {
		if (CHOICES[`${t.name}.${k}`]) return { type: "string", enum: CHOICES[`${t.name}.${k}`] };
		// "One of: folder, mqtt, ..." in the tool's words is a choice here.
		const oneOf = typeof v?.description === "string" && v.type === "string" ? v.description.match(/^One of: ([\w, -]+)$/) : null;
		if (oneOf) return { type: "string", enum: oneOf[1].split(",").map((x: string) => x.trim()) };
		if (!f.prefix && k === "agent" && t.name !== "add_route") return { type: "string", description: "another agent's id: do it for that agent, not for yourself" };
		if (!f.prefix && k === "conversation") return { type: "string" };
		// Whom something is for is one of a few, and the tools say so in words that change with the conversation.
		// Only the main agent sets things up for all agents: the choice is there for whom the tool itself names it to.
		if (!f.prefix && k === "scope") {
			const all = /global/.test(String(v?.description ?? ""));
			return { type: "string", enum: [...(t.name === "unsubscribe" ? ["local", "agent", "all"] : ["local", "agent"]), ...(all ? ["global"] : [])], description: `whom it is for; leave it out unless your owner says it is for you as an agent${all ? ", or for all agents" : ""}` };
		}
		const lean = leanSchema(v, "none", 1);
		const hint = ARG_HINT[`${t.name}.${k}`];
		return hint ? { ...lean, description: hint } : lean;
	};

	const build = (f: Family) => {
		f.action = new Map();
		// An action is called what the tool is called (for a server's tool, without the server's prefix): the
		// names the manual and the tools' own answers use.
		for (const t of f.members) f.action.set(f.prefix ? t.name.slice(f.prefix.length) : t.name, t);
		// The argument that says which tool is meant must not be one a member takes itself.
		const used = new Set(f.members.flatMap((t) => Object.keys(t.parameters?.properties ?? {})));
		const several = f.id === "lists";
		f.key = several ? "what" : (["action", "tool", "call", "which"].find((k) => !used.has(k)) ?? "action");
		const props: Record<string, any> = { [f.key]: several ? { type: "array", items: { type: "string", enum: [...f.action.keys()] } } : { type: "string", enum: [...f.action.keys()] } };
		// What is said about an argument, and by which actions: argument -> words -> actions.
		const said = new Map<string, Map<string, string[]>>();
		// The values an argument can take, and for which actions: argument -> values -> actions.
		const choices = new Map<string, Map<string, string[]>>();
		const takes = new Map<string, number>();
		let forOthers = false;
		for (const [action, t] of f.action) {
			for (const [k, v] of Object.entries(t.parameters?.properties ?? {}) as Array<[string, any]>) {
				if (k === "agent" || k === "conversation") forOthers = true;
				const { description, ...now } = argOf(f, t, k, v);
				takes.set(k, (takes.get(k) ?? 0) + 1);
				const values = choices.get(k) ?? new Map<string, string[]>();
				choices.set(k, values);
				const these = Array.isArray(now.enum) ? now.enum.join(", ") : "";
				values.set(these, [...(values.get(these) ?? []), action]);
				if (description) {
					const words = said.get(k) ?? new Map<string, string[]>();
					said.set(k, words);
					words.set(description, [...(words.get(description) ?? []), action]);
				}
				const had = props[k];
				if (!had) props[k] = now;
				else if (JSON.stringify(had) !== JSON.stringify(now)) props[k] = Array.isArray(had.enum) && Array.isArray(now.enum) ? { type: "string", enum: [...new Set([...had.enum, ...now.enum])] } : {};
			}
		}
		// An argument that means one thing in every action says it once. One that two actions use differently
		// ("instructions" of a new agent, and of a change to one) says it for each: left unsaid, a model fills it
		// with too little and makes up for that with calls nobody asked for.
		for (const [k, words] of said) {
			const all = [...words];
			if (k === "scope") props[k] = { ...props[k], description: all.map(([d]) => d).sort((a, b) => b.length - a.length)[0] };
			else if (all.length === 1 && all[0][1].length === takes.get(k)) props[k] = { ...props[k], description: all[0][0] };
			else props[k] = { ...props[k], description: all.map(([d, actions]) => `${actions.join(", ")}: ${d}`).join(". ") };
		}
		// An argument that takes other values in one action than in another is declared with all of them, which is
		// all a declaration can say; which belong to which action is said in words, or a model takes one of another's.
		for (const [k, values] of choices) {
			const real = [...values].filter(([v]) => v);
			if (real.length < 2) continue;
			const which = real.map(([v, actions]) => `${actions.join(", ")}: ${v}`).join("; ");
			props[k] = { ...props[k], description: props[k]?.description ? `${props[k].description}. ${which}` : which };
		}
		f.schema = { type: "object", properties: props, required: [f.key] };
		const line = (action: string, t: Tool) => {
			const p = Object.keys(t.parameters?.properties ?? {}).filter((k) => k !== "agent" && k !== "conversation");
			const req = new Set<string>(t.parameters?.required ?? []);
			const sig = [...p.filter((k) => req.has(k)), ...p.filter((k) => !req.has(k)).map((k) => `${k}?`)].join(", ");
			return `- ${action}(${sig}): ${BRIEF[t.name] ?? (f.kind === "browser" ? BROWSER_BRIEF[t.name.slice(f.prefix!.length)] : undefined) ?? firstSentence(t.description, 100)}`;
		};
		const about = /[.!?]$/.test(f.about.trim()) ? f.about.trim() : `${f.about.trim()}.`;
		if (several) {
			f.description = `${about} Give "what": one of these, or several at once. When your owner asks for a change and a list ("add this, and show me what else there is"), call it in the same answer as the tool that makes the change.\n${[...f.action].map(([a, t]) => `- ${a}: ${BRIEF[t.name] ?? firstSentence(t.description, 100)}`).join("\n")}${forOthers ? '\nFor what another agent has (its sources, schedules, MCP servers, skills), give "agent": X.' : ""}`;
			return;
		}
		f.description = `${about} Give "${f.key}" and the arguments of that ${f.key === "action" ? "action" : "tool"} (? marks an optional one). Two actions are two calls, which can go in one answer:\n${[...f.action].map(([a, t]) => line(a, t)).join("\n")}${forOthers ? '\nTo do one of these for another agent (your owner wants agent X to watch, to be woken, to have a skill), give "agent": X.' : ""}`;
	};

	const prepare = (f: Family) => (loadout: any) => {
		const declared = loadout.declared as Tool[];
		f.members = declared.filter((t) => !names.has(t.name) && familyOf(t) === f);
		known = declared.filter((t) => !names.has(t.name) && familyOf(t) !== undefined);
		build(f);
		// A family that has nothing is not declared. (A sub-agent's request is given its conversation's declarations in agents.ts.)
		return { hiddenDeclarations: [...f.members.map((t) => t.name), ...(f.members.length ? [] : [f.name])], descriptions: { [f.name]: f.description } };
	};

	/** The list tool: every list that was asked for, one after the other, each by its own tool. */
	const lists = (f: Family) => async (id: string, p: any, signal: any, onUpdate: any, ctx: any) => {
		const asked = [p?.what, p?.action, p?.list, p?.lists].flatMap((v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\s]+/) : [])).map((x) => String(x).trim()).filter(Boolean);
		const whats = [...new Set(asked)];
		if (!whats.length) throw new Error(`${f.name} needs "what": one or several of ${[...f.action.keys()].join(", ")}.`);
		// One list, or something that is no list: as any family does it, also for an action of another family.
		if (whats.length === 1) return run(f)(id, { ...p, what: whats[0] }, signal, onUpdate, ctx);
		const parts: Array<{ what: string; text: string; failed: boolean; content: any[] }> = [];
		for (const what of whats) {
			try {
				const r: any = await run(f)(id, { ...p, what }, signal, onUpdate, ctx);
				parts.push({ what, failed: false, content: r?.content ?? [], text: "" });
			} catch (e) {
				parts.push({ what, failed: true, content: [], text: e instanceof Error ? e.message : String(e) });
			}
		}
		if (parts.every((x) => x.failed)) throw new Error(parts.map((x) => `${x.what}: ${x.text}`).join("\n\n"));
		return { content: parts.flatMap((x) => [{ type: "text", text: `## ${x.what}${x.failed ? `\n${x.text}` : ""}` }, ...x.content]), details: {} };
	};

	const run = (f: Family) => async (_id: string, p: any, signal: any, onUpdate: any, ctx: any) => {
		const wanted = String((Array.isArray(p?.[f.key]) ? p[f.key][0] : p?.[f.key]) ?? [p?.action, p?.tool].find((x) => typeof x === "string" && f.action.has(x)) ?? "").trim();
		const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
		const find = (g: Family) => g.action.get(wanted) ?? [...g.action].find(([a, m]) => plain(a) === plain(wanted) || m.name === wanted || plain(m.name.replace(/^mcp__/, "")) === plain(wanted))?.[1];
		let t = find(f);
		// An action of another family, asked of this one: a tool's answer names the action ("mcp_servers lists them")
		// and not its family. There is one tool of that name, so it is carried out, and the call is not sent back.
		if (!t && wanted) {
			const others = [...fams.values()].filter((g) => g !== f && find(g));
			if (others.length === 1) t = find(others[0]);
		}
		if (!t) throw new Error(opts.leaf ? NOT_A_SUBAGENTS : `${f.name} has no ${f.key} "${wanted}". It has: ${[...f.action.keys()].join(", ")}.`);
		const mine = Object.keys(t.parameters?.properties ?? {});
		let args: Record<string, unknown> = {};
		const stray: string[] = [];
		for (const [k, v] of Object.entries(p ?? {})) {
			if (k === f.key || (f.id === "lists" && ["action", "list", "lists"].includes(k)) || (["action", "tool", "call", "which"].includes(k) && !mine.includes(k) && typeof v === "string" && f.action.has(v))) continue;
			if (mine.includes(k)) args[k] = v;
			// An argument of another action of the family, filled in because the declaration has it: named, not passed on.
			else if (v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) stray.push(k);
		}
		args = ease(t.name, fit(t.parameters, args));
		const outcome = await ctx.executeTool(t.name, args, { signal, onUpdate });
		const strayNote = stray.length ? `\n[${wanted} does not take ${stray.join(", ")}: left out.]` : "";
		if (!outcome.isError) {
			if (!strayNote) return outcome.result;
			return { ...outcome.result, content: [...(outcome.result?.content ?? []), { type: "text", text: strayNote }] };
		}
		const said = (outcome.result?.content ?? []).map((c: any) => (c.type === "text" ? c.text : "")).join("\n").trim();
		// Wrong arguments: say what the tool takes, so that the next call is right. A refusal is left as it is.
		const wrongArgs = WRONG_ARGS.test(said) && !/not approved|refused|denied|not done \(/i.test(said);
		throw new Error(`${said || `${wanted} failed`}${strayNote}${wrongArgs ? `\n\nWhat ${wanted} takes, in full:\n${helpOf(t, wanted)}` : ""}`);
	};

	const tools = [...fams.values()].map((f) =>
		defineTool({
			name: f.name,
			label: f.name,
			description: f.about,
			// What the model is held to is the family's own schema, put into the request by the extension below.
			parameters: Type.Object({}, { additionalProperties: true }),
			prepareLoadout: prepare(f),
			execute: (f.id === "lists" ? lists(f) : run(f)) as any,
		}),
	);

	const list = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]).map(String).map((x) => x.trim()).filter(Boolean);
	const details = defineTool({
		name: FIND_TOOLS,
		label: "Tool details",
		description: 'Everything about an action of one of your tools: what each argument takes, its limits, examples. For when the line in the tool\'s description is not enough. "names": actions ("add_source", "click") or a whole tool ("browser").',
		parameters: Type.Object({ names: Type.Union([Type.String(), Type.Array(Type.String())]) }),
		execute: async (_id, p) => {
			const out: string[] = [];
			const missing: string[] = [];
			let used = 0;
			const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
			for (const n of list(p.names)) {
				const fam = [...fams.values()].find((f) => f.name === n || f.id === n || f.id === `server:${n}`);
				// (a family by its name, by pine's word for the group, or by the server's name)
				const hits = fam ? fam.members : known.filter((t) => t.name === n || plain(t.name).endsWith(plain(n)));
				if (!hits.length) missing.push(n);
				for (const t of hits) {
					const f = familyOf(t);
					const a = f ? ([...f.action].find(([, m]) => m === t)?.[0] ?? t.name) : t.name;
					const h = helpOf(t, f ? `${f.name}, ${f.key} "${a}"` : t.name);
					if (out.length && used + h.length > 9000) continue;
					out.push(h);
					used += h.length;
				}
			}
			if (!out.length) return { content: [{ type: "text" as const, text: `Nothing is called ${missing.join(", ") || "that"}. The actions are listed in the descriptions of your tools.` }], details: {} };
			return { content: [{ type: "text" as const, text: out.join("\n\n") }], details: {} };
		},
	});

	const extension = (pi: any) => {
		pi.on("before_provider_request", (e: any) => {
			const payload = shortDeclarations(e.payload, names);
			if (!Array.isArray(payload?.tools)) return payload;
			return {
				...payload,
				tools: payload.tools.map((t: any) => {
					const f = [...fams.values()].find((x) => x.name === (t?.function?.name ?? t?.name));
					if (!f || !f.schema) return t;
					return t.function ? { ...t, function: { ...t.function, description: f.description, parameters: f.schema } } : { ...t, description: f.description, input_schema: f.schema };
				}),
			};
		});
		// A call the model made of a tool that is declared by itself: eased like one through a family.
		pi.on("tool_call", (e: any) => {
			ease(e.toolName, e.input);
			return undefined;
		});
		pi.on("tool_result", (e: any) => {
			if (!e.isError || !e.toolName || e.parentToolCallId || names.has(e.toolName)) return undefined;
			const said = (e.content ?? []).map((c: any) => (c.type === "text" ? c.text : "")).join("\n");
			if (!WRONG_ARGS.test(said)) return undefined;
			const t = pi.getAllTools().find((x: any) => x.name === e.toolName);
			return t ? { content: [...e.content, { type: "text", text: `\nWhat ${e.toolName} takes, in full:\n${helpOf(t, e.toolName)}` }] } : undefined;
		});
	};
	for (const n of names) ROUTERS.add(n);
	return { tools: [...tools, details], extension, names: [...names] };
}
