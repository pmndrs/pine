import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { errText, sleep, truncate } from "../util.ts";

/**
 * A Telegram bot: the owner writes to it from wherever they are, and the agent answers there.
 *
 * options: { token, allow?, approvals?, apiBase? }
 *   token      the bot's token from @BotFather
 *   allow      Telegram user ids that may talk to it. Without it the bot is paired: the first
 *              account that writes to it is put to the owner in pine, who confirms it there
 *   approvals  also send approval requests to that chat, with buttons (default true)
 *   apiBase    a Bot API server of your own instead of api.telegram.org
 *
 * event "message": { text, name, username, chatId, messageId, images? }
 * It can send: { text, chatId? } goes to the owner's chat.
 *
 * Messages are fetched by long polling: one request that Telegram answers the moment something
 * arrives. Nothing listens on a port, so it works behind any router. Only accounts on `allow`, or
 * the one that was paired, are heard; everyone else gets no answer at all. Nothing is ever sent
 * to anyone else.
 */
export const type: SourceType = {
	summary: "a Telegram bot: your owner writes to it from anywhere and you answer there; you can also message them through it. Needs the bot's token from @BotFather",
	talks: true,
	sends: 'a Telegram message to your owner: {"text": "..."}',
	options: Type.Object(
		{
			token: Type.String({ description: "the bot's token, as @BotFather gives it (123456789:AA...)", secret: true }),
			allow: Type.Optional(Type.Array(Type.Number(), { description: "Telegram user ids that may talk to the bot. Leave out unless your owner gave you their id: the bot is then paired, which means the first account that writes to it is shown to your owner in pine to confirm" })),
			approvals: Type.Optional(Type.Boolean({ description: "also send approval requests to the owner there, with buttons to answer them. Default true" })),
			apiBase: Type.Optional(Type.String({ description: "address of a Bot API server of your own, instead of https://api.telegram.org" })),
		},
		{ additionalProperties: false },
	),
	plan(o) {
		if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(String(o.token))) throw new Error("that is not a bot token. @BotFather gives one that looks like 123456789:AAH... when a bot is created with /newbot");
		if (o.apiBase !== undefined) {
			let url: URL;
			try {
				url = new URL(o.apiBase);
			} catch {
				throw new Error(`"${o.apiBase}" is not an address`);
			}
			if (url.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("a Bot API server of your own must be reached over https, or run on this machine");
		}
		const ids: number[] = o.allow ?? [];
		return {
			options: o,
			opens: true,
			owner: true,
			does: [
				"connect to Telegram as your bot and wait for messages",
				ids.length ? `listen only to the Telegram user${ids.length === 1 ? "" : "s"} ${ids.join(", ")}` : "ask you here, in pine, before it listens to anyone: the first account that writes to the bot is shown to you to confirm",
				"take what that account writes as coming from you, with everything your agents may do for you",
				"send answers back to that chat, and nowhere else",
				...(o.approvals === false ? [] : ["send approval requests there too, with buttons"]),
			],
			tell: ids.length ? "Your owner can write to the bot now." : "Tell your owner to open the bot in Telegram and write anything to it. pine then asks them, here and not in Telegram, to confirm that account; after that it is the only one the bot listens to.",
		};
	},
};

const MAX_PHOTO = 10 * 1024 * 1024;

export default async function telegram(source: SourceApi): Promise<void> {
	const o = source.options;
	const token = String(o.token ?? "");
	if (!token) throw new Error("the bot token is missing");
	source.secret(token);
	const base = String(o.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "");
	const stop = new AbortController();
	source.onStop(() => stop.abort());

	const api = async (method: string, body: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<any> => {
		const res = await fetch(`${base}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)]) });
		const json: any = await res.json().catch(() => ({}));
		if (!json.ok) throw new Error(`Telegram refused ${method}: ${json.description ?? res.status}`);
		return json.result;
	};
	// A wrong token is found out here, and shows as the reason the source is not running.
	const me = await api("getMe");
	const mediaDir = path.join(source.dataDir, "media");
	fs.mkdirSync(mediaDir, { recursive: true });
	source.media(mediaDir);

	// ---- who is heard ------------------------------------------------------------------------------
	const fixed: number[] = (Array.isArray(o.allow) ? o.allow : []).map(Number).filter(Number.isFinite);
	const paired = () => source.kv.get<{ id: number; name: string }>("owner");
	const heard = (userId: number) => fixed.includes(userId) || paired()?.id === userId;
	/** The chat everything unasked goes to. A private chat has the id of its user. */
	const ownerChat = () => fixed[0] ?? paired()?.id;

	const send = async (chatId: number, text: string, extra: Record<string, unknown> = {}) => {
		if (!heard(chatId)) throw new Error("that chat is not your owner's");
		const body = text.trim() || "(empty message)";
		let last: any;
		for (let i = 0; i < body.length; i += 4000) last = await api("sendMessage", { chat_id: chatId, text: body.slice(i, i + 4000), ...(i + 4000 >= body.length ? extra : {}) });
		return last;
	};

	// ---- out: answers, and what an agent sends on its own -------------------------------------------
	source.onSend(async (message) => {
		const chatId = Number(message.chatId ?? ownerChat());
		if (!Number.isFinite(chatId)) throw new Error("nobody is connected yet: your owner has to write to the bot once, and confirm it in pine");
		await send(chatId, String(message.text ?? ""));
		return "sent to your owner on Telegram";
	});

	// "typing…" while an agent works on something that will be answered here.
	const typing = new Map<number, NodeJS.Timeout>();
	source.on("agent/+/started", (e) => {
		const p = e.payload as any;
		const chatId = Number(p?.reply?.payload?.chatId);
		if (p?.reply?.topic !== `out/source/${source.key}` || !heard(chatId)) return;
		const tick = () => void api("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
		tick();
		const h = setInterval(tick, 4500);
		h.unref?.();
		typing.set(p.task, h);
	});
	source.on(["agent/+/done", "agent/+/failed"], (e) => {
		const id = (e.payload as any)?.task;
		clearInterval(typing.get(id));
		typing.delete(id);
	});
	source.onStop(() => typing.forEach((h) => clearInterval(h)));

	// ---- approval requests, to answer from the phone ---------------------------------------------------
	if (o.approvals !== false) {
		const asked = new Map<string, number>();
		source.on("approval/requested", async (e) => {
			const r = e.payload as any;
			const chat = ownerChat();
			if (chat === undefined) return;
			const always = r.remember ? [{ text: `Always: ${truncate(String(r.remember), 30)}`, callback_data: `ap:${r.id}:2` }] : [];
			const msg = await send(chat, `Approval needed\nAgent: ${r.agent}${r.task ? ` (task #${r.task})` : ""}\nAction: ${truncate(String(r.summary), 1200)}\nWhy you are asked: ${r.why}`, { reply_markup: { inline_keyboard: [[{ text: "Allow", callback_data: `ap:${r.id}:1` }, ...always, { text: "Deny", callback_data: `ap:${r.id}:0` }]] } });
			if (msg?.message_id) asked.set(r.id, msg.message_id);
		});
		source.on("approval/decided", async (e) => {
			const d = e.payload as any;
			const messageId = asked.get(d.id);
			asked.delete(d.id);
			if (messageId) await api("editMessageReplyMarkup", { chat_id: ownerChat(), message_id: messageId, reply_markup: { inline_keyboard: [[{ text: d.allow ? `Allowed (${d.by})` : `Denied (${d.by})`, callback_data: "noop" }]] } }).catch(() => {});
		});
	}

	// ---- in ----------------------------------------------------------------------------------------
	const photo = async (sizes: any[]): Promise<{ path: string; mimeType: string } | undefined> => {
		const best = sizes.filter((s) => (s.file_size ?? 0) <= MAX_PHOTO).at(-1);
		if (!best) return undefined;
		const file = await api("getFile", { file_id: best.file_id });
		const res = await fetch(`${base}/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
		if (!res.ok) return undefined;
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length > MAX_PHOTO) return undefined;
		const target = path.join(mediaDir, `${String(best.file_unique_id).replace(/[^A-Za-z0-9_-]/g, "")}.jpg`);
		fs.writeFileSync(target, buf, { mode: 0o600 });
		return { path: target, mimeType: "image/jpeg" };
	};

	/** An account nobody knows yet writes to a bot that has no owner: the owner is asked in pine, once per account at a time. */
	const asking = new Set<number>();
	const pair = async (m: any, userId: number, name: string): Promise<boolean> => {
		if (fixed.length || paired() || asking.has(userId)) return false;
		asking.add(userId);
		try {
			const who = `${name || "somebody"} (${m.from?.username ? `@${m.from.username}, ` : ""}Telegram id ${userId})`;
			const yes = await source.approvals.ask(
				`let the Telegram account of ${who} talk to your agents as you through the bot @${me.username}\nIt just wrote: "${truncate(String(m.text ?? m.caption ?? "(a picture)"), 200)}"`,
				"what this account writes will count as your own words, with everything your agents may do for you. Allow it only if this is your account",
			);
			if (yes && !paired()) source.kv.set("owner", { id: userId, name });
			return yes && paired()?.id === userId;
		} finally {
			asking.delete(userId);
		}
	};

	const onMessage = async (m: any) => {
		const userId = Number(m.from?.id);
		const chatId = Number(m.chat?.id);
		const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ");
		if (m.chat?.type !== "private") return;
		// Unknown senders get no answer at all: nothing to probe, nothing to flood the log with.
		if (!heard(userId) && !(await pair(m, userId, name))) return source.log.debug(`ignored a message from user ${userId}`);
		const text = String(m.text || m.caption || "").trim();
		const images = m.photo ? [await photo(m.photo).catch(() => undefined)].filter(Boolean) : [];
		if (!text && !images.length) return;

		const verdict = text.match(/^\/(allow|deny)(?:\s+(\w+))?/);
		if (verdict && o.approvals !== false) {
			const pending = source.approvals.pending();
			const id = verdict[2] ?? (pending.length === 1 ? pending[0].id : undefined);
			const ok = id ? source.approvals.decide(id, verdict[1] === "allow", `telegram:${userId}`) : false;
			return void send(chatId, ok ? "Noted." : "No such open request.").catch(() => {});
		}
		source.emit("message", { text: text || "(a picture)", name, username: m.from?.username, chatId, messageId: m.message_id, images: images.length ? images : undefined }, { reply: { chatId } });
	};

	const onCallback = async (c: any) => {
		const userId = Number(c.from?.id);
		const m = String(c.data ?? "").match(/^ap:(\w+):([012])$/);
		if (!heard(userId) || !m) return void api("answerCallbackQuery", { callback_query_id: c.id }).catch(() => {});
		const ok = source.approvals.decide(m[1], m[2] !== "0", `telegram:${userId}`, m[2] === "2");
		await api("answerCallbackQuery", { callback_query_id: c.id, text: ok ? (m[2] === "0" ? "Denied" : m[2] === "2" ? "Allowed for this conversation" : "Allowed") : "Already answered or expired" }).catch(() => {});
	};

	const poll = async () => {
		const pollSec = 25;
		let offset = source.kv.get<number>("offset") ?? 0;
		let backoff = 1000;
		while (!stop.signal.aborted) {
			try {
				const updates: any[] = await api("getUpdates", { offset, timeout: pollSec, allowed_updates: ["message", "callback_query"] }, (pollSec + 10) * 1000);
				backoff = 1000;
				for (const u of updates) {
					offset = u.update_id + 1;
					source.kv.set("offset", offset);
					// Not awaited: a pairing question stays open until the owner answers, and messages keep coming meanwhile.
					if (u.message) void onMessage(u.message).catch((e) => source.log.warn("a message could not be handled", errText(e)));
					else if (u.callback_query) void onCallback(u.callback_query).catch((e) => source.log.warn("a button press could not be handled", errText(e)));
				}
			} catch (e) {
				if (stop.signal.aborted) break;
				source.log.warn(`asking Telegram for messages failed, trying again in ${backoff} ms`, errText(e));
				await sleep(backoff);
				backoff = Math.min(backoff * 2, 60_000);
			}
		}
	};
	void poll();
}
