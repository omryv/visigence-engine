/**
 * Something the player can use by looking at it and holding INTERACT.
 *
 * The InteractionSystem finds the target; an Interactable only has to say whether it can
 * be used, what the prompt reads, and what happens while the hold runs. Progress is the
 * interactable's own business (a door override is a 2.2 s hold, a station a 3.4 s one),
 * which is what keeps the mission logic out of the interaction system.
 *
 * `anchor` is where the player is meant to stand/aim - the point the centre ray is tested
 * against - and `blockerId` names the collider the line-of-sight test must ignore (a
 * prop's own body would otherwise occlude the sight line to itself).
 */

export class Interactable {
  /**
   * @param {object} def
   * @param {string} def.id
   * @param {{x:number,y?:number,z:number}} def.anchor    world position at base of use column
   * @param {number} [def.height=1.4]          height of the use column, metres
   * @param {number} [def.radius=0.8]          how far off the anchor the ray may pass
   * @param {number} [def.maxDistance]         overrides INTERACTION.maxDistance
   * @param {string|null} [def.blockerId]      collider to ignore for line of sight
   */
  constructor({ id, anchor, height = 1.4, radius = 0.8, maxDistance = null, blockerId = null, focusPriority = 0 }) {
    this.id = id;
    this.anchor = anchor;
    this.height = height;
    this.radius = radius;
    this.maxDistance = maxDistance;
    this.blockerId = blockerId;
    // A small item on a larger usable surface wins a direct aim hit on both.
    this.focusPriority = Math.max(0,Math.min(.5,focusPriority));
  }

  /** Whether this can be used right now (state-dependent: a door that is already open cannot). */
  canInteract(player) { return true; }   // eslint-disable-line no-unused-vars

  /** @returns {{key:string,label:string,progress:number,sub?:string}|null} */
  getPrompt(player) { return null; }     // eslint-disable-line no-unused-vars

  /**
   * Advance the hold by `dt`. Called on every fixed step the player is holding INTERACT
   * with this as the target. Return true when the use completes.
   */
  interact(player, dt) { return false; } // eslint-disable-line no-unused-vars

  /** The hold was released or the target lost. */
  cancel(player) {}                      // eslint-disable-line no-unused-vars

  /** Called every fixed step this is NOT being used (progress bleed-off lives here). */
  idle(dt) {}                            // eslint-disable-line no-unused-vars
}
