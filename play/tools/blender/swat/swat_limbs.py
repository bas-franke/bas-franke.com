"""
SWAT operator, part 4 of the pipeline: tactical gloves, hard knee pads and high tactical boots.

    blender --background --factory-startup --python swat_limbs.py -- [out.blend] [--preview <dir>]

Writes out/swat_limbs.blend with one collection `Limbs`: per side a glove, a knee pad and a boot in their final
world-space position on the A-posed body from out/swat_body.blend (or a 1.83 m stand-in while that file does not
exist), transforms applied, materials prefixed `Limbs_`. Reference: images/5.webp (glove, kneepad and boot crops).

- Gloves: the rig has no finger bones, so each glove is a relaxed GRIPPING hand modelled in the hand's frame: the
  fingers wrap a 35 mm cylinder across the palm (pistol grip / handguard), the thumb opposed down its other side, with
  a cuff, a Velcro wrist strap and knuckle armour. Its A-pose world position and axis are stored on the glove as
  `grip_center` / `grip_axis` / `grip_radius` for the animation.
- Boots are a lofted last (flat-bottomed sections that stand full-width on the sole) fused with a shaft fitted to the
  measured ankle and calf, split into rubber toe cap / mudguard, leather vamp / heel counter and nylon shaft panels,
  on a two-tier sole (lugged outsole, stepped midsole) with a heel break; flat laces, tongue, padded collar, pull loop.
- Knee pads: a domed, wrapped polymer shell with a rubber rim on a fabric sleeve; two straps fitted to the trouser
  leg at their own height, with side buckles.
Every game object is low poly (about 4k triangles for the whole part). Its detail (finger pads, knuckle caps, panels,
stitching, round laces, eyelets and speed hooks, tread lugs, ridge and rivets) lives in a dense copy `<name>_high`
(custom properties high = True, high_of = <name>; never rendered or exported) that build_swat.bake_high() projects
into the normal map.
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
PREVIEW = None
if "--preview" in ARGS:
    i = ARGS.index("--preview")
    PREVIEW = ARGS[i + 1]
    ARGS = ARGS[:i] + ARGS[i + 2:]
OUT = ARGS[0] if ARGS else os.path.join(HERE, "out", "swat_limbs.blend")
BODY = os.path.join(HERE, "out", "swat_body.blend")

# Export budgets (triangles) for the decimated game shells; the whole part (2 gloves, 2 knee pads, 2 boots) stays
# under ~4k. The detail lives in the `_high` bake sources.
GLOVE_SHELL_TRIS = 470
BOOT_SHELL_TRIS = 400


# ---- scene and materials ------------------------------------------------------------------------------------------

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


_mats = {}


def material(name, color, rough, metal=0.0, coat=0.0, bump=0.0, bump_scale=900.0):
    """Principled material; `bump` adds a fine noise bump (fabric weave / leather grain) at `bump_scale` per metre.
    The finish worker bakes the real maps; this is enough for the comparison renders."""
    name = "Limbs_" + name
    if name in _mats:
        return _mats[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (*color, 1.0)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    if coat:
        p.inputs["Coat Weight"].default_value = coat
        p.inputs["Coat Roughness"].default_value = 0.35
    if bump:
        tc = nt.nodes.new("ShaderNodeTexCoord")
        noise = nt.nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = bump_scale
        noise.inputs["Detail"].default_value = 4.0
        b = nt.nodes.new("ShaderNodeBump")
        b.inputs["Strength"].default_value = bump
        b.inputs["Distance"].default_value = 0.0004
        nt.links.new(tc.outputs["Object"], noise.inputs["Vector"])
        nt.links.new(noise.outputs["Fac"], b.inputs["Height"])
        nt.links.new(b.outputs["Normal"], p.inputs["Normal"])
    _mats[name] = m
    return m


def mats():
    # Base colours sampled from the sheet's crops: mid-dark matte greys with visible grain, not pure black.
    return {
        "glove": material("GloveFabric", (0.032, 0.032, 0.035), 0.78, bump=0.55, bump_scale=1500),
        "armor": material("GloveArmor", (0.022, 0.022, 0.024), 0.55, coat=0.08, bump=0.35, bump_scale=700),
        "panel": material("GlovePanel", (0.026, 0.026, 0.028), 0.68, bump=0.8, bump_scale=1100),
        "palm": material("GlovePalm", (0.036, 0.035, 0.034), 0.88, bump=0.6, bump_scale=800),
        "velcro": material("Velcro", (0.026, 0.026, 0.029), 0.95, bump=0.7, bump_scale=2500),
        "shell": material("KneeShell", (0.030, 0.030, 0.032), 0.58, coat=0.06, bump=0.55, bump_scale=420),
        "rubber": material("Rubber", (0.020, 0.020, 0.021), 0.72, bump=0.3, bump_scale=800),
        "strap": material("Webbing", (0.026, 0.027, 0.030), 0.85, bump=0.6, bump_scale=1800),
        "buckle": material("Buckle", (0.022, 0.022, 0.023), 0.5),
        "leather": material("BootLeather", (0.026, 0.026, 0.027), 0.6, coat=0.04, bump=0.6, bump_scale=650),
        "nylon": material("BootNylon", (0.040, 0.041, 0.045), 0.86, bump=0.6, bump_scale=1600),
        "sole": material("BootSole", (0.020, 0.020, 0.020), 0.88, bump=0.4, bump_scale=300),
        "lace": material("Lace", (0.011, 0.011, 0.012), 0.8),
        "metal": material("Eyelet", (0.20, 0.20, 0.21), 0.34, metal=1.0),
        "padding": material("Padding", (0.030, 0.031, 0.035), 0.88, bump=0.5, bump_scale=1300),
    }


# ---- mesh helpers -------------------------------------------------------------------------------------------------

def frame(z_axis, y_hint=Vector((0, 1, 0))):
    """Rotation matrix whose local Z is `z_axis` (local Y as close to `y_hint` as possible)."""
    z = z_axis.normalized()
    y = y_hint - z * y_hint.dot(z)
    if y.length < 1e-6:
        y = Vector((1, 0, 0)) - z * z.x
    y.normalize()
    x = y.cross(z)
    return Matrix((x, y, z)).transposed().to_4x4()


def basis(x, y, z):
    return Matrix((x, y, z)).transposed().to_4x4()


def ellipsoid(bm, center, radii, rot=Matrix.Identity(4), segs=(16, 10)):
    m = Matrix.Translation(center) @ rot @ Matrix.Diagonal((*radii, 1.0))
    bmesh.ops.create_uvsphere(bm, u_segments=segs[0], v_segments=segs[1], radius=1.0, matrix=m)


def tube(bm, p0, p1, r0, r1, segs=12, cap=True, scale_x=1.0):
    """Cone/cylinder from p0 to p1 (radius r0 at p0, r1 at p1)."""
    d = p1 - p0
    m = Matrix.Translation((p0 + p1) / 2) @ frame(d) @ Matrix.Diagonal((scale_x, 1, 1, 1))
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=segs, radius1=r0, radius2=r1, depth=d.length, matrix=m)


def sweep_loop(bm, ring, r, sides=6, up=Vector((0, 0, 1)), closed=True):
    """A continuous tube of radius r through the points of `ring` (closed loop, or an open polyline)."""
    n = len(ring)
    loops = []
    for k in range(n):
        if closed:
            t = (ring[(k + 1) % n] - ring[k - 1]).normalized()
        else:
            t = (ring[min(k + 1, n - 1)] - ring[max(k - 1, 0)]).normalized()
        u = t.cross(up)
        if u.length < 1e-6:
            u = t.cross(Vector((1, 0, 0)))
        u.normalize()
        w = u.cross(t)
        loops.append([bm.verts.new(ring[k] + (u * math.cos(2 * math.pi * j / sides) + w * math.sin(2 * math.pi * j / sides)) * r) for j in range(sides)])
    for k in range(n if closed else n - 1):
        a, b = loops[k], loops[(k + 1) % n]
        for j in range(sides):
            jj = (j + 1) % sides
            bm.faces.new((a[j], a[jj], b[jj], b[j]))


def box(bm, center, rot, size):
    bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(center) @ rot @ Matrix.Diagonal((*size, 1.0)))


def mesh_from_bm(name, bm, mat_index=0):
    me = bpy.data.meshes.new(name)
    for f in bm.faces:
        f.material_index = mat_index
        f.smooth = True
    bm.to_mesh(me)
    bm.free()
    return me


def new_object(name, me, coll):
    o = bpy.data.objects.new(name, me)
    coll.objects.link(o)
    return o


def bake_modifiers(o):
    """Applies every modifier by replacing the mesh with its evaluated copy (no operator context needed)."""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    o.modifiers.clear()
    old = o.data
    o.data = me
    bpy.data.meshes.remove(old)


def modified(me, coll, mods):
    """Runs a mesh through a list of (type, {settings}) modifiers and returns the resulting mesh."""
    o = new_object("tmp", me, coll)
    for kind, settings in mods:
        m = o.modifiers.new(kind.lower(), kind)
        for k, v in settings.items():
            setattr(m, k, v)
    bake_modifiers(o)
    out = o.data
    bpy.data.objects.remove(o)
    return out


def tri_count(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


def remesh_smooth(o, voxel, smooth_iters=6, smooth_factor=0.6):
    r = o.modifiers.new("remesh", "REMESH")
    r.mode = "VOXEL"
    r.voxel_size = voxel
    r.use_smooth_shade = True
    s = o.modifiers.new("smooth", "SMOOTH")
    s.factor = smooth_factor
    s.iterations = smooth_iters
    bake_modifiers(o)


def decimated(me, target, coll):
    """A decimated copy of a mesh (the original is kept)."""
    copy = me.copy()
    t = tri_count(copy)
    if t > target:
        copy = modified(copy, coll, [("DECIMATE", {"ratio": target / t, "use_collapse_triangulate": True})])
    for p in copy.polygons:
        p.use_smooth = True
    return copy


def assemble(name, parts, materials, coll):
    """One object from (mesh, slot) pairs; slot None keeps the mesh's own material indices. Meshes are consumed."""
    bm = bmesh.new()
    for me, slot in parts:
        if slot is not None:
            for p in me.polygons:
                p.material_index = slot
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    for f in bm.faces:
        f.smooth = True
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in materials:
        me.materials.append(m)
    return new_object(name, me, coll)


def ray(tree, origin, direction, dist=1.0):
    hit, normal, _, _ = tree.ray_cast(origin, direction.normalized(), dist)
    return hit, normal


# ---- gloves -------------------------------------------------------------------------------------------------------
# Modelled in a local frame (wrist at the origin, fingers +Y, back of the hand +Z, palm -Z, thumb on -X), then placed
# on the body's wrist along the hand bone, mirrored so the thumb is on the same side as the body's thumb, and scaled to
# the body's hand length. The glove replaces the hand: the finish stage hides the Body_Skin faces weighted to it.
# The rig has no finger bones, so the glove is a relaxed GRIPPING hand: the fingers wrap a ~35 mm cylinder (pistol grip
# or handguard) lying across the palm along local X, the thumb runs down its other side. Both gloves share the shape.

FINGERS = [  # base x, segment lengths, base radius, sideways drift (degrees)
    (-0.0352, (0.049, 0.030, 0.024), 0.0122, -2.0),
    (-0.0118, (0.053, 0.033, 0.025), 0.0127, -0.5),
    (0.0118, (0.050, 0.031, 0.024), 0.0122, 1.0),
    (0.0346, (0.039, 0.024, 0.021), 0.0110, 2.5),
]
KNUCKLE_Y = 0.099
GLOVE_LENGTH = KNUCKLE_Y + 0.053 + 0.033 + 0.025  # wrist to the middle fingertip, straightened (sets the scale)
GRIP_R = 0.0175  # radius of the gripped cylinder
GRIP_C = Vector((0.0, KNUCKLE_Y + 0.003, -0.039))  # its axis at x = 0 ...
GRIP_TILT = Vector((1.0, -0.10, 0.06))  # ... and direction: a little diagonal, closer to the palm on the pinky side
THUMB = [Vector((-0.035, 0.030, -0.012)), Vector((-0.048, 0.053, -0.044)), Vector((-0.049, 0.080, -0.066)), Vector((-0.038, 0.104, -0.075))]
THUMB_R = (0.0136, 0.0124, 0.0112)


def hand_frame(side, hand):
    """Wrist, hand axis (towards the fingertips), back-of-hand normal (outwards) and the lateral axis."""
    w, tip = hand
    a = (tip - w).normalized()
    # As in the sheet's A-pose the back of the hand turns ~40 degrees forward (+Y), so it reads from the front.
    out = Vector((side, 0.85, 0))
    b = (out - a * out.dot(a)).normalized()
    return w, a, b, a.cross(b)


def hand_measure(skin, tag, w, a, b, x):
    """The body's hand: length (wrist to fingertip), the lateral side its thumb is on (+1 / -1), and the wrist's
    half-width and half-thickness (so the cuff covers it)."""
    if skin is None:
        return GLOVE_LENGTH, -1, 0.0, 0.0
    gh = skin.vertex_groups.get(f"hand.{tag}")
    gf = skin.vertex_groups.get(f"forearm.{tag}")
    pts, wrist = [], []
    for v in skin.data.vertices:
        wh = wf = 0.0
        for gg in v.groups:
            if gh and gg.group == gh.index:
                wh = gg.weight
            elif gf and gg.group == gf.index:
                wf = gg.weight
        co = skin.matrix_world @ v.co - w
        d = co.dot(a)
        if wh > 0.3:
            pts.append((d, co.dot(x)))
        if (wh > 0.1 or wf > 0.1) and -0.03 < d < 0.01 and abs(co.dot(x)) < 0.08 and abs(co.dot(b)) < 0.08:
            wrist.append((abs(co.dot(x)), abs(co.dot(b))))
    if not pts:
        return GLOVE_LENGTH, -1, 0.0, 0.0
    length = max(d for d, _ in pts)
    near = [l for d, l in pts if 0.015 < d < 0.55 * length]
    lo, hi = min(near, default=0.0), max(near, default=0.0)
    wx = max((p[0] for p in wrist), default=0.0)
    wb = max((p[1] for p in wrist), default=0.0)
    return length, (1 if hi > -lo else -1), wx, wb


def grip_axis_at(x):
    """Point on the grip axis at lateral position x (local frame)."""
    return GRIP_C + GRIP_TILT * x


def wrap_step(p, length, c, rho):
    """Next finger joint (2D, y/z): at `length` from p and `rho` from the grip axis c, curling forward and down round it
    (clockwise seen from +X); heads straight at the axis while the circle is out of reach."""
    d = c - p
    dist = d.length
    if length <= dist - rho:
        return p + d * (length / dist)
    a = (length * length - rho * rho + dist * dist) / (2 * dist)
    h = math.sqrt(max(0.0, length * length - a * a))
    m = p + d * (a / dist)
    perp = Vector((-d.y, d.x)) / dist
    for q in (m + perp * h, m - perp * h):
        if (p.x - c.x) * (q.y - c.y) - (p.y - c.y) * (q.x - c.x) < 0:
            return q
    return m + perp * h


def finger_chain(x0, lengths, r, drift):
    """Joint positions, segment directions and back-of-finger normals of a finger wrapped round the grip."""
    c3 = grip_axis_at(x0)
    c = Vector((c3.y, c3.z))
    p = Vector((KNUCKLE_Y, 0.001))
    flat = [p]
    rr = r
    for length in lengths:
        p = wrap_step(p, length, c, GRIP_R + rr * 0.97)
        flat.append(p)
        rr *= 0.9
    pts, s = [], 0.0
    for i, q in enumerate(flat):
        if i:
            s += lengths[i - 1]
        pts.append(Vector((x0 + math.radians(drift) * s, q.x, q.y)))
    dirs, norms = [], []
    for i in range(3):
        d = (pts[i + 1] - pts[i]).normalized()
        mid = (pts[i] + pts[i + 1]) / 2
        out = mid - grip_axis_at(mid.x)
        out.x = 0.0
        n = (out - d * out.dot(d)).normalized()
        dirs.append(d)
        norms.append(n)
    return pts, dirs, norms


def seg_frame(d, n):
    """Rotation taking local +Y to the segment direction d and local +Z to its back-of-finger normal n."""
    return basis(d.cross(n), d, n)


def thumb_chain():
    dirs, norms = [], []
    for i in range(3):
        d = (THUMB[i + 1] - THUMB[i]).normalized()
        out = Vector((-0.75, 0.0, -0.65))  # the thumbnail faces out and down, away from the grip
        dirs.append(d)
        norms.append((out - d * out.dot(d)).normalized())
    return THUMB, dirs, norms


CUFF_RX, CUFF_RZ = 0.037 * 1.22, 0.037  # cuff half-width / half-thickness at the wrist


def glove_shell(coll, cuff):
    """Dense, voxel-remeshed glove shell (the bake source and the parent of the game shell)."""
    bm = bmesh.new()
    # Cuff over the wrist, flaring a little towards the forearm; `cuff` (x, z) scales it to the body's wrist.
    # Long enough to run up under the shirt cuff (the sleeve stops short of the wrist).
    tube(bm, Vector((0, -0.085, 0.001)), Vector((0, 0.020, 0.0)), 0.042, 0.037, segs=20, scale_x=1.22)
    bmesh.ops.scale(bm, vec=(cuff[0], 1, cuff[1]), verts=list(bm.verts))
    # Back of the hand and palm: a flat-backed block with a thick heel, the hypothenar pad and a knuckle ridge.
    ellipsoid(bm, Vector((0, 0.060, -0.001)), (0.049, 0.052, 0.0195), segs=(20, 12))
    ellipsoid(bm, Vector((0.004, 0.034, -0.004)), (0.044, 0.036, 0.022), segs=(18, 10))
    ellipsoid(bm, Vector((0.030, 0.052, -0.012)), (0.017, 0.032, 0.014))
    tube(bm, Vector((-0.041, KNUCKLE_Y, -0.001)), Vector((0.040, KNUCKLE_Y - 0.002, -0.001)), 0.0125, 0.011, segs=10)
    # Thenar mound and the opposed thumb, running down the near side of the grip.
    ellipsoid(bm, Vector((-0.031, 0.040, -0.013)), (0.020, 0.030, 0.018))
    t_pts, t_dirs, t_norms = thumb_chain()
    for i in range(3):
        L = (t_pts[i + 1] - t_pts[i]).length
        ellipsoid(bm, (t_pts[i] + t_pts[i + 1]) / 2, (THUMB_R[i] * 1.02, L * 0.62, THUMB_R[i] * 0.95), seg_frame(t_dirs[i], t_norms[i]), segs=(14, 8))
        ellipsoid(bm, t_pts[i + 1], (THUMB_R[i] * 0.9,) * 3, segs=(10, 6))
    # Fingers: a padded barrel per segment plus a sphere in every joint, so the curled joints stay round.
    chains = []
    for x0, lengths, r, drift in FINGERS:
        pts, dirs, norms = finger_chain(x0, lengths, r, drift)
        chains.append((pts, dirs, norms, r))
        rr = r
        ellipsoid(bm, pts[0], (rr,) * 3, segs=(10, 6))
        for i in range(3):
            L = (pts[i + 1] - pts[i]).length
            ellipsoid(bm, (pts[i] + pts[i + 1]) / 2, (rr * 0.98, L * 0.6, rr * 0.95), seg_frame(dirs[i], norms[i]), segs=(14, 8))
            rr *= 0.9
            ellipsoid(bm, pts[i + 1], (rr * 1.0,) * 3, segs=(10, 6))
    o = new_object("glove_tmp", mesh_from_bm("glove_tmp", bm), coll)
    remesh_smooth(o, 0.0010, smooth_iters=5, smooth_factor=0.55)
    return o, chains, (t_pts, t_dirs, t_norms)


def conform_grid(tree, nx, ny, place, direction, offset):
    """A grid whose vertices are ray-cast onto the shell: place(u, v) gives the ray origin for u, v in [-1, 1]."""
    bm = bmesh.new()
    grid = bmesh.ops.create_grid(bm, x_segments=nx, y_segments=ny, size=1.0)
    for v in grid["verts"]:
        o = place(v.co.x, v.co.y)
        hit, n = ray(tree, o, direction, 0.3)
        if hit is None:  # off the edge of the shell: snap to the nearest surface instead of hanging in the air
            hit, n, _, _ = tree.find_nearest(o + direction * 0.12)
        v.co = hit + n * offset
    return bm


def glove_parts(tree, chains, thumb, coll, cuff):
    """What is layered on the shell, in the glove's local frame: (game parts, bake-only parts) as (mesh, slot) lists.
    The game mesh keeps only what shapes the silhouette (knuckle armour, wrist strap, tab); padded finger segments,
    knuckle caps and panels live in the bake source."""
    down = Vector((0, 0, -1))
    low, high = [], []

    def armour(nx, ny):
        # Cast from above and in front, so the plate drapes over the knuckles of the fist.
        bm = conform_grid(tree, nx, ny, lambda u, v: Vector((u * 0.039, KNUCKLE_Y + 0.004 + v * 0.011 + 0.06, 0.12)), Vector((0, -0.5, -1)).normalized(), 0.0003)
        return modified(mesh_from_bm("armor", bm), coll, [("SOLIDIFY", {"thickness": 0.0045, "offset": 1.0})])

    low.append((armour(6, 1), 1))
    high.append((armour(12, 4), 1))
    # Hard oval cap over each knuckle.
    bm = bmesh.new()
    for pts, dirs, norms, r in chains:
        n0 = (Vector((0, 0, 1)) + norms[0]).normalized()
        hit, n = ray(tree, pts[0] + n0 * 0.08, -n0, 0.12)
        if hit is not None:
            ellipsoid(bm, hit + n * 0.0050, (r * 1.0, 0.0125, 0.0072), frame(n, Vector((0, 1, 0))), segs=(12, 6))
    high.append((mesh_from_bm("caps", bm), 1))
    # Padded armour on the first two finger segments and on the thumb's middle segment.
    bm = bmesh.new()
    segs = [(pts[i], pts[i + 1], dirs[i], norms[i], r * (0.9 ** i)) for pts, dirs, norms, r in chains for i in (0, 1)]
    t_pts, t_dirs, t_norms = thumb
    segs.append((t_pts[1], t_pts[2], t_dirs[1], t_norms[1], 0.0115))
    for p0, p1, d, n0, r in segs:
        mid = (p0 + p1) / 2
        hit, n = ray(tree, mid + n0 * 0.05, -n0, 0.1)
        if hit is None:
            continue
        box(bm, hit + n * 0.0013, frame(n, d), (r * 1.25, (p1 - p0).length * 0.55, 0.0042))
    high.append((modified(mesh_from_bm("pads", bm), coll, [("BEVEL", {"width": 0.0014, "segments": 2})]), 1))
    # Textured panel on the back of the hand, and the grip panel on the palm.
    bm = conform_grid(tree, 6, 5, lambda u, v: Vector((u * 0.036, 0.052 + v * 0.026, 0.12)), down, 0.0005)
    high.append((modified(mesh_from_bm("back", bm), coll, [("SOLIDIFY", {"thickness": 0.0012, "offset": 1.0})]), 4))
    bm = conform_grid(tree, 6, 4, lambda u, v: Vector((u * 0.038, 0.045 + v * 0.022, -0.12)), Vector((0, 0, 1)), 0.0005)
    high.append((modified(mesh_from_bm("palm", bm), coll, [("SOLIDIFY", {"thickness": 0.0013, "offset": 1.0})]), 2))

    # Wrist closure: a wide Velcro strap round the cuff with a tab on the back.
    def strap(segs):
        bm = bmesh.new()
        tube(bm, Vector((0, -0.036, 0.001)), Vector((0, -0.014, 0.001)), 0.0415, 0.0405, segs=segs, cap=False, scale_x=1.22)
        bmesh.ops.scale(bm, vec=(cuff[0], 1, cuff[1]), verts=bm.verts)
        return modified(mesh_from_bm("strap", bm), coll, [("SOLIDIFY", {"thickness": 0.0022, "offset": 1.0})])

    def tab(seg):
        bm = bmesh.new()
        box(bm, Vector((0.012 * cuff[0], -0.025, 0.0365 * cuff[1])), Matrix.Rotation(0.06, 4, "Y"), (0.046, 0.024, 0.0042))
        return modified(mesh_from_bm("tab", bm), coll, [("BEVEL", {"width": 0.0015, "segments": seg})]) if seg else mesh_from_bm("tab", bm)

    low += [(strap(10), 3), (tab(0), 3)]
    high += [(strap(24), 3), (tab(2), 3)]
    return low, high


def mark_high(o, low_name):
    """A bake source: never exported or rendered; build_swat.bake_high() projects it onto `low_name`."""
    o["high"] = True
    o["high_of"] = low_name
    o.hide_render = True


def glove(side, tag, hand, skin, coll, mt):
    w, a, b, x = hand_frame(side, hand)
    length, thumb_side, wx, wb = hand_measure(skin, tag, w, a, b, x)
    scale = max(0.95, min(1.4, length / GLOVE_LENGTH * 1.19))  # a padded glove is bigger than the bare hand
    cuff = (max(1.0, (wx + 0.004) / (CUFF_RX * scale)), max(1.0, (wb + 0.004) / (CUFF_RZ * scale)))
    shell, chains, thumb = glove_shell(coll, cuff)
    tree = BVHTree.FromObject(shell, bpy.context.evaluated_depsgraph_get())
    low_parts, high_parts = glove_parts(tree, chains, thumb, coll, cuff)
    coarse = modified(shell.data.copy(), coll, [("REMESH", {"mode": "VOXEL", "voxel_size": 0.0026, "use_smooth_shade": True})])
    low_shell = decimated(coarse, GLOVE_SHELL_TRIS, coll)
    bpy.data.meshes.remove(coarse)
    slots = [mt["glove"], mt["armor"], mt["palm"], mt["velcro"], mt["panel"]]
    name = f"Limbs_Glove.{tag}"
    final = assemble(name, [(low_shell, 0)] + low_parts, slots, coll)
    high = assemble(name + "_high", [(shell.data.copy(), 0)] + high_parts, slots, coll)
    old = shell.data
    bpy.data.objects.remove(shell)
    bpy.data.meshes.remove(old)
    mark_high(high, name)
    # The model's thumb is on local -X (world -x); mirror when the body's thumb is on the other side.
    mirror = Matrix.Diagonal((-1, 1, 1, 1)) if thumb_side > 0 else Matrix.Identity(4)
    M = Matrix.Translation(w) @ basis(x, a, b) @ Matrix.Diagonal((scale, scale, scale, 1)) @ mirror
    for o in (final, high):
        o.data.transform(M)
        if thumb_side > 0:
            o.data.flip_normals()
    # Where the glove holds the gun (A-pose world space), for the animation / weapon placement.
    final["grip_center"] = list(M @ GRIP_C)
    final["grip_axis"] = list((M.to_3x3() @ GRIP_TILT).normalized())
    final["grip_radius"] = GRIP_R * scale
    print(f"  glove {tag}: hand length {length:.3f} m, scale {scale:.2f}, cuff x{cuff[0]:.2f}/{cuff[1]:.2f}, thumb on {'+' if thumb_side > 0 else '-'}x, grip {tuple(round(c, 3) for c in final['grip_center'])}")
    return final, high


# ---- knee pads ----------------------------------------------------------------------------------------------------
# Local frame: origin on the front of the knee (on the trousers), +Y out of the leg, +Z up the leg. As on the sheet: a
# padded fabric sleeve, an oval hard shell on it with a raised inner ridge, a crease across its upper third and six
# rivets, and two elastic straps round the leg with side buckles. The straps are fitted to the trouser leg measured at
# their own height (knee_matrix), so they sit snug instead of hanging off the back of the leg.

LEG_R = 0.062
KNEE_WRAP = 0.074  # radius the sleeve and shell wrap around (set per leg from the trousers)
KNEE_FIT = {"hw": LEG_R, "depth": LEG_R, "cx": 0.0, "straps": []}  # trouser half-width, front depth, strap ellipses
STRAP_Z = (0.066, -0.072)


def wrap_y(x, lift=0.0):
    return math.sqrt(KNEE_WRAP * KNEE_WRAP - x * x) - KNEE_WRAP + lift


def squircle(u, v, k):
    """Maps the square [-1, 1]^2 towards a disc; k = 0 square, 1 disc."""
    disk = Vector((u * math.sqrt(max(0.0, 1 - v * v / 2)), v * math.sqrt(max(0.0, 1 - u * u / 2))))
    return u * (1 - k) + disk.x * k, v * (1 - k) + disk.y * k


SHELL_W, SHELL_H, SHELL_Z = 0.049, 0.073, 0.002


def shell_point(px, pz):
    x = px * SHELL_W
    z = pz * SHELL_H + SHELL_Z
    y = wrap_y(x, 0.012 + 0.020 * (1 - 0.45 * px * px - 0.65 * pz * pz))
    y -= 0.0022 * math.exp(-((pz - 0.42) / 0.09) ** 2) * (1 - px * px)  # crease across the upper third
    return Vector((x, y, z))


def shell_normal(px, pz):
    p = shell_point(px, pz)
    n = (shell_point(px + 0.02, pz) - p).cross(shell_point(px, pz + 0.02) - p).normalized()
    return -n if n.y < 0 else n


def knee_pad(side, M, coll, mt):
    tag = "R" if side > 0 else "L"

    def sleeve(nx, ny):
        bm = bmesh.new()
        grid = bmesh.ops.create_grid(bm, x_segments=nx, y_segments=ny, size=1.0)
        for v in grid["verts"]:
            u, w = squircle(v.co.x, v.co.y, 0.35)
            x = u * 0.066
            v.co = Vector((x, wrap_y(x, 0.002), w * 0.097))
        return modified(mesh_from_bm("sleeve", bm), coll, [("SOLIDIFY", {"thickness": 0.011, "offset": 1.0})])

    def shell(nx, ny):
        bm = bmesh.new()
        grid = bmesh.ops.create_grid(bm, x_segments=nx, y_segments=ny, size=1.0)
        for v in grid["verts"]:
            v.co = shell_point(*squircle(v.co.x, v.co.y, 0.88))
        me = mesh_from_bm("shell", bm)
        me.materials.append(mt["shell"])
        me.materials.append(mt["rubber"])  # Solidify needs the slot to exist, or the rim offset is clamped away
        return modified(me, coll, [("SOLIDIFY", {"thickness": 0.0065, "offset": 1.0, "material_offset_rim": 1})])

    def straps(segs, thick):
        bm = bmesh.new()
        for zc, cx, cy, rx, ry in KNEE_FIT["straps"]:
            tube(bm, Vector((cx, cy, zc - 0.009)), Vector((cx, cy, zc + 0.009)), ry, ry, segs=segs, cap=False, scale_x=rx / ry)
        me = mesh_from_bm("straps", bm)
        return modified(me, coll, [("SOLIDIFY", {"thickness": 0.0022, "offset": 1.0})]) if thick else me

    def buckles(loops):
        bm = bmesh.new()
        for zc, cx, cy, rx, ry in KNEE_FIT["straps"]:
            if loops:
                for sx in (-1, 1):
                    x = sx * 0.064
                    box(bm, Vector((x, wrap_y(x, 0.009), zc)), Matrix.Rotation(-math.asin(x / KNEE_WRAP), 4, "Z"), (0.007, 0.010, 0.026))
            ang = side * math.radians(80)
            c = Vector((cx + math.sin(ang) * (rx + 0.003), cy + math.cos(ang) * (ry + 0.003), zc))
            box(bm, c, Matrix.Rotation(-ang, 4, "Z"), (0.026, 0.005, 0.022))
        return mesh_from_bm("hardware", bm)

    # Bake-only detail: the raised moulded ridge inset from the shell's edge, and six rivets.
    bm = bmesh.new()
    ring = []
    for i in range(28):
        ang = 2 * math.pi * i / 28
        px, pz = squircle(0.80 * math.cos(ang), 0.82 * math.sin(ang), 0.88)
        ring.append(shell_point(px, pz) + shell_normal(px, pz) * 0.0008)
    sweep_loop(bm, ring, 0.0017, sides=6, up=Vector((0, 1, 0)))
    ridge = mesh_from_bm("ridge", bm)
    bm = bmesh.new()
    for px, pz in ((-0.6, 0.66), (0.6, 0.66), (-0.6, -0.66), (0.6, -0.66), (-0.86, -0.05), (0.86, -0.05)):
        ellipsoid(bm, shell_point(px, pz) + shell_normal(px, pz) * 0.0008, (0.0046, 0.0046, 0.0026), frame(shell_normal(px, pz)), segs=(8, 4))
    rivets = mesh_from_bm("rivets", bm)

    slots = [mt["shell"], mt["rubber"], mt["strap"], mt["padding"], mt["buckle"]]
    name = f"Limbs_KneePad.{tag}"
    low = assemble(name, [(sleeve(4, 5), 3), (shell(4, 5), None), (straps(12, False), 2), (buckles(False), 4)], slots, coll)
    high = assemble(name + "_high", [(sleeve(8, 10), 3), (shell(12, 14), None), (ridge, 0), (rivets, 4), (straps(28, True), 2), (buckles(True), 4)], slots, coll)
    mark_high(high, name)
    for o in (low, high):
        o.data.transform(M)
    return low, high


# ---- boots --------------------------------------------------------------------------------------------------------
# Local frame: origin on the ground under the ankle, toe along +Y, up +Z; side +1 is the right foot (outside = +X).
# FIT is set per foot from the body before the boot is built. The upper is one lofted last (flat-bottomed sections that
# sit full-width on the sole) fused with a shaft that follows the measured ankle and calf, so it reads as a laced
# leather/nylon boot, not a galosh; the outsole is a slightly flared block with a heel break, glued to the upper.

WIDTH = [(0.0, 0.035), (0.08, 0.043), (0.25, 0.044), (0.5, 0.049), (0.68, 0.0605), (0.82, 0.0616), (0.92, 0.054), (0.975, 0.0355), (1.0, 0.008)]  # wide forefoot, roomy toe box
HEIGHT = [(0.0, 0.105), (0.28, 0.104), (0.42, 0.098), (0.55, 0.086), (0.7, 0.068), (0.85, 0.056), (0.95, 0.048), (1.0, 0.040)]
SOLE_TOP = 0.040
SHAFT_TOP = 0.335  # high tactical boot up the shin: the trousers end at ~0.31 m and blouse over the collar
FIT = {"heel": -0.072, "toe": 0.236, "wscale": 1.0, "rx": 0.043, "ry": 0.051, "cx": 0.0, "cy": 0.0, "shaft": []}


def interp(table, t):
    t = min(max(t, 0.0), 1.0)
    for (t0, v0), (t1, v1) in zip(table, table[1:]):
        if t <= t1:
            k = (t - t0) / (t1 - t0)
            k = k * k * (3 - 2 * k)
            return v0 + (v1 - v0) * k
    return table[-1][1]


def foot_y(t):
    return FIT["heel"] + (FIT["toe"] - FIT["heel"]) * t


def foot_w(t):
    return interp(WIDTH, t) * FIT["wscale"]


def foot_center_x(t, side):
    return FIT["cx"] - side * 0.005 * math.sin(math.pi * t)


def toe_spring(t):
    return 0.016 * max(0.0, (t - 0.76) / 0.24) ** 2


def arch(t):
    """Heel break: the outsole is lifted between the heel block and the forefoot."""
    up = min(max((t - 0.26) / 0.025, 0.0), 1.0)
    down = min(max((0.56 - t) / 0.12, 0.0), 1.0)
    return 0.013 * min(up, down)


def shaft_at(z):
    """(rx, ry, cx, cy) of the shaft at height z, from the measured table."""
    tab = FIT["shaft"]
    if not tab:
        return FIT["rx"], FIT["ry"], FIT["cx"], FIT["cy"]
    if z <= tab[0][0]:
        return tab[0][1:]
    for a, b in zip(tab, tab[1:]):
        if z <= b[0]:
            k = (z - a[0]) / (b[0] - a[0])
            return tuple(a[i] + (b[i] - a[i]) * k for i in range(1, 5))
    return tab[-1][1:]


def outline(side, n, notch=0.0, grow=0.0):
    """Closed footprint outline; with `notch` every other pair of points steps out (or in), so the sole's side shows
    lug blocks."""
    pts = []
    for i in range(n + 1):
        t = i / n
        pts.append((foot_center_x(t, side) + foot_w(t) + grow + (notch if ((i // 2) % 2 == 0 and 0 < i < n) else 0.0), foot_y(t) + grow * (2 * t - 1), t))
    for i in range(n, -1, -1):
        t = i / n
        pts.append((foot_center_x(t, side) - foot_w(t) - grow - (notch if ((i // 2) % 2 == 0 and 0 < i < n) else 0.0), foot_y(t) + grow * (2 * t - 1), t))
    return pts


def prism(bm, bottom_pts, top_pts, z0, z1, lift_bottom=False):
    """A block between two footprint outlines (a flared sole); the bottom follows the toe spring and the heel break.
    The caps get their own vertices, so the sole's edges stay crisp under smooth shading."""
    def ring(pts, z, lift):
        return [bm.verts.new((x, y, z + toe_spring(t) + (arch(t) if lift else 0.0))) for x, y, t in pts]
    bottom, top = ring(bottom_pts, z0, lift_bottom), ring(top_pts, z1, False)
    n = len(bottom)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((bottom[i], bottom[j], top[j], top[i]))
    bm.faces.new(list(reversed(ring(bottom_pts, z0, lift_bottom))))
    bm.faces.new(ring(top_pts, z1, False))


def boot_shell(side, coll):
    """Dense upper: the lofted last and the shaft, voxel-remeshed so they fillet into one leather shell."""
    bm = bmesh.new()
    rings = []
    n_t, n_a = 30, 24
    z_b = SOLE_TOP - 0.003
    for i in range(n_t + 1):
        t = i / n_t
        y = foot_y(0.015 + 0.975 * t)
        a = max(foot_w(t) * 0.985, 0.004)
        h = interp(HEIGHT, t)
        # Round the toe and the heel in profile (the ends shrink in height as well as width).
        end = max((t - 0.74) / 0.26, (0.06 - t) / 0.06, 0.0)
        h *= math.sqrt(max(0.10, 1 - end ** 2.2))
        zc = z_b + h / 2 + toe_spring(t)
        xc = foot_center_x(t, side)
        ring = []
        for k in range(n_a):
            ang = 2 * math.pi * k / n_a
            c, s = math.cos(ang), math.sin(ang)
            # Rounded over the top; nearly square below, so the upper stands full-width on the sole (no galosh tuck).
            e = 0.8 if s >= 0 else 0.3
            ring.append(bm.verts.new((xc + a * math.copysign(abs(c) ** e, c), y, zc + (h / 2) * math.copysign(abs(s) ** e, s))))
        rings.append(ring)
    for i in range(n_t):
        for k in range(n_a):
            kk = (k + 1) % n_a
            bm.faces.new((rings[i][k], rings[i][kk], rings[i + 1][kk], rings[i + 1][k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    # Shaft: elliptical sections following the measured ankle and calf, a light padded bulge round the ankle bones and
    # a small flare to the collar.
    rings = []
    n_z, n_r = 18, 24
    for i in range(n_z + 1):
        f = i / n_z
        z = 0.055 + (SHAFT_TOP - 0.055) * f
        rx, ry, cx, cy = shaft_at(z)
        pad = math.exp(-((z - 0.10) / 0.025) ** 2)
        rx *= 1.0 + 0.06 * pad + 0.04 * max(0.0, f - 0.85) / 0.15
        ry *= 1.0 + 0.03 * pad + 0.04 * max(0.0, f - 0.85) / 0.15
        ring = [bm.verts.new((cx + rx * math.cos(2 * math.pi * k / n_r), cy + ry * math.sin(2 * math.pi * k / n_r), z)) for k in range(n_r)]
        rings.append(ring)
    for i in range(n_z):
        for k in range(n_r):
            kk = (k + 1) % n_r
            bm.faces.new((rings[i][k], rings[i][kk], rings[i + 1][kk], rings[i + 1][k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = new_object("boot_tmp", mesh_from_bm("boot_tmp", bm), coll)
    remesh_smooth(o, 0.0022, smooth_iters=6, smooth_factor=0.5)
    return o


def boot_planes():
    """Panel boundaries (point, normal; the panel is on the normal's side): rubber mudguard, toe cap, heel counter,
    nylon shaft."""
    return {
        "mud": (Vector((0, 0, SOLE_TOP + 0.011)), Vector((0, 0, -1))),
        "toe": (Vector((0, FIT["toe"] - 0.072, SOLE_TOP)), Vector((0, 1, -0.55)).normalized()),
        "heel": (Vector((0, FIT["heel"] + 0.075, SOLE_TOP)), Vector((0, -1, -0.50)).normalized()),
        "shaft": (Vector((0, FIT["heel"] + 0.11, 0.118)), Vector((0, -0.35, 1)).normalized()),
    }


def boot_zone(c, planes):
    """Material slot for a face by its centre: rubber mudguard and toe cap, leather heel counter and vamp, nylon
    quarters and shaft."""
    def on(k):
        p, n = planes[k]
        return (c - p).dot(n) > 0
    if on("mud") or on("toe"):
        return 1
    if on("heel"):
        return 0
    if on("shaft"):
        return 2
    return 0 if c.y > FIT["heel"] + 0.12 else 2


def zoned(me):
    """Cuts the game shell along the panel boundaries (crisp material edges) and assigns the zones."""
    planes = boot_planes()
    bm = bmesh.new()
    bm.from_mesh(me)
    for co, no in planes.values():
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=co, plane_no=no)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    for f in bm.faces:
        f.material_index = boot_zone(f.calc_center_median(), planes)
        f.smooth = True
    bm.to_mesh(me)
    bm.free()
    return me


def face_out(bm):
    """Open strips on the boot (tongue, flat laces): every face turned away from the shaft axis / up off the instep."""
    bm.normal_update()
    for f in bm.faces:
        c = f.calc_center_median()
        rx, ry, cx, cy = shaft_at(c.z)
        out = Vector((c.x - cx, c.y - cy, 0.0 if c.z > 0.12 else 0.06))
        if f.normal.dot(out) < 0:
            f.normal_flip()


def boot(side, M, coll, mt):
    tag = "R" if side > 0 else "L"
    shell = boot_shell(side, coll)
    tree = BVHTree.FromObject(shell, bpy.context.evaluated_depsgraph_get())
    low, high = [], []
    low_shell = zoned(decimated(shell.data, BOOT_SHELL_TRIS, coll))
    high_shell = zoned(shell.data.copy())
    low.append((low_shell, None))
    high.append((high_shell, None))

    def onto(origin, target):
        d = target - origin
        hit, n = ray(tree, origin, d, d.length + 0.05)
        return hit + n * 0.0006 if hit is not None else None

    # Bake only: stitched seams along the panel edges (toe cap, heel counter, quarters) and round the shaft.
    seams = []
    t_cap = 0.78
    yc_cap = foot_y(t_cap)
    zc_cap = SOLE_TOP + interp(HEIGHT, t_cap) * 0.40
    for off in (0.0, 0.004):
        seams.append([onto(Vector((foot_center_x(t_cap, side) + 0.2 * math.sin(th), yc_cap + 0.035 - off, zc_cap + 0.2 * math.cos(th))), Vector((foot_center_x(t_cap, side), yc_cap - off, zc_cap))) for th in [math.radians(a) for a in range(-100, 101, 8)]])
    hc = Vector((FIT["cx"], FIT["heel"] + 0.055, 0.0))
    for off in (0.0, 0.004):
        seams.append([onto(hc + Vector((0.2 * math.sin(ph), -0.2 * math.cos(ph), 0.092 + off - 0.03 * (abs(ph) / math.radians(110)) ** 2)), hc + Vector((0, 0, 0.092 + off - 0.03 * (abs(ph) / math.radians(110)) ** 2))) for ph in [math.radians(a) for a in range(-110, 111, 10)]])
    for sx in (-1, 1):
        line = []
        for i in range(12):
            f = i / 11
            y = FIT["heel"] + 0.07 + f * 0.11
            z = 0.075 + f * 0.035 + 0.012 * math.sin(math.pi * f)
            line.append(onto(Vector((FIT["cx"] + sx * 0.2, y, z)), Vector((FIT["cx"], y, z))))
        seams.append(line)
    for z in (0.082, 0.178, 0.25):
        rx, ry, cx, cy = shaft_at(z)
        ring = []
        for a in range(-125, 126, 10):
            th = math.radians(a)
            ring.append(onto(Vector((cx + 0.2 * math.sin(th), cy - 0.2 * math.cos(th), z)), Vector((cx, cy, z))))
        seams.append(ring)
    bm = bmesh.new()
    for line in seams:
        line = [p for p in line if p is not None]
        if len(line) >= 3:
            sweep_loop(bm, line, 0.0011, sides=4, closed=False)
    high.append((mesh_from_bm("seams", bm), 0))

    # Outsole and midsole, one flared block glued under the upper with a heel break. The bake copy adds the tread: a
    # stepped sidewall, chevron lugs underneath and the midsole ridge.
    # Game sole: a lugged outsole block with a stepped-in midsole on it (the step reads as a real sole, not a plank).
    bm = bmesh.new()
    prism(bm, outline(side, 14, grow=0.0042), outline(side, 14, grow=0.0050), 0.0, 0.017, lift_bottom=True)
    prism(bm, outline(side, 12, grow=0.0030), outline(side, 12, grow=0.0024), 0.016, SOLE_TOP + 0.001)
    low.append((mesh_from_bm("sole", bm), 3))
    bm = bmesh.new()
    prism(bm, outline(side, 44, notch=-0.0018, grow=0.0042), outline(side, 44, notch=-0.0018, grow=0.0050), 0.0045, 0.017, lift_bottom=True)
    prism(bm, outline(side, 44, grow=0.0030), outline(side, 44, grow=0.0024), 0.016, SOLE_TOP + 0.001)
    ridge = [Vector((x, y, 0.0285 + toe_spring(t))) for x, y, t in outline(side, 44, grow=0.0030)]
    sweep_loop(bm, ridge, 0.0014, sides=4)
    for i in range(1, 16):
        t = i / 16
        if arch(t) > 0.001:
            continue
        for u in (-0.55, 0.0, 0.55):
            for sx in (-1, 1):
                ang = sx * math.radians(28)
                c = Vector((foot_center_x(t, side) + (u + sx * 0.12) * foot_w(t), foot_y(t), 0.0024 + toe_spring(t)))
                box(bm, c, Matrix.Rotation(ang, 4, "Z"), (foot_w(t) * 0.26, 0.009, 0.0048))
    high.append((mesh_from_bm("sole", bm), 3))

    # Lacing: rows on the instep (cast down) and up the shaft front (cast backwards).
    rows = []
    for t in (0.70, 0.635, 0.57):
        y = foot_y(t)
        rows.append([ray(tree, Vector((FIT["cx"] + sx * 0.019, y, 0.4)), Vector((0, 0, -1)), 0.5) for sx in (-1, 1)])
    for z in (0.128, 0.156, 0.184, 0.212, 0.240, 0.268, 0.296, 0.320):
        rx, ry, cx, cy = shaft_at(z)
        rows.append([ray(tree, Vector((cx + sx * 0.020, 0.4, z)), Vector((0, -1, 0)), 0.5) for sx in (-1, 1)])
    rows = [r for r in rows if r[0][0] is not None and r[1][0] is not None]

    def tongue(solid):
        bm = bmesh.new()
        verts = []
        for (p0, n0), (p1, n1) in rows:
            mid = (p0 + p1) / 2
            n = (n0 + n1).normalized()
            lat = (p1 - p0).normalized()
            verts.append([bm.verts.new(mid + n * 0.0012 + lat * s * 0.016) for s in (-1, 1)])
        (p0, n0), (p1, n1) = rows[-1]
        top = (p0 + p1) / 2 + (n0 + n1).normalized() * 0.0015 + Vector((0, 0.004, SHAFT_TOP + 0.016 - p0.z))
        lat = (p1 - p0).normalized()
        verts.append([bm.verts.new(top + lat * s * 0.015) for s in (-1, 1)])
        for (a0, a1), (b0, b1) in zip(verts, verts[1:]):
            bm.faces.new((a0, b0, b1, a1))
        face_out(bm)
        me = mesh_from_bm("tongue", bm)
        if solid:
            return modified(me, coll, [("SOLIDIFY", {"thickness": 0.005, "offset": 1.0}), ("BEVEL", {"width": 0.0015, "segments": 1})])
        return me

    if len(rows) >= 2:
        low.append((tongue(False), 6))
        high.append((tongue(True), 6))
    # Eyelets low on the instep, speed hooks up the shaft (bake only: at game distance they live in the normal map).
    bm = bmesh.new()
    for pair in rows:
        for hit, n in pair:
            if hit.z < 0.12:
                bmesh.ops.create_cone(bm, cap_ends=False, segments=10, radius1=0.0045, radius2=0.0040, depth=0.0024, matrix=Matrix.Translation(hit + n * 0.0010) @ frame(n))
            else:
                tip = hit + n * 0.0060
                tube(bm, hit, tip, 0.0024, 0.0022, segs=8)
                tube(bm, tip - Vector((0, 0, 0.0015)), tip + Vector((0, 0, 0.0045)) - n * 0.0015, 0.0020, 0.0018, segs=8)
    high.append((mesh_from_bm("eyelets", bm), 5))
    # Laces: flat crossing strips in the game mesh, round cord with a bow in the bake copy.
    lift = 0.0055
    bm = bmesh.new()
    for a, b in zip(rows, rows[1:]):
        for (p0, n0), (p1, n1) in ((a[0], b[1]), (a[1], b[0])):
            q0, q1 = p0 + n0 * lift, p1 + n1 * lift
            lat = (q1 - q0).cross((n0 + n1)).normalized() * 0.0024
            bm.faces.new((bm.verts.new(q0 - lat), bm.verts.new(q0 + lat), bm.verts.new(q1 + lat), bm.verts.new(q1 - lat)))
    face_out(bm)
    low.append((mesh_from_bm("laces", bm), 4))
    bm = bmesh.new()
    for a, b in zip(rows, rows[1:]):
        for (p0, n0), (p1, n1) in ((a[0], b[1]), (a[1], b[0])):
            tube(bm, p0 + n0 * lift, p1 + n1 * lift, 0.0022, 0.0022, segs=6, cap=False)
    if rows:
        (p0, n0), (p1, n1) = rows[0]
        tube(bm, p0 + n0 * lift, p1 + n1 * lift, 0.0022, 0.0022, segs=6, cap=False)
        (p0, n0), (p1, n1) = rows[-1]
        top = (p0 + p1) / 2 + n0 * 0.006
        for sx in (-1, 1):
            loop = Matrix.Translation(top + Vector((sx * 0.010, 0.002, 0.003))) @ Matrix.Rotation(math.pi / 2, 4, "X") @ Matrix.Rotation(sx * 0.5, 4, "Y") @ Matrix.Diagonal((0.011, 0.006, 0.011, 1))
            bmesh.ops.create_cone(bm, cap_ends=False, segments=10, radius1=1.0, radius2=1.0, depth=0.0025, matrix=loop)
            tube(bm, top, top + Vector((sx * 0.007, 0.008, -0.05)), 0.0021, 0.0019, segs=6, cap=False)
    high.append((mesh_from_bm("laces", bm), 4))

    # Padded collar, dipping a little at the front where the tongue comes up, and the pull loop at the back.
    rx, ry, cx, cy = shaft_at(SHAFT_TOP)
    rx, ry, yc = rx * 1.04 + 0.002, ry * 1.04 + 0.002, cy + 0.002

    def collar(n, sides, r):
        bm = bmesh.new()
        ring = [Vector((cx + rx * math.cos(2 * math.pi * k / n), yc + ry * math.sin(2 * math.pi * k / n), SHAFT_TOP - 0.002 - 0.006 * max(0.0, math.sin(2 * math.pi * k / n)))) for k in range(n)]
        sweep_loop(bm, ring, r, sides=sides)
        return mesh_from_bm("collar", bm)

    low.append((collar(12, 4, 0.0080), 6))
    high.append((collar(32, 10, 0.0080), 6))

    def pull(segs, thick):
        bm = bmesh.new()
        loop = Matrix.Translation((cx, yc - ry - 0.004, SHAFT_TOP + 0.008)) @ Matrix.Rotation(math.pi / 2, 4, "Y") @ Matrix.Diagonal((0.017, 0.009, 1.0, 1))
        bmesh.ops.create_cone(bm, cap_ends=False, segments=segs, radius1=1.0, radius2=1.0, depth=0.012, matrix=loop)
        me = mesh_from_bm("pull", bm)
        return modified(me, coll, [("SOLIDIFY", {"thickness": 0.002})]) if thick else me

    low.append((pull(6, False), 2))
    high.append((pull(16, True), 2))

    slots = [mt["leather"], mt["rubber"], mt["nylon"], mt["sole"], mt["lace"], mt["metal"], mt["padding"]]
    name = f"Limbs_Boot.{tag}"
    final = assemble(name, low, slots, coll)
    hi = assemble(name + "_high", high, slots, coll)
    old = shell.data
    bpy.data.objects.remove(shell)
    bpy.data.meshes.remove(old)
    mark_high(hi, name)
    for o in (final, hi):
        o.data.transform(M)
    # Where the trousers meet the boot (world space, the boot faces +Y): build_swat drapes Body_Trousers vertices
    # around the shaft outside the ellipse (tuck_cx, tuck_cy, tuck_rx, tuck_ry) below tuck_top.
    rx, ry, cx, cy = shaft_at(SHAFT_TOP)
    c = M @ Vector((cx, cy + 0.004, SHAFT_TOP))
    final["tuck_top"] = c.z
    final["tuck_cx"], final["tuck_cy"] = c.x, c.y
    final["tuck_rx"], final["tuck_ry"] = rx - 0.004, ry - 0.004
    return final, hi


# ---- fitting ------------------------------------------------------------------------------------------------------

def load_body():
    """Appends everything from out/swat_body.blend into a `BodyRef` collection."""
    if not os.path.exists(BODY):
        return None, [], None
    with bpy.data.libraries.load(BODY, link=False) as (src, dst):
        dst.objects = list(src.objects)
    coll = bpy.data.collections.new("BodyRef")
    bpy.context.scene.collection.children.link(coll)
    arm, meshes, skin = None, [], None
    for o in dst.objects:
        if o is None:
            continue
        coll.objects.link(o)
        if o.type == "ARMATURE":
            arm = o
        elif o.type == "MESH" and not o.get("high"):
            meshes.append(o)
            if o.name.startswith("Body_Skin"):
                skin = o
    return arm, meshes, skin


def bone_world(arm, names):
    for n in names:
        b = arm.data.bones.get(n)
        if b:
            return arm.matrix_world @ b.head_local, arm.matrix_world @ b.tail_local
    return None


def anchors(arm, meshes):
    """Wrist/hand axis, knee and ankle per side, from the body's armature or a 1.83 m A-pose stand-in; and a BVH of
    the clothed body for ray casts."""
    out = {}
    tree = None
    if meshes:
        dg = bpy.context.evaluated_depsgraph_get()
        bm = bmesh.new()
        for o in meshes:
            me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
            me.transform(o.matrix_world)
            bm.from_mesh(me)
            bpy.data.meshes.remove(me)
        tree = BVHTree.FromBMesh(bm)
        bm.free()
    for side, tag in ((1, "R"), (-1, "L")):
        hand = shin = foot = None
        if arm:
            hand = bone_world(arm, (f"hand.{tag}", f"hand{tag}"))
            shin = bone_world(arm, (f"shin.{tag}", f"shin{tag}"))
            foot = bone_world(arm, (f"foot.{tag}", f"foot{tag}"))
        if hand is None:
            w = Vector((side * 0.46, 0.03, 0.96))
            hand = (w, w + Vector((side * 0.04, 0.02, -0.14)))
        if shin is None:
            k = Vector((side * 0.112, 0.01, 0.52))
            shin = (k, Vector((side * 0.122, -0.02, 0.092)))
        if foot is None:
            a = Vector((side * 0.122, -0.02, 0.092))
            foot = (a, Vector((side * 0.122, 0.153, 0.02)))
        out[tag] = {"hand": hand, "shin": shin, "foot": foot}
    return out, tree


def knee_matrix(shin, tree):
    """Frame on the front of the trousers at the knee; also measures the trouser leg there (KNEE_FIT)."""
    global KNEE_WRAP
    k, ankle = shin
    up = (k - ankle).normalized()
    fwd = Vector((0, 1, 0))
    fwd = (fwd - up * fwd.dot(up)).normalized()
    side = fwd.cross(up)
    front = k + fwd * LEG_R
    KNEE_FIT.update({"hw": LEG_R, "depth": LEG_R, "cx": 0.0})
    if tree:
        hit, _ = ray(tree, k + fwd * 0.4, -fwd, 0.5)
        if hit is not None:
            front = hit + fwd * 0.004
        # Half-width of the trouser leg: rays from just outside each side (never as far as the other leg).
        a, _ = ray(tree, k + side * 0.095, -side, 0.095)
        b, _ = ray(tree, k - side * 0.095, side, 0.095)
        if a is not None and b is not None:
            KNEE_FIT["hw"] = ((a - b).dot(side)) / 2 + 0.003
            KNEE_FIT["cx"] = ((a + b) / 2 - k).dot(side)
        KNEE_FIT["depth"] = (front - k).dot(fwd)
    KNEE_WRAP = max(0.072, KNEE_FIT["hw"] * 1.08)
    Mk = Matrix.Translation(front - up * 0.010) @ basis(side, fwd, up)
    # Each strap is fitted to the trouser leg at its own height: an ellipse 2.5 mm outside the cloth all round.
    inv = Mk.inverted()
    straps = []
    for zc in STRAP_Z:
        h = (Mk @ Vector((0, 0, zc)) - k).dot(up)
        P = k + up * h
        ex = {}
        if tree:
            for name, d, reach in (("+x", side, 0.11), ("-x", -side, 0.11), ("+y", fwd, 0.16), ("-y", -fwd, 0.16)):
                hit, _ = ray(tree, P + d * reach, -d, reach)
                if hit is not None:
                    ex[name] = inv @ hit
        if len(ex) == 4:
            straps.append((zc, (ex["+x"].x + ex["-x"].x) / 2, (ex["+y"].y + ex["-y"].y) / 2, (ex["+x"].x - ex["-x"].x) / 2 + 0.0025, (ex["+y"].y - ex["-y"].y) / 2 + 0.0025))
        else:
            straps.append((zc, KNEE_FIT["cx"], -KNEE_FIT["depth"] + 0.004, KNEE_FIT["hw"] + 0.003, KNEE_FIT["depth"] + 0.003))
    KNEE_FIT["straps"] = straps
    print(f"  knee fit: half-width {KNEE_FIT['hw']:.3f}, depth {KNEE_FIT['depth']:.3f}, wrap {KNEE_WRAP:.3f}, straps " + "; ".join(f"z{s[0]:+.3f} c({s[1]:.3f},{s[2]:.3f}) r({s[3]:.3f},{s[4]:.3f})" for s in straps))
    return Mk


def boot_matrix(foot):
    a, toe = foot
    f = Vector((toe.x - a.x, toe.y - a.y, 0.0))
    if f.length < 1e-4:
        f = Vector((0, 1, 0))
    f.normalize()
    return Matrix.Translation((a.x, a.y, 0.0)) @ basis(f.cross(Vector((0, 0, 1))), f, Vector((0, 0, 1)))


def fit_boot(side, tag, M, skin, tree):
    """Sizes the boot to the body: the foot inside it and the shaft snug round the ankle (`tree` is the skin only)."""
    FIT.update({"heel": -0.072, "toe": 0.236, "wscale": 1.0, "rx": 0.043, "ry": 0.051, "cx": 0.0, "cy": 0.0, "shaft": []})
    inv = M.inverted()
    if skin:
        # Every skin vertex of this foot below the ankle (weights alone miss the heel, which leans on the shin).
        pts = []
        for v in skin.data.vertices:
            p = inv @ (skin.matrix_world @ v.co)
            if p.z < 0.075 and abs(p.x) < 0.07 and -0.16 < p.y < 0.32:
                pts.append(p)
        if pts:
            ys = [p.y for p in pts]
            xs = [p.x for p in pts]
            # A chunky boot: generous toe box and width round the body's foot.
            FIT["heel"] = min(min(ys) - 0.020, -0.066)
            FIT["toe"] = max(max(ys) + 0.040, 0.24)
            FIT["wscale"] = max(1.12, (max(abs(x) for x in xs) + 0.010) / 0.049)
    if tree:
        # The leg (skin) measured at several heights: the shaft follows the ankle and calf with room for padding and
        # leather (the trousers drape outside over the collar), never narrower than a real boot's ankle.
        table = []
        for z in (0.08, 0.12, 0.17, 0.22, 0.27, SHAFT_TOP - 0.01):
            ex = {}
            for name, d in (("+x", Vector((1, 0, 0))), ("-x", Vector((-1, 0, 0))), ("+y", Vector((0, 1, 0))), ("-y", Vector((0, -1, 0)))):
                wd = (M.to_3x3() @ d).normalized()
                # Start 10 cm out, so the ray never reaches the other leg (legs are ~24 cm apart).
                origin = M @ Vector((0, 0, z)) + wd * 0.10
                hit, _ = ray(tree, origin, -wd, 0.10)
                if hit is not None:
                    ex[name] = inv @ hit
            if len(ex) == 4:
                rx = (ex["+x"].x - ex["-x"].x) / 2
                ry = (ex["+y"].y - ex["-y"].y) / 2
                table.append([z, max(0.043, rx + 0.012), max(0.049, ry + 0.012), (ex["+x"].x + ex["-x"].x) / 2, (ex["+y"].y + ex["-y"].y) / 2])
        if table:
            # Never narrower going up (a boot shaft does not pinch in above the ankle), capped as before.
            for i in range(1, len(table)):
                table[i][1] = max(table[i][1], table[i - 1][1] * 0.98)
                table[i][2] = max(table[i][2], table[i - 1][2] * 0.98)
            for row in table:
                row[1], row[2] = min(row[1], 0.060), min(row[2], 0.066)
            FIT["shaft"] = [tuple(r) for r in table]
            FIT["rx"], FIT["ry"] = table[-1][1], table[-1][2]
            FIT["cx"] = sum(r[3] for r in table) / len(table)
            FIT["cy"] = sum(r[4] for r in table) / len(table)
    print(f"  boot {tag} fit: " + ", ".join(f"{k}={v:.3f}" for k, v in FIT.items() if k != "shaft") + " shaft " + " ".join(f"z{r[0]:.2f}:{r[1]:.3f}/{r[2]:.3f}" for r in FIT["shaft"]))


# ---- preview ------------------------------------------------------------------------------------------------------

def setup_render(res):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for kind in ("OPTIX", "CUDA"):
            try:
                prefs.compute_device_type = kind
                prefs.get_devices()
                if any(d.type == kind for d in prefs.devices):
                    break
            except Exception:
                pass
        for d in prefs.devices:
            d.use = True
        sc.cycles.device = "GPU"
    except Exception:
        pass
    sc.cycles.samples = 128
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Medium High Contrast"
    world = bpy.data.worlds.get("studio") or bpy.data.worlds.new("studio")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.42, 0.43, 0.45, 1)
    bg.inputs["Strength"].default_value = 0.55
    sc.world = world


def light(name, loc, target, energy, size, color=(1, 1, 1)):
    ld = bpy.data.lights.new(name, "AREA")
    ld.energy = energy
    ld.size = size
    ld.color = color
    o = bpy.data.objects.new(name, ld)
    bpy.context.scene.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()


def camera_at(pos, target, up, lens):
    cd = bpy.data.cameras.new("cam")
    cd.lens = lens
    cd.clip_start = 0.01
    o = bpy.data.objects.new("cam", cd)
    bpy.context.scene.collection.objects.link(o)
    f = (target - pos).normalized()
    r = f.cross(up).normalized()
    u = r.cross(f)
    o.matrix_world = basis(r, u, -f)
    o.matrix_world.translation = pos
    bpy.context.scene.camera = o


def standin_body(anch, coll):
    """Navy-trousered legs and sleeved arms for previews while the real body does not exist."""
    navy = bpy.data.materials.new("preview_navy")
    navy.use_nodes = True
    p = navy.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (0.034, 0.040, 0.062, 1)
    p.inputs["Roughness"].default_value = 0.85
    bm = bmesh.new()
    for tag, side in (("R", 1), ("L", -1)):
        k, a = anch[tag]["shin"]
        hip = Vector((side * 0.10, 0.0, 0.95))
        tube(bm, hip, k, 0.078, LEG_R - 0.002, segs=20)
        tube(bm, k, a + Vector((0, 0, 0.12)), LEG_R - 0.002, 0.048, segs=20)
        ellipsoid(bm, k, (LEG_R - 0.002,) * 3)
        w, tip = anch[tag]["hand"]
        d = (tip - w).normalized()
        tube(bm, w - d * 0.30, w - d * 0.03, 0.05, 0.04, segs=16)
    me = mesh_from_bm("standin", bm)
    me.materials.append(navy)
    new_object("standin", me, coll)


def hide_covered_skin():
    """Preview only: delete Body_Skin faces under the gloves and boots, as the finish stage does for the game."""
    skin = next((o for o in bpy.context.scene.objects if o.name.startswith("Body_Skin")), None)
    if skin is None:
        return
    idx = {g.index for g in skin.vertex_groups if g.name in ("hand.L", "hand.R", "foot.L", "foot.R")}
    bm = bmesh.new()
    bm.from_mesh(skin.data)
    deform = bm.verts.layers.deform.active
    if deform is None:
        bm.free()
        return
    covered = {v for v in bm.verts if sum(w for g, w in v[deform].items() if g in idx) > 0.5}
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if all(v in covered for v in f.verts)], context="FACES")
    bm.to_mesh(skin.data)
    bm.free()


def load_parts():
    """Preview only: the other workers' parts (head, torso), so the four views show the whole operator."""
    for name in ("swat_head.blend", "swat_torso.blend"):
        path = os.path.join(HERE, "out", name)
        if not os.path.exists(path):
            continue
        with bpy.data.libraries.load(path, link=False) as (src, dst):
            dst.objects = list(src.objects)
        for o in dst.objects:
            # Parents (armatures, empties) come along so parented parts land where they belong; only meshes render.
            if o is not None and not o.get("high"):
                bpy.context.scene.collection.objects.link(o)
                o.hide_render = o.type != "MESH"


def tuck_trousers(boots):
    """Preview only: what the finish stage does with the tuck_* properties: trouser legs pulled inside the boot
    shafts below the collar, bloused just above it."""
    trousers = next((o for o in bpy.context.scene.objects if o.name.startswith("Body_Trousers")), None)
    if trousers is None:
        return
    mw = trousers.matrix_world
    inv = mw.inverted()
    for v in trousers.data.vertices:
        p = mw @ v.co
        for b in boots:
            top = b["tuck_top"]
            dx, dy = p.x - b["tuck_cx"], p.y - b["tuck_cy"]
            if abs(dx) > 0.15 or abs(dy) > 0.15 or p.z > top + 0.07:
                continue
            e = math.hypot(dx / b["tuck_rx"], dy / b["tuck_ry"])
            if p.z < top - 0.04:
                k = min(1.0, 0.92 / max(e, 1e-6))  # tucked inside the shaft
            else:
                # Bloused: the fabric drapes out over the collar and hangs a few centimetres down over the shaft.
                f = min(1.0, (p.z - (top - 0.04)) / 0.11)
                k = max(1.18 / max(e, 1e-6), 1.0) * (1.0 + 0.06 * math.sin(math.pi * f))
                k = k * (1 - f) + max(k, 1.0) * f if e > 1.0 else k
            p = Vector((b["tuck_cx"] + dx * k, b["tuck_cy"] + dy * k, p.z))
            v.co = inv @ p


def previews(anch, objs):
    os.makedirs(PREVIEW, exist_ok=True)
    extra = bpy.data.collections.new("Preview")
    bpy.context.scene.collection.children.link(extra)
    if not bpy.data.collections.get("BodyRef"):
        standin_body(anch, extra)
    hide_covered_skin()
    load_parts()
    tuck_trousers([objs["Limbs_Boot.R"], objs["Limbs_Boot.L"]])
    floor = bpy.data.meshes.new("floor")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=6)
    bm.to_mesh(floor)
    bm.free()
    fm = bpy.data.materials.new("floor")
    fm.use_nodes = True
    fm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.36, 0.37, 0.39, 1)
    fm.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.6
    floor.materials.append(fm)
    extra.objects.link(bpy.data.objects.new("floor", floor))

    def centre(o):
        return sum((o.matrix_world @ v.co for v in o.data.vertices), Vector()) / len(o.data.vertices)

    def shoot(name, target, direction, up, dist, lens=85, res=(600, 900), key=(-1.2, 1.5, 1.6)):
        setup_render(res)
        for o in [o for o in bpy.context.scene.objects if o.type in ("LIGHT", "CAMERA")]:
            bpy.data.objects.remove(o)
        camera_at(target + direction.normalized() * dist, target, up, lens)
        light("key", target + Vector(key) * dist, target, 60 * dist * dist, dist * 0.9)
        light("fill", target + Vector((1.4, 1.0, 0.4)) * dist, target, 18 * dist * dist, dist * 1.2, (0.92, 0.95, 1.0))
        light("rim", target + Vector((0.3, -1.6, 1.0)) * dist, target, 45 * dist * dist, dist * 0.6)
        bpy.context.scene.render.filepath = os.path.join(PREVIEW, name + ".png")
        bpy.ops.render.render(write_still=True)

    w, a, b, x = hand_frame(1, anch["R"]["hand"])
    skin = next((o for o in bpy.context.scene.objects if o.name.startswith("Body_Skin")), None)
    thumb = hand_measure(skin, "R", w, a, b, x)[1]
    # As on the sheet: back of the hand three-quarters on, from the thumb side, fingers hanging.
    shoot("glove", w + a * 0.09, b * 0.75 + x * thumb * 0.65 + Vector((0, 0.15, 0)), -a, 0.58, res=(560, 900), key=(1.0, 0.9, 1.3))
    # Game distance: the hand in the A-pose, straight from the front, as in the sheet's front view.
    shoot("glove_far", w + a * 0.04, Vector((0, 1, 0.05)), Vector((0, 0, 1)), 1.5, lens=50, res=(700, 700), key=(-1.0, 1.4, 1.1))
    # The gripped cylinder (preview only), seen along its axis and from the thumb side.
    g = objs["Limbs_Glove.R"]
    gc, ga, gr = Vector(g["grip_center"]), Vector(g["grip_axis"]), g["grip_radius"]
    bm = bmesh.new()
    tube(bm, gc - ga * 0.07, gc + ga * 0.07, gr, gr, segs=24)
    gm = bpy.data.materials.new("grip_preview")
    gm.use_nodes = True
    gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.25, 0.08, 0.05, 1)
    me = mesh_from_bm("grip_preview", bm)
    me.materials.append(gm)
    grip = bpy.data.objects.new("grip_preview", me)
    extra.objects.link(grip)
    shoot("glove_grip", gc, ga, -a, 0.55, res=(700, 700), key=(1.0, 0.9, 1.3))
    shoot("glove_grip_thumb", gc + a * 0.01, -ga * 0.8 + b * 0.5 - a * 0.2, -a, 0.55, res=(700, 700), key=(-1.0, 0.9, 1.3))
    shoot("glove_grip_back", gc, b + ga * 0.4, -a, 0.55, res=(700, 700), key=(-1.0, 0.9, 1.3))
    bpy.data.objects.remove(grip)
    shoot("kneepad", centre(objs["Limbs_KneePad.R"]), Vector((0.06, 1.0, 0.02)), Vector((0, 0, 1)), 0.62, res=(560, 900), key=(-0.8, 1.5, 1.0))
    bc = centre(objs["Limbs_Boot.R"])
    shoot("boot", bc + Vector((0, 0.02, 0.0)), Vector((0.55, 1.0, 0.32)), Vector((0, 0, 1)), 1.05, res=(600, 900))
    body = bpy.data.collections.get("BodyRef")
    if body:
        body.hide_render = True
    # Boot on its own, like the sheet's equipment shot: three-quarters from the front-outside.
    shoot("boot_side", bc + Vector((0, 0.03, 0.0)), Vector((0.85, 0.75, 0.25)), Vector((0, 0, 1)), 1.25, res=(900, 640))
    if body:
        body.hide_render = False
    shoot("lower", Vector((0, 0, 0.62)), Vector((0.35, 1.0, 0.12)), Vector((0, 0, 1)), 3.2, lens=60, res=(900, 1100), key=(-1.0, 1.3, 1.2))
    # The sheet's four views of the whole operator: front, left, back, three-quarters.
    for name, d in (("v_front", (0, 1, 0.05)), ("v_left", (-1, 0, 0.05)), ("v_back", (0, -1, 0.05)), ("v_34", (-0.75, 1, 0.08))):
        shoot(name, Vector((0, 0, 0.93)), Vector(d), Vector((0, 0, 1)), 5.2, lens=50, res=(500, 1000), key=(-1.0, 1.4, 1.1))


# ---- main ---------------------------------------------------------------------------------------------------------

def main():
    reset()
    mt = mats()
    arm, meshes, skin = load_body()
    anch, tree = anchors(arm, meshes)
    skin_tree = anchors(arm, [skin])[1] if skin else None
    coll = bpy.data.collections.new("Limbs")
    bpy.context.scene.collection.children.link(coll)
    scratch = bpy.data.collections.new("Scratch")
    bpy.context.scene.collection.children.link(scratch)
    objs = {}
    for side, tag in ((1, "R"), (-1, "L")):
        g, gh = glove(side, tag, anch[tag]["hand"], skin, coll, mt)
        kp, kh = knee_pad(side, knee_matrix(anch[tag]["shin"], tree), coll, mt)
        M = boot_matrix(anch[tag]["foot"])
        fit_boot(side, tag, M, skin, skin_tree)
        bt, bh = boot(side, M, coll, mt)
        for o in (g, gh, kp, kh, bt, bh):
            objs[o.name] = o
    for o in list(scratch.objects):
        bpy.data.objects.remove(o)
    bpy.context.scene.collection.children.unlink(scratch)
    for o in list(bpy.data.objects):
        if o.name.startswith("tmp") or o.name.endswith("_tmp"):
            bpy.data.objects.remove(o)
    for me in list(bpy.data.meshes):
        if me.users == 0:
            bpy.data.meshes.remove(me)
    total = 0
    for o in sorted(coll.objects, key=lambda o: o.name):
        t = tri_count(o.data)
        if not o.get("high"):
            total += t
        print(f"  {o.name:24s} {t:7d} tris{'  (high)' if o.get('high') else ''}")
    print(f"limbs export total: {total} tris; body: {'swat_body.blend' if arm else 'stand-in'}")
    # The saved file holds only the limbs: drop the body (it is loaded again for the previews).
    body = bpy.data.collections.get("BodyRef")
    if body:
        for o in list(body.objects):
            bpy.data.objects.remove(o)
        bpy.data.collections.remove(body)
        for block in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials):
            for d in list(block):
                if d.users == 0:
                    block.remove(d)
    os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(OUT), compress=True)
    print("saved", OUT)
    if PREVIEW:
        load_body()
        previews(anch, objs)


main()
