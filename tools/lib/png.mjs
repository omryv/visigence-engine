// PNG in, PNG out — on Node's own zlib, because the engine has no dependencies
// and the benchmark should not be the thing that introduces one.
//
// Decoder: 8-bit and 16-bit, greyscale / RGB / palette / grey+alpha / RGBA,
// non-interlaced (Adam7 is refused with a clear error rather than mis-read).
// Every output is RGBA 8-bit, straight (not premultiplied) alpha, row-major,
// which is what `reconstruct` consumes.
//
// Encoder: RGBA 8-bit, filter 0 on every row, one IDAT. Used for the renders
// the benchmark writes so a reader can look at what was measured.

import zlib from 'node:zlib';

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

let CRC_T = null;
function crc32(buf, start = 0, end = buf.length) {
  if (!CRC_T) {
    CRC_T = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; }
  }
  let crc = -1;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ CRC_T[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

/**
 * @param {Uint8Array|Buffer} bytes
 * @returns {{w:number, h:number, px:Uint8ClampedArray, colorType:number, bitDepth:number, hasAlpha:boolean}}
 */
export function decodePNG(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) throw new Error('not a PNG (bad signature)');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  let sawIHDR = false, sawIEND = false;
  while (p + 8 <= b.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(b[p+4], b[p+5], b[p+6], b[p+7]);
    const start = p + 8, end = start + len;
    if (end + 4 > b.length) throw new Error(`PNG chunk ${type} runs past the end of the file`);
    const crc = dv.getUint32(end);
    if (crc !== crc32(b, p + 4, end)) throw new Error(`PNG chunk ${type} has a bad CRC`);
    if (type === 'IHDR') {
      w = dv.getUint32(start); h = dv.getUint32(start + 4);
      bitDepth = b[start + 8]; colorType = b[start + 9]; interlace = b[start + 12];
      if (b[start + 10] !== 0) throw new Error('PNG uses an unknown compression method');
      if (b[start + 11] !== 0) throw new Error('PNG uses an unknown filter method');
      if (interlace !== 0) throw new Error('interlaced (Adam7) PNG is not supported by this decoder');
      sawIHDR = true;
    } else if (type === 'PLTE') {
      palette = b.subarray(start, end);
    } else if (type === 'tRNS') {
      trns = b.subarray(start, end);
    } else if (type === 'IDAT') {
      idat.push(b.subarray(start, end));
    } else if (type === 'IEND') { sawIEND = true; break; }
    p = end + 4;
  }
  if (!sawIHDR) throw new Error('PNG has no IHDR');
  if (!sawIEND) throw new Error('PNG has no IEND');
  if (!idat.length) throw new Error('PNG has no image data');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`PNG colour type ${colorType} is not valid`);
  if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error(`PNG bit depth ${bitDepth} is not valid`);
  if (colorType !== 0 && colorType !== 3 && bitDepth < 8) throw new Error(`PNG bit depth ${bitDepth} is not valid for colour type ${colorType}`);
  const total = idat.reduce((s, c) => s + c.length, 0);
  const z = new Uint8Array(total);
  { let o = 0; for (const c of idat) { z.set(c, o); o += c.length; } }
  const raw = zlib.inflateSync(z);
  const bpp = Math.max(1, (channels * bitDepth) >> 3);           // bytes per complete pixel, for filtering
  const stride = Math.ceil(w * channels * bitDepth / 8);
  if (raw.length < h * (stride + 1)) throw new Error(`PNG image data is short: ${raw.length} bytes for ${h} rows of ${stride + 1}`);

  // unfilter in place
  const out = new Uint8Array(h * stride);
  let prev = null;
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    switch (ft) {
      case 0: row.set(src); break;
      case 1: for (let i = 0; i < stride; i++) row[i] = (src[i] + (i >= bpp ? row[i - bpp] : 0)) & 255; break;
      case 2: for (let i = 0; i < stride; i++) row[i] = (src[i] + (prev ? prev[i] : 0)) & 255; break;
      case 3: for (let i = 0; i < stride; i++) row[i] = (src[i] + (((i >= bpp ? row[i - bpp] : 0) + (prev ? prev[i] : 0)) >> 1)) & 255; break;
      case 4: for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp] : 0, bb = prev ? prev[i] : 0, c = (prev && i >= bpp) ? prev[i - bpp] : 0;
        const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c);
        row[i] = (src[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c)) & 255;
      } break;
      default: throw new Error(`PNG row ${y} uses an unknown filter type ${ft}`);
    }
    prev = row;
  }

  // to RGBA8
  const px = new Uint8ClampedArray(w * h * 4);
  const sample = (row, x, ch) => {
    // value of channel `ch` of pixel x in `row`, scaled to 8 bits
    if (bitDepth === 8) return row[x * channels + ch];
    if (bitDepth === 16) return row[(x * channels + ch) * 2];      // high byte: a truncation, not a rounding
    const idx = x * channels + ch, bit = idx * bitDepth, byte = row[bit >> 3];
    const shift = 8 - bitDepth - (bit & 7);
    return (byte >> shift) & ((1 << bitDepth) - 1);
  };
  const maxSub = (1 << bitDepth) - 1;
  for (let y = 0; y < h; y++) {
    const row = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (colorType === 3) {
        const i = sample(row, x, 0);
        if (!palette || i * 3 + 2 >= palette.length) throw new Error('PNG palette index out of range');
        px[o] = palette[i*3]; px[o+1] = palette[i*3+1]; px[o+2] = palette[i*3+2];
        px[o+3] = trns && i < trns.length ? trns[i] : 255;
      } else if (colorType === 0 || colorType === 4) {
        let g = sample(row, x, 0);
        if (bitDepth < 8) g = Math.round(g * 255 / maxSub);
        px[o] = g; px[o+1] = g; px[o+2] = g;
        px[o+3] = colorType === 4 ? sample(row, x, 1) : 255;
      } else {
        px[o] = sample(row, x, 0); px[o+1] = sample(row, x, 1); px[o+2] = sample(row, x, 2);
        px[o+3] = colorType === 6 ? sample(row, x, 3) : 255;
      }
    }
  }
  return { w, h, px, colorType, bitDepth, hasAlpha: colorType === 4 || colorType === 6 || (colorType === 3 && !!trns) };
}

/** RGBA8 → PNG bytes. */
export function encodePNG(px, w, h) {
  if (px.length !== w * h * 4) throw new Error(`encodePNG: ${px.length} bytes is not ${w}×${h}×4`);
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(px.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const z = zlib.deflateSync(raw, { level: 6 });
  const chunk = (type, data) => {
    const c = new Uint8Array(12 + data.length);
    const dv = new DataView(c.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
    c.set(data, 8);
    dv.setUint32(8 + data.length, crc32(c, 4, 8 + data.length));
    return c;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, w); new DataView(ihdr.buffer).setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [new Uint8Array(SIG), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const outb = new Uint8Array(total);
  let o = 0; for (const p of parts) { outb.set(p, o); o += p.length; }
  return outb;
}

/**
 * Area-averaged reduction of an RGBA image to `dw`×`dh`. The colour is
 * averaged premultiplied by alpha and un-premultiplied afterwards, so a
 * boundary pixel's colour is the subject's and not a blend with whatever
 * the transparent background happened to be; alpha is a plain average and
 * so is a genuine fractional coverage, which is what the segmentation's
 * sub-pixel boundary reads.
 */
export function downscaleRGBA(px, w, h, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const sx = w / dw, sy = h / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = y * sy, y1 = (y + 1) * sy;
    for (let x = 0; x < dw; x++) {
      const x0 = x * sx, x1 = (x + 1) * sx;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.min(h, Math.ceil(y1)); yy++) {
        const fy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        if (fy <= 0) continue;
        for (let xx = Math.floor(x0); xx < Math.min(w, Math.ceil(x1)); xx++) {
          const fx = Math.min(x1, xx + 1) - Math.max(x0, xx);
          if (fx <= 0) continue;
          const wgt = fx * fy, o = (yy * w + xx) * 4, al = px[o+3] / 255;
          r += px[o] * al * wgt; g += px[o+1] * al * wgt; b += px[o+2] * al * wgt; a += al * wgt; wsum += wgt;
        }
      }
      const o = (y * dw + x) * 4;
      if (a > 0) { out[o] = r / a; out[o+1] = g / a; out[o+2] = b / a; } else { out[o] = 0; out[o+1] = 0; out[o+2] = 0; }
      out[o+3] = wsum > 0 ? (a / wsum) * 255 : 0;
    }
  }
  return out;
}
