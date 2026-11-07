/* seed-vectors.mjs — write the shared seed vectors every port is checked against.
 *
 *   node tools/kernel/seed-vectors.mjs           (re)write tools/test/kernel/vectors/seed-vectors.json
 *   node tools/kernel/seed-vectors.mjs --check   exit 1 if the committed file differs
 *
 * The file is the contract between src/kernel/core/seedpath.js and every other
 * implementation of it — tools/kernel/py/genesis_seed.py today, whatever a sibling
 * repository ports it into next. It is GENERATED, from the JS, because the JS
 * is the implementation the shipping worlds are built by; a port is right
 * when it reproduces this file and wrong otherwise.
 *
 * Deterministic by construction: no clock, no randomness, inputs in a fixed
 * list, entries sorted by path (then by input), every object's keys sorted,
 * two-space indent, one trailing newline. Running it twice writes the same
 * bytes, which is what lets the file be committed and diffed.
 *
 * What each entry records, and why:
 *   input        the root and segments exactly as a caller might pass them —
 *                lowercase, padded with spaces, separated by "_" — so the
 *                normalization is part of what a port must agree on
 *   path, root   the canonical path and its canonical root
 *   hashSeed     src/kernel/seed.js hashSeed(root), the 32-bit FNV-1a
 *   seedChannel  seedChannel(root, c) for terrain / erosion / props — the
 *                three channels a port is most likely to need on day one
 *   legacy32Seed seedChannel(root, segments.join(":")), what legacy32 seeds
 *                mulberry32 with
 *   legacy32     the first 8 uint32 draws of streamFor(path, legacy32)
 *   hash64       FNV-1a/64 of the path, 16 hex digits
 *   v2State      the four sfc32 words splitmix32 derives from hash64
 *   v2           the first 8 uint32 draws of streamFor(path), mode v2
 *
 * Plus `hash64` (raw strings, including the published FNV-1a/64 test values
 * for "", "a" and "foobar"), `invalid` (inputs both implementations must
 * refuse, so a port agrees with the JS about what is NOT a path as well) and
 * `world` (raw typed seeds and the path worldSeedPath gives each — the seeds
 * with other than twelve letters and digits, which seedPath keeps verbatim
 * and the engine pads or truncates).
 *
 * And `placements` / `placementsInvalid`: placement lists with the canonical
 * text and the hash src/kernel/terrain/fingerprint.js gives each, and lists it
 * refuses. Not the seed algebra, but the same kind of contract — a number a
 * Python pipeline (tools/kernel/py/genesis_placements.py) must reproduce bit for
 * bit — and it rides in this file so one checker and one staleness test
 * cover both. The rows are chosen for what a port gets wrong by default:
 * code-point instead of code-unit sorting (an astral uid against U+FF01),
 * escaped non-ASCII, ties in the rounding, −0, control characters.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hashSeed, seedChannel } from "../../src/kernel/seed.js";
import { seedPath, worldSeedPath, parseSeedPath, streamFor, hash64, hash64Hex, v2State } from "../../src/kernel/core/seedpath.js";
import { canonicalPlacements, placementsHash } from "../../src/kernel/terrain/fingerprint.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "tools/test/kernel/vectors/seed-vectors.json");
const DRAWS = 8;
const CHANNELS = ["erosion", "props", "terrain"];

export const INPUTS = [
  ["K7QN-3F2A-9XBD", ["terrain"]],
  ["k7qn-3f2a-9xbd", ["terrain"]],             // lowercase: the same path as above
  [" k7qn 3f2a_9xbd ", ["erosion"]],          // odd separators and padding
  ["ZZ11-0000-AAAA", ["props"]],               // the second GOLDEN seed in noise-stack.test.js
  ["2222-2222-2222", ["climate"]],             // the pad character everywhere
  ["AB12.CD34.EF56", ["room:0"]],              // "." separators; an index of zero
  ["K7QN-3F2A-9XBD", ["world", "grass"]],      // legacy32 == channelRng(seed, "world:grass")
  ["K7QN-3F2A-9XBD", ["compose", "river:3", "tree:17"]],
  ["K7QN-3F2A-9XBD", ["café"]],                // precomposed U+00E9
  ["K7QN-3F2A-9XBD", ["森", "山:2"]],           // CJK, one code unit each
  ["K7QN-3F2A-9XBD", ["🌲:4294967296"]],       // astral: a surrogate pair; an index past 2^32
  ["unseeded", ["terrain"]],                   // a verbatim root
  ["mountainpass", ["detail"]],                // a twelve-letter word IS seed-shaped
];

export const INVALID = [
  ["", ["terrain"]],
  ["K7QN", ["a/b"]],
  ["my world", ["terrain"]],
  ["K7QN-3F2A-9XBD", [""]],
  ["K7QN-3F2A-9XBD", ["room:"]],
  ["K7QN-3F2A-9XBD", ["room:01"]],
  ["K7QN-3F2A-9XBD", ["room:-1"]],
  ["K7QN-3F2A-9XBD", ["room:1:2"]],
  ["K7QN-3F2A-9XBD", ["room:9007199254740992"]],
  ["K7QN-3F2A-9XBD", ["two words"]],
  ["K7QN-3F2A-9XBD", ["\ud800x"]],
  ["root:x", ["terrain"]],
  ["k7qn3f2a9xbd\n", ["terrain"]],             // Python's "$" would match before this newline
  ["K7QN-3F2A-9XBD", ["room:1\n"]],
  ["K7QN-3F2A-9XBD", ["room:" + "1".repeat(5000)]], // past Python's 4300-digit int() limit
  ["K7QN-3F2A-9XBD", ["a\u00a0b"]],             // NBSP
  ["K7QN-3F2A-9XBD", ["a\u0085"]],              // NEL, a C1 control
  ["K7QN-3F2A-9XBD", ["\u2028"]],               // line separator
  ["K7QN-3F2A-9XBD", ["\ufeffterrain"]],        // byte-order mark
  ["K7QN-3F2A-9XBD", ["ter\u200brain"]],        // zero-width space
  ["K7QN-3F2A-9XBD", ["a\u202eb"]],             // right-to-left override
  ["K7QN-3F2A-9XBD", ["\u3000"]],               // ideographic space
];

// Typed seeds as a user or a URL hands them over, through worldSeedPath.
const WORLD = [
  ["hello", ["terrain"]],                      // short: padded with "2"
  ["k7qn-3f2a", ["terrain"]],                  // eight characters
  ["K7QN3F2A9XBDQ", ["terrain"]],              // thirteen: truncated
  ["K7QN-3F2A-9XBD-ZZ", ["terrain"]],          // a fourth group: dropped
  ["k7qn 3f2a 9xbd", ["world", "grass"]],      // the already seed-shaped case
];

/* Placement lists. Plain JSON on purpose — the file is how a port receives
   them — so the JS-only shapes (undefined, typed arrays, Map) are covered by
   tests/ground.test.js instead. */
export const PLACEMENTS = [
  [],
  // Code-unit order puts U+1F600 (0xD83D 0xDE00) AFTER U+FF01; code-point
  // order would put it first.
  [{ uid: "\u{1F600}" }, { uid: "\uff01" }],
  [
    { uid: "p3f2a-1", ref: "tree.oak", position: [12.345678, 4.5, -300.25], rotationY: 1.2345678, scale: 1 },
    { uid: "p3f2a-0", ref: "rock.flat", proc: { seed: "A", size: 2 }, position: [-7, 0.125, 40], scale: [1, 2, 1] },
    { uid: "p3f2a-a", ref: "lamp", position: [0, 0, 0], rotationY: 0, scale: 0.5 },
  ],
  [
    {
      uid: "café-2",
      label: "crème brûlée\t\"q\"\\ \u0001\u007f\u2028森",
      /* Exact ties — each of these times 10000 is exactly k + 0.5 as a
         double (checked: 0.00005 * 10000 === 0.5) — written 1, 0, 3, −3,
         where Python's round() would write 0, 0, 2, −4. Then −0. */
      position: [0.00005, -0.00005, 0.00025, -0.00035, -0],
      keys: { "z": 1, "森": 2, "\uff01": 3, "\u{1F600}": 4, "A": 5 },
      flag: false, none: null, big: 900000000000,
    },
    { uid: "café-1", ref: "tree.oak", scale: [1, 2, 1] },
    { ref: "no uid sorts first" },
  ],
  [{ uid: "same", n: 2 }, { uid: "same", n: 1 }],
];

export const PLACEMENTS_INVALID = [
  [{ uid: 7 }],                          // a numeric uid
  [{ uid: "a", s: "\ud800" }],           // a lone surrogate
  [{ uid: "a", x: 1e12 }],               // past 2^53 quanta
];

const RAW_HASH64 = ["", "a", "foobar", "K7QN-3F2A-9XBD", "K7QN-3F2A-9XBD:terrain"];

function entry(root, segments) {
  const path = seedPath(root, ...segments);
  const canon = parseSeedPath(path);
  const legacy = streamFor(path, { mode: "legacy32" });
  const v2 = streamFor(path);
  const seedChannels = {};
  for (const c of CHANNELS) seedChannels[c] = seedChannel(canon.root, c);
  return {
    input: { root, segments },
    path,
    root: canon.root,
    hashSeed: hashSeed(canon.root),
    seedChannel: seedChannels,
    legacy32Seed: seedChannel(canon.root, canon.segments.join(":")),
    legacy32: Array.from({ length: DRAWS }, () => legacy.nextU32()),
    hash64: hash64Hex(path),
    v2State: v2State(hash64(path)),
    v2: Array.from({ length: DRAWS }, () => v2.nextU32()),
  };
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
    return o;
  }
  return v;
}

export function buildVectors() {
  const entries = INPUTS.map(([r, s]) => entry(r, s)).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 :
    JSON.stringify(a.input) < JSON.stringify(b.input) ? -1 : 1);
  for (const [r, s] of INVALID) {
    let threw = false;
    try { seedPath(r, ...s); } catch { threw = true; }
    if (!threw) throw new Error(`seed-vectors: ${JSON.stringify([r, s])} is listed invalid but seedPath accepted it`);
  }
  for (const r of PLACEMENTS_INVALID) {
    let threw = false;
    try { placementsHash(r); } catch { threw = true; }
    if (!threw) throw new Error(`seed-vectors: ${JSON.stringify(r)} is listed invalid but placementsHash accepted it`);
  }
  return sortKeys({
    format: 1,
    generator: "tools/kernel/seed-vectors.mjs",
    source: "src/kernel/core/seedpath.js",
    draws: DRAWS,
    entries,
    hash64: RAW_HASH64.map((input) => ({ input, hex: hash64Hex(input) })),
    invalid: INVALID.map(([root, segments]) => ({ root, segments })),
    placements: PLACEMENTS.map((records) => ({ records, canonical: canonicalPlacements(records), hash: placementsHash(records) })),
    placementsInvalid: PLACEMENTS_INVALID.map((records) => ({ records })),
    world: WORLD.map(([typed, segments]) => ({ typed, segments, path: worldSeedPath(typed, ...segments) })),
  });
}

export const render = (v) => JSON.stringify(v, null, 2) + "\n";

if (typeof process !== "undefined" && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = render(buildVectors());
  if (process.argv.includes("--check")) {
    let have = "";
    try { have = readFileSync(OUT, "utf8"); } catch {}
    if (have !== text) {
      console.error("seed-vectors: tools/test/kernel/vectors/seed-vectors.json is stale — run node tools/kernel/seed-vectors.mjs");
      process.exit(1);
    }
    console.log("seed-vectors: up to date");
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, text);
    console.log(`seed-vectors: wrote ${INPUTS.length} entries to tools/test/kernel/vectors/seed-vectors.json`);
  }
}
