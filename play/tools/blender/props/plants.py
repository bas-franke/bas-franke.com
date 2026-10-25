"""
Last Light hotel plants, built in Blender and exported as props_plants.glb:

    blender --background --factory-startup --python plants.py -- <output-dir> [preview-dir]

  planterTree  a bushy ficus with glossy dark leaves in a dark speckled stone pot (~2.3 m)
  flowers      tall white blossom sprays (stock / orchid) in a clear glass cylinder with water (~1.25 m)
  flowersBowl  a tabletop arrangement of white flowers and long dark leaves in a polished brass bowl (~0.7 m)

Everything is procedural: leaves and petals are small bent meshes cut from one painted atlas (alpha-tested, glossy,
with a normal map), branches and stems are tubes along generated skeletons, pots and bowls are lathed profiles.
Each prop is an empty named as above with its meshes as children; origin at the floor (or table) centre, front +Y
(glTF -Z). Pass a preview folder to also render each prop in a studio scene like the reference sheet.
"""

import math
import random
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector

ARGS = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
OUT = Path(ARGS[0]) if ARGS else Path("models")
PREVIEW = Path(ARGS[1]) if len(ARGS) > 1 else None

UP = Vector((0, 0, 1))


# ---- scene ---------------------------------------------------------------------------------------------------------

def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)


# ---- textures ------------------------------------------------------------------------------------------------------

def srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def image(name, rgba, noncolor=False):
    h, w = rgba.shape[:2]
    if rgba.shape[2] == 3:
        rgba = np.concatenate([rgba, np.ones((h, w, 1))], axis=-1)
    img = bpy.data.images.new(name, w, h, alpha=True, float_buffer=False)
    if noncolor:
        img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(np.clip(rgba, 0, 1).astype(np.float32).ravel())
    img.file_format = "PNG"
    img.use_fake_user = True
    img.pack()
    return img


def value_noise(h, w, cells, rng):
    """Smooth noise in 0..1: random lattice, bilinearly interpolated."""
    g = rng.random((cells + 1, cells + 1))
    ys = np.linspace(0, cells, h, endpoint=False)
    xs = np.linspace(0, cells, w, endpoint=False)
    y0 = ys.astype(int)
    x0 = xs.astype(int)
    fy = (ys - y0)[:, None]
    fx = (xs - x0)[None, :]
    fy = fy * fy * (3 - 2 * fy)
    fx = fx * fx * (3 - 2 * fx)
    a = g[y0][:, x0]
    b = g[y0][:, x0 + 1]
    c = g[y0 + 1][:, x0]
    d = g[y0 + 1][:, x0 + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def fbm(h, w, rng, base=4, octaves=5):
    out = np.zeros((h, w))
    amp = 1.0
    tot = 0.0
    for o in range(octaves):
        out += value_noise(h, w, base * 2**o, rng) * amp
        tot += amp
        amp *= 0.5
    return out / tot


def normal_from_height(hgt, strength):
    dy, dx = np.gradient(hgt)
    n = np.dstack([-dx * strength, -dy * strength, np.ones_like(hgt)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return n * 0.5 + 0.5


# Atlas regions (u0, v0, u1, v1). Leaves run along +v in their region.
ATLAS = 1024
R_FICUS = [(0.0, 0.5, 0.25, 1.0), (0.25, 0.5, 0.5, 1.0), (0.0, 0.0, 0.25, 0.5), (0.25, 0.0, 0.5, 0.5)]
R_LONG = [(0.5, 0.0, 0.625, 1.0), (0.625, 0.0, 0.75, 1.0)]
R_PETAL = [(0.75, 0.75, 1.0, 1.0), (0.75, 0.5, 1.0, 0.75)]
R_BUD = (0.75, 0.25, 1.0, 0.5)
R_SEPAL = (0.75, 0.0, 1.0, 0.25)


def paint_atlas():
    rng = np.random.default_rng(7)
    S = ATLAS
    col = np.zeros((S, S, 3))
    alpha = np.zeros((S, S))
    hgt = np.zeros((S, S))
    rough = np.full((S, S), 0.5)
    grain = fbm(S, S, rng, base=16, octaves=4)

    def region(r):
        u0, v0, u1, v1 = r
        return int(v0 * S), int(v1 * S), int(u0 * S), int(u1 * S)

    def leaf(r, shape, c_base, c_light, c_rib, veins=9, vein_slope=0.45, gloss=0.28, seed=0):
        y0, y1, x0, x1 = region(r)
        hh, ww = y1 - y0, x1 - x0
        yy, xx = np.mgrid[0:hh, 0:ww]
        y = (yy + 0.5) / hh  # along the leaf
        x = ((xx + 0.5) / ww) * 2 - 1  # across
        y = y * 1.06 - 0.03
        hw = shape(np.clip(y, 0, 1)) * ((y >= 0) & (y <= 1))
        inside = np.abs(x) < hw
        a = np.clip((hw - np.abs(x)) * ww * 0.5, 0, 1) * inside
        xr = np.abs(x) / np.maximum(hw, 1e-3)
        rib = np.exp(-((x / 0.035) ** 2))
        s = y - vein_slope * np.abs(x)
        vein = np.exp(-(((s * veins) % 1.0 - 0.5) ** 2) / 0.004) * (xr < 0.92) * (y > 0.08)
        nloc = grain[y0:y1, x0:x1]
        t = np.clip(0.35 * xr + 0.25 * (1 - y) + 0.4 * (nloc - 0.5), 0, 1)
        c = c_base[None, None, :] * (1 - t[..., None]) + c_light[None, None, :] * t[..., None]
        c = c * (0.85 + 0.3 * nloc[..., None])
        c = c + (c_rib[None, None, :] - c) * (rib * 0.8 + vein * 0.25)[..., None]
        c = c * (1 - 0.25 * (xr > 0.93)[..., None])  # darker rim
        h = (1 - xr**2) * 0.6 - rib * 0.9 - vein * 0.25 + nloc * 0.1
        col[y0:y1, x0:x1] = np.where(inside[..., None], c, col[y0:y1, x0:x1])
        alpha[y0:y1, x0:x1] = np.maximum(alpha[y0:y1, x0:x1], a)
        hgt[y0:y1, x0:x1] = np.where(inside, h, hgt[y0:y1, x0:x1])
        rough[y0:y1, x0:x1] = np.where(inside, gloss + 0.15 * nloc, rough[y0:y1, x0:x1])

    def ficus(y):
        # Elliptic with a short drip tip.
        w = np.sin(np.pi * np.clip(y, 0, 1) ** 0.8) ** 0.85 * 0.92
        tip = np.clip((y - 0.82) / 0.18, 0, 1)
        return w * (1 - 0.55 * tip**1.5)

    def lance(y):
        return np.sin(np.pi * np.clip(y, 0, 1) ** 0.65) ** 1.2 * 0.95

    def petal(y):
        return np.sin(np.pi * np.clip(y, 0, 1) ** 0.75) ** 0.55 * 0.98

    def bud(y):
        return np.sin(np.pi * np.clip(y, 0, 1) ** 0.9) ** 0.8 * 0.9

    lin = lambda *v: np.array(v)
    leaf(R_FICUS[0], ficus, lin(0.022, 0.060, 0.012), lin(0.070, 0.140, 0.025), lin(0.09, 0.13, 0.04), veins=8)
    leaf(R_FICUS[1], ficus, lin(0.030, 0.075, 0.014), lin(0.110, 0.190, 0.035), lin(0.12, 0.16, 0.05), veins=8)
    leaf(R_FICUS[2], ficus, lin(0.014, 0.040, 0.010), lin(0.040, 0.090, 0.018), lin(0.07, 0.10, 0.03), veins=9)
    leaf(R_FICUS[3], ficus, lin(0.022, 0.060, 0.012), lin(0.070, 0.140, 0.030), lin(0.15, 0.20, 0.06), veins=7)
    leaf(R_LONG[0], lance, lin(0.010, 0.032, 0.010), lin(0.030, 0.075, 0.020), lin(0.06, 0.10, 0.035), veins=26, vein_slope=0.15)
    leaf(R_LONG[1], lance, lin(0.018, 0.050, 0.014), lin(0.045, 0.100, 0.025), lin(0.08, 0.13, 0.045), veins=26, vein_slope=0.15)
    leaf(R_PETAL[0], petal, lin(0.62, 0.60, 0.50), lin(0.80, 0.78, 0.68), lin(0.70, 0.70, 0.55), veins=14, vein_slope=0.05, gloss=0.45)
    leaf(R_PETAL[1], petal, lin(0.58, 0.58, 0.46), lin(0.76, 0.74, 0.62), lin(0.66, 0.68, 0.50), veins=12, vein_slope=0.05, gloss=0.45)
    leaf(R_BUD, bud, lin(0.30, 0.36, 0.16), lin(0.55, 0.58, 0.36), lin(0.25, 0.32, 0.12), veins=6, vein_slope=0.05, gloss=0.4)
    leaf(R_SEPAL, lance, lin(0.04, 0.10, 0.02), lin(0.10, 0.18, 0.05), lin(0.08, 0.14, 0.04), veins=10, vein_slope=0.2)
    # Petals: a green-yellow base where they join the flower.
    for r in R_PETAL:
        y0, y1, x0, x1 = region(r)
        yy = (np.arange(y1 - y0)[:, None] + 0.5) / (y1 - y0)
        base = np.clip(1 - yy / 0.18, 0, 1) ** 2
        col[y0:y1, x0:x1] = col[y0:y1, x0:x1] * (1 - base[..., None] * 0.6) + np.array([0.35, 0.40, 0.12]) * base[..., None] * 0.6

    rgba = np.concatenate([srgb(col), alpha[..., None]], axis=-1)
    albedo = image("plants_albedo", rgba)
    nrm = image("plants_normal", normal_from_height(hgt * 3.0, 6.0), noncolor=True)
    rm = np.dstack([np.ones_like(rough), rough, np.zeros_like(rough)])
    rmi = image("plants_rm", rm, noncolor=True)
    return albedo, nrm, rmi


def paint_stone():
    rng = np.random.default_rng(11)
    S = 512
    n1 = fbm(S, S, rng, base=6, octaves=5)
    n2 = fbm(S, S, rng, base=48, octaves=3)
    fleck = (rng.random((S, S)) > 0.985).astype(float) * rng.uniform(0.5, 1, (S, S))
    v = 0.022 + 0.018 * n1 + 0.01 * n2 + 0.05 * fleck
    col = np.dstack([v, v * 1.0, v * 1.04])
    albedo = image("stone_albedo", srgb(col))
    hgt = n2 * 0.6 + n1 * 0.4 + fleck * 0.3
    nrm = image("stone_normal", normal_from_height(hgt, 3.0), noncolor=True)
    rough = 0.34 + 0.25 * n1 - 0.1 * fleck
    rmi = image("stone_rm", np.dstack([np.ones_like(rough), rough, np.full_like(rough, 0.25)]), noncolor=True)
    return albedo, nrm, rmi


def paint_brass():
    rng = np.random.default_rng(5)
    S = 512
    # Brushed: noise stretched along u (around the bowl).
    streak = value_noise(S, 8, 256, rng)
    streak = np.repeat(streak, S // 8, axis=1)
    n = fbm(S, S, rng, base=5, octaves=4)
    base = np.array([0.80, 0.55, 0.22])
    col = base[None, None, :] * (0.9 + 0.15 * streak[..., None] + 0.08 * (n[..., None] - 0.5))
    albedo = image("brassbowl_albedo", srgb(col))
    rough = 0.12 + 0.08 * streak + 0.06 * n
    rmi = image("brassbowl_rm", np.dstack([np.ones_like(rough), rough, np.ones_like(rough)]), noncolor=True)
    return albedo, rmi


# ---- materials -----------------------------------------------------------------------------------------------------

def material(name, albedo=None, color=(0.5, 0.5, 0.5), rough=0.5, metal=0.0, normal=None, rm=None, alpha_clip=False, double=False, blend_alpha=None, nstrength=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_fake_user = True
    mat.use_nodes = True
    mat.use_backface_culling = not double
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if albedo is not None:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = albedo
        nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
        if alpha_clip:
            rnd = nt.nodes.new("ShaderNodeMath")
            rnd.operation = "ROUND"
            nt.links.new(t.outputs["Alpha"], rnd.inputs[0])
            nt.links.new(rnd.outputs[0], bsdf.inputs["Alpha"])
    if rm is not None:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = rm
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(t.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    if normal is not None:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = normal
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = nstrength
        nt.links.new(t.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    if blend_alpha is not None:
        bsdf.inputs["Alpha"].default_value = blend_alpha
        for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
            try:
                setattr(mat, attr, val)
            except Exception:
                pass
    return mat


# ---- mesh building -------------------------------------------------------------------------------------------------

class Builder:
    """Accumulates vertices, quads/tris and per-corner UVs, then makes one smooth-shaded object."""

    def __init__(self):
        self.verts = []
        self.faces = []
        self.uvs = []

    def add(self, pts, faces, uvs):
        base = len(self.verts)
        self.verts.extend(pts)
        for f, fu in zip(faces, uvs):
            self.faces.append([base + i for i in f])
            self.uvs.append(fu)

    def tris(self):
        return sum(len(f) - 2 for f in self.faces)

    def make(self, name, mat, parent, smooth=True):
        me = bpy.data.meshes.new(name)
        me.from_pydata([tuple(v) for v in self.verts], [], self.faces)
        uv = me.uv_layers.new(name="UVMap")
        k = 0
        for poly, fu in zip(me.polygons, self.uvs):
            for li, u in zip(poly.loop_indices, fu):
                uv.data[li].uv = u
            k += 1
        for p in me.polygons:
            p.use_smooth = smooth
        me.materials.append(mat)
        me.validate()
        ob = bpy.data.objects.new(name, me)
        bpy.context.collection.objects.link(ob)
        ob.parent = parent
        return ob


def frame(d, hint=UP):
    d = d.normalized()
    if abs(d.dot(hint)) > 0.95:
        hint = Vector((1, 0, 0))
    side = d.cross(hint).normalized()
    nrm = side.cross(d).normalized()
    return d, side, nrm


def leaf(b, base, d, length, width, region, roll=0.0, droop=0.25, fold=0.25, rows=3, cols=3, cup=0.0, nrm_hint=UP):
    """A bent quad strip: along `d`, folded at the midrib, drooping under gravity, optionally cupped."""
    d, side, nrm = frame(d, nrm_hint)
    if roll:
        rot = Matrix.Rotation(roll, 3, d)
        side = rot @ side
        nrm = rot @ nrm
    u0, v0, u1, v1 = region
    pts, uvs_v = [], []
    for r in range(rows + 1):
        y = r / rows
        for c in range(cols):
            x = c / (cols - 1) * 2 - 1
            p = base + d * (y * length) + side * (x * width * 0.5)
            p += nrm * (abs(x) * width * 0.5 * fold + cup * (1 - x * x) * -width * 0.25 + cup * y * y * length * 0.4)
            p += Vector((0, 0, -1)) * (y * y * length * droop)
            pts.append(p)
            uvs_v.append((u0 + (x + 1) * 0.5 * (u1 - u0), v0 + y * (v1 - v0)))
    faces, uvs = [], []
    for r in range(rows):
        for c in range(cols - 1):
            a = r * cols + c
            f = [a, a + 1, a + 1 + cols, a + cols]
            faces.append(f)
            uvs.append([uvs_v[i] for i in f])
    b.add(pts, faces, uvs)


def tube(b, pts, radii, sides=6, cap=False):
    rings = []
    n = len(pts)
    prev_side = None
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, n - 1)] - pts[max(i - 1, 0)]).normalized()
        if prev_side is None:
            _, side, _ = frame(t)
        else:
            side = (prev_side - t * prev_side.dot(t)).normalized()
        prev_side = side
        other = t.cross(side)
        ring = [p + (side * math.cos(a) + other * math.sin(a)) * radii[i] for a in (2 * math.pi * k / sides for k in range(sides))]
        rings.append(ring)
    verts = [v for r in rings for v in r]
    faces, uvs = [], []
    for i in range(n - 1):
        for k in range(sides):
            a = i * sides + k
            bb = i * sides + (k + 1) % sides
            f = [a, bb, bb + sides, a + sides]
            faces.append(f)
            uvs.append([(k / sides, i / (n - 1)), ((k + 1) / sides, i / (n - 1)), ((k + 1) / sides, (i + 1) / (n - 1)), (k / sides, (i + 1) / (n - 1))])
    if cap:
        tip = len(verts)
        verts.append(pts[-1] + (pts[-1] - pts[-2]).normalized() * radii[-1])
        for k in range(sides):
            a = (n - 1) * sides + k
            bb = (n - 1) * sides + (k + 1) % sides
            faces.append([a, bb, tip])
            uvs.append([(0, 1), (1, 1), (0.5, 1)])
    b.add(verts, faces, uvs)


def lathe(b, profile, segs=48, uv_v=None, lobes=0, lobe_amp=0.0, lobe_z=(0, 0)):
    """Revolves (r, z) points around z. Profile order sets the face winding: outside going up faces out."""
    n = len(profile)
    lens = [0.0]
    for i in range(1, n):
        lens.append(lens[-1] + math.dist(profile[i - 1], profile[i]))
    total = lens[-1] or 1
    verts = []
    for i, (r, z) in enumerate(profile):
        for k in range(segs):
            a = 2 * math.pi * k / segs
            rr = r
            if lobes and lobe_z[0] <= z <= lobe_z[1]:
                w = math.sin(math.pi * (z - lobe_z[0]) / (lobe_z[1] - lobe_z[0]))
                rr = r * (1 + lobe_amp * w * (0.5 + 0.5 * math.cos(lobes * a)) - lobe_amp * w * 0.5)
            verts.append(Vector((rr * math.cos(a), rr * math.sin(a), z)))
    faces, uvs = [], []
    for i in range(n - 1):
        for k in range(segs):
            a = i * segs + k
            bb = i * segs + (k + 1) % segs
            f = [a, bb, bb + segs, a + segs]
            faces.append(f)
            u0, u1 = k / segs, (k + 1) / segs
            va, vb = lens[i] / total, lens[i + 1] / total
            uvs.append([(u0, va), (u1, va), (u1, vb), (u0, vb)])
    b.add(verts, faces, uvs)


def bezier(p0, p1, p2, n):
    out = []
    for i in range(n):
        t = i / (n - 1)
        out.append(p0 * (1 - t) ** 2 + p1 * (2 * (1 - t) * t) + p2 * t * t)
    return out


def root(name):
    e = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(e)
    e.empty_display_size = 0.3
    return e


def tri_report(name, *builders):
    t = sum(b.tris() for b in builders)
    print(f"TRIS {name}: {t}")
    return t


# ---- props ---------------------------------------------------------------------------------------------------------

def blossom(b, center, out, size, rng, petals=4, layers=1, region=None, cup=0.35, tilt=0.45, rows=1):
    """Petals arranged around the outward axis, cupped up from the flower plane."""
    out = out.normalized()
    _, s, n = frame(out)
    for layer in range(layers):
        k = petals
        off = rng.random() * math.tau + layer * math.pi / k
        sz = size * (1 - 0.2 * layer)
        for i in range(k):
            a = off + i * math.tau / k
            dirp = (s * math.cos(a) + n * math.sin(a)) * math.cos(tilt + 0.25 * layer) + out * math.sin(tilt + 0.25 * layer)
            reg = region or R_PETAL[rng.integers(0, 2)]
            leaf(b, center + out * (0.002 + 0.003 * layer), dirp, sz, sz * 0.9, reg, roll=0.0, droop=-0.05, fold=-0.15, rows=rows, cols=3, cup=cup, nrm_hint=out)


def build_planter_tree(mats):
    rnd = random.Random(42)
    r = root("planterTree")
    pot = Builder()
    # Dark stone pot: rounded bottom, slight belly, thick rolled rim.
    lathe(pot, [(0.0, 0.0), (0.26, 0.0), (0.33, 0.03), (0.38, 0.12), (0.41, 0.30), (0.42, 0.50), (0.415, 0.62), (0.405, 0.655), (0.385, 0.66), (0.37, 0.64), (0.36, 0.60)], segs=48)
    pot.make("planterTree_pot", mats["stone"], r)
    soil = Builder()
    lathe(soil, [(0.362, 0.595), (0.25, 0.60), (0.1, 0.603), (0.0, 0.604)], segs=32)
    soil.make("planterTree_soil", mats["soil"], r)

    bark = Builder()
    leaves = Builder()
    # Crown: an ellipsoid the branches grow towards, starting low above the pot like the reference.
    C = Vector((0, 0, 1.6))
    RX, RZ = 0.8, 0.7
    lens = [0.40, 0.38, 0.30, 0.22, 0.16]
    rads = [0.03, 0.018, 0.011, 0.007, 0.0045]
    leafy = []

    def crown_target():
        while True:
            v = Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-0.55, 1)))
            if v.length <= 1:
                return C + Vector((v.x * RX, v.y * RX * 0.9, v.z * RZ)) * rnd.uniform(0.75, 1.0)

    def grow(p, d, depth):
        L = lens[depth] * rnd.uniform(0.85, 1.15)
        end = p + d * L
        mid = (p + end) * 0.5 + Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-0.3, 0.6))) * L * 0.08
        n = 4 if depth < 2 else 3
        pts = bezier(p, mid, end, n)
        tube(bark, pts, [rads[depth] * (1 - 0.3 * i / (n - 1)) for i in range(n)], sides=5 if depth < 2 else 4 if depth < 4 else 3)
        if depth >= 2:
            leafy.append((pts, d, depth))
        if depth == len(lens) - 1:
            return
        kids = rnd.choice([2, 3, 3]) if depth else 3
        off = rnd.uniform(0, math.tau)
        _, sd, nd = frame(d)
        for k in range(kids):
            a = off + k * math.tau / kids + rnd.uniform(-0.4, 0.4)
            perp = sd * math.cos(a) + nd * math.sin(a)
            spread = math.radians(rnd.uniform(28, 48))
            nd2 = (d * math.cos(spread) + perp * math.sin(spread))
            # A little upward pull keeps the crown domed instead of drooping, and keeps it inside an ellipsoid.
            nd2 += Vector((0, 0, 0.18))
            rel = end - C
            if (rel.x / RX) ** 2 + (rel.y / RX) ** 2 + (rel.z / RZ) ** 2 > 0.8:
                nd2 -= rel.normalized() * 0.5
            grow(end, nd2.normalized(), depth + 1)

    for i in range(4):
        a = i * math.tau / 4 + rnd.uniform(-0.35, 0.35)
        base = Vector((math.cos(a) * 0.05, math.sin(a) * 0.05, 0.585))
        d = Vector((math.cos(a) * 0.3, math.sin(a) * 0.3, 1)).normalized()
        grow(base, d, 0)

    count = 0
    for pts, d, depth in leafy:
        per = 2 if depth == 2 else 3 if depth == 3 else 4
        for j in range(per):
            t = rnd.uniform(0.1, 1.0)
            i = min(len(pts) - 2, int(t * (len(pts) - 1)))
            f = t * (len(pts) - 1) - i
            p = pts[i] * (1 - f) + pts[i + 1] * f
            outward = (p - Vector((0, 0, p.z - 0.25))).normalized()
            a = rnd.uniform(0, math.tau)
            ld = (d * 0.6 + outward * 0.5 + Vector((math.cos(a), math.sin(a), rnd.uniform(0.0, 0.9))) * 0.75).normalized()
            L = rnd.uniform(0.14, 0.20)
            leaf(leaves, p, ld, L, L * 0.42, R_FICUS[rnd.randrange(4)], roll=rnd.uniform(-0.7, 0.7), droop=rnd.uniform(0.2, 0.5), fold=0.25, rows=2, cols=3)
            count += 1
    print(f"planterTree: {len(leafy)} leafy twigs, {count} leaves")
    bark.make("planterTree_branches", mats["bark"], r)
    leaves.make("planterTree_leaves", mats["foliage"], r)
    tri_report("planterTree", pot, soil, bark, leaves)
    return r


def spray(stem_b, petal_b, p0, p1, tip, rng, blossoms=11, buds=4, size=0.024, radius=0.0035, petals=4):
    pts = bezier(p0, p1, tip, 7)
    tube(stem_b, pts, [radius] * len(pts), sides=4)
    # Blossoms climb the top part of the stem, smaller towards the tip, buds at the very end.
    n = blossoms + buds
    for i in range(n):
        t = 0.42 + 0.58 * (i / (n - 1))
        k = min(5, int(t * 6))
        f = t * 6 - k
        p = pts[k] * (1 - f) + pts[min(6, k + 1)] * f
        tang = (pts[min(6, k + 1)] - pts[k]).normalized()
        a = rng.random() * math.tau
        _, s, nn = frame(tang)
        out = (s * math.cos(a) + nn * math.sin(a)) * 0.85 + tang * 0.35
        if i < blossoms:
            sz = size * (1.0 - 0.35 * i / blossoms) * rng.uniform(0.85, 1.1)
            blossom(petal_b, p + out.normalized() * 0.006, out, sz, rng, petals=petals, layers=1, tilt=0.25, cup=0.25)
        else:
            sz = size * 0.55 * (1 - 0.15 * (i - blossoms))
            leaf(petal_b, p, (tang * 0.8 + out * 0.4).normalized(), sz, sz * 0.55, R_BUD, droop=-0.1, fold=0.6, rows=1, cols=3)


def build_flowers(mats):
    rng = np.random.default_rng(3)
    r = root("flowers")
    glass = Builder()
    H, R, T = 0.42, 0.095, 0.006
    lathe(glass, [(0.0, 0.0), (R - 0.004, 0.0), (R, 0.004), (R, H), (R - T, H), (R - T, 0.022), (0.0, 0.022)], segs=48)
    glass.make("flowers_vase", mats["glass"], r)
    water = Builder()
    lathe(water, [(0.0, 0.023), (R - T - 0.001, 0.023), (R - T - 0.001, 0.27), (0.0, 0.27)], segs=40)
    water.make("flowers_water", mats["water"], r)
    stems = Builder()
    petals = Builder()
    leaves = Builder()
    n = 22
    for i in range(n):
        a = i * 2.39996 + rng.uniform(-0.2, 0.2)
        rb = 0.055 * math.sqrt(rng.random())
        p0 = Vector((math.cos(a) * rb, math.sin(a) * rb, 0.03))
        m = Vector((math.cos(a) * 0.05, math.sin(a) * 0.05, H + 0.02))
        # A wide fan, tallest in the middle, like the reference.
        lean = 0.12 + 0.88 * math.sqrt(rng.random())
        horiz = 0.62 * lean
        top = 1.24 - 0.5 * lean**2 + rng.uniform(-0.04, 0.03)
        dirh = Vector((math.cos(a), math.sin(a) * 0.55, 0)).normalized()
        tip = Vector((dirh.x * horiz, dirh.y * horiz, top))
        p1 = m + dirh * horiz * 0.15 + Vector((0, 0, (top - H) * 0.55))
        spray(stems, petals, p0, p1, tip, rng, blossoms=int(rng.integers(11, 14)), buds=4, size=0.042 + 0.008 * rng.random(), petals=5)
    # A few narrow leaves where the stems leave the vase.
    for i in range(9):
        a = i * math.tau / 9 + rng.uniform(-0.2, 0.2)
        base = Vector((math.cos(a) * 0.05, math.sin(a) * 0.05, H + rng.uniform(0.02, 0.12)))
        d = Vector((math.cos(a) * 0.8, math.sin(a) * 0.8, 0.7)).normalized()
        L = rng.uniform(0.12, 0.18)
        leaf(leaves, base, d, L, 0.022, R_SEPAL, roll=rng.uniform(-0.5, 0.5), droop=0.5, fold=0.3, rows=3, cols=3)
    stems.make("flowers_stems", mats["stem"], r)
    petals.make("flowers_blossoms", mats["foliage"], r)
    leaves.make("flowers_leaves", mats["foliage"], r)
    tri_report("flowers", glass, water, stems, petals, leaves)
    return r


def build_flowers_bowl(mats):
    rng = np.random.default_rng(9)
    r = root("flowersBowl")
    bowl = Builder()
    lathe(
        bowl,
        [(0.0, 0.0), (0.085, 0.0), (0.10, 0.008), (0.098, 0.022), (0.09, 0.03), (0.13, 0.05), (0.175, 0.09), (0.197, 0.14), (0.197, 0.175), (0.185, 0.205), (0.17, 0.222), (0.172, 0.232), (0.163, 0.236), (0.155, 0.226), (0.15, 0.2), (0.0, 0.2)],
        segs=80,
        lobes=10,
        lobe_amp=0.06,
        lobe_z=(0.03, 0.2),
    )
    bowl.make("flowersBowl_bowl", mats["brass"], r)
    leaves = Builder()
    stems = Builder()
    petals = Builder()
    # Long dark leaves fanning out of the bowl, drooping over its rim.
    for i in range(52):
        a = i * 2.39996
        up = rng.uniform(0.05, 0.9)
        d = Vector((math.cos(a), math.sin(a) * 0.85, up)).normalized()
        base = Vector((math.cos(a) * 0.06, math.sin(a) * 0.06, 0.21))
        L = rng.uniform(0.17, 0.25)
        leaf(leaves, base, d, L, L * 0.4, R_FICUS[i % 4], roll=rng.uniform(-0.6, 0.6), droop=rng.uniform(0.3, 0.6), fold=0.3, rows=3, cols=3)
    # Big white flowers on a dome above the bowl.
    for i in range(22):
        a = i * 2.39996
        rr = 0.26 * math.sqrt((i + 0.5) / 22)
        p = Vector((math.cos(a) * rr, math.sin(a) * rr * 0.85, 0.30 + 0.2 * (1 - (rr / 0.26) ** 2) + rng.uniform(-0.02, 0.02)))
        out = (p - Vector((0, 0, 0.12))).normalized()
        tube(stems, [Vector((p.x * 0.2, p.y * 0.2, 0.2)), p * 0.6 + Vector((0, 0, 0.08)), p], [0.004] * 3, sides=5)
        blossom(petals, p, out, rng.uniform(0.042, 0.052), rng, petals=6, layers=2, cup=0.45, tilt=0.25)
        # A green heart.
        leaf(petals, p + out * 0.004, out, 0.014, 0.012, R_BUD, fold=0.8, droop=0, rows=1, cols=3)
    # Sprays of small blossoms reaching out like the reference.
    for i in range(9):
        a = i * math.tau / 9 + rng.uniform(-0.2, 0.2)
        p0 = Vector((math.cos(a) * 0.04, math.sin(a) * 0.04, 0.2))
        L = rng.uniform(0.2, 0.28)
        up = rng.uniform(0.35, 1.0)
        tip = Vector((math.cos(a) * L, math.sin(a) * L * 0.8, 0.3 + up * 0.28))
        p1 = (p0 + tip) * 0.5 + Vector((0, 0, 0.12))
        spray(stems, petals, p0, p1, tip, rng, blossoms=9, buds=4, size=0.026, radius=0.003)
    leaves.make("flowersBowl_leaves", mats["foliage"], r)
    stems.make("flowersBowl_stems", mats["stem"], r)
    petals.make("flowersBowl_flowers", mats["foliage"], r)
    tri_report("flowersBowl", bowl, leaves, stems, petals)
    return r


# ---- export and previews -------------------------------------------------------------------------------------------

def export(roots):
    bpy.ops.object.select_all(action="DESELECT")
    for r in roots:
        r.select_set(True)
        for c in r.children_recursive:
            c.select_set(True)
    bpy.context.view_layer.objects.active = roots[0]
    OUT.mkdir(parents=True, exist_ok=True)
    path = str(OUT / "props_plants.glb")
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


def setup_gpu(scene):
    scene.render.engine = "CYCLES"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for kind in ("OPTIX", "CUDA", "HIP"):
            try:
                prefs.compute_device_type = kind
                prefs.get_devices()
                gpus = [d for d in prefs.devices if d.type != "CPU"]
                if gpus:
                    for d in prefs.devices:
                        d.use = d.type != "CPU"
                    scene.cycles.device = "GPU"
                    print(f"GPU {kind}")
                    return
            except Exception:
                continue
    except Exception:
        pass


def studio(scene):
    """Dark charcoal sweep with a warm soft key and a rim, like the reference sheet."""
    world = bpy.data.worlds.new("Studio")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.018, 0.018, 0.019, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 1.0
    scene.world = world
    # Floor and back wall as one curved sweep.
    me = bpy.data.meshes.new("Sweep")
    verts, faces = [], []
    rows = 24
    for i in range(rows + 1):
        t = i / rows
        a = t * math.pi / 2
        y = -6 + 6 * t if t < 0 else 0
        if t < 0.5:
            yy, zz = 6 - 12 * t, 0.0
        else:
            q = (t - 0.5) / 0.5 * math.pi / 2
            yy, zz = -1.2 * math.sin(q) * 0 + (0 - 1.2 * math.sin(q)) - 0.0, 1.2 * (1 - math.cos(q))
        verts += [(-8, yy, zz), (8, yy, zz)]
        if i:
            faces.append([2 * (i - 1), 2 * (i - 1) + 1, 2 * i + 1, 2 * i])
    # Extend the wall up.
    top = len(verts)
    verts += [(-8, -1.2, 8), (8, -1.2, 8)]
    faces.append([top - 2, top - 1, top + 1, top])
    me.from_pydata(verts, [], faces)
    for p in me.polygons:
        p.use_smooth = True
    sweep = bpy.data.objects.new("Sweep", me)
    m = material("SweepMat", color=(0.009, 0.0105, 0.014), rough=0.55)
    me.materials.append(m)
    scene.collection.objects.link(sweep)
    lights = []

    def area(name, loc, target, energy, color, size):
        l = bpy.data.objects.new(name, bpy.data.lights.new(name, "AREA"))
        l.data.energy = energy
        l.data.color = color
        l.data.size = size
        l.location = loc
        l.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(l)
        lights.append(l)

    return sweep, area, lights


def render(scene, roots, name, target, dist, elev, azim, res=(900, 900), lens=55, key=1.0):
    sweep, area, lights = studio_cache["s"]
    for l in lights:
        bpy.data.objects.remove(l, do_unlink=True)
    lights.clear()
    t = Vector(target)
    s = dist / 3.0
    area("Key", t + Vector((-1.4, 2.4, 2.6)) * s, t, 380 * s * s * key, (1.0, 0.84, 0.64), 1.4 * s)
    area("Rim", t + Vector((1.9, -1.4, 1.6)) * s, t, 260 * s * s * key, (1.0, 0.86, 0.68), 1.0 * s)
    area("Fill", t + Vector((2.2, 2.0, 0.6)) * s, t, 25 * s * s * key, (0.85, 0.85, 0.9), 2.0 * s)
    for o in scene.objects:
        if o.type == "MESH" and o is not sweep:
            o.hide_render = not any(o in r.children_recursive for r in roots)
    a, e = math.radians(azim), math.radians(elev)
    cam = scene.camera
    cam.data.lens = lens
    cam.location = t + Vector((math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e))) * dist
    cam.rotation_euler = (t - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.filepath = str(PREVIEW / f"{name}.png")
    bpy.ops.render.render(write_still=True)
    print(f"PREVIEW {scene.render.filepath}")


studio_cache = {}


def previews(roots):
    PREVIEW.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    setup_gpu(scene)
    scene.cycles.samples = 96
    scene.cycles.use_denoising = True
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        scene.view_settings.view_transform = "Filmic"
    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    studio_cache["s"] = studio(scene)
    tree, flw, bowl = roots
    # Each prop at the origin for its shot; move the others out of frame.
    for r in roots:
        r.location = (0, 0, 0)
    for r, others in ((tree, (flw, bowl)), (flw, (tree, bowl)), (bowl, (tree, flw))):
        for o in others:
            o.location = (50, 50, 0)
        r.location = (0, 0, 0)
        bpy.context.view_layer.update()
        if r is tree:
            render(scene, [r], "planterTree", (0, 0, 1.18), 4.3, 6, 8)
            render(scene, [r], "planterTree_top", (0, 0, 1.2), 5.6, 28, 30, res=(600, 600))
        elif r is flw:
            render(scene, [r], "flowers", (0, 0, 0.62), 2.9, 6, 6)
        else:
            render(scene, [r], "flowersBowl", (0, 0, 0.33), 1.75, 10, 8)
    for r in roots:
        r.location = (0, 0, 0)


def build_all():
    clear_scene()
    albedo, nrm, rm = paint_atlas()
    s_alb, s_nrm, s_rm = paint_stone()
    b_alb, b_rm = paint_brass()
    mats = {
        "foliage": material("Foliage", albedo=albedo, normal=nrm, rm=rm, alpha_clip=True, double=True, nstrength=0.8),
        "stone": material("PotStone", albedo=s_alb, normal=s_nrm, rm=s_rm, nstrength=0.6),
        "soil": material("Soil", color=(0.025, 0.018, 0.012), rough=0.95),
        "bark": material("Bark", color=(0.16, 0.11, 0.07), rough=0.75),
        "stem": material("Stem", color=(0.16, 0.30, 0.05), rough=0.4),
        "glass": material("VaseGlass", color=(0.25, 0.27, 0.27), rough=0.02, blend_alpha=0.1, double=True),
        "water": material("VaseWater", color=(0.12, 0.18, 0.12), rough=0.02, blend_alpha=0.12, double=True),
        "brass": material("BowlBrass", albedo=b_alb, rm=b_rm, metal=1.0, rough=0.15),
    }
    roots = [build_planter_tree(mats), build_flowers(mats), build_flowers_bowl(mats)]
    export(roots)
    if PREVIEW:
        previews(roots)


build_all()
