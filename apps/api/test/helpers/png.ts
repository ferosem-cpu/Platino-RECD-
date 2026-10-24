// Builds small, valid PNG files for the signature tests (what a browser canvas would send): 8-bit RGBA, not
// interlaced. No image library needed - zlib plus a CRC-32.
import { deflateSync } from "zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export interface PngOptions {
  width?: number;
  height?: number;
  /** Draw a diagonal "stroke" (opaque dark pixels). false = a fully transparent canvas. */
  ink?: boolean;
  colourType?: number;
  /** Replace the compressed pixel data with this raw (uncompressed) payload, e.g. to build an oversized stream. */
  rawOverride?: Buffer;
}

export function makePng(o: PngOptions = {}): Buffer {
  const width = o.width ?? 300;
  const height = o.height ?? 120;
  const colourType = o.colourType ?? 6;
  const bpp = colourType === 6 ? 4 : 3;
  const rowBytes = width * bpp + 1;
  const raw = Buffer.alloc(rowBytes * height); // filter byte 0 (None) + zeroed pixels = transparent
  if (o.ink !== false) {
    for (let y = 10; y < height - 10; y++) {
      const x = Math.floor(((y - 10) / (height - 20)) * (width - 40)) + 10;
      for (let dx = 0; dx < 4; dx++) {
        const i = y * rowBytes + 1 + (x + dx) * bpp;
        raw[i] = 20; raw[i + 1] = 20; raw[i + 2] = 60;
        if (bpp === 4) raw[i + 3] = 255;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colourType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(o.rawOverride ?? raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const pngDataUrl = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`;
