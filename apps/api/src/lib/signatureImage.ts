/**
 * Server-side checks on a drawn signature sent as a PNG data URL. The browser/phone canvas produces an 8-bit RGBA,
 * non-interlaced PNG; anything else is refused. The checks are about safety and sanity (type, size, structure,
 * dimensions, "not an empty canvas") - they do not and cannot prove WHO drew it. Identity comes from the signer's
 * authenticated session (see routes/serviceReports.ts).
 */
import { inflateSync } from "zlib";
import { SERVICE_REPORT_LIMITS, SIGNATURE_DATA_URL_PREFIX } from "@recd/shared";

export type SignatureCheck = { ok: true; bytes: Buffer; width: number; height: number } | { ok: false; reason: string };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function checkSignatureDataUrl(dataUrl: unknown): SignatureCheck {
  const L = SERVICE_REPORT_LIMITS;
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(SIGNATURE_DATA_URL_PREFIX)) return { ok: false, reason: "The signature must be a PNG image." };
  const b64 = dataUrl.slice(SIGNATURE_DATA_URL_PREFIX.length);
  if (b64.length === 0 || b64.length % 4 !== 0 || !BASE64.test(b64)) return { ok: false, reason: "The signature image is not valid." };
  if (Math.floor((b64.length * 3) / 4) > L.SIGNATURE_MAX_BYTES + 2) return { ok: false, reason: "The signature image is too large." };
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length > L.SIGNATURE_MAX_BYTES) return { ok: false, reason: "The signature image is too large." };
  if (bytes.length < 40 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return { ok: false, reason: "The signature image is not a PNG." };

  let pos = 8;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  let sawIend = false;
  const idat: Buffer[] = [];
  while (pos + 12 <= bytes.length) {
    const len = bytes.readUInt32BE(pos);
    const type = bytes.toString("latin1", pos + 4, pos + 8);
    const dataStart = pos + 8;
    if (len > bytes.length || dataStart + len + 4 > bytes.length) return { ok: false, reason: "The signature image is damaged." };
    if (type === "IHDR") {
      if (len !== 13 || pos !== 8) return { ok: false, reason: "The signature image is damaged." };
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      const depth = bytes[dataStart + 8];
      const colour = bytes[dataStart + 9];
      const interlace = bytes[dataStart + 12];
      if (depth !== 8 || colour !== 6 || interlace !== 0) return { ok: false, reason: "The signature image format is not supported." };
      sawIhdr = true;
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(dataStart, dataStart + len));
    } else if (type === "IEND") {
      sawIend = true;
      break;
    }
    pos = dataStart + len + 4;
  }
  if (!sawIhdr || !sawIend || idat.length === 0) return { ok: false, reason: "The signature image is damaged." };
  if (width < L.SIGNATURE_MIN_DIMENSION || height < L.SIGNATURE_MIN_DIMENSION || width > L.SIGNATURE_MAX_DIMENSION || height > L.SIGNATURE_MAX_DIMENSION) {
    return { ok: false, reason: "The signature image has an unsupported size." };
  }

  // Inflate with a hard cap equal to the exact expected size (no decompression bombs), then look for any ink.
  const rowBytes = width * 4 + 1;
  const expected = rowBytes * height;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1024 });
  } catch {
    return { ok: false, reason: "The signature image is damaged." };
  }
  if (raw.length !== expected) return { ok: false, reason: "The signature image is damaged." };
  let ink = false;
  for (let row = 0; row < height && !ink; row++) {
    const start = row * rowBytes + 1; // skip the filter-type byte
    for (let i = start; i < start + width * 4; i++) {
      if (raw[i] !== 0) {
        ink = true;
        break;
      }
    }
  }
  if (!ink) return { ok: false, reason: "Please draw your signature before signing." };
  return { ok: true, bytes, width, height };
}
