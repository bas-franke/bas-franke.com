"""
SWAT operator, part 1 of 5: the armature, an athletic body and the navy combat uniform.

    blender --background --factory-startup --python swat_body.py -- [out.blend] [--preview <dir>] [--fast]

Writes out/swat_body.blend (next to this script by default) for the other SWAT workers (head, torso, limbs) to fit
their gear to, and for build_swat.py to assemble. Reference: images/5.webp ("SWAT / character model reference").

Modelling, in order:
  1. Armature `Survivor`: the shared skeleton from build_zombies.py (contract bone names), scaled by S.
  2. Body: anatomical forms as metaball ellipsoids and capsules (pelvis, abdomen, rib cage, pecs, lats, traps, deltoids,
     arms, glutes, thighs, calves, feet, skull, jaw, brow, cheekbones, nose, ears), polygonised, voxel-remeshed so the
     joins fillet, smoothed, then decimated to an export budget. Hands are a separate fine metaball family with a palm,
     thenar pad and five three-phalanx fingers in a relaxed curl, joined on. Eye sockets are carved and eyeballs added
     so the face reads through the HEAD worker's goggles.
  3. Uniform: a loose garment volume (simpler, fuller forms than the body) is cut into a combat shirt and trousers,
     draped over the body with Blender's cloth simulation (gravity, pinned at the shoulders, waist, cuffs and boot tops),
     then given compression folds at the elbows, knees, crotch and waist, blousing above the boots, sunken seams, a mock
     collar, cuffs with hook-and-loop tabs, shoulder pockets with flaps and velcro panels, thigh cargo pockets with
     flaps and pleats, and knee seams.
     That detailed uniform is the HIGH bake source (Body_Shirt_high / Body_Trousers_high, obj["high"] = True,
     obj["high_of"] = the low name). The exported LOW uniform is a QuadriFlow quad cage of the same garment volume
     (~4.9k tris for shirt + trousers), cut with planar cuts, shrink-wrapped onto the draped cloth, lifted onto the
     pockets / flaps / collar so the silhouette and the short bake rays carry them, with the sleeves gathered into the
     glove cuffs (they end inside the skin 4 cm above the wrist), the shirt tail tucked inside the trouser waist and
     the hems bloused over the boot collars.
  4. Weights: heat-map automatic weights on the body, copied to the uniform by nearest-surface data transfer, then
     relaxed round the shoulders, elbows, hips and knees so raised arms roll the cloth instead of creasing it.
Collection `Body`: Survivor (armature), Body_Skin (weight source, not exported), Body_Eyes, Body_Shirt,
Body_Trousers, plus the two _high bake sources. Materials: Body_Skin, Body_Eyes, Body_Uniform (navy ripstop),
Body_Velcro.
"""

import importlib.util
import math
import random
import sys
import time
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector, noise

HERE = Path(__file__).resolve().parent
BLENDER_DIR = HERE.parent
_spec = importlib.util.spec_from_file_location("bz", BLENDER_DIR / "build_zombies.py")
bz = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bz)

ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
FAST = "--fast" in ARGV
NODRAPE = "--nodrape" in ARGV
PREVIEW = None
if "--preview" in ARGV:
    PREVIEW = Path(ARGV[ARGV.index("--preview") + 1])
    PREVIEW.mkdir(parents=True, exist_ok=True)
POS = [a for i, a in enumerate(ARGV) if not a.startswith("--") and (i == 0 or ARGV[i - 1] != "--preview")]
OUT_BLEND = Path(POS[0]) if POS else HERE / "out" / "swat_body.blend"
REF = Path(r"C:\Users\buunn\AppData\Local\Temp\claude\C--Projects-bas-franke-com\5cfa0a1c-4b50-4c12-9ad4-13780799ba35\images\5.webp")

# The shared rig is ~1.76 m to the top of the head bone; the operator is a little taller (crown ~1.83 m).
S = 1.02
T0 = time.time()


def log(msg):
    print(f"[swat_body {time.time() - T0:6.1f}s] {msg}", flush=True)


def P(x, y, z):
    return Vector((x * S, y * S, z * S))


link, activate, apply_all, smooth, tris = bz.link, bz.activate, bz.apply_all, bz.smooth, bz.tris


# ---- materials --------------------------------------------------------------------------------------------------------

def materials():
    m = bz.material
    return {
        "skin": m("Body_Skin", (0.42, 0.29, 0.23), rough=0.55, spec=0.4),
        "eyes": m("Body_Eyes", (0.75, 0.74, 0.72), rough=0.08, spec=0.6),
        "iris": m("Body_Iris", (0.05, 0.07, 0.08), rough=0.08, spec=0.6),
        # Dark navy ripstop, matching the reference's shirt and trousers (~#1f2433).
        "uniform": m("Body_Uniform", (0.016, 0.019, 0.034), rough=0.82, spec=0.35),
        "velcro": m("Body_Velcro", (0.012, 0.014, 0.024), rough=0.95, spec=0.2),
    }


# ---- metaballs --------------------------------------------------------------------------------------------------------

def meta_family(name, resolution):
    mb = bpy.data.metaballs.new(name)
    mb.resolution = resolution
    mb.render_resolution = resolution
    mb.threshold = THRESHOLD
    obj = link(bpy.data.objects.new(name, mb))
    return obj


THRESHOLD = 0.6


def influence(visible, stiff):
    """Element radius whose isolated surface has radius `visible` (Blender's field is stiff * (1 - (r/R)^2)^3)."""
    return visible / math.sqrt(1.0 - (THRESHOLD / stiff) ** (1.0 / 3.0))


def ball(mobj, center, radius, size=(1, 1, 1), rot=None, stiff=2.0, negative=False):
    """An ellipsoid element whose isolated surface has half-extents radius * size."""
    el = mobj.data.elements.new(type="ELLIPSOID")
    el.co = Vector(center)
    el.radius = influence(radius, stiff)
    el.size_x, el.size_y, el.size_z = size
    el.stiffness = stiff
    el.use_negative = negative
    if rot is not None:
        el.rotation = rot
    return el


def capsule(mobj, a, b, radius, stiff=2.0, flat=1.0):
    """A capsule from a to b (radius at both ends). `flat` < 1 squashes it front to back."""
    a, b = Vector(a), Vector(b)
    d = b - a
    el = mobj.data.elements.new(type="CAPSULE")
    el.co = (a + b) / 2
    el.radius = influence(radius, stiff)
    el.size_x = d.length / 2
    el.stiffness = stiff
    q = Vector((1, 0, 0)).rotation_difference(d.normalized())
    el.rotation = q
    return el


def cone_capsule(mobj, a, b, ra, rb, n=4, stiff=2.0):
    """A tapering limb: several short capsules with radii going from ra to rb."""
    a, b = Vector(a), Vector(b)
    for i in range(n):
        t0, t1 = i / n, (i + 1) / n
        r = ra + (rb - ra) * (i + 0.5) / n
        capsule(mobj, a.lerp(b, t0), a.lerp(b, t1), r, stiff=stiff)


def to_mesh(mobj, name, voxel=None, smooth_iter=6, smooth_factor=0.6):
    """Polygonises a metaball family, optionally voxel-remeshes it, smooths it and returns the mesh object."""
    bpy.context.view_layer.update()
    activate(mobj)
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = name
    if voxel:
        r = obj.modifiers.new("Remesh", "REMESH")
        r.mode = "VOXEL"
        r.voxel_size = voxel
        r.adaptivity = 0.0
        obj = apply_all(obj)
    if smooth_iter:
        sm = obj.modifiers.new("Smooth", "SMOOTH")
        sm.factor = smooth_factor
        sm.iterations = smooth_iter
        obj = apply_all(obj)
    obj.name = name
    return smooth(obj)


def decimate_to(obj, target_tris):
    t = tris(obj)
    if t > target_tris:
        obj = bz.decimate(obj, target_tris / t)
    return obj


# ---- body -------------------------------------------------------------------------------------------------------------

FAMILIES = ("torso", "armL", "armR", "legL", "legR")


def body_forms(fam, k=1.0, garment=False):
    """Anatomical forms of an athletic 1.83 m man, A-posed on the shared rig, as separate metaball families (torso, each
    arm, each leg) so limbs never blob into each other; the families are unioned by a voxel remesh afterwards.
    k inflates radii; `garment` drops the muscle definition and adds the slack cloth bridges (armpits, seat, back)."""
    R = lambda r: r * S * k  # noqa: E731
    g = 1 if garment else 0
    t = fam["torso"]

    # Pelvis, abdomen, waist, rib cage, shoulder girdle: a V-shaped torso.
    ball(t, P(0, -0.012, 0.93), R(0.14 + 0.018 * g), (1.1, 0.8, 0.8))
    ball(t, P(0, 0.004, 1.02), R(0.13 + 0.02 * g), (1.08, 0.8, 0.75))
    ball(t, P(0, 0.008, 1.1), R(0.125 + 0.024 * g), (1.08, 0.8, 0.75))
    ball(t, P(0, 0.008, 1.2), R(0.15 + 0.022 * g), (1.1, 0.8, 0.8))
    ball(t, P(0, 0.012, 1.29), R(0.168 + 0.024 * g), (1.15, 0.8, 0.75))
    ball(t, P(0, -0.006, 1.375), R(0.172 + 0.024 * g), (1.22, 0.71, 0.52))
    if not garment:
        for x in (-1, 1):
            ball(t, P(x * 0.08, 0.075, 1.31), R(0.075), (1.3, 0.55, 0.85))  # pecs
            ball(t, P(x * 0.115, 0.02, 1.07), R(0.055), (0.8, 0.8, 1.3))  # obliques
            ball(t, P(x * 0.145, -0.035, 1.24), R(0.07), (0.85, 0.75, 1.35))  # lats
            ball(t, P(x * 0.08, -0.075, 1.32), R(0.055), (1.0, 0.45, 1.0))  # shoulder blades
            ball(t, P(x * 0.09, -0.015, 1.45), R(0.048), (1.6, 0.85, 0.6))  # traps
            ball(t, P(x * 0.072, -0.065, 0.92), R(0.078), (0.95, 0.75, 1.0))  # glutes
        for z in (1.12, 1.18, 1.235):
            for x in (-1, 1):
                ball(t, P(x * 0.033, 0.088, z), R(0.026), (1.2, 0.55, 0.9))  # abdominals
    else:
        for x in (-1, 1):
            ball(t, P(x * 0.09, -0.015, 1.45), R(0.055), (1.6, 0.9, 0.65))  # over the traps
            ball(t, P(x * 0.075, -0.06, 0.93), R(0.085), (0.95, 0.8, 1.0))  # seat
            ball(t, P(x * 0.083, 0.068, 1.3), R(0.074), (1.3, 0.56, 0.86))  # over the pecs
            ball(t, P(x * 0.15, -0.03, 1.24), R(0.07), (0.85, 0.8, 1.35))  # over the lats
    # Neck.
    capsule(t, P(0, -0.004, 1.43), P(0, 0.008, 1.6), R(0.064 + 0.01 * g))
    if not garment:
        for x in (-1, 1):
            capsule(t, P(x * 0.04, 0.03, 1.47), P(x * 0.03, 0.032, 1.6), R(0.019))  # sternocleidomastoid
            capsule(t, P(x * 0.03, -0.035, 1.47), P(x * 0.06, -0.02, 1.43), R(0.03))  # neck into the traps

    # Arms (A-pose along the rig bones).
    for x, side in ((-1, "L"), (1, "R")):
        a = fam["arm" + side]
        sh = P(x * 0.17, 0.0, 1.42)
        el = P(x * 0.33, 0.0, 1.17)
        wr = P(x * 0.44, 0.03, 0.94)
        ball(a, P(x * (0.205 + 0.002 * g), 0.0, 1.405), R(0.07 + 0.005 * g), (1.0, 1.1, 0.95))  # deltoid / shoulder seam
        cone_capsule(a, sh, el, R(0.06 + 0.007 * g), R(0.046 + 0.009 * g), n=4)
        if not garment:
            ball(a, sh.lerp(el, 0.5) + Vector((0, 0.022, 0)), R(0.038), (1.0, 1.0, 1.6))  # biceps
            ball(a, sh.lerp(el, 0.42) + Vector((0, -0.026, 0)), R(0.04), (1.0, 1.0, 1.7))  # triceps
            ball(a, el.lerp(wr, 0.25) + Vector((0, 0.006, 0)), R(0.041), (1.0, 1.0, 1.5))  # forearm mass
        cone_capsule(a, el, wr, R(0.047 + 0.008 * g), R(0.031 + 0.01 * g), n=4)

    # Legs.
    for x, side in ((-1, "L"), (1, "R")):
        lg = fam["leg" + side]
        hip = P(x * 0.098, 0.0, 0.95)
        kn = P(x * 0.11, 0.01, 0.51)
        an = P(x * 0.12, -0.02, 0.1)
        cone_capsule(lg, hip, kn, R(0.094 + 0.012 * g), R(0.06 + 0.02 * g), n=5)
        if not garment:
            ball(lg, hip.lerp(kn, 0.4) + Vector((0, 0.028, 0)), R(0.06), (1.0, 1.0, 1.8))  # quads
            ball(lg, P(x * 0.11, 0.043, 0.52), R(0.033), (1.0, 0.8, 1.0))  # kneecap
            ball(lg, kn.lerp(an, 0.3) + Vector((0, -0.028, 0)), R(0.047), (1.0, 1.0, 1.6))  # calf
            capsule(lg, P(x * 0.12, -0.03, 0.04), P(x * 0.12, 0.14, 0.025), R(0.03))  # foot
            ball(lg, P(x * 0.12, -0.02, 0.065), R(0.036), (0.9, 1.0, 0.9))  # heel / ankle
        cone_capsule(lg, kn, an, R(0.056 + 0.02 * g), R(0.035 + 0.022 * g), n=5)


def families(prefix, res):
    return {f: meta_family(f"{prefix}{f}", res) for f in FAMILIES}


def leg_gap(z):
    """Half the gap between the legs at height z (world, scaled): closed at the crotch, ~2.5 cm at the knees."""
    zs = z / S
    pts = [(0.86, 0.0), (0.82, 0.008), (0.7, 0.018), (0.55, 0.026), (0.0, 0.03)]
    for (z0, g0), (z1, g1) in zip(pts[:-1], pts[1:]):
        if z1 <= zs <= z0:
            t = (z0 - zs) / (z0 - z1)
            return (g0 + (g1 - g0) * t) * S
    return 0.0 if zs > 0.86 else 0.03 * S


def clamp_leg(obj, side):
    """Pushes a leg's inner surface out of the other leg's half so the legs stay apart below the crotch (the metaball
    capsules of a limb reinforce each other and swell past their nominal radius)."""
    for v in obj.data.vertices:
        g = leg_gap(v.co.z)
        if g <= 0:
            continue
        if side < 0 and v.co.x > -g:
            v.co.x = -g
        elif side > 0 and v.co.x < g:
            v.co.x = g


def union_mesh(fams, name, voxel, smooth_iter, smooth_factor, extra=()):
    """Polygonises each family, joins them (plus `extra` meshes) and voxel-remeshes the lot into one closed surface."""
    parts = []
    for k, m in fams.items():
        part = to_mesh(m, f"{name}_{k}", voxel=None, smooth_iter=0)
        if k in ("legL", "legR"):
            clamp_leg(part, -1 if k == "legL" else 1)
        parts.append(part)
    parts += list(extra)
    obj = bz.join(parts, name)
    r = obj.modifiers.new("Remesh", "REMESH")
    r.mode = "VOXEL"
    r.voxel_size = voxel
    r.adaptivity = 0.0
    obj = apply_all(obj)
    if smooth_iter:
        sm = obj.modifiers.new("Smooth", "SMOOTH")
        sm.factor = smooth_factor
        sm.iterations = smooth_iter
        obj = apply_all(obj)
    obj.name = obj.data.name = name
    return smooth(obj)


def head_forms(m):
    """Base volumes only: cranium, face mass, jaw, chin, ears. Features are sculpted afterwards (sculpt_face)."""
    ball(m, P(0, -0.012, 1.708), S * 0.092, (0.83, 1.04, 1.02))  # cranium
    ball(m, P(0, 0.022, 1.668), S * 0.077, (0.86, 1.0, 0.98))  # face mass
    ball(m, P(0, 0.04, 1.613), S * 0.052, (1.06, 0.95, 0.7))  # jaw
    ball(m, P(0, 0.07, 1.596), S * 0.026, (1.2, 0.9, 0.9))  # chin
    for x in (-1, 1):
        capsule(m, P(x * 0.056, 0.008, 1.63), P(x * 0.024, 0.068, 1.597), S * 0.018)  # jaw line
        ball(m, P(x * 0.074, -0.006, 1.674), S * 0.021, (0.4, 0.85, 1.35))  # ear


def gauss3(co, c, r):
    d = (co - c) / r
    return math.exp(-d.length_squared)


def sculpt_face(head):
    """Scripted sculpt strokes on the head: brow ridge, eye sockets, nose (bridge, tip, wings), cheekbones, temples,
    nasolabial folds, lips and mouth line, chin, jaw angle. Offsets are along +Y (forward) or the vertex normal."""
    F = lambda x, y, z: Vector((x * S, y * S, z * S))  # noqa: E731
    eyes = [F(x * 0.031, 0.0, 1.692) for x in (-1, 1)]

    def fn(co, n):
        if co.z < 1.57 * S or co.z > 1.78 * S:
            return None
        front = max(0.0, min(1.0, (n.y - 0.15) / 0.55))
        off = Vector((0, 0, 0))
        x, z = co.x / S, co.z / S
        # Nose: a ridge on the midline, rising from the bridge to the tip, falling back under it.
        if co.y > 0:
            prof = 0.0
            if 1.648 < z < 1.712:
                t = (1.712 - z) / (1.712 - 1.656)
                prof = 0.032 * min(1.0, t) ** 1.2 if z > 1.656 else 0.032 * max(0.0, 1 - (1.656 - z) / 0.01)
            width = 0.012 + 0.012 * max(0.0, (1.69 - z) / 0.04)
            off.y += prof * math.exp(-(x / width) ** 2) * front
            # Nose wings.
            for sx in (-1, 1):
                off.y += 0.008 * gauss3(co, F(sx * 0.016, 0.1, 1.652), 0.011) * front
        # Eye sockets: dents under the brow where the eyeballs sit.
        for e in eyes:
            off.y -= 0.016 * gauss3(Vector((co.x, 0, co.z)), Vector((e.x, 0, e.z)), 0.02 * S) * front
        # Brow ridge: a band above the sockets.
        for sx in (-1, 1):
            off.y += 0.012 * gauss3(Vector((co.x, 0, co.z)), F(sx * 0.03, 0, 1.714), 0.02) * front
        # Cheekbones, temples, cheek hollows, nasolabial folds.
        for sx in (-1, 1):
            off += n * 0.006 * gauss3(co, F(sx * 0.05, 0.072, 1.67), 0.018)
            off -= n * 0.005 * gauss3(co, F(sx * 0.07, 0.04, 1.712), 0.02)
            off -= n * 0.004 * gauss3(co, F(sx * 0.048, 0.07, 1.632), 0.014)
            off -= n * 0.003 * gauss3(co, F(sx * 0.026, 0.096, 1.638), 0.007)
        # Lips and the mouth line; chin boss.
        if co.y > 0:
            off.y += 0.008 * gauss3(Vector((co.x * 0.55, 0, co.z)), F(0, 0, 1.627), 0.009) * front
            off.y += 0.006 * gauss3(Vector((co.x * 0.6, 0, co.z)), F(0, 0, 1.611), 0.008) * front
            off.y -= 0.004 * gauss3(Vector((co.x * 0.5, 0, co.z)), F(0, 0, 1.619), 0.003) * front
            off.y += 0.006 * gauss3(Vector((co.x * 0.8, 0, co.z)), F(0, 0, 1.592), 0.014) * front
        # Jaw angle.
        for sx in (-1, 1):
            off += n * 0.004 * gauss3(co, F(sx * 0.058, 0.01, 1.615), 0.014)
        return off

    bz.push_verts(head, fn)
    sm = head.modifiers.new("Smooth", "SMOOTH")
    sm.factor = 0.6
    sm.iterations = 8
    head = apply_all(head)
    return smooth(head)


def hand_forms(fams, x):
    """A relaxed hand: palm family plus one family per finger, so the fingers never blob together."""
    m = fams[0]
    wr = P(x * 0.44, 0.03, 0.94)
    tip = P(x * 0.48, 0.05, 0.8)
    down = (tip - wr).normalized()
    inward = Vector((-x, 0, 0))
    inward = (inward - down * inward.dot(down)).normalized()  # palm normal
    fwd = down.cross(inward).normalized() * (1 if x > 0 else -1)
    if fwd.y < 0:
        fwd = -fwd
    # Palm: a flattened box-ish ellipsoid.
    pc = wr + down * 0.05
    rot = Matrix((fwd, inward, down)).transposed().to_quaternion()
    ball(m, pc, 0.047 * S, (0.92, 0.36, 1.08), rot=rot, stiff=2.4)
    ball(m, wr + down * 0.012, 0.03 * S, (1.0, 0.7, 0.6), rot=rot, stiff=2.0)  # wrist
    ball(m, pc + fwd * 0.03 + inward * 0.012 - down * 0.012, 0.022 * S, (0.8, 0.7, 1.2), rot=rot, stiff=1.6)  # thenar pad
    # Fingers: index to little across the palm width, three phalanges each, curling toward the palm.
    lengths = [(0.042, 0.026, 0.02), (0.046, 0.029, 0.021), (0.043, 0.027, 0.02), (0.035, 0.021, 0.018)]
    radii = [0.0092, 0.0095, 0.009, 0.0078]
    for i, (lens, r) in enumerate(zip(lengths, radii)):
        m = fams[1 + i]
        across = (1.5 - i) * 0.0195
        base = pc + down * 0.048 + fwd * across
        d = down.copy()
        p = base
        curl = 0.42 + i * 0.06
        for j, L in enumerate(lens):
            d = (d * math.cos(curl) + inward * math.sin(curl)).normalized()
            q = p + d * L
            capsule(m, p, q, r * S * (1 - 0.08 * j), stiff=2.2)
            p = q
    # Thumb: from the thenar pad, out and around toward the index finger.
    m = fams[5]
    tb = pc + fwd * 0.038 + inward * 0.01 + down * 0.0
    d = (down * 0.55 + fwd * 0.6 + inward * 0.45).normalized()
    p = tb
    for j, L in enumerate((0.04, 0.032, 0.026)):
        q = p + d * L
        capsule(m, p, q, (0.012 - 0.0012 * j) * S, stiff=2.2)
        p = q
        d = (d * math.cos(0.35) + (inward - fwd * 0.3).normalized() * math.sin(0.35)).normalized()


def eye_openings(head):
    """Cuts almond-shaped lid openings into the sculpted sockets (the head is still a closed mesh here)."""
    for x in (-1, 1):
        ex, ez = x * 0.031 * S, 1.692 * S
        ok, loc, _n, _i = head.ray_cast(Vector((ex, 1.0, ez)), Vector((0, -1, 0)))
        fy = loc.y if ok else 0.085 * S
        cut = bz.prim("sphere", head.data.materials[0] if head.data.materials else bz.material("Body_Skin", (0.4, 0.3, 0.2)), loc=(ex, fy, ez), segments=24, ring_count=12, radius=0.0125 * S)
        cut.scale = (1.35, 0.7, 0.55)
        cut.rotation_euler = (0, x * math.radians(-8), 0)
        activate(cut)
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        md = head.modifiers.new("Eye", "BOOLEAN")
        md.operation = "DIFFERENCE"
        md.object = cut
        md.solver = "EXACT"
        head = apply_all(head)
        bpy.data.objects.remove(cut, do_unlink=True)
    head.name = head.data.name = "Body_Head"
    return head


def carve_eyes(body, mats, head_front):
    """Eyeballs with an iris behind the lid openings (front of the eye ~2 mm behind the lid rim)."""
    eyes = []
    for x, fy in zip((-1, 1), head_front):
        ex, ez = x * 0.031 * S, 1.692 * S
        r = 0.0122 * S
        c = Vector((ex, fy - r + 0.0005, ez))
        e = bz.prim("sphere", mats["eyes"], loc=tuple(c), segments=20, ring_count=12, radius=r)
        e.data.materials.append(mats["iris"])
        for p in e.data.polygons:
            if (p.center - c).normalized().y > 0.84:
                p.material_index = 1
        eyes.append(apply_all(e))
    return body, bz.join(eyes, "Body_Eyes")


def build_body(mats):
    log("body forms")
    res = 0.012 if FAST else 0.008
    fams = families("Body_", res)
    body_forms(fams)
    body = union_mesh(fams, "Body_Skin", 0.006 if FAST else 0.0042, 4, 0.5)
    body = decimate_to(body, 9000)
    log(f"body polygonised {tris(body)} tris")
    hm = meta_family("Body_head", 0.006)
    head_forms(hm)
    head = to_mesh(hm, "Body_Head", voxel=0.0028 if FAST else 0.002, smooth_iter=3, smooth_factor=0.5)
    head = sculpt_face(head)
    head = decimate_to(head, 6000)
    head_front = []
    for x in (-1, 1):
        ok, loc, _n, _i = head.ray_cast(Vector((x * 0.031 * S, 1.0, 1.692 * S)), Vector((0, -1, 0)))
        head_front.append(loc.y if ok else 0.085 * S)
    head = eye_openings(head)
    hands = []
    for x in (-1, 1):
        hf = [meta_family(f"Hand{x}_{i}", 0.003 if FAST else 0.0022) for i in range(6)]
        hand_forms(hf, x)
        parts = [to_mesh(f, f"hand{x}_{i}", voxel=None, smooth_iter=0) for i, f in enumerate(hf)]
        hnd = bz.join(parts, f"hand{x}")
        r = hnd.modifiers.new("Remesh", "REMESH")
        r.mode = "VOXEL"
        r.voxel_size = 0.0022 if FAST else 0.0015
        hnd = apply_all(hnd)
        sm = hnd.modifiers.new("Smooth", "SMOOTH")
        sm.factor = 0.5
        sm.iterations = 3
        hnd = smooth(apply_all(hnd))
        hands.append(decimate_to(hnd, 2600))
    log("head and hands")
    body = bz.join([body, head] + hands, "Body_Skin")
    body.data.materials.clear()
    body.data.materials.append(mats["skin"])
    body, eyes = carve_eyes(body, mats, head_front)
    body.name = "Body_Skin"
    return smooth(body), eyes


# ---- uniform ----------------------------------------------------------------------------------------------------------

def garment_volume(mats):
    fams = families("Garment_", 0.016 if FAST else 0.011)
    body_forms(fams, k=1.0, garment=True)
    g = union_mesh(fams, "Garment", 0.012 if FAST else 0.009, 8, 0.6)
    g.data.materials.clear()
    g.data.materials.append(mats["uniform"])
    return g


def remove_islands(obj, min_faces=300):
    """Deletes loose mesh islands smaller than `min_faces` (cut-off scraps of the garment volume near the hands)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    seen = set()
    kill = []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, island = [f], []
        seen.add(f.index)
        while stack:
            cur = stack.pop()
            island.append(cur)
            for e in cur.edges:
                for nf in e.link_faces:
                    if nf.index not in seen:
                        seen.add(nf.index)
                        stack.append(nf)
        if len(island) < min_faces:
            kill += island
    if kill:
        bmesh.ops.delete(bm, geom=kill, context="FACES")
    bm.to_mesh(obj.data)
    bm.free()
    return len(kill)


# The sleeve ends inside the glove cuff (the glove runs ~8.5 cm up the forearm), 4 cm above the wrist; the trouser hem
# hangs over the boot collar (boot top ~0.335 m), bloused.
SLEEVE_END = -0.04
HEM_Z = 0.29
# Export budget: shirt + trousers ~4.7k tris (QuadriFlow faces before the cuts); the high copies feed the normal bake.
LOW_FACES = 2750
LOW_TRIS = 4900
HIGH_TRIS = 60000


def split_garment(g):
    """Cuts the garment volume into a shirt (neck to wrists, down to the hips) and trousers (waist to the boot tops)."""
    shirt = g.copy()
    shirt.data = g.data.copy()
    link(shirt)
    shirt.name = shirt.data.name = "Body_Shirt"
    trousers = g
    trousers.name = trousers.data.name = "Body_Trousers"
    # Shirt: everything above the hips, minus the head and the hands; ends just above the wrist.
    # The hem cut applies to the torso only (the A-posed forearms slope below the hem line); each sleeve ends at a
    # plane square to the forearm at the wrist, where the cuff sits and the glove cuff overlaps it.
    def past_wrist(c):
        x = 1 if c.x > 0 else -1
        el, wr = P(x * 0.33, 0.0, 1.17), P(x * 0.44, 0.03, 0.94)
        return abs(c.x) > 0.3 * S and (c - wr).dot((wr - el).normalized()) > SLEEVE_END

    bz.delete_faces(shirt, lambda c, n: (c.z < 1.04 * S and abs(c.x) < 0.27 * S) or c.z > 1.6 * S or past_wrist(c))
    # Trousers: waist to just above the ankle; no torso.
    bz.delete_faces(trousers, lambda c, n: c.z > 1.075 * S or c.z < HEM_Z or abs(c.x) > 0.27 * S)
    log(f"removed islands: shirt {remove_islands(shirt)} faces, trousers {remove_islands(trousers)} faces")
    return shirt, trousers


def drape(cloth, collider, pins, frames, shrink=0.0):
    """Blender cloth simulation over `collider`, pinned where `pins(co)` is true; applies the settled frame."""
    scene = bpy.context.scene
    pin = cloth.vertex_groups.new(name="pin")
    for v in cloth.data.vertices:
        w = pins(v.co)
        if w:
            pin.add([v.index], w, "REPLACE")
    col = collider.modifiers.new("Collision", "COLLISION")
    collider.collision.thickness_outer = 0.006
    collider.collision.cloth_friction = 8.0
    mod = cloth.modifiers.new("Cloth", "CLOTH")
    s = mod.settings
    s.quality = 5
    s.mass = 0.3
    s.air_damping = 1.5
    s.tension_stiffness = 18
    s.compression_stiffness = 18
    s.shear_stiffness = 10
    s.bending_stiffness = 0.6
    s.shrink_min = shrink
    s.vertex_group_mass = "pin"
    s.pin_stiffness = 3.0
    mod.collision_settings.use_collision = True
    mod.collision_settings.distance_min = 0.005
    mod.collision_settings.use_self_collision = False
    mod.point_cache.frame_start = 1
    mod.point_cache.frame_end = frames
    scene.frame_start = 1
    scene.frame_end = frames
    for f in range(1, frames + 1):
        scene.frame_set(f)
    activate(cloth)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    scene.frame_set(1)
    collider.modifiers.remove(col)
    cloth.vertex_groups.remove(cloth.vertex_groups["pin"])
    return cloth


def wrinkles(obj, regions, seed):
    """Fabric wrinkles: 3D noise sampled in each region's own frame, squashed along its axis so the ridges wrap around
    the limb (compression folds) or run along it (drape). regions: (a, b, radius, amp, along_scale, around_scale)."""
    offs = [Vector((seed * 13.1 + i * 7.7, seed * 3.3 + i * 1.9, i * 5.1)) for i in range(len(regions))]

    def fn(co, n):
        total = 0.0
        for (a, b, rad, amp, s_along, s_around), o in zip(regions, offs):
            ab = b - a
            L = ab.length
            axis = ab / L
            t = (co - a).dot(axis)
            if t < -rad or t > L + rad:
                continue
            closest = a + axis * max(0.0, min(L, t))
            d = (co - closest).length
            if d > rad * 2.0:
                continue
            w = math.exp(-max(0.0, -t, t - L) ** 2 / (rad * rad * 0.25)) * math.exp(-(d / (rad * 1.6)) ** 2)
            side = co - closest
            q = Vector((t * s_along, side.x * s_around, (side.y + side.z) * s_around)) + o
            nz = noise.noise(q)
            # Sharpen to ridges: folds are creases, not soft bumps.
            # Cloth creases: |noise| has sharp V valleys at its zero lines and broad rounded tops between them.
            crease = abs(nz) ** 0.5 * 1.7 - 0.7
            total += amp * w * crease
        return n * total if total else None

    bz.push_verts(obj, wrinkles_clamp(fn))


def wrinkles_clamp(fn):
    return fn


def folds(obj, specs, seed):
    """Compression folds: ripples along an axis near a point, wavy around the limb. specs: (center, axis, radius, amp, freq)."""
    rnd = random.Random(seed)
    phase = [rnd.random() * 6.28 for _ in specs]

    def fn(co, n):
        off = 0.0
        for i, (c, axis, rad, amp, freq) in enumerate(specs):
            d = co - c
            if d.length > rad * 2.5:
                continue
            along = d.dot(axis)
            g = math.exp(-(d.length / rad) ** 2)
            side = d - axis * along
            ang = math.atan2(side.y, side.x)
            off += amp * g * math.sin(along * freq + phase[i] + 1.7 * math.sin(ang * 2 + phase[i] * 1.3))
        return n * off

    bz.push_verts(obj, fn)


def seam_lines(obj, lines, depth=0.0022, width=0.0035):
    """Sunken seams along polylines (lists of points), like the reference's stitched panel lines."""
    segs = []
    for pts in lines:
        for a, b in zip(pts[:-1], pts[1:]):
            segs.append((Vector(a), Vector(b)))

    def fn(co, n):
        best = 1.0
        for a, b in segs:
            d = bz.seg_dist(co, a, b)
            if d < best:
                best = d
        if best < width * 2.5:
            return -n * depth * math.exp(-(best / width) ** 2)
        return None

    bz.push_verts(obj, fn)


def surface_panel(target, center, normal_hint, w, h, thick, mat, name, up=Vector((0, 0, 1)), bevel=0.003, offset=0.0015):
    """A flat rectangle (pocket, flap, velcro patch) shrink-wrapped onto `target`'s surface, given thickness."""
    nrm = Vector(normal_hint).normalized()
    right = up.cross(nrm).normalized()
    upv = nrm.cross(right).normalized()
    nx, ny = 10, 10
    verts, faces = [], []
    for j in range(ny + 1):
        for i in range(nx + 1):
            u = (i / nx - 0.5) * w
            v = (j / ny - 0.5) * h
            verts.append(Vector(center) + right * u + upv * v + nrm * 0.05)
    for j in range(ny):
        for i in range(nx):
            a = j * (nx + 1) + i
            faces.append((a, a + 1, a + nx + 2, a + nx + 1))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    o = link(bpy.data.objects.new(name, me))
    o.data.materials.append(mat)
    sw = o.modifiers.new("Wrap", "SHRINKWRAP")
    sw.target = target
    sw.wrap_method = "PROJECT"
    sw.use_project_z = False
    sw.use_negative_direction = True
    sw.use_positive_direction = True
    sw.wrap_mode = "OUTSIDE_SURFACE"
    sw.offset = offset
    # Project along the panel normal: PROJECT needs an axis; use NEAREST_SURFACEPOINT for robustness.
    sw.wrap_method = "NEAREST_SURFACEPOINT"
    so = o.modifiers.new("Solid", "SOLIDIFY")
    so.thickness = thick
    so.offset = 1.0
    if bevel:
        bv = o.modifiers.new("Bevel", "BEVEL")
        bv.width = bevel
        bv.segments = 2
        bv.limit_method = "ANGLE"
    o = apply_all(o)
    return smooth(o)


def split_legs(trousers):
    """Cuts a wedge between the trouser legs: closed at the crotch, ~5 cm apart at the knees, so each leg is its own
    tube like on the reference."""
    prof = [(0.84, 0.002), (0.78, 0.008), (0.62, 0.022), (0.5, 0.03), (0.0, 0.034), (-0.05, 0.034)]
    verts, faces = [], []
    for z, hw in prof:
        for x, y in ((-hw, -0.4), (hw, -0.4), (hw, 0.4), (-hw, 0.4)):
            verts.append(Vector((x * S, y, z * S)))
    n = len(prof)
    for i in range(n - 1):
        for k in range(4):
            a0, a1 = i * 4 + k, i * 4 + (k + 1) % 4
            faces.append((a0, a1, a1 + 4, a0 + 4))
    faces.append((0, 1, 2, 3)[::-1])
    faces.append(tuple((n - 1) * 4 + k for k in range(4)))
    me = bpy.data.meshes.new("wedge")
    me.from_pydata(verts, [], faces)
    me.update()
    cutter = link(bpy.data.objects.new("wedge", me))
    md = trousers.modifiers.new("Split", "BOOLEAN")
    md.operation = "DIFFERENCE"
    md.object = cutter
    md.solver = "EXACT"
    trousers = apply_all(trousers)
    bpy.data.objects.remove(cutter, do_unlink=True)
    trousers.name = trousers.data.name = "Body_Trousers"
    return smooth(trousers)


def blouse(trousers):
    """Bloused hems: above the boot collar (~0.335 m) the leg puffs out ~1.5 cm with soft vertical pleats, then comes
    in a little toward the hem (0.29 m), which hangs over the collar like the reference's trousers."""
    rnd = random.Random(23)
    phase = [rnd.random() * 6.3 for _ in range(4)]
    top = 0.47 * S
    span = top - HEM_Z

    def fn(co, n):
        if co.z > top or co.z < HEM_Z - 0.02:
            return None
        x = 1 if co.x > 0 else -1
        kn, an = P(x * 0.11, 0.01, 0.51), P(x * 0.12, -0.02, 0.1)
        leg = (an - kn).normalized()
        axis_pt = kn + leg * ((co - kn).dot(leg))
        radial = co - axis_pt
        radial = radial - leg * radial.dot(leg)
        if radial.length < 1e-6:
            return None
        rdir = radial.normalized()
        ang = math.atan2(rdir.y, rdir.x)
        t = max(0.0, min(1.0, (top - co.z) / span))  # 0 at the top of the drape, 1 at the hem
        puff = 0.022 * math.sin(math.pi * 0.8 * t) ** 1.5
        pleat = 0.005 * math.sin(ang * 7 + phase[0] + 2.0 * math.sin(ang * 3 + phase[1])) * t
        return rdir * (puff + pleat)

    bz.push_verts(trousers, fn)


# ---- the low-poly uniform -------------------------------------------------------------------------------------------

def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def quad_low(g, target):
    """A clean, symmetric quad cage of the closed garment volume (QuadriFlow), ~`target` faces; decimation fallback."""
    lo = g.copy()
    lo.data = g.data.copy()
    link(lo)
    lo.name = lo.data.name = "GarmentLow"
    activate(lo)
    try:
        bpy.ops.object.quadriflow_remesh(target_faces=target, use_preserve_sharp=False, use_preserve_boundary=False,
                                         use_mesh_symmetry=True, seed=1)
    except RuntimeError as e:
        log(f"quadriflow failed ({e}); decimating")
    if len(lo.data.polygons) > target * 1.5 or len(lo.data.polygons) < target * 0.3:
        lo = decimate_to(lo, target * 2)
    lo.data.materials.clear()
    for m in g.data.materials:
        lo.data.materials.append(m)
    log(f"low cage {len(lo.data.polygons)} faces")
    return smooth(lo)


def bisect_keep(obj, co, no, region=None):
    """Cuts `obj` with the plane (co, no) and deletes everything on the +no side; `region(face_center)` limits the cut
    to part of the mesh (e.g. one sleeve). Gives straight, clean garment edges on the low mesh."""
    co, no = Vector(co), Vector(no)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    faces = [f for f in bm.faces if region is None or region(f.calc_center_median())]
    verts = {v for f in faces for v in f.verts}
    edges = {e for f in faces for e in f.edges}
    bmesh.ops.bisect_plane(bm, geom=list(verts) + list(edges) + faces, dist=1e-6, plane_co=co, plane_no=no)
    kill = [f for f in bm.faces if (region is None or region(f.calc_center_median())) and (f.calc_center_median() - co).dot(no) > 0]
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def split_low(lo):
    """The low cage cut like the high garment, with planar cuts (clean cuff, hem, waist and collar edges)."""
    shirt = lo.copy()
    shirt.data = lo.data.copy()
    link(shirt)
    shirt.name = shirt.data.name = "Body_Shirt"
    trousers = lo
    trousers.name = trousers.data.name = "Body_Trousers"
    bisect_keep(shirt, P(0, 0, 1.6), (0, 0, 1))
    bisect_keep(shirt, P(0, 0, 1.04), (0, 0, -1), region=lambda c: abs(c.x) < 0.27 * S)
    for x in (-1, 1):
        el, wr = P(x * 0.33, 0.0, 1.17), P(x * 0.44, 0.03, 0.94)
        ax = (wr - el).normalized()
        bisect_keep(shirt, wr + ax * SLEEVE_END, ax, region=lambda c, x=x: c.x * x > 0.3 * S)
    bisect_keep(trousers, P(0, 0, 1.075), (0, 0, 1))
    bisect_keep(trousers, Vector((0, 0, HEM_Z)), (0, 0, -1))
    bz.delete_faces(trousers, lambda c, n: abs(c.x) > 0.27 * S)
    log(f"low islands removed: shirt {remove_islands(shirt, 40)} faces, trousers {remove_islands(trousers, 40)} faces")
    return smooth(shirt), smooth(trousers)


def skin_bvh(body):
    from mathutils.bvhtree import BVHTree
    return BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())


def sleeve_taper(obj, bvh):
    """Gathers each sleeve into the glove: from 11 cm above the wrist the sleeve closes onto the forearm and the last
    centimetres sit just inside the skin, so the glove cuff always covers the sleeve end."""
    for x in (-1, 1):
        el, wr = P(x * 0.33, 0.0, 1.17), P(x * 0.44, 0.03, 0.94)
        ax = (wr - el).normalized()
        for v in obj.data.vertices:
            c = v.co
            if c.x * x < 0.27 * S:
                continue
            d = (c - wr).dot(ax)
            if d < -0.115 or d > 0.02:
                continue
            foot = wr + ax * d
            rad = c - foot
            rad -= ax * rad.dot(ax)
            r = rad.length
            if r < 1e-5:
                continue
            dirn = rad / r
            loc, _n, _i, dist = bvh.ray_cast(foot, dirn, 0.12)
            rs = dist if loc is not None else 0.03
            s = smoothstep(-0.115, -0.07, d)
            target = (1 - s) * r + s * (rs - 0.003)
            v.co = foot + dirn * min(r, target)
    obj.data.update()


def tuck_shirt(shirt, depth=0.007):
    """The shirt's tail sits inside the trouser waist (no z-fighting between 1.04 and 1.075 m)."""
    def fn(co, n):
        if abs(co.x) > 0.27 * S or co.z > 1.1 * S:
            return None
        return -n * depth * smoothstep(1.1 * S, 1.08 * S, co.z)
    bz.push_verts(shirt, fn)


def waist_band(trousers):
    def fn(co, n):
        if co.z < 1.03 * S:
            return None
        return n * 0.003 * smoothstep(1.03 * S, 1.045 * S, co.z)
    bz.push_verts(trousers, fn)


def wrap_to(lo, target):
    """Shrink-wraps the low cage onto the draped high garment (nearest surface point)."""
    sw = lo.modifiers.new("Wrap", "SHRINKWRAP")
    sw.target = target
    sw.wrap_method = "NEAREST_SURFACEPOINT"
    sw.offset = 0.0005
    return apply_all(lo)


def lift_to(lo, high, max_d=0.035, under=0.003):
    """Raises the low surface onto the high one's raised details (pockets, flaps, collar, waistband) along the normal,
    so the silhouette carries them and the normal bake's short rays reach them; the lift is smoothed over neighbours."""
    from mathutils.bvhtree import BVHTree
    bvh = BVHTree.FromObject(high, bpy.context.evaluated_depsgraph_get())
    me = lo.data
    me.update()
    disp = []
    for v in me.vertices:
        # Cast inward from outside: the first outward-facing high surface is the outermost layer (a pocket's face, not
        # its back); surfaces facing the other way belong to a neighbouring limb and are skipped.
        n = v.normal
        start = v.co + n * max_d
        t, lift = 0.0, 0.0
        for _k in range(4):
            loc, nh, _i, dist = bvh.ray_cast(start - n * t, -n, max_d + 0.003 - t)
            if loc is None:
                break
            t += dist + 1e-4
            if nh.dot(n) > 0.2:
                lift = max(0.0, max_d - t - under)
                break
        disp.append(lift)
    nbr = [[] for _ in me.vertices]
    for e in me.edges:
        a, b = e.vertices
        nbr[a].append(b)
        nbr[b].append(a)
    moved = 0
    for i, v in enumerate(me.vertices):
        if disp[i] < 0.001:
            continue
        # A lone lifted vertex is a thin detail (pleat, tab, seam bead): leave it to the bake.
        if not any(disp[j] > 0.002 for j in nbr[i]):
            continue
        avg = sum(disp[j] for j in nbr[i]) / len(nbr[i])
        v.co += v.normal * min(disp[i], 0.5 * disp[i] + 0.5 * avg + 0.004)
        moved += 1
    me.update()
    log(f"{lo.name}: {moved} verts lifted onto the high detail")


def mark_high(obj, low_name):
    obj.name = obj.data.name = f"{low_name}_high"
    obj["high"] = True
    obj["high_of"] = low_name
    obj["part"] = "body"
    for md in list(obj.modifiers):
        obj.modifiers.remove(md)
    return obj


def build_uniform(body, mats):
    log("garment volume")
    g = garment_volume(mats)
    # QuadriFlow lands only roughly on its target: retry with a corrected target until the cut garment fits the budget.
    target = LOW_FACES
    for attempt in range(4):
        shirt_lo, trousers_lo = split_low(quad_low(g, target))
        total = tris(shirt_lo) + tris(trousers_lo)
        log(f"low uniform attempt {attempt}: target {target} -> {total} tris")
        if LOW_TRIS - 450 <= total <= LOW_TRIS or attempt == 3:
            break
        target = int(target * (LOW_TRIS - 200) / total)
        for o in (shirt_lo, trousers_lo):
            bpy.data.objects.remove(o, do_unlink=True)
    shirt, trousers = split_garment(g)

    log(f"shirt {tris(shirt)} tris, trousers {tris(trousers)} tris; draping")
    collider = body.copy()
    collider.data = body.data.copy()
    link(collider)
    collider.name = "collider"
    frames = 14 if FAST else 40
    if NODRAPE:
        frames = 0
    if frames:
        shirt = drape(shirt, collider, lambda c: 1.0 if (c.z > 1.42 * S and abs(c.x) < 0.2 * S) or (abs(c.x) > 0.42 * S and c.z < 1.0 * S) or (c.z < 1.07 * S and abs(c.x) < 0.27 * S) else 0.0, frames)
    sides = [(-1 if v.co.x < 0 else 1) for v in trousers.data.vertices]
    if frames:
        trousers = drape(trousers, collider, lambda c: 1.0 if c.z > 1.0 * S or c.z < HEM_Z + 0.02 else 0.0, frames)
    bpy.data.objects.remove(collider, do_unlink=True)
    # The drape pulls the inner leg surfaces together again: keep each vertex on its own leg's side.
    for v, side in zip(trousers.data.vertices, sides):
        g = leg_gap(v.co.z)
        if g > 0 and side * v.co.x < g:
            v.co.x = side * g
    log("draped")
    bvh = skin_bvh(body)
    sleeve_taper(shirt, bvh)
    tuck_shirt(shirt)
    # The low cage follows the draped cloth before the folds and pockets go on (those are baked into its normal map).
    shirt_lo = wrap_to(shirt_lo, shirt)
    trousers_lo = wrap_to(trousers_lo, trousers)
    sleeve_taper(shirt_lo, bvh)
    tuck_shirt(shirt_lo)
    clamp_leg_sides(trousers_lo)

    # Compression folds (amplitudes in metres along the normal): only where fabric really folds.
    specs_shirt, specs_trousers = [], []
    for x in (-1, 1):
        sh = P(x * 0.17, 0.0, 1.42)
        el = P(x * 0.33, 0.0, 1.17)
        wr = P(x * 0.44, 0.03, 0.94)
        up = (el - sh).normalized()
        lo = (wr - el).normalized()
        specs_shirt += [
            (el + Vector((-x * 0.025, 0.03, 0)), lo, 0.04, 0.011, 170),  # inner elbow bend
            (el + Vector((-x * 0.02, 0.035, -0.03)), lo, 0.03, 0.007, 230),  # secondary Z-fold below the bend
            (P(x * 0.415, 0.024, 1.0), lo, 0.05, 0.009, 125),  # sleeve stacking above the cuff
            (P(x * 0.4, 0.022, 1.035), lo, 0.04, 0.006, 150),
            (P(x * 0.18, 0.03, 1.35), up, 0.035, 0.004, 120),  # armpit
        ]
        hip = P(x * 0.098, 0.0, 0.95)
        kn = P(x * 0.11, 0.01, 0.51)
        an = P(x * 0.12, -0.02, 0.1)
        leg = (an - hip).normalized()
        specs_trousers += [
            (kn + Vector((0, -0.05, 0)), leg, 0.05, 0.008, 140),  # back of the knee
            (P(x * 0.07, 0.05, 0.9), (hip - P(0, 0.03, 0.83)).normalized(), 0.04, 0.005, 120),  # hip / crotch crease
        ]
    folds(shirt, specs_shirt, 3)
    folds(trousers, specs_trousers, 5)
    # Crisp crease networks at the joints only; the rest of the fabric stays taut ripstop.
    sh_regions, tr_regions = [], []
    for x in (-1, 1):
        sh = P(x * 0.17, 0.0, 1.42)
        el = P(x * 0.33, 0.0, 1.17)
        wr = P(x * 0.44, 0.03, 0.94)
        hip = P(x * 0.098, 0.0, 0.95)
        kn = P(x * 0.11, 0.01, 0.51)
        an = P(x * 0.12, -0.02, 0.1)
        inner = Vector((-x * 0.02, 0.03, 0))
        sh_regions += [
            (sh.lerp(el, 0.8) + inner, el.lerp(wr, 0.25) + inner, 0.045, 0.018, 34.0, 9.0),  # inner elbow
            (el.lerp(wr, 0.6), el.lerp(wr, 0.95), 0.05, 0.012, 40.0, 8.0),  # stacked folds over the glove cuff
            (P(x * 0.17, 0.03, 1.38), P(x * 0.22, 0.03, 1.32), 0.04, 0.006, 30.0, 10.0),  # armpit
        ]
        tr_regions += [
            (kn + Vector((0, -0.05, 0.05)), kn + Vector((0, -0.05, -0.05)), 0.05, 0.014, 34.0, 8.0),  # back of the knee
            (P(x * 0.05, 0.045, 0.9), hip.lerp(kn, 0.15) + Vector((0, 0.04, 0)), 0.05, 0.008, 26.0, 9.0),  # hip crease
        ]
    wrinkles(shirt, sh_regions, 11)
    wrinkles(trousers, tr_regions, 17)
    blouse(trousers)
    for gobj in (shirt, trousers):
        sm = gobj.modifiers.new("Soften", "SMOOTH")
        sm.factor = 0.5
        sm.iterations = 1
        apply_all(gobj)

    # Seams: shoulder yoke, raglan line, sleeve outer seam, side seams, trouser outseam and inseam, knee panels.
    shirt_lines, trouser_lines = [], []
    for x in (-1, 1):
        shirt_lines += [
            [P(x * 0.06, 0.06, 1.47), P(x * 0.15, 0.06, 1.4), P(x * 0.19, 0.075, 1.3)],
            [P(x * 0.06, -0.06, 1.47), P(x * 0.15, -0.065, 1.4), P(x * 0.19, -0.075, 1.3)],
            [P(x * 0.17, -0.018, 1.47), P(x * 0.33, -0.05, 1.17), P(x * 0.43, -0.02, 0.97)],
            [P(x * 0.17, 0.0, 1.3), P(x * 0.165, 0.0, 1.0)],
        ]
        trouser_lines += [
            [P(x * 0.2, 0.0, 1.06), P(x * 0.19, 0.0, 0.75), P(x * 0.175, 0.0, 0.2)],
            [P(x * 0.03, 0.0, 0.88), P(x * 0.07, 0.0, 0.6), P(x * 0.08, 0.0, 0.2)],
            [P(x * 0.06, 0.085, 0.6), P(x * 0.11, 0.095, 0.62), P(x * 0.16, 0.085, 0.6)],
            [P(x * 0.06, 0.08, 0.42), P(x * 0.11, 0.09, 0.4), P(x * 0.16, 0.08, 0.42)],
        ]
    seam_lines(shirt, shirt_lines)
    seam_lines(trousers, trouser_lines)

    extras_shirt, extras_trousers = [], []
    for x in (-1, 1):
        # Shoulder pocket with flap and a velcro panel on top (the SWAT patch goes on the left one).
        up_arm = (P(x * 0.17, 0, 1.42) - P(x * 0.33, 0, 1.17)).normalized()
        out = Vector((x, 0, 0))
        out = (out - up_arm * out.dot(up_arm)).normalized()
        c = P(x * 0.26, 0.0, 1.29)
        extras_shirt.append(surface_panel(shirt, c, out, 0.085, 0.1, 0.008, mats["uniform"], f"sleevePocket{x}", up=up_arm, bevel=0.004))
        extras_shirt.append(surface_panel(shirt, c + up_arm * 0.045, out, 0.095, 0.045, 0.01, mats["uniform"], f"sleeveFlap{x}", up=up_arm, bevel=0.003, offset=0.011))
        # Velcro field on the pocket face (the SWAT patch sits on the left one).
        extras_shirt.append(surface_panel(shirt, c - up_arm * 0.012, out, 0.075, 0.055, 0.003, mats["velcro"], f"sleeveVelcro{x}", up=up_arm, bevel=0.001, offset=0.011))
        # Thigh cargo pocket: bellows body, flap with a snap tab, two pleats.
        c = P(x * 0.19, 0.012, 0.7)
        nrm = Vector((x, 0.25, 0)).normalized()
        pocket = surface_panel(trousers, c, nrm, 0.13, 0.17, 0.016, mats["uniform"], f"cargo{x}", bevel=0.008)
        # Loaded pockets sag: push the lower half out and down a little.
        ctr = c.copy()
        bz.push_verts(pocket, lambda co, n, ctr=ctr, nrm=nrm: (nrm * 0.014 + Vector((0, 0, -0.006))) * max(0.0, min(1.0, (ctr.z - co.z) / 0.085 + 0.2)) if (co - ctr).dot(nrm) > 0.004 else None)
        extras_trousers.append(smooth(pocket))
        extras_trousers.append(surface_panel(trousers, c + Vector((0, 0, 0.088)), nrm, 0.15, 0.056, 0.011, mats["uniform"], f"cargoFlap{x}", bevel=0.003, offset=0.022))
        # Snap tab under the flap's front edge.
        extras_trousers.append(surface_panel(trousers, c + Vector((0, 0, 0.056)), nrm, 0.03, 0.022, 0.004, mats["velcro"], f"cargoTab{x}", bevel=0.002, offset=0.034))
        for dx in (-0.035, 0.035):
            extras_trousers.append(surface_panel(trousers, c + nrm.cross(Vector((0, 0, 1))).normalized() * dx, nrm, 0.006, 0.15, 0.003, mats["uniform"], f"pleat{x}{dx}", bevel=0.0, offset=0.018))
        # Small lower-leg pocket.
        c2 = P(x * 0.155, 0.04, 0.45)
        extras_trousers.append(surface_panel(trousers, c2, Vector((x, 0.5, 0)).normalized(), 0.075, 0.09, 0.01, mats["uniform"], f"shinPocket{x}", bevel=0.005))
        # Knee reinforcement panel (sits under the LIMBS worker's knee pad).
        extras_trousers.append(surface_panel(trousers, P(x * 0.11, 0.07, 0.52), Vector((0, 1, 0)), 0.12, 0.15, 0.003, mats["uniform"], f"kneePanel{x}", bevel=0.004))
    # Mock collar: a soft band around the neck rising toward the jaw (under the balaclava).
    collar = bz.prim("cyl", mats["uniform"], loc=tuple(P(0, 0.002, 1.555)), radius=0.079 * S, depth=0.095, vertices=36)
    collar = apply_all(collar)
    bz.delete_faces(collar, lambda cc, n: abs(n.z) > 0.9)
    so = collar.modifiers.new("Solid", "SOLIDIFY")
    so.thickness = 0.006
    collar = smooth(apply_all(collar))
    bz.push_verts(collar, lambda co, n: Vector((0, -0.004, 0.01)) if co.y < 0 and co.z > 1.555 * S else (Vector((0, 0.006, -0.014)) if co.y > 0.05 and co.z > 1.555 * S else None))
    extras_shirt.append(collar)
    # Front zip placket on the collar.
    extras_shirt.append(bz.box((0.012, 0.006, 0.08), tuple(P(0, 0.089, 1.54)), mats["velcro"], bevel=0.002))
    # Waistband with belt loops (the TORSO worker's belt sits on it).
    wb = bz.prim("cyl", mats["uniform"], loc=tuple(P(0, -0.003, 1.045)), radius=0.165 * S, depth=0.045, vertices=48)
    wb.scale = (1.0, 0.78, 1.0)
    wb = apply_all(wb)
    activate(wb)
    bpy.ops.object.transform_apply(scale=True)
    bz.delete_faces(wb, lambda cc, n: abs(n.z) > 0.9)
    so = wb.modifiers.new("Solid", "SOLIDIFY")
    so.thickness = 0.006
    wb = smooth(apply_all(wb))
    extras_trousers.append(wb)

    shirt = bz.join([shirt] + extras_shirt, "Body_Shirt_high")
    trousers = bz.join([trousers] + extras_trousers, "Body_Trousers_high")
    shirt = mark_high(decimate_to(shirt, HIGH_TRIS), "Body_Shirt")
    trousers = mark_high(decimate_to(trousers, HIGH_TRIS), "Body_Trousers")

    # Low: the hem blousing and waistband shapes, then lifted onto the high's pockets, flaps and collar.
    blouse(trousers_lo)
    waist_band(trousers_lo)
    lift_to(shirt_lo, shirt)
    lift_to(trousers_lo, trousers)
    clamp_leg_sides(trousers_lo)
    shirt_lo.name = shirt_lo.data.name = "Body_Shirt"
    trousers_lo.name = trousers_lo.data.name = "Body_Trousers"
    log(f"uniform low: shirt {tris(shirt_lo)} + trousers {tris(trousers_lo)} tris; high {tris(shirt)} + {tris(trousers)}")
    return smooth(shirt_lo), smooth(trousers_lo), shirt, trousers


def clamp_leg_sides(trousers):
    for v in trousers.data.vertices:
        side = -1 if v.co.x < 0 else 1
        g = leg_gap(v.co.z)
        if g > 0 and side * v.co.x < g:
            v.co.x = side * g
    trousers.data.update()


# ---- rigging ------------------------------------------------------------------------------------------------------------

def auto_weights(arm, obj):
    """Heat-map automatic weights; falls back to the rig's distance weights if heat weighting leaves verts unweighted."""
    activate(obj)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    try:
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    except RuntimeError as e:
        log(f"auto weights failed on {obj.name}: {e}")
    unweighted = sum(1 for v in obj.data.vertices if not v.groups or sum(g.weight for g in v.groups) < 1e-4)
    if unweighted > len(obj.data.vertices) * 0.01:
        log(f"{obj.name}: {unweighted} unweighted verts after heat weights; using distance weights")
        for vg in list(obj.vertex_groups):
            obj.vertex_groups.remove(vg)
        for md in list(obj.modifiers):
            if md.type == "ARMATURE":
                obj.modifiers.remove(md)
        obj.parent = None
        bz.skin_to(obj, arm, [b[0] for b in bz.BONES if b[0] != "root"], scale=S, power=5)
    return obj


JOINTS = []  # (centre, radius, iterations): where garment weights get relaxed
for _x in (-1, 1):
    JOINTS += [(P(_x * 0.17, 0.0, 1.42), 0.13, 10), (P(_x * 0.33, 0.0, 1.17), 0.07, 4),
               (P(_x * 0.1, 0.0, 0.95), 0.12, 6), (P(_x * 0.11, 0.01, 0.51), 0.07, 4)]


def smooth_joint_weights(obj):
    """Relaxes the weights round the shoulders, elbows, hips and knees over the mesh's edges (Laplacian smoothing of
    every bone's weight, fading out toward each region's rim), so a raised arm rolls the shoulder cloth over the
    deltoid instead of popping it out as a ball, and the low cage bends without creases."""
    me = obj.data
    names = {g.index: g.name for g in obj.vertex_groups}
    W = [{names[g.group]: g.weight for g in v.groups if g.group in names} for v in me.vertices]
    nbr = [[] for _ in me.vertices]
    for e in me.edges:
        a, b = e.vertices
        nbr[a].append(b)
        nbr[b].append(a)
    for c, rad, iters in JOINTS:
        region = []
        for v in me.vertices:
            d = (v.co - c).length
            if d < rad:
                region.append((v.index, 1.0 - smoothstep(rad * 0.6, rad, d)))
        for _ in range(iters):
            new = {}
            for i, k in region:
                if not nbr[i]:
                    continue
                avg = {}
                for j in nbr[i]:
                    for bn, w in W[j].items():
                        avg[bn] = avg.get(bn, 0.0) + w / len(nbr[i])
                mix = {}
                for bn in set(avg) | set(W[i]):
                    mix[bn] = (1 - 0.5 * k) * W[i].get(bn, 0.0) + 0.5 * k * avg.get(bn, 0.0)
                new[i] = mix
            for i, mix in new.items():
                W[i] = mix
    for v, ws in zip(me.vertices, W):
        for bn, w in ws.items():
            g = obj.vertex_groups.get(bn) or obj.vertex_groups.new(name=bn)
            if w > 1e-4:
                g.add([v.index], w, "REPLACE")
            elif bn in obj.vertex_groups:
                g.remove([v.index])


def transfer_weights(src, dst, arm):
    """Copies the body's bone weights to a garment from the nearest body surface."""
    for b in bz.BONES:
        if b[0] != "root" and b[0] not in dst.vertex_groups:
            dst.vertex_groups.new(name=b[0])
    dt = dst.modifiers.new("DT", "DATA_TRANSFER")
    dt.object = src
    dt.use_vert_data = True
    dt.data_types_verts = {"VGROUP_WEIGHTS"}
    dt.vert_mapping = "POLYINTERP_NEAREST"
    dt.layers_vgroup_select_src = "ALL"
    dt.layers_vgroup_select_dst = "NAME"
    activate(dst)
    bpy.ops.object.modifier_apply(modifier=dt.name)
    smooth_joint_weights(dst)
    # Normalise and keep at most 4 influences.
    plan = []
    for v in dst.data.vertices:
        gs = sorted(((g.group, g.weight) for g in v.groups), key=lambda gw: -gw[1])
        plan.append((v.index, gs))
    for vi, gs in plan:
        keep = gs[:4]
        total = sum(w for _, w in keep) or 1.0
        for gi, _ in gs[4:]:
            dst.vertex_groups[gi].remove([vi])
        for gi, w in keep:
            dst.vertex_groups[gi].add([vi], w / total, "REPLACE")
    dst.parent = arm
    md = dst.modifiers.new("Armature", "ARMATURE")
    md.object = arm
    return dst


# ---- preview ----------------------------------------------------------------------------------------------------------

def use_gpu():
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("OPTIX", "CUDA", "HIP", "ONEAPI"):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
            if any(d.type == kind for d in prefs.devices):
                for d in prefs.devices:
                    d.use = d.type == kind
                bpy.context.scene.cycles.device = "GPU"
                return kind
        except TypeError:
            continue
    return "CPU"


def preview(objs):
    """Light-grey studio renders (front, left, back, 3/4) like the reference sheet, plus a side-by-side with it."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    log(f"render device {use_gpu()}")
    scene.cycles.samples = 48 if FAST else 96
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 420
    scene.render.resolution_y = 760
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = -0.7
    world = bpy.data.worlds.new("studio")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.56, 0.58, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.9
    scene.world = world
    floor = bz.prim("cube", bz.material("PreviewFloor", (0.5, 0.5, 0.52), rough=0.7), loc=(0, 0, -0.05), scale=(12, 12, 0.1))
    lights = []
    for loc, energy, size in (((2.2, 3.0, 3.4), 520, 2.5), ((-2.8, 1.6, 2.2), 260, 3.0), ((0.4, -3.0, 3.0), 300, 2.0)):
        ld = bpy.data.lights.new("key", "AREA")
        ld.energy = energy
        ld.size = size
        lo = link(bpy.data.objects.new("key", ld))
        lo.location = loc
        lo.rotation_euler = (Vector((0, 0, 1.0)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        lights.append(lo)
    cam_d = bpy.data.cameras.new("cam")
    cam_d.lens = 70
    cam = link(bpy.data.objects.new("cam", cam_d))
    scene.camera = cam
    files = []
    # Reference order: front, left (the operator's left side faces the camera), back, 3/4.
    for name, ang in (("front", 0), ("left", -90), ("back", 180), ("34", -35)):
        a = math.radians(ang)
        cam.location = (math.sin(a) * 5.0, math.cos(a) * 5.0, 1.0)
        cam.rotation_euler = (Vector((0, 0, 0.93)) - cam.location).to_track_quat("-Z", "Y").to_euler()
        path = str(PREVIEW / f"body_{name}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        files.append(path)
    # Face close-up (for the HEAD worker's balaclava and goggle fit).
    cam.location = (0.25, 0.6, 1.7)
    cam.rotation_euler = (Vector((0, 0.03, 1.67)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = str(PREVIEW / "body_face.png")
    bpy.ops.render.render(write_still=True)
    cam.location = (0.62, 0.25, 0.95)
    cam.rotation_euler = (Vector((0.45, 0.03, 0.88)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = str(PREVIEW / "body_hand.png")
    bpy.ops.render.render(write_still=True)
    compare(files)
    for o in [floor, cam] + lights:
        bpy.data.objects.remove(o, do_unlink=True)


def load_px(path):
    im = bpy.data.images.load(str(path))
    w, h = im.size
    px = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, im.channels)[..., :3]
    return px[::-1]  # top row first


def resize(px, w, h):
    sh, sw = px.shape[:2]
    ys = (np.arange(h) * sh / h).astype(int)
    xs = (np.arange(w) * sw / w).astype(int)
    return px[ys][:, xs]


def compare(files):
    """Reference four views (top) over the renders (bottom), one JPEG."""
    renders = [load_px(f) for f in files]
    rh, rw = renders[0].shape[:2]
    row = np.concatenate(renders, axis=1)
    out_rows = []
    if REF.exists():
        ref = load_px(REF)
        H, W = ref.shape[:2]
        crop = ref[int(H * 0.035):int(H * 0.69), int(W * 0.0):int(W * 0.79)]
        crop = resize(crop, row.shape[1], int(crop.shape[0] * row.shape[1] / crop.shape[1]))
        out_rows.append(crop)
    out_rows.append(row)
    sheet = np.concatenate(out_rows, axis=0)
    h, w = sheet.shape[:2]
    img = bpy.data.images.new("compare", w, h, alpha=False)
    rgba = np.concatenate([sheet[::-1], np.ones((h, w, 1), np.float32)], axis=2)
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = str(PREVIEW / "body_compare.jpg")
    img.file_format = "JPEG"
    img.save()
    log(f"compare -> {PREVIEW / 'body_compare.jpg'}")


# ---- main -------------------------------------------------------------------------------------------------------------

def main():
    bz.clear_scene()
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)
    coll = bpy.data.collections.new("Body")
    bpy.context.scene.collection.children.link(coll)
    layer_coll = bpy.context.view_layer.layer_collection.children["Body"]
    bpy.context.view_layer.active_layer_collection = layer_coll
    mats = materials()
    arm = bz.build_armature("Survivor", S)
    body, eyes = build_body(mats)
    shirt, trousers, shirt_hi, trousers_hi = build_uniform(body, mats)
    log("weights")
    auto_weights(arm, body)
    transfer_weights(body, shirt, arm)
    transfer_weights(body, trousers, arm)
    bz.skin_to(eyes, arm, ["head"], scale=S, rigid="head")
    for o in (body, eyes, shirt, trousers):
        o["part"] = "body"
    for o in (shirt_hi, trousers_hi):
        o.hide_render = True
        o.hide_set(True)
    log("tris: " + ", ".join(f"{o.name} {tris(o)}" for o in (body, eyes, shirt, trousers)))
    OUT_BLEND.parent.mkdir(parents=True, exist_ok=True)
    if PREVIEW:
        preview([body, eyes, shirt, trousers])
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT_BLEND), compress=True)
    log(f"saved {OUT_BLEND}")


if __name__ == "__main__":
    main()
