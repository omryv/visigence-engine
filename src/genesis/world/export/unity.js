/* export/unity.js — the export, landing in Unity.
 *
 * A bundle a buyer cannot open is a demo, not a product. The GLB opens in
 * any viewer, but a STUDIO does not want a mesh — they want a Unity Terrain
 * they can paint, and the placements standing on it where the editor put
 * them. So the bundle now ships its own reader: one Editor script, no
 * package manager, no dependency, copied into Assets/Editor and driven from
 * a menu item.
 *
 * ── why a .r16 rides beside the 16-bit PNG ──
 * The PNG is the archival form — lossless, inspectable, importable by every
 * DCC tool. But C# inside the Unity Editor has no PNG decoder that keeps 16
 * bits (Texture2D.LoadImage flattens to 8), and shipping a decoder inside
 * the importer would make the importer the biggest thing in the bundle. Raw
 * little-endian uint16 is Unity's own native heightmap interchange (the
 * terrain tooling calls it RAW), it is `res * res * 2` bytes with nothing to
 * decode, and it is derived from the SAME field as the PNG, so the two
 * cannot disagree.
 *
 * ── handedness, stated once and obeyed twice ──
 * This engine is right-handed, +Y up, row 0 of the field at z = -size/2.
 * Unity is left-handed. The importer mirrors Z: placements go in at
 * (x, y, -z) with yaw negated, and the heightmap rows are read flipped so
 * the terrain under a mirrored placement is the same ground it stood on
 * here. That rule lives in ONE place — the C# below — and the JSON stays in
 * this engine's own coordinates, because an export that pre-mirrors for one
 * consumer is wrong for every other.
 *
 * Pure JS, deterministic: same field, same bytes.
 */

/** The field as Unity's RAW heightmap: little-endian uint16 rows, row 0 at
    z = -size/2, normalised against the field's own min/max — the manifest
    carries both, and height_m = min + (sample/65535) * (max - min). */
export function encodeR16(field) {
  const { res, data, min, max } = field;
  const range = max - min || 1;
  const out = new Uint8Array(res * res * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < res * res; i++) {
    view.setUint16(i * 2, Math.round(((data[i] - min) / range) * 65535), true);
  }
  return out;
}

/* The importer, as source. A template literal holding C# is unusual enough
   to justify the ground rules: no backtick and no "${" appears in the C#
   (C# interpolation is $"...", which is avoided below for exactly this
   reason), so the JS parser and the C# compiler never disagree about where
   anything ends. */
export const UNITY_IMPORTER_CS = `// WorldgenceImporter.cs — open a Worldgence export bundle as a Unity scene.
//
// Ships INSIDE the bundle it imports (unity/ folder), so the reader can never
// drift from the writer: a bundle is opened by the importer it was zipped
// with. Editor-only; nothing here runs in a build.
//
// Use:
//   1. Unzip the .export.zip somewhere on disk (outside Assets is fine).
//   2. Copy this file into Assets/Editor/ in your Unity project.
//   3. Tools > Worldgence > Import World Bundle…  → pick the unzipped folder.
//
// What you get:
//   - a Terrain built from unity/heightmap.r16 at the bundle's real metres,
//     positioned so the world's origin is the scene's origin;
//   - a "Placements" root with one GameObject per placement, at its authored
//     transform, carrying a WorldgencePlacement component (uid, label, verb)
//     and a placeholder box of the placement's measured extent — swap in
//     your own prefabs by uid or label, the component is the join;
//   - a water plane at the world's water level.
//
// COORDINATES. The engine is right-handed (+Y up, row 0 of the heightmap at
// z = -size/2); Unity is left-handed. This file is the one place the mirror
// happens: placements go in at (x, y, -z) with yaw negated, and heightmap
// rows are read flipped to match. The JSON in the bundle stays in the
// engine's own coordinates on purpose.

using System;
using System.IO;
using UnityEditor;
using UnityEngine;

public class WorldgencePlacement : MonoBehaviour
{
    public string uid;
    public string label;
    public string verb;   // what the object affords, when it affords anything
}

public static class WorldgenceImporter
{
    [Serializable] class HeightmapInfo { public int res; public float minMeters; public float maxMeters; public float sizeMeters; }
    [Serializable] class Manifest { public HeightmapInfo heightmap; public float waterLevelMeters; public string origin; }
    [Serializable] class Bounds3 { public float size; public float above; public float below; }
    [Serializable] class Placement
    {
        public string uid; public string label; public string verb;
        public float[] position; public float rotationY; public float scale;
        public Bounds3 bounds;
    }
    [Serializable] class Placements { public Placement[] placements; }

    [MenuItem("Tools/Worldgence/Import World Bundle...")]
    public static void Import()
    {
        string dir = EditorUtility.OpenFolderPanel("Unzipped Worldgence bundle", "", "");
        if (string.IsNullOrEmpty(dir)) return;

        var manifest = JsonUtility.FromJson<Manifest>(File.ReadAllText(Path.Combine(dir, "manifest.json")));
        var hm = manifest.heightmap;
        if (hm == null || hm.res <= 0) { EditorUtility.DisplayDialog("Worldgence", "manifest.json carries no heightmap entry.", "OK"); return; }

        // ── terrain ──
        byte[] raw = File.ReadAllBytes(Path.Combine(dir, "unity", "heightmap.r16"));
        int res = hm.res;
        if (raw.Length != res * res * 2) { EditorUtility.DisplayDialog("Worldgence", "heightmap.r16 is not res*res*2 bytes.", "OK"); return; }

        float[,] heights = new float[res, res];
        for (int z = 0; z < res; z++)
        {
            int srcRow = res - 1 - z;   // the Z mirror — see the header
            for (int x = 0; x < res; x++)
            {
                int i = (srcRow * res + x) * 2;
                heights[z, x] = (raw[i] | (raw[i + 1] << 8)) / 65535f;
            }
        }

        var data = new TerrainData();
        data.heightmapResolution = res;
        float range = Mathf.Max(hm.maxMeters - hm.minMeters, 0.001f);
        data.size = new Vector3(hm.sizeMeters, range, hm.sizeMeters);
        data.SetHeights(0, 0, heights);
        AssetDatabase.CreateAsset(data, AssetDatabase.GenerateUniqueAssetPath("Assets/WorldgenceTerrain.asset"));

        GameObject terrainGo = Terrain.CreateTerrainGameObject(data);
        terrainGo.name = string.IsNullOrEmpty(manifest.origin) ? "Worldgence Terrain" : manifest.origin + " terrain";
        terrainGo.transform.position = new Vector3(-hm.sizeMeters / 2f, hm.minMeters, -hm.sizeMeters / 2f);

        // ── placements ──
        string pj = Path.Combine(dir, "placements.json");
        int placed = 0;
        if (File.Exists(pj))
        {
            var set = JsonUtility.FromJson<Placements>(File.ReadAllText(pj));
            var root = new GameObject("Placements");
            foreach (var p in set.placements)
            {
                var go = new GameObject(string.IsNullOrEmpty(p.label) ? p.uid : p.label);
                go.transform.SetParent(root.transform);
                // right-handed → left-handed: mirror Z, negate yaw
                go.transform.position = new Vector3(p.position[0], p.position[1], -p.position[2]);
                go.transform.rotation = Quaternion.Euler(0f, -p.rotationY * Mathf.Rad2Deg, 0f);

                var tag = go.AddComponent<WorldgencePlacement>();
                tag.uid = p.uid; tag.label = p.label; tag.verb = p.verb;

                // Placeholder mass from the editor's own measurement, so the
                // scene reads at a glance until prefabs are swapped in.
                float s = (p.bounds != null && p.bounds.size > 0f) ? p.bounds.size : 1.5f;
                float h = (p.bounds != null) ? Mathf.Max(p.bounds.above + p.bounds.below, 0.25f) : s;
                var box = GameObject.CreatePrimitive(PrimitiveType.Cube);
                box.name = "placeholder";
                box.transform.SetParent(go.transform, false);
                box.transform.localScale = new Vector3(s, h, s);
                box.transform.localPosition = new Vector3(0f, h / 2f - ((p.bounds != null) ? p.bounds.below : 0f), 0f);
                placed++;
            }
        }

        // ── water ──
        var water = GameObject.CreatePrimitive(PrimitiveType.Plane);
        water.name = "Water";
        // a Unity plane is 10 x 10 m at scale 1
        water.transform.localScale = new Vector3(hm.sizeMeters / 10f, 1f, hm.sizeMeters / 10f);
        water.transform.position = new Vector3(0f, manifest.waterLevelMeters, 0f);

        EditorUtility.DisplayDialog("Worldgence",
            "Imported: terrain " + res + "x" + res + " over " + hm.sizeMeters + " m, "
            + placed + " placements, water at " + manifest.waterLevelMeters + " m.", "OK");
    }
}
`;

export const UNITY_README = `Worldgence bundle -> Unity
==========================

1. Unzip this .export.zip somewhere on disk (outside Assets is fine).
2. Copy unity/WorldgenceImporter.cs into Assets/Editor/ in your project.
3. In Unity: Tools > Worldgence > Import World Bundle...  and pick the
   unzipped folder.

You get the terrain at real metres, every placement at its authored
transform (as a tagged placeholder box - swap prefabs in by the uid or
label on the WorldgencePlacement component), and the water plane.

Coordinates: the JSON in this bundle is right-handed, +Y up, the engine's
own frame. The importer performs the one mirror Unity needs; if you write
your own reader, mirror Z and negate the yaw.

heightmap.r16 is raw little-endian uint16, row 0 at z = -size/2, normalised
against minMeters/maxMeters from manifest.json. The 16-bit PNG next to it is
the same field for every other tool.
`;

/** The unity/ folder of the bundle. */
export function buildUnityFiles(field) {
  const enc = new TextEncoder();
  return [
    { name: "unity/heightmap.r16", bytes: encodeR16(field) },
    { name: "unity/WorldgenceImporter.cs", bytes: enc.encode(UNITY_IMPORTER_CS) },
    { name: "unity/README.txt", bytes: enc.encode(UNITY_README) },
  ];
}
