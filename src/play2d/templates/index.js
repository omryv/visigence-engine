/**
 * The template games the gallery offers: five complete, playable games, one per genre, each a
 * starting point a game developer can remix. `build()` returns a fresh, normalised project (a
 * new id unless one is given, so a remix never overwrites another save). Templates are named by
 * their genre, as the 3D studio's are; `build({ copy: true })` is someone's own copy, titled
 * "My platformer game" until they name it.
 *
 * `blankProject(genre)` is the empty-but-playable starting frame for a new game of a genre.
 */
import { normalizeProject, createProject, newId, FORMAT_KIND, FORMAT_VERSION } from '../core/format.js';
import { genreById } from '../core/catalog.js';
import { fromAscii } from './ascii.js';
import { honeyHeistLevels } from './honey-heist.js';
import { meadowQuestLevels } from './meadow-quest.js';
import { slimeSiegeLevels } from './slime-siege.js';
import { hiveRunLevels } from './hive-run.js';
import { crateGardenLevels } from './crate-garden.js';

const make = (meta, levels) => (opts = {}) => normalizeProject({
  kind: FORMAT_KIND, version: FORMAT_VERSION,
  id: opts.id || newId('g'),
  title: opts.copy ? copyTitle(meta.genre) : meta.name, studio: '', description: meta.description, accent: meta.accent,
  genre: meta.genre, template: meta.id,
  settings: { lives: meta.lives ?? 3, hearts: meta.hearts ?? 3, difficulty: 'normal', music: true, sound: true },
  publish: { adBreaks: false, rewardedContinue: false, showCredits: true },
  levels: levels(),
});

const META = [
  {
    id: 'honey-heist', genre: 'platformer', name: 'Platformer template', biome: 'meadow', accent: '#ff9f45',
    tagline: 'Run, jump and stomp through three biomes to King Slime.',
    description: 'Run the meadow, hop the dunes, climb the frost peak. Springs, levers, crumbling bridges and a king at the top.',
    levels: honeyHeistLevels,
  },
  {
    id: 'meadow-quest', genre: 'adventure', name: 'Adventure template', biome: 'meadow', accent: '#5ad8c4',
    tagline: 'Explore a village: talk, unlock, push, warp.',
    description: 'Villagers with something to say, chests and keys, a ruin to search and a village to cross by lantern light.',
    levels: meadowQuestLevels, lives: 3, hearts: 4,
  },
  {
    id: 'slime-siege', genre: 'arena', name: 'Arena shooter template', biome: 'meadow', accent: '#ff6257',
    tagline: 'Twin-stick waves in walled arenas.',
    description: 'Hold the field against burrow after burrow, survive the sandstone pit, then break King Slime.',
    levels: slimeSiegeLevels, lives: 3, hearts: 5,
  },
  {
    id: 'hive-run', genre: 'maze', name: 'Arcade maze template', biome: 'meadow', accent: '#ffcf3f',
    tagline: 'Eat the pollen, dodge the bees, turn the tables.',
    description: 'Three hives, four bee temperaments, royal jelly in the corners. Clear every dot to move on.',
    levels: hiveRunLevels, lives: 3, hearts: 1,
  },
  {
    id: 'crate-garden', genre: 'puzzle', name: 'Block puzzle template', biome: 'meadow', accent: '#72d6ff',
    tagline: 'Push every crate onto a pad. Every level is proven solvable.',
    description: 'Crates, pads, pits, ice and gates. Each puzzle has a par set by the solver: beat it for the third star.',
    levels: crateGardenLevels, lives: 0, hearts: 1,
  },
];

export const TEMPLATES = META.map(m => ({
  id: m.id, genre: m.genre, name: m.name, tagline: m.tagline, description: m.description, biome: m.biome, accent: m.accent,
  levels: 3,
  build: make(m, m.levels),
}));

export const templateById = id => TEMPLATES.find(t => t.id === id) || null;
/** What a copy of a genre's template is called until its maker names it. */
export const copyTitle = genre => `My ${(genreById(genre)?.name || 'arcade').toLowerCase()} game`;

// ---------------------------------------------------------------------------------------------
// Blank starting frames: small, playable, and obviously meant to be painted over.

const BLANK = {
  platformer: () => fromAscii('platformer', {
    id: 'blank', name: 'Level 1', biome: 'meadow', rules: { win: 'goal' },
    map: [
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '...........................ooo..................',
      '................................................',
      '..........................=====.................',
      '.P......................................G.......',
      '####################....########################',
      '####################....########################',
      '####################....########################',
      '####################....########################',
    ],
    decor: [
      '................................................',
      '................................................',
      '.....q........................q.................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
      '....t....f...g.......................f..u.......',
      '................................................',
      '................................................',
      '................................................',
      '................................................',
    ],
  }),
  adventure: () => fromAscii('adventure', {
    id: 'blank', name: 'Level 1', biome: 'meadow', rules: { win: 'goal' },
    map: [
      '##############################',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#.P------------------------G.#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '#............................#',
      '##############################',
    ],
  }),
  arena: () => fromAscii('arena', {
    id: 'blank', name: 'Level 1', biome: 'meadow', rules: { win: 'waves' },
    legend: { Z: { entity: 'spawner', props: { enemy: 'slime', waves: 2, perWave: 3 } } },
    map: [
      '##########################',
      '#........................#',
      '#..Z..................Z..#',
      '#........................#',
      '#........................#',
      '#........................#',
      '#........................#',
      '#........................#',
      '#............P...........#',
      '#........................#',
      '#........................#',
      '##########################',
    ],
  }),
  maze: () => fromAscii('maze', {
    id: 'blank', name: 'Level 1', biome: 'meadow', rules: { win: 'dots' },
    legend: { 1: { entity: 'bee', props: { temper: 'hunter' } }, 2: { entity: 'bee', props: { temper: 'ambusher' } }, j: { entity: 'power' } },
    map: [
      '###################',
      '#j.......#.......j#',
      '#.##.###.#.###.##.#',
      '#.................#',
      '#.##.#.##g##.#.##.#',
      '#....#.#1-2#.#....#',
      '####.#.#####.#.####',
      '#........P........#',
      '#.##.###.#.###.##.#',
      '#j.......#.......j#',
      '###################',
    ],
  }),
  puzzle: () => fromAscii('puzzle', {
    id: 'blank', name: 'Level 1', biome: 'meadow', rules: { win: 'crates' },
    map: [
      '#########',
      '#P......#',
      '#..C.._.#',
      '#.......#',
      '#..C.._.#',
      '#.......#',
      '#########',
    ],
  }),
};

export function blankProject(genre, opts = {}) {
  const base = createProject(genre, opts);
  const level = (BLANK[genre] || BLANK.platformer)();
  level.id = newId('l');
  level.entities.forEach((e, i) => { e.id = `${level.id}-${e.type}-${i}`; });
  return normalizeProject({ ...base, kind: FORMAT_KIND, version: FORMAT_VERSION, levels: [level] });
}
