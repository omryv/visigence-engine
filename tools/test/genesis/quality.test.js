// Quality-preset contracts. These are the numbers that decide what a visitor
// actually sees, and one of them was wrong for a long time: `shadows` was a
// top-two-tier flag, so every Intel desktop, every masked GPU under eight
// cores and every phone rendered a world lit by a sun that cast nothing.
// A flag that turns off the most visible thing a renderer does needs a test.
import { test, eq, ok, report } from "../kernel/harness.js";
import { QUALITY_PRESETS, willComposite } from "../../../src/genesis/render/quality.js";

const TIERS = ["low", "medium", "high", "ultra"];

test("every tier exists and is ordered", () => {
  for (const t of TIERS) ok(QUALITY_PRESETS[t], `missing tier ${t}`);
  eq(Object.keys(QUALITY_PRESETS).length, TIERS.length);
});

test("the sun casts on every tier", () => {
  // The whole point of the change this test locks in. If a preset ever goes
  // back to shadows:false, the world it renders is flat-lit and the tier that
  // does it is, in practice, most desktops.
  for (const t of TIERS) {
    eq(QUALITY_PRESETS[t].shadows, true, `tier ${t} casts no sun shadows;`);
    ok(QUALITY_PRESETS[t].shadowRes >= 1024, `tier ${t} shadow map is under 1024;`);
  }
});

test("shadow resolution never decreases as tiers rise", () => {
  for (let i = 1; i < TIERS.length; i++) {
    const lo = QUALITY_PRESETS[TIERS[i - 1]], hi = QUALITY_PRESETS[TIERS[i]];
    ok(hi.shadowRes >= lo.shadowRes, `${TIERS[i]} has a smaller shadow map than ${TIERS[i - 1]}`);
  }
});

test("vegetation joins the shadow pass only where it is affordable", () => {
  // grassShadows is the flag that genuinely doubles the shadow pass's draw
  // count — unlike `shadows`, it earns being tier-gated.
  eq(QUALITY_PRESETS.low.grassShadows, false);
  eq(QUALITY_PRESETS.medium.grassShadows, false);
  eq(QUALITY_PRESETS.high.grassShadows, true);
  eq(QUALITY_PRESETS.ultra.grassShadows, true);
});

test("a tier that cannot cast cannot claim contact shadows either", () => {
  // Contact shadows are the short-range half of the same problem; without a
  // cascade behind them they would be the ONLY occlusion in the frame and
  // would read as dirt rather than as shadow.
  for (const t of TIERS) {
    const p = QUALITY_PRESETS[t];
    if (p.contactShadows) ok(p.shadows, `tier ${t} has contact shadows without a shadow map`);
  }
});

test("every tier carries every flag the engine reads", () => {
  // A missing key is `undefined`, which is falsy, which silently disables a
  // feature on exactly one tier — the hardest kind of graphics bug to see.
  const keys = Object.keys(QUALITY_PRESETS.ultra);
  for (const t of TIERS) {
    for (const k of keys) {
      ok(k in QUALITY_PRESETS[t], `tier ${t} is missing ${k}`);
      ok(QUALITY_PRESETS[t][k] !== undefined, `tier ${t} has ${k} undefined`);
    }
  }
});

test("every tier blooms", () => {
  /* The same argument the shadow test above makes, applied to the other
     feature that used to be switched off for most of the audience. With
     post false, an emissive material is just a colour: a lit window at
     midnight, a lamp in a doorway and an open fire are all exactly as bright
     as the wall behind them. The HDR values were always there; nothing in the
     low tier's pipeline ever turned them into light. */
  for (const t of TIERS) {
    eq(QUALITY_PRESETS[t].post, true, `tier ${t} runs no post pipeline, so nothing in it glows;`);
  }
});

test("a tier that composites pays for its own antialiasing", () => {
  /* THE INVARIANT THAT MAKES BLOOM ON THE LOW TIER SAFE, and the one that is
     easiest to lose by tidying.

     The renderer is built with `antialias: true`, so a tier that draws
     straight to the canvas gets MSAA on the default framebuffer for free.
     The moment the frame is composited from an offscreen target, that stops
     being true — the canvas is drawn by one fullscreen triangle with no
     interior edges, and multisampling it antialiases nothing. So a tier
     running post has exactly two possible sources of antialiasing: temporal
     accumulation, or MSAA on the scene target via postSamples. With neither,
     it renders a fully aliased frame while `antialias: true` sits in the
     constructor looking like it is doing something.

     That is how adding bloom to the low tier could have been a downgrade —
     trading every antialiased edge on the device with the least resolution to
     spare for a glow. postSamples is what stops it, which is why deleting it
     as dead configuration would have been the wrong reading: it is unused on
     the accumulating tiers and load-bearing on this one. */
  for (const t of TIERS) {
    const p = QUALITY_PRESETS[t];
    if (!p.post) continue;
    ok(p.taa || p.postSamples >= 2,
      `tier ${t} composites with neither taa nor postSamples — its frame has no antialiasing at all;`);
  }
});

test("occlusion is never asked for without the accumulation that makes it work", () => {
  // Eight samples a frame is noise. TAA is what turns it into a couple of
  // hundred, and the pipeline drops ssao without it — so a preset that sets
  // one without the other is stating an intent the engine will not honour.
  for (const t of TIERS) {
    const p = QUALITY_PRESETS[t];
    if (p.ssao || p.contactShadows) {
      ok(p.taa, `tier ${t} asks for screen-space occlusion without temporal accumulation;`);
    }
  }
});

test("the canvas is only asked to multisample when it would do something", () => {
  /* `antialias: true` is a CONTEXT-CREATION attribute — it cannot be changed
     after the renderer exists, which is why the tier is probed on a throwaway
     context first. What it buys is a second, multisampled copy of the whole
     drawing buffer; what that copy is worth depends entirely on what gets
     drawn to the canvas.

     Every tier composites now, and a composited frame arrives as one
     fullscreen triangle with no interior edges — so the multisampling
     antialiases nothing while still costing tens of megabytes on a phone at
     devicePixelRatio 2. Only the float-less fallback, which draws geometry
     straight to the canvas, genuinely wants it. */
  for (const t of TIERS) {
    ok(willComposite({ tier: t, floatColor: true }),
      `tier ${t} would not composite on a device with float colour, so the tier table and the pipeline disagree`);
    ok(!willComposite({ tier: t, floatColor: false }),
      `tier ${t} claims it would composite without EXT_color_buffer_float, which the pipeline refuses to do`);
  }
  // An unknown tier must not be read as "composites" — that would drop the
  // canvas multisampling on a device whose frame still goes straight there.
  ok(!willComposite({ tier: "nonsense", floatColor: true }), "an unknown tier is treated as compositing");
});

test("budgets rise with the tier", () => {
  const rising = ["grassCount", "rainCount", "snowCount", "anisotropy", "pixelRatio"];
  for (let i = 1; i < TIERS.length; i++) {
    const lo = QUALITY_PRESETS[TIERS[i - 1]], hi = QUALITY_PRESETS[TIERS[i]];
    for (const k of rising) {
      ok(hi[k] >= lo[k], `${k} drops from ${TIERS[i - 1]} (${lo[k]}) to ${TIERS[i]} (${hi[k]})`);
    }
  }
});

report("quality");
