/**
 * THE SKY, THE PROBE AND THE AIR, from one description.
 *
 * game/ShooterSession.js used to paint a 512 x 256 canvas gradient, hand it to
 * `scene.background` and `scene.environment` both, and light the world with a directional
 * light whose colour had nothing to do with that gradient. Three symptoms followed, all
 * visible in the reference shots: a sky with no sun in it and no depth (a gradient is a
 * gradient at any resolution), reflections on the weapon and the wet road that showed a
 * banded grey, and a fog that was a flat `Fog(background, 42, 150)` so a building 60 m
 * away simply faded into the same grey the sky was.
 *
 * This module derives all three from ONE sun and ONE dome, described by a look
 * (config/looks.js):
 *
 *   BACKGROUND   an analytic sky evaluated per fragment in TSL: a zenith-to-horizon
 *                gradient, a Mie halo and a disc around the sun, the city's own glow at
 *                the horizon after dark, stars, and a cloud layer from a fractal noise on
 *                a plane above the camera. Crisp at any resolution, HDR, and the disc is
 *                bright enough that the bloom and the lens flare pick it up as they would
 *                a real source. Assigned to `scene.backgroundNode`.
 *   ENVIRONMENT  the same node, rendered once into a cube by three's PMREMGenerator and
 *                prefiltered by roughness. This is what a polished receiver, a puddle and
 *                a rough concrete kerb reflect, each at its own blur - and it is the SAME
 *                sky the player sees, so a reflection of the sun sits under the sun.
 *   FOG          exponential height fog with in-scattering toward the sun, as
 *                `scene.fogNode`. The air is densest at street level and thins with
 *                height, so a tower's top stays clear while its base sits in haze; and a
 *                surface seen against the sun picks up the sun's colour, which is what
 *                separates aerial perspective from a grey wash.
 *
 * Everything the look decides is a uniform, so a runtime change (a look swap, a time of
 * day) is a value write and not a shader rebuild. The probe is the one exception - it is
 * a baked texture - and `bakeEnvironment()` re-renders it on demand.
 *
 * Runs on both backends: TSL compiles to WGSL and to GLSL, and PMREMGenerator has a
 * node-based implementation in three/webgpu that the WebGL2 fallback shares.
 */

import { Scene, PMREMGenerator, Color, Vector3, MathUtils } from 'three/webgpu';
import {
  Fn, uniform, float, vec3, vec4, positionWorldDirection, positionWorld, cameraPosition,
  normalize, dot, max, pow, exp, mix, smoothstep, clamp, floor, fract, sin, abs, select, length,
  mx_fractal_noise_float, fog,
} from 'three/tsl';

/** Unit vector TOWARD the sun for an elevation and azimuth in degrees (azimuth 0 = +Z). */
export function sunDirection(elevationDeg, azimuthDeg, out = new Vector3()) {
  const el = MathUtils.degToRad(elevationDeg), az = MathUtils.degToRad(azimuthDeg);
  return out.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
}

/** sRGB hex -> linear Color, the space every node here works in. */
const linear = (hex) => new Color(hex);

/**
 * The uniforms one sky is driven by. Built from a look's `sky` block; `accent` is the
 * project's palette colour, which tints the city glow at night so a cyan district and an
 * amber one have different skies.
 */
export function createSkyUniforms(sky, { accent = 0xffffff } = {}) {
  const pollution = linear(accent).lerp(linear(sky.horizon), 0.7);
  return {
    sunDir: uniform(sunDirection(sky.elevation, sky.azimuth)),
    sunColor: uniform(linear(sky.sunColor)),
    disc: uniform(sky.disc ?? 20),
    // cos of the disc's angular radius; the sun is ~0.0047 rad, drawn a little larger.
    discCos: uniform(Math.cos(sky.discSize ?? 0.009)),
    discInnerCos: uniform(Math.cos((sky.discSize ?? 0.009) * 0.8)),
    glow: uniform(sky.glow ?? 0.3),
    zenith: uniform(linear(sky.zenith)),
    horizon: uniform(linear(sky.horizon)),
    ground: uniform(linear(sky.ground)),
    pollution: uniform(sky.pollution ?? 0),
    pollutionColor: uniform(pollution),
    stars: uniform(sky.stars ?? 0),
    clouds: uniform(sky.clouds ?? 0),
    cloudOffset: uniform(sky.cloudOffset ?? 0),
  };
}

/**
 * The dome, as a node. Evaluated on three's background sphere, where
 * `positionWorldDirection` is the view direction; and inside the PMREM cube render, where
 * it is the cube face's direction. Same node, same sky.
 */
export function createSkyNode(u) {
  return Fn(() => {
    const dir = normalize(positionWorldDirection);
    const up = dir.y;
    const mu = dot(dir, u.sunDir);
    const t = clamp(up, 0, 1);

    // The dome: zenith at the top, horizon colour pulled up by a cubic so the band is
    // wide near the ground and the zenith stays clean.
    const horizonMix = pow(float(1).sub(t), 3.0);
    const sky = mix(u.zenith, u.horizon, horizonMix).toVar();

    // Mie: a wide forward-scatter lobe and a tight halo, both in the sun's colour.
    const m = max(mu, 0);
    const halo = pow(m, 6).mul(0.5).add(pow(m, 48)).mul(u.glow);
    sky.addAssign(u.sunColor.mul(halo));

    // Light pollution: the city glowing up from below the horizon after dark.
    const pol = pow(float(1).sub(t), 9).mul(u.pollution).mul(smoothstep(-0.15, 0.05, up));
    sky.addAssign(u.pollutionColor.mul(pol));

    // Stars: a hashed lattice, thresholded, kept off the horizon band where the haze is.
    const cell = floor(dir.mul(420.0));
    const h = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
    const star = smoothstep(0.9988, 0.99995, h).mul(u.stars).mul(smoothstep(0.06, 0.4, up));
    sky.addAssign(vec3(star.mul(1.6)));

    // Clouds: fractal noise on a plane above the camera; the division by height gives
    // the perspective a cloud deck has, and the fade hides the singularity at the horizon.
    const plane = dir.xz.div(max(up, 0.05)).mul(0.28).add(u.cloudOffset);
    const n = mx_fractal_noise_float(vec3(plane, 0.0), 4, 2.15, 0.52, 1.0).mul(0.5).add(0.5);
    const coverLo = float(0.86).sub(u.clouds.mul(0.42));
    const cover = smoothstep(coverLo, coverLo.add(0.18), n).mul(smoothstep(0.02, 0.22, up)).mul(u.clouds.greaterThan(0.001));
    // Lit on the sun side, in shadow away from it; the shadow side takes the zenith's hue.
    const cloudLit = u.sunColor.mul(0.55).add(u.horizon.mul(0.6)).mul(m.mul(0.6).add(0.4));
    const cloudShade = mix(u.zenith, u.horizon, 0.5).mul(0.7);
    const cloudColor = mix(cloudShade, cloudLit, smoothstep(0.55, 1.0, n));
    sky.assign(mix(sky, cloudColor, cover));

    // The disc, last, so a cloud can cover it.
    const disc = smoothstep(u.discCos, u.discInnerCos, mu).mul(u.disc).mul(float(1).sub(cover));
    sky.addAssign(u.sunColor.mul(disc));

    // Below the horizon there is ground, not sky: a flat colour so the probe's lower
    // hemisphere is the bounce a floor would give.
    sky.assign(mix(u.ground, sky, smoothstep(-0.08, 0.0, up)));
    return vec4(sky, 1.0);
  })();
}

/**
 * Exponential height fog with sun in-scatter, as a `scene.fogNode`.
 *
 * The optical depth along a ray from the camera to the fragment through a density
 * `d0 * exp(-k * y)` has a closed form, `d0 * exp(-k * y_cam) * (1 - exp(-k * dy * s)) /
 * (k * dy)` for a ray of length `s` and slope `dy`, with the flat-ray limit `d0 * s`. That
 * is what is integrated here, so the fog is exact for the density it declares rather than
 * an approximation of one, and it costs one exp per fragment more than FogExp2.
 *
 * @param {object} u  the uniforms from createFogUniforms()
 */
export function createAtmosphereFog(u) {
  const factor = Fn(() => {
    const delta = positionWorld.sub(cameraPosition);
    const dist = length(delta);
    const dy = delta.y.div(max(dist, 0.001));
    const t = u.falloff.mul(dy).mul(dist);
    const small = abs(t).lessThan(1e-4);
    const safeT = select(small, float(1.0), t);
    const ratio = select(small, float(1.0), float(1).sub(exp(safeT.negate())).div(safeT));
    const depth = u.density.mul(exp(u.falloff.mul(cameraPosition.y).negate())).mul(dist).mul(ratio);
    return clamp(float(1).sub(exp(depth.negate())), 0.0, u.maxFog);
  })();
  const color = Fn(() => {
    const viewDir = normalize(positionWorld.sub(cameraPosition));
    const toward = pow(max(dot(viewDir, u.sunDir), 0), 8).mul(u.inscatter);
    return mix(u.color, u.sunColor, toward);
  })();
  return fog(color, factor);
}

/** The fog's uniforms, from a look's `fog` block and the sky it belongs to. */
export function createFogUniforms(fogLook, sky, skyUniforms) {
  return {
    density: uniform(fogLook.density ?? 0.01),
    falloff: uniform(fogLook.falloff ?? 0.08),
    inscatter: uniform(fogLook.inscatter ?? 0.4),
    maxFog: uniform(fogLook.maxFog ?? 0.94),
    // The far field converges to the dome's horizon, so a fogged tower and the sky behind
    // it meet without a seam. A look may still pin its own colour.
    color: uniform(fogLook.color !== undefined ? linear(fogLook.color) : linear(sky.horizon).multiplyScalar(0.9)),
    sunColor: uniform(linear(sky.sunColor).lerp(linear(sky.horizon), 0.35)),
    sunDir: skyUniforms.sunDir,
  };
}

/**
 * One sky, owned: its uniforms, its node, and the probe baked from it.
 */
export class SkyEnvironment {
  /**
   * @param {import('three/webgpu').WebGPURenderer} renderer  initialised
   * @param {object} sky  a look's `sky` block
   * @param {{accent?: number, probeSize?: number}} [o]
   */
  constructor(renderer, sky, { accent = 0xffffff, probeSize = 128 } = {}) {
    this.renderer = renderer;
    this.sky = sky;
    this.uniforms = createSkyUniforms(sky, { accent });
    this.node = createSkyNode(this.uniforms);
    this.sunDir = this.uniforms.sunDir.value;
    this.probeSize = probeSize;
    /** A scene of nothing but the dome, for the probe render. */
    this._probeScene = new Scene();
    this._probeScene.backgroundNode = this.node;
    this._pmrem = null;
    this._target = null;
    this.texture = null;
    this.bakeEnvironment();
  }

  /** Render the dome into the prefiltered probe. Idempotent; call again after a uniform change. */
  bakeEnvironment() {
    this._pmrem ||= new PMREMGenerator(this.renderer);
    const previous = this._target;
    this._target = this._pmrem.fromScene(this._probeScene, 0, 0.1, 100, { size: this.probeSize });
    this.texture = this._target.texture;
    this.texture.name = 'SkyEnvironment';
    previous?.dispose();
    return this.texture;
  }

  /** Put this sky behind `scene` and into its reflections. */
  applyTo(scene, { environmentIntensity = 1 } = {}) {
    scene.background = null;
    scene.backgroundNode = this.node;
    scene.environment = this.texture;
    scene.environmentIntensity = environmentIntensity;
  }

  dispose() {
    this._target?.dispose();
    this._pmrem?.dispose();
    this._target = null; this._pmrem = null; this.texture = null;
  }
}
