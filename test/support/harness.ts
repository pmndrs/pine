import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
// The scripted model server of the baseline suite: replies follow directives embedded in the prompt.
import { mockMsg, startMock, textOf as rawTextOf } from "../../baseline/tests/mock.mjs";
import { type Pine, startPine } from "../../src/pine.ts";
import { createLogger } from "../../src/util.ts";

/** The notes pine puts in front of a message when the mode, the state or the day has changed. */
const NOTE = /<pine-note>[\s\S]*?<\/pine-note>\s*/g;

/** Message text as the author wrote it, without pine's notes. */
/**
 * How a refusal by the sandbox reads in a shell. macOS says no. On Linux what is closed is not
 * there, and what may not be written lies on a read-only mount.
 */
export const refused = /Operation not permitted|No such file or directory|Read-only file system|Permission denied|Device or resource busy/;
/** The same from a file tool. */
export const toolRefused = /ERROR: .*(not permitted|no such file or directory)/i;

export const textOf = (content: unknown): string => rawTextOf(content).replace(NOTE, "");
/** All notes pine has sent in the conversation of a request, oldest first. */
export const notesOf = (req: any): string[] => (req.body.messages ?? []).filter((m: any) => m.role === "user").flatMap((m: any) => rawTextOf(m.content).match(NOTE) ?? []);
export { mockMsg, rawTextOf };
export const MCP_STUB = path.resolve(import.meta.dirname, "../../baseline/tests/mcp-stdio-server.mjs");

export interface AgentSpec {
	agent?: Record<string, unknown>;
	/** <home>/agents/<id>/AGENTS.md */
	persona?: string;
	/** Files written into the workspace. */
	files?: Record<string, string>;
	/** Files written into the agent dir (skills, extensions). */
	dirFiles?: Record<string, string>;
}

export interface Harness {
	home: string;
	mock: any;
	pine: Pine;
	logs: string[];
	workspace(agent: string): string;
	/** Model requests whose system prompt contains `marker`. */
	requestsFor(marker: string): any[];
	toolResults(req?: any): string[];
	toolsOffered(req: any): string[];
	system(req: any): string;
	restart(): Promise<Pine>;
	close(): Promise<void>;
}

// A failed assertion skips the test's own close(); without this the daemon would keep the process alive.
const open = new Set<Harness>();
after(async () => {
	for (const h of [...open]) await h.close().catch(() => {});
});

const write = (file: string, content: string) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
};

export async function harness(spec: { pine?: Record<string, unknown>; agents: Record<string, AgentSpec>; files?: Record<string, string>; model?: Record<string, unknown>; mock?: any; mockOptions?: Record<string, unknown>; start?: boolean }): Promise<Harness> {
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pine-test-")));
	const mock = spec.mock ?? (await startMock({ strip: NOTE, ...(spec.mockOptions ?? {}) }));
	write(
		path.join(home, "models.json"),
		JSON.stringify({ providers: { mock: { name: "Mock", baseUrl: mock.baseUrl, api: "openai-completions", apiKey: mock.apiKey ?? "sk-mock", models: [{ id: "m", name: "Mock", contextWindow: 128000, maxTokens: 4096, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...(spec.model ?? {}) }] } } }),
	);
	// Tests script the model, and a scripted command must not reach the account of whoever runs
	// them: every agent stays in its workspace unless a test asks for the account by name.
	const defaults = { model: "mock/m", scope: "workspace", ...((spec.pine?.defaults as Record<string, unknown> | undefined) ?? {}) };
	// The same goes for what happens after outside content: the tests that are about the one
	// question say so here, and the tests about the reviewer ask for it and script its answers.
	const security = { review: "ask", ...((spec.pine?.security as Record<string, unknown> | undefined) ?? {}) };
	write(path.join(home, "pine.json"), JSON.stringify({ http: false, logLevel: "debug", ...(spec.pine ?? {}), defaults, security }, null, 2));
	for (const [rel, content] of Object.entries(spec.files ?? {})) write(path.join(home, rel), content);
	for (const [id, a] of Object.entries(spec.agents)) {
		const dir = path.join(home, "agents", id);
		write(path.join(dir, "agent.json"), JSON.stringify(a.agent ?? {}, null, 2));
		write(path.join(dir, "AGENTS.md"), a.persona ?? `PERSONA-${id.toUpperCase()}\n`);
		const ws = typeof a.agent?.workspace === "string" ? path.resolve(dir, a.agent.workspace as string) : path.join(dir, "workspace");
		fs.mkdirSync(ws, { recursive: true });
		for (const [rel, content] of Object.entries(a.files ?? {})) write(path.join(ws, rel), content);
		for (const [rel, content] of Object.entries(a.dirFiles ?? {})) write(path.join(dir, rel), content);
	}
	const logs: string[] = [];
	const log = createLogger("debug", "pine", (l) => {
		logs.push(l);
		if (process.env.PINE_TEST_LOG) process.stderr.write(`${l}\n`);
	});
	const h: Harness = {
		home,
		mock,
		logs,
		pine: undefined as any,
		workspace: (agent) => h.pine.cfg.agents[agent].workspace,
		requestsFor: (marker) => mock.state.requests.filter((r: any) => h.system(r).includes(marker)),
		toolResults: (req = mock.state.requests.at(-1)) => req.body.messages.filter((m: any) => m.role === "tool").map((m: any) => textOf(m.content)),
		toolsOffered: (req) => (req.body.tools ?? []).map((t: any) => t.function?.name ?? t.name),
		system: (req) => {
			const m = (req.body.messages ?? []).find((x: any) => x.role === "system" || x.role === "developer");
			return m ? rawTextOf(m.content) : "";
		},
		restart: async () => {
			await h.pine?.stop();
			h.pine = await startPine({ home, log });
			return h.pine;
		},
		close: async () => {
			open.delete(h);
			await h.pine?.stop();
			if (!spec.mock) await mock.close();
			fs.rmSync(home, { recursive: true, force: true });
		},
	};
	open.add(h);
	if (spec.start !== false) h.pine = await startPine({ home, log });
	return h;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function until(fn: () => unknown, ms = 5000, what = "condition"): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return;
		await sleep(25);
	}
	throw new Error(`timed out waiting for ${what}`);
}
