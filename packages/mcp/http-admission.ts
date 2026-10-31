/** Fair bounded admission for authenticated HTTP requests. Idle keep-alive
 * sockets do not consume a permit; queued work is scheduled round-robin by
 * authenticated principal so one credential cannot monopolize free slots. */
export class FairRequestAdmission {
  readonly #maxActive: number;
  readonly #maxPerPrincipal: number;
  readonly #maxQueued: number;
  #active = 0;
  #queued = 0;
  readonly #activeByPrincipal = new Map<string, number>();
  readonly #queues = new Map<string, Array<{ resolve: (release: () => void) => void; reject: (error: Error) => void; signal?: AbortSignal; abort?: () => void }>>();
  readonly #roundRobin: string[] = [];

  constructor(maxActive: number, maxPerPrincipal: number, maxQueued: number) {
    if (![maxActive, maxPerPrincipal, maxQueued].every(Number.isSafeInteger) || maxActive < 1 || maxPerPrincipal < 1 || maxPerPrincipal > maxActive || maxQueued < 0) throw new RangeError('Invalid HTTP admission limits');
    this.#maxActive = maxActive; this.#maxPerPrincipal = maxPerPrincipal; this.#maxQueued = maxQueued;
  }

  acquire(principal: string, signal?: AbortSignal): Promise<(() => void) | undefined> {
    if (!principal) return Promise.reject(new Error('Authenticated principal is required'));
    if (signal?.aborted) return Promise.resolve(undefined);
    const active = this.#activeByPrincipal.get(principal) ?? 0;
    if (this.#queued === 0 && this.#active < this.#maxActive && active < this.#maxPerPrincipal) {
      this.#grant(principal); return Promise.resolve(this.#releaseOnce(principal));
    }
    if (this.#queued >= this.#maxQueued) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const waiter: { resolve: (release: () => void) => void; reject: (error: Error) => void; signal?: AbortSignal; abort?: () => void } = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.abort = () => {
          const queue = this.#queues.get(principal); const index = queue?.indexOf(waiter) ?? -1;
          if (index >= 0) { queue!.splice(index, 1); this.#queued--; if (queue!.length === 0) this.#removePrincipal(principal); resolve(undefined); this.#pump(); }
        };
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      let queue = this.#queues.get(principal);
      if (!queue) { queue = []; this.#queues.set(principal, queue); this.#roundRobin.push(principal); }
      queue.push(waiter); this.#queued++;
      this.#pump();
    });
  }

  get active(): number { return this.#active; }
  get queued(): number { return this.#queued; }

  #grant(principal: string): void { this.#active++; this.#activeByPrincipal.set(principal, (this.#activeByPrincipal.get(principal) ?? 0) + 1); }
  #releaseOnce(principal: string): () => void {
    let released = false;
    return () => { if (released) return; released = true; this.#active--; const count = (this.#activeByPrincipal.get(principal) ?? 1) - 1; if (count) this.#activeByPrincipal.set(principal, count); else this.#activeByPrincipal.delete(principal); this.#pump(); };
  }
  #removePrincipal(principal: string): void { this.#queues.delete(principal); const index = this.#roundRobin.indexOf(principal); if (index >= 0) this.#roundRobin.splice(index, 1); }
  #pump(): void {
    while (this.#active < this.#maxActive && this.#roundRobin.length) {
      let checked = 0, selected = -1;
      while (checked < this.#roundRobin.length) {
        const index = checked % this.#roundRobin.length; const principal = this.#roundRobin[index]!;
        if ((this.#activeByPrincipal.get(principal) ?? 0) < this.#maxPerPrincipal && (this.#queues.get(principal)?.length ?? 0) > 0) { selected = index; break; }
        checked++;
      }
      if (selected < 0) return;
      const principal = this.#roundRobin[selected]!; const queue = this.#queues.get(principal)!; const waiter = queue.shift()!;
      this.#queued--; if (waiter.abort && waiter.signal) waiter.signal.removeEventListener('abort', waiter.abort);
      if (queue.length === 0) this.#removePrincipal(principal);
      else { this.#roundRobin.splice(selected, 1); this.#roundRobin.push(principal); }
      this.#grant(principal); waiter.resolve(this.#releaseOnce(principal));
    }
  }
}
