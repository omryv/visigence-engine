/**
 * Particles, screen shake and floating score text for the game shell. Event-driven: the shell
 * hands every simulation event to `handle`, which turns it into a small burst appropriate to
 * it (dust on landing, sparkles on honey, a splat for a stomped slime). Drawn in world space
 * through drawScene's fx hook, so particles sit under the grade and the darkness like
 * everything else. Reduced motion keeps the feedback and drops the shake.
 */

import { mulberry32 } from '../../kernel/seed.js';

const COLORS = {
  dust: ['#e8d2b0', '#d9bf98'], honey: ['#ffd26b', '#ffb72b', '#fff4c2'], heart: ['#ff5a6e', '#ffb3bf'],
  slime: ['#7bdc5a', '#4aa83a', '#d4ffc0'], spark: ['#fff6c9', '#ffcf6b'], wood: ['#c98b4a', '#9a6230'],
  leaf: ['#5fb14b', '#8fd46a'], blue: ['#72d6ff', '#d9f5ff'], pink: ['#ffb3e2', '#fff2fb'], rock: ['#aeb6be', '#7f8993'],
  water: ['#a9e3ff', '#ffffff'],
};

/* The sparks' stream: fixed, so a level's effects are the same every time (nothing in the engine is random). */
export function createFx({ reduced = false, rng = mulberry32(0xf00d) } = {}) {
  const parts = [];
  const texts = [];
  let shakeT = 0, shakeAmp = 0;
  const MAX = reduced ? 120 : 420;

  function burst(x, y, n, palette, { speed = 3, up = 0, life = 0.5, size = 0.1, gravity = 12, spread = Math.PI * 2, angle = -Math.PI / 2, shape = 'dot' } = {}) {
    if (reduced) n = Math.ceil(n / 2);
    for (let i = 0; i < n && parts.length < MAX; i++) {
      const a = angle + (rng() - 0.5) * spread, s = speed * (0.4 + rng() * 0.8);
      parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - up, life: life * (0.6 + rng() * 0.6), max: life, size: size * (0.6 + rng() * 0.8), color: palette[Math.floor(rng() * palette.length)], gravity, shape, spin: rng() * 6 });
    }
  }
  function text(x, y, str, color = '#fff6c9') { texts.push({ x, y, str, color, life: 0.9, max: 0.9 }); }
  function shake(amp, t = 0.25) { if (reduced) return; shakeAmp = Math.max(shakeAmp, amp); shakeT = Math.max(shakeT, t); }

  return {
    handle(e) {
      switch (e.type) {
        case 'jump': burst(e.x, e.y, e.big ? 10 : 5, COLORS.dust, { speed: 1.6, spread: Math.PI * 0.8, angle: Math.PI / 2 * 0 - Math.PI / 2, life: 0.35, size: e.big ? 0.14 : 0.08, gravity: -2 }); break;
        case 'doubleJump': burst(e.x, e.y, 8, COLORS.spark, { speed: 2.5, life: 0.4, size: 0.07, gravity: 0, shape: 'star' }); break;
        case 'land': burst(e.x, e.y, 6, COLORS.dust, { speed: 2.2, spread: Math.PI * 0.5, angle: -Math.PI / 2, life: 0.35, size: 0.09, gravity: 4 }); break;
        case 'coin': burst(e.x, e.y, 6, COLORS.honey, { speed: 2.5, life: 0.4, size: 0.06, gravity: 0, shape: 'star' }); text(e.x, e.y - 0.3, '+10'); break;
        case 'gem': burst(e.x, e.y, 14, COLORS.honey, { speed: 3.5, life: 0.6, size: 0.08, gravity: 0, shape: 'star' }); text(e.x, e.y - 0.4, '+100'); break;
        case 'heart': burst(e.x, e.y, 10, COLORS.heart, { speed: 2.5, life: 0.5, size: 0.08, gravity: -1 }); break;
        case 'key': case 'chest': burst(e.x, e.y, 12, COLORS.spark, { speed: 3, life: 0.6, size: 0.07, gravity: 0, shape: 'star' }); break;
        case 'powerup': case 'power': burst(e.x, e.y, 16, e.type === 'power' ? COLORS.pink : COLORS.blue, { speed: 4, life: 0.6, size: 0.08, gravity: 0, shape: 'star' }); break;
        case 'stomp': burst(e.x, e.y, 10, COLORS.slime, { speed: 3, life: 0.45, size: 0.11, gravity: 14, spread: Math.PI, angle: -Math.PI / 2 }); shake(0.06, 0.1); break;
        case 'kill': burst(e.x, e.y, 10, e.what === 'bee' ? COLORS.honey : COLORS.slime, { speed: 3.2, life: 0.45, size: 0.1 }); if (e.score) text(e.x, e.y - 0.4, '+' + e.score); break;
        case 'hurt': burst(e.x, e.y, 8, COLORS.heart, { speed: 3, life: 0.35, size: 0.08, gravity: 6 }); shake(0.12, 0.2); break;
        case 'die': burst(e.x, e.y, 16, COLORS.spark, { speed: 4, life: 0.8, size: 0.09, gravity: 3, shape: 'star' }); shake(0.18, 0.3); break;
        case 'checkpoint': burst(e.x, e.y, 14, COLORS.honey, { speed: 2.5, life: 0.8, size: 0.07, gravity: -3, shape: 'star' }); break;
        case 'spring': burst(e.x, e.y, 6, COLORS.spark, { speed: 2, life: 0.3, size: 0.07, gravity: 0 }); break;
        case 'hit': burst(e.x, e.y, 4, e.owner === 'player' ? COLORS.spark : COLORS.wood, { speed: 2.5, life: 0.25, size: 0.06, gravity: 0 }); break;
        case 'break': burst(e.x, e.y, 14, e.what === 'bush' ? COLORS.leaf : COLORS.wood, { speed: 3.5, life: 0.6, size: 0.1, gravity: 8 }); shake(0.05, 0.1); break;
        case 'crumble': if (!e.start) burst(e.x, e.y, 10, COLORS.dust, { speed: 2, life: 0.6, size: 0.1, gravity: 14, spread: Math.PI, angle: Math.PI / 2 }); break;
        case 'teleport': burst(e.x, e.y, 16, COLORS.pink, { speed: 3, life: 0.5, size: 0.07, gravity: 0, shape: 'star' }); if (e.from) burst(e.from.x, e.from.y, 10, COLORS.pink, { speed: 2, life: 0.4, size: 0.06, gravity: 0 }); break;
        case 'push': burst(e.x, e.y + 0.4, 4, COLORS.dust, { speed: 1.2, life: 0.3, size: 0.07, gravity: -1 }); break;
        case 'fill': burst(e.x, e.y, 14, COLORS.dust, { speed: 2.5, life: 0.6, size: 0.11, gravity: 4 }); shake(0.05, 0.12); break;
        case 'splash': burst(e.x, e.y, 10, COLORS.water, { speed: 3.5, life: 0.5, size: 0.08, gravity: 16, spread: Math.PI * 0.7 }); break;
        case 'beeEaten': text(e.x, e.y - 0.3, '+' + (e.score || 200), '#ffb3e2'); burst(e.x, e.y, 10, COLORS.pink, { speed: 3, life: 0.5, size: 0.07, shape: 'star', gravity: 0 }); break;
        case 'slam': burst(e.x, e.y, 18, COLORS.dust, { speed: 4, life: 0.6, size: 0.14, gravity: 8, spread: Math.PI, angle: -Math.PI / 2 }); shake(e.shake || 0.3, 0.35); break;
        case 'bossHit': burst(e.x, e.y, 14, COLORS.slime, { speed: 4, life: 0.5, size: 0.12 }); shake(0.15, 0.2); break;
        case 'win': burst(e.x, e.y - 0.5, 30, [...COLORS.honey, ...COLORS.blue], { speed: 5, life: 1.2, size: 0.09, gravity: 5, shape: 'star' }); break;
        case 'shieldBreak': burst(e.x, e.y, 12, COLORS.blue, { speed: 3.5, life: 0.4, size: 0.07, gravity: 0 }); break;
        case 'spawn': burst(e.x, e.y + 0.3, 8, COLORS.dust, { speed: 1.8, life: 0.45, size: 0.11, gravity: -1 }); break;
        case 'door': burst(e.x, e.y + 0.3, 6, COLORS.dust, { speed: 1.5, life: 0.4, size: 0.09, gravity: -1 }); break;
        case 'dot': break;
        default: break;
      }
    },
    update(dt) {
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.life -= dt;
        if (p.life <= 0) { parts.splice(i, 1); continue; }
        p.vy += p.gravity * dt; p.x += p.vx * dt; p.y += p.vy * dt;
        p.vx *= Math.exp(-2 * dt);
      }
      for (let i = texts.length - 1; i >= 0; i--) { const t = texts[i]; t.life -= dt; t.y -= dt * 1.2; if (t.life <= 0) texts.splice(i, 1); }
      shakeT = Math.max(0, shakeT - dt);
      if (!shakeT) shakeAmp = 0;
    },
    /** World-space draw, called from drawScene's fx hook. */
    draw(ctx, cam, size, ox, oy) {
      for (const p of parts) {
        const k = p.life / p.max;
        ctx.globalAlpha = Math.min(1, k * 1.6);
        ctx.fillStyle = p.color;
        const x = ox + p.x * size, y = oy + p.y * size, r = Math.max(1, p.size * size * (0.5 + k * 0.5));
        if (p.shape === 'star') {
          ctx.beginPath();
          ctx.moveTo(x, y - r * 1.6); ctx.quadraticCurveTo(x, y, x + r * 1.6, y); ctx.quadraticCurveTo(x, y, x, y + r * 1.6); ctx.quadraticCurveTo(x, y, x - r * 1.6, y); ctx.quadraticCurveTo(x, y, x, y - r * 1.6);
          ctx.fill();
        } else { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
      }
      ctx.globalAlpha = 1;
      if (texts.length) {
        ctx.font = `900 ${Math.max(11, Math.round(size * 0.36))}px "Nunito", ui-rounded, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.lineJoin = 'round';
        for (const t of texts) {
          const k = t.life / t.max;
          ctx.globalAlpha = Math.min(1, k * 2);
          const x = ox + t.x * size, y = oy + t.y * size;
          ctx.lineWidth = Math.max(2, size * 0.08); ctx.strokeStyle = '#2b1d14'; ctx.strokeText(t.str, x, y);
          ctx.fillStyle = t.color; ctx.fillText(t.str, x, y);
        }
        ctx.globalAlpha = 1;
        ctx.textAlign = 'start';
      }
    },
    /** Camera offset in tiles for the current shake. */
    shakeOffset(t) {
      if (!shakeT) return { x: 0, y: 0 };
      const a = shakeAmp * (shakeT / 0.35);
      return { x: Math.sin(t * 91) * a, y: Math.cos(t * 77) * a };
    },
    clear() { parts.length = 0; texts.length = 0; shakeT = 0; },
  };
}
