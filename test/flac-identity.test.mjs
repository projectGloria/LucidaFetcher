import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFlacIdentity, verifyFlacIdentity } from '../src/engine/flac-identity.mjs';
import { score, isAcceptable, injectableScorer } from '../src/engine/matching.mjs';

const block = (type, body, last = false) => {
  const header = Buffer.alloc(4); header[0] = type | (last ? 128 : 0); header.writeUIntBE(body.length, 1, 3);
  return Buffer.concat([header, body]);
};
const uint = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };
const flac = (tags, duration = 180) => {
  const stream = Buffer.alloc(34); stream.writeUInt16BE(4096);
  stream.writeBigUInt64BE((44100n << 44n) | BigInt(Math.round(44100 * duration)), 10);
  const comments = Object.entries(tags).flatMap(([key, values]) => (Array.isArray(values) ? values : [values]).map(value => Buffer.from(`${key}=${value}`)));
  return Buffer.concat([Buffer.from('fLaC'), block(0, stream), block(4, Buffer.concat([
    uint(0), uint(comments.length), ...comments.flatMap(c => [uint(c.length), c]),
  ]), true), Buffer.from([255, 248, 0, 0])]);
};

test('FLAC identity rejects remixes, another artist, duration drift and a different ISRC', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lucida-identity-'));
  try {
    const file = path.join(temp, 'track.flac');
    const expected = { title: 'Song', artist: 'Artist', durationSec: 180, isrc: 'USABC1234567' };
    for (const [tags, duration, ok] of [
      [{ TITLE: 'Song', ARTIST: 'Artist', ISRC: 'US-ABC-12-34567' }, 180, true],
      [{ TITLE: 'Song (Remix)', ARTIST: 'Artist' }, 180, false],
      [{ TITLE: 'Song', ARTIST: 'Someone Else' }, 180, false],
      [{ TITLE: 'Song', ARTIST: 'Artist' }, 240, false],
      [{ TITLE: 'Song', ARTIST: 'Artist', ISRC: 'USABC1234568' }, 180, false],
      [{}, 181, true],
      [{}, 240, false],
    ]) {
      await fs.writeFile(file, flac(tags, duration));
      assert.equal((await verifyFlacIdentity(file, expected)).ok, ok, JSON.stringify(tags));
    }
    await fs.writeFile(file, flac({ TITLE: 'Song', ARTIST: ['Artist', 'Guest'] }));
    const actual = await readFlacIdentity(file);
    assert.equal(actual.artist, 'Artist, Guest'); assert.equal(actual.durationSec, 180);
    await fs.writeFile(file, flac({ TITLE: 'Song' }).subarray(0, 50));
    await assert.rejects(readFlacIdentity(file), /Truncated/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('duration and word order gates agree in the module and injected scorer', () => {
  const expected = { title: 'No Glory', artist: 'Artist', durationSec: 180 };
  for (const [title, duration, ok] of [['No Glory', 182, true], ['No Glory', 240, false], ['Glory No', 180, false]]) {
    assert.equal(isAcceptable(score(expected, title, 'Artist', duration)), ok);
    assert.equal(new Function(`${injectableScorer(expected)} return isAcceptable(score(${JSON.stringify(title)}, 'Artist', ${duration}), MIN_TITLE_SCORE);`)(), ok);
  }
});
