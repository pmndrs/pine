// Bundled MCP server "commands": turns fixed shell commands into typed tools.
//
// An agent that should be able to "check the printer" does not need a shell for it. Declare the
// command once; the model only fills in the parameters you defined. Arguments are passed as an
// argument vector, never through a shell, so a parameter cannot smuggle in a second command.
//
// options: {
//   commands: {
//     <tool name>: {
//       description,
//       run: ["program", "arg", "{{param}}", ...],
//       params?: { <name>: { type?: "string"|"number"|"boolean", description?, enum?, pattern?, required?, default? } },
//       timeoutSec?, cwd?, env?, sandbox?, maxOutput?
//     }
//   },
//   cwd, sandboxProfile, env        // filled in by pine: the agent's workspace, sandbox profile and shell environment
// }
import { spawn } from "node:child_process";
import { type McpTool, options, serve } from "./lib.ts";

interface Param {
	type?: "string" | "number" | "boolean";
	description?: string;
	enum?: unknown[];
	pattern?: string;
	required?: boolean;
	default?: unknown;
}
interface Command {
	description: string;
	run: string[];
	params?: Record<string, Param>;
	timeoutSec?: number;
	cwd?: string;
	env?: Record<string, string>;
	sandbox?: boolean;
	maxOutput?: number;
}

const o = options<{ commands?: Record<string, Command>; cwd?: string; sandboxProfile?: string; env?: Record<string, string> }>();

export function buildArgv(cmd: Command, args: Record<string, unknown>): string[] {
	const values: Record<string, string> = {};
	for (const [name, p] of Object.entries(cmd.params ?? {})) {
		const v = args[name] ?? p.default;
		if (v === undefined || v === null || v === "") {
			if (p.required !== false && p.default === undefined) throw new Error(`parameter "${name}" is required`);
			values[name] = "";
			continue;
		}
		const s = String(v);
		if (p.type === "number" && !Number.isFinite(Number(v))) throw new Error(`parameter "${name}" must be a number`);
		if (p.type === "boolean" && !["true", "false"].includes(s)) throw new Error(`parameter "${name}" must be true or false`);
		if (p.enum && !p.enum.map(String).includes(s)) throw new Error(`parameter "${name}" must be one of: ${p.enum.join(", ")}`);
		if (p.pattern && !new RegExp(`^(?:${p.pattern})$`).test(s)) throw new Error(`parameter "${name}" has an invalid format`);
		// A value that starts with "-" would be read as an option by most programs.
		if (s.startsWith("-") && p.type !== "number" && !p.pattern && !p.enum) throw new Error(`parameter "${name}" must not start with "-"`);
		if (s.includes("\0")) throw new Error(`parameter "${name}" contains an invalid character`);
		values[name] = s;
	}
	return cmd.run.map((part) => part.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name) => (name in values ? values[name] : "")));
}

function run(name: string, cmd: Command, args: Record<string, unknown>): Promise<string> {
	let argv = buildArgv(cmd, args);
	if (cmd.sandbox && o.sandboxProfile) argv = ["/usr/bin/sandbox-exec", "-f", o.sandboxProfile, ...argv];
	const max = cmd.maxOutput ?? 30_000;
	return new Promise((resolve, reject) => {
		const child = spawn(argv[0], argv.slice(1), { cwd: cmd.cwd ?? o.cwd, env: { ...(o.env ?? { PATH: process.env.PATH ?? "" }), ...(cmd.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		const add = (d: Buffer) => {
			if (out.length < max) out += d.toString("utf8");
		};
		child.stdout.on("data", add);
		child.stderr.on("data", add);
		const timer = setTimeout(() => child.kill("SIGKILL"), (cmd.timeoutSec ?? 30) * 1000);
		child.on("error", (e) => (clearTimeout(timer), reject(new Error(`${name}: ${e.message}`))));
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			const text = out.length > max ? `${out.slice(0, max)}\n[output cut at ${max} characters]` : out;
			if (signal) return reject(new Error(`${name} was stopped after ${cmd.timeoutSec ?? 30} s\n${text}`));
			if (code !== 0) return reject(new Error(`${name} exited with code ${code}\n${text}`));
			resolve(text.trim() || "(no output)");
		});
	});
}

if (import.meta.main) {
	const tools: McpTool[] = Object.entries(o.commands ?? {}).map(([name, cmd]) => ({
		name,
		description: cmd.description,
		inputSchema: {
			type: "object",
			properties: Object.fromEntries(Object.entries(cmd.params ?? {}).map(([p, d]) => [p, { type: d.type ?? "string", ...(d.description ? { description: d.description } : {}), ...(d.enum ? { enum: d.enum } : {}) }])),
			required: Object.entries(cmd.params ?? {}).filter(([, d]) => d.required !== false && d.default === undefined).map(([p]) => p),
		},
		handler: (args) => run(name, cmd, args),
	}));
	serve({ name: "pine-commands", version: "0.1.0" }, tools);
}
