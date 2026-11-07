"""Tree preview: generated trees (src/world/treeGrammar.js, ported in tree_grammar.py) meshed in Blender the way
render/TreeAssembler.js meshes them in the engine: a tapered tube per skeleton segment with lobed roots at the
trunk foot and the bark ramp baked as vertex colour, plus canopy parts copied from the TRE_Parts library at their
sockets, coloured with the plan's palette. Used by the species sheet, the catalog card and the village preview.

exec after tree_grammar.py and tree_parts.py (same globals):
    g['assemble_tree'](plan, name, coll, at, yaw, scale, lite)   the tree's objects (bark + one per canopy slot)
    g['sheet_trees']()                                             a species sheet on the review set, then render_review
    g['review_trees']()                                            assets/v2/arcade/arcade-trees-review.png (one light render)
    g['cards_trees']()                                             assets/v2/arcade/catalog/tree.png
"""
import bpy, bmesh, math, json
from mathutils import Vector, Matrix

TREE_COLL = 'ARC_Trees'
TREE_REVIEW = OUT + '/arcade/arcade-trees-review.png'
TREE_SIDES, TREE_SIDES_LITE = 8, 6


def tree_rules(pack=None):
    return json.load(open(pack or (globals().get('REPO', ROOT) + '/packs/arcade/pack.json')))['trees']


def tree_slot_mat(slot, hexs):
    name = f'TREP_{slot}_{hexs}'
    m = bpy.data.materials.get(name)
    if m: return m
    return toon(name, hexs, **TSLOT_TOON.get(slot, {}))


def _bark_mult(t):
    c = ramp(BARK, t); top = hexlin(BARK[-1])
    return tuple(min(1.0, c[i] / max(top[i], 1e-6)) for i in range(3))


def mesh_skeleton(plan, name, coll, lite=False):
    """The plan's segments as tubes, one object, smooth-shaded, bark ramp in 'Col' (TreeAssembler.meshSkeleton's twin)."""
    n = TREE_SIDES_LITE if lite else TREE_SIDES; segs = plan['segments']; has_child = set(g['i'] for g in segs)
    seed = len(segs) * 7 + len(plan['sockets']); top = max(plan['top'], 1e-3)
    bm = bmesh.new(); cols = []
    for si, g in enumerate(segs):
        a = Vector(g['a']); b = Vector(g['b']); d = (b - a).normalized()
        u = d.cross(Vector((0, 0, 1))).normalized() if abs(d.z) < 0.99 else Vector((1, 0, 0)); v = d.cross(u)
        style = plan.get('bark')
        root = g['i'] < 0 and not lite and style != 'ribs'
        if root:
            lobes = 0.5 if style is None else 0.25
            rings = [(a - Vector((0, 0, 0.06)), g['r0'] * (1.5 if style is None else 1.3), lobes), (a + d * 0.14, g['r0'] * 1.14, lobes * 0.44), (a + d * 0.36, g['r0'] * 1.02, 0.04), (b, g['r1'], 0.0)]
        elif style == 'rings' and g['d'] == 0:
            # a palm's frond scar at every joint: a proud lip, then the trunk
            rings = [(a, g['r0'] * 1.12, 0.0), (a + d * 0.1, g['r0'] * 0.97, 0.0), (b, g['r1'], 0.0)]
        else:
            rings = [(a - Vector((0, 0, 0.06)) if g['i'] < 0 else a, g['r0'], 0.0), (b, g['r1'], 0.0)]
        ids = []
        for ri, (c, r, lobe) in enumerate(rings):
            ring = []
            for k in range(n):
                ang = 2 * math.pi * k / n; rad = u * math.cos(ang) + v * math.sin(ang)
                flare = 1 + lobe * max(0.0, math.cos(5 * ang + seed)) ** 2
                p = c + rad * r * flare
                if style == 'ribs': m = 0.78 + 0.22 * (0.5 + 0.5 * math.cos(math.pi * k)); col = (m, m, m)
                elif style == 'rings': m = 0.62 if ri == 0 and len(rings) == 3 else 0.84 + 0.16 * (0.5 + 0.5 * math.cos(4 * ang + si * 1.7)); col = (m, m * 0.97, m * 0.94)
                else:
                    h = min(1.0, p.z / max(0.35 * top, 1e-3)); streak = 0.5 + 0.5 * math.cos(4 * ang + si * 1.7)
                    t = 0.35 + 0.45 * h + 0.25 * streak - 0.3 * max(0.0, (p.z - 0.75 * top) / (0.25 * top)) - 0.08 * g['d']
                    col = _bark_mult(t)
                ring.append(bm.verts.new(p)); cols.append(col)
            ids.append(ring)
        for r in range(len(ids) - 1):
            for k in range(n):
                k1 = (k + 1) % n
                bm.faces.new((ids[r][k], ids[r][k1], ids[r + 1][k1], ids[r + 1][k]))
        if si not in has_child:
            c = bm.verts.new(b); cols.append(_bark_mult(0.25)); last = ids[-1]
            for k in range(n): bm.faces.new((last[k], last[(k + 1) % n], c))
    bm.normal_update()
    for f in bm.faces: f.smooth = True
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); coll.objects.link(ob)
    ob.data.materials.append(tree_slot_mat('Bark', tree_slot_color(plan, 'Bark')))
    _set_col(ob, cols)
    return ob


def place_canopy(plan, name, coll, lite=False):
    """The plan's sockets as copies of the library parts (one object each, the plan's colours on their slots)."""
    LIB = bpy.data.collections[globals().get('TREE_LIB_COLL') or PARTS_COLL_T]; out = []
    for i, q in enumerate(plan['sockets']):
        pid = q['part'] + '.lite' if lite and (q['part'] + '.lite') in LIB.objects else q['part']
        src = LIB.objects.get(pid)
        if not src: continue
        c = src.copy(); c.data = src.data.copy(); coll.objects.link(c); c.name = f'{name}.c{i}'
        c.matrix_world = Matrix.Translation(q['p']) @ Matrix.Rotation(2 * math.pi * q['k'] / 64, 4, 'Z') @ Matrix.Diagonal((q['s'], q['s'], q['s'], 1))
        for k, m in enumerate(c.data.materials):
            slot = m.name[4:] if m.name.startswith('TRE_') else 'Leaf'
            c.data.materials[k] = tree_slot_mat(slot, tree_slot_color(plan, slot))
        out.append(c)
    return out


def assemble_tree(plan, name, coll, at=(0, 0, 0), yaw=0.0, scale=1.0, lite=False):
    """A tree at `at`, turned by yaw about Z and scaled: [bark, canopy...] objects, each carrying the plan's outline."""
    objs = [mesh_skeleton(plan, f'{name}.Bark', coll, lite)] + place_canopy(plan, name, coll, lite)
    M = Matrix.Translation(at) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Diagonal((scale, scale, scale, 1))
    for o in objs:
        o.matrix_world = M @ o.matrix_world; o['arc_outline'] = plan['outline']
    return objs


def _tree_coll():
    C = bpy.data.collections.get(TREE_COLL) or bpy.data.collections.new(TREE_COLL)
    sc = bpy.data.scenes['ARC_Review']
    if C.name not in sc.collection.children: sc.collection.children.link(C)
    for o in list(C.objects):
        me = o.data if o.type == 'MESH' else None
        bpy.data.objects.remove(o, do_unlink=True)
        if me and me.users == 0: bpy.data.meshes.remove(me)
    return C


SIDE = Vector((0.8, 0.6, 0.0)); BACK = Vector((-0.6, 0.8, 0.0))


SHEET_ROWS = ('sapling', 'blossom', 'broadleaf', 'willow', 'conifer')   # short in front, tall at the back


def sheet_trees(species=SHEET_ROWS, keys=('sheet|0', 'sheet|1', 'sheet|2', 'sheet|3'), pack=None, gap=7.0, rows_gap=9.0, lite=False):
    """A species sheet: one row per species (front to back), `keys` trees across, outlined, on the review set."""
    rules = tree_rules(pack); C = _tree_coll(); info = {}
    fams = [s for s in species if s in rules['species']] + [s for s in rules['species'] if s not in species]
    for r, sp in enumerate(fams):
        for i, key in enumerate(keys):
            plan = generate_tree(rules, sp, key)
            at = LINEUP + SIDE * (i - (len(keys) - 1) / 2) * gap + BACK * (r * rows_gap)
            objs = assemble_tree(plan, f'TS_{sp}_{i}', C, at, FACE + 0.3 * i, 1.0, lite)
            for o in objs: outline(o, plan['outline'])
            info[f'{sp}/{key}'] = {'segments': len(plan['segments']), 'sockets': len(plan['sockets']), 'top': plan['top'], 'crown': plan['crown'], 'tris': tris(objs)}
    return info


def review_trees(path=TREE_REVIEW, res=(1400, 800), samples=16, dist=62.0, lens=38, rows=5, rows_gap=9.0):
    """One light render of the sheet from high on the look-dev side, framed on the middle row."""
    sc = bpy.data.scenes['ARC_Review']; keep = sc.camera; C = bpy.data.collections[TREE_COLL]
    cam = bpy.data.objects.get('ARC_TreeCam') or bpy.data.objects.new('ARC_TreeCam', bpy.data.cameras.new('ARC_TreeCam'))
    if cam.name not in C.objects: C.objects.link(cam)
    t = LINEUP + BACK * ((rows - 1) / 2 * rows_gap) + Vector((0, 0, 2.6)); d = Vector((0.5, -0.7, 0.5)).normalized()
    cam.location = t + d * dist; cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = lens; cam.data.clip_start = 0.1; cam.data.clip_end = 1000; sc.camera = cam
    hide = tuple(x for x in ('ARC_Gameplay', 'ARC_Weapons', 'ARC_Critters', 'ARC_Creatures', 'ARC_Houses', 'NAT_Review', 'TRE_Review') if bpy.data.collections.get(x))
    set_look(haze_density=0.002)     # the sheet is read from 60 m: a whisper of haze, so the back rows stay legible
    try: return render_review(path, res, samples, hide=hide)
    finally: sc.camera = keep; set_look()


def cards_trees(pack=None, out=OUT + '/arcade/catalog'):
    """The catalog card 'tree': a broadleaf, a conifer and a blossom tree together, the dressing entry's face."""
    rules = tree_rules(pack); C = _tree_coll(); names = []
    for i, (sp, key, dx) in enumerate((('broadleaf', 'card', 0.0), ('conifer', 'card', -4.2), ('blossom', 'card', 3.6))):
        plan = generate_tree(rules, sp, key)
        objs = assemble_tree(plan, f'CARD_tree_{sp}', C, LINEUP + Vector((60, 0, 0)) + SIDE * dx + BACK * (2.0 if i else 0.0), FACE)
        names += [o.name for o in objs]
    try: return thumbnails(out=out, thumbs={'tree': (names, True)})
    finally: _tree_coll()
