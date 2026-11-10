import crypto from "node:crypto";
import { timingSafeEqual } from "../security.ts";
import { Type } from "typebox";
import type { SourceType } from "../source-types.ts";
import { refuse, type SourceApi } from "../sources.ts";

/**
 * A web address other services can call: POST http://<pine's control address>/hook/<name>.
 * For GitHub, Home Assistant, a doorbell, a shortcut on your phone, anything that can send a request.
 *
 * options: { secret, open? }
 *   secret  the caller proves itself with it, either as "Authorization: Bearer <secret>" or by
 *           signing the body (HMAC SHA-256 in X-Hub-Signature-256 or X-Signature, as GitHub does)
 *   open    true to accept anyone who can reach the port; only for a port nobody else can reach
 *
 * event "received": { body, headers }   body is parsed JSON, or { text } for anything else
 */
const KEPT = ["content-type", "user-agent", "x-github-event", "x-github-delivery", "x-event-type", "x-event-key", "x-request-id"];

export const type: SourceType = {
	summary: "a web address other services can call (POST /hook/<name> on pine's control port; /hook/<name>@<agent> for an agent's own). For GitHub, Home Assistant, a doorbell, a shortcut on a phone",
	options: Type.Object(
		{
			secret: Type.Optional(Type.String({ description: "what the caller proves itself with. Leave it out and pine makes one", secret: true })),
			open: Type.Optional(Type.Boolean({ description: "true to accept anyone who can reach the port, without a secret. Only for a port nobody else can reach" })),
		},
		{ additionalProperties: false },
	),
	plan(o, setup) {
		if (o.open === true) return { options: { open: true }, does: [`accept web requests at /hook/${setup.key} on pine's control port from ANYONE who can reach it`], opens: true, tell: `Callers use POST /hook/${setup.key} on pine's control address.` };
		const made = !o.secret;
		return { options: { secret: o.secret ?? setup.random(24) }, does: [`accept web requests at /hook/${setup.key} on pine's control port from callers that present a secret${made ? " (made now)" : ""}`], opens: true, tell: `Callers use POST /hook/${setup.key} on pine's control address and present the secret, which your owner finds in pine's .env file as ${setup.envName("secret")}.` };
	},
};

export default function webhook(source: SourceApi): void {
	const secret = typeof source.options.secret === "string" ? source.options.secret : "";
	if (!secret && source.options.open !== true) throw new Error(`needs a "secret" the caller has to present (or "open": true to accept anyone who can reach the port)`);
	source.secret(secret || undefined);
	source.http(({ headers, body }) => {
		if (secret) {
			const bearer = String(headers.authorization ?? "").replace(/^Bearer /, "");
			const sig = String(headers["x-hub-signature-256"] ?? headers["x-signature"] ?? "").replace(/^sha256=/, "");
			const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
			if (!(bearer && timingSafeEqual(bearer, secret)) && !(sig && timingSafeEqual(sig, expected))) throw refuse(401, "bad signature");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(body.toString("utf8"));
		} catch {
			parsed = { text: body.toString("utf8") };
		}
		source.emit("received", { body: parsed, headers: Object.fromEntries(KEPT.filter((k) => headers[k] !== undefined).map((k) => [k, String(headers[k])])) });
	});
}
