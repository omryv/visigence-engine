/**
 * Grid collision, line-of-sight and navigation over the baked maze.
 *
 * The whole world is one bit-packed walkable mask produced offline from the authored
 * maze mesh (src/game/level.generated.js). Cells outside the maze are NOT walkable, so
 * the maze's own geometry is what keeps the player in the level - there is no invisible
 * boundary box anywhere.
 *
 * On top of the static mask sit a small number of dynamic blockers (the glass tank,
 * the console, the barricade while it stands). They are kept in a separate list rather
 * than stamped into the grid so that clearing the barricade is a one-line state change.
 *
 * Nothing in here allocates per call: every method works through preallocated scratch.
 */

import * as LEVEL_GRID from './grid.js';
const RAY_AXES=['x','y','z'];

function unpackBits(b64, count) {
  const bin = atob(b64);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = (bin.charCodeAt(i >> 3) >> (i & 7)) & 1;
  return out;
}

export class CollisionSystem {
  /**
   * How far out from a blocker its clearance is written, metres: comfortably past the
   * largest body radius in the game (the 0.80 m behemoth) plus the path's own cell
   * rounding. Beyond it a cell is DYNAMIC_FAR and no body radius can fail there.
   */
  static DYNAMIC_REACH = 1.2;
  static DYNAMIC_FAR = 1e6;

  /**
   * @param {object} [grid] the level's baked geometry - the namespace of a
   *   `*.generated.js` module (GRID_N, CELL_SIZE, GRID_ORIGIN, WALKABLE_PACKED,
   *   WORLD_SCALE). Defaults to the level, so every existing caller - the game's boot,
   *   and the eight tools under tools/ that construct one with no arguments - keeps working
   *   unchanged and Level 1 is provably untouched by the multi-level refactor.
   */
  constructor(grid = LEVEL_GRID) {
    this.n = grid.GRID_N;
    this.cell = grid.CELL_SIZE;
    this.invCell = 1 / grid.CELL_SIZE;
    this.originX = grid.GRID_ORIGIN.x;
    this.originZ = grid.GRID_ORIGIN.z;
    this.worldScale = grid.WORLD_SCALE;
    this.walkable = unpackBits(grid.WALKABLE_PACKED, grid.GRID_N * grid.GRID_N);

    /** @type {{x:number,z:number,r:number,active:boolean,id:string}[]} */
    this.circleBlockers = [];
    /** @type {{x:number,z:number,hx:number,hz:number,active:boolean,id:string}[]} */
    this.boxBlockers = [];
    // Authored finite boxes affect projectiles only. Navigation retains its 2D footprints.
    this.projectileBoxes = [];
    this.bodyQuery = null;

    /**
     * DISTANCE from each cell to the nearest active dynamic blocker, in cells - the
     * dynamic counterpart of `clearance`, so findPath can ask the same question of a prop
     * that it asks of a wall: "does a body of THIS radius fit here?".
     *
     * It used to be a mask of cells inside every blocker inflated by one fixed
     * BODY_INFLATE of 0.46 m, sized for the 0.42 m enemies. The brute is 0.62 m and the
     * behemoth 0.80, and a path that clears a crate by 0.46 m is one the brute walks
     * straight into: it pinned itself against the crate beside the tank, dropped the path,
     * searched again, found the same path, and stood there for the rest of the wave - and
     * a chambered mission advances only on a clear. Per-radius clearance ends that without
     * making the small bodies route as conservatively as the largest one.
     *
     * Cells farther than DYNAMIC_REACH from every blocker hold DYNAMIC_FAR. Rebuilt only
     * when a blocker is added or toggled, so navigation stays allocation- and scan-free
     * per query. Without it findPath would route straight through the barricade and the
     * console - the static mask knows nothing about props.
     */
    this.dynamicClearance = new Float32Array(this.n * this.n).fill(CollisionSystem.DYNAMIC_FAR);
    this.dynamicDirty = false;
    this.navigationVersion = 0;

    // --- navigation scratch, allocated once ---
    this._navDist = new Float32Array(this.n * this.n);
    this._navFrom = new Int32Array(this.n * this.n);
    this._navStamp = new Int32Array(this.n * this.n);
    this._navEpoch = 0;
    this._queue = new Int32Array(this.n * this.n);
    this._pathScratch = [];

    /**
     * Clearance field in cells, computed once from the static mask. Used to keep enemies
     * off walls and to validate authored placements.
     */
    this.clearance = this._buildClearance();
  }

  // ---------------- coordinate helpers ----------------

  cellX(x) { return Math.floor((x - this.originX) * this.invCell); }
  cellZ(z) { return Math.floor((z - this.originZ) * this.invCell); }
  worldX(i) { return this.originX + (i + 0.5) * this.cell; }
  worldZ(j) { return this.originZ + (j + 0.5) * this.cell; }

  inBounds(i, j) { return i >= 0 && j >= 0 && i < this.n && j < this.n; }

  /** Static walkability of the cell containing (x,z). Ignores dynamic blockers. */
  isOpenCell(i, j) {
    return this.inBounds(i, j) && this.walkable[j * this.n + i] === 1;
  }

  isOpenAt(x, z) {
    return this.isOpenCell(this.cellX(x), this.cellZ(z));
  }

  // ---------------- dynamic blockers ----------------

  addCircleBlocker(id, x, z, r) {
    const b = { id, x, z, r, active: true };
    this.circleBlockers.push(b);
    this.dynamicDirty = true;
    this.navigationVersion++;
    return b;
  }

  addBoxBlocker(id, x, z, hx, hz) {
    const b = { id, x, z, hx, hz, active: true };
    this.boxBlockers.push(b);
    this.dynamicDirty = true;
    this.navigationVersion++;
    return b;
  }

  setBlockerActive(id, active) {
    for (const b of this.circleBlockers) if (b.id === id) b.active = active;
    for (const b of this.boxBlockers) if (b.id === id) b.active = active;
    this.dynamicDirty = true;
    this.navigationVersion++;
  }

  /**
   * Write every active blocker's distance field into `dynamicClearance`: for each cell
   * within DYNAMIC_REACH of the blocker, the distance from the cell centre to the
   * blocker's surface (a circle's rim, a box's edge), in cells, keeping the smaller value
   * where two blockers overlap. Cells inside a blocker read 0.
   */
  rebuildDynamicMask(ignoreId = null) {
    const n = this.n, cell = this.cell;
    const dc = this.dynamicClearance;
    dc.fill(CollisionSystem.DYNAMIC_FAR);
    const reach = CollisionSystem.DYNAMIC_REACH;
    for (const b of this.circleBlockers) {
      if (!b.active || b.id === ignoreId) continue;
      const r = b.r + reach;
      const i0 = Math.max(0, this.cellX(b.x - r)), i1 = Math.min(n - 1, this.cellX(b.x + r));
      const j0 = Math.max(0, this.cellZ(b.z - r)), j1 = Math.min(n - 1, this.cellZ(b.z + r));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const dx = this.worldX(i) - b.x, dz = this.worldZ(j) - b.z;
        const d = Math.max(0, Math.hypot(dx, dz) - b.r) / cell;
        const k = j * n + i;
        if (d < dc[k]) dc[k] = d;
      }
    }
    for (const b of this.boxBlockers) {
      if (!b.active || b.id === ignoreId) continue;
      const hx = b.hx + reach, hz = b.hz + reach;
      const i0 = Math.max(0, this.cellX(b.x - hx)), i1 = Math.min(n - 1, this.cellX(b.x + hx));
      const j0 = Math.max(0, this.cellZ(b.z - hz)), j1 = Math.min(n - 1, this.cellZ(b.z + hz));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const ex = Math.max(0, Math.abs(this.worldX(i) - b.x) - b.hx);
        const ez = Math.max(0, Math.abs(this.worldZ(j) - b.z) - b.hz);
        const d = Math.hypot(ex, ez) / cell;
        const k = j * n + i;
        if (d < dc[k]) dc[k] = d;
      }
    }
    this.dynamicDirty = false;
  }

 /**
   * True if a disc of `radius` centred at (x,z) overlaps any active dynamic blocker.
   * `ignoreId` exempts one blocker - a line of sight TO a prop has to be allowed to end
   * inside the prop's own collider.
   */
  hitsBlocker(x, z, radius, ignoreId = null, projectile = false) {
    for (let k = 0; k < this.circleBlockers.length; k++) {
      const b = this.circleBlockers[k];
      if (!b.active || b.id === ignoreId || (projectile && b.projectileProxy)) continue;
      const dx = x - b.x, dz = z - b.z, rr = b.r + radius;
      if (dx * dx + dz * dz < rr * rr) return b;
    }
    for (let k = 0; k < this.boxBlockers.length; k++) {
      const b = this.boxBlockers[k];
      if (!b.active || b.id === ignoreId || (projectile && b.projectileProxy)) continue;
      if(this.bodyQuery && b.box && (b.box.max.y<=this.bodyQuery.y+.21 || b.box.min.y>=this.bodyQuery.y+this.bodyQuery.height))continue;
      if (Math.abs(x - b.x) < b.hx + radius && Math.abs(z - b.z) < b.hz + radius) return b;
    }
    return null;
  }

  /**
   * True if a disc of `radius` centred at (x,z) is entirely inside walkable space and
   * clear of dynamic blockers. Samples the disc's bounding cells rather than only the
   * centre, so a body can never be pushed halfway into a wall.
   */
  isFree(x, z, radius, projectile = false) {
    const i0 = this.cellX(x - radius), i1 = this.cellX(x + radius);
    const j0 = this.cellZ(z - radius), j1 = this.cellZ(z + radius);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (this.isOpenCell(i, j)) continue;
        // Closest point on this blocked cell to the disc centre.
        const cx = Math.max(this.originX + i * this.cell, Math.min(x, this.originX + (i + 1) * this.cell));
        const cz = Math.max(this.originZ + j * this.cell, Math.min(z, this.originZ + (j + 1) * this.cell));
        const dx = x - cx, dz = z - cz;
        if (dx * dx + dz * dz < radius * radius) return false;
      }
    }
    return this.hitsBlocker(x, z, radius, null, projectile) === null;
  }

  /**
   * Move a disc from (x,z) by (dx,dz), sliding along whatever it hits.
   * Writes the result into `out` ({x,z,hitX,hitZ}) and returns it.
   *
   * Axis-separated resolution: try X then Z. This is what gives clean corridor sliding
   * and stops the player sticking in corners.
   */
  moveDisc(x, z, dx, dz, radius, out) {
    let nx = x, nz = z;
    let hitX = false, hitZ = false;

    // Sub-step so a fast body cannot tunnel through a 0.12 m cell.
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(dist / (this.cell * 0.7)));
    const sx = dx / steps, sz = dz / steps;

    for (let s = 0; s < steps; s++) {
      if (sx !== 0) {
        if (this.isFree(nx + sx, nz, radius)) nx += sx;
        else hitX = true;
      }
      if (sz !== 0) {
        if (this.isFree(nx, nz + sz, radius)) nz += sz;
        else hitZ = true;
      }
    }

    // Last-resort depenetration: if we somehow ended up inside geometry (a blocker was
    // just enabled under us, or a spawn was bad), push to the nearest free cell.
    if (!this.isFree(nx, nz, radius)) {
      const safe = this.findNearestFree(nx, nz, radius, 12);
      if (safe) { nx = safe.x; nz = safe.z; }
    }

    out.x = nx; out.z = nz; out.hitX = hitX; out.hitZ = hitZ;
    return out;
  }

  /** Spiral outward for the closest position where a disc of `radius` fits. */
  findNearestFree(x, z, radius, maxRings = 20) {
    if (this.isFree(x, z, radius)) return { x, z };
    const ci = this.cellX(x), cj = this.cellZ(z);
    for (let r = 1; r <= maxRings; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const wx = this.worldX(ci + di), wz = this.worldZ(cj + dj);
          if (this.isFree(wx, wz, radius)) return { x: wx, z: wz };
        }
      }
    }
    return null;
  }

  /**
   * Line of sight between two world points, in the XZ plane. Uses an amanatides-woo
   * style DDA over the grid, so it stops exactly at the first solid cell.
   * Dynamic blockers block sight too (you cannot shoot a enemy through the tank).
   */
  hasLineOfSight(x0, z0, x1, z1, ignoreBlockers = false, ignoreBlockerId = null) {
    let i = this.cellX(x0), j = this.cellZ(z0);
    const iEnd = this.cellX(x1), jEnd = this.cellZ(z1);
    if (!this.isOpenCell(i, j)) return false;

    const dx = x1 - x0, dz = z1 - z0;
    const stepI = dx > 0 ? 1 : -1, stepJ = dz > 0 ? 1 : -1;
    const tDeltaX = dx === 0 ? Infinity : Math.abs(this.cell / dx);
    const tDeltaZ = dz === 0 ? Infinity : Math.abs(this.cell / dz);
    const cellMinX = this.originX + i * this.cell, cellMinZ = this.originZ + j * this.cell;
    let tMaxX = dx === 0 ? Infinity : ((dx > 0 ? cellMinX + this.cell - x0 : x0 - cellMinX) / Math.abs(dx));
    let tMaxZ = dz === 0 ? Infinity : ((dz > 0 ? cellMinZ + this.cell - z0 : z0 - cellMinZ) / Math.abs(dz));

    let guard = 0;
    const guardMax = this.n * 3;
    while ((i !== iEnd || j !== jEnd) && guard++ < guardMax) {
      if (tMaxX < tMaxZ) { i += stepI; tMaxX += tDeltaX; }
      else { j += stepJ; tMaxZ += tDeltaZ; }
      if (!this.isOpenCell(i, j)) return false;
      if (!ignoreBlockers) {
        const bx = this.worldX(i), bz = this.worldZ(j);
        if (this.hitsBlocker(bx, bz, this.cell * 0.4, ignoreBlockerId)) return false;
      }
    }
    return true;
  }

  /**
   * Raycast in the XZ plane against walls and dynamic blockers.
   * Returns {hit, x, z, dist, normalX, normalZ, blocker} or null past maxDist.
   * Used for hitscan weapons, grenade collision and view-model pushback.
   */
  raycastXZ(x0, z0, dirX, dirZ, maxDist, out, projectile = false) {
    const len = Math.hypot(dirX, dirZ) || 1;
    const dx = dirX / len, dz = dirZ / len;
    // The grid marcher can step entirely across a thin prop (or a box corner).
    // End the march at the nearest analytic blocker entry so its final sample is
    // guaranteed to touch that prop. Keep the existing grid/normal/refinement path.
    if (dx || dz) {
      for (const b of this.circleBlockers) {
        if (!b.active || (projectile && b.projectileProxy)) continue;
        const ox = x0 - b.x, oz = z0 - b.z;
        const along = ox * dx + oz * dz;
        const c = ox * ox + oz * oz - b.r * b.r;
        const disc = along * along - c;
        if (c <= 0) { maxDist = 0; break; }
        if (disc < 0) continue;
        const t = -along - Math.sqrt(disc);
        if (t >= 0 && t < maxDist) maxDist = t;
      }
      for (const b of this.boxBlockers) {
        if (!b.active || (projectile && b.projectileProxy)) continue;
        let near = 0, far = maxDist;
        if (Math.abs(dx) < 1e-10) {
          if (Math.abs(x0 - b.x) > b.hx) continue;
        } else {
          const a = (b.x - b.hx - x0) / dx, z = (b.x + b.hx - x0) / dx;
          near = Math.max(near, Math.min(a, z)); far = Math.min(far, Math.max(a, z));
        }
        if (Math.abs(dz) < 1e-10) {
          if (Math.abs(z0 - b.z) > b.hz) continue;
        } else {
          const a = (b.z - b.hz - z0) / dz, z = (b.z + b.hz - z0) / dz;
          near = Math.max(near, Math.min(a, z)); far = Math.min(far, Math.max(a, z));
        }
        if (near <= far) maxDist = near;
      }
    }
    const stepLen = this.cell * 0.5;
    const steps = Math.max(1, Math.ceil(maxDist / stepLen));
    let px = x0, pz = z0;
    for (let s = 1; s <= steps; s++) {
      const t = Math.min(s * stepLen, maxDist);
      const nx = x0 + dx * t, nz = z0 + dz * t;
      const blocked = !this.isOpenAt(nx, nz);
      const blocker = blocked ? null : this.hitsBlocker(nx, nz, 0.01, null, projectile);
      if (blocked || blocker) {
        // Binary-refine between the last free point and this one.
        let lo = 0, hi = 1;
        for (let k = 0; k < 8; k++) {
          const mid = (lo + hi) * 0.5;
          const mx = px + (nx - px) * mid, mz = pz + (nz - pz) * mid;
          if (!this.isOpenAt(mx, mz) || this.hitsBlocker(mx, mz, 0.01, null, projectile)) hi = mid; else lo = mid;
        }
        const hx = px + (nx - px) * lo, hz = pz + (nz - pz) * lo;
        /**
         * THE SURFACE NORMAL, from the surface rather than from the ray.
         *
         * A grid hit takes it from whichever axis crossed a cell boundary, which is the
         * face the ray came through. A BLOCKER hit cannot: a crate or a console sits inside
         * one cell, so no boundary is crossed and both axes stay zero. That used to fall
         * through to `-dx, -dz` - the ray turned round, pointing back at whoever fired -
         * and callers have no way to tell that apart from a real normal. Bullet decals are
         * oriented from it, so a mark on a crate was stamped facing the shooter instead of
         * lying on the crate, and stretched and clipped from every other angle.
         *
         * Both blocker shapes know their own geometry, so both can answer properly: a
         * circle (the tank, the console) has a radial normal, and a box (crates, the
         * barricade, the blast doors) has the face the hit point sits on - the axis where
         * the point is furthest out relative to that half-extent. `hitsBlocker` was tested
         * with a 0.01 radius, so the point is just outside the surface, which is the side
         * the sign below picks up.
         */
        let nX = 0, nZ = 0;
        if (blocker) {
          if (blocker.r !== undefined) {
            const ddx = hx - blocker.x, ddz = hz - blocker.z;
            const l = Math.hypot(ddx, ddz);
            if (l > 1e-6) { nX = ddx / l; nZ = ddz / l; }
          } else {
            const ex = Math.abs(hx - blocker.x) / (blocker.hx || 1e-6);
            const ez = Math.abs(hz - blocker.z) / (blocker.hz || 1e-6);
            if (ex >= ez) nX = hx > blocker.x ? 1 : -1;
            else nZ = hz > blocker.z ? 1 : -1;
          }
        } else {
          if (this.cellX(hx) !== this.cellX(nx)) nX = dx > 0 ? -1 : 1;
          if (this.cellZ(hz) !== this.cellZ(nz)) nZ = dz > 0 ? -1 : 1;
        }
        /**
         * Last resort, for a hit that resolved inside a cell without crossing into it (a
         * ray that began inside geometry). The dominant axis of travel, reversed: still a
         * real face of an axis-aligned cell, where the ray direction is a diagonal that
         * belongs to no surface in the level.
         */
        if (nX === 0 && nZ === 0) {
          if (Math.abs(dx) >= Math.abs(dz)) nX = dx > 0 ? -1 : 1;
          else nZ = dz > 0 ? -1 : 1;
        }
        out.hit = true;
        out.x = hx; out.z = hz;
        out.dist = Math.hypot(hx - x0, hz - z0);
        out.normalX = nX; out.normalZ = nZ;
        out.blocker = blocker;
        return out;
      }
      px = nx; pz = nz;
    }
    out.hit = false;
    out.x = x0 + dx * maxDist; out.z = z0 + dz * maxDist;
    out.dist = maxDist; out.normalX = -dx; out.normalZ = -dz; out.blocker = null;
    return out;
  }

  /** Allocation-free finite 3D slab tests; render triangles never enter the combat path. */
  raycastProjectile(origin, dir, range, out) {
    const horizontal=Math.hypot(dir.x,dir.z);
    this.raycastXZ(origin.x,origin.z,dir.x,dir.z,range*horizontal,out,true);
    out.dist=out.hit&&horizontal>1e-8?out.dist/horizontal:range;
    if(horizontal<=1e-8)out.hit=false;
    out.normalY=0;
    for(const p of this.projectileBoxes){
      if(!p.active)continue;
      // The rendered wall profile is recessed inside its conservative navigation grid.
      // Let its mounted plate replace that wall hit, while retaining the actual plate
      // position for decals. Never extend through another prop or beyond weapon range.
      const limit=Math.min(range,out.dist+(p.wallMounted&&out.hit&&!out.blocker?.id ? .12 : 0));
      let near=0,far=limit,nx=0,ny=0,nz=0,miss=false;
      for(const axis of RAY_AXES){
        const d=dir[axis],o=origin[axis],lo=p.box.min[axis],hi=p.box.max[axis];
        if(Math.abs(d)<1e-10){if(o<lo||o>hi){miss=true;break;}continue;}
        const a=(lo-o)/d,b=(hi-o)/d,entry=Math.min(a,b);
        if(entry>near){near=entry;nx=axis==='x'?(d>0?-1:1):0;ny=axis==='y'?(d>0?-1:1):0;nz=axis==='z'?(d>0?-1:1):0;}
        far=Math.min(far,Math.max(a,b));if(near>far){miss=true;break;}
      }
      if(miss||near>limit)continue;
      out.hit=true;out.dist=near;out.blocker=p;out.normalX=nx;out.normalY=ny;out.normalZ=nz;
    }
    out.x=origin.x+dir.x*out.dist;out.z=origin.z+dir.z*out.dist;
    return out;
  }

  isProjectileFree(x,y,z,radius) {
    if(!this.isFree(x,z,radius,true))return false;
    for(const p of this.projectileBoxes){
      if(!p.active)continue;
      const b=p.box;
      if(x+radius>b.min.x&&x-radius<b.max.x&&y+radius>b.min.y&&y-radius<b.max.y&&z+radius>b.min.z&&z-radius<b.max.z)return false;
    }
    return true;
  }

  /** Whether the player's body can traverse a straight segment, including live blockers. */
  canTravel(x0, z0, x1, z1, radius) {
    return this._discCanTravel(x0, z0, x1, z1, radius);
  }

  // ---------------- navigation ----------------

  /**
   * Breadth-first flood from `goal` outward, then walk the gradient back from `start`.
   * The maze is small (320x320 with 23829 walkable cells) and enemies repath at most a
   * few times a second, so an exact BFS beats an approximate A* here and cannot fail to
   * find a route that exists.
   *
   * `radiusCells` inflates obstacles so a body of that radius fits along the whole path.
   * Returns an array of {x,z} waypoints (reused scratch array) or null.
   */
  /**
   * @param {{bestEffort?: boolean}} [o]  bestEffort: when the goal cannot be reached, return
   *   the path to the reachable cell nearest it instead of null. For a body that HUNTS: a
   *   player standing in a pinch a heavy cannot fit into (against the station, between two
   *   crates) is still a player the heavy should walk up to, not one it stands still for.
   *   Route displays and gate checks keep the exact answer.
   */
  findPath(startX, startZ, goalX, goalZ, radiusCells = 3, { bestEffort = false } = {}) {
    if (this.dynamicDirty) this.rebuildDynamicMask();
    const n = this.n;
    let gi = this.cellX(goalX), gj = this.cellZ(goalZ);
    if (!this.inBounds(this.cellX(startX), this.cellZ(startZ)) || !this.inBounds(gi, gj)) return null;

    // Snap the goal to a cell with enough clearance, else the flood never reaches it.
    if (this.clearance[gj * n + gi] < radiusCells || this.dynamicClearance[gj * n + gi] < radiusCells) {
      const snapped = this._snapToClearance(gi, gj, radiusCells, 14);
      if (!snapped) return null;
      gi = snapped.i; gj = snapped.j;
    }
    /**
     * AND THE START. A body standing closer to a crate than its own path clearance - which
     * is where a spawn point beside cover, a slide along a wall or a shove from a crowd
     * leaves it - is not inside the crate, but the search would begin in a cell it refuses
     * to enter and return nothing; the body then walks straight at the player, pins itself
     * on the very obstacle it is standing next to, drops the path, searches again and gets
     * nothing again, for as long as the wave lasts. Starting from the nearest clear cell
     * makes the first waypoint a step out of the pinch, which moveDisc's sliding delivers.
     */
    let si = this.cellX(startX), sj = this.cellZ(startZ);
    if (this.clearance[sj * n + si] < radiusCells || this.dynamicClearance[sj * n + si] < radiusCells) {
      const snapped = this._snapToClearance(si, sj, radiusCells, 14);
      if (!snapped) return null;
      si = snapped.i; sj = snapped.j;
    }

    const epoch = ++this._navEpoch;
    const stamp = this._navStamp, from = this._navFrom, q = this._queue;
    let head = 0, tail = 0;
    const gIdx = gj * n + gi;
    stamp[gIdx] = epoch; from[gIdx] = -1; q[tail++] = gIdx;

    const sIdx = sj * n + si;
    let found = stamp[sIdx] === epoch;
    const clearance = this.clearance;
    const dyn = this.dynamicClearance;

    while (head < tail && !found) {
      const c = q[head++];
      const ci = c % n, cj = (c / n) | 0;
      for (let k = 0; k < 4; k++) {
        const ni = ci + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const nj = cj + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const idx = nj * n + ni;
        if (stamp[idx] === epoch) continue;
        if (!this.walkable[idx]) continue;
        if (clearance[idx] < radiusCells) continue;
        if (dyn[idx] < radiusCells) continue;
        stamp[idx] = epoch;
        from[idx] = c;
        q[tail++] = idx;
        if (idx === sIdx) { found = true; break; }
      }
    }

    if (!found) return bestEffort ? this._nearestReachable(sIdx, gi, gj, radiusCells) : null;

    const path = this._pathScratch;
    path.length = 0;
    let cur = sIdx;
    let guard = 0;
    while (cur !== -1 && guard++ < n * n) {
      path.push({ x: this.worldX(cur % n), z: this.worldZ((cur / n) | 0) });
      if (cur === gIdx) break;
      cur = from[cur];
    }
    // The true goal may have been snapped; finish at the caller's point.
    path.push({ x: goalX, z: goalZ });
    return this._smoothPath(path, radiusCells * this.cell);
  }

  /**
   * The best-effort answer: flood from the START over the same predicates findPath uses,
   * keep the visited cell nearest the goal, and hand back the path to it. Runs only after
   * the exact search has failed, so it costs one more flood on a frame that already paid
   * for one, and only for callers that asked for it.
   */
  _nearestReachable(sIdx, gi, gj, radiusCells) {
    const n = this.n;
    const epoch = ++this._navEpoch;
    const stamp = this._navStamp, from = this._navFrom, q = this._queue;
    const clearance = this.clearance, dyn = this.dynamicClearance;
    let head = 0, tail = 0;
    stamp[sIdx] = epoch; from[sIdx] = -1; q[tail++] = sIdx;
    let best = sIdx, bestD = Infinity;
    while (head < tail) {
      const c = q[head++];
      const ci = c % n, cj = (c / n) | 0;
      const d = (ci - gi) * (ci - gi) + (cj - gj) * (cj - gj);
      if (d < bestD) { bestD = d; best = c; }
      for (let k = 0; k < 4; k++) {
        const ni = ci + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const nj = cj + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const idx = nj * n + ni;
        if (stamp[idx] === epoch) continue;
        if (!this.walkable[idx]) continue;
        if (clearance[idx] < radiusCells) continue;
        if (dyn[idx] < radiusCells) continue;
        stamp[idx] = epoch;
        from[idx] = c;
        q[tail++] = idx;
      }
    }
    if (best === sIdx) return null;
    // `from` points back toward the start, so the walk comes out goal-first: reverse it.
    const path = this._pathScratch;
    path.length = 0;
    let cur = best, guard = 0;
    while (cur !== -1 && guard++ < n * n) {
      path.push({ x: this.worldX(cur % n), z: this.worldZ((cur / n) | 0) });
      cur = from[cur];
    }
    path.reverse();
    return this._smoothPath(path, radiusCells * this.cell);
  }

  /**
   * String-pull: drop any waypoint the body can see past. Cuts a 200-cell BFS path down
   * to a handful of corners, which is what makes the movement read as deliberate rather
   * than grid-stepped.
   */
  _smoothPath(path, radius) {
    if (path.length <= 2) return path.slice();
    const out = [path[0]];
    let i = 0;
    // Only look a bounded distance ahead. Unbounded string-pulling is O(n^2) in the raw
    // BFS path length, which for a 70 m cross-level route is thousands of visibility
    // samples per repath - far too much with 20 enemies repathing twice a second.
    const WINDOW = 24;
    while (i < path.length - 1) {
      let j = Math.min(path.length - 1, i + WINDOW);
      for (; j > i + 1; j--) {
        if (this._discCanTravel(path[i].x, path[i].z, path[j].x, path[j].z, radius)) break;
      }
      out.push(path[j]);
      i = j;
    }
    return out;
  }

  /** Sample along a segment checking a disc of `radius` fits the whole way. */
  _discCanTravel(x0, z0, x1, z1, radius) {
    const d = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(2, Math.ceil(d / (this.cell * 0.8)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      if (!this.isFree(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, radius)) return false;
    }
    return true;
  }

  _snapToClearance(i, j, minClearance, maxRings) {
    const n = this.n;
    for (let r = 1; r <= maxRings; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const ii = i + di, jj = j + dj;
          if (!this.inBounds(ii, jj)) continue;
          if (this.clearance[jj * n + ii] >= minClearance && this.dynamicClearance[jj * n + ii] >= minClearance) return { i: ii, j: jj };
        }
      }
    }
    return null;
  }

  /** Two-pass chamfer distance transform over the static mask, in cell units. */
  _buildClearance() {
    const n = this.n, INF = 1e6;
    const d = new Float32Array(n * n);
    for (let k = 0; k < n * n; k++) d[k] = this.walkable[k] ? INF : 0;
    const D1 = 1, D2 = Math.SQRT2;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const c = j * n + i;
      if (d[c] === 0) continue;
      let v = d[c];
      if (i > 0) v = Math.min(v, d[c - 1] + D1);
      if (j > 0) v = Math.min(v, d[c - n] + D1);
      if (i > 0 && j > 0) v = Math.min(v, d[c - n - 1] + D2);
      if (i < n - 1 && j > 0) v = Math.min(v, d[c - n + 1] + D2);
      d[c] = v;
    }
    for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) {
      const c = j * n + i;
      if (d[c] === 0) continue;
      let v = d[c];
      if (i < n - 1) v = Math.min(v, d[c + 1] + D1);
      if (j < n - 1) v = Math.min(v, d[c + n] + D1);
      if (i < n - 1 && j < n - 1) v = Math.min(v, d[c + n + 1] + D2);
      if (i > 0 && j < n - 1) v = Math.min(v, d[c + n - 1] + D2);
      d[c] = v;
    }
    return d;
  }

  /** Flood-fill reachability test, used by the level validator. */
  isReachable(fromX, fromZ, toX, toZ, radiusCells = 3) {
    return this.findPath(fromX, fromZ, toX, toZ, radiusCells) !== null;
  }
}
