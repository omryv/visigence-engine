/**
 * The shipped GLBs are EXT_meshopt_compression-packed, exactly as the game loads them
 * (core/AssetLoader.js sets the same vendored decoder). Every GLTFLoader the harness builds
 * goes through here so a compressed file parses instead of throwing.
 */
import { MeshoptDecoder } from '../../vendor/three/examples/jsm/libs/meshopt_decoder.module.js';

await MeshoptDecoder.ready;

export function withMeshopt(loader) {
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}
