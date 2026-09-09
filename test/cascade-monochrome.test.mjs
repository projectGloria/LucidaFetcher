import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMonochromeScript } from '../src/engine/cascade-monochrome.mjs';
import { makePage, runScript } from './fake-dom.mjs';

const FETISH = { title: 'Fetish', artist: 'Obzkure' };
const fast = { candidatePolls: 4, totalPolls: 40, findPolls: 4 };

const run = (expected, tracks, opts = {}, pageOpts = {}) => {
  const page = makePage(tracks, pageOpts);
  return runScript(buildMonochromeScript(expected, { ...fast, ...opts }), page)
    .then((r) => ({ ...r, anchorClicks: page.anchorClicks }));
};

test('downloads the exact match, not a title that merely contains it', async () => {
  const r = await run(FETISH, [
    { title: 'Money Fetish', artist: 'Obzkure', behaviour: 'ok' },
    { title: 'Fetish', artist: 'Obzkure', behaviour: 'ok' },
  ]);
  assert.equal(r.outcome, 'download-triggered');
  assert.deepEqual(r.anchorClicks, ['Fetish.flac']);
});

test('falls through to another pressing when the first has no stream', async () => {
  // This is the exact KAN failure: the correct card is found, but Monochrome's
  // backend answers "no audio stream is available for this track". The old
  // cascade reported that as a dead track. The same recording is listed twice.
  const r = await run(FETISH, [
    { title: 'Fetish', artist: 'Obzkure', behaviour: 'fail' },
    { title: 'Fetish', artist: 'Obzkure', behaviour: 'ok' },
  ]);
  assert.equal(r.outcome, 'download-triggered');
  assert.deepEqual(r.anchorClicks, ['Fetish.flac']);
  assert.equal(r.attempts.length, 1, 'should record the failed first attempt');
});

test('a lingering toast does not fail the next candidate', async () => {
  // Monochrome's toasts stay on screen for seconds. The polled backstop reads
  // whatever is in the container, so without the baseline guard candidate two
  // would read candidate one's toast 250ms later and fail instantly - which
  // silently collapses the walk back to single-shot behaviour.
  const r = await run(FETISH, [
    { title: 'Fetish', artist: 'Obzkure', behaviour: 'fail' },
    { title: 'Fetish', artist: 'Obzkure', behaviour: 'ok' },
  ], {}, { toastLingers: true });
  assert.equal(r.outcome, 'download-triggered');
});

test('never falls through to a DIFFERENT song', async () => {
  // "Money Fetish" passes the acceptance gate: every expected token is present
  // and the artist matches. Falling through to it when the real track's stream
  // fails would download the wrong song - worse than the skip being prevented.
  const r = await run(FETISH, [
    { title: 'Fetish', artist: 'Obzkure', behaviour: 'fail' },
    { title: 'Money Fetish', artist: 'Obzkure', behaviour: 'ok' },
  ]);
  assert.equal(r.outcome, 'provider-failed');
  assert.deepEqual(r.anchorClicks, [], 'must not download a different song');
});

test('treats an alternate pressing as the same recording', async () => {
  // STOP folds "(Original Mix)" onto the bare title, so this is a real alternate.
  const r = await run(FETISH, [
    { title: 'Fetish', artist: 'Obzkure', behaviour: 'fail' },
    { title: 'Fetish (Original Mix)', artist: 'Obzkure', behaviour: 'ok' },
  ]);
  assert.equal(r.outcome, 'download-triggered');
  assert.deepEqual(r.anchorClicks, ['Fetish (Original Mix).flac']);
});

test('reports provider-failed only once every pressing is exhausted', async () => {
  const r = await run(FETISH, [
    { title: 'Fetish', artist: 'Obzkure', behaviour: 'fail' },
    { title: 'Fetish', artist: 'Obzkure', behaviour: 'fail' },
  ]);
  assert.equal(r.outcome, 'provider-failed');
  assert.equal(r.attempts.length, 2);
  assert.match(r.message, /no audio stream/);
});

test('refuses a same-title track by a different artist', async () => {
  const r = await run(FETISH, [{ title: 'Fetish', artist: 'Selena Gomez', behaviour: 'ok' }]);
  assert.equal(r.outcome, 'no-match');
  assert.deepEqual(r.anchorClicks, []);
});

test('reports no-results when the page says there are none', async () => {
  const r = await run(FETISH, []);
  assert.equal(r.outcome, 'no-results');
});
