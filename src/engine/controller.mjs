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
import { buildPlan, nextAttempt, advanceAfter, DOWNLOAD_SERVICES } from './chain.mjs';
import { buildSearchVariants } from './variants.mjs';
import { describeStep, describeOutcome, describeAbandon, serviceLabel } from './status.mjs';
import { assignPlaylistFiles } from './profile-paths.mjs';

// Attempt outcomes that are a verdict on the SOURCE rather than on the track.
// Kept next to the chain's own list in advanceAfter, which skips the rest of a
// store's variants for the same reasons.
const UNAVAILABLE_OUTCOMES = new Set([
  'service-unavailable', 'search-unavailable', 'navigation-timeout', 'invalid-country',
]);

export const QUEUED = 'queued';
export const PAUSED = 'paused';
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
  return { outcome: 'completed', savePath: done.savePath, file: done.file, bytes: done.bytes, service: done.service };
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
    // Stores currently known to be down, so the rest of the queue stops paying
    // their timeouts one track at a time. Nothing used to write to this set -
    // markServiceUnhealthy had no caller outside the tests - so the skip was
    // dead and a dead store cost every track in a 130-track playlist a full
    // page-load-and-poll before the chain moved on.
    //
    // Time-limited rather than permanent: a store that was rate-limiting for a
    // minute must be able to come back within the same run, and a single bad
    // attempt should not retire it for the session.
    this.unhealthy = new Set();
    this._unhealthyAt = new Map();
    this.unhealthyTtlMs = opts.unhealthyTtlMs == null ? 120000 : opts.unhealthyTtlMs;

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
    this.checkExisting = opts.checkExisting || null;
    // How many transfers may run DETACHED from a slot. Past this, a chain waits
    // for its own file inline, which both bounds the transfers in flight and
    // stops the queue racing ahead of the network.
    this.maxTransfers = opts.maxTransfers == null ? 3 : Math.max(0, opts.maxTransfers | 0);
    this.transfers = new Map(); // item id -> AbortController
    this.keepTrying = !!opts.keepTrying;
    this.retryDelayMs = opts.retryDelayMs ?? 30000;
    this.retryMaxDelayMs = opts.retryMaxDelayMs ?? 300000;
    this._retryTimer = null;
    this.retryAt = null;
    this._retryRound = 0;
    this._retryStopped = false;
    this._disposed = false;

    this.items = new Map(); // id -> record
    // identity -> id, so the same song appearing twice in a playlist is queued
    // once. Item ids are per-entry, so they cannot answer this on their own.
    this.keys = new Map();
    this.tracks = new Map(); // trackKey -> trackRecord
    this.playlists = new Map(); // playlistId -> { id, name, file, trackKeys: [], profileId }
    this.profiles = new Map(); // profileId -> profileMeta
    this._listeners = new Set();
    this._version = 0;
    // Byte counters move several times a second per transfer; statuses do not.
    // Progress rides its own channel so a ticking bar cannot re-render the
    // whole queue - see subscribeProgress.
    this._progressListeners = new Set();
    this._progressVersion = 0;

    this.pool = new Pool({
      concurrency: opts.concurrency || 3,
      run: (item, slot, signal) => this._runChain(item, slot, signal),
      onEvent: (name, payload) => {
        if (name === 'idle') this._emit();
        if (name === 'error') {
          // A chain should never throw; if one does, the track must still reach
          // a terminal state or it sits at "searching" forever.
          const rec = this._getRecord(payload.item.id);
          if (rec && rec.item === payload.item && !this._isTerminal(rec.status)) {
            this._set(rec, SKIPPED, `Engine error: ${payload.error && payload.error.message}`);
          }
        }
      },
    });
  }

  // ---- store interface (useSyncExternalStore-compatible) -------------------

  subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  getSnapshot() { return this._version; }

  _getRecord(id) {
    if (this.items.has(id)) return this.items.get(id);
    if (this.tracks.has(id)) return this.tracks.get(id);
    if (typeof id === 'string' && id.includes('::')) {
      const parts = id.split('::');
      const key = parts[parts.length - 1];
      return this.tracks.get(key) || null;
    }
    return null;
  }

  // Cache key for the derived views below. The version moves on every emit;
  // the sizes cover a structural change that has not emitted yet, so a caller
  // reading straight after add() never gets the previous list.
  _cacheKey() {
    return `${this._version}:${this.items.size}:${this.tracks.size}:${this.playlists.size}:${this.profiles.size}`;
  }

  /**
   * Every row, one per playlist membership. Rebuilt at most once per version:
   * on each emit it was being rebuilt four times (two renderer subscribers,
   * QueueView and the transport bar), each pass copying every track's item
   * into a fresh object - O(memberships) allocations, four times over, for
   * every status change. Treat the returned array and records as read-only.
   */
  getItems() {
    const key = this._cacheKey();
    if (this._itemsCache && this._itemsCache.key === key) return this._itemsCache.items;
    const items = this._buildItems();
    this._itemsCache = { key, items };
    return items;
  }

  _buildItems() {
    const loose = [...this.items.values()];
    if (!this.playlists.size) return loose;

    const derived = [];
    for (const pl of this.playlists.values()) {
      const prof = this.profiles.get(pl.profileId);
      const plFolder = pl.folder || pl.file || String(pl.name || 'Playlist').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').trim();
      const defaultPlFolder = prof?.folderName ? `${prof.folderName}/${plFolder}` : plFolder;
      const resolvedFolderName = (pl.folderName && !/\/Playlists$/i.test(pl.folderName) && pl.folderName !== 'Playlists')
        ? pl.folderName
        : defaultPlFolder;
      (pl.trackKeys || []).forEach((key, index) => {
        const track = this.tracks.get(key);
        if (!track) return;
        derived.push({
          id: `${pl.id}::${index}::${key}`,
          trackKey: key,
          item: {
            ...track.item,
            groupId: pl.id,
            groupName: pl.name,
            groupArtwork: pl.artwork || track.item.image,
            folderName: resolvedFolderName,
            profileId: prof?.id || pl.profileId,
            profileName: prof?.name || prof?.user,
            profileUser: prof?.user,
            profileArtwork: prof?.image,
            profileFolder: prof?.folderName,
          },
          status: track.status,
          statusText: track.statusText,
          priority: !!track.priority,
          prioritizedAt: track.prioritizedAt || null,
          get progress() { return track.progress; },
          get receivedBytes() { return track.receivedBytes; },
          get totalBytes() { return track.totalBytes; },
          tried: track.tried,
          attemptStartedAt: track.attemptStartedAt,
          result: track.result,
          step: track.step,
          transferService: track.transferService,
          reused: track.firstPlaylistId !== pl.id,
          file: track.file || track.result?.file,
          savePath: track.savePath || track.result?.savePath,
        });
      });
    }
    return [...loose, ...derived];
  }

  getPlaylistItems(playlistId) {
    const pl = this.playlists.get(playlistId);
    if (!pl) return [];
    const prof = this.profiles.get(pl.profileId);
    const plFolder = pl.folder || pl.file || String(pl.name || 'Playlist').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').trim();
    const defaultPlFolder = prof?.folderName ? `${prof.folderName}/${plFolder}` : plFolder;
    const resolvedFolderName = (pl.folderName && !/\/Playlists$/i.test(pl.folderName) && pl.folderName !== 'Playlists')
      ? pl.folderName
      : defaultPlFolder;
    return (pl.trackKeys || []).map((key, index) => {
      const track = this.tracks.get(key);
      if (!track) return null;
      return {
        id: `${pl.id}::${index}::${key}`,
        trackKey: key,
        item: {
          ...track.item,
          groupId: pl.id,
          groupName: pl.name,
          folderName: resolvedFolderName,
          profileId: prof?.id || pl.profileId,
        },
        status: track.status,
        statusText: track.statusText,
        priority: !!track.priority,
        prioritizedAt: track.prioritizedAt || null,
        get progress() { return track.progress; },
        get receivedBytes() { return track.receivedBytes; },
        get totalBytes() { return track.totalBytes; },
        tried: track.tried,
        attemptStartedAt: track.attemptStartedAt,
        result: track.result,
        step: track.step,
        transferService: track.transferService,
        reused: track.firstPlaylistId !== pl.id,
        file: track.file || track.result?.file,
        savePath: track.savePath || track.result?.savePath,
      };
    }).filter(Boolean);
  }

  getItem(id) { return this._getRecord(id); }

  /**
   * Returns the live execution queue order:
   * 1. Active items (downloading, ready, searching)
   * 2. Queued items in exact Pool.queue execution order (with 1-based queuePosition)
   * 3. Paused items
   * 4. Skipped / Cancelled / Completed items
   */
  getQueueOrder() {
    const unique = new Map();
    for (const rec of this.items.values()) unique.set(rec.item.id, rec);
    for (const [key, rec] of this.tracks.entries()) unique.set(key, rec);

    const active = [];
    const paused = [];
    const rest = [];
    const queuedById = new Map();

    for (const [id, rec] of unique.entries()) {
      if (rec.status === DOWNLOADING || rec.status === READY || rec.status === SEARCHING) {
        active.push(rec);
      } else if (rec.status === QUEUED) {
        queuedById.set(id, rec);
      } else if (rec.status === PAUSED) {
        paused.push(rec);
      } else {
        rest.push(rec);
      }
    }

    const orderedQueued = [];
    const seenQueued = new Set();
    for (const it of this.pool.queue) {
      const rec = queuedById.get(it.id);
      if (rec && !seenQueued.has(it.id)) {
        seenQueued.add(it.id);
        orderedQueued.push(rec);
      }
    }
    for (const [id, rec] of queuedById.entries()) {
      if (!seenQueued.has(id)) orderedQueued.push(rec);
    }

    return {
      active,
      queued: orderedQueued,
      paused,
      rest,
      all: [...active, ...orderedQueued, ...paused, ...rest],
    };
  }

  /**
   * The byte-level channel: download progress, and nothing else.
   *
   * A transfer reports bytes far more often than any track changes status, and
   * only the views that draw the bytes (the dock, a row's bar) care. Everyone
   * else subscribes to the store version and sleeps through the ticks.
   */
  subscribeProgress(fn) { this._progressListeners.add(fn); return () => this._progressListeners.delete(fn); }
  getProgressSnapshot() { return this._progressVersion; }

  // Five components read this per emit; one count serves them all. The retry
  // check runs inside _emit after a status has changed but before the version
  // moves, so it uses _countStats() directly and never sees a stale cache.
  get stats() {
    const key = this._cacheKey();
    if (this._statsCache && this._statsCache.key === key) return this._statsCache.stats;
    const stats = this._countStats();
    this._statsCache = { key, stats };
    return stats;
  }

  _countStats() {
    let queued = 0, active = 0, ready = 0, completed = 0, skipped = 0, paused = 0, cancelled = 0;
    const allRecords = [...this.items.values(), ...this.tracks.values()];
    for (const r of allRecords) {
      if (r.status === COMPLETED) completed++;
      else if (r.status === SKIPPED) skipped++;
      else if (r.status === PAUSED) paused++;
      else if (r.status === CANCELLED) cancelled++;
      else if (r.status === READY) { ready++; active++; }
      else if (r.status === SEARCHING || r.status === DOWNLOADING) active++;
      else if (r.status === QUEUED) queued++;
    }
    return { queued, active, ready, completed, skipped, paused, cancelled, total: allRecords.length };
  }

  _emit() {
    this._syncRetry();
    this._version++;
    this._progressVersion++;
    this._listeners.forEach((fn) => fn());
    this._progressListeners.forEach((fn) => fn());
  }

  _emitProgress() {
    this._progressVersion++;
    this._progressListeners.forEach((fn) => fn());
  }

  updateArtwork(updates = []) {
    if (this._disposed) return 0;
    let changed = 0;
    for (const update of updates) {
      const rec = this._getRecord(update.id);
      if (!rec || (update.item && update.item !== rec.item) || !update.image) continue;
      rec.item.image = update.image;
      rec.item.artworkPending = false;
      if (this.tracks.get(update.id) === rec && !this.playlists.get(rec.firstPlaylistId)?.artwork) {
        rec.item.groupArtwork = update.image;
      }
      changed++;
    }
    if (changed) this._emit();
    return changed;
  }

  _set(rec, status, statusText) {
    rec.status = status;
    if (status === COMPLETED) this._retryRound = 0;
    if (statusText !== undefined) rec.statusText = statusText;
    this._emit();
  }

  _isTerminal(s) { return s === COMPLETED || s === SKIPPED || s === CANCELLED; }

  // ---- queue ---------------------------------------------------------------

  setKeepTrying(enabled) {
    this.keepTrying = !!enabled;
    this._retryStopped = false;
    this._retryRound = 0;
    this._clearRetry();
    this._emit();
  }

  _clearRetry() {
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    this.retryAt = null;
  }

  _canRetry() {
    const idle = this.keepTrying && !this._disposed && !this._retryStopped && !this.paused
      && this.services.some(service => DOWNLOAD_SERVICES.includes(service)) && this.pool.pending === 0 && this.pool.activeCount === 0
      && this.transfers.size === 0;
    if (!idle) return false;
    const stats = this._countStats();
    return stats.active === 0 && stats.queued === 0 && stats.skipped > 0;
  }

  _syncRetry() {
    if (!this._canRetry()) { this._clearRetry(); return; }
    if (this._retryTimer !== null) return;
    // A dead store must not turn a missing playlist into a tight retry loop.
    const delay = Math.min(this.retryMaxDelayMs, this.retryDelayMs * 2 ** Math.min(10, this._retryRound));
    this.retryAt = Date.now() + delay;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this.retryAt = null;
      if (!this._canRetry()) return;
      this._retryRound++;
      const count = this.retrySkipped({ force: true });
      this.log('queue.auto-retry', { count, round: this._retryRound });
    }, delay);
    this._retryTimer.unref?.();
  }

  dispose() {
    this._disposed = true;
    this.cancelAll();
    this._listeners.clear();
    this._progressListeners.clear();
  }

  add(items, opts = {}) {
    const list = Array.isArray(items) ? items : [items];
    const priority = !!opts.priority;
    const preempt = !!opts.preempt;
    const startPaused = !!opts.paused;
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
          if (priority) {
            this.prioritize(firstId, { preempt });
          }
          continue;
        }
        this.keys.delete(key); // the original was removed; this entry takes over
      }
      if (key) this.keys.set(key, item.id);
      item.searchVariants = item.searchVariants && item.searchVariants.length
        ? item.searchVariants
        : buildSearchVariants(item.title, item.artist, item.album);
      const rec = {
        item,
        status: startPaused ? PAUSED : QUEUED,
        statusText: startPaused ? 'Paused — ready when you are' : (priority ? 'Prioritized — starting next' : 'Waiting in queue'),
        priority,
        prioritizedAt: priority ? Date.now() : null,
        tried: [], plan: null, step: null, result: null,
      };
      if (priority && this.items.size > 0) {
        const entries = [[item.id, rec], ...this.items.entries()];
        this.items = new Map(entries);
      } else {
        this.items.set(item.id, rec);
      }
      fresh.push(item);
    }
    this.lastAdd = { added: fresh.length, duplicates };
    if (fresh.length) {
      this._retryStopped = false;
      this._retryRound = 0;
      this._emit();
      if (!startPaused) {
        if (priority) {
          this.pool.submitFront(fresh);
          if (preempt) this._preemptSlots(Math.min(fresh.length, this.pool.concurrency), new Set(fresh.map((i) => i.id)));
        } else {
          this.pool.submit(fresh);
        }
      }
    }
    return fresh.length;
  }

  addProfile(profileMeta = {}, playlists = [], tracks = {}, { queue = true } = {}) {
    const profId = profileMeta.id || profileMeta.user || 'profile';
    this.profiles.set(profId, { ...profileMeta, id: profId });

    const trackEntries = tracks instanceof Map ? tracks.entries() : Object.entries(tracks || {});
    const trackMap = tracks instanceof Map ? tracks : new Map(trackEntries);

    // Register playlists
    for (const pl of assignPlaylistFiles(playlists)) {
      const folder = pl.folder || pl.file || String(pl.name || 'Playlist').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').trim();
      const folderName = (pl.folderName && !/\/Playlists$/i.test(pl.folderName) && pl.folderName !== 'Playlists')
        ? pl.folderName
        : (profileMeta.folderName ? `${profileMeta.folderName}/${folder}` : folder);
      this.playlists.set(pl.id, {
        id: pl.id,
        name: pl.name,
        folder,
        file: folder,
        artwork: pl.artwork || pl.image,
        folderName,
        trackKeys: [...(pl.trackKeys || [])],
        profileId: profId,
      });
    }

    // Determine firstPlaylistId for each trackKey
    const firstPlaylistForKey = new Map();
    for (const pl of playlists) {
      for (const key of (pl.trackKeys || [])) {
        if (!firstPlaylistForKey.has(key)) {
          firstPlaylistForKey.set(key, pl.id);
        }
      }
    }

    const fresh = [];
    for (const [key, meta] of trackMap.entries()) {
      if (this.tracks.has(key)) {
        const existing = this.tracks.get(key);
        // Reimporting repairs artwork on completed/shared tracks too.
        if ((meta.image || meta.artwork) && !(meta.artworkPending && existing.item.artworkPending === false)) {
          existing.item.image = meta.image || meta.artwork;
          if (!this.playlists.get(existing.firstPlaylistId)?.artwork) {
            existing.item.groupArtwork = existing.item.image;
          }
          existing.item.artworkPending = meta.artworkPending;
        }
        if (!existing.firstPlaylistId && firstPlaylistForKey.has(key)) {
          existing.firstPlaylistId = firstPlaylistForKey.get(key);
        }
        const nowDownloaded = meta.status === 'downloaded' || meta.status === COMPLETED;
        if (nowDownloaded && existing.status !== COMPLETED) {
          this.pool.cancel(key);
          this._abortTransfer(key);
          existing.transferService = meta.transferService || meta.downloadService || existing.transferService || null;
          existing.file = meta.file || existing.file || null;
          existing.savePath = meta.savePath || existing.savePath || null;
          existing.bytes = meta.bytes || existing.bytes || null;
          existing.receivedBytes = existing.bytes || 0;
          existing.totalBytes = existing.bytes || 0;
          existing.progress = 1;
          existing.result = {
            outcome: 'completed',
            file: existing.file,
            savePath: existing.savePath,
            bytes: existing.bytes,
            service: existing.transferService,
          };
          existing.status = COMPLETED;
          existing.statusText = 'Downloaded';
        }
        continue;
      }

      const firstPlId = firstPlaylistForKey.get(key) || null;
      const firstPl = firstPlId ? this.playlists.get(firstPlId) : null;
      const defaultTrackFolder = firstPl?.folderName
        || (profileMeta.folderName ? `${profileMeta.folderName}/Playlist` : 'Playlist');
      const trackFolderName = (meta.folderName && !/\/Tracks$/i.test(meta.folderName) && meta.folderName !== 'Tracks')
        ? meta.folderName
        : defaultTrackFolder;

      const isDownloaded = meta.status === 'downloaded' || meta.status === COMPLETED;
      const item = {
        id: key,
        key,
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        isrc: meta.isrc,
        service: meta.service,
        trackId: meta.trackId,
        image: meta.image || meta.artwork,
        artworkPending: meta.artworkPending,
        durationSec: meta.durationSec,
        folderName: trackFolderName,
        profileId: profId,
        profileFolder: meta.profileFolder || profileMeta.folderName,
        groupName: firstPl?.name || null,
        groupArtwork: firstPl?.artwork || meta.image || meta.artwork,
        searchVariants: meta.searchVariants && meta.searchVariants.length
          ? meta.searchVariants
          : buildSearchVariants(meta.title, meta.artist, meta.album),
      };

      const rec = {
        item,
        transferService: meta.transferService || meta.downloadService || null,
        status: isDownloaded ? COMPLETED : [SKIPPED, CANCELLED, PAUSED].includes(meta.status) ? meta.status : QUEUED,
        statusText: isDownloaded ? 'Downloaded' : meta.status === PAUSED ? (meta.statusText || 'Paused') : meta.statusText || 'Waiting in queue',
        tried: meta.tried || [],
        plan: null,
        step: null,
        result: isDownloaded ? { outcome: 'completed', file: meta.file, savePath: meta.savePath, bytes: meta.bytes } : null,
        file: meta.file || null,
        savePath: meta.savePath || null,
        bytes: meta.bytes || null,
        receivedBytes: meta.bytes || 0,
        totalBytes: meta.bytes || 0,
        firstPlaylistId: firstPlId,
      };

      this.tracks.set(key, rec);

      if (rec.status === QUEUED) {
        fresh.push(item);
      }
    }

    if (fresh.length) {
      this._retryStopped = false;
      this._retryRound = 0;
      this._emit();
      if (queue) this.pool.submit(fresh);
    } else {
      this._emit();
    }
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
    const existing = this._getRecord(item.id);
    if (existing && existing.status !== QUEUED) return false;
    const key = identityKey(item);
    if (key && this.keys.has(key) && this.keys.get(key) !== item.id) return false;
    if (key) this.keys.set(key, item.id);
    if (existing) this.pool.cancel(item.id);

    item.searchVariants = item.searchVariants && item.searchVariants.length
      ? item.searchVariants
      : buildSearchVariants(item.title, item.artist, item.album);

    const total = info.total || 0;
    const received = info.received || 0;
    const rec = Object.assign(existing || {}, {
      item, status: received > 0 ? DOWNLOADING : READY,
      statusText: 'Resuming where it stopped',
      transferService: item.transferService || existing?.transferService || item.service || null,
      tried: item.tried || existing?.tried || [], plan: null, step: null, result: null,
      progress: total > 0 ? Math.min(1, received / total) : null,
      receivedBytes: received, totalBytes: total,
    });
    if (!existing) this.items.set(item.id, rec);

    const ctl = new AbortController();
    this.transfers.set(item.id, ctl);
    rec.transferToken = ctl;
    this._emit();

    Promise.resolve(this._waitForTransfer(item.id, ctl.signal)).then((done) => {
      if (this.transfers.get(item.id) === ctl) this.transfers.delete(item.id);
      // Given up on already (failTransfer), or no longer ours.
      if (rec.transferToken !== ctl) { this._emit(); return; }
      rec.transferToken = null;
      if (this._getRecord(item.id) !== rec || rec.status === CANCELLED || rec.status === PAUSED) { this._emit(); return; }
      if (ctl.signal.aborted) {
        if (rec.status !== PAUSED && !rec._preempted) this._set(rec, CANCELLED, 'Cancelled');
        rec._preempted = false;
        return;
      }

      if (done && done.status === 'completed') {
        rec.result = { outcome: 'completed', savePath: done.savePath, file: done.file, bytes: done.bytes, service: done.service };
        rec.transferService = done.service || rec.transferService;
        rec.file = done.file;
        rec.savePath = done.savePath;
        rec.bytes = done.bytes;
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
  resume() { this._retryStopped = false; this.pool.resume(); this._emit(); }
  get paused() { return this.pool.paused; }
  get retryStopped() { return this._retryStopped; }
  setConcurrency(n) { this.pool.setConcurrency(n); this._emit(); }
  setServices(services) { this.services = [...services]; this._emit(); }

  /**
   * Preempt up to `count` currently running non-priority slots so newly prioritized
   * items can begin immediately without waiting for slow searches to finish.
   */
  _preemptSlots(count = 1, excludeIds = new Set()) {
    if (count <= 0 || this.pool._freeSlots.length > 0) return 0;
    const activeRuns = [...this.pool.active.values()].reverse();
    let preempted = 0;
    for (const run of activeRuns) {
      if (preempted >= count) break;
      if (excludeIds.has(run.item.id)) continue;
      const victimRec = this._getRecord(run.item.id);
      if (!victimRec) continue;
      victimRec._preempted = true;
      if (victimRec.step && victimRec.step.index != null) {
        victimRec.resumeIndex = victimRec.step.index;
      }
      victimRec.status = QUEUED;
      victimRec.statusText = 'Yielded slot to priority download — will resume next';
      // Place victim in queue right after the excluded priority items
      this.pool.queue = this.pool.queue.filter((it) => it.id !== run.item.id);
      let insertAt = 0;
      while (insertAt < this.pool.queue.length && excludeIds.has(this.pool.queue[insertAt].id)) {
        insertAt++;
      }
      this.pool.queue.splice(insertAt, 0, run.item);
      try { run.controller.abort(); } catch (e) { /* already settled */ }
      preempted++;
    }
    if (preempted) this._emit();
    return preempted;
  }

  /**
   * Casually pause a single item (whether queued, searching, ready, or downloading).
   * Frees its worker slot and transfer slot immediately so other items can proceed,
   * while remembering its place in the fallback chain for when it is resumed.
   */
  pauseItem(id) {
    const rec = this._getRecord(id);
    if (!rec || rec.status === COMPLETED || rec.status === PAUSED) return false;
    const targetId = rec.item.id;
    if (rec.step && rec.step.index != null) {
      rec.resumeIndex = rec.step.index;
    }
    rec._preempted = false;
    rec.status = PAUSED;
    rec.statusText = 'Paused';
    this.pool.cancel(targetId);
    this._abortTransfer(targetId);
    this._emit();
    return true;
  }

  /**
   * Resume or restart any paused, cancelled, skipped, or queued item.
   * If `now` is true, places it at the front of the queue and optionally preempts a busy slot.
   */
  resumeItem(id, { now = false, preempt = false } = {}) {
    const rec = this._getRecord(id);
    if (!rec || rec.status === COMPLETED) return false;
    const targetId = rec.item.id;
    if (rec.status === SKIPPED || rec.status === CANCELLED) {
      rec.retried = false;
      rec.tried = [];
      rec.plan = null;
      rec.step = null;
      rec.result = null;
      rec.resumeIndex = null;
      rec.progress = null;
      rec.receivedBytes = 0;
      rec.totalBytes = 0;
      rec.transferService = null;
      rec.attemptStartedAt = null;
      this.unhealthy.clear();
      this._unhealthyAt.clear();
    }
    rec._preempted = false;
    if (now) {
      rec.priority = true;
      rec.prioritizedAt = Date.now();
    }
    const alreadyActive = this.pool.active.has(targetId) || this.transfers.has(targetId);
    if (!alreadyActive) {
      rec.status = QUEUED;
      rec.statusText = now ? 'Prioritized — starting next' : 'Waiting in queue';
      if (now) {
        this.pool.submitFront([rec.item]);
        if (preempt) this._preemptSlots(1, new Set([targetId]));
      } else {
        this.pool.submit([rec.item]);
      }
    }
    this._retryStopped = false;
    this._emit();
    return true;
  }

  /**
   * Toggle an item between active/queued and paused/resumed.
   */
  toggleItem(id, opts = {}) {
    const rec = this._getRecord(id);
    if (!rec || rec.status === COMPLETED) return false;
    if (rec.status === PAUSED || rec.status === CANCELLED || rec.status === SKIPPED) {
      return this.resumeItem(id, opts);
    }
    return this.pauseItem(id);
  }

  /**
   * Prioritize an item ("Download Now" / "Move to Top").
   * Preempts a busy worker slot by default so the item starts immediately.
   */
  prioritize(id, { preempt = true } = {}) {
    const rec = this._getRecord(id);
    if (!rec || rec.status === COMPLETED) return false;
    const targetId = rec.item.id;
    rec.priority = true;
    rec.prioritizedAt = Date.now();

    // Also move visual position to top of its container
    this._moveVisualOrder(id, 'top');

    if (rec.status === PAUSED || rec.status === CANCELLED || rec.status === SKIPPED) {
      return this.resumeItem(id, { now: true, preempt });
    }
    if (rec.status === QUEUED) {
      rec.statusText = 'Prioritized — starting next';
      this.pool.submitFront([rec.item]);
      if (preempt) this._preemptSlots(1, new Set([targetId]));
      this._emit();
      return true;
    }
    this._emit();
    return true;
  }

  downloadNow(id) {
    return this.prioritize(id, { preempt: true });
  }

  _moveVisualOrder(id, target) {
    if (typeof id === 'string' && id.includes('::')) {
      const parts = id.split('::');
      const plId = parts[0];
      const key = parts[parts.length - 1];
      const pl = this.playlists.get(plId);
      if (pl && Array.isArray(pl.trackKeys)) {
        const idx = pl.trackKeys.indexOf(key);
        if (idx >= 0) {
          let nextIdx = idx;
          if (target === 'top' || target === 'front') nextIdx = 0;
          else if (target === 'bottom' || target === 'back') nextIdx = pl.trackKeys.length - 1;
          else if (target === 'up') nextIdx = Math.max(0, idx - 1);
          else if (target === 'down') nextIdx = Math.min(pl.trackKeys.length - 1, idx + 1);
          if (nextIdx !== idx) {
            const [k] = pl.trackKeys.splice(idx, 1);
            pl.trackKeys.splice(nextIdx, 0, k);
            return true;
          }
        }
      }
      return false;
    }
    const rec = this._getRecord(id);
    const itemId = rec?.item?.id || id;
    if (this.items.has(itemId)) {
      const entries = [...this.items.entries()];
      const idx = entries.findIndex(([k]) => k === itemId);
      if (idx < 0) return false;
      let nextIdx = idx;
      if (target === 'top' || target === 'front') nextIdx = 0;
      else if (target === 'bottom' || target === 'back') nextIdx = entries.length - 1;
      else if (target === 'up') nextIdx = Math.max(0, idx - 1);
      else if (target === 'down') nextIdx = Math.min(entries.length - 1, idx + 1);
      if (nextIdx === idx) return false;
      const [entry] = entries.splice(idx, 1);
      entries.splice(nextIdx, 0, entry);
      this.items = new Map(entries);
      return true;
    }
    return false;
  }

  /**
   * Move an item in the queue ('top' | 'up' | 'down' | 'bottom').
   */
  moveItem(id, direction = 'top') {
    const rec = this._getRecord(id);
    if (!rec) return false;
    const targetId = rec.item.id;
    const movedPool = this.pool.move(targetId, direction);
    const movedVisual = this._moveVisualOrder(id, direction);
    if (direction === 'top' || direction === 'front') {
      rec.priority = true;
      rec.prioritizedAt = Date.now();
    }
    if (movedPool || movedVisual) {
      this._emit();
      return true;
    }
    return false;
  }

  /**
   * Reorder `fromId` to the position of `toId` (drag-and-drop support).
   */
  reorderItem(fromId, toId) {
    const fromRec = this._getRecord(fromId);
    const toRec = this._getRecord(toId);
    if (!fromRec || !toRec || fromRec === toRec) return false;
    const fromTarget = fromRec.item.id;
    const toTarget = toRec.item.id;
    let changed = this.pool.reorder(fromTarget, toTarget);

    if (this.items.has(fromTarget) && this.items.has(toTarget)) {
      const entries = [...this.items.entries()];
      const fIdx = entries.findIndex(([k]) => k === fromTarget);
      const tIdx = entries.findIndex(([k]) => k === toTarget);
      if (fIdx >= 0 && tIdx >= 0 && fIdx !== tIdx) {
        const [entry] = entries.splice(fIdx, 1);
        entries.splice(tIdx, 0, entry);
        this.items = new Map(entries);
        changed = true;
      }
    } else if (typeof fromId === 'string' && fromId.includes('::') && typeof toId === 'string' && toId.includes('::')) {
      const fParts = fromId.split('::');
      const tParts = toId.split('::');
      if (fParts[0] === tParts[0]) {
        const pl = this.playlists.get(fParts[0]);
        if (pl && Array.isArray(pl.trackKeys)) {
          const fKey = fParts[fParts.length - 1];
          const tKey = tParts[tParts.length - 1];
          const fIdx = pl.trackKeys.indexOf(fKey);
          const tIdx = pl.trackKeys.indexOf(tKey);
          if (fIdx >= 0 && tIdx >= 0 && fIdx !== tIdx) {
            const [k] = pl.trackKeys.splice(fIdx, 1);
            pl.trackKeys.splice(tIdx, 0, k);
            changed = true;
          }
        }
      }
    }
    if (changed) this._emit();
    return changed;
  }

  _groupRecords(groupId) {
    if (this.playlists.has(groupId)) {
      const pl = this.playlists.get(groupId);
      return (pl?.trackKeys || []).map((k) => this.tracks.get(k)).filter(Boolean);
    }
    const out = [];
    for (const rec of this.items.values()) {
      const gid = rec.item.groupId || '__loose__';
      if (gid === groupId) out.push(rec);
    }
    return out;
  }

  /** Pause all active and queued tracks in a playlist/group. */
  pauseGroup(groupId) {
    const recs = this._groupRecords(groupId);
    let count = 0;
    for (const rec of recs) {
      if (rec.status === QUEUED || rec.status === SEARCHING || rec.status === READY || rec.status === DOWNLOADING) {
        const targetId = rec.item.id;
        if (rec.step && rec.step.index != null) rec.resumeIndex = rec.step.index;
        rec._preempted = false;
        rec.status = PAUSED;
        rec.statusText = 'Paused';
        this.pool.cancel(targetId);
        this._abortTransfer(targetId);
        count++;
      }
    }
    if (count) this._emit();
    return count;
  }

  /** Resume all paused (or cancelled/skipped) tracks in a playlist/group. */
  resumeGroup(groupId, { now = false, preempt = false } = {}) {
    const recs = this._groupRecords(groupId);
    const hasPaused = recs.some((r) => r.status === PAUSED);
    const toResume = [];
    for (const rec of recs) {
      if (rec.status === PAUSED || (!hasPaused && (rec.status === CANCELLED || rec.status === SKIPPED))) {
        if (rec.status === SKIPPED || rec.status === CANCELLED) {
          rec.retried = false;
          rec.tried = [];
          rec.plan = null;
          rec.step = null;
          rec.result = null;
          rec.resumeIndex = null;
          rec.progress = null;
          rec.receivedBytes = 0;
          rec.totalBytes = 0;
          rec.transferService = null;
          rec.attemptStartedAt = null;
        }
        rec._preempted = false;
        rec.status = QUEUED;
        rec.statusText = now ? 'Prioritized — starting next' : 'Waiting in queue';
        if (now) {
          rec.priority = true;
          rec.prioritizedAt = Date.now();
        }
        toResume.push(rec.item);
      }
    }
    if (toResume.length) {
      this._retryStopped = false;
      if (now) {
        this.pool.submitFront(toResume);
        if (preempt) this._preemptSlots(Math.min(toResume.length, this.pool.concurrency), new Set(toResume.map((i) => i.id)));
      } else {
        this.pool.submit(toResume);
      }
      this._emit();
    }
    return toResume.length;
  }

  /** Prioritize an entire playlist/group to the front of the queue. */
  prioritizeGroup(groupId, { preempt = true } = {}) {
    const recs = this._groupRecords(groupId);
    const items = [];
    for (const rec of recs) {
      if (rec.status === COMPLETED) continue;
      if (rec.status === PAUSED || rec.status === CANCELLED || rec.status === SKIPPED) {
        if (rec.status !== PAUSED) {
          rec.tried = [];
          rec.plan = null;
          rec.step = null;
          rec.result = null;
          rec.resumeIndex = null;
        }
        rec.status = QUEUED;
      }
      if (rec.status === QUEUED) {
        rec.priority = true;
        rec.prioritizedAt = Date.now();
        rec.statusText = 'Prioritized — starting next';
        items.push(rec.item);
      }
    }
    if (items.length) {
      this.pool.submitFront(items);
      if (preempt) this._preemptSlots(Math.min(items.length, this.pool.concurrency), new Set(items.map((i) => i.id)));
      this._emit();
    }
    return items.length;
  }

  /** Pause all playlists in a profile. */
  pauseProfile(profileId) {
    let count = 0;
    for (const [plId, pl] of this.playlists.entries()) {
      if (pl.profileId === profileId) count += this.pauseGroup(plId);
    }
    return count;
  }

  /** Resume all playlists in a profile. */
  resumeProfile(profileId, opts = {}) {
    let count = 0;
    for (const [plId, pl] of this.playlists.entries()) {
      if (pl.profileId === profileId) count += this.resumeGroup(plId, opts);
    }
    return count;
  }

  cancel(id) {
    const rec = this._getRecord(id);
    const targetId = rec?.item?.id || id;
    if (rec) rec._preempted = false;
    this.pool.cancel(targetId);
    this._abortTransfer(targetId);
    if (rec && !this._isTerminal(rec.status)) this._set(rec, CANCELLED, 'Cancelled');
    return !!rec;
  }

  cancelAll() {
    this._retryStopped = true;
    this._clearRetry();
    this.pool.cancelAll();
    const allRecords = [...this.items.values(), ...this.tracks.values()];
    for (const rec of allRecords) {
      if (!this._isTerminal(rec.status)) {
        rec._preempted = false;
        this._abortTransfer(rec.item.id);
        rec.status = CANCELLED;
        rec.statusText = 'Cancelled';
      }
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
      // Check if derived playlist item: plId::index::key
      if (typeof id === 'string' && id.includes('::')) {
        const parts = id.split('::');
        const plId = parts[0];
        const idx = Number(parts[1]);
        const key = parts[parts.length - 1];
        const pl = this.playlists.get(plId);
        if (pl && Array.isArray(pl.trackKeys)) {
          if (!Number.isNaN(idx) && idx >= 0 && idx < pl.trackKeys.length) {
            pl.trackKeys.splice(idx, 1);
          } else {
            const kIdx = pl.trackKeys.indexOf(key);
            if (kIdx !== -1) pl.trackKeys.splice(kIdx, 1);
          }
          // Check refcount across remaining playlists
          let refcount = 0;
          for (const otherPl of this.playlists.values()) {
            if (otherPl.trackKeys?.includes(key)) refcount++;
          }
          if (refcount === 0) {
            const trackRec = this.tracks.get(key);
            if (trackRec && !this._isTerminal(trackRec.status)) {
              this.pool.cancel(key);
              this._abortTransfer(key);
            }
            this.tracks.delete(key);
          }
          removed++;
          continue;
        }
      }

      if (this.tracks.has(id)) {
        const rec = this.tracks.get(id);
        if (!this._isTerminal(rec.status)) {
          this.pool.cancel(id);
          this._abortTransfer(id);
        }
        this.tracks.delete(id);
        removed++;
        continue;
      }

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
    if (this.playlists.has(groupId)) {
      const removedPl = this.playlists.get(groupId);
      this.playlists.delete(groupId);
      const remainingKeys = new Set();
      for (const pl of this.playlists.values()) {
        for (const k of pl.trackKeys || []) {
          remainingKeys.add(k);
        }
      }
      for (const key of (removedPl.trackKeys || [])) {
        if (!remainingKeys.has(key)) {
          const trackRec = this.tracks.get(key);
          if (trackRec) {
            if (!this._isTerminal(trackRec.status)) {
              this.pool.cancel(key);
              this._abortTransfer(key);
            }
            this.tracks.delete(key);
          }
        }
      }
      this._emit();
      return (removedPl.trackKeys || []).length;
    }
    const ids = [];
    for (const rec of this.items.values()) {
      const gid = rec.item.groupId || '__loose__';
      if (gid === groupId) ids.push(rec.item.id);
    }
    return this.remove(ids);
  }

  removeProfile(profileId) {
    const removedKeys = new Set();
    let removed = 0, changed = this.profiles.delete(profileId);
    for (const [id, pl] of this.playlists) {
      if (pl.profileId !== profileId) continue;
      this.playlists.delete(id);
      changed = true;
      removed += (pl.trackKeys || []).length;
      for (const key of pl.trackKeys || []) removedKeys.add(key);
    }
    const remaining = new Set([...this.playlists.values()].flatMap(pl => pl.trackKeys || []));
    for (const key of removedKeys) {
      if (remaining.has(key)) continue;
      const rec = this.tracks.get(key);
      if (rec && !this._isTerminal(rec.status)) { this.pool.cancel(key); this._abortTransfer(key); }
      this.tracks.delete(key);
    }
    const looseIds = [...this.items.values()].filter(rec => rec.item.profileId === profileId).map(rec => rec.item.id);
    // remove() emits once for all loose tracks; otherwise emit once here.
    removed += this.remove(looseIds);
    if (changed && !looseIds.length) this._emit();
    return removed;
  }

  markServiceUnhealthy(service) {
    if (!service) return;
    this.unhealthy.add(service);
    this._unhealthyAt.set(service, Date.now());
  }

  markServiceHealthy(service) {
    if (!service) return;
    this.unhealthy.delete(service);
    this._unhealthyAt.delete(service);
  }

  /** The skip set, with anything past its TTL given another chance. */
  _skipSet() {
    if (this.unhealthy.size && this.unhealthyTtlMs > 0) {
      const now = Date.now();
      for (const [service, at] of this._unhealthyAt) {
        if (now - at >= this.unhealthyTtlMs) this.markServiceHealthy(service);
      }
    }
    return this.unhealthy;
  }

  // ---- transfer state ------------------------------------------------------
  //
  // The chain loop cannot report these: between the click and the finished file
  // it is simply awaiting one promise. The bytes are announced separately by
  // the main process, so they are pushed in from the outside.

  noteDownloadStarted(id, service) {
    const rec = this._getRecord(id);
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
    const rec = this._getRecord(id);
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
      this._emit(); // a status change is structural; everything re-renders once for it
      return;
    }
    // Bytes alone: only the views that draw them are listening.
    this._emitProgress();
  }

  /**
   * Give every skipped track one more pass through the whole chain. A store
   * that answered "uh-oh" all afternoon, or a stream backend that was down, may
   * well answer now - so a skip is not necessarily permanent.
   */
  retrySkipped(opts = {}) {
    // `force` is the user asking a second time. The once-only flag exists to
    // stop an AUTOMATIC retry loop, not to refuse a deliberate request - and a
    // button that silently does nothing on its second press is worse than
    // either. The unhealthy set is cleared with it: the usual reason for asking
    // again is that whatever was down has come back.
    const force = !!opts.force;
    this._retryStopped = false;
    this._clearRetry();
    if (force) {
      this.unhealthy.clear();
      this._unhealthyAt.clear();
    }
    const again = [];
    const allRecords = [...this.items.values(), ...this.tracks.values()];
    for (const rec of allRecords) {
      if (rec.status !== SKIPPED || (rec.retried && !force)) continue;
      rec.retried = true;
      rec.tried = [];
      rec.plan = null;
      rec.step = null;
      rec.result = null;
      rec.resumeIndex = null;
      rec.progress = null;
      rec.receivedBytes = 0;
      rec.totalBytes = 0;
      rec.transferService = null;
      rec.attemptStartedAt = null;
      rec.status = QUEUED;
      rec.statusText = 'Queued for one more try';
      again.push(rec.item);
    }
    if (again.length) { this._emit(); this.pool.submit(again); }
    return again.length;
  }

  // ---- transfers off the pool ----------------------------------------------

  _waitForTransfer(id, signal) {
    if (!this.awaitTransfer) return Promise.resolve(null);
    try { return Promise.resolve(this.awaitTransfer(id, signal)).catch(() => null); }
    catch { return Promise.resolve(null); }
  }

  /**
   * Give up on a transfer we are following without cancelling the track: the
   * resume could not be started at all, so the track goes back through the
   * ordinary chain. Distinct from cancel(), which is the user's decision.
   */
  failTransfer(id, reason) {
    const rec = this._getRecord(id);
    if (!rec || !rec.transferToken) return false;
    const ctl = rec.transferToken;
    rec.transferToken = null;
    if (this.transfers.get(id) === ctl) this.transfers.delete(id);
    ctl.abort(); // release the old waiter's timer and abort listener before retrying
    if (this._isTerminal(rec.status)) return false;
    this.log('transfer.gave-up', { id, name: rec.item.name, reason: reason || null });
    this._set(rec, QUEUED, 'Could not pick that download up - starting it again');
    this.pool.submit([rec.item]);
    return true;
  }

  _abortTransfer(id) {
    const rec = this._getRecord(id);
    if (rec) rec.transferToken = null;
    const ctl = this.transfers.get(id);
    if (ctl) {
      this.transfers.delete(id);
      try { ctl.abort(); } catch (e) { /* already settled */ }
    }
    if (this.cancelTransfer) { try { this.cancelTransfer(id); } catch (e) { /* best effort */ } }
  }

  /**
   * Follow a file that is already moving, with no slot held. A transfer that
   * fails has to re-enter the chain where it left off - the whole point of the
   * chain is that a source failing is not the end of the track - so the item
   * goes back to the FRONT of the queue with its plan and its resume point
   * intact, rather than behind two hundred tracks it was already ahead of.
   */
  _detachTransfer(rec, item, step, ctl = new AbortController(), completion = null) {
    this.transfers.set(item.id, ctl);
    rec.transferToken = ctl;
    this._emit();

    Promise.resolve(completion || this._waitForTransfer(item.id, ctl.signal)).then((done) => {
      if (this.transfers.get(item.id) === ctl) this.transfers.delete(item.id);
      if (rec.transferToken !== ctl) { this._emit(); return; }
      rec.transferToken = null;
      // Removed, cancelled or otherwise no longer ours while the bytes moved.
      if (this._getRecord(item.id) !== rec || rec.status === CANCELLED || rec.status === PAUSED) { this._emit(); return; }
      if (ctl.signal.aborted) {
        if (rec.status !== PAUSED && !rec._preempted) this._set(rec, CANCELLED, 'Cancelled');
        rec._preempted = false;
        return;
      }

      const res = transferResult(done);
      rec.tried.push({
        service: step.service, outcome: res.outcome,
        label: res.label || null, message: res.message || null,
        httpStatus: res.httpStatus || null, retryAt: res.retryAt || null,
        at: new Date().toISOString(),
      });

      if (res.outcome === 'completed') {
        rec.result = res;
        rec.file = res.file || rec.file;
        rec.savePath = res.savePath || rec.savePath;
        rec.bytes = res.bytes || rec.bytes;
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

  _transferRoom(signal) {
    let finish;
    const promise = new Promise(resolve => {
      let off = () => {};
      const abort = () => finish(false);
      finish = open => { off(); signal?.removeEventListener('abort', abort); resolve(open); };
      const check = () => {
        if (signal?.aborted) finish(false);
        else if (this.transfers.size < this.maxTransfers) finish(true);
      };
      off = this.subscribe(check);
      signal?.addEventListener('abort', abort, { once: true });
      check();
    });
    return { promise, cancel: () => finish(false) };
  }

  async _waitOrDetach(rec, item, step, signal) {
    const ctl = new AbortController();
    const abort = () => ctl.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const completion = this._waitForTransfer(item.id, ctl.signal);
    try {
      for (;;) {
        const room = this._transferRoom(ctl.signal);
        let result;
        try {
          result = await Promise.race([
            completion.then(done => ({ done })),
            room.promise.then(open => ({ open })),
          ]);
        } finally { room.cancel(); }
        if ('done' in result) return result;
        if (!result.open || ctl.signal.aborted) return { done: null };
        // Several workers may wake for one vacancy. Claim it synchronously.
        if (this.transfers.size < this.maxTransfers) {
          this._detachTransfer(rec, item, step, ctl, completion);
          return { detached: true };
        }
      }
    } finally { signal?.removeEventListener('abort', abort); }
  }

  // ---- the chain -----------------------------------------------------------

  async _runChain(item, slot, signal) {
    const rec = this._getRecord(item.id);
    if (!rec || rec.status === CANCELLED || rec.status === PAUSED) return;

    const services = [...new Set(this.services)];

    // A track that comes back after a failed transfer resumes its chain rather
    // than restarting it: the sources it already exhausted are still exhausted.
    if (rec.plan && rec.resumeIndex != null) {
      const from = rec.resumeIndex;
      rec.resumeIndex = null;
      return this._walkChain(rec, item, slot, signal, from);
    }

    if (this.checkExisting) {
      const existing = await Promise.resolve(this.checkExisting(item)).catch(() => null);
      if (signal?.aborted || this._getRecord(item.id) !== rec) {
        if (rec._preempted) { rec._preempted = false; return; }
        if (this._getRecord(item.id) === rec && rec.status !== PAUSED) this._set(rec, CANCELLED, 'Cancelled');
        return;
      }
      if (existing && existing.done) {
        rec.transferService = existing.service || rec.transferService || null;
        rec.file = existing.file || rec.file || null;
        rec.savePath = existing.savePath || rec.savePath || null;
        rec.bytes = existing.bytes || rec.bytes || null;
        rec.receivedBytes = rec.bytes || 0;
        rec.totalBytes = rec.bytes || 0;
        rec.progress = 1;
        rec.result = {
          outcome: 'completed',
          file: rec.file,
          savePath: rec.savePath,
          bytes: rec.bytes,
          service: rec.transferService,
        };
        this.log('done', { id: item.id, name: item.name, via: existing.via || 'existing' });
        this._set(rec, COMPLETED, 'Downloaded');
        return;
      }
    }

    rec.plan = buildPlan({
      variants: item.searchVariants,
      services,
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
      if (signal && signal.aborted) {
        if (rec._preempted) { rec._preempted = false; return; }
        if (rec.status !== PAUSED) this._set(rec, CANCELLED, 'Cancelled');
        return;
      }

      const step = nextAttempt(rec.plan, { index, skip: this._skipSet() });
      if (!step) {
        const why = describeAbandon(rec.tried);
        this.log('skip', { id: item.id, name: item.name, reason: why, tried: rec.tried });
        this._set(rec, SKIPPED, why);
        return;
      }

      // Re-check settings for existing plans, including resumed transfers.
      const enabled = step.service === 'jamendo'
        ? this.planOptions.jamendo === true
        : this.services.includes(step.service);
      if (!enabled || ['youtube', 'soundcloud', 'direct'].includes(step.source)
          || ['youtube', 'soundcloud'].includes(step.service)) {
        index = step.index + 1;
        continue;
      }

      rec.step = step;
      // When THIS attempt began, not the track's - so the UI can show how long
      // the current source has been sitting on it, which is the number that
      // tells a stuck-looking wait apart from a merely slow one.
      rec.attemptStartedAt = Date.now();
      this._set(rec, SEARCHING, describeStep(step, rec.plan));

      let res;
      try {
        res = await this.getWorker(slot).run(item, step, signal);
      } catch (err) {
        if (err && err.name === 'Aborted') {
          if (rec._preempted) { rec._preempted = false; return; }
          if (rec.status !== PAUSED) this._set(rec, CANCELLED, 'Cancelled');
          return;
        }
        res = { outcome: 'error', message: err && err.message };
      }

      if (signal?.aborted || this._getRecord(item.id) !== rec) {
        if (rec._preempted) { rec._preempted = false; return; }
        if (this._getRecord(item.id) === rec && rec.status !== PAUSED) this._set(rec, CANCELLED, 'Cancelled');
        return;
      }

      // The transfer has begun and the view is free. Either let go of the slot
      // and follow the file from outside the pool, or - if enough transfers are
      // already detached - stay here and wait for it, which is what keeps the
      // queue from running arbitrarily far ahead of the network.
      if (res.outcome === 'transferring') {
        this._markReady(rec, step.service);
        if (this.awaitTransfer && this.transfers.size < this.maxTransfers) {
          this._detachTransfer(rec, item, step);
          return;
        }
        // Any detached file completing can free this view. Waiting only for
        // this track's file held every slot behind the slowest transfers.
        const waiting = this.awaitTransfer && this.maxTransfers > 0
          ? await this._waitOrDetach(rec, item, step, signal)
          : { done: await this._waitForTransfer(item.id, signal) };
        if (waiting.detached) return;
        const done = waiting.done;
        if (signal?.aborted || this._getRecord(item.id) !== rec) {
          if (rec._preempted) { rec._preempted = false; return; }
          if (this._getRecord(item.id) === rec && rec.status !== PAUSED) this._set(rec, CANCELLED, 'Cancelled');
          return;
        }
        res = transferResult(done);
      }

      rec.tried.push({
        service: step.service, outcome: res.outcome,
        label: res.label || null, message: res.message || null,
        at: new Date().toISOString(),
        httpStatus: res.httpStatus || null, retryAt: res.retryAt || null,
      });

      // What this attempt says about the STORE, as opposed to the track. Only
      // the outcomes that mean "this source could not be asked" retire it; a
      // confident "we do not have that" is the store working correctly and
      // must not take it out of the chain for everything behind this track.
      if (res.outcome === 'access-blocked') {
        for (const service of this.services) {
          if ((service === 'monochrome') === (step.source === 'monochrome')) this.markServiceUnhealthy(service);
        }
      } else if (UNAVAILABLE_OUTCOMES.has(res.outcome)) {
        this.markServiceUnhealthy(step.service);
        this.log('service.unhealthy', { service: step.service, outcome: res.outcome });
      } else {
        this.markServiceHealthy(step.service);
      }

      if (res.outcome === 'completed') {
        rec.result = res;
        rec.file = res.file || rec.file;
        rec.savePath = res.savePath || rec.savePath;
        rec.bytes = res.bytes || rec.bytes;
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
