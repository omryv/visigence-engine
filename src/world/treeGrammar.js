/**
 * TREE GRAMMAR: a seeded, constrained L-system that turns a key into an Arcade tree. No AI, no network: the
 * rules in the pack (`packs/<theme>/pack.json`, `trees`) and a few PRNG streams.
 *
 * It runs in three stages, every one reading the STYLE DNA (size, age, bushy, gnarl, tone) drawn first, so
 * the trunk, the branching and the crown stay correlated:
 *
 *   1. style      a palette, then weighted, tagged choices (grammarCore) per species `plan` slot. An option's
 *                 `set` overrides species numbers (a leaning oak raises its lean limit), its `tags` gate the
 *                 productions below (`needs` / `clash`).
 *   2. rewrite    the species' axiom is rewritten `depth` times (bent by the age gene). Every non-terminal
 *                 draws one roll and takes a weighted successor (`favor` bends the weights by a gene). What is
 *                 left after the last pass becomes the species' `tip` (a leaf socket), so every branch ends
 *                 in foliage.
 *   3. interpret  a turtle walks the string. F grows a tapered segment, [ ] push and pop a branch (one order
 *                 deeper, thinner), + - pitch, / \ roll, L and P place canopy sockets. The CONSTRAINTS are
 *                 enforced here: a segment cap, a lean cone for the trunk and a spread cone for branches (a
 *                 pitch that would leave the cone is refused), a crown radius cap (a segment that would leave
 *                 it stops at it), a floor no segment or clump may dip under, and a socket cap met by taking
 *                 every k-th tip so the clumps stay spread over the crown, not bunched on the first branch.
 *
 * Turns are multiples of 1/64 turn from DIRS64 (no trigonometry), so the Python port
 * (tools/blender/v2/arcade/tree_grammar.py) is a line-for-line twin and tools/test/test-tree-grammar.mjs holds
 * both to identical plans through fixtures. `generateTree` returns plain data: segments (a, b, r0, r1, depth,
 * parent), canopy sockets (part, position, spin, scale) and the numbers the village layout needs back: the
 * trunk radius (its collider), the trunk's clear height, the crown radius and the top. render/TreeAssembler.js
 * and tree_preview.py mesh that plan the same way.
 *
 * PARITY RULES: no trigonometry; numbers leave through r4 (floor(x + 0.5)); every symbol draws its rolls
 * before deciding anything, whatever branch is taken; integer loop counters; powers by repeated multiplication.
 * Coordinates are Blender's: metres, Z up, the tree standing on the origin.
 */
import { mulberry32 } from '../utils/math.js';
import { hashSeed } from '../kernel/seed.js';
import { clamp01, choose, weightOf, allows, toned } from './grammarCore.js';
import { DIRS64 } from './grammarCore.js';

export const TREE_GRAMMAR_VERSION = 1;
/** The turtle's terminal alphabet; any other character is a non-terminal the productions must rewrite. */
export const TREE_SYMBOLS = 'F[]+-/\\LP';
const MIN_SEGMENT = 0.15, MIN_SOCKET = 0.45, TRUNK_WALL = 1.15;

const r4 = v => Math.floor(v * 10000 + 0.5) / 10000;
const r4v = a => [r4(a[0]), r4(a[1]), r4(a[2])];
const mix = (range, t) => range[0] + (range[1] - range[0]) * t;
const mad = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
const mod64 = k => ((k % 64) + 64) % 64;

/** One PRNG stream per stage, so changing the canopy rules never reshuffles the trunks. */
export function treeRng(species, key, stage) { return mulberry32(hashSeed(`tree|${species}|${key}|${stage}`)); }

/** Rotate the heading toward (sign +1) or away from (sign -1) the frame's up vector by k/64 turn. */
function pitch(st, k, sign) {
  const [c, s] = DIRS64[mod64(k)], H = st.H, U = st.U;
  return { H: [H[0] * c + U[0] * s * sign, H[1] * c + U[1] * s * sign, H[2] * c + U[2] * s * sign], U: [U[0] * c - H[0] * s * sign, U[1] * c - H[1] * s * sign, U[2] * c - H[2] * s * sign] };
}
/** Roll the frame about the heading by k/64 turn (sign -1 rolls the other way). */
function roll(st, k, sign) {
  const [c, s] = DIRS64[mod64(k)], L = st.L, U = st.U;
  st.L = [L[0] * c + U[0] * s * sign, L[1] * c + U[1] * s * sign, L[2] * c + U[2] * s * sign];
  st.U = [U[0] * c - L[0] * s * sign, U[1] * c - L[1] * s * sign, U[2] * c - L[2] * s * sign];
}

/**
 * @param {object} rules  the pack's `trees` block
 * @param {{species: string, key: string|number}} req
 */
export function generateTree(rules, { species, key }) {
  const S = rules?.species?.[species];
  if (!S) throw new Error(`Unknown tree species: ${species}`);
  const k = String(key), lim = rules.limits;
  // 1. style DNA and palette.
  const d = treeRng(species, k, 'dna');
  const size = d(), age = d(), bushy = d(), gnarl = d(), tone = d() * 2 - 1, paletteRoll = d();
  const dna = { size, age, bushy, gnarl, tone };
  const base = S.palettes[Math.floor(paletteRoll * S.palettes.length)], palette = {};
  for (const [slot, hex] of Object.entries(base)) palette[slot] = toned(hex, tone);
  // Weighted, tagged style choices; an option's `set` overrides the species' numbers for this tree.
  const c = treeRng(species, k, 'style'), tags = new Set(), style = {}, P = { ...S };
  for (const step of S.plan ?? []) {
    const chanceRoll = c(), pickRoll = c();
    const chance = step.chance === undefined ? 1 : clamp01(step.chance * (0.6 + 0.8 * dna[step.gene ?? 'bushy']));
    if (chanceRoll >= chance) continue;
    const option = choose(pickRoll, step.options.filter(o => allows(o, tags)), o => weightOf(o, dna));
    if (!option) {
      if (step.chance === undefined) throw new Error(`Tree ${species}: no allowed option for required slot "${step.slot}"`);
      continue;
    }
    for (const t of option.tags ?? []) tags.add(t);
    style[step.slot] = option.id;
    Object.assign(P, option.set ?? {});
  }
  // 2. rewrite the axiom; every non-terminal draws one roll whether or not a successor is allowed.
  const w = treeRng(species, k, 'grow');
  const iterations = Math.min(P.depth[1], P.depth[0] + Math.floor(age * (P.depth[1] - P.depth[0] + 1)));
  let s = P.axiom;
  const choices = [];
  for (let it = 0; it < iterations; it++) {
    let out = '';
    for (const ch of s) {
      const R = P.rules[ch];
      if (!R) { out += ch; continue; }
      const roll_ = w(), opt = choose(roll_, R.filter(o => allows(o, tags)), o => weightOf(o, dna));
      if (opt) { out += opt.to; choices.push(`${ch}${R.indexOf(opt)}`); }
    }
    s = out;
  }
  let str = '';
  for (const ch of s) str += TREE_SYMBOLS.includes(ch) ? ch : P.tip;
  // 3. interpret.
  const j = treeRng(species, k, 'shape');
  const hs = mix(P.scale, size), cap = mix(P.crown, size), segCap = Math.min(P.segments, lim.segments);
  const segments = [], candidates = [], stack = [];
  let st = { p: [0, 0, 0], H: [0, 0, 1], L: [0, 1, 0], U: [-1, 0, 0], r: P.trunk * hs, d: 0, last: -1, dead: false };
  let pruned = 0, leaves = 0;
  for (const ch of str) {
    if (ch === 'F') {
      const jr = j();
      if (st.dead) continue;
      if (segments.length >= segCap) { pruned++; continue; }
      let len = P.length[Math.min(st.d, P.length.length - 1)] * hs * (1 - P.jitter * 0.5 + P.jitter * jr);
      // The crown cap: a segment that would leave the cylinder stops at it (the root of |p_h + t H_h| = cap).
      const a = st.H[0] * st.H[0] + st.H[1] * st.H[1], b = 2 * (st.p[0] * st.H[0] + st.p[1] * st.H[1]), cc = st.p[0] * st.p[0] + st.p[1] * st.p[1] - cap * cap;
      if (a > 1e-9) { const disc = b * b - 4 * a * cc; if (disc >= 0) { const t = (-b + Math.sqrt(disc)) / (2 * a); if (t < len) len = t; } }
      const end = mad(st.p, st.H, len);
      if (len < MIN_SEGMENT || (st.d > 0 && end[2] < lim.floor)) { st.dead = true; continue; }
      const r1 = Math.max(P.twig, st.r * P.taper);
      segments.push({ a: r4v(st.p), b: r4v(end), r0: r4(st.r), r1: r4(r1), d: st.d, i: st.last });
      st.p = end; st.r = r1; st.last = segments.length - 1;
      // Tropism: the heading bends toward (or away from) the sky, then the frame is squared up again.
      st.H = unit([st.H[0], st.H[1], st.H[2] + P.tropism]);
      st.L = unit(cross(st.U, st.H)); st.U = cross(st.H, st.L);
    } else if (ch === '[') {
      stack.push(st);
      st = { ...st, d: st.d + 1, r: Math.max(P.twig, st.r * P.branch) };
    } else if (ch === ']') {
      if (stack.length) st = stack.pop();
    } else if (ch === '+' || ch === '-') {
      const jr = j();
      if (st.dead) continue;
      const k_ = st.d === 0 ? P.leanStep : P.pitch[0] + Math.floor(jr * (P.pitch[1] - P.pitch[0] + 1)) + Math.floor(gnarl * P.gnarl);
      const next = pitch(st, k_, ch === '+' ? 1 : -1);
      // The cone: the trunk may lean `lean`/64 turn from vertical, a branch may open `spread`/64.
      if (next.H[2] < DIRS64[st.d === 0 ? P.lean : P.spread][0]) continue;
      st.H = next.H; st.U = next.U;
    } else if (ch === '/' || ch === '\\') {
      const jr = j();
      if (st.dead) continue;
      roll(st, P.roll + Math.floor(jr * (2 * P.rollJitter + 1)) - P.rollJitter, ch === '/' ? 1 : -1);
    } else if (ch === 'L' || ch === 'P') {
      const pr = j(), sr = j(), sc = j();
      if (st.dead) continue;
      const tip = ch === 'P', list = tip ? (P.leaf.tips ?? P.leaf.parts) : P.leaf.parts, range = tip ? (P.leaf.tipScale ?? P.leaf.scale) : P.leaf.scale;
      const part = list[Math.floor(pr * list.length)], ext = rules.parts[part];
      let scale = mix(range, sc) * hs;
      for (let q = 0; q < st.d; q++) scale *= P.leaf.byDepth;
      if (!tip) { scale *= 1 - P.leaf.shrink * leaves; leaves++; }
      // Nothing hangs under the floor: a clump that would is shrunk to fit, or dropped when it cannot.
      if (ext.bot < 0 && st.p[2] + ext.bot * scale < lim.floor) scale = (st.p[2] - lim.floor) / -ext.bot;
      if (scale < MIN_SOCKET) continue;
      candidates.push({ part, p: r4v(st.p), k: Math.floor(sr * 64) % 64, s: r4(scale), d: st.d, tip });
    }
  }
  // The socket cap, met by stride so the kept clumps stay spread over the crown; tips always stay.
  const socketCap = Math.min(P.sockets, lim.sockets), leafList = candidates.filter(q => !q.tip);
  const stride = leafList.length > socketCap ? Math.floor((leafList.length + socketCap - 1) / socketCap) : 1;
  const keep = new Set();
  for (let q = 0; q < leafList.length; q++) if (q % stride === 0) keep.add(leafList[q]);
  const sockets = candidates.filter(q => q.tip || keep.has(q)).map(({ tip, ...q }) => q);
  // What the layout needs back.
  const trunk = r4((segments.length ? segments[0].r0 : P.trunk * hs) * TRUNK_WALL);
  let clear = 0, crown = trunk * 2, top = 0;
  for (const g of segments) {
    if (g.d === 0 && g.b[2] > clear) clear = g.b[2];
    if (g.b[2] > top) top = g.b[2];
    const reach = Math.sqrt(g.b[0] * g.b[0] + g.b[1] * g.b[1]) + g.r1;
    if (reach > crown) crown = reach;
  }
  for (const q of sockets) {
    const ext = rules.parts[q.part], reach = Math.sqrt(q.p[0] * q.p[0] + q.p[1] * q.p[1]) + ext.r * q.s, high = q.p[2] + ext.top * q.s;
    if (reach > crown) crown = reach;
    if (high > top) top = high;
  }
  const plan = { version: TREE_GRAMMAR_VERSION, species, key: k, dna, palette, colors: rules.colors, style, scale: r4(hs), iterations, choices, string: str,
    segments, sockets, pruned, trunk, clear: r4(clear), crown: r4(crown), top: r4(top), outline: P.outline };
  // A species' trunk style for the mesher: 'rings' (a palm's frond scars) or 'ribs' (a cactus); absent for bark.
  if (P.bark) plan.bark = P.bark;
  return plan;
}

/** The colour a slot takes in this plan: the palette first, then the shared colours. */
export function treeSlotColor(plan, slot) {
  const key = slot.charAt(0).toLowerCase() + slot.slice(1);
  return plan.palette[key] ?? plan.colors[key] ?? plan.palette.leaf;
}

/** A compact, order-preserving digest of a plan's geometry: what the Python port must reproduce. */
export function treeDigest(plan) {
  const num = v => String(Math.floor(v * 10000 + 0.5));
  const rows = plan.segments.map(g => [...g.a, ...g.b, g.r0, g.r1, g.d, g.i].map(num).join(','));
  for (const q of plan.sockets) rows.push([q.part, ...q.p.map(num), q.k, num(q.s), q.d].join(','));
  return { segments: plan.segments.length, sockets: plan.sockets.length, trunk: plan.trunk, clear: plan.clear, crown: plan.crown, top: plan.top, hash: hashSeed(rows.join('\n')) };
}

/**
 * Structural checks on a pack's tree rules, with messages that name the broken rule. When `parts` (the library
 * index: id -> {r, top, bot, tris}) is given, every canopy part the rules name must exist there too.
 */
export function validateTreeRules(rules, parts = null) {
  const errors = [];
  if (!rules || typeof rules !== 'object') return ['trees: missing'];
  for (const k of ['segments', 'sockets', 'floor', 'clear']) if (typeof rules.limits?.[k] !== 'number') errors.push(`trees.limits.${k}: missing`);
  const known = id => !!rules.parts?.[id] && (!parts || !!parts[id]);
  for (const [id, ext] of Object.entries(rules.parts ?? {})) {
    if (!(ext.r > 0 && typeof ext.top === 'number' && typeof ext.bot === 'number')) errors.push(`trees.parts.${id}: needs r, top and bot`);
    if (parts && !parts[id]) errors.push(`trees.parts.${id}: not in the library`);
  }
  for (const [id, S] of Object.entries(rules.species ?? {})) {
    const where = `trees.species.${id}`;
    if (!S.palettes?.length) errors.push(`${where}: needs at least one palette`);
    for (const k of ['depth', 'scale', 'pitch', 'crown']) if (!(S[k]?.length === 2)) errors.push(`${where}.${k}: needs [min, max]`);
    for (const k of ['trunk', 'taper', 'branch', 'twig', 'jitter', 'gnarl', 'roll', 'rollJitter', 'lean', 'leanStep', 'spread', 'tropism', 'segments', 'sockets', 'outline']) if (typeof S[k] !== 'number') errors.push(`${where}.${k}: missing`);
    if (!(S.length?.length >= 1)) errors.push(`${where}.length: needs one length per depth`);
    if (typeof S.axiom !== 'string' || !S.axiom.length) errors.push(`${where}.axiom: missing`);
    if (typeof S.tip !== 'string' || !TREE_SYMBOLS.includes(S.tip)) errors.push(`${where}.tip: must be a terminal`);
    const symbols = new Set([...TREE_SYMBOLS, ...Object.keys(S.rules ?? {})]);
    for (const ch of S.axiom ?? '') if (!symbols.has(ch)) errors.push(`${where}.axiom: "${ch}" has no production`);
    for (const [ch, R] of Object.entries(S.rules ?? {})) {
      if (!R.length) errors.push(`${where}.rules.${ch}: no successors`);
      for (const o of R) {
        if (typeof o.to !== 'string') errors.push(`${where}.rules.${ch}: successor without "to"`);
        if (!((o.w ?? 1) >= 0)) errors.push(`${where}.rules.${ch}: negative weight`);
        let depth = 0;
        for (const c of o.to ?? '') { if (!symbols.has(c)) errors.push(`${where}.rules.${ch}: "${c}" has no production`); if (c === '[') depth++; if (c === ']') depth--; if (depth < 0) break; }
        if (depth !== 0) errors.push(`${where}.rules.${ch}: unbalanced brackets in "${o.to}"`);
      }
    }
    for (const step of S.plan ?? []) {
      if (!step.options?.length) errors.push(`${where}.${step.slot}: no options`);
      for (const o of step.options ?? []) if (!((o.w ?? 1) >= 0)) errors.push(`${where}.${step.slot}: negative weight`);
    }
    for (const list of [S.leaf?.parts, S.leaf?.tips]) for (const pid of list ?? []) if (!known(pid)) errors.push(`${where}.leaf: part "${pid}" is not in trees.parts and the library`);
    if (!(S.leaf?.parts?.length && S.leaf.scale?.length === 2 && typeof S.leaf.byDepth === 'number' && typeof S.leaf.shrink === 'number')) errors.push(`${where}.leaf: needs parts, scale, byDepth and shrink`);
    if (S.tip === 'P' && !S.leaf?.tips?.length) errors.push(`${where}: tip "P" needs leaf.tips`);
  }
  return errors;
}
