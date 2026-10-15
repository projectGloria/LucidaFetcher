import { test } from 'node:test';
import assert from 'node:assert/strict';
import { score, rankCandidates, isAcceptable, norm } from '../src/engine/matching.mjs';
import { buildSearchVariants, buildSearchQuery } from '../src/engine/variants.mjs';
import { buildPlan } from '../src/engine/chain.mjs';

test('Rollin gets a useful broad query within the two-attempt budget', () => {
  const variants = buildSearchVariants("Rollin' (Air Raid Vehicle)", 'Limp Bizkit');
  assert.deepEqual(buildPlan({ variants, services: ['qobuz'] }).map(step => step.query), [
    "Rollin' (Air Raid Vehicle) Limp Bizkit", 'Rollin Limp Bizkit',
  ]);
  assert.ok(isAcceptable(score({ title: "Rollin' (Air Raid Vehicle)", artist: 'Limp Bizkit' }, "Rollin' (Air Raid Vehicle)", 'Limp Bizkit')));
  assert.equal(isAcceptable(score({ title: "Rollin' (Air Raid Vehicle)", artist: 'Limp Bizkit' }, "Rollin' (Urban Assault Vehicle)", 'Limp Bizkit')), false);
});

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

test('folds Latin accents and preserves non-Latin scripts and voicing', () => {
  assert.equal(norm('MATEØ Połoz'), 'mateo poloz');
  assert.equal(norm('Dxrk ダーク'), 'dxrk ダーク');
  assert.notEqual(norm('ダーク'), norm('ターク'));
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

test('an artist whose name tokenises to nothing still gates the match', () => {
  // toks() drops tokens under three characters and every stopword, so "MØ",
  // "AC/DC" and "The xx" all reduce to []. That empty list used to fall through
  // to the no-artist-credited case and set a = 1, switching the artist gate off
  // for exactly the tracks it still had to guard - any title-matching candidate
  // by any artist at all was then accepted.
  for (const [artist, wrong] of [
    ['MØ', 'Some Other Band'],
    ['AC/DC', 'Random Coverband'],
    ['The xx', 'Massive Attack'],
  ]) {
    const s = score({ title: 'Kamikaze', artist }, 'Kamikaze', wrong);
    assert.equal(s.a, 0, `${artist} accepted a track credited to ${wrong}`);
    assert.equal(isAcceptable(s), false);
  }
});

test('a short artist name still matches its own tracks', () => {
  for (const artist of ['MØ', 'AC/DC', 'The xx']) {
    assert.equal(score({ title: 'Kamikaze', artist }, 'Kamikaze', artist).a, 1, artist);
  }
  // credited in the candidate's title rather than its artist field
  assert.equal(score({ title: 'Sunset', artist: 'MØ' }, 'Sunset (MØ Edit)', 'A Label').a, 1);
  // one credit of several is enough, as for any other artist
  assert.equal(score({ title: 'Final Song', artist: 'MØ, Diplo' }, 'Final Song', 'Diplo').a, 1);
});

test('a genuinely uncredited track still gets the free pass', () => {
  assert.equal(score({ title: 'Nothing', artist: '' }, 'Nothing', 'Anyone At All').a, 1);
});

test('matches track when expected title has feat. parenthetical not present on candidate', () => {
  // Expected has "(feat. Julian Casablancas)" while candidate has plain title
  const s = score(
    { title: 'Instant Crush (feat. Julian Casablancas)', artist: 'Daft Punk' },
    'Instant Crush',
    'Daft Punk',
  );
  assert.equal(s.t, 1);
  assert.equal(s.p, 1);
  assert.equal(s.a, 1);
  assert.ok(isAcceptable(s));
});

test('matches candidate with featured artist in candidate artist string', () => {
  const s = score(
    { title: 'Instant Crush (feat. Julian Casablancas)', artist: 'Daft Punk' },
    'Instant Crush',
    'Daft Punk feat. Julian Casablancas',
  );
  assert.equal(s.t, 1);
  assert.equal(s.p, 1);
  assert.equal(s.a, 1);
  assert.ok(isAcceptable(s));
});

test('matches multi-artist collaborations with various delimiters', () => {
  // "x", "feat.", "/" delimiters between artists
  assert.equal(score({ title: 'Song', artist: 'Artist A x Artist B' }, 'Song', 'Artist A').a, 1);
  assert.equal(score({ title: 'Song', artist: 'Artist A / Artist B' }, 'Song', 'Artist B').a, 1);
  assert.equal(score({ title: 'Song', artist: 'Artist A vs. Artist B' }, 'Song', 'Artist A').a, 1);
});
