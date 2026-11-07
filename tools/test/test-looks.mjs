// node tools/test/test-looks.mjs
import assert from 'node:assert/strict';
import { LOOKS, lookFor, studioProfile } from '../../src/config/looks.js';
import { PROFILES } from '../../src/config/quality.js';

// Every theme/lighting pair the studio offers has a complete look.
for (const theme of ['arcade']) for (const lighting of ['night', 'dawn']) {
  const look = lookFor({ theme, lighting });
  assert(look && look.post && look.lighting, `${theme}/${lighting} look`);
  assert.equal(look, LOOKS[theme][lighting]);
  for (const k of ['saturation', 'contrast', 'split', 'vignette', 'grain', 'bloomScale']) assert.equal(typeof look.post[k], 'number', `${theme}/${lighting} post.${k}`);
  assert.equal(look.post.shadowTint.length, 3); assert.equal(look.post.highlightTint.length, 3);
  {
    for (const k of ['elevation', 'azimuth', 'sunColor', 'zenith', 'horizon', 'ground']) assert(look.sky[k] !== undefined, `${theme}/${lighting} sky.${k}`);
    assert(look.sky.elevation > 0 && look.sky.elevation < 90);
    for (const k of ['sun', 'sunColor', 'hemiSky', 'hemiGround', 'hemi', 'env', 'exposure', 'wet']) assert(look.lighting[k] !== undefined, `${theme}/${lighting} lighting.${k}`);
    assert(look.fog.density > 0 && look.fog.falloff > 0);
  }
}
assert.equal(lookFor({ theme: 'nothing', lighting: 'noon' }), LOOKS.arcade.night, 'unknown pairs fall back');

// The three graphics words map onto a monotone ladder of what the post stack builds.
const perf = studioProfile('performance', PROFILES.standard), bal = studioProfile('balanced', PROFILES.standard), qual = studioProfile('quality', PROFILES.standard);
assert(!perf.postFX && !perf.ao && !perf.traa, 'performance has no post');
assert(bal.postFX && bal.ao && bal.traa && bal.film && !bal.dof && !bal.ssr, 'balanced: temporal AA, occlusion, grade');
assert(qual.postFX && qual.ao && qual.traa && qual.dof && qual.lensflare && qual.ssr, 'quality: everything the studio can use');
assert(bal.aoSamples < qual.aoSamples);
assert(perf.lights <= bal.lights && bal.lights === qual.lights);
for (const p of [perf, bal, qual]) assert(!p.volumetric && !p.motionBlur, 'the maze-only passes stay off');
console.log('PASS the studio looks and the quality ladder');
