/**
 * Crate Garden: three block puzzles, each proven solvable by the builder's solver, with par set
 * to the fewest moves it found.
 *
 *   1 First push     two crates, two pads: learn to push and not to wedge
 *   2 Pit and slide  a pit swallows a crate to open the way; an ice lane slides a crate home
 *   3 Two gates      a crate on the plate holds a gate open; the amber key opens the other
 */
import { fromAscii } from './ascii.js';

export function crateGardenLevels() {
  return [
    fromAscii('puzzle', {
      id: 'cg-first-push', name: 'First push', biome: 'meadow', rules: { win: 'crates', par: 11 },
      map: [
        '########',
        '#P.....#',
        '#.C.#..#',
        '#..C._.#',
        '##._...#',
        '########',
      ],
    }),
    fromAscii('puzzle', {
      id: 'cg-pit-and-slide', name: 'Pit and slide', biome: 'desert', rules: { win: 'crates', par: 30 },
      map: [
        '##########',
        '#P..#....#',
        '#.C.O._..#',
        '#...#....#',
        '#.C.iii._#',
        '#...###..#',
        '#..C.....#',
        '##########',
      ],
    }),
    fromAscii('puzzle', {
      id: 'cg-two-gates', name: 'Two gates', biome: 'snow', rules: { win: 'crates', par: 35 },
      legend: {
        p: { entity: 'plate', tag: 'plate' },
        D: { entity: 'door', props: { lock: 'none', stayOpen: false }, tag: 'gate' },
        R: { entity: 'door', props: { lock: 'amber' } },
      },
      links: [['plate', 'gate']],
      map: [
        '###########',
        '#P..#..R._#',
        '#.C.D.....#',
        '#...#..C..#',
        '##p##.....#',
        '#...#.###.#',
        '#.C.....#.#',
        '#..k..._..#',
        '###########',
      ],
    }),
  ];
}
