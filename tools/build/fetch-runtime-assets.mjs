/** Restore ignored local art for offline tests/Blender work; hosting needs no download. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { ASSET_ORIGIN } from '../../src/config/assetDelivery.js';
import { root, writeAssetManifest } from './asset-manifest.mjs';
const run = promisify(execFile), manifest = writeAssetManifest();
const matches = (file,item) => fs.existsSync(file) && fs.statSync(file).size === item.bytes && createHash('sha256').update(fs.readFileSync(file)).digest('hex') === item.sha256;
let cursor=0,downloaded=0,cached=0;
await Promise.all(Array.from({length:4},async()=>{
  while(cursor<manifest.files.length){
    const item=manifest.files[cursor++],file=path.resolve(root,item.path);
    if(!item.path.startsWith('assets/')||!file.startsWith(root)||item.path.split('/').includes('..'))throw Error(`Invalid asset path: ${item.path}`);
    if(matches(file,item)){cached++;continue;}
    const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'visigames-art-')),temp=path.join(scratch,'asset');
    try{
      await run('curl',['--silent','--show-error','--fail','--retry','2','--max-time','90','-o',temp,`${ASSET_ORIGIN}/${item.remotePath??item.path}`]);
      if(!matches(temp,item))throw Error(`Checksum mismatch: ${item.path}`);
      fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(temp,file);downloaded++;
    }finally{fs.rmSync(scratch,{recursive:true,force:true});}
  }
}));
console.log(`${downloaded} assets restored, ${cached} verified cache hits. Local runtime art is ignored by Git.`);
