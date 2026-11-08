/**
 * Backdrops and grading. Side view gets a layered parallax sky: a gradient, far and near
 * silhouettes shaped by the biome (meadow hills, desert dunes and mesas, snow peaks) and
 * drifting clouds. Top view gets the biome's ground colour (the floor tiles add the texture).
 * `grade` lays the time of day over the finished scene; `darkness` cuts light pools out of a
 * night overlay for adventure levels played in the dark.
 */
import { BIOME_PALETTES, TIME_GRADES, mix } from './palette.js';
import { cellHash } from '../core/grid.js';

const pal = biome => BIOME_PALETTES[biome] || BIOME_PALETTES.meadow;

export function drawBackground(ctx, w, h, info) {
  const P = pal(info.biome);
  const grade = TIME_GRADES[info.time] || null;
  if (info.view !== 'side') {
    ctx.fillStyle = P.floor.base;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  const sky = grade?.sky || P.sky;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, sky[0]);
  g.addColorStop(1, sky[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const size = info.size || 32;
  const camX = info.camX || 0, camY = info.camY || 0;
  const levelH = info.levelH || 24;
  // the horizon sits low, and drifts gently with the camera's height
  const viewTiles = h / size;
  const horizon = h * 0.62 + ((levelH - viewTiles) * 0.5 - camY) * size * 0.12;
  if (grade?.stars) stars(ctx, w, horizon, camX * size * 0.05);
  if (info.time === 'night') moon(ctx, w * 0.78 - camX * size * 0.02, h * 0.18, Math.max(18, size * 0.8));
  else sun(ctx, w * 0.8 - camX * size * 0.02, h * 0.16, Math.max(20, size * 0.9), info.time === 'golden');
  clouds(ctx, w, horizon, size, camX, info.t || 0, P, grade);
  const far = grade ? mix(P.far, grade.tint, grade.alpha * 1.4) : P.far;
  const near = grade ? mix(P.near, grade.tint, grade.alpha * 1.2) : P.near;
  ridge(ctx, w, h, horizon - size * 1.2, size, camX * size * 0.18, far, info.biome, 1, grade);
  ridge(ctx, w, h, horizon + size * 0.9, size, camX * size * 0.42, near, info.biome, 2, grade);
  // haze where the near ridge meets the ground
  const hz = ctx.createLinearGradient(0, horizon, 0, h);
  hz.addColorStop(0, 'rgba(255,255,255,0)');
  hz.addColorStop(1, grade ? mix(P.haze, grade.tint, grade.alpha) : P.haze);
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = hz;
  ctx.fillRect(0, horizon, w, h - horizon);
  ctx.globalAlpha = 1;
}

function ridge(ctx, w, h, baseY, size, offset, color, biome, layer, grade) {
  const span = size * (layer === 1 ? 9 : 6);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, h);
  const step = Math.max(4, size / 4);
  for (let x = 0; x <= w + step; x += step) {
    const u = (x + offset) / span;
    let y;
    if (biome === 'desert') {
      // dunes, with a flat-topped mesa now and then on the far layer
      y = Math.sin(u * 1.3) * 0.5 + Math.sin(u * 2.9 + 1) * 0.25;
      if (layer === 1) { const m = Math.sin(u * 0.45 + 2); if (m > 0.72) y = -1.6 + Math.sin(u * 9) * 0.05; }
    } else if (biome === 'snow') {
      const saw = Math.abs(((u * 0.9) % 2 + 2) % 2 - 1);
      y = (layer === 1 ? -2.4 : -1) * (1 - saw) + Math.sin(u * 3.1) * 0.2;
    } else {
      y = Math.sin(u) * 0.7 + Math.sin(u * 2.3 + 1.7) * 0.35;
    }
    ctx.lineTo(x, baseY + y * size * (layer === 1 ? 1.3 : 0.9));
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
  if (biome === 'snow' && layer === 1) {
    // snow caps: redraw the peaks in white, clipped to the top of the ridge
    ctx.save();
    ctx.clip();
    ctx.fillStyle = grade ? mix('#ffffff', grade.tint, grade.alpha) : '#ffffff';
    ctx.fillRect(0, 0, w, baseY - size * 1.6);
    ctx.restore();
  }
  if (biome === 'meadow' && layer === 2) {
    // little round trees along the near hills
    ctx.fillStyle = mix(color, '#2c6a34', 0.35);
    for (let i = -1; i < w / (size * 2.2) + 1; i++) {
      const wx = i * size * 2.2 - (offset % (size * 2.2));
      const k = Math.floor((i * size * 2.2 + offset) / (size * 2.2));
      if (cellHash(k, 3, 9) < 0.45) continue;
      const u = (wx + offset) / span;
      const y = baseY + (Math.sin(u) * 0.7 + Math.sin(u * 2.3 + 1.7) * 0.35) * size * 0.9;
      const r = size * (0.35 + cellHash(k, 4, 9) * 0.25);
      ctx.beginPath(); ctx.arc(wx, y - r * 0.6, r, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function clouds(ctx, w, horizon, size, camX, t, P, grade) {
  const col = grade ? mix(P.cloud, grade.tint, grade.alpha * 1.5) : P.cloud;
  ctx.fillStyle = col;
  ctx.globalAlpha = grade?.stars ? 0.25 : 0.85;
  const band = size * 7;
  for (let i = -1; i < w / band + 2; i++) {
    const drift = t * size * 0.15 + camX * size * 0.08;
    const k = Math.floor((i * band + drift) / band);
    const x = i * band - (drift % band) + cellHash(k, 1, 7) * band * 0.5;
    const y = horizon * (0.18 + cellHash(k, 2, 7) * 0.45);
    const s = size * (0.6 + cellHash(k, 3, 7) * 0.6);
    ctx.beginPath();
    ctx.arc(x, y, s, Math.PI * 0.5, Math.PI * 1.5);
    ctx.arc(x + s * 1.3, y - s * 0.5, s * 1.2, Math.PI, Math.PI * 2);
    ctx.arc(x + s * 2.6, y, s, Math.PI * 1.5, Math.PI * 0.5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function sun(ctx, x, y, r, golden) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
  g.addColorStop(0, golden ? 'rgba(255, 214, 140, 0.95)' : 'rgba(255, 252, 230, 0.95)');
  g.addColorStop(0.3, golden ? 'rgba(255, 180, 100, 0.35)' : 'rgba(255, 250, 220, 0.3)');
  g.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r * 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = golden ? '#ffd9a0' : '#fffbe8';
  ctx.beginPath(); ctx.arc(x, y, r * 0.8, 0, Math.PI * 2); ctx.fill();
}
function moon(ctx, x, y, r) {
  ctx.fillStyle = 'rgba(220, 230, 255, 0.18)';
  ctx.beginPath(); ctx.arc(x, y, r * 2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#eef2ff';
  ctx.beginPath(); ctx.arc(x, y, r * 0.8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(160, 170, 210, 0.5)';
  ctx.beginPath(); ctx.arc(x - r * 0.25, y - r * 0.1, r * 0.16, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(x + r * 0.2, y + r * 0.25, r * 0.1, 0, Math.PI * 2); ctx.fill();
}
function stars(ctx, w, horizon, offset) {
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 90; i++) {
    const x = ((cellHash(i, 1, 11) * w * 1.5 - offset) % w + w) % w;
    const y = cellHash(i, 2, 11) * horizon * 0.9;
    const r = 0.6 + cellHash(i, 3, 11) * 1.3;
    ctx.globalAlpha = 0.4 + cellHash(i, 4, 11) * 0.6;
    ctx.fillRect(x, y, r, r);
  }
  ctx.globalAlpha = 1;
}

/** Lay the time of day over a finished scene. */
export function drawGrade(ctx, w, h, info) {
  const grade = TIME_GRADES[info.time];
  if (!grade) return;
  ctx.save();
  if (info.time === 'night') {
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = '#7c88c2';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = grade.tint;
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = grade.tint;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.07;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
}

/**
 * Night darkness with soft pools of light. `lights` are {x, y, r} in canvas pixels. The mask
 * is drawn into a scratch canvas owned by the caller (`scratch`), sized to the target.
 */
export function drawDarkness(ctx, w, h, lights, scratch) {
  if (!scratch) return;
  if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
  const m = scratch.getContext('2d');
  m.globalCompositeOperation = 'source-over';
  m.clearRect(0, 0, w, h);
  m.fillStyle = 'rgba(6, 8, 22, 0.9)';
  m.fillRect(0, 0, w, h);
  m.globalCompositeOperation = 'destination-out';
  for (const l of lights) {
    const g = m.createRadialGradient(l.x, l.y, l.r * 0.15, l.x, l.y, l.r);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.75)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    m.fillStyle = g;
    m.beginPath(); m.arc(l.x, l.y, l.r, 0, Math.PI * 2); m.fill();
  }
  m.globalCompositeOperation = 'source-over';
  ctx.drawImage(scratch, 0, 0);
}
