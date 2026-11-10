// Bundled MCP server "browser": a real browser (Playwright) for pages that need JavaScript,
// clicks, forms or a login.
//
// This file is a guard around Microsoft's Playwright MCP server, which it starts as a child:
//
//   - Every request the browser makes goes through a small proxy in this process. The proxy
//     refuses private, loopback and link-local addresses (checked on the address it actually
//     connects to), so a page cannot reach your router, your NAS or pine's control port.
//   - Tools that would run code on this machine or read local files are removed from the tool
//     list and refused if called anyway.
//   - The browser's file access is confined to a scratch folder.
//
// Everything a browser returns is outside content; pine marks sessions that use it as tainted.
//
// options: {
//   headed?, profile?, tools?: "core" | "all" | string[], block?: string[],
//   allowHosts?, denyHosts?, allowPrivate?, browser?, executablePath?, caps?, viewport?, extraArgs?
// }
import { spawn } from "node:child_process";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { options } from "./lib.ts";
import { isPrivateAddress } from "./web.ts";

interface BrowserOptions {
	headed?: boolean;
	/** Folder for a persistent profile (cookies, logins). Default: a fresh profile every time. */
	profile?: string;
	tools?: "core" | "all" | string[];
	block?: string[];
	allowHosts?: string[];
	denyHosts?: string[];
	allowPrivate?: boolean;
	browser?: string;
	executablePath?: string;
	caps?: string;
	viewport?: string;
	extraArgs?: string[];
}

/** Never offered: they execute code in this process or hand local files to a page. */
export const ALWAYS_BLOCKED = ["browser_run_code_unsafe", "browser_file_upload", "browser_drop", "browser_install"];
/** Enough to read and operate a page; keeps the tool list short for small models. */
export const CORE_TOOLS = [
	"browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_find", "browser_click", "browser_type", "browser_fill_form",
	"browser_press_key", "browser_select_option", "browser_hover", "browser_wait_for", "browser_tabs", "browser_handle_dialog", "browser_close",
];

export function toolAllowed(name: string, o: Pick<BrowserOptions, "tools" | "block">): boolean {
	if (ALWAYS_BLOCKED.includes(name) || (o.block ?? []).includes(name)) return false;
	const tools = o.tools ?? "core";
	return tools === "all" ? true : (tools === "core" ? CORE_TOOLS : tools).includes(name);
}

const hostMatches = (list: string[] | undefined, host: string) => (list ?? []).some((h) => host === h || host.endsWith(`.${h}`));

/** Resolve a host and return an address the browser may connect to, or throw. */
export async function vet(host: string, o: Pick<BrowserOptions, "allowHosts" | "denyHosts" | "allowPrivate">): Promise<string> {
	const name = host.replace(/^\[|\]$/g, "").toLowerCase();
	if (hostMatches(o.denyHosts, name)) throw new Error(`${name} is on the deny list`);
	if (o.allowHosts?.length && !hostMatches(o.allowHosts, name)) throw new Error(`${name} is not on the allow list`);
	if (!o.allowPrivate && (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".internal"))) throw new Error(`${name} is a local name`);
	const addrs = net.isIP(name) ? [{ address: name }] : await dns.promises.lookup(name, { all: true });
	if (!addrs.length) throw new Error(`${name} does not resolve`);
	if (!o.allowPrivate && addrs.some((a) => isPrivateAddress(a.address))) throw new Error(`${name} is a private address`);
	return addrs[0].address;
}

/** A forward proxy that only lets vetted destinations through. */
export async function startGuardProxy(o: Pick<BrowserOptions, "allowHosts" | "denyHosts" | "allowPrivate">, log: (line: string) => void = () => {}) {
	const refused: string[] = [];
	const deny = (what: string, why: unknown) => {
		const line = `${what}: ${why instanceof Error ? why.message : why}`;
		refused.push(line);
		if (refused.length > 200) refused.shift();
		log(`refused ${line}`);
	};
	const server = http.createServer(async (req, res) => {
		// Plain http through the proxy arrives as an absolute URL.
		let url: URL;
		try {
			url = new URL(req.url ?? "");
			if (url.protocol !== "http:") throw new Error("only http and https are proxied");
			const address = await vet(url.hostname, o);
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
			deny(req.url ?? "?", e);
			res.writeHead(403, { "content-type": "text/plain" }).end(`pine: this address is not reachable from the browser (${e instanceof Error ? e.message : e})`);
		}
	});
	server.on("connect", async (req, client: net.Socket, head) => {
		const m = (req.url ?? "").match(/^(.+):(\d+)$/);
		try {
			if (!m) throw new Error("bad CONNECT target");
			const address = await vet(m[1], o);
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
			const content = fs.readFileSync(real, "utf8");
			const max = /snapshot/i.test(label) ? limit : 2000;
			const body = content.length > max ? `${content.slice(0, max)}\n[cut: ${content.length - max} more characters; use browser_find to locate things on a long page]` : content;
			return `${label}:\n${body.trimEnd()}`;
		} catch {
			return whole;
		}
	});
}

if (import.meta.main) {
	const o = options<BrowserOptions>();
	const cli = path.join(path.dirname(createRequire(import.meta.url).resolve("@playwright/mcp")), "cli.js");
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pine-browser-"));
	const proxy = await startGuardProxy(o, (line) => process.stderr.write(`[pine browser] ${line}\n`));
	const args = [
		cli,
		"--proxy-server", `http://127.0.0.1:${proxy.port}`,
		"--output-dir", scratch,
		"--ignore-roots",
		"--file-paths", "absolute",
		"--block-service-workers",
		"--image-responses", "omit",
		...(o.headed ? [] : ["--headless"]),
		...(o.profile ? ["--user-data-dir", o.profile] : ["--isolated"]),
		// Playwright's own Chromium build by default; "chrome" or "msedge" use an installed browser.
		"--browser", o.browser ?? "chromium",
		...(o.executablePath ? ["--executable-path", o.executablePath] : []),
		...(o.caps ? ["--caps", o.caps] : []),
		...(o.viewport ? ["--viewport-size", o.viewport] : []),
		...(o.extraArgs ?? []),
	];
	const child = spawn(process.execPath, args, { cwd: scratch, stdio: ["pipe", "pipe", "inherit"] });
	const stop = () => {
		child.kill();
		fs.rmSync(scratch, { recursive: true, force: true });
		process.exit(0);
	};
	child.on("exit", stop);
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);

	// Relay the MCP conversation, filtering the tool list and refusing blocked calls.
	// A browser is one page at a time: calls that a model issues in parallel are run one after another,
	// otherwise the second navigation would abort the first.
	const listIds = new Set<unknown>();
	const waiting: any[] = [];
	let inFlight: unknown;
	const next = () => {
		if (inFlight !== undefined || !waiting.length) return;
		const msg = waiting.shift();
		inFlight = msg.id;
		child.stdin.write(`${JSON.stringify(msg)}\n`);
	};
	const toClient = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
	readline.createInterface({ input: process.stdin }).on("line", (line) => {
		if (!line.trim()) return;
		let msg: any;
		try {
			msg = JSON.parse(line);
		} catch {
			return void child.stdin.write(`${line}\n`);
		}
		if (msg.method === "tools/list") listIds.add(msg.id);
		if (msg.method === "tools/call" && !toolAllowed(String(msg.params?.name), o)) {
			return toClient({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `The tool ${msg.params?.name} is not available.` }], isError: true } });
		}
		if (msg.method === "tools/call" && msg.id !== undefined) {
			waiting.push(msg);
			return next();
		}
		child.stdin.write(`${JSON.stringify(msg)}\n`);
	}).on("close", () => child.stdin.end());
	readline.createInterface({ input: child.stdout }).on("line", (line) => {
		if (!line.trim()) return;
		let msg: any;
		try {
			msg = JSON.parse(line);
		} catch {
			return void process.stdout.write(`${line}\n`);
		}
		if (listIds.delete(msg.id) && Array.isArray(msg.result?.tools)) msg.result.tools = msg.result.tools.filter((t: any) => toolAllowed(t.name, o));
		for (const part of msg.result?.content ?? []) if (part.type === "text" && typeof part.text === "string") part.text = inlineFiles(part.text, scratch);
		if (msg.result?.content && proxy.refused.length && msg.result.isError) msg.result.content.push({ type: "text", text: `pine: the browser was refused ${proxy.refused.at(-1)}` });
		toClient(msg);
		if (msg.id !== undefined && msg.id === inFlight) {
			inFlight = undefined;
			next();
		}
	});
}
