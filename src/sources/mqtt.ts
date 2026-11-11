import { Type } from "typebox";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { errText, matchesAny, parseDuration } from "../util.ts";

/**
 * An MQTT broker: reports the messages on the topics you name. For home automation hubs, sensors,
 * and devices that speak MQTT themselves (a Bambu printer does, on mqtts://<printer>:8883 with the
 * user "bblp", its access code as password, the topic "device/<serial>/report" and insecureTls).
 *
 * options: { url, topics, publish?, username?, password?, clientId?, minInterval?, insecureTls? }
 *   topics       one MQTT topic filter or a list ("zigbee2mqtt/+", "device/+/report")
 *   publish      topics an agent may send to, to act on a device ("zigbee2mqtt/+/set"). Without it nothing can be sent
 *   minInterval  drop messages that follow the last one on the same topic sooner than this ("30s")
 *   insecureTls  accept a certificate that cannot be verified, as devices with self-made ones need
 *
 * event "message": { topic, value }   value is parsed JSON when the message is JSON, else text
 * It can send, to the topics on `publish` only: { topic, message, retain?, qos? }
 */
export const type: SourceType = {
	summary: "an MQTT broker: reports the messages on the topics you name. For home automation hubs, sensors, and devices that speak MQTT themselves (printers, plugs). With \"publish\" it can also send, to act on a device",
	sends: 'an MQTT message to a topic on its "publish" list, to act on a device: {"topic": "lamp/set", "message": "on"} (message: text or JSON)',
	options: Type.Object(
		{
			url: Type.String({ description: "address of the broker: mqtt://host:1883, or mqtts://host:8883 for TLS" }),
			topics: Type.Union([Type.String(), Type.Array(Type.String())], { description: 'the topic filters to listen to, e.g. "zigbee2mqtt/+" or ["device/+/report"]' }),
			publish: Type.Optional(Type.Array(Type.String(), { description: 'topics you may send to, to act on a device, e.g. ["zigbee2mqtt/+/set"]. Only when your owner wants you to control something; without it nothing can be sent' })),
			username: Type.Optional(Type.String({ description: "user name, if the broker wants one" })),
			password: Type.Optional(Type.String({ description: "password, access code or token, if the broker wants one", secret: true })),
			clientId: Type.Optional(Type.String({ description: "client id, for brokers that want a particular one" })),
			minInterval: Type.Optional(Type.String({ description: 'drop messages that follow the last one on the same topic sooner than this, e.g. "30s". For devices that report many times a second' })),
			insecureTls: Type.Optional(Type.Boolean({ description: "accept a certificate that cannot be verified, as devices with self-made ones need" })),
		},
		{ additionalProperties: false },
	),
	plan(o) {
		let url: URL;
		try {
			url = new URL(o.url);
		} catch {
			throw new Error(`"${o.url}" is not an address. An MQTT broker's looks like mqtt://192.168.1.10:1883`);
		}
		if (!["mqtt:", "mqtts:", "ws:", "wss:"].includes(url.protocol)) throw new Error("an MQTT broker's address starts with mqtt://, mqtts://, ws:// or wss://");
		const topics = (Array.isArray(o.topics) ? o.topics : String(o.topics).split(",")).map((t: string) => t.trim()).filter(Boolean);
		if (!topics.length) throw new Error(`needs "topics": which MQTT topics to listen to`);
		if (o.minInterval) parseDuration(o.minInterval);
		const publish = (Array.isArray(o.publish) ? o.publish : []).map((t: string) => String(t).trim()).filter(Boolean);
		return { options: { ...o, topics, ...(publish.length ? { publish } : {}) }, does: [`connect to the MQTT broker ${url.host}${o.username ? ` as ${o.username}` : ""} and listen to ${topics.join(", ")}`, ...(publish.length ? [`let the agent send messages to ${publish.join(", ")}, which can switch and control devices`] : []), ...(o.password ? ["with the password given"] : []), ...(o.insecureTls ? ["without checking its certificate"] : [])], opens: true };
	},
};

export default async function mqttSource(source: SourceApi): Promise<void> {
	const { default: mqtt } = await import("mqtt");
	const o = source.options;
	if (typeof o.url !== "string") throw new Error(`needs "url", for example mqtt://192.168.1.10:1883`);
	const topics: string[] = (Array.isArray(o.topics) ? o.topics : o.topics ? [o.topics] : []).map(String);
	if (!topics.length) throw new Error(`needs "topics": which MQTT topics to listen to`);
	const minMs = o.minInterval !== undefined ? parseDuration(o.minInterval) : 0;
	source.secret(o.password);

	const client = mqtt.connect(o.url, { username: o.username, password: o.password, clientId: o.clientId ?? `pine-${source.name}-${process.pid}`, reconnectPeriod: 5000, connectTimeout: 10_000, rejectUnauthorized: o.insecureTls !== true });
	source.onStop(() => new Promise<void>((r) => client.end(true, {}, () => r())));
	client.on("error", (e) => source.log.warn("mqtt error", errText(e)));
	client.on("connect", () => {
		source.log.info(`connected to ${new URL(o.url).host}`);
		for (const t of topics) client.subscribe(t, (err) => err && source.log.warn(`subscribe ${t} failed`, errText(err)));
	});
	const last = new Map<string, number>();
	client.on("message", (topic, buf) => {
		const now = Date.now();
		if (minMs && now - (last.get(topic) ?? 0) < minMs) return;
		last.set(topic, now);
		if (last.size > 5000) last.clear();
		const text = buf.length > 256 * 1024 ? "" : buf.toString("utf8");
		let value: unknown = text;
		try {
			value = JSON.parse(text);
		} catch {
			// plain text
		}
		source.emit("message", { topic, value });
	});

	// Sending: only to the topics the owner put on the list, and never to a filter.
	const allowed: string[] = (Array.isArray(o.publish) ? o.publish : []).map(String);
	source.onSend(async (m) => {
		const topic = String(m.topic ?? "");
		if (!topic) throw new Error('say which topic: {"topic": "...", "message": "..."}');
		if (/[+#]/.test(topic) || !matchesAny(allowed, topic)) throw new Error(`"${topic}" is not a topic this source may send to (${allowed.join(", ") || "none: it was set up to listen only"})`);
		const message = m.message ?? m.text ?? "";
		await new Promise<void>((resolve, reject) => client.publish(topic, typeof message === "string" ? message : JSON.stringify(message), { retain: m.retain === true, qos: [0, 1, 2].includes(m.qos) ? m.qos : 0 }, (err) => (err ? reject(err) : resolve())));
		return `published to ${topic}`;
	});
}
