"""
SWAT operator, part 4 of the pipeline: tactical gloves, hard knee pads and high tactical boots.

    blender --background --factory-startup --python swat_limbs.py -- [out.blend] [--preview <dir>]

Writes out/swat_limbs.blend with one collection `Limbs`: per side a glove, a knee pad and a boot in their final
world-space position on the A-posed body from out/swat_body.blend (or a 1.83 m stand-in while that file does not
exist), transforms applied, materials prefixed `Limbs_`. Reference: images/5.webp (glove, kneepad and boot crops).

- Gloves are the body's own hands, lifted out of Body_Skin, inflated by a few millimetres, voxel-remeshed and smoothed,
  so they fit the posed fingers exactly. The knuckle armour, padded finger segments, palm grip panel, cuff and Velcro
  wrist strap are placed by ray casts onto that shell.
- Boots are lofted from footprint and shaft cross-sections sized to the body's foot and trouser leg, voxel-remeshed so
  the joins fillet, then decimated; raised toe cap and heel counter panels, a lugged outsole with a heel break, a
  padded tongue, eyelets, criss-cross laces with a bow, a padded collar and a pull loop are added at game density.
- Knee pads are a domed, wrapped polymer shell with a rubber rim and a ridge, a fabric backing, two elastic straps
  and side buckles.
The dense remeshed shells are kept as `<name>_high` (custom property `high`, not rendered) for the normal bakes.
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

# Export budgets (triangles) for the decimated shells; the whole part stays under ~8k.
GLOVE_SHELL_TRIS = 640
BOOT_SHELL_TRIS = 480


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
        "nylon": material("BootNylon", (0.030, 0.031, 0.034), 0.86, bump=0.6, bump_scale=1600),
        "sole": material("BootSole", (0.020, 0.020, 0.020), 0.88, bump=0.4, bump_scale=300),
        "lace": material("Lace", (0.022, 0.022, 0.024), 0.85),
        "metal": material("Eyelet", (0.06, 0.06, 0.062), 0.42, metal=1.0),
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


def keep_high(o, mat):
    o.data.materials.append(mat)
    o["high"] = 1
    o.hide_render = True


# ---- gloves -------------------------------------------------------------------------------------------------------
# Modelled in a local frame (wrist at the origin, fingers +Y, back of the hand +Z, palm -Z, thumb on -X), then placed
# on the body's wrist along the hand bone, mirrored so the thumb is on the same side as the body's thumb, and scaled to
# the body's hand length. The glove replaces the hand: the finish stage hides the Body_Skin faces weighted to it.

FINGERS = [  # base x, segment lengths, base radius, splay (degrees)
    (-0.0340, (0.049, 0.030, 0.024), 0.0098, -7.0),
    (-0.0114, (0.053, 0.033, 0.025), 0.0103, -2.5),
    (0.0114, (0.050, 0.031, 0.024), 0.0098, 3.0),
    (0.0334, (0.039, 0.024, 0.021), 0.0088, 8.5),
]
CURL = (math.radians(8), math.radians(16), math.radians(12))
KNUCKLE_Y = 0.099
GLOVE_LENGTH = KNUCKLE_Y + 0.053 + 0.033 + 0.025  # wrist to the middle fingertip, straightened


def hand_frame(side, hand):
    """Wrist, hand axis (towards the fingertips), back-of-hand normal (outwards) and the lateral axis."""
    w, tip = hand
    a = (tip - w).normalized()
    out = Vector((side, 0, 0))
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


def finger_chain(base, lengths, splay, curl=CURL):
    """Joint positions and segment directions of a relaxed, slightly curled finger."""
    pts, dirs = [base.copy()], []
    yaw = Matrix.Rotation(math.radians(splay), 3, "Z")
    pitch = 0.0
    p = base.copy()
    for seg, length in enumerate(lengths):
        pitch += curl[seg]
        d = yaw @ (Matrix.Rotation(-pitch, 3, "X") @ Vector((0, 1, 0)))
        p = p + d * length
        pts.append(p.copy())
        dirs.append(d)
    return pts, dirs


def seg_rot(d):
    """Rotation taking local +Y to the segment direction, keeping local +Z on the back of the finger."""
    z = Vector((0, 0, 1))
    z = (z - d * z.dot(d)).normalized()
    return basis(d.cross(z), d, z)


CUFF_RX, CUFF_RZ = 0.037 * 1.22, 0.037  # cuff half-width / half-thickness at the wrist


def glove_shell(coll, cuff):
    bm = bmesh.new()
    # Cuff over the wrist, flaring a little towards the forearm; `cuff` (x, z) scales it to the body's wrist.
    # Long enough to run up under the shirt cuff (the sleeve stops short of the wrist).
    tube(bm, Vector((0, -0.085, 0.001)), Vector((0, 0.020, 0.0)), 0.042, 0.037, segs=20, scale_x=1.22)
    bmesh.ops.scale(bm, vec=(cuff[0], 1, cuff[1]), verts=list(bm.verts))
    # Hand: a flat-backed mitt with a thick heel and a knuckle ridge.
    ellipsoid(bm, Vector((0, 0.062, 0.0)), (0.047, 0.055, 0.0175), segs=(20, 12))
    ellipsoid(bm, Vector((0.004, 0.036, -0.004)), (0.042, 0.038, 0.020), segs=(18, 10))
    tube(bm, Vector((-0.041, KNUCKLE_Y + 0.004, 0.001)), Vector((0.040, KNUCKLE_Y + 0.002, 0.001)), 0.012, 0.0108, segs=10)
    # Thenar mound and the thumb.
    ellipsoid(bm, Vector((-0.032, 0.040, -0.009)), (0.020, 0.031, 0.016))
    tdir = Vector((-0.50, 0.80, -0.32)).normalized()
    t_pts, t_dirs = [Vector((-0.036, 0.034, -0.008))], []
    p = t_pts[0].copy()
    for length in (0.044, 0.032, 0.026):
        q = p + tdir * length
        t_pts.append(q.copy())
        t_dirs.append(tdir.copy())
        p = q
        tdir = (Matrix.Rotation(-math.radians(13), 3, "X") @ tdir).normalized()
    r = 0.0128
    for i in range(3):
        ellipsoid(bm, (t_pts[i] + t_pts[i + 1]) / 2, (r * 1.04, (t_pts[i + 1] - t_pts[i]).length * 0.62, r * 0.95), seg_rot(t_dirs[i]), segs=(14, 8))
        r *= 0.9
    # Fingers: a slightly barrel-shaped ellipsoid per segment, so the padded segments read after the remesh.
    chains = []
    for x0, lengths, r, splay in FINGERS:
        pts, dirs = finger_chain(Vector((x0, KNUCKLE_Y, 0.001)), lengths, splay)
        chains.append((pts, dirs, r))
        rr = r
        for i in range(3):
            ellipsoid(bm, (pts[i] + pts[i + 1]) / 2, (rr * 1.05, lengths[i] * 0.62, rr), seg_rot(dirs[i]), segs=(14, 8))
            rr *= 0.9
        ellipsoid(bm, pts[3] - dirs[2] * 0.004, (rr * 0.98, rr * 0.98, rr * 0.92), segs=(10, 6))
    o = new_object("glove_tmp", mesh_from_bm("glove_tmp", bm), coll)
    remesh_smooth(o, 0.0011, smooth_iters=5, smooth_factor=0.55)
    return o, chains, (t_pts, t_dirs)


def conform_grid(tree, nx, ny, place, direction, offset):
    """A grid whose vertices are ray-cast onto the shell: place(u, v) gives the ray origin for u, v in [-1, 1]."""
    bm = bmesh.new()
    grid = bmesh.ops.create_grid(bm, x_segments=nx, y_segments=ny, size=1.0)
    for v in grid["verts"]:
        o = place(v.co.x, v.co.y)
        hit, n = ray(tree, o, direction, 0.3)
        v.co = hit + n * offset if hit is not None else o + direction * 0.1
    return bm


def glove_parts(tree, chains, thumb, coll, cuff):
    """Everything layered on the shell, in the glove's local frame: (mesh, material slot) pairs."""
    down, up = Vector((0, 0, -1)), Vector((0, 0, 1))
    parts = []
    # Raised armour base across the knuckles, and a hard oval cap over each knuckle.
    bm = conform_grid(tree, 8, 2, lambda u, v: Vector((u * 0.041 - 0.001, KNUCKLE_Y - 0.003 + v * 0.011, 0.12)), down, 0.0003)
    parts.append((modified(mesh_from_bm("armor", bm), coll, [("SOLIDIFY", {"thickness": 0.0018, "offset": 1.0})]), 4))
    bm = bmesh.new()
    for pts, dirs, r in chains:
        hit, n = ray(tree, pts[0] + Vector((0, 0.001, 0.12)), down, 0.3)
        if hit is not None:
            ellipsoid(bm, hit + n * 0.0030, (r * 0.88, 0.0100, 0.0036), frame(n, Vector((0, 1, 0))), segs=(8, 4))
    parts.append((mesh_from_bm("caps", bm), 1))
    # Padded armour on the first two finger segments and on the thumb.
    bm = bmesh.new()
    segs = [(pts[i], pts[i + 1], dirs[i], r * (0.9 ** i)) for pts, dirs, r in chains for i in (0, 1)]
    t_pts, t_dirs = thumb
    segs.append((t_pts[1], t_pts[2], t_dirs[1], 0.0115))
    for p0, p1, d, r in segs:
        mid = (p0 + p1) / 2
        back = seg_rot(d).to_3x3() @ Vector((0, 0, 1))
        if p0.x < -0.035 and p0.y < 0.09:
            back = (back + Vector((-0.6, 0, 0.2))).normalized()  # the thumb's pad sits on its outer side
        hit, n = ray(tree, mid + back * 0.05, -back, 0.1)
        if hit is None:
            continue
        box(bm, hit + n * 0.0013, frame(n, d), (r * 1.15, (p1 - p0).length * 0.46, 0.0028))
    parts.append((mesh_from_bm("pads", bm), 1))
    # Textured panel on the back of the hand, and the grip panel on the palm.
    bm = conform_grid(tree, 4, 3, lambda u, v: Vector((u * 0.036, 0.055 + v * 0.026, 0.12)), down, 0.0005)
    parts.append((modified(mesh_from_bm("back", bm), coll, [("SOLIDIFY", {"thickness": 0.0012, "offset": 1.0})]), 4))
    bm = conform_grid(tree, 4, 4, lambda u, v: Vector((u * 0.038, 0.062 + v * 0.036, -0.12)), up, 0.0005)
    parts.append((modified(mesh_from_bm("palm", bm), coll, [("SOLIDIFY", {"thickness": 0.0013, "offset": 1.0})]), 2))
    # Wrist closure: a wide Velcro strap round the cuff with a tab on the back.
    bm = bmesh.new()
    tube(bm, Vector((0, -0.036, 0.001)), Vector((0, -0.014, 0.001)), 0.0415, 0.0405, segs=14, cap=False, scale_x=1.22)
    bmesh.ops.scale(bm, vec=(cuff[0], 1, cuff[1]), verts=bm.verts)
    parts.append((modified(mesh_from_bm("strap", bm), coll, [("SOLIDIFY", {"thickness": 0.0022, "offset": 1.0})]), 3))
    bm = bmesh.new()
    box(bm, Vector((0.012 * cuff[0], -0.025, 0.0365 * cuff[1])), Matrix.Rotation(0.06, 4, "Y"), (0.046, 0.024, 0.0042))
    parts.append((modified(mesh_from_bm("tab", bm), coll, [("BEVEL", {"width": 0.0015, "segments": 2})]), 3))
    return parts


def glove(side, tag, hand, skin, coll, mt):
    w, a, b, x = hand_frame(side, hand)
    length, thumb_side, wx, wb = hand_measure(skin, tag, w, a, b, x)
    scale = max(0.85, min(1.25, length / GLOVE_LENGTH * 1.03))
    cuff = (max(1.0, (wx + 0.004) / (CUFF_RX * scale)), max(1.0, (wb + 0.004) / (CUFF_RZ * scale)))
    high, chains, thumb = glove_shell(coll, cuff)
    high.name = f"Limbs_Glove.{tag}_high"
    tree = BVHTree.FromObject(high, bpy.context.evaluated_depsgraph_get())
    parts = glove_parts(tree, chains, thumb, coll, cuff)
    coarse = modified(high.data.copy(), coll, [("REMESH", {"mode": "VOXEL", "voxel_size": 0.0024, "use_smooth_shade": True})])
    low = decimated(coarse, GLOVE_SHELL_TRIS, coll)
    bpy.data.meshes.remove(coarse)
    final = assemble(f"Limbs_Glove.{tag}", [(low, 0)] + parts, [mt["glove"], mt["armor"], mt["palm"], mt["velcro"], mt["panel"]], coll)
    keep_high(high, mt["glove"])
    # The model's thumb is on local -X (world -x); mirror when the body's thumb is on the other side.
    mirror = Matrix.Diagonal((-1, 1, 1, 1)) if thumb_side > 0 else Matrix.Identity(4)
    M = Matrix.Translation(w) @ basis(x, a, b) @ Matrix.Diagonal((scale, scale, scale, 1)) @ mirror
    for o in (final, high):
        o.data.transform(M)
        if thumb_side > 0:
            o.data.flip_normals()
    print(f"  glove {tag}: hand length {length:.3f} m, scale {scale:.2f}, cuff x{cuff[0]:.2f}/{cuff[1]:.2f}, thumb on {'+' if thumb_side > 0 else '-'}x")
    return final, high


# ---- knee pads ----------------------------------------------------------------------------------------------------
# Local frame: origin on the front of the knee (on the trousers), +Y out of the leg, +Z up the leg. As on the sheet: a
# padded fabric sleeve with strap loops at its sides, an oval hard shell on it with a raised inner ridge, a crease
# across its upper third and six rivets, and two elastic straps round the leg with side buckles.

LEG_R = 0.062
KNEE_WRAP = 0.074  # radius the sleeve and shell wrap around (set per leg from the trousers)
KNEE_FIT = {"hw": LEG_R, "depth": LEG_R, "cx": 0.0}  # trouser half-width, front depth from the knee joint


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
    rho = math.sqrt(px * px + pz * pz)
    y = wrap_y(x, 0.012 + 0.020 * (1 - 0.45 * px * px - 0.65 * pz * pz))
    y -= 0.0022 * math.exp(-((pz - 0.42) / 0.09) ** 2) * (1 - px * px)  # crease across the upper third
    return Vector((x, y, z))


def shell_normal(px, pz):
    p = shell_point(px, pz)
    n = (shell_point(px + 0.02, pz) - p).cross(shell_point(px, pz + 0.02) - p).normalized()
    return -n if n.y < 0 else n


def knee_pad(side, M, coll, mt):
    tag = "R" if side > 0 else "L"
    parts = []
    # Padded sleeve: a rounded rectangle wrapped round the knee, visible all round the shell.
    bm = bmesh.new()
    grid = bmesh.ops.create_grid(bm, x_segments=6, y_segments=8, size=1.0)
    for v in grid["verts"]:
        u, w = squircle(v.co.x, v.co.y, 0.35)
        x = u * 0.066
        v.co = Vector((x, wrap_y(x, 0.002), w * 0.097))
    parts.append((modified(mesh_from_bm("sleeve", bm), coll, [("SOLIDIFY", {"thickness": 0.012, "offset": 1.0})]), 3))
    # Hard shell with a rubber rim.
    bm = bmesh.new()
    grid = bmesh.ops.create_grid(bm, x_segments=10, y_segments=12, size=1.0)
    for v in grid["verts"]:
        v.co = shell_point(*squircle(v.co.x, v.co.y, 0.88))
    me = mesh_from_bm("shell", bm)
    me.materials.append(mt["shell"])
    me.materials.append(mt["rubber"])  # Solidify needs the slot to exist, or the rim offset is clamped away
    parts.append((modified(me, coll, [("SOLIDIFY", {"thickness": 0.0065, "offset": 1.0, "material_offset_rim": 1})]), None))
    # Raised moulded ridge: a thin oval loop lying on the shell, inset from its edge.
    bm = bmesh.new()
    ring = []
    for i in range(22):
        ang = 2 * math.pi * i / 22
        px, pz = squircle(0.80 * math.cos(ang), 0.82 * math.sin(ang), 0.88)
        ring.append(shell_point(px, pz) + shell_normal(px, pz) * 0.0008)
    sweep_loop(bm, ring, 0.0017, sides=4, up=Vector((0, 1, 0)))
    parts.append((mesh_from_bm("ridge", bm), 0))
    # Rivets: four in the corners and one each side of the middle.
    bm = bmesh.new()
    for px, pz in ((-0.6, 0.66), (0.6, 0.66), (-0.6, -0.66), (0.6, -0.66), (-0.86, -0.05), (0.86, -0.05)):
        p = shell_point(px, pz)
        n = shell_normal(px, pz)
        ellipsoid(bm, p + n * 0.0008, (0.0046, 0.0046, 0.0026), frame(n), segs=(6, 3))
    parts.append((mesh_from_bm("rivets", bm), 4))
    # Straps round the leg, the loops they run through at the sleeve's sides, and side buckles.
    bm = bmesh.new()
    for zc in (0.068, -0.074):
        cy = -KNEE_FIT["depth"] + 0.004
        rr = KNEE_FIT["depth"] + 0.003
        tube(bm, Vector((KNEE_FIT["cx"], cy, zc - 0.010)), Vector((KNEE_FIT["cx"], cy, zc + 0.010)), rr, rr, segs=12, cap=False, scale_x=(KNEE_FIT["hw"] + 0.003) / rr)
    parts.append((modified(mesh_from_bm("straps", bm), coll, [("SOLIDIFY", {"thickness": 0.0024})]), 2))
    bm = bmesh.new()
    for zc in (0.068, -0.074):
        for sx in (-1, 1):
            x = sx * 0.064
            box(bm, Vector((x, wrap_y(x, 0.009), zc)), Matrix.Rotation(-math.asin(x / KNEE_WRAP), 4, "Z"), (0.007, 0.010, 0.030))
        ang = side * math.radians(80)
        c = Vector((KNEE_FIT["cx"] + math.sin(ang) * (KNEE_FIT["hw"] + 0.007), -KNEE_FIT["depth"] + math.cos(ang) * (KNEE_FIT["depth"] + 0.007), zc))
        box(bm, c, Matrix.Rotation(-ang, 4, "Z"), (0.030, 0.006, 0.024))
    parts.append((mesh_from_bm("hardware", bm), 4))
    o = assemble(f"Limbs_KneePad.{tag}", parts, [mt["shell"], mt["rubber"], mt["strap"], mt["padding"], mt["buckle"]], coll)
    o.data.transform(M)
    return o


# ---- boots --------------------------------------------------------------------------------------------------------
# Local frame: origin on the ground under the ankle, toe along +Y, up +Z; side +1 is the right foot (outside = +X).
# FIT is set per foot from the body before the boot is built.

WIDTH = [(0.0, 0.033), (0.08, 0.041), (0.25, 0.042), (0.5, 0.044), (0.68, 0.049), (0.82, 0.047), (0.92, 0.038), (0.975, 0.022), (1.0, 0.004)]
HEIGHT = [(0.0, 0.105), (0.28, 0.104), (0.42, 0.098), (0.55, 0.088), (0.7, 0.072), (0.85, 0.058), (0.95, 0.045), (1.0, 0.03)]
SOLE_TOP = 0.040
SHAFT_TOP = 0.232
FIT = {"heel": -0.072, "toe": 0.236, "wscale": 1.0, "rx": 0.043, "ry": 0.051, "cx": 0.0, "cy": 0.0}


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
    return 0.018 * max(0.0, (t - 0.74) / 0.26) ** 2


def arch(t):
    """Heel break: the outsole is lifted between the heel block and the forefoot."""
    up = min(max((t - 0.27) / 0.05, 0.0), 1.0)
    down = min(max((0.56 - t) / 0.08, 0.0), 1.0)
    return 0.007 * min(up, down)


def outline(side, n, notch=0.0, grow=0.0):
    """Closed footprint outline; with `notch` every other point juts out, so the sole's side shows lug blocks."""
    pts = []
    for i in range(n + 1):
        t = i / n
        pts.append((foot_center_x(t, side) + foot_w(t) + grow + (notch if (i % 2 == 0 and 0 < i < n) else 0.0), foot_y(t) + grow * (2 * t - 1), t))
    for i in range(n, -1, -1):
        t = i / n
        pts.append((foot_center_x(t, side) - foot_w(t) - grow - (notch if (i % 2 == 1 and 0 < i < n) else 0.0), foot_y(t) + grow * (2 * t - 1), t))
    return pts


def extrude_outline(bm, pts, z0, z1, lift_bottom=False):
    bottom = [bm.verts.new((x, y, z0 + toe_spring(t) + (arch(t) if lift_bottom else 0.0))) for x, y, t in pts]
    top = [bm.verts.new((x, y, z1 + toe_spring(t))) for x, y, t in pts]
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((bottom[i], bottom[j], top[j], top[i]))
    bm.faces.new(list(reversed(bottom)))
    bm.faces.new(top)


def prism(bm, bottom_pts, top_pts, z0, z1):
    """Like extrude_outline, but the top and bottom outlines differ (a flared midsole)."""
    bottom = [bm.verts.new((x, y, z0 + toe_spring(t))) for x, y, t in bottom_pts]
    top = [bm.verts.new((x, y, z1 + toe_spring(t))) for x, y, t in top_pts]
    n = len(bottom)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((bottom[i], bottom[j], top[j], top[i]))
    bm.faces.new(list(reversed(bottom)))
    bm.faces.new(top)


def boot_shell(side, coll):
    bm = bmesh.new()
    rings = []
    n_t, n_a = 26, 18
    for i in range(n_t + 1):
        t = i / n_t
        y = foot_y(0.02 + 0.97 * t)
        a = max(foot_w(t) * 0.97, 0.004)
        h = interp(HEIGHT, t)
        # Round the toe and the heel in profile (the ends shrink in height as well as width).
        end = max((t - 0.80) / 0.20, (0.07 - t) / 0.07, 0.0)
        h *= math.sqrt(max(0.06, 1 - end * end))
        zc = SOLE_TOP - 0.004 + h / 2 + toe_spring(t)
        xc = foot_center_x(t, side)
        ring = []
        for k in range(n_a):
            ang = 2 * math.pi * k / n_a
            c, s = math.cos(ang), math.sin(ang)
            ex = 2.0 / 2.5
            ring.append(bm.verts.new((xc + a * math.copysign(abs(c) ** ex, c), y, zc + (h / 2) * math.copysign(abs(s) ** ex, s))))
        rings.append(ring)
    for i in range(n_t):
        for k in range(n_a):
            kk = (k + 1) % n_a
            bm.faces.new((rings[i][k], rings[i][kk], rings[i + 1][kk], rings[i + 1][k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    # Shaft: elliptical sections hugging the ankle, flaring slightly to the collar, leaning a little forward.
    rings = []
    n_z = 10
    for i in range(n_z + 1):
        f = i / n_z
        z = 0.06 + (SHAFT_TOP - 0.06) * f
        waist = 0.15 * math.exp(-((f - 0.28) / 0.22) ** 2)  # narrowest just above the ankle bones
        rx = FIT["rx"] * (0.98 + 0.10 * f - waist)
        ry = FIT["ry"] * (1.0 + 0.07 * f - waist * 0.7)
        yc = FIT["cy"] - 0.004 + 0.010 * f
        ring = [bm.verts.new((FIT["cx"] + rx * math.cos(2 * math.pi * k / 20), yc + ry * math.sin(2 * math.pi * k / 20), z)) for k in range(20)]
        rings.append(ring)
    for i in range(n_z):
        for k in range(20):
            kk = (k + 1) % 20
            bm.faces.new((rings[i][k], rings[i][kk], rings[i + 1][kk], rings[i + 1][k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = new_object("boot_tmp", mesh_from_bm("boot_tmp", bm), coll)
    remesh_smooth(o, 0.0026, smooth_iters=8, smooth_factor=0.6)
    return o


def toe_cap(c):
    return c.y > FIT["toe"] - 0.078 and c.z < 0.088


def heel_counter(c):
    return c.y < FIT["heel"] + 0.062 and SOLE_TOP + 0.012 < c.z < 0.118


def boot_zone(c):
    """Material slot for a shell face by its centre: rubber mudguard, leather toe/vamp/heel, nylon quarters/shaft."""
    if c.z < SOLE_TOP + 0.014:
        return 1
    if toe_cap(c) or heel_counter(c):
        return 0
    if c.y > FIT["heel"] + 0.13 and c.z < 0.125:
        return 0
    return 2


def overlay(me_low, keep, slot, coll):
    """A raised panel: the shell faces selected by `keep`, pushed out along their normals and given thickness."""
    bm = bmesh.new()
    bm.from_mesh(me_low)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if not keep(f.calc_center_median())], context="FACES")
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * 0.0011
    return modified(mesh_from_bm("panel", bm, slot), coll, [("SOLIDIFY", {"thickness": 0.0014, "offset": 1.0})])


def boot(side, M, coll, mt):
    tag = "R" if side > 0 else "L"
    high = boot_shell(side, coll)
    high.name = f"Limbs_Boot.{tag}_high"
    tree = BVHTree.FromObject(high, bpy.context.evaluated_depsgraph_get())
    low = decimated(high.data, BOOT_SHELL_TRIS, coll)
    for p in low.polygons:
        p.material_index = boot_zone(p.center)
    parts = [(low, None)]

    # Stitched panel seams cast onto the shell: across the toe cap, round the heel counter, and the quarter panel's
    # edge running from the heel counter up to the lacing on each side.
    def onto(origin, target):
        d = target - origin
        hit, n = ray(tree, origin, d, d.length + 0.05)
        return hit + n * 0.0006 if hit is not None else None

    seams = []
    t_cap = 0.79
    yc_cap = foot_y(t_cap)
    zc_cap = SOLE_TOP + interp(HEIGHT, t_cap) * 0.45
    seams.append([onto(Vector((foot_center_x(t_cap, side) + 0.2 * math.sin(th), yc_cap + 0.03, zc_cap + 0.2 * math.cos(th))), Vector((foot_center_x(t_cap, side), yc_cap, zc_cap))) for th in [math.radians(a) for a in range(-100, 101, 12)]])
    hc = Vector((FIT["cx"], FIT["heel"] + 0.055, 0.0))
    seams.append([onto(hc + Vector((0.2 * math.sin(ph), -0.2 * math.cos(ph), 0.098 - 0.03 * (abs(ph) / math.radians(110)) ** 2)), hc + Vector((0, 0, 0.098 - 0.03 * (abs(ph) / math.radians(110)) ** 2))) for ph in [math.radians(a) for a in range(-110, 111, 14)]])
    for sx in (-1, 1):
        line = []
        for i in range(9):
            f = i / 8
            y = FIT["heel"] + 0.07 + f * 0.11
            z = 0.075 + f * 0.035 + 0.012 * math.sin(math.pi * f)
            line.append(onto(Vector((FIT["cx"] + sx * 0.2, y, z)), Vector((FIT["cx"], y, z))))
        seams.append(line)
    bm = bmesh.new()
    for line in seams:
        line = [p for p in line if p is not None]
        if len(line) >= 3:
            sweep_loop(bm, line, 0.0011, sides=3, closed=False)
    parts.append((mesh_from_bm("seams", bm), 0))

    # Lugged outsole with a heel break, and a plain midsole band.
    bm = bmesh.new()
    extrude_outline(bm, outline(side, 18, notch=0.007, grow=0.005), 0.0, 0.016, lift_bottom=True)
    prism(bm, outline(side, 18, grow=0.0045), outline(side, 18, grow=0.0005), 0.015, SOLE_TOP + 0.001)
    parts.append((mesh_from_bm("sole", bm), 3))

    # Lacing: rows on the instep (cast down) and up the shaft front (cast backwards).
    rows = []
    for t in (0.74, 0.67, 0.60, 0.53):
        y = foot_y(t)
        rows.append([ray(tree, Vector((FIT["cx"] + sx * 0.0165, y, 0.4)), Vector((0, 0, -1)), 0.5) for sx in (-1, 1)])
    for z in (0.120, 0.148, 0.176, 0.204, 0.230):
        rows.append([ray(tree, Vector((FIT["cx"] + sx * 0.0175, 0.4, z)), Vector((0, -1, 0)), 0.5) for sx in (-1, 1)])
    rows = [r for r in rows if r[0][0] is not None and r[1][0] is not None]
    # Padded tongue strip down the middle of the lacing.
    if len(rows) >= 2:
        bm = bmesh.new()
        verts = []
        for (p0, n0), (p1, n1) in rows:
            mid = (p0 + p1) / 2
            n = (n0 + n1).normalized()
            lat = (p1 - p0).normalized()
            verts.append([bm.verts.new(mid + n * 0.0012 + lat * s * 0.012) for s in (-1, 1)])
        (p0, n0), (p1, n1) = rows[-1]
        top = (p0 + p1) / 2 + (n0 + n1).normalized() * 0.0015 + Vector((0, 0.004, SHAFT_TOP + 0.016 - p0.z))
        lat = (p1 - p0).normalized()
        verts.append([bm.verts.new(top + lat * s * 0.015) for s in (-1, 1)])
        for (a0, a1), (b0, b1) in zip(verts, verts[1:]):
            bm.faces.new((a0, a1, b1, b0))
        parts.append((modified(mesh_from_bm("tongue", bm), coll, [("SOLIDIFY", {"thickness": 0.005, "offset": 1.0}), ("BEVEL", {"width": 0.0015, "segments": 1})]), 6))
    bm = bmesh.new()
    for pair in rows:
        for hit, n in pair:
            bmesh.ops.create_cone(bm, cap_ends=False, segments=6, radius1=0.0033, radius2=0.0033, depth=0.0018, matrix=Matrix.Translation(hit + n * 0.0006) @ frame(n))
    parts.append((mesh_from_bm("eyelets", bm), 5))
    bm = bmesh.new()
    lift = 0.0048
    for a, b in zip(rows, rows[1:]):
        for (p0, n0), (p1, n1) in ((a[0], b[1]), (a[1], b[0])):
            tube(bm, p0 + n0 * lift, p1 + n1 * lift, 0.0015, 0.0015, segs=5, cap=False)
    if rows:
        (p0, n0), (p1, n1) = rows[0]
        tube(bm, p0 + n0 * lift, p1 + n1 * lift, 0.0015, 0.0015, segs=5, cap=False)
        (p0, n0), (p1, n1) = rows[-1]
        top = (p0 + p1) / 2 + n0 * 0.006
        for sx in (-1, 1):
            loop = Matrix.Translation(top + Vector((sx * 0.010, 0.002, 0.003))) @ Matrix.Rotation(math.pi / 2, 4, "X") @ Matrix.Rotation(sx * 0.5, 4, "Y") @ Matrix.Diagonal((0.011, 0.006, 0.011, 1))
            bmesh.ops.create_cone(bm, cap_ends=False, segments=8, radius1=1.0, radius2=1.0, depth=0.0025, matrix=loop)
            tube(bm, top, top + Vector((sx * 0.007, 0.008, -0.05)), 0.0013, 0.0012, segs=5, cap=False)
    parts.append((mesh_from_bm("laces", bm), 4))

    # Padded collar and the pull loop at the back.
    rx, ry, yc = FIT["rx"] * 1.03 + 0.004, FIT["ry"] * 1.04 + 0.004, FIT["cy"] + 0.006
    rx, ry = FIT["rx"] * 1.08 + 0.002, FIT["ry"] * 1.07 + 0.002
    bm = bmesh.new()
    ring = [Vector((FIT["cx"] + rx * math.cos(2 * math.pi * k / 18), yc + ry * math.sin(2 * math.pi * k / 18), SHAFT_TOP - 0.002 - 0.006 * max(0.0, math.sin(2 * math.pi * k / 18)))) for k in range(18)]
    # A rolled, padded collar: a fat tube, dipping a little at the front where the tongue comes up.
    sweep_loop(bm, ring, 0.0085, sides=6)
    parts.append((mesh_from_bm("collar", bm), 6))
    bm = bmesh.new()
    loop = Matrix.Translation((FIT["cx"], yc - ry - 0.004, SHAFT_TOP + 0.008)) @ Matrix.Rotation(math.pi / 2, 4, "Y") @ Matrix.Diagonal((0.017, 0.009, 1.0, 1))
    bmesh.ops.create_cone(bm, cap_ends=False, segments=8, radius1=1.0, radius2=1.0, depth=0.012, matrix=loop)
    parts.append((modified(mesh_from_bm("pull", bm), coll, [("SOLIDIFY", {"thickness": 0.002})]), 2))

    final = assemble(f"Limbs_Boot.{tag}", parts, [mt["leather"], mt["rubber"], mt["nylon"], mt["sole"], mt["lace"], mt["metal"], mt["padding"]], coll)
    keep_high(high, mt["leather"])
    for o in (final, high):
        o.data.transform(M)
    return final, high


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
    print(f"  knee fit: half-width {KNEE_FIT['hw']:.3f}, depth {KNEE_FIT['depth']:.3f}, wrap {KNEE_WRAP:.3f}")
    return Matrix.Translation(front - up * 0.010) @ basis(side, fwd, up)


def boot_matrix(foot):
    a, toe = foot
    f = Vector((toe.x - a.x, toe.y - a.y, 0.0))
    if f.length < 1e-4:
        f = Vector((0, 1, 0))
    f.normalize()
    return Matrix.Translation((a.x, a.y, 0.0)) @ basis(f.cross(Vector((0, 0, 1))), f, Vector((0, 0, 1)))


def fit_boot(side, tag, M, skin, tree):
    """Sizes the boot to the body: the foot inside it and the shaft snug round the ankle (`tree` is the skin only)."""
    FIT.update({"heel": -0.072, "toe": 0.236, "wscale": 1.0, "rx": 0.043, "ry": 0.051, "cx": 0.0, "cy": 0.0})
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
            FIT["heel"] = min(min(ys) - 0.016, -0.06)
            FIT["toe"] = max(max(ys) + 0.024, 0.20)
            FIT["wscale"] = max(1.0, (max(abs(x) for x in xs) + 0.007) / 0.049)
    if tree:
        # Widest leg section (trousers bloused into the boot) between the ankle and the collar.
        rx, ry, cxs, cys = 0.0, 0.0, [], []
        for z in (0.12, 0.16, 0.20, SHAFT_TOP - 0.01):
            ex = {}
            for name, d in (("+x", Vector((1, 0, 0))), ("-x", Vector((-1, 0, 0))), ("+y", Vector((0, 1, 0))), ("-y", Vector((0, -1, 0)))):
                wd = (M.to_3x3() @ d).normalized()
                # Start 10 cm out, so the ray never reaches the other leg (legs are ~24 cm apart).
                origin = M @ Vector((0, 0, z)) + wd * 0.10
                hit, _ = ray(tree, origin, -wd, 0.10)
                if hit is not None:
                    ex[name] = inv @ hit
            if len(ex) == 4:
                rx = max(rx, (ex["+x"].x - ex["-x"].x) / 2)
                ry = max(ry, (ex["+y"].y - ex["-y"].y) / 2)
                cxs.append((ex["+x"].x + ex["-x"].x) / 2)
                cys.append((ex["+y"].y + ex["-y"].y) / 2)
        if cxs:
            # The ankle and lower calf (skin) inside a snug shaft; the trousers blouse over the top as on the sheet.
            FIT["rx"] = min(0.050, max(0.040, rx + 0.012))
            FIT["ry"] = min(0.056, max(0.047, ry + 0.012))
            FIT["cx"] = sum(cxs) / len(cxs)
            FIT["cy"] = sum(cys) / len(cys)
    print(f"  boot {tag} fit: " + ", ".join(f"{k}={v:.3f}" for k, v in FIT.items()))


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


def previews(anch, objs):
    os.makedirs(PREVIEW, exist_ok=True)
    extra = bpy.data.collections.new("Preview")
    bpy.context.scene.collection.children.link(extra)
    if not bpy.data.collections.get("BodyRef"):
        standin_body(anch, extra)
    hide_covered_skin()
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
    shoot("glove_palm", w + a * 0.085, -b * 1.0 + Vector((0, 0.5, 0)), -a, 0.60, res=(560, 900), key=(-1.0, 1.2, 1.3))
    shoot("kneepad", centre(objs["Limbs_KneePad.R"]), Vector((0.06, 1.0, 0.02)), Vector((0, 0, 1)), 0.62, res=(560, 900), key=(-0.8, 1.5, 1.0))
    bc = centre(objs["Limbs_Boot.R"])
    shoot("boot", bc + Vector((0, 0.01, -0.01)), Vector((0.9, 0.85, 0.32)), Vector((0, 0, 1)), 0.72, res=(600, 900))
    body = bpy.data.collections.get("BodyRef")
    if body:
        body.hide_render = True
    # Boot on its own, like the sheet's equipment shot: three-quarters from the front-outside.
    shoot("boot_side", bc + Vector((0, 0, 0.04)), Vector((0.85, 0.75, 0.25)), Vector((0, 0, 1)), 0.8, res=(900, 640))
    if body:
        body.hide_render = False
    shoot("lower", Vector((0, 0, 0.62)), Vector((0.35, 1.0, 0.12)), Vector((0, 0, 1)), 3.2, lens=60, res=(900, 1100), key=(-1.0, 1.3, 1.2))


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
        kp = knee_pad(side, knee_matrix(anch[tag]["shin"], tree), coll, mt)
        M = boot_matrix(anch[tag]["foot"])
        fit_boot(side, tag, M, skin, skin_tree)
        bt, bh = boot(side, M, coll, mt)
        for o in (g, gh, kp, bt, bh):
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
