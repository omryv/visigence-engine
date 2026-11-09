/**
 * THE STUDIO'S LEVEL EDITOR (Build mode, docs/EDITOR.md): a game of levels built by hand in the 3D view, on top of what
 * the seed and the mission graph generate.
 *
 * One store (store.js) holds the game and its undo history; every change compiles the level in view (a few
 * milliseconds: world/shooterProject.js, its village layout cached) and runs the live checks (world/level/checks.js).
 * The session (game/ShooterSession.js) is the same one the studio plays with: it rebuilds the level once edits settle
 * and draws it with the editor's camera and overlays (setEditView). Rendering runs only while something changes: a
 * drag, a camera ease, a fly, a few frames after a change for the temporal antialiasing to settle.
 *
 * Before a game is open the editor shows its start screen (start.js): the games saved in this browser (library.js),
 * the template games, a blank start per genre. On a wide screen the viewport beside it previews the card in focus,
 * the same session turning slowly round the level (still under prefers-reduced-motion).
 */
import { createStore, isKeyRef } from './store.js';
import { createPanels, esc } from './panels.js';
import { createViewport } from './viewport.js';
import { EditorCamera } from './camera.js';
import { Overlays } from './overlays.js';
import { icon } from './icons.js';
import { pickables as listPickables, entityLabel, generatedLabel } from './pick.js';
import { levelProject } from '../../src/world/level/game.js';
import { decodeRegions } from '../../src/world/level/regions.js';
import { DEFAULT_START } from '../../src/world/level/edits.js';
import { ENTITY_TYPES } from '../../src/world/level/entities.js';
import { checkLevel } from '../../src/world/level/checks.js';
import { resolveProject, compileShooterProject } from '../../src/world/shooterProject.js';
import { resolvePack } from '../../src/world/pack.js';
import { CATALOG } from '../../src/world/catalog.js';
import { GENRES } from '../../src/genres/registry.js';
import { generationKey } from '../draft.js';
import { createLibrary } from './library.js';
import { createStart } from './start.js';
import { levelMapSvg } from './levelMap.js';
import { TEMPLATES, templateGame, templateById, copyName } from '../../src/world/level/templates.js';
import { resolveGame } from '../../src/world/shooterProject.js';
import { quickMission } from '../../src/world/missionCard.js';
import { parseProjectText } from '../../src/world/projectSchema.js';
import { Group, Vector3 } from 'three/webgpu';
import { DEFAULT_SEED, drawSeed, channelRng, normalizeSeed } from '../../src/kernel/seed.js';

const SETTLE_FRAMES = 8;
/** The live preview turns this fast round the level, radians a second. */
const PREVIEW_SPIN = 0.09;
const wide = () => matchMedia('(min-width: 900px)').matches;
/* Seeds are never drawn from the air. A blank game starts on the default seed's world; a level added after another
   grows from that level's seed (its "next-level" stream), so the same game adds the same levels every time. */
const nextLevelSeed = (seed) => drawSeed(channelRng(normalizeSeed(seed) || DEFAULT_SEED, 'next-level'));
const _v = new Vector3();

/**
 * @param {HTMLElement} root  the #build section
 * @param {object} studio     what the studio lends: ensureSession(), viewport (the game viewport element), toast(text),
 *                            playtest({from, onEnd}), openGraph(), exit(), storage (the games are saved there)
 */
export function mountBuild(root, studio) {
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  // The shell's static icons, before any game is open (the start screen's top bar uses them).
  for (const el of root.querySelectorAll('[data-bld-icon]')) el.innerHTML = icon(el.dataset.bldIcon);
  let store = null, panels = null, viewport = null, gameId = null;
  const library = createLibrary(studio.storage);
  library.migrate();
  let pack = null, level = null, checks = null, compileError = null, items = [], structures = [];
  let rebuilding = false, rebuildAgain = false, builtKey = null, raf = 0, settle = 0, lastFrame = 0, frames = 0, fpsStart = 0, captureFor = null, flying = 0, hover = null;
  const cameras = new Map(), thumbs = new Map(), statuses = new Map();
  const view = { grid: true, reach: false };
  const camera = new EditorCamera({ ground: (x, z) => app.ground(x, z), reducedMotion });
  const overlays = new Overlays();
  const marks = root.querySelector('#bld-marks'), pending = root.querySelector('#bld-pending'), empty = root.querySelector('#bld-empty'), viewEl = root.querySelector('#bld-view');
  const editView = { world: overlays.world, top: overlays.top, focus: { x: 0, z: 16 }, camera: cam => { camera.apply(cam); editView.focus = camera.mode === 'fly' ? { x: camera.fly.x, z: camera.fly.z } : camera.target; } };

  const app = {
    get session() { return studio.session(); },
    get store() { return store; },
    camera, overlays, view, thumbs,
    get panels() { return panels; },
    get level() { return level; },
    get checks() { return checks; },
    get compileError() { return compileError; },
    get pickables() { return items; },
    editing: false,
    /** The level in view as the flat project the runtime compiles. */
    flat: () => levelProject(store.game, store.state.levelIndex),
    ground: (x, z) => level?.terrain?.heightAt?.(x, z) ?? 0,
    levelStatus: id => statuses.get(id) ?? 'unknown',
    originOf(ref) { const p = items.find(i => i.ref === ref); return p ? { x: p.x, z: p.z, yaw: p.record?.yaw ?? 0 } : null; },
    labelOf(ref) { if (ref === 'start') return 'Start'; const e = !isKeyRef(ref) && store.entity(ref); return e ? entityLabel(e) : items.find(i => i.ref === ref)?.label ?? generatedLabel(ref); },
    /** Where on screen a world point is, in the viewport's pixels; null behind the camera. */
    toScreen(x, y, z) {
      const cam = app.session?.camera; if (!cam) return null;
      _v.set(x, y, z).project(cam);
      if (_v.z > 1) return null;
      return { x: (_v.x + 1) / 2 * viewEl.clientWidth, y: (1 - _v.y) / 2 * viewEl.clientHeight };
    },
    /** Can a thing of radius r stand at (x, z): on walkable ground, and not inside a house or a landmark? */
    canStand(x, z, r = 0.5, type = null) {
      if (!level) return true;
      if (type === 'trigger') return true;
      const n = level.grid.GRID_N, cell = level.grid.CELL_SIZE, i = Math.floor((x + 40) / cell), j = Math.floor((z + 40) / cell);
      if (!app.walkable || i < 0 || j < 0 || i >= n || j >= n || !app.walkable[j * n + i]) return false;
      const rr = Math.min(r, 0.8);
      return !structures.some(s => s.collision === 'circle' ? Math.hypot(x - s.x, z - s.z) < s.radius + rr
        : Math.abs((x - s.x) * Math.cos(s.yaw ?? 0) - (z - s.z) * Math.sin(s.yaw ?? 0)) < s.halfX + rr && Math.abs((x - s.x) * Math.sin(s.yaw ?? 0) + (z - s.z) * Math.cos(s.yaw ?? 0)) < s.halfZ + rr);
    },
    setHover(ref) { hover = ref; drawMarks(); },
    render,
    setCameraMode(m) { camera.setMode(m); panels.render(['tool']); render(); },
    toggleView(k) { view[k] = !view[k]; if (k === 'grid') overlays.setGridVisible(view.grid); if (k === 'reach') drawReach(); panels.render(['tool']); render(); },
    focusRef(ref) { const p = items.find(i => i.ref === ref) ?? (ref === 'start' ? { ...(store.edits.start ?? DEFAULT_START), r: 1 } : null); if (p) { camera.focus(p.x, p.z, Math.max(2, p.r ?? 2)); render(); } },
    focusAt(x, z) { camera.focus(x, z, 3); render(); },
    patchGame(patch) {
      try { resolveProject({ ...app.flat(), ...patch }); store.patch(patch, patch.genre ? 'Change genre' : patch.ground ? 'Change ground' : 'Change difficulty'); }
      catch (e) { studio.toast(e.message); panels.render(['panels']); }
    },
    toastPlace(it) { panels.setHint(`Place ${it.label.toLowerCase()}: click the ground. [ and ] turn it; Esc stops placing.`); },
    previewDrag(refs) { moveVisuals(refs); drawOverlays(); render(); },
    previewRegions() { overlays.drawRegions(decodeRegions(store.edits.regions)); render(); },
    drawMarquee(box) {
      marks.querySelector('.bld-marquee')?.remove();
      if (!box) return;
      const r = viewEl.getBoundingClientRect(), el = document.createElement('div'); el.className = 'bld-marquee';
      Object.assign(el.style, { left: `${Math.min(box.x0, box.x) - r.left}px`, top: `${Math.min(box.y0, box.y) - r.top}px`, width: `${Math.abs(box.x - box.x0)}px`, height: `${Math.abs(box.y - box.y0)}px` });
      marks.appendChild(el);
    },
    drawRubberBand(from, to) {
      const src = from && store.entity(from);
      overlays.drawRubberBand(src ? { x: src.x, z: src.z } : null, to ? { x: to.x, z: to.z, y: to.y } : null, app.ground);
      render();
    },
    pulse() { settle = SETTLE_FRAMES; render(); },
    contextMenu,
    playtest,
    flyLoop() { if (!flying) { flying = performance.now(); render(); } },
  };

  // ------------------------------------------------------------------ open a game
  /** Open a game of the library (`id`) in the editor. */
  function open(game, id) {
    gameId = id;
    if (!store) {
      store = createStore(game, { storage: studio.storage, key: library.key(id) });
      panels = createPanels(root, { store, app });
      viewport = createViewport(viewEl, { store, app });
      store.on('*', kind => {
        if (kind === 'game' || kind === 'level') { if (kind === 'level') onLevelChange(); compile(); }
        if (kind === 'selection') { drawOverlays(); viewport.updateGizmo(); }
        if (kind === 'tool') { viewport.updateGizmo(); overlays.setCursor(null); }
        if (kind !== 'notice') panels.render([kind]);
        render();
      });
      store.on('notice', n => studio.toast(n.text));
      store.on('saved', ok => { if (ok) library.touch(gameId, store.game); else studio.toast('This browser refused to save the game (its storage is full). Export it to keep your changes.'); });
    } else store.open(game, { key: library.key(id) });
    root.querySelector('#bld-name').value = game.name;
    panels.render(['all']);
    onLevelChange(); compile();
  }

  function onLevelChange() {
    const id = store.level.id;
    const saved = cameras.get(id);
    if (saved) camera.restore(saved);
    else { const s = store.edits.start ?? DEFAULT_START; camera.restore({ ...camera.snapshot(), mode: camera.mode === 'fly' ? 'orbit' : camera.mode, target: { x: s.x, z: s.z - 10 }, distance: 34 }); }
    builtKey = null;
  }

  // ------------------------------------------------------------------ compile, check, rebuild
  async function ensurePack() {
    if (pack) return pack;
    const r = await fetch('/packs/arcade/pack.json', { cache: 'no-store' });
    if (!r.ok) throw Error('The Arcade pack could not be loaded');
    return (pack = resolvePack(await r.json(), CATALOG.arcade.measurements));
  }

  async function compile() {
    if (!store) return;
    await ensurePack();
    const flat = app.flat();
    try {
      const project = resolveProject(flat);
      level = compileShooterProject(project, pack);
      compileError = null;
      checks = checkLevel(level, { genre: GENRES[project.genre] });
      const errors = checks.issues.filter(i => i.severity === 'error').length, warnings = checks.issues.filter(i => i.severity === 'warning').length;
      statuses.set(store.level.id, errors ? 'error' : warnings ? 'warning' : 'clean');
      structures = level.placements.filter(p => p.collisionOnly && (p.id === 'house-block' || p.id === 'landmark-block') && !p.parent?.startsWith('entity:'));
      const { CollisionSystem } = await import('../../src/sim/CollisionSystem.js');
      app.walkable = new CollisionSystem(level.grid).walkable;
    } catch (error) {
      compileError = error.message; checks = null;
      statuses.set(store.level.id, 'error');
    }
    items = level ? listPickables(level, store.edits, app.session?.game) : [];
    const world = level?.world, terrain = level?.terrain;
    overlays.setGround(terrain, `${store.level.id}|${level?.project.seed}|${world ? JSON.stringify(level.worldKit?.id) : 'flat'}`);
    overlays.setGridVisible(view.grid);
    overlays.drawRegions(decodeRegions(store.edits.regions));
    drawOverlays(); drawReach();
    panels.render(['compile']);
    if (!compileError) scheduleRebuild();
    else showState('error');
    render();
  }

  let rebuildTimer = 0;
  function scheduleRebuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuild, 90);
  }
  async function rebuild() {
    if (!app.editing) return;
    if (rebuilding) { rebuildAgain = true; return; }
    const flat = app.flat(), key = `${store.level.id}|${generationKey(resolveProject(flat))}`;
    if (key === builtKey) return;
    rebuilding = true; showState(builtKey === null ? 'loading' : 'updating');
    try {
      const session = await studio.ensureSession();
      session.setEditView(editView);
      // Warm: the session keeps its stage (scene, lights, sky, post stack, materials) and builds only the level again,
      // unless the edit changed what the stage was made from (the look, the lighting, the world's biome).
      await session.build(flat, { isCurrent: () => app.editing, warm: true });
      if (!app.editing) return;
      builtKey = key;
      session.setRendering(false);
      items = listPickables(level, store.edits, session.game);
      captureFor = store.level.id;
      showState(null);
    } catch (error) {
      showState('error', error.message); console.error(error);
    } finally {
      rebuilding = false;
      settle = SETTLE_FRAMES; drawOverlays(); viewport.updateGizmo(); panels.render(['compile']); render();
      if (rebuildAgain) { rebuildAgain = false; scheduleRebuild(); }
    }
  }

  function showState(state, detail = '') {
    const first = state === 'loading';
    empty.hidden = !first && state !== 'error';
    if (first) empty.innerHTML = `<div><h2>Building ${esc(store.level.name)}</h2><p>Growing the village from its seed and loading its art. The first level takes a few seconds; edits after that settle in a moment.</p><div class="bld-bar"><i></i></div></div>`;
    if (state === 'error') empty.innerHTML = `<div><h2>This level can't be built yet</h2><p>${esc(detail || compileError)}</p><button type="button" class="bld-btn bld-btn--secondary" data-bld="graph">${icon('graph')}Open the mission graph</button></div>`;
    pending.hidden = state !== 'updating';
    pending.textContent = 'Updating the level';
  }

  // ------------------------------------------------------------------ overlays and marks
  function drawOverlays() {
    if (!store || !level) return;
    const edits = store.edits, sel = new Set(store.state.selection), byId = new Map(edits.entities.map(e => [e.id, e]));
    overlays.drawMarkers({
      start: edits.start ?? DEFAULT_START,
      zones: edits.entities.filter(e => e.type === 'trigger'),
      sleepers: edits.entities.filter(e => e.type === 'enemy' && edits.wires.some(w => w.to === e.id)),
      selected: sel,
    }, app.ground);
    overlays.drawWires(edits.wires.map(w => ({ from: byId.get(w.from), to: byId.get(w.to), fromId: w.from, toId: w.to })).filter(w => w.from && w.to)
      .map(w => ({ ...w, from: { x: w.from.x, z: w.from.z }, to: { x: w.to.x, z: w.to.z } })), app.ground, sel);
    overlays.drawTrace(store.state.trace?.levelId === store.level.id ? store.state.trace : null, app.ground);
  }
  function drawReach() { overlays.drawReach(checks?.reach ?? null, k => app.walkable?.[k], view.reach); }

  /** During a drag the models follow the store before the level is rebuilt. */
  function moveVisuals(refs) {
    const session = app.session; if (!session?.level) return;
    for (const ref of refs) {
      const t = store.transformOf(ref, app.originOf(ref)); if (!t) continue;
      const records = ref === 'start' ? [] : session.level.placements.filter(p => p.entity === ref || p.key === ref || p.lockOf === ref);
      for (const p of records) {
        const v = session.placementVisuals.get(p); if (!v) continue;
        const own = p.entity === ref || p.key === ref;
        const x = own ? t.x : t.x + Math.sin(t.yaw ?? 0) * 0.58, z = own ? t.z : t.z + Math.cos(t.yaw ?? 0) * 0.58;
        v.position.set(x, app.ground(x, z) + (p.lift ?? 0), z); v.rotation.y = t.yaw ?? p.yaw ?? 0;
        if (t.scale && p.entity === ref) v.scale.setScalar(t.scale / (store.entity(ref)?.scale ?? 1) * (v.userData.baseScale ??= 1));
      }
      for (const e of session.game?.enemies.enemies ?? []) {
        const group = session.game.script.groups.find(g => g.entity.id === ref);
        if ((group && group.spawned.includes(e.id)) || (Number.isInteger(e.generated) && ref === `enemy:${e.generated}`)) {
          e.position.set(t.x, app.ground(t.x, t.z), t.z); e.prevPosition.copy(e.position); e.yaw = t.yaw ?? e.yaw;
        }
      }
      const it = items.find(i => i.ref === ref); if (it) { it.x = t.x; it.z = t.z; it.y = app.ground(t.x, t.z); }
    }
  }

  /** Viewfinder brackets round the selection and the hovered thing, and a few labels, drawn in the DOM over the canvas. */
  function drawMarks() {
    if (!store || !app.editing) { marks.innerHTML = ''; return; }
    const keep = marks.querySelector('.bld-marquee'), sel = store.state.selection, html = [];
    const box = (it, cls, text) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
      const r = it.box ? Math.hypot(it.box.hw, it.box.hd) : it.r;
      for (const [dx, dz] of [[-r, -r], [r, -r], [r, r], [-r, r]]) for (const dy of [0, it.h]) {
        const s = app.toScreen(it.x + dx, it.y + dy, it.z + dz); if (!s) continue;
        any = true; x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x); y1 = Math.max(y1, s.y);
      }
      if (!any) return;
      const pad = 6; x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
      html.push(`<div class="bld-vf ${cls}" style="transform:translate(${x0.toFixed(1)}px,${y0.toFixed(1)}px);width:${(x1 - x0).toFixed(1)}px;height:${(y1 - y0).toFixed(1)}px"><i></i><i></i><i></i><i></i></div>`);
      if (text) html.push(`<span class="bld-label ${cls.includes('invalid') ? 'bld-label--bad' : 'bld-label--sel'}" style="transform:translate(calc(${((x0 + x1) / 2).toFixed(1)}px - 50%), calc(${(y0 - 4).toFixed(1)}px - 100%))">${esc(text)}</span>`);
    };
    for (const ref of sel) {
      const it = items.find(i => i.ref === ref) ?? (ref === 'start' ? { ...(store.edits.start ?? DEFAULT_START), y: app.ground((store.edits.start ?? DEFAULT_START).x, (store.edits.start ?? DEFAULT_START).z), r: 1, h: 2 } : null);
      if (!it) continue;
      const e = !isKeyRef(ref) && store.entity(ref), bad = e && !app.canStand(e.x, e.z, ENTITY_TYPES[e.type].radius, e.type);
      box(it, `bld-vf--primary${bad ? ' bld-vf--invalid' : ''}`, sel.length === 1 ? (bad ? `${app.labelOf(ref)} · can't stand here` : app.labelOf(ref)) : null);
    }
    if (hover && !sel.includes(hover)) { const it = items.find(i => i.ref === hover); if (it) box(it, 'bld-vf--hover', null); }
    // Mission order: each pad's step number, the extraction last.
    const mission = level?.blueprint.mission ?? [];
    for (const it of items) {
      if (!it.ref.startsWith('step:')) continue;
      const n = mission.findIndex(s => it.ref.startsWith(`step:${s.id}:`)) + 1, s = n && app.toScreen(it.x, it.y + it.h + 0.4, it.z);
      if (s) html.push(`<span class="bld-label bld-label--pad" style="transform:translate(calc(${s.x.toFixed(1)}px - 50%), calc(${s.y.toFixed(1)}px - 50%))" title="Mission step ${n}">${n}</span>`);
    }
    const st = store.edits.start ?? DEFAULT_START, ss = app.toScreen(st.x, app.ground(st.x, st.z) + 2.2, st.z);
    if (ss && !sel.includes('start')) html.push(`<span class="bld-label" style="transform:translate(calc(${ss.x.toFixed(1)}px - 50%), calc(${ss.y.toFixed(1)}px - 100%))">Start</span>`);
    marks.innerHTML = html.join('');
    if (keep) marks.appendChild(keep);
  }

  // ------------------------------------------------------------------ rendering on demand
  /**
   * Ask for a redraw. Every redraw ends with a few still frames: the temporal AA resolves each frame against the last,
   * so stopping on the frame a drag or an orbit ends froze its history mid-motion (a doubled grid, smeared edges).
   */
  function render() { settle = Math.max(settle, SETTLE_FRAMES); nextFrame(); }
  function nextFrame() { if (!raf && app.editing) raf = requestAnimationFrame(frame); }
  function frame(now) {
    raf = 0;
    const session = app.session;
    if (!app.editing || !session?.game || rebuilding && builtKey === null) return;
    if (flying) { const dt = Math.min(0.05, (now - flying) / 1000); flying = camera.flyBy(viewport.flyInput, dt, false) ? now : 0; }
    viewport.updateGizmo();
    session.frame(now);
    const animating = camera.animating;
    drawMarks();
    if (captureFor && !animating) captureThumb();
    // The frame rate means something only while frames run back to back (a drag, a fly, an ease): measured then, hidden idle.
    if (lastFrame && now - lastFrame < 120) { frames++; if (!fpsStart) fpsStart = lastFrame; if (now - fpsStart > 800) { panels.setFps(Math.round(frames * 1000 / (now - fpsStart))); frames = 0; fpsStart = now; } }
    else { frames = 0; fpsStart = 0; }
    lastFrame = now;
    if (animating || flying || settle-- > 0) nextFrame();
    else { cameras.set(store.level.id, camera.snapshot()); lastFrame = 0; panels.setFps(null); }
  }
  function captureThumb() {
    const src = app.session?.canvas; if (!src || !src.width) return;
    try {
      const c = captureThumb.canvas ??= Object.assign(document.createElement('canvas'), { width: 128, height: 112 }), x = c.getContext('2d');
      const k = Math.max(128 / src.width, 112 / src.height), w = src.width * k, h = src.height * k;
      x.drawImage(src, (128 - w) / 2, (112 - h) / 2, w, h);
      thumbs.set(captureFor, c.toDataURL('image/jpeg', 0.7)); captureFor = null; panels.render(['thumbs']);
    } catch { captureFor = null; }
  }

  // ------------------------------------------------------------------ playtest
  async function playtest(from = null) {
    if (compileError) { studio.toast('Fix the level’s mission graph first: it cannot be built.'); return; }
    if (rebuilding || builtKey === null) { studio.toast('The level is still being built. Play in a moment.'); scheduleRebuild(); return; }
    const errors = checks?.issues.filter(i => i.severity === 'error') ?? [];
    if (errors.length) studio.toast(`Playing with ${errors.length} error${errors.length > 1 ? 's' : ''}: ${errors[0].message}`);
    app.editing = false; root.dataset.view = 'play'; marks.innerHTML = '';
    viewport.cancel(); playButton(true);
    studio.playtest({ from, onEnd: endPlaytest });
  }
  function endPlaytest() {
    const session = app.session, game = session?.game;
    if (game) store.setTrace({ levelId: store.level.id, points: game.trace.points.slice(), deaths: game.trace.deaths.slice(), time: game.time });
    session?.resetLevel();
    session?.setEditView(editView); session?.setRendering(false);
    app.editing = true; root.dataset.view = 'edit'; playButton(false);
    items = listPickables(level, store.edits, session?.game);
    drawOverlays(); settle = SETTLE_FRAMES; render();
    if (store.state.trace?.points.length) panels.setHint(`Last playtest: ${Math.round(store.state.trace.time)} s, ${store.state.trace.deaths.length} fall${store.state.trace.deaths.length === 1 ? '' : 's'}. The route is drawn on the ground.`);
  }

  /** Play the game through from its first level: title card, levels, the ad breaks it asks for, the ending. */
  async function playWholeGame() {
    if (compileError) { studio.toast('Fix the level’s mission graph first: it cannot be built.'); return; }
    store.flush();
    app.editing = false; root.dataset.view = 'play'; marks.innerHTML = ''; empty.hidden = true; pending.hidden = true;
    viewport.cancel(); playButton(true);
    await studio.playGame(store.game, { onEnd: backFromGame });
  }
  /** Back from a whole-game run: the session held other levels, so the one in view is rebuilt. */
  function backFromGame() {
    root.dataset.view = 'edit'; playButton(false);
    app.editing = true; builtKey = null;
    app.session?.setEditView(editView); app.session?.setRendering(false);
    scheduleRebuild(); render();
  }

  /** Export: the playable game (a ZIP for any static host or portal) or its editable file, with the publishing switches. */
  function exportDialog() {
    const host = root.querySelector('#bld-dialogs');
    let d = host.querySelector('#bld-export-dialog');
    if (!d) {
      d = document.createElement('dialog'); d.id = 'bld-export-dialog'; d.className = 'bld-dialog'; d.setAttribute('aria-labelledby', 'bld-export-title');
      host.appendChild(d);
      // Its switches carry data-publish, which the panels' change handler on the editor's root already applies.
      d.addEventListener('click', async e => {
        const b = e.target.closest('[data-export]'); if (!b) { if (e.target === d) d.close(); return; }
        if (b.dataset.export === 'close') d.close();
        if (b.dataset.export === 'file') studio.exportFile(store.game);
        if (b.dataset.export === 'zip') {
          const label = b.innerHTML; b.disabled = true;
          try { store.flush(); await studio.exportZip(store.game, (done, total) => { b.textContent = `Packaging ${done} of ${total}…`; }); d.close(); }
          catch (error) { studio.toast(error.message); }
          finally { b.disabled = false; b.innerHTML = label; }
        }
      });
    }
    const g = store.game, pub = g.publish ?? {}, n = g.levels.length;
    const sw = (k, l, hint) => `<label class="bld-switch"><span>${esc(l)}<small class="bld-note">${esc(hint)}</small></span><input type="checkbox" data-publish="${k}" ${pub[k] ? 'checked' : ''}></label>`;
    d.innerHTML = `<form method="dialog" class="bld-dialog__body">
      <h2 id="bld-export-title">Export ${esc(g.name)}</h2>
      <p class="bld-note">The playable game: its ${n} level${n > 1 ? 's' : ''}, art and runtime in one ZIP for any static host, itch.io or a web portal. Or its game file, to open in the studio again.</p>
      <fieldset class="bld-dialog__set"><legend class="bld-meta">Publishing</legend>
        ${sw('adBreaks', 'Ad break between levels', 'Before each next level.')}
        ${sw('rewardedContinue', 'Rewarded continue', 'After the last life: an ad for the lives back.')}
        ${sw('showCredits', '“Made with Visigame”', 'On the title card and the ending.')}
        <p class="bld-note">The game calls <code>window.VisigameHooks</code> at these moments; the exported page explains how to connect a portal’s SDK. Without one, play just goes on.</p>
      </fieldset>
      <div class="bld-dialog__foot">
        <button type="button" class="bld-btn bld-btn--ghost" data-export="close">Close</button>
        <button type="button" class="bld-btn bld-btn--secondary" data-export="file">${icon('download')}Game file</button>
        <button type="button" class="bld-btn bld-btn--primary" data-export="zip">${icon('download')}Playable game (ZIP)</button>
      </div>
    </form>`;
    d.showModal();
    d.querySelector('[data-export="zip"]').focus();
  }

  /** While a playtest runs, the primary action is to stop it. */
  function playButton(playing) {
    const b = root.querySelector('#bld-play');
    b.dataset.bld = playing ? 'stop' : 'play';
    b.innerHTML = `${icon(playing ? 'stop' : 'play')}<span class="bld-play-label">${playing ? 'Stop playtest' : 'Play level'}</span>`;
  }

  // ------------------------------------------------------------------ context menu and top bar actions
  function closeMenus() { for (const m of root.querySelectorAll('.bld-menu')) { m.hidden = true; } root.querySelector('#bld-play-more').setAttribute('aria-expanded', 'false'); root.querySelector('.bld-ctx')?.remove(); }
  function contextMenu(x, y, ref, g) {
    closeMenus();
    if (ref && !store.state.selection.includes(ref)) store.select([ref]);
    const refs = store.state.selection, placed = refs.filter(r => !isKeyRef(r) && r !== 'start').length;
    const m = document.createElement('div'); m.className = 'bld-menu bld-ctx'; m.setAttribute('role', 'menu');
    const item = (act, ic, text, dis = false, kbd = '') => `<button type="button" role="menuitem" data-bld="${act}" ${dis ? 'disabled' : ''}>${icon(ic)}${esc(text)}${kbd ? `<kbd>${kbd}</kbd>` : ''}</button>`;
    m.innerHTML = (refs.length ? item('duplicate', 'copy', 'Duplicate', !placed, 'Ctrl D') + item('delete', 'trash', refs.some(isKeyRef) && !placed ? 'Remove' : 'Delete', false, 'Del') + item('focus', 'focus', 'Frame', false, 'F') + '<hr>' : '')
      + item('play-here-ctx', 'playFrom', 'Play from here', !g, 'P') + item('place-here', 'place', `Place ${store.state.placing ? ENTITY_TYPES[store.state.placing.type].label.toLowerCase() : 'thing'} here`, !g);
    m.dataset.x = g?.x ?? ''; m.dataset.z = g?.z ?? '';
    root.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.position = 'fixed'; m.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`; m.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`; m.style.right = 'auto';
    m.querySelector('button:not([disabled])')?.focus();
  }

  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-bld]'); if (!b) { if (!e.target.closest('.bld-menu')) closeMenus(); return; }
    const act = b.dataset.bld, ctx = b.closest('.bld-ctx'), at = ctx && ctx.dataset.x !== '' ? { x: Number(ctx.dataset.x), z: Number(ctx.dataset.z) } : null;
    if (act !== 'play-menu') closeMenus();
    const sel = store?.state.selection ?? [];
    switch (act) {
      case 'exit': studio.exit(); break;
      case 'start': showStart(); break;
      case 'undo': store.undo(); break;
      case 'redo': store.redo(); break;
      case 'checks': panels.selectTab('checks'); if (matchMedia('(max-width: 899px)').matches) panels.setSheet('right', true, 'checks'); break;
      case 'play': playtest(null); break;
      case 'stop': studio.stopPlaytest(); break;
      case 'play-here': case 'play-here-ctx': case 'play-here-sel': {
        const t = act === 'play-here-sel' && sel[0] ? store.transformOf(sel[0], app.originOf(sel[0])) : at ?? camera.target;
        playtest(t ? { x: t.x, z: t.z, yaw: t.yaw ?? 0 } : null); break;
      }
      case 'play-game': playWholeGame(); break;
      case 'play-menu': { const menu = root.querySelector('#bld-play-menu'); menu.hidden = !menu.hidden; b.setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) menu.querySelector('button')?.focus(); break; }
      case 'export': exportDialog(); break;
      case 'duplicate': store.duplicate(sel, 1, 1); break;
      case 'delete': store.remove(sel); break;
      case 'focus': sel.length ? app.focusRef(sel[0]) : camera.frameAll(); render(); break;
      case 'place-here': if (at && store.state.placing) { const id = store.addEntity(store.state.placing.type, at.x, at.z, { props: store.state.placing.props }); if (id) store.select([id]); } break;
      case 'snap': store.setSnap(!store.state.snap); break;
      case 'grid': case 'reach': app.toggleView(act); break;
      case 'reset-start': store.transact('Reset start', () => store.setTransform('start', DEFAULT_START)); break;
      case 'graph': studio.openGraph(); break;
      case 'add-level': store.addLevel(nextLevelSeed(levelProject(store.game, store.state.levelIndex).seed)); break;
      case 'wire-from': store.setTool('wire'); panels.setHint('Drag from this lever or zone to a door or a critter.'); break;
      case 'panels-left': case 'sheet-left': panels.setSheet('left', root.dataset.left !== 'open', 'palette'); break;
      case 'sheet-right': panels.setSheet('right', root.dataset.right !== 'open', 'inspector'); break;
      case 'tools-more': contextMenu(b.getBoundingClientRect().left, b.getBoundingClientRect().top - 220, null, null); break;
    }
  });
  root.addEventListener('keydown', e => { if (e.key === 'Escape' && root.querySelector('.bld-menu:not([hidden])')) { closeMenus(); root.querySelector('#bld-play-more').focus(); } });

  // ------------------------------------------------------------------ the start screen and its live preview
  const startEl = root.querySelector('#bld-start'), cap = root.querySelector('#bld-previewcap');
  const previewCam = new EditorCamera({ ground: (x, z) => app.session?.level?.terrain?.heightAt?.(x, z) ?? 0, reducedMotion });
  const previewView = { world: new Group(), top: new Group(), focus: { x: 0, z: 0 }, camera: cam => previewCam.apply(cam) };
  const maps = new Map();
  let previewKey = null, previewTimer = 0, spin = 0, spinLast = 0, swing = 0, trying = false;

  /** A template level's map, compiled once. */
  async function mapFor(id, index) {
    const k = `${id}:${index}`;
    if (!maps.has(k)) maps.set(k, (async () => {
      await ensurePack();
      const game = resolveGame(templateGame(id)), t = templateById(id);
      return levelMapSvg(compileShooterProject(resolveProject(levelProject(game, index)), pack), { title: `Map of ${t.name}, level ${index + 1}: ${t.levels[index].name}` });
    })());
    return maps.get(k);
  }
  /** A template's copy, a blank game of a genre, a saved game: the ways into the editor (the start screen's and a link's). */
  const useTemplate = id => {
    const t = templateById(id), game = resolveGame(templateGame(id));
    keep({ ...game, name: copyName(id) }, `Your copy of the ${t.name.toLowerCase()}. Name it in the title box; it saves in this browser as you go.`);
  };
  const blankGame = genre => { const g = resolveGame(quickMission('arcade', DEFAULT_SEED, genre)); keep({ ...g, name: `New ${GENRES[genre].label.toLowerCase()} game` }, null); };
  const openSaved = id => {
    try { const doc = parseProjectText(library.text(id) ?? '').project; openEditor(resolveGame(doc), id); }
    catch (e) { studio.toast(`That game could not be opened: ${e.message}`); }
  };
  const start = createStart(startEl, {
    templates: TEMPLATES, library, mapFor,
    actions: {
      use: useTemplate,
      tryIt,
      blank: blankGame,
      open: openSaved,
      remove: id => { library.remove(id); if (id === gameId) gameId = null; },
      file: async f => {
        try {
          if (f.size > 600000) throw Error('Choose a Visigames game file under 600 KB.');
          const opened = parseProjectText(await f.text(), { requireEnvelope: true });
          keep(resolveGame(opened.project), opened.migrated ? `Opened ${f.name}, updated from format ${opened.from}.` : `Opened ${f.name}.`);
        } catch (e) { studio.toast(e.message); }
      },
      focus: (id, index) => preview(id, index),
      back: () => showEditor(),
    },
  });
  /** Save a new game to the library and open it. */
  function keep(game, message) {
    const id = library.add(game);
    if (!id) { studio.toast('This browser refused to save the game (its storage is full). Delete a game you no longer need, then try again.'); return; }
    openEditor(game, id);
    if (message) studio.toast(message);
  }

  async function showStart() {
    stopEditing(); stopTrying();
    store?.flush();
    root.dataset.view = 'start'; empty.hidden = true; pending.hidden = true;
    start.render({ current: store && gameId && library.has(gameId) ? { name: store.game.name } : null });
    startEl.scrollTop = 0; startEl.querySelector('h2')?.focus?.();
    if (wide()) start.focusFirst();
  }
  /** The live preview: the session builds the level and turns round it. Debounced, so a sweep over the cards builds once. */
  function preview(id, index) {
    if (!wide() || root.dataset.view !== 'start') return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const key = `${id}:${index}`, t = templateById(id);
      if (key === previewKey) return;
      previewKey = key;
      cap.hidden = false; cap.innerHTML = `<span class="bld-meta">Loading preview</span><b>${esc(t.name)} · ${index + 1} ${esc(t.levels[index].name)}</b>`;
      try {
        const session = await studio.ensureSession();
        if (previewKey !== key || root.dataset.view !== 'start') return;
        viewEl.prepend(studio.viewport); session.resize();
        session.setEditView(previewView);
        Object.assign(previewCam, { mode: 'orbit', target: { x: 0, z: -2 }, distance: 66, pitch: 0.72, yaw: previewCam.yaw || 0.6 });
        await session.build(levelProject(resolveGame(templateGame(id)), index), { isCurrent: () => previewKey === key && root.dataset.view === 'start' });
        if (previewKey !== key || root.dataset.view !== 'start') return;
        session.setRendering(false);
        cap.innerHTML = `<span class="bld-meta">Live preview · ${esc(GENRES[t.genre].label)}</span><b>${esc(t.name)} · ${index + 1} ${esc(t.levels[index].name)}</b>`;
        // a new template swings the camera on round, rather than cutting to it
        if (!reducedMotion()) swing += 0.55;
        spinLast = 0; if (!spin) spin = requestAnimationFrame(turn);
      } catch (e) { if (previewKey === key) { cap.innerHTML = `<span class="bld-meta">Preview unavailable</span><b>${esc(e.message)}</b>`; previewKey = null; } }
    }, 220);
  }
  /** One frame of the preview's slow turn; one still frame under reduced motion or while the tab is hidden. */
  function turn(now) {
    spin = 0;
    const session = app.session;
    if (root.dataset.view !== 'start' || !previewKey || !session?.game) return;
    if (!reducedMotion() && spinLast) {
      const dt = Math.min(0.05, (now - spinLast) / 1000), d = swing * Math.min(1, dt * 2.6);
      swing -= d; previewCam.yaw += dt * PREVIEW_SPIN + d;
    }
    spinLast = now;
    session.frame(now);
    if (!reducedMotion() && !document.hidden) spin = requestAnimationFrame(turn);
  }
  function stopPreview() { clearTimeout(previewTimer); cancelAnimationFrame(spin); spin = 0; previewKey = null; cap.hidden = true; }

  /** "Play it": the template level plays as it is, then the start screen comes back. */
  async function tryIt(id, index) {
    const t = templateById(id);
    stopPreview(); trying = true;
    root.dataset.view = 'play'; root.dataset.trying = ''; viewEl.prepend(studio.viewport);
    playButton(true);
    empty.hidden = false; empty.innerHTML = `<div><h2>Loading ${esc(t.name)}</h2><p>${esc(t.levels[index].name)}: growing the village and loading its art.</p><div class="bld-bar"><i></i></div></div>`;
    try {
      const session = await studio.ensureSession();
      session.setEditView(null); session.resize();
      await session.build(levelProject(resolveGame(templateGame(id)), index), { isCurrent: () => trying });
      if (!trying) return;
      empty.hidden = true;
      studio.playtest({ from: null, onEnd: () => { if (trying) showStart(); } });
    } catch (e) { empty.hidden = true; studio.toast(`${t.name} could not be started: ${e.message}`); showStart(); }
  }
  function stopTrying() { if (!trying) return; trying = false; delete root.dataset.trying; playButton(false); }

  function stopEditing() {
    app.editing = false; viewport?.cancel();
    cancelAnimationFrame(raf); raf = 0; marks.innerHTML = '';
  }
  /** Into the editor with a game of the library. */
  async function openEditor(game, id) {
    stopPreview(); stopTrying();
    root.dataset.view = 'edit';
    viewEl.prepend(studio.viewport);
    app.editing = true;
    open(game, id);
    showState('loading');
    const session = await studio.ensureSession();
    session.setEditView(editView); session.setRendering(false);
    session.resize(); builtKey = null; scheduleRebuild();
  }
  /** Back into the editor with the game already open. */
  async function showEditor() {
    stopPreview(); stopTrying();
    root.dataset.view = 'edit';
    viewEl.prepend(studio.viewport);
    app.editing = true; compile();
    showState(builtKey === null ? 'loading' : null);
    const session = await studio.ensureSession();
    session.setEditView(editView); session.setRendering(false);
    session.resize(); builtKey = null; scheduleRebuild();
  }

  // ------------------------------------------------------------------ show and hide
  return {
    app,
    /**
     * Enter Build mode: with a game, it joins the library and opens; without one, the game already open comes back,
     * or the start screen shows.
     */
    async show(game = null) {
      root.hidden = false;
      if (game) keep(game, null);
      else if (store && gameId && library.has(gameId)) await showEditor();
      else await showStart();
    },
    /**
     * Straight into the editor from a link (the landing hub's): a copy of a template, a game saved in this browser, or
     * a blank game of a genre. Returns false when the link names nothing it knows, so the caller can show() instead.
     */
    route({ template = null, game = null, blank = null } = {}) {
      if (template && templateById(template)) { root.hidden = false; useTemplate(template); return true; }
      if (game && library.has(game)) { root.hidden = false; openSaved(game); return true; }
      if (blank && GENRES[blank]) { root.hidden = false; blankGame(blank); return true; }
      return false;
    },
    hide() {
      stopEditing(); stopPreview(); stopTrying();
      app.session?.setEditView(null);
      store?.flush();
      root.hidden = true;
      builtKey = null;
    },
    get store() { return store; },
    get library() { return library; },
    showStart,
    endPlaytest,
  };
}
