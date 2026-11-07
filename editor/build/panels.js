/**
 * The level editor's panels (docs/EDITOR.md): the tool rail, the outliner and the palette, the inspector, the checks,
 * the level and game settings, the levels strip, the top bar and the status bar. Plain DOM rendered from the store
 * (editor/build/store.js) and the app's latest compile; every action goes back through the store, so it is one undo
 * step with a name. Real buttons, labels and form controls; tabs and radio groups follow the ARIA patterns and the
 * arrow keys; nothing is told by colour alone.
 */
import { icon } from './icons.js';
import { TOOLS, isKeyRef, label as stepLabel } from './store.js';
import { entityLabel, generatedLabel } from './pick.js';
import { ENTITY_TYPES, ENTITY_GROUPS, KEY_COLORS, PLACEABLE_PROPS, SCALE_RANGE, EDIT_LIMITS } from '../../src/world/level/entities.js';
import { REGION_KINDS, decodeRegions, regionCounts } from '../../src/world/level/regions.js';
import { FIXED_KEY, DEFAULT_START } from '../../src/world/level/edits.js';
import { MAX_LEVELS } from '../../src/world/level/game.js';
import { issueCounts, BUDGETS } from '../../src/world/level/checks.js';
import { CATALOG } from '../../src/world/catalog.js';
import { NATURE_PARTS } from '../../src/world/natureParts.js';
import { OBJECTIVE_KINDS } from '../../src/world/blueprint.js';
import { GENRES } from '../../src/genres/registry.js';
import { assetURL } from '../../src/config/assetDelivery.js';
import { levelPar } from '../../src/world/levelPar.js';
import { formatTime } from '../../src/world/missionCard.js';

export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (root, s) => root.querySelector(s);
const deg = r => Math.round(r * 180 / Math.PI);
const rad = d => d * Math.PI / 180;
const cap = s => s[0].toUpperCase() + s.slice(1);

export const TOOL_INFO = {
  select: { label: 'Select', key: 'V', hint: 'Click to select, Shift-click to add, drag on empty ground to box-select. Drag the view to orbit.' },
  move: { label: 'Move', key: 'W', hint: 'Drag the gizmo, or drag a selected thing on the ground. Hold Alt to ignore snapping.' },
  rotate: { label: 'Turn', key: 'E', hint: 'Drag the ring to turn the selection. Snaps to 15°; hold Alt for free turning.' },
  scale: { label: 'Scale', key: 'R', hint: 'Drag the corner handle. Props scale from half to twice their size.' },
  place: { label: 'Place', key: 'B', hint: 'Click the ground to place what the palette has chosen. [ and ] turn it.' },
  paint: { label: 'Paint', key: 'N', hint: 'Paint spawn zones, paths and no-go ground. [ and ] change the brush; Alt-drag erases.' },
  wire: { label: 'Wire', key: 'L', hint: 'Drag from a lever or a trigger zone to a door or a critter. Click a wire’s end in the inspector to cut it.' },
  erase: { label: 'Erase', key: 'X', hint: 'Click a thing to delete it; generated things can be restored from the inspector.' },
};
const CAMERA_INFO = { orbit: { label: 'Orbit', key: 'O', icon: 'orbit' }, top: { label: 'Top', key: 'T', icon: 'top' }, fly: { label: 'Fly', key: 'Y', icon: 'fly' } };
const TYPE_ICON = { enemy: 'enemy', pickup: 'heart', key: 'key', collectible: 'drop', door: 'door', lever: 'lever', trigger: 'zone', checkpoint: 'flag', prop: 'cube', start: 'start', generated: 'cube' };
/** A generated thing's icon, by what its key says it is. */
const TREES = /^(tree|broadleaf|willow|conifer|blossom|sapling|orchard)@/, FLORA = /^(flora|bush|tuft|flowers|mushrooms|reeds|stump|shore)@/;
const refIcon = (ref, kind, record) => kind !== 'generated' ? TYPE_ICON[kind] ?? 'cube'
  : ref.startsWith('step:') ? (record?.pickup === 'collectible' ? 'drop' : 'pad') : ref.startsWith('enemy:') ? 'enemy' : ref.startsWith('gate:') ? 'door' : ref.startsWith('house@') ? 'house'
  : TREES.test(ref) ? 'tree' : FLORA.test(ref) ? 'flower' : /^(healthSupply)@/.test(ref) ? 'heart' : 'cube';
const GROUP_ORDER = ['player', 'mission', 'enemies', 'items', 'logic', 'props', 'village'];
const GROUP_LABEL = { ...Object.fromEntries(Object.entries(ENTITY_GROUPS).map(([k, v]) => [k, v.label])), mission: 'Mission', village: 'Generated village' };

/** The palette: every placeable thing, by group, with its card picture where the catalogue has one. */
export function paletteItems(genre) {
  const cat = CATALOG.arcade, card = id => cat.props.find(p => p.id === id)?.preview ?? cat.gear.find(p => p.id === id)?.preview;
  const items = [];
  for (const e of cat.enemies) items.push({ id: `enemy:${e.id}`, type: 'enemy', props: { kind: e.id }, label: e.label, sub: e.boss ? 'Heavy' : 'Critter', art: e.preview, group: 'enemies' });
  for (const [kind, pid, name] of [['health', 'healthSupply', 'Honey jar'], ['ammo', 'ammoSupply', 'Pebble pouch'], ['grenade', 'grenadeSupply', 'Fizz-bomb']]) {
    if (kind !== 'health' && !genre.weapons) continue;
    items.push({ id: `pickup:${kind}`, type: 'pickup', props: { kind }, label: name, sub: 'Supply', art: card(pid), group: 'items' });
  }
  for (const c of KEY_COLORS) items.push({ id: `key:${c}`, type: 'key', props: { color: c }, label: `${cap(c)} key`, sub: 'Opens its colour', art: card('keyAmber'), group: 'items', tint: c });
  items.push({ id: 'collectible', type: 'collectible', props: {}, label: 'Honey drop', sub: 'Collect', art: card('honeyDrop'), group: 'items' });
  items.push({ id: 'door:hold', type: 'door', props: { lock: 'hold' }, label: 'Door', sub: 'Hold to open', art: card('woodGate') ?? cat.doors[0]?.preview, group: 'logic' });
  for (const c of KEY_COLORS) items.push({ id: `door:${c}`, type: 'door', props: { lock: c }, label: `${cap(c)} door`, sub: 'Needs its key', art: card('lockAmber'), group: 'logic', tint: c });
  items.push({ id: 'door:wired', type: 'door', props: { lock: 'wired' }, label: 'Wired door', sub: 'Lever or zone', art: cat.doors[0]?.preview, group: 'logic' });
  items.push({ id: 'lever', type: 'lever', props: {}, label: 'Lever', sub: 'Drives wires', art: card('lever'), group: 'logic' });
  items.push({ id: 'trigger', type: 'trigger', props: {}, label: 'Trigger zone', sub: 'Drives wires', icon: 'zone', group: 'logic' });
  items.push({ id: 'checkpoint', type: 'checkpoint', props: {}, label: 'Checkpoint', sub: 'Respawn here', icon: 'flag', group: 'logic' });
  for (const pid of PLACEABLE_PROPS) {
    const p = cat.props.find(x => x.id === pid);
    items.push({ id: `prop:${pid}`, type: 'prop', props: { prop: pid, variant: '' }, label: { hayBarricade: 'Hay bale', house: 'House', tree: 'Tree', nature: 'Plant' }[pid] ?? p?.label ?? cap(pid), sub: { house: 'Grown from a plan', tree: 'Grown from a plan', nature: 'Flora' }[pid] ?? 'Prop', art: p?.preview, group: 'props' });
  }
  return items;
}

/** Variant choices for a prop, from the level's pack (a house family, a tree species, a flora part). */
function variantOptions(prop, pack) {
  if (prop === 'house') return Object.keys(pack?.houses?.families ?? {}).map(v => [v, cap(v)]);
  if (prop === 'tree') return Object.keys(pack?.trees?.species ?? {}).map(v => [v, cap(v)]);
  if (prop === 'nature') return Object.keys(NATURE_PARTS).filter(p => !/^(pool|bridge|lily|stone\.bank)/.test(p)).map(v => [v, cap(v.replace('.', ' '))]);
  return [];
}

export function createPanels(root, { store, app }) {
  const els = {
    rail: $(root, '#bld-rail'), outliner: $(root, '#bld-outliner'), palette: $(root, '#bld-palette'), inspector: $(root, '#bld-inspector'),
    checks: $(root, '#bld-checks'), level: $(root, '#bld-level'), levels: $(root, '#bld-levels'), status: $(root, '#bld-status'),
    name: $(root, '#bld-name'), genre: $(root, '#bld-genre'), saved: $(root, '#bld-saved'), undo: $(root, '#bld-undo'), redo: $(root, '#bld-redo'),
    issues: $(root, '#bld-issues'), camera: $(root, '#bld-camera'), mobile: $(root, '#bld-mobile'),
  };
  const ui = { leftTab: 'outliner', rightTab: 'inspector', open: new Set(['player', 'mission', 'enemies', 'items', 'logic', 'props']), search: '', palGroup: 'all', palSearch: '', hint: '', cursor: null, fps: null };

  // ------------------------------------------------------------------ rail
  function renderRail() {
    const tools = TOOLS.map(t => `<button type="button" class="bld-tool" data-tool="${t}" aria-pressed="${store.state.tool === t}" aria-label="${TOOL_INFO[t].label} (${TOOL_INFO[t].key})" data-tip="${TOOL_INFO[t].label}" data-kbd="${TOOL_INFO[t].key}">${icon(t)}</button>`);
    tools.splice(4, 0, '<hr>'); tools.splice(8, 0, '<hr>');
    els.rail.innerHTML = tools.join('') + `<hr><button type="button" class="bld-tool" data-bld="panels-left" aria-label="Outliner and palette" aria-expanded="${root.dataset.left === 'open'}" data-tip="Outliner and palette">${icon('layers')}</button>`;
    els.camera.innerHTML = Object.entries(CAMERA_INFO).map(([m, c]) => `<button type="button" role="radio" data-camera="${m}" aria-checked="${app.camera.mode === m}" tabindex="${app.camera.mode === m ? 0 : -1}" aria-label="${c.label} camera (${c.key})">${icon(c.icon)}<span>${c.label}</span></button>`).join('');
    const snap = root.querySelector('[data-bld="snap"]'), grid = root.querySelector('[data-bld="grid"]'), reach = root.querySelector('[data-bld="reach"]');
    snap.setAttribute('aria-pressed', String(store.state.snap)); grid.setAttribute('aria-pressed', String(app.view.grid)); reach.setAttribute('aria-pressed', String(app.view.reach));
    renderMobile();
  }

  function renderMobile() {
    const t = store.state.tool;
    els.mobile.innerHTML = [['select', 'Select'], ['move', 'Move'], ['place', 'Place']].map(([id, l]) => `<button type="button" data-tool="${id}" aria-pressed="${t === id}">${icon(id)}${l}</button>`).join('')
      + `<button type="button" data-bld="sheet-left" aria-pressed="${root.dataset.left === 'open'}">${icon('palette')}Library</button>`
      + `<button type="button" data-bld="sheet-right" aria-pressed="${root.dataset.right === 'open'}">${icon('sliders')}Inspect</button>`
      + `<button type="button" data-bld="tools-more" aria-haspopup="menu">${icon('dots')}More</button>`;
  }

  // ------------------------------------------------------------------ top bar
  function renderTop() {
    const g = store.game;
    if (document.activeElement !== els.name) els.name.value = g.name;
    els.genre.textContent = GENRES[g.genre]?.label ?? g.genre;
    els.undo.disabled = !store.canUndo(); els.redo.disabled = !store.canRedo();
    els.undo.title = store.canUndo() ? `Undo ${store.undoLabel()} (Ctrl Z)` : 'Nothing to undo';
    els.redo.title = store.canRedo() ? `Redo ${store.redoLabel()} (Ctrl Shift Z)` : 'Nothing to redo';
    els.undo.setAttribute('aria-label', store.canUndo() ? `Undo ${store.undoLabel()}` : 'Undo');
    els.redo.setAttribute('aria-label', store.canRedo() ? `Redo ${store.redoLabel()}` : 'Redo');
    els.saved.dataset.state = store.state.saved ? 'saved' : 'dirty';
    els.saved.textContent = store.state.saved ? 'Saved' : 'Saving…';
    const c = issueCounts(app.checks?.issues ?? []), error = app.compileError;
    els.issues.innerHTML = error ? `<b class="is-error">1</b><span>Can't build</span>`
      : c.error || c.warning ? `${c.error ? `<b class="is-error">${c.error}</b>` : ''}${c.warning ? `<b class="is-warning">${c.warning}</b>` : ''}<span>Checks</span>`
      : `<b class="is-clean">0</b><span>Checks clear</span>`;
    els.issues.setAttribute('aria-label', error ? 'The level cannot be built. Open the checks.' : `${c.error} errors, ${c.warning} warnings. Open the checks.`);
  }

  // ------------------------------------------------------------------ outliner
  function outlineRows() {
    const items = app.pickables ?? [], issueRefs = new Map();
    for (const i of app.checks?.issues ?? []) if (i.ref && !issueRefs.has(i.ref)) issueRefs.set(i.ref, i.severity);
    const groups = Object.fromEntries(GROUP_ORDER.map(g => [g, []]));
    for (const it of items) (groups[it.group] ?? groups.village).push({ ...it, flag: issueRefs.get(it.ref) });
    return groups;
  }
  function renderOutliner() {
    const groups = outlineRows(), q = ui.search.trim().toLowerCase(), sel = new Set(store.state.selection);
    const focused = document.activeElement?.closest?.('#bld-outliner') ? document.activeElement.dataset.ref : null;
    let html = `<label class="bld-search">${icon('select')}<span class="sr-only">Find in the level</span><input type="search" id="bld-find" placeholder="Find in the level" value="${esc(ui.search)}"></label><ul class="bld-tree">`;
    for (const g of GROUP_ORDER) {
      let rows = groups[g];
      if (q) rows = rows.filter(r => r.label.toLowerCase().includes(q) || r.ref.toLowerCase().includes(q));
      if (!rows.length && (q || g === 'village')) continue;
      const open = ui.open.has(g) || !!q, limit = g === 'village' && !q ? 60 : 400;
      html += `<li class="bld-layer"><div class="bld-layer__head"><button type="button" class="bld-layer__toggle" data-layer="${g}" aria-expanded="${open}">${icon('chevronDown')}${esc(GROUP_LABEL[g])}<span class="bld-layer__count">${rows.length}</span></button></div>`;
      if (open) {
        html += '<ul class="bld-rows" role="listbox" aria-multiselectable="true" aria-label="' + esc(GROUP_LABEL[g]) + '">';
        for (const r of rows.slice(0, limit)) html += `<li><button type="button" class="bld-row" role="option" data-ref="${esc(r.ref)}" aria-selected="${sel.has(r.ref)}">${icon(refIcon(r.ref, r.kind, r.record))}<span>${esc(r.label)}</span>${r.flag ? `<i class="bld-flag bld-flag--${r.flag}" title="${r.flag === 'error' ? 'Has an error' : 'Has a warning'}"></i><span class="sr-only">${r.flag}</span>` : ''}<small>${Math.round(r.x)}, ${Math.round(r.z)}</small></button></li>`;
        if (rows.length > limit) html += `<li class="bld-more">${rows.length - limit} more · search to find them</li>`;
        html += '</ul>';
      }
      html += '</li>';
    }
    html += '</ul>';
    els.outliner.innerHTML = html;
    if (focused) els.outliner.querySelector(`[data-ref="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------ palette
  function renderPalette() {
    const genre = GENRES[store.game.genre], items = paletteItems(genre), edits = store.edits, q = ui.palSearch.trim().toLowerCase();
    const placing = store.state.tool === 'place' ? store.state.placing : null;
    const count = type => edits.entities.filter(e => e.type === type).length;
    let html = `<div class="bld-pal-groups" role="group" aria-label="Filter">${['all', 'enemies', 'items', 'logic', 'props', 'regions'].map(g => `<button type="button" class="bld-chipbtn" data-pal-group="${g}" aria-pressed="${ui.palGroup === g}">${g === 'all' ? 'All' : g === 'regions' ? 'Ground' : ENTITY_GROUPS[g].label}</button>`).join('')}</div>`;
    html += `<label class="bld-search">${icon('select')}<span class="sr-only">Find a thing to place</span><input type="search" id="bld-pal-find" placeholder="Find a thing to place" value="${esc(ui.palSearch)}"></label>`;
    if (ui.palGroup === 'all' || ui.palGroup === 'regions') {
      html += `<h3 class="bld-h">Paint the ground</h3><div class="bld-cards">${Object.entries(REGION_KINDS).map(([id, k]) => `<button type="button" class="bld-card" data-region="${id}" aria-pressed="${store.state.tool === 'paint' && store.state.brush.region === id}" title="${esc(k.hint)}"><span class="bld-card__art bld-card__art--swatch bld-card__art--${id}" aria-hidden="true"></span><span class="bld-card__label">${esc(k.label)}<small>${id === 'spawn' ? 'Dots' : id === 'path' ? 'Solid' : 'Stripes'}</small></span></button>`).join('')}</div>`;
    }
    for (const g of ['enemies', 'items', 'logic', 'props']) {
      if (ui.palGroup !== 'all' && ui.palGroup !== g) continue;
      const list = items.filter(i => i.group === g && (!q || i.label.toLowerCase().includes(q) || i.sub.toLowerCase().includes(q)));
      if (!list.length) continue;
      html += `<h3 class="bld-h">${ENTITY_GROUPS[g].label}</h3><div class="bld-cards">`;
      for (const it of list) {
        const n = count(it.type), lim = ENTITY_TYPES[it.type].limit, on = placing && placing.type === it.type && JSON.stringify(placing.props) === JSON.stringify({ ...placing.props, ...it.props });
        html += `<button type="button" class="bld-card" data-place="${esc(it.id)}" aria-pressed="${!!on}" ${n >= lim ? 'disabled' : ''} title="${esc(ENTITY_TYPES[it.type].hint)}"><span class="bld-card__art">${it.art ? `<img loading="lazy" src="${esc(assetURL(it.art))}" alt="" ${it.tint ? `style="filter:${it.tint === 'ice' ? 'hue-rotate(170deg) saturate(1.2)' : it.tint === 'rose' ? 'hue-rotate(-35deg) saturate(1.1)' : 'none'}"` : ''}>` : icon(it.icon ?? 'cube')}</span><span class="bld-card__label">${esc(it.label)}<small>${esc(it.sub)}</small></span><span class="bld-card__cap ${n >= lim ? 'is-full' : ''}">${n}/${lim}</span></button>`;
      }
      html += '</div>';
    }
    els.palette.innerHTML = html;
  }

  // ------------------------------------------------------------------ inspector
  const numField = (key, labelText, value, { step = 0.5, min = -38, max = 38, unit = '' } = {}) =>
    `<div class="bld-num"><span>${esc(labelText)}</span><input type="number" data-t="${key}" value="${value}" step="${step}" min="${min}" max="${max}" aria-label="${esc(labelText)}${unit ? ` in ${unit}` : ''}"></div>`;
  function transformFields(t, { yaw = true, scale = false, disabled = false } = {}) {
    return `<div class="bld-field bld-field--row"><span class="bld-field__label">Position</span>${numField('x', 'X', t.x.toFixed(1), { unit: 'metres' })}${numField('z', 'Z', t.z.toFixed(1), { unit: 'metres' })}${yaw ? numField('yaw', '°', deg(t.yaw ?? 0), { step: 15, min: -180, max: 180, unit: 'degrees' }) : '<span></span>'}</div>`
      + (scale ? `<div class="bld-field"><label for="bld-scale">Scale</label><input id="bld-scale" type="range" data-t="scale" min="${SCALE_RANGE[0]}" max="${SCALE_RANGE[1]}" step="0.05" value="${t.scale ?? 1}" aria-valuetext="${Math.round((t.scale ?? 1) * 100)} percent"></div>` : '')
      + (disabled ? '' : '');
  }
  function propFields(e) {
    const def = ENTITY_TYPES[e.type], pack = app.level?.pack;
    let html = '';
    for (const [k, f] of Object.entries(def.props)) {
      const id = `bld-p-${k}`, v = e.props[k];
      let control;
      if (f.type === 'enum') control = `<select id="${id}" data-p="${k}">${f.values.map(o => `<option value="${o}" ${o === v ? 'selected' : ''}>${esc(enumLabel(k, o))}</option>`).join('')}</select>`;
      else if (f.type === 'enemy') control = `<select id="${id}" data-p="${k}">${CATALOG.arcade.enemies.map(x => `<option value="${x.id}" ${x.id === v ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>`;
      else if (f.type === 'prop') control = `<select id="${id}" data-p="${k}">${PLACEABLE_PROPS.map(x => `<option value="${x}" ${x === v ? 'selected' : ''}>${esc(paletteName(x))}</option>`).join('')}</select>`;
      else if (f.type === 'variant') {
        const opts = variantOptions(e.props.prop, pack);
        if (!opts.length) continue;
        control = `<select id="${id}" data-p="${k}"><option value="" ${!v ? 'selected' : ''}>First</option>${opts.map(([o, l]) => `<option value="${o}" ${o === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
      } else control = `<input id="${id}" type="number" data-p="${k}" min="${f.min}" max="${f.max}" step="${f.step ?? 1}" value="${v}">`;
      html += `<div class="bld-field"><label for="${id}">${esc(f.label)}</label>${control}</div>`;
    }
    return html;
  }
  function wiresOf(e) {
    const def = ENTITY_TYPES[e.type], edits = store.edits;
    if (!def.wireOut && !def.wireIn) return '';
    const out = edits.wires.filter(w => w.from === e.id), inn = edits.wires.filter(w => w.to === e.id);
    const row = (w, other) => { const o = store.entity(other); return `<li>${icon(TYPE_ICON[o?.type] ?? 'cube')}<span>${esc(o ? entityLabel(o) : other)}</span><button type="button" class="bld-btn bld-btn--ghost bld-btn--sm" data-unwire="${w.from}>${w.to}" aria-label="Cut the wire to ${esc(o ? entityLabel(o) : other)}">Cut</button></li>`; };
    let html = `<h3 class="bld-h">${def.wireOut ? 'Drives' : 'Driven by'}</h3>`;
    const list = def.wireOut ? out.map(w => row(w, w.to)) : inn.map(w => row(w, w.from));
    html += list.length ? `<ul class="bld-wires">${list.join('')}</ul>` : `<p class="bld-note">${def.wireOut ? 'Nothing yet. Wire it to a door or a critter.' : e.type === 'door' && e.props.lock === 'wired' ? 'Nothing yet: this door can never open. Wire a lever or a trigger zone to it.' : 'Nothing: it follows its own rules.'}</p>`;
    if (def.wireOut) html += `<button type="button" class="bld-btn bld-btn--secondary bld-btn--sm" data-bld="wire-from">${icon('wire')}Wire to…</button>`;
    return html;
  }
  function renderInspector() {
    const sel = store.state.selection, focusKey = document.activeElement?.dataset?.t ?? document.activeElement?.dataset?.p ?? null;
    let html = '';
    if (!sel.length) {
      const edits = store.edits, counts = regionCounts(decodeRegions(edits.regions));
      html = `<div class="bld-selinfo">${icon('layers')}<div><h3>${esc(store.level.name)}</h3><p>${edits.entities.length} placed · ${Object.keys(edits.overrides).length} changes · ${edits.wires.length} wires</p></div></div>`
        + `<p class="bld-note">Pick a thing in the view or the outliner to edit it. Choose from the palette and click the ground to place. Painted ground: ${counts.spawn} spawn, ${counts.path} path, ${counts.nogo} no-go cells.</p>`
        + `<h3 class="bld-h">Keys</h3><p class="bld-note"><kbd>V</kbd> select · <kbd>W</kbd> move · <kbd>E</kbd> turn · <kbd>R</kbd> scale · <kbd>B</kbd> place · <kbd>N</kbd> paint · <kbd>L</kbd> wire · <kbd>X</kbd> erase · <kbd>F</kbd> frame · <kbd>Ctrl D</kbd> duplicate · <kbd>Del</kbd> delete · <kbd>F5</kbd> play</p>`;
    } else if (sel.length > 1) {
      const placed = sel.filter(r => !isKeyRef(r) && r !== 'start').length;
      html = `<div class="bld-selinfo">${icon('select')}<div><h3>${sel.length} selected</h3><p>${placed} placed · ${sel.length - placed} generated or start</p></div></div>`
        + `<div class="bld-actions"><button type="button" class="bld-btn bld-btn--secondary bld-btn--sm" data-bld="duplicate" ${placed ? '' : 'disabled'}>${icon('copy')}Duplicate</button><button type="button" class="bld-btn bld-btn--danger bld-btn--sm" data-bld="delete">${icon('trash')}Delete</button><button type="button" class="bld-btn bld-btn--ghost bld-btn--sm" data-bld="focus">${icon('focus')}Frame</button></div>`;
    } else {
      const ref = sel[0];
      if (ref === 'start') {
        const s = store.edits.start ?? DEFAULT_START;
        html = `<div class="bld-selinfo">${icon('start')}<div><h3>Player start</h3><p>${store.edits.start ? 'Moved' : 'Where the generator starts'}</p></div></div>${transformFields(s)}`
          + `<div class="bld-actions"><button type="button" class="bld-btn bld-btn--secondary bld-btn--sm" data-bld="play-here-sel">${icon('playFrom')}Play from here</button>${store.edits.start ? `<button type="button" class="bld-btn bld-btn--ghost bld-btn--sm" data-bld="reset-start">${icon('restore')}Back to the generator's</button>` : ''}</div>`;
      } else if (!isKeyRef(ref)) {
        const e = store.entity(ref);
        if (!e) { store.select([]); return; }
        const def = ENTITY_TYPES[e.type];
        html = `<div class="bld-selinfo">${icon(TYPE_ICON[e.type])}<div><h3>${esc(entityLabel(e))}</h3><p>${esc(ENTITY_GROUPS[def.group].label)} · ${esc(e.id)}</p></div></div><p class="bld-note">${esc(def.hint)}</p>`
          + transformFields({ ...e }, { scale: !!def.scalable }) + propFields(e) + wiresOf(e)
          + `<div class="bld-actions"><button type="button" class="bld-btn bld-btn--secondary bld-btn--sm" data-bld="duplicate">${icon('copy')}Duplicate</button><button type="button" class="bld-btn bld-btn--secondary bld-btn--sm" data-bld="play-here-sel">${icon('playFrom')}Play from here</button><button type="button" class="bld-btn bld-btn--danger bld-btn--sm" data-bld="delete">${icon('trash')}Delete</button></div>`;
      } else {
        const item = app.pickables?.find(p => p.ref === ref), o = store.edits.overrides[ref], fixed = FIXED_KEY.test(ref), pad = ref.startsWith('step:');
        const step = pad ? app.level?.blueprint.mission.find(s => ref.startsWith(`step:${s.id}:`)) : null;
        const t = o && !o.removed ? { yaw: item?.record?.yaw ?? 0, ...o } : { x: item?.x ?? 0, z: item?.z ?? 0, yaw: item?.record?.yaw ?? 0 };
        html = `<div class="bld-selinfo">${icon(pad ? (item?.record?.pickup === 'collectible' ? 'drop' : 'pad') : ref.startsWith('enemy:') ? 'enemy' : ref.startsWith('house') ? 'house' : 'cube')}<div><h3>${esc(item?.label ?? generatedLabel(ref))}</h3><p>Generated${step ? ` · ${esc(OBJECTIVE_KINDS[step.objective].label)}` : ''}${o ? (o.removed ? ' · removed' : ' · moved') : ''}</p></div></div>`
          + `<p class="bld-note">${fixed ? 'Stands on ground levelled for it: remove it, or place your own.' : pad ? `A mission step’s ${item?.record?.pickup === 'collectible' ? 'honey drop' : 'pad'}: move it anywhere. The step itself (and how many it lays) lives in the mission graph.` : 'Made by the generator. Move or remove it; your change survives a reload and edits elsewhere.'}</p>`
          + (fixed ? '' : transformFields(t))
          + `<div class="bld-actions">${pad ? `<button type="button" class="bld-btn bld-btn--secondary bld-btn--sm" data-bld="graph">${icon('graph')}Mission graph</button>` : `<button type="button" class="bld-btn bld-btn--danger bld-btn--sm" data-bld="delete">${icon('trash')}Remove</button>`}${o ? `<button type="button" class="bld-btn bld-btn--ghost bld-btn--sm" data-restore="${esc(ref)}">${icon('restore')}Restore</button>` : ''}</div>`;
      }
    }
    els.inspector.innerHTML = html;
    if (focusKey) els.inspector.querySelector(`[data-t="${focusKey}"],[data-p="${focusKey}"]`)?.focus({ preventScroll: true });
  }
  function enumLabel(key, v) {
    if (key === 'lock') return v === 'hold' ? 'Hold to open' : v === 'wired' ? 'A wire (lever or zone)' : `The ${v} key`;
    if (key === 'behavior') return v === 'hunt' ? 'Hunts the player' : 'Guards its spot';
    if (key === 'kind') return { health: 'Honey jar (health)', ammo: 'Pebble pouch (ammo)', grenade: 'Fizz-bomb (grenade)' }[v] ?? cap(v);
    return cap(v);
  }
  const paletteName = id => ({ hayBarricade: 'Hay bale', nature: 'Plant' }[id] ?? cap(id));

  // ------------------------------------------------------------------ checks
  function meter(labelText, value, max, warnAt) {
    const k = Math.min(1, value / max), cls = value > max ? 'is-over' : warnAt !== null && value > warnAt ? 'is-warn' : '';
    return `<div class="bld-meter ${cls}"><span>${esc(labelText)}</span><b>${value} / ${max}</b><div class="bld-meter__track" role="meter" aria-label="${esc(labelText)}" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${value}"><div class="bld-meter__fill" style="transform:scaleX(${k.toFixed(3)})"></div></div></div>`;
  }
  function renderChecks() {
    let html = '';
    if (app.compileError) {
      html = `<div class="bld-issue bld-issue--error"><span class="bld-issue__sev">Error</span><p>${esc(app.compileError)}</p><div class="bld-issue__acts"><button type="button" class="bld-btn bld-btn--secondary bld-btn--sm" data-bld="graph">${icon('graph')}Mission graph</button></div></div>`;
      els.checks.innerHTML = html; return;
    }
    const st = app.checks?.stats;
    if (st) html += `<h3 class="bld-h">Budgets</h3><div class="bld-meters">${meter('Critters awake at the start', st.critters, BUDGETS.crittersDesktop, BUDGETS.crittersPhone)}${meter('Props', st.props, BUDGETS.propsDesktop, BUDGETS.propsPhone)}${meter('Placed things', st.placed, EDIT_LIMITS.entities, null)}</div>`
      + `<p class="bld-note">${st.reached ? `${Math.round(st.reached / Math.max(1, st.walkable) * 100)}% of the walkable ground is reachable from the start` : 'Nothing is reachable from the start'}${st.doors ? `; ${st.doorsOpened} of ${st.doors} doors can be opened` : ''}.</p>`;
    const issues = app.checks?.issues ?? [];
    html += `<h3 class="bld-h">Issues<small>${issues.length}</small></h3>`;
    if (!issues.length) html += `<div class="bld-clean">${icon('check')}Every pad, key and lever is in reach, and the budgets hold.</div>`;
    for (const i of issues) {
      html += `<div class="bld-issue bld-issue--${i.severity}"><span class="bld-issue__sev">${i.severity === 'error' ? 'Error' : i.severity === 'warning' ? 'Warn' : 'Tip'}</span><p>${esc(i.message)}</p><div class="bld-issue__acts">`
        + (i.at ? `<button type="button" class="bld-btn bld-btn--ghost bld-btn--sm" data-jump="${esc(i.id)}">${icon('focus')}Jump</button>` : '')
        + (i.code === 'orphan' ? `<button type="button" class="bld-btn bld-btn--ghost bld-btn--sm" data-drop="${esc(i.ref)}">${icon('trash')}Drop change</button>` : '')
        + '</div></div>';
    }
    els.checks.innerHTML = html;
    const n = issues.filter(i => i.severity !== 'tip').length;
    $(root, '#bld-tab-checks').innerHTML = `Checks${n ? `<span class="bld-count">${n}</span>` : ''}`;
  }

  // ------------------------------------------------------------------ level and game settings
  function renderLevel() {
    const g = store.game, lvl = store.level, flat = app.flat(), genre = GENRES[g.genre], worldNode = lvl.blueprint?.nodes.find(n => n.kind === 'world');
    const worlds = CATALOG.arcade.world, currentWorld = worldNode?.items[0] ?? worlds[0].id, mission = app.level?.blueprint.mission ?? [];
    const sel = (id, labelText, options, value, attrs = '') => `<div class="bld-field"><label for="${id}">${esc(labelText)}</label><select id="${id}" ${attrs}>${options.map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
    let html = `<h3 class="bld-h">This level</h3>`
      + `<div class="bld-field"><label for="bld-lvl-name">Name</label><input id="bld-lvl-name" type="text" maxlength="40" value="${esc(lvl.name)}"></div>`
      + sel('bld-lvl-world', 'World', worlds.map(w => [w.id, w.label]), currentWorld, 'data-level="world"')
      + `<div class="bld-field"><label for="bld-lvl-seed">Seed</label><div style="display:flex;gap:6px"><input id="bld-lvl-seed" type="text" maxlength="24" value="${esc(flat.seed)}" spellcheck="false" style="font-family:var(--font-mono);font-size:12px"><button type="button" class="bld-icon" data-bld="reseed" aria-label="New variation">${icon('shuffle')}</button></div></div>`
      + `<p class="bld-note">A new seed grows a new village; your placed things stay, and changes to generated things that no longer exist are listed in Checks.</p>`
      + sel('bld-game-ground', 'Ground', [['world', 'Its seed’s Visigenesis world'], ['village', 'The village’s own hills']], g.ground ?? 'village', 'data-game="ground"')
      + `<p class="bld-note" id="bld-ground-note">${esc(groundNote(app.level))}</p>`
      + sel('bld-lvl-light', 'Time of day', [['dawn', 'Sunny day'], ['night', 'Golden hour']], flat.lighting, 'data-level="lighting"')
      + (genre.weapons || g.genre !== 'exploration' ? `<div class="bld-field"><label for="bld-lvl-enemies">Generated critters</label><input id="bld-lvl-enemies" type="number" min="${genre.id === 'exploration' ? 0 : 1}" max="12" value="${flat.enemyCount}" data-level="enemyCount"></div>` : '')
      + sel('bld-lvl-behavior', 'Critters', [['guard', 'Guard and respond'], ['hunt', 'Hunt the player']], flat.behavior, 'data-level="behavior"')
      + sel('bld-lvl-cover', 'Generated cover', [['light', 'Light'], ['balanced', 'Balanced'], ['dense', 'Dense']], flat.cover, 'data-level="cover"')
      + `<h3 class="bld-h">Mission<small>${mission.length} steps</small></h3>`
      + (mission.length ? `<ol class="bld-wires" style="list-style:decimal inside">${mission.map(s => `<li><span>${esc(OBJECTIVE_KINDS[s.objective].label)}${['activate', 'override', 'barricade', 'waves'].includes(s.objective) ? ` · ${s.count}` : ''}</span></li>`).join('')}</ol>` : '<p class="bld-note">No steps connected.</p>')
      + `<button type="button" class="bld-btn bld-btn--secondary bld-btn--sm" data-bld="graph">${icon('graph')}Edit the mission graph</button>`
      + `<h3 class="bld-h">Game</h3>`
      + `<p class="bld-note">These apply to every level of ${esc(g.name)}.</p>`
      + sel('bld-game-genre', 'Genre', Object.values(GENRES).map(x => [x.id, x.label]), g.genre, 'data-game="genre"')
      + `<p class="bld-note">${esc(genre.description)}</p>`
      + sel('bld-game-difficulty', 'Difficulty', [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']], g.difficulty, 'data-game="difficulty"')
      + `<div class="bld-field"><label for="bld-game-lives">Lives</label><input id="bld-game-lives" type="number" min="1" max="9" value="${g.settings?.lives ?? 1}" data-game="lives"></div>`
      + `<h3 class="bld-h">Publishing</h3>`
      + [['adBreaks', 'Ad break between levels', 'Calls VisigameHooks.adBreak(‘between-levels’) before each next level.'], ['rewardedContinue', 'Rewarded continue', 'After the last life: an ad for the lives back.'], ['showCredits', '“Made with Visigame”', 'On the title card and the ending.']]
        .map(([k, l, hint]) => `<label class="bld-switch"><span>${esc(l)}<small class="bld-note" style="display:block;margin:0">${esc(hint)}</small></span><input type="checkbox" data-publish="${k}" ${g.publish?.[k] ? 'checked' : ''}></label>`).join('');
    els.level.innerHTML = html;
  }

  /**
   * What the level stands on, in a sentence (world/kernelGround.js): the site of its seed's world, what the mission
   * cost the kernel and the par its walker gives, or why it kept the village's own hills.
   */
  function groundNote(level) {
    const G = level?.ground;
    if (!G) return 'The ground is being grown.';
    if (G.kind === 'world') {
      const par = levelPar(level, level.pack.world.terrain.traversal), nats = G.conditioning ? Math.round(G.conditioning.nats) : 0;
      return `On its seed's Visigenesis world: the 640 m site at (${G.site.x}, ${G.site.z}) of its 4 km plate, played at 1:8. `
        + `The kernel bent it ${nats} nats to meet the mission${par?.seconds ? `, and walks it in ${formatTime(par.seconds)}` : ''}. Ground ${G.heightHash}.`;
    }
    if (G.asked === 'world') return `This seed's world has no site this mission stands on (${G.reason}), so the level keeps the village's own hills.`;
    return 'The village grows its own hills from the seed, as every level made before worlds did.';
  }

  // ------------------------------------------------------------------ levels strip
  function renderLevels() {
    const g = store.game, worlds = CATALOG.arcade.world;
    els.levels.innerHTML = g.levels.map((l, i) => {
      const w = worlds.find(x => x.id === l.blueprint?.nodes.find(n => n.kind === 'world')?.items[0]) ?? worlds[0];
      const status = app.levelStatus?.(l.id) ?? 'unknown', thumb = app.thumbs.get(l.id) ?? assetURL(w.preview);
      return `<button type="button" class="bld-lvl" data-level-index="${i}" aria-current="${i === store.state.levelIndex}" aria-label="Level ${i + 1}: ${esc(l.name)}, ${esc(w.label)}${status === 'error' ? ', has errors' : status === 'warning' ? ', has warnings' : ''}"><span class="bld-lvl__thumb" style="background-image:url('${esc(thumb)}')"></span><span class="bld-lvl__text"><strong>${esc(l.name)}</strong><small>${String(i + 1).padStart(2, '0')} · ${esc(w.label)}</small></span><i class="bld-lvl__status is-${status}" aria-hidden="true"></i></button>`;
    }).join('') + `<button type="button" class="bld-lvl-add" data-bld="add-level" aria-label="Add a level" ${g.levels.length >= MAX_LEVELS ? 'disabled' : ''}>${icon('plus')}</button>`;
  }

  // ------------------------------------------------------------------ status bar
  function renderStatus() {
    const t = TOOL_INFO[store.state.tool], sel = store.state.selection.length, c = ui.cursor;
    els.status.innerHTML = `<span class="bld-status__hint">${esc(ui.hint || t.hint)}</span>`
      + (c ? `<span>X <b>${c.x.toFixed(1)}</b> Z <b>${c.z.toFixed(1)}</b></span>` : '')
      + `<span>${sel ? `<b>${sel}</b> selected` : 'Nothing selected'}</span><span>Snap <b>${store.state.snap ? 'on' : 'off'}</b></span>`
      + (ui.fps ? `<span><b>${ui.fps}</b> fps</span>` : '');
  }

  // ------------------------------------------------------------------ events
  root.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || !root.contains(b)) return;
    if (b.dataset.tool) { store.setTool(b.dataset.tool); if (matchMedia('(max-width: 599px)').matches && b.dataset.tool === 'place') setSheet('left', true, 'palette'); }
    if (b.dataset.camera) app.setCameraMode(b.dataset.camera);
    if (b.dataset.bldTab) selectTab(b.dataset.bldTab);
    if (b.dataset.layer) { ui.open.has(b.dataset.layer) ? ui.open.delete(b.dataset.layer) : ui.open.add(b.dataset.layer); renderOutliner(); root.querySelector(`[data-layer="${b.dataset.layer}"]`)?.focus(); }
    if (b.dataset.ref) {
      const ref = b.dataset.ref;
      if (e.shiftKey || e.metaKey || e.ctrlKey) store.toggleSelect(ref); else store.select([ref]);
      if (e.detail >= 2) app.focusRef(ref);
    }
    if (b.dataset.palGroup) { ui.palGroup = b.dataset.palGroup; renderPalette(); }
    if (b.dataset.place) { const it = paletteItems(GENRES[store.game.genre]).find(x => x.id === b.dataset.place); if (it) { store.setPlacing(it.type, it.props); app.toastPlace(it); } }
    if (b.dataset.region) { store.setBrush({ region: b.dataset.region }); store.setTool('paint'); }
    if (b.dataset.jump) { const i = app.checks?.issues.find(x => x.id === b.dataset.jump); if (i?.at) { app.focusAt(i.at.x, i.at.z); if (i.ref && (i.ref === 'start' || !isKeyRef(i.ref) || app.pickables.some(p => p.ref === i.ref))) store.select([i.ref]); } }
    if (b.dataset.drop) store.dropOverrides([b.dataset.drop]);
    if (b.dataset.restore) store.restore(b.dataset.restore);
    if (b.dataset.unwire) { const [from, to] = b.dataset.unwire.split('>'); store.unwire(from, to); }
    if (b.dataset.levelIndex) store.selectLevel(Number(b.dataset.levelIndex));
  });
  // A double-click on a level opens its settings with the name ready to type.
  root.addEventListener('dblclick', e => {
    const b = e.target.closest('[data-level-index]'); if (!b) return;
    store.selectLevel(Number(b.dataset.levelIndex)); selectTab('level');
    if (matchMedia('(max-width: 899px)').matches) setSheet('right', true, 'level');
    const input = root.querySelector('#bld-lvl-name'); input?.focus(); input?.select();
  });
  root.addEventListener('input', e => {
    if (e.target.id === 'bld-find') { ui.search = e.target.value; renderOutliner(); root.querySelector('#bld-find')?.focus(); const el = root.querySelector('#bld-find'); el.setSelectionRange(el.value.length, el.value.length); }
    if (e.target.id === 'bld-pal-find') { ui.palSearch = e.target.value; renderPalette(); const el = root.querySelector('#bld-pal-find'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    if (e.target.dataset.t === 'scale') applyTransform({ scale: Number(e.target.value) }, true);
  });
  root.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.t && t.dataset.t !== 'scale') {
      const v = Number(t.value); if (!Number.isFinite(v)) return;
      applyTransform({ [t.dataset.t]: t.dataset.t === 'yaw' ? rad(v) : v });
    }
    if (t.dataset.t === 'scale') store.state.dragging = false;
    if (t.dataset.p) {
      const ref = store.state.selection[0], e2 = store.entity(ref), f = ENTITY_TYPES[e2.type].props[t.dataset.p];
      const value = f.type === 'int' || f.type === 'num' ? Number(t.value) : t.value;
      store.updateEntity(ref, { props: { [t.dataset.p]: value, ...(t.dataset.p === 'prop' ? { variant: '' } : {}) } }, `Change ${stepLabel(e2)}`);
    }
    if (t.id === 'bld-name') store.patch({ name: t.value }, 'Rename game');
    if (t.id === 'bld-lvl-name') store.renameLevel(store.state.levelIndex, t.value);
    if (t.id === 'bld-lvl-seed') store.patch({ seed: t.value }, 'Change seed');
    if (t.dataset.level === 'world') {
      const bp = store.level.blueprint;
      store.patch({ blueprint: { ...bp, nodes: bp.nodes.map(n => n.kind === 'world' ? { ...n, items: [t.value] } : n) } }, 'Change world');
    }
    if (t.dataset.level && t.dataset.level !== 'world') store.patch({ [t.dataset.level]: t.dataset.level === 'enemyCount' ? Number(t.value) : t.value }, `Change ${t.dataset.level === 'enemyCount' ? 'critters' : t.dataset.level}`);
    if (t.dataset.game === 'lives') store.patch({ settings: { ...store.game.settings, lives: Number(t.value) } }, 'Change lives');
    else if (t.dataset.game) app.patchGame({ [t.dataset.game]: t.value });
    if (t.dataset.publish) store.setPublish({ [t.dataset.publish]: t.checked });
  });
  root.addEventListener('keydown', e => {
    // Tabs and radio groups: the arrow keys move between options (WAI-ARIA).
    const tab = e.target.closest('[role="tab"],[role="radio"]');
    if (tab && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      const list = [...tab.parentElement.querySelectorAll(`[role="${tab.getAttribute('role')}"]`)], i = list.indexOf(tab), step = ['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : -1;
      const next = list[(i + step + list.length) % list.length]; next.focus(); next.click(); e.preventDefault();
    }
    // Outliner rows: up and down walk the list, Enter frames.
    const row = e.target.closest('.bld-row');
    if (row && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
      const rows = [...els.outliner.querySelectorAll('.bld-row')], i = rows.indexOf(row), next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) { next.focus(); store.select([next.dataset.ref]); } e.preventDefault();
    }
    if (row && e.key === 'Enter') { app.focusRef(row.dataset.ref); e.preventDefault(); }
  });
  // Rail tooltips: the tool's name and key.
  let tip = null;
  root.addEventListener('pointerover', e => {
    const b = e.target.closest('[data-tip]'); tip?.remove(); tip = null;
    if (!b || e.pointerType === 'touch') return;
    const r = b.getBoundingClientRect(); tip = document.createElement('div'); tip.className = 'bld-tip';
    tip.innerHTML = `${esc(b.dataset.tip)}${b.dataset.kbd ? `<kbd>${esc(b.dataset.kbd)}</kbd>` : ''}`;
    root.appendChild(tip); tip.style.left = `${r.right + 8}px`; tip.style.top = `${r.top + r.height / 2 - tip.offsetHeight / 2}px`;
  });
  root.addEventListener('pointerout', e => { if (e.target.closest?.('[data-tip]')) { tip?.remove(); tip = null; } });
  root.addEventListener('pointerdown', () => { tip?.remove(); tip = null; });

  function applyTransform(patch, live = false) {
    const ref = store.state.selection[0]; if (!ref) return;
    const item = app.pickables?.find(p => p.ref === ref);
    const origin = item ? { x: item.x, z: item.z, yaw: item.record?.yaw ?? 0 } : null;
    if (live && !store.state.dragging) { store.begin('Scale'); store.state.dragging = true; }
    store.setTransform(ref, patch, origin);
    if (!live && store.state.dragging) { store.state.dragging = false; store.end(); }
    if (live) clearTimeout(applyTransform.t), applyTransform.t = setTimeout(() => { if (store.state.dragging) { store.state.dragging = false; store.end(); } }, 400);
  }

  function selectTab(id) {
    const left = ['outliner', 'palette'].includes(id);
    for (const b of root.querySelectorAll(`[data-bld-tab]`)) {
      if (['outliner', 'palette'].includes(b.dataset.bldTab) !== left) continue;
      const on = b.dataset.bldTab === id; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
      root.querySelector(`#bld-${b.dataset.bldTab}`).hidden = !on;
    }
    if (left) ui.leftTab = id; else ui.rightTab = id;
    render(['panels']);
  }
  function setSheet(side, open, tab = null) {
    root.dataset[side] = open ? 'open' : 'closed';
    if (open && tab) selectTab(tab);
    renderRail();
  }

  function render(kinds = ['all']) {
    const all = kinds.includes('all');
    if (all || kinds.includes('tool')) renderRail();
    renderTop();
    if (all || kinds.some(k => ['game', 'level', 'selection', 'checks', 'panels', 'compile'].includes(k))) {
      if (ui.leftTab === 'outliner') renderOutliner(); else renderPalette();
      if (ui.rightTab === 'inspector') renderInspector(); else if (ui.rightTab === 'checks') renderChecks(); else renderLevel();
    } else if (kinds.includes('tool') && ui.leftTab === 'palette') renderPalette();
    if (all || kinds.some(k => ['game', 'level', 'checks', 'compile', 'thumbs'].includes(k))) renderLevels();
    renderStatus();
  }
  return {
    render, selectTab, setSheet, renderStatus,
    setHint(text) { ui.hint = text; renderStatus(); },
    setCursor(c) { ui.cursor = c; renderStatus(); },
    setFps(f) { ui.fps = f; renderStatus(); },
    get ui() { return ui; },
  };
}

