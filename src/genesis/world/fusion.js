// fusion.js — the contract layer. The ONLY place the engine meets the
// game/export models. Owns: string-seed identity for handoffs, settlement
// scoring + spawn rings derived from the live heightfield, biome palette
// alignment, and versioned prop records with stable per-placement uids.
// Pure JS (no three.js) — runs under JavaScriptCore tests.

import { hashSeed, seedChannel, channelRng, normalizeSeed } from "../../kernel/seed.js";
import { elevNorm, slopeAt, createBakedSampler } from "../../kernel/terrain/heightfield.js";
import { PALETTES } from "../style/palettes.js";

export const FUSION_VERSION = 4;

/* ── stable placement identity ──
   A uid is minted once when a prop is placed and never changes, so a Unity
   reimport UPDATES the buyer's object instead of duplicating it. */
export function makeUid(seed, n) {
  return "p" + (seedChannel(seed, "prop:" + n) >>> 0).toString(36) + "-" + n.toString(36);
}
export function nextUidIndex(records) {
  let max = -1;
  for (const r of records) {
    const n = parseInt(String(r.uid).split("-").pop(), 36);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/* ── settlement scoring ──
   Scores the live heightfield for habitability: flat, dry, near water, in
   the fertile elevation band, with land at its back. Greedy peak-picking
   with minimum separation gives settlement sites; the best site is the
   spawn (double ring). */
export function scoreSettlements(field, params, count = 5) {
  const sampler = createBakedSampler(field);
  const { size, height } = params.terrain;
  // The waterline is wherever the flood put it (params.water.level), not 0 —
  // a settlement under a raised flood is not habitable, and the spawn must
  // not drop the player into drowned ground.
  const level = params.water?.level || 0;
  const N = 64, cell = size / N;
  const scores = [];
  for (let j = 2; j < N - 2; j++) {
    for (let i = 2; i < N - 2; i++) {
      const x = (i / (N - 1) - 0.5) * size, z = (j / (N - 1) - 0.5) * size;
      const h = sampler(x, z);
      if (h <= level + 1) continue; // underwater / surf
      const t = elevNorm(h, height);
      const slope = slopeAt(sampler, x, z, cell * 0.5);
      const flat = Math.max(0, 1 - slope * 3.5);
      const band = Math.max(0, 1 - Math.abs(t - 0.42) * 3.2); // fertile mid-low band
      // Water proximity: nearest of 8 probes at increasing radius.
      let waterDist = 1;
      for (let r = 1; r <= 4 && waterDist === 1; r++) {
        for (let a = 0; a < 8; a++) {
          const wx = x + Math.cos(a * Math.PI / 4) * r * cell, wz = z + Math.sin(a * Math.PI / 4) * r * cell;
          if (sampler(wx, wz) < level) { waterDist = r / 4; break; }
        }
      }
      const nearWater = 1 - waterDist * 0.7;
      /* Hinterland: land fraction in two wider rings. A settlement needs
         country behind it — fields, woods, somewhere for a road to go. A
         bare sand spit in a lagoon is flat, dry and near water, and scoring
         it top put the spawn (and the opening village) on the one patch of
         ground with nothing around it. */
      let landNear = 0;
      for (const r of [5, 9]) {
        for (let a = 0; a < 8; a++) {
          const px = x + Math.cos(a * Math.PI / 4) * r * cell, pz = z + Math.sin(a * Math.PI / 4) * r * cell;
          if (sampler(px, pz) > level + 1) landNear++;
        }
      }
      const hinterland = 0.3 + 0.7 * (landNear / 16);
      const score = flat * flat * band * nearWater * hinterland;
      if (score > 0.05) scores.push({ x, z, score });
    }
  }
  scores.sort((a, b) => b.score - a.score);
  const picked = [];
  const minSep = size * 0.12;
  for (const s of scores) {
    if (picked.length >= count) break;
    if (picked.every((p) => Math.hypot(p.x - s.x, p.z - s.z) > minSep)) {
      picked.push({ x: round1(s.x), z: round1(s.z), score: round3(s.score), r: round1(size * 0.02) });
    }
  }
  return picked;
}

export function deriveSpawn(settlements, params, { field = null, override = null } = {}) {
  const size = params.terrain.size;
  const yaw = (seedChannel(params.seed, "spawn-yaw") / 4294967296) * Math.PI * 2;
  const rings = [{ r: round1(size * 0.006) }, { r: round1(size * 0.011) }]; // double ring = spawn
  // Authored spawn: the editor's pick wins over everything — but the world
  // is a finite floating plate, so it is fenced inside it like the player is.
  if (override && Number.isFinite(override.x) && Number.isFinite(override.z)) {
    const lim = size / 2 - 12;
    return {
      x: round1(clamp(override.x, -lim, lim)),
      z: round1(clamp(override.z, -lim, lim)),
      yaw, rings, authored: true,
    };
  }
  if (settlements.length) return { x: settlements[0].x, z: settlements[0].z, yaw, rings };
  // No habitable site scored (ocean-heavy worlds): take the highest land
  // near the centre rather than dropping the player into the deep sea.
  if (field) {
    const sampler = createBakedSampler(field);
    const level = params.water?.level || 0;
    let best = null;
    const N = 48;
    for (let j = 1; j < N; j++) {
      for (let i = 1; i < N; i++) {
        const x = (i / (N - 1) - 0.5) * size * 0.9, z = (j / (N - 1) - 0.5) * size * 0.9;
        const h = sampler(x, z);
        if (h < level + 3) continue;
        const score = h - (Math.hypot(x, z) / size) * 40;
        if (!best || score > best.score) best = { x, z, score };
      }
    }
    if (best) return { x: round1(best.x), z: round1(best.z), yaw, rings };
  }
  return { x: 0, z: 0, yaw, rings };
}

/* ── biome palette alignment ──
   The record carries the palette VALUES, not just the name, so a game or a
   Unity project renders the same colours even if its palette table drifts. */
export function alignedPalette(biome) {
  const p = PALETTES[biome] || PALETTES.verdant;
  return {
    biome, stops: p.stops.map(([t, c]) => [t, c]),
    water: { ...p.water }, sky: { ...p.sky }, fog: p.fog,
    grass: p.grass, rock: p.rock, sand: p.sand,
  };
}

/* ── versioned world record ── */
export function buildFusionRecord({ params, propRecords, field, tactics = null, assets = {}, spawnOverride = null }) {
  const settlements = scoreSettlements(field, params);
  const spawn = deriveSpawn(settlements, params, { field, override: spawnOverride });
  return {
    version: FUSION_VERSION,
    kind: "vsight-world",
    seed: normalizeSeed(params.seed),
    seedHash: hashSeed(params.seed),
    bakedAt: Date.now(),
    params: JSON.parse(JSON.stringify(params)),
    palette: alignedPalette(params.biome),
    props: propRecords.map((r) => ({
      v: 1, uid: r.uid, ref: r.ref || null, url: r.url || null, label: r.label,
      position: r.position.map(round2), rotationY: round3(r.rotationY || 0), scale: round3(r.scale || 1),
      placeholder: !!r.placeholder, bytesKey: r.bytesKey || null,
      proc: r.proc || null, // builder blocks: the geometry spec IS the asset
      // Point-seated pieces (stacked blocks, decks, hung walkways) keep their
      // authored height on re-add; without this flag VSight re-seats them onto
      // the terrain and a bridge lies on its riverbed.
      seat: r.seat === "point" ? "point" : null,
      // Style overrides: per-placement paint tint, per-axis stretch, and
      // texture genre skin (real/toon/grim/fantasy).
      tint: r.tint ? r.tint.map(round3) : null,
      stretch: r.stretch ? r.stretch.map(round3) : null,
      style: r.style || null,
      /* What the thing is FOR: {kind, verb, reach} from js/affordance.js, on
         the interior pieces that afford anything. This list enumerates rather
         than spreads, so a field that is not named here does not exist on the
         far side of the handoff — and an interior whose chairs stop being
         chairs the moment it leaves the editor is an interior that was only
         ever furnished for the person who generated it. */
      use: r.use || null,
    })),
    assets, // bytesKey → ArrayBuffer for URL-less imports (IndexedDB clones these fine)
    settlements, spawn, tactics,
    field: { res: field.res, size: field.size }, // games re-bake the grid from params; dims are the contract
  };
}

export function validateFusionRecord(rec) {
  const errors = [];
  if (!rec || typeof rec !== "object") return ["record missing"];
  if (rec.version !== FUSION_VERSION) errors.push(`version ${rec?.version} ≠ ${FUSION_VERSION}`);
  if (!normalizeSeed(rec.seed)) errors.push("bad seed");
  if (!rec.params?.terrain?.size) errors.push("params missing");
  /* A record from a file is a stranger's: `props: 5` or `props: [null]` must
     come back as named failures, not as a TypeError out of the loop (which
     is what it did, until the M4 review fed it one). */
  const props = Array.isArray(rec.props) ? rec.props : [];
  if (!Array.isArray(rec.props)) errors.push("props missing");
  for (const p of props) {
    if (!p || typeof p !== "object") errors.push(`prop ${JSON.stringify(p ?? null)} is not a placement`);
    else if (!p.uid) errors.push("prop without uid");
  }
  if (new Set(props.map((p) => p?.uid)).size !== props.length) errors.push("duplicate uids");
  return errors;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;
