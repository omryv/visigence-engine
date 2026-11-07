/* png.js — write a grayscale PNG with no canvas and no dependency.
 *
 * The masks this repo bakes (slope, curvature, AO, flow, deposition — see
 * engine/terrain/masks.js) exist "so a buyer can RE-AUTHOR the look", and
 * until now they were computed, packed into a GPU texture, and shipped
 * nowhere. Giving them to a person means a file, and the file format every
 * texture pipeline reads is PNG.
 *
 * The browser way is canvas.toBlob, which needs a document and answers with
 * whatever compression the browser felt like — different bytes per engine,
 * per version, per day. This tool's save path promises the same world twice
 * is the same bytes twice, and the export keeps that promise the same way:
 * pure arithmetic, deterministic output, testable under the suite.
 *
 * The zlib stream inside IDAT uses STORE blocks (BTYPE 00) — legal zlib that
 * every inflater reads, no Huffman coder to write or to get wrong. A 513²
 * 16-bit heightmap is ~530 KB instead of ~300 KB compressed; for maps this
 * size, correctness-by-simplicity is the better trade, and the zip around
 * the bundle is store-only for the same reason (tools/lib/png.mjs is the
 * mirror image: sixty lines to READ one, on the same argument).
 *
 * 8-bit for the masks, 16-bit for the heightmap — 8 bits over a 420 m range
 * is 1.6 m steps, visible terracing on any slope; 16 bits is 6 mm.
 */

// ── CRC-32 (PNG chunks) and Adler-32 (zlib trailer) ─────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0xffffffff) {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/* zlib wrapper around store-only deflate: 2-byte header, then blocks of at
   most 65535 literal bytes each, then the Adler-32 of the raw stream. */
export function zlibStore(raw) {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78; out[1] = 0x01;       // 32K window, fastest — honest for store
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const start = i * 65535;
    const len = Math.min(65535, raw.length - start);
    out[o++] = i === blocks - 1 ? 1 : 0;              // BFINAL, BTYPE 00
    out[o++] = len & 0xff; out[o++] = len >> 8;
    out[o++] = ~len & 0xff; out[o++] = (~len >> 8) & 0xff;
    out.set(raw.subarray(start, start + len), o);
    o += len;
  }
  const ad = adler32(raw);
  out[o++] = ad >>> 24; out[o++] = (ad >>> 16) & 0xff; out[o++] = (ad >>> 8) & 0xff; out[o++] = ad & 0xff;
  return out;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const body = out.subarray(4, 8 + data.length);
  dv.setUint32(8 + data.length, crc32(body));
  return out;
}

/**
 * Grayscale PNG. `depth` 8 takes a Uint8Array of width×height; depth 16
 * takes a Uint16Array (written big-endian, as PNG requires). Returns the
 * complete file as a Uint8Array.
 */
export function encodeGrayPng({ width, height, depth = 8, data }) {
  if (data.length !== width * height) throw new Error(`encodeGrayPng: ${data.length} samples for ${width}×${height}`);
  const bytesPerPixel = depth / 8;
  const stride = width * bytesPerPixel;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0;                                     // filter: none
    if (depth === 8) {
      raw.set(data.subarray(y * width, (y + 1) * width), row + 1);
    } else {
      for (let x = 0; x < width; x++) {
        const v = data[y * width + x];
        raw[row + 1 + x * 2] = v >> 8;
        raw[row + 2 + x * 2] = v & 0xff;
      }
    }
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = depth; ihdr[9] = 0;                       // colour type 0: grayscale
  // ihdr[10..12]: compression 0, filter 0, interlace 0

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", zlibStore(raw)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
