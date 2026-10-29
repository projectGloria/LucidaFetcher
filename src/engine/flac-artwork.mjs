import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const MAX_PICTURE = 16 * 1024 * 1024;

async function readExactly(file, size, at) {
  const bytes = Buffer.alloc(size);
  if ((await file.read(bytes, 0, size, at)).bytesRead !== size) throw new Error('Truncated FLAC metadata');
  return bytes;
}

export function pictureBytes(body) {
  let at = 4;
  const skip = () => {
    if (at + 4 > body.length) throw new Error('Invalid FLAC picture');
    const size = body.readUInt32BE(at); at += 4 + size;
    if (at > body.length) throw new Error('Invalid FLAC picture');
  };
  skip(); skip(); // MIME and description
  at += 16; // width, height, depth, palette
  if (at + 4 > body.length) throw new Error('Invalid FLAC picture');
  const length = body.readUInt32BE(at); at += 4;
  if (!length || at + length !== body.length) throw new Error('Invalid FLAC picture');
  return body.subarray(at);
}

async function metadata(file) {
  if ((await readExactly(file, 4, 0)).toString() !== 'fLaC') throw new Error('Not FLAC');
  const blocks = [];
  let at = 4;
  for (let count = 0; count < 10000; count++) {
    const head = await readExactly(file, 4, at);
    const length = head.readUIntBE(1, 3);
    if (!count && ((head[0] & 127) !== 0 || length !== 34)) throw new Error('Invalid STREAMINFO');
    blocks.push({ type: head[0] & 127, at: at + 4, length });
    at += 4 + length;
    if (head[0] & 128) return { blocks, audioAt: at };
  }
  throw new Error('Too many metadata blocks');
}

export async function hasValidArtwork(path, decode) {
  const file = await open(path, 'r');
  try {
    const { blocks } = await metadata(file);
    for (const block of blocks) {
      if (block.type !== 6 || block.length > MAX_PICTURE) continue;
      try {
        if (decode(pictureBytes(await readExactly(file, block.length, block.at)))) return true;
      } catch { /* A bad picture must not hide a later valid front cover. */ }
    }
    return false;
  } finally { await file.close(); }
}

export async function embedArtwork(path, { bytes, mime = 'image/png', width, height }) {
  if (!bytes?.length || bytes.length > MAX_PICTURE - 1024 || !width || !height) throw new Error('Invalid artwork');
  const mimeBytes = Buffer.from(mime);
  const body = Buffer.alloc(32 + mimeBytes.length + bytes.length);
  body.writeUInt32BE(3, 0); body.writeUInt32BE(mimeBytes.length, 4); mimeBytes.copy(body, 8);
  const at = 8 + mimeBytes.length;
  body.writeUInt32BE(width, at + 4); body.writeUInt32BE(height, at + 8);
  body.writeUInt32BE(24, at + 12); body.writeUInt32BE(bytes.length, at + 20); bytes.copy(body, at + 24);
  const temporary = `${path}.${randomUUID()}.metadata`;
  const source = await open(path, 'r');
  let target;
  try {
    const { blocks, audioAt } = await metadata(source);
    target = await open(temporary, 'wx');
    const write = async chunk => {
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await target.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw new Error('Short FLAC write');
        offset += bytesWritten;
      }
    };
    const copy = async (start, length) => {
      const buffer = Buffer.alloc(256 * 1024);
      while (length > 0) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(length, buffer.length), start);
        if (!bytesRead) throw new Error('Truncated FLAC');
        await write(buffer.subarray(0, bytesRead)); start += bytesRead; length -= bytesRead;
      }
    };
    await write(Buffer.from('fLaC'));
    for (const block of blocks) {
      if (block.type === 6) continue;
      const head = Buffer.alloc(4); head[0] = block.type; head.writeUIntBE(block.length, 1, 3);
      await write(head); await copy(block.at, block.length);
    }
    const head = Buffer.alloc(4); head[0] = 128 | 6; head.writeUIntBE(body.length, 1, 3);
    await write(head); await write(body);
    await copy(audioAt, (await source.stat()).size - audioAt);
    await target.sync(); await target.close();
    await source.close();
    await rename(temporary, path);
  } finally {
    await target?.close(); await source.close();
    await unlink(temporary).catch(() => {});
  }
}
