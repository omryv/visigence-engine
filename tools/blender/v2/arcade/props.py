"""Arcade gameplay props: the crystal shrine (objective), the village gate (gate) and the hay-and-crate
barricade (barricade). Same toon kit, palette and outlines as the hero corner.

exec after vg.py, kit.py, nature.py and hero_corner.py (same globals). Loader (Claude Bridge execute_code):
    T = '<repo>/tools/blender/v2'
    g = bpy.app.driver_namespace.setdefault('vg', {})
    for f in ('vg.py', 'arcade/kit.py', 'arcade/nature.py', 'arcade/hero_corner.py', 'arcade/props.py'):
        exec(open(f'{T}/{f}').read(), g)
    g['build_props']()    props + their review scene (needs the look-dev scene open for sky, sun and groves)
    g['review_props']()   one light EEVEE render          g['ship_props']()   GLBs + catalog cards
Metres, Z up, every prop's front faces -Y. The gate's doors are separate nodes hinged on their outer edge
(Door_L, Door_R) so the engine can swing them open; the shrine's crystal is its own node (Crystal).
"""
import bpy, math, random
from mathutils import Vector

# gameplay-only materials, built with the kit's two-branch toon/glTF setup
PROP_MATS = {
    'ARC_Crystal': ('#dccbff', {'shade': '#a893e0', 'rim': 0.8}),
    'ARC_Hay':     ('#f8d98a', {'shade': '#cdb9c9'}),
}
PROP_GLOW = {'ARC_Rune': '#8ff3d4'}

GATE_POST = 1.55            # post centres at +-GATE_POST
HINGE = 1.37                # door hinge lines at +-HINGE

LINEUP = Vector((1.8, -1.5, 0.0))      # the look-dev framing spot: groves and hills sit behind it
SIDE = Vector((0.8, 0.6, 0.0))         # screen-right for a camera looking along the look-dev direction
FACE = math.atan2(0.6, 0.8)            # yaw that turns a prop's -Y front toward that camera
PROPS_REVIEW = OUT + '/arcade/arcade-props-review.png'
PROP_CARDS = {'shrine': (['ARC_Shrine', 'ARC_Shrine_Crystal'], True),
              'gate': (['ARC_Gate', 'ARC_Gate_DoorL', 'ARC_Gate_DoorR'], True),
              'barricade': (['ARC_Barricade'], True)}

def prop_mats():
    M = {m.name[4:]: m for m in bpy.data.materials if m.name.startswith('ARC_')}
    if 'Wood' not in M: M = materials(); set_look()
    for k, (h, kw) in PROP_MATS.items(): M[k[4:]] = toon(k, h, **kw)
    for k, h in PROP_GLOW.items(): M[k[4:]] = glow(k, h)
    return M

def octo(name, r, z0, z1, mat, r1=None, bev=0.05):
    """Octagonal drum with flat faces on the axes (plinths, column caps)."""
    ob = lathe(name, [(0, z0), (r, z0), (r if r1 is None else r1, z1), (0, z1)], axis='Z', segs=8, mat=mat, cap=False)
    xform(ob, rot=[('Z', math.pi / 8)])
    return chunky(ob, bev)

def gem(name, r, h, mat, sides=6):
    """Faceted crystal on z=0: short lower point, straight prism, long upper point."""
    ob = lathe(name, [(0, 0), (r, h * 0.25), (r, h * 0.62), (0, h)], axis='Z', segs=sides, mat=mat, cap=False)
    return smooth(ob, 15, weighted=False)

def tone(objs, k=1.0, bottom=(0.74, 0.7, 0.8), lo=None, hi=None):
    """The kit's usual local vertical gradient, scaled by k for per-piece tonal variation."""
    vgrad(objs, tuple(c * k for c in bottom), (k, k, k), lo=lo, hi=hi, local=True)

# ---------------------------------------------------------------- crystal shrine

def shrine(M):
    """Stepped stone plinth, rune-lit column, gold claws holding a big faceted crystal. Returns (base, crystal)."""
    parts = [octo('s1', 1.05, 0.0, 0.26, M['Stone'], 1.0, 0.06), octo('s2', 0.78, 0.26, 0.5, M['Stone'], 0.74, 0.05)]
    col = lathe('col', [(0, 0.5), (0.36, 0.5), (0.36, 0.6), (0.3, 0.66), (0.27, 1.06), (0, 1.06)], axis='Z', segs=8,
                mat=M['Stone'], cap=False)
    xform(col, rot=[('Z', math.pi / 8)]); parts.append(chunky(col, 0.03))
    tone(parts, lo=0.0, hi=1.2)
    gold = [octo('cap', 0.33, 1.04, 1.2, M['ButterYellow'], 0.4, 0.03)]
    for k in range(4):                    # claws on the diagonals, between the runes
        a = math.pi / 4 + k * math.pi / 2; d = Vector((math.cos(a), math.sin(a), 0))
        p0, p1, p2 = d * 0.3 + Vector((0, 0, 1.16)), d * 0.38 + Vector((0, 0, 1.42)), d * 0.29 + Vector((0, 0, 1.68))
        gold += [chunky(strut(f'claw{k}a', p0, p1, 0.08, 0.08, M['ButterYellow']), 0.02),
                 chunky(strut(f'claw{k}b', p1, p2, 0.07, 0.07, M['ButterYellow']), 0.02),
                 blob(f'claw{k}c', p2, 0.055, M['ButterYellow'], subd=2, jitter=0.0)]
    tone(gold, bottom=(0.8, 0.72, 0.72), lo=1.0, hi=1.7)
    runes = []
    for k in range(4):                    # glowing slits on the four axis faces of the column
        r = box(f'rune{k}', (0.07, 0.03, 0.3), (0, -0.27, 0.84), M['Rune']); xform(r, rot=[('Z', k * math.pi / 2)])
        runes.append(r)
    rnd = random.Random(3); shards = []
    for k, a in enumerate((0.35, 2.3, 4.2)):   # little crystal clusters growing out of the upper step
        for j, (h, r) in enumerate(((0.36, 0.075), (0.24, 0.055))):
            s = gem(f'shard{k}{j}', r, h, M['Crystal'])
            aa = a + (j - 0.5) * 0.35; d = Vector((math.cos(aa), math.sin(aa), 0))
            xform(s, rot=[('Y', 0.45 + rnd.uniform(-0.1, 0.1)), ('Z', aa)], loc=d * (0.58 + 0.05 * j) + Vector((0, 0, 0.47)))
            shards.append(s)
    tone(shards, bottom=(0.78, 0.8, 1.0))
    ensure_grad(runes)
    base = merge('ARC_Shrine', parts + gold + runes + shards)
    cr = gem('ARC_Shrine_Crystal', 0.3, 1.28, M['Crystal'])
    xform(cr, rot=[('Z', 0.26)], loc=(0, 0, 1.3))
    vgrad([cr], (0.74, 0.76, 1.0), lo=1.3, hi=2.58, local=True)
    base['arc_outline'] = 0.035; cr['arc_outline'] = 0.03
    return base, cr

# ---------------------------------------------------------------- village gate

def gate_frame(M):
    """Stone footings, two posts, a lintel and a little shingle roof over the opening."""
    fr = []
    for s in (-1, 1):
        fr.append(rbox(f'foot{s}', (0.52, 0.52, 0.3), (s * GATE_POST, 0, 0.15), M['Stone'], 0.06))
        fr.append(rbox(f'post{s}', (0.3, 0.3, 2.6), (s * GATE_POST, 0, 1.55), M['Wood'], 0.05))
    fr.append(rbox('lintel', (3.9, 0.4, 0.28), (0, 0, 2.66), M['WoodDark'], 0.05))
    pitch = math.radians(40); ridge = 3.24
    gab = prism('gable', [(-0.42, 2.76), (0.42, 2.76), (0, 2.76 + 0.42 * math.tan(pitch))], -1.85, 1.85, axis='X', mat=M['Wood'])
    fr.append(chunky(gab, 0.02))
    tone(fr, lo=0.0, hi=3.2)
    roof = []; rnd = random.Random(5)
    for s in (-1, 1):
        n = Vector((0, s * math.sin(pitch), math.cos(pitch)))       # outward roof normal on this side
        for i in range(3):                    # three staggered shingle rows; upper rows sit on the lower ones
            u = 0.13 + i * 0.2
            c = Vector((0, s * u * math.cos(pitch), ridge - u * math.sin(pitch))) - n * 0.045 + n * 0.03 * (2 - i)
            t = rbox(f'roof{s}{i}', (4.3 - 0.06 * i, 0.26, 0.09), (rnd.uniform(-0.04, 0.04), c.y, c.z), M['Roof'], 0.03,
                     rot=('X', -s * pitch))
            tone([t], k=rnd.uniform(0.9, 1.0), bottom=(0.8, 0.76, 0.86))
            roof.append(t)
    roof.append(rbox('ridge', (4.45, 0.17, 0.17), (0, 0, ridge + 0.05), M['WoodDark'], 0.035))
    tone(roof[-1:], lo=ridge - 0.05, hi=ridge + 0.14)
    ob = merge('ARC_Gate', fr + roof)
    ob['arc_outline'] = 0.035
    return ob

def gate_leaf(M, s, name):
    """One door: pointed pickets rising toward the middle, rails on both faces, a Z brace, iron straps,
    hinge knuckles and a ring pull. s = -1 left leaf, +1 right leaf; built closed, in gate space."""
    rnd = random.Random(11 + s); inner, outer = 0.03, HINGE - 0.03; n = 5; w = (outer - inner) / n
    parts = []
    for i in range(n):
        x0, x1 = inner + i * w + 0.014, inner + (i + 1) * w - 0.014; xm = (x0 + x1) / 2
        top = 1.52 + 0.3 * (1 - (xm / outer) ** 2)
        pts = [(s * x0, 0.12), (s * x1, 0.12), (s * x1, top), (s * xm, top + 0.13), (s * x0, top)]
        p = chunky(prism(f'plank{i}', pts, -0.035, 0.035, axis='Y', mat=M['Wood']), 0.02)
        tone([p], k=rnd.uniform(0.86, 1.0), lo=0.0, hi=1.9)
        parts.append(p)
    wood = []
    for y in (-0.065, 0.065):
        for z in (0.42, 1.28):
            wood.append(rbox('rail', (outer - 0.12, 0.06, 0.16), (s * (0.07 + outer - 0.05) / 2, y, z), M['WoodDark'], 0.025))
    wood.append(chunky(strut('brace', (s * (outer - 0.14), -0.07, 0.5), (s * 0.2, -0.07, 1.2), 0.14, 0.06, M['WoodDark']), 0.02))
    tone(wood, lo=0.0, hi=1.9)
    iron = []
    for y in (-0.1, 0.1):
        for z in (0.42, 1.28):
            iron.append(rbox('strap', (0.42, 0.03, 0.1), (s * (outer - 0.2), y, z), M['Iron'], 0.012))
        iron.append(torus('ring', 0.07, 0.018, (s * 0.17, y * 1.1, 0.9), M['Iron'], axis='Y'))
    for z in (0.42, 1.28):
        iron.append(cyl('knuckle', 0.045, z - 0.08, z + 0.08, axis='Z', segs=8, mat=M['Iron'], center=(s * HINGE, 0, 0)))
    ensure_grad(iron)
    ob = merge(name, parts + wood + iron)
    ob['arc_outline'] = 0.025
    return ob

# ---------------------------------------------------------------- barricade

def hay_bale(M, name, loc, yaw):
    """Four pressed hay slices of slightly different size and tone, bound by two ties."""
    rnd = random.Random(sum(map(ord, name))); flakes = []
    for i, x in enumerate((-0.43, -0.145, 0.145, 0.43)):
        f = rbox(f'{name}_f{i}', (0.3, 0.62 + rnd.uniform(-0.02, 0.015), 0.56 + rnd.uniform(-0.025, 0.01)),
                 (x, rnd.uniform(-0.012, 0.012), 0.28), M['Hay'], 0.11, segs=2)
        tone([f], k=rnd.uniform(0.9, 1.0), bottom=(0.8, 0.74, 0.78), lo=0.0, hi=0.56)
        flakes.append(f)
    ties = [chunky(prism(f'{name}_tie{i}', rrect(0.655, 0.59, 0.14, 0, 0.28), x - 0.035, x + 0.035, axis='X', mat=M['WoodDark']), 0.012)
            for i, x in enumerate((-0.29, 0.29))]
    tone(ties, lo=0.0, hi=0.56)
    ob = merge(name, flakes + ties)
    xform(ob, rot=[('Z', yaw)], loc=loc)
    return ob

def crate(M, name, loc, yaw, s=0.74):
    core = rbox(name, (s, s, s), (0, 0, s / 2), M['Wood'], 0.03)
    e, t, d = s / 2, 0.11, 0.025; o = e - t / 2 + d; specs = []
    for ax in range(3):                   # boards along all twelve edges, standing proud of the faces
        for a in (-1, 1):
            for b in (-1, 1):
                size = [t, t, t]; size[ax] = s + 2 * d
                loc_ = [0.0, 0.0, 0.0]; others = [i for i in range(3) if i != ax]
                loc_[others[0]] = a * o; loc_[others[1]] = b * o
                loc_[2] += e
                specs.append((tuple(size), tuple(loc_)))
    edges = chunky(boxes(f'{name}_edges', specs, M['WoodDark']), 0.02)
    diag = [chunky(strut(f'{name}_diag{y}', (-e + t, y, t), (e - t, y, s - t), 0.1, 0.04, M['WoodDark']), 0.015) for y in (-e - 0.01, e + 0.01)]
    tone([core], lo=0.0, hi=s); tone([edges] + diag, k=0.95, lo=0.0, hi=s)
    ob = merge(name, [core, edges] + diag)
    xform(ob, rot=[('Z', yaw)], loc=loc)
    return ob

def barricade(M):
    """Three hay bales, a crate and two crossed planks: reads 'blocked' from any side."""
    parts = [hay_bale(M, 'baleA', (-0.25, 0.0, 0.0), 0.05), hay_bale(M, 'baleB', (0.93, 0.06, 0.0), -0.08),
             hay_bale(M, 'baleC', (0.37, 0.02, 0.56), 0.1), crate(M, 'crate', (-1.3, 0.08, 0.0), 0.25)]
    planks = []
    for i, a in enumerate((0.5, -0.5)):
        p = rbox(f'plank{i}', (1.55, 0.05, 0.17), (0, 0, 0), M['Wood'], 0.02)
        xform(p, rot=[('Y', a), ('X', -0.18)], loc=(0.36, -0.44, 0.62))
        tone([p], k=0.95 if i else 1.0)
        planks.append(p)
    ob = merge('ARC_Barricade', parts + planks)
    ob['arc_outline'] = 0.03
    return ob

# ---------------------------------------------------------------- review scene

def _review_scene():
    """A second scene in the look-dev file: its own meadow (contact-shaded around the new props), the look-dev
    hills, groves and clouds linked in, the look-dev sun and sky, and its own camera."""
    main = bpy.data.scenes['Scene']
    sc = bpy.data.scenes.get('ARC_Review') or bpy.data.scenes.new('ARC_Review')
    sc.world = main.world
    for name in ('ARC_ReviewSet', 'ARC_Gameplay'):
        c = bpy.data.collections.get(name) or bpy.data.collections.new(name)
        if c.name not in sc.collection.children: sc.collection.children.link(c)
    back = bpy.data.collections['ARC_ReviewSet']
    for o in bpy.data.collections['ARC_LookDev'].objects:
        if o.name.startswith(('ARC_LookDev_Hill', 'ARC_LookDev_Grove', 'ARC_LookDev_Cloud')) and o.name not in back.objects:
            back.objects.link(o)
    sun_ob = bpy.data.objects['ARC_Sun']
    if sun_ob.name not in back.objects: back.objects.link(sun_ob)
    return sc, back, bpy.data.collections['ARC_Gameplay']

def _clear(c):
    for o in list(c.objects):
        me = o.data if o.type == 'MESH' else None
        bpy.data.objects.remove(o, do_unlink=True)
        if me and me.users == 0: bpy.data.meshes.remove(me)

def build_props():
    M = prop_mats()
    sc, back, G = _review_scene()
    _clear(G)
    old = bpy.data.objects.get('ARC_Review_Meadow')
    if old: me = old.data; bpy.data.objects.remove(old, do_unlink=True); bpy.data.meshes.remove(me)
    base, cr = shrine(M)
    frame = gate_frame(M); dl = gate_leaf(M, -1, 'ARC_Gate_DoorL'); dr = gate_leaf(M, 1, 'ARC_Gate_DoorR')
    bar = barricade(M)
    for o in (base, cr, frame, dl, dr, bar): put(o, G)
    f = Vector((-0.6, 0.8, 0.0))
    for objs, off, yaw in (([base, cr], SIDE * -3.9, 0.25), ([frame, dl, dr], SIDE * 0.1 + f * 1.2, -0.3), ([bar], SIDE * 4.0, 0.35)):
        for o in objs: o.location = LINEUP + off; o.rotation_euler = (0, 0, FACE + yaw)
    for o in G.objects:
        if o.get('arc_outline', 0) > 0: outline(o, o['arc_outline'])
    md = put(meadow('ARC_Review_Meadow', M), back)
    # these objects live only in the review scene, so the active depsgraph never evaluates them: read the
    # transform channels (matrix_basis) directly instead of contact_points()'s matrix_world
    contacts = [((o.matrix_basis @ v.co).x, (o.matrix_basis @ v.co).y) for o in G.objects for v in o.data.vertices
                if (o.matrix_basis @ v.co).z < 0.3]
    paint_ground([md], contacts)
    cam = bpy.data.objects.get('ARC_ReviewCam') or bpy.data.objects.new('ARC_ReviewCam', bpy.data.cameras.new('ARC_ReviewCam'))
    if cam.name not in back.objects: back.objects.link(cam)
    t = LINEUP + Vector((0, 0, 1.25)); d = Vector((0.6, -0.8, 0.3)).normalized()
    cam.location = t + d * 13.0; cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = 35; cam.data.shift_y = 0.1; cam.data.clip_start = 0.1; cam.data.clip_end = 1000
    sc.camera = cam
    return {o.name: tris([o]) for o in G.objects}

def review_props(path=PROPS_REVIEW, res=(1200, 700), samples=16):
    """One light EEVEE render of the gameplay props (the weapon lineup, if built, is hidden for it)."""
    return render_review(path, res, samples, hide=('ARC_Weapons',))

def render_review(path, res=(1200, 700), samples=16, hide=()):
    """Render the review scene from its active camera (settings copied from the look-dev scene), with the
    named collections hidden for this render only."""
    main = bpy.data.scenes['Scene']; sc = bpy.data.scenes['ARC_Review']; win = bpy.context.window
    hidden = [c for c in (bpy.data.collections.get(n) for n in hide) if c and not c.hide_render]
    for c in hidden: c.hide_render = True
    sc.render.engine = main.render.engine
    for k in ('taa_samples', 'use_raytracing', 'use_fast_gi', 'use_shadows', 'shadow_ray_count', 'shadow_step_count',
              'shadow_resolution_scale', 'shadow_pool_size', 'use_volumetric_shadows'):
        try: setattr(sc.eevee, k, getattr(main.eevee, k))
        except (AttributeError, TypeError): pass
    sc.eevee.taa_render_samples = samples
    sc.view_settings.view_transform = 'Standard'; sc.view_settings.look = 'None'
    sc.render.resolution_x, sc.render.resolution_y = res; sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'PNG'; sc.render.filepath = path
    win.scene = sc
    try: bpy.ops.render.render(write_still=True, scene=sc.name)
    finally:
        win.scene = main
        for c in hidden: c.hide_render = False
    return path

def ship_props(out=OUT + '/arcade'):
    """GLBs (palette x COLOR_0, no outlines, gate doors hinged on their own nodes) + 256 px catalog cards."""
    ob = bpy.data.objects; res = {}
    res['shrine'] = export_nodes([('Shrine', [ob['ARC_Shrine']], None, (0, 0, 0), True),
                                  ('Crystal', [ob['ARC_Shrine_Crystal']], None, (0, 0, 0), True)], f'{out}/arcade-shrine.glb')
    res['gate'] = export_nodes([('Frame', [ob['ARC_Gate']], None, (0, 0, 0), True),
                                ('Door_L', [ob['ARC_Gate_DoorL']], (-HINGE, 0, 0), (-HINGE, 0, 0), True),
                                ('Door_R', [ob['ARC_Gate_DoorR']], (HINGE, 0, 0), (HINGE, 0, 0), True)], f'{out}/arcade-gate.glb')
    res['barricade'] = export_nodes([('Barricade', [ob['ARC_Barricade']], None, (0, 0, 0), True)], f'{out}/arcade-barricade.glb')
    res['cards'] = thumbnails(thumbs=PROP_CARDS)
    return res
