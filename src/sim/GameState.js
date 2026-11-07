/**
 * Explicit game states with guarded transitions.
 *
 * The point of routing every change through here is leak prevention: input, audio and
 * simulation each ask `isPlaying` / `wantsPointerLock` rather than tracking their own
 * flags, so a pause during combat cannot leave the weapon firing or the audio running.
 */

export const State = {
  BOOT: 'BOOT',
  LOADING: 'LOADING',
  TITLE: 'TITLE',
  PLAYING: 'PLAYING',
  PAUSED: 'PAUSED',
  PLAYER_DEAD: 'PLAYER_DEAD',
  VICTORY: 'VICTORY',
  ERROR: 'ERROR',
};

/** from -> allowed destinations */
const ALLOWED = {
  [State.BOOT]: [State.LOADING, State.ERROR],
  [State.LOADING]: [State.TITLE, State.ERROR],
  [State.TITLE]: [State.PLAYING, State.ERROR],
  [State.PLAYING]: [State.PAUSED, State.PLAYER_DEAD, State.VICTORY, State.TITLE, State.ERROR],
  [State.PAUSED]: [State.PLAYING, State.TITLE, State.ERROR],
  [State.PLAYER_DEAD]: [State.PLAYING, State.TITLE, State.ERROR],
  [State.VICTORY]: [State.PLAYING, State.TITLE, State.ERROR],
  [State.ERROR]: [],
};

export class GameState {
  constructor(onChange) {
    this.current = State.BOOT;
    this.previous = null;
    this.timeInState = 0;
    this.onChange = onChange;
  }

  can(next) { return ALLOWED[this.current]?.includes(next) ?? false; }

  set(next, payload) {
    if (next === this.current) return false;
    if (!this.can(next)) {
      console.warn(`[GameState] refused ${this.current} -> ${next}`);
      return false;
    }
    this.previous = this.current;
    this.current = next;
    this.timeInState = 0;
    this.onChange?.(next, this.previous, payload);
    return true;
  }

  update(dt) { this.timeInState += dt; }

  /** The simulation only advances in this state. */
  get isPlaying() { return this.current === State.PLAYING; }
  get isTerminal() { return this.current === State.PLAYER_DEAD || this.current === State.VICTORY; }
}
