/**
 * WHERE A BODY CAN STAND, AND GET TO. Pure JS — no three.js.
 *
 * One implementation, three consumers: `tools/build/bake-level.mjs` writes it into a
 * level, `tools/test/walk-world.mjs` walks it, and `preview/` bakes it in the browser.
 * It lives here rather than in the baker because a second copy of this function is a
 * second opinion about what is walkable, and the player would be standing on one while
 * the collision mask was built from the other. (It WAS duplicated, briefly, between the
 * baker and the walker. That is how this module came to exist.)
 *
 * ---------------------------------------------------------------------------
 * TWO PASSES, AND THE SECOND IS THE ONE THAT MATTERS
 * ---------------------------------------------------------------------------
 * LOCAL asks, of each cell on its own: is the ground here flat enough to stand on, and
 * is it out of water deep enough to swim in? Cheap, parallel, and not sufficient.
 *
 * REACH asks the question a local test cannot: can a player GET here. A flat shelf
 * halfway up a cliff passes every local test — nothing about the shelf is steep — and is
 * somewhere no player will ever be. So the second pass floods from the spawn, neighbour
 * to neighbour, refusing any step whose rise exceeds `stepUp`, and everything it does not
 * reach is cleared.
 *
 * That is the whole argument the repository kernel makes in `src/kernel/core/reach.js`: a graph
 * can certify that every room has a door and the geometry can still be a building you
 * cannot enter, so the only honest test is to walk it. Here it is walked once, offline,
 * over a grid.
 *
 * The flood is also where the terrain choice becomes a gameplay choice. It is why
 * `badlands` strands 38,329 of its locally-flat cells — mesa tops genuinely unreachable
 * from each other — while `atoll` strands 234, because the sea is its boundary and there
 * is nothing to orphan.
 */

/**
 * @param {import('../sim/Terrain.js').Terrain} terrain
 * @param {object} o
 * @param {number} o.gridN      cells per axis
 * @param {object} o.traversal  the spec's traversal block
 * @returns {{walkable: Uint8Array, heights: Float32Array, gridN: number, cell: number,
 *   origin: {x: number, z: number}, spawnIndex: number, localCount: number,
 *   reachable: number, stranded: number, spawn: {x: number, y: number, z: number}|null}}
 */
export function bakeNavGrid(terrain, { gridN, traversal }) {
  const size = terrain.size;
  const cell = size / gridN;
  const originX = -size / 2;
  const originZ = -size / 2;
  /** Cell CENTRES, not corners: a corner is shared by four cells, so sampling there
   *  makes a cell's walkability depend on ground it does not contain. */
  const cx = (i) => originX + (i + 0.5) * cell;
  const cz = (j) => originZ + (j + 0.5) * cell;

  const heights = new Float32Array(gridN * gridN);
  const local = new Uint8Array(gridN * gridN);
  let localCount = 0;

  for (let j = 0; j < gridN; j++) {
    for (let i = 0; i < gridN; i++) {
      const x = cx(i), z = cz(j);
      const at = j * gridN + i;
      heights[at] = terrain.heightAt(x, z);
      if (terrain.depthAt(x, z) > traversal.wadeDepth) continue;
      if (terrain.slopeAt(x, z) > traversal.maxSlope) continue;
      local[at] = 1;
      localCount++;
    }
  }

  /**
   * Seed at the most CENTRAL standable cell, not a corner. The plate deliberately drowns
   * the world's rim (see src/kernel/terrain/heightfield.js), so a corner seed starts the flood in
   * the sea and reaches nothing.
   */
  const mid = (gridN - 1) / 2;
  let spawnIndex = -1, bestD = Infinity;
  for (let j = 0; j < gridN; j++) {
    for (let i = 0; i < gridN; i++) {
      if (!local[j * gridN + i]) continue;
      const d = (i - mid) ** 2 + (j - mid) ** 2;
      if (d < bestD) { bestD = d; spawnIndex = j * gridN + i; }
    }
  }

  const walkable = new Uint8Array(gridN * gridN);
  if (spawnIndex < 0) {
    return { walkable, heights, gridN, cell, origin: { x: originX, z: originZ },
      spawnIndex: -1, localCount, reachable: 0, stranded: localCount, spawn: null };
  }

  const queue = new Int32Array(gridN * gridN);
  let head = 0, tail = 0;
  walkable[spawnIndex] = 1;
  queue[tail++] = spawnIndex;
  while (head < tail) {
    const idx = queue[head++];
    const i = idx % gridN, j = (idx - i) / gridN;
    const h = heights[idx];
    for (let d = 0; d < 4; d++) {
      const ni = i + (d === 0 ? -1 : d === 1 ? 1 : 0);
      const nj = j + (d === 2 ? -1 : d === 3 ? 1 : 0);
      if (ni < 0 || nj < 0 || ni >= gridN || nj >= gridN) continue;
      const n = nj * gridN + ni;
      if (walkable[n] || !local[n]) continue;
      if (Math.abs(heights[n] - h) > traversal.stepUp) continue;
      walkable[n] = 1;
      queue[tail++] = n;
    }
  }

  const si = spawnIndex % gridN, sj = (spawnIndex - si) / gridN;
  return {
    walkable, heights, gridN, cell,
    origin: { x: originX, z: originZ },
    spawnIndex, localCount,
    reachable: tail,
    stranded: localCount - tail,
    spawn: { x: cx(si), y: heights[spawnIndex], z: cz(sj) },
  };
}

/**
 * Bitset, LSB-first within each byte — the layout `CollisionSystem` unpacks.
 *
 * `btoa` in a browser, `Buffer` in node. Both produce the same string; the split exists
 * because this module has to run in both and neither API is present in the other.
 */
export function packBits(bits) {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i]) bytes[i >> 3] |= 1 << (i & 7);
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** The namespace shape `new CollisionSystem(grid)` reads, from a baked nav grid. */
export function gridModuleFor(nav, size) {
  return {
    GRID_N: nav.gridN,
    CELL_SIZE: nav.cell,
    GRID_ORIGIN: nav.origin,
    WORLD_SCALE: size,
    WALKABLE_PACKED: packBits(nav.walkable),
  };
}
