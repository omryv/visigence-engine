/* The engine, off the main thread.
 *
 * Reconstruction is seconds of straight-line arithmetic; running it on the UI
 * thread would freeze the tab and, worse, freeze the progress bar that is
 * supposed to be reporting it. This module imports the engine directly from
 * /src — the same files the npm package exports, with no build step between —
 * and forwards `reconstruct`'s own progress callback as messages.
 *
 * The finished result is kept HERE rather than only sent out, so a second
 * request (simplify at another κ) does not have to re-reconstruct or ship the
 * geometry back and forth. Arrays are cloned rather than transferred for the
 * same reason: the worker keeps its copy.
 */

import { reconstruct } from '../atlas-core.js';
import { smartMesh } from '../smartmesh.js';

let result = null;   // what `reconstruct` last returned

/** Only the parts the page can use; the rest stays in this worker. */
function payload(r) {
  return {
    positions: r.positions, normals: r.normals, uvs: r.uvs, indices: r.indices,
    baseColor: r.baseColor, confColor: r.confColor, sigma: r.sigma, agen: r.agen,
    padded: r.padded, paddedBack: r.paddedBack,
    stats: r.stats, summary: r.summary, topo: r.topo, conf: r.conf, prov: r.prov,
    cam: r.cam, sigStats: r.sigStats, reproj: r.reproj, notes: r.notes,
    joints: r.rig.joints.length,
  };
}

function smartPayload(s) {
  return {
    positions: s.positions, normals: s.normals, uvs: s.uvs, indices: s.indices,
    baseColor: s.baseColor, confColor: s.confColor, sigma: s.sigma, agen: s.agen,
    skinJoints: s.skinJoints, skinWeights: s.skinWeights,
    quads: s.quads, tris: s.tris,
    report: s.report,
  };
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'reconstruct') {
      const { grid, tex, back, profile, facing, mode } = msg;
      const log = [];
      let extra = null;
      if (back || profile) {
        extra = { facing: facing || 'left' };
        if (back) extra.back = { px: back.grid.px, w: back.grid.w, h: back.grid.h, tex: back.tex };
        if (profile) extra.profile = { px: profile.grid.px, w: profile.grid.w, h: profile.grid.h };
      }
      const t0 = Date.now();
      result = reconstruct(
        grid.px, grid.w, grid.h, mode,
        (p) => self.postMessage({ type: 'progress', progress: p.progress, phase: p.phase, stage: p.stage }),
        tex, extra, null,
      );
      self.postMessage({ type: 'done', ms: Date.now() - t0, result: payload(result), log: result.log });
      return;
    }

    if (msg.type === 'simplify') {
      if (!result) throw new Error('nothing to simplify yet');
      const t0 = Date.now();
      const s = smartMesh(result, {
        kappa: msg.kappa,
        target: msg.target || undefined,
        measure: false,           // the true deviation is the benchmark's job, not the page's
      });
      self.postMessage({ type: 'simplified', ms: Date.now() - t0, smart: smartPayload(s) });
      return;
    }

    if (msg.type === 'exportGeometry') {
      // Everything the exporters need for whichever mesh the page is showing.
      if (!result) throw new Error('nothing to export yet');
      const s = msg.which === 'smart' && msg.kappa !== undefined
        ? smartMesh(result, { kappa: msg.kappa, target: msg.target || undefined, measure: false })
        : null;
      const g = s || result;
      self.postMessage({
        type: 'geometry',
        which: msg.which,
        geo: {
          positions: g.positions, normals: g.normals, uvs: g.uvs, indices: g.indices,
          colors: g.baseColor, sigma: g.sigma,
        },
        rig: {
          joints: result.rig.joints, bones: result.rig.bones,
          skinJoints: s ? s.skinJoints : result.rig.skinJoints,
          skinWeights: s ? s.skinWeights : result.rig.skinWeights,
        },
        sigmaMeta: result.sigStats,
      });
      return;
    }

    throw new Error(`unknown request ${msg.type}`);
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
