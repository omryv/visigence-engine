/**
 * Arriving with a vision: the landing page's bee asks "What is your vision?" and sends the
 * answer here as `?vision=`. The studio reads it (src/world/vision.js, the words in
 * src/world/visionLexicon.json), opens the canvas on the project those words build, and
 * lands the Blender transition: the landing's dive ends on warm bokeh (transition-end.jpg),
 * which defocuses away while the blueprint assembles node by node, each word lighting up
 * as the node it made arrives. See docs/VISION.md.
 */
import { readVision, VISION_MAX_CHARS } from '../src/world/vision.js';
import { assetURL } from '../src/config/assetDelivery.js';
import { escapeHtml } from './BlueprintBoard.js';

const END_FRAME = 'assets/v2/landing/transition-end.jpg';
/** Pools, then the generator, the mission in order, the output: the order the canvas assembles in. */
const ORDER = ['world', 'weapons', 'enemies', 'doors', 'props', 'generator'];
const STAGGER = 90;
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The vision in this page's address, trimmed to what a vision may hold, or null. */
export function visionFromURL(search = location.search) {
  const text = new URLSearchParams(search).get('vision');
  return text && text.trim() ? text.trim().slice(0, VISION_MAX_CHARS) : null;
}

/** The last frame of the landing's dive, over everything, until the canvas is ready under it. */
function veil() {
  const el = document.createElement('div');
  el.className = 'vision-veil';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<img src="${assetURL(END_FRAME)}" alt="">`;
  document.body.append(el);
  return {
    lift() {
      if (reduced()) { el.remove(); return; }
      el.classList.add('is-lifting');
      el.addEventListener('transitionend', () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 1600);
    },
  };
}

function nodeOrder(blueprint) {
  const steps = blueprint.nodes.filter(n => n.kind === 'objective').map(n => n.id);
  return [...ORDER, ...steps, 'output'];
}

/** The sentence, with every understood word marked and tied to the node it made. */
function readingStrip(vision, order) {
  const parts = []; let at = 0;
  for (const r of vision.reading) {
    parts.push(escapeHtml(vision.text.slice(at, r.start)));
    const i = r.node ? Math.max(0, order.indexOf(r.node)) : order.length;
    const title = r.node ? r.label : `${r.label} (not used in this genre)`;
    parts.push(`<mark tabindex="0" class="${r.node ? '' : 'is-dropped'}" data-node="${escapeHtml(r.node ?? '')}" style="--i:${i}" title="${escapeHtml(title)}">${escapeHtml(vision.text.slice(r.start, r.end))}<small>${escapeHtml(r.label)}</small></mark>`);
    at = r.end;
  }
  parts.push(escapeHtml(vision.text.slice(at)));
  const n = vision.reading.length;
  const foot = n ? `${n} ${n === 1 ? 'word' : 'words'} understood` : 'No words matched yet, so this is a starting village';
  const el = document.createElement('section');
  el.className = 'vision-reading';
  el.setAttribute('aria-label', 'Your vision');
  el.innerHTML = `<div class="vr-head"><span class="vr-eyebrow">Your vision</span><span class="vr-foot">${foot} · seed ${escapeHtml(vision.project.seed)}</span><button class="vr-close" type="button" aria-label="Hide your vision">×</button></div>
    <p class="vr-text" dir="auto">${parts.join('')}</p>
    ${vision.unmatched.length ? `<p class="vr-unread">Not in the word list yet: ${vision.unmatched.slice(0, 8).map(escapeHtml).join(', ')}</p>` : ''}`;
  el.querySelector('.vr-close').addEventListener('click', () => el.remove());
  const light = (mark, on) => {
    const id = mark.dataset.node;
    if (id) document.querySelector(`[data-bp-node="${CSS.escape(id)}"]`)?.classList.toggle('vision-lit', on);
  };
  for (const mark of el.querySelectorAll('mark')) {
    for (const [type, on] of [['mouseenter', true], ['mouseleave', false], ['focus', true], ['blur', false]]) mark.addEventListener(type, () => light(mark, on));
  }
  return el;
}

/** Play the canvas assembling: each node in order, then the wires between them. */
function assemble(order) {
  if (reduced()) return;
  const stage = document.querySelector('#graph-stage');
  if (!stage) return;
  for (const el of stage.querySelectorAll('[data-bp-node]')) {
    const i = order.indexOf(el.dataset.bpNode);
    el.style.setProperty('--i', String(i < 0 ? order.length : i));
    el.classList.add('vision-in');
    el.addEventListener('animationend', () => el.classList.remove('vision-in'), { once: true });
  }
  const wires = stage.querySelector('svg');
  if (wires) {
    wires.style.setProperty('--wire-delay', `${order.length * STAGGER}ms`);
    wires.classList.add('vision-wires');
    wires.addEventListener('animationend', () => wires.classList.remove('vision-wires'), { once: true });
  }
}

/**
 * Build the vision's project and land on the canvas. `enterCanvas` switches the studio to
 * Remix; `change` applies the project (so Undo returns to what was there before).
 */
export async function arriveWithVision(text, { change, enterCanvas, fitGraph, toast }) {
  const cover = veil();
  // Drop the vision from the address so a reload keeps the player's edits instead of rebuilding.
  try {
    const url = new URL(location.href); url.searchParams.delete('vision');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  } catch { /* an address that cannot be rewritten only means a reload reads the vision again */ }
  let vision;
  try {
    const lexicon = await (await fetch(new URL('../src/world/visionLexicon.json', import.meta.url))).json();
    vision = readVision(text, lexicon);
    enterCanvas();
    change(vision.project);
  } catch (error) {
    cover.lift();
    toast(`Your vision could not be turned into a game: ${error.message}. Start from a world instead.`);
    return null;
  }
  const order = nodeOrder(vision.project.blueprint);
  const panel = document.querySelector('.graph.panel');
  panel?.querySelector('.vision-reading')?.remove();
  panel?.insertBefore(readingStrip(vision, order), panel.querySelector('.graph-viewport'));
  document.documentElement.style.setProperty('--vision-stagger', `${STAGGER}ms`);
  requestAnimationFrame(() => {
    fitGraph();
    assemble(order);
    cover.lift();
    document.querySelector('#compile-top')?.focus({ preventScroll: true });
  });
  return vision;
}
