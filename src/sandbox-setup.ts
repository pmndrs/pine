import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { containerFlags, inContainer, sandboxFound, sandboxMissing, sandboxRecheck } from "./security.ts";

// On Linux pine needs things that only an administrator can give. For the sandbox: the
// bubblewrap package, and on Ubuntu 24.04 and later an AppArmor rule that lets it work. For the
// browser of the web tools: system libraries a server or a container does not have. pine init
// looks at what is missing, says what it would run and, after one yes, runs it (with sudo when
// it is not root itself). Nobody should have to copy commands out of a manual for this.

/** What pine init looks at. A function of this alone decides what to do, so it can be tested without a machine. */
export interface Machine {
	/** Where bwrap is, when it is installed. */
	bwrap?: string;
	/** Whether a sandbox could be made, and what bubblewrap said when not. */
	works: boolean;
	said?: string;
	/** The kernel keeps ordinary programs from making user namespaces unless AppArmor allows it (Ubuntu). */
	apparmor: boolean;
	/** There is a file at PROFILE_FILE already. */
	profile: boolean;
	/** Whether a program is there: a package manager, sudo, apparmor_parser. */
	has(program: string): boolean;
	root: boolean;
	container: boolean;
	/** apt has no package lists yet, as in a container that was just made. */
	aptEmpty: boolean;
	/** System libraries the downloaded browser needs and does not find. */
	browserLacks: string[];
}

export interface Step {
	/** What it does, in words. */
	says: string;
	/** The command, without sudo. "{file}" stands for a file holding `content`. */
	argv: string[];
	content?: string;
	/** It asks for administrator rights itself, so pine does not put sudo in front. */
	elevates?: boolean;
}

export interface Plan {
	/** Nothing to do. */
	ok: boolean;
	/** What is missing, in words. */
	why: string;
	steps: Step[];
	/** Why pine cannot do it here, and what would. */
	cannot?: string;
}

export const PROFILE_FILE = "/etc/apparmor.d/bwrap";

/** The rule that lets bubblewrap make the user namespaces its sandboxes consist of. */
export const profileFor = (bwrap: string) => `# Written by pine init. It lets bubblewrap, which pine's sandbox is built on, create user namespaces.
abi <abi/4.0>,
include <tunables/global>

profile bwrap ${bwrap} flags=(unconfined) {
  userns,
}
`;

const INSTALL: Array<[string, string[]]> = [
	["apt-get", ["apt-get", "install", "-y", "bubblewrap"]],
	["dnf", ["dnf", "install", "-y", "bubblewrap"]],
	["yum", ["yum", "install", "-y", "bubblewrap"]],
	["pacman", ["pacman", "-S", "--noconfirm", "--needed", "bubblewrap"]],
	["zypper", ["zypper", "--non-interactive", "install", "bubblewrap"]],
	["apk", ["apk", "add", "bubblewrap"]],
];

const boxed = (root: boolean) => `This is a container that was started without the rights a sandbox needs, and they cannot be given from inside. Start it with:\n  docker run ${containerFlags(root)} ...`;

/** What has to be done on this machine for the sandbox to work. */
export function sandboxPlan(m: Machine): Plan {
	if (m.works) return { ok: true, why: "", steps: [] };
	const steps: Step[] = [];
	const missing: string[] = [];
	let cannot: string | undefined;

	if (!m.bwrap) {
		missing.push("bubblewrap is not installed");
		const manager = INSTALL.find(([program]) => m.has(program));
		if (!manager) cannot = "pine does not know this system's package manager. Install the package bubblewrap (the program is bwrap), then run pine init again.";
		else {
			if (manager[0] === "apt-get" && m.aptEmpty) steps.push({ says: "fetch the list of packages", argv: ["apt-get", "update"] });
			steps.push({ says: "install bubblewrap", argv: manager[1] });
		}
	}
	// AppArmor belongs to the host: inside a container there is nothing to load a rule into.
	if (m.apparmor && !m.container) {
		missing.push(m.bwrap ? "AppArmor keeps bubblewrap from making a sandbox" : "this system also needs an AppArmor rule for it");
		if (!m.has("apparmor_parser")) cannot ??= `AppArmor restricts user namespaces here, and apparmor_parser, which loads a rule that allows them, is missing. Install the package apparmor, then run pine init again.`;
		else {
			if (!m.profile) steps.push({ says: `write ${PROFILE_FILE}, the rule that lets bubblewrap make sandboxes`, argv: ["install", "-m", "0644", "{file}", PROFILE_FILE], content: profileFor(m.bwrap ?? "/usr/bin/bwrap") });
			steps.push({ says: "load that rule", argv: ["apparmor_parser", "-r", PROFILE_FILE] });
		}
	} else if (m.bwrap) {
		// It is installed and nothing pine can change stands in its way.
		missing.push(`bubblewrap cannot make a sandbox here${m.said ? ` ("${m.said}")` : ""}`);
		cannot = m.container ? boxed(m.root) : "Ordinary users may not create user namespaces on this system. Its administrator can allow them (often: sysctl kernel.unprivileged_userns_clone=1).";
	}
	if (!cannot && steps.length && !m.root && !m.has("sudo")) cannot = `This needs an administrator, and there is no sudo here. As root, run:\n${steps.map((s) => `  ${shown(s)}`).join("\n")}`;
	return { ok: false, why: missing.join("; "), steps: cannot ? [] : steps, cannot };
}

/**
 * What the browser needs, when it lacks system libraries. Playwright, whose browser it is, knows
 * the packages; it installs them with apt, so only where apt is.
 */
export function browserPlan(m: Machine, cli = playwrightCli()): { step?: Step; cannot?: string } | undefined {
	if (!m.browserLacks.length) return undefined;
	const lacks = `${m.browserLacks.length} system ${m.browserLacks.length === 1 ? "library" : "libraries"} (${m.browserLacks.slice(0, 4).join(", ")}${m.browserLacks.length > 4 ? ", ..." : ""})`;
	if (!m.has("apt-get")) return { cannot: `The browser the web tools drive lacks ${lacks}. pine installs them only where apt is; here they come from this system's package manager. Web search and page reading work without the browser.` };
	if (!m.root && !m.has("sudo")) return { cannot: `The browser the web tools drive lacks ${lacks}, and installing them needs an administrator. As root: npx playwright install-deps chromium` };
	return { step: { says: `install the ${lacks} the browser of the web tools lacks (apt-get, through Playwright)`, argv: [process.execPath, cli, "install-deps", "chromium"], elevates: true } };
}

/** Playwright's own command, of the copy pine ships with. */
function playwrightCli(): string {
	return path.join(path.dirname(createRequire(import.meta.url).resolve("playwright-core")), "cli.js");
}

/** A step as the owner reads it. */
export const shown = (step: Step, root = true) => (step.content || step.elevates ? step.says : `${root ? "" : "sudo "}${step.argv.join(" ")}`);

/** The libraries the downloaded browser does not find, by what the system's loader says. */
function browserLacks(): string[] {
	const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright");
	const programs: string[] = [];
	const visit = (d: string, depth: number) => {
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.isDirectory() && depth < 2 && (depth > 0 || e.name.startsWith("chromium"))) visit(path.join(d, e.name), depth + 1);
			else if (e.isFile() && ["chrome", "chrome-headless-shell", "headless_shell"].includes(e.name)) programs.push(path.join(d, e.name));
		}
	};
	visit(dir, 0);
	const lacks = new Set<string>();
	for (const program of programs) {
		const out = spawnSync("ldd", [program], { encoding: "utf8", timeout: 10_000 }).stdout ?? "";
		for (const m of out.matchAll(/^\s*(\S+) => not found/gm)) lacks.add(m[1]);
	}
	return [...lacks].sort();
}

/** This machine, looked at. */
export function lookAtMachine(): Machine {
	sandboxRecheck();
	const found = sandboxFound();
	const dirs = [...new Set([...(process.env.PATH ?? "").split(":").filter((d) => path.isAbsolute(d)), "/usr/sbin", "/usr/bin", "/sbin", "/bin", "/usr/local/bin"])];
	const reads = (file: string) => {
		try {
			return fs.readFileSync(file, "utf8");
		} catch {
			return "";
		}
	};
	return {
		bwrap: found.bwrap || undefined,
		works: found.works,
		said: found.said || undefined,
		apparmor: reads("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").trim() === "1",
		profile: fs.existsSync(PROFILE_FILE),
		has: (program) => dirs.some((d) => fs.existsSync(path.join(d, program))),
		root: process.getuid?.() === 0,
		container: inContainer(),
		browserLacks: browserLacks(),
		aptEmpty: !(() => {
			try {
				return fs.readdirSync("/var/lib/apt/lists").some((f) => f.endsWith("_Packages") || f.endsWith("_Packages.lz4"));
			} catch {
				return false;
			}
		})(),
	};
}

/** Run a step as an administrator. sudo asks for the password itself; pine never sees it. */
function runStep(step: Step, root: boolean): number {
	let dir: string | undefined;
	try {
		let argv = step.argv;
		if (step.content !== undefined) {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-setup-"));
			const file = path.join(dir, "file");
			fs.writeFileSync(file, step.content, { mode: 0o644 });
			argv = argv.map((a) => (a === "{file}" ? file : a));
		}
		const full = root || step.elevates ? argv : ["sudo", ...argv];
		return spawnSync(full[0], full.slice(1), { stdio: "inherit" }).status ?? 1;
	} finally {
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
}

export interface SetupIo {
	out(line: string): void;
	/** Ask a yes-or-no question; undefined when nobody is there to answer. */
	confirm(question: string): Promise<boolean | undefined>;
	/** Do it without asking. */
	yes?: boolean;
	machine?: () => Machine;
	run?: (step: Step, root: boolean) => number;
}

/**
 * Make the sandbox work on this Linux machine and give the browser its libraries, or say
 * plainly why not. Returns whether the sandbox works afterwards. pine runs either way; without
 * a sandbox agents get no shell.
 */
export async function setUpSandbox(io: SetupIo): Promise<boolean> {
	const look = io.machine ?? lookAtMachine;
	const run = io.run ?? runStep;
	const machine = look();
	const plan = sandboxPlan(machine);
	const web = browserPlan(machine);
	if (plan.ok && !web) {
		io.out("\nThe sandbox agents run their commands in works.");
		return true;
	}
	const noShell = "Until then pine runs, but agents get no shell.";
	io.out(plan.ok ? "\nThe sandbox agents run their commands in works." : `\nThe sandbox agents run their commands in does not work yet: ${plan.why}.`);
	if (plan.cannot) io.out(`${plan.cannot}\n${noShell}`);
	if (web?.cannot) io.out(web.cannot);
	const steps = [...plan.steps, ...(web?.step ? [web.step] : [])];
	if (!steps.length) return plan.ok;
	if (web?.step) io.out("The browser the web tools drive cannot start yet: it lacks system libraries.");
	io.out(`pine can set ${steps.length === 1 ? "this" : "it"} up. It would ${machine.root ? "run" : "run as administrator (sudo asks for your password)"}:\n${steps.map((s) => `  ${shown(s, machine.root)}`).join("\n")}`);
	const go = io.yes ? true : await io.confirm("Set it up now?");
	if (!go) {
		io.out(`${go === undefined ? "Nobody is here to say yes" : "Not set up"}. Run "pine init --yes" to do it, or pine init again in a terminal.${plan.ok ? "" : ` ${noShell}`}`);
		return plan.ok;
	}
	for (const step of steps) {
		const status = run(step, machine.root);
		if (status !== 0) {
			io.out(`\nThat did not work (${shown(step, machine.root)} ended with ${status}). Nothing else was changed.${plan.ok ? "" : ` ${noShell}`}`);
			return plan.ok;
		}
	}
	const after = look();
	if (web?.step) io.out(after.browserLacks.length ? `The browser still lacks ${after.browserLacks.join(", ")}.` : "The browser has what it needs now.");
	if (plan.ok) return true;
	if (after.works) {
		io.out("The sandbox works now.");
		return true;
	}
	// Installed, and still nothing: what stands in the way is not pine's to change.
	const second = sandboxPlan(after);
	io.out(`\nIt is set up, but a sandbox still cannot be made: ${second.cannot ?? (sandboxMissing() || second.why)}\n${noShell}`);
	return false;
}
