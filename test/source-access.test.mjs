import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { SourceAccess, retryAfterMs, normalizeApiUrl, monochromeConfigScript, delay } from '../src/engine/source-access.mjs';
import { installSourceObserver } from '../src/engine/source-response.cjs';
import { buildPlan, advanceAfter } from '../src/engine/chain.mjs';
import { describeOutcome, describeAbandon } from '../src/engine/status.mjs';

test('Retry-After supports seconds, dates, missing and malformed headers', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  assert.equal(retryAfterMs('120', now), 120000);
  assert.equal(retryAfterMs('Mon, 26 Oct 2026 12:02:00 GMT', now), 120000);
  assert.equal(retryAfterMs('Mon, 26 Oct 2026 11:00:00 GMT', now), 0);
  for (const value of [null, '', 'garbage']) assert.equal(retryAfterMs(value, now), null);
});

test('all Lucida stores serialize, a cancelled waiter releases nothing, and Monochrome runs independently', async () => {
  const access = new SourceAccess();
  const key = access.key({ source: 'lucida', service: 'qobuz' });
  assert.equal(key, access.key({ source: 'lucida', service: 'tidal' }));
  const first = await access.acquire(key);
  const cancelled = new AbortController();
  const second = access.acquire(key, cancelled.signal);
  let thirdStarted = false;
  const third = access.acquire(key).then(release => { thirdStarted = true; return release; });
  cancelled.abort();
  await assert.rejects(second, { name: 'Aborted' });
  const mono = await access.acquire('monochrome');
  mono();
  assert.equal(thirdStarted, false);
  first();
  (await third)();
  assert.equal(access.state(key).active, false);
});

test('shared pacing honors extended cooldowns and persists Retry-After across restarts', async () => {
  let now = 0, extended = false, saved;
  const access = new SourceAccess({ now: () => now, onChange: state => { saved = state; },
    sleep: async ms => {
      now += ms;
      if (!extended) { extended = true; access.limited('lucida', '5'); }
    } });
  await access.pace('lucida');
  access.limited('lucida', '2');
  await access.pace('lucida');
  assert.equal(now, 6000, 'a response can extend the deadline while a worker waits');
  assert.equal(saved.sourceCooldowns.lucida, 6000);
  const restored = new SourceAccess({ cooldowns: saved.sourceCooldowns, now: () => 0 });
  assert.equal(restored.cooldowns.lucida, 6000);
  access.healthy('lucida');
  assert.equal(access.cooldowns.lucida, 6000, 'success never clears an outstanding server deadline');
});

test('missing Retry-After backs off exponentially and cancelling a cooldown is prompt', async () => {
  const access = new SourceAccess({ now: () => 1000 });
  assert.equal(access.limited('lucida'), 31000);
  assert.equal(access.limited('lucida'), 61000);
  const abort = new AbortController();
  const waiting = access.pace('lucida', abort.signal);
  abort.abort();
  await assert.rejects(waiting, { name: 'Aborted' });
  await assert.rejects(delay(1000, abort.signal), { name: 'Aborted' });
});

test('release cache is bounded, expires, and isolates matching criteria and service', () => {
  let now = 0;
  const access = new SourceAccess({ now: () => now });
  const step = { service: 'qobuz', query: 'Song Artist' };
  const item = { title: 'Song', artist: 'Artist', durationSec: 200 };
  const key = access.cacheKey(item, step);
  access.rememberRelease(key, 'https://lucida.to/release/1');
  assert.equal(access.getRelease(key), 'https://lucida.to/release/1');
  assert.notEqual(key, access.cacheKey({ ...item, durationSec: 300 }, step));
  assert.notEqual(key, access.cacheKey(item, { ...step, service: 'tidal' }));
  access.rememberRelease('bad', 'https://other.example/track');
  assert.equal(access.getRelease('bad'), null);
  now = 600001;
  assert.equal(access.getRelease(key), null);
  for (let i = 0; i < 205; i++) access.rememberRelease(String(i), `https://lucida.to/release/${i}`);
  assert.equal(access.cache.size, 200);
  assert.equal(access.getRelease('0'), null);
});

test('country preferences are separate per provider and emit immutable persistence snapshots', () => {
  const snapshots = [];
  const access = new SourceAccess({ onChange: state => snapshots.push(state) });
  access.rememberRegion('qobuz', 'NL');
  access.rememberRegion('tidal', 'US');
  access.forgetRegion('qobuz');
  assert.deepEqual(snapshots[0].sourceRegions, { qobuz: 'NL' });
  assert.deepEqual(access.regions, { tidal: 'US' });
});

test('custom API validation and Monochrome configuration support enabling and clearing a backend', () => {
  assert.equal(normalizeApiUrl(' http://127.0.0.1:8000/ '), 'http://127.0.0.1:8000');
  for (const invalid of ['file:///tmp/api', 'javascript:alert(1)', 'https://u:p@server', 'https://server/?token=x', 'oops']) {
    assert.throws(() => normalizeApiUrl(invalid));
  }
  const values = new Map();
  const context = { location: { origin: 'https://monochrome.st' }, localStorage: {
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key),
  } };
  vm.runInNewContext(monochromeConfigScript('http://127.0.0.1:8000'), context);
  assert.equal(values.get('dev-mode-enabled'), 'true');
  assert.equal(values.get('dev-mode-url'), 'http://127.0.0.1:8000');
  vm.runInNewContext(monochromeConfigScript(''), context);
  assert.equal(values.get('dev-mode-enabled'), 'false');
  assert.equal(values.has('dev-mode-url'), false);
  context.location.origin = 'https://unrelated.example';
  assert.throws(() => vm.runInNewContext(monochromeConfigScript(''), context));
});

test('rate limits skip all remaining Lucida stores, but country errors skip only their provider', () => {
  const plan = buildPlan({ services: ['qobuz', 'tidal', 'monochrome'], variants: ['one', 'two'] });
  assert.equal(plan[advanceAfter(plan, 0, 'rate-limited')].source, 'monochrome');
  assert.equal(plan[advanceAfter(plan, 0, 'access-blocked')].source, 'monochrome');
  assert.equal(plan[advanceAfter(plan, 0, 'invalid-country')].service, 'tidal');
  assert.doesNotMatch(describeOutcome('search-unavailable', { service: 'qobuz' }), /rate.limit/i);
  assert.match(describeAbandon([{ service: 'qobuz', outcome: 'invalid-country' }]), /regions/);
});

test('response observer captures headers without URLs and rejects unrelated and stale responses', () => {
  const hooks = {}, published = [];
  const webRequest = Object.fromEntries(['onBeforeSendHeaders', 'onHeadersReceived', 'onCompleted', 'onErrorOccurred']
    .map(name => [name, handler => { hooks[name] = handler; }]));
  const original = { itemId: 'one', service: 'qobuz', sourceUrl: 'https://lucida.to/search' };
  let context = original;
  installSourceObserver(webRequest, () => context, value => published.push(value));
  let callbacks = 0;
  const reply = response => { assert.deepEqual(response, {}); callbacks++; };
  const request = { id: 1, webContentsId: 7, resourceType: 'xhr', url: 'https://lucida.to/api?token=secret' };
  hooks.onBeforeSendHeaders(request, reply);
  hooks.onHeadersReceived({ ...request, statusCode: 429, responseHeaders: { 'Retry-After': ['120'] } }, reply);
  assert.equal(published[0].retryAfter, '120');
  assert.equal(published[0].host, 'lucida.to');
  assert.equal(published[0].status, 429);
  assert.doesNotMatch(JSON.stringify(published), /secret/);
  context = { ...original, itemId: 'next' };
  hooks.onHeadersReceived({ ...request, statusCode: 429 }, reply);
  hooks.onBeforeSendHeaders({ ...request, id: 2, url: 'https://analytics.example/event' }, reply);
  hooks.onHeadersReceived({ ...request, id: 2, statusCode: 429 }, reply);
  hooks.onCompleted(request);
  context = original;
  hooks.onHeadersReceived({ ...request, statusCode: 429 }, reply);
  assert.equal(published.length, 1);
  assert.equal(callbacks, 6);
});

test('response observer recognizes configured API origins and separates 403 from 429', () => {
  const hooks = {}, published = [];
  const webRequest = Object.fromEntries(['onBeforeSendHeaders', 'onHeadersReceived', 'onCompleted', 'onErrorOccurred']
    .map(name => [name, handler => { hooks[name] = handler; }]));
  const context = { itemId: 'mono', service: 'monochrome', sourceUrl: 'https://monochrome.st/search/x', apiUrl: 'http://127.0.0.1:8000' };
  installSourceObserver(webRequest, () => context, value => published.push(value));
  for (const [id, url, status] of [[1, 'http://127.0.0.1:8000/search', 429], [2, 'https://monochrome.st/', 403]]) {
    const request = { id, webContentsId: 7, resourceType: id === 1 ? 'xhr' : 'mainFrame', url };
    hooks.onBeforeSendHeaders(request, () => {});
    hooks.onHeadersReceived({ ...request, statusCode: status }, () => {});
    hooks.onErrorOccurred(request);
  }
  assert.deepEqual(published.map(r => [r.status, r.mainFrame]), [[429, false], [403, true]]);
});
