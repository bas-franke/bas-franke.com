"""
Builds the Garden Sentinels towers (towers.glb) in Blender: six tower kinds, three levels each.

    blender --background --factory-startup --python build_garden_towers.py -- <output-dir> [preview-dir]

Style: cozy "advanced ceramic tech". Every tower stands on a round stone-ringed planter overflowing with leaves,
built from polished cream ceramic, warm bronze (joints, barrels, housings), gold trim (level 3) and a strong glow in
the kind's colour: amber laser lens, orange-red missile tips, amber shield dome, mint flower, teal beacon crystal,
water-blue sprinkler tank.
Everything is procedural geometry with plain materials (no textures), so the GLB stays small.

Conventions the frontend relies on (frontend/src/games/garden/api.ts, models.ts section):
  * one root per kind and level: `Tower_<kind>_<lv>`, kind in laser, shield, slow, missile, beacon,
    sprinkler, lv 1..3;
    origin at the ground centre, footprint inside a 1.8 m circle, front = Blender +Y (glTF -Z).
  * laser, missile and sprinkler: child empty `<root>_head` at the yaw axis; everything that turns hangs under it, aim = +Y.
    Muzzle empties `<root>_muzzle` or `<root>_muzzle0..N` under the head at the barrel tips.
  * shield, slow and beacon: one `<root>_muzzle` empty where the effect emits (core, flower centre, crystal tip).
  * materials: `Team` (tinted per player, near white; only the small pennant on the planter rim), `Glow*` (emissive:
    GlowAmber, GlowMissile, GlowShield (translucent dome), GlowMint, GlowPetal, GlowGreen, GlowYellow, GlowWater,
    GlowWaterGlass (translucent sprinkler dome) and the
    kind-coloured plinth bands GlowBand_<kind>), Ceramic, CeramicBlue (sprinkler tank), Bronze, BronzeDark, Copper,
    Gold, Stone, StoneDark, Leaf, LeafDark, Soil. Planter meshes are shared between kinds of the same level.
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

KINDS = ("laser", "shield", "slow", "missile", "beacon", "sprinkler")
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
        "Gold": material("Gold", "#E5AE45", rough=0.26, metal=1.0),
        "Stone": material("Stone", "#B3A795", rough=0.92),
        "StoneDark": material("StoneDark", "#8E8475", rough=0.95),
        "Leaf": material("Leaf", "#6BAF4B", rough=0.6, double_sided=True),
        "LeafDark": material("LeafDark", "#3E7A33", rough=0.7, double_sided=True),
        "Soil": material("Soil", "#4A3426", rough=1.0),
        "Bronze": material("Bronze", "#6B5444", rough=0.34, metal=0.7, coat=0.2),
        "BronzeDark": material("BronzeDark", "#3A2E28", rough=0.42, metal=0.55),
        "Team": material("Team", "#F2F2F0", rough=0.4),
        "GlowAmber": material("GlowAmber", "#FF9A2E", rough=0.3, emission="#FFA940", strength=3.0),
        "GlowMissile": material("GlowMissile", "#FF6A26", rough=0.3, emission="#FF7A30", strength=3.2),
        "GlowShield": material("GlowShield", "#FFB24A", rough=0.06, emission="#FFB24A", strength=0.55, alpha=0.42,
                               double_sided=True),
        "GlowMint": material("GlowMint", "#12A397", rough=0.2, emission="#2FDCCD", strength=2.0),
        "GlowPetal": material("GlowPetal", "#36D8CA", rough=0.25, emission="#4EE6D9", strength=0.6,
                              double_sided=True),
        "GlowGreen": material("GlowGreen", "#8CFF5A", rough=0.3, emission="#7CFF4A", strength=3.0),
        "GlowYellow": material("GlowYellow", "#FFD27A", rough=0.3, emission="#FFD27A", strength=2.6),
        # plinth band in the tower kind's colour (baked: the owner colour lives on the small Team pennant)
        "GlowBand_laser": material("GlowBand_laser", "#FFA940", rough=0.3, emission="#FFA940", strength=1.6),
        "GlowBand_missile": material("GlowBand_missile", "#FF6A26", rough=0.3, emission="#FF7A30", strength=1.6),
        "GlowBand_shield": material("GlowBand_shield", "#FFC060", rough=0.3, emission="#FFB24A", strength=1.4),
        "GlowBand_slow": material("GlowBand_slow", "#4EE6D9", rough=0.3, emission="#4EE6D9", strength=1.3),
        "GlowBand_beacon": material("GlowBand_beacon", "#1FC79A", rough=0.3, emission="#22D8A4", strength=1.4),
        # sprinkler cannon: glazed blue tank, copper pipes, water-blue glow (#2EB3FF)
        "CeramicBlue": material("CeramicBlue", "#2F7FC4", rough=0.24, coat=0.5),
        "Copper": material("Copper", "#C0703F", rough=0.3, metal=1.0),
        "GlowWater": material("GlowWater", "#1E9BF0", rough=0.2, emission="#2EB3FF", strength=1.8),
        "GlowWaterGlass": material("GlowWaterGlass", "#8FD8FF", rough=0.05, emission="#2EB3FF", strength=0.45,
                                   alpha=0.4, double_sided=True),
        "GlowBand_sprinkler": material("GlowBand_sprinkler", "#2EB3FF", rough=0.3, emission="#2EB3FF", strength=1.5),
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

BASE_R = {1: 0.68, 2: 0.73, 3: 0.77}
BASE_H = {1: 0.36, 2: 0.40, 3: 0.44}
MAX_R = 0.82


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

def kind_band(b, kind, r, z, lv):
    """Glowing band round the foot of the plinth in the tower kind's colour (amber, orange, mint, teal...)."""
    torus(b, r, 0.036 + 0.006 * lv, f"GlowBand_{kind}", mat4((0, 0, z)), seg=32, rseg=6)


def team_pennant(b, z0, lv):
    """Small owner-coloured pennant on the planter rim (front-left): the only `Team` part of a tower."""
    a = math.radians(135)
    r = BASE_R[lv] - 0.1
    x, y = r * math.cos(a), r * math.sin(a)
    zb = z0 + 0.03
    ph = 0.38
    cyl(b, 0.016, 0.013, ph, "BronzeDark", mat4((x, y, zb + ph / 2)), seg=8)
    cyl(b, 0.04, 0.04, 0.03, "BronzeDark", mat4((x, y, zb + 0.015)), seg=10)
    sphere(b, 0.055, "Team", mat4((x, y, zb + ph + 0.02)), seg=10, rings=6)
    # flag flies outward along the radius, gently waved (two panels)
    ux, uy = math.cos(a), math.sin(a)
    for i, (d0, d1, wv) in enumerate(((0.0, 0.11, 0.015), (0.11, 0.21, -0.01))):
        cx = x + ux * (d0 + d1) / 2 - uy * wv
        cy = y + uy * (d0 + d1) / 2 + ux * wv
        hgt = 0.14 - 0.03 * i
        box(b, (d1 - d0 + 0.006, 0.014, hgt), "Team", mat4((cx, cy, zb + ph - 0.08 - 0.012 * i), (0, 0, a)), bevel=0.004,
            segs=1)


def plinth(b, z0, s, lv, kind, top_r=0.2, height=0.36):
    """Tapered ceramic column: kind-coloured glow band at the foot, bronze collar on top; returns the top z."""
    h = height * s
    lathe(b, [(0.34 * s, z0 - 0.04), (0.35 * s, z0 + 0.05 * s), (0.31 * s, z0 + 0.1 * s),
              (top_r * s * 1.05, z0 + h * 0.72), (top_r * s * 1.22, z0 + h * 0.9), (top_r * s * 1.22, z0 + h)],
          "Ceramic", seg=28)
    kind_band(b, kind, 0.33 * s, z0 + 0.075 * s, lv)
    cyl(b, top_r * s * 1.32, top_r * s * 1.28, 0.06 * s, "Bronze", mat4((0, 0, z0 + h - 0.015 * s)), seg=28,
        bevel=0.008)
    if lv >= 2:
        cyl(b, 0.38 * s, 0.38 * s, 0.04, "BronzeDark", mat4((0, 0, z0 + 0.0)), seg=28)
        for i in range(6):
            a = TAU * i / 6
            box(b, (0.05 * s, 0.03 * s, h * 0.5), "Bronze",
                mat4((math.cos(a) * top_r * s * 1.12, math.sin(a) * top_r * s * 1.12, z0 + h * 0.55), (0, 0, a + math.pi / 2)) @
                mat4(rot=(0.18, 0, 0)), bevel=0.008, segs=1)
    if lv == 3:
        torus(b, top_r * s * 1.34, 0.02, "Gold", mat4((0, 0, z0 + h - 0.015 * s)), seg=28, rseg=6)
        torus(b, 0.345 * s, 0.017, "Gold", mat4((0, 0, z0 + 0.135 * s)), seg=28, rseg=6)
    return z0 + h + 0.015 * s


def side_lens(b, x, z, r, lv, y=0.0):
    sign = 1 if x > 0 else -1
    rot = (0, math.pi / 2, 0)
    torus(b, r, r * 0.3, "Gold" if lv == 3 else "Bronze", mat4((x, y, z), rot), seg=24, rseg=8)
    cyl(b, r * 0.9, r * 0.9, 0.04, "BronzeDark", mat4((x - sign * 0.012, y, z), rot), seg=20)
    sphere(b, r * 0.76, "GlowAmber", mat4((x + sign * 0.006, y, z), rot, (1, 1, 0.4)), seg=16, rings=8)


# ---- laser turret ------------------------------------------------------------------------------------------------------

def build_laser(mats, root, name, lv, z0):
    s = (0.95, 1.0, 1.05)[lv - 1]
    b = Builder(mats)
    ztop = plinth(b, z0, s, lv, "laser", top_r=0.2, height=0.3)
    cyl(b, 0.25 * s, 0.25 * s, 0.05, "BronzeDark", mat4((0, 0, ztop + 0.02)), seg=24)
    team_pennant(b, z0, lv)
    obj_from_mesh(name + "_body", b.mesh(name + "_body"), root)

    head = empty(name + "_head", root, (0, 0, ztop + 0.045))
    h = Builder(mats)
    k = (1.12, 1.2, 1.3)[lv - 1]
    # turntable + bronze neck
    cyl(h, 0.24 * k, 0.22 * k, 0.07 * k, "BronzeDark", mat4((0, 0, 0.035 * k)), seg=24)
    cyl(h, 0.12 * k, 0.15 * k, 0.16 * k, "Bronze", mat4((0, -0.02 * k, 0.12 * k)), seg=16)
    zc = 0.31 * k
    # rounded ceramic body with a bronze belt
    sphere(h, 1.0, "Ceramic", mat4((0, -0.03 * k, zc), scale=(0.27 * k, 0.3 * k, 0.26 * k)), seg=22, rings=12)
    torus(h, 0.262 * k, 0.034 * k, "Gold" if lv == 3 else "Bronze", mat4((0, -0.04 * k, zc), (math.pi / 2, 0, 0)),
          seg=28, rseg=8)
    side_lens(h, 0.275 * k, zc, 0.11 * k, lv, y=-0.03 * k)
    side_lens(h, -0.275 * k, zc, 0.11 * k, lv, y=-0.03 * k)
    # rear housing (dark bronze) with a vent glow
    box(h, (0.27 * k, 0.17 * k, 0.21 * k), "BronzeDark", mat4((0, -0.33 * k, zc)), bevel=0.045 * k, segs=3)
    box(h, (0.16 * k, 0.02, 0.05 * k), "GlowAmber", mat4((0, -0.42 * k, zc + 0.03 * k)), bevel=0.008)
    if lv >= 2:
        # bronze armour crest and a top sensor
        box(h, (0.12 * k, 0.42 * k, 0.07 * k), "Bronze", mat4((0, -0.08 * k, zc + 0.24 * k), (0.1, 0, 0)),
            bevel=0.03 * k, segs=3)
        cyl(h, 0.04 * k, 0.05 * k, 0.05 * k, "BronzeDark", mat4((0, 0.1 * k, zc + 0.26 * k)), seg=12)
        sphere(h, 0.034 * k, "GlowAmber", mat4((0, 0.1 * k, zc + 0.3 * k)), seg=10, rings=6)
    if lv == 3:
        # cheek plates
        for sx in (-1, 1):
            box(h, (0.05 * k, 0.26 * k, 0.2 * k), "Bronze", mat4((sx * 0.2 * k, -0.2 * k, zc - 0.02 * k), (0, 0, sx * 0.25)),
                bevel=0.02 * k, segs=2)
    # barrel(s): bronze, amber lens at the tip
    barrels = [0.0] if lv < 3 else [-0.085 * k, 0.085 * k]
    br = (0.075, 0.082, 0.068)[lv - 1] * k
    y0 = 0.2 * k
    ty = (0.62, 0.69, 0.76)[lv - 1]
    blen = ty - y0
    tips = []
    for bx in barrels:
        cyl(h, br, br * 0.92, blen, "Bronze", mat4((bx, y0 + blen / 2, zc), (-math.pi / 2, 0, 0)), seg=16)
        cyl(h, br * 1.55, br * 1.55, 0.14 * k, "Ceramic", mat4((bx, y0 + 0.07 * k, zc), (-math.pi / 2, 0, 0)),
            seg=20, bevel=0.014)
        nfins = (1, 3, 3)[lv - 1]
        for j in range(nfins):
            cyl(h, br * 1.38, br * 1.38, 0.022 * k, "BronzeDark" if lv < 3 else "Gold",
                mat4((bx, y0 + 0.18 * k + (blen - 0.3 * k) * (j + 0.5) / max(nfins, 1), zc), (-math.pi / 2, 0, 0)), seg=16)
        cyl(h, br * 1.5, br * 1.32, 0.08 * k, "BronzeDark", mat4((bx, ty, zc), (-math.pi / 2, 0, 0)), seg=18, bevel=0.01)
        torus(h, br * 1.05, br * 0.3, "GlowAmber", mat4((bx, ty + 0.042 * k, zc), (math.pi / 2, 0, 0)), seg=16, rseg=6)
        sphere(h, br * 0.95, "GlowAmber", mat4((bx, ty + 0.03 * k, zc), scale=(1, 0.55, 1)), seg=14, rings=8)
        tips.append((bx, ty + 0.07 * k, zc))
    obj_from_mesh(name + "_turret", h.mesh(name + "_turret"), head)
    if len(tips) == 1:
        empty(name + "_muzzle", head, tips[0])
    else:
        for i, t in enumerate(tips):
            empty(f"{name}_muzzle{i}", head, t)


# ---- missile pod -------------------------------------------------------------------------------------------------------

def build_missile(mats, root, name, lv, z0):
    s = (0.95, 1.0, 1.05)[lv - 1]
    b = Builder(mats)
    ztop = plinth(b, z0, s, lv, "missile", top_r=0.21, height=0.34)
    cyl(b, 0.26 * s, 0.26 * s, 0.05, "BronzeDark", mat4((0, 0, ztop + 0.02)), seg=24)
    team_pennant(b, z0, lv)
    obj_from_mesh(name + "_body", b.mesh(name + "_body"), root)

    head = empty(name + "_head", root, (0, 0, ztop + 0.045))
    h = Builder(mats)
    k = (1.1, 1.2, 1.3)[lv - 1]
    cyl(h, 0.25 * k, 0.23 * k, 0.07 * k, "BronzeDark", mat4((0, 0, 0.035 * k)), seg=24)
    zc = 0.32 * k
    pitch = math.radians(22)
    P = mat4((0, 0, zc), (pitch, 0, 0))     # pod frame: tubes along local +Y, tilted up
    # tube layout per level (2x2, 2x2 heavier, 3x2)
    if lv == 1:
        tr, sp = 0.075 * k, 0.17 * k
        layout = [(-0.5, -0.5), (0.5, -0.5), (-0.5, 0.5), (0.5, 0.5)]
    elif lv == 2:
        tr, sp = 0.08 * k, 0.18 * k
        layout = [(-0.5, -0.5), (0.5, -0.5), (-0.5, 0.5), (0.5, 0.5)]
    else:
        tr, sp = 0.075 * k, 0.17 * k
        layout = [(-1, -0.5), (0, -0.5), (1, -0.5), (-1, 0.5), (0, 0.5), (1, 0.5)]
    tlen = (0.46, 0.48, 0.5)[lv - 1] * k
    ty0 = -0.24 * k
    xs = [x * sp for x, _ in layout]
    zs = [z * sp for _, z in layout]
    w = (max(xs) - min(xs)) + tr * 2 + 0.08 * k
    hh = (max(zs) - min(zs)) + tr * 2 + 0.08 * k
    # yoke: bronze trunnion block + side arms with ceramic drums
    box(h, (w * 0.55, 0.26 * k, 0.2 * k), "Bronze", mat4((0, -0.02 * k, 0.17 * k)), bevel=0.03 * k)
    for sx in (-1, 1):
        dx = sx * (w / 2 + 0.045 * k)
        box(h, (0.06 * k, 0.2 * k, 0.26 * k), "BronzeDark", mat4((dx, -0.02 * k, zc - 0.06 * k)), bevel=0.02 * k)
        cyl(h, 0.11 * k, 0.11 * k, 0.08 * k, "Ceramic", mat4((dx + sx * 0.03 * k, -0.02 * k, zc), (0, math.pi / 2, 0)),
            seg=20, bevel=0.016)
        cyl(h, 0.06 * k, 0.06 * k, 0.1 * k, "Bronze", mat4((dx + sx * 0.05 * k, -0.02 * k, zc), (0, math.pi / 2, 0)),
            seg=14)
        sphere(h, 0.04 * k, "GlowMissile", mat4((dx + sx * 0.1 * k, -0.02 * k, zc), scale=(0.5, 1, 1)), seg=10, rings=6)
    # bronze housing round the tube bundle (rear 70 %) and a dark back plate
    box(h, (w, tlen * 0.7, hh), "Bronze", P @ mat4((0, ty0 + tlen * 0.35, 0)), bevel=0.05 * k, segs=3)
    box(h, (w * 0.9, 0.06 * k, hh * 0.9), "BronzeDark", P @ mat4((0, ty0 - 0.02 * k, 0)), bevel=0.025 * k)
    # glowing stripes on top so the kind reads from above
    for sx in ((-0.25, 0.25) if lv < 3 else (-0.33, 0.0, 0.33)):
        box(h, (0.035 * k, tlen * 0.5, 0.02), "GlowMissile", P @ mat4((sx * w, ty0 + tlen * 0.36, hh / 2 + 0.004)),
            bevel=0.006, segs=1)
    if lv >= 2:
        for yy in (ty0 + 0.05 * k, ty0 + tlen * 0.62):
            box(h, (w + 0.014, 0.025 * k, hh + 0.014), "Gold" if lv == 3 else "BronzeDark", P @ mat4((0, yy, 0)),
                bevel=0.006)
    tips = []
    for x, z in layout:
        x, z = x * sp, z * sp
        cyl(h, tr, tr, tlen, "BronzeDark", P @ mat4((x, ty0 + tlen / 2, z), (-math.pi / 2, 0, 0)), seg=16)
        cyl(h, tr * 1.14, tr * 1.14, 0.05 * k, "Gold" if lv == 3 else "Bronze",
            P @ mat4((x, ty0 + tlen - 0.025 * k, z), (-math.pi / 2, 0, 0)), seg=16, bevel=0.008)
        torus(h, tr * 0.9, tr * 0.18, "GlowMissile", P @ mat4((x, ty0 + tlen + 0.003, z), (math.pi / 2, 0, 0)),
              seg=16, rseg=5)
        cyl(h, tr * 0.78, tr * 0.78, 0.02, "Soil", P @ mat4((x, ty0 + tlen - 0.004, z), (-math.pi / 2, 0, 0)), seg=14)
        # missile nose peeking out of the tube
        cyl(h, tr * 0.66, 0.0, 0.11 * k, "GlowMissile", P @ mat4((x, ty0 + tlen + 0.03 * k, z), (-math.pi / 2, 0, 0)),
            seg=12)
        tips.append((P @ Vector((x, ty0 + tlen + 0.09 * k, z)))[:])
    if lv >= 2:
        # targeting sensor on top
        box(h, (0.09 * k, 0.13 * k, 0.05 * k), "BronzeDark", P @ mat4((0, ty0 + 0.1 * k, hh / 2 + 0.025 * k)), bevel=0.01)
        sphere(h, 0.03 * k, "GlowMissile", P @ mat4((0, ty0 + 0.16 * k, hh / 2 + 0.035 * k)), seg=10, rings=6)
    obj_from_mesh(name + "_turret", h.mesh(name + "_turret"), head)
    for i, t in enumerate(tips):
        empty(f"{name}_muzzle{i}", head, t)


# ---- bubble shield -----------------------------------------------------------------------------------------------------

def build_shield(mats, root, name, lv, z0):
    s = (1.0, 1.04, 1.08)[lv - 1]
    b = Builder(mats)
    # low ceramic pedestal: the amber dome is the tower
    lathe(b, [(0.36 * s, z0 - 0.04), (0.37 * s, z0 + 0.05 * s), (0.33 * s, z0 + 0.1 * s), (0.3 * s, z0 + 0.14 * s),
              (0.34 * s, z0 + 0.17 * s), (0.31 * s, z0 + 0.19 * s)], "Ceramic", seg=32)
    kind_band(b, "shield", 0.35 * s, z0 + 0.075 * s, lv)
    team_pennant(b, z0, lv)
    if lv >= 2:
        cyl(b, 0.39 * s, 0.39 * s, 0.04, "BronzeDark", mat4((0, 0, z0)), seg=28)
    R = (0.55, 0.59, 0.62)[lv - 1]
    cut = 0.3                                     # dome is cut 0.3 R below its centre
    zc = z0 + 0.18 * s + R * cut
    # bronze seat ring the dome stands in
    torus(b, R * math.sqrt(1 - cut * cut) + 0.01, 0.04, "Bronze", mat4((0, 0, zc - R * cut + 0.01)), seg=40, rseg=8)
    # claws cupping the dome
    nclaw = (4, 5, 6)[lv - 1]
    for i in range(nclaw):
        a = TAU * i / nclaw + math.pi / nclaw
        for j in range(2 + (lv >= 2)):
            t = -0.28 + 0.3 * j
            px, pz = math.cos(t) * (R + 0.022), math.sin(t) * (R + 0.022)
            M = mat4((math.cos(a) * px, math.sin(a) * px, zc + pz), (0, 0, a)) @ mat4(rot=(0, -t, 0))
            box(b, (0.04, 0.08, 0.15), "Gold" if lv == 3 else "Bronze", M, bevel=0.014)
    # core on a bronze stalk
    cyl(b, 0.045, 0.07, R * 0.55, "Bronze", mat4((0, 0, zc - R * 0.2)), seg=12)
    cyl(b, 0.1, 0.07, 0.05, "Ceramic", mat4((0, 0, zc + 0.02)), seg=16)
    sphere(b, (0.11, 0.12, 0.13)[lv - 1], "GlowGreen", mat4((0, 0, zc + 0.11)), seg=16, rings=10)
    # amber glass dome with a glowing hex lattice
    prof = []
    a0 = -math.asin(cut)
    for i in range(15):
        t = a0 + (math.pi / 2 - a0) * i / 14
        prof.append((max(R * math.cos(t), 0.0) if i < 14 else 0.0, zc + R * math.sin(t)))
    lathe(b, prof, "GlowShield", seg=32, cap_top=False)
    hex_shell(b, R + 0.005, "GlowAmber", mat4((0, 0, zc)), sub=2, thickness=0.02 if lv == 1 else 0.022,
              cut_below=-R * cut)
    if lv >= 2:
        torus(b, R + 0.02, 0.024, "Gold" if lv == 3 else "Bronze", mat4((0, 0, zc + R * 0.35), ), seg=40, rseg=6)
    if lv == 3:
        cyl(b, 0.08, 0.035, 0.07, "Gold", mat4((0, 0, zc + R + 0.025)), seg=12)
        crystal(b, [(0, 0), (0.04, 0.05), (0, 0.17)], "GlowAmber", mat4((0, 0, zc + R + 0.05)), sides=6)
    obj_from_mesh(name + "_body", b.mesh(name + "_body"), root)
    empty(name + "_muzzle", root, (0, 0, zc + 0.11))


# ---- slow flower -------------------------------------------------------------------------------------------------------

def petal(b, length, width, mat, M, cup=0.05, lift=0.06, nu=7, nv=5):
    """Broad rounded petal along +X: cupped across, lifted towards the tip (single surface, double-sided material)."""
    tmp = bmesh.new()
    rows = []
    for i in range(nu + 1):
        u = i / nu
        half = width * 0.5 * (0.25 + 0.75 * math.sin(math.pi * u ** 0.62) ** 0.55) if u < 1 else 0.0
        row = []
        for j in range(nv):
            v = -1 + 2 * j / (nv - 1)
            row.append(tmp.verts.new((u * length, v * half, cup * v * v * (1 - 0.3 * u) + lift * u * u)))
        rows.append(row)
    for i in range(nu):
        for j in range(nv - 1):
            try:
                tmp.faces.new((rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1]))
            except ValueError:
                pass
    bmesh.ops.remove_doubles(tmp, verts=tmp.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(tmp, faces=tmp.faces)
    for f in tmp.faces:
        if f.normal.z < 0:
            f.normal_flip()
    b.merge(tmp, mat, M, True)


def petal_ring(b, n, length, width, zc, tilt, offset, mat, r0=0.05, cup=0.05):
    for i in range(n):
        a = TAU * i / n + offset
        M = mat4((0, 0, zc), (0, 0, a)) @ mat4((r0, 0, 0), (0, -tilt, 0))
        petal(b, length, width, mat, M, cup=cup)


def build_slow(mats, root, name, lv, z0):
    s = (1.0, 1.05, 1.1)[lv - 1]
    b = Builder(mats)
    # ceramic cup the flower grows from
    lathe(b, [(0.26 * s, z0 - 0.04), (0.28 * s, z0 + 0.04 * s), (0.24 * s, z0 + 0.1 * s), (0.2 * s, z0 + 0.16 * s),
              (0.23 * s, z0 + 0.2 * s), (0.18 * s, z0 + 0.21 * s)], "Ceramic", seg=28)
    kind_band(b, "slow", 0.27 * s, z0 + 0.06 * s, lv)
    team_pennant(b, z0, lv)
    torus(b, 0.215 * s, 0.022, "Gold" if lv == 3 else "Bronze", mat4((0, 0, z0 + 0.2 * s)), seg=28, rseg=6)
    stem_h = (0.35, 0.39, 0.43)[lv - 1]
    zc = z0 + 0.2 * s + stem_h
    # short, thick, slightly curved stem
    pts = 5
    for i in range(pts):
        t0, t1 = i / pts, (i + 1) / pts
        x0, x1 = 0.035 * math.sin(t0 * math.pi), 0.035 * math.sin(t1 * math.pi)
        p0 = Vector((x0, 0, z0 + 0.15 * s + stem_h * t0))
        p1 = Vector((x1, 0, z0 + 0.15 * s + stem_h * t1))
        d = p1 - p0
        rot = d.to_track_quat("Z", "Y").to_euler()
        r = 0.07 * (1 - 0.25 * t0)
        cyl(b, r, 0.07 * (1 - 0.25 * t1), d.length + 0.01, "LeafDark", mat4((p0 + p1) / 2, rot), seg=12)
    # two broad leaves
    for i, (a, zf) in enumerate(((0.5, 0.25), (0.5 + math.pi, 0.5))):
        M = mat4((0.02, 0, z0 + 0.2 * s + stem_h * zf), (0, 0, a)) @ mat4(rot=(0.2, -0.45, 0))
        leaf(b, 0.42 * s, 0.22 * s, "Leaf", M, curl=0.45, droop=0.3)
    # sepals
    for i in range(8):
        a = TAU * (i + 0.5) / 8
        M = mat4((0.04, 0, zc - 0.05), (0, 0, a)) @ mat4(rot=(0, 0.15, 0))
        leaf(b, 0.17, 0.09, "Gold" if lv == 3 else "LeafDark", M, curl=0.2, droop=0.05)
    # bloom: 8 broad mint petals, about 1.0-1.1 m across
    plen = (0.45, 0.47, 0.5)[lv - 1]
    pw = (0.3, 0.31, 0.32)[lv - 1]
    petal_ring(b, 8, plen, pw, zc, math.radians(12), 0.0, "GlowPetal", r0=0.06, cup=0.05)
    if lv == 2:
        petal_ring(b, 8, plen * 0.5, pw * 0.7, zc + 0.03, math.radians(30), TAU / 16, "GlowPetal", r0=0.05, cup=0.03)
    if lv == 3:
        petal_ring(b, 8, plen * 0.72, pw * 0.85, zc + 0.04, math.radians(28), TAU / 16, "GlowPetal", r0=0.05, cup=0.04)
        torus(b, 0.15, 0.02, "Gold", mat4((0, 0, zc + 0.06)), seg=28, rseg=6)
    # amber centre
    rc = (0.13, 0.135, 0.14)[lv - 1]
    zcore = zc + 0.05 + 0.02 * (lv - 1)
    sphere(b, rc, "GlowYellow", mat4((0, 0, zcore), scale=(1, 1, 0.6)), seg=18, rings=10)
    for i in range(10 + 2 * lv):
        a = TAU * i / (10 + 2 * lv)
        sphere(b, 0.02, "GlowYellow", mat4((math.cos(a) * rc * 1.12, math.sin(a) * rc * 1.12, zcore + 0.02)),
               seg=6, rings=4)
    obj_from_mesh(name + "_body", b.mesh(name + "_body"), root)
    empty(name + "_muzzle", root, (0, 0, zcore + 0.06))


# ---- energy beacon -----------------------------------------------------------------------------------------------------

def build_beacon(mats, root, name, lv, z0):
    s = (1.0, 1.1, 1.2)[lv - 1]
    b = Builder(mats)
    ph = 0.28 * s
    lathe(b, [(0.32 * s, z0 - 0.04), (0.33 * s, z0 + 0.05 * s), (0.24 * s, z0 + 0.1 * s), (0.18 * s, z0 + ph * 0.7),
              (0.24 * s, z0 + ph * 0.9), (0.25 * s, z0 + ph), (0.14 * s, z0 + ph + 0.02)], "Ceramic", seg=28)
    kind_band(b, "beacon", 0.31 * s, z0 + 0.075 * s, lv)
    team_pennant(b, z0, lv)
    cyl(b, 0.17 * s, 0.13 * s, 0.07 * s, "Bronze", mat4((0, 0, z0 + ph + 0.04 * s)), seg=16, bevel=0.01)
    torus(b, 0.25 * s, 0.025, "Bronze", mat4((0, 0, z0 + ph)), seg=28, rseg=6)
    if lv >= 2:
        cyl(b, 0.36 * s, 0.36 * s, 0.04, "BronzeDark", mat4((0, 0, z0)), seg=28)
    # crystal spindle
    ch = (0.8, 0.88, 0.96)[lv - 1] * s
    cr = (0.18, 0.19, 0.2)[lv - 1] * s
    zb = z0 + ph + 0.07 * s
    crystal(b, [(0.0, 0.0), (cr * 0.7, ch * 0.13), (cr, ch * 0.38), (cr * 0.9, ch * 0.6), (cr * 0.5, ch * 0.84),
                (0.0, ch)], "GlowMint", mat4((0, 0, zb)), sides=8, twist=0.0)
    zm = zb + ch * 0.45
    # thick gold gyro rings
    rr = cr + (0.15, 0.17, 0.19)[lv - 1] * s
    rings = [(math.radians(90), 0, 0)]
    if lv >= 2:
        rings.append((math.radians(90), 0, math.radians(90)))
    if lv == 3:
        rings.append((0, 0, 0))
    for i, rot in enumerate(rings):
        R = rr + 0.05 * i
        torus(b, R, 0.04 * s, "Gold", mat4((0, 0, zm), rot), seg=40, rseg=8)
    # lower gold cradle ring on short bronze posts
    torus(b, cr + 0.08 * s, 0.03 * s, "Gold", mat4((0, 0, zb + 0.04 * s)), seg=32, rseg=8)
    for i in range(3 + lv):
        a = TAU * i / (3 + lv)
        cx, cy = math.cos(a) * (cr + 0.08 * s), math.sin(a) * (cr + 0.08 * s)
        cyl(b, 0.02 * s, 0.02 * s, 0.09 * s, "Bronze", mat4((cx, cy, zb)), seg=8)
    # ring pivots
    for sx in (-1, 1):
        sphere(b, 0.055 * s, "Bronze", mat4((sx * rr, 0, zm)), seg=12, rings=8)
    if lv >= 2:
        for i in range(lv + 1):
            a = TAU * i / (lv + 1) + 0.4
            M = mat4((math.cos(a) * (rr + 0.12 * s), math.sin(a) * (rr + 0.12 * s), zm + 0.12 * s * math.sin(a * 2)),
                     (0.3, 0.2, a))
            crystal(b, [(0, -0.07 * s), (0.035 * s, 0.0), (0, 0.09 * s)], "GlowMint", M, sides=5)
    if lv == 3:
        # crown above the tip
        zt = zb + ch + 0.02
        torus(b, 0.09 * s, 0.02 * s, "Gold", mat4((0, 0, zt - 0.08 * s)), seg=24, rseg=6)
        for i in range(6):
            a = TAU * i / 6
            M = mat4((math.cos(a) * 0.09 * s, math.sin(a) * 0.09 * s, zt - 0.08 * s), (0, 0, a)) @ \
                mat4(rot=(0, -0.35, 0))
            crystal(b, [(0, 0), (0.018 * s, 0.03 * s), (0, 0.1 * s)], "Gold", M, sides=4)
    obj_from_mesh(name + "_body", b.mesh(name + "_body"), root)
    empty(name + "_muzzle", root, (0, 0, zb + ch + 0.03))


# ---- sprinkler cannon --------------------------------------------------------------------------------------------------

def pipe(b, pts, r, mat, seg=8, joints=True):
    """Bent pipe through the given points: one cylinder per segment, balls at the bends."""
    pts = [Vector(p) for p in pts]
    for p0, p1 in zip(pts, pts[1:]):
        d = p1 - p0
        rot = d.to_track_quat("Z", "Y").to_euler()
        cyl(b, r, r, d.length, mat, mat4((p0 + p1) / 2, rot), seg=seg)
    if joints:
        for p in pts[1:-1]:
            sphere(b, r * 1.25, mat, mat4(p), seg=seg, rings=6)


def bell_nozzle(h, P, x, z, k, lv, rad=0.12, length=0.26):
    """Short wide bronze nozzle along local +Y of frame P: ceramic sleeve, flared bell, glowing water mouth.
    Returns the tip position in head space."""
    rot = (-math.pi / 2, 0, 0)            # lathe +Z -> +Y
    L = length * k
    R = rad * k
    cyl(h, R * 0.74, R * 0.74, L * 0.45, "Ceramic", P @ mat4((x, L * 0.2, z), rot), seg=12)
    lathe(h, [(R * 0.62, 0), (R * 0.64, L * 0.42), (R * 0.78, L * 0.7), (R * 0.96, L * 0.9), (R, L)],
          "Bronze", P @ mat4((x, L * 0.05, z), rot), seg=14, cap_top=False)
    trim = "Gold" if lv == 3 else "BronzeDark"
    torus(h, R * 0.98, R * 0.14, trim, P @ mat4((x, L * 1.05, z), rot), seg=14, rseg=6)
    torus(h, R * 0.66, R * 0.16, "GlowWater", P @ mat4((x, L * 1.04, z), rot), seg=14, rseg=6)
    cyl(h, R * 0.8, R * 0.8, 0.012, "GlowWater", P @ mat4((x, L * 0.98, z), rot), seg=12)
    cyl(h, R * 0.76, R * 0.76, 0.02 * k, trim, P @ mat4((x, L * 0.47, z), rot), seg=12)
    return (P @ Vector((x, L * 1.1, z)))[:]


# smoother shading threshold than the other towers: 6-sided tori and pipes stay smooth (one vertex per
# corner instead of four), which keeps the GLB small
SPRINKLER_SHARP = 64.0


def build_sprinkler(mats, root, name, lv, z0):
    s = (0.95, 1.0, 1.05)[lv - 1]
    b = Builder(mats)
    hoop = ("Ceramic", "Bronze", "Gold")[lv - 1]
    # ceramic foot with the water-blue band
    lathe(b, [(0.37 * s, z0 - 0.04), (0.38 * s, z0 + 0.05 * s), (0.34 * s, z0 + 0.1 * s), (0.3 * s, z0 + 0.12 * s)],
          "Ceramic", seg=24)
    kind_band(b, "sprinkler", 0.36 * s, z0 + 0.075 * s, lv)
    team_pennant(b, z0, lv)
    if lv >= 2:
        cyl(b, 0.4 * s, 0.4 * s, 0.04, "BronzeDark", mat4((0, 0, z0)), seg=24)
    # glazed blue water drum
    TR = 0.32 * s
    TH = (0.34, 0.37, 0.38)[lv - 1] * s
    zt0 = z0 + 0.11 * s
    zt1 = zt0 + TH
    lathe(b, [(TR * 0.9, zt0), (TR * 0.98, zt0 + 0.05 * s), (TR * 1.04, zt0 + TH * 0.5), (TR * 0.98, zt1 - 0.05 * s),
              (TR * 0.9, zt1)], "CeramicBlue", seg=24, cap_top=False)
    for zz in (zt0 + 0.06 * s, zt1 - 0.06 * s):
        torus(b, TR * 1.0, 0.026, hoop, mat4((0, 0, zz)), seg=24, rseg=6)
    # rivets on the hoops
    for i in range(8):
        a = TAU * (i + 0.5) / 8
        for zz in (zt0 + 0.06 * s, zt1 - 0.06 * s):
            sphere(b, 0.014, "BronzeDark", mat4((math.cos(a) * TR * 1.03, math.sin(a) * TR * 1.03, zz)), seg=5, rings=3)
    # lid: blue glaze with a glowing water ring round the rim (reads blue from the game camera)
    torus(b, TR * 0.9, 0.03, "GlowWater", mat4((0, 0, zt1 + 0.004)), seg=24, rseg=6)
    if lv < 3:
        lathe(b, [(TR * 0.9, zt1), (TR * 0.84, zt1 + 0.04 * s), (TR * 0.55, zt1 + 0.08 * s), (0.16 * s, zt1 + 0.09 * s),
                  (0.16 * s, zt1 + 0.1 * s)], "CeramicBlue", seg=24)
        ztop = zt1 + 0.1 * s
    else:
        # Masterwork: glass water dome over the drum, water and bubbles inside, a bronze column carries the head
        dr = TR * 0.88
        dh = 0.2 * s
        prof = []
        for i in range(8):
            t = (math.pi / 2) * i / 7
            prof.append((dr * math.cos(t) if i < 7 else 0.0, zt1 + dh * math.sin(t)))
        cyl(b, dr * 0.97, dr * 0.97, 0.05 * s, "GlowWater", mat4((0, 0, zt1 + 0.025 * s)), seg=24)
        lathe(b, prof, "GlowWaterGlass", seg=24, cap_top=False)
        torus(b, dr * 0.72, 0.016, "Gold", mat4((0, 0, zt1 + dh * 0.7)), seg=24, rseg=6)
        rnd = random.Random(55)
        for i in range(6):
            a = rnd.uniform(0, TAU)
            rr = rnd.uniform(0.1, dr * 0.75)
            sphere(b, rnd.uniform(0.012, 0.024), "GlowWaterGlass",
                   mat4((math.cos(a) * rr, math.sin(a) * rr, zt1 + rnd.uniform(0.06, 0.14) * s)), seg=6, rings=4)
        cyl(b, 0.06 * s, 0.07 * s, dh + 0.02, "Bronze", mat4((0, 0, zt1 + dh / 2)), seg=14)
        cyl(b, 0.13 * s, 0.1 * s, 0.04 * s, "Gold", mat4((0, 0, zt1 + dh + 0.01)), seg=20, bevel=0.006)
        ztop = zt1 + dh + 0.03 * s
    # side valve wheel
    vx = TR * 1.04
    vm = "Copper" if lv >= 2 else "Bronze"
    cyl(b, 0.03, 0.03, 0.06, "BronzeDark", mat4((vx + 0.02, 0, zt0 + TH * 0.45), (0, math.pi / 2, 0)), seg=10)
    torus(b, 0.055, 0.012, vm, mat4((vx + 0.055, 0, zt0 + TH * 0.45), (0, math.pi / 2, 0)), seg=16, rseg=6)
    for i in range(3):
        box(b, (0.008, 0.1, 0.012), vm, mat4((vx + 0.055, 0, zt0 + TH * 0.45), (TAU * i / 3, 0, 0)), segs=1)
    if lv >= 2:
        # water-level window on the front: bronze frame, glowing water up to two thirds
        wy = TR * 1.035
        wz = zt0 + TH * 0.5
        wh = TH * 0.56
        box(b, (0.12 * s, 0.03, wh + 0.04), "BronzeDark", mat4((0, wy, wz)), bevel=0.012, segs=1)
        box(b, (0.075 * s, 0.03, wh * 0.62), "GlowWater", mat4((0, wy + 0.006, wz - wh * 0.19)), bevel=0.008, segs=1)
        box(b, (0.075 * s, 0.026, wh * 0.36), "Soil", mat4((0, wy + 0.004, wz + wh * 0.31)), bevel=0.006, segs=1)
        for j in range(3):
            box(b, (0.03, 0.012, 0.006), "Gold" if lv == 3 else "Bronze",
                mat4((0.055 * s, wy + 0.018, wz - wh * 0.4 + wh * 0.4 * j)), segs=1)
        # copper pipes up the back flanks into the lid
        for sx in (-1, 1):
            a = math.radians(90 + sx * 128)
            cx, cy = math.cos(a), math.sin(a)
            r1 = TR * 1.12
            pts = [(cx * TR * 1.0, cy * TR * 1.0, zt0 + 0.12 * s), (cx * r1, cy * r1, zt0 + 0.12 * s),
                   (cx * r1, cy * r1, zt1 + 0.02), (cx * TR * 0.7, cy * TR * 0.7, zt1 + 0.06 * s)]
            pipe(b, pts, 0.022, "Copper")
            for zz in (zt0 + 0.12 * s, zt1 - 0.06 * s):
                cyl(b, 0.032, 0.032, 0.02, "BronzeDark", mat4((cx * r1, cy * r1, zz)), seg=10)
    if lv == 3:
        # gold buttresses round the drum
        for i in range(4):
            a = TAU * (i + 0.5) / 4
            box(b, (0.05, 0.08, TH * 0.7), "Gold",
                mat4((math.cos(a) * TR * 1.04, math.sin(a) * TR * 1.04, zt0 + TH * 0.38), (0, 0, a + math.pi / 2)) @
                mat4(rot=(0.08, 0, 0)), bevel=0.012, segs=1)
    obj_from_mesh(name + "_body", b.mesh(name + "_body", sharp_angle=SPRINKLER_SHARP), root)

    # ---- swivel head: everything that turns, aim = +Y; nozzle pitched up-forward for lobbed water bombs
    head = empty(name + "_head", root, (0, 0, ztop))
    h = Builder(mats)
    k = (1.12, 1.16, 1.2)[lv - 1]
    cyl(h, 0.17 * k, 0.15 * k, 0.05 * k, "BronzeDark", mat4((0, 0, 0.025 * k)), seg=20)
    sphere(h, 0.12 * k, "Bronze", mat4((0, -0.02 * k, 0.1 * k), scale=(1, 1.05, 0.8)), seg=14, rings=8)
    torus(h, 0.13 * k, 0.018, "Gold" if lv == 3 else "Ceramic", mat4((0, 0, 0.06 * k)), seg=24, rseg=6)
    zc = 0.15 * k
    pitch = math.radians(42)
    P = mat4((0, -0.03 * k, zc), (pitch, 0, 0))
    # yoke cheeks + trunnion caps
    yw = (0.14, 0.22, 0.16)[lv - 1] * k
    for sx in (-1, 1):
        box(h, (0.045 * k, 0.15 * k, 0.17 * k), "Bronze", mat4((sx * yw, -0.03 * k, zc - 0.03 * k)), bevel=0.016 * k, segs=1)
        cyl(h, 0.055 * k, 0.055 * k, 0.03, "Ceramic", mat4((sx * (yw + 0.03 * k), -0.03 * k, zc), (0, math.pi / 2, 0)),
            seg=14, bevel=0.006)
        sphere(h, 0.022 * k, "GlowWater", mat4((sx * (yw + 0.05 * k), -0.03 * k, zc), scale=(0.5, 1, 1)), seg=8, rings=5)
    tips = []
    if lv == 1:
        sphere(h, 0.1 * k, "BronzeDark", P @ mat4((0, -0.02 * k, 0)), seg=14, rings=8)
        tips.append(bell_nozzle(h, P, 0.0, 0.0, k, lv, rad=0.14, length=0.36))
    elif lv == 2:
        # copper manifold feeding twin nozzles
        cyl(h, 0.055 * k, 0.055 * k, 2 * yw - 0.02, "Copper", P @ mat4((0, 0, 0), (0, math.pi / 2, 0)), seg=14)
        box(h, (0.16 * k, 0.12 * k, 0.12 * k), "BronzeDark", P @ mat4((0, -0.04 * k, 0)), bevel=0.03 * k, segs=1)
        for sx in (-1, 1):
            tips.append(bell_nozzle(h, P, sx * 0.11 * k, 0.0, k, lv, rad=0.11, length=0.36))
        pipe(h, [P @ Vector((-0.105 * k, -0.06 * k, -0.07 * k)), P @ Vector((0, -0.1 * k, -0.1 * k)),
                 P @ Vector((0.105 * k, -0.06 * k, -0.07 * k))], 0.016, "Copper")
    else:
        # Masterwork: fat barrel ending in a rotating triple-nozzle rose
        rot = (-math.pi / 2, 0, 0)
        sphere(h, 0.1 * k, "BronzeDark", P @ mat4((0, -0.02 * k, 0)), seg=14, rings=8)
        cyl(h, 0.085 * k, 0.095 * k, 0.24 * k, "Ceramic", P @ mat4((0, 0.1 * k, 0), rot), seg=18)
        for yy in (0.02, 0.17):
            torus(h, 0.09 * k, 0.014, "Gold", P @ mat4((0, yy * k, 0), rot), seg=20, rseg=6)
        cyl(h, 0.075 * k, 0.15 * k, 0.07 * k, "Bronze", P @ mat4((0, 0.25 * k, 0), rot), seg=20)
        cyl(h, 0.16 * k, 0.16 * k, 0.04 * k, "Gold", P @ mat4((0, 0.3 * k, 0), rot), seg=24, bevel=0.008)
        cyl(h, 0.05 * k, 0.05 * k, 0.03, "GlowWater", P @ mat4((0, 0.325 * k, 0), rot), seg=12)
        Q = P @ mat4((0, 0.24 * k, 0))
        for i in range(3):
            a = TAU * i / 3 + math.pi / 2
            x, z = math.cos(a) * 0.095 * k, math.sin(a) * 0.095 * k
            tips.append(bell_nozzle(h, Q, x, z, k, lv, rad=0.072, length=0.2))
        # gold fins between the nozzles
        for i in range(3):
            a = TAU * (i + 0.5) / 3 + math.pi / 2
            box(h, (0.012, 0.12 * k, 0.05 * k), "Gold",
                P @ mat4((math.cos(a) * 0.12 * k, 0.3 * k, math.sin(a) * 0.12 * k), (0, -a + math.pi / 2, 0)), segs=1)
    obj_from_mesh(name + "_nozzle", h.mesh(name + "_nozzle", sharp_angle=SPRINKLER_SHARP), head)
    if len(tips) == 1:
        empty(name + "_muzzle", head, tips[0])
    else:
        for i, t in enumerate(tips):
            empty(f"{name}_muzzle{i}", head, t)


BUILDERS = {"laser": build_laser, "shield": build_shield, "slow": build_slow, "missile": build_missile,
            "beacon": build_beacon, "sprinkler": build_sprinkler}


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
        r.location = (KINDS.index(kind) * 2.0 - (len(KINDS) - 1), (int(lv) - 2) * 2.2, 0)
    # towers face the camera (-Y side) for the lineup; aim stays +Y in the export
    for r in roots:
        r.rotation_euler = (0, 0, math.pi)
    shoot("towers_preview_lineup.png", (0, 0, 0.6), 17.5, 55, 0, 50, (1800, 1300))
    shoot("towers_preview_lineup34.png", (0.9, 0, 0.7), 15.5, 28, 25, 50, (1800, 1100))
    # game camera with every tower aiming to the right (barrels and nozzles in profile)
    for r in roots:
        r.rotation_euler = (0, 0, -math.pi / 2)
    shoot("towers_preview_lineup_side.png", (0, 0, 0.6), 17.5, 55, 0, 50, (1800, 1300))
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
