"""Arcade SNOW parts library: everything the alpine snow village adds on top of the Arcade kit, in ONE GLB
(assets/v2/arcade/arcade-snow-parts.glb) that the snow biome's house, tree, nature and landmark rules all name as
their library.

  house     plank, arched and barn doors, glowing four-pane and arched windows with snowy sills and heads, shutters
            with a cut diamond, evergreen sill boxes, snow-laden porch canopies, lanterns, the workshop sign, the tower
            banner, the snow ridge bolster, the snowy spire, the chimney pot, the belfry bell and yard props (firewood,
            sled, barrels, crates, a snowman). HSE_<Slot> colour slots (white x the 'Col' gradient) like
            arcade-house-parts.glb; snow is its own slot, HSE_Snow, so the plan's colours fill it.
  tree      snow-laden conifer tiers and tops, and the bare tree's snowy twig ends (TRE_Leaf/Bark/Snow slots).
  nature    snowbanks, snowy rocks and stones, a snowy evergreen bush, grass poking through snow, a fallen log, a
            stump, firewood stacks, a sled, a lantern post, a barrel, frozen cattails, the fingerpost and the step
            stone (the kit's ARC_ materials plus ARC_Snow, ARC_Frost and the cool ARC_Slate rock).
  landmark  the bell tower with its clock over the square, the roofed well, the winter market stalls (ARC_ + LMK_).

Snow is always a rounded mass with real thickness that rests on something: slabs swell in the middle and round over
their edges, roofs carry a blanket with a cushioned lip, sills and caps sit on what holds them. Doors, glass and
silhouettes stay clear of it.

exec after vg.py, kit.py, nature.py, hero_corner.py, creature_parts.py, house_parts.py, nature_parts.py,
landmark_parts.py and tree_parts.py (same globals):
    g['build_snow_parts']()        every part into SNW_Parts (hidden; previews copy from it)
    g['show_snow_parts'](kinds)    coloured preview copies in rows in SNW_Show (the snow scene)
    g['ship_snow_parts']()         the GLB + src/world/snowParts.js (one index per kind)

Units are metres at game scale. Wall parts stand on the bottom centre of their opening on the wall plane and face -Y;
everything else stands on its origin. Sockets follow the house parts contract (house_parts.py).
"""
import bpy, bmesh, math, random, json
from mathutils import Vector, Matrix

PARTS_COLL_S = 'SNW_Parts'
SHOW_COLL_S = 'SNW_Show'
SCENE_S = 'SNW_Snow'
PARTS_GLB_S = OUT + '/arcade/arcade-snow-parts.glb'
PARTS_INDEX_S = globals().get('REPO', ROOT) + '/src/world/snowParts.js'
SPARTS, SPART_ORDER, SKIND = {}, [], {}

SNOW = '#eef5fc'
SNOW_SHADE = '#b1c2ea'
HSLOT_TOON['Snow'] = {'shade': SNOW_SHADE, 'rim': 0.25}
TSLOT_TOON['Snow'] = {'shade': SNOW_SHADE, 'rim': 0.25}

# The preview palette (the plans' own palettes come from the pack's snow rules).
SNOW_PREVIEW = {
    'Wall': '#f6ead4', 'Masonry': '#c9c6cf', 'Roof': '#c24a3c', 'Accent': '#c24a3c', 'Timber': '#b8773f', 'TimberDark': '#7c4a2d',
    'Log': '#c07a44', 'Plank': '#b98052', 'Stone': '#b8b9c6', 'StoneDark': '#858399', 'Iron': '#5e6275', 'Glass': '#5a78a8',
    'Glow': '#ffd873', 'Leaf': '#3f8a4f', 'Petal': '#fff6e8', 'Gold': '#e8b64a', 'Bark': '#6e5446', 'Snow': SNOW, 'Awning': '#c24a3c',
}
# Toon ramps (dark -> sunlit) for the vertex-coloured greens and bark.
PINE_S = ('#1f4f36', '#2f6e45', '#3f8a4f', '#58a65c')
BARK_S = ('#3f3029', '#56423a', '#6e5446', '#8a6b58')
STRAW = ('#6e5a3a', '#94794a', '#b89a5e', '#d8bf82')
NATURE_EXTRA = {'ARC_Snow': (SNOW, {'shade': SNOW_SHADE, 'rim': 0.25}), 'ARC_Frost': ('#d6e8f6', {'shade': '#9fb3de', 'rim': 0.3}),
                'ARC_Slate': ('#9aa2b6', {'shade': '#a09ac2'}), 'ARC_SlateDark': ('#7b8299', {'shade': '#9690bb'}),
                'ARC_Pine': ('#ffffff', {'shade': '#9bb6cc'}), 'ARC_Berry': ('#d8413f', {})}


def spart(pid, kind='house'):
    def reg(fn):
        SPARTS[pid] = fn; SPART_ORDER.append(pid); SKIND[pid] = kind; return fn
    return reg


def _sm():
    """The kit's ARC_ materials plus the snow village's own (toon-swapped by the engine like every ARC_ material)."""
    M = {m.name[4:]: m for m in bpy.data.materials if m.name.startswith('ARC_')}
    if 'Wood' not in M: M = materials(); set_look()
    for name, (hex_, kw) in NATURE_EXTRA.items():
        M[name[4:]] = bpy.data.materials.get(name) or toon(name, hex_, **kw)
    return M


def _cols(ob, fn):
    _set_col(ob, [fn(v) for v in ob.data.vertices])

# ---------------------------------------------------------------- snow shapes


def snow_slab(name, size, loc, mat, bulge=0.35, rot=None, segs=2, bev=None):
    """A soft snow slab w x d x t whose base centre sits on `loc`: rounded all round, its top swelling in the middle.
    `rot` ([(axis, angle)]) turns it about its base centre before it is moved."""
    w, d, t = size
    ob = rbox(name, (w, d, t), (0, 0, t / 2), mat, bev if bev is not None else min(t * 0.46, w * 0.24, d * 0.24), segs=segs)
    for v in ob.data.vertices:
        if v.co.z > t * 0.55:
            u = min(1.0, abs(v.co.x) / (w / 2)); q = min(1.0, abs(v.co.y) / (d / 2))
            v.co.z += t * bulge * (1 - u * u) * (1 - q * q)
    xform(ob, rot=rot, loc=loc)
    smooth(ob, 75, weighted=False)
    return ob


def snow_ball(name, loc, r, mat, squash=0.62, seed=0, subd=2):
    """A heaped mound of snow: a squashed, slightly lumpy sphere cut flat underneath."""
    ob = blob(name, (0, 0, 0), r, mat, subd=subd, scale=(1, 1, squash), jitter=0.05, seed=seed)
    for v in ob.data.vertices: v.co.z = max(v.co.z, -r * squash * 0.2)
    xform(ob, loc=loc)
    return ob


def snow_gable(name, half, k, y0, y1, ridge, mat, t=0.16, over=0.07, lip=0.05):
    """The snow blanket on a two-slope roof running along Y: its underside follows the roof (ridge height `ridge` at
    x = 0, falling `k` per metre to x = +-half), its top swells over each slope and rounds over the eaves a little
    past them (`over`), hanging `lip` below the roof's edge."""
    n = 5; top = []; bot = []
    for i in range(-n, n + 1):
        x = (half + over) * i / n; ax = abs(x); zr = ridge - k * min(ax, half)
        s = min(1.0, ax / half)
        swell = t * (1.0 + 0.35 * math.sin(math.pi * s)) if ax <= half else t * 0.8
        top.append((x, zr + swell - (lip + t * 0.6) * max(0.0, (ax - half) / over)))
        bot.append((x, zr - (lip if ax > half else 0.0)))
    pts = top + list(reversed(bot))
    ob = prism(name, list(reversed(pts)), y0, y1, axis='Y', mat=mat)
    chunky(ob, min(0.07, t * 0.4), 2)
    smooth(ob, 60, weighted=False)
    return ob


def snow_shed(name, run, k, x0, x1, top_z, mat, t=0.16, over=0.08, lip=0.05, out=-1):
    """The snow on a one-slope roof running along X from x0 to x1: its high edge on the wall (y = 0, z = top_z), the
    roof falling `k` per metre toward y = out * run."""
    n = 5; top = []; bot = []
    for i in range(n + 1):
        d = (run + over) * i / n; zr = top_z - k * min(d, run)
        s = min(1.0, d / run)
        swell = t * (1.0 + 0.3 * math.sin(math.pi * s)) if d <= run else t * 0.8
        top.append((out * d, zr + swell - (lip + t * 0.6) * max(0.0, (d - run) / over)))
        bot.append((out * d, zr - (lip if d > run else 0.0)))
    pts = top + list(reversed(bot))
    if out > 0: pts = list(reversed(pts))
    ob = prism(name, pts, x0, x1, axis='X', mat=mat)
    chunky(ob, min(0.07, t * 0.4), 2)
    smooth(ob, 60, weighted=False)
    return ob

# ---------------------------------------------------------------- house parts (HSE_ slots)


def _snowsill(w, y=-0.12, z=0.1, t=0.12):
    """A heap of snow along a sill: thick in the middle, tapering toward the ends."""
    return snow_slab('snsill', (w, 0.3, t), (0, y, z), hm('Snow'), bulge=0.55)


def _head(w, z, y=-0.08):
    """A timber head board over an opening with a snow cushion on it."""
    board = ybox('head', (w, 0.28, 0.16), (0, y, z + 0.08), 'Timber', 0.04)
    cap = snow_slab('snhead', (w - 0.06, 0.3, 0.11), (0, y - 0.01, z + 0.15), hm('Snow'), bulge=0.5)
    return [board, cap]


@spart('door.snow.plank')
def _s():
    """A heavy plank door in a timber frame: 1.3 wide, 2.05 tall, iron strap hinges and ring, a snowy head board."""
    fr = ring_frame('fr', rect_pts(1.3, 2.05), rect_pts(0.98, 1.9, 0.0, -0.3), -0.14, 0.1, 'Timber')
    pn = panel('pn', rect_pts(1.0, 1.9), -0.05, 0.05, 'Accent')
    grooves = boxes('gr', [((0.03, 0.03, 1.84), (x, -0.055, 0.95)) for x in (-0.25, 0.0, 0.25)], hm('TimberDark'))
    straps = boxes('st', [((0.62, 0.035, 0.09), (-0.16, -0.07, z)) for z in (0.45, 1.5)], hm('Iron'))
    ring = torus('rg', 0.08, 0.02, (0.3, -0.09, 1.0), hm('Iron'))
    ob = hfinish('door.snow.plank', [fr, pn, grooves, straps, ring] + _head(1.56, 2.05), 0.03)
    sock(ob, 'lamp', (0.95, 0, 1.3)); sock(ob, 'canopy', (0, 0, 2.2)); sock(ob, 'sign', (-0.95, 0, 1.9))
    return ob


@spart('door.snow.arched')
def _s():
    """A round-headed door in a chunky stone surround with a keystone: 1.36 wide, 2.1 tall, snow on the keystone."""
    sur = ring_frame('sur', arch_pts(1.56, 2.3), arch_pts(1.0, 2.2, 0.0, -0.3), -0.18, 0.1, 'Stone', 0.06)
    key = chunky(prism('key', [(-0.14, 2.12), (0.14, 2.12), (0.19, 2.42), (-0.19, 2.42)], -0.22, 0.08, axis='Y', mat=hm('StoneDark')), 0.03)
    pn = panel('pn', arch_pts(1.02, 1.94), -0.05, 0.05, 'Accent')
    planks = boxes('pl', [((0.035, 0.04, 1.5), (x, -0.06, 0.8)) for x in (-0.2, 0.2)], hm('TimberDark'))
    studs = [blob(f's{i}', (x, -0.08, z), 0.035, hm('Iron'), subd=1, jitter=0.0) for i, (x, z) in enumerate(((-0.34, 0.5), (0.34, 0.5), (-0.34, 1.3), (0.34, 1.3)))]
    knob = torus('kn', 0.08, 0.02, (0.28, -0.09, 0.98), hm('Gold'))
    cap = snow_slab('snkey', (0.5, 0.36, 0.12), (0, -0.07, 2.4), hm('Snow'), bulge=0.6)
    ob = hfinish('door.snow.arched', [sur, key, pn, planks, knob, cap] + studs, 0.03)
    sock(ob, 'lamp', (1.02, 0, 1.3)); sock(ob, 'canopy', (0, 0, 2.3)); sock(ob, 'sign', (-1.02, 0, 1.95))
    return ob


@spart('door.snow.double')
def _s():
    """The workshop's barn doors: two braced leaves in a heavy frame, 1.9 wide, 2.2 tall, snow on the lintel."""
    fr = ring_frame('fr', rect_pts(1.9, 2.2), rect_pts(1.6, 2.05, 0.0, -0.3), -0.14, 0.1, 'Timber')
    parts = [fr]
    for s in (-1, 1):
        x0 = s * 0.4
        parts.append(panel(f'lf{s}', rect_pts(0.78, 2.03, x0), -0.05, 0.05, 'Accent'))
        parts.append(boxes(f'rl{s}', [((0.7, 0.045, 0.12), (x0, -0.065, z)) for z in (0.25, 1.1, 1.85)], hm('TimberDark')))
        parts.append(chunky(strut(f'br{s}', (x0 - s * 0.3, -0.065, 0.32), (x0 + s * 0.3, -0.065, 1.03), 0.1, 0.045, hm('TimberDark')), 0.01))
        parts.append(chunky(strut(f'bu{s}', (x0 - s * 0.3, -0.065, 1.17), (x0 + s * 0.3, -0.065, 1.78), 0.1, 0.045, hm('TimberDark')), 0.01))
        parts.append(sphere(f'h{s}', (s * 0.09, -0.1, 1.05), 0.045, 'Iron'))
    ob = hfinish('door.snow.double', parts + _head(2.2, 2.2), 0.03)
    sock(ob, 'lamp', (1.25, 0, 1.35)); sock(ob, 'canopy', (0, 0, 2.35)); sock(ob, 'sign', (-1.3, 0, 2.0))
    return ob


def _panes(w, h, z0, glow=True):
    """Warm lit panes behind a cross of glazing bars."""
    gl = prism('gl', rect_pts(w, h, 0.0, z0), -0.03, 0.05, axis='Y', mat=hm('Glow' if glow else 'Glass'))
    bars = boxes('bars', [((0.07, 0.05, h), (0, -0.05, z0 + h / 2)), ((w, 0.05, 0.07), (0, -0.05, z0 + h * 0.55))], hm('TimberDark'))
    return [gl, bars]


@spart('win.snow.cross')
def _s():
    """A four-pane window with a warm glow: 1.1 wide, 1.25 tall; snow heaped on the sill and on the head board."""
    fr = ring_frame('fr', rect_pts(1.1, 1.25), rect_pts(0.8, 0.95, 0.0, 0.15), -0.12, 0.1, 'Timber')
    sill = ybox('sill', (1.3, 0.34, 0.12), (0, -0.1, 0.02), 'Timber', 0.04)
    ob = hfinish('win.snow.cross', [fr, sill, _snowsill(1.18, -0.12, 0.08)] + _panes(0.82, 0.97, 0.14) + _head(1.34, 1.25), 0.028)
    sock(ob, 'shutter', (0.57, -0.05, 0.1)); sock(ob, 'sill', (0, -0.14, 0.2))
    return ob


@spart('win.snow.arched')
def _s():
    """A round-headed window, 1.0 wide, 1.4 tall, lit, with a snowy sill."""
    fr = ring_frame('fr', arch_pts(1.0, 1.4), arch_pts(0.7, 1.12, 0.0, 0.15), -0.12, 0.1, 'Timber')
    gl = smooth(prism('gl', arch_pts(0.72, 1.13, 0.0, 0.14), -0.03, 0.05, axis='Y', mat=hm('Glow')), 30, weighted=False)
    bars = boxes('bars', [((0.07, 0.05, 1.08), (0, -0.05, 0.68)), ((0.7, 0.05, 0.07), (0, -0.05, 0.62))], hm('TimberDark'))
    sill = ybox('sill', (1.2, 0.34, 0.12), (0, -0.1, 0.02), 'Timber', 0.04)
    cap = snow_slab('sncap', (0.36, 0.3, 0.1), (0, -0.05, 1.38), hm('Snow'), bulge=0.6)
    ob = hfinish('win.snow.arched', [fr, gl, bars, sill, _snowsill(1.08, -0.12, 0.08), cap], 0.028)
    sock(ob, 'shutter', (0.52, -0.05, 0.1)); sock(ob, 'sill', (0, -0.14, 0.2))
    return ob


@spart('win.slim')
def _s():
    """A tall narrow lit window, 0.74 wide, 1.45 tall (towers and gables)."""
    fr = ring_frame('fr', arch_pts(0.74, 1.45), arch_pts(0.5, 1.2, 0.0, 0.13), -0.12, 0.1, 'Timber')
    gl = smooth(prism('gl', arch_pts(0.52, 1.21, 0.0, 0.12), -0.03, 0.05, axis='Y', mat=hm('Glow')), 30, weighted=False)
    bars = boxes('bars', [((0.5, 0.05, 0.06), (0, -0.05, 0.62))], hm('TimberDark'))
    sill = ybox('sill', (0.92, 0.34, 0.12), (0, -0.1, 0.02), 'Timber', 0.04)
    ob = hfinish('win.slim', [fr, gl, bars, sill, _snowsill(0.8, -0.12, 0.08)], 0.026)
    sock(ob, 'shutter', (0.39, -0.05, 0.1)); sock(ob, 'sill', (0, -0.14, 0.2))
    return ob


@spart('win.round')
def _s():
    """A round lit attic window, 0.9 across."""
    fr = torus('fr', 0.38, 0.075, (0, -0.02, 0.45), hm('Timber'), axis='Y', segs=20, rsegs=6)
    gl = disc('gl', 0.34, -0.03, 0.05, 0.45, 'Glow')
    bars = boxes('bars', [((0.06, 0.05, 0.7), (0, -0.05, 0.45)), ((0.7, 0.05, 0.06), (0, -0.05, 0.45))], hm('TimberDark'))
    cap = snow_slab('sncap', (0.42, 0.26, 0.09), (0, -0.04, 0.86), hm('Snow'), bulge=0.6)
    ob = hfinish('win.round', [fr, gl, bars, cap], 0.026)
    sock(ob, 'sill', (0, -0.1, 0.07))
    return ob


@spart('win.oriel')
def _s():
    """A bay window on corbels with its own snowy roof: 1.9 wide, 0.6 out, 2.0 tall."""
    body = ybox('body', (1.8, 0.62, 1.55), (0, -0.25, 1.0), 'Wall', 0.04)
    corb = chunky(prism('corb', [(-0.9, 0.23), (0.9, 0.23), (0.6, 0.0), (-0.6, 0.0)], -0.56, 0.05, axis='Y', mat=hm('Timber')), 0.04)
    posts = boxes('posts', [((0.12, 0.12, 1.55), (x, -0.57, 1.0)) for x in (-0.86, -0.3, 0.3, 0.86)], hm('Timber'))
    rails = boxes('rails', [((1.86, 0.14, 0.12), (0, -0.57, z)) for z in (0.28, 1.72)], hm('Timber'))
    glass = boxes('gl', [((0.44, 0.04, 1.3), (x, -0.57, 1.0)) for x in (-0.58, 0.0, 0.58)], hm('Glow'))
    bars = boxes('bars', [((0.44, 0.05, 0.05), (x, -0.59, 1.1)) for x in (-0.58, 0.0, 0.58)], hm('TimberDark'))
    roof = chunky(prism('roof', [(0.1, 1.76), (-0.78, 1.8), (-0.78, 1.95), (0.1, 2.28)], -1.02, 1.02, axis='X', mat=hm('Roof')), 0.04)
    snow = snow_shed('snroof', 0.88, 0.55, -1.0, 1.0, 2.28, hm('Snow'), t=0.14)
    xform(snow, loc=(0, 0.1, 0))
    return hfinish('win.oriel', [body, corb, posts, rails, glass, bars, roof, snow], 0.028)


@spart('balcony')
def _s():
    """An alpine balcony: a plank floor on brackets, a board railing with cut-out hearts, snow along its top rail."""
    floor = ybox('floor', (1.8, 0.72, 0.1), (0, -0.36, -0.05), 'Timber', 0.03)
    rail = ybox('rail', (1.86, 0.1, 0.1), (0, -0.7, 0.92), 'Timber', 0.02)
    sides = boxes('sides', [((0.1, 0.72, 0.1), (s * 0.88, -0.36, 0.92)) for s in (-1, 1)], hm('Timber'))
    boards = [ybox(f'bd{i}', (0.17, 0.05, 0.84), (-0.76 + i * 0.19, -0.7, 0.45), 'Accent' if i % 2 else 'Timber', 0.015) for i in range(9)]
    holes = [chunky(prism(f'ho{i}', [(-0.76 + i * 0.19, 0.5), (-0.76 + i * 0.19 + 0.05, 0.58), (-0.76 + i * 0.19, 0.66), (-0.76 + i * 0.19 - 0.05, 0.58)], -0.735, -0.72, axis='Y', mat=hm('TimberDark')), 0.0) for i in range(9)]
    br = [chunky(strut(f'b{s}', (s * 0.7, -0.02, -0.6), (s * 0.7, -0.62, -0.1), 0.1, 0.1, hm('Timber')), 0.02) for s in (-1, 1)]
    snow = snow_slab('snrail', (1.8, 0.16, 0.1), (0, -0.7, 0.97), hm('Snow'), bulge=0.5)
    return hfinish('balcony', [floor, rail, sides, snow] + boards + holes + br, 0.025)


@spart('dormer.snow')
def _s():
    """A gabled dormer under a snow blanket. Its body runs 2.4 back and 0.9 below the origin, into any roof."""
    hw, eave, rise = 0.78, 1.28, 0.9
    body = chunky(prism('body', [(-hw, -0.9), (hw, -0.9), (hw, eave), (0, eave + rise - 0.1), (-hw, eave)], 0.0, 2.4, axis='Y', mat=hm('Wall')), 0.03)
    posts = boxes('posts', [((0.2, 0.2, eave + 0.9), (s * hw, -0.02, (eave - 0.9) / 2)) for s in (-1, 1)], hm('Timber'))
    plate = ybox('plate', (2 * hw + 0.3, 0.26, 0.2), (0, -0.04, eave + 0.02), 'Timber', 0.04)
    k = rise / (hw + 0.28); slabs = []
    for s in (-1, 1):
        slabs.append(chunky(prism(f'slab{s}', [(0, eave + rise), (s * (hw + 0.28), eave + rise - (hw + 0.28) * k), (s * (hw + 0.28), eave + rise - (hw + 0.28) * k - 0.16), (0, eave + rise - 0.16)], -0.3, 2.4, axis='Y', mat=hm('Roof')), 0.03))
    snow = snow_gable('snow', hw + 0.28, k, -0.34, 2.4, eave + rise, hm('Snow'), t=0.15)
    fr = ring_frame('wfr', rect_pts(0.9, 0.86, 0.0, 0.2), rect_pts(0.64, 0.6, 0.0, 0.33), -0.11, 0.06, 'Timber')
    gl = prism('wgl', rect_pts(0.66, 0.62, 0.0, 0.32), -0.03, 0.03, axis='Y', mat=hm('Glow'))
    bars = boxes('wb', [((0.06, 0.05, 0.6), (0, -0.05, 0.63)), ((0.64, 0.05, 0.06), (0, -0.05, 0.63))], hm('TimberDark'))
    return hfinish('dormer.snow', [body, posts, plate] + slabs + [snow, fr, gl, bars], 0.03)


@spart('shutter.snow')
def _s():
    """A plank shutter in the accent colour with a cut diamond and two battens (the RIGHT shutter; the left mirrors)."""
    pn = panel('pn', rect_pts(0.42, 1.0, 0.23), -0.04, 0.02, 'Accent', 0.02)
    grooves = boxes('gr', [((0.025, 0.02, 0.96), (x, -0.045, 0.5)) for x in (0.1, 0.23, 0.36)], hm('TimberDark'))
    battens = boxes('bt', [((0.38, 0.035, 0.08), (0.23, -0.06, z)) for z in (0.16, 0.84)], hm('TimberDark'))
    dia = chunky(prism('dia', [(0.23, 0.36), (0.31, 0.5), (0.23, 0.64), (0.15, 0.5)], -0.06, -0.045, axis='Y', mat=hm('TimberDark')), 0.0)
    return hfinish('shutter.snow', [pn, grooves, battens, dia], 0.02)


@spart('sill.snow')
def _s():
    """A window box of evergreen sprigs and red berries under a cushion of snow."""
    bx = ybox('box', (1.1, 0.28, 0.22), (0, -0.14, -0.02), 'Timber', 0.04)
    rim = boxes('rim', [((1.16, 0.05, 0.05), (0, -0.29, z)) for z in (-0.08, 0.06)], hm('TimberDark'))
    P = [bx, rim]
    for i in range(3):
        P.append(blob(f'lf{i}', (-0.34 + i * 0.34, -0.14, 0.14), 0.17, hm('Leaf'), subd=2, scale=(1.3, 0.8, 0.62), jitter=0.12, seed=i))
    for i, (x, y) in enumerate(((-0.42, -0.26), (-0.12, -0.28), (0.2, -0.27), (0.44, -0.24))):
        P.append(blob(f'be{i}', (x, y, 0.16), 0.045, hm('Accent'), subd=1, jitter=0.0))
    for i, x in enumerate((-0.3, 0.12, 0.38)):
        P.append(snow_slab(f'sn{i}', (0.34, 0.2, 0.07), (x, -0.14, 0.22), hm('Snow'), bulge=0.7))
    return hfinish('sill.snow', P, 0.02)


@spart('canopy.snow')
def _s():
    """A gabled porch roof on two braces over the door, carrying a thick snow blanket with a soft lip."""
    k = 0.95; hw = 1.05; slabs = []
    for s in (-1, 1):
        slabs.append(chunky(prism(f's{s}', [(0, 1.0), (s * hw, 1.0 - hw * k), (s * hw, 1.0 - hw * k - 0.14), (0, 0.86)], -1.05, 0.02, axis='Y', mat=hm('Roof')), 0.03))
    snow = snow_gable('snow', hw, k, -1.1, 0.02, 1.0, hm('Snow'), t=0.17)
    tym = chunky(prism('tym', [(-0.84, 0.1), (0.84, 0.1), (0, 0.9)], -1.0, -0.94, axis='Y', mat=hm('Wall')), 0.02)
    barge = [chunky(strut(f'bg{s}', (0, -1.03, 0.86), (s * (hw - 0.05), -1.03, 0.86 - (hw - 0.05) * k), 0.13, 0.08, hm('Timber')), 0.02) for s in (-1, 1)]
    beam = ybox('beam', (1.8, 0.14, 0.16), (0, -0.97, 0.06), 'Timber', 0.03)
    br = [chunky(strut(f'b{s}', (s * 0.84, -0.02, -0.55), (s * 0.84, -0.92, 0.05), 0.12, 0.12, hm('Timber')), 0.02) for s in (-1, 1)]
    return hfinish('canopy.snow', slabs + [snow, tym] + barge + [beam] + br, 0.03)


@spart('canopy.snow.shed')
def _s():
    """A shed porch roof on braces, snow on it: the workshop's wide door gets it."""
    slab = chunky(prism('slab', [(0.02, 0.55), (-1.0, 0.1), (-1.0, -0.04), (0.02, 0.4)], -1.3, 1.3, axis='X', mat=hm('Roof')), 0.04)
    snow = snow_shed('snow', 1.0, 0.45, -1.3, 1.3, 0.55, hm('Snow'), t=0.16)
    br = [chunky(strut(f'b{s}', (s * 1.1, -0.02, -0.5), (s * 1.1, -0.85, 0.12), 0.12, 0.12, hm('Timber')), 0.02) for s in (-1, 1)]
    return hfinish('canopy.snow.shed', [slab, snow] + br, 0.03)


@spart('lantern.snow')
def _s():
    """A wall lantern on an iron bracket, glowing warm, a little snow on its hood."""
    arm = ybox('arm', (0.08, 0.52, 0.08), (0, -0.26, 0.36), 'Iron', 0.015)
    body = ybox('glow', (0.28, 0.28, 0.38), (0, -0.5, 0.0), 'Glow', 0.03)
    posts = boxes('cage', [((0.05, 0.05, 0.4), (sx * 0.14, -0.5 + sy * 0.14, 0.0)) for sx in (-1, 1) for sy in (-1, 1)], hm('Iron'))
    cap = lathe('cap', [(0.26, 0.18), (0.0, 0.42)], axis='Z', segs=4, mat=hm('Iron'))
    xform(cap, rot=[('Z', math.pi / 4)], loc=(0, -0.5, 0))
    snow = snow_ball('sn', (0, -0.5, 0.25), 0.16, hm('Snow'), squash=0.55, seed=3)
    base = ybox('base', (0.34, 0.34, 0.07), (0, -0.5, -0.22), 'Iron', 0.015)
    return hfinish('lantern.snow', [arm, body, posts, cap, snow, base], 0.02)


@spart('sign.workshop')
def _s():
    """The workshop's hanging sign: a board with a crossed hammer and saw, snow along its top."""
    arm = ybox('arm', (0.06, 0.9, 0.07), (0, -0.44, 0.3), 'Iron', 0.01)
    curl = torus('curl', 0.12, 0.02, (0, -0.16, 0.16), hm('Iron'), axis='X', segs=10)
    board = ybox('board', (0.08, 0.76, 0.6), (0, -0.54, -0.14), 'Accent', 0.04)
    rim = boxes('rim', [((0.1, 0.8, 0.05), (0, -0.54, z)) for z in (-0.44, 0.16)], hm('Timber'))
    chains = boxes('ch', [((0.02, 0.02, 0.16), (0, y, 0.2)) for y in (-0.22, -0.86)], hm('Iron'))
    em = []
    for s in (-1, 1):
        handle = chunky(strut(f'hh{s}', (s * 0.05, -0.34, -0.36), (s * 0.05, -0.72, 0.06), 0.06, 0.04, hm('Timber')), 0.005)
        head = rbox(f'hd{s}', (0.05, 0.2, 0.09), (s * 0.05, -0.74, 0.08), hm('Iron'), 0.01)
        saw = chunky(strut(f'sw{s}', (s * 0.05, -0.74, -0.36), (s * 0.05, -0.36, 0.04), 0.12, 0.03, hm('Iron')), 0.005)
        em += [handle, head, saw]
    snow = snow_slab('sn', (0.14, 0.72, 0.08), (0, -0.54, 0.18), hm('Snow'), bulge=0.6)
    return hfinish('sign.workshop', [arm, curl, board, rim, chains, snow] + em, 0.02)


@spart('banner.snow')
def _s():
    """The watchtower's banner: a red cloth with a pointed foot and a white diamond, hung from a rod. 0.9 x 1.9."""
    rod = ybox('rod', (1.1, 0.08, 0.08), (0, -0.1, 1.9), 'Iron', 0.01)
    ends = [sphere(f'e{s}', (s * 0.58, -0.1, 1.9), 0.06, 'Gold') for s in (-1, 1)]
    cloth = chunky(prism('cloth', [(-0.44, 1.86), (-0.44, 0.35), (0.0, 0.0), (0.44, 0.35), (0.44, 1.86)], -0.1, -0.04, axis='Y', mat=hm('Accent')), 0.012)
    trim = chunky(prism('trim', [(-0.44, 1.7), (0.44, 1.7), (0.44, 1.78), (-0.44, 1.78)], -0.11, -0.1, axis='Y', mat=hm('Gold')), 0.0)
    dia = chunky(prism('dia', [(0, 0.62), (0.22, 0.98), (0, 1.34), (-0.22, 0.98)], -0.12, -0.1, axis='Y', mat=hm('Petal')), 0.005)
    dot = chunky(prism('dot', [(0, 0.86), (0.08, 0.98), (0, 1.1), (-0.08, 0.98)], -0.125, -0.12, axis='Y', mat=hm('Accent')), 0.0)
    snow = snow_slab('sn', (1.0, 0.14, 0.07), (0, -0.1, 1.93), hm('Snow'), bulge=0.5)
    return hfinish('banner.snow', [rod, cloth, trim, dia, dot, snow] + ends, 0.022)


@spart('roof.ridge.snow')
def _s():
    """The snow bolster along a ridge or a hip: a soft round roll 1.32 long that covers where the blankets meet."""
    roll = smooth(lathe('roll', [(0.3, -0.74), (0.38, -0.6), (0.41, -0.25), (0.41, 0.25), (0.38, 0.6), (0.3, 0.74)], axis='X', segs=10, mat=hm('Snow')), 60, weighted=False)
    xform(roll, scale=(1, 1.15, 0.66), loc=(0, 0, 0.08))
    return hfinish('roof.ridge.snow', [roll], 0.035, (0.9, 0.9, 0.94))


@spart('roof.spire')
def _s():
    """A snowy finial for a pyramid or cone tip: a short roof-coloured cone under a snow cap and a gold ball."""
    cone = smooth(lathe('cone', [(0.34, 0.0), (0.28, 0.12), (0.0, 0.8)], axis='Z', segs=12, mat=hm('Roof')), 50, weighted=False)
    snow = smooth(lathe('snow', [(0.0, 0.2), (0.4, 0.18), (0.44, 0.08), (0.3, 0.02), (0.0, 0.06)], axis='Z', segs=12, mat=hm('Snow')), 60, weighted=False)
    post = ybox('post', (0.08, 0.08, 0.4), (0, 0, 0.9), 'Iron', 0.0)
    ball = sphere('ball', (0, 0, 1.12), 0.11, 'Gold')
    return hfinish('roof.spire', [cone, snow, post, ball], 0.03)


@spart('chimney.pot')
def _s():
    pot = smooth(lathe('pot', [(0.0, 0.0), (0.17, 0.0), (0.2, 0.06), (0.16, 0.3), (0.2, 0.36), (0.2, 0.42), (0.12, 0.42), (0.12, 0.3)], axis='Z', segs=12, mat=hm('Roof')), 40, weighted=False)
    ring = smooth(lathe('ring', [(0.12, 0.44), (0.22, 0.43), (0.24, 0.38), (0.2, 0.34), (0.12, 0.36)], axis='Z', segs=12, mat=hm('Snow')), 60, weighted=False)
    return hfinish('chimney.pot', [pot, ring], 0.025)


@spart('bell.hang')
def _s():
    """The belfry's bell: a yoke beam across the top plate (origin on its top) and a bronze bell hanging from it."""
    beam = ybox('beam', (3.2, 0.26, 0.26), (0, 0, -0.13), 'Timber', 0.04)
    yoke = ybox('yoke', (0.5, 0.3, 0.26), (0, 0, -0.38), 'TimberDark', 0.04)
    bell = smooth(lathe('bell', [(0.0, -0.46), (0.16, -0.48), (0.24, -0.56), (0.28, -0.8), (0.34, -1.0), (0.46, -1.16), (0.47, -1.22), (0.38, -1.2), (0.0, -1.14)], axis='Z', segs=16, mat=hm('Gold')), 45, weighted=False)
    lip = torus('lip', 0.45, 0.035, (0, 0, -1.19), hm('Gold'), axis='Z', segs=16, rsegs=5)
    clap = sphere('clap', (0, 0, -1.2), 0.08, 'Iron')
    return hfinish('bell.hang', [beam, yoke, bell, lip, clap], 0.03)


def _logs(name, n_rows, width, depth, r=0.12, x0=0.0, y0=0.0, z0=0.0, seed=7):
    """Split firewood in a stack: rows of rounds seen end-on (their pale cut faces toward -Y)."""
    rnd = random.Random(seed); P = []
    for row in range(n_rows):
        n = max(1, int(width / (2 * r + 0.01)) - (row % 2))
        for i in range(n):
            x = x0 - width / 2 + r + (row % 2) * r + i * (2 * r + 0.01) + rnd.uniform(-0.01, 0.01); z = z0 + r + row * (2 * r * 0.9)
            rr = r * rnd.uniform(0.9, 1.05)
            bark = lathe(f'{name}{row}{i}', [(rr, y0 - depth / 2), (rr, y0 + depth / 2)], axis='Y', segs=7, mat=hm('TimberDark'), center=(x, 0, z))
            end = prism(f'{name}e{row}{i}', [(x + math.cos(2 * math.pi * k / 7) * rr * 0.9, z + math.sin(2 * math.pi * k / 7) * rr * 0.9) for k in range(7)], y0 - depth / 2 - 0.015, y0 - depth / 2 + 0.01, axis='Y', mat=hm('Timber'))
            P += [bark, end]
    return P


@spart('yard.firewood')
def _s():
    """A stack of split firewood against the wall under a snow cushion, a chopping block with an axe beside it."""
    P = _logs('lg', 4, 1.3, 0.5, 0.12, -0.15, 0.0, 0.0)
    P.append(snow_slab('sn', (1.32, 0.56, 0.14), (-0.15, 0.0, 0.84), hm('Snow'), bulge=0.5))
    block = smooth(lathe('blk', [(0.27, 0.0), (0.28, 0.42), (0.0, 0.43)], axis='Z', segs=10, mat=hm('Timber'), center=(0.85, -0.25, 0)), 40, weighted=False)
    snb = snow_ball('snb', (0.85, -0.25, 0.43), 0.22, hm('Snow'), squash=0.45, seed=5)
    handle = chunky(strut('ax', (0.85, -0.25, 0.44), (0.72, -0.4, 1.02), 0.06, 0.05, hm('Timber')), 0.01)
    head = rbox('axh', (0.08, 0.26, 0.16), (0.85, -0.25, 0.5), hm('Iron'), 0.015)
    return hfinish('yard.firewood', P + [block, snb, handle, head], 0.025, (0.72, 0.68, 0.8))


def _sled(name, s=1.0, slot=None, mats=None):
    """A wooden sled: curled runners, red slats, a rope; about 1.3 m long."""
    M = mats or {k: hm(k) for k in ('Timber', 'TimberDark', 'Accent', 'Iron')}
    P = []
    for sy in (-1, 1):
        run = [(-0.62, 0.02), (0.5, 0.02), (0.62, 0.08), (0.68, 0.2), (0.62, 0.3), (0.54, 0.26), (0.58, 0.18), (0.5, 0.1), (-0.62, 0.1)]
        r = chunky(prism(f'{name}r{sy}', [(x * s, z * s) for x, z in run], sy * 0.26 * s - 0.03, sy * 0.26 * s + 0.03, axis='Y', mat=M['Iron']), 0.01)
        P.append(r)
        for x in (-0.4, 0.0, 0.36):
            P.append(rbox(f'{name}p{sy}{x}', (0.06 * s, 0.06 * s, 0.2 * s), (x * s, sy * 0.26 * s, 0.2 * s), M['TimberDark'], 0.01))
    for i, x in enumerate((-0.5, -0.3, -0.1, 0.1, 0.3)):
        P.append(rbox(f'{name}s{i}', (0.16 * s, 0.66 * s, 0.05 * s), (x * s, 0, 0.32 * s), M['Accent'] if i % 2 == 0 else M['Timber'], 0.015))
    P.append(rbox(f'{name}bar', (0.06 * s, 0.7 * s, 0.07 * s), (0.5 * s, 0, 0.34 * s), M['Timber'], 0.015))
    return P


@spart('yard.sled')
def _s():
    P = _sled('sl')
    P.append(snow_slab('sn', (0.5, 0.5, 0.08), (-0.25, 0.0, 0.35), hm('Snow'), bulge=0.6))
    for o in P: xform(o, rot=[('Z', 0.35)])
    return hfinish('yard.sled', P, 0.025)


def _barrel_s(name, loc, s=1.0):
    body = lathe(name, [(0.0, 0.0), (0.37 * s, 0.0), (0.42 * s, 0.2 * s), (0.45 * s, 0.5 * s), (0.42 * s, 0.8 * s), (0.37 * s, s), (0.32 * s, s), (0.0, 0.96 * s)], axis='Z', segs=12, mat=hm('Timber'), cap=False)
    smooth(body, 20, weighted=False)
    bands = [lathe(f'{name}b{i}', [(r * s - 0.01, z * s), (r * s + 0.028, z * s + 0.01), (r * s + 0.028, z * s + 0.11), (r * s - 0.01, z * s + 0.12), (r * s - 0.01, z * s)], axis='Z', segs=12, mat=hm('Iron'), cap=False) for i, (r, z) in enumerate(((0.425, 0.14), (0.425, 0.74)))]
    for b in bands: smooth(b, 20, weighted=False)
    cap = smooth(lathe(f'{name}sn', [(0.0, s + 0.12 * s), (0.28 * s, s + 0.1 * s), (0.4 * s, s + 0.03 * s), (0.38 * s, s - 0.03 * s), (0.0, s - 0.02 * s)], axis='Z', segs=12, mat=hm('Snow')), 60, weighted=False)
    for o in [body, cap] + bands: xform(o, loc=loc)
    return [body, cap] + bands


@spart('yard.barrels.snow')
def _s():
    return hfinish('yard.barrels.snow', _barrel_s('a', (-0.35, 0.0, 0.0)) + _barrel_s('b', (0.45, 0.15, 0.0), 0.85), 0.03, (0.72, 0.68, 0.8))


@spart('yard.crates.snow')
def _s():
    P = _crate('a', (0.7, 0.7, 0.6), (-0.3, 0.0, 0.0), 0.1) + _crate('b', (0.6, 0.6, 0.5), (0.45, 0.1, 0.0), -0.2)
    P.append(snow_slab('sa', (0.66, 0.66, 0.1), (-0.3, 0.0, 0.6), hm('Snow'), bulge=0.5, rot=[('Z', 0.1)]))
    P.append(snow_slab('sb', (0.56, 0.56, 0.09), (0.45, 0.1, 0.5), hm('Snow'), bulge=0.5, rot=[('Z', -0.2)]))
    return hfinish('yard.crates.snow', P, 0.03)


@spart('yard.snowman')
def _s():
    """A villager's snowman: three snowballs, pebble eyes and buttons, a carrot nose, twig arms, a knitted scarf."""
    P = [snow_ball('b0', (0, 0, 0.28), 0.4, hm('Snow'), squash=0.85, seed=1, subd=2),
         blob('b1', (0, 0, 0.8), 0.3, hm('Snow'), subd=2, jitter=0.04, seed=2), blob('b2', (0, 0, 1.2), 0.21, hm('Snow'), subd=2, jitter=0.03, seed=3)]
    for o in P: smooth(o, 80, weighted=False)
    P += [sphere(f'e{s}', (s * 0.08, -0.18, 1.26), 0.03, 'Iron') for s in (-1, 1)]
    P += [sphere(f'bt{i}', (0, -0.29, 0.72 + i * 0.13), 0.035, 'Iron') for i in range(2)]
    nose = smooth(lathe('nose', [(0.045, 0.0), (0.0, 0.2)], axis='Y', segs=8, mat=hm('Gold')), 40, weighted=False)
    xform(nose, rot=[('X', math.pi)], loc=(0, -0.19, 1.2))
    scarf = torus('scarf', 0.22, 0.06, (0, 0, 1.02), hm('Accent'), axis='Z', segs=12, rsegs=5)
    tail = rbox('tail', (0.12, 0.05, 0.3), (0.12, -0.2, 0.86), hm('Accent'), 0.02)
    arms = [limb(f'a{s}', (s * 0.24, 0, 0.86), (s * 0.62, -0.05, 1.12), 0.025, 0.015, hm('TimberDark'), segs=5) for s in (-1, 1)]
    return hfinish('yard.snowman', P + [nose, scarf, tail] + arms, 0.025, (0.9, 0.9, 0.95))

# ---------------------------------------------------------------- tree parts: snowy conifer tiers, bare twigs (TRE_ slots)


def _snow_tier(pid, lite, R=1.4, H=1.4, seed=21):
    """A drooping conical tier hanging from its socket at the trunk (the meadow conifer's shape) with a snow
    shell over its upper face: thick at the middle, fraying into rounded tongues on the scalloped rim."""
    segs = 10 if lite else 18; rnd = random.Random(seed)
    top = 0.15; base = top - H
    prof = [(0.0, top), (R * 0.3, base + H * 0.76), (R * 0.72, base + H * 0.3), (R, base), (R * 0.6, base + 0.14), (0.0, base + 0.3)]
    t = lathe(pid + '_g', prof, axis='Z', segs=segs, mat=tm('Leaf'))
    lobes = 5 if lite else 8; ph = rnd.uniform(0, 6.28)
    def wob(v, amt):
        a = math.atan2(v.co.y, v.co.x); rr = math.hypot(v.co.x, v.co.y)
        if rr > R * 0.5:
            k = 1 + amt * math.cos(lobes * a + ph) * (rr / R); v.co.x *= k; v.co.y *= k
            v.co.z -= 0.12 * (rr / R) * (0.5 + 0.5 * math.cos(lobes * a + ph))
    for v in t.data.vertices: wob(v, 0.13)
    t.data.shade_smooth()
    _set_col(t, [mult_ramp(PINE_S, 0.3 + 0.45 * (v.co.z - base) / H + 0.1 * max(0.0, v.normal.z) - (0.35 if v.normal.z < -0.3 else 0.0)) for v in t.data.vertices])
    # the snow: a shell over the top two thirds, lifted 5-10 cm, its rim lobed like the tier's so it hangs in tongues
    sp = [(0.0, top + 0.12), (R * 0.3, base + H * 0.76 + 0.11), (R * 0.66, base + H * 0.34 + 0.09), (R * 0.86, base + H * 0.12 + 0.04),
          (R * 0.8, base + H * 0.1 - 0.04), (R * 0.6, base + H * 0.3 - 0.02), (R * 0.25, base + H * 0.76 - 0.04), (0.0, top - 0.02)]
    s = lathe(pid + '_s', sp, axis='Z', segs=segs, mat=tm('Snow'))
    for v in s.data.vertices:
        a = math.atan2(v.co.y, v.co.x); rr = math.hypot(v.co.x, v.co.y)
        if rr > R * 0.5:
            c = math.cos(lobes * a + ph); k = 1 + (0.13 + 0.08 * c) * c * (rr / R)
            v.co.x *= k; v.co.y *= k; v.co.z -= 0.12 * (rr / R) * (0.5 + 0.5 * c) + 0.06 * max(0.0, c) * (rr / R)
    s.data.shade_smooth(); ensure_grad([s])
    ob = merge(pid, [t, s])
    return tfinish(pid, ob)


@spart('snowpine.tier', 'tree')
def _s(): return _snow_tier('snowpine.tier', False)
@spart('snowpine.tier.lite', 'tree')
def _s(): return _snow_tier('snowpine.tier.lite', True)


def _snow_spire(pid, lite):
    segs = 8 if lite else 12; rnd = random.Random(22)
    prof = [(0.0, 1.3), (0.22, 0.85), (0.42, 0.35), (0.55, -0.2), (0.32, -0.08), (0.0, 0.0)]
    t = lathe(pid + '_g', prof, axis='Z', segs=segs, mat=tm('Leaf')); ph = rnd.uniform(0, 6.28)
    for v in t.data.vertices:
        a = math.atan2(v.co.y, v.co.x); rr = math.hypot(v.co.x, v.co.y)
        if rr > 0.3:
            k = 1 + 0.12 * math.cos(5 * a + ph); v.co.x *= k; v.co.y *= k; v.co.z -= 0.08 * (0.5 + 0.5 * math.cos(5 * a + ph))
    t.data.shade_smooth()
    _set_col(t, [mult_ramp(PINE_S, 0.4 + 0.45 * (v.co.z + 0.2) / 1.5 + 0.1 * max(0.0, v.normal.z) - (0.35 if v.normal.z < -0.3 else 0.0)) for v in t.data.vertices])
    s = lathe(pid + '_s', [(0.0, 1.42), (0.2, 1.0), (0.34, 0.62), (0.4, 0.5), (0.3, 0.52), (0.14, 0.9), (0.0, 1.2)], axis='Z', segs=segs, mat=tm('Snow'))
    for v in s.data.vertices:
        a = math.atan2(v.co.y, v.co.x); c = math.cos(5 * a + ph)
        if math.hypot(v.co.x, v.co.y) > 0.25: v.co.x *= 1 + 0.14 * c; v.co.y *= 1 + 0.14 * c; v.co.z -= 0.08 * max(0.0, c)
    s.data.shade_smooth(); ensure_grad([s])
    return tfinish(pid, merge(pid, [t, s]))


@spart('snowpine.top', 'tree')
def _s(): return _snow_spire('snowpine.top', False)
@spart('snowpine.top.lite', 'tree')
def _s(): return _snow_spire('snowpine.top.lite', True)


def _twig(pid, lite, seed, n=3, L=0.55):
    """A bare tree's branch end: a few forked twigs (the bark slot) and one cushion of snow resting in the fork, so
    the crown reads as dark branches dusted white, not as a cluster of puffs."""
    rnd = random.Random(seed); P = []
    for k in range(n if not lite else 2):
        a = 2 * math.pi * k / n + rnd.uniform(-0.3, 0.3); up = rnd.uniform(0.35, 0.7)
        tip = Vector((math.cos(a) * L * 0.8, math.sin(a) * L * 0.8, L * up))
        tw = limb(f'{pid}_t{k}', (0, 0, -0.05), tip, 0.045, 0.018, tm('Bark'), segs=5 if not lite else 4)
        _cols(tw, lambda v: mult_ramp(BARK_S, 0.35 + 0.4 * max(0.0, v.normal.z)))
        P.append(tw)
        if not lite:
            fork = tip * 0.55 + Vector((math.cos(a + 1.2) * 0.2, math.sin(a + 1.2) * 0.2, 0.18))
            f = limb(f'{pid}_f{k}', tip * 0.5, fork, 0.025, 0.012, tm('Bark'), segs=4)
            _cols(f, lambda v: mult_ramp(BARK_S, 0.4)); P.append(f)
    P.append(blob(f'{pid}_c', (0, 0, 0.08), 0.2, tm('Snow'), subd=2, scale=(1.4, 1.2, 0.45), jitter=0.05, seed=seed))
    ensure_grad([o for o in P if o.data.materials[0].name == 'TRE_Snow'])
    return tfinish(pid, merge(pid, P))


@spart('bare.twig.a', 'tree')
def _s(): return _twig('bare.twig.a', False, 51)
@spart('bare.twig.a.lite', 'tree')
def _s(): return _twig('bare.twig.a.lite', True, 51)
@spart('bare.twig.b', 'tree')
def _s(): return _twig('bare.twig.b', False, 52, n=2, L=0.45)
@spart('bare.twig.b.lite', 'tree')
def _s(): return _twig('bare.twig.b.lite', True, 52, n=2, L=0.45)

# ---------------------------------------------------------------- nature parts (ARC_ materials)


def _slate(name, M, size, seed, dark=False, loc=(0.0, 0.0, 0.0), yaw=0.0, cap=True):
    """A cool grey boulder with a snow cap resting on its top, the cap rounding over the edges a little."""
    ob = rock(name, size, M['SlateDark' if dark else 'Slate'], seed=seed, yaw=yaw, round_=0.3)
    h = size[2]
    _cols(ob, lambda v: tuple(c * (0.78 + 0.22 * min(1.0, v.co.z / h)) for c in (1.0, 1.0, 1.0)))
    P = [ob]
    if cap:
        c = snow_slab(name + 's', (size[0] * 0.86, size[1] * 0.84, h * 0.26), (0, 0, h * 0.84), M['Snow'], bulge=0.5, rot=[('Z', yaw)])
        P.append(c)
    for o in P: xform(o, loc=loc)
    return P


@spart('rock.snow.a', 'nature')
def _s():
    M = _sm(); return nfinish('rock.snow.a', _slate('rsa0', M, (1.4, 1.1, 0.9), 3) + _slate('rsa1', M, (0.7, 0.6, 0.45), 4, True, (0.9, -0.35, 0), 0.5), 0.035)


@spart('rock.snow.b', 'nature')
def _s():
    M = _sm()
    return nfinish('rock.snow.b', _slate('rsb0', M, (1.0, 0.9, 1.2), 5) + _slate('rsb1', M, (0.9, 0.75, 0.55), 6, True, (0.55, 0.5, 0), 0.9) + _slate('rsb2', M, (0.45, 0.4, 0.3), 7, False, (-0.7, -0.3, 0), 0.3, cap=False), 0.035)


@spart('rock.snow.c', 'nature')
def _s():
    M = _sm(); return nfinish('rock.snow.c', _slate('rsc0', M, (0.75, 0.6, 0.45), 8) + _slate('rsc1', M, (0.4, 0.36, 0.26), 9, True, (0.5, 0.2, 0), 1.1, cap=False), 0.03)


def _bank(pid, L, W, H, seed):
    """A shallow snowbank: one long, low, softly lumpy drift, knee high at most, cut flat on the ground."""
    M = _sm()
    ob = blob(pid + '_d', (0, 0, 0), 1.0, M['Snow'], subd=3, scale=(L / 2, W / 2, H), jitter=0.07, seed=seed)
    for v in ob.data.vertices:
        # a wind-blown drift: a little taller toward one end, never below the ground
        v.co.z = max(0.0, v.co.z * (1.0 + 0.25 * v.co.x / (L / 2)))
    decimate(ob, 0.6)
    ob.data.shade_smooth()
    return nfinish(pid, [ob], 0.025, grad=(0.86, 0.88, 0.95))


@spart('snowbank.a', 'nature')
def _s(): return _bank('snowbank.a', 2.4, 1.1, 0.42, 61)
@spart('snowbank.b', 'nature')
def _s(): return _bank('snowbank.b', 1.6, 0.9, 0.32, 62)


@spart('bush.snow', 'nature')
def _s():
    """A low evergreen shrub half buried, snow heaped over its crown."""
    M = _sm()
    b = puff('bsn', 0.6, M['Pine'], subd=3, cells=11, depth=0.22, lobes=0.16, squash=(1.2, 1.0, 0.7), seed=71)
    decimate(b, 0.55)
    lo = min(v.co.z for v in b.data.vertices); hi = max(v.co.z for v in b.data.vertices)
    paint_foliage(b, PINE_S, lo, hi)
    for v in b.data.vertices: v.co.z -= lo
    h = hi - lo
    cap = snow_ball('bsc', (0.05, 0.0, h * 0.78), 0.56, M['Snow'], squash=0.42, seed=72)
    cap2 = snow_ball('bsd', (-0.42, 0.18, h * 0.5), 0.3, M['Snow'], squash=0.5, seed=73)
    return nfinish('bush.snow', [b, cap, cap2], 0.025)


@spart('tuft.snow', 'nature')
def _s():
    """Dry straw grass poking out of a small snow mound (sways in the wind)."""
    M = _sm(); rnd = random.Random(81); P = []
    for k in range(8):
        a = 2 * math.pi * k / 8 + rnd.uniform(-0.2, 0.2); ln = rnd.uniform(0.3, 0.45)
        bl = limb(f'tsb{k}', (math.cos(a) * 0.05, math.sin(a) * 0.05, 0.02), (math.cos(a) * ln * 0.45, math.sin(a) * ln * 0.45, ln), 0.022, 0.006, M['Leaf'], segs=4)
        _cols(bl, lambda v: ramp(STRAW, 0.3 + 0.6 * v.co.z / 0.45)); P.append(bl)
    P.append(snow_ball('tsm', (0, 0, 0), 0.24, M['Snow'], squash=0.4, seed=82))
    return nfinish('tuft.snow', P, 0.0)


@spart('log.snow', 'nature')
def _s():
    """A fallen log with a stripe of snow along its top and a snowy stub of a branch."""
    M = _sm()
    lg = lathe('lgb', [(0.2, -0.85), (0.22, -0.5), (0.21, 0.5), (0.19, 0.85)], axis='X', segs=9, mat=M['Bark'], center=(0, 0, 0.2))
    _cols(lg, lambda v: ramp(BARK_S, 0.35 + 0.45 * max(0.0, v.normal.z)))
    ends = [prism(f'lge{s}', [(math.cos(2 * math.pi * k / 9) * 0.18, 0.2 + math.sin(2 * math.pi * k / 9) * 0.18) for k in range(9)], s * 0.86 - 0.02, s * 0.86 + 0.02, axis='X', mat=M['Wood']) for s in (-1, 1)]
    stub = limb('lgs', (0.2, 0.0, 0.3), (0.35, -0.05, 0.62), 0.07, 0.04, M['Bark'])
    _cols(stub, lambda v: ramp(BARK_S, 0.5))
    snow = snow_slab('lgn', (1.6, 0.3, 0.1), (0, 0, 0.38), M['Snow'], bulge=0.5)
    return nfinish('log.snow', [lg, stub, snow] + ends, 0.03)


@spart('stump.snow', 'nature')
def _s():
    M = _sm()
    st = lathe('sts', [(0.36, 0.0), (0.3, 0.1), (0.28, 0.42), (0.0, 0.44)], axis='Z', segs=10, mat=M['Bark'])
    _cols(st, lambda v: ramp(BARK_S, 0.35 + 0.4 * v.co.z / 0.44))
    cap = smooth(lathe('stc', [(0.0, 0.58), (0.22, 0.56), (0.32, 0.48), (0.31, 0.42), (0.0, 0.43)], axis='Z', segs=10, mat=M['Snow']), 60, weighted=False)
    return nfinish('stump.snow', [st, cap], 0.03)


@spart('firewood.stack', 'nature')
def _s():
    """A free-standing firewood stack between two posts, under a little plank roof with snow on it."""
    M = _sm(); rnd = random.Random(91); P = []
    r = 0.15
    for row in range(4):
        for i in range(6 - (row % 2)):
            x = -0.84 + r + (row % 2) * r + i * (2 * r + 0.01); z = r + row * 2 * r * 0.9; rr = r * rnd.uniform(0.9, 1.05)
            P.append(lathe(f'fb{row}{i}', [(rr, -0.3), (rr, 0.3)], axis='Y', segs=6, mat=M['WoodDark'], center=(x, 0, z)))
            P.append(prism(f'fe{row}{i}', [(x + math.cos(2 * math.pi * k / 6) * rr * 0.92, z + math.sin(2 * math.pi * k / 6) * rr * 0.92) for k in range(6)], -0.315, -0.29, axis='Y', mat=M['Wood']))
    for s in (-1, 1): P.append(rbox(f'fp{s}', (0.12, 0.12, 1.5), (s * 0.95, 0, 0.75), M['WoodDark'], 0.02))
    roof = chunky(prism('fr', [(-0.45, 1.5), (0.45, 1.62), (0.45, 1.7), (-0.45, 1.58)], -1.1, 1.1, axis='X', mat=M['Wood']), 0.02)
    snow = snow_slab('fsn', (2.1, 0.9, 0.14), (0, 0, 1.62), M['Snow'], bulge=0.45, rot=[('X', -0.13)])
    xform(snow, loc=(0, 0, 0.0))
    return nfinish('firewood.stack', P + [roof, snow], 0.028, grad=(0.74, 0.7, 0.8))


@spart('sled', 'nature')
def _s():
    M = _sm()
    P = _sled('ns', mats={'Timber': M['Wood'], 'TimberDark': M['WoodDark'], 'Accent': M['CoralPink'], 'Iron': M['Iron']})
    P.append(snow_slab('nsn', (0.46, 0.5, 0.08), (-0.28, 0.0, 0.35), M['Snow'], bulge=0.6))
    return nfinish('sled', P, 0.025, grad=(0.76, 0.72, 0.82))


@spart('lantern.post', 'nature')
def _s():
    """A path lantern: a timber post with a crossbar, the lantern hanging from it, glowing, snow on the cap."""
    M = _sm(); glowm = bpy.data.materials.get('ARC_Glow') or glow('ARC_Glow', '#ffd873')
    post = rbox('lp_p', (0.14, 0.14, 1.9), (0, 0, 0.95), M['WoodDark'], 0.02)
    arm = rbox('lp_a', (0.5, 0.1, 0.1), (0.2, 0, 1.8), M['WoodDark'], 0.015)
    body = rbox('lp_g', (0.24, 0.24, 0.32), (0.36, 0, 1.45), glowm, 0.02)
    cage = boxes('lp_c', [((0.04, 0.04, 0.34), (0.36 + sx * 0.12, sy * 0.12, 1.45)) for sx in (-1, 1) for sy in (-1, 1)], M['Iron'])
    cap = lathe('lp_h', [(0.22, 1.62), (0.0, 1.8)], axis='Z', segs=4, mat=M['Iron'], center=(0.36, 0, 0)); xform(cap, loc=(0, 0, 0))
    hook = rbox('lp_k', (0.03, 0.03, 0.12), (0.36, 0, 1.76), M['Iron'], 0.0)
    snp = snow_ball('lp_s', (0.0, 0.0, 1.9), 0.13, M['Snow'], squash=0.6, seed=4)
    sna = snow_slab('lp_t', (0.46, 0.12, 0.07), (0.2, 0, 1.85), M['Snow'], bulge=0.6)
    snc = snow_ball('lp_u', (0.36, 0, 1.68), 0.14, M['Snow'], squash=0.5, seed=5)
    base = snow_ball('lp_b', (0, 0, 0), 0.3, M['Snow'], squash=0.45, seed=6)
    return nfinish('lantern.post', [post, arm, body, cage, cap, hook, snp, sna, snc, base], 0.025)


@spart('barrel.snow', 'nature')
def _s():
    M = _sm()
    body = lathe('bb', [(0.0, 0.0), (0.37, 0.0), (0.42, 0.2), (0.45, 0.5), (0.42, 0.8), (0.37, 1.0), (0.0, 0.98)], axis='Z', segs=12, mat=M['Wood'])
    smooth(body, 20, weighted=False)
    bands = [lathe(f'bn{i}', [(0.43, z), (0.455, z + 0.01), (0.455, z + 0.1), (0.43, z + 0.11)], axis='Z', segs=12, mat=M['Iron'], cap=False) for i, z in enumerate((0.14, 0.74))]
    cap = smooth(lathe('bc', [(0.0, 1.12), (0.28, 1.1), (0.4, 1.03), (0.38, 0.97), (0.0, 0.98)], axis='Z', segs=12, mat=M['Snow']), 60, weighted=False)
    return nfinish('barrel.snow', [body, cap] + bands, 0.03, grad=(0.74, 0.7, 0.8))


@spart('reeds.frozen', 'nature')
def _s():
    """Frozen cattails at the pond's edge: straw stems with brown heads, a little snow at the foot (sways)."""
    M = _sm(); rnd = random.Random(97); P = []
    for k in range(5):
        a = 2 * math.pi * k / 5 + rnd.uniform(-0.3, 0.3); r = rnd.uniform(0.04, 0.16); h = rnd.uniform(0.8, 1.2)
        base = (math.cos(a) * r, math.sin(a) * r, 0.0); top = (base[0] + math.cos(a) * 0.1, base[1] + math.sin(a) * 0.1, h)
        st = limb(f'rf{k}', base, top, 0.018, 0.01, M['Leaf'], segs=4); _cols(st, lambda v: ramp(STRAW, 0.3 + 0.5 * v.co.z / 1.2)); P.append(st)
        if k % 2 == 0:
            hd = lathe(f'rh{k}', [(0.0, -0.12), (0.045, -0.1), (0.05, 0.08), (0.0, 0.12)], axis='Z', segs=6, mat=M['WoodDark'], center=(top[0], top[1], top[2] - 0.2))
            hd.data.shade_smooth(); P.append(hd)
    P.append(snow_ball('rfs', (0, 0, 0), 0.26, M['Snow'], squash=0.35, seed=98))
    return nfinish('reeds.frozen', P, 0.0)


@spart('signpost', 'nature')
def _s():
    """A snowy fingerpost: a timber post, two painted boards (red and blue), snow on the cap and the boards' tops."""
    M = _sm()
    post = rbox('sp_post', (0.12, 0.12, 1.85), (0, 0, 0.92), M['WoodDark'], bev=0.02)
    arrow = [(-0.36, -0.1), (0.28, -0.1), (0.42, 0.0), (0.28, 0.1), (-0.36, 0.1)]
    b1 = chunky(prism('sp_b1', arrow, -0.03, 0.03, axis='Y', mat=M['CoralPink']), 0.015); xform(b1, rot=[('Z', 0.3)], loc=(0.1, 0.0, 1.46))
    b2 = chunky(prism('sp_b2', [(-p[0], p[1]) for p in arrow], -0.03, 0.03, axis='Y', mat=M['SkyBlue']), 0.015); xform(b2, rot=[('Z', -0.35)], loc=(-0.1, 0.0, 1.18))
    s1 = snow_slab('sp_s1', (0.6, 0.08, 0.06), (0.06, 0.0, 1.56), M['Snow'], bulge=0.6, rot=[('Z', 0.3)])
    s2 = snow_slab('sp_s2', (0.6, 0.08, 0.06), (-0.06, 0.0, 1.28), M['Snow'], bulge=0.6, rot=[('Z', -0.35)])
    cap = snow_ball('sp_c', (0, 0, 1.85), 0.12, M['Snow'], squash=0.6, seed=7)
    foot = snow_ball('sp_f', (0, 0, 0), 0.3, M['Snow'], squash=0.4, seed=8)
    return nfinish('signpost', [post, b1, b2, s1, s2, cap, foot], 0.03, grad=(0.8, 0.76, 0.86))


@spart('stone.step', 'nature')
def _s():
    """A flat grey stepping stone for the doorstep walks, the paths and the fords, swept clear."""
    M = _sm()
    s = lathe('stone.step', [(0.0, 0.08), (0.3, 0.075), (0.42, 0.04), (0.42, -0.02)], axis='Z', segs=8, mat=M['Slate'])
    xform(s, scale=(1.2, 0.8, 1.0)); smooth(s, 40, weighted=False)
    return nfinish('stone.step', [s], 0.02, grad=(0.82, 0.8, 0.86))

# ---------------------------------------------------------------- landmark parts (ARC_ + LMK_ slots)


def _lms():
    M = _lm(); M.update(_sm()); return M


def _pyr_roof(name, half, rise, z0, mat, snowmat, t=0.2, lite=False):
    """A four-sided pyramid roof (square, `half` to its eaves) with a snow cap over it that rounds over the eaves."""
    roof = lathe(name, [(0.0, z0 + rise), (half * 1.414, z0), (half * 1.414, z0 - 0.18), (0.0, z0 + rise - 0.2)], axis='Z', segs=4, mat=mat)
    xform(roof, rot=[('Z', math.pi / 4)])
    sn = lathe(name + 's', [(0.0, z0 + rise + t + 0.05), (half * 1.414 * 0.55, z0 + rise * 0.45 + t * 1.2), (half * 1.414 + 0.08, z0 + t * 0.4), (half * 1.414 + 0.02, z0 - 0.08),
                            (half * 1.414 - 0.2, z0 + 0.1), (0.0, z0 + rise - 0.05)], axis='Z', segs=4, mat=snowmat)
    xform(sn, rot=[('Z', math.pi / 4)])
    if not lite: chunky(sn, 0.06, 2)
    return [roof, sn]


def _belltower(pid, lite):
    """The village bell tower over the square: a stone shaft on a plinth with a clock face and two red banners, a
    timber-framed belfry open on all sides with the bronze bell, a steep snow-capped pyramid roof and a gold
    finial. About 11.5 m to the tip; a door at its foot, front toward -Y."""
    M = _lms(); P = []; bev = 0.0 if lite else 0.06
    P.append(rbox('bt_plinth', (3.3, 3.3, 0.7), (0, 0, 0.35), M['StoneDark'], bev))
    P.append(rbox('bt_shaft', (2.8, 2.8, 5.6), (0, 0, 3.5), M['Stone'], bev))
    P.append(rbox('bt_band', (3.05, 3.05, 0.26), (0, 0, 6.33), M['StoneDark'], bev))
    if not lite:
        rnd = random.Random(5)
        for k in range(4):
            for q in range(4):
                zc = 1.2 + q * 1.3 + rnd.uniform(-0.15, 0.15); w = rnd.uniform(0.5, 0.8); x = rnd.uniform(-0.9, 0.9)
                if k == 0 and abs(x) < 0.9 and zc < 2.6: continue
                if k == 0 and abs(x) < 0.8 and 3.4 < zc < 5.8: continue
                st = box(f'bt_st{k}{q}', (w, 0.12, 0.28), (x, -1.43, zc), M['StoneDark'])
                chunky(st, 0.04); xform(st, rot=[('Z', k * math.pi / 2)]); P.append(st)
        for sx in (-1, 1):
            for sy in (-1, 1):
                for q in range(4):
                    long = q % 2 == 0; sz = (0.62, 0.4) if long else (0.4, 0.62)
                    qb = box('bt_q', (sz[0], sz[1], 0.5), (sx * (1.4 - sz[0] / 2 + 0.05), sy * (1.4 - sz[1] / 2 + 0.05), 1.1 + q * 1.3), M['Stone'])
                    chunky(qb, 0.04); P.append(qb)
    # the door
    P.append(chunky(prism('bt_arch', arch_pts(1.5, 2.45), -1.46, -1.36, axis='Y', mat=M['StoneDark']), 0.03 if not lite else 0.0))
    P.append(chunky(prism('bt_door', arch_pts(1.1, 2.1, 0.0, 0.7), -1.5, -1.42, axis='Y', mat=M['CoralPink']), 0.02 if not lite else 0.0))
    xform(P[-1], loc=(0, 0, 0)); xform(P[-2], loc=(0, 0, 0.7))
    P.append(snow_slab('bt_dsn', (0.9, 0.3, 0.12), (0, -1.46, 3.1), M['Snow'], bulge=0.5))
    # the clock: a cream face in a stone ring, iron hands, on the front and back
    for k in (0, 2):
        ring = torus('bt_cr', 0.66, 0.1, (0, -1.44, 4.6), M['StoneDark'], axis='Y', segs=20 if not lite else 12, rsegs=5)
        face = cyl('bt_cf', 0.6, -1.47, -1.4, axis='Y', segs=20 if not lite else 12, mat=M['Plaster'], center=(0, 0, 4.6))
        hands = boxes('bt_ch', [((0.06, 0.03, 0.46), (0, -1.5, 4.8)), ((0.34, 0.03, 0.06), (0.15, -1.5, 4.6))], M['Iron'])
        marks = boxes('bt_cm', [((0.07, 0.025, 0.12), (math.sin(q * math.pi / 2) * 0.48, -1.49, 4.6 + math.cos(q * math.pi / 2) * 0.48)) for q in range(4)], M['Iron'])
        for o in (ring, face, hands, marks): xform(o, rot=[('Z', k * math.pi / 2)])
        P += [ring, face, hands, marks]
    # banners on the sides
    for k in (1, 3):
        ban = chunky(prism('bt_ban', [(-0.42, 5.9), (0.42, 5.9), (0.42, 4.1), (0.0, 3.75), (-0.42, 4.1)], -1.46, -1.4, axis='Y', mat=M['CoralPink']), 0.01)
        dia = chunky(prism('bt_bd', [(0, 4.5), (0.22, 4.85), (0, 5.2), (-0.22, 4.85)], -1.48, -1.46, axis='Y', mat=M['Plaster']), 0.0)
        rod = cyl('bt_br', 0.04, -0.55, 0.55, axis='X', segs=6, mat=M['Iron'], center=(0, -1.46, 5.95))
        for o in (ban, dia, rod): xform(o, rot=[('Z', k * math.pi / 2)])
        P += [ban, dia, rod]
    # the belfry: a plank deck, corner posts, rails with crossed braces, the bell
    P.append(rbox('bt_deck', (3.2, 3.2, 0.2), (0, 0, 6.56), M['Wood'], 0.03 if not lite else 0.0))
    for sx in (-1, 1):
        for sy in (-1, 1): P.append(rbox('bt_post', (0.26, 0.26, 2.5), (sx * 1.35, sy * 1.35, 7.9), M['WoodDark'], 0.03 if not lite else 0.0))
    for k in range(4):
        rail = rbox('bt_rail', (2.8, 0.16, 0.16), (0, -1.38, 7.55), M['Wood'], 0.02)
        top = rbox('bt_plate', (3.0, 0.26, 0.24), (0, -1.38, 9.1), M['Wood'], 0.02)
        xs = [chunky(strut('bt_x', (-1.2, -1.38, 6.7), (1.2, -1.38, 7.5), 0.12, 0.1, M['WoodDark']), 0.01), chunky(strut('bt_y', (1.2, -1.38, 6.7), (-1.2, -1.38, 7.5), 0.12, 0.1, M['WoodDark']), 0.01)] if not lite else []
        brk = [chunky(strut('bt_k', (s * 1.2, -1.38, 8.35), (s * 0.7, -1.38, 9.0), 0.14, 0.12, M['WoodDark']), 0.01) for s in (-1, 1)] if not lite else []
        for o in [rail, top] + xs + brk: xform(o, rot=[('Z', k * math.pi / 2)])
        P += [rail, top] + xs + brk
        P.append(snow_slab('bt_rs', (2.7, 0.2, 0.08), (0, -1.38, 7.62), M['Snow'], bulge=0.5, rot=[('Z', k * math.pi / 2)]))
    bell = smooth(lathe('bt_bell', [(0.0, 8.9), (0.18, 8.88), (0.27, 8.78), (0.31, 8.5), (0.38, 8.28), (0.52, 8.1), (0.53, 8.03), (0.42, 8.06), (0.0, 8.12)], axis='Z', segs=16 if not lite else 10, mat=M['ButterYellow']), 45, weighted=False)
    P += [bell, rbox('bt_yoke', (2.8, 0.24, 0.24), (0, 0, 9.0), M['WoodDark'], 0.02)]
    P += _pyr_roof('bt_roof', 1.85, 2.2, 9.2, M['CoralPink'], M['Snow'], 0.22, lite)
    P.append(cyl('bt_fp', 0.05, 11.4, 11.9, axis='Z', segs=6, mat=M['Iron']))
    P.append(blob('bt_fb', (0, 0, 11.95), 0.14, M['ButterYellow'], subd=1 if lite else 2, jitter=0.0))
    # a snowdrift round the plinth
    if not lite:
        for i, (x, y, r) in enumerate(((-1.5, -1.2, 0.5), (1.7, 0.6, 0.6), (-1.2, 1.6, 0.55), (0.9, 1.75, 0.4))):
            P.append(snow_ball(f'bt_dr{i}', (x, y, 0.0), r, M['Snow'], squash=0.5, seed=20 + i))
    _tone(P)
    return lfinish(pid, P, 0.035)


@spart('belltower.snow', 'landmark')
def _s(): return _belltower('belltower.snow', False)
@spart('belltower.snow.lite', 'landmark')
def _s(): return _belltower('belltower.snow.lite', True)


def _well_snow(pid, lite):
    """The square's well: a round stone well under a steep little gable roof on two posts, snow thick on the roof and
    the rim, a windlass and a bucket. Front toward -Y."""
    M = _lms(); segs = 10 if lite else 16; P = []
    ring = lathe('ws_ring', [(0.62, 0.0), (0.92, 0.0), (0.94, 0.72), (0.84, 0.84), (0.62, 0.84), (0.62, 0.1)], axis='Z', segs=segs, mat=M['Stone'])
    if not lite: chunky(ring, 0.05)
    P.append(ring)
    P.append(smooth(lathe('ws_rs', [(0.6, 0.84), (0.95, 0.83), (0.98, 0.78), (0.85, 0.76), (0.62, 0.8)], axis='Z', segs=segs, mat=M['Snow']), 60, weighted=False))
    P.append(cyl('ws_ice', 0.64, 0.6, 0.66, axis='Z', segs=segs, mat=M['Frost']))
    for s in (-1, 1): P.append(rbox('ws_post', (0.18, 0.18, 2.5), (s * 0.95, 0, 1.25), M['WoodDark'], 0.02 if not lite else 0.0))
    P.append(rbox('ws_beam', (2.2, 0.18, 0.18), (0, 0, 2.45), M['Wood'], 0.02))
    # a small steep gable roof over the shaft, its eaves well above the rim so the well reads under it
    k = 0.85; hw = 0.95; ridge = 3.3
    for s in (-1, 1):
        P.append(chunky(prism(f'ws_r{s}', [(0, ridge), (s * hw, ridge - hw * k), (s * hw, ridge - hw * k - 0.12), (0, ridge - 0.12)], -1.1, 1.1, axis='X', mat=M['CoralPink']), 0.02 if not lite else 0.0))
    P.append(chunky(prism('ws_gab', [(-0.8, 2.52), (0.8, 2.52), (0, ridge - 0.1)], -0.9, 0.9, axis='X', mat=M['Wood']), 0.02 if not lite else 0.0))
    sn = snow_gable('ws_sn', hw, k, -1.15, 1.15, ridge, M['Snow'], t=0.18)
    xform(sn, rot=[('Z', math.pi / 2)]); P.append(sn)
    if not lite:
        P.append(cyl('ws_axle', 0.07, -0.9, 0.9, axis='X', segs=8, mat=M['Wood'], center=(0, 0, 1.6)))
        P.append(rbox('ws_crank', (0.06, 0.06, 0.36), (1.0, -0.05, 1.45), M['Iron'], 0.0))
        P.append(cyl('ws_rope', 0.02, 0.9, 1.6, axis='Z', segs=5, mat=M['Sand']))
        P.append(lathe('ws_bucket', [(0.14, 0.7), (0.19, 0.98), (0.16, 0.98), (0.16, 0.74), (0.0, 0.74)], axis='Z', segs=8, mat=M['WoodDark'], center=(0.0, 0, 0)))
        xform(P[-1], loc=(0.0, 0.0, 0.08))
        for i, (x, y, r) in enumerate(((-1.1, -0.6, 0.45), (1.2, 0.5, 0.38))):
            P.append(snow_ball(f'ws_dr{i}', (x, y, 0.0), r, M['Snow'], squash=0.45, seed=30 + i))
    _tone(P)
    return lfinish(pid, P, 0.03)


@spart('well.snow', 'landmark')
def _s(): return _well_snow('well.snow', False)
@spart('well.snow.lite', 'landmark')
def _s(): return _well_snow('well.snow.lite', True)


def _stall_snow(pid, variant, lite):
    """A winter market stall: a timber counter under a steep little roof in the awning colour (LMK_Awning) on four
    posts, snow heaped on the roof, goods on the counter (firewood and lanterns, or scarves and pies). Front -Y."""
    M = _lms(); P = []
    P.append(rbox('ss_counter', (2.3, 0.9, 0.92), (0, 0.15, 0.46), M['Wood'], 0.04 if not lite else 0.0))
    P.append(rbox('ss_top', (2.45, 1.05, 0.08), (0, 0.15, 0.95), M['WoodDark'], 0.01))
    P.append(rbox('ss_skirt', (2.34, 0.06, 0.5), (0, -0.32, 0.6), M['Awning'], 0.01))
    for sx in (-1, 1):
        for sy in (-1, 1): P.append(rbox('ss_post', (0.12, 0.12, 2.35), (sx * 1.2, sy * 0.62 + 0.15, 1.17), M['WoodDark'], 0.01))
    k = 0.75; hw = 0.95
    for s in (-1, 1):
        P.append(chunky(prism(f'ss_r{s}', [(0.15, 3.0), (0.15 + s * hw, 3.0 - hw * k), (0.15 + s * hw, 3.0 - hw * k - 0.1), (0.15, 2.9)], -1.45, 1.45, axis='X', mat=M['Awning']), 0.02 if not lite else 0.0))
    sn = snow_gable('ss_sn', hw, k, -1.5, 1.5, 3.0, M['Snow'], t=0.18)
    xform(sn, rot=[('Z', math.pi / 2)], loc=(0, 0.15, 0)); P.append(sn)
    if not lite:
        for i in range(6):
            P.append(rbox(f'ss_val{i}', (0.44, 0.04, 0.2), (-1.2 + i * 0.48, -0.82, 2.2), M['Awning'] if i % 2 == 0 else M['Plaster'], 0.01))
        if variant == 0:
            for j, x in enumerate((-0.65, 0.05)):
                for row in range(2):
                    for i in range(3 - row):
                        P.append(lathe(f'ss_l{j}{row}{i}', [(0.09, -0.25), (0.09, 0.25)], axis='Y', segs=6, mat=M['WoodDark'], center=(x - 0.18 + i * 0.18 + row * 0.09, 0.15, 1.08 + row * 0.16)))
            for i, x in enumerate((0.55, 0.85)):
                P.append(rbox(f'ss_lg{i}', (0.18, 0.18, 0.24), (x, 0.1, 1.12), bpy.data.materials.get('ARC_Glow') or glow('ARC_Glow', '#ffd873'), 0.02))
                P.append(lathe(f'ss_lc{i}', [(0.15, 1.24), (0.0, 1.38)], axis='Z', segs=4, mat=M['Iron'], center=(x, 0.1, 0)))
        else:
            for i, (x, mat) in enumerate(((-0.75, 'CoralPink'), (-0.45, 'SkyBlue'), (-0.15, 'ButterYellow'))):
                P.append(rbox(f'ss_sc{i}', (0.26, 0.5, 0.12), (x, 0.15, 1.05 + 0.0), M[mat], 0.03))
            for i, x in enumerate((0.35, 0.8)):
                P.append(cyl(f'ss_pie{i}', 0.2, 0.99, 1.1, axis='Z', segs=10, mat=M['ButterYellow'], center=(x, 0.15, 0)))
                P.append(cyl(f'ss_pt{i}', 0.16, 1.1, 1.13, axis='Z', segs=10, mat=M['Roof'], center=(x, 0.15, 0)))
        P.append(snow_ball('ss_dr', (1.25, -0.5, 0.0), 0.36, M['Snow'], squash=0.45, seed=40 + variant))
    _tone(P)
    return lfinish(pid, P, 0.03)


@spart('stall.snow.a', 'landmark')
def _s(): return _stall_snow('stall.snow.a', 0, False)
@spart('stall.snow.a.lite', 'landmark')
def _s(): return _stall_snow('stall.snow.a.lite', 0, True)
@spart('stall.snow.b', 'landmark')
def _s(): return _stall_snow('stall.snow.b', 1, False)
@spart('stall.snow.b.lite', 'landmark')
def _s(): return _stall_snow('stall.snow.b.lite', 1, True)

# ---------------------------------------------------------------- gameplay props: rocks, fence, barricade, barrel (own GLBs)
#
# The snow biome patches four of the theme's props by id (packs/arcade/pack.json biomes.snow.props): the cover rocks,
# the fence (a split-rail fence under snow), the hay barricade (sleds, firewood and crates) and the barrel. Each is
# its own GLB at the meadow prop's longest size, so the pack's `metres` and every placement stay as they are.

SNOW_PROPS = {'rocks': 'arcade-snow-rocks.glb', 'fence': 'arcade-snow-fence.glb', 'barricade': 'arcade-snow-barricade.glb', 'barrel': 'arcade-snow-barrel.glb'}


def snow_rocks():
    """Cover rocks: three snow-capped slate boulders, 2.5 m long, about 1.4 m high."""
    M = _sm()
    P = _slate('srk0', M, (1.35, 1.1, 1.3), 11, False, (-0.45, 0.0, 0.0), 0.2) + _slate('srk1', M, (1.0, 0.85, 0.8), 12, True, (0.55, -0.12, 0.0), -0.4) + _slate('srk2', M, (0.5, 0.48, 0.4), 13, False, (0.98, 0.3, 0.0), 0.7, cap=False)
    P.append(snow_ball('srk_d', (0.1, -0.55, 0.0), 0.5, M['Snow'], squash=0.4, seed=14))
    ensure_grad(P)
    ob = merge('SNW_Rocks', P); ob['arc_outline'] = 0.035
    return ob


def snow_fence():
    """A split-rail fence panel, 2.46 long: two chunky posts, two rails, snow along each rail and on the post tops."""
    M = _sm(); P = []
    for s in (-1, 1):
        P.append(rbox(f'sf_p{s}', (0.18, 0.18, 1.15), (s * 1.1, 0, 0.57), M['WoodDark'], 0.03))
        P.append(snow_ball(f'sf_c{s}', (s * 1.1, 0, 1.13), 0.14, M['Snow'], squash=0.55, seed=3 + s))
    for i, z in enumerate((0.45, 0.88)):
        r = rbox(f'sf_r{i}', (2.46, 0.14, 0.16), (0, 0, z), M['Wood'], 0.03); xform(r, rot=[('X', 0.0)])
        P.append(r)
        P.append(snow_slab(f'sf_s{i}', (2.3, 0.17, 0.09), (0, 0, z + 0.07), M['Snow'], bulge=0.5))
    # a low drift along the foot of the fence, no deeper than the posts (the fence's collider is its bounding box)
    d = snow_ball('sf_d', (0.2, 0.0, 0.0), 1.0, M['Snow'], squash=1.0, seed=9)
    xform(d, scale=(0.9, 0.16, 0.22)); P.append(d)
    ensure_grad(P); vgrad([o for o in P if o.data.materials[0].name.startswith('ARC_Wood')], (0.8, 0.76, 0.84), local=True)
    ob = merge('SNW_Fence', P); ob['arc_outline'] = 0.03
    return ob


def snow_barricade():
    """The snow village's barricade: an upended sled, a firewood pile and crates under snow, 3.3 m long."""
    M = _sm(); P = []
    cr = _crate('sbc0', (0.8, 0.75, 0.72), (-1.1, 0.0, 0.0), 0.1) + _crate('sbc1', (0.62, 0.6, 0.5), (-1.05, 0.05, 0.72), -0.25)
    for o in cr:
        for i, m in enumerate(o.data.materials):
            if m and m.name.startswith('HSE_'): o.data.materials[i] = M['Wood' if m.name == 'HSE_Timber' else 'WoodDark']
    P += cr
    P.append(snow_slab('sbs0', (0.58, 0.56, 0.1), (-1.05, 0.05, 1.22), M['Snow'], bulge=0.5, rot=[('Z', -0.25)]))
    sled = _sled('sbl', 1.1, mats={'Timber': M['Wood'], 'TimberDark': M['WoodDark'], 'Accent': M['CoralPink'], 'Iron': M['Iron']})
    # the sled leans on its tail against the crates, in the barricade's own plane, so it adds no depth
    for o in sled: xform(o, rot=[('Y', 0.95)], loc=(-0.05, 0.0, 0.55))
    P += sled
    r = 0.13
    for row in range(3):
        for i in range(5 - row):
            x = 0.75 + i * 0.27 + row * 0.135; z = r + row * 0.23
            P.append(lathe(f'sbw{row}{i}', [(r, -0.35), (r, 0.35)], axis='Y', segs=7, mat=M['WoodDark'], center=(x, -0.1, z)))
            P.append(prism(f'sbe{row}{i}', [(x + math.cos(2 * math.pi * k / 7) * r * 0.9, z + math.sin(2 * math.pi * k / 7) * r * 0.9) for k in range(7)], -0.465, -0.44, axis='Y', mat=M['Wood']))
    P.append(snow_slab('sbs1', (1.2, 0.72, 0.14), (1.28, -0.1, 0.7), M['Snow'], bulge=0.5))
    P.append(snow_ball('sbd', (-0.4, -0.15, 0.0), 0.45, M['Snow'], squash=0.45, seed=15))
    ensure_grad(P)
    ob = merge('SNW_Barricade', P); ob['arc_outline'] = 0.03
    return ob


def snow_barrel():
    """The cover barrel, 1 m tall, snow heaped on its lid."""
    M = _sm()
    body = lathe('sbr', [(0.0, 0.0), (0.37, 0.0), (0.42, 0.18), (0.45, 0.45), (0.42, 0.72), (0.37, 0.88), (0.0, 0.86)], axis='Z', segs=14, mat=M['Wood'])
    smooth(body, 20, weighted=False)
    bands = [lathe(f'sbb{i}', [(0.43, z), (0.458, z + 0.01), (0.458, z + 0.1), (0.43, z + 0.11)], axis='Z', segs=14, mat=M['Iron'], cap=False) for i, z in enumerate((0.12, 0.64))]
    cap = smooth(lathe('sbc', [(0.0, 1.0), (0.26, 0.98), (0.4, 0.91), (0.39, 0.85), (0.0, 0.86)], axis='Z', segs=14, mat=M['Snow']), 60, weighted=False)
    P = [body, cap] + bands
    ensure_grad(P); vgrad([body], (0.74, 0.7, 0.8), local=True)
    ob = merge('SNW_Barrel', P); ob['arc_outline'] = 0.03
    return ob


def build_snow_props():
    """The four props into SNW_Props (in the snow scene), standing on the origin, fronts toward -Y."""
    sc = bpy.data.scenes[SCENE_S]
    C = bpy.data.collections.get('SNW_Props') or bpy.data.collections.new('SNW_Props')
    if C.name not in sc.collection.children: sc.collection.children.link(C)
    for o in list(C.objects): _remove(o)
    out = {}
    for name, fn in (('rocks', snow_rocks), ('fence', snow_fence), ('barricade', snow_barricade), ('barrel', snow_barrel)):
        ob = fn()
        for u in list(ob.users_collection): u.objects.unlink(ob)
        C.objects.link(ob)
        lo, hi = bounds([ob]); out[name] = {'size': [round(hi.x - lo.x, 4), round(hi.z - lo.z, 4), round(hi.y - lo.y, 4)], 'tris': tris([ob])}
    return out


def ship_snow_props(out=OUT + '/arcade'):
    C = bpy.data.collections['SNW_Props']; res = {}
    for key, node, obname in (('rocks', 'Rocks', 'SNW_Rocks'), ('fence', 'Fence', 'SNW_Fence'), ('barricade', 'Barricade', 'SNW_Barricade'), ('barrel', 'Barrel', 'SNW_Barrel')):
        ob = C.objects[obname]
        res[key] = export_nodes([(node, [ob], None, (0, 0, 0), True)], f'{out}/{SNOW_PROPS[key]}')
    return res

# ---------------------------------------------------------------- scene, build, show, ship


def snow_scene():
    """The snow village's own scene with its own sky and sun (the kit's sky()/sun() mutate the shared ARC_ ones)."""
    sc = bpy.data.scenes.get(SCENE_S) or bpy.data.scenes.new(SCENE_S)
    w = bpy.data.worlds.get('SNW_Sky')
    if not w:
        keep = bpy.context.window.scene; bpy.context.window.scene = sc
        base = bpy.data.worlds.get('ARC_Sky'); w = base.copy() if base else bpy.data.worlds.new('SNW_Sky'); w.name = 'SNW_Sky'
        bpy.context.window.scene = keep
    sc.world = w
    sun_ob = bpy.data.objects.get('SNW_Sun')
    if not sun_ob:
        src = bpy.data.objects.get('ARC_Sun')
        sun_ob = src.copy() if src else bpy.data.objects.new('SNW_Sun', bpy.data.lights.new('SNW_Sun', 'SUN'))
        sun_ob.data = sun_ob.data.copy(); sun_ob.name = 'SNW_Sun'; sun_ob.data.name = 'SNW_Sun'
    if sun_ob.name not in sc.collection.objects: sc.collection.objects.link(sun_ob)
    return sc


def _remove(ob):
    me = ob.data if ob.type == 'MESH' else None
    bpy.data.objects.remove(ob, do_unlink=True)
    if me and me.users == 0: bpy.data.meshes.remove(me)


def build_snow_parts(only=None):
    """Every part (or the ids in `only`) into SNW_Parts; an earlier build of the same ids goes first."""
    materials()
    for s in HSLOTS + ('Snow', 'Log', 'Plank', 'Masonry'): hm(s)
    for s in ('Leaf', 'Bark', 'Snow', 'Gold'): tm(s)
    _lm(); _sm()
    sc = snow_scene()
    C = bpy.data.collections.get(PARTS_COLL_S) or bpy.data.collections.new(PARTS_COLL_S)
    if C.name not in sc.collection.children: sc.collection.children.link(C)
    ids = [p for p in SPART_ORDER if only is None or p in only]
    for pid in ids:
        old = bpy.data.objects.get(pid)
        if old:
            for ch in list(old.children): _remove(ch)
            _remove(old)
    info = {}
    keep = bpy.context.window.scene; bpy.context.window.scene = sc
    try:
        for pid in ids:
            ob = SPARTS[pid]()
            for o in [ob] + list(ob.children):
                for u in list(o.users_collection): u.objects.unlink(o)
                C.objects.link(o)
            ob['snw_kind'] = SKIND[pid]
            info[pid] = tris([ob] + [c for c in ob.children if c.type == 'MESH'])
    finally:
        bpy.context.window.scene = keep
    C.hide_render = True; C.hide_viewport = True
    return {'parts': len(info), 'tris': sum(info.values()), 'each': info}


def snow_preview_material(slot):
    """A coloured copy of an HSE_/TRE_/LMK_ slot for the previews (the shipped parts stay white x gradient)."""
    name = 'SNWP_' + slot
    m = bpy.data.materials.get(name)
    if m: return m
    hex_ = SNOW_PREVIEW.get(slot, '#ffffff')
    if slot == 'Glow': return glow(name, hex_)
    kw = dict(HSLOT_TOON.get(slot, {})); kw.update(TSLOT_TOON.get(slot, {}) if slot in ('Snow', 'Leaf', 'Bark') else {})
    return toon(name, hex_, **kw)


def _srecolour(ob):
    for i, m in enumerate(ob.data.materials):
        if m and m.name.startswith(('HSE_', 'TRE_', 'LMK_')):
            ob.data.materials[i] = snow_preview_material(m.name[4:].split('.')[0])


def show_snow_parts(kinds=('house',), only=None, per_row=8, gap=3.2, origin=(0.0, 0.0), outlines=True):
    """Coloured copies of the built parts in rows in SNW_Show (the snow scene), with their outline shells."""
    src = bpy.data.collections[PARTS_COLL_S]; sc = snow_scene()
    C = bpy.data.collections.get(SHOW_COLL_S) or bpy.data.collections.new(SHOW_COLL_S)
    if C.name not in sc.collection.children: sc.collection.children.link(C)
    for o in [o for o in C.objects if o.parent is not None] + [o for o in C.objects if o.parent is None]: _remove(o)
    ids = [p for p in SPART_ORDER if SKIND[p] in kinds and (only is None or p in only) and src.objects.get(p)]
    for i, pid in enumerate(ids):
        o = src.objects[pid]; c = o.copy(); c.data = o.data.copy(); C.objects.link(c)
        c.location = (origin[0] + (i % per_row) * gap, origin[1] + (i // per_row) * gap * 1.4, 0.0)
        _srecolour(c)
        for ch in o.children:
            if ch.type == 'MESH':
                cc = ch.copy(); cc.data = ch.data.copy(); C.objects.link(cc); cc.parent = c; _srecolour(cc)
        if outlines and c.get('arc_outline', 0) > 0: outline(c, c['arc_outline'])
    return {'shown': ids}


def snow_parts_index():
    C = bpy.data.collections[PARTS_COLL_S]; idx = {'house': {}, 'tree': {}, 'nature': {}, 'landmark': {}}
    for pid in SPART_ORDER:
        ob = C.objects.get(pid)
        if not ob: continue
        kind = SKIND[pid]; objs = [ob] + [c for c in ob.children if c.type == 'MESH']
        if kind == 'house':
            idx[kind][pid] = {'sockets': sorted(ch['socket'] for ch in ob.children if 'socket' in ch)}
            continue
        r = 0.0; top = 0.0; bot = 0.0
        for o in objs:
            base = o.matrix_parent_inverse @ o.matrix_basis if o.parent else Matrix.Identity(4)
            for v in o.data.vertices:
                w = base @ v.co; r = max(r, math.hypot(w.x, w.y)); top = max(top, w.z); bot = min(bot, w.z)
        if kind == 'tree': idx[kind][pid] = {'r': round(r, 3), 'top': round(top, 3), 'bot': round(bot, 3), 'tris': tris(objs)}
        elif kind == 'nature': idx[kind][pid] = {'foot': round(r, 3), 'tris': tris(objs)}
        else: idx[kind][pid] = {'foot': round(r, 3), 'top': round(top, 3), 'tris': tris(objs)}
    return idx


def ship_snow_parts(path=PARTS_GLB_S, index=PARTS_INDEX_S):
    """One GLB with every snow part (sockets as child empties) + the JS index, one map per kind."""
    C = bpy.data.collections[PARTS_COLL_S]
    objs = [o for o in C.objects if o.parent is None] + [o for o in C.objects if o.parent is not None]
    gltf_mode(True)
    try:
        C.hide_viewport = False
        bpy.context.view_layer.update()
        size = export_glb(objs, path)
    finally:
        gltf_mode(False); C.hide_viewport = True
    idx = snow_parts_index()
    with open(index, 'w') as f:
        f.write('// Generated by tools/blender/v2/arcade/snow_parts.py (ship_snow_parts): the snow parts library index,\n'
                '// one map per kind (house parts with their sockets; tree, nature and landmark parts with their extents and\n'
                '// triangles). The snow biome\'s rules are validated against it.\n'
                "export const SNOW_LIBRARY = 'assets/v2/arcade/arcade-snow-parts.glb';\n")
        for kind, name in (('house', 'SNOW_HOUSE_PARTS'), ('tree', 'SNOW_TREE_PARTS'), ('nature', 'SNOW_NATURE_PARTS'), ('landmark', 'SNOW_LANDMARK_PARTS')):
            f.write(f'export const {name} = ' + json.dumps(idx[kind], indent=1, sort_keys=True) + ';\n')
    return {'kb': round(size / 1024, 1), 'parts': sum(len(v) for v in idx.values()), 'tris': tris([o for o in objs if o.type == 'MESH'])}
