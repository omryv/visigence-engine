# Studio artwork migration to R2

All six studio objects now pass SHA-256, file-size and CORS verification. R2 returns `Access-Control-Allow-Origin: *`, permitting development and Vercel origins. The studio loads these files from R2; static builds contain no art. Git tracking was removed while local originals were preserved. See [verification](reports/mission-polish/studio-r2-after-upload.json).

Run `node tools/build/prepare-studio-upload.mjs` to stage `.r2-upload/visigames-studio/assets/studio/` and regenerate `tools/assets/studio-manifest.json`. A ready upload archive is available locally at `.r2-upload/visigames-studio-upload.zip`.

Upload the package's **assets** folder to the existing bucket root. Preserve these exact keys:

- `assets/studio/import-demo.glb` — original sample prop
- `assets/studio/mission-beacon.glb` — original extraction beacon
- `assets/studio/visigames-mark.svg` — brand mark
- `assets/studio/asset-cube.svg` — asset library icon
- `assets/studio/shuffle.svg` — seed control icon
- `assets/studio/play.svg` — play control icon

Total uncompressed size: 103,621 bytes. Do not replace existing objects elsewhere in the bucket. Use `image/png`, `image/svg+xml` and `model/gltf-binary` content types; public GET must allow CORS from `https://visigames.vercel.app`.

After upload, verify with:

```sh
node tools/build/verify-r2.mjs --manifest tools/assets/studio-manifest.json --report docs/reports/mission-polish/studio-r2-after-upload.json --origin https://visigames.vercel.app
```

The launcher, sample importer, icons, beacon and game exporter use the common asset resolver. Standalone ZIPs retain local paths and bundled bytes. The runtime manifest includes all seven files, so `npm run assets:fetch` can restore a fresh test cache. No Git history rewrite was performed.

The original Blender scripts, manifests and source code remain in Git. Local imported creator assets remain private to the user's browser until included in their downloaded game; this package does not upload them.
