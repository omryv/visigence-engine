/** Stage the new studio artwork without changing live delivery or deleting originals. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const names=['import-demo.glb','mission-beacon.glb','visigames-mark.svg','asset-cube.svg','shuffle.svg','play.svg'];
const output='.r2-upload/visigames-studio';
const files=[];
for(const name of names){
 const source=`assets/studio/${name}`,bytes=await fs.readFile(source),target=path.join(output,source);
 await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);
 files.push({path:source,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
const manifest={version:1,totalBytes:files.reduce((n,f)=>n+f.bytes,0),files};
await fs.writeFile('tools/assets/studio-manifest.json',JSON.stringify(manifest,null,2)+'\n');
await fs.writeFile(`${output}/UPLOAD-INSTRUCTIONS.txt`,[
 'Upload the assets folder in this package into the ROOT of the existing R2 bucket.',
 'Preserve assets/studio/<filename> exactly. Do not create assets/assets/.',
 'If uploading individual files, open the assets/studio prefix first.',
 'Keep existing bucket files. Upload the six files, not this text file or the ZIP itself.',
 'PNG: image/png; SVG: image/svg+xml; GLB: model/gltf-binary.',
 'The bucket must permit public GET with CORS for https://visigames.vercel.app.',
 'Delivery remains local until remote hashes/CORS pass verification; then switch paths and remove Git-tracked asset copies.',
 'Keep the original local files until verification is complete.'
].join('\n')+'\n');
console.log(`${files.length} files (${manifest.totalBytes} bytes) staged at ${path.resolve(output)}.`);
