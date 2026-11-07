/**
 * PAINTED REGIONS: spawn zones, paths and no-go ground, on a one-metre grid over the 80 m meadow.
 *
 * A region never touches the terrain maths (world/worldTerrain.js, and its Blender port for parity): a path clears
 * the village's clutter from its cells and is painted into the ground overlay, a no-go cell is refused by the nav
 * grid for every body, and a spawn zone is where enemies without a placed spot appear. Stored as one run-length
 * string per level: `<count><char>` runs, row by row from the far-left corner (x = -40, z = -40), `.` for none.
 */

export const REGION_N = 80;
export const REGION_HALF = REGION_N / 2;
export const REGION_KINDS = {
  spawn: { code: 1, char: 's', label: 'Spawn zone', hint: 'Enemies without a placed spot appear here.' },
  path: { code: 2, char: 'p', label: 'Path', hint: 'Clears trees, rocks and flowers, and lays packed sand.' },
  nogo: { code: 3, char: 'x', label: 'No-go', hint: 'No one walks here: the player and the critters turn back.' },
};
const CHARS = ['.', ...Object.values(REGION_KINDS).map(k => k.char)];
export const REGION_CODES = Object.fromEntries(Object.entries(REGION_KINDS).map(([id, k]) => [id, k.code]));
/** The longest region string a level may carry: a checkerboard would be 12 800 chars, so a painted level is far under. */
export const MAX_REGION_TEXT = 12000;

export function emptyRegions() { return new Uint8Array(REGION_N * REGION_N); }

export function encodeRegions(cells) {
  let out = '', run = 0, code = cells[0];
  if (!cells.some(c => c)) return '';
  for (let i = 0; i <= cells.length; i++) {
    if (i < cells.length && cells[i] === code) { run++; continue; }
    out += `${run}${CHARS[code]}`;
    code = cells[i]; run = 1;
  }
  return out;
}

/** Decode a region string; throws on anything but whole runs of known codes that fill the grid exactly. */
export function decodeRegions(text) {
  const cells = emptyRegions();
  if (!text) return cells;
  if (typeof text !== 'string' || text.length > MAX_REGION_TEXT) throw Error('regions: expected a run-length string');
  let i = 0;
  for (const m of text.matchAll(/(\d+)(.)|(.)/g)) {
    if (m[3] !== undefined) throw Error(`regions: unexpected "${m[3]}"`);
    const n = Number(m[1]), code = CHARS.indexOf(m[2]);
    if (code < 0 || !(n > 0) || i + n > cells.length) throw Error('regions: malformed run');
    cells.fill(code, i, i + n); i += n;
  }
  if (i !== cells.length) throw Error(`regions: ${i} of ${cells.length} cells`);
  return cells;
}

export function regionIndex(x, z) {
  const i = Math.floor(x + REGION_HALF), j = Math.floor(z + REGION_HALF);
  return i < 0 || j < 0 || i >= REGION_N || j >= REGION_N ? -1 : j * REGION_N + i;
}
export function regionAt(cells, x, z) { const k = regionIndex(x, z); return k < 0 ? 0 : cells[k]; }
export function regionCentre(index) { return { x: (index % REGION_N) - REGION_HALF + 0.5, z: Math.floor(index / REGION_N) - REGION_HALF + 0.5 }; }

/** The cells a round brush of radius `r` metres covers at (x, z): the ones whose centre is inside it. */
export function brushCells(x, z, r) {
  const out = [], lo = Math.max(0, Math.floor(z - r + REGION_HALF)), hi = Math.min(REGION_N - 1, Math.floor(z + r + REGION_HALF));
  const left = Math.max(0, Math.floor(x - r + REGION_HALF)), right = Math.min(REGION_N - 1, Math.floor(x + r + REGION_HALF));
  for (let j = lo; j <= hi; j++) for (let i = left; i <= right; i++) {
    const cx = i - REGION_HALF + 0.5, cz = j - REGION_HALF + 0.5;
    if ((cx - x) ** 2 + (cz - z) ** 2 <= r * r) out.push(j * REGION_N + i);
  }
  if (!out.length) { const k = regionIndex(x, z); if (k >= 0) out.push(k); }
  return out;
}

/** How many cells of each kind a level has painted. */
export function regionCounts(cells) {
  const counts = Object.fromEntries(Object.keys(REGION_KINDS).map(k => [k, 0]));
  const byCode = Object.entries(REGION_CODES);
  for (const c of cells) if (c) counts[byCode.find(([, v]) => v === c)[0]]++;
  return counts;
}
