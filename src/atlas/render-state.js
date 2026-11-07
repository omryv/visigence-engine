// What a render adds that the exported bytes do not carry, declared once, in data.
//
// WHY THIS FILE EXISTS. A picture of a reconstruction is not evidence about the
// file it came from. Any presentation layer adds light, tone mapping and a
// ground plane the glTF never carried, and a renderer that shares the file's own
// conventions will agree with the file whether or not the file is right. That is
// exactly how a texture that was upside down in every conformant loader survived
// a green board.
//
// So the additions are written down here, as data, rather than left as literals
// scattered through whatever is drawing. `certificate.js` records them as
// `viewerOnlyEffects[]` and `tools/test/atlas/certificate.mjs` requires every one to appear
// there as a DECLARED leaf — never a derived one — because these are precisely
// the quantities no verifier can recompute from the file.
//
// This module imports nothing and must keep importing nothing. It is data.

/** The roughness the baked export declares, and therefore the one to show. */
export const BAKED_ROUGHNESS = 0.86;

/**
 * What a studio presentation adds that the exported bytes do not carry.
 *
 * These are DECLARED, not hidden and not removed: a studio-lit presentation is a
 * legitimate thing for a product to do, and the price of doing it is saying so —
 * on the canvas where someone is looking at it, and in the certificate where
 * someone is auditing it. An empty list would mean the render is reproducible
 * anywhere. This list is not empty.
 */
export const VIEWER_ONLY_EFFECTS = [
  {
    id: 'studioLightRig',
    what: 'A three-point rig — 1.3 key, 0.35 fill, 0.6 rim — over 0.28 ambient,'
        + ' totalling 2.53x a single unit light. glTF carries no lights in this file and'
        + ' KHR_lights_punctual is not declared, so no engine can reproduce it. Measured'
        + ' on the test fixture over the camera-facing surface, the rig\'s multiplicative'
        + ' factor (ambient + key + fill) has a mean of 1.01 and a spread of 0.35 (sd/mean)'
        + ' where a uniform environment supplies exactly 0: it sculpts without lifting,'
        + ' and every bit of shape-from-shading in the viewer is the rig\'s.',
  },
  {
    id: 'acesToneMapping',
    what: 'ACES filmic tone mapping at exposure 1.0, applied to linear light: the atlas is'
        + ' decoded from sRGB before it is lit and encoded once afterwards. Measured against'
        + ' the same rig with a plain clip: +2.2% mean level on the test fixture. The'
        + ' rendered mean luminance sits at 1.06x the photograph\'s on the fixture and 1.04x'
        + ' on a three-view character; it was 2.94x and 1.58x when the sRGB bytes were lit'
        + ' as linear and encoded a second time, with 26% of the character\'s visible'
        + ' surface clipped to white.',
  },
  {
    id: 'contactShadow',
    what: 'A shadow map, and a ground plane at 0.42 opacity that catches it. The plane'
        + ' is not part of the mesh and is not exported, so the contact shadow that seats'
        + ' the object exists in this viewer and nowhere else.',
  },
];

/**
 * The same disclosure as one sentence, for a surface that has room for one.
 *
 * Lives here so the sentence shown to a reader and the leaf in the certificate
 * come out of one module. A disclosure that is only in the document is a
 * disclosure for auditors; the person being shown the render is the one who
 * needs it.
 */
export const VIEWER_ONLY_NOTICE =
  'Viewed under this viewer\'s studio lighting — other engines will differ.';
