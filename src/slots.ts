// Which slot of a llama.cpp server a conversation's requests go to.
//
// A llama.cpp server keeps, per slot, what it has read of one conversation. Left to itself it
// gives a request to the slot whose content begins most like it. Conversations of one agent all
// begin alike (the tools, the instructions), so a new conversation, or a sub-agent, is given the
// slot of the conversation the owner is in the middle of, and that one is read again from its
// beginning when the owner comes back to it: for many models the server cannot go back part of
// the way (it can only return to a point it saved, and it saves few).
//
// So pine says which slot (`id_slot`): a conversation goes back to the slot it was in, and one
// that has none takes the slot that is cheapest to lose, an empty one first. Nothing here is
// needed for a correct answer; a server that knows no slots is never sent the word.

export interface Occupant {
	/** The conversation whose text the slot holds: "agent:conversation". */
	who: string;
	/** How many tokens of it the slot holds: what it would cost to read again. */
	tokens: number;
	at: number;
	/** For a slot pine filled itself (WARM): whose beginning it holds and which, as "agent:tools:instructions". */
	what?: string;
}

/** Who holds a slot that pine filled in the background with what every conversation begins with. */
export const WARM = "~warm";

export class SlotBook {
	/** Slots a server has, by server ("origin|model"). Zero: not a llama.cpp server, or not known yet. */
	private count = new Map<string, number>();
	/** Who has a request under way in a slot, by server. */
	private busy = new Map<string, Map<number, string>>();
	private held: Map<string, Array<Occupant | undefined>>;
	private save: (all: Record<string, Array<Occupant | undefined>>) => void;

	constructor(saved: Record<string, Array<Occupant | undefined>> | undefined, save: (all: Record<string, Array<Occupant | undefined>>) => void) {
		this.held = new Map(Object.entries(saved ?? {}));
		this.save = save;
	}

	known(server: string): boolean {
		return this.count.has(server);
	}

	setCount(server: string, n: number): void {
		this.count.set(server, Math.max(0, Math.floor(n)));
	}

	/** The slot for a request of `who`, or undefined to let the server choose (no free slot, or no slots known). */
	take(server: string, who: string): number | undefined {
		return this.takeFrom(server, who)?.slot;
	}

	/** As take(), and how much of the conversation the slot held before: nothing of that kept by the server means it has lost what it had read. */
	takeFrom(server: string, who: string): { slot: number; held: number } | undefined {
		const n = this.count.get(server) ?? 0;
		if (n <= 0) return undefined;
		const busy = this.busy.get(server) ?? new Map<number, string>();
		this.busy.set(server, busy);
		const held = this.held.get(server) ?? [];
		this.held.set(server, held);
		// A slot that is being filled in the background counts as free: the server takes the request when it is done
		// with that, which beats taking the place of a conversation.
		const free = Array.from({ length: n }, (_, i) => i).filter((i) => !busy.has(i) || busy.get(i) === WARM);
		if (!free.length) return undefined;
		// Its own slot, if it still holds it; else one that was filled with what this agent's conversations begin with;
		// else an empty one; else the one that is cheapest to read again, the longest unused first.
		const mine = free.find((i) => held[i]?.who === who);
		const agent = who.slice(0, who.indexOf(":") + 1);
		const warm = free.find((i) => held[i]?.who === WARM && held[i]!.what?.startsWith(agent));
		const empty = free.find((i) => !held[i]);
		const cheapest = () => [...free].sort((a, b) => held[a]!.tokens - held[b]!.tokens || held[a]!.at - held[b]!.at)[0];
		const slot = mine ?? warm ?? empty ?? cheapest();
		const before = held[slot]?.who === who ? held[slot]!.tokens : 0;
		busy.set(slot, who);
		if (held[slot]?.who !== who) held[slot] = { who, tokens: 0, at: Date.now() };
		return { slot, held: before };
	}

	/** The request is over: the slot is free again, and holds this much of the conversation. */
	give(server: string, slot: number | undefined, who: string, tokens?: number): void {
		if (slot === undefined) return;
		if (this.busy.get(server)?.get(slot) === who) this.busy.get(server)!.delete(slot);
		const held = this.held.get(server);
		if (held && held[slot]?.who === who) {
			held[slot] = { who, tokens: tokens ?? held[slot]!.tokens, at: Date.now() };
			this.save(Object.fromEntries(this.held));
		}
	}

	/**
	 * Slots to fill in the background with what an agent's conversations begin with (`what`:
	 * "agent:tools:instructions"): the empty ones, and the ones filled for this agent before whose
	 * content is no longer what a conversation begins with. One whose tools changed is read from
	 * its first token, so that waits until it is `old` milliseconds old: conversations of one agent
	 * that have different tools must not have the slot filled anew with every message.
	 */
	toFill(server: string, what: string, old = 600_000): number[] {
		const n = this.count.get(server) ?? 0;
		const held = this.held.get(server) ?? [];
		const busy = this.busy.get(server);
		const [agent, tools] = what.split(":");
		return Array.from({ length: n }, (_, i) => i).filter((i) => {
			if (busy?.has(i)) return false;
			const h = held[i];
			if (!h) return true;
			if (h.who !== WARM || !h.what || h.what === what) return false;
			const [a, t] = h.what.split(":");
			return a === agent && (t === tools || h.at < Date.now() - old);
		});
	}

	/** Whether no request of pine's is under way on the server. */
	quiet(server: string): boolean {
		return !(this.busy.get(server)?.size ?? 0);
	}

	/** Take a slot to fill it in the background. False when a request is under way in it. */
	fill(server: string, slot: number, what: string): boolean {
		const held = this.held.get(server) ?? [];
		this.held.set(server, held);
		const busy = this.busy.get(server) ?? new Map<number, string>();
		this.busy.set(server, busy);
		if (busy.has(slot) || (held[slot] && held[slot]!.who !== WARM)) return false;
		busy.set(slot, WARM);
		// What every conversation begins with: nothing of anybody's is lost when the next conversation takes this slot.
		held[slot] = { who: WARM, tokens: 0, at: Date.now(), what };
		return true;
	}

	/** The filling is over. One that failed leaves the slot empty; a conversation that took the slot meanwhile keeps it. */
	filled(server: string, slot: number, ok: boolean, tokens = 0): void {
		if (this.busy.get(server)?.get(slot) === WARM) this.busy.get(server)!.delete(slot);
		const held = this.held.get(server);
		if (!held || held[slot]?.who !== WARM) return;
		held[slot] = ok ? { ...held[slot]!, tokens, at: Date.now() } : undefined;
		this.save(Object.fromEntries(this.held));
	}

	/** The server has lost what it had read (it was started anew): only the slot of the request that showed it holds something. */
	lost(server: string, except?: number): void {
		const held = this.held.get(server);
		if (!held) return;
		for (let i = 0; i < held.length; i++) if (i !== except) held[i] = undefined;
		this.save(Object.fromEntries(this.held));
	}

	/** A conversation is gone (reset, removed, a sub-agent that is done): its slot is anybody's. */
	forget(who: string): void {
		for (const held of this.held.values()) for (let i = 0; i < held.length; i++) if (held[i]?.who === who) held[i] = undefined;
		this.save(Object.fromEntries(this.held));
	}

	/** An agent is gone: nothing of it is kept here either. */
	forgetAgent(agent: string): void {
		for (const held of this.held.values()) for (let i = 0; i < held.length; i++) if (held[i]?.who.startsWith(`${agent}:`) || held[i]?.what?.startsWith(`${agent}:`)) held[i] = undefined;
		this.save(Object.fromEntries(this.held));
	}

	state(server: string): Array<Occupant | undefined> {
		return [...(this.held.get(server) ?? [])];
	}
}
