import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DownloadTracker } from '../src/engine/electron-bridge.mjs';

const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function policies(config = {}, fileSystem = fs) {
  const sandbox = { fs: fileSystem, Buffer, config, nativeImage: {
    createFromBuffer: bytes => ({ isEmpty: () => !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) }),
  } };
  vm.runInNewContext(main.slice(main.indexOf('function downloadSourceEnabled('), main.indexOf('const mediaTransfers =')), sandbox);
  return sandbox;
}

test('main process accepts only enabled sources, never YouTube or SoundCloud', () => {
  const { downloadSourceEnabled: enabled } = policies({ fallbackServices: ['qobuz', 'tidal', 'amazon', 'youtube', 'soundcloud'] });
  for (const source of ['qobuz', 'tidal', 'amazon']) assert.equal(enabled(source), true);
  for (const source of ['youtube', 'soundcloud', 'deezer', 'monochrome', undefined]) assert.equal(enabled(source), false);
  assert.equal(policies({ fallbackServices: [] }).downloadSourceEnabled('amazon'), false);
});

test('FLAC validation rejects lossy data renamed to .flac and existing lossy files', () => {
  for (const [name, data, expected] of [
    ['song.flac', 'fLaC', true],
    ['renamed.flac', 'ID3lossy audio', false],
    ['song.mp3', 'ID3lossy audio', false],
    ['song.m4a', 'ftypM4A', false],
    ['empty.flac', '', false],
  ]) {
    let closed = false;
    const { isFlacFile } = policies({}, {
      openSync: () => 1,
      readSync: (_fd, buffer) => Buffer.from(data).copy(buffer),
      closeSync: () => { closed = true; },
    });
    assert.equal(isFlacFile(name), expected, name);
    if (name.endsWith('.flac')) assert.equal(closed, true);
  }
});

test('Chromium rejects disabled, blocked, and non-FLAC transfers before saving', () => {
  for (const [service, filename, url] of [
    ['qobuz', 'song.mp3', 'https://cdn.example/song.mp3'],
    ['soundcloud', 'song.flac', 'https://soundcloud.com/a/b'],
    ['deezer', 'song.flac', 'https://cdn.example/song.flac'],
    ['qobuz', 'song.flac', 'https://youtube.com/watch?v=1'],
  ]) {
    let rejected = false;
    const messages = [];
    const sandbox = { ...policies({ fallbackServices: ['qobuz'] }), URL, providerDownloads: new Map(),
      MEDIA_HOSTS: /(^|\.)(soundcloud\.com|snd\.sc|youtube\.com|youtu\.be)$/i,
      takeDownloadContext: () => ({ itemId: 'one', attemptService: service }),
      safeBaseName: s => s, forgetTransfer() {}, logEvent() {}, toUI: (...args) => messages.push(args),
    };
    vm.runInNewContext(main.slice(main.indexOf('function handleWillDownload('), main.indexOf('// ---------------------------------------------------------------------------\n// System tray')), sandbox);
    sandbox.handleWillDownload({ preventDefault() { rejected = true; } }, {
      getFilename: () => filename, getURL: () => url,
      setSavePath() { assert.fail('A rejected transfer must not save a file'); },
    }, {});
    assert.equal(rejected, true);
    assert.equal(messages[0][1].status, 'rejected-format-or-source');
  }
});

test('a rejected transfer settles a pending start without waiting for timeout', async () => {
  const listeners = {};
  const tracker = new DownloadTracker({ on: (name, fn) => { listeners[name] = fn; } });
  const started = tracker.awaitStart('one');
  listeners['download-status'](null, { itemId: 'one', status: 'rejected-format' });
  await started;
  assert.equal((await tracker.await('one')).status, 'rejected-format');
});

// ---------------------------------------------------------------------------
// Embedded artwork validation
//
// A FLAC file's metadata chain is: 4-byte "fLaC" magic, then N blocks, each
// with a 4-byte header (type + 24-bit length) followed by `length` bytes of
// body. Type 0 = STREAMINFO, type 6 = PICTURE. The last-block flag is bit 7
// of the first header byte. The tests below build minimal byte sequences to
// exercise hasEmbeddedArtwork without touching the filesystem.
// ---------------------------------------------------------------------------

function flacBytes(blocks) {
  // blocks: [{ type, last?, bodyLen }]  (no actual body needed - readSync is mocked)
  const parts = [Buffer.from('fLaC', 'ascii')];
  for (const b of blocks) {
    let body = Buffer.alloc(b.bodyLen);
    if (b.type === 6) {
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
      body = Buffer.alloc(32 + 9 + png.length);
      body.writeUInt32BE(3); body.writeUInt32BE(9, 4); body.write('image/png', 8);
      body.writeUInt32BE(1, 21); body.writeUInt32BE(1, 25); body.writeUInt32BE(png.length, 37); png.copy(body, 41);
    }
    const h = Buffer.alloc(4);
    h[0] = (b.type & 0x7f) | (b.last ? 0x80 : 0);
    h.writeUIntBE(body.length, 1, 3);
    parts.push(h);
    parts.push(body);
  }
  return Buffer.concat(parts);
}

function artworkPolicies(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
  return policies({}, {
    openSync: () => 1,
    readSync: (_fd, buffer, offset, length, position) => {
      const available = Math.max(0, buf.length - position);
      const n = Math.min(length, available);
      buf.copy(buffer, offset, position, position + n);
      return n;
    },
    closeSync: () => {},
  });
}

test('hasEmbeddedArtwork detects PICTURE blocks in FLAC files', () => {
  // STREAMINFO (type 0, 34 bytes) + PICTURE (type 6, 100 bytes, last)
  const withArt = flacBytes([
    { type: 0, bodyLen: 34 },
    { type: 6, bodyLen: 100, last: true },
  ]);
  assert.equal(artworkPolicies(withArt).hasEmbeddedArtwork('track.flac'), true);
});

test('hasEmbeddedArtwork rejects FLAC files without a PICTURE block', () => {
  // STREAMINFO only (type 0, 34 bytes, last)
  const noArt = flacBytes([
    { type: 0, bodyLen: 34, last: true },
  ]);
  assert.equal(artworkPolicies(noArt).hasEmbeddedArtwork('track.flac'), false);
});

test('hasEmbeddedArtwork rejects non-FLAC and non-.flac files', () => {
  assert.equal(artworkPolicies('ID3lossy').hasEmbeddedArtwork('track.flac'), false);
  assert.equal(artworkPolicies('fLaC').hasEmbeddedArtwork('track.mp3'), false);
  assert.equal(artworkPolicies('').hasEmbeddedArtwork('track.flac'), false);
});

test('hasEmbeddedArtwork finds PICTURE after multiple non-PICTURE blocks', () => {
  // STREAMINFO + VORBIS_COMMENT (type 4) + PICTURE (type 6, last)
  const multi = flacBytes([
    { type: 0, bodyLen: 34 },
    { type: 4, bodyLen: 200 },
    { type: 6, bodyLen: 50, last: true },
  ]);
  assert.equal(artworkPolicies(multi).hasEmbeddedArtwork('song.flac'), true);
});

test('a rejected-no-artwork status settles a pending DownloadTracker start', async () => {
  const listeners = {};
  const tracker = new DownloadTracker({ on: (name, fn) => { listeners[name] = fn; } });
  const started = tracker.awaitStart('art');
  listeners['download-status'](null, { itemId: 'art', status: 'rejected-no-artwork' });
  await started;
  assert.equal((await tracker.await('art')).status, 'rejected-no-artwork');
});

test('safeFetchImage blocks private hosts, insecure protocols, and malicious redirects', async () => {
  const sandbox = {
    URL, Buffer, AbortSignal,
    PRIVATE_HOST: /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd])/i,
    MAX_ARTWORK_BYTES: 15 * 1024 * 1024,
    boundedBytes: async (_res) => Buffer.from('image-bytes'),
    net: {
      fetch: async (href) => {
        if (href === 'https://example.com/redirect-to-private') {
          return { status: 302, headers: new Map([['location', 'http://127.0.0.1:8080/secret.jpg']]) };
        }
        if (href === 'https://example.com/redirect-to-safe') {
          return { status: 302, headers: new Map([['location', 'https://cdn.example.com/cover.jpg']]) };
        }
        if (href === 'https://cdn.example.com/cover.jpg') {
          return {
            ok: true, status: 200,
            headers: new Map([['content-type', 'image/jpeg'], ['content-length', '11']]),
          };
        }
        return { ok: false, status: 404 };
      },
    },
  };
  vm.runInNewContext(main.slice(main.indexOf('async function safeFetchImage('), main.indexOf('const pendingArtworkDownloads =')), sandbox);

  // Insecure and private initial hosts
  await assert.rejects(() => sandbox.safeFetchImage('http://example.com/art.jpg'), /Insecure or private host blocked/);
  await assert.rejects(() => sandbox.safeFetchImage('https://127.0.0.1/art.jpg'), /Insecure or private host blocked/);
  await assert.rejects(() => sandbox.safeFetchImage('https://localhost/art.jpg'), /Insecure or private host blocked/);
  await assert.rejects(() => sandbox.safeFetchImage('https://192.168.1.10/art.jpg'), /Insecure or private host blocked/);

  // Malicious redirect to loopback
  await assert.rejects(() => sandbox.safeFetchImage('https://example.com/redirect-to-private'), /Insecure or private host blocked/);

  // Valid redirect to safe HTTPS image
  const res = await sandbox.safeFetchImage('https://example.com/redirect-to-safe');
  assert.equal(res.buf.toString(), 'image-bytes');
  assert.equal(res.url.href, 'https://cdn.example.com/cover.jpg');
});

