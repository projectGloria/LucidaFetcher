import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, rankCandidates, isAcceptable, norm } from '../src/engine/matching.mjs';
import { buildSearchVariants, buildSearchQuery } from '../src/engine/variants.mjs';

const S = (title, artist) => (ct, ca) => score({ title, artist }, ct, ca);

test('accepts the correct hit', () => {
  assert.deepEqual(S('Fetish', 'Obzkure')('Fetish', 'Obzkure'), { t: 1, p: 1, a: 1 });
});

test('rejects a same-title track by a different artist', () => {
  // The KAN run offered "Fetish - Selena Gomez" on qobuz.
  assert.equal(S('Fetish', 'Obzkure')('Fetish', 'Selena Gomez').a, 0);
  assert.equal(S('Montana', 'BeeBars')('Magic Metal Montana', 'Charli xcx').a, 0);
});

test('an artist token alone is not an artist match', () => {
  // "Billy Joel" once satisfied a search for "Joel Nielsen" on "joel" alone.
  assert.equal(S('X Marks', 'Joel Nielsen')('X Marks', 'Billy Joel').a, 0);
});

test('a version marker on one side only is disqualifying', () => {
  assert.equal(S('No Glory (Remix)', 'X')('No Glory', 'X').t, 0);
  assert.equal(S('No Glory', 'X')('No Glory (Slowed + Reverb)', 'X').t, 0);
  assert.equal(S('No Glory (Remix)', 'X')('No Glory (Remix)', 'X').t, 1);
});

test('"version"/"original" describe an ordinary release, not an altered cut', () => {
  assert.ok(isAcceptable(S('Propane Nightmares', 'Pendulum')('Propane Nightmares (album version)', 'Pendulum')));
});

test('folds stroked letters and strips non-latin scripts', () => {
  assert.equal(norm('MATEØ Połoz'), 'mateo poloz');
  assert.equal(norm('Dxrk ダーク'), 'dxrk');
});

test('matches an artist credited only inside the candidate title', () => {
  assert.equal(S('The Mad Devil', 'MATEØ')('The Mad Devil (MATEØ)', 'Rok Nardin').a, 1);
});

test('an exact title outranks one that merely contains it', () => {
  // "Money Fetish" is a different song, but every expected token ('fetish') is
  // present in it, so recall alone scored it a perfect tie with the real track.
  const exact = S('Fetish', 'Obzkure')('Fetish', 'Obzkure');
  const superset = S('Fetish', 'Obzkure')('Money Fetish', 'Obzkure');
  assert.equal(exact.t, superset.t, 'recall cannot separate these');
  assert.ok(exact.p > superset.p, 'precision must');
});

test('rankCandidates returns every candidate, best first', () => {
  // The old cascade sorted, took [0] and threw the rest away, so one failed
  // stream resolution killed the track. Callers must see the alternatives.
  const ranked = rankCandidates({ title: 'Fetish', artist: 'Obzkure' }, [
    { title: 'Money Fetish', artist: 'Obzkure' },
    { title: 'Fetish', artist: 'Obzkure' },
    { title: 'Fetish', artist: 'Selena Gomez' },
  ]);
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0].title, 'Fetish');
  assert.equal(ranked[0].artist, 'Obzkure');
  assert.ok(ranked[0].acceptable);
  assert.ok(!ranked.find((c) => c.artist === 'Selena Gomez').acceptable);
});

test('every KAN failure yields more than one distinct query', () => {
  // Each of these collapsed to a single variant before, so the retry path was
  // dead on arrival for all of them.
  for (const [title, artist] of [
    ['Fetish', 'Obzkure'], ['Dark Essence', 'Dirrek, Tsunca'],
    ['Imperial Ghost', 'Blazzefall'], ['Wait (Slowed)', 'WIB3X'], ['Montana', 'BeeBars'],
  ]) {
    const v = buildSearchVariants(title, artist);
    assert.ok(v.length > 1, `${title} produced only ${v.length} variant(s)`);
    assert.equal(new Set(v).size, v.length, 'variants must be distinct');
  }
});

test('drops a feat. credit from the query but keeps it for scoring', () => {
  assert.equal(buildSearchQuery('Dark Essence (feat. Tsunca)', 'Dirrek'), 'Dark Essence Dirrek');
});
