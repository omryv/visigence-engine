/**
 * CREATURE GRAMMAR: a seeded, hierarchical stochastic grammar that turns a key into a creature
 * blueprint. No AI, no network, nothing but the rules in the pack (`packs/<theme>/pack.json`,
 * `creatures`) and one PRNG stream.
 *
 * A creature starts from its family's archetype and a STYLE DNA drawn from the seed: size,
 * roundness, ornament and tone. Every later choice reads that DNA, so proportions, parts,
 * colours and expression stay correlated and the result reads as designed rather than
 * randomly assembled:
 *
 *   - each plan step fills one slot with a weighted choice whose weights are conditioned on
 *     the DNA (`favor`: a rounder creature prefers the round body);
 *   - compatibility tags gate options (`needs` / `clash`: no ring of spots on a cone cap);
 *   - optional steps fire with a chance scaled by the ornament gene;
 *   - rank and role pick palette overrides, required parts (the boss's crown) and the mood the
 *     expression is drawn from.
 *
 * The output is plain data - which part goes on which socket of which parent, colours, face
 * and surface patterns - that render/CreatureAssembler.js turns into geometry. The Blender
 * preview (tools/blender/v2/arcade/creature_grammar.py) is a line-for-line port of this file
 * with the same PRNG, and tools/test/test-creature-grammar.mjs holds them to identical output,
 * so what the art pipeline reviews is exactly what the game spawns.
 *
 * PARITY RULES: every step draws the same four numbers whatever branch it takes; weights are
 * summed in rule order; colours round with floor(x + 0.5). Keep all three when editing.
 */
import { mulberry32 } from '../utils/math.js';
import { hashSeed } from '../kernel/seed.js';
import { clamp01, choose, weightOf, toned } from './grammarCore.js';

export const GRAMMAR_VERSION = 1;
export const CREATURE_ROLES = ['hostile', 'friendly'];
export const CREATURE_RANKS = ['minion', 'boss'];

/** The PRNG stream for one creature key. */
export function creatureRng(key) { return mulberry32(hashSeed(String(key))); }

/**
 * @param {object} rules  the pack's `creatures` block
 * @param {{family: string, key: string|number, role?: 'hostile'|'friendly', rank?: 'minion'|'boss'}} request
 * @returns {object} blueprint: {family, rank, role, key, dna, palette, colors, face, parts, patterns, hover}
 */
export function generateCreature(rules, { family, key, role = 'hostile', rank = 'minion' }) {
  const F = rules?.families?.[family];
  if (!F) throw new Error(`Unknown creature family: ${family}`);
  const rng = creatureRng(`${family}|${rank}|${role}|${key}`);
  // Style DNA. Small creatures lean round (a baby-schema bias), so size and roundness are correlated.
  const size = rng();
  const round = clamp01(0.7 * rng() + 0.3 * (1 - size));
  const ornament = rng();
  const tone = rng() * 2 - 1;
  const paletteRoll = rng(), moodRoll = rng();
  const dna = { size, round, ornament, tone };
  const boss = rank === 'boss' ? (F.boss ?? {}) : null;
  const base = boss?.palette ?? F.palettes[Math.floor(paletteRoll * F.palettes.length)];
  const palette = {};
  for (const [slot, hex] of Object.entries(base)) palette[slot] = toned(hex, tone);
  const moods = F.moods?.[role] ?? rules.moods[role];
  const expression = boss?.expression ?? choose(moodRoll, Object.keys(moods), k => moods[k]);
  const parts = [], patterns = [], tags = new Set();
  for (const step of F.plan) {
    const chanceRoll = rng(), pickRoll = rng(), extraA = rng(), extraB = rng();
    if (step.rank && !step.rank.includes(rank)) continue;
    const forced = boss?.require ? step.options.find(o => boss.require.includes(o.part)) : undefined;
    const chance = step.chance === undefined ? 1 : clamp01(step.chance * (0.6 + 0.8 * ornament));
    if (!forced && chanceRoll >= chance) continue;
    const allowed = o => (!o.rank || o.rank.includes(rank))
      && (o.needs ?? []).every(t => tags.has(t)) && !(o.clash ?? []).some(t => tags.has(t));
    const option = forced ?? choose(pickRoll, step.options.filter(allowed), o => weightOf(o, dna));
    if (!option) {
      if (step.chance === undefined) throw new Error(`Creature ${family}: no allowed option for required slot "${step.slot}"`);
      continue;
    }
    for (const t of option.tags ?? []) tags.add(t);
    if (step.kind === 'pattern') {
      if (option.pattern === 'none') continue;
      const [c0, c1] = option.count, [s0, s1] = option.size;
      patterns.push({ slot: step.slot, on: step.on ?? 'body', pattern: option.pattern, color: option.color ?? 'trim',
        count: c0 + Math.floor(extraA * (c1 - c0 + 1)), size: s0 + (s1 - s0) * extraB, seed: Math.floor(pickRoll * 4294967296) });
      continue;
    }
    parts.push({ slot: step.slot, part: option.part, on: step.slot === 'body' ? null : (step.on ?? 'body'),
      socket: step.socket ?? null, pair: !!step.pair });
  }
  const face = { expression, ...rules.expressions[expression], eye: (F.face?.eye ?? 1) * (1 + 0.35 * (1 - size)) };
  return { version: GRAMMAR_VERSION, family, rank, role, key: String(key), dna, palette, colors: rules.colors, face, parts, patterns, hover: F.hover ?? 0 };
}

/**
 * Structural checks on a pack's creature rules, with messages that name the broken rule. When
 * `parts` (the library index: id -> {sockets}) is given, every part and socket must exist too.
 */
export function validateCreatureRules(rules, parts = null) {
  const errors = [];
  if (!rules || typeof rules !== 'object') return ['creatures: missing'];
  for (const role of CREATURE_ROLES) if (!rules.moods?.[role]) errors.push(`creatures.moods.${role}: missing`);
  for (const [role, moods] of Object.entries(rules.moods ?? {})) for (const name of Object.keys(moods)) if (!rules.expressions?.[name]) errors.push(`creatures.moods.${role}: unknown expression "${name}"`);
  for (const [id, F] of Object.entries(rules.families ?? {})) {
    const where = `creatures.families.${id}`;
    if (!F.palettes?.length) errors.push(`${where}: needs at least one palette`);
    if (F.plan?.[0]?.slot !== 'body') { errors.push(`${where}: the plan must start with the body slot`); continue; }
    const slots = new Map();
    for (const step of F.plan) {
      const at = `${where}.${step.slot}`;
      if (!step.options?.length) errors.push(`${at}: no options`);
      if (step.slot !== 'body' && step.kind !== 'pattern' && !step.socket) errors.push(`${at}: needs a socket`);
      if (step.on && !slots.has(step.on)) errors.push(`${at}: "on" names slot "${step.on}", which is not filled earlier`);
      for (const o of step.options ?? []) {
        if (!((o.w ?? 1) >= 0)) errors.push(`${at}: negative weight`);
        if (step.kind === 'pattern') { if (o.pattern !== 'none' && !(o.count?.length === 2 && o.size?.length === 2)) errors.push(`${at}.${o.pattern}: needs count and size ranges`); continue; }
        if (!o.part) { errors.push(`${at}: an option has no part`); continue; }
        if (parts && !parts[o.part]) errors.push(`${at}: part "${o.part}" is not in the library`);
        const parent = step.slot === 'body' ? null : slots.get(step.on ?? 'body');
        if (parts && parent && step.socket) for (const p of parent) if (parts[p] && !parts[p].sockets.includes(step.socket)) errors.push(`${at}: "${p}" has no "${step.socket}" socket for "${o.part}"`);
      }
      if (step.kind !== 'pattern') slots.set(step.slot, (step.options ?? []).map(o => o.part).filter(Boolean));
      if (step.slot === 'body' && step.chance !== undefined) errors.push(`${at}: the body cannot be optional`);
    }
    for (const req of F.boss?.require ?? []) if (!F.plan.some(s => s.options?.some(o => o.part === req))) errors.push(`${where}.boss: required part "${req}" is not an option in the plan`);
    if (F.boss?.expression && !rules.expressions?.[F.boss.expression]) errors.push(`${where}.boss: unknown expression "${F.boss.expression}"`);
  }
  for (const r of rules.roster ?? []) {
    if (!rules.families?.[r.family]) errors.push(`creatures.roster.${r.id}: unknown family "${r.family}"`);
    if (r.rank && !CREATURE_RANKS.includes(r.rank)) errors.push(`creatures.roster.${r.id}: unknown rank "${r.rank}"`);
  }
  for (const f of rules.wildlife?.families ?? []) if (!rules.families?.[f]) errors.push(`creatures.wildlife: unknown family "${f}"`);
  return errors;
}
