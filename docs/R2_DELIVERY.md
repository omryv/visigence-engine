# R2 delivery status

Public origin: `https://pub-f1c1beced9f54323ac7db4d8f77fc346.r2.dev`

The engine resolves model, texture, audio, library-preview and graph-preview URLs through `src/config/assetDelivery.js`. Game export downloads art from that origin and embeds it in the ZIP; exported standalone games load their embedded files locally. Logical catalogue/pack paths and GLB-relative texture paths remain unchanged.

Static site builds contain application code and packs, with no copied art. `tools/assets/runtime-manifest.json` is the committed runtime inventory, so hosting builds do not need local asset binaries. Refresh it deliberately with `node tools/build/asset-manifest.mjs --refresh` after modifying local art.

## Current repository layout

No files under `assets/` remain tracked. The runtime manifest lives in `tools/assets/`; audio provenance is retained there too. Text verification reports live in `docs/reports/`. Source artwork and review media are retained in the existing workspace and Git history, not in the current checkout. See [asset storage](ASSETS.md).

The verified runtime inventory is `tools/assets/runtime-manifest.json` (path, byte size and SHA-256 per file). Optimized standalone exports include their dependencies and KTX2 decoder. Physical iPhone testing was unavailable.

The full asset-folder cleanup is checked with a static build from a checkout with no `assets/` directory, import validation, public byte/CORS verification and browser engine checks.


## Bucket setting and repeat verification

For these public, unauthenticated assets, the following R2 CORS policy permits read access while the final engine domain is undecided. Replace `*` with explicit engine origins when desired; include `http://127.0.0.1:8123` for local browser verification.

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length"],
    "MaxAgeSeconds": 3600
  }
]
```

The policy is documentation only; no bucket configuration was changed. No credentials are needed in the engine. To repeat verification, run `node tools/build/verify-r2.mjs --origin http://127.0.0.1:8123` (Node and curl required), then exercise all three themes in `tools/test/studio-capture.html`, including architecture door/glass cases and a real game export. The verifier returns a failure status unless both bytes and CORS pass. It never deletes files.

Studio artwork migration: [delivery and verification](STUDIO_ASSET_UPLOAD.md). Local authoring copies remain available; the current Git tree and static hosting build contain no runtime asset binaries.

Removal applies to the current branch; earlier Git commits still contain binaries.
