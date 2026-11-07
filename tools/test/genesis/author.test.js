/* The author interface (js/author.js): a document of statements compiled
 * into a world, and read back statement by statement.
 *
 * What is held here:
 *   - condition.js's per-record misses are the solve's own: their largest is
 *     the `miss` the sampler has always reported, to the bit, on a v1 list
 *     and a v2 one;
 *   - MET_TOLERANCE's measured case (the number its comment quotes);
 *   - a compile is the ordinary pipeline: its world file validates, its
 *     certificate verifies at tier 2, and a document with no statements
 *     compiles to the seed's own world — the same parameter hash and the
 *     same ground hash as makeParams(seed) baked directly;
 *   - a grammar's records come first and the statements keep their own
 *     indices; a missed statement is reported at ITS index, with its miss;
 *   - a grammar record the ground misses makes the world NOT met even when
 *     every statement is, and compile and explain say so with the same rows
 *     at the same indices;
 *   - explain reads back what compile reported, and walks; a bake grid over
 *     MAX_VERIFY_RES, from the file's ground block, is refused before any
 *     bake.
 *
 * Grids are 129² here (the certificate and the ground block are then at
 * 129², a legal grid of its own) to keep the file fast; the canonical 513²
 * compile is tests/overworld.test.js's. Not 65²: erosion is resolution-
 * dependent, and the default droplet budget on a 65² grid was measured
 * leaving no cell of this world walkable at all (walkableFraction 0; 0.35 at
 * 129², 0.62 at 257²). Needs WebCrypto (Node) for the signature.
 */
import { test, eq, ok, close, report } from "../kernel/harness.js";
import { readFileSync } from "node:fs";
import { makeParams, mergeParams } from "../../../src/kernel/presets.js";
import { createHeightSampler } from "../../../src/kernel/terrain/heightfield.js";
import { groundBundle } from "../../../src/kernel/terrain/ground.js";
import { terrainParameterHash } from "../../../src/kernel/terrain/fingerprint.js";
import { validateWorldFile } from "../../../src/genesis/world/worldfile.js";
import { verifyCertificate, MAX_VERIFY_RES } from "../../../src/genesis/world/certificate.js";
import { fullParams, WORLDS } from "../../../src/genesis/world/worlds.js";
import { compileIntent, explainWorld, paramsForIntent, MET_TOLERANCE, formatCompileReport, formatExplanation } from "../../../src/genesis/world/author.js";

const EXAMPLE = JSON.parse(readFileSync(new URL("../../../schema/examples/K7QN.intent.json", import.meta.url), "utf8"));
const RES = 129;
const doc = (statements, extra = {}) => ({ kind: "visigenesis.intent", version: 2, seed: "K7QN-3F2A-9XBD", statements, ...extra });

if (!globalThis.crypto?.subtle) {
  print("author: skipped — this runtime has no WebCrypto (run under Node: RUNTIME=node sh tests/run.sh)");
} else {
  await main();
}

async function main() {
  const made = await compileIntent(EXAMPLE, { res: RES });
  const v2 = await verifyCertificate(made.certificate, made.world, { tier: 2 });
  const empty = await compileIntent(doc([]), { res: RES });
  const far = await compileIntent(doc([{ type: "point", x: 0, z: 0, h: 120 }], { world: "farshore" }), { res: RES });
  /* A summit 50 m from a pad 140 m below it: an ask the lattice cannot
     express (condition.js RIDGE's own example), so one of them misses. */
  const torn = await compileIntent(doc([
    { type: "point", x: -1200, z: 900, h: 60 },
    { type: "summit", x: 300, z: 300, h: 180 },
    { type: "pad", x: 350, z: 300, r: 48, h: 40 },
  ]), { res: RES });
  const overridden = await compileIntent(doc([], { seed: "AAAA" }), { seed: "k7qn", res: RES });
  /* Farshore on K7QN brings one level record of its own (its land bar). With
     a point that must stand 400 m up and a wider level on top of it, both
     statements are kept and the grammar's own record is the one that gives:
     measured at 5.76 cm, over MET_TOLERANCE. */
  const offBar = await compileIntent(doc([
    { type: "point", x: 0, z: 0, h: 400, op: ">=" },
    { type: "level", h: 0, op: ">=", inset: 0.9 },
  ], { world: "farshore" }), { res: RES });

  test("a record's miss is the solve's own: the largest of them is the sampler's miss, on v1 and v2 lists", () => {
    for (const intent of [
      [{ type: "summit", x: 600, z: -400, h: 260 }, { type: "pad", x: -500, z: 300, r: 80, h: 40 }, { type: "level", h: 40 }, { type: "point", x: 0, z: 900, h: -20 }],
      EXAMPLE.statements,
      [{ type: "point", x: 0, z: 0, h: 100, op: ">=" }, { type: "corridor", points: [[0, 0], [800, 0]], maxGrade: 0.05 }],
    ]) {
      const s = createHeightSampler(mergeParams(makeParams({ seed: "K7QN-3F2A-9XBD" }), { terrain: { intent } }));
      const m = s.conditioning.system.misses;
      eq(m.length, intent.length, "one miss per record");
      eq(Math.max(...m), s.conditioning.miss, "the largest is the miss");
      ok(m.every((x) => x === null || x >= 0), "never negative");
    }
  });

  test("MET_TOLERANCE's measured case: a pad beside a summit, a level and a point misses by 2.0 cm", () => {
    const s = createHeightSampler(mergeParams(makeParams({ seed: "K7QN-3F2A-9XBD" }), { terrain: { intent: [
      { type: "summit", x: 600, z: -400, h: 260 }, { type: "pad", x: -500, z: 300, r: 80, h: 40 },
      { type: "level", h: 40 }, { type: "point", x: 0, z: 900, h: -20 },
    ] } }));
    close(s.conditioning.system.misses[1], 0.0200, 5e-4, "the pad");
    ok(s.conditioning.system.misses[1] < MET_TOLERANCE, "…which is met");
  });

  test("the example compiles to a valid world whose certificate verifies at tier 2", () => {
    eq(validateWorldFile(made.world).length, 0);
    eq(made.world.ground.res, RES);
    ok(v2.ok, JSON.stringify(v2.mismatches));
    eq(made.report.statements.length, EXAMPLE.statements.length);
    ok(made.report.statements.every((s) => s.stated && s.met), JSON.stringify(made.report.statements));
    ok(made.report.met && made.report.conditioning.converged);
    eq(made.report.parameterHash, terrainParameterHash(made.world.world.params));
    eq(made.report.certificate.sha256, made.certificate.subject.sha256);
    ok(formatCompileReport(made.report).includes("every statement met"));
  });

  test("no statements is the seed's own world: the same parameter hash and the same ground", () => {
    const p = makeParams({ seed: "K7QN-3F2A-9XBD" });
    eq(empty.report.conditioning, null);
    eq(empty.report.parameterHash, terrainParameterHash(p));
    eq(empty.report.ground.heightHash, groundBundle(p, { res: RES }).manifest.heightHash);
    ok(empty.report.met);
  });

  test("a named world is its grammar's params; its own records come first and the statements keep their indices", () => {
    const gram = fullParams(WORLDS.farshore, "K7QN-3F2A-9XBD");
    eq(far.report.grammarRecords, gram.terrain.intent.length);
    eq(far.world.origin, "farshore");
    eq(far.world.world.params.terrain.size, gram.terrain.size);
    eq(far.report.statements.length, 1);
    eq(far.report.statements[0].type, "point");
    eq(far.world.world.params.terrain.intent.length, gram.terrain.intent.length + 1);
  });

  test("a statement the ground cannot keep is reported at its own index, with its miss", () => {
    ok(!torn.report.met);
    const missed = torn.report.statements.filter((s) => !s.met);
    ok(missed.length >= 1, "something missed");
    ok(missed.every((s) => s.index === 1 || s.index === 2), `only the summit or the pad: ${JSON.stringify(missed)}`);
    ok(torn.report.statements[0].met, "the lone point still met");
    close(Math.max(...torn.report.statements.map((s) => s.miss)), torn.report.conditioning.miss, 0, "the worst is the solve's miss");
  });

  test("a grammar record the ground misses is reported, and the world is NOT met though every statement is", () => {
    const r = offBar.report;
    eq(r.grammarRecords, 1); eq(r.grammar.length, 1);
    ok(r.statements.every((s) => s.met), JSON.stringify(r.statements));
    eq(r.grammar[0].type, "level"); eq(r.grammar[0].index, 0);
    ok(!r.grammar[0].met, JSON.stringify(r.grammar));
    close(r.grammar[0].miss, 0.0576, 5e-4, "the measured miss");
    ok(r.grammar[0].miss > MET_TOLERANCE);
    eq(r.grammar[0].miss, r.conditioning.miss, "the grammar's record is the worst miss");
    ok(!r.met, "not met");
    ok(formatCompileReport(r).includes("[farshore 0]") && formatCompileReport(r).includes("NOT every statement met"));
    // explain on the written file: the same rows, at the same indices.
    const x = explainWorld(offBar.world);
    eq(JSON.stringify(x.grammar), JSON.stringify(r.grammar));
    eq(JSON.stringify(x.statements), JSON.stringify(r.statements));
    ok(!x.met);
    // A named world whose records the grammar's own already meet: an empty grammar list or every row met.
    ok(far.report.grammar.every((g) => g.met) && far.report.met === far.report.statements.every((s) => s.met));
    eq(JSON.stringify(explainWorld(far.world).statements), JSON.stringify(far.report.statements));
  });

  test("a seed passed in beats the document's, normalised", () => {
    eq(overridden.report.seed, "K7QN-2222-2222");
    eq(paramsForIntent(doc([]), { seed: "k7qn" }).seed, "K7QN-2222-2222");
  });

  let refused = null;
  try { await compileIntent(doc([{ type: "pad", x: 0, z: 0, r: 10, h: 5 }]), { res: RES }); } catch (e) { refused = e; }
  test("a document that does not compile is refused with its reasons, in its own terms", () => {
    ok(refused instanceof TypeError);
    ok(/statements\[0\]\.r 10/.test(refused.message), refused.message);
  });

  const e = explainWorld(made.world, { spawn: [-600, -400], objective: [400, -200] });
  const fromFile = explainWorld(made.world, { objective: [400, -200] });
  const quiet = explainWorld(made.world);
  test("explain reads back what compile reported", () => {
    eq(JSON.stringify(e.statements), JSON.stringify(made.report.statements));
    eq(e.conditioning.nats, made.report.conditioning.nats);
    ok(e.met);
    ok(e.sigma.postMedian < e.sigma.priorMedian, "the statements decided some of the ground");
    ok(e.sigma.atStatements < 0.01, `pinned at the statements: ${e.sigma.atStatements} m`);
    eq(e.ground.res, RES); eq(e.ground.matchesFile, true);
  });

  test("…and walks: reach from the spawn, par to the objective, the file's spawn when none is given", () => {
    ok(e.reach.walkable && e.reach.reachedCount > 0);
    ok(e.route.verdict !== "error", JSON.stringify(e.route.issues));
    ok(e.route.parSeconds >= e.route.distance / 6, "par is at least the flat walk (walk 6 m/s)");
    eq(fromFile.reach.spawnFrom, "file");
    eq(JSON.stringify(fromFile.reach.spawn), JSON.stringify([made.world.world.spawn.x, made.world.world.spawn.z]));
    eq(quiet.reach, null); eq(quiet.route, null); eq(quiet.ground, null);
    ok(formatExplanation(e).includes("par "));
  });

  test("a bake grid over MAX_VERIFY_RES is refused, from the file's ground block or from res", () => {
    const big = JSON.parse(JSON.stringify(made.world));
    big.ground.res = MAX_VERIFY_RES + 1;
    eq(validateWorldFile(big).length, 0, "the file format itself allows it");
    for (const [w, opts] of [[big, { spawn: [0, 0] }], [made.world, { spawn: [0, 0], res: MAX_VERIFY_RES + 1 }], [made.world, { spawn: [0, 0], res: 1 }]]) {
      let threw = null;
      const t0 = Date.now();
      try { explainWorld(w, opts); } catch (err) { threw = err; }
      ok(threw instanceof RangeError, String(threw));
      ok(Date.now() - t0 < 5000, "refused before baking");
    }
    // Without a spawn or an objective nothing is baked, and the file is read as it is.
    eq(explainWorld(big).ground, null);
  });
}

report("author");
