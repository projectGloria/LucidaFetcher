import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker, urlForStep } from '../src/engine/worker.mjs';

const ITEM = { id: 't1', name: 'Obzkure - Fetish', title: 'Fetish', artist: 'Obzkure', folderName: 'KAN', key: 'k1' };
const lucidaStep = { source: 'lucida', service: 'qobuz', query: 'Fetish Obzkure', variantIndex: 0 };
const monoStep = { source: 'monochrome', service: 'monochrome', query: 'Fetish Obzkure', variantIndex: 0 };

function fakeView(outcomes) {
  const listeners = new Set();
  const fire = () => [...listeners].forEach((cb) => cb());
  return {
    webContentsId: 7,
    navigated: [],
    navigate(url) { this.navigated.push(url); setTimeout(fire, 1); },
    onDomReady(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    async executeJavaScript() {
      const o = outcomes.shift();
      // The search cascade navigates the page itself, so a 'navigating' result
      // is followed by another dom-ready with no navigate() call.
      if (o && o.outcome === 'navigating') setTimeout(fire, 1);
      return o;
    },
  };
}

function fakeIpc(over = {}) {
  return {
    contexts: [], cleared: [], ytDownloads: [],
    setDownloadContext(c) { this.contexts.push(c); },
    clearDownloadContext(id) { this.cleared.push(id); },
    async awaitDownload() { return { status: 'completed', savePath: 'p/f.flac', file: 'f.flac', bytes: 10 }; },
    async searchYouTube() { return []; },
    async searchJamendo() { return { ok: true, results: [] }; },
    async downloadYouTube(p) { this.ytDownloads.push(p); return { savePath: 'p/f.flac', file: 'f.flac', bytes: 20 }; },
    ...over,
  };
}

const mk = (view, ipc, timeouts) => new Worker({ slot: 0, view, ipc, timeouts: { domReadyTimeoutMs: 200, cascadeTimeoutMs: 200, monochromeCascadeTimeoutMs: 200, ...timeouts } });

test('builds the right search URL per source', () => {
  assert.equal(urlForStep(lucidaStep), 'https://lucida.to/search?query=Fetish%20Obzkure&service=qobuz');
  assert.equal(urlForStep(monoStep), 'https://monochrome.st/search/Fetish%20Obzkure');
});

test('carries a Lucida attempt through search then release page', async () => {
  const view = fakeView([{ outcome: 'navigating', label: 'Fetish - Obzkure' }, { outcome: 'clicked-download-button' }]);
  const ipc = fakeIpc();
  const r = await mk(view, ipc).run(ITEM, lucidaStep);
  assert.equal(r.outcome, 'completed');
  assert.equal(r.file, 'f.flac');
  // Only the search URL is navigated to - the page moves itself to the release.
  assert.deepEqual(view.navigated, ['https://lucida.to/search?query=Fetish%20Obzkure&service=qobuz']);
});

test('a region retry still leaves room for search, release and both alternate hits', async () => {
  const view = fakeView([
    { outcome: 'navigating', label: 'Search region: NL' },
    { outcome: 'navigating', alternates: ['https://lucida.to/a/2', 'https://lucida.to/a/3'] },
    { outcome: 'provider-failed' }, { outcome: 'provider-failed' }, { outcome: 'clicked-download-button' },
  ]);
  const result = await mk(view, fakeIpc()).run(ITEM, lucidaStep);
  assert.equal(result.outcome, 'completed');
  assert.equal(view.navigated.length, 3);
});

test('registers the download context before navigating, and clears it after', async () => {
  const view = fakeView([{ outcome: 'clicked-download-button' }]);
  const ipc = fakeIpc();
  await mk(view, ipc).run(ITEM, lucidaStep);
  // A page can trigger a download the instant it loads, and will-download reads
  // this map - so it has to be in place first.
  assert.equal(ipc.contexts.length, 1);
  assert.equal(ipc.contexts[0].webContentsId, 7);
  assert.equal(ipc.contexts[0].itemId, 't1');
  assert.deepEqual(ipc.cleared, [7]);
});

test('does not wait for a download when nothing was clicked', async () => {
  let waited = false;
  const view = fakeView([{ outcome: 'no-match', label: 'Fetish - Selena Gomez' }]);
  const ipc = fakeIpc({ async awaitDownload() { waited = true; return null; } });
  const r = await mk(view, ipc).run(ITEM, lucidaStep);
  assert.equal(r.outcome, 'no-match');
  assert.equal(waited, false);
  assert.deepEqual(ipc.cleared, [7], 'context must still be released');
});

test('reports a click that never produced a file', async () => {
  const view = fakeView([{ outcome: 'clicked-download-button' }]);
  const ipc = fakeIpc({ async awaitDownload() { return null; } });
  const r = await mk(view, ipc).run(ITEM, lucidaStep);
  assert.equal(r.outcome, 'no-download-started');
});

test('reports a download that started and then failed', async () => {
  const view = fakeView([{ outcome: 'clicked-download-button' }]);
  const ipc = fakeIpc({ async awaitDownload() { return { status: 'interrupted' }; } });
  const r = await mk(view, ipc).run(ITEM, lucidaStep);
  assert.equal(r.outcome, 'download-failed');
  assert.equal(r.message, 'interrupted');
});

test('survives a page that never becomes ready', async () => {
  const view = { webContentsId: 7, navigated: [], navigate() {}, onDomReady() { return () => {}; }, async executeJavaScript() {} };
  const r = await mk(view, fakeIpc()).run(ITEM, lucidaStep);
  assert.equal(r.outcome, 'navigation-timeout');
});

test('turns an injection failure into an outcome, not a crash', async () => {
  const view = fakeView([]);
  view.executeJavaScript = async () => { throw new Error('webview gone'); };
  const r = await mk(view, fakeIpc()).run(ITEM, lucidaStep);
  assert.equal(r.outcome, 'injection-failed');
});








test('aborts when the signal is already tripped', async () => {
  const c = new AbortController();
  c.abort();
  await assert.rejects(() => mk(fakeView([]), fakeIpc()).run(ITEM, lucidaStep, c.signal), /aborted/);
});


test('blocks all YouTube and SoundCloud paths before search or download', async () => {
  for (const service of ['youtube', 'soundcloud']) {
    for (const source of [service, 'direct', 'lucida']) {
      const ipc = fakeIpc();
      const view = fakeView([]);
      const result = await mk(view, ipc).run(ITEM, { source, service, query: 'song', url: 'https://example.com' });
      assert.equal(result.outcome, 'provider-failed');
      assert.deepEqual(ipc.ytDownloads, []);
      assert.deepEqual(view.navigated, []);
    }
  }
});
