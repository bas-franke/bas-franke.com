"""
Builds the Garden Sentinels environment kit (kit.glb) in Blender.

    blender --background --factory-startup --python build_garden_kit.py -- <output-dir> [preview-dir]

Everything is procedural geometry with vertex colours, so a handful of materials serve every piece:
  * Kit         matte vertex-coloured surface (foliage, stone, soil), double sided for leaf cards
  * KitCeramic  glossy vertex-coloured surface (cream ceramic, gold trim, solar cells)
  * GlowLamp / GlowDome / GlowPortal   emissive (garden lamp orb, greenhouse glass + door, portal lanterns + back)
Conventions the frontend relies on (api.ts, KitName):
  * One root mesh per piece named Kit_<name>, origin at the ground centre, metres, Blender +Y is the front.
  * bridge: 4 x 4 m, walk direction Y, deck top ~0.3 m, water below at z = -0.35.
  * portal: 4 x 4 m, opening towards +Y.  greenhouse: 8 x 8 m, door towards +Y.  lamp: 1.6 m tall.
Foliage / rocks / flowers / grass are low poly because the game instances hundreds of them.
"""

import math
import random
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils import noise as mnoise

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = Path(ARGS[0]) if ARGS else Path("models/garden")
PREVIEW = Path(ARGS[1]) if len(ARGS) > 1 else None


# ---- colours ------------------------------------------------------------------------------------------------------------

def H(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def mul(a, k):
    return tuple(min(1.0, c * k) for c in a)


def lin(c):
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def jit(c, rng, amt=0.08):
    k = 1 + rng.uniform(-amt, amt)
    return mul(mix(c, (c[1], c[2], c[0]), rng.uniform(0, amt * 0.4)), k)


STONE = [H("#a69d90"), H("#968e83"), H("#b5ab9c"), H("#8c8579")]
MOSS = H("#79a03c")
LEAF = [H("#3d7a2b"), H("#4f8f30"), H("#2f6a26"), H("#62a23a")]
LEAF_LIGHT = H("#9ccc4f")
LEAF_DARK = H("#1f4a1c")
GRASS = H("#5c9a34")
CREAM = H("#f4e4c6")
CREAM_SHADE = H("#e0cca9")
GOLD = H("#e3b45a")
PAVER = [H("#e8d2ad"), H("#e0c79e"), H("#ecd9b8"), H("#d9bf95")]
BARK = H("#7b5a3c")
SOIL = H("#5e4632")
DARK = H("#1d1814")
PINK = H("#f26aa9")
MAGENTA = H("#d4459a")
YELLOW = H("#ffd23f")
ORANGE = H("#ff9a3c")
WHITE = H("#fff7ea")
PURPLE = H("#9a6ad8")
BLUE = H("#6f8ff0")
SOLAR = H("#1d3a72")


# ---- materials ----------------------------------------------------------------------------------------------------------

MATS = {}


def vc_material(name, rough, double_sided):
    mat = bpy.data.materials.new(name)
    mat.use_fake_user = True
    mat.use_nodes = True
    mat.use_backface_culling = not double_sided
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    col = nt.nodes.new("ShaderNodeVertexColor")
    col.layer_name = "Col"
    nt.links.new(col.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = 0.0
    mat.diffuse_color = (0.8, 0.8, 0.8, 1.0)
    MATS[name] = mat
    return mat


def glow_material(name, color, strength):
    mat = bpy.data.materials.new(name)
    mat.use_fake_user = True
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    c = lin(color)
    bsdf.inputs["Base Color"].default_value = (*mul(c, 0.45), 1.0)
    bsdf.inputs["Roughness"].default_value = 0.3
    bsdf.inputs["Emission Color"].default_value = (*c, 1.0)
    bsdf.inputs["Emission Strength"].default_value = strength
    mat.diffuse_color = (*c, 1.0)
    MATS[name] = mat
    return mat


def make_materials():
    vc_material("Kit", 0.85, True)
    vc_material("KitCeramic", 0.38, False)
    glow_material("GlowLamp", H("#ffa53a"), 2.0)
    glow_material("GlowDome", H("#ffa940"), 1.5)
    glow_material("GlowPortal", H("#ff8a2a"), 2.5)


# ---- mesh builder -------------------------------------------------------------------------------------------------------

class B:
    """Accumulates parts (verts, faces, per-vertex sRGB colour, material, smooth flag) into one mesh."""

    def __init__(self):
        self.v, self.c, self.f, self.m, self.s = [], [], [], [], []

    def add(self, verts, faces, col, mat="Kit", smooth=True, mtx=None):
        base = len(self.v)
        for i, p in enumerate(verts):
            p = Vector(p)
            if mtx is not None:
                p = mtx @ p
            self.v.append(p)
            if callable(col):
                self.c.append(col(p, i))
            elif isinstance(col, list):
                self.c.append(col[i])
            else:
                self.c.append(col)
        for f in faces:
            self.f.append(tuple(base + i for i in f))
            self.m.append(mat)
            self.s.append(smooth)
        return base

    def build(self, name, ao=None):
        me = bpy.data.meshes.new(name)
        me.from_pydata([tuple(v) for v in self.v], [], self.f)
        names = []
        for m in self.m:
            if m not in names:
                names.append(m)
        for n in names:
            me.materials.append(MATS[n])
        me.polygons.foreach_set("material_index", [names.index(m) for m in self.m])
        me.polygons.foreach_set("use_smooth", self.s)
        attr = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
        flat = []
        for p, c in zip(self.v, self.c):
            k = 1.0
            if ao:
                z0, z1, lo = ao
                t = max(0.0, min(1.0, (p.z - z0) / (z1 - z0)))
                k = lo + (1 - lo) * (t * t * (3 - 2 * t))
            flat.extend((*lin(mul(c, k)), 1.0))
        attr.data.foreach_set("color", flat)
        me.color_attributes.active_color = attr
        me.color_attributes.render_color_index = 0
        me.validate(clean_customdata=False)
        me.update()
        obj = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(obj)
        return obj


def tris(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


# ---- primitives (return local verts, faces) -----------------------------------------------------------------------------

def bm_out(bm):
    bm.verts.ensure_lookup_table()
    verts = [v.co.copy() for v in bm.verts]
    faces = [tuple(v.index for v in f.verts) for f in bm.faces]
    bm.free()
    return verts, faces


def ico(sub, r=1.0):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
    return bm_out(bm)


def shaped_box(fn, bev=0.0, segs=1):
    """Cube whose corner (sx, sy, sz) in {-1, 1}^3 goes to fn(sx, sy, sz); optional bevel."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2.0)
    for v in bm.verts:
        v.co = Vector(fn(1 if v.co.x > 0 else -1, 1 if v.co.y > 0 else -1, 1 if v.co.z > 0 else -1))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    if bev > 0:
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bev, offset_type="OFFSET", segments=segs, profile=0.5,
                        affect="EDGES", clamp_overlap=True)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return bm_out(bm)


def rbox(sx, sy, sz, bev=0.03, segs=1):
    return shaped_box(lambda a, b, c: (a * sx / 2, b * sy / 2, c * sz / 2), bev, segs)


def revolve(profile, seg):
    """Surface of revolution around Z from (r, z) pairs (r = 0 gives a pole)."""
    verts, faces, rings = [], [], []
    for r, z in profile:
        if r <= 1e-6:
            rings.append([len(verts)])
            verts.append(Vector((0, 0, z)))
        else:
            ring = []
            for k in range(seg):
                a = 2 * math.pi * k / seg
                ring.append(len(verts))
                verts.append(Vector((r * math.cos(a), r * math.sin(a), z)))
            rings.append(ring)
    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        for k in range(seg):
            k1 = (k + 1) % seg
            if len(a) == 1:
                faces.append((a[0], b[k1], b[k]))
            elif len(b) == 1:
                faces.append((a[k], a[k1], b[0]))
            else:
                faces.append((a[k], a[k1], b[k1], b[k]))
    return verts, faces


def tube(points, radii, sides):
    """Tapered tube along a polyline (open ends)."""
    verts, faces = [], []
    pts = [Vector(p) for p in points]
    for i, p in enumerate(pts):
        d = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        t1 = d.orthogonal().normalized()
        t2 = d.cross(t1)
        for k in range(sides):
            a = 2 * math.pi * k / sides
            verts.append(p + (t1 * math.cos(a) + t2 * math.sin(a)) * radii[i])
    for i in range(len(pts) - 1):
        for k in range(sides):
            k1 = (k + 1) % sides
            faces.append((i * sides + k, i * sides + k1, (i + 1) * sides + k1, (i + 1) * sides + k))
    return verts, faces


def lumpy(verts, amp, freq, seed, center=(0, 0, 0)):
    c = Vector(center)
    so = Vector((seed * 7.31, seed * 3.17, seed * 5.53))
    out = []
    for v in verts:
        d = (v - c)
        n = d.normalized() if d.length > 1e-6 else Vector((0, 0, 1))
        out.append(v + n * amp * mnoise.noise(v * freq + so))
    return out


def trs(pos=(0, 0, 0), yaw=0.0, pitch=0.0, roll=0.0, scale=1.0):
    s = scale if isinstance(scale, (tuple, list)) else (scale, scale, scale)
    S = Matrix.Diagonal((*s, 1.0))
    return (Matrix.Translation(pos) @ Matrix.Rotation(yaw, 4, "Z") @ Matrix.Rotation(pitch, 4, "X")
            @ Matrix.Rotation(roll, 4, "Y") @ S)


def align_z(n):
    return Vector((0, 0, 1)).rotation_difference(Vector(n).normalized()).to_matrix().to_4x4()


# ---- foliage parts ------------------------------------------------------------------------------------------------------

# base 0, left 1-2, tip 3, right 4-5, ridge 6-7
LEAF_FACES = [(0, 6, 1), (1, 6, 7), (1, 7, 2), (2, 7, 3), (0, 4, 6), (4, 7, 6), (4, 5, 7), (5, 3, 7)]


def leaf(b, pos, yaw, pitch, length, width, col, rng, droop=0.25, mat="Kit"):
    """Rounded, folded leaf card (8 tris) pointing along yaw, tilted up by pitch."""
    L, W = length, width * 1.25
    d = droop * L
    verts = [(0, 0, 0), (-W * 0.42, L * 0.3, -0.05 * d), (-W * 0.36, L * 0.7, -0.45 * d), (0, L, -d),
             (W * 0.42, L * 0.3, -0.05 * d), (W * 0.36, L * 0.7, -0.45 * d), (0, L * 0.3, W * 0.14),
             (0, L * 0.68, W * 0.1 - 0.4 * d)]
    c = jit(col, rng)
    e = mix(c, LEAF_LIGHT, 0.3)
    cols = [mul(c, 0.65), c, e, mix(c, LEAF_LIGHT, 0.4), c, e, mul(c, 0.95), mix(c, LEAF_LIGHT, 0.2)]
    b.add(verts, LEAF_FACES, cols, mat, True, trs(pos, yaw - math.pi / 2, pitch, rng.uniform(-0.3, 0.3)))


def flat_leaf(b, pos, yaw, pitch, length, width, col, rng):
    """Flat diamond (2 tris) for fern leaflets."""
    verts = [(0, 0, 0), (-width / 2, length * 0.45, 0), (0, length, -0.15 * length), (width / 2, length * 0.45, 0)]
    c = jit(col, rng, 0.06)
    b.add(verts, [(0, 3, 1), (1, 3, 2)], [mul(c, 0.8), c, mix(c, LEAF_LIGHT, 0.3), c], "Kit", True,
          trs(pos, yaw - math.pi / 2, pitch))


def flower(b, pos, normal, r, petal, center=YELLOW, petals=5, rng=None, cup=0.25):
    """Simple flower head: petal quads around a little centre pyramid (~13 tris)."""
    verts, faces, cols = [], [], []
    ph = rng.uniform(0, 6.28) if rng else 0
    tip = mix(petal, WHITE, 0.35)
    for k in range(petals):
        a = ph + 2 * math.pi * k / petals
        da = math.pi / petals * 0.75
        i = len(verts)
        verts += [(r * 0.15 * math.cos(a), r * 0.15 * math.sin(a), 0.0),
                  (r * 0.6 * math.cos(a - da), r * 0.6 * math.sin(a - da), r * cup * 0.6),
                  (r * math.cos(a), r * math.sin(a), r * cup),
                  (r * 0.6 * math.cos(a + da), r * 0.6 * math.sin(a + da), r * cup * 0.6)]
        cols += [mul(petal, 0.85), petal, tip, petal]
        faces += [(i, i + 1, i + 2), (i, i + 2, i + 3)]
    i = len(verts)
    for k in range(3):
        a = 2 * math.pi * k / 3
        verts.append((r * 0.22 * math.cos(a), r * 0.22 * math.sin(a), r * 0.05))
        cols.append(mul(center, 0.85))
    verts.append((0, 0, r * 0.18))
    cols.append(center)
    faces += [(i, i + 1, i + 3), (i + 1, i + 2, i + 3), (i + 2, i, i + 3)]
    b.add(verts, faces, cols, "Kit", True, Matrix.Translation(pos) @ align_z(normal))


def blade(b, pos, yaw, h, w, bend, base, tipc, rng, lean=0.0):
    verts = [(-w / 2, 0, 0), (w / 2, 0, 0), (-w * 0.32, bend * 0.3, h * 0.55), (w * 0.32, bend * 0.3, h * 0.55),
             (0, bend, h)]
    cols = [mul(base, 0.75), mul(base, 0.75), mix(base, tipc, 0.45), mix(base, tipc, 0.45), tipc]
    b.add(verts, [(0, 1, 3, 2), (2, 3, 4)], cols, "Kit", True, trs(pos, yaw, lean))


def blob(b, pos, size, sub, seed, col, rng, amp=0.16, light=LEAF_LIGHT, cull=-0.35):
    """Lumpy foliage blob; faces entirely below local z = cull (hidden underneath / in the ground) are dropped."""
    verts, faces = ico(sub)
    verts = lumpy(verts, amp, 1.8, seed)
    faces = [f for f in faces if max(verts[i].z for i in f) > cull]
    cs = [mix(mul(jit(col, rng, 0.05), 0.9 + 0.2 * mnoise.noise(v * 2.3 + Vector((seed, 0, 0)))), light,
              max(0.0, v.z) * 0.18) for v in verts]
    b.add(verts, faces, cs, "Kit", True, trs(pos, rng.uniform(0, 6.28), scale=size))


def bush(b, center, R, H_, seed, flower_cols=(), nflowers=0, leaf_col=None, nleaves=70, blobs=5, rng=None,
         blob_col=None, leaf_scale=1.0):
    rng = rng or random.Random(seed)
    cx, cy, cz = center
    leaf_col = leaf_col or LEAF[0]
    blob_col = blob_col or mul(leaf_col, 0.8)
    for i in range(blobs):
        if i == 0:
            p, s = (cx, cy, cz + H_ * 0.42), (R * 0.62, R * 0.62, H_ * 0.48)
        else:
            a = 2 * math.pi * i / (blobs - 1) + rng.uniform(-0.3, 0.3)
            d = R * rng.uniform(0.38, 0.5)
            p = (cx + d * math.cos(a), cy + d * math.sin(a), cz + H_ * 0.25)
            s = (R * 0.45, R * 0.45, H_ * 0.33)
        blob(b, p, s, 2, seed + i * 1.7, blob_col, rng)
    for i in range(nleaves):
        # Golden-angle spiral so a few leaves still cover the dome evenly.
        th = i * 2.39996 + rng.uniform(-0.25, 0.25)
        e = math.asin(min(0.97, (i + rng.uniform(0.2, 0.8)) / nleaves))
        rr = R * (0.82 - 0.6 * (leaf_scale - 1))
        p = Vector((cx + rr * math.cos(e) * math.cos(th), cy + rr * math.cos(e) * math.sin(th),
                    cz + H_ * (0.9 - 0.4 * (leaf_scale - 1)) * math.sin(e) + 0.03))
        L = R * rng.uniform(0.42, 0.6) * leaf_scale
        col = leaf_col if rng.random() > 0.3 else LEAF[rng.randrange(len(LEAF))]
        leaf(b, p, th, e * 0.85 - 0.15, L, L * 0.55, col, rng)
    for i in range(nflowers):
        th = rng.uniform(0, 2 * math.pi)
        e = math.radians(rng.uniform(25, 80))
        n = Vector((math.cos(e) * math.cos(th), math.cos(e) * math.sin(th), math.sin(e)))
        p = Vector((cx + R * 0.95 * n.x, cy + R * 0.95 * n.y, cz + H_ * 1.0 * n.z + 0.02))
        nn = (n + Vector((0, 0, 1.2))).normalized()
        flower(b, p, nn, R * rng.uniform(0.13, 0.18), flower_cols[i % len(flower_cols)], YELLOW, 5, rng)


def stone(b, pos, size, sub, seed, rng, moss=0.55, col=None, yaw=None):
    verts, faces = ico(sub + 1)
    so = Vector((seed, seed * 1.9, seed * 0.7))
    out, cols = [], []
    base = col or STONE[rng.randrange(len(STONE))]
    for v in verts:
        d = v.normalized()
        n = mnoise.noise(d * 1.6 + so)
        p = d * (1 + 0.2 * n)
        if p.z < -0.35:
            p.z = -0.35 + (p.z + 0.35) * 0.15
        out.append(p)
        c = mul(base, 0.88 + 0.18 * mnoise.noise(d * 3.1 + so))
        m = d.z + 0.3 * mnoise.noise(d * 2.4 - so)
        if moss and m > moss:
            c = mix(c, jit(MOSS, rng, 0.05), min(1.0, (m - moss) * 4))
        cols.append(c)
    sx, sy, sz = size
    px, py, pz = pos
    b.add(out, faces, cols, "Kit", True,
          trs((px, py, pz + 0.3 * sz), rng.uniform(0, 6.28) if yaw is None else yaw, scale=size))


def ground_leaves(b, rng, center, r0, r1, n, L, cols=LEAF, z=0.02):
    for i in range(n):
        th = rng.uniform(0, 6.28)
        r = rng.uniform(r0, r1)
        p = (center[0] + r * math.cos(th), center[1] + r * math.sin(th), center[2] + z)
        l = L * rng.uniform(0.8, 1.2)
        leaf(b, p, th, rng.uniform(0.25, 0.6), l, l * 0.5, cols[rng.randrange(len(cols))], rng)


# ---- small pieces -------------------------------------------------------------------------------------------------------

def k_rock_a():
    b, rng = B(), random.Random(11)
    stone(b, (0.05, 0, 0), (0.62, 0.52, 0.5), 2, 1.3, rng)
    stone(b, (0.62, -0.28, 0), (0.32, 0.3, 0.26), 1, 4.1, rng)
    stone(b, (-0.5, 0.32, 0), (0.3, 0.27, 0.22), 1, 7.7, rng)
    ground_leaves(b, rng, (0, 0, 0), 0.5, 0.75, 6, 0.25)
    return b.build("Kit_rock_a", ao=(-0.05, 0.6, 0.65))


def k_rock_b():
    b, rng = B(), random.Random(12)
    stone(b, (0, 0, 0), (0.55, 0.48, 0.62), 2, 2.6, rng)
    stone(b, (-0.5, -0.3, 0), (0.28, 0.26, 0.22), 1, 9.2, rng)
    ground_leaves(b, rng, (0, 0, 0), 0.45, 0.65, 5, 0.25)
    return b.build("Kit_rock_b", ao=(-0.05, 0.7, 0.65))


def k_rock_c():
    b, rng = B(), random.Random(13)
    stone(b, (0.1, 0.05, -0.05), (0.5, 0.42, 0.3), 2, 5.5, rng, moss=0.45)
    stone(b, (-0.5, -0.2, -0.02), (0.3, 0.26, 0.2), 1, 3.3, rng, moss=0.45)
    stone(b, (0.55, 0.45, -0.02), (0.22, 0.2, 0.16), 1, 6.4, rng, moss=0.45)
    ground_leaves(b, rng, (0, 0, 0), 0.4, 0.7, 5, 0.22)
    return b.build("Kit_rock_c", ao=(-0.05, 0.35, 0.65))


def k_bush_a():
    b = B()
    bush(b, (0, 0, 0), 0.62, 0.75, 21, (PINK, WHITE, YELLOW), 9, LEAF[1], 38, 4, leaf_scale=1.3)
    return b.build("Kit_bush_a", ao=(0.0, 0.7, 0.45))


def k_bush_b():
    b = B()
    bush(b, (0, 0, 0), 0.5, 0.95, 22, (WHITE, PURPLE), 7, LEAF[0], 36, 4, leaf_scale=1.3)
    return b.build("Kit_bush_b", ao=(0.0, 0.8, 0.45))


def k_fern():
    b, rng = B(), random.Random(31)
    fronds = 8
    for f in range(fronds):
        th = 2 * math.pi * f / fronds + rng.uniform(-0.2, 0.2)
        rise = rng.uniform(0.7, 1.0)
        length = rng.uniform(0.6, 0.78)
        steps = 6
        prev = None
        for s in range(steps):
            t = (s + 0.5) / steps
            r = length * t
            z = 0.05 + length * rise * (1.6 * t - 1.3 * t * t)
            p = Vector((r * math.cos(th), r * math.sin(th), z))
            slope = math.atan2(length * rise * (1.6 - 2.6 * t), length)
            sz = 0.2 * (1 - t * 0.7)
            col = mix(LEAF[2], LEAF_LIGHT, t * 0.5)
            for side in (-1, 1):
                flat_leaf(b, p, th + side * 1.15, slope * 0.6, sz, sz * 0.42, col, rng)
            prev = p
        flat_leaf(b, prev, th, -0.5, 0.12, 0.06, mix(LEAF[2], LEAF_LIGHT, 0.5), rng)
    return b.build("Kit_fern", ao=(0.0, 0.4, 0.5))


def tree_trunk(b, rng, height, r0):
    pts, rad = [], []
    lean = Vector((rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), 0))
    for i in range(6):
        t = i / 5
        pts.append(Vector((0, 0, height * t)) + lean * t * t)
        rad.append(r0 * (1.25 - 0.55 * t) * (1.35 if i == 0 else 1))
    v, f = tube(pts, rad, 7)
    b.add(v, f, lambda p, i: mul(BARK, 0.8 + 0.25 * mnoise.noise(p * 4)), "Kit", True)
    return pts[-1]


def k_tree_a():
    b, rng = B(), random.Random(41)
    top = tree_trunk(b, rng, 2.0, 0.12)
    for a in (0.6, 2.8, 4.6):
        d = Vector((math.cos(a), math.sin(a), 1.1)).normalized()
        start = Vector((0, 0, 1.4))
        v, f = tube([start, start + d * 0.55], [0.06, 0.035], 5)
        b.add(v, f, BARK, "Kit", True)
    canopy = [((0, 0, 2.45), (1.0, 1.0, 0.8)), ((0.55, 0.25, 2.1), (0.62, 0.62, 0.55)),
              ((-0.5, 0.35, 2.15), (0.6, 0.6, 0.52)), ((0.05, -0.6, 2.05), (0.6, 0.6, 0.5)),
              ((0.0, 0.0, 2.95), (0.65, 0.65, 0.5))]
    for i, (p, s) in enumerate(canopy):
        blob(b, (top.x + p[0], top.y + p[1], p[2]), s, 2, 4 + i * 2.3, mul(LEAF[1], 0.95), rng)
    n_leaves = 32
    for i in range(n_leaves):
        th = i * 2.39996 + rng.uniform(-0.2, 0.2)
        e = math.asin(min(0.97, -0.35 + 1.3 * (i + rng.uniform(0.2, 0.8)) / n_leaves))
        p = Vector((0.92 * math.cos(e) * math.cos(th), 0.92 * math.cos(e) * math.sin(th), 2.45 + 0.85 * math.sin(e)))
        L = rng.uniform(0.45, 0.6)
        leaf(b, p + Vector((top.x, top.y, 0)), th, e * 0.8, L, L * 0.55, LEAF[rng.randrange(4)], rng)
    return b.build("Kit_tree_a", ao=(0.0, 2.6, 0.5))


def k_tree_b():
    """Blossom tree: spreading layered canopy, pink-tinted with flowers."""
    b, rng = B(), random.Random(42)
    top = tree_trunk(b, rng, 1.7, 0.11)
    for a in (0.2, 2.3, 4.3):
        d = Vector((math.cos(a), math.sin(a), 0.7)).normalized()
        start = Vector((0, 0, 1.3))
        v, f = tube([start, start + d * 0.8], [0.06, 0.03], 5)
        b.add(v, f, BARK, "Kit", True)
    blossom = H("#f7a8c8")
    leafc = H("#6aa83c")
    pinks = [H("#f59ac0"), H("#ee86b2"), H("#f8b6d0"), H("#e978a8"), H("#f7a8c8")]
    pads = [((0, 0, 2.1), (1.15, 1.15, 0.55)), ((0.75, 0.3, 1.85), (0.6, 0.6, 0.4)),
            ((-0.7, 0.4, 1.9), (0.6, 0.6, 0.4)), ((0.1, -0.75, 1.85), (0.62, 0.62, 0.4)),
            ((0.1, 0.1, 2.55), (0.7, 0.7, 0.4))]
    for i, (p, s) in enumerate(pads):
        blob(b, (top.x + p[0], top.y + p[1], p[2]), s, 2, 9 + i * 1.9,
             pinks[i % len(pinks)], rng, light=WHITE)
    n_leaves = 20
    for i in range(n_leaves):
        th = i * 2.39996 + rng.uniform(-0.2, 0.2)
        e = math.asin(min(0.9, -0.25 + 1.15 * (i + rng.uniform(0.2, 0.8)) / n_leaves))
        p = Vector((1.06 * math.cos(e) * math.cos(th), 1.06 * math.cos(e) * math.sin(th), 2.1 + 0.6 * math.sin(e)))
        L = rng.uniform(0.42, 0.55)
        leaf(b, p + Vector((top.x, top.y, 0)), th, e * 0.8, L, L * 0.55, mix(leafc, LEAF[0], rng.random()), rng)
    for i in range(10):
        th = i * 2.39996 + 1.0
        e = math.asin(min(0.95, (i + 0.5) / 10))
        n = Vector((math.cos(e) * math.cos(th), math.cos(e) * math.sin(th), math.sin(e)))
        p = Vector((top.x + 1.18 * n.x, top.y + 1.18 * n.y, 2.12 + 0.6 * n.z))
        flower(b, p, (n + Vector((0, 0, 1))).normalized(), rng.uniform(0.14, 0.18), rng.choice((PINK, WHITE, blossom)),
               WHITE, 5, rng)
    return b.build("Kit_tree_b", ao=(0.0, 2.3, 0.5))


def flower_bed(name, seed, cols, n, big=False):
    b, rng = B(), random.Random(seed)
    for i in range(8):
        th = i * 2.39996 + rng.uniform(-0.3, 0.3)
        r = rng.uniform(0.1, 0.45)
        p = (r * math.cos(th), r * math.sin(th), 0.02)
        L = rng.uniform(0.28, 0.38)
        leaf(b, p, th, rng.uniform(0.25, 0.75), L, L * 0.5, LEAF[rng.randrange(4)], rng)
    for i in range(n):
        th = rng.uniform(0, 6.28)
        r = rng.uniform(0.0, 0.45)
        h = rng.uniform(0.18, 0.4)
        base = Vector((r * math.cos(th), r * math.sin(th), 0))
        top = base + Vector((rng.uniform(-0.05, 0.05), rng.uniform(-0.05, 0.05), h))
        v, f = tube([base, top], [0.012, 0.009], 3)
        b.add(v, f, LEAF[2], "Kit", True)
        nn = Vector((rng.uniform(-0.35, 0.35), rng.uniform(-0.35, 0.35), 1)).normalized()
        c = cols[i % len(cols)]
        flower(b, top, nn, rng.uniform(0.12, 0.16) * (1.25 if big else 1), c, ORANGE if c == WHITE else YELLOW,
               6 if big else 5, rng)
    return b.build(name, ao=(0.0, 0.35, 0.6))


def k_grass():
    b, rng = B(), random.Random(51)
    for i in range(15):
        th = rng.uniform(0, 6.28)
        r = rng.uniform(0.0, 0.18)
        p = (r * math.cos(th), r * math.sin(th), 0)
        blade(b, p, th + rng.uniform(-0.6, 0.6), rng.uniform(0.22, 0.42), rng.uniform(0.04, 0.06),
              rng.uniform(0.06, 0.16), GRASS, mix(GRASS, H("#c8e070"), 0.6), rng, rng.uniform(-0.1, 0.1))
    return b.build("Kit_grass_tuft")


def k_reeds():
    b, rng = B(), random.Random(52)
    reed = H("#6f9a3c")
    for i in range(16):
        th = rng.uniform(0, 6.28)
        r = rng.uniform(0.0, 0.3)
        p = (r * math.cos(th), r * math.sin(th), -0.1)
        blade(b, p, th, rng.uniform(0.8, 1.35), rng.uniform(0.05, 0.07), rng.uniform(0.1, 0.3), reed,
              H("#c4d67a"), rng)
    for i in range(4):
        th = rng.uniform(0, 6.28)
        r = rng.uniform(0.05, 0.22)
        base = Vector((r * math.cos(th), r * math.sin(th), -0.1))
        top = base + Vector((rng.uniform(-0.08, 0.08), rng.uniform(-0.08, 0.08), rng.uniform(1.0, 1.35)))
        v, f = tube([base, top], [0.012, 0.01], 3)
        b.add(v, f, reed, "Kit", True)
        d = (top - base).normalized()
        v, f = tube([top - d * 0.22, top - d * 0.02], [0.035, 0.035], 6)
        b.add(v, f, H("#7a4e2c"), "Kit", True)
        v, f = tube([top - d * 0.02, top + d * 0.08], [0.008, 0.005], 3)
        b.add(v, f, H("#7a4e2c"), "Kit", True)
    return b.build("Kit_reeds", ao=(-0.1, 0.6, 0.6))


def pad(b, pos, r, yaw, rng):
    seg = 14
    notch = 0.5
    verts, cols = [Vector((0, 0, 0.012))], [H("#9ccf55")]
    for k in range(seg + 1):
        a = notch / 2 + (2 * math.pi - notch) * k / seg
        rr = r * (1 + 0.04 * math.sin(a * 5))
        verts.append(Vector((rr * math.cos(a), rr * math.sin(a), 0.02)))
        cols.append(mix(H("#4f9a34"), H("#3a7a2a"), rng.random()))
    faces = [(0, k + 1, k + 2) for k in range(seg)]
    b.add(verts, faces, cols, "Kit", True, trs(pos, yaw))


def k_lilypad():
    b, rng = B(), random.Random(61)
    pad(b, (0, 0, 0), 0.42, 0.3, rng)
    pad(b, (0.52, 0.32, 0), 0.24, 2.0, rng)
    pad(b, (-0.38, 0.45, 0), 0.18, 4.0, rng)
    flower(b, (0.08, -0.05, 0.03), (0, 0, 1), 0.12, H("#f7a6c8"), YELLOW, 6, rng, cup=0.9)
    flower(b, (0.08, -0.05, 0.05), (0, 0, 1), 0.07, H("#fbd3e3"), YELLOW, 5, rng, cup=1.2)
    return b.build("Kit_lilypad")


def k_path_stone():
    b, rng = B(), random.Random(71)
    n = 10
    outline = [0.42 * (1 + 0.08 * mnoise.noise(Vector((math.cos(2 * math.pi * k / n), math.sin(2 * math.pi * k / n),
                                                          3.3)) * 1.5)) for k in range(n)]
    verts, faces = [], []
    rings = [(1.0, -0.03), (1.0, 0.04), (0.92, 0.065), (0.75, 0.075)]
    for s, z in rings:
        for k in range(n):
            a = 2 * math.pi * k / n
            verts.append(Vector((outline[k] * s * math.cos(a), outline[k] * s * 0.85 * math.sin(a), z)))
    for i in range(len(rings) - 1):
        for k in range(n):
            k1 = (k + 1) % n
            faces.append((i * n + k, i * n + k1, (i + 1) * n + k1, (i + 1) * n + k))
    c = len(verts)
    verts.append(Vector((0, 0, 0.078)))
    last = (len(rings) - 1) * n
    faces += [(last + k, last + (k + 1) % n, c) for k in range(n)]
    base = PAVER[1]
    b.add(verts, faces, lambda p, i: mul(base, 0.82 + 0.25 * min(1, p.z / 0.075) + 0.06 * mnoise.noise(p * 6)), "Kit",
          True)
    return b.build("Kit_path_stone")


def k_pebble():
    b, rng = B(), random.Random(81)
    stone(b, (0, 0, -0.02), (0.14, 0.11, 0.07), 1, 1.1, rng, moss=0)
    stone(b, (0.17, 0.1, -0.02), (0.09, 0.08, 0.05), 0, 2.2, rng, moss=0)
    stone(b, (-0.12, 0.14, -0.02), (0.08, 0.07, 0.045), 0, 3.3, rng, moss=0)
    stone(b, (0.05, -0.16, -0.02), (0.07, 0.06, 0.04), 0, 4.4, rng, moss=0)
    return b.build("Kit_pebble")


# ---- ceramic props ------------------------------------------------------------------------------------------------------

def ceramic_col(trims=()):
    def f(p, i):
        for z0, z1 in trims:
            if z0 <= p.z <= z1:
                return GOLD
        return mix(CREAM_SHADE, CREAM, min(1.0, 0.4 + p.z))
    return f


def k_lamp():
    b, rng = B(), random.Random(91)
    post = [(0.0, 0.0), (0.2, 0.0), (0.22, 0.05), (0.21, 0.12), (0.15, 0.18), (0.09, 0.23), (0.075, 0.3),
            (0.07, 1.0), (0.08, 1.06), (0.16, 1.1), (0.18, 1.14), (0.18, 1.18), (0.12, 1.19)]
    v, f = revolve(post, 16)
    b.add(v, f, ceramic_col([(1.13, 1.2), (0.0, 0.06)]), "KitCeramic", True)
    v, f = revolve([(0.12, 1.18), (0.135, 1.24), (0.14, 1.32), (0.135, 1.4), (0.12, 1.45)], 16)
    b.add(v, f, H("#ffb347"), "GlowLamp", True)
    cap = [(0.12, 1.44), (0.19, 1.44), (0.2, 1.48), (0.17, 1.53), (0.1, 1.575), (0.04, 1.595), (0.0, 1.6)]
    v, f = revolve(cap, 16)
    b.add(v, f, ceramic_col([(1.43, 1.46)]), "KitCeramic", True)
    for k in range(3):
        a = 2 * math.pi * k / 3 + 0.5
        v, f = rbox(0.045, 0.045, 0.28, 0.012)
        b.add(v, f, CREAM, "KitCeramic", False, trs((0.145 * math.cos(a), 0.145 * math.sin(a), 1.315), a))
    ground_leaves(b, rng, (0, 0, 0), 0.18, 0.3, 7, 0.22)
    return b.build("Kit_lamp", ao=(0.0, 0.4, 0.75))


def k_solar():
    b, rng = B(), random.Random(92)
    stand = [(0.0, 0.0), (0.3, 0.0), (0.32, 0.06), (0.27, 0.12), (0.12, 0.17), (0.07, 0.22), (0.065, 0.55),
             (0.0, 0.58)]
    v, f = revolve(stand, 14)
    b.add(v, f, ceramic_col([(0.0, 0.05)]), "KitCeramic", True)
    v, f = tube([(-0.12, 0, 0.6), (0.12, 0, 0.6)], [0.05, 0.05], 8)
    b.add(v, f, GOLD, "KitCeramic", True)
    M = trs((0, 0, 0.62), 0, -0.55)
    v, f = rbox(1.0, 0.72, 0.06, 0.02)
    b.add(v, f, CREAM, "KitCeramic", False, M @ Matrix.Translation((0, 0, 0.03)))
    nx, ny, gap = 4, 3, 0.022
    cw, ch = (0.92 - gap * (nx - 1)) / nx, (0.64 - gap * (ny - 1)) / ny
    for i in range(nx):
        for j in range(ny):
            x0 = -0.46 + i * (cw + gap)
            y0 = -0.32 + j * (ch + gap)
            verts = [(x0, y0, 0.062), (x0 + cw, y0, 0.062), (x0 + cw, y0 + ch, 0.062), (x0, y0 + ch, 0.062)]
            c0 = SOLAR
            cols = [mul(c0, 0.8), c0, mix(c0, H("#6f9ae0"), 0.45), mix(c0, H("#4a72c0"), 0.25)]
            b.add(verts, [(0, 1, 2, 3)], cols, "KitCeramic", False, M)
    bush(b, (0.0, 0.0, 0.0), 0.42, 0.28, 93, (), 0, LEAF[1], 18, 3, rng)
    stone(b, (0.42, 0.25, -0.03), (0.16, 0.14, 0.12), 1, 2.0, rng)
    stone(b, (-0.38, -0.3, -0.03), (0.13, 0.12, 0.1), 1, 3.0, rng)
    return b.build("Kit_solar", ao=(0.0, 0.5, 0.65))


# ---- bridge -------------------------------------------------------------------------------------------------------------

def deck_h(y):
    return 0.3 - 0.1 * (y / 2) ** 2


def planter(b, pos, rng, flowers):
    x, y, z = pos
    v, f = rbox(0.44, 0.44, 0.24, 0.04)
    b.add(v, f, CREAM, "KitCeramic", False, Matrix.Translation((x, y, z + 0.12)))
    v, f = rbox(0.48, 0.48, 0.04, 0.015)
    b.add(v, f, GOLD, "KitCeramic", False, Matrix.Translation((x, y, z + 0.235)))
    bush(b, (x, y, z + 0.18), 0.3, 0.32, int(x * 10 + y * 3 + 50), flowers, 5, LEAF[1], 22, 3, rng)


def k_bridge():
    b, rng = B(), random.Random(101)
    # Stone body with an elliptical arch over the water.
    W = 1.3
    ys = [-2.0, -1.7, -1.3, -1.3, -1.0, -0.6, -0.3, 0.0, 0.3, 0.6, 1.0, 1.3, 1.3, 1.7, 2.0]
    # The two samples at |y| = 1.3 make a vertical step from the abutment bottom up to the arch spring line.
    bottoms = [-0.35 + 0.42 * math.sqrt(max(0.0, 1 - (y / 1.3) ** 2)) if abs(y) < 1.3 else -0.65 for y in ys]
    bottoms[3] = bottoms[11] = -0.35
    tops = [deck_h(y) - 0.08 for y in ys]
    verts, faces = [], []
    n = len(ys)
    for x in (-W, W):
        for i in range(n):
            verts.append(Vector((x, ys[i], tops[i])))
            verts.append(Vector((x, ys[i], bottoms[i])))
    L, R = 0, 2 * n

    def vi(side, i, top):
        return side + 2 * i + (0 if top else 1)
    for i in range(n - 1):
        faces.append((vi(L, i, True), vi(L, i, False), vi(L, i + 1, False), vi(L, i + 1, True)))
        faces.append((vi(R, i, True), vi(R, i + 1, True), vi(R, i + 1, False), vi(R, i, False)))
        faces.append((vi(L, i, True), vi(L, i + 1, True), vi(R, i + 1, True), vi(R, i, True)))
        faces.append((vi(L, i, False), vi(R, i, False), vi(R, i + 1, False), vi(L, i + 1, False)))
    faces.append((vi(L, 0, True), vi(R, 0, True), vi(R, 0, False), vi(L, 0, False)))
    faces.append((vi(L, n - 1, True), vi(L, n - 1, False), vi(R, n - 1, False), vi(R, n - 1, True)))
    body = H("#b09f8a")
    b.add(verts, faces, lambda p, i: mul(body, 0.8 + 0.15 * mnoise.noise(p * 3) + 0.15 * max(0, p.z + 0.35)), "Kit",
          False)
    # Voussoir stones around the arch on both faces.
    nv = 9
    for side in (-1, 1):
        for k in range(nv):
            a0 = math.pi * k / nv + 0.015
            a1 = math.pi * (k + 1) / nv - 0.015
            ro = 0.2 + rng.uniform(-0.02, 0.03)

            def fn(sx, sy, sz, a0=a0, a1=a1, ro=ro, side=side):
                a = a0 if sx < 0 else a1
                rx, rz = (1.3, 0.42) if sz < 0 else (1.3 + ro, 0.42 + ro)
                x = side * (W + (0.07 if sy > 0 else -0.03))
                return (x, rx * math.cos(a), -0.35 + rz * math.sin(a))
            v, f = shaped_box(fn, 0.025, 1)
            b.add(v, f, jit(H("#cdbfa8"), rng, 0.06), "Kit", False)
    # Paver deck.
    rows, cols_ = 5, 3
    tl, tw = 4.0 / rows, 2.5 / cols_
    for r in range(rows):
        yc = -2.0 + tl * (r + 0.5)
        slope = math.atan2(deck_h(yc + 0.01) - deck_h(yc - 0.01), 0.02)
        for c in range(cols_):
            xc = -1.25 + tw * (c + 0.5) + (0.0 if r % 2 == 0 else 0.0)
            v, f = rbox(tw - 0.05, tl - 0.05, 0.1, 0.03)
            b.add(v, f, jit(PAVER[rng.randrange(4)], rng, 0.05), "Kit", False,
                  trs((xc, yc, deck_h(yc) - 0.05), 0, slope))
    # Parapets: low stone walls with cream caps, ceramic posts, planters on the end posts.
    posts = [-1.82, -0.62, 0.62, 1.82]
    wallc = H("#b8a48c")
    for side in (-1, 1):
        x = side * 1.42
        for i in range(len(posts) - 1):
            y0, y1 = posts[i], posts[i + 1]
            yc, ln = (y0 + y1) / 2, y1 - y0
            slope = math.atan2(deck_h(y1) - deck_h(y0), ln)
            v, f = rbox(0.2, ln, 0.42, 0.03)
            b.add(v, f, jit(wallc, rng, 0.04), "Kit", False, trs((x, yc, deck_h(yc) + 0.05), 0, slope))
            v, f = rbox(0.28, ln, 0.07, 0.025)
            b.add(v, f, CREAM, "KitCeramic", False, trs((x, yc, deck_h(yc) + 0.29), 0, slope))
        for k, y in enumerate(posts):
            end = k in (0, len(posts) - 1)
            s = 0.4 if end else 0.28
            top = deck_h(y) + (0.42 if end else 0.46)
            v, f = rbox(s, s, top + 0.35, 0.04)
            b.add(v, f, ceramic_col(), "KitCeramic", False, Matrix.Translation((x, y, (top - 0.35) / 2)))
            v, f = rbox(s + 0.05, s + 0.05, 0.05, 0.015)
            b.add(v, f, GOLD, "KitCeramic", False, Matrix.Translation((x, y, top - 0.02)))
            if end:
                planter(b, (x, y, top), rng, (PINK, WHITE, YELLOW) if side < 0 else (PURPLE, PINK, WHITE))
            else:
                v, f = revolve([(0.11, top), (0.12, top + 0.04), (0.08, top + 0.1), (0.0, top + 0.12)], 10)
                b.add(v, f, CREAM, "KitCeramic", True, Matrix.Translation((x, y, 0)))
    # Abutment rocks and bank foliage at the four corners.
    for sx in (-1, 1):
        for sy in (-1, 1):
            stone(b, (sx * 1.55, sy * 1.45, -0.55), (0.35, 0.32, 0.4), 1, sx * 3 + sy * 7, rng)
            stone(b, (sx * 1.75, sy * 1.85, -0.1), (0.25, 0.22, 0.2), 1, sx * 5 + sy * 11, rng)
            ground_leaves(b, rng, (sx * 1.7, sy * 1.75, 0), 0.0, 0.25, 6, 0.3)
            for j in range(3):
                flower(b, (sx * (1.6 + rng.uniform(0, 0.3)), sy * (1.6 + rng.uniform(0, 0.3)), 0.15),
                       (0, 0, 1), 0.08, rng.choice((PINK, YELLOW, WHITE)), YELLOW, 5, rng)
    return b.build("Kit_bridge", ao=(-0.5, 0.5, 0.6))


# ---- portal -------------------------------------------------------------------------------------------------------------

RI, ZC = 1.1, 1.0


def portal_inner(t):
    L = 2 * ZC + math.pi * RI
    s = t * L
    if s < ZC:
        return RI, s
    s -= ZC
    if s < math.pi * RI:
        a = s / RI
        return RI * math.cos(a), ZC + RI * math.sin(a)
    s -= math.pi * RI
    return -RI, ZC - s


def portal_outer(t):
    a = math.pi * t
    return 1.98 * math.cos(a), 2.95 * math.sin(a) ** 0.75


def k_portal():
    b, rng = B(), random.Random(111)
    T = 26
    ts = [i / T for i in range(T + 1)]
    ysec = [0.82, 0.3, -0.3, -0.9, -1.45]
    grass = H("#5f9a36")
    earth = H("#7d6a52")
    # Mound shell: inner tunnel surface + lumpy outer grass surface.
    inner_rows, outer_rows = [], []
    verts = []
    for j, y in enumerate(ysec):
        ri, ro = [], []
        k = 1.0 if y > -0.9 else 0.88
        for t in ts:
            xi, zi = portal_inner(t)
            xo, zo = portal_outer(t)
            xo, zo = xi + (xo - xi) * k, zi + (zo - zi) * k
            p = Vector((xo, y, zo))
            if 0 < t < 1:
                p += Vector((xo, 0, zo - 0.6)).normalized() * 0.18 * mnoise.noise(Vector((xo, y, zo)) * 1.2)
            ri.append(len(verts))
            verts.append(Vector((xi, y, zi)))
            ro.append(len(verts))
            verts.append(p)
        inner_rows.append(ri)
        outer_rows.append(ro)
    # back slope ring
    back = []
    for t, (iv, ov) in enumerate(zip(inner_rows[-1], outer_rows[-1])):
        pi, po = verts[iv], verts[ov]
        q = pi + (po - pi) * 0.45
        back.append(len(verts))
        verts.append(Vector((q.x * 1.05, -1.95, max(0.0, q.z - 0.25))))
    f_inner, f_outer, f_front, f_back = [], [], [], []
    for j in range(len(ysec) - 1):
        for i in range(T):
            a, bb = inner_rows[j], inner_rows[j + 1]
            f_inner.append((a[i], a[i + 1], bb[i + 1], bb[i]))
            a, bb = outer_rows[j], outer_rows[j + 1]
            f_outer.append((a[i], bb[i], bb[i + 1], a[i + 1]))
    for i in range(T):
        a, o = inner_rows[0], outer_rows[0]
        f_front.append((a[i], o[i], o[i + 1], a[i + 1]))
        o, k = outer_rows[-1], back
        f_outer.append((o[i], k[i], k[i + 1], o[i + 1]))
        a = inner_rows[-1]
        f_back.append((k[i], a[i], a[i + 1], k[i + 1]))

    def outer_col(p, i):
        g = mul(grass, 0.85 + 0.25 * mnoise.noise(p * 1.7))
        return mix(earth, g, min(1.0, max(0.0, p.z * 1.5 - 0.2)))
    vlist = verts
    b.add(vlist, f_outer, outer_col, "Kit", True)
    b.add(vlist, f_front, lambda p, i: mix(H("#6c7a4a"), grass, min(1, max(0, (p.z - 1.6) * 1.2))), "Kit", True)
    b.add(vlist, f_back, outer_col, "Kit", True)
    b.add(vlist, f_inner, lambda p, i: mix(DARK, H("#4a3f35"), max(0.0, min(1.0, (p.y + 0.6) / 1.5))), "Kit", True)
    # Glowing back of the tunnel.
    bv = [Vector((0, -1.42, 0.9))]
    for t in ts:
        xi, zi = portal_inner(t)
        bv.append(Vector((xi * 0.98, -1.42, zi * 0.98)))
    b.add(bv, [(0, i + 2, i + 1) for i in range(T)] + [(0, 1, T + 1)], H("#ff9a3a"), "GlowPortal", False)
    wall = [Vector((p.x * 1.02, -1.47, p.z * 1.01)) for p in bv]
    b.add(wall, [(0, i + 1, i + 2) for i in range(T)] + [(0, T + 1, 1)], DARK, "Kit", False)
    # Floor pavers in the tunnel.
    for r in range(4):
        yc = 1.25 - r * 0.7
        for c in (-1, 1):
            v, f = rbox(0.98, 0.64, 0.06, 0.02)
            col = jit(PAVER[rng.randrange(4)], rng, 0.05)
            if r >= 2:
                col = mul(col, 0.55 if r == 2 else 0.35)
            b.add(v, f, col, "Kit", False, Matrix.Translation((c * 0.51, yc, 0.01)))
    # Voussoir arch and jamb stones.
    nv = 9
    for k in range(nv):
        a0 = math.pi * k / nv + 0.012
        a1 = math.pi * (k + 1) / nv - 0.012
        ro = 1.72 + (0.12 if k == nv // 2 else rng.uniform(-0.05, 0.05))
        yf = 1.3 + (0.06 if k == nv // 2 else rng.uniform(-0.03, 0.03))

        def fn(sx, sy, sz, a0=a0, a1=a1, ro=ro, yf=yf):
            a = a0 if sx < 0 else a1
            r = RI - 0.02 if sz < 0 else ro
            return (r * math.cos(a), yf if sy > 0 else 0.7, ZC + r * math.sin(a))
        v, f = shaped_box(fn, 0.05, 1)
        col = CREAM if k == nv // 2 else jit(STONE[rng.randrange(4)], rng, 0.06)
        b.add(v, f, col, "KitCeramic" if k == nv // 2 else "Kit", False)
    for side in (-1, 1):
        for z0, z1 in ((0.0, 0.48), (0.5, 0.99)):
            def fn(sx, sy, sz, z0=z0, z1=z1, side=side):
                x = side * ((RI - 0.02) if sx < 0 else (1.74 + 0.03 * z0))
                return (x, 1.3 if sy > 0 else 0.7, z1 if sz > 0 else z0)
            v, f = shaped_box(fn, 0.05, 1)
            b.add(v, f, jit(STONE[rng.randrange(4)], rng, 0.06), "Kit", False)
    # Lanterns either side of the mouth.
    for side in (-1, 1):
        x, y = side * 1.72, 1.62
        prof = [(0.0, 0.0), (0.2, 0.0), (0.21, 0.07), (0.14, 0.14), (0.085, 0.19), (0.08, 0.8), (0.15, 0.85),
                (0.16, 0.9)]
        v, f = revolve(prof, 12)
        b.add(v, f, ceramic_col([(0.84, 0.91)]), "KitCeramic", True, Matrix.Translation((x, y, 0)))
        v, f = ico(3, 0.17)
        b.add(v, f, H("#ff9a3a"), "GlowPortal", True, Matrix.Translation((x, y, 1.05)))
        v, f = revolve([(0.1, 1.17), (0.18, 1.2), (0.13, 1.27), (0.0, 1.32)], 12)
        b.add(v, f, CREAM, "KitCeramic", True, Matrix.Translation((x, y, 0)))
    # Foliage over the top and around the base.
    for p, R_, fl in (((-0.9, 0.45, 2.45), 0.55, (PINK, YELLOW)), ((0.8, 0.5, 2.5), 0.6, (WHITE, PINK)),
                      ((0.0, 0.2, 2.85), 0.5, (YELLOW, PURPLE)), ((-1.45, -0.6, 1.4), 0.5, (PINK,)),
                      ((1.45, -0.7, 1.35), 0.5, (WHITE,)), ((0.0, -1.0, 2.5), 0.6, ())):
        bush(b, p, R_, R_ * 0.9, int(p[0] * 13 + p[1] * 7 + 200), fl, 5 if fl else 0, LEAF[rng.randrange(4)], 34, 3,
             rng)
    for sx in (-1, 1):
        stone(b, (sx * 1.65, 1.0, 0), (0.35, 0.3, 0.3), 1, sx * 4.4, rng)
        ground_leaves(b, rng, (sx * 1.85, 0.9, 0), 0.0, 0.2, 6, 0.3)
    return b.build("Kit_portal", ao=(0.0, 1.2, 0.6))


# ---- greenhouse ---------------------------------------------------------------------------------------------------------

def geodesic_cells(sub=2):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
    # Put a vertex at the very top so the apex is a cell centre.
    top = max(bm.verts, key=lambda v: v.co.z)
    rot = top.co.normalized().rotation_difference(Vector((0, 0, 1))).to_matrix()
    for v in bm.verts:
        v.co = rot @ v.co
    cells = []
    for v in bm.verts:
        n = v.co.normalized()
        cents = [f.calc_center_median().normalized() for f in v.link_faces]
        t1 = n.orthogonal().normalized()
        t2 = n.cross(t1)
        cents.sort(key=lambda c: math.atan2((c - n).dot(t2), (c - n).dot(t1)))
        cells.append((n, cents))
    bm.free()
    return cells


def k_greenhouse():
    b, rng = B(), random.Random(121)
    # Stone plinth + cream ceramic ring wall with a gold band.
    ring = [(3.96, 0.0), (3.96, 0.1), (3.8, 0.13), (3.74, 0.18), (3.72, 0.62), (3.66, 0.76), (3.5, 0.83),
            (3.22, 0.83), (3.16, 0.76), (3.0, 0.74)]
    v, f = revolve(ring, 72)

    def ring_col(p, i):
        if p.z < 0.12 and math.hypot(p.x, p.y) > 3.78:
            return mul(PAVER[3], 0.85 + 0.1 * mnoise.noise(p * 3))
        a = math.atan2(p.y, p.x) / (2 * math.pi) * 24
        line = abs(a - round(a)) < 0.03
        return mul(CREAM, 0.86) if line and p.z < 0.7 else mix(CREAM_SHADE, CREAM, min(1, 0.4 + p.z))
    b.add(v, f, ring_col, "KitCeramic", True)
    v, f = revolve([(3.715, 0.5), (3.75, 0.52), (3.75, 0.58), (3.715, 0.6)], 72)
    b.add(v, f, GOLD, "KitCeramic", True)
    # Geodesic dome: recessed glowing panels in a raised ceramic frame.
    R, zc, sq = 3.05, 0.74, 0.8
    for n, cents in geodesic_cells(2):
        if n.z < -0.02:
            continue
        pts = [Vector((c.x * R, c.y * R, c.z * R * sq + zc)) for c in cents]
        ctr = Vector((n.x * R, n.y * R, n.z * R * sq + zc))
        out = [(p - Vector((0, 0, zc))).normalized() * 0.05 for p in pts]
        outer = [p + o for p, o in zip(pts, out)]
        inner = [ctr + (p - ctr) * 0.84 + o for p, o in zip(pts, out)]
        panel = [ctr + (p - ctr) * 0.84 for p in pts]
        k = len(pts)
        verts = outer + inner + panel + [ctr - (ctr - Vector((0, 0, zc))).normalized() * 0.01]
        faces = []
        for i in range(k):
            j = (i + 1) % k
            faces.append((i, j, k + j, k + i))
            faces.append((k + i, k + j, 2 * k + j, 2 * k + i))
        top = abs(n.z) > 0.985
        frame_col = GOLD if top else CREAM
        b.add(verts, faces, lambda p, i: mix(CREAM_SHADE, frame_col, 0.6 + 0.4 * min(1, (p.z - zc) / 2.5)),
              "KitCeramic", True)
        if top:
            v2, f2 = revolve([(0.32, 0.0), (0.3, 0.12), (0.18, 0.2), (0.06, 0.32), (0.0, 0.38)], 10)
            b.add(v2, f2, GOLD, "KitCeramic", True, Matrix.Translation((0, 0, ctr.z + 0.02)))
        pv = panel + [ctr]
        b.add(pv, [(i, (i + 1) % k, k) for i in range(k)], H("#ffc95c"), "GlowDome", True)
    # Door vestibule at +Y.
    v, f = rbox(1.9, 1.1, 1.9, 0.06)
    b.add(v, f, ceramic_col(), "KitCeramic", False, Matrix.Translation((0, 3.4, 0.95)))
    roof = [(0.0, -0.58), (0.98, -0.58), (0.98, 0.58), (0.0, 0.58)]
    v, f = revolve(roof, 20)
    b.add(v, f, CREAM, "KitCeramic", True, trs((0, 3.4, 1.9), 0, math.pi / 2))
    v, f = revolve([(1.0, -0.6), (1.04, -0.56), (1.04, -0.5), (1.0, -0.46)], 20)
    b.add(v, f, GOLD, "KitCeramic", True, trs((0, 3.4, 1.9), 0, math.pi / 2))
    v, f = revolve([(0.0, 0.0), (0.16, 0.0), (0.14, 0.1), (0.05, 0.2), (0.0, 0.26)], 10)
    b.add(v, f, GOLD, "KitCeramic", True, Matrix.Translation((0, 3.5, 2.86)))
    # Door: glowing arched glass in a gold frame.
    dw, dh = 0.55, 1.35
    outline = [(dw, 0.05), (dw, dh)]
    for k in range(1, 12):
        a = math.pi * k / 12
        outline.append((dw * math.cos(a), dh + dw * math.sin(a)))
    outline += [(-dw, dh), (-dw, 0.05)]
    door_y = 3.965
    dv = [Vector((0, door_y, 0.9))] + [Vector((x, door_y, z)) for x, z in outline]
    nd = len(outline)
    b.add(dv, [(0, i + 1, i + 2) for i in range(nd - 1)] + [(0, nd, 1)], H("#ffc95c"), "GlowDome", False)
    frame = []
    for i in range(nd - 1):
        x0, z0 = outline[i]
        x1, z1 = outline[i + 1]
        frame.append(((x0, door_y + 0.02, z0), (x1, door_y + 0.02, z1)))
    fv, ff = [], []
    for p0, p1 in frame:
        tv, tf = tube([p0, p1], [0.05, 0.05], 5)
        base = len(fv)
        fv += tv
        ff += [tuple(base + i for i in q) for q in tf]
    b.add(fv, ff, GOLD, "KitCeramic", True)
    for p0, p1 in (((0, door_y + 0.03, 0.05), (0, door_y + 0.03, dh + dw)),
                   ((-dw, door_y + 0.03, dh), (dw, door_y + 0.03, dh))):
        tv, tf = tube([p0, p1], [0.03, 0.03], 5)
        b.add(tv, tf, GOLD, "KitCeramic", True)
    v, f = rbox(1.5, 0.5, 0.08, 0.03)
    b.add(v, f, PAVER[0], "Kit", False, Matrix.Translation((0, 3.75, 0.04)))
    # Foliage hugging the ring and filling the corners of the 8 x 8 m footprint.
    fl_sets = [(PINK, WHITE, YELLOW), (PURPLE, WHITE), (YELLOW, ORANGE), (PINK, MAGENTA, WHITE)]
    for i, ang in enumerate((25, 60, 120, 155, 200, 245, 295, 340)):
        a = math.radians(ang)
        r = 3.98 if (ang % 90) not in (0,) else 3.9
        R_ = 0.42 if abs(math.sin(2 * a)) < 0.6 else 0.55
        bush(b, (r * math.cos(a), r * math.sin(a), 0), R_, R_ * 1.1, 300 + i, fl_sets[i % 4], 6, LEAF[i % 4], 40, 3,
             rng)
    for sx in (-1, 1):
        for sy in (-1, 1):
            cx, cy = sx * 3.45, sy * 3.45
            stone(b, (cx + sx * 0.1, cy - sy * 0.25, 0), (0.32, 0.28, 0.28), 1, sx * 2 + sy * 9, rng)
            ground_leaves(b, rng, (cx, cy, 0), 0.0, 0.35, 7, 0.3)
            for j in range(4):
                flower(b, (cx + rng.uniform(-0.3, 0.3), cy + rng.uniform(-0.3, 0.3), 0.14), (0, 0, 1), 0.09,
                       fl_sets[(j + sx + 2) % 4][0], YELLOW, 5, rng)
    for sx in (-1, 1):
        bush(b, (sx * 1.35, 3.55, 0), 0.38, 0.45, 400 + sx, (PINK, WHITE), 4, LEAF[1], 26, 3, rng)
    return b.build("Kit_greenhouse", ao=(0.0, 1.0, 0.65))


# ---- export and preview -------------------------------------------------------------------------------------------------

def export(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    OUT.mkdir(parents=True, exist_ok=True)
    path = str(OUT / "kit.glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_normals=True,
        export_texcoords=False,
        export_vertex_color="ACTIVE",
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_lights=False,
        export_cameras=False,
        export_extras=False,
    )
    print(f"EXPORTED {path}")


def preview_material(name, color, rough=0.9, emission=None, alpha=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*lin(color), 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*lin(emission), 1.0)
        bsdf.inputs["Emission Strength"].default_value = 0.6
    return mat


def plane(name, x0, x1, y0, y1, z, mat):
    me = bpy.data.meshes.new(name)
    me.from_pydata([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], [], [(0, 1, 2, 3)])
    me.materials.append(mat)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def slab(name, x0, x1, y0, y1, z0, z1, mat):
    v, f = shaped_box(lambda a, b, c: (x0 if a < 0 else x1, y0 if b < 0 else y1, z0 if c < 0 else z1))
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(p) for p in v], [], f)
    me.materials.append(mat)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def setup_render(res):
    scene = bpy.context.scene
    for eng in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT", "CYCLES"):
        try:
            scene.render.engine = eng
            break
        except TypeError:
            continue
    if scene.render.engine == "CYCLES":
        scene.cycles.samples = 32
        scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    world = bpy.data.worlds.get("PrevWorld") or bpy.data.worlds.new("PrevWorld")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (*lin(H("#bcd3e6")), 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.9
    scene.world = world
    try:
        scene.view_settings.view_transform = "Standard"
    except TypeError:
        pass
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 3.2
    sun.data.color = (1.0, 0.9, 0.75)
    sun.data.angle = math.radians(6)
    sun.rotation_euler = (math.radians(50), 0, math.radians(35))
    scene.collection.objects.link(sun)
    return sun


def camera(name, target, dist, elev, azim, ortho=None):
    tgt = Vector(target)
    a, e = math.radians(azim), math.radians(elev)
    pos = tgt + Vector((math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e))) * dist
    cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
    if ortho:
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = ortho
    else:
        cam.data.lens = 50
    cam.data.clip_end = 500
    cam.location = pos
    cam.rotation_euler = (tgt - pos).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.collection.objects.link(cam)
    return cam


def render(cam, visible, name):
    scene = bpy.context.scene
    scene.camera = cam
    for o in scene.objects:
        if o.type == "MESH":
            o.hide_render = o not in visible
    scene.render.filepath = str(PREVIEW / f"{name}.png")
    bpy.ops.render.render(write_still=True)
    print(f"PREVIEW {scene.render.filepath}")


def inst(src, pos, yaw=0.0, scale=1.0):
    o = src.copy()
    bpy.context.scene.collection.objects.link(o)
    o.location = pos
    o.rotation_euler = (0, 0, yaw)
    o.scale = (scale, scale, scale)
    return o


def previews(objs):
    setup_render((1600, 900))
    grass_m = preview_material("PrevGrass", H("#6fa243"))
    soil_m = preview_material("PrevSoil", H("#6b5440"))
    water_m = preview_material("PrevWater", H("#3f9fd8"), 0.15, H("#2a7fc0"))
    path_m = preview_material("PrevPath", H("#e6cfa8"))
    ground = plane("PrevGround", -60, 60, -60, 60, -0.002, grass_m)

    # Lineup: hero pieces back row, small pieces front rows.
    lineup = []
    hero = {"portal": (-9, -6), "greenhouse": (0, -6), "bridge": (9, -6)}
    for n, (x, y) in hero.items():
        o = objs[n]
        o.location = (x, y, 0.35 if n == "bridge" else 0)
        lineup.append(o)
    small = [n for n in objs if n not in hero]
    for i, n in enumerate(small):
        row, col = divmod(i, 9)
        o = objs[n]
        o.location = (-10 + col * 2.5, 0.5 + row * 3.2, 0)
        lineup.append(o)
    cam = camera("CamLineup", (0, -2.5, 0.8), 40, 35, 0, ortho=27)
    render(cam, lineup + [ground], "kit_preview_lineup")
    cam2 = camera("CamSmall", (0, 3.4, 0.4), 30, 30, 0, ortho=21)
    render(cam2, lineup + [ground], "kit_preview_small")
    for o in lineup:
        o.location = (0, 0, 0)

    # Vignette: a stream along X with the bridge, greenhouse, portal and scattered foliage.
    vis = []
    vis.append(slab("BankN", -16, 16, 1.6, 16, -0.7, -0.002, grass_m))
    vis.append(slab("BankS", -16, 16, -16, -1.6, -0.7, -0.002, grass_m))
    vis.append(plane("Water", -16, 16, -1.7, 1.7, -0.35, water_m))
    vis.append(plane("StreamBed", -16, 16, -1.7, 1.7, -0.7, soil_m))
    vis.append(plane("PathN", -1.2, 1.2, 1.9, 4.6, 0.003, path_m))
    vis.append(plane("PathS", -1.2, 1.2, -9, -1.9, 0.003, path_m))
    vis.append(plane("PathW", -9, -1.2, -7.8, -5.4, 0.003, path_m))
    vis.append(inst(objs["bridge"], (0, 0, 0)))
    vis.append(inst(objs["greenhouse"], (0, 8.6, 0)))
    vis.append(inst(objs["portal"], (-9.5, -8.6, 0), math.radians(-90)))
    rng = random.Random(5)
    for x in (-1.8, 1.8):
        vis.append(inst(objs["lamp"], (x, 3.0, 0)))
        vis.append(inst(objs["lamp"], (x, -4.5, 0)))
    vis.append(inst(objs["solar"], (5.2, 3.0, 0), 0.4))
    vis.append(inst(objs["solar"], (-5.0, 3.2, 0), -0.3))
    for i in range(10):
        x = rng.uniform(-14, 14)
        if abs(x) < 2.6:
            continue
        side = rng.choice((-1, 1))
        vis.append(inst(objs[rng.choice(("rock_a", "rock_b", "rock_c"))], (x, side * 1.75, -0.15), rng.uniform(0, 6)))
    for i in range(6):
        x = rng.uniform(-13, 13)
        if abs(x) < 2.5:
            continue
        vis.append(inst(objs["lilypad"], (x, rng.uniform(-1.0, 1.0), -0.35), rng.uniform(0, 6)))
        vis.append(inst(objs["reeds"], (x + rng.uniform(-1, 1), rng.choice((-1.5, 1.5)), -0.1), rng.uniform(0, 6)))
    picks = ["bush_a", "bush_b", "fern", "flowers_a", "flowers_b", "flowers_c", "grass_tuft", "grass_tuft",
             "grass_tuft", "pebble"]
    placed = 0
    while placed < 110:
        x, y = rng.uniform(-15, 15), rng.uniform(-14, 14)
        if abs(y) < 2.2 or (abs(x) < 1.6 and -9.5 < y < 5) or (math.hypot(x, y - 8.6) < 4.5) or \
                (math.hypot(x + 9.5, y + 8.6) < 2.6) or (-9.5 < x < -1 and -8.2 < y < -5.0):
            continue
        vis.append(inst(objs[rng.choice(picks)], (x, y, 0), rng.uniform(0, 6), rng.uniform(0.85, 1.2)))
        placed += 1
    for p in ((6.5, 5.5), (-6.0, 7.0), (7.5, -6.0), (-13.0, -4.0), (12.0, 9.0), (-12.0, 10.0), (3.5, -9.0)):
        vis.append(inst(objs[rng.choice(("tree_a", "tree_b"))], (p[0], p[1], 0), rng.uniform(0, 6)))
    for y in (-3.0, -5.0, -7.0):
        vis.append(inst(objs["path_stone"], (-1.7, y, 0), rng.uniform(0, 6)))
    cam3 = camera("CamVignette", (-1.5, 0.0, 0), 40, 52, 8, ortho=30)
    render(cam3, vis, "kit_preview_vignette")
    cam4 = camera("CamVignetteClose", (-1.0, 2.5, 0.8), 15, 30, 20)
    render(cam4, vis, "kit_preview_close")
    cam5 = camera("CamPortal", (-9.5, -8.6, 1.3), 10, 18, -70)
    render(cam5, vis, "kit_preview_portal")
    cam6 = camera("CamGreenhouse", (0, 8.6, 1.5), 16, 25, 25)
    render(cam6, vis, "kit_preview_greenhouse")


NAMES = ["rock_a", "rock_b", "rock_c", "bush_a", "bush_b", "fern", "tree_a", "tree_b", "flowers_a", "flowers_b",
         "flowers_c", "grass_tuft", "reeds", "lilypad", "lamp", "solar", "bridge", "portal", "greenhouse",
         "path_stone", "pebble"]


def build_all():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    make_materials()
    builders = {
        "rock_a": k_rock_a, "rock_b": k_rock_b, "rock_c": k_rock_c, "bush_a": k_bush_a, "bush_b": k_bush_b,
        "fern": k_fern, "tree_a": k_tree_a, "tree_b": k_tree_b,
        "flowers_a": lambda: flower_bed("Kit_flowers_a", 201, (PINK, WHITE, MAGENTA), 7),
        "flowers_b": lambda: flower_bed("Kit_flowers_b", 202, (YELLOW, ORANGE, WHITE), 7),
        "flowers_c": lambda: flower_bed("Kit_flowers_c", 203, (PURPLE, BLUE, WHITE), 6, big=True),
        "grass_tuft": k_grass, "reeds": k_reeds, "lilypad": k_lilypad, "lamp": k_lamp, "solar": k_solar,
        "bridge": k_bridge, "portal": k_portal, "greenhouse": k_greenhouse, "path_stone": k_path_stone,
        "pebble": k_pebble,
    }
    objs = {n: builders[n]() for n in NAMES}
    for n, o in objs.items():
        d = o.dimensions
        print(f"KIT {n:11s} tris={tris(o):6d} size={d.x:.2f}x{d.y:.2f}x{d.z:.2f} "
              f"mats={[m.name for m in o.data.materials]}")
    export(list(objs.values()))
    if PREVIEW:
        PREVIEW.mkdir(parents=True, exist_ok=True)
        previews(objs)


if __name__ == "__main__":
    build_all()
