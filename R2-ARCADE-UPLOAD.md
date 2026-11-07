# Arcade R2 locations

Bucket: `game-engine`
Public origin: https://pub-f1c1beced9f54323ac7db4d8f77fc346.r2.dev

Everything Arcade lives under one prefix, `assets/v2/arcade/`, and each object key is exactly the path
the engine uses. It is also the Blender kit's local output folder, so on localhost the same path is
served from the checkout (`?assets=remote` tests the R2 copies).

- Runtime models: `assets/v2/arcade/arcade-{fence,barrel,rocks,tree-oak,tree-pine,tree-sapling,ground}.glb`
- Gameplay props: `assets/v2/arcade/arcade-{shrine,gate,barricade}.glb`
- Weapons: `assets/v2/arcade/arcade-{slingshot,repeater,blunderbuss,arbalest,cannon}.glb`
- Pickups: `assets/v2/arcade/arcade-{pouch,honey,fizzbomb}.glb` (ammo, health, grenade; the fizz-bomb is also the
  thrown grenade, through the pack's `grenade` key)
- Player character: `assets/v2/arcade/characters/arcade-hero.glb` (the villager hero: 65 Mixamo bones, clips
  `Hero_{Idle,Walk,Run,Jump,Interact}` and the genre clips `Hero_{Attack,AimIdle,AimRun,Hit,Death,Cheer}` the
  third-person and top-down hero plays, and a `Grip_R` socket on the right hand for the staff)
- Gear for hand-built levels (docs/EDITOR.md): keys `assets/v2/arcade/arcade-keys.glb` (nodes `Key_{amber,ice,rose}`),
  padlocks `assets/v2/arcade/arcade-locks.glb` (nodes `Lock_{amber,ice,rose}`), the lever `arcade-lever.glb` (`Base`,
  `Handle`), the honey drop `arcade-drop.glb` and the hero's trail staff `arcade-staff.glb`, with the cards
  `assets/v2/arcade/catalog/{key,lock,lever,drop,staff}.png`
- First-person viewmodels (the hero's arms holding each weapon, 11 clips each, see docs/FP_ARMS.md), in the `fp/`
  folder: `assets/v2/arcade/fp/{slingshot,repeater,blunderbuss,arbalest,cannon}.glb`
- Weapon sounds (the pack's `sounds` slots), under their own prefix `assets/v2/arcade-sounds/`:
  `weapon-sounds/shot-arcade-mode/{slingshot,repeating-crossbow,blunderbuss,heavy-crossbow,mini-cannon}-shot-arcade-mode.mp3`
  and `weapon-sounds/reload-arcade-mode/{...}-reload-arcade-mode.mp3`
- Creature parts library (every enemy and wildlife critter is generated from it, see docs/CREATURES.md):
  `assets/v2/arcade/arcade-creature-parts.glb`
- House parts library (every village house is generated from it, see docs/HOUSES.md):
  `assets/v2/arcade/arcade-house-parts.glb`
- Nature parts library (the village layout's bushes, flowers, tufts, mushrooms, stumps, stepping stones and
  signposts, see docs/WORLD.md, and the water's bank stones, reeds, lily pads and blooms, footbridge and pool,
  see docs/TERRAIN.md): `assets/v2/arcade/arcade-nature-parts.glb`
- Desert oasis biome (see docs/BIOMES.md): the parts library `assets/v2/arcade/arcade-desert-parts.glb` (desert
  houses' parts, palm crowns and cactus caps, desert flora, the oasis well, market stalls and lookout), the props
  `assets/v2/arcade/arcade-desert-{rocks,wall,barricade}.glb` and the cards
  `assets/v2/arcade/catalog/desert-{house,tree,nature,landmark,rocks,wall,barricade}.png`, and the Environments card
  picture `assets/v2/arcade/arcade-desert-review.png`
- Snow village biome (see docs/BIOMES.md): the parts library `assets/v2/arcade/arcade-snow-parts.glb` (alpine houses'
  parts, snowy conifer tiers and bare-tree twigs, winter flora, the bell tower, the well and the winter stalls), the props
  `assets/v2/arcade/arcade-snow-{rocks,fence,barricade,barrel}.glb`, the cards
  `assets/v2/arcade/catalog/snow-{house,tree,nature,landmark,rocks,fence,barricade,barrel}.png`, and the Environments
  card and launcher picture `assets/v2/arcade/arcade-snow-review.png`
- World tile and meadow preview: `assets/v2/arcade/arcade-lookdev-review.png`
- Studio catalog cards: `assets/v2/arcade/catalog/{barrel,fence,oak,pine,rocks,sapling}.png`, the houses'
  `{house,house-cottage,house-townhouse,house-farmhouse,house-tower}.png`, the flora's `nature.png`, plus
  `{shrine,gate,barricade,slingshot,repeater,blunderbuss,arbalest,cannon}.png`, the pickups'
  `{pouch,honey,fizzbomb}.png`, the hero's `hero.png` and the creature roster's
  `{slime,shroom,bee,sprout,pebble,batpuff,hornblob,acorn,spirit,king}.png`
- Painted textures (also embedded in the GLBs): `assets/v2/arcade/textures/arcade-{grass,sand}.png`
- Look-dev extras, not referenced by the engine yet: `arcade-hero-corner.glb` (the landing page's hero shows it,
  live, on a pedestal: docs/LANDING.md), `arcade-dressing.glb`, `arcade-lookdev.blend`

No longer referenced, and safe to delete from the bucket: the earlier upload under `assets/arcade/` (no `v2`), the retired hand-made critters
`assets/v2/arcade/arcade-{slime,shroom,bee,king}.glb`, and the retired hand-made cottage
`assets/v2/arcade/arcade-cottage.glb` with its card `catalog/cottage.png`.

The exact keys, byte sizes and SHA-256 hashes are in `tools/assets/arcade-r2-upload-manifest.json`
(verified against the public origin after each upload).
The Blender sources that produce every file are `tools/blender/v2/arcade/{kit,nature,hero_corner,props,weapons,pickups,gear,hero,creature_parts,creature_preview,house_parts,house_preview,nature_parts,tree_parts,tree_preview,world_terrain,world_preview,desert_parts,desert_preview,snow_parts,snow_preview,fp_rigs,fp_clips}.py` (the viewmodels also run `tools/blender/v2/{fparms,fpanim}.py`; their source file is `assets/v2/arcade/fp/src/fp_arcade.blend`, which stays local).
Repeat the byte/CORS audit:

```sh
node tools/build/verify-r2.mjs --manifest tools/assets/arcade-r2-upload-manifest.json --origin http://127.0.0.1:8126 --report docs/reports/arcade/r2-verification.json
```
