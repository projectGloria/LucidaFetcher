import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatM3U8 } from '../src/engine/m3u8.mjs';

test('formatM3U8 generates valid #EXTM3U with relative paths', () => {
  const playlist = {
    name: 'Rock Classics',
    trackKeys: ['queen-bohemian', 'daft-getlucky', 'queen-bohemian'],
  };
  const tracks = {
    'queen-bohemian': {
      title: 'Bohemian Rhapsody',
      artist: 'Queen',
      durationSec: 354,
      file: 'Tracks/Queen - Bohemian Rhapsody.flac',
      status: 'downloaded',
    },
    'daft-getlucky': {
      title: 'Get Lucky',
      artist: 'Daft Punk',
      durationSec: 248.4,
      file: 'Tracks/Daft Punk - Get Lucky.flac',
      status: 'downloaded',
    },
  };

  const output = formatM3U8(playlist, tracks);
  const expected = [
    '#EXTM3U',
    '#EXTINF:354,Queen - Bohemian Rhapsody',
    '../Tracks/Queen - Bohemian Rhapsody.flac',
    '#EXTINF:248,Daft Punk - Get Lucky',
    '../Tracks/Daft Punk - Get Lucky.flac',
    '#EXTINF:354,Queen - Bohemian Rhapsody',
    '../Tracks/Queen - Bohemian Rhapsody.flac',
    '',
  ].join('\n');

  assert.equal(output, expected);
});

test('formatM3U8 omits non-downloaded tracks by default', () => {
  const playlist = {
    name: 'Mix',
    trackKeys: ['track-1', 'track-2', 'track-3'],
  };
  const tracks = new Map([
    ['track-1', { title: 'One', artist: 'Band', file: 'Tracks/Band - One.flac', status: 'downloaded' }],
    ['track-2', { title: 'Two', artist: 'Band', file: 'Tracks/Band - Two.flac', status: 'pending' }],
    ['track-3', { title: 'Three', artist: 'Band', file: 'Tracks/Band - Three.flac', status: 'failed' }],
  ]);

  const output = formatM3U8(playlist, tracks);
  const lines = output.trim().split('\n');
  assert.equal(lines.length, 3); // #EXTM3U + #EXTINF + path
  assert.equal(lines[1], '#EXTINF:-1,Band - One');
  assert.equal(lines[2], '../Tracks/Band - One.flac');
});
