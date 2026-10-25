"""
Last Light hotel furniture pack (props_furniture.glb): lounge armchair, lounge sofa, coffee table and side table, built
to match panels 1-4 of the prop reference sheet (track-arm greige boucle upholstery on thin polished brass plinths;
polished brass drum tables with black marble tops).

    blender --background --factory-startup --python furniture.py -- <output-dir> [preview-dir] [reference.webp]

With a preview dir it also renders each prop in a studio set that mimics the sheet (charcoal sweep, warm key from the
upper left, rim light) and, given the reference image, writes side-by-side comparisons.

models.ts loads every props_*.glb pack and lets a name found there win over props.glb, so these four replace the
older versions by name. Conventions: one top-level object per prop (armchair, sofa, coffeeTable, brassTable), origin at
the floor centre, Blender +Y is the front (glTF -Z).
"""

import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = Path(ARGS[0]) if ARGS else Path("models/zombies")
PREVIEW = Path(ARGS[1]) if len(ARGS) > 1 else None
REFERENCE = Path(ARGS[2]) if len(ARGS) > 2 else None


# ---- scene helpers ---------------------------------------------------------------------------------------------------

def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)


def activate(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_mods(obj):
    activate(obj)
    bpy.ops.object.convert(target="MESH")
    return bpy.context.active_object


def smooth(obj, angle=35):
    for p in obj.data.polygons:
        p.use_smooth = True
    try:
        activate(obj)
        bpy.ops.object.shade_auto_smooth(angle=math.radians(angle))
    except Exception:
        pass
    return obj


def rbox(size, loc, mat, bevel=0.0, segs=4, rot=(0, 0, 0)):
    """Box with rounded edges (bevel applied), smooth shaded."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(mat)
    if bevel:
        m = o.modifiers.new("Bevel", "BEVEL")
        m.width = bevel
        m.segments = segs
        m.profile = 0.5
        m.limit_method = "NONE"
    o = apply_mods(o)
    smooth(o, 50)
    return o


def puffy(size, loc, mat, bevel, puff, rot=(0, 0, 0), sag=0.0, subdiv=1):
    """Upholstered cushion: rounded box, subdivided, faces bulged out (most in the middle), the top sagging a little."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))
    o = bpy.context.active_object
    o.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(mat)
    m = o.modifiers.new("Bevel", "BEVEL")
    m.width = bevel
    m.segments = 5
    m.limit_method = "NONE"
    s = o.modifiers.new("Sub", "SUBSURF")
    s.levels = subdiv
    s.render_levels = subdiv
    o = apply_mods(o)
    sx, sy, sz = size
    for v in o.data.vertices:
        lx = min(1.0, abs(v.co.x) / (sx / 2))
        ly = min(1.0, abs(v.co.y) / (sy / 2))
        lz = min(1.0, abs(v.co.z) / (sz / 2))
        bulge = (1 - lx ** 2 * 0.85) * (1 - ly ** 2 * 0.85) * (1 - lz ** 2 * 0.85)
        v.co += v.normal * puff * bulge
        if sag and v.co.z > 0:
            v.co.z -= sag * (1 - lx ** 2) * (1 - ly ** 2) * (v.co.z / (sz / 2))
    o.rotation_euler = rot
    o.location = loc
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
    smooth(o, 60)
    return o


def pillow(size, thick, loc, mat, rot=(0, 0, 0)):
    """Throw pillow: a dense grid box whose thickness falls to a seam at the edges, so corners pinch into points."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))
    o = bpy.context.active_object
    o.scale = (size, thick, size)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(mat)
    s = o.modifiers.new("Sub", "SUBSURF")
    s.levels = 3
    s.subdivision_type = "SIMPLE"
    o = apply_mods(o)
    h = size / 2
    for v in o.data.vertices:
        u = min(1.0, abs(v.co.x) / h)
        w = min(1.0, abs(v.co.z) / h)
        fall = (1 - u ** 2.4) * (1 - w ** 2.4)
        sign = 1 if v.co.y >= 0 else -1
        v.co.y = sign * (0.006 + (thick / 2) * fall ** 0.55)
        # Edges pull in a little where the cover is stretched over the filling.
        v.co.x *= 1 - 0.05 * (1 - w ** 2)
        v.co.z *= 1 - 0.05 * (1 - u ** 2)
    sm = o.modifiers.new("Smooth", "SUBSURF")
    sm.levels = 1
    o = apply_mods(o)
    o.rotation_euler = rot
    o.location = loc
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
    smooth(o, 80)
    return o


def lathe(name, profile, segments, mat):
    """Surface of revolution around Z from (r, z) points; UVs cylindrical (u around, v along the profile length)."""
    verts, faces, uvs = [], [], []
    n = len(profile)
    acc = [0.0]
    for i in range(1, n):
        acc.append(acc[-1] + math.dist(profile[i - 1], profile[i]))
    for s in range(segments + 1):
        a = 2 * math.pi * s / segments
        for (r, z) in profile:
            verts.append((r * math.cos(a), r * math.sin(a), z))
    for s in range(segments):
        for i in range(n - 1):
            a = s * n + i
            b = (s + 1) * n + i
            faces.append((a, b, b + 1, a + 1))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    me.materials.append(mat)
    uv = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            s, i = divmod(vi, n)
            uv.data[li].uv = (s / segments * 3.0, acc[i] * 1.5)
    # Weld the seam column back together for smooth shading (UVs stay split via the loops).
    activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=1e-5)
    bpy.ops.object.mode_set(mode="OBJECT")
    smooth(obj, 40)
    return obj


def disc_uv(obj, mat_index, scale):
    """Planar top-down UVs for the faces using a material slot (the marble tops)."""
    me = obj.data
    uv = me.uv_layers.active or me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        if poly.material_index != mat_index:
            continue
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            uv.data[li].uv = (co.x * scale + 0.5, co.y * scale + 0.5)


def box_uv(obj, per_metre, skip=()):
    """Triplanar-style UVs: each face projected along its dominant normal axis."""
    me = obj.data
    uv = me.uv_layers.active or me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        if poly.material_index in skip:
            continue
        n = poly.normal
        ax = max(range(3), key=lambda k: abs(n[k]))
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            u, v = ((co.y, co.z), (co.x, co.z), (co.x, co.y))[ax]
            uv.data[li].uv = (u * per_metre, v * per_metre)


def join(objs, name):
    activate(objs[0])
    for o in objs[1:]:
        o.select_set(True)
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = name
    # Material slots may repeat after the join; collapse duplicates so the GLB gets one primitive per material.
    me = obj.data
    seen = {}
    remap = {}
    for i, m in enumerate(me.materials):
        if m.name in seen:
            remap[i] = seen[m.name]
        else:
            seen[m.name] = i
    if remap:
        for p in me.polygons:
            p.material_index = remap.get(p.material_index, p.material_index)
        bpy.ops.object.material_slot_remove_unused()
    return obj


def tris(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


# ---- textures (numpy) ------------------------------------------------------------------------------------------------

def fnoise(h, w, beta=1.6, seed=0, stretch=(1.0, 1.0)):
    """Tileable fractal noise in 0..1 via FFT filtering. stretch > 1 smooths that axis (x, y)."""
    rng = np.random.default_rng(seed)
    white = rng.standard_normal((h, w))
    fy = np.fft.fftfreq(h)[:, None] * h / max(h, w) * stretch[1]
    fx = np.fft.fftfreq(w)[None, :] * w / max(h, w) * stretch[0]
    f = np.sqrt(fx * fx + fy * fy)
    f[0, 0] = 1.0
    spec = np.fft.fft2(white) / f ** beta
    spec[0, 0] = 0
    out = np.real(np.fft.ifft2(spec))
    out -= out.min()
    out /= max(out.max(), 1e-9)
    return out


def normal_from_height(hgt, strength):
    dx = (np.roll(hgt, -1, axis=1) - np.roll(hgt, 1, axis=1)) * 0.5 * strength
    dy = (np.roll(hgt, -1, axis=0) - np.roll(hgt, 1, axis=0)) * 0.5 * strength
    n = np.stack([-dx, -dy, np.ones_like(hgt)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def image(name, rgb, noncolor=False):
    h, w = rgb.shape[:2]
    rgba = np.concatenate([rgb, np.ones((h, w, 1))], axis=-1)
    img = bpy.data.images.new(name, w, h, alpha=False, float_buffer=False)
    if noncolor:
        img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(np.clip(rgba, 0, 1).astype(np.float32).ravel())
    img.file_format = "PNG"
    img.use_fake_user = True
    return img


def orm(rough, metal):
    h, w = rough.shape
    return np.stack([np.ones((h, w)), rough, metal], axis=-1)


def boucle_textures(size=512, seed=3, base=(0.235, 0.195, 0.152)):
    """Greige boucle: dense tiny loops (bright tips, dark gaps), a faint slubby tone variation."""
    h = w = size
    loops = fnoise(h, w, 0.35, seed)                       # nearly white noise = individual loops
    loops2 = fnoise(h, w, 0.6, seed + 1)
    tone = fnoise(h, w, 1.6, seed + 2)
    k = np.clip((loops * 0.6 + loops2 * 0.4 - 0.25) * 1.6, 0, 1)
    col = np.array(base)[None, None, :] * (0.8 + 0.3 * k[..., None]) * (0.95 + 0.08 * tone[..., None])
    rough = np.clip(0.88 + 0.08 * (1 - k), 0, 1)
    return srgb(col), orm(rough, np.zeros_like(rough)), normal_from_height(k, 2.6)


def velvet_textures(size=256, seed=5, base=(0.012, 0.012, 0.014)):
    h = w = size
    crush = fnoise(h, w, 1.4, seed)
    col = np.array(base)[None, None, :] * (0.8 + 0.5 * crush[..., None])
    rough = np.clip(0.55 + 0.25 * crush, 0, 1)
    return srgb(col), orm(rough, np.zeros_like(rough)), normal_from_height(crush, 0.6)


def brass_textures(size=512, seed=7):
    """Polished brass with fine vertical brushing (v is the vertical / long axis in our UVs)."""
    h = w = size
    streak = fnoise(h, w, 1.0, seed, stretch=(1.0, 60.0))
    fine = fnoise(h, w, 0.4, seed + 1, stretch=(1.0, 90.0))
    col = np.array((1.0, 0.66, 0.24))[None, None, :] * (0.93 + 0.08 * streak[..., None])
    rough = np.clip(0.07 + 0.07 * streak + 0.03 * fine, 0, 1)
    return srgb(col), orm(rough, np.ones_like(rough)), normal_from_height(streak * 0.5 + fine * 0.5, 0.12)


def marble_textures(size=1024, seed=11):
    """Polished black marble (panels 3, 4): near-black body crossed by a network of thin white crackle veins of even
    width, a few bolder, each with a faint grey halo. Veins are iso-lines of noise fields, normalised by the gradient so
    they keep a constant pixel width instead of ballooning where the noise is flat."""
    h = w = size
    cloud = fnoise(h, w, 1.5, seed)
    veins = np.zeros((h, w))
    halo = np.zeros((h, w))
    for i, (beta, px, amp, gate_at) in enumerate(((2.1, 2.0, 1.0, 0.25), (1.9, 1.5, 0.85, 0.3), (1.7, 1.1, 0.65, 0.4), (1.5, 0.9, 0.45, 0.5))):
        n = fnoise(h, w, beta, seed + 10 + i)
        gy, gx = np.gradient(n)
        grad = np.sqrt(gx * gx + gy * gy) + 1e-6
        d = np.abs(n - 0.5) / grad                     # distance to the iso-line in pixels
        gate = np.clip((fnoise(h, w, 1.8, seed + 20 + i) - gate_at) * 6, 0, 1)
        veins = np.maximum(veins, np.clip(1 - d / px, 0, 1) ** 1.3 * amp * gate)
        halo = np.maximum(halo, np.clip(1 - d / (px * 7), 0, 1) * 0.18 * amp * gate)
    base = np.array((0.011, 0.011, 0.012))[None, None, :] * (0.75 + 0.6 * cloud[..., None]) + np.array((0.05, 0.048, 0.046)) * halo[..., None]
    white = np.array((0.80, 0.78, 0.74))
    col = base * (1 - veins[..., None]) + white * veins[..., None]
    rough = np.clip(0.05 + 0.03 * cloud + 0.04 * veins, 0, 1)
    return srgb(col), orm(rough, np.zeros_like(rough)), normal_from_height(-0.2 * veins, 0.5)


def tex_material(name, maps, rough=0.5, metal=0.0, normal_strength=1.0, sheen=0.0, sheen_tint=(1, 1, 1)):
    albedo, rm, nrm = maps
    mat = bpy.data.materials.new(name)
    mat.use_fake_user = True
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    col = nt.nodes.new("ShaderNodeTexImage")
    col.image = albedo
    nt.links.new(col.outputs["Color"], bsdf.inputs["Base Color"])
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = rm
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(t.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    nm = nt.nodes.new("ShaderNodeTexImage")
    nm.image = nrm
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nmap.inputs["Strength"].default_value = normal_strength
    nt.links.new(nm.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    if sheen:
        bsdf.inputs["Sheen Weight"].default_value = sheen
        bsdf.inputs["Sheen Tint"].default_value = (*sheen_tint, 1.0)
        bsdf.inputs["Sheen Roughness"].default_value = 0.45
    return mat


def palette():
    fab = boucle_textures()
    vel = velvet_textures()
    br = brass_textures()
    mb = marble_textures()
    return {
        "fabric": tex_material("Boucle", (image("boucle_c", fab[0]), image("boucle_orm", fab[1], True), image("boucle_n", fab[2], True)), normal_strength=2.2, sheen=0.12, sheen_tint=(0.8, 0.74, 0.66)),
        "velvet": tex_material("Velvet", (image("velvet_c", vel[0]), image("velvet_orm", vel[1], True), image("velvet_n", vel[2], True)), sheen=0.25, sheen_tint=(0.12, 0.12, 0.14)),
        "brass": tex_material("BrushedBrass", (image("brass_c", br[0]), image("brass_orm", br[1], True), image("brass_n", br[2], True)), metal=1.0, normal_strength=0.3),
        "marble": tex_material("MarbleDark", (image("marble_c", mb[0]), image("marble_orm", mb[1], True), image("marble_n", mb[2], True)), normal_strength=0.5),
    }


# ---- props -----------------------------------------------------------------------------------------------------------
# Blender +Y is the front. Every upholstered piece: a thin brass plinth band on four short brass feet, the upholstered
# body above it with track arms flush with the back, loose seat and back cushions, scatter pillows.

def plinth(W, D, p, z_top, band, feet):
    """Thin polished brass band frame under the upholstery, standing on brass feet. feet: list of (x, y, sx, sy)."""
    parts = []
    z0 = z_top - band
    t = 0.02
    parts.append(rbox((W, t, band), (0, D / 2 - t / 2, z0 + band / 2), p["brass"], bevel=0.003, segs=2))
    parts.append(rbox((W, t, band), (0, -(D / 2 - t / 2), z0 + band / 2), p["brass"], bevel=0.003, segs=2))
    parts.append(rbox((t, D, band), (W / 2 - t / 2, 0, z0 + band / 2), p["brass"], bevel=0.003, segs=2))
    parts.append(rbox((t, D, band), (-(W / 2 - t / 2), 0, z0 + band / 2), p["brass"], bevel=0.003, segs=2))
    for (x, y, sx, sy) in feet:
        parts.append(rbox((sx, sy, z0), (x, y, z0 / 2), p["brass"], bevel=0.003, segs=2))
    return parts


def upholstered(W, D, H, z0, arm, back, seat_h, seats, p, pillows, cush_h=0.16):
    """Track-arm piece on a plinth whose top is z0. H is the top of the arms and the back (flush, as in the sheet).
    seats: number of seat cushions. pillows: (x, material, size, yaw) leaning on the back panel."""
    f = p["fabric"]
    parts = []
    base_top = z0 + seat_h
    # Seat platform (its front is the visible rail under the cushion).
    parts.append(rbox((W - 2 * arm + 0.01, D - back + 0.01, seat_h), (0, back / 2, z0 + seat_h / 2), f, bevel=0.02, segs=4))
    for sx in (-1, 1):
        parts.append(puffy((arm, D, H - z0), (sx * (W / 2 - arm / 2), 0, z0 + (H - z0) / 2), f, bevel=0.03, puff=0.005))
    parts.append(puffy((W - 2 * arm + 0.02, back, H - z0), (0, -(D / 2 - back / 2), z0 + (H - z0) / 2), f, bevel=0.03, puff=0.005))
    inner = W - 2 * arm - 0.006
    cw = inner / seats
    seat_d = D - back - 0.006
    for i in range(seats):
        x = -inner / 2 + cw * (i + 0.5)
        parts.append(puffy((cw - 0.006, seat_d, cush_h), (x, (D / 2 - seat_d / 2) - 0.002, base_top + cush_h / 2), f, bevel=0.04, puff=0.01, sag=0.006))
    for (x, mat, sz, yaw) in pillows:
        parts.append(pillow(sz, 0.17, (x, -(D / 2 - back) + 0.13, base_top + cush_h + sz * 0.43 - 0.02), mat,
                            rot=(math.radians(-16), math.radians(yaw * 0.6), math.radians(yaw))))
    return parts


def prop_armchair(p):
    W, D, H = 0.86, 0.84, 0.78
    z0, band = 0.13, 0.035
    feet = [(sx * (W / 2 - 0.03), sy * (D / 2 - 0.03), 0.032, 0.032) for sx in (-1, 1) for sy in (-1, 1)]
    parts = plinth(W, D, p, z0, band, feet)
    parts += upholstered(W, D, H, z0, arm=0.15, back=0.17, seat_h=0.13, seats=1, p=p, pillows=[(0.0, p["fabric"], 0.5, 0)], cush_h=0.17)
    obj = join(parts, "armchair")
    box_uv(obj, per_metre=2.6)
    return obj


def prop_sofa(p):
    W, D, H = 2.21, 0.95, 0.70
    z0, band = 0.085, 0.03
    # Two wide block feet near each end, as in panel 2.
    feet = [(sx * (W / 2 - 0.26), 0.0, 0.16, D - 0.2) for sx in (-1, 1)]
    parts = plinth(W, D, p, z0, band, feet)
    pil = [(0.64, p["velvet"], 0.52, -8), (0.24, p["fabric"], 0.48, 4), (-0.34, p["velvet"], 0.5, -5), (-0.68, p["velvet"], 0.52, 8)]
    parts += upholstered(W, D, H, z0, arm=0.19, back=0.22, seat_h=0.13, seats=1, p=p, pillows=pil, cush_h=0.18)
    obj = join(parts, "sofa")
    box_uv(obj, per_metre=2.6)
    return obj


def drum_table(name, r, h, p):
    """Polished brass drum: a proud foot ring and a proud top rim (each set off by a small groove) around a straight
    body; the rim holds an inset black marble top."""
    g = 0.006   # groove depth
    prof = [(0.0, 0.0), (r + 0.01, 0.0), (r + 0.014, 0.004), (r + 0.014, 0.034), (r + 0.01, 0.038),
            (r - g, 0.04), (r - g, 0.048), (r, 0.052), (r, h - 0.05), (r - g, h - 0.046), (r - g, h - 0.04),
            (r + 0.008, h - 0.036), (r + 0.012, h - 0.032), (r + 0.012, h - 0.004), (r + 0.008, h),
            (r - 0.012, h), (r - 0.014, h - 0.005)]
    body = lathe(name + "_body", prof, 96, p["brass"])
    top = lathe(name + "_top", [(0.0, h - 0.005), (r - 0.014, h - 0.005), (r - 0.014, h - 0.03)], 96, p["marble"])
    obj = join([body, top], name)
    disc_uv(obj, [m.name for m in obj.data.materials].index("MarbleDark"), 1.4 / (2 * r))
    return obj


def prop_coffee_table(p):
    return drum_table("coffeeTable", 0.5, 0.46, p)


def prop_brass_table(p):
    return drum_table("brassTable", 0.3, 0.58, p)


# ---- studio preview ----------------------------------------------------------------------------------------------------

def studio():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for kind in ("OPTIX", "CUDA"):
            try:
                prefs.compute_device_type = kind
                prefs.get_devices()
                for d in prefs.devices:
                    d.use = True
                scene.cycles.device = "GPU"
                break
            except Exception:
                continue
    except Exception:
        pass
    scene.cycles.samples = 96
    scene.cycles.use_denoising = True
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = -0.55
    world = bpy.data.worlds.new("Studio")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.03, 0.03, 0.032, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
    scene.world = world
    # Charcoal sweep: floor curving up into the backdrop, slightly glossy so feet and drums reflect.
    floor_mat = bpy.data.materials.new("StudioFloor")
    floor_mat.use_nodes = True
    b = floor_mat.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (0.03, 0.03, 0.032, 1)
    b.inputs["Roughness"].default_value = 0.38
    prof = [(-6.0, 0.0)] + [(1.5 + 1.2 * math.sin(a), 1.2 - 1.2 * math.cos(a)) for a in np.linspace(0, math.pi / 2, 12)] + [(2.7, 5.0)]
    verts, faces = [], []
    for i, (y, z) in enumerate(prof):
        verts += [(-8, -y, z), (8, -y, z)]
        if i:
            a = (i - 1) * 2
            faces.append((a, a + 1, a + 3, a + 2))
    me = bpy.data.meshes.new("sweep")
    me.from_pydata(verts, [], faces)
    sweep = bpy.data.objects.new("sweep", me)
    bpy.context.collection.objects.link(sweep)
    me.materials.append(floor_mat)
    smooth(sweep, 80)

    def area(name, loc, target, energy, size, color):
        d = bpy.data.lights.new(name, "AREA")
        d.energy = energy
        d.spread = math.radians(100)
        d.size = size
        d.color = color
        o = bpy.data.objects.new(name, d)
        bpy.context.collection.objects.link(o)
        o.location = loc
        direction = Vector(target) - Vector(loc)
        o.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        return o

    area("key", (-2.6, 2.6, 3.0), (0, 0, 0.4), 140, 1.6, (1.0, 0.84, 0.64))
    area("fill", (2.8, 2.6, 1.2), (0, 0, 0.4), 22, 3.0, (0.85, 0.88, 1.0))
    area("rim", (1.8, -2.4, 2.2), (0, 0, 0.5), 160, 1.0, (1.0, 0.88, 0.7))
    # Tall soft strips the camera does not see: they paint the long vertical highlights on the polished brass.
    strip = bpy.data.materials.new("Strip")
    strip.use_nodes = True
    nt = strip.node_tree
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs[1].default_value = 5.0
    em.inputs[0].default_value = (1.0, 0.9, 0.75, 1)
    nt.links.new(em.outputs[0], nt.nodes["Material Output"].inputs[0])
    for (x, y, w) in ((-1.6, 2.2, 0.25), (1.2, 2.4, 0.12), (-0.4, 2.8, 0.08), (2.4, -0.4, 0.2)):
        bpy.ops.mesh.primitive_plane_add(size=1, location=(x, y, 0.9))
        st = bpy.context.active_object
        st.scale = (w, 1, 1.6)
        st.rotation_euler = (math.radians(90), 0, math.atan2(-x, y))
        st.data.materials.append(strip)
        st.visible_camera = False
        st.visible_shadow = False
        st.name = "strip"
    cam_data = bpy.data.cameras.new("cam")
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.collection.objects.link(cam)
    scene.camera = cam
    return cam


def shoot(cam, objs, name, target, dist, elev, azim, lens=50, res=(640, 520)):
    scene = bpy.context.scene
    for o in bpy.data.objects:
        if o.type == "MESH" and o.name != "sweep" and not o.name.startswith("strip"):
            o.hide_render = o not in objs
    scene.render.resolution_x, scene.render.resolution_y = res
    cam.data.lens = lens
    e, a = math.radians(elev), math.radians(azim)
    t = Vector(target)
    cam.location = t + Vector((math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e))) * dist
    cam.rotation_euler = (t - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = str(PREVIEW / f"{name}.png")
    bpy.ops.render.render(write_still=True)
    return scene.render.filepath


# Sheet panels (main view boxes in the 1536 x 1024 reference) and the matching camera for each prop.
PANELS = {
    "armchair": ((12, 36, 260, 240), dict(target=(0, 0, 0.38), dist=2.6, elev=14, azim=-32)),
    "sofa": ((392, 36, 765, 165), dict(target=(0, 0, 0.36), dist=3.9, elev=10, azim=0)),
    "coffeeTable": ((775, 36, 1015, 240), dict(target=(0, 0, 0.22), dist=2.1, elev=22, azim=-12)),
    "brassTable": ((1160, 36, 1385, 240), dict(target=(0, 0, 0.29), dist=1.75, elev=20, azim=-12)),
}


def compare(name, render_path):
    try:
        from PIL import Image
    except Exception:
        return
    ref = Image.open(REFERENCE).convert("RGB")
    box, _ = PANELS[name]
    crop = ref.crop(box)
    mine = Image.open(render_path).convert("RGB")
    h = 420
    crop = crop.resize((int(crop.width * h / crop.height), h))
    mine = mine.resize((int(mine.width * h / mine.height), h))
    out = Image.new("RGB", (crop.width + mine.width + 10, h), (20, 20, 20))
    out.paste(crop, (0, 0))
    out.paste(mine, (crop.width + 10, 0))
    out.save(PREVIEW / f"cmp_{name}.jpg", quality=90)


# ---- main ----------------------------------------------------------------------------------------------------------------

def export(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    OUT.mkdir(parents=True, exist_ok=True)
    path = str(OUT / "props_furniture.glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_image_format="WEBP",
        export_image_quality=85,
        export_image_webp_fallback=False,
        export_normals=True,
        export_texcoords=True,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_lights=False,
        export_cameras=False,
    )
    print(f"EXPORTED {path}")


def main():
    clear_scene()
    p = palette()
    objs = {"armchair": prop_armchair(p), "sofa": prop_sofa(p), "coffeeTable": prop_coffee_table(p), "brassTable": prop_brass_table(p)}
    for name, o in objs.items():
        d = o.dimensions
        print(f"PROP {name} tris={tris(o)} dims=({d.x:.2f} x {d.z:.2f} x {d.y:.2f}) mats={[m.name for m in o.data.materials]}")
    export(list(objs.values()))
    if PREVIEW:
        PREVIEW.mkdir(parents=True, exist_ok=True)
        cam = studio()
        for name, o in objs.items():
            path = shoot(cam, [o], name, **PANELS[name][1])
            if REFERENCE:
                compare(name, path)


if __name__ == "__main__":
    main()
