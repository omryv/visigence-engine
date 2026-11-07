/* claims.js — what a world can be held to, as data, and how each part of it
 * is known.
 *
 * A world is a seed and a params object, and everything else is derived from
 * them. That is the whole of the README's first rule, and it is what makes a
 * world checkable at all: a statement about a world is either something the
 * params decide outright, or something the pipeline makes of them, or a
 * constant of the build that made it. There is no fourth kind of fact, and
 * this module is where that is written down rather than assumed.
 *
 *     deriveClaims({ params, manifest, conditioning, reach, spawn })
 *       -> { kind, version, world, ground, conditioning, reach, unknown }
 *
 * The inputs are the things this module does NOT compute: the ground manifest
 * groundBundle wrote (src/kernel/terrain/ground.js), the conditioning summary the
 * sampler carries (heightfield.js `height.conditioning`), and a reachTerrain
 * flood over that ground (terrain-reach.js). They are handed in rather than
 * made here because each is a bake or a solve — hundreds of milliseconds — and
 * a caller that already has one must not have to pay for it twice. What IS
 * computed here is everything cheap: the parameter hash, the seed's hash, the
 * size and the waterline, how many intent records the params carry. Those are
 * read from `params`, never from the inputs, and an input that disagrees with
 * them (a manifest baked from other params, a conditioning summary for a world
 * with no intent) is refused with a TypeError rather than quietly believed —
 * a claim derived from the wrong bake is the one kind of false claim that
 * would pass every internal consistency check.
 *
 * ── the registry ──
 * REGISTRY names every leaf the tree can hold and says how that leaf is known.
 * Four accounts, and nothing else:
 *
 *   declared   a constant of the build or of the format — kind, version, the
 *              generator and controller versions, the grid a bake was asked
 *              for. Asserted literally by a verifier; nothing to compute.
 *   rederived  recomputable from the world file alone, cheaply, with no bake
 *              and no solve: a terrainParameterHash, a hashSeed, a field read
 *              out of params. A verifier at tier 1 recomputes every one.
 *   derived    recomputable only by running the pipeline again — re-baking the
 *              canonical ground, re-solving the intent, re-flooding the reach.
 *              A verifier at tier 2 does exactly that and compares EQUAL, not
 *              within a tolerance: the same inputs through the same code, and
 *              a tolerance is where a fabricated number would hide.
 *   unknown    not computable from what was given, and stated as the string
 *              "unknown" with a reason in `unknown[]`. Only a leaf whose
 *              registry entry says `mayBeUnknown` may be unknown at all: a
 *              rederived claim is always computable from the params, so a
 *              certificate that called one unknown would be declining to say
 *              something it could not fail to know.
 *
 * tools/test/kernel/claims.test.js walks a real tree and fails on any leaf this registry
 * does not cover, on any registry leaf the tree does not carry, on an
 * "unknown" with no reason, and on a reason listed for a leaf that is then
 * stated anyway — the same two-way honesty src/atlas/ holds its own
 * certificate to ("nothing unknown is unexplained; nothing explained as
 * unknown is stated").
 *
 * ── what is deliberately not a claim ──
 *   · Placements. What stands on the ground is not the ground, and a world
 *     file's placements are signed as part of its bytes (js/certificate.js
 *     `subject.sha256`), not re-derived: nothing in this repository can
 *     re-derive where a person put a chair.
 *   · Timings. groundBundle's `stages[].ms` are whatever an injected clock
 *     said; a claim that two bakes took the same time is false on its face.
 *   · cellSize. It is size / (res - 1), and stating it would be stating two
 *     claims twice.
 *
 * Pure JS — no three.js, no DOM, no clock, no randomness, no WebCrypto (the
 * signature lives one layer out, in js/certificate.js, for exactly that
 * reason). Part of the core (src/kernel/core/index.js CORE_MODULES), so
 * tools/check-imports.mjs holds it to all of that.
 */

import { hashSeed } from "../seed.js";
import { GENERATOR_VERSION, terrainParameterHash } from "../terrain/fingerprint.js";
import { normalizeIntent } from "../terrain/condition.js";
import { CONTROLLER_VERSION } from "./controller.js";

export const CLAIMS_KIND = "visigenesis.claims";
/* The tree's own shape: bumped when a leaf is added, removed or redefined,
   which is also when REGISTRY changes. */
export const CLAIMS_VERSION = 1;
export const UNKNOWN = "unknown";
export const ACCOUNTS = Object.freeze(["declared", "rederived", "derived", "unknown"]);

/* Every leaf, and how it is known when it IS known. `mayBeUnknown` marks the
   leaves whose value depends on an input the caller may not have given. */
const entry = (account, how, mayBeUnknown = false) => Object.freeze({ account, how, mayBeUnknown });

export const REGISTRY = Object.freeze({
  "kind":                     entry("declared", "the constant CLAIMS_KIND"),
  "version":                  entry("declared", "the constant CLAIMS_VERSION"),

  "world.seed":               entry("rederived", "params.seed, exactly as the pipeline reads it"),
  "world.seedHash":           entry("rederived", "hashSeed(params.seed), as an unsigned 32-bit integer"),
  "world.parameterHash":      entry("rederived", "terrainParameterHash(params)"),

  "ground.generatorVersion":  entry("declared", "GENERATOR_VERSION of the build that baked the manifest"),
  "ground.res":               entry("declared", "the grid the ground was baked at (manifest.res)", true),
  "ground.size":              entry("rederived", "params.terrain.size"),
  "ground.waterLevel":        entry("rederived", "params.water.level || 0, spelled as canonical.js floods it"),
  "ground.min":               entry("derived", "the stored field's lowest height, re-baked", true),
  "ground.max":               entry("derived", "the stored field's highest height, re-baked", true),
  "ground.heightHash":        entry("derived", "FNV-1a over the re-baked field's float32 bytes", true),
  "ground.landMaskHash":      entry("derived", "FNV-1a over the re-flooded wet mask", true),
  "ground.flowMaskHash":      entry("derived", "FNV-1a over the re-drained flow mask", true),
  "ground.deltaHash":         entry("derived", "FNV-1a over the re-run erosion delta, null when none ran", true),

  "conditioning.records":     entry("rederived", "normalizeIntent(params.terrain.intent).length, 0 for none"),
  "conditioning.conditioned": entry("derived", "whether the sampler's solve produced a correction", true),
  "conditioning.nats":        entry("derived", "½·ΔᵀΣ⁻¹Δ of the re-solved correction, 0 when none", true),
  "conditioning.miss":        entry("derived", "the re-solved worst shortfall in metres, 0 when none", true),

  "reach.controllerVersion":  entry("declared", "CONTROLLER_VERSION of the body the flood walked"),
  "reach.spawnX":             entry("rederived", "the world file's spawn x", true),
  "reach.spawnZ":             entry("rederived", "the world file's spawn z", true),
  "reach.spawnCell":          entry("derived", "the walkable cell the spawn snapped to, re-flooded; −1 for none", true),
  "reach.walkableCount":      entry("derived", "walkable cells on the re-baked ground", true),
  "reach.reachedCount":       entry("derived", "cells the re-flooded spawn reaches", true),
  "reach.reachedFraction":    entry("derived", "reachedCount / walkableCount, 0 when nothing is walkable", true),
});

/* The ground leaves a manifest supplies, by the name the manifest spells them.
   ground.size and ground.waterLevel are not among them: those are read from
   params, and the manifest is held to agree. */
const MANIFEST_DERIVED = ["min", "max", "heightHash", "landMaskHash", "flowMaskHash", "deltaHash"];
const REACH_DERIVED = ["spawnCell", "walkableCount", "reachedCount", "reachedFraction"];

/**
 * The claims that are recomputable from a world's params (and its spawn)
 * alone, with no bake and no solve. Keyed by registry path. A verifier's
 * tier 1 is this function and an equality check; deriveClaims below states
 * exactly these values, so the two cannot disagree about what "rederived"
 * means.
 *
 * @param {object} params
 * @param {{ spawn?: {x:number,z:number}|[number,number]|null }} [opts]
 * @returns {Object<string, *>}
 */
export function rederivedClaims(params, { spawn = null } = {}) {
  if (!params?.terrain) throw new TypeError("rederivedClaims: params.terrain is required");
  /* The seed AS THE PIPELINE READS IT — seedChannel(params.seed, …) hashes
     the raw string — not normalizeSeed's display form. Those differ for any
     seed longer than twelve characters (normalizeSeed truncates), and two
     such seeds normalise alike while growing different worlds, so the
     normalised form would let one world's certificate name another's seed. */
  const seed = typeof params.seed === "string" ? params.seed : String(params.seed ?? "");
  const records = normalizeIntent(params.terrain.intent);
  const s = readSpawn(spawn);
  return {
    "world.seed": seed,
    "world.seedHash": hashSeed(seed) >>> 0,
    "world.parameterHash": terrainParameterHash(params),
    "ground.size": params.terrain.size,
    "ground.waterLevel": params.water?.level || 0,
    "conditioning.records": records ? records.length : 0,
    "reach.spawnX": s ? s[0] : UNKNOWN,
    "reach.spawnZ": s ? s[1] : UNKNOWN,
  };
}

/* A spawn as a world file carries it ({ x, z, … }) or as reachTerrain takes it
   ([x, z]); null when absent or not two finite numbers. */
function readSpawn(spawn) {
  if (spawn == null) return null;
  const x = Array.isArray(spawn) ? spawn[0] : spawn.x;
  const z = Array.isArray(spawn) ? spawn[1] : spawn.z;
  return Number.isFinite(x) && Number.isFinite(z) ? [x, z] : null;
}

/**
 * The claims tree for a world.
 *
 * @param {object} o
 * @param {object} o.params              a complete params object
 * @param {object|null} [o.manifest]     groundBundle(params).manifest, or null
 * @param {object|null|undefined} [o.conditioning]
 *        createHeightSampler(params).conditioning — null is a FACT (the
 *        sampler solved nothing), undefined means "not supplied", which makes
 *        the solved values unknown for a world that carries intent
 * @param {object|null} [o.reach]        reachTerrain over the manifest's field
 *                                       from `spawn`, or null
 * @param {{x,z}|[x,z]|null} [o.spawn]   the spawn the reach was flooded from
 * @returns {object} the tree; `unknown` lists [{ claim, why }]
 */
export function deriveClaims({ params, manifest = null, conditioning = undefined, reach = null, spawn = null } = {}) {
  const re = rederivedClaims(params, { spawn });
  const unknown = [];
  const miss = (claim, why) => { unknown.push({ claim, why }); return UNKNOWN; };

  /* ── the ground ── */
  const ground = {
    generatorVersion: GENERATOR_VERSION,
    res: null,
    size: re["ground.size"],
    waterLevel: re["ground.waterLevel"],
  };
  if (manifest) {
    /* The manifest must be THIS world's, from THIS generator. Each of these is
       a bake of something else being passed off as this one. */
    if (manifest.generatorVersion !== GENERATOR_VERSION) {
      throw new TypeError(`deriveClaims: the manifest was baked by generator ${manifest.generatorVersion}, this build is ${GENERATOR_VERSION}`);
    }
    if (manifest.parameterHash !== re["world.parameterHash"]) {
      throw new TypeError(`deriveClaims: the manifest's parameterHash ${manifest.parameterHash} is not these params' ${re["world.parameterHash"]}`);
    }
    if (manifest.size !== ground.size) throw new TypeError(`deriveClaims: the manifest's size ${manifest.size} is not params.terrain.size ${ground.size}`);
    if (manifest.waterLevel !== ground.waterLevel) throw new TypeError(`deriveClaims: the manifest's waterLevel ${manifest.waterLevel} is not the params' ${ground.waterLevel}`);
    if (!Number.isInteger(manifest.res) || manifest.res < 2) throw new TypeError(`deriveClaims: the manifest's res ${manifest.res} is not a grid`);
    ground.res = manifest.res;
    for (const k of MANIFEST_DERIVED) ground[k] = manifest[k];
  } else {
    const why = "no ground manifest was given, so nothing was baked to measure";
    ground.res = miss("ground.res", why);
    for (const k of MANIFEST_DERIVED) ground[k] = miss(`ground.${k}`, why);
  }

  /* ── the conditioning ── */
  const records = re["conditioning.records"];
  const cond = { records, conditioned: false, nats: 0, miss: 0 };
  if (!records) {
    /* No statements: nothing was solved, so the correction is the zero
       correction and its cost is exactly zero nats — survey.js reports an
       unconditioned seed the same way. Not unknown: known, and zero. A
       summary handed in for a world with nothing to solve came from some
       other world. */
    if (conditioning != null) throw new TypeError("deriveClaims: a conditioning summary was given for params that carry no intent");
  } else if (conditioning === undefined) {
    const why = "the params carry intent and no conditioning summary was given, so nothing was solved to measure";
    cond.conditioned = miss("conditioning.conditioned", why);
    cond.nats = miss("conditioning.nats", why);
    cond.miss = miss("conditioning.miss", why);
  } else if (conditioning !== null) {
    if (!Number.isFinite(conditioning.nats) || !Number.isFinite(conditioning.miss)) {
      throw new TypeError("deriveClaims: the conditioning summary's nats and miss must be finite numbers");
    }
    cond.conditioned = true;
    cond.nats = conditioning.nats;
    cond.miss = conditioning.miss;
  }

  /* ── the reach ── */
  const r = {
    controllerVersion: CONTROLLER_VERSION,
    spawnX: re["reach.spawnX"],
    spawnZ: re["reach.spawnZ"],
  };
  if (r.spawnX === UNKNOWN) {
    unknown.push({ claim: "reach.spawnX", why: "the world names no spawn" });
    unknown.push({ claim: "reach.spawnZ", why: "the world names no spawn" });
  }
  if (reach) {
    if (r.spawnX === UNKNOWN) throw new TypeError("deriveClaims: a reach was given with no spawn to say where its flood started");
    if (!manifest) throw new TypeError("deriveClaims: a reach was given with no manifest to say which ground it was flooded over");
    if (reach.res !== manifest.res || reach.size !== manifest.size) {
      throw new TypeError(`deriveClaims: the reach was flooded over a ${reach.res}² ${reach.size} m field, the manifest is ${manifest.res}² ${manifest.size} m`);
    }
    if (reach.settings?.version !== CONTROLLER_VERSION) {
      throw new TypeError(`deriveClaims: the reach walked controller ${reach.settings?.version}, this build is ${CONTROLLER_VERSION}`);
    }
    r.spawnCell = reach.spawnCell;
    r.walkableCount = reach.walkableCount;
    r.reachedCount = reach.reachedCount;
    r.reachedFraction = reach.reachedFraction;
  } else {
    const why = r.spawnX === UNKNOWN ? "the world names no spawn, so the flood has no start"
      : manifest ? "no reach was given" : "no ground was baked to flood over";
    for (const k of REACH_DERIVED) r[k] = miss(`reach.${k}`, why);
  }

  return {
    kind: CLAIMS_KIND,
    version: CLAIMS_VERSION,
    world: {
      seed: re["world.seed"],
      seedHash: re["world.seedHash"],
      parameterHash: re["world.parameterHash"],
    },
    ground,
    conditioning: cond,
    reach: r,
    unknown,
  };
}

/** Every leaf of a claims tree as [path, value], in tree order, `unknown`
    excluded (it is the list ABOUT the leaves, not one of them). An array is a
    leaf: no claim is a list, so one appearing is a leaf the registry will
    not cover, which is what should happen to it. */
export function claimLeaves(claims) {
  const out = [];
  const walk = (o, path) => {
    for (const [k, v] of Object.entries(o)) {
      const p = path ? `${path}.${k}` : k;
      if (!path && k === "unknown") continue;
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, p);
      else out.push([p, v]);
    }
  };
  if (claims && typeof claims === "object") walk(claims, "");
  return out;
}

/** The value at a dotted path, or undefined. */
export function claimAt(claims, path) {
  return path.split(".").reduce((o, k) => (o == null || typeof o !== "object" ? undefined : o[k]), claims);
}

/** How a leaf of THIS tree is known: "unknown" when the tree lists it, else
    the registry's account; null for a path the registry does not name. */
export function accountOf(claims, path) {
  if (!REGISTRY[path]) return null;
  if ((claims?.unknown || []).some((u) => u && u.claim === path)) return "unknown";
  return REGISTRY[path].account;
}

/**
 * The registry's accounting of a tree, as lists of paths — all empty when
 * every leaf is accounted for:
 *
 *   uncovered    a leaf the registry does not name
 *   absent       a registry leaf the tree does not carry
 *   unexplained  a leaf stated as "unknown" with no reason listed
 *   overclaimed  a leaf listed as unknown that the tree then states anyway
 *   forbidden    an unknown leaf whose registry entry says it is always known
 *   malformed    an `unknown` entry that is not { claim, why } with a reason
 */
export function claimsAccounting(claims) {
  const leaves = claimLeaves(claims);
  const have = new Set(leaves.map(([p]) => p));
  const list = Array.isArray(claims?.unknown) ? claims.unknown : [];
  const malformed = [];
  const listed = new Set();
  for (const u of list) {
    if (!u || typeof u.claim !== "string" || typeof u.why !== "string" || !u.why.trim()) {
      malformed.push(u && typeof u.claim === "string" ? u.claim : JSON.stringify(u));
      continue;
    }
    listed.add(u.claim);
  }
  if (claims && claims.unknown !== undefined && !Array.isArray(claims.unknown)) malformed.push("unknown");
  return {
    uncovered: leaves.filter(([p]) => !REGISTRY[p]).map(([p]) => p),
    absent: Object.keys(REGISTRY).filter((p) => !have.has(p)),
    unexplained: leaves.filter(([p, v]) => v === UNKNOWN && !listed.has(p)).map(([p]) => p),
    overclaimed: [...listed].filter((p) => claimAt(claims, p) !== UNKNOWN),
    forbidden: leaves.filter(([p, v]) => v === UNKNOWN && REGISTRY[p] && !REGISTRY[p].mayBeUnknown).map(([p]) => p),
    malformed,
  };
}
