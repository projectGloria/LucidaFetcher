import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { Controller } from '../src/engine/controller.mjs';
import { DownloadTracker } from '../src/engine/electron-bridge.mjs';
import { Pool } from '../src/engine/pool.mjs';
import { Worker } from '../src/engine/worker.mjs';
import { attachPersistence, startEngine } from '../src/engine/renderer-integration.mjs';

const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const track = id => ({ id, key: id, title: 'Song', artist: 'Artist', searchVariants: ['Song Artist'] });
const step = { source: 'lucida', service: 'qobuz', query: 'Song Artist' };

function retryController(t, run, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const controller = new Controller({
    services: ['qobuz'], concurrency: 1, keepTrying: true,
    retryDelayMs: 100, retryMaxDelayMs: 400,
    getWorker: () => ({ run }), ...options,
  });
  t.after(() => controller.dispose());
  return controller;
}

test('keep trying repeats entire failed passes until success without retrying completed tracks', async t => {
  const attempts = new Map();
  const c = retryController(t, async item => {
    const n = (attempts.get(item.id) || 0) + 1;
    attempts.set(item.id, n);
    return { outcome: item.id === 'done' || n === 3 ? 'completed' : 'no-results' };
  });
  c.add([track('done'), track('missing')]);
  await drain();
  assert.equal(c.getItem('missing').status, 'skipped');
  assert.equal(c.retryAt, Date.now() + 100);
  t.mock.timers.tick(100);
  await drain();
  assert.equal(attempts.get('missing'), 2);
  assert.equal(c.retryAt, Date.now() + 200);
  t.mock.timers.tick(200);
  await drain();
  assert.equal(c.getItem('missing').status, 'completed');
  assert.equal(attempts.get('done'), 1);
  assert.equal(c.retryAt, null);
});

test('keep trying waits for detached transfers as well as the search pool', async t => {
  let finish;
  const c = retryController(t, async item => ({ outcome: item.id === 'moving' ? 'transferring' : 'no-results' }), {
    awaitTransfer: () => new Promise(resolve => { finish = resolve; }),
  });
  c.add([track('missing'), track('moving')]);
  await drain();
  assert.equal(c.pool.activeCount, 0);
  assert.equal(c.retryAt, null);
  finish({ status: 'completed' });
  await drain();
  assert.equal(c.retryAt, Date.now() + 100);
});

test('pause, disable, removal and cancel all clear automatic retries', async t => {
  let runs = 0;
  const c = retryController(t, async () => { runs++; return { outcome: 'no-results' }; });
  c.add(track('missing'));
  await drain();
  c.pause();
  t.mock.timers.tick(1000);
  await drain();
  assert.equal(runs, 1);
  c.resume();
  assert.notEqual(c.retryAt, null);
  c.setKeepTrying(false);
  assert.equal(c.retryAt, null);
  c.setKeepTrying(true);
  c.cancelAll();
  t.mock.timers.tick(1000);
  await drain();
  assert.equal(runs, 1);
  c.setKeepTrying(true);
  c.remove('missing');
  assert.equal(c.retryAt, null);
});

test('automatic retries do not revive cancelled tracks and have bounded backoff', async t => {
  const seen = [];
  const c = retryController(t, async item => { seen.push(item.id); return { outcome: 'no-results' }; });
  c.pause();
  c.add([track('missing'), track('cancelled')]);
  c.cancel('cancelled');
  c.resume();
  await drain();
  for (const delay of [100, 200, 400, 400]) {
    assert.equal(c.retryAt, Date.now() + delay);
    t.mock.timers.tick(delay);
    await drain();
  }
  assert.equal(seen.includes('cancelled'), false);
});

test('default queues never retry automatically and enabling it handles an already finished queue', async t => {
  const c = retryController(t, async () => ({ outcome: 'no-results' }), { keepTrying: false });
  c.add(track('missing'));
  await drain();
  assert.equal(c.retryAt, null);
  c.setKeepTrying(true);
  assert.equal(c.retryAt, Date.now() + 100);
});

test('empty enabled sources do not spin an automatic retry loop', async t => {
  const c = retryController(t, async () => { assert.fail('No enabled source'); }, { services: [] });
  c.add(track('missing'));
  await drain();
  assert.equal(c.getItem('missing').status, 'skipped');
  assert.equal(c.retryAt, null);
});

test('retrying a large queue emits once and clears stale progress for every missing track', () => {
  const c = new Controller();
  c.pause();
  c.add(Array.from({ length: 1000 }, (_, i) => track(String(i))));
  for (const rec of c.items.values()) Object.assign(rec, { status: 'skipped', receivedBytes: 99, progress: 0.9 });
  let notifications = 0;
  c.subscribe(() => notifications++);
  assert.equal(c.retrySkipped({ force: true }), 1000);
  assert.equal(notifications, 1);
  assert.ok(c.getItems().every(rec => rec.receivedBytes === 0 && rec.progress === null));
  c.dispose();
});

test('giving up on an adopted transfer aborts its orphaned waiter before resubmission', async () => {
  let signal;
  const c = new Controller({ awaitTransfer: (_id, s) => { signal = s; return new Promise(() => {}); } });
  c.pause();
  c.adoptTransfer(track('resume'));
  assert.equal(c.failTransfer('resume'), true);
  assert.equal(signal.aborted, true);
  assert.equal(c.pool.pending, 1);
  c.dispose();
});

test('tracker releases abort listeners on start, completion, timeout and disposal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ipc = new EventEmitter();
  const tracker = new DownloadTracker(ipc, { startTimeoutMs: 100 });
  const ctl = new AbortController();
  const started = tracker.awaitStart('a', ctl.signal);
  assert.equal(getEventListeners(ctl.signal, 'abort').length, 1);
  ipc.emit('download-started', null, { itemId: 'a', file: 'song.flac' });
  await started;
  assert.equal(getEventListeners(ctl.signal, 'abort').length, 0);
  const done = tracker.await('a', ctl.signal);
  ipc.emit('download-status', null, { itemId: 'a', file: 'song.flac', status: 'completed', bytes: 42 });
  assert.equal((await done).bytes, 42);
  assert.equal(getEventListeners(ctl.signal, 'abort').length, 0);
  const timed = tracker.await('b', ctl.signal);
  t.mock.timers.tick(100);
  assert.equal(await timed, null);
  assert.equal(getEventListeners(ctl.signal, 'abort').length, 0);
  const pending = tracker.awaitStart('c', ctl.signal);
  tracker.dispose();
  assert.equal(await pending, null);
  assert.equal(ipc.eventNames().length, 0);
  assert.equal(getEventListeners(ctl.signal, 'abort').length, 0);
});

test('tracker handles pre-aborted signals and replacement waiters without orphaned promises', async () => {
  const tracker = new DownloadTracker(new EventEmitter());
  const ctl = new AbortController();
  ctl.abort();
  assert.equal(await tracker.await('a', ctl.signal), null);
  assert.equal(await tracker.awaitStart('a', ctl.signal), null);
  assert.equal(tracker.waiters.size + tracker.startWaiters.size, 0);
  const previous = tracker.await('b');
  const next = tracker.await('b');
  assert.equal(await previous, null);
  tracker.dispose();
  assert.equal(await next, null);
});

test('tracker keeps concurrent completions with identical filenames separate', async () => {
  const ipc = new EventEmitter();
  const tracker = new DownloadTracker(ipc);
  const a = tracker.await('a');
  const b = tracker.await('b');
  for (const itemId of ['a', 'b']) ipc.emit('download-started', null, { itemId, file: 'same.flac' });
  ipc.emit('download-status', null, { itemId: 'a', file: 'same.flac', status: 'completed', savePath: 'folder-a' });
  ipc.emit('download-status', null, { itemId: 'b', file: 'same.flac', status: 'completed', savePath: 'folder-b' });
  assert.equal((await a).savePath, 'folder-a');
  assert.equal((await b).savePath, 'folder-b');
  tracker.dispose();
});

test('cancelling navigation and injection promptly releases the worker listener and context', async () => {
  for (const phase of ['navigation', 'injection']) {
    const listeners = new Set();
    let resets = 0, clears = 0;
    const view = {
      webContentsId: 1, navigate() {}, reset() { resets++; },
      onDomReady(cb) { listeners.add(cb); return () => listeners.delete(cb); },
      executeJavaScript: () => new Promise(() => {}),
    };
    const ipc = { setDownloadContext() {}, clearDownloadContext() { clears++; }, cancelDownload() {} };
    const worker = new Worker({ slot: 0, view, ipc });
    const ctl = new AbortController();
    const running = worker.run(track('a'), step, ctl.signal);
    if (phase === 'injection') { for (const listener of [...listeners]) listener(); await drain(); }
    ctl.abort();
    await assert.rejects(running, /aborted/);
    assert.equal(listeners.size, 0);
    assert.equal(clears, 1);
    assert.ok(resets > 0);
    assert.equal(getEventListeners(ctl.signal, 'abort').length, 0);
  }
});

test('synchronous navigation failure still releases the armed DOM listener', async () => {
  const listeners = new Set();
  const worker = new Worker({ slot: 0,
    view: { webContentsId: 1, navigate() { throw new Error('gone'); },
      onDomReady(cb) { listeners.add(cb); return () => listeners.delete(cb); } },
    ipc: { setDownloadContext() {}, clearDownloadContext() {} },
  });
  assert.equal((await worker.run(track('a'), step)).outcome, 'error');
  assert.equal(listeners.size, 0);
});

test('shrinking the pool waits until total active work falls below its new limit', async () => {
  const releases = new Map();
  const pool = new Pool({ concurrency: 3, run: item => new Promise(resolve => releases.set(item.id, resolve)) });
  pool.submit(['a', 'b', 'c', 'd'].map(track));
  await drain();
  pool.setConcurrency(1);
  releases.get('a')();
  await drain();
  assert.equal(pool.activeCount, 2);
  assert.equal(releases.has('d'), false);
  releases.get('b')(); releases.get('c')();
  await drain();
  releases.get('d')();
  await pool.onIdle();
});

test('a requeued active id never owns two pool slots at once', async () => {
  let runs = 0;
  let release;
  const pool = new Pool({ concurrency: 2, run: () => {
    runs++;
    return runs === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  } });
  pool.submit(track('a'));
  await drain();
  pool.requeueFront(track('a'));
  await drain();
  assert.equal(runs, 1);
  release();
  await pool.onIdle();
  assert.equal(runs, 2);
  assert.equal(new Set(pool._freeSlots).size, 2);
});

test('cancelling a paused queue resolves idle waiters without requiring resume', async () => {
  const pool = new Pool({ run() { assert.fail('Paused'); } });
  pool.pause();
  pool.submit(track('a'));
  const idle = pool.onIdle();
  pool.cancel('a');
  await idle;
});

test('persistence disposal releases both its subscription and IPC listener', () => {
  const c = new Controller();
  const ipc = new EventEmitter();
  ipc.send = () => {};
  const dispose = attachPersistence(c, ipc);
  dispose();
  assert.equal(c._listeners.size, 0);
  assert.equal(ipc.listenerCount('flush-state'), 0);
  c.dispose();
});

test('engine pause and resume control actual transfers and engine disposal releases IPC listeners', () => {
  const ipc = new EventEmitter();
  const sent = [];
  ipc.send = (...args) => sent.push(args);
  const views = [{ remove() {} }];
  const c = startEngine({ ipcRenderer: ipc, container: { querySelectorAll: () => views }, concurrency: 1 });
  c.pause(); c.resume();
  assert.ok(sent.some(([channel]) => channel === 'downloads-pause'));
  assert.ok(sent.some(([channel]) => channel === 'downloads-resume'));
  c.dispose();
  assert.equal(ipc.eventNames().length, 0);
});

const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const excerpt = (from, to) => main.slice(main.indexOf(from), main.indexOf(to));

test('state writes preserve call order, freeze snapshots and serialize queue deletion', async () => {
  const files = new Map();
  const writes = [];
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const sandbox = { path, process, setTimeout, logEvent() {}, fs: { promises: {
    mkdir: async () => {}, writeFile: async (file, data) => { files.set(file, data); },
    rename: async (tmp, file) => { if (!writes.length) await gate; writes.push(files.get(tmp)); files.set(file, files.get(tmp)); files.delete(tmp); },
    unlink: async file => { files.delete(file); },
  } } };
  vm.runInNewContext(excerpt('const stateWrites =', '// Debounce with flush'), sandbox);
  const value = { n: 1 };
  const first = sandbox.writeJson('queue.json', value);
  value.n = 2;
  const second = sandbox.writeJson('queue.json', value);
  await drain();
  assert.equal(writes.length, 0);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(writes, ['{"n":1}', '{"n":2}']);
  const third = sandbox.writeJson('queue.json', { n: 3 });
  const cleared = sandbox.queueStateWrite('queue.json', () => sandbox.fs.promises.unlink('queue.json'));
  await Promise.all([third, cleared]);
  assert.equal(files.has('queue.json'), false);
});

test('debounce flush waits for a write that has already started', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sandbox = { setTimeout, clearTimeout, Promise };
  vm.runInNewContext(excerpt('function debounced(', 'const saveManifest ='), sandbox);
  const save = sandbox.debounced(() => gate, 0);
  save();
  await new Promise(resolve => setTimeout(resolve, 5));
  let flushed = false;
  const flush = save.flush().then(() => { flushed = true; });
  await drain();
  assert.equal(flushed, false);
  release();
  await flush;
  assert.equal(flushed, true);
});

test('response limits stop chunked bodies before buffering the entire response', async () => {
  let cancelled = false, reads = 0, released = false;
  const sandbox = { Buffer };
  vm.runInNewContext(excerpt('async function boundedBytes(', "ipcMain.handle('http-json'"), sandbox);
  const response = { headers: { get: () => null }, body: { getReader: () => ({
    read: async () => { reads++; return { done: false, value: Buffer.alloc(4) }; },
    cancel: async () => { cancelled = true; }, releaseLock() { released = true; },
  }) } };
  await assert.rejects(sandbox.boundedBytes(response, 'example', 5), /too large/);
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

test('save paths preserve existing music, exceed 99 collisions, and sanitize DOS device filenames', () => {
  const sandbox = { path, process, WINDOWS_RESERVED: /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i,
    liveSavePaths: new Map(), fs: { existsSync: file => !file.endsWith(' (150).flac') } };
  vm.runInNewContext(excerpt('function savePathKey(', '// Fix 1: extracted'), sandbox);
  assert.equal(sandbox.safeBaseName('CON.flac'), '_CON.flac');
  assert.equal(sandbox.safeBaseName('CON .flac'), '_CON .flac');
  assert.equal(sandbox.safeBaseName('track.flac. '), 'track.flac');
  assert.equal(sandbox.freeSavePath(path.resolve('song.flac'), {}), path.resolve('song (150).flac'));
});

function downloadHarness({ repair = async () => null, valid = true, artwork = true, identity = async () => ({ ok: true }) } = {}) {
  const messages = [];
  const files = new Set();
  const context = { itemId: 'a', key: 'key-a', title: 'Song', attemptService: 'qobuz' };
  const sandbox = {
    path, Date, process, MEDIA_HOSTS: /soundcloud|youtube/,
    WINDOWS_RESERVED: /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i,
    downloadPath: path.resolve('downloads'),
    pendingContexts: new Map(), liveSavePaths: new Map(), liveItems: new Set(), finalizingDownloads: new Set(),
    manifest: {}, quitting: false, URL,
    fs: { existsSync: file => files.has(file), mkdirSync() {}, unlinkSync: file => files.delete(file), statSync: () => ({ size: 42 }), promises: { unlink: async file => files.delete(file) } },
    takeDownloadContext: () => ({ ...context }), takeResumeContext: () => null,
    downloadSourceEnabled: () => true, forgetTransfer() {}, rememberTransfer() {}, startThrottleTimer() {},
    userPaused: false, logEvent() {}, toUI: (...args) => messages.push(args),
    isFlacFile: () => valid, isCompleteFlacFile: () => valid, hasEmbeddedArtwork: () => artwork,
    checkDownloadIdentity: identity,
    partialSize: file => files.has(file) ? 42 : 0,
    stripOversizedArtwork: repair, saveManifest() {}, writeReport() {},
  };
  vm.runInNewContext(excerpt('function savePathKey(', '// ---------------------------------------------------------------------------\n// System tray'), sandbox);
  const item = () => {
    const download = new EventEmitter();
    Object.assign(download, {
      getFilename: () => 'song.flac', getURL: () => 'https://cdn.example/song.flac',
      getReceivedBytes: () => 42, getTotalBytes: () => 42, getMimeType: () => 'audio/flac',
      setSavePath: file => { download.savePath = file; files.add(file); }, isPaused: () => false,
    });
    return download;
  };
  const event = { preventDefault() { event.rejected = true; } };
  return { sandbox, context, item, messages, event, files };
}

test('download finalization holds its save path through asynchronous metadata repair', async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const h = downloadHarness({ repair: () => gate });
  const a = h.item();
  h.sandbox.handleWillDownload(h.event, a, {});
  a.emit('done', null, 'completed');
  assert.equal(h.sandbox.finalizingDownloads.size, 1);
  assert.equal(h.sandbox.liveSavePaths.size, 1);
  const b = h.item();
  h.context.itemId = 'b'; h.context.key = 'key-b';
  h.sandbox.handleWillDownload(h.event, b, {});
  assert.notEqual(a.savePath, b.savePath);
  finish(null);
  await Promise.all([...h.sandbox.finalizingDownloads]);
  assert.equal(h.sandbox.liveSavePaths.has(a.savePath), false);
  assert.equal(h.sandbox.manifest['key-a'].bytes, 42);
  assert.equal(h.messages.find(([channel]) => channel === 'download-status')[1].status, 'completed');
  assert.equal(h.messages.find(([channel]) => channel === 'download-status')[1].bytes, 42);
});

test('a finalization error settles the renderer and releases the path rather than hanging the queue', async () => {
  const h = downloadHarness({ repair: async () => { throw new Error('disk unavailable'); } });
  const item = h.item();
  h.sandbox.handleWillDownload(h.event, item, {});
  item.emit('done', null, 'completed');
  await Promise.all([...h.sandbox.finalizingDownloads]);
  assert.equal(h.sandbox.liveSavePaths.size, 0);
  assert.equal(h.sandbox.finalizingDownloads.size, 0);
  assert.equal(h.messages.at(-1)[1].status, 'finalize-failed');
});

test('a download that cannot open its destination reports failure before claiming resources', () => {
  const h = downloadHarness();
  const item = h.item();
  item.setSavePath = () => { throw new Error('permission denied'); };
  h.sandbox.handleWillDownload(h.event, item, {});
  assert.equal(h.event.rejected, true);
  assert.equal(h.sandbox.liveItems.size, 0);
  assert.equal(h.sandbox.liveSavePaths.size, 0);
  assert.equal(h.messages.at(-1)[1].status, 'save-failed');
});

test('rejected FLAC content never becomes a manifest entry', async () => {
  for (const options of [{ valid: false }, { artwork: false }]) {
    const h = downloadHarness(options);
    const item = h.item();
    h.sandbox.handleWillDownload(h.event, item, {});
    item.emit('done', null, 'completed');
    await Promise.all([...h.sandbox.finalizingDownloads]);
    assert.equal(Object.keys(h.sandbox.manifest).length, 0);
    assert.equal(h.files.size, 0);
    assert.match(h.messages.at(-1)[1].status, /^rejected-/);
  }
});

test('a wrong recording is deleted and rejected before manifest and metadata repair', async () => {
  let repaired = false;
  const h = downloadHarness({ identity: async () => ({ ok: false, reason: 'different title' }), repair: async () => { repaired = true; } });
  const item = h.item(); h.sandbox.handleWillDownload(h.event, item, {});
  item.emit('done', null, 'completed');
  await Promise.all([...h.sandbox.finalizingDownloads]);
  assert.equal(h.messages.at(-1)[1].status, 'rejected-track-identity');
  assert.equal(h.files.size, 0); assert.equal(h.sandbox.liveSavePaths.size, 0);
  assert.equal(Object.keys(h.sandbox.manifest).length, 0); assert.equal(repaired, false);
});

function throttleHarness() {
  let now = 0;
  const sandbox = { setInterval, clearInterval, config: { speedLimitKBps: 0 },
    Date: { now: () => now }, logEvent() {}, mainWindow: null, quitting: false };
  vm.runInNewContext(excerpt('const THROTTLE_TICK_MS =', 'function setPaused('), sandbox);
  vm.runInNewContext('globalThis.records = liveItems; globalThis.pauseUser = value => { userPaused = value; };', sandbox);
  let resumes = 0, cancels = 0, received = 0;
  const rec = { itemId: 'a', lastByteAt: 0, lastReceived: 0, last: 0, allowed: 0, resumeAttempts: 0,
    item: { getReceivedBytes: () => received, canResume: () => true,
      resume: () => { resumes++; }, cancel: () => { cancels++; } } };
  sandbox.records.add(rec);
  return { sandbox, rec, time: value => { now = value; }, bytes: value => { received = value; },
    get resumes() { return resumes; }, get cancels() { return cancels; } };
}

test('interrupted downloads resume a bounded number of times before failing over', () => {
  const h = throttleHarness();
  for (let i = 0; i < 4; i++) {
    h.rec.interrupted = true; h.rec.resumeAt = 0;
    h.sandbox.throttleTick();
  }
  assert.equal(h.resumes, 3);
  assert.equal(h.cancels, 1);
  assert.equal(h.rec.failureReason, 'interrupted');
});

test('stall detection excludes explicit pauses, speed-limit pauses, and transfers still receiving bytes', () => {
  const h = throttleHarness();
  h.sandbox.pauseUser(true);
  h.time(200000); h.sandbox.throttleTick();
  assert.equal(h.cancels, 0);
  h.sandbox.pauseUser(false);
  h.rec.throttled = true;
  h.time(400000); h.sandbox.throttleTick();
  assert.equal(h.cancels, 0);
  h.time(600000); h.bytes(1); h.sandbox.throttleTick();
  assert.equal(h.cancels, 0);
  h.time(720001); h.sandbox.throttleTick();
  assert.equal(h.cancels, 1);
  assert.equal(h.rec.failureReason, 'stalled');
});
