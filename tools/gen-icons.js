#!/usr/bin/env node
/**
 * Zero-dependency PNG icon generator for the Claude Code VSD plugin.
 * Draws 144x144 RGBA tiles with simple vector-ish glyphs and writes them
 * into ../com.sandeep.claudecode.sdPlugin/static/.
 *
 * PNGs are only used for the action-picker list inside VSD Craft. The live
 * on-device key images are rendered at runtime as SVG by plugin/index.js.
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIZE = 144;
const OUT = path.join(__dirname, '..', 'com.sandeep.claudecode.sdPlugin', 'static');
fs.mkdirSync(OUT, { recursive: true });

// ---- tiny RGBA canvas ----------------------------------------------------
function canvas(w, h) {
  return { w, h, px: new Uint8Array(w * h * 4) };
}
function set(c, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  // simple alpha-over compositing
  const ia = a / 255, na = 1 - ia;
  c.px[i] = r * ia + c.px[i] * na;
  c.px[i + 1] = g * ia + c.px[i + 1] * na;
  c.px[i + 2] = b * ia + c.px[i + 2] * na;
  c.px[i + 3] = Math.max(c.px[i + 3], a);
}
function fillRoundRect(c, x, y, w, h, rad, col) {
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const dx = Math.min(xx, w - 1 - xx);
      const dy = Math.min(yy, h - 1 - yy);
      if (dx < rad && dy < rad) {
        const ddx = rad - dx, ddy = rad - dy;
        if (ddx * ddx + ddy * ddy > rad * rad) continue;
      }
      set(c, x + xx, y + yy, col[0], col[1], col[2], col[3] ?? 255);
    }
  }
}
function fillRect(c, x, y, w, h, col) {
  for (let yy = 0; yy < h; yy++)
    for (let xx = 0; xx < w; xx++)
      set(c, x + xx, y + yy, col[0], col[1], col[2], col[3] ?? 255);
}
function ring(c, cx, cy, rOut, rIn, col) {
  for (let y = -rOut; y <= rOut; y++)
    for (let x = -rOut; x <= rOut; x++) {
      const d = Math.sqrt(x * x + y * y);
      if (d <= rOut && d >= rIn) set(c, cx + x, cy + y, col[0], col[1], col[2], col[3] ?? 255);
    }
}
function disc(c, cx, cy, r, col) { ring(c, cx, cy, r, 0, col); }
// filled triangle via barycentric scan
function tri(c, ax, ay, bx, by, cx2, cy2, col) {
  const minX = Math.floor(Math.min(ax, bx, cx2)), maxX = Math.ceil(Math.max(ax, bx, cx2));
  const minY = Math.floor(Math.min(ay, by, cy2)), maxY = Math.ceil(Math.max(ay, by, cy2));
  const area = (bx - ax) * (cy2 - ay) - (cx2 - ax) * (by - ay);
  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) {
      const w0 = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / area;
      const w1 = ((cx2 - bx) * (y - by) - (cy2 - by) * (x - bx)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) set(c, x, y, col[0], col[1], col[2], col[3] ?? 255);
    }
}

// ---- PNG encode ----------------------------------------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(c) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.w, 0); ihdr.writeUInt32BE(c.h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((c.w * 4 + 1) * c.h);
  for (let y = 0; y < c.h; y++) {
    raw[y * (c.w * 4 + 1)] = 0; // filter none
    c.px.subarray(y * c.w * 4, (y + 1) * c.w * 4)
      .forEach((v, i) => { raw[y * (c.w * 4 + 1) + 1 + i] = v; });
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- glyph helpers -------------------------------------------------------
const BG = [24, 24, 27, 255];            // zinc-900 tile
function base(accent) {
  const c = canvas(SIZE, SIZE);
  fillRoundRect(c, 4, 4, SIZE - 8, SIZE - 8, 28, BG);
  fillRoundRect(c, 4, 4, SIZE - 8, 8, 6, accent);       // top accent bar
  return c;
}
// chevron ">" made of two thick strokes
function chevron(c, cx, cy, s, col) {
  for (let t = -s; t <= s; t++) {
    for (let w = 0; w < 12; w++) {
      set(c, cx - 2 + Math.abs(t) * 0 + (t < 0 ? -t : t) - 0 + 0, 0, 0, 0, 0); // noop guard
    }
  }
  // draw as two rotated bars using triangles
  tri(c, cx - s, cy - s, cx - s + 14, cy - s, cx + 4, cy, col);
  tri(c, cx - s, cy - s, cx + 4, cy, cx - s + 14, cy, col);
  tri(c, cx - s, cy + s, cx - s + 14, cy + s, cx + 4, cy, col);
  tri(c, cx - s, cy + s, cx + 4, cy, cx - s + 14, cy, col);
}

const ACCENTS = {
  command: [217, 119, 87],   // claude terracotta
  key: [120, 170, 255],
  tab: [130, 200, 140],
  dial: [200, 150, 240],
  icon: [217, 119, 87],
};

// command: terminal prompt ">_"
function drawCommand() {
  const c = base(ACCENTS.command), col = [240, 240, 240, 255];
  chevron(c, 44, 66, 22, col);
  fillRect(c, 60, 92, 44, 12, col); // underscore
  return c;
}
// key: a keycap with a return-arrow
function drawKey() {
  const c = base(ACCENTS.key), col = [240, 240, 240, 255];
  fillRoundRect(c, 34, 40, 76, 64, 12, [55, 60, 72, 255]);
  fillRoundRect(c, 40, 46, 64, 52, 9, [82, 92, 110, 255]);
  // return arrow ⏎
  fillRect(c, 86, 56, 10, 26, col);
  fillRect(c, 50, 76, 46, 10, col);
  tri(c, 50, 81, 66, 70, 66, 92, col);
  return c;
}
// tab: two arrows / overlapping tabs
function drawTab() {
  const c = base(ACCENTS.tab), col = [240, 240, 240, 255];
  fillRoundRect(c, 30, 50, 50, 40, 8, [70, 110, 80, 255]);
  fillRoundRect(c, 64, 62, 50, 40, 8, [120, 200, 140, 255]);
  // right arrow
  fillRect(c, 78, 78, 18, 8, [24, 24, 27, 255]);
  tri(c, 94, 74, 106, 82, 94, 90, [24, 24, 27, 255]);
  return c;
}
// dial: a knob ring with indicator
function drawDial() {
  const c = base(ACCENTS.dial), col = [240, 240, 240, 255];
  ring(c, 72, 76, 38, 28, [200, 150, 240, 255]);
  disc(c, 72, 76, 22, [60, 50, 72, 255]);
  fillRect(c, 70, 44, 6, 18, col); // indicator notch at top
  return c;
}
// plugin icon: prompt in a rounded chat-ish bubble
function drawIcon() {
  const c = base(ACCENTS.icon), col = [245, 245, 245, 255];
  chevron(c, 46, 70, 24, col);
  fillRect(c, 64, 98, 48, 12, col);
  return c;
}

const jobs = {
  'icon.png': drawIcon,
  'command.png': drawCommand,
  'key.png': drawKey,
  'tab.png': drawTab,
  'dial.png': drawDial,
};
for (const [name, fn] of Object.entries(jobs)) {
  fs.writeFileSync(path.join(OUT, name), encodePNG(fn()));
  console.log('wrote', name);
}
console.log('icons ->', OUT);
