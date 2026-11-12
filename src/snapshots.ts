import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isInside, realish } from "./security.ts";
import { git, type GitOptions } from "./workspace-view.ts";

// The state of a folder at one moment, kept so that it can be compared with another moment and
// gone back to: what undo is made of (src/undo.ts).
//
// A state is a git tree. It is written with git's plumbing into a git directory of pine's own
// under the data folder, with the folder as work tree: the owner's own repository, its index and
// its history are never touched, and a folder that is no repository works the same. Agents cannot
// write pine's data folder, so no agent can change what a state says.
//
// Three things are deliberately left out of a state, and so are never restored:
// - what the folder's ignore rules leave out (.gitignore, the repository's info/exclude);
// - files above MAX_FILE: one large file changed a few times would cost its size each time;
// - a repository inside the folder (a clone, a submodule): git leaves it to itself.

/** Files larger than this are not recorded. */
export const MAX_FILE = 2 * 1024 * 1024;
/** How much may be new or changed in one state. A folder beyond it is not recorded at all, and undo says so. */
const MAX_FILES = 50_000;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_SKIPPED = 1000;
/** A repository inside the folder appears as an entry of this kind. */
const LINK = "160000";
const NONE = "000000";
const DAY = 86_400_000;
/** A file in each git directory whose time says when it was last tidied. */
const TIDIED = "pine-tidied";

/**
 * No setting and no file of the folder may make git run a program or rewrite what it stores: no
 * hooks, no file system monitor, no line-ending conversion. The owner's own git settings
 * (global, system) are not read at all, see `env` below: what is recorded depends on the folder
 * alone, so the owner's global ignore file does not count either.
 */
const CONFIG = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.untrackedCache=false", "-c", "gc.auto=0", "-c", "advice.addEmbeddedRepo=false"];
/**
 * `info/attributes` of the git directory wins over every .gitattributes in the folder. A filter
 * named there would be a program started by git; text conversion would give back a file that is
 * not byte for byte what it was.
 */
const ATTRIBUTES = "* -text -filter -ident -working-tree-encoding\n";

export interface Snap {
	tree: string;
	/** Files left out for their size. They are never touched by a restore. */
	skipped?: string[];
}

export interface FileChange {
	/** From the folder. */
	path: string;
	/** "M" changed, "A" added, "D" deleted. */
	status: "M" | "A" | "D";
	added?: number;
	removed?: number;
}

/** Where a folder's states are kept, and what git is told the folder is. */
interface Place {
	dir: string;
	/** The work tree: the folder itself, or the top of the repository it lies in, so that the ignore rules above it count. */
	base: string;
	/** The folder from there; empty when they are the same. */
	prefix: string;
	/** The repository's own list of what to leave out (info/exclude), if it has one. */
	excludes?: string;
	at: number;
}

interface Entry {
	/** The path from the work tree, byte for byte (a string of bytes: a name need not be valid UTF-8). */
	p: string;
	from: { mode: string; sha: string };
	to: { mode: string; sha: string };
}

const split = (raw: Buffer): string[] => raw.toString("latin1").split("\0").filter(Boolean);
const bytes = (p: string) => Buffer.from(p, "latin1");
const shown = (p: string) => bytes(p).toString("utf8");
/** A path as a line of an exclude file: from the top, and nothing in it is a pattern. */
const pattern = (p: string) => `/${p.replace(/\/$/, "").replace(/[\\*?[\]!# ]/g, "\\$&")}${p.endsWith("/") ? "/" : ""}`;

export class Snapshots {
	private dir: string;
	private places = new Map<string, Place>();
	private lanes = new Map<string, Promise<unknown>>();

	/** `dir`: where the git directories lie, one per folder. Inside pine's data folder. */
	constructor(dir: string) {
		this.dir = dir;
	}

	/** One thing at a time per folder: its states share one index. */
	private alone<T>(root: string, fn: () => Promise<T>): Promise<T> {
		const run = (this.lanes.get(root) ?? Promise.resolve()).then(fn, fn);
		const done = run.then(() => {}, () => {});
		this.lanes.set(root, done);
		void done.then(() => this.lanes.get(root) === done && this.lanes.delete(root));
		return run;
	}

	private g(at: Place, args: string[], opts: GitOptions = {}) {
		return git(at.base, ["--git-dir", at.dir, "--work-tree", at.base, "--literal-pathspecs", ...CONFIG, "-c", `core.excludesFile=${at.excludes ?? "/dev/null"}`, ...args], {
			timeoutMs: 120_000,
			maxBytes: 64 * 1024 * 1024,
			...opts,
			// Its own directory, and nothing else unless the call is a restore.
			write: [at.dir, ...(opts.write ?? [])],
			env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...opts.env },
		});
	}

	private async must(what: string, r: Promise<{ code: number; out: string; raw: Buffer; err: string }>) {
		const got = await r;
		if (got.code !== 0) throw new Error(`${what}: ${got.err.trim().split("\n")[0] || `git ended with ${got.code}`}`);
		return got;
	}

	private async place(root: string): Promise<Place> {
		const known = this.places.get(root);
		if (known && Date.now() - known.at < 10_000 && fs.existsSync(path.join(known.dir, "HEAD"))) return known;
		const dir = path.join(this.dir, crypto.createHash("sha256").update(root).digest("hex").slice(0, 24));
		if (!fs.existsSync(path.join(dir, "HEAD"))) {
			fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			// Without a template: nothing is copied into it that pine did not write.
			await this.must("the place for this folder's states could not be made", git(this.dir, ["init", "-q", "--bare", "--template=", dir], { write: [this.dir] }));
			fs.mkdirSync(path.join(dir, "info"), { recursive: true });
			fs.writeFileSync(path.join(dir, "info", "attributes"), ATTRIBUTES);
			fs.writeFileSync(path.join(dir, "pine-folder"), root);
			fs.writeFileSync(path.join(dir, TIDIED), "");
		}
		const at: Place = { dir, base: root, prefix: "", at: Date.now() };
		// In a repository the rules above the folder count too (node_modules is usually ignored at the
		// top). A folder its repository ignores altogether is not part of it: the home folder kept in
		// git with everything ignored must not mean that nothing below it is ever recorded.
		const top = await git(root, ["rev-parse", "--show-toplevel"]);
		const found = top.code === 0 && top.out.trim() ? realish(top.out.trim()) : "";
		if (found && (found === root || isInside(found, root)) && (found === root || (await git(found, ["check-ignore", "-q", "--", path.relative(found, root)])).code !== 0)) {
			at.base = found;
			at.prefix = path.relative(found, root);
			const own = await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
			const file = own.code === 0 ? own.out.trim() : "";
			if (file && path.isAbsolute(file) && fs.existsSync(file)) at.excludes = file;
		}
		this.places.set(root, at);
		return at;
	}

	/** Bring the index in line with the folder and write it as a tree. */
	private async record(at: Place, root: string): Promise<Snap> {
		const spec = at.prefix || ".";
		const exclude = path.join(at.dir, "info", "exclude");
		fs.writeFileSync(exclude, "");
		// What is new or changed since the last state: only that is looked at and stored.
		const listed = await this.must(`${root} could not be read`, this.g(at, ["ls-files", "-z", "-m", "-o", "--exclude-standard", "--", spec]));
		const large: string[] = [];
		const nested: string[] = [];
		let files = 0;
		let size = 0;
		for (const p of new Set(split(listed.raw))) {
			if (p.endsWith("/")) {
				nested.push(p);
				continue;
			}
			let stat: fs.Stats;
			try {
				// Only its size and kind are asked for, and a link is not followed.
				stat = fs.lstatSync(Buffer.concat([bytes(`${at.base}/`), bytes(p)]));
			} catch {
				continue; // deleted
			}
			if (!stat.isFile()) continue;
			if (stat.size > MAX_FILE) large.push(p);
			else (files++, (size += stat.size));
		}
		if (files > MAX_FILES || size > MAX_BYTES) throw new Error(`there is too much in ${root} to record (${files} files, ${Math.round(size / 1024 / 1024)} MB new or changed)`);
		if (large.length > MAX_SKIPPED) throw new Error(`there are too many large files in ${root} to record (${large.length})`);
		const out = [...large, ...nested];
		if (out.length) {
			if (out.some((p) => p.includes("\n"))) throw new Error(`a file in ${root} that has to be left out has a line break in its name`);
			fs.writeFileSync(exclude, `${out.map(pattern).join("\n")}\n`, "latin1");
			// One that was small before is in the index: taken out, or the tree would keep its old content as if it were the present.
			if (large.length) await this.must("a large file could not be left out", this.g(at, ["update-index", "--force-remove", "-z", "--stdin"], { stdin: bytes(`${large.join("\0")}\0`) }));
		}
		if (listed.raw.length) await this.must(`${root} could not be recorded`, this.g(at, ["add", "-A", "--", spec]));
		const tree = (await this.must(`${root} could not be recorded`, this.g(at, ["write-tree"]))).out.trim();
		if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error(`${root} could not be recorded`);
		return { tree, ...(large.length ? { skipped: large } : {}) };
	}

	private async entries(at: Place, a: string, b: string): Promise<Entry[]> {
		const got = await this.must("two states could not be compared", this.g(at, ["diff-tree", "-r", "-z", "--no-renames", "--no-abbrev", a, b]));
		const parts = split(got.raw);
		const out: Entry[] = [];
		for (let i = 0; i + 1 < parts.length; i += 2) {
			const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) \w/.exec(parts[i]);
			// A repository inside the folder is not ours to compare or restore.
			if (m && m[1] !== LINK && m[2] !== LINK) out.push({ p: parts[i + 1], from: { mode: m[1], sha: m[3] }, to: { mode: m[2], sha: m[4] } });
		}
		return out;
	}

	private outward(at: Place, e: Entry): FileChange {
		const full = shown(e.p);
		return { path: at.prefix && full.startsWith(`${at.prefix}/`) ? full.slice(at.prefix.length + 1) : full, status: e.from.mode === NONE ? "A" : e.to.mode === NONE ? "D" : "M" };
	}

	/** Record what is in a folder now. `root` is a real path. Throws with the reason when it cannot be recorded. */
	take(root: string): Promise<Snap> {
		return this.alone(root, async () => this.record(await this.place(root), root));
	}

	/** What differs between two states of a folder, with line counts. */
	changed(root: string, a: Snap, b: Snap): Promise<FileChange[]> {
		return this.alone(root, async () => {
			if (a.tree === b.tree) return [];
			const at = await this.place(root);
			const files = (await this.entries(at, a.tree, b.tree)).map((e) => ({ e, f: this.outward(at, e) }));
			const counts = await this.g(at, ["diff-tree", "-r", "-z", "--no-renames", "--numstat", a.tree, b.tree]);
			for (const line of split(counts.raw)) {
				const m = /^(\d+)\t(\d+)\t([\s\S]+)$/.exec(line);
				const hit = m && files.find((x) => x.e.p === m[3]);
				if (m && hit) Object.assign(hit.f, { added: Number(m[1]), removed: Number(m[2]) });
			}
			return files.map((x) => x.f);
		});
	}

	/** The difference of one file between two states, as git prints it. */
	diff(root: string, a: Snap, b: Snap, file: string): Promise<{ diff: string; truncated: boolean } | undefined> {
		return this.alone(root, async () => {
			if (!file || file.includes("\0")) return undefined;
			const at = await this.place(root);
			const r = await this.g(at, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", a.tree, b.tree, "--", at.prefix ? `${at.prefix}/${file}` : file]);
			if (r.code !== 0) return undefined;
			const max = 200_000;
			return { diff: r.out.slice(0, max), truncated: r.out.length > max };
		});
	}

	/**
	 * Put files of a folder back to what they were in `target`. Which files: those that differ
	 * between the two states of `within` (what one message changed), or the paths in `only`; of
	 * these, the ones that are not as in `target` now. Nothing else in the folder is touched.
	 *
	 * The folder's present state is recorded first and returned (`cur`), so that the restore can
	 * itself be taken back. `paths` are the files that were set, for exactly that.
	 *
	 * The files are written by git, never by this process. Git does not write through a link: a
	 * folder on the way that has become a link is removed and made again as a folder. Whatever it
	 * did, the sandbox it runs in can write the folder and pine's own git directory and nothing else.
	 */
	restore(root: string, target: Snap, o: { within?: [Snap, Snap]; only?: string[]; avoid?: Snap[] }): Promise<{ cur: Snap; files: FileChange[]; paths: string[]; left: string[] }> {
		return this.alone(root, async () => {
			const at = await this.place(root);
			const cur = await this.record(at, root);
			const allow = o.within ? new Set((await this.entries(at, o.within[0].tree, o.within[1].tree)).map((e) => e.p)) : new Set(o.only ?? []);
			// A file that was too large in any of the states involved has no content on record on that
			// side: setting it would put an old version over it, or delete it.
			const skip = new Set([cur, target, ...(o.avoid ?? []), ...(o.within ?? [])].flatMap((s) => s.skipped ?? []));
			const all = (await this.entries(at, cur.tree, target.tree)).filter((e) => allow.has(e.p));
			const todo = all.filter((e) => !skip.has(e.p));
			if (todo.length) {
				// The tree to go to: the present one with exactly these files as they were. Built in an index of its own.
				const index = path.join(at.dir, "restore-index");
				fs.rmSync(index, { force: true });
				const env = { GIT_INDEX_FILE: index };
				await this.must("the files could not be restored", this.g(at, ["read-tree", cur.tree], { env }));
				// What goes comes first: a file may give way to a folder of its name, or the other way round.
				const lines = [...todo.filter((e) => e.to.mode === NONE), ...todo.filter((e) => e.to.mode !== NONE)].map((e) => `${e.to.mode === NONE ? `0 ${"0".repeat(e.to.sha.length)}` : `${e.to.mode} ${e.to.sha}`}\t${e.p}\0`);
				await this.must("the files could not be restored", this.g(at, ["update-index", "-z", "--index-info"], { env, stdin: bytes(lines.join("")) }));
				const want = (await this.must("the files could not be restored", this.g(at, ["write-tree"], { env }))).out.trim();
				fs.rmSync(index, { force: true });
				// The index is the present state, so only these files differ, and only they are written or removed.
				await this.must("the files could not be restored", this.g(at, ["read-tree", "--reset", "-u", want], { write: [root] }));
			}
			return { cur, files: todo.map((e) => this.outward(at, e)), paths: todo.map((e) => e.p), left: all.filter((e) => skip.has(e.p)).map((e) => this.outward(at, e).path) };
		});
	}

	/**
	 * The tidying: states nobody refers to any more are dropped once they are a few days old, and
	 * the git directory of a folder that is gone, or that has no state left, is removed.
	 * `kept`: the trees still referred to, by folder.
	 */
	async prune(kept: Map<string, Set<string>>): Promise<void> {
		let names: string[] = [];
		try {
			names = fs.readdirSync(this.dir).filter((n) => /^[0-9a-f]{24}$/.test(n));
		} catch {
			return; // nothing recorded yet
		}
		for (const name of names) {
			const dir = path.join(this.dir, name);
			let root = "";
			try {
				root = fs.readFileSync(path.join(dir, "pine-folder"), "utf8");
			} catch {
				// not one of ours, or half made
			}
			const trees = kept.get(root);
			const age = (file: string) => {
				try {
					return Date.now() - fs.statSync(path.join(dir, file)).mtimeMs;
				} catch {
					return Number.POSITIVE_INFINITY;
				}
			};
			// The index is written with every state that is recorded. The directory's own time counts
			// too: one that is being made this moment has neither file yet and must not be taken for an old one.
			const idle = Math.min(age("."), age("index"), age(TIDIED)) > DAY;
			if (!root || !fs.existsSync(root) || !trees?.size) {
				if (idle) fs.rmSync(dir, { recursive: true, force: true });
				continue;
			}
			// Once a day is enough, and a folder in use is not held up by it more often.
			if (age(TIDIED) < DAY) continue;
			fs.writeFileSync(path.join(dir, TIDIED), "");
			await this.alone(root, async () => {
				const at: Place = { dir, base: root, prefix: "", at: 0 };
				// A tree that is referred to gets a name, which is what keeps git from dropping it.
				const have = split((await this.g(at, ["for-each-ref", "--format=%(refname)%00", "refs/pine/"])).raw).map((r) => r.trim()).filter(Boolean);
				const want = [...(trees ?? [])].filter((t) => /^[0-9a-f]{40,64}$/.test(t));
				const edits = [...have.filter((r) => !want.includes(r.slice("refs/pine/".length))).map((r) => `delete ${r}\n`), ...want.filter((t) => !have.includes(`refs/pine/${t}`)).map((t) => `update refs/pine/${t} ${t}\n`)];
				if (edits.length) await this.g(at, ["update-ref", "--stdin"], { stdin: edits.join("") });
				await this.g(at, ["gc", "--quiet", "--prune=3.days.ago"], { timeoutMs: 300_000 });
			}).catch(() => {});
		}
	}
}
