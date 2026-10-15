// Read metadata only; never buffer the audio or large embedded pictures.
import fs from 'node:fs/promises';
import { score, isAcceptable } from './matching.mjs';

export async function readFlacIdentity(file) {
  const input = await fs.open(file, 'r');
  try {
    const size = (await input.stat()).size;
    const magic = Buffer.alloc(4);
    if ((await input.read(magic, 0, 4, 0)).bytesRead !== 4 || magic.toString('ascii') !== 'fLaC') throw new Error('Invalid FLAC header');
    const tags = {};
    let durationSec = 0, at = 4, last = false, count = 0;
    while (!last) {
      const header = Buffer.alloc(4);
      if (++count > 10000 || (await input.read(header, 0, 4, at)).bytesRead !== 4) throw new Error('Invalid FLAC metadata');
      const type = header[0] & 0x7f;
      const length = header.readUIntBE(1, 3);
      last = !!(header[0] & 0x80);
      at += 4;
      if (at + length > size) throw new Error('Truncated FLAC metadata');
      if (type === 0 || type === 4) {
        if (type === 4 && length > 1024 * 1024) throw new Error('FLAC comments exceed limit');
        const body = Buffer.alloc(length);
        if ((await input.read(body, 0, length, at)).bytesRead !== length) throw new Error('Truncated FLAC metadata');
        if (type === 0 && length === 34) {
          const packed = body.readBigUInt64BE(10);
          const sampleRate = Number(packed >> 44n);
          const samples = Number(packed & ((1n << 36n) - 1n));
          if (sampleRate && samples) durationSec = samples / sampleRate;
        }
        if (type === 4) {
          let pos = 0;
          const uint = () => {
            if (pos + 4 > length) throw new Error('Invalid FLAC comments');
            const value = body.readUInt32LE(pos); pos += 4; return value;
          };
          const vendorLength = uint(); pos += vendorLength;
          const comments = uint();
          if (comments > 10000) throw new Error('Too many FLAC comments');
          for (let i = 0; i < comments; i++) {
            const bytes = uint();
            if (pos + bytes > length) throw new Error('Invalid FLAC comments');
            const comment = body.toString('utf8', pos, pos + bytes); pos += bytes;
            const equals = comment.indexOf('=');
            if (equals < 1) continue;
            const key = comment.slice(0, equals).toUpperCase();
            const value = comment.slice(equals + 1).trim();
            if (value) (tags[key] ||= []).push(value);
          }
        }
      }
      at += length;
    }
    return { title: tags.TITLE?.[0] || '', artist: (tags.ARTIST || tags.ALBUMARTIST || []).join(', '),
      isrc: tags.ISRC?.[0] || '', durationSec };
  } finally { await input.close(); }
}

export async function verifyFlacIdentity(file, expected) {
  const actual = await readFlacIdentity(file);
  return compareFlacIdentity(actual, expected);
}

export function compareFlacIdentity(actual, expected) {
  // Some providers omit tags. Check every identity field they do supply.
  const scored = score(expected, actual.title || expected.title, actual.artist || expected.artist, actual.durationSec);
  if (!isAcceptable(scored)) return { ok: false, reason: 'title, artist or duration differs', actual };
  const isrc = value => String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  if (expected.isrc && actual.isrc && isrc(expected.isrc) !== isrc(actual.isrc)) return { ok: false, reason: 'ISRC differs', actual };
  return { ok: true, actual };
}
