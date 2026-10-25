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

Pieces: front and back plate bags (shooter's cut, padded edges), cummerbund, padded shoulder straps, laser-cut style
MOLLE rows (flat 25 mm webbing, bar-tack gaps), white "SWAT" patches front, back and on the left sleeve, three 5.56
mag pouches with flaps and bungee, radio pouch with radio and antenna, side pouches, drag handle, the tactical belt
with buckle and keepers, pistol-mag pouches, a utility pouch, a medic pouch with a cross at the back, and a right drop
holster (leg platform, polymer holster with retention hood, pistol grip, thigh strap with buckle).
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

    def mesh(self, thick, cut_w, cut_h, low_cut=0.022):
        W, H = self.W, self.H
        nx, nz = 12, 9
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


def molle_on_plate(b, plate, mat, z0, z1, x0, x1, base_out, pitch=0.038, strip=0.025, col=0.0381, gap=0.0045):
    """Rows of flat 25 mm webbing on a plate face, cut into bar-tacked segments: one low-poly box per segment, raised
    3 mm and set on the plate's local tangent so the rows follow its curve."""
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
    """A pouch in local space: back face at y=0, front at y=d, bottom at z=0; returns {material key: bmesh}."""
    parts = {"nylon": [], "webbing": [], "polymer": [], "velcro": []}
    parts["nylon"].append(rbox_bm((w, d, h), (0, d / 2, h / 2), r=0.007, seg=1 if w < 0.09 else 2))
    if flap:
        ft = 0.006
        parts["nylon"].append(rbox_bm((w + 0.004, d + 0.006, ft), (0, d / 2 + 0.001, h + ft / 2 - 0.001), r=0.0025, seg=1))
        parts["nylon"].append(rbox_bm((w + 0.004, ft, 0.048), (0, d + ft / 2, h - 0.024), r=0.0025, seg=1))
        if tab:
            parts["polymer"].append(rbox_bm((0.018, 0.006, 0.02), (0, d + ft + 0.002, h - 0.046), r=0.002, seg=1))
    if bungee:
        parts["webbing"].append(rbox_bm((w + 0.006, 0.004, 0.012), (0, d + 0.001, h * 0.42), r=0.0015, seg=1))
    return parts


def mag_pouch_bm(w, d, h):
    """Open-top 5.56 pouch: body, a magazine standing proud with its baseplate, bungee over the top, pull tab, and
    two webbing bands across the front (local: back at y=0, bottom at z=0)."""
    parts = {"nylon": [], "webbing": [], "polymer": [], "velcro": []}
    parts["nylon"].append(rbox_bm((w, d, h), (0, d / 2, h / 2), r=0.008, seg=1))
    for mx in (-w / 4 + 0.002, w / 4 - 0.002):  # two magazines per pouch, like the sheet's doubles
        parts["polymer"].append(rbox_bm((w / 2 - 0.012, d - 0.02, 0.05), (mx, d / 2, h + 0.012), r=0.004, seg=1))
        parts["polymer"].append(rbox_bm((w / 2 - 0.008, d - 0.014, 0.01), (mx, d / 2, h + 0.04), r=0.003, seg=1))
        parts["webbing"].append(box_bm((0.005, d + 0.006, 0.005), (mx, d / 2, h + 0.047)))  # bungee over the top
        parts["webbing"].append(box_bm((0.005, 0.005, 0.055), (mx, d + 0.002, h + 0.018)))  # bungee down the front
    parts["polymer"].append(rbox_bm((0.026, 0.006, 0.02), (0, d + 0.004, h - 0.018), r=0.002, seg=1))  # pull tab
    for zz in (0.35, 0.62):
        parts["webbing"].append(box_bm((w + 0.004, 0.004, 0.022), (0, d + 0.001, h * zz)))
    parts["webbing"].append(box_bm((w + 0.002, d + 0.002, 0.008), (0, d / 2, h - 0.003)))  # top binding
    parts["webbing"].append(box_bm((0.006, 0.003, h * 0.8), (0, d + 0.0005, h * 0.45)))  # front seam
    return parts


def add_parts(b, parts, M, m):
    for key, lst in parts.items():
        for bm in lst:
            b.add_bm(bm, m[key], M)


def build_torso(fit, coll, m, bp):
    objs = []
    # Plate bags. Front: top below the sternal notch, bottom at the navel line; back a little taller.
    front = Plate(fit, +1, 0.352, 0.39, 1.296)
    back = Plate(fit, -1, 0.362, 0.405, 1.29)
    T = 0.034
    for plate, name, cut in ((front, "Torso_FrontPlate", (0.055, 0.075)), (back, "Torso_BackPlate", (0.045, 0.06))):
        b = Builder(name)
        b.add_bm(plate.mesh(T, *cut), m["nylon"])
        objs.append(b.finish(coll, bevel=0.007, segments=1, angle=30))

    def ftop(plate):
        return plate.zc + plate.H / 2

    def fbot(plate):
        return plate.zc - plate.H / 2

    # MOLLE: lower front (behind and between the mag pouches), most of the back panel.
    b = Builder("Torso_Molle")
    molle_on_plate(b, front, m["webbing"], fbot(front) + 0.01, ftop(front) - 0.252, -0.158, 0.158, T)
    molle_on_plate(b, back, m["webbing"], fbot(back) + 0.014, ftop(back) - 0.14, -0.162, 0.162, T)
    objs.append(b.finish(coll, smooth=False))

    # Velcro admin field on the front top (the patch sits on it) and the back top.
    b = Builder("Torso_Velcro")
    for plate, w, h, dz in ((front, 0.21, 0.07, 0.04), (back, 0.275, 0.11, 0.086)):
        M = plate.frame(0, ftop(plate) - dz, T)
        b.add_bm(rbox_bm((w, 0.003, h), (0, 0.0015, 0), r=0.0012, seg=1), m["velcro"], M)
    objs.append(b.finish(coll, smooth=False))

    # SWAT patches: front, back (bigger), left sleeve.
    b = Builder("Torso_Patches")
    for plate, w, h, th, dz in ((front, 0.196, 0.064, 0.048, 0.04), (back, 0.252, 0.094, 0.07, 0.086)):
        M = plate.frame(0, ftop(plate) - dz, T + 0.003)
        b.add_bm(rbox_bm((w, 0.003, h), (0, 0.0015, 0), r=0.002, seg=1), m["patch"], M)
        b.add_bm(text_bm("SWAT", th, 0.0), m["text"], M @ Matrix.Translation((0, 0.0036, -0.001)))
    ua, ub = bp["upperarm.L"]
    axis = (ub - ua).normalized()
    c = ua + (ub - ua) * 0.47  # on the uniform's shoulder-pocket velcro, like the reference
    out_dir = Vector((-1, 0.1, 0.1))
    out_dir = (out_dir - axis * out_dir.dot(axis)).normalized()
    hit = fit.outer(c, out_dir) or c + out_dir * 0.06
    objs.append(b.finish(coll, smooth=False))
    b = Builder("Torso_SleevePatch")  # weight entirely to upperarm.L
    M = frame(hit + out_dir * 0.002, out_dir, up=-axis)
    M = M @ Matrix.Translation((0, 0.003, 0))
    b.add_bm(rbox_bm((0.11, 0.0035, 0.072), (0, 0.00175, 0), r=0.003, seg=1), m["patch"], M)
    b.add_bm(text_bm("SWAT", 0.032, 0.0), m["text"], M @ Matrix.Translation((0, 0.0042, -0.0005)))
    ob = b.finish(coll, smooth=False)
    ob["bone"] = "upperarm.L"
    objs.append(ob)

    # Mag pouches: three 5.56 pouches on the lower front.
    b = Builder("Torso_MagPouches")
    z0 = ftop(front) - 0.072 - 0.05 - 0.125  # patch, the mag tops, then the pouches (top to bottom, as on the sheet)
    for x in (-0.096, 0.0, 0.096):
        M = front.frame(x, z0, T + 0.008)
        add_parts(b, mag_pouch_bm(0.09, 0.056, 0.125), M, m)
    objs.append(b.finish(coll, smooth=True))

    # Radio pouch with radio and antenna, upper front on the wearer's left (-X), under the shoulder strap.
    b = Builder("Torso_Radio")
    xr, zr = -0.136, ftop(front) - 0.1
    M = front.frame(xr, zr, T + 0.003)
    add_parts(b, pouch_bm(0.062, 0.038, 0.105, flap=False, bungee=True, tab=False), M, m)
    b.add_bm(rbox_bm((0.052, 0.03, 0.05), (0, 0.022, 0.125), r=0.004, seg=2), m["polymer"], M)  # radio top
    b.add_bm(cyl_bm(0.008, 0.008, 0.016, 10, (0.013, 0.022, 0.158)), m["polymer"], M)  # channel knob
    b.add_bm(cyl_bm(0.0055, 0.0035, 0.012, 8, (-0.012, 0.022, 0.156)), m["metal"], M)  # antenna base
    ant = cyl_bm(0.0042, 0.0022, 0.175, 8, (0, 0, 0.0875))
    rot = Matrix.Rotation(math.radians(-6), 4, "Y") @ Matrix.Rotation(math.radians(-5), 4, "X")
    b.add_bm(ant, m["rubber"], M @ Matrix.Translation((-0.012, 0.022, 0.162)) @ rot)
    b.add_bm(rbox_bm((0.014, 0.012, 0.03), (0.034, 0.022, 0.11), r=0.003, seg=1), m["polymer"], M)  # PTT
    objs.append(b.finish(coll, smooth=True))

    # Cummerbund: wraps from under the front plate's sides around to the back plate.
    b = Builder("Torso_Cummerbund")
    bw = Builder("Torso_CummerbundMolle")
    zlo, zhi = 1.09, 1.255
    zs = np.linspace(zlo, zhi, 4)
    for s in (1, -1):
        cols_p, cols_n = [], []
        th_f = math.atan2(0.09, front.W / 2 - 0.04)
        th_b = -math.atan2(0.08, back.W / 2 - 0.04)
        thetas = np.linspace(th_f, th_b, 9)
        for th in thetas:
            row_p, row_n = [], []
            for z in zs:
                cy = fit.axis_y(z)
                ang = th if s > 0 else math.pi - th
                p, d = fit.radial(Vector((0, cy, z)), ang, 0.16)
                row_p.append(p + d * 0.005)
                row_n.append(d)
            cols_p.append(row_p)
            cols_n.append(row_n)
        b.add_bm(shell_bm(cols_p, cols_n, 0.017), m["nylon"])
        # MOLLE rows on the cummerbund.
        for zc in (1.13, 1.17, 1.21):
            seg_th = np.linspace(th_f - 0.25, th_b + 0.25, 7)
            for k in range(len(seg_th) - 1):
                ta, tb = seg_th[k], seg_th[k + 1] - 0.03
                pa, da = fit.radial(Vector((0, fit.axis_y(zc), zc)), ta if s > 0 else math.pi - ta, 0.16)
                pb, db = fit.radial(Vector((0, fit.axis_y(zc), zc)), tb if s > 0 else math.pi - tb, 0.16)
                d = (da + db).normalized()
                c = (pa + pb) / 2 + d * 0.0225
                bw.add_bm(box_bm(((pb - pa).length, 0.003, 0.025), (0, 0.0015, 0)), m["webbing"], frame(c, d))
    objs.append(b.finish(coll, bevel=0.004, segments=1, angle=40))
    objs.append(bw.finish(coll, smooth=False))

    # Side pouches on the cummerbund.
    b = Builder("Torso_SidePouches")
    for ang in (math.radians(-22), math.radians(202)):
        z = 1.14
        cy = fit.axis_y(z + 0.055)
        p, d = fit.radial(Vector((0, cy, z + 0.055)), ang, 0.16)
        M = frame(p + d * 0.022 - Vector((0, 0, 0.055)), d)
        add_parts(b, pouch_bm(0.08, 0.04, 0.11, flap=True, bungee=False), M, m)
    objs.append(b.finish(coll, smooth=True))

    # Padded shoulder straps from the front plate top over the trapezius to the back plate top.
    b = Builder("Torso_ShoulderStraps")
    for s in (1, -1):
        xs = [s * (0.112 + dx) for dx in (-0.041, 0.0, 0.041)]
        cols_p, cols_n = [], []
        for phi in np.linspace(math.radians(8), math.radians(172), 13):
            d = Vector((0, math.cos(phi), math.sin(phi)))
            row_p, row_n = [], []
            for x in xs:
                c = Vector((x, fit.axis_y(1.37), 1.37))
                p = fit.outer(c, d, gap=0.018, maxd=0.3) or c + d * 0.13
                row_p.append(p + d * 0.004)
                row_n.append(d)
            cols_p.append(row_p)
            cols_n.append(row_n)
        b.add_bm(shell_bm(cols_p, cols_n, 0.042), m["nylon"])
    objs.append(b.finish(coll, bevel=0.009, segments=1, angle=30))

    # Drag handle at the top of the back panel.
    b = Builder("Torso_DragHandle")
    M = back.frame(0, ftop(back) - 0.02, T)
    pts, nrm = [], []
    for k in range(9):
        a = math.pi * k / 8
        x = -0.045 * math.cos(a)
        y = 0.024 * math.sin(a)
        nl = (M.to_3x3() @ Vector((-math.cos(a) * 0.5, max(math.sin(a), 0.4), 0))).normalized()
        pts.append([M @ Vector((x, y, zz)) for zz in (-0.012, 0.012)])
        nrm.append([nl, nl])
    b.add_bm(shell_bm(pts, nrm, 0.004), m["webbing"])
    objs.append(b.finish(coll, smooth=True))
    return objs, front, back


def build_belt(fit, coll, m, bp):
    objs = []
    zlo, zhi = 0.962, 1.024
    zm = (zlo + zhi) / 2
    n = 40
    thetas = [2 * math.pi * k / n for k in range(n)]
    ring_p, ring_n = [], []
    for th in thetas:
        row_p, row_n = [], []
        for z in (zlo, zhi):
            cy = fit.axis_y(z)
            p, d = fit.radial(Vector((0, cy, z)), th, 0.15)
            row_p.append(p + d * 0.004)
            row_n.append(d)
        ring_p.append(row_p)
        ring_n.append(row_n)
    b = Builder("Torso_Belt")
    b.add_bm(shell_bm(ring_p, ring_n, 0.017, close_u=True), m["nylon"])
    objs.append(b.finish(coll, bevel=0.004, segments=1, angle=40))

    def on_belt(theta, z=zm, out=0.021):
        cy = fit.axis_y(z)
        p, d = fit.radial(Vector((0, cy, z)), theta, 0.15)
        return frame(p + d * out, d)

    # Buckle (cobra-style) at the front, keepers around.
    b = Builder("Torso_BeltHardware")
    M = on_belt(math.pi / 2)
    b.add_bm(rbox_bm((0.086, 0.012, 0.05), (0, 0.006, 0), r=0.004, seg=2), m["polymer"], M)  # buckle body
    b.add_bm(rbox_bm((0.04, 0.006, 0.03), (0, 0.014, 0), r=0.002, seg=1), m["metal"], M)  # centre release
    for side in (-1, 1):
        b.add_bm(rbox_bm((0.01, 0.009, 0.046), (side * 0.036, 0.013, 0), r=0.002, seg=1), m["polymer"], M)
    for deg in (40, 140, 215, 250, 290, 325):
        M = on_belt(math.radians(deg), out=0.0205)
        b.add_bm(rbox_bm((0.016, 0.005, 0.066), (0, 0.0025, 0), r=0.0015, seg=1), m["webbing"], M)
    objs.append(b.finish(coll, smooth=True))

    # Belt pouches: two pistol-mag pouches front left, a utility pouch on the left hip, medic pouch at the back.
    b = Builder("Torso_BeltPouches")
    for deg in (116, 129):
        M = on_belt(math.radians(deg), out=0.021) @ Matrix.Translation((0, 0, -0.05))
        add_parts(b, pouch_bm(0.036, 0.03, 0.092, flap=True, bungee=False, tab=True), M, m)
    M = on_belt(math.radians(196), out=0.021) @ Matrix.Translation((0, 0, -0.07))
    add_parts(b, pouch_bm(0.08, 0.045, 0.1, flap=True, bungee=False, tab=True), M, m)
    la, lb = bp["thigh.L"]

    def lthigh(z, ang):
        t = (z - la.z) / (lb.z - la.z)
        c = la + (lb - la) * t
        d = Vector((math.cos(ang), math.sin(ang), 0))
        p = fit.outer(c, d, gap=0.03, maxd=0.25)
        return (p if p is not None else c + d * 0.085), d

    p, d = lthigh(0.84, math.radians(165))
    M = frame(p + d * 0.006, d) @ Matrix.Translation((0, 0, -0.075))
    add_parts(b, pouch_bm(0.125, 0.06, 0.15, flap=True, bungee=True, tab=True), M, m)
    pp, nn = [], []
    for k in range(20):
        a = 2 * math.pi * k / 20
        rp, rn = [], []
        for z in (0.78, 0.812):
            q, dd = lthigh(z, a)
            rp.append(q + dd * 0.003)
            rn.append(dd)
        pp.append(rp)
        nn.append(rn)
    b.add_bm(shell_bm(pp, nn, 0.004, close_u=True), m["webbing"])
    for z0, z1 in ((0.95, 0.99),):
        q, dd = lthigh(0.97, math.radians(165))
        b.add_bm(rbox_bm((0.03, 0.006, 0.09), (0, 0.003, -0.02), r=0.002, seg=1), m["webbing"], frame(q + dd * 0.004, dd))  # hanger strap
    for deg in (236, 304):
        M = on_belt(math.radians(deg), out=0.021) @ Matrix.Translation((0, 0, -0.07))
        add_parts(b, pouch_bm(0.085, 0.048, 0.11, flap=True, bungee=False, tab=True), M, m)
    M = on_belt(math.radians(58), out=0.021) @ Matrix.Translation((0, 0, -0.045))
    add_parts(b, pouch_bm(0.04, 0.034, 0.085, flap=True, bungee=False, tab=False), M, m)
    objs.append(b.finish(coll, smooth=True))

    b = Builder("Torso_MedicPouch")
    M = on_belt(math.radians(270), out=0.021) @ Matrix.Translation((0, 0, -0.08))
    b.add_bm(rbox_bm((0.165, 0.062, 0.112), (0, 0.031, 0.056), r=0.014, seg=3), m["nylon"], M)
    b.add_bm(rbox_bm((0.168, 0.004, 0.006), (0, 0.062, 0.093), r=0.0015, seg=1), m["webbing"], M)  # zip seam
    for sz in ((0.046, 0.016), (0.016, 0.046)):
        b.add_bm(rbox_bm((sz[0], 0.003, sz[1]), (0, 0.0635, 0.05), r=0.0012, seg=1), m["cross"], M)
    b.add_bm(rbox_bm((0.1, 0.006, 0.032), (0, 0.0, 0.112), r=0.002, seg=1), m["webbing"], M)  # belt loop
    objs.append(b.finish(coll, smooth=True))

    # Right drop holster: leg platform on the outside of the right thigh, holster, hood, grip, thigh strap.
    ta, tb = bp["thigh.R"]
    axis = (tb - ta).normalized()

    def thigh_at(z):
        t = (z - ta.z) / (tb.z - ta.z)
        return ta + (tb - ta) * t

    def thigh_surf(z, ang):
        c = thigh_at(z)
        d = Vector((math.cos(ang), math.sin(ang), 0))
        p = fit.outer(c, d, gap=0.03, maxd=0.25)
        return (p if p is not None else c + d * 0.085), d

    b = Builder("Torso_Holster")
    zs = np.linspace(0.80, 0.985, 7)
    angs = np.linspace(math.radians(-17), math.radians(17), 4)
    pp, nn = [], []
    for z in zs:
        rp, rn = [], []
        for a in angs:
            p, d = thigh_surf(z, a)
            rp.append(p + d * 0.004)
            rn.append(d)
        pp.append(rp)
        nn.append(rn)
    b.add_bm(shell_bm(pp, nn, 0.008), m["polymer"])
    pc, dc = thigh_surf(0.875, 0.0)
    M = frame(pc + dc * 0.012, dc)  # X' points to the front here (Y' = +X outward, Z' up)
    # Holster shell: pistol hangs barrel-down, slightly canted; grip up and to the rear (-X').
    cant = Matrix.Rotation(math.radians(8), 4, "Y")
    H = M @ cant
    # Side profile in (x' = forward, z' = up); muzzle down. Extruded through the holster's thickness.
    prof = [(-0.04, 0.075), (0.036, 0.075), (0.04, 0.05), (0.052, 0.038), (0.05, -0.004), (0.026, -0.018),
            (0.022, -0.14), (0.01, -0.155), (-0.022, -0.155), (-0.032, -0.14), (-0.042, 0.04)]
    b.add_bm(prism_bm(prof, 0.0, 0.056, r=0.009), m["polymer"], H)
    b.add_bm(rbox_bm((0.05, 0.008, 0.1), (0.0, 0.059, -0.06), r=0.003, seg=1), m["polymer"], H)  # outer rib
    for (sx, sz) in ((0.03, 0.02), (-0.026, -0.03), (0.012, -0.12)):
        b.add_bm(cyl_bm(0.0055, 0.0055, 0.006, 8), m["metal"], H @ Matrix.Translation((sx, 0.059, sz)) @ Matrix.Rotation(math.pi / 2, 4, "X"))
    # Retention hood: an arch from the front of the holster over the rear of the slide.
    # Pistol slide rear standing out of the holster mouth, the hood rotated down over it.
    b.add_bm(rbox_bm((0.074, 0.026, 0.026), (-0.0, 0.024, 0.088), r=0.003, seg=1), m["metal"], H)
    hood = Matrix.Translation((0.004, 0.024, 0.098))
    b.add_bm(rbox_bm((0.05, 0.06, 0.016), (0.0, 0.0, 0.012), r=0.005, seg=1), m["polymer"], H @ hood)  # top bar
    for sy in (-0.026, 0.026):
        b.add_bm(rbox_bm((0.05, 0.008, 0.05), (0.0, sy, -0.008), r=0.003, seg=1), m["polymer"], H @ hood)  # arms
    b.add_bm(cyl_bm(0.007, 0.007, 0.066, 8), m["metal"], H @ Matrix.Translation((0.03, 0.024, 0.07)) @ Matrix.Rotation(math.pi / 2, 4, "X"))  # pivot
    # Grip: angled back out of the holster's rear, with a beavertail and the frame's tang.
    G = H @ Matrix.Translation((-0.03, 0.024, 0.078)) @ Matrix.Rotation(math.radians(-20), 4, "Y")
    b.add_bm(rbox_bm((0.032, 0.028, 0.095), (-0.006, 0, 0.0475), r=0.007, seg=1), m["polymer"], G)
    b.add_bm(rbox_bm((0.02, 0.022, 0.01), (-0.024, 0, 0.012), r=0.003, seg=1), m["polymer"], G)
    objs.append(b.finish(coll, smooth=True))

    # Thigh strap with buckle, and the drop strap from the belt.
    b = Builder("Torso_ThighStrap")
    for zc, h in ((0.735, 0.034), (0.84, 0.03)):
        pp, nn = [], []
        for k in range(20):
            a = 2 * math.pi * k / 20
            rp, rn = [], []
            for z in (zc - h / 2, zc + h / 2):
                p, d = thigh_surf(z, a)
                rp.append(p + d * 0.003)
                rn.append(d)
            pp.append(rp)
            nn.append(rn)
        b.add_bm(shell_bm(pp, nn, 0.004, close_u=True), m["webbing"])
        p, d = thigh_surf(zc, math.radians(55))
        b.add_bm(rbox_bm((0.04, 0.01, 0.034), (0, 0.005, 0), r=0.003, seg=1), m["polymer"], frame(p + d * 0.006, d))
    objs.append(b.finish(coll, smooth=True))
    return objs


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
        "34_hold": ((-2.3, 2.4, 1.3), (0, 0, 1.05), 50, (700, 1000)),
        "left_hold": ((-3.3, 0, 1.25), (0, 0, 1.05), 50, (700, 1000)),
    }
    for name, (loc, tgt, lens, res) in views.items():
        if skin:
            skin.hide_render = name == "holster_side"  # the A-pose hand hangs in front of the holster
        shoot(cam, out_dir / f"torso_{name}.png", loc, tgt, lens, res)
        log(f"rendered {name}")
    if skin:
        skin.hide_render = False
    saved = pose_hold()
    if saved:
        for name, (loc, tgt, lens, res) in hold_views.items():
            shoot(cam, out_dir / f"torso_{name}.png", loc, tgt, lens, res)
            log(f"rendered {name}")
        # Back to the A-pose and unparented, exactly where the gear was built.
        for o, mw in saved.items():
            o.parent = None
            o.matrix_world = mw
        bpy.context.view_layer.update()


def pose_hold():
    """The rifle-hold idle pose from build_zombies.py (IK to the grip, torso aim), applied to the body's armature;
    the carrier gear follows the chest bone, the belt gear stays on the hips. Preview only."""
    arm = bpy.data.objects.get("Survivor")
    if not arm or arm.type != "ARMATURE":
        return None
    g = bz.GRIP * S
    saved = {o: o.matrix_world.copy() for o in bpy.data.collections["Torso"].objects}
    for o in bpy.data.collections["Torso"].objects:
        belt = any(k in o.name for k in ("Belt", "Medic", "Holster", "Thigh"))
        bone = "upperarm.L" if o.get("bone") == "upperarm.L" else (None if belt else "chest")
        if not bone:
            continue
        mw = o.matrix_world.copy()
        o.parent = arm
        o.parent_type = "BONE"
        o.parent_bone = bone
        o.matrix_world = mw
    hold = bz.solve_hold(arm, bz.TORSO_AIM, right_wrist=g + Vector((0.025, -0.065, 0.045)), right_aim=g + Vector((-0.03, 0.02, -0.08)),
                         left_wrist=g + Vector((-0.07, 0.2, 0.0)), left_aim=g + Vector((-0.01, 0.27, 0.06)))
    pose = dict(bz.TORSO_AIM)
    pose.update(hold)
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
        pb.rotation_euler = tuple(math.radians(a) for a in pose.get(pb.name, (0, 0, 0)))
    bpy.context.view_layer.update()
    return saved


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
