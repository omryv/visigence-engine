# Manual generation and first-person visibility

The editor now starts new projects with zero nodes and zero connections. Existing saved
projects still open as drafts. Add a generator, output, asset pools and mission steps,
select assets, and connect the ports yourself. No objective is automatically inserted
into a mission chain. Generate / Compile is enabled when the connected graph is valid.

Changing options, assets, connections, title, positions, undo/redo or importing a project
never loads a world. Renderer initialization is lazy until Generate. One explicit build
uses one snapshot; edits during it stay pending and repeated clicks cannot queue more
builds. Closing play stops the render loop. The last generated world remains cached,
with a pending-changes label until the next Generate; this is not a claim that all GPU
memory is released while editing. A viewport resize can repaint that one paused frame.
Standalone exported games still initialize their packaged mission; switching perspective
there updates the camera without rebuilding or resetting the mission.

## First-person obstruction

Observed in the previous build: `WeaponController` stores the mount Group as `Weapon.rig`
and the full animation/hand descriptor as `Weapon.build`. `ShooterSession.frame` replaced
its descriptor with `active.rig` after the first frame. The `authored` property was then
absent, which enabled fallback character arms in addition to the weapon's authored hands.
The large polygonal foreground shapes were those duplicate body arms.

`ShooterSession._syncWeaponVisual` now uses `active.build` and retains the full descriptor
through weapon switches. Runtime diagnostics now report `authored: true`, `body: false`,
`arms: false`; the view-model contains the weapon assembly's hands only. Static weapons
retain their fallback arms.

Blender Bridge was used to inspect the hand meshes and try a sleeve reshaping hypothesis.
Mesh isolation disproved that explanation for the large obstruction. The experimental
asset edits were discarded: this change modifies no model or animation files. The prior
rendering review's attribution of those shapes to a remaining sleeve-art limitation is
superseded by this runtime diagnosis.

## Additional generator fix

A world-pool selection drew a random number inside each `find()` comparison, so a pool
with several assets could fail to match any world and crash on `worldKit.ceiling`.
Selection now draws one ID before lookup, including building models. Tests cover all
three categories with complete world pools over 40 seeds each. Corrected multi-option
selection can change layouts from the buggy implementation; fixed graph/seed inputs
remain deterministic within this version.

## Validation

- 22 CPU suites pass, including real editor event routing with counted renderer/build
  boundaries, edits during a delayed build, duplicate Generate clicks, pending/invalid
  graph behavior, empty startup and unconnected node creation, and standalone loading.
- First-person visibility regression checks cover authored → static → authored switches.
- Browser: created and connected a five-node game from an empty board, generated it,
  closed play, and verified a changed perspective remained pending until Generate.
- Browser captures exercise hip fire and the sidearm reload.
  [Before](https://github.com/omryv/shooter-engine/blob/873fff9e546a8f62843d29d2b24ec6cd749e984a/assets/review/evidence/manual-generation/forearms-before.jpg) and
  [after](https://github.com/omryv/shooter-engine/blob/873fff9e546a8f62843d29d2b24ec6cd749e984a/assets/review/evidence/manual-generation/forearms-after.jpg) illustrate the removed body arms;
  browser dimensions differ, so these are not pixel-matched measurements. The
  [after diagnostic record](../docs/reports/evidence/manual-generation/forearms-after.json) records its
  actual buffer, backend, settings and visibility. No heap or FPS reduction is claimed.
- All three ZIPs pass independent integrity, assets and runtime-import checks. Static
  Vercel build and source import checks pass.
