"""Blender preview of the house grammar: meshes plans expanded by house_grammar.py (identical to the engine's
src/world/houseGrammar.js) the way render/HouseAssembler.js does, renders a review sheet and the catalog cards.

exec after house_parts.py and house_grammar.py (same globals):
    g['sheet_houses']()      a street of generated houses per family in the review scene
    g['review_houses']()     one light EEVEE render of the sheet
    g['cards_houses']()      256 px catalog cards, one per family

Meshing rules shared with the engine:
  - a prism is a convex polygon in its frame's (u, v) plane extruded along w, with a chamfer of `b` on every
    edge: the polygon's corners are cut, the caps are inset, so the silhouette catches the rim light like the
    kit's chunky bevel; faces are flat, except the sides of a `round` prism (towers), which are smooth;
  - a lathe revolves a closed (r, z) profile in n segments, smooth around the axis, flat along the profile;
  - every piece carries the kit's baked gradient in 'Col', darkening toward the bottom of its `g` range
    (roofs a touch warmer), and is merged with the rest of its colour slot and outline width;
  - parts are copies of the library (house_parts.py) at their placement; a paired socket places the right
    side and its mirror image across the host's X.
"""
import bpy, bmesh, math, json
from mathutils import Vector, Matrix

PARTS_COLL_H = globals().get('PARTS_COLL_H', 'HSE_Parts')
HOUSE_COLL = 'ARC_Houses'
HOUSE_REVIEW = OUT + '/arcade/arcade-houses-review.png'
SLOT_TOON = {'Roof': {'shade': '#bd9ec6'}, 'Glass': {'rim': 0.7}, 'Leaf': {'shade': '#9bb6cc'}}
COOL, WARM = (0.78, 0.76, 0.86), (0.8, 0.76, 0.86)
THIN = 0.35
MX = Matrix.Diagonal((-1, 1, 1, 1))

# ---------------------------------------------------------------- mesher (render/HouseAssembler.js twin)


def _unit2(x, y):
    l = math.hypot(x, y)
    return (x / l, y / l) if l > 1e-12 else (0.0, 0.0)


def _area2(P):
    n = len(P)
    return sum(P[i][0] * P[(i + 1) % n][1] - P[(i + 1) % n][0] * P[i][1] for i in range(n)) / 2


def _chamfer2(P, c):
    """Cut every corner of a convex polygon by c along both edges; an acute corner (under 75 degrees) stays sharp."""
    out, n = [], len(P)
    for i in range(n):
        a, b, d = P[i - 1], P[i], P[(i + 1) % n]
        la, ld = math.hypot(a[0] - b[0], a[1] - b[1]), math.hypot(d[0] - b[0], d[1] - b[1])
        if ((a[0] - b[0]) * (d[0] - b[0]) + (a[1] - b[1]) * (d[1] - b[1])) / (la * ld) > 0.2588: out.append(b); continue
        out.append((b[0] + (a[0] - b[0]) / la * c, b[1] + (a[1] - b[1]) / la * c))
        out.append((b[0] + (d[0] - b[0]) / ld * c, b[1] + (d[1] - b[1]) / ld * c))
    return out


def _inset2(Q, c):
    """Offset a CCW polygon inward by c (mitred corners)."""
    out, n = [], len(Q)
    for j in range(n):
        p, q, r = Q[j - 1], Q[j], Q[(j + 1) % n]
        n1, n2 = _unit2(p[1] - q[1], q[0] - p[0]), _unit2(q[1] - r[1], r[0] - q[0])
        k = c / max(0.2, 1 + n1[0] * n2[0] + n1[1] * n2[1])
        out.append((q[0] + (n1[0] + n2[0]) * k, q[1] + (n1[1] + n2[1]) * k))
    return out


def _grad(z, g, slot):
    lo = WARM if slot == 'Roof' else COOL
    t = min(1.0, max(0.0, (z - g[0]) / max(g[1] - g[0], 1e-6))) ** 0.8
    return tuple(lo[i] + (1 - lo[i]) * t for i in range(3))


def prism_geo(pc):
    """-> (points, faces, smooth flags) in house space."""
    f = pc['f']; o, u, v, w = f[0:3], f[3:6], f[6:9], f[9:12]
    P = [tuple(p) for p in pc['p']]
    if _area2(P) < 0: P = P[::-1]
    # drop repeated points (a triangle given as a degenerate trapezoid)
    P = [p for i, p in enumerate(P) if math.hypot(p[0] - P[i - 1][0], p[1] - P[i - 1][1]) > 1e-6]
    w0, w1 = pc['w']
    edge = min(math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]) for i in range(len(P)))
    c = min(pc['b'], (w1 - w0) * 0.4, edge * 0.3)
    if c > 1e-4:
        # thin pieces (tiles, beams, struts) keep the chamfer round their face and skip it on their short edges
        Q = P if pc['r'] or w1 - w0 < THIN else _chamfer2(P, c)
        I = _inset2(Q, c)
        rings = [(I, w0), (Q, w0 + c), (Q, w1 - c), (I, w1)]
    else:
        rings = [(P, w0), (P, w1)]
    pts, faces, smooth = [], [], []
    for poly, ww in rings:
        for a, b in poly:
            pts.append((o[0] + u[0] * a + v[0] * b + w[0] * ww, o[1] + u[1] * a + v[1] * b + w[1] * ww, o[2] + u[2] * a + v[2] * b + w[2] * ww))
    n = len(rings[0][0])
    flip = (u[1] * v[2] - u[2] * v[1]) * w[0] + (u[2] * v[0] - u[0] * v[2]) * w[1] + (u[0] * v[1] - u[1] * v[0]) * w[2] < 0
    def add(idx, sm):
        faces.append(tuple(reversed(idx)) if flip else tuple(idx)); smooth.append(sm)
    add([k for k in reversed(range(n))], False)
    for r in range(len(rings) - 1):
        side = pc['r'] and len(rings) == 4 and r == 1 or pc['r'] and len(rings) == 2
        for k in range(n):
            a, b = r * n + k, r * n + (k + 1) % n
            add([a, b, b + n, a + n], bool(side))
    add([(len(rings) - 1) * n + k for k in range(n)], False)
    return pts, faces, smooth


def lathe_geo(pc):
    c, prof, n = pc['c'], pc['p'], pc['n']
    area = sum(prof[i][0] * prof[(i + 1) % len(prof)][1] - prof[(i + 1) % len(prof)][0] * prof[i][1] for i in range(len(prof)))
    pts, faces, smooth = [], [], []
    for i in range(len(prof)):
        (r0, z0), (r1, z1) = prof[i], prof[(i + 1) % len(prof)]
        if r0 < 1e-6 and r1 < 1e-6: continue
        nr, nz = (z1 - z0, -(r1 - r0)) if area > 0 else (-(z1 - z0), r1 - r0)   # outward in the (r, z) plane
        base = len(pts)
        for k in range(n + 1):
            a = 2 * math.pi * k / n; ca, sa = math.cos(a), math.sin(a)
            pts.append((c[0] + r0 * ca, c[1] + r0 * sa, z0)); pts.append((c[0] + r1 * ca, c[1] + r1 * sa, z1))
        for k in range(n):
            q = [base + 2 * k, base + 2 * k + 1, base + 2 * k + 3, base + 2 * k + 2]
            A, B, C = (Vector(pts[q[0]]), Vector(pts[q[1]]), Vector(pts[q[2]]))
            if (B - A).cross(C - A).length < 1e-9: A, B, C = Vector(pts[q[0]]), Vector(pts[q[2]]), Vector(pts[q[3]])
            geo = (B - A).cross(C - A); am = 2 * math.pi * (k + 0.5) / n
            want = Vector((nr * math.cos(am), nr * math.sin(am), nz))
            faces.append(tuple(q) if geo.dot(want) >= 0 else tuple(reversed(q))); smooth.append(True)
    return pts, faces, smooth


def _object(name, groups, coll):
    """groups: [(points, faces, smooth, colours)] merged into one mesh object; 'Col' is a point attribute."""
    bm = bmesh.new(); buf = []
    for pts, faces, smooth, cols in groups:
        vs = [bm.verts.new(p) for p in pts]
        for c in cols: buf += (*c, 1.0)
        for fi, sm in zip(faces, smooth):
            try: bm.faces.new([vs[i] for i in fi]).smooth = sm
            except ValueError: pass
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); coll.objects.link(ob)
    a = me.color_attributes.new(GRAD, 'FLOAT_COLOR', 'POINT'); a.data.foreach_set('color', buf)
    me.color_attributes.active_color_name = GRAD; me.color_attributes.default_color_name = GRAD
    return ob


def slot_mat(slot, hexs):
    name = f'HSEP_{slot}_{hexs}'
    m = bpy.data.materials.get(name)
    if m: return m
    if slot == 'Glow': return glow(name, hexs)
    return toon(name, hexs, **SLOT_TOON.get(slot, {}))


def mesh_pieces(plan, built, name, coll):
    """Pieces -> one object per (slot, outline width), toon-shaded with the plan's colours, outlined."""
    groups = {}
    for pc in built['pieces']:
        pts, faces, smooth = prism_geo(pc) if pc['k'] == 'prism' else lathe_geo(pc)
        cols = [_grad(p[2], pc['g'], pc['s']) for p in pts]
        groups.setdefault((pc['s'], pc['o']), []).append((pts, faces, smooth, cols))
    out = []
    for (slot, width), gs in groups.items():
        ob = _object(f'{name}.{slot}.{width}', gs, coll)
        ob.data.materials.append(slot_mat(slot, house_slot_color(plan, slot)))
        ob['arc_outline'] = width
        out.append(ob)
    return out

# ---------------------------------------------------------------- parts


def _socket(part_id, socket):
    e = bpy.data.objects.get(f'{part_id}:{socket}')
    if not e: raise KeyError(f'{part_id} has no socket {socket}')
    return e.matrix_parent_inverse @ e.matrix_basis


def _pmat(m):
    return Matrix(((m[3], m[6], m[9], m[0]), (m[4], m[7], m[10], m[1]), (m[5], m[8], m[11], m[2]), (0, 0, 0, 1)))


def place_parts(plan, built, name, coll, lib_coll=None):
    lib = bpy.data.collections.get(lib_coll or PARTS_COLL_H)
    placed, out = [], []
    for p in built['parts']:
        if 'm' in p: mats = [_pmat(p['m'])]
        else:
            host_id, host_m = placed[p['on']]
            if not (lib and lib.objects.get(host_id)): placed.append((p['id'], host_m)); continue   # blockout: no library yet
            S = _socket(host_id, p['socket'])
            mats = [host_m @ S] + ([host_m @ MX @ S] if p['pair'] else [])
        placed.append((p['id'], mats[0]))
        src = lib.objects.get(p['id']) if lib else None
        for i, mw in enumerate(mats):
            if src is None:
                # blockout stand-in: a flat panel where the part goes
                w, h = (1.3, 2.05) if p['id'].startswith('door') else (1.2, 1.35) if p['id'].startswith(('win', 'dormer')) else (0.4, 0.4)
                bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
                bmesh.ops.scale(bm, vec=(w, 0.12, h), verts=bm.verts); bmesh.ops.translate(bm, vec=(0, -0.04, h / 2), verts=bm.verts)
                c = new_obj(f'{name}.{p["id"]}', bm, slot_mat('Accent' if p['id'].startswith('door') else 'Glass', house_slot_color(plan, 'Accent') if p['id'].startswith('door') else plan['colors']['glass']), coll)
                c.matrix_world = mw; c['arc_outline'] = 0.02; ensure_grad([c]); out.append(c)
                continue
            c = src.copy(); c.data = src.data.copy(); coll.objects.link(c)
            for k, m in enumerate(c.data.materials):
                if m and m.name.startswith('HSE_'): c.data.materials[k] = slot_mat(m.name[4:], house_slot_color(plan, m.name[4:]))
            c.name = f'{name}.{p["id"]}'; c.matrix_world = mw; c['arc_outline'] = src.get('arc_outline', 0.02)
            out.append(c)
    return out


def assemble_house(plan, built, name, coll, at=(0, 0, 0), yaw=0.0, lib_coll=None):
    root = bpy.data.objects.new(name, None); coll.objects.link(root)
    obs = mesh_pieces(plan, built, name, coll) + place_parts(plan, built, name, coll, lib_coll)
    for o in obs:
        mw = o.matrix_world.copy(); o.parent = root; o.matrix_parent_inverse = Matrix.Identity(4); o.matrix_basis = mw
        if o.get('arc_outline', 0) > 0: outline(o, o['arc_outline'])
    root.location = at; root.rotation_euler = (0, 0, yaw)
    return root

# ---------------------------------------------------------------- sheet, review, cards


def _house_coll():
    sc = bpy.data.scenes['ARC_Review']
    C = bpy.data.collections.get(HOUSE_COLL) or bpy.data.collections.new(HOUSE_COLL)
    if C.name not in sc.collection.children: sc.collection.children.link(C)
    for o in list(C.objects):
        me = o.data if o.type == 'MESH' else None
        bpy.data.objects.remove(o, do_unlink=True)
        if me and me.users == 0: bpy.data.meshes.remove(me)
    return C


def houses_from_json(path):
    """[{plan, built}] dumped by the engine grammar (for a look before the Python port runs)."""
    return json.load(open(path))


def house_rules(pack=None):
    return json.load(open(pack or (globals().get('REPO', ROOT) + '/packs/arcade/pack.json')))['houses']


def generated(rules, requests):
    """[(family, key)] -> [{plan, built}] from the Python port of the grammar."""
    out = []
    for fam, key in requests:
        plan = generate_house(rules, fam, key)
        out.append({'plan': plan, 'built': build_house(rules, plan)})
    return out


def sheet_houses(families=None, keys=('sheet|0', 'sheet|1'), pack=None, gap=10.5):
    """A street of generated houses: `keys` per family, in family order."""
    rules = house_rules(pack)
    fams = families or list(rules['families'])
    return sheet_from(generated(rules, [(f, k) for f in fams for k in keys]), gap)


def cards_houses(pack=None, out=OUT + '/arcade/catalog'):
    """Catalog cards: 'house' (the dressing entry, a generated cottage) and one per family."""
    rules = house_rules(pack); C = _house_coll(); cards = {}
    picks = [('house', 'cottage', 'card')] + [(f'house-{f}', f, 'card') for f in rules['families']]
    for i, (cid, fam, key) in enumerate(picks):
        e = generated(rules, [(fam, key)])[0]
        root = assemble_house(e['plan'], e['built'], f'CARD_{cid}', C, LINEUP + Vector((60 + i * 14, 0, 0)), FACE)
        names = [o.name for o in root.children if o.type == 'MESH']
        R = Matrix.LocRotScale(root.location, root.rotation_euler.to_quaternion(), root.scale)
        for o in list(root.children):
            mw = R @ o.matrix_basis; o.parent = None; o.matrix_world = mw
        cards[cid] = (names, True)
    try: return thumbnails(out=out, thumbs=cards)
    finally: _house_coll()


STREET = Vector((0.8, 0.6, 0.0))      # the review street runs across the look-dev camera's view


def sheet_from(entries, gap=10.5):
    """Houses side by side along a street, fronts toward the review camera."""
    C = _house_coll(); info = {}
    for i, e in enumerate(entries):
        at = LINEUP + STREET * (i - (len(entries) - 1) / 2) * gap
        assemble_house(e['plan'], e['built'], f'HS_{i}', C, at, FACE)
        info[i] = {'family': e['plan']['family'], 'key': e['plan']['key'], 'pieces': len(e['built']['pieces']), 'parts': len(e['built']['parts'])}
    return info


def village_review(level_json, path=OUT + '/arcade/arcade-village-review.png', res=(1200, 700), samples=16, pack=None):
    """An engine-compiled village (the dressing placements of a level, dumped as [{id, x, z, yaw, plan}]) in its own
    scene: houses rebuilt from their plans at the engine's positions and turns, look-dev trees in the tree slots,
    seen down the centre lane. Engine (x, z) is Blender (x, -y); a turn about engine Y is the same turn about Z."""
    rules = house_rules(pack); main = bpy.data.scenes['Scene']; win = bpy.context.window
    sc = bpy.data.scenes.get('ARC_Village') or bpy.data.scenes.new('ARC_Village'); sc.world = main.world
    for o in list(sc.collection.objects): sc.collection.objects.unlink(o)   # unlink only: the sun is the look-dev's
    C = bpy.data.collections.get('ARC_VillageSet') or bpy.data.collections.new('ARC_VillageSet')
    if C.name not in sc.collection.children: sc.collection.children.link(C)
    for o in list(C.objects):
        me = o.data if o.type == 'MESH' else None
        bpy.data.objects.remove(o, do_unlink=True)
        if me and me.users == 0: bpy.data.meshes.remove(me)
    sc.collection.objects.link(bpy.data.objects['ARC_Sun'])
    M = _mats(); grass = meadow('ARC_Village_Meadow', M, radius=90.0); put(grass, C)
    paint_ground([grass], [(p['x'], -p['z']) for p in level_json])
    trees = {'oak': 'ARC_Tree', 'pine': 'ARC_Pine_A', 'sapling': 'ARC_Sapling_B'}
    for i, p in enumerate(level_json):
        if p.get('plan'):
            assemble_house(p['plan'], build_house(rules, p['plan']), f'VL_{i}', C, (p['x'], -p['z'], 0), p['yaw'])
        elif p['id'] in trees and bpy.data.objects.get(trees[p['id']]):
            t = bpy.data.objects[trees[p['id']]].copy(); C.objects.link(t); t.location = (p['x'], -p['z'], 0)
    cam = bpy.data.objects.get('ARC_VillageCam') or bpy.data.objects.new('ARC_VillageCam', bpy.data.cameras.new('ARC_VillageCam'))
    if cam.name not in sc.collection.objects: sc.collection.objects.link(cam)
    t = Vector((-2, 4, 2.0)); d = Vector((0.3, 1.0, 0.34)).normalized()
    cam.location = t + d * 34; cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = 30; cam.data.clip_end = 1000; sc.camera = cam
    sc.render.engine = main.render.engine
    for k in ('taa_samples', 'use_raytracing', 'use_fast_gi', 'use_shadows', 'shadow_ray_count', 'shadow_step_count', 'shadow_resolution_scale', 'shadow_pool_size'):
        try: setattr(sc.eevee, k, getattr(main.eevee, k))
        except (AttributeError, TypeError): pass
    sc.eevee.taa_render_samples = samples; sc.view_settings.view_transform = 'Standard'; sc.view_settings.look = 'None'
    sc.render.resolution_x, sc.render.resolution_y = res; sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'PNG'; sc.render.filepath = path
    win.scene = sc
    try: bpy.ops.render.render(write_still=True, scene=sc.name)
    finally: win.scene = main
    return path


def review_houses(path=HOUSE_REVIEW, res=(1200, 700), samples=16, target=None, dist=30.0, lens=35, lift=0.42):
    sc = bpy.data.scenes['ARC_Review']; keep = sc.camera
    cam = bpy.data.objects.get('ARC_HouseCam') or bpy.data.objects.new('ARC_HouseCam', bpy.data.cameras.new('ARC_HouseCam'))
    back = bpy.data.collections['ARC_ReviewSet']
    if cam.name not in back.objects: back.objects.link(cam)
    t = Vector(target) if target else LINEUP + Vector((0, 0, 3.2))
    d = Vector((0.6, -0.8, lift)).normalized()
    cam.location = t + d * dist; cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = lens; cam.data.shift_y = 0.05; cam.data.clip_start = 0.1; cam.data.clip_end = 1000
    sc.camera = cam
    hide = tuple(n for n in ('ARC_Gameplay', 'ARC_Weapons', 'ARC_Critters', 'ARC_Creatures') if bpy.data.collections.get(n))
    try: return render_review(path, res, samples, hide=hide)
    finally: sc.camera = keep
