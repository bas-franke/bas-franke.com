"""
First-person SWAT arms for Last Light (arms.glb), modelled in Blender:

    blender --background --factory-startup --python build_arms.py -- <output-dir> [<preview-dir>]

- Hands: organic volumes from metaballs (a palm with thenar and hypothenar pads, five fingers with three phalanges
  each, knuckle bulges), posed joint by joint around the real grip and handguard of the guns (phalanx lengths of a
  gloved adult hand, each joint placed on the gun's cross-section so the fingers hug it), converted to meshes and
  decimated.
- Glove: the hand surface is the glove; a moulded knuckle guard, a gauntlet cuff with a wrist strap and a velcro tab sit on top; the palm side has its own grippy material.
- Sleeve: a navy ripstop combat-shirt sleeve, simulated as cloth: it starts pulled down over the cuff and is pushed back up the
  forearm by a hook, so it bunches into real folds at the wrist; then thickened.
- Textures: one shared atlas for both arms with baked tangent normals (leather grain, stitching, fabric weave,
  ribbing), ambient occlusion (glTF occlusion) and roughness.

Contract (viewmodel.ts): meshes ArmR / ArmL, origin at the camera, glTF -Z forward (Blender +Y), the right palm wraps
the gun grip at ARM_PALM_R (the gun's origin) and the left palm sits under a handguard whose axis is 4.2 cm above
ARM_PALM_L (viewmodel.ts moves ArmL so that point lands under the gun it holds).
"""

import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = Path(ARGS[0]) if ARGS else Path("models")
PREVIEW = ARGS[1] if len(ARGS) > 1 and ARGS[1] not in ("arms",) else None

# Camera at the origin looking along +Y (glTF -Z), x right, z up.
ARM_PALM_R = Vector((0.12, 0.33, -0.21))
ARM_PALM_L = Vector((0.02, 0.53, -0.19))
BAKE_SIZE = 1024
# Metaball surface radius per unit of element radius (threshold 0.6, stiffness 2), measured.
MB_K = 0.575


# ---- helpers ---------------------------------------------------------------------------------------------------------

def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, color, rough=0.6, spec=0.4, sheen=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Specular IOR Level"].default_value = spec
    if sheen:
        bsdf.inputs["Sheen Weight"].default_value = sheen
    return mat


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def activate(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def apply_mods(obj):
    activate(obj)
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def smooth(obj, angle=60):
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def join(objs, name):
    objs = [o for o in objs if o]
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = name
    o.data.name = name
    return o


def decimate(obj, ratio):
    if ratio >= 1:
        return obj
    d = obj.modifiers.new("Dec", "DECIMATE")
    d.ratio = ratio
    apply_mods(obj)
    return obj


def tris(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def quat_x_to(d):
    """Rotation taking +X onto direction d (metaball capsules lie along their local X)."""
    return Vector((1, 0, 0)).rotation_difference(d.normalized())


# ---- metaball volumes -------------------------------------------------------------------------------------------------

class Volume:
    """One metaball family: everything added to it melts into one smooth surface."""

    def __init__(self, name, res=0.0026):
        self.mb = bpy.data.metaballs.new(name)
        self.mb.resolution = res
        self.mb.render_resolution = res
        self.mb.threshold = 0.6
        self.obj = link(bpy.data.objects.new(name, self.mb))

    def ball(self, c, r, scale=(1, 1, 1), rot=None):
        e = self.mb.elements.new(type="ELLIPSOID" if scale != (1, 1, 1) else "BALL")
        e.co = c
        e.radius = r / MB_K
        e.stiffness = 2.0
        if scale != (1, 1, 1):
            e.size_x, e.size_y, e.size_z = scale
        if rot is not None:
            e.rotation = rot
        return e

    def capsule(self, a, b, r):
        a, b = Vector(a), Vector(b)
        e = self.mb.elements.new(type="CAPSULE")
        e.co = (a + b) / 2
        e.radius = r / MB_K
        e.stiffness = 2.0
        e.size_x = (b - a).length / 2
        e.rotation = quat_x_to(b - a)
        return e

    def chain(self, pts, radii):
        """Tapered limb: capsules between joints plus a ball at every joint (knuckles)."""
        for i in range(len(pts) - 1):
            self.capsule(pts[i], pts[i + 1], (radii[i] + radii[i + 1]) / 2)
        for p, r in zip(pts, radii):
            self.ball(p, r * 1.04)

    def mesh(self, name, mat, ratio):
        activate(self.obj)
        bpy.ops.object.convert(target="MESH")
        o = bpy.context.active_object
        o.name = name
        o.data.materials.clear()
        o.data.materials.append(mat)
        smooth(o)
        return decimate(o, ratio)


def skin_chain(name, pts, radii, mat, subsurf=2, ratio=0.35):
    """A limb as a Skin-modifier tube through joint points (with in-between points slightly thinner, so the knuckles
    read without beading), subdivided into a smooth surface with a rounded tip."""
    verts, rads = [], []
    for i in range(len(pts) - 1):
        a, b = Vector(pts[i]), Vector(pts[i + 1])
        verts += [a, a.lerp(b, 0.5)]
        rads += [radii[i], (radii[i] + radii[i + 1]) / 2 * 0.95]
    verts.append(Vector(pts[-1]))
    rads.append(radii[-1])
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [(i, i + 1) for i in range(len(verts) - 1)], [])
    o = link(bpy.data.objects.new(name, me))
    sk = o.modifiers.new("Skin", "SKIN")
    sk.use_smooth_shade = True
    for i, r in enumerate(rads):
        o.data.skin_vertices[0].data[i].radius = (r, r)
    o.data.skin_vertices[0].data[0].use_root = True
    sub = o.modifiers.new("Sub", "SUBSURF")
    sub.levels = subsurf
    apply_mods(o)
    o.data.materials.append(mat)
    smooth(o)
    return decimate(o, ratio)


# ---- skinned tubes and strips (cuffs, guards, pads) -----------------------------------------------------------------

def ring_mesh(name, rings, mat, cap_start=False, cap_end=False):
    """Mesh through a list of rings (each a list of points, same count)."""
    me = bpy.data.meshes.new(name)
    verts = [tuple(p) for r in rings for p in r]
    n = len(rings[0])
    faces = []
    for i in range(len(rings) - 1):
        for j in range(n):
            a = i * n + j
            b = i * n + (j + 1) % n
            faces.append((a, b, b + n, a + n))
    if cap_start:
        faces.append(tuple(reversed(range(n))))
    if cap_end:
        faces.append(tuple((len(rings) - 1) * n + j for j in range(n)))
    me.from_pydata(verts, [], faces)
    me.update()
    o = link(bpy.data.objects.new(name, me))
    o.data.materials.append(mat)
    return smooth(o)


def frame_for(axis, up=Vector((0, 0, 1))):
    z = axis.normalized()
    x = up.cross(z)
    if x.length < 1e-4:
        x = Vector((1, 0, 0)).cross(z)
    x.normalize()
    y = z.cross(x)
    return x, y, z


def tube(name, pts, radii, mat, segs=20, squash=1.0, up=Vector((0, 0, 1)), cap_end=False):
    """Tube through a polyline with per-point radii (squash flattens it along the frame's y)."""
    rings = []
    for i, p in enumerate(pts):
        d = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)])
        x, y, _ = frame_for(d, up)
        r = radii[i]
        rings.append([p + x * (math.cos(a) * r) + y * (math.sin(a) * r * squash) for a in (2 * math.pi * k / segs for k in range(segs))])
    return ring_mesh(name, rings, mat, cap_end=cap_end)


# ---- hands -----------------------------------------------------------------------------------------------------------

# Gloved adult male hand, metres: phalanx lengths (proximal, middle, distal) and radii.
FINGERS = {
    "index": ((0.046, 0.027, 0.022), 0.0106),
    "middle": ((0.050, 0.031, 0.023), 0.0110),
    "ring": ((0.047, 0.029, 0.022), 0.0104),
    "little": ((0.037, 0.022, 0.019), 0.0094),
}


def walk(start, length, curve, t0):
    """Point on `curve(t)` (t increasing) at `length` from `start`, searching from t0; returns (point, t)."""
    t = t0
    prev = curve(t)
    for _ in range(4000):
        t += 0.002
        p = curve(t)
        if (p - start).length >= length:
            return p, t
        prev = p
    return prev, t


def finger_around(curve, mcp, lengths, t0):
    """Joints of a finger whose MCP knuckle is at `mcp` and whose phalanges lie on the wrap curve."""
    pip, t = walk(mcp, lengths[0], curve, t0)
    dip, t = walk(pip, lengths[1], curve, t)
    tip, t = walk(dip, lengths[2], curve, t)
    return [mcp, pip, dip, tip]


def grip_curve(z, extra):
    """Around a pistol grip (gun space, Blender axes): cross-section ~3 x 5.4 cm, leaning back 15 degrees.
    t = 0 on the right side, pi/2 at the front strap, pi on the left side."""
    yc = -0.006 + 0.275 * z
    rx, ry = 0.0155 + extra, 0.027 + extra

    def c(t):
        return Vector((rx * math.cos(t), yc + ry * math.sin(t), z))

    return c


def right_hand(mats):
    """Right hand wrapped around a pistol grip at the gun's origin (gun space). Returns (parts, wrist, wrist_dir)."""
    glove, palm_mat, armor = mats["glove"], mats["palm"], mats["armor"]
    parts = []
    joints = {}
    # Middle, ring and little fingers: knuckles stand off the right-front of the grip, the phalanges hug the front
    # strap and end on the left side.
    for name, z, ky in (("middle", -0.016, 0.0), ("ring", -0.038, -0.004), ("little", -0.058, -0.010)):
        lengths, r = FINGERS[name]
        curve = grip_curve(z, r + 0.0012)
        mcp = Vector((0.036, 0.004 + 0.275 * z + ky, z + 0.003))
        js = finger_around(curve, mcp, lengths, 0.15)
        joints[name] = (js, r)
    # Index finger: along the right side of the frame, the last joint curling onto the trigger.
    lengths, r = FINGERS["index"]
    mcp = Vector((0.037, 0.006, 0.006))
    pip = mcp + Vector((-0.012, 0.044, -0.004)).normalized() * lengths[0]
    dip = pip + Vector((-0.017, 0.016, -0.012)).normalized() * lengths[1]
    tip = dip + Vector((-0.012, -0.006, -0.019)).normalized() * lengths[2]
    joints["index"] = ([mcp, pip, dip, tip], r)
    # Thumb: from the heel of the hand over the back strap to the left side of the frame, pointing forward.
    thumb = [Vector((0.026, -0.058, -0.024)), Vector((0.006, -0.050, 0.008)), Vector((-0.022, -0.026, 0.012)), Vector((-0.027, 0.004, 0.010)), Vector((-0.025, 0.026, 0.008))]
    # Palm volume: the main pad on the right side of the grip, the thenar pad up into the web, the hypothenar heel
    # against the back strap. Back of the hand: a flatter, wider layer with the metacarpal ridges.
    pv = Volume("PalmR")
    rot = Quaternion(Vector((0, 0, 1)), math.radians(8))
    pv.ball(Vector((0.033, -0.026, -0.028)), 1.0, scale=(0.0155, 0.047, 0.044), rot=rot)
    pv.ball(Vector((0.022, -0.050, -0.006)), 1.0, scale=(0.017, 0.022, 0.018))
    pv.ball(Vector((0.021, -0.050, -0.052)), 1.0, scale=(0.016, 0.022, 0.021))
    for name in ("index", "middle", "ring", "little"):
        js, r = joints[name]
        base = Vector((0.036, -0.064, -0.030 + (js[0].z + 0.026) * 0.45))
        pv.capsule(base, js[0], r * 0.92)
    # Wrist: where the palm narrows into the forearm.
    wrist = Vector((0.038, -0.098, -0.044))
    pv.ball(wrist + Vector((0, 0.012, 0.003)), 1.0, scale=(0.022, 0.02, 0.028))
    # Thumb base (CMC + metacarpal) belongs to the palm volume so the web is continuous.
    pv.capsule(thumb[0], thumb[1], 0.0135)
    parts.append(pv.mesh("palmR", glove, 0.14))
    for name in ("index", "middle", "ring", "little"):
        js, r = joints[name]
        parts.append(skin_chain(name + "R", js, [r * 1.08, r, r * 0.94, r * 0.86], glove))
    parts.append(skin_chain("thumbR", thumb[1:], [0.0135, 0.0123, 0.0113, 0.0101], glove))
    # Grippy material on the palm side (faces pointing at the grip).
    for o in parts:
        o.data.materials.append(palm_mat)
        for poly in o.data.polygons:
            c = o.matrix_world @ poly.center
            n = poly.normal
            yc = -0.006 + 0.275 * c.z
            to_grip = Vector((-c.x, yc - c.y, 0))
            if to_grip.length > 1e-6 and n.dot(to_grip.normalized()) > 0.45:
                poly.material_index = 1
    # Knuckle guard: a moulded plate over the four MCP knuckles, and pads on the proximal and middle phalanges.
    out_dir = Vector((1, 0.15, 0)).normalized()
    knuckles = [joints[n][0][0] for n in ("index", "middle", "ring", "little")]
    guard_pts = [k + out_dir * (joints[n][1] + 0.0045) for k, n in zip(knuckles, ("index", "middle", "ring", "little"))]
    parts.append(knuckle_guard("guardR", guard_pts, out_dir, armor))
    wrist_dir = (wrist - Vector((0.17, -0.35, -0.24))).normalized()  # pointing from the elbow to the wrist
    return parts, wrist, wrist_dir


def knuckle_guard(name, pts, out, mat):
    """Moulded knuckle armour: a thick, rounded bar through the knuckles with a ridge per knuckle."""
    v = Volume(name, res=0.0017)
    for i in range(len(pts) - 1):
        v.capsule(pts[i], pts[i + 1], 0.0065)
    for p in pts:
        v.ball(p + out * 0.0018, 0.0075)
    o = v.mesh(name, mat, 0.22)
    # Flatten it against the hand: squash along `out` around its centre.
    c = sum(pts, Vector()) / len(pts)
    for vert in o.data.vertices:
        d = vert.co - c
        k = d.dot(out)
        vert.co -= out * (k * 0.35)
    return o


def handguard_curve(y, extra, R=0.030):
    """Around a handguard along +Y whose axis is 4.2 cm above ARM_PALM_L (rig space). psi = 0 at the bottom, positive
    towards +x (the right side)."""
    C = ARM_PALM_L + Vector((0, 0, 0.042))

    def c(psi):
        return C + Vector(((R + extra) * math.sin(psi), y, -(R + extra) * math.cos(psi)))

    return c


def left_hand(mats):
    """Left hand under a handguard (rig space): palm under it, fingers up the right side, thumb up the left."""
    glove, palm_mat, armor = mats["glove"], mats["palm"], mats["armor"]
    C = ARM_PALM_L + Vector((0, 0, 0.042))
    parts = []
    joints = {}
    for name, y in (("index", 0.034), ("middle", 0.012), ("ring", -0.011), ("little", -0.031)):
        lengths, r = FINGERS[name]
        curve = handguard_curve(y, r + 0.0012)
        mcp = handguard_curve(y - 0.004, 0.027)(math.radians(18))
        js = finger_around(curve, mcp, lengths, math.radians(30))
        joints[name] = (js, r)
    # Thumb: up the left side, pointing forward along the handguard.
    th = [handguard_curve(-0.03, 0.030)(math.radians(-62)), handguard_curve(-0.012, 0.016)(math.radians(-88)), handguard_curve(0.012, 0.0125)(math.radians(-104)),
          handguard_curve(0.036, 0.0115)(math.radians(-112)), handguard_curve(0.056, 0.0108)(math.radians(-116))]
    pv = Volume("PalmL")
    pc = handguard_curve(0.0, 0.017)(math.radians(-14))
    pv.ball(pc, 1.0, scale=(0.044, 0.046, 0.016), rot=Quaternion(Vector((0, 1, 0)), math.radians(-14)))
    pv.ball(handguard_curve(-0.03, 0.02)(math.radians(-40)), 1.0, scale=(0.022, 0.02, 0.017))
    pv.ball(handguard_curve(0.03, 0.02)(math.radians(-6)), 1.0, scale=(0.02, 0.018, 0.016))
    wrist = C + Vector((-0.068, -0.052, -0.05))
    for name in ("index", "middle", "ring", "little"):
        js, r = joints[name]
        pv.capsule(pc.lerp(wrist, 0.25) + Vector((0, js[0].y - C.y, 0)) * 0.6, js[0], r * 0.92)
    pv.ball(wrist + Vector((0.01, 0.012, 0.006)), 1.0, scale=(0.026, 0.022, 0.021))
    pv.capsule(th[0], th[1], 0.0135)
    parts.append(pv.mesh("palmL", glove, 0.14))
    for name in ("index", "middle", "ring", "little"):
        js, r = joints[name]
        parts.append(skin_chain(name + "L", js, [r * 1.08, r, r * 0.94, r * 0.86], glove))
    parts.append(skin_chain("thumbL", th[1:], [0.0135, 0.0123, 0.0113, 0.0101], glove))
    for o in parts:
        o.data.materials.append(palm_mat)
        for poly in o.data.polygons:
            c = o.matrix_world @ poly.center
            to_axis = Vector((C.x - c.x, 0, C.z - c.z))
            if to_axis.length > 1e-6 and poly.normal.dot(to_axis.normalized()) > 0.45:
                poly.material_index = 1
    # Knuckle guard and finger pads, outward from the handguard axis.
    knuckles = [joints[n][0][0] for n in ("index", "middle", "ring", "little")]
    out = (sum(knuckles, Vector()) / 4 - Vector((C.x, sum(k.y for k in knuckles) / 4, C.z))).normalized()
    guard = [k + out * (joints[n][1] + 0.0045) for k, n in zip(knuckles, ("index", "middle", "ring", "little"))]
    parts.append(knuckle_guard("guardL", guard, out, armor))
    elbow = C + Vector((-0.2, -0.23, -0.26))
    return parts, wrist, (wrist - elbow).normalized(), elbow


# ---- cuff, strap, sleeve ----------------------------------------------------------------------------------------------

def gauntlet(name, wrist, d, up, mats, length=0.05):
    """Glove cuff up the wrist, a wrist strap with a velcro tab across the back."""
    glove, strap, velcro = mats["glove"], mats["strap"], mats["velcro"]
    a = wrist + d * 0.006
    b = wrist - d * length
    cuff = tube(name + "Cuff", [a + d * 0.004, a, a.lerp(b, 0.5), b], [0.0255, 0.0272, 0.0292, 0.0312], glove, segs=22, squash=0.78, up=up)
    s0 = wrist - d * 0.018
    s1 = wrist - d * 0.040
    band = tube(name + "Strap", [s0, s0.lerp(s1, 0.5), s1], [0.0312, 0.0318, 0.0326], strap, segs=22, squash=0.78, up=up)
    # Velcro tab on the back of the wrist.
    x, y, _ = frame_for(d, up)
    centre = wrist.lerp(wrist - d * 0.029, 1.0) + y * 0.0262
    tab = tube(name + "Tab", [centre + x * 0.018, centre - x * 0.018], [0.0105, 0.0105], velcro, segs=8, squash=0.3, up=d)
    return [cuff, band, tab]


def arm_collider(name, pts, radii):
    o = tube(name, pts, radii, bpy.data.materials[0], segs=16, cap_end=True)
    col = o.modifiers.new("Collision", "COLLISION")
    o.collision.thickness_outer = 0.0025
    o.collision.cloth_friction = 6.0
    return o


def sleeve(name, wrist, elbow, shoulder, d, up, mat, collider):
    """Combat-shirt sleeve as cloth: built pulled down over the glove cuff, then pushed up the forearm by a hook on its
    end ring while the top is pinned; the extra length piles up in folds at the wrist."""
    segs = 28
    path_len = 0.30
    start = wrist - d * 0.035  # final cuff position (just above the glove cuff)
    push = 0.06  # extra length at rest, pushed back during the sim
    axis_pts = []
    n_rings = 34
    far = elbow + (shoulder - elbow) * 0.25
    for i in range(n_rings):
        t = i / (n_rings - 1)
        # From the over-extended end (down over the hand) to beyond the elbow.
        p0 = start + d * push
        axis_pts.append(p0.lerp(start, min(1.0, t * 4)) if t < 0.25 else start.lerp(far, (t - 0.25) / 0.75))
    radii = []
    for i, p in enumerate(axis_pts):
        t = i / (n_rings - 1)
        radii.append(0.041 + 0.016 * max(0.0, t - 0.25))
    o = tube(name, axis_pts, radii, mat, segs=segs, squash=0.86, up=up)
    # Pin groups: the end ring (hooked) and the top three rings.
    pin = o.vertex_groups.new(name="pin")
    end = o.vertex_groups.new(name="end")
    for v in o.data.vertices:
        ring = v.index // segs
        if ring == 0:
            pin.add([v.index], 1.0, "REPLACE")
            end.add([v.index], 1.0, "REPLACE")
        elif ring >= n_rings - 3:
            pin.add([v.index], 1.0, "REPLACE")
    # Hook on the end ring, animated back up the arm.
    empty = link(bpy.data.objects.new(name + "Hook", None))
    empty.location = axis_pts[0]
    hook = o.modifiers.new("Hook", "HOOK")
    hook.object = empty
    hook.vertex_group = "end"
    hook.center = axis_pts[0]
    bpy.context.view_layer.update()
    hook.matrix_inverse = empty.matrix_world.inverted()
    empty.keyframe_insert("location", frame=1)
    empty.location = Vector(axis_pts[0]) - d * push
    empty.keyframe_insert("location", frame=28)
    cloth = o.modifiers.new("Cloth", "CLOTH")
    cs = cloth.settings
    cs.quality = 8
    cs.mass = 0.12
    cs.tension_stiffness = 12
    cs.compression_stiffness = 12
    cs.shear_stiffness = 6
    cs.bending_stiffness = 0.25
    cs.air_damping = 2.0
    cs.vertex_group_mass = "pin"
    cs.shrink_min = 0.0
    cs.effector_weights.gravity = 0.35
    cc = cloth.collision_settings
    cc.distance_min = 0.0022
    cc.use_self_collision = True
    cc.self_distance_min = 0.0018
    cc.collision_quality = 3
    cloth.point_cache.frame_start = 1
    cloth.point_cache.frame_end = 40
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = 40
    for f in range(1, 41):
        scene.frame_set(f)
    # Freeze the simulated shape (the whole stack at the last frame) into the mesh.
    deps = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(deps), preserve_all_data_layers=True, depsgraph=deps)
    o.modifiers.clear()
    o.data = me
    bpy.data.objects.remove(empty)
    o.vertex_groups.clear()
    scene.frame_set(1)
    # Calm the sim's high-frequency noise (keeps the folds, loses the crinkle) before thickening.
    sm = o.modifiers.new("Smooth", "SMOOTH")
    sm.factor = 0.6
    sm.iterations = 6
    apply_mods(o)
    # Thickness and a turned-back cuff hem.
    sol = o.modifiers.new("Solid", "SOLIDIFY")
    sol.thickness = 0.0022
    sol.offset = 1.0
    apply_mods(o)
    smooth(o)
    # A hemmed cuff covering the cut edge: a short, slightly flared band with a stitched lip.
    x, y, _ = frame_for(d, up)
    c0 = start + d * 0.004
    c1 = start - d * 0.026
    hem = tube(name + "Hem", [c0 + d * 0.002, c0, c0.lerp(c1, 0.5), c1, c1 - d * 0.003], [0.036, 0.043, 0.044, 0.045, 0.041], mat, segs=28, squash=0.86, up=up)
    return join([o, hem], name)


# ---- baking -----------------------------------------------------------------------------------------------------------

# Per material: (bump strength, distance, layers[(kind, scale, detail, weight)], roughness base, roughness spread)
DETAIL = {
    "Glove": (0.25, 0.0008, [("noise", 420, 6, 0.6), ("voronoi", 260, 0, 0.4), ("waveb", 90, 0, 0.12)], 0.5, 0.14),
    "GlovePalm": (0.9, 0.0012, [("voronoi", 380, 0, 1.0), ("noise", 120, 4, 0.4)], 0.82, 0.08),
    "GloveArmor": (0.35, 0.001, [("noise", 60, 3, 0.6), ("wave", 140, 0, 0.3)], 0.3, 0.1),
    "Strap": (0.7, 0.0014, [("wave", 600, 0, 1.0), ("noise", 200, 2, 0.2)], 0.7, 0.08),
    "Velcro": (1.0, 0.001, [("noise", 900, 2, 1.0)], 0.9, 0.05),
    "Sleeve": (0.5, 0.0012, [("wave", 900, 0, 0.3), ("waveb", 900, 0, 0.3), ("wave", 160, 0, 0.22), ("waveb", 160, 0, 0.22), ("noise", 18, 3, 0.45)], 0.84, 0.06),
}


def _detail_nodes(nt, layers):
    tc = nt.nodes.new("ShaderNodeTexCoord")
    nodes = [tc]
    total = None
    for kind, scale, extra, weight in layers:
        if kind == "noise":
            t = nt.nodes.new("ShaderNodeTexNoise")
            t.inputs["Scale"].default_value = scale
            t.inputs["Detail"].default_value = extra
            out = t.outputs["Fac"]
        elif kind == "voronoi":
            t = nt.nodes.new("ShaderNodeTexVoronoi")
            t.feature = "DISTANCE_TO_EDGE"
            t.inputs["Scale"].default_value = scale
            out = t.outputs["Distance"]
        else:
            t = nt.nodes.new("ShaderNodeTexWave")
            t.wave_type = "BANDS"
            t.bands_direction = "X" if kind == "wave" else "Z"
            t.inputs["Scale"].default_value = scale
            t.inputs["Distortion"].default_value = 1.5
            out = t.outputs["Fac"]
        nt.links.new(tc.outputs["Object"], t.inputs["Vector"])
        mul = nt.nodes.new("ShaderNodeMath")
        mul.operation = "MULTIPLY"
        mul.inputs[1].default_value = weight
        nt.links.new(out, mul.inputs[0])
        nodes += [t, mul]
        if total is None:
            total = mul.outputs[0]
        else:
            addn = nt.nodes.new("ShaderNodeMath")
            addn.operation = "ADD"
            nt.links.new(total, addn.inputs[0])
            nt.links.new(mul.outputs[0], addn.inputs[1])
            total = addn.outputs[0]
            nodes.append(addn)
    return nodes, total


def gltf_output_group():
    ng = bpy.data.node_groups.get("glTF Material Output")
    if ng:
        return ng
    ng = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
    ng.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    ng.nodes.new("NodeGroupInput")
    return ng


def bake_maps(meshes):
    """Shared atlas: tangent normals from procedural bump, roughness from procedural variation, and AO."""
    bpy.ops.object.select_all(action="DESELECT")
    for m in meshes:
        m.select_set(True)
        if not m.data.uv_layers:
            m.data.uv_layers.new(name="UVMap")
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.003, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(margin=0.003, rotate=True)
    bpy.ops.object.mode_set(mode="OBJECT")

    def image(name, data=True):
        img = bpy.data.images.new(name, BAKE_SIZE, BAKE_SIZE, alpha=False, float_buffer=False, is_data=data)
        img.colorspace_settings.name = "Non-Color"
        return img

    normal_img = image("ArmsNormal")
    normal_img.generated_color = (0.5, 0.5, 1.0, 1.0)
    rough_img = image("ArmsRough")
    ao_img = image("ArmsAO")
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.render.bake.margin = 6
    scene.render.bake.use_clear = True
    mats = {mat for m in meshes for mat in m.data.materials}
    temp = {}
    for mat in mats:
        nt = mat.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        strength, dist, layers, rbase, rspread = DETAIL.get(mat.name, (0.3, 0.001, [("noise", 120, 4, 1.0)], 0.6, 0.1))
        nodes, total = _detail_nodes(nt, layers)
        bmp = nt.nodes.new("ShaderNodeBump")
        bmp.inputs["Strength"].default_value = strength
        bmp.inputs["Distance"].default_value = dist
        nt.links.new(total, bmp.inputs["Height"])
        nt.links.new(bmp.outputs["Normal"], bsdf.inputs["Normal"])
        # Roughness variation around the base value (scuffs are glossier on leather, fuzzier on fabric).
        mr = nt.nodes.new("ShaderNodeMapRange")
        mr.inputs["From Min"].default_value = 0.0
        mr.inputs["From Max"].default_value = 1.2
        mr.inputs["To Min"].default_value = max(0.05, rbase - rspread)
        mr.inputs["To Max"].default_value = min(1.0, rbase + rspread)
        nt.links.new(total, mr.inputs["Value"])
        nt.links.new(mr.outputs["Result"], bsdf.inputs["Roughness"])
        tex = nt.nodes.new("ShaderNodeTexImage")
        nt.nodes.active = tex
        temp[mat] = (nodes + [bmp, mr], tex)
    bpy.ops.object.select_all(action="DESELECT")
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    for img, kind, samples in ((normal_img, "NORMAL", 2), (rough_img, "ROUGHNESS", 2), (ao_img, "AO", 48)):
        for mat, (_, tex) in temp.items():
            tex.image = img
            mat.node_tree.nodes.active = tex
        scene.cycles.samples = samples
        if kind == "NORMAL":
            bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT", margin=6, use_clear=True)
        else:
            bpy.ops.object.bake(type=kind, margin=6, use_clear=True)
        img.pack()
        if PREVIEW:
            img.save(filepath=str(Path(PREVIEW) / f"arms_{kind.lower()}.png"))
    # Rewire: baked normal map, roughness from the baked image's G channel, AO into the glTF occlusion slot.
    ng = gltf_output_group()
    for mat, (nodes, tex) in temp.items():
        nt = mat.node_tree
        for n in nodes:
            nt.nodes.remove(n)
        nt.nodes.remove(tex)
        bsdf = nt.nodes.get("Principled BSDF")
        tn = nt.nodes.new("ShaderNodeTexImage")
        tn.image = normal_img
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
        tr = nt.nodes.new("ShaderNodeTexImage")
        tr.image = rough_img
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(tr.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        ta = nt.nodes.new("ShaderNodeTexImage")
        ta.image = ao_img
        sep2 = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(ta.outputs["Color"], sep2.inputs["Color"])
        g = nt.nodes.new("ShaderNodeGroup")
        g.node_tree = ng
        nt.links.new(sep2.outputs["Red"], g.inputs["Occlusion"])
    scene.render.engine = "BLENDER_WORKBENCH"


# ---- build ------------------------------------------------------------------------------------------------------------

def build_arms():
    clear_scene()
    mats = {
        "glove": material("Glove", (0.022, 0.022, 0.024), rough=0.48, spec=0.5),
        "palm": material("GlovePalm", (0.03, 0.03, 0.031), rough=0.82, spec=0.3),
        "armor": material("GloveArmor", (0.028, 0.029, 0.031), rough=0.3, spec=0.55),
        "strap": material("Strap", (0.02, 0.02, 0.021), rough=0.7, spec=0.35),
        "velcro": material("Velcro", (0.026, 0.026, 0.027), rough=0.9, spec=0.2),
        "sleeve": material("Sleeve", (0.0137, 0.0176, 0.0331), rough=0.84, spec=0.3),  # navy ripstop, #1f2433
    }
    collider_mat = material("Collider", (1, 0, 1))
    up = Vector((0, 0, 1))

    # Right arm: hand in gun space, moved to the palm point.
    parts, wrist, d = right_hand(mats)
    for o in parts:
        o.location += ARM_PALM_R
    wrist = wrist + ARM_PALM_R
    elbow = ARM_PALM_R + Vector((0.17, -0.35, -0.24))
    shoulder = elbow + Vector((0.08, -0.22, -0.12))
    d = (wrist - elbow).normalized()
    cuff = gauntlet("R", wrist, d, up, mats)
    collider = arm_collider("colR", [wrist + d * 0.03, wrist - d * 0.05, elbow, shoulder], [0.03, 0.033, 0.045, 0.05])
    collider.data.materials[0] = collider_mat
    sl = sleeve("sleeveR", wrist, elbow, shoulder, d, up, mats["sleeve"], collider)
    bpy.data.objects.remove(collider)
    apply_all(parts + cuff)
    arm_r = join(parts + cuff + [sl], "ArmR")

    # Left arm: already in rig space.
    parts, wrist, d, elbow = left_hand(mats)
    shoulder = elbow + Vector((-0.06, -0.24, -0.1))
    cuff = gauntlet("L", wrist, d, up, mats)
    collider = arm_collider("colL", [wrist + d * 0.03, wrist - d * 0.05, elbow, shoulder], [0.03, 0.033, 0.045, 0.05])
    collider.data.materials[0] = collider_mat
    sl = sleeve("sleeveL", wrist, elbow, shoulder, d, up, mats["sleeve"], collider)
    bpy.data.objects.remove(collider)
    apply_all(parts + cuff)
    arm_l = join(parts + cuff + [sl], "ArmL")

    for o in (arm_r, arm_l):
        activate(o)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        # Drop the collider material slot if it slipped in.
        for i, m in enumerate(list(o.data.materials)):
            if m and m.name == "Collider":
                o.data.materials.pop(index=i)
                break
    for o in (arm_r, arm_l):
        o.data.validate(clean_customdata=False)
    bake_maps([arm_r, arm_l])
    print("ARMS tris", tris(arm_r) + tris(arm_l), [(o.name, tris(o)) for o in (arm_r, arm_l)])
    return [arm_r, arm_l]


def apply_all(objs):
    for o in objs:
        activate(o)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def export(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    OUT.mkdir(parents=True, exist_ok=True)
    path = str(OUT / "arms.glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_image_format="JPEG",
        export_jpeg_quality=88,
        export_normals=True,
        export_texcoords=True,
        export_vertex_color="NONE",
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_lights=False,
        export_cameras=False,
        export_extras=False,
    )
    print(f"EXPORTED {path}")


if __name__ == "__main__":
    arms = build_arms()
    export(arms)
