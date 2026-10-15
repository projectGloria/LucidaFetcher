import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller, COMPLETED } from '../src/engine/controller.mjs';

const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

test('addProfile deduplicates tracks across multiple playlists in the download pool', async () => {
  const submittedItems = [];
  const controller = new Controller({
    services: ['qobuz'],
    concurrency: 2,
    getWorker: () => ({
      run: async (item) => {
        submittedItems.push(item);
        return { outcome: 'completed', savePath: `Tracks/${item.artist} - ${item.title}.flac`, file: `${item.artist} - ${item.title}.flac`, bytes: 1000 };
      },
    }),
  });

  const profileMeta = { id: 'prof-1', user: 'testuser', name: 'Test User', folderName: 'TestUser' };

  // Playlist 1 has Track A and Track B
  // Playlist 2 has Track B (repeat) and Track C
  // Playlist 3 has Track A (repeat)
  const keyA = 'isrc:GBUM71029604';
  const keyB = 'isrc:USRC17607839';
  const keyC = 'na:daftpunk|getlucky';

  const playlists = [
    { id: 'pl-1', name: 'Rock Mix', trackKeys: [keyA, keyB] },
    { id: 'pl-2', name: 'Party Mix', trackKeys: [keyB, keyC] },
    { id: 'pl-3', name: 'Favorites', trackKeys: [keyA] },
  ];

  const tracks = {
    [keyA]: { title: 'Bohemian Rhapsody', artist: 'Queen', durationSec: 354 },
    [keyB]: { title: 'Don\'t Stop Me Now', artist: 'Queen', durationSec: 210 },
    [keyC]: { title: 'Get Lucky', artist: 'Daft Punk', durationSec: 248 },
  };

  const freshCount = controller.addProfile(profileMeta, playlists, tracks);
  assert.equal(freshCount, 3, 'Only 3 unique tracks submitted to the worker pool');
  assert.equal(controller.tracks.size, 3);
  assert.equal(controller.playlists.size, 3);

  // Derived playlist items
  const pl1Items = controller.getPlaylistItems('pl-1');
  assert.equal(pl1Items.length, 2);
  assert.equal(pl1Items[0].trackKey, keyA);
  assert.equal(pl1Items[0].reused, false);
  assert.equal(pl1Items[1].trackKey, keyB);
  assert.equal(pl1Items[1].reused, false);

  const pl2Items = controller.getPlaylistItems('pl-2');
  assert.equal(pl2Items.length, 2);
  assert.equal(pl2Items[0].trackKey, keyB);
  assert.equal(pl2Items[0].reused, true, 'Track B in Playlist 2 is marked reused');
  assert.equal(pl2Items[1].trackKey, keyC);
  assert.equal(pl2Items[1].reused, false);

  const pl3Items = controller.getPlaylistItems('pl-3');
  assert.equal(pl3Items.length, 1);
  assert.equal(pl3Items[0].trackKey, keyA);
  assert.equal(pl3Items[0].reused, true, 'Track A in Playlist 3 is marked reused');

  // getItems() returns all 5 derived playlist rows
  const allDerived = controller.getItems();
  assert.equal(allDerived.length, 5);

  // Wait for pool execution
  await drain();
  assert.equal(submittedItems.length, 3, 'Worker pool ran exactly once per unique track key');

  // After completion, all rows reflect completed status
  const updatedPl1 = controller.getPlaylistItems('pl-1');
  assert.equal(updatedPl1[0].status, COMPLETED);
  assert.equal(updatedPl1[1].status, COMPLETED);

  const updatedPl2 = controller.getPlaylistItems('pl-2');
  assert.equal(updatedPl2[0].status, COMPLETED);
  assert.equal(updatedPl2[1].status, COMPLETED);

  controller.dispose();
});

test('removeGroup refcounts tracks across playlists and cancels only orphaned pending tracks', async () => {
  let cancelledId = null;
  const controller = new Controller({
    services: ['qobuz'],
    concurrency: 3,
    getWorker: () => ({
      run: async (item, step, signal) => {
        signal.addEventListener('abort', () => { cancelledId = item.id; });
        return new Promise(() => {}); // never finishes to simulate in-flight
      },
    }),
  });

  const profileMeta = { id: 'prof-1', user: 'testuser' };
  const keyShared = 'isrc:SHARED12345';
  const keyOnlyPl1 = 'isrc:ONLYPL1';
  const keyOnlyPl2 = 'isrc:ONLYPL2';

  const playlists = [
    { id: 'pl-1', name: 'Playlist One', trackKeys: [keyShared, keyOnlyPl1] },
    { id: 'pl-2', name: 'Playlist Two', trackKeys: [keyShared, keyOnlyPl2] },
  ];

  const tracks = {
    [keyShared]: { title: 'Shared Song', artist: 'Artist S' },
    [keyOnlyPl1]: { title: 'Pl1 Song', artist: 'Artist 1' },
    [keyOnlyPl2]: { title: 'Pl2 Song', artist: 'Artist 2' },
  };

  controller.addProfile(profileMeta, playlists, tracks);
  assert.equal(controller.tracks.size, 3);
  await drain();

  // Remove Playlist One
  controller.removeGroup('pl-1');

  // pl-1 should be removed from playlists
  assert.equal(controller.playlists.has('pl-1'), false);
  assert.equal(controller.playlists.has('pl-2'), true);

  // keyShared is still referenced by pl-2, so it MUST stay in controller.tracks
  assert.equal(controller.tracks.has(keyShared), true);

  // keyOnlyPl1 is no longer referenced by any playlist, so it was orphaned and removed
  assert.equal(controller.tracks.has(keyOnlyPl1), false);

  // keyOnlyPl2 still belongs to pl-2
  assert.equal(controller.tracks.has(keyOnlyPl2), true);
  assert.equal(cancelledId, keyOnlyPl1);

  controller.dispose();
});

test('addProfile respects already completed tracks and does not re-submit them', async () => {
  const submitted = [];
  const controller = new Controller({
    services: ['qobuz'],
    concurrency: 1,
    getWorker: () => ({
      run: async (item) => {
        submitted.push(item.id);
        return { outcome: 'completed' };
      },
    }),
  });

  const profileMeta = { id: 'prof-1' };
  const keyDone = 'isrc:ALREADYDONE';
  const keyNew = 'isrc:NEWMUSIC';

  const playlists = [
    { id: 'pl-1', name: 'Mix', trackKeys: [keyDone, keyNew] },
  ];

  const tracks = {
    [keyDone]: {
      title: 'Old Song',
      artist: 'Artist',
      status: 'downloaded',
      file: 'Tracks/Artist - Old Song.flac',
      bytes: 12345,
    },
    [keyNew]: {
      title: 'New Song',
      artist: 'Artist',
      status: 'pending',
    },
  };

  const fresh = controller.addProfile(profileMeta, playlists, tracks);
  assert.equal(fresh, 1, 'Only 1 new track submitted to pool');
  assert.equal(controller.tracks.get(keyDone).status, COMPLETED);
  assert.equal(controller.tracks.get(keyDone).file, 'Tracks/Artist - Old Song.flac');

  await drain();
  assert.deepEqual(submitted, [keyNew]);

  controller.dispose();
});
