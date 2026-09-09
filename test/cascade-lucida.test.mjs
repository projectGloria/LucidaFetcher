import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLucidaScript } from '../src/engine/cascade-lucida.mjs';
import { makeLucidaPage, runScript } from './fake-dom.mjs';

const FETISH = { title: 'Fetish', artist: 'Obzkure' };
const fast = { findPolls: 6, emptyPolls: 3 };

const run = (expected, pageOpts) => {
  const page = makeLucidaPage(pageOpts);
  return runScript(buildLucidaScript(expected, fast), page).then((r) => ({ ...r, page }));
};

test('navigates to the best hit, not the first listed', () => run(FETISH, {
  results: [
    { title: 'Fetish', artist: 'Selena Gomez', href: 'https://lucida.to/a/wrong' },
    { title: 'Fetish', artist: 'Obzkure', href: 'https://lucida.to/a/right' },
  ],
}).then((r) => {
  assert.equal(r.outcome, 'navigating');
  assert.equal(r.page.location.href, 'https://lucida.to/a/right');
}));

test('prefers an exact title over one that merely contains it', () => run(FETISH, {
  results: [
    { title: 'Money Fetish', artist: 'Obzkure', href: 'https://lucida.to/a/wrong' },
    { title: 'Fetish', artist: 'Obzkure', href: 'https://lucida.to/a/right' },
  ],
}).then((r) => assert.equal(r.page.location.href, 'https://lucida.to/a/right')));

test('reports no-match rather than settling for a different artist', () => run(FETISH, {
  results: [{ title: 'Fetish', artist: 'Selena Gomez', href: 'https://lucida.to/a/wrong' }],
}).then((r) => {
  assert.equal(r.outcome, 'no-match');
  assert.equal(r.page.location.href, 'https://lucida.to/search?query=x', 'must not navigate');
}));

test('returns alternates so a dead release page can be retried', () => run(FETISH, {
  results: [
    { title: 'Fetish', artist: 'Obzkure', href: 'https://lucida.to/a/1' },
    { title: 'Fetish', artist: 'Obzkure', href: 'https://lucida.to/a/2' },
  ],
}).then((r) => assert.deepEqual(r.alternates, ['https://lucida.to/a/2'])));

test('recognises the store error page', () => run(FETISH, { error: 'Uh-oh!' })
  .then((r) => assert.equal(r.outcome, 'no-results')));

test('calls a rendered but empty result list empty', () => run(FETISH, { results: [] })
  .then((r) => assert.equal(r.outcome, 'no-results')));

test('presses the download button on a release page', () => run(FETISH, {
  href: 'https://lucida.to/a/right', downloadControl: 'button',
}).then((r) => {
  assert.equal(r.outcome, 'clicked-download-button');
  assert.deepEqual(r.page.clicked, ['download-button']);
}));

test('falls back to a text download control', () => run(FETISH, {
  href: 'https://lucida.to/a/right', downloadControl: 'text',
}).then((r) => {
  assert.equal(r.outcome, 'clicked-text');
  assert.deepEqual(r.page.clicked, ['text']);
}));

test('times out on a release page with no control at all', () => run(FETISH, {
  href: 'https://lucida.to/a/right',
}).then((r) => assert.equal(r.outcome, 'timeout')));
