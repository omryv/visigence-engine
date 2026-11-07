/* src/kernel/core/seedpath.js — one seed algebra for every repository.
 *
 * src/kernel/seed.js gives a world ONE name and lets each subsystem draw its own
 * stream from it: `channelRng("K7QN-3F2A-9XBD", "terrain")`. Every world in
 * this repository is built on that scheme, and nothing here changes it: the
 * claim this file makes, and that tools/test/kernel/seedpath.test.js checks, is only that
 * legacy32 below draws exactly what src/kernel/seed.js draws. (Whether the copies
 * of seed.js in sibling repositories still agree with this one is not tested
 * here; tools/test/kernel/vectors/seed-vectors.json is what they can now be checked
 * against.) What it does not give is a way to NAME a stream that every repository (JS, Python inside
 * Blender, whatever comes next) can write down the same way, and it has two
 * properties that stop being acceptable once the kernel is a library other
 * repositories derive thousands of streams from:
 *
 *   - the identity of a stream is a 32-bit FNV-1a hash. By the birthday bound
 *     the chance that some two of n distinct channel strings collide is
 *     1 − exp(−n(n−1)/2³³), so a world that names 10 000 streams (one per
 *     room, per prop, per stroke) has about a one-in-86 chance (0.0116) of two
 *     of them being the SAME stream, and 100 000 streams make it more likely
 *     than not (0.69). That formula is for hashes that behave like random
 *     draws, and it is what was measured: among 200 000 distinct random names
 *     under one seed, 9 pairs shared a 32-bit channel (4.66 expected) and none
 *     shared a 64-bit path hash. (A counting suffix is kinder — "prop:0" to
 *     "prop:999999" happen not to collide at all — but nobody gets to choose
 *     that every stream they name is a counter.) tools/test/kernel/seedpath.test.js
 *     repeats the measurement;
 *   - the generator behind it, mulberry32, has 32 bits of state: a single
 *     stream can only ever be in 2³² places, and every stream is a window on
 *     the same single cycle.
 *
 * So this module adds three things, and keeps the old behaviour reachable as
 * a named MODE rather than as a special case somebody has to remember.
 *
 * ── 1. a path grammar
 *
 *     path     = root ( "/" segment )*
 *     segment  = name [ ":" index ]
 *     name     = 1*namechar
 *     namechar = any UTF-16 code unit except "/", ":" and the BANNED units
 *                below; surrogates only as a correctly ordered pair
 *     index    = "0" | [1-9][0-9]*            (≤ 2^53 − 1, no sign, no padding)
 *     root     = a SEED-SHAPED string, which is replaced by normalizeSeed of
 *                itself, or else 1*namechar kept verbatim
 *
 *   "Seed-shaped" means: only ASCII letters, digits, and the separators
 *   space, "-", "_" and ".", with EXACTLY twelve letters and digits in it.
 *   That is the shape a correctly typed seed comes in ("k7qn 3f2a 9xbd",
 *   "K7QN-3F2A-9XBD", "k7qn_3f2a.9xbd"), and for those normalizeSeed is a
 *   pure re-spelling, so the canonical root is the seed the engine holds.
 *   Anything else — "unseeded", a test fixture's name — is a verbatim root.
 *   The rule is deliberately narrow: normalizeSeed pads and truncates, so
 *   applying it to every root would quietly turn "unseeded" into
 *   "UNSE-EDED-2222" and two different short roots into one. A twelve-letter
 *   WORD ("mountainpass") is seed-shaped and does get normalized; that is what
 *   the editor's seed box would do with it too.
 *
 *   The consequence a consumer has to know: the ROOT IS THE ENGINE'S SEED,
 *   not whatever the user typed. The engine normalizes every typed seed
 *   (Engine.js setSeed: `normalizeSeed(seed)`, refusing what is not one), padding a
 *   short one and truncating a long one, so "hello" is the world
 *   HELL-O222-2222 and "K7QN-3F2A-9XBD-ZZ" is K7QN-3F2A-9XBD. seedPath does
 *   neither — "hello" and "K7QN3F2A9XBDQ" are verbatim roots to it, and
 *   legacy32 on them is NOT the world the editor shows for that input. Pass
 *   engine.params.seed (already normalized), or use worldSeedPath(typed, ...),
 *   which applies normalizeSeed exactly as the engine does and refuses input
 *   from which no seed survives instead of rolling a random one. Both cases
 *   are pinned in tools/test/kernel/seedpath.test.js.
 *
 *   BANNED code units, in names and in verbatim roots alike, are the ones
 *   that make two paths that look the same name different streams: every
 *   control (U+0000–U+001F, U+007F–U+009F), every Unicode White_Space unit
 *   (U+0020, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F,
 *   U+3000), and the invisible format characters (U+00AD soft hyphen,
 *   U+200B–U+200F zero-width and direction marks, U+202A–U+202E and
 *   U+2066–U+2069 bidirectional embeddings and isolates, U+2060–U+2064 word
 *   joiner and invisible operators, U+FEFF byte-order mark). It is an
 *   explicit list, not "whatever the runtime's \s matches", so a port copies
 *   it rather than inheriting its own regex engine's Unicode version. Other
 *   look-alikes (Cyrillic "а" against Latin "a") are left alone: they are
 *   visible characters, and refusing them would refuse whole scripts.
 *
 *   No Unicode normalization (NFC) is applied to names: "café" spelled with a
 *   precomposed é and with e + U+0301 are two different paths. Normalization
 *   tables move between Unicode versions, and a hash that depends on which
 *   version a runtime ships is not portable; a caller who wants NFC applies it
 *   before naming the path.
 *
 * ── 2. a 64-bit path hash
 *
 *   hash64 is FNV-1a/64 over the path's UTF-16 code units — the same unit
 *   convention hashSeed uses, so the two hashes read a string the same way and
 *   a Python port reads it with `encode("utf-16-le")`. It is done in two
 *   uint32 limbs with Math.imul and 16-bit halves, not BigInt: every current
 *   engine has BigInt, but it allocates per operation, it is not how anything
 *   else in this core computes, and a port to a language without big integers
 *   should be able to copy this loop as written. The 16-bit partial products
 *   stay below 2^25 and no intermediate sum exceeds 2^33 in magnitude, far
 *   inside the 2^53 a double holds exactly, so the arithmetic is exact on any
 *   engine. tools/test/kernel/seedpath.test.js cross-checks it against a BigInt FNV.
 *
 * ── 3. two stream modes
 *
 *   "legacy32" IS today's stream. For a one-segment path it is
 *   `mulberry32(seedChannel(root, segment))` — src/kernel/seed.js's own functions,
 *   called, not re-implemented, so it cannot drift. A multi-segment path joins
 *   its segments with ":" before the channel hash, which is exactly how the
 *   compound channels already in the tree are spelled: "world/grass" in
 *   legacy32 is `channelRng(seed, "world:grass")` (js/worlds.js), and
 *   "landform/planting" is js/landform.js's "landform:planting". The price is
 *   that legacy32 cannot tell "a/b:1" from "a/b/1" — both are channel "a:b:1"
 *   — which is the 32-bit scheme's ambiguity, kept on purpose, and the reason
 *   new code should not use this mode.
 *
 *   "v2" (the default) is sfc32 — Chris Doty-Humphrey's Small Fast Counting
 *   generator, 128 bits of state of which 32 are a counter that steps by one
 *   on every draw, so no seed can land it on a cycle shorter than 2³² (the
 *   state cannot repeat before the counter does). Its author gives the average
 *   period as about 2¹²⁷ and reports it passing PractRand to the full length
 *   tested; those are published figures, not re-measured here. Every step is
 *   add / xor / shift / rotate on uint32, which ports to any language with
 *   32-bit masking and nothing else. xoshiro128** was the alternative; it is
 *   equally fast and equally portable, but it has an all-zero state that must
 *   be guarded against and it needs a multiply, where sfc32 needs neither.
 *
 *   The four state words come from hash64 through splitmix32: a splitmix32
 *   state starts at the low limb and emits a and b, then the high limb is
 *   XORed into that state and it emits c and d. Both limbs therefore reach the
 *   state, and a hash whose two limbs happen to be equal does not produce two
 *   equal halves. Then twelve outputs are discarded — the short warm-up the
 *   sfc family's own seeding routine uses — so the first value anybody sees
 *   is already several rounds of mixing away from the hash. Measured on the
 *   first draw of "room:0" … "room:2000": consecutive neighbours differ in
 *   16.0 of 32 bits on average (tools/test/kernel/seedpath.test.js).
 *
 *   Both modes return floats as u32 / 2³² — 32 bits of resolution, the same as
 *   mulberry32 has always given. Two draws per float would give 53 bits; that
 *   was deliberately not done, because it halves the stream for every caller
 *   to buy precision nobody placing a tree needs, and because "one draw, one
 *   value" is the property that keeps a Python port a line-for-line copy.
 *
 * ── what this does NOT do
 *
 *   It does not move any existing world. src/kernel/seed.js is untouched and every
 *   caller of channelRng / seedChannel draws exactly what it drew before. The
 *   channel strings in the tree today are expressible as legacy32 paths, as
 *   long as a part that is not a non-negative integer is written as a NAME
 *   rather than an index: engine/props/grass.js's "grass:i:x:z" has
 *   coordinates that can be negative, and "-3" is not an index but is a
 *   perfectly good name, so seedPath(seed, "grass", "5", "-3", "7") in legacy32
 *   is channelRng(seed, "grass:5:-3:7"). js/archetype.js's "archetype:<uid>"
 *   is archetype/<uid> whenever the uid is a grammatical name; its root is
 *   `seed || uid`, which is that caller's choice, not this module's. The pairs
 *   tools/test/kernel/seedpath.test.js checks against channelRng are "terrain",
 *   "erosion", "climate", "detail", "landform", "spawn-yaw", "headless",
 *   "prop:3", and the compound world/grass, landform/planting, landform/woods,
 *   compose/river:3, detail/turf, scatter/pine and grass/5/-3/7.
 *
 *   The shared vectors in tools/test/kernel/vectors/seed-vectors.json are generated by
 *   tools/kernel/seed-vectors.mjs from this file and checked by tools/test/kernel/seed-vectors.test.js and
 *   tools/kernel/py/check_vectors.py, so a port that disagrees with the JS by one bit
 *   fails a test somewhere rather than shipping a different world.
 */

import { normalizeSeed, seedChannel, mulberry32 } from "../seed.js";

const SEP = "/";
const IDX = ":";
const MAX_INDEX = 9007199254740991; // 2^53 − 1: an index held as a JS number is exact

/* The banned code units of the header, as a predicate. Every one of them is
   in the BMP, so a code-unit test is the whole rule. */
function isBanned(c) {
  return c <= 0x20 || (c >= 0x7f && c <= 0xa0) || c === 0xad || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200f) || (c >= 0x2028 && c <= 0x202f) ||
    (c >= 0x205f && c <= 0x2064) || (c >= 0x2066 && c <= 0x2069) ||
    c === 0x3000 || c === 0xfeff;
}

/* The one character rule, shared by names and verbatim roots. Returns the
   reason a string is not 1*namechar, or "" when it is. Code units, not code
   points: that is the unit the hashes read. */
function badNameReason(s) {
  if (s.length === 0) return "is empty";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x2f) return `contains "/" at ${i}`;
    if (c === 0x3a) return `contains ":" at ${i}`;
    if (isBanned(c)) return `contains control, space or invisible U+${c.toString(16).padStart(4, "0").toUpperCase()} at ${i}`;
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (!(d >= 0xdc00 && d <= 0xdfff)) return `contains an unpaired high surrogate at ${i}`;
      i++;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return `contains an unpaired low surrogate at ${i}`;
  }
  return "";
}

/** True when `s` is the shape a typed seed comes in: ASCII letters and digits
 *  separated by nothing, spaces, "-", "_" or ".", with exactly twelve
 *  letters and digits. Such a root is replaced by normalizeSeed(s). */
export function isSeedShaped(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9 ._-]+$/.test(s)) return false;
  return s.replace(/[^A-Za-z0-9]/g, "").length === 12;
}

function canonicalRoot(root) {
  if (typeof root !== "string") throw new TypeError(`seedPath: root must be a string, got ${typeof root}`);
  if (isSeedShaped(root)) return normalizeSeed(root);
  const why = badNameReason(root);
  if (why) throw new Error(`seedPath: root ${JSON.stringify(root)} ${why}`);
  return root;
}

function checkSegment(seg, where) {
  if (typeof seg !== "string") throw new TypeError(`seedPath: segment ${where} must be a string, got ${typeof seg}`);
  const k = seg.indexOf(IDX);
  const name = k < 0 ? seg : seg.slice(0, k);
  const why = badNameReason(name);
  if (why) throw new Error(`seedPath: segment ${where} ${JSON.stringify(seg)}: name ${why}`);
  if (k >= 0) {
    const index = seg.slice(k + 1);
    if (!/^(0|[1-9][0-9]*)$/.test(index)) {
      throw new Error(`seedPath: segment ${where} ${JSON.stringify(seg)}: index must be a non-negative decimal integer with no sign or leading zeros`);
    }
    if (Number(index) > MAX_INDEX) throw new Error(`seedPath: segment ${where} ${JSON.stringify(seg)}: index exceeds 2^53 − 1`);
  }
  return seg;
}

/* The body of seedPath, over an array: parseSeedPath calls this directly so
   a path with a few hundred thousand segments is not spread into an argument
   list (which throws RangeError at roughly 120 000 arguments in V8). */
function canonicalize(root, segments) {
  let out = canonicalRoot(root);
  for (let i = 0; i < segments.length; i++) out += SEP + checkSegment(segments[i], i);
  return out;
}

/** seedPath(root, ...segments) → the canonical path string.
 *  seedPath("k7qn 3f2a 9xbd", "compose", "river:3") === "K7QN-3F2A-9XBD/compose/river:3".
 *  With no segments it returns the canonical root on its own. Throws on any
 *  string the grammar above does not accept.
 *
 *  `root` must be the WORLD'S seed as the engine holds it (engine.params.seed,
 *  i.e. normalizeSeed of what was typed), not raw user input: a typed seed
 *  with other than twelve letters and digits is a verbatim root here, and the
 *  engine pads or truncates it into a different one. worldSeedPath is the
 *  entry point for raw input. */
export function seedPath(root, ...segments) {
  return canonicalize(root, segments);
}

/** worldSeedPath(typed, ...segments) → seedPath(normalizeSeed(typed), ...).
 *  The path a consumer holding raw user input ("?seed=hello", a pasted
 *  13-character string) should use: it lands on the same root the engine
 *  builds the world from. Where the engine falls back to a RANDOM seed
 *  (nothing alphanumeric survives), this throws instead, because a path that
 *  names a different stream on every call is not a path. */
export function worldSeedPath(typed, ...segments) {
  const seed = normalizeSeed(typed);
  if (seed === null) throw new Error(`worldSeedPath: no seed survives normalizeSeed(${JSON.stringify(typed)}); the engine would roll a random one`);
  return canonicalize(seed, segments);
}

/** parseSeedPath(path) → { root, segments }. Only CANONICAL paths parse: a
 *  path whose root is seed-shaped but not normalized ("k7qn-3f2a-9xbd/x") is
 *  rejected, because the string a caller hashes must be the string the path
 *  names — silently normalizing here would let hash64(path) and
 *  streamFor(path) disagree about which stream the same text means. */
export function parseSeedPath(path) {
  if (typeof path !== "string") throw new TypeError(`parseSeedPath: path must be a string, got ${typeof path}`);
  const parts = path.split(SEP);
  const root = parts[0];
  const segments = parts.slice(1);
  const canon = canonicalize(root, segments);
  if (canon !== path) throw new Error(`parseSeedPath: ${JSON.stringify(path)} is not canonical; seedPath gives ${JSON.stringify(canon)}`);
  return { root, segments };
}

/* ── FNV-1a / 64 in two uint32 limbs ──────────────────────────────────────
   offset basis 0xcbf29ce484222325, prime 0x100000001b3 = 2^40 + 0x1b3.
   h·prime mod 2^64 = h·0x1b3 + (h << 40). The first term is the low limb
   times 0x1b3 split into 16-bit halves (each partial product < 2^26) plus
   the high limb times 0x1b3 by Math.imul; the second only touches the high
   limb, as lo << 8. */
const FNV64_HI = 0xcbf29ce4;
const FNV64_LO = 0x84222325;
const FNV64_P = 0x1b3;

/** hash64(str) → { hi, lo }, FNV-1a 64-bit over UTF-16 code units, as two
 *  uint32 limbs. A non-string throws TypeError, as seedPath does: String(x)
 *  would hash undefined as "undefined", and the Python port has no such
 *  coercion to agree with. */
export function hash64(str) {
  if (typeof str !== "string") throw new TypeError(`hash64: expected a string, got ${typeof str}`);
  const s = str;
  let hi = FNV64_HI, lo = FNV64_LO;
  for (let i = 0; i < s.length; i++) {
    lo = (lo ^ s.charCodeAt(i)) >>> 0;
    const p0 = (lo & 0xffff) * FNV64_P;
    const p1 = (lo >>> 16) * FNV64_P + (p0 >>> 16);
    hi = (Math.imul(hi, FNV64_P) + (p1 >>> 16) + (lo << 8)) >>> 0;
    lo = (((p1 & 0xffff) << 16) | (p0 & 0xffff)) >>> 0;
  }
  return { hi, lo };
}

/** hex64({ hi, lo }) → 16 lowercase hex digits, high limb first. */
export function hex64(h) {
  return (h.hi >>> 0).toString(16).padStart(8, "0") + (h.lo >>> 0).toString(16).padStart(8, "0");
}

/** hash64Hex(str) → hex64(hash64(str)). */
export function hash64Hex(str) {
  return hex64(hash64(str));
}

/* ── v2: splitmix32 → sfc32 ───────────────────────────────────────────── */

/** splitmix32(state) → () => uint32. The 32-bit SplitMix finalizer (golden
 *  increment 0x9e3779b9, multipliers 0x21f0aaad and 0x735a2d97). Exported
 *  because it is part of the seeding contract a port has to reproduce. */
export function splitmix32(state) {
  let s = state | 0;
  const next = () => {
    s = (s + 0x9e3779b9) | 0;
    let t = s ^ (s >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
  next.mix = (x) => { s = (s ^ x) | 0; };
  return next;
}

/** sfc32(a, b, c, d) → () => uint32. d is the counter. No warm-up here:
 *  streamFor does the seeding and the discard. */
export function sfc32(a, b, c, d) {
  a |= 0; b |= 0; c |= 0; d |= 0;
  return () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
}

const SFC32_DISCARD = 12;

/** v2State(h) → [a, b, c, d], the sfc32 seed state for a 64-bit hash. */
export function v2State(h) {
  const sm = splitmix32(h.lo);
  const a = sm(), b = sm();
  sm.mix(h.hi);
  const c = sm(), d = sm();
  return [a, b, c, d];
}

export const STREAM_MODES = Object.freeze(["v2", "legacy32"]);

/** streamFor(path, { mode = "v2" } = {}) → a () => [0,1) generator with a
 *  `.nextU32()` method drawing from the SAME stream (one call, one draw, in
 *  either form), and `.path` / `.mode` for whoever is debugging it.
 *
 *  `path` must be canonical (see parseSeedPath) and have at least one
 *  segment: a stream drawn from the bare root is the "everybody shares one
 *  stream" design the channel discipline exists to prevent.
 *
 *    legacy32  mulberry32(seedChannel(root, segments.join(":"))) — today's
 *              channelRng, bit for bit
 *    v2        sfc32 seeded from hash64(path) via splitmix32, 12 discarded */
export function streamFor(path, opts) {
  if (opts !== undefined && (opts === null || typeof opts !== "object")) {
    throw new TypeError(`streamFor: options must be an object like { mode: "v2" }, got ${opts === null ? "null" : typeof opts}`);
  }
  const mode = opts === undefined || opts.mode === undefined ? "v2" : opts.mode;
  const { root, segments } = parseSeedPath(path);
  if (segments.length === 0) throw new Error(`streamFor: ${JSON.stringify(path)} has no segments — name the channel`);
  let nextU32;
  if (mode === "legacy32") {
    const f = mulberry32(seedChannel(root, segments.join(IDX)));
    // mulberry32 returns u32 / 2^32, which is exact, so this recovers the u32.
    nextU32 = () => f() * 4294967296;
  } else if (mode === "v2") {
    const [a, b, c, d] = v2State(hash64(path));
    nextU32 = sfc32(a, b, c, d);
    for (let i = 0; i < SFC32_DISCARD; i++) nextU32();
  } else {
    throw new Error(`streamFor: unknown mode ${JSON.stringify(mode)}; expected one of ${STREAM_MODES.join(", ")}`);
  }
  const next = () => nextU32() / 4294967296;
  next.nextU32 = nextU32;
  next.path = path;
  next.mode = mode;
  return next;
}
