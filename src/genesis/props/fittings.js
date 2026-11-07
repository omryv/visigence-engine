/* fittings.js — using the things in a room.
 *
 * engine/props/doors.js swings anything that declares a hinge, and that
 * already covers the whole of "open": a wardrobe, a cold store and the front
 * door of a house are the same machinery, because a piece of casework that
 * opens emits an ordinary `proc.door` (js/furniture.js). This file is the
 * rest of the sentence — sitting down, picking something up, lighting a
 * candle, standing at a bench — and it exists because none of those is a
 * hinge and all of them are what a room is for.
 *
 * WHAT IT KNOWS, AND HOW LITTLE. A placement carries a `use` field: a verb, a
 * kind and a reach, and nothing else. It is minted by js/affordance.js, which
 * is a layer ABOVE this one — the engine sits under the editor and may not
 * reach up into it — so the contract between them is plain data on the record
 * rather than a shared module. That is the same rule the rest of the project
 * runs on: `params` is the whole world, and an affordance held in a Map
 * beside the editor is one that does not survive a reload, an export, or a
 * handoff to a runtime that was written afterwards.
 *
 * State, not world state. Which chairs have been sat in and which candles are
 * burning never enters `params`, exactly as which doors happen to be open
 * never does — so a world still reloads identically and an export still
 * carries a room rather than a save game.
 *
 * The five kinds and what each actually does:
 *
 *   sit, rest    hands back a pose. The controller owns the player's
 *                position, so it is the controller that sits down; this only
 *                says where and how high.
 *   take         the object leaves the room. Hidden rather than deleted,
 *                because the record is still the world's and putting it back
 *                has to be free.
 *   light        a flame goes on or out. Every emissive part in the placement
 *                is dimmed together, and the real point light with it, so a
 *                blown-out candle darkens the room rather than turning grey.
 *   search       a container is looked in. Nothing moves: this catalogue's
 *                containers have lids and the engine hinges about the
 *                vertical axis, and a chest that rotates bodily when you open
 *                it is worse than a chest that stays still.
 *   work         a bench, a loom, a basin. Nothing moves here either — what
 *                is afforded is the ACTIVITY, and whatever wants to build
 *                something on a workbench has an event to hang it on.
 */

import * as THREE from "three";

const REACH_PAD = 0.4;   // slack on a piece's own stated reach, in metres
const FACING = 0.3;      // how much it must be in front of you (dot product)
const EYE = 1.05;        // seated eye height above a seat, metres

export class Fittings {
  constructor() {
    this.items = new Map();   // uid → { use, object, record, on, taken }
    this._v = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
  }

  /* Register a freshly built placement, if it affords anything. Silent about
     everything else, which is most of a world: a wall, a floor slab and a
     rug all come through here and none of them is interesting. */
  register(uid, object, record) {
    const use = record?.use;
    if (!use?.kind) { this.items.delete(uid); return; }
    this.items.set(uid, {
      uid, use, object, record,
      // A lamp starts lit, because the room was lit when it was planned: the
      // layout solver measured this thing's contribution to the floor it
      // covers, and starting it out would darken a room that was checked lit.
      on: true, taken: false,
    });
  }

  unregister(uid) { this.items.delete(uid); }
  clear() { this.items.clear(); }
  get count() { return this.items.size; }

  /* What you are looking at: the nearest thing within its own reach and
     roughly in front of you. Each piece states how far away its verb still
     works, because they genuinely differ — you can light a lamp from further
     off than you can climb into a bed. */
  pick(camera) {
    camera.getWorldDirection(this._fwd);
    let best = null, bestD = Infinity;
    for (const it of this.items.values()) {
      if (it.taken) continue;
      it.object.getWorldPosition(this._v);
      const dx = this._v.x - camera.position.x;
      const dy = this._v.y - camera.position.y;
      const dz = this._v.z - camera.position.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > (it.use.reach ?? 1.2) + REACH_PAD || dist > bestD) continue;
      const dot = (dx * this._fwd.x + dy * this._fwd.y + dz * this._fwd.z) / (dist || 1);
      if (dot < FACING) continue;
      best = it; bestD = dist;
    }
    return best;
  }

  /* The line to put under the crosshair. Says what will HAPPEN, never what
     the thing is: "Sit" beats "Armchair", and a player who needs to be told
     they are looking at an armchair has a different problem. */
  promptFor(it) {
    if (!it) return null;
    if (it.use.kind === "light") return { verb: it.on ? "Put out" : "Light", label: it.record.label };
    return { verb: it.use.verb, label: it.record.label };
  }

  /* Use whatever is in front of the camera. Returns what happened — the
     caller decides what that means, because sitting down is the controller's
     business and picking something up is a game's.

     → null when there is nothing there, else { uid, kind, ... } */
  use(camera) {
    const it = this.pick(camera);
    if (!it) return null;
    switch (it.use.kind) {
      case "sit": case "rest":
        return { uid: it.uid, kind: it.use.kind, pose: this.poseOf(it) };
      case "take":
        it.taken = true;
        it.object.visible = false;
        return { uid: it.uid, kind: "take", label: it.record.label, ref: it.record.ref };
      case "light":
        it.on = !it.on;
        setGlow(it.object, it.on);
        return { uid: it.uid, kind: "light", on: it.on };
      default:
        // search and work: state and a message, and deliberately no motion.
        return { uid: it.uid, kind: it.use.kind, label: it.record.label };
    }
  }

  /* Where the player ends up, in world space, and which way they end up
     facing. A seat's own rotation is the answer to the second question: every
     piece in the catalogue is built with local +z as the face it presents to
     the room, so a chair drawn up to a table already points at the table. */
  poseOf(it) {
    it.object.getWorldPosition(this._v);
    const yaw = it.object.rotation.y;
    return {
      x: this._v.x,
      y: this._v.y + (it.use.seatH ?? 0.45) + EYE,
      z: this._v.z,
      yaw,
    };
  }

  // Put back everything the player picked up and relight everything they
  // blew out. A rebuild re-registers, so this is for the case where the world
  // stays and the session restarts.
  reset() {
    for (const it of this.items.values()) {
      if (it.taken) { it.taken = false; it.object.visible = true; }
      if (!it.on) { it.on = true; setGlow(it.object, true); }
    }
  }
}

/* Put a placement's flames out, or light them again.
 *
 * BY VISIBILITY, NOT BY MATERIAL, and that is the whole design of this
 * function. Props shares materials between placements to keep a world's draw
 * cost down, so dimming `emissiveIntensity` on the mesh in front of you blows
 * out every other candle in the world at the same time — and cloning the
 * material instead leaves an allocation nothing owns and nothing disposes.
 *
 * It is also the more honest picture. What a burning thing emits in this
 * catalogue is one small sphere on top of it (the `lamp` helper in
 * js/furniture.js) plus the real point light that sphere carries. Hiding the
 * sphere is a flame going out; the candle it sat on stays exactly where it
 * was, which is what happens. */
function setGlow(object, on) {
  object.traverse((o) => {
    if (o.isLight) { o.visible = on; return; }
    if (o.isMesh && o.material?.emissiveIntensity > 0) o.visible = on;
  });
}
