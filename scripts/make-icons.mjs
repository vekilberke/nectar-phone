// Draws the app icon (Nectar's notch, a black capsule, on a honey field) as PNG and SVG into public/.
// Run once after changing the design: node scripts/make-icons.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const HONEY = [240, 180, 60];
const NOTCH = [0, 0, 0];

// Shapes in a 0..1 square; the capsule stays inside the maskable safe zone (80% circle).
const capsule = { cx: 0.5, cy: 0.5, w: 0.62, h: 0.22 };

function sdCapsule(x, y) {
  const r = capsule.h / 2;
  const hx = capsule.w / 2 - r;
  const dx = Math.max(Math.abs(x - capsule.cx) - hx, 0);
  return Math.hypot(dx, y - capsule.cy) - r;
}

function pixel(x, y, px) {
  const aa = (d) => Math.min(1, Math.max(0, 0.5 - d / px));
  const t = aa(sdCapsule(x, y));
  return HONEY.map((v, i) => Math.round(v * (1 - t) + NOTCH[i] * t));
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel((x + 0.5) / size, (y + 0.5) / size, 1 / size);
      raw.set([r, g, b], y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const dir = new URL("../public/", import.meta.url);
for (const size of [192, 512]) writeFileSync(new URL(`icon-${size}.png`, dir), png(size));
const s = 100;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}"><rect width="${s}" height="${s}" fill="#f0b43c"/><rect x="${(capsule.cx - capsule.w / 2) * s}" y="${(capsule.cy - capsule.h / 2) * s}" width="${capsule.w * s}" height="${capsule.h * s}" rx="${(capsule.h / 2) * s}" fill="#000"/></svg>\n`;
writeFileSync(new URL("icon.svg", dir), svg);
console.log("icons written");
