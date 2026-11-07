"""Blender preview of the desert village: generated desert houses (house_grammar.py, flat-roofed families) built from
the desert parts library (desert_parts.py, the DST_Parts collection) in the DST_Desert scene, and review renders at
the game's own camera (58 degree vertical field of view, eye 1.7 m above the ground).

exec after house_grammar.py, house_preview.py and desert_parts.py (same globals):
    g['desert_street'](families, keys)     a row of generated houses per family, fronts toward -Y
    g['eye_render'](path, at, look)        a render from the player's eye at `at` looking toward `look`
    g['overview_render'](path)             a raised three-quarter view of the whole street
"""
import bpy, json, math
from mathutils import Vector, Matrix

DESERT_HOUSES = 'DST_Houses'
DESERT_LOTS = {'courtyard': (10.0, 12.0), 'merchant': (11.0, 12.0), 'inn': (12.0, 12.0), 'tower': (8.0, 8.0)}
GAME_VFOV = 58.0   # ShooterSession: PerspectiveCamera(58, ...)
EYE = 1.7


def desert_rules(pack=None, biome='desert'):
    """The desert biome's house rules, read from the pack (biomes.desert.houses), or a rules file while it is drafted."""
    path = globals().get('DESERT_HOUSES_JSON')
    if path: return json.load(open(path))
    P = json.load(open(pack or (globals().get('REPO', ROOT) + '/packs/arcade/pack.json')))
    return P['biomes'][biome]['houses']


def _desert_coll(clear=True):
    sc = bpy.data.scenes['DST_Desert']
    C = bpy.data.collections.get(DESERT_HOUSES) or bpy.data.collections.new(DESERT_HOUSES)
    if C.name not in sc.collection.children: sc.collection.children.link(C)
    if clear:
        for o in [o for o in C.objects if o.parent is not None] + [o for o in C.objects if o.parent is None]:
            me = o.data if o.type == 'MESH' else None
            bpy.data.objects.remove(o, do_unlink=True)
            if me and me.users == 0: bpy.data.meshes.remove(me)
    return C


def desert_street(families=None, keys=('street|0', 'street|1'), rules=None, gap=1.0, y=0.0):
    """Every family x key, side by side on its own lot, fronts toward -Y; returns the plans laid out."""
    rules = rules or desert_rules(); C = _desert_coll()
    fams = families or list(rules['families'])
    x = 0.0; out = []
    for fam in fams:
        for key in keys:
            w, d = DESERT_LOTS.get(fam, (10.0, 12.0))
            plan = generate_house(rules, fam, key, {'w': w, 'd': d}); built = build_house(rules, plan)
            assemble_house(plan, built, f'DH_{fam}_{key}', C, at=(x + w / 2, y, 0), lib_coll='DST_Parts')
            out.append({'family': fam, 'key': key, 'x': x + w / 2, 'style': plan['style'], 'bounds': plan['bounds'], 'pieces': len(built['pieces']), 'parts': len(built['parts'])})
            x += w + gap
    return out


def _cam(name='DST_Cam'):
    sc = bpy.data.scenes['DST_Desert']
    cam = bpy.data.objects.get(name) or bpy.data.objects.new(name, bpy.data.cameras.new(name))
    if cam.name not in sc.collection.objects: sc.collection.objects.link(cam)
    sc.camera = cam
    return cam


class desert_haze:
    """The desert's warm, thin haze on the kit's shared ARC_Haze group for one render, then the meadow's back."""
    def __init__(self, color='#f2dcc0', density=0.0045, start=35.0): self.want = (color, density, start)
    def __enter__(self):
        h = haze_group().nodes
        self.keep = (tuple(h['ARC_HazeColor'].outputs[0].default_value), h['ARC_HazeDensity'].outputs[0].default_value, h['ARC_HazeStart'].outputs[0].default_value)
        h['ARC_HazeColor'].outputs[0].default_value = (*hexlin(self.want[0]), 1)
        h['ARC_HazeDensity'].outputs[0].default_value = self.want[1]; h['ARC_HazeStart'].outputs[0].default_value = self.want[2]
    def __exit__(self, *a):
        h = haze_group().nodes
        h['ARC_HazeColor'].outputs[0].default_value = self.keep[0]
        h['ARC_HazeDensity'].outputs[0].default_value = self.keep[1]; h['ARC_HazeStart'].outputs[0].default_value = self.keep[2]


def eye_render(path, at, look, res=(1296, 800), samples=16, h=EYE):
    """The player's view: eye `h` above (at.x, at.y), looking at `look` (x, y, z), 58 degrees vertical."""
    cam = _cam(); sc = bpy.data.scenes['DST_Desert']
    cam.location = Vector((at[0], at[1], h)); d = Vector(look) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    cam.data.sensor_fit = 'VERTICAL'; cam.data.angle_y = math.radians(GAME_VFOV); cam.data.shift_y = 0.0
    cam.data.clip_start = 0.06; cam.data.clip_end = 300
    bpy.context.window.scene = sc
    with desert_haze(): return render(path, res, samples)


def overview_render(path, target, direction=(0.35, -1.0, 0.62), dist=40.0, lens=35, res=(1600, 800), samples=16):
    cam = _cam(); sc = bpy.data.scenes['DST_Desert']
    t = Vector(target); d = Vector(direction).normalized()
    cam.location = t + d * dist; cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cam.data.sensor_fit = 'AUTO'; cam.data.lens = lens; cam.data.shift_y = 0.0; cam.data.clip_start = 0.1; cam.data.clip_end = 1000
    bpy.context.window.scene = sc
    with desert_haze(): return render(path, res, samples)


def _card_coll():
    sc = bpy.data.scenes['DST_Desert']
    C = bpy.data.collections.get('DST_Cards') or bpy.data.collections.new('DST_Cards')
    if C.name not in sc.collection.children: sc.collection.children.link(C)
    for o in [o for o in C.objects if o.parent is not None] + [o for o in C.objects if o.parent is None]:
        me = o.data if o.type == 'MESH' else None
        bpy.data.objects.remove(o, do_unlink=True)
        if me and me.users == 0: bpy.data.meshes.remove(me)
    return C


def _copy_in(C, src, at, yaw=0.0, recolour=True):
    c = src.copy(); c.data = src.data.copy(); C.objects.link(c)
    c.matrix_world = Matrix.Translation(Vector(at)) @ Matrix.Rotation(yaw, 4, 'Z')
    if recolour: _recolour(c)
    if c.get('arc_outline', 0) > 0: outline(c, c['arc_outline'])
    return c


def desert_cards(out=OUT + '/arcade/catalog', rules=None, trees=None, only=None):
    """The desert biome's catalog cards: desert-house, desert-tree, desert-nature, desert-landmark, desert-rocks,
    desert-wall and desert-barricade (256 px, the studio's dark slate, like every Arcade card)."""
    rules = rules or desert_rules(); trees = trees or json.load(open(globals().get('DESERT_TREES_JSON') or (globals().get('REPO', ROOT) + '/packs/arcade/pack.json')))
    if 'species' not in trees: trees = trees['biomes']['desert']['trees']
    sc = bpy.data.scenes['DST_Desert']; keep_world = sc.world; win = bpy.context.window; keep_scene = win.scene
    P = bpy.data.collections['DST_Parts']; C = _card_coll(); base = Vector((300, 0, 0)); cards = {}
    try:
        win.scene = sc
        plan = generate_house(rules, 'merchant', 'card|1', {'w': 11.0, 'd': 12.0})
        root = assemble_house(plan, build_house(rules, plan), 'CARD_house', C, at=base, yaw=0.5, lib_coll='DST_Parts')
        R = Matrix.LocRotScale(root.location, root.rotation_euler.to_quaternion(), root.scale)
        names = [o.name for o in root.children if o.type == 'MESH']
        for o in list(root.children):
            mw = R @ o.matrix_basis; o.parent = None; o.matrix_world = mw
        cards['desert-house'] = (names, True)
        names = []
        globals()['TREE_LIB_COLL'] = 'DST_Parts'
        for sp, key, dx in (('palm', 'card|2', -1.4), ('saguaro', 'card|1', 1.8)):
            for o in assemble_tree(generate_tree(trees, sp, key), f'CARD_{sp}', C, at=base + Vector((40 + dx, 0, 0))):
                if o.get('arc_outline', 0) > 0: outline(o, o['arc_outline'])
                names.append(o.name)
        cards['desert-tree'] = (names, True)
        cards['desert-nature'] = ([_copy_in(C, P.objects[pid], base + Vector((80 + x, y, 0)), yaw).name for pid, x, y, yaw in
                                   (('cactus.barrel', -0.9, 0.2, 0.3), ('agave', 0.4, -0.5, 0.0), ('cactus.pear', 1.3, 0.5, 0.6), ('rock.sand.c', -0.2, 1.0, 0.2), ('shrub.dry.a', -1.6, -0.4, 0.0))], True)
        cards['desert-landmark'] = ([_copy_in(C, P.objects[pid], base + Vector((120 + x, y, 0)), yaw).name for pid, x, y, yaw in
                                     (('well.oasis', -1.6, 0.4, 0.3), ('stall.desert.a', 2.2, -0.6, -0.4))], True)
        for key, obname in (('desert-rocks', 'DST_Rocks'), ('desert-wall', 'DST_Wall'), ('desert-barricade', 'DST_Barricade')):
            cards[key] = ([_copy_in(bpy.data.collections['DST_Props'], bpy.data.objects[obname], base + Vector((160 + 10 * len(cards), 0, 0)), 0.0, False).name], True)
        made = thumbnails(out=out, thumbs={k: v for k, v in cards.items() if only is None or k in only})
    finally:
        sc.world = keep_world; win.scene = keep_scene
        for key in ('desert-rocks', 'desert-wall', 'desert-barricade'):
            for n in cards.get(key, ([], 0))[0]:
                o = bpy.data.objects.get(n)
                if o: bpy.data.objects.remove(o, do_unlink=True)
        _card_coll()
    return made
