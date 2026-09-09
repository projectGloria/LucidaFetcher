import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker, urlForStep } from '../src/engine/worker.mjs';

const ITEM = { id: 't1', name: 'Obzkure - Fetish', title: 'Fetish', artist: 'Obzkure', folderName: 'KAN', key: 'k1' };
const lucidaStep = { source: 'lucida', service: 'qobuz', query: 'Fetish Obzkure', variantIndex: 0 };
const monoStep = { source: 'monochrome', service: 'monochrome', query: 'Fetish Obzkure', variantIndex: 0 };
const ytStep = { source: 'youtube', service: 'youtube', query: 'Fetish Obzkure', variantIndex: 0 };

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
    async downloadYouTube(p) { this.ytDownloads.push(p); return { savePath: 'p/f.m4a', file: 'f.m4a', bytes: 20 }; },
    ...over,
  };
}

const mk = (view, ipc, timeouts) => new Worker({ slot: 0, view, ipc, timeouts: { domReadyTimeoutMs: 200, cascadeTimeoutMs: 200, monochromeCascadeTimeoutMs: 200, ...timeouts } });

test('builds the right search URL per source', () => {
  assert.equal(urlForStep(lucidaStep), 'https://lucida.to/search?query=Fetish%20Obzkure&service=qobuz');
  assert.equal(urlForStep(monoStep), 'https://monochrome.tf/search/Fetish%20Obzkure');
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

test('downloads the chosen YouTube upload', async () => {
  const ipc = fakeIpc({
    async searchYouTube() { return [{ title: 'Obzkure - Fetish', uploader: 'Obzkure', url: 'https://y/1' }]; },
  });
  const r = await mk(fakeView([]), ipc).run(ITEM, ytStep);
  assert.equal(r.outcome, 'completed');
  assert.equal(r.via, 'yt-dlp');
  assert.equal(ipc.ytDownloads[0].url, 'https://y/1');
});

test('downloads an artist-authorized Jamendo FLAC after strict matching', async () => {
  const ipc = fakeIpc({
    async searchJamendo() { return { ok: true, results: [{
      title: 'Fetish', artist: 'Obzkure', uploader: 'Obzkure', durationSec: 240,
      url: 'https://prod-1.storage.jamendo.com/download/track/1/flac/',
      sourcePage: 'https://www.jamendo.com/track/1',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    }] }; },
  });
  const r = await mk(fakeView([]), ipc).run(
    { ...ITEM, durationSec: 240 },
    { source: 'jamendo', service: 'jamendo', query: 'Fetish Obzkure', variantIndex: 0 }
  );
  assert.equal(r.outcome, 'completed');
  assert.equal(r.via, 'jamendo-api');
  assert.equal(ipc.ytDownloads[0].service, 'jamendo');
  assert.equal(ipc.ytDownloads[0].licenseUrl, 'https://creativecommons.org/licenses/by/4.0/');
});

test('refuses a similarly named Jamendo track instead of substituting it', async () => {
  const ipc = fakeIpc({
    async searchJamendo() { return { ok: true, results: [{
      title: 'Fetish Remix', artist: 'Someone Else', uploader: 'Someone Else',
      url: 'https://prod-1.storage.jamendo.com/download/track/2/flac/',
    }] }; },
  });
  const r = await mk(fakeView([]), ipc).run(
    ITEM, { source: 'jamendo', service: 'jamendo', query: 'Fetish Obzkure', variantIndex: 0 }
  );
  assert.equal(r.outcome, 'no-match');
  assert.equal(ipc.ytDownloads.length, 0);
});

test('refuses every YouTube result rather than fetching a wrong file', async () => {
  const ipc = fakeIpc({
    async searchYouTube() { return [{ title: 'Fetish (Slowed + Reverb)', uploader: 'x', url: 'https://y/1' }]; },
  });
  const r = await mk(fakeView([]), ipc).run(ITEM, ytStep);
  assert.equal(r.outcome, 'no-match');
  assert.equal(ipc.ytDownloads.length, 0);
});

test('a throttled search is reported as unavailable, not as "no results"', async () => {
  // yt-dlp signals throttling by exiting 0 with empty output. Calling that
  // "no results" writes "not on YouTube" into the folder report for a track
  // that is plainly there - and hides the fact that a retry would work.
  const ipc = fakeIpc({ async searchYouTube() { return { ok: false, reason: 'unavailable', results: [] }; } });
  const r = await mk(fakeView([]), ipc).run(ITEM, ytStep);
  assert.equal(r.outcome, 'search-unavailable');
  assert.equal(ipc.ytDownloads.length, 0);
});

test('an honest empty search is still "no results"', async () => {
  const ipc = fakeIpc({ async searchYouTube() { return { ok: true, results: [] }; } });
  const r = await mk(fakeView([]), ipc).run(ITEM, ytStep);
  assert.equal(r.outcome, 'no-results');
});

test('still accepts the older bare-array search result', async () => {
  const ipc = fakeIpc({
    async searchYouTube() { return [{ title: 'Obzkure - Fetish', uploader: 'Obzkure', url: 'https://y/1' }]; },
  });
  const r = await mk(fakeView([]), ipc).run(ITEM, ytStep);
  assert.equal(r.outcome, 'completed');
});

test('aborts when the signal is already tripped', async () => {
  const c = new AbortController();
  c.abort();
  await assert.rejects(() => mk(fakeView([]), fakeIpc()).run(ITEM, lucidaStep, c.signal), /aborted/);
});
test('SoundCloud search downloads the matching upload and records the provider', async () => {
  const ipc = fakeIpc({ searchSoundCloud: async () => ({ ok: true, results: [
    { title: 'Obzkure - Fetish', uploader: 'Obzkure', url: 'https://soundcloud.com/obzkure/fetish' },
  ] }) });
  const worker = mk(fakeView([]), ipc);
  const result = await worker.run(ITEM, { ...ytStep, source: 'soundcloud', service: 'soundcloud' });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.step.service, 'soundcloud');
  assert.equal(ipc.ytDownloads[0].service, 'soundcloud');
  assert.equal(ipc.ytDownloads[0].url, 'https://soundcloud.com/obzkure/fetish');
});

test('cancelling a direct media transfer sends its item ID to the main process', async () => {
  const abort = new AbortController();
  let finish, cancelled;
  const ipc = fakeIpc({
    downloadYouTube: () => new Promise(r => { finish = r; }),
    cancelDownload: id => { cancelled = id; finish({}); },
  });
  const work = mk(fakeView([]), ipc).run(ITEM, { source: 'direct', service: 'soundcloud', url: 'https://soundcloud.com/artist/song' }, abort.signal);
  abort.abort();
  await assert.rejects(work, { name: 'Aborted' });
  assert.equal(cancelled, ITEM.id);
});
