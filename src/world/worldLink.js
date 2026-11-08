/**
 * A WORLD IN A LINK: how World mode hands its world to Play.
 *
 * The world editor (world.html) promises to store nothing on the visitor's machine: no local storage, no cookies.
 * So the world it hands to Play travels in the link itself, in the fragment (`#world=…`), which a browser never sends
 * to a server. What travels is what a level's ground needs (world/kernelGround.js worldParamsFor): the seed, the
 * world's `terrain` and `water` params, and a name to show. A named world is about half a kilobyte of it.
 *
 * Plain base64url of UTF-8 JSON, with a version, so a link made today reads tomorrow and a link from a newer build is
 * refused by name rather than misread. Pure: no DOM, no storage.
 */
import { normalizeSeed } from '../kernel/seed.js';
import { normalizeWorldParams, WORLD_PARAMS_MAX_BYTES } from './worldParams.js';

export const WORLD_LINK_VERSION = 1;
export const WORLD_LINK_KEY = 'world';

const toB64 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64 = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0)));
};

/** The fragment value for a world: `{ seed, name?, worldParams }` → a string to put after `#world=`. */
export function encodeWorldLink({ seed, name = null, worldParams }) {
  const s = normalizeSeed(String(seed ?? ''));
  if (!s) throw new Error('a world link needs a seed');
  const params = normalizeWorldParams(worldParams);
  if (!params) throw new Error('a world link needs the world\'s terrain');
  const doc = { v: WORLD_LINK_VERSION, seed: s, ...(name ? { name: String(name).slice(0, 64) } : {}), params };
  return toB64(JSON.stringify(doc));
}

/** The world a fragment value names, or throws saying why it cannot be read. */
export function decodeWorldLink(value) {
  if (typeof value !== 'string' || !value) throw new Error('no world in the link');
  if (value.length > WORLD_PARAMS_MAX_BYTES * 2) throw new Error('the world in the link is too large');
  let doc;
  try { doc = JSON.parse(fromB64(value)); } catch { throw new Error('the world in the link cannot be read'); }
  if (doc?.v !== WORLD_LINK_VERSION) throw new Error(`the world in the link is format ${doc?.v}; this build reads ${WORLD_LINK_VERSION}`);
  const seed = normalizeSeed(String(doc.seed ?? ''));
  if (!seed) throw new Error('the world in the link has no seed');
  const worldParams = normalizeWorldParams(doc.params);
  if (!worldParams) throw new Error('the world in the link has no terrain');
  return { seed, name: typeof doc.name === 'string' ? doc.name.slice(0, 64) : null, worldParams };
}

/** The world a page's address carries in its fragment, or null (and why, when it carries one it cannot read). */
export function worldFromLocation(loc) {
  const m = /(?:^#|&)world=([^&]*)/.exec(loc?.hash ?? '');
  if (!m) return { world: null, error: null };
  try { return { world: decodeWorldLink(decodeURIComponent(m[1])), error: null }; }
  catch (e) { return { world: null, error: e.message }; }
}
