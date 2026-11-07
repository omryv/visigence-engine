const urls = new Map();
export function localAssetURL(path) { return urls.get(path.replace(/^\//,'')); }
export function registerLocalAsset(path,blob) {
  const prior=urls.get(path);if(prior)URL.revokeObjectURL(prior);
  const url=URL.createObjectURL(blob);urls.set(path,url);return url;
}
