# The project file

A project is the one document every surface exchanges: the studio saves it to
localStorage, `.visigames.json` downloads and game ZIPs carry it, a "Beat this" link
encodes it, and the runtime compiles it. `src/world/projectSchema.js` is its contract.

Since format 4 a project may be a **game**: the fields every level shares at the top, and a
list of `levels`, each with its own seed, light, mission graph, encounter and hand edits. The
level editor ([EDITOR.md](EDITOR.md)) writes games; Remix and mission links still write one
flat mission, which reads as a game of one level.

## Envelope

A file or a ZIP carries the project inside an envelope:

```json
{ "kind": "visigames.project", "version": 4, "name": "…", "genre": "action", "theme": "arcade", "…": "…",
  "settings": { "lives": 3 }, "publish": { "adBreaks": false, "rewardedContinue": false, "showCredits": true },
  "levels": [ { "id": "l1", "name": "Shrine Path", "seed": "TRLW-DN01-MEAD", "lighting": "dawn",
                "blueprint": { "…": "…" }, "enemyCount": 3, "behavior": "guard", "cover": "light",
                "objectives": 1, "missionProfile": null, "edits": { "…": "…" } } ] }
```

`kind` names the document (`vsight.project` is the launch-era name and still opens).
`version` is the **format version**, currently 4. A bare project with no envelope, which
is what localStorage and mission links hold, is read as the current format. The blueprint
inside keeps its own `version` (currently 1): it is a nested document with its own history.

`packageProject(project)` produces the envelope; `parseProjectText(text, { requireEnvelope })`
reads one. Downloads and ZIPs require the envelope; a link does not.

## Migration

`MIGRATIONS` maps a format version to the function that lifts a document one version up,
and `migrateProject` walks it from the file's version to the current one. A file from a
newer format is refused with its version named rather than opened on a guess: its fields
may mean something this build does not know, and "opens but plays differently" is the
worst outcome for a shared mission. The studio says when a file was migrated.

To change the format: bump `PROJECT_FILE_VERSION`, add the step to `MIGRATIONS`, extend
`test-project-schema` with a document of the old shape, and note the change here.

History: 1 the launch-era `vsight.project` document; 2 the `visigames.project` kind;
3 the `genre` field (see [GENRES.md](GENRES.md)), which earlier documents read as `shooter`;
4 games of levels, hand edits, game settings and publishing switches. The 3 to 4 step lifts
a flat mission into a game of one level (`liftToGame`, `src/world/level/game.js`), so every
older file opens as the mission it was.

`levelProject(game, i)` flattens level i back into the flat project the runtime compiles:
nothing below the studio learns what a level list is. `resolveGame` resolves a whole game.

## Validation

`validateProject` checks the document's **shape**: field types, budgets and the structure
of the blueprint, imported props and presentation, reporting every problem with the path
it is at (`blueprint.nodes[3].kind`, `importedProps[0].rightsConfirmed`). Unknown fields
are warnings, carried and ignored. `resolveProject` runs the shape check first, so its own
messages about **meaning** (a theme that does not exist, a weapon outside the catalogue, a
prop overlapping a route) can assume the field is at least the right kind of thing. Both
throw `ProjectFormatError`, whose `path` names the field.

Text from any source is capped at 512 KB (`MAX_PROJECT_BYTES`) before it is parsed; a
three-level template game with its hand edits is about 10 KB, a game at the editor's limits
(8 levels of 200 placed things and painted ground) stays under the cap.

Retired values still open rather than fail: `camera` `third`/`tactical` become `first` (the
engine is first-person only), `genre` `adventure`/`tactical` become `shooter`, and
the `district-v1`, `relic-v1` and `uplink-v1` mission profiles become `null`.

## Fields

| Field | Type | Meaning is checked by |
| --- | --- | --- |
| `name` | string, 64 chars | `resolveProject` |
| `genre` | string, one of `src/genres/registry.js` (format 3; absent means `shooter`) | `resolveProject` |
| `theme`, `difficulty`, `behavior`, `cover`, `weapon`, `camera`, `lighting`, `palette`, `quality` | string | `resolveProject` (enumerations) |
| `player` | string | `resolveProject` (catalogue) |
| `seed` | string | `normalizeSeed` |
| `enemyCount`, `objectives`, `frameRate` | number (a numeric string is accepted from form inputs) | `resolveProject` (ranges) |
| `missionProfile` | string or null | `resolveProject` |
| `blueprint` | `{ version: 1, nodes, edges }` | `normalizeBlueprint`, `compileBlueprint` |
| `importedProps` | array of prop records, at most 8 | `normalizeImportedProps`, `placeImportedProps` |
| `presentation` | `{ studioName, accent, artwork?, logo? }` | `normalizePresentation` |
| `settings` | `{ lives }` (1 to 9; absent means the genre's preset) | `normalizeSettings` |
| `publish` | `{ adBreaks, rewardedContinue, showCredits }` booleans | `normalizePublish` |
| `levels` | array of 1 to 8 levels (format 4), each `{ id, name }` and the level fields below | `normalizeLevelMeta`, `resolveGame` |
| `edits` (per level) | `{ version: 1, start, entities, overrides, regions, wires }` | `normalizeEdits` (`src/world/level/edits.js`) |

A level's own fields are `seed`, `lighting`, `blueprint`, `enemyCount`, `behavior`, `cover`,
`objectives`, `missionProfile` and `edits` (`LEVEL_KEYS`); everything else belongs to the game.

### Hand edits

- `start`: `{ x, z, yaw }` or null (the generator's start).
- `entities`: placed things, each `{ id, type, x, z, yaw, props, scale? }`; ids are 1 to 12
  lowercase letters and digits. Types and their props are in `src/world/level/entities.js`:
  enemy, pickup, key, collectible, door, lever, trigger, checkpoint, prop. Up to 200.
- `overrides`: generated things moved (`{ x, z, yaw? }`) or removed (`{ removed: true }`),
  keyed by what they are and where the generator put them: `step:<stepId>:<i>` (a mission pad
  or a collect step's honey drop; moved, never removed), `gate:<i>`, `cover:<i>:<±1>`,
  `dress:<i>`, `enemy:<i>` (a generated critter's spawn), `<kind>@<x>,<z>` for the village
  (`house@12.3,-8.1`, `tree@…`). Houses, landmarks, footbridges and the pool can be removed,
  not moved. A key the generator no longer makes is kept and reported as an orphan.
- `regions`: painted ground over the 80 m square at 1 m, run-length encoded (`.` none, `s`
  spawn zone, `p` path, `x` no-go), at most 12 000 characters.
- `wires`: `{ from, to }`, from a lever or a trigger zone to a door or a critter group. Up to 120.

## Untrusted content

A project from a link, a file or a ZIP is a stranger's document, and so is every imported
prop it names. The shape check and the size cap are the first line; the import dialog's
budgets (8 MB, 50k triangles, 64 MB decoded texture per prop, 12 textures at 2048 px)
are the second; and the runtime loader enforces its own, whatever the file claimed: a load
deadline and a decoded-texture budget per asset (`core/AssetLoader.js`,
`IMPORTED_PROP_DEADLINE_MS`, `IMPORTED_PROP_TEXTURE_BYTES`), with the asset named in the
error. Hosted sharing of missions will need the same budgets enforced where the file is
stored, not only where it is opened.
