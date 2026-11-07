import { AUDIO_ASSETS } from './audio.js';

// Only supplied files enter the default bank. Future packs can override semantic IDs
// with { file, gain, bus, spatial, ... }; gameplay never depends on a filename.
const ids = ['uiEsc','uiClick','steps','jump','weapon1Fire','weapon1Reload',
  'rpgFire','rpgImpact','rpgReload','weaponSwitch','pistolFire','pistolReload',
  'shotgunFire','shotgunReload','sniperFire','sniperReload','computerLoading',
  'computerActivated','doorOpened','doorUnavailable','grenadeExploded'];
export const DEFAULT_SOUNDS = Object.fromEntries(ids.map(id => [id, {
  ...AUDIO_ASSETS[id], file: `assets/audio/default/${AUDIO_ASSETS[id].file}`,
}]));
DEFAULT_SOUNDS.land = {...DEFAULT_SOUNDS.steps, loop:false, offset:.09, duration:.30};
export const SOUND_ALIASES = {
  shotSmg: 'weapon1Fire', shotPistol: 'pistolFire', shotShotgun: 'shotgunFire',
  shotSniper: 'sniperFire', shotRpg: 'rpgFire', explosion: 'grenadeExploded',
  doorOpen: 'doorOpened', consoleStart: 'computerLoading',
  objectiveComplete: 'computerActivated', pickup: 'uiClick',
};
