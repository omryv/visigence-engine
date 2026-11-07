"""Arcade gear for hand-built levels (docs/EDITOR.md): keys and the padlocks they open, a lever, the honey drop a
collect-a-thon counts, and the hero's trail staff. Same toon kit, palette and outlines as the pickups.

exec after vg.py, kit.py, nature.py, hero_corner.py, props.py, weapons.py and pickups.py (same globals):
    g['build_gear']()     everything into ARC_Gear (shown in the ARC_Review scene) + its camera
    g['review_gear']()    one light EEVEE render (assets/v2/arcade/arcade-gear-review.png)
    g['ship_gear']()      assets/v2/arcade/arcade-{keys,locks,lever,drop,staff}.glb + the 256 px catalog cards

Contract with the engine (render/CombatEnvironment.js, game/LevelScript.js, genres/hero/HeroPresentation.js):
  - arcade-keys.glb: Key_<colour> nodes (amber, ice, rose), all at the origin, standing on it, extras arc_bob so the
    session hovers, bobs and turns them like a pickup. arcade-locks.glb: Lock_<colour> padlocks, all at the origin, hung
    from their shackle's top, their face toward -Y here (+Z in glTF), which the engine hangs on a locked gate's front.
  - arcade-lever.glb: Base standing on its origin, and Handle with its origin on the hinge (0, 0, LEVER_HINGE); the engine
    turns the Handle about X from LEVER_THROW back to forward when pulled.
  - arcade-drop.glb: one 'Pickup' node, arc_bob, like the other pickups.
  - arcade-staff.glb: one 'Staff' node, its grip at the origin and its shaft along Y (the long end toward -Y), which is how
    it hangs off the hero's Grip_R socket (hero.py) with no offset of its own.
  - Budgets: under ~900 triangles a node.
Colours are the palette's: a key and its lock share the colour of the lock (amber = Honey, ice = SkyBlue, rose = CoralPink).
"""
import bpy, math
from mathutils import Vector

GEAR_OUTLINE = 0.009
GEAR_REVIEW = OUT + '/arcade/arcade-gear-review.png'
KEY_COLOURS = {'amber': 'Honey', 'ice': 'SkyBlue', 'rose': 'CoralPink'}
LEVER_HINGE = 0.34
LEVER_THROW = 0.62            # radians the handle leans back before it is pulled
STAFF_GRIP = 0.33             # metres of shaft behind the hand
GEAR_BUILDERS = []            # (id, builder, label, extras), filled by @gear


def gear(gid, label, bob=None):
    def reg(fn):
        GEAR_BUILDERS.append((gid, fn, label, {'arc_bob': bob} if bob else {})); return fn
    return reg

# ---------------------------------------------------------------- keys and padlocks


def key_parts(M, colour):
    """An old storybook key standing on its bit: an open ring bow in the lock's colour, a brass collar and shaft, and a
    stepped two-tooth bit. About 0.42 m, a little bigger than the other pickups so its colour reads across a meadow."""
    c = M[KEY_COLOURS[colour]]
    bow = torus('bow', 0.08, 0.03, (0, 0, 0.33), c, axis='Y', segs=16, rsegs=6)
    collar = cyl('collar', 0.032, 0.225, 0.26, axis='Z', segs=10, mat=M['ButterYellow'])
    shaft = cyl('shaft', 0.02, 0.02, 0.24, axis='Z', segs=8, mat=M['ButterYellow'])
    tip = ball('tip', (0, 0, 0.02), 0.023, M['ButterYellow'], subd=1)
    bit = box('bit', (0.022, 0.085, 0.1), (0, -0.05, 0.075), M['ButterYellow'])
    teeth = [box(f'tooth{i}', (0.022, 0.035, 0.035), (0, -0.1, z), M['ButterYellow']) for i, z in enumerate((0.04, 0.11))]
    for o in (bit, *teeth): chunky(o, 0.006)
    tone([bow], k=1.0, lo=0.22, hi=0.42); tone([collar, shaft, tip, bit, *teeth], k=0.97, lo=0.0, hi=0.3)
    return [bow, collar, shaft, tip, bit, *teeth]


def lock_parts(M, colour):
    """A chunky padlock in the lock's colour, an iron shackle above it and a brass keyhole plate; hung from the shackle's top
    at the origin, the body below."""
    c = M[KEY_COLOURS[colour]]
    body = prism('lockbody', rrect(0.2, 0.17, 0.05, 0, -0.205, n=3), -0.05, 0.05, axis='Y', mat=c)
    chunky(body, 0.012)
    shackle = tube('shackle', [(-0.055, 0, -0.12), (-0.055, 0, -0.06), (-0.035, 0, -0.02), (0.0, 0, -0.01), (0.035, 0, -0.02),
                               (0.055, 0, -0.06), (0.055, 0, -0.12)], 0.016, M['Iron'], segs=8)
    plate = cyl('plate', 0.042, -0.052, -0.066, axis='Y', segs=12, mat=M['ButterYellow'], center=(0, 0, -0.2))
    hole = prism('hole', [(-0.009, -0.24), (0.009, -0.24), (0.006, -0.205), (0.013, -0.195), (0.0, -0.182), (-0.013, -0.195),
                          (-0.006, -0.205)], -0.068, -0.062, axis='Y', mat=M['Ink'] if 'Ink' in M else M['StoneDark'])
    tone([body], k=1.0, lo=-0.29, hi=-0.12); tone([shackle, plate, hole], k=0.97)
    return [body, shackle, plate, hole]

# ---------------------------------------------------------------- lever


def lever_base(M):
    """A squat stone plinth with a wooden cap and a slot, a brass pivot either side: the lever's fixed part."""
    plinth = prism('plinth', rrect(0.5, 0.26, 0.05, 0, 0.13, n=3), -0.2, 0.2, axis='Y', mat=M['Stone'])
    chunky(plinth, 0.03)
    cap = box('cap', (0.44, 0.34, 0.07), (0, 0, 0.29), M['WoodDark']); chunky(cap, 0.015)
    pivots = [cyl(f'pivot{i}', 0.05, 0.0, 0.04, axis='X', segs=12, mat=M['ButterYellow'], center=(x, 0, LEVER_HINGE)) for i, x in enumerate((-0.13, 0.09))]
    cheeks = [box(f'cheek{i}', (0.035, 0.12, 0.14), (x, 0, LEVER_HINGE - 0.03), M['Iron']) for i, x in enumerate((-0.085, 0.085))]
    for o in pivots + cheeks: chunky(o, 0.008)
    tone([plinth], lo=0.0, hi=0.26); tone([cap], k=0.95); tone(pivots + cheeks, k=0.97)
    return [plinth, cap, *pivots, *cheeks]


def lever_handle(M):
    """The throw: a wooden stick on the hinge with a coral knob, modelled upright with its hinge at the origin."""
    stick = cyl('stick', 0.028, 0.0, 0.52, axis='Z', segs=8, mat=M['Wood'], r2=0.022)
    band = cyl('band', 0.033, 0.3, 0.33, axis='Z', segs=10, mat=M['ButterYellow'])
    knob = ball('knob', (0, 0, 0.56), 0.068, M['CoralPink'], subd=2)
    tone([stick], k=0.95, lo=0.0, hi=0.5); tone([band, knob], k=1.0)
    return [stick, band, knob]

# ---------------------------------------------------------------- honey drop and staff


@gear('drop', 'Drop', bob=0.16)
def honey_drop(M):
    """A plump honey droplet, point up, with a white glint and a curl of leaf at its foot: what a collect step counts."""
    prof = [(0.0, 0.0), (0.07, 0.008), (0.115, 0.05), (0.128, 0.105), (0.112, 0.16), (0.075, 0.215), (0.035, 0.265), (0.0, 0.3)]
    drop = lathe('drop', prof, axis='Z', segs=16, mat=M['Honey'], cap=False)
    smooth(drop, 60, weighted=False)
    glint = ball('glint', (-0.052, -0.083, 0.165), 0.022, M['Plaster'], (0.7, 0.45, 1.3), subd=1)
    lf = prism('leaf', leaf(0.11, 0.036), -0.003, 0.003, axis='Y', mat=M['LeafGreen'])
    xform(lf, rot=[('Y', 0.35), ('Z', -0.6)], loc=(0.03, 0.02, 0.02))
    tone([drop], bottom=(0.82, 0.62, 0.52), lo=0.0, hi=0.3)
    ensure_grad([glint, lf])
    return [drop, glint, lf]


def staff_parts(M):
    """The trail staff: a knotted walking stick, a leather grip where the hand closes, a brass ferrule, and a bound tuft of
    coral cloth and a leaf at the head. Its grip at the origin, the long end toward -Y (1.1 m in all)."""
    head, foot = -(1.1 - STAFF_GRIP), STAFF_GRIP
    shaft = tube('shaft', [(0, foot, 0), (0.004, 0.1, 0.006), (-0.004, -0.25, -0.004), (0.006, -0.5, 0.004), (0, head, 0)],
                 [0.03, 0.033, 0.034, 0.036, 0.04], M['Wood'], segs=8)
    knots = [ball(f'knot{i}', (0.024 * s, y, 0.014), 0.028, M['WoodDark'], (1, 1.4, 1), subd=1) for i, (y, s) in enumerate(((-0.34, 1), (-0.58, -1)))]
    grip = cyl('grip', 0.042, -0.07, 0.07, axis='Y', segs=10, mat=M['Burlap'])
    wraps = [torus(f'wrap{i}', 0.042, 0.009, (0, y, 0), M['Rope'], axis='Y', segs=10, rsegs=4) for i, y in enumerate((-0.07, 0.0, 0.07))]
    ferrule = cyl('ferrule', 0.034, foot - 0.05, foot + 0.005, axis='Y', segs=10, mat=M['ButterYellow'])
    crown = ball('crown', (0, head - 0.02, 0), 0.062, M['WoodDark'], (1, 1.3, 1), subd=2)
    tuft = ball('tuft', (0, head + 0.1, 0), 0.056, M['CoralPink'], (1.1, 1.6, 1.1), subd=1)
    bind = torus('bind', 0.042, 0.011, (0, head + 0.055, 0), M['Rope'], axis='Y', segs=10, rsegs=4)
    lf = prism('staffleaf', leaf(0.12, 0.04), -0.003, 0.003, axis='Y', mat=M['LeafGreen'])
    xform(lf, rot=[('X', -1.2), ('Z', 0.4)], loc=(0.03, head + 0.08, 0.03))
    tone([shaft] + knots, k=0.95); tone([grip] + wraps + [ferrule, crown, tuft, bind], k=0.97)
    ensure_grad([lf])
    return [shaft, *knots, grip, *wraps, ferrule, crown, tuft, bind, lf]

# ---------------------------------------------------------------- build, review, ship


def gear_mats():
    M = pick_mats()
    if 'Ink' not in M and 'ARC_Ink' in bpy.data.materials: M['Ink'] = bpy.data.materials['ARC_Ink']
    return M


def gear_objects(M):
    """(object name, parts, extras) for every node the gear ships."""
    out = [(f'ARC_G_Key_{c}', key_parts(M, c), {'arc_bob': 0.16}) for c in KEY_COLOURS]
    out += [(f'ARC_G_Lock_{c}', lock_parts(M, c), {}) for c in KEY_COLOURS]
    out += [('ARC_G_LeverBase', lever_base(M), {}), ('ARC_G_LeverHandle', lever_handle(M), {})]
    out += [(f'ARC_G_{label}', fn(M), extras) for _, fn, label, extras in GEAR_BUILDERS]
    out += [('ARC_G_Staff', staff_parts(M), {})]
    return out


def build_gear():
    """Every gear node merged into ARC_Gear (linked into the review scene), outlined, lined up on the review meadow;
    returns their triangles and sizes."""
    M = gear_mats()
    sc, back, _ = _review_scene()
    G = bpy.data.collections.get('ARC_Gear') or bpy.data.collections.new('ARC_Gear')
    if G.name not in sc.collection.children: sc.collection.children.link(G)
    _clear(G)
    info, made = {}, []
    for name, parts, extras in gear_objects(M):
        ob = put(merge(name, parts), G)
        ob['arc_outline'] = GEAR_OUTLINE
        for k, v in extras.items(): ob[k] = v
        outline(ob, GEAR_OUTLINE)
        vs = [v.co for v in ob.data.vertices]
        info[name[6:]] = {'tris': tris([ob]), 'size': [round(max(c[k] for c in vs) - min(c[k] for c in vs), 3) for k in range(3)]}
        made.append(ob)
    # the review: keys hovering, locks hung on posts' height, the lever with its handle leaning back, drop and staff
    gap = 0.55; x0 = -gap * (len(made) - 1) / 2
    for i, ob in enumerate(made):
        ob.location = LINEUP + SIDE * (x0 + gap * i) + Vector((0, 0, 0.16 if ob.get('arc_bob') else 0.0))
        ob.rotation_euler = (0, 0, FACE + 0.35)
        if 'Lock_' in ob.name: ob.location.z = 0.9
        if ob.name == 'ARC_G_LeverHandle':
            ob.location = bpy.data.objects['ARC_G_LeverBase'].location + Vector((0, 0, LEVER_HINGE)); ob.rotation_euler = (LEVER_THROW, 0, FACE + 0.35)
        if ob.name == 'ARC_G_Staff': ob.location.z = 0.2; ob.rotation_euler = (math.pi / 2, 0, FACE + 0.35)
    cam = bpy.data.objects.get('ARC_GearCam') or bpy.data.objects.new('ARC_GearCam', bpy.data.cameras.new('ARC_GearCam'))
    if cam.name not in back.objects: back.objects.link(cam)
    t = LINEUP + Vector((0, 0, 0.45)); d = Vector((0.6, -0.8, 0.45)).normalized()
    cam.location = t + d * 8.2; cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = 50; cam.data.clip_start = 0.05; cam.data.clip_end = 1000
    return info


def review_gear(path=GEAR_REVIEW, res=(1400, 700), samples=16):
    """One light EEVEE render of the gear (everything else in the review scene hidden for it)."""
    sc = bpy.data.scenes['ARC_Review']; keep = sc.camera
    sc.camera = bpy.data.objects['ARC_GearCam']
    try: return render_review(path, res, samples, hide=[c.name for c in sc.collection.children if c.name not in ('ARC_ReviewSet', 'ARC_Gear')])
    finally: sc.camera = keep


def ship_gear(out=OUT + '/arcade'):
    """The four GLBs (no outline shells) and catalog cards for the editor's palette: key, lock, lever, drop, staff."""
    ob = bpy.data.objects; res = {}
    # The three colours of a key (and of a lock) share one file, all at the origin: the file measures as one of them and
    # the engine picks the colour by node name.
    res['keys'] = export_nodes([(f'Key_{c}', [ob[f'ARC_G_Key_{c}']], None, (0, 0, 0), True) for c in KEY_COLOURS], f'{out}/arcade-keys.glb')
    res['locks'] = export_nodes([(f'Lock_{c}', [ob[f'ARC_G_Lock_{c}']], None, (0, 0, 0), True) for c in KEY_COLOURS], f'{out}/arcade-locks.glb')
    res['lever'] = export_nodes([('Base', [ob['ARC_G_LeverBase']], None, (0, 0, 0), True),
                                 ('Handle', [ob['ARC_G_LeverHandle']], None, (0, 0, LEVER_HINGE), True)], f'{out}/arcade-lever.glb')
    res['drop'] = export_nodes([('Pickup', [ob['ARC_G_Drop']], None, (0, 0, 0), True)], f'{out}/arcade-drop.glb')
    res['staff'] = export_nodes([('Staff', [ob['ARC_G_Staff']], None, (0, 0, 0), True)], f'{out}/arcade-staff.glb')
    res['cards'] = thumbnails(thumbs={'key': (['ARC_G_Key_amber'], False), 'lock': (['ARC_G_Lock_amber'], False),
                                      'lever': (['ARC_G_LeverBase', 'ARC_G_LeverHandle'], True), 'drop': (['ARC_G_Drop'], False),
                                      'staff': (['ARC_G_Staff'], False)})
    return res
