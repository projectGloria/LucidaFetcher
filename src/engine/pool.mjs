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
    this._concurrency = next;

    // Rebuilt from what is ACTUALLY running, never by arithmetic on the old
    // ceiling. Growing used to push every index in [old, new) back
    // unconditionally - but a busy slot is not in _freeSlots to begin with, it
    // is held by its task - so lowering the concurrency slider and raising it
    // again (a range input fires on every step of one drag) handed a live slot
    // to a second chain. Two chains on one slot means two tracks driving the
    // same webview AND registering the same webContentsId download context,
    // which files the finished file under the wrong track: silent corruption,
    // not a visible failure.
    //
    // Slots at or above the new ceiling keep running; _start's finally checks
    // the ceiling before returning one, so they retire as they come back.
    const busy = new Set();
    for (const run of this.active.values()) busy.add(run.slot);
    this._freeSlots = [];
    for (let i = 0; i < next; i++) if (!busy.has(i)) this._freeSlots.push(i);

    this._pump();
  }

  submit(items) {
    const list = Array.isArray(items) ? items : [items];
    const existing = new Set(this.queue.map((it) => it.id));
    for (const item of list) {
      if (!existing.has(item.id)) {
        this.queue.push(item);
        existing.add(item.id);
      }
    }
    this._pump();
  }

  /** Put items at the FRONT of the queue in their given order. */
  submitFront(items) {
    const list = Array.isArray(items) ? items : [items];
    if (!list.length) return;
    const ids = new Set(list.map((it) => it.id));
    this.queue = this.queue.filter((it) => !ids.has(it.id));
    this.queue.unshift(...list);
    this._pump();
  }

  /** Put an item back at the FRONT - used when an attempt fails and the track
   *  should carry on down its chain before anything new is started. */
  requeueFront(item) {
    this.queue = this.queue.filter((it) => it.id !== item.id);
    this.queue.unshift(item);
    this._pump();
  }

  /**
   * Move a queued item to 'top' | 'bottom' | 'up' | 'down' or a numeric index.
   */
  move(id, target) {
    const idx = this.queue.findIndex((it) => it.id === id);
    if (idx < 0) return false;
    let nextIdx = idx;
    if (target === 'top' || target === 'front') nextIdx = 0;
    else if (target === 'bottom' || target === 'back') nextIdx = this.queue.length - 1;
    else if (target === 'up') nextIdx = Math.max(0, idx - 1);
    else if (target === 'down') nextIdx = Math.min(this.queue.length - 1, idx + 1);
    else if (typeof target === 'number') nextIdx = Math.max(0, Math.min(this.queue.length - 1, target | 0));
    if (nextIdx === idx) return false;
    const [item] = this.queue.splice(idx, 1);
    this.queue.splice(nextIdx, 0, item);
    return true;
  }

  /**
   * Move queued item `fromId` to the position of `toId`.
   */
  reorder(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return false;
    const fromIdx = this.queue.findIndex((it) => it.id === fromId);
    const toIdx = this.queue.findIndex((it) => it.id === toId);
    if (fromIdx < 0 || toIdx < 0) return false;
    const [item] = this.queue.splice(fromIdx, 1);
    this.queue.splice(toIdx, 0, item);
    return true;
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
    this._pump();
    return this.queue.length < before || !!running;
  }

  cancelAll() {
    this.queue = [];
    for (const { controller } of this.active.values()) {
      try { controller.abort(); } catch (e) { /* already settled */ }
    }
    this._pump();
  }

  /** Resolves when nothing is queued and nothing is running. */
  onIdle() {
    if (!this.queue.length && !this.active.size) return Promise.resolve();
    return new Promise((resolve) => this._idleResolvers.push(resolve));
  }

  _pump() {
    while (!this.paused && this.queue.length && this._freeSlots.length && this.active.size < this._concurrency) {
      // A detached transfer can fail before its original task returns its slot.
      // Starting that id twice overwrites active and gives away a busy webview.
      const index = this.queue.findIndex((item) => !this.active.has(item.id));
      if (index < 0) break;
      const slot = this._freeSlots.shift();
      const [item] = this.queue.splice(index, 1);
      this._start(item, slot);
    }
    if (!this.queue.length && !this.active.size) {
      const waiting = this._idleResolvers;
      this._idleResolvers = [];
      waiting.forEach((r) => r());
      this.onEvent('idle', {});
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
