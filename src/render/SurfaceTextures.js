import { assetURL } from '../config/assetDelivery.js';
/** Authored PBR surface maps (base colour, normal, roughness) as a tiled MeshStandardMaterial. */

import {
  RepeatWrapping, SRGBColorSpace, TextureLoader, MeshStandardMaterial,
} from 'three/webgpu';

/**
 * THE AUTHORED SURFACES (village, museum, cinema), loaded under the same budget as
 * everything else.
 *
 * Those three sectors ship their walls and floors as 2048 px PNG sets - six maps, about
 * 100 MB of RGBA once decoded, plus mips - and until now they were loaded straight into
 * the GPU whatever the profile said, while every GLB texture was being capped at
 * `maxTextureSize` by core/AssetLoader.js. A `lean` phone therefore carried more texture
 * memory in the village than a desktop carried in the level, and the two sets of
 * sectors could not be said to have one texture budget. The cap lands here now, by the
 * same canvas downscale the loader uses: at 1024 the village wall is 256 px per metre,
 * which is exactly the level's density, so the campaign reads as one product from one
 * pipeline rather than two. `full` keeps every texel.
 *
 * @param {Record<'map'|'normalMap'|'roughnessMap', string>} urls
 * @param {{tileMetres: number, anisotropy?: number, maxSize?: number, roughness?: number, metalness?: number}} o
 */
export function authoredSurfaceMaterial(urls, { tileMetres, anisotropy = 8, maxSize = Infinity, roughness = 1, metalness = 0, textureScale, textures }) {
  const loader = new TextureLoader();
  const maps = {};
  for (const [slot, url] of Object.entries(urls)) {
    const isColor = slot === 'map';
    const t = textures?.get(url.replace(/^\//,''))?.clone() ?? loader.load(assetURL(url), (tex) => {
      const img = tex.image;
      const w = img?.width | 0, h = img?.height | 0;
      if (!w || !h || (w <= maxSize && h <= maxSize)) return;
      try {
        const scale = maxSize / Math.max(w, h);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        tex.image = canvas;
        tex.needsUpdate = true;
      } catch { /* undrawable: keep the original */ }
    });
    t.wrapS = t.wrapT = RepeatWrapping;
    t.repeat.setScalar(textureScale / tileMetres);
    t.anisotropy = anisotropy;
    if (isColor) t.colorSpace = SRGBColorSpace;
    maps[slot] = t;
  }
  return new MeshStandardMaterial({ ...maps, roughness, metalness });
}
