const { app, BrowserWindow, session, ipcMain, dialog, net, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

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
  // Scrub at the point of logging, not just at report time: signed download
  // URLs carry their query string as the credential, and the raw .jsonl is
  // something users inspect directly (grep/jq). This is idempotent with the
  // scrub at report collection time, which exists for older log files written
  // before this write-side guard was added.
  const record = { ts: new Date().toISOString(), t: Date.now() - SESSION_START, evt, ...scrubEvent(data) };
  let line;
  try {
    line = JSON.stringify(record);
  } catch (err) {
    // never let a circular or oversized payload take the app down
    line = JSON.stringify({ ts: record.ts, t: record.t, evt: 'log.error', of: evt, message: err.message });
  }
  recentEvents.push(line);
  if (recentEvents.length > RECENT_CAP) recentEvents.splice(0, recentEvents.length - RECENT_CAP);
  if (logStream && !logStream.writableEnded && !logStream.destroyed) logStream.write(line + '\n');
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

// ---------------------------------------------------------------------------
// Keeping credentials out of the log
//
// The diagnostics report redacts the config block it renders - and then printed
// the raw event tail underneath it verbatim, which is where the credentials
// actually were. `set-config` logged its patch as-is, so typing a Jamendo
// client ID wrote it (and every prefix of it, one per keystroke) straight into
// session-*.jsonl, and from there into a file the user is invited to hand to
// someone else.
//
// So it is scrubbed HERE, on the way in, rather than at the point of rendering:
// there is exactly one log writer and every reader of it - the report, the raw
// tail, a grep over the .jsonl - gets the same guarantee.
//
// Mirrors redactConfig() in src/engine/diagnostics.mjs. Main is CommonJS and
// that module is ESM bundled into the renderer, so the pattern is duplicated
// rather than shared; keep the two in step.
// ---------------------------------------------------------------------------
const SECRET_KEY = /token|secret|password|clientid|key$/i;

/** A settings patch as key names and value shapes, never values. */
function describePatch(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (SECRET_KEY.test(k)) out[k] = v ? `(set, ${String(v).length} chars)` : '(cleared)';
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = '(object)';
    else out[k] = v;
  }
  return out;
}

// A store's resolved download URL is signed and time-limited: the query string
// IS the credential, so the origin and path stay (they are what a diagnosis
// needs) and the rest goes.
function scrubValue(key, value) {
  if (SECRET_KEY.test(key)) return value == null ? value : '(redacted)';
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return value;
  try {
    const u = new URL(value);
    return u.origin + u.pathname + (u.search ? '?(redacted)' : '');
  } catch (e) { return value; }
}

function scrubEvent(evt) {
  if (!evt || typeof evt !== 'object') return evt;
  const out = Array.isArray(evt) ? [] : {};
  for (const [k, v] of Object.entries(evt)) {
    if (v && typeof v === 'object') out[k] = scrubEvent(v);
    else out[k] = scrubValue(k, v);
  }
  return out;
}

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
    logConsoleMessage(contents.id, tag(), level, message, lineNo, sourceId);
  });

  contents.on('destroyed', () => consoleSpam.delete(contents.id));

  // ---- hardening ----------------------------------------------------------
  //
  // The main window runs with nodeIntegration on and contextIsolation off,
  // which is a deliberate choice (the renderer needs require('electron') and
  // there is no preload) but leaves no safety net at all if anything ever
  // reaches that context. These are the nets. Attached centrally for the same
  // reason as the logging above: a webview added later is covered the day it is
  // added, not the day someone notices it is not.

  // Nothing in this app opens a window. A scraped page asking for one is either
  // an ad or a popunder.
  contents.setWindowOpenHandler(({ url }) => {
    logEvent('page.windowOpen.denied', { url: String(url || '').slice(0, 200) });
    return { action: 'deny' };
  });

  // A webview must never be handed Node or a preload, whatever its attributes
  // say. The worker views are created without them today; this makes that a
  // property of the app rather than of one call site.
  contents.on('will-attach-webview', (e, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    // Hidden workers and a tray-hidden window still own active searches.
    webPreferences.backgroundThrottling = false;
    params.allowpopups = false;
  });

  contents.on('unresponsive', () => logEvent('page.unresponsive', tag()));
  contents.on('responsive', () => logEvent('page.responsive', tag()));
});

// A scraped page that gets stuck in a render loop can emit the same warning
// hundreds of times a SECOND (seen live: a lucida.to i18n check re-firing
// faster than this process could otherwise keep up with). Logging every one
// used to mean an unbounded, unthrottled write for every single repeat - on
// the same event loop that also has to service IPC, will-download and every
// other worker's webview, so a page spamming its console was a way for that
// page to degrade the whole app's responsiveness, not just its own. Keyed per
// webContents so one noisy view cannot suppress another's genuinely different
// warning.
// 1, 2, 10, 100, 1000... - a runaway loop stays visible (and diagnostics can
// see it kept going) without a write for every single repeat.
function isSpamMilestone(n) {
  if (n <= 2) return true;
  let p = 10;
  while (p < n) p *= 10;
  return p === n;
}

const consoleSpam = new Map(); // wc id -> { key, count }
function logConsoleMessage(wcId, tag, level, message, lineNo, sourceId) {
  const msg = String(message || '').slice(0, 500);
  const key = level + '|' + msg;
  const st = consoleSpam.get(wcId);
  const isRepeat = st && st.key === key;
  const count = isRepeat ? ++st.count : 1;
  if (!isRepeat) consoleSpam.set(wcId, { key, count: 1 });
  if (!isSpamMilestone(count)) return;
  logEvent('page.console', {
    ...tag, level: CONSOLE_LEVELS[level] || String(level),
    message: msg, source: String(sourceId || '').slice(0, 200), line: lineNo,
    ...(count > 1 ? { repeated: count } : {}),
  });
}

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
  downloadPath: null, speedLimitKBps: 0, scanFolderForExisting: true,
  // Transfers allowed to keep running after the page that started them has
  // moved on to the next search. 0 = a page waits for its own file. A worker
  // waiting at this cap can detach as soon as any existing transfer completes.
  // Mirrors DEFAULT_MAX_TRANSFERS in src/engine/renderer-integration.mjs.
  maxTransfers: 6,
  keepTrying: false,
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
const stateWrites = new Map();

function queueStateWrite(file, operation) {
  const previous = stateWrites.get(file) || Promise.resolve();
  const write = previous.then(operation).catch(e => {
    logEvent('state.error', { file: path.basename(file), message: e.message });
  }).finally(() => {
    if (stateWrites.get(file) === write) stateWrites.delete(file);
  });
  stateWrites.set(file, write);
  return write;
}

function writeJson(file, value, indent) {
  // Freeze the snapshot now; asynchronous mkdir used to serialize a newer
  // mutation, and concurrent renames could then restore an older queue.
  let data;
  try { data = JSON.stringify(value, null, indent || 0); }
  catch (e) {
    logEvent('state.error', { file: path.basename(file), message: e.message });
    return Promise.resolve();
  }
  return queueStateWrite(file, async () => {
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(tmp, data);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await fs.promises.rename(tmp, file);
          break;
        } catch (err) {
          if (attempt === 2) throw err;
          await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
        }
      }
    } catch (e) {
      logEvent('state.error', { file: path.basename(file), message: e.message });
    } finally {
      try { await fs.promises.unlink(tmp).catch(() => {}); } catch {}
    }
  });
}

// Debounce with flush and cancel. State is written on every queue mutation, but a
// pending write still has to land before the app quits (flush), and must not
// resurrect a file the renderer has just cleared (cancel).
function debounced(fn, ms) {
  let timer = null, pending = null;
  let inFlight = Promise.resolve();
  const run = () => {
    timer = null;
    if (pending) {
      const args = pending;
      pending = null;
      // Submit now so a later queue-clear enters the same write lane AFTER
      // this snapshot, even if a previous write is still in progress.
      inFlight = Promise.all([inFlight, Promise.resolve(fn.apply(null, args))]).then(() => undefined);
    }
    return inFlight;
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
        durationSec: ctx.durationSec || null, isrc: ctx.isrc || null,
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
  if (config.scanFolderForExisting === false) config.scanFolderForExisting = true;
  downloadPath = config.downloadPath || app.getPath('downloads');
  manifest = readJson(MANIFEST_FILE, {}) || {};
  transfers = readJson(TRANSFERS_FILE, {}) || {};

  // Bound manifest growth by dropping entries whose file is gone - but not on
  // the critical path. See pruneManifest.
  setTimeout(() => { pruneManifest().catch(() => {}); }, 2000);
  setTimeout(() => { cleanLeftoverPartFiles(downloadPath).catch(err => logEvent('cleanup.failed', { message: err.message })); }, 2500);
}

async function cleanLeftoverPartFiles(dir) {
  // A library can have thousands of folders. Walk asynchronously, and leave
  // current/resumable transfers alone even if they have a partial extension.
  const protectedPaths = new Set(Object.values(transfers).filter(t => t?.savePath).map(t => savePathKey(t.savePath)));
  const folders = [dir];
  while (folders.length) {
    if (quitting) return;
    let entries;
    const folder = folders.pop();
    try { entries = await fs.promises.opendir(folder); } catch { continue; }
    for await (const ent of entries) {
      if (quitting) return;
      const full = path.join(folder, ent.name);
      if (ent.isDirectory()) { folders.push(full); continue; }
      if (!ent.isFile() || !/\.(part|crdownload)$/i.test(ent.name)) continue;
      const key = savePathKey(full);
      if (protectedPaths.has(key) || liveSavePaths.has(key)) continue;
      try {
        const stat = await fs.promises.stat(full);
        if (stat.mtimeMs >= SESSION_START || liveSavePaths.has(key)) continue;
        await fs.promises.unlink(full);
        logEvent('cleanup.part', { file: full });
      } catch { /* disappeared or inaccessible */ }
    }
  }
}

/**
 * Drop manifest entries whose file no longer exists.
 *
 * Asynchronous, and deliberately after the window is up: this used to be one
 * synchronous existsSync per entry before anything was drawn, and the manifest
 * holds one entry per download the user has ever made, so the delay scaled with
 * the size of their library.
 *
 * Skipped entirely when the download root itself cannot be read. An external or
 * network drive that is not mounted yet is not evidence that the files are
 * gone, and treating it as such wiped the whole manifest and re-fetched a
 * library that was already on disk.
 */
const PRUNE_BAIL_RATIO = 0.5;   // share of a sizeable manifest that means "library moved"
const PRUNE_BAIL_FLOOR = 20;    // below this, losing them all is cheap and probably real

async function pruneManifest() {
  const root = path.resolve(downloadPath);
  try {
    if (!(await fs.promises.stat(root)).isDirectory()) return;
  } catch (e) {
    logEvent('manifest.prune.skipped', { reason: 'download-root-unavailable' });
    return;
  }

  // Decided first, applied second. The root existing is NOT enough on its own:
  // an empty-but-present folder is what a re-created download directory, a
  // re-pointed setting or a drive mounted without its contents all look like,
  // and pruning against one wipes the record of a library that is still there.
  // Observed doing exactly that: 997 of 997 entries dropped in one pass.
  //
  // Files really do get deleted a few at a time. They do not all vanish at
  // once, so "all of them are gone" is evidence about the FOLDER, not about the
  // files - and the manifest is worth far more than the bytes it costs to keep.
  const keys = Object.keys(manifest);
  const missing = [];
  for (const key of keys) {
    const rec = manifest[key];
    if (!rec || !rec.savePath) continue;
    try { await fs.promises.access(rec.savePath); }
    catch (e) { missing.push(key); }
  }
  if (!missing.length) return;

  if (keys.length >= PRUNE_BAIL_FLOOR && missing.length >= keys.length * PRUNE_BAIL_RATIO) {
    logEvent('manifest.prune.skipped', {
      reason: 'too-many-missing', missing: missing.length, entries: keys.length,
      downloadPath: root,
    });
    return;
  }

  for (const key of missing) delete manifest[key];
  saveManifest();
  logEvent('manifest.pruned', { pruned: missing.length, remaining: Object.keys(manifest).length });
}

function saveConfig() {
  config.downloadPath = downloadPath;
  writeJson(CONFIG_FILE, config);
}

ipcMain.handle('get-config', () => Object.assign({}, config, { downloadPath, stateDir: STATE_DIR }));

ipcMain.on('set-config', (event, patch) => {
  const next = Object.assign({}, patch || {});

  // downloadPath is owned by select-directory, which sets the module variable
  // that saveConfig() writes back - so merging it here used to be silently
  // discarded one line later. Honour it, but only if it names a real directory.
  if ('downloadPath' in next) {
    const wanted = String(next.downloadPath || '');
    delete next.downloadPath;
    if (wanted && path.resolve(wanted) !== path.resolve(downloadPath)) {
      try {
        if (fs.statSync(wanted).isDirectory()) downloadPath = path.resolve(wanted);
        else logEvent('settings.downloadPath.rejected', { reason: 'not-a-directory' });
      } catch (err) {
        logEvent('settings.downloadPath.rejected', { message: err.message });
      }
    }
  }

  Object.assign(config, next);
  saveConfig();
  logEvent('settings.change', describePatch(next));
});

ipcMain.on('queue-save', (event, snap, immediate = false) => {
  if (immediate) { saveQueue.cancel(); writeJson(QUEUE_FILE, snap); }
  else saveQueue(snap);
});
ipcMain.handle('queue-load', () => readJson(QUEUE_FILE, null));
ipcMain.on('queue-clear', () => {
  saveQueue.cancel(); // otherwise the in-flight debounce writes the file straight back
  queueStateWrite(QUEUE_FILE, () => fs.promises.unlink(QUEUE_FILE).catch(e => { if (e.code !== 'ENOENT') throw e; }));
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
  queueStateWrite(HISTORY_FILE, () => fs.promises.unlink(HISTORY_FILE).catch(e => { if (e.code !== 'ENOENT') throw e; }));
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

// A request that never answers is worse than one that fails: an IPC handler
// that never settles leaves the renderer's promise pending forever, which in
// the import flow is a spinner with no timeout and no cancel.
const HTTP_TIMEOUT_MS = 20000;
const MAX_JSON_BYTES = 8 * 1024 * 1024;

/**
 * A response body, refusing anything oversized before it is buffered.
 *
 * `res.text()` / `res.arrayBuffer()` buffer whatever arrives, so an endpoint
 * that answers with gigabytes is a way to exhaust the main process.
 */
async function boundedBytes(res, host, limit) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > limit) { await res.body?.cancel(); throw new Error('response too large from ' + host); }
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('response too large from ' + host); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally { reader.releaseLock(); }
}

async function boundedText(res, host, limit = MAX_JSON_BYTES) {
  return (await boundedBytes(res, host, limit)).toString('utf8');
}

ipcMain.handle('http-json', async (event, url) => {
  let u;
  try { u = new URL(String(url)); } catch (e) { throw new Error('bad url'); }
  const allows = Object.prototype.hasOwnProperty.call(JSON_HOSTS, u.hostname) && JSON_HOSTS[u.hostname];
  if (u.protocol !== 'https:' || !allows || !allows(u.pathname)) {
    logEvent('http.blocked', { url: String(url).slice(0, 200) });
    throw new Error('host not allowed: ' + u.hostname);
  }
  const started = Date.now();
  // `redirect: 'error'`, because the allowlist above is checked exactly once.
  // net.fetch follows redirects by default, so an allowed host that redirects -
  // and soundcloud's oEmbed takes the pasted link as a query parameter, so its
  // destination is not entirely ours to choose - could reach anywhere, which is
  // exactly the general purpose proxy this allowlist exists to prevent. Both
  // endpoints here answer directly; a redirect from either is a reason to stop.
  const res = await net.fetch(u.href, {
    redirect: 'error',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await boundedText(res, u.hostname);
  logEvent('http.json', { host: u.hostname, path: u.pathname, status: res.status,
                          bytes: text.length, ms: Date.now() - started });
  // A 404 is an ANSWER, not a failure: SoundCloud's oEmbed returns one for a
  // private or deleted upload, and every caller here already handles a null
  // page. Throwing made Electron log a stack per missing cover.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('http ' + res.status);
  try { return JSON.parse(text); } catch (e) { throw new Error('bad json from ' + u.hostname); }
});

const MEDIA_HOSTS = /(^|\.)(soundcloud\.com|snd\.sc|youtube\.com|youtu\.be|music\.youtube\.com)$/i;

// Enforce the same source policy at the process boundary, including old queues.
function downloadSourceEnabled(service) {
  return ['qobuz', 'tidal', 'amazon', 'deezer', 'yandex', 'monochrome'].includes(service)
    && (config.fallbackServices || ['amazon']).includes(service);
}

function isFlacFile(file) {
  if (!/\.flac$/i.test(file || '')) return false;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(4);
    return fs.readSync(fd, header, 0, 4, 0) === 4 && header.toString('ascii') === 'fLaC';
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Format magic alone also matches partial downloads. Check the metadata chain,
// STREAMINFO and the first audio frame; recorded completed files must retain
// their known byte length. Chromium supplies completion for new transfers.
function isCompleteFlacFile(file, expectedBytes = 0) {
  if (!isFlacFile(file)) return false;
  let fd;
  try {
    const size = fs.statSync(file).size;
    if (expectedBytes > 0 && size !== expectedBytes) return false;
    if (size < 44) return false;
    fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(8);
    if (fs.readSync(fd, header, 0, 8, 0) !== 8 || header.toString('ascii', 0, 4) !== 'fLaC'
        || (header[4] & 0x7f) !== 0 || header.readUIntBE(5, 3) !== 34) return false;
    const stream = Buffer.alloc(34);
    if (fs.readSync(fd, stream, 0, 34, 8) !== 34 || !stream.readUInt16BE(0)) return false;
    // STREAMINFO's total samples may legally be zero (unknown). Completion
    // comes from Chromium or the recorded file length, not that optional count.
    const block = Buffer.alloc(4);
    let at = 4, last = false, count = 0;
    while (!last) {
      if (++count > 10000 || at + 4 > size || fs.readSync(fd, block, 0, 4, at) !== 4) return false;
      last = !!(block[0] & 0x80);
      at += 4 + block.readUIntBE(1, 3);
      if (at > size) return false;
    }
    const frame = Buffer.alloc(2);
    return at + 2 < size && fs.readSync(fd, frame, 0, 2, at) === 2 && frame[0] === 0xff && (frame[1] & 0xfe) === 0xf8;
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// A FLAC with no embedded PICTURE metadata block is rejected: artwork is part of
// what makes a download worth keeping, and a file without it is incomplete.
// Walks the same header chain as stripOversizedArtwork but synchronously and
// without reading block bodies - only the 4-byte headers are touched.
function hasEmbeddedArtwork(file) {
  if (!/\.flac$/i.test(file || '')) return false;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const magic = Buffer.alloc(4);
    if (fs.readSync(fd, magic, 0, 4, 0) !== 4 || magic.toString('ascii') !== 'fLaC') return false;
    const head = Buffer.alloc(4);
    let off = 4, last = false;
    while (!last) {
      if (fs.readSync(fd, head, 0, 4, off) !== 4) return false;
      last = !!(head[0] & 0x80);
      const type = head[0] & 0x7f;
      if (type === 6) return true;   // PICTURE block found
      const len = (head[1] << 16) | (head[2] << 8) | head[3];
      off += 4 + len;
    }
    return false;
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

const mediaTransfers = new Map();
ipcMain.on('download-cancel-item', (event, itemId) => {
  for (const [id, ctx] of pendingContexts) if (ctx.itemId === itemId) pendingContexts.delete(id);
  mediaTransfers.get(itemId)?.abort();
  for (const rec of liveItems) {
    if (rec.itemId === itemId) { try { rec.item.cancel(); } catch {} }
  }
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
const AUDIO_EXT = /\.flac$/i;

// Reserved DOS device names. Illegal as a file or directory name on Windows
// with or without an extension. Mirrored by sanitizeFolder in
// src/engine/sources.mjs, which names the same folders on the renderer side.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Stroked/ligature letters have no NFD decomposition and remain letters after
// normalisation, so they must be folded explicitly - the same table as FOLD in
// src/engine/matching.mjs, whose normWith() this mirrors. A first version folded
// inside a replace that only matched NON-letters, so it never fired: "Bjørn"
// tokenised as "bjørn" here but "bjorn" in the engine, and the folder scan could
// not match a transliterated filename.
const FOLD_CHARS = {
  'ł':'l','ø':'o','đ':'d','ð':'d','þ':'th','æ':'ae','œ':'oe',
  'ß':'ss','ı':'i','ħ':'h','ŋ':'n','ŧ':'t','ĸ':'k',
};

function normTokens(s) {
  return String(s || '').normalize('NFKD').replace(/(\p{Script=Latin})\p{M}+/gu, '$1').normalize('NFC')
    .toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]|[łøđðþæœßıħŋŧĸ]/gu, (c) => FOLD_CHARS[c] || ' ')
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
    let safe = part.replace(/[<>:"|?*\x00-\x1f]+/g, '_').replace(/[. ]+$/g, '').trim();
    if (!safe || safe === '.' || safe === '..') safe = '_';
    // A reserved DOS device name is not a legal directory on Windows whatever
    // its extension, so mkdir fails and the whole playlist ends up with nowhere
    // to go. "AUX" is a plausible album title; the rest are here for free.
    if (WINDOWS_RESERVED.test(safe.split('.')[0].trim())) safe = safe.replace(/^([^.]*)/, '$1_');
    return safe;
  }).filter(Boolean);
  if (!segments.length) return root;
  const candidate = path.resolve(root, ...segments);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return path.join(root, '_');
  return candidate;
}

function checkDownloaded(q, names = null, scan = false) {
  if (!q) return { done: false };
  const rec = q.key ? manifest[q.key] : null;
  const pendingPath = file => Object.values(transfers).some(t => t?.savePath && savePathKey(t.savePath) === savePathKey(file));
  if (q.savePath && q.bytes > 0 && !pendingPath(q.savePath) && isCompleteFlacFile(q.savePath, q.bytes) && hasEmbeddedArtwork(q.savePath)) {
    const service = rec?.savePath && savePathKey(rec.savePath) === savePathKey(q.savePath) ? rec.service : null;
    return { done: true, file: path.basename(q.savePath), savePath: q.savePath, bytes: q.bytes, via: 'recorded-file', service: service || null };
  }
  if (rec && rec.savePath) {
    if (pendingPath(rec.savePath)) return { done: false };
    if (!['youtube', 'soundcloud'].includes(rec.service) && isCompleteFlacFile(rec.savePath, rec.bytes) && hasEmbeddedArtwork(rec.savePath)) return { done: true, file: rec.file, via: 'manifest', service: rec.service || null, sourceUrl: rec.sourceUrl || null, savePath: rec.savePath, bytes: rec.bytes || null };
    delete manifest[q.key]; // gone from disk - let it download again
    saveManifest();
  }
  if (!scan) return { done: false };
  const want = normTokens(`${q.artist || ''} ${q.title || ''}`).join(' ');
  const reversed = normTokens(`${q.title || ''} ${q.artist || ''}`).join(' ');
  if (!q.artist || !q.title) return { done: false };
  if (!names) return { done: false };
  for (const candidate of names) {
    const f = candidate.file;
    const have = candidate.tokens;
    const savePath = candidate.savePath || path.join(folderFor(q.folderName), f);
    if (!pendingPath(savePath) && (want === have.join(' ') || reversed === have.join(' '))) {
      return { done: true, file: f, savePath, bytes: candidate.bytes || null, via: 'scan' };
    }
  }
  return { done: false };
}

async function isFlacFileAsync(file) {
  if (!/\.flac$/i.test(file || '')) return false;
  let handle;
  try {
    handle = await fs.promises.open(file, 'r');
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    return bytesRead === 4 && header.toString('ascii') === 'fLaC';
  } catch { return false; }
  finally { if (handle) await handle.close().catch(() => {}); }
}

let scanEnginesPromise = null;
function getScanEngines() {
  if (!scanEnginesPromise) {
    scanEnginesPromise = Promise.all([
      import('./src/engine/flac-identity.mjs'),
      import('./src/engine/matching.mjs'),
    ]).then(([flac, matching]) => ({ ...flac, ...matching }));
  }
  return scanEnginesPromise;
}

// Recursively scan downloadPath (and any target folders) for valid, complete
// FLAC files with embedded artwork so existing tracks in any subfolder are not
// downloaded a second time.
let activeFolderScan = null;
function scanDownloadFolders(extraDirs = []) {
  if (activeFolderScan) return activeFolderScan;
  const run = (async () => {
    const { readFlacIdentity } = await getScanEngines();
    const protectedPaths = new Set(Object.values(transfers).filter(t => t?.savePath).map(t => savePathKey(t.savePath)));
    const visited = new Set();
    const queue = [path.resolve(downloadPath), ...extraDirs.map(d => path.resolve(d))];
    const entries = [];
    while (queue.length) {
      const dir = queue.shift();
      const dKey = savePathKey(dir);
      if (visited.has(dKey)) continue;
      visited.add(dKey);
      let dirEntries;
      try { dirEntries = await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch { continue; }
      for (const ent of dirEntries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          queue.push(full);
        } else if (ent.isFile() && AUDIO_EXT.test(ent.name)) {
          const fKey = savePathKey(full);
          if (!protectedPaths.has(fKey) && !liveSavePaths.has(fKey)) {
            entries.push({ file: ent.name, dir, dirKey: dKey, savePath: full, key: fKey });
          }
        }
      }
    }
    const hasDupSuffix = name => /(?:\s+\(\d+\)|\s+\[[0-9a-f]{6,10}\])+$/i.test(path.parse(name).name);
    entries.sort((a, b) => (Number(hasDupSuffix(a.file)) - Number(hasDupSuffix(b.file))) || a.file.localeCompare(b.file));

    // Large libraries used to open every file at once, exhausting handles
    // and reporting valid downloads as missing when open failed with EMFILE.
    const flacs = [];
    for (let start = 0; start < entries.length; start += 16) {
      const batch = await Promise.all(entries.slice(start, start + 16).map(async (entry) => {
        const { savePath: file, key } = entry;
        if (protectedPaths.has(key) || liveSavePaths.has(key)) return null;
        let stat;
        try { stat = await fs.promises.stat(file); } catch { return null; }
        const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        const prev = flacIdentityCache.get(key);
        const record = (prev && prev.stamp === stamp && typeof prev.valid === 'boolean')
          ? prev
          : await (async () => {
            const valid = await isFlacFileAsync(file) && isCompleteFlacFile(file) && hasEmbeddedArtwork(file);
            const next = valid
              ? { stamp, valid: true, identity: readFlacIdentity(file) }
              : { stamp, valid: false, identity: null };
            flacIdentityCache.set(key, next);
            if (next.identity) {
              next.identity.catch(() => { if (flacIdentityCache.get(key) === next) flacIdentityCache.delete(key); });
            }
            while (flacIdentityCache.size > 4000) flacIdentityCache.delete(flacIdentityCache.keys().next().value);
            return next;
          })();
        if (!record.valid) return null;
        const identity = record.identity ? await record.identity.catch(() => null) : null;
        const cleanBase = path.parse(entry.file).name.replace(/(?:\s+\(\d+\)|\s+\[[0-9a-f]{6,10}\])+$/i, '');
        return {
          file: entry.file,
          dir: entry.dir,
          dirKey: entry.dirKey,
          savePath: file,
          bytes: stat.size,
          cleanBase,
          tokens: normTokens(cleanBase),
          identity,
        };
      }));
      flacs.push(...batch.filter(Boolean));
    }
    return flacs;
  })();
  activeFolderScan = run;
  return run.finally(() => { if (activeFolderScan === run) activeFolderScan = null; });
}

// Restart recovery uses recorded lengths and transfer records because a
// partial FLAC already has valid format magic. All other checks scan the
// download directory and its subfolders for existing completed FLACs.
ipcMain.handle('downloads-check', async (event, list, opts) => {
  const checks = list || [];
  // Startup must use durable completions or interrupted-transfer records. An
  // untracked, truncated audio file cannot be proven complete by a folder scan.
  const scan = !opts?.restore && opts?.scan !== false && (opts?.scan !== undefined ? !!opts.scan : config.scanFolderForExisting !== false);
  const results = checks.map((q) => checkDownloaded(q));
  const validateIndexes = async (indexes) => {
    for (let start = 0; start < indexes.length; start += 8) {
      const slice = indexes.slice(start, start + 8);
      const batch = await Promise.all(slice.map(async (index) => {
        const q = checks[index];
        const result = results[index];
        if (!result.done || !q?.title || !result.savePath) return result;
        const identity = await checkDownloadIdentity(result.savePath, q).catch(() => ({ ok: false }));
        return identity.ok ? result : { done: false, reason: 'track-identity' };
      }));
      batch.forEach((result, offset) => {
        const index = slice[offset], q = checks[index], previous = results[index];
        if (result.reason === 'track-identity' && q.key && manifest[q.key]?.savePath === previous.savePath) {
          delete manifest[q.key]; saveManifest();
        }
        results[index] = result;
      });
    }
    return results;
  };
  await validateIndexes(checks.map((_, i) => i));
  if (!scan) return results;

  // The folder scan runs only for the tracks the manifest could not answer.
  const wanted = [];
  checks.forEach((q, i) => {
    if (q && !results[i].done && q.title && q.artist) wanted.push(i);
  });
  if (!wanted.length) return results;

  const extraDirs = [...new Set(wanted.map(i => folderFor(checks[i].folderName)))];
  const allFlacs = await scanDownloadFolders(extraDirs);
  const { compareFlacIdentity, score, isAcceptable } = await getScanEngines();
  const pendingPath = file => Object.values(transfers).some(t => t?.savePath && savePathKey(t.savePath) === savePathKey(file));

  for (const i of wanted) {
    const q = checks[i];
    const targetDirKey = savePathKey(folderFor(q.folderName));
    const inTarget = [];
    const inOther = [];
    for (const c of allFlacs) {
      if (pendingPath(c.savePath)) continue;
      if (c.identity && !compareFlacIdentity(c.identity, q).ok) continue;
      if (c.dirKey === targetDirKey) inTarget.push(c);
      else inOther.push(c);
    }
    const ordered = [...inTarget, ...inOther];
    let match = checkDownloaded(q, ordered, true);
    if (!match.done) {
      for (const c of ordered) {
        if (c.identity && c.identity.title && c.identity.artist && compareFlacIdentity(c.identity, q).ok) {
          match = { done: true, file: c.file, savePath: c.savePath, bytes: c.bytes, via: 'scan' };
          break;
        }
        const sep = c.cleanBase.indexOf(' - ');
        if (sep > 0) {
          const fileArtist = c.cleanBase.slice(0, sep).trim();
          const fileTitle = c.cleanBase.slice(sep + 3).trim();
          if (fileArtist && fileTitle && isAcceptable(score(q, fileTitle, fileArtist, c.identity?.durationSec))) {
            match = { done: true, file: c.file, savePath: c.savePath, bytes: c.bytes, via: 'scan' };
            break;
          }
        }
      }
    }
    results[i] = match;
  }

  await validateIndexes(wanted);

  // A scan hit is a guess the manifest should not have to make twice. Backfill
  // it as a real entry so the NEXT launch (or the next check of this same
  // track) finds it by key instead of re-tokenizing the folder.
  let backfilled = false;
  results.forEach((res, i) => {
    const q = checks[i];
    if (!res.done || res.via !== 'scan' || !q) return;
    const savePath = res.savePath || path.join(folderFor(q.folderName), res.file);
    let bytes = res.bytes || null;
    if (!bytes) {
      try { bytes = fs.statSync(savePath).size; } catch (e) { /* stat failed, keep null */ }
    }
    res.savePath = savePath;
    res.bytes = bytes;
    if (!q.key || manifest[q.key]) return;
    manifest[q.key] = { file: res.file, savePath, bytes, at: new Date().toISOString(),
      service: null, format: path.extname(res.file).slice(1), sourceUrl: null, mediaUrl: null, licenseUrl: null };
    backfilled = true;
  });
  if (backfilled) saveManifest();

  return results;
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
  return Promise.all(writes).then(() => evictReports());
}

function saveReportSoon(file) {
  dirtyReports.add(file);
  clearTimeout(reportFlushTimer);
  reportFlushTimer = setTimeout(flushReports, 500);
}

// Folders whose reports stay parsed in memory. A profile download touches one
// per playlist and nothing used to drop them, so a forty-playlist run held
// forty whole reports for the rest of the session. Insertion order, so the
// least recently created goes first - and an entry with unwritten changes is
// never dropped, because the cache IS the pending write.
const REPORT_CACHE_MAX = 24;

function evictReports() {
  if (reportCache.size <= REPORT_CACHE_MAX) return;
  for (const file of [...reportCache.keys()]) {
    if (reportCache.size <= REPORT_CACHE_MAX) break;
    if (dirtyReports.has(file) || stateWrites.has(file)) continue;
    reportCache.delete(file);
  }
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
  evictReports();
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

let libraryEnginePromise = null;
function getLibraryEngine() {
  if (!libraryEnginePromise) {
    libraryEnginePromise = import('./src/engine/profile-output.mjs');
  }
  return libraryEnginePromise;
}

ipcMain.handle('profile-library-load', async (event, folderName) => {
  if (!folderName) return { version: 1, profile: {}, tracks: {}, playlists: [] };
  try {
    const { loadValidatedLibrary } = await getLibraryEngine();
    const dir = folderFor(folderName);
    return await loadValidatedLibrary(dir, async (file, bytes, track) =>
      isCompleteFlacFile(file, bytes) && hasEmbeddedArtwork(file) &&
      !Object.values(transfers).some(t => t?.savePath && savePathKey(t.savePath) === savePathKey(file)) &&
      (await checkDownloadIdentity(file, track)).ok);
  } catch (err) {
    logEvent('profile.library.load.error', { folder: folderName, message: err.message });
    return { version: 1, profile: {}, tracks: {}, playlists: [] };
  }
});

// A copy/validation pass can take longer than the renderer's update interval.
// Retain one latest snapshot per destination while its current pass finishes.
const pendingProfileSyncs = new Map();
ipcMain.on('profile-library-sync', (event, payload) => {
  if (!payload || !payload.folderName || !payload.state) return;
  const profileDir = folderFor(payload.folderName);
  const key = savePathKey(profileDir);
  const existing = pendingProfileSyncs.get(key);
  if (existing) { existing.state = structuredClone(payload.state); return; }
  const pending = { state: structuredClone(payload.state) };
  pendingProfileSyncs.set(key, pending);
  // Register before the dynamic import so quit waits for the entire output.
  queueStateWrite(path.join(profileDir, 'profile-output'), async () => {
    try {
      const { syncProfileLibrary } = await getLibraryEngine();
      while (pending.state) {
        const state = pending.state;
        pending.state = null;
        try {
          await syncProfileLibrary(profileDir, state, {
            validateFile: (file, bytes) => isCompleteFlacFile(file, bytes) && hasEmbeddedArtwork(file),
            saveArtwork: (url, file) => { downloadArtwork(url, file); },
            sourceFolder: folderFor,
            reserveCopy: file => {
              const targetKey = savePathKey(file);
              if (liveSavePaths.has(targetKey)) return null;
              const owner = {};
              liveSavePaths.set(targetKey, owner);
              return () => { if (liveSavePaths.get(targetKey) === owner) liveSavePaths.delete(targetKey); };
            },
          });
          logEvent('profile.library.synced', { folder: payload.folderName, playlists: state.playlists.length });
        } catch (error) {
          logEvent('profile.library.sync.failed', { folder: payload.folderName, message: error.message });
        }
      }
    } finally { pendingProfileSyncs.delete(key); }
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
// Events one report may carry. A long session runs to tens of thousands of
// lines, and every one of them used to be parsed on the main thread and then
// structured-cloned across the IPC boundary - a multi-second freeze triggered
// by the button someone presses when something is already wrong. The newest are
// the ones worth having, so the oldest go.
const MAX_REPORT_EVENTS = 20000;

/**
 * A session log as events, newest-biased and bounded.
 *
 * Streamed rather than read whole: readFileSync blocked the same event loop
 * that services IPC, will-download and every worker webview, and split('\n')
 * plus JSON.parse held three copies of the file at once.
 */
async function readSessionEvents(file, cap = MAX_REPORT_EVENTS) {
  let handle;
  try { handle = await fs.promises.open(file, 'r'); } catch (e) { return null; }
  const events = [];
  try {
    const rl = readline.createInterface({
      input: handle.createReadStream({ encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch (e) { /* a half-written last line */ }
      // Trimmed in batches, not per line: splicing on every line past the cap
      // would be quadratic on exactly the long sessions this exists to survive.
      if (events.length >= cap * 2) events.splice(0, events.length - cap);
    }
  } catch (e) {
    logEvent('diagnostics.read.failed', { file: path.basename(file), message: e.message });
  } finally {
    try { await handle.close(); } catch (e) { /* already gone */ }
  }
  if (events.length > cap) events.splice(0, events.length - cap);
  return events;
}

ipcMain.handle('diagnostics-collect', async (event, opts = {}) => {
  // Flush first: the last few events are usually the interesting ones, and a
  // stream that has not drained would leave them out of the very report they
  // were meant to explain.
  //
  // Bounded, because a stream that has ERRORED never drains: the write returns
  // false, 'drain' never fires, and the report a user reached for because the
  // disk filled up would be the one call that never came back.
  await new Promise((resolve) => {
    if (!logStream) { resolve(); return; }
    if (logStream.write('')) { resolve(); return; }
    const done = () => {
      clearTimeout(timer);
      logStream.removeListener('drain', done);
      logStream.removeListener('error', done);
      logStream.removeListener('close', done);
      resolve();
    };
    const timer = setTimeout(done, 2000);
    logStream.once('drain', done);
    logStream.once('error', done);
    logStream.once('close', done);
  });

  let events = await readSessionEvents(LOG_FILE);
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
      for (const f of older) before.push(...((await readSessionEvents(path.join(LOG_DIR, f))) || []));
      events = before.concat(events);
    } catch (e) { /* the current session is still worth reporting */ }
  }

  if (events.length > MAX_REPORT_EVENTS) events.splice(0, events.length - MAX_REPORT_EVENTS);

  // Scrubbed ONCE, here, so the summary and the raw tail below it cannot
  // disagree about what is safe to print. Older log files were written before
  // the scrub existed, so this is not redundant with the write-side one.
  events = events.map(scrubEvent);

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
  const result = await dialog.showSaveDialog(mainWindow, {
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
  const result = await dialog.showOpenDialog(mainWindow, {
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
  if (id) { pendingContexts.set(id, context); return; }
  // A WORKER context with no id must not silently fall back to the shared slot.
  // viewAdapter returns null for webContentsId whenever getWebContentsId()
  // throws, and two workers landing here would overwrite each other - which is
  // the single-slot corruption this map was introduced to end, reintroduced
  // through the back door. Refuse it: the attempt fails and the chain retries,
  // which is recoverable, where filing a file under the wrong track is not.
  if (context && context.itemId) {
    logEvent('download.context.rejected', { itemId: context.itemId, reason: 'no-webContentsId' });
    return;
  }
  // Genuinely context-free: a direct link opened in the main window.
  fallbackContext = context;
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
//
// Same posture as downloadArtwork below, for the same reason: the URL comes
// from scraped content. An earlier version handed it straight to net.request -
// no protocol or private-host check, no response cap, and no timeout, so a
// connection that never answered left the renderer's promise pending forever.
ipcMain.handle('download-artwork', async (event, { url, suggestedName }) => {
  if (!url) return { ok: false, error: 'No artwork URL.' };
  let u;
  try { u = new URL(String(url)); } catch (e) { return { ok: false, error: 'Not a valid artwork URL.' }; }
  if (u.protocol !== 'https:' || PRIVATE_HOST.test(u.hostname)) {
    logEvent('artwork.blocked', { host: u.hostname, protocol: u.protocol, via: 'save-as' });
    return { ok: false, error: 'That artwork URL is not allowed.' };
  }
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

  try {
    const { buf, url: finalUrl } = await safeFetchImage(u.href);
    await fs.promises.writeFile(result.filePath, buf);
    logEvent('artwork.saved', { url: finalUrl.origin + finalUrl.pathname, savePath: result.filePath });
    return { ok: true, savePath: result.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function showItemOrFolder(payload) {
  try {
    const { savePath: itemSavePath, folderName } = payload || {};
    if (itemSavePath && fs.existsSync(itemSavePath)) {
      shell.showItemInFolder(path.resolve(itemSavePath));
      return { ok: true };
    }
    const folder = folderName ? folderFor(folderName) : downloadPath;
    if (!fs.existsSync(folder)) return { ok: false, error: 'That folder does not exist yet.' };
    shell.openPath(path.resolve(folder));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

ipcMain.handle('open-item-folder', (event, payload) => showItemOrFolder(payload));
ipcMain.on('open-item-folder', (event, payload) => showItemOrFolder(payload));

ipcMain.handle('open-path', async (event, targetPath) => {
  try {
    if (!targetPath || typeof targetPath !== 'string') return { ok: false, error: 'Invalid path' };
    const resolved = path.resolve(targetPath);
    if (!fs.existsSync(resolved)) return { ok: false, error: 'That path does not exist.' };
    const err = await shell.openPath(resolved);
    if (err) return { ok: false, error: err };
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
const finalizingDownloads = new Set();
const DOWNLOAD_STALL_MS = 120000;
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
  const perItemLimit = liveItems.size > 0 ? limit / liveItems.size : limit;

  liveItems.forEach((rec) => {
    const item = rec.item;
    let received;
    try { received = item.getReceivedBytes(); } catch (e) { liveItems.delete(rec); return; }
    if (received !== rec.lastReceived || userPaused || rec.throttled || quitting) {
      rec.lastByteAt = now;
      rec.lastReceived = received;
    }
    if (userPaused || quitting) { rec.last = now; return; }
    if (rec.interrupted) {
      if (now < rec.resumeAt) return;
      if (rec.resumeAttempts >= 3 || !item.canResume()) {
        rec.failureReason = 'interrupted';
        try { item.cancel(); } catch { /* already terminal */ }
      } else {
        rec.resumeAttempts++;
        rec.resumeAt = now + 1000 * 2 ** rec.resumeAttempts;
        rec.interrupted = false;
        try { item.resume(); }
        catch { rec.interrupted = true; }
      }
      return;
    }
    if (now - rec.lastByteAt >= DOWNLOAD_STALL_MS) {
      rec.failureReason = 'stalled';
      logEvent('download.stalled', { itemId: rec.itemId, received });
      try { item.cancel(); } catch { /* already terminal */ }
      return;
    }

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

    rec.allowed += perItemLimit * (now - rec.last) / 1000;
    rec.last = now;
    // never bank more than a second of headroom, or a long pause would be followed
    // by an unthrottled burst as the budget is spent
    if (rec.allowed > received + perItemLimit) rec.allowed = received + perItemLimit;

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
const MAX_ARTWORK_BYTES = 12 * 1024 * 1024;

// Hosts nothing on the open internet should be resolving to. An artwork URL
// arrives from a scraped page, so it is attacker-influenceable in a way the
// rest of this file's URLs are not; a per-CDN allowlist would be brittle
// (Spotify, Deezer, SoundCloud and YouTube all serve art from rotating
// hostnames), so the check is on where it is allowed to POINT instead.
const PRIVATE_HOST = /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd])/i;

/**
 * The folder's cover.jpg.
 *
 * Deliberately strict: this is the one outbound request in the app whose URL
 * comes from scraped content rather than from a fixed endpoint, and it used to
 * be an unvalidated net.fetch whose entire response was buffered and written to
 * disk whatever it was.
 */
async function safeFetchImage(initialUrl, maxBytes = MAX_ARTWORK_BYTES, timeoutMs = 15000) {
  let currentUrl;
  try { currentUrl = new URL(String(initialUrl)); } catch (e) {
    throw new Error('Invalid artwork URL');
  }
  const maxRedirects = 5;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (currentUrl.protocol !== 'https:' || PRIVATE_HOST.test(currentUrl.hostname)) {
      throw new Error(`Insecure or private host blocked: ${currentUrl.hostname}`);
    }
    const res = await net.fetch(currentUrl.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`Redirect ${res.status} missing location header`);
      currentUrl = new URL(loc, currentUrl);
      continue;
    }
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    const type = String(res.headers.get('content-type') || '');
    if (!/^image\//i.test(type)) throw new Error('Response is not an image');
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error('Image exceeds size limit');
    const buf = await boundedBytes(res, currentUrl.hostname, maxBytes);
    if (buf.length > maxBytes) throw new Error('Image exceeds size limit');
    return { buf, url: currentUrl };
  }
  throw new Error('Too many redirects');
}

const pendingArtworkDownloads = new Map();
const artworkQueue = [];
let activeArtworkDownloads = 0;

function pumpArtwork() {
  while (activeArtworkDownloads < 4 && artworkQueue.length) {
    const task = artworkQueue.shift();
    activeArtworkDownloads++;
    task().finally(() => { activeArtworkDownloads--; pumpArtwork(); });
  }
}

ipcMain.on('playlist-artwork-sync', (event, payload) => {
  if (!payload?.folderName || !payload.url) return;
  downloadArtwork(payload.url, path.join(folderFor(payload.folderName), 'cover.png'));
});

function downloadArtwork(url, artPath) {
  const key = savePathKey(artPath);
  if (pendingArtworkDownloads.has(key)) return pendingArtworkDownloads.get(key);
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  pendingArtworkDownloads.set(key, pending);
  artworkQueue.push(async () => {
    const tmp = `${artPath}.${process.pid}.tmp`;
    try {
      const stat = await fs.promises.stat(artPath).catch(() => null);
      if (stat?.size > 0) return;
      const { buf, url: finalUrl } = await safeFetchImage(url);
      const image = nativeImage.createFromBuffer(buf);
      if (image.isEmpty()) throw new Error('Cannot decode artwork');
      await fs.promises.mkdir(path.dirname(artPath), { recursive: true });
      const encoded = /\.jpe?g$/i.test(artPath) || typeof image.toPNG !== 'function'
        ? image.toJPEG(90)
        : image.toPNG();
      await fs.promises.writeFile(tmp, encoded);
      await fs.promises.rename(tmp, artPath);
      logEvent('artwork.saved', { url: finalUrl.origin + finalUrl.pathname, savePath: artPath });
    } catch (e) {
      logEvent('artwork.error', { url: String(url).slice(0, 120), message: e.message });
    } finally {
      await fs.promises.unlink(tmp).catch(() => {});
      pendingArtworkDownloads.delete(key);
      finish();
    }
  });
  pumpArtwork();
  return pending;
}

const flacIdentityCache = new Map();
async function checkDownloadIdentity(file, context) {
  const { readFlacIdentity, compareFlacIdentity } = await import('./src/engine/flac-identity.mjs');
  const stat = await fs.promises.stat(file);
  const key = savePathKey(file);
  const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  let cached = flacIdentityCache.get(key);
  if (!cached || cached.stamp !== stamp) {
    cached = { stamp, identity: readFlacIdentity(file) };
    flacIdentityCache.set(key, cached);
    cached.identity.catch(() => { if (flacIdentityCache.get(key) === cached) flacIdentityCache.delete(key); });
    while (flacIdentityCache.size > 2000) flacIdentityCache.delete(flacIdentityCache.keys().next().value);
  }
  return compareFlacIdentity(await cached.identity, context);
}

// Paths currently being written to, so two transfers cannot be pointed at one
// file. Keyed by path, valued by the live record that owns it.
const liveSavePaths = new Map();

function savePathKey(file) {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** A filename with no path in it, whatever the server suggested. */
function safeBaseName(name) {
  const base = path.basename(String(name || '').replace(/[\\/]+/g, '_'));
  let safe = base.replace(/[<>:"|?*\x00-\x1f]+/g, '_').replace(/^\.+/, '').trim().replace(/[. ]+$/g, '');
  if (WINDOWS_RESERVED.test(safe.split('.')[0].trim())) safe = '_' + safe;
  return safe || 'download';
}

/** The wanted path, or the first " (n)" variant no live transfer holds. */
function freeSavePath(wanted, rec) {
  const dir = path.dirname(wanted);
  const ext = path.extname(wanted);
  const base = path.basename(wanted, ext);
  let candidate = wanted;
  for (let n = 1; ; n++) {
    const holder = liveSavePaths.get(savePathKey(candidate));
    if (holder === rec || (!holder && !fs.existsSync(candidate))) return candidate;
    candidate = path.join(dir, `${base} (${n})${ext}`);
  }
}

// Fix 1: extracted so it can be registered exactly once, outside createWindow
// (which app.on('activate') can call again on macOS - registering this inside
// it would double every download-completion side effect).
function handleWillDownload(event, item, webContents) {
  // Claim this worker's context. Taking it by webContents rather than from a
  // shared slot is what lets several downloads be in flight at once.
  const ctx = takeDownloadContext(webContents) || takeResumeContext(item);
  let rec = null;
  try {

    // The remote server chose this, via Content-Disposition or the URL. Chromium
    // sanitises what it suggests, but yt-download already checks its own target
    // for containment and this path did not - so it is checked the same way here
    // rather than left as the one place that trusts it.
    const rawName = safeBaseName(item.getFilename());
    const fileName = (ctx?.artist && ctx?.title && /\.flac$/i.test(rawName))
      ? safeBaseName(`${ctx.artist} - ${ctx.title}.flac`)
      : rawName;
    const service = ctx && (ctx.attemptService || ctx.service);
    const blockedUrl = (item.getURLChain?.() || [item.getURL()]).some(url => {
      try { return MEDIA_HOSTS.test(new URL(url).hostname); } catch { return false; }
    });
    if (!downloadSourceEnabled(service) || blockedUrl || !/\.flac$/i.test(fileName)
        || (ctx?.resumed && !/\.flac$/i.test(ctx.savePath || ''))) {
      event.preventDefault();
      forgetTransfer(ctx && ctx.itemId);
      logEvent('download.rejected', { file: fileName, service, reason: 'enabled FLAC sources only' });
      toUI('download-status', { itemId: ctx && ctx.itemId, file: fileName, status: 'rejected-format-or-source' });
      return;
    }
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
        const artPath = path.join(folderPath, 'cover.png');
        if (!fs.existsSync(artPath)) {
          downloadArtwork(ctx.artworkUrl, artPath);
        }
      }
    }

    // A resumed transfer's path is ours, out of transfers.json, and there are
    // already bytes at it - rewriting it would point Chromium at a different file
    // and lose exactly what the resume exists to keep. Only a path built from the
    // server's filename needs checking.
    const resumedPath = !!(ctx && ctx.resumed && ctx.savePath);
    if (!resumedPath) {
      const root = path.resolve(downloadPath);
      const resolved = path.resolve(savePath);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        logEvent('download.path.rejected', { file: fileName, savePath: resolved });
        savePath = path.join(root, fileName);
      } else {
        savePath = resolved;
      }
    }

    // Two LIVE transfers must never share a path. setSavePath is explicit, so
    // Chromium's own " (1)" uniquification does not apply and the second writer
    // would overwrite the first - or, through the interrupted-partial cleanup in
    // 'done' below, delete a file that had already finished.
    let initialReceived = 0;
    try { initialReceived = item.getReceivedBytes() || 0; } catch (e) { /* fresh */ }
    rec = { item, itemId: ctx?.itemId, allowed: initialReceived, last: Date.now(), throttled: false, mark: initialReceived,
      lastReceived: initialReceived, lastByteAt: Date.now(), resumeAttempts: 0, interrupted: false };
    if (!resumedPath) savePath = freeSavePath(savePath, rec);
    rec.savePath = savePath;
    if (resumedPath && liveSavePaths.has(savePathKey(savePath))) throw new Error('Transfer already owns this resume path');

    item.setSavePath(savePath);
    liveSavePaths.set(savePathKey(savePath), rec);

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

    item.on('updated', (_updated, state) => {
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
            // A filename is not unique across concurrent transfers, so the
            // renderer's tracker keys on this and keeps the name only as a
            // fallback for an older main process.
            itemId: ctx && ctx.itemId || null,
            received: item.getReceivedBytes(),
            total: item.getTotalBytes()
          });
        }
      } else if (state === 'interrupted') {
        rec.interrupted = true;
        rec.resumeAt = Date.now() + 1000 * 2 ** rec.resumeAttempts;
        logEvent('download.interrupted', { file: fileName, received: item.getReceivedBytes() });
      }
    });

    item.once('done', (_done, downloadState) => {
      const finishing = (async () => {
        let state = downloadState;
        liveItems.delete(rec);
        if (state !== 'completed' && rec.failureReason) state = rec.failureReason;
        // Keep ownership through validation and asynchronous metadata repair.
        const ownsPath = liveSavePaths.get(savePathKey(savePath)) === rec;
        try {
          if (state === 'completed' && !isCompleteFlacFile(savePath)) {
            state = 'rejected-format';
            if (ownsPath) { try { fs.unlinkSync(savePath); } catch {} }
          }
          if (state === 'completed' && !hasEmbeddedArtwork(savePath)) {
            state = 'rejected-no-artwork';
            if (ownsPath) { try { fs.unlinkSync(savePath); } catch {} }
          }
          if (state === 'completed' && ctx?.title) {
            let identity;
            try { identity = await checkDownloadIdentity(savePath, ctx); }
            catch (err) { identity = { ok: false, reason: err.message }; }
            if (!identity.ok) {
              state = 'rejected-track-identity';
              logEvent('download.identity.rejected', { itemId: ctx.itemId, reason: identity.reason, actual: identity.actual });
              if (ownsPath) await fs.promises.unlink(savePath).catch(() => {});
            }
          }
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
            // Only a partial THIS transfer owns. Deleting by path alone could remove
            // a file another item had already finished at the same name.
            const have = ownsPath ? partialSize(savePath) : 0;
            const total = item.getTotalBytes();
            if (have > 0 && (!total || have < total)) {
              try { fs.unlinkSync(savePath); } catch (e) { /* best effort */ }
            }
          }
          const ms = Date.now() - startedAt;
          const bytes = item.getReceivedBytes();
          let completedBytes;
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
            if (art) logEvent('artwork.resized', Object.assign({ file: fileName }, art));
            // What is actually on disk: stripOversizedArtwork may have just rebuilt
            // the file smaller than the bytes that came down the wire. The manifest
            // used to record the wire count while the folder report re-stated the
            // file - two different numbers for one download.
            const onDisk = (() => { try { return fs.statSync(savePath).size; } catch (e) { return bytes; } })();
            completedBytes = onDisk;
            // What lets a restarted app know this track is already on disk. Keyed by
            // track rather than by filename, because only the renderer knows which
            // queue item a given download belonged to.
            if (ctx && ctx.key) {
              manifest[ctx.key] = { file: path.basename(savePath), savePath, bytes: onDisk, at: new Date().toISOString(),
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
                file: path.basename(savePath),
                bytes: onDisk,
                via: 'download',
                tried: ctx.tried && ctx.tried.length ? ctx.tried : undefined
              });
            }
            // Report eviction is safely managed by evictReports() upon writeReport,
            // avoiding cache deletion races during concurrent playlist downloads.
          }

          // Durable writes above happen before this UI send (defense in depth: a
          // destroyed-window throw here, now guarded by toUI, can never skip them).
          toUI('download-status', { file: path.basename(savePath), status: state,
            service: ctx && ctx.attemptService || null, itemId: ctx && ctx.itemId || null, savePath, bytes: completedBytes ?? bytes });
        } finally {
          // Metadata repair awaits disk I/O; keep the path reserved until it ends.
          if (liveSavePaths.get(savePathKey(savePath)) === rec) liveSavePaths.delete(savePathKey(savePath));
        }
      })().catch(err => {
        logEvent('download.finalize.failed', { itemId: ctx?.itemId, message: err.message });
        toUI('download-status', { itemId: ctx?.itemId, file: fileName, status: 'finalize-failed', savePath });
      }).finally(() => finalizingDownloads.delete(finishing));
      finalizingDownloads.add(finishing);
    });
  } catch (err) {
    event.preventDefault();
    if (rec) {
      liveItems.delete(rec);
      if (rec.savePath && liveSavePaths.get(savePathKey(rec.savePath)) === rec) {
        liveSavePaths.delete(savePathKey(rec.savePath));
      }
    }
    forgetTransfer(ctx?.itemId);
    logEvent('download.setup.failed', { itemId: ctx?.itemId, message: err.message });
    toUI('download-status', { itemId: ctx?.itemId, status: 'save-failed' });
  }
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
let traySig = null;
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
  // Stats change once per status transition, which during a run is often; the
  // menu and tooltip are rebuilds of the same few numbers, so skip the work
  // when nothing they display has moved.
  const sig = JSON.stringify([trayStats, downloadPath]);
  if (sig === traySig) return;
  traySig = sig;
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
    backgroundColor: '#0a0a0c', // must equal --bg in styles.css, or the window flashes a different black on launch
    webPreferences: {
      webviewTag: true,
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
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
  // The main window shows the app's own UI and nothing else, ever. It runs with
  // Node integration and no context isolation, so a navigation away from local
  // content would hand full Node to whatever it landed on. Pin it.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const ok = /^file:/i.test(url) || url.startsWith('http://localhost:5173');
    if (ok) return;
    event.preventDefault();
    logEvent('window.navigation.blocked', { url: String(url || '').slice(0, 200) });
    shell.openExternal(url).catch(() => {}); // the user meant to open a link
  });

  mainWindow.setMenu(null);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Hide instead of close, unless the app is genuinely on its way out. The
  // `quitting` flag is already the app's answer to "is this a real exit?" - it
  // is set by before-quit and by the tray's own Quit - so the tray reuses it
  // rather than inventing a second source of truth that could disagree.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    if (config.closeToTray && tray && !tray.isDestroyed()) {
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
      return;
    }
    // A real close when not running in tray: cleanly flush queue and state before destroying window
    event.preventDefault();
    app.quit(); // before-quit keeps this window alive until its queue snapshot lands
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

/** Every byte of `buf`, however many writes that takes. */
async function writeAll(handle, buf, length) {
  const total = length == null ? buf.length : length;
  let off = 0;
  while (off < total) {
    const { bytesWritten } = await handle.write(buf, off, total - off);
    if (!bytesWritten) throw new Error('short write rebuilding FLAC metadata');
    off += bytesWritten;
  }
}

async function stripOversizedArtwork(filePath) {
  let input = null;
  let output = null;
  // Tracked out here so a failure part-way cannot leave a .arttmp beside the
  // user's music. This rewrites a file in place; the debris is the one thing
  // worse than not rewriting it.
  let tmp = null;
  let renamed = false;
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

    const large = blocks.filter((b) => b.type === 6 && b.len > MAX_EMBEDDED_ART);
    if (large.length === 0) return null;
    const replacements = new Map();
    for (const b of large) {
      const old = Buffer.alloc(b.len);
      if ((await input.read(old, 0, old.length, b.at + 4)).bytesRead !== old.length) throw new Error('short artwork read');
      const mimeLen = old.readUInt32BE(4);
      let pos = 8 + mimeLen;
      const descLen = old.readUInt32BE(pos);
      const desc = old.subarray(pos + 4, pos + 4 + descLen);
      pos += 4 + descLen + 16;
      const dataLen = old.readUInt32BE(pos);
      pos += 4;
      if (pos + dataLen > old.length) throw new Error('truncated PICTURE block');
      let image = nativeImage.createFromBuffer(old.subarray(pos, pos + dataLen));
      if (image.isEmpty()) throw new Error('cannot decode embedded artwork');
      const size = image.getSize();
      if (Math.max(size.width, size.height) > 1024) {
        image = image.resize(size.width >= size.height ? { width: 1024 } : { height: 1024 });
      }
      const jpeg = image.toJPEG(85);
      const mime = Buffer.from('image/jpeg');
      const dims = image.getSize();
      const body = Buffer.alloc(32 + mime.length + desc.length + jpeg.length);
      body.writeUInt32BE(old.readUInt32BE(0), 0);
      body.writeUInt32BE(mime.length, 4); mime.copy(body, 8);
      let at = 8 + mime.length;
      body.writeUInt32BE(desc.length, at); at += 4; desc.copy(body, at); at += desc.length;
      for (const number of [dims.width, dims.height, 24, 0, jpeg.length]) { body.writeUInt32BE(number, at); at += 4; }
      jpeg.copy(body, at);
      if (body.length > MAX_EMBEDDED_ART) throw new Error('resized artwork exceeds limit');
      const rebuilt = Buffer.alloc(4 + body.length);
      rebuilt[0] = 6; rebuilt.writeUIntBE(body.length, 1, 3); body.copy(rebuilt, 4);
      replacements.set(b, rebuilt);
    }
    const keep = blocks;
    if (!keep.some((b) => b.type === 0)) return null; // never leave a file without STREAMINFO

    tmp = filePath + '.arttmp';
    output = await fs.promises.open(tmp, 'w');
    try {
      await writeAll(output, Buffer.from('fLaC', 'latin1'));
      keep.forEach((b, i) => {
        b.last = i === keep.length - 1;
      });
      for (const b of keep) {
        const buf = replacements.get(b) || Buffer.alloc(4 + b.len);
        // A short read here would silently write zeroes into the metadata of a
        // file that is about to replace the user's audio. Checked, not assumed.
        if (!replacements.has(b)) {
          const { bytesRead } = await input.read(buf, 0, buf.length, b.at);
          if (bytesRead !== buf.length) throw new Error('short read rebuilding FLAC metadata');
        }
        // whichever block now comes last has to carry the last-block flag
        buf[0] = b.last ? (buf[0] | 0x80) : (buf[0] & 0x7f);
        await writeAll(output, buf);
      }
      const chunk = Buffer.alloc(1 << 20); // these run to tens of MB - copy in chunks
      let pos = audioStart;
      while (true) {
        const { bytesRead } = await input.read(chunk, 0, chunk.length, pos);
        if (!bytesRead) break;
        await writeAll(output, chunk, bytesRead);
        pos += bytesRead;
      }
    } finally {
      if (output) { await output.close(); output = null; }
    }
    await input.close();
    input = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await fs.promises.rename(tmp, filePath);
        break;
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
      }
    }
    renamed = true;
    return { removedBytes: large.reduce((sum, b) => sum + b.len + 4 - replacements.get(b).length, 0), preservedArtwork: true };
  } catch (e) {
    return { error: e.message };
  } finally {
    if (output) { try { await output.close(); } catch (e) { /* already closed */ } }
    if (input) { try { await input.close(); } catch (e) { /* already closed */ } }
    // The rename consumes tmp on the happy path; anything else leaves it behind.
    if (tmp && !renamed) { try { await fs.promises.unlink(tmp); } catch (e) { /* never created */ } }
  }
}

// ---------------------------------------------------------------------------
// One instance
//
// Two copies both read state/*.json into memory and both rewrite them whole, so
// the second to write wins and the first's completed downloads, queue and
// resume records are simply gone. Easy to hit rather than theoretical: the
// window hides to the tray, so "no window on screen" is this app's ordinary
// state and launching it again from the shortcut is the obvious thing to do.
// ---------------------------------------------------------------------------
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  // Straight out, before the log or any state file is opened - there is nothing
  // to flush and the running copy owns them.
  app.exit(0);
}
app.on('second-instance', () => showWindow());

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
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

// ---------------------------------------------------------------------------
// Landing every debounced write before the process goes
//
// saveQueue, saveManifest, saveTransfers and flushReports are all debounced AND
// async, so "the write was scheduled" and "the write reached the disk" are up
// to a second apart. Nothing used to hold the process open across that gap:
// window-all-closed awaited them, but Electron does not await a listener's
// return value, so the handler returned a pending promise at its first `await`
// and the quit sequence ran on to teardown with the writes still outstanding.
//
// The files lost that way are exactly the ones they exist to protect - the
// resume records for transfers in flight, and the manifest entry for a track
// that finished seconds before the quit.
//
// before-quit is where this belongs rather than window-all-closed, because the
// tray's Quit never closes a window first.
// ---------------------------------------------------------------------------
let flushing = null;
let flushed = false;

function flushAllState() {
  if (flushing) return flushing;
  flushing = (async () => {
    // The renderer holds the queue snapshot, and its persist timer cannot fire
    // once its window goes away. Ask for a final save and give it one turn
    // before flushing - a track that changed status seconds before the quit is
    // exactly the one the next launch most needs to know about.
    toUI('flush-state');
    await new Promise((r) => setTimeout(r, 400));
    // Pause rather than cancel: a cancelled DownloadItem takes its partial file
    // with it, and that file is exactly what the next launch resumes from.
    liveItems.forEach((rec) => {
      try { rec.item.pause(); } catch (e) { /* already finished */ }
    });
    try {
      await Promise.all([...finalizingDownloads]);
      await Promise.all([
        Promise.resolve(saveTransfers.flush()),
        Promise.resolve(saveManifest.flush()),
        Promise.resolve(saveQueue.flush()),
        Promise.resolve(flushReports()),
      ]);
      await Promise.all([...stateWrites.values()]);
      // Artwork is independent of audio transfers, but gets a brief quit flush.
      let artTimer;
      await Promise.race([
        Promise.all([...pendingArtworkDownloads.values()]),
        new Promise(resolve => { artTimer = setTimeout(resolve, 2000); }),
      ]);
      clearTimeout(artTimer);
    } catch (err) {
      logEvent('state.flush.failed', { message: err.message });
    }
    logEvent('session.end', { uptimeMs: Date.now() - SESSION_START });
    // Bounded: a quit must not be able to hang on a stream that will not close.
    await new Promise((resolve) => {
      if (!logStream) { resolve(); return; }
      const timer = setTimeout(resolve, 1500);
      logStream.end(() => { clearTimeout(timer); resolve(); });
    });
  })();
  return flushing;
}

app.on('before-quit', (event) => {
  quitting = true;
  // Remove the icon on the way out rather than leaving a ghost in the tray
  // until the shell next repaints it.
  if (tray && !tray.isDestroyed()) { tray.destroy(); tray = null; }

  // Second pass, once the flush below has finished: let the quit through.
  if (flushed) return;
  event.preventDefault();
  if (flushing) return;
  flushAllState().finally(() => { flushed = true; app.quit(); });
});

app.on('window-all-closed', () => {
  // On macOS an app outlives its windows and this queue is meant to keep
  // running, so closing the window must NOT set `quitting` - which would send
  // every later download down the "interrupted by the quit" branch for the rest
  // of the session - or pause transfers nothing is left to resume.
  if (process.platform === 'darwin') return;
  app.quit(); // before-quit does the flushing
});
