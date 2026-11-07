/** Only portable, declared image assets enter project/export metadata. */
export function normalizePresentation(input={}) {
  if(!input||typeof input!=='object')throw Error('Invalid mission identity.');
  const result={studioName:String(input.studioName??'').trim().slice(0,64),accent:input.accent??'#ec9a52'};
  if(!/^#[0-9a-f]{6}$/i.test(result.accent))throw Error('Choose a valid accent color.');
  for(const kind of ['artwork','logo']){
    const a=input[kind];if(!a)continue;
    if(!/^[a-f0-9]{64}$/.test(a.id)||!['image/png','image/jpeg'].includes(a.mime)||!Number.isInteger(a.bytes)||a.bytes<24||a.bytes>4*1024*1024||![a.width,a.height].every(n=>Number.isInteger(n)&&n>0&&n<=4096))throw Error('Use PNG/JPEG artwork under 4 MB and 4096 pixels per side.');
    if(a.rightsConfirmed!==true||!String(a.creator??'').trim()||!String(a.license??'').trim())throw Error('Artwork needs creator, licence and redistribution permission.');
    result[kind]={id:a.id,model:`imports/${a.id}.${a.mime==='image/png'?'png':'jpg'}`,mime:a.mime,bytes:a.bytes,width:a.width,height:a.height,creator:String(a.creator).trim().slice(0,160),license:String(a.license).trim().slice(0,300),source:String(a.source??'').slice(0,300),rightsConfirmed:true};
  }
  return result;
}
export function presentationFiles(project){return [project.presentation?.artwork,project.presentation?.logo].filter(Boolean);}
