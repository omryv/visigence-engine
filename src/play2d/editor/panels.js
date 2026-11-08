/**
 * The editor's panels: Layers, the Palette, the Inspector (Selection, Level and Game tabs),
 * the Level strip and the Issues list. Everything they change goes through the store, so every
 * edit is one undo step (text fields commit once, when you pause or leave them).
 *
 *   mountPanels(store, art, els, deps) -> { refresh, setAnalysis, focusInspector, destroy }
 *   els:  { layers, palette, inspector, levels, issues }
 *   deps: { getAnalysis(), onJump(issue), onPlay(cell), confirm(msg) -> Promise<bool>,
 *           drawThumb(canvas, levelIndex), levelStatus(i) -> 'error'|'warning'|null }
 */
import {
  genreById, tilesFor, decorFor, entitiesFor, entityDef, propsFor, optionsFor,
  BIOMES, TIMES, WIN_RULES,
} from '../core/catalog.js';
import { icon } from './icons.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const LAYER_INFO = {
  terrain: { name: 'Terrain', icon: 'grid', hint: 'Solid ground, platforms, water and hazards.' },
  decor: { name: 'Decor', icon: 'wand', hint: 'Scenery. Never collides.' },
  entities: { name: 'Parts', icon: 'cube', hint: 'The player, critters, pickups and mechanisms.' },
};

export function mountPanels(store, art, els, deps = {}) {
  const st = store.state;
  let analysis = null;
  let paletteFilter = { q: '', cat: '' };
  let inspectorTab = 'selection';
  const offs = [];
  const dpr = () => Math.min(2, window.devicePixelRatio || 1);
  const view = () => store.view;
  const genre = () => store.genre;

  // ============================================================== layers
  function renderLayers() {
    const l = store.level;
    const counts = {
      terrain: l.terrain.reduce((n, c) => n + (c ? 1 : 0), 0),
      decor: l.decor.reduce((n, c) => n + (c ? 1 : 0), 0),
      entities: l.entities.length,
    };
    els.layers.innerHTML = `
      <div class="pnl-head"><h2 class="pnl-title">${icon('layers')}Layers</h2><span class="meta">Q · W · T</span></div>
      <ul class="layers">
        ${['terrain', 'decor', 'entities'].map(k => {
          const on = st.layer === k, vis = st.visible[k], lock = st.locked[k];
          return `<li class="layer ${on ? 'is-active' : ''} ${vis ? '' : 'is-hidden'}">
            <button type="button" class="layer__main" aria-pressed="${on}" data-layer="${k}">
              ${icon(LAYER_INFO[k].icon)}<span class="layer__name">${LAYER_INFO[k].name}</span><span class="layer__count meta">${counts[k].toLocaleString('en')}</span>
            </button>
            <button type="button" class="icon-btn icon-btn--sm" data-eye="${k}" aria-pressed="${!vis}" aria-label="${vis ? 'Hide' : 'Show'} ${LAYER_INFO[k].name.toLowerCase()}" title="${vis ? 'Hide' : 'Show'}">${icon(vis ? 'eye' : 'eyeOff')}</button>
            <button type="button" class="icon-btn icon-btn--sm" data-lock="${k}" aria-pressed="${lock}" aria-label="${lock ? 'Unlock' : 'Lock'} ${LAYER_INFO[k].name.toLowerCase()}" title="${lock ? 'Unlock' : 'Lock'}">${icon(lock ? 'lock' : 'unlock')}</button>
          </li>`;
        }).join('')}
      </ul>`;
  }
  els.layers.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.layer) { store.setLayer(b.dataset.layer); paletteFilter = { q: '', cat: '' }; }
    else if (b.dataset.eye) store.setVisible(b.dataset.eye, !st.visible[b.dataset.eye]);
    else if (b.dataset.lock) store.setLocked(b.dataset.lock, !st.locked[b.dataset.lock]);
  });

  // ============================================================== palette
  function paletteItems() {
    const g = genre();
    if (st.layer === 'terrain') return tilesFor(g).map(t => ({ kind: 'tile', id: t.code, name: t.name, cat: t.category, hint: t.hint || '' }));
    if (st.layer === 'decor') return decorFor(g).map(d => ({ kind: 'decor', id: d.code, name: d.name, cat: d.category, hint: d.hint || 'Scenery. Never collides.' }));
    return entitiesFor(g).map(e => ({ kind: 'entity', id: e.type, name: e.name, cat: e.category, hint: e.hint || '', max: e.max }));
  }
  function renderPalette() {
    const items = paletteItems();
    const cats = [...new Set(items.map(i => i.cat))];
    const q = paletteFilter.q.trim().toLowerCase();
    const shown = items.filter(i => (!paletteFilter.cat || i.cat === paletteFilter.cat) && (!q || i.name.toLowerCase().includes(q) || i.cat.toLowerCase().includes(q)));
    const sel = st.brush[st.layer];
    const counts = new Map();
    if (st.layer === 'entities') for (const e of store.level.entities) counts.set(e.type, (counts.get(e.type) || 0) + 1);
    const current = items.find(i => i.id === sel);
    els.palette.innerHTML = `
      <div class="pnl-head"><h2 class="pnl-title">${icon('palette')}Palette</h2><span class="meta">${esc(LAYER_INFO[st.layer].name)} · ${items.length}</span></div>
      <label class="search">${icon('target')}<input type="search" placeholder="Search ${esc(LAYER_INFO[st.layer].name.toLowerCase())}" aria-label="Search the palette" value="${esc(paletteFilter.q)}"></label>
      <div class="chips" role="group" aria-label="Categories">
        <button type="button" class="chip ${paletteFilter.cat ? '' : 'is-on'}" data-cat="" aria-pressed="${!paletteFilter.cat}">All</button>
        ${cats.map(c => `<button type="button" class="chip ${paletteFilter.cat === c ? 'is-on' : ''}" data-cat="${esc(c)}" aria-pressed="${paletteFilter.cat === c}">${esc(c)}</button>`).join('')}
      </div>
      <div class="swatches" role="listbox" aria-label="${esc(LAYER_INFO[st.layer].name)} palette" tabindex="-1">
        ${shown.map((it, n) => {
          const on = it.id === sel;
          const count = it.kind === 'entity' ? counts.get(it.id) || 0 : null;
          const full = it.max && count >= it.max;
          return `<button type="button" class="swatch ${on ? 'is-on' : ''}" role="option" aria-selected="${on}" tabindex="${on || (!shown.some(s => s.id === sel) && n === 0) ? 0 : -1}" data-id="${esc(it.id)}" title="${esc(it.name)}${n < 9 ? ` (${n + 1})` : ''}">
            <canvas class="swatch__art" width="${Math.round(44 * dpr())}" height="${Math.round(44 * dpr())}" data-kind="${it.kind}" data-art="${esc(it.id)}"></canvas>
            <span class="swatch__name">${esc(it.name)}</span>
            ${n < 9 ? `<kbd class="swatch__key">${n + 1}</kbd>` : ''}
            ${count !== null && it.max < 400 ? `<span class="swatch__count meta ${full ? 'is-full' : ''}">${count}/${it.max}</span>` : ''}
            <i class="vf" aria-hidden="true"></i>
          </button>`;
        }).join('') || `<p class="empty">Nothing matches “${esc(paletteFilter.q)}”.</p>`}
      </div>
      <div class="palette-hint">${current ? `<p class="palette-hint__name">${esc(current.name)}</p><p>${esc(current.hint)}</p>` : '<p>Pick something to paint.</p>'}</div>`;
    const l = store.level;
    for (const c of els.palette.querySelectorAll('canvas[data-art]')) {
      const kind = c.dataset.kind;
      const id = kind === 'entity' ? c.dataset.art : +c.dataset.art;
      const img = art.icon(kind, id, c.width, { view: view(), biome: l.biome, genre: genre() });
      const g = c.getContext('2d');
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
    }
  }
  els.palette.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.classList.contains('chip')) { paletteFilter.cat = b.dataset.cat; renderPalette(); return; }
    if (b.classList.contains('swatch')) {
      const id = st.layer === 'entities' ? b.dataset.id : +b.dataset.id;
      store.setBrush(st.layer, id);
      if (!['brush', 'rect', 'fill'].includes(st.tool)) store.setTool('brush');
    }
  });
  els.palette.addEventListener('input', e => {
    if (e.target.type !== 'search') return;
    paletteFilter.q = e.target.value;
    const pos = e.target.selectionStart;
    renderPalette();
    const input = els.palette.querySelector('input[type=search]');
    input.focus(); input.setSelectionRange(pos, pos);
  });
  els.palette.addEventListener('keydown', e => {
    const b = e.target.closest('.swatch');
    if (!b) return;
    const all = [...els.palette.querySelectorAll('.swatch')];
    const i = all.indexOf(b);
    const cols = Math.max(1, Math.round(els.palette.querySelector('.swatches').clientWidth / b.offsetWidth));
    const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (move) { e.preventDefault(); const n = all[Math.max(0, Math.min(all.length - 1, i + move))]; all.forEach(s => (s.tabIndex = -1)); n.tabIndex = 0; n.focus(); }
    if (e.key === 'Home') { e.preventDefault(); all[0].focus(); }
    if (e.key === 'End') { e.preventDefault(); all[all.length - 1].focus(); }
  });
  // 1–9 pick from the palette; Q W T switch layers
  function onKey(e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || deps.blocked?.()) return;
    if (/^[1-9]$/.test(e.key)) {
      const sw = els.palette.querySelectorAll('.swatch')[+e.key - 1];
      if (sw) { sw.click(); e.preventDefault(); }
    } else if (e.key === 'q' || e.key === 'Q') store.setLayer('terrain');
    else if (e.key === 'w' || e.key === 'W') store.setLayer('decor');
    else if (e.key === 't' || e.key === 'T') store.setLayer('entities');
  }
  window.addEventListener('keydown', onKey);

  // ============================================================== inspector
  function renderInspector() {
    const tabs = [['selection', 'Selection'], ['level', 'Level'], ['game', 'Game']];
    els.inspector.innerHTML = `
      <div class="tabs" role="tablist" aria-label="Inspector">
        ${tabs.map(([k, n]) => `<button type="button" role="tab" id="tab-${k}" aria-controls="tp-${k}" aria-selected="${inspectorTab === k}" tabindex="${inspectorTab === k ? 0 : -1}" data-tab="${k}">${n}</button>`).join('')}
      </div>
      <div class="tabpanel" role="tabpanel" id="tp-${inspectorTab}" aria-labelledby="tab-${inspectorTab}">${inspectorTab === 'selection' ? selectionHtml() : inspectorTab === 'level' ? levelHtml() : gameHtml()}</div>`;
    paintInspectorArt();
  }
  function paintInspectorArt() {
    const l = store.level;
    for (const c of els.inspector.querySelectorAll('canvas[data-art]')) {
      const img = art.icon('entity', c.dataset.art, c.width, { view: view(), biome: l.biome, genre: genre(), props: c.dataset.props ? JSON.parse(c.dataset.props) : undefined });
      const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    }
  }

  function field(label, control, opts = {}) {
    return `<div class="field ${opts.cls || ''}"><label class="field__label meta" ${opts.for ? `for="${opts.for}"` : ''}>${esc(label)}</label>${control}${opts.help ? `<p class="field__help">${esc(opts.help)}</p>` : ''}</div>`;
  }
  function numberControl(id, value, p, data) {
    const step = p.step || 1;
    return `<div class="num">
      <input type="range" min="${p.min}" max="${p.max}" step="${step}" value="${value}" aria-labelledby="${id}-l" ${data} data-range>
      <input id="${id}" type="number" min="${p.min}" max="${p.max}" step="${step}" value="${value}" ${data} inputmode="decimal">
    </div>`;
  }
  function segmented(name, options, value, data, labels = {}) {
    return `<div class="seg" role="radiogroup" aria-label="${esc(name)}">${options.map(o => `<button type="button" role="radio" aria-checked="${o === value}" class="seg__opt ${o === value ? 'is-on' : ''}" ${data} data-value="${esc(o)}">${esc(labels[o] || cap(o))}</button>`).join('')}</div>`;
  }
  function toggle(id, on, data, label) {
    return `<label class="switch" for="${id}"><input id="${id}" type="checkbox" ${on ? 'checked' : ''} ${data}><span class="switch__track" aria-hidden="true"><i></i></span><span class="switch__label">${esc(label)}</span></label>`;
  }

  function selectionHtml() {
    const l = store.level;
    const sel = st.selection;
    const ents = l.entities.filter(e => sel.ids.includes(e.id));
    if (sel.region) {
      const r = sel.region;
      let tiles = 0;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (l.terrain[y * l.width + x]) tiles++;
      return `<div class="insp-head"><div><p class="meta">Region · X ${r.x} · Y ${r.y}</p><h3 class="insp-title">${r.w} × ${r.h} cells</h3></div></div>
        <p class="insp-text">${tiles} terrain tile${tiles === 1 ? '' : 's'} and ${ents.length} part${ents.length === 1 ? '' : 's'} inside.</p>
        <div class="btn-row">
          <button type="button" class="btn btn--secondary btn--sm" data-act="copy">${icon('copy')}Copy</button>
          <button type="button" class="btn btn--secondary btn--sm" data-act="flip">${icon('flip')}Flip</button>
          <button type="button" class="btn btn--danger btn--sm" data-act="clear">${icon('trash')}Clear</button>
        </div>
        <p class="field__help">Ctrl or ⌘ with C, X, V and D copy, cut, paste and duplicate. F flips. Delete clears.</p>`;
    }
    if (!ents.length) {
      return `<div class="insp-empty">
        <p class="insp-empty__title">Nothing selected</p>
        <p class="hint-fine">Choose the select tool (V) and click a part to edit it, or drag across the grid to select a region.</p>
        <p class="hint-coarse">Tap Select, then tap a part to edit it, or drag across the grid to select a region. Two fingers pan and zoom; press and hold for more.</p>
        <ul class="kbd-list hint-fine">
          <li><kbd>B</kbd> brush</li><li><kbd>U</kbd> rectangle</li><li><kbd>G</kbd> fill</li><li><kbd>E</kbd> erase</li>
          <li><kbd>L</kbd> wire</li><li><kbd>Space</kbd> drag to pan</li><li><kbd>P</kbd> play from the cursor</li><li><kbd>?</kbd> every shortcut</li>
        </ul>
      </div>`;
    }
    if (ents.length > 1) {
      const by = new Map();
      for (const e of ents) by.set(e.type, (by.get(e.type) || 0) + 1);
      return `<div class="insp-head"><div><p class="meta">Selection</p><h3 class="insp-title">${ents.length} parts</h3></div></div>
        <ul class="count-list">${[...by].map(([t, n]) => `<li><span>${esc(entityDef(t).name)}</span><b class="meta">${n}</b></li>`).join('')}</ul>
        <div class="btn-row">
          <button type="button" class="btn btn--secondary btn--sm" data-act="copy">${icon('copy')}Copy</button>
          <button type="button" class="btn btn--danger btn--sm" data-act="delete">${icon('trash')}Delete</button>
        </div>`;
    }
    const e = ents[0];
    const def = entityDef(e.type);
    const g = genre();
    const props = propsFor(e.type, g).filter(p => !p.showIf || Object.entries(p.showIf).every(([k, v]) => e.props[k] === v));
    const outs = l.links.filter(k => k.from === e.id), ins = l.links.filter(k => k.to === e.id);
    const nameOf = id => { const o = l.entities.find(x => x.id === id); return o ? `${entityDef(o.type).name} at ${o.x}, ${o.y}` : 'a missing part'; };
    const px = Math.round(56 * dpr());
    return `<div class="insp-head">
        <canvas class="insp-art" width="${px}" height="${px}" data-art="${esc(e.type)}" data-props='${esc(JSON.stringify(e.props))}'></canvas>
        <div><p class="meta">${esc(def.category)} · X ${e.x} · Y ${e.y}</p><h3 class="insp-title">${esc(def.name)}</h3></div>
      </div>
      <p class="insp-text">${esc(def.hint || '')}</p>
      ${props.length ? `<div class="fields">${props.map(p => propControl(e, p)).join('')}</div>` : ''}
      ${def.linkSource || def.linkTarget ? `<div class="wires">
        <p class="field__label meta">Wires</p>
        ${outs.length || ins.length ? `<ul class="wire-list">
          ${outs.map(k => `<li>${icon('wire')}<span>Drives ${esc(nameOf(k.to))}</span><button type="button" class="icon-btn icon-btn--sm" data-cut="${esc(k.from)}>${esc(k.to)}" aria-label="Cut this wire" title="Cut">${icon('close')}</button></li>`).join('')}
          ${ins.map(k => `<li>${icon('wire')}<span>Driven by ${esc(nameOf(k.from))}</span><button type="button" class="icon-btn icon-btn--sm" data-cut="${esc(k.from)}>${esc(k.to)}" aria-label="Cut this wire" title="Cut">${icon('close')}</button></li>`).join('')}
        </ul>` : `<p class="field__help">${def.linkSource ? 'Not wired yet. Drag from this part to a gate, platform, cannon or burrow with the wire tool.' : 'Nothing drives it: it follows its own rules until a lever, plate or burrow is wired to it.'}</p>`}
        ${def.linkSource ? `<button type="button" class="btn btn--secondary btn--sm" data-act="wire">${icon('link')}Wire to…</button>` : ''}
      </div>` : ''}
      <div class="btn-row">
        <button type="button" class="btn btn--secondary btn--sm" data-act="play-here">${icon('play')}Play from here</button>
        <button type="button" class="btn btn--secondary btn--sm" data-act="duplicate">${icon('copy')}Duplicate</button>
        <button type="button" class="btn btn--danger btn--sm" data-act="delete">${icon('trash')}Delete</button>
      </div>`;
  }
  function propControl(e, p) {
    const id = `prop-${p.key}`;
    const v = e.props[p.key] ?? p.default;
    const data = `data-prop="${esc(p.key)}"`;
    if (p.type === 'int' || p.type === 'float') return field(p.label, numberControl(id, v, p, data), { for: id, help: p.help });
    if (p.type === 'bool') return field(p.label, toggle(id, v, data, v ? 'On' : 'Off'), { help: p.help });
    if (p.type === 'text') return field(p.label, `<textarea id="${id}" rows="3" maxlength="${p.max || 140}" ${data}>${esc(v)}</textarea><span class="counter meta" data-counter="${esc(p.key)}">${String(v).length} / ${p.max || 140}</span>`, { for: id });
    if (p.type === 'enum') {
      const opts = optionsFor(p, genre());
      const labels = p.labels || {};
      if (opts.length <= 4 && opts.every(o => (labels[o] || o).length <= 10)) return field(p.label, segmented(p.label, opts, v, data, labels));
      return field(p.label, `<div class="select"><select id="${id}" ${data}>${opts.map(o => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${esc(labels[o] || cap(o))}</option>`).join('')}</select>${icon('chevronDown')}</div>`, { for: id });
    }
    return '';
  }

  function levelHtml() {
    const l = store.level;
    const g = genreById(genre());
    const r = l.rules;
    const winOpts = g.wins;
    return `<div class="fields">
      ${field('Name', `<input id="lv-name" type="text" maxlength="40" value="${esc(l.name)}" data-level="name">`, { for: 'lv-name' })}
      ${field('Biome', `<div class="biomes" role="radiogroup" aria-label="Biome">${BIOMES.map(b => `<button type="button" role="radio" aria-checked="${l.biome === b.id}" class="biome biome--${b.id} ${l.biome === b.id ? 'is-on' : ''}" data-level="biome" data-value="${b.id}"><i aria-hidden="true"></i>${esc(b.name)}</button>`).join('')}</div>`)}
      ${field('Time of day', segmented('Time of day', TIMES.map(t => t.id), l.time, 'data-level="time"', Object.fromEntries(TIMES.map(t => [t.id, t.name]))))}
      ${field('Size', `<div class="size-row">
          <label class="mini-field"><span class="meta">W</span><input id="lv-w" type="number" min="${g.minSize.width}" max="${g.maxSize.width}" value="${l.width}" data-size="w"></label>
          <label class="mini-field"><span class="meta">H</span><input id="lv-h" type="number" min="${g.minSize.height}" max="${g.maxSize.height}" value="${l.height}" data-size="h"></label>
          <div class="anchor" role="radiogroup" aria-label="Keep content anchored to">${[0, 0.5, 1].flatMap(ay => [0, 0.5, 1].map(ax => `<button type="button" role="radio" class="anchor__cell ${ax === sizeAnchor.ax && ay === sizeAnchor.ay ? 'is-on' : ''}" aria-checked="${ax === sizeAnchor.ax && ay === sizeAnchor.ay}" data-anchor="${ax},${ay}" aria-label="${['Top', 'Middle', 'Bottom'][ay * 2]} ${['left', 'centre', 'right'][ax * 2]}"></button>`)).join('')}</div>
          <button type="button" class="btn btn--secondary btn--sm" data-act="resize">Apply</button>
        </div>`, { help: `${g.minSize.width}–${g.maxSize.width} × ${g.minSize.height}–${g.maxSize.height}. The dot picks which edge stays put.` })}
      ${field('Win rule', `<div class="select"><select id="lv-win" data-rule="win">${winOpts.map(w => `<option value="${w}" ${r.win === w ? 'selected' : ''}>${esc(WIN_RULES[w].label)}</option>`).join('')}</select>${icon('chevronDown')}</div>`, { for: 'lv-win' })}
      ${r.win === 'survive' ? field('Survive for (s)', numberControl('lv-survive', r.survive, { min: 5, max: 600, step: 5 }, 'data-rule="survive"'), { for: 'lv-survive' }) : ''}
      ${genre() !== 'puzzle' ? field('Time limit (s)', numberControl('lv-limit', r.timeLimit, { min: 0, max: 600, step: 5 }, 'data-rule="timeLimit"'), { for: 'lv-limit', help: '0 means no limit.' }) : ''}
      ${field(genre() === 'puzzle' ? 'Par (moves)' : 'Par (s)', numberControl('lv-par', r.par, { min: 0, max: genre() === 'puzzle' ? 500 : 600, step: 1 }, 'data-rule="par"'), { for: 'lv-par', help: 'Beat par for the third star. 0: finish without a hit instead.' + (analysis?.stats?.par ? ` Suggested: ${analysis.stats.par}.` : '') })}
      ${genre() === 'adventure' ? field('Night vision', toggle('lv-dark', r.dark, 'data-rule="dark"', 'Dark at night: only lights show the way'), { help: l.time === 'night' ? '' : 'Takes effect when the time of day is night.' }) : ''}
      ${genre() === 'adventure' ? field('Slingshot', toggle('lv-sling', r.slingshot, 'data-rule="slingshot"', 'The hero carries a slingshot (X)')) : ''}
      ${field('Designer notes', `<textarea id="lv-notes" rows="3" maxlength="1000" data-level="notes" placeholder="Only you see these.">${esc(l.notes || '')}</textarea>`, { for: 'lv-notes' })}
    </div>`;
  }
  let sizeAnchor = { ax: 0, ay: 1 };

  function gameHtml() {
    const p = store.project;
    const s = p.settings, pub = p.publish;
    const accents = ['#ff9f45', '#5ad8c4', '#72d6ff', '#ff6257', '#ffcf3f', '#b98cff'];
    return `<div class="fields">
      ${field('Title', `<input id="gm-title" type="text" maxlength="48" value="${esc(p.title)}" data-game="title">`, { for: 'gm-title' })}
      ${field('Studio', `<input id="gm-studio" type="text" maxlength="40" value="${esc(p.studio)}" data-game="studio" placeholder="Your name or studio">`, { for: 'gm-studio' })}
      ${field('Description', `<textarea id="gm-desc" rows="3" maxlength="200" data-game="description" placeholder="One or two sentences for the title screen.">${esc(p.description)}</textarea>`, { for: 'gm-desc' })}
      ${field('Accent', `<div class="accents" role="radiogroup" aria-label="Accent colour">${accents.map(a => `<button type="button" role="radio" aria-checked="${p.accent === a}" class="accent ${p.accent === a ? 'is-on' : ''}" style="--c:${a}" data-accent="${a}" aria-label="Accent ${a}"></button>`).join('')}<label class="accent accent--custom" title="Custom colour"><input type="color" value="${esc(p.accent)}" data-game="accent" aria-label="Custom accent colour"></label></div>`, { help: 'Colours the title screen’s main button.' })}
      ${field('Lives', numberControl('gm-lives', s.lives, { min: 0, max: 9, step: 1 }, 'data-setting="lives"'), { for: 'gm-lives', help: '0 gives unlimited lives.' })}
      ${genre() !== 'maze' && genre() !== 'puzzle' ? field('Hearts', numberControl('gm-hearts', s.hearts, { min: 1, max: 6, step: 1 }, 'data-setting="hearts"'), { for: 'gm-hearts' }) : ''}
      ${field('Difficulty', segmented('Difficulty', ['easy', 'normal', 'hard'], s.difficulty, 'data-setting="difficulty"'))}
      ${field('Sound', `${toggle('gm-music', s.music, 'data-setting="music"', 'Music')}${toggle('gm-sound', s.sound, 'data-setting="sound"', 'Sound effects')}`)}
      <div class="publish-box">
        <p class="field__label meta">Publishing</p>
        ${toggle('gm-ads', pub.adBreaks, 'data-publish="adBreaks"', 'Ad break between levels')}
        ${toggle('gm-rewarded', pub.rewardedContinue, 'data-publish="rewardedContinue"', 'Rewarded continue after game over')}
        ${toggle('gm-credits', pub.showCredits, 'data-publish="showCredits"', 'Show “Made with Visigame”')}
        <p class="field__help">Exported games call <code>window.VisigameHooks.adBreak()</code> at these moments. Wire it to your web portal's SDK; without one the game simply carries on.</p>
      </div>
    </div>`;
  }

  // inspector events
  let textTimer = 0, textPending = null;
  function commitText() {
    clearTimeout(textTimer);
    const t = textPending; textPending = null;
    if (!t) return;
    t();
  }
  function scheduleText(fn) { textPending = fn; clearTimeout(textTimer); textTimer = setTimeout(commitText, 700); }
  els.inspector.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tab) { inspectorTab = b.dataset.tab; renderInspector(); els.inspector.querySelector(`[data-tab="${inspectorTab}"]`)?.focus(); return; }
    const sel = store.state.selection;
    const one = store.level.entities.find(o => o.id === sel.ids[0]);
    if (b.dataset.prop && b.dataset.value !== undefined) { store.setEntityProps(one.id, { [b.dataset.prop]: b.dataset.value }); return; }
    if (b.dataset.level && b.dataset.value !== undefined) { store.setLevel({ [b.dataset.level]: b.dataset.value }); return; }
    if (b.dataset.setting && b.dataset.value !== undefined) { store.setProject({ settings: { [b.dataset.setting]: b.dataset.value } }); return; }
    if (b.dataset.accent) { store.setProject({ accent: b.dataset.accent }); return; }
    if (b.dataset.anchor) { const [ax, ay] = b.dataset.anchor.split(',').map(Number); sizeAnchor = { ax, ay }; renderInspector(); return; }
    if (b.dataset.cut) { const [from, to] = b.dataset.cut.split('>'); store.removeLink(from, to); return; }
    switch (b.dataset.act) {
      case 'copy': store.copy(); break;
      case 'flip': store.flipRegion(sel.region); break;
      case 'clear': store.clearRegion(sel.region, true); store.select([]); break;
      case 'delete': store.removeEntities(sel.ids); break;
      case 'duplicate': if (one) { store.copy(); store.paste(Math.min(store.level.width - 1, one.x + 1), one.y); } break;
      case 'wire': store.setTool('link'); store.notice('Drag from this part to what it should drive.'); break;
      case 'play-here': if (one) deps.onPlay?.({ x: one.x, y: one.y }); break;
      case 'resize': {
        const w = +els.inspector.querySelector('[data-size="w"]').value, h = +els.inspector.querySelector('[data-size="h"]').value;
        store.resizeLevel(w, h, sizeAnchor.ax, sizeAnchor.ay);
        break;
      }
    }
  });
  els.inspector.addEventListener('input', e => {
    const t = e.target;
    const one = store.level.entities.find(o => o.id === store.state.selection.ids[0]);
    if (t.dataset.range !== undefined) { const n = t.parentElement.querySelector('input[type=number]'); if (n) n.value = t.value; return; }
    if (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type === 'text')) {
      if (t.dataset.prop && one) {
        const key = t.dataset.prop, value = t.value, id = one.id;
        const counter = els.inspector.querySelector(`[data-counter="${key}"]`);
        if (counter) counter.textContent = `${value.length} / ${t.maxLength}`;
        scheduleText(() => store.setEntityProps(id, { [key]: value }, 'Edit text'));
      } else if (t.dataset.level) { const key = t.dataset.level, value = t.value; scheduleText(() => store.setLevel({ [key]: value }, key === 'name' ? 'Rename level' : 'Edit notes')); }
      else if (t.dataset.game) { const key = t.dataset.game, value = t.value; scheduleText(() => store.setProject({ [key]: value }, key === 'title' ? 'Rename game' : 'Game details')); }
    }
  });
  els.inspector.addEventListener('change', e => {
    const t = e.target;
    const one = store.level.entities.find(o => o.id === store.state.selection.ids[0]);
    if (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type === 'text')) { commitText(); return; }
    const val = t.type === 'checkbox' ? t.checked : t.type === 'number' || t.type === 'range' ? +t.value : t.value;
    if (t.dataset.prop && one) store.setEntityProps(one.id, { [t.dataset.prop]: val });
    else if (t.dataset.rule) store.setLevel({ rules: { [t.dataset.rule]: val } });
    else if (t.dataset.setting) store.setProject({ settings: { [t.dataset.setting]: val } });
    else if (t.dataset.publish) store.setProject({ publish: { [t.dataset.publish]: val } });
    else if (t.dataset.game === 'accent') store.setProject({ accent: val });
  });
  els.inspector.addEventListener('focusout', e => { if (e.target.tagName === 'TEXTAREA' || e.target.type === 'text') commitText(); });
  els.inspector.addEventListener('keydown', e => {
    const tab = e.target.closest('[role=tab]');
    if (!tab) return;
    const order = ['selection', 'level', 'game'];
    const i = order.indexOf(tab.dataset.tab);
    const n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
    if (n === null) return;
    e.preventDefault();
    inspectorTab = order[(n + 3) % 3];
    renderInspector();
    els.inspector.querySelector(`[data-tab="${inspectorTab}"]`).focus();
  });

  // ============================================================== level strip
  let dragFrom = null;
  function renderLevels() {
    const p = store.project;
    els.levels.innerHTML = `<div class="lvls" role="tablist" aria-label="Levels">
      ${p.levels.map((l, i) => {
        const on = i === st.levelIndex;
        const status = deps.levelStatus?.(i);
        return `<button type="button" role="tab" class="lvl ${on ? 'is-on' : ''}" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-i="${i}" draggable="true" title="${esc(l.name)} · double-click to rename">
          <canvas class="lvl__thumb" width="${Math.round(64 * dpr())}" height="${Math.round(36 * dpr())}" data-thumb="${i}" aria-hidden="true"></canvas>
          <span class="lvl__text"><span class="lvl__num meta">Level ${i + 1}</span><span class="lvl__name">${esc(l.name)}</span></span>
          ${status ? `<i class="lvl__dot lvl__dot--${status}" role="img" aria-label="${status === 'error' ? 'Has errors' : 'Has warnings'}"></i>` : ''}
        </button>`;
      }).join('')}
      <div class="lvl-tools">
        <button type="button" class="btn btn--secondary btn--sm" data-lvl="gen" title="Generate levels that are checked before you see them">${icon('wand')}Generate</button>
        <button type="button" class="icon-btn" data-lvl="add" aria-label="Add a level" title="Add a level">${icon('plus')}</button>
        <button type="button" class="icon-btn" data-lvl="dup" aria-label="Duplicate this level" title="Duplicate this level">${icon('copy')}</button>
        <button type="button" class="icon-btn" data-lvl="del" aria-label="Delete this level" title="Delete this level" ${p.levels.length <= 1 ? 'disabled' : ''}>${icon('trash')}</button>
      </div>
    </div>`;
    drawThumbs();
  }
  let thumbTimer = 0;
  function drawThumbs(only = null) {
    for (const c of els.levels.querySelectorAll('canvas[data-thumb]')) {
      const i = +c.dataset.thumb;
      if (only !== null && i !== only) continue;
      deps.drawThumb?.(c, i);
    }
  }
  els.levels.addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.i !== undefined) { store.selectLevel(+b.dataset.i); return; }
    if (b.dataset.lvl === 'gen') deps.onGenerate?.();
    else if (b.dataset.lvl === 'add') store.addLevel();
    else if (b.dataset.lvl === 'dup') store.duplicateLevel();
    else if (b.dataset.lvl === 'del') {
      const l = store.level;
      if (await (deps.confirm?.(`Delete “${l.name}”? You can undo this.`) ?? Promise.resolve(true))) store.removeLevel();
    }
  });
  els.levels.addEventListener('dblclick', e => {
    const b = e.target.closest('.lvl');
    if (!b) return;
    const i = +b.dataset.i;
    const name = b.querySelector('.lvl__name');
    const input = document.createElement('input');
    input.className = 'lvl__rename'; input.value = store.project.levels[i].name; input.maxLength = 40;
    input.setAttribute('aria-label', 'Level name');
    name.replaceWith(input);
    input.focus(); input.select();
    const done = ok => { if (ok && input.value.trim()) { store.selectLevel(i); store.setLevel({ name: input.value.trim() }, 'Rename level'); } renderLevels(); };
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); ev.stopPropagation(); });
    input.addEventListener('blur', () => done(true), { once: true });
  });
  els.levels.addEventListener('keydown', e => {
    const b = e.target.closest('.lvl');
    if (!b) return;
    const i = +b.dataset.i, n = store.project.levels.length;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const j = Math.max(0, Math.min(n - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
      if (e.altKey) { store.moveLevel(i, j); } else store.selectLevel(j);
      els.levels.querySelector(`[data-i="${j}"]`)?.focus();
    }
  });
  els.levels.addEventListener('dragstart', e => { const b = e.target.closest('.lvl'); if (!b) return; dragFrom = +b.dataset.i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragFrom)); });
  els.levels.addEventListener('dragover', e => { if (dragFrom !== null && e.target.closest('.lvl')) { e.preventDefault(); } });
  els.levels.addEventListener('drop', e => { const b = e.target.closest('.lvl'); if (b && dragFrom !== null) { e.preventDefault(); store.moveLevel(dragFrom, +b.dataset.i); } dragFrom = null; });

  // ============================================================== issues
  function renderIssues() {
    const a = analysis;
    const issues = a?.issues || [];
    const errors = issues.filter(i => i.severity === 'error').length, warnings = issues.filter(i => i.severity === 'warning').length;
    const tally = errors ? `<span class="tally tally--live">${errors} error${errors === 1 ? '' : 's'}</span>` : warnings ? `<span class="tally tally--warn">${warnings} warning${warnings === 1 ? '' : 's'}</span>` : a ? '<span class="tally tally--ready">Ready</span>' : '<span class="tally">Checking</span>';
    const st_ = a?.stats;
    const meter = (label, [used, max]) => {
      const k = Math.min(1, used / max);
      return `<div class="meter-row"><span class="meta">${label}</span><div class="meter ${k > 0.9 ? 'meter--zebra' : ''}" role="meter" aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${used}" aria-label="${label}"><i style="width:${(k * 100).toFixed(1)}%"></i></div><b class="meta">${used}/${max}</b></div>`;
    };
    els.issues.innerHTML = `
      <div class="pnl-head"><h2 class="pnl-title">${icon('issue')}Checks</h2>${tally}</div>
      ${issues.length ? `<ul class="issues">${issues.map(is => `<li><button type="button" class="issue issue--${is.severity}" data-issue="${esc(is.id)}" ${is.at ? '' : 'aria-disabled="true"'}>
          <span class="issue__sev meta">${is.severity === 'error' ? 'Error' : is.severity === 'warning' ? 'Warning' : 'Tip'}</span>
          <span class="issue__msg">${esc(is.message)}</span>
          ${is.at ? `<span class="issue__at meta">X ${is.at.x} · Y ${is.at.y}</span>` : ''}
        </button></li>`).join('')}</ul>` : a ? '<p class="empty-ok">No issues. The level can be played and finished.</p>' : ''}
      ${st_ ? `<div class="stats">
        ${meter('Parts', st_.budget.entities)}${meter('Critters', st_.budget.enemies)}${meter('Wires', st_.budget.links)}
        <dl class="facts">
          <div><dt class="meta">Reachable</dt><dd>${st_.reachableCells.toLocaleString('en')} cells</dd></div>
          ${st_.route ? `<div><dt class="meta">Route</dt><dd>≈ ${st_.route.seconds} s</dd></div>` : ''}
          ${st_.par ? `<div><dt class="meta">Suggested par</dt><dd>${st_.par} ${st_.parUnit}</dd></div>` : ''}
          <div><dt class="meta">Honey</dt><dd>${st_.coins} drops · ${st_.gems} jars</dd></div>
        </dl>
      </div>` : ''}`;
  }
  els.issues.addEventListener('click', e => {
    const b = e.target.closest('[data-issue]');
    if (!b || !analysis) return;
    const is = analysis.issues.find(i => i.id === b.dataset.issue);
    if (is) deps.onJump?.(is);
  });

  // ============================================================== wiring
  offs.push(
    store.on('layer', () => { renderLayers(); renderPalette(); }),
    store.on('brush', renderPalette),
    store.on('view', renderLayers),
    store.on('selection', () => { if (inspectorTab !== 'selection' && (st.selection.ids.length || st.selection.region)) inspectorTab = 'selection'; renderInspector(); }),
    store.on('level', () => {
      renderLayers();
      if (!els.inspector.contains(document.activeElement) || inspectorTab === 'selection') renderInspector();
      if (st.layer === 'entities') renderPalette();
      clearTimeout(thumbTimer); thumbTimer = setTimeout(() => drawThumbs(st.levelIndex), 250);
    }),
    store.on('levels', () => { renderLevels(); renderPalette(); renderInspector(); renderLayers(); }),
    store.on('project', () => { if (!els.inspector.contains(document.activeElement)) renderInspector(); }),
  );
  function refresh() { renderLayers(); renderPalette(); renderInspector(); renderLevels(); renderIssues(); }
  refresh();

  return {
    refresh,
    setAnalysis(r) {
      analysis = r;
      renderIssues();
      // keep level-strip dots current without rebuilding it
      for (const b of els.levels.querySelectorAll('.lvl')) {
        const i = +b.dataset.i;
        const status = deps.levelStatus?.(i);
        let dot = b.querySelector('.lvl__dot');
        if (!status && dot) dot.remove();
        else if (status) { if (!dot) { dot = document.createElement('i'); dot.setAttribute('role', 'img'); b.appendChild(dot); } dot.className = `lvl__dot lvl__dot--${status}`; dot.setAttribute('aria-label', status === 'error' ? 'Has errors' : 'Has warnings'); }
      }
    },
    focusInspector() { inspectorTab = 'selection'; renderInspector(); const f = els.inspector.querySelector('input, select, textarea, button.seg__opt'); f?.focus(); },
    showTab(tab) { inspectorTab = tab; renderInspector(); },
    destroy() { offs.forEach(f => f()); window.removeEventListener('keydown', onKey); commitText(); },
  };
}

export { esc };
