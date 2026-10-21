// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark gradient, a pair of
// bookshelf speakers, each with a concentric driver (a tweeter in the middle
// of the cone), a status led and sound waves between them. Plain Node (zlib),
// no dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
/** Antialiased coverage of a signed distance (negative inside). */
const inside = (distance) => Math.min(1, Math.max(0, 0.5 - distance));

/** Signed distance to a rounded rectangle centred on (cx, cy). */
function roundRect(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

const DARK = [14, 15, 20];
const GREY = [44, 46, 56];
const CABINET = [232, 230, 226];
const CABINET_SHADE = [178, 176, 172];
const CONE = [196, 120, 64];
const CONE_DARK = [120, 70, 36];
const RING = [40, 42, 48];
const TWEETER = [222, 196, 150];
const GLOW = [255, 176, 92];

const SPEAKERS = [
  { cx: 230, cy: 262 },
  { cx: 570, cy: 262 },
];

function speaker(color, x, y, { cx, cy }) {
  // Soft shadow under the cabinet.
  const shadow = Math.hypot((x - cx) / 140, (y - (cy + 168)) / 14);
  color = mix(color, [0, 0, 0], (1 - shadow) * 0.7);
  // The cabinet, lit from the top left.
  const body = roundRect(x, y, cx, cy, 110, 160, 22);
  const shade = ((x - cx) / 220 + (y - cy) / 320) * 0.9 + 0.3;
  color = mix(color, mix(CABINET, CABINET_SHADE, shade), inside(body));
  // The driver: a dark surround, the cone, the tweeter in its centre.
  const dx = x - cx;
  const dy = y - (cy - 18);
  const d = Math.hypot(dx, dy);
  color = mix(color, RING, inside(d - 82));
  const angle = Math.atan2(dy, dx);
  const sheen = 0.5 + 0.5 * Math.cos(angle - 2.3);
  const cone = mix(CONE_DARK, CONE, (d / 74) * 0.7 + sheen * 0.3);
  color = mix(color, cone, inside(d - 74));
  // Concentric ribs of the cone.
  for (const r of [38, 52, 64]) {
    color = mix(color, CONE_DARK, inside(Math.abs(d - r) - 1) * 0.5);
  }
  color = mix(color, RING, inside(d - 28));
  color = mix(color, mix(TWEETER, [255, 255, 255], sheen * 0.4), inside(d - 22));
  // The status led.
  color = mix(color, GLOW, inside(Math.hypot(x - cx, y - (cy + 120)) - 5));
  return color;
}

function pixel(x, y) {
  let color = mix(DARK, GREY, (x / WIDTH) * 0.6 + (y / HEIGHT) * 0.4);
  for (const s of SPEAKERS) {
    color = speaker(color, x, y, s);
  }
  // Sound waves between the speakers.
  const mid = { x: 400, y: 244 };
  const wd = Math.hypot(x - mid.x, y - mid.y);
  const waveAngle = Math.abs(Math.atan2(y - mid.y, Math.abs(x - mid.x)));
  if (Math.abs(x - mid.x) < 58 && waveAngle < 0.6) {
    for (const r of [18, 36, 54]) {
      color = mix(color, GLOW, inside(Math.abs(wd - r) - 2.5) * (1 - waveAngle / 0.6) * 0.9);
    }
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
