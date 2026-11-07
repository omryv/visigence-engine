// The world certificate, and whether any of it can be trusted.
//
// Modelled on packages/atlas-core/tests/certificate.mjs: a signed statement is
// only worth what survives somebody trying to bend it, so the heart of this
// file is a TAMPER TABLE — one edit per row, each of which the verifier must
// catch and must catch BY NAME. A verifier that says "no" without saying
// which claim failed has not verified anything; it has had a mood.
//
// The other half is the boundary the CLI promises: bin/genesis-verify.mjs's
// static import closure is walked from source and must not contain the
// renderer (engine/Engine.js), three.js, or the studio (js/studio.js).
//
// Needs WebCrypto. Node has it; jsc does not, and
// this file says so and skips rather than passing on nothing. The async work
// happens at module level (top-level await), so every test() below is the
// synchronous assertion the harness expects.
import { test, eq, ok, report } from "../kernel/harness.js";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { makeParams, mergeParams } from "../../../src/kernel/presets.js";
import { bakeHeightField } from "../../../src/kernel/terrain/heightfield.js";
import { groundBundle } from "../../../src/kernel/terrain/ground.js";
import { buildWorldFile, groundBlock, validateWorldFile } from "../../../src/genesis/world/worldfile.js";
import { SEED_WORLD } from "./seed-world.js";
import {
  buildCertificate, verifyCertificate, generateSigningKey, keyFingerprint, canonicalJSON,
  deriveWorldClaims, worldDigest, CERT_FORMAT, ESTABLISHES,
} from "../../../src/genesis/world/certificate.js";

const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
const clone = (o) => JSON.parse(JSON.stringify(o));
const clock = () => (globalThis.performance ? performance.now() : 0);

if (!globalThis.crypto?.subtle) {
  print("certificate: skipped — this runtime has no WebCrypto (run under Node: RUNTIME=node sh tests/run.sh)");
} else {
  await main();
}

async function main() {
  /* ── two small worlds, A and B, and the default world ──
     A carries intent (so nats are solved, not zero) and a spawn (so the reach
     is flooded, not unknown). Certificates for A and B are baked at 129² to
     keep the table fast; the default world is certified at the canonical
     513², end to end, once. */
  const RES = 129;
  const mint = (seed) => {
    const params = mergeParams(makeParams({ seed }), {
      terrain: { intent: [{ type: "point", x: 0, z: 0, h: 140 }] },
      water: { level: 2 },
    });
    return buildWorldFile({ params, propRecords: [], field: bakeHeightField(params, RES), world: null });
  };
  const A = mint("CE7T-W4LD-2AAB");
  const B = mint("CE7T-W4LD-2AAA");

  let t = clock();
  const certA = await buildCertificate(A, { res: RES });
  const buildMs = clock() - t;
  const certB = await buildCertificate(B, { res: RES });

  t = clock();
  const t1 = await verifyCertificate(certA, A);
  const t1Ms = clock() - t;
  t = clock();
  const t2 = await verifyCertificate(certA, A, { tier: 2 });
  const t2Ms = clock() - t;

  const resign = async (cert) => {
    const { signature, signer, ...body } = clone(cert);
    void signature; void signer;
    // A forger's re-sign: the edited body, under a key the forger just made.
    const key = await generateSigningKey();
    const s = globalThis.crypto.subtle;
    const jwk = await s.exportKey("jwk", key.publicKey);
    const publicKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    const full = { ...body, signer: { alg: "ECDSA-P256-SHA256", publicKey, fingerprint: await keyFingerprint(publicKey), ephemeral: true } };
    const sig = await s.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(canonicalJSON(full)));
    let bin = ""; for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
    return { ...full, signature: btoa(bin) };
  };

  /* ── the tamper table ──
     [name, certificate, world, tier, claims that must be named, claims that must NOT be] */
  const rows = [];
  {
    const c = clone(certA);
    c.claims.ground.heightHash = (c.claims.ground.heightHash ^ 1) >>> 0;
    rows.push(["one bit of the stated heightHash flipped", c, A, 1, ["signature"], []]);
    rows.push(["…and at tier 2 the hash itself is named", c, A, 2, ["signature", "ground.heightHash"], []]);
  }
  {
    const c = clone(certA);
    c.claims.conditioning.nats = c.claims.conditioning.nats * 1.01;
    rows.push(["a nats value edited", c, A, 2, ["signature", "conditioning.nats"], []]);
    const forged = await resign(c);
    rows.push(["a nats value edited, re-signed with a fresh key", forged, A, 2, ["conditioning.nats"], ["signature"]]);
  }
  {
    const w = clone(A);
    w.world.params.seed = "CE7T-W4LD-2AAC";
    w.world.seed = "CE7T-W4LD-2AAC";
    rows.push(["the world's seed edited", certA, w, 1, ["world.seed", "world.seedHash", "world.parameterHash", "subject.sha256"], ["signature"]]);
  }
  {
    const c = clone(certA);
    c.claims.world.parameterHash = (c.claims.world.parameterHash ^ 0x10) >>> 0;
    rows.push(["a claim edited, re-signed with a fresh key", await resign(c), A, 1, ["world.parameterHash"], ["signature"]]);
  }
  {
    const c = clone(certA);
    const raw = atob(c.signature).split("");
    raw[7] = String.fromCharCode(raw[7].charCodeAt(0) ^ 0x01);
    c.signature = btoa(raw.join(""));
    rows.push(["one byte of the signature flipped", c, A, 1, ["signature"], ["world.parameterHash", "subject.sha256"]]);
  }
  rows.push(["a certificate swapped onto another world", certA, B, 1, ["subject.sha256", "world.seed", "world.parameterHash"], ["signature"]]);
  {
    const c = clone(certA);
    c.signer.ephemeral = false;
    rows.push(["an ephemeral key relabelled as a kept one", c, A, 1, ["signature"], []]);
  }
  {
    const w = clone(A);
    w.world.params.sky.timeOfDay = (w.world.params.sky.timeOfDay + 1) % 24;
    rows.push(["the hour edited — not a claim, but part of the signed bytes", certA, w, 1, ["subject.sha256"], ["world.parameterHash"]]);
  }
  {
    const c = clone(certA);
    c.claims.reach.reachedCount += 1;
    rows.push(["the reach inflated by one cell, re-signed", await resign(c), A, 2, ["reach.reachedCount"], ["signature"]]);
  }
  {
    const c = clone(certA);
    c.claims.ground.flowMaskHash = "unknown";
    c.claims.unknown.push({ claim: "ground.landMaskHash", why: "not measured" });
    rows.push(["an unknown unexplained, and an explained one stated anyway, re-signed", await resign(c), A, 1,
      ["ground.flowMaskHash", "ground.landMaskHash"], ["signature"]]);
  }

  /* ── the holes the M4 review found, each now a row ── */
  // (1) A file whose own ground block is false, under a certificate that
  //     calls the ground "unknown" (claims derived with no bake — every
  //     unknown explained, which the registry allows) and is signed over the
  //     lying file's own digest. Both tiers used to say VERIFIED.
  const lyingFile = clone(A);
  lyingFile.ground = groundBlock(groundBundle(A.world.params, { res: 65 }).manifest);
  lyingFile.ground.heightHash = (lyingFile.ground.heightHash ^ 1) >>> 0;
  {
    const c = clone(certA);
    c.claims = deriveWorldClaims(lyingFile, { bake: false }).claims;
    c.subject.sha256 = await worldDigest(lyingFile);
    const forged = await resign(c);
    rows.push(["a false ground block, under a certificate that calls the ground unknown", forged, lyingFile, 1,
      ["ground block heightHash"], ["signature", "subject.sha256"]]);
    rows.push(["…and at tier 2 the block is re-baked at its own grid", forged, lyingFile, 2,
      ["ground block heightHash (re-baked)"], ["signature", "subject.sha256", "ground block landMaskHash (re-baked)"]]);
  }
  // (2) A "__proto__" member — an own property after JSON.parse, which the
  //     first canonicalJSON silently dropped — in the world, deep in the
  //     world, and in the certificate.
  const withProto = (o, value) => Object.defineProperty(o, "__proto__", { value, enumerable: true, writable: true, configurable: true });
  {
    const w = withProto(clone(A), { evil: 1 });
    rows.push(["a \"__proto__\" member added to the world file", certA, w, 1, ["subject.sha256"], ["signature", "world file"]]);
    const deep = clone(A);
    withProto(deep.world.params.terrain, { size: 1 });
    rows.push(["a \"__proto__\" member added deep in the params", certA, deep, 1, ["subject.sha256"], ["signature", "world.parameterHash"]]);
    rows.push(["a \"__proto__\" member added to the certificate", withProto(clone(certA), { ephemeral: false }), A, 1, ["signature"], ["subject.sha256"]]);
  }
  // (3) A world with no intent, whose conditioning is "known, and zero":
  //     re-signed with all three stated unknown (with reasons).
  const plain = (() => {
    const params = mergeParams(makeParams({ seed: "CE7T-W4LD-2AAD" }), { water: { level: 2 } });
    return buildWorldFile({ params, propRecords: [], field: bakeHeightField(params, 65), world: null });
  })();
  const certPlain = await buildCertificate(plain, { res: 65 });
  {
    const c = clone(certPlain);
    for (const k of ["conditioned", "nats", "miss"]) {
      c.claims.conditioning[k] = "unknown";
      c.claims.unknown.push({ claim: `conditioning.${k}`, why: "the solve was not run" });
    }
    rows.push(["a no-intent world's zero conditioning re-signed as unknown", await resign(c), plain, 1,
      ["conditioning.conditioned", "conditioning.nats", "conditioning.miss"], ["signature"]]);
    const n = clone(certPlain);
    n.claims.conditioning.nats = 0.5;
    rows.push(["a no-intent world's nats edited, re-signed — tier 1 sees it", await resign(n), plain, 1, ["conditioning.nats"], ["signature"]]);
  }
  // (4) A world file validateWorldFile once crashed on: named, not thrown.
  const badProps = clone(A); badProps.world.props = 5;
  const nullProp = clone(A); nullProp.world.props = [null];
  rows.push(["a world file whose props is not a list", certA, badProps, 2, ["world file"], ["certificate"]]);
  rows.push(["a world file with a null placement", certA, nullProp, 1, ["world file"], ["certificate"]]);
  rows.push(["a certificate whose claims are the wrong shape", { ...clone(certA), claims: { unknown: 7, world: [1] } }, A, 2, ["signature"], []]);

  const results = [];
  for (const [name, cert, world, tier, must, mustNot] of rows) {
    const t0 = clock();
    const v = await verifyCertificate(cert, world, { tier });
    results.push({ name, v, tier, must, mustNot, ms: clock() - t0 });
  }
  /* The boundary between the tiers, as a fact rather than a footnote: a
     DERIVED claim edited and re-signed passes tier 1, because tier 1 does not
     bake. Asserted, so that if tier 1 ever starts claiming to catch this the
     comment in certificate.js has to change with it. */
  const forgedNats = rows.find((r) => r[0] === "a nats value edited, re-signed with a fresh key")[1];
  const tier1Blind = await verifyCertificate(forgedNats, A, { tier: 1 });

  /* ── the default world, canonical grid, end to end ── */
  t = clock();
  const kept = { ...(await generateSigningKey()), ephemeral: false };
  const certD = await buildCertificate(SEED_WORLD, { key: kept });
  const buildDMs = clock() - t;
  t = clock();
  const vD = await verifyCertificate(certD, SEED_WORLD, { tier: 2 });
  const verifyDMs = clock() - t;
  const keptPrint = await keyFingerprint(await globalThis.crypto.subtle.exportKey("jwk", kept.publicKey));

  /* ── a file that carries its own ground block ── */
  const withGround = clone(A);
  withGround.ground = groundBlock(groundBundle(A.world.params, { res: 65 }).manifest);
  const certG = await buildCertificate(withGround);
  const vG = await verifyCertificate(certG, withGround, { tier: 2 });
  const vGRebaked = vG.checked.filter((c) => /\(re-baked\)$/.test(c)).length;
  /* An honest certificate that vouches for little: claims derived with no
     bake, every unknown explained. It passes — and the pass has to say how
     much it did not check. */
  const vouchesLittle = await resign({ ...clone(certA), claims: deriveWorldClaims(A, { bake: false }).claims });
  const vLittle = await verifyCertificate(vouchesLittle, A, { tier: 2 });
  const lying = clone(withGround);
  lying.ground.heightHash = (lying.ground.heightHash ^ 1) >>> 0;
  let lyingThrew = null;
  try { await buildCertificate(lying); } catch (e) { lyingThrew = e.message; }
  const vLying = await verifyCertificate(certG, lying, { tier: 1 });

  /* ── the CLI ── */
  const dir = mkdtempSync(join(tmpdir(), "genesis-verify-"));
  const put = (name, v) => { const p = join(dir, name); writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v)); return p; };
  const cli = (...args) => spawnSync(process.execPath, [join(ROOT, "bin/genesis-verify.mjs"), ...args], { encoding: "utf8" });
  const wA = put("a.world.json", A), cA = put("a.cert.json", certA), wB = put("b.world.json", B);
  const cliRuns = {
    good1: cli(wA, cA),
    good2: cli(wA, cA, "--tier", "2"),
    swapped: cli(wB, cA),
    forged2: cli(wA, put("forged.cert.json", forgedNats), "--tier=2"),
    little: cli(wA, put("little.cert.json", vouchesLittle), "--tier", "2"),
    badProps: cli(put("badprops.world.json", badProps), cA),
    missing: cli(join(dir, "nope.json"), cA),
    garbage: cli(put("junk.json", "{ not json"), cA),
    badTier: cli(wA, cA, "--tier", "3"),
    noArgs: cli(),
  };
  rmSync(dir, { recursive: true, force: true });

  /* ════════════ assertions ════════════ */

  test("a certificate is built and verifies at both tiers", () => {
    eq(certA.format, CERT_FORMAT);
    ok(t1.ok, `tier 1: ${JSON.stringify(t1.mismatches)}`);
    ok(t2.ok, `tier 2: ${JSON.stringify(t2.mismatches)}`);
    eq(t1.tier, 1); eq(t2.tier, 2);
    ok(t2.checked.length > t1.checked.length, "tier 2 checks more than tier 1");
    for (const c of ["signature", "subject.sha256", "registry", "world.parameterHash"]) ok(t1.checked.includes(c), `tier 1 checks ${c}`);
    for (const c of ["ground.heightHash", "conditioning.nats", "reach.reachedCount"]) {
      ok(!t1.checked.includes(c), `tier 1 does not pretend to check ${c}`);
      ok(t2.checked.includes(c), `tier 2 checks ${c}`);
    }
    ok(certA.claims.conditioning.nats > 0 && certA.claims.reach.reachedCount > 0, "A has solved intent and a flooded reach");
    print(`    ${RES}²: build ${buildMs.toFixed(0)} ms; tier 1 ${t1Ms.toFixed(1)} ms (${t1.checked.length} checks); ` +
      `tier 2 ${t2Ms.toFixed(0)} ms (${t2.checked.length} checks)`);
  });

  test("the certificate says it establishes integrity, not identity — and says when its key is ephemeral", () => {
    ok(/INTEGRITY, NOT IDENTITY/.test(certA.establishes) && certA.establishes === ESTABLISHES, "the limit is in the document");
    eq(certA.signer.ephemeral, true, "no key was injected, so the pair was minted for this certificate");
    eq(certD.signer.ephemeral, false, "an injected kept key is not called ephemeral");
    eq(vD.key, keptPrint, "the verifier reports the fingerprint of the key that signed");
    eq(certD.signer.fingerprint, keptPrint);
  });

  test("the default world at 513², signed with an injected key, verifies at tier 2", () => {
    ok(vD.ok, JSON.stringify(vD.mismatches));
    eq(certD.claims.ground.res, 513);
    eq(certD.claims.unknown.length, 0, "the default world names a spawn, so nothing is unknown");
    print(`    default world 513²: build ${buildDMs.toFixed(0)} ms, tier-2 verify ${verifyDMs.toFixed(0)} ms, ${vD.checked.length} checks`);
  });

  test("every tampering case is caught, naming the claim", () => {
    let caught = 0;
    for (const { name, v, tier, must, mustNot, ms } of results) {
      const named = v.mismatches.map((m) => m.claim);
      print(`    t${tier} ${name.padEnd(70)} ${v.ok ? "NOT CAUGHT" : "caught: " + [...new Set(named)].join(", ")} (${ms.toFixed(0)} ms)`);
      if (!v.ok) caught++;
      ok(!v.ok, `${name}: verification still passed`);
      for (const c of must) ok(named.includes(c), `${name}: ${c} not named (named ${named.join(", ")})`);
      for (const c of mustNot) ok(!named.includes(c), `${name}: ${c} named, and it should have held`);
      for (const m of v.mismatches) ok("stated" in m && "derived" in m, `${name}: a mismatch without stated/derived`);
    }
    eq(caught, results.length, "caught");
  });

  test("tier 1 does not see a derived claim edited and re-signed — the tier boundary, as a fact", () => {
    ok(tier1Blind.ok, "tier 1 now catches a re-signed nats edit; update certificate.js's account of the tiers");
  });

  test("a world file's own ground block is checked against the certificate, and a false one is never signed", () => {
    ok(vG.ok, JSON.stringify(vG.mismatches));
    eq(certG.claims.ground.res, 65, "the grid came from the file's block");
    ok(lyingThrew && /ground block/.test(lyingThrew), `buildCertificate signed a false ground block (${lyingThrew})`);
    eq(validateWorldFile(lying).length, 0, "the lie is well-formed — only a bake can catch it");
    const named = vLying.mismatches.map((m) => m.claim);
    ok(named.includes("ground block heightHash") && named.includes("subject.sha256"), `named ${named.join(", ")}`);
  });

  test("tier 2 re-bakes a file's own ground block; a pass reports the grid and what was left unknown", () => {
    eq(vGRebaked, 8, "every block line compared against a fresh bake");
    eq(vG.res, 65);
    eq(t1.res, null, "tier 1 bakes nothing");
    eq(t1.unknown.length, 0);
    ok(vLittle.ok, JSON.stringify(vLittle.mismatches));
    ok(vLittle.unknown.some((u) => u.claim === "ground.heightHash"), "the declined claims come back with the verdict");
    print(`    a certificate with no bake behind it: passes tier 2 with ${vLittle.unknown.length} claims unknown, all listed`);
  });

  test("canonicalJSON serialises every own key, \"__proto__\" included", () => {
    const o = JSON.parse('{"b":1,"__proto__":{"x":2},"a":[1,null]}');
    eq(canonicalJSON(o), '{"__proto__":{"x":2},"a":[1,null],"b":1}');
    eq(canonicalJSON({ b: undefined, a: [undefined, NaN], c: () => 1 }), '{"a":[null,null]}', "undefined and functions dropped as JSON.stringify drops them");
    eq(canonicalJSON({ 10: 1, 9: 2 }), '{"10":1,"9":2}', "keys by code unit, integer-like ones too");
  });

  test("a certificate re-derives with the very function that built it", () => {
    const again = deriveWorldClaims(A, { res: RES }).claims;
    eq(canonicalJSON(again), canonicalJSON(certA.claims));
  });

  test("genesis-verify exits 0 verified, 1 not verified, 2 unreadable", () => {
    const s = (r) => `${r.status}: ${r.stdout}${r.stderr}`;
    eq(cliRuns.good1.status, 0, s(cliRuns.good1));
    ok(/VERIFIED/.test(cliRuns.good1.stdout) && /INTEGRITY, not identity/.test(cliRuns.good1.stdout), "a pass says what it means");
    eq(cliRuns.good2.status, 0, s(cliRuns.good2));
    eq(cliRuns.swapped.status, 1, s(cliRuns.swapped));
    ok(/world\.parameterHash/.test(cliRuns.swapped.stdout) && /subject\.sha256/.test(cliRuns.swapped.stdout), "each mismatch printed by name");
    eq(cliRuns.forged2.status, 1, s(cliRuns.forged2));
    ok(/conditioning\.nats/.test(cliRuns.forged2.stdout), "the forged nats named");
    ok(/re-baked at 129²/.test(cliRuns.good2.stdout), "a tier-2 pass names the grid it baked at");
    for (const k of ["missing", "garbage", "badTier", "noArgs"]) eq(cliRuns[k].status, 2, `${k} — ${s(cliRuns[k])}`);
    eq(cliRuns.little.status, 0, s(cliRuns.little));
    ok(/as unknown/.test(cliRuns.little.stdout) && /ground\.heightHash/.test(cliRuns.little.stdout), "a pass lists what the certificate declined to state");
    eq(cliRuns.badProps.status, 1, s(cliRuns.badProps));
    ok(/world file/.test(cliRuns.badProps.stdout) && !/TypeError|\bat \S+:\d+/.test(cliRuns.badProps.stdout + cliRuns.badProps.stderr),
      "a world validateWorldFile once crashed on is a named mismatch, not a stack trace");
  });

  /* A static walk of relative imports from an entry file, comments removed.
     Returns the files reached, the bare specifiers seen, and any file that
     imports dynamically (which a static walk cannot follow, so it is named
     rather than trusted). */
  const closureOf = (entry) => {
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const files = new Set(), bare = new Set(), dynamic = [];
    const walk = (rel) => {
      if (files.has(rel)) return;
      files.add(rel);
      const src = strip(readFileSync(join(ROOT, rel), "utf8"));
      for (const m of src.matchAll(/(?:^|[\s;])(?:import|export)\s[^"'`;]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']/gm)) {
        const spec = m[1] || m[2];
        if (spec.startsWith(".")) walk(relative(ROOT, resolve(ROOT, dirname(rel), spec)));
        else bare.add(spec);
      }
      if (/\bimport\s*\(/.test(src)) dynamic.push(rel);
    };
    walk(entry);
    return { files, bare, dynamic };
  };

  test("the closure walk can see a renderer when there is one", () => {
    /* The check below is only worth something if this walker would have
       found the thing it polices. Walked from the studio, it must. */
    const studio = closureOf("editor/world/studio.js");
    ok(studio.files.has("src/genesis/Engine.js"), "the walk from js/studio.js did not reach engine/Engine.js");
    ok(studio.bare.has("three"), "the walk from js/studio.js did not see three");
  });

  test("the verifier's import closure holds no renderer, no three.js and no studio", () => {
    const { files, bare, dynamic } = closureOf("bin/genesis-verify.mjs");
    for (const banned of ["src/genesis/Engine.js", "editor/world/studio.js"]) ok(!files.has(banned), `${banned} is in the verifier's closure`);
    ok(![...files].some((f) => /(^|\/)three(\/|\.|$)/.test(f)), "a three.js file is in the closure");
    const nonNode = [...bare].filter((b) => !b.startsWith("node:"));
    eq(nonNode.join(","), "", "bare imports in the closure (three would be one):");
    eq(dynamic.join(","), "", "files in the closure that import dynamically:");
    ok(files.has("src/genesis/world/certificate.js") && files.has("src/kernel/core/claims.js"), "the walk reached the certificate and the claims");
    const bytes = [...files].reduce((n, f) => n + readFileSync(join(ROOT, f)).length, 0);
    print(`    closure: ${files.size} modules, ${Math.round(bytes / 1024)} KB; bare: ${[...bare].sort().join(", ")}`);
  });
}

report("certificate");
