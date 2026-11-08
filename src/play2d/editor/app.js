/**
 * The level builder's app: routing between the start screen, the editor and the shared-link
 * player; the top bar, tool rail, status bar and phone toolbar; analysis in a worker; the
 * keyboard map; theme; playtest; share and export.
 *
 * Routes (the hash is read once, then cleared so a reload reopens your autosaved game):
 *   #play=<code>       play a shared game full-screen, with Remix to open it in the builder
 *   #try=<id>          play a template full-screen, with Remix (the iOS app's Games tab opens this)
 *   #template=<id>     start from a template        #new=<genre>   start blank
 *   #generate=<genre>  start blank with Generate levels open; #generate=<genre>:<seed> with that seed filled in
 *   #open=<id>         a game saved in this browser
 *   #gallery           the start screen             (none)         your latest game, else the start screen
 */
import { createStore, readRecent, loadSaved, forgetSaved } from './store.js';
import { createArt } from '../art/index.js';
import { drawScene, sceneFromLevel } from '../runtime/render.js';
import { createGame } from '../runtime/game.js';
import { createViewport } from './viewport.js';
import { createTools } from './tools.js';
import { mountPanels } from './panels.js';
import { renderGallery } from './gallery.js';
import { openPlaytest } from './playtest.js';
import { openExport, openShare, readProjectFile, pickFile } from './publish.js';
import { dialog, confirmDialog, toast, menu, installTooltips, dialogOpen, esc } from './dialogs.js';
import { icon } from './icons.js';
import { drawLevelThumb } from './thumbs.js';
import { openGenerate } from './generate-dialog.js';
import { parseGenerateLink } from '../core/generate.js';
import { TEMPLATES, templateById, blankProject } from '../templates/index.js';
import { analyzeLevel, analyzeProject } from '../core/analyze.js';
import { decodeShare, newId } from '../core/format.js';
import { genreById, entityDef, LIMITS, GENRE_IDS } from '../core/catalog.js';
import { parseProject } from '../core/format.js';
import { worldFromLocation } from '../../world/worldLink.js';
import { worldParamsFor } from '../../world/kernelGround.js';
import { bakeHeightField } from '../../kernel/terrain/heightfield.js';
import { buildWorldFile } from '../../genesis/world/worldfile.js';
import { projectOverworld, serializeOverworld } from '../../genesis/world/overworld.js';

/* The one editor's world, when this 2D view runs inside it (index.html hands it over in the fragment, as it does to
   every view: src/world/worldLink.js). The start screen offers it as a 2D adventure. */
let editorWorld = worldFromLocation(location).world;
// The editor keeps this view when another is shown, and says so (stop drawing; start again); and when its world has
// changed meanwhile, it hands the new one over, which the start screen offers.
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== window.parent) return;
  const t = e.data?.type;
  if (t === 'visigence:pause') vp?.setPaused(true);
  if (t === 'visigence:resume' && app.dataset.view === 'editor') vp?.setPaused(false);
  if (t === 'visigence:world' && typeof e.data.link === 'string') {
    const next = worldFromLocation({ hash: '#world=' + e.data.link }).world;
    if (next && JSON.stringify(next) !== JSON.stringify(editorWorld)) { editorWorld = next; if (app.dataset.view === 'gallery') showGallery(); }
  }
});
/** The editor's world as a 2D adventure: its ground, read square by square (src/genesis/world/overworld.js). */
function worldIn2D() {
  const params = worldParamsFor(editorWorld.seed, editorWorld.worldParams);
  const doc = buildWorldFile({ params, propRecords: [], field: bakeHeightField(params, 65) });
  const { project, report } = projectOverworld(doc);
  const p = parseProject(serializeOverworld(project));
  p.title = `The world ${editorWorld.seed}`;
  return { project: p, report };
}

const $ = id => document.getElementById(id);
const THEME_KEY = 'visigame.builder.theme';
// builder.css hides Share, Export and Redo from the top bar at this width; the Play menu carries them there
const COMPACT = matchMedia('(max-width: 760px)');
const art = createArt();

const app = $('app');
const editorEl = $('editor');
const galleryEl = $('gallery');
let store = null, vp = null, tools = null, panels = null, gallery = null, playing = null;
const analyses = new Map();        // level id -> { result, stamp }
let analyzeTimer = 0, stamp = 0;

// ============================================================== boot (started at the end of this module)
async function boot() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.has('play')) return startPlayer(hash.get('play'));
  if (hash.has('try') && templateById(hash.get('try'))) {
    const id = hash.get('try');
    clearHash();
    return showPlayer(templateById(id).build({ id: 'try-' + id }), () => templateById(id).build({ copy: true }));
  }
  let project = null;
  if (hash.has('template')) project = templateById(hash.get('template'))?.build({ copy: true }) || null;
  else if (hash.has('new') && GENRE_IDS.includes(hash.get('new'))) project = blankProject(hash.get('new'));
  if (project) { clearHash(); return openEditor(project); }
  const gen = hash.has('generate') ? parseGenerateLink(hash.get('generate')) : null;
  if (gen) {
    clearHash();
    openEditor(blankProject(gen.genre));
    openGenerate({ store, art, fresh: true, seed: gen.seed });
    return;
  }
  if (hash.has('open')) {
    const saved = loadSaved(hash.get('open'));
    clearHash();
    if (saved) return openEditor(saved);
    toast('That game is not saved in this browser.', 'warn');
    return showGallery();
  }
  if (hash.has('gallery')) { clearHash(); return showGallery(); }
  const last = readRecent()[0];
  const saved = last ? loadSaved(last.id) : null;
  if (saved) return openEditor(saved);
  showGallery();
}
function clearHash() { history.replaceState(null, '', location.pathname + location.search); }

// ============================================================== the shared-link player
async function startPlayer(code) {
  app.dataset.view = 'player';
  let project;
  try { project = await decodeShare(code); }
  catch (e) { clearHash(); toast(`That link could not be opened: ${e.message}`, 'error', { ms: 6000 }); return showGallery(); }
  showPlayer(project);
}
/** `remix()` is the copy Remix opens: by default the game itself under a new id. */
function showPlayer(project, remix = () => ({ ...project, id: newId('g') })) {
  app.dataset.view = 'player';
  const page = document.createElement('div');
  page.className = 'player-page';
  app.appendChild(page);
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;inset:0';
  page.appendChild(host);
  const game = createGame(host, project, { mode: 'standalone', art, hooks: { adBreak: () => Promise.resolve(false), event: () => {} } });
  const bar = document.createElement('div');
  bar.className = 'player-page__bar';
  bar.innerHTML = `<button type="button" class="btn btn--secondary" data-remix>${icon('wand')}Remix in the builder</button>`;
  page.appendChild(bar);
  document.title = `${project.title} · Visigence Engine`;
  bar.querySelector('[data-remix]').addEventListener('click', () => {
    game.destroy(); page.remove(); clearHash();
    openEditor(remix());
    toast('This is your copy. It saves in this browser as you edit.', 'ok');
  });
}

// ============================================================== the start screen
function showGallery() {
  app.dataset.view = 'gallery';
  playing?.close();
  vp?.setPaused(true);
  $('skip').hidden = true;
  editorEl.hidden = true;
  galleryEl.hidden = false;
  gallery?.destroy();
  document.title = 'Visigence Engine · 2D';
  gallery = renderGallery(galleryEl, {
    art, templates: TEMPLATES, recent: readRecent(),
    current: store ? store.project : null,
    onTemplate: id => openEditor(templateById(id).build({ copy: true })),
    onTry: id => tryTemplate(id),
    onBlank: g => openEditor(blankProject(g)),
    onGenerate: g => { openEditor(blankProject(g)); openGenerate({ store, art, fresh: true }); },
    onOpen: id => { const p = loadSaved(id); if (p) openEditor(p); else toast('That game could not be read from this browser.', 'error'); },
    onForget: async id => { const r = readRecent().find(x => x.id === id); if (await confirmDialog(`Delete “${r?.title || 'this game'}” from this browser? This cannot be undone.`)) { forgetSaved(id); showGallery(); } },
    onOpenFile: () => openFile(),
    onContinue: () => showEditor(),
    onTheme: () => toggleTheme(),
    world: editorWorld,
    onWorld: () => {
      try {
        const { project, report } = worldIn2D();
        openEditor(project);
        toast(`Your world in 2D: ${report.width} × ${report.height} squares, ${Math.round(report.tileMetres)} m each.`, 'ok');
      } catch (e) { toast(e.message || 'The world could not be drawn in 2D.', 'error', { ms: 6000 }); }
    },
  });
  galleryEl.scrollTop = 0;
}
function tryTemplate(id) {
  const project = templateById(id).build({ id: 'try-' + id });
  const host = $('playtest');
  const from = document.activeElement, scroll = galleryEl.scrollTop;
  host.hidden = false;
  host.style.inset = '0';
  // the game covers the start screen: hiding it also stops its live previews drawing underneath
  galleryEl.hidden = true;
  const frame = document.createElement('div');
  frame.style.cssText = 'position:absolute;inset:0';
  host.appendChild(frame);
  const game = createGame(frame, project, { mode: 'standalone', art });
  const back = document.createElement('button');
  back.type = 'button'; back.className = 'btn btn--secondary';
  back.style.cssText = 'position:absolute;left:12px;bottom:12px;z-index:20';
  back.innerHTML = `${icon('chevronLeft')}Back to templates`;
  const remix = document.createElement('button');
  remix.type = 'button'; remix.className = 'btn btn--primary';
  remix.style.cssText = 'position:absolute;right:12px;bottom:12px;z-index:20';
  remix.innerHTML = `${icon('wand')}Use this template`;
  host.append(back, remix);
  const close = () => { game.destroy(); host.innerHTML = ''; host.hidden = true; host.style.inset = ''; galleryEl.hidden = false; galleryEl.scrollTop = scroll; };
  back.addEventListener('click', () => { close(); if (from?.isConnected) from.focus({ preventScroll: true }); });
  remix.addEventListener('click', () => { close(); openEditor(templateById(id).build({ copy: true })); });
}
async function openFile() {
  const f = await pickFile();
  if (!f) return;
  try { const p = await readProjectFile(f); openEditor(p); toast(`Opened ${p.title}.`, 'ok'); }
  catch (e) { toast(e.message || 'That file could not be opened.', 'error', { ms: 6000 }); }
}

// ============================================================== the editor
function openEditor(project) {
  if (!store) {
    store = createStore(project);
    mountEditor();
  } else {
    store.replaceProject(project);
    analyses.clear();
    vp.invalidate();
    requestAnimationFrame(() => vp.fit());
  }
  store.save(true);
  showEditor();
  analyzeAll();
}
function showEditor() {
  app.dataset.view = 'editor';
  gallery?.destroy(); gallery = null;
  galleryEl.hidden = true;
  editorEl.hidden = false;
  document.title = `${store.project.title} · 2D · Visigence Engine`;
  vp.setPaused(false);
  $('skip').hidden = false;
  requestAnimationFrame(() => { vp.redraw(); vp.canvas.focus({ preventScroll: true }); });
}

function mountEditor() {
  vp = createViewport($('viewport'), store, art, { drawScene, sceneFromLevel, getAnalysis: () => analyses.get(store.level.id)?.result || null });
  tools = createTools(vp, store, {
    menu: (x, y, items) => menu(x, y, items),
    onPlay: cell => play({ spawn: cell }),
    onFocusInspector: () => { editorEl.classList.add('show-right'); panels.focusInspector(); },
    onHover: () => statusbar(),
    blocked: () => dialogOpen() || !!playing,
  });
  panels = mountPanels(store, art, { layers: $('layers'), palette: $('palette'), inspector: $('inspector'), levels: $('levels'), issues: $('issues') }, {
    getAnalysis: () => analyses.get(store.level.id)?.result || null,
    onJump: jumpTo,
    onPlay: cell => play({ spawn: cell }),
    confirm: msg => confirmDialog(msg),
    drawThumb,
    onGenerate: () => openGenerate({ store, art }),
    levelStatus: i => { const l = store.project.levels[i]; const r = l && analyses.get(l.id)?.result; if (!r) return null; return r.issues.some(x => x.severity === 'error') ? 'error' : r.issues.some(x => x.severity === 'warning') ? 'warning' : null; },
    blocked: () => dialogOpen() || !!playing,
  });
  // a handle for scripted checks and the curious: window.__builder.store.project is the live game
  window.__builder = { store, vp, art, analysis: () => analyses.get(store.level.id)?.result || null };
  renderTopbar();
  renderRail();
  renderMobilebar();
  statusbar();

  store.on('history', updateHistory);
  store.on('saved', updateSaved);
  store.on('project', () => { $('game-title').value !== store.project.title && ($('game-title').value = store.project.title); document.title = `${store.project.title} · 2D · Visigence Engine`; statusbar(); });
  store.on('level', () => { scheduleAnalysis(); statusbar(); });
  store.on('levels', () => { scheduleAnalysis(0); statusbar(); vp.onLevelSwitch(); });
  store.on('tool', () => { renderRail(); renderMobilebar(); statusbar(); });
  store.on('brush', () => { renderRail(); statusbar(); });
  store.on('layer', statusbar);
  store.on('view', renderRail);
  store.on('notice', n => { if (n.tone !== 'history') toast(n.text, n.tone === 'warn' ? 'warn' : 'info'); });
  window.addEventListener('keydown', globalKeys);
  window.addEventListener('beforeunload', () => store.save(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) store.save(true); });
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => vp.refreshColors());
  // the grid's keys (arrows, Enter, P) belong to its canvas, not the viewport box the link names
  $('skip').addEventListener('click', e => { e.preventDefault(); vp.canvas.focus(); });
  // tap outside an open sheet (phone) or drawer (tablet) to close it
  $('stage').addEventListener('pointerdown', () => editorEl.classList.remove('show-left', 'show-right'));
}

// ============================================================== top bar
function renderTopbar() {
  const p = store.project;
  const title = $('game-title');
  title.value = p.title;
  title.addEventListener('change', () => store.setProject({ title: title.value.trim() || 'Untitled game' }, 'Rename game'));
  title.addEventListener('keydown', e => { if (e.key === 'Enter') { title.blur(); vp.canvas.focus(); } e.stopPropagation(); });
  $('games-btn').innerHTML = `${icon('folder')}<span class="btn__label">Games</span>`;
  $('games-btn').dataset.tip = 'Your games and templates';
  $('undo').innerHTML = icon('undo');
  $('redo').innerHTML = icon('redo');
  $('share-btn').innerHTML = `${icon('share')}<span class="btn__label">Share</span>`;
  $('share-btn').dataset.tip = 'Share a link that plays the game';
  $('export-btn').dataset.tip = 'Download the game or the project';
  $('export-btn').innerHTML = `${icon('download')}<span class="btn__label">Export</span>`;
  $('play-btn').innerHTML = `${icon('play')}<span class="btn__label">Play</span><kbd class="topbar__hide-sm">F5</kbd>`;
  $('play-more').innerHTML = icon('chevronDown');
  const moreLabel = () => $('play-more').setAttribute('aria-label', COMPACT.matches ? 'More: play, share and export' : 'More ways to play');
  COMPACT.addEventListener?.('change', moreLabel);
  moreLabel();
  $('toggle-right').innerHTML = `${icon('sliders')}<span class="btn__label">Inspect</span>`;
  updateHistory(); updateSaved({ ok: true }); updateGenreChip(); updateIssues();
  $('topbar').addEventListener('click', e => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const a = b.dataset.action;
    if (a === 'gallery') { e.preventDefault(); store.save(true); showGallery(); }
    else if (a === 'undo') store.undo();
    else if (a === 'redo') store.redo();
    else if (a === 'share') openShare(store);
    else if (a === 'export') exportGame();
    else if (a === 'play') play();
    else if (a === 'play-menu') playMenu(b);
    else if (a === 'issues') { editorEl.classList.add('show-right'); $('issues').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); $('issues').querySelector('button, .empty-ok')?.focus?.(); }
    else if (a === 'toggle-right') { const on = !editorEl.classList.contains('show-right'); editorEl.classList.toggle('show-right', on); b.setAttribute('aria-expanded', on); }
  });
}
function updateGenreChip() { $('genre-chip').textContent = genreById(store.genre).name; }
function updateHistory() {
  const u = $('undo'), r = $('redo');
  u.disabled = !store.canUndo(); r.disabled = !store.canRedo();
  u.dataset.tip = store.canUndo() ? `Undo ${store.undoLabel().toLowerCase()}` : 'Nothing to undo'; u.dataset.kbd = '⌘Z';
  r.dataset.tip = store.canRedo() ? `Redo ${store.redoLabel().toLowerCase()}` : 'Nothing to redo'; r.dataset.kbd = '⇧⌘Z';
}
function updateSaved(s) {
  const el = $('saved');
  if (!s?.ok) { el.className = 'tally tally--warn'; el.textContent = 'Not saved'; el.title = 'This browser would not store the game. Download the project from Export to keep it.'; return; }
  if (s.pending) { el.className = 'tally'; el.textContent = 'Saving'; return; }
  el.className = 'tally tally--ready'; el.textContent = 'Saved'; el.title = 'Saved in this browser';
  statusbar();
}
let issuesHtml = '';
function updateIssues() {
  const r = analyses.get(store.level.id)?.result;
  const b = $('issues-tally');
  // the tally is a polite live region: rewrite it only when the verdict changes, not after every edit
  const set = html => { if (html !== issuesHtml) { issuesHtml = html; b.innerHTML = html; } };
  if (!r) { set('<span class="tally"><span class="tally-word">Checking</span></span>'); return; }
  const e = r.issues.filter(x => x.severity === 'error').length, w = r.issues.filter(x => x.severity === 'warning').length;
  set(e ? `<span class="tally tally--live">${e}<span class="tally-word">&nbsp;error${e === 1 ? '' : 's'}</span></span>` : w ? `<span class="tally tally--warn">${w}<span class="tally-word">&nbsp;warning${w === 1 ? '' : 's'}</span></span>` : '<span class="tally tally--ready"><span class="tally-word">Ready</span></span>');
  b.setAttribute('aria-label', e ? `${e} errors in this level` : w ? `${w} warnings in this level` : 'No issues in this level');
}

// ============================================================== tool rail and phone bar
const TOOL_LIST = [
  ['select', 'Select and move', 'V', 'select'], ['brush', 'Brush', 'B', 'brush'], ['rect', 'Rectangle', 'U', 'rect'], ['fill', 'Fill', 'G', 'fill'],
  ['erase', 'Erase', 'E', 'erase'], ['pick', 'Pick a brush', 'I', 'pick'], ['link', 'Wire', 'L', 'link'], ['hand', 'Pan', 'H', 'hand'],
];
const OVERLAYS = [['grid', 'Grid', 'grid'], ['links', 'Wires', 'wire'], ['reach', 'Where the player can go', 'reach'], ['trace', 'Last playtest', 'trace'], ['issues', 'Issue markers', 'issue']];
function renderRail() {
  const st = store.state;
  const rail = $('toolrail');
  rail.innerHTML = `
    ${TOOL_LIST.map(([id, name, key, ic]) => `<button type="button" class="rail-btn" data-tool="${id}" aria-pressed="${st.tool === id}" aria-label="${name}" data-tip="${name}" data-kbd="${key}">${icon(ic)}<kbd aria-hidden="true">${key}</kbd></button>`).join('')}
    <div class="rail-sep"></div>
    <div class="rail-size" role="group" aria-label="Brush size">
      <button type="button" class="icon-btn icon-btn--sm" data-size="1" aria-label="Bigger brush" data-tip="Bigger brush" data-kbd="]">${icon('plus')}</button>
      <output aria-live="polite" title="Brush size">${st.brushSize}</output>
      <button type="button" class="icon-btn icon-btn--sm" data-size="-1" aria-label="Smaller brush" data-tip="Smaller brush" data-kbd="[">${icon('minus')}</button>
    </div>
    <div class="rail-sep"></div>
    ${OVERLAYS.map(([id, name, ic]) => `<button type="button" class="rail-btn" data-overlay="${id}" aria-pressed="${!!st.overlays[id]}" aria-label="Show ${name.toLowerCase()}" data-tip="${name}">${icon(ic)}</button>`).join('')}
    <button type="button" class="rail-btn" data-overlay="minimap" aria-pressed="${!vp._miniHidden}" aria-label="Show the minimap" data-tip="Minimap">${icon('minimap')}</button>
    <div class="rail-bottom">
      <button type="button" class="rail-btn" data-rail="help" aria-label="Keyboard shortcuts" data-tip="Shortcuts" data-kbd="?">${icon('keyboard')}</button>
    </div>`;
  if (!rail.dataset.wired) {
    rail.dataset.wired = '1';
    rail.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tool) store.setTool(b.dataset.tool);
      else if (b.dataset.size) store.setBrushSize(store.state.brushSize + +b.dataset.size);
      else if (b.dataset.overlay === 'minimap') { vp._miniHidden = !vp._miniHidden; vp.setMinimap(!vp._miniHidden); renderRail(); }
      else if (b.dataset.overlay) store.toggleOverlay(b.dataset.overlay);
      else if (b.dataset.rail === 'help') shortcuts();
    });
  }
}
function renderMobilebar() {
  const st = store.state;
  const bar = $('mobilebar');
  const item = (attr, name, ic, on) => `<button type="button" class="mb-btn" ${attr} aria-pressed="${on}">${icon(ic)}<span>${name}</span></button>`;
  bar.innerHTML = [
    item('data-mb="palette"', 'Palette', 'palette', editorEl.classList.contains('show-left')),
    item('data-tool="brush"', 'Paint', 'brush', st.tool === 'brush'),
    item('data-tool="erase"', 'Erase', 'erase', st.tool === 'erase'),
    item('data-tool="select"', 'Select', 'select', st.tool === 'select'),
    item('data-tool="link"', 'Wire', 'link', st.tool === 'link'),
    item('data-mb="undo"', 'Undo', 'undo', false),
    item('data-mb="inspect"', 'Inspect', 'sliders', editorEl.classList.contains('show-right')),
  ].join('');
  if (!bar.dataset.wired) {
    bar.dataset.wired = '1';
    bar.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tool) { store.setTool(b.dataset.tool); editorEl.classList.remove('show-left', 'show-right'); }
      else if (b.dataset.mb === 'palette') { editorEl.classList.remove('show-right'); editorEl.classList.toggle('show-left'); }
      else if (b.dataset.mb === 'inspect') { editorEl.classList.remove('show-left'); editorEl.classList.toggle('show-right'); }
      else if (b.dataset.mb === 'undo') store.undo();
      renderMobilebar();
    });
  }
}

function statusbar() {
  if (!store) return;
  const l = store.level, st = store.state;
  const brush = st.layer === 'entities' ? entityDef(st.brush.entities)?.name : null;
  const hints = {
    select: 'Click a part to select · drag to move · drag empty ground for a region',
    brush: `Painting ${brush || 'the active layer'} · shift-click for a line · right-drag erases`,
    rect: 'Drag a rectangle', fill: 'Click to fill the region', erase: 'Click or drag to erase',
    pick: 'Click to take a brush from the grid', link: 'Drag from a lever, plate or burrow to what it drives · click a wire to cut it', hand: 'Drag to pan',
  };
  const saved = st.savedAt ? new Date(st.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
  $('statusbar').innerHTML = `<span>${esc(genreById(store.genre).name)}</span><span>Level <b>${st.levelIndex + 1}/${store.project.levels.length}</b></span><span><b>${l.width} × ${l.height}</b></span><span>Parts <b>${l.entities.length}/${LIMITS.entities}</b></span><span class="grow">${esc(hints[st.tool] || '')}</span><span>Saved ${esc(saved)}</span>`;
}

// ============================================================== analysis (in a worker)
let worker = null, workerOk = true, reqId = 0;
const pending = new Map();
function getWorker() {
  if (worker || !workerOk) return worker;
  try {
    worker = new Worker('/src/play2d/editor/analysis-worker.js', { type: 'module' });
    worker.onmessage = e => { const cb = pending.get(e.data.id); pending.delete(e.data.id); cb?.(e.data); };
    worker.onerror = () => { workerOk = false; worker = null; for (const cb of pending.values()) cb({ ok: false, error: 'worker failed' }); pending.clear(); };
  } catch { workerOk = false; worker = null; }
  return worker;
}
/** Stop whatever the worker is chewing on (a stale puzzle solve can take a second). */
function restartWorker() {
  worker?.terminate();
  worker = null;
  for (const cb of pending.values()) cb({ ok: false, dropped: true });
  pending.clear();
}
function analyzeIndex(i, { urgent = false } = {}) {
  return new Promise(resolve => {
    const level = store.project.levels[i];
    if (!level) return resolve(null);
    const mini = { genre: store.project.genre, settings: store.project.settings, levels: [level] };
    if (urgent && pending.size) restartWorker();
    const w = getWorker();
    const my = ++stamp;
    const done = r => {
      if (r?.ok) analyses.set(level.id, { result: r.result, stamp: my });
      resolve(r?.ok ? r.result : null);
    };
    if (w) {
      const id = ++reqId;
      pending.set(id, done);
      w.postMessage({ id, project: mini, levelIndex: 0, opts: { maxNodes: 400000 } });
    } else {
      setTimeout(() => { try { done({ ok: true, result: analyzeLevel(mini, 0, { maxNodes: 60000 }) }); } catch (e) { done({ ok: false }); } }, 0);
    }
  });
}
function scheduleAnalysis(delay = 160) {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(async () => {
    const id = store.level.id;
    await analyzeIndex(store.state.levelIndex, { urgent: true });
    if (store.level.id === id) { panels.setAnalysis(analyses.get(id)?.result || null); vp.redraw(); updateIssues(); }
  }, delay);
}
async function analyzeAll() {
  await analyzeIndex(store.state.levelIndex);
  panels.setAnalysis(analyses.get(store.level.id)?.result || null); updateIssues(); vp.redraw();
  for (let i = 0; i < store.project.levels.length; i++) if (!analyses.has(store.project.levels[i].id)) await analyzeIndex(i);
  panels.setAnalysis(analyses.get(store.level.id)?.result || null);
}
function jumpTo(issue) {
  if (issue.level !== undefined && issue.level !== store.state.levelIndex) store.selectLevel(issue.level);
  editorEl.classList.remove('show-left', 'show-right');
  if (issue.at) requestAnimationFrame(() => { vp.centerOn(issue.at.x, issue.at.y, { flash: true }); vp.cursor = { ...issue.at }; });
  if (issue.entityId && store.entity(issue.entityId)) store.select([issue.entityId]);
  vp.canvas.focus({ preventScroll: true });
}

// ============================================================== playing
function play({ spawn = null, levelIndex = store.state.levelIndex, mode = 'playtest' } = {}) {
  if (playing) return;
  store.save(true);
  const r = analyses.get(store.project.levels[levelIndex].id)?.result;
  if (r && r.issues.some(x => x.id === 'no-player')) { toast('Place a player start first: pick Player start from the Parts palette.', 'warn'); return; }
  vp.setPaused(true); // the game covers the grid
  $('skip').hidden = true;
  playing = openPlaytest({
    host: $('playtest'), editor: editorEl, store, art, levelIndex, spawn, mode,
    onClose: result => {
      playing = null;
      vp.setPaused(app.dataset.view !== 'editor');
      $('skip').hidden = app.dataset.view !== 'editor';
      if (result && result.trace?.length) {
        const level = store.project.levels[result.levelIndex];
        store.setTrace({ levelId: level.id, points: result.trace, deaths: result.deaths || [], status: result.status, time: result.time });
        if (!store.state.overlays.trace) store.toggleOverlay('trace', true);
        const t = clock(result.time);
        if (result.status === 'won') toast(`Cleared in ${t}${result.stars ? ` · ${result.stars} star${result.stars === 1 ? '' : 's'}` : ''}. The trace shows your route.`, 'ok');
        else if (result.deaths?.length) toast(`${result.deaths.length} fall${result.deaths.length === 1 ? '' : 's'} in ${t}: the crosses on the trace show where.`);
        else toast(`Stopped after ${t}. The trace shows your route.`);
      }
      requestAnimationFrame(() => vp.canvas.focus({ preventScroll: true }));
    },
  });
}
function playMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const cell = vp.cursor || (vp.hover && vp.cellInside(vp.hover) ? vp.hover : null);
  const items = [
    { label: 'Play this level', kbd: 'F5', icon: 'play', run: () => play() },
    { label: 'Play from the cursor', kbd: 'P', icon: 'target', run: () => (cell ? play({ spawn: cell }) : toast('Hover or move the cell cursor to where you want to start, then press P.')) },
    { label: 'Play the whole game', icon: 'expand', run: () => play({ levelIndex: 0, mode: 'standalone' }) },
  ];
  if (COMPACT.matches) {
    items.push({ sep: true },
      { label: 'Share a link', icon: 'share', run: () => openShare(store) },
      { label: 'Export', icon: 'download', run: () => exportGame() });
    if (store.canRedo()) items.push({ label: `Redo ${store.redoLabel().toLowerCase()}`, icon: 'redo', run: () => store.redo() });
  }
  menu(r.right - 220, r.bottom + 6, items, { anchor });
}
function exportGame() {
  openExport({
    store,
    analyzeProject: () => analyzeProject(store.project, { maxNodes: 60000 }),
    onJump: jumpTo,
  });
}

// ============================================================== keyboard, theme, help
function globalKeys(e) {
  if (app.dataset.view !== 'editor' || playing || dialogOpen()) return;
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); return; }
  if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); store.redo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); store.save(true); toast('Saved in this browser. Export downloads a copy.', 'ok'); return; }
  if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); exportGame(); return; }
  if (e.key === 'F5' || (mod && e.key === 'Enter')) { e.preventDefault(); play(); return; }
  if (typing) return;
  if (e.key === '?') { e.preventDefault(); shortcuts(); }
}
function currentTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'daylight' : 'stage';
}
function toggleTheme() {
  const next = currentTheme() === 'daylight' ? 'stage' : 'daylight';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* the choice lasts this visit */ }
  document.querySelector('meta[name=theme-color]').content = next === 'daylight' ? '#eef1ff' : '#151a4d';
  vp?.refreshColors();
  if (store) renderRail();
}
function shortcuts() {
  const k = (...keys) => keys.map(x => `<kbd>${esc(x)}</kbd>`).join('');
  const group = (title, rows) => `<div><h3>${esc(title)}</h3><dl>${rows.map(([keys, what]) => `<dt>${keys}</dt><dd>${esc(what)}</dd>`).join('')}</dl></div>`;
  dialog({
    meta: 'Keyboard', title: 'Shortcuts', wide: true,
    body: `<div class="shortcuts">
      ${group('Tools', [[k('V'), 'Select and move'], [k('B'), 'Brush'], [k('U'), 'Rectangle'], [k('G'), 'Fill'], [k('E'), 'Erase'], [k('I'), 'Pick a brush (or Alt-click)'], [k('L'), 'Wire'], [k('H'), 'Pan (or hold Space)'], [k('[', ']'), 'Brush size']])}
      ${group('Palette and layers', [[k('1', '…', '9'), 'Pick from the palette'], [k('Q'), 'Terrain layer'], [k('W'), 'Decor layer'], [k('T'), 'Parts layer']])}
      ${group('Editing', [[k('⌘', 'Z'), 'Undo'], [k('⇧', '⌘', 'Z'), 'Redo'], [k('⌘', 'C') + k('X') + k('V'), 'Copy, cut, paste'], [k('⌘', 'D'), 'Duplicate'], [k('Del'), 'Delete the selection'], [k('F'), 'Flip a region'], [k('Esc'), 'Clear the selection'], [k('Shift'), 'Click: draw a line']])}
      ${group('View and play', [[k('Wheel'), 'Pan'], [k('⌘', 'Wheel'), 'Zoom'], [k('+') + k('−'), 'Zoom'], [k('0'), 'Fit the level'], [k('Arrows'), 'Move the cell cursor (grid focused)'], [k('Enter'), 'Use the tool at the cursor'], [k('P'), 'Play from the cursor'], [k('F5'), 'Play this level'], [k('⌘', 'S'), 'Save now'], [k('⌘', 'E'), 'Export']])}
    </div>`,
    actions: [{ label: 'Close', kind: 'secondary', value: 'close', autofocus: true }],
  });
}

// ============================================================== thumbnails for the level strip
function drawThumb(canvas, i) {
  const l = store.project.levels[i];
  if (l) drawLevelThumb(canvas, l, store.genre, art);
}

function clock(s) { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

installTooltips(document.body);
boot().catch(err => { console.error(err); toast(`Something went wrong starting the builder: ${err.message}`, 'error', { ms: 8000 }); });
