/**
 * Bounds how many agent runs talk to the model server at once. Higher priority waits less;
 * equal priorities are first come, first served.
 */
export class Limiter {
	max: number;
	private active = 0;
	private seq = 0;
	private queue: Array<{ priority: number; seq: number; resolve: () => void }> = [];

	constructor(max: number) {
		this.max = Math.max(1, max);
	}

	get stats() {
		return { active: this.active, waiting: this.queue.length, max: this.max };
	}

	async acquire(priority = 0): Promise<Slot> {
		await this.take(priority);
		return new Slot(this, priority);
	}

	take(priority: number): Promise<void> {
		if (this.active < this.max) {
			this.active++;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.queue.push({ priority, seq: this.seq++, resolve });
			this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
		});
	}

	free(): void {
		const next = this.queue.shift();
		if (next) next.resolve();
		else this.active--;
	}
}

/** One run's place at the model server. A run that only waits for other runs lends its place out with suspend(). */
export class Slot {
	private limiter: Limiter;
	private priority: number;
	private held = true;
	private done = false;
	private waiters = 0;
	private reacquiring?: Promise<void>;

	constructor(limiter: Limiter, priority: number) {
		this.limiter = limiter;
		this.priority = priority;
	}

	/** Give the place up while `fn` runs (a delegated task, sub-agents), then take one again before returning. */
	async suspend<T>(fn: () => Promise<T>): Promise<T> {
		this.waiters++;
		if (this.reacquiring) await this.reacquiring;
		if (this.held && !this.done) {
			this.held = false;
			this.limiter.free();
		}
		try {
			return await fn();
		} finally {
			this.waiters--;
			if (this.waiters === 0 && !this.held && !this.done) {
				// A run that already started goes ahead of runs that have not.
				this.reacquiring = this.limiter.take(this.priority + 1000).then(() => {
					this.held = true;
					this.reacquiring = undefined;
					if (this.done) this.release();
				});
			}
			if (this.reacquiring) await this.reacquiring;
		}
	}

	release(): void {
		this.done = true;
		if (!this.held) return;
		this.held = false;
		this.limiter.free();
	}
}
