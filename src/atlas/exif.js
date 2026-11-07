/* Atlas — EXIF focal length.
 *
 * The reconstruction needs one number from the camera: how many pixels of the
 * image plane subtend one radian. Everything else about the lens is decoration.
 *
 * This file exists because the previous version invented that number. It read
 *
 *     mm = 35 + (1 − bboxWidth/imageWidth) * 40
 *
 * which is an affine map from FRAMING to focal length with no optical content
 * whatsoever, printed as "estimated lens 52mm (CI 38–66mm)" — and the interval
 * was `6 + bgVar*40`, which is not a coverage interval, a credible interval, or
 * any other kind of interval. It then drove the perspective taper, so a
 * fabricated quantity was bending the geometry.
 *
 * A photograph either carries its focal length or it does not. When it does not,
 * the honest reconstruction is orthographic, and the app says so.
 *
 * What is returned is `fRel = f_px / max(W, H)`: the focal length in pixels,
 * divided by the long side. That is invariant to resampling — which matters,
 * because the pipeline reconstructs on a 280px grid and the photograph is not
 * 280px — and it is dimensionless, so no 36mm constant has to travel with it.
 * For a 35mm frame the long side IS 36mm, so mm35 = fRel * 36 exactly, and that
 * is the only place the number 36 appears.
 *
 * No DOM, no dependencies: it takes an ArrayBuffer and returns a plain object,
 * so it is testable headlessly like the rest of the core.
 */

/* ------------------------------------------------------------------- tags */

const TAG_EXIF_IFD      = 0x8769;
const TAG_FOCAL_LENGTH  = 0x920a;   // RATIONAL, mm
const TAG_FOCAL_35MM    = 0xa405;   // SHORT, mm, already 35mm-equivalent
const TAG_FP_X_RES      = 0xa20e;   // RATIONAL, pixels per FP_RES_UNIT
const TAG_FP_RES_UNIT   = 0xa210;   // SHORT: 1 none, 2 inch, 3 cm, 4 mm, 5 um
const TAG_PIXEL_X       = 0xa002;   // SHORT|LONG, sensor pixels across
const TAG_PIXEL_Y       = 0xa003;

const MM_PER_UNIT = { 2: 25.4, 3: 10, 4: 1, 5: 0.001 };

// Byte width per TIFF type code. 0 marks a type this reader will not follow.
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 0, 1, 2, 4, 8, 4, 8];

// A malformed IFD can claim any entry count it likes. Real ones are small.
const MAX_ENTRIES = 512;

/* -------------------------------------------------------------- plausibility
 *
 * These bounds reject garbage, not unusual lenses. fRel = 0.35 is a 12.6mm
 * ultra-wide (about 122° across the frame) and fRel = 30 is a 1080mm
 * super-telephoto; a phone is 1.1–2.2 and a 50mm normal lens is 1.39. Anything
 * outside is a misparse, not a photograph.
 */
const F_REL_MIN = 0.35;
const F_REL_MAX = 30;

// A crop changes the field of view without changing any EXIF field, so a
// declared focal length no longer describes the file. Aspect ratio is the only
// evidence of that available here, and it only catches non-uniform crops — a
// centred crop that preserves aspect is undetectable and will read as a longer
// lens than the file actually has. Stated in the return value, not hidden.
const ASPECT_TOLERANCE = 0.02;

/* ------------------------------------------------------------- byte access */

function reader(view, base, little) {
  const end = view.byteLength;
  return {
    u16: (o) => (base + o + 2 <= end ? view.getUint16(base + o, little) : null),
    u32: (o) => (base + o + 4 <= end ? view.getUint32(base + o, little) : null),
    // RATIONAL is two LONGs: numerator, denominator.
    rat: (o) => {
      if (base + o + 8 > end) return null;
      const n = view.getUint32(base + o, little), d = view.getUint32(base + o + 4, little);
      return d ? n / d : null;
    },
  };
}

/* Walk one IFD, collecting the tags asked for. Values of 4 bytes or fewer live
 * inline in the entry; anything larger is an offset from the TIFF base. Only
 * count-1 scalars are read, which is all any focal-length tag ever is. */
function readIFD(view, tiffBase, ifdOffset, little, wanted, out) {
  const at = (o) => reader(view, tiffBase + o, little);
  const head = at(ifdOffset);
  const count = head.u16(0);
  if (count === null || count > MAX_ENTRIES) return;

  for (let i = 0; i < count; i++) {
    const e = at(ifdOffset + 2 + i * 12);
    const tag = e.u16(0), type = e.u16(2), n = e.u32(4);
    if (tag === null || type === null || n === null) return;
    if (!wanted.has(tag)) continue;
    const size = TYPE_SIZE[type] || 0;
    if (!size || n !== 1) continue;

    // Inline when the payload fits the 4-byte value field, else an offset.
    const vOff = size <= 4 ? ifdOffset + 2 + i * 12 + 8 : e.u32(8);
    if (vOff === null) continue;
    const v = at(vOff);

    let value = null;
    if (type === 3) value = v.u16(0);
    else if (type === 4) value = v.u32(0);
    else if (type === 5) value = v.rat(0);
    if (value !== null) out[tag] = value;
  }
}

/* --------------------------------------------------------------- container */

/** Locate the TIFF stream inside a JPEG APP1 "Exif\0\0" segment. */
function jpegTiffBase(view) {
  if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return -1;
  let p = 2;
  while (p + 4 <= view.byteLength) {
    if (view.getUint8(p) !== 0xff) return -1;            // not a marker: give up
    const marker = view.getUint8(p + 1);
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { p += 2; continue; }
    if (marker === 0xda) return -1;                       // scan data: no more headers
    const len = view.getUint16(p + 2, false);
    if (len < 2) return -1;
    if (marker === 0xe1 && p + 4 + 6 <= view.byteLength) {
      // "Exif\0\0"
      if (view.getUint32(p + 4, false) === 0x45786966 && view.getUint16(p + 8, false) === 0x0000) {
        return p + 10;
      }
    }
    p += 2 + len;
  }
  return -1;
}

/** Locate the TIFF stream inside a PNG eXIf chunk (PNG 1.5+). */
function pngTiffBase(view) {
  if (view.byteLength < 8) return -1;
  if (view.getUint32(0, false) !== 0x89504e47 || view.getUint32(4, false) !== 0x0d0a1a0a) return -1;
  let p = 8;
  while (p + 8 <= view.byteLength) {
    const len = view.getUint32(p, false), type = view.getUint32(p + 4, false);
    if (len > view.byteLength) return -1;
    if (type === 0x65584966) return p + 8;                // 'eXIf'
    if (type === 0x49454e44) return -1;                   // 'IEND'
    p += 12 + len;                                        // len + type + data + crc
  }
  return -1;
}

/** A bare TIFF file is its own stream. */
function tiffTiffBase(view) {
  if (view.byteLength < 4) return -1;
  const b = view.getUint16(0, false);
  return (b === 0x4949 || b === 0x4d4d) ? 0 : -1;
}

/* ------------------------------------------------------------------ public */

/**
 * Read the focal length a photograph declares about itself.
 *
 * @param {ArrayBuffer|Uint8Array} buf   the undecoded file
 * @param {number} [imgW]  decoded width, for crop detection
 * @param {number} [imgH]  decoded height
 * @returns {{known: boolean, fRel: number, mm35: number|null, source: string,
 *            reason: string|null, cropChecked: boolean}}
 *
 * `known: false` is a complete answer, not a failure. The caller reconstructs
 * orthographically and says the lens is unknown.
 */
export function readLens(buf, imgW = 0, imgH = 0) {
  const unknown = (reason) => ({ known: false, fRel: 0, mm35: null, source: 'none', reason, cropChecked: false });
  if (!buf) return unknown('no file');

  let view;
  try {
    view = buf instanceof DataView ? buf
         : ArrayBuffer.isView(buf) ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
         : new DataView(buf);
  } catch (_) { return unknown('unreadable'); }
  if (view.byteLength < 16) return unknown('unreadable');

  let tiff = -1;
  try {
    tiff = jpegTiffBase(view);
    if (tiff < 0) tiff = pngTiffBase(view);
    if (tiff < 0) tiff = tiffTiffBase(view);
  } catch (_) { return unknown('unreadable'); }
  if (tiff < 0) return unknown('no EXIF');

  const tags = {};
  try {
    const order = view.getUint16(tiff, false);
    if (order !== 0x4949 && order !== 0x4d4d) return unknown('no EXIF');
    const little = order === 0x4949;
    const head = reader(view, tiff, little);
    if (head.u16(2) !== 0x002a) return unknown('no EXIF');
    const ifd0 = head.u32(4);
    if (ifd0 === null || ifd0 < 8) return unknown('no EXIF');

    const want0 = new Set([TAG_EXIF_IFD]);
    readIFD(view, tiff, ifd0, little, want0, tags);
    const exifIFD = tags[TAG_EXIF_IFD];
    if (exifIFD === undefined) return unknown('no EXIF lens data');

    const want = new Set([TAG_FOCAL_LENGTH, TAG_FOCAL_35MM, TAG_FP_X_RES,
                          TAG_FP_RES_UNIT, TAG_PIXEL_X, TAG_PIXEL_Y]);
    readIFD(view, tiff, exifIFD, little, want, tags);
  } catch (_) { return unknown('malformed EXIF'); }

  // Crop check, where the file says what the sensor produced. A non-uniform
  // crop invalidates the declared focal length; a uniform one is invisible here
  // and cropChecked:true does not claim otherwise.
  const px = tags[TAG_PIXEL_X], py = tags[TAG_PIXEL_Y];
  let cropChecked = false;
  if (px > 0 && py > 0 && imgW > 0 && imgH > 0) {
    const a = Math.max(px, py) / Math.min(px, py);
    const b = Math.max(imgW, imgH) / Math.min(imgW, imgH);
    if (Math.abs(a - b) / b > ASPECT_TOLERANCE) return unknown('image was cropped or resized non-uniformly');
    cropChecked = true;
  }

  const accept = (fRel, source) => (fRel >= F_REL_MIN && fRel <= F_REL_MAX
    ? { known: true, fRel, mm35: Math.round(fRel * 36), source, reason: null, cropChecked }
    : null);

  // Preferred: the camera already did the equivalence. fRel = mm35 / 36 needs no
  // sensor dimensions and survives any uniform resampling of the file.
  const m35 = tags[TAG_FOCAL_35MM];
  if (m35 > 0) {
    const r = accept(m35 / 36, 'EXIF FocalLengthIn35mmFilm');
    if (r) return r;
  }

  // Otherwise derive f_px on the sensor and divide by the sensor's long side.
  // FocalPlaneXResolution is in pixels per FocalPlaneResolutionUnit, so
  // f_px = focal_mm * (R / mmPerUnit), and dividing by max(PixelX, PixelY)
  // gives the same scale-free ratio as the path above.
  const focal = tags[TAG_FOCAL_LENGTH], fpr = tags[TAG_FP_X_RES];
  const mmPerUnit = MM_PER_UNIT[tags[TAG_FP_RES_UNIT]];
  if (focal > 0 && fpr > 0 && mmPerUnit && px > 0 && py > 0) {
    const r = accept(focal * (fpr / mmPerUnit) / Math.max(px, py), 'EXIF FocalLength + FocalPlane');
    if (r) return r;
  }

  return unknown(m35 > 0 || focal > 0 ? 'EXIF focal length out of plausible range' : 'no EXIF lens data');
}

/**
 * Normalise whatever the host supplies into the lens record the core uses.
 * Accepts `{fRel}` or `{mm35}`; anything else is unknown. This is the ONLY way
 * a focal length enters the reconstruction, and it cannot manufacture one.
 */
export function declareLens(lens) {
  const unknown = { known: false, fRel: 0, mm35: null, source: 'none', reason: 'not supplied', cropChecked: false };
  if (!lens) return unknown;
  if (lens.known === false) return { ...unknown, reason: lens.reason || 'not supplied' };
  const fRel = lens.fRel > 0 ? lens.fRel : (lens.mm35 > 0 ? lens.mm35 / 36 : 0);
  if (!(fRel >= F_REL_MIN && fRel <= F_REL_MAX) || !isFinite(fRel)) {
    return { ...unknown, reason: 'declared focal length out of plausible range' };
  }
  return { known: true, fRel, mm35: Math.round(fRel * 36),
           source: lens.source || 'declared', reason: null, cropChecked: !!lens.cropChecked };
}
