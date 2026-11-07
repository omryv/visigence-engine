import { assetURL } from '../config/assetDelivery.js';
/**
 * Progressive GLB loading with an explicit mandatory-asset contract.
 *
 * A mandatory asset that resolves to NONE of its candidate paths raises a hard error
 * naming every path tried, and the app enters ERROR. Nothing is silently replaced with a
 * placeholder box.
 *
 * Each GLB bakes a single base-colour JPEG, shipped at 2048x2048 (tools/build/shrink-textures.mjs
 * keeps them there - they arrived at 4096 and, for the hands and enemies, 8192, which is
 * 268 MB of RGBA per decode and enough to get the page killed on a phone). 2048 is the
 * highest cap any profile has; the lower tiers are downscaled on a canvas as they load.
 *
 * MEMORY IS RELEASED AS EACH FILE LANDS. GLTFLoader keeps, on the parser it returns, the
 * whole binary chunk, a cached copy of every bufferView it sliced out of it, and the
 * original full-size textures - between them a second and third copy of the file that
 * nothing in the game ever reads again. `_release` drops all of it, which is what keeps a
 * phone's WebContent process under the limit at which iOS reloads the page.
 */

import { LoadingManager, SRGBColorSpace, CanvasTexture, Source, Box3, Vector3 } from 'three/webgpu';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export class MandatoryAssetError extends Error {
  constructor(key, paths, cause) {
    super(
      `MANDATORY ASSET MISSING: "${key}" could not be loaded.\n` +
      `Tried, in order:\n${paths.map((p) => `    ${p}`).join('\n')}\n` +
      `Last error: ${cause?.message || cause}`
    );
    this.name = 'MandatoryAssetError';
    this.key = key;
    this.paths = paths;
  }
}


/** Updated geometry must bypass the week-long GLB cache of a previous release. */
function requestPath(def, path) {
  path = assetURL(path);
  return def.revision ? `${path}${path.includes('?') ? '&' : '?'}v=${encodeURIComponent(def.revision)}` : path;
}

/**
 * A LOAD THAT TAKES TOO LONG, OR DECODES TOO MUCH, IS A FAILED LOAD.
 *
 * Every asset the session loads is fetched, parsed and decoded on the player's machine,
 * and a creator's imported prop is a file nobody here has seen. The import dialog checks
 * the file's bytes, triangles and texture sizes before it is accepted; these two guards
 * are the runtime's own limits, enforced on the parsed result whatever the file claimed,
 * so a prop that stalls the network or decodes into a quarter gigabyte of pixels fails
 * with its name on the error rather than taking the session down with it.
 *
 * `deadlineMs` bounds the whole load (fetch, parse, texture decode). `maxDecodedTextureBytes`
 * bounds the RGBA pixels its materials reference, counted once per shared image. Both are
 * per definition (`definitions[key]`), with these defaults for definitions that set none;
 * the session sets the import budget explicitly (game/ShooterSession.js).
 */
export const DEFAULT_LOAD_DEADLINE_MS = 120000;
/** The import dialog's own ceiling (editor/assetImport.js): 64 MB of decoded RGBA per prop. */
export const IMPORTED_PROP_TEXTURE_BYTES = 64 * 1024 * 1024;
export const IMPORTED_PROP_DEADLINE_MS = 45000;

export class AssetBudgetError extends Error {
  constructor(key, limit, message) {
    super(`ASSET OVER BUDGET: "${key}" ${message}`);
    this.name = 'AssetBudgetError';
    this.key = key;
    this.limit = limit;
  }
}

/** Resolve with `promise`, or reject once `ms` have passed. The late result is dropped. */
export function withDeadline(promise, ms, onTimeout) {
  let timer = null;
  const expiry = new Promise((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms); });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/** RGBA bytes a decoded image occupies, or 0 when its size is unknown (compressed, data). */
export function decodedImageBytes(image) {
  const w = image?.width | 0, h = image?.height | 0;
  return w > 0 && h > 0 ? w * h * 4 : 0;
}

export class AssetLoader {
  constructor({ maxTextureSize = 2048, anisotropy = 4, definitions = {} } = {}) {
    this.definitions = definitions;
    this.maxTextureSize = maxTextureSize;
    this.anisotropy = anisotropy;
    this.manager = new LoadingManager();
    this.loader = new GLTFLoader(this.manager);
    // Every staged GLB is EXT_meshopt_compression-packed (tools/compress-models: gltfpack
    // -cc -noq, so geometry stays bit-exact float and the node structure is untouched).
    // The decoder is vendored beside the loader; a GLB without the extension ignores it.
    this.loader.setMeshoptDecoder(MeshoptDecoder);
    /** @type {Map<string, {gltf: object, path: string, box: Box3, size: Vector3}>} */
    this.loaded = new Map();this.surfaceTextures=new Map();
    /** Paths that resolved, for the completion report. */
    this.resolved = {};
    /** Non-fatal problems worth surfacing (optional asset missing, fallback path used). */
    this.warnings = [];
    this._textureCache = new Map();
    this._imageCache = new Map();
    this._sharedTextures = new Map();
    this._inflight = new Map();
  }

  enableCompressedTextures(renderer) {
    this.ktx2=new KTX2Loader(this.manager).setTranscoderPath('/vendor/three/examples/jsm/libs/basis/').setWorkerLimit(2).detectSupport(renderer);
    this.loader.setKTX2Loader(this.ktx2);
  }

  async loadSurface(path){
    if(this.surfaceTextures.has(path))return this.surfaceTextures.get(path);
    const texture=await this.ktx2.loadAsync(assetURL(path));
    if(this._disposed){texture.dispose();throw new Error('Asset loader disposed');}
    this.surfaceTextures.set(path,texture);return texture;
  }
  retainSurfaces(paths){const keep=new Set(paths);for(const [path,texture]of this.surfaceTextures)if(!keep.has(path)){texture.dispose();this.surfaceTextures.delete(path);}}

  get(key) {
    const e = this.loaded.get(key);
    if (!e) throw new Error(`Asset "${key}" was never loaded`);
    return e;
  }

  has(key) { return this.loaded.has(key); }

  /**
   * Loads one logical asset by trying its candidate paths in order.
   * A 404 on the brief's spelling then success on the repository's is recorded as a
   * warning, not hidden.
   */
  async loadOne(key) {
    if (this._disposed) throw new Error('Asset loader disposed');
    if (this.loaded.has(key)) return this.loaded.get(key);
    if (this._inflight.has(key)) return this._inflight.get(key);
    const pending = this._loadOne(key);
    this._inflight.set(key, pending);
    try { return await pending; } finally { this._inflight.delete(key); }
  }

  async _loadOne(key) {
    const def = this.definitions[key];
    if (!def) throw new Error(`Unknown asset key "${key}"`);
    let lastErr = null;
    for (let i = 0; i < def.paths.length; i++) {
      const path = def.paths[i];
      try {
        const deadline = def.deadlineMs ?? DEFAULT_LOAD_DEADLINE_MS;
        const gltf = await withDeadline(this.loader.loadAsync(requestPath(def, path)), deadline,
          () => new AssetBudgetError(key, deadline, `did not finish loading within ${Math.round(deadline / 1000)} s (${path})`));
        if (this._disposed) {
          const resources = new Set();
          collectResources(gltf.scene, resources);
          for (const resource of resources) resource.dispose?.();
          this._release(gltf);
          throw new Error('Asset loader disposed');
        }
        const imageKeys=new WeakMap();
        for(const [object,association]of gltf.parser?.associations??[]){
          if(!object.isTexture||association.textures===undefined)continue;
          const texture=gltf.parser.json.textures[association.textures],image=gltf.parser.json.images[texture.extensions?.KHR_texture_basisu?.source??texture.source];
          if(image?.uri)imageKeys.set(object,new URL(image.uri,new URL(requestPath(def,path),globalThis.location?.href??'http://localhost/')).href);
        }
        if (def.maxDecodedTextureBytes) this._assertTextureBudget(key, gltf.scene, def.maxDecodedTextureBytes);
        this._processMaterials(gltf.scene,def.sharedTextureNamespace,def.maxTextureSize,imageKeys);
        this._release(gltf);
        const box = new Box3().setFromObject(gltf.scene, true);
        const size = box.getSize(new Vector3());
        this.loaded.set(key, { gltf, path, box, size });
        this.resolved[key] = path;
        if (i > 0) {
          this.warnings.push(
            `"${key}": ${def.paths.slice(0, i).join(', ')} not found; using ${path}`
          );
        }
        return this.loaded.get(key);
      } catch (err) {
        if (this._disposed) throw err;
        lastErr = err;
      }
    }
    if (def.mandatory) throw new MandatoryAssetError(key, def.paths, lastErr);
    this.warnings.push(`Optional asset "${key}" unavailable (${def.paths.join(', ')})`);
    return null;
  }

  /**
   * Refuse a parsed model whose materials reference more decoded pixels than `limit`,
   * before any of them is uploaded or downscaled. Each image is counted once however many
   * materials and slots share it, which is what a GPU would pay too. Throws AssetBudgetError.
   */
  _assertTextureBudget(key, root, limit) {
    const seen = new Set();
    let bytes = 0;
    root.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m) continue;
        for (const value of Object.values(m)) {
          if (!value?.isTexture || !value.image) continue;
          const image = value.source?.data ?? value.image;
          if (seen.has(image)) continue;
          seen.add(image);
          bytes += decodedImageBytes(image);
        }
      }
    });
    if (bytes > limit) {
      throw new AssetBudgetError(key, limit,
        `decodes ${Math.round(bytes / 1048576)} MB of texture, the limit is ${Math.round(limit / 1048576)} MB`);
    }
    return bytes;
  }

  /**
   * Downscale oversized textures and normalise the PBR response.
   * Tripo exports arrive as MeshPhysicalMaterial (they declare KHR_materials_specular and
   * KHR_materials_volume) with metalness 0 / roughness 0.5 and no normal map.
   */
  _processMaterials(root,namespace=null,maxTextureSize=this.maxTextureSize,imageKeys=new WeakMap()) {
    root.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        if(namespace==='mobile-v1'&&m.transparent)m.forceSinglePass=true;
        for (const slot of ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
          const t = m[slot];
          if (!t?.image) continue;
          const identity=imageKeys.get(t)??t.name;
          const key=namespace&&identity?JSON.stringify([namespace,identity,maxTextureSize,t.colorSpace,t.channel,t.wrapS,t.wrapT,t.repeat.toArray(),t.offset.toArray(),t.rotation]):null;
          const shared=key&&this._sharedTextures.get(key);
          const scaled = shared || this._downscale(t, slot === 'map' || slot === 'emissiveMap',maxTextureSize);
          if(key&&!shared)this._sharedTextures.set(key,scaled);
          if (scaled !== t) m[slot] = scaled;
          m[slot].anisotropy = this.anisotropy;
          m[slot].needsUpdate = true;
        }
      }
    });
  }

  /**
   * Let go of everything the parser kept that the scene does not need.
   *
   * After parse() the GLTFParser still holds: the GLB's binary chunk (`KHR_binary_glTF`
   * extension body), the cache of every bufferView/accessor/image promise it resolved -
   * each bufferView a fresh slice, so that is a second copy of the file - and the
   * texture/source caches that keep the original full-size images alive after
   * _processMaterials has swapped the downscaled copies in. Geometry attributes are their
   * own copies, so none of this is referenced by anything in `gltf.scene`. Measured on the
   * shipped set: 306 MB of heap after boot with it, and the difference is what a phone
   * has to spare.
   *
   * Nothing in this project reads `gltf.parser` after load; if something ever needs the
   * associations map or a cached accessor, it has to take it before this runs.
   */
  _release(gltf) {
    const parser = gltf?.parser;
    if (!parser) return;
    parser.cache?.removeAll?.();
    const bin = parser.extensions?.KHR_binary_glTF;
    if (bin) bin.body = null;
    parser.textureCache = {};
    parser.sourceCache = {};
    parser.associations?.clear?.();
  }

  /**
   * Canvas-downscale a texture whose image exceeds the tier cap. Returns the original if
   * it is already small enough or cannot be drawn.
   *
   * Canvas pixels are shared by source. Texture wrappers remain per texture and colour
   * role: samplers, UV transforms, channels and colour spaces can differ over one image.
   */
  _downscale(texture, isColor,max=this.maxTextureSize) {
    const cacheKey = `${texture.uuid}:${max}:${isColor}`;
    const cached = this._textureCache.get(cacheKey);
    if (cached) return cached;

    const img = texture.image;
    const w = img.width | 0, h = img.height | 0;
    if (!w || !h || (w <= max && h <= max)) return texture;

    const scale = max / Math.max(w, h);
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const imageKey = `${texture.source?.uuid ?? texture.uuid}:${max}`;
    let source = this._imageCache.get(imageKey);
    let canvas = source?.data;
    if (!canvas) try {
      canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, cw, ch);
      source = new Source(canvas);
      this._imageCache.set(imageKey, source);
    } catch {
      return texture;   // tainted or undrawable - keep the original
    }
    const out = new CanvasTexture(canvas);
    out.copy(texture);
    // Preserve shared upload ownership without changing the original full-size Source.
    out.source = source;
    out.colorSpace = isColor ? SRGBColorSpace : texture.colorSpace;
    out.needsUpdate = true;
    this._textureCache.set(cacheKey, out);
    return out;
  }

  /** Free every GPU resource this loader created. */
  retain(keys) {
    const keep=new Set(keys),resources=new Set();
    for(const [key,{gltf}]of this.loaded){if(keep.has(key))continue;collectResources(gltf.scene,resources);this.loaded.delete(key);}
    const retained=new Set();for(const {gltf}of this.loaded.values())collectResources(gltf.scene,retained);
    for(const resource of resources)if(!retained.has(resource))resource.dispose?.();
    for(const [key,texture]of this._sharedTextures)if(!retained.has(texture))this._sharedTextures.delete(key);
    this._textureCache.clear();this._imageCache.clear();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;this.ktx2?.dispose();for(const texture of this.surfaceTextures.values())texture.dispose();this.surfaceTextures.clear();
    const resources = new Set();
    for (const { gltf } of this.loaded.values()) {
      collectResources(gltf.scene, resources);
    }
    for (const t of this._textureCache.values()) resources.add(t);
    for (const resource of resources) resource.dispose?.();
    this._textureCache.clear();
    this._imageCache.clear();
    this.loaded.clear();
    this._sharedTextures.clear();
  }
}

function collectResources(root, resources) {
  root.traverse(o => {
    if (!o.isMesh) return;
    if (o.geometry) resources.add(o.geometry);
    for (const material of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!material) continue;
      for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
      resources.add(material);
    }
  });
}
