/* ground.js — ONE GROUND UNDER EVERYTHING, and the receipt that says which.
 *
 * canonical.js answers "what ground does this world have". It answers with
 * arrays: a field, two masks, an erosion delta. Arrays are what a renderer
 * wants and are useless to anybody who needs to ask, without holding them,
 * whether two programs are standing on the same ground — a sibling repository
 * that ported the generator, a server that baked the world last week, a file
 * on disk that claims to be this seed. The fingerprint (fingerprint.js) is
 * the comparison; this module is the thing that is compared: the bake AND the
 * statement of what was baked, made in one call, so the statement cannot be
 * computed from a different bake than the one it ships with.
 *
 *     groundBundle(params, { res, erode, now })
 *       -> { field, wet, flow, delta, manifest }
 *
 * The four arrays come from bakeCanonicalGround, unchanged and unwrapped —
 * this module does not bake, erode, flood or drain anything itself. It calls
 * the one pipeline there is and then reads what came back. A second copy of
 * the stages here, written so they could be timed, would be precisely the
 * third-copy drift canonical.js was extracted to end; the stage hook (`mark`)
 * that canonical.js now accepts exists so the timing could be done without it.
 *
 * ── the manifest ──
 * Plain JSON, and schema/ground.schema.json is its contract:
 *
 *   kind, version         "visigenesis.ground", 1 — what this object is, and
 *                         which shape of it; bumped when the SHAPE changes
 *   generatorVersion      fingerprint.js's GENERATOR_VERSION: which pipeline
 *   res, size, cellSize   the grid: samples per edge, metres per edge, and
 *                         metres per cell (size / (res - 1))
 *   min, max              the STORED field's extremes, read back from the
 *                         float32 data (see bakeHeightField) — bounds every
 *                         height in the field is inside of, exactly
 *   waterLevel            the level the sea was flooded from, in metres: the
 *                         one canonical.js actually used, not a re-reading
 *   parameterHash         terrainParameterHash(params)
 *   heightHash            FNV-1a over the field's float32 bytes
 *   landMaskHash          … over the wet mask
 *   flowMaskHash          … over the flow mask
 *   deltaHash             … over the erosion delta, or null when no erosion
 *                         ran (erosion off in the params, or `erode: false`)
 *   stages                [{ name, ms? }] in the order they finished
 *
 * Every hash is the SAME function fingerprint.js computes for the same array,
 * so a manifest and a canonicalTerrainFingerprint of the same ground agree
 * line for line — tests/ground.test.js holds them to it — and a consumer can
 * compare either against either.
 *
 * ── timings, and why there is no clock in here ──
 * The core is deterministic, and a clock is the most direct way not to be:
 * two bakes of the same world would differ in their manifest, and the first
 * consumer to hash the manifest whole would conclude they were two worlds. So
 * the core owns no clock. A caller that wants timings hands one in as
 * `now()` (anything returning milliseconds — performance.now in a page, the
 * same in Node); without one, `stages` still lists what ran, in order, and
 * carries no `ms`. Timings are never part of any hash, and the hashes above
 * are computed before the last stage is timed, so they could not be.
 *
 * `stages` is also the honest record of which stages happened: "erode" is
 * present only when the simulation ran, so a manifest baked with
 * `erode: false` over an erosion-enabled world says so even though its
 * parameterHash is that world's (the field is the world's FIRST SWEEP, not
 * the world — its heightHash will not match the eroded bake, which is
 * exactly what classify() calls case A).
 *
 * ── what is deliberately not here ──
 *   · No `sampler` override, although bakeErodedField takes one. A manifest
 *     carries parameterHash as its claim about where the field came from; a
 *     field baked from a sampler other than params' own would make that claim
 *     false while every hash in the manifest was internally consistent.
 *   · No placements. What stands on the ground is not the ground; fold it in
 *     with placementsHash (fingerprint.js) where it is the question.
 *   · No resolution policing. `res` defaults to CANONICAL_RES and any other
 *     value is honoured and RECORDED: erosion is resolution-dependent, so a
 *     bake at another grid is another world, and the manifest's `res` and
 *     heightHash both say so rather than this function refusing.
 *
 * Pure JS — no three.js, no DOM, no clock, no randomness. Part of the core
 * (src/kernel/core/index.js CORE_MODULES), so tools/check-imports.mjs holds it to
 * all of that.
 */

import { bakeCanonicalGround, CANONICAL_RES } from "./canonical.js";
import {
  GENERATOR_VERSION, terrainParameterHash, hashFloat32, hashMask,
} from "./fingerprint.js";

export const GROUND_KIND = "visigenesis.ground";
/* The manifest's own shape. Not GENERATOR_VERSION: the pipeline can change
   with the manifest unchanged, and a field can be added here with the
   pipeline unchanged. */
export const GROUND_MANIFEST_VERSION = 1;

/**
 * Bake a world's ground and state what was baked.
 *
 * @param {object} params           a complete params object (presets.js)
 * @param {object} [opts]
 * @param {number} [opts.res]       samples per edge (default CANONICAL_RES)
 * @param {boolean} [opts.erode]    false stops before the droplet simulation
 *                                  (a boolean: the string "false" is refused,
 *                                  not read as truthy)
 * @param {(() => number)|null} [opts.now]  a millisecond clock, for stage
 *                                  timings only; omitted means no `ms`
 * @returns {{ field, wet, flow, delta, manifest }}
 */
export function groundBundle(params, { res = CANONICAL_RES, erode = true, now = null } = {}) {
  if (!params?.terrain) throw new TypeError("groundBundle: params.terrain is required");
  if (!Number.isInteger(res) || res < 2) throw new RangeError(`groundBundle: res must be an integer ≥ 2, got ${res}`);
  if (now != null && typeof now !== "function") throw new TypeError("groundBundle: now must be a function returning milliseconds");

  if (typeof erode !== "boolean") throw new TypeError(`groundBundle: erode must be true or false, got ${typeof erode} ${String(erode)}`);
  /* The level the wet mask is flooded to. canonical.js reads it as
     `params.water?.level || 0`, and a value that spelling would quietly turn
     into 0 (NaN) or hand on as something other than a number (a string) is
     refused here instead: the manifest would otherwise name a sea that is not
     the one the mask was flooded from, or one the schema cannot carry.
     Absent means 0, as everywhere else. */
  const level = params.water?.level;
  if (level != null && !Number.isFinite(level)) throw new TypeError(`groundBundle: params.water.level must be a finite number, got ${String(level)}`);

  /* Timings are what an injected clock says and nothing more trusted than
     that. A clock that steps backwards (Date.now under an NTP correction) or
     returns something that is not a number must not be able to produce a
     manifest that fails its own schema, so a negative difference is written
     as 0 and a non-finite one is left out — the stage is still listed, it is
     only the `ms` that the clock could not vouch for. */
  const stages = [];
  let last = now ? now() : NaN;
  const mark = (name) => {
    if (!now) { stages.push({ name }); return; }
    const t = now();
    const d = t - last;
    stages.push(Number.isFinite(d) ? { name, ms: Math.max(0, d) } : { name });
    if (Number.isFinite(t)) last = t;
  };

  const { field, wet, flow, delta } = bakeCanonicalGround(params, { res, erode, mark });
  /* A params object with a non-finite size or height bakes a field of NaN
     without complaint, and its manifest would serialise size, cellSize, min
     and max as null — a manifest that fails the schema it is published
     under, with no error anywhere. Refuse it at the one place it can be seen. */
  for (const [k, v] of [["size", field.size], ["min", field.min], ["max", field.max]]) {
    if (!Number.isFinite(v)) throw new RangeError(`groundBundle: the baked field's ${k} is ${v} — params.terrain does not describe a ground`);
  }

  const manifest = {
    kind: GROUND_KIND,
    version: GROUND_MANIFEST_VERSION,
    generatorVersion: GENERATOR_VERSION,
    res: field.res,
    size: field.size,
    cellSize: field.size / (field.res - 1),
    min: field.min,
    max: field.max,
    // The level masksFor was handed in bakeCanonicalGround, spelled the same
    // way, so the manifest names the sea the wet mask was actually flooded to.
    // With the refusal above, this and the fingerprint's `level ?? 0` agree
    // on every params object groundBundle accepts.
    waterLevel: params.water?.level || 0,
    parameterHash: terrainParameterHash(params),
    heightHash: hashFloat32(field.data),
    landMaskHash: hashMask(wet),
    flowMaskHash: hashMask(flow),
    deltaHash: hashFloat32(delta),
    stages,
  };
  mark("hash");

  return { field, wet, flow, delta, manifest };
}
