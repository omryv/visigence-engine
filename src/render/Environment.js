/** Low-resolution level probes derived from the live lighting palette at boot.
 * Scene environmentIntensity controls IBL; per-material intensity is ignored without envMap.
 */
import { CanvasTexture, EquirectangularReflectionMapping, SRGBColorSpace, Color } from 'three/webgpu';
import { mrt, vec3, vec4, float } from 'three/tsl';

/**
 * What an UNLIT material writes to the world pass's extra render targets (option 4).
 *
 * When screen-space reflections are on, the world pass carries a normal target and a
 * roughness/metalness target alongside the colour, and the reflection pass reads them to
 * decide what reflects and how sharply. A lit material fills both from its own shading; an
 * unlit one - a light shaft, a tracer, a particle cloud, a scorch mark - has no roughness
 * at all, and whatever it left in that target would be read as "mirror". So every unlit
 * material declares itself: a camera-facing normal and roughness 1, which the reflection
 * pass reads as "nothing to reflect here". Merged over the pass's MRT per material by
 * three; ignored entirely when the pass has no MRT.
 */
let UNLIT_MRT = null;

/**
 * Whether the world pass carries those targets this session. Decided once, before any
 * material is built (Game._buildWorld), from the same switch PostFX reads. It matters
 * because three does not ignore a material's `mrtNode` when the pass has none - it makes
 * it the material's whole output, and a light shaft that writes only a normal and a
 * roughness draws nothing at all.
 */
let _unlitMrtEnabled = false;
export function setUnlitMrtEnabled(ssr, ao = false) {
  _unlitMrtEnabled = !!(ssr || ao);
  UNLIT_MRT = ssr ? mrt({ normal: vec3(0, 0, 1), rm: vec4(1, 0, 0, 1) })
    : ao ? mrt({ aoMask: float(0) }) : null;
}

/**
 * Small on purpose. The probe is prefiltered into a mip chain before anything samples it,
 * so source resolution buys nothing above the size of the features actually painted here
 * (a horizon band and four soft lobes) while costing prefilter time at boot.
 */
const WIDTH = 256;
const HEIGHT = 128;

/** A dim palette profile and four azimuth bins of the authored fixtures. */
export function probePalette({ sky = 0x35525F, ground = 0x241E1B, fog = 0x080E12,
  zones = [], breached = false } = {}) {
  const skyColor = new Color(sky), floor = new Color(ground), voidColor = new Color(fog);
  const band = skyColor.clone().lerp(floor, .35);
  const profile = [[0, voidColor], [.28, voidColor.clone().lerp(skyColor,.45)],
    [.45, band], [.52, band.clone().multiplyScalar(1.6)], [.72, floor], [1, floor.clone().multiplyScalar(.45)]]
    .map(([stop, color]) => [stop, color.getStyle()]);
  const bins = Array.from({length:4}, () => ({color:new Color(0),weight:0}));
  for (const zone of zones) {
    const yaw = (Math.atan2(zone.pos.z, zone.pos.x) / (Math.PI * 2) + 1) % 1;
    const bin = bins[Math.floor(yaw * 4)];
    const weight = Math.max(0, zone.intensity);
    const color = new Color(zone.color);
    if (breached) color.lerp(skyColor,.65);
    bin.color.add(color.multiplyScalar(weight)); bin.weight += weight;
  }
  const lobes = bins.map((bin,i) => {
    const c = bin.weight ? bin.color.multiplyScalar(1 / bin.weight) : band.clone();
    c.multiplyScalar(.22).convertLinearToSRGB();
    return {u:(i+.5)/4,v:.5,rx:.17,ry:.12,alpha:.4,
      color:[c.r,c.g,c.b].map(x=>Math.round(Math.min(1,x)*255)).join(',')};
  });
  return {profile,lobes};
}

/**
 * Paint the probe and hand back a texture ready for `scene.environment`.
 *
 * Equirectangular, and the orientation follows three's own convention: v runs 0 at -Y to
 * 1 at +Y, and a CanvasTexture's default `flipY` puts the top ROW of the canvas at v = 1.
 * So the canvas is painted the way it reads - sky at the top, floor at the bottom.
 *
 * @returns {CanvasTexture|null} null if `?ibl=off` or a 2D context is unavailable, in
 *   which case the caller simply leaves `scene.environment` unset and the game renders
 *   as it did before.
 */
export function createProbeEnvironment(options = {}) {
  const { profile, lobes } = probePalette(options);
  /**
   * `?ibl=off` renders the level exactly as it did before the probe existed - the
   * hemisphere goes back to its pre-probe intensity on its own, because Lighting keys that
   * off whether this returned anything. The probe is the single largest change to how
   * every surface in the game is shaded, so being able to A/B it from the address bar is
   * how anyone judges the art direction, or bisects it if a device dislikes the prefilter.
   * Same convention as `?renderer=` in core/Renderer.js.
   */
  if (typeof location !== 'undefined'
    && new URLSearchParams(location.search).get('ibl') === 'off') return null;

  let canvas;
  let g;
  try {
    canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    g = canvas.getContext('2d');
  } catch {
    return null;
  }
  if (!g) return null;

  const grad = g.createLinearGradient(0, 0, 0, HEIGHT);
  for (const [stop, color] of profile) grad.addColorStop(stop, color);
  g.fillStyle = grad;
  g.fillRect(0, 0, WIDTH, HEIGHT);

  // Additive, so a lobe can only ever brighten the band it sits on - it cannot punch a
  // dark hole in the horizon and turn into a visible seam on a curved surface.
  g.globalCompositeOperation = 'lighter';
  for (const lobe of lobes) {
    // Painted three times, at u - 1, u and u + 1, so a lobe that overruns either edge
    // comes back on the other one. The probe wraps in azimuth; a lobe that did not would
    // put a hard vertical seam behind the player at yaw 0.
    for (const wrap of [-1, 0, 1]) {
      const cx = (lobe.u + wrap) * WIDTH;
      const cy = (1 - lobe.v) * HEIGHT;
      const rx = lobe.rx * WIDTH;
      const ry = lobe.ry * HEIGHT;
      if (cx + rx < 0 || cx - rx > WIDTH) continue;
      g.save();
      g.translate(cx, cy);
      g.scale(1, ry / rx);
      const radial = g.createRadialGradient(0, 0, 0, 0, 0, rx);
      radial.addColorStop(0, `rgba(${lobe.color}, ${lobe.alpha})`);
      radial.addColorStop(0.55, `rgba(${lobe.color}, ${lobe.alpha * 0.35})`);
      radial.addColorStop(1, `rgba(${lobe.color}, 0)`);
      g.fillStyle = radial;
      g.beginPath();
      g.arc(0, 0, rx, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }
  g.globalCompositeOperation = 'source-over';

  const texture = new CanvasTexture(canvas);
  texture.name = 'ProbeEnvironment';
  texture.mapping = EquirectangularReflectionMapping;
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Opt one unlit material OUT of the scene environment.
 *
 * `scene.environment` reaches MeshBasicMaterial as well as MeshStandardMaterial, and a
 * basic material's default `combine` is MultiplyOperation at `reflectivity` 1 - so an
 * additive light shaft, a tracer or a scorch decal would come out multiplied by a probe
 * whose average value is about 0.06, i.e. almost extinguished. Every unlit material in the
 * project is therefore built with reflectivity 0, which makes that blend a no-op
 * (`mix(light, light * env, 0)` is `light`) and is inert on any path that never consults
 * an environment at all.
 *
 * Applied through one function rather than by hand at eight call sites so that the reason
 * lives in exactly one place, and so a new unlit effect is one call away from being safe.
 *
 * @template {{reflectivity?: number}} T
 * @param {T} material
 * @returns {T} the same material, for chaining onto a constructor call
 */
export function excludeFromEnvironment(material) {
  material.reflectivity = 0;
  markUnlit(material);
  return material;
}

/**
 * Declare a material unlit to the world pass's extra targets - see UNLIT_MRT. Applied to
 * the particle clouds as well, which never go through excludeFromEnvironment because a
 * PointsMaterial has no reflectivity to zero.
 *
 * Works on classic materials as well as node materials: the renderer converts a classic
 * material by copying every own property onto its node equivalent, `mrtNode` included.
 *
 * @template T
 * @param {T} material
 * @returns {T}
 */
export function markUnlit(material) {
  if (_unlitMrtEnabled) material.mrtNode = UNLIT_MRT;
  return material;
}
