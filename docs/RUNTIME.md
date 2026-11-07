# Runtime contract

`src/game/Game.js` is the simulation owner. The studio, terrain preview and headless walker use
it; a game host should create it rather than assembling another player/collision loop.
No browser globals, storage, asset fetching or rendering are required to construct it.

## Repository map

| Responsibility | Implementation |
| --- | --- |
| Guarded lifecycle | `src/sim/GameState.js` |
| 60 Hz tick, subsystem wiring, HUD state | `src/game/Game.js` |
| Deterministic AI, spawns, combat, death | `src/game/EnemySystem.js` |
| Connected mission sequence, waves, doors and extraction | `src/game/BlueprintObjectives.js` |
| Legacy terrain stations | `src/game/ObjectiveSystem.js` |
| Health, ammunition and grenade pickups | `src/game/SupplySystem.js` |
| Typed graph validation and connected pool selection | `src/world/blueprint.js` |
| Spec to in-memory terrain/nav/placements | `src/world/compileLevel.js` |
| Offline level serialization | `tools/build/bake-level.mjs` |
| Nav, clearance, LOS, dynamic blockers | `src/sim/CollisionSystem.js` |
| Hitscan and head classification | `src/weapons/WeaponRaycaster.js` |
| Terrain intersection for shots/rockets | `src/sim/terrainRay.js` |
| Weapon damage scaling and cadence | `src/weapons/WeaponController.js` |
| Shared blast falloff and cover checks | `GrenadeSystem.radialDamage` |
| Enemy poses and death collapse | `PackAnimator` (skinned), `RigidAnimator` (rigid) |

The previous notes called the death system a ragdoll. The available implementations are
procedural collapse/topple animations, not physics ragdolls. The runtime calls those
existing implementations through `setDeathDirection`, `kickStagger` and `update`.

## Loading and advancing

```js
import { Game } from './src/game/Game.js';
import { resolvePack } from './src/world/pack.js';

// The host loads JSON/assets. resolvePack also accepts measured asset metadata.
const game = Game.fromSpec(spec, { camera, pack: resolvePack(manifest, measurements) });
// Alternatively: Game.fromBaked(await import('./level.generated.js'), { camera }).
game.start();

// Render host: seconds, not milliseconds. A function supplies input for each tick.
game.advance(frameSeconds, tick => replayInputs[tick] ?? {});
game.updateVisuals(frameSeconds);
renderer.render(scene, camera);

// Headless simulation/replay uses exact ticks and never drops simulation time.
game.step({ move: { x: 0, y: 1 }, fire: true });
```

Choose `advance` or `step` for a given loop, not both. `advance` caps catch-up at the
existing `MAX_SUBSTEPS`; excess elapsed wall time is discarded. For equal tick inputs,
simulation is independent of render grouping. `look: {x, y}` contains per-tick radian
deltas; do not reuse one mouse event over several catch-up ticks. `reload` and `grenade`
are per-tick action requests. Move/fire/ADS/interact/sprint/crouch are held intentions.

`pause`, `resume`, `restart` and `dispose` gate updates through `GameState`. Restart resets
the same level, score, RNG, corpses, weapons/projectile pools and objective progress.
Manually spawned enemies are cleared; an encounter owner should replay its spawn schedule.
Restart does not rebuild art or mutate the level specification.

The fixed update order is player, interactions, weapons, enemies, grenades, rockets,
objectives, with player death taking precedence over victory. Rendering cannot open an
attack damage window. `hudState` exposes lifecycle, mission time, health, score, kills,
enemy count, weapon data, grenade count, interaction prompt and objective progress.
Score is run-local; it does not write a save file or automatically bank salvage.

## Existing combat systems and visuals

Pass `createSystems(game)` to construct already-loaded `WeaponController`, `GrenadeSystem`
and `RocketSystem` instances using `game.player`, `game.collision` and `game.camera`.
Return `{ weapons, grenades, rockets }`; an optional `objectives` overrides the default
mission system, and explicit `objectives: null` disables it. The host still owns renderer,
scene, assets, VFX and audio. The runtime owns and disposes the supplied gameplay systems.

Game wires the enemy provider and `onEnemyHit` callback, projectile `onExplode` callbacks,
viewmodel recoil, rocket launch dependency and grenade throw pose. Those damage callbacks
are runtime-owned. WeaponController already computes headshot and falloff multipliers;
EnemySystem receives final damage without applying them twice. Both explosive systems
use the existing grenade radial-damage helper, including its configured falloff exponent.

```js
const enemy = game.enemies.spawn('shambler', {
  position: { x: 12, z: -8 }, authored: true, alerted: true,
});
// null means blocked, unreachable, too near the player, or at the population cap.
// Omitting position chooses a deterministic valid nav cell.
```

Enemy tuning comes from `ENEMY_TYPES` and `ENEMY_LIMITS`. Generic and authored spawn
distances are distinct. Path requests use each type's radius, with bounded spawn search
and the existing near/far repath intervals. Unknown quality tiers use the conservative
mobile population cap. The studio supplies theme-specific ranged or melee tuning through `enemyTypes`.

`createEnemyVisual(enemy)` may return `{ root, animator, dispose }`. The root belongs in
the host's scene; the animator drives its child model. The host prepares/clones the model
using the existing rig or rigid-body pipeline. Assets and shared materials remain owned
by the host; the visual disposer should detach per-instance objects without disposing
shared geometry. A headless enemy needs no visual.

The animator reads exactly `position`, `velocity`, `yaw`, `state`, `stateTime`, `alive`,
`aware`, `distToPlayer`, `deathTime`, and `dissolve`. Dead enemies stop attacking, moving,
participating in separation and receiving hits immediately, then retain their visual
until the configured corpse linger expires. Visual seeds never drive gameplay decisions.

## Blueprint missions

Studio levels carry a compiled blueprint. `BlueprintObjectives` advances its connected
sequence of activation, door overrides, waves, elimination, heavy encounters, barricades,
checkpoints and extraction. Enemy spawns use the connected category roster. Door and
barricade completion updates dynamic collision. `SupplySystem` restores actual runtime
resources; supplies, objectives and blockers reset together on restart.

## Legacy terrain objective rule

Placed records with `objectiveIndex` become control stations. Looking at a station and
holding interact activates it using `OBJECTIVE.activationTime`; releasing decays progress
using `INTERACTION.cancelDecay`. All stations must complete before the configured
extraction delay runs. Return to the player spawn within `OBJECTIVE.extractionRadius` to
win. Extraction guidance uses the existing pathfinder. Levels without stations stay in
sandbox mode and do not win automatically. Campaign wave counts are not inferred from
old Maze Fever configuration.

## Corrections made at integration seams

- Interaction columns use the anchor's elevation, preserving zero-height legacy anchors.
- Shots/rockets intersect baked terrain; grenades settle on it, including below sea level.
- Placed props register rotated navigation footprints and finite projectile boxes, so
  shots can pass above low cover. Blocker activation affects both representations.
- Explosions now respect prop blockers; the old helper ignored dynamic cover.
- Grenade disposal detaches both world and held roots, even with a separate viewmodel camera.
- Enemy repaths skip a redundant start cell only after a body-clearance check, preventing
  oscillation back to the cell center during pursuit.

Navigation and perception remain conservative 2D grid/LOS queries. Circular props use
conservative bounding boxes for projectiles. This change does not add multi-floor nav.

## Studio host and verification

`ShooterSession` loads measured asset packs, compiles `shooterProject`, creates the
renderer, characters, viewmodels, animation, audio and input, and advances this same
runtime. `PackAnimator` plays Blender-baked skeleton clips; authored weapon assemblies
use the existing `AuthoredAnimator`. These are animation-driven visual presentations,
not physics ragdolls. The theme roster selects ranged operators or melee subjects.

Run `node tools/test/run.mjs` and `node tools/check-imports.mjs`. The studio suite covers
all three themes, determinism, actual pack geometry, firing/reloading, objective
activation, extraction, restart and character animation metadata. Export tests open
produced ZIPs with Python's independent ZIP reader and verify every runtime import
and selected pack asset is present. Browser checks cover the visual host separately.

See [STUDIO.md](STUDIO.md) for integration details and release limits. Remaining product
work includes campaign/progression, destructible environments, real-device performance
and touch QA, native iOS packaging, and App Store submission. The supported mission steps are documented in STUDIO.md; the compiler validates their
required pools before loading assets.
