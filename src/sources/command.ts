import { Type } from "typebox";
import type { SourceType } from "../source-types.ts";
import type { SourceApi } from "../sources.ts";
import { parseDuration } from "../util.ts";
import { clip, found, harmless, lineDiff, pattern, shown } from "../watching.ts";

/**
 * A command, run again and again: reports when what it prints or how it ends changes. For what
 * only a command can tell: free disk space, a build, a branch that moved, a log, whether a
 * machine answers.
 *
 * options: { run, every?, match?, timeout? }
 *   run      the command line, run by bash from the workspace of the agent the source belongs to
 *   every    how often ("1m" by default)
 *   match    watch only what this regular expression finds in what it prints
 *   timeout  how long one run may take ("30s" by default)
 *
 * event "changed": { command, code, previousCode?, value, previous }         with match
 *                  { command, code, previousCode?, added, removed, more? }   without
 *
 * The command runs in the sandbox of that agent's shell: it reaches what the agent reaches and
 * nothing else. The first run is the starting point and reports nothing.
 */
const MIN = 5000;

export const type: SourceType = {
	summary: "a command run again and again: reports when what it prints, or how it ends (its exit code), changes. For what only a command can tell: free disk space, a build, a branch that moved, a log, whether a machine answers. It runs like a command in your own shell, with the same limits",
	options: Type.Object(
		{
			run: Type.String({ description: 'the command line, run by bash from your workspace, e.g. "df -h /" or "git -C ~/dev/app rev-parse origin/main". One that only looks: it runs unattended, again and again' }),
			every: Type.Optional(Type.String({ description: 'how often to run it, e.g. "1m", "1h". Default "1m", at least "5s"' })),
			match: Type.Optional(Type.String({ description: 'watch only what this regular expression finds in what it prints (its first group, if it has one), e.g. "([0-9]+)% used". Without it everything it prints counts' })),
			timeout: Type.Optional(Type.String({ description: 'how long one run may take before it is stopped. Default "30s"' })),
		},
		{ additionalProperties: false },
	),
	plan(o, setup) {
		const run = String(o.run ?? "").trim();
		if (!run) throw new Error(`needs "run": the command line`);
		if (run.length > 2000) throw new Error("that command line is too long: put it into a script in your workspace and run that");
		const every = o.every ?? "1m";
		if (parseDuration(every) < MIN) throw new Error('"every" must be at least "5s"');
		if (o.timeout && parseDuration(o.timeout) < 1000) throw new Error('"timeout" must be at least "1s"');
		if (o.match) pattern(o.match);
		return {
			options: { ...o, run },
			does: [`run this command every ${every}, unattended, with the rights of ${setup.agent}'s shell (its sandbox): ${run}`, `report when ${o.match ? `what /${o.match}/ finds in what it prints` : "what it prints"} or its exit code changes`],
			opens: true,
			tell: "Its first run is the starting point and reports nothing; from then on only a change does. The sources tool shows how the last run went.",
		};
	},
};

export default function command(source: SourceApi): void {
	const o = source.options;
	const run = typeof o.run === "string" ? o.run.trim() : "";
	if (!run) throw new Error(`needs "run": the command line`);
	const re = o.match ? pattern(String(o.match)) : undefined;
	const timeoutMs = parseDuration(o.timeout ?? "30s");

	source.poll(o.every ?? "1m", async (signal) => {
		const { code, output } = await source.exec(run, { timeoutMs, signal });
		const text = output.replace(/\r\n/g, "\n").trimEnd().slice(0, 200_000);
		if (re) {
			const value = found(re, text);
			source.status(`exit ${code}, ${value === null ? "found nothing with the pattern" : `now: ${harmless(value)}`}`);
			const was = source.changed({ code, value });
			if (was) source.emit("changed", { command: clip(run, 300), code, value, previous: shown(was.previous.value), ...(was.previous.code !== code ? { previousCode: was.previous.code } : {}) });
			return;
		}
		source.status(`exit ${code}, ${text ? text.split("\n").length : 0} lines`);
		const was = source.changed({ code, text });
		if (!was) return;
		const diff = lineDiff(String(was.previous.text ?? ""), text);
		if (diff.added.length || diff.removed.length || was.previous.code !== code) source.emit("changed", { command: clip(run, 300), code, ...(was.previous.code !== code ? { previousCode: was.previous.code } : {}), ...diff });
	});
}
