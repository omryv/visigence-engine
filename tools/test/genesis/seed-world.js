/* A seed's own world as a saved world file: what the editor opens on (src/kernel/seed.js DEFAULT_SEED, nothing
 * placed), built through the same buildWorldFile a Save goes through. The suites that need "a world document" read
 * this one; there is no authored sample world any more. */
import { makeParams } from "../../../src/kernel/presets.js";
import { DEFAULT_SEED } from "../../../src/kernel/seed.js";
import { bakeHeightField } from "../../../src/kernel/terrain/heightfield.js";
import { buildWorldFile } from "../../../src/genesis/world/worldfile.js";

const params = makeParams({ seed: DEFAULT_SEED });
export const SEED_WORLD = buildWorldFile({ params, propRecords: [], field: bakeHeightField(params, 65) });
