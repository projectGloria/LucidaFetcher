import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayedService } from '../src/engine/source-display.mjs';

test('shows only the active provider despite earlier failed attempts', () => {
  const rec = { step: { service: 'soundcloud' }, tried: [{ service: 'qobuz' }, { service: 'amazon' }] };
  for (const status of ['searching', 'downloading', 'ready']) {
    assert.equal(displayedService({ ...rec, status }), 'soundcloud');
  }
  assert.equal(displayedService({ ...rec, status: 'completed', result: { step: { service: 'youtube' } } }), 'youtube');
  assert.equal(displayedService({ status: 'completed', transferService: 'qobuz' }), 'qobuz');
  assert.equal(displayedService({ status: 'ready', transferService: 'tidal' }), 'tidal');
  for (const status of ['queued', 'cancelled', 'skipped']) assert.equal(displayedService({ ...rec, status }), null);
});

test('metadata never identifies the audio download provider', () => {
  const item = { service: 'spotify' };
  assert.equal(displayedService({ status: 'completed', item }), null);
  assert.equal(displayedService({ status: 'completed', item, transferService: 'spotify' }), null);
  assert.equal(displayedService({ status: 'completed', item, transferService: 'qobuz' }), 'qobuz');
  assert.equal(displayedService({ status: 'completed', item, result: { service: 'amazon' } }), 'amazon');
  assert.equal(displayedService({ status: 'completed', item, tried: [
    { service: 'qobuz', outcome: 'completed' }, { service: 'tidal', outcome: 'no-match' },
  ] }), 'qobuz');
  for (const status of ['ready', 'downloading']) {
    assert.equal(displayedService({ status, item }), null);
    assert.equal(displayedService({ status, item, transferService: 'spotify', step: { service: 'deezer' } }), 'deezer');
  }
});

