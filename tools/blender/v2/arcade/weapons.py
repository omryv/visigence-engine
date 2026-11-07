"""Arcade weapons: slingshot (pistol), repeating crossbow (smgGun), blunderbuss (shotgun), heavy crossbow
(sniper) and mini cannon (rpg). Static first-person models, no arms and no clips: the engine hangs them
through makePackWeapon (src/viewmodel/PackViewmodel.js) with its procedural recoil, sway and aim.

exec after vg.py, kit.py, nature.py, hero_corner.py and props.py (same globals):
    g['build_weapons']()   g['review_weapons']()   g['ship_weapons']()
Conventions (as the v2 weapons): metres, Z up, bore along +Y ending at the Muzzle marker; the Sight marker
sits on the aim line and carries its eye distance in 'eye'. Every weapon is longer along Y than it is wide
along X, because the engine turns a static weapon's longest horizontal axis down the view. Strings and bands
ship as a separate 'String' node with arc_outline 0: an outline shell would swallow them.
"""
import bpy, bmesh, math
from mathutils import Vector, Matrix

WEAPON_OUTLINE = 0.006
WEAPONS_REVIEW = OUT + '/arcade/arcade-weapons-review.png'
MARKERS = {}      # weapon id -> {'Muzzle': (loc, {}), 'Sight': (loc, {'eye': d})}, filled by build_weapons()

# ---------------------------------------------------------------- helpers

def bez(p0, p1, p2, n=8):
    """Quadratic Bezier samples (n + 1 points) from p0 through control p1 to p2."""
    p0, p1, p2 = Vector(p0), Vector(p1), Vector(p2)
    return [p0 * (1 - t) ** 2 + p1 * 2 * (1 - t) * t + p2 * t * t for t in (i / n for i in range(n + 1))]

def tube(name, pts, radii, mat, segs=10, cap=True):
    """Round tube swept along a polyline (limbs, rods, strings, fuses). radii: one value or one per point."""
    pts = [Vector(p) for p in pts]; n = len(pts)
    radii = list(radii) if isinstance(radii, (list, tuple)) else [radii] * n
    bm = bmesh.new(); rings = []; up = None
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized()
        if up is None: up = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
        nrm = (up - t * up.dot(t)).normalized(); up = nrm; b = t.cross(nrm)
        rings.append([bm.verts.new(p + (nrm * math.cos(2 * math.pi * k / segs) + b * math.sin(2 * math.pi * k / segs)) * radii[i])
                      for k in range(segs)])
    for j in range(n - 1):
        A, B = rings[j], rings[j + 1]
        for k in range(segs): bm.faces.new((A[k], A[(k + 1) % segs], B[(k + 1) % segs], B[k]))
    if cap: bm.faces.new(list(reversed(rings[0]))); bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return smooth(new_obj(name, bm, mat), 60, weighted=False)

def taper(r0, r1, n):
    return [r0 + (r1 - r0) * i / (n - 1) for i in range(n)]

def ball(name, loc, r, mat, scale=(1, 1, 1), subd=3):
    return blob(name, loc, r, mat, subd=subd, scale=scale, jitter=0.0)

def fins(name, y0, y1, z, r, mat, count=3, h=0.018, t=0.003, start=90):
    """Bolt fletching: `count` thin vanes around a shaft along Y at height z."""
    out = []
    for k in range(count):
        f = rbox(f'{name}{k}', (t, y1 - y0, h), (0, 0, 0), mat, 0.001)
        xform(f, loc=(0, (y0 + y1) / 2, r + h / 2))
        xform(f, rot=[('Y', math.radians(start + 360 * k / count - 90))])
        xform(f, loc=(0, 0, z))
        out.append(f)
    return out

# ---------------------------------------------------------------- slingshot (pistol)

def slingshot(M):
    P, S = [], []
    P.append(loft('grip', [(-0.14, 0.017, -0.017, 0.016, 2.2), (-0.125, 0.023, -0.023, 0.022, 2.2),
                           (-0.06, 0.021, -0.021, 0.02, 2.2), (0.0, 0.026, -0.026, 0.025, 2.2)], segs=16, mat=M['Wood'], axis='Z'))
    P.append(loft('wrap', [(-0.103, 0.0245, -0.0245, 0.0238, 2.2), (-0.037, 0.0235, -0.0235, 0.0228, 2.2)], segs=16, mat=M['CoralPink'], axis='Z'))
    P += [torus(f'wrapband{i}', 0.0238, 0.0045, (0, 0, z), M['WoodDark'], axis='Z', segs=16, rsegs=6) for i, z in enumerate((-0.103, -0.037))]
    P.append(ball('pommel', (0, 0, -0.145), 0.026, M['WoodDark'], (1, 1, 0.75)))
    P.append(ball('crotch', (0, 0, 0.004), 0.027, M['Wood']))
    for s in (-1, 1):
        arm = bez((0, 0, -0.005), (s * 0.062, 0, 0.03), (s * 0.068, 0, 0.12), 8)
        P.append(tube(f'arm{s}', arm, taper(0.022, 0.016, len(arm)), M['Wood'], segs=12))
        P.append(ball(f'tip{s}', (s * 0.068, 0, 0.124), 0.019, M['ButterYellow'], (1, 1, 0.8)))
        P.append(torus(f'tie{s}', 0.0175, 0.004, (s * 0.067, 0, 0.1), M['Hay'], axis='Z', segs=12, rsegs=6))
        S.append(tube(f'band{s}', [(s * 0.066, -0.004, 0.108), (s * 0.02, -0.15, 0.107)], 0.0055, M['Mint'], segs=8))
    P.append(ball('pouch', (0, -0.158, 0.107), 0.022, M['WoodDark'], (1.25, 0.55, 0.85)))
    P.append(blob('pebble', (0, -0.146, 0.108), 0.015, M['Stone'], subd=2, jitter=0.15, seed=4))
    return P, S, {'Muzzle': ((0, 0.02, 0.107), {}), 'Sight': ((0, 0.0, 0.12), {'eye': 0.34})}

# ---------------------------------------------------------------- repeating crossbow (smgGun)

def repeater(M):
    P, S = [], []
    P.append(loft('stock', [(-0.37, 0.02, -0.1, 0.026, 3.0), (-0.34, 0.03, -0.1, 0.03, 3.0), (-0.24, 0.032, -0.075, 0.03, 3.0),
                            (-0.15, 0.03, -0.028, 0.024, 3.0), (-0.05, 0.03, -0.025, 0.025, 3.0), (0.28, 0.03, -0.012, 0.026, 3.0),
                            (0.33, 0.026, -0.004, 0.022, 3.0)], segs=16, mat=M['Wood']))
    P.append(loft('grip', [(-0.02, -0.075, -0.135, 0.019), (-0.08, -0.09, -0.15, 0.02), (-0.13, -0.1, -0.16, 0.019)],
                  segs=14, mat=M['WoodDark'], axis='Z'))
    P.append(rbox('buttplate', (0.064, 0.012, 0.13), (0, -0.372, -0.036), M['ButterYellow'], 0.004))
    P.append(tube('trigger', bez((0, -0.055, -0.02), (0, -0.06, -0.045), (0, -0.075, -0.058), 4), 0.0055, M['Iron'], segs=8))
    P.append(rbox('prodblock', (0.09, 0.05, 0.05), (0, 0.28, 0.015), M['WoodDark'], 0.008))
    for s in (-1, 1):
        limb = bez((s * 0.04, 0.285, 0.015), (s * 0.2, 0.3, 0.015), (s * 0.26, 0.2, 0.015), 10)
        P.append(tube(f'limb{s}', limb, taper(0.016, 0.01, len(limb)), M['Wood'], segs=10))
        P.append(ball(f'limbtip{s}', (s * 0.26, 0.2, 0.015), 0.0135, M['ButterYellow']))
        P.append(torus(f'limbwrap{s}', 0.0165, 0.004, (s * 0.075, 0.29, 0.015), M['Hay'], axis='X', segs=12, rsegs=6))
        S.append(tube(f'string{s}', [(s * 0.258, 0.2, 0.015), (s * 0.01, 0.022, 0.036)], 0.0035, M['Hay'], segs=6))
    P.append(rbox('hopper', (0.058, 0.26, 0.085), (0, 0.15, 0.078), M['CoralPink'], 0.008))
    P += [rbox(f'hopband{i}', (0.066, 0.02, 0.093), (0, y, 0.078), M['ButterYellow'], 0.004) for i, y in enumerate((0.05, 0.25))]
    P.append(lathe('bolttip', [(0.0085, 0.28), (0.0, 0.318)], axis='Y', segs=8, mat=M['Iron'], center=(0, 0, 0.058)))
    for i, x in enumerate((-0.013, 0.0, 0.013)):   # fletchings of the loaded bolts poking out of the hopper
        P.append(rbox(f'flight{i}', (0.004, 0.045, 0.02), (x, 0.045 + 0.01 * i, 0.128), (M['Mint'], M['SkyBlue'], M['Lilac'])[i], 0.0015))
    for s in (-1, 1):                               # cocking lever: a U arm from the fore pivot back over the hopper
        P.append(tube(f'lever{s}', bez((s * 0.036, 0.27, 0.01), (s * 0.036, 0.2, 0.16), (s * 0.036, 0.0, 0.165), 8), 0.0075, M['WoodDark'], segs=8))
        P.append(ball(f'pivot{s}', (s * 0.037, 0.27, 0.01), 0.011, M['ButterYellow']))
    P.append(tube('leverbar', [(-0.042, 0.0, 0.165), (0.042, 0.0, 0.165)], 0.009, M['Hay'], segs=10))
    P.append(ball('frontbead', (0, 0.26, 0.124), 0.0065, M['ButterYellow']))
    return P, S, {'Muzzle': ((0, 0.32, 0.058), {}), 'Sight': ((0, 0.03, 0.128), {'eye': 0.22})}

# ---------------------------------------------------------------- blunderbuss (shotgun)

def blunderbuss(M):
    P, bz = [], 0.035
    P.append(lathe('barrel', [(0.026, -0.14), (0.027, 0.1), (0.03, 0.3), (0.0, 0.3)], axis='Y', segs=16, mat=M['Iron'], center=(0, 0, bz)))
    bell = lathe('bell', [(0.03, 0.28), (0.034, 0.36), (0.046, 0.43), (0.068, 0.49), (0.076, 0.505), (0.07, 0.515), (0.058, 0.512),
                          (0.044, 0.47), (0.026, 0.4), (0.0, 0.4)], axis='Y', segs=20, mat=M['ButterYellow'], center=(0, 0, bz))
    P.append(smooth(bell, 55, weighted=False))
    P += [torus(f'band{i}', 0.0295, 0.0055, (0, y, bz), M['ButterYellow'], axis='Y', segs=16, rsegs=6) for i, y in enumerate((-0.05, 0.12, 0.27))]
    P.append(ball('breech', (0, -0.14, bz), 0.027, M['Iron'], (1, 0.6, 1)))
    P.append(loft('stock', [(-0.52, 0.03, -0.14, 0.03, 2.8), (-0.46, 0.035, -0.13, 0.033, 2.8), (-0.3, 0.03, -0.05, 0.026, 2.8),
                            (-0.2, 0.035, -0.035, 0.024, 2.8), (-0.1, 0.035, -0.02, 0.027, 2.8), (0.22, 0.03, 0.0, 0.025, 2.8),
                            (0.26, 0.026, 0.006, 0.021, 2.8)], segs=16, mat=M['Wood']))
    P.append(rbox('buttplate', (0.066, 0.014, 0.172), (0, -0.524, -0.055), M['ButterYellow'], 0.004))
    P.append(rbox('lockplate', (0.012, 0.11, 0.04), (0.029, -0.12, 0.022), M['Iron'], 0.004))
    P.append(tube('hammer', bez((0.036, -0.155, 0.02), (0.04, -0.17, 0.055), (0.036, -0.145, 0.075), 5), 0.0075, M['Iron'], segs=8))
    P.append(ball('jaw', (0.036, -0.142, 0.078), 0.0105, M['Iron']))
    P.append(rbox('frizzen', (0.012, 0.014, 0.036), (0.036, -0.095, 0.052), M['Iron'], 0.003))
    P.append(tube('guard', bez((0, -0.13, -0.025), (0, -0.175, -0.095), (0, -0.25, -0.045), 8), 0.006, M['ButterYellow'], segs=8))
    P.append(tube('trigger', bez((0, -0.17, -0.025), (0, -0.172, -0.045), (0, -0.182, -0.058), 4), 0.005, M['Iron'], segs=8))
    P.append(ball('rearbead', (0, -0.1, 0.064), 0.006, M['ButterYellow']))
    for s in (-1, 1):   # pastel side inlay on the butt
        P.append(rbox(f'inlay{s}', (0.004, 0.13, 0.05), (s * 0.031, -0.43, -0.04), M['SkyBlue'], 0.0015))
    return P, [], {'Muzzle': ((0, 0.51, bz), {}), 'Sight': ((0, -0.12, 0.068), {'eye': 0.2})}

# ---------------------------------------------------------------- heavy crossbow (sniper)

def arbalest(M):
    P, S = [], []
    P.append(loft('stock', [(-0.56, 0.03, -0.11, 0.03, 3.0), (-0.52, 0.036, -0.11, 0.034, 3.0), (-0.36, 0.04, -0.07, 0.032, 3.0),
                            (-0.24, 0.036, -0.03, 0.026, 3.0), (-0.12, 0.036, -0.028, 0.03, 3.0), (0.36, 0.034, -0.016, 0.03, 3.0),
                            (0.42, 0.03, -0.006, 0.026, 3.0)], segs=16, mat=M['Wood']))
    P.append(loft('grip', [(-0.02, -0.16, -0.23, 0.021), (-0.09, -0.18, -0.25, 0.022), (-0.14, -0.19, -0.26, 0.021)],
                  segs=14, mat=M['WoodDark'], axis='Z'))
    P.append(rbox('buttplate', (0.07, 0.012, 0.15), (0, -0.562, -0.04), M['ButterYellow'], 0.004))
    for s in (-1, 1):
        P.append(rbox(f'panel{s}', (0.004, 0.3, 0.032), (s * 0.0305, 0.12, 0.009), M['SkyBlue'], 0.0015))
    P.append(tube('trigger', bez((0, -0.12, -0.028), (0, -0.07, -0.05), (0, -0.03, -0.062), 5), 0.005, M['Iron'], segs=8))
    P.append(rbox('prodblock', (0.11, 0.07, 0.065), (0, 0.4, 0.012), M['WoodDark'], 0.008))
    P += [rbox(f'binding{i}', (0.116, 0.014, 0.071), (0, y, 0.012), M['Iron'], 0.003) for i, y in enumerate((0.38, 0.42))]
    for s in (-1, 1):
        limb = bez((s * 0.05, 0.41, 0.012), (s * 0.26, 0.43, 0.012), (s * 0.35, 0.3, 0.012), 10)
        P.append(tube(f'limb{s}', limb, taper(0.019, 0.012, len(limb)), M['Iron'], segs=10))
        P.append(ball(f'limbtip{s}', (s * 0.35, 0.3, 0.012), 0.016, M['ButterYellow']))
        S.append(tube(f'string{s}', [(s * 0.348, 0.3, 0.012), (s * 0.012, 0.022, 0.04)], 0.004, M['Hay'], segs=6))
    P.append(rbox('nut', (0.03, 0.03, 0.02), (0, 0.02, 0.042), M['ButterYellow'], 0.004))
    P.append(tube('shaft', [(0, 0.03, 0.047), (0, 0.44, 0.047)], 0.0055, M['Wood'], segs=8))
    P.append(lathe('head', [(0.0125, 0.435), (0.0, 0.5)], axis='Y', segs=8, mat=M['Iron'], center=(0, 0, 0.047)))
    P += fins('vane', 0.035, 0.09, 0.047, 0.004, M['Mint'])
    scope_z = 0.098
    P.append(cyl('scope', 0.02, -0.2, 0.1, axis='Y', segs=16, mat=M['ButterYellow'], center=(0, 0, scope_z)))
    P.append(lathe('objective', [(0.02, 0.098), (0.027, 0.13), (0.027, 0.142), (0.0, 0.142)], axis='Y', segs=16, mat=M['ButterYellow'], center=(0, 0, scope_z)))
    P.append(lathe('eyepiece', [(0.0, -0.242), (0.024, -0.242), (0.024, -0.225), (0.02, -0.198)], axis='Y', segs=16, mat=M['ButterYellow'], center=(0, 0, scope_z)))
    P += [cyl(f'lens{i}', 0.019, y, y + 0.002, axis='Y', segs=16, mat=M['Glass'], center=(0, 0, scope_z)) for i, y in enumerate((0.1415, -0.2435))]
    P += [rbox(f'mount{i}', (0.024, 0.03, 0.05), (0, y, 0.066), M['Iron'], 0.004) for i, y in enumerate((-0.12, 0.04))]
    # the draw crank on the right flank just ahead of the grip, where the shooting hand reaches it (the first-person
    # rig turns it three times per shot; fp_rigs.py's Crank bone pivots on the disc's axis)
    P.append(cyl('crankdisc', 0.032, 0.03, 0.044, axis='X', segs=16, mat=M['ButterYellow'], center=(0, -0.09, 0.0)))
    P.append(tube('crankarm', [(0.045, -0.09, 0.0), (0.045, -0.09, -0.055)], 0.006, M['Iron'], segs=8))
    P.append(tube('crankknob', [(0.045, -0.09, -0.055), (0.078, -0.09, -0.055)], 0.0095, M['WoodDark'], segs=10))
    return P, S, {'Muzzle': ((0, 0.5, 0.047), {}), 'Sight': ((0, -0.243, scope_z), {'eye': 0.06})}

# ---------------------------------------------------------------- mini cannon (rpg)

def cannon(M):
    P, bz = [], 0.085
    barrel = lathe('barrel', [(0.0, -0.34), (0.022, -0.34), (0.03, -0.325), (0.02, -0.305), (0.016, -0.295), (0.06, -0.29), (0.078, -0.265),
                              (0.08, -0.22), (0.074, -0.05), (0.066, 0.2), (0.074, 0.215), (0.082, 0.25), (0.082, 0.275), (0.07, 0.29),
                              (0.05, 0.29), (0.044, 0.24), (0.0, 0.24)], axis='Y', segs=20, mat=M['Iron'], center=(0, 0, bz))
    P.append(smooth(barrel, 40, weighted=False))
    P += [torus(f'ring{i}', R, 0.008, (0, y, bz), M['ButterYellow'], axis='Y', segs=20, rsegs=6)
          for i, (y, R) in enumerate(((-0.24, 0.08), (-0.05, 0.075), (0.2, 0.068)))]
    P.append(ball('cascabel', (0, -0.35, bz), 0.026, M['ButterYellow']))
    P.append(tube('fuse', bez((0, -0.245, 0.158), (0.012, -0.255, 0.19), (-0.008, -0.235, 0.212), 6), 0.005, M['Hay'], segs=8))
    P.append(ball('spark', (-0.008, -0.235, 0.22), 0.012, M['Glow'], subd=2))
    P.append(loft('bed', [(-0.26, 0.03, -0.02, 0.05, 3.2), (0.12, 0.03, -0.02, 0.05, 3.2)], segs=16, mat=M['Wood']))
    P.append(rbox('trim', (0.106, 0.36, 0.012), (0, -0.07, -0.022), M['Roof'], 0.003))
    P.append(loft('grip', [(-0.02, -0.15, -0.2, 0.022), (-0.1, -0.165, -0.215, 0.023), (-0.15, -0.17, -0.22, 0.022)],
                  segs=14, mat=M['WoodDark'], axis='Z'))
    P.append(loft('foregrip', [(-0.02, 0.085, 0.035, 0.02), (-0.12, 0.08, 0.035, 0.022)], segs=14, mat=M['WoodDark'], axis='Z'))
    P.append(ball('foreknob', (0, 0.058, -0.125), 0.026, M['ButterYellow'], (1, 1, 0.6)))
    P.append(tube('trigger', bez((0, -0.12, -0.02), (0, -0.123, -0.04), (0, -0.132, -0.052), 4), 0.005, M['Iron'], segs=8))
    P += [ball(f'bead{i}', (0, y, z), 0.0065, M['ButterYellow']) for i, (y, z) in enumerate(((-0.12, 0.162), (0.2, 0.155)))]
    return P, [], {'Muzzle': ((0, 0.29, bz), {}), 'Sight': ((0, -0.13, 0.168), {'eye': 0.18})}

# ---------------------------------------------------------------- build, review, ship

WEAPON_BUILDERS = [('slingshot', slingshot, 'Slingshot'), ('repeater', repeater, 'Repeater'), ('blunderbuss', blunderbuss, 'Blunderbuss'),
                   ('arbalest', arbalest, 'Arbalest'), ('cannon', cannon, 'Cannon')]
ROWS = (('repeater', 'arbalest'), ('slingshot', 'blunderbuss', 'cannon'))

def _vz(objs):
    zs = [v.co.z for o in objs for v in o.data.vertices]; ys = [v.co.y for o in objs for v in o.data.vertices]
    return min(zs), max(zs), min(ys), max(ys)

def build_weapons():
    M = prop_mats()
    sc, back, G = _review_scene()
    W = bpy.data.collections.get('ARC_Weapons') or bpy.data.collections.new('ARC_Weapons')
    if W.name not in sc.collection.children: sc.collection.children.link(W)
    _clear(W)
    info, made = {}, {}
    for wid, fn, label in WEAPON_BUILDERS:
        P, S, markers = fn(M)
        z0, z1, _, _ = _vz(P)
        vgrad([o for o in P if o.data.materials[0].name != 'ARC_Glow'], (0.8, 0.76, 0.86), lo=z0, hi=z1, local=True)
        ensure_grad(P + S)
        body = put(merge(f'ARC_W_{label}', P), W); body['arc_outline'] = WEAPON_OUTLINE
        objs = [body]
        if S:
            st = put(merge(f'ARC_W_{label}_String', S), W); st['arc_outline'] = 0.0; objs.append(st)
        outline(body, WEAPON_OUTLINE)
        MARKERS[wid] = markers; made[wid] = objs
        z0, z1, y0, y1 = _vz(objs)
        xs = [v.co.x for o in objs for v in o.data.vertices]
        info[wid] = {'tris': tris(objs), 'length_y': round(y1 - y0, 3), 'width_x': round(max(xs) - min(xs), 3), 'height_z': round(z1 - z0, 3)}
    # lineup: two rows floating over the meadow, bores pointing screen-right, right side toward the camera
    base = LINEUP + Vector((0, 0, 1.0)); gap = 0.16
    for r, row in enumerate(ROWS):
        spans = [_vz(made[w])[2:] for w in row]
        total = sum(y1 - y0 for y0, y1 in spans) + gap * (len(row) - 1); x = -total / 2
        for w, (y0, y1) in zip(row, spans):
            for o in made[w]:
                o.location = base + Vector((x - y0, 0, 0.5 - r * 0.42)); o.rotation_euler = (0, 0, -math.pi / 2)
            x += (y1 - y0) + gap
    cam = bpy.data.objects.get('ARC_WeaponCam') or bpy.data.objects.new('ARC_WeaponCam', bpy.data.cameras.new('ARC_WeaponCam'))
    if cam.name not in back.objects: back.objects.link(cam)
    t = base + Vector((0, 0, 0.3)); d = Vector((0.12, -1.0, 0.34)).normalized()
    cam.location = t + d * 3.5; cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = 50; cam.data.clip_start = 0.05; cam.data.clip_end = 1000
    return info

def review_weapons(path=WEAPONS_REVIEW, res=(1200, 700), samples=16):
    """One light EEVEE render of the weapon lineup (the gameplay props are hidden for it)."""
    sc = bpy.data.scenes['ARC_Review']; keep = sc.camera
    sc.camera = bpy.data.objects['ARC_WeaponCam']
    try: return render_review(path, res, samples, hide=('ARC_Gameplay',))
    finally: sc.camera = keep

def _export_weapon(wid, label, path):
    objs = [o for o in bpy.data.collections['ARC_Weapons'].objects if o.name in (f'ARC_W_{label}', f'ARC_W_{label}_String')]
    made, marks = [], []
    gltf_mode(True)
    try:
        for o in sorted(objs, key=lambda o: o.name):
            made.append(export_copy([o], 'String' if o.name.endswith('_String') else label, None, (0, 0, 0), True))
        for name, (loc, props) in MARKERS[wid].items():
            old = bpy.data.objects.get(name)
            if old: bpy.data.objects.remove(old, do_unlink=True)
            e = bpy.data.objects.new(name, None); coll('ARC_Export').objects.link(e); e.location = loc
            for k, v in props.items(): e[k] = v
            marks.append(e)
        n = tris(made); size = export_glb(made + marks, path)
    finally:
        gltf_mode(False)
        for o in made:
            me = o.data; bpy.data.objects.remove(o, do_unlink=True)
            if me.users == 0: bpy.data.meshes.remove(me)
        for e in marks: bpy.data.objects.remove(e, do_unlink=True)
    return {'file': path.rsplit('/', 1)[-1], 'kb': round(size / 1024, 1), 'tris': n}

def ship_weapons(out=OUT + '/arcade'):
    """One GLB per weapon (body + String node + Muzzle/Sight markers) and a 256 px catalog card each."""
    res = {wid: _export_weapon(wid, label, f'{out}/arcade-{wid}.glb') for wid, _, label in WEAPON_BUILDERS}
    cards = {wid: ([o.name for o in bpy.data.collections['ARC_Weapons'].objects if o.name.startswith(f'ARC_W_{label}')], True)
             for wid, _, label in WEAPON_BUILDERS}
    res['cards'] = thumbnails(thumbs=cards)
    return res
