import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/engine/controller.mjs';
import { attachPersistence } from '../src/engine/renderer-integration.mjs';
import { displayedService } from '../src/engine/source-display.mjs';

test('restored downloads keep metadata separate from the actual audio provider', async () => {
  for (const verifiedService of ['amazon', null]) {
    const c = new Controller();
    const snap = { v: 4, paused: true, items: [],
      profiles: [{ id: 'p', name: 'Profile', folderName: 'Profile' }],
      playlists: [{ id: 'pl', profileId: 'p', name: 'Mix', trackKeys: ['song'] }],
      tracks: [{ id: 'song', key: 'song', title: 'Song', artist: 'Artist', service: 'spotify',
        transferService: 'qobuz', status: 'completed', savePath: '/fixture/song.flac', bytes: 100 }],
    };
    const off = attachPersistence(c, { send() {}, invoke: async name => {
      if (name === 'queue-load') return snap;
      if (name === 'downloads-check') return [{ done: true, file: 'song.flac', savePath: '/fixture/song.flac', bytes: 100, service: verifiedService }];
      return [];
    } });
    try {
      await c.restore();
      const rec = c.getItem('song');
      assert.equal(rec.status, 'completed');
      assert.equal(rec.item.service, 'spotify');
      assert.equal(displayedService(rec), verifiedService || 'qobuz');
      assert.equal(displayedService(c.getPlaylistItems('pl')[0]), verifiedService || 'qobuz');
    } finally { off(); c.dispose(); }
  }
});

test('restores a paused queue without starting it and keeps missing tracks visible', async () => {
  let runs = 0;
  const c = new Controller({ getWorker: () => ({ run: async () => { runs++; return { outcome: 'completed' }; } }) });
  const snap = { paused: true, items: [
    { id: 'queued', title: 'Song', artist: 'Artist' },
    { id: 'missing', title: 'Other', skippedInEarlierRun: true, statusText: 'No matching upload', tried: [{ service: 'soundcloud', outcome: 'no-match' }] },
  ] };
  attachPersistence(c, { send() {}, invoke: async name => name === 'queue-load' ? snap : [] });
  const result = await c.restore();
  assert.equal(runs, 0);
  assert.equal(c.paused, true);
  assert.equal(result.staySkipped, 1);
  assert.equal(c.getItem('missing').status, 'skipped');
  assert.equal(c.getItem('missing').statusText, 'No matching upload');
  c.remove(['queued', 'missing']);
});

test('playlist removal immediately saves remaining work or clears the queue', () => {
  const messages = [];
  const c = new Controller({ getWorker() { throw new Error('Must remain paused'); } });
  c.pause();
  attachPersistence(c, { send: (...args) => messages.push(args) });
  c.add([{ id: 'a', title: 'A', groupId: 'one' }, { id: 'b', title: 'B', groupId: 'two' }]);
  c.removeGroup('one');
  assert.equal(messages[0][0], 'queue-save');
  assert.equal(messages[0][2], true);
  assert.deepEqual(messages[0][1].items.map(i => i.id), ['b']);
  c.removeGroup('two');
  assert.equal(messages[1][0], 'queue-clear');
});
