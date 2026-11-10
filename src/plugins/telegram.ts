import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { PineApi } from "../plugins.ts";
import { errText, sleep, truncate } from "../util.ts";

/**
 * Telegram bots as an event source and sink.
 *
 * options: { accounts: { <name>: { token, allow: [userId...], chats?: [chatId...], agent?, session?, approvals?, apiBase? } } }
 *
 * In:  telegram/<account>/message   { chatId, userId, username, name, text, messageId, images? }   (trust: owner)
 * Out: out/telegram/<account>       { text, chatId? }   chatId defaults to the first allowed user
 *
 * Only users in `allow` are heard, and messages are only ever sent to `allow` users and `chats`.
 * With `agent` set, messages go straight to that agent (session "tg-<chatId>"), and /reset and
 * /stop work in the chat. Without it, write a route for telegram/<account>/message.
 */

interface Account {
	name: string;
	token: string;
	allow: number[];
	chats: number[];
	agent?: string;
	approvals: boolean;
	apiBase: string;
	whenBusy: "queue" | "steer";
}

const MAX_PHOTO = 10 * 1024 * 1024;

export default function telegram(pine: PineApi): void {
	const accounts: Account[] = Object.entries<any>(pine.options.accounts ?? {}).map(([name, a], i) => ({
		name,
		token: String(a.token ?? ""),
		allow: (a.allow ?? []).map(Number).filter(Number.isFinite),
		chats: (a.chats ?? []).map(Number).filter(Number.isFinite),
		agent: a.agent,
		approvals: a.approvals ?? i === 0,
		apiBase: String(a.apiBase ?? "https://api.telegram.org").replace(/\/$/, ""),
		whenBusy: a.whenBusy === "steer" ? "steer" : "queue",
	}));
	if (!accounts.length) throw new Error("telegram: no accounts configured");
	const mediaDir = path.join(pine.dataDir, "media", "telegram");
	fs.mkdirSync(mediaDir, { recursive: true });
	pine.media(mediaDir);
	const stop = new AbortController();
	pine.onStop(() => stop.abort());

	for (const acct of accounts) {
		if (!acct.token) throw new Error(`telegram account ${acct.name}: token missing`);
		if (!acct.allow.length) throw new Error(`telegram account ${acct.name}: "allow" must list at least one user id; a bot without it would take orders from anyone`);
		if (acct.agent && !pine.agents.list().some((a) => a.id === acct.agent)) throw new Error(`telegram account ${acct.name}: unknown agent "${acct.agent}"`);
		pine.secret(acct.token);
		const out = `out/telegram/${acct.name}`;
		const owner = acct.allow[0];
		const mayReceive = (chatId: number) => acct.allow.includes(chatId) || acct.chats.includes(chatId);

		const api = async (method: string, body: Record<string, unknown>, timeoutMs = 20_000): Promise<any> => {
			const res = await fetch(`${acct.apiBase}/bot${acct.token}/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)]),
			});
			const json: any = await res.json().catch(() => ({}));
			if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
			return json.result;
		};

		const send = async (chatId: number, text: string, extra: Record<string, unknown> = {}) => {
			if (!mayReceive(chatId)) throw new Error(`chat ${chatId} is not on the allow list of account ${acct.name}`);
			const body = text.trim() || "(empty message)";
			let last: any;
			for (let i = 0; i < body.length; i += 4000) last = await api("sendMessage", { chat_id: chatId, text: body.slice(i, i + 4000), ...(i + 4000 >= body.length ? extra : {}) });
			return last;
		};

		// ---- out ---------------------------------------------------------------------------------
		pine.bus.subscribe(out, async (e) => {
			const p = (e.payload ?? {}) as any;
			const chatId = Number(p.chatId ?? owner);
			try {
				await send(chatId, String(p.text ?? ""));
			} catch (err) {
				pine.log.warn(`could not send to ${chatId}`, errText(err));
			}
		});

		// "typing…" while an agent works on something that will be answered here.
		const typing = new Map<number, NodeJS.Timeout>();
		pine.bus.subscribe("agent/+/started", (e) => {
			const p = e.payload as any;
			if (p?.reply?.topic !== out) return;
			const chatId = Number(p.reply.payload?.chatId ?? owner);
			if (!mayReceive(chatId)) return;
			const tick = () => void api("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
			tick();
			const h = setInterval(tick, 4500);
			h.unref?.();
			typing.set(p.task, h);
		});
		pine.bus.subscribe(["agent/+/done", "agent/+/failed"], (e) => {
			const id = (e.payload as any)?.task;
			clearInterval(typing.get(id));
			typing.delete(id);
		});
		pine.onStop(() => typing.forEach((h) => clearInterval(h)));

		// ---- approvals -----------------------------------------------------------------------------
		if (acct.approvals) {
			const asked = new Map<string, number>();
			pine.bus.subscribe("approval/requested", async (e) => {
				const r = e.payload as any;
				const text = `Approval needed\nAgent: ${r.agent} (task #${r.task})\nAction: ${truncate(String(r.summary), 1200)}\nWhy you are asked: ${r.why}`;
				try {
					const always = r.remember ? [{ text: `Always: ${truncate(String(r.remember), 30)}`, callback_data: `ap:${r.id}:2` }] : [];
					const msg = await send(owner, text, { reply_markup: { inline_keyboard: [[{ text: "Allow", callback_data: `ap:${r.id}:1` }, ...always, { text: "Deny", callback_data: `ap:${r.id}:0` }]] } });
					if (msg?.message_id) asked.set(r.id, msg.message_id);
				} catch (err) {
					pine.log.warn("could not ask for approval", errText(err));
				}
			});
			pine.bus.subscribe("approval/decided", async (e) => {
				const d = e.payload as any;
				const messageId = asked.get(d.id);
				asked.delete(d.id);
				if (messageId) await api("editMessageReplyMarkup", { chat_id: owner, message_id: messageId, reply_markup: { inline_keyboard: [[{ text: d.allow ? `Allowed (${d.by})` : `Denied (${d.by})`, callback_data: "noop" }]] } }).catch(() => {});
			});
		}

		// ---- agent tool ----------------------------------------------------------------------------
		pine.tool({
			name: accounts.length === 1 ? "telegram_send" : `telegram_send_${acct.name.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`,
			description: `Send your owner a Telegram message${accounts.length === 1 ? "" : ` through the ${acct.name} bot`}. Use it to report something without having been asked; answers to a message you received are delivered automatically.`,
			parameters: Type.Object({ text: Type.String() }),
			execute: async (p) => {
				await send(owner, String(p.text));
				return "sent";
			},
		});

		// ---- in ----------------------------------------------------------------------------------
		const photo = async (sizes: any[]): Promise<{ path: string; mimeType: string } | undefined> => {
			const best = sizes.filter((s) => (s.file_size ?? 0) <= MAX_PHOTO).at(-1);
			if (!best) return undefined;
			const file = await api("getFile", { file_id: best.file_id });
			const res = await fetch(`${acct.apiBase}/file/bot${acct.token}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
			if (!res.ok) return undefined;
			const buf = Buffer.from(await res.arrayBuffer());
			if (buf.length > MAX_PHOTO) return undefined;
			const target = path.join(mediaDir, `${String(best.file_unique_id).replace(/[^A-Za-z0-9_-]/g, "")}.jpg`);
			fs.writeFileSync(target, buf, { mode: 0o600 });
			return { path: target, mimeType: "image/jpeg" };
		};

		const onMessage = async (m: any) => {
			const userId = Number(m.from?.id);
			const chatId = Number(m.chat?.id);
			// Unknown senders get no answer at all: nothing to probe, nothing to flood the log with.
			if (!acct.allow.includes(userId) || (m.chat?.type !== "private" && !acct.chats.includes(chatId))) return pine.log.debug(`ignored message from user ${userId} in chat ${chatId}`);
			const text = String(m.text ?? m.caption ?? "").trim();
			const images = m.photo ? [await photo(m.photo).catch(() => undefined)].filter(Boolean) : [];
			if (!text && !images.length) return;
			const session = `tg-${chatId}`;

			if (acct.agent && /^\/(reset|new)\b/.test(text)) {
				const done = await pine.agents.reset(acct.agent, session).catch((e) => errText(e));
				return void send(chatId, done === true ? "Started a fresh conversation." : done === false ? "Nothing to reset." : `Could not reset: ${done}`).catch(() => {});
			}
			if (acct.agent && /^\/stop\b/.test(text)) {
				const mine = pine.agents.running().filter((r) => r.agent === acct.agent && r.session === session);
				mine.forEach((r) => pine.agents.cancel(r.task));
				return void send(chatId, mine.length ? "Stopped." : "Nothing is running.").catch(() => {});
			}
			const pending = pine.approvals.pending();
			const verdict = text.match(/^\/(allow|deny)(?:\s+(\w+))?/);
			if (verdict && acct.approvals) {
				const id = verdict[2] ?? (pending.length === 1 ? pending[0].id : undefined);
				const ok = id ? pine.approvals.decide(id, verdict[1] === "allow", `telegram:${userId}`) : false;
				return void send(chatId, ok ? "Noted." : "No such open request.").catch(() => {});
			}

			const payload = { chatId, userId, username: m.from?.username, name: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" "), text, messageId: m.message_id, images: images.length ? images : undefined };
			const reply = { topic: out, payload: { chatId } };
			const event = pine.bus.publish(`telegram/${acct.name}/message`, payload, { trust: "owner", reply: acct.agent ? undefined : reply });
			if (acct.agent) {
				try {
					pine.agents.submit({ agent: acct.agent, prompt: text || "(image)", session, kind: "event", event, reply, images: images as any, trust: "owner", priority: 10, whenBusy: acct.whenBusy });
				} catch (err) {
					void send(chatId, `Could not take that: ${errText(err)}`).catch(() => {});
				}
			}
		};

		const onCallback = async (c: any) => {
			const userId = Number(c.from?.id);
			const m = String(c.data ?? "").match(/^ap:(\w+):([012])$/);
			if (!acct.allow.includes(userId) || !m) return void api("answerCallbackQuery", { callback_query_id: c.id }).catch(() => {});
			const ok = pine.approvals.decide(m[1], m[2] !== "0", `telegram:${userId}`, m[2] === "2");
			await api("answerCallbackQuery", { callback_query_id: c.id, text: ok ? (m[2] === "0" ? "Denied" : m[2] === "2" ? "Allowed for this conversation" : "Allowed") : "Already answered or expired" }).catch(() => {});
		};

		const poll = async () => {
			const pollSec = Number(pine.options.pollTimeoutSec ?? 25);
			let offset = pine.kv.get<number>(`offset:${acct.name}`) ?? 0;
			let backoff = 1000;
			while (!stop.signal.aborted) {
				try {
					const updates: any[] = await api("getUpdates", { offset, timeout: pollSec, allowed_updates: ["message", "callback_query"] }, (pollSec + 10) * 1000);
					backoff = 1000;
					for (const u of updates) {
						offset = u.update_id + 1;
						pine.kv.set(`offset:${acct.name}`, offset);
						if (u.message) await onMessage(u.message).catch((e) => pine.log.warn("message handling failed", errText(e)));
						else if (u.callback_query) await onCallback(u.callback_query).catch((e) => pine.log.warn("callback handling failed", errText(e)));
					}
				} catch (e) {
					if (stop.signal.aborted) break;
					pine.log.warn(`polling ${acct.name} failed, retrying in ${backoff} ms`, errText(e));
					await sleep(backoff);
					backoff = Math.min(backoff * 2, 60_000);
				}
			}
		};
		void poll();
	}
}
