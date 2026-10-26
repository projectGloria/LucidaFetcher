// Boots the engine inside the Electron renderer and hands back a controller.
//
// Kept separate from renderer.js so the wiring is one import and a handful of
// call sites rather than surgery spread through a 3,600-line file, and so the
// same controller can be handed to the React view layer later without changing
// anything on this side.

import { Controller } from './controller.mjs';
import { Worker } from './worker.mjs';
import { viewAdapter, ipcAdapter, DownloadTracker, ensureWorkerViews } from './electron-bridge.mjs';
import { collectProfiles, reportPayload, profileSignature } from './profile-report.mjs';
import { assignPlaylistFiles } from './profile-paths.mjs';
import { buildSearchVariants } from './variants.mjs';
import { SourceAccess, normalizeApiUrl } from './source-access.mjs';
import { describeStep } from './status.mjs';

export const DEFAULT_CONCURRENCY = 3;
// How many finished-searching tracks may be in flight without holding a
// webview - the fetch-ahead depth.
//
// Two batches of detached files give searches headroom while transfers drain.
// When this limit is reached, the controller frees a waiting view as soon as
// ANY detached file finishes; a slower file no longer blocks its own view until
// completion when another transfer has already made room.
//
// Not unbounded, for two reasons: the queue would otherwise race arbitrarily
// far ahead of the network, and every extra simultaneous transfer is one more
// share of the same bandwidth and one more request the scraper sites can decide
// to rate-limit.
export const DEFAULT_MAX_TRANSFERS = 6;

/**
 * @param opts {
 *   ipcRenderer
 *   container: Element        where worker webviews are appended
 *   services: string[]        the Lucida store chain
 *   concurrency?: number
 *   log?: (evt, data) => void
 *   onChange?: (controller) => void
 *   onDownloadStart?: (itemId, payload) => void
 *   pipeline?: boolean        free a worker at transfer start (default on)
 *   maxTransfers?: number     transfers allowed to run detached from a slot
 * }
 */
export function startEngine(opts) {
  const {
    ipcRenderer, container, services, log = () => {},
    concurrency = DEFAULT_CONCURRENCY, onChange, onDownloadStart, planOptions = {},
    pipeline = true, maxTransfers = DEFAULT_MAX_TRANSFERS, keepTrying = false,
  } = opts;

  const tracker = new DownloadTracker(ipcRenderer);
  const ipc = ipcAdapter(ipcRenderer, tracker);
  let monochromeApiUrl = '';
  try { monochromeApiUrl = normalizeApiUrl(opts.monochromeApiUrl); }
  catch (error) { log('source.config.error', { message: error.message }); }
  const access = new SourceAccess({ regions: opts.sourceRegions, cooldowns: opts.sourceCooldowns,
    onChange: patch => ipcRenderer.send('set-config', patch) });
  const accessDeps = { access, getMonochromeApiUrl: () => monochromeApiUrl,
    onWait: (itemId, step, ms, limited) => {
      const rec = controller.getItem(itemId);
      if (!rec || rec.status !== 'searching') return;
      rec.statusText = ms == null ? 'Waiting for a source browser'
        : limited ? `Source rate limit — retrying in ${Math.ceil(ms / 1000)}s` : describeStep(step, rec.plan);
      controller._emit();
    } };

  // One webview per slot, created up front. Building them lazily would put a
  // page load on the critical path of the first download in each slot.
  const views = ensureWorkerViews(container, concurrency);
  const workers = views.map((view, slot) => new Worker({
    slot, view: viewAdapter(view), ipc, log, pipeline, ...accessDeps,
  }));

  const controller = new Controller({
    getWorker: (slot) => workers[slot],
    services,
    concurrency,
    log,
    planOptions,
    maxTransfers: pipeline ? maxTransfers : 0,
    keepTrying,
    awaitTransfer: (itemId, signal) => tracker.await(itemId, signal),
    cancelTransfer: (itemId) => ipc.cancelDownload(itemId),
    checkExisting: typeof ipcRenderer.invoke === 'function'
      ? (item) => ipcRenderer.invoke('downloads-check', [{
        key: item.key, folderName: item.folderName, title: item.title,
        artist: item.artist, durationSec: item.durationSec, isrc: item.isrc,
      }], { scan: true }).then((res) => res?.[0] || null).catch(() => null)
      : null,
  });
  controller.setMonochromeApiUrl = value => { monochromeApiUrl = normalizeApiUrl(value); };

  controller.recheckExisting = async () => {
    if (controller.restoring || typeof ipcRenderer.invoke !== 'function') return 0;
    const pending = [
      ...[...controller.items.values()].filter((r) => r.status !== 'completed' && r.status !== 'cancelled'),
      ...[...controller.tracks.values()].filter((r) => r.status !== 'completed' && r.status !== 'cancelled'),
    ];
    if (!pending.length) return 0;
    const checks = await ipcRenderer.invoke('downloads-check', pending.map((r) => ({
      key: r.item.key, folderName: r.item.folderName, title: r.item.title,
      artist: r.item.artist, durationSec: r.item.durationSec, isrc: r.item.isrc,
    })), { scan: true }).catch(() => []) || [];
    let found = 0;
    pending.forEach((rec, i) => {
      const hit = checks[i];
      if (!hit || !hit.done || rec.status === 'completed' || rec.status === 'cancelled') return;
      found++;
      const targetId = rec.item.id;
      controller.pool.cancel(targetId);
      controller._abortTransfer(targetId);
      rec.transferService = hit.service || rec.transferService || null;
      rec.file = hit.file || rec.file || null;
      rec.savePath = hit.savePath || rec.savePath || null;
      rec.bytes = hit.bytes || rec.bytes || null;
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
      rec.status = 'completed';
      rec.statusText = 'Downloaded';
    });
    if (found) controller._emit();
    return found;
  };

  // Transfer state comes from the main process, not from the chain loop - which
  // between the click and the finished file is just awaiting one promise.
  tracker.onStarted = (itemId, payload) => {
    controller.noteDownloadStarted(itemId, payload && payload.service);
    if (onDownloadStart) onDownloadStart(itemId, payload);
  };
  tracker.onProgress = (itemId, received, total) => controller.noteProgress(itemId, received, total);
  const basePause = controller.pause.bind(controller);
  const baseResume = controller.resume.bind(controller);
  controller.pause = () => { ipcRenderer.send('downloads-pause'); basePause(); };
  controller.resume = () => { ipcRenderer.send('downloads-resume'); baseResume(); };

  // The folder's record of what it is missing, and why. The main process writes
  // the "downloaded" half itself when a file lands, but only the renderer knows
  // that a track ran out of sources - and this file is the only thing about a
  // failed track that survives the app closing.
  const cleanups = [];
  const reported = new Map();
  cleanups.push(controller.subscribe(() => {
    if (controller.restoring) return;
    for (const id of reported.keys()) if (!controller.getItem(id)) reported.delete(id);
    for (const rec of controller.getItems()) {
      if (rec.status !== 'skipped' || reported.get(rec.item.id) === rec.tried) continue;
      reported.set(rec.item.id, rec.tried);
      ipcRenderer.send('report-track', {
        section: 'missing',
        folderName: rec.item.folderName,
        entry: {
          title: rec.item.title,
          artist: rec.item.artist,
          group: rec.item.groupName || null,
          searchQuery: rec.item.searchQuery || null,
          reason: rec.statusText,
          tried: rec.tried,
        },
      });
    }
  }));

  // The other half of that record, one level up: when every track a profile
  // queued has reached a terminal state, write the summary of the whole run
  // into the user's folder. Keyed by the outcome and not just by the profile,
  // so retrying the missing tracks rewrites it rather than leaving the first,
  // now-wrong answer on disk.
  const profileSigs = new Map();
  cleanups.push(controller.subscribe(() => {
    if (controller.restoring) return;
    const profiles = collectProfiles(controller.getItems());
    const ids = new Set(profiles.map(group => group.id));
    for (const id of profileSigs.keys()) if (!ids.has(id)) profileSigs.delete(id);
    for (const group of profiles) {
      if (!group.done || !group.folderName) continue;
      const sig = profileSignature(group);
      if (profileSigs.get(group.id) === sig) continue;
      profileSigs.set(group.id, sig);
      ipcRenderer.send('profile-report', reportPayload(group));
      log('profile.done', {
        profile: group.profile && group.profile.user,
        playlists: group.playlists.length,
        downloaded: group.downloadedCount,
        missing: group.missingCount,
      });
    }
  }));

  // Profile library manifest (library.json) and .m3u8 playlists:
  // Synchronized whenever a track completes or changes state.
  let librarySyncTimer = null;
  const librarySignatures = new Map();
  const folderArtwork = new Map();
  cleanups.push(controller.subscribe(() => {
    if (controller.restoring) return;
    for (const rec of controller.items.values()) {
      const { folderName, groupArtwork } = rec.item;
      if (!folderName || !groupArtwork || folderArtwork.get(folderName) === groupArtwork) continue;
      folderArtwork.set(folderName, groupArtwork);
      ipcRenderer.send?.('playlist-artwork-sync', { folderName, url: groupArtwork });
    }
  }));
  const syncLibraries = () => {
    if (controller.restoring || !controller.profiles || !controller.profiles.size) return;
    for (const prof of controller.profiles.values()) {
      if (!prof.folderName) continue;
      const profPlaylists = [];
      for (const pl of controller.playlists.values()) {
        if (pl.profileId === prof.id) {
          const folder = pl.folder || pl.file || String(pl.name || 'Playlist').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').trim();
          profPlaylists.push({
            id: pl.id,
            name: pl.name,
            artwork: pl.artwork || null,
            folder,
            file: folder,
            trackKeys: pl.trackKeys || [],
          });
        }
      }

      const profTracks = {};
      const members = new Set(profPlaylists.flatMap(pl => pl.trackKeys));
      for (const [key, track] of controller.tracks.entries()) {
        if (members.has(key)) {
          const ownerPl = controller.playlists.get(track.firstPlaylistId)
            || profPlaylists.find(pl => (pl.trackKeys || []).includes(key))
            || profPlaylists[0];
          const ownerFolder = ownerPl?.folder || ownerPl?.file || 'Playlist';
          const baseFile = track.file ? String(track.file).replace(/\\/g, '/').replace(/^Tracks\/+/i, '').split('/').pop() : null;
          profTracks[key] = {
            title: track.item.title,
            artist: track.item.artist,
            durationSec: track.item.durationSec,
            image: track.item.image || null,
            artworkPending: !!track.item.artworkPending,
            service: track.item.service || null,
            downloadService: track.transferService || track.result?.service || null,
            trackId: track.item.trackId || null,
            isrc: track.item.isrc || null,
            file: baseFile ? `${ownerFolder}/${baseFile}` : null,
            savePath: track.savePath || track.result?.savePath || null,
            sourceFolder: track.item.profileFolder || controller.profiles.get(track.item.profileId)?.folderName || null,
            bytes: track.bytes || null,
            status: track.status === 'completed' ? 'downloaded' : track.status === 'skipped' ? 'failed' : track.status === 'cancelled' ? 'cancelled' : 'pending',
          };
        }
      }

      const state = {
        version: 1,
        profile: {
          id: prof.id,
          name: prof.name || prof.user,
          user: prof.user,
          service: prof.service,
          image: prof.image || null,
        },
        tracks: profTracks,
        playlists: profPlaylists,
      };

      const signature = JSON.stringify(state);
      if (librarySignatures.get(prof.id) === signature) continue;
      librarySignatures.set(prof.id, signature);
      state.profile.updatedAt = new Date().toISOString();

      ipcRenderer.send?.('profile-library-sync', {
        folderName: prof.folderName,
        state,
      });
    }
  };
  const flushLibraries = () => {
    if (librarySyncTimer) { clearTimeout(librarySyncTimer); librarySyncTimer = null; }
    syncLibraries();
  };
  ipcRenderer.on?.('flush-state', flushLibraries);
  cleanups.push(() => ipcRenderer.removeListener?.('flush-state', flushLibraries));

  cleanups.push(() => {
    if (librarySyncTimer) {
      clearTimeout(librarySyncTimer);
      librarySyncTimer = null;
      syncLibraries();
    }
  });

  cleanups.push(controller.subscribe(() => {
    if (!controller.restoring && controller.profiles?.size) {
      if (librarySyncTimer) return;
      librarySyncTimer = setTimeout(() => {
        librarySyncTimer = null;
        syncLibraries();
      }, 250);
    }
  }));

  if (onChange) cleanups.push(controller.subscribe(() => onChange(controller)));

  // Growing the pool needs more webviews; shrinking leaves the extra ones
  // parked rather than destroying a view a slot may still be finishing in.
  const baseSetConcurrency = controller.setConcurrency.bind(controller);
  controller.setConcurrency = (n) => {
    const want = Math.max(1, n | 0);
    const all = ensureWorkerViews(container, Math.max(want, workers.length));
    for (let i = workers.length; i < want; i++) {
      workers[i] = new Worker({ slot: i, view: viewAdapter(all[i]), ipc, log, pipeline, ...accessDeps });
    }
    baseSetConcurrency(want);
  };

  cleanups.push(attachPersistence(controller, ipcRenderer, log));
  const baseDispose = controller.dispose.bind(controller);
  controller.dispose = () => {
    cleanups.forEach(cleanup => cleanup());
    baseDispose();
    tracker.dispose();
    for (const view of container.querySelectorAll('webview.worker-view')) view.remove();
  };

  controller.tracker = tracker;
  controller.workers = workers;
  return controller;
}

const PERSIST_MAX_WAIT_MS = 1500;

/**
 * Keep state/queue.json in step with the queue, and offer what it holds back on
 * the next launch.
 *
 * Completed profile tracks retain their canonical records and memberships.
 * Completed loose tracks are already recorded in the download manifest.
 * Skipped tracks ARE written, flagged, so they can be shown as missing without
 * being retried on every start - a skip means the whole chain was exhausted, and
 * paying that cost again on every launch to reach the same answer is what the
 * flag exists to prevent.
 */
export function attachPersistence(controller, ipcRenderer, log = () => {}) {
  let timer = null;
  let lastSaveAt = 0;

  const serialize = r => ({
    ...r.item,
    transferService: r.transferService || r.step?.service || r.item.transferService || null,
    status: r.status, statusText: r.statusText, tried: r.tried,
    file: r.file || r.result?.file || null, savePath: r.savePath || r.result?.savePath || null,
    bytes: r.bytes || r.result?.bytes || null, firstPlaylistId: r.firstPlaylistId,
    skippedInEarlierRun: r.status === 'skipped',
  });
  const snapshot = () => ({
    v: 4,
    at: Date.now(),
    paused: controller.paused,
    items: [...controller.items.values()]
      .filter((r) => r.status !== 'completed' && r.status !== 'cancelled')
      .map(serialize),
    profiles: [...controller.profiles.values()],
    playlists: [...controller.playlists.values()],
    tracks: [...controller.tracks.values()].map(serialize),
  });

  const save = () => {
    if (controller.restoring) return;
    lastSaveAt = Date.now();
    const snap = snapshot();
    if (snap.items.length || snap.playlists.length) ipcRenderer.send('queue-save', snap);
    else ipcRenderer.send('queue-clear'); // nothing outstanding: do not replay an empty run
  };

  // A trailing debounce starves here. Status transitions arrive every few
  // seconds across a long run, and each one used to push the 1.5s write further
  // out - so queue.json froze at the last quiet moment, and the quit flush in
  // main had nothing to flush: a crash took every change since the run started
  // with it. So this is a throttle: the FIRST change schedules a write that runs
  // no matter what arrives afterwards, and every write reads the latest state -
  // changes are coalesced, never dropped. Steady activity costs one write per
  // window; a quiet queue costs one write, just later.
  const unsubscribe = controller.subscribe(() => {
    if (controller.restoring) return;
    if (timer) return;
    const wait = Math.max(0, PERSIST_MAX_WAIT_MS - (Date.now() - lastSaveAt));
    timer = setTimeout(() => { timer = null; save(); }, wait);
  });

  // Removal is a structural change: save it immediately through both debounce
  // layers so closing the app cannot bring the deleted playlist back.
  const saveRemoval = () => {
    for (const id of controller.profiles.keys()) {
      if (![...controller.playlists.values()].some(pl => pl.profileId === id)) controller.profiles.delete(id);
    }
    clearTimeout(timer);
    timer = null;
    lastSaveAt = Date.now();
    const snap = snapshot();
    if (snap.items.length || snap.playlists.length) ipcRenderer.send('queue-save', snap, true);
    else ipcRenderer.send('queue-clear');
  };
  let removalDepth = 0;
  for (const method of ['remove', 'removeGroup', 'removeProfile']) {
    if (typeof controller[method] !== 'function') continue;
    const baseRemove = controller[method].bind(controller);
    controller[method] = ids => {
      removalDepth++;
      try {
        const before = controller.getSnapshot();
        const count = baseRemove(ids);
        if ((count || controller.getSnapshot() !== before) && removalDepth === 1) saveRemoval();
        return count;
      } finally { removalDepth--; }
    };
  }

  // The quit handshake. Main flushes its own writers on before-quit, but only
  // this side can supply the queue snapshot - and once the window is gone, the
  // timer holding it never fires. Main says "now or never"; this lands the
  // write immediately so the flush a few hundred ms later picks it up.
  const onFlush = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      save();
  };
  if (typeof ipcRenderer.on === 'function') ipcRenderer.on('flush-state', onFlush);

  controller.restore = async () => {
    controller.restoring = true;
    let snap;
    try {
      snap = normalizeQueueSnapshot(await ipcRenderer.invoke('queue-load').catch(() => null));
      if (!snap.items.length && !snap.tracks.length) return { restored: 0, resumed: 0, alreadyDone: 0, staySkipped: 0 };
      controller.pause();
      const resumable = await ipcRenderer.invoke('transfers-resumable').catch(() => []) || [];
      const byId = new Map(resumable.map(t => [t.itemId, t]));
      const all = [...snap.items, ...snap.tracks];
      const checks = await ipcRenderer.invoke('downloads-check', all.map(i => ({
        key: i.key, folderName: i.folderName, title: i.title, artist: i.artist, durationSec: i.durationSec, isrc: i.isrc, savePath: i.savePath, bytes: i.bytes,
      })), { restore: true }).catch(() => []) || [];
      let alreadyDone = 0, staySkipped = 0, restored = 0, resumed = 0;
      const toResume = [];
      const prepared = all.map((item, i) => {
        if (byId.has(item.id) && item.status !== 'cancelled') {
          toResume.push(item.id);
          return { ...item, status: 'queued' };
        }
        if (checks[i]?.done) {
          alreadyDone++;
          return { ...item, ...checks[i], service: item.service,
            transferService: checks[i].service || item.transferService || null, status: 'completed' };
        }
        if (item.skippedInEarlierRun || item.status === 'skipped') { staySkipped++; return { ...item, status: 'skipped' }; }
        if (item.status === 'cancelled' || item.status === 'paused') return item;
        restored++;
        return { ...item, status: 'queued' };
      });
      const profileTracks = new Map(prepared.slice(snap.items.length).map(t => [t.key || t.id, t]));
      for (const profile of snap.profiles) {
        const playlists = snap.playlists.filter(pl => pl.profileId === profile.id);
        const keys = new Set(playlists.flatMap(pl => pl.trackKeys));
        controller.addProfile(profile, playlists, new Map([...profileTracks].filter(([key]) => keys.has(key))), { queue: false });
      }
      for (const item of prepared.slice(0, snap.items.length)) {
        if (item.status === 'completed') continue;
        controller.add(item);
        const rec = controller.getItem(item.id);
        if (!rec) continue;
        rec.status = item.status;
        rec.statusText = item.statusText || (item.status === 'skipped' ? 'Missing from an earlier run' : item.status === 'paused' ? 'Paused' : 'Waiting in queue');
        rec.tried = item.tried || [];
        if (['skipped', 'cancelled', 'paused'].includes(item.status)) controller.pool.cancel(item.id);
      }
      const resumeIds = new Set(toResume);
      controller.pool.submit([...controller.tracks.values()].filter(rec => rec.status === 'queued' && !resumeIds.has(rec.item.id)).map(rec => rec.item));
      for (const id of toResume) {
        const item = controller.getItem(id)?.item;
        if (!item || !controller.adoptTransfer(item, byId.get(id))) continue;
        resumed++;
        Promise.resolve(ipcRenderer.invoke('transfer-resume', id)).then(result => {
          if (!result?.ok) controller.failTransfer(id, 'resume-unavailable');
        }).catch(() => controller.failTransfer(id, 'resume-unavailable'));
      }
      log('session.restore', { restored, resumed, alreadyDone, staySkipped, paused: !!snap.paused });
      return { restored, resumed, alreadyDone, staySkipped };
    } finally {
      controller.restoring = false;
      if (snap && !snap.paused) controller.resume();
      controller._emit();
    }
  };
  return () => {
    clearTimeout(timer);
    unsubscribe();
    ipcRenderer.removeListener?.('flush-state', onFlush);
  };
}

// Upgrade old display-row snapshots without flattening shared profile tracks.
export function normalizeQueueSnapshot(snapshot) {
  const snap = snapshot || {};
  const refreshQueries = item => {
    const variants = buildSearchVariants(item.title, item.artist, item.album);
    // Upgrade generated queries from old queues while keeping custom searches.
    return item.searchVariants?.[0] === variants[0] ? { ...item, searchVariants: variants } : item;
  };
  if (snap.v >= 4) {
    const assignedPlaylists = assignPlaylistFiles(snap.playlists || []).map(pl => {
      const prof = (snap.profiles || []).find(p => p.id === pl.profileId);
      const profFolder = prof?.folderName || '';
      const folder = pl.folder || pl.file;
      const folderName = (!pl.folderName || /\/Playlists$/i.test(pl.folderName) || pl.folderName === 'Playlists')
        ? (profFolder ? `${profFolder}/${folder}` : folder)
        : pl.folderName;
      return { ...pl, folderName };
    });
    const plById = new Map(assignedPlaylists.map(pl => [pl.id, pl]));
    const tracks = (snap.tracks || []).map(t => {
      const refreshed = refreshQueries(t);
      if (!refreshed.folderName || /\/Tracks$/i.test(refreshed.folderName) || refreshed.folderName === 'Tracks') {
        const ownerPl = plById.get(refreshed.firstPlaylistId)
          || assignedPlaylists.find(pl => (pl.trackKeys || []).includes(refreshed.key || refreshed.id));
        if (ownerPl?.folderName) return { ...refreshed, folderName: ownerPl.folderName };
      }
      return refreshed;
    });
    return { ...snap, items: (snap.items || []).map(refreshQueries), tracks, profiles: snap.profiles || [], playlists: assignedPlaylists };
  }
  const profiles = new Map(), playlists = new Map(), tracks = new Map(), items = [];
  for (const item of snap.items || []) {
    if (!item.profileId || !item.groupId || item.id !== item.key) { items.push(item); continue; }
    const folderName = item.profileFolder || String(item.folderName || '').replace(/\/(Playlists|Tracks)$/i, '');
    profiles.set(item.profileId, { id: item.profileId, name: item.profileName, user: item.profileUser, service: item.profileService, image: item.profileArtwork, folderName });
    if (!playlists.has(item.groupId)) playlists.set(item.groupId, { id: item.groupId, profileId: item.profileId, name: item.groupName, artwork: item.groupArtwork, trackKeys: [] });
    playlists.get(item.groupId).trackKeys.push(item.key);
    if (!tracks.has(item.key)) tracks.set(item.key, { ...item, firstPlaylistId: item.groupId, profileFolder: folderName });
  }
  const assignedPlaylists = assignPlaylistFiles([...playlists.values()]).map(pl => {
    const profFolder = profiles.get(pl.profileId)?.folderName || '';
    const folder = pl.folder || pl.file;
    return { ...pl, folderName: profFolder ? `${profFolder}/${folder}` : folder };
  });
  const plById = new Map(assignedPlaylists.map(pl => [pl.id, pl]));
  const normalizedTracks = [...tracks.values()].map(t => {
    const ownerPl = plById.get(t.firstPlaylistId) || assignedPlaylists.find(pl => (pl.trackKeys || []).includes(t.key));
    return refreshQueries({ ...t, folderName: ownerPl?.folderName || (t.profileFolder ? `${t.profileFolder}/Playlist` : 'Playlist') });
  });
  return { ...snap, v: 4, items: items.map(refreshQueries), profiles: [...profiles.values()], playlists: assignedPlaylists, tracks: normalizedTracks };
}
