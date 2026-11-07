# Genres

The engine is a platform; a genre is a vocabulary and a set of rules over it. Every genre plays on the same renderer,
world generator, terrain, collision, navigation, critters, interaction system, level script, audio and studio. What
a genre decides: which blueprint pools a mission needs, which objectives its steps may use, the perspective it plays
from, what the player's hands do, and how it is controlled.

`src/genres/registry.js` is the table (data only, no three, readable by the world layer); `src/genres/rules.js` maps
each genre to its runtime rules, which the session consults for the systems handed to the game, the shape of the
fixed-step input, the camera and, for the genres that show the hero, the hero's model. `project.genre` (project format
3 and later, see [PROJECT_FORMAT.md](PROJECT_FORMAT.md)) names the genre; a document without it is a shooter.

| Genre | Plays as | Builds | Perspective | Mission steps | Lives |
| --- | --- | --- | --- | --- | --- |
| `shooter` | Hitscan weapons, fizz-bombs, rockets. | weapon stack | first | all but collect and survive | 1 |
| `exploration` | No weapons. Reach, activate, get out. | nothing extra | first | activate, override, reach, extract | 1 |
| `action` | Third person with the trail staff: strike, jump, keys and gates. | the staff strike (`MeleeSystem`) | follow | activate, override, waves, eliminate, boss, barricade, reach, collect, extract | 3 |
| `arena` | From above, twin stick: move one way, aim another, survive. | weapon stack, fired from the hero | overhead | waves, survive, eliminate, boss, activate, reach, extract | 3 |
| `collect` | Third person, no weapon: run and jump for honey; land on critters. | the stomp (`StompSystem`) | follow | collect, reach, activate, override, extract | 3 |

The old third-person camera and the adventure and tactical genres of 2026-09 were retired; saved projects that name
them open as shooters in first person (`resolveProject`), which is what they were saved as. The action, arena and
collect genres are new ids with new rules, not those.

## Perspectives

- **first**: the eye, the hands and the weapon (the first-person arms, [FP_ARMS.md](FP_ARMS.md)).
- **follow** (`genres/hero/view.js` `FollowCamera`): behind the hero, the look input orbiting the camera, the hero
  turning to where they run at a bounded rate (`genres/hero/thirdPerson.js`). The camera eases after the hero, keeps
  its height over hills and slides in rather than cut through a house or a trunk. The action adventure frames it over
  the right shoulder; the collect-a-thon higher and further back, where a jump's landing shows.
- **overhead** (`OverheadCamera`): above and behind, north up; the pointer's point on the ground (or the right stick,
  or the right touch pad) is what the hero aims at. On a portrait screen it stands further off to show the same width.

The hero seen from outside is the pack's player model with its clips (`anim/HeroAnimator.js`: idle, run, jump, fall,
attack, hit, death, cheer, and the aim set for the arena), holding the trail staff in its `Grip_R` socket or the
arena's weapon at the chest (`genres/hero/HeroPresentation.js`). Presentation only: the simulation sees an ordinary
player input, so replays, collision, interactions and the level script work unchanged.

## Controls

Each genre declares its controls in the registry (`controls`): the play card's guide for keyboard and mouse, for touch
and for a gamepad, and which touch buttons show. Gamepads use the standard mapping (`core/Gamepad.js`): left stick
moves, right stick looks (or aims, in the arena), A jumps, B or X interacts, RT fires (strikes), LT aims down the
sights, LB throws a fizz-bomb, RB reloads, Y cycles weapons, Start pauses.

| Genre | Keyboard and mouse | Touch |
| --- | --- | --- |
| shooter | WASD, mouse aim, click fire, Space jump, E interact, R reload, G fizz-bomb | move pad, drag to look, FIRE, AIM, USE, RELOAD, GRENADE, WEAPON |
| exploration | WASD, mouse look, Shift sprint, Space jump, E interact, J journal | move pad, drag to look, JUMP, USE |
| action | WASD run, mouse turns the camera, Space jump, click strike, E interact | move pad, drag the camera, STRIKE, JUMP, USE |
| arena | WASD move, the mouse aims, hold click to fire, G, R, E | move pad, a right-hand aim pad that fires while held, RELOAD, GRENADE, WEAPON, USE |
| collect | WASD run, mouse turns the camera, Space jump, E interact | move pad, drag the camera, a large JUMP, USE |

## What each one adds

**Exploration** removes the weapon stack. The interaction hold is the only hand action; critters are hazards, so
the compiler refuses the combat steps.

**Action**: the fire button swings the staff: one press, one swing, the blow landing on the swing's fifth frame on
everything in reach and in front with a clear line, then a cooldown. A barricade takes the blow like a bullet.

**Arena**: the shooter's weapon stack, carried by the hero; shots, tracers and the muzzle flash leave from the hero's
weapon. `survive` keeps the waves coming until its clock runs out.

**Collect**: landing on a critter bops it and bounces the hero; walking into one still hurts. `collect` counts honey
drops: the ones the editor placed and the ones the step lays along the village lanes (on dry ground, clear of pads,
cover and the start, keyed per step so the editor moves them like pads).

The launcher offers each genre a ready mission (`src/world/genreContent.js`: survey-v1, trail-v1, siege-v1,
harvest-v1), and the level editor a template game ([EDITOR.md](EDITOR.md)).

## The seam, for the next genre

1. Add an entry to `GENRES` in `src/genres/registry.js`: its pools, objectives, perspective, preset and controls.
2. Add a rules module under `src/genres/<id>/` and register it in `src/genres/rules.js`: `createSystems` returns any
   systems under any keys (`Game` steps the ones it does not know after the shooter's fixed set, passes them the raw
   input, and carries them through restart, visuals, the HUD and disposal); `input` shapes the fixed-step input;
   `view`, `updateCamera` and `createPlayerVisual` if it does not play in first person; `gear` in the registry for
   pack props it needs loaded (they ship with its exports).
3. Give `quickMission` (`src/world/missionCard.js`) a preset if the launcher should offer it, and a template game.
4. Extend `test-genres` with the genre's contract and one played-through mission.

The studio reads the table for its genre select, objective library and control guides; the launcher for its genre
picker; the compiler for its pool and step rules. None of them needs to know a genre by name.
