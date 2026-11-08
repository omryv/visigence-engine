/**
 * The editor's grid: the level drawn through the same renderer the game uses, with the
 * editing layer on top — rulers, a crisp grid, the brush ghost, selection brackets, wires,
 * reachability, the last playtest's trace, issue badges and a minimap.
 *
 *   createViewport(host, store, art, deps) -> viewport
 *   deps: { drawScene, sceneFromLevel, getAnalysis() }
 *
 * Coordinates: the camera is { x, y, size } with `size` in device pixels per tile. Zoom is
 * shown in CSS pixels per tile (32 px = 100%). The canvas redraws only when something changed,
 * plus a gentle 24 fps clock for animated tiles and sprites while the tab is visible and the grid
 * is not paused (`setPaused`: covered by a playtest, or hidden behind the start screen).
 */
import { entityDef, footprint, tileByCode, decorByCode, genreById } from '../core/catalog.js';
import { keyHex, mapBackground, mapColor } from '../art/palette.js';

export const ZOOM_MIN = 6, ZOOM_MAX = 96;
const RULER = 22;           // CSS px
const EASE = t => 1 - Math.pow(1 - t, 3);

export function createViewport(host, store, art, deps) {
  host.classList.add('vp');
  const canvas = document.createElement('canvas');
  canvas.className = 'vp-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-roledescription', 'level grid');
  const live = document.createElement('div');
  live.className = 'sr-only';
  live.setAttribute('aria-live', 'polite');
  const mini = document.createElement('canvas');
  mini.className = 'vp-mini';
  mini.setAttribute('aria-label', 'Minimap: drag to move the view');
  mini.setAttribute('role', 'img');
  const chip = document.createElement('div');
  chip.className = 'vp-chip meta';
  const zoomBox = document.createElement('div');
  zoomBox.className = 'vp-zoom';
  zoomBox.innerHTML = `<button type="button" class="icon-btn icon-btn--sm" data-z="out" aria-label="Zoom out" title="Zoom out (−)"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button><button type="button" class="vp-zoom__pct meta" data-z="fit" title="Whole level or close-up (0)">100%</button><button type="button" class="icon-btn icon-btn--sm" data-z="in" aria-label="Zoom in" title="Zoom in (+)"><svg viewBox="0 0 24 24"><path d="M5 12h14M12 5v14"/></svg></button>`;
  host.append(canvas, mini, chip, zoomBox, live);
  const ctx = canvas.getContext('2d');
  const mctx = mini.getContext('2d');

  let W = 1, H = 1, dpr = 1;
  const cam = { x: -1, y: -1, size: 32 };
  let scene = null, sceneLevel = null;
  let needs = true, raf = 0, destroyed = false, paused = false, t0 = performance.now(), lastAnim = 0;
  let zoomAnim = null;
  let colors = readColors();
  let showMini = true;
  const flashes = [];
  const vp = {
    canvas, host,
    hover: null,          // {x, y}
    cursor: null,         // keyboard cell cursor {x, y}
    ghost: null,          // { cells: [[x,y]], kind: 'tile'|'decor'|'entity'|'erase'|'region', id, label, bad }
    marquee: null,        // {x, y, w, h}
    moveOffset: null,     // {dx, dy} while dragging a selection
    wire: null,           // { from: entity, to: {x, y} (cell float), target: entity|null, ok }
    get zoom() { return Math.round(cam.size / dpr); },
    get cam() { return cam; },
  };

  // ------------------------------------------------------------------ sizing
  function resize() {
    const r = host.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    const old = { W, H, size: cam.size };
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    canvas.style.width = r.width + 'px'; canvas.style.height = r.height + 'px';
    // keep the view centre where it was
    if (old.W > 1) {
      const cx = cam.x + old.W / old.size / 2, cy = cam.y + old.H / old.size / 2;
      W = w; H = h;
      cam.x = cx - W / cam.size / 2; cam.y = cy - H / cam.size / 2;
    } else { W = w; H = h; }
    const mw = Math.min(180, Math.max(120, r.width * 0.18));
    mini.width = Math.round(mw * dpr); mini.height = Math.round(mw * 0.62 * dpr);
    mini.style.width = mw + 'px'; mini.style.height = (mw * 0.62) + 'px';
    vp.redraw();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  // ------------------------------------------------------------------ camera
  const level = () => store.level;
  function clampCam() {
    const l = level();
    const vw = W / cam.size, vh = H / cam.size;
    const mx = Math.max(4, vw * 0.4), my = Math.max(4, vh * 0.4);
    cam.x = Math.max(-mx - RULER * dpr / cam.size, Math.min(l.width + mx - vw, cam.x));
    cam.y = Math.max(-my - RULER * dpr / cam.size, Math.min(l.height + my - vh, cam.y));
  }
  /**
   * 'home' (default): the whole level when it fits at a workable size, else a close view at the
   * player start (a side-on level fills the height and scrolls sideways). 'all': the whole level,
   * however small. `vp.fit(true)` toggles between the two, which is what 0 and the zoom label do.
   */
  let fitMode = 'home';
  vp.fit = (animate = false, mode) => {
    const l = level();
    mode = mode || (animate ? (fitMode === 'all' ? 'home' : 'all') : 'home');
    fitMode = mode;
    const aw = W / dpr - RULER - 24, ah = H / dpr - RULER - 24;
    const whole = Math.floor(Math.min(aw / l.width, ah / l.height));
    const HOME_MIN = 18;
    let css, cx = l.width / 2, cy = l.height / 2;
    if (mode === 'all' || whole >= HOME_MIN) css = Math.max(ZOOM_MIN, Math.min(64, whole));
    else {
      css = store.view === 'side' ? Math.max(HOME_MIN, Math.min(40, Math.floor(ah / l.height))) : HOME_MIN;
      const p = l.entities.find(e => e.type === 'player');
      if (p) { cx = p.x + 0.5 + (store.view === 'side' ? (aw / css) * 0.3 : 0); cy = store.view === 'side' ? l.height / 2 : p.y + 0.5; }
      // keep the level filling the view where it is bigger than the view
      const vw = (W / dpr - RULER) / css, vh = (H / dpr - RULER) / css;
      cx = l.width > vw ? Math.max(vw / 2 - 0.5, Math.min(l.width - vw / 2 + 0.5, cx)) : l.width / 2;
      cy = l.height > vh ? Math.max(vh / 2 - 0.5, Math.min(l.height - vh / 2 + 0.5, cy)) : l.height / 2;
    }
    const size = Math.round(css * dpr);
    const target = { size, x: cx - (W + RULER * dpr) / size / 2 + RULER * dpr / size, y: cy - (H + RULER * dpr) / size / 2 + RULER * dpr / size };
    if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) startZoom(target); else { Object.assign(cam, target); zoomAnim = null; clampCam(); vp.redraw(); }
  };
  function startZoom(target) {
    zoomAnim = { from: { ...cam }, to: target, t: 0, start: performance.now() };
    vp.redraw();
  }
  /** Zoom by a factor about a point in CSS px (default: the view centre). */
  vp.zoomBy = (f, px = null, py = null, animate = true) => {
    const css = cam.size / dpr;
    const nextCss = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(css * f)));
    if (nextCss === Math.round(css) && !zoomAnim) return;
    vp.zoomTo(nextCss, px, py, animate);
  };
  vp.zoomTo = (css, px = null, py = null, animate = true) => {
    const ax = (px ?? W / dpr / 2) * dpr, ay = (py ?? H / dpr / 2) * dpr;
    const base = zoomAnim ? zoomAnim.to : cam;
    const wx = base.x + ax / base.size, wy = base.y + ay / base.size;
    const size = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, css)) * dpr);
    const target = { size, x: wx - ax / size, y: wy - ay / size };
    if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) startZoom(target);
    else { Object.assign(cam, target); zoomAnim = null; clampCam(); vp.redraw(); }
  };
  vp.panBy = (dxCss, dyCss) => { cam.x -= (dxCss * dpr) / cam.size; cam.y -= (dyCss * dpr) / cam.size; if (zoomAnim) { zoomAnim.to.x -= (dxCss * dpr) / zoomAnim.to.size; zoomAnim.to.y -= (dyCss * dpr) / zoomAnim.to.size; } clampCam(); vp.redraw(); };
  vp.centerOn = (x, y, opts = {}) => {
    const target = { size: cam.size, x: x + 0.5 - W / cam.size / 2, y: y + 0.5 - H / cam.size / 2 };
    if (opts.animate !== false && !matchMedia('(prefers-reduced-motion: reduce)').matches) startZoom(target); else { Object.assign(cam, target); vp.redraw(); }
    if (opts.flash) vp.flash(x, y);
  };
  vp.flash = (x, y) => { flashes.push({ x, y, t: performance.now() }); vp.redraw(); };
  vp.screenToCell = (clientX, clientY) => {
    const r = canvas.getBoundingClientRect();
    const px = (clientX - r.left) * dpr, py = (clientY - r.top) * dpr;
    return { x: Math.floor(cam.x + px / cam.size), y: Math.floor(cam.y + py / cam.size), fx: cam.x + px / cam.size, fy: cam.y + py / cam.size };
  };
  vp.cellInside = c => { const l = level(); return c && c.x >= 0 && c.y >= 0 && c.x < l.width && c.y < l.height; };
  vp.inRuler = (clientX, clientY) => { const r = canvas.getBoundingClientRect(); return clientX - r.left < RULER || clientY - r.top < RULER; };
  vp.setMinimap = on => { showMini = on; mini.hidden = !on; vp.redraw(); };
  vp.redraw = () => { needs = true; if (!raf && !destroyed) raf = requestAnimationFrame(frame); };
  /** Stop the animation clock while nobody can see the grid; changes still draw once. */
  vp.setPaused = on => { paused = !!on; if (!paused) vp.redraw(); };
  vp.refreshColors = () => { colors = readColors(); vp.redraw(); };
  vp.invalidate = () => { scene = null; vp.redraw(); };

  // ------------------------------------------------------------------ the frame
  function frame(now) {
    raf = 0;
    if (destroyed) return;
    let animating = false;
    if (zoomAnim) {
      const k = Math.min(1, (now - zoomAnim.start) / 240);
      const e = EASE(k), a = zoomAnim.from, b = zoomAnim.to;
      // interpolate in screen space so the zoom anchor stays put
      const s = a.size + (b.size - a.size) * e;
      const ax = a.x * a.size, bx = b.x * b.size, ay = a.y * a.size, by = b.y * b.size;
      cam.size = s;
      cam.x = (ax + (bx - ax) * e) / s;
      cam.y = (ay + (by - ay) * e) / s;
      if (k >= 1) { Object.assign(cam, b); zoomAnim = null; clampCam(); }
      animating = true;
    }
    if (flashes.length) animating = true;
    const t = (now - t0) / 1000;
    const idle = !paused && !document.hidden;
    const tick = idle && now - lastAnim > 1000 / 24;
    if (needs || animating || tick) {
      needs = false;
      lastAnim = now;
      draw(t);
    }
    if (animating || idle) raf = requestAnimationFrame(frame);
  }

  function ensureScene() {
    const l = level();
    if (!scene || sceneLevel !== l) { scene = deps.sceneFromLevel(store.project, store.state.levelIndex, 0); sceneLevel = l; }
    return scene;
  }

  function draw(t) {
    const l = level();
    const size = cam.size;
    const st = store.state;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = colors.cyc;
    ctx.fillRect(0, 0, W, H);
    const sc = ensureScene();
    const ox = -cam.x * size, oy = -cam.y * size;
    const lx = Math.round(ox), ly = Math.round(oy), lw = Math.round(l.width * size), lh = Math.round(l.height * size);
    // the level, clipped to its bounds (outside is the cyclorama)
    ctx.save();
    ctx.beginPath(); ctx.rect(lx, ly, lw, lh); ctx.clip();
    const moving = vp.moveOffset && st.selection.ids.length;
    const hidden = moving ? new Set(st.selection.ids) : null;
    const drawn = hidden ? { ...sc, entities: sc.entities.filter(e => !hidden.has(e.id)), player: sc.player && hidden.has(sc.player.id) ? null : sc.player } : sc;
    deps.drawScene(ctx, drawn, { x: cam.x, y: cam.y, size }, art, {
      width: W, height: H, t, editor: true,
      terrain: st.visible.terrain, decor: st.visible.decor, entities: st.visible.entities,
    });
    ctx.restore();

    const S = n => n * size;            // tiles -> device px
    const px = x => Math.round(ox + x * size), py = y => Math.round(oy + y * size);
    const x0 = Math.max(0, Math.floor(cam.x)), y0 = Math.max(0, Math.floor(cam.y));
    const x1 = Math.min(l.width, Math.ceil(cam.x + W / size)), y1 = Math.min(l.height, Math.ceil(cam.y + H / size));

    // reachability tint
    const an = deps.getAnalysis();
    if (st.overlays.reach && an?.reach && an.reach.length === l.width * l.height) {
      // shade what the player can never reach, and outline the edge of what they can
      const R = an.reach, at = (x, y) => x >= 0 && y >= 0 && x < l.width && y < l.height && R[y * l.width + x];
      ctx.fillStyle = 'rgba(8, 9, 10, 0.5)';
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (!R[y * l.width + x]) ctx.fillRect(px(x), py(y), Math.ceil(size), Math.ceil(size));
      ctx.beginPath();
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        if (!R[y * l.width + x]) continue;
        const X = px(x), Y = py(y), S = size;
        if (!at(x, y - 1)) { ctx.moveTo(X, Y); ctx.lineTo(X + S, Y); }
        if (!at(x, y + 1)) { ctx.moveTo(X, Y + S); ctx.lineTo(X + S, Y + S); }
        if (!at(x - 1, y)) { ctx.moveTo(X, Y); ctx.lineTo(X, Y + S); }
        if (!at(x + 1, y)) { ctx.moveTo(X + S, Y); ctx.lineTo(X + S, Y + S); }
      }
      ctx.strokeStyle = colors.peaking; ctx.lineWidth = Math.max(1.5, dpr * 1.5); ctx.stroke();
    }
    // grid
    if (st.overlays.grid) {
      ctx.lineWidth = 1;
      if (size / dpr >= 10) {
        // cell lines only when cells are big enough to read; the 8-cell lines always
        ctx.beginPath();
        for (let x = x0; x <= x1; x++) { if (x % 8 === 0) continue; const X = px(x) + 0.5; ctx.moveTo(X, py(y0)); ctx.lineTo(X, py(y1)); }
        for (let y = y0; y <= y1; y++) { if (y % 8 === 0) continue; const Y = py(y) + 0.5; ctx.moveTo(px(x0), Y); ctx.lineTo(px(x1), Y); }
        ctx.strokeStyle = colors.gridMinor; ctx.stroke();
      }
      ctx.beginPath();
      for (let x = Math.ceil(x0 / 8) * 8; x <= x1; x += 8) { const X = px(x) + 0.5; ctx.moveTo(X, py(y0)); ctx.lineTo(X, py(y1)); }
      for (let y = Math.ceil(y0 / 8) * 8; y <= y1; y += 8) { const Y = py(y) + 0.5; ctx.moveTo(px(x0), Y); ctx.lineTo(px(x1), Y); }
      ctx.strokeStyle = colors.gridMajor; ctx.stroke();
    }
    // level bounds
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeStyle = colors.lineStrong;
    ctx.strokeRect(lx - 0.5, ly - 0.5, lw + 1, lh + 1);

    // the trace of the last playtest on this level
    const tr = st.trace;
    if (st.overlays.trace && tr && tr.levelId === l.id && tr.points.length > 1) drawTrace(tr, S, ox, oy);

    // guides for the selected (or hovered) parts: tracks, ranges, aim lines, key-door hints
    const sel = new Set(st.selection.ids);
    const hoverEnt = vp.hover ? store.entityAt(vp.hover.x, vp.hover.y) : null;
    for (const e of l.entities) if (sel.has(e.id) || e === hoverEnt) guides(e, S, ox, oy);

    // wires
    if (st.overlays.links) drawWires(l, sel, S, ox, oy);
    if (vp.wire) {
      const a = vp.wire.from, fa = footprint(a);
      const ax = ox + (a.x + fa.w / 2) * size, ay = oy + (a.y + fa.h / 2) * size;
      const bx = ox + vp.wire.to.x * size, by = oy + vp.wire.to.y * size;
      wire(ax, ay, bx, by, vp.wire.target ? (vp.wire.ok ? colors.peaking : colors.tally) : colors.peaking, true);
      // highlight valid targets
      for (const e of l.entities) {
        const d = entityDef(e.type);
        if (!d?.linkTarget || e.id === a.id) continue;
        const f = footprint(e);
        ctx.save(); ctx.setLineDash([4 * dpr, 3 * dpr]); ctx.strokeStyle = colors.peaking; ctx.lineWidth = 1.5 * dpr;
        ctx.strokeRect(px(e.x) + 2, py(e.y) + 2, S(f.w) - 4, S(f.h) - 4); ctx.restore();
      }
    }

    // issues
    if (st.overlays.issues && an?.issues) {
      for (const is of an.issues) {
        if (!is.at || is.severity === 'tip') continue;
        const bx = px(is.at.x) + S(1) - 7 * dpr, by = py(is.at.y) + 7 * dpr;
        ctx.beginPath(); ctx.arc(bx, by, 6.5 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = is.severity === 'error' ? colors.tally : colors.zebra; ctx.fill();
        ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = colors.cyc; ctx.stroke();
        ctx.fillStyle = colors.onSignal; ctx.font = `700 ${9 * dpr}px ${colors.mono}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('!', bx, by + 0.5 * dpr);
      }
      ctx.textAlign = 'start';
    }

    // selected entities: viewfinder brackets (and their dragged ghosts)
    for (const e of l.entities) {
      if (!sel.has(e.id)) continue;
      const f = footprint(e);
      const dx = vp.moveOffset?.dx || 0, dy = vp.moveOffset?.dy || 0;
      if (moving) {
        const box = sceneBox(e, dx, dy);
        ctx.globalAlpha = 0.85;
        art.entity(ctx, { ...box.ent }, box.px, size, { biome: l.biome, time: l.time, view: store.view, t, editor: true, genre: store.genre });
        ctx.globalAlpha = 1;
      }
      brackets(px(e.x + dx), py(e.y + dy), S(f.w), S(f.h), colors.peaking);
    }
    // region selection
    const reg = st.selection.region || vp.marquee;
    if (reg && reg.w > 0 && reg.h > 0) {
      ctx.save();
      ctx.fillStyle = colors.peakingA;
      ctx.fillRect(px(reg.x), py(reg.y), S(reg.w), S(reg.h));
      ctx.setLineDash([6 * dpr, 4 * dpr]); ctx.lineDashOffset = -((t * 20) % 10) * dpr;
      ctx.strokeStyle = colors.peaking; ctx.lineWidth = 1.5 * dpr;
      ctx.strokeRect(px(reg.x) + 0.5, py(reg.y) + 0.5, S(reg.w) - 1, S(reg.h) - 1);
      ctx.restore();
      label(`${reg.w} × ${reg.h}`, px(reg.x), py(reg.y) - 6 * dpr);
    }

    // the brush ghost
    const g = vp.ghost;
    if (g && g.cells?.length) {
      ctx.save();
      if (g.kind === 'erase' || g.bad) {
        ctx.fillStyle = colors.tallyA;
        for (const [x, y] of g.cells) ctx.fillRect(px(x), py(y), Math.ceil(size), Math.ceil(size));
      } else if (g.kind === 'tile' || g.kind === 'decor') {
        ctx.globalAlpha = 0.6;
        const at = (dx, dy) => 0;
        for (const [x, y] of g.cells.slice(0, 1500)) {
          if (x < 0 || y < 0 || x >= l.width || y >= l.height) continue;
          const info = { biome: l.biome, time: l.time, view: store.view, t, x, y, at, toggle: false, crumble: 0 };
          if (g.kind === 'tile') { if (g.id) art.tile(ctx, g.id, px(x), py(y), Math.round(size), info); }
          else if (g.id) art.decor(ctx, g.id, px(x), py(y), Math.round(size), info);
        }
        ctx.globalAlpha = 1;
      } else if (g.kind === 'entity' && g.id) {
        ctx.globalAlpha = 0.6;
        for (const [x, y] of g.cells.slice(0, 400)) {
          const box = sceneBox({ type: g.id, x, y, props: g.props || {} }, 0, 0);
          art.entity(ctx, box.ent, box.px, size, { biome: l.biome, time: l.time, view: store.view, t, editor: true, genre: store.genre });
        }
        ctx.globalAlpha = 1;
      }
      // outline the footprint
      ctx.strokeStyle = g.kind === 'erase' || g.bad ? colors.tally : colors.peaking;
      ctx.lineWidth = 1.5 * dpr;
      if (g.rect) ctx.strokeRect(px(g.rect.x) + 0.5, py(g.rect.y) + 0.5, S(g.rect.w) - 1, S(g.rect.h) - 1);
      else if (g.cells.length <= 25) for (const [x, y] of g.cells) ctx.strokeRect(px(x) + 0.5, py(y) + 0.5, S(1) - 1, S(1) - 1);
      ctx.restore();
      if (g.label) label(g.label, px(g.rect ? g.rect.x : g.cells[0][0]), py(g.rect ? g.rect.y : g.cells[0][1]) - 6 * dpr);
    } else if (vp.hover && vp.cellInside(vp.hover)) {
      ctx.strokeStyle = colors.peaking; ctx.lineWidth = 1.5 * dpr;
      ctx.strokeRect(px(vp.hover.x) + 0.5, py(vp.hover.y) + 0.5, S(1) - 1, S(1) - 1);
    }
    // keyboard cursor
    if (vp.cursor && document.activeElement === canvas) {
      ctx.save(); ctx.setLineDash([3 * dpr, 3 * dpr]); ctx.strokeStyle = colors.peaking; ctx.lineWidth = 2 * dpr;
      ctx.strokeRect(px(vp.cursor.x) + 1, py(vp.cursor.y) + 1, S(1) - 2, S(1) - 2); ctx.restore();
    }
    // flashes (jump-to-issue)
    const now = performance.now();
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i], k = (now - f.t) / 900;
      if (k >= 1) { flashes.splice(i, 1); continue; }
      ctx.save(); ctx.globalAlpha = 1 - k; ctx.strokeStyle = colors.peaking; ctx.lineWidth = 2 * dpr;
      const r = size * (0.6 + k * 1.4);
      ctx.beginPath(); ctx.arc(px(f.x) + size / 2, py(f.y) + size / 2, r, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }
    rulers(l);
    if (showMini) drawMini(l);
    chipText();
  }

  function sceneBox(src, dx, dy) {
    const sc = ensureScene();
    const view = sc.view;
    const def = entityDef(src.type);
    const f = footprint(src);
    const full = sc.entities.concat(sc.player ? [sc.player] : []).find(e => e.id === src.id);
    const base = full || { type: src.type, props: src.props || {}, facing: -1, dir: 'down', anim: 'idle', animTime: 0, alive: true, active: false, open: false, hp: 1, maxHp: 1, data: {}, cell: { x: src.x, y: src.y } };
    // same anchoring as the scene: body inside the footprint
    const bw = full ? full.w : f.w, bh = full ? full.h : f.h;
    const bx = full ? full.x - src.x : 0, by = full ? full.y - src.y : 0;
    const size = cam.size;
    const x = src.x + dx + bx, y = src.y + dy + by;
    void def; void view;
    return { ent: { ...base, props: src.props || base.props }, px: { x: -cam.x * size + x * size, y: -cam.y * size + y * size, w: bw * size, h: bh * size } };
  }

  function brackets(x, y, w, h, color) {
    const a = Math.min(14 * dpr, w / 2.5, h / 2.5 + 4), o = 3 * dpr;
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 2 * dpr; ctx.lineCap = 'square';
    ctx.beginPath();
    ctx.moveTo(x - o, y - o + a); ctx.lineTo(x - o, y - o); ctx.lineTo(x - o + a, y - o);
    ctx.moveTo(x + w + o - a, y - o); ctx.lineTo(x + w + o, y - o); ctx.lineTo(x + w + o, y - o + a);
    ctx.moveTo(x + w + o, y + h + o - a); ctx.lineTo(x + w + o, y + h + o); ctx.lineTo(x + w + o - a, y + h + o);
    ctx.moveTo(x - o + a, y + h + o); ctx.lineTo(x - o, y + h + o); ctx.lineTo(x - o, y + h + o - a);
    ctx.stroke(); ctx.restore();
  }
  function label(text, x, y) {
    ctx.save();
    ctx.font = `800 ${10.5 * dpr}px ${colors.mono}`;
    const w = ctx.measureText(text).width + 10 * dpr, h = 17 * dpr;
    const bx = Math.max(RULER * dpr + 2, x), by = Math.max(RULER * dpr + 2, y - h);
    ctx.fillStyle = colors.peaking; roundRect(bx, by, w, h, 3 * dpr); ctx.fill();
    ctx.fillStyle = colors.onSignal; ctx.textBaseline = 'middle'; ctx.fillText(text, bx + 5 * dpr, by + h / 2 + 0.5);
    ctx.restore();
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  function wire(ax, ay, bx, by, color, live = false, emphasis = false) {
    const dx = bx - ax, dy = by - ay;
    const bend = Math.min(160 * dpr, Math.hypot(dx, dy) * 0.35);
    const c1x = ax + bend * Math.sign(dx || 1), c1y = ay, c2x = bx - bend * Math.sign(dx || 1), c2y = by;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = (emphasis ? 3 : 2) * dpr;
    if (live) ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.bezierCurveTo(c1x, c1y, c2x, c2y, bx, by); ctx.stroke();
    ctx.setLineDash([]);
    // ports and an arrowhead at the target
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(ax, ay, 3.5 * dpr, 0, Math.PI * 2); ctx.fill();
    const ang = Math.atan2(by - c2y, bx - c2x);
    const s = 7 * dpr;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx - Math.cos(ang - 0.45) * s, by - Math.sin(ang - 0.45) * s); ctx.lineTo(bx - Math.cos(ang + 0.45) * s, by - Math.sin(ang + 0.45) * s); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  function drawWires(l, sel, S, ox, oy) {
    const byId = new Map(l.entities.map(e => [e.id, e]));
    for (const k of l.links) {
      const a = byId.get(k.from), b = byId.get(k.to);
      if (!a || !b) continue;
      const fa = footprint(a), fb = footprint(b);
      const emph = sel.has(a.id) || sel.has(b.id);
      const ax = ox + (a.x + fa.w / 2) * cam.size, ay = oy + (a.y + fa.h / 2) * cam.size;
      const bx = ox + (b.x + fb.w / 2) * cam.size, by = oy + (b.y + fb.h / 2) * cam.size;
      ctx.globalAlpha = emph || !sel.size ? 1 : 0.45;
      wire(ax, ay, bx, by, colors.peaking, false, emph);
      ctx.globalAlpha = 1;
    }
  }
  /** Where a selected part will go: platform tracks, bee flight ranges, cannon aim, key-gate pairs. */
  function guides(e, S, ox, oy) {
    const l = level();
    const size = cam.size;
    const f = footprint(e);
    ctx.save();
    ctx.setLineDash([5 * dpr, 4 * dpr]);
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = colors.peaking;
    const x = ox + e.x * size, y = oy + e.y * size;
    if (e.type === 'platform') {
      const d = e.props.distance || 5;
      if (e.props.axis === 'y') ctx.strokeRect(x + 1, y + 1, S(f.w) - 2, S(d + 1) - 2); else ctx.strokeRect(x + 1, y + 1, S(f.w + d) - 2, S(1) - 2);
    } else if (e.type === 'bee' && store.view === 'side') {
      const r = e.props.range || 3;
      if (e.props.axis === 'x') ctx.strokeRect(x - S(r), y + 1, S(r * 2 + 1), S(1) - 2);
      else if (e.props.axis === 'y') ctx.strokeRect(x + 1, y - S(r), S(1) - 2, S(r * 2 + 1));
    } else if ((e.type === 'bee' && e.props.radius) || e.type === 'spirit') {
      const r = e.type === 'spirit' ? 8 : e.props.radius;
      ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, S(r), 0, Math.PI * 2); ctx.stroke();
    } else if (e.type === 'turret' && e.props.dir !== 'player') {
      const dir = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[e.props.dir || 'left'];
      const cx = x + size / 2, cy = y + size / 2;
      let n = 1;
      while (n < 40) { const tx = e.x + dir[0] * n, ty = e.y + dir[1] * n; if (tx < 0 || ty < 0 || tx >= l.width || ty >= l.height) break; const c = l.terrain[ty * l.width + tx]; if (c && tileByCode(c)?.solid) break; n++; }
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + dir[0] * S(n - 0.5), cy + dir[1] * S(n - 0.5)); ctx.stroke();
    } else if (e.type === 'spring') {
      const p = e.props.power || 7;
      ctx.beginPath(); ctx.moveTo(x + size / 2, y); ctx.lineTo(x + size / 2, y - S(p)); ctx.stroke();
    }
    // key <-> gate colour hints
    const color = e.type === 'key' ? e.props.color : e.type === 'door' ? e.props.lock : null;
    if (color && color !== 'none') {
      ctx.strokeStyle = keyHex(color);
      for (const o of l.entities) {
        const oc = o.type === 'key' ? o.props.color : o.type === 'door' ? o.props.lock : null;
        if (o === e || oc !== color || o.type === e.type) continue;
        ctx.beginPath(); ctx.moveTo(x + size / 2, y + size / 2); ctx.lineTo(ox + (o.x + 0.5) * size, oy + (o.y + 0.5) * size); ctx.stroke();
      }
    }
    ctx.restore();
  }
  function drawTrace(tr, S, ox, oy) {
    const pts = tr.points;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.lineWidth = 3 * dpr;
    for (let i = 1; i < pts.length; i++) {
      const k = i / pts.length;
      ctx.strokeStyle = `rgba(255, 159, 69, ${0.25 + 0.6 * k})`;
      ctx.beginPath(); ctx.moveTo(ox + pts[i - 1][0] * cam.size, oy + pts[i - 1][1] * cam.size); ctx.lineTo(ox + pts[i][0] * cam.size, oy + pts[i][1] * cam.size); ctx.stroke();
    }
    const [sx, sy] = pts[0], [ex, ey] = pts[pts.length - 1];
    ctx.fillStyle = colors.tungsten; ctx.beginPath(); ctx.arc(ox + sx * cam.size, oy + sy * cam.size, 5 * dpr, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = tr.status === 'won' ? colors.success : colors.tungsten; ctx.lineWidth = 2.5 * dpr;
    ctx.beginPath(); ctx.arc(ox + ex * cam.size, oy + ey * cam.size, 7 * dpr, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = colors.tally; ctx.lineWidth = 3 * dpr;
    for (const d of tr.deaths || []) {
      const cx = ox + d.x * cam.size, cy = oy + d.y * cam.size, r = 7 * dpr;
      ctx.beginPath(); ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r); ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r); ctx.stroke();
    }
    ctx.restore();
  }

  function rulers(l) {
    const R = RULER * dpr, size = cam.size;
    ctx.save();
    ctx.fillStyle = colors.surface; ctx.fillRect(0, 0, W, R); ctx.fillRect(0, 0, R, H);
    ctx.fillStyle = colors.line; ctx.fillRect(0, R - dpr, W, dpr); ctx.fillRect(R - dpr, 0, dpr, H);
    const css = size / dpr;
    const step = css >= 40 ? 1 : css >= 22 ? 2 : css >= 14 ? 4 : 8;
    ctx.font = `800 ${9.5 * dpr}px ${colors.mono}`;
    ctx.textBaseline = 'middle';
    const hx0 = Math.max(0, Math.floor(cam.x)), hx1 = Math.min(l.width, Math.ceil(cam.x + W / size));
    for (let x = hx0; x < hx1; x++) {
      const X = Math.round((x - cam.x) * size);
      if (X < R - size) continue;
      const hot = vp.hover && vp.hover.x === x;
      if (hot) { ctx.fillStyle = colors.peakingA; ctx.fillRect(X, 0, size, R - dpr); }
      if (x % step === 0 || hot) { ctx.fillStyle = hot ? colors.peaking : colors.muted; ctx.textAlign = 'center'; ctx.fillText(String(x), X + size / 2, R / 2 + dpr); }
      else { ctx.fillStyle = colors.line; ctx.fillRect(X, R - 5 * dpr, dpr, 4 * dpr); }
    }
    const vy0 = Math.max(0, Math.floor(cam.y)), vy1 = Math.min(l.height, Math.ceil(cam.y + H / size));
    for (let y = vy0; y < vy1; y++) {
      const Y = Math.round((y - cam.y) * size);
      if (Y < R - size) continue;
      const hot = vp.hover && vp.hover.y === y;
      if (hot) { ctx.fillStyle = colors.peakingA; ctx.fillRect(0, Y, R - dpr, size); }
      if (y % step === 0 || hot) { ctx.fillStyle = hot ? colors.peaking : colors.muted; ctx.textAlign = 'center'; ctx.fillText(String(y), R / 2, Y + size / 2 + dpr); }
      else { ctx.fillStyle = colors.line; ctx.fillRect(R - 5 * dpr, Y, 4 * dpr, dpr); }
    }
    ctx.fillStyle = colors.surface; ctx.fillRect(0, 0, R, R);
    ctx.restore();
  }

  function drawMini(l) {
    const mw = mini.width, mh = mini.height;
    const s = Math.min((mw - 8) / l.width, (mh - 8) / l.height);
    const ox = (mw - l.width * s) / 2, oy = (mh - l.height * s) / 2;
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.fillStyle = colors.surface; mctx.fillRect(0, 0, mw, mh);
    mctx.fillStyle = mapBackground(l.biome, store.view);
    mctx.fillRect(ox, oy, l.width * s, l.height * s);
    const cw = Math.max(1, s);
    for (let y = 0; y < l.height; y++) for (let x = 0; x < l.width; x++) {
      const c = l.terrain[y * l.width + x];
      if (!c) continue;
      mctx.fillStyle = mapColor(c, l.biome, store.view);
      mctx.fillRect(ox + x * s, oy + y * s, cw, cw);
    }
    for (const e of l.entities) {
      const d = entityDef(e.type);
      mctx.fillStyle = e.type === 'player' ? colors.tungsten : d?.enemy ? colors.tally : e.type === 'goal' ? colors.success : colors.peaking;
      const r = Math.max(1.5 * dpr, s * 0.8);
      mctx.fillRect(ox + (e.x + 0.5) * s - r / 2, oy + (e.y + 0.5) * s - r / 2, r, r);
    }
    // the view rectangle
    mctx.strokeStyle = colors.ink; mctx.lineWidth = 1.5 * dpr;
    mctx.strokeRect(ox + cam.x * s, oy + cam.y * s, (W / cam.size) * s, (H / cam.size) * s);
    vp._mini = { ox, oy, s };
  }
  // minimap navigation
  let miniDrag = false;
  const miniMove = e => {
    const m = vp._mini; if (!m) return;
    const r = mini.getBoundingClientRect();
    const x = ((e.clientX - r.left) * dpr - m.ox) / m.s, y = ((e.clientY - r.top) * dpr - m.oy) / m.s;
    cam.x = x - W / cam.size / 2; cam.y = y - H / cam.size / 2; zoomAnim = null; clampCam(); vp.redraw();
  };
  mini.addEventListener('pointerdown', e => { miniDrag = true; mini.setPointerCapture(e.pointerId); miniMove(e); });
  mini.addEventListener('pointermove', e => { if (miniDrag) miniMove(e); });
  mini.addEventListener('pointerup', () => { miniDrag = false; });

  zoomBox.addEventListener('click', e => {
    const b = e.target.closest('[data-z]');
    if (!b) return;
    if (b.dataset.z === 'in') vp.zoomBy(1.25);
    else if (b.dataset.z === 'out') vp.zoomBy(0.8);
    else vp.fit(true);
    canvas.focus({ preventScroll: true });
  });

  function chipText() {
    const pct = Math.round(((cam.size / dpr) / 32) * 100);
    zoomBox.querySelector('.vp-zoom__pct').textContent = pct + '%';
    const c = vp.hover || vp.cursor;
    const l = level();
    if (!c || !vp.cellInside(c)) { chip.textContent = `${l.width} × ${l.height} · ${genreById(store.genre).name}`; return; }
    chip.textContent = describe(c);
  }
  function describe(c) {
    const l = level();
    const i = c.y * l.width + c.x;
    const t = l.terrain[i], d = l.decor[i];
    const e = store.entityAt(c.x, c.y);
    const parts = [`X ${c.x}`, `Y ${c.y}`];
    parts.push(t ? tileByCode(t)?.name : store.view === 'side' ? 'Air' : 'Ground');
    if (d) parts.push(decorByCode(d)?.name);
    if (e) parts.push(entityDef(e.type)?.name);
    return parts.filter(Boolean).join(' · ');
  }
  vp.describe = describe;
  vp.announce = c => { live.textContent = describe(c); };

  // ------------------------------------------------------------------ store wiring
  const offs = [
    store.on('level', () => { scene = null; vp.redraw(); }),
    store.on('levels', () => { scene = null; }),
    store.on('selection', vp.redraw),
    store.on('view', vp.redraw),
    store.on('trace', vp.redraw),
    store.on('layer', vp.redraw),
  ];
  let lastLevelId = null;
  const onLevelSwitch = () => { if (store.level.id !== lastLevelId) { lastLevelId = store.level.id; requestAnimationFrame(() => vp.fit()); } };
  offs.push(store.on('levels', onLevelSwitch), store.on('project', onLevelSwitch));
  vp.destroy = () => { destroyed = true; cancelAnimationFrame(raf); ro.disconnect(); offs.forEach(f => f()); host.innerHTML = ''; };
  vp.onLevelSwitch = onLevelSwitch;
  requestAnimationFrame(() => { resize(); lastLevelId = store.level.id; vp.fit(); });
  return vp;

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, f) => (cs.getPropertyValue(n).trim() || f);
    const peaking = v('--peaking', '#b7a3ff');
    return {
      cyc: v('--surface-000', '#0c0e33'), surface: v('--surface-100', '#151a4d'), line: v('--line', '#313a8a'), lineStrong: v('--line-strong', '#8d96e8'),
      ink: v('--ink', '#f4f5ff'), muted: v('--ink-muted', '#b3b9ee'), peaking, tungsten: v('--tungsten', '#ffc933'), tally: v('--tally', '#ff7da0'),
      zebra: v('--zebra', '#ffd24a'), success: v('--success', '#5ee3a1'), onSignal: v('--on-signal', '#0c0e33'),
      peakingA: hexA(peaking, 0.16), tallyA: hexA(v('--tally', '#ff7da0'), 0.28),
      gridMinor: v('--grid-minor', 'rgba(8, 9, 10, 0.16)'), gridMajor: v('--grid-major', 'rgba(8, 9, 10, 0.34)'),
      mono: v('--font-label', 'ui-rounded, system-ui, sans-serif'),
    };
  }
}

function hexA(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(183, 163, 255, ${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
