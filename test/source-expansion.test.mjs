import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyCatalogUrl, readCatalog, scrapePublicCatalog } from '../src/engine/public-catalog.mjs';
import { createProvider, matchRecording, API_PROVIDERS } from '../src/engine/providers.mjs';
import { embedArtwork, hasValidArtwork, pictureBytes } from '../src/engine/flac-artwork.mjs';
import { visibleRange } from '../src/engine/virtual-range.mjs';
import { Worker } from '../src/engine/worker.mjs';
import { SourceAccess } from '../src/engine/source-access.mjs';
import { Pool } from '../src/engine/pool.mjs';
import { resourceCache } from '../src/engine/resource-cache.mjs';
import { Controller } from '../src/engine/controller.mjs';
import { createCatalogTransport } from '../src/engine/catalog-http.mjs';
import { attachPersistence } from '../src/engine/renderer-integration.mjs';

test('recognizes public catalog link shapes without accepting lookalike hosts', () => {
  for (const type of ['track', 'album', 'playlist']) {
    assert.equal(classifyCatalogUrl(`https://tidal.com/browse/${type}/123`)?.type, type);
    assert.equal(classifyCatalogUrl(`https://play.qobuz.com/${type}/123`)?.service, 'qobuz');
  }
  assert.equal(classifyCatalogUrl('https://www.qobuz.com/us-en/album/title/abc123').id, 'abc123');
  assert.equal(classifyCatalogUrl('https://tidal.com.evil.test/album/1'), null);
});

test('catalog pagination preserves membership order and reports truncated or circular lists', async () => {
  const track = n => ({ title: `Track ${n}`, artist: 'Artist', id: n, isrc: `ISRC${n}` });
  const pages = [{ name: 'Album', total: 3, tracks: [track(1), track(2)], next: '2' },
    { total: 3, tracks: [track(1)], complete: true }];
  let n = 0;
  const full = await readCatalog({}, { readPage: async () => pages[n++] });
  assert.deepEqual(full.tracks.map(t => t.id), [1, 2, 1]);
  assert.equal(full.warning, null);
  const partial = await readCatalog({}, { readPage: async () => pages[0] });
  assert.equal(partial.complete, false); assert.match(partial.warning, /Partial import/);
  const unknown = await readCatalog({}, { readPage: async () => ({ tracks: [track(1)] }) });
  assert.equal(unknown.complete, false);
  await assert.rejects(readCatalog({}, { readPage: async () => ({ tracks: [] }) }), /private/);
});

test('catalog cancellation is not downgraded into a partial success', async () => {
  const abort = new AbortController();
  await assert.rejects(readCatalog({}, { signal: abort.signal, readPage: async () => {
    abort.abort(); throw abort.signal.reason;
  } }), { name: 'AbortError' });
  assert.equal(typeof new Function(`return (${scrapePublicCatalog.toString()})`)(), 'function');
});

test('HiFi adapter rejects lossy/encrypted manifests and preserves rate limit hints', async () => {
  let manifest = { mimeType: 'audio/flac', codecs: 'flac', encryptionType: 'NONE', urls: ['https://audio.tidal.com/test.flac?token=private'] };
  let quality = 'LOSSLESS', status = 200;
  const adapter = createProvider('hifi-tidal', { request: async () => ({ status, retryAfter: '30', data: { data: {
    audioQuality: quality, manifestMimeType: 'application/vnd.tidal.bts', manifest: Buffer.from(JSON.stringify(manifest)).toString('base64'),
  } } }) });
  assert.match((await adapter.resolve({ id: '1' })).url, /^https:/);
  quality = 'HIGH'; await assert.rejects(adapter.resolve({ id: '1' }), /FLAC/);
  quality = 'LOSSLESS'; manifest.encryptionType = 'AES'; await assert.rejects(adapter.resolve({ id: '1' }), /unencrypted/);
  status = 429; await assert.rejects(adapter.resolve({ id: '1' }), error => error.outcome === 'rate-limited' && error.retryAfter === '30');
  status = 403; await assert.rejects(adapter.resolve({ id: '1' }), error => error.outcome === 'access-blocked');
});

test('recording matching rejects conflicting ISRC and altered versions', () => {
  const expected = { title: 'Fetish', artist: 'Obzkure', durationSec: 180, isrc: 'ABC123' };
  const candidates = [{ ...expected, id: 'wrong', isrc: 'DEF456' }, { ...expected, id: 'remix', title: 'Fetish (Remix)' }, { ...expected, id: 'right' }];
  assert.equal(matchRecording(expected, candidates).id, 'right');
});

test('unqualified API providers never allocate or navigate a browser', async () => {
  const worker = new Worker({ view: new Proxy({}, { get() { throw new Error('Allocated browser'); } }), ipc: {} });
  for (const id of Object.keys(API_PROVIDERS)) {
    assert.equal((await worker.run({ id: '1' }, { source: id, service: id })).outcome, 'provider-failed');
  }
  const access = new SourceAccess();
  assert.equal(access.key({ source: 'hifi-tidal' }), access.key({ source: 'monochrome' }));
});

test('embedding replaces corrupt artwork and preserves every audio byte', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lucida-art-test-'));
  try {
    const file = path.join(directory, 'test.flac');
    const stream = Buffer.alloc(42); stream.write('fLaC'); stream[4] = 128; stream[7] = 34;
    const audio = Buffer.from([255, 248, ...Array.from({ length: 2000 }, (_, n) => n % 256)]);
    await writeFile(file, Buffer.concat([stream, audio]));
    assert.equal(await hasValidArtwork(file, () => true), false);
    const bytes = Buffer.from('decoded-test-image');
    await embedArtwork(file, { bytes, width: 10, height: 10 });
    assert.equal(await hasValidArtwork(file, b => b.equals(bytes)), true);
    assert.equal(await hasValidArtwork(file, () => false), false);
    assert.deepEqual((await readFile(file)).subarray(-audio.length), audio);
    await embedArtwork(file, { bytes, width: 20, height: 20 });
    assert.deepEqual((await readFile(file)).subarray(-audio.length), audio);
    assert.throws(() => pictureBytes(Buffer.alloc(5)), /Invalid/);
    await writeFile(file, 'not flac');
    await assert.rejects(embedArtwork(file, { bytes, width: 1, height: 1 }), /FLAC/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('virtual ranges remain bounded for 5000 rows and hide offscreen groups', () => {
  for (const count of [500, 5000]) for (const top of [0, -10000, -200000]) {
    const range = visibleRange(count, top, 720);
    assert.ok(range.end - range.start <= 28);
  }
  assert.deepEqual(visibleRange(5000, 800, 720), { start: 0, end: 0 });
  assert.deepEqual(visibleRange(100, -5000, 720), { start: 0, end: 0 });
});

test('surplus slots are reported idle only after their active work ends', async () => {
  const finish = [], events = [];
  const pool = new Pool({ concurrency: 3, run: () => new Promise(r => finish.push(r)), onEvent: (name, data) => {
    if (name === 'slot-idle') { assert.equal([...pool.active.values()].some(r => r.slot === data.slot), false); events.push(data.slot); }
  } });
  pool.submit([{ id: '1' }, { id: '2' }, { id: '3' }]); await Promise.resolve();
  pool.setConcurrency(1); assert.deepEqual(events, []);
  finish.forEach(r => r()); await pool.onIdle(); assert.deepEqual(events.sort(), [0, 1, 2]);
});

test('API worker shares the transfer lifecycle without allocating a browser', async () => {
  let started, requests = 0;
  const expected = { id: 'one', title: 'Fetish', artist: 'Obzkure', durationSec: 180, isrc: 'ABC123' };
  const manifest = Buffer.from(JSON.stringify({ mimeType: 'audio/flac', codecs: 'flac', encryptionType: 'NONE', urls: ['https://audio.tidal.com/one.flac'] })).toString('base64');
  const worker = new Worker({ pipeline: true, providers: { 'hifi-tidal': { qualified: true } },
    view: new Proxy({}, { get() { throw new Error('Allocated a browser'); } }),
    ipc: { providerRequest: async (_id, operation) => {
      requests++;
      return { status: 200, data: operation === 'search' ? { tracks: { items: [{ ...expected, id: 1, artist: { name: expected.artist } }] } }
        : { audioQuality: 'LOSSLESS', manifestMimeType: 'application/vnd.tidal.bts', manifest } };
    }, startProviderDownload: async payload => { started = payload; }, awaitDownloadStart: async () => ({ status: 'started' }) },
  });
  assert.equal((await worker.run(expected, { source: 'hifi-tidal', service: 'hifi-tidal', query: 'Fetish' })).outcome, 'transferring');
  assert.equal(started.itemId, expected.id); assert.equal(requests, 2);
  worker.ipc.providerRequest = async () => ({ status: 403 });
  assert.equal((await worker.run(expected, { source: 'hifi-tidal' })).outcome, 'access-blocked');
});

test('resource requests coalesce, respect concurrency, expire and retry failures', async () => {
  let active = 0, maximum = 0, calls = 0, now = 0;
  const cache = resourceCache(async key => {
    calls++; active++; maximum = Math.max(active, maximum);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    if (key === 'bad') throw new Error('unavailable'); return key;
  }, { concurrency: 2, maxEntries: 2, ttl: 10, now: () => now });
  await Promise.all([cache('a'), cache('a'), cache('b'), cache('c')]);
  assert.equal(calls, 3); assert.equal(maximum, 2);
  await cache('c'); assert.equal(calls, 3);
  now = 11; await cache('c'); assert.equal(calls, 4);
  await assert.rejects(cache('bad')); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(cache('bad')); assert.equal(calls, 6);
});

test('cache accounting failures reject and release the next request', async () => {
  const cache = resourceCache(async key => key, { concurrency: 1, sizeOf: value => {
    if (value === 'bad') throw new Error('accounting failure');
    return 1;
  } });
  const failed = assert.rejects(cache('bad'), /accounting failure/);
  assert.equal(await cache('good'), 'good');
  await failed;
});

test('item subscribers ignore unrelated status and byte changes', () => {
  const controller = new Controller(); controller.pause();
  controller.add([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]);
  let changes = 0; const unsubscribe = controller.subscribeItem('a', () => changes++);
  controller.getItem('b').status = 'skipped'; controller._emit(); assert.equal(changes, 0);
  controller.getItem('a').status = 'searching'; controller._emit(); assert.equal(changes, 1);
  controller.getItem('a').receivedBytes = 42; controller._emitProgress(); assert.equal(changes, 1);
  unsubscribe(); controller.dispose();
});

test('Qobuz metadata transport paginates public tracks without playback credentials', async () => {
  const urls = [];
  const read = createCatalogTransport({ readText: response => response.text(), fetch: async input => {
    const url = new URL(input); urls.push(url);
    if (url.pathname === '/us-en/shop') return new Response('<a href="/us-en/album/fixture/album1">Album</a>');
    if (url.pathname === '/us-en/album/fixture/album1') return new Response('app_id=123456789');
    assert.match(url.pathname, /\/playlist\/get$/);
    assert.equal(url.searchParams.get('app_id'), '123456789');
    const offset = Number(url.searchParams.get('offset'));
    return Response.json({ name: 'Fixture', tracks: { total: 2, items: [{ id: offset + 1, title: 'Song', performer: { name: 'Artist' },
      duration: 120, isrc: 'ABC', album: { title: 'Album', image: { large: 'https://art.example/cover.png' } } }] } });
  } });
  const ref = classifyCatalogUrl('https://open.qobuz.com/playlist/123');
  const result = await readCatalog(ref, { readPage: async (_ref, cursor) => (await read(ref.url, cursor)).page });
  assert.equal(result.complete, true); assert.equal(result.tracks.length, 2);
  assert.deepEqual(result.tracks.map(t => t.id), ['1', '2']);
  assert.ok(urls.every(url => !url.pathname.includes('getFileUrl')));
  await assert.rejects(read('https://evil.example/playlist/123'), /Unsupported/);
});

test('catalog redirects cannot turn metadata access into a general network proxy', async () => {
  let calls = 0;
  const read = createCatalogTransport({ readText: response => response.text(), fetch: async () => {
    calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  } });
  await assert.rejects(read('https://tidal.com/track/1'), /Invalid catalog redirect/);
  assert.equal(calls, 1);
});

test('restoring 5000 tracks batches insertion and preserves queued versus paused or cancelled states', async () => {
  const controller = new Controller();
  const items = Array.from({ length: 5000 }, (_, n) => ({ id: `restore-${n}`, title: `Track ${n}`,
    status: n % 3 === 0 ? 'paused' : n % 3 === 1 ? 'cancelled' : 'queued' }));
  let changes = 0; controller.subscribe(() => changes++);
  const dispose = attachPersistence(controller, { on() {}, removeListener() {}, send() {},
    invoke: async channel => channel === 'queue-load' ? { v: 4, paused: true, items } : [] });
  await controller.restore();
  assert.ok(changes <= 4, `Restore emitted ${changes} structural updates`);
  assert.equal(controller.getItems().length, 5000);
  assert.equal(controller.pool.queue.length, items.filter(item => item.status === 'queued').length);
  assert.ok(controller.pool.queue.every(item => controller.getItem(item.id).status === 'queued'));
  dispose(); controller.dispose();
});
