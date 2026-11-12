import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { bin, helperArgv, isInside, realish } from "./security.ts";

// What a UI shows beside a conversation: the files of the folder it works in, and what changed
// there according to git. Everything here only reads. None of it reaches a model.

export interface Change {
	/** Path from the top of the repository. */
	path: string;
	/** "M" changed, "A" added, "D" deleted, "R" renamed, "?" not tracked yet. */
	status: string;
	added?: number;
	removed?: number;
}

const MAX_OUT = 2_000_000;

/**
 * Run git so that it can only look. A repository's own configuration can name programs for git
 * to run (filters, diff drivers, hooks, a file system monitor); a folder somebody cloned must not
 * get to run anything with the daemon's rights just because it was looked at. So git runs in a
 * sandbox that can neither write nor use the network, and with the programs it would start for
 * a diff turned off. Every git call of the daemon goes through here.
 */
export function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<{ code: number; out: string; raw: Buffer; err: string }> {
	const none = { out: "", raw: Buffer.alloc(0) };
	const jail = helperArgv(opts.write);
	if (!jail) return Promise.resolve({ code: 127, ...none, err: "there is no sandbox on this system to run git in" });
	const safe = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat", "-c", "diff.external=", "-c", "safe.directory=*", "-c", "color.ui=false", "-c", "core.quotePath=false"];
	const max = opts.maxBytes ?? MAX_OUT;
	return new Promise((resolve) => {
		const child = spawn(jail[0], [...jail.slice(1), bin("git"), "-C", cwd, ...safe, ...args], { stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...opts.env } });
		const chunks: Buffer[] = [];
		let size = 0;
		let err = "";
		child.stdout!.on("data", (d: Buffer) => {
			size += d.length;
			if (size <= max) chunks.push(d);
			else child.kill("SIGKILL");
		});
		child.stderr!.on("data", (d: Buffer) => (err.length < 2000 ? (err += d.toString("utf8")) : undefined));
		if (opts.stdin !== undefined) {
			child.stdin!.on("error", () => {});
			child.stdin!.end(opts.stdin);
		}
		const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 15_000);
		child.on("error", (e) => (clearTimeout(timer), resolve({ code: 127, ...none, err: e.message })));
		child.on("close", (code) => {
			clearTimeout(timer);
			const raw = Buffer.concat(chunks);
			resolve({ code: code ?? 1, out: raw.toString("utf8"), raw, err });
		});
	});
}

/**
 * What a git call may do beyond looking. The snapshots behind undo (`src/snapshots.ts`) are the
 * one user: they write into a git directory of pine's own and, for a restore the owner asked
 * for, into the folder itself. `write` is enforced by the sandbox, not by git.
 */
export interface GitOptions {
	/** Folders git may write in. Without any it can only look. */
	write?: string[];
	stdin?: Buffer | string;
	/** More environment: a git directory, an index file of its own. */
	env?: Record<string, string>;
	maxBytes?: number;
	timeoutMs?: number;
}

/** The repository a folder lies in, if any: its top folder and the branch that is checked out. */
async function repository(root: string): Promise<{ top: string; branch: string } | undefined> {
	const top = await git(root, ["rev-parse", "--show-toplevel"]);
	if (top.code !== 0 || !top.out.trim()) return undefined;
	const branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
	return { top: realish(top.out.trim()), branch: branch.code === 0 ? branch.out.trim() : "" };
}

/** What differs from the last commit in a folder: changed, added, deleted and new files, with line counts. */
export async function changes(root: string): Promise<{ repo: boolean; branch?: string; top?: string; files: Change[]; more: boolean }> {
	const repo = await repository(root);
	if (!repo) return { repo: false, files: [], more: false };
	const status = await git(repo.top, ["status", "--porcelain=v1", "-z", "--", root]);
	const files: Change[] = [];
	const parts = status.out.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (entry.length < 4) continue;
		const xy = entry.slice(0, 2);
		const file = entry.slice(3);
		// A rename is followed by the name it had before.
		if (xy.includes("R") || xy.includes("C")) i++;
		const code = xy === "??" ? "?" : xy.includes("D") ? "D" : xy.includes("A") ? "A" : xy.includes("R") ? "R" : "M";
		files.push({ path: file, status: code });
	}
	const hasHead = (await git(repo.top, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
	const counts = await git(repo.top, ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", ...(hasHead ? ["HEAD"] : []), "--", root]);
	for (const line of counts.out.split("\0")) {
		const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
		const file = m && files.find((f) => f.path === m[3]);
		if (m && file && m[1] !== "-") Object.assign(file, { added: Number(m[1]), removed: Number(m[2]) });
	}
	// A new file has no counts from git; its lines are all new.
	for (const f of files) {
		if (f.status !== "?" || f.path.endsWith("/")) continue;
		try {
			const full = path.join(repo.top, f.path);
			if (fs.statSync(full).size < 1_000_000) f.added = fs.readFileSync(full, "utf8").split("\n").length - 1;
		} catch {
			// gone since
		}
	}
	return { repo: true, branch: repo.branch, top: repo.top, files: files.slice(0, 300), more: files.length > 300 };
}

/** The diff of one file against the last commit. A file git does not know yet is shown as all new. */
export async function diffOf(root: string, file: string): Promise<{ diff: string; truncated: boolean } | undefined> {
	const repo = await repository(root);
	if (!repo || file.includes("\0")) return undefined;
	const target = realish(path.join(repo.top, file));
	if (!isInside(realish(root), target) && target !== realish(root)) return undefined;
	const hasHead = (await git(repo.top, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
	let r = await git(repo.top, ["diff", "--no-ext-diff", "--no-textconv", ...(hasHead ? ["HEAD"] : []), "--", file]);
	if (!r.out.trim()) r = await git(repo.top, ["diff", "--no-ext-diff", "--no-textconv", "--no-index", "--", "/dev/null", file]);
	const max = 200_000;
	return { diff: r.out.slice(0, max), truncated: r.out.length > max };
}

/** A path inside a folder, with links resolved, or undefined when it leads out of it. */
function inside(root: string, rel: string): string | undefined {
	if (rel.includes("\0")) return undefined;
	const base = realish(root);
	const target = realish(path.join(base, rel));
	return target === base || isInside(base, target) ? target : undefined;
}

/**
 * Files of a folder whose path fits what somebody typed, the best first: for pointing an agent at
 * a file by a few letters of its name. In a repository these are the files git knows or would add
 * (ignored ones are left out); elsewhere a walk of bounded size that skips hidden folders and
 * `node_modules`. Nothing outside the folder is named.
 */
export async function findFiles(root: string, query: string, limit = 20): Promise<string[]> {
	const base = realish(root);
	let files: string[] = [];
	const listed = (await repository(base)) ? await git(base, ["ls-files", "-co", "--exclude-standard", "-z"]) : undefined;
	if (listed?.code === 0) files = listed.out.split("\0").filter(Boolean);
	else {
		const walk = (rel: string, depth: number) => {
			if (files.length >= 5000 || depth > 6) return;
			for (const e of listDir(base, rel)?.entries ?? []) {
				const next = rel ? `${rel}/${e.name}` : e.name;
				if (!e.dir) files.push(next);
				else if (!e.name.startsWith(".") && e.name !== "node_modules") walk(next, depth + 1);
			}
		};
		walk("", 0);
	}
	const q = query.toLowerCase();
	if (!q) return files.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)).slice(0, limit);
	// Letters in order, with anything between them: "agts" finds "src/agents.ts".
	const inOrder = (text: string) => {
		let i = 0;
		for (const ch of text) if (ch === q[i] && ++i === q.length) return true;
		return false;
	};
	const rank = (file: string) => {
		const lower = file.toLowerCase();
		const name = lower.slice(lower.lastIndexOf("/") + 1);
		return name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : lower.includes(q) ? 3 : inOrder(name) ? 4 : inOrder(lower) ? 5 : -1;
	};
	return files
		.map((file) => ({ file, rank: rank(file) }))
		.filter((x) => x.rank >= 0)
		.sort((a, b) => a.rank - b.rank || a.file.length - b.file.length || a.file.localeCompare(b.file))
		.slice(0, limit)
		.map((x) => x.file);
}

export interface Entry {
	name: string;
	dir: boolean;
	size: number;
}

/** What is in one folder: folders first, then files, by name. Git's own folder is left out. */
export function listDir(root: string, rel: string): { entries: Entry[]; more: boolean } | undefined {
	const dir = inside(root, rel);
	if (!dir) return undefined;
	let names: fs.Dirent[];
	try {
		names = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	const entries: Entry[] = [];
	for (const d of names) {
		if (d.name === ".git" || d.name === ".DS_Store") continue;
		const full = path.join(dir, d.name);
		try {
			const stat = fs.statSync(full);
			// A link that leads out of the folder is not shown as part of it.
			if (!inside(root, path.relative(realish(root), full))) continue;
			entries.push({ name: d.name, dir: stat.isDirectory(), size: stat.isDirectory() ? 0 : stat.size });
		} catch {
			// a broken link
		}
	}
	entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
	return { entries: entries.slice(0, 500), more: entries.length > 500 };
}

/** A file's text, for reading. Binary files and very large ones are only described. */
export function readText(root: string, rel: string): { text?: string; size: number; binary: boolean; truncated: boolean } | undefined {
	const file = inside(root, rel);
	if (!file) return undefined;
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) return undefined;
		const max = 256 * 1024;
		const fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(Math.min(stat.size, max));
		fs.readSync(fd, buf, 0, buf.length, 0);
		fs.closeSync(fd);
		if (buf.subarray(0, 8192).includes(0)) return { size: stat.size, binary: true, truncated: false };
		return { text: buf.toString("utf8"), size: stat.size, binary: false, truncated: stat.size > max };
	} catch {
		return undefined;
	}
}
