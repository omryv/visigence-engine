"""Arcade creature parts library: the modular bodies, caps, shells, ears, wings, horns, leaves, antlers and
accessories the creature grammar (src/world/creatureGrammar.js) assembles into creatures.

exec after vg.py, kit.py, nature.py, hero_corner.py, props.py, weapons.py and critters.py (same globals):
    g['build_parts']()     every part into the CRT_Parts collection (hidden; the preview copies from it)
    g['ship_parts']()      assets/v2/arcade/arcade-creature-parts.glb + src/world/creatureParts.js (the index)

Contract with the engine (render/CreatureAssembler.js) and the preview (creature_preview.py):
  - One top-level glTF node per part, named by its id ('slime.body.drop'); extras: arc_outline, and for bodies
    `face` {c, el, az, r} (ray origin in glTF metres, eye elevation and half-spacing in degrees, eye radius),
    for caps and shells `pattern` {c, el: [lo, hi]} (the zone surface patterns are scattered over).
  - Sockets are child empties named '<part>:<socket>' with extras.socket = <socket>. A part attaches with its
    own origin on the socket and its axes on the socket's axes. Paired sockets (ear, wing, horn, arm, foot,
    antenna) exist on the RIGHT (+X) side only; the left is the mirror image across X.
  - Materials are colour SLOTS named CRT_<Slot>, authored white x the 'Col' gradient; the palette fills them.
Units: a body stands about 1 unit tall on z=0 and faces -Y; everything else is sized to that. The engine
scales the whole creature to its catalog height afterwards.
"""
import bpy, bmesh, math, random, json, os
from mathutils import Vector, Matrix, Euler

PARTS_COLL = 'CRT_Parts'
PARTS_GLB = OUT + '/arcade/arcade-creature-parts.glb'
PARTS_INDEX = globals().get('REPO', ROOT) + '/src/world/creatureParts.js'   # the checkout being edited (the loader sets REPO)
SLOT_SHADE = {'Leaf': {'shade': '#9bb6cc'}, 'Wing': {'shade': '#b3c6e8', 'rim': 0.8}, 'Ink': {'rim': 0.0}}
SLOTS = ('Body', 'Accent', 'Trim', 'Leaf', 'Wood', 'Gold', 'Stone', 'Wing', 'Ink', 'White')
PARTS = {}          # id -> builder
PART_ORDER = []


def part(pid):
    def reg(fn):
        PARTS[pid] = fn; PART_ORDER.append(pid); return fn
    return reg


def cm(slot):
    """The white CRT_<slot> material (toon in Blender, palette x gradient in the GLB)."""
    name = 'CRT_' + slot
    return bpy.data.materials.get(name) or toon(name, '#ffffff', **SLOT_SHADE.get(slot, {}))


def gl(v):
    """Blender (Z up, -Y front) -> glTF (Y up, +Z front)."""
    return [round(v[0], 5), round(v[2], 5), round(-v[1], 5)]


def sock(ob, name, loc, rot=(0, 0, 0)):
    e = bpy.data.objects.new(f'{ob.name}:{name}', None)
    bpy.context.scene.collection.objects.link(e)
    e.empty_display_size = 0.05; e.empty_display_type = 'ARROWS'
    e.parent = ob; e.location = loc; e.rotation_euler = rot; e['socket'] = name
    return e


def finish_part(pid, objs, outline=0.018, grad=(0.8, 0.76, 0.86), lo=None, hi=None):
    """Merge the pieces into one object named by the part id, with a vertical gradient and outline width."""
    objs = [o for o in objs if o is not None]
    vgrad([o for o in objs if o.data.materials and o.data.materials[0].name not in ('CRT_Ink', 'CRT_White')], grad, lo=lo, hi=hi, local=True)
    ensure_grad(objs)
    ob = merge(pid, objs) if len(objs) > 1 else objs[0]
    ob.name = pid; ob.data.name = pid
    ob['arc_outline'] = outline
    return ob


def lathe_z(name, prof, slot, segs=24):
    return smooth(lathe(name, prof, axis='Z', segs=segs, mat=cm(slot)), 50, weighted=False)


def face_meta(ob, c, el, az, r):
    ob['face'] = {'c': gl(c), 'el': el, 'az': az, 'r': r}


def body_sockets(ob, S, top_el=82, top_sink=0.02, extra=()):
    """Top socket on the surface straight above the face centre (tilted slightly forward)."""
    loc, nrm = S.hit(fdir(0, top_el)); sock(ob, 'top', loc - nrm * top_sink)
    for name, d, sink, rot in extra:
        loc, nrm = S.hit(d); sock(ob, name, loc - nrm * sink, rot)

# ---------------------------------------------------------------- bodies: slime


def slime_shape(name, R, curl, stretch=1.0):
    bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=4, radius=R)
    for v in bm.verts:
        x, y, z = v.co
        z = z * 0.42 if z < 0 else z * stretch
        rho = math.hypot(x, y)
        z += curl * R * max(0.0, 1 - rho / (0.38 * R)) ** 2
        v.co = Vector((x * 1.08, y * 1.04, z))
    zmin = min(v.co.z for v in bm.verts); bmesh.ops.translate(bm, vec=(0, 0, -zmin), verts=bm.verts)
    ob = new_obj(name, bm, cm('Body')); ob.data.shade_smooth()
    return ob, R * 0.42 - zmin


def _slime(pid, R, curl, stretch):
    ob, cz = slime_shape(pid, R, curl, stretch)
    ob = finish_part(pid, [ob], 0.02, (0.74, 0.78, 0.92))
    c = (0, 0, R * 0.42 + 0.08); S = Skin(ob, c)
    face_meta(ob, c, 13, 21, 0.2 * R)
    body_sockets(ob, S, top_el=76 if curl > 0.2 else 88)
    return ob


@part('slime.body.drop')
def _p(): return _slime('slime.body.drop', 0.56, 0.34, 1.0)


@part('slime.body.round')
def _p(): return _slime('slime.body.round', 0.66, 0.06, 1.0)


@part('slime.body.tall')
def _p(): return _slime('slime.body.tall', 0.5, 0.3, 1.3)

# ---------------------------------------------------------------- bodies: mushroom stems, caps


def _stem(pid, h, r):
    ob = lathe_z(pid, [(0.0, 0.08), (r * 0.8, 0.08), (r, 0.2), (r * 1.04, h * 0.45), (r * 0.9, h * 0.8), (r * 0.74, h), (0.0, h + 0.02)], 'Body', 22)
    ob = finish_part(pid, [ob], 0.018, lo=0.08, hi=h)
    c = (0, 0, h * 0.5); S = Skin(ob, c)
    face_meta(ob, c, 4, 19, 0.07)
    sock(ob, 'top', (0, 0, h - 0.02))
    loc, nrm = S.hit(fdir(90, -8)); sock(ob, 'arm', loc - nrm * 0.02, (0, 0.35, 0))
    sock(ob, 'foot', (r * 0.55, -0.05, 0.0))
    return ob


@part('shroom.stem.stubby')
def _p(): return _stem('shroom.stem.stubby', 0.58, 0.3)


@part('shroom.stem.tall')
def _p(): return _stem('shroom.stem.tall', 0.78, 0.26)


def _cap(pid, prof, pattern_el, gill_z=0.0):
    ob = lathe(pid, prof, axis='Z', segs=30, mat=cm('Accent'), cap=False)
    ob.data.materials.append(cm('Body'))
    for p in ob.data.polygons:
        if p.normal.z < -0.35: p.material_index = 1          # underside = gills in the stem colour
    smooth(ob, 50, weighted=False)
    zs = [v.co.z for v in ob.data.vertices]
    ob = finish_part(pid, [ob], 0.02, lo=min(zs), hi=max(zs))
    # rays start above the gills (the underside peaks at z 0.04), or they would scatter the spots inside the cap
    ob['pattern'] = {'c': gl((0, 0, gill_z + 0.09)), 'el': list(pattern_el)}
    return ob


@part('shroom.cap.dome')
def _p(): return _cap('shroom.cap.dome', [(0.0, 0.42), (0.26, 0.39), (0.45, 0.27), (0.55, 0.12), (0.57, 0.03), (0.51, -0.02), (0.28, 0.02), (0.0, 0.04)], (16, 88))


@part('shroom.cap.flat')
def _p(): return _cap('shroom.cap.flat', [(0.0, 0.27), (0.32, 0.25), (0.55, 0.17), (0.65, 0.07), (0.66, 0.0), (0.58, -0.03), (0.3, 0.01), (0.0, 0.03)], (12, 88))


@part('shroom.cap.cone')
def _p(): return _cap('shroom.cap.cone', [(0.0, 0.6), (0.08, 0.52), (0.2, 0.36), (0.36, 0.18), (0.5, 0.06), (0.52, 0.0), (0.45, -0.03), (0.24, 0.01), (0.0, 0.03)], (14, 70))

# ---------------------------------------------------------------- limbs and feet (shared)


@part('arm.stub')
def _p():
    a = blob('arm.stub', (0, 0, 0), 0.075, cm('Body'), subd=3, scale=(0.75, 0.75, 1.25), jitter=0.0)
    xform(a, rot=[('Y', 0.35)], loc=(0.05, 0, -0.06))
    return finish_part('arm.stub', [a], 0.014)


@part('foot.boot')
def _p():
    f = blob('foot.boot', (0, -0.03, 0.07), 0.11, cm('Wood'), subd=3, scale=(0.85, 1.25, 0.62), jitter=0.0)
    return finish_part('foot.boot', [f], 0.014)


@part('foot.nub')
def _p():
    f = blob('foot.nub', (0, -0.02, 0.05), 0.085, cm('Body'), subd=3, scale=(0.9, 1.15, 0.6), jitter=0.0)
    return finish_part('foot.nub', [f], 0.012, (0.72, 0.68, 0.8))

# ---------------------------------------------------------------- bees


def _bee(pid, stretch):
    b = blob('b', (0, 0, 0), 0.44, cm('Body'), subd=4, scale=(1.0, 1.05 * stretch, 0.95), jitter=0.0)
    b.data.materials.append(cm('Accent'))
    L = 0.44 * 1.05 * stretch
    for p in b.data.polygons:                              # stripes across the back half, by position along Y
        t = p.center.y / L
        if 0.05 < t < 0.24 or 0.42 < t < 0.6 or t > 0.8: p.material_index = 1
    smooth(b, 50, weighted=False)
    sting = lathe('sting', [(0.045, 0.0), (0.0, 0.14)], axis='Y', segs=8, mat=cm('Ink'))
    xform(sting, loc=(0, L - 0.03, 0))
    ob = finish_part(pid, [b, sting], 0.018)
    xform(ob, loc=(0, 0, 0.44 * 0.95 + 0.02))
    c = (0, -0.05, 0.46); S = Skin(ob, c)
    face_meta(ob, c, 6, 25, 0.095)
    loc, nrm = S.hit(fdir(0, 88)); sock(ob, 'top', loc - nrm * 0.02)
    loc, nrm = S.hit(Vector((0.35, 0.3, 0.85)).normalized()); sock(ob, 'wing', loc - nrm * 0.02, (0.5, 0.35, 0))
    loc, nrm = S.hit(fdir(22, 55)); sock(ob, 'antenna', loc - nrm * 0.02, (-0.35, 0.3, 0))
    return ob


@part('bee.body.round')
def _p(): return _bee('bee.body.round', 1.0)


@part('bee.body.long')
def _p(): return _bee('bee.body.long', 1.35)


def _wing(pid, r, sx, sy):
    w = blob(pid, (0, 0, 0), r, cm('Wing'), subd=3, scale=(sx, sy, 0.06), jitter=0.0)
    xform(w, loc=(r * sx * 0.85, 0, 0))                  # root at the origin, blade out along +X
    xform(w, rot=[('Y', -0.9), ('Z', -0.35)])
    return finish_part(pid, [w], 0.01, (0.86, 0.9, 1.0))


@part('bee.wing.round')
def _p(): return _wing('bee.wing.round', 0.3, 1.0, 0.62)


@part('bee.wing.long')
def _p(): return _wing('bee.wing.long', 0.34, 1.0, 0.42)


@part('bee.antenna.curl')
def _p():
    t = tube('stalk', bez((0, 0, 0), (0.02, -0.05, 0.2), (0.1, -0.14, 0.26), 8), 0.014, cm('Ink'), segs=8)
    k = ball('knob', (0.1, -0.14, 0.26), 0.04, cm('Accent'))
    return finish_part('bee.antenna.curl', [t, k], 0.01)


@part('bee.antenna.ball')
def _p():
    t = tube('stalk', [(0, 0, 0), (0.02, -0.03, 0.24)], 0.012, cm('Ink'), segs=8)
    k = ball('knob', (0.02, -0.03, 0.27), 0.055, cm('Accent'))
    return finish_part('bee.antenna.ball', [t, k], 0.01)

# ---------------------------------------------------------------- sprouts


def _sprout_body(pid, prof):
    ob = lathe_z(pid, prof, 'Body', 26)
    ob = finish_part(pid, [ob], 0.02)
    top = max(p[1] for p in prof)
    c = (0, 0, top * 0.45); S = Skin(ob, c)
    face_meta(ob, c, 6, 22, 0.085)
    sock(ob, 'top', (0, 0, top - 0.02))
    sock(ob, 'foot', (0.16, -0.05, 0.0))
    return ob


@part('sprout.body.round')
def _p(): return _sprout_body('sprout.body.round', [(0.0, 0.0), (0.3, 0.0), (0.45, 0.1), (0.5, 0.3), (0.46, 0.52), (0.34, 0.7), (0.16, 0.8), (0.0, 0.82)])


@part('sprout.body.pear')
def _p(): return _sprout_body('sprout.body.pear', [(0.0, 0.0), (0.32, 0.0), (0.47, 0.12), (0.48, 0.3), (0.38, 0.52), (0.26, 0.72), (0.14, 0.86), (0.0, 0.9)])


def leaf(name, length, width, slot='Leaf', curl=0.12):
    """A leaf blade along +Y from the origin: a flattened, slightly cupped lens with a midrib crease."""
    bm = bmesh.new(); rows = 8; cols = 5; verts = []
    for i in range(rows + 1):
        t = i / rows; w = width * math.sin(math.pi * t) ** 0.8 * (1 - 0.25 * t)
        row = []
        for j in range(cols + 1):
            s = j / cols * 2 - 1
            row.append(bm.verts.new((s * w, t * length, curl * length * (s * s) * 0.5 + 0.06 * length * math.sin(math.pi * t))))
        verts.append(row)
    for i in range(rows):
        for j in range(cols): bm.faces.new((verts[i][j], verts[i][j + 1], verts[i + 1][j + 1], verts[i + 1][j]))
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    ob = new_obj(name, bm, cm(slot))
    sol = ob.modifiers.new('thick', 'SOLIDIFY'); sol.thickness = 0.018; sol.offset = 0
    apply_mods(ob)
    return smooth(ob, 60, weighted=False)


def stem(name, h, r=0.02, slot='Leaf', bend=0.03):
    return tube(name, bez((0, 0, -0.03), (bend, 0, h * 0.5), (0, 0, h), 5), r, cm(slot), segs=8)


@part('sprout.top.twoleaf')
def _p():
    s = stem('stem', 0.12, 0.024)
    L = []
    for sd in (-1, 1):
        l = leaf(f'leaf{sd}', 0.5, 0.26)
        xform(l, rot=[('X', -0.35), ('Z', -sd * 1.4)], loc=(0, 0, 0.11)); L.append(l)
    return finish_part('sprout.top.twoleaf', [s] + L, 0.014, (0.7, 0.8, 0.7))


@part('sprout.top.seedling')
def _p():
    s = stem('stem', 0.14, 0.016)
    L = []
    for sd in (-1, 1):
        l = leaf(f'leaf{sd}', 0.13, 0.07)
        xform(l, rot=[('X', -0.45), ('Z', -sd * 1.3)], loc=(0, 0, 0.13)); L.append(l)
    return finish_part('sprout.top.seedling', [s] + L, 0.012, (0.7, 0.8, 0.7))


def flower_head(name, loc, petals, r, slot='Accent', centre='Gold', tilt=0.3):
    parts = []
    for k in range(petals):
        a = 2 * math.pi * k / petals
        p = blob(f'{name}p{k}', (0, 0, 0), r, cm(slot), subd=2, scale=(0.55, 1.0, 0.28), jitter=0.0)
        xform(p, loc=(0, r * 0.95, 0)); xform(p, rot=[('X', tilt), ('Z', a)], loc=loc); parts.append(p)
    parts.append(ball(f'{name}c', Vector(loc) + Vector((0, 0, 0.02)), r * 0.55, cm(centre), (1, 1, 0.6)))
    return parts


@part('sprout.top.tulip')
def _p():
    s = stem('stem', 0.2, 0.018)
    cup = []
    for k in range(3):
        p = blob(f'pet{k}', (0, 0, 0), 0.09, cm('Accent'), subd=3, scale=(0.7, 0.5, 1.0), jitter=0.0)
        xform(p, loc=(0, -0.035, 0.07)); xform(p, rot=[('X', 0.15), ('Z', 2 * math.pi * k / 3)], loc=(0, 0, 0.2)); cup.append(p)
    l = leaf('leaf', 0.14, 0.07); xform(l, rot=[('X', -0.6), ('Z', -1.2)], loc=(0, 0, 0.06))
    return finish_part('sprout.top.tulip', [s, l] + cup, 0.012)


@part('sprout.top.daisy')
def _p():
    s = stem('stem', 0.18, 0.016)
    head = flower_head('d', (0, 0, 0.19), 8, 0.06, slot='White')
    l = leaf('leaf', 0.12, 0.06); xform(l, rot=[('X', -0.6), ('Z', 1.3)], loc=(0, 0, 0.05))
    return finish_part('sprout.top.daisy', [s, l] + head, 0.01)

# ---------------------------------------------------------------- pebble turtle


@part('pebble.base.turtle')
def _p():
    body = blob('belly', (0, 0.05, 0.2), 0.36, cm('Body'), subd=3, scale=(1.05, 1.25, 0.55), jitter=0.0)
    head = blob('head', (0, -0.44, 0.32), 0.19, cm('Body'), subd=3, scale=(1.0, 1.05, 0.95), jitter=0.0)
    neck = tube('neck', [(0, -0.2, 0.25), (0, -0.36, 0.3)], 0.1, cm('Body'), segs=12)
    legs = []
    for sx in (-1, 1):
        for sy, ln in ((-0.2, 0.0), (0.3, 0.0)):
            legs.append(blob(f'leg{sx}{sy}', (sx * 0.3, sy, 0.08), 0.1, cm('Body'), subd=3, scale=(1.0, 1.1, 0.85), jitter=0.0))
    tail = lathe('tail', [(0.05, 0.0), (0.0, 0.12)], axis='Y', segs=8, mat=cm('Body')); xform(tail, rot=[('X', -0.3)], loc=(0, 0.46, 0.16))
    ob = finish_part('pebble.base.turtle', [body, head, neck, tail] + legs, 0.02)
    c = (0, -0.42, 0.33); face_meta(ob, c, 8, 30, 0.055)
    sock(ob, 'shell', (0, 0.05, 0.25))
    return ob


def _shell(pid, obj, top):
    obj['pattern'] = {'c': gl((0, 0, 0.05)), 'el': [25, 88]}
    sock(obj, 'top', (0, 0, top - 0.03))
    return obj


@part('pebble.shell.rock')
def _p():
    bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=2, radius=0.46)
    rnd = random.Random(4)
    for v in bm.verts:
        v.co *= 1 + rnd.uniform(-0.08, 0.08)
        v.co.x *= 1.05; v.co.y *= 1.2; v.co.z = max(v.co.z, -0.02) * 0.95
    ob = new_obj('pebble.shell.rock', bm, cm('Accent'))
    smooth(ob, 25, weighted=False)
    zs = [v.co.z for v in ob.data.vertices]
    ob = finish_part('pebble.shell.rock', [ob], 0.022, (0.74, 0.72, 0.84), lo=min(zs), hi=max(zs))
    return _shell(ob, ob, max(zs))


@part('pebble.shell.dome')
def _p():
    d = lathe_z('dome', [(0.0, 0.46), (0.25, 0.43), (0.42, 0.3), (0.52, 0.1), (0.54, 0.0), (0.0, 0.0)], 'Accent', 26)
    xform(d, scale=(1.0, 1.18, 1.0))
    rim = torus('rim', 0.53, 0.045, (0, 0, 0.02), cm('Trim'), axis='Z', segs=28, rsegs=6); xform(rim, scale=(1.0, 1.18, 1.0))
    ob = finish_part('pebble.shell.dome', [d, rim], 0.022, lo=0, hi=0.46)
    return _shell(ob, ob, 0.46)


@part('pebble.shell.hex')
def _p():
    d = lathe_z('dome', [(0.0, 0.42), (0.28, 0.39), (0.45, 0.25), (0.53, 0.08), (0.54, 0.0), (0.0, 0.0)], 'Accent', 6)
    xform(d, scale=(1.0, 1.18, 1.0)); smooth(d, 20, weighted=False)
    S = Skin(d, (0, 0, 0.02)); plates = []
    for k, (az, el) in enumerate([(0, 90)] + [(a, 48) for a in range(0, 360, 60)]):
        p = S.stick(f'plate{k}', fdir(az, el), 0.13 if el == 90 else 0.11, cm('Trim'), (1, 1, 0.22), out=-0.005, spin=math.radians(az), subd=1)
        plates.append(p)
    ob = finish_part('pebble.shell.hex', [d] + plates, 0.022, lo=0, hi=0.42)
    return _shell(ob, ob, 0.42)


@part('pebble.detail.moss')
def _p():
    tufts = [blob(f'moss{i}', (x, y, 0.0), r, cm('Leaf'), subd=3, scale=(1, 1, 0.55), jitter=0.12, seed=i)
             for i, (x, y, r) in enumerate(((0, 0, 0.16), (0.12, 0.08, 0.1), (-0.1, 0.1, 0.11), (0.02, -0.12, 0.09)))]
    return finish_part('pebble.detail.moss', tufts, 0.014, (0.7, 0.8, 0.7))

# ---------------------------------------------------------------- bat-puff


@part('bat.body.puff')
def _p():
    b = blob('puff', (0, 0, 0.46), 0.44, cm('Body'), subd=4, scale=(1.05, 1.0, 0.98), jitter=0.07, seed=7)
    ob = finish_part('bat.body.puff', [b], 0.02)
    c = (0, 0, 0.47); S = Skin(ob, c)
    face_meta(ob, c, 10, 24, 0.1)
    loc, nrm = S.hit(fdir(38, 62)); sock(ob, 'ear', loc - nrm * 0.03, (0, 0.45, 0))
    loc, nrm = S.hit(fdir(95, 5)); sock(ob, 'wing', loc - nrm * 0.03, (0, 0, 0.35))
    loc, nrm = S.hit(fdir(0, 88)); sock(ob, 'top', loc - nrm * 0.02)
    return ob


def _ear(pid, prof, inner):
    o = lathe(pid, prof, axis='Z', segs=12, mat=cm('Body'))
    xform(o, scale=(1.0, 0.45, 1.0)); smooth(o, 50, weighted=False)
    i = lathe('inner', [(p[0] * 0.62, p[1] * 0.85 + 0.02) for p in prof], axis='Z', segs=12, mat=cm('Trim'))
    xform(i, scale=(1.0, 0.2, 1.0), loc=(0, -0.045, 0)); smooth(i, 50, weighted=False)
    return finish_part(pid, [o, i], 0.014)


@part('bat.ear.pointy')
def _p(): return _ear('bat.ear.pointy', [(0.12, 0.0), (0.11, 0.1), (0.07, 0.22), (0.0, 0.32)], True)


@part('bat.ear.round')
def _p(): return _ear('bat.ear.round', [(0.1, 0.0), (0.13, 0.08), (0.12, 0.16), (0.07, 0.22), (0.0, 0.24)], True)


@part('bat.wing.bat')
def _p():
    # membrane outline in the XZ plane, scalloped along the trailing edge, then fingers along the struts
    pts = [(0.0, 0.05), (0.18, 0.2), (0.42, 0.26), (0.5, 0.12), (0.42, 0.02), (0.36, -0.06), (0.27, -0.02), (0.2, -0.1), (0.12, -0.04), (0.02, -0.06)]
    m = prism('membrane', fillet(pts, 0.03, 3), -0.012, 0.012, axis='Y', mat=cm('Accent'))
    fingers = [tube(f'f{i}', [(0.0, 0.0, 0.02), p], 0.012, cm('Accent'), segs=6) for i, p in enumerate(((0.42, 0.0, 0.25), (0.36, 0.0, -0.05), (0.2, 0.0, -0.09)))]
    ob = finish_part('bat.wing.bat', [chunky(m, 0.006)] + fingers, 0.012, (0.8, 0.76, 0.9))
    return ob


@part('bat.wing.tiny')
def _p():
    w = blob('bat.wing.tiny', (0, 0, 0), 0.14, cm('Accent'), subd=3, scale=(1.0, 0.18, 0.7), jitter=0.0)
    xform(w, loc=(0.12, 0, 0.02))
    return finish_part('bat.wing.tiny', [w], 0.012, (0.8, 0.76, 0.9))

# ---------------------------------------------------------------- horned blob


def _blob_body(pid, sc):
    b = blob(pid, (0, 0, 0), 0.5, cm('Body'), subd=4, scale=sc, jitter=0.03, seed=3)
    for v in b.data.vertices:
        if v.co.z < 0: v.co.z *= 0.5
    b.data.update()
    zmin = min(v.co.z for v in b.data.vertices); xform(b, loc=(0, 0, -zmin))
    ob = finish_part(pid, [b], 0.02)
    top = max(v.co.z for v in ob.data.vertices)
    c = (0, 0, top * 0.42); S = Skin(ob, c)
    face_meta(ob, c, 10, 22, 0.09)
    loc, nrm = S.hit(fdir(0, 88)); sock(ob, 'top', loc - nrm * 0.02)
    loc, nrm = S.hit(fdir(42, 58)); sock(ob, 'horn', loc - nrm * 0.03, (0, 0.5, 0))
    sock(ob, 'foot', (0.2, -0.06, 0.0))
    return ob


@part('blob.body.wide')
def _p(): return _blob_body('blob.body.wide', (1.18, 1.05, 0.95))


@part('blob.body.tall')
def _p(): return _blob_body('blob.body.tall', (0.95, 0.95, 1.3))


@part('horn.curved')
def _p():
    c = bez((0, 0, 0), (0.02, 0, 0.16), (0.13, 0, 0.24), 8)
    return finish_part('horn.curved', [tube('horn.curved', c, taper(0.065, 0.012, len(c)), cm('Accent'), segs=10)], 0.014)


@part('horn.straight')
def _p():
    return finish_part('horn.straight', [lathe_z('horn.straight', [(0.06, 0.0), (0.045, 0.1), (0.0, 0.24)], 'Accent', 10)], 0.014)


@part('horn.ram')
def _p():
    pts = [Vector((0.07 * math.cos(t) + 0.06 * t / 6.2, -0.02 * t, 0.07 * math.sin(t) + 0.06)) for t in (i * 0.35 for i in range(19))]
    pts = [Vector((0, 0, 0))] + pts
    return finish_part('horn.ram', [tube('horn.ram', pts, taper(0.05, 0.02, len(pts)), cm('Accent'), segs=10)], 0.014)

# ---------------------------------------------------------------- acorn


def _acorn_body(pid, prof):
    ob = lathe_z(pid, prof, 'Body', 26)
    ob = finish_part(pid, [ob], 0.02)
    top = max(p[1] for p in prof)
    c = (0, 0, top * 0.4); S = Skin(ob, c)
    face_meta(ob, c, 4, 24, 0.08)
    sock(ob, 'top', (0, 0, top - 0.1))
    sock(ob, 'foot', (0.15, -0.05, 0.0))
    return ob


@part('acorn.body.round')
def _p(): return _acorn_body('acorn.body.round', [(0.0, 0.0), (0.28, 0.02), (0.44, 0.16), (0.48, 0.36), (0.44, 0.54), (0.36, 0.66), (0.0, 0.7)])


@part('acorn.body.egg')
def _p(): return _acorn_body('acorn.body.egg', [(0.0, 0.0), (0.22, 0.03), (0.36, 0.18), (0.4, 0.4), (0.37, 0.6), (0.3, 0.74), (0.0, 0.78)])


def _acorn_cap(pid, prof, top):
    cap = lathe_z('cap', prof, 'Accent', 28)
    S = Skin(cap, (0, 0, 0.05)); bumps = []
    for k, el in enumerate((22, 42)):
        for j in range(14 if el < 30 else 10):
            az = 360 * j / (14 if el < 30 else 10) + 12 * k
            bumps.append(S.stick(f'b{k}{j}', fdir(az, el), 0.045, cm('Accent'), (1, 1, 0.45), out=-0.012, subd=1))
    rim = torus('rim', 0.47, 0.04, (0, 0, 0.02), cm('Accent'), axis='Z', segs=28, rsegs=6)
    ob = finish_part(pid, [cap, rim] + bumps, 0.02, (0.72, 0.68, 0.78), lo=0, hi=top)
    sock(ob, 'top', (0, 0, top - 0.02))
    return ob


@part('acorn.cap.classic')
def _p(): return _acorn_cap('acorn.cap.classic', [(0.0, 0.24), (0.22, 0.22), (0.4, 0.14), (0.48, 0.04), (0.47, 0.0), (0.0, 0.0)], 0.24)


@part('acorn.cap.pointed')
def _p(): return _acorn_cap('acorn.cap.pointed', [(0.0, 0.34), (0.1, 0.28), (0.3, 0.16), (0.46, 0.05), (0.47, 0.0), (0.0, 0.0)], 0.34)


@part('acorn.top.stem')
def _p():
    return finish_part('acorn.top.stem', [stem('acorn.top.stem', 0.12, 0.028, 'Wood', 0.03)], 0.012)

# ---------------------------------------------------------------- forest spirit


def _spirit_body(pid, prof):
    ob = lathe_z(pid, prof, 'Body', 26)
    ob = finish_part(pid, [ob], 0.02, (0.82, 0.8, 0.9))
    top = max(p[1] for p in prof)
    c = (0, 0, top * 0.66); S = Skin(ob, c)
    face_meta(ob, c, 4, 20, 0.07)
    sock(ob, 'top', (0, 0, top - 0.02))
    sock(ob, 'neck', (0, 0, top * 0.5))
    return ob


@part('spirit.body.bell')
def _p(): return _spirit_body('spirit.body.bell', [(0.0, 0.0), (0.4, 0.0), (0.42, 0.08), (0.34, 0.3), (0.26, 0.56), (0.24, 0.8), (0.18, 0.96), (0.0, 1.02)])


@part('spirit.body.bean')
def _p(): return _spirit_body('spirit.body.bean', [(0.0, 0.0), (0.3, 0.0), (0.36, 0.12), (0.33, 0.36), (0.3, 0.6), (0.3, 0.8), (0.2, 0.94), (0.0, 0.98)])


@part('spirit.cloak.leaves')
def _p():
    L = []
    for k in range(9):
        a = 2 * math.pi * k / 9
        l = leaf(f'cl{k}', 0.34, 0.14, curl=0.2)
        xform(l, rot=[('X', -2.35)], loc=(0, 0.02, 0)); xform(l, rot=[('Z', a + math.pi)], loc=(0, 0, 0.02))
        xform(l, loc=(0.3 * math.sin(a), -0.3 * math.cos(a), 0))
        L.append(l)
    return finish_part('spirit.cloak.leaves', L, 0.014, (0.66, 0.78, 0.68))


@part('spirit.top.antlers')
def _p():
    br = []
    for sd in (-1, 1):
        main = bez((sd * 0.04, 0, 0), (sd * 0.1, 0, 0.18), (sd * 0.24, 0, 0.3), 7)
        br.append(tube(f'a{sd}', main, taper(0.03, 0.014, len(main)), cm('Wood'), segs=8))
        tw = bez(main[3], (sd * 0.1, 0, 0.3), (sd * 0.06, 0, 0.38), 4)
        br.append(tube(f't{sd}', tw, taper(0.018, 0.01, len(tw)), cm('Wood'), segs=6))
        l = leaf(f'l{sd}', 0.1, 0.05); xform(l, rot=[('X', -0.9), ('Z', -sd * 0.9)], loc=tuple(main[-1])); br.append(l)
    return finish_part('spirit.top.antlers', br, 0.012)

# ---------------------------------------------------------------- shared accessories


@part('acc.bow')
def _p():
    lobes = []
    for sd in (-1, 1):
        b = blob(f'lobe{sd}', (sd * 0.1, 0, 0.07), 0.08, cm('Accent'), subd=3, scale=(1.1, 0.55, 0.8), jitter=0.0)
        xform(b, rot=[('Y', sd * 0.25)]); lobes.append(b)
    knot = ball('knot', (0, -0.01, 0.07), 0.04, cm('Accent'))
    return finish_part('acc.bow', lobes + [knot], 0.012)


@part('acc.leaf')
def _p():
    s = stem('stem', 0.08, 0.016)
    l = leaf('l', 0.2, 0.1); xform(l, rot=[('X', -0.5), ('Z', -0.4)], loc=(0, 0, 0.07))
    return finish_part('acc.leaf', [s, l], 0.012, (0.7, 0.8, 0.7))


@part('acc.flower')
def _p():
    return finish_part('acc.flower', flower_head('f', (0, 0, 0.04), 5, 0.06, slot='Accent', tilt=0.2), 0.01)


@part('acc.crown')
def _p():
    parts = [lathe('band', [(0.18, 0.0), (0.2, 0.0), (0.22, 0.12), (0.2, 0.12), (0.18, 0.01), (0.18, 0.0)], axis='Z', segs=24, mat=cm('Gold'), cap=False)]
    for k in range(5):
        a = -math.pi / 2 + k * 2 * math.pi / 5; d = Vector((math.cos(a), math.sin(a), 0))
        sp = lathe(f'spike{k}', [(0.038, 0.0), (0.0, 0.1)], axis='Z', segs=8, mat=cm('Gold')); xform(sp, loc=d * 0.21 + Vector((0, 0, 0.11))); parts.append(sp)
        parts.append(ball(f'gem{k}', d * 0.21 + Vector((0, 0, 0.22)), 0.024, cm('Accent')))
    for p in parts: smooth(p, 40, weighted=False)
    return finish_part('acc.crown', parts, 0.012, (0.82, 0.74, 0.74))

# ---------------------------------------------------------------- build and ship


def build_parts():
    materials(); prop_mats()
    for s in SLOTS: cm(s)
    C = bpy.data.collections.get(PARTS_COLL) or bpy.data.collections.new(PARTS_COLL)
    if C.name not in bpy.data.scenes['Scene'].collection.children: bpy.data.scenes['Scene'].collection.children.link(C)
    doomed = list(C.objects); meshes = [o.data for o in doomed if o.type == 'MESH']
    for o in doomed: bpy.data.objects.remove(o, do_unlink=True)
    for me in meshes:
        if me.users == 0: bpy.data.meshes.remove(me)
    info = {}
    for pid in PART_ORDER:
        ob = PARTS[pid]()
        for o in [ob] + list(ob.children):
            for u in list(o.users_collection): u.objects.unlink(o)
            C.objects.link(o)
        info[pid] = tris([ob])
    C.hide_render = True; C.hide_viewport = True
    return {'parts': len(info), 'tris': sum(info.values()), 'max': max(info.items(), key=lambda kv: kv[1])}


def parts_index():
    C = bpy.data.collections[PARTS_COLL]; idx = {}
    for pid in PART_ORDER:
        ob = C.objects[pid]
        idx[pid] = {'sockets': sorted(ch['socket'] for ch in ob.children if 'socket' in ch), 'face': 'face' in ob, 'pattern': 'pattern' in ob}
    return idx


def ship_parts(path=PARTS_GLB, index=PARTS_INDEX):
    """One GLB with every part (sockets as child empties) + the JS index the engine and tests validate against."""
    C = bpy.data.collections[PARTS_COLL]
    objs = [o for o in C.objects]
    gltf_mode(True)
    try:
        C.hide_viewport = False
        # export only mesh parts and their socket empties
        bpy.context.view_layer.update()
        size = export_glb(objs, path)
    finally:
        gltf_mode(False); C.hide_viewport = True
    idx = parts_index()
    body = json.dumps(idx, indent=1, sort_keys=True)
    with open(index, 'w') as f:
        f.write('// Generated by tools/blender/v2/arcade/creature_parts.py (ship_parts): the creature parts library\n'
                '// index - every part id with its sockets. The grammar rules are validated against it.\n'
                'export const CREATURE_PARTS = ' + body + ';\n')
    return {'kb': round(size / 1024, 1), 'parts': len(idx), 'tris': tris([o for o in objs if o.type == 'MESH'])}
