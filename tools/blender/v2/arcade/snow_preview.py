"""Blender preview of the snow village: generated alpine houses (house_grammar.py with the snow covering, log walls and
the belfry) built from the snow parts library (snow_parts.py, the SNW_Parts collection) in the SNW_Snow scene, snowy
trees from the tree grammar, and review renders at the game's own camera (58 degree vertical field of view, eye
1.7 m above the ground).

exec after house_grammar.py, house_preview.py, tree_grammar.py, tree_preview.py and snow_parts.py (same globals):
    g['snow_setup']()                      sky, sun, render settings and the snow ground of the SNW_Snow scene
    g['snow_street'](families, keys)       a row of generated houses per family, fronts toward -Y
    g['snow_eye'](path, at, look)          a render from the player's eye at `at` looking toward `look`
    g['snow_overview'](path, target)       a raised three-quarter view
    g['snow_cards']()                      the snow biome's catalog cards
"""
import bpy, json, math
from mathutils import Vector, Matrix

SNOW_HOUSES = 'SNW_Houses'
SNOW_LOTS = {'cabin': (9.0, 11.0), 'lodge': (12.0, 13.0), 'workshop': (11.0, 12.0), 'watchtower': (8.0, 8.0)}
GAME_VFOV = 58.0   # ShooterSession: PerspectiveCamera(58, ...)
EYE = 1.7
SLOT_TOON['Snow'] = {'shade': SNOW_SHADE, 'rim': 0.25}
# The snow look (config/looks.js BIOME_LOOKS.arcade.snow, golden hour): a crisp blue sky, a near-white sun, a cool
# fill bounced off the snow and a thin blue-white haze.
SNOW_SKY = {'top': '#4a8fe4', 'mid': '#9cc8f2', 'horizon': '#e4eef9', 'fill': '#dce8f7', 'fill_strength': 0.55}
SNOW_SUN = {'to_sun': (-0.25, -0.6, 0.62), 'strength': 4.2, 'color': '#fff4e6'}


def snow_pack(pack=None):
    return json.load(open(pack or (globals().get('REPO', ROOT) + '/packs/arcade/pack.json')))


def snow_rules(pack=None):
    P = snow_pack(pack); return P['biomes']['snow']['houses']


def snow_trees(pack=None):
    P = snow_pack(pack); return P['biomes']['snow']['trees']


def _sky_world(w, top, mid, horizon, fill, fill_strength):
    """kit.sky()'s gradient and fill, on the snow scene's own world (kit.sky rewrites the shared ARC_Sky)."""
    nt = w.node_tree
    for n in list(nt.nodes): nt.nodes.remove(n)
    out = _n(nt, 'ShaderNodeOutputWorld', (800, 0))
    tc = _n(nt, 'ShaderNodeTexCoord', (-800, 0))
    sep = _n(nt, 'ShaderNodeSeparateXYZ', (-600, 0)); _link(nt, tc.outputs['Generated'], sep.inputs[0])
    t = _mapr(nt, sep.outputs['Z'], -0.02, 0.28)
    rp = _n(nt, 'ShaderNodeValToRGB', (-200, 0)); _link(nt, t, rp.inputs[0])
    els = rp.color_ramp.elements
    els[0].position, els[0].color = 0.0, (*hexlin(horizon), 1)
    els[1].position, els[1].color = 1.0, (*hexlin(top), 1)
    e = els.new(0.3); e.color = (*hexlin(mid), 1)
    cam_bg = _n(nt, 'ShaderNodeBackground', (200, 100)); _link(nt, rp.outputs[0], cam_bg.inputs['Color'])
    light_bg = _n(nt, 'ShaderNodeBackground', (200, -100))
    light_bg.inputs['Color'].default_value = (*hexlin(fill), 1); light_bg.inputs['Strength'].default_value = fill_strength
    lp = _n(nt, 'ShaderNodeLightPath', (200, 300))
    mx = _n(nt, 'ShaderNodeMixShader', (500, 0))
    _link(nt, lp.outputs['Is Camera Ray'], mx.inputs[0]); _link(nt, light_bg.outputs[0], mx.inputs[1]); _link(nt, cam_bg.outputs[0], mx.inputs[2])
    _link(nt, mx.outputs[0], out.inputs['Surface'])


def snow_setup(ground=True):
    """The SNW_Snow scene ready to render: Standard view, light EEVEE, its own sky and sun, a snow ground disc."""
    sc = snow_scene(); win = bpy.context.window; keep = win.scene; win.scene = sc
    try:
        render_setup()
        w = sc.world
        try: w.use_nodes = True
        except AttributeError: pass
        _sky_world(w, **SNOW_SKY)
        L = bpy.data.objects['SNW_Sun']; S = SNOW_SUN
        L.data.energy = S['strength']; L.data.color = hexlin(S['color']); L.data.angle = math.radians(3.0)
        d = Vector(S['to_sun']).normalized(); L.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler(); L.location = d * 30
        if ground and not bpy.data.objects.get('SNW_Ground'):
            M = _sm()
            g = cyl('SNW_Ground', 120.0, -0.2, 0.0, axis='Z', segs=48, mat=M['Snow'])
            for u in list(g.users_collection): u.objects.unlink(g)
            sc.collection.objects.link(g); ensure_grad([g])
    finally:
        win.scene = keep
    return sc


def _snow_coll(name=SNOW_HOUSES, clear=True):
    sc = snow_scene()
    C = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if C.name not in sc.collection.children: sc.collection.children.link(C)
    if clear:
        for o in [o for o in C.objects if o.parent is not None] + [o for o in C.objects if o.parent is None]:
            me = o.data if o.type == 'MESH' else None
            bpy.data.objects.remove(o, do_unlink=True)
            if me and me.users == 0: bpy.data.meshes.remove(me)
    return C


def snow_street(families=None, keys=('street|0', 'street|1'), rules=None, gap=1.0, y=0.0, clear=True):
    """Every family x key, side by side on its own lot, fronts toward -Y; returns the plans laid out."""
    rules = rules or snow_rules(); C = _snow_coll(clear=clear)
    fams = families or list(rules['families'])
    x = 0.0; out = []
    for fam in fams:
        for key in keys:
            w, d = SNOW_LOTS.get(fam, (10.0, 12.0))
            plan = generate_house(rules, fam, key, {'w': w, 'd': d}); built = build_house(rules, plan)
            assemble_house(plan, built, f'SH_{fam}_{key}', C, at=(x + w / 2, y, 0), lib_coll=PARTS_COLL_S)
            out.append({'family': fam, 'key': key, 'x': x + w / 2, 'style': plan['style'], 'bounds': plan['bounds'], 'pieces': len(built['pieces']), 'parts': len(built['parts'])})
            x += w + gap
    return out


def snow_grove(items, trees=None, name='SNW_Trees', clear=True):
    """Trees of the snow species: items [(species, key, x, y)]."""
    trees = trees or snow_trees(); C = _snow_coll(name, clear)
    globals()['TREE_LIB_COLL'] = PARTS_COLL_S
    out = []
    for sp, key, x, y in items:
        objs = assemble_tree(generate_tree(trees, sp, key), f'ST_{sp}_{key}', C, at=(x, y, 0))
        for o in objs:
            if o.get('arc_outline', 0) > 0: outline(o, o['arc_outline'])
        out.append(sp)
    return out


def _cam(name='SNW_Cam'):
    sc = snow_scene()
    cam = bpy.data.objects.get(name) or bpy.data.objects.new(name, bpy.data.cameras.new(name))
    if cam.name not in sc.collection.objects: sc.collection.objects.link(cam)
    sc.camera = cam
    return cam


class snow_haze:
    """A cool, thin haze on the kit's shared ARC_Haze group for one render, then the meadow's back."""
    def __init__(self, color='#e2ecf8', density=0.005, start=30.0): self.want = (color, density, start)
    def __enter__(self):
        h = haze_group().nodes
        self.keep = (tuple(h['ARC_HazeColor'].outputs[0].default_value), h['ARC_HazeDensity'].outputs[0].default_value, h['ARC_HazeStart'].outputs[0].default_value)
        h['ARC_HazeColor'].outputs[0].default_value = (*hexlin(self.want[0]), 1)
        h['ARC_HazeDensity'].outputs[0].default_value = self.want[1]; h['ARC_HazeStart'].outputs[0].default_value = self.want[2]
    def __exit__(self, *a):
        h = haze_group().nodes
        h['ARC_HazeColor'].outputs[0].default_value = self.keep[0]
        h['ARC_HazeDensity'].outputs[0].default_value = self.keep[1]; h['ARC_HazeStart'].outputs[0].default_value = self.keep[2]


def _go(path, res, samples):
    sc = snow_scene(); win = bpy.context.window; keep = win.scene; win.scene = sc
    try:
        with snow_haze(): return render(path, res, samples)
    finally:
        win.scene = keep


def snow_eye(path, at, look, res=(1296, 800), samples=16, h=EYE):
    """The player's view: eye `h` above (at.x, at.y), looking at `look` (x, y, z), 58 degrees vertical."""
    cam = _cam()
    cam.location = Vector((at[0], at[1], h)); d = Vector(look) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    cam.data.sensor_fit = 'VERTICAL'; cam.data.angle_y = math.radians(GAME_VFOV); cam.data.shift_y = 0.0
    cam.data.clip_start = 0.06; cam.data.clip_end = 300
    return _go(path, res, samples)


def snow_overview(path, target, direction=(0.35, -1.0, 0.62), dist=40.0, lens=35, res=(1600, 800), samples=16):
    cam = _cam(); t = Vector(target); d = Vector(direction).normalized()
    cam.location = t + d * dist; cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cam.data.sensor_fit = 'AUTO'; cam.data.lens = lens; cam.data.shift_y = 0.0; cam.data.clip_start = 0.1; cam.data.clip_end = 1000
    return _go(path, res, samples)


def _card_coll():
    return _snow_coll('SNW_Cards')


def _copy_in(C, src, at, yaw=0.0, recolour=True):
    c = src.copy(); c.data = src.data.copy(); C.objects.link(c)
    c.matrix_world = Matrix.Translation(Vector(at)) @ Matrix.Rotation(yaw, 4, 'Z')
    if recolour: _srecolour(c)
    if c.get('arc_outline', 0) > 0: outline(c, c['arc_outline'])
    return c


def snow_cards(out=OUT + '/arcade/catalog', only=None):
    """The snow biome's catalog cards: snow-house, snow-tree, snow-nature, snow-landmark, snow-rocks, snow-fence,
    snow-barricade and snow-barrel (256 px, the studio's dark slate, like every Arcade card)."""
    rules = snow_rules(); trees = snow_trees()
    sc = snow_scene(); keep_world = sc.world; win = bpy.context.window; keep_scene = win.scene
    P = bpy.data.collections[PARTS_COLL_S]; C = _card_coll(); base = Vector((300, 0, 0)); cards = {}
    ground = bpy.data.objects.get('SNW_Ground'); hidden = ground.hide_render if ground else None
    try:
        win.scene = sc
        if ground: ground.hide_render = True
        plan = generate_house(rules, 'cabin', 'card|1', {'w': 9.0, 'd': 11.0})
        root = assemble_house(plan, build_house(rules, plan), 'CARD_house', C, at=base, yaw=0.5, lib_coll=PARTS_COLL_S)
        R = Matrix.LocRotScale(root.location, root.rotation_euler.to_quaternion(), root.scale)
        names = [o.name for o in root.children if o.type == 'MESH']
        for o in list(root.children):
            mw = R @ o.matrix_basis; o.parent = None; o.matrix_world = mw
        cards['snow-house'] = (names, True)
        names = []
        globals()['TREE_LIB_COLL'] = PARTS_COLL_S
        for sp, key, dx in (('snowpine', 'card|2', -1.6), ('bare', 'card|1', 2.0)):
            for o in assemble_tree(generate_tree(trees, sp, key), f'CARD_{sp}', C, at=base + Vector((40 + dx, 0, 0))):
                if o.get('arc_outline', 0) > 0: outline(o, o['arc_outline'])
                names.append(o.name)
        cards['snow-tree'] = (names, True)
        cards['snow-nature'] = ([_copy_in(C, P.objects[pid], base + Vector((80 + x, y, 0)), yaw).name for pid, x, y, yaw in
                                 (('firewood.stack', -0.6, 0.6, 0.2), ('rock.snow.a', 1.4, 0.3, 0.4), ('bush.snow', -1.9, -0.5, 0.0), ('sled', 0.3, -1.0, 0.5), ('lantern.post', 2.3, -0.9, 0.0))], True)
        cards['snow-landmark'] = ([_copy_in(C, P.objects[pid], base + Vector((120 + x, y, 0)), yaw).name for pid, x, y, yaw in
                                   (('belltower.snow', -1.2, 0.8, 0.35), ('well.snow', 2.4, -1.4, -0.3))], True)
        for key, obname in (('snow-rocks', 'SNW_Rocks'), ('snow-fence', 'SNW_Fence'), ('snow-barricade', 'SNW_Barricade'), ('snow-barrel', 'SNW_Barrel')):
            cards[key] = ([_copy_in(bpy.data.collections['SNW_Props'], bpy.data.objects[obname], base + Vector((160 + 10 * len(cards), 0, 0)), 0.0, False).name], True)
        made = thumbnails(out=out, thumbs={k: v for k, v in cards.items() if only is None or k in only})
    finally:
        if ground: ground.hide_render = hidden
        sc.world = keep_world; win.scene = keep_scene
        for key in ('snow-rocks', 'snow-fence', 'snow-barricade', 'snow-barrel'):
            for n in cards.get(key, ([], 0))[0]:
                o = bpy.data.objects.get(n)
                if o: bpy.data.objects.remove(o, do_unlink=True)
        _card_coll()
    return made


def snow_vignette(path=OUT + '/arcade/arcade-snow-review.png', res=(1200, 700), samples=16):
    """The snow village's Environments card picture: a cabin, a lodge and a workshop round a frozen pond, the bell
    tower behind, the well and a winter stall, snowy pines and a bare tree, firewood, a sled and lanterns; a raised
    three-quarter view like the desert's."""
    rules = snow_rules(); trees = snow_trees(); M = _sm()
    C = _snow_coll('SNW_Vignette'); P = bpy.data.collections[PARTS_COLL_S]
    for name in ('SNW_Houses', 'SNW_Trees', 'SNW_Show', 'SNW_PropShow', 'SNW_Cards'):
        c = bpy.data.collections.get(name)
        if c: c.hide_render = True
    for fam, key, at, yaw in (('cabin', 'vig|3', (-9.5, 5.5), 0.35), ('lodge', 'vig|1', (1.0, 10.5), 0.0), ('workshop', 'vig|2', (-15.0, 13.0), 0.5)):
        w, d = SNOW_LOTS[fam]
        plan = generate_house(rules, fam, key, {'w': w, 'd': d})
        assemble_house(plan, build_house(rules, plan), f'SV_{fam}', C, at=(at[0], at[1], 0), yaw=yaw, lib_coll=PARTS_COLL_S)
    for pid, at, yaw in (('belltower.snow', (12.0, 8.0), -0.35), ('well.snow', (6.0, 0.5), 0.3), ('stall.snow.a', (9.8, -2.8), -0.5),
                         ('firewood.stack', (-4.2, 4.0), 0.1), ('sled', (-3.0, -4.6), 0.6), ('lantern.post', (2.6, -3.2), 0.0), ('lantern.post', (-6.8, -1.0), 0.0),
                         ('barrel.snow', (8.2, 1.6), 0.0), ('snowbank.a', (4.0, -6.0), 0.3), ('snowbank.b', (-10.5, -4.0), -0.4), ('rock.snow.a', (16.0, -3.5), 0.5),
                         ('bush.snow', (-1.0, 4.6), 0.0), ('signpost', (1.8, 2.8), 0.4), ('reeds.frozen', (-5.2, -1.6), 0.0), ('reeds.frozen', (0.9, -1.9), 1.0)):
        _copy_in(C, P.objects[pid], (at[0], at[1], 0.0), yaw)
    sm = bpy.data.objects.get('yard.snowman')
    if sm: _copy_in(C, sm, (-7.0, 0.6, 0.0), 0.5)
    # the frozen pond: pale ice a hair above the snow, one soft snow bank rounding up all round it
    ice = cyl('SV_ice', 3.2, 0.0, 0.03, axis='Z', segs=48, mat=M['Frost'])
    rim = lathe('SV_rim', [(3.05, 0.0), (3.2, 0.12), (3.55, 0.3), (4.0, 0.26), (4.5, 0.08), (4.7, 0.0)], axis='Z', segs=48, mat=M['Snow'])
    for o in (ice, rim):
        xform(o, scale=(1.25, 1.0, 1.0), loc=(-2.5, -1.0, 0.0)); smooth(o, 60, weighted=False)
        for u in list(o.users_collection): u.objects.unlink(o)
        C.objects.link(o); ensure_grad([o]); outline(o, 0.02)
    globals()['TREE_LIB_COLL'] = PARTS_COLL_S
    for sp, key, x, y in (('snowpine', 'v|1', -16.5, 3.0), ('snowpine', 'v|2', -13.5, -3.5), ('snowpine', 'v|3', 17.5, 12.0), ('snowpine', 'v|4', -4.5, 16.0),
                          ('snowpine', 'v|5', 19.0, 3.5), ('snowpine', 'v|6', 7.0, 15.5), ('bare', 'v|1', 4.0, 5.0), ('bare', 'v|2', -4.0, 11.0)):
        for o in assemble_tree(generate_tree(trees, sp, key), f'SV_{sp}_{key}', C, at=(x, y, 0)):
            if o.get('arc_outline', 0) > 0: outline(o, o['arc_outline'])
    return snow_overview(path, (1.0, 3.5, 2.6), direction=(0.2, -1.0, 0.6), dist=38.0, lens=35, res=res, samples=samples)
