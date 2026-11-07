/** Read-only byte verification; deliberately never deletes local assets. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
import { createHash } from 'node:crypto';
import { ASSET_ORIGIN } from '../../src/config/assetDelivery.js';
import { root, writeAssetManifest } from './asset-manifest.mjs';
const originIndex = process.argv.indexOf('--origin');
const origin = originIndex >= 0 ? process.argv[originIndex + 1] : 'http://127.0.0.1:8123';
if (!origin) throw Error('--origin requires the engine URL origin');
const manifestIndex=process.argv.indexOf('--manifest'),reportIndex=process.argv.indexOf('--report');
const manifest=manifestIndex>=0?JSON.parse(fs.readFileSync(process.argv[manifestIndex+1])):writeAssetManifest(),results=[];let cursor=0;
const reportPath=reportIndex>=0?process.argv[reportIndex+1]:'docs/reports/assets/r2-verification.json';
await Promise.all(Array.from({length:6}, async () => {
  while (cursor < manifest.files.length) {
    const item = manifest.files[cursor++];
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'visigames-r2-'));
    try {
      const body = path.join(scratch,'body'), headers = path.join(scratch,'headers');
      await run('curl',['--silent','--show-error','--fail','--retry','2','--max-time','90','-H',`Origin: ${origin}`,'-D',headers,'-o',body,`${ASSET_ORIGIN}/${item.remotePath??item.path}`]);
      const bytes = fs.readFileSync(body);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const cors = fs.readFileSync(path.join(scratch,'headers'),'utf8').match(/^access-control-allow-origin:\s*(.+)$/im)?.[1].trim() ?? null;
      results.push({path:item.path,ok:bytes.length===item.bytes&&sha256===item.sha256,bytes:bytes.length,sha256,cors,corsAllowed:cors==='*'||cors===origin});
    } catch (error) { results.push({path:item.path,ok:false,error:error.message,corsAllowed:false}); }
    finally { fs.rmSync(scratch,{recursive:true,force:true}); }
    if (results.length % 25 === 0) console.log(`${results.length}/${manifest.files.length} checked`);
  }
}));
results.sort((a,b)=>a.path.localeCompare(b.path));
const report = {base:ASSET_ORIGIN,origin,checked:results.length,passed:results.filter(r=>r.ok).length,corsPassed:results.filter(r=>r.corsAllowed).length,results};
fs.writeFileSync(path.resolve(root,reportPath),JSON.stringify(report,null,2)+'\n');
console.log(`Bytes: ${report.passed}/${report.checked}; CORS: ${report.corsPassed}/${report.checked}`);
if (report.passed !== report.checked || report.corsPassed !== report.checked) process.exitCode = 1;
