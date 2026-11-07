"""Arcade house parts library: the doors, windows, shutters, flower boxes, lanterns, canopies, signs, ridge caps,
spires, vanes, chimney pots, dormers, bay windows, balconies and yard props the house grammar
(src/world/houseGrammar.js) hangs on its code-built walls and roofs.

exec after vg.py, kit.py, nature.py, hero_corner.py, props.py, weapons.py, critters.py and creature_parts.py (same globals):
    g['build_house_parts']()   every part into the HSE_Parts collection (hidden; the preview copies from it)
    g['ship_house_parts']()    assets/v2/arcade/arcade-house-parts.glb + src/world/houseParts.js (the index)

Contract with the engine (render/HouseAssembler.js) and the preview (house_preview.py):
  - One top-level glTF node per part, named by its id ('win.arched'); extras: arc_outline (metres, world scale).
  - Sockets are child empties named '<part>:<socket>' with extras.socket = <socket>. A hung part attaches with
    its own origin on the socket and its axes on the socket's axes. The paired socket (shutter) exists on the
    RIGHT (+X) side only; the left is the mirror image across the host's X.
  - Materials are colour SLOTS named HSE_<Slot>, authored white x the 'Col' gradient; the plan's palette fills them.
Units are metres at game scale (no rescale). Wall parts stand on their origin at the bottom centre of the opening,
on the wall plane, and face -Y (out of the wall); roof parts stand on their origin; ridge caps run along X, 1.32 long.
"""
import bpy, bmesh, math, random, json
from mathutils import Vector, Matrix

PARTS_COLL_H = 'HSE_Parts'
PARTS_GLB_H = OUT + '/arcade/arcade-house-parts.glb'
PARTS_INDEX_H = globals().get('REPO', ROOT) + '/src/world/houseParts.js'
HSLOTS = ('Wall', 'Roof', 'Accent', 'Timber', 'TimberDark', 'Stone', 'StoneDark', 'Iron', 'Glass', 'Glow', 'Leaf', 'Petal', 'Gold')
HSLOT_TOON = {'Roof': {'shade': '#bd9ec6'}, 'Glass': {'rim': 0.7}, 'Leaf': {'shade': '#9bb6cc'}}
HPARTS, HPART_ORDER = {}, []


def hpart(pid):
    def reg(fn):
        HPARTS[pid] = fn; HPART_ORDER.append(pid); return fn
    return reg


def hm(slot):
    """The white HSE_<slot> material (toon in Blender, palette x gradient in the GLB)."""
    name = 'HSE_' + slot
    m = bpy.data.materials.get(name)
    if m: return m
    return glow(name, '#ffffff') if slot == 'Glow' else toon(name, '#ffffff', **HSLOT_TOON.get(slot, {}))


def hfinish(pid, objs, outline=0.025, grad=(0.8, 0.76, 0.86)):
    """Merge the pieces into one object named by the part id; each piece darkens toward its own base."""
    objs = [o for o in objs if o is not None]
    vgrad([o for o in objs if o.data.materials and o.data.materials[0].name not in ('HSE_Glass', 'HSE_Glow')], grad, local=True)
    ensure_grad(objs)
    ob = merge(pid, objs) if len(objs) > 1 else objs[0]
    ob.name = pid; ob.data.name = pid; ob['arc_outline'] = outline
    return ob


def ybox(name, size, loc, slot, bev=0.03, rot=None):
    return rbox(name, size, loc, hm(slot), bev, rot)


def panel(name, pts, y0, y1, slot, bev=0.03):
    """A flat piece in the wall plane: 2D outline (x, z) extruded from y0 to y1."""
    return chunky(prism(name, pts, y0, y1, axis='Y', mat=hm(slot)), bev)


def ring_frame(name, outer, inner, y0, y1, slot, bev=0.035):
    fr = prism(name, outer, y0, y1, axis='Y', mat=hm(slot))
    cut(fr, prism('cut', inner, y0 - 0.3, y1 + 0.3, axis='Y'))
    return chunky(fr, bev)


def rect_pts(w, h, cx=0.0, z0=0.0):
    return [(cx - w / 2, z0), (cx + w / 2, z0), (cx + w / 2, z0 + h), (cx - w / 2, z0 + h)]


def disc(name, r, y0, y1, cz, slot, segs=20):
    return smooth(prism(name, [(math.cos(2 * math.pi * k / segs) * r, cz + math.sin(2 * math.pi * k / segs) * r) for k in range(segs)], y0, y1, axis='Y', mat=hm(slot)), 30, weighted=False)


def sphere(name, loc, r, slot, scale=(1, 1, 1)):
    return blob(name, loc, r, hm(slot), subd=2, scale=scale, jitter=0.0)

# ---------------------------------------------------------------- doors


@hpart('door.arched')
def _p():
    fr = ring_frame('fr', arch_pts(1.36, 2.08), arch_pts(1.0, 2.19, 0.0, -0.3), -0.13, 0.1, 'TimberDark')
    pn = panel('pn', arch_pts(1.02, 1.92), -0.05, 0.05, 'Accent')
    planks = boxes('pl', [((0.035, 0.04, 1.45), (x, -0.06, 0.78)) for x in (-0.18, 0.18)], hm('TimberDark'))
    knob = torus('kn', 0.09, 0.022, (0.26, -0.09, 0.95), hm('Gold'))
    ob = hfinish('door.arched', [fr, pn, planks, knob], 0.03)
    sock(ob, 'lamp', (0.98, 0, 1.25)); sock(ob, 'canopy', (0, 0, 2.16)); sock(ob, 'sign', (-0.98, 0, 1.9))
    return ob


@hpart('door.plank')
def _p():
    fr = ring_frame('fr', rect_pts(1.3, 2.0), rect_pts(0.98, 1.86, 0.0, -0.3), -0.13, 0.1, 'Timber')
    pn = panel('pn', rect_pts(1.0, 1.86), -0.05, 0.05, 'Accent')
    grooves = boxes('gr', [((0.03, 0.03, 1.8), (x, -0.055, 0.93)) for x in (-0.25, 0.0, 0.25)], hm('TimberDark'))
    rim = torus('rim', 0.15, 0.035, (0, -0.07, 1.45), hm('Timber'), segs=12)
    glass = disc('gl', 0.14, -0.07, 0.02, 1.45, 'Glass')
    handle = sphere('h', (0.34, -0.1, 0.95), 0.05, 'Gold')
    ob = hfinish('door.plank', [fr, pn, grooves, rim, glass, handle], 0.03)
    sock(ob, 'lamp', (0.95, 0, 1.25)); sock(ob, 'canopy', (0, 0, 2.08)); sock(ob, 'sign', (-0.95, 0, 1.85))
    return ob


@hpart('door.round')
def _p():
    fr = ring_frame('fr', arch_pts(1.3, 1.95, n=10), arch_pts(0.96, 1.78, 0.0, -0.3, n=10), -0.13, 0.1, 'Timber')
    pn = panel('pn', arch_pts(0.98, 1.8, n=10), -0.05, 0.05, 'Accent')
    straps = boxes('st', [((0.8, 0.04, 0.08), (0.0, -0.065, z)) for z in (0.45, 1.2)], hm('Iron'))
    ring = torus('rg', 0.08, 0.02, (-0.26, -0.09, 0.9), hm('Iron'))
    stud = [blob(f's{i}', (x, -0.08, z), 0.035, hm('Iron'), subd=1, jitter=0.0) for i, (x, z) in enumerate(((-0.3, 0.45), (0.3, 0.45), (-0.3, 1.2), (0.3, 1.2)))]
    ob = hfinish('door.round', [fr, pn, straps, ring] + stud, 0.03)
    sock(ob, 'lamp', (0.92, 0, 1.2)); sock(ob, 'canopy', (0, 0, 2.02)); sock(ob, 'sign', (-0.92, 0, 1.8))
    return ob


@hpart('door.double')
def _p():
    fr = ring_frame('fr', rect_pts(1.9, 2.15), rect_pts(1.6, 2.0, 0.0, -0.3), -0.13, 0.1, 'Timber')
    parts = [fr]
    for s in (-1, 1):
        x0 = s * 0.4
        parts.append(panel(f'lf{s}', rect_pts(0.78, 1.98, x0), -0.05, 0.05, 'Accent'))
        parts.append(boxes(f'rl{s}', [((0.7, 0.04, 0.1), (x0, -0.065, z)) for z in (0.25, 1.75)], hm('TimberDark')))
        parts.append(chunky(strut(f'br{s}', (x0 - s * 0.3, -0.065, 0.32), (x0 + s * 0.3, -0.065, 1.68), 0.1, 0.04, hm('TimberDark')), 0.01))
        parts.append(sphere(f'h{s}', (s * 0.09, -0.1, 1.0), 0.045, 'Iron'))
    ob = hfinish('door.double', parts, 0.03)
    sock(ob, 'lamp', (1.25, 0, 1.3)); sock(ob, 'canopy', (0, 0, 2.2)); sock(ob, 'sign', (-1.25, 0, 1.95))
    return ob

# ---------------------------------------------------------------- windows


def _sill(w):
    return ybox('sill', (w, 0.34, 0.14), (0, -0.1, -0.02), 'Timber', 0.04)


@hpart('win.arched')
def _p():
    fr = ring_frame('fr', arch_pts(1.24, 1.5), arch_pts(0.88, 1.14, 0.0, 0.18), -0.12, 0.1, 'Timber')
    gl = smooth(prism('gl', arch_pts(0.9, 1.15, 0.0, 0.17), -0.03, 0.05, axis='Y', mat=hm('Glass')), 30, weighted=False)
    bars = boxes('bars', [((0.07, 0.05, 1.12), (0, -0.05, 0.74)), ((0.88, 0.05, 0.07), (0, -0.05, 0.62))], hm('TimberDark'))
    ob = hfinish('win.arched', [fr, gl, bars, _sill(1.5)], 0.028)
    sock(ob, 'shutter', (0.64, -0.05, 0.12)); sock(ob, 'sill', (0, -0.12, 0.05))
    return ob


@hpart('win.cross')
def _p():
    fr = ring_frame('fr', rect_pts(1.2, 1.3), rect_pts(0.9, 1.0, 0.0, 0.15), -0.12, 0.1, 'Timber')
    gl = prism('gl', rect_pts(0.92, 1.02, 0.0, 0.14), -0.03, 0.05, axis='Y', mat=hm('Glass'))
    bars = boxes('bars', [((0.07, 0.05, 1.0), (0, -0.05, 0.65)), ((0.9, 0.05, 0.07), (0, -0.05, 0.65))], hm('TimberDark'))
    top = ybox('top', (1.4, 0.26, 0.14), (0, -0.07, 1.34), 'Timber', 0.04)
    ob = hfinish('win.cross', [fr, gl, bars, top, _sill(1.44)], 0.028)
    sock(ob, 'shutter', (0.62, -0.05, 0.1)); sock(ob, 'sill', (0, -0.12, 0.05))
    return ob


@hpart('win.round')
def _p():
    fr = torus('fr', 0.38, 0.075, (0, -0.02, 0.45), hm('Timber'), axis='Y', segs=20, rsegs=6)
    gl = disc('gl', 0.34, -0.03, 0.05, 0.45, 'Glass')
    bars = boxes('bars', [((0.06, 0.05, 0.7), (0, -0.05, 0.45)), ((0.7, 0.05, 0.06), (0, -0.05, 0.45))], hm('TimberDark'))
    sl = ybox('sill', (0.7, 0.26, 0.1), (0, -0.08, 0.02), 'Timber', 0.03)
    ob = hfinish('win.round', [fr, gl, bars, sl], 0.026)
    sock(ob, 'sill', (0, -0.1, 0.07))
    return ob


@hpart('win.slim')
def _p():
    fr = ring_frame('fr', arch_pts(0.74, 1.45), arch_pts(0.5, 1.2, 0.0, 0.13), -0.12, 0.1, 'Timber')
    gl = smooth(prism('gl', arch_pts(0.52, 1.21, 0.0, 0.12), -0.03, 0.05, axis='Y', mat=hm('Glass')), 30, weighted=False)
    bars = boxes('bars', [((0.5, 0.05, 0.06), (0, -0.05, 0.62))], hm('TimberDark'))
    ob = hfinish('win.slim', [fr, gl, bars, _sill(0.92)], 0.026)
    sock(ob, 'shutter', (0.39, -0.05, 0.1)); sock(ob, 'sill', (0, -0.12, 0.05))
    return ob


@hpart('win.oriel')
def _p():
    """A bay window on corbels with its own little roof: 1.9 wide, 0.6 out, 2.0 tall."""
    body = ybox('body', (1.8, 0.62, 1.55), (0, -0.25, 1.0), 'Wall', 0.04)
    corb = chunky(prism('corb', [(-0.9, 0.23), (0.9, 0.23), (0.6, 0.0), (-0.6, 0.0)], -0.56, 0.05, axis='Y', mat=hm('Timber')), 0.04)
    posts = boxes('posts', [((0.12, 0.12, 1.55), (x, -0.57, 1.0)) for x in (-0.86, -0.3, 0.3, 0.86)], hm('Timber'))
    rails = boxes('rails', [((1.86, 0.14, 0.12), (0, -0.57, z)) for z in (0.28, 1.72)], hm('Timber'))
    glass = boxes('gl', [((0.44, 0.04, 1.3), (x, -0.57, 1.0)) for x in (-0.58, 0.0, 0.58)], hm('Glass'))
    bars = boxes('bars', [((0.44, 0.05, 0.05), (x, -0.59, 1.1)) for x in (-0.58, 0.0, 0.58)], hm('TimberDark'))
    roof = chunky(prism('roof', [(0.1, 1.76), (-0.78, 1.8), (-0.78, 1.95), (0.1, 2.28)], -1.02, 1.02, axis='X', mat=hm('Roof')), 0.04)
    ob = hfinish('win.oriel', [body, corb, posts, rails, glass, bars, roof], 0.028)
    return ob


@hpart('dormer')
def _p():
    """A gabled dormer. Its body runs 2.4 back and 0.9 below the origin, so it sits into any roof it is placed on."""
    hw, eave, rise = 0.78, 1.28, 0.82
    body = chunky(prism('body', [(-hw, -0.9), (hw, -0.9), (hw, eave), (0, eave + rise - 0.1), (-hw, eave)], 0.0, 2.4, axis='Y', mat=hm('Wall')), 0.03)
    posts = boxes('posts', [((0.2, 0.2, eave + 0.9), (s * hw, -0.02, (eave - 0.9) / 2)) for s in (-1, 1)], hm('Timber'))
    plate = ybox('plate', (2 * hw + 0.3, 0.26, 0.2), (0, -0.04, eave + 0.02), 'Timber', 0.04)
    k = rise / (hw + 0.28); slabs, tiles = [], []
    for s in (-1, 1):
        slabs.append(chunky(prism(f'slab{s}', [(0, eave + rise), (s * (hw + 0.28), eave + rise - (hw + 0.28) * k), (s * (hw + 0.28), eave + rise - (hw + 0.28) * k - 0.16), (0, eave + rise - 0.16)], -0.3, 2.4, axis='Y', mat=hm('Roof')), 0.03))
        al = math.atan(k)
        for i, yc in enumerate((0.25, 1.05, 1.85)):
            t = box(f't{s}{i}', (hw + 0.36, 0.76, 0.18), (0, 0, 0), hm('Roof'))
            t.data.transform(Matrix.Translation((s * (hw + 0.36) / 2, 0, 0.09)))
            t.data.transform(Matrix.Rotation(s * (al - 0.08), 4, 'Y'))
            t.data.transform(Matrix.Translation((0, yc - 0.3, eave + rise - 0.02)))
            chunky(t, 0.05); tiles.append(t)
    cap = smooth(lathe('cap', [(0.12, -0.3), (0.18, -0.2), (0.18, 2.4), (0.12, 2.5)], axis='Y', segs=8, mat=hm('Roof'), center=(0, 0, eave + rise + 0.04)), 50, weighted=False)
    fr = ring_frame('wfr', rect_pts(0.9, 0.86, 0.0, 0.2), rect_pts(0.64, 0.6, 0.0, 0.33), -0.11, 0.06, 'Timber')
    gl = prism('wgl', rect_pts(0.66, 0.62, 0.0, 0.32), -0.03, 0.03, axis='Y', mat=hm('Glass'))
    bars = boxes('wb', [((0.06, 0.05, 0.6), (0, -0.05, 0.63)), ((0.64, 0.05, 0.06), (0, -0.05, 0.63))], hm('TimberDark'))
    return hfinish('dormer', [body, posts, plate] + slabs + tiles + [cap, fr, gl, bars], 0.03)

# ---------------------------------------------------------------- window and door trims


@hpart('shutter.plank')
def _p():
    pn = panel('pn', rect_pts(0.46, 1.26, 0.25), -0.04, 0.02, 'Accent', 0.02)
    grooves = boxes('gr', [((0.025, 0.02, 1.2), (x, -0.045, 0.63)) for x in (0.1, 0.25, 0.4)], hm('TimberDark'))
    battens = boxes('bt', [((0.4, 0.035, 0.08), (0.25, -0.06, z)) for z in (0.22, 1.04)], hm('TimberDark'))
    brace = chunky(strut('br', (0.08, -0.06, 0.26), (0.42, -0.06, 1.0), 0.07, 0.035, hm('TimberDark')), 0.01)
    return hfinish('shutter.plank', [pn, grooves, battens, brace], 0.02)


@hpart('shutter.louvre')
def _p():
    fr = ring_frame('fr', rect_pts(0.46, 1.26, 0.25), rect_pts(0.34, 1.12, 0.25, 0.07), -0.05, 0.02, 'Accent', 0.02)
    slats = boxes('sl', [((0.36, 0.03, 0.13), (0.25, -0.02, 0.17 + i * 0.155), ('X', 0.45)) for i in range(7)], hm('Accent'))
    return hfinish('shutter.louvre', [fr, slats], 0.02)


@hpart('flowerbox')
def _p():
    bx = ybox('box', (1.3, 0.3, 0.24), (0, -0.15, 0.12), 'Timber', 0.04)
    rim = boxes('rim', [((1.36, 0.05, 0.05), (0, -0.305, z)) for z in (0.05, 0.2)], hm('TimberDark'))
    rnd = random.Random(3); leaves, flowers = [], []
    for i in range(3):
        x = -0.4 + i * 0.4
        leaves.append(blob(f'lf{i}', (x, -0.15, 0.26), 0.2, hm('Leaf'), subd=2, scale=(1.25, 0.85, 0.7), jitter=0.12, seed=i))
    for i in range(5):
        x = -0.48 + i * 0.24 + rnd.uniform(-0.03, 0.03); y = -0.22 + rnd.uniform(-0.04, 0.04); z = 0.37 + rnd.uniform(0, 0.06)
        flowers.append(blob(f'fl{i}', (x, y, z), 0.065, hm('Petal' if i % 2 else 'Accent'), subd=1, scale=(1, 1, 0.7), jitter=0.0))
        flowers.append(blob(f'fc{i}', (x, y - 0.04, z + 0.01), 0.028, hm('Gold'), subd=1, jitter=0.0))
    return hfinish('flowerbox', [bx, rim] + leaves + flowers, 0.02)


@hpart('lantern')
def _p():
    arm = ybox('arm', (0.08, 0.52, 0.08), (0, -0.26, 0.36), 'Iron', 0.015)
    body = ybox('glow', (0.28, 0.28, 0.38), (0, -0.5, 0.0), 'Glow', 0.03)
    cap = lathe('cap', [(0.26, 0.18), (0.0, 0.45)], axis='Z', segs=4, mat=hm('Iron'))
    xform(cap, rot=[('Z', math.pi / 4)], loc=(0, -0.5, 0))
    base = ybox('base', (0.34, 0.34, 0.07), (0, -0.5, -0.22), 'Iron', 0.015)
    hook = ybox('hook', (0.04, 0.04, 0.16), (0, -0.5, 0.36), 'Iron', 0.0)
    return hfinish('lantern', [arm, body, cap, base, hook], 0.02)


@hpart('canopy.shed')
def _p():
    slab = chunky(prism('slab', [(0.02, 0.5), (-0.9, 0.1), (-0.9, -0.04), (0.02, 0.34)], -1.05, 1.05, axis='X', mat=hm('Roof')), 0.04)
    k = 0.4 / 0.92; al = math.atan(k); tiles = []
    for i, x in enumerate((-0.7, 0.0, 0.7)):
        t = box(f't{i}', (0.66, 1.0, 0.16), (0, 0, 0), hm('Roof'))
        t.data.transform(Matrix.Translation((0, -0.5, 0.08)))
        t.data.transform(Matrix.Rotation(al - 0.08, 4, 'X'))
        t.data.transform(Matrix.Translation((x, 0.0, 0.5)))
        chunky(t, 0.05); tiles.append(t)
    br = [chunky(strut(f'b{s}', (s * 0.85, -0.02, -0.45), (s * 0.85, -0.75, 0.12), 0.1, 0.1, hm('Timber')), 0.02) for s in (-1, 1)]
    return hfinish('canopy.shed', [slab] + tiles + br, 0.03)


@hpart('canopy.gable')
def _p():
    k = 0.9; hw = 1.0; slabs = []
    for s in (-1, 1):
        slabs.append(chunky(prism(f's{s}', [(0, 0.95), (s * hw, 0.95 - hw * k), (s * hw, 0.95 - hw * k - 0.14), (0, 0.81)], -0.95, 0.02, axis='Y', mat=hm('Roof')), 0.03))
    tym = chunky(prism('tym', [(-0.8, 0.12), (0.8, 0.12), (0, 0.84)], -0.9, -0.84, axis='Y', mat=hm('Wall')), 0.02)
    barge = [chunky(strut(f'bg{s}', (0, -0.93, 0.8), (s * (hw - 0.05), -0.93, 0.8 - (hw - 0.05) * k), 0.12, 0.08, hm('Timber')), 0.02) for s in (-1, 1)]
    beam = ybox('beam', (1.7, 0.12, 0.14), (0, -0.88, 0.08), 'Timber', 0.03)
    br = [chunky(strut(f'b{s}', (s * 0.8, -0.02, -0.5), (s * 0.8, -0.82, 0.05), 0.1, 0.1, hm('Timber')), 0.02) for s in (-1, 1)]
    cap = sphere('cap', (0, -0.95, 0.97), 0.08, 'Gold')
    return hfinish('canopy.gable', slabs + [tym] + barge + [beam] + br + [cap], 0.03)


@hpart('sign')
def _p():
    arm = ybox('arm', (0.06, 0.82, 0.07), (0, -0.4, 0.28), 'Iron', 0.01)
    curl = torus('curl', 0.12, 0.02, (0, -0.16, 0.14), hm('Iron'), axis='X', segs=10)
    board = ybox('board', (0.07, 0.72, 0.46), (0, -0.5, -0.12), 'Timber', 0.04)
    chains = boxes('ch', [((0.02, 0.02, 0.16), (0, y, 0.18)) for y in (-0.22, -0.78)], hm('Iron'))
    emblem = [smooth(prism(f'em{s}', [(math.cos(2 * math.pi * k / 16) * 0.13 - 0.5, -0.12 + math.sin(2 * math.pi * k / 16) * 0.13) for k in range(16)], s * 0.035, s * 0.06, axis='X', mat=hm('Accent')), 30, weighted=False) for s in (-1, 1)]
    return hfinish('sign', [arm, curl, board, chains] + emblem, 0.02)

# ---------------------------------------------------------------- roof pieces


@hpart('roof.ridge')
def _p():
    return hfinish('roof.ridge', [smooth(lathe('cap', [(0.2, -0.66), (0.31, -0.52), (0.31, 0.52), (0.2, 0.66)], axis='X', segs=8, mat=hm('Roof')), 50, weighted=False)], 0.045, (0.84, 0.78, 0.86))


@hpart('roof.ridge.thatch')
def _p():
    roll = smooth(lathe('roll', [(0.24, -0.7), (0.38, -0.5), (0.42, 0.0), (0.38, 0.5), (0.24, 0.7)], axis='X', segs=10, mat=hm('Roof')), 60, weighted=False)
    return hfinish('roof.ridge.thatch', [roll], 0.045, (0.84, 0.78, 0.86))


@hpart('roof.spire')
def _p():
    cone = smooth(lathe('cone', [(0.3, 0.0), (0.24, 0.12), (0.0, 0.75)], axis='Z', segs=12, mat=hm('Roof')), 50, weighted=False)
    ball = sphere('ball', (0, 0, 0.82), 0.1, 'Gold')
    return hfinish('roof.spire', [cone, ball], 0.03)


@hpart('roof.finial')
def _p():
    post = ybox('post', (0.1, 0.1, 0.6), (0, 0, 0.3), 'TimberDark', 0.02)
    collar = ybox('collar', (0.18, 0.18, 0.08), (0, 0, 0.55), 'Timber', 0.02)
    ball = sphere('ball', (0, 0, 0.72), 0.13, 'Gold')
    return hfinish('roof.finial', [post, collar, ball], 0.025)


@hpart('roof.vane')
def _p():
    rod = ybox('rod', (0.05, 0.05, 1.1), (0, 0, 0.55), 'Iron', 0.0)
    ball = sphere('ball', (0, 0, 0.5), 0.09, 'Gold')
    arms = boxes('arms', [((0.6, 0.03, 0.03), (0, 0, 0.66)), ((0.03, 0.6, 0.03), (0, 0, 0.66))], hm('Iron'))
    arrow = chunky(prism('arrow', [(-0.45, -0.03), (0.3, -0.03), (0.3, -0.09), (0.46, 0.0), (0.3, 0.09), (0.3, 0.03), (-0.45, 0.03)], 0.86, 0.9, axis='Z', mat=hm('Iron')), 0.0)
    tail = chunky(prism('tail', [(-0.45, 0.0), (-0.58, -0.12), (-0.36, -0.12), (-0.3, 0.0), (-0.36, 0.12), (-0.58, 0.12)], 0.86, 0.9, axis='Z', mat=hm('Iron')), 0.0)
    bird = chunky(prism('bird', [(-0.18, 0.0), (0.16, 0.0), (0.2, 0.12), (0.26, 0.2), (0.16, 0.26), (0.1, 0.18), (-0.02, 0.2), (-0.2, 0.32), (-0.14, 0.12)], -0.02, 0.02, axis='Y', mat=hm('Accent')), 0.01)
    xform(bird, loc=(0, 0, 0.92))
    return hfinish('roof.vane', [rod, ball, arms, arrow, tail, bird], 0.018)


@hpart('chimney.pot')
def _p():
    pot = smooth(lathe('pot', [(0.0, 0.0), (0.17, 0.0), (0.2, 0.06), (0.16, 0.3), (0.2, 0.36), (0.2, 0.42), (0.12, 0.42), (0.12, 0.3)], axis='Z', segs=12, mat=hm('Roof')), 40, weighted=False)
    return hfinish('chimney.pot', [pot], 0.025)

# ---------------------------------------------------------------- balcony and yard


@hpart('balcony')
def _p():
    floor = ybox('floor', (1.8, 0.72, 0.1), (0, -0.36, -0.05), 'Timber', 0.03)
    rails = boxes('rails', [((1.86, 0.1, 0.09), (0, -0.7, 0.9)), ((0.1, 0.72, 0.09), (-0.88, -0.36, 0.9)), ((0.1, 0.72, 0.09), (0.88, -0.36, 0.9))], hm('Timber'))
    bal = [((0.06, 0.06, 0.84), (-0.8 + i * 0.2, -0.7, 0.44)) for i in range(9)] + [((0.06, 0.06, 0.84), (s * 0.88, -0.36 + d, 0.44)) for s in (-1, 1) for d in (-0.2, 0.1)]
    balus = boxes('bal', bal, hm('TimberDark'))
    br = [chunky(strut(f'b{s}', (s * 0.7, -0.02, -0.6), (s * 0.7, -0.62, -0.1), 0.1, 0.1, hm('Timber')), 0.02) for s in (-1, 1)]
    return hfinish('balcony', [floor, rails, balus] + br, 0.025)


def _barrel(name, loc, s=1.0):
    body = lathe(name, [(0.0, 0.0), (0.37 * s, 0.0), (0.42 * s, 0.2 * s), (0.45 * s, 0.5 * s), (0.42 * s, 0.8 * s), (0.37 * s, s), (0.32 * s, s), (0.0, 0.96 * s)], axis='Z', segs=12, mat=hm('Timber'), cap=False)
    smooth(body, 20, weighted=False)
    bands = [lathe(f'{name}b{i}', [(r * s - 0.01, z * s), (r * s + 0.028, z * s + 0.01), (r * s + 0.028, z * s + 0.11), (r * s - 0.01, z * s + 0.12), (r * s - 0.01, z * s)], axis='Z', segs=12, mat=hm('Iron'), cap=False) for i, (r, z) in enumerate(((0.425, 0.14), (0.425, 0.74)))]
    for b in bands: smooth(b, 20, weighted=False)
    for o in [body] + bands: xform(o, loc=loc)
    return [body] + bands


@hpart('yard.barrels')
def _p():
    return hfinish('yard.barrels', _barrel('a', (-0.35, 0.0, 0.0)) + _barrel('b', (0.45, 0.15, 0.0), 0.85) + _barrel('c', (0.1, -0.55, 0.0), 0.65), 0.03, (0.72, 0.68, 0.8))


def _crate(name, size, loc, yaw=0.0):
    sx, sy, sz = size
    body = ybox(name, size, (0, 0, sz / 2), 'Timber', 0.03)
    edges = boxes(name + 'e', [((sx + 0.02, 0.07, 0.07), (0, s * (sy / 2 - 0.02), z)) for s in (-1, 1) for z in (0.05, sz - 0.05)]
                  + [((0.07, sy + 0.02, 0.07), (s * (sx / 2 - 0.02), 0, z)) for s in (-1, 1) for z in (0.05, sz - 0.05)]
                  + [((0.07, 0.07, sz), (sx2 * (sx / 2 - 0.02), sy2 * (sy / 2 - 0.02), sz / 2)) for sx2 in (-1, 1) for sy2 in (-1, 1)], hm('TimberDark'))
    for o in (body, edges): xform(o, rot=[('Z', yaw)], loc=loc)
    return [body, edges]


@hpart('yard.crates')
def _p():
    return hfinish('yard.crates', _crate('a', (0.7, 0.7, 0.6), (-0.3, 0.0, 0.0), 0.1) + _crate('b', (0.6, 0.6, 0.5), (0.45, 0.1, 0.0), -0.2) + _crate('c', (0.5, 0.5, 0.42), (-0.25, 0.05, 0.6), 0.35), 0.03)


@hpart('yard.woodpile')
def _p():
    logs = []
    rows = [(-0.42, 0.0), (-0.14, 0.0), (0.14, 0.0), (0.42, 0.0), (-0.28, 1), (0.0, 1), (0.28, 1), (-0.14, 2), (0.14, 2)]
    rnd = random.Random(7)
    for i, (x, r) in enumerate(rows):
        z = 0.14 + r * 0.25; ln = 1.1 + rnd.uniform(-0.1, 0.1)
        bark = smooth(lathe(f'l{i}', [(0.13, -ln / 2), (0.14, 0.0), (0.13, ln / 2)], axis='Y', segs=8, mat=hm('TimberDark'), center=(x, 0, z), cap=False), 50, weighted=False)
        ends = [prism(f'e{i}{s}', [(x + math.cos(2 * math.pi * k / 8) * 0.125, z + math.sin(2 * math.pi * k / 8) * 0.125) for k in range(8)], s * ln / 2 - 0.02, s * ln / 2 + 0.02, axis='Y', mat=hm('Timber')) for s in (-1, 1)]
        logs += [bark] + ends
    block = smooth(lathe('stump', [(0.26, 0.0), (0.27, 0.35), (0.0, 0.36)], axis='Z', segs=10, mat=hm('Timber'), center=(0.95, -0.2, 0)), 40, weighted=False)
    return hfinish('yard.woodpile', logs + [block], 0.025, (0.7, 0.66, 0.78))


@hpart('yard.bench')
def _p():
    seat = ybox('seat', (1.4, 0.42, 0.08), (0, -0.05, 0.45), 'Timber', 0.02)
    back = boxes('back', [((1.4, 0.06, 0.12), (0, 0.16, z)) for z in (0.66, 0.84)], hm('Timber'))
    legs = boxes('legs', [((0.08, 0.36, 0.45), (s * 0.58, -0.05, 0.22)) for s in (-1, 1)] + [((0.08, 0.06, 0.95), (s * 0.58, 0.16, 0.47)) for s in (-1, 1)], hm('TimberDark'))
    return hfinish('yard.bench', [seat, back, legs], 0.025)

# ---------------------------------------------------------------- build and ship


def build_house_parts():
    materials()
    for s in HSLOTS: hm(s)
    C = bpy.data.collections.get(PARTS_COLL_H) or bpy.data.collections.new(PARTS_COLL_H)
    if C.name not in bpy.data.scenes['Scene'].collection.children: bpy.data.scenes['Scene'].collection.children.link(C)
    doomed = list(C.objects); meshes = [o.data for o in doomed if o.type == 'MESH']
    for o in doomed: bpy.data.objects.remove(o, do_unlink=True)
    for me in meshes:
        if me.users == 0: bpy.data.meshes.remove(me)
    info = {}
    for pid in HPART_ORDER:
        ob = HPARTS[pid]()
        for o in [ob] + list(ob.children):
            for u in list(o.users_collection): u.objects.unlink(o)
            C.objects.link(o)
        info[pid] = tris([ob])
    C.hide_render = True; C.hide_viewport = True
    return {'parts': len(info), 'tris': sum(info.values()), 'each': info}


def house_parts_index():
    C = bpy.data.collections[PARTS_COLL_H]; idx = {}
    for pid in HPART_ORDER:
        ob = C.objects[pid]
        idx[pid] = {'sockets': sorted(ch['socket'] for ch in ob.children if 'socket' in ch)}
    return idx


def ship_house_parts(path=PARTS_GLB_H, index=PARTS_INDEX_H):
    """One GLB with every part (sockets as child empties) + the JS index the engine and tests validate against."""
    C = bpy.data.collections[PARTS_COLL_H]
    objs = [o for o in C.objects]
    gltf_mode(True)
    try:
        C.hide_viewport = False
        bpy.context.view_layer.update()
        size = export_glb(objs, path)
    finally:
        gltf_mode(False); C.hide_viewport = True
    idx = house_parts_index()
    with open(index, 'w') as f:
        f.write('// Generated by tools/blender/v2/arcade/house_parts.py (ship_house_parts): the house parts library\n'
                '// index - every part id with its sockets. The grammar rules are validated against it.\n'
                'export const HOUSE_PARTS = ' + json.dumps(idx, indent=1, sort_keys=True) + ';\n')
    return {'kb': round(size / 1024, 1), 'parts': len(idx), 'tris': tris([o for o in objs if o.type == 'MESH'])}
