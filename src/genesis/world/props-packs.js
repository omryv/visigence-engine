// Pack registry for the Blocks dock. Adding an item = one manifest entry.
//
// EVERY ITEM IS PROCEDURAL, AND THAT IS NOW A RULE RATHER THAN A HABIT. A pack
// entry carries a `proc` part spec that block-shapes.js assembles at runtime;
// it never carries a `url`. The catalogue therefore costs zero bytes of asset
// storage, has no third-party origin to allow in the content policy, and
// cannot fail because somebody else's bucket is down. There used to be a
// `field-kit` pack of thirteen GLBs streamed from an R2 bucket — it was the
// only thing on this origin that reached off it, and removing it is what let
// the policy drop to `default-src 'none'` with no remote host at all.
//
// tests/compose.test.js enforces the rule: a spec that carries a url fails.

import { buildingParts, roadParts, junctionParts, plazaParts, treeParts, pineParts, birchParts, bushParts, hedgeParts,
         castleParts, curtainWallParts, pathParts, jettyParts, cropParts, fountainParts, palmParts, studyParts,
         STREET_SURFACES } from "./block-shapes.js";

export const PACKS_VERSION = 3;

// Arc sampler for extrude outlines/holes (pure data helper — no three here).
const arc = (cx, cy, r, a0, a1, n) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [+(cx + Math.cos(a) * r).toFixed(3), +(cy + Math.sin(a) * r).toFixed(3)];
  });

const HPI = Math.PI / 2;

export const PACKS = [
  {
    // Builder pack: game-world construction blocks. No GLB and no network:
    // `proc.parts` is a declarative geometry spec (dims in metres) the engine
    // assembles — box(+bevel) · wedge · cylinder(+rTop) · cone · sphere ·
    // lathe(profile) · extrude(outline/holes/depth). Per part: tex, color,
    // roughness, metalness, emissive. `grime` weathers the metres nearest the
    // ground. The spec travels IN the placement record, so VSight and exports
    // rebuild the identical object. Pure data — keep this module three-free.
    id: "builder",
    label: "Builder",
    items: [
      { id: "floor", label: "Floor", category: "builder", thumb: "▦", proc: { grime: 0.3, parts: [
        { shape: "box", dims: [6, 0.3, 6], pos: [0, 0.15, 0], bevel: 0.03, color: 0x8f959c, tex: "concrete" },
        { shape: "box", dims: [5.7, 0.02, 5.7], pos: [0, 0.31, 0], color: 0x989da3, tex: "concrete", grime: false },
      ] } },

      { id: "wall", label: "Wall", category: "builder", thumb: "▭", proc: { grime: 1.1, parts: [
        { shape: "box", dims: [6, 0.3, 0.55], pos: [0, 0.15, 0], bevel: 0.02, color: 0x83898f, tex: "concrete" },
        { shape: "box", dims: [6, 2.55, 0.35], pos: [0, 1.575, 0], color: 0xa8adb5, tex: "plaster" },
        { shape: "box", dims: [0.28, 2.55, 0.42], pos: [-2.86, 1.575, 0], color: 0x9aa0ac, tex: "plaster" },
        { shape: "box", dims: [0.28, 2.55, 0.42], pos: [2.86, 1.575, 0], color: 0x9aa0ac, tex: "plaster" },
        { shape: "box", dims: [6.15, 0.14, 0.5], pos: [0, 2.92, 0], bevel: 0.03, color: 0x8f959c, tex: "concrete", grime: false },
      ] } },

      { id: "doorway", label: "Doorway", category: "builder", thumb: "🚪", proc: { grime: 1.0, parts: [
        { shape: "extrude", depth: 0.35, color: 0xa8adb5, tex: "plaster",
          outline: [[-3, 0], [3, 0], [3, 3], [-3, 3]],
          holes: [[[0.75, 0.05], ...arc(0, 1.65, 0.75, 0, Math.PI, 12), [-0.75, 0.05]]] },
        { shape: "box", dims: [0.18, 1.7, 0.45], pos: [-0.89, 0.85, 0], color: 0x8f959c, tex: "stone" },
        { shape: "box", dims: [0.18, 1.7, 0.45], pos: [0.89, 0.85, 0], color: 0x8f959c, tex: "stone" },
        { shape: "box", dims: [0.42, 0.5, 0.45], pos: [0, 2.5, 0], color: 0x9ba1a8, tex: "stone", grime: false },
        { shape: "box", dims: [1.9, 0.07, 0.7], pos: [0, 0.035, 0], bevel: 0.02, color: 0x878d93, tex: "concrete" },
      ] } },

      // Six metres wide, so it drops straight into a wall run (and a maze
      // grid) with no gap. `proc.door` makes the leaf swing: parts flagged
      // door:true hang off a pivot at `hinge`, and E opens them in play.
      { id: "door", label: "Door", category: "builder", thumb: "🚪", proc: {
        grime: 0.9,
        door: { hinge: [-1.05, 0, 0], swing: 1.95 },
        parts: [
          { shape: "box", dims: [1.9, 3, 0.45], pos: [-2.05, 1.5, 0], color: 0x9298a0, tex: "stone" },
          { shape: "box", dims: [1.9, 3, 0.45], pos: [2.05, 1.5, 0], color: 0x9298a0, tex: "stone" },
          { shape: "box", dims: [6, 0.72, 0.5], pos: [0, 2.64, 0], bevel: 0.02, color: 0x9ba1a8, tex: "stone", grime: false },
          { shape: "box", dims: [2.5, 0.1, 0.62], pos: [0, 0.05, 0], bevel: 0.02, color: 0x878d93, tex: "concrete" },
          { shape: "box", dims: [2.1, 2.24, 0.12], pos: [0, 1.14, 0], color: 0x7a5a3c, tex: "board", door: true },
          { shape: "sphere", dims: [0.075], pos: [0.78, 1.12, 0.12], color: 0x9aa2ab, tex: "none", metalness: 0.7, roughness: 0.35, door: true },
        ],
      } },

      // Wedge rises toward +z: walk up from the −z side.
      { id: "ramp", label: "Ramp", category: "builder", thumb: "◢", proc: { grime: 0.9, parts: [
        { shape: "wedge", dims: [3, 2.55, 6.4], pos: [0, 0, 0], color: 0x8f959c, tex: "concrete" },
        { shape: "wedge", dims: [0.22, 2.7, 6.4], pos: [-1.61, 0, 0], color: 0x7d838c, tex: "concrete" },
        { shape: "wedge", dims: [0.22, 2.7, 6.4], pos: [1.61, 0, 0], color: 0x7d838c, tex: "concrete" },
        { shape: "box", dims: [3.44, 0.12, 0.7], pos: [0, 0.06, -3.5], bevel: 0.02, color: 0x848a92, tex: "concrete" },
      ] } },

      // Ascends toward +z: stringers, nosed treads, wooden handrails.
      { id: "stairs", label: "Stairs", category: "builder", thumb: "🪜", proc: { grime: 0.8, parts: [
        { shape: "wedge", dims: [0.28, 2.5, 6.0], pos: [-1.36, 0, 0], color: 0x767c85, tex: "concrete" },
        { shape: "wedge", dims: [0.28, 2.5, 6.0], pos: [1.36, 0, 0], color: 0x767c85, tex: "concrete" },
        { shape: "box", dims: [3, 0.5, 1.2], pos: [0, 0.25, -2.4], bevel: 0.03, color: 0x8f959c, tex: "concrete" },
        { shape: "box", dims: [3, 0.5, 1.2], pos: [0, 0.75, -1.2], bevel: 0.03, color: 0x8f959c, tex: "concrete" },
        { shape: "box", dims: [3, 0.5, 1.2], pos: [0, 1.25, 0], bevel: 0.03, color: 0x8f959c, tex: "concrete" },
        { shape: "box", dims: [3, 0.5, 1.2], pos: [0, 1.75, 1.2], bevel: 0.03, color: 0x8f959c, tex: "concrete" },
        { shape: "box", dims: [3, 0.5, 1.2], pos: [0, 2.25, 2.4], bevel: 0.03, color: 0x8f959c, tex: "concrete" },
        { shape: "cylinder", dims: [0.045, 0.95], pos: [-1.43, 0.975, -2.4], color: 0x5f666e, tex: "none", metalness: 0.5, roughness: 0.5 },
        { shape: "cylinder", dims: [0.045, 0.95], pos: [-1.43, 1.975, 0], color: 0x5f666e, tex: "none", metalness: 0.5, roughness: 0.5 },
        { shape: "cylinder", dims: [0.045, 0.95], pos: [-1.43, 2.975, 2.4], color: 0x5f666e, tex: "none", metalness: 0.5, roughness: 0.5 },
        { shape: "cylinder", dims: [0.045, 0.95], pos: [1.43, 0.975, -2.4], color: 0x5f666e, tex: "none", metalness: 0.5, roughness: 0.5 },
        { shape: "cylinder", dims: [0.045, 0.95], pos: [1.43, 1.975, 0], color: 0x5f666e, tex: "none", metalness: 0.5, roughness: 0.5 },
        { shape: "cylinder", dims: [0.045, 0.95], pos: [1.43, 2.975, 2.4], color: 0x5f666e, tex: "none", metalness: 0.5, roughness: 0.5 },
        { shape: "cylinder", dims: [0.05, 5.2], pos: [-1.43, 2.45, 0], rotX: 1.176, color: 0x7a5a3e, tex: "wood", grime: false },
        { shape: "cylinder", dims: [0.05, 5.2], pos: [1.43, 2.45, 0], rotX: 1.176, color: 0x7a5a3e, tex: "wood", grime: false },
      ] } },

      { id: "pillar", label: "Pillar", category: "builder", thumb: "▮", proc: { grime: 0.7, parts: [
        { shape: "box", dims: [0.95, 0.22, 0.95], pos: [0, 0.11, 0], bevel: 0.03, color: 0x9298a0, tex: "stone" },
        { shape: "lathe", profile: [[0.45, 0], [0.45, 0.08], [0.37, 0.14], [0.34, 0.22]], pos: [0, 0.22, 0], seg: 28, color: 0x9aa0a8, tex: "stone" },
        { shape: "cylinder", dims: [0.3, 3.0], rTop: 0.26, seg: 28, pos: [0, 1.94, 0], color: 0x9aa0a8, tex: "stone" },
        { shape: "lathe", profile: [[0.27, 0], [0.31, 0.1], [0.44, 0.24], [0.47, 0.3]], pos: [0, 3.44, 0], seg: 28, color: 0x9aa0a8, tex: "stone", grime: false },
        { shape: "box", dims: [0.85, 0.14, 0.85], pos: [0, 3.82, 0], bevel: 0.02, color: 0x9298a0, tex: "stone", grime: false },
      ] } },

      { id: "crate", label: "Crate", category: "objects", thumb: "📦", proc: { grime: 0.4, parts: [
        { shape: "box", dims: [1.3, 1.3, 1.3], pos: [0, 0.66, 0], bevel: 0.025, color: 0x9c7a52, tex: "wood" },
        { shape: "box", dims: [0.14, 1.36, 0.14], pos: [-0.63, 0.68, -0.63], color: 0x77573a, tex: "board" },
        { shape: "box", dims: [0.14, 1.36, 0.14], pos: [0.63, 0.68, -0.63], color: 0x77573a, tex: "board" },
        { shape: "box", dims: [0.14, 1.36, 0.14], pos: [-0.63, 0.68, 0.63], color: 0x77573a, tex: "board" },
        { shape: "box", dims: [0.14, 1.36, 0.14], pos: [0.63, 0.68, 0.63], color: 0x77573a, tex: "board" },
        { shape: "box", dims: [1.34, 0.07, 1.34], pos: [0, 0.33, 0], color: 0x8b9299, tex: "metal", metalness: 0.65, roughness: 0.45 },
        { shape: "box", dims: [1.34, 0.07, 1.34], pos: [0, 1.0, 0], color: 0x8b9299, tex: "metal", metalness: 0.65, roughness: 0.45 },
      ] } },

      // Jersey barrier: true highway cross-section, extruded.
      { id: "barrier", label: "Barrier", category: "builder", thumb: "▬", proc: { grime: 0.5, parts: [
        { shape: "extrude", depth: 3, rotY: HPI, pos: [0, 0, 0], bevel: 0.02, color: 0x848a92, tex: "concrete",
          outline: [[-0.32, 0], [0.32, 0], [0.24, 0.1], [0.13, 0.46], [0.11, 0.82], [-0.11, 0.82], [-0.13, 0.46], [-0.24, 0.1]] },
      ] } },

      // Gabled cottage: real door/window openings, glowing panes, eaves,
      // terracotta roof, brick chimney. Front faces +z.
      /* The room this house contains, declared the way buildingParts declares
         its own: walls stand at ±3.325 and are 0.35 thick, the floor slab
         tops out at 0.3 and the eaves are at 3.3, so the space inside is
         6.3 m square and 2.9 m tall. Without this the house was an
         unfurnishable shell — interiors.js only furnishes rooms a block
         actually declares, and this one, being hand-built rather than
         generated, never declared any. */
      /* THE FRONT WALL IS THREE MESHES, and that is the whole difference
         between a door and a picture of one. Collision is one axis-aligned
         box per MESH (engine/props/Props.js), so a doorway punched as a hole
         in a single wall is solid: the box spans the hole. This block was
         authored as one face with a door-shaped hole in it and a board across
         the hole, which meant six furnished rooms in every market hamlet that
         nobody could ever stand in. Two piers and a head over them — exactly
         what js/block-shapes.js does for the buildings it generates — and the
         gap is real. The leaf then declares itself a leaf (`door: true`) and
         the block declares the pivot, so E swings it and its blocker drops
         out while it is open. */
      { id: "house", label: "House", category: "builder", thumb: "🏠", proc: { grime: 1.0,
        rooms: [{ level: 0, at: "ground", y: 0.3, h: 2.9, x: 0, z: 0, w: 6.3, d: 6.3 }],
        door: { hinge: [-0.68, 0.3, 3.3], swing: 1.9 },
        ports: [{ kind: "door", pos: [0, 0.3, 4.0], normal: [0, 1], width: 1.4 }],
        parts: [
        { shape: "box", dims: [7.3, 0.3, 7.3], pos: [0, 0.15, 0], bevel: 0.03, color: 0x84898f, tex: "concrete" },
        { shape: "extrude", depth: 0.35, pos: [0, 0.3, 3.325], color: 0xb3ab97, tex: "plaster",
          outline: [[-3.5, 0], [-0.7, 0], [-0.7, 3], [-3.5, 3]],
          holes: [[[-2.7, 1.15], [-1.6, 1.15], [-1.6, 2.25], [-2.7, 2.25]]] },
        { shape: "extrude", depth: 0.35, pos: [0, 0.3, 3.325], color: 0xb3ab97, tex: "plaster",
          outline: [[0.7, 0], [3.5, 0], [3.5, 3], [0.7, 3]],
          holes: [[[1.6, 1.15], [2.7, 1.15], [2.7, 2.25], [1.6, 2.25]]] },
        // The head over the opening. It starts at 2.15 m, so a player ducks
        // under it rather than walking into it.
        { shape: "extrude", depth: 0.35, pos: [0, 0.3, 3.325], color: 0xb3ab97, tex: "plaster",
          outline: [[-0.7, 2.15], [0.7, 2.15], [0.7, 3], [-0.7, 3]], holes: [] },
        { shape: "extrude", depth: 0.35, pos: [0, 0.3, -3.325], color: 0xb3ab97, tex: "plaster",
          outline: [[-3.5, 0], [3.5, 0], [3.5, 3], [-3.5, 3]],
          holes: [[[-0.63, 1.3], [0.63, 1.3], [0.63, 2.4], [-0.63, 2.4]]] },
        { shape: "extrude", depth: 0.35, pos: [-3.325, 0.3, 0], rotY: HPI, color: 0xb3ab97, tex: "plaster",
          outline: [[-3.5, 0], [3.5, 0], [3.5, 3], [0, 4.6], [-3.5, 3]],
          holes: [[[-0.55, 1.3], [0.55, 1.3], [0.55, 2.4], [-0.55, 2.4]]] },
        { shape: "extrude", depth: 0.35, pos: [3.325, 0.3, 0], rotY: HPI, color: 0xb3ab97, tex: "plaster",
          outline: [[-3.5, 0], [3.5, 0], [3.5, 3], [0, 4.6], [-3.5, 3]] },
        { shape: "box", dims: [7.9, 0.16, 4.35], pos: [0, 4.03, 1.995], rotX: 0.411, color: 0x9a6a55, tex: "rooftile", grime: false },
        { shape: "box", dims: [7.9, 0.16, 4.35], pos: [0, 4.03, -1.995], rotX: -0.411, color: 0x9a6a55, tex: "rooftile", grime: false },
        { shape: "cylinder", dims: [0.09, 7.9], pos: [0, 4.92, 0], rotZ: HPI, color: 0x8a5c48, tex: "rooftile", grime: false },
        { shape: "box", dims: [0.7, 1.6, 0.7], pos: [2.2, 4.5, -1.2], color: 0xa87058, tex: "brick", grime: false },
        { shape: "box", dims: [0.85, 0.12, 0.85], pos: [2.2, 5.36, -1.2], bevel: 0.02, color: 0x8f959c, tex: "concrete", grime: false },
        { shape: "cylinder", dims: [0.12, 0.3], pos: [2.2, 5.57, -1.2], color: 0x6d4a3c, tex: "none", roughness: 0.7, grime: false },
        { shape: "box", dims: [1.36, 2.06, 0.08], pos: [0, 1.38, 3.3], color: 0x7a5a3c, tex: "board", door: true },
        { shape: "box", dims: [1.06, 1.06, 0.06], pos: [-2.15, 2.0, 3.28], tex: "none", color: 0x35281c, emissive: 0xffb45c, emissiveIntensity: 1.4 },
        { shape: "box", dims: [1.06, 1.06, 0.06], pos: [2.15, 2.0, 3.28], tex: "none", color: 0x35281c, emissive: 0xffb45c, emissiveIntensity: 1.4 },
        { shape: "box", dims: [1.22, 1.02, 0.06], pos: [0, 2.15, -3.28], tex: "none", color: 0x35281c, emissive: 0xffb45c, emissiveIntensity: 1.4 },
        { shape: "box", dims: [0.06, 1.02, 1.06], pos: [-3.28, 2.15, 0], tex: "none", color: 0x35281c, emissive: 0xffb45c, emissiveIntensity: 1.4 },
        { shape: "box", dims: [1.3, 0.08, 0.16], pos: [-2.15, 1.41, 3.54], bevel: 0.02, color: 0x8f959c, tex: "concrete", grime: false },
        { shape: "box", dims: [1.3, 0.08, 0.16], pos: [2.15, 1.41, 3.54], bevel: 0.02, color: 0x8f959c, tex: "concrete", grime: false },
        { shape: "box", dims: [1.9, 0.1, 0.6], pos: [0, 0.35, 3.45], bevel: 0.02, color: 0x878d93, tex: "concrete" },
      ] } },

      // Watchtower: flared base, tapered shaft, corbelled crown, witch-hat
      // roof, glowing arrow slits.
      /* A round room gets the largest SQUARE that fits inside it: the shaft's
         inner face is about 1.7 m from the axis, so a 2.4 m square keeps
         every corner off the curved wall. Planning a circle as a circle
         would need a second solver for one building. */
      { id: "tower", label: "Tower", category: "builder", thumb: "🗼", proc: { grime: 1.6,
        rooms: [{ level: 0, at: "ground", y: 0.05, h: 3.2, x: 0, z: 0, w: 2.4, d: 2.4 }],
        parts: [
        { shape: "lathe", profile: [[2.6, 0], [2.5, 0.5], [2.15, 1.4], [2.05, 1.8]], seg: 28, pos: [0, 0, 0], color: 0x8d9198, tex: "stone" },
        { shape: "cylinder", dims: [2.05, 5.4], rTop: 1.8, seg: 28, pos: [0, 4.5, 0], color: 0x9298a1, tex: "stone" },
        { shape: "lathe", profile: [[1.8, 0], [2.15, 0.3], [2.2, 0.55]], seg: 28, pos: [0, 7.2, 0], color: 0x878d96, tex: "stone", grime: false },
        { shape: "cone", dims: [2.35, 2.6, 28], pos: [0, 9.05, 0], color: 0x6f4a4a, tex: "shingle", grime: false },
        { shape: "sphere", dims: [0.16], pos: [0, 10.45, 0], color: 0xb8a25f, tex: "none", metalness: 0.8, roughness: 0.35, grime: false },
        { shape: "box", dims: [0.22, 0.9, 0.12], pos: [0, 5.0, 1.93], tex: "none", color: 0x1c1e22, emissive: 0xffb45c, emissiveIntensity: 0.9 },
        { shape: "box", dims: [0.22, 0.9, 0.12], pos: [1.62, 6.0, -0.93], rotY: 2.094, tex: "none", color: 0x1c1e22, emissive: 0xffb45c, emissiveIntensity: 0.9 },
        { shape: "box", dims: [0.22, 0.9, 0.12], pos: [-1.69, 4.0, -0.975], rotY: -2.094, tex: "none", color: 0x1c1e22, emissive: 0xffb45c, emissiveIntensity: 0.9 },
        { shape: "box", dims: [1.5, 2.2, 0.6], pos: [0, 1.1, 2.3], color: 0x848a92, tex: "stone" },
        { shape: "box", dims: [1.1, 1.9, 0.2], pos: [0, 0.98, 2.42], color: 0x6d5138, tex: "board" },
      ] } },

      // Stilted lookout deck: joists, X-bracing, ladder up the front.
      { id: "platform", label: "Platform", category: "builder", thumb: "⬒", proc: { grime: 0.8, parts: [
        { shape: "box", dims: [5, 0.22, 5], pos: [0, 3.41, 0], bevel: 0.025, color: 0x96744e, tex: "wood", grime: false },
        { shape: "box", dims: [5.2, 0.3, 0.24], pos: [0, 3.15, -2.5], color: 0x77573a, tex: "wood", grime: false },
        { shape: "box", dims: [5.2, 0.3, 0.24], pos: [0, 3.15, 2.5], color: 0x77573a, tex: "wood", grime: false },
        { shape: "box", dims: [0.24, 0.3, 5.2], pos: [-2.5, 3.15, 0], color: 0x77573a, tex: "wood", grime: false },
        { shape: "box", dims: [0.24, 0.3, 5.2], pos: [2.5, 3.15, 0], color: 0x77573a, tex: "wood", grime: false },
        { shape: "cylinder", dims: [0.16, 3.3], pos: [-2.2, 1.65, -2.2], color: 0x6f5138, tex: "board" },
        { shape: "cylinder", dims: [0.16, 3.3], pos: [2.2, 1.65, -2.2], color: 0x6f5138, tex: "board" },
        { shape: "cylinder", dims: [0.16, 3.3], pos: [-2.2, 1.65, 2.2], color: 0x6f5138, tex: "board" },
        { shape: "cylinder", dims: [0.16, 3.3], pos: [2.2, 1.65, 2.2], color: 0x6f5138, tex: "board" },
        { shape: "box", dims: [4.9, 0.13, 0.13], pos: [0, 2.0, -2.2], rotZ: 0.427, color: 0x6a4f35, tex: "wood" },
        { shape: "box", dims: [4.9, 0.13, 0.13], pos: [0, 2.0, -2.2], rotZ: -0.427, color: 0x6a4f35, tex: "wood" },
        { shape: "box", dims: [4.9, 0.13, 0.13], pos: [0, 2.0, 2.2], rotZ: 0.427, color: 0x6a4f35, tex: "wood" },
        { shape: "box", dims: [4.9, 0.13, 0.13], pos: [0, 2.0, 2.2], rotZ: -0.427, color: 0x6a4f35, tex: "wood" },
        { shape: "cylinder", dims: [0.05, 3.4], pos: [-0.28, 1.7, 2.62], color: 0x77573a, tex: "none", roughness: 0.7 },
        { shape: "cylinder", dims: [0.05, 3.4], pos: [0.28, 1.7, 2.62], color: 0x77573a, tex: "none", roughness: 0.7 },
        { shape: "cylinder", dims: [0.035, 0.62], pos: [0, 0.5, 2.62], rotZ: HPI, color: 0x8a6a48, tex: "none", roughness: 0.7 },
        { shape: "cylinder", dims: [0.035, 0.62], pos: [0, 1.0, 2.62], rotZ: HPI, color: 0x8a6a48, tex: "none", roughness: 0.7 },
        { shape: "cylinder", dims: [0.035, 0.62], pos: [0, 1.5, 2.62], rotZ: HPI, color: 0x8a6a48, tex: "none", roughness: 0.7 },
        { shape: "cylinder", dims: [0.035, 0.62], pos: [0, 2.0, 2.62], rotZ: HPI, color: 0x8a6a48, tex: "none", roughness: 0.7 },
        { shape: "cylinder", dims: [0.035, 0.62], pos: [0, 2.5, 2.62], rotZ: HPI, color: 0x8a6a48, tex: "none", roughness: 0.7 },
        { shape: "cylinder", dims: [0.035, 0.62], pos: [0, 3.0, 2.62], rotZ: HPI, color: 0x8a6a48, tex: "none", roughness: 0.7 },
      ] } },

      { id: "fence", label: "Fence", category: "builder", thumb: "🚧", proc: { grime: 0.35, parts: [
        { shape: "box", dims: [0.16, 1.25, 0.16], pos: [-1.42, 0.625, 0], bevel: 0.02, color: 0x7d5f40, tex: "board" },
        { shape: "box", dims: [0.16, 1.25, 0.16], pos: [1.42, 0.625, 0], bevel: 0.02, color: 0x7d5f40, tex: "board" },
        { shape: "box", dims: [0.2, 0.05, 0.2], pos: [-1.42, 1.275, 0], color: 0x6a4f35, tex: "wood", grime: false },
        { shape: "box", dims: [0.2, 0.05, 0.2], pos: [1.42, 1.275, 0], color: 0x6a4f35, tex: "wood", grime: false },
        { shape: "box", dims: [3.0, 0.14, 0.07], pos: [0, 0.55, 0.06], color: 0x8a6a48, tex: "wood" },
        { shape: "box", dims: [3.0, 0.14, 0.07], pos: [0, 1.0, 0.06], color: 0x8a6a48, tex: "wood", grime: false },
      ] } },

      { id: "gate", label: "Gate", category: "builder", thumb: "⛩", proc: { grime: 0.3, parts: [
        { shape: "box", dims: [0.2, 1.6, 0.2], pos: [-0.95, 0.8, 0], bevel: 0.02, color: 0x715536, tex: "board" },
        { shape: "box", dims: [0.2, 1.6, 0.2], pos: [0.95, 0.8, 0], bevel: 0.02, color: 0x715536, tex: "board" },
        { shape: "box", dims: [0.26, 0.06, 0.26], pos: [-0.95, 1.63, 0], color: 0x5f4630, tex: "wood", grime: false },
        { shape: "box", dims: [0.26, 0.06, 0.26], pos: [0.95, 1.63, 0], color: 0x5f4630, tex: "wood", grime: false },
        { shape: "box", dims: [0.3, 1.15, 0.06], pos: [-0.68, 0.775, 0], color: 0x8a6a48, tex: "board" },
        { shape: "box", dims: [0.3, 1.15, 0.06], pos: [-0.34, 0.775, 0], color: 0x86653f, tex: "board" },
        { shape: "box", dims: [0.3, 1.15, 0.06], pos: [0, 0.775, 0], color: 0x8a6a48, tex: "board" },
        { shape: "box", dims: [0.3, 1.15, 0.06], pos: [0.34, 0.775, 0], color: 0x86653f, tex: "board" },
        { shape: "box", dims: [0.3, 1.15, 0.06], pos: [0.68, 0.775, 0], color: 0x8a6a48, tex: "board" },
        { shape: "box", dims: [1.72, 0.12, 0.05], pos: [0, 1.28, 0.045], color: 0x77573a, tex: "wood", grime: false },
        { shape: "box", dims: [1.72, 0.12, 0.05], pos: [0, 0.28, 0.045], color: 0x77573a, tex: "wood" },
        { shape: "box", dims: [1.85, 0.12, 0.05], pos: [0, 0.77, 0.05], rotZ: 0.55, color: 0x77573a, tex: "wood" },
        { shape: "box", dims: [0.3, 0.08, 0.1], pos: [-0.82, 1.2, 0.05], color: 0x7d848c, tex: "metal", metalness: 0.7, roughness: 0.4 },
        { shape: "box", dims: [0.3, 0.08, 0.1], pos: [-0.82, 0.4, 0.05], color: 0x7d848c, tex: "metal", metalness: 0.7, roughness: 0.4 },
      ] } },

      // Freestanding stone archway with keystone and imposts.
      { id: "arch", label: "Arch", category: "builder", thumb: "🏛", proc: { grime: 1.0, parts: [
        { shape: "extrude", depth: 0.8, color: 0x979da5, tex: "stone",
          outline: [[-2, 0], [2, 0], [2, 3.0], [-2, 3.0]],
          holes: [[[1.3, 0.05], ...arc(0, 1.4, 1.3, 0, Math.PI, 14), [-1.3, 0.05]]] },
        { shape: "box", dims: [0.5, 0.62, 0.9], pos: [0, 2.78, 0], color: 0x8a9098, tex: "stone", grime: false },
        { shape: "box", dims: [0.6, 0.16, 0.95], pos: [-1.55, 1.36, 0], color: 0x878d95, tex: "stone" },
        { shape: "box", dims: [0.6, 0.16, 0.95], pos: [1.55, 1.36, 0], color: 0x878d95, tex: "stone" },
        { shape: "box", dims: [4.3, 0.22, 1.0], pos: [0, 3.11, 0], bevel: 0.03, color: 0x8f959c, tex: "concrete", grime: false },
      ] } },

      // Plank footbridge: stone abutments, curbs, post-and-rail sides.
      { id: "bridge", label: "Bridge", category: "builder", thumb: "🌉", proc: { grime: 0.4, parts: [
        { shape: "box", dims: [2.6, 0.5, 0.9], pos: [0, 0.25, -2.9], color: 0x8d9399, tex: "stone" },
        { shape: "box", dims: [2.6, 0.5, 0.9], pos: [0, 0.25, 2.9], color: 0x8d9399, tex: "stone" },
        { shape: "box", dims: [2.4, 0.18, 6.2], pos: [0, 0.62, 0], bevel: 0.02, color: 0x8f6d48, tex: "wood", grime: false },
        { shape: "box", dims: [0.18, 0.12, 6.2], pos: [-1.12, 0.76, 0], color: 0x6f5138, tex: "wood", grime: false },
        { shape: "box", dims: [0.18, 0.12, 6.2], pos: [1.12, 0.76, 0], color: 0x6f5138, tex: "wood", grime: false },
        { shape: "box", dims: [0.1, 0.85, 0.1], pos: [-1.08, 1.135, -2.6], color: 0x6f5138, tex: "board", grime: false },
        { shape: "box", dims: [0.1, 0.85, 0.1], pos: [-1.08, 1.135, 0], color: 0x6f5138, tex: "board", grime: false },
        { shape: "box", dims: [0.1, 0.85, 0.1], pos: [-1.08, 1.135, 2.6], color: 0x6f5138, tex: "board", grime: false },
        { shape: "box", dims: [0.1, 0.85, 0.1], pos: [1.08, 1.135, -2.6], color: 0x6f5138, tex: "board", grime: false },
        { shape: "box", dims: [0.1, 0.85, 0.1], pos: [1.08, 1.135, 0], color: 0x6f5138, tex: "board", grime: false },
        { shape: "box", dims: [0.1, 0.85, 0.1], pos: [1.08, 1.135, 2.6], color: 0x6f5138, tex: "board", grime: false },
        { shape: "box", dims: [0.12, 0.09, 6.2], pos: [-1.08, 1.6, 0], color: 0x7a5a3e, tex: "wood", grime: false },
        { shape: "box", dims: [0.12, 0.09, 6.2], pos: [1.08, 1.6, 0], color: 0x7a5a3e, tex: "wood", grime: false },
      ] } },

      // Steel frame scaffold with a working deck.
      { id: "scaffold", label: "Scaffold", category: "builder", thumb: "🏗", proc: { grime: 0.5, parts: [
        { shape: "cylinder", dims: [0.05, 4.6], pos: [-1.4, 2.3, -0.7], color: 0x8e959c, tex: "metal", metalness: 0.7, roughness: 0.42 },
        { shape: "cylinder", dims: [0.05, 4.6], pos: [1.4, 2.3, -0.7], color: 0x8e959c, tex: "metal", metalness: 0.7, roughness: 0.42 },
        { shape: "cylinder", dims: [0.05, 4.6], pos: [-1.4, 2.3, 0.7], color: 0x8e959c, tex: "metal", metalness: 0.7, roughness: 0.42 },
        { shape: "cylinder", dims: [0.05, 4.6], pos: [1.4, 2.3, 0.7], color: 0x8e959c, tex: "metal", metalness: 0.7, roughness: 0.42 },
        { shape: "cylinder", dims: [0.04, 2.8], pos: [0, 1.5, -0.7], rotZ: HPI, color: 0x868d94, tex: "metal", metalness: 0.7, roughness: 0.42 },
        { shape: "cylinder", dims: [0.04, 2.8], pos: [0, 1.5, 0.7], rotZ: HPI, color: 0x868d94, tex: "metal", metalness: 0.7, roughness: 0.42 },
        { shape: "cylinder", dims: [0.04, 2.8], pos: [0, 3.0, -0.7], rotZ: HPI, color: 0x868d94, tex: "metal", metalness: 0.7, roughness: 0.42 },
        { shape: "cylinder", dims: [0.04, 2.8], pos: [0, 3.0, 0.7], rotZ: HPI, color: 0x868d94, tex: "metal", metalness: 0.7, roughness: 0.42 },
        { shape: "cylinder", dims: [0.04, 1.4], pos: [-1.4, 1.5, 0], rotX: HPI, color: 0x868d94, tex: "metal", metalness: 0.7, roughness: 0.42 },
        { shape: "cylinder", dims: [0.04, 1.4], pos: [1.4, 1.5, 0], rotX: HPI, color: 0x868d94, tex: "metal", metalness: 0.7, roughness: 0.42 },
        { shape: "cylinder", dims: [0.04, 1.4], pos: [-1.4, 3.0, 0], rotX: HPI, color: 0x868d94, tex: "metal", metalness: 0.7, roughness: 0.42 },
        { shape: "cylinder", dims: [0.04, 1.4], pos: [1.4, 3.0, 0], rotX: HPI, color: 0x868d94, tex: "metal", metalness: 0.7, roughness: 0.42 },
        { shape: "cylinder", dims: [0.035, 3.3], pos: [0, 2.25, 0.7], rotZ: 1.0, color: 0x7c838a, tex: "metal", metalness: 0.7, roughness: 0.42 },
        { shape: "cylinder", dims: [0.035, 3.3], pos: [0, 2.25, -0.7], rotZ: -1.0, color: 0x7c838a, tex: "metal", metalness: 0.7, roughness: 0.42 },
        { shape: "box", dims: [3.0, 0.08, 1.5], pos: [0, 3.06, 0], color: 0x9a7850, tex: "wood", grime: false },
        { shape: "box", dims: [3.0, 0.16, 0.04], pos: [0, 3.18, -0.73], color: 0x8a6a48, tex: "wood", grime: false },
      ] } },

      // Stone well: glossy water, windlass, bucket, tiled cap roof.
      { id: "well", label: "Well", category: "structures", thumb: "🪣", proc: { grime: 0.6, parts: [
        { shape: "cylinder", dims: [0.9, 0.85], seg: 24, pos: [0, 0.425, 0], color: 0x8d9198, tex: "stone" },
        { shape: "cylinder", dims: [0.72, 0.9], seg: 24, pos: [0, 0.44, 0], color: 0x14161a, tex: "none", roughness: 0.9 },
        { shape: "cylinder", dims: [0.7, 0.02], seg: 24, pos: [0, 0.78, 0], color: 0x1b3a44, tex: "none", roughness: 0.15, metalness: 0.1, grime: false },
        { shape: "lathe", profile: [[0.72, 0], [0.98, 0], [0.98, 0.1], [0.72, 0.1]], seg: 24, pos: [0, 0.85, 0], color: 0x878d95, tex: "stone", grime: false },
        { shape: "box", dims: [0.12, 2.1, 0.12], pos: [-1.02, 1.05, 0], color: 0x77573a, tex: "board" },
        { shape: "box", dims: [0.12, 2.1, 0.12], pos: [1.02, 1.05, 0], color: 0x77573a, tex: "board" },
        { shape: "cylinder", dims: [0.09, 1.9], pos: [0, 1.85, 0], rotZ: HPI, color: 0x8a6a48, tex: "wood", grime: false },
        { shape: "box", dims: [0.26, 0.07, 0.07], pos: [1.05, 1.85, 0], color: 0x5f4630, tex: "none", roughness: 0.7, grime: false },
        { shape: "cylinder", dims: [0.02, 0.55], pos: [0.3, 1.58, 0], color: 0xb9a883, tex: "none", roughness: 0.9, grime: false },
        { shape: "cylinder", dims: [0.13, 0.22], rTop: 0.17, pos: [0.3, 1.2, 0], color: 0x9aa2ab, tex: "metal", metalness: 0.6, roughness: 0.5, grime: false },
        { shape: "box", dims: [2.3, 0.09, 0.95], pos: [0, 2.36, 0.36], rotX: 0.626, color: 0x7a4a44, tex: "rooftile", grime: false },
        { shape: "box", dims: [2.3, 0.09, 0.95], pos: [0, 2.36, -0.36], rotX: -0.626, color: 0x7a4a44, tex: "rooftile", grime: false },
      ] } },

      // Market stall: counter, canvas canopy, valance, a crate of goods.
      { id: "stall", label: "Stall", category: "structures", thumb: "🎪", proc: { grime: 0.4, parts: [
        { shape: "box", dims: [2.9, 0.9, 0.9], pos: [0, 0.45, 0.35], bevel: 0.02, color: 0x8a6a48, tex: "wood" },
        { shape: "box", dims: [3.05, 0.08, 1.0], pos: [0, 0.94, 0.35], bevel: 0.02, color: 0xa5825a, tex: "wood", grime: false },
        { shape: "cylinder", dims: [0.055, 2.4], pos: [-1.4, 1.2, 0.95], color: 0x77573a, tex: "board" },
        { shape: "cylinder", dims: [0.055, 2.4], pos: [1.4, 1.2, 0.95], color: 0x77573a, tex: "board" },
        { shape: "cylinder", dims: [0.055, 2.4], pos: [-1.4, 1.2, -0.75], color: 0x77573a, tex: "board" },
        { shape: "cylinder", dims: [0.055, 2.4], pos: [1.4, 1.2, -0.75], color: 0x77573a, tex: "board" },
        { shape: "box", dims: [3.3, 0.07, 2.1], pos: [0, 2.52, 0.1], rotX: 0.28, color: 0xb8543f, tex: "plaster", grime: false },
        { shape: "box", dims: [3.3, 0.2, 0.05], pos: [0, 2.15, 1.13], color: 0xc9c2b4, tex: "plaster", grime: false },
        { shape: "box", dims: [0.8, 0.5, 0.6], pos: [-0.9, 1.23, 0.3], rotY: 0.2, color: 0x9c7a52, tex: "wood", grime: false },
      ] } },

      // Street lamp: lathe base, tapered pole, glowing head. Objects, not
      // builder — it's furniture you scatter.
      { id: "lamp", label: "Lamp", category: "objects", thumb: "💡", proc: { grime: 0.5, parts: [
        { shape: "lathe", profile: [[0.22, 0], [0.22, 0.08], [0.12, 0.14], [0.1, 0.5]], seg: 20, pos: [0, 0, 0], color: 0x3d4248, tex: "none", metalness: 0.75, roughness: 0.4 },
        { shape: "cylinder", dims: [0.07, 2.9], rTop: 0.05, pos: [0, 1.95, 0], color: 0x3d4248, tex: "none", metalness: 0.75, roughness: 0.4 },
        { shape: "cylinder", dims: [0.045, 0.75], pos: [0.35, 3.38, 0], rotZ: HPI, color: 0x3d4248, tex: "none", metalness: 0.75, roughness: 0.4 },
        { shape: "box", dims: [0.34, 0.22, 0.34], pos: [0.72, 3.32, 0], bevel: 0.03, color: 0x33383e, tex: "none", metalness: 0.75, roughness: 0.4 },
        { shape: "box", dims: [0.26, 0.14, 0.26], pos: [0.72, 3.24, 0], tex: "none", color: 0x2a2119, emissive: 0xffc678, emissiveIntensity: 2.2 },
        { shape: "cone", dims: [0.26, 0.18, 4], pos: [0.72, 3.52, 0], color: 0x33383e, tex: "none", metalness: 0.75, roughness: 0.4, grime: false },
      ] } },

      // Campfire: stone ring, leaning logs, ember glow.
      { id: "campfire", label: "Campfire", category: "nature", thumb: "🔥", proc: { parts: [
        { shape: "box", dims: [0.28, 0.22, 0.2], pos: [0, 0.1, 0.72], color: 0x8b8f94, tex: "stone" },
        { shape: "box", dims: [0.28, 0.22, 0.2], pos: [0.509, 0.1, 0.509], rotY: 0.785, color: 0x84888d, tex: "stone" },
        { shape: "box", dims: [0.28, 0.22, 0.2], pos: [0.72, 0.1, 0], rotY: 1.571, color: 0x8b8f94, tex: "stone" },
        { shape: "box", dims: [0.28, 0.22, 0.2], pos: [0.509, 0.1, -0.509], rotY: 2.356, color: 0x84888d, tex: "stone" },
        { shape: "box", dims: [0.28, 0.22, 0.2], pos: [0, 0.1, -0.72], color: 0x8b8f94, tex: "stone" },
        { shape: "box", dims: [0.28, 0.22, 0.2], pos: [-0.509, 0.1, -0.509], rotY: 0.785, color: 0x84888d, tex: "stone" },
        { shape: "box", dims: [0.28, 0.22, 0.2], pos: [-0.72, 0.1, 0], rotY: 1.571, color: 0x8b8f94, tex: "stone" },
        { shape: "box", dims: [0.28, 0.22, 0.2], pos: [-0.509, 0.1, 0.509], rotY: 2.356, color: 0x84888d, tex: "stone" },
        { shape: "cylinder", dims: [0.09, 0.85], pos: [0.18, 0.3, 0], rotZ: 1.1, color: 0x5e4630, tex: "wood" },
        { shape: "cylinder", dims: [0.09, 0.85], pos: [-0.18, 0.3, 0], rotZ: -1.1, color: 0x5e4630, tex: "wood" },
        { shape: "cylinder", dims: [0.09, 0.85], pos: [0, 0.3, 0.18], rotX: 1.1, color: 0x5e4630, tex: "wood" },
        { shape: "cylinder", dims: [0.09, 0.85], pos: [0, 0.3, -0.18], rotX: -1.1, color: 0x5e4630, tex: "wood" },
        { shape: "sphere", dims: [0.26], pos: [0, 0.18, 0], tex: "none", color: 0x241207, emissive: 0xff6a22, emissiveIntensity: 2.2 },
        { shape: "cone", dims: [0.2, 0.55, 10], pos: [0, 0.75, 0], tex: "none", color: 0x2a1508, emissive: 0xffb03a, emissiveIntensity: 2.6 },
      ] } },
    ],
  },
  {
    // Street pack: the pieces a CITY needs that a hamlet never did. Streets
    // and multi-storey shells are generated from block-shapes.js rather than
    // hand-placed — a six-storey block is the same spec as a three-storey one
    // with one number changed, and neither costs more meshes than the other.
    id: "street",
    label: "Street",
    items: [
      // Runs along X on the 6 m module, like wall and fence, so a row lays
      // with the same alongTo() the perimeter op already uses.
      { id: "road", label: "Road", category: "street", thumb: "🛣", proc: roadParts() },
      { id: "road-plain", label: "Road (plain)", category: "street", thumb: "▬", proc: roadParts({ markings: "none" }) },
      { id: "crossing", label: "Crossing", category: "street", thumb: "🦓", proc: roadParts({ markings: "zebra" }) },
      { id: "junction", label: "Junction", category: "street", thumb: "✚", proc: junctionParts() },
      { id: "plaza", label: "Plaza", category: "street", thumb: "⬜", proc: plazaParts() },

      // Free-standing blocks. Frontage faces +z.
      { id: "block-low", label: "Block · 3", category: "structures", thumb: "🏢",
        proc: buildingParts({ floors: 3, w: 11, d: 10, bays: 3 }) },
      { id: "block-mid", label: "Block · 6", category: "structures", thumb: "🏢",
        proc: buildingParts({ floors: 6, w: 12, d: 11, bays: 4 }) },
      { id: "block-high", label: "Tower · 12", category: "structures", thumb: "🏙",
        proc: buildingParts({ floors: 12, w: 11, d: 11, bays: 3, wallColor: 0x9aa3ad }) },
      // Near-square on purpose: the pyramid roof only lands on the corners
      // of a square footprint (see block-shapes.js).
      { id: "civic", label: "Civic", category: "structures", thumb: "🏛",
        proc: buildingParts({ floors: 2, w: 14, d: 13, bays: 4, roof: "hip", floorH: 4.2,
          wallColor: 0xc2bcae, roofColor: 0x6f4a4a, roofTex: "shingle" }) },

      // Stacked masses. Each tier is a full shell, so these cost more than a
      // plain block — but the cost is per TIER, not per storey, so a 21-storey
      // spire is still three shells. The setbacks leave terraces, and every
      // terrace head carries walkway ports, which is what the composer's
      // connection pass joins into bridges.
      { id: "block-stack", label: "Stack · 3", category: "structures", thumb: "🏗",
        proc: buildingParts({ floors: 12, tiers: 3, setback: 0.18, shift: 0.5,
          w: 13, d: 12, bays: 4, wallColor: 0x8d939b }) },
      { id: "block-spire", label: "Spire · 4", category: "structures", thumb: "🗼",
        proc: buildingParts({ floors: 22, tiers: 4, setback: 0.2, shift: 0.7,
          w: 14, d: 13, bays: 4, wallColor: 0x7f858d, glowIntensity: 1.6 }) },

      // Row units: exactly 6 m wide, blind party walls, no roof overhang
      // across the run — two of them abut into one continuous street wall.
      { id: "row-house", label: "Row House", category: "structures", thumb: "🏘",
        proc: buildingParts({ floors: 2, w: 6, d: 8.5, bays: 2, roof: "gable", sides: "party",
          wallColor: 0xbfae95 }) },
      { id: "row-shop", label: "Row Shop", category: "structures", thumb: "🏪",
        proc: buildingParts({ floors: 3, w: 6, d: 8.5, bays: 2, sides: "party",
          wallColor: 0xa8a89c, glowIntensity: 1.9 }) },

      // Planting: displaced-blob canopies wearing the foliage texture kind
      // (block-shapes.js) — an ecosystem's worth of species, not lollipops.
      { id: "tree", label: "Oak", category: "nature", thumb: "🌳", proc: treeParts() },
      { id: "tree-small", label: "Sapling", category: "nature", thumb: "🌱", proc: treeParts({ h: 4, spread: 1.6, seed: 17 }) },
      { id: "pine", label: "Pine", category: "nature", thumb: "🌲", proc: pineParts() },
      { id: "birch", label: "Birch", category: "nature", thumb: "🌳", proc: birchParts() },
      { id: "bush", label: "Bush", category: "nature", thumb: "🌿", proc: bushParts() },
      { id: "hedge", label: "Hedge", category: "nature", thumb: "🌿", proc: hedgeParts() },
    ],
  },
  {
    /* Land pack: the pieces a WORLD needs that a district never did.
     *
     * Everything above builds a settlement — a street, a terrace, a block. A
     * world grammar needs the other scale: the landmark the whole map points
     * at, the ways that are not streets, the enclosure round a keep, and the
     * handful of small things (a plot of crops, a jetty, a palm) whose absence
     * is what made every generated place read as the same generated place.
     *
     * Three castles, and they are ONE FUNCTION with three sets of numbers —
     * see castleParts. Their roofs are split across two texture roles on
     * purpose: `shingle` for spires and cones, `rooftile` for everything
     * lower, so a theme colours the silhouette separately from the mass and
     * the same geometry comes out royal blue in one world and red in another.
     */
    id: "land",
    label: "Land",
    items: [
      // Slender, many-spired, gold-finialled: the ceremonial landmark. Tall
      // enough (≈96 m) to be the first thing resolved from two kilometres up.
      /* The spires are AUTHORED blue. Doctrine says colour belongs to the
         theme, but hex→linear conversion is merciless to minority channels:
         the old warm brown kept 0.08 of a blue channel, and no multiplier a
         theme can sanely hold turns 0.08 into a royal spire. A blue-forward
         author gives every theme a real channel to shape — storybook deepens
         it, weathered greys it, parade would warm it. */
      { id: "castle-spires", label: "Spired Castle", category: "structures", thumb: "🏰",
        proc: castleParts({ w: 24, d: 21, floors: 5, floorH: 5.0, bays: 4, terraces: 2, terraceStep: 4.2,
          towers: 8, towerR: 3.0, towerTop: 1.34, spire: 3.6, centre: 2.05, centreR: 4.6,
          wallColor: 0xdcd6c6, trimColor: 0xbab4a4, roofColor: 0x6a86e8 }) },

      // Squat, symmetrical, red-coned: the playful kingdom's centrepiece. Its
      // recognition is the WIDTH and the cluster of cones, not the reach.
      /* Both castles author their masonry LIGHT for the same linear-space
         reason the spires author blue: the stone texture multiplies at half
         luminance, and a keep that has to come out cream has to go in
         nearly white. */
      { id: "castle-round", label: "Round Castle", category: "structures", thumb: "🏰",
        proc: castleParts({ w: 30, d: 26, floors: 3, floorH: 4.6, bays: 5, terraces: 2, terraceStep: 5.0,
          towers: 4, towerR: 4.4, towerTop: 1.28, spire: 2.3, centre: 1.7, centreR: 6.2,
          wallColor: 0xe9e2d0, trimColor: 0xc4bcaa, roofColor: 0xd86258 }) },

      // The citadel: the largest mass in the catalogue, a curtain wall round
      // it, and a gatehouse on the approach. Dark-shouldered by dressing, not
      // by authored colour — the geometry is the same grey stone as the rest.
      { id: "castle-citadel", label: "Citadel", category: "structures", thumb: "🏰",
        proc: castleParts({ w: 38, d: 30, floors: 7, floorH: 5.4, bays: 5, terraces: 2, terraceStep: 6.0,
          towers: 6, towerR: 4.6, towerTop: 1.26, spire: 3.1, centre: 1.78, centreR: 6.0,
          wallColor: 0x9aa0a4, trimColor: 0x8a9096, roofColor: 0x5f5a5e, hall: false,
          curtain: { r: 58, h: 9, thickness: 2.0, towers: 5, towerR: 4.2, gateWidth: 11 } }) },

      // Enclosure runs. Crenellations are points in one extrude, not boxes —
      // sixty metres of wall costs two meshes a tile.
      { id: "rampart", label: "Rampart", category: "builder", thumb: "🧱", proc: curtainWallParts() },
      // Warmer stone than the intact rampart: cold blue-grey sticks strewn
      // over an olive plain read as debris rather than as masonry.
      { id: "ruin-wall", label: "Ruined Wall", category: "builder", thumb: "🧱",
        proc: curtainWallParts({ h: 4.6, ruin: 0.62, merlons: 3, seed: 11, color: 0x9a9184 }) },

      /* Ways that are not streets. The street pack's `road` is asphalt with a
         painted centre line; laying it through a coastal village is what makes
         a fairytale kingdom look like a business park. */
      { id: "lane", label: "Dirt Lane", category: "street", thumb: "〰",
        proc: pathParts({ width: 4.2, color: 0xb09168, rise: 0.09, verge: 0.5, vergeColor: 0x8e9a5e,
          vergeTex: "foliage" }) },
      { id: "track", label: "Old Road", category: "street", thumb: "〰",
        proc: pathParts({ width: 5.4, color: 0x8f8a78, tex: "stone", rise: 0.12, verge: 0.7,
          vergeColor: 0x7d8452, vergeTex: "foliage" }) },
      { id: "avenue", label: "Avenue", category: "street", thumb: "▤",
        proc: pathParts({ width: 14, color: 0xa8a496, tex: "stone", rise: 0.16, verge: 1.1,
          vergeColor: 0x9aa0a8, inlay: 2.6, inlayColor: 0xc6c0ae }) },

      /* The old street: same cross-section and same 9 m junction as the
         modern one, so `streets` lays a market town with the arithmetic it
         already has — setts instead of tarmac, and no painted centre line. */
      { id: "setts", label: "Setts", category: "street", thumb: "▨",
        proc: roadParts({ markings: "none", surface: STREET_SURFACES.setts, kerb: STREET_SURFACES.flags }) },
      { id: "junction-setts", label: "Setts Junction", category: "street", thumb: "✚",
        proc: junctionParts({ surface: STREET_SURFACES.setts, kerb: STREET_SURFACES.flags }) },

      { id: "jetty", label: "Jetty", category: "builder", thumb: "🪵", proc: jettyParts() },
      { id: "crops", label: "Crops", category: "nature", thumb: "🌾", proc: cropParts() },
      { id: "fountain", label: "Fountain", category: "structures", thumb: "⛲", proc: fountainParts() },
      { id: "palm", label: "Palm", category: "nature", thumb: "🌴", proc: palmParts() },

      /* Small buildings, in two roofing materials on purpose. `cottage` roofs
         in `rooftile` and `cottage-slate` in `shingle`, so one theme can put
         red on some roofs and blue on others down the same lane — which is
         what a village of individual houses looks like from the air, and what
         a single-role dressing can never produce. */
      { id: "cottage", label: "Cottage", category: "structures", thumb: "🏡",
        proc: buildingParts({ floors: 1, w: 8, d: 7.5, bays: 2, roof: "gable", floorH: 3.5,
          wallColor: 0xc9c3b5, roofColor: 0x9a6a55, roofTex: "rooftile" }) },
      { id: "cottage-slate", label: "Slate Cottage", category: "structures", thumb: "🏡",
        proc: buildingParts({ floors: 1, w: 8.5, d: 7, bays: 3, roof: "gable", floorH: 3.5,
          wallColor: 0xc4c0b4, roofColor: 0x505c78, roofTex: "shingle" }) },
      /* The pink house. Authored bright, because everything downstream takes
         a bite out of it: the plaster map multiplies at about 0.6 luminance,
         the grime term darkens the metre nearest the ground, and the shaded
         side of a gable is half the building. A wall authored at the colour
         you want is a wall that renders maroon. */
      /* Painted board, not plaster: the plaster map multiplies at half
         luminance and no tint recovers bright pink through it — the villa
         rendered mauve in every frame, with its own reference photo saying
         otherwise. `none` is the paint role: flat colour, themed by the
         paint tint, which is what a pink-painted beach house actually is. */
      { id: "villa", label: "Villa", category: "structures", thumb: "🏠",
        proc: buildingParts({ floors: 2, w: 9.5, d: 8.5, bays: 3, roof: "gable", floorH: 3.3,
          // White trim, which is the one detail the reference photograph of
          // this house names. Left to the default it came out the catalogue's
          // cold structural grey — a pink beach house edged in slate.
          wallColor: 0xf0a8bc, wallTex: "none", trimColor: 0xd0ccc4,
          roofColor: 0xc46050, roofTex: "rooftile" }) },
      { id: "hall", label: "Hall", category: "structures", thumb: "🏫",
        proc: buildingParts({ floors: 2, w: 15, d: 12, bays: 4, roof: "gable", floorH: 3.9,
          wallColor: 0xcac5b7, roofColor: 0x9a6a55, roofTex: "rooftile" }) },
      { id: "study", label: "Field Study", category: "structures", thumb: "🔭",
        proc: studyParts() },
      { id: "lodge", label: "Lodge", category: "structures", thumb: "🛖",
        proc: buildingParts({ floors: 1, w: 7.5, d: 6.5, bays: 2, roof: "gable", floorH: 3.2,
          wallColor: 0xbdb6a6, roofColor: 0x8a5f4e, roofTex: "rooftile" }) },
    ],
  },
];

export const CATEGORIES = ["all", "builder", "street", "nature", "structures", "objects", "creatures"];

export function allItems() {
  return PACKS.flatMap((p) => p.items.map((it) => ({ ...it, pack: p.id })));
}

export function findItem(ref) {
  return allItems().find((it) => `${it.pack}/${it.id}` === ref || it.id === ref) || null;
}
