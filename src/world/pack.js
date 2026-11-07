/**
 * A PACK: what one word in the picker actually resolves to.
 *
 * The product's first click is a category — "arcade" — and everything downstream has
 * to come from somewhere deterministic. A pack is that somewhere: a manifest plus a
 * folder of art, resolved into the shapes the engine already reads. No model decides any
 * of it; the click selects a file.
 *
 *     click "arcade"   ->  packs/arcade/pack.json   ->  resolvePack()
 *                      ->  terrain recipe + weapons + characters + placeable props
 *
 * ---------------------------------------------------------------------------
 * WHY A MANIFEST IS NOT OPTIONAL: THE ART DOES NOT KNOW HOW BIG IT IS
 * ---------------------------------------------------------------------------
 * Every generated asset in this pack arrives UNIT-NORMALISED — its longest axis is
 * exactly 1.0 — which `tools/build/inspect-pack.mjs` measures and reports. A crate, a
 * door, a sniper rifle and a soldier are therefore all the same size, and nothing inside
 * the file distinguishes them. Scale is not a styling choice here, it is the difference
 * between a crate you can hide behind and a crate the size of a building.
 *
 * So `metres` is the one field every entry must carry: the length of the object's
 * LONGEST axis in the world. `scale = metres / longest`, and `longest` is measured from
 * the file rather than assumed, so a re-export at a different normalisation still lands
 * at the right size.
 *
 * ---------------------------------------------------------------------------
 * ROLE IS THE FIELD THAT MAKES A PROP GAMEPLAY
 * ---------------------------------------------------------------------------
 * A prop with no role is set dressing, and a level made of set dressing is a diorama.
 * The role is what the placer and the simulation read:
 *
 *   cover      blocks movement and sight. Placed in the open, where it creates the
 *              sightline breaks a firefight needs.
 *   barricade  blocks, and can be cleared. `BARRICADE` in config/gameplay.js.
 *   gate       blocks a route until opened. `DOOR` in config/gameplay.js.
 *   door       a pair: `opensTo` names the model it becomes.
 *   objective  the thing the mission is about. `OBJECTIVE` in config/gameplay.js.
 *   dressing   no collision. Honest about being decoration.
 *
 * `collision` says what shape `CollisionSystem` registers — `box`, `circle` or `none` —
 * because that class already takes exactly those two blocker kinds and nothing else has
 * to be invented to make a prop solid.
 */

import { validateCreatureRules } from './creatureGrammar.js';
import { validateHouseRules } from './houseGrammar.js';
import { validateWorldRules } from './worldGrammar.js';
import { validateTreeRules } from './treeGrammar.js';
import { NATURE_PARTS } from './natureParts.js';
import { TREE_PARTS } from './treeParts.js';
import { LANDMARK_PARTS } from './landmarkParts.js';
import { validateLandmarkRules } from './worldLandmarks.js';
import { DESERT_LIBRARY, DESERT_HOUSE_PARTS, DESERT_TREE_PARTS, DESERT_NATURE_PARTS, DESERT_LANDMARK_PARTS } from './desertParts.js';
import { SNOW_LIBRARY, SNOW_HOUSE_PARTS, SNOW_TREE_PARTS, SNOW_NATURE_PARTS, SNOW_LANDMARK_PARTS } from './snowParts.js';

/** Bump when a change makes an old manifest resolve to a DIFFERENT game. */
export const PACK_VERSION = 1;
export const PACK_KIND = 'shooter.pack';

/**
 * The parts index a rules block is checked against: the one its own library was shipped with. Each biome village
 * (the desert oasis, the snow village) keeps every kind of part in one library, so its house, tree, flora and
 * landmark rules all name it.
 */
const PARTS_INDEX = {
  house: { [DESERT_LIBRARY]: DESERT_HOUSE_PARTS, [SNOW_LIBRARY]: SNOW_HOUSE_PARTS },
  tree: { [DESERT_LIBRARY]: DESERT_TREE_PARTS, [SNOW_LIBRARY]: SNOW_TREE_PARTS },
  nature: { [DESERT_LIBRARY]: DESERT_NATURE_PARTS, [SNOW_LIBRARY]: SNOW_NATURE_PARTS },
  landmark: { [DESERT_LIBRARY]: DESERT_LANDMARK_PARTS, [SNOW_LIBRARY]: SNOW_LANDMARK_PARTS },
};
const indexFor = (kind, library, fallback) => PARTS_INDEX[kind][library] ?? fallback;

/**
 * A BIOME is a variant of a theme's world: the same pack, another village. `manifest.biomes.<id>` is an overlay on
 * the manifest: objects merge key by key, arrays and plain values replace, `null` deletes a key, a key listed in
 * the overlay's `replace` is taken whole, and `props` patches prop entries by id (a desert's rocks are sandstone).
 * The theme's own world is the biome with no overlay (Arcade's meadow).
 */
function overlay(base, patch) {
  if (patch === null) return undefined;
  if (typeof patch !== 'object' || Array.isArray(patch) || typeof base !== 'object' || base === null || Array.isArray(base)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) { const m = overlay(base[k], v); if (m === undefined) delete out[k]; else out[k] = m; }
  return out;
}
export function applyBiome(manifest, biome) {
  const B = biome ? manifest?.biomes?.[biome] : null;
  if (!B) return manifest;
  const out = { ...manifest }, whole = new Set(B.replace ?? []);
  for (const [key, value] of Object.entries(B)) {
    if (['label', 'blurb', 'replace'].includes(key)) continue;
    if (key === 'props') { out.props = (manifest.props ?? []).flatMap(p => (value[p.id] === null ? [] : value[p.id] ? [{ ...p, ...value[p.id] }] : [p])); continue; }
    if (whole.has(key)) out[key] = value;
    else { const m = overlay(manifest[key], value); if (m === undefined) delete out[key]; else out[key] = m; }
  }
  return out;
}

/** The same pack resolved for another biome (the project's): itself when it already is that biome. */
export function biomePack(pack, biome) {
  const want = biome && pack?.biomes?.includes(biome) ? biome : null;
  if ((pack?.biome ?? null) === want || !pack?.source) return pack;
  return resolvePack(pack.source.manifest, pack.source.measured, want, { weaponless: pack.source.weaponless });
}

/** Roles the placer and the simulation know how to act on. */
/**
 * `gear` is what only a hand-built level places (world/level/entities.js): keys, padlocks, a lever, the honey drop,
 * and the hero's staff. It is never a pool option, so a generated mission cannot draw it.
 */
export const ROLES = ['cover', 'barricade', 'gate', 'door', 'objective', 'dressing', 'gear'];
/** Blocker shapes `CollisionSystem` can register. */
export const COLLISION_KINDS = ['box', 'circle', 'none'];
/** The model a resolved pack throws as its grenade (sim/GrenadeSystem.js). */
export const grenadeModel = (pack) => pack.grenade.model;

/**
 * Validate a manifest and fill in what can be derived.
 *
 * Throws rather than repairs. A pack is authored content and a silently-corrected pack
 * is a pack whose author never finds out it was wrong — which shows up as a crate the
 * size of a building, in front of a player.
 *
 * @param {object} manifest  parsed pack.json
 * @param {Record<string, {longest: number, triangles: number, static: boolean}>} [measured]
 *   per-asset measurements from tools/build/inspect-pack.mjs, keyed by asset path. When
 *   supplied, `scale` is computed from the file's real extent instead of assuming 1.0.
 * @param {{weaponless?: boolean}} [o]  a pack exported with a game whose genres fire nothing carries no weapons, and
 *   may: the session says so for such a game. Every other pack must carry at least one.
 */
export function resolvePack(manifest, measured = null, biome = null, { weaponless = false } = {}) {
  if (manifest?.kind !== PACK_KIND) {
    throw new TypeError(`resolvePack: not a ${PACK_KIND} (got ${JSON.stringify(manifest?.kind)})`);
  }
  if (manifest.packVersion > PACK_VERSION) {
    throw new TypeError(
      `resolvePack: pack "${manifest.id}" is version ${manifest.packVersion}, this engine `
      + `reads ${PACK_VERSION}. Refusing to build it as something else.`);
  }
  if (!manifest.id) throw new TypeError('resolvePack: a pack needs an id');
  const source = { manifest, measured, weaponless };
  if (biome && !manifest.biomes?.[biome]) throw new TypeError(`resolvePack: ${manifest.id} has no biome "${biome}"`);
  manifest = applyBiome(manifest, biome);

  /**
   * metres -> a uniform scale, from the file's own measured extent, plus the world-space
   * FOOTPRINT the placer needs.
   *
   * The footprint is the X/Z extent after scaling, and it is what decides how big a
   * blocker the prop registers and how far apart two of them have to be. Taking it from
   * `metres` alone would be wrong for anything that is not cubic: `broken-road-block` is
   * 1.00 x 0.51 x 0.31, so at 2.5 m long it is 0.78 m deep, and a placer that reserved
   * 2.5 m in both axes would scatter six of them where twenty fit.
   */
  const scaleOf = (entry, where) => {
    if (!Number.isFinite(entry.metres) || entry.metres <= 0) {
      throw new TypeError(`resolvePack: ${manifest.id}.${where} needs a positive "metres"`);
    }
    const m = measured?.[entry.model];
    if (m?.longest === undefined) {
      return { scale: entry.metres, longest: 1, size: null, footprint: entry.metres, height: entry.metres, measured: false };
    }
    if (!(m.longest > 0)) throw new TypeError(`resolvePack: ${entry.model} measures ${m.longest} across`);
    const scale = entry.metres / m.longest;
    const size = m.size ? m.size.map((v) => +(v * scale).toFixed(4)) : null;
    return {
      scale,
      longest: m.longest,
      size,
      /** The larger of the two ground axes, in metres. */
      footprint: size ? +Math.max(size[0], size[2]).toFixed(4) : entry.metres,
      height: size ? size[1] : entry.metres,
      measured: true,
    };
  };

  const characters = {};
  for (const [key, c] of Object.entries(manifest.characters ?? {})) {
    if (!c.model) throw new TypeError(`resolvePack: character "${key}" has no model`);
    characters[key] = { id: key, ...c, ...scaleOf(c, `characters.${key}`) };
  }
  if (!characters.player) throw new TypeError(`resolvePack: ${manifest.id} has no player character`);

  const weapons = {};
  for (const [key, w] of Object.entries(manifest.weapons ?? {})) {
    if (!w.model) throw new TypeError(`resolvePack: weapon "${key}" has no model`);
    weapons[key] = { id: key, ...w, ...scaleOf(w, `weapons.${key}`) };
  }
  if (!Object.keys(weapons).length && !weaponless) throw new TypeError(`resolvePack: ${manifest.id} has no weapons`);

  const props = (manifest.props ?? []).map((p, i) => {
    if (!p.id) throw new TypeError(`resolvePack: prop #${i} has no id`);
    if (!ROLES.includes(p.role)) {
      throw new TypeError(
        `resolvePack: prop "${p.id}" has role "${p.role}". Known: ${ROLES.join(', ')}`);
    }
    const collision = p.collision ?? 'box';
    if (!COLLISION_KINDS.includes(collision)) {
      throw new TypeError(
        `resolvePack: prop "${p.id}" has collision "${collision}". Known: ${COLLISION_KINDS.join(', ')}`);
    }
    return { ...p, collision, ...scaleOf(p, `props.${p.id}`) };
  });

  // A door that opens into nothing is a door that deletes itself when used.
  for (const p of props) {
    if (p.opensTo && !props.some((q) => q.id === p.opensTo)) {
      throw new TypeError(`resolvePack: prop "${p.id}" opens to "${p.opensTo}", which is not in this pack`);
    }
  }

  const terrain = manifest.terrain ?? {};
  if (terrain.default && terrain.recipes && !terrain.recipes.includes(terrain.default)) {
    throw new TypeError(
      `resolvePack: ${manifest.id} defaults to terrain "${terrain.default}" but does not list it`);
  }

  // Generated creatures (world/creatureGrammar.js): refuse broken rules here, with the rule's own name.
  if (manifest.creatures) {
    const errors = validateCreatureRules(manifest.creatures);
    if (errors.length) throw new TypeError(`resolvePack: ${manifest.id} ${errors[0]}`);
  }
  // Generated houses (world/houseGrammar.js): the same, and a house prop needs the rules to build from.
  if (manifest.houses) {
    const errors = validateHouseRules(manifest.houses, indexFor('house', manifest.houses.library, null));
    if (errors.length) throw new TypeError(`resolvePack: ${manifest.id} ${errors[0]}`);
  }
  for (const p of props) if (p.generator === 'house' && !manifest.houses) throw new TypeError(`resolvePack: prop "${p.id}" is a generated house but ${manifest.id} has no house rules`);
  // Generated trees (world/treeGrammar.js): the same, against the tree parts library.
  if (manifest.trees) {
    const errors = validateTreeRules(manifest.trees, indexFor('tree', manifest.trees.library, TREE_PARTS));
    if (errors.length) throw new TypeError(`resolvePack: ${manifest.id} ${errors[0]}`);
  }
  for (const p of props) if (p.generator === 'tree' && !manifest.trees) throw new TypeError(`resolvePack: prop "${p.id}" is a generated tree but ${manifest.id} has no tree rules`);
  // The village layout (world/worldGrammar.js): the same, and its flora needs the nature parts library.
  if (manifest.world) {
    const errors = validateWorldRules(manifest.world, indexFor('nature', manifest.world.library, NATURE_PARTS), manifest.trees ?? null);
    if (errors.length) throw new TypeError(`resolvePack: ${manifest.id} ${errors[0]}`);
  }
  for (const p of props) if (p.generator === 'nature' && !manifest.world) throw new TypeError(`resolvePack: prop "${p.id}" is generated flora but ${manifest.id} has no world rules`);
  // The village's landmarks (world/worldLandmarks.js): the same, against the landmark parts library.
  if (manifest.world?.landmarks) {
    const errors = validateLandmarkRules(manifest.world.landmarks, indexFor('landmark', manifest.world.landmarks.library, LANDMARK_PARTS), manifest.trees ?? null);
    if (errors.length) throw new TypeError(`resolvePack: ${manifest.id} world.${errors[0]}`);
  }
  for (const p of props) if (p.generator === 'landmark' && !manifest.world?.landmarks) throw new TypeError(`resolvePack: prop "${p.id}" is a generated landmark but ${manifest.id} has no landmark rules`);

  const sounds = {};
  for (const [id, entry] of Object.entries(manifest.sounds ?? {})) {
    if (!entry || typeof entry.file !== 'string' || !/^assets\/[a-zA-Z0-9_./-]+\.(mp3|wav|ogg)$/.test(entry.file) || entry.file.split('/').includes('..')) throw new TypeError(`resolvePack: invalid sound path for ${id}`);
    if (entry.gain !== undefined && (!Number.isFinite(entry.gain) || entry.gain < 0 || entry.gain > 4)) throw new TypeError(`resolvePack: invalid sound gain for ${id}`);
    sounds[id] = {...entry};
  }
  // The thrown grenade (sim/GrenadeSystem.js): one model, required; its size is measured from the file.
  const grenade = manifest.grenade;
  if (!grenade || typeof grenade.model !== 'string' || !/^assets\/[a-zA-Z0-9_./-]+\.glb$/.test(grenade.model) || grenade.model.split('/').includes('..')) {
    throw new TypeError(`resolvePack: ${manifest.id} grenade needs a "model" .glb under assets/`);
  }
  const pack = {
    sounds,
    grenade: { model: grenade.model },
    creatures: manifest.creatures ?? null,
    houses: manifest.houses ?? null,
    trees: manifest.trees ?? null,
    world: manifest.world ?? null,
    kind: PACK_KIND,
    packVersion: manifest.packVersion ?? PACK_VERSION,
    id: manifest.id,
    label: manifest.label ?? manifest.id,
    blurb: manifest.blurb ?? '',
    terrain: {
      recipes: terrain.recipes ?? [],
      default: terrain.default ?? terrain.recipes?.[0] ?? null,
      palette: terrain.palette ?? null,
    },
    characters,
    weapons,
    props,
    /** Props grouped by role — what the placer iterates. */
    byRole: Object.fromEntries(ROLES.map((r) => [r, props.filter((p) => p.role === r)])),
    /** The biome this pack was resolved for (null: the theme's own world) and every biome the theme offers. */
    biome: biome ?? null,
    biomes: Object.keys(source.manifest.biomes ?? {}),
  };
  // What biomePack re-resolves from; kept off the enumerable shape, so a pack still compares and serialises as before.
  Object.defineProperty(pack, 'source', { value: source, enumerable: false });
  return pack;
}

/** Every asset path a manifest references, deduplicated, in declaration order. */
export function packAssets(manifest) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') { if (v.endsWith('.glb')) out.push(v); return; }
    if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(manifest);
  return [...new Set(out)];
}

/**
 * The decoded-texture budget a pack costs, and whether it fits.
 *
 * Decoded RGBA, not file size: an 8192 map is 268 MB in memory whatever it compresses
 * to on disk, and it is the memory figure that gets a tab killed. `src/core/AssetLoader.js`
 * caps textures at 2048 for exactly this reason and downscales as it loads, so this
 * reports BOTH numbers — what the pack ships, and what it costs once the loader has done
 * its work. A pack is shippable when the second one fits.
 */
export function packBudget(manifest, measured, { cap = 2048, limitMB = 512 } = {}) {
  const assets = packAssets(manifest);
  let shipped = 0, capped = 0, bytes = 0, missing = 0;
  const over = [];
  for (const a of assets) {
    const m = measured?.[a];
    if (!m) { missing++; continue; }
    bytes += m.bytes ?? 0;
    shipped += m.decodedMB ?? 0;
    for (const dim of m.images ?? []) {
      const [w, h] = dim.split('x').map(Number);
      const cw = Math.min(w, cap), ch = Math.min(h, cap);
      capped += (cw * ch * 4) / 1048576;
      if (w > cap || h > cap) over.push({ asset: a, dim });
    }
  }
  return {
    assets: assets.length,
    missing,
    diskMB: +(bytes / 1048576).toFixed(1),
    shippedTextureMB: +shipped.toFixed(1),
    cappedTextureMB: +capped.toFixed(1),
    over,
    fits: capped <= limitMB,
    limitMB,
  };
}
