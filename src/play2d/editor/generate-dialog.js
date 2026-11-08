/**
 * Generate levels: say how many, how the difficulty should climb, which biome and a seed; the
 * builder makes candidates in a worker, keeps only the ones its own checks (and, for puzzles,
 * the solver) pass, and shows what it kept in order of difficulty with what each one holds.
 * Add them after the current level, or replace every level with them. One undo step either way.
 */
import { dialog, toast, esc } from './dialogs.js';
import { icon } from './icons.js';
import { genreById, BIOMES } from '../core/catalog.js';
import { GENERATE_MAX } from '../core/generate.js';
import { drawLevelThumb } from './thumbs.js';
import { hashSeed } from '../../kernel/seed.js';
import { worldFromLocation } from '../../world/worldLink.js';

const CURVES = [
  { id: 'gentle', label: 'Gentle', from: 0.05, to: 0.5, help: 'Easy to medium: a first game, or players new to the genre.' },
  { id: 'full', label: 'Full climb', from: 0.1, to: 0.9, help: 'Easy to hard: a whole game that builds to a finale.' },
  { id: 'tough', label: 'Tough', from: 0.45, to: 0.95, help: 'Medium to hard: for players who have beaten the rest.' },
];
const SEED_WORDS = ['amber', 'bramble', 'clover', 'dune', 'ember', 'frost', 'glade', 'hive', 'ivy', 'juniper', 'kestrel', 'lantern', 'meadow', 'nectar', 'oasis', 'pine', 'quill', 'reed', 'saffron', 'thistle', 'umber', 'willow', 'yarrow', 'zephyr'];

/* The seed the generator starts on: the one editor's world seed when this view runs inside it (everything comes from
   the seed), or one spelled from the game itself. Never a dice roll: the same game offers the same seed. */
const worldSeed = (() => { try { return worldFromLocation(location).world?.seed ?? null; } catch { return null; } })();
function seedFor(store) {
  if (worldSeed) return worldSeed;
  const h = hashSeed(String(store?.project?.id ?? store?.project?.title ?? 'game'));
  return `${SEED_WORDS[h % SEED_WORDS.length]}-${SEED_WORDS[(h >>> 8) % SEED_WORDS.length]}-${(h >>> 16) % 100}`;
}

/**
 * @param {object} o
 * @param {object} o.store
 * @param {object} o.art
 * @param {boolean} [o.fresh]  the game is a new blank one: offer "Use these levels" (replace) first
 * @param {string|null} [o.seed]  start with this seed (a `#generate=<genre>:<seed>` link) instead of a random one
 */
export function openGenerate({ store, art, fresh = false, seed = null }) {
  const genre = store.genre, g = genreById(genre);
  const biome = store.level?.biome || 'meadow';
  let worker = null, result = null, running = false;
  const state = { count: 5, curve: 'full', biome: fresh ? 'mixed' : biome, seed: seed || seedFor(store) };
  const seg = (name, options, value) => `<div class="seg" role="radiogroup" aria-label="${esc(name)}">${options.map(o => `<button type="button" role="radio" aria-checked="${o.id === value}" class="seg__opt ${o.id === value ? 'is-on' : ''}" data-${name}="${o.id}">${esc(o.label)}</button>`).join('')}</div>`;
  const body = `
    <p class="gen-lede">Every level is checked before you see it: ${genre === 'puzzle' ? 'the solver proves each puzzle can be solved and sets its par' : genre === 'platformer' ? 'every jump on the way to the shrine is inside the hero\'s reach' : genre === 'maze' ? 'every dot can be eaten and every bee can leave the hive' : genre === 'arena' ? 'every burrow, cannon and pickup is in play' : 'every key is reachable before its gate'}. Anything that fails is thrown away.</p>
    <div class="gen-form">
      <div class="field"><label class="field__label meta" for="gen-count">Levels</label>
        <div class="gen-count"><input id="gen-count" type="range" min="1" max="${GENERATE_MAX}" step="1" value="${state.count}"><output for="gen-count" class="meta">${state.count}</output></div></div>
      <div class="field"><span class="field__label meta" id="gen-curve-l">Difficulty</span>${seg('curve', CURVES, state.curve)}<p class="field__help" data-curve-help>${esc(CURVES.find(c => c.id === state.curve).help)}</p></div>
      <div class="field"><span class="field__label meta">Biome</span>${seg('biome', [...BIOMES.map(b => ({ id: b.id, label: b.name.split(' ')[0] })), { id: 'mixed', label: 'Mixed' }], state.biome)}</div>
      <div class="field"><label class="field__label meta" for="gen-seed">Seed</label>
        <div class="copyrow"><input id="gen-seed" type="text" maxlength="40" spellcheck="false" autocomplete="off" value="${esc(state.seed)}"></div>
        <p class="field__help">The same seed and settings make the same levels, so you can share a seed.</p></div>
    </div>
    <div class="gen-summary"><span class="meta" data-summary></span><button type="button" class="btn btn--ghost btn--sm" data-gen="edit">Change settings</button></div>
    <div class="gen-status" role="status" aria-live="polite"></div>
    <ol class="gen-list" aria-label="Generated levels"></ol>
    <div class="dialog__actions gen-actions"></div>`;

  return dialog({
    meta: `Generate · ${g.name}`, title: 'Generate levels', wide: true, body,
    onMount: (dlg, close) => {
      const $ = s => dlg.querySelector(s);
      const status = $('.gen-status'), list = $('.gen-list'), actions = $('.gen-actions');
      const renderActions = () => {
        if (running) { actions.innerHTML = `<button type="button" class="btn btn--ghost" data-gen="cancel">Stop</button>`; return; }
        const n = result?.levels.length || 0;
        if (!n) { actions.innerHTML = `<button type="button" class="btn btn--ghost" data-close>Cancel</button><button type="button" class="btn btn--primary" data-gen="run">${icon('wand')}Generate</button>`; return; }
        const picked = [...list.querySelectorAll('input[type=checkbox]:checked')].length;
        const add = `<button type="button" class="btn btn--${fresh ? 'secondary' : 'primary'}" data-gen="add" ${picked ? '' : 'disabled'}>${icon('plus')}Add ${picked} level${picked === 1 ? '' : 's'}</button>`;
        const replace = `<button type="button" class="btn btn--${fresh ? 'primary' : 'secondary'}" data-gen="replace" ${picked ? '' : 'disabled'}>${fresh ? `Use ${picked === 1 ? 'this level' : `these ${picked}`}` : 'Replace every level'}</button>`;
        actions.innerHTML = `<button type="button" class="btn btn--ghost" data-gen="run">${icon('undo')}Another batch</button><span class="grow"></span>${fresh ? add + replace : replace + add}`;
      };
      const stop = () => { worker?.terminate(); worker = null; running = false; };
      const run = () => {
        stop();
        state.seed = ($('#gen-seed').value || '').trim() || seedFor(store);
        $('#gen-seed').value = state.seed;
        const curve = CURVES.find(c => c.id === state.curve);
        result = null; list.innerHTML = ''; running = true; renderActions();
        status.innerHTML = `<div class="meter"><i style="width:0%"></i></div><span class="meta">Making candidates and checking each one…</span>`;
        const opts = { count: state.count, biome: state.biome, from: curve.from, to: curve.to, seed: state.seed };
        const t0 = performance.now();
        const done = res => {
          running = false; worker?.terminate(); worker = null;
          result = res;
          const secs = ((performance.now() - t0) / 1000).toFixed(1);
          if (!res.levels.length) {
            status.innerHTML = `<span class="tally tally--warn">None passed</span><span class="meta">${res.rejected} candidates failed their checks. Try another seed.</span>`;
          } else {
            status.innerHTML = `<span class="tally tally--ready">${res.levels.length} ready</span><span class="meta">${res.attempts} candidates made, ${res.rejected} thrown away by the checks · ${secs} s · seed ${esc(state.seed)}</span>`;
            list.innerHTML = res.levels.map((r, i) => `<li class="gen-item">
              <label class="gen-item__pick"><input type="checkbox" checked data-pick="${i}" aria-label="Include ${esc(r.level.name)}"></label>
              <canvas class="gen-item__thumb" width="${genre === 'platformer' ? 256 : 160}" height="96" data-thumb="${i}" aria-hidden="true"></canvas>
              <div class="gen-item__body">
                <p class="gen-item__title"><strong>${i + 1}. ${esc(r.level.name)}</strong><span class="gen-diff" style="--d:${r.score.toFixed(2)}" title="Difficulty ${Math.round(r.score * 100)} of 100"><i></i>${r.label} ${Math.round(r.score * 100)}</span></p>
                <p class="meta">${esc(r.facts.join(' · '))} · ${r.level.width}×${r.level.height} · ${esc(BIOMES.find(b => b.id === r.level.biome)?.name || r.level.biome)}</p>
              </div></li>`).join('');
            for (const c of list.querySelectorAll('canvas[data-thumb]')) drawLevelThumb(c, res.levels[+c.dataset.thumb].level, genre, art);
            // the results take the room; the settings fold into one line
            $('[data-summary]').textContent = `${state.count} level${state.count === 1 ? '' : 's'} · ${CURVES.find(c => c.id === state.curve).label} · ${state.biome === 'mixed' ? 'Mixed biomes' : BIOMES.find(b => b.id === state.biome).name} · seed ${state.seed}`;
            dlg.classList.add('has-results');
          }
          renderActions();
          (actions.querySelector('.btn--primary') || actions.querySelector('button'))?.focus();
        };
        const fail = msg => { running = false; stop(); status.innerHTML = `<span class="tally tally--live">Failed</span><span class="meta">${esc(msg)}</span>`; renderActions(); };
        try {
          worker = new Worker('/src/play2d/editor/generate-worker.js', { type: 'module' });
          worker.onmessage = e => {
            const m = e.data;
            if (m.type === 'progress') { const bar = status.querySelector('.meter i'); if (bar) bar.style.width = `${Math.round((100 * m.done) / m.total)}%`; const t = status.querySelector('.meta'); if (t) t.textContent = `Checked ${m.attempts} candidates: ${m.kept} kept, ${m.rejected} thrown away…`; }
            else if (m.type === 'done') done(m.result);
            else if (m.type === 'error') fail(m.message);
          };
          worker.onerror = ev => fail(ev.message || 'The generator stopped unexpectedly.');
          worker.postMessage({ genre, opts });
        } catch (e) { fail(e.message); }
      };
      dlg.addEventListener('input', e => {
        if (e.target.id === 'gen-count') { state.count = +e.target.value; $('output[for=gen-count]').textContent = state.count; }
      });
      dlg.addEventListener('change', e => { if (e.target.dataset.pick !== undefined) renderActions(); });
      dlg.addEventListener('click', e => {
        const opt = e.target.closest('.seg__opt');
        if (opt) {
          const group = opt.closest('.seg');
          for (const o of group.querySelectorAll('.seg__opt')) { const on = o === opt; o.classList.toggle('is-on', on); o.setAttribute('aria-checked', on); }
          if (opt.dataset.curve) { state.curve = opt.dataset.curve; $('[data-curve-help]').textContent = CURVES.find(c => c.id === state.curve).help; }
          if (opt.dataset.biome) state.biome = opt.dataset.biome;
          return;
        }
        const b = e.target.closest('[data-gen]');
        if (!b) return;
        const kind = b.dataset.gen;
        if (kind === 'run') return run();
        if (kind === 'edit') { dlg.classList.remove('has-results'); $('#gen-count').focus(); return; }
        if (kind === 'cancel') { stop(); status.innerHTML = '<span class="meta">Stopped.</span>'; renderActions(); return; }
        if (kind === 'add' || kind === 'replace') {
          const picked = [...list.querySelectorAll('input[data-pick]:checked')].map(c => result.levels[+c.dataset.pick].level);
          const n = store.insertLevels(picked, { replace: kind === 'replace', label: kind === 'replace' ? 'Use generated levels' : 'Add generated levels' });
          if (n) toast(`${kind === 'replace' ? 'The game now has' : 'Added'} ${n} generated level${n === 1 ? '' : 's'}. Undo takes ${n === 1 ? 'it' : 'them'} back in one step.`, 'ok', { ms: 5000 });
          stop();
          close(kind);
        }
      });
      // Enter in the seed field generates
      $('#gen-seed').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
      renderActions();
      // a dialog closed by Escape or the X stops the worker too
      const obs = new MutationObserver(() => { if (!dlg.isConnected) { stop(); obs.disconnect(); } });
      obs.observe(document.getElementById('dialogs'), { childList: true });
    },
  });
}
