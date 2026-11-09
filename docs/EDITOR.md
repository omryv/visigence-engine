# The level editor

Build mode (the **Build** tab of the page, or **Build level** in Remix) is a 3D level
editor for the arcade games the studio makes: a first-person shooter, first-person exploration, a third-person
action adventure, a top-down arena shooter and a 3D collect-a-thon ([GENRES.md](GENRES.md)). It edits a **game**: a
list of levels, each a seeded village and a mission graph with hand edits on top ([PROJECT_FORMAT.md](PROJECT_FORMAT.md)).
It is not a separate tool: it runs in the studio's page, on the studio's session, renderer and runtime, and what it
plays is what an export plays.

The 2D level builder that used to sit beside it moved to its own repository, [omryv/2dgen](https://github.com/omryv/2dgen),
and shares no code with this one.

## Starting

The editor opens on its **start screen** (`editor/build/start.js`):

- **Your games**: every game saved in this browser, newest first. Open one, or delete it (the row asks first).
- **Start from a template**: five complete games, one per genre, three levels each (below), as a deck that turns:
  one card in front, its neighbours angled away and out of focus behind it, the rest round the back. The arrows, the
  dots, the arrow keys, a swipe or a click on a card behind turn it. Each card maps its levels from the same compile
  the editor uses (`editor/build/levelMap.js`); the level buttons switch the map. On a screen 900 px or wider the
  viewport beside the deck previews the card in front live, in 3D, turning slowly, and swings on round when the deck
  turns rather than cutting (a still frame under `prefers-reduced-motion`). **Use template** copies it into your
  games; **Play it** plays the level shown, then comes back.
- **Or start blank**: one level in a genre, its mission ready to play.
- **Open a game file**: a `.visigames.json` file from Export (or from Remix; a flat project opens as one level).

Games are saved as you work (`editor/build/library.js`): each has its own browser-storage entry holding the game
document, and an index lists them. The one game the editor kept before the library existed is migrated in as its
first entry. When storage is full the editor says so rather than failing silently; Export keeps a copy anywhere.

### The templates

Templates are named by their genre ("Arena shooter template"), the same words Play's genre switch and the landing hub
use, so Play, Remix and Build read as one studio. **Use template** makes a copy called "My arena shooter game" in the
title box, to rename before publishing: the title is what the exported game's start card and download are called.
Links and saved games use the ids, which keep their first names (`?mode=build&template=honey-siege`).

| Template (id) | Levels | Built by hand on top of the village |
| --- | --- | --- |
| Shooter (`hive-patrol`) | Station Run (meadow), Gatehouse (desert), The King's Yard (snow, night) | an ambush zone wired to a hunting swarm, a lever that wakes the gatehouse guard, cover and supplies, the extraction inside an amber-gated pen |
| Exploration (`lantern-survey`) | Meadow Survey, Oasis Keys, Night Lanterns | honey to find, a checkpoint, an ice-gated pen, two nested pens (the ice key behind the rose gate) and a lever |
| Action adventure (`trail-warden`) | Shrine Path, Dune Gate, Frost Warden | critter groups, the shrine moved into an amber-gated pen with its key guarded, an ambush zone, a checkpoint, the King |
| Arena shooter (`honey-siege`) | Square Siege, Dune Hold, Night Swarm | spawn ground painted at the lane ends, barrels, rocks and hay for cover, supplies |
| Collect-a-thon (`honey-harvest`) | Meadow Harvest, Oasis Honey, Frost Hunt | honey in a lever-locked pen, checkpoints, the way home behind a rose gate |

Every template level passes the live checks with no error or warning, every pen stays shut until its gate opens,
and every level is won by playing it (`tools/test/test-level-templates.mjs`). They are data
(`src/world/level/templates.js`): a creator can make any of them in the editor.

## Editing

The top bar: back to the studio, **Games** (the start screen), the game's title, genre and save state, undo and redo
(each step is named: "Undo Place barrel"), the checks, **Export** and **Play level** (its menu: play from the cursor,
play the whole game). The left panel is the **outliner** (everything in the level by group, searchable) and the
**palette** (what can be placed, with the catalogue's card pictures); the right is the **inspector**, the **checks**
and the **level** settings (its world, light, critters, cover and mission; the game's genre, difficulty and lives;
publishing). Under the view is the **level strip**: add, duplicate, reorder, rename and delete levels (up to 8).

| Tool | Key | Does |
| --- | --- | --- |
| Select | V | click, Shift-click to add, drag on empty ground to box-select |
| Move | W | drag the gizmo or the thing; snaps to the grid (Alt: free) |
| Turn | E | the ring; 15° steps (Alt: free) |
| Scale | R | props, half to twice their size |
| Place | B | click the ground to place the palette's choice; `[` `]` turn it |
| Paint | N | spawn zones, paths (clears clutter, lays packed sand) and no-go ground; `[` `]` brush size; Alt erases |
| Wire | L | drag from a lever or a trigger zone to a door or a critter group |
| Erase | X | delete; a generated thing is removed and can be restored from the inspector |

Cameras: **Orbit** (O), **Top** (T), **Fly** (Y; WASD, Q/E down and up). F frames the selection (or the level), G
toggles the grid, arrows nudge (Shift: 2 m), Ctrl/Cmd D duplicates, Delete deletes, Ctrl/Cmd Z and Shift Z undo and
redo, F5 or Ctrl/Cmd Enter plays, P plays from the cursor, Esc steps back. On a touch screen one finger does what the
tool does, two fingers pan and pinch, and a long press opens the context menu; the panels become bottom sheets under
600 px.

What can be placed (`src/world/level/entities.js`): critter groups (a kind, how many, guard or hunt), supplies,
coloured keys, honey drops, doors (hold to open, a key's colour, or wired), levers, trigger zones, checkpoints, and
props (barrels, rocks, fences, hay, houses from the house grammar, trees from the tree grammar, plants).

### Hand edits and the generator

A level is its seed and mission graph plus **edits**: the start, placed things, overrides of generated things (moved
or removed, by a stable key such as `tree@12.3,-8.1` or `step:activate:0`), painted regions and wires. Edits are
applied **after** the village is laid out: the layout sees only the generator's own inputs, so moving one barrel never
re-plans the village, and a placed thing clears the clutter round it. Change the seed, the light or the mission in
the graph, and the hand edits stay where they were; a generated thing an edit refers to that no longer exists is
reported as an orphan in the checks, with a button to drop it. Houses, landmarks, footbridges and the pool stand on
levelled ground: they can be removed, not moved. A mission's pads belong to its steps: move them freely; how many
there are is set in the graph (**Edit the mission graph** opens Remix on this level and comes back).

## Live checks

Every change recompiles the level (a few milliseconds; the village layout is cached) and checks it
(`src/world/level/checks.js`): the player start on standable, free ground; every pad, drop, key and the extraction
reachable, with doors opened as the player could (held, by a key found earlier, or by a wire from something
reachable); every locked door with a key, every key with a door, every door and critter group a wire drives, every
lever or zone driving something; things standing inside a house; critters over the desktop (22) and phone (11)
budgets and props over 160 (desktop) or 90 (phone); orphaned edits. Each issue names the thing and jumps to it.
**Reach** shades the ground the player can get to.

## Playtest

**Play level** plays the level in the view at once, from its start or from the cursor (P, or the context menu). Stop
returns to the editor with the route drawn on the ground and every fall marked. **Play the whole game** plays it as an
export does: the title card, each level in turn, the ad breaks and the rewarded continue shown as short simulated
cards (the rewarded one always pays), the ending; the portal events go to the studio's log.

## Publishing

**Export** offers the playable game (a ZIP: the runtime, every level's world and art, the game; serve it from any
static host, upload it to itch.io or a portal) or the game file. Its switches (also in the Level tab):

- **Ad break between levels**: before each next level the game awaits `VisigameHooks.adBreak('between-levels')`.
- **Rewarded continue**: after the last life, the player may watch an ad (`adBreak('rewarded')`) to carry on from the
  last checkpoint with their lives back; once per attempt at a level.
- **"Made with Visigame"** on the title card and the ending.

The exported page defines, before any of its modules:

```js
window.VisigameHooks = window.VisigameHooks || {
  adBreak: function (kind) { return Promise.resolve(false); },  // resolve when the ad is over; for 'rewarded', true if earned
  event: function (name, data) {},  // gameplayStart, gameplayStop, levelStart, levelComplete, gameOver, gameComplete
};
```

A portal's SDK replaces it (or edits it there). Each event is reported once per moment; `levelStart`,
`levelComplete` and `gameOver` carry `{ level, name }` (`levelComplete` adds `time` and `kills`), `gameComplete`
carries `{ levels, time }`. A hook that throws, rejects, or never resolves (90 s) never stops play
(`editor/gameRun.js`).

## Performance

The editor renders only while something changes (a drag, a camera ease, a fly, a few frames after an edit for the
temporal antialiasing to settle); the frame rate shows in the status bar while frames run back to back. Picking uses
simple shapes rather than meshes; overlays are a handful of draw calls. A rebuild after an edit is debounced and
**warm** (`ShooterSession.build(project, { warm: true })`): the session keeps its stage (the scene and its lights, the
sky and its probe, the fog, the post stack, the audio, the effect pools, and every material the toon kit and the
assemblers made, so no shader is compiled again) and takes down and builds only the level's own things. It also keeps
the fetched pack (the village layout cache is keyed by it) and the device profile (reading it waits on the GPU). The
stage is rebuilt only when what it was made from changes: the theme, the world's biome, the lighting, the palette,
the quality, the genre or the look. The old level's resources (and its paused game) are freed one rebuild late: three
deletes a shader program when the last thing drawn with it goes, so freeing them before the new level had been drawn,
shadows and critters included, compiled those shaders again. `node tools/test/measure-edit.mjs` holds all of this:
in headless Chromium on its software rasteriser (stand-in art), an edit to the rebuilt level drawn once in about
0.45 s, where a full rebuild took 11 to 12 s, nearly all of it shaders compiled again; no edit compiles a shader
program; over the edits the renderer's geometries and textures, the scene's objects and the light rig stay flat.
Budgets in the checks keep a level playable on a phone.

## Files

| | |
| --- | --- |
| `editor/build/app.js` | the editor: compile, check, rebuild, render on demand, playtest, the start screen's preview, export |
| `editor/build/store.js` | the game and its named undo steps, autosave |
| `editor/build/library.js` | the games saved in this browser |
| `editor/build/start.js`, `levelMap.js` | the start screen and its maps |
| `editor/build/viewport.js`, `camera.js`, `pick.js`, `overlays.js`, `panels.js` | input, cameras, picking, 3D overlays, panels |
| `editor/gameRun.js` | a game played through, and the portal hooks |
| `src/world/level/` | edits, entities, regions, applying edits, checks, games of levels, templates (three-free) |
| `src/game/LevelScript.js` | placed things at run time: doors, keys, levers, zones, drops, checkpoints, lives |

Tests: `test-level-edits`, `test-level-checks`, `test-level-store`, `test-level-library`, `test-level-script`,
`test-level-templates`, `test-game-run`, `test-game-export`.

## Limits

Up to 8 levels a game, 200 placed things and 120 wires a level, 512 KB a game file. Sculpting the terrain is not
offered: the terrain is baked from the seed, and hand-shaped ground would have to be carried through the nav-grid
bake, collision and export in lockstep (paint paths and no-go ground instead). Everything saved in a browser stays
in that browser until it is exported.
