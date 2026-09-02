const { app, BrowserWindow, session, ipcMain, dialog, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const crypto = require('crypto');

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
const LOG_DIR = path.join(app.getAppPath(), 'logs');
const SESSION_START = Date.now();
const LOG_FILE = path.join(
  LOG_DIR,
  `session-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jsonl`
);
let logStream = null;

function openLog() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    logStream.on('error', (err) => console.error('[logger] write failed:', err.message));
  } catch (err) {
    console.error('[logger] could not open', LOG_FILE, '-', err.message);
  }
}

function logEvent(evt, data = {}) {
  let line;
  try {
    line = JSON.stringify({ ts: new Date().toISOString(), t: Date.now() - SESSION_START, evt, ...data });
  } catch (err) {
    // never let a circular or oversized payload take the app down
    line = JSON.stringify({ ts: new Date().toISOString(), t: Date.now() - SESSION_START,
                            evt: 'log.error', of: evt, message: err.message });
  }
  if (logStream) logStream.write(line + '\n');
  if (!app.isPackaged && process.env.LF_VERBOSE) console.log(line);
}

ipcMain.on('log', (event, payload) => {
  if (payload && typeof payload.evt === 'string') logEvent(payload.evt, payload.data || {});
});
ipcMain.handle('get-log-path', () => LOG_FILE);

process.on('uncaughtException', (err) => {
  logEvent('error.main', { message: err.message, stack: (err.stack || '').split('\n').slice(0, 6).join(' | ') });
});

// ---------------------------------------------------------------------------
// Persistent state
//
//   state/config.json   - download path + speed limit, so settings outlive a run
//   state/queue.json    - the live queue, so a closed app resumes where it left
//   state/manifest.json - every completed download, keyed by track
//   state/cache/*.json  - scraped result lists, so re-pasting a link costs no fetch
//
// All of it is small and rewritten wholesale. Writes go through a temp file and a
// rename: these files are read back on the next launch, and a crash mid-write that
// left truncated JSON behind would lose the queue it was meant to protect.
// ---------------------------------------------------------------------------
const STATE_DIR = path.join(app.getAppPath(), 'state');
const CACHE_DIR = path.join(STATE_DIR, 'cache');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const QUEUE_FILE = path.join(STATE_DIR, 'queue.json');
const MANIFEST_FILE = path.join(STATE_DIR, 'manifest.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_CONFIG = { downloadPath: null, speedLimitKBps: 0, scanFolderForExisting: false };
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
const saveQueue = debounced((snap) => writeJson(QUEUE_FILE, snap), 400);

function loadState() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { /* reported on first write */ }
  config = Object.assign({}, DEFAULT_CONFIG, readJson(CONFIG_FILE, {}));
  downloadPath = config.downloadPath || app.getPath('downloads');
  manifest = readJson(MANIFEST_FILE, {}) || {};

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

ipcMain.on('queue-save', (event, snap) => saveQueue(snap));
ipcMain.handle('queue-load', () => readJson(QUEUE_FILE, null));
ipcMain.on('queue-clear', () => {
  saveQueue.cancel(); // otherwise the in-flight debounce writes the file straight back
  try { fs.unlinkSync(QUEUE_FILE); } catch (e) { /* nothing to clear */ }
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
const JSON_HOSTS = ['api.deezer.com'];

ipcMain.handle('http-json', async (event, url) => {
  let u;
  try { u = new URL(String(url)); } catch (e) { throw new Error('bad url'); }
  if (u.protocol !== 'https:' || JSON_HOSTS.indexOf(u.hostname) === -1) {
    logEvent('http.blocked', { url: String(url).slice(0, 200) });
    throw new Error('host not allowed: ' + u.hostname);
  }
  const started = Date.now();
  const res = await net.fetch(u.href);
  const text = await res.text();
  logEvent('http.json', { host: u.hostname, path: u.pathname, status: res.status,
                          bytes: text.length, ms: Date.now() - started });
  if (!res.ok) throw new Error('http ' + res.status);
  try { return JSON.parse(text); } catch (e) { throw new Error('bad json from ' + u.hostname); }
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
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

// must match the sanitisation applied when a download is actually saved, below
function folderFor(folderName) {
  return folderName ? path.join(downloadPath, folderName.replace(/[<>:"/\\|?*]+/g, '_')) : downloadPath;
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

let nextDownloadContext = null;

ipcMain.on('set-next-download-folder', (event, context) => {
  nextDownloadContext = context;
});

ipcMain.handle('get-download-path', () => {
  return downloadPath;
});

// Standalone "save this artwork" action from the results/queue artwork
// popup's right-click menu. Deliberately separate from will-download/
// nextDownloadContext - this is a one-off save-as, not a queued track,
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
  // Capture the context now: it belongs to THIS download, and the renderer
  // overwrites it as soon as the next queue item is navigated to.
  const ctx = nextDownloadContext;
  nextDownloadContext = null;

  const fileName = item.getFilename();
  let savePath = path.join(downloadPath, fileName);

  if (ctx && ctx.folderName) {
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

  const rec = { item, allowed: 0, last: Date.now(), throttled: false, mark: 0 };
  liveItems.add(rec);
  startThrottleTimer();
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
      reportCache.delete(path.join(folderFor(ctx.folderName), REPORT_NAME));
    }

    // Durable writes above happen before this UI send (defense in depth: a
    // destroyed-window throw here, now guarded by toUI, can never skip them).
    toUI('download-status', { file: item.getFilename(), status: state,
      service: ctx && ctx.attemptService || null, itemId: ctx && ctx.itemId || null, savePath });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    backgroundColor: '#0a0a0b',
    webPreferences: {
      webviewTag: true,
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenu(null);
  mainWindow.once('ready-to-show', () => mainWindow.show());
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', async () => {
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
