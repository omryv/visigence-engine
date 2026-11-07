// A world in a link. js/share.js puts a whole world file in a URL fragment,
// and a fragment is input from a stranger: so what is proved here is that a
// world survives the trip exactly, and that what is not a world — garbage, a
// truncated link, and above all a few kilobytes that inflate to gigabytes —
// is refused, quickly, with a FormatError that says which of those it was.
// The bomb test is apps/builder2d/tools/test/test-builder-templates.mjs's,
// ported: count what the decoder pulls out of the decompressor and hold it
// under a bound far below the bomb's size.
//
// Needs CompressionStream (Node ≥18, every current browser); jsc has none,
// and this file says so and skips.
import { test, eq, ok, report } from "../kernel/harness.js";
import { makeParams, mergeParams } from "../../../src/kernel/presets.js";
import { bakeHeightField } from "../../../src/kernel/terrain/heightfield.js";
import { makeUid } from "../../../src/genesis/world/fusion.js";
import { buildWorldFile, serializeWorldFile } from "../../../src/genesis/world/worldfile.js";
import { SEED_WORLD } from "./seed-world.js";
import { encodeWorldLink, decodeWorldLink, FormatError, MAX_LINK_BYTES } from "../../../src/genesis/world/share.js";

const clock = () => (globalThis.performance ? performance.now() : 0);

if (typeof CompressionStream !== "function" || typeof DecompressionStream !== "function") {
  print("share: skipped — this runtime has no CompressionStream (run under Node: RUNTIME=node sh tests/run.sh)");
} else {
  await main();
}

async function refusal(promise) {
  try { await promise; return null; } catch (e) { return e; }
}

async function main() {
  /* ── round trips ── */
  const defaultLink = await encodeWorldLink(SEED_WORLD);
  const defaultBack = await decodeWorldLink(defaultLink);

  /* A built-on world: a seed's own params with a statement in its intent, scored on a baked field, carrying
     procedural placements that share one geometry spec — the shape a composed town has, so the geometry table is
     exercised too. */
  const SEED = "K7QN-3F2A-9XBD";
  const params = mergeParams(makeParams({ seed: SEED }), { terrain: { intent: [{ type: "level", h: 30, op: ">=" }] } });
  const chair = { kind: "block", shape: "chair", parts: [
    { g: "box", pos: [0, 0.42, 0], size: [0.46, 0.06, 0.44], mat: "wood" },
    { g: "box", pos: [0, 0.72, -0.2], size: [0.46, 0.54, 0.06], mat: "wood" },
  ] };
  const props = Array.from({ length: 40 }, (_, i) => ({
    uid: makeUid(SEED, i), ref: "interior/chair", url: null, label: "Chair",
    position: [i * 1.25, 3.5, -i * 0.75], rotationY: i * 0.1, scale: 1, proc: chair,
  }));
  const generated = buildWorldFile({ params, propRecords: props, field: bakeHeightField(params, 129) });
  const generatedLink = await encodeWorldLink(generated);
  const generatedBack = await decodeWorldLink(generatedLink.slice(1)); // without its '#'

  /* The uncompressed fallback a platform without CompressionStream writes. */
  const Real = { C: globalThis.CompressionStream, D: globalThis.DecompressionStream };
  globalThis.CompressionStream = undefined;
  let plainLink;
  try { plainLink = await encodeWorldLink(SEED_WORLD); } finally { globalThis.CompressionStream = Real.C; }
  const plainBack = await decodeWorldLink(plainLink);
  globalThis.DecompressionStream = undefined;
  let noInflate;
  try { noInflate = await refusal(decodeWorldLink(defaultLink)); } finally { globalThis.DecompressionStream = Real.D; }

  /* ── the bomb ──
     64 MB of zeros, deflated, as a link. Wrapped so the test counts every
     byte the decoder pulls out of the decompressor. */
  const zeros = new Uint8Array(64 * 1024 * 1024);
  const deflated = new Uint8Array(await new Response(new Blob([zeros]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  let bin = "";
  for (let i = 0; i < deflated.length; i += 0x8000) bin += String.fromCharCode.apply(null, deflated.subarray(i, i + 0x8000));
  const bombLink = "#world=1." + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  let inflated = 0;
  globalThis.DecompressionStream = class {
    constructor(format) {
      const d = new Real.D(format);
      this.writable = d.writable;
      this.readable = d.readable.pipeThrough(new TransformStream({ transform(chunk, out) { inflated += chunk.length; out.enqueue(chunk); } }));
    }
  };
  let bomb, bombMs;
  try {
    const t0 = clock();
    bomb = await refusal(decodeWorldLink(bombLink));
    bombMs = clock() - t0;
  } finally { globalThis.DecompressionStream = Real.D; }

  /* ── garbage, each kind ── */
  const enc = (s) => { let b = ""; for (const c of new TextEncoder().encode(s)) b += String.fromCharCode(c); return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const garbage = [
    ["an empty string", "", "prefix"],
    ["some other fragment", "#section-2", "prefix"],
    ["another key", "#game=1.abcd", "prefix"],
    ["an unknown codec", "#world=2.abcd", "prefix"],
    ["characters base64url does not have", "#world=1.ab+/cd", "prefix"],
    ["base64 that cannot be", "#world=0.a", "base64"],
    ["random bytes claiming deflate", "#world=1." + enc("ÿþ this is not deflate at all"), "inflate"],
    // Cut on a base64 quantum, so it is the DEFLATE stream that ends early
    // rather than the base64 (which is the row above).
    ["a truncated compressed world", "#world=1." + defaultLink.slice(9, 9 + 4 * Math.floor((defaultLink.length - 9) / 8)), "inflate"],
    ["bytes that are not UTF-8", "#world=0.__79", "utf8"],
    ["text that is not JSON", "#world=0." + enc("hello"), "json"],
    ["JSON that is not a world", "#world=0." + enc(JSON.stringify({ kind: "something-else" })), "world"],
    ["a world with its version bent", "#world=0." + enc(JSON.stringify({ ...SEED_WORLD, fileVersion: 99 })), "world"],
    // Shapes validateWorldFile once threw a TypeError on (the M4 review).
    ["a world whose props is a number", "#world=0." + enc(JSON.stringify({ ...SEED_WORLD, world: { ...SEED_WORLD.world, props: 5 } })), "world"],
    ["a world with a null placement", "#world=0." + enc(JSON.stringify({ ...SEED_WORLD, world: { ...SEED_WORLD.world, props: [null] } })), "world"],
    ["a world whose world is a list", "#world=0." + enc(JSON.stringify({ ...SEED_WORLD, world: [1, 2] })), "world"],
    ["a link longer than any capped world", "#world=0." + "A".repeat(3 * 1024 * 1024), "too-long"],
  ];
  const garbageOut = [];
  for (const [name, link, code] of garbage) garbageOut.push([name, code, await refusal(decodeWorldLink(link))]);
  const tight = await refusal(decodeWorldLink(defaultLink, { maxBytes: 1024 }));

  /* ════════════ assertions ════════════ */

  test("the default world round-trips through a link, exactly", () => {
    ok(defaultLink.startsWith("#world=1."), defaultLink.slice(0, 12));
    eq(serializeWorldFile(defaultBack), serializeWorldFile(SEED_WORLD));
    const raw = JSON.stringify(SEED_WORLD).length;
    print(`    default world: ${raw} bytes of JSON → a ${defaultLink.length}-character link`);
  });

  test("a generated world file round-trips through a link, exactly", () => {
    eq(serializeWorldFile(generatedBack), serializeWorldFile(generated));
    eq(generated.procs.length, 1, "forty chairs, one geometry spec");
    eq(generatedBack.world.props.length, 40);
    ok(generatedBack.world.params.terrain.intent !== undefined, "the intent travelled");
    const raw = JSON.stringify(generated).length;
    print(`    ${SEED} with a statement, 40 placements: ${raw} bytes of JSON → a ${generatedLink.length}-character link`);
  });

  test("the uncompressed fallback round-trips, and a compressed link says why it cannot open without an inflater", () => {
    ok(plainLink.startsWith("#world=0."), plainLink.slice(0, 12));
    eq(serializeWorldFile(plainBack), serializeWorldFile(SEED_WORLD));
    ok(noInflate instanceof FormatError && noInflate.code === "no-inflate", `${noInflate && noInflate.message}`);
  });

  test("a 64 MB bomb is refused before it is inflated, quickly", () => {
    ok(bomb instanceof FormatError, `not refused as a FormatError: ${bomb}`);
    eq(bomb.code, "too-large", bomb.message);
    ok(inflated < 16 * 1024 * 1024, `inflated ${inflated} bytes of the 64 MB`);
    ok(inflated > MAX_LINK_BYTES, "the cap is what stopped it, not an early failure");
    ok(bombMs < 2000, `took ${bombMs.toFixed(0)} ms`);
    print(`    bomb: a ${bombLink.length}-character link for 64 MiB; refused after inflating ${inflated} bytes, in ${bombMs.toFixed(0)} ms`);
  });

  test("garbage is refused with a FormatError naming what went wrong", () => {
    for (const [name, code, err] of garbageOut) {
      ok(err instanceof FormatError, `${name}: not a FormatError (${err})`);
      eq(err.code, code, `${name}: ${err && err.message} —`);
      ok(typeof err.message === "string" && err.message.length > 10, `${name}: no sentence`);
    }
    ok(tight instanceof FormatError && tight.code === "too-large", "a cap of 1 KiB refuses the default world");
  });
}

report("share");
