/**
 * THE BUILD SPEC: the whole game as a couple of kilobytes of choices.
 *
 * This is the file the product compiles. A player makes a sequence of choices, each one
 * writes a field here, and this object — plus the engine — is the game. Nothing else
 * travels: no heightmap, no baked lighting, no level geometry. A spec is instructions,
 * and the engine is the only thing that can follow them.
 *
 *     choices -> BuildSpec -> tools/build/bake-level.mjs -> static files -> playable
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FILE AND NOT A FUNCTION CALL
 * ---------------------------------------------------------------------------
 * Because the promise is reproducibility, and reproducibility has to be checkable. A
 * spec is hashable, diffable, cacheable and mailable. Two specs that hash the same must
 * build the same folder of files, and `specHash` is what lets a build cache be a plain
 * key-value lookup instead of an act of faith. That is also what makes the marginal
 * cost of a "generation" effectively zero: the second person to pick the same choices
 * gets a cache hit, not a rebuild.
 *
 * It is deliberately shaped like the repository's `.world.json` (js/worldfile.js) — `{ kind,
 * fileVersion, generatorVersion, ... }` — because that format has already survived a
 * generator rewrite with its old files still building, and the migration story is the
 * part of a spec format that is expensive to learn twice.
 *
 * ---------------------------------------------------------------------------
 * THE LADDER, AND WHAT OF IT EXISTS
 * ---------------------------------------------------------------------------
 * The product's choice sequence is World -> Terrain -> Environment -> Gameplay ->
 * Character -> Role -> Mechanics -> Encounters -> Objectives -> Presentation -> Build,
 * and each rung is supposed to CONSTRAIN the next rather than sit beside it. The spec
 * encodes that by making later blocks read earlier ones: `resolveSpec` derives what it
 * can instead of asking, so choosing an island world has already decided that traversal
 * is coastal, that encounters cluster inland, and that the mission cannot be a long
 * patrol route.
 *
 * Honest status, because a spec that pretends to carry systems the engine does not have
 * is worse than one that admits the gap:
 *
 *   pack        BUILT    the first click -> packs/<id>/pack.json -> src/world/pack.js
 *   world       BUILT    seed + terrain params -> the repository kernel's src/kernel/terrain/heightfield.js
 *   terrain     BUILT    baked to heights + a walkable mask by tools/build/bake-level.mjs
 *   environment ABSENT   lightZones is carried in the spec but nothing consumes it yet
 *   gameplay    BUILT    src/config/gameplay.js overlay — weapons, player, economy
 *   character   BUILT    src/viewmodel/ — hands and weapon rigs
 *   role        ABSENT   no loadout/class system exists
 *   mechanics   PARTIAL  weapons and grenades exist; traversal verbs do not
 *   encounters  PARTIAL  objectives and cover placed on reachable ground
 *                        (world/placement.js); runtime AI exists, encounter specs still pending
 *   objectives  PARTIAL  objective props are placed and reachability-checked; no
 *                        campaign wave specifications yet; runtime activation/extraction exists
 *   presentation BUILT   src/config/quality.js + core/DeviceProfile.js decide it at boot
 *
 * The absent rungs are named here on purpose. When they arrive they get a block in this
 * file and a stage in the baker, and nothing else about the pipeline changes.
 */

import { hashSeed, normalizeSeed } from '../kernel/seed.js';

/** Bump when a change makes an old spec build a DIFFERENT world. */
export const GENERATOR_VERSION = 1;
/** Bump when the file's shape changes in a way a reader must know about. */
export const FILE_VERSION = 1;
export const SPEC_KIND = 'shooter.build';

/**
 * TERRAIN RECIPES: the "World" rung's menu.
 *
 * A recipe is a complete, tuned terrain parameter set — not a preset that nudges a
 * slider. That distinction is the product's whole UX claim: the player picks a KIND OF
 * PLACE and gets one, rather than being handed eleven numbers and asked to find a good
 * combination. Every one of these is walkable, has a coastline, and has enough flat
 * ground to fight on, which is a property that was tuned, not assumed.
 *
 * `size` is in metres. These are shooter scales — a few hundred metres across — not the
 * 4 km continents the kernel's own worlds are (src/kernel/presets.js). See
 * src/kernel/terrain/heightfield.js at the repository root, which samples both.
 */
export const TERRAIN_RECIPES = {
  /** Rolling ground with a few commanding rises. The default because it fights well. */
  highlands: {
    size: 420, height: 62, frequency: 3.1, octaves: 5, lacunarity: 2.03, gain: 0.5,
    warp: 0.5, ridged: 0.45, plateau: 0.05, island: 0.0, seaLevel: 0.42,
  },
  /** Sharp relief, deep draws, long sight lines from the crests. */
  alpine: {
    size: 520, height: 120, frequency: 3.6, octaves: 6, lacunarity: 2.02, gain: 0.5,
    warp: 0.58, ridged: 0.8, plateau: 0.03, island: 0.1, seaLevel: 0.40,
  },
  /** Terraced mesas: flat fighting decks separated by drops you cannot climb. */
  badlands: {
    size: 460, height: 78, frequency: 4.2, octaves: 5, lacunarity: 2.1, gain: 0.48,
    warp: 0.35, ridged: 0.55, plateau: 0.55, island: 0.0, seaLevel: 0.44,
  },
  /** One landmass in water. Traversal is funnelled; the sea is the level boundary. */
  atoll: {
    size: 380, height: 46, frequency: 2.8, octaves: 5, lacunarity: 2.0, gain: 0.52,
    warp: 0.45, ridged: 0.25, plateau: 0.0, island: 0.85, seaLevel: 0.50,
  },
  /** Broad and gentle. The most floor area per square metre; the fewest sight breaks. */
  basin: {
    size: 400, height: 34, frequency: 2.4, octaves: 4, lacunarity: 2.0, gain: 0.55,
    warp: 0.3, ridged: 0.15, plateau: 0.12, island: 0.0, seaLevel: 0.38,
  },
};

/**
 * TRAVERSAL: what the body can do, which is what makes terrain gameplay.
 *
 * These are the numbers the baker turns a height field into a walkable mask WITH — the
 * same way the repository kernel's interior reach check (src/kernel/core/reach.js, STEP_UP) is
 * parameterised by its walk controller's own step height rather than by a guess. Change `stepUp` and the set of reachable
 * ground changes; that coupling is the point, and it is why these live in the spec
 * rather than in a config constant.
 */
export const TRAVERSAL_DEFAULTS = {
  /** Metres of vertical rise a player can walk up without jumping. */
  stepUp: 0.55,
  /** Slope, in metres per metre, above which ground is too steep to stand on. */
  maxSlope: 0.85,
  /** Player capsule radius, for clearance against blockers. Matches PLAYER.radius. */
  radius: 0.42,
  /** Headroom the player needs. */
  headroom: 1.9,
  /**
   * Metres of water depth that is still walkable. Shallows are traversable and read as
   * a shore; anything deeper is the level's edge.
   */
  wadeDepth: 0.9,
};

/** The spec a user who has chosen nothing still gets: a complete, playable world. */
export function defaultSpec() {
  return {
    kind: SPEC_KIND,
    fileVersion: FILE_VERSION,
    generatorVersion: GENERATOR_VERSION,
    /**
     * THE FIRST CLICK. A pack id resolves to packs/<id>/pack.json, which supplies the
     * art, the scales, the prop roles and the terrain recipes this kind of game uses.
     * Null means the engine's own defaults and no art, which is what every spec built
     * before packs existed says by saying nothing.
     */
    pack: null,
    world: {
      seed: 'K7QN-3F2A-9XBD',
      recipe: 'highlands',
      /** Overrides merged OVER the recipe. Empty is the honest default. */
      terrain: {},
    },
    traversal: {},
    /**
     * The grid the walkable mask is baked at. 320 is what `src/sim/grid.js` has always
     * used and what `CollisionSystem` unpacks; it stays the default so an existing
     * flat-grid level and a baked terrain level are the same kind of object.
     */
    bake: { gridN: 320, heightRes: 257 },
    environment: { lightZones: [] },
    /**
     * What goes ON the ground. `objectives` is how many the mission has;
     * `coverDensity` scales the cover scatter, 0 for none. See world/placement.js —
     * these are read there and nowhere else.
     */
    encounters: { objectives: 3, coverDensity: 1 },
    /** Sparse overlays onto src/config/*. Absent means "the engine's own value". */
    gameplay: {},
    presentation: {},
  };
}

/**
 * Fill a partial spec out to a complete one, deriving what can be derived.
 *
 * Pure, total, and idempotent: `resolve(resolve(s))` deep-equals `resolve(s)`. That
 * matters because the hash is taken over the RESOLVED spec, so a user who typed
 * nothing and a user who typed the defaults explicitly must land on the same build.
 *
 * @throws {TypeError} on a recipe that does not exist — a silent fallback here would
 *   ship a different world than the one that was chosen, which is the one failure this
 *   whole design exists to prevent.
 */
export function resolveSpec(input = {}) {
  const base = defaultSpec();
  const world = { ...base.world, ...(input.world ?? {}) };

  /* String(… ?? '') before the kernel's normalizeSeed, not after. The kernel reads a FALSY
     input as no seed at all (`String(input || "")`); this engine always read the number 0 as
     the seed 0222-2222-2222, and a spec saved with `seed: 0` has to keep building the world
     it built. The two agree on every other input, strings and other numbers included. */
  const seed = normalizeSeed(String(world.seed ?? '')) ?? base.world.seed;
  const recipeName = world.recipe ?? base.world.recipe;
  const recipe = TERRAIN_RECIPES[recipeName];
  if (!recipe) {
    throw new TypeError(
      `resolveSpec: unknown terrain recipe "${recipeName}". ` +
      `Known: ${Object.keys(TERRAIN_RECIPES).join(', ')}`);
  }

  /* KERNEL-ONLY FIELDS ARE STRIPPED, NOT PASSED. The repository kernel's createHeightSampler
     honours two fields this spec format never had: `stack` (a layer stack that REPLACES the
     recipe's shape) and `intent` (statements the kernel's solver makes the ground meet). The
     port this engine used to carry ignored both, so a spec carrying either built the recipe's
     world; passed through, the same file would build a different one under the same
     GENERATOR_VERSION — measured on K7QN-3F2A-9XBD highlands: a 60 m pad at 30 m moved h(0,0)
     from 11.151 m to 29.99999 m, and a billow stack moved h(10,10) from 12.786 m to -1.182 m.
     Until games3d supports them on purpose (with a version bump and parseSpec refusing them on
     older generators), they are removed here, before the hash, so a spec that carries them is
     the very spec that does not — the same world and the same specHash. Mission intent reaches
     the kernel by another road: a shooter project with `ground: "world"` (world/kernelGround.js).
     tools/test/test-buildspec.mjs pins both. */
  const { stack: _stack, intent: _intent, ...terrain } = { ...recipe, ...(world.terrain ?? {}) };
  const traversal = { ...TRAVERSAL_DEFAULTS, ...(input.traversal ?? {}) };
  const bake = { ...base.bake, ...(input.bake ?? {}) };

  const resolved = {
    kind: SPEC_KIND,
    fileVersion: FILE_VERSION,
    generatorVersion: GENERATOR_VERSION,
    pack: input.pack ?? base.pack,
    world: { seed, recipe: recipeName, terrain },
    traversal,
    bake,
    environment: { ...base.environment, ...(input.environment ?? {}) },
    encounters: { ...base.encounters, ...(input.encounters ?? {}) },
    gameplay: { ...(input.gameplay ?? {}) },
    presentation: { ...(input.presentation ?? {}) },
  };
  resolved.specHash = specHash(resolved);
  return resolved;
}

/**
 * A stable 32-bit id for a resolved spec, as eight lowercase hex digits.
 *
 * Taken over a CANONICAL serialisation — keys sorted at every depth — because
 * `JSON.stringify` preserves insertion order, and two specs that differ only in the
 * order their fields were assigned are the same spec and must cache as one. `specHash`
 * itself is excluded so that hashing is idempotent.
 */
export function specHash(spec) {
  return hashSeed(canonicalize(spec)).toString(16).padStart(8, '0');
}

/** Deterministic JSON: object keys sorted, arrays in order, `specHash` omitted. */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).filter((k) => k !== 'specHash').sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

/**
 * Read a spec that came off disk or over the wire.
 *
 * A spec from a NEWER generator is refused rather than built: it names systems this
 * engine does not have, and building it would quietly produce a different game than the
 * one the sender saw. An older one is accepted — that is what `generatorVersion` is for
 * — and the caller is told, so a rebuild can be offered.
 */
export function parseSpec(json) {
  const raw = typeof json === 'string' ? JSON.parse(json) : json;
  if (raw?.kind !== SPEC_KIND) {
    throw new TypeError(`parseSpec: not a ${SPEC_KIND} (got ${JSON.stringify(raw?.kind)})`);
  }
  if (raw.generatorVersion > GENERATOR_VERSION) {
    throw new TypeError(
      `parseSpec: spec was built by generator v${raw.generatorVersion}, this engine is ` +
      `v${GENERATOR_VERSION}. Refusing to build it as something else.`);
  }
  const resolved = resolveSpec(raw);
  resolved.migratedFrom = raw.generatorVersion < GENERATOR_VERSION ? raw.generatorVersion : null;
  return resolved;
}
