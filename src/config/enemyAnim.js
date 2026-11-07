/**
 * Tuning for the enemy bodies in src/anim: the whole-body motion of the rigid (unskinned)
 * enemies in RigidBody.js, and the character of a synthesised walk and run cycle.
 *
 * GAMEPLAY numbers - speeds, reach, windup, damage - stay in gameplay.js and are this file's
 * INPUT, never its output. Nothing here may change how far an enemy can reach or when its
 * damage window opens. What this file holds is the CHARACTER of the motion.
 *
 * Angles are RADIANS. Rates are per second. Distances are metres.
 */

export const ANIM = {
  /**
   * THE TWO CYCLES. What is here is the CHARACTER of a synthesised walk and run; what is not
   * here, and cannot be, is how fast they carry the body - that is set by how much horizontal
   * reach a model's shortest leg has left, which is measured off the body.
   *
   * `reach` is the fraction of that available step the cycle uses, and it is the one number
   * that really separates a walk from a run: everything else follows from taking a longer step
   * in a shorter time with less of it spent on the ground.
   */
  gait: {
    /** Keyframes per cycle. */
    samples: 96,
    clips: [
      {
        name: 'Walk',
        /**
         * 0.92 s and 0.80 of the available step come out at about 1.15 m/s on these models,
         * which is deliberately close to a shambler's 1.55 m/s: the animator makes up the
         * difference exactly, but it does it by stretching the stride and raising the cadence,
         * and a cycle authored far below the speed it is asked for spends the whole game at
         * the far end of both.
         */
        duration: 0.92,
        /** Fraction of the cycle a foot is planted. Above 0.5 there is double support. */
        duty: 0.62,
        reach: 0.80,
        /** Swing-phase toe clearance, metres. */
        lift: 0.055,
        /** How far the pelvis drops at each end of stance, metres. */
        pelvisDrop: 0.045,
        /** Ankle pitch through the roll from heel strike to toe-off, radians. */
        footPitch: 0.20,
        armSwing: 0.24,
        foreArmSwing: 0.12,
        /** Cycles the forearm lags the upper arm by. */
        armLag: 0.07,
      },
      {
        name: 'Run',
        duration: 0.74,
        /** Under 0.5: a flight phase, which is what makes a run a run. */
        duty: 0.38,
        reach: 0.94,
        lift: 0.115,
        pelvisDrop: 0.085,
        footPitch: 0.30,
        armSwing: 0.52,
        foreArmSwing: 0.30,
        armLag: 0.05,
      },
    ],
  },

  /** STAGGER: a damped spring on the whole body. */
  stagger: {
    stiffness: 290,
    damping: 17,
    impulse: 5.5,
  },

  /** DEATH: how the body sinks away once it has fallen. */
  death: {
    /** How far the body sinks, as a fraction of the type's height, before it is removed. */
    sinkFraction: 1.0,
    sinkTime: 1.0,
  },

  /**
   * STYLE, per enemy type id, read by the rigid bodies (src/anim/RigidBody.js): `energy`
   * widens the roll, the wag and the stride, `weight` slows every settle and deepens the lean,
   * `asymmetry` sets how unevenly the roll favours one side, `breath` the breathing rate.
   */
  style: {
    shambler: {
      energy: 0.78, weight: 1.30, asymmetry: 0.30, breath: 1.15,
    },
    runner: {
      energy: 1.25, weight: 0.80, asymmetry: 0.16, breath: 1.45,
    },
    husk: {
      energy: 1.10, weight: 0.62, asymmetry: 0.38, breath: 1.30,
    },
    brute: {
      energy: 0.62, weight: 1.85, asymmetry: 0.22, breath: 1.50,
    },
    lurker: {
      energy: 1.18, weight: 0.70, asymmetry: 0.14, breath: 0.70,
    },
    prowler: {
      energy: 1.30, weight: 0.66, asymmetry: 0.18, breath: 1.35,
    },
    behemoth: {
      energy: 0.70, weight: 2.20, asymmetry: 0.30, breath: 0.85,
    },
    stalker: {
      energy: 1.05, weight: 1.35, asymmetry: 0.22, breath: 1.05,
    },
    titan: {
      energy: 0.55, weight: 2.60, asymmetry: 0.34, breath: 0.70,
    },
    /**
     * ARCADE'S CRITTERS are rigid bodies as well. The slime is all bounce: the widest excursions
     * in the roster on the lightest body, so it settles fast. The shroomling waddles; the bumble
     * brute is a heavy hover whose quick breath reads as its wing beat; the king slime is a slow
     * wobbling mass.
     */
    slime: {
      energy: 1.60, weight: 0.60, asymmetry: 0.20, breath: 1.80,
    },
    shroom: {
      energy: 1.15, weight: 0.95, asymmetry: 0.30, breath: 1.20,
    },
    bee: {
      energy: 0.80, weight: 1.40, asymmetry: 0.15, breath: 2.60,
    },
    king: {
      energy: 0.90, weight: 2.00, asymmetry: 0.25, breath: 0.90,
    },
    /** The generated families (packs/arcade creatures): a sprout bobs, a pebble turtle plods, a bat-puff flutters. */
    sprout: {
      energy: 1.35, weight: 0.70, asymmetry: 0.25, breath: 1.60,
    },
    pebble: {
      energy: 0.60, weight: 1.90, asymmetry: 0.30, breath: 0.80,
    },
    batpuff: {
      energy: 1.25, weight: 0.65, asymmetry: 0.20, breath: 2.80,
    },
    hornblob: {
      energy: 1.00, weight: 1.30, asymmetry: 0.30, breath: 1.10,
    },
    acorn: {
      energy: 1.20, weight: 0.85, asymmetry: 0.35, breath: 1.30,
    },
    spirit: {
      energy: 0.85, weight: 1.05, asymmetry: 0.15, breath: 0.90,
    },
  },
  /** Used when a type has no entry above. */
  defaultStyle: {
    energy: 1.0, weight: 1.0, asymmetry: 0.2, breath: 1.0,
  },

  /**
   * RIGID BODIES: the whole-body motion of an enemy that has no joints (src/anim/RigidBody.js).
   * Angles in radians, lengths as fractions of the body's height, so one table serves a 2.4 m
   * tortoise and a 3.2 m giraffe in proportion. The style block above scales these per type.
   */
  rigid: {
    /** One step, as a fraction of height. A 2.6 m hippo at 0.36 takes 0.94 m steps. */
    strideFraction: 0.36,
    /** Below this ground speed the body is standing: weight-shift idle instead of a walk. */
    idleSpeed: 0.08,
    /** Cycles per second of that weight shift, before the style's weight slows it. */
    idleCadence: 0.22,
    /** Side-to-side roll amplitude at full speed. */
    roll: 0.075,
    /** Vertical bob per step at full speed, as a fraction of height. */
    bob: 0.018,
    /** How far the body drops on a footfall, and how quickly it eases back up (per second). */
    settleDrop: 0.010,
    settleRate: 9,
    /** Yaw wag of the front end against the roll. */
    wag: 0.045,
    /** Forward lean at full speed, and per m/s^2 of acceleration. */
    lean: 0.11,
    leanAccel: 0.035,
    /** Bank into a turn, per rad/s of yaw rate, capped at this. */
    bank: 0.06,
    /** Breathing: cycles per second and vertical amplitude as a fraction of height. */
    breathRate: 0.28,
    breath: 0.0035,
    /** The stagger spring, as a multiplier on ANIM.stagger.stiffness, and what it drives. */
    staggerStiffness: 0.55,
    staggerLean: 0.22,
    staggerShove: 0.06,
    attack: {
      /** Rear back over the windup: pitch (rad), rise and backward shift (fractions of height). */
      rear: 0.14,
      rise: 0.02,
      rearShift: 0.04,
      /** Lunge through the active window: pitch forward and reach forward. */
      lunge: 0.20,
      reach: 0.12,
    },
    death: {
      /** Seconds from the kill to lying flat. Heavier than a enemy's 0.95 s collapse. */
      fallTime: 1.10,
      /** How far past horizontal-ish the topple goes; 1.45 rad is 83 degrees. */
      topple: 1.45,
      /** The rebound after impact: amplitude (rad) and rate (cycles/s). */
      bounce: 0.05,
      bounceRate: 1.6,
      /** Downward settle at the end of the fall, as a fraction of height. */
      sink: 0.03,
    },
  },
};
