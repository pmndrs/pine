import type { TSchema } from "typebox";

// A source type is a module: its default export starts a source, and its `type` export says what
// such a source is and which options it takes. That description is all an agent's add_source tool
// knows about the type: it offers the type with these options, checks what it is given against the
// schema, and lets the type say what the set-up would do. pine's own types (folder, timer, mqtt,
// webhook, ftp) and the ones you register under "sourceTypes" in pine.json are described the same way.

/** What setting a source up would mean, worked out before anything is written. */
export interface SourcePlan {
	/** The options as they go into the configuration: paths resolved, defaults that matter filled in, secrets made. */
	options: Record<string, unknown>;
	/** What it will do, in plain words, for the owner's dialog. */
	does: string[];
	/** It reaches something new (a folder elsewhere, a network connection, a port), so the owner is asked first. */
	opens: boolean;
	/** A folder the agent gets read access to along with the source. */
	read?: string;
	/** What the agent should pass on once it is set up (where a device finds its password, for example). */
	tell?: string;
	/**
	 * What it reports is the owner speaking, not outside content: the source itself makes sure of
	 * who is on the other end (a Telegram account the owner paired, for example). The owner is told
	 * so before they confirm.
	 */
	owner?: boolean;
}

export interface SourceSetup {
	/** The name the source will have. */
	name: string;
	/** What it is called in events and addresses: its name, or name@agent for an agent's own source. */
	key: string;
	/** The agent it is set up by, and that agent's workspace. */
	agent: string;
	workspace: string;
	/** pine's home folder, which no source may point into. */
	home: string;
	/** An absolute path for one an agent wrote: ~ is the user's home, anything relative is meant from the workspace. */
	resolve(p: string): string;
	/** A fresh secret of `bytes` random bytes, as letters and digits. */
	random(bytes: number): string;
	/** The name a secret option gets in pine's .env file, to tell the owner where to find it. */
	envName(option: string): string;
}

export interface SourceType {
	/** One line: what a source of this type reports and what it is for. */
	summary: string;
	/**
	 * Its options as a JSON schema of an object (typebox's Type.Object). Give each property a
	 * description; mark one that is a password or token with `secret: true`, and pine keeps its value
	 * in .env and out of the configuration, the event log and what models see.
	 */
	options: TSchema;
	/** Check the options and say what the source would do. Throw for what cannot work. Without it, a set-up is always put to the owner. */
	plan?(options: Record<string, any>, setup: SourceSetup): SourcePlan;
	/**
	 * Its "message" events are somebody writing to the agent: the event's `text` is what they
	 * wrote, it reaches the agent as a message rather than as a report, and the agent's answer goes
	 * back through the source.
	 */
	talks?: boolean;
	/**
	 * It can also send. One line for the agent on what sending through it does and what to pass,
	 * for example 'a Telegram message to your owner: {"text": "..."}'. The agent's `send` tool
	 * offers every source that says this.
	 */
	sends?: string;
}
