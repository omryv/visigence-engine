import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeAssets } from './asset-manifest.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
function walk(dir){return readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(e=>e.name.startsWith('.')?[]:e.isDirectory()?walk(`${dir}/${e.name}`):[`${dir}/${e.name}`]);}
// The engine (its kernel included, at src/kernel/), three and the studio's runtime files. Not src/atlas/: the photograph
// reconstruction is the studio's "See yourself", and a downloaded game carries the figure as the GLB it became.
// Nor the editor's other views (the 2D builder's editor and games, My-3D-Engine): a downloaded 3D game plays one mission.
const OTHER_VIEWS=['src/play2d/editor/','src/play2d/runtime/','src/play2d/art/','src/play2d/templates/','editor/play2d/','editor/my-3d-engine/'];
const files=[...walk('src'),...walk('vendor'),...walk('editor')].filter(p=>/\.(js|css|wasm)$/.test(p)&&!p.startsWith('src/world/levels/')&&!p.startsWith('src/atlas/')&&!OTHER_VIEWS.some(d=>p.startsWith(d)));
files.push(...runtimeAssets().filter(p=>p.startsWith('assets/audio/default/')&&p.endsWith('.mp3')));
// Studio markup references these thumbnails even when exported as a standalone game.
files.push(...runtimeAssets().filter(p=>p.startsWith('assets/catalog/')));
writeFileSync(path.join(root,'editor/runtime-files.json'),JSON.stringify(files.sort(),null,2)+'\n');
