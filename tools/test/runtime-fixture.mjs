import { Terrain } from '../../src/sim/Terrain.js';
import { gridModuleFor } from '../../src/world/navgrid.js';
import { Game } from '../../src/game/Game.js';

export function flatLevel(height = 0) {
  const n = 64, walkable = new Uint8Array(n * n);
  for (let z = 1; z < n - 1; z++) for (let x = 1; x < n - 1; x++) walkable[z * n + x] = 1;
  const nav = { gridN: n, cell: 1, origin: { x: -32, z: -32 }, walkable };
  return { spec: { world: { seed: 'K7QN-3F2A-9XBD' } },
    terrain: new Terrain({ res: 2, size: n, data: new Float32Array(4).fill(height), min: height, max: height }),
    grid: gridModuleFor(nav, n), spawn: { position: { x: 0, z: 0 }, yaw: 0, pitch: 0 }, placements: [] };
}

export function makeGame(options = {}) {
  const game = new Game({ level: flatLevel(), ...options });
  game.start();
  return game;
}
