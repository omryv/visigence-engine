/**
 * A level drawn small: the level strip's thumbnails and the generator's previews. With room for
 * at least three pixels a cell it is the real art; below that, flat map colours by biome.
 */
import { drawScene, sceneFromLevel } from '../runtime/render.js';
import { genreById, entityDef } from '../core/catalog.js';
import { DEFAULT_SETTINGS } from '../core/format.js';
import { mapBackground, mapColor } from '../art/palette.js';

export function drawLevelThumb(canvas, level, genre, art) {
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const view = genreById(genre)?.view || 'top';
  g.fillStyle = mapBackground(level.biome, view);
  g.fillRect(0, 0, W, H);
  const s = Math.min(W / level.width, H / level.height);
  const ox = (W - level.width * s) / 2, oy = (H - level.height * s) / 2;
  if (s >= 3) {
    const scene = sceneFromLevel({ genre, settings: { ...DEFAULT_SETTINGS }, levels: [level] }, 0, 0);
    g.save(); g.translate(Math.round(ox), Math.round(oy));
    drawScene(g, scene, { x: 0, y: 0, size: Math.floor(s) }, art, { width: W, height: H, t: 0, editor: true, background: true });
    g.restore();
    return;
  }
  for (let y = 0; y < level.height; y++) for (let x = 0; x < level.width; x++) {
    const c = level.terrain[y * level.width + x];
    if (!c) continue;
    g.fillStyle = mapColor(c, level.biome, view);
    g.fillRect(ox + x * s, oy + y * s, Math.ceil(s), Math.ceil(s));
  }
  for (const e of level.entities) {
    g.fillStyle = e.type === 'player' ? '#ff9f45' : entityDef(e.type)?.enemy ? '#ff6257' : e.type === 'goal' ? '#5ad8c4' : '#ffe38a';
    g.fillRect(ox + e.x * s - 0.5, oy + e.y * s - 0.5, Math.max(2, s + 1), Math.max(2, s + 1));
  }
}
