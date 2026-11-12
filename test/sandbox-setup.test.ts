import assert from "node:assert/strict";
import test from "node:test";
import { browserPlan, type Machine, PROFILE_FILE, profileFor, sandboxPlan, setUpSandbox, shown, type Step } from "../src/sandbox-setup.ts";
import { containerFlags } from "../src/security.ts";

/** A machine as pine init finds it: Ubuntu 24.04, just installed, unless said otherwise. */
const machine = (over: Partial<Machine> & { programs?: string[] } = {}): Machine => {
	const programs = over.programs ?? ["apt-get", "sudo", "apparmor_parser"];
	return { works: false, apparmor: true, profile: false, root: false, container: false, aptEmpty: false, browserLacks: [], has: (p) => programs.includes(p), ...over };
};
const commands = (m: Machine) => sandboxPlan(m).steps.map((s) => shown(s, m.root));

test("what pine init does for the sandbox follows from what the machine lacks", () => {
	assert.deepEqual(sandboxPlan(machine({ works: true, bwrap: "/usr/bin/bwrap" })), { ok: true, why: "", steps: [] });

	// Ubuntu 24.04, fresh: the package, the rule, and loading it.
	const fresh = sandboxPlan(machine());
	assert.equal(fresh.why, "bubblewrap is not installed; this system also needs an AppArmor rule for it");
	assert.deepEqual(fresh.steps.map((s) => s.argv), [["apt-get", "install", "-y", "bubblewrap"], ["install", "-m", "0644", "{file}", PROFILE_FILE], ["apparmor_parser", "-r", PROFILE_FILE]]);
	assert.equal(fresh.steps[1].content, profileFor("/usr/bin/bwrap"));
	assert.match(profileFor("/usr/bin/bwrap"), /profile bwrap \/usr\/bin\/bwrap flags=\(unconfined\) \{\n  userns,\n\}/);
	assert.deepEqual(commands(machine()), ["sudo apt-get install -y bubblewrap", `write ${PROFILE_FILE}, the rule that lets bubblewrap make sandboxes`, `sudo apparmor_parser -r ${PROFILE_FILE}`]);

	// Installed already, only AppArmor in the way; with the rule's file there, it is only loaded.
	assert.deepEqual(commands(machine({ bwrap: "/usr/bin/bwrap", said: "setting up uid map: Permission denied" })), [`write ${PROFILE_FILE}, the rule that lets bubblewrap make sandboxes`, `sudo apparmor_parser -r ${PROFILE_FILE}`]);
	assert.deepEqual(commands(machine({ bwrap: "/usr/bin/bwrap", profile: true })), [`sudo apparmor_parser -r ${PROFILE_FILE}`]);

	// Other systems: their own package manager, and no AppArmor rule where none is needed.
	assert.deepEqual(commands(machine({ apparmor: false, programs: ["dnf", "sudo"] })), ["sudo dnf install -y bubblewrap"]);
	assert.deepEqual(commands(machine({ apparmor: false, programs: ["pacman", "sudo"] })), ["sudo pacman -S --noconfirm --needed bubblewrap"]);
	assert.deepEqual(commands(machine({ apparmor: false, programs: ["zypper", "sudo"] })), ["sudo zypper --non-interactive install bubblewrap"]);

	// A container that was just made: pine is root, apt has no lists, and AppArmor is the host's.
	assert.deepEqual(commands(machine({ root: true, container: true, aptEmpty: true, programs: ["apt-get"] })), ["apt-get update", "apt-get install -y bubblewrap"]);
	assert.deepEqual(commands(machine({ root: true, container: true, apparmor: false, programs: ["apk"] })), ["apk add bubblewrap"]);
});

test("what pine cannot do is said with what would", () => {
	const noRights = sandboxPlan(machine({ bwrap: "/usr/bin/bwrap", said: "Creating new namespace failed: Operation not permitted", root: true, container: true }));
	assert.deepEqual(noRights.steps, []);
	assert.match(noRights.why, /bubblewrap cannot make a sandbox here \("Creating new namespace failed: Operation not permitted"\)/);
	assert.ok(noRights.cannot!.includes(`docker run ${containerFlags(true)} ...`) && /cannot be given from inside/.test(noRights.cannot!));
	// As root four rights are enough; an ordinary user in the container needs a fifth, for the sandbox's own /proc.
	assert.equal(containerFlags(true), "--cap-add SYS_ADMIN --cap-add NET_ADMIN --security-opt seccomp=unconfined --security-opt apparmor=unconfined");
	assert.equal(containerFlags(false), `${containerFlags(true)} --security-opt systempaths=unconfined`);
	assert.ok(sandboxPlan(machine({ bwrap: "/usr/bin/bwrap", said: "Can't mount proc", container: true })).cannot!.includes("systempaths=unconfined"));

	assert.match(sandboxPlan(machine({ bwrap: "/usr/bin/bwrap", apparmor: false })).cannot!, /Ordinary users may not create user namespaces on this system/);
	assert.match(sandboxPlan(machine({ apparmor: false, programs: ["sudo"] })).cannot!, /does not know this system's package manager\. Install the package bubblewrap/);
	assert.match(sandboxPlan(machine({ programs: ["apt-get", "sudo"] })).cannot!, /apparmor_parser, which loads a rule that allows them, is missing/);
	const noSudo = sandboxPlan(machine({ programs: ["apt-get", "apparmor_parser"] }));
	assert.match(noSudo.cannot!, /needs an administrator, and there is no sudo here\. As root, run:\n  apt-get install -y bubblewrap\n  write .*\n  apparmor_parser -r/);
	assert.deepEqual(noSudo.steps, [], "and nothing is run");
});

test("the browser gets its system libraries where apt can give them, and pine says so where it cannot", () => {
	const lacks = ["libasound.so.2", "libatk-1.0.so.0", "libgbm.so.1", "libnspr4.so", "libnss3.so"];
	assert.equal(browserPlan(machine()), undefined, "nothing is missing");
	const plan = browserPlan(machine({ browserLacks: lacks }), "/pine/node_modules/playwright-core/cli.js")!;
	assert.deepEqual(plan.step!.argv.slice(1), ["/pine/node_modules/playwright-core/cli.js", "install-deps", "chromium"]);
	assert.equal(plan.step!.elevates, true, "Playwright asks for the administrator itself, so no sudo is put in front");
	assert.equal(shown(plan.step!, false), "install the 5 system libraries (libasound.so.2, libatk-1.0.so.0, libgbm.so.1, libnspr4.so, ...) the browser of the web tools lacks (apt-get, through Playwright)");
	assert.match(browserPlan(machine({ browserLacks: lacks, programs: ["dnf", "sudo"] }))!.cannot!, /lacks 5 system libraries .*pine installs them only where apt is/);
	assert.match(browserPlan(machine({ browserLacks: ["libnss3.so"], programs: ["apt-get"] }))!.cannot!, /lacks 1 system library \(libnss3\.so\), and installing them needs an administrator/);
	assert.ok(browserPlan(machine({ browserLacks: lacks, root: true, programs: ["apt-get"] }))!.step, "root needs no sudo");
});

test("pine init asks once, runs the steps in order and looks again", async () => {
	const setup = async (opts: { answer?: boolean; yes?: boolean; fail?: number; before?: Parameters<typeof machine>[0]; after?: Parameters<typeof machine>[0] }) => {
		const lines: string[] = [];
		const ran: string[] = [];
		const asked: string[] = [];
		let looks = 0;
		const works = await setUpSandbox({
			out: (l) => lines.push(l),
			yes: opts.yes,
			confirm: async (q) => (asked.push(q), opts.answer),
			machine: () => (looks++ === 0 ? machine(opts.before) : machine({ bwrap: "/usr/bin/bwrap", works: true, ...opts.after })),
			run: (step: Step, root: boolean) => (ran.push(shown(step, root)), ran.length === opts.fail ? 1 : 0),
		});
		return { works, ran, asked, text: lines.join("\n") };
	};

	const yes = await setup({ answer: true });
	assert.equal(yes.works, true);
	assert.deepEqual(yes.asked, ["Set it up now?"]);
	assert.equal(yes.ran.length, 3);
	assert.match(yes.text, /does not work yet: bubblewrap is not installed.*\npine can set it up\. It would run as administrator \(sudo asks for your password\):\n  sudo apt-get install -y bubblewrap\n  write .*\n  sudo apparmor_parser -r .*\nThe sandbox works now\./s);

	const no = await setup({ answer: false });
	assert.deepEqual([no.works, no.ran], [false, []]);
	assert.match(no.text, /Not set up\. Run "pine init --yes" to do it.*agents get no shell/);
	const nobody = await setup({ answer: undefined });
	assert.deepEqual([nobody.works, nobody.ran], [false, []], "without a terminal nothing is run as administrator");
	assert.match(nobody.text, /Nobody is here to say yes/);
	const told = await setup({ yes: true });
	assert.deepEqual([told.works, told.asked, told.ran.length], [true, [], 3], "--yes does not ask");

	const broke = await setup({ answer: true, fail: 1 });
	assert.deepEqual([broke.works, broke.ran.length], [false, 1], "after a step that fails nothing else is run");
	assert.match(broke.text, /That did not work \(sudo apt-get install -y bubblewrap ended with 1\)/);

	// Installed in a container without the rights: said with the flags it needs.
	const boxed = await setup({ yes: true, before: { root: true, container: true, programs: ["apt-get"] }, after: { works: false, root: true, container: true, said: "Operation not permitted" } });
	assert.equal(boxed.works, false);
	assert.match(boxed.text, /It is set up, but a sandbox still cannot be made: This is a container that was started without the rights a sandbox needs.*docker run --cap-add SYS_ADMIN/s);

	// One question covers the sandbox and the browser; a sandbox that works already is said so.
	const both = await setup({ answer: true, before: { browserLacks: ["libnss3.so", "libgbm.so.1"] } });
	assert.deepEqual([both.works, both.asked.length, both.ran.length], [true, 1, 4]);
	assert.match(both.ran[3], /install the 2 system libraries/);
	assert.match(both.text, /The browser the web tools drive cannot start yet: it lacks system libraries\.\npine can set it up.*The browser has what it needs now\.\nThe sandbox works now\./s);
	const onlyBrowser = await setup({ answer: true, before: { works: true, bwrap: "/usr/bin/bwrap", browserLacks: ["libnss3.so"] } });
	assert.deepEqual([onlyBrowser.works, onlyBrowser.ran.length], [true, 1]);
	assert.match(onlyBrowser.text, /^\nThe sandbox agents run their commands in works\.\nThe browser the web tools drive cannot start yet.*pine can set this up/s);
	const declined = await setup({ answer: false, before: { works: true, bwrap: "/usr/bin/bwrap", browserLacks: ["libnss3.so"] } });
	assert.equal(declined.works, true, "the sandbox works whatever is said about the browser");
	assert.ok(!/no shell/.test(declined.text));

	const fine = await setup({ before: { works: true, bwrap: "/usr/bin/bwrap" } });
	assert.deepEqual([fine.works, fine.asked, fine.ran], [true, [], []]);
	assert.match(fine.text, /The sandbox agents run their commands in works\./);
});
