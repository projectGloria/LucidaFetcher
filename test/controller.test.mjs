import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller, COMPLETED, SKIPPED, CANCELLED, READY, DOWNLOADING } from '../src/engine/controller.mjs';

const track = (id, over = {}) => ({ id, name: `n${id}`, title: 'Fetish', artist: 'Obzkure', ...over });

// `answers` maps service -> outcome, or is a function of (item, step).
function makeController(answers, opts = {}) {
  const seen = [];
  const worker = {
    async run(item, step) {
      seen.push(`${item.id}:${step.service}:${step.variantIndex}`);
      const a = typeof answers === 'function' ? answers(item, step) : answers[step.service];
      return a || { outcome: 'no-results' };
    },
  };
  const c = new Controller({
    getWorker: () => worker,
    services: ['qobuz', 'amazon'],
    concurrency: opts.concurrency || 1,
    planOptions: opts.planOptions,
  });
  return { c, seen };
}

test('stops at the first source that delivers', async () => {
  const { c, seen } = makeController({ qobuz: { outcome: 'completed' } });
  c.add(track('a'));
  await c.pool.onIdle();
  assert.equal(c.getItem('a').status, COMPLETED);
  assert.deepEqual(seen, ['a:qobuz:0']);
});

test('exhausts selected stores without unselected fallbacks', async () => {
  const { c, seen } = makeController({ youtube: { outcome: 'completed' } });
  c.add(track('a'));
  await c.pool.onIdle();
  assert.equal(c.getItem('a').status, SKIPPED);
  assert.deepEqual(seen, ['a:qobuz:0', 'a:qobuz:1', 'a:amazon:0', 'a:amazon:1']);
});
test('a store that cannot supply the audio loses its remaining wordings', async () => {
  const { c, seen } = makeController((item, step) =>
    step.service === 'qobuz' ? { outcome: 'provider-failed' } : { outcome: 'no-results' });
  c.add(track('a'));
  await c.pool.onIdle();
  assert.ok(!seen.includes('a:qobuz:1'), 'rewording will not conjure the audio');
  assert.ok(seen.includes('a:amazon:0'));
});

test('explains a skip in terms of what was tried', async () => {
  const { c } = makeController({});
  c.add(track('a'));
  await c.pool.onIdle();
  const rec = c.getItem('a');
  assert.equal(rec.status, SKIPPED);
  // Not "Skipped" - it must say which sources were asked.
  assert.match(rec.statusText, /Not found on any of \d+ sources/);
  assert.match(rec.statusText, /Qobuz/);
});

test('distinguishes "nobody has it" from "found it but could not serve it"', async () => {
  const { c } = makeController((item, step) =>
    step.service === 'amazon' ? { outcome: 'provider-failed', message: 'no audio stream' } : { outcome: 'no-results' });
  c.add(track('a'));
  await c.pool.onIdle();
  // The final reason must name the source that HAD the track, so the user can
  // tell "nobody stocks this" from "it exists but the backend was broken".
  assert.match(c.getItem('a').statusText, /Found on Amazon Music but no source could supply the audio/);
});

test('reports which source is being asked, not just "fetching"', async () => {
  const texts = [];
  const { c } = makeController((item, step) => {
    texts.push(c.getItem('a').statusText);
    return step.service === 'amazon' ? { outcome: 'completed' } : { outcome: 'no-results' };
  });
  c.add(track('a'));
  await c.pool.onIdle();
  assert.ok(texts.some((t) => /Searching Qobuz via Lucida/.test(t)), texts.join(' | '));
  assert.ok(texts.some((t) => /wording 2 of 2/.test(t)), texts.join(' | '));
});

test('runs several tracks at the configured concurrency', async () => {
  let live = 0, peak = 0;
  const worker = {
    async run() {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return { outcome: 'completed' };
    },
  };
  const c = new Controller({ getWorker: () => worker, services: ['qobuz'], concurrency: 3 });
  c.add([track('a'), track('b'), track('c'), track('d'), track('e')]);
  await c.pool.onIdle();
  assert.equal(peak, 3);
  assert.equal(c.stats.completed, 5);
});

test('never queues the same track twice', async () => {
  const { c } = makeController({ qobuz: { outcome: 'completed' } });
  assert.equal(c.add(track('a')), 1);
  assert.equal(c.add(track('a')), 0);
  await c.pool.onIdle();
  assert.equal(c.stats.total, 1);
});

test('a playlist listing the same song twice downloads it once', async () => {
  const { c, seen } = makeController({ qobuz: { outcome: 'completed' } });
  const key = '|fetish|obzkure';
  // Two entries, two ids, one identity - which is exactly what a playlist with
  // a repeated track looks like coming out of an import.
  assert.equal(c.add([track('a', { key }), track('b', { key })]), 1);
  assert.deepEqual(c.lastAdd, { added: 1, duplicates: 1 });
  await c.pool.onIdle();
  assert.equal(c.stats.total, 1);
  assert.deepEqual(seen, ['a:qobuz:0']);
});

test('removing a track frees its identity for a later add', async () => {
  const { c } = makeController({ qobuz: { outcome: 'completed' } });
  const key = '|fetish|obzkure';
  c.add(track('a', { key }));
  await c.pool.onIdle();
  assert.equal(c.remove('a'), 1);
  assert.equal(c.add(track('b', { key })), 1);
});

test('tracks with no key are never collapsed into each other', async () => {
  const { c } = makeController({ qobuz: { outcome: 'completed' } });
  assert.equal(c.add([track('a'), track('b')]), 2);
});

test('does not add the original store unless enabled', async () => {
  const { c, seen } = makeController({ tidal: { outcome: 'completed' } });
  c.add(track('a', { originalService: 'tidal' }));
  await c.pool.onIdle();
  assert.ok(seen.every(s => !s.includes(':tidal:')));
  assert.equal(c.getItem('a').status, SKIPPED);
});

test('settings changes exclude a disabled source from an existing plan', async () => {
  const { c, seen } = makeController(() => { c.services = ['qobuz']; return { outcome: 'no-results' }; });
  c.add(track('a'));
  await c.pool.onIdle();
  assert.ok(seen.every(s => s.includes(':qobuz:')));
});

test('an empty selection never runs a worker even with an original or media source', async () => {
  const { c, seen } = makeController({});
  c.services = [];
  c.add(track('a', { originalService: 'tidal', mediaUrl: 'https://soundcloud.com/a/b' }));
  await c.pool.onIdle();
  assert.deepEqual(seen, []);
});
test('does not ask the same store twice when it is also in the chain', async () => {
  const { c, seen } = makeController({});
  c.add(track('a', { originalService: 'qobuz' }));
  await c.pool.onIdle();
  assert.equal(seen.filter((s) => s.includes(':qobuz:0')).length, 1);
});

test('skips a source that is known to be down', async () => {
  const { c, seen } = makeController({ amazon: { outcome: 'completed' } });
  c.markServiceUnhealthy('qobuz');
  c.add(track('a'));
  await c.pool.onIdle();
  assert.ok(!seen.some((s) => s.includes('qobuz')));
});

test('cancelling a queued track stops it ever running', async () => {
  const { c, seen } = makeController(async () => {
    await new Promise((r) => setTimeout(r, 10));
    return { outcome: 'completed' };
  });
  c.add([track('a'), track('b')]);
  c.cancel('b');
  await c.pool.onIdle();
  assert.equal(c.getItem('b').status, CANCELLED);
  assert.ok(!seen.some((s) => s.startsWith('b:')));
});

test('retrySkipped gives every skipped track one more full pass', async () => {
  let phase = 0;
  const worker = { async run() { return phase === 0 ? { outcome: 'no-results' } : { outcome: 'completed' }; } };
  const c = new Controller({ getWorker: () => worker, services: ['qobuz'] });
  c.add(track('a'));
  await c.pool.onIdle();
  assert.equal(c.getItem('a').status, SKIPPED);

  phase = 1;
  assert.equal(c.retrySkipped(), 1);
  await c.pool.onIdle();
  assert.equal(c.getItem('a').status, COMPLETED);
  assert.equal(c.retrySkipped(), 0, 'only one extra pass, not a loop');
});

test('a worker that throws still reaches a terminal state', async () => {
  // Otherwise the track sits at "searching" forever and the queue never drains.
  const worker = { async run() { throw new Error('webview died'); } };
  const c = new Controller({ getWorker: () => worker, services: ['qobuz'], planOptions: { youtube: false, monochrome: false } });
  c.add(track('a'));
  await c.pool.onIdle();
  assert.equal(c.getItem('a').status, SKIPPED);
});

test('reports transfer state pushed in from the main process', async () => {
  // The chain loop cannot report these: between the click and the finished file
  // it is only awaiting a promise. Without this wiring the row stays on
  // "Working" with no progress bar for the whole transfer.
  const worker = { async run() { await new Promise((r) => setTimeout(r, 30)); return { outcome: 'completed' }; } };
  const c = new Controller({ getWorker: () => worker, services: ['qobuz'] });
  c.add(track('a'));
  await new Promise((r) => setTimeout(r, 5));

  // A started transfer is READY, not DOWNLOADING: the file has been handed to
  // the main process and nothing has moved yet.
  c.noteDownloadStarted('a', 'qobuz');
  assert.equal(c.getItem('a').status, READY);
  assert.match(c.getItem('a').statusText, /waiting to download from Qobuz/);

  // Chromium announcing a transfer it has not begun must not promote it - that
  // is what would put every parked file back under "Downloading".
  c.noteProgress('a', 0, 200);
  assert.equal(c.getItem('a').status, READY, 'zero bytes is not downloading');

  c.noteProgress('a', 50, 200);
  assert.equal(c.getItem('a').status, DOWNLOADING, 'the first byte promotes it');
  assert.match(c.getItem('a').statusText, /Downloading from Qobuz/);
  assert.equal(c.getItem('a').progress, 0.25);

  // A stream with no declared length must give an indeterminate bar, not a fake
  // one stuck near the end.
  c.noteProgress('a', 50, 0);
  assert.equal(c.getItem('a').progress, null);

  await c.pool.onIdle();
  assert.equal(c.getItem('a').status, COMPLETED);
});

test('ignores transfer events for a track that already finished', async () => {
  const { c } = makeController({ qobuz: { outcome: 'completed' } });
  c.add(track('a'));
  await c.pool.onIdle();
  c.noteProgress('a', 1, 2);
  assert.equal(c.getItem('a').status, COMPLETED, 'a late event must not revive it');
});

test('notifies subscribers as state changes', async () => {
  const { c } = makeController({ qobuz: { outcome: 'completed' } });
  let calls = 0;
  c.subscribe(() => calls++);
  c.add(track('a'));
  await c.pool.onIdle();
  assert.ok(calls > 1);
  assert.ok(c.getSnapshot() > 0);
});
test('removing a playlist cancels active and queued tracks and keeps other groups', async () => {
  let started;
  const ready = new Promise(r => { started = r; });
  let aborted = false;
  const c = new Controller({ concurrency: 1, services: ['qobuz'], getWorker: () => ({
    run(item, step, signal) {
      if (item.groupId !== 'remove') return Promise.resolve({ outcome: 'completed', step });
      started();
      return new Promise(resolve => signal.addEventListener('abort', () => {
        aborted = true; resolve({ outcome: 'completed', step });
      }, { once: true }));
    },
  }) });
  c.add([track('a', { groupId: 'remove' }), track('b', { groupId: 'remove' }), track('c', { groupId: 'keep' })]);
  await ready;
  assert.equal(c.removeGroup('remove'), 2);
  await c.pool.onIdle();
  assert.equal(aborted, true);
  assert.deepEqual(c.getItems().map(r => r.item.id), ['c']);
  assert.equal(c.getItem('c').status, COMPLETED);
});

// ---- the pipeline --------------------------------------------------------
//
// A scraped attempt ends when the transfer STARTS: the webview has done its job
// and the bytes are the main process's business. These cover the handoff, and
// above all what happens when a handed-off transfer then fails - the chain has
// already moved on by then, so re-entry is the part with teeth.

function pipelined(answers, opts = {}) {
  const transfers = new Map(); // item id -> resolve
  const seen = [];
  let live = 0, peak = 0;
  const worker = {
    async run(item, step) {
      seen.push(`${item.id}:${step.service}:${step.variantIndex}`);
      live++; peak = Math.max(peak, live);
      await Promise.resolve();
      live--;
      const a = typeof answers === 'function' ? answers(item, step) : answers[step.service];
      return a || { outcome: 'no-results' };
    },
  };
  const c = new Controller({
    getWorker: () => worker,
    services: ['qobuz', 'amazon'],
    concurrency: opts.concurrency || 1,
    maxTransfers: opts.maxTransfers == null ? 3 : opts.maxTransfers,
    awaitTransfer: (id) => new Promise((resolve) => transfers.set(id, resolve)),
    cancelTransfer: (id) => { const r = transfers.get(id); if (r) { transfers.delete(id); r(null); } },
  });
  return { c, transfers, seen, searching: () => live, peakSearching: () => peak };
}

const settle = () => new Promise((r) => setTimeout(r, 25));

test('any finished detached transfer frees a search slot without waiting for slower files', async () => {
  const { c, transfers, seen } = pipelined({ qobuz: { outcome: 'transferring' } }, { concurrency: 2, maxTransfers: 1 });
  c.add(['a', 'b', 'c', 'd'].map(id => track(id, { key: id })));
  await settle();
  assert.equal(seen.length, 3, 'one detached file and two occupied workers');
  transfers.get('a')({ status: 'completed', file: 'a.flac', bytes: 1 });
  await settle();
  assert.equal(seen.length, 4, 'search resumes while b and c are still downloading');
  assert.equal(c.transfers.size, 1, 'the configured detached-transfer cap is respected');
  for (const id of ['b', 'c', 'd']) transfers.get(id)({ status: 'completed', file: `${id}.flac`, bytes: 1 });
  await settle(); await c.pool.onIdle();
  assert.equal(c.stats.completed, 4); assert.equal(c._listeners.size, 0, 'capacity subscriptions are removed');
  c.dispose();
});

test('cancelling workers waiting for transfer capacity releases their listeners and slots', async () => {
  const { c } = pipelined({ qobuz: { outcome: 'transferring' } }, { concurrency: 2, maxTransfers: 1 });
  c.add(['a', 'b', 'c'].map(id => track(id, { key: id })));
  await settle();
  assert.ok(c._listeners.size > 0);
  c.cancelAll(); await c.pool.onIdle(); await settle();
  assert.equal(c.transfers.size, 0); assert.equal(c._listeners.size, 0);
  assert.ok(c.getItems().every(rec => rec.status === 'cancelled'));
  c.dispose();
});

test('a started transfer frees the slot for the next track', async () => {
  const { c, transfers, seen } = pipelined({ qobuz: { outcome: 'transferring' } }, { concurrency: 1 });
  c.add([track('a', { key: 'a' }), track('b', { key: 'b' })]);
  await settle();

  // One slot, and yet both tracks have been searched: the first is downloading
  // without holding the slot it searched in.
  assert.deepEqual(seen, ['a:qobuz:0', 'b:qobuz:0']);
  assert.equal(c.getItem('a').status, READY);
  assert.equal(c.transfers.size, 2);

  transfers.get('a')({ status: 'completed', savePath: 'p/a.flac', file: 'a.flac', bytes: 1 });
  transfers.get('b')({ status: 'completed', savePath: 'p/b.flac', file: 'b.flac', bytes: 1 });
  await settle();
  assert.equal(c.stats.completed, 2);
});

test('a transfer that fails re-enters the chain at the next source', async () => {
  const { c, transfers, seen } = pipelined((item, step) => (
    step.service === 'qobuz' && step.variantIndex === 0 ? { outcome: 'transferring' }
      : step.service === 'amazon' ? { outcome: 'completed' }
      : { outcome: 'no-results' }
  ));
  c.add(track('a', { key: 'a' }));
  await settle();
  assert.equal(c.getItem('a').status, READY);

  transfers.get('a')({ status: 'interrupted' });
  await settle();
  await c.pool.onIdle();

  // Not restarted from the top: qobuz was tried and is not tried again.
  assert.equal(c.getItem('a').status, COMPLETED);
  // The next VARIANT of the store it failed in comes before the next store,
  // exactly as it does when the chain waits for the file inline.
  assert.deepEqual(seen, ['a:qobuz:0', 'a:qobuz:1', 'a:amazon:0']);
  assert.equal(c.getItem('a').tried[0].outcome, 'download-failed');
});

test('a transfer that never lands still ends the track', async () => {
  const { c, transfers } = pipelined((item, step) => (
    step.variantIndex === 0 && step.service === 'qobuz'
      ? { outcome: 'transferring' } : { outcome: 'no-results' }
  ));
  c.add(track('a', { key: 'a' }));
  await settle();
  transfers.get('a')(null); // no file, ever
  await settle();
  await c.pool.onIdle();
  assert.equal(c.getItem('a').status, SKIPPED);
});

test('cancelling a detached transfer stops it and leaves no chain running', async () => {
  const { c, transfers } = pipelined({ qobuz: { outcome: 'transferring' } });
  c.add(track('a', { key: 'a' }));
  await settle();
  assert.equal(c.transfers.size, 1);

  c.cancel('a');
  await settle();
  assert.equal(c.getItem('a').status, CANCELLED);
  assert.equal(c.transfers.size, 0);
  assert.equal(transfers.has('a'), false, 'the main process must be told to stop');
});

test('removing a track mid-transfer drops it without resurrecting it', async () => {
  const { c, transfers } = pipelined({ qobuz: { outcome: 'transferring' } });
  c.add(track('a', { key: 'a' }));
  await settle();
  assert.equal(c.remove('a'), 1);
  const resolve = transfers.get('a');
  if (resolve) resolve({ status: 'interrupted' }); // arrives after the record is gone
  await settle();
  assert.equal(c.getItems().length, 0);
  assert.equal(c.stats.total, 0);
});

test('at the transfer cap a chain waits for its own file, holding the slot', async () => {
  const { c, transfers, seen } = pipelined(
    { qobuz: { outcome: 'transferring' } }, { concurrency: 1, maxTransfers: 1 });
  c.add([track('a', { key: 'a' }), track('b', { key: 'b' })]);
  await settle();

  // 'a' is detached; 'b' takes the freed slot and then hits the cap, so it holds
  // the slot until its own transfer finishes.
  assert.deepEqual(seen, ['a:qobuz:0', 'b:qobuz:0']);
  assert.equal(c.transfers.size, 1);

  transfers.get('a')({ status: 'completed', savePath: 'p/a.flac', file: 'a.flac', bytes: 1 });
  transfers.get('b')({ status: 'completed', savePath: 'p/b.flac', file: 'b.flac', bytes: 1 });
  await settle();
  assert.equal(c.stats.completed, 2);
});

test('with no transfer waiter the pipeline degrades to waiting inline', async () => {
  // maxTransfers 0 is the kill switch: behaviour identical to before the split.
  const { c, transfers } = pipelined({ qobuz: { outcome: 'transferring' } }, { maxTransfers: 0 });
  c.add(track('a', { key: 'a' }));
  await settle();
  assert.equal(c.transfers.size, 0, 'nothing detached');
  assert.equal(c.pool.activeCount, 1, 'the slot is still held');
  transfers.get('a')({ status: 'completed', savePath: 'p/a.flac', file: 'a.flac', bytes: 1 });
  await c.pool.onIdle();
  assert.equal(c.getItem('a').status, COMPLETED);
});

// ---- picking a transfer back up after a restart --------------------------

test('an adopted transfer completes without ever touching a worker', async () => {
  const { c, transfers, seen } = pipelined({ qobuz: { outcome: 'completed' } });
  const item = track('a', { key: 'a' });
  assert.equal(c.adoptTransfer(item, { received: 900, total: 1000 }), true);

  const rec = c.getItem('a');
  assert.equal(rec.status, DOWNLOADING);
  assert.equal(rec.progress, 0.9, 'the bar starts where the file actually is');
  assert.deepEqual(seen, [], 'nothing is searched for a file already coming down');

  transfers.get('a')({ status: 'completed', savePath: 'p/a.flac', file: 'a.flac', bytes: 1000 });
  await settle();
  assert.equal(c.getItem('a').status, COMPLETED);
});

test('a resume that dies falls back to the ordinary chain', async () => {
  const { c, transfers, seen } = pipelined({ qobuz: { outcome: 'completed' } });
  c.adoptTransfer(track('a', { key: 'a' }), { received: 10, total: 1000 });
  transfers.get('a')({ status: 'interrupted' });
  await settle();
  await c.pool.onIdle();
  assert.equal(c.getItem('a').status, COMPLETED);
  assert.deepEqual(seen, ['a:qobuz:0'], 'the track is fetched from the top of its chain');
});

test('a resume the main process cannot start is handed to the chain at once', async () => {
  const { c, seen } = pipelined({ qobuz: { outcome: 'completed' } });
  c.adoptTransfer(track('a', { key: 'a' }), { received: 10, total: 1000 });
  assert.equal(c.failTransfer('a', 'resume-unavailable'), true);
  assert.equal(c.transfers.size, 0);
  await c.pool.onIdle();
  assert.equal(c.getItem('a').status, COMPLETED);
  assert.deepEqual(seen, ['a:qobuz:0']);
});

test('a late result cannot revive a track that was already given up on', async () => {
  const { c, transfers } = pipelined({ qobuz: { outcome: 'completed' } });
  c.adoptTransfer(track('a', { key: 'a' }), { received: 10, total: 1000 });
  c.failTransfer('a', 'resume-unavailable');
  await c.pool.onIdle();
  assert.equal(c.getItem('a').status, COMPLETED);

  // The abandoned wait settles long afterwards; it must change nothing.
  transfers.get('a')({ status: 'interrupted' });
  await settle();
  assert.equal(c.getItem('a').status, COMPLETED);
});

test('an adopted track is still deduplicated against the queue', async () => {
  const { c } = pipelined({ qobuz: { outcome: 'transferring' } });
  c.adoptTransfer(track('a', { key: 'same' }), { received: 1, total: 2 });
  assert.equal(c.add(track('b', { key: 'same' })), 0);
  assert.equal(c.stats.total, 1);
});

test('cancelling an inline transfer always notifies cancelTransfer', async () => {
  const cancelledTransfers = [];
  const worker = {
    async run() {
      return { outcome: 'transferring' };
    },
  };
  const c = new Controller({
    getWorker: () => worker,
    services: ['qobuz'],
    concurrency: 1,
    maxTransfers: 0, // forces inline transfer
    awaitTransfer: () => new Promise(() => {}),
    cancelTransfer: (id) => cancelledTransfers.push(id),
  });
  c.add(track('t1'));
  await settle();
  c.cancel('t1');
  assert.deepEqual(cancelledTransfers, ['t1']);
});


// ---- custom queue, priority preemption & casual per-item pause/resume -----

test('pauseItem pauses an active track, frees its worker slot for the next track, and resumeItem finishes it', async () => {
  const order = [];
  let releaseA;
  const gateA = new Promise((r) => { releaseA = r; });

  const worker = {
    async run(item, step, signal) {
      order.push(`start:${item.id}`);
      if (item.id === 'a' && order.filter((x) => x === 'start:a').length === 1) {
        await Promise.race([
          gateA,
          new Promise((r) => signal.addEventListener('abort', r, { once: true })),
        ]);
        if (signal.aborted) return { outcome: 'cancelled' };
      }
      order.push(`done:${item.id}`);
      return { outcome: 'completed' };
    },
  };

  const c = new Controller({ getWorker: () => worker, services: ['qobuz'], concurrency: 1 });
  c.add([track('a', { key: 'a' }), track('b', { key: 'b' })]);
  await settle();

  assert.equal(c.getItem('a').status, 'searching');
  assert.equal(c.pauseItem('a'), true);
  assert.equal(c.getItem('a').status, 'paused');
  assert.equal(c.stats.paused, 1);

  // Freed slot runs 'b' immediately while 'a' stays paused
  await c.pool.onIdle();
  assert.equal(c.getItem('b').status, COMPLETED);
  assert.equal(c.getItem('a').status, 'paused');

  // Resuming 'a' picks it back up and completes it
  releaseA();
  assert.equal(c.resumeItem('a'), true);
  await c.pool.onIdle();
  assert.equal(c.getItem('a').status, COMPLETED);
  assert.equal(c.stats.paused, 0);
});

test('priority add with preempt interrupts a busy non-priority worker without cancelling the preempted item', async () => {
  const completedOrder = [];
  const worker = {
    async run(item, step, signal) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 15);
        signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      });
      if (signal.aborted) return { outcome: 'cancelled' };
      completedOrder.push(item.id);
      return { outcome: 'completed' };
    },
  };

  const c = new Controller({ getWorker: () => worker, services: ['qobuz'], concurrency: 1 });
  c.add([track('slow-1', { key: 'k1' }), track('slow-2', { key: 'k2' })]);
  await new Promise((r) => setTimeout(r, 3));

  // Preempt with an urgent track while slow-1 is mid-run
  c.add(track('urgent', { key: 'ku' }), { priority: true, preempt: true });
  await c.pool.onIdle();

  assert.equal(completedOrder[0], 'urgent', 'urgent track finishes first');
  assert.deepEqual(completedOrder, ['urgent', 'slow-1', 'slow-2'], 'preempted track resumes right after urgent');
  assert.equal(c.stats.completed, 3);
});

test('pauseGroup and resumeGroup control a playlist independently of other groups', async () => {
  const { c } = makeController({ qobuz: { outcome: 'completed' } });
  c.pause();
  c.add([
    track('g1-a', { key: 'g1a', groupId: 'g1', groupName: 'Playlist 1' }),
    track('g1-b', { key: 'g1b', groupId: 'g1', groupName: 'Playlist 1' }),
    track('g2-a', { key: 'g2a', groupId: 'g2', groupName: 'Playlist 2' }),
  ]);

  assert.equal(c.pauseGroup('g1'), 2);
  assert.equal(c.getItem('g1-a').status, 'paused');
  assert.equal(c.getItem('g1-b').status, 'paused');
  assert.equal(c.getItem('g2-a').status, 'queued');

  c.resume();
  await c.pool.onIdle();
  assert.equal(c.getItem('g2-a').status, COMPLETED);
  assert.equal(c.getItem('g1-a').status, 'paused');

  assert.equal(c.resumeGroup('g1'), 2);
  await c.pool.onIdle();
  assert.equal(c.getItem('g1-a').status, COMPLETED);
  assert.equal(c.getItem('g1-b').status, COMPLETED);
});
