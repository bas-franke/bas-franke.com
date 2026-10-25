"""
Builds the Last Light props (props.glb) in Blender: weapon locker, hanging lamp, barricade board, frag grenade,
chain-link fence section and a dead tree.

    blender --background --factory-startup --python build_props.py -- <output-dir> [preview-dir]

Everything is procedural: modelled geometry plus textures painted with numpy (paint scratches and rust, wood grain,
bark fissures, a chain-link alpha mask) and turned into normal / roughness maps, embedded in the GLB.
Conventions the frontend relies on (models.ts prop(), world.ts):
  * Blender +Y is the front (glTF -Z). Each prop is one top-level object named locker, lamp, board, nade, fence, tree.
  * locker: 1 x 0.5 x 2 m, origin at the floor centre, open front; J-hooks on the front frame hold the displayed gun
    at 1.3 m, pegs inside at 1.2 m, amber indicator lamp on top (material Indicator).
  * lamp: origin at the bulb (material Bulb, swapped at runtime), cable 1 m up.
  * board: 1.9 (X) x 0.18 (Z) x 0.035 (Y, thickness), origin at the centre.
  * fence: one 2.5 m section along X, posts at x = +-1.25; userData.noMoonShadow (glTF extras) on the mesh.
  * tree: about 5.6 m tall, origin at the ground.
"""

import math
import random
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils import noise as mnoise

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = Path(ARGS[0]) if ARGS else Path("models/zombies")
PREVIEW = Path(ARGS[1]) if len(ARGS) > 1 else None


# ---- scene helpers ---------------------------------------------------------------------------------------------------

def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.curves, bpy.data.lights, bpy.data.cameras):
        for item in list(coll):
            if item.users == 0:
                coll.remove(item)


def activate(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_all(obj):
    activate(obj)
    bpy.ops.object.convert(target="MESH")
    return bpy.context.active_object


def smooth(obj, on=True):
    for p in obj.data.polygons:
        p.use_smooth = on
    return obj


def prim(kind, mat, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), bevel=0.0, segs=2, **kw):
    ops = {
        "cube": bpy.ops.mesh.primitive_cube_add,
        "cyl": bpy.ops.mesh.primitive_cylinder_add,
        "cone": bpy.ops.mesh.primitive_cone_add,
        "sphere": bpy.ops.mesh.primitive_uv_sphere_add,
        "torus": bpy.ops.mesh.primitive_torus_add,
    }
    if kind == "cube":
        kw.setdefault("size", 1)
    ops[kind](location=loc, rotation=rot, **kw)
    obj = bpy.context.active_object
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    if bevel:
        m = obj.modifiers.new("Bevel", "BEVEL")
        m.width = bevel
        m.segments = segs
        m.limit_method = "ANGLE"
    if kind in ("sphere", "torus", "cyl", "cone"):
        smooth(obj)
        if kind in ("cyl", "cone"):
            m = obj.modifiers.new("Split", "EDGE_SPLIT")
            m.split_angle = math.radians(40)
    return obj


def box(size, loc, mat, rot=(0, 0, 0), bevel=0.003):
    return prim("cube", mat, loc=loc, rot=rot, scale=size, bevel=bevel)


def cyl(r, depth, loc, mat, rot=(0, 0, 0), verts=12):
    return prim("cyl", mat, loc=loc, rot=rot, radius=r, depth=depth, vertices=verts)


def join(objs, name):
    objs = [apply_all(o) for o in objs]
    activate(objs[0])
    for o in objs[1:]:
        o.select_set(True)
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = name
    return obj


def set_origin(obj, point):
    d = Vector(point) - obj.location
    obj.data.transform(Matrix.Translation(-d))
    obj.location = Vector(point)


def mesh_obj(name, verts, faces, mat, uvs=None, smooth_shade=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    if isinstance(mat, (list, tuple)):
        for m in mat:
            me.materials.append(m)
    else:
        me.materials.append(mat)
    if uvs is not None:
        layer = me.uv_layers.new(name="UVMap")
        for loop in me.loops:
            layer.data[loop.index].uv = uvs[loop.vertex_index]
    smooth(obj, smooth_shade)
    return obj


def tris(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def displace(obj, strength, scale, coords="GLOBAL", levels=0, name="Disp", kind="CLOUDS"):
    if levels:
        sub = obj.modifiers.new("Sub", "SUBSURF")
        sub.subdivision_type = "SIMPLE"
        sub.levels = levels
        sub.render_levels = levels
    key = f"{name}{kind}{scale}"
    tex = bpy.data.textures.get(key) or bpy.data.textures.new(key, kind)
    tex.use_fake_user = True
    tex.noise_scale = scale
    if kind == "CLOUDS":
        tex.noise_depth = 2
    d = obj.modifiers.new(name, "DISPLACE")
    d.texture = tex
    d.strength = strength
    d.texture_coords = coords
    d.mid_level = 0.5
    return obj


def box_uv(obj, per_metre=1.0, offset=(0.0, 0.0, 0.0)):
    """World-ish box projection: each face takes the two axes it is not facing. Fine for boxy props."""
    me = obj.data
    layer = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
    ox, oy, oz = offset
    for poly in me.polygons:
        n = poly.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            x, y, z = co.x + ox, co.y + oy, co.z + oz
            if ax == 0:
                uv = (y, z)
            elif ax == 1:
                uv = (x, z)
            else:
                uv = (x, y)
            layer.data[li].uv = (uv[0] * per_metre, uv[1] * per_metre)


def grime(obj, dirt=0.35, low=0.5, seed=0.0, scale=4.0):
    """Vertex colour that multiplies the material: dirt blotches, darker towards the floor (fake ambient occlusion)."""
    attr = obj.data.color_attributes.new(name="Col", type="BYTE_COLOR", domain="POINT")
    for v in obj.data.vertices:
        p = obj.matrix_world @ v.co
        n = mnoise.noise(Vector((p.x * scale + seed, p.y * scale, p.z * scale)))
        d = 1.0 - dirt * (0.5 + 0.5 * n) - low * max(0.0, 0.35 - p.z) * 1.2
        d = max(0.25, min(1.0, d))
        attr.data[v.index].color = (d, d, d, 1.0)
    obj.data.color_attributes.active_color = attr
    return obj


# ---- tubes (wires, branches, cables) ---------------------------------------------------------------------------------

def tube_geometry(points, radii, sides, uv_tile=0.3, cap_end=True, cap_start=False):
    """Rings along a polyline with parallel-transport frames. UVs: u around (repeats by circumference), v along."""
    pts = [Vector(p) for p in points]
    n = len(pts)
    tangents = []
    for i in range(n):
        a = pts[max(0, i - 1)]
        b = pts[min(n - 1, i + 1)]
        tangents.append((b - a).normalized())
    t0 = tangents[0]
    ref = Vector((0, 0, 1)) if abs(t0.z) < 0.9 else Vector((1, 0, 0))
    normal = t0.cross(ref).normalized()
    verts, faces, uvs = [], [], []
    rep = max(1, round(2 * math.pi * radii[0] / uv_tile))
    length = 0.0
    prev_t = t0
    for i in range(n):
        t = tangents[i]
        # Parallel transport the normal.
        axis = prev_t.cross(t)
        if axis.length > 1e-6:
            ang = prev_t.angle(t)
            normal = (Matrix.Rotation(ang, 3, axis.normalized()) @ normal).normalized()
        prev_t = t
        binormal = t.cross(normal).normalized()
        if i > 0:
            length += (pts[i] - pts[i - 1]).length
        for k in range(sides + 1):
            a = 2 * math.pi * k / sides
            off = normal * math.cos(a) + binormal * math.sin(a)
            verts.append(pts[i] + off * radii[i])
            uvs.append((k / sides * rep, length / uv_tile))
    ring = sides + 1
    for i in range(n - 1):
        for k in range(sides):
            a = i * ring + k
            faces.append((a, a + 1, a + 1 + ring, a + ring))
    if cap_end:
        tip = len(verts)
        verts.append(pts[-1] + tangents[-1] * radii[-1] * 0.8)
        uvs.append((0.5 * rep, (length + radii[-1]) / uv_tile))
        base = (n - 1) * ring
        for k in range(sides):
            faces.append((base + k, base + k + 1, tip))
    if cap_start:
        c = len(verts)
        verts.append(pts[0])
        uvs.append((0, 0))
        for k in range(sides):
            faces.append((k + 1, k, c))
    return verts, faces, uvs


def tubes_obj(name, paths, mat, uv_tile=0.3, smooth_shade=True):
    """paths: list of (points, radii, sides, cap_end)."""
    V, F, U = [], [], []
    for pts, radii, sides, cap in paths:
        v, f, u = tube_geometry(pts, radii, sides, uv_tile, cap_end=cap)
        base = len(V)
        V += v
        U += u
        F += [tuple(i + base for i in face) for face in f]
    return mesh_obj(name, V, F, mat, uvs=U, smooth_shade=smooth_shade)


# ---- textures (numpy) ------------------------------------------------------------------------------------------------

def fnoise(h, w, beta=1.6, seed=0, stretch=(1.0, 1.0)):
    """Tileable fractal noise in 0..1 via FFT filtering. stretch>1 smooths that axis (x, y)."""
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


def lines(h, w, count, seed, length=(6, 50), angle_bias=None, width=1):
    """Random scratch lines as a 0..1 mask (wrapping)."""
    rng = np.random.default_rng(seed)
    m = np.zeros((h, w), dtype=np.float32)
    for _ in range(count):
        y0, x0 = rng.uniform(0, h), rng.uniform(0, w)
        a = rng.uniform(0, math.pi) if angle_bias is None else angle_bias + rng.normal(0, 0.35)
        ln = rng.uniform(*length)
        ts = np.linspace(0, ln, int(ln * 2) + 2)
        ys = (y0 + np.sin(a) * ts).astype(int) % h
        xs = (x0 + np.cos(a) * ts).astype(int) % w
        v = rng.uniform(0.5, 1.0)
        for o in range(width):
            m[(ys + o) % h, xs] = np.maximum(m[(ys + o) % h, xs], v)
    return m


def smear_down(mask, decay=0.985):
    """Rust streaks: every row takes the decayed max of the row above it (image rows go bottom-up, so 'down' is -1)."""
    out = mask.copy()
    for r in range(out.shape[0] - 2, -1, -1):
        out[r] = np.maximum(out[r], out[r + 1] * decay)
    return out


def image(name, rgba, fmt="JPEG", noncolor=False):
    h, w = rgba.shape[:2]
    if rgba.shape[2] == 3:
        rgba = np.concatenate([rgba, np.ones((h, w, 1))], axis=-1)
    img = bpy.data.images.new(name, w, h, alpha=(fmt == "PNG"), float_buffer=False)
    # Colour space first: changing it afterwards reloads the buffer and drops the pixels.
    if noncolor:
        img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(np.clip(rgba, 0, 1).astype(np.float32).ravel())
    img.file_format = fmt
    img.use_fake_user = True
    return img


def srgb(c):
    """Linear -> display values for painting albedo maps (images are stored as sRGB)."""
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def tex_material(name, albedo, rough_metal=None, normal=None, normal_strength=1.0, alpha_clip=False, double_sided=False, rough=0.6, metal=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_fake_user = True
    mat.use_nodes = True
    mat.use_backface_culling = not double_sided
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    col = nt.nodes.new("ShaderNodeTexImage")
    col.image = albedo
    nt.links.new(col.outputs["Color"], bsdf.inputs["Base Color"])
    if alpha_clip:
        rnd = nt.nodes.new("ShaderNodeMath")
        rnd.operation = "ROUND"
        nt.links.new(col.outputs["Alpha"], rnd.inputs[0])
        nt.links.new(rnd.outputs[0], bsdf.inputs["Alpha"])
    if rough_metal is not None:
        rm = nt.nodes.new("ShaderNodeTexImage")
        rm.image = rough_metal
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(rm.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    if normal is not None:
        nm = nt.nodes.new("ShaderNodeTexImage")
        nm.image = normal
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nmap.inputs["Strength"].default_value = normal_strength
        nt.links.new(nm.outputs["Color"], nmap.inputs["Color"])
        nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    mat.diffuse_color = (*albedo.pixels[0:3], 1.0)
    return mat


def plain(name, color, rough=0.6, metal=0.0, emission=None, strength=1.0, double_sided=False):
    mat = bpy.data.materials.new(name)
    mat.use_fake_user = True
    mat.use_nodes = True
    mat.use_backface_culling = not double_sided
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = strength
    mat.diffuse_color = (*color, 1.0)
    return mat


def orm(rough, metal):
    h, w = rough.shape
    return np.stack([np.ones((h, w)), rough, metal, np.ones((h, w))], axis=-1)


def paint_textures(size=512, base=(0.075, 0.105, 0.085), seed=1):
    """Chipped green paint over steel: scratches to bare metal, rust blotches with streaks, grime."""
    h = w = size
    tone = fnoise(h, w, 1.8, seed)
    grime_n = fnoise(h, w, 1.2, seed + 1, stretch=(1.0, 0.35))
    rust_seed = (fnoise(h, w, 2.2, seed + 2) > 0.72).astype(np.float32) * fnoise(h, w, 1.0, seed + 3)
    rust = np.clip(smear_down(rust_seed, 0.992) * 1.3, 0, 1)
    scratch = lines(h, w, 260, seed + 4, (4, 40), width=1) + lines(h, w, 40, seed + 5, (20, 120), angle_bias=1.45, width=1) * 0.8
    scratch = np.clip(scratch, 0, 1)
    chips = (fnoise(h, w, 1.0, seed + 6) > 0.86).astype(np.float32)
    bare = np.clip(scratch + chips, 0, 1)
    paint = np.array(base)[None, None, :] * (0.8 + 0.4 * tone[..., None]) * (0.75 + 0.25 * grime_n[..., None])
    steel = np.array((0.32, 0.31, 0.29))[None, None, :] * (0.8 + 0.3 * tone[..., None])
    rustc = np.array((0.16, 0.06, 0.025))[None, None, :] * (0.6 + 0.6 * fnoise(h, w, 0.8, seed + 7)[..., None])
    col = paint * (1 - bare[..., None]) + steel * bare[..., None]
    col = col * (1 - rust[..., None] * 0.9) + rustc * rust[..., None] * 0.9
    alb = srgb(col)
    rough = np.clip(0.5 + 0.15 * tone - 0.25 * bare + 0.4 * rust, 0.15, 1)
    metal = np.clip(bare * (1 - rust), 0, 1)
    hgt = 0.6 * fnoise(h, w, 2.0, seed + 8) - 0.5 * scratch - 0.35 * chips + 0.25 * rust
    return alb, orm(rough, metal), normal_from_height(hgt, 2.5)


def wood_textures(w=1024, h=128, seed=3, base=(0.2, 0.15, 0.105)):
    """Rough-sawn weathered plank: grain along u, knots, saw marks, a split near one end, nail rust."""
    v = np.linspace(0, 1, h, endpoint=False)[:, None]
    u = np.linspace(0, 1, w, endpoint=False)[None, :]
    warp = fnoise(h, w, 2.0, seed, stretch=(6.0, 1.0)) * 1.0
    rng = np.random.default_rng(seed)
    grain_phase = v * 26 + warp * 5
    # Knots bend the grain around them.
    for _ in range(3):
        ku, kv, kr = rng.uniform(0.1, 0.9), rng.uniform(0.2, 0.8), rng.uniform(0.012, 0.025)
        du = (u - ku) * (w / h) * 0.12
        dv = v - kv
        d = np.sqrt(du * du + dv * dv)
        grain_phase = grain_phase + 3.0 * np.exp(-((d / (kr * 3)) ** 2)) * np.sign(dv + 1e-6)
    rings = 0.5 + 0.5 * np.sin(grain_phase * math.pi * 2)
    rings = rings ** 3
    knots = np.zeros((h, w))
    rng2 = np.random.default_rng(seed + 9)
    for _ in range(3):
        ku, kv, kr = rng2.uniform(0.1, 0.9), rng2.uniform(0.25, 0.75), rng2.uniform(0.01, 0.02)
        du = (u - ku) * (w / h) * 0.12
        dv = v - kv
        d = np.sqrt(du * du + dv * dv)
        knots = np.maximum(knots, np.clip(1 - d / kr, 0, 1))
    fibre = fnoise(h, w, 1.0, seed + 1, stretch=(12.0, 1.0))
    saw = 0.5 + 0.5 * np.sin((u * w / h * 0.18 * 40 + v * 3) * math.pi * 2)
    weather = fnoise(h, w, 1.5, seed + 2, stretch=(3.0, 1.0))
    # Split: a dark crack along u near the right end.
    crack = np.exp(-((v - 0.55 - 0.08 * fnoise(h, w, 2.0, seed + 4, stretch=(5, 1))) / 0.012) ** 2) * np.clip((u - 0.82) / 0.05, 0, 1)
    # Rust from the nails at both ends.
    rust = np.zeros((h, w))
    for nu in (0.05, 0.95):
        for nv in (0.25, 0.75):
            d = np.sqrt(((u - nu) * w / h * 0.5) ** 2 + (v - nv) ** 2)
            rust = np.maximum(rust, np.clip(1 - d / 0.12, 0, 1) ** 2)
    col = np.array(base)[None, None, :] * (0.65 + 0.35 * rings[..., None]) * (0.8 + 0.3 * fibre[..., None])
    grey = np.array((0.19, 0.18, 0.17))[None, None, :]
    col = col * (1 - 0.55 * weather[..., None]) + grey * 0.55 * weather[..., None] * (0.7 + 0.3 * fibre[..., None])
    col = col * (1 - 0.7 * knots[..., None]) + np.array((0.05, 0.035, 0.02)) * 0.7 * knots[..., None]
    col = col * (1 - crack[..., None] * 0.9)
    col = col * (1 - rust[..., None] * 0.5) + np.array((0.14, 0.05, 0.02)) * rust[..., None] * 0.5
    col *= 0.85 + 0.15 * saw[..., None]
    hgt = 0.5 * rings + 0.3 * fibre + 0.15 * saw - 0.8 * crack - 0.3 * knots
    rough = np.clip(0.82 + 0.1 * fibre - 0.15 * knots, 0, 1)
    return srgb(col), orm(rough, np.zeros_like(rough)), normal_from_height(hgt, 3.0)


def bark_textures(size=512, seed=5):
    """Deep vertical fissures (v runs along the branch), grey ridges, a little lichen."""
    h = w = size
    a = fnoise(h, w, 1.7, seed, stretch=(1.0, 5.0))
    b = fnoise(h, w, 2.0, seed + 1, stretch=(1.0, 2.5))
    ridge = 1 - np.abs(a * 2 - 1)
    ridge = ridge ** 2.2
    plates = (np.abs(np.sin(b * 18)) > 0.15).astype(np.float32) * 0.15
    hgt = ridge * 0.8 + plates + 0.2 * fnoise(h, w, 1.0, seed + 2)
    lichen = np.clip((fnoise(h, w, 2.4, seed + 3) - 0.7) * 4, 0, 1) * ridge
    col = np.array((0.055, 0.048, 0.042))[None, None, :] * (0.4 + 1.0 * hgt[..., None])
    col = col * (1 - lichen[..., None] * 0.6) + np.array((0.12, 0.13, 0.1)) * lichen[..., None] * 0.6
    rough = np.clip(0.95 - 0.1 * ridge, 0, 1)
    return srgb(col), orm(rough, np.zeros_like(rough)), normal_from_height(hgt, 6.0)


def chainlink_texture(size=512, diamonds=8, seed=7):
    """Galvanised chain-link mesh with alpha: two sets of diagonal wires with a woven bend, rust in patches."""
    h = w = size
    y, x = np.mgrid[0:h, 0:w] / size * diamonds
    d1 = (x + y) % 1.0
    d2 = (x - y) % 1.0
    width = 0.07
    w1 = np.clip(1 - np.abs(d1 - 0.5) / width, 0, 1)
    w2 = np.clip(1 - np.abs(d2 - 0.5) / width, 0, 1)
    # Weave: alternate which wire is on top at crossings.
    over = ((np.floor(x + y) + np.floor(x - y)) % 2 == 0)
    prof = np.where(over, np.maximum(w1, w2 * 0.85), np.maximum(w2, w1 * 0.85))
    alpha = (prof > 0.05).astype(np.float32)
    rust = np.clip((fnoise(h, w, 1.6, seed) - 0.6) * 3, 0, 1)
    col = np.array((0.36, 0.36, 0.34))[None, None, :] * (0.55 + 0.45 * prof[..., None])
    col = col * (1 - rust[..., None] * 0.8) + np.array((0.17, 0.07, 0.03)) * rust[..., None] * 0.8
    rgba = np.concatenate([srgb(col), alpha[..., None]], axis=-1)
    hgt = np.sqrt(np.clip(prof, 0, 1))
    rough = np.clip(0.45 + 0.4 * rust, 0, 1)
    return rgba, orm(rough, np.clip(0.85 - rust, 0, 1)), normal_from_height(hgt, 4.0)


def enamel_texture(size=256, seed=9):
    h = w = size
    chips = (fnoise(h, w, 1.1, seed) > 0.78).astype(np.float32)
    tone = fnoise(h, w, 1.6, seed + 1)
    dust = fnoise(h, w, 1.0, seed + 2)
    col = np.array((0.05, 0.085, 0.07))[None, None, :] * (0.85 + 0.3 * tone[..., None])
    col = col * (1 - chips[..., None]) + np.array((0.09, 0.04, 0.02)) * chips[..., None]
    col = col * (1 - 0.3 * dust[..., None]) + np.array((0.12, 0.11, 0.1)) * 0.3 * dust[..., None]
    rough = np.clip(0.3 + 0.25 * dust + 0.5 * chips, 0, 1)
    hgt = -chips * 0.6 + 0.1 * tone
    return srgb(col), orm(rough, chips * 0.2), normal_from_height(hgt, 2.0)


# ---- materials ---------------------------------------------------------------------------------------------------------

def palette():
    p = {}
    alb, rm, nrm = paint_textures(512)
    p["paint"] = tex_material("LockerPaint", image("locker_albedo", alb), image("locker_rm", rm, noncolor=True), image("locker_n", nrm, noncolor=True), 1.0)
    p["inside"] = plain("LockerInside", (0.03, 0.035, 0.032), rough=0.8, metal=0.3)
    alb, rm, nrm = wood_textures()
    p["plank"] = tex_material("Plank", image("plank_albedo", alb), image("plank_rm", rm, noncolor=True), image("plank_n", nrm, noncolor=True), 1.2)
    alb, rm, nrm = bark_textures()
    p["bark"] = tex_material("Bark", image("bark_albedo", alb), image("bark_rm", rm, noncolor=True), image("bark_n", nrm, noncolor=True), 1.6)
    rgba, rm, nrm = chainlink_texture()
    p["chainlink"] = tex_material("ChainLink", image("chainlink_albedo", rgba, fmt="PNG"), image("chainlink_rm", rm, noncolor=True), image("chainlink_n", nrm, noncolor=True), 1.0, alpha_clip=True, double_sided=True)
    alb, rm, nrm = enamel_texture()
    p["enamel"] = tex_material("Enamel", image("enamel_albedo", alb), image("enamel_rm", rm, noncolor=True), image("enamel_n", nrm, noncolor=True), 1.0, double_sided=True)
    p["enamel_in"] = plain("EnamelInner", (0.55, 0.52, 0.45), rough=0.35)
    p["bulb"] = plain("Bulb", (1.0, 0.85, 0.6), emission=(1.0, 0.72, 0.42), strength=12.0)
    p["indicator"] = plain("Indicator", (1.0, 0.55, 0.15), emission=(1.0, 0.45, 0.1), strength=6.0)
    p["bakelite"] = plain("Bakelite", (0.02, 0.016, 0.014), rough=0.35)
    p["cable"] = plain("Cable", (0.015, 0.015, 0.015), rough=0.55)
    p["steel"] = plain("PropSteel", (0.3, 0.3, 0.29), rough=0.45, metal=0.9)
    p["brass"] = plain("Brass", (0.35, 0.25, 0.1), rough=0.4, metal=0.9)
    p["nail"] = plain("Nail", (0.16, 0.14, 0.12), rough=0.6, metal=0.85)
    p["olive"] = plain("NadeOlive", (0.075, 0.085, 0.045), rough=0.55, metal=0.15)
    p["yellow"] = plain("NadeYellow", (0.55, 0.42, 0.05), rough=0.6)
    p["fencesteel"] = plain("FenceSteel", (0.25, 0.25, 0.235), rough=0.55, metal=0.8)
    p["ammo"] = plain("AmmoCan", (0.06, 0.075, 0.04), rough=0.6, metal=0.3)
    p["stencil"] = plain("Stencil", (0.55, 0.52, 0.45), rough=0.8)
    return p


# ---- locker ------------------------------------------------------------------------------------------------------------

def louvres(x, y_from, y_to, z_from, rows, mat, face_x=None, face_y=None, tilt=0.5):
    """Pressed louvres: thin slanted lips stamped out of a panel."""
    parts = []
    for r in range(rows):
        z = z_from + r * 0.028
        if face_x is not None:
            parts.append(box((0.008, abs(y_to - y_from), 0.006), (x + face_x * 0.004, (y_from + y_to) / 2, z), mat, rot=(0, -face_x * tilt, 0), bevel=0.0015))
        else:
            parts.append(box((abs(y_to - y_from), 0.008, 0.006), ((y_from + y_to) / 2, x + face_y * 0.004, z), mat, rot=(face_y * tilt, 0, 0), bevel=0.0015))
    return parts


def stencil(text, size, loc, rot, mat):
    bpy.ops.object.text_add(location=loc, rotation=rot)
    t = bpy.context.active_object
    t.data.body = text
    t.data.size = size
    t.data.align_x = "CENTER"
    t.data.align_y = "CENTER"
    t.data.materials.append(mat)
    return apply_all(t)


def prop_locker(p):
    paint = p["paint"]
    parts = []
    T = 0.022
    # Carcass: back, sides, top, base plinth, front frame (open front facing +Y).
    back = box((1.0, T, 2.0), (0, -0.25 + T / 2, 1.0), paint)
    left = box((T, 0.5, 2.0), (-0.5 + T / 2, 0, 1.0), paint)
    right = box((T, 0.5, 2.0), (0.5 - T / 2, 0, 1.0), paint)
    top = box((1.0, 0.5, T), (0, 0, 2.0 - T / 2), paint)
    base = box((1.0, 0.46, 0.1), (0, -0.01, 0.05), paint)
    floor = box((0.96, 0.46, T), (0, 0, 0.1 + T / 2), paint)
    for o in (left, right, top):
        displace(o, 0.006, 0.35, levels=2)
    parts += [back, left, right, top, base, floor]
    # Front frame: stiles and header with a rolled lip.
    parts.append(box((0.05, 0.03, 1.9), (-0.475, 0.235, 1.05), paint))
    parts.append(box((0.05, 0.03, 1.9), (0.475, 0.235, 1.05), paint))
    parts.append(box((1.0, 0.03, 0.16), (0, 0.235, 1.92), paint))
    parts.append(box((1.0, 0.03, 0.05), (0, 0.235, 0.125), paint))
    # Inside: darker, a pegboard back, a hat shelf, a shelf with ammo cans.
    parts.append(box((0.93, 0.004, 1.6), (0, -0.236, 1.0), p["inside"], bevel=0))
    parts.append(box((0.94, 0.42, 0.015), (0, 0.0, 1.66), paint))
    parts.append(box((0.94, 0.42, 0.015), (0, 0.0, 0.55), paint))
    for i, (x, dz) in enumerate(((-0.25, 0.0), (0.02, 0.0), (0.22, 0.0), (-0.1, 0.15))):
        can = box((0.24, 0.12, 0.15), (x, -0.08 + (i % 2) * 0.05, 0.635 + dz), p["ammo"], rot=(0, 0, random.uniform(-0.2, 0.2)), bevel=0.006)
        parts.append(can)
        parts.append(box((0.05, 0.02, 0.012), (x, -0.08 + (i % 2) * 0.05, 0.72 + dz), p["steel"], bevel=0.003))
    for x in (-0.25, 0.25):
        parts.append(cyl(0.007, 0.12, (x, -0.17, 1.2), p["steel"], rot=(math.radians(90), 0, 0), verts=8))
    # Front J-hooks that carry the displayed gun at 1.3 m.
    for x in (-0.3, 0.3):
        hook = [(x, 0.25, 1.24), (x, 0.33, 1.24), (x, 0.365, 1.255), (x, 0.37, 1.29)]
        parts.append(tubes_obj("hook", [(hook, [0.006] * 4, 6, True)], p["steel"]))
    # Side louvres near the top and bottom of both sides.
    for sx in (-1, 1):
        for zf in (1.72, 0.25):
            parts += louvres(sx * 0.5, -0.12, 0.12, zf, 5, paint, face_x=sx)
    # Door: hinged on the right stile, swung far open so it rests against the wall beside the locker.
    door_parts = [box((0.47, 0.022, 1.82), (0.235, 0, 0), paint)]
    displace(door_parts[0], 0.008, 0.3, levels=2)
    door_parts += louvres(0.012, 0.08, 0.39, 0.62, 5, paint, face_y=1)
    door_parts += louvres(0.012, 0.08, 0.39, -0.78, 5, paint, face_y=1)
    door_parts.append(box((0.025, 0.03, 0.14), (0.42, 0.02, 0.05), p["steel"], bevel=0.006))
    door_parts.append(stencil("13", 0.11, (0.235, 0.0125, 0.32), (math.radians(90), 0, math.radians(180)), p["stencil"]))
    door = join(door_parts, "door")
    door.location = (0.5, 0.25, 1.04)
    door.rotation_euler = (0, 0, math.radians(158))
    parts.append(door)
    for z in (0.35, 1.04, 1.7):
        parts.append(cyl(0.01, 0.09, (0.495, 0.255, z), p["steel"], verts=10))
    # Hasp on the left stile with an open padlock hanging from it.
    parts.append(box((0.06, 0.012, 0.03), (-0.47, 0.255, 1.05), p["steel"], bevel=0.003))
    parts.append(prim("torus", p["steel"], loc=(-0.455, 0.265, 1.04), rot=(0, math.radians(90), 0), major_radius=0.012, minor_radius=0.003, major_segments=12, minor_segments=6))
    lock = box((0.045, 0.02, 0.05), (-0.455, 0.27, 0.995), p["brass"], rot=(0, 0.25, 0), bevel=0.006)
    parts.append(lock)
    shackle = [(-0.468, 0.27, 1.018), (-0.47, 0.27, 1.045), (-0.455, 0.27, 1.058), (-0.44, 0.27, 1.045), (-0.44, 0.27, 1.03)]
    parts.append(tubes_obj("shackle", [(shackle, [0.004] * 5, 6, True)], p["steel"]))
    # Stencilled number on the header, a riveted plate and the indicator lamp in a little cage.
    parts.append(stencil("LOCKER 13", 0.055, (0, 0.2515, 1.93), (math.radians(90), 0, math.radians(180)), p["stencil"]))
    for x in (-0.44, 0.44):
        for z in (1.87, 1.97):
            parts.append(prim("sphere", p["steel"], loc=(x, 0.251, z), radius=0.006, segments=8, ring_count=5))
    parts.append(cyl(0.04, 0.025, (0, 0.17, 2.012), p["steel"], verts=14))
    parts.append(prim("sphere", p["indicator"], loc=(0, 0.17, 2.045), radius=0.028, segments=14, ring_count=9))
    cage = []
    for k in range(4):
        a = k * math.pi / 2 + math.pi / 4
        cage.append(([(0.036 * math.cos(a), 0.17 + 0.036 * math.sin(a), 2.022), (0.034 * math.cos(a), 0.17 + 0.034 * math.sin(a), 2.06), (0, 0.17, 2.08)], [0.0025] * 3, 4, False))
    parts.append(tubes_obj("cage", cage, p["steel"]))
    obj = join(parts, "locker")
    box_uv(obj, per_metre=1.0)
    set_origin(obj, (0, 0, 0))
    grime(obj, dirt=0.35, low=0.6, seed=1.3)
    return obj


# ---- lamp ---------------------------------------------------------------------------------------------------------------

def revolve(name, profile, segments, mat, uv_rep=3.0):
    """Surface of revolution around Z from (r, z) pairs; u around, v along the profile."""
    verts, faces, uvs = [], [], []
    acc = [0.0]
    for i in range(1, len(profile)):
        acc.append(acc[-1] + math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]))
    for i, (r, z) in enumerate(profile):
        for k in range(segments + 1):
            a = 2 * math.pi * k / segments
            verts.append((r * math.cos(a), r * math.sin(a), z))
            uvs.append((k / segments * uv_rep, acc[i] * 4))
    ring = segments + 1
    for i in range(len(profile) - 1):
        for k in range(segments):
            a = i * ring + k
            faces.append((a, a + ring, a + ring + 1, a + 1))
    return mesh_obj(name, verts, faces, mat, uvs=uvs)


def prop_lamp(p):
    parts = []
    # Pear-shaped bulb at the origin with its neck going up into the socket.
    bulb = revolve("bulb", [(0.0, -0.036), (0.016, -0.033), (0.029, -0.022), (0.034, -0.004), (0.031, 0.014), (0.02, 0.03), (0.013, 0.042), (0.013, 0.05)], 18, p["bulb"])
    parts.append(bulb)
    parts.append(revolve("socket", [(0.016, 0.048), (0.018, 0.052), (0.018, 0.062), (0.0185, 0.066), (0.018, 0.07), (0.0185, 0.074), (0.018, 0.078), (0.02, 0.09), (0.02, 0.1)], 14, p["bakelite"]))
    # Enamel shade: outer green enamel, inner off-white reflector, a rolled rim.
    prof = [(0.05, 0.11), (0.06, 0.1), (0.1, 0.075), (0.15, 0.045), (0.19, 0.018), (0.212, -0.004)]
    parts.append(revolve("shade", prof, 36, p["enamel"]))
    inner = revolve("shade_in", [(r - 0.003, z - 0.003) for r, z in reversed(prof)], 36, p["enamel_in"])
    parts.append(inner)
    parts.append(prim("torus", p["enamel"], loc=(0, 0, -0.006), major_radius=0.212, minor_radius=0.0045, major_segments=36, minor_segments=6))
    parts.append(revolve("collar", [(0.0, 0.135), (0.03, 0.135), (0.034, 0.128), (0.034, 0.112), (0.05, 0.11)], 16, p["steel"]))
    # Wire guard under the bulb.
    paths = []
    for k in range(6):
        a = k * math.pi / 3
        pts = []
        for s in range(7):
            t = s / 6
            r = 0.205 * (1 - t) ** 0.8 + 0.035 * t
            z = -0.006 - 0.15 * math.sin(t * math.pi / 2)
            pts.append((r * math.cos(a), r * math.sin(a), z))
        paths.append((pts, [0.0022] * len(pts), 4, False))
    rings = []
    for r, z in ((0.17, -0.06), (0.1, -0.12), (0.035, -0.156)):
        pts = [(r * math.cos(2 * math.pi * k / 20), r * math.sin(2 * math.pi * k / 20), z) for k in range(21)]
        rings.append((pts, [0.0022] * 21, 4, False))
    parts.append(tubes_obj("guard", paths + rings, p["steel"]))
    # Cable up to a ceiling rose 1 m above the bulb, a little slack and twist.
    cable = [(0.003 * math.sin(i), 0.003 * math.cos(i * 0.7), 0.135 + (1.0 - 0.135) * i / 12) for i in range(13)]
    parts.append(tubes_obj("cable", [(cable, [0.004] * 13, 6, False)], p["cable"]))
    parts.append(revolve("rose", [(0.0, 0.985), (0.035, 0.985), (0.045, 0.995), (0.045, 1.01)], 16, p["bakelite"]))
    obj = join(parts, "lamp")
    set_origin(obj, (0, 0, 0))
    return obj


# ---- board -------------------------------------------------------------------------------------------------------------

def prop_board(p):
    L, T, H = 1.9, 0.035, 0.18
    plank = box((L, T, H), (0, 0, 0), p["plank"], bevel=0.004)
    sub = plank.modifiers.new("Sub", "SUBSURF")
    sub.subdivision_type = "SIMPLE"
    sub.levels = 2
    plank = apply_all(plank)
    rng = random.Random(3)
    # Rough-sawn: a gentle twist and cup, grain ripples on the faces, ragged split ends.
    for v in plank.data.vertices:
        x, y, z = v.co
        t = x / L
        v.co.y += 0.004 * math.sin(t * 2.2) + 0.006 * (z / H) ** 2 + 0.0012 * mnoise.noise(Vector((x * 9, 0, z * 40)))
        if abs(x) > L / 2 - 0.012:
            v.co.x += math.copysign(1, x) * (0.012 * mnoise.noise(Vector((z * 30, y * 30, 1.7))) + 0.01 * rng.random())
    # UVs across the plank: u along X over the whole length, v across the face.
    me = plank.data
    layer = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        ax = max(range(3), key=lambda i: abs(poly.normal[i]))
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            u = (co.x + L / 2) / L
            vv = (co.z + H / 2) / H if ax != 2 else (co.y + T / 2) / T * 0.2
            if ax == 0:
                u, vv = (0.0 if co.x < 0 else 1.0) + co.y * 0.3, (co.z + H / 2) / H
            layer.data[li].uv = (u, vv)
    parts = [plank]
    # Nails: heads on the front face (+Y), one bent over and sticking out.
    for x in (-0.875, 0.875):
        for z in (-0.045, 0.045):
            xx = x + rng.uniform(-0.012, 0.012)
            zz = z + rng.uniform(-0.01, 0.01)
            parts.append(cyl(0.0055, 0.002, (xx, T / 2 + 0.006, zz), p["nail"], rot=(math.radians(90), 0, 0), verts=10))
    bent = [(0.89, T / 2 + 0.006, -0.045), (0.89, T / 2 + 0.03, -0.045), (0.895, T / 2 + 0.042, -0.035), (0.9, T / 2 + 0.046, -0.015)]
    parts.append(tubes_obj("bentnail", [(bent, [0.0022] * 4, 5, True)], p["nail"]))
    obj = join(parts, "board")
    set_origin(obj, (0, 0, 0))
    grime(obj, dirt=0.3, low=0.0, seed=2.1, scale=6)
    return obj


# ---- grenade -----------------------------------------------------------------------------------------------------------

def prop_nade(p):
    parts = []
    # M67: a smooth steel sphere about 64 mm across, fuse on top, the spoon down one side, the pin ring on the other.
    body = revolve("body", [(0.0, -0.032), (0.012, -0.0305), (0.022, -0.024), (0.029, -0.013), (0.0318, 0.0), (0.0305, 0.011), (0.025, 0.022), (0.016, 0.029), (0.011, 0.031)], 22, p["olive"])
    parts.append(body)
    parts.append(prim("torus", p["yellow"], loc=(0, 0, 0.009), major_radius=0.0306, minor_radius=0.0009, major_segments=24, minor_segments=4))
    parts.append(prim("torus", p["olive"], loc=(0, 0, -0.001), major_radius=0.0318, minor_radius=0.0006, major_segments=24, minor_segments=4))
    parts.append(revolve("fuse", [(0.0105, 0.03), (0.0105, 0.036), (0.0095, 0.04), (0.0095, 0.047), (0.0075, 0.05), (0.0, 0.052)], 12, p["steel"]))
    # Spoon: a curved flat strip hugging the body.
    spoon = []
    for k in range(7):
        t = k / 6
        a = math.radians(70) - t * math.radians(95)
        r = 0.0335 + 0.012 * (1 - t) ** 3
        spoon.append((r * math.cos(a), 0.0, 0.006 + r * math.sin(a) * 0.95 + 0.012 * (1 - t)))
    sp = tubes_obj("spoon", [(spoon, [0.0016] * len(spoon), 4, False)], p["olive"])
    sp.scale = (1, 4.0, 1)
    parts.append(sp)
    # Pin through the fuse and the ring.
    parts.append(cyl(0.0012, 0.026, (0, 0, 0.043), p["steel"], rot=(math.radians(90), 0, 0), verts=6))
    parts.append(prim("torus", p["steel"], loc=(-0.004, -0.024, 0.043), rot=(0, math.radians(90), math.radians(20)), major_radius=0.011, minor_radius=0.0011, major_segments=16, minor_segments=5))
    parts.append(box((0.003, 0.006, 0.012), (0.012, 0, 0.044), p["steel"], bevel=0.0005))
    obj = join(parts, "nade")
    set_origin(obj, (0, 0, 0))
    return obj


# ---- fence -------------------------------------------------------------------------------------------------------------

def prop_fence(p):
    rng = random.Random(11)
    parts = []
    posts = []
    for x in (-1.25, 1.25):
        lean = (rng.uniform(-0.05, 0.05), rng.uniform(-0.06, 0.06))
        pts = [(x + lean[0] * z, lean[1] * z, z) for z in (-0.05, 0.8, 1.6, 2.15)]
        posts.append((pts, [0.032, 0.031, 0.03, 0.03], 8, True))
        # Barbed-wire extension straight up from the post.
        top = Vector(pts[-1])
        ext = [tuple(top), tuple(top + Vector((lean[0] * 0.4, lean[1] * 0.4, 0.42)))]
        posts.append((ext, [0.012, 0.012], 5, True))
    parts.append(tubes_obj("posts", posts, p["fencesteel"]))
    # Top rail with a slight sag, bottom tension wire.
    rail = [(-1.25 + 2.5 * k / 6, 0.0, 2.1 - 0.025 * math.sin(math.pi * k / 6)) for k in range(7)]
    wire = [(-1.25 + 2.5 * k / 8, 0.0, 0.07 + 0.02 * math.sin(math.pi * k / 8)) for k in range(9)]
    strands = []
    for h in (2.24, 2.38, 2.52):
        pts = [(-1.25 + 2.5 * k / 16, 0.006 * math.sin(k * 1.7 + h * 9), h - 0.035 * math.sin(math.pi * k / 16) + 0.004 * math.sin(k * 2.3)) for k in range(17)]
        strands.append((pts, [0.0022] * len(pts), 3, False))
    parts.append(tubes_obj("rails", [(rail, [0.019] * 7, 7, False), (wire, [0.0035] * 9, 4, False)] + strands, p["fencesteel"]))
    # Barbs: little crossed spikes along the strands.
    barbs = []
    for h in (2.24, 2.38, 2.52):
        for k in range(1, 20):
            x = -1.25 + 2.5 * k / 20
            z = h - 0.035 * math.sin(math.pi * (k / 20))
            for a in (0.6, 2.2):
                d = Vector((math.cos(a) * 0.3, math.sin(a), math.cos(a + 1) * 0.7)).normalized() * 0.016
                c = Vector((x, 0, z))
                barbs.append(([tuple(c - d), tuple(c + d)], [0.0012, 0.0006], 3, False))
    parts.append(tubes_obj("barbs", barbs, p["fencesteel"], smooth_shade=False))
    # The mesh: one alpha-tested sheet, bulged and sagging, the bottom corner peeled out.
    nx, nz = 10, 8
    verts, faces, uvs = [], [], []
    for i in range(nx + 1):
        for k in range(nz + 1):
            x = -1.22 + 2.44 * i / nx
            z = 0.06 + 2.02 * k / nz
            y = 0.03 * math.sin(math.pi * i / nx) * math.sin(math.pi * k / nz) + 0.01 * mnoise.noise(Vector((x * 2, z * 2, 3.3)))
            if i >= nx - 2 and k <= 1:
                peel = (i - (nx - 2) + 1) / 3 * (1 - k)
                y -= 0.18 * peel
                z += 0.08 * peel
            verts.append((x, y, z))
            uvs.append(((x + 1.25) / 0.5, z / 0.5))
    for i in range(nx):
        for k in range(nz):
            a = i * (nz + 1) + k
            faces.append((a, a + nz + 1, a + nz + 2, a + 1))
    sheet = mesh_obj("sheet", verts, faces, p["chainlink"], uvs=uvs)
    parts.append(sheet)
    obj = join(parts, "fence")
    set_origin(obj, (0, 0, 0))
    grime(obj, dirt=0.3, low=0.4, seed=4.2)
    obj["noMoonShadow"] = True
    return obj


# ---- tree --------------------------------------------------------------------------------------------------------------

def prop_tree(p):
    rng = random.Random(23)
    paths = []

    def sides_for(r):
        return 12 if r > 0.12 else 8 if r > 0.05 else 6 if r > 0.022 else 4

    def branch(start, direction, length, r0, depth, broken=False):
        segs = max(3, int(length / 0.22))
        pts, radii = [Vector(start)], [r0]
        d = Vector(direction).normalized()
        pos = Vector(start)
        children = []
        for s in range(1, segs + 1):
            t = s / segs
            # Gnarl: wander, reach up early, droop towards the tip.
            d = (d + Vector((rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), rng.uniform(-0.12, 0.2) + (0.08 if t < 0.5 else -0.1)))).normalized()
            pos = pos + d * (length / segs)
            pts.append(pos.copy())
            bump = 1 + 0.12 * mnoise.noise(pos * 3)
            radii.append(max(0.006, r0 * (1 - t * (0.75 if not broken else 0.35)) * bump))
            if depth > 0 and 0.3 < t < 0.95 and rng.random() < 0.42:
                children.append((pos.copy(), d.copy(), radii[-1], t))
        sides = sides_for(r0)
        paths.append((pts, radii, sides, not broken))
        for cpos, cd, cr, t in children:
            side = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(0.0, 0.9))).normalized()
            nd = (cd * 0.4 + side).normalized()
            child_len = length * (1 - t) * rng.uniform(0.75, 1.15) + 0.25
            snap = depth == 2 and rng.random() < 0.25
            branch(cpos - cd * cr * 0.5, nd, child_len * (0.45 if snap else 1), cr * 0.72, depth - 1, broken=snap)

    branch((0, 0, -0.35), (0.08, 0.03, 1), 3.9, 0.26, 3)
    # Roots flaring out into the ground.
    for k in range(5):
        a = k * 2 * math.pi / 5 + rng.uniform(-0.3, 0.3)
        start = Vector((0.1 * math.cos(a), 0.1 * math.sin(a), 0.25))
        pts = [start + Vector((math.cos(a), math.sin(a), 0)) * (0.25 * s) + Vector((0, 0, -0.22 * s - 0.05 * s * s)) for s in range(6)]
        radii = [0.16 * (1 - s / 6) + 0.02 for s in range(6)]
        paths.append((pts, radii, 8, True))
    tree = tubes_obj("tree", paths, p["bark"], uv_tile=0.35)
    # Scale to ~5.6 m above the ground.
    zs = [v.co.z for v in tree.data.vertices]
    k = 5.6 / max(zs)
    tree.data.transform(Matrix.Scale(k, 4))
    grime(tree, dirt=0.25, low=0.4, seed=7.7, scale=1.5)
    tree.name = "tree"
    return tree


# ---- export and preview ------------------------------------------------------------------------------------------------

def export(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    OUT.mkdir(parents=True, exist_ok=True)
    path = str(OUT / "props.glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_image_format="WEBP",
        export_image_quality=82,
        export_image_webp_fallback=False,
        export_normals=True,
        export_texcoords=True,
        export_vertex_color="ACTIVE",
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_lights=False,
        export_cameras=False,
        export_extras=True,
    )
    print(f"EXPORTED {path}")


def render_preview(objs, name, target, dist, elev=10, azim=30, lens=50, res=(640, 640)):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.film_transparent = False
    world = bpy.data.worlds.get("PrevWorld") or bpy.data.worlds.new("PrevWorld")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.004, 0.005, 0.008, 1)
    scene.world = world
    scene.view_settings.view_transform = "AgX" if "AgX" in [i.identifier for i in scene.view_settings.bl_rna.properties["view_transform"].enum_items] else "Filmic"
    tgt = Vector(target)
    a, e = math.radians(azim), math.radians(elev)
    # Blender front is +Y: look at the prop from the front-right.
    cam_pos = tgt + Vector((math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e))) * dist
    cam = bpy.data.objects.new("PrevCam", bpy.data.cameras.new("PrevCam"))
    cam.data.lens = lens
    bpy.context.collection.objects.link(cam)
    cam.location = cam_pos
    cam.rotation_euler = (tgt - cam_pos).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    key = bpy.data.objects.new("Key", bpy.data.lights.new("Key", "SPOT"))
    key.data.energy = 300 * dist * dist / 4
    key.data.color = (1.0, 0.78, 0.55)
    key.data.spot_size = math.radians(70)
    key.data.shadow_soft_size = 0.15
    key.location = tgt + Vector((0.6, 1.2, 2.2)) * (dist / 2.5)
    key.rotation_euler = (tgt - key.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.collection.objects.link(key)
    fill = bpy.data.objects.new("Fill", bpy.data.lights.new("Fill", "AREA"))
    fill.data.energy = 25 * dist * dist / 4
    fill.data.color = (0.5, 0.62, 1.0)
    fill.data.size = 2
    fill.location = tgt + Vector((-2.0, 0.5, 0.8)) * (dist / 2.5)
    fill.rotation_euler = (tgt - fill.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.collection.objects.link(fill)
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, -0.001) if target[2] > 0.2 else (0, 0, -0.04))
    ground = bpy.context.active_object
    gm = bpy.data.materials.new("PrevGround")
    gm.use_nodes = True
    gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.03, 0.03, 0.03, 1)
    ground.data.materials.append(gm)
    for o in bpy.data.objects:
        o.hide_render = not (o in objs or o in (cam, key, fill, ground))
    scene.render.filepath = str(PREVIEW / f"{name}.png")
    bpy.ops.render.render(write_still=True)
    for o in (cam, key, fill, ground):
        bpy.data.objects.remove(o, do_unlink=True)
    for o in bpy.data.objects:
        o.hide_render = False
    print(f"PREVIEW {scene.render.filepath}")


def build_all():
    random.seed(1)
    clear_scene()
    p = palette()
    objs = {
        "locker": prop_locker(p),
        "lamp": prop_lamp(p),
        "board": prop_board(p),
        "nade": prop_nade(p),
        "fence": prop_fence(p),
        "tree": prop_tree(p),
    }
    for name, o in objs.items():
        print(f"PROP {name} tris={tris(o)} mats={[m.name for m in o.data.materials]}")
    if PREVIEW:
        PREVIEW.mkdir(parents=True, exist_ok=True)
        render_preview([objs["locker"]], "locker", (0, 0, 1.0), 3.2, elev=8, azim=28)
        render_preview([objs["locker"]], "locker_close", (-0.3, 0.2, 1.1), 1.2, elev=10, azim=-20)
        render_preview([objs["lamp"]], "lamp", (0, 0, 0.0), 0.9, elev=-12, azim=20)
        render_preview([objs["board"]], "board", (0.5, 0, 0), 0.9, elev=15, azim=20)
        render_preview([objs["nade"]], "nade", (0, 0, 0.01), 0.22, elev=12, azim=35)
        render_preview([objs["fence"]], "fence", (0, 0, 1.3), 3.6, elev=6, azim=20)
        render_preview([objs["tree"]], "tree", (0, 0, 2.8), 8.5, elev=6, azim=30)
    export(list(objs.values()))


if __name__ == "__main__":
    build_all()
