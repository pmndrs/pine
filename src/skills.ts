import fs from "node:fs";
import path from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, agentSkillsDir, conversationsDir, globalSkillsDir, type PineConfig } from "./config.ts";
import { isInside, realish } from "./security.ts";
import { safeName } from "./util.ts";

/**
 * Skills: what an agent knows how to do, written down. A skill is a folder with a SKILL.md (a
 * name, a line on when to use it, and the instructions) and whatever files those instructions
 * refer to. The agent sees name and line in its prompt and reads the rest when a task calls for it.
 *
 * Like event sources and MCP servers, a skill is for one conversation, for one agent or for all
 * agents. Unlike them it needs no entry in a configuration file: where the folder lies says whom
 * it is for.
 *
 *   <home>/skills/<name>/                                 all agents
 *   <home>/agents/<id>/skills/<name>/                     that agent, in all its conversations
 *   <home>/agents/<id>/conversations/<session>/skills/<name>/   that one conversation
 *
 * All three lie in pine's home, where an agent can read its own but write nothing: a skill is
 * part of an agent's instructions, and is written by pine when a tool asks for it.
 */
export type SkillScope = "local" | "agent" | "global";

export interface SkillInfo {
	name: string;
	description: string;
	scope: SkillScope;
	dir: string;
	/** Put there by pine's tools, so the tools may also replace and remove it. The owner's own folders (`skills` in a configuration file) are not. */
	managed: boolean;
}

const MAX_TEXT = 40_000;
const MAX_FILES = 200;
const MAX_BYTES = 4 * 1024 * 1024;

export const localSkillsDir = (agent: AgentConfig, session: string) => path.join(conversationsDir(agent), safeName(session), "skills");

/** The folders an agent's session reads skills from, beyond what its configuration names. */
export function skillDirs(cfg: PineConfig, agent: AgentConfig, session: string): string[] {
	return [globalSkillsDir(cfg), ...(session === "main" ? [] : [localSkillsDir(agent, session)])].filter((d) => fs.existsSync(d));
}

const read = (dir: string, scope: SkillScope, managed: boolean): SkillInfo[] =>
	fs.existsSync(dir) ? loadSkillsFromDir({ dir, source: scope }).skills.map((s) => ({ name: s.name, description: s.description, scope, dir: s.baseDir, managed })) : [];

/** The skills one conversation of an agent has, the nearest first: its own, the agent's, those for all agents. */
export function listSkills(cfg: PineConfig, agent: AgentConfig, session: string): SkillInfo[] {
	const out = [
		...(session === "main" ? [] : read(localSkillsDir(agent, session), "local", true)),
		...read(agentSkillsDir(agent), "agent", true),
		...agent.skills.flatMap((d) => read(d, "agent", false)),
		...read(globalSkillsDir(cfg), "global", true),
		...cfg.skills.filter((d) => realish(d) !== realish(globalSkillsDir(cfg))).flatMap((d) => read(d, "global", false)),
	];
	return out.filter((s, i) => out.findIndex((x) => x.name === s.name) === i);
}

/**
 * Every skill that one of a scope would stand beside: for a conversation what it sees, for an
 * agent also what its other conversations have, for all agents everything there is. A name is
 * used once among those, so that no conversation ever has two skills of one name.
 */
export function skillsBeside(cfg: PineConfig, agent: AgentConfig, scope: SkillScope, session: string): SkillInfo[] {
	const locals = (a: AgentConfig) => (fs.existsSync(conversationsDir(a)) ? fs.readdirSync(conversationsDir(a)).flatMap((s) => read(path.join(conversationsDir(a), s, "skills"), "local", true)) : []);
	if (scope === "local") return listSkills(cfg, agent, session);
	if (scope === "agent") return [...locals(agent), ...listSkills(cfg, agent, "main")];
	return Object.values(cfg.agents).flatMap((a) => [...locals(a), ...listSkills(cfg, a, "main")]);
}

/** Every skill there is, with whom it is for: for whoever looks at the whole setup. */
export function allSkills(cfg: PineConfig): Array<SkillInfo & { agent?: string; session?: string }> {
	const global = [...read(globalSkillsDir(cfg), "global", true), ...cfg.skills.filter((d) => realish(d) !== realish(globalSkillsDir(cfg))).flatMap((d) => read(d, "global", false))];
	const perAgent = Object.values(cfg.agents).flatMap((a) => [
		...[...read(agentSkillsDir(a), "agent", true), ...a.skills.flatMap((d) => read(d, "agent", false))].map((s) => ({ ...s, agent: a.id })),
		...(fs.existsSync(conversationsDir(a)) ? fs.readdirSync(conversationsDir(a)) : []).flatMap((session) => read(path.join(conversationsDir(a), session, "skills"), "local", true).map((s) => ({ ...s, agent: a.id, session }))),
	]);
	return [...global, ...perAgent];
}

export interface SkillSpec {
	name: string;
	description: string;
	instructions: string;
	/** A folder whose files go along with the skill: scripts, references, templates. */
	files?: string;
}

/** Check what a skill is to be before anybody is asked anything. Returns it tidied, with the files that would be copied. */
export function checkSkill(spec: SkillSpec, workspace: string): SkillSpec & { copy: Array<{ from: string; to: string }> } {
	const name = String(spec.name ?? "").trim();
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error(`"${name}" is not a usable skill name: lowercase letters, digits and single hyphens, at most 64 characters (for example invoices, solar-yield)`);
	if (name === "pine") throw new Error('"pine" is the name of pine\'s own manual');
	const description = String(spec.description ?? "").replace(/\s+/g, " ").trim();
	if (!description) throw new Error(`a skill needs a "description": one or two sentences on what it is for and when to use it. You decide by that line alone whether to read the skill`);
	if (description.length > 1024) throw new Error(`the description is too long (${description.length} characters, at most 1024). It says when to use the skill; how to do it goes into "instructions"`);
	const instructions = String(spec.instructions ?? "").trim();
	if (!instructions) throw new Error(`a skill needs "instructions": what to do, step by step, written to yourself`);
	if (instructions.length > MAX_TEXT) throw new Error(`the instructions are too long (${instructions.length} characters, at most ${MAX_TEXT}). Put long material into files next to the skill ("files") and refer to them`);
	const copy: Array<{ from: string; to: string }> = [];
	if (spec.files) {
		const root = realish(path.resolve(workspace, spec.files));
		if (!isInside(realish(workspace), root) || root === realish(workspace)) throw new Error(`"files" must be a folder inside your workspace`);
		if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`${root} is not a folder that exists`);
		let bytes = 0;
		const walk = (dir: string) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const from = path.join(dir, entry.name);
				// Only what is really there: a link could point at anything.
				if (entry.isSymbolicLink()) throw new Error(`${from} is a link; a skill carries files, not links`);
				if (entry.isDirectory()) {
					if (entry.name === ".git" || entry.name === "node_modules") continue;
					walk(from);
				} else if (entry.isFile()) {
					const to = path.relative(root, from);
					if (to === "SKILL.md") continue;
					bytes += fs.statSync(from).size;
					copy.push({ from, to });
					if (copy.length > MAX_FILES || bytes > MAX_BYTES) throw new Error(`${root} is too much for a skill (at most ${MAX_FILES} files and ${MAX_BYTES / 1024 / 1024} MB)`);
				}
			}
		};
		walk(root);
	}
	return { name, description, instructions, copy };
}

/** Where a skill of a scope lies. */
export function skillDir(cfg: PineConfig, agent: AgentConfig, scope: SkillScope, session: string, name: string): string {
	return path.join(scope === "global" ? globalSkillsDir(cfg) : scope === "agent" ? agentSkillsDir(agent) : localSkillsDir(agent, session), name);
}

/** Write a skill, in place of one of the same name in the same place. */
export function writeSkill(dir: string, skill: ReturnType<typeof checkSkill>): void {
	// Built beside it and swapped in, so that a half-written skill is never read.
	const fresh = `${dir}.new-${process.pid}`;
	fs.rmSync(fresh, { recursive: true, force: true });
	fs.mkdirSync(fresh, { recursive: true, mode: 0o700 });
	for (const f of skill.copy) {
		fs.mkdirSync(path.dirname(path.join(fresh, f.to)), { recursive: true });
		fs.copyFileSync(f.from, path.join(fresh, f.to));
	}
	// The description as a quoted string, which is the same in JSON and in YAML: a colon in it cannot break the header.
	fs.writeFileSync(path.join(fresh, "SKILL.md"), `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions}\n`);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.renameSync(fresh, dir);
}

/** Delete a skill's folder, and the folders above it that it leaves empty, up to the agent's or pine's own. */
export function deleteSkill(dir: string, stop: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
	for (let up = path.dirname(dir); isInside(stop, up) && up !== stop; up = path.dirname(up)) {
		if (!fs.existsSync(up) || fs.readdirSync(up).length) break;
		fs.rmdirSync(up);
	}
}

/** A conversation is removed: the skills that were its own go with it. */
export function dropConversationSkills(agent: AgentConfig, session: string): string[] {
	const dir = localSkillsDir(agent, session);
	const names = read(dir, "local", true).map((s) => s.name);
	fs.rmSync(path.dirname(dir), { recursive: true, force: true });
	if (fs.existsSync(conversationsDir(agent)) && !fs.readdirSync(conversationsDir(agent)).length) fs.rmdirSync(conversationsDir(agent));
	return names;
}

/** A conversation got another name: its skills follow it. */
export function renameConversationSkills(agent: AgentConfig, from: string, to: string): void {
	const a = path.dirname(localSkillsDir(agent, from));
	const b = path.dirname(localSkillsDir(agent, to));
	if (!fs.existsSync(a)) return;
	fs.rmSync(b, { recursive: true, force: true });
	fs.renameSync(a, b);
}
