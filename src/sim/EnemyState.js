/**
 * The enemy behaviour states, in their own module so that both the simulation
 * (src/game/EnemySystem.js) and the animation layer (src/anim/) can name
 * them without either one importing the other.
 *
 * The animator READS these and never writes them: what the body is doing is decided by the
 * fixed-step simulation, and the animator's only job is to make that decision legible. In
 * particular the damage window belongs to EnemySystem - an attack's timing is gameplay, and
 * an animation must never be able to change when a hit lands.
 */
export const EnemyState = {
  IDLE: 'IDLE',
  CHASE: 'CHASE',
  ATTACK_WINDUP: 'ATTACK_WINDUP',
  ATTACK_ACTIVE: 'ATTACK_ACTIVE',
  ATTACK_RECOVER: 'ATTACK_RECOVER',
  STAGGER: 'STAGGER',
  DEAD: 'DEAD',
};
