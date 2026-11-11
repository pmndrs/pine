import { spawn } from "node:child_process";
import path from "node:path";
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { bin, tilde } from "./security.ts";

/**
 * File tools whose every read and write happens inside the agent's sandbox.
 *
 * pi's own file tools run in the daemon process. Checking a path first and opening it afterwards
 * leaves a gap: a shell command can swap a file for a symlink in between. Here the operating
 * system applies the same policy to file tools as to shell commands, so there is nothing to race.
 */
export interface SandboxFs {
	/** What to put in front of the command that is about to run so that it runs inside the agent's sandbox. */
	prefix(): string[];
	cwd: string;
	env(): NodeJS.ProcessEnv;
	/**
	 * Where the sandbox cannot forbid making a protected file (Linux, see `sandboxGuard`): taken
	 * before a write, and `restore` after it removes what the write may not have made.
	 */
	guard?(): { restore(): string[] } | undefined;
}

const MAX_READ = 50 * 1024 * 1024;
const MAX_OUT = 40_000;

export function sandboxExec(fs: SandboxFs, argv: string[], opts: { stdin?: string | Buffer; signal?: AbortSignal; maxBytes?: number; timeoutMs?: number } = {}): Promise<{ code: number; stdout: Buffer; stderr: string; truncated: boolean }> {
	return new Promise((resolve, reject) => {
		const jail = fs.prefix();
		// The programs are named by where they lie on this system, never looked up on a PATH an agent could shape.
		const child = spawn(jail[0], [...jail.slice(1), bin(path.basename(argv[0])), ...argv.slice(1)], { cwd: fs.cwd, env: fs.env(), stdio: ["pipe", "pipe", "pipe"] });
		const max = opts.maxBytes ?? MAX_READ;
		const chunks: Buffer[] = [];
		let size = 0;
		let truncated = false;
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => {
			if (size + d.length > max) {
				truncated = true;
				chunks.push(d.subarray(0, Math.max(0, max - size)));
				size = max;
				child.kill("SIGKILL");
			} else {
				chunks.push(d);
				size += d.length;
			}
		});
		child.stderr.on("data", (d: Buffer) => (stderr.length < 4000 ? (stderr += d.toString("utf8")) : undefined));
		const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 60_000);
		const onAbort = () => child.kill("SIGKILL");
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (e) => (clearTimeout(timer), reject(e)));
		child.on("close", (code) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolve({ code: code ?? (truncated ? 0 : 1), stdout: Buffer.concat(chunks), stderr, truncated });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(opts.stdin ?? "");
	});
}

function explain(file: string, stderr: string): Error {
	if (/Operation not permitted|Permission denied|Read-only file system|Device or resource busy/.test(stderr)) return new Error(`${file}: not permitted. Your file access is limited to your workspace.`);
	if (/No such file or directory/.test(stderr)) return Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: "ENOENT" });
	if (/Is a directory/.test(stderr)) return Object.assign(new Error(`EISDIR: ${file} is a directory`), { code: "EISDIR" });
	return new Error(`${file}: ${stderr.trim().split("\n")[0] || "operation failed"}`);
}

export function sniffImage(head: Buffer): string | null {
	if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
	if (head.length >= 6 && ["GIF87a", "GIF89a"].includes(head.subarray(0, 6).toString("latin1"))) return "image/gif";
	if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
	return null;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: undefined as any });
const clip = (s: string) => (s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n[output cut at ${MAX_OUT} characters; narrow the search]` : s);

/** read, write, edit, grep, find and ls, all executed inside the sandbox. */
export function sandboxedFileTools(fs: SandboxFs, enabled: string[]): any[] {
	const readFile = async (file: string) => {
		const r = await sandboxExec(fs, ["/bin/cat", "--", file]);
		if (r.code !== 0 && !r.truncated) throw explain(file, r.stderr);
		return r.stdout;
	};
	/** A call that writes. What it made although the run may not make it is gone again afterwards, and the call fails. */
	const writing = async (file: string, argv: string[], stdin?: string) => {
		const guard = fs.guard?.();
		let r: Awaited<ReturnType<typeof sandboxExec>>;
		let gone: string[] = [];
		try {
			r = await sandboxExec(fs, argv, { stdin });
		} finally {
			gone = guard?.restore() ?? [];
		}
		if (gone.length) throw explain(file, "Operation not permitted");
		if (r.code !== 0) throw explain(file, r.stderr);
	};
	const writeFile = (file: string, content: string) => writing(file, ["/bin/sh", "-c", 'cat > "$1"', "sh", file], content);
	// Opening the file is the only check that tells "missing" from "not permitted".
	const readable = async (file: string) => {
		const r = await sandboxExec(fs, ["/usr/bin/head", "-c", "1", "--", file], { maxBytes: 16 });
		if (r.code !== 0) throw explain(file, r.stderr || "No such file or directory");
	};
	const writable = async (file: string) => {
		await readable(file);
		const r = await sandboxExec(fs, ["/bin/test", "-w", file]);
		if (r.code !== 0) throw explain(file, "Permission denied");
	};
	// "~" is the owner's home, as pi's read, write and edit take it.
	const resolve = (p: string | undefined) => path.resolve(fs.cwd, tilde(p && p.length ? p : "."));
	const tools: Record<string, () => any> = {
		read: () =>
			createReadToolDefinition(fs.cwd, {
				operations: {
					readFile,
					access: readable,
					detectImageMimeType: async (file) => sniffImage((await sandboxExec(fs, ["/usr/bin/head", "-c", "16", "--", file])).stdout),
				},
			}),
		write: () =>
			createWriteToolDefinition(fs.cwd, {
				operations: {
					writeFile,
					mkdir: (dir) => writing(dir, ["/bin/mkdir", "-p", "--", dir]),
				},
			}),
		edit: () => createEditToolDefinition(fs.cwd, { operations: { readFile, writeFile, access: writable } }),
		ls: () =>
			defineTool({
				name: "ls",
				label: "ls",
				description: "List the entries of a directory. Directories end with /.",
				parameters: Type.Object({ path: Type.Optional(Type.String({ description: "Directory, default: your workspace" })), limit: Type.Optional(Type.Number({ description: "Maximum entries, default 500" })) }),
				execute: async (_id, p, signal) => {
					const dir = resolve(p.path);
					const r = await sandboxExec(fs, ["/bin/ls", "-1Ap", "--", dir], { signal, maxBytes: 2_000_000 });
					if (r.code !== 0) throw explain(p.path ?? ".", r.stderr);
					const entries = r.stdout.toString("utf8").split("\n").filter(Boolean);
					const limit = Math.max(1, Math.min(Number(p.limit) || 500, 5000));
					return text(entries.length ? entries.slice(0, limit).join("\n") + (entries.length > limit ? `\n[${entries.length - limit} more entries]` : "") : "(empty directory)");
				},
			}),
		find: () =>
			defineTool({
				name: "find",
				label: "find",
				description: "Find files by name. The pattern is a glob such as *.md or src/*.ts; .git and node_modules are skipped.",
				parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String({ description: "Directory to search, default: your workspace" })), limit: Type.Optional(Type.Number({ description: "Maximum results, default 200" })) }),
				execute: async (_id, p, signal) => {
					const dir = resolve(p.path);
					const match = p.pattern.includes("/") ? ["-path", `*${p.pattern.replace(/^\.?\//, "")}`] : ["-name", p.pattern];
					const r = await sandboxExec(fs, ["/usr/bin/find", dir, "(", "-name", ".git", "-o", "-name", "node_modules", ")", "-prune", "-o", ...match, "-print"], { signal, maxBytes: 4_000_000 });
					const lines = r.stdout.toString("utf8").split("\n").filter(Boolean).map((f) => path.relative(dir, f) || ".");
					if (!lines.length && r.code !== 0 && r.stderr) throw explain(p.path ?? ".", r.stderr);
					const limit = Math.max(1, Math.min(Number(p.limit) || 200, 2000));
					return text(lines.length ? clip(lines.slice(0, limit).join("\n") + (lines.length > limit ? `\n[${lines.length - limit} more results]` : "")) : "no files found");
				},
			}),
		grep: () =>
			defineTool({
				name: "grep",
				label: "grep",
				description: "Search file contents with a regular expression. Returns file:line:text. .git and node_modules are skipped.",
				parameters: Type.Object({
					pattern: Type.String({ description: "Regular expression (extended syntax)" }),
					path: Type.Optional(Type.String({ description: "File or directory, default: your workspace" })),
					glob: Type.Optional(Type.String({ description: "Only files whose name matches, for example *.md" })),
					ignoreCase: Type.Optional(Type.Boolean()),
					literal: Type.Optional(Type.Boolean({ description: "Treat the pattern as plain text" })),
					context: Type.Optional(Type.Number({ description: "Lines of context around each match" })),
					limit: Type.Optional(Type.Number({ description: "Maximum output lines, default 200" })),
				}),
				execute: async (_id, p, signal) => {
					const target = resolve(p.path);
					const args = ["-rnI", p.literal ? "-F" : "-E", "--exclude-dir=.git", "--exclude-dir=node_modules"];
					if (p.ignoreCase) args.push("-i");
					if (p.glob) args.push(`--include=${p.glob}`);
					if (Number(p.context) > 0) args.push("-C", String(Math.min(Number(p.context), 20)));
					const r = await sandboxExec(fs, ["/usr/bin/grep", ...args, "-e", p.pattern, "--", target], { signal, maxBytes: 4_000_000 });
					if (r.code > 1 && !r.stdout.length) throw explain(p.path ?? ".", r.stderr);
					const prefix = target.endsWith(path.sep) ? target : target + path.sep;
					const lines = r.stdout.toString("utf8").split("\n").filter(Boolean).map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l));
					const limit = Math.max(1, Math.min(Number(p.limit) || 200, 2000));
					return text(lines.length ? clip(lines.slice(0, limit).join("\n") + (lines.length > limit ? `\n[${lines.length - limit} more lines]` : "")) : "no matches");
				},
			}),
	};
	return enabled.filter((name) => tools[name]).map((name) => tools[name]());
}
