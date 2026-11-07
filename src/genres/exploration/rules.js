/** Exploration: weapon-free input; the interaction hold is the only hand action. */
export const explorationRules = {
  id: 'exploration',
  pointerLock: true,
  view: () => 'first',
  createSystems: () => ({}),
  /** Fire, aim and reload mean nothing here; the interaction hold is the only hand action. */
  input: (session, input) => ({ ...input, fire: false, ads: false, reload: false, grenade: false, weapon: null }),
};
