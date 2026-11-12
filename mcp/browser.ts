// Bundled MCP server "browser": a real browser (Playwright) for pages that need JavaScript,
// clicks, forms or a login.
//
// This file is a guard around Microsoft's Playwright MCP server, which it starts as a child:
//
//   - Every request the browser makes goes through a small proxy in this process. The proxy
//     refuses private, loopback and link-local addresses (checked on the address it actually
//     connects to), so a page cannot reach your router, your NAS or pine's control port.
//     The one exception is an address the owner allowed for the conversation: the daemon asks
//     them when the agent opens a local address, and writes the yes into `localFile`.
//   - Tools that would run code on this machine or read local files are removed from the tool
//     list and refused if called anyway.
//   - The browser's file access is confined to a scratch folder.
//
//   - The browser has no window unless `headed` is set. In the owner's own conversations the agent
//     can put it on the owner's screen and take it off again (browser_show, browser_hide): the
//     browser is started anew, on the same page, with the same logins.
//
// Everything a browser returns is outside content; pine marks sessions that use it as tainted.
//
// options: {
//   headed?, profile?, tools?: "core" | "all" | string[], block?: string[], images?,
//   allowHosts?, denyHosts?, allowPrivate?, browser?, executablePath?, caps?, viewport?, extraArgs?
// }
import { type ChildProcess, spawn } from "node:child_process";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { options } from "./lib.ts";
import { hostPort, isLocalName, isPrivateAddress } from "../src/net.ts";

interface BrowserOptions {
	headed?: boolean;
	/** Folder for a persistent profile (cookies, logins). Default: a fresh profile every time. */
	profile?: string;
	tools?: "core" | "all" | string[];
	block?: string[];
	/** false: a screenshot comes back without its picture. For a model that cannot see. Default true. */
	images?: boolean;
	allowHosts?: string[];
	denyHosts?: string[];
	allowPrivate?: boolean;
	/**
	 * Set by pine, not by the owner: a file in pine's home with the local addresses ("host:port")
	 * the owner allowed for this conversation. Agents cannot write there.
	 */
	localFile?: string;
	/**
	 * Set by pine, not by the owner: this is one of the owner's own conversations, so the agent may
	 * put the browser on the owner's screen (browser_show, browser_hide).
	 */
	window?: boolean;
	browser?: string;
	executablePath?: string;
	caps?: string;
	viewport?: string;
	extraArgs?: string[];
}

/** Never offered: they execute code in this process or hand local files to a page. */
export const ALWAYS_BLOCKED = ["browser_run_code_unsafe", "browser_file_upload", "browser_drop", "browser_install", "browser_storage_state", "browser_set_storage_state"];
/**
 * This server asks Playwright for its "storage" tools to carry a login from a hidden browser to a
 * visible one. To an agent they are offered only where the owner asked for them (`caps`).
 */
const STORAGE_TOOLS = /^browser_(cookie|localstorage|sessionstorage)_/;
/** pine's own: the browser as a window on the owner's screen. */
export const WINDOW_TOOLS = [
	{
		name: "browser_show",
		description:
			"Open the browser as a window on your owner's screen, on the page you are on, with the same logins. Use it when your owner wants to watch, or has to do something themselves: log in, solve a captcha, confirm a payment. You keep working in the same window. The page is loaded again, so text typed into a form is gone.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "browser_hide",
		description: "Close the browser's window on your owner's screen and carry on without one, on the same page, with the same logins.",
		inputSchema: { type: "object", properties: {} },
	},
];
const isWindowTool = (name: string) => WINDOW_TOOLS.some((t) => t.name === name);
/** Enough to read and operate a page; keeps the tool list short for small models. */
export const CORE_TOOLS = [
	"browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_find", "browser_click", "browser_type", "browser_fill_form",
	"browser_press_key", "browser_select_option", "browser_hover", "browser_wait_for", "browser_tabs", "browser_handle_dialog", "browser_close",
	// To look at a page the way a person does, and to see why it does not work: an agent that builds a page needs both.
	"browser_take_screenshot", "browser_console_messages",
];

export function toolAllowed(name: string, o: Pick<BrowserOptions, "tools" | "block" | "window" | "caps">): boolean {
	if (ALWAYS_BLOCKED.includes(name) || (o.block ?? []).includes(name)) return false;
	if (isWindowTool(name)) return o.window === true;
	if (STORAGE_TOOLS.test(name) && !(o.caps ?? "").split(",").some((c) => c.trim() === "storage")) return false;
	const tools = o.tools ?? "core";
	return tools === "all" ? true : (tools === "core" ? CORE_TOOLS : tools).includes(name);
}

const hostMatches = (list: string[] | undefined, host: string) => (list ?? []).some((h) => host === h || host.endsWith(`.${h}`));

type GuardOptions = Pick<BrowserOptions, "allowHosts" | "denyHosts" | "allowPrivate" | "localFile">;

/** What the agent is told when a local address is refused in a conversation where the owner can be asked. */
export const ASK_HINT = "A local address needs your owner's yes. Open it with browser_navigate (for example http://localhost:3000) and your owner is asked";

/** The local addresses the owner allowed for this conversation. Read each time: a yes applies at once. */
function allowedLocal(o: GuardOptions): string[] {
	if (!o.localFile) return [];
	try {
		const list = JSON.parse(fs.readFileSync(o.localFile, "utf8"));
		return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
	} catch {
		return [];
	}
}

/**
 * Resolve a host and return what the browser may connect to, or throw. For a public name that is
 * the address it resolved to; for a local address the owner allowed (host and port), the host as given.
 */
export async function vet(host: string, o: GuardOptions, port?: number): Promise<string> {
	const name = host.replace(/^\[|\]$/g, "").toLowerCase();
	if (hostMatches(o.denyHosts, name)) throw new Error(`${name} is on the deny list`);
	if (o.allowHosts?.length && !hostMatches(o.allowHosts, name)) throw new Error(`${name} is not on the allow list`);
	if (!o.allowPrivate && (isLocalName(name) || (net.isIP(name) && isPrivateAddress(name)))) {
		// Only a host that is local by its own name can be allowed: a name that has to be looked up
		// could point somewhere else tomorrow.
		if (port !== undefined && allowedLocal(o).includes(hostPort(name, port))) return name;
		throw new Error(`${name} is a ${isLocalName(name) ? "local name" : "private address"}`);
	}
	const addrs = net.isIP(name) ? [{ address: name }] : await dns.promises.lookup(name, { all: true });
	if (!addrs.length) throw new Error(`${name} does not resolve`);
	if (!o.allowPrivate && addrs.some((a) => isPrivateAddress(a.address))) throw new Error(`${name} resolves to a private address`);
	return addrs[0].address;
}

/** A forward proxy that only lets vetted destinations through. */
export async function startGuardProxy(o: GuardOptions, log: (line: string) => void = () => {}) {
	const refused: string[] = [];
	/** Records a refusal and returns the sentence for the agent. */
	const deny = (what: string, why: unknown) => {
		const reason = why instanceof Error ? why.message : String(why);
		// Where the owner can be asked, say how. Elsewhere there is nothing the agent can do.
		const line = `${what}: ${reason}${o.localFile && / is a (local name|private address)$/.test(reason) ? `. ${ASK_HINT}` : ""}`;
		refused.push(line);
		if (refused.length > 200) refused.shift();
		log(`refused ${line}`);
		return line;
	};
	const server = http.createServer(async (req, res) => {
		// Plain http through the proxy arrives as an absolute URL.
		let url: URL;
		try {
			url = new URL(req.url ?? "");
			if (url.protocol !== "http:") throw new Error("only http and https are proxied");
			const address = await vet(url.hostname, o, Number(url.port || 80));
			const headers = { ...req.headers };
			delete headers["proxy-connection"];
			delete headers["proxy-authorization"];
			const upstream = http.request({ host: address, port: Number(url.port || 80), method: req.method, path: url.pathname + url.search, headers: { ...headers, host: url.host } }, (up) => {
				res.writeHead(up.statusCode ?? 502, up.headers);
				up.pipe(res);
			});
			upstream.on("error", () => res.writeHead(502).end());
			req.pipe(upstream);
		} catch (e) {
			res.writeHead(403, { "content-type": "text/plain" }).end(`pine: this address is not reachable from the browser (${deny(req.url ?? "?", e)})`);
		}
	});
	server.on("connect", async (req, client: net.Socket, head) => {
		const m = (req.url ?? "").match(/^(.+):(\d+)$/);
		try {
			if (!m) throw new Error("bad CONNECT target");
			const address = await vet(m[1], o, Number(m[2]));
			const upstream = net.connect(Number(m[2]), address, () => {
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (head.length) upstream.write(head);
				upstream.pipe(client);
				client.pipe(upstream);
			});
			const close = () => (upstream.destroy(), client.destroy());
			upstream.on("error", close);
			client.on("error", close);
		} catch (e) {
			deny(req.url ?? "?", e);
			client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
		}
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	return { port: (server.address() as net.AddressInfo).port, refused, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

/**
 * Playwright writes page snapshots and logs to files and returns links to them. An agent cannot
 * follow those links, so put the content of files from the scratch folder into the result itself.
 */
export function inlineFiles(text: string, scratch: string, limit = 24_000): string {
	const root = fs.realpathSync(scratch);
	return text.replace(/\[([^\]\n]+)\]\((\/[^)\s#]+)(#[^)\s]*)?\)/g, (whole, label, file) => {
		try {
			const real = fs.realpathSync(file);
			if (!real.startsWith(root + path.sep)) return whole;
			const bytes = fs.readFileSync(real);
			// A screenshot or a PDF: the picture itself comes with the result, its bytes are not text.
			if (bytes.subarray(0, 4096).includes(0)) return `${label}: saved as ${real}`;
			const content = bytes.toString("utf8");
			const max = /snapshot/i.test(label) ? limit : 2000;
			const body = content.length > max ? `${content.slice(0, max)}\n[cut: ${content.length - max} more characters; use browser_find to locate things on a long page]` : content;
			return `${label}:\n${body.trimEnd()}`;
		} catch {
			return whole;
		}
	});
}

export interface BrowserServer {
	/** Starts Playwright's server, with a window or without. */
	launch(headed: boolean): ChildProcess;
	/** One message for the client. */
	send(msg: unknown): void;
	/** A folder the browser may write into; a login is kept there for the moment of a restart. */
	scratch: string;
	/** What the guard refused, newest last. */
	refused: string[];
	/** Playwright's server ended by itself. */
	ended(): void;
}

/**
 * The conversation between pine and Playwright's server: the tool list is filtered, blocked calls
 * are refused, calls run one after another, and the browser is restarted when its window is to
 * appear or to go. Returns what takes the client's lines.
 */
export function relay(o: BrowserOptions, io: BrowserServer): { line(line: string): void; close(): void; child(): ChildProcess } {
	let headed = !!o.headed;
	/** The address of the page that is open, to open it again after a restart. */
	let page: string | undefined;
	/** The client's first message, said again to a browser that is started later. */
	let hello: any;
	const retired = new Set<ChildProcess>();
	const own = new Map<string, (msg: any) => void>();
	let ownIds = 0;
	const listIds = new Set<unknown>();
	// A browser is one page at a time: calls that a model issues in parallel are run one after another,
	// otherwise the second navigation would abort the first.
	const waiting: any[] = [];
	let inFlight: any;

	const start = (): ChildProcess => {
		const c = io.launch(headed);
		c.on("exit", () => {
			if (retired.delete(c)) return;
			for (const answer of own.values()) answer({ error: { message: "the browser ended" } });
			io.ended();
		});
		readline.createInterface({ input: c.stdout! }).on("line", (line) => fromBrowser(c, line));
		return c;
	};
	let child = start();
	const write = (msg: unknown) => child.stdin!.write(`${JSON.stringify(msg)}\n`);

	/** A request of this server's own; the answer does not go to the client. */
	const ask = (method: string, params: unknown, ms = 30_000) =>
		new Promise<any>((resolve) => {
			const id = `pine-${++ownIds}`;
			const timer = setTimeout(() => own.get(id)?.({ error: { message: "the browser did not answer" } }), ms);
			own.set(id, (msg) => (clearTimeout(timer), own.delete(id), resolve(msg)));
			write({ jsonrpc: "2.0", id, method, params });
		});
	const textOf = (msg: any) => (msg.result?.content ?? []).filter((p: any) => p.type === "text").map((p: any) => String(p.text)).join("\n") || String(msg.error?.message ?? "");
	const call = async (name: string, args: unknown) => {
		const msg = await ask("tools/call", { name, arguments: args });
		return { ok: !msg.error && !msg.result?.isError, text: inlineFiles(textOf(msg), io.scratch) };
	};

	const next = () => {
		if (inFlight !== undefined || !waiting.length) return;
		inFlight = waiting.shift();
		if (isWindowTool(String(inFlight.params?.name))) return void turn(inFlight);
		write(inFlight);
	};
	const answered = (msg: unknown) => {
		io.send(msg);
		inFlight = undefined;
		next();
	};

	/** Ends the browser and starts it again, with a window or without. */
	const restart = async (window: boolean) => {
		const old = child;
		const gone = new Promise((r) => old.once("exit", r));
		retired.add(old);
		await ask("tools/call", { name: "browser_close", arguments: {} }, 5000);
		old.kill();
		await gone;
		headed = window;
		child = start();
		if (hello) {
			await ask("initialize", hello.params);
			write({ jsonrpc: "2.0", method: "notifications/initialized" });
		}
	};

	/** browser_show and browser_hide. The login goes along in a file that exists only for the restart. */
	const turn = async (msg: any) => {
		const show = msg.params.name === "browser_show";
		const say = (text: string, isError = false) => answered({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } });
		if (headed === show) return say(show ? "The browser is already a window on your owner's screen." : "The browser has no window.");
		const at = page;
		const state = path.join(io.scratch, `state-${process.pid}-${Date.now()}.json`);
		try {
			const kept = at !== undefined && (await call("browser_storage_state", { filename: state })).ok;
			const open = async (window: boolean) => {
				await restart(window);
				if (kept) await call("browser_set_storage_state", { filename: state });
				// A browser that was not told to open anything has no window yet.
				return call("browser_navigate", { url: at ?? "about:blank" });
			};
			let now = await open(show);
			if (show && !now.ok) {
				const why = now.text.split("\n").find((l) => /error/i.test(l) && l.trim().length > 12) ?? now.text.split("\n")[0] ?? "";
				now = await open(false);
				return say(`A window could not be opened on this computer (${why.trim().slice(0, 200)}). The browser carries on without one. If pine runs on a machine without a screen, there is no window to show.\n\n${now.text}`, true);
			}
			say(
				`${show ? "The browser is now a window on your owner's screen. They can use it themselves: log in, solve a captcha, confirm something. Tell them it is open, and when they have to do something, wait until they say they are done. You work in the same window; browser_hide closes it and keeps the logins." : "The window is closed. The browser carries on without one, with the same logins."}\n\n${now.text}`,
			);
		} catch (e) {
			say(`The browser could not be ${show ? "shown" : "hidden"}: ${e instanceof Error ? e.message : String(e)}`, true);
		} finally {
			fs.rmSync(state, { force: true });
		}
	};

	const fromBrowser = (from: ChildProcess, line: string) => {
		if (!line.trim()) return;
		let msg: any;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		const mine = typeof msg.id === "string" ? own.get(msg.id) : undefined;
		if (from !== child) return; // the last words of a browser that was replaced
		for (const part of msg.result?.content ?? []) {
			if (part.type !== "text" || typeof part.text !== "string") continue;
			const url = part.text.match(/^- Page URL: (\S+)/m)?.[1];
			if (url) page = url === "about:blank" ? undefined : url;
		}
		if (mine) return mine(msg);
		if (listIds.delete(msg.id) && Array.isArray(msg.result?.tools)) msg.result.tools = [...msg.result.tools.filter((t: any) => toolAllowed(t.name, o)), ...WINDOW_TOOLS.filter((t) => toolAllowed(t.name, o))];
		const current = inFlight !== undefined && msg.id !== undefined && msg.id === inFlight.id ? inFlight : undefined;
		// A page that is still loading its fonts makes a screenshot give up after five seconds. Once more does it.
		if (current?.params?.name === "browser_take_screenshot" && msg.result?.isError && !current.again && /Timeout/.test(textOf(msg))) {
			current.again = true;
			return void write({ jsonrpc: current.jsonrpc, id: current.id, method: current.method, params: current.params });
		}
		if (current?.params?.name === "browser_close" && !msg.result?.isError) page = undefined;
		for (const part of msg.result?.content ?? []) if (part.type === "text" && typeof part.text === "string") part.text = inlineFiles(part.text, io.scratch);
		if (msg.result?.content && io.refused.length && msg.result.isError) msg.result.content.push({ type: "text", text: `pine: the browser was refused ${io.refused.at(-1)}` });
		if (current) answered(msg);
		else io.send(msg);
	};

	return {
		child: () => child,
		close: () => child.stdin!.end(),
		line(line: string) {
			if (!line.trim()) return;
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				return void child.stdin!.write(`${line}\n`);
			}
			if (msg.method === "initialize") hello = msg;
			if (msg.method === "tools/list") listIds.add(msg.id);
			if (msg.method === "tools/call" && !toolAllowed(String(msg.params?.name), o)) {
				return io.send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `The tool ${msg.params?.name} is not available.` }], isError: true } });
			}
			if (msg.method === "tools/call" && msg.id !== undefined) {
				waiting.push(msg);
				return next();
			}
			write(msg);
		},
	};
}

if (import.meta.main) {
	const o = options<BrowserOptions>();
	const cli = path.join(path.dirname(createRequire(import.meta.url).resolve("@playwright/mcp")), "cli.js");
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pine-browser-"));
	const proxy = await startGuardProxy(o, (line) => process.stderr.write(`[pine browser] ${line}\n`));
	const caps = [...new Set(["storage", ...(o.caps ?? "").split(",").map((c) => c.trim()).filter(Boolean)])].join(",");
	const args = (headed: boolean) => [
		cli,
		"--proxy-server", `http://127.0.0.1:${proxy.port}`,
		"--output-dir", scratch,
		"--ignore-roots",
		"--file-paths", "absolute",
		"--block-service-workers",
		// Tools that a page declares are outside content with a name; none of them is offered.
		"--no-webmcp",
		"--image-responses", o.images === false ? "omit" : "allow",
		...(headed ? [] : ["--headless"]),
		...(o.profile ? ["--user-data-dir", o.profile] : ["--isolated"]),
		// Playwright's own Chromium build by default; "chrome" or "msedge" use an installed browser.
		"--browser", o.browser ?? "chromium",
		...(o.executablePath ? ["--executable-path", o.executablePath] : []),
		"--caps", caps,
		...(o.viewport ? ["--viewport-size", o.viewport] : []),
		...(o.extraArgs ?? []),
	];
	const stop = () => {
		server.child().kill();
		fs.rmSync(scratch, { recursive: true, force: true });
		process.exit(0);
	};
	const server = relay(o, {
		launch: (headed) => spawn(process.execPath, args(headed), { cwd: scratch, stdio: ["pipe", "pipe", "inherit"] }),
		send: (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`),
		scratch,
		refused: proxy.refused,
		ended: () => stop(),
	});
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	readline.createInterface({ input: process.stdin }).on("line", (line) => server.line(line)).on("close", () => server.close());
}
