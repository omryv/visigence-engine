"""Arcade tree parts library: the canopy clumps the tree grammar (src/world/treeGrammar.js) hangs on its
code-built trunks and branches: leaf cushions in three sizes and a tuft, conifer tiers and a spire, blossom puffs,
willow fronds and a willow crown. Every part has a `.lite` twin at a fraction of the triangles for phones.

exec after vg.py, kit.py and nature.py (same globals):
    g['build_tree_parts']()   every part into the TRE_Parts collection (hidden; the preview copies from it)
    g['review_trees_parts']() one light review render of the parts in a row (assets/v2/arcade/arcade-tree-parts-review.png)
    g['ship_tree_parts']()    assets/v2/arcade/arcade-tree-parts.glb + src/world/treeParts.js (the index)

Contract with the engine (render/TreeAssembler.js) and the preview (tree_preview.py):
  - One top-level glTF node per part, named by its id ('leaf.clump.a'; GLTFLoader keeps it in userData.name).
    Parts are authored at game scale with their SOCKET on the origin (a clump's centre, the top of a tier or a
    frond), +Y up in glTF; the tree's outline width comes from the plan, not the part.
  - Materials are colour SLOTS named TRE_<Slot> (Leaf, Blossom), white x the 'Col' gradient. The gradient is a
    MULTIPLIER ramp (the kit's foliage tone ramp divided by its sunlit stop), so the plan's palette colour is the
    clump's sunlit tone and the ramp only ever darkens toward the creases and the underside.
"""
import bpy, bmesh, math, random, json
from mathutils import Vector, Matrix

PARTS_COLL_T = 'TRE_Parts'
PARTS_GLB_T = OUT + '/arcade/arcade-tree-parts.glb'
PARTS_INDEX_T = globals().get('REPO', ROOT) + '/src/world/treeParts.js'
TREE_PARTS_REVIEW = OUT + '/arcade/arcade-tree-parts-review.png'
TSLOT_TOON = {'Leaf': {'shade': '#9bb6cc'}, 'Blossom': {'shade': '#cfa9c9'}, 'Bark': {}}
# sRGB tone ramps, dark -> light; the last stop is the sunlit tone the palette supplies
BLOSSOM = ('#b8506f', '#e87a9c', '#ffb0c6', '#ffd0de')
WILLOW = ('#4d7a2f', '#7aa73a', '#a8cc5a', '#cfe98c')
TPARTS, TPART_ORDER = {}, []


def tpart(pid):
    def reg(fn):
        TPARTS[pid] = fn; TPART_ORDER.append(pid); return fn
    return reg


def tm(slot):
    """The white TRE_<slot> material (toon in Blender, palette x gradient in the GLB)."""
    name = 'TRE_' + slot
    m = bpy.data.materials.get(name)
    if m: return m
    return toon(name, '#ffffff', **TSLOT_TOON.get(slot, {}))


def mult_ramp(stops, t):
    """The tone ramp as a multiplier of its sunlit (last) stop, in linear RGB."""
    c = ramp(stops, t); top = hexlin(stops[-1])
    return tuple(min(1.0, c[i] / max(top[i], 1e-6)) for i in range(3))


def paint_mult(ob, stops, lo, hi, up=0.2):
    """paint_foliage's cushion shading, as a multiplier ramp: lit cushion tops, dark creases and underside."""
    import numpy as np
    me = ob.data; n = len(me.vertices)
    b = np.ones(n, np.float32)
    if 'arc_bump' in me.attributes: me.attributes['arc_bump'].data.foreach_get('value', b)
    cols = []
    for i, v in enumerate(me.vertices):
        h = (v.co.z - lo) / max(hi - lo, 1e-6)
        cols.append(mult_ramp(stops, 0.42 * h + 0.52 * float(b[i]) ** 1.4 + up * max(0.0, v.normal.z) - 0.16))
    _set_col(ob, cols)


def decimate(ob, ratio):
    """Collapse the mesh to `ratio` of its faces through an evaluated copy (organic blobs keep their silhouette
    and their point attributes)."""
    if ratio >= 1: return ob
    m = ob.modifiers.new('TRE_Dec', 'DECIMATE'); m.ratio = ratio; m.use_collapse_triangulate = True
    dg = bpy.context.evaluated_depsgraph_get(); ev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    old = ob.data; ob.modifiers.remove(m); ob.data = me; me.name = old.name + '_dec'
    if old.users == 0: bpy.data.meshes.remove(old)
    ob.data.shade_smooth()
    return ob


def clump(pid, r, stops, slot, subd, cells, depth, lite, squash=(1, 1, 0.88), flat=-0.5, seed=1, soft=0.35):
    """A foliage cushion with its centre on the origin; lite twins are the bare 80-face icosphere."""
    ob = puff(pid, r, tm(slot), subd=2 if lite else subd, cells=max(5, cells // 2) if lite else cells, depth=depth, squash=squash, flat=flat, seed=seed)
    if not lite: decimate(ob, 0.62)
    soften(ob, (0, 0, -0.15 * r), soft)
    lo = min(v.co.z for v in ob.data.vertices); hi = max(v.co.z for v in ob.data.vertices)
    paint_mult(ob, stops, lo, hi)
    return ob


def tfinish(pid, ob):
    ensure_grad([ob]); ob.name = pid; ob.data.name = pid
    return ob

# ---------------------------------------------------------------- broadleaf and sapling cushions

def _leaf(pid, r, cells, lite, seed, squash=(1, 1, 0.88)):
    return tfinish(pid, clump(pid, r, LEAF, 'Leaf', 3, cells, 0.17, lite, squash=squash, seed=seed))


@tpart('leaf.clump.a')
def _a(): return _leaf('leaf.clump.a', 1.05, 14, False, 11)
@tpart('leaf.clump.a.lite')
def _al(): return _leaf('leaf.clump.a.lite', 1.05, 14, True, 11)
@tpart('leaf.clump.b')
def _b(): return _leaf('leaf.clump.b', 0.9, 11, False, 12, squash=(1.15, 0.9, 0.85))
@tpart('leaf.clump.b.lite')
def _bl(): return _leaf('leaf.clump.b.lite', 0.9, 11, True, 12, squash=(1.15, 0.9, 0.85))
@tpart('leaf.clump.c')
def _c(): return _leaf('leaf.clump.c', 0.7, 9, False, 13)
@tpart('leaf.clump.c.lite')
def _cl(): return _leaf('leaf.clump.c.lite', 0.7, 9, True, 13)
@tpart('leaf.tuft')
def _t(): return _leaf('leaf.tuft', 0.5, 7, False, 14, squash=(1, 1, 0.9))
@tpart('leaf.tuft.lite')
def _tl(): return _leaf('leaf.tuft.lite', 0.5, 7, True, 14, squash=(1, 1, 0.9))

# ---------------------------------------------------------------- conifer

def _tier(pid, lite, R=1.4, H=1.4):
    """A drooping conical tier hanging from its socket at the trunk, scalloped rim, lit top, dark underside."""
    segs = 10 if lite else 18; rnd = random.Random(21)
    top = 0.15; base = top - H
    prof = [(0.0, top), (R * 0.3, base + H * 0.76), (R * 0.72, base + H * 0.3), (R, base), (R * 0.6, base + 0.14), (0.0, base + 0.3)]
    t = lathe(pid, prof, axis='Z', segs=segs, mat=tm('Leaf'))
    lobes = 5 if lite else 9; ph = rnd.uniform(0, 6.28)
    for v in t.data.vertices:
        a = math.atan2(v.co.y, v.co.x); rr = math.hypot(v.co.x, v.co.y)
        if rr > R * 0.5:
            k = 1 + 0.13 * math.cos(lobes * a + ph) * (rr / R)
            v.co.x *= k; v.co.y *= k
            v.co.z -= 0.12 * (rr / R) * (0.5 + 0.5 * math.cos(lobes * a + ph))
    t.data.shade_smooth(); cols = []
    for v in t.data.vertices:
        tier_t = (v.co.z - base) / H
        cols.append(mult_ramp(PINE, 0.35 + 0.5 * tier_t + 0.15 * max(0.0, v.normal.z) - (0.35 if v.normal.z < -0.3 else 0.0)))
    _set_col(t, cols)
    return tfinish(pid, t)


@tpart('pine.tier')
def _pt(): return _tier('pine.tier', False)
@tpart('pine.tier.lite')
def _ptl(): return _tier('pine.tier.lite', True)


def _spire(pid, lite):
    segs = 8 if lite else 12; rnd = random.Random(22)
    prof = [(0.0, 1.3), (0.22, 0.85), (0.42, 0.35), (0.55, -0.2), (0.32, -0.08), (0.0, 0.0)]
    t = lathe(pid, prof, axis='Z', segs=segs, mat=tm('Leaf'))
    ph = rnd.uniform(0, 6.28)
    for v in t.data.vertices:
        a = math.atan2(v.co.y, v.co.x); rr = math.hypot(v.co.x, v.co.y)
        if rr > 0.3:
            k = 1 + 0.12 * math.cos(5 * a + ph); v.co.x *= k; v.co.y *= k; v.co.z -= 0.08 * (0.5 + 0.5 * math.cos(5 * a + ph))
    t.data.shade_smooth()
    _set_col(t, [mult_ramp(PINE, 0.45 + 0.5 * (v.co.z + 0.2) / 1.5 + 0.15 * max(0.0, v.normal.z) - (0.35 if v.normal.z < -0.3 else 0.0)) for v in t.data.vertices])
    return tfinish(pid, t)


@tpart('pine.top')
def _pp(): return _spire('pine.top', False)
@tpart('pine.top.lite')
def _ppl(): return _spire('pine.top.lite', True)

# ---------------------------------------------------------------- blossom

def _blossom(pid, r, cells, lite, seed):
    return tfinish(pid, clump(pid, r, BLOSSOM, 'Blossom', 3, cells, 0.2, lite, squash=(1, 1, 0.85), seed=seed))


@tpart('blossom.clump.a')
def _ba(): return _blossom('blossom.clump.a', 1.0, 15, False, 31)
@tpart('blossom.clump.a.lite')
def _bal(): return _blossom('blossom.clump.a.lite', 1.0, 15, True, 31)
@tpart('blossom.clump.b')
def _bb(): return _blossom('blossom.clump.b', 0.8, 12, False, 32)
@tpart('blossom.clump.b.lite')
def _bbl(): return _blossom('blossom.clump.b.lite', 0.8, 12, True, 32)

# ---------------------------------------------------------------- willow

def _frond(pid, lite, R=0.75, D=2.2, seed=41):
    """A curtain of leaves hanging from its socket: widest a third of the way down, scalloped at the hem."""
    segs = 8 if lite else 12; rnd = random.Random(seed)
    prof = [(0.12, 0.25), (R * 0.6, 0.08), (R * 0.95, -0.35 * D / 2.2), (R, -0.6 * D / 2.2), (R * 0.82, -0.85 * D / 2.2), (R * 0.5, -D), (0.0, -D * 0.94)]
    if lite: prof = [prof[0], prof[1], prof[3], prof[5], prof[6]]
    f = lathe(pid, prof, axis='Z', segs=segs, mat=tm('Leaf'))
    lobes = 5 if lite else 7; ph = rnd.uniform(0, 6.28)
    for v in f.data.vertices:
        a = math.atan2(v.co.y, v.co.x); rr = math.hypot(v.co.x, v.co.y); down = min(1.0, max(0.0, -v.co.z / D))
        if rr > R * 0.4:
            k = 1 + 0.1 * math.cos(lobes * a + ph); v.co.x *= k; v.co.y *= k
            v.co.z -= 0.16 * down * (0.5 + 0.5 * math.cos(lobes * a + ph))
    f.data.shade_smooth()
    _set_col(f, [mult_ramp(WILLOW, 0.3 + 0.55 * (1 - min(1.0, max(0.0, -v.co.z / D))) + 0.2 * max(0.0, v.normal.z) + 0.12 * (0.5 + 0.5 * math.cos(lobes * math.atan2(v.co.y, v.co.x) + ph))) for v in f.data.vertices])
    return tfinish(pid, f)


@tpart('willow.frond.a')
def _wa(): return _frond('willow.frond.a', False)
@tpart('willow.frond.a.lite')
def _wal(): return _frond('willow.frond.a.lite', True)
@tpart('willow.frond.b')
def _wb(): return _frond('willow.frond.b', False, R=0.6, D=1.7, seed=42)
@tpart('willow.frond.b.lite')
def _wbl(): return _frond('willow.frond.b.lite', True, R=0.6, D=1.7, seed=42)


def _wcrown(pid, lite):
    return tfinish(pid, clump(pid, 1.6, WILLOW, 'Leaf', 3, 16, 0.15, lite, squash=(1, 1, 0.5), flat=-0.6, seed=43, soft=0.5))


@tpart('willow.crown')
def _wc(): return _wcrown('willow.crown', False)
@tpart('willow.crown.lite')
def _wcl(): return _wcrown('willow.crown.lite', True)

# ---------------------------------------------------------------- build, review, ship

def build_tree_parts():
    materials()
    C = bpy.data.collections.get(PARTS_COLL_T) or bpy.data.collections.new(PARTS_COLL_T)
    if C.name not in bpy.data.scenes['Scene'].collection.children: bpy.data.scenes['Scene'].collection.children.link(C)
    # the previous library, and any part left in the scene by an aborted build (it would take the part's name)
    doomed = list(C.objects) + [o for o in bpy.data.objects if o.name not in C.objects and any(o.name == p or o.name.startswith(p + '.0') for p in TPART_ORDER)]
    meshes = [o.data for o in doomed if o.type == 'MESH']
    for o in doomed: bpy.data.objects.remove(o, do_unlink=True)
    for me in meshes:
        if me.users == 0: bpy.data.meshes.remove(me)
    info = {}
    for pid in TPART_ORDER:
        ob = TPARTS[pid]()
        for u in list(ob.users_collection): u.objects.unlink(ob)
        C.objects.link(ob)
        info[pid] = tris([ob])
    C.hide_render = True; C.hide_viewport = True
    return {'parts': len(info), 'tris': sum(info.values()), 'each': info}


def tree_parts_index():
    C = bpy.data.collections[PARTS_COLL_T]; idx = {}
    for pid in TPART_ORDER:
        o = C.objects[pid]; vs = o.data.vertices
        idx[pid] = {'r': round(max(math.hypot(v.co.x, v.co.y) for v in vs), 3), 'top': round(max(v.co.z for v in vs), 3), 'bot': round(min(v.co.z for v in vs), 3), 'tris': tris([o])}
    return idx


def review_tree_parts(path=TREE_PARTS_REVIEW, res=(1400, 700), samples=16, gap=2.4):
    """The full parts in a row (lite twins behind them), one light render on the review set."""
    C = bpy.data.collections[PARTS_COLL_T]; sc = bpy.data.scenes['ARC_Review']; keep = sc.camera
    tmp = bpy.data.collections.get('TRE_Review') or bpy.data.collections.new('TRE_Review')
    if tmp.name not in sc.collection.children: sc.collection.children.link(tmp)
    for o in list(tmp.objects): bpy.data.objects.remove(o, do_unlink=True)
    side = Vector((0.8, 0.6, 0.0)); back = Vector((-0.6, 0.8, 0.0)); full = [p for p in TPART_ORDER if not p.endswith('.lite')]; n = len(full)
    mats = {'Leaf': toon('TREV_Leaf', '#bfe36a', shade='#9bb6cc'), 'Blossom': toon('TREV_Blossom', '#ffd0de', shade='#cfa9c9')}
    for i, pid in enumerate(full):
        for j, name in enumerate((pid, pid + '.lite')):
            c = C.objects[name].copy(); c.data = C.objects[name].data.copy(); tmp.objects.link(c)
            lift = -min(v.co.z for v in c.data.vertices) + 0.05
            c.matrix_world = Matrix.Translation(LINEUP + side * (i - (n - 1) / 2) * gap + back * (j * 3.2) + Vector((0, 0, lift)))
            for k, m in enumerate(c.data.materials): c.data.materials[k] = mats.get(m.name[4:], m)
            outline(c, 0.04)
    cam = bpy.data.objects.get('ARC_TreePartsCam') or bpy.data.objects.new('ARC_TreePartsCam', bpy.data.cameras.new('ARC_TreePartsCam'))
    if cam.name not in tmp.objects: tmp.objects.link(cam)
    t = LINEUP + back * 1.4 + Vector((0, 0, 0.6)); d = Vector((0.6, -0.8, 0.5)).normalized()
    cam.location = t + d * 30; cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = 40; cam.data.clip_start = 0.1; cam.data.clip_end = 1000; sc.camera = cam
    hide = tuple(x for x in ('ARC_Gameplay', 'ARC_Weapons', 'ARC_Critters', 'ARC_Creatures', 'ARC_Houses') if bpy.data.collections.get(x))
    try: return render_review(path, res, samples, hide=hide)
    finally:
        sc.camera = keep
        for o in list(tmp.objects):
            if o.type != 'CAMERA': bpy.data.objects.remove(o, do_unlink=True)


def ship_tree_parts(path=PARTS_GLB_T, index=PARTS_INDEX_T):
    C = bpy.data.collections[PARTS_COLL_T]
    objs = [o for o in C.objects]
    gltf_mode(True)
    try:
        C.hide_viewport = False
        bpy.context.view_layer.update()
        size = export_glb(objs, path)
    finally:
        gltf_mode(False); C.hide_viewport = True
    idx = tree_parts_index()
    with open(index, 'w') as f:
        f.write('// Generated by tools/blender/v2/arcade/tree_parts.py (ship_tree_parts): the tree parts library\n'
                '// index - every canopy part id with its horizontal radius, its extent above and below the socket (metres) and\n'
                '// its triangle count; `.lite` twins are the phone build. The tree rules are validated against it.\n'
                'export const TREE_PARTS = ' + json.dumps(idx, indent=1, sort_keys=True) + ';\n')
    return {'kb': round(size / 1024, 1), 'parts': len(idx), 'tris': tris(objs)}
