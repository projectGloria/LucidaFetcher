// The session log, read back as an explanation.
//
// The summariser is the part of the logging system that has to be right: a log
// nobody can read is the same as no log, and a summary that quietly drops the
// events it was not taught about is worse than no summary, because it looks
// complete.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, levelOf, chainLine, redactConfig, renderReport } from '../src/engine/diagnostics.mjs';

const session = {
  ts: '2026-09-09T10:00:00.000Z', t: 0, evt: 'session.start',
  electron: '44.0.0', chrome: '152', node: '24', platform: 'win32', arch: 'x64',
  downloadPath: 'D:/KAN', stateDir: 'D:/state',
};

const run = () => [
  session,
  { evt: 'attempt.outcome', id: '1', name: 'A - One', service: 'qobuz', outcome: 'not-found', ms: 1200 },
  { evt: 'attempt.outcome', id: '1', name: 'A - One', service: 'tidal', outcome: 'download', ms: 800 },
  { evt: 'done', id: '1', name: 'A - One', service: 'tidal' },
  { evt: 'attempt.outcome', id: '2', name: 'B - Two', service: 'qobuz', outcome: 'not-found', ms: 1100 },
  { evt: 'attempt.error', id: '2', name: 'B - Two', service: 'tidal', message: 'page load timed out' },
  { evt: 'skip', id: '2', name: 'B - Two', reason: 'No source had it', tried: ['qobuz', 'tidal'] },
  { evt: 'download.start' },
  { evt: 'download.done', bytes: 5 * 1024 * 1024 },
];

test('an event name is enough to know how bad it is', () => {
  assert.equal(levelOf('attempt.error'), 'error');
  assert.equal(levelOf('error.renderer'), 'error');
  assert.equal(levelOf('crash.renderer'), 'error');
  assert.equal(levelOf('media.resolve.failed'), 'error');
  assert.equal(levelOf('http.blocked'), 'warn');
  assert.equal(levelOf('download.interrupted'), 'warn');
  assert.equal(levelOf('download.progress'), 'debug');
  assert.equal(levelOf('download.start'), 'info');
});

test('an event nobody taught it about is kept, not dropped', () => {
  // A summary that ignores what it does not recognise is the summary that
  // hides the next bug.
  const s = summarize([{ evt: 'something.brand.new', detail: 1 }]);
  assert.equal(s.counts.total, 1);
  assert.equal(s.counts.info, 1);
  assert.deepEqual(s.events, [{ evt: 'something.brand.new', n: 1, level: 'info' }]);
});

test('a track keeps its chain in the order it was tried', () => {
  const s = summarize(run());
  const two = s.tracks.find((t) => t.id === '2');
  assert.equal(chainLine(two), 'qobuz:not-found -> tidal:error');
  assert.equal(two.result, 'missing');
  assert.equal(two.reason, 'No source had it');
  assert.deepEqual(two.tried, ['qobuz', 'tidal']);
});

test('a downloaded track records which source actually produced the file', () => {
  const s = summarize(run());
  const one = s.tracks.find((t) => t.id === '1');
  assert.equal(one.result, 'downloaded');
  assert.equal(one.via, 'tidal');
});

test('a track still running when the log ends is unfinished, not missing', () => {
  // The difference matters: "missing" is an answer, "unfinished" is the log
  // stopping - usually a crash, and never the track's fault.
  const s = summarize([session, { evt: 'attempt.outcome', id: '9', name: 'C', service: 'qobuz', outcome: 'not-found', ms: 5 }]);
  assert.equal(s.tracks[0].result, 'unfinished');
});

test('the source table says which store is actually working', () => {
  const s = summarize(run());
  const qobuz = s.services.find((x) => x.service === 'qobuz');
  const tidal = s.services.find((x) => x.service === 'tidal');
  assert.equal(qobuz.attempts, 2);
  assert.equal(qobuz.found, 0);
  assert.equal(qobuz.hitRate, 0);
  assert.equal(qobuz.avgMs, 1150);
  assert.equal(tidal.found, 1);
  assert.deepEqual(qobuz.outcomes, { 'not-found': 2 });
});

test('a handed-off transfer counts as the source having produced a file', () => {
  // `transferring` is a success: the store gave us a file and the pool moved
  // on. Counting it as a miss would make the pipeline look broken.
  const s = summarize([{ evt: 'attempt.outcome', id: '1', service: 'amazon', outcome: 'transferring', ms: 10 }]);
  assert.equal(s.services[0].found, 1);
});

test('repeated failures are clustered, not listed four hundred times', () => {
  const events = Array.from({ length: 400 }, () => (
    { evt: 'attempt.error', id: 'x', service: 'tidal', message: 'page load timed out' }));
  events.push({ evt: 'attempt.error', id: 'y', service: 'qobuz', message: 'something else' });
  const s = summarize(events);
  assert.equal(s.problems.length, 2);
  assert.equal(s.problems[0].n, 400);
  assert.equal(s.counts.error, 401);
});

test('credentials are redacted and paths are not', () => {
  const out = redactConfig({
    jamendoClientId: 'abc123', apiToken: 'xyz', downloadPath: 'D:/KAN',
    speedLimitKBps: 0, fallbackServices: ['amazon'],
  });
  assert.equal(out.jamendoClientId, '(set, redacted)');
  assert.equal(out.apiToken, '(set, redacted)');
  // The paths and the service list are exactly what a diagnosis needs.
  assert.equal(out.downloadPath, 'D:/KAN');
  assert.deepEqual(out.fallbackServices, ['amazon']);
});

test('an empty client id is left alone rather than claimed to be set', () => {
  assert.equal(redactConfig({ jamendoClientId: '' }).jamendoClientId, '');
});

test('the report leads with the diagnosis and carries the evidence', () => {
  const s = summarize(run());
  const text = renderReport({
    summary: s, config: { jamendoClientId: 'secret' },
    raw: ['{"evt":"done"}'], notes: 'half the profile came back missing',
    generatedAt: '2026-09-09T11:00:00.000Z',
  });

  assert.match(text, /^# LucidaFetcher diagnostics/);
  assert.match(text, /half the profile came back missing/);
  assert.ok(text.indexOf('## Summary') < text.indexOf('## Raw events'), 'diagnosis comes before evidence');
  assert.match(text, /1 downloaded, 1 missing/);
  assert.match(text, /B - Two/);
  assert.match(text, /qobuz:not-found -> tidal:error/);
  assert.match(text, /page load timed out/);
  assert.match(text, /5\.0 MB/);
  // Nothing secret survives into a file that is meant to be handed over.
  assert.equal(text.includes('secret'), false);
});

test('a log with nothing wrong in it says so', () => {
  const text = renderReport({ summary: summarize([session]), raw: [] });
  assert.match(text, /Nothing logged an error or a warning/);
  assert.match(text, /No search attempt was recorded/);
});

test('summarizing an empty or malformed log does not throw', () => {
  assert.doesNotThrow(() => summarize([]));
  assert.doesNotThrow(() => summarize(null));
  assert.doesNotThrow(() => summarize([null, 42, {}, { evt: 5 }]));
  assert.doesNotThrow(() => renderReport({ summary: summarize([]) }));
});
