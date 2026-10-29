// Browser fixture for real React recovery and progress subscriptions.
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import RenderBoundary from '../src/ui/components/RenderBoundary.jsx';
import TransportBar from '../src/ui/components/TransportBar.jsx';
import { initEngine } from '../src/ui/engine.js';
import { parseCatalogHtml } from '../src/engine/public-catalog.mjs';

const c = await initEngine({ config: {}, log() {} });
c.pause();
const structural = new Set(), progress = new Set();
let version = 0, progressVersion = 0, reads = 0, broken = false;
const rec = { item: { id: 'moving', title: 'Fixture', artist: 'Artist' }, status: 'downloading', receivedBytes: 10, totalBytes: 100, progress: 0.1 };
const records = [rec, ...Array.from({ length: 10000 }, (_, i) => ({ item: { id: 'queued-' + i }, status: 'queued' }))];
c.subscribe = fn => { structural.add(fn); return () => structural.delete(fn); };
c.subscribeProgress = fn => { progress.add(fn); return () => progress.delete(fn); };
c.getSnapshot = () => version;
c.getProgressSnapshot = () => progressVersion;
c.getItems = () => { reads++; return records.slice(); };

function Fragile() {
  if (broken) throw new Error('fixture render failure');
  return <p>Interface restored</p>;
}

const root = createRoot(document.getElementById('root'));
const render = () => root.render(<><RenderBoundary><Fragile /></RenderBoundary><TransportBar /></>);
flushSync(render);
window.runUIRegression = () => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const before = reads;
  for (let n = 11; n <= 90; n++) {
    rec.receivedBytes = n; rec.progress = n / 100;
    flushSync(() => { progressVersion++; progress.forEach(fn => fn()); });
  }
  check(reads === before, 'Progress expanded all 10001 playlist rows again: ' + reads);
  check(document.querySelector('.transfer-pct').textContent === '90%', 'Progress stopped updating');
  rec.status = 'ready';
  flushSync(() => { version++; structural.forEach(fn => fn()); });
  check(document.querySelector('.transfer-pct').textContent === 'Ready', 'Structural change was cached incorrectly');
  broken = true; flushSync(render);
  check(document.querySelector('[role="alert"]')?.textContent.includes('fixture render failure'), 'Rendering failure left a blank window');
  check(!!document.querySelector('.transport'), 'Rendering failure removed the transfer display');
  broken = false;
  flushSync(() => document.querySelector('[role="alert"] button').click());
  check(!document.querySelector('[role="alert"]') && document.body.textContent.includes('Interface restored'), 'Interface recovery failed');
  check(c.getItems()[0] === rec, 'Recovery replaced the download queue');
  return { rows: records.length, progressTicks: 80, extraExpansions: 0, recovered: true };
};

window.runCatalogRegression = async () => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const track = await parseCatalogHtml('<script>window.catalogCodeRan = true;</script><script type="application/ld+json">' + JSON.stringify({
    '@type': 'MusicRecording', name: 'Song (Remix)', byArtist: [{ name: 'Artist' }], duration: 'PT3M1S', isrcCode: 'ABC123', image: 'https://art.example/cover.png',
  }) + '</script>', { service: 'tidal', type: 'track', id: '1' });
  check(track.complete && track.tracks[0].isrc === 'ABC123' && track.tracks[0].durationSec === 181, 'Track metadata was lost');
  check(track.tracks[0].title === 'Song (Remix)' && !window.catalogCodeRan, 'Static catalog parsing changed recording or ran page code');
  const album = await parseCatalogHtml('<script>window.tidalMediaSessionMetadata={"1":{"title":"Song","artist":"Artist","album":"Album","artwork":[{"src":"https://art.example/a.png"}]}};</script>'
    + '<list-item product-type="track" product-id="1"><span slot="title">Song (Live)</span><time slot="duration">4:12</time></list-item>',
  { service: 'tidal', type: 'album', id: 'a' });
  check(album.tracks[0].title === 'Song (Live)' && album.tracks[0].durationSec === 252 && !album.complete, 'Embed truncation or version was lost');
  return true;
};
