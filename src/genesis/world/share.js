/* share.js — a whole world in a link.
 *
 * A world file is kilobytes (README: params are instructions, not assets), and
 * kilobytes fit in a URL fragment. So a world can travel as a link the way the
 * 2D level builder's games already do (apps/builder2d/builder/core/format.js,
 * whose bounds and whose zip-bomb test this module ports):
 *
 *     encodeWorldLink(doc)                    -> Promise<"#world=1.<base64url>">
 *     decodeWorldLink(hash, { maxBytes })     -> Promise<doc>   (throws FormatError)
 *
 * "1." is deflate-raw through the platform's CompressionStream, then
 * base64url; "0." is the uncompressed fallback a platform without
 * CompressionStream writes. A FRAGMENT, not a query: the part after `#` is
 * never sent to a server, so a world shared this way is not uploaded anywhere
 * by being opened — the same no-network promise worldfile.js makes about
 * files.
 *
 * ── the bounds, and why each one is there ──
 * A link is input from a stranger, and a few kilobytes of deflate can inflate
 * to gigabytes: 64 MB of zeros deflates to a link of about 85 KB
 * (tests/share.test.js measures it). So nothing here ever holds more than
 * `maxBytes` (2 MiB by default, builder2d's MAX_FILE_BYTES) of inflated
 * output: the inflate is STREAMED, its output is counted chunk by chunk, and
 * the moment the count passes the cap the stream is cancelled and the link is
 * refused — before the rest of it is inflated, not after. The link text
 * itself is capped first, at what base64 of a maxBytes payload could ever
 * need, so a 100 MB fragment is refused before it is decoded at all.
 *
 * Every refusal is a FormatError whose `code` names what went wrong — prefix,
 * base64, too-long, no-inflate, inflate, too-large, utf8, json, world — and
 * whose message says it in a sentence a person can act on. A link that
 * decodes but does not hold a valid world is refused with validateWorldFile's
 * own list, so a link is held to exactly what a file dragged in is held to.
 *
 * No DOM (Blob, streams and TextEncoder are in every modern runtime, Node
 * included), no storage, no network, no three.js.
 */

import { validateWorldFile } from "./worldfile.js";

export const LINK_KEY = "world";
export const MAX_LINK_BYTES = 2 * 1024 * 1024;

export class FormatError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "FormatError";
    this.code = code;
  }
}

/* ── base64url ── */

const b64url = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64url = (str) => {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

/** Bytes through a (de)compression stream. Past `limit` output bytes it stops
    reading, cancels the stream and returns null — the cap is enforced on what
    the stream has PRODUCED, so a bomb is stopped one chunk past the limit. */
async function pipeBytes(bytes, stream, limit = Infinity) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * A world document as a link fragment, `#world=1.…` (or `#world=0.…` where
 * the platform has no CompressionStream).
 * @param {object} doc a world file document
 * @returns {Promise<string>}
 */
export async function encodeWorldLink(doc) {
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  if (typeof CompressionStream === "function") {
    return `#${LINK_KEY}=1.` + b64url(await pipeBytes(bytes, new CompressionStream("deflate-raw")));
  }
  return `#${LINK_KEY}=0.` + b64url(bytes);
}

/* The longest base64url text a payload of `n` bytes needs. Deflate can expand
   incompressible input, by 5 bytes per 64 KiB stored block plus a few; the
   1/1000 and 64 bytes of slack cover that with room to spare. */
const maxEncodedChars = (n) => Math.ceil(((n + Math.ceil(n / 1000) + 64) * 4) / 3);

/**
 * The world a link fragment holds. Accepts the fragment with or without its
 * leading `#`. Throws FormatError, never anything else, for a link that is
 * not a world.
 *
 * @param {string} hash
 * @param {{ maxBytes?: number }} [opts]  the most inflated JSON it will hold
 * @returns {Promise<object>} the validated world file document
 */
export async function decodeWorldLink(hash, { maxBytes = MAX_LINK_BYTES } = {}) {
  if (!(Number.isInteger(maxBytes) && maxBytes > 0)) throw new RangeError(`decodeWorldLink: maxBytes must be a positive integer, got ${maxBytes}`);
  const text = String(hash ?? "").trim().replace(/^#/, "");
  // Capped before it is even matched: the prefix is 8 characters at most.
  if (text.length > maxEncodedChars(maxBytes) + 8) {
    throw new FormatError(`This link is ${text.length} characters, longer than any world of at most ${maxBytes} bytes could need`, "too-long");
  }
  const m = new RegExp(`^${LINK_KEY}=([01])\\.([A-Za-z0-9_-]*)$`).exec(text);
  if (!m) throw new FormatError(`This link does not hold a world (expected "#${LINK_KEY}=1.…" or "#${LINK_KEY}=0.…")`, "prefix");
  let bytes;
  try { bytes = unb64url(m[2]); } catch { throw new FormatError("This link is damaged: its payload is not base64url", "base64"); }
  if (m[1] === "1") {
    if (typeof DecompressionStream !== "function") throw new FormatError("This platform cannot inflate a compressed link (no DecompressionStream)", "no-inflate");
    try {
      bytes = await pipeBytes(bytes, new DecompressionStream("deflate-raw"), maxBytes);
    } catch {
      throw new FormatError("This link is damaged: its payload is not deflate-raw", "inflate");
    }
  }
  if (!bytes || bytes.length > maxBytes) throw new FormatError(`This link holds more than ${maxBytes} bytes of world`, "too-large");
  let json;
  try { json = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new FormatError("This link is damaged: its payload is not UTF-8 text", "utf8"); }
  let doc;
  try { doc = JSON.parse(json); } catch (e) { throw new FormatError(`This link does not hold JSON: ${e.message}`, "json"); }
  /* validateWorldFile does not throw — it catches its own — but this
     function's "FormatError, never anything else" should not rest on another
     module keeping its word: a world with `props: 5` once reached a raw
     TypeError here. */
  let errors;
  try { errors = validateWorldFile(doc); } catch (e) { errors = [`not a readable world file (${e?.message ?? e})`]; }
  if (errors.length) throw new FormatError(`This link does not hold a valid world: ${errors.join("; ")}`, "world");
  return doc;
}
