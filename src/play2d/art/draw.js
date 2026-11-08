/**
 * Drawing helpers shared by the tiles and the cast. Every sprite is drawn in tile units: the
 * caller translates to the sprite's anchor and scales by the pixel size of a tile, so one path
 * serves a 16 px palette icon and a 96 px close-up. `unit(ctx, size)` sets the outline width
 * for that scale, which is what keeps line weight identical across the whole set.
 */
import { INK, outlineWidth } from './palette.js';

/** Begin a sprite: save, translate to (x, y) in pixels, scale to tile units, set the ink line. */
export function unit(ctx, x, y, size) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size, size);
  ctx.lineWidth = outlineWidth(size) / size;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = INK;
}

export function rr(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function ell(ctx, cx, cy, rx, ry, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(0.0001, rx), Math.max(0.0001, ry), rot, 0, Math.PI * 2);
}

/** Fill the current path, then stroke it with ink. */
export function fs(ctx, fill) {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.stroke();
}

/**
 * Three-tone fill: the shape in its shade colour, then the base colour over the same shape
 * shifted toward the upper-left light, clipped to the shape. What is left is a crescent of
 * shade on the lower-right. Then the ink outline. Highlights are the sprite's own business.
 */
export function lit(ctx, pathFn, base, shade, off = 0.07) {
  pathFn();
  ctx.fillStyle = shade || base;
  ctx.fill();
  if (shade) {
    ctx.save();
    pathFn();
    ctx.clip();
    ctx.translate(-off, -off);
    pathFn();
    ctx.fillStyle = base;
    ctx.fill();
    ctx.restore();
  }
  pathFn();
  ctx.stroke();
}

/** A soft contact shadow under a top-view sprite. */
export function shadow(ctx, cx, cy, rx, ry, alpha = 0.22) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#1a120c';
  ell(ctx, cx, cy, rx, ry);
  ctx.fill();
  ctx.restore();
}

/** Cartoon eyes: dark ovals with a white glint, optionally blinking. */
export function eyes(ctx, points, r, blink = 0, look = 0) {
  for (const [x, y] of points) {
    ctx.fillStyle = INK;
    ell(ctx, x + look * r * 0.3, y, r * 0.78, r * Math.max(0.12, 1 - blink));
    ctx.fill();
    if (blink < 0.6) {
      ctx.fillStyle = '#ffffff';
      ell(ctx, x + look * r * 0.3 - r * 0.28, y - r * 0.38, r * 0.3, r * 0.3);
      ctx.fill();
    }
  }
}

/** A four-point sparkle (pickups, chests, the shrine). */
export function sparkle(ctx, x, y, r, color = '#ffffff', alpha = 1) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.quadraticCurveTo(x, y, x, y - r);
  ctx.fill();
  ctx.restore();
}

/** A radial glow (lights only: lanterns, crystals, jelly). */
export function glow(ctx, x, y, r, color, alpha = 1) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A heart path centred at (x, y) with half-width r. */
export function heartPath(ctx, x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x, y + r * 0.9);
  ctx.bezierCurveTo(x - r * 1.35, y + r * 0.05, x - r * 0.95, y - r * 1.05, x, y - r * 0.4);
  ctx.bezierCurveTo(x + r * 0.95, y - r * 1.05, x + r * 1.35, y + r * 0.05, x, y + r * 0.9);
  ctx.closePath();
}

/** A honey-drop path: round bottom, pointed top. */
export function dropPath(ctx, x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x, y - r * 1.45);
  ctx.bezierCurveTo(x + r * 0.35, y - r * 0.8, x + r, y - r * 0.35, x + r, y + r * 0.1);
  ctx.arc(x, y + r * 0.1, r, 0, Math.PI);
  ctx.bezierCurveTo(x - r, y - r * 0.35, x - r * 0.35, y - r * 0.8, x, y - r * 1.45);
  ctx.closePath();
}

export const TAU = Math.PI * 2;
export const wave = (t, speed = 1, phase = 0) => Math.sin((t * speed + phase) * TAU);
export const ease = x => x * x * (3 - 2 * x);
export const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
