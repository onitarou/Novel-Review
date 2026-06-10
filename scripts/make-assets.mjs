import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const width = 1200;
const height = 760;
const pixels = Buffer.alloc(width * height * 4);

for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const grain = noise(x, y) * 8;
    setPixel(x, y, 126 + grain, 112 + grain, 96 + grain, 255);
  }
}

drawRect(80, 110, 690, 480, [238, 226, 205, 255]);
drawRect(118, 148, 610, 12, [164, 136, 104, 255]);
drawRect(118, 205, 560, 10, [164, 136, 104, 255]);
drawRect(118, 262, 590, 10, [164, 136, 104, 255]);
drawRect(118, 319, 520, 10, [164, 136, 104, 255]);
drawRect(118, 376, 600, 10, [164, 136, 104, 255]);
drawRect(118, 433, 490, 10, [164, 136, 104, 255]);

drawRect(820, 160, 170, 470, [38, 36, 32, 255]);
drawRect(855, 205, 36, 330, [198, 151, 64, 255]);
drawRect(918, 205, 36, 260, [215, 194, 154, 255]);

drawRotatedPen(650, 548);
drawRect(760, 84, 210, 96, [225, 213, 168, 255]);
drawRect(790, 114, 150, 8, [130, 116, 91, 255]);
drawRect(790, 140, 125, 8, [130, 116, 91, 255]);

drawRect(190, 620, 430, 42, [28, 108, 99, 255]);
drawRect(214, 634, 280, 8, [235, 240, 232, 255]);

const png = encodePng(width, height, pixels);
writeFileSync("public/login-bg.png", png);
console.log("wrote public/login-bg.png");

function setPixel(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const i = (y * width + x) * 4;
  pixels[i] = clamp(r);
  pixels[i + 1] = clamp(g);
  pixels[i + 2] = clamp(b);
  pixels[i + 3] = clamp(a);
}

function drawRect(x, y, w, h, color) {
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      const edge = xx === x || yy === y || xx === x + w - 1 || yy === y + h - 1;
      const shadow = edge ? -18 : 0;
      setPixel(xx, yy, color[0] + shadow, color[1] + shadow, color[2] + shadow, color[3]);
    }
  }
}

function drawRotatedPen(cx, cy) {
  for (let t = -160; t <= 160; t += 1) {
    for (let w = -7; w <= 7; w += 1) {
      const x = Math.round(cx + t * 0.92 - w * 0.38);
      const y = Math.round(cy + t * 0.38 + w * 0.92);
      setPixel(x, y, 31, 36, 39, 255);
    }
  }
  drawRect(cx + 132, cy + 44, 42, 20, [195, 145, 58, 255]);
}

function noise(x, y) {
  let n = x * 374761393 + y * 668265263;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) & 255) / 255;
}

function encodePng(w, h, rgba) {
  const rows = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const rowStart = y * (w * 4 + 1);
    rows[rowStart] = 0;
    rgba.copy(rows, rowStart + 1, y * w * 4, (y + 1) * w * 4);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", Buffer.concat([
      u32(w),
      u32(h),
      Buffer.from([8, 6, 0, 0, 0])
    ])),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  return Buffer.concat([
    u32(data.length),
    typeBuffer,
    data,
    u32(crc32(Buffer.concat([typeBuffer, data])))
  ]);
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function clamp(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}
