import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackKey } from '../src/engine/trackKey.mjs';

test('trackKey prioritizes ISRC over service ID over artist/title', () => {
  assert.equal(
    trackKey({ isrc: 'gbum71029604', service: 'spotify', trackId: '123', title: 'Song', artist: 'Band' }),
    'isrc:GBUM71029604'
  );
  assert.equal(
    trackKey({ service: 'Spotify', trackId: 'abc456', title: 'Song', artist: 'Band' }),
    'spotify:abc456'
  );
  assert.equal(
    trackKey({ title: 'Song', artist: 'Band' }),
    'na:band|song'
  );
});

test('trackKey normalizes case, punctuation and diacritics', () => {
  const k1 = trackKey({ title: 'Dvořák: Symphony No. 9', artist: 'Antonín Dvořák' });
  const k2 = trackKey({ title: 'Dvorak - Symphony No 9', artist: 'Antonin Dvorak' });
  assert.equal(k1, k2);
  assert.equal(k1, 'na:antonindvorak|dvoraksymphonyno9');
});

test('trackKey supports non-Latin scripts (Japanese, Cyrillic, Arabic, Korean)', () => {
  const jp = trackKey({ title: '千本桜', artist: '初音ミク' });
  assert.equal(jp, 'na:初音ミク|千本桜');

  const ru = trackKey({ title: 'Группа крови', artist: 'Кино' });
  assert.equal(ru, 'na:кино|группакрови');

  const ar = trackKey({ title: 'تملي معاك', artist: 'عمرو دياب' });
  assert.equal(ar, 'na:عمرودياب|تمليمعاك');

  const ko = trackKey({ title: '강남스타일', artist: '싸이' });
  assert.equal(ko, 'na:싸이|강남스타일');
});

test('trackKey treats different song cuts and versions as distinct', () => {
  const orig = trackKey({ title: 'Bohemian Rhapsody', artist: 'Queen' });
  const live = trackKey({ title: 'Bohemian Rhapsody (Live at Wembley)', artist: 'Queen' });
  const remaster = trackKey({ title: 'Bohemian Rhapsody - 2011 Remaster', artist: 'Queen' });
  assert.notEqual(orig, live);
  assert.notEqual(orig, remaster);
  assert.notEqual(live, remaster);
});

test('trackKey throws when no identifier or text exists', () => {
  assert.throws(() => trackKey({}), /Cannot derive track key/);
  assert.throws(() => trackKey({ title: '!!!', artist: '???' }), /Cannot derive track key/);
});
