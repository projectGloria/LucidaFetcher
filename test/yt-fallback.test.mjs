import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickYouTube, cleanYouTubeTitle } from '../src/engine/yt-fallback.mjs';

const FETISH = { title: 'Fetish', artist: 'Obzkure' };

test('strips upload furniture from a title', () => {
  assert.equal(cleanYouTubeTitle('Obzkure - Fetish (Official Music Video) [HD]'), 'Obzkure - Fetish');
  assert.equal(cleanYouTubeTitle('Fetish | Obzkure | Official Audio'), 'Fetish Obzkure');
});

test('picks the real upload', () => {
  const { chosen } = pickYouTube(FETISH, [
    { title: 'Obzkure - Fetish (Official Video)', uploader: 'Obzkure', url: 'u1' },
  ]);
  assert.equal(chosen.url, 'u1');
});

test('reads an "Artist - Title" upload where the artist leads', () => {
  const { chosen } = pickYouTube(FETISH, [
    { title: 'Obzkure - Fetish', uploader: 'Some Label', url: 'u1' },
  ]);
  assert.ok(chosen, 'artist in the title half must still match');
});

test('refuses an altered cut', () => {
  // YouTube results for this genre are thick with these; taking one would be a
  // wrong file rather than the skip it replaced.
  const { chosen } = pickYouTube(FETISH, [
    { title: 'Obzkure - Fetish (Slowed + Reverb)', uploader: 'slowed nation', url: 'u1' },
    { title: 'Fetish - Obzkure [Nightcore]', uploader: 'nc', url: 'u2' },
  ]);
  assert.equal(chosen, null);
});

test('refuses a different artist', () => {
  const { chosen } = pickYouTube(FETISH, [
    { title: 'Selena Gomez - Fetish (Official Video)', uploader: 'SelenaGomezVEVO', url: 'u1' },
  ]);
  assert.equal(chosen, null);
});

test('refuses an hour-long mix that merely names the track', () => {
  const { ranked } = pickYouTube(
    { ...FETISH, durationSec: 195 },
    [{ title: 'Obzkure - Fetish', uploader: 'Obzkure', url: 'u1', durationSec: 3600 }]
  );
  assert.equal(ranked[0].acceptable, false);
  assert.match(ranked[0].reason, /duration off/);
});

test('accepts a duration within normal drift', () => {
  const { chosen } = pickYouTube(
    { ...FETISH, durationSec: 195 },
    [{ title: 'Obzkure - Fetish', uploader: 'Obzkure', url: 'u1', durationSec: 201 }]
  );
  assert.equal(chosen.url, 'u1');
});

test('prefers the exact upload over a longer title containing it', () => {
  const { chosen } = pickYouTube(FETISH, [
    { title: 'Obzkure - Money Fetish', uploader: 'Obzkure', url: 'wrong' },
    { title: 'Obzkure - Fetish', uploader: 'Obzkure', url: 'right' },
  ]);
  assert.equal(chosen.url, 'right');
});
