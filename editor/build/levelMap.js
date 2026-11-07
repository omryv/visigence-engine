/**
 * A compiled level as a map, north up (the start at the bottom, the mission running up the page): the lanes, the
 * water, the houses and landmarks, what stands solid, the painted ground, the mission's pads, honey and extraction,
 * the placed things, and the start. The start screen's cards draw their levels with it, from the same compile the
 * editor and the game use, so a card shows what the template really is.
 *
 * Returns SVG markup over the 80 m square (viewBox -40..40 on both axes, world X right, world Z down). Colours are
 * CSS classes (`map-*`, editor/build/build.css), so the map follows the design tokens and the light and dark themes.
 */
import { decodeRegions, REGION_N, REGION_HALF } from '../../src/world/level/regions.js';

const n2 = v => Math.round(v * 100) / 100;
const deg = yaw => n2(-yaw * 180 / Math.PI);
const BIOME = { desert: 'desert', snow: 'snow' };
const REGION_CLASS = ['', 'map-spawn', 'map-path', 'map-nogo'];
const SOLID = new Set(['fence', 'rocks', 'barrel', 'hayBarricade', 'woodGate', 'crystalShrine']);

/** A rectangle turned by a world yaw, centred on (x, z). */
const box = (x, z, hx, hz, yaw, cls) => `<rect class="${cls}" x="${n2(-hx)}" y="${n2(-hz)}" width="${n2(hx * 2)}" height="${n2(hz * 2)}" transform="translate(${n2(x)} ${n2(z)}) rotate(${deg(yaw ?? 0)})"/>`;
const dot = (x, z, r, cls) => `<circle class="${cls}" cx="${n2(x)}" cy="${n2(z)}" r="${n2(r)}"/>`;
const line = (pts, w, cls) => `<polyline class="${cls}" stroke-width="${n2(w)}" points="${pts.map(([x, z]) => `${n2(x)},${n2(z)}`).join(' ')}"/>`;

/**
 * @param {object} level  a compiled level (world/shooterProject.js compileShooterProject)
 * @param {{title?: string}} [o]  an accessible name for the map
 */
export function levelMapSvg(level, { title = 'Level map' } = {}) {
  const w = level.world, out = [];
  const biome = BIOME[level.worldKit?.biome ?? level.worldKit?.id] ?? 'meadow';
  out.push(`<rect class="map-ground map-ground--${biome}" x="-40" y="-40" width="80" height="80"/>`);
  // Painted ground: runs of one kind along each row, merged.
  const cells = (() => { try { return decodeRegions(level.edits?.regions ?? ''); } catch { return null; } })();
  if (cells?.some(c => c)) for (let j = 0; j < REGION_N; j++) {
    let i = 0;
    while (i < REGION_N) {
      const c = cells[j * REGION_N + i]; let k = i + 1;
      while (k < REGION_N && cells[j * REGION_N + k] === c) k++;
      if (c) out.push(`<rect class="${REGION_CLASS[c]}" x="${i - REGION_HALF}" y="${j - REGION_HALF}" width="${k - i}" height="1"/>`);
      i = k;
    }
  }
  if (w) {
    for (const s of w.spurs ?? []) out.push(line(s.pts, s.w, 'map-lane'));
    for (const l of w.lanes ?? []) out.push(line(l.pts, l.w, 'map-lane'));
    if (w.square) out.push(dot(w.square.x, w.square.z, w.square.r, 'map-lane map-square'));
    const B = w.water?.brook;
    if (B?.pts) out.push(line(B.pts, B.w ?? 1.6, 'map-water map-brook'));
    for (const p of w.water?.ponds ?? []) {
      const r = p.radii ?? [p.r], pts = r.map((ri, k) => { const a = k / r.length * Math.PI * 2; return `${n2(p.x + Math.cos(a) * ri)},${n2(p.z + Math.sin(a) * ri)}`; });
      out.push(`<polygon class="map-water" points="${pts.join(' ')}"/>`);
    }
  }
  for (const p of level.placements) {
    if (p.collisionOnly || p.lockOf) continue;
    if (p.house) out.push(box(p.x, p.z, p.halfX, p.halfZ, p.yaw, 'map-house'));
    else if (p.landmark) out.push(dot(p.x, p.z, 2.2, 'map-landmark'));
    else if (p.tree) out.push(dot(p.x, p.z, Math.min(2.2, (p.crown ?? 2) * 0.45), 'map-tree'));
    else if (p.entity && p.lock) out.push(box(p.x, p.z, p.halfX ?? 2.2, Math.max(0.45, p.halfZ ?? 0.45), p.yaw, `map-door map-door--${p.lock}`));
    else if (p.pickup === 'key') out.push(dot(p.x, p.z, 0.9, `map-key map-key--${p.color}`));
    else if (p.pickup === 'collectible') out.push(dot(p.x, p.z, 0.55, 'map-drop'));
    else if (p.stepId && p.role !== 'checkpoint') out.push(dot(p.x, p.z, 1.5, 'map-pad'));
    else if (p.role === 'checkpoint') out.push(dot(p.x, p.z, 1.9, 'map-pad map-pad--reach'));
    else if (p.lever) out.push(box(p.x, p.z, 0.5, 0.5, p.yaw, 'map-lever'));
    else if (p.role === 'respawn') out.push(dot(p.x, p.z, 1, 'map-flag'));
    else if (p.pickup) out.push(dot(p.x, p.z, 0.6, 'map-supply'));
    else if (SOLID.has(p.id) && p.collision === 'box') out.push(box(p.x, p.z, p.halfX, Math.max(0.2, p.halfZ), p.yaw, p.entity && p.id === 'woodGate' ? 'map-door' : 'map-solid'));
  }
  for (const e of level.entities ?? []) {
    if (e.type === 'trigger') out.push(box(e.x, e.z, e.props.w / 2, e.props.d / 2, e.yaw, 'map-zone'));
    if (e.type === 'enemy') out.push(dot(e.x, e.z, 0.7 + 0.15 * e.props.count, 'map-enemy'));
  }
  const ex = level.extraction;
  if (ex && level.blueprint?.mission.some(s => s.objective === 'extract')) out.push(dot(ex.x, ex.z, 2.3, 'map-extract'));
  const s = level.spawn?.position, yaw = level.spawn?.yaw ?? 0;
  if (s) out.push(`<path class="map-start" d="M0 -2.2L1.6 1.4L0 0.6L-1.6 1.4Z" transform="translate(${n2(s.x)} ${n2(s.z)}) rotate(${deg(yaw)})"/>`);
  return `<svg class="map" viewBox="-40 -40 80 80" role="img" aria-label="${title.replace(/[<&"]/g, '')}" preserveAspectRatio="xMidYMid meet">${out.join('')}</svg>`;
}
