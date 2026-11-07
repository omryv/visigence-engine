import { OBJECTIVE, INTERACTION, HUD_TEXT, PLAYER } from '../config/gameplay.js';
import { Interactable } from '../interaction/Interactable.js';
import { ExtractionGuidance } from '../sim/ExtractionGuidance.js';

class ControlStation extends Interactable {
  constructor(record, placementIndex) {
    super({ id: `objective:${record.objectiveIndex}`,
      anchor: { x: record.x, y: record.y, z: record.z },
      height: record.height, radius: record.radius,
      maxDistance: OBJECTIVE.interactRange, blockerId: `prop:${placementIndex}:${record.id}` });
    this.reset();
  }
  reset() { this.progress = 0; this.complete = false; }
  canInteract(player) { return player.alive && !this.complete; }
  getPrompt() { return { key: 'E', label: HUD_TEXT.promptInteract, progress: this.progress }; }
  interact(player, dt) {
    if (!this.canInteract(player)) return false;
    this.progress = Math.min(1, this.progress + dt / OBJECTIVE.activationTime);
    this.complete = this.progress >= 1 - 1e-9;
    if (this.complete) this.progress = 1;
    return this.complete;
  }
  idle(dt) {
    if (!this.complete) this.progress = Math.max(0, this.progress - INTERACTION.cancelDecay * dt);
  }
}

/**
 * First procedural mission: activate placed stations, then return to the spawn to
 * extract. This does not invent campaign waves from OBJECTIVE.wavesToSurvive;
 * authored encounter/wave specifications remain a separate compiler stage.
 */
export class ObjectiveSystem {
  constructor({ level, interactions, collision }) {
    this.interactions = interactions;
    this.stations = (level.placements ?? []).flatMap((p, index) => p.objectiveIndex === undefined
      ? [] : [interactions.register(new ControlStation(p, index))]);
    this.extraction = { ...level.spawn.position };
    this.guidance = new ExtractionGuidance(collision, PLAYER.radius);
    this.reset();
  }

  reset() {
    for (const station of this.stations) station.reset();
    this.phase = this.stations.length ? 'ACTIVATE' : 'SANDBOX';
    this.delay = 0;
    this.complete = false;
    this.guidance.reset();
    this.route = null;
  }

  fixedUpdate(dt, game) {
    if (this.phase === 'SANDBOX' || this.complete) return;
    if (this.phase === 'ACTIVATE' && this.stations.every(s => s.complete)) {
      this.phase = 'UNLOCKING';
      this.delay = OBJECTIVE.extractionDelay;
    } else if (this.phase === 'UNLOCKING') {
      this.delay = Math.max(0, this.delay - dt);
      if (this.delay <= 1e-9) this.phase = 'EXTRACT';
    }
    if (this.phase === 'EXTRACT') {
      this.route = this.guidance.update(dt, game.player, this.extraction);
      const p = game.player.position, target = this.extraction;
      if (game.player.alive && Math.hypot(p.x - target.x, p.z - target.z) <= OBJECTIVE.extractionRadius
        && Math.abs(p.y - game.terrain.heightAt(target.x, target.z)) <= game.terrain.stepDown) {
        this.complete = true;
        this.phase = 'COMPLETE';
      }
    }
  }

  get hudState() {
    return { phase: this.phase, completed: this.stations.filter(s => s.complete).length,
      total: this.stations.length, extraction: this.extraction,
      label: this.phase === 'ACTIVATE' ? HUD_TEXT.objectiveActivate
        : this.phase === 'SANDBOX' ? '' : HUD_TEXT.objectiveExtract,
      route: this.route ? { ...this.route } : null };
  }

  dispose() { for (const station of this.stations) this.interactions.unregister(station.id); }
}
