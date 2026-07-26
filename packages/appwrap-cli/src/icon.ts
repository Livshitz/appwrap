/**
 * Dependency-free PNG codec + macOS app-icon corner rounding, in pure TS on `node:zlib`.
 *
 * WHY: a desktop shell can embed an icon PNG and set it as the RUNTIME app icon on macOS — which
 * OVERRIDES the bundle icns/Assets.car in cmd+tab/Dock. A template placeholder would then show while
 * the app runs, so we stamp the app's real icon in instead: downscale (sips, in the CLI) → decode here
 * → round the corners with the macOS app-icon squircle mask → ensure RGBA (alpha is required) → re-encode.
 *
 * Supports 8-bit RGB / RGBA, non-interlaced PNG (what `sips` emits). Errors clearly on anything else.
 */
import { deflateSync, inflateSync } from 'zlib';

/** Apple's app-icon corner radius as a fraction of the icon side (the "squircle" bounding ratio).
 * A plain rounded-rect at this radius is a close-enough approximation of the true superellipse. */
export const APPLE_CORNER_RATIO = 0.2237;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface RgbaImage {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes/pixel, length = width*height*4. */
  data: Buffer;
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
};

/** Decode an 8-bit, non-interlaced RGB/RGBA PNG into a normalized RGBA image. RGB input gets an
 * opaque (255) alpha channel added. Throws on unsupported PNGs (paletted, 16-bit, interlaced, …). */
export function decodePng(buf: Buffer): RgbaImage {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG (bad signature)');

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const idat: Buffer[] = [];

  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    const data = buf.subarray(dataStart, dataStart + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth} (only 8-bit)`);
      if (colorType !== 2 && colorType !== 6)
        throw new Error(`unsupported PNG color type ${colorType} (only RGB=2 / RGBA=6)`);
      if (interlace !== 0) throw new Error('unsupported interlaced PNG');
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off = dataStart + len + 4; // +4 CRC
  }
  if (!width || !height) throw new Error('PNG missing IHDR');

  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('PNG IDAT truncated');

  // Unfilter scanlines (filter types 0-4) in place into a channels-packed buffer.
  const unf = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const inRow = y * (stride + 1) + 1;
    const outRow = y * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[inRow + x];
      const a = x >= channels ? unf[outRow + x - channels] : 0; // left
      const b = y > 0 ? unf[outRow - stride + x] : 0; // up
      const c = x >= channels && y > 0 ? unf[outRow - stride + x - channels] : 0; // up-left
      let val: number;
      switch (filter) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + a; break;
        case 2: val = rawByte + b; break;
        case 3: val = rawByte + ((a + b) >> 1); break;
        case 4: val = rawByte + paeth(a, b, c); break;
        default: throw new Error(`unsupported PNG filter type ${filter}`);
      }
      unf[outRow + x] = val & 0xff;
    }
  }

  // Normalize to RGBA.
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++) {
    data[j++] = unf[i * channels];
    data[j++] = unf[i * channels + 1];
    data[j++] = unf[i * channels + 2];
    data[j++] = channels === 4 ? unf[i * channels + 3] : 255;
  }
  return { width, height, data };
}

/** Encode a normalized RGBA image to a PNG (color type 6, 8-bit, filter type 0, zlib deflate). */
export function encodePng(img: RgbaImage): Buffer {
  const { width, height, data } = img;
  const stride = width * 4;
  const rawFiltered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rawFiltered[y * (stride + 1)] = 0; // filter type 0 (None)
    data.copy(rawFiltered, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(rawFiltered);

  const chunk = (type: string, body: Buffer): Buffer => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'ascii');
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** Multiply the alpha channel by a rounded-rect mask (radius = ratio*side) so corners become
 * transparent — the macOS app-icon shape. Mutates + returns the image. */
export function roundCorners(img: RgbaImage, ratio: number = APPLE_CORNER_RATIO): RgbaImage {
  const { width, height, data } = img;
  const r = Math.min(width, height) * ratio;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Distance into the nearest corner's radius square; only corners are clipped.
      const dx = x < r ? r - (x + 0.5) : x + 0.5 > width - r ? x + 0.5 - (width - r) : 0;
      const dy = y < r ? r - (y + 0.5) : y + 0.5 > height - r ? y + 0.5 - (height - r) : 0;
      if (dx > 0 && dy > 0) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        // 1px anti-aliased edge: coverage 1 inside the radius, 0 outside, linear across the boundary.
        const coverage = Math.max(0, Math.min(1, r - dist + 0.5));
        const idx = (y * width + x) * 4 + 3;
        data[idx] = Math.round(data[idx] * coverage);
      }
    }
  }
  return img;
}

/** Center the image on a larger transparent canvas (no resampling — callers pre-size via sips).
 * macOS app icons bake in a transparent margin: the squircle artwork is 824px on a 1024 canvas
 * (~80.5%). A full-bleed runtime icon renders visibly LARGER than its bundle-masked Dock neighbors. */
export function padToCanvas(img: RgbaImage, canvas: number): RgbaImage {
  const { width, height, data } = img;
  const ox = Math.floor((canvas - width) / 2);
  const oy = Math.floor((canvas - height) / 2);
  const out = Buffer.alloc(canvas * canvas * 4);
  for (let y = 0; y < height; y++) {
    out.set(data.subarray(y * width * 4, (y + 1) * width * 4), ((y + oy) * canvas + ox) * 4);
  }
  return { width: canvas, height: canvas, data: out };
}

/** Artwork fraction of the icon canvas per Apple's Big Sur+ app-icon grid (824/1024). */
export const APPLE_ICON_GRID_SCALE = 824 / 1024;

/** Convenience: decode a (sips-produced) PNG, round its corners, guarantee RGBA, re-encode. */
export function makeRoundedRgbaIcon(pngBuf: Buffer, ratio: number = APPLE_CORNER_RATIO): Buffer {
  return encodePng(roundCorners(decodePng(pngBuf), ratio));
}

/** Dock-parity runtime icon: rounded artwork centered on a transparent `canvas`² px canvas at the
 * Apple icon-grid scale. Input PNG should already be sized to `canvas * APPLE_ICON_GRID_SCALE`. */
export function makeDockRuntimeIcon(pngBuf: Buffer, canvas: number): Buffer {
  return encodePng(padToCanvas(roundCorners(decodePng(pngBuf)), canvas));
}

// ─── CRC32 (PNG/zlib polynomial) ───
let CRC_TABLE: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
