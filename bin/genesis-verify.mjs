#!/usr/bin/env node
/* genesis-verify — check a world file against its certificate, from a terminal.
 *
 * This exists to make one constraint concrete rather than merely claimed:
 * verification must not require the editor. There is no DOM here, no WebGL,
 * no three.js and no studio — it imports js/certificate.js and nothing else,
 * and tests/certificate.test.js walks that import closure and fails if it
 * ever grows to include engine/Engine.js, three or js/studio.js.
 *
 *   node bin/genesis-verify.mjs world.world.json world.certificate.json [--tier 1|2]
 *
 * Tier 1 (the default) checks the signature, the file's SHA-256, the declared
 * constants, every claim recomputable from the params without a bake, and the
 * registry's accounting of the tree — milliseconds. Tier 2 also re-bakes the
 * ground, re-solves the intent and re-floods the reach, and compares every
 * derived claim equal — about as long as one bake (0.73–0.75 s for the default
 * world at 513²).
 *
 * Exit status is the answer: 0 verified, 1 not verified, 2 could not be read.
 * Every mismatch is printed by name, because a failure that does not say
 * WHICH claim failed is not a verification, it is a mood.
 */

import { readFile } from "node:fs/promises";
import { verifyCertificate } from "../src/genesis/world/certificate.js";

const USAGE = "usage: genesis-verify <world.json> <certificate.json> [--tier 1|2]";

async function main(argv) {
  const files = [];
  let tier = 1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tier") { tier = Number(argv[++i]); continue; }
    if (a.startsWith("--tier=")) { tier = Number(a.slice(7)); continue; }
    if (a.startsWith("--")) { console.error(`unknown option ${a}\n${USAGE}`); return 2; }
    files.push(a);
  }
  if (files.length !== 2 || (tier !== 1 && tier !== 2)) { console.error(USAGE); return 2; }
  const [worldPath, certPath] = files;

  const read = async (path) => {
    try { return { value: JSON.parse(await readFile(path, "utf8")) }; }
    catch (e) { return { error: `could not read ${path}: ${e.message}` }; }
  };
  const world = await read(worldPath);
  if (world.error) { console.error(world.error); return 2; }
  const cert = await read(certPath);
  if (cert.error) { console.error(cert.error); return 2; }

  if (!globalThis.crypto?.subtle) {
    console.error("this runtime has no WebCrypto, so the hash and the signature cannot be checked. Node 20 or newer has it.");
    return 2;
  }

  /* verifyCertificate reports what it cannot read as a named mismatch rather
     than throwing; this guard is for the day something slips past that, so a
     stranger's file still gets an exit status and a sentence, not a stack. */
  let r;
  try { r = await verifyCertificate(cert.value, world.value, { tier }); }
  catch (e) { console.error(`could not check ${certPath} against ${worldPath}: ${e?.message ?? e}`); return 2; }
  console.log(`tier ${r.tier}: ${r.checked.length} checks against ${worldPath}` +
    (r.res ? ` (ground re-baked at ${r.res}²)` : ""));
  if (r.ok) {
    // Say what a pass does and does not mean, here, where someone is reading it.
    console.log(`VERIFIED — every claim checked at tier ${r.tier} was recomputed from the world file and matched, ` +
      "and the signature covers this exact document.");
    if (r.tier === 1) console.log("Tier 1 does not re-bake: the derived claims (ground hashes, nats, reach) are the signer's word. --tier 2 checks them.");
    /* A certificate may decline to state a claim, with a reason; a pass then
       vouches for less, and the reader should see how much less. */
    if (r.unknown.length) {
      console.log(`The certificate states ${r.unknown.length} claim${r.unknown.length === 1 ? "" : "s"} as unknown, so nothing was checked for ${r.unknown.length === 1 ? "it" : "them"}:`);
      for (const u of r.unknown) console.log(`  · ${u.claim}: ${u.why}`);
    }
    console.log(`This establishes INTEGRITY, not identity: nobody has vouched for the signing key ${r.key}` +
      `${cert.value.signer?.ephemeral ? " (an ephemeral key, made for this certificate alone)" : ""}.`);
    return 0;
  }
  console.log("NOT VERIFIED");
  for (const m of r.mismatches) {
    console.log(`  · ${m.claim}: certificate says ${JSON.stringify(m.stated)}, re-derived ${JSON.stringify(m.derived)}`);
  }
  return 1;
}

process.exit(await main(process.argv.slice(2)));
