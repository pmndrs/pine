import fs from "node:fs";
import path from "node:path";
import { type AgentConfig, loadConfig, type PineConfig } from "./config.ts";
import { errText } from "./util.ts";

/** The built-in tools an agent can be given. */
export const AGENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export interface NewAgent {
	id: string;
	/** One line: what it is for. Other agents see it when they decide whom to hand work to. */
	description: string;
	/** Who it is and how it works: its AGENTS.md. */
	instructions: string;
	model?: string;
	tools?: string[];
}

/**
 * Create an agent while the daemon runs: its folder with agent.json, its instructions and an empty
 * workspace. The files are written first and then read back through the normal loader, so a new
 * agent is checked exactly like one that was there at start; if it does not pass, the folder is
 * taken away again. Nothing but these few lines goes into its agent.json.
 */
/** What is wrong with a proposed agent, as an error; nothing is written. Returns the cleaned-up values. */
export function checkNewAgent(cfg: PineConfig, spec: NewAgent): { description: string; tools: string[] } {
	if (!/^[a-z][a-z0-9_-]{1,30}$/.test(spec.id)) throw new Error(`"${spec.id}" is not a usable agent id: lowercase letters, digits, - and _, starting with a letter, at least two characters`);
	if (cfg.agents[spec.id]) throw new Error(`an agent called ${spec.id} exists already`);
	const description = spec.description.replace(/\s+/g, " ").trim();
	if (!description) throw new Error("an agent needs a description: one line on what it is for");
	if (!spec.instructions.trim()) throw new Error("an agent needs instructions: who it is and how it works");
	const tools = spec.tools ?? AGENT_TOOLS;
	const unknown = tools.filter((t) => !AGENT_TOOLS.includes(t));
	if (unknown.length) throw new Error(`unknown tool${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}. An agent can have: ${AGENT_TOOLS.join(", ")}`);
	if (fs.existsSync(path.join(cfg.home, "agents", spec.id))) throw new Error(`the folder agents/${spec.id} exists already`);
	return { description, tools };
}

export function createAgent(cfg: PineConfig, spec: NewAgent): AgentConfig {
	const { description, tools } = checkNewAgent(cfg, spec);
	const dir = path.join(cfg.home, "agents", spec.id);
	fs.mkdirSync(path.join(dir, "workspace"), { recursive: true, mode: 0o700 });
	try {
		fs.writeFileSync(path.join(dir, "agent.json"), `${JSON.stringify({ description, ...(spec.model ? { model: spec.model } : {}), tools }, null, 2)}\n`, { mode: 0o600 });
		fs.writeFileSync(path.join(dir, "AGENTS.md"), `${spec.instructions.trim()}\n`, { mode: 0o600 });
		const made = loadConfig(cfg.home).agents[spec.id];
		if (!made) throw new Error("the new agent was not found after writing it");
		cfg.agents[spec.id] = made;
		return made;
	} catch (e) {
		fs.rmSync(dir, { recursive: true, force: true });
		throw new Error(`the agent could not be created: ${errText(e)}`);
	}
}
