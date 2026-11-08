/**
 * The in-game HUD, drawn on the canvas in CSS pixels after the scene: hearts and lives, the
 * objective, score, honey and keys, timers, the power bar, the boss bar and the message panel
 * for signs and villagers. Indigo pills with a soft outline and rounded Nunito (its digits are
 * all one width, so counters never wobble), matching the builder's playful night skin.
 */

import { unit, ell, heartPath, dropPath } from '../art/draw.js';
import { SPRITE, INK as OUTLINE, keyHex } from '../art/palette.js';

const FONT_NUM = '"Nunito", ui-rounded, system-ui, sans-serif';
const FONT_SANS = '"Nunito", ui-rounded, system-ui, sans-serif';
const PILL = 'rgba(21, 26, 77, 0.82)';
const INK = '#f4f5ff', MUTED = '#b3b9ee', PEAK = '#b7a3ff', TUNG = '#ffc933', TALLY = '#ff6b93', ZEBRA = '#ffd24a';

function pill(ctx, x, y, w, h, r = 10) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = PILL; ctx.fill();
  ctx.strokeStyle = 'rgba(141, 150, 232, 0.6)'; ctx.lineWidth = 1.5; ctx.stroke();
}
function wrap(ctx, text, max) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? line + ' ' + w : w;
    if (ctx.measureText(next).width > max && line) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}
const clock = s => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Crisp vector icons for the HUD, drawn in a unit box centred at (cx, cy) of size s. */
function heartIcon(ctx, cx, cy, s, full) {
  unit(ctx, cx, cy, s);
  ctx.lineWidth = 0.09;
  heartPath(ctx, 0, 0.06, 0.4);
  if (full) { ctx.fillStyle = SPRITE.heart.base; ctx.fill(); ctx.fillStyle = SPRITE.heart.light; ell(ctx, -0.17, -0.1, 0.09, 0.06, -0.6); ctx.fill(); heartPath(ctx, 0, 0.06, 0.4); ctx.strokeStyle = OUTLINE; ctx.stroke(); }
  else { ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fill(); ctx.strokeStyle = 'rgba(236,235,230,0.45)'; ctx.stroke(); }
  ctx.restore();
}
function dropIcon(ctx, cx, cy, s) {
  unit(ctx, cx, cy, s);
  ctx.lineWidth = 0.08;
  dropPath(ctx, 0, 0.1, 0.3); ctx.fillStyle = SPRITE.honey.base; ctx.fill(); ctx.strokeStyle = OUTLINE; ctx.stroke();
  ctx.fillStyle = SPRITE.honey.light; ell(ctx, -0.1, 0.02, 0.06, 0.12, 0.3); ctx.fill();
  ctx.restore();
}
function jarIcon(ctx, cx, cy, s) {
  unit(ctx, cx, cy, s);
  ctx.lineWidth = 0.08;
  ctx.beginPath(); ctx.moveTo(-0.24, -0.22); ctx.quadraticCurveTo(-0.4, -0.1, -0.36, 0.14); ctx.quadraticCurveTo(-0.34, 0.4, 0, 0.4); ctx.quadraticCurveTo(0.34, 0.4, 0.36, 0.14); ctx.quadraticCurveTo(0.4, -0.1, 0.24, -0.22); ctx.closePath();
  ctx.fillStyle = SPRITE.jar.honey; ctx.fill(); ctx.strokeStyle = OUTLINE; ctx.stroke();
  ctx.fillStyle = SPRITE.jar.lid; ctx.fillRect(-0.3, -0.38, 0.6, 0.16); ctx.strokeRect(-0.3, -0.38, 0.6, 0.16);
  ctx.fillStyle = 'rgba(255,255,255,0.65)'; ctx.fillRect(-0.22, -0.12, 0.07, 0.34);
  ctx.restore();
}
function keyIcon(ctx, cx, cy, s, color) {
  unit(ctx, cx, cy, s);
  ctx.lineWidth = 0.08; ctx.strokeStyle = OUTLINE; ctx.fillStyle = keyHex(color);
  ctx.rotate(-0.5);
  ctx.beginPath(); ctx.arc(-0.2, 0, 0.18, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillRect(-0.04, -0.06, 0.46, 0.12); ctx.strokeRect(-0.04, -0.06, 0.46, 0.12);
  ctx.fillRect(0.26, 0.04, 0.08, 0.12); ctx.strokeRect(0.26, 0.04, 0.08, 0.12);
  ctx.restore();
}
function headIcon(ctx, cx, cy, s) {
  unit(ctx, cx, cy, s);
  ctx.lineWidth = 0.08; ctx.strokeStyle = OUTLINE;
  ell(ctx, 0, 0.05, 0.34, 0.32); ctx.fillStyle = SPRITE.hero.skin; ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-0.36, 0.08); ctx.bezierCurveTo(-0.4, -0.42, 0.4, -0.42, 0.36, 0.08); ctx.quadraticCurveTo(0.1, -0.1, -0.36, 0.08); ctx.closePath(); ctx.fillStyle = SPRITE.hero.hair; ctx.fill(); ctx.stroke();
  ctx.fillStyle = OUTLINE; ell(ctx, -0.12, 0.1, 0.05, 0.07); ctx.fill(); ell(ctx, 0.12, 0.1, 0.05, 0.07); ctx.fill();
  ctx.restore();
}

export function drawHud(ctx, w, h, sim, o) {
  const k = Math.max(0.8, Math.min(1.25, Math.min(w, h) / 720));
  const pad = Math.round(14 * k);
  ctx.save();
  if (o.topInset) ctx.translate(0, o.topInset);
  h -= o.topInset || 0;
  ctx.save();
  ctx.textBaseline = 'middle';
  const p = sim.player;
  const topH = Math.round(40 * k);

  // ---- top left: hearts, lives, power
  if (sim.genre !== 'puzzle' && sim.genre !== 'maze') {
    const hs = Math.round(22 * k), gap = Math.round(3 * k);
    const livesW = o.lives > 0 ? Math.round(52 * k) : 0;
    const bw = pad + p.maxHearts * (hs + gap) + livesW + Math.round(4 * k);
    pill(ctx, pad, pad, bw, topH);
    for (let i = 0; i < p.maxHearts; i++) heartIcon(ctx, pad + Math.round(10 * k) + i * (hs + gap) + hs / 2, pad + topH / 2, hs, i < p.hearts);
    if (o.lives > 0) { ctx.fillStyle = MUTED; ctx.font = `800 ${Math.round(12 * k)}px ${FONT_NUM}`; ctx.fillText(`×${o.lives}`, pad + bw - livesW + Math.round(8 * k), pad + topH / 2 + 1); }
  } else if (o.lives > 0) {
    const bw = Math.round(86 * k);
    pill(ctx, pad, pad, bw, topH);
    headIcon(ctx, pad + Math.round(20 * k), pad + topH / 2, Math.round(24 * k));
    ctx.fillStyle = INK; ctx.font = `900 ${Math.round(14 * k)}px ${FONT_NUM}`; ctx.fillText(`×${o.lives}`, pad + Math.round(38 * k), pad + topH / 2 + 1);
  }
  const power = p.data?.power;
  if (power && power.left > 0) {
    const y = pad + topH + Math.round(8 * k), bw = Math.round(150 * k), bh = Math.round(24 * k);
    pill(ctx, pad, y, bw, bh, 6);
    const col = { wings: '#ffe98a', rapid: '#ff7a5c', spread: '#72d6ff', shield: '#9df5c8' }[power.kind] || PEAK;
    ctx.fillStyle = INK; ctx.font = `800 ${Math.round(10 * k)}px ${FONT_NUM}`;
    ctx.fillText(power.kind.toUpperCase(), pad + Math.round(10 * k), y + bh / 2 + 1);
    const bx = pad + Math.round(62 * k), bl = bw - Math.round(72 * k);
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(bx, y + bh / 2 - 2, bl, 4);
    ctx.fillStyle = col; ctx.fillRect(bx, y + bh / 2 - 2, bl * Math.max(0, power.left / power.total), 4);
  }
  if (sim.genre === 'maze' && sim.powerLeft > 0) {
    const y = pad + topH + Math.round(8 * k), bw = Math.round(150 * k), bh = Math.round(24 * k);
    pill(ctx, pad, y, bw, bh, 6);
    ctx.fillStyle = INK; ctx.font = `800 ${Math.round(10 * k)}px ${FONT_NUM}`; ctx.fillText('JELLY', pad + Math.round(10 * k), y + bh / 2 + 1);
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(pad + Math.round(62 * k), y + bh / 2 - 2, bw - Math.round(72 * k), 4);
    ctx.fillStyle = '#ffb3e2'; ctx.fillRect(pad + Math.round(62 * k), y + bh / 2 - 2, (bw - Math.round(72 * k)) * Math.min(1, sim.powerLeft / 7), 4);
  }

  // ---- top centre: the objective
  const obj = sim.objective || {};
  ctx.font = `900 ${Math.round(13 * k)}px ${FONT_SANS}`;
  const labelW = ctx.measureText(obj.label || '').width;
  ctx.font = `800 ${Math.round(12 * k)}px ${FONT_NUM}`;
  const textW = obj.text ? ctx.measureText(obj.text).width + Math.round(14 * k) : 0;
  const ow = Math.min(w - pad * 2, labelW + textW + Math.round(32 * k));
  const narrow = w < 560;
  const ox = narrow ? w - pad - ow : (w - ow) / 2, oy = narrow ? pad + topH + Math.round(8 * k) : pad;
  if (obj.label) {
    pill(ctx, ox, oy, ow, topH);
    ctx.fillStyle = INK; ctx.font = `900 ${Math.round(13 * k)}px ${FONT_SANS}`;
    ctx.fillText(obj.label, ox + Math.round(16 * k), oy + topH / 2);
    if (obj.text) { ctx.fillStyle = TUNG; ctx.font = `800 ${Math.round(12 * k)}px ${FONT_NUM}`; ctx.fillText(obj.text, ox + Math.round(16 * k) + labelW + Math.round(14 * k), oy + topH / 2 + 1); }
    if (obj.progress > 0) { ctx.fillStyle = PEAK; ctx.fillRect(ox + 8, oy + topH - 3, (ow - 16) * Math.min(1, obj.progress), 2); }
  }
  // time limit
  const limit = sim.level.rules.timeLimit;
  if (limit > 0 && sim.genre !== 'puzzle') {
    const left = limit - sim.time;
    const tw = Math.round(76 * k), ty = oy + topH + Math.round(8 * k);
    const tx = narrow ? w - pad - tw : (w - tw) / 2;
    pill(ctx, tx, ty, tw, Math.round(28 * k), 6);
    ctx.fillStyle = left < 10 ? ZEBRA : INK; ctx.font = `900 ${Math.round(13 * k)}px ${FONT_NUM}`;
    ctx.textAlign = 'center'; ctx.fillText(clock(left), tx + tw / 2, ty + Math.round(14 * k) + 1); ctx.textAlign = 'start';
  }

  // ---- top right: score, honey, keys
  if (!narrow || sim.genre === 'maze' || sim.genre === 'puzzle') {
    ctx.font = `900 ${Math.round(16 * k)}px ${FONT_NUM}`;
    const scoreStr = String((o.score || 0) + sim.score).padStart(5, '0');
    const parts = [];
    if (sim.genre === 'puzzle') parts.push(['moves', `${sim.moves}`]);
    if (sim.coinsTotal) parts.push(['coin', `${sim.coins}/${sim.coinsTotal}`]);
    if (sim.gemsTotal) parts.push(['gem', `${sim.gems}/${sim.gemsTotal}`]);
    ctx.font = `800 ${Math.round(12 * k)}px ${FONT_NUM}`;
    let extra = 0;
    // a part is an icon and its count, or for moves a MOVES label and the count: measure what is drawn
    for (const [kind, s] of parts) extra += kind === 'moves' ? ctx.measureText(`MOVES ${s}`).width + Math.round(14 * k) : ctx.measureText(s).width + Math.round(34 * k);
    const keys = Object.entries(sim.keys || {}).filter(([, n]) => n > 0);
    extra += keys.length * Math.round(34 * k);
    ctx.font = `900 ${Math.round(16 * k)}px ${FONT_NUM}`;
    const sw = sim.genre === 'puzzle' ? 0 : ctx.measureText(scoreStr).width + Math.round(20 * k);
    const bw = sw + extra + Math.round(14 * k);
    const bx = narrow ? pad + (sim.genre === 'maze' && o.lives > 0 ? Math.round(94 * k) : 0) : w - pad - bw - (o.rightInset || 0);
    if (bw > Math.round(20 * k)) {
      pill(ctx, bx, pad, bw, topH);
      let x = bx + Math.round(12 * k);
      if (sw) { ctx.fillStyle = INK; ctx.fillText(scoreStr, x, pad + topH / 2 + 1); x += sw; }
      ctx.font = `800 ${Math.round(12 * k)}px ${FONT_NUM}`;
      for (const [kind, s] of parts) {
        if (kind === 'moves') { ctx.fillStyle = MUTED; ctx.fillText('MOVES', x, pad + topH / 2 + 1); x += ctx.measureText('MOVES ').width; ctx.fillStyle = INK; ctx.fillText(s, x, pad + topH / 2 + 1); x += ctx.measureText(s).width + Math.round(14 * k); continue; }
        const is = Math.round(20 * k);
        (kind === 'coin' ? dropIcon : jarIcon)(ctx, x + is / 2, pad + topH / 2, is);
        x += is + Math.round(4 * k);
        ctx.fillStyle = INK; ctx.fillText(s, x, pad + topH / 2 + 1);
        x += ctx.measureText(s).width + Math.round(10 * k);
      }
      for (const [color, n] of keys) {
        const is = Math.round(20 * k);
        keyIcon(ctx, x + is / 2, pad + topH / 2, is, color);
        x += is;
        if (n > 1) { ctx.fillStyle = INK; ctx.fillText(`${n}`, x, pad + topH / 2 + 1); }
        x += Math.round(14 * k);
      }
    }
  }

  // ---- boss bar
  const boss = sim.boss;
  if (boss && boss.alive && boss.maxHp > 1) {
    const bw = Math.min(w - pad * 2, Math.round(360 * k)), bh = Math.round(34 * k);
    const bx = (w - bw) / 2, by = h - pad - bh - (o.touch ? Math.round(150 * k) : 0);
    pill(ctx, bx, by, bw, bh);
    ctx.fillStyle = INK; ctx.font = `900 ${Math.round(12 * k)}px ${FONT_SANS}`;
    ctx.fillText('King Slime', bx + Math.round(12 * k), by + bh / 2);
    const lx = bx + Math.round(92 * k), lw = bw - Math.round(104 * k);
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(lx, by + bh / 2 - 3, lw, 6);
    ctx.fillStyle = TALLY; ctx.fillRect(lx, by + bh / 2 - 3, lw * Math.max(0, boss.hp / boss.maxHp), 6);
  }

  // ---- messages from signs and villagers
  if (sim.message && sim.message.text) {
    const mw = Math.min(w - pad * 2, Math.round(560 * k));
    ctx.font = `600 ${Math.round(15 * k)}px ${FONT_SANS}`;
    const lines = wrap(ctx, sim.message.text, mw - Math.round(36 * k));
    const lh = Math.round(22 * k);
    const mh = Math.round(46 * k) + lines.length * lh;
    const mx = (w - mw) / 2, my = h - pad - mh - (o.touch ? Math.round(150 * k) : Math.round(10 * k));
    pill(ctx, mx, my, mw, mh, 10);
    ctx.fillStyle = TUNG; ctx.font = `800 ${Math.round(11 * k)}px ${FONT_NUM}`;
    ctx.fillText((sim.message.title || '').toUpperCase(), mx + Math.round(18 * k), my + Math.round(20 * k));
    ctx.fillStyle = INK; ctx.font = `600 ${Math.round(15 * k)}px ${FONT_SANS}`;
    lines.forEach((l, i) => ctx.fillText(l, mx + Math.round(18 * k), my + Math.round(40 * k) + i * lh + lh / 2 - 4));
  }

  // ---- puzzle hint
  if (sim.genre === 'puzzle' && !o.touch) {
    ctx.font = `800 ${Math.round(11 * k)}px ${FONT_NUM}`;
    const s = 'Z UNDO · R RESTART';
    const tw = ctx.measureText(s).width + Math.round(24 * k);
    pill(ctx, pad, h - pad - Math.round(30 * k), tw, Math.round(30 * k), 6);
    ctx.fillStyle = MUTED; ctx.fillText(s, pad + Math.round(12 * k), h - pad - Math.round(15 * k) + 1);
  }
  ctx.restore();
  ctx.restore();
}
