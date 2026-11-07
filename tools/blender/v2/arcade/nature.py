"""Arcade nature kit: cushioned foliage, trees (oak, pine, sapling), bushes, grass tufts, pebbles and a
painted grass ground. exec after vg.py and kit.py (same globals).

Foliage and grass take their colour from tone ramps baked into the 'Col' vertex attribute (their
materials are white), so the greens below are the single source of truth for every tree and lawn.
Foliage is an icosphere split into rounded leaf cushions (Voronoi cells with a circular profile and
pushed-in creases): a scalloped silhouette under the outline, lit cushion tops, dark creases, and
normals softened toward the canopy centre so the whole crown reads as one lit volume.
"""
import bpy, bmesh, math, random
import numpy as np
from mathutils import Vector, Matrix, kdtree, noise as mnoise

# sRGB tone ramps, dark -> light
LEAF = ('#23663f', '#3f9a40', '#7cc843', '#bfe36a')
PINE = ('#18574a', '#2a8656', '#5fb558', '#9fd666')
GRASS = ('#3b8f3c', '#5cb042', '#86cb4e', '#b3da60')
BARK = ('#5e3521', '#8a532f', '#b0733f')

def ramp(stops, t):
    t = min(1.0, max(0.0, t)) * (len(stops) - 1)
    i = min(int(t), len(stops) - 2); f = t - i
    a, b = hexlin(stops[i]), hexlin(stops[i + 1])
    return tuple(a[k] + (b[k] - a[k]) * f for k in range(3))

def _set_col(ob, cols):
    """Write a flat list of linear RGB tuples (one per vertex) into the GRAD attribute."""
    me = ob.data
    a = me.color_attributes.get(GRAD) or me.color_attributes.new(GRAD, 'FLOAT_COLOR', 'POINT')
    a.data.foreach_set('color', [c for rgb in cols for c in (*rgb, 1.0)])
    try:
        me.color_attributes.active_color_name = GRAD; me.color_attributes.default_color_name = GRAD
    except AttributeError: pass

# ---------------------------------------------------------------- foliage

def puff(name, r, mat, subd=4, cells=18, depth=0.16, lobes=0.1, flat=-0.5, squash=(1, 1, 0.88), center=(0, 0, 0), seed=0):
    """Foliage clump of rounded leaf cushions. Each vertex's cushion height goes to 'arc_bump'."""
    rnd = random.Random(seed)
    bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=subd, radius=1.0)
    golden = math.pi * (3 - math.sqrt(5)); pts = []
    for i in range(cells):
        z = 1 - 2 * (i + 0.5) / cells; rr = math.sqrt(max(0.0, 1 - z * z)); a = i * golden
        p = Vector((rr * math.cos(a), rr * math.sin(a), z)) + Vector([rnd.uniform(-0.18, 0.18) for _ in range(3)])
        pts.append(tuple(p.normalized()))
    P = np.array(pts); w = 0.42 * math.sqrt(4 * math.pi / cells)
    off = Vector((seed * 3.1, seed * 1.7, seed * 0.9)); bumps = []
    for v in bm.verts:
        n = v.co.normalized()
        d = np.sort(np.linalg.norm(P - np.array(n), axis=1))
        t = min(1.0, (d[1] - d[0]) / w)
        bump = math.sqrt(max(0.0, 1 - (1 - t) ** 2))
        co = n * (1 + lobes * mnoise.noise(n * 1.1 + off)) * (1 - depth * (1 - bump))
        if co.z < flat: co.z = flat + (co.z - flat) * 0.35
        v.co = Vector((co.x * squash[0] * r, co.y * squash[1] * r, co.z * squash[2] * r)) + Vector(center)
        bumps.append(bump)
    ob = new_obj(name, bm, mat); ob.data.shade_smooth()
    ob.data.attributes.new('arc_bump', 'FLOAT', 'POINT').data.foreach_set('value', bumps)
    return ob

def soften(ob, center, amount=0.45):
    """Blend vertex normals toward the canopy centre: the crown shades as one volume, cushions stay."""
    c = Vector(center); ns = []
    for v in ob.data.vertices:
        ns.append((v.normal * (1 - amount) + (v.co - c).normalized() * amount).normalized())
    ob.data.normals_split_custom_set_from_vertices(ns)

def paint_foliage(ob, stops, lo, hi, up=0.2):
    me = ob.data; n = len(me.vertices)
    b = np.ones(n, np.float32)
    if 'arc_bump' in me.attributes: me.attributes['arc_bump'].data.foreach_get('value', b)
    cols = []
    for i, v in enumerate(me.vertices):
        h = (v.co.z - lo) / max(hi - lo, 1e-6)
        cols.append(ramp(stops, 0.42 * h + 0.52 * b[i] ** 1.4 + up * max(0.0, v.normal.z) - 0.16))
    _set_col(ob, cols)

# ---------------------------------------------------------------- trunks and branches

def trunk(name, h, r, mat, seed=0, roots=5, lean=0.12, segs=10):
    rnd = random.Random(seed)
    fr = (0.0, 0.03, 0.08, 0.16, 0.3, 0.5, 0.7, 0.88, 1.0)
    rk = (1.0, 0.86, 0.72, 0.62, 0.56, 0.52, 0.52, 0.56, 0.42)
    ob = lathe(name, [(r * k, h * f) for k, f in zip(rk, fr)], axis='Z', segs=segs, mat=mat)
    ph = rnd.uniform(0, 2 * math.pi)
    for v in ob.data.vertices:
        z = v.co.z; a = math.atan2(v.co.y, v.co.x)
        s = 1 + 0.9 * max(0.0, math.cos(roots * a + ph)) ** 2 * math.exp(-z / (0.16 * h))
        v.co.x *= s; v.co.y *= s
        v.co.x += lean * h * math.sin(z / h * math.pi * 0.8)
    smooth(ob, 70, weighted=False)
    return ob

def limb(name, a, b, r0, r1, mat, segs=6):
    a, b = Vector(a), Vector(b); d = b - a
    ob = lathe(name, [(r0, 0.0), (r1, d.length)], axis='Z', segs=segs, mat=mat)
    ob.data.transform(Matrix.Translation(a) @ Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4())
    ob.data.shade_smooth()
    return ob

def paint_bark(ob, h, seed=0):
    off = seed * 1.37; cols = []
    for v in ob.data.vertices:
        a = math.atan2(v.co.y, v.co.x)
        streak = 0.5 + 0.5 * math.cos(4 * a + 1.5 * mnoise.noise(Vector((v.co.z * 0.8, off, 0.3))))
        t = 0.35 + 0.45 * min(1.0, v.co.z / (0.35 * h)) + 0.25 * streak - 0.3 * max(0.0, (v.co.z - 0.75 * h) / (0.25 * h))
        cols.append(ramp(BARK, t))
    _set_col(ob, cols)

# ---------------------------------------------------------------- trees

def oak(name, M, seed=0, s=1.0):
    """Round hero tree: flared trunk with limbs into a cushioned crown of one big and three side clumps."""
    rnd = random.Random(seed); h = 3.2 * s
    tr = trunk(name + '_trunk', h, 0.42 * s, M['Bark'], seed)
    top = Vector((0.12 * h * math.sin(0.8 * math.pi), 0.0, h))
    main_c = Vector((top.x, 0.0, 4.9 * s))
    sides = [Vector((1.7, -0.35, 4.25)), Vector((-1.6, 0.4, 4.35)), Vector((0.35, -1.35, 4.05))]
    rot = Matrix.Rotation(rnd.uniform(0, 2 * math.pi), 3, 'Z')
    sides = [rot @ (v * s) for v in sides]
    bark = [tr] + [limb(f'{name}_l{i}', top - Vector((0, 0, 0.6 * s)), c.lerp(top, 0.25), 0.17 * s, 0.07 * s, M['Bark'])
                   for i, c in enumerate(sides)]
    paint_bark(tr, h, seed)
    for l in bark[1:]: _set_col(l, [ramp(BARK, 0.45)] * len(l.data.vertices))
    wood = merge(name + '_wood', bark)
    clumps = [puff(f'{name}_c0', 2.2 * s, M['Leaf'], 4, 17, depth=0.17, center=main_c, seed=seed * 10)]
    clumps += [puff(f'{name}_c{i + 1}', rnd.uniform(1.25, 1.45) * s, M['Leaf'], 3, 8, depth=0.2, center=c, seed=seed * 10 + i + 1)
               for i, c in enumerate(sides)]
    crown = merge(name + '_crown', clumps)
    soften(crown, main_c - Vector((0, 0, 0.4 * s)), 0.3)
    paint_foliage(crown, LEAF, 2.6 * s, 7.0 * s)
    ob = merge(name, [wood, crown]); ob['arc_outline'] = 0.045
    return ob

def pine(name, M, seed=0, s=1.0, tiers=4):
    """Stacked-tier pine: each tier a drooping cone with a scalloped rim, lit on top, dark underneath."""
    rnd = random.Random(seed)
    tr = lathe(name + '_trunk', [(0.3 * s, 0.0), (0.22 * s, 0.5 * s), (0.17 * s, 1.5 * s)], axis='Z', segs=8, mat=M['Bark'])
    tr.data.shade_smooth(); _set_col(tr, [ramp(BARK, 0.4)] * len(tr.data.vertices))
    parts = [tr]; top = (0.9 + (tiers - 1) * 1.05 + 1.3) * s
    for i in range(tiers):
        f = i / max(tiers - 1, 1); R = (1.8 - 1.05 * f) * s; H = (1.9 - 0.55 * f) * s; base = (0.9 + i * 1.05) * s
        prof = [(0.0, base + H), (R * 0.3, base + H * 0.76), (R * 0.72, base + H * 0.3), (R, base),
                (R * 0.6, base + 0.14 * s), (0.0, base + 0.3 * s)]
        t = lathe(f'{name}_t{i}', prof, axis='Z', segs=18, mat=M['Leaf'])
        lobes = 9; ph = rnd.uniform(0, 6.28); cols = []
        for v in t.data.vertices:
            a = math.atan2(v.co.y, v.co.x); rr = math.hypot(v.co.x, v.co.y)
            if rr > R * 0.5:
                k = 1 + 0.13 * math.cos(lobes * a + ph) * (rr / R)
                v.co.x *= k; v.co.y *= k
                v.co.z -= 0.12 * s * (rr / R) * (0.5 + 0.5 * math.cos(lobes * a + ph))
        t.data.shade_smooth()
        for v in t.data.vertices:
            tier_t = (v.co.z - base) / H
            cols.append(ramp(PINE, 0.2 + 0.35 * (v.co.z / top) + 0.5 * tier_t + 0.15 * max(0.0, v.normal.z) - (0.35 if v.normal.z < -0.3 else 0.0)))
        _set_col(t, cols)
        parts.append(t)
    ob = merge(name, parts); ob['arc_outline'] = 0.04
    return ob

def sapling(name, M, seed=0, s=1.0):
    h = 1.7 * s
    tr = trunk(name + '_trunk', h, 0.2 * s, M['Bark'], seed, roots=4, lean=0.08, segs=8)
    paint_bark(tr, h, seed)
    c = Vector((0.1 * s, 0.0, 2.45 * s))
    crown = merge(name + '_crown', [puff(name + '_c0', 1.1 * s, M['Leaf'], 3, 9, center=c, seed=seed * 7),
                                    puff(name + '_c1', 0.7 * s, M['Leaf'], 3, 6, center=c + Vector((0.55, -0.3, 0.45)) * s, seed=seed * 7 + 1)])
    soften(crown, c); paint_foliage(crown, LEAF, 1.5 * s, 3.4 * s)
    ob = merge(name, [tr, crown]); ob['arc_outline'] = 0.035
    return ob

def bush(name, M, r=0.6, seed=0, flowers=None):
    """Cushioned shrub; flowers=(material, count) adds blossom dots on its upper half."""
    rnd = random.Random(seed)
    b = puff(name, r, M['Leaf'], 3, 8, depth=0.18, flat=-0.3, squash=(1.0, 0.95, 0.72), center=(0, 0, r * 0.45), seed=seed)
    soften(b, (0, 0, 0.2 * r), 0.35); paint_foliage(b, LEAF, 0.0, r * 1.2, up=0.25)
    parts = [b]
    if flowers:
        mat, n = flowers
        for i in range(n):
            a = rnd.uniform(0, 2 * math.pi); el = rnd.uniform(0.35, 1.1)
            p = Vector((math.cos(a) * math.cos(el) * r, math.sin(a) * math.cos(el) * r * 0.95, r * 0.45 + math.sin(el) * r * 0.72))
            f = blob(f'{name}_f{i}', p * 1.02, r * 0.11, mat, subd=1, scale=(1, 1, 0.7), jitter=0.0)
            _set_col(f, [(1.0, 1.0, 1.0)] * len(f.data.vertices)); parts.append(f)
    ob = merge(name, parts); ob['arc_outline'] = 0.03
    return ob

# ---------------------------------------------------------------- ground dressing

def tuft(name, M, seed=0, blades=6, h=0.45):
    """Grass tuft: tapered, bent three-sided blades, dark at the root and bright at the tips."""
    rnd = random.Random(seed); bm = bmesh.new(); tz = []
    for k in range(blades):
        a = 2 * math.pi * k / blades + rnd.uniform(-0.35, 0.35); hh = h * rnd.uniform(0.55, 1.0); bend = rnd.uniform(0.2, 0.55)
        d = Vector((math.cos(a), math.sin(a), 0.0)); sd = Vector((-d.y, d.x, 0.0)); base = d * rnd.uniform(0.0, 0.07)
        ring = lambda c, w: [bm.verts.new(c + sd * w), bm.verts.new(c - sd * w), bm.verts.new(c - d * w * 0.8)]
        r0 = ring(base, 0.05); r1 = ring(base + d * hh * bend * 0.35 + Vector((0, 0, hh * 0.55)), 0.032)
        tip = bm.verts.new(base + d * hh * bend + Vector((0, 0, hh)))
        for j in range(3):
            bm.faces.new((r0[j], r0[(j + 1) % 3], r1[(j + 1) % 3], r1[j])); bm.faces.new((r1[j], r1[(j + 1) % 3], tip))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = new_obj(name, bm, M['Leaf']); ob.data.shade_smooth()
    _set_col(ob, [ramp(GRASS, 0.1 + 0.95 * v.co.z / h) for v in ob.data.vertices])
    return ob

def pebble(name, M, size, seed=0):
    ob = blob(name, (0, 0, size[2] * 0.3), 1.0, M['Stone'], subd=1, scale=size, jitter=0.12, seed=seed)
    return ob

def scatter(src_fn, name, spots, seed=0, scale=(0.8, 1.2)):
    """Instance-bake src_fn(i) meshes at (x, y) spots with random yaw/scale, merged into one object."""
    rnd = random.Random(seed); parts = []
    for i, (x, y) in enumerate(spots):
        o = src_fn(i); k = rnd.uniform(*scale)
        xform(o, scale=(k, k, k), rot=[('Z', rnd.uniform(0, 2 * math.pi))], loc=(x, y, 0.0))
        parts.append(o)
    return merge(name, parts)

def cluster_spots(centres, seed=0, avoid=None):
    """centres: [(x, y, count, radius)] -> jittered spots, dropping any that avoid(x, y) rejects."""
    rnd = random.Random(seed); out = []
    for cx, cy, n, r in centres:
        for _ in range(n):
            a = rnd.uniform(0, 2 * math.pi); d = r * math.sqrt(rnd.random())
            x, y = cx + math.cos(a) * d, cy + math.sin(a) * d
            if not (avoid and avoid(x, y)): out.append((x, y))
    return out

# ---------------------------------------------------------------- ground

def grass_tile(name, M, radius, spacing=0.45, center=(0, 0), rim=1.0, drop=0.35, tile=3.0, seed=0):
    """Round lawn tile on a jittered grid (dense enough for painted patches and contact shading),
    dipping below the surroundings at the rim; UVs are world-space so the grass texture tiles
    seamlessly across neighbouring tiles."""
    rnd = random.Random(seed); bm = bmesh.new(); vs = {}
    n = int(2 * radius / spacing) + 2; cx, cy = center
    for i in range(n + 1):
        for j in range(n + 1):
            x = -radius - spacing + i * spacing; y = -radius - spacing + j * spacing
            if math.hypot(x, y) > radius + spacing * 1.2: continue
            jx, jy = (rnd.uniform(-0.2, 0.2) * spacing, rnd.uniform(-0.2, 0.2) * spacing)
            d = math.hypot(x + jx, y + jy); t = min(1.0, max(0.0, (d - (radius - rim)) / rim))
            vs[(i, j)] = bm.verts.new((x + jx, y + jy, -drop * t * t * (3 - 2 * t)))
    for i in range(n):
        for j in range(n):
            q = [vs.get(k) for k in ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))]
            if all(q): bm.faces.new(q)
    uv = bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        for l in f.loops: l[uv].uv = ((l.vert.co.x + cx) / tile, (l.vert.co.y + cy) / tile)
    ob = new_obj(name, bm, M['Grass']); ob.data.shade_smooth(); ob.location = (cx, cy, 0.0)
    return ob

def meadow(name, M, radius=180.0, segs=72, tile=3.0, z=-0.06):
    """Look-dev backdrop lawn: fine rings near the set, coarse toward the horizon (haze hides it)."""
    rings = [0, 3, 6, 9, 12, 15, 18, 21, 24, 28, 32, 37, 43, 50, 60, 75, 95, 120, 150, radius]
    bm = bmesh.new(); prev = None
    for r in rings:
        ring = [bm.verts.new((math.cos(2 * math.pi * k / segs) * r, math.sin(2 * math.pi * k / segs) * r, z)) for k in range(segs)] if r else [bm.verts.new((0, 0, z))]
        if prev is not None:
            for k in range(segs):
                if len(prev) == 1: bm.faces.new((prev[0], ring[k], ring[(k + 1) % segs]))
                else: bm.faces.new((prev[k], ring[k], ring[(k + 1) % segs], prev[(k + 1) % segs]))
        prev = ring
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    uv = bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        for l in f.loops: l[uv].uv = (l.vert.co.x / tile, l.vert.co.y / tile)
    ob = new_obj(name, bm, M['Grass']); ob.data.shade_smooth()
    if ob.data.polygons[0].normal.z < 0: ob.data.flip_normals()
    return ob

def hill(name, M, loc, R, h, segs=28, tile=3.0):
    ob = lathe(name, [(0.0, h), (R * 0.35, h * 0.88), (R * 0.7, h * 0.45), (R, 0.0), (R * 1.02, -1.0)], axis='Z', segs=segs, mat=M['Grass'])
    ob.data.shade_smooth(); xform(ob, loc=loc)
    me = ob.data; uv = me.uv_layers.new(name='UVMap')
    for l in me.loops:
        co = me.vertices[l.vertex_index].co; uv.data[l.index].uv = (co.x / tile, co.y / tile)
    return ob

def grass_color(w):
    big = mnoise.noise(Vector((w.x * 0.085, w.y * 0.085, 0.3)))
    mid = mnoise.noise(Vector((w.x * 0.3, w.y * 0.3, 1.7)))
    return 0.55 + 0.36 * big + 0.3 * mid

def paint_ground(objs, contacts=(), worn=(), far=60.0, low=-0.02, tone=None):
    """Painted lawn: broad lush/deep patches, darker contact shading where things touch the ground,
    drier grass along worn edges (paths), fading toward a calmer mid-tone with distance. Ground below `low`
    (the look-dev lawn's sunken rim) is a shade darker; relief passes a low that never triggers, and a `tone`
    (world position -> ramp offset) that paints its rises sunnier and its hollows deeper, as the engine's overlay does."""
    bpy.context.view_layer.update()
    kc = kt = None
    if contacts:
        kc = kdtree.KDTree(len(contacts))
        for i, p in enumerate(contacts): kc.insert(Vector((p[0], p[1], 0.0)), i)
        kc.balance()
    if worn:
        kt = kdtree.KDTree(len(worn))
        for i, p in enumerate(worn): kt.insert(Vector((p[0], p[1], 0.0)), i)
        kt.balance()
    for o in objs:
        mw = o.matrix_world; cols = []
        for v in o.data.vertices:
            w = mw @ v.co; flat = Vector((w.x, w.y, 0.0))
            t = grass_color(w)
            if kt: t += 0.22 * math.exp(-(kt.find(flat)[2] / 0.9) ** 2)
            dist = flat.length; t = t + (0.55 - t) * min(1.0, dist / far) * 0.5
            if tone: t += tone(w)
            c = ramp(GRASS, t)
            if kc:
                d = kc.find(flat)[2]; ao = 1 - 0.42 * math.exp(-(d / 0.55) ** 2)
                c = tuple(x * ao for x in c)
            if w.z < low: c = tuple(x * 0.85 for x in c)
            cols.append(c)
        _set_col(o, cols)

def contact_points(objs, below=0.35, step=1):
    """World XY of every vertex within `below` metres of the ground: where contact shading goes."""
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get(); pts = []
    for o in objs:
        if o.type != 'MESH': continue
        ev = o.evaluated_get(dg); me = ev.to_mesh(); mw = o.matrix_world
        for v in me.vertices[::step]:
            w = mw @ v.co
            if w.z < below: pts.append((w.x, w.y))
        ev.to_mesh_clear()
    return pts
