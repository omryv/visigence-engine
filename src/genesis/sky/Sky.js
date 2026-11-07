// Procedural sky dome + lighting rig. One class owns: gradient sky shader,
// sun disc, stars, cloud layer (cheap slab fbm, extra octaves when the
// quality preset allows "volumetric"), the sun/hemisphere lights and the fog
// colour — all driven by params.sky.timeOfDay.

import * as THREE from "three";
import {
  Fn, vec2, vec3, float, positionLocal, screenCoordinate, normalize, clamp, mix, pow, max, dot, smoothstep, abs, step,
  sin, floor,
} from "three/tsl";
import { uniform } from "three/tsl";
import { Atmosphere } from "../render/atmosphere.js";
import { wgNoise, wgHash } from "../render/nodes.js";
import { sunDirection, sunAltitudeSine } from "./sun.js";

/* The dome's own fbm STAYS here, deliberately. It is not the water's fbm under
   another name: this one steps at lacunarity 2.03 with a +19.7 offset per
   octave and is left unnormalised, and the volumetric tier buys two more
   octaves. Water's runs three unrolled octaves at 2.13/4.41 with weights that
   sum to one. Same shape, different function. `extra` (0 or 1) weighs octaves
   five and six in, which is the GLSL's dynamic octave count without a loop
   that compiles differently on the two backends. */
function fbm(p, oct, extra = float(0)) {
  let s = float(0), a = 0.5, q = p;
  for (let i = 0; i < oct; i++) {
    const term = wgNoise(q).mul(a);
    s = s.add(i >= 4 ? term.mul(extra) : term);
    q = q.mul(2.03).add(19.7); a *= 0.5;
  }
  return s;
}

/* The dome, as a colour node over the sphere's own direction: term for term
   the GLSL FRAG this replaced, without its tone map (the renderer gives every
   node material, this one included, the same ACES and sRGB) and with the
   dither applied in linear before it. */
function skyColor(u) {
  return Fn(() => {
    const d = normalize(positionLocal);
    const t = clamp(d.y.mul(0.5).add(0.5), 0, 1);
    const col = mix(u.uHorizon, u.uZenith, pow(t, 0.62)).toVar();

    // Horizon haze: the last few degrees above the skyline blend into the SAME
    // colour the aerial perspective fades land into.
    const band = float(1).sub(smoothstep(0, 0.16, abs(d.y)));
    col.assign(mix(col, u.uHaze, band.mul(0.72).mul(u.uHazeAmt)));

    // Sun disc + halo: limb-darkened, inside a broad forward-scattered glow
    // that swells and reddens as the sun nears the horizon.
    const sd = max(dot(d, u.uSunDir), 0);
    const low = clamp(float(1).sub(u.uSunDir.y.mul(2.2)), 0, 1);
    const disc = pow(sd, mix(1400, 520, low)).mul(float(0.75).add(pow(sd, 5000).mul(0.25)));
    const halo = pow(sd, mix(30, 9, low)).mul(float(0.34).add(low.mul(0.5))).add(pow(sd, 3).mul(0.05).mul(low));
    const sunCol = mix(vec3(1.0, 0.96, 0.88), vec3(1.0, 0.46, 0.22), low);
    col.addAssign(sunCol.mul(disc.mul(3.4).add(halo)).mul(float(1).sub(u.uNight)));

    // Moon: the sun path mirrored, cold and dim.
    const md = max(dot(d, u.uSunDir.negate()), 0);
    col.addAssign(vec3(0.55, 0.62, 0.75).mul(pow(md, 260).mul(1.4).add(pow(md, 24).mul(0.06))).mul(u.uNight));

    // Stars fade in at night, only above the horizon.
    const sp = d.xz.div(d.y.add(0.35)).mul(140);
    const star = step(0.9985, wgHash(floor(sp)));
    const tw = float(0.6).add(sin(u.uTime.mul(2).add(wgHash(floor(sp).add(7)).mul(40))).mul(0.4));
    col.addAssign(vec3(star).mul(tw).mul(u.uNight).mul(smoothstep(0, 0.15, d.y)).mul(step(0.02, u.uNight)).mul(step(0, d.y)));

    // Clouds: fbm slab projected on the dome, softened at the edges and
    // silver-lined where the sun sits behind them.
    const cp = d.xz.div(d.y.add(0.22)).mul(1.7).mul(u.uCloudScale).add(vec2(u.uTime.mul(0.008), u.uTime.mul(0.003)));
    const c = fbm(cp, 6, u.uVolumetric);
    const cov = smoothstep(float(1).sub(u.uCloudCover), float(1).sub(u.uCloudCover).add(0.42), c);
    const lit = fbm(cp.add(u.uSunDir.xz.mul(0.35)), 3);
    const cloudCol = mix(vec3(0.5, 0.53, 0.6), vec3(1.06, 1.01, 0.97), clamp(lit.add(0.25), 0, 1)).toVar();
    const rim = pow(max(dot(d, u.uSunDir), 0), 14).mul(float(1).sub(cov.mul(0.55)));
    cloudCol.addAssign(mix(vec3(1.0, 0.92, 0.8), vec3(1.0, 0.6, 0.34), low).mul(rim).mul(0.9).mul(float(1).sub(u.uNight)));
    cloudCol.assign(mix(cloudCol, cloudCol.mul(vec3(0.28, 0.3, 0.4)), u.uNight));
    const horizonFade = smoothstep(0.015, 0.12, d.y);
    const clouds = step(0.015, d.y).mul(step(0.01, u.uCloudCover));
    const withClouds = mix(mix(col, cloudCol, cov.mul(horizonFade).mul(0.92)), u.uHaze, band.mul(0.5).mul(u.uHazeAmt));
    col.assign(mix(col, withClouds, clouds));

    col.assign(mix(col, col.mul(vec3(0.09, 0.11, 0.19)), u.uNight.mul(float(1).sub(t.mul(0.4)))));
    // Dither: a smooth gradient across a whole sky is exactly where 8-bit
    // banding shows, and it is very visible on phone OLEDs.
    col.addAssign(wgHash(screenCoordinate.xy).sub(0.5).mul(0.0035));
    return col;
  })();
}

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
    const U = (v) => uniform(v);
    this.uniforms = {
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
    for (const k of Object.keys(this.uniforms)) this.uniforms[k] = U(this.uniforms[k].value);
    // A dome drawn first (renderOrder −10) and never written to depth, so the
    // world draws over it wherever it stands. The air is its own: no fog.
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    material.colorNode = skyColor(this.uniforms);
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
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
      // Redrawn only when a caster or the box moved: the engine sets
      // needsUpdate (Engine._frame, _needsShadow).
      this.sun.shadow.autoUpdate = false;
      this.sun.shadow.needsUpdate = true;
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
