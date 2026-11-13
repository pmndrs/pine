import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Denials, type DenialTools, fromOutput, gather, reaches, sortDenials } from "../src/access.ts";
import { rootsFor, sandboxAvailable, sandboxProfile } from "../src/security.ts";
import { harness, MCP_STUB, mockMsg, notesOf } from "./support/harness.ts";

// A home of the test's own. What lies in it is "the owner's files": outside every agent's
// sandbox, as the owner's real home is, and nothing of the real one is touched.
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pine-owner-home-")));
process.env.HOME = HOME;
process.on("exit", () => fs.rmSync(HOME, { recursive: true, force: true }));

const owner = { trust: "owner" as const };
const sandbox = { skip: !sandboxAvailable() };
const call = (name: string, args: any) => ({ name, args });
/** An agent that works in its own folders, without the shared temp folder (the test's home lies in it). */
const spec = () => ({ pine: { main: "main", security: { askAccess: true } }, agents: { main: {}, banks: { agent: { description: "money", tools: ["read", "bash", "edit", "write", "grep", "find", "ls"], sandbox: { sharedTmp: false } } } } }) as any;
const put = (rel: string, content: string) => {
	const file = path.join(HOME, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
};
function answering(h: Awaited<ReturnType<typeof harness>>, allow: (req: any) => boolean) {
	const asked: any[] = [];
	h.pine.bus.subscribe("approval/requested", (e) => {
		asked.push(e.payload);
		h.pine.approvals.decide((e.payload as any).id, allow(e.payload), "test");
	});
	return asked;
}
const runner = (h: Awaited<ReturnType<typeof harness>>, session = "work", trust: "owner" | "untrusted" = "owner") => async (...tools: any[]) => {
	await h.pine.agents.run({ agent: "banks", session, prompt: mockMsg([{ tools }]), trust });
	return h.toolResults().slice(-tools.length);
};

test("access: the paths a command names are read from its text, with what it writes", () => {
	const where = { cwd: "/w/space", shellHome: "/pine/sandbox/a", ownerHome: "/Users/o" };
	const of = (command: string) => reaches(command, where).map((r) => `${r.write ? "write" : "read"} ${r.path}${r.owner ? ` (owner: ${r.owner})` : ""}`);
	assert.deepEqual(of("cat /Users/o/notes/a.txt"), ["read /Users/o/notes/a.txt"]);
	assert.deepEqual(of('ls -la "/Users/o/My Files" 2>/dev/null && echo ok'), ["read /Users/o/My Files"]);
	assert.deepEqual(of("cp /Users/o/a.pdf inbox/ && cp inbox/a.pdf /Users/o/out/"), ["read /Users/o/a.pdf", "write /Users/o/out"]);
	assert.deepEqual(of("echo hi > /Users/o/out.txt; date | tee -a /Users/o/log.txt"), ["write /Users/o/out.txt", "write /Users/o/log.txt"]);
	assert.deepEqual(of("mkdir -p /Users/o/new && rm /Users/o/old.txt"), ["write /Users/o/new", "write /Users/o/old.txt"]);
	assert.deepEqual(of("cp /Users/o/scans/*.pdf inbox/"), ["read /Users/o/scans"], "a pattern is the folder it looks in");
	assert.deepEqual(of('for f in /Users/o/in/$name; do cat "$f"; done'), ["read /Users/o/in"]);
	assert.deepEqual(of("tool --input=/Users/o/in.csv --verbose"), ["read /Users/o/in.csv"]);
	assert.deepEqual(of("ls ~/documents/scans"), ["read /pine/sandbox/a/documents/scans (owner: /Users/o/documents/scans)"], "~ is the shell's home, and the owner's is kept beside it");
	assert.deepEqual(of('cat "$HOME/x" ${HOME}/y'), ["read /pine/sandbox/a/x (owner: /Users/o/x)", "read /pine/sandbox/a/y (owner: /Users/o/y)"]);
	assert.deepEqual(of("cat ../../etc/x"), ["read /etc/x"]);
	// What names nothing outside: the program itself, relative paths, devices, a fd.
	assert.deepEqual(of("/usr/bin/python3 tool.py data/in.csv > out.txt 2>&1"), []);
	assert.deepEqual(of("echo x > /dev/null; FOO=/Users/o/x true"), []);
	// The same path twice is one entry, and a write counts.
	assert.deepEqual(of("cat /Users/o/a; echo x >> /Users/o/a"), ["write /Users/o/a"]);
});

test("access: the system's reports and a failed command's words are sorted into paths, network and services", () => {
	const d = (op: string, target: string) => ({ process: "p", op, target });
	const sorted = sortDenials([
		d("file-read-data", "/Users/o/a"),
		d("file-read-data", "/Users/o/b"),
		d("file-write-create", "/Users/o/b"),
		d("file-write-data", "/dev/dtracehelper"),
		d("file-ioctl", "path:/dev/dtracehelper ioctl-command:(_IO \"h\" 4)"),
		d("network-outbound", "/private/var/run/mDNSResponder"),
		d("network-outbound", "/private/var/run/syslog"),
		d("mach-lookup", "com.apple.windowserver.active"),
		d("mach-lookup", "com.apple.diagnosticd"),
	]);
	assert.deepEqual(sorted, { read: ["/Users/o/a"], write: ["/Users/o/b"], network: true, services: ["com.apple.windowserver.active"] });
	assert.equal(sortDenials([d("network-outbound", "/private/var/run/syslog"), d("network-bind", "local:*:0")]).network, false, "the system's log socket, and a socket for itself, are not the network");
	assert.equal(sortDenials([d("network-outbound", "remote:1.1.1.1:80")]).network, true);
	assert.equal(sortDenials([d("network-bind", "local:*:8000")]).network, true, "a port it wanted to listen on is");

	assert.deepEqual(fromOutput("ls: /Users/o/dev/test: Operation not permitted\nok /Users/o/other"), { paths: ["/Users/o/dev/test"], network: false });
	assert.deepEqual(fromOutput("touch: cannot touch '/home/o/x.txt': Read-only file system").paths, ["/home/o/x.txt"]);
	assert.equal(fromOutput("curl: (6) Could not resolve host: example.com").network, true);
	assert.equal(fromOutput("fatal: unable to access 'https://x/': Temporary failure in name resolution").network, true);
	assert.deepEqual(fromOutput("nothing matched"), { paths: [], network: false });

	// Few questions for many refusals.
	assert.deepEqual(gather(["/Users/o/scans/a.pdf", "/Users/o/scans/b.pdf"], ["/Users/o/scans"]), ["/Users/o/scans"], "what lies in something the command named is that thing");
	assert.deepEqual(gather(["/Users/o/d/1", "/Users/o/d/2", "/Users/o/d/3", "/Users/o/e/1"], []), ["/Users/o/e/1", "/Users/o/d"], "several in one folder are the folder");
	assert.deepEqual(gather(["/Users/o/d/1", "/Users/o/d/2"], []), ["/Users/o/d/1", "/Users/o/d/2"]);
});

test("access: a file tool that is given a path outside the sandbox makes pine ask the owner; a no is kept, and a run from outside is not asked about", sandbox, async () => {
	const bill = put("papers/bill.txt", "BILL-219\n");
	const secret = put("locked/secret.txt", "SECRET\n");
	const h = await harness(spec());
	const asked = answering(h, (r) => !/secret/.test(r.summary));
	const run = runner(h);

	let out = await run(call("read", { path: bill }));
	assert.ok(out[0].includes("BILL-219"), out[0]);
	assert.equal(asked.length, 1, "asked once, by pine: the agent did not call request_access");
	assert.equal(asked[0].tool, "request_access");
	assert.equal(asked[0].summary, `read ${bill}\nfor: read ${bill}`);
	assert.match(asked[0].why, /banks is about to do this, and it lies outside its sandbox\. A yes holds for this conversation/);
	out = await run(call("read", { path: bill }), call("bash", { command: `cat ${bill}` }));
	assert.ok(out[0].includes("BILL-219") && out[1].includes("BILL-219"), "the yes holds for the conversation, for the shell too");
	assert.equal(asked.length, 1);

	// A no: the call is refused with the owner's answer, and the same thing is not asked again here.
	out = await run(call("read", { path: secret }));
	assert.match(out[0], /secret\.txt is outside what this conversation may read\. Your owner said no to this in this conversation: read .*secret\.txt\. Do not retry/);
	assert.equal(asked.length, 2);
	out = await run(call("read", { path: secret }), call("bash", { command: `cat ${secret}` }));
	assert.match(out[0], /Your owner said no/);
	assert.match(out[1], /Not run: the command reaches outside your sandbox\. Your owner said no/);
	assert.equal(asked.length, 2, "not asked a second time");

	// Writing is asked for as writing.
	const made = path.join(HOME, "papers", "note.txt");
	out = await run(call("write", { path: made, content: "paid" }));
	assert.equal(fs.readFileSync(made, "utf8"), "paid");
	assert.match(asked[2].summary, /^write /);

	// pine's own files are never put to the owner.
	out = await run(call("read", { path: path.join(h.home, "pine.json") }));
	assert.match(out[0], /not accessible to agents/);
	// And a run that an event from outside started cannot be given more: no question.
	out = await runner(h, "inbox", "untrusted")(call("read", { path: put("other/x.txt", "X") }));
	assert.match(out[0], /outside the paths this agent may read/);
	assert.equal(asked.length, 3);
	await h.close();
});

test("access: a shell command that names a path outside is asked about before it runs, and ~ is told apart from the owner's home", sandbox, async () => {
	const bill = put("inbox/bill.txt", "BILL-77\n");
	put("scans/one.pdf", "%PDF one");
	const h = await harness(spec());
	const asked = answering(h, (r) => !/vault/.test(r.summary));
	const run = runner(h);

	let out = await run(call("bash", { command: `cat ${bill} 2>/dev/null` }));
	assert.equal(out[0].trim(), "BILL-77", "the command ran with the access, in the same call");
	assert.equal(asked[0].summary, `read ${bill}\nfor: bash: cat ${bill} 2>/dev/null`);

	// What it writes is asked for as writing: the target of a redirect.
	const log = path.join(HOME, "inbox", "paid.log");
	out = await run(call("bash", { command: `echo paid > ${log} && cat ${log}` }));
	assert.equal(out[0].trim(), "paid");
	assert.match(asked[1].summary, /^write /);

	// "~" in the agent's shell is its own home. The owner's folder was meant: asked for, and the agent is told how to name it.
	out = await run(call("bash", { command: "ls ~/scans/*.pdf" }));
	assert.match(out[0], /Not run\. In your shell, ~ and \$HOME are your own private home \(.*sandbox\/banks\), not your owner's \(.*\), and what the command names is in your owner's\. You may use it: your owner has just allowed it\. Run the command again with the full path: .*\/scans$/);
	assert.equal(asked[2].summary, `read ${path.join(HOME, "scans")}\nfor: bash: ls ~/scans/*.pdf`);
	out = await run(call("bash", { command: `ls ${HOME}/scans/*.pdf` }));
	assert.match(out[0], /one\.pdf/);
	assert.equal(asked.length, 3);
	// Its own home is its own: a file it made there is found with ~, and nobody is asked.
	out = await run(call("bash", { command: "mkdir -p ~/scans && echo mine > ~/scans/own.txt && cat ~/scans/own.txt" }));
	assert.equal(out[0].trim(), "mine");
	assert.equal(asked.length, 3);

	// A no: the command does not run.
	put("vault/key.txt", "KEY");
	out = await run(call("bash", { command: `cat ${HOME}/vault/key.txt; echo ran` }));
	assert.match(out[0], /Not run: the command reaches outside your sandbox\. Your owner said no to this in this conversation: read .*vault\/key\.txt/);
	assert.ok(!out[0].includes("ran"));

	// The agent is told both things before it tries.
	const note = notesOf(h.mock.state.requests.at(-1)).at(-1)!;
	assert.match(note, /You work freely inside your workspace\. When a command or a file tool needs a file or folder of your owner's outside it, pine asks your owner and tells you the answer\./);
	assert.match(note, /In your shell, ~ and \$HOME are a private home of your own \(.*sandbox\/banks\), not your owner's home/);
	await h.close();
});

// A stand-in for the system's log: the test says what "the system reports" for the next command.
const READER = `const fs=require("fs");const f=process.argv[1];let at=0;setInterval(()=>{let s;try{s=fs.readFileSync(f)}catch{return}if(s.length>at){process.stdout.write(s.subarray(at));at=s.length}},15);`;
const MARKER = `const fs=require("fs");const [f,pending,tag,about]=process.argv.slice(1);let out="";if(about){let p="";try{p=fs.readFileSync(pending,"utf8");fs.writeFileSync(pending,"")}catch{}for(const l of p.split("\\n").filter(Boolean))out+=JSON.stringify({eventMessage:"Sandbox: prog(7) deny(1) "+l+"\\n"+about})+"\\n"}out+=JSON.stringify({eventMessage:"Sandbox: cat(8) deny(1) file-read-data /private/etc/hosts\\n"+tag})+"\\n";fs.appendFileSync(f,out);`;
const quiet = { info() {}, warn() {}, error() {}, debug() {}, child: () => ({}) } as any;
function standInTools(dir: string, reads = true) {
	const file = path.join(dir, "reports.ndjson");
	const pending = path.join(dir, "pending.txt");
	fs.writeFileSync(file, "");
	const tools: DenialTools = {
		stream: () => (reads ? [process.execPath, "-e", READER, file] : undefined),
		mark: (tag, about) => [process.execPath, "-e", MARKER, file, pending, tag, about],
	};
	return { tools, reports: (...lines: string[]) => fs.writeFileSync(pending, `${lines.join("\n")}\n`) };
}
function standIn(h: Awaited<ReturnType<typeof harness>>, reads = true) {
	const { tools, reports } = standInTools(h.home, reads);
	h.pine.agents.denials.stop();
	h.pine.agents.denials = new Denials(quiet, tools);
	return { reports };
}

test("access: the log is read while commands run and a little longer, and again for the next one", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-denials-"));
	const { tools, reports } = standInTools(dir);
	const d = new Denials(quiet, tools, 60);
	t.after(() => (d.stop(), fs.rmSync(dir, { recursive: true, force: true })));
	const state = () => (d as any).state;
	assert.equal(state(), "idle", "nothing runs before the first command");
	assert.equal(await d.ready(), true);
	const a = d.tag();
	const b = d.tag();
	reports("file-read-data /Users/o/a", "mach-lookup com.apple.x");
	assert.deepEqual(await d.collect(a), [{ process: "prog", op: "file-read-data", target: "/Users/o/a" }, { process: "prog", op: "mach-lookup", target: "com.apple.x" }]);
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(state(), "ready", "a command is still running: the reader stays");
	assert.deepEqual(await d.collect(b), [], "and what one command was refused is not another's");
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(state(), "idle", "nothing runs: the reader is gone");
	assert.equal(await d.ready(), true, "the next command starts it again");
	const c = d.tag();
	reports("network-outbound remote:1.2.3.4:443");
	assert.deepEqual(await d.collect(c), [{ process: "prog", op: "network-outbound", target: "remote:1.2.3.4:443" }]);
	// Where there is nothing to read the system's reports with, it says so and costs nothing.
	const none = new Denials(quiet, { stream: () => undefined, mark: () => undefined });
	assert.equal(await none.ready(), false);
	assert.deepEqual(await none.collect(none.tag()), []);
});

test("access: what the sandbox refused a command that named nothing is put to the owner after it, and said at the end of its answer", sandbox, async () => {
	const ledger = put("ledger/2026.csv", "LEDGER-ROW\n");
	const h = await harness(spec());
	const system = standIn(h);
	const asked = answering(h, (r) => !/network/.test(r.summary));
	const run = runner(h);
	// The path is put together at run time: nothing in the text names it.
	const hidden = `P=${HOME}/ledger; cat "$P/2026.csv"`;

	system.reports(`file-read-data ${ledger}`);
	let out = await run(call("bash", { command: hidden }));
	assert.match(out[0], /Command exited with code 1/);
	assert.ok(out[0].endsWith(`[pine: your sandbox stopped part of this command (files outside what you may reach). Your owner has now allowed this conversation to read ${ledger}. Run the command again.]`), out[0]);
	assert.equal(asked.length, 1);
	assert.equal(asked[0].tool, "request_access");
	assert.equal(asked[0].summary, `read ${ledger}\nfor: bash: ${hidden}`);
	assert.match(asked[0].why, /a command of banks tried this, and its sandbox stopped it\. A yes holds for this conversation, until it is reset; the agent is told to run the command again/);
	out = await run(call("bash", { command: hidden }));
	assert.equal(out[0].trim(), "LEDGER-ROW", "and then it works, with nothing added");

	// The network: asked when the command failed for want of it. A no is kept.
	system.reports("network-outbound /private/var/run/mDNSResponder");
	out = await run(call("bash", { command: 'echo "curl: (6) Could not resolve host: example.com"; exit 6' }));
	assert.match(out[0], /\[pine: your sandbox stopped part of this command \(the network\)\. Your owner said no to this in this conversation: use the network\. Do not retry/);
	assert.equal(asked.at(-1).summary.split("\n")[0], "use the network");
	system.reports("network-outbound remote:93.184.216.34:443");
	out = await run(call("bash", { command: "echo failed to fetch; exit 1" }));
	assert.match(out[0], /Your owner said no to this in this conversation: use the network/);
	assert.equal(asked.length, 2, "not asked again");
	// A program that looked for the network and went on without it: nobody is bothered.
	system.reports("network-outbound /private/var/run/mDNSResponder");
	out = await run(call("bash", { command: "echo made" }));
	assert.equal(out[0].trim(), "made");

	// pine's own files: no question, because no answer opens them, and the agent is told so.
	system.reports(`file-read-data ${path.join(h.home, "pine.json")}`);
	out = await run(call("bash", { command: "false" }));
	assert.match(out[0], /pine\.json: part of pine itself, which is closed to every agent in every mode\. Do not look for another way/);
	// What a program looks for on its own account, and what a command that ended well was refused: nothing is said.
	system.reports(`file-read-data ${HOME}/.config/tool.toml`, `file-read-data ${HOME}/Library/Preferences/x.plist`, "mach-lookup com.apple.diagnosticd");
	out = await run(call("bash", { command: "false" }));
	assert.ok(!out[0].includes("[pine:"), out[0]);
	system.reports(`file-read-data ${HOME}/elsewhere/x`);
	out = await run(call("bash", { command: "echo fine" }));
	assert.equal(out[0].trim(), "fine");
	// A cache it could not write, and a service of the system it did not get: said, not asked.
	system.reports("file-write-create /private/var/folders/zz/C/clang/ModuleCache/A/x.pcm");
	out = await run(call("bash", { command: "echo 'error: unable to open output file'; exit 1" }));
	assert.match(out[0], /Not writable for the command: \/private\/var\/folders\/zz\/C\/clang\/ModuleCache\/A\/x\.pcm\. A program that wants a folder for its cache or settings can be given one/);
	system.reports("mach-lookup com.apple.windowserver.active");
	out = await run(call("bash", { command: "false" }));
	assert.match(out[0], /asked for system services it does not get in your sandbox \(com\.apple\.windowserver\.active\)/);
	assert.equal(asked.length, 2);
	await h.close();
});

test("access: where the system reports nothing, a failed command's own words are what pine goes by", sandbox, async () => {
	const taxes = put("taxes/2025.txt", "TAX\n");
	const h = await harness(spec());
	standIn(h, false);
	const asked = answering(h, () => true);
	const run = runner(h);
	let out = await run(call("bash", { command: `P=${HOME}/taxes; echo "cat: $P/2025.txt: Permission denied"; exit 1` }));
	assert.equal(asked[0].summary.split("\n")[0], `read ${taxes}`);
	assert.match(out[0], /Your owner has now allowed this conversation to read .*2025\.txt\. Run the command again\.\]$/);
	out = await run(call("bash", { command: `P=${HOME}/taxes; cat "$P/2025.txt"` }));
	assert.equal(out[0].trim(), "TAX");
	out = await run(call("bash", { command: `echo "fatal: unable to access 'https://x.example/': Could not resolve host: x.example"; exit 128` }));
	assert.equal(asked[1].summary.split("\n")[0], "use the network");
	assert.match(out[0], /Your owner has now allowed this conversation to use the network\. Run the command again/);
	// A command that fails for a reason of its own is left alone.
	out = await run(call("bash", { command: "grep -c nothing-like-this /etc/hosts" }));
	assert.ok(!out[0].includes("[pine:"));
	assert.equal(asked.length, 2);
	await h.close();
});

test("access: on macOS the system's own log says what a command was refused", { skip: process.platform !== "darwin" || !sandboxAvailable() }, async (t) => {
	put("real/a.txt", "REAL\n");
	const h = await harness(spec());
	t.after(() => h.close());
	if (!(await h.pine.agents.denials.ready())) return t.skip("the system's log cannot be read by this account");
	const asked = answering(h, () => true);
	const run = runner(h);
	const hidden = `P=${HOME}/real; ls "$P"`;
	let out = await run(call("bash", { command: hidden }));
	assert.match(out[0], /Operation not permitted/);
	assert.equal(asked[0]?.summary, `read ${path.join(HOME, "real")}\nfor: bash: ${hidden}`);
	assert.match(out[0], /Your owner has now allowed this conversation to read .*\/real\. Run the command again\.\]$/);
	out = await run(call("bash", { command: hidden }));
	assert.equal(out[0].trim(), "a.txt");
	// A command that is refused nothing is told nothing, and costs no question.
	out = await run(call("bash", { command: "echo plain" }));
	assert.equal(out[0].trim(), "plain");
	assert.equal(asked.length, 1);
});

test("access: the sandbox of an agent that works in its own folders points programs at its own home, and its refusals carry the command's text", { skip: process.platform !== "darwin" || !sandboxAvailable() }, async () => {
	const h = await harness(spec());
	answering(h, () => true);
	const out = await runner(h)(call("bash", { command: 'echo "$CFFIXED_USER_HOME|$CLANG_MODULE_CACHE_PATH|$HOME"' }));
	const [fixed, cache, home] = out[0].trim().split("|");
	assert.equal(fixed, home);
	assert.equal(cache, path.join(home, ".cache", "clang", "ModuleCache"));
	const agent = h.pine.cfg.agents.banks;
	const roots = rootsFor(h.pine.cfg, agent);
	const plain = sandboxProfile(h.pine.cfg, agent, roots, "normal");
	const tagged = sandboxProfile(h.pine.cfg, agent, roots, "normal", false, "pine-x:c:1");
	assert.ok(!plain.includes("with message"));
	assert.ok(tagged.includes('(deny default (with message "pine-x:c:1"))'));
	// The text is all that differs: what is allowed and refused is the same.
	assert.equal(tagged.replaceAll(' (with message "pine-x:c:1")', ""), plain);
	assert.equal(sandboxProfile(h.pine.cfg, agent, roots, "restricted", false, "t").replaceAll(' (with message "t")', ""), sandboxProfile(h.pine.cfg, agent, roots, "restricted"));
	await h.close();
});

test("access: download says what to do with a file that is on this computer", async () => {
	const h = await harness(spec());
	answering(h, () => true);
	const out = await runner(h)(call("download", { url: "file:///Users/o/scans/a.pdf", path: "a.pdf" }));
	assert.match(out[0], /download fetches web addresses \(https\)\. A file on this computer is read with the read tool or copied with the shell, by its path\./);
	await h.close();
});
