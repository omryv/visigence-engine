// Seed paths: one grammar, one 64-bit hash, two stream modes — and the proof
// that the old mode IS the old streams.
//
// The claim this file exists to hold is "legacy32 reproduces today's streams
// bit for bit". It is checked the only way that means anything: against
// src/kernel/seed.js's own channelRng, for every channel name the tree already
// uses that the grammar can express, over ten thousand draws each. A
// legacy mode that agrees for the first draw and drifts on the hundredth is a
// different world three stages downstream, so "many draws" is the point.
//
// The second claim — that the shared vectors in tools/test/kernel/vectors/ are what the
// JS computes today — lives in seed-vectors.test.js, because reading a file
// needs node:fs. This file imports nothing but the modules under test and the
// harness, so it runs under JavaScriptCore as well as Node: the algebra is
// core, and core is meant to be checked on both.
import { test, eq, ok, close, report } from "./harness.js";
import { hashSeed, seedChannel, channelRng, mulberry32, normalizeSeed } from "../../../src/kernel/seed.js";
import {
  seedPath, worldSeedPath, parseSeedPath, isSeedShaped, hash64, hex64, hash64Hex,
  splitmix32, sfc32, v2State, streamFor, STREAM_MODES,
} from "../../../src/kernel/core/seedpath.js";
import * as core from "../../../src/kernel/core/index.js";

const throws = (fn) => { try { fn(); } catch { return true; } return false; };

/* ── hash64 ─────────────────────────────────────────────────────────────── */

test("hash64 is FNV-1a/64: the published test values", () => {
  // From the FNV reference test suite (Fowler/Noll/Vo): offset basis for "",
  // and the two most-quoted single values.
  eq(hash64Hex(""), "cbf29ce484222325");
  eq(hash64Hex("a"), "af63dc4c8601ec8c");
  eq(hash64Hex("foobar"), "85944171f73967e8");
});

test("hash64's 32-bit limbs agree with a BigInt FNV on 3000 strings", () => {
  const P = 0x100000001b3n, M = (1n << 64n) - 1n;
  const big = (s) => {
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < s.length; i++) h = ((h ^ BigInt(s.charCodeAt(i))) * P) & M;
    return h;
  };
  const r = mulberry32(0x5eed);
  for (let n = 0; n < 3000; n++) {
    let s = "";
    const len = (r() * 40) | 0;
    // every width of code unit: ASCII, Latin-1, BMP, and raw surrogate halves
    for (let k = 0; k < len; k++) s += String.fromCharCode([0x7f, 0xff, 0xffff][(r() * 3) | 0] * r() | 0);
    const h = hash64(s);
    const want = big(s);
    eq(h.hi, Number(want >> 32n), `hi of #${n}`);
    eq(h.lo, Number(want & 0xffffffffn), `lo of #${n}`);
    eq(hex64(h), want.toString(16).padStart(16, "0"), `hex of #${n}`);
  }
});

test("hash64 reads UTF-16 code units, the same unit hashSeed reads", () => {
  // A surrogate pair is two units to both hashes; hashing the two halves as a
  // string of their own gives the same value.
  const tree = "\u{1F332}";
  eq(tree.length, 2);
  eq(hash64Hex(tree), hash64Hex("\ud83c" + "\udf32"));
  eq(hashSeed(tree), hashSeed("\ud83c" + "\udf32"));
});

/* ── legacy32 is today's streams ────────────────────────────────────────── */

const SEEDS = ["K7QN-3F2A-9XBD", "ZZ11-0000-AAAA", "2222-2222-2222", "AB12-CD34-EF56", "unseeded"];
const DRAWS = 10000;

test("legacy32 == channelRng for every one-segment channel in the tree, 10 000 draws", () => {
  // The channel literals engine/ and js/ pass to seedChannel / channelRng today
  // that are grammatical one-segment names.
  const channels = ["terrain", "erosion", "climate", "detail", "landform", "spawn-yaw", "headless", "prop:3"];
  for (const seed of SEEDS) for (const ch of channels) {
    const a = streamFor(seedPath(seed, ch), { mode: "legacy32" });
    const b = channelRng(seed, ch);
    for (let i = 0; i < DRAWS; i++) {
      const x = a(), y = b();
      if (x !== y) throw new Error(`${seed}/${ch} draw ${i}: ${x} vs ${y}`);
    }
  }
});

test("legacy32 multi-segment paths are today's compound channels", () => {
  const pairs = [
    [["world", "grass"], "world:grass"],              // js/worlds.js
    [["landform", "planting"], "landform:planting"],  // js/landform.js
    [["landform", "woods"], "landform:woods"],
    [["compose", "river:3"], "compose:river:3"],      // js/compose.js shape
    [["detail", "turf"], "detail:turf"],              // engine/terrain/detail-layers.js
    [["scatter", "pine"], "scatter:pine"],            // engine/props/Scatter.js shape
    [["grass", "5", "-3", "7"], "grass:5:-3:7"],      // engine/props/grass.js: a negative
                                                      // coordinate is a NAME, not an index
  ];
  for (const seed of SEEDS) for (const [segs, ch] of pairs) {
    const a = streamFor(seedPath(seed, ...segs), { mode: "legacy32" });
    const b = channelRng(seed, ch);
    for (let i = 0; i < 2000; i++) eq(a(), b(), `${seed} ${ch} draw ${i}`);
  }
});

test("nextU32 and the float draw from ONE stream, in either mode", () => {
  for (const mode of STREAM_MODES) {
    const p = "K7QN-3F2A-9XBD/terrain";
    const mixed = streamFor(p, { mode }), ints = streamFor(p, { mode });
    for (let i = 0; i < 1000; i++) {
      const u = ints.nextU32();
      ok(Number.isInteger(u) && u >= 0 && u < 4294967296, `${mode} u32 out of range: ${u}`);
      if (i % 2) eq(mixed.nextU32(), u, `${mode} draw ${i}`);
      else eq(mixed(), u / 4294967296, `${mode} draw ${i}`);
    }
    eq(mixed.mode, mode);
    eq(mixed.path, p);
  }
});

test("a lowercase or spaced seed lands on the engine's normalized stream", () => {
  const a = streamFor(seedPath(" k7qn 3f2a_9xbd ", "terrain"), { mode: "legacy32" });
  const b = channelRng(normalizeSeed(" k7qn 3f2a_9xbd "), "terrain");
  for (let i = 0; i < 1000; i++) eq(a(), b(), `draw ${i}`);
});

test("a typed seed that is not twelve characters: seedPath keeps it, worldSeedPath is the engine's", () => {
  // The engine pads a short seed and truncates a long one (setSeed:
  // normalizeSeed(seed) || randomSeed()). seedPath does neither — pinned here
  // so nobody "fixes" it into padding "unseeded" — and worldSeedPath does
  // exactly what the engine does.
  const cases = [
    ["hello", "HELL-O222-2222"],              // fewer than twelve
    ["k7qn-3f2a", "K7QN-3F2A-2222"],
    ["K7QN3F2A9XBDQ", "K7QN-3F2A-9XBD"],      // more than twelve
    ["K7QN-3F2A-9XBD-ZZ", "K7QN-3F2A-9XBD"],
  ];
  for (const [typed, engineRoot] of cases) {
    eq(normalizeSeed(typed), engineRoot, `normalizeSeed(${typed})`);
    eq(seedPath(typed, "terrain"), typed + "/terrain", `seedPath keeps ${typed} verbatim`);
    const w = worldSeedPath(typed, "terrain");
    eq(w, engineRoot + "/terrain", `worldSeedPath(${typed})`);
    const a = streamFor(w, { mode: "legacy32" }), b = channelRng(engineRoot, "terrain");
    for (let i = 0; i < 1000; i++) eq(a(), b(), `${typed} draw ${i}`);
    const raw = streamFor(seedPath(typed, "terrain"), { mode: "legacy32" })();
    ok(raw !== channelRng(engineRoot, "terrain")(), `${typed}: the verbatim root happened to be the engine's stream`);
  }
  eq(worldSeedPath("k7qn 3f2a 9xbd", "world", "grass"), "K7QN-3F2A-9XBD/world/grass");
  // where the engine would roll a random seed, worldSeedPath refuses
  ok(throws(() => worldSeedPath("", "terrain")), "empty typed seed");
  ok(throws(() => worldSeedPath("!!!", "terrain")), "no letters or digits");
  ok(throws(() => worldSeedPath(undefined, "terrain")), "undefined");
});

/* ── v2 ─────────────────────────────────────────────────────────────────── */

test("v2 is the default and is not legacy32", () => {
  for (const seed of SEEDS) for (const ch of ["terrain", "erosion", "props", "room:0"]) {
    const p = seedPath(seed, ch);
    const d = streamFor(p), v = streamFor(p, { mode: "v2" }), l = streamFor(p, { mode: "legacy32" });
    let same = 0;
    for (let i = 0; i < DRAWS; i++) {
      const x = v.nextU32();
      eq(d.nextU32(), x, `${p} default != v2 at ${i}`);
      if (x === l.nextU32()) same++;
    }
    // 10 000 positions, each a 1-in-2^32 chance of agreeing by accident
    ok(same <= 1, `${p}: v2 and legacy32 agree at ${same} of ${DRAWS} positions`);
  }
});

test("v2 floats are in [0,1) and look uniform", () => {
  const v = streamFor("K7QN-3F2A-9XBD/props");
  let sum = 0, lo = 1, hi = 0;
  const bins = new Array(16).fill(0);
  const N = 160000;
  for (let i = 0; i < N; i++) {
    const x = v();
    sum += x; lo = Math.min(lo, x); hi = Math.max(hi, x);
    bins[(x * 16) | 0]++;
  }
  ok(lo >= 0 && hi < 1, `range [${lo}, ${hi}]`);
  close(sum / N, 0.5, 0.005, "mean");
  for (const b of bins) ok(Math.abs(b - N / 16) < 5 * Math.sqrt(N / 16), `bin count ${b}`);
});

test("v2 seeds all four sfc32 words from both hash limbs", () => {
  // equal limbs must not give equal halves of the state
  const st = v2State({ hi: 0x12345678, lo: 0x12345678 });
  ok(st[0] !== st[2] && st[1] !== st[3], `state ${st}`);
  // changing only hi leaves a,b and moves c,d
  const a = v2State({ hi: 1, lo: 7 }), b = v2State({ hi: 2, lo: 7 });
  eq(a[0], b[0]); eq(a[1], b[1]);
  ok(a[2] !== b[2] && a[3] !== b[3], "hi did not reach c, d");
  // splitmix32 and sfc32 are plain uint32 generators
  const sm = splitmix32(0), g = sfc32(1, 2, 3, 4);
  for (let i = 0; i < 100; i++) {
    const x = sm(), y = g();
    ok(Number.isInteger(x) && x >= 0 && x < 4294967296);
    ok(Number.isInteger(y) && y >= 0 && y < 4294967296);
  }
});

test("neighbouring paths give unrelated v2 streams", () => {
  // the twelve-draw discard is what keeps "room:1" and "room:2" apart from the
  // first value; count agreeing bits across the first draw of 2000 neighbours
  let bits = 0;
  for (let i = 0; i < 2000; i++) {
    const a = streamFor(`K7QN-3F2A-9XBD/room:${i}`).nextU32();
    const b = streamFor(`K7QN-3F2A-9XBD/room:${i + 1}`).nextU32();
    let x = (a ^ b) >>> 0;
    while (x) { bits += x & 1; x >>>= 1; }
  }
  close(bits / 2000, 16, 0.5, "mean differing bits");
});

/* ── grammar ────────────────────────────────────────────────────────────── */

test("seedPath builds canonical paths", () => {
  eq(seedPath("K7QN-3F2A-9XBD"), "K7QN-3F2A-9XBD");
  eq(seedPath("k7qn-3f2a-9xbd", "terrain"), "K7QN-3F2A-9XBD/terrain");
  eq(seedPath("k7qn3f2a9xbd", "compose", "river:3"), "K7QN-3F2A-9XBD/compose/river:3");
  eq(seedPath("AB12.CD34.EF56", "room:0"), "AB12-CD34-EF56/room:0");
  eq(seedPath("unseeded", "terrain"), "unseeded/terrain");
  eq(seedPath("K7QN", "terrain"), "K7QN/terrain", "a short root is verbatim, not padded");
  eq(seedPath("K7QN-3F2A-9XBD", "café", "森:9007199254740991"), "K7QN-3F2A-9XBD/café/森:9007199254740991");
  ok(isSeedShaped("mountainpass") && !isSeedShaped("unseeded") && !isSeedShaped("k7qn3f2a9xbd\n"));
});

test("seedPath refuses everything the grammar does not name", () => {
  // (the full shared refusal list is tools/test/kernel/vectors/seed-vectors.json's
  // `invalid`, checked by seed-vectors.test.js and by the Python port)
  for (const seg of ["", "a/b", "room:", "room:01", "room:-1", "room:1:2", "room:9007199254740992", "two words", "\ud800x", "x\udc00"]) {
    ok(throws(() => seedPath("K7QN-3F2A-9XBD", seg)), `accepted ${JSON.stringify(seg)}`);
  }
  ok(throws(() => seedPath("K7QN-3F2A-9XBD", "room:" + "1".repeat(5000))), "a 5000-digit index");
  ok(throws(() => seedPath("", "terrain")) && throws(() => seedPath("root:x", "terrain")), "bad roots");
  ok(throws(() => seedPath(42, "terrain")), "a number root");
  ok(throws(() => seedPath("K7QN-3F2A-9XBD", 3)), "a number segment");
  ok(throws(() => seedPath(null)), "a null root");
  // the message names the problem
  let msg = "";
  try { seedPath("K7QN-3F2A-9XBD", "room:01"); } catch (e) { msg = e.message; }
  ok(/leading zeros/.test(msg), msg);
});

test("the banned code units are refused, and their neighbours are not", () => {
  // every banned unit of the header, one by one, in a name and in a root
  const banned = [];
  for (let c = 0; c <= 0x20; c++) banned.push(c);
  for (let c = 0x7f; c <= 0xa0; c++) banned.push(c);
  banned.push(0xad, 0x1680, 0x3000, 0xfeff);
  for (let c = 0x2000; c <= 0x200f; c++) banned.push(c);
  for (let c = 0x2028; c <= 0x202f; c++) banned.push(c);
  for (let c = 0x205f; c <= 0x2064; c++) banned.push(c);
  for (let c = 0x2066; c <= 0x2069; c++) banned.push(c);
  for (const c of banned) {
    const ch = String.fromCharCode(c);
    ok(throws(() => seedPath("K7QN-3F2A-9XBD", "a" + ch + "b")), `name accepted U+${c.toString(16)}`);
    ok(throws(() => seedPath("w" + ch + "x", "terrain")), `root accepted U+${c.toString(16)}`);
  }
  // the units on either side of each banned range are ordinary characters
  for (const c of [0x21, 0x7e, 0xa1, 0xac, 0xae, 0x167f, 0x1681, 0x1fff, 0x2010, 0x2027, 0x2030, 0x205e, 0x2065, 0x206a, 0x2fff, 0x3001, 0xfefe, 0xff00]) {
    const ch = String.fromCharCode(c);
    if (ch === "/" || ch === ":") continue;
    eq(seedPath("K7QN-3F2A-9XBD", "a" + ch + "b"), "K7QN-3F2A-9XBD/a" + ch + "b", `U+${c.toString(16)}`);
  }
});

test("parseSeedPath accepts only canonical paths", () => {
  const p = parseSeedPath("K7QN-3F2A-9XBD/compose/river:3");
  eq(p.root, "K7QN-3F2A-9XBD");
  eq(p.segments.join("|"), "compose|river:3");
  ok(throws(() => parseSeedPath("k7qn-3f2a-9xbd/terrain")), "unnormalized root");
  ok(throws(() => parseSeedPath("K7QN-3F2A-9XBD//terrain")), "empty segment");
  ok(throws(() => parseSeedPath("K7QN-3F2A-9XBD/terrain/")), "trailing slash");
  // a path far longer than any argument list: parsed without spreading
  const segs = Array.from({ length: 200000 }, (_, i) => "s" + i);
  eq(parseSeedPath("K7QN-3F2A-9XBD/" + segs.join("/")).segments.length, 200000);
});

test("streamFor needs a channel and a known mode", () => {
  ok(throws(() => streamFor("K7QN-3F2A-9XBD")), "bare root");
  ok(throws(() => streamFor("K7QN-3F2A-9XBD/terrain", { mode: "v3" })), "unknown mode");
  ok(throws(() => streamFor("k7qn-3f2a-9xbd/terrain")), "non-canonical path");
  let msg = "";
  try { streamFor("K7QN-3F2A-9XBD/terrain", null); } catch (e) { msg = e.message; }
  ok(/options must be an object/.test(msg), `null options: ${msg}`);
  eq(streamFor("K7QN-3F2A-9XBD/terrain", {}).mode, "v2", "empty options");
});

test("hash64 takes strings only, like seedPath", () => {
  for (const bad of [undefined, null, 123, ["a"], { toString: () => "a" }]) {
    let err = null;
    try { hash64(bad); } catch (e) { err = e; }
    ok(err instanceof TypeError, `hash64(${String(bad)}) did not throw TypeError`);
  }
});

/* ── determinism, and why 64 bits ───────────────────────────────────────── */

test("the same path is the same stream; a different path is not", () => {
  for (const mode of STREAM_MODES) {
    const a = streamFor("K7QN-3F2A-9XBD/森/山:2", { mode }), b = streamFor("K7QN-3F2A-9XBD/森/山:2", { mode });
    for (let i = 0; i < DRAWS; i++) eq(a.nextU32(), b.nextU32(), `${mode} draw ${i}`);
  }
  ok(streamFor("K7QN-3F2A-9XBD/a/b:1")() !== streamFor("K7QN-3F2A-9XBD/a/b/1")(),
    "v2 tells a/b:1 from a/b/1");
  // legacy32 cannot, by construction: both are channel "a:b:1"
  eq(streamFor("K7QN-3F2A-9XBD/a/b:1", { mode: "legacy32" })(), streamFor("K7QN-3F2A-9XBD/a/b/1", { mode: "legacy32" })());
});

test("the collision figures in seedpath.js's header", () => {
  const p = (n) => 1 - Math.exp(-n * (n - 1) / 2 ** 33);
  close(p(10000), 0.0116, 0.00005, "10 000 streams");
  eq(Math.round(1 / p(10000)), 86);
  close(p(100000), 0.69, 0.005, "100 000 streams");
  // and measured: 200 000 distinct random names under one seed
  const r = mulberry32(7), names = new Set(), A = "abcdefghijklmnopqrstuvwxyz";
  while (names.size < 200000) {
    let w = "";
    const L = 4 + ((r() * 8) | 0);
    for (let k = 0; k < L; k++) w += A[(r() * 26) | 0];
    names.add(w + ":" + ((r() * 1000) | 0));
  }
  const s32 = new Set(), s64 = new Set();
  let c32 = 0, c64 = 0;
  for (const w of names) {
    const h = seedChannel("K7QN-3F2A-9XBD", w);
    if (s32.has(h)) c32++; else s32.add(h);
    const g = hash64Hex(seedPath("K7QN-3F2A-9XBD", w));
    if (s64.has(g)) c64++; else s64.add(g);
  }
  eq(c32, 9, "32-bit channel collisions");
  eq(c64, 0, "64-bit path collisions");
  close(200000 * 199999 / 2 / 2 ** 32, 4.66, 0.005, "expected 32-bit collisions");
});

test("the core index re-exports the seed path API", () => {
  for (const name of ["seedPath", "worldSeedPath", "parseSeedPath", "hash64", "hex64", "hash64Hex", "streamFor", "splitmix32", "sfc32", "v2State", "isSeedShaped", "STREAM_MODES"]) {
    ok(name in core, `src/kernel/core/index.js does not export ${name}`);
  }
  ok(core.CORE_MODULES.includes("src/kernel/core/seedpath.js"), "seedpath.js is not in CORE_MODULES");
});

report("seedpath");
