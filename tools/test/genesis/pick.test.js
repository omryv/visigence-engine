/* Skirts are not ground.
 *
 * A terrain tile's geometry is surface triangles followed by a skirt ring,
 * and the raycast used to take hit[0] whichever half it struck — so a
 * grazing ray on a nearer tile's skirt wall handed the sculpt brush, the
 * site ring, the ghost and the spawn marker a point metres below the ground
 * the pointer was actually over.
 *
 * The rule that repairs it is pure (engine/terrain/pick.js): first hit whose
 * triangle index lies in the recorded surface range. This suite drives it
 * with synthetic hit lists, checks the index arithmetic the recorder relies
 * on, and pins the wiring as text — QuadtreeTerrain must record the boundary
 * BEFORE appending the skirt, and Engine.raycastGround must go through the
 * helper rather than [0].
 */
import { test, ok, eq, report } from "../kernel/harness.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { firstGroundHit } from "../../../src/genesis/terrain/pick.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const code = (p) => readFileSync(join(ROOT, p), "utf8");

// A synthetic hit: distance-ordered like three's intersectObjects output.
const hit = (faceIndex, groundIndexCount, point = { x: 0, y: 0, z: 0 }) => ({
  faceIndex, point,
  object: { geometry: { userData: { groundIndexCount } } },
});

// The counts a real tile records: res² grid → (res-1)²·2 surface triangles,
// then 4(res-1) skirt edges → 8(res-1) more.
const surfaceCount = (res) => (res - 1) * (res - 1) * 6;
const skirtFaces = (res) => 4 * (res - 1) * 2;

test("a surface hit passes and a skirt hit is skipped", () => {
  const res = 65;
  const ground = surfaceCount(res);
  eq(firstGroundHit([hit(0, ground)]).faceIndex, 0, "first surface triangle");
  eq(firstGroundHit([hit(ground / 3 - 1, ground)]).faceIndex, ground / 3 - 1, "last surface triangle");
  eq(firstGroundHit([hit(ground / 3, ground)]), null, "first skirt triangle is not ground");
  eq(firstGroundHit([hit(ground / 3 + skirtFaces(res) - 1, ground)]), null, "last skirt triangle");
});

test("a nearer skirt hit does not shadow the ground behind it", () => {
  // The bug in one list: skirt of tile A first (nearer), true ground of tile
  // B second. The helper must return B's point, not A's wall.
  const res = 65;
  const ground = surfaceCount(res);
  const wanted = { x: 12, y: 34, z: 56 };
  const got = firstGroundHit([
    hit(ground / 3 + 4, ground),          // tile A: skirt wall, nearest
    hit(100, ground, wanted),             // tile B: real ground behind it
  ]);
  eq(got.point, wanted, "the skirt wall shadowed the ground");
});

test("all-skirt lists yield null, empty lists yield null", () => {
  const ground = surfaceCount(33);
  eq(firstGroundHit([hit(ground / 3, ground), hit(ground / 3 + 7, ground)]), null);
  eq(firstGroundHit([]), null);
});

test("geometry with no recorded boundary counts as ground", () => {
  // Only terrain tiles carry skirts; anything else pickable is all surface.
  const bare = { faceIndex: 9, point: { x: 1, y: 2, z: 3 }, object: { geometry: { userData: {} } } };
  eq(firstGroundHit([bare]), bare);
});

test("the recorder writes the boundary before the skirt exists", () => {
  const src = code("src/genesis/terrain/QuadtreeTerrain.js");
  const record = src.indexOf("groundIndexCount = index.length");
  const skirt = src.indexOf("// Skirt:");
  ok(record !== -1, "QuadtreeTerrain no longer records where the surface ends");
  ok(skirt !== -1, "the skirt comment moved — retarget this check");
  ok(record < skirt, "the boundary is recorded AFTER skirt triangles were appended");
  ok(/geo\.userData\.groundIndexCount/.test(src), "the count never reaches the geometry");
});

test("raycastGround goes through the rule, not through [0]", () => {
  const src = code("src/genesis/Engine.js");
  ok(/firstGroundHit\(/.test(src), "Engine.raycastGround stopped filtering skirt hits");
  const fn = src.slice(src.indexOf("raycastGround("), src.indexOf("raycastProps("));
  ok(!/intersectObjects\([^)]*\)\[0\]/.test(fn),
    "raycastGround takes the nearest hit unfiltered again");
});

report("pick");
