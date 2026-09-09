import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/engine/controller.mjs';
import { attachPersistence } from '../src/engine/renderer-integration.mjs';

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
