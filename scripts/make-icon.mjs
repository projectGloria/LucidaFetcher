// The app icon, drawn in code.
//
// No image editor and no conversion tool is involved on purpose: the icon has
// to exist as a 512px PNG for Linux/macOS and as a multi-size .ico for the
// Windows exe, installer and shortcut, and generating both from one description
// means the 16px favicon and the 256px shortcut can never drift apart. zlib and
// a CRC table are all a PNG actually needs, and Windows has accepted PNG-framed
// .ico entries since Vista.
//
// The mark: the app's accent violet on a rounded square, with a download arrow
// whose shaft is three audio bars. It has to survive being 16px in a system
// tray, so there is exactly one idea in it and no line thinner than a twelfth
// of the canvas.
//
//   node scripts/make-icon.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');

// --- PNG -------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param rgba Buffer of size*size*4 */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // One filter byte per scanline. Filter 0 (none) throughout - the image is
  // tiny and smooth, and zlib gets it under 20KB regardless.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- ICO -------------------------------------------------------------------

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);           // reserved
  header.writeUInt16LE(1, 2);           // type: icon
  header.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach((img, i) => {
    const at = i * 16;
    // 256 is written as 0: the field is one byte and 256 does not fit.
    dir[at] = img.size >= 256 ? 0 : img.size;
    dir[at + 1] = img.size >= 256 ? 0 : img.size;
    dir[at + 2] = 0;                    // palette entries
    dir[at + 3] = 0;                    // reserved
    dir.writeUInt16LE(1, at + 4);       // colour planes
    dir.writeUInt16LE(32, at + 6);      // bits per pixel
    dir.writeUInt32LE(img.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += img.png.length;
  });

  return Buffer.concat([header, dir, ...images.map((i) => i.png)]);
}

// --- the drawing ------------------------------------------------------------

// Straight from styles.css, so the icon is the same violet as the interface.
const ACCENT_HI = [0x8d, 0x93, 0xff];
const ACCENT_LO = [0x4a, 0x54, 0xe8];
const INK = [0xf4, 0xf5, 0xff];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * clamp01(t)));

/** Signed distance to a rounded rectangle centred on the origin. */
function sdRoundedRect(px, py, halfW, halfH, r) {
  const qx = Math.abs(px) - (halfW - r);
  const qy = Math.abs(py) - (halfH - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * The glyph, in a 0..1 square. Returns true where ink should go.
 *
 * A download arrow with three audio bars for a shaft: the bars say "audio", the
 * head says "fetch", and at 16px the whole thing still reads as an arrow, which
 * is the only thing it has to do at that size.
 */
function inGlyph(x, y) {
  const cx = x - 0.5;

  // Three bars of a level meter, centre one tallest, all ending where the
  // arrowhead begins.
  const barBottom = 0.50;
  const bars = [
    { at: -0.150, top: 0.30 },
    { at: 0.000, top: 0.20 },
    { at: 0.150, top: 0.30 },
  ];
  for (const b of bars) {
    if (sdRoundedRect(cx - b.at, y - (b.top + barBottom) / 2,
      0.052, (barBottom - b.top) / 2, 0.045) <= 0) return true;
  }

  // The arrowhead: a downward triangle, corners eased by testing a small
  // rounded distance rather than the bare half-planes.
  const tipY = 0.800;
  const topY = 0.515;
  const halfSpan = 0.225;
  if (y >= topY && y <= tipY) {
    const t = (y - topY) / (tipY - topY);
    const half = halfSpan * (1 - t);
    // A little vertical rounding at the tip so it does not alias to a point.
    if (Math.abs(cx) <= half + 0.012 && y <= tipY - Math.max(0, (Math.abs(cx) / halfSpan) * 0.02)) return true;
  }
  return false;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4; // 4x4 supersampling: 17 levels of coverage, plenty for a glyph
  const radius = 0.235; // of the full width, in the rounded-square style

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let inkHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          // A hair of inset so the rounded corners are not clipped by the edge.
          if (sdRoundedRect(u - 0.5, v - 0.5, 0.5 - 0.006, 0.5 - 0.006, radius) <= 0) bgHits++;
          if (inGlyph(u, v)) inkHits++;
        }
      }
      const total = SS * SS;
      const bg = bgHits / total;
      const ink = (inkHits / total) * bg; // ink cannot spill past the tile

      // Diagonal gradient, lighter at the top-left, plus a soft top highlight -
      // enough depth that the tile does not look flat next to Windows' own
      // icons without turning into a skeuomorphic button.
      const t = (x / size) * 0.55 + (y / size) * 0.75;
      let colour = mix(ACCENT_HI, ACCENT_LO, t);
      colour = mix(colour, [255, 255, 255], Math.max(0, 0.16 - (y / size) * 0.5));
      const px = mix(colour, INK, ink);

      const at = (y * size + x) * 4;
      rgba[at] = px[0];
      rgba[at + 1] = px[1];
      rgba[at + 2] = px[2];
      rgba[at + 3] = Math.round(bg * 255);
    }
  }
  return rgba;
}

// --- output -----------------------------------------------------------------

mkdirSync(OUT, { recursive: true });

// electron-builder wants a 512px source for the app icon; the .ico carries the
// sizes Windows actually asks for - 16 and 32 for the tray and title bar, 256
// for the shortcut and the installer.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const icoImages = ICO_SIZES.map((size) => ({ size, png: encodePng(render(size), size) }));

writeFileSync(join(OUT, 'icon.ico'), encodeIco(icoImages));
writeFileSync(join(OUT, 'icon.png'), encodePng(render(512), 512));
// The tray asks for a small bitmap and scales badly from a large one, so it
// gets its own file at the size Windows draws it.
writeFileSync(join(OUT, 'tray.png'), encodePng(render(32), 32));

console.log('build/icon.ico  ' + ICO_SIZES.join(', '));
console.log('build/icon.png  512');
console.log('build/tray.png  32');
