import mqtt from "mqtt";
import { Type } from "typebox";
import type { PineApi } from "../plugins.ts";
import { errText, matchesAny, render, topicMatches } from "../util.ts";

/**
 * MQTT broker as an event source and sink.
 *
 * options: {
 *   url, username?, password?, clientId?,
 *   subscribe: [{ topic, as?, persist?, minIntervalMs?, trust? }],   // as: bus topic template, default "mqtt/{{topic}}"
 *   publish: ["zigbee2mqtt/+/set", ...]                               // MQTT topics agents and routes may publish to
 * }
 *
 * In:  mqtt/<mqtt topic>   { topic, value }   value is parsed JSON when the message is JSON, else a string
 * Out: out/mqtt            { topic, message, retain?, qos? }
 *
 * Whatever arrives from a broker is outside content (trust: untrusted) unless a subscription says
 * `"trust": "owner"`, which you should only do for a broker nobody else can publish to.
 */
export default async function mqttPlugin(pine: PineApi): Promise<void> {
	const o = pine.options;
	if (typeof o.url !== "string") throw new Error("mqtt: url missing");
	const subs: Array<{ topic: string; as?: string; persist?: boolean; minIntervalMs?: number; trust?: string }> = o.subscribe ?? [];
	const allowed: string[] = o.publish ?? [];
	pine.secret(o.password);

	const client = mqtt.connect(o.url, { username: o.username, password: o.password, clientId: o.clientId ?? `pine-${process.pid}`, reconnectPeriod: 5000, connectTimeout: 10_000 });
	pine.onStop(() => new Promise<void>((r) => client.end(true, {}, () => r())));
	client.on("error", (e) => pine.log.warn("mqtt error", errText(e)));
	client.on("connect", () => {
		pine.log.info(`connected to ${new URL(o.url).host}`);
		for (const s of subs) client.subscribe(s.topic, (err) => err && pine.log.warn(`subscribe ${s.topic} failed`, errText(err)));
	});

	const last = new Map<string, number>();
	client.on("message", (topic, buf) => {
		const sub = subs.find((s) => topicMatches(s.topic, topic));
		if (!sub) return;
		const now = Date.now();
		if (sub.minIntervalMs && now - (last.get(topic) ?? 0) < sub.minIntervalMs) return;
		last.set(topic, now);
		const text = buf.length > 256 * 1024 ? "" : buf.toString("utf8");
		let value: unknown = text;
		try {
			value = JSON.parse(text);
		} catch {
			// plain text payload
		}
		pine.bus.publish(sub.as ? render(sub.as, { topic }) : `mqtt/${topic}`, { topic, value }, { persist: sub.persist !== false, trust: sub.trust === "owner" ? "owner" : "untrusted" });
	});

	const publish = (topic: string, message: unknown, opts: { retain?: boolean; qos?: 0 | 1 | 2 } = {}) => {
		if (/[+#]/.test(topic) || !matchesAny(allowed, topic)) throw new Error(`MQTT topic "${topic}" is not on the publish list (${allowed.join(", ") || "empty"})`);
		return new Promise<void>((resolve, reject) =>
			client.publish(topic, typeof message === "string" ? message : JSON.stringify(message ?? ""), { retain: opts.retain === true, qos: opts.qos ?? 0 }, (err) => (err ? reject(err) : resolve())),
		);
	};

	pine.bus.subscribe("out/mqtt", async (e) => {
		const p = (e.payload ?? {}) as any;
		try {
			await publish(String(p.topic ?? ""), p.message, p);
		} catch (err) {
			pine.log.warn("publish refused", errText(err));
		}
	});

	if (allowed.length) {
		pine.tool({
			name: "mqtt_publish",
			description: `Publish an MQTT message to control a device. Topics you may use: ${allowed.join(", ")}`,
			parameters: Type.Object({ topic: Type.String(), message: Type.String({ description: "Payload: plain text or JSON" }) }),
			execute: async (p) => {
				await publish(String(p.topic), String(p.message));
				return `published to ${p.topic}`;
			},
		});
	}
}
