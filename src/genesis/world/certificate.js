/* certificate.js — a world, signed, and a verifier that does not trust the
 * signature to mean more than it does.
 *
 * The discipline is packages/atlas-core's (src/certificate.js, and its
 * README's "The certificate, and a verifier that does not trust it"), carried
 * over to the one artifact this repository makes that outlives the tab: a
 * `.world.json`. A certificate is a signed statement of what a world IS — the
 * claims tree engine/core/claims.js derives — and verification is
 * RE-DERIVATION, not comparison against a stored copy. A certificate that
 * lies about the world fails with a perfect signature, because the signature
 * only proves the lie has not been edited since; one that is honest and was
 * edited in transit fails on the signature. Both, and it fails twice.
 *
 *     buildCertificate(worldDoc, { key, res })            -> Promise<certificate>
 *     verifyCertificate(cert, worldDoc, { tier })         -> Promise<{ ok, tier, checked, mismatches, key }>
 *     deriveWorldClaims(worldDoc, { res, bake })          -> { claims, manifest }
 *
 * ── what the signature does and does not establish ──
 * ECDSA P-256 over SHA-256, through the platform's own WebCrypto
 * (globalThis.crypto.subtle) — not a hand-rolled implementation: rolling
 * crypto to avoid a dependency is a bad trade, and this repository has no
 * dependencies to avoid it for. The key is INJECTED: a caller that holds one
 * passes `{ privateKey, publicKey }` as CryptoKeys; a caller that does not
 * gets an ephemeral pair minted for this one certificate, and the certificate
 * says `ephemeral: true`, because a key that will not exist tomorrow cannot
 * link anything to anything and the reader is entitled to know that before
 * relying on it. This module never touches storage — it is not where a key
 * lives.
 *
 * So it binds the claims to the world file's bytes, and both to a key. It
 * does NOT establish identity: nobody has vouched for that key, and anyone
 * can generate another. That limit is written into the certificate itself
 * (`establishes`) rather than left for the reader to work out, because a
 * signature that looks like an authenticity guarantee and is not one would be
 * the same fabrication in a different currency.
 *
 * The signer block — public key, ephemeral flag, fingerprint — is INSIDE the
 * signed body. atlas-core signs everything except its signature block, which
 * leaves `ephemeral` editable after signing; here only the signature value
 * itself stands outside what it signs.
 *
 * ── two tiers, and what each is entitled to say ──
 *   tier 1   no bake. The signature over the canonical body; the world file's
 *            SHA-256 against `subject`; every `declared` claim against this
 *            build's constants; every `rederived` claim recomputed from the
 *            world file's params (rederivedClaims); the file's own ground
 *            block, when it carries one, against the claims (a ground the
 *            file states and the certificate calls "unknown" is a mismatch,
 *            not a skip); a no-intent world's zero conditioning; and the
 *            registry's accounting of the tree (every leaf named, every
 *            "unknown" explained, nothing explained as unknown and stated).
 *            Milliseconds. What it CANNOT check is a `derived` claim — a
 *            height hash, a nats value, a reach count — so a certificate
 *            whose derived claim was edited and then re-signed with a fresh
 *            key passes tier 1. tests/certificate.test.js holds that case
 *            and says so, because a tier that is silent about its limit is a
 *            tier that is read as stronger than it is.
 *   tier 2   all of tier 1, and then the ground re-baked through groundBundle
 *            at the certificate's own grid, the intent re-solved, the reach
 *            re-flooded from the file's spawn, and every stated `derived`
 *            claim compared EQUAL — and the file's own ground block, when it
 *            has one, against a bake at the block's own grid, whatever the
 *            certificate states. The same inputs through the same code; no
 *            tolerance, because a tolerance is where a fabricated number
 *            hides. About as long as the bake: 0.73–0.75 s for the default world at
 *            513² on the machine this was written on.
 *
 * ── what is not here ──
 * No DOM, no three.js, no storage, no network: bin/genesis-verify.mjs imports
 * this and nothing else, and tests/certificate.test.js walks that import
 * closure and fails if engine/Engine.js, three or js/studio.js is ever in it.
 * Not part of engine/core, only because WebCrypto is an ambient global and
 * the core reaches for none (tests/boundary.test.js).
 */

import { deriveClaims, rederivedClaims, claimsAccounting, claimLeaves, claimAt, REGISTRY, UNKNOWN, CLAIMS_KIND, CLAIMS_VERSION } from "../../kernel/core/claims.js";
import { CONTROLLER_VERSION } from "../../kernel/core/controller.js";
import { reachTerrain } from "../../kernel/core/terrain-reach.js";
import { groundBundle } from "../../kernel/terrain/ground.js";
import { CANONICAL_RES } from "../../kernel/terrain/canonical.js";
import { createHeightSampler } from "../../kernel/terrain/heightfield.js";
import { GENERATOR_VERSION } from "../../kernel/terrain/fingerprint.js";
import { validateWorldFile, GROUND_BLOCK_FIELDS } from "./worldfile.js";

export const CERT_FORMAT = "visigenesis.certificate@1";
export const SIG_ALG = "ECDSA-P256-SHA256";
/* The largest grid a tier-2 verifier will bake. A certificate names its own
   grid, and a verifier that baked whatever it was told could be handed
   res: 100000 and spend the afternoon on it. 1025² is four times the canonical
   bake and already more than any world in this repository is saved at. */
export const MAX_VERIFY_RES = 1025;

export const ESTABLISHES =
  "INTEGRITY, NOT IDENTITY. The signature proves this document has not been edited since it was signed " +
  "with the key in `signer`, and every claim in it is re-derivable from the world file whose canonical JSON " +
  "(keys sorted) has the SHA-256 `subject.sha256`. Nobody has vouched for that key and anyone can generate another: to make it mean " +
  "\"this came from me\", publish its fingerprint somewhere the reader already trusts.";

const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const SIGN = { name: "ECDSA", hash: "SHA-256" };
const subtle = () => globalThis.crypto?.subtle || null;

/* ── bytes ── */

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (buf) => {
  const a = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s);
};
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));

/**
 * Canonical JSON: keys sorted at every depth. The signature is over BYTES, so
 * two serialisations of the same object must be the same bytes, or a round
 * trip through any JSON library breaks verification for no reason. Numbers
 * keep JavaScript's own shortest round-trip form, which both ends agree on.
 *
 * The string is EMITTED here, key by key, rather than built as a sorted copy
 * and handed to JSON.stringify. The copy was the first version, and it had a
 * hole the review found: `out[k] = …` on a plain object does not copy a member
 * named "__proto__" — JSON.parse makes it an own property, the assignment sets
 * the copy's prototype instead, and JSON.stringify never sees it. So a world
 * file with a "__proto__" member had the same digest as the file without it,
 * and a certificate with one had the same signature, while mergeParams
 * (engine/presets.js) would carry that member into the params it built. Every
 * own enumerable key is serialised now, whatever its name; tests/
 * certificate.test.js injects one into a world and one into a certificate and
 * requires `subject.sha256` and `signature` to be named.
 *
 * Keys sort by UTF-16 code unit (Array.prototype.sort's own order, and RFC
 * 8785's), integer-like keys included — the copy-and-stringify version put
 * those first in numeric order, which was an accident of object key order,
 * not a choice. Values JSON cannot hold are dropped the way JSON.stringify
 * drops them: `undefined` and functions vanish from objects and become null
 * in arrays; NaN and ±Infinity become null.
 */
export function canonicalJSON(value) {
  const emit = (v) => {
    if (v === null || typeof v !== "object") return JSON.stringify(v); // undefined for undefined/functions
    if (Array.isArray(v)) return "[" + v.map((x) => emit(x) ?? "null").join(",") + "]";
    const parts = [];
    for (const k of Object.keys(v).sort()) {
      const e = emit(v[k]);
      if (e !== undefined) parts.push(JSON.stringify(k) + ":" + e);
    }
    return "{" + parts.join(",") + "}";
  };
  return emit(value);
}

export async function sha256Hex(bytes) {
  const s = subtle();
  if (!s) throw new Error("sha256Hex: this platform exposes no WebCrypto");
  return hex(await s.digest("SHA-256", bytes));
}

/** The SHA-256 a certificate states for a world file: over its CANONICAL
    JSON (canonicalJSON, keys sorted), not over the file's bytes as saved —
    so indentation and key order in transit do not matter and every value,
    placements included, does. `sha256sum world.json` will not reproduce it;
    `canonicalJSON(JSON.parse(text))` through SHA-256 will. */
export const worldDigest = (doc) => sha256Hex(new TextEncoder().encode(canonicalJSON(doc)));

/* ── keys ── */

/** A fresh P-256 pair, marked ephemeral: what buildCertificate uses when it
    is handed no key. */
export async function generateSigningKey() {
  const s = subtle();
  if (!s) throw new Error("generateSigningKey: this platform exposes no WebCrypto");
  const kp = await s.generateKey(ECDSA, true, ["sign", "verify"]);
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, ephemeral: true };
}

/** A short, stable fingerprint of a public JWK: the first 16 hex digits of
    the SHA-256 of its canonical {crv, kty, x, y}. */
export async function keyFingerprint(jwk) {
  const pub = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  return (await sha256Hex(new TextEncoder().encode(canonicalJSON(pub)))).slice(0, 16);
}

/* ── the claims, derived ── */

/**
 * Run the pipeline on a world file and derive its claims. The one function
 * buildCertificate states from and verifyCertificate's tier 2 re-derives
 * with, so the two cannot be two implementations of the same thing.
 *
 * @param {object} doc               a valid world file
 * @param {object} [opts]
 * @param {number} [opts.res]        the grid to bake at (default CANONICAL_RES)
 * @param {boolean} [opts.bake]      false skips the bake: the ground and the
 *                                   reach are then unknown, with a reason
 * @returns {{ claims: object, manifest: object|null }}
 */
export function deriveWorldClaims(doc, { res = CANONICAL_RES, bake = true } = {}) {
  const params = doc.world.params;
  const spawn = doc.world.spawn ?? null;
  /* The solve the sampler makes, read off it — null when the world carries
     no intent (heightfield.js), which deriveClaims reads as a fact. */
  const conditioning = createHeightSampler(params).conditioning;
  let manifest = null, reach = null;
  if (bake) {
    const b = groundBundle(params, { res });
    manifest = b.manifest;
    if (spawn && Number.isFinite(spawn.x) && Number.isFinite(spawn.z)) {
      reach = reachTerrain(b.field, { spawn: [spawn.x, spawn.z], level: manifest.waterLevel, wet: b.wet });
    }
  }
  return { claims: deriveClaims({ params, manifest, conditioning, reach, spawn }), manifest };
}

/* Which claim each ground-block line is checked against. */
const BLOCK_CLAIM = Object.fromEntries(GROUND_BLOCK_FIELDS.map((k) => [k, k === "parameterHash" ? "world.parameterHash" : `ground.${k}`]));

/* ── build ── */

/**
 * Sign a world. Refuses (throws) a world file that does not validate, and one
 * whose ground block disagrees with the ground its params actually bake —
 * signing that would be certifying a claim already known to be false.
 *
 * @param {object} world             a world file document (js/worldfile.js)
 * @param {object} [opts]
 * @param {{privateKey: CryptoKey, publicKey: CryptoKey, ephemeral?: boolean}|null} [opts.key]
 *        the signing key; null mints an ephemeral pair and says so
 * @param {number|null} [opts.res]   the grid to bake at: default the file's
 *                                   own ground block's, else CANONICAL_RES
 * @returns {Promise<object>} the certificate
 */
export async function buildCertificate(world, { key = null, res = null } = {}) {
  const s = subtle();
  if (!s) throw new Error("buildCertificate: this platform exposes no WebCrypto, so nothing could be signed");
  const errors = validateWorldFile(world);
  if (errors.length) throw new TypeError(`buildCertificate: not a valid world file — ${errors.join("; ")}`);
  const grid = res ?? world.ground?.res ?? CANONICAL_RES;
  if (!Number.isInteger(grid) || grid < 2 || grid > MAX_VERIFY_RES) {
    throw new RangeError(`buildCertificate: res ${grid} is not a grid a verifier will bake (2–${MAX_VERIFY_RES})`);
  }
  const { claims } = deriveWorldClaims(world, { res: grid });
  if (world.ground) {
    const wrong = GROUND_BLOCK_FIELDS.filter((k) => world.ground[k] !== claimAt(claims, BLOCK_CLAIM[k]));
    if (wrong.length) {
      throw new TypeError(`buildCertificate: the file's ground block is not the ground its params bake at ${grid}² (${wrong.join(", ")})`);
    }
  }

  const signingKey = key || await generateSigningKey();
  const jwk = await s.exportKey("jwk", signingKey.publicKey);
  const publicKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const body = {
    format: CERT_FORMAT,
    subject: { kind: world.kind, fileVersion: world.fileVersion, sha256: await worldDigest(world) },
    claims,
    establishes: ESTABLISHES,
    signer: {
      alg: SIG_ALG,
      publicKey,
      fingerprint: await keyFingerprint(publicKey),
      ephemeral: key ? !!key.ephemeral : true,
    },
  };
  const sig = await s.sign(SIGN, signingKey.privateKey, new TextEncoder().encode(canonicalJSON(body)));
  return { ...body, signature: b64(sig) };
}

/* ── verify ── */

const same = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));

/* What a world with NO intent states about its conditioning, without a bake:
   deriveClaims writes these as "known, and zero" (engine/core/claims.js), so
   for such a world they are rederived, and a certificate that calls them
   "unknown" is declining to state what is plain from the params. The
   registry has to allow "unknown" for them — a world WITH intent whose solve
   was not run has nothing to say — so the permission alone could not catch
   this; the params can. */
const NO_INTENT = { "conditioning.conditioned": false, "conditioning.nats": 0, "conditioning.miss": 0 };

/**
 * Re-derive what a certificate claims about a world file and say which claims
 * do not hold.
 *
 * Returns one row per failed claim rather than a bare boolean, because "the
 * certificate does not match" is not useful and "ground.heightHash is
 * 4278738398 and the certificate says 4278738399" is. `ok` is "no
 * mismatches"; `checked` names every claim that was compared, so a pass says
 * what it passed ON; `unknown` lists the claims the certificate declined to
 * state (with its reasons), so a pass that vouched for nothing derived does
 * not read as a full one; `res` is the grid tier 2 baked at, null at tier 1.
 *
 * It does not throw for anything a certificate or a world file can contain —
 * both are files a stranger can hand over. A shape nothing here anticipated
 * is reported as a `certificate` mismatch carrying the error's message, not
 * as a stack trace.
 *
 * @param {object} cert
 * @param {object} worldDoc
 * @param {{ tier?: 1|2 }} [opts]
 * @returns {Promise<{ ok: boolean, tier: 1|2, checked: string[], mismatches: {claim: string, stated: *, derived: *}[], key: string|null, unknown: {claim: string, why: string}[], res: number|null }>}
 */
export async function verifyCertificate(cert, worldDoc, { tier = 1 } = {}) {
  if (tier !== 1 && tier !== 2) throw new RangeError(`verifyCertificate: tier must be 1 or 2, got ${tier}`);
  const st = { checked: [], mismatches: [], key: null, res: null };
  try {
    await verifyInto(st, cert, worldDoc, tier);
  } catch (e) {
    st.checked.push("certificate");
    st.mismatches.push({ claim: "certificate", stated: "a certificate the verifier can read", derived: `could not be checked: ${e?.message ?? e}` });
  }
  const unknown = Array.isArray(cert?.claims?.unknown)
    ? cert.claims.unknown.filter((u) => u && typeof u.claim === "string").map((u) => ({ claim: u.claim, why: String(u.why ?? "") }))
    : [];
  return { ok: st.mismatches.length === 0, tier, checked: st.checked, mismatches: st.mismatches, key: st.key, unknown, res: st.res };
}

async function verifyInto(st, cert, worldDoc, tier) {
  const { checked, mismatches } = st;
  const check = (claim, stated, derived, pass = same(stated, derived)) => {
    checked.push(claim);
    if (!pass) mismatches.push({ claim, stated, derived });
    return pass;
  };

  if (!cert || typeof cert !== "object" || cert.format !== CERT_FORMAT) {
    check("format", cert?.format ?? null, CERT_FORMAT);
    return;
  }
  check("format", cert.format, CERT_FORMAT);

  /* The world file is a file a person picked: hold it to what any opened file
     is held to before re-deriving anything from it. validateWorldFile does not
     throw (it says so, and catches its own); the guard here is so that this
     function's promise does not rest on another module's. */
  let fileErrors;
  try { fileErrors = validateWorldFile(worldDoc); } catch (e) { fileErrors = [`not a readable world file: ${e?.message ?? e}`]; }
  if (!check("world file", "a valid world file", fileErrors.length ? fileErrors.join("; ") : "a valid world file")) return;

  /* ── the signature covers this exact document ── */
  const s = subtle();
  if (!s) {
    check("signature", cert.signer?.alg ?? null, "no WebCrypto on this platform to check it with", false);
  } else {
    const signer = cert.signer || {};
    let good = false, why = "did not verify";
    try {
      if (signer.alg !== SIG_ALG) throw new Error(`unknown algorithm ${JSON.stringify(signer.alg ?? null)}`);
      const pub = await s.importKey("jwk", { ...signer.publicKey, ext: true }, ECDSA, true, ["verify"]);
      const { signature, ...body } = cert;
      good = await s.verify(SIGN, pub, unb64(String(signature)), new TextEncoder().encode(canonicalJSON(body)));
      st.key = await keyFingerprint(signer.publicKey);
    } catch (e) { why = `did not verify: ${e.message}`; }
    check("signature", SIG_ALG, good ? SIG_ALG : why, good);
    if (st.key) check("signer.fingerprint", signer.fingerprint, st.key);
  }

  /* ── the subject: these bytes, this kind ── */
  check("subject.sha256", cert.subject?.sha256 ?? null, await worldDigest(worldDoc));
  check("subject.kind", cert.subject?.kind ?? null, worldDoc.kind);
  check("subject.fileVersion", cert.subject?.fileVersion ?? null, worldDoc.fileVersion);

  const claims = cert.claims;
  if (!claims || typeof claims !== "object") {
    check("claims", null, "a claims tree");
    return;
  }

  /* ── every leaf accounted for ── */
  const acct = claimsAccounting(claims);
  const reasons = {
    uncovered: "a leaf the registry does not name",
    absent: "a registry leaf the certificate does not carry",
    unexplained: "\"unknown\" with no reason given",
    overclaimed: "listed as unknown, and stated anyway",
    forbidden: "unknown, and the registry says it is always known",
    malformed: "an unknown[] entry that is not { claim, why }",
  };
  checked.push("registry");
  for (const [k, paths] of Object.entries(acct)) {
    for (const p of paths) mismatches.push({ claim: p, stated: claimAt(claims, p) ?? null, derived: reasons[k] });
  }

  /* ── declared: this build's constants ── */
  check("kind", claims.kind, CLAIMS_KIND);
  check("version", claims.version, CLAIMS_VERSION);
  check("ground.generatorVersion", claimAt(claims, "ground.generatorVersion"), GENERATOR_VERSION);
  check("reach.controllerVersion", claimAt(claims, "reach.controllerVersion"), CONTROLLER_VERSION);
  const res = claimAt(claims, "ground.res");
  check("ground.res", res, res === UNKNOWN ? UNKNOWN : `a grid of 2–${MAX_VERIFY_RES}`,
    res === UNKNOWN || (Number.isInteger(res) && res >= 2 && res <= MAX_VERIFY_RES));

  /* ── rederived: recomputed from the file's params, no bake ── */
  const re = rederivedClaims(worldDoc.world.params, { spawn: worldDoc.world.spawn ?? null });
  for (const [path, v] of Object.entries(re)) check(path, claimAt(claims, path), v);
  /* A world with no intent: its conditioning is zero, and that is rederived
     too (NO_INTENT above). Checked here, so tier 2 does not check it again. */
  const settled = new Set();
  if (re["conditioning.records"] === 0) {
    for (const [path, v] of Object.entries(NO_INTENT)) {
      const stated = claimAt(claims, path);
      check(path, stated, stated === UNKNOWN ? "known: the world carries no intent, so this is " + JSON.stringify(v) : v);
      settled.add(path);
    }
  }

  /* ── the file's own ground block, when it carries one ──
     The file STATES a ground. A certificate that calls that ground "unknown"
     is not vouching for it, and a verifier that then skipped the block would
     report VERIFIED for a file whose own hashes are false — which is what the
     first version did, and the review caught (a block with heightHash ^ 1,
     claims derived with bake:false, re-signed: both tiers passed). So an
     unknown here is a mismatch: buildCertificate always bakes, and never
     signs a file whose block it has not checked, so an honest certificate
     for a file with a block states every line of it. */
  const block = worldDoc.ground ?? null;
  if (block) {
    for (const k of GROUND_BLOCK_FIELDS) {
      const stated = claimAt(claims, BLOCK_CLAIM[k]);
      check(`ground block ${k}`, stated === UNKNOWN ? `${UNKNOWN} (the certificate does not vouch for the file's ground)` : stated, block[k],
        stated !== UNKNOWN && same(stated, block[k]));
    }
  }

  /* ── tier 2: derived, by running the pipeline again ──
     At the certificate's own grid, which buildCertificate takes from the
     file's ground block when there is one, else CANONICAL_RES. That is a
     deviation from "re-bake the canonical ground", made on purpose: a ground
     hash is a hash OF a grid, and the only grid it can be re-derived at is
     the one it was taken at. The grid is bounded (MAX_VERIFY_RES), it is in
     the signed body, it comes back as `res`, and the CLI prints it. And the
     file's block, when it has one, is compared against a bake at the block's
     OWN grid, whatever the certificate states — so a false block is caught
     at tier 2 even by a certificate that says nothing about the ground. */
  if (tier === 2) {
    const bake = Number.isInteger(res) && res >= 2 && res <= MAX_VERIFY_RES;
    let fresh, manifest;
    try {
      ({ claims: fresh, manifest } = deriveWorldClaims(worldDoc, { res: bake ? res : CANONICAL_RES, bake }));
    } catch (e) {
      // A world the pipeline refuses (groundBundle names why) re-derives
      // nothing, and every derived claim about it is therefore unsupported.
      check("re-derivation", "the pipeline runs on this world", e.message, false);
      return;
    }
    st.res = bake ? res : null;
    for (const [path, stated] of claimLeaves(claims)) {
      if (REGISTRY[path]?.account !== "derived" || stated === UNKNOWN || settled.has(path)) continue;
      check(path, stated, claimAt(fresh, path));
    }
    if (block) {
      if (!manifest || manifest.res !== block.res) {
        if (!(block.res <= MAX_VERIFY_RES)) {
          check("ground block res", block.res, `a grid of 2–${MAX_VERIFY_RES} a verifier will bake`, false);
          return;
        }
        manifest = groundBundle(worldDoc.world.params, { res: block.res }).manifest;
        st.res = st.res ?? block.res;
      }
      for (const k of GROUND_BLOCK_FIELDS) check(`ground block ${k} (re-baked)`, block[k], manifest[k]);
    }
  }
}
