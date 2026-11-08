/**
 * A WORLD AS A PROJECT CARRIES IT: its params and the site a mission stands at, checked. A module of its own, with no
 * imports, so what only reads or writes a world's address (world/worldLink.js, world/editorMission.js, the editor)
 * does not load the mission compiler with it (world/shooterProject.js re-exports these).
 */
/**
 * A world's params as a project carries them: its `terrain` and `water` blocks only (what decides the ground and the
 * sea; the sky, the palette and the placements are the world editor's business), plain JSON, bounded in size so a
 * project file stays a project file. `null` when absent.
 */
export const WORLD_PARAMS_MAX_BYTES = 512 * 1024;
/** A chosen site as a project carries it: `{ x, z }`, finite plate metres, to the decimetre; `null` when absent. */
export function normalizeWorldSite(input) {
  if (input == null) return null;
  const x = Number(input.x), z = Number(input.z);
  if (typeof input !== 'object' || !Number.isFinite(x) || !Number.isFinite(z)) throw new Error('worldSite must be { x, z } in metres');
  return { x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 };
}
export function normalizeWorldParams(input) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('worldParams must be an object');
  const out = {};
  for (const k of ['terrain', 'water']) {
    if (input[k] == null) continue;
    if (typeof input[k] !== 'object' || Array.isArray(input[k])) throw new Error(`worldParams.${k} must be an object`);
    out[k] = JSON.parse(JSON.stringify(input[k]));
  }
  if (!out.terrain) return null;
  if (JSON.stringify(out).length > WORLD_PARAMS_MAX_BYTES) throw new Error(`worldParams is over ${WORLD_PARAMS_MAX_BYTES / 1024} KB`);
  return out;
}
