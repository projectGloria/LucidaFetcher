// The download engine: what is queued, what each track is doing, and why.
//
// One pool task owns a track's WHOLE chain rather than a single attempt. That
// keeps a track on one webview for its lifetime - no interleaving of two
// tracks' scrapes through the same page, no re-queueing between fallbacks - and
// makes the chain a plain loop instead of the old scatter of mutually
// re-entrant functions (handleNoStart -> tryFallbackOrAbandon ->
// startMonochromeAttempt -> processNextInQueue) that each re-queued the item
// and hoped the globals still lined up.
//
// The controller owns chain state only. Byte-level transfer progress stays with
// whoever receives the download events, because that is per-file and arrives
// far too often to route through a store subscription.

import { Pool } from './pool.mjs';
import { buildPlan, nextAttempt, advanceAfter } from './chain.mjs';
import { buildSearchVariants } from './variants.mjs';
import { describeStep, describeOutcome, describeAbandon, serviceLabel } from './status.mjs';

export const QUEUED = 'queued';
export const SEARCHING = 'searching';
// Fetched, handed off, and not yet moving bytes. A scraper site gives you no
// parked link you can hold - "the page finished preparing the file" and "the
// transfer started" are the same instant - so READY is the honest version of
// "ready to download": the search is done and this track is now purely the
// network's problem. It is a real, visible state rather than a flicker because
// the speed limiter in main.js pauses transfers that are over budget, and
// because the engine deliberately runs more transfers than it downloads at
// full tilt. Bytes arriving is what turns it into DOWNLOADING.
export const READY = 'ready';
export const DOWNLOADING = 'downloading';
export const COMPLETED = 'completed';
export const SKIPPED = 'skipped';
export const CANCELLED = 'cancelled';

/**
 * What makes two queue entries the same download.
 *
 * `item.key` is the manifest key the main process files a finished download
 * under, so using it here means "already queued" and "already on disk" agree on
 * what one track is. Nothing is guessed from title and artist alone: an item
 * without a key has not been through the queue-item builder, and a guess is a
 * poor trade when the cost of being wrong is a track silently never fetched.
 */
export function identityKey(item) {
  return item && item.key ? String(item.key).toLowerCase() : null;
}

/** What a detached transfer's ending means to the chain. */
function transferResult(done) {
  if (!done) return { outcome: 'no-download-started' };
  if (done.status !== 'completed') return { outcome: 'download-failed', message: done.status };
  return { outcome: 'completed', savePath: done.savePath, file: done.file, bytes: done.bytes };
}

export class Controller {
  /**
   * @param opts {
   *   getWorker: (slot) => Worker
   *   services: string[]
   *   concurrency?: number
   *   log?: (evt, data) => void
   *   planOptions?: object  // forwarded to buildPlan
   * }
   */
  constructor(opts = {}) {
    this.getWorker = opts.getWorker;
    this.services = opts.services || [];
    this.log = opts.log || (() => {});
    this.planOptions = opts.planOptions || {};
    this.unhealthy = new Set();

    // The pipeline. A scraped attempt now ends when the transfer starts, which
    // leaves the webview free to search the next track while the bytes of this
    // one are still moving - the search phase and the transfer phase use
    // completely different resources, and holding a slot through both was
    // costing roughly the transfer time per track.
    //
    // `awaitTransfer` is how the controller finds out the file landed once the
    // worker is no longer waiting for it.
    this.awaitTransfer = opts.awaitTransfer || null;
    this.cancelTransfer = opts.cancelTransfer || null;
    // How many transfers may run DETACHED from a slot. Past this, a chain waits
    // for its own file inline, which both bounds the transfers in flight and
    // stops the queue racing ahead of the network.
    this.maxTransfers = opts.maxTransfers == null ? 3 : Math.max(0, opts.maxTransfers | 0);
    this.transfers = new Map(); // item id -> AbortController

    this.items = new Map(); // id -> record
    // identity -> id, so the same song appearing twice in a playlist is queued
    // once. Item ids are per-entry, so they cannot answer this on their own.
    this.keys = new Map();
    this._listeners = new Set();
    this._version = 0;

    this.pool = new Pool({
      concurrency: opts.concurrency || 3,
      run: (item, slot, signal) => this._runChain(item, slot, signal),
      onEvent: (name, payload) => {
        if (name === 'error') {
          // A chain should never throw; if one does, the track must still reach
          // a terminal state or it sits at "searching" forever.
          const rec = this.items.get(payload.item.id);
          if (rec && !this._isTerminal(rec.status)) {
            this._set(rec, SKIPPED, `Engine error: ${payload.error && payload.error.message}`);
          }
        }
      },
    });
  }

  // ---- store interface (useSyncExternalStore-compatible) -------------------

  subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  getSnapshot() { return this._version; }
  getItems() { return [...this.items.values()]; }
  getItem(id) { return this.items.get(id); }

  get stats() {
    let queued = 0, active = 0, ready = 0, completed = 0, skipped = 0;
    for (const r of this.items.values()) {
      if (r.status === COMPLETED) completed++;
      else if (r.status === SKIPPED) skipped++;
      else if (r.status === READY) { ready++; active++; }
      else if (r.status === SEARCHING || r.status === DOWNLOADING) active++;
      else if (r.status === QUEUED) queued++;
    }
    return { queued, active, ready, completed, skipped, total: this.items.size };
  }

  _emit() { this._version++; this._listeners.forEach((fn) => fn()); }

  _set(rec, status, statusText) {
    rec.status = status;
    if (statusText !== undefined) rec.statusText = statusText;
    this._emit();
  }

  _isTerminal(s) { return s === COMPLETED || s === SKIPPED || s === CANCELLED; }

  // ---- queue ---------------------------------------------------------------

  add(items) {
    const list = Array.isArray(items) ? items : [items];
    const fresh = [];
    let duplicates = 0;
    for (const item of list) {
      if (this.items.has(item.id)) continue; // never queue the same track twice
      // A playlist that lists the same song five times is five entries with
      // five ids and one identity. Downloading it once and writing it to the
      // same path five times is work that can only produce the file that is
      // already there - so the identity, not the id, decides.
      const key = identityKey(item);
      if (key && this.keys.has(key)) {
        const firstId = this.keys.get(key);
        if (this.items.has(firstId)) {
          duplicates++;
          this.log('duplicate', { id: item.id, name: item.name, key, firstId });
          continue;
        }
        this.keys.delete(key); // the original was removed; this entry takes over
      }
      if (key) this.keys.set(key, item.id);
      item.searchVariants = item.searchVariants && item.searchVariants.length
        ? item.searchVariants
        : buildSearchVariants(item.title, item.artist, item.album);
      this.items.set(item.id, {
        item, status: QUEUED, statusText: 'Waiting in queue',
        tried: [], plan: null, step: null, result: null,
      });
      fresh.push(item);
    }
    this.lastAdd = { added: fresh.length, duplicates };
    if (fresh.length) { this._emit(); this.pool.submit(fresh); }
    return fresh.length;
  }

  /**
   * Take over a file that is already coming down - one the main process picked
   * up where the last run left it. There is no chain behind this and no slot
   * held: the track goes straight to `downloading` and is followed the same way
   * a handed-off transfer is. If the resume turns out to be dead (the link has
   * expired, the server will not do ranges) it falls back to the ordinary
   * chain, which is the same route a failed transfer takes.
   */
  adoptTransfer(item, info = {}) {
    if (this.items.has(item.id)) return false;
    const key = identityKey(item);
    if (key && this.keys.has(key)) return false;
    if (key) this.keys.set(key, item.id);

    item.searchVariants = item.searchVariants && item.searchVariants.length
      ? item.searchVariants
      : buildSearchVariants(item.title, item.artist, item.album);

    const total = info.total || 0;
    const received = info.received || 0;
    const rec = {
      item, status: received > 0 ? DOWNLOADING : READY,
      statusText: 'Resuming where it stopped',
      tried: item.tried || [], plan: null, step: null, result: null,
      progress: total > 0 ? Math.min(1, received / total) : null,
      receivedBytes: received, totalBytes: total,
    };
    this.items.set(item.id, rec);

    const ctl = new AbortController();
    this.transfers.set(item.id, ctl);
    rec.transferToken = ctl;
    this._emit();

    Promise.resolve(this._waitForTransfer(item.id, ctl.signal)).then((done) => {
      if (this.transfers.get(item.id) === ctl) this.transfers.delete(item.id);
      // Given up on already (failTransfer), or no longer ours.
      if (rec.transferToken !== ctl) { this._emit(); return; }
      rec.transferToken = null;
      if (this.items.get(item.id) !== rec || rec.status === CANCELLED) { this._emit(); return; }
      if (ctl.signal.aborted) { this._set(rec, CANCELLED, 'Cancelled'); return; }

      if (done && done.status === 'completed') {
        rec.result = { outcome: 'completed', savePath: done.savePath, file: done.file, bytes: done.bytes };
        this.log('done', { id: item.id, name: item.name, via: 'resume' });
        this._set(rec, COMPLETED, 'Downloaded');
        return;
      }
      this.log('resume.failed', { id: item.id, name: item.name, status: done && done.status });
      this._set(rec, QUEUED, 'Could not pick that download up - starting it again');
      this.pool.submit([item]);
    });
    return true;
  }

  pause() { this.pool.pause(); this._emit(); }
  resume() { this.pool.resume(); this._emit(); }
  get paused() { return this.pool.paused; }
  setConcurrency(n) { this.pool.setConcurrency(n); this._emit(); }

  cancel(id) {
    const rec = this.items.get(id);
    this.pool.cancel(id);
    this._abortTransfer(id);
    if (rec && !this._isTerminal(rec.status)) this._set(rec, CANCELLED, 'Cancelled');
    return !!rec;
  }

  cancelAll() {
    this.pool.cancelAll();
    for (const id of [...this.transfers.keys()]) this._abortTransfer(id);
    for (const rec of this.items.values()) {
      if (!this._isTerminal(rec.status)) this._set(rec, CANCELLED, 'Cancelled');
    }
    this._emit();
  }

  /**
   * Forget these tracks entirely - cancelled, dropped from the queue, gone from
   * the view.
   *
   * Distinct from cancel(), which leaves a tombstone row behind saying the track
   * was cancelled. That is the right answer for one track the user changed their
   * mind about, and the wrong one for a playlist queued by mistake: two hundred
   * cancelled rows are exactly the mess they were trying to clear. Files already
   * downloaded are NOT touched - the queue is a list of intentions, not the
   * library, and deleting audio is not something a "remove from list" button
   * should ever do quietly.
   */
  remove(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    let removed = 0;
    for (const id of list) {
      const rec = this.items.get(id);
      if (!rec) continue;
      // Cancel first: an in-flight chain holds a pool slot and a webview, and
      // dropping the record without cancelling would leave both working on a
      // track nothing is left to receive.
      if (!this._isTerminal(rec.status)) { this.pool.cancel(id); this._abortTransfer(id); }
      this.items.delete(id);
      const key = identityKey(rec.item);
      if (key && this.keys.get(key) === id) this.keys.delete(key);
      removed++;
    }
    if (removed) this._emit();
    return removed;
  }

  /** Every track of one playlist/album group, by the id useGroups() keys on. */
  removeGroup(groupId) {
    const ids = [];
    for (const rec of this.items.values()) {
      const gid = rec.item.groupId || '__loose__';
      if (gid === groupId) ids.push(rec.item.id);
    }
    return this.remove(ids);
  }

  markServiceUnhealthy(service) { this.unhealthy.add(service); }
  markServiceHealthy(service) { this.unhealthy.delete(service); }

  // ---- transfer state ------------------------------------------------------
  //
  // The chain loop cannot report these: between the click and the finished file
  // it is simply awaiting one promise. The bytes are announced separately by
  // the main process, so they are pushed in from the outside.

  noteDownloadStarted(id, service) {
    const rec = this.items.get(id);
    if (!rec || this._isTerminal(rec.status)) return;
    rec.progress = null; // size not known until the first progress event
    this._markReady(rec, service);
  }

  /**
   * The track is fetched and the file is now the main process's business.
   *
   * Not DOWNLOADING: nothing has moved yet. Calling this "downloading" is what
   * made a queue of six handed-off tracks look like six live transfers when
   * three of them were sitting behind the speed limiter, and it is the reason
   * there was no way to see how far ahead of the network the searches had run.
   */
  _markReady(rec, service) {
    if (service || (rec.step && rec.step.service)) {
      rec.transferService = service || rec.step.service;
    }
    if (rec.status === DOWNLOADING) return; // bytes beat the hand-off here
    this._set(rec, READY, `Fetched — waiting to download from ${serviceLabel(rec.transferService)}`);
  }

  noteProgress(id, received, total) {
    const rec = this.items.get(id);
    if (!rec || this._isTerminal(rec.status)) return;
    // A stream with no declared length gives an indeterminate bar rather than a
    // fake one that crawls to 99% and stops.
    rec.progress = total > 0 ? Math.min(1, received / total) : null;
    rec.receivedBytes = received;
    rec.totalBytes = total;
    // The first byte is what promotes a ready track to a downloading one. A
    // progress event of zero is Chromium announcing a transfer it has not begun
    // - promoting on that would put every parked file back under "Downloading".
    if (received > 0 && rec.status !== DOWNLOADING) {
      rec.status = DOWNLOADING;
      rec.statusText = `Downloading from ${serviceLabel(rec.transferService || (rec.step && rec.step.service))}`;
    }
    this._emit();
  }

  /**
   * Give every skipped track one more pass through the whole chain. A store
   * that answered "uh-oh" all afternoon, or a stream backend that was down, may
   * well answer now - so a skip is not necessarily permanent.
   */
  retrySkipped() {
    const again = [];
    for (const rec of this.items.values()) {
      if (rec.status !== SKIPPED || rec.retried) continue;
      rec.retried = true;
      rec.tried = [];
      rec.plan = null;
      rec.step = null;
      this._set(rec, QUEUED, 'Queued for one more try');
      again.push(rec.item);
    }
    if (again.length) this.pool.submit(again);
    return again.length;
  }

  // ---- transfers off the pool ----------------------------------------------

  _waitForTransfer(id, signal) {
    if (!this.awaitTransfer) return Promise.resolve(null);
    return Promise.resolve(this.awaitTransfer(id, signal)).catch(() => null);
  }

  /**
   * Give up on a transfer we are following without cancelling the track: the
   * resume could not be started at all, so the track goes back through the
   * ordinary chain. Distinct from cancel(), which is the user's decision.
   */
  failTransfer(id, reason) {
    const rec = this.items.get(id);
    if (!rec || !rec.transferToken) return false;
    const ctl = rec.transferToken;
    rec.transferToken = null;
    if (this.transfers.get(id) === ctl) this.transfers.delete(id);
    if (this._isTerminal(rec.status)) return false;
    this.log('transfer.gave-up', { id, name: rec.item.name, reason: reason || null });
    this._set(rec, QUEUED, 'Could not pick that download up - starting it again');
    this.pool.submit([rec.item]);
    return true;
  }

  _abortTransfer(id) {
    const rec = this.items.get(id);
    if (rec) rec.transferToken = null;
    const ctl = this.transfers.get(id);
    if (!ctl) return;
    this.transfers.delete(id);
    try { ctl.abort(); } catch (e) { /* already settled */ }
    if (this.cancelTransfer) { try { this.cancelTransfer(id); } catch (e) { /* best effort */ } }
  }

  /**
   * Follow a file that is already moving, with no slot held. A transfer that
   * fails has to re-enter the chain where it left off - the whole point of the
   * chain is that a source failing is not the end of the track - so the item
   * goes back to the FRONT of the queue with its plan and its resume point
   * intact, rather than behind two hundred tracks it was already ahead of.
   */
  _detachTransfer(rec, item, step, index) {
    const ctl = new AbortController();
    this.transfers.set(item.id, ctl);
    rec.transferToken = ctl;
    this._emit();

    Promise.resolve(this._waitForTransfer(item.id, ctl.signal)).then((done) => {
      if (this.transfers.get(item.id) === ctl) this.transfers.delete(item.id);
      if (rec.transferToken !== ctl) { this._emit(); return; }
      rec.transferToken = null;
      // Removed, cancelled or otherwise no longer ours while the bytes moved.
      if (this.items.get(item.id) !== rec || rec.status === CANCELLED) { this._emit(); return; }
      if (ctl.signal.aborted) { this._set(rec, CANCELLED, 'Cancelled'); return; }

      const res = transferResult(done);
      rec.tried.push({
        service: step.service, outcome: res.outcome,
        label: res.label || null, message: res.message || null,
        at: new Date().toISOString(),
      });

      if (res.outcome === 'completed') {
        rec.result = res;
        this.log('done', { id: item.id, name: item.name, service: step.service, via: 'download' });
        this._set(rec, COMPLETED, 'Downloaded');
        return;
      }

      const next = advanceAfter(rec.plan, step.index, res.outcome);
      rec.resumeIndex = next;
      this._set(rec, QUEUED, describeOutcome(res.outcome, {
        service: step.service, label: res.label, message: res.message,
      }));
      this.log('transfer.failed', { id: item.id, name: item.name, service: step.service, outcome: res.outcome });
      this.pool.requeueFront(item);
    });
  }

  // ---- the chain -----------------------------------------------------------

  async _runChain(item, slot, signal) {
    const rec = this.items.get(item.id);
    if (!rec || rec.status === CANCELLED) return;

    // The store the track's own link points at comes FIRST, then the configured
    // fallback chain. `services` holds only the fallbacks - qobuz is deliberately
    // kept out of it because it is normally the originating store, so building a
    // plan from the fallback list alone would never ask the one source most
    // likely to have the track.
    const services = [];
    for (const sv of [item.originalService, ...this.services]) {
      if (sv && services.indexOf(sv) === -1) services.push(sv);
    }

    // A track that comes back after a failed transfer resumes its chain rather
    // than restarting it: the sources it already exhausted are still exhausted.
    if (rec.plan && rec.resumeIndex != null) {
      const from = rec.resumeIndex;
      rec.resumeIndex = null;
      return this._walkChain(rec, item, slot, signal, from);
    }

    rec.plan = buildPlan({
      variants: item.searchVariants,
      services,
      // A track imported from a SoundCloud or YouTube link knows the exact
      // upload it came from; that is worth trying before any search.
      directUrl: item.mediaUrl || null,
      directService: item.mediaService || null,
      ...this.planOptions,
    });

    if (!rec.plan.length) {
      this._set(rec, SKIPPED, describeAbandon([]));
      return;
    }

    return this._walkChain(rec, item, slot, signal, 0);
  }

  async _walkChain(rec, item, slot, signal, startIndex) {
    let index = startIndex;
    for (;;) {
      if (signal && signal.aborted) { this._set(rec, CANCELLED, 'Cancelled'); return; }

      const step = nextAttempt(rec.plan, { index, skip: this.unhealthy });
      if (!step) {
        const why = describeAbandon(rec.tried);
        this.log('skip', { id: item.id, name: item.name, reason: why, tried: rec.tried });
        this._set(rec, SKIPPED, why);
        return;
      }

      rec.step = step;
      this._set(rec, SEARCHING, describeStep(step, rec.plan));

      let res;
      try {
        res = await this.getWorker(slot).run(item, step, signal);
      } catch (err) {
        if (err && err.name === 'Aborted') { this._set(rec, CANCELLED, 'Cancelled'); return; }
        res = { outcome: 'error', message: err && err.message };
      }

      if (signal?.aborted || this.items.get(item.id) !== rec) {
        if (this.items.get(item.id) === rec) this._set(rec, CANCELLED, 'Cancelled');
        return;
      }

      // The transfer has begun and the view is free. Either let go of the slot
      // and follow the file from outside the pool, or - if enough transfers are
      // already detached - stay here and wait for it, which is what keeps the
      // queue from running arbitrarily far ahead of the network.
      if (res.outcome === 'transferring') {
        this._markReady(rec, step.service);
        if (this.awaitTransfer && this.transfers.size < this.maxTransfers) {
          this._detachTransfer(rec, item, step, index);
          return;
        }
        const done = await this._waitForTransfer(item.id, signal);
        if (signal?.aborted || this.items.get(item.id) !== rec) {
          if (this.items.get(item.id) === rec) this._set(rec, CANCELLED, 'Cancelled');
          return;
        }
        res = transferResult(done);
      }

      rec.tried.push({
        service: step.service, outcome: res.outcome,
        label: res.label || null, message: res.message || null,
        at: new Date().toISOString(),
      });

      if (res.outcome === 'completed') {
        rec.result = res;
        this.log('done', { id: item.id, name: item.name, service: step.service, via: res.via || 'download' });
        this._set(rec, COMPLETED, 'Downloaded');
        return;
      }

      this._set(rec, SEARCHING, describeOutcome(res.outcome, {
        service: step.service, label: res.label, message: res.message,
      }));

      index = advanceAfter(rec.plan, step.index, res.outcome);
    }
  }
}
