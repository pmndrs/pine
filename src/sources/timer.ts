import { Type } from "typebox";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { parseCron } from "../timers.ts";
import { parseDuration } from "../util.ts";

/**
 * A clock: reports at fixed times or intervals. For "every morning at seven" and "every 15 minutes".
 *
 * options: { cron?, every?, payload? }
 *   cron     five fields, local time: minute hour day-of-month month day-of-week ("0 7 * * 1-5")
 *   every    an interval instead ("15m", "2h")
 *   payload  extra fields to put into each event
 *
 * event "tick": { scheduled, ...payload }
 */
export const type: SourceType = {
	summary: "a clock: reports at fixed times or intervals. For \"every morning at seven\" and \"every 15 minutes\"",
	options: Type.Object(
		{
			cron: Type.Optional(Type.String({ description: 'five fields, local time: minute hour day-of-month month day-of-week, e.g. "0 7 * * 1-5". Either this or every' })),
			every: Type.Optional(Type.String({ description: 'an interval instead of cron, e.g. "15m", "2h"' })),
			payload: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "extra fields to put into each event" })),
		},
		{ additionalProperties: false },
	),
	plan(o) {
		if (!o.cron === !o.every) throw new Error(`a timer needs either "cron" or "every"`);
		// Checked now, so that a typo is an answer and not a source that fails to start.
		if (o.cron) parseCron(o.cron);
		else if (parseDuration(o.every) < 1000) throw new Error(`"every" must be at least one second`);
		return { options: o, does: [o.cron ? `fire at the times "${o.cron}" (minute hour day month weekday)` : `fire every ${o.every}`], opens: false };
	},
};

export default function timer(source: SourceApi): void {
	const o = source.options;
	if (!o.cron === !o.every) throw new Error(`needs either "cron" or "every"`);
	const extra = o.payload && typeof o.payload === "object" && !Array.isArray(o.payload) ? o.payload : {};
	const fire = (at: number) => source.emit("tick", { scheduled: new Date(at).toISOString(), ...extra });
	let handle: NodeJS.Timeout;
	if (o.every) {
		const ms = parseDuration(o.every);
		if (ms < 1000) throw new Error(`"every" must be at least one second`);
		handle = setInterval(() => fire(Date.now()), ms);
	} else {
		const match = parseCron(String(o.cron));
		const minute = (t: number) => Math.floor(t / 60_000);
		// The last minute that fired is remembered, so a restart within the same minute does not fire twice.
		const tick = () => {
			const now = Date.now();
			if (source.kv.get<number>("last") === minute(now) || !match(new Date(now))) return;
			source.kv.set("last", minute(now));
			fire(now);
		};
		tick();
		handle = setInterval(tick, 15_000);
	}
	handle.unref?.();
	source.onStop(() => clearInterval(handle));
}
