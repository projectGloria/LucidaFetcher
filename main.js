const { app, BrowserWindow, session, ipcMain, dialog, net, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const crypto = require('crypto');

// Suppress internal Chromium network/STUN stderr spam
app.commandLine.appendSwitch('log-level', '3');

let downloadPath = app.getPath('downloads'); // replaced by state/config.json at startup
let mainWindow = null;

// ---------------------------------------------------------------------------
// Session logger
//
// One JSON object per line (.jsonl) so a run can be sliced with grep/jq or read
// back programmatically. The renderer owns most of the interesting state, so it
// forwards its events here over the 'log' channel and the main process is the
// only writer - that keeps ordering stable and survives a renderer crash.
// ---------------------------------------------------------------------------
// Where everything this app WRITES lives.
//
// app.getAppPath() is the repo while developing and `resources/app.asar` once
// installed - and an asar is read-only, so pointing state/ and logs/ at it in a
// packaged build does not fail loudly, it just quietly loses the queue, the
// config, the manifest and the resume data on every launch. Installed builds
// therefore write under the per-user data directory, and a dev run keeps using
// the repo so the state you have been testing against is still there.
const DATA_ROOT = app.isPackaged ? app.getPath('userData') : app.getAppPath();

const LOG_DIR = path.join(DATA_ROOT, 'logs');
const SESSION_START = Date.now();
const LOG_FILE = path.join(
  LOG_DIR,
  `session-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jsonl`
);
let logStream = null;

// Sessions to keep. Logging everything is only sustainable if old logs leave
// on their own - this app is opened daily and a session can run for hours, so
// an unbounded logs/ directory is a slow leak the user would find years later.
// Twenty is enough to cover "it also did this last week" without ever becoming
// a thing anyone has to clean up.
const KEEP_SESSIONS = 20;

function pruneOldLogs() {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter((f) => /^session-.*\.jsonl$/.test(f))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_SESSIONS))) {
      try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch (e) { /* it is only a log */ }
    }
  } catch (e) { /* no directory yet, nothing to prune */ }
}

function openLog() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    pruneOldLogs();
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    logStream.on('error', (err) => console.error('[logger] write failed:', err.message));
  } catch (err) {
    console.error('[logger] could not open', LOG_FILE, '-', err.message);
  }
}

// The last few thousand events, kept in memory as well as on disk.
//
// The diagnostics report has to work when the log file cannot be read back - a
// stream still buffering, a disk that filled, a renderer that died before its
// writes landed - and the events you most want are exactly the ones most likely
// to still be in flight. The buffer is bounded: an app that logs everything
// must not also remember everything.
const RECENT_CAP = 4000;
const recentEvents = [];

function logEvent(evt, data = {}) {
  const record = { ts: new Date().toISOString(), t: Date.now() - SESSION_START, evt, ...data };
  let line;
  try {
    line = JSON.stringify(record);
  } catch (err) {
    // never let a circular or oversized payload take the app down
    line = JSON.stringify({ ts: record.ts, t: record.t, evt: 'log.error', of: evt, message: err.message });
  }
  recentEvents.push(line);
  if (recentEvents.length > RECENT_CAP) recentEvents.splice(0, recentEvents.length - RECENT_CAP);
  if (logStream) logStream.write(line + '\n');
  if (!app.isPackaged && process.env.LF_VERBOSE) console.log(line);
}

// ---------------------------------------------------------------------------
// Every IPC call, without touching a single handler
//
// The renderer asks the main process for everything it cannot do itself, so a
// handler that throws or hangs looks - from the UI - exactly like the app doing
// nothing. Wrapping `handle` once, here, before any handler is registered,
// covers all of them and covers the ones added later too.
//
// Only failures and slow calls are written. A line per successful `cache-get`
// would be most of the log by volume and none of it by value, and a log nobody
// can read is the same as no log.
// ---------------------------------------------------------------------------
const SLOW_IPC_MS = 2000;
const ipcCalls = new Map(); // channel -> { n, fails, slowest }

const rawHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => rawHandle(channel, async (event, ...args) => {
  const started = Date.now();
  const stat = ipcCalls.get(channel) || { n: 0, fails: 0, slowest: 0 };
  stat.n++;
  try {
    const out = await listener(event, ...args);
    const ms = Date.now() - started;
    if (ms > stat.slowest) stat.slowest = ms;
    if (ms >= SLOW_IPC_MS) logEvent('ipc.slow', { channel, ms });
    return out;
  } catch (err) {
    stat.fails++;
    // An IPC handler that throws rejects the renderer's promise, and most call
    // sites there end in a .catch that swallows it. This is the only place the
    // reason survives.
    logEvent('ipc.failed', { channel, ms: Date.now() - started, message: err.message, stack: stackOf(err) });
    throw err;
  } finally {
    ipcCalls.set(channel, stat);
  }
});

ipcMain.on('log', (event, payload) => {
  if (payload && typeof payload.evt === 'string') logEvent(payload.evt, payload.data || {});
});
ipcMain.handle('get-log-path', () => LOG_FILE);

const stackOf = (err) => String((err && err.stack) || '').split('\n').slice(0, 8).join(' | ');

process.on('uncaughtException', (err) => {
  logEvent('error.main', { message: err.message, stack: stackOf(err) });
});

// A rejected promise nobody awaited used to be invisible. Almost everything in
// this app is a promise - every download, every scrape, every IPC handler - so
// "nothing in the log at all" was a real possible answer to "why did that track
// stop moving".
process.on('unhandledRejection', (reason) => {
  logEvent('error.unhandledRejection', {
    message: (reason && reason.message) || String(reason),
    stack: stackOf(reason),
  });
});

function safeUrl(contents) {
  try { return contents && !contents.isDestroyed() ? contents.getURL().slice(0, 300) : null; }
  catch (e) { return null; }
}

// A window or a webview whose process died. Without this the log simply stops
// mid-track, which reads like a hang and is not one.
app.on('render-process-gone', (event, contents, details) => {
  logEvent('crash.renderer', {
    reason: details && details.reason, exitCode: details && details.exitCode,
    url: safeUrl(contents),
  });
});
app.on('child-process-gone', (event, details) => {
  logEvent('crash.child', {
    type: details && details.type, reason: details && details.reason,
    exitCode: details && details.exitCode, name: details && details.name,
  });
});

// ---------------------------------------------------------------------------
// Everything that happens inside a page
//
// The app drives hidden webviews it never looks at, so a scrape that failed
// because the page threw, or was served a login wall, or was rate-limited,
// surfaced as nothing more specific than `attempt.outcome: not-found`.
//
// Attached once, centrally, to every web contents the app creates: no worker or
// scraper has to remember to report, and a webview added later is covered on
// the day it is added rather than the day someone notices it is not.
// ---------------------------------------------------------------------------
const CONSOLE_LEVELS = ['debug', 'info', 'warn', 'error'];

app.on('web-contents-created', (event, contents) => {
  const kind = contents.getType();
  const tag = () => ({ kind, wc: contents.id, url: safeUrl(contents) });

  contents.on('did-fail-load', (e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED, which is what navigating away looks like - and this
    // app navigates away constantly by design. Logging it as a failure would
    // bury the real ones under the routine ones.
    if (errorCode === -3) return;
    logEvent('page.failed', {
      ...tag(), errorCode, errorDescription,
      url: String(validatedURL || '').slice(0, 300), isMainFrame,
    });
  });

  contents.on('console-message', (e, level, message, lineNo, sourceId) => {
    // Scraped pages are noisy - ads, trackers, framework warnings - so only
    // warnings and errors are kept.
    if (level < 2) return;
    logEvent('page.console', {
      ...tag(), level: CONSOLE_LEVELS[level] || String(level),
      message: String(message || '').slice(0, 500),
      source: String(sourceId || '').slice(0, 200), line: lineNo,
    });
  });

  contents.on('unresponsive', () => logEvent('page.unresponsive', tag()));
  contents.on('responsive', () => logEvent('page.responsive', tag()));
});

// ---------------------------------------------------------------------------
// Persistent state
//
//   state/config.json   - download path + speed limit, so settings outlive a run
//   state/queue.json    - the live queue, so a closed app resumes where it left
//   state/manifest.json - every completed download, keyed by track
//   state/cache/*.json  - scraped result lists, so re-pasting a link costs no fetch
//   state/history.json  - past searches and pasted links, newest first
//
// All of it is small and rewritten wholesale. Writes go through a temp file and a
// rename: these files are read back on the next launch, and a crash mid-write that
// left truncated JSON behind would lose the queue it was meant to protect.
// ---------------------------------------------------------------------------
const STATE_DIR = path.join(DATA_ROOT, 'state');
const CACHE_DIR = path.join(STATE_DIR, 'cache');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const QUEUE_FILE = path.join(STATE_DIR, 'queue.json');
const MANIFEST_FILE = path.join(STATE_DIR, 'manifest.json');
const TRANSFERS_FILE = path.join(STATE_DIR, 'transfers.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_CONFIG = {
  downloadPath: null, speedLimitKBps: 0, scanFolderForExisting: false,
  freeSources: ['jamendo'], jamendoClientId: '',
  // Transfers allowed to keep running after the page that started them has
  // moved on to the next search. 0 = a page waits for its own file.
  maxTransfers: 3,
  // Closing the window leaves the app running in the tray. On by default
  // because this is a long-running fetcher: closing the window while forty
  // playlists are still downloading should not throw the run away, and the
  // window is the least interesting part of the app once a queue is moving.
  closeToTray: true,
};
let config = Object.assign({}, DEFAULT_CONFIG);
let manifest = {};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

async function readJsonAsync(file, fallback) {
  try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch (e) { return fallback; }
}

// Async temp-file+rename write. Callers that aren't already async fire-and-forget
// with .catch for logging; the atomicity guarantee (a crash mid-write can't leave
// truncated JSON behind) is unchanged.
async function writeJson(file, value, indent) {
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(value, null, indent || 0));
    await fs.promises.rename(tmp, file);
  } catch (e) {
    logEvent('state.error', { file: path.basename(file), message: e.message });
  }
}

// Debounce with flush and cancel. State is written on every queue mutation, but a
// pending write still has to land before the app quits (flush), and must not
// resurrect a file the renderer has just cleared (cancel).
function debounced(fn, ms) {
  let timer = null, pending = null;
  const run = () => {
    timer = null;
    if (pending) { const args = pending; pending = null; return Promise.resolve(fn.apply(null, args)); }
    return Promise.resolve();
  };
  const d = function (...args) { pending = args; clearTimeout(timer); timer = setTimeout(run, ms); };
  // flush() now returns the (possibly async) write's promise, so a caller like
  // window-all-closed can await it before the process actually quits.
  d.flush = () => { clearTimeout(timer); return run(); };
  d.cancel = () => { clearTimeout(timer); timer = null; pending = null; };
  return d;
}

const saveManifest = debounced(() => writeJson(MANIFEST_FILE, manifest), 500);
ipcMain.handle('manifest-get', () => manifest);
const saveQueue = debounced((snap) => writeJson(QUEUE_FILE, snap), 400);

// ---------------------------------------------------------------------------
// Partly-downloaded files, so a quit mid-transfer costs the bytes still to come
// rather than the ones already on disk.
//
// The queue already survives a restart, but only as intentions: a track that
// was 90% of the way through a 40MB FLAC came back as "queued" and paid for the
// whole file again. What Chromium needs to pick a transfer back up is the URL
// chain, the validators (ETag/Last-Modified) and the byte offset, none of which
// survive the process - so they are written down here while the file moves.
// ---------------------------------------------------------------------------
let transfers = {};   // itemId -> { savePath, urlChain, offset, ... }
let quitting = false;
const saveTransfers = debounced(() => writeJson(TRANSFERS_FILE, transfers), 800);

function rememberTransfer(item, ctx, savePath) {
  if (!ctx || !ctx.itemId) return;
  try {
    transfers[ctx.itemId] = {
      itemId: ctx.itemId,
      savePath,
      file: item.getFilename(),
      urlChain: item.getURLChain(),
      mimeType: item.getMimeType(),
      eTag: item.getETag(),
      lastModified: item.getLastModifiedTime(),
      startTime: item.getStartTime(),
      total: item.getTotalBytes(),
      received: item.getReceivedBytes(),
      // Enough of the download context to file the finished file correctly on
      // the next launch: the worker that knew all this is long gone by then.
      ctx: {
        itemId: ctx.itemId, key: ctx.key || null, folderName: ctx.folderName || null,
        title: ctx.title || null, artist: ctx.artist || null, group: ctx.group || null,
        service: ctx.service || null, attemptService: ctx.attemptService || null,
        originalService: ctx.originalService || null, sourceUrl: ctx.sourceUrl || null,
        artworkUrl: ctx.artworkUrl || null,
      },
      at: Date.now(),
    };
    saveTransfers();
  } catch (e) { /* a download that has already gone away has nothing to record */ }
}

function forgetTransfer(itemId) {
  if (!itemId || !transfers[itemId]) return;
  delete transfers[itemId];
  saveTransfers();
}

/** What is on disk right now, which is the only offset worth trusting. */
function partialSize(file) {
  try { const st = fs.statSync(file); return st.isFile() ? st.size : 0; } catch (e) { return 0; }
}

// A resumed download has no worker webview behind it, so it cannot be matched by
// webContents id the way a live one is. It is matched by its save path instead.
const resumeContexts = new Map(); // savePath -> ctx

function takeResumeContext(item) {
  if (!resumeContexts.size) return null;
  let p = '';
  try { p = item.getSavePath(); } catch (e) { p = ''; }
  if (p && resumeContexts.has(p)) {
    const ctx = resumeContexts.get(p);
    resumeContexts.delete(p);
    return ctx;
  }
  // Chromium does not always report the save path back on the will-download for
  // an interrupted item; the URL it is fetching identifies it just as well.
  let url = '';
  try { url = item.getURL(); } catch (e) { url = ''; }
  for (const [key, ctx] of resumeContexts) {
    if (url && ctx.resumeUrl === url) { resumeContexts.delete(key); return ctx; }
  }
  return null;
}

/**
 * Transfers that could be picked up where they stopped: still recorded, still
 * on disk, still short of the total. Anything else is dropped here rather than
 * offered and then failed.
 */
function resumableTransfers() {
  const out = [];
  for (const id of Object.keys(transfers)) {
    const t = transfers[id];
    const have = t && t.savePath ? partialSize(t.savePath) : 0;
    const resumable = !!(t && t.urlChain && t.urlChain.length && have > 0 &&
      (!t.total || have < t.total));
    if (resumable) out.push({ itemId: id, file: t.file, received: have, total: t.total || 0 });
    else if (t) {
      // Nothing to resume: clear the record, and the stray partial with it, so a
      // fresh download of the same track does not land beside it as "name (1)".
      if (t.savePath && have > 0 && t.total && have < t.total) {
        try { fs.unlinkSync(t.savePath); } catch (e) { /* best effort */ }
      }
      delete transfers[id];
    }
  }
  saveTransfers();
  return out;
}

ipcMain.handle('transfers-resumable', () => resumableTransfers());

ipcMain.handle('transfer-resume', (event, itemId) => {
  const t = transfers[itemId];
  if (!t || !t.urlChain || !t.urlChain.length) return { ok: false, reason: 'unknown' };
  const offset = partialSize(t.savePath);
  if (!offset) return { ok: false, reason: 'no-partial' };

  const ctx = Object.assign({}, t.ctx, {
    itemId,
    resumed: true,
    resumeUrl: t.urlChain[t.urlChain.length - 1],
    savePath: t.savePath,
  });
  resumeContexts.set(t.savePath, ctx);

  try {
    session.defaultSession.createInterruptedDownload({
      path: t.savePath,
      urlChain: t.urlChain,
      mimeType: t.mimeType || 'application/octet-stream',
      offset,
      length: t.total || 0,
      lastModified: t.lastModified || '',
      eTag: t.eTag || '',
      startTime: t.startTime || Date.now() / 1000,
    });
    logEvent('transfer.resume', { itemId, offset, total: t.total || 0, file: t.file });
    return { ok: true, offset, total: t.total || 0 };
  } catch (err) {
    resumeContexts.delete(t.savePath);
    logEvent('transfer.resume.failed', { itemId, message: err.message });
    return { ok: false, reason: err.message };
  }
});

function loadState() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { /* reported on first write */ }
  config = Object.assign({}, DEFAULT_CONFIG, readJson(CONFIG_FILE, {}));
  downloadPath = config.downloadPath || app.getPath('downloads');
  manifest = readJson(MANIFEST_FILE, {}) || {};
  transfers = readJson(TRANSFERS_FILE, {}) || {};

  // Fix 3: bound manifest growth - prune entries whose file no longer exists on
  // disk, same idea checkDownloaded already applies one entry at a time on the
  // read path, but done once up front so a manifest full of deleted files doesn't
  // grow forever.
  let pruned = 0;
  for (const key of Object.keys(manifest)) {
    const rec = manifest[key];
    if (rec && rec.savePath && !fs.existsSync(rec.savePath)) {
      delete manifest[key];
      pruned++;
    }
  }
  if (pruned) saveManifest();
}

function saveConfig() {
  config.downloadPath = downloadPath;
  writeJson(CONFIG_FILE, config);
}

ipcMain.handle('get-config', () => Object.assign({}, config, { downloadPath, stateDir: STATE_DIR }));
ipcMain.on('set-config', (event, patch) => {
  Object.assign(config, patch || {});
  saveConfig();
  logEvent('settings.change', patch || {});
});

ipcMain.on('queue-save', (event, snap, immediate = false) => {
  if (immediate) { saveQueue.cancel(); writeJson(QUEUE_FILE, snap); }
  else saveQueue(snap);
});
ipcMain.handle('queue-load', () => readJson(QUEUE_FILE, null));
ipcMain.on('queue-clear', () => {
  saveQueue.cancel(); // otherwise the in-flight debounce writes the file straight back
  try { fs.unlinkSync(QUEUE_FILE); } catch (e) { /* nothing to clear */ }
});

const PROFILES_FILE = path.join(STATE_DIR, 'profiles.json');
ipcMain.handle('profiles-get', () => readJson(PROFILES_FILE, []));
ipcMain.on('profiles-save', (event, profiles) => writeJson(PROFILES_FILE, profiles));

// What has been searched or pasted, newest first. The renderer owns the shape
// and the ordering; the cap lives here because this file is rewritten wholesale
// and an unbounded one would be read back in full on every launch.
const HISTORY_FILE = path.join(STATE_DIR, 'history.json');
const HISTORY_MAX = 60;
ipcMain.handle('history-get', () => readJson(HISTORY_FILE, []));
ipcMain.on('history-save', (event, entries) => {
  writeJson(HISTORY_FILE, Array.isArray(entries) ? entries.slice(0, HISTORY_MAX) : []);
});
ipcMain.on('history-clear', () => {
  try { fs.unlinkSync(HISTORY_FILE); } catch (e) { /* nothing to clear */ }
});

// ---------------------------------------------------------------------------
// Scrape cache
//
// A Spotify playlist costs one embed fetch for the track list and then one MORE
// per track for its artwork, so re-pasting a 130-track link is 131 round trips
// before a single byte of audio moves. The renderer stores the finished result
// list here, keyed by what was pasted.
// ---------------------------------------------------------------------------
function cacheFile(key) {
  return path.join(CACHE_DIR, crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 20) + '.json');
}

ipcMain.handle('cache-get', async (event, key) => {
  const rec = await readJsonAsync(cacheFile(key), null);
  if (!rec || !rec.at || Date.now() - rec.at > CACHE_TTL_MS) return null;
  logEvent('cache.hit', { key, ageMs: Date.now() - rec.at, entries: (rec.value || []).length });
  return rec.value;
});

ipcMain.on('cache-set', (event, payload) => {
  if (!payload || !payload.key) return;
  writeJson(cacheFile(payload.key), { at: Date.now(), key: payload.key, value: payload.value });
});

ipcMain.handle('cache-clear', () => {
  let n = 0;
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) { fs.unlinkSync(path.join(CACHE_DIR, f)); n++; }
  } catch (e) { /* nothing cached */ }
  logEvent('cache.clear', { files: n });
  return n;
});

// ---------------------------------------------------------------------------
// Main-process JSON fetch
//
// Deezer's public API answers without a key but sends no CORS header at all, so a
// fetch() from the renderer (origin file://, i.e. null) is blocked outright. The
// Spotify embed endpoints do send one, which is why that path can stay in the
// renderer - this exists for the ones that do not. The host allowlist is the whole
// security story: the renderer must never be able to turn this into a general
// purpose proxy.
// ---------------------------------------------------------------------------
// Host -> which paths it may serve. SoundCloud is here only for its public
// oEmbed endpoint, which is the one cheap way to get artwork for a flat-playlist
// row (yt-dlp's --flat-playlist returns none for SoundCloud sets).
const JSON_HOSTS = {
  'api.deezer.com': () => true,
  'soundcloud.com': (p) => p === '/oembed',
};

ipcMain.handle('http-json', async (event, url) => {
  let u;
  try { u = new URL(String(url)); } catch (e) { throw new Error('bad url'); }
  const allows = Object.prototype.hasOwnProperty.call(JSON_HOSTS, u.hostname) && JSON_HOSTS[u.hostname];
  if (u.protocol !== 'https:' || !allows || !allows(u.pathname)) {
    logEvent('http.blocked', { url: String(url).slice(0, 200) });
    throw new Error('host not allowed: ' + u.hostname);
  }
  const started = Date.now();
  const res = await net.fetch(u.href);
  const text = await res.text();
  logEvent('http.json', { host: u.hostname, path: u.pathname, status: res.status,
                          bytes: text.length, ms: Date.now() - started });
  // A 404 is an ANSWER, not a failure: SoundCloud's oEmbed returns one for a
  // private or deleted upload, and every caller here already handles a null
  // page. Throwing made Electron log a stack per missing cover.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('http ' + res.status);
  try { return JSON.parse(text); } catch (e) { throw new Error('bad json from ' + u.hostname); }
});

const yt = require('./youtube-dl.js');

// The services a download may be attributed to. An allowlist rather than a
// pass-through: this string is written into the manifest and into the folder
// report, both of which are read back later, so it must not be whatever the
// renderer happened to send.
const SERVICE_IDS = new Set([
  'qobuz', 'tidal', 'amazon', 'deezer', 'soundcloud', 'spotify',
  'napster', 'yandex', 'monochrome', 'youtube', 'jamendo',
]);

ipcMain.handle('yt-metadata', async (event, url) => {
  return await yt.fetchMetadata(url);
});
// Candidates only - the renderer scores them against the wanted track and is
// free to reject all of them. See src/engine/yt-fallback.mjs for why picking
// the top hit down here would be wrong.
async function mediaSearch(kind, search, query, limit) {
  const q = String(query || '').trim();
  if (!q) return { ok: true, results: [] };
  try {
    return { ok: true, results: await search(q, limit || 5) };
  } catch (err) {
    // "unavailable" is not "no results". Collapsing the two is how a throttled
    // run writes "not on YouTube" into a folder report for tracks that are there.
    logEvent(`${kind}.search.failed`, { query: q, code: err.code || null, error: err.message, stderr: err.stderr || null });
    return { ok: false, reason: err.code === 'SEARCH_UNAVAILABLE' ? 'unavailable' : 'error', message: err.message, results: [] };
  }
}

ipcMain.handle('yt-search', (event, { query, limit } = {}) =>
  mediaSearch('yt', yt.searchYouTube, query, limit));

ipcMain.handle('sc-search', (event, { query, limit } = {}) =>
  mediaSearch('sc', yt.searchSoundCloud, query, limit));

// Jamendo's read API is free for non-commercial applications. It returns a
// download URL only when the artist opted in; enforce both that flag and a
// Creative Commons license here so previews and non-downloadable entries never
// become candidates in the renderer.
ipcMain.handle('jamendo-search', async (event, { query, limit } = {}) => {
  const clientId = String(config.jamendoClientId || '').trim();
  if (!clientId) return { ok: false, reason: 'not-configured', results: [] };
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(clientId)) {
    return { ok: false, reason: 'bad-client-id', message: 'The Jamendo client ID is not valid.', results: [] };
  }
  const q = String(query || '').trim();
  if (!q) return { ok: true, results: [] };

  const u = new URL('https://api.jamendo.com/v3.0/tracks/');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('format', 'json');
  u.searchParams.set('limit', String(Math.min(20, Math.max(1, Number(limit) || 10))));
  u.searchParams.set('search', q);
  u.searchParams.set('include', 'licenses musicinfo');
  u.searchParams.set('audiodlformat', 'flac');
  u.searchParams.set('imagesize', '500');

  const started = Date.now();
  try {
    const response = await net.fetch(u.href);
    const body = await response.json();
    if (!response.ok || body?.headers?.status !== 'success') {
      const message = body?.headers?.error_message || `Jamendo returned HTTP ${response.status}`;
      logEvent('jamendo.search.failed', { query: q, status: response.status, message });
      return { ok: false, reason: 'api-error', message, results: [] };
    }
    const results = (body.results || []).filter((track) => {
      if (track.audiodownload_allowed !== true || !track.audiodownload) return false;
      if (!/^https?:\/\/creativecommons\.org\/licenses\//i.test(track.license_ccurl || '')) return false;
      try {
        const media = new URL(track.audiodownload);
        return media.protocol === 'https:' && (media.hostname === 'jamendo.com' || media.hostname.endsWith('.jamendo.com'));
      } catch (e) { return false; }
    }).map((track) => ({
      id: String(track.id),
      title: track.name || '',
      artist: track.artist_name || '',
      uploader: track.artist_name || '',
      durationSec: Number(track.duration) || null,
      url: track.audiodownload,
      sourcePage: track.shareurl || track.shorturl || null,
      image: track.image || track.album_image || null,
      licenseUrl: track.license_ccurl,
    }));
    logEvent('jamendo.search', { query: q, results: results.length, ms: Date.now() - started });
    return { ok: true, results };
  } catch (err) {
    logEvent('jamendo.search.failed', { query: q, message: err.message });
    return { ok: false, reason: 'unavailable', message: err.message, results: [] };
  }
});

// Everything behind a SoundCloud (or YouTube) link: one track, or every track
// of a set. Done here rather than in the renderer because SoundCloud sends no
// CORS header and its own API needs a client_id scraped out of the page's
// bundles - yt-dlp already solves both, and keeps solving them when the site
// changes underneath us.
const MEDIA_HOSTS = /(^|\.)(soundcloud\.com|snd\.sc|youtube\.com|youtu\.be|music\.youtube\.com)$/i;

ipcMain.handle('media-resolve', async (event, url) => {
  let u;
  try { u = new URL(String(url)); } catch (e) { return { error: 'That is not a valid link.' }; }
  if (!/^https?:$/.test(u.protocol) || !MEDIA_HOSTS.test(u.hostname)) {
    logEvent('media.resolve.blocked', { host: u.hostname });
    return { error: 'Only SoundCloud and YouTube links can be read this way.' };
  }
  const started = Date.now();
  try {
    const out = await yt.resolveMediaUrl(u.href);
    logEvent('media.resolve', { host: u.hostname, kind: out.kind, tracks: out.entries.length, ms: Date.now() - started });
    return out;
  } catch (err) {
    logEvent('media.resolve.failed', { host: u.hostname, error: err.message });
    return { error: err.message };
  }
});
const mediaTransfers = new Map();
ipcMain.on('download-cancel-item', (event, itemId) => {
  mediaTransfers.get(itemId)?.abort();
  for (const rec of liveItems) {
    if (rec.itemId === itemId) { try { rec.item.cancel(); } catch {} }
  }
});

ipcMain.handle('yt-download', async (event, payload) => {
  const { url, savePath, itemId, key, folderName, title, artist, group, sourcePage, licenseUrl } = payload || {};
  // Which catalogue this file actually came from. It used to be hardcoded to
  // 'youtube', which was true while yt-dlp only ever served the YouTube
  // fallback and became a lie the moment SoundCloud joined the chain - and the
  // manifest and the folder report are the only places that answer "where did
  // this file come from?" a month later.
  const service = SERVICE_IDS.has(payload && payload.service) ? payload.service : 'youtube';
  let source;
  try { source = new URL(String(url)); } catch (e) { throw new Error('Invalid media URL.'); }
  if (!/^https?:$/.test(source.protocol)) throw new Error('Only HTTP(S) media URLs are supported.');
  if (service === 'jamendo' && source.hostname !== 'jamendo.com' && !source.hostname.endsWith('.jamendo.com')) {
    throw new Error('Jamendo downloads must come from Jamendo.');
  }

  // The caller may name a file, or - as the engine's YouTube fallback does -
  // give only the folder and the track, leaving the path to be built here.
  // Building it here is also the safer half of the containment check below:
  // a path assembled from a sanitised basename cannot escape by construction.
  const root = path.resolve(downloadPath);
  const sanitize = (v) => String(v || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_')
    .replace(/\s+/g, ' ').trim().slice(0, 150);

  let target, outputTemplate;
  if (savePath) {
    target = path.resolve(String(savePath));
    outputTemplate = target;
  } else {
    const base = sanitize([artist, title].filter(Boolean).join(' - '))
      || sanitize(title) || `track-${itemId || Date.now()}`;
    const dir = folderName ? folderFor(folderName) : downloadPath;
    target = path.join(dir, base);
    // yt-dlp picks the container after it sees the stream, so the extension
    // cannot be known up front - ask for it in the template and find the file
    // afterwards. Naming a fixed .m4a here is how the old fallback ended up
    // stat-ing a file yt-dlp had never written.
    outputTemplate = target + '.%(ext)s';
  }

  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('Download path is outside the configured download folder.');
  }
  const transfer = new AbortController();
  mediaTransfers.set(itemId, transfer);
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });

    // A yt-dlp fetch is a download like any other as far as the user is
    // concerned, so it reports on the same rails as a Chromium one. It used to
    // announce itself on a channel ('yt-download-progress') that nothing had
    // listened to since the React rewrite, so a track being pulled from YouTube
    // sat at "Last resort: searching YouTube" for the whole transfer - the queue
    // looked stuck at exactly the moment it was working hardest.
    //
    // Deliberately NOT the 'download-status' channel: that one settles a
    // DownloadTracker waiter, and this transfer's caller is awaiting the invoke
    // instead. A completion posted there would be filed as an unclaimed result
    // and handed to whichever attempt asked next.
    toUI('media-download-started', { itemId, service, title: title || null });
    let lastSend = 0;
    await yt.downloadYoutubeLink(source.href, outputTemplate, (percent, p) => {
      const now = Date.now();
      if (now - lastSend < 250 && percent < 100) return;
      lastSend = now;
      toUI('media-download-progress', {
        itemId,
        received: p && p.received ? p.received : Math.round(percent),
        total: p && p.total ? p.total : 100,
      });
    }, transfer.signal);
    if (transfer.signal.aborted) throw new Error('Download cancelled');
  } finally {
    if (mediaTransfers.get(itemId) === transfer) mediaTransfers.delete(itemId);
  }

  if (!savePath) {
    const dir = path.dirname(target);
    const base = path.basename(target);
    const produced = (await fs.promises.readdir(dir))
      .filter((f) => f.startsWith(base + '.') && /\.(mp3|m4a|opus|ogg|flac|wav|aac|webm)$/i.test(f))
      .map((f) => path.join(dir, f));
    if (!produced.length) throw new Error('yt-dlp reported success but wrote no file.');
    target = produced[0];
  }
  const bytes = (await fs.promises.stat(target)).size;
  const manifestKey = key || itemId;
  if (manifestKey) {
    manifest[manifestKey] = { file: path.basename(target), savePath: target, bytes,
      at: new Date().toISOString(), service, format: path.extname(target).slice(1),
      sourceUrl: sourcePage || source.href, mediaUrl: source.href, licenseUrl: licenseUrl || null };
  }
  saveManifest();
  if (title) {
    writeReport(folderName, 'downloaded', {
      title, artist: artist || '', group: group || null, service,
      sourceUrl: sourcePage || source.href, mediaUrl: source.href, licenseUrl: licenseUrl || null,
      file: path.basename(target), bytes, via: service === 'jamendo' ? 'jamendo-api' : 'yt-dlp'
    });
    await flushReports();
    reportCache.delete(path.join(folderFor(folderName), REPORT_NAME));
  }
  return { ok: true, savePath: target, file: path.basename(target), bytes };
});

// ---------------------------------------------------------------------------
// "Is this track already downloaded?"
//
// The manifest is the authority: it records the real save path, so an existing
// file is a fact rather than a guess, and a file the user has since deleted
// correctly downloads again. The folder scan below only exists for files this app
// never recorded (an older version, a manual copy) and is off by default -
// matching on a filename can only ever be a guess, and a wrong guess silently
// skips a track the user wanted.
// ---------------------------------------------------------------------------
const AUDIO_EXT = /\.(flac|mp3|m4a|ogg|opus|wav|aac|alac)$/i;

function normTokens(s) {
  const fold = { 'ł':'l','ø':'o','đ':'d','ð':'d','þ':'th','æ':'ae','œ':'oe',
    'ß':'ss','ı':'i','ħ':'h','ŋ':'n','ŧ':'t','ĸ':'k' };
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, (c) => fold[c] || ' ')
    .trim().split(/\s+/).filter(Boolean);
}

// must match the sanitisation applied when a download is actually saved, below
// A folder name may name a PATH, not just a folder: a profile download writes
// "<user>/<playlist>", and the separator is always a forward slash regardless of
// platform because that is the one thing every producer of these strings can
// agree on. Each segment is sanitized on its own - sanitizing the joined string
// would turn the separator into an underscore and flatten the tree - and the
// containment check below is what actually keeps ".." out, not the character
// class.
function folderFor(folderName) {
  if (!folderName) return path.resolve(downloadPath);
  const root = path.resolve(downloadPath);
  const segments = String(folderName).split(/[/\\]+/).map((part) => {
    let safe = part.replace(/[<>:"|?*]+/g, '_').replace(/[. ]+$/g, '').trim();
    if (!safe || safe === '.' || safe === '..') safe = '_';
    return safe;
  }).filter(Boolean);
  if (!segments.length) return root;
  const candidate = path.resolve(root, ...segments);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return path.join(root, '_');
  return candidate;
}

function checkDownloaded(q, names = null) {
  if (!q) return { done: false };
  const rec = q.key ? manifest[q.key] : null;
  if (rec && rec.savePath) {
    if (fs.existsSync(rec.savePath)) return { done: true, file: rec.file, via: 'manifest', service: rec.service || null, sourceUrl: rec.sourceUrl || null, savePath: rec.savePath, bytes: rec.bytes || null };
    delete manifest[q.key]; // gone from disk - let it download again
    saveManifest();
  }
  if (!config.scanFolderForExisting) return { done: false };
  const want = normTokens(q.title);
  if (want.length < 2) return { done: false }; // one-word titles collide far too easily
  if (!names) return { done: false };
  for (const rec of names) {
    const f = rec.file;
    const have = rec.tokens;
    if (want.every((t) => have.indexOf(t) !== -1)) return { done: true, file: f, via: 'scan' };
  }
  return { done: false };
}

ipcMain.handle('downloads-check', async (event, list) => {
  const checks = list || [];
  if (!config.scanFolderForExisting) return checks.map((q) => checkDownloaded(q));

  // Album/profile batches contain many tracks in the same folder. Read and
  // tokenize that directory once instead of doing the same synchronous scan for
  // every track in the batch.
  const folders = new Map();
  for (const q of checks) {
    if (!q || normTokens(q.title).length < 2) continue;
    const dir = folderFor(q.folderName);
    if (!folders.has(dir)) folders.set(dir, null);
  }
  for (const dir of folders.keys()) {
    try {
      const names = await fs.promises.readdir(dir);
      folders.set(dir, names.filter((f) => AUDIO_EXT.test(f)).map((f) => ({
        file: f, tokens: normTokens(path.parse(f).name)
      })));
    } catch (e) {
      folders.set(dir, []);
    }
  }
  return checks.map((q) => checkDownloaded(q, folders.get(folderFor(q && q.folderName))));
});

// ---------------------------------------------------------------------------
// Per-folder download report
//
// state/manifest.json answers "is this on disk?" for the app; it is keyed by
// track and lives next to the code, so it tells the USER nothing when they are
// looking at a folder of music a month later. This writes the same story into
// the folder itself: what was downloaded, from which store, when - and, the part
// that cannot be reconstructed afterwards, what is MISSING and which services
// were tried before giving up.
//
// Written here rather than in the renderer for the same reason as every other
// file under state/: one writer, atomic temp+rename, and it survives a renderer
// crash. Two sources feed it - the main process itself when a download completes
// (only it knows the final path and byte count) and the renderer over
// 'report-track' for tracks that were skipped or found already on disk.
// ---------------------------------------------------------------------------
const REPORT_NAME = '_lucidafetcher.json';
const reportCache = new Map();
const dirtyReports = new Set();
let reportFlushTimer = null;

function reportKey(title, artist) {
  return normTokens(title).join(' ') + '|' + normTokens(artist).join(' ');
}

function emptyReport(folderName) {
  return {
    app: 'LucidaFetcher',
    folder: folderName || '(download root)',
    created: new Date().toISOString(),
    updated: null,
    counts: { downloaded: 0, missing: 0 },
    downloaded: [],
    missing: []
  };
}

function flushReports() {
  clearTimeout(reportFlushTimer);
  reportFlushTimer = null;
  const writes = [];
  for (const file of dirtyReports) {
    const rec = reportCache.get(file);
    if (rec) writes.push(writeJson(file, rec.report, 2));
  }
  dirtyReports.clear();
  return Promise.all(writes);
}

function saveReportSoon(file) {
  dirtyReports.add(file);
  clearTimeout(reportFlushTimer);
  reportFlushTimer = setTimeout(flushReports, 500);
}

// section is 'downloaded' | 'missing'. A track appears once and in one section
// only, so a missing track that is later found moves rather than doubling up.
function writeReport(folderName, section, entry) {
  if (!entry || !entry.title) return;
  const dir = folderFor(folderName);
  const file = path.join(dir, REPORT_NAME);
  let cached = reportCache.get(file);
  if (!cached) {
    try {
      // A group whose every track failed never had its folder created by
      // will-download, and that is exactly the run worth having a record of.
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      logEvent('report.error', { folder: folderName || null, message: e.message });
      return;
    }
    cached = { report: Object.assign(emptyReport(folderName), readJson(file, null) || {}) };
    reportCache.set(file, cached);
  }
  const rep = cached.report;
  if (!Array.isArray(rep.downloaded)) rep.downloaded = [];
  if (!Array.isArray(rep.missing)) rep.missing = [];

  const key = reportKey(entry.title, entry.artist);
  const prev = rep[section].filter((e) => reportKey(e.title, e.artist) === key)[0];
  rep.downloaded = rep.downloaded.filter((e) => reportKey(e.title, e.artist) !== key);
  rep.missing = rep.missing.filter((e) => reportKey(e.title, e.artist) !== key);

  const rec = Object.assign({ at: new Date().toISOString() }, entry);
  // "already on disk" is re-reported on every launch by restoreSession. That must
  // not keep bumping the timestamp forward - when the track was actually fetched
  // is the useful fact, and it is the one thing nothing else remembers.
  if (prev && prev.at && String(entry.via || '').indexOf('existing') === 0) rec.at = prev.at;
  rep[section].push(rec);

  rep.updated = new Date().toISOString();
  rep.counts = { downloaded: rep.downloaded.length, missing: rep.missing.length };
  saveReportSoon(file);
  logEvent('report.write', {
    folder: folderName || null, section, title: entry.title,
    downloaded: rep.counts.downloaded, missing: rep.counts.missing
  });
}

ipcMain.on('report-track', (event, payload) => {
  if (!payload || !payload.entry) return;
  const section = payload.section === 'missing' ? 'missing' : 'downloaded';
  writeReport(payload.folderName, section, payload.entry);
});

// ---------------------------------------------------------------------------
// Whole-profile report
//
// A per-folder report answers "what happened to THIS playlist". Downloading a
// profile asks a question no per-folder file can: across forty playlists, which
// tracks are missing and where. This writes that one file into the user's own
// folder, next to the playlist folders it summarises.
//
// It is written from the aggregate the renderer holds rather than by re-reading
// the playlist reports: the renderer knows why a track was abandoned and which
// services it tried, and those two facts are the entire reason the file exists.
// A profile is re-reported whenever it finishes, so the file is replaced whole
// rather than merged - a stale "missing" surviving a successful retry would be
// worse than no file.
// ---------------------------------------------------------------------------
const PROFILE_REPORT_NAME = '_profile-report.json';

ipcMain.on('profile-report', (event, payload) => {
  if (!payload || !payload.folderName) return;
  const dir = folderFor(payload.folderName);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    logEvent('profile.report.error', { folder: payload.folderName, message: e.message });
    return;
  }
  const playlists = Array.isArray(payload.playlists) ? payload.playlists : [];
  const downloaded = playlists.reduce((n, pl) => n + (pl.downloaded || []).length, 0);
  const missing = playlists.reduce((n, pl) => n + (pl.missing || []).length, 0);
  const report = {
    app: 'LucidaFetcher',
    kind: 'profile',
    profile: payload.profile || null,
    folder: payload.folderName,
    order: payload.order || null,
    finished: new Date().toISOString(),
    counts: { playlists: playlists.length, downloaded, missing, tracks: downloaded + missing },
    playlists,
  };
  writeJson(path.join(dir, PROFILE_REPORT_NAME), report, 2);
  logEvent('profile.report', {
    folder: payload.folderName, playlists: playlists.length, downloaded, missing,
  });
});

// ---------------------------------------------------------------------------
// Diagnostics export
//
// The log is written for a machine; this is the thing a person hands over. Main
// collects (it owns the file and the config) and writes (it is the only writer
// of anything on disk, everywhere else in this app); the RENDERER renders,
// because the summariser lives in src/engine, which is bundled into the UI and
// is not shipped as loose files in a packaged build.
//
// The current session is read back off disk rather than taken from memory so
// the report covers the whole run, not just the last few thousand events - with
// the in-memory ring buffer as the fallback for exactly the cases where reading
// the file is what failed.
// ---------------------------------------------------------------------------
const RAW_TAIL = 1500;

function readSessionEvents(file) {
  const events = [];
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch (e) { /* a half-written last line */ }
  }
  return events;
}

ipcMain.handle('diagnostics-collect', async (event, opts = {}) => {
  // Flush first: the last few events are usually the interesting ones, and a
  // stream that has not drained would leave them out of the very report they
  // were meant to explain.
  await new Promise((resolve) => {
    if (!logStream || !logStream.write('')) logStream ? logStream.once('drain', resolve) : resolve();
    else resolve();
  });

  let events = readSessionEvents(LOG_FILE);
  let source = 'file';
  if (!events || !events.length) {
    source = 'memory';
    events = recentEvents.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  }

  // Earlier sessions, oldest first, when the problem is "it did this yesterday
  // too". Opt-in: most reports want this run and nothing else.
  if (opts.includePrevious) {
    try {
      const older = fs.readdirSync(LOG_DIR)
        .filter((f) => /^session-.*\.jsonl$/.test(f) && path.join(LOG_DIR, f) !== LOG_FILE)
        .sort()
        .slice(-Number(opts.includePrevious));
      const before = [];
      for (const f of older) before.push(...(readSessionEvents(path.join(LOG_DIR, f)) || []));
      events = before.concat(events);
    } catch (e) { /* the current session is still worth reporting */ }
  }

  logEvent('diagnostics.collect', { events: events.length, source, includePrevious: opts.includePrevious || 0 });

  return {
    events,
    // The tail as raw lines: the summary is an interpretation, and whoever
    // reads the report has to be able to check it against what was recorded.
    raw: events.slice(-RAW_TAIL).map((e) => JSON.stringify(e)),
    config: Object.assign({}, config, { downloadPath }),
    logFile: LOG_FILE,
    logDir: LOG_DIR,
    ipc: [...ipcCalls.entries()].map(([channel, v]) => ({ channel, ...v })).sort((a, b) => b.n - a.n),
  };
});

ipcMain.handle('diagnostics-save', async (event, payload = {}) => {
  const name = String(payload.name || 'lucidafetcher-diagnostics.md').replace(/[^\w.-]+/g, '-');
  const result = await dialog.showSaveDialog({
    title: 'Save diagnostics report',
    defaultPath: path.join(app.getPath('desktop'), name),
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
  try {
    await fs.promises.writeFile(result.filePath, String(payload.text || ''), 'utf8');
    logEvent('diagnostics.saved', { file: result.filePath, bytes: (payload.text || '').length });
    return { ok: true, file: result.filePath };
  } catch (err) {
    logEvent('diagnostics.save.failed', { message: err.message });
    return { ok: false, message: err.message };
  }
});

ipcMain.handle('open-log-folder', () => shell.openPath(LOG_DIR));

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  downloadPath = result.filePaths[0];
  saveConfig();
  logEvent('settings.downloadPath', { downloadPath });
  return downloadPath;
});

// Where a download about to start should be filed: its folder, artwork, and the
// track metadata the folder report needs. Only the renderer knows which track
// and which store a file belongs to; only the main process ever sees the file.
//
// Keyed by the webContents that will produce the download - NOT a single slot.
// A single slot is safe only while exactly one download can be in flight: with
// a pool of worker webviews, the second worker's context overwrites the first's
// before will-download fires, and the finished file is then saved into the
// wrong folder and recorded against the wrong track in the wrong report. That
// is silent corruption, not a visible failure, so the key is the worker.
const pendingContexts = new Map(); // webContents id -> context

// Downloads that do not originate in a worker webview (a direct link opened in
// the main window) still need somewhere to look.
let fallbackContext = null;

ipcMain.on('set-next-download-folder', (event, context) => {
  const id = context && context.webContentsId;
  if (id) pendingContexts.set(id, context);
  else fallbackContext = context;
});

// A worker that is torn down or navigated away must not leave its context
// behind for whatever download the same id serves next.
ipcMain.on('clear-download-context', (event, webContentsId) => {
  if (webContentsId) pendingContexts.delete(webContentsId);
});

function takeDownloadContext(webContents) {
  const id = webContents && webContents.id;
  if (id && pendingContexts.has(id)) {
    const ctx = pendingContexts.get(id);
    pendingContexts.delete(id);
    return ctx;
  }
  const ctx = fallbackContext;
  fallbackContext = null;
  return ctx;
}

ipcMain.handle('get-download-path', () => {
  return downloadPath;
});

// Standalone "save this artwork" action from the results/queue artwork
// popup's right-click menu. Deliberately separate from will-download/
// the pending-context map - this is a one-off save-as, not a queued track,
// and must not touch liveItems/throttle/log-as-track-download.
ipcMain.handle('download-artwork', async (event, { url, suggestedName }) => {
  if (!url) return { ok: false, error: 'No artwork URL.' };
  const ext = (() => {
    const m = /\.(jpe?g|png|webp|gif)(?:\?|$)/i.exec(url);
    return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
  })();
  const defaultName = `${(suggestedName || 'artwork').replace(/[<>:"/\\|?*]+/g, '_')}.${ext}`;

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save artwork',
    defaultPath: path.join(app.getPath('downloads'), defaultName),
    filters: [{ name: 'Image', extensions: [ext] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };

  return new Promise((resolve) => {
    const req = net.request(url);
    const chunks = [];
    req.on('response', (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        resolve({ ok: false, error: `Server responded ${res.statusCode}.` });
        res.resume();
        return;
      }
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          fs.writeFileSync(result.filePath, Buffer.concat(chunks));
          logEvent('artwork.saved', { url, savePath: result.filePath });
          resolve({ ok: true, savePath: result.filePath });
        } catch (err) {
          resolve({ ok: false, error: err.message });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
});

ipcMain.handle('open-item-folder', (event, { savePath: itemSavePath, folderName }) => {
  try {
    if (itemSavePath && fs.existsSync(itemSavePath)) {
      shell.showItemInFolder(itemSavePath);
      return { ok: true };
    }
    const folder = folderName ? folderFor(folderName) : downloadPath;
    if (!fs.existsSync(folder)) return { ok: false, error: 'That folder does not exist yet.' };
    shell.openPath(folder);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});


// ---------------------------------------------------------------------------
// Speed limit and pause/resume
//
// Electron exposes no bandwidth cap on a DownloadItem, so the limit is enforced by
// duty-cycling pause()/resume() against a byte budget that refills at the
// configured rate. It is approximate by nature - it averages out over about a
// second rather than smoothing every packet.
//
// resume() is the risk: if the server will not honour a range request, Chromium
// discards what it has and starts the transfer over, which at this frequency would
// mean a download that never finishes. So every resume is checked, and if the byte
// count ever goes backwards the limiter switches itself off for the rest of the
// session and tells the renderer to say so, rather than looping forever.
//
// The queue is strictly serial, so throttling the one live item throttles the
// whole app.
// ---------------------------------------------------------------------------
const THROTTLE_TICK_MS = 500;
const liveItems = new Set();
let throttleTimer = null;
let throttleSupported = true;
let userPaused = false;

function startThrottleTimer() {
  if (!throttleTimer) throttleTimer = setInterval(throttleTick, THROTTLE_TICK_MS);
}

function throttleTick() {
  if (liveItems.size === 0) { clearInterval(throttleTimer); throttleTimer = null; return; }
  const now = Date.now();
  const limit = Math.max(0, config.speedLimitKBps | 0) * 1024;

  liveItems.forEach((rec) => {
    const item = rec.item;
    let received;
    try { received = item.getReceivedBytes(); } catch (e) { liveItems.delete(rec); return; }

    // going backwards after a resume means the server restarted the transfer
    if (!rec.throttled && rec.mark && received < rec.mark && throttleSupported) {
      throttleSupported = false;
      logEvent('download.throttle.unsupported', { file: item.getFilename(), was: rec.mark, now: received });
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('throttle-unsupported');
    }
    rec.mark = received;

    if (userPaused) { rec.last = now; return; } // an explicit pause outranks the limiter

    if (!limit || !throttleSupported) {
      if (rec.throttled) { rec.throttled = false; try { item.resume(); } catch (e) { /* gone */ } }
      rec.allowed = received;
      rec.last = now;
      return;
    }

    rec.allowed += limit * (now - rec.last) / 1000;
    rec.last = now;
    // never bank more than a second of headroom, or a long pause would be followed
    // by an unthrottled burst as the budget is spent
    if (rec.allowed > received + limit) rec.allowed = received + limit;

    if (received >= rec.allowed) {
      if (!rec.throttled) { rec.throttled = true; try { item.pause(); } catch (e) { /* gone */ } }
    } else if (rec.throttled) {
      rec.throttled = false;
      try { item.resume(); } catch (e) { /* gone */ }
    }
  });
}

function setPaused(paused) {
  userPaused = !!paused;
  liveItems.forEach((rec) => {
    try {
      if (userPaused) { rec.item.pause(); return; }
      rec.item.resume();
      rec.allowed = rec.item.getReceivedBytes(); // the budget must not refill while stopped
      rec.last = Date.now();
      rec.throttled = false;
    } catch (e) { /* item already finished */ }
  });
  logEvent(userPaused ? 'download.pause' : 'download.resume', { inFlight: liveItems.size });
}

// Removing the item that is mid-transfer has to stop the transfer too, or the
// bytes keep landing on disk for a track the queue no longer knows about.
ipcMain.on('downloads-cancel', () => {
  for (const transfer of mediaTransfers.values()) transfer.abort();
  const n = liveItems.size;
  liveItems.forEach((rec) => { try { rec.item.cancel(); } catch (e) { /* already finished */ } });
  liveItems.clear();
  logEvent('download.cancel', { cancelled: n });
});

ipcMain.on('downloads-pause', () => setPaused(true));
ipcMain.on('downloads-resume', () => setPaused(false));

// Fix 4: guarded send helper - the will-download handlers had no
// mainWindow-alive check, unlike throttleTick's send.
function toUI(channel, msg) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, msg);
}

// Fix 6: fetch artwork via net.fetch with a timeout and status check instead
// of a bare https.get with no error/timeout handling.
async function downloadArtwork(url, artPath) {
  try {
    const res = await net.fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      logEvent('artwork.error', { url, status: res.status });
      return;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(artPath, buf);
  } catch (e) {
    logEvent('artwork.error', { url, message: e.message });
  }
}

// Fix 1: extracted so it can be registered exactly once, outside createWindow
// (which app.on('activate') can call again on macOS - registering this inside
// it would double every download-completion side effect).
function handleWillDownload(event, item, webContents) {
  // Claim this worker's context. Taking it by webContents rather than from a
  // shared slot is what lets several downloads be in flight at once.
  const ctx = takeDownloadContext(webContents) || takeResumeContext(item);

  const fileName = item.getFilename();
  // A resumed transfer already has a path with bytes in it; recomputing one
  // from the filename would start a second file beside the partial.
  let savePath = ctx && ctx.resumed && ctx.savePath
    ? ctx.savePath
    : path.join(downloadPath, fileName);

  if (ctx && ctx.folderName && !(ctx.resumed && ctx.savePath)) {
    const folderPath = folderFor(ctx.folderName);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
    savePath = path.join(folderPath, fileName);

    if (ctx.artworkUrl) {
      const artPath = path.join(folderPath, 'cover.jpg');
      if (!fs.existsSync(artPath)) {
        downloadArtwork(ctx.artworkUrl, artPath);
      }
    }
  }

  item.setSavePath(savePath);

  const rec = { item, itemId: ctx?.itemId, allowed: 0, last: Date.now(), throttled: false, mark: 0 };
  liveItems.add(rec);
  startThrottleTimer();
  // Written down before the first byte: an app killed seconds into a transfer
  // should still be able to pick it up.
  rememberTransfer(item, ctx, savePath);
  let lastRemembered = Date.now();
  if (ctx && ctx.resumed) {
    try { if (item.canResume()) item.resume(); } catch (e) { /* already running */ }
  }
  if (userPaused) { try { item.pause(); } catch (e) { /* not started yet */ } }

  const startedAt = Date.now();
  let lastProgressLog = 0;
  let lastProgressSend = 0;

  logEvent('download.start', {
    file: fileName,
    total: item.getTotalBytes(),
    savePath,
    itemId: ctx && ctx.itemId || null,
    originalService: ctx && ctx.originalService || null,
    attemptedService: ctx && ctx.attemptService || null,
    url: item.getURL(),
    mime: item.getMimeType()
  });

  toUI('download-started', {
    file: item.getFilename(),
    total: item.getTotalBytes(),
    service: ctx && ctx.attemptService || null,
    itemId: ctx && ctx.itemId || null,
    savePath
  });

  item.on('updated', (event, state) => {
    if (state === 'progressing' && !item.isPaused()) {
      // sampled, not every tick - enough to spot a stall without flooding the log
      if (Date.now() - lastProgressLog > 10000) {
        lastProgressLog = Date.now();
        logEvent('download.progress', {
          file: fileName,
          received: item.getReceivedBytes(),
          total: item.getTotalBytes(),
          ms: Date.now() - startedAt
        });
      }
      // Fix 2: throttle the UI progress event to at most once per 250ms -
      // this handler otherwise fires on every Chromium 'updated' tick.
      const now = Date.now();
      // The resume record only has to be roughly current - it is re-read against
      // the real file size on the next launch - so this is cheap on purpose.
      if (now - lastRemembered >= 2000) {
        lastRemembered = now;
        rememberTransfer(item, ctx, savePath);
      }
      if (now - lastProgressSend >= 250) {
        lastProgressSend = now;
        toUI('download-progress', {
          file: item.getFilename(),
          received: item.getReceivedBytes(),
          total: item.getTotalBytes()
        });
      }
    } else if (state === 'interrupted') {
      logEvent('download.interrupted', { file: fileName, received: item.getReceivedBytes() });
    }
  });

  item.once('done', async (event, state) => {
    liveItems.delete(rec);
    if (state === 'completed') {
      forgetTransfer(ctx && ctx.itemId);
    } else if (quitting) {
      // Interrupted BY the quit: keep the record and the partial file, which is
      // the whole point of writing them down.
      rememberTransfer(item, ctx, savePath);
    } else {
      // Interrupted mid-session. The chain is about to try another source, and a
      // partial left at the target path would send that download to "name (1)".
      forgetTransfer(ctx && ctx.itemId);
      if (savePath && partialSize(savePath) > 0 && partialSize(savePath) < item.getTotalBytes()) {
        try { fs.unlinkSync(savePath); } catch (e) { /* best effort */ }
      }
    }
    const ms = Date.now() - startedAt;
    const bytes = item.getReceivedBytes();
    logEvent('download.done', {
      file: fileName,
      state,
      bytes,
      total: item.getTotalBytes(),
      ms,
      kbps: ms > 0 ? Math.round(bytes / 1024 / (ms / 1000)) : null,
      itemId: ctx && ctx.itemId || null, originalService: ctx && ctx.originalService || null,
      attemptedService: ctx && ctx.attemptService || null
    });
    if (state === 'completed') {
      // This can copy a large FLAC. Keep it asynchronous so IPC and the UI
      // remain responsive while the repair is in progress.
      const art = await stripOversizedArtwork(savePath);
      if (art) logEvent('artwork.stripped', Object.assign({ file: fileName }, art));
      // What lets a restarted app know this track is already on disk. Keyed by
      // track rather than by filename, because only the renderer knows which
      // queue item a given download belonged to.
      if (ctx && ctx.key) {
        manifest[ctx.key] = { file: fileName, savePath, bytes, at: new Date().toISOString(),
          service: ctx.attemptService || null, sourceUrl: ctx.sourceUrl || null };
        saveManifest();
      }
      // The folder's own record of where this track came from. Only the main
      // process knows the final filename and byte count, so it is written here
      // rather than round-tripped back through the renderer.
      if (ctx && ctx.title) {
        writeReport(ctx.folderName, 'downloaded', {
          title: ctx.title,
          artist: ctx.artist || '',
          service: ctx.attemptService || ctx.service || null,
          sourceUrl: ctx.sourceUrl || item.getURL(),
          file: fileName,
          // what is actually on disk: stripOversizedArtwork may have just
          // rebuilt the file smaller than the bytes that came down the wire
          bytes: (() => { try { return fs.statSync(savePath).size; } catch (e) { return bytes; } })(),
          via: 'download',
          tried: ctx.tried && ctx.tried.length ? ctx.tried : undefined
        });
      }
      // Fix 7: this folder's group is fully settled from the report's
      // perspective for now - drop the cache entry rather than holding it for
      // the app's lifetime. writeReport/writeReport-again re-reads from disk
      // on a cache miss, so this is safe.
      if (ctx) {
        // writeReport is debounced; flush before eviction so the completed entry
        // cannot disappear with its cache record.
        await flushReports();
        reportCache.delete(path.join(folderFor(ctx.folderName), REPORT_NAME));
      }
    }

    // Durable writes above happen before this UI send (defense in depth: a
    // destroyed-window throw here, now guarded by toUI, can never skip them).
    toUI('download-status', { file: item.getFilename(), status: state,
      service: ctx && ctx.attemptService || null, itemId: ctx && ctx.itemId || null, savePath });
  });
}

// ---------------------------------------------------------------------------
// System tray
//
// The window is a view onto a queue that keeps running without it. Closing it
// therefore hides it rather than ending the run - a forty-playlist profile
// download is measured in hours, and the alternative is a window the user has
// to leave open and looking at them the whole time.
//
// The menu is rebuilt from the renderer's stats rather than kept in step by
// hand: the main process does not own queue state (the controller does), so it
// reports what it was last told and says "waiting" when it has not been told
// anything yet, instead of inventing a number.
// ---------------------------------------------------------------------------
let tray = null;
let trayStats = null;
let hintedTray = false;

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function trayStatusLine() {
  if (!trayStats) return 'Waiting for the queue…';
  const { active = 0, queued = 0, completed = 0, skipped = 0, paused = false } = trayStats;
  if (paused) return `Paused · ${queued + active} waiting`;
  if (!active && !queued) {
    return completed || skipped
      ? `Idle · ${completed} downloaded${skipped ? `, ${skipped} missing` : ''}`
      : 'Idle';
  }
  return `${active} working · ${queued} queued`;
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const paused = !!(trayStats && trayStats.paused);
  const idle = !trayStats || (!trayStats.active && !trayStats.queued);
  tray.setToolTip('LucidaFetcher — ' + trayStatusLine());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show LucidaFetcher', click: showWindow },
    { type: 'separator' },
    { label: trayStatusLine(), enabled: false },
    {
      label: paused ? 'Resume downloads' : 'Pause downloads',
      // Nothing to pause and nothing held back: the control would only be
      // answering a question nobody asked.
      enabled: !idle || paused,
      click: () => toUI('tray-command', paused ? 'resume' : 'pause'),
    },
    { type: 'separator' },
    { label: 'Open download folder', click: () => shell.openPath(path.resolve(downloadPath)) },
    { type: 'separator' },
    { label: 'Quit LucidaFetcher', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  if (tray && !tray.isDestroyed()) return;
  try {
    const file = path.join(app.getAppPath(), 'build', 'tray.png');
    const image = nativeImage.createFromPath(file);
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    // A left click should open the window; the menu is the right-click.
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
    refreshTray();
    logEvent('tray.ready', { icon: image.isEmpty() ? null : file });
  } catch (e) {
    // A missing tray (some Linux desktops) must not take the app with it - it
    // only means the window has to be closed the ordinary way.
    tray = null;
    logEvent('tray.unavailable', { message: e.message });
  }
}

// The renderer owns the queue, so it is the only thing that can say what the
// tray should read.
ipcMain.on('engine-stats', (event, stats) => {
  trayStats = stats || null;
  refreshTray();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    icon: path.join(app.getAppPath(), 'build', 'icon.png'),
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#0c0d11', // matches the UI's --bg, so startup does not flash white
    webPreferences: {
      webviewTag: true,
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // The React UI, built by Vite into dist/. LF_DEV points at the dev server
  // instead, so the interface can be worked on with hot reload against the real
  // engine rather than the mock.
  const built = path.join(app.getAppPath(), 'dist', 'index.html');
  if (process.env.LF_DEV) {
    mainWindow.loadURL('http://localhost:5173');
  } else if (fs.existsSync(built)) {
    mainWindow.loadFile(built);
  } else {
    // Nothing built yet: say so plainly rather than opening a blank window.
    mainWindow.loadURL('data:text/html,' + encodeURIComponent(
      `<body style="background:#0c0d11;color:#e8eaf2;font:14px system-ui;display:grid;place-items:center;height:100vh;margin:0">
         <div style="text-align:center;line-height:1.6">
           <h2 style="font-weight:600">Interface not built yet</h2>
           <p style="color:#9aa1b8">Run <code style="background:#191c29;padding:2px 6px;border-radius:5px">npm run build:ui</code> once, then start the app again.</p>
         </div>
       </body>`));
  }
  mainWindow.setMenu(null);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Hide instead of close, unless the app is genuinely on its way out. The
  // `quitting` flag is already the app's answer to "is this a real exit?" - it
  // is set by before-quit and by the tray's own Quit - so the tray reuses it
  // rather than inventing a second source of truth that could disagree.
  mainWindow.on('close', (event) => {
    if (quitting || !config.closeToTray || !tray || tray.isDestroyed()) return;
    event.preventDefault();
    mainWindow.hide();
    logEvent('window.hidden', {});
    if (!hintedTray) {
      hintedTray = true;
      // Said once, and only on the platform that has somewhere to say it: an
      // app that vanishes from the taskbar without explaining itself reads as
      // a crash.
      if (process.platform === 'win32') {
        try {
          tray.displayBalloon({
            title: 'LucidaFetcher is still running',
            content: 'Downloads continue in the background. Use the tray icon to open it again or quit.',
          });
        } catch (e) { /* balloons are best effort */ }
      }
    }
  });
}


// ---------------------------------------------------------------------------
// Oversized embedded artwork
//
// Lucida serves some FLACs with very large cover art embedded as a PICTURE
// metadata block, and Windows' FLAC parser gives up on those: Explorer shows no
// artwork, every media property (Length, Bit rate, artist) reads back empty, and
// double-clicking errors instead of playing. Verified 2026-08-28 on "This Is
// Your Life" - a 2400x2400 / 4.58MB block. The identical audio with the block
// removed parses and plays; a 1500x1500 / 2.77MB block in a sibling file is
// fine, so the trigger is the size of the block, not the picture itself.
//
// Only the metadata header is rebuilt - the audio frames are copied across
// untouched. The folder still gets its cover.jpg, so the artwork is not lost,
// it just no longer lives inside the file.
// ---------------------------------------------------------------------------
const MAX_EMBEDDED_ART = 3 * 1024 * 1024; // empirical: 2.77MB parses, 4.58MB does not

async function stripOversizedArtwork(filePath) {
  let input = null;
  let output = null;
  try {
    if (!/\.flac$/i.test(filePath)) return null;
    input = await fs.promises.open(filePath, 'r');
    const magic = Buffer.alloc(4);
    if ((await input.read(magic, 0, 4, 0)).bytesRead !== 4 || magic.toString('latin1') !== 'fLaC') return null;

    // walk the metadata blocks, remembering where each one starts
    const blocks = [];
    const head = Buffer.alloc(4);
    let off = 4, last = false;
    while (!last) {
      if ((await input.read(head, 0, 4, off)).bytesRead !== 4) return null;
      last = !!(head[0] & 0x80);
      blocks.push({ type: head[0] & 0x7f, len: (head[1] << 16) | (head[2] << 8) | head[3], at: off });
      off += 4 + blocks[blocks.length - 1].len;
    }
    const audioStart = off;

    const drop = blocks.filter((b) => b.type === 6 && b.len > MAX_EMBEDDED_ART);
    if (drop.length === 0) return null;
    const keep = blocks.filter((b) => drop.indexOf(b) === -1);
    if (!keep.some((b) => b.type === 0)) return null; // never leave a file without STREAMINFO

    const tmp = filePath + '.arttmp';
    output = await fs.promises.open(tmp, 'w');
    try {
      await output.write(Buffer.from('fLaC', 'latin1'));
      keep.forEach((b, i) => {
        b.last = i === keep.length - 1;
      });
      for (const b of keep) {
        const buf = Buffer.alloc(4 + b.len);
        await input.read(buf, 0, buf.length, b.at);
        // whichever block now comes last has to carry the last-block flag
        buf[0] = b.last ? (buf[0] | 0x80) : (buf[0] & 0x7f);
        await output.write(buf);
      }
      const chunk = Buffer.alloc(1 << 20); // these run to tens of MB - copy in chunks
      let pos = audioStart;
      while (true) {
        const { bytesRead } = await input.read(chunk, 0, chunk.length, pos);
        if (!bytesRead) break;
        await output.write(chunk, 0, bytesRead);
        pos += bytesRead;
      }
    } finally {
      if (output) { await output.close(); output = null; }
    }
    await input.close();
    input = null;
    await fs.promises.rename(tmp, filePath);
    return { removedBytes: drop.reduce((a, b) => a + b.len, 0) };
  } catch (e) {
    return { error: e.message };
  } finally {
    if (output) { try { await output.close(); } catch (e) { /* already closed */ } }
    if (input) { try { await input.close(); } catch (e) { /* already closed */ } }
  }
}

app.whenReady().then(() => {
  openLog();
  loadState();
  logEvent('session.start', {
    logFile: LOG_FILE,
    downloadPath,
    stateDir: STATE_DIR,
    speedLimitKBps: config.speedLimitKBps,
    scanFolderForExisting: config.scanFolderForExisting,
    manifestEntries: Object.keys(manifest).length,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch
  });
  // Fix 1: register exactly once here, not inside createWindow - macOS's
  // app.on('activate') can call createWindow again and would otherwise
  // double-register this listener, doubling every download side effect.
  session.defaultSession.on('will-download', handleWillDownload);

  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  quitting = true;
  // Remove the icon on the way out rather than leaving a ghost in the tray
  // until the shell next repaints it.
  if (tray && !tray.isDestroyed()) { tray.destroy(); tray = null; }
});

app.on('window-all-closed', async () => {
  // Pause rather than cancel: a cancelled DownloadItem takes its partial file
  // with it, and that file is exactly what the next launch resumes from.
  quitting = true;
  liveItems.forEach((rec) => {
    try { rec.item.pause(); } catch (e) { /* already finished */ }
  });
  await Promise.resolve(saveTransfers.flush());
  // the queue and manifest writes are debounced (and now async); land them
  // before the process actually quits.
  await Promise.resolve(saveManifest.flush());
  await Promise.resolve(saveQueue.flush());
  await Promise.resolve(flushReports());
  logEvent('session.end', { uptimeMs: Date.now() - SESSION_START });
  if (logStream) logStream.end();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
