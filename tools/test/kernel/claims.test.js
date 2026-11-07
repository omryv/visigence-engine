// The claims tree, and whether every part of it can say how it is known.
//
// A certificate is worth exactly as much as its weakest leaf, so this suite is
// built around the idea tools/test/atlas/certificate.mjs is: EVERY
// LEAF OF THE TREE MUST BE ACCOUNTED FOR. src/kernel/core/claims.js REGISTRY names
// every leaf and its account; this walks real trees — fully stated, and with
// every input withheld — and fails on any leaf the registry does not cover,
// on any registry leaf a tree does not carry, and on "unknown" either way:
// nothing unknown without a reason, nothing listed unknown that is stated.
// Then it bends a tree each of those ways, because a check that has never
// been seen to fail has not been shown to check anything.
import { test, eq, ok, report } from "./harness.js";
import { makeParams, mergeParams } from "../../../src/kernel/presets.js";
import { groundBundle } from "../../../src/kernel/terrain/ground.js";
import { createHeightSampler } from "../../../src/kernel/terrain/heightfield.js";
import { terrainParameterHash, GENERATOR_VERSION } from "../../../src/kernel/terrain/fingerprint.js";
import { reachTerrain } from "../../../src/kernel/core/terrain-reach.js";
import { CONTROLLER_VERSION } from "../../../src/kernel/core/controller.js";
import {
  deriveClaims, rederivedClaims, claimLeaves, claimAt, accountOf, claimsAccounting,
  REGISTRY, ACCOUNTS, UNKNOWN, CLAIMS_KIND, CLAIMS_VERSION, CORE_MODULES,
} from "../../../src/kernel/core/index.js";

const RES = 129;
/* A world with intent, so the conditioning leaves are solved rather than
   zero: one point statement in the middle of the plate. */
const PARAMS = mergeParams(makeParams({ seed: "C7AM-TR3E-2AAA" }), {
  terrain: { intent: [{ type: "point", x: 0, z: 0, h: 140 }] },
  water: { level: 2 },
});
const SPAWN = { x: 0, z: 0 };
const BUNDLE = groundBundle(PARAMS, { res: RES });
const CONDITIONING = createHeightSampler(PARAMS).conditioning;
const REACH = reachTerrain(BUNDLE.field, { spawn: [SPAWN.x, SPAWN.z], level: BUNDLE.manifest.waterLevel, wet: BUNDLE.wet });

const FULL = deriveClaims({ params: PARAMS, manifest: BUNDLE.manifest, conditioning: CONDITIONING, reach: REACH, spawn: SPAWN });
const BARE = deriveClaims({ params: PARAMS });
const clean = (a) => Object.values(a).every((l) => l.length === 0);
const clone = (o) => JSON.parse(JSON.stringify(o));

test("claims.js is in the core", () => {
  ok(CORE_MODULES.includes("src/kernel/core/claims.js"), "CORE_MODULES does not list src/kernel/core/claims.js");
});

test("every leaf of a fully stated tree is in the registry, and every registry leaf is in the tree", () => {
  const a = claimsAccounting(FULL);
  eq(a.uncovered.join(","), "", "leaves the registry does not name:");
  eq(a.absent.join(","), "", "registry leaves the tree does not carry:");
  eq(claimLeaves(FULL).length, Object.keys(REGISTRY).length, "leaf count");
  eq(FULL.unknown.length, 0, `a fully stated tree has unknowns: ${JSON.stringify(FULL.unknown)}`);
  print(`    ${claimLeaves(FULL).length} leaves: ` + ACCOUNTS.map((k) => `${claimLeaves(FULL).filter(([p]) => accountOf(FULL, p) === k).length} ${k}`).join(", "));
});

test("every registry entry names one of the four accounts and says how", () => {
  for (const [path, e] of Object.entries(REGISTRY)) {
    ok(["declared", "rederived", "derived"].includes(e.account), `${path}: account ${e.account}`);
    ok(typeof e.how === "string" && e.how.length > 8, `${path} does not say how it is known`);
  }
});

test("unknown, both ways: nothing unknown without a reason, nothing listed unknown is stated", () => {
  for (const [name, tree] of [["fully stated", FULL], ["nothing given", BARE]]) {
    const a = claimsAccounting(tree);
    ok(clean(a), `${name}: ${JSON.stringify(a)}`);
    for (const u of tree.unknown) {
      eq(claimAt(tree, u.claim), UNKNOWN, `${name}: ${u.claim} is listed unknown`);
      ok(u.why.length > 10, `${name}: ${u.claim} has no real reason`);
      ok(REGISTRY[u.claim].mayBeUnknown, `${name}: ${u.claim} may never be unknown`);
    }
    for (const [p, v] of claimLeaves(tree)) {
      if (v === UNKNOWN) ok(tree.unknown.some((u) => u.claim === p), `${name}: ${p} is unknown with no reason`);
    }
  }
  /* The bare tree is the honest minimum: everything derivable without a bake
     or a solve is still stated, and everything else is unknown WITH why. */
  const unknownPaths = BARE.unknown.map((u) => u.claim).sort();
  const expected = Object.entries(REGISTRY).filter(([, e]) => e.mayBeUnknown).map(([p]) => p).sort();
  eq(unknownPaths.join(","), expected.join(","), "with nothing given, exactly the may-be-unknown leaves are unknown");
  for (const [p, v] of Object.entries(rederivedClaims(PARAMS))) {
    if (v !== UNKNOWN) eq(claimAt(BARE, p), v, `${p} is still stated with nothing given`);
  }
});

test("the accounting can fail — each way, on a bent tree", () => {
  const bend = (fn) => { const t = clone(FULL); fn(t); return claimsAccounting(t); };
  ok(bend((t) => { t.ground.secretHash = 7; }).uncovered.includes("ground.secretHash"), "an unregistered leaf");
  ok(bend((t) => { delete t.reach.reachedCount; }).absent.includes("reach.reachedCount"), "a missing leaf");
  ok(bend((t) => { t.conditioning.nats = UNKNOWN; }).unexplained.includes("conditioning.nats"), "an unknown with no reason");
  ok(bend((t) => { t.unknown.push({ claim: "ground.heightHash", why: "nobody baked it" }); }).overclaimed.includes("ground.heightHash"),
    "a reason given for a leaf that is then stated");
  ok(bend((t) => { t.world.parameterHash = UNKNOWN; t.unknown.push({ claim: "world.parameterHash", why: "chose not to say" }); })
    .forbidden.includes("world.parameterHash"), "a rederived leaf called unknown");
  ok(bend((t) => { t.unknown.push({ claim: "reach.spawnCell" }); }).malformed.includes("reach.spawnCell"), "a reason-less entry");
});

test("the tree says what was given, and the rederived leaves are the params' own", () => {
  eq(FULL.kind, CLAIMS_KIND);
  eq(FULL.version, CLAIMS_VERSION);
  eq(FULL.world.parameterHash, terrainParameterHash(PARAMS));
  eq(FULL.ground.generatorVersion, GENERATOR_VERSION);
  eq(FULL.reach.controllerVersion, CONTROLLER_VERSION);
  for (const k of ["res", "min", "max", "heightHash", "landMaskHash", "flowMaskHash", "deltaHash"]) eq(FULL.ground[k], BUNDLE.manifest[k], `ground.${k}`);
  eq(FULL.ground.waterLevel, 2);
  eq(FULL.conditioning.records, 1);
  eq(FULL.conditioning.conditioned, true);
  ok(FULL.conditioning.nats > 0, `one statement cost ${FULL.conditioning.nats} nats`);
  eq(FULL.conditioning.nats, CONDITIONING.nats);
  eq(FULL.conditioning.miss, CONDITIONING.miss);
  eq(FULL.reach.reachedCount, REACH.reachedCount);
  ok(FULL.reach.spawnCell >= 0 && FULL.reach.reachedCount > 0, "the spawn stands on walkable ground and reaches some of it");
  print(`    point statement: ${FULL.conditioning.nats.toFixed(3)} nats, miss ${FULL.conditioning.miss.toExponential(2)} m; ` +
    `reach ${FULL.reach.reachedCount}/${FULL.reach.walkableCount} cells from the spawn at ${RES}²`);
  for (const [p, v] of Object.entries(rederivedClaims(PARAMS, { spawn: SPAWN }))) eq(claimAt(FULL, p), v, p);
});

test("a world with no intent is known to cost nothing, not unknown", () => {
  const plain = makeParams({ seed: "C7AM-TR3E-2AAB" });
  eq(createHeightSampler(plain).conditioning, null, "the sampler solved nothing");
  const t = deriveClaims({ params: plain });
  eq(t.conditioning.records, 0);
  eq(t.conditioning.conditioned, false);
  eq(t.conditioning.nats, 0);
  eq(t.conditioning.miss, 0);
  ok(!t.unknown.some((u) => u.claim.startsWith("conditioning.")), "nothing about the conditioning is unknown");
});

test("an input from another world is refused, not believed", () => {
  const throwsWith = (fn, re) => { try { fn(); } catch (e) { return re.test(e.message); } return false; };
  const other = groundBundle(makeParams({ seed: "C7AM-TR3E-2AAC" }), { res: 17, erode: false }).manifest;
  ok(throwsWith(() => deriveClaims({ params: PARAMS, manifest: other }), /parameterHash/), "a manifest of other params");
  ok(throwsWith(() => deriveClaims({ params: PARAMS, manifest: { ...BUNDLE.manifest, generatorVersion: GENERATOR_VERSION + 1 } }), /generator/),
    "a manifest from another generator");
  ok(throwsWith(() => deriveClaims({ params: makeParams({ seed: "C7AM-TR3E-2AAB" }), conditioning: CONDITIONING }), /no intent/),
    "a conditioning summary for a world with nothing to solve");
  ok(throwsWith(() => deriveClaims({ params: PARAMS, manifest: BUNDLE.manifest, reach: REACH }), /no spawn/), "a reach with no spawn");
  ok(throwsWith(() => deriveClaims({ params: PARAMS, reach: REACH, spawn: SPAWN }), /no manifest/), "a reach with no ground");
  const small = groundBundle(PARAMS, { res: 33 });
  ok(throwsWith(() => deriveClaims({ params: PARAMS, manifest: small.manifest, reach: REACH, spawn: SPAWN }), /flooded over/),
    "a reach over another grid");
});

test("the same inputs give the same tree, byte for byte", () => {
  const again = deriveClaims({ params: clone(PARAMS), manifest: groundBundle(clone(PARAMS), { res: RES }).manifest,
    conditioning: createHeightSampler(clone(PARAMS)).conditioning, reach: REACH, spawn: SPAWN });
  eq(JSON.stringify(again), JSON.stringify(FULL));
});

report("claims");
