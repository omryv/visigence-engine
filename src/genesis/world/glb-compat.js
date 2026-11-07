// glb-compat.js — game-shared contract module. Sanity-checks GLB payloads
// before they enter a record or an export (the browser can't afford to ship
// a corrupt asset into a sold Unity project). Treat as a stable contract.

export const GLB_MAGIC = 0x46546c67; // "glTF"

export function inspectGlb(buffer) {
  if (!buffer || buffer.byteLength < 20) return { ok: false, reason: "too small" };
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== GLB_MAGIC) return { ok: false, reason: "not a GLB (magic mismatch)" };
  const version = dv.getUint32(4, true);
  if (version !== 2) return { ok: false, reason: `glTF version ${version}, need 2` };
  const length = dv.getUint32(8, true);
  if (length > buffer.byteLength) return { ok: false, reason: "truncated GLB" };
  // First chunk must be JSON per spec.
  const chunkType = dv.getUint32(16, true);
  if (chunkType !== 0x4e4f534a) return { ok: false, reason: "first chunk not JSON" };
  const jsonLen = dv.getUint32(12, true);
  let meshes = 0, images = 0;
  try {
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen)));
    meshes = json.meshes?.length || 0;
    images = json.images?.length || 0;
    const ext = json.extensionsRequired || [];
    // Unity's glTFast can't do everything; flag the common blockers.
    const unsupported = ext.filter((e) => ["KHR_draco_mesh_compression"].includes(e));
    if (unsupported.length) return { ok: true, version, length, meshes, images, warning: `requires ${unsupported.join(", ")}` };
  } catch {
    return { ok: false, reason: "unparseable JSON chunk" };
  }
  return { ok: true, version, length, meshes, images };
}

export function assertGlb(buffer, label = "asset") {
  const info = inspectGlb(buffer);
  if (!info.ok) throw new Error(`GLB "${label}" rejected: ${info.reason}`);
  if (info.warning) console.warn(`[glb-compat] "${label}": ${info.warning}`);
  return info;
}
