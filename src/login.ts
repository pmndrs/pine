import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PineConfig } from "./config.ts";
import { modelRuntime } from "./models.ts";
import { openInSystem } from "./util.ts";

/** Providers whose usual way in is a browser sign-in with a subscription. */
const OAUTH_FIRST = ["anthropic", "openai-codex", "github-copilot"];

export interface Prompter {
	text(message: string): Promise<string>;
	secret(message: string): Promise<string>;
	say(line: string): void;
	open(url: string): void;
}

/**
 * Read one line without showing it. The prompt stays on screen and says that the input is hidden,
 * so a silent cursor is not mistaken for a hang. Works for typing and for pasting.
 */
export function readSecret(message: string, input: NodeJS.ReadableStream & { setRawMode?(on: boolean): unknown; isTTY?: boolean } = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<string> {
	return new Promise((resolve, reject) => {
		output.write(`${message} (input is hidden; paste or type it, then press enter): `);
		let value = "";
		const raw = Boolean(input.isTTY && input.setRawMode);
		if (raw) input.setRawMode!(true);
		input.resume();
		const finish = (err?: Error) => {
			input.off("data", onData);
			if (raw) input.setRawMode!(false);
			input.pause();
			output.write("\n");
			if (err) reject(err);
			else resolve(value.trim());
		};
		const onData = (chunk: Buffer | string) => {
			for (const ch of chunk.toString("utf8")) {
				if (ch === "\r" || ch === "\n") return finish();
				if (ch === "\x03") return finish(new Error("cancelled"));
				if (ch === "\x7f" || ch === "\b") value = value.slice(0, -1);
				else if (ch >= " ") value += ch;
			}
		};
		input.on("data", onData);
	});
}

const terminalPrompter = (): Prompter & { close(): void } => {
	// A readline interface per question: one that stays open would redraw the line and wipe a prompt
	// printed outside it, and would fight the raw-mode reader over the keyboard.
	const ask = (q: string) =>
		new Promise<string>((resolve) => {
			const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
			rl.question(q, (answer) => {
				rl.close();
				resolve(answer);
			});
		});
	return {
		text: (m) => ask(`${m} `),
		secret: (m) => readSecret(m),
		say: (line) => console.log(line),
		open: openInSystem,
		close: () => process.stdin.pause(),
	};
};

async function runtime(cfg: PineConfig): Promise<ModelRuntime> {
	process.env.PI_CODING_AGENT_DIR = path.join(cfg.dataDir, "pi");
	process.env.PI_SKIP_VERSION_CHECK = "1";
	process.env.PI_TELEMETRY = "0";
	fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	return modelRuntime(cfg.home);
}

/** Every provider pi knows here: its own and the ones of models.json. */
export async function knownProviders(cfg: PineConfig): Promise<string[]> {
	return (await runtime(cfg)).getProviders().map((p: any) => p.id);
}

/**
 * Sign in to a model provider with pi's own login flow and store the credential in
 * <home>/auth.json (mode 600). Agents cannot read that file.
 */
export async function login(cfg: PineConfig, provider: string, type?: "api_key" | "oauth", prompter?: Prompter): Promise<string[]> {
	const rt = await runtime(cfg);
	if (!rt.getProvider(provider)) throw new Error(`unknown provider "${provider}". Known: ${rt.getProviders().map((p: any) => p.id).sort().join(", ")}`);
	const own = prompter ? undefined : terminalPrompter();
	const p = prompter ?? own!;
	try {
		const kind = type ?? (OAUTH_FIRST.includes(provider) ? "oauth" : "api_key");
		await rt.login(provider, kind, {
			prompt: async (q: any) => {
				if (q.type === "secret") return p.secret(q.message);
				if (q.type === "select") {
					q.options.forEach((o: any, i: number) => p.say(`  ${i + 1}) ${o.label}${o.description ? ` - ${o.description}` : ""}`));
					const n = Number(await p.text(`${q.message} [1-${q.options.length}]`));
					return q.options[Math.max(1, Math.min(q.options.length, n || 1)) - 1].id;
				}
				return p.text(q.message);
			},
			notify: (e: any) => {
				if (e.type === "auth_url") {
					p.say(`Open this page to sign in:\n\n  ${e.url}\n${e.instructions ? `\n${e.instructions}\n` : ""}`);
					p.open(e.url);
				} else if (e.type === "device_code") {
					p.say(`Go to ${e.verificationUri} and enter the code ${e.userCode}`);
					p.open(e.verificationUri);
				} else if (e.message) p.say(e.message);
			},
		});
		await (rt as any).settleCredentialWrites?.();
	} finally {
		own?.close();
	}
	const authFile = path.join(cfg.home, "auth.json");
	if (fs.existsSync(authFile)) fs.chmodSync(authFile, 0o600);
	const models = [...(await rt.getAvailable())].filter((m: any) => m.provider === provider).map((m: any) => `${provider}/${m.id}`);
	// A pasted key is stored as it is; only the first request shows whether the provider accepts it.
	const head = (type ?? (OAUTH_FIRST.includes(provider) ? "oauth" : "api_key")) === "oauth" ? `Signed in to ${provider}.` : `Stored the key for ${provider} (it is checked when the first message is sent).`;
	p.say(`${head} ${models.length} models are available, for example:\n${models.slice(0, 8).map((m) => `  ${m}`).join("\n")}\n\nUse one with "defaults": { "model": "<provider/id>" } in pine.json, or /model in the terminal UI.`);
	return models;
}

export async function logout(cfg: PineConfig, provider: string): Promise<void> {
	const rt = await runtime(cfg);
	await rt.logout(provider);
	await (rt as any).settleCredentialWrites?.();
	console.log(`Removed the stored credential for ${provider}.`);
}
