// Procedural sky dome + lighting rig. One class owns: gradient sky shader,
// sun disc, stars, cloud layer (cheap slab fbm, extra octaves when the
// quality preset allows "volumetric"), the sun/hemisphere lights and the fog
// colour — all driven by params.sky.timeOfDay.

import * as THREE from "three";
import { Atmosphere } from "../render/atmosphere.js";
import "../render/chunks.js";   // registers wg_output / wg_noise
import { sunDirection, sunAltitudeSine } from "./sun.js";

const VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = modelViewMatrix * vec4(position, 1.0);
    gl_Position = (projectionMatrix * p).xyww; // depth = far plane
  }
`;

const FRAG = /* glsl */`
  precision highp float;
#include <wg_output>
#include <wg_noise>
  varying vec3 vDir;
  uniform vec3 uSunDir;
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uHaze;         // matches the aerial-perspective haze exactly
  uniform float uHazeAmt;     // author's haze dial, 0 = clear sky to the horizon
  uniform float uNight;       // 0 day … 1 night
  uniform float uCloudCover;  // 0..1
  uniform float uCloudScale;
  uniform float uTime;
  uniform float uVolumetric;  // 0 or 1

  /* The dome's own fbm STAYS here, deliberately. It is not the water's fbm
     under another name: this one takes a dynamic octave count (the volumetric
     tier buys extra octaves), steps at lacunarity 2.03 with a +19.7 offset per
     octave, and is left unnormalised. Water's runs three unrolled octaves at
     2.13/4.41 with weights that sum to one. Same shape, different function —
     merging them would be a merge of two tunings, not of two copies. */
  float fbm(vec2 p, int oct) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++) {
      if (i >= oct) break;
      s += a * wgNoise(p); p = p * 2.03 + 19.7; a *= 0.5;
    }
    return s;
  }

  void main() {
    vec3 d = normalize(vDir);
    float t = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(uHorizon, uZenith, pow(t, 0.62));

    // Horizon haze: the last few degrees above the skyline blend into the
    // SAME colour the aerial perspective fades land into, so the world edge
    // dissolves instead of ending on a hard line.
    float band = 1.0 - smoothstep(0.0, 0.16, abs(d.y));
    col = mix(col, uHaze, band * 0.72 * uHazeAmt);

    // Sun disc + halo. The disc is limb-darkened (brighter core, softer rim)
    // and sits inside a broad forward-scattered glow that swells and reddens
    // as the sun nears the horizon — the dusty look of real low sun.
    float sd = max(dot(d, uSunDir), 0.0);
    float low = clamp(1.0 - uSunDir.y * 2.2, 0.0, 1.0);
    float disc = pow(sd, mix(1400.0, 520.0, low));
    disc *= 0.75 + 0.25 * pow(sd, 5000.0);            // limb darkening
    float halo = pow(sd, mix(30.0, 9.0, low)) * (0.34 + low * 0.5)
               + pow(sd, 3.0) * 0.05 * low;           // wide dusk scatter
    vec3 sunCol = mix(vec3(1.0, 0.96, 0.88), vec3(1.0, 0.46, 0.22), low);
    col += sunCol * (disc * 3.4 + halo) * (1.0 - uNight);

    // Moon: reuse the sun path mirrored, cold and dim
    float md = max(dot(d, -uSunDir), 0.0);
    col += vec3(0.55, 0.62, 0.75) * (pow(md, 260.0) * 1.4 + pow(md, 24.0) * 0.06) * uNight;

    // Stars fade in at night, only above the horizon
    if (uNight > 0.02 && d.y > 0.0) {
      vec2 sp = d.xz / (d.y + 0.35) * 140.0;
      float star = step(0.9985, wgHash(floor(sp)));
      float tw = 0.6 + 0.4 * sin(uTime * 2.0 + wgHash(floor(sp) + 7.0) * 40.0);
      col += vec3(star) * tw * uNight * smoothstep(0.0, 0.15, d.y);
    }

    // Clouds: fbm slab projected on the dome, softened at the edges and
    // silver-lined where the sun sits behind them.
    if (d.y > 0.015 && uCloudCover > 0.01) {
      vec2 cp = d.xz / (d.y + 0.22) * 1.7 * uCloudScale + vec2(uTime * 0.008, uTime * 0.003);
      int oct = uVolumetric > 0.5 ? 6 : 4;
      float c = fbm(cp, oct);
      // Wider ramp than before: wispy edges instead of a hard cut-out.
      float cov = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.42, c);
      // Cheap self-shadowing: resample toward the sun for a lit edge
      float lit = fbm(cp + uSunDir.xz * 0.35, 3);
      vec3 cloudCol = mix(vec3(0.5, 0.53, 0.6), vec3(1.06, 1.01, 0.97), clamp(lit + 0.25, 0.0, 1.0));
      // Sun behind cloud → bright rim; low sun tints the whole underside.
      float rim = pow(max(dot(d, uSunDir), 0.0), 14.0) * (1.0 - cov * 0.55);
      cloudCol += mix(vec3(1.0, 0.92, 0.8), vec3(1.0, 0.6, 0.34), low) * rim * 0.9 * (1.0 - uNight);
      cloudCol = mix(cloudCol, cloudCol * vec3(0.28, 0.3, 0.4), uNight);
      float horizonFade = smoothstep(0.015, 0.12, d.y);
      col = mix(col, cloudCol, cov * horizonFade * 0.92);
      // Distant clouds sink into the same haze the land uses.
      col = mix(col, uHaze, band * 0.5 * uHazeAmt);
    }

    col = mix(col, col * vec3(0.09, 0.11, 0.19), uNight * (1.0 - t * 0.4));
    // Same ACES + sRGB transform three gives the lit materials: the sun can
    // now blow past 1.0 and roll off into white instead of clipping flat.
    col = wfOutput(col);
    // Dither: a smooth gradient across a whole sky is exactly where 8-bit
    // banding shows, and it is very visible on phone OLEDs.
    col += (wgHash(gl_FragCoord.xy) - 0.5) * 0.0035;
    gl_FragColor = vec4(col, 1.0);
  }
`;

/* How hazy the dome is: the author's fog dial, scaled by how thick the air
   is. `turbidity` is the number a sky model uses for exactly this — how much
   the atmosphere scatters — and until now it was WRITTEN BY EVERY WORLD IN
   THE TABLE AND READ BY NOBODY: four grammars each named an air quality, the
   exporter carried it to Unity, and the renderer had no uniform for it. So
   the sky the editor showed and the sky the export described were two
   different skies, and nothing said so.

   Relative to the default 2.2, so a world that leaves it alone is unchanged
   and one that asks for thin air (an atoll at noon) gets a cleaner horizon
   than one that asks for a hazy afternoon over a kingdom. */
function hazeAmount(density, turbidity) {
  const d = density ?? 0.35;
  const t = (turbidity ?? 2.2) / 2.2;
  return Math.min((d / 0.35) * Math.max(0.4, Math.min(1.8, t)), 2);
}

export class Sky {
  constructor({ params, palette, quality, atmos = null }) {
    this.params = params;
    // Shares the engine's exposure so the dome tone-maps exactly like the
    // land does (standalone use gets a default rig).
    this.atmos = atmos || new Atmosphere(params);
    this.uniforms = {
      uExposure: this.atmos.uniforms.uExposure,
      uWfPost: this.atmos.uniforms.uWfPost, // linear output under the HDR pipeline
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uHorizon: { value: new THREE.Color(palette.sky.horizon) },
      uZenith: { value: new THREE.Color(palette.sky.zenith) },
      uHaze: { value: new THREE.Color(palette.fog) },
      uHazeAmt: { value: hazeAmount(params.fog?.density, params.sky?.turbidity) },
      uNight: { value: 0 },
      uCloudCover: { value: params.sky.cloudCover },
      uCloudScale: { value: params.sky.cloudScale },
      uTime: { value: 0 },
      uVolumetric: { value: quality.cloudsVolumetric && params.sky.volumetric ? 1 : 0 },
    };
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 16),
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false })
    );
    this.mesh.frustumCulled = false;
    this.mesh.scale.setScalar(params.terrain.size * 4);
    this.mesh.renderOrder = -10;

    this.sun = new THREE.DirectionalLight(0xffffff, 2.6);
    this.sun.castShadow = !!quality.shadows;
    // The shadow volume is a box that TRACKS THE VIEWER (see updateShadow):
    // pinned to the world origin it only ever covered the middle of the map,
    // so anything built or walked away from centre had no shadows at all.
    this._shadowRadius = 0;
    this._shadowAt = null;
    if (quality.shadows) {
      // One cascade, so its resolution is the whole budget for shadow detail
      // at distance — the top tier spends 4096² on it. What the map cannot
      // resolve up close is picked up by the depth-buffer contact shadows in
      // the post pipeline, which is the cheaper half of the same problem.
      const res = quality.shadowRes || 2048;
      this.sun.shadow.mapSize.set(res, res);
      this.sun.shadow.bias = -0.0002;
      // Terrain casts onto itself at grazing sun angles; normalBias is the
      // knob that kills the resulting acne without detaching contact shadows.
      this.sun.shadow.normalBias = 1.2;
      this._setShadowRadius(Math.min(params.terrain.size * 0.06, 260));
    }
    this.hemi = new THREE.HemisphereLight(palette.sky.zenith, 0x4a4038, 0.55);
    this.fogColor = new THREE.Color(palette.fog);
    this.night = 0;       // 0 day … 1 night, mirrored to readers each setTimeOfDay
    this._weatherDim = 1; // rain/snow pull the sun down without touching params
    this.hemiScale = 1;   // engine halves this when sky IBL carries the ambient
    this.setTimeOfDay(params.sky.timeOfDay);
  }

  // Overcast dimming for weather: 1 = clear, ~0.55 = rain/snow. Re-applies
  // the current time of day so every derived intensity follows.
  setWeatherDim(f) {
    this._weatherDim = f;
    this.setTimeOfDay(this.params.sky.timeOfDay);
  }

  addTo(scene) { scene.add(this.mesh, this.sun, this.sun.target, this.hemi); }

  _setShadowRadius(r) {
    // Proportional deadband: the radius now spans 180 m to a few kilometres,
    // and a flat one-metre gate would rebuild the projection on every frame
    // of a zoom.
    if (Math.abs(r - this._shadowRadius) < Math.max(1, this._shadowRadius * 0.02)) return;
    this._shadowRadius = r;
    const cam = this.sun.shadow.camera;
    Object.assign(cam, { left: -r, right: r, top: r, bottom: -r, near: 1, far: r * 8 });
    cam.updateProjectionMatrix();
    this._shadowAt = null; // force a re-centre
  }

  /* Centre the shadow box on WHAT THE FRAME IS ABOUT, not on the eye.
     Called every frame by the engine; it only does work when the view has
     actually moved a texel or two, and it snaps to the shadow-map texel grid
     so edges don't crawl as you walk.

     This used to centre on the camera position, which is right for a walking
     viewer and wrong for every other shot this editor takes. An orbit camera
     sits OUTSIDE what it is looking at — the default view is parked off the
     plate, several hundred metres from the world it frames — so the box
     tracked a patch of open water under the lens while the terrain on screen
     had no shadow-map coverage at all. The sun was casting the whole time;
     nothing in shot was inside the volume. That is the "sunlight, 0 shadows"
     you see, and no amount of resolution fixes it.

     So: centre on the focus point, then widen to take in the ground under the
     viewer as well when that still fits.

     Radius scales with altitude, and its ceiling scales with the WORLD rather
     than being a flat 900 m. Texel size wants to stay proportional to what a
     screen pixel covers: from 4 km up the whole plate is on screen and a 3 m
     texel is finer than a pixel, while the old cap left two thirds of the
     world outside the box in exactly that shot. */
  updateShadow(camPos, groundY = 0, focus = null) {
    if (!this.sun.castShadow) return false;
    const fx = focus ? focus.x : camPos.x;
    const fz = focus ? focus.z : camPos.z;
    const fy = focus ? focus.y : groundY;
    const alt = Math.max(camPos.y - groundY, 0);
    const reach = Math.hypot(camPos.x - fx, camPos.z - fz);
    const ceiling = Math.max(this.params.terrain.size * 0.75, 900);
    this._setShadowRadius(Math.min(Math.max(180, alt * 0.9, reach + 90), ceiling));
    const r = this._shadowRadius;
    const texel = (r * 2) / this.sun.shadow.mapSize.x;
    const x = Math.round(fx / texel) * texel;
    const z = Math.round(fz / texel) * texel;
    const y = Math.round(fy / texel) * texel;
    if (this._shadowAt && this._shadowAt.x === x && this._shadowAt.z === z && this._shadowAt.y === y) return false;
    this._shadowAt = { x, y, z };
    this.sun.target.position.set(x, y, z);
    this.sun.target.updateMatrixWorld();
    this.sun.position.copy(this.uniforms.uSunDir.value).multiplyScalar(r * 3.2).add(this.sun.target.position);
    this.sun.updateMatrixWorld();
    return true;
  }

  /* Where the shadow volume is and how big, for anything that must not cull a
     caster out of it — the scatter's per-instance cull is the first such
     reader. Exposed rather than recomputed, so there is one answer. */
  get shadowRadius() { return this.sun.castShadow ? this._shadowRadius : 0; }
  get shadowCentre() { return this._shadowAt; }

  setPalette(palette) {
    this.uniforms.uHorizon.value.setHex(palette.sky.horizon);
    this.uniforms.uZenith.value.setHex(palette.sky.zenith);
    this.hemi.color.setHex(palette.sky.zenith);
    this._paletteFog = new THREE.Color(palette.fog);
    this.setTimeOfDay(this.params.sky.timeOfDay);
  }

  setTimeOfDay(tod) {
    this.params.sky.timeOfDay = tod;
    /* The curve itself lives in sky/sun.js now — one home, so the shelf can
       grade its lamp by the same sun the editor will raise and a tool can ask
       whether an authored hour has any sun above the horizon at all. `el` is
       the RAW altitude sine, which is what the night and dusk ramps below are
       written on; the direction is that sine carried through the azimuth
       sweep and the southing, which is a shallower angle. */
    const el = sunAltitudeSine(tod);
    const d = sunDirection(tod);
    const dir = new THREE.Vector3(d.x, d.y, d.z);
    this.uniforms.uSunDir.value.copy(dir);

    const night = THREE.MathUtils.clamp(-el * 4 + 0.12, 0, 1);
    const dusk = THREE.MathUtils.clamp(1 - Math.abs(el) * 3.2, 0, 1);
    this.uniforms.uNight.value = night;
    this.night = night;

    const day = 1 - night;
    // Position is re-derived per frame by updateShadow(); this is the
    // fallback placement for rigs without shadows.
    this.sun.position.copy(dir.clone().multiplyScalar(this.params.terrain.size));
    this._shadowAt = null;
    this.sun.intensity = (0.04 + day * 2.7) * this._weatherDim;
    this.sun.color.setHSL(0.085, dusk * 0.75, 0.62 + day * 0.3);
    this.hemi.intensity = (0.1 + day * 0.5) * this.hemiScale * (0.6 + 0.4 * this._weatherDim);

    const base = this._paletteFog || this._baseFog || (this._baseFog = this.fogColor.clone());
    this.fogColor.copy(base)
      .lerp(new THREE.Color(0xff9a5a), dusk * 0.45)
      .lerp(new THREE.Color(0x0b1020), night * 0.92);
    this.uniforms.uHaze.value.copy(this.fogColor);
  }

  setHazeAmount(density, turbidity) {
    this.uniforms.uHazeAmt.value = hazeAmount(density, turbidity);
  }

  setClouds({ cover, scale, volumetric }) {
    if (cover !== undefined) this.uniforms.uCloudCover.value = cover;
    if (scale !== undefined) this.uniforms.uCloudScale.value = scale;
    if (volumetric !== undefined) this.uniforms.uVolumetric.value = volumetric ? 1 : 0;
  }

  tick(dt) { this.uniforms.uTime.value += dt; }

  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}
