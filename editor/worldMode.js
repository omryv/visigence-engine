/**
 * WORLD MODE: the first of the engine's modes. A seed is a world; this is where the whole of it is seen, and where a
 * level on it is played from.
 *
 * The page asks a worker for the seed's world (src/world/worldWorker.js: the quick look, then the canonical ground) and
 * draws it with src/render/WorldView.js on the engine's renderer. The renderer is made when the mode is entered and
 * disposed when it is left; the studio lets Play's session go when World is entered (editor/studio.js releaseSession),
 * so the page holds one GPU context at a time.
 *
 * "Play here" hands the seed to Play: the mission card's level stands on this world (src/world/kernelGround.js), on
 * the first of the marked sites where the mission's ground can be met.
 */
import { escapeHtml as esc } from './BlueprintBoard.js';
import { normalizeSeed } from '../src/kernel/seed.js';

const fmt = (v, d = 0) => Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });

/**
 * @param {{getSeed: () => string, setSeed: (seed: string) => string, play: () => void, toast: (m: string) => void}} o
 *   getSeed/setSeed: the seed the Play front holds (one seed for the whole tool); play: open the mission on it
 */
export function mountWorldMode({ getSeed, setSeed, play, toast }) {
  const root = document.createElement('section');
  root.id = 'world-mode'; root.setAttribute('aria-label', 'World'); root.hidden = true;
  root.innerHTML = `
    <div class="world-stage"><canvas class="world-canvas" aria-label="The seed's world. Drag to turn, scroll to zoom."></canvas><div class="world-labels" aria-hidden="true"></div></div>
    <div class="world-panel">
      <span class="eyebrow">WORLD</span>
      <h1>Every seed is a world.</h1>
      <p class="world-lede">A 4 km plate the Genesis Kernel grows from one seed: shaped, eroded by droplets, flooded from the sea and drained. A level is 640 m of it, played at 1:8.</p>
      <form class="world-seed"><label for="world-seed">SEED</label><div><input id="world-seed" maxlength="24" spellcheck="false" autocomplete="off"><button type="button" data-world-shuffle aria-label="A new seed">New</button></div></form>
      <dl class="world-facts"></dl>
      <ol class="world-sites"></ol>
      <button class="world-play primary" data-world-play><span>Play here</span><small>A mission on this world</small></button>
      <p class="world-note"></p>
    </div>`;
  document.body.append(root);
  const $ = s => root.querySelector(s);
  let view = null, worker = null, ask = 0, visit = 0, bake = null, quick = null;

  function facts() {
    const b = bake ?? quick;
    if (!b) { $('.world-facts').innerHTML = '<div><dt>Ground</dt><dd>Growing…</dd></div>'; return; }
    const ms = b.manifest.stages?.reduce((a, s) => a + (s.ms ?? 0), 0);
    $('.world-facts').innerHTML = [
      ['Ground', b.quick ? `${b.res}² · first look, eroding…` : `${b.res}² · eroded${ms ? ` in ${fmt(ms / 1000, 1)} s` : ''}`],
      ['Land', `${fmt(b.land * 100)}% of the plate`],
      ['Relief', `${fmt(b.min)} m to ${fmt(b.max)} m`],
      ['Height hash', `<code>${esc(b.manifest.heightHash)}</code>`],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
    const sites = bake?.sites ?? [];
    $('.world-sites').innerHTML = !bake ? '' : sites.length
      ? sites.map((s, n) => `<li><button type="button" data-site="${n}"><b>${n + 1}</b><span>${['First', 'Second', 'Third'][n] ?? 'Next'} choice<small>${fmt(s.span)} m · ${fmt(s.relief)} m of relief</small></span></button></li>`).join('')
      : '<li class="world-nosite">No dry, gentle 640 m site on this world: a level here keeps the village’s own ground.</li>';
    $('.world-note').textContent = view ? `Drawn on ${view.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'} · heights ×1.6 for legibility · a level stands on the first site its mission can be met on.` : '';
  }

  function labels() {
    const host = $('.world-labels');
    if (!view || !bake) { host.innerHTML = ''; return; }
    if (host.childElementCount !== view.sites.length) host.innerHTML = view.sites.map((_, n) => `<span class="world-pin${n ? '' : ' first'}">${n + 1}</span>`).join('');
    view.sites.forEach((_, n) => { const p = view.project(n), el = host.children[n]; el.hidden = !p; if (p) el.style.transform = `translate(${p.x}px, ${p.y}px)`; });
  }

  function request(seed) {
    const id = ++ask; bake = null; quick = null; facts();
    worker ??= new Worker(new URL('../src/world/worldWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.id !== ask) return;
      if (data.type === 'error') { toast(`This world could not be grown: ${data.message}`); return; }
      if (data.type === 'quick') quick = data.bake; else if (data.type === 'world') bake = data.bake; else return;
      view?.show(data.bake); facts(); labels();
    };
    worker.postMessage({ id, seed });
  }

  async function enter() {
    root.hidden = false;
    const mine = ++visit, seed = getSeed(); $('#world-seed').value = seed;
    if (!view) {
      let v = null;
      try {
        const { WorldView } = await import('../src/render/WorldView.js');
        v = new WorldView($('.world-canvas'));
        await v.init();
      } catch (err) { v?.dispose(); if (mine === visit) toast(`World view could not start: ${err.message}`); return; }
      // Left (or left and entered again) while the renderer started: this one is drawing on a canvas that is gone.
      if (mine !== visit || root.hidden) { v.dispose(); return; }
      v.onFrame = labels; view = v;
    }
    if (!bake || bake.seed !== seed) request(seed); else view.show(bake);
    facts();
  }

  function leave() {
    root.hidden = true; visit++;
    view?.dispose(); view = null;
    // A canvas stays bound to the context it first handed out, and a disposed renderer may have lost it: the next
    // visit draws on a fresh one.
    const canvas = $('.world-canvas'); canvas.replaceWith(canvas.cloneNode());
    $('.world-labels').innerHTML = '';
  }

  function choose(input) {
    const seed = normalizeSeed(String(input ?? ''));
    if (!seed) { toast('A seed is letters and digits.'); return; }
    $('#world-seed').value = setSeed(seed);
    if (!root.hidden) request(getSeed());
  }

  $('.world-seed').addEventListener('submit', e => { e.preventDefault(); choose($('#world-seed').value); });
  $('#world-seed').addEventListener('change', () => choose($('#world-seed').value));
  root.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-world-shuffle')) choose(Array.from(crypto.getRandomValues(new Uint8Array(12)), n => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[n % 32]).join('').match(/.{4}/g).join('-'));
    if (b.dataset.site) view?.focus(Number(b.dataset.site));
    if (b.hasAttribute('data-world-play')) play();
  });
  // ?debug=1: the view itself, for the browser harness (tools/test/e2e-world.mjs reads the GPU's frame through it).
  if (new URLSearchParams(location.search).has('debug')) window.__world = { view: () => view, bake: () => bake };
  return { enter, leave, get bake() { return bake; } };
}
