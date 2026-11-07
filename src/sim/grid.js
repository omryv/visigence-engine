/**
 * THE WALKABLE GRID — your game supplies this.
 *
 * `CollisionSystem` takes a grid object and reads six fields off it. What ships here is an
 * EMPTY one with the right shape, so the engine constructs and runs before a level exists;
 * with nothing walkable, every query says "blocked".
 *
 * WALKABLE_PACKED is a base64 bitset, one bit per cell, row-major over GRID_N * GRID_N,
 * bit set meaning the cell can be stood in. Bake it from your own level geometry and pass
 * the module to `new CollisionSystem(myGrid)` — the constructor argument is the seam, and
 * this default exists so that seam is never load-bearing at import time.
 */
export const WORLD_SCALE = 60;
export const WORLD_SCALE_Y = 30;
export const WALL_HEIGHT = 5.0829;
export const GRID_N = 320;
export const CELL_SIZE = WORLD_SCALE / GRID_N;
export const GRID_ORIGIN = { x: -WORLD_SCALE / 2, z: -WORLD_SCALE / 2 };
export const MAZE_BOUNDS = { min: { x: -0.5, z: -0.5 }, max: { x: 0.5, z: 0.5 } };
export const WALKABLE_PACKED = '';
