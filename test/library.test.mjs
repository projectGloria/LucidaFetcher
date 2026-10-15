import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadLibrary, saveLibrary, sanitizeTrackFileName } from '../src/engine/library.mjs';

test('loadLibrary returns empty library when file does not exist', async () => {
  const tmp = path.join(os.tmpdir(), `lucida-test-lib-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const lib = await loadLibrary(tmp);
  assert.equal(lib.version, 1);
  assert.deepEqual(lib.playlists, []);
  assert.deepEqual(lib.tracks, {});
});

test('saveLibrary writes atomically and loadLibrary reads it back', async () => {
  const tmp = path.join(os.tmpdir(), `lucida-test-lib-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const state = {
      version: 1,
      profile: { name: 'Nihil', service: 'spotify' },
      tracks: {
        'isrc:123': { title: 'Song', artist: 'Band', file: 'Tracks/Band - Song.flac', status: 'downloaded' },
      },
      playlists: [
        { id: 'p1', name: 'Play', file: 'Playlists/Play.m3u8', trackKeys: ['isrc:123'] },
      ],
    };
    await saveLibrary(tmp, state);
    const read = await loadLibrary(tmp);
    assert.deepEqual(read, state);
  } finally {
    try { await fs.promises.rm(tmp, { recursive: true, force: true }); } catch {}
  }
});

test('loadLibrary renames corrupt file and recovers without throwing', async () => {
  const tmp = path.join(os.tmpdir(), `lucida-test-lib-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await fs.promises.mkdir(tmp, { recursive: true });
    await fs.promises.writeFile(path.join(tmp, 'library.json'), '{ invalid json ...', 'utf8');

    const read = await loadLibrary(tmp);
    assert.equal(read.version, 1);
    assert.deepEqual(read.tracks, {});

    // Check that corrupt file was preserved
    const files = await fs.promises.readdir(tmp);
    assert.equal(files.some((f) => f.includes('library.json.corrupt-')), true);
  } finally {
    try { await fs.promises.rm(tmp, { recursive: true, force: true }); } catch {}
  }
});

test('sanitizeTrackFileName sanitizes names and resolves collisions with hash', () => {
  const name1 = sanitizeTrackFileName('AC/DC', 'Highway to Hell?');
  assert.equal(name1, 'ACDC - Highway to Hell.flac');

  const claimed = new Set(['Queen - Bohemian Rhapsody.flac']);
  const name2 = sanitizeTrackFileName('Queen', 'Bohemian Rhapsody', 'isrc:ABC', claimed);
  assert.match(name2, /^Queen - Bohemian Rhapsody \[[a-f0-9]{6}\]\.flac$/);
});
