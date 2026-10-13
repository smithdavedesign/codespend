// The 1200×630 share image (og:image / twitter:image), drawn with code at build time: a 5×7 pixel font, filled
// rectangles and a minimal PNG encoder on node:zlib. No image is copied from anywhere and no package is needed.
import { deflateSync } from 'node:zlib';

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

// 5×7 glyphs, one string per row ('#' = dot). Only what the image needs: capitals, digits and a few symbols.
const FONT = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  $: ['..#..', '.####', '#.#..', '.###.', '..#.#', '####.', '..#..'],
  '%': ['##...', '##..#', '...#.', '..#..', '.#...', '#..##', '...##'],
  '/': ['.....', '....#', '...#.', '..#..', '.#...', '#....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '·': ['.....', '.....', '.###.', '.###.', '.###.', '.....', '.....'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const COLORS = {
  bg: '#0b1220', accent: '#1d4ed8', white: '#f8fafc', kicker: '#7dd3fc', text: '#cbd5e1', muted: '#94a3b8',
  track: '#1e293b', ok: '#22c55e', warn: '#f59e0b', over: '#ef4444',
};

function canvas(w, h, bg) {
  const px = Buffer.alloc(w * h * 3);
  const [r, g, b] = hex(bg);
  for (let i = 0; i < px.length; i += 3) { px[i] = r; px[i + 1] = g; px[i + 2] = b; }
  // Rounded corners: pixels outside the radius are skipped.
  const rect = (x, y, rw, rh, color, radius = 0) => {
    const [cr, cg, cb] = hex(color);
    for (let yy = Math.max(0, y); yy < Math.min(h, y + rh); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(w, x + rw); xx++) {
        if (radius) {
          const dx = Math.max(x + radius - xx - 0.5, xx + 0.5 - (x + rw - radius), 0);
          const dy = Math.max(y + radius - yy - 0.5, yy + 0.5 - (y + rh - radius), 0);
          if (dx * dx + dy * dy > radius * radius) continue;
        }
        const i = (yy * w + xx) * 3;
        px[i] = cr; px[i + 1] = cg; px[i + 2] = cb;
      }
    }
  };
  // Returns the x just after the text, so differently coloured runs can follow each other.
  const text = (str, x, y, scale, color) => {
    for (const ch of str) {
      const glyph = FONT[ch];
      if (!glyph) throw new Error(`og-image: no glyph for ${JSON.stringify(ch)}`);
      glyph.forEach((row, gy) => [...row].forEach((dot, gx) => { if (dot === '#') rect(x + gx * scale, y + gy * scale, scale, scale, color); }));
      x += 6 * scale;
    }
    return x;
  };
  return { px, rect, text };
}

const textWidth =(str, scale) => [...str].length * 6 * scale - scale;

// Budget bars: the track runs from 0% to 150% of the budget, so an overspend shows past the dashed 100% line.
const BARS = [['DOCS', 42, 'ok'], ['ACME/WEB', 81, 'warn'], ['PLATFORM', 138, 'over']];

export function ogImagePng() {
  const W = OG_WIDTH;
  const H = OG_HEIGHT;
  const c = canvas(W, H, COLORS.bg);
  c.rect(0, 0, W, 10, COLORS.accent);
  c.text('CLAUDE · OPENAI · COPILOT · CURSOR', 80, 64, 4, COLORS.kicker);
  c.text('CODESPEND', 80, 112, 14, COLORS.white);
  c.text('BUDGET ALERTS FOR AI CODING SPEND', 80, 240, 5, COLORS.text);

  const trackX = 300;
  const trackW = 700;
  const at = (pct) => trackX + Math.round((trackW * pct) / 150);
  BARS.forEach(([label, pct, tone], i) => {
    const y = 318 + i * 62;
    c.text(label, 80, y + 2, 4, COLORS.text);
    c.rect(trackX, y, trackW, 32, COLORS.track, 8);
    c.rect(trackX, y, at(pct) - trackX, 32, COLORS[tone], 8);
    c.text(`${pct}%`, 1024, y + 2, 4, tone === 'over' ? COLORS.over : COLORS.text);
  });
  const line = at(100);
  for (let y = 304; y < 318 + 2 * 62 + 46; y += 14) c.rect(line - 1, y, 3, 8, COLORS.white);
  const label = '100% OF BUDGET';
  c.text(label, line - Math.round(textWidth(label, 3) / 2), 512, 3, COLORS.muted);

  const x = c.text('$9/MONTH', 80, 566, 4, COLORS.white);
  c.text(' · ALERTS BY EMAIL AND SLACK', x, 566, 4, COLORS.muted);
  return encodePng(W, H, c.px);
}

// ---------- PNG (8-bit RGB, no interlace) ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function encodePng(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // bit depth 8, colour type 2 (RGB), deflate, no filter, no interlace
  const stride = w * 3;
  const raw = Buffer.alloc(h * (stride + 1)); // each row: filter byte 0, then the pixels
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
