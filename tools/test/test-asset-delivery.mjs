import assert from 'node:assert/strict';
import { ASSET_ORIGIN, assetURL, isPackagedGame } from '../../src/config/assetDelivery.js';
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
// The editor's Play runs the same runtime, standalone, on the site (data-embed="world"): its art is on the asset origin,
// not beside the page. This is the deployed failure: every model asked of www.visigenesis.com/assets/, 404.
globalThis.document={body:{dataset:{build:'standalone',embed:'world'}}};
globalThis.location={hostname:'www.visigenesis.com',search:'?embed=world'};
try {
  assert.equal(isPackagedGame(),false,'a game played in the editor is not a downloaded ZIP');
  assert.equal(assetURL('assets/v2/arcade/characters/arcade-hero.glb?v=7dd45daf9161'),`${ASSET_ORIGIN}/assets/v2/arcade/characters/arcade-hero.glb?v=7dd45daf9161`);
  for(const file of runtimeAssets())assert.equal(assetURL(file),`${ASSET_ORIGIN}/${file}`,`${file} in the editor's game`);
}
finally {delete globalThis.document;delete globalThis.location;}
globalThis.document={body:{dataset:{build:'standalone'}}};
try { assert.equal(isPackagedGame(),true); } finally {delete globalThis.document;}
console.log('All runtime paths route to R2, the editor\'s game included; standalone ZIPs retain local asset paths.');
