# First-person arms

Arcade ships first-person arms: the villager hero's, one GLB per weapon, built by the scripts `fparms.py` and `fpanim.py`.

## Arcade

The Arcade view is the hero's own arms (`assets/v2/arcade/characters/arcade-hero.glb`) holding each Arcade weapon,
one GLB per weapon:

| Pack weapon | Viewmodel | Prefix | Style |
|---|---|---|---|
| `sidearm` | `assets/v2/arcade/fp/slingshot.glb` | `Sling` | a chest-high ready draw; release, band snap, catch the pouch, drawn again by the next shot |
| `assault` | `assets/v2/arcade/fp/repeater.glb` | `Repeater` | the left hand works the lever bar; a flick per bolt; the hopper is the magazine |
| `shotgun` | `assets/v2/arcade/fp/blunderbuss.glb` | `Blunderbuss` | a big rolling kick, the thumb re-cocks; powder horn and ramrod, two rams |
| `marksman` | `assets/v2/arcade/fp/arbalest.glb` | `Arbalest` | the string snaps forward, the limbs flex, three turns of the crank, a bolt drops in |
| `launcher` | `assets/v2/arcade/fp/cannon.glb` | `Cannon` | fuse flare and a heavy kick; the ball is dropped in the muzzle (no `_ReloadEmpty`) |

How it is built:
- **Arms modelled for the camera.** The third-person hero's toon arms (1.3x hands, 4.6 cm fingers, 15 cm forearms, a
  0.46 m reach) fill the frame at first-person distance. So `arcade/fp_rigs.py` builds a first-person pair in the hero's
  look: skin arms in the short sky-blue sleeve, the dark leather fingerless glove, the kit's materials. They are life
  size, with 1.8 cm fingers, a 10 cm palm and a 7 cm forearm, and the reach is 0.60 m, longer than the body's as
  first-person arms usually are: the camera never sees the shoulder, and the reach decides how far out a weapon can hang.
  `fp_hero_source()` builds them on the Mixamo bone names at the hero's eye (0, -0.228, 1.538).
- **The source swap.** `fparms.py` keeps a `SOURCES` table: file, scale, eye, shoulder shift, mesh, cached arms name,
  remap, colour layer and an optional `build` function that makes the source in the file instead of importing it. The
  Arcade entry is `hero` (`use_source('hero')`), found by its
  `fp_source` tag. The shoulders sit 8 cm behind and 25 cm below the eye, the left one further forward for the support
  hand.
- **Framing, measured.** Each weapon is placed with `fp_place` (a grip on a chosen screen point at a chosen distance), at
  life scale (the cannon at 0.85), and checked with `arc_coverage` / `arc_sweep` through the engine's 60 degree camera:
  at idle the arms cover 4-10% of the frame and next to nothing of its centre, and no frame of any clip passes 12%.
  The grips and every hand hold on a moving part were chosen with `fp_grip_search`, which scores the cylinder axis, palm
  side and tilt by the arm solver's wrist twist, bend and reach over the frames the hold is used in. The repeating
  crossbow is worked as the real one is: the rear hand pumps the lever, the front hand holds the fore-stock.
- **Reload poses.** The two muzzle-loaders reload tipped up at the chest with the muzzle just below the eye, the held
  point travelling a straight line (`arc_swing`); the right hand moves to a hold on the barrel for it. The horn and
  ramrod are short toon props parked inside the butt at scale 0.002 outside the reloads.
- **Nodes.** Extra moving bones: `Pouch`/`Pebble` (slingshot), `Lever`/`Mag`/`String` (repeater), `Hammer`/`Horn`/
  `Ramrod` (blunderbuss), `String`/`Limb_L`/`Limb_R`/`Crank`/`Bolt` (arbalest), `Fuse`/`Spark`/`Ball` (cannon). The bands
  and strings are skinned between the two bones they join, so they stretch. `Round` is the pebble, the bolt and the ball.
  Every mesh node carries `extras.arc_outline` (arms and weapon 0.006, bands and strings 0; the engine draws view-model
  shells at 0.4x, a 2.4 mm line), and the engine grows the outline shells (`render/ArcadeToon.js`: a skinned shell for a
  skinned mesh).
- **Sound sync.** Every clip is cut to the Arcade sounds (`assets/v2/arcade-sounds/`, the pack's `sounds` slots). A shot's
  key move lands on the shot sound's transient, a reload's moves land on the reload sound's hits, and the pack's reload
  timeline quotes the same frames in seconds: `magOut` the part leaving, `magIn` the seat, `commitAmmo` the slap or
  second ram, `bolt` the empty reload's extra move. The beat tables are in `arcade/fp_clips.py` beside each weapon.
  The repeater fires at 600 rpm on one looping voice, so its fire slot loops the 0.10 s of the shot around the lever
  clack (`offset`/`loopStart` 0.15 s, `loopEnd` 0.25 s): one clack per bolt, in phase with the clip's flick.

Rebuild, in one namespace, after vg, arcade/kit, nature, hero_corner, props, weapons, critters, pickups and hero:
`fparms.py`, `fpanim.py`, `arcade/fp_rigs.py` (`build_arc('Sling')` builds one rig) and `arcade/fp_clips.py`
(`make_arc('Sling')` authors the clips, `export_arc('Sling')` writes the GLB, `arc_review`/`arc_tile`/`arc_stitch`
make the review renders). The Blender source is `assets/v2/arcade/fp/src/fp_arcade.blend`. The GLBs go to R2 through
`R2-upload-arcade/` and `tools/assets/arcade-r2-upload-manifest.json`.
