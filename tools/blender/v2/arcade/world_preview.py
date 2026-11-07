"""Village preview: an engine-compiled Arcade level in Blender, for review renders of the world layout
(src/world/worldGrammar.js). The level is the JSON the engine compiles (spawn, world {lanes, square, spurs,
walks, zones, flowers} and placements with id, x, z, yaw, scale, part, house plans and tree plans), so the render shows
exactly the village the game builds for that seed: houses and trees rebuilt from their plans, rocks, fences and
gameplay props copied to the engine's positions, the nature parts library's flora, and the lanes as sand ribbons
(the engine paints them into the lawn's overlay; here a ribbon stands in). Engine (x, z) is Blender (x, -y); a
turn about engine Y is the same turn about Blender Z.

exec after house_preview.py, nature_parts.py and tree_preview.py (same globals):
    g['build_village'](level_json_path)   the ARC_Village scene from a level dump
    g['render_village_top']()             assets/v2/arcade/arcade-village-top.png (orthographic, straight down)
    g['render_village_street']()          assets/v2/arcade/arcade-village-street.png (eye height at the spawn, down the spine)
"""
import bpy, bmesh, json, math
from mathutils import Vector, Matrix

VILLAGE_TOP = OUT + '/arcade/arcade-village-top.png'
VILLAGE_STREET = OUT + '/arcade/arcade-village-street.png'
LOOKDEV_GROUPS = {   # placement id -> look-dev objects that make up that prop (trees are generated: see tree_preview.py)
    'rocks': ['ARC_Rock_A', 'ARC_Rock_B', 'ARC_Rock_C'],
    'fence': ['ARC_Fence_Section', 'ARC_Fence_Post'], 'barrel': ['ARC_Barrel'], 'crystalShrine': ['ARC_Shrine', 'ARC_Shrine_Crystal'],
    'woodGate': ['ARC_Gate', 'ARC_Gate_DoorL', 'ARC_Gate_DoorR'], 'hayBarricade': ['ARC_Barricade'],
}
_GROUND = {}


def _ground_frame(names):
    """The frame that puts a look-dev group's ground centre on the origin (cached per group)."""
    key = tuple(names)
    if key not in _GROUND:
        objs = [bpy.data.objects[n] for n in names if n in bpy.data.objects]
        lo, hi = bounds(objs)
        _GROUND[key] = Matrix.Translation((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z))
    return _GROUND[key]


def _place_group(names, C, x, z, yaw, scale=1.0, tag='VL'):
    frame = _ground_frame(names); out = []
    M = Matrix.Translation((x, -z, 0)) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Diagonal((scale, scale, scale, 1)) @ frame
    for n in names:
        src = bpy.data.objects.get(n)
        if not src: continue
        c = src.copy(); C.objects.link(c); c.matrix_world = M @ src.matrix_world; c.name = '%s_%s' % (tag, n[4:]); out.append(c)
    return out


def _flat(bx, by): return 0.0


def _ribbon(name, pts, w, M, C, z=0.012, cols=((0.82, 0.76, 0.8), (1, 1, 1)), ground=_flat, smooth_=True):
    """A sand strip along engine (x, z) points, smoothed, darker at its edges (the overlay's worn rim), laid on
    `ground` (Blender x, y -> height) so it follows the relief."""
    S = _catmull([(p[0], -p[1]) for p in pts], 4) if (len(pts) > 2 and smooth_) else [Vector((p[0], -p[1], 0.0)) for p in pts]
    bm = bmesh.new(); rows = []; col = []
    for i, c in enumerate(S):
        d = (S[min(i + 1, len(S) - 1)] - S[max(i - 1, 0)]).normalized(); n = Vector((-d.y, d.x, 0.0))
        at = lambda q, dz: Vector((q.x, q.y, ground(q.x, q.y) + dz))
        rows.append([bm.verts.new(at(c + n * w / 2, z)), bm.verts.new(at(c, z + 0.006)), bm.verts.new(at(c - n * w / 2, z))])
        col += [cols[0], cols[1], cols[0]]
    for a, b in zip(rows, rows[1:]):
        bm.faces.new((a[0], a[1], b[1], b[0])); bm.faces.new((a[1], a[2], b[2], b[1]))
    bm.normal_update(); bm.faces.ensure_lookup_table()
    if bm.faces and bm.faces[0].normal.z < 0: bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    uv = bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        for l in f.loops: l[uv].uv = (l.vert.co.x / 2.0, l.vert.co.y / 2.0)
    ob = new_obj(name, bm, M['Sand'], C); ob.data.shade_smooth(); ob.visible_shadow = False   # paint, not a solid
    it = iter(col); paint([ob], lambda w_, l: next(it))
    return ob


def _disc(name, x, z, r, M, C, zz=0.014, y=0.0):
    ob = lathe(name, [(0.0, zz + 0.006), (r * 0.8, zz + 0.004), (r, zz)], axis='Z', segs=40, mat=M['Sand'], cap=True)
    ob.location = (x, -z, y); put(ob, C)
    vgrad([ob], (0.82, 0.76, 0.8), lo=zz, hi=zz + 0.006)
    return ob

# ---------------------------------------------------------------- relief and water (src/world/worldTerrain.js)

def terrain_height(T):
    """The level's ground as a function of Blender (x, y): the engine's bilinear sampler over the layout's grid."""
    res, size, cell, H = T['res'], T['size'], T['cell'], T['heights']

    def h(bx, by):
        fx = min(max((bx + size / 2) / cell, 0), res - 1.001); fz = min(max((-by + size / 2) / cell, 0), res - 1.001)
        ix = int(fx); iz = int(fz); tx = fx - ix; tz = fz - iz
        a = H[iz * res + ix]; b = H[iz * res + ix + 1]; c = H[(iz + 1) * res + ix]; d = H[(iz + 1) * res + ix + 1]
        return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz
    return h


def _skirt_rise(x, z, half, S):
    out = max(abs(x) - half, abs(z) - half, 0)
    if out <= 0: return 0.0
    t = min(1.0, out / S['out']); t = t * t * (3 - 2 * t)
    return S['rise'] * t * (0.72 + 0.28 * math.sin(x * 0.11 + 1.7) * math.cos(z * 0.09 - 0.4))


def _ground_axis(size, cell, step, S, lite):
    half = size / 2; n = round(size / cell); sc = S['cell'] * 2.5 if lite else S['cell']; ns = max(1, round(S['out'] / sc)); out = []
    for k in range(ns, 0, -1): out.append(-half - k * sc)
    for i in range(0, n + 1, step): out.append(-half + i * cell)
    if n % step: out.append(half)
    for k in range(1, ns + 1): out.append(half + k * sc)
    return out


def terrain_ground(name, T, S, M, C, lite=False, tile=3.0):
    """The engine's ground mesh (render/ArcadeGround.js buildGroundGeometry): the meadow's grid plus the rising skirt,
    the same axis and the same diagonal split, in the kit's painted grass."""
    size, cell, res, H = T['size'], T['cell'], T['res'], T['heights']; half = size / 2
    xs = _ground_axis(size, cell, 2 if lite else 1, S, lite); n = len(xs)

    def height(x, z):
        i = round((min(half, max(-half, x)) + half) / cell); j = round((min(half, max(-half, z)) + half) / cell)
        return H[min(res - 1, max(0, j)) * res + min(res - 1, max(0, i))] + _skirt_rise(x, z, half, S)
    bm = bmesh.new(); V = [[None] * n for _ in range(n)]
    for j in range(n):
        for i in range(n): V[j][i] = bm.verts.new((xs[i], -xs[j], height(xs[i], xs[j])))
    for j in range(n - 1):
        for i in range(n - 1):
            a, b, c, d = V[j][i], V[j][i + 1], V[j + 1][i], V[j + 1][i + 1]
            if abs(a.co.z - d.co.z) < abs(b.co.z - c.co.z): bm.faces.new((a, c, d)); bm.faces.new((a, d, b))
            else: bm.faces.new((a, c, b)); bm.faces.new((b, c, d))
    bm.normal_update()
    for f in bm.faces:
        if f.normal.z < 0: f.normal_flip()
    uv = bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        for l in f.loops: l[uv].uv = (l.vert.co.x / tile, l.vert.co.y / tile)
    ob = new_obj(name, bm, M['Grass'], C); ob.data.shade_smooth()
    return ob


def water_mesh(name, water, C, deep='#4aa6c8', shallow='#86d3dc', overlap=0.3, pool_rim=0.22):
    """The engine's water (render/ArcadeGround.js buildWaterGeometry) in the preview's toon water: ponds as fans
    over their shorelines, the brook as a ribbon on its surface (broken under the bridges), the pool's disc. The
    shallow tone is the material's; the open water darkens toward the deep tone through the 'Col' gradient."""
    D = DIRS64; bm = bmesh.new(); shore = []
    dl = hexlin(deep); sl = hexlin(shallow); ratio = tuple(min(1.0, dl[k] / max(sl[k], 1e-4)) for k in range(3))

    def vert(x, y, z, s):
        v = bm.verts.new((x, -z, y)); shore.append(s); return v
    for p in water.get('ponds', []):
        c = vert(p['x'], p['level'], p['z'], 0.0)
        ring = [vert(p['x'] + D[k][0] * (p['radii'][k] + overlap), p['level'], p['z'] + D[k][1] * (p['radii'][k] + overlap), 1.0) for k in range(64)]
        mid = [vert(p['x'] + D[k][0] * p['radii'][k] * 0.62, p['level'], p['z'] + D[k][1] * p['radii'][k] * 0.62, 0.15) for k in range(64)]
        for k in range(64):
            k1 = (k + 1) % 64
            bm.faces.new((c, mid[k], mid[k1])); bm.faces.new((mid[k], ring[k], ring[k1], mid[k1]))
    B = water.get('brook')
    if B and B.get('surface'):
        dry = set(b['at'] for b in B['bridges']); pts = B['pts']; n = len(pts); hw = B['w'] / 2 + 0.25; prev = None
        for i in range(n):
            a = pts[max(0, i - 1)]; b = pts[min(n - 1, i + 1)]; tx = b[0] - a[0]; tz = b[1] - a[1]; l = math.hypot(tx, tz) or 1
            nx = -tz / l; nz = tx / l; x, z = pts[i]; y = B['surface'][i]
            row = [vert(x - nx * hw, y, z - nz * hw, 1.0), vert(x, y, z, 0.25), vert(x + nx * hw, y, z + nz * hw, 1.0)]
            if prev and i not in dry and (i - 1) not in dry:
                bm.faces.new((prev[0], prev[1], row[1], row[0])); bm.faces.new((prev[1], prev[2], row[2], row[1]))
            prev = row
        bs = B['basin']; r = bs['r'] - pool_rim; c = vert(bs['x'], bs['level'], bs['z'], 0.2)
        ring = [vert(bs['x'] + D[k][0] * r, bs['level'], bs['z'] + D[k][1] * r, 0.8) for k in range(0, 64, 2)]
        for k in range(len(ring)): bm.faces.new((c, ring[k], ring[(k + 1) % len(ring)]))
    bm.normal_update()
    for f in bm.faces:
        if f.normal.z < 0: f.normal_flip()
    ob = new_obj(name, bm, water_material(), C)
    cols = [tuple(ratio[k] + (1 - ratio[k]) * s for k in range(3)) for s in shore]
    _set_col(ob, cols)
    return ob


def _shore_ribbons(water, M, C, ground):
    """The overlay's painted shoreline, as the preview's sand: a ring round each pond, a band along each bank."""
    D = DIRS64; out = []
    for i, p in enumerate(water.get('ponds', [])):
        ring = [[p['x'] + D[k % 64][0] * (p['radii'][k % 64] + 0.15), p['z'] + D[k % 64][1] * (p['radii'][k % 64] + 0.15)] for k in range(65)]
        out.append(_ribbon('VL_shore%d' % i, ring, 0.9, M, C, z=0.02, ground=ground, smooth_=False))
    B = water.get('brook')
    if B:
        pts = B['pts']; n = len(pts)
        for side in (-1, 1):
            edge = []
            for i in range(n):
                a = pts[max(0, i - 1)]; b = pts[min(n - 1, i + 1)]; tx = b[0] - a[0]; tz = b[1] - a[1]; l = math.hypot(tx, tz) or 1
                off = B['w'] / 2 + 0.3; edge.append([pts[i][0] - tz / l * side * off, pts[i][1] + tx / l * side * off])
            out.append(_ribbon('VL_bank%d' % side, edge, 0.6, M, C, z=0.02, ground=ground))
        bs = B['basin']; out.append(_disc('VL_poolsand', bs['x'], bs['z'], bs['r'] + 0.55, M, C, zz=0.01, y=ground(bs['x'], -bs['z'])))
    return out


def _village_scene():
    main = bpy.data.scenes['Scene']
    sc = bpy.data.scenes.get('ARC_Village') or bpy.data.scenes.new('ARC_Village'); sc.world = main.world
    for o in list(sc.collection.objects): sc.collection.objects.unlink(o)   # unlink only: the sun is the look-dev's
    C = bpy.data.collections.get('ARC_VillageSet') or bpy.data.collections.new('ARC_VillageSet')
    if C.name not in sc.collection.children: sc.collection.children.link(C)
    for o in list(C.objects):
        me = o.data if o.type == 'MESH' else None
        bpy.data.objects.remove(o, do_unlink=True)
        if me and me.users == 0: bpy.data.meshes.remove(me)
    sc.collection.objects.link(bpy.data.objects['ARC_Sun'])
    return sc, C


def build_village(level_path, pack=None, dressing=True, lite=False):
    """The ARC_Village scene from a level dump. On relief (the dump's world.terrain) the ground is the engine's own
    mesh with its skirt, the water its own mesh, every placement stands at its compiled height and a leaning tree
    leans; dressing=False keeps only the ground, the water, the paths and the water's own parts (the terrain sheet)."""
    level = json.load(open(level_path)); rules = house_rules(pack); world = level['world']
    sc, C = _village_scene(); M = _mats(); made = {'houses': 0, 'props': 0, 'flora': 0, 'missing': []}
    T = world.get('terrain'); W = world.get('water'); ground = terrain_height(T) if T else _flat
    if T:
        skirt = json.load(open(pack or (globals().get('REPO', ROOT) + '/packs/arcade/pack.json')))['world']['terrain']['skirt']
        grass = terrain_ground('ARC_Village_Ground', T, skirt, M, C, lite=lite); made['groundTris'] = tris([grass])
    else:
        grass = meadow('ARC_Village_Meadow', M, radius=90.0); put(grass, C)
    for l in world['lanes']: _ribbon('VL_lane_%s' % l['id'], l['pts'], l['w'], M, C, ground=ground)
    for s in world['spurs']: _ribbon('VL_spur', s['pts'], s['w'] * 0.7, M, C, z=0.01, ground=ground)
    for w in world['walks']: _ribbon('VL_walk', w['pts'], w['w'], M, C, z=0.011, ground=ground)
    if world.get('square'): _disc('VL_square', world['square']['x'], world['square']['z'], world['square']['r'], M, C, y=ground(world['square']['x'], -world['square']['z']))
    if W:
        wm = water_mesh('VL_water', W, C); made['waterTris'] = tris([wm])
        _shore_ribbons(W, M, C, ground)
    NAT = bpy.data.collections.get(PARTS_COLL_N)
    WATER_PARTS = ('bridge.plank', 'pool.basin', 'lily.pad', 'lily.bloom', 'stone.bank.a', 'stone.bank.b', 'stone.bank.c', 'reeds', 'stone.step')
    contacts = []
    for i, p in enumerate(level['placements']):
        x, z, yaw, y = p['x'], p['z'], p.get('yaw', 0) or 0, p.get('y', 0) or 0
        if not dressing and not (p.get('part') in WATER_PARTS): continue
        if p.get('plan'):
            assemble_house(p['plan'], build_house(rules, p['plan']), 'VL_%d' % i, C, (x, -z, y), yaw); made['houses'] += 1
            contacts.append((x, -z)); continue
        if p.get('landmark') and not p.get('collisionOnly'):
            # a village landmark (world/worldLandmarks.js): its part from the landmark library, as the engine places it
            objs = globals().get('assemble_landmark', lambda *a, **k: [])(p['landmark'], 'VL_%d' % i, C, (x, -z, y), yaw, lite)
            if objs: made['landmarks'] = made.get('landmarks', 0) + 1; contacts.append((x, -z))
            else: made['missing'].append('landmark:' + p['landmark'].get('part', '?'))
            continue
        if p.get('tree'):
            # a generated tree (world/treeGrammar.js): its plan rides on the placement, scaled by the layout's size roll
            objs = assemble_tree(p['tree'], 'VL_%d' % i, C, (x, -z, y), yaw, p.get('scale', 1) or 1); made['trees'] = made.get('trees', 0) + 1
            lean = p.get('lean')
            if lean and lean[2] > 0:
                # tip toward the water: about (up x toward) through the foot, engine (dx, dz) being Blender (dx, -dz)
                axis = Vector((0, 0, 1)).cross(Vector((lean[0], -lean[1], 0))).normalized()
                L = Matrix.Translation((x, -z, y)) @ Matrix.Rotation(lean[2], 4, axis) @ Matrix.Translation((-x, z, -y))
                for o in objs: o.matrix_world = L @ o.matrix_world
            contacts.append((x, -z)); continue
        if p.get('part'):
            src = NAT and NAT.objects.get(p['part'])
            if not src: made['missing'].append(p['part']); continue
            c = src.copy(); C.objects.link(c); k = p.get('scale', 1) or 1
            c.matrix_world = Matrix.Translation((x, -z, y)) @ Matrix.Rotation(yaw, 4, 'Z') @ Matrix.Diagonal((k, k, k, 1)); c.name = 'VL_%s' % p['part']
            made['flora'] += 1; continue
        if p.get('pickup'):
            b = blob('VL_pickup', (x, -z, y + 0.3), 0.28, M['ButterYellow' if p['pickup'] == 'ammo' else 'Mint' if p['pickup'] == 'health' else 'CoralPink'], subd=2, jitter=0.0); put(b, C); continue
        names = LOOKDEV_GROUPS.get(p['id'])
        if not names: made['missing'].append(p['id']); continue
        # look-dev trees are authored at game scale already; the engine's `scale` for a tree is the layout's size roll times the catalogue's unit scale
        k = p.get('scale', 1) or 1
        if p['id'] in ('rocks',): k = k / (CATALOG_SCALE.get(p['id'], 1))
        elif p['id'] in ('fence', 'barrel', 'crystalShrine', 'woodGate', 'hayBarricade'): k = 1.0
        for o in _place_group(names, C, x, z, yaw, k): o.matrix_world = Matrix.Translation((0, 0, y)) @ o.matrix_world
        made['props'] += 1
        if p['id'] in ('rocks',): contacts.append((x, -z))
    worn = [(v.x, v.y) for l in world['lanes'] for v in _catmull([(p[0], -p[1]) for p in l['pts']], 3)]
    relief_tone = (lambda w: 0.06 * min(4.0, max(0.0, w.z - 0.8)) - 0.35 * min(0.5, max(0.0, -0.2 - w.z))) if T else None
    paint_ground([grass], contacts, worn=worn, low=-99.0 if T else -0.02, tone=relief_tone)
    _LAST['ground'] = ground
    ensure_grad([o for o in C.objects if o.type == 'MESH'])
    for o in C.objects:
        if o.type == 'MESH' and o.get('arc_outline', 0) > 0 and not any(ch.name.endswith('_outline') for ch in o.children): outline(o, o['arc_outline'])
    made['objects'] = len(C.objects); made['tris'] = tris([o for o in C.objects if o.type == 'MESH'])
    return made


# The engine scales each catalogue prop to `metres` over its longest side; the look-dev objects already are that size.
CATALOG_SCALE = {'rocks': 1.0}


def _render_village(cam, path, res, samples):
    main = bpy.data.scenes['Scene']; sc = bpy.data.scenes['ARC_Village']; win = bpy.context.window
    if cam.name not in sc.collection.objects: sc.collection.objects.link(cam)
    sc.camera = cam; sc.render.engine = main.render.engine
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


def render_village_top(path=VILLAGE_TOP, res=(1000, 1000), samples=16, span=84.0):
    cam = bpy.data.objects.get('ARC_VillageTopCam') or bpy.data.objects.new('ARC_VillageTopCam', bpy.data.cameras.new('ARC_VillageTopCam'))
    cam.data.type = 'ORTHO'; cam.data.ortho_scale = span; cam.data.clip_end = 1000
    cam.location = (0, 0, 120); cam.rotation_euler = (0, 0, 0)
    set_look(haze_density=0.0)     # the map is read from 120 m up: no haze for this one render
    try: return _render_village(cam, path, res, samples)
    finally: set_look()


def render_village_street(path=VILLAGE_STREET, res=(1200, 700), samples=16, at=(0.6, 27.5), look=(0.05, -1.0, -0.05), lens=24, eye=1.7):
    """Eye height above the ground at `at` (the relief's ground when the scene has it), looking down the spine."""
    cam = bpy.data.objects.get('ARC_VillageStreetCam') or bpy.data.objects.new('ARC_VillageStreetCam', bpy.data.cameras.new('ARC_VillageStreetCam'))
    cam.data.type = 'PERSP'; cam.data.lens = lens; cam.data.clip_start = 0.1; cam.data.clip_end = 1000
    d = Vector((look[0], -look[1], look[2])).normalized()     # engine look direction -> Blender
    cam.location = (at[0], -at[1], _LAST.get('ground', _flat)(at[0], -at[1]) + eye); cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    return _render_village(cam, path, res, samples)


TERRAIN_SHEET = OUT + '/arcade/arcade-terrain-sheet.png'


def render_terrain_top(path=TERRAIN_SHEET.replace('.png', '-top.png'), to_sun=(-0.78, -0.3, 0.36), **kw):
    """The terrain sheet's map: top-down, lit by a low sun so gentle rises fall into the toon shade band and cast
    their shadows (from straight above a noon sun would flatten them). The look-dev sun is put back afterwards."""
    s = bpy.data.objects['ARC_Sun']; keep = s.matrix_world.copy()
    d = Vector(to_sun).normalized(); s.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    try: return render_village_top(path, **kw)
    finally: s.matrix_world = keep


def render_terrain_sheet(level_path, path=TERRAIN_SHEET, seed_label=None, street=None):
    """The terrain sheet: one seed's relief and water without the village (ground, water, paths, bank stones,
    bridges, pool, lilies, reeds), top-down and from the street, side by side. Two light renders."""
    build_village(level_path, dressing=False)
    top = render_village_top(path.replace('.png', '-top.png'))
    st = render_village_street(path.replace('.png', '-street.png'), **(street or {}))
    return side_by_side([top, st], path)


_LAST = {}
