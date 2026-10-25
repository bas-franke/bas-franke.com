"""
Builds the Garden Sentinels towers (towers.glb) in Blender: five tower kinds, three levels each.

    blender --background --factory-startup --python build_garden_towers.py -- <output-dir> [preview-dir]

Style: cozy "advanced ceramic tech". Every tower stands on a round stone-ringed planter overflowing with leaves,
built from polished cream ceramic, brushed gunmetal, gold trim (level 3) and glowing amber / mint glass.
Everything is procedural geometry with plain materials (no textures), so the GLB stays small.

Conventions the frontend relies on (frontend/src/games/garden/api.ts, models.ts section):
  * one root per kind and level: `Tower_<kind>_<lv>`, kind in laser, shield, slow, missile, beacon, lv 1..3;
    origin at the ground centre, footprint inside a 1.8 m circle, front = Blender +Y (glTF -Z).
  * laser and missile: child empty `<root>_head` at the yaw axis; everything that turns hangs under it, aim = +Y.
    Muzzle empties `<root>_muzzle` or `<root>_muzzle0..N` under the head at the barrel tips.
  * shield, slow and beacon: one `<root>_muzzle` empty where the effect emits (core, flower centre, crystal tip).
  * materials: `Team` (tinted per player, near white), `Glow*` (emissive), Ceramic, CeramicMatte, Metal, Gold,
    Stone, StoneDark, Leaf, LeafDark, Soil, Glass. Planter meshes are shared between kinds of the same level.
"""

import math
import random
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = Path(ARGS[0]) if ARGS else Path("models/garden")
PREVIEW = Path(ARGS[1]) if len(ARGS) > 1 else None

KINDS = ("laser", "shield", "slow", "missile", "beacon")
TAU = math.tau


# ---- materials ---------------------------------------------------------------------------------------------------------

def srgb(hexstr):
    h = hexstr.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def material(name, color, rough=0.5, metal=0.0, emission=None, strength=0.0, alpha=1.0, double_sided=False,
             coat=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_fake_user = True
    mat.use_nodes = True
    mat.use_backface_culling = not double_sided
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*srgb(color), 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if coat and "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = coat
        bsdf.inputs["Coat Roughness"].default_value = 0.08
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*srgb(emission), 1.0)
        bsdf.inputs["Emission Strength"].default_value = strength
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
            if hasattr(mat, attr):
                try:
                    setattr(mat, attr, val)
                except TypeError:
                    pass
    mat.diffuse_color = (*srgb(color), alpha)
    return mat


def palette():
    return {
        "Ceramic": material("Ceramic", "#F5E7D6", rough=0.28, coat=0.4),
        "CeramicMatte": material("CeramicMatte", "#E2CDB3", rough=0.65),
        "Metal": material("Metal", "#3C424B", rough=0.38, metal=0.85),
        "Gold": material("Gold", "#E5AE45", rough=0.26, metal=1.0),
        "Stone": material("Stone", "#B3A795", rough=0.92),
        "StoneDark": material("StoneDark", "#8E8475", rough=0.95),
        "Leaf": material("Leaf", "#6BAF4B", rough=0.6, double_sided=True),
        "LeafDark": material("LeafDark", "#3E7A33", rough=0.7, double_sided=True),
        "Soil": material("Soil", "#4A3426", rough=1.0),
        "Team": material("Team", "#F2F2F0", rough=0.4),
        "Glass": material("Glass", "#FFB84D", rough=0.08, alpha=0.28, double_sided=True),
        "GlowAmber": material("GlowAmber", "#FF9A2E", rough=0.3, emission="#FFA940", strength=3.0),
        "GlowMint": material("GlowMint", "#12A397", rough=0.2, emission="#2FDCCD", strength=2.0),
        "GlowPetal": material("GlowPetal", "#34C9BD", rough=0.15, emission="#2FDCCD", strength=0.8),
        "GlowGreen": material("GlowGreen", "#8CFF5A", rough=0.3, emission="#7CFF4A", strength=3.0),
        "GlowYellow": material("GlowYellow", "#FFE27A", rough=0.3, emission="#FFD54A", strength=3.0),
    }


# ---- mesh builder ------------------------------------------------------------------------------------------------------

def mat4(loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    if isinstance(scale, (int, float)):
        scale = (scale, scale, scale)
    return Matrix.Translation(Vector(loc)) @ Euler(rot, "XYZ").to_matrix().to_4x4() @ Matrix.Diagonal((*scale, 1.0))


class Builder:
    """Accumulates many primitives into one bmesh with per-face materials."""

    def __init__(self, mats):
        self.bm = bmesh.new()
        self.mats = mats
        self.slots = []

    def slot(self, mat):
        if mat not in self.slots:
            self.slots.append(mat)
        return self.slots.index(mat)

    def merge(self, tmp, mat, M=None, smooth=True):
        if M is not None:
            tmp.transform(M)
        idx = self.slot(mat)
        vmap = {v: self.bm.verts.new(v.co) for v in tmp.verts}
        for f in tmp.faces:
            try:
                nf = self.bm.faces.new([vmap[v] for v in f.verts])
            except ValueError:
                continue
            nf.material_index = idx
            nf.smooth = smooth
        tmp.free()

    def mesh(self, name, sharp_angle=38.0, data=None):
        bm = self.bm
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        lim = math.radians(sharp_angle)
        for e in bm.edges:
            if len(e.link_faces) == 2:
                if e.calc_face_angle(0.0) > lim or not (e.link_faces[0].smooth and e.link_faces[1].smooth):
                    e.smooth = False
        me = data or bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        for m in self.slots:
            me.materials.append(self.mats[m] if isinstance(m, str) else m)
        return me


def obj_from_mesh(name, me, parent=None, loc=(0, 0, 0)):
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    o.parent = parent
    o.location = loc
    return o


def empty(name, parent=None, loc=(0, 0, 0), size=0.1):
    o = bpy.data.objects.new(name, None)
    o.empty_display_size = size
    o.empty_display_type = "PLAIN_AXES"
    bpy.context.collection.objects.link(o)
    o.parent = parent
    o.location = loc
    return o


# ---- primitives (all append into a Builder) ----------------------------------------------------------------------------

def box(b, size, mat, M=None, bevel=0.0, segs=2, smooth=True):
    tmp = bmesh.new()
    bmesh.ops.create_cube(tmp, size=1.0)
    tmp.transform(Matrix.Diagonal((*size, 1.0)))
    if bevel:
        bmesh.ops.bevel(tmp, geom=list(tmp.verts) + list(tmp.edges), offset=bevel, offset_type="OFFSET",
                        segments=segs, profile=0.5, affect="EDGES", clamp_overlap=True)
    b.merge(tmp, mat, M, smooth)


def cyl(b, r1, r2, depth, mat, M=None, seg=16, smooth=True, bevel=0.0):
    tmp = bmesh.new()
    bmesh.ops.create_cone(tmp, cap_ends=True, cap_tris=False, segments=seg, radius1=r1, radius2=r2, depth=depth)
    if bevel:
        rim = [e for e in tmp.edges if len(e.link_faces) == 2 and e.calc_face_angle(0) > 0.9]
        bmesh.ops.bevel(tmp, geom=rim, offset=bevel, offset_type="OFFSET", segments=2, profile=0.5,
                        affect="EDGES", clamp_overlap=True)
    b.merge(tmp, mat, M, smooth)


def sphere(b, r, mat, M=None, seg=16, rings=10, smooth=True):
    tmp = bmesh.new()
    bmesh.ops.create_uvsphere(tmp, u_segments=seg, v_segments=rings, radius=r)
    b.merge(tmp, mat, M, smooth)


def ico(b, r, mat, M=None, sub=1, smooth=False):
    tmp = bmesh.new()
    bmesh.ops.create_icosphere(tmp, subdivisions=sub, radius=r)
    b.merge(tmp, mat, M, smooth)


def torus(b, R, r, mat, M=None, seg=24, rseg=8, smooth=True):
    tmp = bmesh.new()
    rows = []
    for i in range(seg):
        a = TAU * i / seg
        row = []
        for j in range(rseg):
            t = TAU * j / rseg
            rr = R + r * math.cos(t)
            row.append(tmp.verts.new((rr * math.cos(a), rr * math.sin(a), r * math.sin(t))))
        rows.append(row)
    for i in range(seg):
        for j in range(rseg):
            a, c = rows[i], rows[(i + 1) % seg]
            tmp.faces.new((a[j], c[j], c[(j + 1) % rseg], a[(j + 1) % rseg]))
    b.merge(tmp, mat, M, smooth)


def lathe(b, profile, mat, M=None, seg=24, smooth=True, cap_top=True, cap_bottom=False):
    """Surface of revolution around Z from (r, z) pairs, bottom to top."""
    tmp = bmesh.new()
    rings = []
    for r, z in profile:
        if r < 1e-6:
            rings.append([tmp.verts.new((0, 0, z))])
        else:
            rings.append([tmp.verts.new((r * math.cos(TAU * k / seg), r * math.sin(TAU * k / seg), z))
                          for k in range(seg)])
    for i in range(len(rings) - 1):
        lo, hi = rings[i], rings[i + 1]
        for k in range(seg):
            k2 = (k + 1) % seg
            if len(lo) == 1:
                tmp.faces.new((lo[0], hi[k], hi[k2]))
            elif len(hi) == 1:
                tmp.faces.new((lo[k], hi[0], lo[k2])[::-1])
            else:
                tmp.faces.new((lo[k], lo[k2], hi[k2], hi[k]))
    if cap_top and len(rings[-1]) > 1:
        tmp.faces.new(rings[-1])
    if cap_bottom and len(rings[0]) > 1:
        tmp.faces.new(rings[0][::-1])
    bmesh.ops.recalc_face_normals(tmp, faces=tmp.faces)
    b.merge(tmp, mat, M, smooth)


def leaf(b, length, width, mat, M, curl=0.3, droop=0.25):
    """A folded leaf along +X: midrib ridge, two segments, a drooping tip (8 triangles)."""
    tmp = bmesh.new()
    L, W = length, width
    def p(x, y, z):
        return tmp.verts.new((x * L, y * W, z * L))
    base = p(0, 0, 0)
    r1, l1, c1 = p(0.33, -0.5, 0.04 + curl * 0.05), p(0.33, 0.5, 0.04 + curl * 0.05), p(0.33, 0, 0.0)
    r2, l2, c2 = p(0.68, -0.42, -droop * 0.3 + curl * 0.06), p(0.68, 0.42, -droop * 0.3 + curl * 0.06), \
        p(0.68, 0, -droop * 0.35)
    tip = p(1.0, 0, -droop)
    for f in ((base, r1, c1), (base, c1, l1), (c1, r1, r2, c2), (c1, c2, l2, l1), (c2, r2, tip), (c2, tip, l2)):
        tmp.faces.new(f)
    b.merge(tmp, mat, M, True)


def crystal(b, rings, mat, M=None, sides=6, twist=0.0):
    """Faceted spindle: rings = [(r, z), ...] with r = 0 for points."""
    tmp = bmesh.new()
    vr = []
    for i, (r, z) in enumerate(rings):
        if r < 1e-6:
            vr.append([tmp.verts.new((0, 0, z))])
        else:
            off = twist * i
            vr.append([tmp.verts.new((r * math.cos(TAU * k / sides + off), r * math.sin(TAU * k / sides + off), z))
                       for k in range(sides)])
    for i in range(len(vr) - 1):
        lo, hi = vr[i], vr[i + 1]
        for k in range(sides):
            k2 = (k + 1) % sides
            if len(lo) == 1:
                tmp.faces.new((lo[0], hi[k], hi[k2]))
            elif len(hi) == 1:
                tmp.faces.new((lo[k], lo[k2], hi[0]))
            else:
                tmp.faces.new((lo[k], lo[k2], hi[k2], hi[k]))
    bmesh.ops.recalc_face_normals(tmp, faces=tmp.faces)
    b.merge(tmp, mat, M, False)


def hex_shell(b, r, mat, M=None, sub=2, thickness=0.018, cut_below=-2.0):
    """Hexagon lattice on a sphere (the dual of an icosphere) turned into a thin wire frame."""
    src = bmesh.new()
    bmesh.ops.create_icosphere(src, subdivisions=sub, radius=1.0)
    src.faces.ensure_lookup_table()
    centers = {f.index: f.calc_center_median().normalized() * r for f in src.faces}
    tmp = bmesh.new()
    cv = {i: tmp.verts.new(c) for i, c in centers.items()}
    for v in src.verts:
        n = v.co.normalized()
        if n.z * r < cut_below:
            continue
        t1 = n.orthogonal().normalized()
        t2 = n.cross(t1)
        fs = sorted(v.link_faces, key=lambda f: math.atan2((f.calc_center_median() - v.co).dot(t2),
                                                           (f.calc_center_median() - v.co).dot(t1)))
        try:
            tmp.faces.new([cv[f.index] for f in fs])
        except ValueError:
            pass
    src.free()
    for v in [v for v in tmp.verts if not v.link_faces]:
        tmp.verts.remove(v)
    bmesh.ops.recalc_face_normals(tmp, faces=tmp.faces)
    bmesh.ops.wireframe(tmp, faces=list(tmp.faces), thickness=thickness, offset=0.0, use_replace=True,
                        use_boundary=True, use_even_offset=True)
    b.merge(tmp, mat, M, False)


# ---- planter base (shared per level) -----------------------------------------------------------------------------------

BASE_R = {1: 0.70, 2: 0.76, 3: 0.80}
BASE_H = {1: 0.36, 2: 0.40, 3: 0.44}
MAX_R = 0.83


def build_base(mats, lv):
    rnd = random.Random(100 + lv)
    b = Builder(mats)
    R, H = BASE_R[lv], BASE_H[lv]
    ring_r = R - 0.11
    # soil core (also hides the gaps between the stones)
    cyl(b, R - 0.1, R - 0.1, H - 0.05, "Soil", mat4((0, 0, (H - 0.05) / 2)), seg=24)
    courses = [(0.0, H)] if lv == 1 else [(0.0, H * 0.5), (H * 0.5, H)]
    for ci, (z0, z1) in enumerate(courses):
        n = 12 + 2 * lv
        off = (0.5 * ci) * TAU / n
        for i in range(n):
            a = TAU * i / n + off + rnd.uniform(-0.03, 0.03)
            arc = TAU * ring_r / n
            hgt = (z1 - z0) - 0.012 + rnd.uniform(-0.012, 0.01)
            size = (arc * rnd.uniform(0.86, 0.95), 0.22 + rnd.uniform(-0.02, 0.02), hgt)
            rr = ring_r + rnd.uniform(-0.01, 0.01)
            M = mat4((rr * math.cos(a), rr * math.sin(a), z0 + hgt / 2 + 0.004),
                     (rnd.uniform(-0.04, 0.04), rnd.uniform(-0.04, 0.04), a + math.pi / 2))
            box(b, size, "Stone" if rnd.random() < 0.7 else "StoneDark", M, bevel=0.035 if lv == 1 else 0.03,
                segs=2)
    if lv == 3:
        torus(b, ring_r + 0.118, 0.02, "Gold", mat4((0, 0, H - 0.07)), seg=48, rseg=6)
        torus(b, ring_r + 0.118, 0.016, "Gold", mat4((0, 0, 0.06)), seg=48, rseg=6)
        for i in range(8):
            a = TAU * (i + 0.5) / 8
            M = mat4(((ring_r + 0.13) * math.cos(a), (ring_r + 0.13) * math.sin(a), H * 0.5), (0, 0, a))
            ico(b, 0.035, "Gold", M @ Matrix.Diagonal((0.6, 1, 1, 1)), sub=1, smooth=True)

    # greenery: leaves spilling over the rim, a ring of bushes, small leaves around the centre
    zt = H - 0.02
    for i in range(10 + 2 * lv):
        a = TAU * i / (10 + 2 * lv) + rnd.uniform(-0.2, 0.2)
        rr = R - 0.17 + rnd.uniform(-0.03, 0.03)
        rb = rnd.uniform(0.09, 0.13)
        ico(b, rb, "LeafDark" if rnd.random() < 0.6 else "Leaf",
            mat4((rr * math.cos(a), rr * math.sin(a), zt + 0.02), (0, 0, rnd.uniform(0, 3)), (1.1, 1.0, 0.62)),
            sub=1, smooth=True)
    n_rim = 46 + 14 * lv
    for i in range(n_rim):
        a = TAU * i / n_rim + rnd.uniform(-0.08, 0.08)
        r0 = R - rnd.uniform(0.1, 0.26)
        pitch = rnd.uniform(-0.95, 0.4)
        L = rnd.uniform(0.17, 0.3)
        reach = r0 + L * max(math.cos(pitch), 0.6)
        if reach > MAX_R:
            L *= (MAX_R - r0) / max(reach - r0, 1e-3)
        yaw = a + rnd.uniform(-0.5, 0.5)
        M = mat4((r0 * math.cos(a), r0 * math.sin(a), zt + rnd.uniform(0.0, 0.05)),
                 (0, 0, yaw)) @ mat4(rot=(rnd.uniform(-0.4, 0.4), -pitch, 0))
        leaf(b, L, L * rnd.uniform(0.42, 0.55), "Leaf" if rnd.random() < 0.65 else "LeafDark", M,
             curl=rnd.uniform(0.1, 0.5), droop=rnd.uniform(0.1, 0.3))
    # leaves draping down the stone face
    for i in range(10 + 4 * lv):
        a = TAU * i / (10 + 4 * lv) + rnd.uniform(-0.15, 0.15)
        r0 = R - 0.05
        L = rnd.uniform(0.13, 0.19)
        M = mat4((r0 * math.cos(a), r0 * math.sin(a), H + 0.01), (0, 0, a + rnd.uniform(-0.3, 0.3))) @ \
            mat4(rot=(rnd.uniform(-0.3, 0.3), rnd.uniform(1.1, 1.4), 0))
        leaf(b, L, L * 0.5, "Leaf" if rnd.random() < 0.5 else "LeafDark", M, curl=0.3, droop=0.1)
    for i in range(16 + 4 * lv):
        a = rnd.uniform(0, TAU)
        r0 = rnd.uniform(0.2, R - 0.3)
        L = rnd.uniform(0.12, 0.2)
        M = mat4((r0 * math.cos(a), r0 * math.sin(a), zt - 0.01), (0, 0, a + rnd.uniform(-1.2, 1.2))) @ \
            mat4(rot=(rnd.uniform(-0.3, 0.3), -rnd.uniform(0.2, 0.7), 0))
        leaf(b, L, L * 0.5, "Leaf" if rnd.random() < 0.6 else "LeafDark", M, curl=0.3, droop=0.15)
    return b.mesh(f"TowerBase_{lv}"), H - 0.04


# ---- shared tower parts ------------------------------------------------------------------------------------------------

def team_band(b, r, z, lv):
    torus(b, r, 0.028 + 0.004 * lv, "Team", mat4((0, 0, z)), seg=32, rseg=6)


def plinth(b, z0, s, lv, top_r=0.2, height=0.42, metal_body=False):
    """Tapered ceramic column with a team band; returns the top z."""
    h = height * s
    body = "Metal" if metal_body else "Ceramic"
    lathe(b, [(0.33 * s, z0 - 0.04), (0.34 * s, z0 + 0.05 * s), (0.3 * s, z0 + 0.1 * s),
              (top_r * s * 1.05, z0 + h * 0.75), (top_r * s * 1.25, z0 + h * 0.92), (top_r * s * 1.25, z0 + h)],
          body, seg=28)
    team_band(b, 0.315 * s, z0 + 0.075 * s, lv)
    if lv >= 2:
        cyl(b, 0.36 * s, 0.36 * s, 0.035, "Metal" if not metal_body else "Ceramic", mat4((0, 0, z0 + 0.0)), seg=28)
    if lv == 3:
        torus(b, top_r * s * 1.27, 0.018, "Gold", mat4((0, 0, z0 + h * 0.93)), seg=28, rseg=6)
        torus(b, 0.34 * s, 0.016, "Gold", mat4((0, 0, z0 + 0.13 * s)), seg=28, rseg=6)
    return z0 + h


def side_lens(b, x, z, r, lv, y=0.0):
    sign = 1 if x > 0 else -1
    rot = (0, math.pi / 2, 0)
    torus(b, r, r * 0.26, "Gold" if lv == 3 else "Metal", mat4((x, y, z), rot), seg=24, rseg=8)
    cyl(b, r * 0.85, r * 0.85, 0.03, "Metal", mat4((x - sign * 0.01, y, z), rot), seg=20)
    sphere(b, r * 0.72, "GlowAmber", mat4((x + sign * 0.005, y, z), rot, (1, 1, 0.35)), seg=16, rings=8)


# ---- laser turret ------------------------------------------------------------------------------------------------------

def build_laser(mats, root, name, lv, z0):
    s = (1.0, 1.14, 1.28)[lv - 1]
    b = Builder(mats)
    ztop = plinth(b, z0, s, lv, top_r=0.19, height=0.36)
    cyl(b, 0.2 * s, 0.2 * s, 0.05, "Metal", mat4((0, 0, ztop + 0.02)), seg=24)
    obj_from_mesh(name + "_body", b.mesh(name + "_body"), root)

    head = empty(name + "_head", root, (0, 0, ztop + 0.045))
    h = Builder(mats)
    # turntable + neck
    cyl(h, 0.19 * s, 0.17 * s, 0.07 * s, "Metal", mat4((0, 0, 0.035 * s)), seg=24)
    s = s * (1.42, 1.3, 1.2)[lv - 1]
    zc = 0.24 * s
    cyl(h, 0.1 * s, 0.13 * s, 0.14 * s, "Metal", mat4((0, -0.02 * s, 0.1 * s)), seg=16)
    # rounded ceramic body
    sphere(h, 1.0, "Ceramic", mat4((0, -0.02 * s, zc), scale=(0.2 * s, 0.25 * s, 0.2 * s)), seg=24, rings=14)
    torus(h, 0.2 * s, 0.022 * s, "Gold" if lv == 3 else "Metal", mat4((0, -0.02 * s, zc), (math.pi / 2, 0, 0)),
          seg=28, rseg=6)
    side_lens(h, 0.215 * s, zc, 0.085 * s, lv)
    side_lens(h, -0.215 * s, zc, 0.085 * s, lv)
    # rear housing
    box(h, (0.22 * s, 0.14 * s, 0.18 * s), "CeramicMatte", mat4((0, -0.25 * s, zc)), bevel=0.04 * s, segs=3)
    if lv >= 2:
        # armour shells and a top sensor
        box(h, (0.09 * s, 0.36 * s, 0.07 * s), "CeramicMatte", mat4((0, -0.06 * s, zc + 0.18 * s), (0.12, 0, 0)),
            bevel=0.03 * s, segs=3)
        cyl(h, 0.035 * s, 0.045 * s, 0.05 * s, "Metal", mat4((0, 0.08 * s, zc + 0.2 * s)), seg=12)
        sphere(h, 0.028 * s, "GlowAmber", mat4((0, 0.08 * s, zc + 0.235 * s)), seg=10, rings=6)
    # barrel(s)
    barrels = [0.0] if lv < 3 else [-0.075 * s, 0.075 * s]
    br = (0.055, 0.06, 0.05)[lv - 1] * s
    blen = (0.3, 0.32, 0.3)[lv - 1] * s
    y0 = 0.13 * s
    tips = []
    for bx in barrels:
        cyl(h, br, br * 0.9, blen, "Metal", mat4((bx, y0 + blen / 2, zc), (-math.pi / 2, 0, 0)), seg=16)
        cyl(h, br * 1.45, br * 1.45, 0.12 * s, "Ceramic", mat4((bx, y0 + 0.08 * s, zc), (-math.pi / 2, 0, 0)),
            seg=20, bevel=0.012)
        nfins = (0, 3, 3)[lv - 1]
        for k in range(nfins):
            cyl(h, br * 1.35, br * 1.35, 0.018 * s, "Metal" if lv < 3 else "Gold",
                mat4((bx, y0 + (0.2 + 0.07 * k) * s, zc), (-math.pi / 2, 0, 0)), seg=16)
        ty = y0 + blen
        if lv == 3:
            box(h, (br * 2.6, 0.1 * s, br * 2.6), "Ceramic", mat4((bx, ty - 0.02 * s, zc)), bevel=0.018)
            torus(h, br * 1.05, br * 0.28, "GlowAmber", mat4((bx, ty + 0.035 * s, zc), (math.pi / 2, 0, 0)),
                  seg=16, rseg=6)
        else:
            cyl(h, br * 1.4, br * 1.25, 0.07 * s, "Ceramic", mat4((bx, ty, zc), (-math.pi / 2, 0, 0)), seg=18,
                bevel=0.01)
            torus(h, br * 0.95, br * 0.28, "GlowAmber", mat4((bx, ty + 0.038 * s, zc), (math.pi / 2, 0, 0)),
                  seg=16, rseg=6)
        sphere(h, br * 0.7, "GlowAmber", mat4((bx, ty + 0.03 * s, zc), scale=(1, 0.6, 1)), seg=12, rings=6)
        tips.append((bx, ty + 0.06 * s, zc))
    obj_from_mesh(name + "_turret", h.mesh(name + "_turret"), head)
    if len(tips) == 1:
        empty(name + "_muzzle", head, tips[0])
    else:
        for i, t in enumerate(tips):
            empty(f"{name}_muzzle{i}", head, t)


# ---- missile pod -------------------------------------------------------------------------------------------------------

def build_missile(mats, root, name, lv, z0):
    s = (1.0, 1.12, 1.24)[lv - 1]
    b = Builder(mats)
    ztop = plinth(b, z0, s, lv, top_r=0.19, height=0.5)
    cyl(b, 0.22 * s, 0.22 * s, 0.05, "Metal", mat4((0, 0, ztop + 0.02)), seg=24)
    obj_from_mesh(name + "_body", b.mesh(name + "_body"), root)

    head = empty(name + "_head", root, (0, 0, ztop + 0.045))
    h = Builder(mats)
    cyl(h, 0.21 * s, 0.19 * s, 0.07 * s, "Metal", mat4((0, 0, 0.035 * s)), seg=24)
    s = s * 1.22
    zc = 0.26 * s
    pitch = math.radians(10)
    P = mat4((0, 0, zc), (pitch, 0, 0))     # pod frame: tubes along local +Y, tilted up
    # trunnion core
    box(h, (0.2 * s, 0.24 * s, 0.22 * s), "Metal", mat4((0, -0.02 * s, 0.17 * s)), bevel=0.03 * s)
    # tube layout per level
    tr = 0.07 * s
    if lv == 1:
        layout = [(-0.085, 0.0), (0.085, 0.0)]
    elif lv == 2:
        layout = [(-0.085, -0.075), (0.085, -0.075), (-0.085, 0.075), (0.085, 0.075)]
    else:
        layout = [(-0.17, -0.07), (0.0, -0.07), (0.17, -0.07), (-0.17, 0.075), (0.0, 0.075), (0.17, 0.075)]
    tlen = (0.5, 0.52, 0.56)[lv - 1] * s
    ty0 = -0.2 * s
    xs = [x for x, _ in layout]
    zs = [z for _, z in layout]
    w = (max(xs) - min(xs)) * s + tr * 2 + 0.07 * s
    hh = (max(zs) - min(zs)) * s + tr * 2 + 0.07 * s
    # ceramic housing wrapping the tube bundle (rear two thirds)
    box(h, (w, tlen * 0.62, hh), "Ceramic", P @ mat4((0, ty0 + tlen * 0.31, 0)), bevel=0.05 * s, segs=3)
    box(h, (w * 0.9, 0.06 * s, hh * 0.9), "CeramicMatte", P @ mat4((0, ty0 - 0.02 * s, 0)), bevel=0.025 * s)
    if lv == 3:
        for yy in (ty0 + 0.05 * s, ty0 + tlen * 0.6):
            box(h, (w + 0.012, 0.02 * s, hh + 0.012), "Gold", P @ mat4((0, yy, 0)), bevel=0.006)
    tips = []
    for x, z in layout:
        x, z = x * s, z * s
        cyl(h, tr, tr, tlen, "Metal", P @ mat4((x, ty0 + tlen / 2, z), (-math.pi / 2, 0, 0)), seg=16)
        cyl(h, tr * 1.12, tr * 1.12, 0.05 * s, "Gold" if lv == 3 else "CeramicMatte",
            P @ mat4((x, ty0 + tlen - 0.025 * s, z), (-math.pi / 2, 0, 0)), seg=16, bevel=0.008)
        cyl(h, tr * 0.8, tr * 0.8, 0.02, "Soil", P @ mat4((x, ty0 + tlen + 0.0005, z), (-math.pi / 2, 0, 0)),
            seg=14)
        # missile nose peeking out of the tube
        cyl(h, tr * 0.62, 0.0, 0.1 * s, "GlowAmber", P @ mat4((x, ty0 + tlen + 0.02 * s, z), (-math.pi / 2, 0, 0)),
            seg=12)
        tips.append((P @ Vector((x, ty0 + tlen + 0.08 * s, z)))[:])
    # side drums with a lens (level 1 and 2), extra side pods on level 3 already cover that
    if lv < 3:
        for sx in (-1, 1):
            dx = sx * (w / 2 + 0.05 * s)
            cyl(h, 0.085 * s, 0.085 * s, 0.09 * s, "Ceramic", P @ mat4((dx, ty0 + 0.15 * s, -0.01), (0, math.pi / 2, 0)),
                seg=20, bevel=0.015)
            cyl(h, 0.05 * s, 0.05 * s, 0.1 * s, "Metal", P @ mat4((dx + sx * 0.01, ty0 + 0.15 * s, -0.01),
                                                                  (0, math.pi / 2, 0)), seg=14)
            sphere(h, 0.035 * s, "GlowAmber", P @ mat4((dx + sx * 0.05 * s, ty0 + 0.15 * s, -0.01)), seg=10, rings=6)
    if lv >= 2:
        # targeting sensor on top
        box(h, (0.08 * s, 0.12 * s, 0.05 * s), "Metal", P @ mat4((0, ty0 + 0.12 * s, hh / 2 + 0.02 * s)), bevel=0.01)
        sphere(h, 0.025 * s, "GlowAmber", P @ mat4((0, ty0 + 0.18 * s, hh / 2 + 0.03 * s)), seg=10, rings=6)
    if lv == 3:
        for sx in (-1, 1):
            torus(h, 0.08 * s, 0.018 * s, "Gold", P @ mat4((sx * (w / 2 + 0.005), ty0 + 0.22 * s, 0),
                                                         (0, math.pi / 2, 0)), seg=20, rseg=6)
            sphere(h, 0.05 * s, "GlowAmber", P @ mat4((sx * (w / 2 + 0.01), ty0 + 0.22 * s, 0), scale=(0.4, 1, 1)),
                   seg=12, rings=8)
    obj_from_mesh(name + "_turret", h.mesh(name + "_turret"), head)
    for i, t in enumerate(tips):
        empty(f"{name}_muzzle{i}", head, t)


# ---- bubble shield -----------------------------------------------------------------------------------------------------

def build_shield(mats, root, name, lv, z0):
    s = (1.0, 1.1, 1.2)[lv - 1]
    b = Builder(mats)
    # vase pedestal
    ph = 0.36 * s
    lathe(b, [(0.32 * s, z0 - 0.04), (0.33 * s, z0 + 0.05 * s), (0.25 * s, z0 + 0.12 * s), (0.16 * s, z0 + ph * 0.6),
              (0.2 * s, z0 + ph * 0.85), (0.27 * s, z0 + ph), (0.24 * s, z0 + ph + 0.03)], "Ceramic", seg=28)
    team_band(b, 0.305 * s, z0 + 0.075 * s, lv)
    if lv >= 2:
        cyl(b, 0.35 * s, 0.35 * s, 0.035, "Metal", mat4((0, 0, z0)), seg=28)
    R = (0.4, 0.44, 0.47)[lv - 1] * s
    zc = z0 + ph + R * 0.82
    # claws cupping the bubble
    nclaw = (4, 5, 6)[lv - 1]
    for i in range(nclaw):
        a = TAU * i / nclaw + math.pi / nclaw
        for k in range(3):
            t = -1.05 + 0.32 * k
            px, pz = math.cos(t) * (R + 0.02), math.sin(t) * (R + 0.02)
            M = mat4((math.cos(a) * px, math.sin(a) * px, zc + pz), (0, 0, a)) @ mat4(rot=(0, -t, 0))
            box(b, (0.035 * s, 0.07 * s, 0.13 * s), "Gold" if lv == 3 else "Metal", M, bevel=0.012)
    # core on a stalk
    cyl(b, 0.04 * s, 0.06 * s, R * 0.8, "Metal", mat4((0, 0, zc - R * 0.42)), seg=12)
    cyl(b, 0.08 * s, 0.06 * s, 0.05 * s, "Ceramic", mat4((0, 0, zc - 0.09 * s)), seg=16)
    sphere(b, (0.09, 0.1, 0.11)[lv - 1] * s, "GlowGreen", mat4((0, 0, zc)), seg=16, rings=10)
    # glass bubble with a glowing hex lattice
    sphere(b, R, "Glass", mat4((0, 0, zc)), seg=32, rings=18)
    hex_shell(b, R + 0.004, "GlowAmber", mat4((0, 0, zc)), sub=2, thickness=0.014 if lv == 1 else 0.016,
              cut_below=-R * 0.86)
    if lv >= 2:
        torus(b, R + 0.025, 0.02, "Gold" if lv == 3 else "Metal", mat4((0, 0, zc)), seg=40, rseg=6)
    if lv == 3:
        torus(b, R + 0.04, 0.016, "Gold", mat4((0, 0, zc), (math.radians(70), 0, 0)), seg=40, rseg=6)
        # crown finial
        cyl(b, 0.07 * s, 0.03 * s, 0.06 * s, "Gold", mat4((0, 0, zc + R + 0.02)), seg=12)
        crystal(b, [(0, 0), (0.035, 0.05), (0, 0.16)], "GlowAmber", mat4((0, 0, zc + R + 0.04)), sides=6)
    obj_from_mesh(name + "_body", b.mesh(name + "_body"), root)
    empty(name + "_muzzle", root, (0, 0, zc))


# ---- slow flower -------------------------------------------------------------------------------------------------------

def petal_ring(b, n, length, width, zc, tilt, offset, mat, thick=0.035):
    for i in range(n):
        a = TAU * i / n + offset
        M = mat4((0, 0, zc), (0, 0, a)) @ mat4(rot=(0, -tilt, 0)) @ \
            mat4((length * 0.5, 0, 0), scale=(length * 0.5, width * 0.5, thick))
        ico(b, 1.0, mat, M, sub=1, smooth=False)


def build_slow(mats, root, name, lv, z0):
    s = (1.0, 1.15, 1.3)[lv - 1]
    b = Builder(mats)
    # ceramic cup the flower grows from
    lathe(b, [(0.22 * s, z0 - 0.04), (0.24 * s, z0 + 0.04 * s), (0.2 * s, z0 + 0.1 * s), (0.17 * s, z0 + 0.16 * s),
              (0.19 * s, z0 + 0.2 * s), (0.15 * s, z0 + 0.21 * s)], "Ceramic", seg=24)
    team_band(b, 0.225 * s, z0 + 0.06 * s, lv)
    if lv == 3:
        torus(b, 0.19 * s, 0.014, "Gold", mat4((0, 0, z0 + 0.19 * s)), seg=24, rseg=6)
    stem_h = (0.7, 0.78, 0.86)[lv - 1] * s
    zc = z0 + 0.2 * s + stem_h
    # slightly curved stem
    pts = 6
    for i in range(pts):
        t0, t1 = i / pts, (i + 1) / pts
        x0, x1 = 0.04 * math.sin(t0 * math.pi), 0.04 * math.sin(t1 * math.pi)
        p0 = Vector((x0, 0, z0 + 0.15 * s + stem_h * t0))
        p1 = Vector((x1, 0, z0 + 0.15 * s + stem_h * t1))
        d = p1 - p0
        rot = d.to_track_quat("Z", "Y").to_euler()
        r = 0.035 * s * (1 - 0.3 * t0)
        cyl(b, r, r * 0.95, d.length + 0.01, "LeafDark", mat4((p0 + p1) / 2, rot), seg=10)
    # stem leaves
    nleaf = (2, 3, 4)[lv - 1]
    for i in range(nleaf):
        a = TAU * i / nleaf + 0.6
        zz = z0 + 0.25 * s + stem_h * (0.25 + 0.3 * (i % 2))
        M = mat4((0.02, 0, zz), (0, 0, a)) @ mat4(rot=(0.3, -0.5, 0))
        leaf(b, 0.32 * s, 0.15 * s, "Leaf", M, curl=0.4, droop=0.35)
    # sepals
    for i in range(6):
        a = TAU * i / 6
        M = mat4((0.03, 0, zc - 0.05 * s), (0, 0, a)) @ mat4(rot=(0, 0.2, 0))
        leaf(b, 0.13 * s, 0.07 * s, "Gold" if lv == 3 else "LeafDark", M, curl=0.2, droop=0.05)
    # crystal petals
    plen = (0.38, 0.4, 0.42)[lv - 1] * s
    if lv == 1:
        petal_ring(b, 6, plen, 0.2 * s, zc, math.radians(22), 0.0, "GlowPetal")
    elif lv == 2:
        petal_ring(b, 8, plen, 0.19 * s, zc - 0.01, math.radians(14), 0.0, "GlowPetal")
        petal_ring(b, 8, plen * 0.72, 0.15 * s, zc + 0.02, math.radians(38), TAU / 16, "GlowPetal")
    else:
        petal_ring(b, 10, plen, 0.18 * s, zc - 0.02, math.radians(10), 0.0, "GlowPetal")
        petal_ring(b, 10, plen * 0.75, 0.15 * s, zc + 0.01, math.radians(32), TAU / 20, "GlowPetal")
        petal_ring(b, 6, plen * 0.45, 0.11 * s, zc + 0.04, math.radians(58), 0.0, "GlowMint")
        torus(b, 0.1 * s, 0.016, "Gold", mat4((0, 0, zc + 0.03)), seg=24, rseg=6)
        for i in range(10):
            a = TAU * (i + 0.5) / 10
            sphere(b, 0.018 * s, "Gold", mat4((math.cos(a) * 0.12 * s, math.sin(a) * 0.12 * s, zc + 0.035)),
                   seg=8, rings=5)
    # glowing centre
    rc = (0.08, 0.095, 0.105)[lv - 1] * s
    sphere(b, rc, "GlowYellow", mat4((0, 0, zc + 0.03 + 0.02 * (lv - 1)), scale=(1, 1, 0.7)), seg=16, rings=10)
    for i in range(8 + 2 * lv):
        a = TAU * i / (8 + 2 * lv)
        sphere(b, 0.016 * s, "GlowYellow", mat4((math.cos(a) * rc * 1.15, math.sin(a) * rc * 1.15,
                                                 zc + 0.04 + 0.02 * (lv - 1))),
               seg=6, rings=4)
    obj_from_mesh(name + "_body", b.mesh(name + "_body"), root)
    empty(name + "_muzzle", root, (0, 0, zc + 0.07 + 0.02 * (lv - 1)))


# ---- energy beacon -----------------------------------------------------------------------------------------------------

def build_beacon(mats, root, name, lv, z0):
    s = (1.0, 1.13, 1.26)[lv - 1]
    b = Builder(mats)
    ph = 0.3 * s
    lathe(b, [(0.3 * s, z0 - 0.04), (0.31 * s, z0 + 0.05 * s), (0.22 * s, z0 + 0.1 * s), (0.17 * s, z0 + ph * 0.7),
              (0.24 * s, z0 + ph * 0.9), (0.25 * s, z0 + ph), (0.14 * s, z0 + ph + 0.02)], "Ceramic", seg=28)
    team_band(b, 0.29 * s, z0 + 0.075 * s, lv)
    cyl(b, 0.16 * s, 0.12 * s, 0.06 * s, "Metal", mat4((0, 0, z0 + ph + 0.04 * s)), seg=16)
    if lv >= 2:
        cyl(b, 0.34 * s, 0.34 * s, 0.035, "Metal", mat4((0, 0, z0)), seg=28)
    # crystal spindle
    ch = (0.78, 0.92, 1.06)[lv - 1] * s
    cr = (0.17, 0.18, 0.19)[lv - 1] * s
    zb = z0 + ph + 0.06 * s
    crystal(b, [(0.0, 0.0), (cr * 0.7, ch * 0.13), (cr, ch * 0.38), (cr * 0.9, ch * 0.6), (cr * 0.5, ch * 0.84),
                (0.0, ch)], "GlowMint", mat4((0, 0, zb)), sides=8, twist=0.0)
    zm = zb + ch * 0.45
    # gyro rings
    rr = cr + (0.17, 0.2, 0.22)[lv - 1] * s
    rings = [((math.radians(90), 0, 0), "Gold")]
    if lv >= 2:
        rings.append(((math.radians(90), 0, math.radians(90)), "Gold"))
    if lv == 3:
        rings.append(((0, 0, 0), "Gold"))
    for i, (rot, mat) in enumerate(rings):
        R = rr + 0.035 * i
        torus(b, R, 0.022 * s, mat, mat4((0, 0, zm), rot), seg=40, rseg=8)
    # lower gold cradle ring on short posts
    torus(b, cr + 0.08 * s, 0.02 * s, "Gold", mat4((0, 0, zb + 0.04 * s)), seg=32, rseg=6)
    for i in range(3 + lv):
        a = TAU * i / (3 + lv)
        cx, cy = math.cos(a) * (cr + 0.08 * s), math.sin(a) * (cr + 0.08 * s)
        cyl(b, 0.014 * s, 0.014 * s, 0.08 * s, "Gold", mat4((cx, cy, zb)), seg=8)
    # ring pivots (little gold beads where the rings would hinge)
    for sx in (-1, 1):
        sphere(b, 0.035 * s, "Gold", mat4((sx * rr, 0, zm)), seg=10, rings=6)
    if lv >= 2:
        for i in range(lv + 1):
            a = TAU * i / (lv + 1) + 0.4
            M = mat4((math.cos(a) * (rr + 0.12 * s), math.sin(a) * (rr + 0.12 * s), zm + 0.12 * s * math.sin(a * 2)),
                     (0.3, 0.2, a))
            crystal(b, [(0, -0.07 * s), (0.035 * s, 0.0), (0, 0.09 * s)], "GlowMint", M, sides=5)
    if lv == 3:
        # crown above the tip
        zt = zb + ch + 0.02
        torus(b, 0.09 * s, 0.014 * s, "Gold", mat4((0, 0, zt - 0.08 * s)), seg=24, rseg=6)
        for i in range(6):
            a = TAU * i / 6
            M = mat4((math.cos(a) * 0.09 * s, math.sin(a) * 0.09 * s, zt - 0.08 * s), (0, 0, a)) @ \
                mat4(rot=(0, -0.35, 0))
            crystal(b, [(0, 0), (0.016 * s, 0.03 * s), (0, 0.1 * s)], "Gold", M, sides=4)
    obj_from_mesh(name + "_body", b.mesh(name + "_body"), root)
    empty(name + "_muzzle", root, (0, 0, zb + ch + 0.03))


BUILDERS = {"laser": build_laser, "shield": build_shield, "slow": build_slow, "missile": build_missile,
            "beacon": build_beacon}


# ---- export / preview --------------------------------------------------------------------------------------------------

def descendants(o):
    out = [o]
    for c in o.children:
        out += descendants(c)
    return out


def export(roots):
    bpy.ops.object.select_all(action="DESELECT")
    for r in roots:
        for o in descendants(r):
            o.select_set(True)
    bpy.context.view_layer.objects.active = roots[0]
    OUT.mkdir(parents=True, exist_ok=True)
    path = str(OUT / "towers.glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_normals=True,
        export_texcoords=False,
        export_vertex_color="NONE",
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_lights=False,
        export_cameras=False,
        export_extras=False,
    )
    print(f"EXPORTED {path}")


def render_previews(roots):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 40
    scene.cycles.use_denoising = True
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for dev in ("OPTIX", "CUDA", "HIP"):
            try:
                prefs.compute_device_type = dev
                prefs.get_devices()
                if any(d.type == dev for d in prefs.devices):
                    for d in prefs.devices:
                        d.use = True
                    scene.cycles.device = "GPU"
                    break
            except TypeError:
                continue
    except Exception:
        pass
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("PrevWorld")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.62, 0.7, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.7
    scene.world = world
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 4.0
    sun.data.color = (1.0, 0.9, 0.75)
    sun.data.angle = math.radians(6)
    sun.rotation_euler = (math.radians(40), math.radians(-15), math.radians(-30))
    bpy.context.collection.objects.link(sun)
    gm = material("PrevGround", "#9DB36E", rough=0.95)
    gb = Builder({"g": gm})
    box(gb, (40, 40, 0.02), gm, mat4((0, 0, -0.011)))
    ground = obj_from_mesh("PrevGround", gb.mesh("PrevGround"))
    cam = bpy.data.objects.new("PrevCam", bpy.data.cameras.new("PrevCam"))
    bpy.context.collection.objects.link(cam)
    scene.camera = cam

    def shoot(fname, target, dist, elev, azim, lens, res):
        scene.render.resolution_x, scene.render.resolution_y = res
        tgt = Vector(target)
        a, e = math.radians(azim), math.radians(elev)
        cam.location = tgt + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * dist
        cam.rotation_euler = (tgt - cam.location).to_track_quat("-Z", "Y").to_euler()
        cam.data.lens = lens
        scene.render.filepath = str(PREVIEW / fname)
        bpy.ops.render.render(write_still=True)
        print(f"PREVIEW {scene.render.filepath}")

    # lineup: kinds along X, levels along Y (lv1 in front)
    for r in roots:
        _, kind, lv = r.name.split("_")
        r.location = (KINDS.index(kind) * 2.0 - 4.0, (int(lv) - 2) * 2.2, 0)
    # towers face the camera (-Y side) for the lineup; aim stays +Y in the export
    for r in roots:
        r.rotation_euler = (0, 0, math.pi)
    shoot("towers_preview_lineup.png", (0, 0, 0.6), 15.5, 55, 0, 50, (1600, 1300))
    shoot("towers_preview_lineup34.png", (0, 0, 0.7), 13.0, 28, 25, 50, (1600, 1100))
    for r in roots:
        r.rotation_euler = (0, 0, math.radians(200))
    for kind in KINDS:
        for r in roots:
            _, k, lv = r.name.split("_")
            r.hide_render = k != kind
            for o in descendants(r):
                o.hide_render = k != kind
            r.location = ((int(lv) - 2) * 2.0, 0, 0)
        shoot(f"towers_preview_{kind}.png", (0, 0, 0.9), 8.6, 24, 12, 50, (1500, 800))
    for r in roots:
        r.location = (0, 0, 0)
        r.rotation_euler = (0, 0, 0)
        for o in descendants(r):
            o.hide_render = False
    for o in (sun, ground, cam):
        bpy.data.objects.remove(o, do_unlink=True)


def build_all():
    random.seed(7)
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    mats = palette()
    bases = {lv: build_base(mats, lv) for lv in (1, 2, 3)}
    roots = []
    for kind in KINDS:
        for lv in (1, 2, 3):
            name = f"Tower_{kind}_{lv}"
            root = empty(name, None, (0, 0, 0), size=0.5)
            base_me, z0 = bases[lv]
            obj_from_mesh(name + "_base", base_me, root)
            BUILDERS[kind](mats, root, name, lv, z0)
            roots.append(root)
    bpy.context.view_layer.update()
    for r in roots:
        tris = 0
        top = 0.0
        rad = 0.0
        for o in descendants(r):
            if o.type == "MESH":
                tris += sum(len(p.vertices) - 2 for p in o.data.polygons)
                for v in o.data.vertices:
                    w = o.matrix_world @ v.co
                    top = max(top, w.z)
                    rad = max(rad, math.hypot(w.x, w.y))
        print(f"TOWER {r.name} tris~{tris} height={top:.2f} radius={rad:.2f}")
    export(roots)
    if PREVIEW:
        PREVIEW.mkdir(parents=True, exist_ok=True)
        render_previews(roots)


if __name__ == "__main__":
    build_all()
