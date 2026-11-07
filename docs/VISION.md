# Visions: a game from the words a player types

> **In this engine.** The landing page whose bee asks the question below stayed in the archived repository
> (omryv/Visigenesis, `apps/games3d/landing/`). The arrival half is here: a link with `?vision=` still builds the
> vision and opens the canvas on it (`editor/visionArrival.js`). Its end frame is art on R2, as before.

The landing page's bee asks **"What is your vision?"**. Whatever the player types ("a snowy fort where bees guard the
honey", or "מבצר מושלג שבו דבורים שומרות על הדבש") travels to the studio as `?vision=`, and the studio opens the
canvas on a game built from those words. No AI service is involved: the words are looked up in a list, the rules
below turn them into a project, and the same sentence always builds the same game.

## The word list

`src/world/visionLexicon.json` holds every word the reader understands, in English and Hebrew. Each entry maps words
and short phrases to one project choice:

| Entry kind | What the words choose | Examples |
| --- | --- | --- |
| `world.*` | a world option (the seed picks one per level if several are named) | snowy, frozen, שלג · desert, oasis, מדבר · village, farm, כפר |
| `enemy.*` | a critter in the enemy pool | bees, honey, דבורים · slime · ghost, רוח · king, מלך (also a boss step) |
| `weapon.*` | a weapon in the pool; the first named is the starting weapon | slingshot · crossbow, קשת · cannon, תותח |
| `objective.*` | a mission step, in the order the words appear | shrine → activate · gate → override · guard, defend → waves · fort, castle → barricade · find → reach · escape → extract |
| `genre.*` | shooter or exploration | peaceful, explore, בלי נשק → exploration · gun, combat → shooter |
| `difficulty.*`, `lighting.*`, `behavior.*`, `count.*` | difficulty, day or golden hour, critters that hunt, many or few | hard, קשה · sunny, יום · chased · swarm, נחיל |

To add a word, add it to an entry's list for its language; a word may appear in only one entry (`test-vision`
checks this, and that every entry names something the catalogue has). A new entry needs English and Hebrew words.

## Reading rules

`readVision(text, lexicon)` in `src/world/vision.js`:

- **Words.** Text is cut into words (letters, digits, apostrophes; Hebrew geresh counts as an apostrophe), lower-cased,
  with Hebrew final letters folded. Phrases ("king slime", "no weapons", "נווה מדבר") are matched before single
  words, and each word is used once.
- **Forms.** English plurals and endings are tried (bees → bee, shrines → shrine, chased → chase, snowy → snow).
  Hebrew tries up to two one-letter prefixes (ו ה ב ל מ ש כ: "והדבורים" → "דבורים", "בשלג" → "שלג") and the plural
  endings ים/ות.
- **Counts.** A number word or digit right before a step sets how many ("three shrines", "4 crystals",
  "שני מקדשים").
- **Genre.** Calm words make an exploration route with only hand-and-foot steps (reach, activate, override,
  extract). Naming a weapon together with a fight overrides a calm word.
- **The mission.** Steps run in the order they were typed, at most four, and extraction always ends it. With no
  step named, the village's shrines come first. A boss step brings King Slime; combat steps bring the first three
  critters if none were named. Counts stay inside the compiler's interaction budget.
- **Name and seed.** The project is named with the sentence itself (cut to 64 characters), and its seed is a hash
  of the words, so a shared sentence rebuilds the same village.

The result is an ordinary project: `resolveProject` accepts it, and `compileBlueprint` accepts its blueprint under the
genre's rules. `test-vision` builds every pair of entries in both languages to keep it that way.

## In the studio

`editor/visionArrival.js` runs when the page opens with `?vision=`:

1. The last frame of the landing's dive (`assets/v2/landing/transition-end.jpg`, warm bokeh) covers the screen.
2. The vision is read, the studio switches to the canvas (Remix) and applies the project. **Undo** returns to the
   project that was open before. `?vision=` is removed from the address, so a reload keeps the player's edits.
3. The bokeh defocuses away while the blueprint assembles in order (pools, generator, steps, output), then the wires.
4. A **Your vision** strip above the canvas shows the sentence with every understood word underlined in tungsten.
   Each word lights up as its node arrives, and hovering or focusing it highlights that node. Words the reader did
   not know are listed so they can be added to the word list.

With reduced motion the transition and the assembly are skipped; everything else is the same.

## The transition

The dive is rendered in Blender from the landing's own scene (`assets/v2/landing/src/visigame-landing.blend`,
camera `VG_DiveCam`, 36 frames at 24 fps, EEVEE with motion blur, encoded to H.264 by Blender). It starts on the
landing's camera, pushes through the village to the cottage's door lantern, and ends with the focus at one metre
so the lantern and the floating embers become bokeh while the exposure sinks. The landing plays it full-screen when
the player takes their vision to the studio, then goes there in the same tab; the studio opens on its last frame.
