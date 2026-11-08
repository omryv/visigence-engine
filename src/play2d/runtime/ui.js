/**
 * The game shell's DOM: the canvas, menus (title, level select, intro card, pause, level
 * complete, game over, ending), the playtest bar and the touch controls. Its stylesheet is a
 * string injected once, so an exported game needs no other file. The builder's playful night
 * skin: indigo cards with a bold outline and a hard drop, toy buttons that press down, the
 * game's accent on its one main action, Fredoka headings and Nunito for the rest.
 *
 * Menus are real buttons: Tab and the arrow keys move between them, Enter or Space presses,
 * and a gamepad's d-pad and A button do the same (the shell forwards them).
 */

export const CSS = `
.vgg{position:relative;width:100%;height:100%;overflow:hidden;background:#0c0e33;color:#f4f5ff;font:500 15px/22px "Nunito",ui-rounded,system-ui,sans-serif;-webkit-font-smoothing:antialiased;user-select:none;-webkit-user-select:none;touch-action:none;--vgg-accent:#ff9f45}
.vgg *{box-sizing:border-box}
.vgg canvas.vgg-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;outline:none}
.vgg-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.vgg-screen{position:absolute;inset:0;display:grid;place-items:center;padding:24px 16px;background:rgba(12,14,51,.55);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);z-index:5;animation:vgg-in .3s ease-out}
.vgg-screen[hidden]{display:none}
.vgg-screen.is-clear{background:transparent;backdrop-filter:none;-webkit-backdrop-filter:none;pointer-events:none}
@keyframes vgg-in{from{opacity:0}}
.vgg-card{width:min(460px,100%);max-height:100%;overflow:auto;background:#1f2566;border:2px solid #8d96e8;border-radius:20px;padding:28px;box-shadow:7px 8px 0 #050620;display:grid;gap:14px;pointer-events:auto;animation:vgg-pop .45s cubic-bezier(.34,1.4,.64,1)}
@keyframes vgg-pop{from{opacity:0;transform:translateY(16px) scale(.94)}}
.vgg-card.is-wide{width:min(620px,100%)}
.vgg-title-card{width:min(560px,100%);text-align:left}
.vgg-meta{margin:0;font:800 11px/16px "Nunito",ui-rounded,system-ui,sans-serif;letter-spacing:.07em;text-transform:uppercase;color:#b3b9ee;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.vgg-meta i{width:4px;height:4px;border-radius:9px;background:currentColor;opacity:.7}
.vgg-meta--accent{color:#ff8fc8}
.vgg-h1{margin:0;font:700 clamp(36px,6.5vw,56px)/1.02 "Fredoka","Nunito",ui-rounded,system-ui,sans-serif;letter-spacing:-.01em;text-wrap:balance}
.vgg-h2{margin:0;font:700 clamp(30px,5vw,42px)/1.05 "Fredoka","Nunito",ui-rounded,system-ui,sans-serif;letter-spacing:0;text-wrap:balance}
.vgg-p{margin:0;color:#d2d6fa;font-size:15px;font-weight:600;line-height:22px}
.vgg-muted{color:#b3b9ee}
.vgg-actions{display:grid;gap:10px;margin-top:6px}
.vgg-row{display:flex;flex-wrap:wrap;gap:8px}
.vgg-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:46px;padding:0 20px;border-radius:14px;border:2px solid #8d96e8;background:#2b3282;color:#f4f5ff;font:800 15px/16px "Nunito",ui-rounded,system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 0 #050620;transition:background-color .18s,box-shadow .18s,transform .18s cubic-bezier(.34,1.4,.64,1),filter .18s}
.vgg-btn:hover{background:#343b94;transform:translateY(-1px);box-shadow:0 5px 0 #050620}
.vgg-btn:active{transform:translateY(4px);box-shadow:0 0 0 #050620;transition-duration:.06s}
.vgg-btn:focus-visible{outline:3px solid #b7a3ff;outline-offset:3px}
.vgg-btn:disabled{opacity:.4;cursor:not-allowed;transform:none}
.vgg-btn--primary{background:var(--vgg-accent);border-color:#050620;color:#1c2250}
.vgg-btn--primary:hover{background:var(--vgg-accent);filter:brightness(1.07)}
.vgg-btn--ghost{border-color:transparent;background:none;color:#b3b9ee;box-shadow:none}
.vgg-btn--ghost:hover{color:#f4f5ff;background:#2b3282;box-shadow:none}
.vgg-btn--ghost:active{transform:translateY(1px)}
.vgg-btn svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.vgg-stars{display:flex;gap:12px;justify-content:center;margin:4px 0}
.vgg-stars svg{width:44px;height:44px;fill:#2b3282;stroke:#8d96e8;stroke-width:1.6;stroke-linejoin:round;transition:transform .42s cubic-bezier(.34,1.4,.64,1)}
.vgg-stars svg.is-on{fill:#ffc933;stroke:#050620;animation:vgg-star .55s cubic-bezier(.34,1.4,.64,1) both}
@keyframes vgg-star{from{transform:scale(.2) rotate(-40deg);opacity:0}}
.vgg-stats{display:grid;grid-template-columns:1fr auto;gap:6px 16px;margin:0;padding:12px 0;border-top:2px dashed #313a8a;border-bottom:2px dashed #313a8a}
.vgg-stats dt{color:#b3b9ee;font:800 11px/20px "Nunito",ui-rounded,system-ui,sans-serif;letter-spacing:.07em;text-transform:uppercase}
.vgg-stats dd{margin:0;font:900 15px/20px "Nunito",ui-rounded,system-ui,sans-serif;text-align:right;font-variant-numeric:tabular-nums}
.vgg-levels{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}
.vgg-level{display:grid;gap:4px;justify-items:start;padding:12px;min-height:68px;border-radius:14px;border:2px solid #8d96e8;background:#2b3282;color:#f4f5ff;text-align:left;font:800 14px/18px "Nunito",ui-rounded,system-ui,sans-serif;cursor:pointer;box-shadow:0 3px 0 #050620;transition:transform .18s cubic-bezier(.34,1.4,.64,1),background-color .18s}
.vgg-level:hover{background:#343b94;transform:translateY(-2px)}
.vgg-level:focus-visible{outline:3px solid #b7a3ff;outline-offset:3px}
.vgg-level:disabled{opacity:.4;cursor:not-allowed;transform:none}
.vgg-level small{font:800 10px/14px "Nunito",ui-rounded,system-ui,sans-serif;letter-spacing:.07em;color:#b3b9ee;text-transform:uppercase}
.vgg-level .vgg-mini{color:#ffc933;letter-spacing:2px;font-size:13px}
.vgg-credit{margin:6px 0 0;font:800 10px/14px "Nunito",ui-rounded,system-ui,sans-serif;letter-spacing:.09em;text-transform:uppercase;color:#8d96e8}
.vgg-hint{margin:0;font:700 12px/17px "Nunito",ui-rounded,system-ui,sans-serif;color:#b3b9ee}
.vgg-intro{position:absolute;left:50%;top:22%;transform:translateX(-50%);z-index:4;text-align:center;pointer-events:none;animation:vgg-intro 2.2s cubic-bezier(.34,1.4,.64,1) both;padding:14px 26px 16px;border-radius:18px;border:2px solid #8d96e8;background:rgba(31,37,102,.9);box-shadow:5px 6px 0 #050620;max-width:calc(100% - 32px)}
.vgg-intro[hidden]{display:none}
@keyframes vgg-intro{0%{opacity:0;transform:translate(-50%,14px) scale(.9)}14%{opacity:1;transform:translate(-50%,0)}80%{opacity:1}100%{opacity:0}}
.vgg-bar{position:absolute;left:0;right:0;top:0;z-index:6;display:flex;align-items:center;gap:8px;padding:8px 10px;background:linear-gradient(rgba(12,14,51,.78),rgba(12,14,51,0));pointer-events:none}
.vgg-bar>*{pointer-events:auto}
.vgg-bar[hidden]{display:none}
.vgg-bar .vgg-btn{min-height:34px;padding:0 12px;font-size:13px;box-shadow:0 3px 0 #050620}
.vgg-bar .vgg-meta{margin-right:auto;color:#f4f5ff}
.vgg-tally{display:inline-flex;align-items:center;gap:6px;color:#ff6b93}
.vgg-tally::before{content:"";width:9px;height:9px;border-radius:9px;background:#ff6b93;box-shadow:0 0 0 3px rgba(255,107,147,.25);animation:vgg-pulse 1.6s ease-in-out infinite}
@keyframes vgg-pulse{50%{opacity:.45;transform:scale(.75)}}
.vgg-corner{position:absolute;right:10px;top:10px;z-index:6;display:flex;gap:8px}
.vgg-corner[hidden]{display:none}
.vgg-icon{width:42px;height:42px;padding:0;border-radius:999px;border:2px solid #8d96e8;background:rgba(31,37,102,.88);color:#f4f5ff;display:grid;place-items:center;cursor:pointer;box-shadow:0 3px 0 #050620;transition:transform .18s cubic-bezier(.34,1.4,.64,1)}
.vgg-icon:active{transform:translateY(3px);box-shadow:none}
.vgg-icon:focus-visible{outline:3px solid #b7a3ff;outline-offset:3px}
.vgg-icon svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.vgg-touch{position:absolute;inset:auto 0 0 0;height:190px;z-index:3;pointer-events:none;padding:0 max(18px,env(safe-area-inset-left)) max(18px,env(safe-area-inset-bottom))}
.vgg-touch[hidden]{display:none}
.vgg-stick{position:absolute;bottom:max(22px,env(safe-area-inset-bottom));width:128px;height:128px;border-radius:999px;background:rgba(31,37,102,.38);border:2px solid rgba(244,245,255,.3);pointer-events:auto;touch-action:none}
.vgg-stick--left{left:max(22px,env(safe-area-inset-left))}
.vgg-stick--right{right:max(22px,env(safe-area-inset-right))}
.vgg-stick i{position:absolute;left:50%;top:50%;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:999px;background:rgba(244,245,255,.9);border:2px solid #050620;box-shadow:0 4px 0 rgba(5,6,32,.6)}
.vgg-pad{position:absolute;left:max(18px,env(safe-area-inset-left));bottom:max(18px,env(safe-area-inset-bottom));display:grid;grid-template-columns:repeat(3,58px);grid-template-rows:repeat(3,58px);gap:5px;pointer-events:auto}
.vgg-pad--lr{grid-template-columns:repeat(2,76px);grid-template-rows:76px}
.vgg-tbtn{border-radius:18px;border:2px solid rgba(244,245,255,.3);background:rgba(31,37,102,.58);color:#f4f5ff;font:900 15px/1 "Nunito",ui-rounded,system-ui,sans-serif;letter-spacing:.04em;display:grid;place-items:center;touch-action:none;-webkit-tap-highlight-color:transparent}
.vgg-tbtn.is-down{background:rgba(244,245,255,.92);color:#0c0e33}
.vgg-tbtn svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.vgg-acts{position:absolute;right:max(18px,env(safe-area-inset-right));bottom:max(18px,env(safe-area-inset-bottom));display:flex;gap:12px;align-items:flex-end;pointer-events:auto}
.vgg-acts .vgg-tbtn{width:74px;height:74px;border-radius:999px}
.vgg-acts .vgg-tbtn--main{width:88px;height:88px;background:rgba(255,201,51,.88);color:#1c2250;border-color:#050620}
.vgg-acts .vgg-tbtn--main.is-down{background:#ffd65c}
@media (prefers-reduced-motion:reduce){.vgg-screen,.vgg-card,.vgg-intro,.vgg-stars svg.is-on{animation:none}.vgg-tally::before{animation:none}.vgg-btn,.vgg-level,.vgg-icon{transition:none}}
`;

const ICON = {
  play: '<path d="m7 4 13 8-13 8Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  sound: '<path d="M4 9v6h4l5 4V5L8 9Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9Z"/><path d="m17 9 5 6m0-6-5 6"/>',
  restart: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  undo: '<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 0 12h-2"/>',
  up: '<path d="m6 15 6-6 6 6"/>', down: '<path d="m6 9 6 6 6-6"/>', left: '<path d="m15 6-6 6 6 6"/>', right: '<path d="m9 6 6 6-6 6"/>',
  star: '<path d="m12 2.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3L2.9 9.5l6.3-.9Z"/>',
};
export const svg = (name, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${ICON[name] || ''}</svg>`;

export function injectStyle() {
  if (typeof document === 'undefined' || document.getElementById('vgg-style')) return;
  const s = document.createElement('style');
  s.id = 'vgg-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Build the shell's DOM inside `container`. */
export function createUI(container, { accent } = {}) {
  injectStyle();
  const root = document.createElement('div');
  root.className = 'vgg';
  if (accent && /^#[0-9a-f]{6}$/i.test(accent)) root.style.setProperty('--vgg-accent', accent);
  root.innerHTML = `
    <canvas class="vgg-canvas" tabindex="0"></canvas>
    <div class="vgg-sr" aria-live="polite" data-live></div>
    <div class="vgg-intro" data-intro hidden></div>
    <div class="vgg-bar" data-bar hidden></div>
    <div class="vgg-corner" data-corner hidden>
      <button class="vgg-icon" type="button" data-act="mute" aria-label="Mute sound">${svg('sound')}</button>
      <button class="vgg-icon" type="button" data-act="pause" aria-label="Pause">${svg('pause')}</button>
    </div>
    <div class="vgg-touch" data-touch hidden></div>
    <div class="vgg-screen" data-screen hidden></div>`;
  container.appendChild(root);
  const $ = sel => root.querySelector(sel);
  const screen = $('[data-screen]');
  let handlers = {};
  let lastFocus = null;

  root.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const fn = handlers[b.dataset.act];
    if (fn) fn(b.dataset.arg, b);
  });
  // arrow keys move between the buttons of an open menu
  screen.addEventListener('keydown', e => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const items = [...screen.querySelectorAll('button:not([disabled])')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
    items[next].focus();
  });

  const api = {
    root,
    canvas: $('canvas'),
    on(map) { handlers = { ...handlers, ...map }; },
    announce(text) { const l = $('[data-live]'); l.textContent = ''; setTimeout(() => { l.textContent = text; }, 30); },
    /** Show a menu card. `html` is trusted markup built here; user text passes through esc(). */
    show(html, { wide = false, clear = false, label = 'Menu' } = {}) {
      lastFocus = document.activeElement;
      screen.innerHTML = `<div class="vgg-card ${wide ? 'is-wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(label)}">${html}</div>`;
      screen.classList.toggle('is-clear', clear);
      screen.hidden = false;
      const first = screen.querySelector('[data-autofocus]') || screen.querySelector('button:not([disabled])');
      if (first) setTimeout(() => first.focus({ preventScroll: true }), 30);
    },
    hide() { screen.hidden = true; screen.innerHTML = ''; if (lastFocus && root.contains(lastFocus)) lastFocus.focus?.({ preventScroll: true }); else api.canvas.focus({ preventScroll: true }); },
    get menuOpen() { return !screen.hidden; },
    focusedMenuButton() { return screen.contains(document.activeElement) ? document.activeElement : null; },
    moveMenuFocus(d) { const items = [...screen.querySelectorAll('button:not([disabled])')]; if (!items.length) return; const i = items.indexOf(document.activeElement); items[Math.max(0, Math.min(items.length - 1, (i < 0 ? 0 : i + d)))].focus(); },
    intro(title, meta) {
      const el = $('[data-intro]');
      el.innerHTML = `<p class="vgg-meta vgg-meta--accent" style="justify-content:center">${esc(meta)}</p><p class="vgg-h2" style="margin-top:6px">${esc(title)}</p>`;
      el.hidden = true; void el.offsetWidth; el.hidden = false;
      clearTimeout(api._introT); api._introT = setTimeout(() => { el.hidden = true; }, 2300);
    },
    bar(html) { const b = $('[data-bar]'); if (html === null) { b.hidden = true; return; } b.innerHTML = html; b.hidden = false; },
    corner(show) { $('[data-corner]').hidden = !show; },
    setMuteIcon(muted) { const b = root.querySelector('[data-act="mute"]'); if (b) { b.innerHTML = svg(muted ? 'mute' : 'sound'); b.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound'); } },
    touch: $('[data-touch]'),
    destroy() { clearTimeout(api._introT); root.remove(); },
  };
  return api;
}

/** On-screen controls for coarse pointers, wired to the input object. */
export function buildTouch(el, genre, input) {
  el.innerHTML = '';
  el.hidden = false;
  const cleanups = [];
  const btn = (label, name, cls = '', html = null) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'vgg-tbtn ' + cls;
    b.innerHTML = html || label;
    b.setAttribute('aria-label', label);
    const on = e => { e.preventDefault(); b.classList.add('is-down'); input.setVirtual(name, true); b.setPointerCapture?.(e.pointerId); };
    const off = e => { e.preventDefault(); b.classList.remove('is-down'); input.setVirtual(name, false); };
    b.addEventListener('pointerdown', on);
    b.addEventListener('pointerup', off);
    b.addEventListener('pointercancel', off);
    b.addEventListener('lostpointercapture', off);
    return b;
  };
  const stick = (side, name) => {
    const s = document.createElement('div');
    s.className = `vgg-stick vgg-stick--${side}`;
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<i></i>';
    const knob = s.firstChild;
    let id = null;
    const move = e => {
      if (e.pointerId !== id) return;
      const r = s.getBoundingClientRect();
      let x = (e.clientX - r.left - r.width / 2) / (r.width / 2), y = (e.clientY - r.top - r.height / 2) / (r.height / 2);
      const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
      knob.style.transform = `translate(${x * 36}px, ${y * 36}px)`;
      input.setStick(name, Math.hypot(x, y) > 0.2 ? { x, y } : null);
    };
    s.addEventListener('pointerdown', e => { e.preventDefault(); id = e.pointerId; s.setPointerCapture(e.pointerId); move(e); });
    s.addEventListener('pointermove', move);
    const end = e => { if (e.pointerId !== id) return; id = null; knob.style.transform = ''; input.setStick(name, null); };
    s.addEventListener('pointerup', end); s.addEventListener('pointercancel', end);
    return s;
  };
  const pad = (four = true) => {
    const p = document.createElement('div');
    p.className = 'vgg-pad' + (four ? '' : ' vgg-pad--lr');
    if (four) {
      const cells = [null, 'up', null, 'left', null, 'right', null, 'down', null];
      for (const c of cells) { if (!c) { p.appendChild(document.createElement('span')); continue; } p.appendChild(btn(c, c, '', svg(c))); }
    } else { p.appendChild(btn('left', 'left', '', svg('left'))); p.appendChild(btn('right', 'right', '', svg('right'))); }
    return p;
  };
  const acts = (...buttons) => { const a = document.createElement('div'); a.className = 'vgg-acts'; for (const b of buttons) a.appendChild(b); return a; };
  if (genre === 'platformer') {
    el.append(pad(false), acts(btn('Lever', 'action', '', 'B'), btn('Jump', 'jump', 'vgg-tbtn--main', 'A')));
  } else if (genre === 'adventure') {
    el.append(stick('left', 'move'), acts(btn('Shoot', 'fire', '', 'B'), btn('Act', 'action', 'vgg-tbtn--main', 'A')));
  } else if (genre === 'arena') {
    el.append(stick('left', 'move'), stick('right', 'aim'));
  } else if (genre === 'maze') {
    el.append(pad(true));
    // swipes anywhere steer too
    let sx = 0, sy = 0, sid = null;
    const canvas = el.parentElement.querySelector('canvas');
    const down = e => { if (e.pointerType === 'mouse') return; sid = e.pointerId; sx = e.clientX; sy = e.clientY; };
    const upH = e => {
      if (e.pointerId !== sid) return; sid = null;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.hypot(dx, dy) < 24) return;
      input.tap(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
    };
    canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointerup', upH);
    cleanups.push(() => { canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointerup', upH); });
  } else if (genre === 'puzzle') {
    const undo = btn('Undo', 'undo', '', svg('undo'));
    const restart = btn('Restart', 'restart', '', svg('restart'));
    el.append(pad(true), acts(restart, undo));
  }
  return () => { for (const c of cleanups) c(); el.innerHTML = ''; el.hidden = true; };
}

export { esc };
