// Downloading a whole profile: the ordering, the folder shape, and the report.
//
// The parts that decide what happens are pure - which playlist goes first, what
// folder it lands in, and what the finished run says it did - so all three are
// exercised here without a browser, a webview, or Electron.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinFolder, sortPlaylists, PROFILE_ORDERS, SPOTIFY_PROFILE_SCRAPE } from '../src/engine/sources.mjs';
import { collectProfiles, reportPayload, profileSignature } from '../src/engine/profile-report.mjs';

const grid = [
  { id: 'a', name: 'Zephyr', tracks: 12 },
  { id: 'b', name: 'Alpha', tracks: 300 },
  { id: 'c', name: 'Mid', tracks: 12 },
];
const names = (list) => list.map((p) => p.name);

test('joinFolder nests without letting a name become a path', () => {
  assert.equal(joinFolder('thesimulacrum', 'Night drive'), 'thesimulacrum/Night drive');
  // A playlist called "AC/DC live" must not silently become two folders.
  assert.equal(joinFolder('User', 'AC/DC live'), 'User/ACDC live');
  assert.equal(joinFolder('', 'Only one'), 'Only one');
});

test('every offered order is one sortPlaylists actually implements', () => {
  for (const order of PROFILE_ORDERS) {
    assert.equal(sortPlaylists(grid, order.id).length, grid.length, order.id);
  }
});

test('track-count orders run both ways', () => {
  assert.deepEqual(names(sortPlaylists(grid, 'more-less')), ['Alpha', 'Zephyr', 'Mid']);
  assert.deepEqual(names(sortPlaylists(grid, 'less-more')), ['Zephyr', 'Mid', 'Alpha']);
});

test('ties keep the order the profile listed them in', () => {
  // Zephyr and Mid both have 12 tracks; the grid order is the tiebreak, so the
  // same profile sorted twice cannot come out in two different orders.
  assert.deepEqual(names(sortPlaylists(grid, 'less-more')).slice(0, 2), ['Zephyr', 'Mid']);
  assert.deepEqual(names(sortPlaylists([...grid].reverse(), 'less-more')).slice(0, 2), ['Mid', 'Zephyr']);
});

test('with no dates at all, the grid order stands in for recency', () => {
  assert.deepEqual(names(sortPlaylists(grid, 'new-old')), ['Zephyr', 'Alpha', 'Mid']);
  assert.deepEqual(names(sortPlaylists(grid, 'old-new')), ['Mid', 'Alpha', 'Zephyr']);
});

test('real dates beat the grid order when a service supplies them', () => {
  const dated = [
    { name: 'middle', addedAt: 2000 },
    { name: 'newest', addedAt: 3000 },
    { name: 'oldest', addedAt: 1000 },
  ];
  assert.deepEqual(names(sortPlaylists(dated, 'new-old')), ['newest', 'middle', 'oldest']);
  assert.deepEqual(names(sortPlaylists(dated, 'old-new')), ['oldest', 'middle', 'newest']);
});

test('sorting by name is not the default', () => {
  assert.deepEqual(names(sortPlaylists(grid, 'name-asc')), ['Alpha', 'Mid', 'Zephyr']);
  assert.deepEqual(names(sortPlaylists(grid, 'default')), ['Zephyr', 'Alpha', 'Mid']);
});

test('sortPlaylists does not reorder its argument', () => {
  const input = [...grid];
  sortPlaylists(input, 'name-asc');
  assert.deepEqual(names(input), names(grid));
});

// --- the report -----------------------------------------------------------

const item = (over) => ({
  id: over.id,
  title: over.title,
  artist: over.artist || 'Someone',
  groupId: over.groupId,
  groupName: over.groupName,
  folderName: over.folderName,
  profileId: 'profile-spotify-nihil',
  profileName: 'Nihil',
  profileUser: 'nihil',
  profileService: 'spotify',
  profileFolder: 'Nihil',
  profileOrder: 'more-less',
});

const rec = (over, status, extra = {}) => ({ item: item(over), status, ...extra });

const run = () => [
  rec({ id: '1', title: 'One', groupId: 'g1', groupName: 'First', folderName: 'Nihil/First' }, 'completed', { statusText: 'qobuz' }),
  rec({ id: '2', title: 'Two', groupId: 'g1', groupName: 'First', folderName: 'Nihil/First' }, 'skipped', { statusText: 'No source had it', tried: ['qobuz', 'tidal', 'youtube'] }),
  rec({ id: '3', title: 'Three', groupId: 'g2', groupName: 'Second', folderName: 'Nihil/Second' }, 'completed', { statusText: 'youtube' }),
];

test('a profile is only finished when every one of its tracks is', () => {
  const items = run();
  items.push(rec({ id: '4', title: 'Four', groupId: 'g2', groupName: 'Second', folderName: 'Nihil/Second' }, 'downloading'));
  const [p] = collectProfiles(items);
  assert.equal(p.done, false);
  assert.equal(p.total, 4);
  assert.equal(p.playlists[1].counts.pending, 1);
});

test('a finished profile reports per playlist, with the reasons kept', () => {
  const [p] = collectProfiles(run());
  assert.equal(p.done, true);
  assert.equal(p.downloadedCount, 2);
  assert.equal(p.missingCount, 1);
  assert.deepEqual(p.playlists.map((pl) => pl.name), ['First', 'Second']);

  const payload = reportPayload(p);
  assert.equal(payload.folderName, 'Nihil');
  assert.equal(payload.order, 'more-less');
  assert.deepEqual(payload.profile, {
    service: 'spotify', user: 'nihil', name: 'Nihil', image: null,
  });
  // The tried list is the part nothing else on disk remembers.
  assert.deepEqual(payload.playlists[0].missing[0].tried, ['qobuz', 'tidal', 'youtube']);
  assert.equal(payload.playlists[0].missing[0].reason, 'No source had it');
  assert.equal(payload.playlists[0].downloaded[0].via, 'qobuz');
});

test('tracks queued outside a profile are not swept into one', () => {
  const loose = { item: { id: 'x', title: 'Loose', groupId: 'g9', groupName: 'Hand-made' }, status: 'completed' };
  assert.deepEqual(collectProfiles([loose]), []);
  assert.equal(collectProfiles(run().concat(loose)).length, 1);
});

test('the signature changes when a retry finds something', () => {
  const before = collectProfiles(run())[0];
  const after = collectProfiles(run().map((r) => (r.status === 'skipped'
    ? { ...r, status: 'completed', statusText: 'tidal' } : r)))[0];
  assert.notEqual(profileSignature(before), profileSignature(after));
});

// --- the injected scrape --------------------------------------------------

const BACKSLASH = String.fromCharCode(92);

test('the profile scrape stays free of backslashes and parses', () => {
  // It is a template literal: a backslash here would have to be doubled to
  // survive, and node --check cannot see inside to say when one was not.
  assert.equal(SPOTIFY_PROFILE_SCRAPE.includes(BACKSLASH), false);
  assert.doesNotThrow(() => new Function('resolve', SPOTIFY_PROFILE_SCRAPE));
});

test('the scrape reports a profile header alongside the playlists', () => {
  // Asserted by name so the shape the renderer reads cannot drift away from
  // what the page script actually resolves with.
  assert.match(SPOTIFY_PROFILE_SCRAPE, /profile: profile/);
  assert.match(SPOTIFY_PROFILE_SCRAPE, /og:image/);
});
