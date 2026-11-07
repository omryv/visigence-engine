/* A photograph in, a figure out: the browser half of atlas-core, for any page that wants one.
 *
 * atlas-core.js has no DOM and keeps it that way, so the steps a page has to do around it live here, once:
 *
 *   decode    the image to RGBA twice, at the geometry grid and at the atlas resolution, after cropping it to its
 *             subject (subjectRect says why), exactly as this package's own page does;
 *   solve     on the engine's own code, in web/worker.js, off the main thread;
 *   compose   the atlas the UVs address (buildAtlas), and encode it as PNG;
 *   export    a GLB, through src/exporters.js.
 *
 * web/app.js (this package's page) uses the first and third; `photoToFigure` is all four in one call, for a page
 * that only wants the file: the studio's "See yourself" (editor/assetImport.js), which hands the GLB to its own prop
 * importer. Nothing here reaches past src/atlas/ (tools/check-imports.mjs).
 */

import { PRESETS, segment, hasAlpha } from '../atlas-core.js';
import { glbBytes } from '../exporters.js';

/**
 * A rectangle of an ImageBitmap (source pixels; the whole bitmap by default)
 * resampled to `maxDim` on its long side, as RGBA.
 */
export function bitmapToPixels(bmp, maxDim, rect = null) {
  const r = rect || { x: 0, y: 0, w: bmp.width, h: bmp.height };
  const scale = Math.min(1, maxDim / Math.max(r.w, r.h));
  const w = Math.max(2, Math.round(r.w * scale));
  const h = Math.max(2, Math.round(r.h * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, w, h);
  return { px: ctx.getImageData(0, 0, w, h).data, w, h };
}

/**
 * The subject's bounding box in the bitmap, padded by CROP_MARGIN of its long
 * side, found by running the engine's OWN segmentation on a probe the size of
 * the geometry grid — so the crop and the reconstruction agree about what the
 * subject is. Null when nothing segments, and the caller resamples the whole
 * frame as it always did.
 *
 * WHY. The working grid is sized by the preset — 280px on the long side at
 * balanced — and a photograph is mostly margin. Measured on the three-view
 * character in the repository (1290×2796, subject 840×1082, 25% of the frame):
 * fitted whole, the grid was 129×280 and the subject got 83×108 of it, a third
 * of the resolution the mode names; cropped first it gets 194×250, the boundary
 * re-projection is placed 2.1× more precisely in source pixels, and the profile
 * fit rises from 0.986 to 0.994. Each view is cropped to its own subject: the
 * back is registered by a similarity fit and the profile by vertical extent, so
 * neither needs the three frames to agree. The margin leaves the engine's
 * border-sampled background model a border to sample.
 */
export const CROP_MARGIN = 0.06;
export function subjectRect(bmp, probeDim) {
  const probe = bitmapToPixels(bmp, probeDim);
  const N = probe.w * probe.h;
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) lum[i] = (0.299 * probe.px[i * 4] + 0.587 * probe.px[i * 4 + 1] + 0.114 * probe.px[i * 4 + 2]) / 255;
  let b;
  try { b = segment(probe.px, lum, probe.w, probe.h, hasAlpha(probe.px, N)).bounds; } catch { return null; }
  if (!b || !b.area) return null;
  const sx = bmp.width / probe.w, sy = bmp.height / probe.h;
  const m = CROP_MARGIN * Math.max((b.maxx - b.minx + 1) * sx, (b.maxy - b.miny + 1) * sy);
  const x0 = Math.max(0, Math.floor(b.minx * sx - m)), y0 = Math.max(0, Math.floor(b.miny * sy - m));
  const x1 = Math.min(bmp.width, Math.ceil((b.maxx + 1) * sx + m)), y1 = Math.min(bmp.height, Math.ceil((b.maxy + 1) * sy + m));
  const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  return rect.w >= 8 && rect.h >= 8 ? rect : null;
}

function rgbaCanvas(buf, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
  return c;
}

/**
 * The atlas the UVs address: observed half on the left, inferred half on the
 * right. With a back view the far half is that photograph; without one it is
 * the near half again, pulled toward grey so the render never claims evidence
 * it does not have.
 */
export function buildAtlas(r) {
  const { texW, texH, atlasS: S } = r.stats;
  const near = rgbaCanvas(r.padded, texW, texH);
  const c = document.createElement('canvas');
  c.width = S * 2; c.height = S;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  x.drawImage(near, 0, 0, S, S);
  if (r.paddedBack) {
    x.drawImage(rgbaCanvas(r.paddedBack, texW, texH), S, 0, S, S);
    return c;
  }
  x.drawImage(near, S, 0, S, S);
  const d = x.getImageData(S, 0, S, S);
  const a = d.data;
  for (let i = 0; i < a.length; i += 4) {
    const l = (a[i] + a[i + 1] + a[i + 2]) / 3;
    a[i]     = (a[i]     * 0.55 + l * 0.45) * 0.96;
    a[i + 1] = (a[i + 1] * 0.55 + l * 0.45) * 0.94;
    a[i + 2] = (a[i + 2] * 0.55 + l * 0.45) * 0.92;
  }
  x.putImageData(d, S, 0);
  return c;
}

/**
 * The atlas no wider than `max` pixels: scaled as a whole, so the UVs (which address it in 0..1) still land where
 * they did. The atlas is two squares side by side, so a 2048 px cap makes each half 1024.
 */
export function fitAtlas(canvas, max) {
  if (!(max > 0) || canvas.width <= max) return canvas;
  const k = max / canvas.width, c = document.createElement('canvas');
  c.width = Math.round(canvas.width * k); c.height = Math.max(1, Math.round(canvas.height * k));
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  x.drawImage(canvas, 0, 0, c.width, c.height);
  return c;
}

/** A canvas as PNG bytes. */
export async function canvasPngBytes(canvas) {
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** One request to web/worker.js, answered by the message of type `want`; progress on the way, errors thrown. */
function ask(worker, msg, want, onProgress) {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') { onProgress?.(data); return; }
      if (data.type === 'error') { reject(new Error(data.message)); return; }
      if (data.type === want) resolve(data);
    };
    worker.onerror = (e) => reject(new Error(e.message || 'the reconstruction worker failed'));
    worker.postMessage(msg);
  });
}

/**
 * A photograph of one subject as a GLB: reconstructed, cut down by SmartMesh to what the evidence supports and at
 * most `triangles`, textured with its atlas. No skin: the rig stays out unless `rigged` (a static prop importer
 * refuses skins). `size` is the mesh's extent in its own units (x, y, z; y is up), for a caller that scales it to a
 * height.
 *
 * `texture` caps the atlas's width in pixels (fitAtlas), for an importer with a texture limit.
 *
 * @param {Blob} file  an image
 * @param {{mode?: string, triangles?: number, kappa?: number, rigged?: boolean, texture?: number, onProgress?: (p: {progress: number, phase: number}) => void}} [o]
 * @returns {Promise<{bytes: Uint8Array, triangles: number, size: number[], ms: number, notes: object[], summary: object}>}
 */
export async function photoToFigure(file, { mode = 'balanced', triangles = 24000, kappa = 1, rigged = false, texture = 2048, onProgress = null } = {}) {
  const preset = PRESETS[mode];
  if (!preset) throw new Error(`unknown mode ${mode}`);
  const t0 = performance.now();
  const bmp = await createImageBitmap(file);
  const rect = subjectRect(bmp, preset.w);
  const grid = bitmapToPixels(bmp, preset.w, rect), tex = bitmapToPixels(bmp, preset.texSrc, rect);
  bmp.close?.();
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  try {
    const done = await ask(worker, { type: 'reconstruct', mode, grid, tex, back: null, profile: null, facing: 'left' }, 'done', onProgress);
    const g = await ask(worker, { type: 'exportGeometry', which: 'smart', kappa, target: triangles }, 'geometry');
    const png = await canvasPngBytes(fitAtlas(buildAtlas(done.result), texture));
    const id = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
    const bytes = glbBytes({ ...g.geo, sigmaMeta: g.sigmaMeta }, png, id, rigged ? g.rig : null, null);
    const P = g.geo.positions, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i++) { const k = i % 3; if (P[i] < lo[k]) lo[k] = P[i]; if (P[i] > hi[k]) hi[k] = P[i]; }
    return { bytes, triangles: g.geo.indices.length / 3, size: hi.map((v, k) => v - lo[k]), ms: performance.now() - t0,
      notes: done.result.notes ?? [], summary: done.result.summary ?? null };
  } finally {
    worker.terminate();
  }
}
