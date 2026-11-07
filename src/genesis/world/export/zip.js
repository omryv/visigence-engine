/* zip.js — one download instead of eight.
 *
 * The export is a GLB, a heightmap and up to six masks, and a browser that
 * fires eight programmatic downloads from one click is a browser showing
 * eight permission bars. A zip is the ordinary answer, and a STORE-ONLY zip
 * is fifty lines: local header + bytes per file, central directory, end
 * record. No compression — the PNGs are already the size they are, the GLB
 * is float data that deflate barely touches, and store keeps the writer
 * trivially correct and byte-deterministic.
 *
 * Timestamps are 0 (1980-01-01 in DOS time, the format's own epoch), for the
 * same reason worldfile.js threads `bakedAt` instead of reading the clock:
 * exporting the same world twice must produce the same bytes, so the second
 * file overwrites the first instead of littering a Downloads folder.
 *
 * Pure JS, no DOM. tests/export.test.js walks the directory back out.
 */

import { crc32 } from "./png.js";

const te = new TextEncoder();

/** `files` is [{ name, bytes: Uint8Array }, …]. Returns the zip as a Uint8Array. */
export function encodeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;

  for (const f of files) {
    const name = te.encode(f.name);
    const crc = crc32(f.bytes);
    const local = new Uint8Array(30 + name.length + f.bytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);      // local file header
    dv.setUint16(4, 20, true);              // version needed: 2.0
    dv.setUint16(6, 0, true);               // flags
    dv.setUint16(8, 0, true);               // method: store
    dv.setUint32(10, 0, true);              // DOS time+date: the epoch
    dv.setUint32(14, crc, true);
    dv.setUint32(18, f.bytes.length, true); // compressed == uncompressed
    dv.setUint32(22, f.bytes.length, true);
    dv.setUint16(26, name.length, true);
    dv.setUint16(28, 0, true);              // extra length
    local.set(name, 30);
    local.set(f.bytes, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);      // central directory header
    cv.setUint16(4, 20, true);              // made by
    cv.setUint16(6, 20, true);              // needed
    cv.setUint16(10, 0, true);              // store
    cv.setUint32(12, 0, true);              // time+date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.bytes.length, true);
    cv.setUint32(24, f.bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);         // local header offset
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }

  const dirSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);      // entries on this disk
  ev.setUint16(10, files.length, true);     // entries total
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);           // directory offset

  const out = new Uint8Array(offset + dirSize + 22);
  let o = 0;
  for (const p of [...locals, ...centrals, eocd]) { out.set(p, o); o += p.length; }
  return out;
}
