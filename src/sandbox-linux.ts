import fs from "node:fs";
import path from "node:path";

// The agent sandbox on Linux, built with bubblewrap (bwrap).
//
// The rules are the ones the macOS profile in security.ts states; here they are said with mounts.
// A command sees the file system as its agent may see it: everything read-only, the owner's home
// and pine's home empty, the agent's own folders put back in (read-only or writable), and no
// network unless it was granted. Nothing in this file decides what an agent may do: it takes the
// same lists of folders the macOS profile takes and turns them into arguments.
//
// Mounts do not keep a program from connecting to a socket that lies where it can read, and
// behind sockets are the desktop session, the keyring, a container daemon, a terminal
// multiplexer that runs commands for whoever asks. Without the network a command therefore
// also gets a system call filter that refuses sockets of that kind (`noLocalSockets`), which
// is what the macOS profile's "no network" means too.
//
// One thing mounts cannot say is "no file of this name may be created". The macOS profile forbids
// writing instruction files and a repository's hooks by pattern. Here, what exists is mounted
// read-only, and what did not exist is taken away again after the command (see `Guard`).

export interface Jail {
	/** The owner's home folder: closed, except for what is listed below. */
	userHome: string;
	/** pine's home folder: closed wherever it lies, except for the agent's own folders. */
	pineHome: string;
	/** pine's program files: never writable. */
	pineCode: string;
	read: string[];
	write: string[];
	ownedRead: string[];
	ownedWrite: string[];
	/** Closed even where a wider rule would open them. */
	closed: string[];
	/**
	 * Folders in which the services of the machine listen (/run). They stay readable, but the
	 * sockets in them are covered, for the case that the network (and with it sockets) is
	 * granted: behind them are the container daemon and the system bus. Default: `SHARED`.
	 */
	shared?: string[];
	network: boolean;
	variant: "normal" | "restricted";
	/** For a run that has read outside content: what exists and may not be changed, and repositories whose folder may not be moved aside. */
	frozen?: { paths: string[]; repositories: string[] };
}

const isInside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const exists = (p: string) => {
	try {
		fs.lstatSync(p);
		return true;
	} catch {
		return false;
	}
};
const isDir = (p: string) => {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
};
/** Parents before what lies in them, so that a later mount never hides an earlier one by accident. */
const shallowFirst = (list: string[]) => [...new Set(list)].filter(exists).sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));

/**
 * Where services of the machine and of the desktop session listen. `SESSIONS` are closed whole;
 * in `SHARED` each socket is covered. Only folders whose content stays: covering something in a
 * temp folder that is gone a moment later would make the command fail.
 */
export const SHARED = ["/run", "/var/run"];
export const SESSIONS = ["/run/user", "/tmp/.X11-unix", "/tmp/.ICE-unix"];

/**
 * A system call filter (seccomp, as a compiled BPF program) that refuses to make a socket of
 * the kind that connects programs on one machine (AF_UNIX), by name or by file. Pairs of
 * connected sockets, which a program makes to talk to its own children, are another call and
 * stay allowed. Programs built for another processor (32 bit on a 64 bit system) are refused
 * whole, because they make sockets through calls this filter does not read.
 * Undefined on a processor this was not written for.
 */
export function noLocalSockets(arch: string = process.arch): Buffer | undefined {
	// The processor's number in a system call's record, and the number of the socket call on it.
	const known: Record<string, [number, number]> = { x64: [0xc000003e, 41], arm64: [0xc00000b7, 198] };
	if (!known[arch]) return undefined;
	const [processor, socket] = known[arch];
	const LOAD = 0x20;
	const EQUAL = 0x15;
	const AT_LEAST = 0x35;
	const RETURN = 0x06;
	const ALLOW = 0x7fff0000;
	const refuse = (errno: number) => 0x00050000 | errno;
	// [code, jump if true, jump if false, value]; a jump counts the instructions it skips.
	const program: Array<[number, number, number, number]> = [
		[LOAD, 0, 0, 4], // which processor the call was made for
		[EQUAL, 0, 7, processor], // another one: refuse (9)
		[LOAD, 0, 0, 0], // which call
		[AT_LEAST, 5, 0, 0x40000000], // the 32 bit calls of a 64 bit processor: refuse (9)
		[EQUAL, 0, 2, socket], // not "socket": allow (7)
		[LOAD, 0, 0, 16], // its first argument: the kind of socket
		[EQUAL, 1, 0, 1], // AF_UNIX: refuse (8)
		[RETURN, 0, 0, ALLOW],
		[RETURN, 0, 0, refuse(1)], // "Operation not permitted"
		[RETURN, 0, 0, refuse(38)], // "Function not implemented"
	];
	const out = Buffer.alloc(program.length * 8);
	program.forEach(([code, yes, no, value], i) => {
		out.writeUInt16LE(code, i * 8);
		out.writeUInt8(yes, i * 8 + 2);
		out.writeUInt8(no, i * 8 + 3);
		out.writeUInt32LE(value >>> 0, i * 8 + 4);
	});
	return out;
}

/**
 * The whole command line in front of a command: bwrap with its arguments, and with the filter
 * when local sockets are to be refused. bwrap reads a filter from an open file; a shell opens
 * one for it that holds the filter's bytes, so no file of pine's has to lie where it is found.
 */
export function jailed(bwrap: string, args: string[], localSockets: boolean, arch: string = process.arch): string[] {
	const filter = localSockets ? undefined : noLocalSockets(arch);
	if (!filter) return [bwrap, ...args];
	const bash = ["/bin/bash", "/usr/bin/bash"].find(exists) ?? "bash";
	const bytes = [...filter].map((b) => `\\${b.toString(8).padStart(3, "0")}`).join("");
	return [bash, "-c", 'exec 9< <(printf "$0") && exec "$@"', bytes, bwrap, "--seccomp", "9", ...args];
}

/**
 * The sockets in the shared folders, a few levels down. A read-only mount does not keep a
 * program from connecting to a socket, so each is covered. Sockets made after this look are not
 * covered; `--unshare-net` closes the ones that have no file at all.
 */
export function sockets(dirs: string[], skip: string[] = []): string[] {
	const found: string[] = [];
	let seen = 0;
	const walk = (dir: string, depth: number) => {
		for (const e of readDir(dir)) {
			if (++seen > 4000) return;
			const full = path.join(dir, e.name);
			if (e.isSocket()) found.push(full);
			else if (e.isDirectory() && !e.isSymbolicLink() && depth < 3 && !skip.includes(full)) walk(full, depth + 1);
		}
	};
	for (const dir of new Set(dirs)) if (isDir(dir) && !fs.lstatSync(dir).isSymbolicLink()) walk(dir, 0);
	return found.sort();
}

/**
 * Where pine runs as root (a container, usually), bubblewrap would hand the command root's
 * powers, and with them it could take the mounts away again. In every variant it gets none.
 */
const POWERLESS = ["--cap-drop", "ALL"];

/** The arguments for bwrap, up to and including the "--" after which the command follows. */
export function bwrapArgs(jail: Jail): string[] {
	const args: string[] = [];
	const ro = (p: string) => args.push("--ro-bind", p, p);
	const rw = (p: string) => args.push("--bind", p, p);
	/** An empty folder in place of a folder. Made read-only at the end, once the folders put back into it have their places. */
	const emptied: string[] = [];
	const empty = (p: string) => (emptied.push(p), args.push("--tmpfs", p));
	const seal = () => {
		for (const p of emptied) args.push("--remount-ro", p);
	};
	/** Close a path that a wider mount has opened: an empty folder in place of a folder, an empty file in place of a file. */
	const close = (p: string) => {
		if (isDir(p)) empty(p);
		else if (exists(p)) args.push("--ro-bind", "/dev/null", p);
	};
	const owned = () => {
		// pine's home is closed wherever it lies; only the agent's own folders in it are put back.
		if (isDir(jail.pineHome)) empty(jail.pineHome);
		for (const p of shallowFirst(jail.ownedRead.filter((r) => isInside(jail.pineHome, r)))) ro(p);
		for (const p of shallowFirst(jail.ownedWrite.filter((r) => isInside(jail.pineHome, r)))) rw(p);
	};

	// Everything can be read and nothing written; devices and /proc are the sandbox's own.
	args.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc");
	// The owner's home is closed. What the agent was given is put back, folder by folder.
	if (isDir(jail.userHome) && jail.userHome !== path.parse(jail.userHome).root) empty(jail.userHome);
	for (const p of shallowFirst(jail.read)) ro(p);
	for (const p of shallowFirst(jail.write)) rw(p);
	owned();
	// What must stay closed although it lies inside something that was just opened. Whatever lies
	// in a closed folder (pine's home, the owner's home) and was not put back is closed already.
	// pine's home was closed last, so in it only the agent's own folders count as opened.
	const own = [...jail.ownedRead, ...jail.ownedWrite];
	const opened = [...jail.read, ...jail.write, ...own];
	const hidden = (p: string) => (isInside(jail.pineHome, p) ? !own.some((r) => isInside(r, p)) : isInside(jail.userHome, p) && !opened.some((r) => isInside(r, p)));
	for (const p of shallowFirst(jail.closed)) if (!hidden(p)) close(p);
	// The services of the machine and of the desktop: what the macOS profile denies by name
	// (keychain, clipboard, other programs) is reached through sockets here.
	for (const p of sockets(jail.shared ?? SHARED, jail.closed)) if (!jail.closed.some((c) => isInside(c, p))) args.push("--ro-bind", "/dev/null", p);
	if (jail.variant === "restricted" && jail.frozen) {
		// A repository's folder becomes a mount of its own, so that it cannot be moved aside and
		// another put in its place. Then what exists and must not change is mounted read-only.
		// Only where the agent can write at all: a mount would otherwise open what is closed to it.
		const writable = (p: string) => (isInside(jail.pineHome, p) ? jail.ownedWrite : [...jail.write, ...jail.ownedWrite]).some((r) => isInside(r, p));
		for (const p of shallowFirst(jail.frozen.repositories.filter(writable))) rw(p);
		for (const p of shallowFirst(jail.frozen.paths.filter(writable))) ro(p);
	}
	seal();
	if (!jail.network) args.push("--unshare-net");
	// Its own process list, so it sees and signals nothing but itself; gone when pine is gone;
	// and no way to type into the terminal pine runs in.
	args.push(...POWERLESS, "--unshare-pid", "--unshare-ipc", "--die-with-parent", "--new-session", "--");
	return args;
}

/** A helper that may read everything, write only in `write`, and has no network: git for a view, a picture converter. */
export function helperArgs(write: string[], shared = SHARED, sessions = SESSIONS): string[] {
	const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
	for (const p of shallowFirst(write)) args.push("--bind", p, p);
	for (const p of sessions) if (isDir(p)) args.push("--tmpfs", p);
	for (const p of sockets(shared, sessions)) args.push("--ro-bind", "/dev/null", p);
	for (const p of sessions) if (isDir(p)) args.push("--remount-ro", p);
	args.push("--unshare-net", ...POWERLESS, "--unshare-pid", "--unshare-ipc", "--die-with-parent", "--new-session", "--");
	return args;
}

export interface Protected {
	/** The agent's folders in which these rules hold: its workspace, and a folder opened for the conversation. */
	roots: string[];
	/** Single files that may not change, wherever they lie (USER.md, the files at the top of the workspace). */
	files: string[];
	/** File names that may not change anywhere under a root (AGENTS.md, CLAUDE.md, ...). */
	names: string[];
	/** Folders at the top of a root that may not change (.pi, .agents). */
	dirs: string[];
	/** Single files that may change all the same: the agent's own files, once the owner has said so for the conversation. */
	open?: string[];
}

/** How far down the look goes. Exported because it is a limit of the protection, and the manual states it. */
export const DEPTH = 6;
const MAX_DIRS = 20_000;
const SKIP = new Set(["node_modules", ".venv", "venv", "__pycache__", ".cache", ".npm", ".pnpm-store", ".yarn", ".gradle", ".tox", ".next", "dist", "build", "target", "DerivedData"]);

/**
 * Every place under the roots that the rules protect and that exists right now: instruction
 * files, the protected folders, and for each repository its hooks and its configuration (also of
 * its submodules). Looked for `DEPTH` levels deep and not in folders of installed packages or
 * build output: a tree is not searched to the bottom for every command.
 */
export function protectedNow(p: Protected): { paths: string[]; repositories: string[] } {
	const paths = new Set<string>(p.files.filter(exists));
	const repositories = new Set<string>();
	let seen = 0;
	const repository = (git: string) => {
		if (!isDir(git)) return; // a submodule's or worktree's ".git" is a file that points elsewhere
		repositories.add(git);
		for (const name of ["hooks", "config"]) if (exists(path.join(git, name))) paths.add(path.join(git, name));
		// Submodules keep their own hooks and configuration under modules/.
		const walk = (dir: string, depth: number) => {
			if (depth > 4 || !isDir(dir)) return;
			for (const name of ["hooks", "config"]) if (exists(path.join(dir, name)) && exists(path.join(dir, "HEAD"))) paths.add(path.join(dir, name));
			for (const e of readDir(dir)) if (e.isDirectory() && !["hooks", "objects", "refs", "logs", "info"].includes(e.name)) walk(path.join(dir, e.name), depth + 1);
		};
		walk(path.join(git, "modules"), 0);
	};
	const visit = (dir: string, depth: number, top: boolean) => {
		if (++seen > MAX_DIRS) return;
		for (const e of readDir(dir)) {
			const full = path.join(dir, e.name);
			if (e.name === ".git") repository(full);
			else if (top && p.dirs.includes(e.name)) paths.add(full);
			else if (!e.isDirectory() && p.names.includes(e.name)) paths.add(full);
			else if (e.isDirectory() && !e.isSymbolicLink() && depth < DEPTH && !SKIP.has(e.name)) visit(full, depth + 1, false);
		}
	};
	for (const root of p.roots) if (isDir(root)) visit(root, 0, true);
	for (const file of p.open ?? []) paths.delete(file);
	return { paths: [...paths], repositories: [...repositories] };
}

function readDir(dir: string): fs.Dirent[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/**
 * What mounts cannot forbid: making a protected file or folder that was not there. Taken before
 * a command that outside content may steer; `restore` after it removes every protected path the
 * command made, and says which. (What was there before is mounted read-only and cannot have changed.)
 */
export class Guard {
	private p: Protected;
	private before: Set<string>;

	constructor(p: Protected) {
		this.p = p;
		this.before = this.all();
	}

	/** Protected paths and repositories as they are now, plus the names at the top of each root that would be protected if they existed. */
	private all(): Set<string> {
		const now = protectedNow(this.p);
		return new Set([...now.paths, ...now.repositories]);
	}

	restore(): string[] {
		const made = [...this.all()].filter((x) => !this.before.has(x)).sort((a, b) => a.length - b.length);
		const gone: string[] = [];
		for (const x of made) {
			if (gone.some((g) => isInside(g, x))) continue;
			try {
				fs.rmSync(x, { recursive: true, force: true });
				gone.push(x);
			} catch {
				// what cannot be removed is reported by whoever reads the list as still there
			}
		}
		return gone;
	}
}
