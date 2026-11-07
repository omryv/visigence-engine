/**
 * THE PROGRESSION SEAM — your game supplies this.
 *
 * `core/Economy.js` turns saved progression into effective numbers: what a purchased tier
 * does to a weapon, what the player's maximum health is. WHERE that save data lives is the
 * game's business — localStorage, a file, a server — so the engine never imports a store.
 * It reads through these two providers instead, and the game installs its own at boot:
 *
 *     setProgressionSource({ ownedWeapons: () => [...], upgradeTiers: () => ({ ... }) });
 *
 * The defaults describe a fresh player who owns the starting weapon and has bought nothing,
 * so the engine is playable before any save system exists.
 */
let source = {
  ownedWeapons: () => [],
  upgradeTiers: () => ({ weapons: {} }),
};

export const ownedWeapons = () => source.ownedWeapons();
export const upgradeTiers = () => source.upgradeTiers();
