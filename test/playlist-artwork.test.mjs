import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { startEngine } from '../src/engine/renderer-integration.mjs';
import { syncProfileLibrary } from '../src/engine/profile-output.mjs';
import { Controller } from '../src/engine/controller.mjs';
import { normalizeQueueSnapshot } from '../src/engine/renderer-integration.mjs';
import { refreshSpotifyArtwork } from '../src/engine/spotify-artwork.mjs';

test('reimport repairs a completed track cover across every playlist without downloading it again', () => {
  const c = new Controller();
  c.pause();
  try {
    const playlists = ['a', 'b'].map(id => ({ id, name: id, artwork: id + '.jpg', trackKeys: ['song'] }));
    c.addProfile({ id: 'user', image: '' }, playlists, { song: { title: 'Song', artist: 'Artist', image: 'a.jpg', status: 'downloaded', file: 'song.flac' } });
    assert.equal(c.addProfile({ id: 'user', image: 'avatar.jpg' }, playlists, { song: { title: 'Song', artist: 'Artist', image: 'album.jpg' } }), 0);
    assert.ok(c.getItems().every(rec => rec.item.image === 'album.jpg' && rec.item.profileArtwork === 'avatar.jpg' && rec.status === 'completed'));
    assert.deepEqual(c.getItems().map(rec => rec.item.groupArtwork), ['a.jpg', 'b.jpg']);
  } finally { c.dispose(); }
});

test('restoring an older queue upgrades generated search queries and preserves custom ones', () => {
  const title = "Rollin' (Air Raid Vehicle)";
  const first = title + ' Limp Bizkit';
  const old = { title, artist: 'Limp Bizkit', searchVariants: [first, "Rollin' Air Raid Vehicle Limp Bizkit"] };
  const custom = { ...old, searchVariants: ['my search', 'my retry'] };
  const restored = normalizeQueueSnapshot({ v: 4, items: [old, custom], tracks: [old] });
  assert.equal(restored.items[0].searchVariants[1], 'Rollin Limp Bizkit');
  assert.equal(restored.tracks[0].searchVariants[1], 'Rollin Limp Bizkit');
  assert.deepEqual(restored.items[1].searchVariants, custom.searchVariants);
});

test('the whole-profile UI queues metadata before loading individual Spotify covers', async () => {
  const source = await fs.readFile(new URL('../src/ui/views/AddView.jsx', import.meta.url), 'utf8');
  const { createSources } = await import('../src/engine/sources.mjs');
  const embed = entity => `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })}</script>`;
  const sources = createSources({ fetch: async url => ({ text: async () => embed(url.includes('/embed/playlist/')
    ? { name: 'Mix', coverArt: { sources: [{ url: 'playlist.jpg' }] }, trackList: [{ uri: 'spotify:track:song', title: 'Song', subtitle: 'Artist' }] }
    : { visualIdentity: { image: [{ url: 'album.jpg', maxWidth: 640 }] } }) }) });
  const sandbox = { sources, console };
  const read = source.slice(source.indexOf('  const readPlaylist ='), source.indexOf('  const profileMeta ='));
  const readOne = source.slice(source.indexOf('  const readOne ='), source.indexOf('  const downloadProfile ='));
  vm.runInNewContext(read + readOne + '\nthis.readOne = readOne;', sandbox);
  const out = await sandbox.readOne({ service: 'spotify', id: 'p', name: 'Mix', image: 'playlist.jpg' }, []);
  assert.equal(out.results[0].image, 'playlist.jpg');
  assert.equal(out.results[0].artworkPending, true);
  assert.equal(out.group.artworkUrl, 'playlist.jpg');
  const c = new Controller();
  c.pause();
  try {
    c.addProfile({ id: 'user' }, [{ id: 'p', artwork: 'playlist.jpg', trackKeys: ['song'] }], {
      song: { title: 'Song', artist: 'Artist', image: out.results[0].image, artworkPending: out.results[0].artworkPending, service: 'spotify', trackId: 'song' },
    });
    assert.equal(c.pool.pending, 1);
    await refreshSpotifyArtwork(c, sources);
    assert.equal(c.getItem('song').item.image, 'album.jpg');
    assert.equal(c.getItems()[0].item.groupArtwork, 'playlist.jpg');
    assert.equal(c.pool.pending, 1);
  } finally { c.dispose(); }
});

test('reimporting a fully downloaded loose playlist still schedules its missing cover', async () => {
  const source = await fs.readFile(new URL('../src/ui/views/AddView.jsx', import.meta.url), 'utf8');
  const sent = [];
  const sandbox = { isElectron: true, ipc: {
    send: (...args) => sent.push(args),
    invoke: async () => [{ done: true }, { done: true }],
  } };
  vm.runInNewContext(source.slice(source.indexOf('async function withoutExisting('), source.indexOf('function EmptyArtwork(')), sandbox);
  const result = await sandbox.withoutExisting([
    { folderName: 'Mix', groupArtwork: 'cover.jpg' }, { folderName: 'Mix', groupArtwork: 'cover.jpg' },
  ]);
  assert.equal(result.items.length, 0); assert.equal(result.skipped, 2);
  assert.equal(sent.length, 1); assert.equal(sent[0][0], 'playlist-artwork-sync');
  assert.equal(sent[0][1].folderName, 'Mix'); assert.equal(sent[0][1].url, 'cover.jpg');
});

test('profile output saves distinct playlist covers without any audio transfers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lucida-covers-'));
  const artworks = [];
  try {
    const state = await syncProfileLibrary(root, { profile: { image: 'profile.jpg' }, tracks: {}, playlists: [
      { id: 'a', name: 'Mix', artwork: 'a.jpg', trackKeys: [] },
      { id: 'b', name: 'Mix', artwork: 'b.jpg', trackKeys: [] },
    ] }, { validateFile: () => true, saveArtwork: (url, file) => artworks.push({ url, file }) });
    assert.deepEqual(artworks.map(a => a.url), ['profile.jpg', 'a.jpg', 'b.jpg']);
    assert.equal(artworks[0].file, path.join(root, 'cover.jpg'));
    for (let i = 0; i < 2; i++) assert.equal(artworks[i + 1].file, path.join(root, state.playlists[i].file.replace(/\.m3u8$/, '.jpg')));
    assert.notEqual(artworks[1].file, artworks[2].file);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('renderer preserves playlist artwork and avoids library writes for search-status changes', async () => {
  const sent = [];
  const c = startEngine({ concurrency: 1, ipcRenderer: { on() {}, send: (...args) => sent.push(args) }, container: { querySelectorAll: () => [{ remove() {} }] } });
  c.pause();
  try {
    c.add([{ id: 'loose', title: 'Song', artist: 'Artist', folderName: 'Loose', groupArtwork: 'loose.jpg' }]);
    assert.equal(sent.find(([channel]) => channel === 'playlist-artwork-sync')[1].url, 'loose.jpg');
    c.addProfile({ id: 'profile', folderName: 'Profile', image: 'avatar.jpg' }, [{ id: 'p', name: 'Playlist', artwork: 'playlist.jpg', trackKeys: ['song'] }], { song: { title: 'Song', artist: 'Artist' } });
    await new Promise(resolve => setTimeout(resolve, 280));
    const syncs = () => sent.filter(([channel]) => channel === 'profile-library-sync');
    assert.equal(syncs().length, 1);
    assert.equal(syncs()[0][1].state.playlists[0].artwork, 'playlist.jpg');
    assert.equal(syncs()[0][1].state.profile.image, 'avatar.jpg');
    c._set(c.getItem('song'), 'searching', 'Searching');
    await new Promise(resolve => setTimeout(resolve, 280));
    assert.equal(syncs().length, 1, 'searching does not rewrite the library or revalidate files');
    const rec = c.getItem('song'); rec.file = 'song.flac'; rec.bytes = 100;
    c._set(rec, 'completed', 'Downloaded');
    await new Promise(resolve => setTimeout(resolve, 280));
    assert.equal(syncs().length, 2, 'completion still updates the library');
  } finally { c.dispose(); }
});

test('artwork saving limits fetch concurrency, deduplicates targets, repairs empty files and retries failures', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lucida-artwork-'));
  try {
    const main = (await fs.readFile(new URL('../main.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    let active = 0, peak = 0, fetched = 0, fail = true;
    const jpeg = Buffer.from([255, 216, 255, 217]);
    const sandbox = { fs: { promises: fs }, path, process, ipcMain: { on() {} }, logEvent() {}, savePathKey: file => file.toLowerCase(),
      nativeImage: { createFromBuffer: () => ({ isEmpty: () => false, toJPEG: () => jpeg }) },
      safeFetchImage: async url => {
        active++; peak = Math.max(active, peak); fetched++;
        try {
          await new Promise(resolve => setTimeout(resolve, 5));
          if (url.includes('fail') && fail) throw new Error('temporary fetch failure');
          return { buf: Buffer.from('png'), url: new URL(url) };
        } finally { active--; }
      },
    };
    vm.runInNewContext(main.slice(main.indexOf('const pendingArtworkDownloads ='), main.indexOf('const flacIdentityCache =')), sandbox);
    const file = i => path.join(root, 'nested', i + '.jpg');
    await fs.mkdir(path.dirname(file(0)), { recursive: true }); await fs.writeFile(file(0), '');
    const writes = Array.from({ length: 9 }, (_, i) => sandbox.downloadArtwork('https://art.example/' + i, file(i)));
    assert.equal(sandbox.downloadArtwork('https://art.example/0', file(0)), writes[0]);
    await Promise.all(writes);
    assert.equal(peak, 4); assert.equal(fetched, 9);
    assert.deepEqual(await fs.readFile(file(0)), jpeg);
    await sandbox.downloadArtwork('https://art.example/0', file(0)); assert.equal(fetched, 9);
    await sandbox.downloadArtwork('https://art.example/fail', file(10));
    await assert.rejects(fs.stat(file(10)), { code: 'ENOENT' });
    fail = false; await sandbox.downloadArtwork('https://art.example/fail', file(10));
    assert.deepEqual(await fs.readFile(file(10)), jpeg);
    assert.ok((await fs.readdir(path.dirname(file(0)))).every(name => !name.endsWith('.tmp')));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
