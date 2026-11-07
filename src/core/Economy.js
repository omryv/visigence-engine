/**
 * SALVAGE ECONOMY DERIVATIONS.
 *
 * The catalog lives in config/gameplay.js (ECONOMY - prices, tracks, challenge terms) and
 * the state lives in core/Progress.js (what is owned, what tier is bought). This module is
 * the arithmetic between them: what a run pays, what a tier does to a weapon, what the next
 * goal is. The pure functions take explicit inputs so tests/test_progression.mjs can pin
 * them without a DOM or storage; the state-bound helpers at the bottom read Progress.
 */

import { WEAPONS, PLAYER, GRENADE, ECONOMY } from '../config/gameplay.js';
import { upgradeTiers } from './progression.js';

// ---------------------------------------------------------------------------
// Pure derivations
// ---------------------------------------------------------------------------

/**
 * What purchased tiers do to one weapon's definition: the four scaled stats, rounded,
 * never below one round in the magazine (the RPG's single-rocket magazine stays one).
 */
export function weaponStatOverrides(id, tiers = {}) {
  const d = WEAPONS[id];
  const w = ECONOMY.upgrades.weapons;
  const scale = (value, perTier, tier) => Math.round(value * (1 + perTier * (tier ?? 0)));
  return {
    damage: scale(d.damage, w.damage.perTier, tiers.damage),
    magazine: Math.max(1, scale(d.magazine, w.magazine.perTier, tiers.magazine)),
    reserve: scale(d.reserve, w.reserve.perTier, tiers.reserve),
    reserveMax: scale(d.reserveMax, w.reserve.perTier, tiers.reserve),
  };
}

/**
 * The extraction bonus: deeper sectors pay a larger base, flown faster and straighter it
 * pays more, and both factors are bounded so no run pays nothing and no run breaks the pace.
 * @param {number} order     the sector's campaign position (1-based)
 * @param {number} accuracy  shots hit / shots fired, 0..1 (0 when nothing was fired)
 * @param {number} time      mission time in seconds
 */
export function clearBonus(order, accuracy, time) {
  const c = ECONOMY.clearBonus;
  const base = c.base + c.perOrder * order;
  const timeFactor = Math.min(c.timeCeiling,
    Math.max(c.timeFloor, c.timeCeiling - (time / c.parTime) * (c.timeCeiling - c.timeFloor)));
  const accuracyFactor = c.accuracyFloor + c.accuracySpan * Math.min(1, Math.max(0, accuracy));
  return Math.round(base * timeFactor * accuracyFactor);
}


// ---------------------------------------------------------------------------
// State-bound helpers (read core/Progress.js)
// ---------------------------------------------------------------------------

/** The four upgrade-scaled stats for one weapon at its purchased tiers. */
export function effectiveWeaponStats(id) {
  return weaponStatOverrides(id, upgradeTiers().weapons[id]);
}

/** How many grenades a run starts with, never past the carry cap. */
export function grenadeStartCount() {
  return Math.min(GRENADE.maxCount,
    GRENADE.initialCount + (upgradeTiers().grenades ?? 0) * ECONOMY.upgrades.grenades.perTier);
}

/** The player's upgraded health ceiling. */
export function playerMaxHealth() {
  return PLAYER.maxHealth + (upgradeTiers().health ?? 0) * ECONOMY.upgrades.health.perTier;
}

