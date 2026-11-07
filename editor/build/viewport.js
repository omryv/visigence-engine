/**
 * The level editor's hands on the 3D view (docs/EDITOR.md): pointer, touch and keyboard, turned into store edits.
 *
 *   select  click to select, Shift or Ctrl to add, Shift-drag on the ground to box-select, drag a selected thing to move it
 *   move    the gizmo's arrows slide along X or Z, its disc anywhere on the ground; snapped to the grid unless Alt is held
 *   rotate  the gizmo's ring turns the selection about its centre, in 15 degree steps unless Alt is held
 *   scale   the gizmo's corner handle scales placed props
 *   place   the palette's choice follows the pointer as a footprint; a click places it ([ and ] turn it)
 *   paint   a round brush paints the chosen region ([ and ] size it; Alt paints it away)
 *   wire    drag from a lever or a trigger zone to a door or a critter
 *   erase   a click deletes
 *
 * Empty ground: a drag orbits (pans in the top view); the right or middle button pans; the wheel zooms; two fingers
 * pan and pinch; a long press opens the context menu. Every drag or stroke is one undo step; the visuals move with the
 * pointer and the level is rebuilt once when it ends.
 */
import { Vector3, Vector2, Raycaster } from 'three/webgpu';
import { pickRay, pickGround } from './pick.js';
import { isKeyRef } from './store.js';
import { brushCells, REGION_CODES } from '../../src/world/level/regions.js';
import { ENTITY_TYPES, WORLD_HALF } from '../../src/world/level/entities.js';
import { FIXED_KEY } from '../../src/world/level/edits.js';

const STEP = { grid: 0.5, turn: Math.PI / 12 };
const snap = (v, s) => Math.round(v / s) * s;
const _o = new Vector3(), _d = new Vector3(), _ndc = new Vector2();

export function createViewport(el, { store, app }) {
  const pointers = new Map();
  let gesture = null, hover = null, lastMove = null, placeYaw = 0, raf = 0, longPress = 0;
  const raycaster = new Raycaster();

  // ------------------------------------------------------------------ rays
  function rayFrom(ev) {
    const cam = app.session?.camera, r = el.getBoundingClientRect();
    if (!cam) return null;
    _ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    cam.updateMatrixWorld();
    _o.setFromMatrixPosition(cam.matrixWorld);
    _d.set(_ndc.x, _ndc.y, 0.5).unproject(cam).sub(_o).normalize();
    return { o: { x: _o.x, y: _o.y, z: _o.z }, d: { x: _d.x, y: _d.y, z: _d.z }, ndc: _ndc.clone() };
  }
  const groundAt = ray => ray && pickGround(ray.o, ray.d, (x, z) => app.ground(x, z));
  function gizmoHit(ray) {
    const giz = app.overlays?.gizmo;
    if (!giz?.root.visible || !ray) return null;
    raycaster.setFromCamera(ray.ndc, app.session.camera);
    const hits = raycaster.intersectObjects(giz.handles.filter(h => h.visible), false);
    return hits[0]?.object.userData.role ?? null;
  }
  function thingAt(ray, filter = null) { return ray ? pickRay(app.pickables ?? [], ray.o, ray.d, filter)?.item ?? null : null; }

  // ------------------------------------------------------------------ helpers
  const selection = () => store.state.selection;
  const origins = refs => Object.fromEntries(refs.map(r => { const p = app.pickables.find(x => x.ref === r); return [r, p ? { x: p.x, z: p.z, yaw: p.record?.yaw ?? 0 } : null]; }));
  function pivotOf(refs) {
    const pts = refs.map(r => store.transformOf(r, app.originOf(r))).filter(Boolean);
    if (!pts.length) return null;
    const x = pts.reduce((s, p) => s + p.x, 0) / pts.length, z = pts.reduce((s, p) => s + p.z, 0) / pts.length;
    return { x, z, y: app.ground(x, z) };
  }
  const movable = r => !(isKeyRef(r) && (FIXED_KEY.test(r) || r.startsWith('lock:')));
  const scalable = refs => refs.length === 1 && !isKeyRef(refs[0]) && refs[0] !== 'start' && !!ENTITY_TYPES[store.entity(refs[0])?.type]?.scalable;
  function setCursor(kind) { el.dataset.cursor = kind; }

  /** Show or hide the gizmo for the selection and the tool. */
  function updateGizmo() {
    const giz = app.overlays?.gizmo, tool = store.state.tool, refs = selection().filter(movable);
    if (!giz) return;
    const show = refs.length && ['select', 'move', 'rotate', 'scale'].includes(tool);
    const at = show ? pivotOf(refs) : null;
    giz.place(at, app.session.camera.position, { move: tool === 'move' || tool === 'select', rotate: tool === 'rotate' || tool === 'select', scale: tool === 'scale' && scalable(refs) });
  }

  // ------------------------------------------------------------------ hover
  function onHover(ev) {
    const ray = rayFrom(ev), tool = store.state.tool;
    if (!ray) return;
    const g = groundAt(ray);
    app.panels.setCursor(g);
    if (tool === 'place') {
      const e = store.state.placing, t = g && snapPoint(g, ev);
      const r = placeRadius(e);
      app.overlays.setCursor(t ? { x: t.x, y: app.ground(t.x, t.z), z: t.z } : null, r, placeYaw, t ? !app.canStand(t.x, t.z, r, e.type) : false);
      setCursor(t ? 'crosshair' : 'not-allowed');
      app.render(); return;
    }
    if (tool === 'paint') {
      app.overlays.setCursor(g ? { ...g } : null, store.state.brush.size);
      setCursor(g ? 'crosshair' : 'default'); app.render(); return;
    }
    const role = gizmoHit(ray);
    app.overlays.gizmo.highlight(role);
    const thing = role ? null : thingAt(ray, tool === 'wire' ? it => wireable(it, 'from') : null);
    const next = thing?.ref ?? null;
    if (next !== hover) { hover = next; app.setHover(hover); }
    setCursor(role ? 'grab' : thing ? 'pointer' : tool === 'erase' ? 'not-allowed' : 'default');
    app.panels.setHint(role ? `${app.overlays.gizmo.handles.find(h => h.userData.role === role)?.userData.label ?? ''}: drag` : thing ? `${thing.label}${thing.kind === 'generated' ? ' · generated' : ''}` : '');
    app.render();
  }
  function wireable(it, end) {
    if (isKeyRef(it.ref) || it.ref === 'start') return false;
    const e = store.entity(it.ref); if (!e) return false;
    return end === 'from' ? !!ENTITY_TYPES[e.type].wireOut : !!ENTITY_TYPES[e.type].wireIn;
  }
  function snapPoint(g, ev) {
    if (!store.state.snap || ev.altKey) return { x: +g.x.toFixed(2), z: +g.z.toFixed(2) };
    return { x: snap(g.x, STEP.grid), z: snap(g.z, STEP.grid) };
  }
  function placeRadius(p) {
    if (p.type === 'trigger') return Math.hypot(p.props.w ?? 6, p.props.d ?? 6) / 2;
    if (p.type === 'prop') return { house: 5, tree: 1.4, nature: 0.5 }[p.props.prop] ?? 0.8;
    return ENTITY_TYPES[p.type].radius || 0.8;
  }

  // ------------------------------------------------------------------ gestures
  function begin(ev) {
    const ray = rayFrom(ev), tool = store.state.tool, g = groundAt(ray);
    if (ev.button === 1 || ev.button === 2) return { kind: 'pan', x: ev.clientX, y: ev.clientY };
    const role = tool !== 'place' && tool !== 'paint' && tool !== 'wire' ? gizmoHit(ray) : null;
    if (role) return startTransform(role, g, ev);
    if (tool === 'place') return { kind: 'place', g };
    if (tool === 'paint') { store.begin(`Paint ${store.state.brush.region === 'nogo' ? 'no-go ground' : store.state.brush.region === 'spawn' ? 'a spawn zone' : 'a path'}`); paintAt(g, ev); return { kind: 'paint' }; }
    const thing = thingAt(ray, tool === 'wire' ? it => wireable(it, 'from') : null);
    if (tool === 'wire') return thing ? { kind: 'wire', from: thing.ref } : { kind: 'orbit', x: ev.clientX, y: ev.clientY };
    if (tool === 'erase') { if (thing) store.remove([thing.ref]); return { kind: 'none' }; }
    if (thing) {
      const sel = selection(), add = ev.shiftKey || ev.ctrlKey || ev.metaKey;
      if (add) { store.toggleSelect(thing.ref); return { kind: 'none' }; }
      if (!sel.includes(thing.ref)) store.select([thing.ref]);
      // Pressing a thing and dragging it moves it (and everything selected with it).
      if (tool === 'select' || tool === 'move') return { kind: 'pending-move', g, x: ev.clientX, y: ev.clientY };
      return { kind: 'none' };
    }
    if (ev.shiftKey) return { kind: 'marquee', x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY };
    return { kind: 'orbit', x: ev.clientX, y: ev.clientY, clear: true, alt: ev.altKey };
  }

  function startTransform(role, g, ev) {
    const refs = selection().filter(movable), pivot = pivotOf(refs);
    if (!refs.length || !pivot) return { kind: 'none' };
    const o = origins(refs), start = Object.fromEntries(refs.map(r => [r, { ...store.transformOf(r, o[r]) }]));
    const label = role === 'rotate' ? 'Turn' : role === 'scale' ? 'Scale' : 'Move';
    store.begin(refs.length === 1 ? `${label} ${app.labelOf(refs[0]).toLowerCase()}` : `${label} ${refs.length} things`);
    const angle0 = g ? Math.atan2(g.x - pivot.x, g.z - pivot.z) : 0;
    return { kind: 'transform', role, refs, origins: o, start, pivot, g0: g, angle0, dist0: g ? Math.hypot(g.x - pivot.x, g.z - pivot.z) : 1, alt: ev.altKey };
  }

  function drag(ev) {
    const gs = gesture; if (!gs) return;
    const dx = ev.clientX - (gs.lx ?? gs.x ?? ev.clientX), dy = ev.clientY - (gs.ly ?? gs.y ?? ev.clientY);
    gs.lx = ev.clientX; gs.ly = ev.clientY;
    if (gs.kind === 'pending-move' && Math.hypot(ev.clientX - gs.x, ev.clientY - gs.y) > 4) Object.assign(gs, startTransform('move', gs.g, ev));
    if (gs.kind === 'orbit') { if (Math.hypot(ev.clientX - gs.x, ev.clientY - gs.y) > 3) gs.moved = true; app.camera.orbitBy(dx, dy, el.clientHeight); app.render(); return; }
    if (gs.kind === 'pan') { app.camera.panBy(dx, dy, el.clientHeight); app.render(); return; }
    if (gs.kind === 'marquee') { gs.x = ev.clientX; gs.y = ev.clientY; app.drawMarquee(gs); return; }
    if (gs.kind === 'paint') { paintAt(groundAt(rayFrom(ev)), ev); return; }
    if (gs.kind === 'wire') { const ray = rayFrom(ev), to = thingAt(ray, it => wireable(it, 'to')), g = groundAt(ray); gs.to = to?.ref ?? null; app.drawRubberBand(gs.from, to ?? g); return; }
    if (gs.kind === 'transform') {
      const g = groundAt(rayFrom(ev)); if (!g || !gs.g0) return;
      const free = ev.altKey || !store.state.snap;
      for (const r of gs.refs) {
        const s = gs.start[r];
        if (gs.role === 'rotate') {
          let d = Math.atan2(g.x - gs.pivot.x, g.z - gs.pivot.z) - gs.angle0;
          if (!free) d = snap(d, STEP.turn);
          const cx = s.x - gs.pivot.x, cz = s.z - gs.pivot.z, c = Math.cos(d), sn = Math.sin(d);
          // Turning a group turns it about its centre: each thing's spot orbits, and each thing turns with it.
          store.setTransform(r, { x: gs.pivot.x + cx * c + cz * sn, z: gs.pivot.z - cx * sn + cz * c, yaw: (s.yaw ?? 0) + d }, gs.origins[r]);
        } else if (gs.role === 'scale') {
          let k = Math.hypot(g.x - gs.pivot.x, g.z - gs.pivot.z) / Math.max(0.3, gs.dist0);
          const next = free ? (s.scale ?? 1) * k : snap((s.scale ?? 1) * k, 0.05);
          store.setTransform(r, { scale: next }, gs.origins[r]);
        } else {
          let mx = g.x - gs.g0.x, mz = g.z - gs.g0.z;
          if (gs.role === 'move-x') mz = 0; if (gs.role === 'move-z') mx = 0;
          let x = s.x + mx, z = s.z + mz;
          if (!free) { x = snap(x, STEP.grid); z = snap(z, STEP.grid); }
          store.setTransform(r, { x: Math.max(-WORLD_HALF, Math.min(WORLD_HALF, x)), z: Math.max(-WORLD_HALF, Math.min(WORLD_HALF, z)) }, gs.origins[r]);
        }
      }
      app.previewDrag(gs.refs);
    }
  }

  function end(ev) {
    const gs = gesture; gesture = null;
    if (!gs) return;
    if (gs.kind === 'orbit' && !gs.moved && gs.clear) store.select([]);
    if (gs.kind === 'transform') { store.end(); app.panels.setHint(''); }
    if (gs.kind === 'paint') store.end();
    if (gs.kind === 'marquee') { app.drawMarquee(null); selectInBox(gs, ev.shiftKey); }
    if (gs.kind === 'wire') { app.drawRubberBand(null); if (gs.to) store.wire(gs.from, gs.to); else app.panels.setHint('Release over a door or a critter to wire it.'); }
    if (gs.kind === 'place' && gs.g) {
      const e = store.state.placing, t = snapPoint(gs.g, ev);
      const id = store.addEntity(e.type, t.x, t.z, { yaw: placeYaw, props: e.props });
      if (id) { store.select([id]); app.pulse(t); }
    }
    app.render();
  }

  function paintAt(g, ev) {
    if (!g) return;
    const code = ev.altKey ? 0 : REGION_CODES[store.state.brush.region];
    store.paint(brushCells(g.x, g.z, store.state.brush.size), code);
    app.previewRegions();
  }

  function selectInBox(box, add) {
    const r = el.getBoundingClientRect(), x0 = Math.min(box.x0, box.x) - r.left, x1 = Math.max(box.x0, box.x) - r.left, y0 = Math.min(box.y0, box.y) - r.top, y1 = Math.max(box.y0, box.y) - r.top;
    const inside = (app.pickables ?? []).filter(it => { const s = app.toScreen(it.x, it.y + it.h / 2, it.z); return s && s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1; }).filter(it => it.group !== 'village' || add);
    store.select(add ? [...selection(), ...inside.map(i => i.ref)] : inside.map(i => i.ref));
  }

  // ------------------------------------------------------------------ pointer events
  el.addEventListener('pointerdown', ev => {
    if (!app.editing || ev.target !== app.session?.canvas) return;
    el.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    app.session.canvas.focus({ preventScroll: true });
    if (pointers.size === 2) {
      // A second finger turns whatever the first was doing into a pinch-and-pan of the view.
      cancelGesture();
      const [a, b] = [...pointers.values()];
      gesture = { kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      return;
    }
    gesture = begin(ev);
    if (ev.pointerType === 'touch') {
      clearTimeout(longPress);
      const x = ev.clientX, y = ev.clientY;
      longPress = setTimeout(() => { if (gesture && !gesture.moved && ['pending-move', 'orbit', 'none'].includes(gesture.kind)) { cancelGesture(); app.contextMenu(x, y, thingAt(rayFrom({ clientX: x, clientY: y }))?.ref ?? null, groundAt(rayFrom({ clientX: x, clientY: y }))); } }, 520);
    }
  });
  el.addEventListener('pointermove', ev => {
    if (!app.editing) return;
    const p = pointers.get(ev.pointerId);
    if (p) {
      if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > 6) clearTimeout(longPress);
      p.x = ev.clientX; p.y = ev.clientY;
    }
    if (gesture?.kind === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      app.camera.zoomBy(gesture.d / Math.max(1, d)); app.camera.panBy(cx - gesture.cx, cy - gesture.cy, el.clientHeight);
      Object.assign(gesture, { d, cx, cy }); app.render(); return;
    }
    if (gesture) { gesture.moved = gesture.moved || (p && Math.hypot(ev.clientX - (gesture.x ?? ev.clientX), ev.clientY - (gesture.y ?? ev.clientY)) > 3); drag(ev); return; }
    lastMove = ev;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (lastMove && !gesture) onHover(lastMove); });
  });
  const release = ev => {
    clearTimeout(longPress);
    pointers.delete(ev.pointerId);
    if (gesture?.kind === 'pinch') { if (pointers.size < 2) gesture = null; return; }
    if (ev.type === 'pointercancel') cancelGesture(); else end(ev);
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('pointerleave', () => { if (!gesture) { app.overlays?.setCursor(null); hover = null; app.setHover(null); app.panels.setCursor(null); app.render(); } });
  el.addEventListener('wheel', ev => {
    if (!app.editing) return;
    ev.preventDefault();
    if (store.state.tool === 'paint' && (ev.ctrlKey || ev.metaKey)) { store.setBrush({ size: Math.max(0.5, Math.min(6, store.state.brush.size - Math.sign(ev.deltaY) * 0.5)) }); onHover(ev); return; }
    app.camera.zoomBy(Math.exp(ev.deltaY * 0.0012)); app.render();
  }, { passive: false });
  el.addEventListener('contextmenu', ev => {
    if (!app.editing) return;
    ev.preventDefault();
    if (gesture?.kind === 'pan' && gesture.moved) return;
    const ray = rayFrom(ev);
    app.contextMenu(ev.clientX, ev.clientY, thingAt(ray)?.ref ?? null, groundAt(ray));
  });
  function cancelGesture() {
    const gs = gesture; gesture = null;
    if (!gs) return;
    if (gs.kind === 'transform' || gs.kind === 'paint') { store.end(); store.undo(); }
    if (gs.kind === 'marquee') app.drawMarquee(null);
    if (gs.kind === 'wire') app.drawRubberBand(null);
  }

  // ------------------------------------------------------------------ keyboard
  const held = new Set();
  const KEYS = { v: 'select', w: 'move', e: 'rotate', r: 'scale', b: 'place', n: 'paint', l: 'wire', x: 'erase' };
  function onKey(ev) {
    if (!app.editing) return;
    const t = ev.target, typing = /INPUT|SELECT|TEXTAREA/.test(t.tagName) || t.isContentEditable;
    const mod = ev.ctrlKey || ev.metaKey, k = ev.key.toLowerCase();
    if (mod && k === 'z') { if (typing) return; ev.preventDefault(); ev.shiftKey ? store.redo() : store.undo(); return; }
    if (mod && k === 'y') { if (typing) return; ev.preventDefault(); store.redo(); return; }
    if (ev.key === 'F5' || (mod && ev.key === 'Enter')) { ev.preventDefault(); app.playtest(); return; }
    if (typing) return;
    if (app.camera.mode === 'fly' && ['w', 'a', 's', 'd', 'q', 'e'].includes(k) && !mod) { held.add(k); app.flyLoop(); ev.preventDefault(); return; }
    if (mod && k === 'd') { ev.preventDefault(); store.duplicate(selection(), STEP.grid * 2, STEP.grid * 2); return; }
    if (mod && k === 'a') { ev.preventDefault(); store.select(store.edits.entities.map(e => e.id)); return; }
    if (ev.key === 'Delete' || ev.key === 'Backspace') { if (selection().length) { ev.preventDefault(); store.remove(selection()); } return; }
    if (ev.key === 'Escape') { if (gesture) cancelGesture(); else if (store.state.tool !== 'select') store.setTool('select'); else store.select([]); app.render(); return; }
    if (mod) return;
    if (KEYS[k] && !ev.shiftKey) { store.setTool(KEYS[k]); return; }
    if (k === 'o') { app.setCameraMode('orbit'); return; }
    if (k === 't') { app.setCameraMode('top'); return; }
    if (k === 'y') { app.setCameraMode('fly'); return; }
    if (k === 'f') { selection().length ? app.focusRef(selection()[0]) : app.camera.frameAll(); app.render(); return; }
    if (k === 'g') { app.toggleView('grid'); return; }
    if (k === 'p') { const g = lastMove && groundAt(rayFrom(lastMove)); app.playtest(g ? { x: g.x, z: g.z, yaw: placeYaw } : null); return; }
    if (ev.key === '[' || ev.key === ']') {
      const s = ev.key === ']' ? 1 : -1;
      if (store.state.tool === 'paint') store.setBrush({ size: Math.max(0.5, Math.min(6, store.state.brush.size + s * 0.5)) });
      else if (store.state.tool === 'place') placeYaw = (placeYaw + s * STEP.turn) % (Math.PI * 2);
      else if (selection().length) { const refs = selection().filter(movable); if (refs.length) nudgeTurn(refs, s * STEP.turn); }
      if (lastMove) onHover(lastMove);
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
    if (arrows && selection().length) {
      ev.preventDefault();
      // Nudges follow the screen: up moves away from the camera, right to its right.
      const yaw = app.camera.mode === 'top' ? 0 : app.camera.mode === 'fly' ? app.camera.fly.yaw : app.camera.yaw, step = ev.shiftKey ? 2 : STEP.grid;
      const c = Math.cos(yaw), s = Math.sin(yaw), mx = (arrows[0] * c + arrows[1] * s) * step, mz = (-arrows[0] * s + arrows[1] * c) * step;
      const refs = selection().filter(movable);
      store.translate(refs, snap(mx, 0.01), snap(mz, 0.01), 'Nudge', origins(refs));
    }
  }
  function nudgeTurn(refs, d) {
    const o = origins(refs); store.begin('Turn');
    for (const r of refs) { const t = store.transformOf(r, o[r]); if (t) store.setTransform(r, { yaw: (t.yaw ?? 0) + d }, o[r]); }
    store.end();
  }
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', ev => held.delete(ev.key.toLowerCase()));
  window.addEventListener('blur', () => held.clear());

  return {
    updateGizmo,
    get flyInput() { return { x: (held.has('d') ? 1 : 0) - (held.has('a') ? 1 : 0), y: (held.has('w') ? 1 : 0) - (held.has('s') ? 1 : 0), z: (held.has('e') ? 1 : 0) - (held.has('q') ? 1 : 0) }; },
    get placeYaw() { return placeYaw; },
    hoverRef: () => hover,
    cancel: cancelGesture,
    dispose() { window.removeEventListener('keydown', onKey); cancelAnimationFrame(raf); },
  };
}

