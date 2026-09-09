import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from '../src/engine/pool.mjs';

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));
const items = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i}` }));

test('never runs more than the configured concurrency', async () => {
  let live = 0, peak = 0;
  const pool = new Pool({
    concurrency: 3,
    run: async () => { live++; peak = Math.max(peak, live); await tick(5); live--; },
  });
  pool.submit(items(12));
  await pool.onIdle();
  assert.equal(peak, 3);
});

test('gives each concurrent task its own slot', async () => {
  const held = new Set();
  const clashes = [];
  const pool = new Pool({
    concurrency: 3,
    run: async (item, slot) => {
      if (held.has(slot)) clashes.push(slot);
      held.add(slot);
      await tick(5);
      held.delete(slot);
    },
  });
  pool.submit(items(9));
  await pool.onIdle();
  // Slots map to worker webviews; two tracks sharing one would drive the same
  // page at once and interleave their scrapes.
  assert.deepEqual(clashes, []);
});

test('a rejecting task returns its slot', async () => {
  // Losing a slot per failure would wedge the queue with work still in it -
  // a hang rather than a visible error.
  const done = [];
  const pool = new Pool({
    concurrency: 2,
    run: async (item) => { await tick(2); if (item.id === 't0') throw new Error('boom'); done.push(item.id); },
  });
  pool.submit(items(6));
  await pool.onIdle();
  assert.equal(done.length, 5);
  assert.equal(pool.activeCount, 0);
});

test('pause stops new work but lets running work finish', async () => {
  const started = [];
  const pool = new Pool({
    concurrency: 2,
    run: async (item) => { started.push(item.id); await tick(10); },
  });
  pool.submit(items(8));
  await tick(1);
  pool.pause();
  const atPause = started.length;
  await tick(30);
  assert.equal(started.length, atPause, 'nothing new may start while paused');
  pool.resume();
  await pool.onIdle();
  assert.equal(started.length, 8);
});

test('raising concurrency puts the new slots to work immediately', async () => {
  let live = 0, peak = 0;
  const pool = new Pool({
    concurrency: 1,
    run: async () => { live++; peak = Math.max(peak, live); await tick(10); live--; },
  });
  pool.submit(items(10));
  await tick(2);
  assert.equal(peak, 1);
  pool.setConcurrency(4);
  await pool.onIdle();
  assert.equal(peak, 4);
});

test('lowering concurrency retires slots without killing running work', async () => {
  const finished = [];
  const pool = new Pool({
    concurrency: 4,
    run: async (item) => { await tick(10); finished.push(item.id); },
  });
  pool.submit(items(8));
  await tick(2);
  pool.setConcurrency(1);
  await pool.onIdle();
  assert.equal(finished.length, 8, 'in-flight downloads must not be dropped');
});

test('cancel drops a queued item and aborts a running one', async () => {
  const ran = [];
  let aborted = false;
  const pool = new Pool({
    concurrency: 1,
    run: async (item, slot, signal) => {
      ran.push(item.id);
      signal.addEventListener('abort', () => { aborted = true; });
      await tick(10);
    },
  });
  pool.submit(items(3));
  await tick(2);
  assert.equal(pool.cancel('t2'), true, 'queued item is cancellable');
  pool.cancel('t0');
  await pool.onIdle();
  assert.ok(aborted, 'running item receives the abort signal');
  assert.ok(!ran.includes('t2'), 'cancelled item never starts');
});

test('requeueFront runs before anything already waiting', async () => {
  const order = [];
  const pool = new Pool({
    concurrency: 1,
    run: async (item) => { order.push(item.id); await tick(2); },
  });
  pool.submit(items(3));
  await tick(1);
  pool.requeueFront({ id: 'retry' });
  await pool.onIdle();
  // A track continuing down its fallback chain should not queue behind every
  // track that has not been looked at yet.
  assert.ok(order.indexOf('retry') < order.indexOf('t2'));
});

test('onIdle resolves immediately when there is nothing to do', async () => {
  const pool = new Pool({ concurrency: 2, run: async () => {} });
  await pool.onIdle();
});
