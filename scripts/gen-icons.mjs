// Generates the extension PNG icons with zero dependencies (hand-rolled PNG encoder).
// Run: npm run icons
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'public/icons');

/* ------------------------------- PNG encoder ------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

/** @param {Uint8Array} rgba length = w*h*4 */
function encodePng(rgba, w, h) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------- artwork -------------------------------- */

const lerp = (a, b, t) => a + (b - a) * t;

/** Signed distance to a rounded rect centred in a unit box. */
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Paint one pixel in unit coordinates (0..1). Returns [r,g,b,a] 0..255. */
function shade(u, v) {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;

  // Background: rounded square, indigo -> violet vertical gradient.
  if (sdRoundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.22) <= 0) {
    const t = (u + v) / 2;
    r = lerp(79, 139, t);
    g = lerp(70, 92, t);
    b = lerp(229, 246, t);
    a = 255;
  }

  if (a === 0) return [0, 0, 0, 0];

  // Four L-shaped viewfinder corners (a "snapshot frame").
  const inset = 0.24;
  const thick = 0.075;
  const armLen = 0.16;
  const nearL = u >= inset && u <= inset + armLen;
  const nearR = u <= 1 - inset && u >= 1 - inset - armLen;
  const nearT = v >= inset && v <= inset + armLen;
  const nearB = v <= 1 - inset && v >= 1 - inset - armLen;
  const onLeft = Math.abs(u - inset) <= thick / 2;
  const onRight = Math.abs(u - (1 - inset)) <= thick / 2;
  const onTop = Math.abs(v - inset) <= thick / 2;
  const onBottom = Math.abs(v - (1 - inset)) <= thick / 2;

  const inCorner =
    ((onLeft || onRight) && (nearT || nearB)) || ((onTop || onBottom) && (nearL || nearR));

  if (inCorner) return [255, 255, 255, 255];

  // Centre "record" dot.
  if (Math.hypot(u - 0.5, v - 0.5) <= 0.115) return [244, 63, 94, 255];

  return [r | 0, g | 0, b | 0, a];
}

function render(size) {
  const SS = 4; // supersampling factor for smooth edges
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let aa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [r, g, b, a] = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          const w = a / 255;
          ar += r * w;
          ag += g * w;
          ab += b * w;
          aa += a;
        }
      }
      const n = SS * SS;
      const alpha = aa / n;
      const wSum = aa / 255 || 1;
      const i = (y * size + x) * 4;
      out[i] = Math.round(ar / wSum);
      out[i + 1] = Math.round(ag / wSum);
      out[i + 2] = Math.round(ab / wSum);
      out[i + 3] = Math.round(alpha);
    }
  }
  return out;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = resolve(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, encodePng(render(size), size, size));
  console.log(`icon ${size}x${size} -> ${file}`);
}
