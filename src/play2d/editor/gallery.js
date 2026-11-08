/**
 * The start screen: five template games playing live in their cards, blank starts for each
 * genre, the games saved in this browser and a way in for project files. Previews are real
 * games in preview mode (critters roam, the camera drifts), paused while off screen; with
 * reduced motion they are still frames.
 */
import { GENRES, genreById, BIOMES } from '../core/catalog.js';
import { createGame } from '../runtime/game.js';
import { drawScene, sceneFromLevel, fitCamera } from '../runtime/render.js';
import { icon } from './icons.js';
import { esc } from './dialogs.js';

const GENRE_ICON = { platformer: 'bolt', adventure: 'reach', arena: 'target', maze: 'grid', puzzle: 'cube' };
const isDaylight = () => (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'daylight' : 'stage')) === 'daylight';

export function renderGallery(el, o) {
  const games = [];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const recent = o.recent || [];
  const ago = t => { const s = Math.max(1, Math.round((Date.now() - t) / 1000)); if (s < 60) return 'just now'; const m = Math.round(s / 60); if (m < 60) return `${m} min ago`; const h = Math.round(m / 60); if (h < 24) return `${h} h ago`; return `${Math.round(h / 24)} d ago`; };
  el.innerHTML = `
    <div class="g-bar">
      <span class="brand"><svg class="brand__mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M5 7h7v7H5zM12 14h7v7h-7zM19 21h8v6h-8z" fill="currentColor"/><path d="M5 21h7v6H5zM19 7h8v7h-8z" fill="none" stroke="var(--peaking)" stroke-width="1.6"/></svg><span class="brand__word">Visigame</span><span class="brand__sub meta">Builder</span></span>
      <span class="grow"></span>
      <button type="button" class="btn btn--secondary" data-g="open" aria-label="Open a file">${icon('folder')}<span class="btn__label">Open a file</span></button>
      ${o.current ? `<button type="button" class="btn btn--primary g-bar__continue" data-g="continue" title="Back to ${esc(o.current.title)}">${icon('chevronLeft')}<span class="btn__label">Back to ${esc(o.current.title)}</span></button>` : ''}
    </div>
    <div class="g-wrap">
      <header class="g-hero">
        <p class="meta">Level builder · Five genres · No code</p>
        <h1 id="gallery-title">Build a level. <span class="g-hero__pop">Play it now.</span></h1>
        <p>Paint a grid, drop in critters, wire the gates. Every level is checked as you build, plays in a click, and exports as one HTML file you own.</p>
      </header>

      ${o.world ? `<section class="g-section g-world" aria-labelledby="g-world">
        <div class="g-section__head"><h2 id="g-world">Your world, in 2D</h2><span class="meta">The editor's world, seed ${esc(o.world.seed)}</span></div>
        <div class="g-blank"><div class="g-tile g-tile--world">${icon('grid')}<strong>An adventure on your world's ground</strong>
          <span>Its coast, its slopes and its flats read square by square from the same ground the 3D world stands on: water is a pond or the edge, steep ground is a wall, flat ground a path. Start and goal are joined on foot in 2D and in 3D.</span>
          <div class="g-tile__foot"><button type="button" class="btn btn--primary btn--sm" data-g="world" aria-label="Make a 2D adventure of your world">${icon('wand')}Make it</button></div>
        </div></div>
      </section>` : ''}

      <section class="g-section" aria-labelledby="g-templates">
        <div class="g-section__head"><h2 id="g-templates">Start from a template</h2><span class="meta">3 levels each · Remix anything</span></div>
        <div class="g-cards">
          ${o.templates.map((t, n) => {
            const g = genreById(t.genre);
            return `<article class="g-card${n === 0 ? ' g-card--feature' : ''}">
              <i class="c"></i><i class="c"></i><i class="c"></i><i class="c"></i>
              <div class="g-card__art"><span class="g-card__status meta">${g.view === 'side' ? 'Side view' : 'Top-down'}</span><div data-preview="${esc(t.id)}" aria-hidden="true"></div></div>
              <div class="g-card__body">
                <p class="meta">${esc(g.verbs)}</p>
                <h3>${esc(t.name)}</h3>
                <p>${esc(t.tagline)}</p>
              </div>
              <div class="g-card__foot">
                <button type="button" class="btn btn--secondary" data-g="template" data-id="${esc(t.id)}" aria-label="Use the ${esc(t.name)}">${icon('wand')}Use template</button>
                <button type="button" class="btn btn--ghost" data-g="try" data-id="${esc(t.id)}" aria-label="Play ${esc(t.name)}">${icon('play')}Play it</button>
              </div>
            </article>`;
          }).join('')}
        </div>
      </section>

      <section class="g-section" aria-labelledby="g-blank">
        <div class="g-section__head"><h2 id="g-blank">Or start blank, or generate</h2><span class="meta">Generated levels are checked before you see them</span></div>
        <div class="g-blank">
          ${GENRES.map(g => `<div class="g-tile">${icon(GENRE_ICON[g.id])}<strong>${esc(g.name)}</strong><span>${esc(g.blurb)}</span>
            <div class="g-tile__foot">
              <button type="button" class="btn btn--secondary btn--sm" data-g="blank" data-genre="${g.id}" aria-label="Start a blank ${esc(g.name.toLowerCase())} game">Blank</button>
              <button type="button" class="btn btn--ghost btn--sm" data-g="generate" data-genre="${g.id}" aria-label="Generate a ${esc(g.name.toLowerCase())} game">${icon('wand')}Generate</button>
            </div></div>`).join('')}
        </div>
      </section>

      ${recent.length ? `<section class="g-section" aria-labelledby="g-recent">
        <div class="g-section__head"><h2 id="g-recent">Your games</h2><span class="meta">Saved in this browser</span></div>
        <ul class="g-recent">
          ${recent.map(r => `<li>
            <span class="grow"><strong>${esc(r.title)}</strong><span class="meta">${esc(genreById(r.genre)?.name || '')} · ${r.levels} level${r.levels === 1 ? '' : 's'} · ${ago(r.at)}</span></span>
            <button type="button" class="btn btn--secondary btn--sm" data-g="recent" data-id="${esc(r.id)}">Open</button>
            <button type="button" class="icon-btn icon-btn--sm" data-g="forget" data-id="${esc(r.id)}" aria-label="Delete ${esc(r.title)} from this browser" data-tip="Delete">${icon('trash')}</button>
          </li>`).join('')}
        </ul>
      </section>` : ''}

      <section class="g-section" aria-label="What the builder does for you">
        <div class="g-facts">
          <div><p class="meta">Checked as you build</p><p>Reachability, keys for every gate, solvable puzzles and budgets, before anyone presses Play.</p></div>
          <div><p class="meta">Plays anywhere</p><p>Keyboard, gamepad and touch, from a phone to a desktop. Share a link, or download one file.</p></div>
          <div><p class="meta">Yours to publish</p><p>Exported games are yours. Hooks for ad breaks and rewarded continues are ready for your web portal.</p></div>
        </div>
      </section>

      <footer class="g-foot meta"><span>Visigame by Visigence</span></footer>
    </div>`;

  // live previews
  for (const box of el.querySelectorAll('[data-preview]')) {
    const t = o.templates.find(x => x.id === box.dataset.preview);
    const project = t.build({ id: 'preview-' + t.id });
    const levelIndex = 0;
    if (reduced) {
      const c = document.createElement('canvas');
      box.appendChild(c);
      requestAnimationFrame(() => {
        const r = box.getBoundingClientRect();
        c.width = Math.max(1, Math.round(r.width)); c.height = Math.max(1, Math.round(r.height));
        c.style.width = '100%'; c.style.height = '100%';
        const scene = sceneFromLevel(project, levelIndex, 0);
        const cam = scene.view === 'side' ? { x: 0, y: Math.max(0, scene.H - c.height / Math.max(10, Math.round(c.height / 14))), size: Math.max(10, Math.round(c.height / 14)) } : fitCamera(scene, c.width, c.height, { margin: 0.3 });
        drawScene(c.getContext('2d'), scene, cam, o.art, { width: c.width, height: c.height, t: 0, editor: true });
      });
    } else {
      games.push(createGame(box, project, { mode: 'preview', art: o.art, levelIndex }));
    }
  }

  el.onclick = e => {
    const b = e.target.closest('[data-g]');
    if (!b) return;
    const kind = b.dataset.g;
    if (kind === 'template') o.onTemplate(b.dataset.id);
    else if (kind === 'try') o.onTry(b.dataset.id);
    else if (kind === 'blank') o.onBlank(b.dataset.genre);
    else if (kind === 'generate') o.onGenerate?.(b.dataset.genre);
    else if (kind === 'recent') o.onOpen(b.dataset.id);
    else if (kind === 'forget') o.onForget(b.dataset.id);
    else if (kind === 'open') o.onOpenFile();
    else if (kind === 'continue') o.onContinue();
    else if (kind === 'world') o.onWorld?.();
    else if (kind === 'theme') { o.onTheme(); b.innerHTML = icon(isDaylight() ? 'moon' : 'sun'); }
  };
  void BIOMES;
  return { destroy() { for (const g of games) g.destroy(); games.length = 0; el.innerHTML = ''; } };
}
