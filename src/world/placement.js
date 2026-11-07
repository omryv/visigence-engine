/**
 * PUT THE PACK ON THE GROUND. Pure JS — no three, so the baker, the browser and the
 * tests all place the same level.
 *
 * This is the step that turns walkable terrain into a level. Terrain decides where you
 * CAN go; props decide where it is worth going and what it costs to cross. Nothing here
 * is decoration: every placement registers a blocker, so a crate is a sightline break
 * and a barricade is a route closed.
 *
 * ---------------------------------------------------------------------------
 * ORDER MATTERS, AND IT IS THE OPPOSITE OF THE OBVIOUS ONE
 * ---------------------------------------------------------------------------
 * The instinct is to scatter cover and then find somewhere for the objective. That
 * produces a level whose mission is wherever there happened to be a gap. So objectives
 * go FIRST, on reachable ground, spread as far from the spawn and from each other as the
 * world allows — they are the level's skeleton. Cover is then scattered around what is
 * already there, and it is the thing that yields.
 *
 * ---------------------------------------------------------------------------
 * AND THE PLACEMENT CAN BREAK THE LEVEL, SO IT IS CHECKED
 * ---------------------------------------------------------------------------
 * A blocker dropped in a corridor can cut the objective off from the spawn. The nav
 * flood proved the ground was connected BEFORE any props existed, and nothing about that
 * proof survives putting solid things on it.
 *
 * So after placing, the reachability flood is run again over the occupied grid, and any
 * placement that severs an objective from the spawn is REMOVED rather than kept. It is
 * the same argument the nav grid makes about terrain and the repository kernel makes about
 * doors: a level that certifies every piece individually can still be one you cannot
 * finish, and the only honest test is to walk it.
 */

import { channelRng } from '../kernel/seed.js';

/** Metres of clear ground kept around the player's spawn. Nothing is placed inside it. */
export const SPAWN_CLEARANCE = 6;
/** Multiplier on a prop's own footprint for the gap between two placements. */
export const SPACING = 1.35;

/**
 * @param {object} o
 * @param {ReturnType<import('./navgrid.js').bakeNavGrid>} o.nav
 * @param {ReturnType<import('./pack.js').resolvePack>} o.pack
 * @param {import('../sim/Terrain.js').Terrain} o.terrain
 * @param {string} o.seed
 * @param {object} [o.encounters]  spec block: { objectives, coverDensity }
 * @returns {{placements: object[], objectives: object[], rejected: object[],
 *   reachableAfter: number, occupied: Uint8Array}}
 */
export function placeProps({ nav, pack, terrain, seed, encounters = {} }) {
  const rng = channelRng(seed, 'props');
  const { gridN, cell, origin, walkable, heights } = nav;
  const cx = (i) => origin.x + (i + 0.5) * cell;
  const cz = (j) => origin.z + (j + 0.5) * cell;

  const wantObjectives = Math.max(1, encounters.objectives ?? 3);
  const coverDensity = encounters.coverDensity ?? 1;

  /** Cells a placement has taken, so nothing overlaps and the flood can be re-run. */
  const occupied = new Uint8Array(gridN * gridN);
  const placements = [];
  const rejected = [];

  /** Reachable cells as a flat list, so a draw is O(1) rather than a scan. */
  const free = [];
  for (let k = 0; k < walkable.length; k++) if (walkable[k]) free.push(k);
  if (!free.length) {
    return { placements: [], objectives: [], rejected: [], reachableAfter: 0, occupied };
  }

  const spawnI = nav.spawnIndex % gridN;
  const spawnJ = (nav.spawnIndex - spawnI) / gridN;
  const distCells = (a, b) => {
    const ai = a % gridN, aj = (a - ai) / gridN;
    const bi = b % gridN, bj = (b - bi) / gridN;
    return Math.hypot(ai - bi, aj - bj);
  };
  const spawnClearCells = SPAWN_CLEARANCE / cell;

  /** Stamp a disc of cells as taken. Returns false if any of them already are. */
  const claim = (idx, radiusM, write) => {
    const r = Math.max(1, Math.ceil((radiusM * SPACING) / cell));
    const ci = idx % gridN, cj = (idx - ci) / gridN;
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        if (i < 0 || j < 0 || i >= gridN || j >= gridN) continue;
        if ((i - ci) ** 2 + (j - cj) ** 2 > r * r) continue;
        if (occupied[j * gridN + i]) return false;
      }
    }
    if (!write) return true;
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        if (i < 0 || j < 0 || i >= gridN || j >= gridN) continue;
        if ((i - ci) ** 2 + (j - cj) ** 2 > r * r) continue;
        occupied[j * gridN + i] = 1;
      }
    }
    return true;
  };

  const emit = (prop, idx) => {
    const i = idx % gridN, j = (idx - i) / gridN;
    const x = cx(i), z = cz(j);
    const half = (prop.size ? [prop.size[0] / 2, prop.size[2] / 2] : [prop.footprint / 2, prop.footprint / 2]);
    return {
      id: prop.id,
      model: prop.model,
      role: prop.role,
      cell: idx,
      x: +x.toFixed(3),
      y: +terrain.heightAt(x, z).toFixed(3),
      z: +z.toFixed(3),
      /** Quarter turns only. A prop rotated 17 degrees reads as dropped, not placed. */
      yaw: +((Math.floor(rng() * 4) * Math.PI) / 2).toFixed(4),
      scale: +prop.scale.toFixed(5),
      collision: prop.collision,
      radius: +(prop.footprint / 2).toFixed(3),
      halfX: +half[0].toFixed(3),
      halfZ: +half[1].toFixed(3),
      height: +(prop.height ?? prop.footprint).toFixed(3),
    };
  };

  /* ── 1. OBJECTIVES: the level's skeleton ──────────────────────────────── */

  const objectiveProps = pack.byRole.objective;
  const objectives = [];
  if (objectiveProps.length) {
    /**
     * Farthest-point sampling: each objective goes to the reachable cell whose nearest
     * already-chosen anchor (spawn included) is furthest away. That spreads them across
     * the whole reachable region instead of clustering them wherever the RNG looked
     * first, and it degrades gracefully — on a cramped world they simply end up closer
     * together rather than failing to place.
     */
    const anchors = [nav.spawnIndex];
    for (let n = 0; n < wantObjectives; n++) {
      let best = -1, bestScore = -1;
      for (const idx of free) {
        if (occupied[idx]) continue;
        let nearest = Infinity;
        for (const a of anchors) nearest = Math.min(nearest, distCells(idx, a));
        if (nearest > bestScore) { bestScore = nearest; best = idx; }
      }
      if (best < 0) break;
      const prop = objectiveProps[n % objectiveProps.length];
      if (!claim(best, prop.footprint / 2, true)) break;
      anchors.push(best);
      const p = emit(prop, best);
      p.objectiveIndex = objectives.length;
      placements.push(p);
      objectives.push(p);
    }
  }

  /* ── 2. COVER: scattered around what is already there ─────────────────── */

  const coverProps = pack.byRole.cover;
  if (coverProps.length && coverDensity > 0) {
    /**
     * One attempt per N square metres of reachable ground, weighted by each prop's own
     * `density`. Attempts, not placements: `claim` refuses anything overlapping, so a
     * crowded region simply yields fewer, which is what makes the result look placed
     * rather than gridded.
     */
    const areaM2 = free.length * cell * cell;
    const attempts = Math.round((areaM2 / 90) * coverDensity);
    const weights = coverProps.map((p) => p.density ?? 1);
    const total = weights.reduce((a, b) => a + b, 0) || 1;

    for (let n = 0; n < attempts; n++) {
      const idx = free[(rng() * free.length) | 0];
      if (occupied[idx]) continue;
      if (distCells(idx, nav.spawnIndex) < spawnClearCells) continue;

      let roll = rng() * total, pick = coverProps[0];
      for (let k = 0; k < coverProps.length; k++) {
        roll -= weights[k];
        if (roll <= 0) { pick = coverProps[k]; break; }
      }
      if (!claim(idx, pick.footprint / 2, true)) continue;
      placements.push(emit(pick, idx));
    }
  }

  /* ── 3. CHECK THE LEVEL IS STILL FINISHABLE ───────────────────────────── */

  const verdict = verifyReachable({ nav, occupied, objectives });
  /**
   * Anything that severed an objective is removed rather than kept. Removing is safe in
   * a way that moving is not: a prop taken out cannot break something else, whereas one
   * relocated has to be re-checked against everything, which is a search this does not
   * need to run to produce a playable level.
   */
  if (!verdict.allReachable) {
    for (const p of [...placements]) {
      if (p.role === 'objective') continue;
      unclaim(occupied, gridN, cell, p);
      const retry = verifyReachable({ nav, occupied, objectives });
      rejected.push({ ...p, why: 'severed an objective from the spawn' });
      placements.splice(placements.indexOf(p), 1);
      if (retry.allReachable) break;
    }
  }

  const final = verifyReachable({ nav, occupied, objectives });
  return {
    placements,
    objectives,
    rejected,
    reachableAfter: final.reachable,
    allObjectivesReachable: final.allReachable,
    occupied,
  };
}

/** Clear the cells a placement took. The inverse of `claim`. */
function unclaim(occupied, gridN, cell, p) {
  const r = Math.max(1, Math.ceil((p.radius * SPACING) / cell));
  const ci = p.cell % gridN, cj = (p.cell - ci) / gridN;
  for (let j = cj - r; j <= cj + r; j++) {
    for (let i = ci - r; i <= ci + r; i++) {
      if (i < 0 || j < 0 || i >= gridN || j >= gridN) continue;
      if ((i - ci) ** 2 + (j - cj) ** 2 > r * r) continue;
      occupied[j * gridN + i] = 0;
    }
  }
}

/**
 * Flood the walkable grid again with the props in it, and report whether every objective
 * is still standing on ground connected to the spawn.
 *
 * The objective's OWN cells are occupied by the objective, so the flood is asked whether
 * it reached any neighbour of it rather than the cell itself — you walk up to a console,
 * not into it.
 */
export function verifyReachable({ nav, occupied, objectives }) {
  const { gridN, walkable, spawnIndex } = nav;
  const seen = new Uint8Array(gridN * gridN);
  const queue = new Int32Array(gridN * gridN);
  let head = 0, tail = 0;
  if (spawnIndex >= 0 && walkable[spawnIndex] && !occupied[spawnIndex]) {
    seen[spawnIndex] = 1;
    queue[tail++] = spawnIndex;
  }
  while (head < tail) {
    const idx = queue[head++];
    const i = idx % gridN, j = (idx - i) / gridN;
    for (let d = 0; d < 4; d++) {
      const ni = i + (d === 0 ? -1 : d === 1 ? 1 : 0);
      const nj = j + (d === 2 ? -1 : d === 3 ? 1 : 0);
      if (ni < 0 || nj < 0 || ni >= gridN || nj >= gridN) continue;
      const n = nj * gridN + ni;
      if (seen[n] || !walkable[n] || occupied[n]) continue;
      seen[n] = 1;
      queue[tail++] = n;
    }
  }
  const touching = (idx) => {
    const i = idx % gridN, j = (idx - i) / gridN;
    for (let dj = -2; dj <= 2; dj++) {
      for (let di = -2; di <= 2; di++) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= gridN || nj >= gridN) continue;
        if (seen[nj * gridN + ni]) return true;
      }
    }
    return false;
  };
  const unreached = objectives.filter((o) => !touching(o.cell));
  return { reachable: tail, allReachable: unreached.length === 0, unreached };
}
