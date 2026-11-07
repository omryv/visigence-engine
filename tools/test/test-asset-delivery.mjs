import assert from 'node:assert/strict';
import { ASSET_ORIGIN, assetURL } from '../../src/config/assetDelivery.js';
import { runtimeAssets } from '../build/asset-manifest.mjs';
for (const file of runtimeAssets()) {
  assert.equal(assetURL(file),`${ASSET_ORIGIN}/${file}`);
  assert.equal(assetURL('/'+file),`${ASSET_ORIGIN}/${file}`);
}
assert.equal(assetURL('/assets/v2/arcade/a.glb?v=123'),`${ASSET_ORIGIN}/assets/v2/arcade/a.glb?v=123`);
assert.equal(assetURL('/packs/arcade/pack.json'),'/packs/arcade/pack.json');
assert.equal(assetURL('data:image/png;base64,abc'),'data:image/png;base64,abc');
assert.equal(assetURL(`${ASSET_ORIGIN}/assets/a.glb`),`${ASSET_ORIGIN}/assets/a.glb`);
globalThis.location={hostname:'localhost',search:''};
try {
  assert.equal(assetURL('assets/v2/arcade/arcade-slime.glb'),'/assets/v2/arcade/arcade-slime.glb','local Arcade art is the Blender output');
  globalThis.location.search='?assets=remote';
  assert.equal(assetURL('assets/v2/arcade/arcade-slime.glb'),`${ASSET_ORIGIN}/assets/v2/arcade/arcade-slime.glb`);
}
finally {delete globalThis.location;}
globalThis.document={body:{dataset:{build:'standalone'}}};
try {
  assert.equal(assetURL('assets/v2/arcade/catalog/slime.png'),'/assets/v2/arcade/catalog/slime.png');
  for(const file of runtimeAssets().filter(p=>p.startsWith('assets/studio/')))assert.equal(assetURL(file),'/'+file,'standalone artwork must remain local');
}
finally {delete globalThis.document;}
console.log('All runtime paths route to R2; standalone ZIPs retain local asset paths.');
