/**
 * The level editor's start screen: the games saved in this browser, the five template games (one per genre, each
 * card mapping its levels from the same compile the editor uses), a blank start per genre, and a way in for project
 * files. On a wide screen the viewport beside it previews the card in front live, in 3D (app.js drives that); on a
 * phone the maps are the preview and "Play it" plays the real level.
 *
 * The templates are a deck that turns, like choosing a cartridge: one card in front, its neighbours angled away behind
 * it, the rest out of sight round the back. The arrows, the dots, the arrow keys, a swipe or a click on a card behind
 * turn it; the card in front is the one the preview shows.
 *
 * Rendering and events only: every action goes back to the app through `actions`.
 */
import { icon } from './icons.js';
import { esc } from './panels.js';
import { GENRES } from '../../src/genres/registry.js';

const GENRE_ICON = { shooter: 'enemy', exploration: 'flag', action: 'pad', arena: 'focus', collect: 'drop' };
const WORLD = { arcade: 'Meadow', desert: 'Desert', snow: 'Snow' };
/** The template's title already names its genre; its badge says how it is seen. */
const VIEW = { first: 'First person', follow: 'Third person', overhead: 'Top-down' };
const ago = (t, now = Date.now()) => {
  const s = Math.max(1, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
};

/**
 * @param {HTMLElement} el  #bld-start
 * @param {object} o
 * @param {object[]} o.templates      world/level/templates.js TEMPLATES
 * @param {object} o.library          library.js
 * @param {(id: string, level: number) => Promise<string>} o.mapFor   a template level's map (SVG markup)
 * @param {object} o.actions          use(id), tryIt(id, level), blank(genre), open(id), remove(id), file(File), focus(id, level), back()
 */
export function createStart(el, { templates, library, mapFor, actions }) {
  const chosen = new Map(templates.map(t => [t.id, 0]));
  let confirming = null, current = null, front = 0;

  function render(state = {}) {
    current = state.current ?? null;
    const saves = library.list();
    el.innerHTML = `
      <div class="bld-start__wrap">
        <header class="bld-start__hero">
          <p class="bld-meta">Level editor · Five genres · Three levels each</p>
          <h2>Make a 3D arcade game.</h2>
          <p>Start from a finished game and change anything in it, or start blank in a genre. Every level is checked while you build, plays in a click and exports as a game you own.</p>
          <div class="bld-start__actions">
            ${current ? `<button type="button" class="bld-btn bld-btn--primary" data-start="back">${icon('chevronLeft')}Back to ${esc(current.name)}</button>` : ''}
            <label class="bld-btn bld-btn--secondary bld-start__file">${icon('folder')}Open a game file<input type="file" accept=".json,application/json" data-start="file" class="sr-only"></label>
          </div>
        </header>
        ${saves.length ? `<section class="bld-start__section" aria-labelledby="bld-start-saves">
          <div class="bld-start__head"><h2 id="bld-start-saves">Your games</h2><span class="bld-meta">Saved in this browser</span></div>
          <ul class="bld-saves">${saves.map(save).join('')}</ul>
        </section>` : ''}
        <section class="bld-start__section" aria-labelledby="bld-start-templates">
          <div class="bld-start__head"><h2 id="bld-start-templates">Start from a template</h2><span class="bld-meta">Three levels each · Remix anything</span></div>
          <div class="bld-deck" role="region" aria-roledescription="carousel" aria-labelledby="bld-start-templates">
            <div class="bld-deck__ring">${templates.map(card).join('')}</div>
            <div class="bld-deck__nav">
              <button type="button" class="bld-icon" data-start="deck-prev" aria-label="Previous template">${icon('chevronLeft')}</button>
              <div class="bld-deck__dots" role="group" aria-label="Templates">${templates.map((t, i) => `<button type="button" data-start="deck-go" data-index="${i}" aria-label="${esc(t.name)}"></button>`).join('')}</div>
              <button type="button" class="bld-icon" data-start="deck-next" aria-label="Next template">${icon('chevronRight')}</button>
            </div>
          </div>
        </section>
        <section class="bld-start__section" aria-labelledby="bld-start-blank">
          <div class="bld-start__head"><h2 id="bld-start-blank">Or start blank</h2><span class="bld-meta">One level, its mission ready to play</span></div>
          <div class="bld-blanks">${Object.values(GENRES).map(g => `<button type="button" class="bld-blank" data-start="blank" data-genre="${g.id}">${icon(GENRE_ICON[g.id] ?? 'cube')}<span><b>${esc(g.label)}</b><small>${esc(g.description)}</small></span></button>`).join('')}</div>
        </section>
      </div>`;
    for (const t of templates) drawMap(t.id);
    arrange();
  }
  function save(s) {
    const g = GENRES[s.genre], meta = `${esc(g?.label ?? s.genre)} · ${s.levels} level${s.levels === 1 ? '' : 's'} · ${ago(s.updated)}`;
    if (confirming === s.id) return `<li class="bld-save bld-save--confirm" data-id="${esc(s.id)}"><span>Delete <b>${esc(s.name)}</b> from this browser? This can't be undone.</span>
      <button type="button" class="bld-btn bld-btn--danger bld-btn--sm" data-start="remove-yes">Delete</button><button type="button" class="bld-btn bld-btn--secondary bld-btn--sm" data-start="remove-no">Keep</button></li>`;
    return `<li class="bld-save" data-id="${esc(s.id)}"><button type="button" class="bld-save__open" data-start="open">${icon(GENRE_ICON[s.genre] ?? 'cube')}<span><b>${esc(s.name)}</b><small>${meta}</small></span></button>
      <button type="button" class="bld-icon" data-start="remove" aria-label="Delete ${esc(s.name)}">${icon('trash')}</button></li>`;
  }
  function card(t, i) {
    const g = GENRES[t.genre], at = chosen.get(t.id);
    return `<article class="bld-card" data-template="${esc(t.id)}" aria-roledescription="slide" aria-label="${i + 1} of ${templates.length}: ${esc(t.name)}" style="--accent:${esc(t.accent)}">
      <div class="bld-card__art">
        <div class="bld-card__map" data-map="${esc(t.id)}"><span class="bld-card__loading">Mapping ${esc(t.levels[at].name)}</span></div>
        <span class="bld-card__genre">${icon(GENRE_ICON[t.genre] ?? 'cube')}${esc(VIEW[g.cameras[0]] ?? g.label)}</span>
        <div class="bld-card__levels" role="group" aria-label="Levels of ${esc(t.name)}">${t.levels.map((l, i) => `<button type="button" data-start="level" data-level="${i}" aria-pressed="${i === at}" title="${esc(l.name)}">${i + 1}<span class="sr-only"> ${esc(l.name)}</span></button>`).join('')}</div>
      </div>
      <div class="bld-card__body">
        <h3>${esc(t.name)}</h3>
        <p>${esc(t.tagline)}</p>
        <p class="bld-meta bld-card__meta"><span data-level-name>${esc(t.levels[at].name)}</span> · ${t.levels.map(l => WORLD[l.world] ?? l.world).join(' · ')}</p>
      </div>
      <div class="bld-card__foot">
        <button type="button" class="bld-btn bld-btn--secondary bld-btn--sm" data-start="use" aria-label="Use the ${esc(t.name)}">${icon('plus')}Use template</button>
        <button type="button" class="bld-btn bld-btn--ghost bld-btn--sm" data-start="try" aria-label="Play ${esc(t.name)}, level ${at + 1}">${icon('play')}Play it</button>
      </div>
    </article>`;
  }
  async function drawMap(id) {
    const at = chosen.get(id), box = el.querySelector(`[data-map="${CSS.escape(id)}"]`);
    if (!box) return;
    try { const svg = await mapFor(id, at); if (chosen.get(id) === at && box.isConnected) box.innerHTML = svg; }
    catch (e) { box.innerHTML = `<span class="bld-card__loading">This map could not be drawn: ${esc(e.message)}</span>`; }
  }
  function setLevel(article, i) {
    const t = templates.find(x => x.id === article.dataset.template);
    chosen.set(t.id, i);
    for (const b of article.querySelectorAll('[data-level]')) b.setAttribute('aria-pressed', String(Number(b.dataset.level) === i));
    article.querySelector('[data-level-name]').textContent = t.levels[i].name;
    article.querySelector('[data-start="try"]').setAttribute('aria-label', `Play ${t.name}, level ${i + 1}`);
    drawMap(t.id);
  }
  const focusCard = article => { if (!article) return; for (const a of el.querySelectorAll('.bld-card[data-active]')) a.removeAttribute('data-active'); article.dataset.active = ''; actions.focus(article.dataset.template, chosen.get(article.dataset.template)); };

  /** Lay the deck out round the card in front: its neighbours angled behind it, the rest round the back. */
  function arrange() {
    const cards = [...el.querySelectorAll('.bld-deck .bld-card')], n = cards.length;
    if (!n) return;
    cards.forEach((c, i) => {
      let d = ((i - front) % n + n) % n; if (d > n / 2) d -= n;
      c.style.setProperty('--d', d); c.style.setProperty('--a', Math.abs(d));
      c.dataset.slot = d === 0 ? 'front' : Math.abs(d) === 1 ? 'side' : 'back';
      c.inert = d !== 0;
    });
    for (const b of el.querySelectorAll('[data-start="deck-go"]')) b.setAttribute('aria-current', String(Number(b.dataset.index) === front));
    el.querySelector('.bld-deck__ring').style.height = `${Math.max(...cards.map(c => c.offsetHeight))}px`;
  }
  /** Turn the deck until card i is in front; the preview follows it. */
  function turn(i, { focus = false } = {}) {
    const n = templates.length;
    front = ((i % n) + n) % n;
    arrange();
    const article = el.querySelectorAll('.bld-deck .bld-card')[front];
    focusCard(article);
    if (focus) article.querySelector('[data-start="use"]')?.focus({ preventScroll: true });
  }

  el.addEventListener('click', e => {
    const b = e.target.closest('[data-start]');
    if (!b) {
      // the cards behind the one in front are inert: a click on one lands on the deck, which turns to it
      const ring = e.target.closest('.bld-deck__ring'); if (!ring) return;
      const hit = [...ring.querySelectorAll('.bld-card')].findIndex((c, i) => { if (i === front) return false; const r = c.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; });
      if (hit >= 0) turn(hit);
      return;
    }
    if (b.dataset.start === 'file') return;
    const article = b.closest('.bld-card'), row = b.closest('.bld-save'), id = article?.dataset.template ?? row?.dataset.id;
    switch (b.dataset.start) {
      case 'level': setLevel(article, Number(b.dataset.level)); focusCard(article); break;
      case 'use': actions.use(id); break;
      case 'try': actions.tryIt(id, chosen.get(id)); break;
      case 'blank': actions.blank(b.dataset.genre); break;
      case 'open': actions.open(id); break;
      case 'remove': confirming = id; render({ current }); el.querySelector('[data-start="remove-no"]')?.focus(); break;
      case 'remove-no': confirming = null; render({ current }); el.querySelector(`.bld-save[data-id="${CSS.escape(id)}"] [data-start="remove"]`)?.focus(); break;
      case 'remove-yes': confirming = null; actions.remove(id); render({ current }); break;
      case 'back': actions.back(); break;
      case 'deck-prev': turn(front - 1); break;
      case 'deck-next': turn(front + 1); break;
      case 'deck-go': turn(Number(b.dataset.index)); break;
    }
  });
  el.addEventListener('change', e => { const input = e.target.closest('[data-start="file"]'); if (input?.files?.[0]) { actions.file(input.files[0]); input.value = ''; } });
  // The arrow keys turn the deck while the keyboard is in it; a swipe across it turns it on a touch screen.
  el.addEventListener('keydown', e => {
    if (!e.target.closest('.bld-deck') || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault(); turn(front + (e.key === 'ArrowRight' ? 1 : -1), { focus: !!e.target.closest('.bld-card') });
  });
  let swipe = null;
  el.addEventListener('pointerdown', e => { if (e.target.closest('.bld-deck__ring') && e.pointerType !== 'mouse') swipe = { x: e.clientX, y: e.clientY }; });
  el.addEventListener('pointerup', e => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y; swipe = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) turn(front + (dx < 0 ? 1 : -1));
  });
  el.addEventListener('pointercancel', () => { swipe = null; });
  window.addEventListener('resize', () => { if (el.querySelector('.bld-deck')) arrange(); });

  return { render, focusFirst: () => turn(front) };
}
