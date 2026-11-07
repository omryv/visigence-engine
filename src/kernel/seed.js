// Seed identity: a world's NAME is a typed string like "K7QN-3F2A-9XBD".
// Everything derived from a seed goes through here so the editor, VSight and
// the Unity export all agree bit-for-bit. Pure JS — runs in JSC tests.

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O/1/I/L ambiguity

/* The seed the editor opens on when nobody names one. A fixed name, not a draw: the first world anybody sees is the
   same world every time, and it is this seed's own world, grown from it and nothing else. Chosen once, by measure:
   about 70 % land and close to 300 m of relief at the default params, a coast with country behind it. */
export const DEFAULT_SEED = "H22U-WCBP-M4BS";

/* A seed spelled from a stream of numbers in [0, 1): deterministic when the stream is, which every stream in this
   engine is (mulberry32, channelRng). There is no default: the engine never draws a seed from ambient entropy, so a
   caller that wants a fresh seed names the stream it comes from. */
export function drawSeed(rng) {
  if (typeof rng !== "function") throw new TypeError("drawSeed(rng): name the stream the seed is drawn from");
  let s = "";
  for (let g = 0; g < 3; g++) {
    if (g) s += "-";
    for (let i = 0; i < 4; i++) s += ALPHABET[(rng() * ALPHABET.length) | 0];
  }
  return s;
}

export function normalizeSeed(input) {
  const raw = String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!raw) return null;
  const groups = [];
  for (let i = 0; i < 12; i += 4) groups.push(raw.slice(i, i + 4).padEnd(4, "2"));
  return groups.slice(0, 3).join("-");
}

// FNV-1a 32-bit over the string bytes.
export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Independent 32-bit stream per subsystem: channel("K7QN-…", "terrain") etc.
export function seedChannel(seed, channel) {
  return hashSeed(seed + ":" + channel);
}

// mulberry32 — tiny deterministic PRNG, identical across JS engines.
export function mulberry32(a) {
  a = a >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function channelRng(seed, channel) {
  return mulberry32(seedChannel(seed, channel));
}
