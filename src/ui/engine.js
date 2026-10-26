// The React app's connection to the download engine.
//
// The engine is a plain event-emitting store, so React subscribes to it with
// useSyncExternalStore - the supported bridge for external stores, and the
// reason the engine never had to become React state. Nothing here owns download
// logic; it only reads.

import { useSyncExternalStore, useCallback, useMemo } from 'react';
import { startEngine } from '../engine/renderer-integration.mjs';
import { createSources } from '../engine/sources.mjs';
import { makeMockController } from './mock.js';
import { refreshSpotifyArtwork } from '../engine/spotify-artwork.mjs';

// Electron's renderer runs with nodeIntegration, so `require` is on window.
// Outside Electron (a browser preview) it is absent, and the app falls back to
// a mock controller so the interface can still be looked at and worked on.
export const isElectron = typeof window !== 'undefined' && typeof window.require === 'function';
export const ipc = isElectron ? window.require('electron').ipcRenderer : null;

let controller = null;
let initializing = null;
let readyResolvers = [];

export function getController() { return controller; }
export function whenReady() {
  if (initializing) return initializing;
  if (controller) return Promise.resolve(controller);
  return new Promise((r) => readyResolvers.push(r));
}

export function initEngine(options) {
  // StrictMode and interface recovery can mount App again during restoration.
  // Every caller must wait for the same boot, including its saved-queue checks.
  if (!initializing) initializing = initializeEngine(options).catch(error => {
    initializing = null;
    throw error;
  });
  return initializing;
}

async function initializeEngine({ config, log }) {
  if (controller) return controller;

  if (!isElectron) {
    controller = makeMockController();
  } else {
    controller = startEngine({
      ipcRenderer: ipc,
      container: document.getElementById('worker-views'),
      services: Array.isArray(config.fallbackServices)
        ? config.fallbackServices : ['amazon'],
      concurrency: config.concurrency || 3,
      // How many transfers may keep running once the page that started them has
      // moved on. 0 restores the old wait-for-your-own-file behaviour.
      maxTransfers: config.maxTransfers == null ? 6 : config.maxTransfers,
      keepTrying: !!config.keepTrying,
      sourceRegions: config.sourceRegions,
      sourceCooldowns: config.sourceCooldowns,
      monochromeApiUrl: config.monochromeApiUrl,
      log,
    });
  }

  // Anything left outstanding by the previous run, minus whatever has since
  // appeared on disk.
  if (controller.restore) {
    try { await controller.restore(); }
    catch (e) { console.warn('[engine] session restore failed:', e.message); }
  }

  readyResolvers.forEach((r) => r(controller));
  readyResolvers = [];
  if (isElectron) refreshSpotifyArtwork(controller, sources).catch(e => console.warn('Artwork refresh failed:', e.message));
  return controller;
}

// Drives #scraper-view for the one import flow that needs a real browser page.
// Deliberately separate from the download workers: a profile scrape and a track
// download must never share a page.
function makeScraper() {
  const view = typeof document !== 'undefined' && document.getElementById('scraper-view');
  if (!view) return null;
  return {
    run(url, script, userAgent) {
      // Spotify serves a different, playlist-less page to Electron's default
      // user agent, which is why the profile grid came back empty. The old
      // implementation set a desktop UA here and the port dropped it.
      if (userAgent) view.setAttribute('useragent', userAgent);
      else view.removeAttribute('useragent');
      return new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, arg) => {
          if (settled) return;
          settled = true;
          view.removeEventListener('dom-ready', onReady);
          view.removeEventListener('did-fail-load', onFail);
          clearTimeout(timer);
          // Unload the page. Webviews run with backgroundThrottling off and are
          // rendered (opacity .001), so open.spotify.com left in here kept its
          // whole SPA running at full rate for the rest of the session. The
          // workers reset after every attempt; this view never did.
          view.setAttribute('src', 'about:blank');
          fn(arg);
        };
        const onReady = async () => {
          let current = '';
          try { current = view.getURL(); } catch (e) { /* not attached yet */ }
          if (!current || current === 'about:blank') return;
          try { done(resolve, await view.executeJavaScript(script)); }
          catch (e) { done(reject, e); }
        };
        const onFail = (e) => { if (e.isMainFrame) done(reject, new Error(e.errorDescription || 'load failed')); };
        const timer = setTimeout(() => done(reject, new Error('page load timed out')), 90000);
        view.addEventListener('dom-ready', onReady);
        view.addEventListener('did-fail-load', onFail);
        if (view.getAttribute('src') === url) view.reload();
        else view.setAttribute('src', url);
      });
    },
  };
}

// Playlist import. `fetch` reaches the public embed endpoints directly; Deezer's
// API goes through the main process, which is not subject to CORS.
export const sources = createSources({
  httpJson: (url) => (ipc ? ipc.invoke('http-json', url) : Promise.reject(new Error('unavailable'))),
  scraper: isElectron ? makeScraper() : null,
  cache: isElectron ? {
    get: (key) => ipc.invoke('cache-get', key),
    set: (key, value) => ipc.send('cache-set', { key, value }),
  } : null,
  log: (evt, data) => ipc && ipc.send('log', { evt, data }),
});

// A no-op store used before the engine exists, so hooks can be called
// unconditionally - React requires that - without a null check at every site.
const emptyStore = { subscribe: () => () => {}, getSnapshot: () => 0 };

function useEngineVersion() {
  const store = controller || emptyStore;
  return useSyncExternalStore(
    useCallback((cb) => store.subscribe(cb), [store]),
    useCallback(() => store.getSnapshot(), [store])
  );
}

/** Every track the engine knows about, re-read whenever it changes. */
export function useItems() {
  const store = controller;
  const version = useEngineVersion();
  return useMemo(() => store ? store.getItems() : [], [store, version]);
}

/**
 * The byte channel: download progress ticks, several per second per transfer.
 *
 * The queue tree (groups, statuses, filters) must not re-render per tick, so it
 * reads only the status version above. The components that draw bytes - a
 * downloading row's bar, the dock - subscribe here instead. Guarded for the
 * mock and pre-boot stores, which predate the split.
 */
export function useTransferProgress() {
  const store = controller || emptyStore;
  return useSyncExternalStore(
    useCallback((cb) => (store.subscribeProgress ? store.subscribeProgress(cb) : () => {}), [store]),
    useCallback(() => (store.getProgressSnapshot ? store.getProgressSnapshot() : 0), [store])
  );
}

export function useStats() {
  const store = controller;
  const version = useEngineVersion();
  return useMemo(() => store ? store.stats : { queued: 0, active: 0, completed: 0, skipped: 0, paused: 0, cancelled: 0, total: 0 }, [store, version]);
}

export function useQueueOrder() {
  const store = controller;
  const version = useEngineVersion();
  return useMemo(() => (store && typeof store.getQueueOrder === 'function')
    ? store.getQueueOrder()
    : { active: [], queued: [], paused: [], rest: [], all: [] }, [store, version]);
}

export function usePaused() {
  useEngineVersion();
  return controller ? controller.paused : false;
}

/**
 * Tracks grouped by playlist/album, preserving first-seen order so rows do not
 * jump around as statuses change. Sorting by status would reorder the list
 * under the user's cursor every time a download finished.
 */
export function useGroups() {
  const items = useItems();
  // Memoized on the item list so the groups keep their identity between
  // renders that did not change the queue (a parent re-render, a toggle).
  return useMemo(() => buildGroups(items), [items]);
}

function buildGroups(items) {
  const groups = new Map();
  for (const rec of items) {
    const key = rec.item.groupId || '__loose__';
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        name: rec.item.groupName || (key === '__loose__' ? 'Individual tracks' : 'Playlist'),
        artwork: rec.item.groupArtwork || null,
        folderName: rec.item.folderName || null,
        profileId: rec.item.profileId || null,
        profileName: rec.item.profileName || null,
        profileArtwork: rec.item.profileArtwork || null,
        profileFolder: rec.item.profileFolder || null,
        records: [],
      });
    }
    groups.get(key).records.push(rec);
  }
  return [...groups.values()];
}

/**
 * The same groups, with the playlists that came from one profile nested under
 * it. A profile download queues forty playlists at once; as a flat list that is
 * forty sections the user has to scroll past to find anything else they queued,
 * and nothing on screen says the forty belong together.
 *
 * Loose playlists are returned alongside profiles rather than under a synthetic
 * "no profile" heading - the shape is `{kind: 'profile'|'group'}` so the view
 * renders one list in queue order and does not have to stitch two together.
 */
export function useProfileTree() {
  const groups = useGroups();
  return useMemo(() => buildProfileTree(groups), [groups]);
}

function buildProfileTree(groups) {
  const out = [];
  const seen = new Map();
  for (const g of groups) {
    if (!g.profileId) { out.push({ kind: 'group', group: g }); continue; }
    let node = seen.get(g.profileId);
    if (!node) {
      node = {
        kind: 'profile',
        id: g.profileId,
        name: g.profileName || 'Profile',
        artwork: g.profileArtwork || null,
        folderName: g.profileFolder || null,
        groups: [],
      };
      seen.set(g.profileId, node);
      out.push(node);
    }
    node.groups.push(g);
  }
  return out;
}
