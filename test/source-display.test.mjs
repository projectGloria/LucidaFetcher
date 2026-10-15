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

