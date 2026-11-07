import { localAssetURL } from './localAssets.js';
/** Public asset origin. Logical asset IDs remain repository-relative. */
export const ASSET_ORIGIN = 'https://pub-f1c1beced9f54323ac7db4d8f77fc346.r2.dev';
export function assetURL(value) {
  const input = String(value);
  const path = input.replace(/^\//, '');
  if (localAssetURL(path)) return localAssetURL(path);
  if (path.startsWith('imports/')) return '/' + path;
  if (!path.startsWith('assets/')) return input;
  // Downloaded game ZIPs contain their own verified asset files.
  if (typeof document !== 'undefined' && document.body?.dataset.build === 'standalone') return '/' + path;
  if(typeof location!=='undefined'&&['localhost','127.0.0.1'].includes(location.hostname)){
    const q=new URLSearchParams(location.search);
    if(q.get('debug')==='1'&&q.get('assets')==='local')return '/'+path;
    // v2 art is authored locally (tools/blender/v2) and served from the checkout until it is uploaded.
    if(path.startsWith('assets/v2/')&&q.get('assets')!=='remote')return '/'+path;
  }
  return `${ASSET_ORIGIN}/${path}`;
}
