/**
 * What the pointer and the keyboard do to the grid, per tool. Every edit goes through the
 * store; a drag is wrapped in begin()/end() so one stroke is one undo step.
 *
 *   select V   click a part to select it (shift adds), drag to move, drag on empty ground for a
 *              region; Ctrl/⌘ C X V D, Delete, arrows nudge, F flips, Esc clears
 *   brush B    paint the active layer (1–5 cells, [ and ]); shift-click draws a line
 *   rect U     drag a rectangle of the brush
 *   fill G     paint-bucket the region under the pointer (tile layers)
 *   erase E    clear cells or parts (right-drag erases with any tool)
 *   pick I     take the brush from what is under the pointer (Alt-click with any tool)
 *   wire L     drag from a lever, plate or burrow to what it should drive; click a wire to cut it
 *   hand H     pan (Space-drag, middle-drag and two fingers pan with any tool)
 *
 * Wheel pans; Ctrl/⌘-wheel and trackpad pinch zoom about the pointer; + and − zoom; 0 fits.
 * With the grid focused and nothing selected, the arrow keys move a cell cursor and Enter
 * applies the tool there, so every tool works from the keyboard.
 */
import { entityDef, footprint, canLink, tileByCode } from '../core/catalog.js';
import { fillRegion, lineCells, rectFrom, idx } from '../core/grid.js';

export function createTools(vp, store, deps = {}) {
  const canvas = vp.canvas;
  const st = store.state;
  const pointers = new Map();
  let drag = null;           // the gesture in progress
  let spaceDown = false;
  let lastPaint = null;      // last painted cell, for shift-click lines
  let pinch = null;
  let longPress = 0;

  const layer = () => st.layer;
  const brushId = () => st.brush[st.layer];
  const locked = () => st.locked[st.layer];
  const cellOf = e => vp.screenToCell(e.clientX, e.clientY);

  function footprintCells(c, n = st.brushSize) {
    const out = [];
    const o = Math.floor((n - 1) / 2);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out.push([c.x - o + x, c.y - o + y]);
    return out;
  }
  function paintCells(cells, erase = false) {
    const l = store.level;
    if (locked()) { store.notice(`The ${layer()} layer is locked.`, 'warn'); return; }
    if (layer() === 'entities') {
      for (const [x, y] of cells) {
        if (x < 0 || y < 0 || x >= l.width || y >= l.height) continue;
        if (erase) { const e = store.entityAt(x, y); if (e) store.removeEntities([e.id], 'Erase'); }
        else store.placeEntity(brushId(), x, y);
      }
      return;
    }
    const code = erase ? 0 : brushId();
    const idxs = [];
    for (const [x, y] of cells) if (x >= 0 && y >= 0 && x < l.width && y < l.height) idxs.push(idx(l.width, x, y));
    store.setCells(layer(), idxs, code, erase ? 'Erase' : 'Paint');
  }
  function ghostFor(c, erase = false) {
    if (!c) return null;
    const kind = erase ? 'erase' : layer() === 'entities' ? 'entity' : layer() === 'decor' ? 'decor' : 'tile';
    if (kind === 'entity') {
      const def = entityDef(brushId());
      const f = footprint({ type: brushId(), props: { width: 3 } });
      return { kind, id: brushId(), cells: [[c.x, c.y]], rect: f.w > 1 || f.h > 1 ? { x: c.x, y: c.y, w: f.w, h: f.h } : null, label: null, bad: !def };
    }
    return { kind, id: brushId(), cells: footprintCells(c) };
  }

  // ------------------------------------------------------------------ pointer
  function onDown(e) {
    canvas.focus({ preventScroll: true });
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.setPointerCapture(e.pointerId);
    if (pointers.size === 2) { startPinch(); return; }
    if (pointers.size > 2) return;
    const c = cellOf(e);
    vp.hover = c;
    const tool = st.tool;
    if (e.button === 1 || spaceDown || tool === 'hand' || vp.inRuler(e.clientX, e.clientY)) { drag = { mode: 'pan', x: e.clientX, y: e.clientY }; canvas.classList.add('is-panning'); return; }
    if (e.pointerType === 'touch') {
      // wait a beat: a second finger turns this into a pan or pinch instead of a stroke
      drag = { mode: 'pending', e: { clientX: e.clientX, clientY: e.clientY, button: 0, shiftKey: false, altKey: false }, t: performance.now(), c };
      clearTimeout(longPress);
      longPress = setTimeout(() => { if (drag?.mode === 'pending' && !drag.moved) { const pe = drag.e; drag = null; openMenu(pe.clientX, pe.clientY, c); } }, 520);
      return;
    }
    begin(e, c);
  }
  function begin(e, c) {
    const tool = st.tool;
    if (e.button === 2) { drag = { mode: 'erase-pending', c, x: e.clientX, y: e.clientY }; return; }
    if (e.altKey || tool === 'pick') { pick(c); return; }
    if (tool === 'select') return beginSelect(e, c);
    if (tool === 'link') return beginWire(e, c);
    if (!vp.cellInside(c) && tool !== 'rect') return;
    if (tool === 'brush' || tool === 'erase') {
      const erase = tool === 'erase';
      store.begin(erase ? 'Erase' : 'Paint');
      if (e.shiftKey && lastPaint) paintCells(lineCells(lastPaint.x, lastPaint.y, c.x, c.y).flatMap(([x, y]) => footprintCells({ x, y })), erase);
      else paintCells(footprintCells(c), erase);
      drag = { mode: 'paint', erase, last: c };
      lastPaint = c;
      return;
    }
    if (tool === 'rect') { drag = { mode: 'rect', a: c, b: c }; updateRectGhost(); return; }
    if (tool === 'fill') { fill(c); return; }
  }
  function onMove(e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch) { movePinch(); return; }
    const c = cellOf(e);
    const changed = !vp.hover || vp.hover.x !== c.x || vp.hover.y !== c.y;
    vp.hover = c;
    if (!drag) {
      if (changed) { hoverGhost(c, e); deps.onHover?.(vp.cellInside(c) ? c : null); vp.redraw(); }
      return;
    }
    if (drag.mode === 'pending') {
      if (Math.hypot(e.clientX - drag.e.clientX, e.clientY - drag.e.clientY) > 6) { clearTimeout(longPress); const pe = drag.e; const c0 = drag.c; drag = null; begin(pe, c0); if (drag) onMove(e); }
      return;
    }
    if (drag.mode === 'pan') { vp.panBy(e.clientX - drag.x, e.clientY - drag.y); drag.x = e.clientX; drag.y = e.clientY; return; }
    if (drag.mode === 'erase-pending') {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) { store.begin('Erase'); paintCells(footprintCells(drag.c), true); drag = { mode: 'paint', erase: true, last: drag.c }; }
      else return;
    }
    if (!changed) return;
    if (drag.mode === 'paint') {
      const cells = lineCells(drag.last.x, drag.last.y, c.x, c.y).slice(1).flatMap(([x, y]) => footprintCells({ x, y }));
      paintCells(cells, drag.erase);
      drag.last = c; lastPaint = c;
      vp.ghost = ghostFor(c, drag.erase);
    } else if (drag.mode === 'rect') { drag.b = c; updateRectGhost(); }
    else if (drag.mode === 'move') { vp.moveOffset = { dx: c.x - drag.start.x, dy: c.y - drag.start.y }; vp.redraw(); }
    else if (drag.mode === 'marquee') { const l = store.level; vp.marquee = rectFrom(drag.start.x, drag.start.y, c.x, c.y, l.width, l.height); vp.redraw(); }
    else if (drag.mode === 'wire') { updateWire(e); }
  }
  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; return; }
    clearTimeout(longPress);
    canvas.classList.remove('is-panning');
    if (!drag) return;
    const d = drag; drag = null;
    const c = cellOf(e);
    if (d.mode === 'pending') { begin(d.e, d.c); if (drag) onUp(e); return; }
    if (d.mode === 'paint') { store.end(); }
    else if (d.mode === 'erase-pending') { openMenu(e.clientX, e.clientY, d.c); }
    else if (d.mode === 'rect') commitRect(d);
    else if (d.mode === 'move') {
      const off = vp.moveOffset; vp.moveOffset = null;
      if (off && (off.dx || off.dy)) { if (!store.moveEntities(st.selection.ids, off.dx, off.dy, 'Move')) store.notice('That would push a part outside the level.', 'warn'); }
      else if (d.clickSelect) store.select(d.clickSelect);
      vp.redraw();
    } else if (d.mode === 'marquee') {
      const r = vp.marquee; vp.marquee = null;
      if (r && (r.w > 1 || r.h > 1)) store.setRegion(r); else store.select([]);
    } else if (d.mode === 'wire') endWire(c);
    hoverGhost(c, e);
    vp.redraw();
  }
  function onLeave() { if (!drag) { vp.hover = null; vp.ghost = null; deps.onHover?.(null); vp.redraw(); } }

  function hoverGhost(c, e) {
    const tool = st.tool;
    if (!vp.cellInside(c)) { vp.ghost = null; return; }
    if (tool === 'brush') vp.ghost = ghostFor(c);
    else if (tool === 'erase') vp.ghost = ghostFor(c, true);
    else if (tool === 'rect') vp.ghost = { ...ghostFor(c), label: '1 × 1' };
    else if (tool === 'fill' && layer() !== 'entities') {
      const l = store.level;
      const cells = fillRegion(l[layer()], l.width, l.height, c.x, c.y);
      vp.ghost = { kind: layer() === 'decor' ? 'decor' : 'tile', id: brushId(), cells: cells.slice(0, 3000).map(i => [i % l.width, Math.floor(i / l.width)]), label: `${cells.length} cells` };
    } else vp.ghost = null;
    if (e?.shiftKey && tool === 'brush' && lastPaint) vp.ghost = { ...ghostFor(c), cells: lineCells(lastPaint.x, lastPaint.y, c.x, c.y).flatMap(([x, y]) => footprintCells({ x, y })) };
  }
  function updateRectGhost() {
    const l = store.level;
    const r = rectFrom(drag.a.x, drag.a.y, drag.b.x, drag.b.y, l.width, l.height);
    const cells = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) cells.push([x, y]);
    vp.ghost = { ...ghostFor(drag.a), cells, rect: r, label: `${r.w} × ${r.h}` };
    vp.redraw();
  }
  function commitRect(d) {
    const l = store.level;
    const r = rectFrom(d.a.x, d.a.y, d.b.x, d.b.y, l.width, l.height);
    if (!r.w || !r.h) return;
    const cells = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) cells.push([x, y]);
    store.begin('Rectangle');
    paintCells(cells);
    store.end();
  }
  function fill(c) {
    if (layer() === 'entities') { store.notice('Fill paints tiles. Pick the Terrain or Decor layer.', 'warn'); return; }
    if (locked()) { store.notice(`The ${layer()} layer is locked.`, 'warn'); return; }
    const l = store.level;
    const cells = fillRegion(l[layer()], l.width, l.height, c.x, c.y);
    if (cells.length > 20000) { store.notice('That region is too large to fill at once.', 'warn'); return; }
    store.setCells(layer(), cells, brushId(), 'Fill');
  }
  function pick(c) {
    const l = store.level;
    if (!vp.cellInside(c)) return;
    const e = store.entityAt(c.x, c.y);
    const i = idx(l.width, c.x, c.y);
    if (layer() === 'entities' && e) { store.setBrush('entities', e.type); store.notice(`Brush: ${entityDef(e.type).name}.`); return; }
    if (layer() === 'decor' && l.decor[i]) { store.setBrush('decor', l.decor[i]); return; }
    if (l.terrain[i]) { store.setBrush('terrain', l.terrain[i]); store.notice(`Brush: ${tileByCode(l.terrain[i])?.name}.`); return; }
    if (e) { store.setBrush('entities', e.type); return; }
  }

  // ------------------------------------------------------------------ select and move
  function beginSelect(e, c) {
    const hit = vp.cellInside(c) ? store.entityAt(c.x, c.y) : null;
    const sel = st.selection.ids;
    if (hit) {
      if (e.shiftKey) { store.select(sel.includes(hit.id) ? sel.filter(id => id !== hit.id) : [...sel, hit.id]); return; }
      if (!sel.includes(hit.id)) store.select([hit.id]);
      drag = { mode: 'move', start: c, clickSelect: sel.includes(hit.id) && sel.length > 1 ? [hit.id] : null };
      vp.moveOffset = { dx: 0, dy: 0 };
      return;
    }
    const reg = st.selection.region;
    if (reg && c.x >= reg.x && c.y >= reg.y && c.x < reg.x + reg.w && c.y < reg.y + reg.h && sel.length) {
      drag = { mode: 'move', start: c };
      vp.moveOffset = { dx: 0, dy: 0 };
      return;
    }
    drag = { mode: 'marquee', start: c };
    vp.marquee = null;
  }

  // ------------------------------------------------------------------ wires
  function beginWire(e, c) {
    const hit = vp.cellInside(c) ? store.entityAt(c.x, c.y) : null;
    if (hit && entityDef(hit.type)?.linkSource) {
      drag = { mode: 'wire', from: hit };
      vp.wire = { from: hit, to: { x: c.fx, y: c.fy }, target: null, ok: false };
      store.select([hit.id]);
      vp.redraw();
      return;
    }
    // clicking near a wire cuts it
    const cut = wireNear(c.fx, c.fy);
    if (cut) { store.removeLink(cut.from, cut.to); store.notice('Wire cut.'); return; }
    if (hit) { store.select([hit.id]); store.notice(`A ${entityDef(hit.type).name.toLowerCase()} cannot drive anything. Start a wire at a lever, plate or burrow.`, 'warn'); }
  }
  function updateWire(e) {
    const c = cellOf(e);
    const target = vp.cellInside(c) ? store.entityAt(c.x, c.y) : null;
    vp.wire.to = { x: c.fx, y: c.fy };
    vp.wire.target = target && target.id !== vp.wire.from.id ? target : null;
    vp.wire.ok = !!vp.wire.target && canLink(vp.wire.from, vp.wire.target);
    vp.redraw();
  }
  function endWire() {
    const w = vp.wire; vp.wire = null;
    if (w?.target) { if (store.addLink(w.from.id, w.target.id)) store.notice(`Wired the ${entityDef(w.from.type).name.toLowerCase()} to the ${entityDef(w.target.type).name.toLowerCase()}.`); }
    vp.redraw();
  }
  function wireNear(fx, fy) {
    const l = store.level;
    const byId = new Map(l.entities.map(e => [e.id, e]));
    let best = null, bd = 0.45;
    for (const k of l.links) {
      const a = byId.get(k.from), b = byId.get(k.to);
      if (!a || !b) continue;
      const fa = footprint(a), fb = footprint(b);
      const ax = a.x + fa.w / 2, ay = a.y + fa.h / 2, bx = b.x + fb.w / 2, by = b.y + fb.h / 2;
      const bend = Math.min(160 / (vp.cam.size || 32), Math.hypot(bx - ax, by - ay) * 0.35);
      const sx = Math.sign(bx - ax || 1);
      for (let i = 0; i <= 24; i++) {
        const t = i / 24, u = 1 - t;
        const x = u * u * u * ax + 3 * u * u * t * (ax + bend * sx) + 3 * u * t * t * (bx - bend * sx) + t * t * t * bx;
        const y = u * u * u * ay + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * by;
        const d = Math.hypot(x - fx, y - fy);
        if (d < bd) { bd = d; best = k; }
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ pinch and wheel
  function startPinch() {
    if (drag?.mode === 'paint') { store.end(); }
    drag = null; clearTimeout(longPress);
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }
  function movePinch() {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return;
    const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const r = canvas.getBoundingClientRect();
    vp.panBy(cx - pinch.cx, cy - pinch.cy);
    if (Math.abs(d - pinch.d) > 2) { vp.zoomTo((vp.cam.size / Math.min(2, devicePixelRatio || 1)) * (d / pinch.d), cx - r.left, cy - r.top, false); }
    pinch = { d, cx, cy };
  }
  function onWheel(e) {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022));
      vp.zoomTo((vp.cam.size / Math.min(2, devicePixelRatio || 1)) * f, e.clientX - r.left, e.clientY - r.top, false);
    } else {
      const k = e.deltaMode === 1 ? 16 : 1;
      vp.panBy(-(e.shiftKey ? e.deltaY : e.deltaX) * k, -(e.shiftKey ? 0 : e.deltaY) * k);
    }
  }

  // ------------------------------------------------------------------ keyboard
  function typing(e) { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); }
  function onKeyDown(e) {
    if (typing(e) || deps.blocked?.()) return;
    const mod = e.ctrlKey || e.metaKey;
    const focusedGrid = document.activeElement === canvas;
    if (e.code === 'Space' && !mod) { if (!spaceDown) { spaceDown = true; canvas.classList.add('is-grab'); } if (focusedGrid || document.activeElement === document.body) e.preventDefault(); return; }
    if (mod && e.key.toLowerCase() === 'c') { if (store.copy()) e.preventDefault(); return; }
    if (mod && e.key.toLowerCase() === 'x') { if (store.copy()) { removeSelection('Cut'); e.preventDefault(); } return; }
    if (mod && e.key.toLowerCase() === 'v') { const c = (vp.hover && vp.cellInside(vp.hover)) ? vp.hover : vp.cursor || { x: 0, y: 0 }; if (store.paste(c.x, c.y)) e.preventDefault(); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); if (store.copy()) { const r = st.selection.region; const ents = store.level.entities.filter(o => st.selection.ids.includes(o.id)); const x = r ? r.x + r.w : Math.max(...ents.map(o => o.x)) + 1; const y = r ? r.y : Math.min(...ents.map(o => o.y)); store.paste(Math.min(x, store.level.width - 1), y); } return; }
    if (mod && e.key.toLowerCase() === 'a' && focusedGrid) { e.preventDefault(); store.select(store.level.entities.map(o => o.id)); return; }
    if (mod) return;
    const key = e.key;
    const TOOLS = { v: 'select', b: 'brush', u: 'rect', r: 'rect', g: 'fill', e: 'erase', i: 'pick', l: 'link', h: 'hand' };
    if (TOOLS[key.toLowerCase()] && !e.altKey) { store.setTool(TOOLS[key.toLowerCase()]); e.preventDefault(); return; }
    if (key === '[') { store.setBrushSize(st.brushSize - 1); return; }
    if (key === ']') { store.setBrushSize(st.brushSize + 1); return; }
    if (key === '+' || key === '=') { vp.zoomBy(1.25); return; }
    if (key === '-' || key === '_') { vp.zoomBy(0.8); return; }
    if (key === '0') { vp.fit(true); return; }
    if (key === 'Escape') { if (drag) { cancelDrag(); } else if (st.selection.ids.length || st.selection.region) store.select([]); return; }
    if ((key === 'Delete' || key === 'Backspace') && (st.selection.ids.length || st.selection.region)) { removeSelection('Delete'); e.preventDefault(); return; }
    if ((key === 'f' || key === 'F') && st.selection.region) { store.flipRegion(st.selection.region); return; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[key] && focusedGrid) {
      e.preventDefault();
      const [dx, dy] = arrows[key];
      const n = e.shiftKey ? 4 : 1;
      if (st.selection.ids.length) { store.moveEntities(st.selection.ids, dx * n, dy * n, 'Nudge'); return; }
      const l = store.level;
      const c = vp.cursor || { x: Math.floor(l.width / 2), y: Math.floor(l.height / 2) };
      vp.cursor = { x: Math.max(0, Math.min(l.width - 1, c.x + dx * n)), y: Math.max(0, Math.min(l.height - 1, c.y + dy * n)) };
      ensureVisible(vp.cursor);
      vp.announce(vp.cursor);
      deps.onHover?.(vp.cursor);
      vp.redraw();
      return;
    }
    if ((key === 'Enter' || key === ' ') && focusedGrid && vp.cursor) { e.preventDefault(); applyAtCursor(); return; }
    if ((key === 'p' || key === 'P') && focusedGrid) { const c = vp.cursor || (vp.hover && vp.cellInside(vp.hover) ? vp.hover : null); deps.onPlay?.(c); e.preventDefault(); }
  }
  function onKeyUp(e) { if (e.code === 'Space') { spaceDown = false; canvas.classList.remove('is-grab'); } }
  function cancelDrag() {
    if (drag?.mode === 'paint') { store.end(); store.undo(); }
    drag = null; vp.marquee = null; vp.moveOffset = null; vp.wire = null; vp.ghost = null; vp.redraw();
  }
  function removeSelection(label) {
    const r = st.selection.region;
    if (r) { store.clearRegion(r, true); store.select([]); return; }
    store.removeEntities(st.selection.ids, label);
  }
  function applyAtCursor() {
    const c = vp.cursor;
    const tool = st.tool;
    if (tool === 'brush' || tool === 'erase') { store.begin('Paint'); paintCells(footprintCells(c), tool === 'erase'); store.end(); }
    else if (tool === 'fill') fill(c);
    else if (tool === 'pick') pick(c);
    else if (tool === 'select') { const hit = store.entityAt(c.x, c.y); store.select(hit ? [hit.id] : []); }
    else if (tool === 'rect') { if (!drag) { drag = { mode: 'rect', a: c, b: c, keyboard: true }; updateRectGhost(); store.notice('Move the cursor to the far corner and press Enter.'); } else { drag.b = c; const d = drag; drag = null; commitRect(d); vp.ghost = null; } }
    else if (tool === 'link') {
      const hit = store.entityAt(c.x, c.y);
      if (!drag && hit && entityDef(hit.type)?.linkSource) { drag = { mode: 'wire', from: hit, keyboard: true }; vp.wire = { from: hit, to: { x: c.x + 0.5, y: c.y + 0.5 }, target: null, ok: false }; store.notice('Move the cursor to what it should drive and press Enter.'); }
      else if (drag?.mode === 'wire') { vp.wire.target = hit; drag = null; endWire(); }
    }
    vp.redraw();
  }
  function ensureVisible(c) {
    const cam = vp.cam, dpr = Math.min(2, devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    const vw = (r.width * dpr) / cam.size, vh = (r.height * dpr) / cam.size;
    if (c.x < cam.x + 1 || c.x > cam.x + vw - 2 || c.y < cam.y + 1 || c.y > cam.y + vh - 2) vp.centerOn(c.x, c.y);
  }

  // ------------------------------------------------------------------ context menu
  function openMenu(clientX, clientY, c) {
    if (!deps.menu) return;
    const hit = vp.cellInside(c) ? store.entityAt(c.x, c.y) : null;
    const items = [];
    if (vp.cellInside(c)) items.push({ label: 'Play from here', kbd: 'P', run: () => deps.onPlay?.(c) });
    if (hit) {
      store.select([hit.id]);
      items.push({ label: 'Duplicate', kbd: '⌘D', run: () => { store.copy(); store.paste(Math.min(store.level.width - 1, hit.x + 1), hit.y); } });
      if (entityDef(hit.type)?.linkSource) items.push({ label: 'Wire from here', kbd: 'L', run: () => { store.setTool('link'); store.notice('Drag from the part to what it should drive.'); } });
      items.push({ label: 'Edit properties', run: () => deps.onFocusInspector?.() });
      items.push({ label: 'Delete', kbd: 'Del', danger: true, run: () => store.removeEntities([hit.id]) });
    }
    if (store.hasClipboard() && vp.cellInside(c)) items.push({ label: 'Paste here', kbd: '⌘V', run: () => store.paste(c.x, c.y) });
    if (items.length) deps.menu(clientX, clientY, items);
  }

  function onContext(e) { e.preventDefault(); }
  function onDbl(e) { const c = cellOf(e); if (vp.cellInside(c) && store.entityAt(c.x, c.y)) { store.select([store.entityAt(c.x, c.y).id]); deps.onFocusInspector?.(); } }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContext);
  canvas.addEventListener('dblclick', onDbl);
  canvas.addEventListener('focus', () => vp.redraw());
  canvas.addEventListener('blur', () => vp.redraw());
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  const offTool = store.on('tool', () => { vp.ghost = null; canvas.dataset.tool = st.tool; vp.redraw(); });
  canvas.dataset.tool = st.tool;

  return {
    destroy() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContext);
      canvas.removeEventListener('dblclick', onDbl);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      offTool();
    },
    cancel: cancelDrag,
  };
}
