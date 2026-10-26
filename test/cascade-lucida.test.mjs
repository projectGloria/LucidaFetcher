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

test('Rollin explicit badge is excluded and the Urban Assault version remains rejected', () => run({ title: "Rollin' (Air Raid Vehicle)", artist: 'Limp Bizkit' }, {
  results: [
    { title: "Rollin' (Urban Assault Vehicle) (Album Version)", artist: 'Limp Bizkit', explicit: true, href: 'https://lucida.to/a/urban' },
    { title: "Rollin' (Air Raid Vehicle)", artist: 'Limp Bizkit', explicit: true, href: 'https://lucida.to/a/air' },
  ],
}).then(r => {
  assert.equal(r.outcome, 'navigating');
  assert.equal(r.page.location.href, 'https://lucida.to/a/air');
  assert.equal(r.candidates[0].title, "Rollin' (Air Raid Vehicle)");
}));

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

test('a generic store error does not claim the recording is missing', () => run(FETISH, { error: 'Uh-oh! Backend error' })
  .then((r) => assert.equal(r.outcome, 'search-unavailable')));

test('recognises an explicit empty search response', () => run(FETISH, { error: 'No results found' })
  .then((r) => assert.equal(r.outcome, 'no-results')));

test('invalid country retries with a region supplied by Lucida', async () => {
  const page = makeLucidaPage({ href: 'https://lucida.to/search?query=Rollin&service=qobuz', error: 'Uh-oh! An error occurred. Invalid country for qobuz' });
  const query = page.document.querySelector;
  page.document.querySelector = selector => selector === 'select[name="country"]'
    ? { options: [{ value: '', disabled: true }, { value: 'NL' }] } : query(selector);
  const r = await runScript(buildLucidaScript(FETISH, fast), page);
  assert.equal(r.outcome, 'navigating');
  assert.equal(page.location.href, 'https://lucida.to/search?query=Rollin&service=qobuz&country=NL');
});

test('an invalid region with no alternative is unavailable, not missing', async () => {
  const page = makeLucidaPage({ href: 'https://lucida.to/search?query=x&country=NL', error: 'Invalid country' });
  const query = page.document.querySelector;
  page.document.querySelector = selector => selector === 'select[name="country"]'
    ? { options: [{ value: 'NL' }] } : query(selector);
  const r = await runScript(buildLucidaScript(FETISH, fast), page);
  assert.equal(r.outcome, 'invalid-country');
});

test('calls a rendered but empty result list empty', () => run(FETISH, { results: [] })
  .then((r) => assert.equal(r.outcome, 'no-results')));

test('country fallback never revisits a failed region and lets the worker pace navigation', async () => {
  const page = makeLucidaPage({ href: 'https://lucida.to/search?query=x&country=US', error: 'Invalid country' });
  const query = page.document.querySelector;
  page.document.querySelector = selector => selector === 'select[name="country"]'
    ? { options: [{ value: 'NL' }, { value: 'US' }, { value: 'DE' }] } : query(selector);
  const result = await runScript(buildLucidaScript(FETISH, { ...fast, managedNavigation: true, triedCountries: ['NL'] }), page);
  assert.equal(result.country, 'DE');
  assert.match(result.url, /country=DE/);
  assert.match(page.location.href, /country=US/);
  const exhausted = await runScript(buildLucidaScript(FETISH, { ...fast, triedCountries: ['NL', 'DE'] }), page);
  assert.equal(exhausted.outcome, 'invalid-country');
});

test('explicit rate-limit messages are distinct from generic backend and country errors', async () => {
  const result = await run(FETISH, { error: 'Too many requests. Please try later.' });
  assert.equal(result.outcome, 'rate-limited');
});

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

test('release page selects the requested recording after a remix and a different song', () => run(FETISH, {
  href: 'https://lucida.to/release', downloadControl: 'button', releaseTracks: [
    { title: 'Fetish (Club Remix)', artist: 'Obzkure' },
    { title: 'Money Fetish', artist: 'Obzkure' },
    { title: 'Fetish', artist: 'Obzkure' },
  ],
}).then(r => { assert.equal(r.outcome, 'clicked-track'); assert.deepEqual(r.page.clicked, ['Fetish']); }));

test('release page refuses its album control when only a remix is available', () => run(FETISH, {
  href: 'https://lucida.to/release', downloadControl: 'button',
  releaseTracks: [{ title: 'Fetish (Remix)', artist: 'Obzkure' }],
}).then(r => { assert.equal(r.outcome, 'no-match'); assert.deepEqual(r.page.clicked, []); }));

test('release page duration gate separates identically titled edits', async () => {
  const page = makeLucidaPage({ href: 'https://lucida.to/release', releaseTracks: [
    { title: 'Fetish', artist: 'Obzkure', duration: '4:00', label: 'long edit' },
    { title: 'Fetish', artist: 'Obzkure', duration: '3:00', label: 'requested recording' },
  ] });
  const r = await runScript(buildLucidaScript({ ...FETISH, durationSec: 180 }, fast), page);
  assert.equal(r.outcome, 'clicked-track'); assert.deepEqual(page.clicked, ['requested recording']);
});

test('a search backend outage is distinguished from one unavailable recording', () => run(FETISH, { error: 'Backend temporarily unavailable' })
  .then(r => assert.equal(r.outcome, 'search-unavailable')));
