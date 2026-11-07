"""Arcade DESERT parts library: everything the desert village adds on top of the Arcade kit, in ONE GLB
(assets/v2/arcade/arcade-desert-parts.glb) that the desert biome's house, tree, nature and landmark rules all name
as their library.

  house     doors, the courtyard gate, windows, shutters, sill pots, awnings, lamps, banners, the inn sign, the
            mashrabiya bay, the balcony, the dome finial, the lookout platform and yard props. HSE_<Slot> colour
            slots (white x the 'Col' gradient) that the house plan's palette fills, exactly like arcade-house-parts.glb.
  tree      palm crowns and cactus caps for the tree grammar (TRE_<Slot> slots, like arcade-tree-parts.glb).
  nature    cacti, dry shrubs, desert tufts, sandstone rocks and the path flagstones (the kit's ARC_ materials).
  landmark  the oasis well with its canopy, the market stalls with broad awnings, the lookout (ARC_ + LMK_ slots).

exec after vg.py, kit.py, nature.py, hero_corner.py, creature_parts.py, house_parts.py, nature_parts.py,
landmark_parts.py and tree_parts.py (same globals):
    g['build_desert_parts']()        every part into DST_Parts (hidden; previews copy from it)
    g['show_desert_parts'](kinds)    coloured preview copies laid out in rows in DST_Show (the desert scene)
    g['ship_desert_parts']()         the GLB + src/world/desertParts.js (one index per kind)

Units are metres at game scale. Wall parts stand on the bottom centre of their opening on the wall plane and face -Y;
everything else stands on its origin. Sockets follow the house parts contract (house_parts.py).
"""
import bpy, bmesh, math, random, json
from mathutils import Vector, Matrix

PARTS_COLL_D = 'DST_Parts'
SHOW_COLL_D = 'DST_Show'
PARTS_GLB_D = OUT + '/arcade/arcade-desert-parts.glb'
PARTS_INDEX_D = globals().get('REPO', ROOT) + '/src/world/desertParts.js'
DPARTS, DPART_ORDER, DKIND = {}, [], {}

# The desert palette the previews use (the plans' own palettes come from the pack's desert rules).
DESERT_PREVIEW = {
    'Wall': '#f4dfbd', 'Masonry': '#e3b98c', 'Roof': '#d8683f', 'Accent': '#35ada2', 'Timber': '#b97a4b', 'TimberDark': '#8a5537',
    'Stone': '#dfb489', 'StoneDark': '#b07e5c', 'Iron': '#6b6475', 'Glass': '#5a4658', 'Glow': '#ffd873', 'Leaf': '#6fae4a',
    'Petal': '#fff4e0', 'Gold': '#f0bd48', 'Bark': '#b98d5a', 'Blossom': '#ff8fb5', 'Awning': '#35ada2',
}


def dpart(pid, kind='house'):
    def reg(fn):
        DPARTS[pid] = fn; DPART_ORDER.append(pid); DKIND[pid] = kind; return fn
    return reg


def arch2(w, h, cu=0.0, v0=0.0, n=10):
    """A round-topped opening outline (the kit's arch_pts, finer)."""
    return arch_pts(w, h, cu, v0, n)


def pointed(w, h, cu=0.0, v0=0.0, n=6, lift=0.18):
    """A softly pointed arch: two arcs meeting a little above the round arch's crown."""
    r = w / 2; vs = v0 + h - r - lift
    left = [(cu - r + r * (1 - math.cos(math.pi / 2 * k / n)), vs + (r + lift) * math.sin(math.pi / 2 * k / n)) for k in range(n + 1)]
    right = [(cu + r - r * (1 - math.cos(math.pi / 2 * k / n)), vs + (r + lift) * math.sin(math.pi / 2 * k / n)) for k in range(n + 1)]
    return [(cu - r, v0), (cu + r, v0)] + right + list(reversed(left))[1:]


def stud_row(name, xs, z, y, r=0.035, slot='Iron'):
    return [blob(f'{name}{i}', (x, y, z), r, hm(slot), subd=1, jitter=0.0) for i, x in enumerate(xs)]


def cloth(name, w, h, point, y0, y1, z_top, slot='Accent', cx=0.0):
    """A hanging banner: w wide, h tall below z_top, its bottom edge pointed down by `point`."""
    pts = [(cx - w / 2, z_top), (cx - w / 2, z_top - h + point), (cx, z_top - h), (cx + w / 2, z_top - h + point), (cx + w / 2, z_top)]
    return chunky(prism(name, list(reversed(pts)), y0, y1, axis='Y', mat=hm(slot)), 0.015)


def diamond(name, cx, cz, r, y0, y1, slot):
    return chunky(prism(name, [(cx, cz - r), (cx + r * 0.72, cz), (cx, cz + r), (cx - r * 0.72, cz)], y0, y1, axis='Y', mat=hm(slot)), 0.01)

# ---------------------------------------------------------------- doors (w/h in the desert rules' houses.parts)


@dpart('door.desert.arch')
def _d():
    """A deep plaster arch round a studded teal door: 1.4 wide, 2.3 tall. The proud surround reads as a shaded entrance."""
    sur = ring_frame('sur', arch2(1.4, 2.3), arch2(1.0, 2.08, 0.0, -0.3), -0.22, 0.1, 'Wall', 0.06)
    reveal = ring_frame('rev', arch2(1.04, 2.1), arch2(0.98, 2.04, 0.0, -0.3), -0.2, 0.08, 'Glass', 0.0)
    leaf = panel('leaf', arch2(1.0, 2.04), -0.03, 0.06, 'Accent', 0.02)
    grooves = boxes('gr', [((0.03, 0.03, 1.7), (x, -0.045, 0.9)) for x in (-0.24, 0.0, 0.24)], hm('TimberDark'))
    studs = stud_row('st', (-0.34, -0.12, 0.12, 0.34), 0.55, -0.06) + stud_row('su', (-0.34, -0.12, 0.12, 0.34), 1.45, -0.06)
    ring = torus('rg', 0.075, 0.018, (0.3, -0.07, 1.02), hm('Gold'), axis='Y', segs=10)
    sill = ybox('sill', (1.2, 0.42, 0.08), (0, -0.12, 0.0), 'StoneDark', 0.02)
    ob = hfinish('door.desert.arch', [sur, reveal, leaf, grooves, ring, sill] + studs, 0.03)
    sock(ob, 'lamp', (0.98, 0, 1.45)); sock(ob, 'canopy', (0, 0, 2.36)); sock(ob, 'sign', (-0.98, 0, 1.95))
    return ob


@dpart('door.desert.square')
def _d():
    """Plaster jambs under a timber lintel whose ends run into the wall: 1.34 wide, 2.14 tall."""
    jambs = boxes('jb', [((0.24, 0.28, 2.0), (s * 0.55, -0.08, 1.0)) for s in (-1, 1)], hm('Wall'))
    chunky(jambs, 0.05)
    lintel = ybox('lin', (1.9, 0.36, 0.24), (0, -0.1, 2.08), 'Timber', 0.05)
    ends = boxes('le', [((0.14, 0.2, 0.2), (s * 0.82, -0.3, 2.08)) for s in (-1, 1)], hm('TimberDark'))
    back = ybox('back', (0.9, 0.04, 1.98), (0, 0.06, 0.99), 'Glass', 0.0)
    leaf = panel('leaf', rect_pts(0.86, 1.94), -0.02, 0.05, 'Accent', 0.02)
    rails = boxes('rl', [((0.8, 0.04, 0.1), (0, -0.04, z)) for z in (0.3, 1.64)], hm('TimberDark'))
    brace = chunky(strut('br', (-0.32, -0.04, 0.36), (0.32, -0.04, 1.58), 0.1, 0.04, hm('TimberDark')), 0.01)
    knock = torus('kn', 0.07, 0.018, (-0.26, -0.07, 1.0), hm('Iron'), axis='Y', segs=10)
    sill = ybox('sill', (1.3, 0.44, 0.08), (0, -0.12, 0.0), 'StoneDark', 0.02)
    ob = hfinish('door.desert.square', [jambs, lintel, ends, back, leaf, rails, brace, knock, sill], 0.03)
    sock(ob, 'lamp', (0.92, 0, 1.35)); sock(ob, 'canopy', (0, 0, 2.22)); sock(ob, 'sign', (-0.92, 0, 1.9))
    return ob


@dpart('door.desert.double')
def _d():
    """A grand sandstone arch with a keystone round a studded double door: 2.0 wide, 2.5 tall (merchant, inn)."""
    sur = ring_frame('sur', arch2(2.0, 2.5), arch2(1.52, 2.26, 0.0, -0.3), -0.2, 0.1, 'Stone', 0.06)
    key = chunky(prism('key', [(-0.16, 2.2), (0.16, 2.2), (0.21, 2.56), (-0.21, 2.56)], -0.26, 0.08, axis='Y', mat=hm('StoneDark')), 0.03)
    reveal = ring_frame('rev', arch2(1.56, 2.28), arch2(1.5, 2.22, 0.0, -0.3), -0.18, 0.08, 'Glass', 0.0)
    leaves = [panel(f'lf{s}', rect_pts(0.72, 2.2, s * 0.38), -0.03, 0.06, 'Accent', 0.02) for s in (-1, 1)]
    top = panel('top', arch2(1.5, 2.22), 0.0, 0.07, 'Accent', 0.0)
    split = ybox('split', (0.05, 0.05, 2.2), (0, -0.05, 1.1), 'TimberDark', 0.0)
    bands = boxes('bd', [((1.46, 0.035, 0.08), (0, -0.05, z)) for z in (0.4, 1.3)], hm('Iron'))
    studs = stud_row('st', (-0.6, -0.3, 0.3, 0.6), 0.85, -0.07) + stud_row('su', (-0.6, -0.3, 0.3, 0.6), 1.75, -0.07)
    rings = [torus(f'rg{s}', 0.07, 0.018, (s * 0.14, -0.08, 1.1), hm('Gold'), axis='Y', segs=10) for s in (-1, 1)]
    sill = ybox('sill', (1.9, 0.46, 0.08), (0, -0.12, 0.0), 'StoneDark', 0.02)
    ob = hfinish('door.desert.double', [sur, key, reveal, top, split, bands, sill] + leaves + studs + rings, 0.03)
    sock(ob, 'lamp', (1.28, 0, 1.55)); sock(ob, 'canopy', (0, 0, 2.58)); sock(ob, 'sign', (-1.28, 0, 2.0))
    return ob


@dpart('gate.court')
def _d():
    """The courtyard gateway: two piers and a round arch standing IN the courtyard wall (origin on its centre plane),
    the teal gate leaves swung half open into the yard. 1.8 clear, 2.75 to the crown."""
    piers = boxes('pr', [((0.46, 0.56, 2.15), (s * 1.13, 0, 1.075)) for s in (-1, 1)], hm('Wall'))
    chunky(piers, 0.08)
    arch = ring_frame('arch', arch2(2.72, 2.95), arch2(1.8, 2.62, 0.0, -0.3), -0.28, 0.28, 'Wall', 0.08)
    cut(arch, box('cutlow', (4.0, 1.0, 1.9), (0, 0, 0.9)))
    caps = boxes('cp', [((0.56, 0.66, 0.12), (s * 1.13, 0, 2.2)) for s in (-1, 1)], hm('Stone'))
    chunky(caps, 0.04)
    crown = ybox('crown', (0.5, 0.62, 0.16), (0, 0, 2.98), 'Stone', 0.04)
    leaves = []
    for s in (-1, 1):
        lf = panel(f'lf{s}', rect_pts(0.86, 1.9, s * 0.45), -0.04, 0.04, 'Accent', 0.02)
        bd = boxes(f'bd{s}', [((0.8, 0.03, 0.08), (s * 0.45, -0.05, z)) for z in (0.35, 1.5)], hm('TimberDark'))
        for o in (lf, bd):
            o.data.transform(Matrix.Translation((-s * 0.9, 0, 0)))
            o.data.transform(Matrix.Rotation(-s * math.radians(62), 4, 'Z'))
            o.data.transform(Matrix.Translation((s * 0.9, 0.12, 0)))
        leaves += [lf, bd]
    sill = ybox('sill', (1.8, 0.6, 0.06), (0, 0, 0.0), 'StoneDark', 0.02)
    return hfinish('gate.court', [piers, arch, caps, crown, sill] + leaves, 0.035)

# ---------------------------------------------------------------- windows


@dpart('win.desert.arch')
def _d():
    """A small, deep arched window: proud plaster reveal round a dark opening, a stone sill. 0.92 wide, 1.3 tall."""
    sur = ring_frame('sur', arch2(0.92, 1.3), arch2(0.6, 1.06, 0.0, 0.14), -0.16, 0.1, 'Wall', 0.05)
    void = panel('void', arch2(0.64, 1.08, 0.0, 0.12), -0.02, 0.06, 'Glass', 0.0)
    bars = boxes('bars', [((0.045, 0.04, 0.95), (0, -0.04, 0.6))], hm('TimberDark'))
    sill = ybox('sill', (0.98, 0.32, 0.12), (0, -0.12, 0.02), 'Stone', 0.035)
    ob = hfinish('win.desert.arch', [sur, void, bars, sill], 0.026)
    sock(ob, 'shutter', (0.47, -0.06, 0.14)); sock(ob, 'sill', (0, -0.16, 0.08))
    return ob


@dpart('win.desert.grille')
def _d():
    """A square window behind a wooden lattice under a timber lintel. 1.0 wide, 1.15 tall."""
    sur = ring_frame('sur', rrect(1.0, 1.1, 0.12, 0.0, 0.55), rect_pts(0.7, 0.8, 0.0, 0.15), -0.14, 0.1, 'Wall', 0.05)
    void = panel('void', rect_pts(0.72, 0.82, 0.0, 0.14), -0.02, 0.06, 'Glass', 0.0)
    lat = boxes('lat', [((0.045, 0.04, 0.8), (x, -0.05, 0.55)) for x in (-0.2, 0.0, 0.2)] + [((0.7, 0.04, 0.045), (0, -0.05, z)) for z in (0.33, 0.55, 0.77)], hm('TimberDark'))
    lintel = ybox('lin', (1.34, 0.3, 0.16), (0, -0.1, 1.12), 'Timber', 0.04)
    sill = ybox('sill', (1.04, 0.3, 0.1), (0, -0.1, 0.02), 'Stone', 0.03)
    ob = hfinish('win.desert.grille', [sur, void, lat, lintel, sill], 0.026)
    sock(ob, 'shutter', (0.5, -0.06, 0.12)); sock(ob, 'sill', (0, -0.14, 0.07))
    return ob


@dpart('win.desert.slot')
def _d():
    """An arrow-slit window in a stone frame, for the lookout. 0.52 wide, 1.1 tall."""
    sur = ring_frame('sur', arch2(0.52, 1.1), arch2(0.22, 0.86, 0.0, 0.12), -0.14, 0.1, 'Stone', 0.04)
    void = panel('void', arch2(0.24, 0.88, 0.0, 0.11), -0.02, 0.06, 'Glass', 0.0)
    ob = hfinish('win.desert.slot', [sur, void], 0.024)
    sock(ob, 'sill', (0, -0.12, 0.1))
    return ob


@dpart('win.mashrabiya')
def _d():
    """A latticed wooden bay window on corbels under a little plank hood: 1.7 wide, 0.6 out, 1.95 tall."""
    body = ybox('body', (1.56, 0.56, 1.4), (0, -0.28, 0.95), 'Timber', 0.04)
    face = ybox('face', (1.36, 0.04, 1.16), (0, -0.57, 0.95), 'Glass', 0.0)
    lat = boxes('lat', [((0.04, 0.04, 1.16), (x, -0.6, 0.95)) for x in (-0.45, -0.22, 0.0, 0.22, 0.45)]
                + [((1.36, 0.04, 0.04), (0, -0.6, z)) for z in (0.55, 0.8, 1.05, 1.3)], hm('TimberDark'))
    frame = ring_frame('fr', rect_pts(1.5, 1.32, 0.0, 0.29), rect_pts(1.34, 1.14, 0.0, 0.38), -0.64, -0.54, 'Timber', 0.02)
    corb = [chunky(prism(f'cb{s}', [(0.0, 0.25), (0.0, 0.0), (-0.5, 0.25)], s * 0.62 - 0.08, s * 0.62 + 0.08, axis='X', mat=hm('TimberDark')), 0.02) for s in (-1, 1)]
    base = ybox('base', (1.66, 0.66, 0.1), (0, -0.3, 0.24), 'TimberDark', 0.03)
    hood = chunky(prism('hood', [(0.02, 1.66), (-0.76, 1.72), (-0.76, 1.8), (0.02, 1.98)], -0.92, 0.92, axis='X', mat=hm('Timber')), 0.03)
    return hfinish('win.mashrabiya', [body, face, lat, frame, base, hood] + corb, 0.028)


@dpart('balcony.desert')
def _d():
    """A timber balcony on projecting beams with a low solid rail, hung on a window's sill socket. 1.9 wide."""
    floor = ybox('floor', (1.9, 0.78, 0.1), (0, -0.39, -0.05), 'Timber', 0.03)
    beams = boxes('bm', [((0.14, 0.95, 0.14), (x, -0.36, -0.17)) for x in (-0.7, 0.0, 0.7)], hm('TimberDark'))
    rail = ybox('rail', (1.9, 0.08, 0.08), (0, -0.76, 0.86), 'Timber', 0.02)
    sides = boxes('sd', [((0.08, 0.76, 0.08), (s * 0.91, -0.38, 0.86)) for s in (-1, 1)], hm('Timber'))
    bal = boxes('bal', [((0.07, 0.07, 0.8), (-0.8 + i * 0.2, -0.76, 0.42)) for i in range(9)] + [((0.07, 0.07, 0.8), (s * 0.91, -0.4 + d, 0.42)) for s in (-1, 1) for d in (-0.18, 0.12)], hm('TimberDark'))
    return hfinish('balcony.desert', [floor, beams, rail, sides, bal], 0.025)

# ---------------------------------------------------------------- trims


@dpart('shutter.desert')
def _d():
    """One teal plank shutter hinged on the right socket (the grammar mirrors it to the left)."""
    pn = panel('pn', rect_pts(0.34, 1.0, 0.19), -0.04, 0.02, 'Accent', 0.02)
    gr = boxes('gr', [((0.022, 0.02, 0.94), (x, -0.045, 0.5)) for x in (0.12, 0.26)], hm('TimberDark'))
    bt = boxes('bt', [((0.3, 0.03, 0.07), (0.19, -0.055, z)) for z in (0.18, 0.82)], hm('TimberDark'))
    return hfinish('shutter.desert', [pn, gr, bt], 0.02)


@dpart('sill.pots')
def _d():
    """Two clay pots of succulents on a sill."""
    parts = []
    for i, (x, s) in enumerate(((-0.2, 1.0), (0.18, 0.8))):
        parts.append(smooth(lathe(f'pot{i}', [(0.0, 0.0), (0.09 * s, 0.0), (0.13 * s, 0.12 * s), (0.14 * s, 0.2 * s), (0.12 * s, 0.22 * s), (0.0, 0.22 * s)], axis='Z', segs=10, mat=hm('Roof'), center=(x, -0.08, 0)), 40, weighted=False))
        for k in range(3):
            a = 2 * math.pi * k / 3 + i
            parts.append(blob(f'suc{i}{k}', (x + math.cos(a) * 0.05 * s, -0.08 + math.sin(a) * 0.05 * s, 0.25 * s), 0.07 * s, hm('Leaf'), subd=2, scale=(0.8, 0.8, 1.4), jitter=0.05, seed=k))
    return hfinish('sill.pots', parts, 0.018)


def _stripes(name, w, n, y_wall, z_wall, y_out, z_out, thick=0.06):
    """A striped fabric slab from the wall line out to the front edge: n strips, Accent and Petal by turns."""
    out = []
    for k in range(n):
        x0 = -w / 2 + w * k / n; x1 = x0 + w / n
        out.append(prism(f'{name}{k}', [(y_wall, z_wall), (y_out, z_out), (y_out, z_out - thick), (y_wall, z_wall - thick)], x0, x1, axis='X', mat=hm('Accent' if k % 2 == 0 else 'Petal')))
    return out


def _valance(name, w, n, y, z):
    out = []
    for k in range(n):
        cx = -w / 2 + w * (k + 0.5) / n
        pts = [(cx - w / n / 2, z), (cx + w / n / 2, z)] + [(cx + math.cos(math.pi * j / 6) * w / n / 2, z - 0.02 - math.sin(math.pi * j / 6) * w / n * 0.42) for j in range(1, 6)]
        out.append(chunky(prism(f'{name}{k}', pts, y - 0.02, y + 0.02, axis='Y', mat=hm('Accent')), 0.008))
    return out


@dpart('awning.door')
def _d():
    """A striped fabric awning over a door on two wall brackets: 1.9 wide, 1.0 out (the canopy socket)."""
    slab = _stripes('st', 1.9, 5, 0.02, 0.32, -1.0, -0.02)
    rod = smooth(cyl('rod', 0.04, -1.0, 1.0, axis='X', segs=8, mat=hm('Timber'), center=(0, -1.0, -0.04)), 40, weighted=False)
    val = _valance('va', 1.9, 5, -1.02, -0.04)
    br = [chunky(strut(f'b{s}', (s * 0.85, -0.02, -0.5), (s * 0.85, -0.98, -0.06), 0.08, 0.08, hm('TimberDark')), 0.015) for s in (-1, 1)]
    return hfinish('awning.door', slab + [rod] + val + br, 0.025)


@dpart('awning.wide')
def _d():
    """The shop front's broad awning on two poles (merchant, inn): 3.4 wide, 1.9 out, from the canopy socket at the
    door's head. The poles run down past any door's foot into the ground."""
    slab = _stripes('st', 3.4, 7, 0.02, 0.5, -1.9, 0.1, 0.07)
    beam = ybox('beam', (3.5, 0.14, 0.16), (0, -1.9, 0.02), 'Timber', 0.03)
    val = _valance('va', 3.4, 7, -1.92, 0.0)
    poles = boxes('po', [((0.13, 0.13, 3.35), (s * 1.6, -1.9, -1.64)) for s in (-1, 1)], hm('TimberDark'))
    chunky(poles, 0.02)
    feet = boxes('ft', [((0.26, 0.26, 0.18), (s * 1.6, -1.9, -2.58)) for s in (-1, 1)], hm('StoneDark'))
    chunky(feet, 0.03)
    return hfinish('awning.wide', slab + [beam] + val + [poles, feet], 0.028)


@dpart('lamp.desert')
def _d():
    """A brass lantern on a wall bracket (the lamp socket)."""
    arm = ybox('arm', (0.06, 0.42, 0.06), (0, -0.21, 0.34), 'Iron', 0.01)
    hook = ybox('hook', (0.03, 0.03, 0.12), (0, -0.42, 0.28), 'Iron', 0.0)
    body = smooth(lathe('glow', [(0.0, -0.12), (0.1, -0.1), (0.12, 0.02), (0.1, 0.14), (0.0, 0.16)], axis='Z', segs=8, mat=hm('Glow'), center=(0, -0.42, 0.0)), 40, weighted=False)
    cap = smooth(lathe('cap', [(0.13, 0.13), (0.1, 0.18), (0.03, 0.3), (0.0, 0.32)], axis='Z', segs=8, mat=hm('Gold'), center=(0, -0.42, 0.0)), 40, weighted=False)
    base = smooth(lathe('base', [(0.0, -0.2), (0.05, -0.2), (0.11, -0.12), (0.0, -0.11)], axis='Z', segs=8, mat=hm('Gold'), center=(0, -0.42, 0.0)), 40, weighted=False)
    ribs = boxes('rb', [((0.02, 0.02, 0.24), (math.cos(a) * 0.115, -0.42 + math.sin(a) * 0.115, 0.02)) for a in (0.4, 2.0, 3.5, 5.1)], hm('Gold'))
    return hfinish('lamp.desert', [arm, hook, body, cap, base, ribs], 0.018)


@dpart('banner.small')
def _d():
    """A cloth banner on a rod flat against the wall beside the door (the sign socket), a diamond on it."""
    rod = smooth(cyl('rod', 0.03, -0.42, 0.42, axis='X', segs=8, mat=hm('Timber'), center=(0, -0.06, 0.34)), 40, weighted=False)
    knobs = [sphere(f'k{s}', (s * 0.44, -0.06, 0.34), 0.045, 'Gold') for s in (-1, 1)]
    cl = cloth('cl', 0.66, 1.25, 0.2, -0.05, -0.02, 0.32)
    d0 = diamond('d0', 0, -0.2, 0.22, -0.065, -0.045, 'Petal')
    d1 = diamond('d1', 0, -0.2, 0.1, -0.075, -0.06, 'Roof')
    return hfinish('banner.small', [rod, cl, d0, d1] + knobs, 0.02)


@dpart('banner.tall')
def _d():
    """A long wall banner for the lookout's front (the `upper` slot): 1.0 wide, 2.2 tall above its origin."""
    rod = smooth(cyl('rod', 0.035, -0.58, 0.58, axis='X', segs=8, mat=hm('Timber'), center=(0, -0.07, 2.2)), 40, weighted=False)
    knobs = [sphere(f'k{s}', (s * 0.6, -0.07, 2.2), 0.05, 'Gold') for s in (-1, 1)]
    cl = cloth('cl', 0.9, 2.1, 0.28, -0.06, -0.02, 2.18)
    d0 = diamond('d0', 0, 1.2, 0.34, -0.075, -0.055, 'Petal')
    d1 = diamond('d1', 0, 1.2, 0.15, -0.085, -0.07, 'Roof')
    return hfinish('banner.tall', [rod, cl, d0, d1] + knobs, 0.022)


@dpart('sign.inn')
def _d():
    """The inn's hanging board on an iron arm out of the wall, a cup on both faces (the sign socket)."""
    arm = ybox('arm', (0.06, 0.86, 0.06), (0, -0.42, 0.3), 'Iron', 0.01)
    curl = torus('curl', 0.12, 0.02, (0, -0.16, 0.16), hm('Iron'), axis='X', segs=10)
    board = ybox('board', (0.08, 0.72, 0.5), (0, -0.52, -0.1), 'Timber', 0.04)
    rim = ring_frame('rim', rrect(0.78, 0.56, 0.06, -0.52, -0.1), rrect(0.66, 0.44, 0.04, -0.52, -0.1), -0.05, 0.05, 'TimberDark', 0.01)
    rim.data.transform(Matrix.Rotation(math.pi / 2, 4, 'Z'))
    chains = boxes('ch', [((0.02, 0.02, 0.16), (0, y, 0.19)) for y in (-0.24, -0.8)], hm('Iron'))
    cups = []
    for s in (-1, 1):
        cups.append(prism(f'cup{s}', [(-0.62, -0.26), (-0.42, -0.26), (-0.4, 0.05), (-0.64, 0.05)], s * 0.045, s * 0.07, axis='X', mat=hm('Petal')))
        cups.append(torus(f'hd{s}', 0.07, 0.02, (s * 0.058, -0.36, -0.1), hm('Petal'), axis='X', segs=8))
        cups.append(prism(f'fo{s}', [(-0.66, 0.03), (-0.38, 0.03), (-0.4, 0.12), (-0.64, 0.12)], s * 0.05, s * 0.075, axis='X', mat=hm('Gold')))
    return hfinish('sign.inn', [arm, curl, board, rim, chains] + cups, 0.02)

# ---------------------------------------------------------------- roof pieces


@dpart('dome.finial')
def _d():
    """The gold finial on a dome's crown (the `topper` slot with a dome)."""
    collar = smooth(lathe('col', [(0.0, 0.0), (0.16, 0.0), (0.12, 0.1), (0.07, 0.14), (0.0, 0.14)], axis='Z', segs=12, mat=hm('Gold')), 40, weighted=False)
    ball = sphere('ball', (0, 0, 0.3), 0.13, 'Gold')
    spike = smooth(lathe('sp', [(0.05, 0.4), (0.0, 0.78)], axis='Z', segs=8, mat=hm('Gold')), 40, weighted=False)
    ball2 = sphere('b2', (0, 0, 0.56), 0.06, 'Gold')
    return hfinish('dome.finial', [collar, ball, spike, ball2], 0.02)


@dpart('tower.canopy')
def _d():
    """The lookout's rooftop shelter: four posts, a shallow plank roof and a flag, authored for a 3.2 m square roof
    (the grammar scales it to the tower's deck). Stands on the roof deck at its centre."""
    posts = boxes('po', [((0.18, 0.18, 1.95), (x, y, 0.97)) for x in (-1.3, 1.3) for y in (-1.3, 1.3)], hm('Timber'))
    chunky(posts, 0.03)
    beams = boxes('bm', [((2.9, 0.2, 0.2), (0, y, 1.95)) for y in (-1.3, 1.3)] + [((0.2, 2.9, 0.2), (x, 0, 1.95)) for x in (-1.3, 1.3)], hm('TimberDark'))
    chunky(beams, 0.03)
    rail = boxes('rl', [((2.6, 0.1, 0.1), (0, y, 0.7)) for y in (-1.3, 1.3)] + [((0.1, 2.6, 0.1), (x, 0, 0.7)) for x in (-1.3, 1.3)], hm('TimberDark'))
    slabs = []
    for s in (-1, 1):
        slabs.append(chunky(prism(f'rf{s}', [(0.0, 2.62), (s * 1.75, 2.06), (s * 1.75, 1.96), (0.0, 2.5)], -1.75, 1.75, axis='Y', mat=hm('Roof')), 0.04))
    ridge = smooth(cyl('rg', 0.1, -1.8, 1.8, axis='Y', segs=8, mat=hm('Timber'), center=(0, 0, 2.62)), 40, weighted=False)
    pole = smooth(cyl('pole', 0.05, 2.5, 4.3, axis='Z', segs=8, mat=hm('Timber'), center=(0.9, 0.9, 0)), 40, weighted=False)
    ball = sphere('ball', (0.9, 0.9, 4.34), 0.08, 'Gold')
    flag = chunky(prism('flag', [(0.95, 4.2), (1.9, 3.95), (1.72, 3.78), (1.9, 3.6), (0.95, 3.55)], 0.88, 0.92, axis='Y', mat=hm('Accent')), 0.01)
    return hfinish('tower.canopy', [posts, beams, rail, ridge, pole, ball, flag] + slabs, 0.03)

# ---------------------------------------------------------------- yard props


def _jar(name, x, y, s, slot='Roof', neck=True):
    prof = [(0.0, 0.0), (0.16 * s, 0.0), (0.26 * s, 0.14 * s), (0.3 * s, 0.34 * s), (0.25 * s, 0.56 * s), (0.13 * s, 0.68 * s)]
    prof += [(0.12 * s, 0.78 * s), (0.17 * s, 0.84 * s), (0.12 * s, 0.86 * s), (0.0, 0.8 * s)] if neck else [(0.16 * s, 0.7 * s), (0.0, 0.66 * s)]
    return smooth(lathe(name, prof, axis='Z', segs=12, mat=hm(slot), center=(x, y, 0)), 40, weighted=False)


@dpart('yard.jars')
def _d():
    """Clay jars of three sizes and one glazed teal one."""
    return hfinish('yard.jars', [_jar('a', -0.3, 0.05, 1.15), _jar('b', 0.28, 0.12, 0.85), _jar('c', 0.05, -0.36, 0.62, 'Accent'), _jar('d', 0.55, -0.3, 0.5, 'Roof', False)], 0.028, (0.74, 0.7, 0.8))


def _basket(name, x, y, r, h):
    body = smooth(lathe(name, [(0.0, 0.0), (r * 0.8, 0.0), (r, h * 0.8), (r * 1.04, h), (r * 0.92, h), (0.0, h * 0.9)], axis='Z', segs=12, mat=hm('Timber'), center=(x, y, 0)), 40, weighted=False)
    bands = [lathe(f'{name}b{i}', [(r * t - 0.005, h * z), (r * t + 0.02, h * z + 0.01), (r * t + 0.02, h * z + 0.05), (r * t - 0.005, h * z + 0.06)], axis='Z', segs=12, mat=hm('TimberDark'), center=(x, y, 0), cap=False) for i, (t, z) in enumerate(((0.9, 0.3), (1.0, 0.7)))]
    return [body] + bands


@dpart('yard.baskets')
def _d():
    """Two woven baskets heaped with fruit and grain."""
    P = _basket('a', -0.25, 0.0, 0.3, 0.36) + _basket('b', 0.32, 0.1, 0.24, 0.28)
    rnd = random.Random(5)
    for i in range(5):
        a = 2 * math.pi * i / 5; P.append(blob(f'f{i}', (-0.25 + math.cos(a) * 0.14, math.sin(a) * 0.14, 0.4), 0.09, hm('Roof' if i % 2 else 'Gold'), subd=2, jitter=0.03, seed=i))
    P.append(blob('grain', (0.32, 0.1, 0.3), 0.2, hm('Petal'), subd=2, scale=(1, 1, 0.45), jitter=0.05, seed=9))
    return hfinish('yard.baskets', P, 0.025, (0.74, 0.7, 0.8))


@dpart('yard.crates')
def _d():
    """Two crates and a barrel by the workshop door."""
    P = _crate('a', (0.7, 0.66, 0.6), (-0.35, 0.05, 0.0), 0.12) + _crate('b', (0.5, 0.5, 0.42), (-0.3, 0.02, 0.6), -0.3) + _barrel('c', (0.5, 0.05, 0.0), 0.8)
    return hfinish('yard.crates', P, 0.028, (0.72, 0.68, 0.8))


@dpart('yard.water')
def _d():
    """A tall water jar on a wooden stand beside a stone trough of water."""
    stand = boxes('st', [((0.08, 0.08, 0.5), (x, y, 0.25)) for x in (-0.62, -0.18) for y in (-0.2, 0.2)] + [((0.56, 0.52, 0.06), (-0.4, 0, 0.5))], hm('TimberDark'))
    jar = _jar('jar', -0.4, 0.0, 1.0)
    jar.location.z = 0.53
    trough = ybox('tr', (0.9, 0.5, 0.42), (0.42, 0.0, 0.21), 'Stone', 0.05)
    water = ybox('wa', (0.72, 0.34, 0.04), (0.42, 0.0, 0.37), 'Accent', 0.0)
    return hfinish('yard.water', [stand, jar, trough, water], 0.028)


@dpart('yard.rug')
def _d():
    """A patterned rug airing over a rail on two posts."""
    posts = boxes('po', [((0.1, 0.1, 1.3), (s * 0.85, 0, 0.65)) for s in (-1, 1)], hm('TimberDark'))
    rail = smooth(cyl('rail', 0.045, -0.95, 0.95, axis='X', segs=8, mat=hm('Timber'), center=(0, 0, 1.22)), 40, weighted=False)
    rug = chunky(prism('rug', [(-0.26, 0.45), (-0.05, 1.26), (0.05, 1.26), (0.26, 0.45), (0.22, 0.43), (0.02, 1.2), (-0.02, 1.2), (-0.22, 0.43)], -0.7, 0.7, axis='X', mat=hm('Roof')), 0.01)
    bands = [prism(f'bd{k}', [(-0.23, 0.62 + k * 0.22), (-0.19, 0.78 + k * 0.22), (-0.17, 0.78 + k * 0.22), (-0.21, 0.62 + k * 0.22)], -0.72, 0.72, axis='X', mat=hm('Petal' if k % 2 else 'Accent')) for k in range(3)]
    bands += [prism(f'bf{k}', [(0.21, 0.62 + k * 0.22), (0.17, 0.78 + k * 0.22), (0.19, 0.78 + k * 0.22), (0.23, 0.62 + k * 0.22)], -0.72, 0.72, axis='X', mat=hm('Petal' if k % 2 else 'Accent')) for k in range(3)]
    fringe = boxes('fr', [((0.04, 0.04, 0.1), (x, s * 0.25, 0.4)) for x in (-0.6, -0.3, 0.0, 0.3, 0.6) for s in (-1, 1)], hm('Petal'))
    return hfinish('yard.rug', [posts, rail, rug, fringe] + bands, 0.022)

# ---------------------------------------------------------------- desert kit materials and tone ramps

PALM = ('#2f7032', '#4f9e3e', '#7fc64d', '#b8e46c')          # frond ramp, dark crease -> sunlit tip
CACTUS = ('#2f6a3e', '#4d9447', '#70b357', '#98cf6c')
DRY = ('#6e5a31', '#9a8243', '#c3a85c', '#e3cd86')
AGAVE = ('#5f7f2c', '#8ea43b', '#b9c653', '#dfe08a')
REED = ('#4f7d34', '#78a844', '#a6c95a', '#d5e489')
SANDSTONE = {'ARC_Sandstone': '#e39d63', 'ARC_SandstoneDark': '#c07e52'}


def _dm():
    """The kit's ARC_ materials plus the desert's sandstone (toon-swapped by the engine like every ARC_ material)."""
    M = {m.name[4:]: m for m in bpy.data.materials if m.name.startswith('ARC_')}
    if 'Wood' not in M: M = materials(); set_look()
    for name, hex_ in SANDSTONE.items():
        M[name[4:]] = bpy.data.materials.get(name) or toon(name, hex_)
    return M


def _cols(ob, fn):
    _set_col(ob, [fn(v) for v in ob.data.vertices])

# ---------------------------------------------------------------- tree parts: palm crowns, cactus caps (TRE_ slots)


def _frond(name, length, width, droop, lift, stations, mat, rib=None):
    """One palm frond along +X: a long arching blade whose edges are cut into swept-back leaflets (a saw-tooth
    silhouette), folded down from its midrib like a roof ridge (it reads from below, where the player stands), closed
    into a thin slab. Its root sits on the origin."""
    bm = bmesh.new(); rows = []
    for i in range(stations + 1):
        t = i / stations; x = length * t
        env = width * 0.5 * max(0.0, math.sin(math.pi * min(1.0, 0.08 + t * 0.94))) ** 0.6
        tooth = i % 2 == 1 and 0 < i < stations
        hw = max(0.035, env * (1.0 if tooth else 0.42))
        back = 0.09 * length / stations * 3 if tooth else 0.0
        z = lift * 4 * t * (1 - t) - droop * t ** 2.2
        ridge = 0.07 * (1 - t) + 0.02
        rows.append([bm.verts.new((x - back, -hw, z - hw * 0.48)), bm.verts.new((x, 0.0, z + ridge)), bm.verts.new((x - back, hw, z - hw * 0.48))])
    for a, b in zip(rows, rows[1:]):
        for k in range(2): bm.faces.new((a[k], b[k], b[k + 1], a[k + 1]))
    bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=0.04)
    ob = new_obj(name, bm, mat); ob.data.shade_smooth()
    _cols(ob, lambda v: mult_ramp(PALM, 0.28 + 0.5 * min(1.0, v.co.x / length) + (0.22 if v.normal.z > 0.2 else -0.18) + 0.18 * min(1.0, abs(v.co.y) / max(width * 0.5, 1e-6))))
    return ob


def _palm_crown(pid, lite, fronds=10, length=2.5, droop=1.45, seed=3, nuts=True):
    """A palm's crown on its socket (the trunk's top): three fronds reaching up, the rest arching out and down, a
    green heart and, on the older palm, a bunch of dates/coconuts under it."""
    rnd = random.Random(seed); P = []
    n = max(6, fronds - 3) if lite else fronds
    for i in range(n):
        yaw = 2 * math.pi * i / n + rnd.uniform(-0.15, 0.15)
        up = i % 3 == 0
        fr = _frond(f'{pid}_f{i}', length * rnd.uniform(0.88, 1.08) * (0.85 if up else 1.0), 0.95, droop * (0.45 if up else rnd.uniform(0.9, 1.15)), 0.4 if up else 0.22, 8 if lite else 14, tm('Leaf'))
        xform(fr, rot=[('Y', -math.radians(42 if up else rnd.uniform(6, 18))), ('Z', yaw)], loc=(0, 0, 0.05))
        P.append(fr)
    heart = lathe(f'{pid}_h', [(0.0, -0.32), (0.22, -0.3), (0.26, -0.05), (0.15, 0.22), (0.0, 0.45)], axis='Z', segs=6 if lite else 10, mat=tm('Leaf'))
    heart.data.shade_smooth(); _cols(heart, lambda v: mult_ramp(PALM, 0.2 + 0.6 * max(0.0, v.co.z + 0.32) / 0.77)); P.append(heart)
    if nuts:
        for k in range(3 if lite else 5):
            a = 2 * math.pi * k / 5 + 0.4
            c = blob(f'{pid}_n{k}', (math.cos(a) * 0.18, math.sin(a) * 0.18, -0.32 - 0.06 * (k % 2)), 0.12, tm('Bark'), subd=2, jitter=0.03, seed=k)
            _cols(c, lambda v: (0.62, 0.5, 0.42)); P.append(c)
    ob = merge(pid, P) if len(P) > 1 else P[0]
    return tfinish(pid, ob)


@dpart('palm.crown.a', 'tree')
def _d(): return _palm_crown('palm.crown.a', False)
@dpart('palm.crown.a.lite', 'tree')
def _d(): return _palm_crown('palm.crown.a.lite', True)
@dpart('palm.crown.b', 'tree')
def _d(): return _palm_crown('palm.crown.b', False, fronds=7, length=1.8, droop=0.8, seed=5, nuts=False)
@dpart('palm.crown.b.lite', 'tree')
def _d(): return _palm_crown('palm.crown.b.lite', True, fronds=7, length=1.8, droop=0.8, seed=5, nuts=False)


def _cap(pid, lite, flower):
    """The rounded top of a cactus limb (the limb's own colour, TRE_Bark), a flower on it if asked: radius 0.3."""
    segs = 8
    cap = lathe(pid + '_c', [(0.3, -0.06), (0.3, 0.02), (0.27, 0.13), (0.19, 0.24), (0.09, 0.3), (0.0, 0.32)], axis='Z', segs=segs, mat=tm('Bark'))
    cap.data.shade_smooth()
    _cols(cap, lambda v: (0.9 + 0.1 * math.cos(4 * math.atan2(v.co.y, v.co.x)),) * 3)
    P = [cap]
    if flower:
        for k in range(5):
            a = 2 * math.pi * k / 5
            P.append(blob(f'{pid}_p{k}', (math.cos(a) * 0.07, math.sin(a) * 0.07, 0.33), 0.06, tm('Blossom'), subd=1, scale=(1.2, 1.2, 0.5), jitter=0.0))
        P.append(blob(pid + '_m', (0, 0, 0.36), 0.035, tm('Gold'), subd=1, jitter=0.0))
    for o in P[1:]: ensure_grad([o])
    ob = merge(pid, P) if len(P) > 1 else P[0]
    return tfinish(pid, ob)


@dpart('cactus.cap', 'tree')
def _d(): return _cap('cactus.cap', False, False)
@dpart('cactus.cap.flower', 'tree')
def _d(): return _cap('cactus.cap.flower', False, True)

# ---------------------------------------------------------------- nature parts: cacti, shrubs, reeds, rocks, stones


def _ribbed(name, M, r, h, ribs=8, segs=16, lean=0.0):
    """A ribbed cactus body: a rounded column whose radius swells on `ribs` ribs, shaded dark in the grooves."""
    prof = [(0.0, 0.0), (r * 0.8, 0.0), (r, h * 0.12), (r, h * 0.72), (r * 0.82, h * 0.92), (r * 0.45, h), (0.0, h * 1.02)]
    ob = lathe(name, prof, axis='Z', segs=segs, mat=M['Leaf'])
    for v in ob.data.vertices:
        a = math.atan2(v.co.y, v.co.x); k = 1 + 0.1 * math.cos(ribs * a)
        v.co.x *= k; v.co.y *= k; v.co.x += lean * v.co.z * v.co.z
    ob.data.shade_smooth()
    _cols(ob, lambda v: ramp(CACTUS, 0.35 + 0.35 * min(1.0, v.co.z / h) + 0.3 * (0.5 + 0.5 * math.cos(ribs * math.atan2(v.co.y, v.co.x)))))
    return ob


@dpart('cactus.barrel', 'nature')
def _d():
    M = _dm(); P = [_ribbed('cb0', M, 0.34, 0.62, 12, 18)]
    b = _ribbed('cb1', M, 0.2, 0.34, 10, 14); b.location = (0.42, 0.16, 0); P.append(b)
    for k in range(5):
        a = 2 * math.pi * k / 5
        P.append(blob(f'cbf{k}', (math.cos(a) * 0.09, math.sin(a) * 0.09, 0.66), 0.075, M['CoralPink'], subd=1, scale=(1.1, 1.1, 0.55), jitter=0.0))
    P.append(blob('cbm', (0, 0, 0.7), 0.05, M['ButterYellow'], subd=1, jitter=0.0))
    return nfinish('cactus.barrel', P, 0.025)


@dpart('cactus.pear', 'nature')
def _d():
    """Prickly pear: flat oval pads stacked on each other, red fruit on the top edges."""
    M = _dm(); rnd = random.Random(12); P = []
    pads = [((0, 0, 0.36), 0.0, 0.0, 1.0), ((0.18, 0.02, 0.86), 0.5, 0.2, 0.8), ((-0.2, -0.02, 0.8), -0.45, -0.3, 0.85), ((0.02, 0.05, 1.22), 0.1, 0.9, 0.7), ((0.38, -0.08, 0.4), 0.9, 1.3, 0.75)]
    for i, (c, tilt, yaw, s) in enumerate(pads):
        pad = blob(f'pp{i}', (0, 0, 0), 0.34 * s, M['Leaf'], subd=2, scale=(1.0, 0.32, 1.25), jitter=0.04, seed=i)
        xform(pad, rot=[('Y', tilt), ('Z', yaw)], loc=c)
        _cols(pad, lambda v: ramp(CACTUS, 0.4 + 0.5 * max(0.0, v.normal.z) + 0.1 * rnd.random()))
        P.append(pad)
    for i, (x, y, z) in enumerate(((0.24, 0.0, 1.2), (-0.18, 0.0, 1.46), (0.06, 0.1, 1.55), (-0.38, 0.0, 1.08))):
        P.append(blob(f'pf{i}', (x, y, z), 0.07, M['CoralPink'], subd=1, scale=(1, 1, 1.25), jitter=0.0))
    return nfinish('cactus.pear', P, 0.025)


@dpart('cactus.small', 'nature')
def _d():
    """A young two-armed column cactus, knee high."""
    M = _dm(); body = _ribbed('cs0', M, 0.16, 1.0, 8, 12)
    arms = []
    for s, z, h in ((1, 0.45, 0.35), (-1, 0.62, 0.26)):
        a = _ribbed(f'csa{s}', M, 0.1, h, 8, 10); a.location = (s * 0.28, 0, z)
        el = lathe(f'cse{s}', [(0.1, 0.0), (0.1, 0.24)], axis='X', segs=10, mat=M['Leaf'], center=(0, 0, 0))
        el.data.transform(Matrix.Translation((0.06 if s > 0 else -0.3, 0, z - 0.02))); el.data.shade_smooth()
        _cols(el, lambda v: ramp(CACTUS, 0.55)); arms += [a, el]
    return nfinish('cactus.small', [body] + arms, 0.022)


def _dry_bush(name, M, r, seed, stops=DRY, twigs=True):
    b = puff(name, r, M['Leaf'], subd=3, cells=12, depth=0.28, lobes=0.18, squash=(1.1, 1.0, 0.72), seed=seed)
    decimate(b, 0.55)
    lo = min(v.co.z for v in b.data.vertices); hi = max(v.co.z for v in b.data.vertices)
    paint_foliage(b, stops, lo, hi)
    for v in b.data.vertices: v.co.z -= lo
    P = [b]
    if twigs:
        rnd = random.Random(seed)
        for k in range(5):
            a = rnd.uniform(0, 2 * math.pi); el = rnd.uniform(0.4, 1.0)
            tip = Vector((math.cos(a) * r * 1.15, math.sin(a) * r * 1.15, (hi - lo) * el))
            P.append(limb(f'{name}_t{k}', (0, 0, 0.05), tip, 0.03, 0.012, M['WoodDark'], segs=4))
    return P


@dpart('shrub.dry.a', 'nature')
def _d():
    M = _dm(); return nfinish('shrub.dry.a', _dry_bush('sda', M, 0.55, 31), 0.025)


@dpart('shrub.dry.b', 'nature')
def _d():
    M = _dm(); P = _dry_bush('sdb', M, 0.42, 32) + [o for o in _dry_bush('sdc', M, 0.3, 33, twigs=False)]
    P[-1].location = (0.42, 0.18, 0)
    return nfinish('shrub.dry.b', P, 0.025)


def _spike(name, M, length, width, yaw, tilt, curl, stops, n=4):
    """One spiky blade (agave leaf, dry grass): a tapered, keeled slab from the origin outward and up."""
    bm = bmesh.new(); rows = []
    for i in range(n + 1):
        t = i / n; hw = width * 0.5 * (1 - t) ** 0.9 + 0.012
        x = length * t; z = curl * t * t
        rows.append([bm.verts.new((x, -hw, z + hw * 0.3)), bm.verts.new((x, 0.0, z)), bm.verts.new((x, hw, z + hw * 0.3))])
    for a, b in zip(rows, rows[1:]):
        for k in range(2): bm.faces.new((a[k], b[k], b[k + 1], a[k + 1]))
    bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=0.03)
    ob = new_obj(name, bm, M['Leaf']); ob.data.shade_smooth()
    _cols(ob, lambda v: ramp(stops, 0.25 + 0.7 * min(1.0, v.co.x / length) + (0.08 if v.normal.z > 0 else -0.1)))
    xform(ob, rot=[('Y', -tilt), ('Z', yaw)])
    return ob


@dpart('agave', 'nature')
def _d():
    """The desert shrub of the reference sheet: a spiky rosette, yellow-green, knee high."""
    M = _dm(); rnd = random.Random(41); P = []
    for ring, (n, ln, tilt) in enumerate(((8, 0.62, 0.35), (6, 0.55, 0.85), (3, 0.4, 1.25))):
        for k in range(n):
            P.append(_spike(f'ag{ring}{k}', M, ln * rnd.uniform(0.9, 1.1), 0.2 - ring * 0.03, 2 * math.pi * k / n + ring * 0.4, tilt, 0.06, AGAVE, n=3))
    return nfinish('agave', P, 0.018)


@dpart('tuft.dry', 'nature')
def _d():
    """A dry grass tuft: thin straw blades fanning out (sways in the wind)."""
    M = _dm(); rnd = random.Random(43); P = []
    for k in range(9):
        P.append(_spike(f'td{k}', M, rnd.uniform(0.32, 0.46), 0.06, 2 * math.pi * k / 9 + rnd.uniform(-0.2, 0.2), rnd.uniform(0.9, 1.3), 0.08, DRY))
    return nfinish('tuft.dry', P, 0.0)


@dpart('reeds.oasis', 'nature')
def _d():
    """Oasis papyrus: slim stems with starburst heads, and a few blades at the foot (sways in the wind)."""
    M = _dm(); rnd = random.Random(47); P = []
    for k in range(4):
        a = 2 * math.pi * k / 4 + rnd.uniform(-0.3, 0.3); r = rnd.uniform(0.05, 0.18); h = rnd.uniform(0.95, 1.35)
        base = (math.cos(a) * r, math.sin(a) * r, 0.0); top = (base[0] + math.cos(a) * 0.12, base[1] + math.sin(a) * 0.12, h)
        st = limb(f'rs{k}', base, top, 0.018, 0.012, M['Leaf'], segs=4); _cols(st, lambda v: ramp(REED, 0.3 + 0.5 * v.co.z / h)); P.append(st)
        for q in range(5):
            P.append(_spike(f'rh{k}{q}', M, 0.2, 0.05, 2 * math.pi * q / 5, -0.25, -0.05, REED, n=2))
            P[-1].location = top
    for k in range(5):
        P.append(_spike(f'rb{k}', M, rnd.uniform(0.35, 0.5), 0.07, 2 * math.pi * k / 5, 1.1, 0.05, REED))
    return nfinish('reeds.oasis', P, 0.0)


def _sandstone(name, M, size, seed, dark=False, loc=(0.0, 0.0, 0.0), yaw=0.0):
    """A wind-rounded sandstone boulder: a chunky rounded box with soft layered bands, flat on its bed."""
    ob = rock(name, size, M['SandstoneDark' if dark else 'Sandstone'], seed=seed, yaw=yaw, round_=0.38)
    h = size[2]
    _cols(ob, lambda v: tuple(c * (0.8 + 0.2 * min(1.0, v.co.z / h)) * (0.94 if int(v.co.z / (h / 3.2)) % 2 else 1.0) for c in (1.0, 0.97, 1.0)))
    ob.location = loc
    return ob


@dpart('rock.sand.a', 'nature')
def _d():
    M = _dm(); return nfinish('rock.sand.a', [_sandstone('rsa0', M, (1.5, 1.2, 0.95), 3), _sandstone('rsa1', M, (0.7, 0.6, 0.45), 4, True, (0.95, -0.35, 0), 0.5)], 0.035)


@dpart('rock.sand.b', 'nature')
def _d():
    M = _dm()
    return nfinish('rock.sand.b', [_sandstone('rsb0', M, (1.1, 0.95, 1.35), 5), _sandstone('rsb1', M, (1.0, 0.8, 0.6), 6, True, (0.55, 0.55, 0), 0.9), _sandstone('rsb2', M, (0.5, 0.45, 0.35), 7, False, (-0.75, -0.3, 0), 0.3)], 0.035)


@dpart('rock.sand.c', 'nature')
def _d():
    M = _dm(); return nfinish('rock.sand.c', [_sandstone('rsc0', M, (0.8, 0.65, 0.5), 8), _sandstone('rsc1', M, (0.45, 0.4, 0.3), 9, True, (0.55, 0.2, 0), 1.1)], 0.03)


@dpart('stone.step', 'nature')
def _d():
    """A sandstone flag for the doorstep walks and the path's edge."""
    M = _dm()
    s = lathe('stone.step', [(0.0, 0.08), (0.3, 0.075), (0.42, 0.04), (0.42, -0.02)], axis='Z', segs=8, mat=M['Sandstone'])
    xform(s, scale=(1.2, 0.8, 1.0)); smooth(s, 40, weighted=False)
    return nfinish('stone.step', [s], 0.02, grad=(0.82, 0.78, 0.84))


@dpart('signpost', 'nature')
def _d():
    """A desert fingerpost: a timber post, two painted boards, a cloth tied round the top."""
    M = _dm()
    post = rbox('dp_post', (0.1, 0.1, 1.8), (0, 0, 0.9), M['WoodDark'], bev=0.02)
    cap = blob('dp_cap', (0, 0, 1.83), 0.075, M['WoodDark'], subd=1, jitter=0.0)
    arrow = [(-0.34, -0.09), (0.26, -0.09), (0.4, 0.0), (0.26, 0.09), (-0.34, 0.09)]
    b1 = chunky(prism('dp_b1', arrow, -0.025, 0.025, axis='Y', mat=M['Wood']), 0.015); xform(b1, rot=[('Z', 0.35)], loc=(0.08, 0.0, 1.42))
    b2 = chunky(prism('dp_b2', [(-p[0], p[1]) for p in arrow], -0.025, 0.025, axis='Y', mat=M['Wood']), 0.015); xform(b2, rot=[('Z', -0.4)], loc=(-0.08, 0.0, 1.16))
    wrap = cyl('dp_w', 0.075, 1.58, 1.7, axis='Z', segs=8, mat=M['Mint'])
    tail = chunky(prism('dp_tl', [(0.0, 1.66), (0.05, 1.66), (0.12, 1.36), (0.06, 1.34)], -0.02, 0.02, axis='Y', mat=M['Mint']), 0.005)
    return nfinish('signpost', [post, cap, b1, b2, wrap, tail], 0.03, grad=(0.8, 0.76, 0.86))

# ---------------------------------------------------------------- landmark parts (ARC_ + LMK_ slots)


def _scallops(name, w, n, y, z, mat, depth=0.24, axis='Y'):
    out = []
    for k in range(n):
        cx = -w / 2 + w * (k + 0.5) / n
        pts = [(cx - w / n / 2, z), (cx + w / n / 2, z)] + [(cx + math.cos(math.pi * j / 6) * w / n / 2, z - 0.02 - math.sin(math.pi * j / 6) * depth) for j in range(1, 6)]
        out.append(prism(f'{name}{k}', pts, y - 0.02, y + 0.02, axis=axis, mat=mat))
    return out


def _well_oasis(pid, lite):
    """The oasis well: a round sandstone well with a water surface, four timber posts and a teal cloth canopy with a
    scalloped valance and a gold finial, a beam and bucket, jars at its foot. Front toward -Y."""
    M = _lm(); M.update(_dm()); segs = 10 if lite else 16; P = []
    ring = lathe('wo_ring', [(0.82, 0.0), (1.12, 0.0), (1.14, 0.78), (1.02, 0.9), (0.82, 0.9), (0.82, 0.1)], axis='Z', segs=segs, mat=M['Sandstone'])
    if not lite: chunky(ring, 0.05)
    P.append(ring)
    P.append(cyl('wo_water', 0.84, 0.55, 0.62, axis='Z', segs=segs, mat=bpy.data.materials.get('ARC_Water') or toon('ARC_Water', '#5fb4cf', shade='#8ea9d8', rim=0.2)))
    for sx in (-1, 1):
        for sy in (-1, 1): P.append(rbox('wo_post', (0.16, 0.16, 2.55), (sx * 1.25, sy * 1.25, 1.27), M['WoodDark'], 0.02 if not lite else 0.0))
    for sy in (-1, 1): P.append(box('wo_beam', (2.8, 0.18, 0.18), (0, sy * 1.25, 2.5), M['Wood']))
    for sx in (-1, 1): P.append(box('wo_beamx', (0.18, 2.8, 0.18), (sx * 1.25, 0, 2.5), M['Wood']))
    # the canopy: a low four-sided cloth pyramid, its rim a little proud of the beams
    tent = lathe('wo_tent', [(0.0, 3.4), (1.2, 2.95), (2.0, 2.62), (2.0, 2.56), (0.0, 2.9)], axis='Z', segs=4, mat=M['Awning'])
    xform(tent, rot=[('Z', math.pi / 4)]); P.append(tent)
    if not lite:
        for q in range(4):
            v = _scallops(f'wo_v{q}_', 2.84, 5, -1.43, 2.6, M['Awning'], 0.2)
            for o in v: xform(o, rot=[('Z', q * math.pi / 2)])
            P += v
        P.append(cyl('wo_axle', 0.07, -1.2, 1.2, axis='X', segs=8, mat=M['Wood'], center=(0, 0, 1.75)))
        P.append(cyl('wo_rope', 0.02, 0.95, 1.75, axis='Z', segs=5, mat=M['Sand']))
        P.append(lathe('wo_bucket', [(0.12, 0.72), (0.17, 0.98), (0.14, 0.98), (0.14, 0.76), (0.0, 0.76)], axis='Z', segs=8, mat=M['WoodDark']))
        for i, (x, y, s) in enumerate(((1.45, -0.9, 0.9), (1.65, -0.5, 0.6), (-1.55, -0.85, 0.75))):
            P.append(smooth(lathe(f'wo_jar{i}', [(0.0, 0.0), (0.16 * s, 0.0), (0.26 * s, 0.14 * s), (0.3 * s, 0.34 * s), (0.25 * s, 0.56 * s), (0.13 * s, 0.68 * s), (0.12 * s, 0.78 * s), (0.17 * s, 0.84 * s), (0.0, 0.8 * s)], axis='Z', segs=10, mat=M['Roof'], center=(x, y, 0)), 40, weighted=False))
    P.append(blob('wo_fin', (0, 0, 3.5), 0.12, M['ButterYellow'], subd=1 if lite else 2, jitter=0.0))
    _tone(P)
    return lfinish(pid, P, 0.03)


@dpart('well.oasis', 'landmark')
def _d(): return _well_oasis('well.oasis', False)
@dpart('well.oasis.lite', 'landmark')
def _d(): return _well_oasis('well.oasis.lite', True)


def _stall_desert(pid, variant, lite):
    """A market stall: a timber counter heaped with goods under a broad striped awning (LMK_Awning and cream) on four
    posts, the front toward -Y."""
    M = _lm(); M.update(_dm()); P = []
    P.append(rbox('sd_counter', (2.4, 0.9, 0.92), (0, 0.15, 0.46), M['Wood'], 0.04 if not lite else 0.0))
    P.append(box('sd_top', (2.55, 1.05, 0.08), (0, 0.15, 0.95), M['WoodDark']))
    P.append(box('sd_cloth', (2.5, 0.06, 0.5), (0, -0.33, 0.7), M['Awning']))
    for sx in (-1, 1):
        for sy in (-1, 1): P.append(box('sd_post', (0.11, 0.11, 2.45), (sx * 1.3, sy * 0.72 + 0.1, 1.22), M['WoodDark']))
    n = 5 if lite else 7
    for k in range(n):
        x0 = -1.55 + 3.1 * k / n; x1 = x0 + 3.1 / n
        P.append(prism(f'sd_aw{k}', [(1.0, 2.62), (-1.05, 2.28), (-1.05, 2.22), (1.0, 2.56)], x0, x1, axis='X', mat=M['Awning'] if k % 2 == 0 else M['Petal']))
    if not lite:
        P += _scallops('sd_v', 3.1, 7, -1.07, 2.25, M['Awning'], 0.18)
        if variant == 0:
            for i, (x, y, s, mat) in enumerate(((-0.75, 0.1, 0.8, 'Roof'), (-0.35, 0.25, 0.6, 'Roof'), (0.1, 0.1, 0.7, 'SkyBlue'), (0.5, 0.25, 0.55, 'Roof'))):
                P.append(smooth(lathe(f'sd_j{i}', [(0.0, 0.99), (0.14 * s, 0.99), (0.24 * s, 0.99 + 0.14 * s), (0.27 * s, 0.99 + 0.32 * s), (0.2 * s, 0.99 + 0.52 * s), (0.1 * s, 0.99 + 0.62 * s), (0.13 * s, 0.99 + 0.7 * s), (0.0, 0.99 + 0.68 * s)], axis='Z', segs=10, mat=M[mat]), 40, weighted=False))
                P[-1].location = (x, y, 0)
            P.append(box('sd_rug', (0.9, 0.5, 0.12), (0.8, 0.2, 1.05), M['CoralPink']))
            P.append(box('sd_rug2', (0.9, 0.5, 0.1), (0.8, 0.2, 1.16), M['Mint']))
        else:
            for x in (-0.7, 0.05, 0.75):
                P.append(lathe('sd_b', [(0.22, 0.99), (0.3, 1.26), (0.25, 1.26), (0.18, 1.02), (0, 1.02)], axis='Z', segs=10, mat=M['Wood'], center=(x, 0.15, 0)))
            for i, (x, mat) in enumerate(((-0.7, 'ButterYellow'), (0.05, 'CoralPink'), (0.75, 'Mint'))):
                P.append(blob(f'sd_g{i}', (x, 0.15, 1.28), 0.2, M[mat], subd=2, scale=(1, 1, 0.5), jitter=0.05, seed=i))
    _tone(P)
    return lfinish(pid, P, 0.03)


@dpart('stall.desert.a', 'landmark')
def _d(): return _stall_desert('stall.desert.a', 0, False)
@dpart('stall.desert.a.lite', 'landmark')
def _d(): return _stall_desert('stall.desert.a.lite', 0, True)
@dpart('stall.desert.b', 'landmark')
def _d(): return _stall_desert('stall.desert.b', 1, False)
@dpart('stall.desert.b.lite', 'landmark')
def _d(): return _stall_desert('stall.desert.b.lite', 1, True)


def _lookout_desert(pid, lite):
    """The rim lookout: a sandstone tower stepped in at mid height, crenellations, a banner, a timber shelter and
    a flag on top, a door at its foot. About 8.5 m to the flag's tip; front toward -Y."""
    M = _lm(); M.update(_dm()); P = []
    bev = 0.0 if lite else 0.08
    P.append(rbox('lo_base', (2.9, 2.9, 3.2), (0, 0, 1.6), M['Sandstone'], bev))
    P.append(rbox('lo_shaft', (2.5, 2.5, 3.3), (0, 0, 4.8), M['Sandstone'], bev))
    P.append(rbox('lo_band', (2.7, 2.7, 0.2), (0, 0, 3.22), M['SandstoneDark'], 0.03 if not lite else 0.0))
    for k in range(4):
        for q in (-1, 0, 1):
            m = rbox('lo_mer', (0.5, 0.34, 0.5), (q * 0.95, -1.12, 6.7), M['Sandstone'], 0.06 if not lite else 0.0)
            xform(m, rot=[('Z', k * math.pi / 2)]); P.append(m)
    P.append(box('lo_deck', (2.3, 2.3, 0.12), (0, 0, 6.46), M['SandstoneDark']))
    for sx in (-1, 1):
        for sy in (-1, 1): P.append(box('lo_post', (0.14, 0.14, 1.7), (sx * 0.9, sy * 0.9, 7.3), M['Wood']))
    roof = lathe('lo_roof', [(0.0, 8.55), (1.5, 8.05), (1.5, 7.95), (0.0, 8.4)], axis='Z', segs=4, mat=M['Roof'])
    xform(roof, rot=[('Z', math.pi / 4)]); P.append(roof)
    P.append(cyl('lo_pole', 0.04, 8.4, 9.5, axis='Z', segs=6, mat=M['Wood']))
    P.append(chunky(prism('lo_flag', [(0.04, 9.45), (0.9, 9.25), (0.75, 9.1), (0.9, 8.95), (0.04, 8.9)], -0.02, 0.02, axis='Y', mat=M['Awning']), 0.005))
    door = chunky(prism('lo_door', arch_pts(1.0, 1.9), -1.5, -1.42, axis='Y', mat=M['WoodDark']), 0.02); P.append(door)
    P.append(chunky(prism('lo_ban', [(-0.4, 5.9), (0.4, 5.9), (0.4, 4.4), (0.0, 4.15), (-0.4, 4.4)], -1.3, -1.26, axis='Y', mat=M['Awning']), 0.01))
    P.append(chunky(prism('lo_dia', [(0, 4.7), (0.2, 5.0), (0, 5.3), (-0.2, 5.0)], -1.32, -1.3, axis='Y', mat=M['Petal']), 0.005))
    if not lite:
        for x, z in ((-0.6, 5.3), (0.6, 5.3), (0.0, 2.3)):
            P.append(prism('lo_slit', arch_pts(0.22, 0.7, x, z - 0.35), -1.27, -1.23, axis='Y', mat=M['WoodDark']))
    _tone(P)
    return lfinish(pid, P, 0.035)


@dpart('lookout.desert', 'landmark')
def _d(): return _lookout_desert('lookout.desert', False)
@dpart('lookout.desert.lite', 'landmark')
def _d(): return _lookout_desert('lookout.desert.lite', True)

# ---------------------------------------------------------------- gameplay props: rocks, low wall, barricade (own GLBs)
#
# The desert biome patches three of the theme's props by id (packs/arcade/pack.json biomes.desert.props): the cover
# rocks, the fence (a low plaster wall here) and the hay barricade (crates, sacks and jars). Each is its own GLB, like
# the meadow's, at the same longest size, so the pack's `metres` and every placement stay as they are.

DESERT_PROPS = {'rocks': 'arcade-desert-rocks.glb', 'wall': 'arcade-desert-wall.glb', 'barricade': 'arcade-desert-barricade.glb'}
PROP_EXTRA = {'ARC_Adobe': '#efcf9e', 'ARC_Clay': '#d8683f'}


def _pm():
    M = _dm()
    for name, hex_ in PROP_EXTRA.items(): M[name[4:]] = bpy.data.materials.get(name) or toon(name, hex_)
    return M


def desert_rocks():
    """Cover rocks: three wind-rounded sandstone boulders, 2.5 m long, about 1.4 m high."""
    M = _pm()
    P = [_sandstone('drk0', M, (1.35, 1.05, 1.4), 11, False, (-0.45, 0.0, 0.0), 0.2),
         _sandstone('drk1', M, (1.0, 0.85, 0.8), 12, True, (0.55, -0.12, 0.0), -0.4),
         _sandstone('drk2', M, (0.55, 0.5, 0.42), 13, False, (0.98, 0.28, 0.0), 0.7)]
    ob = merge('DST_Rocks', P); ob['arc_outline'] = 0.035
    return ob


def desert_wall():
    """A low plaster wall panel, 2.46 long: a rounded body on a sandstone footing under a sandstone cap."""
    M = _pm()
    body = rbox('dw_body', (2.4, 0.36, 0.95), (0, 0, 0.62), M['Adobe'], 0.09, segs=2)
    foot = rbox('dw_foot', (2.46, 0.42, 0.18), (0, 0, 0.09), M['SandstoneDark'], 0.04)
    cap = rbox('dw_cap', (2.46, 0.46, 0.13), (0, 0, 1.15), M['Sandstone'], 0.05)
    vgrad([body], (0.8, 0.76, 0.84), lo=0.1, hi=1.1); ensure_grad([foot, cap])
    ob = merge('DST_Wall', [body, foot, cap]); ob['arc_outline'] = 0.03
    return ob


def desert_barricade():
    """The desert's barricade: crates, grain sacks, clay jars and a rolled rug, 3.3 m long."""
    M = _pm(); P = []
    P += _crate('dbc0', (0.8, 0.75, 0.72), (-1.1, 0.0, 0.0), 0.1)
    P += _crate('dbc1', (0.62, 0.6, 0.5), (-1.05, 0.05, 0.72), -0.25)
    P += _crate('dbc2', (0.72, 0.7, 0.62), (0.2, 0.08, 0.0), -0.12)
    for o in P:
        for i, m in enumerate(o.data.materials):
            if m and m.name.startswith('HSE_'): o.data.materials[i] = M['Wood' if m.name == 'HSE_Timber' else 'WoodDark']
    for i, (x, y, s) in enumerate(((-0.45, -0.2, 1.0), (-0.5, 0.25, 0.9), (0.95, -0.1, 1.05))):
        P.append(blob(f'dbs{i}', (x, y, 0.3 * s), 0.36 * s, M['Sand'], subd=2, scale=(1.15, 0.85, 0.8), jitter=0.06, seed=i))
    for i, (x, y, s) in enumerate(((1.35, 0.25, 1.0), (1.5, -0.25, 0.75))):
        P.append(smooth(lathe(f'dbj{i}', [(0.0, 0.0), (0.18 * s, 0.0), (0.3 * s, 0.18 * s), (0.34 * s, 0.4 * s), (0.28 * s, 0.64 * s), (0.15 * s, 0.78 * s), (0.14 * s, 0.9 * s), (0.2 * s, 0.96 * s), (0.0, 0.92 * s)], axis='Z', segs=12, mat=M['Clay'], center=(x, y, 0)), 40, weighted=False))
    rug = cyl('dbr', 0.17, -0.55, 0.55, axis='X', segs=10, mat=M['CoralPink'], center=(0.25, 0.1, 0.8)); rug.data.shade_smooth(); P.append(rug)
    for q in (-1, 1): P.append(cyl(f'dbb{q}', 0.18, q * 0.3 - 0.05, q * 0.3 + 0.05, axis='X', segs=10, mat=M['Mint'], center=(0.25, 0.1, 0.8)))
    ensure_grad(P); vgrad([o for o in P if o.data.materials[0].name in ('ARC_Sand', 'ARC_Clay')], (0.8, 0.76, 0.84), local=True)
    ob = merge('DST_Barricade', P); ob['arc_outline'] = 0.03
    return ob


def build_desert_props():
    """The three props into DST_Props (in the desert scene), standing on the origin, fronts toward -Y."""
    sc = bpy.data.scenes['DST_Desert']
    C = bpy.data.collections.get('DST_Props') or bpy.data.collections.new('DST_Props')
    if C.name not in sc.collection.children: sc.collection.children.link(C)
    for o in list(C.objects): _remove(o)
    out = {}
    for name, fn in (('rocks', desert_rocks), ('wall', desert_wall), ('barricade', desert_barricade)):
        ob = fn()
        for u in list(ob.users_collection): u.objects.unlink(ob)
        C.objects.link(ob)
        lo, hi = bounds([ob]); out[name] = {'size': [round(hi.x - lo.x, 4), round(hi.z - lo.z, 4), round(hi.y - lo.y, 4)], 'tris': tris([ob])}
    return out


def ship_desert_props(out=OUT + '/arcade'):
    C = bpy.data.collections['DST_Props']; res = {}
    for key, node, obname in (('rocks', 'Rocks', 'DST_Rocks'), ('wall', 'Wall', 'DST_Wall'), ('barricade', 'Barricade', 'DST_Barricade')):
        ob = C.objects[obname]
        res[key] = export_nodes([(node, [ob], None, (0, 0, 0), True)], f'{out}/{DESERT_PROPS[key]}')
    return res

# ---------------------------------------------------------------- build, show, ship


def _remove(ob):
    me = ob.data if ob.type == 'MESH' else None
    bpy.data.objects.remove(ob, do_unlink=True)
    if me and me.users == 0: bpy.data.meshes.remove(me)


def build_desert_parts(only=None):
    """Every part (or the ids in `only`) into DST_Parts; an earlier build of the same ids goes first."""
    materials()
    for s in HSLOTS: hm(s)
    for s in ('Leaf', 'Bark', 'Blossom', 'Gold'): tm(s)
    _lm(); _dm()
    C = bpy.data.collections.get(PARTS_COLL_D) or bpy.data.collections.new(PARTS_COLL_D)
    sc = bpy.data.scenes.get('DST_Desert') or bpy.context.scene
    if C.name not in sc.collection.children: sc.collection.children.link(C)
    ids = [p for p in DPART_ORDER if only is None or p in only]
    for pid in ids:
        old = bpy.data.objects.get(pid)
        if old:
            for ch in list(old.children): _remove(ch)
            _remove(old)
    info = {}
    for pid in ids:
        ob = DPARTS[pid]()
        for o in [ob] + list(ob.children):
            for u in list(o.users_collection): u.objects.unlink(o)
            C.objects.link(o)
        ob['dst_kind'] = DKIND[pid]
        info[pid] = tris([ob] + [c for c in ob.children if c.type == 'MESH'])
    C.hide_render = True; C.hide_viewport = True
    return {'parts': len(info), 'tris': sum(info.values()), 'each': info}


def preview_material(slot):
    """A coloured copy of an HSE_/TRE_/LMK_ slot for the previews (the shipped parts stay white x gradient)."""
    name = 'DSTP_' + slot
    m = bpy.data.materials.get(name)
    if m: return m
    hex_ = DESERT_PREVIEW.get(slot, '#ffffff')
    return glow(name, hex_) if slot == 'Glow' else toon(name, hex_, **HSLOT_TOON.get(slot, {}))


def _recolour(ob):
    for i, m in enumerate(ob.data.materials):
        if m and m.name.startswith(('HSE_', 'TRE_', 'LMK_')):
            ob.data.materials[i] = preview_material(m.name[4:].split('.')[0])


def show_desert_parts(kinds=('house',), only=None, per_row=8, gap=3.2, origin=(0.0, 0.0), outlines=True):
    """Coloured copies of the built parts in rows in DST_Show (the desert scene), with their outline shells."""
    src = bpy.data.collections[PARTS_COLL_D]; sc = bpy.data.scenes['DST_Desert']
    C = bpy.data.collections.get(SHOW_COLL_D) or bpy.data.collections.new(SHOW_COLL_D)
    if C.name not in sc.collection.children: sc.collection.children.link(C)
    for o in [o for o in C.objects if o.parent is not None] + [o for o in C.objects if o.parent is None]: _remove(o)
    ids = [p for p in DPART_ORDER if DKIND[p] in kinds and (only is None or p in only) and src.objects.get(p)]
    for i, pid in enumerate(ids):
        o = src.objects[pid]; c = o.copy(); c.data = o.data.copy(); C.objects.link(c)
        c.location = (origin[0] + (i % per_row) * gap, origin[1] + (i // per_row) * gap * 1.4, 0.0)
        _recolour(c)
        if outlines and c.get('arc_outline', 0) > 0: outline(c, c['arc_outline'])
    return {'shown': ids}


def desert_parts_index():
    C = bpy.data.collections[PARTS_COLL_D]; idx = {'house': {}, 'tree': {}, 'nature': {}, 'landmark': {}}
    for pid in DPART_ORDER:
        ob = C.objects.get(pid)
        if not ob: continue
        kind = DKIND[pid]; objs = [ob] + [c for c in ob.children if c.type == 'MESH']
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


def ship_desert_parts(path=PARTS_GLB_D, index=PARTS_INDEX_D):
    """One GLB with every desert part (sockets as child empties) + the JS index, one map per kind."""
    C = bpy.data.collections[PARTS_COLL_D]
    objs = [o for o in C.objects if o.parent is None] + [o for o in C.objects if o.parent is not None]
    gltf_mode(True)
    try:
        C.hide_viewport = False
        bpy.context.view_layer.update()
        size = export_glb(objs, path)
    finally:
        gltf_mode(False); C.hide_viewport = True
    idx = desert_parts_index()
    with open(index, 'w') as f:
        f.write('// Generated by tools/blender/v2/arcade/desert_parts.py (ship_desert_parts): the desert parts library index,\n'
                '// one map per kind (house parts with their sockets; tree, nature and landmark parts with their extents and\n'
                '// triangles). The desert biome\'s rules are validated against it.\n'
                "export const DESERT_LIBRARY = 'assets/v2/arcade/arcade-desert-parts.glb';\n")
        for kind, name in (('house', 'DESERT_HOUSE_PARTS'), ('tree', 'DESERT_TREE_PARTS'), ('nature', 'DESERT_NATURE_PARTS'), ('landmark', 'DESERT_LANDMARK_PARTS')):
            f.write(f'export const {name} = ' + json.dumps(idx[kind], indent=1, sort_keys=True) + ';\n')
    return {'kb': round(size / 1024, 1), 'parts': sum(len(v) for v in idx.values()), 'tris': tris([o for o in objs if o.type == 'MESH'])}
