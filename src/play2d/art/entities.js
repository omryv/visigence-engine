/**
 * The cast: every entity in the catalogue, drawn procedurally in the Arcade toon style (flat
 * three-tone fills, warm ink outline, one key light from the upper left, chunky rounded shapes).
 *
 *   drawEntity(ctx, ent, box, size, info)
 *   drawProjectile(ctx, p, cx, cy, size, info)
 *
 * `box` is the entity's box in canvas pixels, `size` the pixels per tile. Characters stand on
 * the bottom-centre of their box in side view; in top view they stand a little below the box
 * centre with a contact shadow, in a 3/4 pose (front, back or profile from `ent.dir`). Flat
 * things (gates, crates, plates, platforms, burrows) fill their box.
 *
 * Animation comes from `ent.anim` + `ent.animTime`; in the editor (`info.editor`) idle loops
 * run on `info.t`. Nothing here allocates per frame beyond the canvas calls themselves.
 */
import { SPRITE, INK, keyHex, mix } from './palette.js';
import { unit, rr, ell, fs, lit, shadow, eyes, sparkle, glow, heartPath, dropPath, TAU, wave, clamp01 } from './draw.js';

let FLASH = 0;
/** Colours pass through here so a hit flash can whiten the whole sprite. */
const C = hex => (FLASH > 0 && hex[0] === '#' ? mix(hex, '#ffffff', FLASH) : hex);

const CHANNEL = [
  ['#8a5fe0', '#b98cff'], // violet
  ['#1e9aa6', '#5fd8d0'], // teal
  ['#d9467f', '#ff8fbd'], // rose
  ['#d99a1e', '#ffd35c'], // gold
];

export function drawEntity(ctx, e, box, size, info = {}) {
  const view = info.view || 'side';
  const t = info.t || 0;
  if (e.invuln > 0 && !info.editor && Math.floor(e.invuln * 14) % 2 === 1) return;
  const dead = e.alive === false || e.anim === 'dead';
  if (dead && !['player', 'slime', 'bee', 'spiky', 'spirit', 'boss', 'turret', 'door', 'chest', 'crate'].includes(e.type)) return;
  FLASH = clamp01(e.flash || 0);
  const at = info.editor ? t : (e.animTime || 0);
  const fn = DRAW[e.type];
  if (!fn) { FLASH = 0; return; }
  const cx = box.x + box.w / 2;
  if (FILL.has(e.type)) {
    unit(ctx, box.x, box.y, size);
    fn(ctx, e, { ...info, at, t, view, w: box.w / size, h: box.h / size });
    ctx.restore();
  } else {
    const footY = view === 'side' ? box.y + box.h : box.y + box.h / 2 + size * (FLAT.has(e.type) ? 0 : 0.3);
    unit(ctx, cx, footY, size);
    if (view === 'top' && !FLAT.has(e.type) && !AIRBORNE_TOP.has(e.type)) {
      const s = e.type === 'boss' ? 2 : 1;
      shadow(ctx, 0, 0, 0.3 * s, 0.1 * s);
    }
    fn(ctx, e, { ...info, at, t, view, w: box.w / size, h: box.h / size });
    ctx.restore();
  }
  FLASH = 0;
}

/** Types drawn to fill their box; origin at the box's top-left, in tile units. */
const FILL = new Set(['door', 'crate', 'platform', 'plate', 'spawner']);
/** Top-view things that lie flat and are centred on the box, not standing. */
const FLAT = new Set(['coin', 'gem', 'heart', 'key', 'powerup', 'power', 'teleporter']);
/** Top-view things that draw their own shadow further below (they float). */
const AIRBORNE_TOP = new Set(['bee', 'spirit']);

// ---------------------------------------------------------------------------------------------
// The hero (and the villager, who shares the rig)

function hero(ctx, e, o, pal = SPRITE.hero, hat = false) {
  const view = o.view, anim = e.anim || 'idle', at = o.at;
  let pose = 'side';
  let facing = e.facing || 1;
  if (view === 'top') {
    const d = e.dir || 'down';
    pose = d === 'up' ? 'back' : d === 'down' ? 'front' : 'side';
    facing = d === 'left' ? -1 : 1;
  }
  if (anim === 'climb') pose = 'back';
  if (anim === 'win' && view === 'top') pose = 'front';
  if (anim === 'dead') { deadHero(ctx, pal, at, hat); return; }
  const moving = anim === 'run' || anim === 'walk' || anim === 'push';
  const rate = anim === 'run' ? 2.6 : anim === 'push' ? 1.4 : 2.1;
  const cyc = moving ? at * rate : 0;
  const s = Math.sin(cyc * TAU);
  const bob = moving ? Math.abs(Math.cos(cyc * TAU)) * 0.045 : Math.sin(at * 2.2) * 0.012;
  let legA = moving ? s * 0.13 : 0, legB = -legA;
  let liftA = moving ? Math.max(0, -s) * 0.07 : 0, liftB = moving ? Math.max(0, s) * 0.07 : 0;
  let armA = moving ? -s * 0.5 : 0.1, armB = moving ? s * 0.5 : -0.1;
  let lean = anim === 'run' ? 0.1 : anim === 'push' ? 0.22 : 0;
  let armsUp = false;
  if (anim === 'jump') { legA = 0.1; legB = -0.08; liftA = 0.1; liftB = 0.02; armA = -2.2; armB = 0.6; }
  if (anim === 'fall') { legA = 0.04; legB = -0.04; armA = -2.6 + Math.sin(at * 18) * 0.2; armB = -2.4 - Math.sin(at * 18) * 0.2; }
  if (anim === 'hurt') { lean = -0.25; armA = -1.2; armB = -1.4; }
  if (anim === 'win') { armsUp = true; }
  if (anim === 'swim') { lean = 0.5; armA = Math.sin(at * 7) * 1.4; armB = -armA; legA = Math.sin(at * 7) * 0.08; legB = -legA; }
  if (anim === 'climb') { const c = Math.sin(at * 8); liftA = Math.max(0, c) * 0.12; liftB = Math.max(0, -c) * 0.12; }
  const winHop = anim === 'win' ? Math.abs(Math.sin(at * 5)) * 0.1 : 0;
  ctx.save();
  ctx.translate(0, -bob - winHop);
  if (pose === 'side') {
    ctx.scale(facing, 1);
    ctx.rotate(lean * 0.35);
    // back arm and leg
    arm(ctx, -0.04, -0.52, armB, pal.tunicShade, pal.skinShade);
    leg(ctx, -0.07 + legB, liftB, pal);
    // scarf tail streams behind
    const flap = Math.sin(at * (moving ? 12 : 3)) * 0.04;
    ctx.beginPath();
    ctx.moveTo(-0.08, -0.58);
    ctx.quadraticCurveTo(-0.3, -0.6 + flap, -0.42 - (moving ? 0.08 : 0), -0.5 + flap * 2);
    ctx.lineTo(-0.36 - (moving ? 0.06 : 0), -0.44 + flap);
    ctx.quadraticCurveTo(-0.22, -0.5, -0.06, -0.5);
    ctx.closePath();
    fs(ctx, C(pal.scarf));
    body(ctx, pal);
    leg(ctx, 0.06 + legA, liftA, pal);
    head(ctx, 'side', pal, at, anim, hat);
    arm(ctx, 0.05, -0.52, armA, pal.tunic, pal.skin);
  } else {
    // front or back
    leg(ctx, -0.09, pose === 'front' ? liftA : liftB, pal, legA * 0.2);
    leg(ctx, 0.09, pose === 'front' ? liftB : liftA, pal, legB * 0.2);
    const up = armsUp || anim === 'climb';
    const ca = anim === 'climb' ? Math.sin(at * 8) : 0;
    if (pose === 'back') {
      armFront(ctx, -1, up ? -2.7 + ca * 0.4 : armA * 0.4, pal, true);
      armFront(ctx, 1, up ? -2.7 - ca * 0.4 : armB * 0.4, pal, true);
    }
    body(ctx, pal, true);
    // scarf knot
    rr(ctx, -0.16, -0.62, 0.32, 0.09, 0.045);
    fs(ctx, C(pal.scarf));
    if (pose === 'front') {
      ctx.beginPath(); ctx.moveTo(0.05, -0.56); ctx.lineTo(0.13, -0.42); ctx.lineTo(0.02, -0.45); ctx.closePath(); fs(ctx, C(pal.scarfShade));
    }
    head(ctx, pose, pal, at, anim, hat);
    if (pose === 'front') {
      armFront(ctx, -1, up ? -2.7 : armA * 0.4, pal, false);
      armFront(ctx, 1, up ? -2.7 : armB * 0.4, pal, false);
    }
  }
  ctx.restore();
  if (anim === 'win') { sparkle(ctx, -0.35, -1.05 + Math.sin(at * 6) * 0.05, 0.08, '#fff6c9'); sparkle(ctx, 0.38, -0.9, 0.06, '#fff6c9'); }
  if (e.data?.shield > 0) {
    ctx.save();
    ctx.globalAlpha = 0.35 + 0.15 * Math.sin(o.t * 6);
    ell(ctx, 0, -0.5, 0.52, 0.6);
    ctx.fillStyle = SPRITE.fizz.shield; ctx.fill();
    ctx.globalAlpha = 0.9; ctx.strokeStyle = '#e9fff5'; ctx.stroke();
    ctx.restore();
  }
}

function leg(ctx, x, lift, pal, splay = 0) {
  rr(ctx, x - 0.07 + splay, -0.3 - lift, 0.14, 0.22, 0.05);
  fs(ctx, C(pal.pants));
  rr(ctx, x - 0.085 + splay, -0.11 - lift, 0.17 + 0.02, 0.11, 0.05);
  fs(ctx, C(pal.boots));
}
function body(ctx, pal, front = false) {
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(-0.17, -0.6);
    ctx.lineTo(0.17, -0.6);
    ctx.quadraticCurveTo(0.23, -0.4, 0.21, -0.25);
    ctx.lineTo(-0.21, -0.25);
    ctx.quadraticCurveTo(-0.23, -0.4, -0.17, -0.6);
    ctx.closePath();
  };
  lit(ctx, path, C(pal.tunic), C(pal.tunicShade), 0.05);
  // belt
  ctx.fillStyle = C(pal.boots);
  ctx.fillRect(-0.2, -0.33, 0.4, 0.05);
  if (front) { ctx.fillStyle = C('#ffcf3f'); ctx.fillRect(-0.03, -0.335, 0.06, 0.06); }
}
function arm(ctx, x, y, angle, sleeve, hand) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  rr(ctx, -0.055, -0.02, 0.11, 0.24, 0.05);
  fs(ctx, C(sleeve));
  ell(ctx, 0, 0.24, 0.06, 0.06);
  fs(ctx, C(hand));
  ctx.restore();
}
function armFront(ctx, side, angle, pal, back) {
  ctx.save();
  ctx.translate(side * 0.2, -0.54);
  ctx.rotate(-side * 0.15 + (side < 0 ? -angle : angle) * 0.4 + (angle < -2 ? side * (angle + Math.PI) * -1 : 0));
  if (angle < -2) ctx.rotate(side * 2.6);
  rr(ctx, -0.05, -0.02, 0.1, 0.22, 0.05);
  fs(ctx, C(back ? pal.tunicShade : pal.tunic));
  ell(ctx, 0, 0.22, 0.055, 0.055);
  fs(ctx, C(pal.skin));
  ctx.restore();
}
function head(ctx, pose, pal, at, anim, hat) {
  const hy = -0.82;
  // face
  const path = () => { ell(ctx, 0, hy, 0.27, 0.25); };
  lit(ctx, path, C(pal.skin), C(pal.skinShade), 0.04);
  const blink = anim === 'hurt' ? 0.9 : (at % 3.1 > 2.95 ? 1 : 0);
  if (pose === 'side') {
    // hair: back and top
    ctx.beginPath();
    ctx.moveTo(-0.27, hy + 0.04);
    ctx.bezierCurveTo(-0.3, hy - 0.3, 0.12, hy - 0.36, 0.25, hy - 0.1);
    ctx.quadraticCurveTo(0.12, hy - 0.16, 0.05, hy - 0.08);
    ctx.quadraticCurveTo(-0.02, hy - 0.15, -0.08, hy - 0.05);
    ctx.quadraticCurveTo(-0.14, hy + 0.02, -0.2, hy + 0.14);
    ctx.closePath();
    fs(ctx, C(pal.hair));
    // tuft
    ctx.beginPath(); ctx.moveTo(-0.02, hy - 0.26); ctx.quadraticCurveTo(0.02, hy - 0.4, 0.12, hy - 0.36); ctx.quadraticCurveTo(0.06, hy - 0.3, 0.06, hy - 0.24); ctx.closePath(); fs(ctx, C(pal.hair));
    if (anim !== 'hurt') eyes(ctx, [[0.13, hy + 0.02]], 0.055, blink);
    else xEye(ctx, 0.13, hy + 0.02, 0.05);
    ctx.fillStyle = C(pal.cheek); ctx.globalAlpha = 0.55; ell(ctx, 0.15, hy + 0.1, 0.05, 0.03); ctx.fill(); ctx.globalAlpha = 1;
  } else if (pose === 'front') {
    ctx.beginPath();
    ctx.moveTo(-0.28, hy + 0.06);
    ctx.bezierCurveTo(-0.32, hy - 0.34, 0.32, hy - 0.34, 0.28, hy + 0.06);
    ctx.quadraticCurveTo(0.2, hy - 0.08, 0.1, hy - 0.1);
    ctx.quadraticCurveTo(0.02, hy - 0.02, -0.04, hy - 0.12);
    ctx.quadraticCurveTo(-0.14, hy - 0.06, -0.28, hy + 0.06);
    ctx.closePath();
    fs(ctx, C(pal.hair));
    if (anim === 'hurt') { xEye(ctx, -0.09, hy + 0.03, 0.045); xEye(ctx, 0.09, hy + 0.03, 0.045); }
    else eyes(ctx, [[-0.09, hy + 0.03], [0.09, hy + 0.03]], 0.05, blink);
    ctx.fillStyle = C(pal.cheek); ctx.globalAlpha = 0.55;
    ell(ctx, -0.16, hy + 0.1, 0.045, 0.028); ctx.fill(); ell(ctx, 0.16, hy + 0.1, 0.045, 0.028); ctx.fill();
    ctx.globalAlpha = 1;
    if (anim === 'win') { ctx.beginPath(); ctx.arc(0, hy + 0.1, 0.05, 0, Math.PI); ctx.fillStyle = INK; ctx.fill(); }
  } else {
    ell(ctx, 0, hy - 0.02, 0.28, 0.26);
    fs(ctx, C(pal.hair));
    ctx.beginPath(); ctx.moveTo(-0.1, hy - 0.2); ctx.quadraticCurveTo(0, hy - 0.05, 0.1, hy - 0.2); ctx.strokeStyle = C(pal.hairLight); ctx.stroke(); ctx.strokeStyle = INK;
  }
  if (hat) strawHat(ctx, hy, pose);
}
function strawHat(ctx, hy, pose) {
  ell(ctx, 0, hy - 0.17, 0.4, 0.1);
  fs(ctx, C('#e8c46a'));
  ctx.beginPath();
  ctx.moveTo(-0.2, hy - 0.18);
  ctx.bezierCurveTo(-0.2, hy - 0.46, 0.2, hy - 0.46, 0.2, hy - 0.18);
  ctx.closePath();
  fs(ctx, C('#f2d58a'));
  ctx.fillStyle = C('#c8573f');
  ctx.fillRect(-0.2, hy - 0.26, 0.4, 0.06);
  if (pose !== 'back') { ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(-0.3, hy - 0.2, 0.18, 0.02); }
}
function xEye(ctx, x, y, r) {
  ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke();
}
function deadHero(ctx, pal, at, hat) {
  const k = clamp01(at * 3);
  ctx.save();
  ctx.translate(0, -0.2 * (1 - k) - Math.sin(Math.min(1, at * 2) * Math.PI) * 0.5);
  ctx.rotate(-k * 1.4);
  leg(ctx, -0.07, 0, pal); leg(ctx, 0.07, 0, pal);
  body(ctx, pal, true);
  ell(ctx, 0, -0.82, 0.27, 0.25); fs(ctx, C(pal.skin));
  ctx.beginPath(); ctx.moveTo(-0.28, -0.76); ctx.bezierCurveTo(-0.32, -1.16, 0.32, -1.16, 0.28, -0.76); ctx.closePath(); fs(ctx, C(pal.hair));
  xEye(ctx, -0.09, -0.8, 0.045); xEye(ctx, 0.09, -0.8, 0.045);
  if (hat) strawHat(ctx, -0.82, 'front');
  ctx.restore();
}

const VILLAGER = { ...SPRITE.hero, tunic: '#6fae4a', tunicShade: '#4f8a34', scarf: '#f4e3c0', scarfShade: '#d9c49a', pants: '#5b4a3a', hair: '#8e8e8e', hairLight: '#b5b5b5' };

// ---------------------------------------------------------------------------------------------
// Critters

function slimeShape(ctx, w, h) {
  ctx.beginPath();
  ctx.moveTo(-w * 0.5, 0);
  ctx.bezierCurveTo(-w * 0.56, -h * 0.58, -w * 0.3, -h, 0, -h);
  ctx.bezierCurveTo(w * 0.3, -h, w * 0.56, -h * 0.58, w * 0.5, 0);
  ctx.quadraticCurveTo(0, h * 0.1, -w * 0.5, 0);
  ctx.closePath();
}
function slimeBody(ctx, e, o, W = 0.8, H = 0.6, colors = null) {
  const anim = e.anim || 'idle', at = o.at;
  const hp = e.props?.hp || e.maxHp || 1;
  const col = colors || (hp >= 3 ? SPRITE.slime.blue : hp === 2 ? SPRITE.slime.pink : SPRITE.slime.green);
  let sx = 1, sy = 1, lift = 0;
  if (anim === 'walk' || anim === 'chase') {
    const c = (at * 1.8) % 1;
    lift = Math.sin(c * Math.PI) * 0.16 * (W > 1 ? 0.6 : 1);
    sy = 1 + Math.sin(c * Math.PI) * 0.12 - (c < 0.12 || c > 0.88 ? 0.12 : 0);
    sx = 2 - sy;
  } else if (anim === 'attack') {
    sy = 0.78 + Math.sin(at * 30) * 0.03; sx = 1.18;
  } else if (anim === 'dead') {
    const k = clamp01(at * 3);
    sy = 1 - k * 0.8; sx = 1 + k * 0.5;
    ctx.globalAlpha = 1 - clamp01((at - 0.25) * 3);
  } else if (anim === 'hurt') {
    sy = 0.85; sx = 1.15;
  } else {
    sy = 1 + Math.sin(at * 3.1) * 0.05; sx = 1 - Math.sin(at * 3.1) * 0.04;
  }
  const w = W * sx, h = H * sy;
  ctx.save();
  ctx.translate(0, -lift);
  const flip = (o.view === 'side' ? e.facing || -1 : e.dir === 'left' ? -1 : 1);
  lit(ctx, () => slimeShape(ctx, w, h), C(col[1]), C(col[0]), 0.06 * W);
  // gloss
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ell(ctx, -w * 0.2, -h * 0.72, w * 0.1, h * 0.08, -0.5); ctx.fill();
  ell(ctx, -w * 0.3, -h * 0.55, w * 0.035, h * 0.04); ctx.fill();
  if (anim !== 'dead') {
    const ex = flip * w * 0.08, ey = -h * 0.48;
    const r = Math.min(0.065, 0.075 * W);
    if (anim === 'hurt') { xEye(ctx, ex - w * 0.14, ey, r * 0.7); xEye(ctx, ex + w * 0.14, ey, r * 0.7); }
    else eyes(ctx, [[ex - w * 0.14, ey], [ex + w * 0.14, ey]], r, (o.t % 3.7 > 3.55 ? 1 : 0), flip * 0.5);
    if (anim === 'attack') { ctx.beginPath(); ctx.arc(ex, ey + h * 0.2, r * 0.8, 0, Math.PI); ctx.fillStyle = INK; ctx.fill(); }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function bee(ctx, e, o) {
  const anim = e.anim || 'idle', at = o.at, t = o.t;
  const facing = o.view === 'side' ? (e.facing || 1) : (e.dir === 'left' ? -1 : 1);
  const hover = Math.sin(t * 5 + (e.cell?.x || 0)) * 0.05;
  const y0 = o.view === 'side' ? -0.36 + hover : -0.55 + hover;
  if (o.view === 'top') shadow(ctx, 0, 0.02, 0.22, 0.07, 0.18);
  if (anim === 'eaten') { ctx.save(); ctx.translate(0, y0); eyes(ctx, [[-0.08, 0], [0.1, 0]], 0.07, 0, facing); ctx.restore(); return; }
  if (anim === 'dead') { ctx.globalAlpha = 1 - clamp01(at * 2.5); }
  ctx.save();
  ctx.translate(0, y0);
  ctx.scale(facing, 1);
  if (anim === 'dead') ctx.rotate(at * 6);
  const flee = anim === 'flee';
  const bodyCol = flee ? '#9fb8ff' : SPRITE.bee.body, shadeCol = flee ? '#6f86d6' : SPRITE.bee.bodyShade;
  const flash = flee && (e.data?.fleeLeft ?? 9) < 2 && Math.floor(t * 8) % 2 === 0;
  // back wing
  const flap = Math.sin(t * 60) * 0.5 + 0.5;
  ctx.save(); ctx.globalAlpha *= 0.85;
  ell(ctx, -0.06, -0.22, 0.13, 0.2 * (0.5 + flap * 0.5), -0.5); ctx.fillStyle = C(flash ? '#ffffff' : '#dff1ff'); ctx.fill(); ctx.strokeStyle = '#7fb6d8'; ctx.stroke();
  ctx.restore();
  // stinger
  ctx.beginPath(); ctx.moveTo(-0.28, 0.02); ctx.lineTo(-0.4, 0.05); ctx.lineTo(-0.27, 0.1); ctx.closePath(); fs(ctx, C(INK));
  // body
  const path = () => ell(ctx, 0, 0.04, 0.3, 0.23);
  lit(ctx, path, C(flash ? '#ffffff' : bodyCol), C(shadeCol), 0.04);
  ctx.save(); path(); ctx.clip();
  ctx.fillStyle = C(flee ? '#3a4a7a' : SPRITE.bee.stripe);
  ctx.fillRect(-0.12, -0.3, 0.075, 0.7);
  ctx.fillRect(0.02, -0.3, 0.075, 0.7);
  ctx.restore();
  path(); ctx.stroke();
  // front wing
  ctx.save(); ctx.globalAlpha *= 0.9;
  ell(ctx, 0.04, -0.24, 0.12, 0.19 * (0.4 + flap * 0.6), 0.35); ctx.fillStyle = C('#eef8ff'); ctx.fill(); ctx.strokeStyle = '#7fb6d8'; ctx.stroke();
  ctx.restore();
  // antennae
  ctx.beginPath(); ctx.moveTo(0.2, -0.14); ctx.quadraticCurveTo(0.26, -0.3, 0.34, -0.3); ctx.stroke();
  ell(ctx, 0.35, -0.3, 0.03, 0.03); ctx.fillStyle = INK; ctx.fill();
  if (flee) {
    ctx.beginPath(); ctx.moveTo(0.08, 0.12); for (let i = 0; i < 4; i++) ctx.lineTo(0.1 + i * 0.04, 0.12 + (i % 2 ? -0.02 : 0.02)); ctx.stroke();
    eyes(ctx, [[0.17, -0.02]], 0.05, 0.4);
  } else {
    eyes(ctx, [[0.17, -0.02]], 0.065, t % 2.7 > 2.6 ? 1 : 0, 0.4);
    if (anim === 'attack') { ctx.beginPath(); ctx.moveTo(0.1, -0.12); ctx.lineTo(0.24, -0.08); ctx.stroke(); }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function spiky(ctx, e, o) {
  const anim = e.anim || 'idle', at = o.at;
  const facing = o.view === 'side' ? (e.facing || -1) : (e.dir === 'left' ? -1 : 1);
  const P = SPRITE.burr;
  const step = anim === 'walk' ? Math.abs(Math.sin(at * 9)) * 0.03 : 0;
  if (anim === 'dead') { ctx.globalAlpha = 1 - clamp01((at - 0.2) * 3); }
  ctx.save();
  ctx.translate(0, -step);
  ctx.scale(facing, anim === 'dead' ? -1 : 1);
  if (anim === 'dead') ctx.translate(0, 0.5);
  // feet
  ell(ctx, -0.18, -0.03, 0.08, 0.05); fs(ctx, C(P.nose));
  ell(ctx, 0.14, -0.03, 0.08, 0.05); fs(ctx, C(P.nose));
  // spines: a ring of triangles over the back
  const n = 9;
  ctx.fillStyle = C(P.spine);
  for (let i = 0; i < n; i++) {
    const a = Math.PI + (i / (n - 1)) * Math.PI * 0.95 - 0.05;
    const rx = 0.36, ry = 0.3;
    const bx = Math.cos(a) * rx - 0.04, by = Math.sin(a) * ry - 0.18;
    const tx = Math.cos(a) * (rx + 0.16) - 0.06, ty = Math.sin(a) * (ry + 0.16) - 0.18;
    const px = -Math.sin(a) * 0.07, py = Math.cos(a) * 0.07;
    ctx.beginPath(); ctx.moveTo(bx - px, by - py); ctx.lineTo(tx, ty); ctx.lineTo(bx + px, by + py); ctx.closePath();
    ctx.fillStyle = C(i % 2 ? P.spine : P.spineLight); ctx.fill(); ctx.stroke();
  }
  // body
  const path = () => { ctx.beginPath(); ctx.ellipse(-0.04, -0.16, 0.36, 0.26, 0, Math.PI, 0); ctx.quadraticCurveTo(0.32, -0.02, -0.04, -0.02); ctx.quadraticCurveTo(-0.4, -0.02, -0.4, -0.16); ctx.closePath(); };
  lit(ctx, path, C(P.body), C(mix(P.body, INK, 0.25)), 0.05);
  // face
  ell(ctx, 0.2, -0.13, 0.14, 0.11); fs(ctx, C(P.face));
  ell(ctx, 0.34, -0.14, 0.035, 0.03); ctx.fillStyle = INK; ctx.fill();
  if (anim === 'hurt' || anim === 'dead') xEye(ctx, 0.2, -0.18, 0.035); else eyes(ctx, [[0.2, -0.18]], 0.045, o.t % 3.3 > 3.18 ? 1 : 0, 0.5);
  ctx.restore();
  ctx.globalAlpha = 1;
}

function turret(ctx, e, o) {
  const P = SPRITE.acorn;
  const dir = e.props?.dir || 'left';
  let ang = e.data?.aim;
  if (ang === undefined) ang = dir === 'left' ? Math.PI : dir === 'right' ? 0 : dir === 'up' ? -Math.PI / 2 : dir === 'down' ? Math.PI / 2 : Math.PI;
  const recoil = e.anim === 'fire' ? Math.max(0, 1 - e.animTime * 6) * 0.08 : 0;
  const windup = e.anim === 'attack' ? 0.03 * Math.sin(o.at * 40) : 0;
  if (e.anim === 'dead') { ctx.globalAlpha = 1 - clamp01((o.at - 0.2) * 3); }
  // stump base
  const path = () => { ctx.beginPath(); ctx.moveTo(-0.34, 0); ctx.lineTo(-0.3, -0.3); ctx.lineTo(0.3, -0.3); ctx.lineTo(0.34, 0); ctx.closePath(); };
  lit(ctx, path, C('#a8763f'), C('#7a5230'), 0.04);
  ell(ctx, 0, -0.3, 0.3, 0.07); fs(ctx, C('#d9a86a'));
  ctx.strokeStyle = C('#b8874f'); ell(ctx, 0, -0.3, 0.16, 0.035); ctx.stroke(); ctx.strokeStyle = INK;
  // barrel
  ctx.save();
  ctx.translate(windup, -0.5);
  ctx.rotate(ang);
  ctx.translate(-recoil, 0);
  rr(ctx, 0.05, -0.09, 0.36, 0.18, 0.06); fs(ctx, C(P.barrel));
  rr(ctx, 0.36, -0.11, 0.08, 0.22, 0.03); fs(ctx, C('#6a5a50'));
  ctx.restore();
  // acorn body
  ctx.save(); ctx.translate(windup, 0);
  const nut = () => { ctx.beginPath(); ctx.moveTo(-0.24, -0.58); ctx.bezierCurveTo(-0.26, -0.3, -0.05, -0.28, 0, -0.26); ctx.bezierCurveTo(0.05, -0.28, 0.26, -0.3, 0.24, -0.58); ctx.closePath(); };
  lit(ctx, nut, C(P.nut), C(P.nutShade), 0.04);
  const cap = () => { ctx.beginPath(); ctx.ellipse(0, -0.58, 0.28, 0.17, 0, Math.PI, 0); ctx.quadraticCurveTo(0, -0.5, -0.28, -0.58); ctx.closePath(); };
  lit(ctx, cap, C(P.capLight), C(P.cap), 0.03);
  ctx.beginPath(); ctx.moveTo(0, -0.74); ctx.lineTo(0.03, -0.82); ctx.stroke();
  const look = Math.cos(ang) >= 0 ? 1 : -1;
  if (e.anim === 'dead') { xEye(ctx, -0.07, -0.44, 0.03); xEye(ctx, 0.07, -0.44, 0.03); }
  else eyes(ctx, [[-0.07 + look * 0.03, -0.44], [0.07 + look * 0.03, -0.44]], 0.04, 0, look);
  ctx.beginPath(); ctx.moveTo(-0.12, -0.51); ctx.lineTo(-0.02, -0.49); ctx.moveTo(0.12, -0.51); ctx.lineTo(0.02, -0.49); ctx.stroke();
  ctx.restore();
  ctx.globalAlpha = 1;
}

function spirit(ctx, e, o) {
  const t = o.t, at = o.at;
  const P = SPRITE.spirit;
  const float = Math.sin(t * 2.4 + (e.cell?.x || 0)) * 0.06;
  const y0 = -0.55 + float;
  if (o.view === 'top') shadow(ctx, 0, 0.05, 0.2, 0.06, 0.12);
  const fade = e.anim === 'dead' ? 1 - clamp01(at * 2) : 1;
  ctx.save();
  ctx.globalAlpha = 0.92 * fade;
  glow(ctx, 0, y0, 0.55, P.glow, 0.7);
  ctx.translate(0, y0);
  const facing = o.view === 'side' ? (e.facing || 1) : (e.dir === 'left' ? -1 : 1);
  ctx.scale(facing, 1);
  ctx.beginPath();
  ctx.moveTo(-0.26, 0.28);
  ctx.bezierCurveTo(-0.3, -0.1, -0.24, -0.34, 0, -0.34);
  ctx.bezierCurveTo(0.24, -0.34, 0.3, -0.1, 0.26, 0.28);
  for (let i = 0; i < 4; i++) {
    const x0 = 0.26 - (i + 0.5) * 0.13, wob = Math.sin(t * 6 + i) * 0.03;
    ctx.quadraticCurveTo(x0, 0.2 + wob, x0 - 0.065, 0.3);
  }
  ctx.closePath();
  ctx.fillStyle = C('#f4f7ff'); ctx.fill();
  ctx.strokeStyle = '#8aa6d6'; ctx.stroke();
  ctx.fillStyle = 'rgba(159, 216, 255, 0.35)'; ell(ctx, 0.08, 0.05, 0.14, 0.18); ctx.fill();
  ctx.fillStyle = P.eye;
  ell(ctx, -0.02, -0.1, 0.045, 0.07); ctx.fill(); ell(ctx, 0.13, -0.1, 0.045, 0.07); ctx.fill();
  ctx.beginPath(); ctx.arc(0.06, 0.04, 0.05, 0, Math.PI); ctx.fill();
  ctx.restore();
}

function boss(ctx, e, o) {
  const at = o.at;
  let lift = 0;
  if (e.anim === 'jump' || e.anim === 'walk') lift = 0; // the sim moves the body; keep sprite grounded to the box
  slimeBody(ctx, e, { ...o, at: e.anim === 'walk' ? at * 0.6 : at }, 1.9, 1.45, SPRITE.slime.green);
  if (e.anim === 'dead') return;
  // crown
  const hop = e.anim === 'attack' ? Math.sin(at * 30) * 0.02 : 0;
  const sy = e.anim === 'attack' ? 0.8 : 1 + Math.sin(at * 3.1) * 0.05;
  ctx.save();
  ctx.translate(0, -1.45 * sy + 0.04 - lift + hop);
  const K = SPRITE.king;
  ctx.beginPath();
  ctx.moveTo(-0.34, 0);
  ctx.lineTo(-0.38, -0.34); ctx.lineTo(-0.19, -0.16); ctx.lineTo(0, -0.42); ctx.lineTo(0.19, -0.16); ctx.lineTo(0.38, -0.34); ctx.lineTo(0.34, 0);
  ctx.closePath();
  lit(ctx, () => { ctx.beginPath(); ctx.moveTo(-0.34, 0); ctx.lineTo(-0.38, -0.34); ctx.lineTo(-0.19, -0.16); ctx.lineTo(0, -0.42); ctx.lineTo(0.19, -0.16); ctx.lineTo(0.38, -0.34); ctx.lineTo(0.34, 0); ctx.closePath(); }, C(K.crown), C(K.crownShade), 0.04);
  ell(ctx, 0, -0.1, 0.06, 0.06); fs(ctx, C(K.jewel));
  ell(ctx, -0.22, -0.08, 0.04, 0.04); fs(ctx, C('#72d6ff'));
  ell(ctx, 0.22, -0.08, 0.04, 0.04); fs(ctx, C('#72d6ff'));
  sparkle(ctx, -0.05, -0.2, 0.05, '#fff8d8', 0.5 + 0.5 * Math.sin(o.t * 4));
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------
// Pickups

function bobY(o, e, amp = 0.05, speed = 2.2) { return Math.sin(o.t * speed + (e.cell?.x || 0) * 0.7 + (e.cell?.y || 0) * 0.3) * amp; }

function coin(ctx, e, o) {
  const P = SPRITE.honey;
  const y = (o.view === 'side' ? -0.36 : 0) + bobY(o, e);
  if (o.view === 'side') shadow(ctx, 0, -0.02, 0.12, 0.03, 0.12);
  const spin = Math.cos(o.t * 3 + (e.cell?.x || 0));
  ctx.save();
  ctx.translate(0, y);
  ctx.scale(0.72 + 0.28 * Math.abs(spin), 1);
  lit(ctx, () => dropPath(ctx, 0, 0.04, 0.15), C(P.base), C(P.shade), 0.03);
  ctx.fillStyle = C(P.light); ell(ctx, -0.05, 0.0, 0.035, 0.07, 0.3); ctx.fill();
  ctx.restore();
  if ((o.t * 0.7 + (e.cell?.x || 0) * 0.13) % 1 < 0.12) sparkle(ctx, 0.12, y - 0.14, 0.06, '#fffbe6');
}

function gem(ctx, e, o) {
  const P = SPRITE.jar;
  const y = (o.view === 'side' ? -0.02 : 0.28) + bobY(o, e, 0.035, 1.6) - 0.02;
  if (o.view === 'side') shadow(ctx, 0, -0.02, 0.2, 0.04, 0.15);
  ctx.save();
  ctx.translate(0, y);
  if (o.view === 'top') ctx.scale(0.85, 0.85);
  // jar glass
  const jar = () => { ctx.beginPath(); ctx.moveTo(-0.15, -0.56); ctx.quadraticCurveTo(-0.3, -0.5, -0.29, -0.28); ctx.quadraticCurveTo(-0.28, -0.02, 0, -0.02); ctx.quadraticCurveTo(0.28, -0.02, 0.29, -0.28); ctx.quadraticCurveTo(0.3, -0.5, 0.15, -0.56); ctx.closePath(); };
  jar(); ctx.fillStyle = C('#fff3d6'); ctx.fill();
  ctx.save(); jar(); ctx.clip();
  ctx.fillStyle = C(P.honeyShade); ctx.fillRect(-0.4, -0.42, 0.8, 0.5);
  ctx.fillStyle = C(P.honey); ctx.fillRect(-0.4, -0.42, 0.62, 0.36);
  ctx.beginPath(); ctx.moveTo(-0.4, -0.42); for (let i = 0; i <= 8; i++) ctx.lineTo(-0.4 + i * 0.1, -0.42 + Math.sin(o.t * 3 + i) * 0.012); ctx.lineTo(0.4, -0.46); ctx.lineTo(-0.4, -0.46); ctx.closePath(); ctx.fillStyle = C('#ffd27a'); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillRect(-0.2, -0.46, 0.05, 0.34);
  ctx.restore();
  jar(); ctx.stroke();
  // lid cloth
  ctx.beginPath(); ctx.moveTo(-0.2, -0.54); ctx.lineTo(-0.24, -0.66); ctx.quadraticCurveTo(0, -0.74, 0.24, -0.66); ctx.lineTo(0.2, -0.54); ctx.closePath(); fs(ctx, C(P.lid));
  ctx.fillStyle = C(P.lidShade); ctx.fillRect(-0.2, -0.575, 0.4, 0.035);
  ctx.strokeStyle = C(P.string); ctx.beginPath(); ctx.moveTo(-0.2, -0.56); ctx.lineTo(0.2, -0.56); ctx.stroke(); ctx.strokeStyle = INK;
  ctx.restore();
  if ((o.t * 0.5 + (e.cell?.x || 0) * 0.17) % 1 < 0.1) sparkle(ctx, 0.2, y - 0.6, 0.07, '#fffbe6');
}

function heart(ctx, e, o) {
  const P = SPRITE.heart;
  const beat = 1 + Math.max(0, Math.sin(o.t * 5)) * 0.08;
  const y = (o.view === 'side' ? -0.32 : 0) + bobY(o, e, 0.04);
  if (o.view === 'side') shadow(ctx, 0, -0.02, 0.14, 0.03, 0.12);
  ctx.save(); ctx.translate(0, y); ctx.scale(beat, beat);
  lit(ctx, () => heartPath(ctx, 0, 0, 0.2), C(P.base), C(P.shade), 0.035);
  ctx.fillStyle = C(P.light); ell(ctx, -0.09, -0.08, 0.05, 0.035, -0.6); ctx.fill();
  ctx.restore();
}

function key(ctx, e, o) {
  const col = SPRITE.keys[e.props?.color] || SPRITE.keys.amber;
  const y = (o.view === 'side' ? -0.3 : 0) + bobY(o, e, 0.05, 1.8);
  if (o.view === 'side') shadow(ctx, 0, -0.02, 0.16, 0.03, 0.12);
  ctx.save(); ctx.translate(0, y); ctx.rotate(-0.35 + Math.sin(o.t * 1.8) * 0.08);
  // teeth + shaft
  rr(ctx, -0.04, -0.035, 0.36, 0.07, 0.03); fs(ctx, C(col[1]));
  rr(ctx, 0.2, 0.0, 0.06, 0.1, 0.02); fs(ctx, C(col[1]));
  rr(ctx, 0.28, 0.0, 0.05, 0.08, 0.02); fs(ctx, C(col[1]));
  // bow
  ctx.beginPath(); ctx.arc(-0.14, 0, 0.13, 0, TAU); ctx.fillStyle = C(col[1]); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(-0.14, 0, 0.05, 0, TAU); ctx.fillStyle = C(col[0]); ctx.fill(); ctx.stroke();
  ctx.fillStyle = C(col[2]); ell(ctx, -0.19, -0.06, 0.035, 0.02, -0.6); ctx.fill();
  ctx.restore();
}

function powerup(ctx, e, o) {
  const kind = e.props?.kind || e.data?.kind || 'shield';
  const liquid = SPRITE.fizz[kind] || SPRITE.fizz.shield;
  const y = (o.view === 'side' ? -0.04 : 0.26) + bobY(o, e, 0.04, 2);
  if (o.view === 'side') shadow(ctx, 0, -0.02, 0.16, 0.035, 0.14);
  ctx.save(); ctx.translate(0, y);
  if (o.view === 'top') ctx.scale(0.85, 0.85);
  glow(ctx, 0, -0.28, 0.42, liquid, 0.25 + 0.1 * Math.sin(o.t * 4));
  const flask = () => { ctx.beginPath(); ctx.moveTo(-0.06, -0.56); ctx.lineTo(-0.06, -0.42); ctx.bezierCurveTo(-0.28, -0.38, -0.28, -0.02, 0, -0.02); ctx.bezierCurveTo(0.28, -0.02, 0.28, -0.38, 0.06, -0.42); ctx.lineTo(0.06, -0.56); ctx.closePath(); };
  flask(); ctx.fillStyle = C('#f2fbff'); ctx.fill();
  ctx.save(); flask(); ctx.clip();
  ctx.fillStyle = C(liquid); ctx.fillRect(-0.3, -0.3, 0.6, 0.3);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  for (let i = 0; i < 3; i++) { const by = -0.08 - ((o.t * 0.5 + i * 0.33) % 1) * 0.3; ell(ctx, -0.08 + i * 0.07, by, 0.025, 0.025); ctx.fill(); }
  ctx.fillRect(-0.14, -0.34, 0.04, 0.22);
  ctx.restore();
  flask(); ctx.stroke();
  rr(ctx, -0.08, -0.66, 0.16, 0.12, 0.03); fs(ctx, C('#b8874f'));
  ctx.restore();
}

function power(ctx, e, o) {
  const pulse = 0.5 + 0.5 * Math.sin(o.t * 5);
  const y = o.view === 'side' ? -0.35 : 0;
  glow(ctx, 0, y, 0.45 + pulse * 0.08, 'rgba(255, 170, 230, 0.8)', 0.6);
  ell(ctx, 0, y, 0.17 + pulse * 0.02, 0.17 + pulse * 0.02); fs(ctx, C('#ffe6f6'));
  ctx.fillStyle = C('#ffb3e2'); ell(ctx, 0.04, y + 0.04, 0.09, 0.09); ctx.fill();
  ctx.fillStyle = '#ffffff'; ell(ctx, -0.06, y - 0.06, 0.05, 0.04); ctx.fill();
}

// ---------------------------------------------------------------------------------------------
// Mechanisms and props

function door(ctx, e, o) {
  // origin: the box's top-left; the box is one cell
  const W = o.w, H = o.h;
  const lock = e.props?.lock || 'none';
  const lockCol = SPRITE.keys[lock] || SPRITE.keys.none;
  const openK = e.open ? clamp01((e.animTime || 1) * 4) : 0;
  const top = o.view === 'top';
  // posts
  rr(ctx, 0.02, 0.02, 0.16, H - 0.04, 0.04); fs(ctx, C('#8e8e96'));
  rr(ctx, W - 0.18, 0.02, 0.16, H - 0.04, 0.04); fs(ctx, C('#8e8e96'));
  ctx.fillStyle = C('#b5b5bd'); ctx.fillRect(0.05, 0.05, 0.04, H - 0.1); ctx.fillRect(W - 0.15, 0.05, 0.04, H - 0.1);
  // the gate itself lifts up as it opens
  const gh = (H - 0.12) * (1 - openK * 0.82);
  if (gh > 0.02) {
    const gy = 0.06;
    ctx.save();
    ctx.beginPath(); ctx.rect(0.14, gy, W - 0.28, gh); ctx.clip();
    const planks = 3;
    for (let i = 0; i < planks; i++) {
      const pw = (W - 0.28) / planks;
      rr(ctx, 0.14 + i * pw, gy - (H - gh), pw, H - 0.12, 0.03);
      fs(ctx, C(i % 2 ? '#c7843f' : '#d18f4b'));
    }
    // iron bands
    ctx.fillStyle = C('#5b5560');
    ctx.fillRect(0.14, gy + gh - 0.2, W - 0.28, 0.07);
    ctx.fillRect(0.14, gy + gh * 0.35 - 0.04, W - 0.28, 0.07);
    ctx.restore();
    ctx.beginPath(); ctx.rect(0.14, gy, W - 0.28, gh); ctx.stroke();
    if (openK < 0.5) {
      // lock plate (or a wire socket for 'none')
      const ly = gy + gh * 0.55;
      if (lock === 'none') {
        ell(ctx, W / 2, ly, 0.1, 0.1); fs(ctx, C('#3a3f5c'));
        ell(ctx, W / 2, ly, 0.045, 0.045); ctx.fillStyle = C(e.powered > 0 ? '#72d6ff' : '#6d7178'); ctx.fill();
      } else {
        rr(ctx, W / 2 - 0.13, ly - 0.14, 0.26, 0.28, 0.05); fs(ctx, C(lockCol[1]));
        ctx.fillStyle = C(lockCol[2]); ctx.fillRect(W / 2 - 0.1, ly - 0.11, 0.05, 0.2);
        ctx.fillStyle = INK; ell(ctx, W / 2, ly - 0.03, 0.035, 0.035); ctx.fill(); ctx.fillRect(W / 2 - 0.015, ly - 0.03, 0.03, 0.08);
      }
    }
  }
  if (top && !e.open) { ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(0.14, H - 0.12, W - 0.28, 0.06); }
}

function lever(ctx, e, o) {
  const on = !!e.active;
  const at = o.at;
  const swing = e.data?.swing ?? (on ? 1 : 0);
  const k = e.anim === 'toggle' ? clamp01(at * 8) : 1;
  const ang = (on ? 0.6 : -0.6) * (e.anim === 'toggle' ? (k * 2 - 1) * (on ? 1 : -1) * (on ? 1 : -1) : 1) * (swing >= 0 ? 1 : 1);
  // stick
  ctx.save(); ctx.translate(0, -0.14); ctx.rotate(ang);
  rr(ctx, -0.035, -0.46, 0.07, 0.46, 0.03); fs(ctx, C('#8e5c34'));
  ell(ctx, 0, -0.48, 0.09, 0.09); fs(ctx, C(on ? '#5ad8c4' : '#ff9f45'));
  ctx.fillStyle = 'rgba(255,255,255,0.7)'; ell(ctx, -0.03, -0.51, 0.03, 0.025); ctx.fill();
  ctx.restore();
  // base
  ctx.beginPath(); ctx.moveTo(-0.26, 0); ctx.lineTo(-0.2, -0.18); ctx.lineTo(0.2, -0.18); ctx.lineTo(0.26, 0); ctx.closePath();
  lit(ctx, () => { ctx.beginPath(); ctx.moveTo(-0.26, 0); ctx.lineTo(-0.2, -0.18); ctx.lineTo(0.2, -0.18); ctx.lineTo(0.26, 0); ctx.closePath(); }, C('#aeb6be'), C('#7f8993'), 0.03);
  ell(ctx, -0.12, -0.09, 0.025, 0.025); ctx.fillStyle = C(on ? '#5ad8c4' : '#6d7178'); ctx.fill();
}

function plate(ctx, e, o) {
  const W = o.w, H = o.h, on = !!e.active;
  const inset = on ? 0.16 : 0.12;
  rr(ctx, 0.08, 0.08, W - 0.16, H - 0.16, 0.08); fs(ctx, C('#8a939c'));
  rr(ctx, inset, inset, W - inset * 2, H - inset * 2, 0.06);
  fs(ctx, C(on ? '#5ad8c4' : '#c9d0d6'));
  if (!on) { ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(inset + 0.04, inset + 0.04, W - inset * 2 - 0.08, 0.04); }
  else glow(ctx, W / 2, H / 2, 0.5, 'rgba(90,216,196,0.5)', 0.5);
}

function bswitch(ctx, e, o) {
  const tog = !!o.toggle;
  const squash = e.anim === 'hit' ? Math.max(0, 1 - e.animTime * 6) * 0.08 : 0;
  ctx.save(); ctx.translate(0, squash);
  const w = 0.86, h = 0.5 - squash;
  rr(ctx, -w / 2, -h, w, h, 0.08);
  ctx.save(); ctx.clip();
  ctx.fillStyle = C(tog ? '#7a5a36' : '#ffb23f'); ctx.fillRect(-w / 2, -h, w / 2, h);
  ctx.fillStyle = C(tog ? '#7fd6ff' : '#3f5f7a'); ctx.fillRect(0, -h, w / 2, h);
  ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(-w / 2, -h, w, 0.07);
  ctx.restore();
  rr(ctx, -w / 2, -h, w, h, 0.08); ctx.stroke();
  // swap arrows
  ctx.strokeStyle = C('#fff8ec'); ctx.lineWidth *= 1.2;
  ctx.beginPath(); ctx.moveTo(-0.2, -h * 0.65); ctx.lineTo(0.16, -h * 0.65); ctx.lineTo(0.08, -h * 0.8); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0.2, -h * 0.35); ctx.lineTo(-0.16, -h * 0.35); ctx.lineTo(-0.08, -h * 0.2); ctx.stroke();
  ctx.restore();
}

function spring(ctx, e, o) {
  const P = SPRITE.mushroom;
  const k = e.anim === 'bounce' ? Math.sin(clamp01(e.animTime * 4) * Math.PI) : 0;
  const squash = e.anim === 'bounce' && e.animTime < 0.08 ? 0.3 : -k * 0.15;
  const stemH = 0.22 * (1 - squash);
  rr(ctx, -0.1, -stemH, 0.2, stemH, 0.05); fs(ctx, C(P.stem));
  ctx.save(); ctx.translate(0, -stemH);
  ctx.scale(1 + squash * 0.4, 1 - squash * 0.3);
  const cap = () => { ctx.beginPath(); ctx.moveTo(-0.44, 0.02); ctx.bezierCurveTo(-0.44, -0.36, 0.44, -0.36, 0.44, 0.02); ctx.quadraticCurveTo(0, 0.08, -0.44, 0.02); ctx.closePath(); };
  lit(ctx, cap, C(P.cap), C(P.capShade), 0.04);
  ctx.fillStyle = C(P.dot);
  ell(ctx, -0.2, -0.12, 0.07, 0.05); ctx.fill(); ell(ctx, 0.12, -0.18, 0.08, 0.055); ctx.fill(); ell(ctx, 0.3, -0.05, 0.05, 0.04); ctx.fill();
  ctx.restore();
}

function platform(ctx, e, o) {
  const W = o.w;
  const th = Math.min(0.45, o.h);
  // plank raft: logs with rope
  rr(ctx, 0.02, 0.02, W - 0.04, th, 0.12);
  ctx.save(); ctx.clip();
  const n = Math.max(1, Math.round(W / 0.5));
  for (let i = 0; i < n; i++) { ctx.fillStyle = C(i % 2 ? '#c7843f' : '#d69650'); ctx.fillRect(0.02 + i * (W - 0.04) / n, 0, (W - 0.04) / n, th + 0.1); }
  ctx.fillStyle = C('#eeb16e'); ctx.fillRect(0, 0.02, W, 0.07);
  ctx.fillStyle = C('#9a5f2b'); ctx.fillRect(0, th - 0.06, W, 0.08);
  ctx.restore();
  rr(ctx, 0.02, 0.02, W - 0.04, th, 0.12); ctx.stroke();
  ctx.strokeStyle = C('#f4e3c0');
  for (let i = 1; i < n; i++) { const x = 0.02 + i * (W - 0.04) / n; ctx.beginPath(); ctx.moveTo(x, 0.06); ctx.lineTo(x, th - 0.02); ctx.stroke(); }
  ctx.strokeStyle = INK;
  // bolts at the ends
  ctx.fillStyle = C('#5b5560'); ell(ctx, 0.18, th / 2 + 0.02, 0.035, 0.035); ctx.fill(); ell(ctx, W - 0.18, th / 2 + 0.02, 0.035, 0.035); ctx.fill();
  if (e.inputs > 0) { ell(ctx, W / 2, th / 2 + 0.02, 0.05, 0.05); ctx.fillStyle = C(e.powered > 0 ? '#72d6ff' : '#6d7178'); ctx.fill(); ctx.stroke(); }
}

function crate(ctx, e, o) {
  const W = o.w, H = o.h, P = SPRITE.crate;
  const top = o.view === 'top';
  const x0 = 0.06, y0 = top ? 0.02 : 0.06, w = W - 0.12, h = H - (top ? 0.1 : 0.08);
  if (e.anim === 'dead') { ctx.globalAlpha = 1 - clamp01(o.at * 4); }
  if (top) { ctx.fillStyle = 'rgba(0,0,0,0.2)'; rr(ctx, x0 + 0.03, y0 + 0.1, w, h, 0.06); ctx.fill(); }
  rr(ctx, x0, y0, w, h, 0.06); fs(ctx, C(P.base));
  ctx.save(); rr(ctx, x0, y0, w, h, 0.06); ctx.clip();
  ctx.fillStyle = C(P.shade); ctx.fillRect(x0, y0 + h - 0.12, w, 0.12);
  ctx.fillStyle = C(P.light); ctx.fillRect(x0, y0, w, 0.07);
  ctx.restore();
  // frame and braces
  ctx.strokeStyle = C(P.band);
  ctx.lineWidth *= 1.6;
  rr(ctx, x0 + 0.1, y0 + 0.1, w - 0.2, h - 0.2, 0.03); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x0 + 0.14, y0 + 0.14); ctx.lineTo(x0 + w - 0.14, y0 + h - 0.14); ctx.moveTo(x0 + w - 0.14, y0 + 0.14); ctx.lineTo(x0 + 0.14, y0 + h - 0.14); ctx.stroke();
  ctx.lineWidth /= 1.6; ctx.strokeStyle = INK;
  rr(ctx, x0, y0, w, h, 0.06); ctx.stroke();
  if (e.active) {
    // resting on a pad: a teal rim and a tick
    ctx.save(); ctx.strokeStyle = '#5ad8c4'; ctx.lineWidth *= 2.2; rr(ctx, x0 + 0.03, y0 + 0.03, w - 0.06, h - 0.06, 0.05); ctx.stroke(); ctx.restore();
    ctx.save(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth *= 2; ctx.beginPath(); ctx.moveTo(W / 2 - 0.12, y0 + h / 2); ctx.lineTo(W / 2 - 0.03, y0 + h / 2 + 0.09); ctx.lineTo(W / 2 + 0.14, y0 + h / 2 - 0.1); ctx.stroke(); ctx.restore();
  }
  if (e.hp < e.maxHp && e.hp > 0) { ctx.beginPath(); ctx.moveTo(x0 + w * 0.6, y0); ctx.lineTo(x0 + w * 0.5, y0 + h * 0.35); ctx.lineTo(x0 + w * 0.66, y0 + h * 0.5); ctx.stroke(); }
  ctx.globalAlpha = 1;
}

function chest(ctx, e, o) {
  const P = SPRITE.chest;
  const open = !!e.open;
  const k = open ? clamp01((e.animTime || 1) * 5) : 0;
  const w = 0.78, h = 0.44;
  // body
  rr(ctx, -w / 2, -h, w, h, 0.06); fs(ctx, C(P.base));
  ctx.fillStyle = C(P.shade); ctx.fillRect(-w / 2 + 0.03, -0.12, w - 0.06, 0.09);
  ctx.fillStyle = C(P.band); ctx.fillRect(-w / 2 + 0.1, -h, 0.08, h); ctx.fillRect(w / 2 - 0.18, -h, 0.08, h);
  rr(ctx, -w / 2, -h, w, h, 0.06); ctx.stroke();
  if (open) {
    glow(ctx, 0, -h - 0.05, 0.5, 'rgba(255, 220, 120, 0.8)', 0.6 * (1 - clamp01((e.animTime || 0) - 1.5)));
    ctx.fillStyle = C('#3a2414'); ctx.fillRect(-w / 2 + 0.04, -h - 0.02, w - 0.08, 0.06);
    // lid swung back
    ctx.save(); ctx.translate(0, -h); ctx.scale(1, -0.6 * k + (1 - k));
    lid(ctx, w, P);
    ctx.restore();
    sparkle(ctx, 0.1, -h - 0.25 - k * 0.1, 0.07, '#fff6c9', 0.8);
  } else {
    ctx.save(); ctx.translate(0, -h); lid(ctx, w, P); ctx.restore();
    rr(ctx, -0.07, -h - 0.06, 0.14, 0.16, 0.03); fs(ctx, C(P.band));
    ctx.fillStyle = INK; ell(ctx, 0, -h + 0.01, 0.025, 0.025); ctx.fill();
  }
}
function lid(ctx, w, P) {
  ctx.beginPath(); ctx.moveTo(-w / 2, 0); ctx.lineTo(-w / 2, -0.12); ctx.quadraticCurveTo(0, -0.28, w / 2, -0.12); ctx.lineTo(w / 2, 0); ctx.closePath();
  fs(ctx, C(P.base));
  ctx.fillStyle = C(P.band); ctx.fillRect(-w / 2 + 0.1, -0.2, 0.08, 0.2); ctx.fillRect(w / 2 - 0.18, -0.2, 0.08, 0.2);
  ctx.beginPath(); ctx.moveTo(-w / 2, 0); ctx.lineTo(-w / 2, -0.12); ctx.quadraticCurveTo(0, -0.28, w / 2, -0.12); ctx.lineTo(w / 2, 0); ctx.closePath(); ctx.stroke();
}

function teleporter(ctx, e, o) {
  const ch = Math.max(1, Math.min(4, e.props?.channel || 1)) - 1;
  const [dark, light] = CHANNEL[ch];
  const y = o.view === 'side' ? -0.34 : 0;
  const spin = o.t * 0.6;
  if (o.view === 'side') { rr(ctx, -0.03, y, 0.06, -y, 0.02); fs(ctx, C('#4f9e3b')); }
  glow(ctx, 0, y, 0.5, light, 0.25 + 0.1 * Math.sin(o.t * 3));
  const petals = 5;
  for (let i = 0; i < petals; i++) {
    const a = spin + (i / petals) * TAU;
    ctx.save(); ctx.translate(0, y); ctx.rotate(a);
    ell(ctx, 0.2, 0, 0.16, 0.09); lit(ctx, () => ell(ctx, 0.2, 0, 0.16, 0.09), C(light), C(dark), 0.02);
    ctx.restore();
  }
  ell(ctx, 0, y, 0.12, 0.12); fs(ctx, C('#ffe98a'));
  ctx.strokeStyle = C(dark);
  ctx.beginPath(); for (let i = 0; i < 20; i++) { const a = -spin * 3 + i * 0.5, r = 0.01 + i * 0.0045; const px = Math.cos(a) * r, py = y + Math.sin(a) * r; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); } ctx.stroke();
  ctx.strokeStyle = INK;
  // channel pips
  ctx.fillStyle = INK;
  for (let i = 0; i <= ch; i++) { ell(ctx, (i - ch / 2) * 0.07, y + 0.3, 0.02, 0.02); ctx.fill(); }
}

function sign(ctx, e, o) {
  rr(ctx, -0.04, -0.46, 0.08, 0.46, 0.02); fs(ctx, C('#8e5c34'));
  const w = 0.7, h = 0.4, y = -0.78;
  rr(ctx, -w / 2, y, w, h, 0.05); fs(ctx, C('#d9a168'));
  ctx.fillStyle = C('#b8874f'); ctx.fillRect(-w / 2 + 0.03, y + h - 0.08, w - 0.06, 0.05);
  ctx.strokeStyle = C('#7a5230');
  for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(-0.24, y + 0.1 + i * 0.09); ctx.lineTo(0.24 - (i === 2 ? 0.14 : 0), y + 0.1 + i * 0.09); ctx.stroke(); }
  ctx.strokeStyle = INK;
  if (e.active) sparkle(ctx, 0.3, y - 0.05, 0.06, '#fff6c9');
}

function goal(ctx, e, o) {
  const P = SPRITE.shrine;
  const t = o.t;
  const reached = e.active;
  // plinth
  ctx.beginPath(); ctx.moveTo(-0.44, 0); ctx.lineTo(-0.36, -0.18); ctx.lineTo(0.36, -0.18); ctx.lineTo(0.44, 0); ctx.closePath();
  lit(ctx, () => { ctx.beginPath(); ctx.moveTo(-0.44, 0); ctx.lineTo(-0.36, -0.18); ctx.lineTo(0.36, -0.18); ctx.lineTo(0.44, 0); ctx.closePath(); }, C(P.stone), C(P.stoneShade), 0.03);
  rr(ctx, -0.26, -0.34, 0.52, 0.17, 0.04); fs(ctx, C('#c7ced4'));
  ctx.fillStyle = C('#72d6ff'); ctx.fillRect(-0.18, -0.28, 0.36, 0.04);
  // floating crystal
  const fy = -0.78 + Math.sin(t * 2) * 0.05;
  glow(ctx, 0, fy, 0.75, 'rgba(143, 240, 255, 0.9)', reached ? 0.9 : 0.45 + 0.1 * Math.sin(t * 3));
  ctx.save(); ctx.translate(0, fy); ctx.rotate(Math.sin(t * 1.3) * 0.08);
  const cr = () => { ctx.beginPath(); ctx.moveTo(0, -0.34); ctx.lineTo(0.16, -0.06); ctx.lineTo(0.1, 0.24); ctx.lineTo(-0.1, 0.24); ctx.lineTo(-0.16, -0.06); ctx.closePath(); };
  lit(ctx, cr, C(P.crystal), C(P.crystalShade), 0.05);
  ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.beginPath(); ctx.moveTo(-0.02, -0.28); ctx.lineTo(-0.1, -0.05); ctx.lineTo(-0.04, 0.12); ctx.closePath(); ctx.fill();
  ctx.restore();
  for (let i = 0; i < 3; i++) {
    const a = t * 1.6 + i * TAU / 3;
    sparkle(ctx, Math.cos(a) * 0.36, fy + Math.sin(a) * 0.12, 0.05, '#e9fdff', 0.6 + 0.4 * Math.sin(a));
  }
}

function checkpoint(ctx, e, o) {
  const P = SPRITE.lantern, on = !!e.active;
  rr(ctx, -0.04, -0.72, 0.08, 0.72, 0.02); fs(ctx, C('#6b4325'));
  ctx.beginPath(); ctx.moveTo(0, -0.72); ctx.lineTo(0.22, -0.72); ctx.stroke();
  const sway = Math.sin(o.t * 2) * 0.05;
  ctx.save(); ctx.translate(0.22, -0.72); ctx.rotate(sway);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 0.08); ctx.stroke();
  if (on) glow(ctx, 0, 0.26, 0.7, 'rgba(255, 196, 92, 0.9)', 0.55 + 0.1 * Math.sin(o.t * 7));
  rr(ctx, -0.13, 0.08, 0.26, 0.32, 0.05); fs(ctx, C(P.frame));
  rr(ctx, -0.09, 0.12, 0.18, 0.24, 0.03); fs(ctx, C(on ? P.glassOn : P.glassOff));
  if (on) { ctx.fillStyle = '#fff4c2'; ell(ctx, 0, 0.26, 0.04, 0.07); ctx.fill(); }
  rr(ctx, -0.15, 0.06, 0.3, 0.05, 0.02); fs(ctx, C('#4a3b33'));
  ctx.restore();
}

function spawner(ctx, e, o) {
  const W = o.w, H = o.h, P = SPRITE.burrow;
  const cx = W / 2, by = H - 0.1;
  ctx.beginPath(); ctx.moveTo(0.04, by); ctx.bezierCurveTo(0.1, H * 0.2, W - 0.1, H * 0.2, W - 0.04, by); ctx.closePath();
  lit(ctx, () => { ctx.beginPath(); ctx.moveTo(0.04, by); ctx.bezierCurveTo(0.1, H * 0.2, W - 0.1, H * 0.2, W - 0.04, by); ctx.closePath(); }, C(P.moundLight), C(P.mound), 0.05);
  ell(ctx, cx, by - 0.14, 0.24, 0.13); fs(ctx, C(P.hole));
  ctx.fillStyle = C('#e8c9a0'); for (let i = 0; i < 3; i++) { ell(ctx, 0.25 + i * 0.22, by - 0.36 - (i % 2) * 0.06, 0.035, 0.025); ctx.fill(); }
  if (e.active || e.anim === 'spawn') {
    for (let i = 0; i < 3; i++) {
      const k = ((o.t * 0.8 + i / 3) % 1);
      ctx.save(); ctx.globalAlpha = 0.5 * (1 - k); ctx.fillStyle = '#e8d2b0';
      ell(ctx, cx + (i - 1) * 0.2, by - 0.2 - k * 0.4, 0.08 + k * 0.08, 0.06 + k * 0.05); ctx.fill(); ctx.restore();
    }
  }
  if (e.data?.exhausted) { ctx.fillStyle = 'rgba(90, 216, 196, 0.9)'; ell(ctx, cx, by - 0.14, 0.07, 0.07); ctx.fill(); }
}

function npc(ctx, e, o) {
  hero(ctx, { ...e, anim: e.anim === 'talk' ? 'idle' : e.anim, dir: e.dir || 'down' }, o, VILLAGER, true);
  if (e.anim === 'talk' || e.active) {
    ctx.save(); ctx.translate(0.34, -1.2);
    rr(ctx, -0.14, -0.12, 0.28, 0.2, 0.06); fs(ctx, C('#ffffff'));
    ctx.fillStyle = INK; for (let i = 0; i < 3; i++) { ell(ctx, -0.07 + i * 0.07, -0.02, 0.018, 0.018); ctx.fill(); }
    ctx.restore();
  }
}

const DRAW = {
  player: (ctx, e, o) => hero(ctx, e, o),
  npc,
  slime: (ctx, e, o) => slimeBody(ctx, e, o),
  bee, spiky, turret, spirit, boss,
  coin, gem, heart, key, powerup, power,
  door, switch: lever, plate, bswitch, spring, platform, crate, chest, teleporter, sign, goal, checkpoint, spawner,
};

// ---------------------------------------------------------------------------------------------
// Projectiles

export function drawProjectile(ctx, p, cx, cy, size, info = {}) {
  unit(ctx, cx, cy, size);
  const kind = p.kind || (p.owner === 'enemy' ? 'acorn' : 'pebble');
  if (kind === 'ring') {
    const r = p.r || 0.5;
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life ?? 1));
    ctx.lineWidth *= 3;
    ctx.strokeStyle = '#fff4d8';
    ell(ctx, 0, 0, r, info.view === 'side' ? r * 0.25 : r); ctx.stroke();
    ctx.lineWidth /= 3;
    ctx.strokeStyle = '#ffb23f';
    ell(ctx, 0, 0, r, info.view === 'side' ? r * 0.25 : r); ctx.stroke();
  } else if (kind === 'acorn') {
    const a = Math.atan2(p.vy || 0, p.vx || 1);
    ctx.rotate(a);
    ell(ctx, 0.02, 0, 0.13, 0.1); fs(ctx, '#c98b4a');
    ctx.beginPath(); ctx.ellipse(-0.06, 0, 0.1, 0.12, 0, Math.PI / 2, Math.PI * 1.5); ctx.closePath(); fs(ctx, '#7d5128');
  } else if (kind === 'spark') {
    sparkle(ctx, 0, 0, 0.15, '#fff6c9');
  } else {
    // player pebble with a warm trail
    const sp = Math.hypot(p.vx || 0, p.vy || 0) || 1;
    const tx = -(p.vx || 0) / sp, ty = -(p.vy || 0) / sp;
    ctx.save();
    const g = ctx.createLinearGradient(0, 0, tx * 0.5, ty * 0.5);
    g.addColorStop(0, 'rgba(255, 207, 107, 0.8)'); g.addColorStop(1, 'rgba(255, 207, 107, 0)');
    ctx.strokeStyle = g; ctx.lineWidth = 0.14;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(tx * 0.5, ty * 0.5); ctx.stroke();
    ctx.restore();
    ell(ctx, 0, 0, 0.1, 0.09); fs(ctx, p.power ? '#ffcf6b' : '#d6dbe0');
    ctx.fillStyle = '#ffffff'; ell(ctx, -0.03, -0.03, 0.03, 0.025); ctx.fill();
  }
  ctx.restore();
}

/** Every entity type this module can draw (the review sheet and tests iterate it). */
export const DRAWN_TYPES = Object.keys(DRAW);
