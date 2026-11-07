// The lens is the one number the reconstruction takes on trust from outside,
// and it bends the geometry, so it gets its own suite.
//   node tools/test/atlas/lens.mjs
//
// The previous focal length was `35 + (1 − bboxFill)·40` — an affine map from
// framing to millimetres, printed with an invented confidence interval and fed
// straight into the perspective taper. Deleting it is only half the job: what
// replaces it has to actually READ a photograph's EXIF, and it has to refuse
// everything else rather than fall back to a plausible default.
//
// So both directions are measured here. The refusals are in geometry3d TASK 8c
// (they belong beside the taper they would corrupt); this file builds real EXIF
// byte-for-byte and checks the accept path, including the two containers, both
// byte orders, both derivations, and the crop that invalidates a declared focal
// length without changing a single EXIF field.
import { readLens, declareLens } from '../../../src/atlas/exif.js';

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(56)} ${detail}`);
};

/* ------------------------------------------------------------ EXIF forging */

const T_SHORT = 3, T_LONG = 4, T_RATIONAL = 5;

// Build a TIFF stream: IFD0 carrying only an ExifIFD pointer, then the ExifIFD
// with the tags asked for. RATIONALs do not fit the 4-byte value field, so they
// go on a heap after the directory and the entry holds the offset — which is
// exactly the case a reader gets wrong if it assumes everything is inline.
function buildTiff(entries, little = true) {
  const IFD0 = 8;
  const IFD0_LEN = 2 + 12 + 4;
  const EXIF = IFD0 + IFD0_LEN;
  const EXIF_LEN = 2 + 12 * entries.length + 4;
  const HEAP = EXIF + EXIF_LEN;
  const heapSize = entries.filter(e => e.type === T_RATIONAL).length * 8;

  const buf = new ArrayBuffer(HEAP + heapSize);
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);

  u8[0] = little ? 0x49 : 0x4d; u8[1] = little ? 0x49 : 0x4d;   // "II" | "MM"
  v.setUint16(2, 0x002a, little);
  v.setUint32(4, IFD0, little);

  v.setUint16(IFD0, 1, little);                                  // one entry
  v.setUint16(IFD0 + 2, 0x8769, little);                         // ExifIFDPointer
  v.setUint16(IFD0 + 4, T_LONG, little);
  v.setUint32(IFD0 + 6, 1, little);
  v.setUint32(IFD0 + 10, EXIF, little);
  v.setUint32(IFD0 + 14, 0, little);                             // no IFD1

  v.setUint16(EXIF, entries.length, little);
  let heap = HEAP;
  entries.forEach((e, i) => {
    const off = EXIF + 2 + i * 12;
    v.setUint16(off, e.tag, little);
    v.setUint16(off + 2, e.type, little);
    v.setUint32(off + 4, 1, little);
    if (e.type === T_SHORT) {
      // left-justified in the 4-byte value field, in the file's byte order
      v.setUint16(off + 8, e.value, little);
      v.setUint16(off + 10, 0, little);
    } else if (e.type === T_LONG) {
      v.setUint32(off + 8, e.value, little);
    } else {                                                     // RATIONAL
      v.setUint32(off + 8, heap, little);
      v.setUint32(heap, e.num, little);
      v.setUint32(heap + 4, e.den, little);
      heap += 8;
    }
  });
  v.setUint32(EXIF + 2 + entries.length * 12, 0, little);
  return u8;
}

function asJpeg(tiff) {
  const seg = 2 + 6 + tiff.length;                               // len field + "Exif\0\0" + payload
  const out = new Uint8Array(4 + seg + 2);
  out[0] = 0xff; out[1] = 0xd8;                                  // SOI
  out[2] = 0xff; out[3] = 0xe1;                                  // APP1
  out[4] = (seg >> 8) & 0xff; out[5] = seg & 0xff;               // big-endian length
  out.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 6);              // "Exif\0\0"
  out.set(tiff, 12);
  out[12 + tiff.length] = 0xff; out[13 + tiff.length] = 0xd9;    // EOI
  return out;
}

function asPng(tiff) {
  const out = new Uint8Array(8 + 12 + tiff.length);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);  // signature
  const v = new DataView(out.buffer);
  v.setUint32(8, tiff.length, false);                            // chunk length
  out.set([0x65, 0x58, 0x49, 0x66], 12);                         // "eXIf"
  out.set(tiff, 16);
  v.setUint32(16 + tiff.length, 0, false);                       // CRC, unchecked
  return out;
}

const TAGS = { FOCAL: 0x920a, MM35: 0xa405, FPX: 0xa20e, FPUNIT: 0xa210, PX: 0xa002, PY: 0xa003 };

const mm35Exif = (mm, px = 4000, py = 3000) => buildTiff([
  { tag: TAGS.PX, type: T_LONG, value: px },
  { tag: TAGS.PY, type: T_LONG, value: py },
  { tag: TAGS.MM35, type: T_SHORT, value: mm },
]);

/* ------------------------------------------------------------------ task 1 */

function taskAccept() {
  console.log('\nTASK 1 — a photograph that carries its focal length is believed');
  for (const mm of [24, 35, 50, 85, 200]) {
    const r = readLens(asJpeg(mm35Exif(mm)).buffer, 4000, 3000);
    const exact = r.known && r.mm35 === mm && Math.abs(r.fRel - mm / 36) < 1e-12;
    console.log(`   ${String(mm).padStart(3)}mm  known=${r.known}  fRel=${r.fRel.toFixed(4)}`
              + `  mm35=${r.mm35}  cropChecked=${r.cropChecked}  ${r.source}`);
    ok(`${mm}mm read from FocalLengthIn35mmFilm`, exact, `fRel ${r.fRel.toFixed(4)}`);
  }
  const r = readLens(asJpeg(mm35Exif(50)).buffer, 4000, 3000);
  ok('the accepted lens names its own source', /FocalLengthIn35mmFilm/.test(r.source), r.source);
  ok('a checked aspect ratio is reported as checked', r.cropChecked === true, String(r.cropChecked));
}

/* ------------------------------------------------------------------ task 2 */
// f_px = focal_mm · (FocalPlaneXResolution / mmPerUnit), and fRel divides that
// by the sensor's long side — so the answer is the same ratio the 35mm path
// gives, reached without the camera having done the equivalence for us.
function taskFocalPlane() {
  console.log('\nTASK 2 — focal length + focal plane resolution derives the same ratio');
  // A 4000×3000 sensor 23.5mm wide: 4000/23.5 = 170.21 px/mm. A 35mm lens on it
  // is 35 × 170.21 = 5957 px, so fRel = 5957/4000 = 1.4894 → 53.6mm equivalent.
  const px = 4000, py = 3000, focalMm = 35, sensorMm = 23.5;
  const pxPerMm = px / sensorMm;
  const tiff = buildTiff([
    { tag: TAGS.PX, type: T_LONG, value: px },
    { tag: TAGS.PY, type: T_LONG, value: py },
    { tag: TAGS.FOCAL, type: T_RATIONAL, num: focalMm * 100, den: 100 },
    { tag: TAGS.FPX, type: T_RATIONAL, num: Math.round(pxPerMm * 1000), den: 1000 },
    { tag: TAGS.FPUNIT, type: T_SHORT, value: 4 },               // 4 = millimetre
  ]);
  const r = readLens(asJpeg(tiff).buffer, px, py);
  const want = focalMm * pxPerMm / px;
  console.log(`   focal ${focalMm}mm on a ${sensorMm}mm sensor → fRel ${r.fRel.toFixed(4)}`
            + ` (want ${want.toFixed(4)}) → ${r.mm35}mm equivalent`);
  ok('focal plane path derives fRel', r.known && Math.abs(r.fRel - want) < 1e-3, r.source);
  ok('focal plane path names its source', /FocalPlane/.test(r.source || ''), r.source);

  // Inches are the common unit in the wild, and getting the conversion backwards
  // is a factor of 25.4 — a 35mm lens read as an 889mm one, or as 1.4mm.
  const inch = buildTiff([
    { tag: TAGS.PX, type: T_LONG, value: px },
    { tag: TAGS.PY, type: T_LONG, value: py },
    { tag: TAGS.FOCAL, type: T_RATIONAL, num: focalMm * 100, den: 100 },
    { tag: TAGS.FPX, type: T_RATIONAL, num: Math.round(pxPerMm * 25.4 * 100), den: 100 },
    { tag: TAGS.FPUNIT, type: T_SHORT, value: 2 },               // 2 = inch
  ]);
  const ri = readLens(asJpeg(inch).buffer, px, py);
  console.log(`   the same lens declared in inches → fRel ${ri.fRel.toFixed(4)}`);
  ok('inch and millimetre units agree', ri.known && Math.abs(ri.fRel - want) < 2e-3,
     `${ri.fRel.toFixed(4)} vs ${want.toFixed(4)}`);
}

/* ------------------------------------------------------------------ task 3 */

function taskContainers() {
  console.log('\nTASK 3 — container and byte order do not change the answer');
  const want = 50 / 36;
  const cases = [
    ['JPEG APP1, little-endian', asJpeg(mm35Exif(50)).buffer],
    ['JPEG APP1, big-endian',    asJpeg(buildTiff([
        { tag: TAGS.PX, type: T_LONG, value: 4000 },
        { tag: TAGS.PY, type: T_LONG, value: 3000 },
        { tag: TAGS.MM35, type: T_SHORT, value: 50 },
      ], false)).buffer],
    ['PNG eXIf chunk',           asPng(mm35Exif(50)).buffer],
    ['bare TIFF',                mm35Exif(50).buffer],
  ];
  let allAgree = true;
  for (const [name, buf] of cases) {
    const r = readLens(buf, 4000, 3000);
    const good = r.known && Math.abs(r.fRel - want) < 1e-12;
    allAgree = allAgree && good;
    console.log(`   ${name.padEnd(26)} known=${String(r.known).padEnd(5)} fRel=${r.fRel.toFixed(4)}`);
    ok(`${name} reads 50mm`, good, `fRel ${r.fRel.toFixed(4)}`);
  }
  ok('every container agrees to float precision', allAgree, `${cases.length} containers`);
}

/* ------------------------------------------------------------------ task 4 */
// A crop changes the field of view and changes no EXIF field, so a declared
// focal length stops describing the file. Aspect ratio is the only evidence
// available, and it only catches NON-UNIFORM crops — which is why the return
// value carries `cropChecked` rather than a claim of validity.
function taskCrop() {
  console.log('\nTASK 4 — a crop that changes the aspect ratio invalidates the lens');
  const tiff = mm35Exif(50, 4000, 3000);                          // sensor is 4:3
  const rows = [
    ['uncropped 4000×3000',        4000, 3000, true],
    ['resized 800×600, same 4:3',   800,  600, true],
    ['cropped to square 3000×3000', 3000, 3000, false],
    ['cropped to 16:9 4000×2250',   4000, 2250, false],
    ['1% off 4:3 — within tolerance', 4000, 2970, true],
  ];
  for (const [name, w, h, expect] of rows) {
    const r = readLens(asJpeg(tiff).buffer, w, h);
    console.log(`   ${name.padEnd(32)} known=${String(r.known).padEnd(5)} ${r.reason || r.source}`);
    ok(`${name} → ${expect ? 'accepted' : 'refused'}`, r.known === expect, r.reason || r.source);
  }
  // Without dimensions to compare against there is nothing to check, and the
  // result says so rather than implying the crop was ruled out.
  const blind = readLens(asJpeg(tiff).buffer, 0, 0);
  ok('an unverifiable crop is flagged, not assumed away',
     blind.known === true && blind.cropChecked === false, `cropChecked ${blind.cropChecked}`);
}

/* ------------------------------------------------------------------ task 5 */

function taskRange() {
  console.log('\nTASK 5 — implausible focal lengths are refused, not clamped');
  for (const [mm, expect] of [[8, false], [13, true], [1000, true], [1200, false], [30000, false]]) {
    const r = readLens(asJpeg(mm35Exif(mm)).buffer, 4000, 3000);
    console.log(`   ${String(mm).padStart(5)}mm equiv → known=${String(r.known).padEnd(5)} ${r.reason || ''}`);
    ok(`${mm}mm is ${expect ? 'accepted' : 'refused'}`, r.known === expect, r.reason || 'accepted');
  }
  // A refusal must not leave a usable number behind for a careless caller.
  const bad = readLens(asJpeg(mm35Exif(30000)).buffer, 4000, 3000);
  ok('a refused lens carries no focal length', bad.fRel === 0 && bad.mm35 === null,
     `fRel ${bad.fRel}, mm35 ${bad.mm35}`);
}

/* ------------------------------------------------------------------ task 6 */
// The two doors into the core must agree, or the tests that declare a lens are
// not testing the path a photograph takes.
function taskAgreement() {
  console.log('\nTASK 6 — reading EXIF and declaring a lens reach the same record');
  let worst = 0;
  for (const mm of [24, 35, 50, 85, 135]) {
    const read = readLens(asJpeg(mm35Exif(mm)).buffer, 4000, 3000);
    const decl = declareLens({ mm35: mm });
    const d = Math.abs(read.fRel - decl.fRel);
    worst = Math.max(worst, d);
    ok(`${mm}mm agrees between EXIF and declaration`, d < 1e-12 && read.known && decl.known,
       `Δ ${d.toExponential(1)}`);
  }
  ok('the two doors never disagree', worst < 1e-12, `worst Δ ${worst.toExponential(1)}`);
}

taskAccept(); taskFocalPlane(); taskContainers(); taskCrop(); taskRange(); taskAgreement();

const passed = results.filter(r => r.pass).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
