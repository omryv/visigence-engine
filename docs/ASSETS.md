# Asset storage

The repository tracks no files under `assets/`. The engine loads every runtime asset (models, textures, audio and catalogue previews) from the public R2 origin configured in `src/config/assetDelivery.js`. Their logical `assets/...` paths and relative glTF dependencies remain unchanged. Exported games include their own local copies.

| Tracked location | Purpose |
|---|---|
| `tools/assets/runtime-manifest.json` | Runtime paths, byte counts and SHA-256 checksums |
| `tools/assets/arcade-r2-upload-manifest.json` | The Arcade upload inventory (see [R2-ARCADE-UPLOAD.md](../R2-ARCADE-UPLOAD.md)) |
| `tools/assets/audio/` | Audio provenance records |
| `docs/reports/` | Verification reports and performance measurements |

`assets/` is now entirely ignored. Existing workspace source artwork, Blender files and review images are preserved locally; they are not runtime dependencies and are not part of the R2 runtime upload. Source/review images removed from tracking remain recoverable from commit `873fff9e546a8f62843d29d2b24ec6cd749e984a`. This cleanup does not rewrite Git history or remove its historical blobs.

## Tests without the art

`node tools/test/run.mjs` runs every suite that is about logic rather than files on a
checkout with no `assets/`: the world layer, the simulation, the studio harness, the
project contract, the loader's guards. The twelve suites that open GLBs, audio or studio
images are listed as `ASSET_BACKED` in the runner and are skipped with a named reason
until `npm run assets:fetch` has restored the verified cache. A job that has the cache
runs `node tools/test/run.mjs --require-assets` (or sets `VISIGAMES_REQUIRE_ASSETS=1`), so
a missing file there is a failure and cannot hide as a skip.

## Builds and local authoring

`node tools/build/build-preview.mjs` builds the studio with no local assets. For offline content tests or editing runtime art, restore the optional checksum-verified cache with `npm run assets:fetch`. This downloads only runtime files; original authoring files must come from the preserved workspace or Git history. Do not commit downloaded assets.

After deliberately changing local runtime art, run `node tools/build/asset-manifest.mjs --refresh`. Stage uploads with `node tools/build/prepare-r2.mjs`; upload `.r2-upload/assets/` with the `assets/` prefix intact. Neither command uploads files or changes bucket settings.

Public reads need no credentials. Repeat the byte and CORS audit with `node tools/build/verify-r2.mjs`. See [R2 delivery](R2_DELIVERY.md).

Studio artwork migration: [delivery and verification](STUDIO_ASSET_UPLOAD.md). Local authoring copies remain available; the older runtime art is delivered from R2.
