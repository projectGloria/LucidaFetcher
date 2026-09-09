// A fixed set of worker slots pulling from one queue.
//
// The old queue was a single `currentProcessingItem` plus a chain of
// setTimeout(processNextInQueue, 500|1000|2000) calls: every state transition
// paid a fixed delay whether or not anything was waiting on it, and only one
// track could ever be in flight. This replaces both - work starts the moment a
// slot frees, and several slots exist.
//
// A slot maps to a worker webview in the renderer. The pool deals only in slot
// indices so it stays free of Electron and can be tested in plain Node.

export class Pool {
  /**
   * @param opts {
   *   concurrency: number
   *   run: (item, slot, signal) => Promise<any>
   *   onEvent?: (name, payload) => void
   * }
   */
  constructor(opts = {}) {
    this.run = opts.run;
    this.onEvent = opts.onEvent || (() => {});
    this._concurrency = Math.max(1, opts.concurrency || 1);
    this.queue = [];
    this.active = new Map();  // item id -> { item, slot, controller }
    this.paused = false;
    this._freeSlots = Array.from({ length: this._concurrency }, (_, i) => i);
    this._idleResolvers = [];
  }

  get concurrency() { return this._concurrency; }
  get activeCount() { return this.active.size; }
  get pending() { return this.queue.length; }

  setConcurrency(n) {
    const next = Math.max(1, n | 0);
    if (next === this._concurrency) return;
    if (next > this._concurrency) {
      for (let i = this._concurrency; i < next; i++) this._freeSlots.push(i);
    } else {
      // Slots above the new ceiling are retired as they come back; anything
      // running in one is left alone to finish rather than killed mid-download.
      this._freeSlots = this._freeSlots.filter((s) => s < next);
    }
    this._concurrency = next;
    this._pump();
  }

  submit(items) {
    const list = Array.isArray(items) ? items : [items];
    for (const item of list) this.queue.push(item);
    this._pump();
  }

  /** Put an item back at the FRONT - used when an attempt fails and the track
   *  should carry on down its chain before anything new is started. */
  requeueFront(item) {
    this.queue.unshift(item);
    this._pump();
  }

  pause() { this.paused = true; }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this._pump();
  }

  /** Drop a queued item, or signal a running one to stop. */
  cancel(id) {
    const before = this.queue.length;
    this.queue = this.queue.filter((it) => it.id !== id);
    const running = this.active.get(id);
    if (running) { try { running.controller.abort(); } catch (e) { /* already settled */ } }
    return this.queue.length < before || !!running;
  }

  cancelAll() {
    this.queue = [];
    for (const { controller } of this.active.values()) {
      try { controller.abort(); } catch (e) { /* already settled */ }
    }
  }

  /** Resolves when nothing is queued and nothing is running. */
  onIdle() {
    if (!this.queue.length && !this.active.size) return Promise.resolve();
    return new Promise((resolve) => this._idleResolvers.push(resolve));
  }

  _pump() {
    while (!this.paused && this.queue.length && this._freeSlots.length) {
      const slot = this._freeSlots.shift();
      const item = this.queue.shift();
      this._start(item, slot);
    }
    if (!this.queue.length && !this.active.size) {
      const waiting = this._idleResolvers;
      this._idleResolvers = [];
      waiting.forEach((r) => r());
    }
  }

  _start(item, slot) {
    const controller = new AbortController();
    this.active.set(item.id, { item, slot, controller });
    this.onEvent('start', { item, slot });

    // The slot must come back on EVERY path. A run() that rejects and released
    // nothing would retire the slot permanently, and three of those would wedge
    // the queue with items still in it - a hang, not an error anyone can see.
    Promise.resolve()
      .then(() => this.run(item, slot, controller.signal))
      .then(
        (result) => this.onEvent('done', { item, slot, result }),
        (error) => this.onEvent('error', { item, slot, error })
      )
      .finally(() => {
        this.active.delete(item.id);
        if (slot < this._concurrency) this._freeSlots.push(slot);
        this._pump();
      });
  }
}
