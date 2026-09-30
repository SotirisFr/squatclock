// Generates the app icons (SVG + PNGs) with no dependencies.
// Usage: node tools/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

// Artwork in a 512×512 space: an alarm clock with bells and feet.
const RING = { cx: 256, cy: 290, r: 140, w: 34 };
const BELLS = [[140, 150, 52], [372, 150, 52]];
const DOT = [256, 290, 22];
const STROKES = [ // [x1, y1, x2, y2, halfWidth]
  [256, 290, 256, 196, 15],
  [256, 290, 322, 334, 15],
  [168, 420, 136, 458, 15],
  [344, 420, 376, 458, 15],
];
const C1 = [255, 122, 61];  // #ff7a3d
const C2 = [255, 61, 90];   // #ff3d5a

function svg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#ff7a3d"/><stop offset="1" stop-color="#ff3d5a"/>
  </linearGradient></defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <g transform="translate(256 256) scale(0.86) translate(-256 -284)" fill="#fff" stroke="#fff" stroke-linecap="round">
    ${BELLS.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" stroke="none"/>`).join('')}
    <circle cx="${RING.cx}" cy="${RING.cy}" r="${RING.r}" fill="none" stroke-width="${RING.w}"/>
    ${STROKES.map(([a, b, c, d, w]) => `<path d="M${a} ${b}L${c} ${d}" stroke-width="${w * 2}"/>`).join('')}
    <circle cx="${DOT[0]}" cy="${DOT[1]}" r="${DOT[2]}" stroke="none"/>
  </g>
</svg>
`;
}

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function inArt(x, y) {
  if (Math.abs(Math.hypot(x - RING.cx, y - RING.cy) - RING.r) <= RING.w / 2) return true;
  if (Math.hypot(x - DOT[0], y - DOT[1]) <= DOT[2]) return true;
  for (const [bx, by, r] of BELLS) if (Math.hypot(x - bx, y - by) <= r) return true;
  for (const [a, b, c, d, w] of STROKES) if (segDist(x, y, a, b, c, d) <= w) return true;
  return false;
}

function inRoundRect(x, y, s, r) {
  const qx = Math.max(Math.abs(x - s / 2) - (s / 2 - r), 0);
  const qy = Math.max(Math.abs(y - s / 2) - (s / 2 - r), 0);
  return Math.hypot(qx, qy) <= r;
}

function render(size, { scale, rounded }) {
  const px = Buffer.alloc(size * size * 4);
  const SS = 4;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          // Sample position in 512-space.
          const x = ((i + (si + 0.5) / SS) / size) * 512;
          const y = ((j + (sj + 0.5) / SS) / size) * 512;
          if (rounded && !inRoundRect(x, y, 512, 112)) continue;
          const ax = (x - 256) / scale + 256;
          const ay = (y - 256) / scale + 284;
          let c;
          if (inArt(ax, ay)) c = [255, 255, 255];
          else {
            const t = (x + y) / 1024;
            c = C1.map((v, k) => v + (C2[k] - v) * t);
          }
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }
      const n = SS * SS, o = (j * size + i) * 4;
      const cov = a / n / 255;
      px[o] = cov ? r / n / cov : 0;
      px[o + 1] = cov ? g / n / cov : 0;
      px[o + 2] = cov ? b / n / cov : 0;
      px[o + 3] = a / n;
    }
  }
  return png(size, size, px);
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync(new URL('icon.svg', OUT), svg());
writeFileSync(new URL('icon-192.png', OUT), render(192, { scale: 0.86, rounded: true }));
writeFileSync(new URL('icon-512.png', OUT), render(512, { scale: 0.86, rounded: true }));
// Maskable: full-bleed background, artwork inside the 80% safe zone.
writeFileSync(new URL('maskable-512.png', OUT), render(512, { scale: 0.62, rounded: false }));
// iOS rounds corners itself.
writeFileSync(new URL('apple-touch-icon.png', OUT), render(180, { scale: 0.78, rounded: false }));
console.log('icons written');
