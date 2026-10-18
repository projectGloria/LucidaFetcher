import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Controller } from '../src/engine/controller.mjs';
import { attachPersistence } from '../src/engine/renderer-integration.mjs';

const soundsSource = await fs.readFile(new URL('../src/ui/sounds.js', import.meta.url), 'utf8');
const mainSource = (await fs.readFile(new URL('../main.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const settle = async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); };
function sounds(AudioContext) {
  const scope = { window: { AudioContext } };
  vm.runInNewContext(soundsSource.replace(/export /g, '') + '\nthis.api = { configureSounds, play };', scope);
  return scope.api;
}

test('sound device creation and asynchronous resume failures are contained', async () => {
  for (const AudioContext of [undefined,
    class { constructor() { throw new Error('no audio device'); } },
    class { state = 'suspended'; resume() { return Promise.reject(new Error('device disconnected')); } close() { throw new Error('closed'); } },
  ]) {
    const api = sounds(AudioContext);
    api.configureSounds({ enabled: true });
    assert.doesNotThrow(() => api.play('complete'));
    await settle();
    assert.doesNotThrow(() => api.configureSounds({ enabled: false }));
    await settle();
  }
});

test('sound bursts are bounded, nodes are disconnected, mute is silent and disabling releases the device', async () => {
  const devices = [], oscillators = [], gains = [], peaks = [];
  class AudioContext {
    state = 'running'; currentTime = 0; destination = {};
    constructor() { devices.push(this); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createOscillator() {
      const node = { frequency: {}, connect: target => target, start() {}, stop() {}, disconnect() { this.disconnected = true; } };
      oscillators.push(node); return node;
    }
    createGain() {
      const node = { connect() {}, disconnect() { this.disconnected = true; }, gain: {
        setValueAtTime() {}, exponentialRampToValueAtTime(value) { peaks.push(value); },
      } };
      gains.push(node); return node;
    }
  }
  const api = sounds(AudioContext);
  api.configureSounds({ enabled: true, volume: 0 }); api.play('complete'); await settle();
  assert.equal(devices.length, 0);
  api.configureSounds({ volume: Infinity });
  for (let n = 0; n < 100; n++) api.play('finished');
  await settle();
  assert.equal(oscillators.length, 12);
  assert.ok(peaks.every(Number.isFinite));
  oscillators[0].onended();
  assert.ok(oscillators[0].disconnected && gains[0].disconnected);
  api.configureSounds({ enabled: false }); await settle();
  assert.ok(oscillators.every(node => node.disconnected));
  assert.ok(gains.every(node => node.disconnected));
  assert.equal(devices[0].state, 'closed');
  api.configureSounds({ enabled: true, volume: 1 }); api.play('complete'); await settle();
  assert.equal(devices.length, 2);
  api.configureSounds({ enabled: false });
});

test('removing an entire profile removes hidden playlists and persists once while preserving shared tracks', () => {
  const c = new Controller(); c.pause();
  const track = title => ({ title, artist: 'Fixture', status: 'downloaded' });
  c.addProfile({ id: 'a' }, [
    { id: 'visible', name: 'Visible', trackKeys: ['missing'] },
    { id: 'hidden', name: 'Hidden', trackKeys: ['done', 'shared'] },
  ], { missing: { ...track('Missing'), status: 'skipped' }, done: track('Done'), shared: track('Shared') });
  c.addProfile({ id: 'b' }, [{ id: 'other', name: 'Other', trackKeys: ['shared'] }], {});
  const sent = [];
  const off = attachPersistence(c, { send: (...args) => sent.push(args) });
  let emits = 0; c.subscribe(() => emits++);
  assert.equal(c.removeProfile('a'), 3);
  assert.equal(emits, 1);
  assert.deepEqual([...c.playlists.keys()], ['other']);
  assert.deepEqual([...c.tracks.keys()], ['shared']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'queue-save');
  assert.equal(sent[0][2], true);
  assert.equal(sent[0][1].playlists.length, 1);
  off(); c.dispose();
});

test('all loose import paths retain provider identity, artwork and duration', async () => {
  const source = await fs.readFile(new URL('../src/ui/views/AddView.jsx', import.meta.url), 'utf8');
  const { buildSearchQuery, buildSearchVariants } = await import('../src/engine/variants.mjs');
  const scope = { buildSearchQuery, buildSearchVariants };
  vm.runInNewContext('let seq = 0;\n' + source.slice(source.indexOf('function toQueueItem('), source.indexOf('function formatDuration(')), scope);
  const item = scope.toQueueItem({ title: 'Song', artist: 'Artist', service: 'spotify', trackId: 'track',
    isrc: 'ISRC123', durationSec: 123, artworkPending: true });
  assert.equal(item.service, 'spotify'); assert.equal(item.trackId, 'track');
  assert.equal(item.isrc, 'ISRC123'); assert.equal(item.durationSec, 123); assert.equal(item.artworkPending, true);
});

test('resume records retain ISRC and duration for final recording validation', () => {
  let saved = 0;
  const scope = { transfers: {}, saveTransfers() { saved++; } };
  vm.runInNewContext(mainSource.slice(mainSource.indexOf('function rememberTransfer('), mainSource.indexOf('function forgetTransfer(')), scope);
  const item = Object.fromEntries(['getFilename', 'getURLChain', 'getMimeType', 'getETag', 'getLastModifiedTime', 'getStartTime', 'getTotalBytes', 'getReceivedBytes'].map(name => [name, () => 1]));
  scope.rememberTransfer(item, { itemId: 'song', durationSec: 123, isrc: 'ISRC123' }, 'song.flac');
  assert.equal(saved, 1);
  assert.equal(scope.transfers.song.ctx.durationSec, 123);
  assert.equal(scope.transfers.song.ctx.isrc, 'ISRC123');
});

test('startup cleanup keeps resumable and new partials while asynchronously removing old orphans', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lucida-cleanup-'));
  try {
    await fs.mkdir(path.join(root, 'nested'));
    for (const name of ['resume.part', 'new.crdownload', 'nested/orphan.part', 'music.flac']) await fs.writeFile(path.join(root, name), 'data');
    for (const name of ['resume.part', 'nested/orphan.part']) await fs.utimes(path.join(root, name), new Date(0), new Date(0));
    const scope = { fs: { promises: fs }, path, quitting: false, SESSION_START: Date.now() - 1000,
      transfers: { song: { savePath: path.join(root, 'resume.part') } }, liveSavePaths: new Map(),
      savePathKey: file => path.resolve(file).toLowerCase(), logEvent() {},
    };
    vm.runInNewContext(mainSource.slice(mainSource.indexOf('async function cleanLeftoverPartFiles('), mainSource.indexOf('/**\n * Drop manifest entries')), scope);
    await scope.cleanLeftoverPartFiles(root);
    await fs.access(path.join(root, 'resume.part')); await fs.access(path.join(root, 'new.crdownload')); await fs.access(path.join(root, 'music.flac'));
    await assert.rejects(fs.access(path.join(root, 'nested/orphan.part')), { code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('suspended audio shares one resume and discards queued cues when disabled', async () => {
  const devices = [];
  let resumes = 0, notes = 0;
  class AudioContext {
    state = 'suspended'; currentTime = 0; destination = {};
    constructor() { devices.push(this); }
    resume() { resumes++; return new Promise(resolve => { this.finish = () => { this.state = 'running'; resolve(); }; }); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createOscillator() { notes++; return { frequency: {}, connect: target => target, start() {}, stop() {}, disconnect() {} }; }
    createGain() { return { connect() {}, disconnect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
  }
  const api = sounds(AudioContext);
  api.configureSounds({ enabled: true });
  for (let n = 0; n < 1000; n++) api.play('finished');
  await settle();
  assert.equal(resumes, 1, 'a stalled device must not receive a resume per result');
  devices[0].finish(); await settle();
  assert.equal(notes, 12, 'a result burst must reserve at most twelve pending notes');
  api.configureSounds({ enabled: false });
  api.configureSounds({ enabled: true });
  for (let n = 0; n < 1000; n++) api.play('finished');
  await settle();
  api.configureSounds({ enabled: false });
  api.configureSounds({ enabled: true }); api.play('complete');
  await settle();
  assert.equal(resumes, 3, 'stalled old cues must not block a replacement device');
  devices[1].finish(); devices[2].finish();
  await settle();
  assert.equal(notes, 14, 'old queued sounds must not play after re-enabling');
  api.configureSounds({ enabled: false });
});

test('audio node setup failure disconnects the oscillator and releases its reservation', async () => {
  const oscillators = [];
  class AudioContext {
    state = 'running';
    close() { return Promise.resolve(); }
    createOscillator() {
      const node = { stop() {}, disconnect() { this.disconnected = true; } };
      oscillators.push(node); return node;
    }
    createGain() { throw new Error('device lost during node creation'); }
  }
  const api = sounds(AudioContext);
  api.configureSounds({ enabled: true });
  for (let n = 0; n < 20; n++) { api.play('complete'); await settle(); }
  assert.equal(oscillators.length, 20, 'failed cues must release their note slots');
  assert.ok(oscillators.every(node => node.disconnected));
  api.configureSounds({ enabled: false });
});

test('link preview rejects plain text and incomplete results before they reach React', async () => {
  const source = await fs.readFile(new URL('../src/ui/views/AddView.jsx', import.meta.url), 'utf8');
  const { createSources } = await import('../src/engine/sources.mjs');
  const scope = {};
  vm.runInNewContext(source.slice(source.indexOf('function previewError('), source.indexOf('async function withoutExisting(')), scope);
  const text = await createSources().resolve('Artist - Song');
  assert.match(scope.previewError(text), /Paste a Spotify or Deezer/);
  for (const result of [null, {}, { results: [] }, { group: {}, results: [] }]) assert.ok(scope.previewError(result));
  assert.match(scope.previewError({ kind: 'profile' }), /profile tab/);
  assert.equal(scope.previewError({ error: 'Provider unavailable' }), 'Provider unavailable');
  assert.equal(scope.previewError({ group: {}, results: [{ texts: ['Song', 'Artist'] }] }), null);
});

test('slow profile output coalesces pending snapshots and retains the latest after a failed pass', async () => {
  for (const failFirst of [false, true]) {
    const calls = [], writes = [], errors = [];
    let handler, release;
    const scope = {
      Map, structuredClone, path,
      savePathKey: file => path.resolve(file).toLowerCase(), folderFor: folder => path.resolve(folder),
      ipcMain: { on: (_channel, fn) => { handler = fn; } },
      logEvent: (name, data) => { if (name.endsWith('.failed')) errors.push(data.message); },
      queueStateWrite: (_file, run) => { writes.push(run()); },
      getLibraryEngine: async () => ({ syncProfileLibrary: async (_dir, state) => {
        calls.push(state.revision);
        if (calls.length === 1) await new Promise((resolve, reject) => { release = () => failFirst ? reject(new Error('disk busy')) : resolve(); });
      } }),
      liveSavePaths: new Map(),
    };
    vm.runInNewContext(mainSource.slice(mainSource.indexOf('const pendingProfileSyncs ='), mainSource.indexOf('// Diagnostics export')), scope);
    handler(null, { folderName: 'Profile', state: { revision: 0, playlists: [] } });
    await settle();
    for (let revision = 1; revision <= 100; revision++) handler(null, { folderName: 'Profile', state: { revision, playlists: [] } });
    assert.equal(writes.length, 1, 'quit must wait on one registered task for this destination');
    release(); await Promise.all(writes);
    assert.deepEqual(calls, [0, 100], 'intermediate snapshots must not repeat filesystem passes');
    assert.deepEqual(errors, failFirst ? ['disk busy'] : []);
    handler(null, { folderName: 'Profile', state: { revision: 101, playlists: [] } });
    await Promise.all(writes);
    assert.deepEqual(calls, [0, 100, 101], 'a finished pass must release its destination');
  }
});

test('an unexpected profile queue failure clears the busy state and reports the error', async () => {
  const source = await fs.readFile(new URL('../src/ui/views/AddView.jsx', import.meta.url), 'utf8');
  const { mapPool, joinFolder, sortPlaylists } = await import('../src/engine/sources.mjs');
  const { trackKey } = await import('../src/engine/trackKey.mjs');
  const { assignPlaylistFiles } = await import('../src/engine/profile-paths.mjs');
  const busyStates = [], toasts = [];
  const scope = {
    profile: { info: { name: 'Fixture' }, playlists: [{ id: 'p', name: 'Mix' }] }, busy: null,
    order: 'default', isElectron: false, mapPool, joinFolder, sortPlaylists, trackKey, assignPlaylistFiles,
    profileMeta: () => ({ id: 'fixture', folderName: 'Fixture' }),
    readOne: async () => ({ name: 'Mix', group: { id: 'p' }, results: [{ texts: ['Song', 'Artist'] }] }),
    setBusy: value => busyStates.push(value), onToast: (...args) => toasts.push(args),
    getController() { throw new Error('Queue unavailable'); },
  };
  vm.runInNewContext(source.slice(source.indexOf('  const downloadProfile ='), source.indexOf('  const queuePlaylist =')) + '\nthis.downloadProfile = downloadProfile;', scope);
  await scope.downloadProfile();
  assert.equal(busyStates.at(-1), null);
  assert.deepEqual(toasts, [['Queue unavailable', 'err']]);
});

test('overlapping app mounts wait for the same saved-queue restoration', async () => {
  const source = await fs.readFile(new URL('../src/ui/engine.js', import.meta.url), 'utf8');
  let finishRestore, boots = 0;
  const controller = { restore: () => new Promise(resolve => { finishRestore = resolve; }) };
  const scope = {
    window: { require: () => ({ ipcRenderer: {} }) }, document: { getElementById() {} }, console,
    startEngine: () => { boots++; return controller; }, sources: {}, refreshSpotifyArtwork: async () => {},
  };
  vm.runInNewContext(source.slice(source.indexOf('export const isElectron'), source.indexOf('// Drives #scraper-view')).replace(/export /g, '') + '\nthis.api = { initEngine, whenReady };', scope);
  const ready = [];
  const first = scope.api.initEngine({ config: {} }); first.then(() => ready.push('first'));
  const second = scope.api.initEngine({ config: {} }); second.then(() => ready.push('second'));
  assert.equal(first, second);
  assert.equal(scope.api.whenReady(), first);
  await settle();
  assert.equal(boots, 1); assert.deepEqual(ready, []);
  finishRestore();
  assert.equal(await first, controller); assert.equal(await second, controller);
  assert.deepEqual(ready, ['first', 'second']);
});
