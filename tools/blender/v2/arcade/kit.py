"""Arcade theme look-dev kit: palette, toon materials, outlines, colour gradients, sky, sun and haze.

Run inside Blender after vg.py, in the same globals (hero_corner.py shows the loader).

Every ARC_ material carries two branches:
  toon  EEVEE only. Shader to RGB gives a soft two-tone terminator, a cool lilac shade, a gentle warm
        rim and distance haze.
  glTF  a plain Principled BSDF: palette colour x the 'Col' vertex gradient. This is what ships in the
        GLB, so the engine receives clean colour blocks and applies its own toon shading.
gltf_mode(True) switches every material to its glTF branch for export. Outlines are inverted-hull
Solidify shells, render only; export copies drop them. No textures anywhere: colour comes from the
palette, the baked vertex gradients, the shading and the silhouette.
"""
import bpy, bmesh, math, os, random
import numpy as np
from mathutils import Vector, Matrix, noise as mnoise

GRAD = 'Col'   # vertex-colour gradient attribute, exported as COLOR_0
TEX = OUT + '/arcade/textures'   # small tileable painted multipliers made by paint_textures()

# The theme palette, sampled from the look-dev sheet (assets/v2/arcade/ref).
PALETTE = {
    'coral_pink': '#fd757d', 'butter_yellow': '#fedf75', 'mint': '#6ae2ac', 'sky_blue': '#69c9fd', 'lilac': '#c2a3fd',
    'roof_red': '#c5583b', 'wood_brown': '#a16943', 'stone_grey': '#a9a8ac', 'grass_green': '#55a455', 'warm_sand': '#f0bb84',
}

# Materials as their sunlit tone: gradients and the shade tint only ever darken it.
SHADE = '#c9bedf'   # default shade-side multiplier: cool lilac, never plain grey
MATERIALS = {
    'ARC_CoralPink':    ('#fd757d', {}),
    'ARC_ButterYellow': ('#fedf75', {}),
    'ARC_Mint':         ('#6ae2ac', {}),
    'ARC_SkyBlue':      ('#69c9fd', {}),
    'ARC_Lilac':        ('#c2a3fd', {}),
    'ARC_Roof':         ('#ee5f3a', {'shade': '#bd9ec6'}),
    'ARC_Wood':         ('#c47d4a', {}),
    'ARC_WoodDark':     ('#91573a', {}),
    'ARC_Stone':        ('#c3c0c9', {}),
    'ARC_StoneDark':    ('#8f8b9f', {}),
    'ARC_Plaster':      ('#fbecd2', {}),
    # foliage and lawn are white: their greens live in nature.py's tone ramps, baked per vertex
    'ARC_Grass':        ('#ffffff', {'shade': '#a9bfd0', 'rim': 0.0, 'tex': 'arcade-grass.png'}),
    'ARC_Leaf':         ('#ffffff', {'shade': '#9bb6cc'}),
    'ARC_Bark':         ('#ffffff', {}),
    'ARC_Sand':         ('#f4c890', {'rim': 0.0, 'tex': 'arcade-sand.png'}),
    'ARC_Iron':         ('#6e7285', {}),
    'ARC_Glass':        ('#4f98e0', {'rim': 0.7}),
    'ARC_Petal':        ('#fffaf3', {}),
    'ARC_Cloud':        ('#ffffff', {'shade': '#d5d8f0', 'fog': 0.0, 'rim': 0.0}),
}
GLOW = {'ARC_Glow': '#ffd873'}
OUTLINE = '#4e3129'

def hexlin(h):
    """sRGB hex -> linear RGB (Blender colour sockets are linear)."""
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)

# ---------------------------------------------------------------- shading

def _mul(nt, a, b, loc=(0, 0)):
    """Colour multiply in the exact form the glTF exporter reads back as factor x COLOR_0."""
    n = _n(nt, 'ShaderNodeMix', loc, data_type='RGBA', blend_type='MULTIPLY')
    n.inputs[0].default_value = 1.0
    for sock, x in ((n.inputs[6], a), (n.inputs[7], b)):
        if isinstance(x, (tuple, list)): sock.default_value = (*x[:3], 1)
        else: _link(nt, x, sock)
    return n.outputs[2]

def _group(name, inputs):
    ng = bpy.data.node_groups.new(name, 'ShaderNodeTree')
    for sname, stype, dv in inputs:
        s = ng.interface.new_socket(sname, in_out='INPUT', socket_type=stype); s.default_value = dv
    ng.interface.new_socket('Color', in_out='OUTPUT', socket_type='NodeSocketColor')
    return ng, _n(ng, 'NodeGroupInput', (-1300, 0)), _n(ng, 'NodeGroupOutput', (900, 0))

def haze_group():
    """Exponential distance haze toward the sky's horizon colour (matches the engine's fog model)."""
    ng = bpy.data.node_groups.get('ARC_Haze')
    if ng: return ng
    ng, gi, go = _group('ARC_Haze', (('Color', 'NodeSocketColor', (1, 1, 1, 1)), ('Amount', 'NodeSocketFloat', 1.0)))
    cam = _n(ng, 'ShaderNodeCameraData', (-900, -200))
    start = _n(ng, 'ShaderNodeValue', (-900, -400), name='ARC_HazeStart', label='Haze start')
    dens = _n(ng, 'ShaderNodeValue', (-900, -500), name='ARC_HazeDensity', label='Haze density')
    col = _n(ng, 'ShaderNodeRGB', (-300, 250), name='ARC_HazeColor', label='Haze colour')
    d = _math(ng, 'MAXIMUM', _math(ng, 'SUBTRACT', cam.outputs['View Distance'], start.outputs[0]), 0.0)
    f = _math(ng, 'SUBTRACT', 1.0, _math(ng, 'EXPONENT', _math(ng, 'MULTIPLY', _math(ng, 'MULTIPLY', d, dens.outputs[0]), -1.0)))
    f = _math(ng, 'MULTIPLY', f, gi.outputs['Amount'])
    _link(ng, _mixc(ng, f, gi.outputs['Color'], col.outputs[0]), go.inputs['Color'])
    return ng

def toon_group():
    """Soft two-tone toon: light -> luminance -> smoothstep terminator, lilac shade, warm rim, haze."""
    ng = bpy.data.node_groups.get('ARC_Toon')
    if ng: return ng
    ng, gi, go = _group('ARC_Toon', (('Color', 'NodeSocketColor', (1, 1, 1, 1)), ('Shade', 'NodeSocketColor', (0.6, 0.55, 0.75, 1)),
                                     ('Rim', 'NodeSocketFloat', 0.3), ('Haze', 'NodeSocketFloat', 1.0)))
    dif = _n(ng, 'ShaderNodeBsdfDiffuse', (-1300, 500))
    s2r = _n(ng, 'ShaderNodeShaderToRGB', (-1100, 500)); _link(ng, dif.outputs[0], s2r.inputs[0])
    bw = _n(ng, 'ShaderNodeRGBToBW', (-900, 500)); _link(ng, s2r.outputs[0], bw.inputs[0])
    lo = _n(ng, 'ShaderNodeValue', (-900, 800), name='ARC_TermLo', label='Terminator low')
    hi = _n(ng, 'ShaderNodeValue', (-900, 700), name='ARC_TermHi', label='Terminator high')
    term = _n(ng, 'ShaderNodeMapRange', (-650, 500), interpolation_type='SMOOTHSTEP', clamp=True)
    _link(ng, bw.outputs[0], term.inputs[0]); _link(ng, lo.outputs[0], term.inputs[1]); _link(ng, hi.outputs[0], term.inputs[2])
    lit = term.outputs[0]
    # inside the lit tone, faces square to the sun read a touch brighter: soft form without a third band
    up = _n(ng, 'ShaderNodeMapRange', (-650, 250), clamp=True)
    _link(ng, bw.outputs[0], up.inputs[0]); _link(ng, hi.outputs[0], up.inputs[1])
    _link(ng, _math(ng, 'ADD', hi.outputs[0], 0.9), up.inputs[2])
    up.inputs[3].default_value = 0.9; up.inputs[4].default_value = 1.0
    sc = _n(ng, 'ShaderNodeVectorMath', (-400, 250), operation='SCALE')
    _link(ng, gi.outputs['Color'], sc.inputs[0]); _link(ng, up.outputs[0], sc.inputs['Scale'])
    shade = _mul(ng, gi.outputs['Color'], gi.outputs['Shade'], (-400, 0))
    c = _mixc(ng, lit, shade, sc.outputs[0])
    # rim: warm light along silhouettes, strongest on the sunny side
    lw = _n(ng, 'ShaderNodeLayerWeight', (-650, -300)); lw.inputs['Blend'].default_value = 0.45
    rim = _mapr(ng, lw.outputs['Facing'], 0.62, 0.95)
    rim = _math(ng, 'MULTIPLY', _math(ng, 'MULTIPLY', rim, gi.outputs['Rim']), _math(ng, 'ADD', 0.35, _math(ng, 'MULTIPLY', lit, 0.65)))
    rimc = _n(ng, 'ShaderNodeRGB', (-150, -300), name='ARC_RimColor', label='Rim colour')
    c = _mixc(ng, rim, c, rimc.outputs[0])
    hz = _n(ng, 'ShaderNodeGroup', (500, 0)); hz.node_tree = haze_group()
    _link(ng, c, hz.inputs['Color']); _link(ng, gi.outputs['Haze'], hz.inputs['Amount'])
    _link(ng, hz.outputs['Color'], go.inputs['Color'])
    return ng

def set_look(term=(0.42, 0.62), rim='#fff3df', haze='#cfe4f7', haze_density=0.009, haze_start=25.0):
    """The kit's global dials: terminator band, rim colour, haze colour/density/start distance (m)."""
    t = toon_group().nodes
    t['ARC_TermLo'].outputs[0].default_value, t['ARC_TermHi'].outputs[0].default_value = term
    t['ARC_RimColor'].outputs[0].default_value = (*hexlin(rim), 1)
    h = haze_group().nodes
    h['ARC_HazeColor'].outputs[0].default_value = (*hexlin(haze), 1)
    h['ARC_HazeDensity'].outputs[0].default_value = haze_density
    h['ARC_HazeStart'].outputs[0].default_value = haze_start

def _fresh(name):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    nt = mat.node_tree
    for n in list(nt.nodes): nt.nodes.remove(n)
    return mat, nt, _n(nt, 'ShaderNodeOutputMaterial', (700, 0))

def toon(name, hex_, shade=SHADE, rim=0.3, fog=1.0, tex=None):
    """Base colour = palette factor x (vertex gradient x optional painted texture): the exact chain the
    glTF exporter reads back as baseColorFactor, COLOR_0 and baseColorTexture."""
    mat, nt, out = _fresh(name)
    vc = _n(nt, 'ShaderNodeVertexColor', (-700, 0), layer_name=GRAD)
    col = vc.outputs['Color']
    if tex:
        ti = _n(nt, 'ShaderNodeTexImage', (-950, -250)); ti.image = bpy.data.images.load(f'{TEX}/{tex}', check_existing=True)
        col = _mul(nt, col, ti.outputs['Color'], (-700, -150))
    base = _mul(nt, col, hexlin(hex_), (-450, 0)); base.node.name = 'ARC_BASE'
    grp = _n(nt, 'ShaderNodeGroup', (-150, 150)); grp.node_tree = toon_group()
    _link(nt, base, grp.inputs['Color'])
    grp.inputs['Shade'].default_value = (*hexlin(shade), 1)
    grp.inputs['Rim'].default_value = rim; grp.inputs['Haze'].default_value = fog
    em = _n(nt, 'ShaderNodeEmission', (200, 150), name='ARC_TOON'); _link(nt, grp.outputs['Color'], em.inputs['Color'])
    pb = _n(nt, 'ShaderNodeBsdfPrincipled', (200, -250), name='ARC_GLTF')
    _link(nt, base, pb.inputs['Base Color']); pb.inputs['Roughness'].default_value = 0.85
    _link(nt, em.outputs[0], out.inputs['Surface'])
    mat.diffuse_color = (*hexlin(hex_), 1)
    mat['arc_color'] = hex_
    return mat

def glow(name, hex_, strength=1.0):
    mat, nt, out = _fresh(name)
    em = _n(nt, 'ShaderNodeEmission', (200, 150), name='ARC_TOON')
    em.inputs['Color'].default_value = (*hexlin(hex_), 1); em.inputs['Strength'].default_value = strength
    pb = _n(nt, 'ShaderNodeBsdfPrincipled', (200, -250), name='ARC_GLTF')
    pb.inputs['Base Color'].default_value = (*hexlin(hex_), 1)
    pb.inputs['Emission Color'].default_value = (*hexlin(hex_), 1); pb.inputs['Emission Strength'].default_value = strength
    _link(nt, em.outputs[0], out.inputs['Surface'])
    mat.diffuse_color = (*hexlin(hex_), 1)
    mat['arc_color'] = hex_
    return mat

def outline_mat():
    mat = bpy.data.materials.get('ARC_Outline')
    if mat: return mat
    mat, nt, out = _fresh('ARC_Outline')
    rgb = _n(nt, 'ShaderNodeRGB', (-500, 0)); rgb.outputs[0].default_value = (*hexlin(OUTLINE), 1)
    hz = _n(nt, 'ShaderNodeGroup', (-250, 0)); hz.node_tree = haze_group(); _link(nt, rgb.outputs[0], hz.inputs['Color'])
    em = _n(nt, 'ShaderNodeEmission', (200, 0)); _link(nt, hz.outputs['Color'], em.inputs['Color'])
    _link(nt, em.outputs[0], out.inputs['Surface'])
    # inverted hull: only the far side of the shell draws, and it never shades its own object
    mat.use_backface_culling = True
    try: mat.use_backface_culling_shadow = True
    except AttributeError: pass
    mat.diffuse_color = (*hexlin(OUTLINE), 1)
    return mat

def materials():
    """Build the whole kit; returns {short name: material}, e.g. M['Roof'] for ARC_Roof."""
    if not os.path.exists(TEX + '/arcade-grass.png'): paint_textures()
    M = {k[4:]: toon(k, h, **kw) for k, (h, kw) in MATERIALS.items()}
    M.update({k[4:]: glow(k, h) for k, h in GLOW.items()})
    M['Outline'] = outline_mat()
    return M

def gltf_mode(on):
    """Point every ARC_ material's output at its glTF branch (export) or back at its toon branch."""
    for m in bpy.data.materials:
        nt = m.node_tree
        if not nt: continue
        a, b = nt.nodes.get('ARC_GLTF'), nt.nodes.get('ARC_TOON')
        out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'), None)
        if a and b and out: _link(nt, (a if on else b).outputs[0], out.inputs['Surface'])

def outline(ob, width=0.035):
    """Inverted-hull outline: a Solidify shell pushed out along the normals with flipped faces."""
    om = outline_mat()
    if ob.data.materials.find(om.name) < 0: ob.data.materials.append(om)
    m = ob.modifiers.get('ARC_Outline') or ob.modifiers.new('ARC_Outline', 'SOLIDIFY')
    m.thickness = width; m.offset = 1.0; m.use_flip_normals = True; m.use_even_offset = True
    m.use_quality_normals = True; m.use_rim = False
    m.material_offset = 64   # clamps to the last slot: the outline material
    return ob

# ---------------------------------------------------------------- painted textures

def _fft_noise(n, seed, power, lo, hi, angle=0.0, stretch=1.0):
    """Seamlessly tiling noise: a random-phase spectrum with 1/k^power falloff between wave numbers
    lo..hi (stretch > 1 makes streaks along `angle`)."""
    rng = np.random.default_rng(seed)
    f = np.fft.fftfreq(n) * n
    kx, ky = np.meshgrid(f, f, indexing='ij')
    u = kx * math.cos(angle) + ky * math.sin(angle); v = (ky * math.cos(angle) - kx * math.sin(angle)) * stretch
    k = np.sqrt(u * u + v * v)
    amp = np.where((k >= lo) & (k <= hi), np.power(np.maximum(k, 1e-6), -power), 0.0)
    field = np.real(np.fft.ifft2(amp * np.exp(2j * np.pi * rng.random((n, n)))))
    return (field - field.mean()) / (field.std() + 1e-9)

def _step(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)

def _save_tex(lin, path):
    """Linear RGB multipliers -> sRGB PNG (byte-image pixels are stored sRGB-encoded)."""
    n = lin.shape[0]; x = np.clip(lin, 0.0, 1.0)
    px = np.ones((n, n, 4), np.float32)
    px[..., :3] = np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)
    im = bpy.data.images.new(os.path.basename(path), n, n); im.pixels.foreach_set(px.ravel())
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.filepath_raw = path; im.file_format = 'PNG'; im.save(); bpy.data.images.remove(im)
    return path

def paint_textures(n=512):
    """The theme's only textures: small tileable painted multipliers (mean ~0.9) that add hand-painted
    breakup on top of the vertex colours. Grass: soft tonal blotches plus short light and dark blade
    strokes. Sand: soft blotches plus grit. Generated with numpy (no downloads, no GPU bake)."""
    blot = _step(-0.35, 0.35, _fft_noise(n, 1, 2.2, 2, 20))
    blot2 = _step(0.2, 0.9, _fft_noise(n, 2, 2.0, 3, 28))
    light = _step(1.3, 2.3, _fft_noise(n, 3, 0.8, 24, 150, 0.5, 4.0))
    dark = _step(1.2, 2.2, _fft_noise(n, 4, 0.8, 24, 150, 1.9, 4.0))
    grass = np.stack([0.80 + 0.10 * blot + 0.07 * blot2 + 0.17 * light - 0.24 * dark,
                      0.84 + 0.09 * blot + 0.04 * blot2 + 0.16 * light - 0.20 * dark,
                      0.82 + 0.05 * blot - 0.06 * blot2 + 0.04 * light - 0.10 * dark], -1)
    sb = _step(-0.4, 0.4, _fft_noise(n, 6, 2.0, 2, 18)); grit = _fft_noise(n, 7, 0.3, 60, 250)
    dk, lt = _step(1.5, 2.4, grit), _step(1.5, 2.4, -grit)
    sand = np.stack([0.9 + 0.07 * sb - 0.16 * dk + 0.08 * lt, 0.9 + 0.06 * sb - 0.17 * dk + 0.07 * lt, 0.88 + 0.05 * sb - 0.16 * dk + 0.05 * lt], -1)
    return [_save_tex(grass, TEX + '/arcade-grass.png'), _save_tex(sand, TEX + '/arcade-sand.png')]

# ---------------------------------------------------------------- baked colour gradients

def paint(objs, fn):
    """Write the GRAD vertex colour: fn(world_co, local_co) -> (r, g, b) multiplier in 0..1."""
    for o in objs:
        me = o.data
        a = me.color_attributes.get(GRAD)
        if a and (a.domain != 'POINT' or a.data_type != 'FLOAT_COLOR'):
            me.color_attributes.remove(a); a = None
        a = a or me.color_attributes.new(GRAD, 'FLOAT_COLOR', 'POINT')
        mw = o.matrix_world; buf = []
        for v in me.vertices:
            buf += (*fn(mw @ v.co, v.co), 1.0)
        a.data.foreach_set('color', buf)
        try:
            me.color_attributes.active_color_name = GRAD
            me.color_attributes.default_color_name = GRAD
        except AttributeError: pass

def vgrad(objs, bottom, top=(1, 1, 1), lo=None, hi=None, power=1.0, local=False):
    """Vertical gradient from `bottom` at z=lo to `top` at z=hi, over each object's own Z range unless
    lo/hi are given. local=True measures mesh Z, so modular pieces carry their gradient anywhere."""
    for o in objs:
        zs = [v.co.z if local else (o.matrix_world @ v.co).z for v in o.data.vertices]
        z0 = min(zs) if lo is None else lo; z1 = max(zs) if hi is None else hi
        def fn(w, l, z0=z0, z1=z1):
            t = min(1.0, max(0.0, ((l.z if local else w.z) - z0) / max(z1 - z0, 1e-6))) ** power
            return tuple(bottom[i] + (top[i] - bottom[i]) * t for i in range(3))
        paint([o], fn)

def ensure_grad(objs):
    for o in objs:
        if o.type == 'MESH' and GRAD not in o.data.color_attributes: paint([o], lambda w, l: (1.0, 1.0, 1.0))

# ---------------------------------------------------------------- modelling helpers

def put(ob, c):
    for u in list(ob.users_collection): u.objects.unlink(ob)
    c.objects.link(ob)
    return ob

def chunky(ob, bev=0.06, segs=1, angle=30):
    """Arcade finish: a soft chamfer that catches the rim light, smooth shading, weighted normals."""
    if bev > 0: bevel(ob, bev, segs, angle)
    return smooth(ob, angle + 10)

def rbox(name, size, loc, mat, bev=0.06, rot=None, segs=1):
    return chunky(box(name, size, loc, mat, rot), bev, segs)

def strut(name, a, b, width, depth, mat=None):
    """Beam from a to b (not vertical): `width` across it in its vertical plane, `depth` horizontal."""
    a, b = Vector(a), Vector(b); d = b - a
    ob = box(name, (d.length, depth, width), (0, 0, 0), mat)
    ob.data.transform(Matrix.Translation((a + b) / 2) @ d.to_track_quat('X', 'Z').to_matrix().to_4x4())
    return ob

def arch_pts(w, h, cu=0.0, v0=0.0, n=8):
    """Round-top arch outline, w wide and h tall from v0, centred on u=cu (for doors and windows)."""
    r = w / 2; vs = v0 + h - r
    return [(cu - r, v0), (cu + r, v0)] + [(cu + r * math.cos(math.pi * k / n), vs + r * math.sin(math.pi * k / n)) for k in range(n + 1)]

def torus(name, R, r, loc, mat, axis='Y', segs=8, rsegs=5):
    prof = [(R + r * math.cos(2 * math.pi * k / rsegs), r * math.sin(2 * math.pi * k / rsegs)) for k in range(rsegs + 1)]
    ob = lathe(name, prof, axis=axis, segs=segs, mat=mat, center=loc, cap=False)
    ob.data.shade_smooth()
    return ob

def blob(name, loc, r, mat, subd=3, scale=(1, 1, 1), jitter=0.06, seed=0):
    """Lumpy smooth icosphere: foliage clumps, bushes, clouds. bmesh counts subdivisions from 1 (the bare
    20-face icosahedron): subd 2 = 80 tris (faceted), subd 3 = 320 tris (round silhouette)."""
    bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=subd, radius=r)
    off = Vector((seed * 1.7, seed * 0.61, seed * 0.33))
    for v in bm.verts:
        v.co *= 1.0 + jitter * mnoise.noise(v.co * (1.3 / r) + off)
        v.co.x *= scale[0]; v.co.y *= scale[1]; v.co.z *= scale[2]
    bmesh.ops.translate(bm, vec=loc, verts=bm.verts)
    ob = new_obj(name, bm, mat); ob.data.shade_smooth()
    return ob

def rock(name, size, mat, seed=0, yaw=0.0, round_=0.32):
    """Chunky rounded boulder resting on z=0 at the object origin."""
    ob = box(name, size, (0, 0, size[2] / 2), mat)
    bevel(ob, min(size) * round_, 2, 30)
    rnd = random.Random(seed); m = min(size) * 0.06
    for v in ob.data.vertices:
        v.co += Vector((rnd.uniform(-m, m), rnd.uniform(-m, m), rnd.uniform(-m, m) if v.co.z > 0.02 else 0.0))
    xform(ob, rot=[('Z', yaw)])
    return smooth(ob, 45, weighted=False)

def tris(objs):
    n = 0
    for o in objs:
        if o.type == 'MESH':
            o.data.calc_loop_triangles(); n += len(o.data.loop_triangles)
    return n

# ---------------------------------------------------------------- sky, sun, camera, render

def sky(top='#5a9fea', mid='#9fd0f8', horizon='#cfe4f7', fill='#d3e2f4', fill_strength=0.45):
    """Pastel gradient seen by the camera; a separate soft, even fill for lighting."""
    sc = bpy.context.scene
    w = bpy.data.worlds.get('ARC_Sky') or bpy.data.worlds.new('ARC_Sky')
    try: w.use_nodes = True
    except AttributeError: pass
    sc.world = w
    nt = w.node_tree
    for n in list(nt.nodes): nt.nodes.remove(n)
    out = _n(nt, 'ShaderNodeOutputWorld', (800, 0))
    tc = _n(nt, 'ShaderNodeTexCoord', (-800, 0))
    sep = _n(nt, 'ShaderNodeSeparateXYZ', (-600, 0)); _link(nt, tc.outputs['Generated'], sep.inputs[0])
    t = _mapr(nt, sep.outputs['Z'], -0.02, 0.28)
    ramp = _n(nt, 'ShaderNodeValToRGB', (-200, 0)); _link(nt, t, ramp.inputs[0])
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = 0.0, (*hexlin(horizon), 1)
    els[1].position, els[1].color = 1.0, (*hexlin(top), 1)
    e = els.new(0.3); e.color = (*hexlin(mid), 1)
    cam_bg = _n(nt, 'ShaderNodeBackground', (200, 100)); _link(nt, ramp.outputs[0], cam_bg.inputs['Color'])
    light_bg = _n(nt, 'ShaderNodeBackground', (200, -100))
    light_bg.inputs['Color'].default_value = (*hexlin(fill), 1); light_bg.inputs['Strength'].default_value = fill_strength
    lp = _n(nt, 'ShaderNodeLightPath', (200, 300))
    mix = _n(nt, 'ShaderNodeMixShader', (500, 0))
    _link(nt, lp.outputs['Is Camera Ray'], mix.inputs[0]); _link(nt, light_bg.outputs[0], mix.inputs[1]); _link(nt, cam_bg.outputs[0], mix.inputs[2])
    _link(nt, mix.outputs[0], out.inputs['Surface'])
    return w

def sun(to_sun=(-0.2, -0.62, 0.72), strength=4.0, color='#fff0da', angle=3.0, collection=None):
    L = bpy.data.objects.get('ARC_Sun') or bpy.data.objects.new('ARC_Sun', bpy.data.lights.new('ARC_Sun', 'SUN'))
    put(L, collection or bpy.context.scene.collection)
    L.data.energy = strength; L.data.color = hexlin(color); L.data.angle = math.radians(angle)
    L.data.shadow_maximum_resolution = 0.01   # soft, chunky shadows; finer is wasted on this style
    d = Vector(to_sun).normalized()
    L.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler(); L.location = d * 30
    return L

def camera(target, direction, dist, lens=35, shift_y=0.0, collection=None, name='ARC_Cam'):
    """Look-dev camera. Keep it pitched down ~15 degrees or more and frame the sky with shift_y: in
    Blender 5.2 EEVEE a near-level camera (about 7 degrees) silently loses every sun shadow."""
    cam = bpy.data.objects.get(name) or bpy.data.objects.new(name, bpy.data.cameras.new(name))
    put(cam, collection or bpy.context.scene.collection)
    t = Vector(target); d = Vector(direction).normalized()
    cam.location = t + d * dist
    cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = lens; cam.data.shift_y = shift_y; cam.data.clip_start = 0.1; cam.data.clip_end = 1000
    bpy.context.scene.camera = cam
    return cam

def render_setup(res=(1200, 700), samples=16):
    """Light EEVEE: no ray tracing or volumes; Standard view so the pastels stay as picked."""
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    for k, v in (('taa_render_samples', samples), ('taa_samples', 8), ('use_raytracing', False), ('use_fast_gi', False),
                 ('use_shadows', True), ('shadow_ray_count', 1), ('shadow_step_count', 6), ('shadow_resolution_scale', 1.0),
                 ('shadow_pool_size', '512'), ('use_volumetric_shadows', False)):
        try: setattr(sc.eevee, k, v)
        except (AttributeError, TypeError): pass
    sc.view_settings.view_transform = 'Standard'; sc.view_settings.look = 'None'
    sc.view_settings.exposure = 0.0; sc.view_settings.gamma = 1.0
    sc.render.film_transparent = False
    sc.render.resolution_x, sc.render.resolution_y = res; sc.render.resolution_percentage = 100

def render(path, res=(1200, 700), samples=16):
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y = res; sc.render.resolution_percentage = 100
    sc.eevee.taa_render_samples = samples
    sc.render.image_settings.file_format = 'PNG'
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path

def side_by_side(paths, out, height=700, gap=12):
    """Reference(s) and render in one strip, scaled to a common height, for review."""
    strips = []
    for p in paths:
        im = bpy.data.images.load(p, check_existing=False)
        w, h = im.size; a = np.empty(w * h * 4, np.float32); im.pixels.foreach_get(a)
        bpy.data.images.remove(im)
        a = a.reshape(h, w, 4); W = int(round(w * height / h))
        strips.append(a[(np.arange(height) * h / height).astype(int)][:, (np.arange(W) * w / W).astype(int)])
    total = sum(s.shape[1] for s in strips) + gap * (len(strips) - 1)
    o = np.ones((height, total, 4), np.float32); x = 0
    for s in strips:
        o[:, x:x + s.shape[1]] = s; x += s.shape[1] + gap
    im = bpy.data.images.new('arc_compare', total, height)
    im.pixels.foreach_set(o.ravel())
    os.makedirs(os.path.dirname(out), exist_ok=True)
    im.filepath_raw = out; im.file_format = 'PNG'; im.save()
    bpy.data.images.remove(im)
    return out

# ---------------------------------------------------------------- export

def export_copy(objs, name, origin=None, place=(0, 0, 0), local=False):
    """Merged export copy without outline shells. World transforms are baked in (or the mesh's local
    coordinates kept, local=True), `origin` becomes the node origin, and the node sits at `place`."""
    tmp = coll('ARC_Export'); parts = []
    for o in objs:
        c = o.copy(); c.data = o.data.copy()
        for m in list(c.modifiers): c.modifiers.remove(m)
        tmp.objects.link(c)
        if not local: c.data.transform(o.matrix_world)
        c.matrix_world = Matrix.Identity(4)
        parts.append(c)
    ob = merge(name, parts) if len(parts) > 1 else parts[0]
    ob.name = name; ob.data.name = name
    if origin is not None: ob.data.transform(Matrix.Translation(-Vector(origin)))
    i = ob.data.materials.find('ARC_Outline')
    if i >= 0: ob.data.materials.pop(index=i)
    ob.location = place
    return ob

def export_nodes(nodes, path):
    """nodes: [(node name, objs, origin, place, local)] -> one GLB; returns bytes and triangles."""
    made = []
    gltf_mode(True)
    try:
        for name, objs, origin, place, local in nodes:
            made.append(export_copy(objs, name, origin, place, local))
        n = tris(made); size = export_glb(made, path)
    finally:
        gltf_mode(False)
        for o in made:
            me = o.data; bpy.data.objects.remove(o, do_unlink=True)
            if me.users == 0: bpy.data.meshes.remove(me)
    return {'file': os.path.basename(path), 'kb': round(size / 1024, 1), 'tris': n}
