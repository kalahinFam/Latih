/**
 * Generates the PWA icons as real PNGs, with no image library.
 *
 * A dependency for two static files is not worth it, and hand-rolling the PNG
 * container is about forty lines: signature, IHDR, one zlib-deflated IDAT, IEND.
 *
 * The mark is a range-of-motion arc — the thing the product actually measures —
 * rather than a letterform, because a glyph rendered by hand-plotting pixels
 * would look worse than a shape chosen to be drawn that way.
 *
 * Run: node scripts/gen-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'public', 'icons');

const BG = [11, 17, 32]; // --bg  #0b1120
const ACCENT = [34, 211, 238]; // --accent #22d3ee
const ACCENT_DIM = [15, 118, 145];

// ---------------------------------------------------------------- PNG writer

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** @param {Uint8Array} rgba length = width*height*4 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // Each scanline is prefixed with its filter type. Filter 0 (none) keeps this
  // simple; deflate still compresses the large flat areas well.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ drawing

/** Smooth 0..1 coverage across a half-pixel band, so edges are not jagged. */
function coverage(distance, edge) {
  return Math.min(1, Math.max(0, 0.5 - (distance - edge)));
}

function blend(dst, offset, colour, alpha) {
  if (alpha <= 0) return;
  const a = Math.min(1, alpha);
  dst[offset] = Math.round(dst[offset] * (1 - a) + colour[0] * a);
  dst[offset + 1] = Math.round(dst[offset + 1] * (1 - a) + colour[1] * a);
  dst[offset + 2] = Math.round(dst[offset + 2] * (1 - a) + colour[2] * a);
  dst[offset + 3] = 255;
}

/**
 * @param {number} size
 * @param {boolean} maskable When true, art is inset so Android can crop the
 *   icon to any shape without clipping the mark.
 */
function drawIcon(size, maskable) {
  const rgba = new Uint8Array(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;

  // Maskable icons must keep their content inside the safe zone (the middle
  // 80%); anything outside can be cropped away by the launcher.
  const scale = maskable ? 0.62 : 0.78;
  const outer = (size / 2) * scale;
  const ring = outer * 0.26; // stroke width
  const midRadius = outer - ring / 2;

  // An open ring with a 60-degree gap centred on the bottom, swept clockwise.
  // Angles below are measured clockwise from straight up, so the gap spans
  // 150..210 degrees and the sweep starts at 210 and wraps through 0.
  const TAU = Math.PI * 2;
  const gapStart = (150 / 360) * TAU;
  const gapEnd = (210 / 360) * TAU;
  const sweepStart = gapEnd;
  const sweepLength = TAU - (gapEnd - gapStart);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      blend(rgba, offset, BG, 1);

      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const distance = Math.hypot(dx, dy);

      let angle = Math.atan2(dx, -dy);
      if (angle < 0) angle += TAU;

      const alpha = coverage(Math.abs(distance - midRadius), ring / 2);
      if (alpha > 0 && !(angle > gapStart && angle < gapEnd)) {
        // Progress along the sweep, wrapping past 0 at the top.
        const t = ((angle - sweepStart + TAU) % TAU) / sweepLength;
        // Dim at the start, full accent for the rest: the arc reads as motion
        // travelling in a direction rather than a static ring.
        blend(rgba, offset, t < 0.3 ? ACCENT_DIM : ACCENT, alpha);
      }

      // Centre dot: the joint the arc is measured about.
      blend(rgba, offset, ACCENT, coverage(distance, outer * 0.2));
    }
  }

  return rgba;
}

// -------------------------------------------------------------------- write

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: false },
];

for (const { file, size, maskable } of targets) {
  const png = encodePng(size, size, drawIcon(size, maskable));
  writeFileSync(join(OUT_DIR, file), png);
  console.log(`${file.padEnd(24)} ${size}x${size}  ${png.length} bytes`);
}
