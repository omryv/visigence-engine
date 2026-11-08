/* The My-3D-Engine view of the one editor (index.html): a photograph in, a figure and its files out. Ported from atlas-core's
 * page (omryv/3d web/app.js) onto this repository's reconstruction (src/atlas/) and drawn by the engine's renderer
 * (editor/my-3d-engine/viewer.js, WebGPU) instead of a WebGL2 viewer of its own.
 *
 * The page: photographs in, a mesh and its files out.
 *
 * This module does the four things the engine deliberately does not do, because
 * atlas-core.js has no DOM and is meant to keep it that way:
 *
 *   decode      an image file to RGBA, twice — once at the geometry grid, once
 *               at the atlas resolution, because the atlas does not have to be
 *               as coarse as the solve — after cropping each view to its
 *               subject, because the grid is sized by the preset and a
 *               photograph is mostly margin (see subjectRect)
 *   compose     the two atlas halves into the one texture the UVs address
 *   present     hand the arrays to the viewer and the numbers to the panel
 *   export      GLB, OBJ+MTL+PNG, and the atlas on its own
 *
 * The reconstruction itself happens in web/worker.js, on the engine's own code.
 */

import { PRESETS, segment, hasAlpha } from '../../src/atlas/atlas-core.js';
import { glbBytes, makeOBJ, makeZip } from '../../src/atlas/exporters.js';
import { VIEWER_ONLY_EFFECTS, VIEWER_ONLY_NOTICE } from '../../src/atlas/render-state.js';
import { Viewer } from './viewer.js';
import { fitAtlas, canvasPngBytes } from '../../src/atlas/web/figure.js';

const $ = (id) => document.getElementById(id);

const el = {
  stage: $('stage'), viewport: $('viewport'), dropzone: $('dropzone'),
  progress: $('progress'), progressFill: $('progressFill'), progressLabel: $('progressLabel'),
  viewbar: $('viewbar'), viewerNotice: $('viewerNotice'), spinBtn: $('spinBtn'),
  mode: $('mode'), facingRight: $('facingRight'), runBtn: $('runBtn'),
  kappa: $('kappa'), kappaOut: $('kappaOut'), target: $('target'),
  simplifyBtn: $('simplifyBtn'), stopLine: $('stopLine'),
  readoutCard: $('readoutCard'), readout: $('readout'),
  exportCard: $('exportCard'), glbBtn: $('glbBtn'), objBtn: $('objBtn'), atlasBtn: $('atlasBtn'),
  exportNote: $('exportNote'),
  log: $('log'), browseBtn: $('browseBtn'),
  meshFullBtn: $('meshFullBtn'), meshSmartBtn: $('meshSmartBtn'),
};

const state = {
  files: { front: null, back: null, profile: null },   // {bitmap, name}
  result: null,        // the payload from `reconstruct`
  smart: null,         // the payload from `smartMesh`, when it has been run
  atlas: null,         // HTMLCanvasElement, 2S × S
  atlasPng: null,      // Uint8Array of the same, made lazily for export
  showing: 'full',
  view: 'textured',
  busy: false,
};

/* ───────────────────────────────────────────────────────────── the viewer */

let viewer = null;
// The editor keeps this view when another is shown, and says so: stop drawing while hidden, start again when shown.
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== window.parent) return;
  if (e.data?.type === 'visigence:pause') viewer?.setPaused(true);
  if (e.data?.type === 'visigence:resume') viewer?.setPaused(false);
});
try {
  viewer = new Viewer(el.viewport);
  viewer.onSpinChange = (on) => { el.spinBtn.textContent = on ? 'Pause spin' : 'Resume spin'; el.spinBtn.setAttribute('aria-pressed', String(on)); };
} catch (err) {
  log(err.message, 'red');
}



/* ─────────────────────────────────────────────────────────────────── log */

function log(text, colour = 'ink') {
  const line = document.createElement('div');
  if (colour !== 'ink') line.className = `l-${colour}`;
  line.textContent = text;
  el.log.appendChild(line);
  el.log.scrollTop = el.log.scrollHeight;
}

/* ──────────────────────────────────────────────────────────── image input */

/**
 * A rectangle of an ImageBitmap (source pixels; the whole bitmap by default)
 * resampled to `maxDim` on its long side, as RGBA.
 */
function bitmapToPixels(bmp, maxDim, rect = null) {
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
const CROP_MARGIN = 0.06;
function subjectRect(bmp, probeDim) {
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

async function takeFile(slot, file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { log(`${file.name} is not an image`, 'amber'); return; }
  try {
    const bmp = await createImageBitmap(file);
    state.files[slot] = { bitmap: bmp, name: file.name };
    const btn = $(`slot${slot[0].toUpperCase()}${slot.slice(1)}`);
    btn.classList.add('filled');
    btn.querySelector('.slot-text i').textContent = `${file.name} · ${bmp.width}×${bmp.height}`;
    const url = URL.createObjectURL(file);
    btn.querySelector('.slot-thumb').style.backgroundImage = `url("${url}")`;
    log(`${slot} · ${file.name} · ${bmp.width}×${bmp.height}`);
    el.runBtn.disabled = !state.files.front;
  } catch {
    log(`could not decode ${file.name}`, 'red');
  }
}

for (const slot of ['front', 'back', 'profile']) {
  const input = $(`file${slot[0].toUpperCase()}${slot.slice(1)}`);
  $(`slot${slot[0].toUpperCase()}${slot.slice(1)}`).addEventListener('click', () => input.click());
  input.addEventListener('change', () => takeFile(slot, input.files[0]));
}
el.browseBtn.addEventListener('click', (e) => { e.stopPropagation(); $('fileFront').click(); });

for (const type of ['dragenter', 'dragover']) {
  el.stage.addEventListener(type, (e) => { e.preventDefault(); el.dropzone.classList.add('over'); });
}
for (const type of ['dragleave', 'drop']) {
  el.stage.addEventListener(type, (e) => { e.preventDefault(); el.dropzone.classList.remove('over'); });
}
el.stage.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) takeFile('front', f);
});

/* ──────────────────────────────────────────────────────────────── the run */

const worker = new Worker(new URL('../../src/atlas/web/worker.js', import.meta.url), { type: 'module' });

worker.onerror = (e) => { setBusy(false); log(`worker failed: ${e.message}`, 'red'); };

worker.onmessage = ({ data }) => {
  if (data.type === 'progress') {
    el.progressFill.style.width = `${data.progress}%`;
    el.progressLabel.textContent = `${PHASES[data.phase] || 'Working'}… ${data.progress}%`;
    return;
  }
  if (data.type === 'error') { setBusy(false); log(data.message, 'red'); return; }

  if (data.type === 'done') {
    state.result = data.result;
    state.smart = null;
    state.atlasPng = null;
    for (const l of data.log) log(l.text, l.color === 'ink' ? 'ink' : l.color);
    log(`reconstructed in ${(data.ms / 1000).toFixed(1)}s`, 'green');
    state.atlas = buildAtlas(data.result);
    showMesh('full');
    fillReadout(data.result);
    el.dropzone.hidden = true;
    el.viewbar.hidden = false;
    el.readoutCard.hidden = false;
    el.exportCard.hidden = false;
    el.meshSmartBtn.disabled = true;
    el.meshFullBtn.classList.add('on');
    el.meshSmartBtn.classList.remove('on');
    showNotice();
    setBusy(false);
    el.simplifyBtn.disabled = false;
    return;
  }

  if (data.type === 'simplified') {
    state.smart = data.smart;
    const rep = data.smart.report;
    log(`simplified ${rep.in.triangles.toLocaleString()} → ${rep.out.triangles.toLocaleString()} triangles`
      + ` · ${rep.stop.stoppingReason} · ${(data.ms / 1000).toFixed(1)}s`, 'green');
    el.stopLine.hidden = false;
    el.stopLine.innerHTML = '';
    el.stopLine.append(
      textNode(`${rep.out.triangles.toLocaleString()} triangles `),
      bold(rep.stop.stoppingReason),
      textNode(rep.stop.requestedTriangles
        ? ` · asked for ${rep.stop.requestedTriangles.toLocaleString()}, ${rep.stop.targetReached ? 'met' : 'refused: the budget is not negotiable'}`
        : ' · the count is what the evidence supports'),
    );
    el.meshSmartBtn.disabled = false;
    showMesh('smart');
    setBusy(false);
    return;
  }

  if (data.type === 'geometry') { finishExport(data); return; }
};

const PHASES = ['Normalising', 'Segmenting', 'Depth', 'Symmetry', 'Volume', 'Isosurface', 'Publishing'];

function setBusy(on) {
  state.busy = on;
  el.runBtn.disabled = on || !state.files.front;
  el.simplifyBtn.disabled = on || !state.result;
  el.progress.hidden = !on;
  if (on) { el.progressFill.style.width = '0%'; el.progressLabel.textContent = 'Reconstructing…'; }
}

el.runBtn.addEventListener('click', () => {
  if (!state.files.front || state.busy) return;
  const mode = el.mode.value;
  const preset = PRESETS[mode];
  el.log.textContent = '';
  setBusy(true);
  log(`mode ${mode} · geometry grid ${preset.w}px · atlas source ${preset.texSrc}px`, 'blue');

  const pack = (slot) => {
    const f = state.files[slot];
    if (!f) return null;
    const rect = subjectRect(f.bitmap, preset.w);
    if (rect) log(`${slot} · subject ${rect.w}×${rect.h} of ${f.bitmap.width}×${f.bitmap.height} · cropped before resampling`);
    else log(`${slot} · no subject found on the probe · resampling the whole frame`, 'amber');
    return { grid: bitmapToPixels(f.bitmap, preset.w, rect), tex: bitmapToPixels(f.bitmap, preset.texSrc, rect) };
  };
  const front = pack('front'), back = pack('back'), profile = pack('profile');

  worker.postMessage({
    type: 'reconstruct', mode,
    grid: front.grid, tex: front.tex,
    back: back ? { grid: back.grid, tex: back.tex } : null,
    profile: profile ? { grid: profile.grid } : null,
    facing: el.facingRight.checked ? 'right' : 'left',
  });
});

el.kappa.addEventListener('input', () => { el.kappaOut.textContent = (+el.kappa.value).toFixed(2); });

el.simplifyBtn.addEventListener('click', () => {
  if (!state.result || state.busy) return;
  setBusy(true);
  el.progressLabel.textContent = 'Simplifying to what the evidence supports…';
  el.progressFill.style.width = '55%';
  worker.postMessage({ type: 'simplify', kappa: +el.kappa.value, target: el.target.value ? +el.target.value : 0 });
});

/* ───────────────────────────────────────────────────────────── the atlas */

/**
 * The atlas the UVs address: observed half on the left, inferred half on the
 * right. With a back view the far half is that photograph; without one it is
 * the near half again, pulled toward grey so the render never claims evidence
 * it does not have.
 */
function buildAtlas(r) {
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

function rgbaCanvas(buf, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
  return c;
}

/* ──────────────────────────────────────────────────────────── presenting */

function showMesh(which) {
  const m = which === 'smart' ? state.smart : state.result;
  if (!m || !viewer) return;
  state.showing = which;
  viewer.setMesh({
    positions: m.positions, normals: m.normals, uvs: m.uvs, indices: m.indices,
    colors: state.view === 'confidence' ? m.confColor : m.baseColor,
    sigma: m.sigma,
  }, state.atlas);
  el.meshFullBtn.classList.toggle('on', which === 'full');
  el.meshSmartBtn.classList.toggle('on', which === 'smart');
  const t = (which === 'smart' ? state.smart.report.out.triangles : state.result.topo.triangles);
  el.exportNote.textContent = which === 'smart'
    ? `Exports carry the evidence-sized mesh: ${t.toLocaleString()} triangles, with the σ it inflated to cover what the collapses moved.`
    : `Exports carry the full mesh: ${t.toLocaleString()} triangles, with _SIGMA — the per-vertex uncertainty — and its units.`;
}

for (const b of document.querySelectorAll('[data-view]')) {
  b.addEventListener('click', () => {
    for (const o of document.querySelectorAll('[data-view]')) o.classList.toggle('on', o === b);
    state.view = b.dataset.view;
    viewer?.setMode(state.view);
    // confidence draws the observed/inferred bands, which live in another array
    showMesh(state.showing);
    showNotice();
  });
}
for (const b of document.querySelectorAll('[data-mesh]')) {
  b.addEventListener('click', () => { if (!b.disabled) showMesh(b.dataset.mesh); });
}
el.spinBtn.addEventListener('click', () => {
  const on = el.spinBtn.getAttribute('aria-pressed') !== 'true';
  viewer?.setSpin(on);
  el.spinBtn.setAttribute('aria-pressed', String(on));
  el.spinBtn.textContent = on ? 'Pause spin' : 'Resume spin';
});

/** What this render adds that the exported bytes do not carry — declared, not implied. */
function showNotice() {
  const shown = ['studioLightRig', 'acesToneMapping'];   // no contact shadow here, so none is claimed
  const names = VIEWER_ONLY_EFFECTS.filter((e) => shown.includes(e.id)).map((e) => e.id).join(' · ');
  el.viewerNotice.hidden = false;
  el.viewerNotice.innerHTML = '';
  el.viewerNotice.append(bold(VIEWER_ONLY_NOTICE), textNode(` Viewer-only: ${names}. `),
    textNode(state.view === 'sigma'
      ? `Colour is σ, blue to red, scaled to the 97th percentile (${viewer?.sigmaP97?.toFixed(2) ?? '?'}px of the working grid) — an ordering, not a probability.`
      : state.view === 'confidence'
        ? 'Red is surface no camera saw; the mesh renders it dimmer because it is completed by symmetry, not measured.'
        : 'The far half of the atlas is desaturated where it is a mirror rather than a photograph.'));
}

const textNode = (t) => document.createTextNode(t);
const bold = (t) => { const b = document.createElement('b'); b.textContent = t; return b; };

function fillReadout(r) {
  const rows = [];
  const add = (k, v, cls) => rows.push([k, v, cls]);
  add('Triangles', r.topo.triangles.toLocaleString());
  add('Watertight', r.topo.watertight ? 'yes' : `no · ${r.topo.nonman} non-manifold`, r.topo.watertight ? 'good' : 'warn');
  add('Shells', String(r.topo.shells));
  add('Lens', r.cam.known ? `${r.cam.mm35}mm equiv · ${r.cam.source}` : 'unknown — orthographic', r.cam.known ? 'good' : 'warn');
  add('σ median', `${r.sigStats.p50.toFixed(2)}px`, null);
  add('σ p90', `${r.sigStats.p90.toFixed(2)}px`, null);
  add('σ calibrated', r.sigStats.calibrated ? 'yes' : 'no — an ordering only', r.sigStats.calibrated ? 'good' : 'warn');
  add('Observed', `${Math.round(r.conf.observed * 100)}%`);
  add('Completed', `${Math.round(r.conf.completed * 100)}%`, 'warn');
  add('Re-projection', `${r.reproj.offsetPx.toFixed(2)}px boundary`, r.reproj.offsetPx < 1 ? 'good' : 'warn');
  add('Silhouette IoU', r.reproj.iou.toFixed(4));
  add('Views', String(r.stats.views));
  add('Joints', String(r.joints));
  add('Atlas', r.summary.tex);
  add('Build', `${(r.stats.ms / 1000).toFixed(1)}s`);

  el.readout.innerHTML = '';
  for (const [k, v, cls] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v; if (cls) dd.className = cls;
    el.readout.append(dt, dd);
  }
  for (const n of r.notes) if (n.mark === '※') log(`※ ${n.text}`, 'amber');
}

/* ──────────────────────────────────────────────────────────────── export */

async function atlasPngBytes() {
  if (state.atlasPng) return state.atlasPng;
  const blob = await new Promise((res) => state.atlas.toBlob(res, 'image/png'));
  state.atlasPng = new Uint8Array(await blob.arrayBuffer());
  return state.atlasPng;
}

function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

let pendingExport = null;

function requestGeometry(kind) {
  if (!state.result || state.busy) return;
  pendingExport = kind;
  // The mission's figure is a static prop: the evidence-sized mesh, at most 24k triangles, no skin (as See yourself).
  if (kind === 'mission') { worker.postMessage({ type: 'exportGeometry', which: 'smart', kappa: 1, target: 24000 }); return; }
  worker.postMessage({
    type: 'exportGeometry',
    which: state.showing,
    kappa: state.showing === 'smart' ? +el.kappa.value : undefined,
    target: state.showing === 'smart' && el.target.value ? +el.target.value : 0,
  });
}

async function finishExport(data) {
  const kind = pendingExport; pendingExport = null;
  const id = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
  const png = await atlasPngBytes();
  const geo = { ...data.geo, sigmaMeta: data.sigmaMeta };
  try {
    if (kind === 'glb') {
      const bytes = glbBytes(geo, png, id, data.rig, null);
      save(new Blob([bytes], { type: 'model/gltf-binary' }), `visigence-${id}.glb`);
      log(`GLB · ${(bytes.length / 1048576).toFixed(2)}MB · ${(geo.indices.length / 3).toLocaleString()} triangles`, 'green');
    } else if (kind === 'mission') {
      // Into the one editor's mission: the editor opens the Mission view's prop importer on it (editor/world/game.js).
      // The mission's props carry a texture of at most 2048 px a side (the importer's rule), as See yourself's does.
      const fitted = await canvasPngBytes(fitAtlas(state.atlas, 2048));
      const bytes = glbBytes(geo, fitted, id, null, null);
      window.parent?.postMessage({ type: 'visigence:figure', figure: { bytes, name: 'My figure', triangles: geo.indices.length / 3 } }, location.origin);
      log(`Into the mission · ${(geo.indices.length / 3).toLocaleString()} triangles · the Mission view opens on it`, 'green');
    } else if (kind === 'obj') {
      const files = makeOBJ(geo, id);
      files.push({ name: `atlas-${id}.png`, data: png });
      save(makeZip(files), `visigence-${id}.zip`);
      log(`OBJ + MTL + PNG · zipped`, 'green');
    }
  } catch (err) {
    log(`export failed: ${err.message}`, 'red');
  }
}

el.glbBtn.addEventListener('click', () => requestGeometry('glb'));
document.getElementById('missionBtn')?.addEventListener('click', () => requestGeometry('mission'));
if (window.parent === window) document.getElementById('missionBtn')?.remove();   // only inside the editor
el.objBtn.addEventListener('click', () => requestGeometry('obj'));
el.atlasBtn.addEventListener('click', async () => {
  if (!state.atlas) return;
  const png = await atlasPngBytes();
  save(new Blob([png], { type: 'image/png' }), `visigence-atlas.png`);
  log(`atlas PNG · ${state.atlas.width}×${state.atlas.height}`, 'green');
});

log('ready · drop a photograph to begin', 'blue');
