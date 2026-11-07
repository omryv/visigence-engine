// The runtime's own limits on what an asset may cost: a load deadline and a decoded
// texture budget, both named per asset in the error, both independent of the file's claims.
import assert from 'node:assert/strict';
import { Mesh, BoxGeometry, MeshStandardMaterial, Texture, Group, Source } from 'three/webgpu';
import { AssetLoader, AssetBudgetError, withDeadline, decodedImageBytes, IMPORTED_PROP_TEXTURE_BYTES } from '../../src/core/AssetLoader.js';

// withDeadline: the late result is dropped, the early one wins, the timer never leaks.
await assert.rejects(withDeadline(new Promise(() => {}), 20, () => new Error('late')), /late/);
assert.equal(await withDeadline(Promise.resolve(7), 1000, () => new Error('never')), 7);

// A model that never arrives fails with its key, its path and the deadline, not a hang.
const loader = new AssetLoader({ definitions: { 'imports/abc.glb': { paths: ['/imports/abc.glb'], mandatory: true, deadlineMs: 30 } } });
loader.loader.loadAsync = () => new Promise(() => {});
await assert.rejects(loader.loadOne('imports/abc.glb'), (e) => {
  assert.match(e.message, /MANDATORY ASSET MISSING: "imports\/abc.glb"/);
  assert.match(e.message, /did not finish loading within 0 s \(\/imports\/abc.glb\)/);
  return true;
});

// Decoded bytes: RGBA per pixel, unknown sizes count as nothing.
assert.equal(decodedImageBytes({ width: 2048, height: 2048 }), 16 * 1024 * 1024);
assert.equal(decodedImageBytes({}), 0);
assert.equal(decodedImageBytes(null), 0);

// The texture budget counts each image once across materials and slots, then refuses.
const texture = (w, h) => { const t = new Texture(); t.source = new Source({ width: w, height: h }); return t; };
const shared = texture(4096, 4096);                                    // 64 MB
const scene = new Group();
scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial({ map: shared, roughnessMap: shared })));
scene.add(new Mesh(new BoxGeometry(), [new MeshStandardMaterial({ map: shared }), new MeshStandardMaterial({ normalMap: texture(1, 1) })]));
assert.equal(loader._assertTextureBudget('k', scene, 64 * 1024 * 1024 + 4), 64 * 1024 * 1024 + 4, 'exactly at the limit passes');
scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial({ map: texture(1024, 1024) })));
assert.throws(() => loader._assertTextureBudget('imports/big.glb', scene, IMPORTED_PROP_TEXTURE_BYTES), (e) => {
  assert.ok(e instanceof AssetBudgetError);
  assert.equal(e.key, 'imports/big.glb');
  assert.match(e.message, /decodes 68 MB of texture, the limit is 64 MB/);
  return true;
});

// The budget is enforced from _loadOne on the parsed result, so the file's own claims do not matter.
const guarded = new AssetLoader({ definitions: { 'imports/big.glb': { paths: ['/imports/big.glb'], mandatory: true, maxDecodedTextureBytes: 1024 } } });
guarded.loader.loadAsync = async () => ({ scene, animations: [], parser: null });
await assert.rejects(guarded.loadOne('imports/big.glb'), /ASSET OVER BUDGET: "imports\/big.glb" decodes/);
assert.equal(guarded.has('imports/big.glb'), false, 'a refused asset is not retained');

console.log('Load deadline, decoded-texture budget and their per-asset errors passed');
