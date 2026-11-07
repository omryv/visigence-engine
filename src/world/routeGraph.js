/**
 * ROUTE GRAPH: an ordered chain of points of interest with typed hooks, for any theme to fill and any system to
 * read. A level's landmarks (world/worldLandmarks.js for Arcade), a mission compiler placing a checkpoint, or the
 * wildlife choosing a home all see the same plain data:
 *
 *   route.nodes[i]   { index, id, kind, x, z, hook: { type, label, item?, from? }, life?, keeper?, lane?, pad?, stand? }
 *                    (`stand`: where a visitor stands, in front of a landmark that collides)
 *   route.edges[i]   { a, b, d, via }   from node a to node b, d metres apart, via a lane id or 'square'
 *
 * Hook types:
 *   visit      being there is enough (a lookout, a viewpoint);
 *   interact   a thing to use; it may `give` an item (a well gives water, a windmill flour);
 *   deliver    a place that `takes` items; resolved to the first item an earlier node gives, with `from` its index.
 *              A deliver node with nothing to receive degrades to a visit.
 *
 * The chain is walked from `start` by a greedy nearest-neighbour: at every step the closest node that is ready
 * (a deliver node is ready once any of its items has been given) comes next, ties on the lower input index, so
 * the order is deterministic and needs no trigonometry. Every theme may ignore the route; Arcade uses it.
 */
const r4 = v => Math.floor(v * 10000 + 0.5) / 10000;

/**
 * @param {{id: string, kind: string, x: number, z: number, hook: {type: string, label: string, gives?: string, takes?: string[]}, life?: string[], keeper?: string|null, lane?: string}[]} pois
 * @param {{x: number, z: number}} start  where the chain begins (the spawn)
 */
export function chainRoute(pois, start) {
  const given = new Map(), delivered = new Set(), nodes = [], edges = [], left = pois.map((p, i) => ({ p, i }));
  let at = { x: start.x, z: start.z }, prev = -1;
  while (left.length) {
    let pick = -1, bd = Infinity, best = null;
    for (let q = 0; q < left.length; q++) {
      const { p } = left[q], H = p.hook;
      const ready = H.type !== 'deliver' || (H.takes ?? []).some(item => given.has(item)) || !pois.some(o => o !== p && o.hook.gives && (H.takes ?? []).includes(o.hook.gives));
      if (!ready) continue;
      const d = Math.sqrt((p.x - at.x) * (p.x - at.x) + (p.z - at.z) * (p.z - at.z));
      if (d < bd) { bd = d; pick = q; best = left[q]; }
    }
    if (pick < 0) { pick = 0; best = left[0]; bd = Math.sqrt((best.p.x - at.x) ** 2 + (best.p.z - at.z) ** 2); }   // nothing ready: take the next in input order
    left.splice(pick, 1);
    const p = best.p, H = p.hook, index = nodes.length;
    const hook = { type: H.type, label: H.label };
    if (H.type === 'deliver') {
      // An item nobody has delivered yet first (two stalls trade different goods), else any given item.
      const takes = H.takes ?? [], item = takes.find(it => given.has(it) && !delivered.has(it)) ?? takes.find(it => given.has(it));
      if (item !== undefined) { hook.item = item; hook.from = given.get(item); delivered.add(item); }
      else { hook.type = 'visit'; hook.label = H.visitLabel ?? H.label; }
    }
    if (H.gives) { hook.gives = H.gives; if (!given.has(H.gives)) given.set(H.gives, index); }
    const node = { index, id: p.id, kind: p.kind, x: p.x, z: p.z, hook };
    if (p.life?.length) node.life = p.life.slice();
    if (p.keeper) node.keeper = p.keeper;
    if (p.lane) node.lane = p.lane;
    if (p.pad) node.pad = p.pad;
    if (p.stand) node.stand = p.stand;
    nodes.push(node);
    edges.push({ a: prev, b: index, d: r4(bd), via: p.lane ?? 'square' });
    at = { x: p.x, z: p.z }; prev = index;
  }
  return { start: { x: start.x, z: start.z }, nodes, edges };
}

/** The nodes of one hook type, in route order. */
export function routeNodes(route, type) {
  return route ? route.nodes.filter(n => n.hook.type === type) : [];
}
