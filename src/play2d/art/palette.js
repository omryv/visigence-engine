/**
 * The Arcade toon palette, shared by every drawing in the builder so tiles, critters and
 * backdrops read as one set: flat fills in three tones (shade, base, light), a warm dark
 * outline, and a single key light from the upper left.
 *
 * Chrome stays graphite (the Visigame design system); the game art is the only thing in colour.
 */

/** The outline every sprite shares: warm near-black, never pure black. */
export const INK = '#2b1d14';
/** Outline width for a sprite drawn `size` pixels per tile. */
export const outlineWidth = size => Math.max(1, Math.round(size / 18));

/** Per-biome colours. `side` backdrops use sky/far/near; `top` floors use floor/path. */
export const BIOME_PALETTES = {
  meadow: {
    sky: ['#86cdf5', '#d9f1ff'], far: '#a6d995', near: '#7cc46b', haze: '#e8f6e0', cloud: '#ffffff', cloudShade: '#d6ebf8',
    grass: { dark: '#4f9e3b', base: '#78cf52', light: '#a7ea72' },
    soil: { dark: '#8e5a31', base: '#bd8249', light: '#d9a168', speck: '#a86d3c' },
    stone: { dark: '#7f8993', base: '#aeb6be', light: '#d6dbe0' },
    wood: { dark: '#9a5f2b', base: '#d18f4b', light: '#eeb16e' },
    ice: { dark: '#6fbde6', base: '#b7e5fb', light: '#ecfaff' },
    water: { deep: '#2f8fd0', base: '#4fb3ea', light: '#a9e3ff', foam: '#e9f8ff' },
    thorn: { dark: '#2f5b27', base: '#4d7f35', spike: '#efe8c8' },
    wall: { top: '#5cbf5c', base: '#3f9f4a', dark: '#2c7a38', light: '#86d97a' },
    floor: { base: '#86cf5f', dark: '#6cb94b', light: '#a3df76' },
    path: { base: '#e2b97f', dark: '#c79a5e', light: '#f2d3a2' },
    pit: { rim: '#6b4a2e', deep: '#1c140e' },
    foliage: { dark: '#3d8a3a', base: '#5fb14b', light: '#8fd46a' },
    trunk: { dark: '#6b4325', base: '#8e5c34' },
    flower: ['#ff7fae', '#ffd23f', '#ffffff', '#9ac7ff'],
  },
  desert: {
    sky: ['#ffc98a', '#fff0d4'], far: '#f3cf92', near: '#e9b56d', haze: '#fff3dd', cloud: '#fff9ef', cloudShade: '#f7dfc0',
    grass: { dark: '#c99a4f', base: '#f3d48f', light: '#fdeab8' },
    soil: { dark: '#a86a35', base: '#d69a58', light: '#ebbb7c', speck: '#bf8246' },
    stone: { dark: '#b0773f', base: '#dca462', light: '#f2c98d' },
    wood: { dark: '#8e5626', base: '#c7843f', light: '#e7a862' },
    ice: { dark: '#6fbde6', base: '#b7e5fb', light: '#ecfaff' },
    water: { deep: '#1e9aa6', base: '#3cc4c9', light: '#9ff0ea', foam: '#e6fffb' },
    thorn: { dark: '#4f6b2a', base: '#7b9a3b', spike: '#fff4d2' },
    wall: { top: '#f0c27e', base: '#d49a55', dark: '#aa6f36', light: '#fbd9a0' },
    floor: { base: '#f0d08f', dark: '#dfb873', light: '#fae4b3' },
    path: { base: '#d88c5a', dark: '#b86c3e', light: '#eeae7f' },
    pit: { rim: '#8a5a2e', deep: '#24170c' },
    foliage: { dark: '#3f8a4a', base: '#63b35a', light: '#94d67a' },
    trunk: { dark: '#7a5230', base: '#a8763f' },
    flower: ['#ff8a5c', '#ffd23f', '#ff5fa2', '#fff2c2'],
  },
  snow: {
    sky: ['#a9cdee', '#eef6fd'], far: '#dce9f5', near: '#c3d8ec', haze: '#f4f9ff', cloud: '#ffffff', cloudShade: '#dbe7f2',
    grass: { dark: '#c9dbea', base: '#f4f9ff', light: '#ffffff' },
    soil: { dark: '#5f6b7a', base: '#8793a3', light: '#a9b4c2', speck: '#76828f' },
    stone: { dark: '#7d8fa3', base: '#a9bacb', light: '#d3dfeb' },
    wood: { dark: '#7a4d2a', base: '#a86e3e', light: '#cf945e' },
    ice: { dark: '#5fb2e0', base: '#aee0fb', light: '#ecfaff' },
    water: { deep: '#3a86c2', base: '#6fb8e6', light: '#c4ecff', foam: '#ffffff' },
    thorn: { dark: '#35584a', base: '#4f7d66', spike: '#f4fbff' },
    wall: { top: '#f7fbff', base: '#c7d9ea', dark: '#93adc6', light: '#ffffff' },
    floor: { base: '#eaf2fa', dark: '#d4e2ef', light: '#ffffff' },
    path: { base: '#b9c6d3', dark: '#98a7b7', light: '#d7e0ea' },
    pit: { rim: '#6c7f94', deep: '#141c26' },
    foliage: { dark: '#2f6b55', base: '#3f8a6a', light: '#6fb592' },
    trunk: { dark: '#5b3d25', base: '#7d5634' },
    flower: ['#9ac7ff', '#ffffff', '#c7b3ff', '#ffd6e8'],
  },
};

/** Time-of-day grading: a colour laid over the scene with `alpha`, and a sky override. */
export const TIME_GRADES = {
  day: null,
  golden: { tint: '#ff9a4a', alpha: 0.18, sky: ['#ffb277', '#ffe6c2'] },
  night: { tint: '#1a2352', alpha: 0.5, sky: ['#0f1633', '#2c3a6b'], stars: true },
};

/** Character and item colours (biome independent, so a slime is a slime everywhere). */
export const SPRITE = {
  hero: { skin: '#ffd7b0', skinShade: '#eab58c', hair: '#6b3f24', hairLight: '#8e5733', scarf: '#ff9f45', scarfShade: '#d9772a', tunic: '#3e8ed0', tunicShade: '#2d6aa3', pants: '#3a3f5c', boots: '#6b4a2e', eye: '#2b1d14', cheek: '#ff9c8a' },
  slime: { green: ['#4aa83a', '#7bdc5a', '#d4ffc0'], pink: ['#d9578f', '#ff8fbd', '#ffe0ee'], blue: ['#3f8fd6', '#7ec8ff', '#e0f3ff'] },
  bee: { body: '#ffd23f', bodyShade: '#e6a92a', stripe: '#2b1d14', wing: 'rgba(233, 247, 255, 0.85)', wingEdge: '#9fd2ee' },
  burr: { body: '#a8683a', spine: '#6b3f1f', spineLight: '#c98c55', face: '#f2c79a', nose: '#2b1d14' },
  acorn: { cap: '#7d5128', capLight: '#a5703d', nut: '#c98b4a', nutShade: '#a56a32', barrel: '#4a3b33' },
  spirit: { body: 'rgba(244, 247, 255, 0.9)', glow: 'rgba(159, 216, 255, 0.55)', eye: '#3a4a7a' },
  king: { crown: '#ffcf3f', crownShade: '#e0a526', jewel: '#ff4f6a' },
  honey: { base: '#ffb72b', shade: '#e08a12', light: '#ffe38a' },
  jar: { glass: 'rgba(255, 244, 214, 0.9)', honey: '#ffae2b', honeyShade: '#e08312', lid: '#e0584a', lidShade: '#b73d33', string: '#f4e3c0' },
  heart: { base: '#ff5a6e', shade: '#d63a52', light: '#ffb3bf' },
  keys: { amber: ['#d98a1e', '#ffb23f', '#ffe08a'], ice: ['#3fa6d9', '#7fd6ff', '#d9f5ff'], rose: ['#d9467f', '#ff7fae', '#ffd1e3'], none: ['#7f8993', '#aeb6be', '#d6dbe0'] },
  shrine: { stone: '#aeb6be', stoneShade: '#7f8993', crystal: '#8ff0ff', crystalShade: '#3fc2e0', glow: 'rgba(143, 240, 255, 0.45)' },
  lantern: { frame: '#4a3b33', glassOff: '#6d7178', glassOn: '#ffd26b', glow: 'rgba(255, 196, 92, 0.45)' },
  mushroom: { cap: '#ff5a4f', capShade: '#d63a35', dot: '#fff4e6', stem: '#f6e6cc' },
  crate: { base: '#c98b4a', shade: '#9a6230', light: '#e8b47a', band: '#7a4a22' },
  chest: { base: '#b8733a', shade: '#8a5226', band: '#ffcf3f', bandShade: '#d9a526' },
  warp: { petal: '#b98cff', petalShade: '#8a5fe0', core: '#ffe98a', swirl: '#f3e9ff' },
  burrow: { mound: '#8e5a31', moundLight: '#bd8249', hole: '#1c140e' },
  power: { core: '#fff2fb', glow: 'rgba(255, 170, 230, 0.6)' },
  fizz: { wings: '#ffe98a', rapid: '#ff7a5c', spread: '#72d6ff', shield: '#9df5c8', glass: 'rgba(240, 250, 255, 0.85)' },
  shot: { player: '#ffcf6b', enemy: '#8e5a31', glow: 'rgba(255, 207, 107, 0.5)' },
};

/** Hex for a key/lock colour id. */
export const keyHex = id => (SPRITE.keys[id] || SPRITE.keys.amber)[1];

/** Mix two hex colours (t = 0 gives a, 1 gives b). */
export function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
  const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
  const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
}

/**
 * Flat colours for maps (the editor's minimap and level thumbnails): the level's background, and
 * one colour per terrain code, both from the biome's palette.
 */
export function mapBackground(biome, view) {
  const p = BIOME_PALETTES[biome] || BIOME_PALETTES.meadow;
  return view === 'side' ? p.sky[0] : p.floor.base;
}
export function mapColor(code, biome, view) {
  const p = BIOME_PALETTES[biome] || BIOME_PALETTES.meadow;
  switch (code) {
    case 8: case 22: return p.water.base;
    case 6: return '#d9577a';
    case 3: case 23: return p.wood.base;
    case 7: return p.trunk.base;
    case 21: case 27: return p.path.base;
    case 25: case 4: return p.ice.base;
    case 26: return p.pit.deep;
    case 24: case 29: return p.foliage.dark;
    case 9: return SPRITE.keys.amber[1];
    case 10: return SPRITE.keys.ice[1];
    case 2: case 5: return p.stone.base;
    case 28: return p.wood.dark;
    default: return view === 'side' ? p.soil.base : p.wall.dark;
  }
}
