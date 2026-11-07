// Connection ports: the local→world transform, what may legally connect to
// what, and the guarantee that the matcher takes the BEST pair rather than
// the first one it stumbles over.
import { test, eq, ok, close, report } from "../kernel/harness.js";
import { worldPorts, collectPorts, compatible, scoreMatch, matchPorts, linkGeometry }
  from "../../../src/kernel/core/ports.js";
import { buildingParts } from "../../../src/genesis/world/block-shapes.js";

// The composer's own rotation helper, copied here so the test pins the
// convention rather than importing whatever compose.js happens to do today.
const alongTo = (dx, dz) => Math.atan2(-dz, dx);

const rec = (uid, x, z, rotationY, ports, y = 0, extra = {}) => ({
  uid, position: [x, y, z], rotationY, scale: 1,
  proc: { parts: [], ports }, ...extra,
});
const P = (kind, pos, normal, more = {}) => ({ kind, pos, normal, ...more });

/* ── local → world ── */

test("an unrotated placement moves its ports by the position only", () => {
  const r = rec("a", 10, -4, 0, [P("walkway", [1, 3, 2], [0, 1], { width: 2 })]);
  const [p] = worldPorts(r);
  close(p.x, 11, 1e-9, "x");
  close(p.y, 3, 1e-9, "y");
  close(p.z, -2, 1e-9, "z");
  close(p.nx, 0, 1e-9, "normal x");
  close(p.nz, 1, 1e-9, "normal z");
  eq(p.uid, "a");
  eq(p.width, 2);
});

test("rotation follows the composer's alongTo convention", () => {
  // A port whose local normal is +x, on a placement laid along (dx, dz),
  // must end up pointing along (dx, dz). Get this sign backwards and every
  // bridge in a street leaves through the back of its building.
  for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [3, 4], [-5, 2]]) {
    const L = Math.hypot(dx, dz);
    const r = rec("a", 0, 0, alongTo(dx, dz), [P("walkway", [0, 0, 0], [1, 0])]);
    const [p] = worldPorts(r);
    close(p.nx, dx / L, 1e-9, `normal x for ${dx},${dz}`);
    close(p.nz, dz / L, 1e-9, `normal z for ${dx},${dz}`);
  }
});

test("a quarter turn carries the port position round with it", () => {
  const r = rec("a", 0, 0, Math.PI / 2, [P("door", [2, 1, 0], [1, 0])]);
  const [p] = worldPorts(r);
  // rotationY = +90° maps local +x onto -z (alongTo(0,-1) === PI/2).
  close(p.x, 0, 1e-9, "x");
  close(p.z, -2, 1e-9, "z");
  close(p.y, 1, 1e-9, "y is never rotated");
});

test("scale and per-placement stretch carry the ports with the geometry", () => {
  const r = rec("a", 0, 0, 0, [P("walkway", [2, 4, 0], [1, 0])], 0,
    { scale: 2, stretch: [1, 0.5, 1] });
  const [p] = worldPorts(r);
  close(p.x, 4, 1e-9, "x scaled");
  close(p.y, 4, 1e-9, "y takes scale x stretch — a squashed ruin keeps its ports");
});

test("the seated ground height is the port's datum", () => {
  // props.add() re-seats every placement onto the terrain, so a building on a
  // hill must carry its ports up the hill with it.
  const r = rec("a", 0, 0, 0, [P("roof", [0, 20, 0], [0, 1])], 55);
  const [p] = worldPorts(r);
  close(p.y, 75, 1e-9, "20m of building on 55m of hill");
});

test("collectPorts skips placements that declare none", () => {
  const list = collectPorts([
    rec("a", 0, 0, 0, [P("door", [0, 0, 1], [0, 1])]),
    { uid: "b", position: [0, 0, 0], proc: { parts: [] } },
    { uid: "c", position: [0, 0, 0] },
    rec("d", 9, 0, 0, [P("walkway", [0, 3, 0], [0, 1])]),
  ]);
  eq(list.length, 2);
  eq(list[0].uid, "a");
  eq(list[1].uid, "d");
});

/* ── compatibility ── */

test("only sensible kinds connect, and the table reads both ways", () => {
  ok(compatible("walkway", "walkway"), "deck to deck");
  ok(compatible("walkway", "roof"), "deck onto a roof");
  ok(compatible("roof", "walkway"), "and the same pair stated backwards");
  ok(compatible("door", "walkway"), "a walkway may reach an entrance");
  ok(compatible("pipe", "pipe"), "pipe to pipe");
  ok(!compatible("pipe", "walkway"), "a pipe is not a bridge");
  ok(!compatible("pipe", "door"), "a pipe does not end at a front door");
  ok(!compatible("roof", "roof"), "two roofs do not join without a deck");
});

/* ── the score ──
   A rejected pair returns null, which is categorically different from a poor
   score: no amount of emptiness elsewhere may promote it. */

const wp = (uid, x, y, z, nx, nz, kind = "walkway") =>
  ({ uid, index: 0, kind, x, y, z, nx, nz, width: 2, level: 0, capacity: 1 });

test("a port never connects to itself or to its own building", () => {
  const a = wp("a", 0, 5, 0, 0, 1);
  const b = { ...wp("a", 0, 5, 12, 0, -1), index: 1 };
  eq(scoreMatch(a, b), null);
});

test("incompatible kinds score null", () => {
  eq(scoreMatch(wp("a", 0, 5, 0, 0, 1, "pipe"), wp("b", 0, 5, 12, 0, -1, "walkway")), null);
});

test("span limits reject the too-near and the too-far", () => {
  ok(scoreMatch(wp("a", 0, 5, 0, 0, 1), wp("b", 0, 5, 12, 0, -1)) !== null, "12m is fine");
  eq(scoreMatch(wp("a", 0, 5, 0, 0, 1), wp("b", 0, 5, 2, 0, -1)), null, "2m is too close");
  eq(scoreMatch(wp("a", 0, 5, 0, 0, 1), wp("b", 0, 5, 200, 0, -1)), null, "200m is too far");
});

test("both ends must face each other", () => {
  // b sits in front of a, but faces away — a walkway would leave through its
  // back wall. This is the check that makes bridges arrive at entrances.
  eq(scoreMatch(wp("a", 0, 5, 0, 0, 1), wp("b", 0, 5, 12, 0, 1)), null, "b faces away");
  eq(scoreMatch(wp("a", 0, 5, 0, 0, -1), wp("b", 0, 5, 12, 0, -1)), null, "a faces away");
  ok(scoreMatch(wp("a", 0, 5, 0, 0, 1), wp("b", 0, 5, 12, 0, -1)) !== null, "facing is fine");
});

test("a facing pair scores better than a glancing one", () => {
  const head = scoreMatch(wp("a", 0, 5, 0, 0, 1), wp("b", 0, 5, 12, 0, -1));
  const skew = scoreMatch(wp("a", 0, 5, 0, 0.7, 0.71), wp("b", 0, 5, 12, 0, -1));
  ok(head < skew, `square-on (${head.toFixed(3)}) must beat glancing (${skew.toFixed(3)})`);
});

test("a walkway may not climb more steeply than its slope limit", () => {
  ok(scoreMatch(wp("a", 0, 0, 0, 0, 1), wp("b", 0, 2, 12, 0, -1)) !== null, "2m over 12m is walkable");
  eq(scoreMatch(wp("a", 0, 0, 0, 0, 1), wp("b", 0, 9, 12, 0, -1)), null, "9m over 12m is a ladder");
});

test("dropping onto a roof is exempt from the slope limit, climbing to one is not", () => {
  const down = scoreMatch(wp("a", 0, 20, 0, 0, 1), wp("b", 0, 4, 12, 0, -1, "roof"));
  ok(down !== null, "a deck may fall steeply onto a roof");
  const up = scoreMatch(wp("a", 0, 4, 0, 0, 1), wp("b", 0, 20, 12, 0, -1));
  eq(up, null, "but it may not climb the same grade to a deck");
});

test("a shorter, flatter link scores lower than a long steep one", () => {
  const near = scoreMatch(wp("a", 0, 5, 0, 0, 1), wp("b", 0, 5, 10, 0, -1));
  const far = scoreMatch(wp("a", 0, 5, 0, 0, 1), wp("b", 0, 8, 40, 0, -1));
  ok(near < far, `near+flat ${near.toFixed(3)} must beat far+steep ${far.toFixed(3)}`);
});

test("a run straight through another building is refused", () => {
  const a = wp("a", 0, 5, 0, 0, 1), b = wp("b", 0, 5, 30, 0, -1);
  ok(scoreMatch(a, b, { obstacles: [] }) !== null, "clear span is fine");
  eq(scoreMatch(a, b, { obstacles: [{ uid: "c", x: 0, z: 15, r: 6 }] }), null, "dead through it");
  // Its own endpoints never obstruct themselves.
  ok(scoreMatch(a, b, { obstacles: [{ uid: "a", x: 0, z: 0, r: 6 }] }) !== null, "endpoint is not an obstacle");
});

test("a near miss is penalised without being rejected", () => {
  const a = wp("a", 0, 5, 0, 0, 1), b = wp("b", 0, 5, 30, 0, -1);
  const clean = scoreMatch(a, b, { obstacles: [] });
  const grazing = scoreMatch(a, b, { obstacles: [{ uid: "c", x: 7, z: 15, r: 6 }] });
  ok(grazing !== null, "a graze is still legal");
  ok(grazing > clean, "but it costs more than a clear run");
});

/* ── the matcher ── */

test("the matcher takes the lowest score, not the first candidate", () => {
  // `far` is offered first and is perfectly legal. `near` is better. The
  // whole point of the pass is that `near` wins anyway.
  const ports = [
    wp("a", 0, 5, 0, 0, 1),
    wp("far", 0, 5, 40, 0, -1),
    wp("near", 0, 5, 11, 0, -1),
  ];
  const links = matchPorts(ports, { maxLinks: 1 });
  eq(links.length, 1);
  eq(links[0].b.uid, "near", "the nearer, cheaper pair must be chosen");
});

test("each port is spent once", () => {
  const ports = [
    wp("a", 0, 5, 0, 0, 1),
    wp("b", 0, 5, 12, 0, -1),
    wp("c", 0, 5, 13, 0, -1),
  ];
  const links = matchPorts(ports);
  const seen = new Set();
  for (const l of links) {
    for (const p of [l.a, l.b]) {
      const k = p.uid + "#" + p.index;
      ok(!seen.has(k), `port ${k} was used twice`);
      seen.add(k);
    }
  }
});

test("two buildings are never linked twice", () => {
  const ports = [
    { ...wp("a", -2, 5, 0, 0, 1), index: 0 },
    { ...wp("a", 2, 5, 0, 0, 1), index: 1 },
    { ...wp("b", -2, 5, 12, 0, -1), index: 0 },
    { ...wp("b", 2, 5, 12, 0, -1), index: 1 },
  ];
  const links = matchPorts(ports);
  eq(links.length, 1, "one bridge between a and b, not two parallel ones");
});

test("matching is deterministic", () => {
  const build = () => [
    wp("a", 0, 5, 0, 0, 1), wp("b", 0, 5, 12, 0, -1),
    wp("c", 20, 5, 0, 0, 1), wp("d", 20, 5, 14, 0, -1),
    wp("e", 40, 6, 0, 0, 1), wp("f", 40, 5, 13, 0, -1),
  ];
  const a = JSON.stringify(matchPorts(build()));
  const b = JSON.stringify(matchPorts(build()));
  eq(a, b, "same ports must give the same links");
});

test("nothing legal means no links, not a bad link", () => {
  const links = matchPorts([wp("a", 0, 5, 0, 0, 1), wp("b", 0, 5, 300, 0, -1)]);
  eq(links.length, 0);
});

/* ── link geometry ── */

test("link geometry lays a run-along-X piece onto the link", () => {
  const a = wp("a", 0, 5, 0, 0, 1), b = wp("b", 0, 5, 12, 0, -1);
  const g = linkGeometry(a, b);
  close(g.x, 0, 1e-9, "midpoint x");
  close(g.z, 6, 1e-9, "midpoint z");
  close(g.run, 12, 1e-9, "plan run");
  close(g.rotationY, alongTo(0, 12), 1e-9, "must match the composer's alongTo");
});

test("a sloped deck is longer than its plan run", () => {
  const g = linkGeometry(wp("a", 0, 0, 0, 0, 1), wp("b", 0, 5, 12, 0, -1));
  close(g.run, 12, 1e-9, "plan run ignores the climb");
  close(g.span, 13, 1e-9, "3-4-5: the deck itself is 13m");
  close(g.rise, 5, 1e-9, "rise");
  ok(g.pitch > 0, "b is higher, so the deck tilts up");
});

test("a link is only as wide as its narrower end", () => {
  const a = { ...wp("a", 0, 5, 0, 0, 1), width: 3 };
  const b = { ...wp("b", 0, 5, 12, 0, -1), width: 1.6 };
  close(linkGeometry(a, b).width, 1.6, 1e-9);
});

/* ── against real buildings ── */

test("a generated building emits the ports its shape implies", () => {
  const one = buildingParts({ floors: 6, tiers: 1 });
  const three = buildingParts({ floors: 12, tiers: 3 });
  const kinds = (b) => b.ports.map((p) => p.kind);

  eq(kinds(one).filter((k) => k === "door").length, 1, "one entrance");
  eq(kinds(one).filter((k) => k === "roof").length, 1, "one roof landing");
  ok(kinds(three).filter((k) => k === "walkway").length >
     kinds(one).filter((k) => k === "walkway").length,
     "a stacked building offers walkways at more levels");

  // Every walkway port must look outward, and sit above the ground.
  for (const p of three.ports.filter((q) => q.kind === "walkway")) {
    close(Math.hypot(p.normal[0], p.normal[1]), 1, 1e-9, "normals are unit");
    ok(p.pos[1] > 0, "a walkway port is never at ground level");
  }
});

test("a row unit offers no walkway through its party walls", () => {
  const party = buildingParts({ floors: 4, tiers: 2, sides: "party" });
  for (const p of party.ports.filter((q) => q.kind === "walkway")) {
    eq(p.normal[0], 0, "a party wall is blind — nothing may leave through it");
  }
});

test("two placed towers see each other's ports across the gap", () => {
  const a = { uid: "t1", position: [0, 0, 0], rotationY: 0, scale: 1,
              proc: buildingParts({ floors: 9, tiers: 3, w: 10, d: 10 }) };
  const b = { uid: "t2", position: [0, 0, 22], rotationY: 0, scale: 1,
              proc: buildingParts({ floors: 9, tiers: 3, w: 10, d: 10 }) };
  const links = matchPorts(collectPorts([a, b]), {
    obstacles: [{ uid: "t1", x: 0, z: 0, r: 7 }, { uid: "t2", x: 0, z: 22, r: 7 }],
  });
  eq(links.length, 1, "one walkway between two towers");
  const [l] = links;
  ok(l.a.uid !== l.b.uid, "it spans the gap rather than looping back");
  const g = linkGeometry(l.a, l.b);
  ok(g.run > 0 && g.run < 46, `span ${g.run.toFixed(1)}m is buildable`);
  ok(Math.abs(g.rise) / g.run <= 0.28 + 1e-9, "and it is walkable");
});

report("ports");
