"""
SWAT operator, part 3 of 5: the torso gear, fitted to the A-posed body from out/swat_body.blend.

    blender --background --factory-startup --python swat_torso.py -- [out.blend] [--preview <dir>] [--standin]

Writes out/swat_torso.blend: one collection `Torso` with every piece in final world space on the A-posed body
(transforms and modifiers applied, materials prefixed `Torso_`). Reference: images/5.webp ("SWAT / character model
reference": plate carrier, mag pouch (5.56), utility pouch, radio pouch, tactical belt, holster and the detail crops).

How it fits: the body's outermost layer (uniform over skin) is ray-cast from inside along many directions, keeping
the outer end of the first cluster of hits, so the arms never get in the way. Rigid parts (the plates) are fitted with
a single-curvature surface that clears every sample; soft parts (cummerbund, straps, belt, thigh strap) follow the
surface. Until swat_body.blend exists (or with --standin) a 1.83 m athletic stand-in from the shared rig is used.

Pieces: front and back plate bags (shooter's cut), cummerbund, padded shoulder straps, white "SWAT" patches on the
front and the left sleeve, three 5.56 mag pouches, side pouches, a black MOLLE assault pack over the back plate (front
and admin pockets, side bottle pouches, compression straps, shoulder straps, hydration tube, the radio with its
antenna on its left side), the tactical belt with buckle, pistol-mag, utility and rear pouches, a medic pouch with a
cross, a left drop pouch and a right drop holster (leg platform, holster with retention hood, pistol grip, thigh
straps with buckles).

Low / high: every piece is a game-density low mesh (~4k tris in all) plus, where it has fine detail, a `<name>_high`
bake source (obj["high"] = True, obj["high_of"] = <name>) with the MOLLE rows, bindings, stitch beads, keepers,
rounder bevels and screws, which build_swat bakes into the low mesh's normal map and never exports.
Weights: each exported piece carries its own bone weights (weight_gear), which build_swat keeps: carrier and pack on
chest / spine, belt kit on the hips, leg kit on its thigh (hangers blend from the hips), thigh straps and the sleeve
patch copied from the uniform under them, so nothing floats off or tears in the posed stance.
"""

import importlib.util
import math
import subprocess
import sys
import time
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

HERE = Path(__file__).resolve().parent
BLENDER_DIR = HERE.parent
_spec = importlib.util.spec_from_file_location("bz", BLENDER_DIR / "build_zombies.py")
bz = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bz)

ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
STANDIN = "--standin" in ARGV
PREVIEW = None
if "--preview" in ARGV:
    PREVIEW = Path(ARGV[ARGV.index("--preview") + 1])
    PREVIEW.mkdir(parents=True, exist_ok=True)
POS = [a for i, a in enumerate(ARGV) if not a.startswith("--") and (i == 0 or ARGV[i - 1] != "--preview")]
OUT_BLEND = Path(POS[0]) if POS else HERE / "out" / "swat_torso.blend"
BODY_BLEND = HERE / "out" / "swat_body.blend"
FONT = Path(r"C:\Windows\Fonts\arialbd.ttf")
S = 1.02  # the shared rig scaled to the operator (crown ~1.83 m), as swat_body.py does
T0 = time.time()


def log(msg):
    print(f"[swat_torso {time.time() - T0:6.1f}s] {msg}", flush=True)


# ---- scene helpers -----------------------------------------------------------------------------------------------

def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)
    for m in list(bpy.data.meshes):
        bpy.data.meshes.remove(m)


def collection(name):
    c = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if c.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(c)
    return c


_mats = {}


def material(name, color, rough=0.7, metal=0.0, bump=0.0, bump_scale=900.0, emit=None):
    """Principled material; `bump` adds a fine procedural weave-ish bump for previews (the finish worker bakes real maps)."""
    if name in _mats:
        return _mats[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emit:
        bsdf.inputs["Emission Color"].default_value = (*emit, 1.0)
        bsdf.inputs["Emission Strength"].default_value = 1.0
    if bump > 0:
        tc = nt.nodes.new("ShaderNodeTexCoord")
        noise = nt.nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = bump_scale
        noise.inputs["Detail"].default_value = 2.0
        b = nt.nodes.new("ShaderNodeBump")
        b.inputs["Strength"].default_value = bump
        b.inputs["Distance"].default_value = 0.0004
        nt.links.new(tc.outputs["Object"], noise.inputs["Vector"])
        nt.links.new(noise.outputs["Fac"], b.inputs["Height"])
        nt.links.new(b.outputs["Normal"], bsdf.inputs["Normal"])
    _mats[name] = m
    return m


def lin(hexstr):
    """sRGB hex to linear RGB."""
    h = hexstr.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def mats():
    return {
        "nylon": material("Torso_Nylon", lin("#0c0d0e"), 0.74, bump=0.42, bump_scale=700),
        "webbing": material("Torso_Webbing", lin("#0a0b0c"), 0.68, bump=0.3, bump_scale=1500),
        "polymer": material("Torso_Polymer", lin("#111112"), 0.42),
        "metal": material("Torso_Metal", lin("#2a2b2d"), 0.35, metal=1.0),
        "rubber": material("Torso_Rubber", lin("#0f0f10"), 0.62),
        "patch": material("Torso_PatchBase", lin("#131314"), 0.86, bump=0.1, bump_scale=1800),
        "text": material("Torso_PatchText", lin("#e9e9e6"), 0.62),
        "cross": material("Torso_Cross", lin("#9b9c9e"), 0.7),
        "velcro": material("Torso_Velcro", lin("#17181a"), 0.9, bump=0.3, bump_scale=2600),
    }


# ---- mesh building ---------------------------------------------------------------------------------------------------

class Builder:
    """Accumulates geometry for one object (several materials allowed), then makes the object."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.mat_index = {}
        self.mat_list = []

    def mi(self, mat):
        if mat.name not in self.mat_index:
            self.mat_index[mat.name] = len(self.mat_list)
            self.mat_list.append(mat)
        return self.mat_index[mat.name]

    def add_bm(self, src, mat, matrix=None):
        """Merges another bmesh (already in local/world space; `matrix` applied if given)."""
        idx = self.mi(mat)
        vmap = {}
        flip = matrix is not None and matrix.to_3x3().determinant() < 0
        for v in src.verts:
            co = matrix @ v.co if matrix else v.co.copy()
            vmap[v] = self.bm.verts.new(co)
        for f in src.faces:
            try:
                vs = [vmap[v] for v in f.verts]
                nf = self.bm.faces.new(list(reversed(vs)) if flip else vs)
                nf.material_index = idx
                nf.smooth = f.smooth
            except ValueError:
                pass

    def finish(self, coll, bevel=0.0, segments=2, angle=35, smooth=True):
        me = bpy.data.meshes.new(self.name)
        self.bm.normal_update()
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mat_list:
            me.materials.append(m)
        ob = bpy.data.objects.new(self.name, me)
        coll.objects.link(ob)
        if bevel > 0:
            mod = ob.modifiers.new("Bevel", "BEVEL")
            mod.width = bevel
            mod.segments = segments
            mod.limit_method = "ANGLE"
            mod.angle_limit = math.radians(angle)
            mod.harden_normals = False
        apply_modifiers(ob)
        for p in ob.data.polygons:
            p.use_smooth = smooth
        return ob


def apply_modifiers(ob):
    if not ob.modifiers:
        return
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev)
    old = ob.data
    ob.modifiers.clear()
    ob.data = me
    me.name = old.name
    bpy.data.meshes.remove(old)


def shade_auto(ob, angle=40):
    """Smooth shading with sharp edges above `angle` (works across Blender versions)."""
    me = ob.data
    try:
        bpy.context.view_layer.objects.active = ob
        ob.select_set(True)
        bpy.ops.object.shade_auto_smooth(angle=math.radians(angle))
        ob.select_set(False)
    except Exception:
        for p in me.polygons:
            p.use_smooth = True


def box_bm(size, center=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    sx, sy, sz = size
    cx, cy, cz = center
    for v in bm.verts:
        v.co = Vector((v.co.x * sx + cx, v.co.y * sy + cy, v.co.z * sz + cz))
    return bm


def rbox_bm(size, center=(0, 0, 0), r=0.004, seg=2):
    """A box with rounded edges (bmesh bevel), local coordinates."""
    bm = box_bm(size, center)
    r = min(r, min(size) * 0.45)
    if r > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=r, segments=seg, profile=0.5, affect="EDGES", clamp_overlap=True)
    return bm


def cyl_bm(r1, r2, depth, segs=12, center=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segs, radius1=r1, radius2=r2, depth=depth)
    for v in bm.verts:
        v.co += Vector(center)
    return bm


def shell_bm(points, normals, thick, close_u=False):
    """A solid shell from a grid of surface points (nu x nv) with outward normals: inner skin at the points, outer at
    points + normal * thick, side walls on the open boundaries. Faces come out outward-facing."""
    nu = len(points)
    nv = len(points[0])
    bm = bmesh.new()
    vin = [[bm.verts.new(points[i][j]) for j in range(nv)] for i in range(nu)]
    vout = [[bm.verts.new(points[i][j] + normals[i][j] * thick) for j in range(nv)] for i in range(nu)]
    iu = range(nu if close_u else nu - 1)
    for i in iu:
        i2 = (i + 1) % nu
        for j in range(nv - 1):
            bm.faces.new((vout[i][j], vout[i2][j], vout[i2][j + 1], vout[i][j + 1]))
            bm.faces.new((vin[i][j + 1], vin[i2][j + 1], vin[i2][j], vin[i][j]))
    for i in iu:  # v boundaries
        i2 = (i + 1) % nu
        bm.faces.new((vin[i][0], vin[i2][0], vout[i2][0], vout[i][0]))
        bm.faces.new((vout[i][nv - 1], vout[i2][nv - 1], vin[i2][nv - 1], vin[i][nv - 1]))
    if not close_u:  # u boundaries
        for j in range(nv - 1):
            bm.faces.new((vout[0][j], vout[0][j + 1], vin[0][j + 1], vin[0][j]))
            bm.faces.new((vin[nu - 1][j], vin[nu - 1][j + 1], vout[nu - 1][j + 1], vout[nu - 1][j]))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    # recalc can flip a whole thin shell inside out; check against the given outward normal.
    f = bm.faces[0]
    f.normal_update()
    probe = normals[0][0]
    if f.normal.dot(probe) < 0 and abs(f.normal.dot(probe)) > 0.5:
        pass  # first face is a side wall or the inner skin; the outer face orientation is checked below
    bm.normal_update()
    outer_sum = 0.0
    for fc in bm.faces:
        c = fc.calc_center_median()
        outer_sum += fc.normal.dot(c - points[nu // 2][nv // 2])
    if outer_sum < 0:
        bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
    return bm


def frame(origin, normal, up=Vector((0, 0, 1))):
    """Matrix for a local frame: Y' = outward normal, Z' = up (orthogonalised), X' = Z' x Y' (to the right as seen by
    someone looking at the surface from outside, so text reads correctly). The frame is left-handed, so add_bm
    re-orients faces of mirrored geometry (see Builder.add_bm)."""
    y = normal.normalized()
    z = (up - y * up.dot(y)).normalized()
    x = z.cross(y).normalized()
    m = Matrix((x, y, z)).transposed().to_4x4()
    m.translation = origin
    return m


def text_bm(text, size, depth, offset=0.0):
    """Extruded text (Arial Bold) as a bmesh lying in local X/Z, facing +Y, centred, front face at y = depth."""
    cu = bpy.data.curves.new("txt", "FONT")
    cu.body = text
    if FONT.exists():
        cu.font = bpy.data.fonts.load(str(FONT), check_existing=True)
    cu.size = size
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    cu.extrude = depth / 2  # 0: a single front-facing fill
    cu.offset = offset
    cu.resolution_u = 2
    ob = bpy.data.objects.new("txt", cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-5)
    # Font space: X right, Y up, Z out. Map to X' right, Z' up, Y' out; front face at y = depth.
    for v in bm.verts:
        x, y, z = v.co
        v.co = Vector((x, z + depth / 2, y))
    if depth == 0:
        # Font fills face +Z, which maps to +Y' here, but the axis swap mirrors the winding: face outward again.
        bm.normal_update()
        if sum(f.normal.y for f in bm.faces) < 0:
            bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)
    bpy.data.meshes.remove(me)
    return bm


# ---- the body to fit -----------------------------------------------------------------------------------------------

def bone_points():
    """Head/tail of each contract bone in world space (from the body's armature, else the shared rig scaled)."""
    arm = bpy.data.objects.get("Survivor")
    if arm and arm.type == "ARMATURE":
        return {b.name: (arm.matrix_world @ b.head_local, arm.matrix_world @ b.tail_local) for b in arm.data.bones}
    return {n: (Vector(h) * S, Vector(t) * S) for n, _, h, t in bz.BONES}


def load_body(coll):
    """Appends the body's meshes and armature (for fitting and the preview). Returns True if the real body was used."""
    if BODY_BLEND.exists() and not STANDIN:
        with bpy.data.libraries.load(str(BODY_BLEND), link=False) as (src, dst):
            dst.objects = list(src.objects)
        for o in dst.objects:
            if o is None:
                continue
            if o.get("high") or o.name.endswith("High"):
                bpy.data.objects.remove(o, do_unlink=True)
                continue
            coll.objects.link(o)
        log(f"fitting to {BODY_BLEND.name}: {[o.name for o in coll.objects]}")
        return True
    build_standin(coll)
    log("fitting to the stand-in body")
    return False


def build_standin(coll):
    """A 1.83 m athletic mannequin at the uniform's outer surface: lofted torso, capsule limbs, head."""
    navy = material("Ref_Uniform", lin("#1f2433"), 0.86, bump=0.15, bump_scale=1600)
    skin = material("Ref_Skin", lin("#a5806b"), 0.55)
    bm = bmesh.new()
    rings = [  # z, half width, front, back (uniform outer surface)
        (0.86, 0.150, 0.095, 0.115), (0.93, 0.172, 0.100, 0.125), (1.00, 0.166, 0.104, 0.118), (1.08, 0.156, 0.106, 0.106),
        (1.18, 0.166, 0.116, 0.106), (1.27, 0.182, 0.132, 0.114), (1.35, 0.192, 0.138, 0.120), (1.42, 0.205, 0.118, 0.112),
        (1.47, 0.170, 0.080, 0.090), (1.51, 0.090, 0.060, 0.060), (1.56, 0.062, 0.055, 0.055),
    ]
    n = 40
    prev = None
    for z, hw, fr, bk in rings:
        ring = []
        for k in range(n):
            t = 2 * math.pi * k / n
            c, s = math.cos(t), math.sin(t)
            e = 2.4  # superellipse: a slightly boxy torso
            x = hw * math.copysign(abs(c) ** (2 / e), c)
            y = (fr if s > 0 else bk) * math.copysign(abs(s) ** (2 / e), s)
            ring.append(bm.verts.new((x, y, z * S / 1.0)))
        if prev:
            for k in range(n):
                bm.faces.new((prev[k], prev[(k + 1) % n], ring[(k + 1) % n], ring[k]))
        else:
            bm.faces.new(list(reversed(ring)))
        prev = ring
    bm.faces.new(prev)
    bp = bone_points()

    def capsule(a, b, r1, r2):
        d = b - a
        cb = cyl_bm(r1, r2, d.length, 16)
        rot = d.normalized().to_track_quat("Z", "Y").to_matrix().to_4x4()
        m = Matrix.Translation((a + b) / 2) @ rot
        for v in cb.verts:
            v.co = m @ v.co
        return cb

    torso = Builder("Ref_Standin")
    torso.add_bm(bm, navy)
    for s in ("L", "R"):
        for bone, r1, r2 in (("upperarm", 0.058, 0.047), ("forearm", 0.046, 0.036), ("thigh", 0.092, 0.064), ("shin", 0.060, 0.050)):
            a, b = bp[f"{bone}.{s}"]
            torso.add_bm(capsule(a, b, r1, r2), navy)
        a, b = bp[f"hand.{s}"]
        torso.add_bm(capsule(a, b, 0.03, 0.025), skin)
    hs = bmesh.new()
    bmesh.ops.create_uvsphere(hs, u_segments=20, v_segments=12, radius=0.105)
    for v in hs.verts:
        v.co = Vector((v.co.x * 0.86, v.co.y, v.co.z * 1.1)) + Vector((0, 0.01, 1.70))
    torso.add_bm(hs, skin)
    ob = torso.finish(coll, smooth=True)
    for p in ob.data.polygons:
        p.use_smooth = True


class Fit:
    """Ray-cast fitting against the body's outermost layer."""

    def __init__(self, objs):
        dg = bpy.context.evaluated_depsgraph_get()
        verts, polys, base = [], [], 0
        for o in objs:
            if o.type != "MESH" or o.name.endswith("Eyes"):
                continue
            ev = o.evaluated_get(dg)
            me = ev.to_mesh()
            mw = o.matrix_world
            verts += [mw @ v.co for v in me.vertices]
            polys += [[base + i for i in p.vertices] for p in me.polygons]
            base += len(me.vertices)
            ev.to_mesh_clear()
        self.verts = np.array([tuple(v) for v in verts]) if verts else np.zeros((0, 3))
        self.bvh = BVHTree.FromPolygons(verts, polys)
        log(f"fit surface: {base} verts")

    def outer(self, origin, direction, gap=0.035, maxd=0.7):
        """Outer end of the first cluster of surface hits from `origin` along `direction` (None if nothing)."""
        d = direction.normalized()
        hits = []
        t = 0.0
        while t < maxd:
            loc, nrm, idx, dist = self.bvh.ray_cast(origin + d * t, d, maxd - t)
            if loc is None:
                break
            th = t + dist
            if hits and th - hits[-1] > gap:
                break
            hits.append(th)
            t = th + 1e-4
        return origin + d * hits[-1] if hits else None

    def axis_y(self, z, xlim=0.12, band=0.02):
        """Centre of the torso front-to-back at height z."""
        v = self.verts
        sel = v[(np.abs(v[:, 2] - z) < band) & (np.abs(v[:, 0]) < xlim)]
        if len(sel) < 4:
            return 0.0
        return float((sel[:, 1].max() + sel[:, 1].min()) / 2)

    def radial(self, center, theta, fallback):
        """Outer torso surface at `center` (a point on the axis) along horizontal angle theta (0 = +X, 90 deg = +Y).
        A tight hit cluster and a short reach keep the sleeves (hanging close to the waist in A-pose) out of it."""
        d = Vector((math.cos(theta), math.sin(theta), 0))
        p = self.outer(center, d, gap=0.016, maxd=0.30)
        return (p if p is not None else center + d * fallback), d


# ---- the pieces ----------------------------------------------------------------------------------------------------

class Plate:
    """A rigid plate bag: depth q(x, z) = a + c x^2 + d (z - zm) outward from the body (side +1 front, -1 back)."""

    def __init__(self, fit, side, W, H, zc, clear=0.006):
        self.side, self.W, self.H, self.zc = side, W, H, zc
        xs = np.linspace(-W / 2 - 0.01, W / 2 + 0.01, 11)
        zs = np.linspace(zc - H / 2, zc + H / 2, 11)
        rows = []
        for z in zs:
            cy = fit.axis_y(z)
            for x in xs:
                p = fit.outer(Vector((x, cy, z)), Vector((0, side, 0)))
                if p is not None:
                    rows.append((x, z, side * p.y))
        a = np.array(rows)
        self.zm = zc
        A = np.stack([np.ones(len(a)), a[:, 0] ** 2, a[:, 2] * 0 + (a[:, 1] - zc)], axis=1)
        coef, *_ = np.linalg.lstsq(A, a[:, 2], rcond=None)
        c0, c2, cz = coef
        c2 = min(c2, -0.05)  # plates always curve back at the edges a little
        resid = a[:, 2] - (c0 + c2 * a[:, 0] ** 2 + cz * (a[:, 1] - zc))
        self.a = c0 + float(resid.max()) + clear
        self.c, self.d = c2, cz
        log(f"plate side {side}: q = {self.a:.3f} + {self.c:.3f} x^2 + {self.d:.3f} (z - {zc:.2f})")

    def q(self, x, z):
        return self.a + self.c * x * x + self.d * (z - self.zm)

    def point(self, x, z, out=0.0):
        """Point on the plate's inner surface (plus `out` along the normal) and the outward normal."""
        n = Vector((-2 * self.c * x, self.side, -self.d)).normalized()
        n.y = self.side * abs(n.y)
        p = Vector((x, self.side * self.q(x, z), z))
        return p + n * out, n

    def frame(self, x, z, out=0.0):
        """Local frame on the plate: X' to the wearer's right as seen from outside the plate... see below."""
        p, n = self.point(x, z, out)
        return frame(p, n)

    def mesh(self, thick, cut_w, cut_h, low_cut=0.022, nx=12, nz=9):
        W, H = self.W, self.H
        bm = bmesh.new()
        grid = []
        for j in range(nz + 1):
            z = self.zc - H / 2 + H * j / nz
            row = []
            for i in range(nx + 1):
                x = -W / 2 + W * i / nx
                p, _ = self.point(x, z)
                row.append(bm.verts.new(p))
            grid.append(row)
        for j in range(nz):
            for i in range(nx):
                bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
        top, bot = self.zc + H / 2, self.zc - H / 2
        cuts = [  # (point on line, in-plane normal pointing out of the plate) in (x, z)
            ((-W / 2 + cut_w, top), (-cut_h, cut_w)), ((W / 2 - cut_w, top), (cut_h, cut_w)),
            ((-W / 2 + low_cut, bot), (-low_cut, -low_cut)), ((W / 2 - low_cut, bot), (low_cut, -low_cut)),
        ]
        for (px, pz), (nxx, nzz) in cuts:
            geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
            bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=(px, 0, pz), plane_no=(nxx, 0, nzz), clear_outer=True)
        bm.normal_update()
        if sum(f.normal.y for f in bm.faces) * self.side < 0:
            bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
        # Solidify outward by hand: copy, offset along the surface normal, bridge the boundary.
        me = bpy.data.meshes.new("tmp")
        bm.to_mesh(me)
        bm.free()
        ob = bpy.data.objects.new("tmp", me)
        bpy.context.scene.collection.objects.link(ob)
        sol = ob.modifiers.new("Solid", "SOLIDIFY")
        sol.thickness = thick
        sol.offset = 1.0
        sol.use_even_offset = True
        apply_modifiers(ob)
        out = bmesh.new()
        out.from_mesh(ob.data)
        solid = ob.data
        bpy.data.objects.remove(ob)
        bpy.data.meshes.remove(solid)
        return out


def bevel_bm(bm, width, seg=1, angle=30):
    """Rounds the bmesh's edges sharper than `angle` (in place)."""
    bm.normal_update()
    edges = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(angle)]
    if edges and width > 0:
        bmesh.ops.bevel(bm, geom=edges, offset=width, segments=seg, profile=0.5, affect="EDGES", clamp_overlap=True)
    return bm


class Pair:
    """A low-poly export object and its high-detail normal-bake source (obj["high"] = True, obj["high_of"] = low
    name; build_swat projects it onto the low mesh and never exports it)."""

    def __init__(self, name):
        self.name = name
        self.lo = Builder(name)
        self.hi = Builder(name + "_high")
        self.hi_used = False

    def both(self, bm, mat, M=None):
        self.lo.add_bm(bm, mat, M)
        self.high(bm, mat, M)

    def low(self, bm, mat, M=None):
        self.lo.add_bm(bm, mat, M)

    def high(self, bm, mat, M=None):
        self.hi.add_bm(bm, mat, M)
        self.hi_used = True

    def parts(self, low_parts, high_parts, M, m):
        for key, lst in low_parts.items():
            for bm in lst:
                self.lo.add_bm(bm, m[key], M)
        for key, lst in high_parts.items():
            for bm in lst:
                self.high(bm, m[key], M)

    def finish(self, coll, smooth=True, hbevel=0.0, hsegments=2, angle=35):
        lo = self.lo.finish(coll, smooth=smooth)
        if self.hi_used:
            hi = self.hi.finish(coll, bevel=hbevel, segments=hsegments, angle=angle, smooth=True)
            hi["high"] = True
            hi["high_of"] = self.name
            hi.hide_render = True
        else:
            self.hi.bm.free()
        return lo


def molle_on_plate(b, plate, mat, z0, z1, x0, x1, base_out, pitch=0.038, strip=0.025, col=0.0381, gap=0.0045):
    """Rows of flat 25 mm webbing on a plate face, cut into bar-tacked segments (bake detail): one box per segment,
    raised 3 mm and set on the plate's local tangent so the rows follow its curve."""
    z = z0 + strip / 2
    while z + strip / 2 <= z1 + 1e-6:
        x = x0
        while x + 0.01 < x1:
            xe = min(x + col - gap, x1)
            xm = (x + xe) / 2
            M = plate.frame(xm, z, base_out)
            b.add_bm(box_bm((xe - x, 0.0032, strip), (0, 0.0016, 0)), mat, M)
            x += col
        z += pitch


def molle_rows(b, mat, w, h, center, M, pitch=0.038, strip=0.025, col=0.0381, gap=0.0045, axis="x"):
    """MOLLE rows on a flat face of local frame M (face plane y = 0, rows along local x, stacked along z)."""
    cx, cz = center
    z = cz - h / 2 + strip / 2
    while z + strip / 2 <= cz + h / 2 + 1e-6:
        x = cx - w / 2
        while x + 0.01 < cx + w / 2:
            xe = min(x + col - gap, cx + w / 2)
            b.add_bm(box_bm((xe - x, 0.0032, strip), ((x + xe) / 2, 0.0016, z)), mat, M)
            x += col
        z += pitch


def prism_bm(profile, y0, y1, r=0.0):
    """A 2D profile in local (x, z) extruded from y0 to y1, edges rounded by r (bmesh bevel)."""
    bm = bmesh.new()
    a = [bm.verts.new((x, y0, z)) for x, z in profile]
    b = [bm.verts.new((x, y1, z)) for x, z in profile]
    n = len(profile)
    bm.faces.new(a)
    bm.faces.new(list(reversed(b)))
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((a[i], b[i], b[j], a[j]))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    if r > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=r, segments=1, profile=0.5, affect="EDGES", clamp_overlap=True)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    return bm


def pouch_bm(w, d, h, flap=True, bungee=True, tab=True):
    """High-detail pouch in local space (back face at y=0, front at y=d, bottom at z=0): rounded body, lid and front
    flap, binding along the front edges, pull tab, bungee. Returns {material key: [bmesh]}."""
    parts = {"nylon": [], "webbing": [], "polymer": [], "velcro": []}
    parts["nylon"].append(rbox_bm((w, d, h), (0, d / 2, h / 2), r=0.008, seg=3))
    for sx in (-1, 1):  # edge binding
        parts["webbing"].append(rbox_bm((0.005, 0.005, h - 0.012), (sx * (w / 2 - 0.002), d - 0.001, h / 2), r=0.002, seg=1))
    parts["webbing"].append(rbox_bm((w - 0.01, 0.005, 0.005), (0, d - 0.001, 0.004), r=0.002, seg=1))
    if flap:
        ft = 0.006
        parts["nylon"].append(rbox_bm((w + 0.004, d + 0.006, ft), (0, d / 2 + 0.001, h + ft / 2 - 0.001), r=0.0025, seg=2))
        parts["nylon"].append(rbox_bm((w + 0.004, ft, 0.048), (0, d + ft / 2, h - 0.024), r=0.0025, seg=2))
        if tab:
            parts["polymer"].append(rbox_bm((0.018, 0.006, 0.02), (0, d + ft + 0.002, h - 0.046), r=0.002, seg=1))
    if bungee:
        parts["webbing"].append(rbox_bm((w + 0.006, 0.004, 0.012), (0, d + 0.001, h * 0.42), r=0.0015, seg=1))
    return parts


def pouch_lo(w, d, h, flap=True):
    """Game-density pouch: a softly bevelled block and its flap."""
    parts = {"nylon": [rbox_bm((w, d, h), (0, d / 2, h / 2), r=0.008, seg=1)], "webbing": [], "polymer": [], "velcro": []}
    if flap:
        parts["nylon"].append(box_bm((w + 0.004, 0.006, 0.05), (0, d + 0.003, h - 0.024)))
    return parts


def mag_pouch_bm(w, d, h):
    """Open-top 5.56 pouch (high): body, two magazines standing proud with baseplates, bungee over the top, pull tab,
    two webbing bands across the front (local: back at y=0, bottom at z=0)."""
    parts = {"nylon": [], "webbing": [], "polymer": [], "velcro": []}
    parts["nylon"].append(rbox_bm((w, d, h), (0, d / 2, h / 2), r=0.008, seg=3))
    for mx in (-w / 4 + 0.002, w / 4 - 0.002):
        parts["polymer"].append(rbox_bm((w / 2 - 0.012, d - 0.02, 0.05), (mx, d / 2, h + 0.012), r=0.004, seg=2))
        parts["polymer"].append(rbox_bm((w / 2 - 0.008, d - 0.014, 0.01), (mx, d / 2, h + 0.04), r=0.003, seg=2))
        parts["webbing"].append(box_bm((0.005, d + 0.006, 0.005), (mx, d / 2, h + 0.047)))
        parts["webbing"].append(box_bm((0.005, 0.005, 0.055), (mx, d + 0.002, h + 0.018)))
    parts["polymer"].append(rbox_bm((0.026, 0.006, 0.02), (0, d + 0.004, h - 0.018), r=0.002, seg=1))
    for zz in (0.35, 0.62):
        parts["webbing"].append(box_bm((w + 0.004, 0.004, 0.022), (0, d + 0.001, h * zz)))
    parts["webbing"].append(box_bm((w + 0.002, d + 0.002, 0.008), (0, d / 2, h - 0.003)))
    parts["webbing"].append(box_bm((0.006, 0.003, h * 0.8), (0, d + 0.0005, h * 0.45)))
    return parts


def mag_pouch_lo(w, d, h):
    parts = {"nylon": [rbox_bm((w, d, h), (0, d / 2, h / 2), r=0.008, seg=1)], "webbing": [], "polymer": [], "velcro": []}
    for mx in (-w / 4 + 0.002, w / 4 - 0.002):
        parts["polymer"].append(box_bm((w / 2 - 0.012, d - 0.02, 0.05), (mx, d / 2, h + 0.012)))
        parts["polymer"].append(box_bm((w / 2 - 0.008, d - 0.014, 0.01), (mx, d / 2, h + 0.04)))
    return parts


def build_torso(fit, coll, m, bp):
    objs = []
    # Plate bags. Front: top below the sternal notch, bottom at the navel line; back a little taller.
    front = Plate(fit, +1, 0.352, 0.39, 1.296)
    back = Plate(fit, -1, 0.362, 0.405, 1.29)
    T = 0.034

    def ftop(plate):
        return plate.zc + plate.H / 2

    def fbot(plate):
        return plate.zc - plate.H / 2

    for plate, name, cut in ((front, "Torso_FrontPlate", (0.055, 0.075)), (back, "Torso_BackPlate", (0.045, 0.06))):
        pr = Pair(name)
        pr.low(bevel_bm(plate.mesh(T, *cut, nx=6, nz=5), 0.007, 1), m["nylon"])
        pr.high(bevel_bm(plate.mesh(T, *cut, nx=14, nz=10), 0.008, 3), m["nylon"])
        if plate is front:
            molle_on_plate(pr.hi, front, m["webbing"], fbot(front) + 0.01, ftop(front) - 0.252, -0.158, 0.158, T)
        else:
            molle_on_plate(pr.hi, back, m["webbing"], fbot(back) + 0.014, ftop(back) - 0.14, -0.162, 0.162, T)
        objs.append(pr.finish(coll))

    # Velcro admin field and the SWAT patch on the front top (the back is under the assault pack).
    b = Builder("Torso_Velcro")
    M = front.frame(0.012, ftop(front) - 0.04, T)
    b.add_bm(box_bm((0.21, 0.003, 0.07), (0, 0.0015, 0)), m["velcro"], M)
    objs.append(b.finish(coll, smooth=False))
    b = Builder("Torso_Patches")
    M = front.frame(0.012, ftop(front) - 0.04, T + 0.003)
    b.add_bm(box_bm((0.196, 0.003, 0.064), (0, 0.0015, 0)), m["patch"], M)
    b.add_bm(text_bm("SWAT", 0.048, 0.0), m["text"], M @ Matrix.Translation((0, 0.0036, -0.001)))
    objs.append(b.finish(coll, smooth=False))
    # Left sleeve patch on the uniform's shoulder-pocket velcro, like the reference.
    ua, ub = bp["upperarm.L"]
    axis = (ub - ua).normalized()
    c = ua + (ub - ua) * 0.47
    out_dir = Vector((-1, 0.1, 0.1))
    out_dir = (out_dir - axis * out_dir.dot(axis)).normalized()
    hit = fit.outer(c, out_dir) or c + out_dir * 0.06
    b = Builder("Torso_SleevePatch")
    M = frame(hit + out_dir * 0.002, out_dir, up=-axis) @ Matrix.Translation((0, 0.003, 0))
    b.add_bm(box_bm((0.11, 0.0035, 0.072), (0, 0.00175, 0)), m["patch"], M)
    b.add_bm(text_bm("SWAT", 0.032, 0.0), m["text"], M @ Matrix.Translation((0, 0.0042, -0.0005)))
    objs.append(b.finish(coll, smooth=False))

    # Mag pouches: three 5.56 doubles on the lower front.
    pr = Pair("Torso_MagPouches")
    z0 = ftop(front) - 0.072 - 0.05 - 0.125
    for x in (-0.096, 0.0, 0.096):
        M = front.frame(x, z0, T + 0.008)
        pr.parts(mag_pouch_lo(0.09, 0.056, 0.125), mag_pouch_bm(0.09, 0.056, 0.125), M, m)
    objs.append(pr.finish(coll))

    # Cummerbund: wraps from under the front plate's sides around to the back plate.
    th_f = math.atan2(0.09, front.W / 2 - 0.04)
    th_b = -math.atan2(0.08, back.W / 2 - 0.04)

    def cumm(s, nth, nz):
        cols_p, cols_n = [], []
        for th in np.linspace(th_f, th_b, nth):
            row_p, row_n = [], []
            for z in np.linspace(1.09, 1.255, nz):
                ang = th if s > 0 else math.pi - th
                p, d = fit.radial(Vector((0, fit.axis_y(z), z)), ang, 0.16)
                row_p.append(p + d * 0.005)
                row_n.append(d)
            cols_p.append(row_p)
            cols_n.append(row_n)
        return shell_bm(cols_p, cols_n, 0.034)

    pr = Pair("Torso_Cummerbund")
    for s in (1, -1):
        pr.low(cumm(s, 7, 3), m["nylon"])
        pr.high(bevel_bm(cumm(s, 15, 6), 0.005, 2), m["nylon"])
        for zc in (1.13, 1.17, 1.21):
            seg_th = np.linspace(th_f - 0.25, th_b + 0.25, 7)
            for k in range(len(seg_th) - 1):
                ta, tb = seg_th[k], seg_th[k + 1] - 0.03
                pa, da = fit.radial(Vector((0, fit.axis_y(zc), zc)), ta if s > 0 else math.pi - ta, 0.16)
                pb, db = fit.radial(Vector((0, fit.axis_y(zc), zc)), tb if s > 0 else math.pi - tb, 0.16)
                d = (da + db).normalized()
                cc = (pa + pb) / 2 + d * 0.0395
                pr.high(box_bm(((pb - pa).length, 0.003, 0.025), (0, 0.0015, 0)), m["webbing"], frame(cc, d))
    objs.append(pr.finish(coll))

    # Side pouches on the cummerbund (one each side).
    pr = Pair("Torso_SidePouches")
    for deg in (8, 172):
        ang = math.radians(deg)
        z = 1.115
        p, d = fit.radial(Vector((0, fit.axis_y(z + 0.06), z + 0.06)), ang, 0.16)
        M = frame(p + d * 0.041 - Vector((0, 0, 0.06)), d)
        pr.parts(pouch_lo(0.072, 0.048, 0.125), pouch_bm(0.072, 0.048, 0.125, flap=True, bungee=True), M, m)
    objs.append(pr.finish(coll))

    # Padded shoulder straps from the front plate top over the trapezius to the back plate top.
    def strap(s, xs, nphi, lift=0.004, thick=0.042, phis=(8, 172)):
        cols_p, cols_n = [], []
        for phi in np.linspace(math.radians(phis[0]), math.radians(phis[1]), nphi):
            d = Vector((0, math.cos(phi), math.sin(phi)))
            row_p, row_n = [], []
            for x in xs:
                cc = Vector((x, fit.axis_y(1.37), 1.37))
                p = fit.outer(cc, d, gap=0.018, maxd=0.3) or cc + d * 0.13
                row_p.append(p + d * lift)
                row_n.append(d)
            cols_p.append(row_p)
            cols_n.append(row_n)
        return shell_bm(cols_p, cols_n, thick), cols_p, cols_n

    pr = Pair("Torso_ShoulderStraps")
    for s in (1, -1):
        pr.low(strap(s, [s * (0.112 + dx) for dx in (-0.041, 0.041)], 9)[0], m["nylon"])
        pr.high(bevel_bm(strap(s, [s * (0.112 + dx) for dx in (-0.041, -0.02, 0.0, 0.02, 0.041)], 17)[0], 0.009, 2), m["nylon"])
    objs.append(pr.finish(coll))

    objs += build_backpack(fit, coll, m, back, T, strap)
    return objs, front, back


def build_backpack(fit, coll, m, back, T, strap):
    """A boxy black MOLLE assault pack over the back plate (top at shoulder height, bottom at the belt), with a front
    pocket, side bottle pouches, compression straps, a grab handle, shoulder straps over the carrier's, the radio on
    its left side and a hydration tube over the left shoulder."""
    objs = []
    z_lo, z_hi = 1.085, 1.49
    H = z_hi - z_lo
    W, D = 0.32, 0.135
    M = back.frame(0.0, (z_lo + z_hi) / 2, T + 0.008)
    # Lean the pack's top back a little so it clears the back of the helmet.
    M = M @ Matrix.Rotation(math.radians(-2), 4, "X")
    pr = Pair("Torso_Backpack")
    lo_parts, hi_parts = [], []

    def add(size, center, r, seg_lo, seg_hi, mat="nylon"):
        pr.low(rbox_bm(size, center, r=r, seg=seg_lo) if seg_lo else box_bm(size, center), m[mat], M)
        pr.high(rbox_bm(size, center, r=r, seg=seg_hi), m[mat], M)

    add((W, D, H), (0, D / 2, 0), 0.03, 2, 4)  # main bag
    add((W - 0.06, 0.05, H * 0.55), (0, D + 0.022, -H * 0.17), 0.016, 2, 3)  # front pocket
    add((W - 0.1, 0.035, 0.07), (0, D + 0.012, H * 0.33), 0.01, 1, 3)  # admin pocket up top
    for sx in (-1, 1):
        add((0.06, 0.1, 0.2), (sx * (W / 2 + 0.026), D * 0.5, -H * 0.24), 0.014, 2, 3)  # side bottle pouches
        for zz in (-0.06, 0.08):  # compression straps across the sides (box low, buckle in both)
            c = (sx * (W / 2 + 0.003), D * 0.5, zz)
            pr.low(box_bm((0.008, D * 0.9, 0.022), c), m["webbing"], M)
            pr.high(rbox_bm((0.008, D * 0.9, 0.022), c, r=0.002, seg=1), m["webbing"], M)
            pr.both(box_bm((0.012, 0.03, 0.03), (sx * (W / 2 + 0.008), D * 0.85, zz)), m["polymer"], M)
        # Straps down the front pocket.
        c = (sx * 0.075, D + 0.049, -H * 0.15)
        pr.low(box_bm((0.022, 0.006, H * 0.62), c), m["webbing"], M)
        pr.high(rbox_bm((0.022, 0.006, H * 0.62), c, r=0.002, seg=1), m["webbing"], M)
        pr.both(box_bm((0.03, 0.012, 0.032), (sx * 0.075, D + 0.054, -H * 0.36)), m["polymer"], M)
    # Grab handle on top.
    pr.both(box_bm((0.1, 0.022, 0.012), (0, D * 0.35, H / 2 + 0.008)), m["webbing"], M)
    # Bake detail: MOLLE on the front pocket and the bag's front, zip beads round the front panel and the lid.
    Mf = M @ Matrix.Translation((0, D, 0))
    molle_rows(pr.hi, m["webbing"], W - 0.04, H * 0.3, (0, H * 0.06), Mf)
    molle_rows(pr.hi, m["webbing"], W - 0.1, H * 0.4, (0, -H * 0.2), M @ Matrix.Translation((0, D + 0.047, 0)))
    for sx in (-1, 1):
        Ms = M @ Matrix.Translation((sx * (W / 2 + 0.056), D * 0.5, 0)) @ Matrix.Rotation(-sx * math.pi / 2, 4, "Z")
        molle_rows(pr.hi, m["webbing"], 0.08, 0.16, (0, -H * 0.24), Ms)
    for zz in (H / 2 - 0.012, -H / 2 + 0.012):
        pr.high(box_bm((W - 0.03, 0.006, 0.004), (0, D - 0.004, zz)), m["webbing"], M)
    for sx in (-1, 1):
        pr.high(box_bm((0.004, 0.006, H - 0.04), (sx * (W / 2 - 0.004), D - 0.004, 0)), m["webbing"], M)
    objs.append(pr.finish(coll))

    # Pack shoulder straps over the carrier's (to the chest, the sternum strap between them) and the hydration tube.
    pr = Pair("Torso_PackStraps")
    for s in (1, -1):
        lo, cols_p, cols_n = strap(s, [s * (0.105 + dx) for dx in (-0.026, 0.026)], 8, lift=0.05, thick=0.014, phis=(22, 150))
        pr.low(lo, m["nylon"])
        pr.high(bevel_bm(strap(s, [s * (0.105 + dx) for dx in (-0.026, 0.0, 0.026)], 14, lift=0.05, thick=0.014, phis=(22, 150))[0], 0.005, 2), m["nylon"])
        # Ladder-lock buckle and the strap tail at the front end.
        p0, n0 = cols_p[0][0].lerp(cols_p[0][1], 0.5), cols_n[0][0]
        Mb = frame(p0 + n0 * 0.016, n0, up=Vector((0, 0, 1)))
        pr.both(box_bm((0.056, 0.008, 0.028), (0, 0, 0.0)), m["polymer"], Mb)
        if s < 0:
            # Hydration tube: out of the pack's top, over the left strap, down the chest to a bite valve.
            pts = [M @ Vector((-0.05, D * 0.4, H / 2 - 0.01)), M @ Vector((-0.06, D * 0.1, H / 2 + 0.03))]
            for i in range(len(cols_p) - 1, -1, -1):
                q = cols_p[i][0].lerp(cols_p[i][1], 0.25) + cols_n[i][0] * 0.024
                if q.z > pts[-1].z - 0.2:
                    pts.append(q)
            pts.append(pts[-1] + Vector((0.01, 0.012, -0.06)))
            pr.low(tube_bm(pts, 0.0065, 5), m["rubber"])
            pr.high(tube_bm(pts, 0.0065, 10), m["rubber"])
            pr.both(cyl_bm(0.009, 0.007, 0.03, 8), m["rubber"], Matrix.Translation(pts[-1]) @ (pts[-1] - pts[-2]).normalized().to_track_quat("Z", "Y").to_matrix().to_4x4())
    objs.append(pr.finish(coll))

    # Radio pouch with radio and antenna on the pack's upper left side; the antenna stands up behind the shoulder.
    pr = Pair("Torso_Radio")
    Mr = M @ Matrix.Translation((-(W / 2), D * 0.45, H * 0.12)) @ Matrix.Rotation(math.pi / 2, 4, "Z")
    pr.parts({"nylon": [rbox_bm((0.062, 0.038, 0.105), (0, 0.019, 0.0525), r=0.006, seg=1)]}, pouch_bm(0.062, 0.038, 0.105, flap=False, bungee=True, tab=False), Mr, m)
    pr.low(box_bm((0.052, 0.03, 0.05), (0, 0.022, 0.125)), m["polymer"], Mr)
    pr.high(rbox_bm((0.052, 0.03, 0.05), (0, 0.022, 0.125), r=0.004, seg=2), m["polymer"], Mr)
    pr.both(cyl_bm(0.008, 0.008, 0.016, 6, (0.013, 0.022, 0.158)), m["polymer"], Mr)
    ant = cyl_bm(0.0042, 0.0022, 0.175, 5, (0, 0, 0.0875))
    rot = Matrix.Rotation(math.radians(-6), 4, "Y") @ Matrix.Rotation(math.radians(-5), 4, "X")
    pr.both(ant, m["rubber"], Mr @ Matrix.Translation((-0.012, 0.022, 0.15)) @ rot)
    pr.high(rbox_bm((0.014, 0.012, 0.03), (0.034, 0.022, 0.11), r=0.003, seg=1), m["polymer"], Mr)
    objs.append(pr.finish(coll))
    return objs


def tube_bm(pts, r, sides):
    """A tube along the polyline `pts` (open ends)."""
    bm = bmesh.new()
    rings = []
    for i, p in enumerate(pts):
        a = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
        a.normalize()
        u = a.orthogonal().normalized()
        v = a.cross(u)
        rings.append([bm.verts.new(p + (u * math.cos(2 * math.pi * k / sides) + v * math.sin(2 * math.pi * k / sides)) * r) for k in range(sides)])
    # Keep the ring frames from twisting: re-index each ring to its nearest start vertex.
    for i in range(1, len(rings)):
        prev = rings[i - 1][0].co
        k0 = min(range(sides), key=lambda k: (rings[i][k].co - prev).length)
        rings[i] = rings[i][k0:] + rings[i][:k0]
    for r0, r1 in zip(rings[:-1], rings[1:]):
        for k in range(sides):
            try:
                bm.faces.new((r0[k], r0[(k + 1) % sides], r1[(k + 1) % sides], r1[k]))
            except ValueError:
                pass
    bm.normal_update()
    return bm


def build_belt(fit, coll, m, bp):
    objs = []
    zlo, zhi = 0.962, 1.024
    zm = (zlo + zhi) / 2

    def ring(n):
        ring_p, ring_n = [], []
        for k in range(n):
            th = 2 * math.pi * k / n
            row_p, row_n = [], []
            for z in (zlo, zhi):
                p, d = fit.radial(Vector((0, fit.axis_y(z), z)), th, 0.15)
                row_p.append(p + d * 0.004)
                row_n.append(d)
            ring_p.append(row_p)
            ring_n.append(row_n)
        return shell_bm(ring_p, ring_n, 0.017, close_u=True)

    def on_belt(theta, z=zm, out=0.021):
        p, d = fit.radial(Vector((0, fit.axis_y(z), z)), theta, 0.15)
        return frame(p + d * out, d)

    pr = Pair("Torso_Belt")
    pr.low(ring(24), m["nylon"])
    # The high belt keeps the low ring as its base (a rounder high ring bakes zigzags along the thin edges).
    pr.high(ring(24), m["nylon"])
    for z in (zlo + 0.008, zhi - 0.008):  # stitch beads
        for k in range(48):
            th = 2 * math.pi * (k + 0.5) / 48
            pr.high(box_bm((0.02, 0.0015, 0.0015), (0, 0.0007, 0)), m["webbing"], on_belt(th, z, out=0.0205))
    # Buckle (cobra-style) at the front; keepers round the belt (bake detail).
    M = on_belt(math.pi / 2)
    pr.low(rbox_bm((0.086, 0.012, 0.05), (0, 0.006, 0), r=0.004, seg=1), m["polymer"], M)
    pr.high(rbox_bm((0.086, 0.012, 0.05), (0, 0.006, 0), r=0.004, seg=2), m["polymer"], M)
    pr.both(box_bm((0.04, 0.006, 0.03), (0, 0.014, 0)), m["metal"], M)
    for side in (-1, 1):
        pr.both(box_bm((0.01, 0.009, 0.046), (side * 0.036, 0.013, 0)), m["polymer"], M)
    for deg in (40, 140, 215, 250, 290, 325):
        pr.high(rbox_bm((0.016, 0.005, 0.066), (0, 0.0025, 0), r=0.0015, seg=1), m["webbing"], on_belt(math.radians(deg), out=0.0205))
    objs.append(pr.finish(coll))

    # Belt pouches: two pistol-mag pouches front left, a utility pouch on the left hip, two at the back, one small.
    # (Two objects of < 300 tris each: build_swat halves any bigger "beltpouch" mesh first when over its budget.)
    for name, spec in (("Torso_BeltPouchesFront", [(116, -0.026, (0.036, 0.03, 0.092), True), (129, -0.026, (0.036, 0.03, 0.092), True),
                                                   (58, -0.02, (0.04, 0.034, 0.085), False)]),
                       ("Torso_BeltPouchesBack", [(196, -0.045, (0.08, 0.045, 0.1), True), (236, -0.05, (0.085, 0.048, 0.1), True),
                                                  (304, -0.05, (0.085, 0.048, 0.1), True)])):
        pr = Pair(name)
        for deg, dz, (w, d, h), tab in spec:
            M = on_belt(math.radians(deg), out=0.021) @ Matrix.Translation((0, 0, dz)) @ Matrix.Scale(1.15, 4)
            pr.parts(pouch_lo(w, d, h), pouch_bm(w, d, h, flap=True, bungee=False, tab=tab), M, m)
        objs.append(pr.finish(coll))

    pr = Pair("Torso_MedicPouch")
    M = on_belt(math.radians(270), out=0.021) @ Matrix.Translation((0, 0, -0.055)) @ Matrix.Scale(1.15, 4)
    pr.low(rbox_bm((0.165, 0.062, 0.112), (0, 0.031, 0.056), r=0.014, seg=1), m["nylon"], M)
    pr.high(rbox_bm((0.165, 0.062, 0.112), (0, 0.031, 0.056), r=0.014, seg=3), m["nylon"], M)
    pr.high(rbox_bm((0.168, 0.004, 0.006), (0, 0.062, 0.093), r=0.0015, seg=1), m["webbing"], M)  # zip seam
    for sz in ((0.046, 0.016), (0.016, 0.046)):
        pr.both(box_bm((sz[0], 0.003, sz[1]), (0, 0.0635, 0.05)), m["cross"], M)
    pr.high(rbox_bm((0.1, 0.006, 0.032), (0, 0.0, 0.112), r=0.002, seg=1), m["webbing"], M)  # belt loop
    objs.append(pr.finish(coll))

    # Left drop pouch on the thigh: pouch, leg band and the hanger strap from the belt.
    la, lb = bp["thigh.L"]

    def lthigh(z, ang):
        t = (z - la.z) / (lb.z - la.z)
        c = la + (lb - la) * t
        d = Vector((math.cos(ang), math.sin(ang), 0))
        p = fit.outer(c, d, gap=0.03, maxd=0.25)
        return (p if p is not None else c + d * 0.085), d

    pr = Pair("Torso_DropPouch")
    p, d = lthigh(0.87, math.radians(165))
    M = frame(p + d * 0.006, d) @ Matrix.Translation((0, 0, -0.075)) @ Matrix.Scale(1.15, 4)
    pr.parts(pouch_lo(0.125, 0.06, 0.15), pouch_bm(0.125, 0.06, 0.15, flap=True, bungee=True, tab=True), M, m)
    pr.low(band_bm(lthigh, 0.80, 0.832, 12), m["webbing"])
    pr.high(band_bm(lthigh, 0.80, 0.832, 32), m["webbing"])
    objs.append(pr.finish(coll))
    pr = Pair("Torso_DropHanger")
    q, dd = lthigh(0.965, math.radians(165))
    pr.low(box_bm((0.03, 0.006, 0.075), (0, 0.003, -0.012)), m["webbing"], frame(q + dd * 0.004, dd))
    objs.append(pr.finish(coll))

    # Right drop holster: leg platform on the outside of the right thigh, holster, hood, grip; thigh straps.
    ta, tb = bp["thigh.R"]

    def thigh_surf(z, ang):
        t = (z - ta.z) / (tb.z - ta.z)
        c = ta + (tb - ta) * t
        d = Vector((math.cos(ang), math.sin(ang), 0))
        p = fit.outer(c, d, gap=0.03, maxd=0.25)
        return (p if p is not None else c + d * 0.085), d

    def platform(nz, na):
        pp, nn = [], []
        for z in np.linspace(0.80, 0.975, nz):
            rp, rn = [], []
            for a in np.linspace(math.radians(-17), math.radians(17), na):
                p, d = thigh_surf(z, a)
                rp.append(p + d * 0.004)
                rn.append(d)
            pp.append(rp)
            nn.append(rn)
        return shell_bm(pp, nn, 0.008)

    pr = Pair("Torso_Holster")
    pr.low(platform(4, 3), m["polymer"])
    pr.high(bevel_bm(platform(9, 6), 0.003, 2), m["polymer"])
    pc, dc = thigh_surf(0.875, 0.0)
    H = frame(pc + dc * 0.012, dc) @ Matrix.Rotation(math.radians(8), 4, "Y")
    prof = [(-0.04, 0.075), (0.036, 0.075), (0.04, 0.05), (0.052, 0.038), (0.05, -0.004), (0.026, -0.018),
            (0.022, -0.14), (0.01, -0.155), (-0.022, -0.155), (-0.032, -0.14), (-0.042, 0.04)]
    pr.low(prism_bm(prof, 0.0, 0.056), m["polymer"], H)
    pr.high(prism_bm(prof, 0.0, 0.056, r=0.009), m["polymer"], H)
    pr.high(rbox_bm((0.05, 0.008, 0.1), (0.0, 0.059, -0.06), r=0.003, seg=1), m["polymer"], H)  # outer rib
    for (sx, sz) in ((0.03, 0.02), (-0.026, -0.03), (0.012, -0.12)):
        pr.high(cyl_bm(0.0055, 0.0055, 0.006, 8), m["metal"], H @ Matrix.Translation((sx, 0.059, sz)) @ Matrix.Rotation(math.pi / 2, 4, "X"))
    # Pistol slide rear standing out of the holster mouth, the retention hood rotated down over it.
    pr.both(box_bm((0.074, 0.026, 0.026), (0.0, 0.024, 0.088)), m["metal"], H)
    hood = H @ Matrix.Translation((0.004, 0.024, 0.098))
    pr.low(box_bm((0.05, 0.06, 0.016), (0.0, 0.0, 0.012)), m["polymer"], hood)
    pr.high(rbox_bm((0.05, 0.06, 0.016), (0.0, 0.0, 0.012), r=0.005, seg=2), m["polymer"], hood)
    for sy in (-0.026, 0.026):
        pr.both(box_bm((0.05, 0.008, 0.05), (0.0, sy, -0.008)), m["polymer"], hood)
    pr.both(cyl_bm(0.007, 0.007, 0.066, 6), m["metal"], H @ Matrix.Translation((0.03, 0.024, 0.07)) @ Matrix.Rotation(math.pi / 2, 4, "X"))
    G = H @ Matrix.Translation((-0.03, 0.024, 0.078)) @ Matrix.Rotation(math.radians(-20), 4, "Y")
    pr.low(rbox_bm((0.032, 0.028, 0.095), (-0.006, 0, 0.0475), r=0.007, seg=1), m["polymer"], G)
    pr.high(rbox_bm((0.032, 0.028, 0.095), (-0.006, 0, 0.0475), r=0.007, seg=2), m["polymer"], G)
    pr.both(box_bm((0.02, 0.022, 0.01), (-0.024, 0, 0.012)), m["polymer"], G)
    objs.append(pr.finish(coll))
    # Hanger strap from the belt to the platform (blends hips into the thigh).
    pr = Pair("Torso_HolsterHanger")
    q, dd = thigh_surf(0.985, 0.0)
    pr.low(box_bm((0.045, 0.006, 0.06), (0, 0.003, 0.0)), m["webbing"], frame(q + dd * 0.006, dd))
    objs.append(pr.finish(coll))

    pr = Pair("Torso_ThighStrap")
    for zc, h in ((0.735, 0.034), (0.84, 0.03)):
        pr.low(band_bm(thigh_surf, zc - h / 2, zc + h / 2, 12), m["webbing"])
        pr.high(band_bm(thigh_surf, zc - h / 2, zc + h / 2, 32), m["webbing"])
        p, d = thigh_surf(zc, math.radians(55))
        Mb = frame(p + d * 0.006, d)
        pr.low(box_bm((0.04, 0.01, 0.034), (0, 0.005, 0)), m["polymer"], Mb)
        pr.high(rbox_bm((0.04, 0.01, 0.034), (0, 0.005, 0), r=0.003, seg=1), m["polymer"], Mb)
    objs.append(pr.finish(coll))
    return objs


def band_bm(surf, z0, z1, n, lift=0.003, thick=0.004):
    """A strap round a limb: `surf(z, angle)` gives the surface point and outward direction."""
    pp, nn = [], []
    for k in range(n):
        a = 2 * math.pi * k / n
        rp, rn = [], []
        for z in (z0, z1):
            p, d = surf(z, a)
            rp.append(p + d * lift)
            rn.append(d)
        pp.append(rp)
        nn.append(rn)
    return shell_bm(pp, nn, thick, close_u=True)


# ---- weights -------------------------------------------------------------------------------------------------------

def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def set_weights(ob, fn):
    """fn(world co) -> {bone: weight}; replaces the object's vertex groups."""
    for g in list(ob.vertex_groups):
        ob.vertex_groups.remove(g)
    groups = {}
    for v in ob.data.vertices:
        ws = fn(ob.matrix_world @ v.co)
        tot = sum(ws.values()) or 1.0
        for bone, w in ws.items():
            if w <= 1e-4:
                continue
            if bone not in groups:
                groups[bone] = ob.vertex_groups.new(name=bone)
            groups[bone].add([v.index], w / tot, "REPLACE")


def copy_weights(ob, src, k=4, bones=None):
    """Bone weights from the nearest vertices of `src` (the uniform under a strap), inverse-distance averaged."""
    from mathutils.kdtree import KDTree
    sv = src.data.vertices
    kd = KDTree(len(sv))
    for v in sv:
        kd.insert(src.matrix_world @ v.co, v.index)
    kd.balance()
    gname = {g.index: g.name for g in src.vertex_groups}

    def fn(co):
        acc = {}
        for _c, i, dist in kd.find_n(co, k):
            wi = 1.0 / (dist + 0.004)
            for g in sv[i].groups:
                name = gname.get(g.group)
                if name and (bones is None or name in bones):
                    acc[name] = acc.get(name, 0.0) + g.weight * wi
        top = sorted(acc.items(), key=lambda kv: -kv[1])[:4]
        return dict(top) if top else {"hips": 1.0}

    set_weights(ob, fn)


def carrier_w(co):
    c = smoothstep(1.12 * 1.0, 1.32, co.z)
    return {"chest": c, "spine": 1.0 - c}


def weight_gear(coll, ref):
    """Every exported piece gets its own bone weights (build_swat keeps them): carrier and pack ride chest and spine,
    the belt and its pouches the hips, leg gear its thigh (hangers blend from the hips), straps and the sleeve patch
    copy the uniform under them so they never float off it."""
    trousers = ref.objects.get("Body_Trousers")
    shirt = ref.objects.get("Body_Shirt")
    for ob in coll.objects:
        if ob.get("high") or ob.type != "MESH":
            continue
        n = ob.name
        if n in ("Torso_Belt", "Torso_BeltPouchesFront", "Torso_BeltPouchesBack", "Torso_MedicPouch"):
            set_weights(ob, lambda co: {"hips": 1.0})
        elif n in ("Torso_DropPouch", "Torso_Holster"):
            side = "L" if "Drop" in n else "R"
            set_weights(ob, lambda co, s=side: {f"thigh.{s}": 1.0})
        elif "Hanger" in n:
            side = "L" if "Drop" in n else "R"
            set_weights(ob, lambda co, s=side: {f"thigh.{s}": smoothstep(1.01, 0.93, co.z), "hips": 1.0 - smoothstep(1.01, 0.93, co.z)})
        elif n == "Torso_ThighStrap":
            if trousers:
                copy_weights(ob, trousers, bones={"thigh.R", "hips", "thigh.L"})
            else:
                set_weights(ob, lambda co: {"thigh.R": 1.0})
        elif n == "Torso_SleevePatch":
            if shirt:
                copy_weights(ob, shirt, bones={"upperarm.L", "chest", "forearm.L"})
            else:
                set_weights(ob, lambda co: {"upperarm.L": 1.0})
        else:
            set_weights(ob, carrier_w)


# ---- preview -------------------------------------------------------------------------------------------------------

def studio():
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for kind in ("OPTIX", "CUDA"):
            try:
                prefs.compute_device_type = kind
                prefs.get_devices()
                for dv in prefs.devices:
                    dv.use = True
                sc.cycles.device = "GPU"
                break
            except Exception:
                continue
    except Exception:
        pass
    sc.cycles.samples = 96
    sc.cycles.use_denoising = True
    try:
        sc.view_settings.view_transform = "AgX"
        sc.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        pass
    sc.view_settings.exposure = -0.7  # the reference: near-black gear against a light grey studio
    world = bpy.data.worlds.new("Studio")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.62, 0.63, 0.65, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 1.5
    sc.world = world
    floor_m = material("Ref_Floor", lin("#d4d5d8"), 0.8)
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=6)
    me = bpy.data.meshes.new("Floor")
    bm.to_mesh(me)
    me.materials.append(floor_m)
    fl = bpy.data.objects.new("Ref_Floor", me)
    sc.collection.objects.link(fl)

    def area(name, loc, energy, size, target=(0, 0, 1.2)):
        ld = bpy.data.lights.new(name, "AREA")
        ld.energy = energy
        ld.size = size
        lo = bpy.data.objects.new(name, ld)
        lo.location = loc
        d = Vector(target) - Vector(loc)
        lo.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        sc.collection.objects.link(lo)
        return lo

    area("Key", (-2.2, 2.8, 3.4), 520, 2.5)
    area("Fill", (2.8, 2.4, 1.8), 200, 3.0)
    area("Rim", (0.5, -3.0, 3.2), 380, 2.0)
    area("Top", (0, 0.5, 4.2), 140, 3.0)
    cam_d = bpy.data.cameras.new("Cam")
    cam = bpy.data.objects.new("Cam", cam_d)
    sc.collection.objects.link(cam)
    sc.camera = cam
    return cam


def shoot(cam, path, loc, target, lens, res):
    sc = bpy.context.scene
    cam.location = loc
    d = Vector(target) - Vector(loc)
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = lens
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def previews(out_dir):
    cam = studio()
    views = {
        "front": ((0, 7.0, 1.0), (0, 0, 0.98), 55, (560, 1000)),
        "front_torso": ((0, 1.75, 1.18), (0, 0, 1.12), 50, (760, 900)),
        "back_torso": ((0, -1.75, 1.18), (0, 0, 1.12), 50, (760, 900)),
        "holster_side": ((1.25, 0.0, 0.92), (0.15, 0.0, 0.9), 70, (600, 760)),
        "left": ((-7.0, 0.0, 1.0), (0, 0, 0.98), 55, (560, 1000)),
        "back": ((0, -7.0, 1.0), (0, 0, 0.98), 55, (560, 1000)),
        "34": ((-4.8, 5.0, 1.15), (0, 0, 0.98), 55, (560, 1000)),
        "carrier": ((0.0, 1.55, 1.30), (0, 0.1, 1.24), 50, (700, 760)),
        "carrier_back": ((0.0, -1.55, 1.32), (0, -0.1, 1.26), 50, (700, 760)),
        "holster": ((1.15, 0.55, 0.95), (0.18, 0.0, 0.9), 60, (600, 760)),
    }
    skin = bpy.data.objects.get("Body_Skin")
    hold_views = {
        "front_hold": ((0, 3.3, 1.2), (0, 0, 1.05), 50, (700, 1000)),
        "34_hold": ((2.3, 2.4, 1.3), (0, 0, 1.0), 50, (700, 1000)),  # right-front, like the sheet's 3/4
        "front34_hold": ((-1.6, 3.0, 1.3), (0, 0, 1.0), 50, (700, 1000)),  # the pose sheet's front three-quarter
        "rear34_hold": ((-2.0, -2.6, 1.35), (0, 0, 1.0), 50, (700, 1000)),
        "left_hold": ((-3.3, 0, 1.25), (0, 0, 1.05), 50, (700, 1000)),
    }
    for name, (loc, tgt, lens, res) in views.items():
        if skin:
            skin.hide_render = name == "holster_side"  # the A-pose hand hangs in front of the holster
        shoot(cam, out_dir / f"torso_{name}.png", loc, tgt, lens, res)
        log(f"rendered {name}")
    if skin:
        skin.hide_render = False
    posed = pose_hold()
    if posed:
        for name, (loc, tgt, lens, res) in hold_views.items():
            shoot(cam, out_dir / f"torso_{name}.png", loc, tgt, lens, res)
            log(f"rendered {name}")
        # Back to the A-pose with no deform modifiers, exactly where the gear was built.
        for o in posed:
            for md in list(o.modifiers):
                if md.type == "ARMATURE":
                    o.modifiers.remove(md)
        arm = bpy.data.objects.get("Survivor")
        if arm and arm.animation_data:
            arm.animation_data.action = None
        for pb in arm.pose.bones:
            pb.matrix_basis = Matrix.Identity(4)
        bpy.context.view_layer.update()


def pose_hold():
    """The game's idle ready stance (swat_anim.build_clips 'idle', frame 1) on the body's armature, falling back to
    build_zombies' IK hold. The gear deforms with its own export weights (weight_gear), as in the game; preview only."""
    arm = bpy.data.objects.get("Survivor")
    if not arm or arm.type != "ARMATURE":
        return None
    posed_objs = []
    for o in bpy.data.collections["Torso"].objects:
        if o.get("high"):
            continue
        md = o.modifiers.new("Armature", "ARMATURE")
        md.object = arm
        posed_objs.append(o)
    posed = False
    anim_py = HERE / "swat_anim.py"
    if anim_py.exists():
        try:
            spec = importlib.util.spec_from_file_location("swat_anim", anim_py)
            sa = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(sa)
            sa.build_clips(arm, bz)
            act = bpy.data.actions.get("idle")
            arm.animation_data_create()
            arm.animation_data.action = act
            try:
                if getattr(act, "slots", None):
                    arm.animation_data.action_slot = act.slots[0]
            except Exception:
                pass
            bpy.context.scene.frame_set(1)
            posed = True
            log("preview pose: swat_anim idle")
        except Exception as e:
            log(f"swat_anim idle failed ({e}); using the IK hold")
    if not posed:
        g = bz.GRIP * S
        hold = bz.solve_hold(arm, bz.TORSO_AIM, right_wrist=g + Vector((0.025, -0.065, 0.045)), right_aim=g + Vector((-0.03, 0.02, -0.08)),
                             left_wrist=g + Vector((-0.07, 0.2, 0.0)), left_aim=g + Vector((-0.01, 0.27, 0.06)))
        pose = dict(bz.TORSO_AIM)
        pose.update(hold)
        for pb in arm.pose.bones:
            pb.rotation_mode = "XYZ"
            pb.rotation_euler = tuple(math.radians(a) for a in pose.get(pb.name, (0, 0, 0)))
    bpy.context.view_layer.update()
    return posed_objs


# ---- main ------------------------------------------------------------------------------------------------------------

def main():
    clear_scene()
    ref = collection("BodyRef")
    real = load_body(ref)
    bpy.context.view_layer.update()
    fit = Fit([o for o in ref.objects if o.type == "MESH"])
    bp = bone_points()
    m = mats()
    coll = collection("Torso")
    objs, front, back = build_torso(fit, coll, m, bp)
    objs += build_belt(fit, coll, m, bp)
    weight_gear(coll, ref)
    tris = high = 0
    for o in coll.objects:
        o.data.calc_loop_triangles()
        nt = len(o.data.loop_triangles)
        if o.get("high"):
            high += nt
        else:
            tris += nt
        log(f"  {o.name}: {nt} tris{' (bake source)' if o.get('high') else ''}")
    log(f"Torso export: {tris} tris, bake sources: {high} tris ({'real body' if real else 'stand-in'})")
    if PREVIEW:
        previews(PREVIEW)
    # The saved part file holds only the Torso collection.
    for o in list(ref.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.data.collections.remove(ref)
    for o in list(bpy.context.scene.collection.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    try:
        bpy.ops.outliner.orphans_purge(do_recursive=True)
    except Exception:
        pass
    OUT_BLEND.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT_BLEND), compress=True)
    log(f"saved {OUT_BLEND}")


main()
