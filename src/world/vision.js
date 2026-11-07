/**
 * THE VISION READER: a sentence a player typed ("a snowy fort where bees guard the honey")
 * becomes a project, deterministically and with no AI in the loop.
 *
 * The words live in data (src/world/visionLexicon.json, English and Hebrew); this file is
 * only the rules for reading them. It imports nothing from three and nothing that reads the
 * network, so the studio, a test and a bake all read a sentence the same way, and the same
 * sentence always builds the same game: the seed is derived from the words themselves.
 *
 *   readVision(text, lexicon) -> { project, reading, unmatched, text }
 *
 * `project` is an input for resolveProject (name, seed, genre, choices and a full blueprint
 * that compileBlueprint accepts under the genre's rules). `reading` lists every word that was
 * understood, in the order it was typed, with the entry it matched and the blueprint node it
 * made, which is what the studio shows while the canvas assembles. See docs/VISION.md.
 */
import { CATALOG } from './catalog.js';
import { GENRES, DEFAULT_GENRE } from '../genres/registry.js';
import { normalizeSeed } from '../kernel/seed.js';

export const VISION_MAX_CHARS = 280;
const THEME = 'arcade';
/** How many of each step a mission asks for when the sentence does not say. */
const DEFAULT_COUNT = { activate: 3, override: 1, waves: 2, eliminate: 1, boss: 1, barricade: 2, reach: 1, extract: 1 };
/** Upper bounds per step, inside the blueprint compiler's 12-interaction budget. */
const MAX_COUNT = { activate: 4, override: 3, waves: 5, eliminate: 3, boss: 1, barricade: 3, reach: 1, extract: 1 };
const STEP_DURATION = { activate: 3.4, override: 2.5, barricade: 2, extract: 1.5 };
const MAX_STEPS = 5;
/** Which blueprint node a matched entry lands on, for the studio's reading strip. */
const NODE_OF = { world: 'world', enemies: 'enemies', weapons: 'weapons', objectives: null, genre: 'generator', difficulty: 'generator', lighting: 'generator', behavior: 'enemies', enemyCount: 'enemies' };

/** Lower-case, fold Hebrew final letters and geresh, keep letters, digits and apostrophes. */
export function normalizeWord(word) {
  return String(word).toLowerCase().normalize('NFKC')
    .replace(/[׳’‘`]/g, "'")
    .replace(/[֑-ׇ]/g, '')                       // Hebrew points and cantillation
    .replace(/[ךםןףץ]/g, c => ({ 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' })[c])
    .replace(/^'+|'+$/g, '');
}
/** Split a sentence into tokens, keeping where each one starts in the original text. */
export function tokenize(text) {
  const out = [];
  for (const m of String(text).matchAll(/[\p{L}\p{N}'׳’]+/gu)) {
    const norm = normalizeWord(m[0]);
    if (norm) out.push({ raw: m[0], norm, start: m.index, end: m.index + m[0].length, lang: /[֐-׿]/.test(m[0]) ? 'he' : 'en' });
  }
  return out;
}
/** The forms a token may stand for: itself, then plural/tense/adjective endings and Hebrew prefixes removed. */
function forms(token, prefixes) {
  const w = token.norm, list = [w];
  if (token.lang === 'en') {
    const add = f => { if (f.length > 1 && !list.includes(f)) list.push(f); };
    if (w.endsWith("'s")) add(w.slice(0, -2));
    if (w.endsWith('ies')) add(w.slice(0, -3) + 'y');
    if (w.endsWith('es')) add(w.slice(0, -2));
    if (w.endsWith('s') && !w.endsWith('ss')) add(w.slice(0, -1));
    if (w.endsWith('ing')) { add(w.slice(0, -3)); add(w.slice(0, -3) + 'e'); }
    if (w.endsWith('ed')) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
    if (w.endsWith('y')) add(w.slice(0, -1));
  } else {
    // Up to two one-letter prefixes (ו, ה, ב, ל, מ, ש, כ): "והדבורים" -> "דבורים".
    const stems = [w];
    for (let i = 0; i < 2; i++) for (const s of [...stems]) if (s.length > 2 && prefixes.includes(s[0])) stems.push(s.slice(1));
    for (const s of stems) {
      for (const f of [s, s.replace(/(ימ|ות)$/, ''), s.replace(/(ימ|ות)$/, 'ה')]) if (f.length > 1 && !list.includes(f)) list.push(f);
    }
  }
  return list;
}

/** A word index: normalized word or phrase -> entry, per language. Throws on a word listed twice. */
export function indexLexicon(lexicon) {
  const index = { en: new Map(), he: new Map() }, phraseLength = { en: 1, he: 1 };
  for (const entry of lexicon.entries) {
    for (const [lang, words] of Object.entries(entry.words)) {
      for (const word of words) {
        const key = tokenize(word).map(t => t.norm).join(' ');
        if (index[lang].has(key)) throw Error(`Vision lexicon lists "${word}" twice (${index[lang].get(key).id}, ${entry.id})`);
        index[lang].set(key, entry);
        phraseLength[lang] = Math.max(phraseLength[lang], key.split(' ').length);
      }
    }
  }
  const stop = { en: new Set((lexicon.stopwords?.en ?? []).map(normalizeWord)), he: new Set((lexicon.stopwords?.he ?? []).map(normalizeWord)) };
  const numbers = { en: new Map(), he: new Map() };
  for (const lang of ['en', 'he']) for (const [w, n] of Object.entries(lexicon.numbers?.[lang] ?? {})) numbers[lang].set(normalizeWord(w), n);
  return { index, phraseLength, stop, numbers, prefixes: (lexicon.prefixes?.he ?? []).map(normalizeWord) };
}

/** A stable seed from the words: FNV-1a over the normalized sentence, spelled in the seed alphabet. */
export function visionSeed(text) {
  const words = tokenize(text).map(t => t.norm).join(' ');
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (const ch of words) { const c = ch.codePointAt(0); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ (c + 97), 2246822519) >>> 0; }
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '', a = h1, b = h2;
  for (let i = 0; i < 12; i++) { const v = i < 6 ? a : b; out += alphabet[(v >>> ((i % 6) * 5)) & 31]; }
  return normalizeSeed(out);
}
/** The project's name: the sentence itself, cut at a word boundary to the 64 characters a name holds. */
export function visionName(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= 64) return clean || 'My vision';
  const cut = clean.slice(0, 63).replace(/\s+\S*$/, '');
  return (cut || clean.slice(0, 63)) + '…';
}

/**
 * Read a sentence. Phrases are matched before single words, longest first; each token is used
 * once. A number word or digit right before a step ("three shrines") sets that step's count.
 */
export function readVision(text, lexicon) {
  const clean = String(text ?? '').slice(0, VISION_MAX_CHARS);
  const lx = indexLexicon(lexicon), tokens = tokenize(clean), used = new Array(tokens.length).fill(false);
  const hits = [];
  for (let i = 0; i < tokens.length; i++) {
    if (used[i]) continue;
    const lang = tokens[i].lang;
    let hit = null;
    for (let n = Math.min(lx.phraseLength[lang], tokens.length - i); n >= 1 && !hit; n--) {
      const span = tokens.slice(i, i + n);
      if (span.some((t, k) => used[i + k] || t.lang !== lang)) continue;
      if (n === 1) {
        for (const f of forms(span[0], lx.prefixes)) { const e = lx.index[lang].get(f); if (e) { hit = { entry: e, n: 1 }; break; } }
      } else {
        const heads = forms(span[0], lx.prefixes);
        for (const h of heads) { const e = lx.index[lang].get([h, ...span.slice(1).map(t => t.norm)].join(' ')); if (e) { hit = { entry: e, n }; break; } }
      }
    }
    if (!hit) continue;
    for (let k = 0; k < hit.n; k++) used[i + k] = true;
    const first = tokens[i], last = tokens[i + hit.n - 1];
    const before = tokens[i - 1], count = before && !used[i - 1] ? (lx.numbers[before.lang].get(before.norm) ?? (/^\d{1,2}$/.test(before.norm) ? Number(before.norm) : null)) : null;
    if (count != null && hit.entry.add?.objectives) used[i - 1] = true;
    hits.push({ entry: hit.entry, word: clean.slice(first.start, last.end), start: first.start, end: last.end, lang, count: hit.entry.add?.objectives ? count : null });
  }
  const unmatched = tokens.filter((t, i) => !used[i] && !lx.stop[t.lang].has(t.norm) && !lx.numbers[t.lang].has(t.norm)).map(t => t.raw);
  return { text: clean, ...assemble(clean, hits), unmatched };
}

/** Turn the matched entries into a project and a blueprint the compiler accepts. */
function assemble(text, hits) {
  const catalog = CATALOG[THEME];
  const set = {}, pools = { world: [], weapons: [], enemies: [] }, steps = [];
  for (const h of hits) {
    for (const [key, value] of Object.entries(h.entry.set ?? {})) {
      // The first word that sets a choice wins, except that a world adds to the pool (the seed picks one per level).
      if (key === 'world') { if (!pools.world.includes(value)) pools.world.push(value); }
      else if (!(key in set)) set[key] = value;
    }
    for (const [key, values] of Object.entries(h.entry.add ?? {})) {
      if (key === 'objectives') {
        for (const objective of values) {
          const existing = steps.find(s => s.objective === objective);
          if (existing) { if (h.count) existing.count = h.count; }
          else steps.push({ objective, count: h.count ?? DEFAULT_COUNT[objective] });
        }
      } else for (const id of values) if (!pools[key].includes(id)) pools[key].push(id);
    }
  }
  // Words that name weapons or a fight make a shooter even if a calm word came first.
  if (set.genre === 'exploration' && (pools.weapons.length || steps.some(s => ['waves', 'eliminate', 'boss', 'barricade'].includes(s.objective)))) {
    const wantsCombat = hits.some(h => h.entry.id === 'genre.shooter' || h.entry.add?.weapons);
    if (wantsCombat) set.genre = 'shooter';
  }
  const genreId = set.genre ?? DEFAULT_GENRE, genre = GENRES[genreId];
  if (!pools.world.length) pools.world.push(catalog.world[0].id);
  if (!pools.weapons.length) pools.weapons.push('assault');
  const hostile = catalog.enemies.filter(e => !e.boss).map(e => e.id);
  let mission = steps.filter(s => genre.objectives.includes(s.objective));
  if (mission.some(s => ['waves', 'eliminate', 'boss'].includes(s.objective)) || genreId === 'shooter') {
    if (!pools.enemies.some(id => hostile.includes(id))) pools.enemies.unshift(...hostile.slice(0, 3).filter(id => !pools.enemies.includes(id)));
  }
  if (mission.some(s => s.objective === 'boss') && !pools.enemies.includes('king')) pools.enemies.push('king');
  // Extraction ends every mission; with nothing else asked for, the village's shrines come first.
  const body = mission.filter(s => s.objective !== 'extract').slice(0, MAX_STEPS - 1);
  if (!body.length) body.push({ objective: 'activate', count: DEFAULT_COUNT.activate });
  mission = [...body, { objective: 'extract', count: 1 }].map(s => ({ ...s, count: Math.max(1, Math.min(MAX_COUNT[s.objective], s.count)) }));
  // Keep inside the compiler's interaction budget (activate/override/barricade count up to 4, reach 1).
  let budget = 12;
  for (const s of mission) if (['activate', 'override', 'barricade', 'reach'].includes(s.objective)) { s.count = Math.min(s.count, Math.max(1, budget)); budget -= s.objective === 'reach' ? 1 : Math.min(s.count, 4); }

  const props = catalog.props.filter(a => ['cover', 'barricade', 'objective', 'dressing'].includes(a.role) || a.pickup).map(a => a.id);
  const doors = [catalog.doors.find(d => d.opensTo)?.id ?? catalog.doors[0].id];
  const blueprint = visionBlueprint({ world: pools.world, weapons: pools.weapons, enemies: pools.enemies, doors, props }, mission);

  const reading = hits.map(h => {
    const keys = [...Object.keys(h.entry.set ?? {}), ...Object.keys(h.entry.add ?? {})];
    let node = null;
    if (h.entry.add?.objectives) node = blueprint.nodes.find(n => n.kind === 'objective' && n.objective === h.entry.add.objectives[0])?.id ?? null;
    else for (const k of keys) if (NODE_OF[k]) { node = NODE_OF[k]; break; }
    return { word: h.word, start: h.start, end: h.end, lang: h.lang, entry: h.entry.id, label: h.entry.label, node };
  });
  const project = {
    name: visionName(text), theme: THEME, genre: genreId, seed: visionSeed(text),
    weapon: pools.weapons[0], ...Object.fromEntries(Object.entries(set).filter(([k]) => k !== 'genre')),
    objectives: mission.find(s => s.objective === 'activate')?.count ?? 3,
    blueprint,
  };
  if (genreId === 'exploration' && project.enemyCount > 4) project.enemyCount = 4;
  return { project, reading, mission };
}

/** The canvas the studio shows: pools on the left, the generator, the mission steps in order, the output. */
export function visionBlueprint(pools, mission) {
  const kinds = ['world', 'weapons', 'enemies', 'doors', 'props'];
  const nodes = kinds.map((kind, i) => ({ id: kind, kind, x: 25, y: 25 + i * 133, items: [...(pools[kind] ?? [])] }));
  nodes.push({ id: 'generator', kind: 'generator', x: 290, y: 250 });
  const edges = kinds.map(kind => ({ from: kind, out: kind, to: 'generator', input: kind }));
  let prev = { id: 'generator', out: 'start' };
  mission.forEach((step, i) => {
    const id = `${step.objective}-${i + 1}`;
    nodes.push({ id, kind: 'objective', objective: step.objective, count: step.count, duration: STEP_DURATION[step.objective] ?? 3, x: 560 + (i % 2) * 70, y: 40 + i * 118 });
    edges.push({ from: prev.id, out: prev.out, to: id, input: 'start' });
    prev = { id, out: 'complete' };
  });
  nodes.push({ id: 'output', kind: 'output', x: 900, y: 250 });
  edges.push({ from: 'generator', out: 'game', to: 'output', input: 'game' }, { from: prev.id, out: prev.out, to: 'output', input: 'mission' });
  return { version: 1, nodes, edges };
}
