// The shared seed vectors are what the JS computes today.
//
// tools/test/kernel/vectors/seed-vectors.json is the contract every port of the seed
// algebra is checked against (tools/kernel/py/check_vectors.py today). This file
// regenerates it in memory and compares byte for byte, so a change to the
// algebra that forgets to regenerate the vectors fails here, and then
// recomputes every field from src/kernel/seed.js and src/kernel/core/seedpath.js
// directly, so the file cannot be "up to date" with a generator that is
// itself wrong.
//
// It also carries the placements rows (src/kernel/terrain/fingerprint.js
// placementsHash, ported in tools/kernel/py/genesis_placements.py), recomputed here
// from the parsed file the same way.
//
// Split from seedpath.test.js because it needs node:fs (and the generator
// needs node:path and node:url). tests/run.sh skips it under JavaScriptCore
// and says so; seedpath.test.js, which holds the algebra's own claims, runs
// on both.
import { test, eq, ok, report } from "./harness.js";
import { readFileSync } from "node:fs";
import { hashSeed, seedChannel, mulberry32, normalizeSeed } from "../../../src/kernel/seed.js";
import { seedPath, worldSeedPath, parseSeedPath, hash64, hash64Hex, v2State, streamFor } from "../../../src/kernel/core/seedpath.js";
import { canonicalPlacements, placementsHash } from "../../../src/kernel/terrain/fingerprint.js";
import { buildVectors, render, INVALID, PLACEMENTS_INVALID } from "../../kernel/seed-vectors.mjs";

const VECTORS_TEXT = readFileSync(new URL("./vectors/seed-vectors.json", import.meta.url), "utf8");
const V = JSON.parse(VECTORS_TEXT);

const throws = (fn) => { try { fn(); } catch { return true; } return false; };

test("the committed vectors are exactly what the generator writes today", () => {
  eq(render(buildVectors()), VECTORS_TEXT, "tools/test/kernel/vectors/seed-vectors.json is stale — run node tools/kernel/seed-vectors.mjs;");
});

test("every vector field recomputes from src/kernel/seed.js and seedpath.js", () => {
  ok(V.entries.length >= 12, `only ${V.entries.length} entries`);
  for (const e of V.entries) {
    const p = seedPath(e.input.root, ...e.input.segments);
    eq(p, e.path, "path");
    const { root, segments } = parseSeedPath(p);
    eq(root, e.root, `${p} root`);
    eq(hashSeed(root), e.hashSeed, `${p} hashSeed`);
    for (const c of ["terrain", "erosion", "props"]) eq(seedChannel(root, c), e.seedChannel[c], `${p} seedChannel ${c}`);
    const ls = seedChannel(root, segments.join(":"));
    eq(ls, e.legacy32Seed, `${p} legacy32Seed`);
    // legacy32 draws, recomputed from mulberry32 itself rather than via streamFor
    const m = mulberry32(ls);
    for (let i = 0; i < V.draws; i++) eq(m() * 4294967296, e.legacy32[i], `${p} legacy32[${i}]`);
    eq(hash64Hex(p), e.hash64, `${p} hash64`);
    const st = v2State(hash64(p));
    for (let i = 0; i < 4; i++) eq(st[i], e.v2State[i], `${p} v2State[${i}]`);
    const v = streamFor(p);
    for (let i = 0; i < V.draws; i++) eq(v.nextU32(), e.v2[i], `${p} v2[${i}]`);
  }
  for (const w of V.world) {
    eq(worldSeedPath(w.typed, ...w.segments), w.path, `world ${w.typed}`);
    eq(w.path.split("/")[0], normalizeSeed(w.typed), `world ${w.typed} root is the engine's`);
  }
});

test("the vectors cover what a port gets wrong first", () => {
  const paths = V.entries.map((e) => e.path);
  ok(V.entries.some((e) => e.input.root !== e.root), "no entry exercises root normalization");
  ok(V.entries.some((e) => e.input.root === "k7qn-3f2a-9xbd"), "no lowercase seed");
  ok(V.entries.some((e) => e.input.segments.length >= 3), "no multi-segment path");
  ok(paths.some((p) => /[^\x00-\x7f]/.test(p)), "no non-ASCII segment");
  ok(paths.some((p) => /[\ud800-\udbff]/.test(p)), "no astral (surrogate-pair) segment");
  ok(V.entries.some((e) => !/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(e.root)), "no verbatim root");
  ok(V.invalid.length >= 10, "too few refusals recorded");
  ok(V.invalid.some((x) => x.segments.some((s) => s.length > 4300)), "no index past Python's int() digit limit");
  ok(V.invalid.some((x) => x.segments.some((s) => /[\u00a0\u2028\ufeff\u200b]/.test(s))), "no invisible-character refusal");
  const roots = V.world.map((w) => w.typed.replace(/[^A-Za-z0-9]/g, "").length);
  ok(roots.some((n) => n < 12) && roots.some((n) => n > 12), "world rows need a short and a long typed seed");
});

test("seedPath refuses every recorded invalid input", () => {
  eq(V.invalid.length, INVALID.length);
  for (const { root, segments } of V.invalid) {
    ok(throws(() => seedPath(root, ...segments)), `accepted ${JSON.stringify([root, segments]).slice(0, 80)}`);
  }
});

test("the placements rows recompute from fingerprint.js, and cover what a port gets wrong", () => {
  /* From the PARSED file, not the generator's in-memory lists: the records a
     port receives are what JSON carries (−0 arrives as 0, keys in file order),
     and the canonical text must not care. */
  ok(V.placements.length >= 4, `only ${V.placements.length} placements rows`);
  for (const [i, p] of V.placements.entries()) {
    eq(canonicalPlacements(p.records), p.canonical, `placements[${i}] canonical`);
    eq(placementsHash(p.records), p.hash, `placements[${i}] hash`);
  }
  const texts = V.placements.map((p) => p.canonical);
  ok(texts.some((t) => /[\ud800-\udbff]/.test(t)), "no astral character");
  ok(texts.some((t) => /[\u0080-\ud7ff\ue000-\uffff]/.test(t)), "no BMP non-ASCII text");
  ok(texts.some((t) => /\\u00[01]/.test(t)), "no escaped control character");
  // The astral-vs-U+FF01 row is in code-unit order, which is not code-point order.
  ok(texts.includes('[{"uid":"\u{1F600}"},{"uid":"\uff01"}]'), "the code-unit ordering row is missing or reordered");
  eq(V.placementsInvalid.length, PLACEMENTS_INVALID.length);
  for (const { records } of V.placementsInvalid) {
    ok(throws(() => placementsHash(records)), `accepted ${JSON.stringify(records)}`);
  }
});

report("seed-vectors");
