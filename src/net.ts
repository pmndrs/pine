import { createHash, randomBytes } from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Agent, fetch } from "undici";

/** Addresses that are not on the public internet: loopback, private ranges, link-local, multicast. */
export function isPrivateAddress(ip: string): boolean {
	if (net.isIPv4(ip)) {
		const [a, b] = ip.split(".").map(Number);
		return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
	}
	const v = ip.toLowerCase();
	if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
	return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff") || v.startsWith("64:ff9b:");
}

/**
 * Connections that refuse private addresses. The check runs when the connection is made, on the
 * address actually used, so a DNS answer that changes between check and use does not help an attacker.
 */
export function publicOnlyAgent(timeoutMs: number, allowPrivate = false): Agent {
	return new Agent({
		connect: {
			lookup: (hostname: string, opts: any, cb: any) =>
				dns.lookup(hostname, { ...opts, all: true }, (err, addrs: any) => {
					if (err) return cb(err);
					const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIPv6(addrs) ? 6 : 4 }];
					if (!allowPrivate && list.some((a: any) => isPrivateAddress(a.address))) return cb(new Error(`${hostname} resolves to a private address`));
					return opts?.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
				}),
		} as any,
		headersTimeout: timeoutMs,
		bodyTimeout: timeoutMs,
	});
}

const isLocalName = (host: string) => host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");

export interface Fetched {
	/** A file with a random name in the system's temp folder. The caller moves or deletes it. */
	file: string;
	url: string;
	bytes: number;
	sha256: string;
	type: string;
	/** Every hop was one of the trusted origins. */
	trusted: boolean;
}

/**
 * Download an address to a temporary file, byte for byte.
 *
 * `trusted` are origins the owner has already connected the caller to (its MCP servers): they are
 * fetched as they are. Any other address is fetched only when `open` is set, and then only over
 * https and never from a private or local address. Redirects are followed by the same rules.
 */
export async function fetchToFile(o: { url: string; trusted: Set<string>; open: boolean | ((host: string) => string | true); allowPrivate?: boolean; maxBytes: number; timeoutMs?: number; signal?: AbortSignal }): Promise<Fetched> {
	const timeoutMs = o.timeoutMs ?? 120_000;
	const check = (raw: string): { url: URL; trusted: boolean } => {
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw new Error("not a valid URL");
		}
		if (url.username || url.password) throw new Error("URLs with credentials are not fetched");
		if (o.trusted.has(url.origin)) return { url, trusted: true };
		const host = url.hostname.replace(/^\[|\]$/g, "");
		// `open` may answer per host, with the reason when it says no.
		const open = typeof o.open === "function" ? o.open(host) : o.open || `${url.host} is not one of your MCP servers, and this conversation has no network access. Ask your owner with request_access (network: true), then try again`;
		if (open !== true) throw new Error(open);
		if (o.allowPrivate) return { url, trusted: false };
		if (url.protocol !== "https:") throw new Error("only https addresses can be downloaded");
		if (isLocalName(host) || (net.isIP(host) && isPrivateAddress(host))) throw new Error("private and local addresses are not fetched");
		return { url, trusted: false };
	};
	const guarded = publicOnlyAgent(timeoutMs, o.allowPrivate);
	const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(o.signal ? [o.signal] : [])]);
	const file = path.join(os.tmpdir(), `pine-dl-${randomBytes(16).toString("hex")}`);
	let allTrusted = true;
	try {
		let { url, trusted } = check(o.url);
		for (let hop = 0; hop < 6; hop++) {
			allTrusted &&= trusted;
			const res = await fetch(url, { ...(trusted ? {} : { dispatcher: guarded }), redirect: "manual", headers: { accept: "*/*", "user-agent": "pine" }, signal });
			if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
				await res.body?.cancel();
				({ url, trusted } = check(new URL(res.headers.get("location")!, url).href));
				continue;
			}
			if (!res.ok) {
				await res.body?.cancel();
				throw new Error(`the server answered HTTP ${res.status}`);
			}
			// "wx": the name is new and random; an existing file or link at that name is an error, not a target.
			const out = fs.openSync(file, "wx", 0o600);
			const hash = createHash("sha256");
			let bytes = 0;
			try {
				if (res.body) {
					for await (const chunk of res.body as any) {
						bytes += chunk.length;
						if (bytes > o.maxBytes) throw new Error(`larger than the limit of ${Math.round(o.maxBytes / 1024 / 1024)} MB`);
						hash.update(chunk);
						fs.writeSync(out, chunk);
					}
				}
			} finally {
				fs.closeSync(out);
			}
			return { file, url: url.href, bytes, sha256: hash.digest("hex"), type: res.headers.get("content-type") ?? "", trusted: allTrusted };
		}
		throw new Error("too many redirects");
	} catch (e) {
		fs.rmSync(file, { force: true });
		throw e;
	} finally {
		void guarded.close().catch(() => {});
	}
}
