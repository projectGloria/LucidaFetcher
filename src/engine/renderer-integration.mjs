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

export const DEFAULT_CONCURRENCY = 3;
// How many finished-searching tracks may be in flight without holding a
// webview - the fetch-ahead depth.
//
// It must be LARGER than the slot count, or the pipeline stalls exactly where
// it is supposed to help: at 3 and 3, once three transfers are detached the
// next chain waits for its own file inline, holding its slot, and three of
// those park every webview on the network. Searching then stops dead until a
// file lands, so the downloads run in visible batches of three with a gap after
// each. At two batches ahead the slots keep fetching while the files drain, and
// there is always something already fetched for the network to pick up.
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
    pipeline = true, maxTransfers = DEFAULT_MAX_TRANSFERS,
  } = opts;

  const tracker = new DownloadTracker(ipcRenderer);
  const ipc = ipcAdapter(ipcRenderer, tracker);

  // One webview per slot, created up front. Building them lazily would put a
  // page load on the critical path of the first download in each slot.
  const views = ensureWorkerViews(container, concurrency);
  const workers = views.map((view, slot) => new Worker({
    slot, view: viewAdapter(view), ipc, log, pipeline,
  }));

  const controller = new Controller({
    getWorker: (slot) => workers[slot],
    services,
    concurrency,
    log,
    planOptions,
    maxTransfers: pipeline ? maxTransfers : 0,
    awaitTransfer: (itemId, signal) => tracker.await(itemId, signal),
    cancelTransfer: (itemId) => ipc.cancelDownload(itemId),
  });

  // Transfer state comes from the main process, not from the chain loop - which
  // between the click and the finished file is just awaiting one promise.
  tracker.onStarted = (itemId, payload) => {
    controller.noteDownloadStarted(itemId, payload && payload.service);
    if (onDownloadStart) onDownloadStart(itemId, payload);
  };
  tracker.onProgress = (itemId, received, total) => controller.noteProgress(itemId, received, total);

  // The folder's record of what it is missing, and why. The main process writes
  // the "downloaded" half itself when a file lands, but only the renderer knows
  // that a track ran out of sources - and this file is the only thing about a
  // failed track that survives the app closing.
  const reported = new Set();
  controller.subscribe(() => {
    for (const rec of controller.getItems()) {
      if (rec.status !== 'skipped' || reported.has(rec.item.id)) continue;
      reported.add(rec.item.id);
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
  });

  // The other half of that record, one level up: when every track a profile
  // queued has reached a terminal state, write the summary of the whole run
  // into the user's folder. Keyed by the outcome and not just by the profile,
  // so retrying the missing tracks rewrites it rather than leaving the first,
  // now-wrong answer on disk.
  const profileSigs = new Map();
  controller.subscribe(() => {
    for (const group of collectProfiles(controller.getItems())) {
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
  });

  if (onChange) controller.subscribe(() => onChange(controller));

  // Growing the pool needs more webviews; shrinking leaves the extra ones
  // parked rather than destroying a view a slot may still be finishing in.
  const baseSetConcurrency = controller.setConcurrency.bind(controller);
  controller.setConcurrency = (n) => {
    const want = Math.max(1, n | 0);
    const all = ensureWorkerViews(container, Math.max(want, workers.length));
    for (let i = workers.length; i < want; i++) {
      workers[i] = new Worker({ slot: i, view: viewAdapter(all[i]), ipc, log, pipeline });
    }
    baseSetConcurrency(want);
  };

  attachPersistence(controller, ipcRenderer, log);

  controller.tracker = tracker;
  controller.workers = workers;
  return controller;
}

const PERSIST_DEBOUNCE_MS = 1500;

/**
 * Keep state/queue.json in step with the queue, and offer what it holds back on
 * the next launch.
 *
 * Completed tracks are not written: they are already in the manifest, and
 * replaying them would only make the next launch re-check files it knows about.
 * Skipped tracks ARE written, flagged, so they can be shown as missing without
 * being retried on every start - a skip means the whole chain was exhausted, and
 * paying that cost again on every launch to reach the same answer is what the
 * flag exists to prevent.
 */
export function attachPersistence(controller, ipcRenderer, log = () => {}) {
  let timer = null;

  const snapshot = () => ({
    v: 3,
    at: Date.now(),
    paused: controller.paused,
    items: controller.getItems()
      .filter((r) => r.status !== 'completed' && r.status !== 'cancelled')
      .map((r) => ({ ...r.item, status: r.status, statusText: r.statusText, tried: r.tried, skippedInEarlierRun: r.status === 'skipped' })),
  });

  controller.subscribe(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const snap = snapshot();
      if (snap.items.length) ipcRenderer.send('queue-save', snap);
      else ipcRenderer.send('queue-clear'); // nothing outstanding: do not replay an empty run
    }, PERSIST_DEBOUNCE_MS);
  });

  // Removal is a structural change: save it immediately through both debounce
  // layers so closing the app cannot bring the deleted playlist back.
  const baseRemove = controller.remove.bind(controller);
  controller.remove = (ids) => {
    const count = baseRemove(ids);
    if (count) {
      clearTimeout(timer);
      const snap = snapshot();
      if (snap.items.length) ipcRenderer.send('queue-save', snap, true);
      else ipcRenderer.send('queue-clear');
    }
    return count;
  };

  controller.restore = async () => {
    const snap = await ipcRenderer.invoke('queue-load').catch(() => null);
    const items = (snap && snap.items) || [];
    if (!items.length) return { restored: 0, alreadyDone: 0, staySkipped: 0 };

    // A file the user has since deleted must download again, and one downloaded
    // by another means must not.
    let checks = [];
    try {
      checks = await ipcRenderer.invoke('downloads-check',
        items.map((i) => ({ key: i.key, folderName: i.folderName, title: i.title })));
    } catch (e) { checks = []; }

    // Files that were still coming down when the app last closed. Chromium can
    // pick these up at the byte they stopped at, so they must not go back
    // through the chain as if nothing had been fetched.
    let resumable = [];
    try { resumable = (await ipcRenderer.invoke('transfers-resumable')) || []; }
    catch (e) { resumable = []; }
    const byId = new Map(resumable.map((t) => [t.itemId, t]));

    const fresh = [];
    const toResume = [];
    let alreadyDone = 0, staySkipped = 0;
    items.forEach((item, i) => {
      if (checks[i] && checks[i].done) { alreadyDone++; return; }
      if (item.skippedInEarlierRun) {
        staySkipped++;
        controller.items.set(item.id, {
          item, status: 'skipped', statusText: item.statusText || 'Missing from an earlier run',
          tried: item.tried || [], plan: null, step: null, result: null,
        });
        return;
      }
      if (byId.has(item.id)) { toResume.push(item); return; }
      fresh.push(item);
    });

    // Pause before add() submits work; pausing after submission is too late.
    if (snap && snap.paused) controller.pause();
    const restored = controller.add(fresh);

    // Adopt first, THEN ask the main process to start pulling: the record has to
    // exist before the first progress event arrives, or the bytes have nowhere
    // to be reported against.
    let resumed = 0;
    for (const item of toResume) {
      if (!controller.adoptTransfer(item, byId.get(item.id))) { controller.add([item]); continue; }
      resumed++;
      Promise.resolve(ipcRenderer.invoke('transfer-resume', item.id))
        .then((res) => {
          // Nothing to resume after all - hand it to the chain rather than
          // leaving a row that says "downloading" with nothing behind it.
          if (!res || !res.ok) controller.failTransfer(item.id, 'resume-unavailable');
        })
        .catch(() => controller.failTransfer(item.id, 'resume-unavailable'));
    }

    if (staySkipped || resumed) controller._emit();
    log('session.restore', { restored, resumed, alreadyDone, staySkipped, paused: !!(snap && snap.paused) });
    return { restored, resumed, alreadyDone, staySkipped };
  };
}
