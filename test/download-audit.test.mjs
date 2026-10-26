import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Controller } from '../src/engine/controller.mjs';
import { attachPersistence, startEngine, normalizeQueueSnapshot } from '../src/engine/renderer-integration.mjs';
import { score, isAcceptable, injectableScorer } from '../src/engine/matching.mjs';
import { trackKey } from '../src/engine/trackKey.mjs';
import { createSources, classifyInput } from '../src/engine/sources.mjs';
import { syncProfileLibrary, loadValidatedLibrary } from '../src/engine/profile-output.mjs';
import { saveLibrary } from '../src/engine/library.mjs';
import { buildLucidaScript } from '../src/engine/cascade-lucida.mjs';
import { makeLucidaPage } from './fake-dom.mjs';

const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const excerpt = (from, to) => main.slice(main.indexOf(from), main.indexOf(to));
const drain = async () => { for (let n = 0; n < 50; n++) await Promise.resolve(); };
const profile = { id: 'p', name: 'Profile', user: 'fixture', folderName: 'Profile' };
const playlists = [{ id: 'a', name: 'Mix', trackKeys: ['shared'] }, { id: 'b', name: 'Mix', trackKeys: ['shared'] }];
const track = { title: 'Song', artist: 'Artist' };

test('title gate rejects superset songs, omitted words, edits and repeated-word false positives', () => {
  for (const [expected, candidate] of [['Fetish', 'Money Fetish'], ['Fetish', 'Fetish (Club Mix)'], ['The Song', 'Song'], ['No No', 'No Yes']]) {
    assert.equal(isAcceptable(score({ title: expected, artist: 'Artist' }, candidate, 'Artist')), false, candidate);
    const sandbox = {};
    vm.runInNewContext(injectableScorer({ title: expected, artist: 'Artist' }) + `globalThis.ok = isAcceptable(score(${JSON.stringify(candidate)}, 'Artist'), MIN_TITLE_SCORE);`, sandbox);
    assert.equal(sandbox.ok, false, 'injected code must enforce the same gate');
  }
});

test('short and Unicode titles match, but a different Unicode artist does not', () => {
  for (const [title, artist] of [['Go', 'MØ'], ['夜', '東京'], ['Привет', 'Молчат Дома'], ['봄날', '방탄소년단'], ['حب', 'عمرو دياب']]) {
    assert.ok(isAcceptable(score({ title, artist }, title, artist)), title);
    assert.equal(isAcceptable(score({ title, artist }, title, 'Other Artist')), false, artist);
  }
  assert.notEqual(trackKey({ title: 'ダーク', artist: 'X' }), trackKey({ title: 'ターク', artist: 'X' }));
});

test('Lucida never returns a different song or club cut as a failed-stream alternate', async () => {
  const page = makeLucidaPage({ results: [
    { title: 'Fetish', artist: 'Obzkure', href: 'https://lucida.to/exact' },
    { title: 'Money Fetish', artist: 'Obzkure', href: 'https://lucida.to/wrong' },
    { title: 'Fetish (Club Mix)', artist: 'Obzkure', href: 'https://lucida.to/edit' },
    { title: 'Fetish (Original Mix)', artist: 'Obzkure', href: 'https://lucida.to/pressing' },
  ] });
  const result = await vm.runInNewContext(buildLucidaScript({ title: 'Fetish', artist: 'Obzkure' }), { ...page, setInterval, clearInterval });
  assert.deepEqual(Array.from(result.alternates), ['https://lucida.to/pressing']);
});

test('a track-specific provider failure does not suppress that provider for another track', async () => {
  const seen = [];
  const c = new Controller({ services: ['qobuz'], concurrency: 1, getWorker: () => ({ run: async item => {
    seen.push(item.id); return { outcome: item.id === 'missing' ? 'provider-failed' : 'completed' };
  } }) });
  c.add([{ id: 'missing', ...track, searchVariants: ['Song'] }, { id: 'found', title: 'Other', artist: 'Artist', searchVariants: ['Other'] }]);
  await drain();
  assert.deepEqual(seen, ['missing', 'found']);
  assert.equal(c.getItem('found').status, 'completed');
  c.dispose();
});

test('profile rows keep live progress for every playlist membership', () => {
  const c = new Controller(); c.pause(); c.addProfile(profile, playlists, { shared: track });
  c.noteProgress('shared', 10, 100);
  const rows = c.getItems();
  c.noteProgress('shared', 80, 100);
  for (const row of rows) { assert.equal(row.progress, 0.8); assert.equal(row.receivedBytes, 80); }
  c.dispose();
});

test('profile persistence retains completed membership and resumable canonical tracks', async () => {
  const sent = [];
  const c = new Controller(); c.pause();
  const stop = attachPersistence(c, { send: (...args) => sent.push(args) });
  c.addProfile(profile, playlists.map(pl => ({ ...pl, trackKeys: ['shared', 'done'] })), {
    shared: track, done: { title: 'Complete', artist: 'Artist', status: 'downloaded', file: 'done.flac', bytes: 100 },
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  const snap = sent.find(([name]) => name === 'queue-save')[1];
  assert.equal(snap.v, 4); assert.equal(snap.items.length, 0); assert.equal(snap.tracks.length, 2);
  let finish;
  const resumed = new Controller({ awaitTransfer: () => new Promise(resolve => { finish = resolve; }) });
  const channels = [];
  const off = attachPersistence(resumed, { send() {}, invoke: async (name, list, opts) => {
    channels.push(name);
    if (name === 'queue-load') return snap;
    if (name === 'transfers-resumable') return [{ itemId: 'shared', received: 20, total: 100 }];
    if (name === 'downloads-check') { assert.deepEqual(opts, { restore: true }); return list.map(() => ({ done: true, file: 'done.flac', bytes: 100 })); }
    if (name === 'transfer-resume') return { ok: true };
  } });
  const result = await resumed.restore();
  assert.ok(channels.indexOf('transfers-resumable') < channels.indexOf('downloads-check'));
  assert.equal(result.resumed, 1); assert.equal(resumed.tracks.size, 2); assert.equal(resumed.items.size, 0);
  const firstPlFolder = resumed.playlists.get('a').folder;
  assert.equal(resumed.getItem('shared').item.folderName, `Profile/${firstPlFolder}`);
  assert.equal(resumed.getPlaylistItems('b').length, 2);
  assert.equal(resumed.getItem('shared').status, 'downloading', 'resume wins over any completion guess');
  finish({ status: 'completed', file: 'actual (1).flac', savePath: '/fixture/actual (1).flac', bytes: 100 });
  await drain();
  assert.equal(resumed.getItem('shared').status, 'completed');
  assert.equal(resumed.getPlaylistItems('b')[0].file, 'actual (1).flac');
  stop(); off(); c.dispose(); resumed.dispose();
});

test('legacy profile display rows migrate without dropping shared membership', () => {
  const rows = playlists.map(pl => ({ id: 'shared', key: 'shared', ...track, profileId: 'p', profileFolder: 'Profile', folderName: 'Profile/Playlists', groupId: pl.id, groupName: pl.name }));
  const snap = normalizeQueueSnapshot({ v: 3, items: rows });
  assert.equal(snap.tracks.length, 1); assert.equal(snap.playlists.length, 2);
  assert.equal(snap.tracks[0].folderName, `Profile/${snap.playlists[0].folder}`);
  assert.ok(snap.playlists.every(pl => pl.trackKeys[0] === 'shared'));
});

test('every profile library receives shared canonical track metadata', () => {
  const messages = [];
  const c = startEngine({ concurrency: 1, ipcRenderer: { on() {}, send: (...args) => messages.push(args) }, container: { querySelectorAll: () => [{ remove() {} }] } });
  c.pause();
  c.addProfile(profile, [playlists[0]], { shared: { ...track, status: 'downloaded', file: 'actual.flac', savePath: '/fixture/actual.flac', bytes: 100 } });
  c.addProfile({ id: 'second', folderName: 'Second' }, [{ ...playlists[1], id: 'second-b' }], { shared: track });
  c.dispose();
  const payload = messages.find(([name, value]) => name === 'profile-library-sync' && value.folderName === 'Second')[1];
  assert.equal(payload.state.tracks.shared.file, 'Mix/actual.flac');
  assert.equal(payload.state.tracks.shared.sourceFolder, 'Profile');
});

test('library output validates disk files, preserves collisions, copies shared audio into each playlist folder and separates equal playlist names', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucida-output-test-'));
  try {
    const owner = path.join(temp, 'Owner'), dest = path.join(temp, 'Second');
    fs.mkdirSync(path.join(owner, 'Mix'), { recursive: true });
    const source = path.join(owner, 'Mix', 'actual (1).flac'); fs.writeFileSync(source, 'completed-fixture');
    const bytes = fs.statSync(source).size;
    const validateFile = file => { try { return fs.readFileSync(file, 'utf8') === 'completed-fixture'; } catch { return false; } };
    const snapshot = { profile, tracks: { shared: { ...track, file: 'wrong.flac', savePath: source, bytes, status: 'downloaded' } }, playlists: playlists.map(pl => ({ ...pl, file: 'Playlists/Mix.m3u8' })) };
    // Pre-populate a colliding file in the first playlist folder so collision disambiguation is tested
    const previewState = await syncProfileLibrary(path.join(temp, 'Preview'), { profile, tracks: {}, playlists: snapshot.playlists }, { validateFile });
    const firstPlFolder = previewState.playlists[0].folder;
    const secondPlFolder = previewState.playlists[1].folder;
    fs.mkdirSync(path.join(dest, firstPlFolder), { recursive: true });
    fs.writeFileSync(path.join(dest, firstPlFolder, 'actual (1).flac'), 'other-music');
    const state = await syncProfileLibrary(dest, snapshot, { validateFile });
    assert.notEqual(state.playlists[0].folder.toLowerCase(), state.playlists[1].folder.toLowerCase());
    assert.match(state.tracks.shared.file, /actual \(1\) \[/);
    const copiedFirst = path.join(dest, state.tracks.shared.file);
    const copiedSecond = path.join(dest, state.tracks.shared.playlistFiles[secondPlFolder]);
    assert.equal(fs.readFileSync(copiedFirst, 'utf8'), 'completed-fixture');
    assert.equal(fs.readFileSync(copiedSecond, 'utf8'), 'completed-fixture');
    assert.equal(fs.readFileSync(path.join(dest, firstPlFolder, 'actual (1).flac'), 'utf8'), 'other-music');
    assert.equal(fs.existsSync(path.join(dest, 'Tracks')), false);
    assert.equal(fs.existsSync(path.join(dest, 'Playlists')), false);
    assert.equal(fs.existsSync(path.join(dest, 'library.json')), false);
    const again = await syncProfileLibrary(dest, snapshot, { validateFile });
    assert.equal(again.tracks.shared.file, state.tracks.shared.file, 'sync does not make new copies');
    fs.unlinkSync(copiedFirst);
    const loaded = await loadValidatedLibrary(dest, validateFile);
    assert.equal(loaded.tracks.shared.status, 'missing');
    await saveLibrary(dest, { tracks: { escape: { status: 'downloaded', bytes, file: '../Owner/Mix/actual (1).flac' } } });
    assert.equal((await loadValidatedLibrary(dest, validateFile)).tracks.escape.status, 'missing');
    const reservedDir = path.join(temp, 'Reserved');
    let released = false;
    const copiedState = await syncProfileLibrary(reservedDir, snapshot, { validateFile, reserveCopy: target =>
      path.basename(target) === path.basename(source) ? null : () => { released = true; } });
    assert.notEqual(copiedState.tracks.shared.file, `${firstPlFolder}/${path.basename(source)}`);
    assert.ok(released, 'copy releases its reservation');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('complete-file checks reject format-only partial files and recorded length mismatches', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucida-check-test-'));
  try {
    const file = path.join(temp, 'Artist - Song.flac');
    const data = Buffer.alloc(50); data.write('fLaC'); data[4] = 0x80; data.writeUIntBE(34, 5, 3); data.writeUInt16BE(4096, 8); data.writeBigUInt64BE(100n, 18); data[42] = 0xff; data[43] = 0xf8;
    fs.writeFileSync(file, data);
    const sandbox = { fs, Buffer, path, transfers: {}, manifest: {}, saveManifest() {}, folderFor: () => temp, savePathKey: value => path.resolve(value).toLowerCase() };
    vm.runInNewContext(excerpt('function isFlacFile(', 'const mediaTransfers ='), sandbox);
    vm.runInNewContext(excerpt('const FOLD_CHARS =', 'async function isFlacFileAsync(').replace(/function folderFor\([\s\S]*?\n}\n/, ''), sandbox);
    assert.equal(sandbox.isCompleteFlacFile(file, 50), true);
    data.writeBigUInt64BE(0n, 18); fs.writeFileSync(file, data);
    assert.equal(sandbox.isCompleteFlacFile(file, 50), true, 'FLAC permits an unknown total sample count');
    assert.equal(sandbox.isCompleteFlacFile(file, 100), false);
    fs.writeFileSync(file, 'fLaC');
    assert.equal(sandbox.isCompleteFlacFile(file), false);
    assert.equal(sandbox.checkDownloaded({ savePath: file, bytes: 50 }).done, false);
    fs.writeFileSync(file, data);
    sandbox.hasEmbeddedArtwork = () => true;
    sandbox.transfers.one = { savePath: file };
    sandbox.manifest.saved = { savePath: file, bytes: 50, service: 'qobuz' };
    assert.equal(sandbox.checkDownloaded({ key: 'saved', savePath: file, bytes: 50 }).done, false, 'a pending transfer cannot be declared complete');
    delete sandbox.transfers.one;
    assert.equal(sandbox.checkDownloaded({ key: 'saved', savePath: file, bytes: 50 }).service, 'qobuz', 'recorded files retain the verified manifest provider');
    sandbox.manifest.saved.savePath = path.join(temp, 'different.flac');
    assert.equal(sandbox.checkDownloaded({ key: 'saved', savePath: file, bytes: 50 }).service, null, 'a different file cannot establish this download provider');
    // Matching filenames from an import scan must include the exact artist.
    assert.equal(sandbox.checkDownloaded({ title: 'Song', artist: 'Other' }, [{ file: path.basename(file), tokens: ['artist', 'song'] }], true).done, false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('single-track links import Spotify metadata with a canonical embed URL and Deezer album art', async () => {
  const urls = [];
  const entity = { name: 'Go', subtitle: 'Artist', duration: 180000, visualIdentity: { image: [{ url: 'cover.jpg', maxWidth: 640 }] } };
  const html = `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })}</script>`;
  const sources = createSources({ fetch: async url => { urls.push(url); return { ok: true, text: async () => html }; }, httpJson: async () => ({ id: 123, title: 'Night', artist: { name: 'Artist' }, duration: 100, album: { title: 'Album', cover_xl: 'album.jpg' } }) });
  const spotify = await sources.resolve('https://open.spotify.com/intl-en/embed/track/abc?si=x');
  assert.deepEqual(spotify.results[0].texts, ['Go', 'Artist']);
  assert.equal(spotify.results[0].durationSec, 180);
  assert.equal(urls[0], 'https://open.spotify.com/embed/track/abc');
  const deezer = await sources.resolve('https://www.deezer.com/en/track/123');
  assert.equal(deezer.results[0].image, 'album.jpg'); assert.equal(deezer.results[0].album, 'Album');
  assert.equal(classifyInput('https://evil.test/open.spotify.com/track/abc').kind, 'link');
  assert.equal(classifyInput('https://evil.test/open.spotify.com/user/abc').kind, 'unknown');
});

test('downloads-check scans all subfolders recursively and addProfile/checkExisting skip tracks already on disk', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucida-subfolder-scan-'));
  try {
    const subA = path.join(temp, 'Nihil', 'Casual');
    const subB = path.join(temp, 'Nihil', '-');
    fs.mkdirSync(subA, { recursive: true });
    fs.mkdirSync(subB, { recursive: true });
    // Build a valid FLAC with STREAMINFO (0), PICTURE (6, last), and an audio frame (0xff 0xf8)
    const flac = Buffer.alloc(60);
    flac.write('fLaC', 0, 'ascii');
    flac[4] = 0x00; flac.writeUIntBE(34, 5, 3); flac.writeUInt16BE(4096, 8);
    // 44100 Hz, 2 channels, 16 bps, 441000 samples (10s)
    const packed = (44100n << 44n) | (1n << 41n) | (15n << 36n) | 441000n;
    flac.writeBigUInt64BE(packed, 18);
    flac[42] = 0x86; flac.writeUIntBE(4, 43, 3); // PICTURE block (last=1, type=6, len=4)
    flac[50] = 0xff; flac[51] = 0xf8;

    const prodigyClean = path.join(subA, 'The Prodigy - Smack My Bitch Up.flac');
    const prodigyDup = path.join(subA, 'The Prodigy - Smack My Bitch Up (1).flac');
    const grimesFile = path.join(subA, 'Grimes - Welcome To The Opera.flac');
    fs.writeFileSync(prodigyClean, flac);
    fs.writeFileSync(prodigyDup, flac);
    fs.writeFileSync(grimesFile, flac);

    const flacMod = await import('../src/engine/flac-identity.mjs');
    const matchingMod = await import('../src/engine/matching.mjs');
    let checkHandler;
    const sandbox = {
      fs, Buffer, path,
      downloadPath: temp,
      config: { scanFolderForExisting: true },
      transfers: {},
      manifest: {},
      liveSavePaths: new Map(),
      flacIdentityCache: new Map(),
      saveManifest() {},
      savePathKey: value => path.resolve(value).toLowerCase(),
      ipcMain: { handle: (name, fn) => { if (name === 'downloads-check') checkHandler = fn; } },
      checkDownloadIdentity: async () => ({ ok: true }),
    };
    vm.runInNewContext(excerpt('function isFlacFile(', 'const mediaTransfers ='), sandbox);
    vm.runInNewContext(excerpt('const AUDIO_EXT =', 'const REPORT_NAME ='), sandbox);
    sandbox.getScanEngines = async () => ({ ...flacMod, ...matchingMod });

    const results = await checkHandler(null, [
      { key: 'spotify:prodigy', folderName: 'Nihil/-', title: 'Smack My Bitch Up', artist: 'The Prodigy', durationSec: 10 },
      { key: 'spotify:grimes', folderName: '', title: 'Welcome To The Opera (with Grimes)', artist: 'Anyma, Grimes', durationSec: 10 },
      { key: 'spotify:missing', folderName: 'Nihil/Casual', title: 'Nonexistent Song', artist: 'The Prodigy', durationSec: 10 },
    ], {});

    assert.equal(results[0].done, true, 'finds track in sibling subfolder Nihil/Casual when checking Nihil/-');
    assert.equal(results[0].file, 'The Prodigy - Smack My Bitch Up.flac', 'prefers clean filename over (1) duplicate');
    assert.equal(results[0].savePath, prodigyClean);
    assert.equal(results[0].bytes, flac.length);
    assert.equal(sandbox.manifest['spotify:prodigy'].savePath, prodigyClean);

    assert.equal(results[1].done, true, 'matches multi-artist / featured track against subfolder file');
    assert.equal(results[1].savePath, grimesFile);
    assert.equal(results[2].done, false, 'does not match missing song');

    // Controller.addProfile upgrades an existing skipped track when re-imported as downloaded
    let workerRuns = 0;
    const c = new Controller({
      services: ['qobuz'],
      getWorker: () => ({ run: async () => { workerRuns++; return { outcome: 'no-match' }; } }),
      checkExisting: async (item) => item.key === 'spotify:prodigy'
        ? { done: true, file: path.basename(prodigyClean), savePath: prodigyClean, bytes: flac.length, via: 'scan' }
        : { done: false },
    });
    c.pause();
    c.addProfile({ id: 'nihil', folderName: 'Nihil' }, [{ id: 'pl1', name: 'Casual', trackKeys: ['spotify:grimes'] }], {
      'spotify:grimes': { title: 'Welcome To The Opera', artist: 'Anyma, Grimes', status: 'skipped' },
    });
    assert.equal(c.getItem('spotify:grimes').status, 'skipped');
    c.addProfile({ id: 'nihil', folderName: 'Nihil' }, [{ id: 'pl1', name: 'Casual', trackKeys: ['spotify:grimes'] }], {
      'spotify:grimes': {
        title: 'Welcome To The Opera', artist: 'Anyma, Grimes', status: 'downloaded',
        file: path.basename(grimesFile), savePath: grimesFile, bytes: flac.length,
      },
    });
    assert.equal(c.getItem('spotify:grimes').status, 'completed');
    assert.equal(c.getItem('spotify:grimes').savePath, grimesFile);

    // Controller._runChain checks checkExisting before running a worker
    c.add({ id: 'loose-prodigy', key: 'spotify:prodigy', title: 'Smack My Bitch Up', artist: 'The Prodigy' });
    c.resume();
    await drain();
    assert.equal(c.getItem('loose-prodigy').status, 'completed');
    assert.equal(c.getItem('loose-prodigy').savePath, prodigyClean);
    assert.equal(workerRuns, 0, 'worker never runs for a track already found on disk');
    c.dispose();
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
