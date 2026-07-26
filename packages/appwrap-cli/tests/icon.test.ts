import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'zlib';
import { decodePng, encodePng, makeRoundedRgbaIcon, roundCorners } from '../src/icon';

// ─── Minimal hand-rolled PNG encoders (independent of the module under test) ───
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}
/** Build a raw filter-type-0 PNG with `channels` (3=RGB, 4=RGBA). `fill(x,y)` returns the pixel bytes. */
function makePng(width: number, height: number, channels: 3 | 4, fill: (x: number, y: number) => number[]): Buffer {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const px = fill(x, y);
      for (let c = 0; c < channels; c++) raw[y * (stride + 1) + 1 + x * channels + c] = px[c];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const alphaAt = (img: { width: number; data: Buffer }, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];

describe('decodePng / encodePng', () => {
  test('RGBA decode→encode roundtrip is lossless', () => {
    const src = makePng(8, 6, 4, (x, y) => [x * 30, y * 40, 100, 200]);
    const decoded = decodePng(src);
    expect(decoded.width).toBe(8);
    expect(decoded.height).toBe(6);
    const round = decodePng(encodePng(decoded));
    expect(round.width).toBe(8);
    expect(round.height).toBe(6);
    expect(Buffer.compare(round.data, decoded.data)).toBe(0);
  });

  test('RGB input gets an opaque alpha channel added', () => {
    const src = makePng(4, 4, 3, () => [10, 20, 30]);
    const decoded = decodePng(src);
    expect(decoded.data.length).toBe(4 * 4 * 4); // RGBA
    for (let i = 0; i < 16; i++) expect(decoded.data[i * 4 + 3]).toBe(255);
    expect([decoded.data[0], decoded.data[1], decoded.data[2]]).toEqual([10, 20, 30]);
  });

  test('unsupported PNG errors clearly', () => {
    expect(() => decodePng(Buffer.from('not a png'))).toThrow(/signature/);
  });
});

describe('roundCorners — macOS app-icon mask', () => {
  test('corners become transparent, center stays opaque, dimensions preserved', () => {
    const img = decodePng(makePng(64, 64, 4, () => [255, 0, 0, 255]));
    roundCorners(img);
    expect(img.width).toBe(64);
    expect(img.height).toBe(64);
    expect(alphaAt(img, 0, 0)).toBe(0); // top-left corner clipped
    expect(alphaAt(img, 63, 0)).toBe(0);
    expect(alphaAt(img, 0, 63)).toBe(0);
    expect(alphaAt(img, 63, 63)).toBe(0);
    expect(alphaAt(img, 32, 32)).toBe(255); // center untouched
    expect(alphaAt(img, 32, 0)).toBe(255); // mid-edge untouched
  });

  test('makeRoundedRgbaIcon: RGB in → rounded RGBA PNG out, transparent corners survive re-decode', () => {
    const out = makeRoundedRgbaIcon(makePng(64, 64, 3, () => [0, 128, 255]));
    const decoded = decodePng(out);
    expect(decoded.width).toBe(64);
    expect(alphaAt(decoded, 0, 0)).toBe(0);
    expect(alphaAt(decoded, 32, 32)).toBe(255);
  });
});
