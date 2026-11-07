// Minimap: top-down palette render of the heightfield onto a 2D canvas,
// with the viewer marker, optional spawn rings, and click-to-travel.

import { elevNorm } from "../kernel/terrain/heightfield.js";
import { wetAt } from "../kernel/water/flood.js";
import { PALETTES, paletteColor, lerpHex } from "./style/palettes.js";
import { createBiomeField } from "../kernel/terrain/climate.js";

export class Minimap {
  constructor(canvas, { onTravel } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.res = 128;
    this.base = null; // ImageData of the terrain, redrawn only on world change
    this.size = 1;
    this.marker = { x: 0, z: 0, yaw: 0 };
    this.rings = null;
    canvas.addEventListener("click", (e) => {
      if (!onTravel) return;
      const r = canvas.getBoundingClientRect();
      const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
      onTravel((u - 0.5) * this.size, (v - 0.5) * this.size);
    });
  }

  // Rebuild the terrain image from a sampler (world change / erosion done).
  // `flood` is the engine's sea-connected mask (water/flood.js); without it
  // the map would paint a landlocked hollow blue while the world renders it
  // as the dry ground it is.
  redraw({ sampler, params, palette, flood = null }) {
    const res = this.res, size = params.terrain.size, height = params.terrain.height;
    // Waterline in metres — the flood slider moves it, so the map has to read
    // it rather than assume the natural coastline at 0.
    const level = params.water.level || 0;
    this.size = size;
    /* Spatial climate, when the world has it: the map's land has to agree
       with the ground the terrain is colouring, or the minimap becomes a
       picture of a different world. Rebuilt per redraw — redraw only fires on
       a world change, and the field costs microseconds against the 16k
       sampler calls below. The sea stays the primary palette's, exactly as
       it does in the renderer. */
    const biomes = createBiomeField(params, (name) => PALETTES[name]?.climate);
    const biomePals = biomes ? biomes.names.map((n) => PALETTES[n]) : null;
    const img = new ImageData(res, res);
    for (let j = 0; j < res; j++) {
      const z = (j / (res - 1) - 0.5) * size;
      for (let i = 0; i < res; i++) {
        const x = (i / (res - 1) - 0.5) * size;
        const h = sampler(x, z);
        let hex;
        const submerged = h < level && (flood ? wetAt(flood, x, z) : true);
        if (params.water.enabled && submerged) {
          const d = Math.min((level - h) / (height * 0.3), 1);
          hex = lerpHex(palette.water.shallow, palette.water.deep, d);
        } else {
          const t = elevNorm(h, height);
          if (biomes) {
            const cb = biomes.blendAt(x, z);
            hex = lerpHex(paletteColor(biomePals[cb.a], t), paletteColor(biomePals[cb.b], t), cb.mix);
          } else {
            hex = paletteColor(palette, t);
          }
          // hillshade from the west
          const dh = sampler(x - size / res, z) - h;
          const shade = Math.max(0.72, Math.min(1.18, 1 + dh * 0.02));
          hex = lerpHex(0x000000, hex, Math.min(shade, 1));
          if (shade > 1) hex = lerpHex(hex, 0xffffff, (shade - 1) * 0.5);
        }
        const p = (j * res + i) * 4;
        img.data[p] = hex >> 16 & 255; img.data[p + 1] = hex >> 8 & 255;
        img.data[p + 2] = hex & 255; img.data[p + 3] = 255;
      }
    }
    this.base = img;
    this.render();
  }

  setMarker(x, z, yaw) {
    const m = this.marker;
    if (Math.abs(m.x - x) < 1 && Math.abs(m.z - z) < 1 && Math.abs(m.yaw - yaw) < 0.05) return;
    this.marker = { x, z, yaw };
    this.render();
  }

  setRings(rings) { this.rings = rings; this.render(); } // [{x,z,r}, …]

  render() {
    if (!this.base) return;
    const ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
    /* THE SCRATCH SURFACE IS KEPT, not minted per call. render() runs on every
       ring change, every flood, every world event and every resize — and each
       call was allocating a whole res² OffscreenCanvas plus a 2D context and
       dropping both for the collector a millisecond later. It is the same
       size every time unless `res` itself changes, which is the only thing
       worth reacting to. `base` still has to be blitted in, because that is
       what putImageData is for; what is saved is the allocation, not the
       copy. */
    if (!this._off || this._offRes !== this.res) {
      this._off = new OffscreenCanvas(this.res, this.res);
      this._offCtx = this._off.getContext("2d");
      this._offRes = this.res;
    }
    const off = this._off;
    this._offCtx.putImageData(this.base, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(off, 0, 0, w, h);

    const toPx = (x, z) => [(x / this.size + 0.5) * w, (z / this.size + 0.5) * h];
    if (this.rings) {
      // The shell's SIGNAL colour — the chart and the chrome agree on what
      // "live" looks like (css/editor.css --signal).
      ctx.strokeStyle = "rgba(25,182,240,0.92)";
      for (const ring of this.rings) {
        const [cx, cy] = toPx(ring.x, ring.z);
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(cx, cy, (ring.r / this.size) * w, 0, Math.PI * 2); ctx.stroke();
      }
    }
    const [mx, my] = toPx(this.marker.x, this.marker.z);
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(-this.marker.yaw);
    ctx.fillStyle = "#9a8cf8";   // --ion: the viewer is a selection, not a signal
    ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(4.2, 5); ctx.lineTo(-4.2, 5); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
}
