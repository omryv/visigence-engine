/* graph.js — questions you ask of a plan.
 *
 * Every one of these was written inside game/horror/world/plan.js, where it
 * sat next to genuinely horror-specific code and was reachable only by
 * importing a horror module. None of them knows anything about horror, or
 * about buildings, or about rooms: they operate on NODES joined by EDGES,
 * and the only thing they require of a caller is that it can say which node
 * an edge runs between.
 *
 * They live here because the second game mode that needs "how many doors
 * from the way in is this" should not have to import the first one to get
 * it — and because "is there another way round" is the kind of question a
 * placement rule, a threat rule, a validator and a mission layer all ask,
 * which is exactly what makes it engine rather than content.
 *
 * The shape a caller supplies is deliberately minimal:
 *
 *   { nodes: [...], edges: [{ a, b, ...}] }
 *
 * `a` and `b` are indices into `nodes`, and an edge may carry anything else
 * it likes — a door, a corridor, a pipe. Negative indices mean OUTSIDE, so a
 * graph can name its own entrances without inventing a sentinel node.
 *
 * Pure JS. No three.js, no DOM, no globals, no randomness.
 */

export const OUTSIDE = -1;

/* Everything joined to one node, with the edge that joins them. The edge
   comes back too, because callers almost always need to know WHAT the
   connection was — a door you can open, a stair you have to climb. */
export function neighbours(graph, node) {
  const out = [];
  for (const e of graph.edges) {
    if (e.a === node) out.push({ node: e.b, edge: e });
    else if (e.b === node) out.push({ node: e.a, edge: e });
  }
  return out;
}

/* Hops from a start node to every other. Breadth-first, so the number is the
   number of EDGES crossed rather than any distance in metres — which is the
   number that matters for "how deep is this", "how far was help" and "is
   this somewhere you pass or somewhere you go".

   Nodes outside the graph (negative ids) are not traversed. */
export function depths(graph, start) {
  const dist = new Map(graph.nodes.map((_, i) => [i, Infinity]));
  if (start == null || start < 0) return dist;
  dist.set(start, 0);
  const queue = [start];
  while (queue.length) {
    const at = queue.shift();
    for (const n of neighbours(graph, at)) {
      if (n.node < 0 || dist.get(n.node) <= dist.get(at) + 1) continue;
      dist.set(n.node, dist.get(at) + 1);
      queue.push(n.node);
    }
  }
  return dist;
}

/* The shortest way from one node to another, as a list of node ids including
   both ends. Null when there is no route at all — which is a fact worth
   having rather than an empty array that reads like success. */
export function routeBetween(graph, from, to) {
  if (from === to) return [from];
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const at = queue.shift();
    for (const n of neighbours(graph, at)) {
      if (n.node < 0 || prev.has(n.node)) continue;
      prev.set(n.node, at);
      if (n.node === to) {
        const path = [to];
        let cur = to;
        while (prev.get(cur) != null) { cur = prev.get(cur); path.push(cur); }
        return path.reverse();
      }
      queue.push(n.node);
    }
  }
  return null;
}

/* Is there a route that AVOIDS a node? The question behind "can the player
   go round this", and therefore behind every fairness rule about where a
   blockage may be placed. */
export function routeAvoiding(graph, from, to, avoid) {
  if (from === avoid || to === avoid) return null;
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const at = queue.shift();
    if (at === to) return true;
    for (const n of neighbours(graph, at)) {
      if (n.node < 0 || n.node === avoid || seen.has(n.node)) continue;
      seen.add(n.node);
      queue.push(n.node);
    }
  }
  return null;
}

/* A node with one way in and out. `ignore` lets a caller discount an edge
   kind — an entrance from outside is not what makes a room a dead end. */
export function isDeadEnd(graph, node, ignore = null) {
  const live = neighbours(graph, node).filter((n) => !ignore || !ignore(n.edge));
  return live.length <= 1;
}

/* Every node reachable from a start. The set, not the count, because the
   thing a caller usually wants next is what is NOT in it. */
export function reachableFrom(graph, start) {
  const seen = new Set();
  if (start == null || start < 0) return seen;
  const queue = [start];
  seen.add(start);
  while (queue.length) {
    const at = queue.shift();
    for (const n of neighbours(graph, at)) {
      if (n.node < 0 || seen.has(n.node)) continue;
      seen.add(n.node);
      queue.push(n.node);
    }
  }
  return seen;
}

/* Nodes nothing can reach. The single most useful validation a generated
   plan can run on itself: a room that exists and cannot be entered is a
   sealed void, and it is invisible until somebody walks the building. */
export function unreachable(graph, start) {
  const seen = reachableFrom(graph, start);
  return graph.nodes.map((_, i) => i).filter((i) => !seen.has(i));
}

/* A spanning tree back to a root, breadth-first. Returns the EDGES of the
   tree, which is what a caller cuts doorways along: taking a tree rather
   than the whole adjacency is what guarantees every node is reachable
   without opening every wall in the building. */
export function spanningTree(graph, root) {
  const seen = new Set([root]);
  const queue = [root];
  const edges = [];
  while (queue.length) {
    const at = queue.shift();
    for (const n of neighbours(graph, at)) {
      if (n.node < 0 || seen.has(n.node)) continue;
      seen.add(n.node);
      edges.push({ ...n.edge, a: at, b: n.node });
      queue.push(n.node);
    }
  }
  return edges;
}
