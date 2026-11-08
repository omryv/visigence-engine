/**
 * THE MISSION WORLDS, AS DATA: the themes, their palettes and the launcher's worlds. A module of its own, with no
 * imports, so the editor's Game panel and its mission address read the looks without loading the mission compiler
 * (world/missionCard.js re-exports these).
 */
// Presentation catalog: add worlds here without changing the launcher layout.
// Gameplay modes are separate from world art and lighting.
export const MISSION_THEMES = {
  arcade: { title: 'Arcade', description: 'A bright pastel village. Chunky toon worlds for any genre.', time: 'Sunny day', lighting: 'dawn', accent: '#ff9aa6', position: '50%', focus: '50% 50%', index: 1, art: '/assets/v2/arcade/arcade-lookdev-review.png', artSize: 'cover', crop: [0, 0, 1, 1] },
};
/** The launcher and studio palette a theme opens with. */
export const THEME_PALETTE = { arcade: 'violet' };
/**
 * The launcher's worlds: each a theme and one of its environments (world/catalog.js `world`, the studio's
 * Environments), with its own card art. The meadow is the theme's own village; the desert and the snow village are
 * its biomes.
 */
export const MISSION_WORLDS = {
  arcade: { ...MISSION_THEMES.arcade, theme: 'arcade', world: null, title: 'Meadow village', description: 'A bright pastel village of cottages, blossom and a brook.' },
  desert: { theme: 'arcade', world: 'desert', title: 'Desert oasis', description: 'Plaster houses and domes, palms round the water, a striped market.', time: 'Sunny day', lighting: 'dawn', accent: '#f0b04a', position: '50%', focus: '50% 50%', index: 2, art: '/assets/v2/arcade/arcade-desert-review.png', artSize: 'cover', crop: [0, 0, 1, 1] },
  snow: { theme: 'arcade', world: 'snow', title: 'Snow village', description: 'Log cabins under thick snow, a bell tower over the square, a frozen pond.', time: 'Sunny day', lighting: 'dawn', accent: '#8cc4f2', position: '50%', focus: '50% 50%', index: 3, art: '/assets/v2/arcade/arcade-snow-review.png', artSize: 'cover', crop: [0, 0, 1, 1] },
};
