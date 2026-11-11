import net from "node:net";
import { Type } from "typebox";
import { type Agent, fetch } from "undici";
import { isLocalName, isPrivateAddress, publicOnlyAgent } from "../net.ts";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { errText, getPath, parseDuration } from "../util.ts";
import { clip, found, harmless, lineDiff, pageText, pattern, shown } from "../watching.ts";

/**
 * A web address, looked at again and again: reports when what it answers changes, and when it
 * stops or starts answering. For pages and services that cannot call you: a price, a version, a
 * status page, a device with a state page on your network.
 *
 * options: { url, every?, path?, match?, headers?, token?, tokenHeader?, local? }
 *   every        how often to look ("5m" by default)
 *   path         for a JSON answer: watch only this field ("data.price")
 *   match        for a page or text: watch only what this regular expression finds
 *   headers      headers to send
 *   token        sent as "Authorization: Bearer <token>", or as it is in the header `tokenHeader`
 *   local        the address is on the owner's own network, under a name that does not say so
 *
 * event "changed": { url, value, previous }           with path or match
 *                  { url, added, removed, more? }     without: the lines that are new and gone
 * event "down":    { url, error, looks }              after three failed looks in a row
 * event "up":      { url }                            when it answers again
 *
 * The first look is the starting point and reports nothing.
 */
const MIN = 30_000;
const DOWN_AFTER = 3;
const MAX_BODY = 1024 * 1024;
const TIMEOUT = 20_000;
/**
 * Whether an address says by itself that it is on this computer or the local network. Such an
 * address the owner confirmed as what it is. Any other one must stay on the public internet: a
 * name that one day points into the local network is not followed there.
 */
const isLocal = (url: URL) => {
	const host = url.hostname.replace(/^\[|\]$/g, "");
	return isLocalName(host) || (net.isIP(host) !== 0 && isPrivateAddress(host));
};

/** Why a look failed, in words: what lies behind "fetch failed". */
const reason = (e: unknown, url: URL) => {
	const text = errText((e as any)?.cause ?? e);
	return /resolves to a private address/.test(text) ? `${url.hostname} leads to an address on your own network. If that is meant, set the source up again with "local": true` : text;
};

/** Headers that carry a secret. Those go into `token`, which is kept out of the configuration. */
const SECRET_HEADERS = ["authorization", "proxy-authorization", "cookie"];

export const type: SourceType = {
	summary: "a web address looked at again and again: reports when what it answers changes (the whole page, or one value in it: a price, a version, a state), and when it stops or starts answering. For pages and services that cannot call you",
	options: Type.Object(
		{
			url: Type.String({ description: "the address to look at, https://... (http:// for a device on the local network)" }),
			every: Type.Optional(Type.String({ description: 'how often to look, e.g. "5m", "1h". Default "5m", at least "30s"' })),
			path: Type.Optional(Type.String({ description: 'for an answer in JSON: watch only this field, e.g. "data.price" or "items.0.state"' })),
			match: Type.Optional(Type.String({ description: 'for a page or text: watch only what this regular expression finds (its first group, if it has one), e.g. "Price: ([0-9.,]+)". Without path or match the whole text counts, and a page that shows the time or a counter changes at every look' })),
			headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'headers to send, e.g. {"accept": "application/json"}. Not for secrets' })),
			token: Type.Optional(Type.String({ description: "an access token or key, if the address wants one. Sent as Authorization: Bearer <token>", secret: true })),
			tokenHeader: Type.Optional(Type.String({ description: 'send the token as this header instead, as it is, e.g. "x-api-key"' })),
			local: Type.Optional(Type.Boolean({ description: "true if the address is on your owner's own network under a name that does not say so (nas.home, ha.lan). Not needed for an IP address, localhost or a .local name" })),
		},
		{ additionalProperties: false },
	),
	plan(o) {
		let url: URL;
		try {
			url = new URL(o.url);
		} catch {
			throw new Error(`"${o.url}" is not an address. It looks like https://example.com/page`);
		}
		if (!["http:", "https:"].includes(url.protocol)) throw new Error("the address must start with https:// or http://");
		if (url.username || url.password) throw new Error('an address with a user name or password in it is not taken: leave it out of the address and name "token" in "ask"');
		const every = o.every ?? "5m";
		if (parseDuration(every) < MIN) throw new Error('"every" must be at least "30s"');
		if (o.path && o.match) throw new Error('"path" is for an answer in JSON, "match" for a page or text: give one of them');
		if (o.match) pattern(o.match);
		const secret = Object.keys(o.headers ?? {}).filter((h) => SECRET_HEADERS.includes(h.toLowerCase()));
		if (secret.length) throw new Error(`the header ${secret.join(", ")} carries a secret: leave it out, name "token" in "ask" and give "tokenHeader": "${secret[0].toLowerCase()}"`);
		if (o.tokenHeader && !/^[A-Za-z0-9-]+$/.test(o.tokenHeader)) throw new Error('"tokenHeader" is the name of a header, e.g. "x-api-key"');
		const what = o.path ? `the field ${o.path} of what it answers` : o.match ? `what /${o.match}/ finds in it` : "what it answers";
		return {
			options: { ...o, url: url.href },
			does: [`ask ${clip(url.href, 160)}${o.local || isLocal(url) ? " (an address on your own network or this computer)" : ""} every ${every} and report when ${what} changes, and when it stops or starts answering`, ...(o.token ? [`with the token given, sent only to ${url.host}`] : [])],
			opens: true,
			tell: "Its first look is the starting point and reports nothing; from then on only a change does. The sources tool shows what it found at the last look.",
		};
	},
};

/** One look: the answer's text, at most 1 MB of it. A redirect is followed only on the same host. */
async function get(start: URL, o: Record<string, any>, guard: Agent | undefined, signal: AbortSignal): Promise<{ type: string; body: string }> {
	const headers: Record<string, string> = { ...(o.headers ?? {}) };
	if (o.token) headers[o.tokenHeader ?? "authorization"] = o.tokenHeader ? o.token : `Bearer ${o.token}`;
	let at = start;
	for (let hop = 0; hop < 6; hop++) {
		const res = await fetch(at, { headers, redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]), ...(guard ? { dispatcher: guard } : {}) });
		const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
		if (to) {
			await res.body?.cancel().catch(() => {});
			const next = new URL(to, at);
			// The owner confirmed one host. Another one is another decision, and must not get the token.
			const upgrade = at.protocol === "http:" && next.protocol === "https:";
			if (next.hostname !== start.hostname || (next.protocol !== at.protocol && !upgrade) || (next.port !== at.port && !upgrade)) throw new Error(`it sends on to ${next.host}, which is not the address that was confirmed. If that is the right one, set the source up with it`);
			at = next;
			continue;
		}
		if (!res.ok) {
			await res.body?.cancel().catch(() => {});
			throw new Error(`it answered ${res.status}`);
		}
		const chunks: Buffer[] = [];
		let size = 0;
		const reader = res.body?.getReader();
		while (reader) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(Buffer.from(value.subarray(0, MAX_BODY - size)));
			size += value.length;
			if (size >= MAX_BODY) {
				await reader.cancel().catch(() => {});
				break;
			}
		}
		return { type: res.headers.get("content-type") ?? "", body: Buffer.concat(chunks).toString("utf8") };
	}
	throw new Error("it sends on and on (more than five redirects)");
}

export default function http(source: SourceApi): void {
	const o = source.options;
	if (typeof o.url !== "string") throw new Error(`needs "url": the address to look at`);
	const url = new URL(o.url);
	if (!["http:", "https:"].includes(url.protocol)) throw new Error("the address must start with https:// or http://");
	const re = o.match ? pattern(String(o.match)) : undefined;
	source.secret(o.token);
	const guard = o.local === true || isLocal(url) ? undefined : publicOnlyAgent(TIMEOUT);
	if (guard) source.onStop(() => guard.close());
	// How many looks in a row failed. Whether "down" was said is kept, so that "up" follows it also across a restart.
	let failed = 0;

	source.poll(o.every ?? "5m", async (signal) => {
		let answer: { type: string; body: string };
		try {
			answer = await get(url, o, guard, signal);
		} catch (e) {
			if (signal.aborted) return;
			const why = reason(e, url);
			failed++;
			if (failed === DOWN_AFTER && !source.kv.get("down")) {
				source.kv.set("down", true);
				source.emit("down", { url: o.url, error: why, looks: failed });
			}
			throw new Error(why);
		}
		failed = 0;
		if (source.kv.get("down")) {
			source.kv.set("down", false);
			source.emit("up", { url: o.url });
		}
		const html = /html/i.test(answer.type) || /^\s*<(!doctype html|html)\b/i.test(answer.body);
		let json: unknown;
		if (!html) {
			try {
				json = JSON.parse(answer.body);
			} catch {
				// plain text
			}
		}
		if (o.path || re) {
			let value: unknown = null;
			if (o.path) value = json === undefined ? null : (getPath(json, String(o.path)) ?? null);
			// In what a reader sees first; a pattern that is about the markup finds it in the source.
			else value = (html ? found(re!, pageText(answer.body)) : null) ?? found(re!, answer.body);
			source.status(value === null ? `found nothing ${o.path ? `at ${o.path}` : "with the pattern"}` : `now: ${harmless(value)}`);
			const was = source.changed(value);
			if (was) source.emit("changed", { url: o.url, value: shown(value), previous: shown(was.previous) });
			return;
		}
		const text = (html ? pageText(answer.body) : json !== undefined ? JSON.stringify(json, null, 1) : answer.body).slice(0, 200_000);
		source.status(`now: ${text.split("\n").length} lines`);
		const was = source.changed(text);
		if (!was) return;
		const diff = lineDiff(String(was.previous), text);
		// The same lines in another order are not worth a turn.
		if (diff.added.length || diff.removed.length) source.emit("changed", { url: o.url, ...diff });
	});
}
