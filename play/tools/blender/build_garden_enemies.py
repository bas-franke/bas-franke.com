"""
Builds the Garden Sentinels enemies in Blender and exports them as one animated GLB.

    blender --background --factory-startup --python build_garden_enemies.py -- <output-dir>

Output: <output-dir>/enemies.glb. Conventions the frontend relies on (frontend/src/games/garden/api.ts, models.ts):
  * One root per kind: Enemy_<kind> for runner, skitter, disruptor, brute, colossus. The root is an armature object
    whose bones are all prefixed with the kind (runner_hips, ...); its single child mesh Enemy_<kind>_body is rigidly
    skinned (every vertex 100 % on one bone), so the rig deforms like jointed parts.
  * Origin at the feet, facing Blender +Y (glTF -Z), real-world sizes: runner 0.8 m, skitter 0.5 m, disruptor 0.9 m,
    brute 1.8 m, colossus 3 m (tallest crystal tip).
  * Clips <kind>_walk (in-place loop), <kind>_idle (loop), <kind>_die (one-shot, ends lying on its side) and
    disruptor_cast (rear up + crest pulse), exported as separate glTF animations via NLA tracks.
  * Two materials per enemy: Body (vertex colours, COLOR_0) and Crystal (emissive crystals + eyes; base colour and
    emission from two small palette textures via TEXCOORD_0, the emission one dimmed per cell).
Everything is procedural: bodies are low-res ellipsoids and tapered limbs, crystals are faceted pointed prisms.
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
FPS = 30
X = Vector((1, 0, 0))

# ---- scene + materials -----------------------------------------------------------------------------------------------


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for act in list(bpy.data.actions):
        bpy.data.actions.remove(act)
    for coll in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.images):
        for item in list(coll):
            if item.users == 0:
                coll.remove(item)
    bpy.context.scene.render.fps = FPS


def srgb(h):
    """Hex to sRGB floats (0..1)."""
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


# Two materials per enemy (draw calls dominate with hundreds on screen):
#   Body     non-emissive; its colours come from the COLOR_0 vertex colours.
#   Crystal  emissive crystals + eyes; base colour and emission sample two tiny palette textures (TEXCOORD_0 puts
#            every face in the centre of one flat colour cell), since three.js does not tint emission by vertex colour.
BODY_COLORS = {
    "orange": "#F2802E", "cream": "#F5E7D6", "char": "#2A211E", "teal": "#23797A", "deep": "#1B4A52",
    "violet": "#7440CC", "lilac": "#C9B2EE", "stone": "#2E3550", "plate": "#143840",
}
# Palette cell order: key -> (colour, emission factor). The emission texture is the base colour scaled by the factor,
# so each cell glows at its own strength inside one material (strong glow + bloom blows faceted crystals out into
# fuzz at gameplay scale; most crystals glow softly so their facets read, eyes and the colossus core stay bright).
GLOW_COLORS = {
    "amber": ("#FFA940", 0.65),     # runner blade edges, tail flame
    "skbase": ("#2BB3A8", 0.25),    # skitter crystal bases
    "sktip": ("#9FF7EF", 0.25),     # skitter crystal tips
    "cviolet": ("#9A5CF0", 0.45),   # disruptor crystals
    "vtip": ("#D2A8FF", 0.55),       # disruptor crystal tips
    "cyan": ("#5FE8F2", 0.31),       # brute / colossus crystals
    "ctip": ("#B4FBFF", 0.36),      # brute / colossus crystal tips
    "core": ("#FF9A2A", 1.0),       # colossus core
    "eyes": ("#FFF6D8", 0.8),
    "aeyes": ("#FFB347", 1.0),      # amber eyes (brute, colossus)
}
GLOW_CELLS = 16     # cells across the palette texture
CELL_PX = 4
GLOW_STRENGTH = 1.6


def srgb_to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lin_to_srgb(c):
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def glow_uv(key):
    return ((list(GLOW_COLORS).index(key) + 0.5) / GLOW_CELLS, 0.5)


def palette():
    """Palette keys; Body faces take the colour as vertex colour, Crystal faces a palette cell."""
    return {k: k for k in (*BODY_COLORS, *GLOW_COLORS)}


_mats = {}


def materials():
    if _mats:
        return _mats["Body"], _mats["Crystal"]
    body = bpy.data.materials.new("Body")
    body.use_fake_user = True
    body.use_backface_culling = True
    body.use_nodes = True
    nt = body.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = 0.58
    attr = nt.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])

    w, h = GLOW_CELLS * CELL_PX, CELL_PX
    cells = list(GLOW_COLORS.values())

    def palette_image(name, emissive):
        img = bpy.data.images.new(name, w, h, alpha=False)
        px = [1.0] * (w * h * 4)
        for y in range(h):
            for x in range(w):
                col, k = cells[min(x // CELL_PX, len(cells) - 1)]
                lin = [srgb_to_lin(c) for c in srgb(col)]
                if emissive:
                    lin = [min(1.0, c * k) for c in lin]
                i = (y * w + x) * 4
                px[i:i + 3] = [lin_to_srgb(c) for c in lin]
        img.pixels = px
        img.pack()
        img.use_fake_user = True
        return img

    img = palette_image("crystal_palette", False)
    emi = palette_image("crystal_glow", True)
    crystal = bpy.data.materials.new("Crystal")
    crystal.use_fake_user = True
    crystal.use_backface_culling = True
    crystal.use_nodes = True
    nt = crystal.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = 0.4
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Closest"
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    etex = nt.nodes.new("ShaderNodeTexImage")
    etex.image = emi
    etex.interpolation = "Closest"
    nt.links.new(etex.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = GLOW_STRENGTH
    _mats["Body"], _mats["Crystal"] = body, crystal
    return body, crystal


# ---- geometry builder ------------------------------------------------------------------------------------------------


def frame(d):
    d = d.normalized()
    u = d.cross(Vector((0, 0, 1)) if abs(d.z) < 0.95 else Vector((0, 1, 0))).normalized()
    return u, d.cross(u).normalized()


def lod(n, lo):
    """Trims sphere / limb resolution (top-down camera, small on screen)."""
    return max(lo, int(n * 0.75 + 0.5))


class Body:
    """One bmesh per creature; every part is rigidly bound to one bone (a vertex group of the same name)."""

    def __init__(self, kind, bones):
        self.kind = kind
        self.bm = bmesh.new()
        self.dl = self.bm.verts.layers.deform.verify()
        self.col = self.bm.loops.layers.color.new("Col")
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.groups = {b: i for i, b in enumerate(bones)}
        self.rng = random.Random(kind)

    def _paint(self, faces, key, smooth):
        glow = key in GLOW_COLORS
        col = (1.0, 1.0, 1.0, 1.0) if glow else (*srgb(BODY_COLORS[key]), 1.0)
        uv = glow_uv(key) if glow else (0.0, 0.0)
        for f in faces:
            f.material_index = 1 if glow else 0
            f.smooth = smooth
            for lp in f.loops:
                lp[self.col] = col
                lp[self.uv].uv = uv

    def _tag(self, verts, bone, key, smooth):
        g = self.groups[bone]
        self._paint({f for v in verts for f in v.link_faces}, key, smooth)
        for v in verts:
            v[self.dl].clear()
            v[self.dl][g] = 1.0

    def blob(self, c, r, bone, key, rot=(0, 0, 0), seg=12, rings=8, smooth=True):
        m = (Matrix.Translation(Vector(c)) @ Euler([math.radians(a) for a in rot]).to_matrix().to_4x4()
             @ Matrix.Diagonal((*r, 1.0)))
        verts = bmesh.ops.create_uvsphere(self.bm, u_segments=lod(seg, 6), v_segments=lod(rings, 4), radius=1.0,
                                          matrix=m)["verts"]
        self._tag(verts, bone, key, smooth)

    def gem(self, c, r, bone, key, subdiv=1):
        m = Matrix.Translation(Vector(c)) @ Matrix.Diagonal((r, r, r, 1.0))
        verts = bmesh.ops.create_icosphere(self.bm, subdivisions=subdiv, radius=1.0, matrix=m)["verts"]
        self._tag(verts, bone, key, False)

    def limb(self, a, b, r1, r2, bone, key, seg=10, smooth=True, joint=True):
        """Open tapered tube (both ends sit inside a body part, joint ball or paw)."""
        a, b = Vector(a), Vector(b)
        d = b - a
        m = Matrix.Translation((a + b) / 2) @ d.to_track_quat("Z", "Y").to_matrix().to_4x4()
        verts = bmesh.ops.create_cone(self.bm, cap_ends=False, cap_tris=False, segments=lod(seg, 6), radius1=r1,
                                      radius2=r2, depth=d.length, matrix=m)["verts"]
        self._tag(verts, bone, key, smooth)
        if joint:
            self.blob(b, (r2, r2, r2), bone, key, seg=seg, rings=5, smooth=smooth)

    def crystal(self, base, d, length, r, bone, key, tip=None, sides=5, tipf=0.32, embed=0.25, lean=0.0, wide=None,
                flat=1.0, taper=None):
        """Faceted pointed prism from `base` along `d` (open at the embedded base); `tip` colours the pointed end.
        `wide` + `flat` make a blade: full radius along `wide` (projected off `d`), `flat` x radius across it;
        `taper` narrows the shaft towards the tip (r at the base, taper * r where the point starts)."""
        d = Vector(d).normalized()
        base = Vector(base)
        rng = self.rng
        if wide is not None:
            u = Vector(wide) - d * Vector(wide).dot(d)
            u.normalize()
            v = d.cross(u).normalized()
            spin = 0.0
        else:
            u, v = frame(d)
            spin = rng.uniform(0, math.tau)
        b0 = base - d * (length * embed)
        b1 = base + d * (length * (1 - tipf))
        apex = base + d * length + u * (lean * length)
        r0, r1 = (r * 0.72, r) if taper is None else (r, r * taper)
        bm = self.bm
        ring0, ring1 = [], []
        for i in range(sides):
            ang = spin + math.tau * i / sides
            j = 1.0 + rng.uniform(-0.12, 0.12)
            off = (u * math.cos(ang) + v * (flat * math.sin(ang)))
            ring0.append(bm.verts.new(b0 + off * r0 * j))
            ring1.append(bm.verts.new(b1 + off * r1 * j))
        top = bm.verts.new(apex)
        faces, tipfaces = [], []
        for i in range(sides):
            k = (i + 1) % sides
            faces.append(bm.faces.new((ring0[i], ring0[k], ring1[k], ring1[i])))
            tipfaces.append(bm.faces.new((ring1[i], ring1[k], top)))
        self._tag(ring0 + ring1 + [top], bone, key, False)
        if tip is not None:
            self._paint(tipfaces, tip, False)
        # outward winding, set by hand: the shell is open, so recalc_face_normals is not trusted with it
        axis0 = b0
        for f in faces + tipfaces:
            f.normal_update()
            c = f.calc_center_median()
            radial = (c - axis0) - d * (c - axis0).dot(d)
            if f.normal.dot(radial) < 0:
                f.normal_flip()

    def mesh(self, name):
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        body, crystal = materials()
        me.materials.append(body)
        me.materials.append(crystal)
        try:
            me.color_attributes.active_color = me.color_attributes["Col"]
            me.color_attributes.render_color_index = me.color_attributes.active_color_index
        except (AttributeError, KeyError):
            pass
        obj = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(obj)
        for b in sorted(self.groups, key=self.groups.get):
            obj.vertex_groups.new(name=f"{self.kind}_{b}")
        return obj


# ---- rig ---------------------------------------------------------------------------------------------------------------

LEGS = ("FL", "FR", "BL", "BR")


def rig_spec(J, extra=()):
    """J: joint points. Returns [(short name, head, tail, parent)]. Bones in the YZ plane get local X = world X, so
    +X rotation pitches forward-pointing bones up and swings downward-pointing (leg) bones forward."""
    s = J["scale"]
    hips = Vector(J["hips"])
    spec = [
        ("root", (0, 0, 0), (0, 0.25 * s, 0), None),
        ("hips", tuple(hips), tuple(hips + Vector((0, 0.15 * s, 0))), "root"),
        ("chest", J["chest"][0], J["chest"][1], "hips"),
        ("head", J["head"][0], J["head"][1], "chest"),
    ]
    if "tail" in J:
        spec.append(("tail", J["tail"][0], J["tail"][1], "hips"))
    for leg in LEGS:
        top, knee, paw = J["leg" + leg]
        spec.append((f"leg{leg}_up", top, knee, "chest" if leg[0] == "F" else "hips"))
        spec.append((f"leg{leg}_lo", knee, paw, f"leg{leg}_up"))
    spec.extend(extra)
    return spec


def legs(front, back, w):
    """front/back: (top, knee, paw) as (y, z) pairs; w[key]: |x| of the leg, one value or one per joint.
    L legs sit at -X, R legs are the mirror at +X."""
    J = {}
    for side, sx in (("L", -1), ("R", 1)):
        for key, pts in (("F", front), ("B", back)):
            wx = w[key] if isinstance(w[key], tuple) else (w[key],) * 3
            J[f"leg{key}{side}"] = tuple((sx * wx[i], y, z) for i, (y, z) in enumerate(pts))
    return J


def build_rig(kind, spec):
    data = bpy.data.armatures.new(f"{kind}_rig")
    arm = bpy.data.objects.new(f"Enemy_{kind}", data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = data.edit_bones
    for name, h, t, parent in spec:
        b = eb.new(f"{kind}_{name}")
        b.head, b.tail = Vector(h), Vector(t)
        d = (b.tail - b.head).normalized()
        b.align_roll(X.cross(d) if abs(d.x) < 0.9 else Vector((0, 0, 1)))
        if parent:
            b.parent = eb[f"{kind}_{parent}"]
            b.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
    return arm


def bind(body_obj, arm):
    body_obj.parent = arm
    mod = body_obj.modifiers.new("Armature", "ARMATURE")
    mod.object = arm


# ---- animation -----------------------------------------------------------------------------------------------------------


def animate(arm, kind, name, frames, fn):
    """fn(t in 0..1) -> {short bone: {"r": deg xyz, "l": xyz, "s": scalar}}; every bone is keyed on every frame."""
    arm.animation_data_create()
    act = bpy.data.actions.new(f"{kind}_{name}")
    act.use_fake_user = True
    arm.animation_data.action = act
    n = len(kind) + 1
    for f in range(frames + 1):
        pose = fn(f / frames)
        for pb in arm.pose.bones:
            sp = pose.get(pb.name[n:], {})
            pb.rotation_euler = [math.radians(a) for a in sp.get("r", (0, 0, 0))]
            pb.location = sp.get("l", (0, 0, 0))
            s = sp.get("s", 1.0)
            pb.scale = (s, s, s)
            pb.keyframe_insert("rotation_euler", frame=f)
            pb.keyframe_insert("location", frame=f)
            pb.keyframe_insert("scale", frame=f)
    track = arm.animation_data.nla_tracks.new()
    track.name = act.name
    strip = track.strips.new(act.name, 0, act)
    strip.name = act.name
    try:
        if act.slots:
            strip.action_slot = act.slots[0]
    except AttributeError:
        pass
    arm.animation_data.action = None


def merge(*poses):
    out = {}
    for p in poses:
        for k, v in p.items():
            o = out.setdefault(k, {})
            for key, val in v.items():
                if key == "s":
                    o["s"] = o.get("s", 1.0) * val
                else:
                    prev = o.get(key, (0, 0, 0))
                    o[key] = tuple(prev[i] + val[i] for i in range(3))
    return out


def smooth01(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


TROT = {"FL": 0.0, "BR": 0.0, "FR": 0.5, "BL": 0.5}
BOUND = {"FL": 0.0, "FR": 0.12, "BL": 0.5, "BR": 0.62}
WALK = {"BL": 0.0, "FL": 0.25, "BR": 0.5, "FR": 0.75}


def gait(t, phases, A, B, back_a=None):
    out = {}
    for leg, ph in phases.items():
        a = math.tau * (t + ph)
        amp = A if leg[0] == "F" else (back_a if back_a is not None else A)
        out[f"leg{leg}_up"] = {"r": (amp * math.sin(a), 0, 0)}
        out[f"leg{leg}_lo"] = {"r": (-B * max(0.0, math.cos(a)), 0, 0)}
    return out


def walk_fn(phases, A, B, bob, pitch=0.0, sway=0.0, roll=0.0, head=0.0, tail=12.0, back_a=None, extra=None):
    def fn(t):
        w = math.tau * t
        p = gait(t, phases, A, B, back_a)
        p = merge(p, {
            "root": {"r": (-pitch, 0, 0)},
            "hips": {"l": (0, 0, bob * math.cos(2 * w)), "r": (sway * math.cos(2 * w), roll * math.sin(w), 0)},
            "chest": {"r": (-sway * math.cos(2 * w), -roll * 1.4 * math.sin(w), 0)},
            "head": {"r": (head * math.cos(2 * w) + pitch * 0.6, roll * 0.8 * math.sin(w), 0)},
            "tail": {"r": (0, 0, tail * math.sin(w))},
        })
        if extra:
            p = merge(p, extra(t))
        return p
    return fn


def idle_fn(breath, look=18.0, tail=10.0, extra=None):
    def fn(t):
        w = math.tau * t
        p = {
            "hips": {"l": (0, 0, breath * math.sin(2 * w))},
            "chest": {"r": (1.5 * math.sin(2 * w), 0, 0)},
            "head": {"r": (4 * math.sin(w + 1.0), 0, look * math.sin(w))},
            "tail": {"r": (0, 0, tail * math.sin(2 * w))},
        }
        if extra:
            p = merge(p, extra(t))
        return p
    return fn


def die_fn(lift, half_width, extra=None):
    """Hop, roll onto the right side and go limp. Ends lying still on the ground."""
    def fn(t):
        e = smooth01(t / 0.7)
        hop = math.sin(math.pi * min(1.0, t / 0.35)) * lift if t < 0.35 else 0.0
        settle = smooth01((t - 0.7) / 0.3)
        p = {
            "root": {"r": (0, 84 * e, 0), "l": (0, 0, half_width * e + hop)},
            "head": {"r": (-25 * e + 8 * settle, 0, 10 * e), },
            "chest": {"r": (-6 * e, 0, 0)},
            "tail": {"r": (0, 0, 20 * e)},
        }
        for i, leg in enumerate(LEGS):
            k = 1 if leg[1] == "L" else -1
            p[f"leg{leg}_up"] = {"r": ((18 if leg[0] == "F" else -14) * e + k * 6 * settle, 0, 0)}
            p[f"leg{leg}_lo"] = {"r": (-(30 + 8 * i) * e, 0, 0)}
        if extra:
            p = merge(p, extra(t))
        return p
    return fn


def finish(kind, body, spec, anims):
    arm = build_rig(kind, spec)
    obj = body.mesh(f"Enemy_{kind}_body")
    bind(obj, arm)
    for name, frames, fn in anims:
        animate(arm, kind, name, frames, fn)
    return arm


def mirror_x(p):
    return (-p[0], p[1], p[2])


def pair(fn, p, *args, **kw):
    """Calls fn for a point and its X mirror; `d` (direction) in kw is mirrored as well."""
    fn(p, *args, **kw)
    kw2 = dict(kw)
    if "d" in kw2:
        kw2["d"] = mirror_x(kw2["d"])
    fn(mirror_x(p), *args, **kw2)


# ---- creatures -----------------------------------------------------------------------------------------------------------


def eye_pair(b, P, x, y, z, r, socket=True, yaw=18):
    for sx in (-1, 1):
        if socket:
            b.blob((sx * x, y - r * 0.2, z), (r * 1.3, r * 0.7, r * 1.0), "head", P["char"], rot=(0, sx * -12, sx * -yaw),
                   seg=10, rings=6)
        b.blob((sx * (x + r * 0.05), y + r * 0.1, z + r * 0.08), (r * 1.08, r * 0.5, r * 0.72), "head", P["eyes"],
               rot=(0, sx * -12, sx * -yaw), seg=10, rings=6)


def build_runner(P):
    kind = "runner"
    J = {"scale": 0.8, "hips": (0, -0.15, 0.31), "chest": ((0, -0.02, 0.33), (0, 0.16, 0.36)),
         "head": ((0, 0.20, 0.40), (0, 0.46, 0.38)), "tail": ((0, -0.25, 0.34), (0, -0.50, 0.48))}
    J.update(legs(front=((0.14, 0.28), (0.165, 0.14), (0.19, 0.03)),
                  back=((-0.16, 0.29), (-0.22, 0.13), (-0.17, 0.03)), w={"F": 0.09, "B": 0.095}))
    spec = rig_spec(J)
    b = Body(kind, [s[0] for s in spec])
    O, C, K, A = P["orange"], P["cream"], P["char"], P["amber"]
    # torso: two overlapping masses plus a cream bib
    b.blob((0, -0.12, 0.32), (0.13, 0.17, 0.125), "hips", O)
    b.blob((0, 0.06, 0.34), (0.145, 0.17, 0.14), "chest", O)
    b.blob((0, -0.04, 0.33), (0.135, 0.14, 0.13), "hips", O)
    b.blob((0, 0.16, 0.28), (0.1, 0.085, 0.1), "chest", C)
    b.blob((0, 0.19, 0.38), (0.09, 0.1, 0.09), "chest", O, rot=(-35, 0, 0))
    # head: big fox head, cream muzzle, tall ears
    b.blob((0, 0.28, 0.43), (0.13, 0.125, 0.11), "head", O)
    b.blob((0, 0.34, 0.39), (0.1, 0.09, 0.07), "head", C)
    b.limb((0, 0.37, 0.40), (0, 0.475, 0.38), 0.055, 0.02, "head", C, seg=8, joint=False)
    b.blob((0, 0.48, 0.38), (0.022, 0.02, 0.018), "head", K, seg=8, rings=5)
    eye_pair(b, P, 0.066, 0.384, 0.458, 0.043, yaw=22)
    for sx in (-1, 1):
        # big pointed fox ears (broad face forward) with charcoal tips, cream cheek tufts
        b.crystal((sx * 0.08, 0.28, 0.49), (sx * 0.55, -0.15, 1), 0.19, 0.062, "head", O, tip=K, sides=4, tipf=0.42,
                  wide=(1, 0, 0), flat=0.42)
        b.crystal((sx * 0.115, 0.28, 0.4), (sx * 1, -0.8, -0.15), 0.12, 0.04, "head", C, sides=4, tipf=0.6)
    # mane: six long backswept charcoal blades, amber along the outer quarter. Spine blades are thin across X; the
    # fanned pairs lie broad side up so they read from the top-down camera.
    blades = [((0, 0.2, 0.51), (0, -0.95, 1), 0.37, 0.085, "head", None),
              ((0, -0.04, 0.46), (0, -1, 0.72), 0.5, 0.095, "chest", None),
              ((0.075, 0.1, 0.45), (0.8, -0.95, 0.62), 0.46, 0.09, "chest", (0.95, 0.8, 0)),
              ((0.075, -0.14, 0.43), (0.9, -1, 0.42), 0.4, 0.08, "hips", (1, 0.9, 0))]
    for p, d, ln, r, bone, wide in blades:
        if wide is None:
            b.crystal(p, d, ln, r, bone, K, tip=A, tipf=0.25, sides=4, wide=(0, 1, 0), flat=0.3, taper=0.6)
        else:
            for sx in (-1, 1):
                b.crystal((sx * p[0], p[1], p[2]), (sx * d[0], d[1], d[2]), ln, r, bone, K, tip=A, tipf=0.25, sides=4,
                          wide=(sx * wide[0], wide[1], wide[2]), flat=0.3, taper=0.6)
    # bushy tail with a flame tip
    b.limb((0, -0.24, 0.34), (0, -0.45, 0.45), 0.06, 0.08, "tail", O, joint=True)
    for d, ln in (((0, -1, 0.7), 0.22), ((0.5, -1, 0.5), 0.16), ((-0.5, -1, 0.5), 0.16), ((0, -0.6, 1), 0.18)):
        b.crystal((0, -0.49, 0.47), d, ln, 0.05, "tail", A, sides=5, tipf=0.5)
    # legs: chunky orange tops, charcoal socks, little amber claws
    for leg in LEGS:
        top, knee, paw = J["leg" + leg]
        big = 0.07 if leg[0] == "B" else 0.06
        b.blob(top, (big * 1.2, big * 1.5, big * 1.5), f"leg{leg}_up", O)
        b.limb(top, knee, big, 0.042, f"leg{leg}_up", O, seg=8)
        b.limb(knee, paw, 0.038, 0.034, f"leg{leg}_lo", K, seg=8)
        b.blob((paw[0], paw[1] + 0.018, 0.026), (0.042, 0.052, 0.028), f"leg{leg}_lo", K, seg=8, rings=5)
        for cx in (-0.02, 0.02):
            b.crystal((paw[0] + cx, paw[1] + 0.06, 0.022), (0, 1, -0.3), 0.04, 0.011, f"leg{leg}_lo", A, sides=4)
    anims = [
        ("walk", 16, walk_fn(BOUND, 34, 55, 0.018, pitch=6, sway=4, head=-3, tail=10)),
        ("idle", 72, idle_fn(0.006, look=20)),
        ("die", 30, die_fn(0.12, 0.14)),
    ]
    return finish(kind, b, spec, anims)


def build_skitter(P):
    kind = "skitter"
    J = {"scale": 0.5, "hips": (0, -0.08, 0.13), "chest": ((0, -0.02, 0.14), (0, 0.12, 0.14)),
         "head": ((0, 0.13, 0.15), (0, 0.31, 0.12))}
    J.update(legs(front=((0.10, 0.09), (0.12, 0.05), (0.135, 0.018)),
                  back=((-0.10, 0.09), (-0.125, 0.05), (-0.105, 0.018)), w={"F": 0.095, "B": 0.1}))
    spec = rig_spec(J)
    b = Body(kind, [s[0] for s in spec])
    T, C, K, M, MT = P["teal"], P["cream"], P["char"], P["skbase"], P["sktip"]
    b.blob((0, -0.03, 0.145), (0.14, 0.17, 0.115), "hips", T)
    b.blob((0, 0.02, 0.105), (0.115, 0.17, 0.07), "chest", C)
    b.blob((0, 0.07, 0.14), (0.125, 0.10, 0.10), "chest", T)
    b.blob((0, 0.165, 0.14), (0.095, 0.09, 0.082), "head", T)
    b.blob((0, 0.205, 0.125), (0.075, 0.07, 0.06), "head", C)
    b.limb((0, 0.23, 0.125), (0, 0.30, 0.11), 0.042, 0.014, "head", C, seg=8, joint=False)
    b.blob((0, 0.303, 0.11), (0.016, 0.015, 0.013), "head", K, seg=8, rings=5)
    eye_pair(b, P, 0.048, 0.228, 0.16, 0.027, yaw=24)
    for sx in (-1, 1):
        b.crystal((sx * 0.065, 0.15, 0.205), (sx * 0.6, -0.2, 1), 0.09, 0.03, "head", T, tip=MT, sides=4, tipf=0.5)
    # crystal coat: fewer, bigger backswept shards over the upper back (teal base, pale tip, soft glow)
    n = 26
    for i in range(n):
        zf = 1 - (i + 0.5) / n
        rr = math.sqrt(1 - zf * zf)
        ang = i * 2.39996
        nx, ny, nz = rr * math.cos(ang), rr * math.sin(ang), zf
        if nz < 0.18 or ny > 0.55:
            continue
        p = Vector((0.14 * nx * 0.92, -0.03 + 0.17 * ny * 0.92, 0.145 + 0.115 * nz * 0.92))
        d = Vector((nx * 0.8, ny * 0.5 - 1.0, nz * 1.2)).normalized()
        ln = 0.16 + 0.19 * nz * (1 - 0.35 * max(0.0, ny)) + b.rng.uniform(-0.02, 0.02)
        bone = "chest" if p.y > 0.03 else "hips"
        b.crystal(p, d, ln, 0.046 + 0.014 * nz, bone, M, tip=MT, sides=5, tipf=0.3)
    for leg in LEGS:
        top, knee, paw = J["leg" + leg]
        b.limb(top, knee, 0.04, 0.03, f"leg{leg}_up", T, seg=8)
        b.limb(knee, paw, 0.028, 0.024, f"leg{leg}_lo", K, seg=8)
        b.blob((paw[0], paw[1] + 0.012, 0.018), (0.03, 0.036, 0.019), f"leg{leg}_lo", K, seg=8, rings=5)
    anims = [
        ("walk", 10, walk_fn(TROT, 38, 50, 0.012, pitch=3, roll=4, head=4, tail=0)),
        ("idle", 60, idle_fn(0.004, look=25, extra=lambda t: {"head": {"r": (6 * max(0, math.sin(math.tau * 3 * t)) ** 8, 0, 0)}})),
        ("die", 27, die_fn(0.08, 0.12)),
    ]
    return finish(kind, b, spec, anims)


def build_disruptor(P):
    kind = "disruptor"
    J = {"scale": 0.9, "hips": (0, -0.17, 0.3), "chest": ((0, -0.02, 0.34), (0, 0.18, 0.39)),
         "head": ((0, 0.24, 0.45), (0, 0.46, 0.45)), "tail": ((0, -0.27, 0.33), (0, -0.55, 0.29))}
    J.update(legs(front=((0.15, 0.28), (0.17, 0.14), (0.19, 0.03)),
                  back=((-0.17, 0.29), (-0.23, 0.13), (-0.18, 0.03)), w={"F": 0.09, "B": 0.095}))
    crest = [("crest", (0, 0.30, 0.54), (0, 0.27, 0.68), "head")]
    spec = rig_spec(J, crest)
    b = Body(kind, [s[0] for s in spec])
    V, C, K, CV, VT = P["violet"], P["lilac"], P["char"], P["cviolet"], P["vtip"]
    b.blob((0, -0.15, 0.31), (0.12, 0.15, 0.115), "hips", V)
    b.blob((0, 0.07, 0.34), (0.13, 0.16, 0.13), "chest", V)
    b.blob((0, -0.04, 0.32), (0.12, 0.14, 0.12), "hips", V)
    b.blob((0, 0.2, 0.4), (0.085, 0.1, 0.09), "chest", V, rot=(-35, 0, 0))
    b.blob((0, 0.33, 0.48), (0.135, 0.13, 0.115), "head", V)
    b.blob((0, 0.39, 0.445), (0.095, 0.085, 0.07), "head", C)
    b.limb((0, 0.41, 0.45), (0, 0.50, 0.43), 0.05, 0.02, "head", C, seg=8, joint=False)
    b.blob((0, 0.503, 0.43), (0.02, 0.018, 0.016), "head", K, seg=8, rings=5)
    eye_pair(b, P, 0.062, 0.425, 0.495, 0.031)
    # crest: a big fan of violet crystals flaring back off the head (bone "crest", it flashes / swells while casting);
    # wide and swept back so the disruptor reads from the top-down camera
    for d, ln, r, x in (((0, -0.85, 1), 0.46, 0.095, 0), ((0.6, -0.75, 0.8), 0.46, 0.088, 0.045),
                        ((-0.6, -0.75, 0.8), 0.46, 0.088, -0.045), ((1.2, -0.5, 0.45), 0.4, 0.078, 0.08),
                        ((-1.2, -0.5, 0.45), 0.4, 0.078, -0.08)):
        b.crystal((x, 0.30, 0.55), d, ln, r, "crest", CV, tip=VT, sides=5, tipf=0.35)
    # back: tall spine shards with wide flaring side shards
    for p, ln, bone in (((0, 0.1, 0.46), 0.34, "chest"), ((0, -0.06, 0.46), 0.36, "chest"), ((0, -0.2, 0.42), 0.28, "hips"),
                        ((0, -0.31, 0.37), 0.2, "hips")):
        b.crystal(p, (0, -0.9, 1), ln, 0.07, bone, CV, tip=VT, sides=5, tipf=0.35)
        for sx in (-1, 1):
            b.crystal((sx * 0.09, p[1] - 0.03, p[2] - 0.05), (sx * 1.2, -0.6, 0.6), ln * 0.9, 0.065, bone, CV, tip=VT,
                      tipf=0.35)
    # long tail ending in a crystal
    b.limb((0, -0.27, 0.33), (0, -0.50, 0.3), 0.055, 0.035, "tail", V, seg=8)
    b.crystal((0, -0.52, 0.3), (0, -1, 0.35), 0.2, 0.055, "tail", CV, tip=VT, sides=5, tipf=0.4)
    for leg in LEGS:
        top, knee, paw = J["leg" + leg]
        big = 0.065 if leg[0] == "B" else 0.058
        b.blob(top, (big * 1.2, big * 1.5, big * 1.5), f"leg{leg}_up", V)
        b.limb(top, knee, big, 0.04, f"leg{leg}_up", V, seg=8)
        b.limb(knee, paw, 0.036, 0.032, f"leg{leg}_lo", V, seg=8)
        b.blob((paw[0], paw[1] + 0.016, 0.026), (0.04, 0.05, 0.027), f"leg{leg}_lo", K, seg=8, rings=5)
        b.crystal((paw[0], paw[1] + 0.045, 0.02), (0, 1, -0.2), 0.035, 0.012, f"leg{leg}_lo", CV, sides=4)

    def crest_pulse(t):
        return {"crest": {"s": 1 + 0.05 * math.sin(math.tau * 2 * t)}}

    def cast(t):
        env = smooth01(t / 0.35) * (1 - smooth01((t - 0.68) / 0.32))
        flash = math.exp(-((t - 0.5) / 0.1) ** 2)
        return {
            "hips": {"r": (26 * env, 0, 0), "l": (0, -0.02 * env, 0.03 * env)},
            "chest": {"r": (6 * env, 0, 0)},
            "head": {"r": (-22 * env, 0, 0)},
            "crest": {"s": 1 + 0.18 * env + 0.3 * flash},
            "tail": {"r": (-12 * env, 0, 0)},
            "legFL_up": {"r": (40 * env, 0, 0)}, "legFR_up": {"r": (34 * env, 0, 0)},
            "legFL_lo": {"r": (-50 * env, 0, 0)}, "legFR_lo": {"r": (-45 * env, 0, 0)},
            "legBL_up": {"r": (-26 * env, 0, 0)}, "legBR_up": {"r": (-26 * env, 0, 0)},
        }

    anims = [
        ("walk", 20, walk_fn(TROT, 28, 48, 0.012, pitch=2, roll=3, head=-2, tail=14, extra=crest_pulse)),
        ("idle", 60, idle_fn(0.006, look=16, extra=crest_pulse)),
        ("die", 30, die_fn(0.1, 0.13, extra=lambda t: {"crest": {"s": 1 - 0.5 * smooth01(t / 0.8)}})),
        ("cast", 24, cast),
    ]
    return finish(kind, b, spec, anims)


def build_brute(P):
    kind = "brute"
    J = {"scale": 1.8, "hips": (0, -0.34, 0.66), "chest": ((0, -0.08, 0.80), (0, 0.30, 0.90)),
         "head": ((0, 0.36, 0.84), (0, 0.76, 0.80))}
    J.update(legs(front=((0.22, 0.94), (0.30, 0.50), (0.40, 0.14)),
                  back=((-0.38, 0.60), (-0.28, 0.32), (-0.36, 0.08)),
                  w={"F": (0.5, 0.6, 0.54), "B": (0.27, 0.3, 0.29)}))
    spec = rig_spec(J)
    b = Body(kind, [s[0] for s in spec])
    D, CY, CT, S = P["deep"], P["cyan"], P["ctip"], P["stone"]
    # hunched gorilla mass: huge chest and shoulders, smaller rear
    b.blob((0, -0.32, 0.68), (0.34, 0.32, 0.30), "hips", D, seg=12, rings=8)
    b.blob((0, 0.04, 0.86), (0.46, 0.42, 0.40), "chest", D, seg=14, rings=9)
    for sx in (-1, 1):
        b.blob((sx * 0.42, 0.18, 0.96), (0.25, 0.27, 0.25), "chest", D, seg=12, rings=8)
    # head low between the shoulders, heavy brow, glowing eyes
    b.blob((0, 0.46, 0.82), (0.21, 0.2, 0.19), "head", D, seg=12, rings=8)
    b.blob((0, 0.6, 0.76), (0.15, 0.11, 0.11), "head", S, seg=10, rings=7)
    b.blob((0, 0.58, 0.91), (0.2, 0.08, 0.055), "head", S, rot=(-12, 0, 0), seg=10, rings=6)
    for sx in (-1, 1):
        b.blob((sx * 0.09, 0.645, 0.855), (0.045, 0.022, 0.032), "head", P["aeyes"], rot=(0, sx * -12, sx * -20),
               seg=10, rings=6)
        b.crystal((sx * 0.13, 0.44, 0.98), (sx * 0.5, -0.4, 1), 0.18, 0.055, "head", CY, sides=5)
    # big cyan crystal clusters on the shoulders and along the back (tallest tip ~1.8 m)
    for sx in (-1, 1):
        for d, ln, r, off in (((0.3, -0.25, 1), 0.78, 0.13, (0.4, 0.16, 1.1)), ((0.9, 0.1, 0.75), 0.5, 0.1, (0.55, 0.22, 1.02)),
                              ((0.55, -0.7, 0.9), 0.55, 0.1, (0.34, 0.02, 1.1)), ((0.15, 0.45, 1), 0.42, 0.09, (0.34, 0.3, 1.06)),
                              ((0.95, -0.3, 0.35), 0.34, 0.08, (0.6, 0.08, 0.92))):
            b.crystal((sx * off[0], off[1], off[2]), (sx * d[0], d[1], d[2]), ln, r, "chest", CY, tip=CT, sides=6, tipf=0.3)
    for p, ln, r, bone in (((0, 0.0, 1.2), 0.62, 0.13, "chest"), ((0, -0.2, 1.1), 0.5, 0.11, "chest"),
                           ((0, -0.36, 0.94), 0.4, 0.1, "hips"), ((0, -0.54, 0.84), 0.28, 0.08, "hips"),
                           ((0.17, -0.24, 1.0), 0.34, 0.085, "hips"), ((-0.17, -0.24, 1.0), 0.34, 0.085, "hips"),
                           ((0.16, -0.48, 0.84), 0.22, 0.065, "hips"), ((-0.16, -0.48, 0.84), 0.22, 0.065, "hips")):
        b.crystal(p, (p[0] * 2.5, -0.55, 1), ln, r, bone, CY, tip=CT, sides=6, tipf=0.3)
    # arms (front legs): thick, knuckle-walking fists with crystal knuckles; short heavy hind legs
    for leg in LEGS:
        top, knee, paw = J["leg" + leg]
        sx = -1 if leg[1] == "L" else 1
        if leg[0] == "F":
            b.limb(top, knee, 0.2, 0.14, f"leg{leg}_up", D, seg=12)
            b.limb(knee, (paw[0], paw[1], paw[2] + 0.06), 0.14, 0.19, f"leg{leg}_lo", D, seg=12)
            b.blob((paw[0], paw[1] + 0.03, 0.13), (0.18, 0.19, 0.13), f"leg{leg}_lo", S, seg=12, rings=7)
            for cx in (-0.09, 0.0, 0.09):
                b.crystal((paw[0] + cx, paw[1] + 0.16, 0.07), (0, 1, -0.15), 0.13, 0.04, f"leg{leg}_lo", CY, sides=4)
            b.crystal((paw[0] + sx * 0.12, paw[1] - 0.04, 0.42), (sx * 0.8, -0.4, 0.6), 0.24, 0.06, f"leg{leg}_lo", CY)
        else:
            b.limb(top, knee, 0.2, 0.14, f"leg{leg}_up", D, seg=12)
            b.limb(knee, paw, 0.14, 0.11, f"leg{leg}_lo", D, seg=10)
            b.blob((paw[0], paw[1] + 0.06, 0.07), (0.13, 0.18, 0.075), f"leg{leg}_lo", S, seg=10, rings=6)
            for cx in (-0.055, 0.055):
                b.crystal((paw[0] + cx, paw[1] + 0.21, 0.05), (0, 1, -0.2), 0.09, 0.032, f"leg{leg}_lo", CY, sides=4)
    anims = [
        ("walk", 36, walk_fn(WALK, 24, 40, 0.035, pitch=2, sway=2, roll=5, head=3, back_a=22)),
        ("idle", 90, idle_fn(0.015, look=14, extra=lambda t: {"chest": {"r": (2.5 * math.sin(math.tau * t), 0, 0)}})),
        ("die", 36, die_fn(0.05, 0.4)),
    ]
    return finish(kind, b, spec, anims)


def build_colossus(P):
    kind = "colossus"
    J = {"scale": 3.0, "hips": (0, -0.65, 1.40), "chest": ((0, -0.1, 1.5), (0, 0.6, 1.62)),
         "head": ((0, 0.85, 1.55), (0, 1.55, 1.35)), "tail": ((0, -1.25, 1.35), (0, -2.0, 0.95))}
    J.update(legs(front=((0.48, 1.42), (0.55, 0.76), (0.62, 0.16)),
                  back=((-0.75, 1.34), (-0.62, 0.72), (-0.72, 0.16)), w={"F": 0.66, "B": 0.6}))
    core = [("core", (0, -0.15, 2.05), (0, -0.15, 2.4), "hips")]
    spec = rig_spec(J, core)
    b = Body(kind, [s[0] for s in spec])
    # brute palette: deep teal body, darker plates, soft cyan crystals, one bright amber core
    S, D, K = P["deep"], P["plate"], P["char"]
    CY, CT, CO = P["cyan"], P["ctip"], P["core"]
    CV = CA = CY
    # massive faceted stone body with darker teal armour plates
    b.blob((0, -0.62, 1.45), (0.74, 0.8, 0.66), "hips", S, seg=12, rings=8, smooth=False)
    b.blob((0, 0.32, 1.58), (0.84, 0.74, 0.72), "chest", S, seg=12, rings=8, smooth=False)
    for sx in (-1, 1):
        b.blob((sx * 0.66, 0.42, 1.72), (0.36, 0.42, 0.34), "chest", D, rot=(0, sx * 25, 0), seg=8, rings=6, smooth=False)
        b.blob((sx * 0.6, -0.72, 1.6), (0.32, 0.4, 0.3), "hips", D, rot=(0, sx * 25, 0), seg=8, rings=6, smooth=False)
    # head: broad, low, crowned with a forward crystal horn, four glowing eyes
    b.blob((0, 1.1, 1.48), (0.46, 0.46, 0.38), "head", S, seg=10, rings=7, smooth=False)
    b.blob((0, 1.38, 1.32), (0.32, 0.26, 0.2), "head", D, seg=10, rings=6, smooth=False)
    b.blob((0, 1.32, 1.68), (0.42, 0.14, 0.09), "head", D, rot=(-15, 0, 0), seg=8, rings=5, smooth=False)
    for sx in (-1, 1):
        b.blob((sx * 0.2, 1.47, 1.55), (0.085, 0.04, 0.06), "head", P["aeyes"], rot=(0, 0, sx * -20), seg=10, rings=6)
        b.blob((sx * 0.33, 1.38, 1.47), (0.05, 0.03, 0.04), "head", P["aeyes"], rot=(0, 0, sx * -35), seg=8, rings=5)
        b.crystal((sx * 0.3, 1.05, 1.78), (sx * 0.5, -0.3, 1), 0.5, 0.1, "head", CV, sides=5)
        b.crystal((sx * 0.42, 1.35, 1.25), (sx * 0.4, 1, 0.2), 0.32, 0.07, "head", CA, sides=5)
    b.crystal((0, 1.45, 1.62), (0, 1, 0.9), 0.6, 0.12, "head", CY, tip=CT, sides=6, tipf=0.4)
    # glowing core on the back, ringed by tall prismatic crystals: reads as the boss from the top-down camera
    b.gem((0, -0.15, 2.2), 0.4, "core", CO, subdiv=1)
    b.blob((0, -0.15, 2.0), (0.48, 0.48, 0.18), "core", D, seg=10, rings=5, smooth=False)
    ring = [CV, CY, CA]
    for i in range(9):
        a = math.tau * i / 9 + 0.2
        p = (0.52 * math.cos(a), -0.15 + 0.6 * math.sin(a), 2.0 - 0.05 * abs(math.sin(a)))
        d = (math.cos(a) * 0.55, math.sin(a) * 0.55, 1)
        ln = 1.05 + 0.12 * math.cos(3 * a) if math.sin(a) < 0.5 else 0.75
        b.crystal(p, d, ln, 0.15, "chest" if p[1] > -0.1 else "hips", ring[i % 3], tip=CT, sides=6, tipf=0.3)
    # shoulder + flank clusters and a spiked tail
    for sx in (-1, 1):
        for off, d, ln, r, m, bone in (((0.72, 0.45, 1.92), (0.8, 0.2, 0.9), 0.62, 0.13, CV, "chest"),
                                       ((0.85, 0.2, 1.75), (1, -0.2, 0.4), 0.45, 0.1, CY, "chest"),
                                       ((0.62, 0.7, 1.95), (0.5, 0.6, 1), 0.4, 0.09, CA, "chest"),
                                       ((0.68, -0.7, 1.8), (0.8, -0.3, 0.9), 0.55, 0.12, CY, "hips"),
                                       ((0.55, -1.05, 1.6), (0.6, -0.8, 0.7), 0.42, 0.1, CA, "hips"),
                                       ((0.78, -0.4, 1.55), (1, 0, 0.3), 0.35, 0.09, CV, "hips")):
            b.crystal((sx * off[0], off[1], off[2]), (sx * d[0], d[1], d[2]), ln, r, bone, m, tip=CT, sides=6, tipf=0.3)
    for p, ln, m in (((0, -1.0, 1.98), 0.6, CV), ((0, 0.62, 2.12), 0.55, CA), ((0, -1.3, 1.72), 0.45, CY)):
        b.crystal(p, (0, -0.5 if p[1] < 0 else 0.3, 1), ln, 0.13, "hips" if p[1] < 0 else "chest", m, sides=6)
    b.limb((0, -1.2, 1.4), (0, -1.9, 1.0), 0.32, 0.16, "tail", S, seg=8, smooth=False)
    for i, (y, z) in enumerate(((-1.35, 1.62), (-1.6, 1.45), (-1.85, 1.25))):
        b.crystal((0, y, z), (0, -0.7, 1), 0.4 - 0.08 * i, 0.09, "tail", ring[i], sides=5)
    b.crystal((0, -1.95, 0.98), (0, -1, 0.3), 0.35, 0.1, "tail", CV, sides=5)
    # pillar legs with crystal-clawed feet
    for leg in LEGS:
        top, knee, paw = J["leg" + leg]
        b.blob(top, (0.38, 0.42, 0.42), f"leg{leg}_up", S, seg=10, rings=7, smooth=False)
        b.limb(top, knee, 0.32, 0.24, f"leg{leg}_up", S, seg=10, smooth=False)
        b.limb(knee, (paw[0], paw[1], 0.2), 0.24, 0.3, f"leg{leg}_lo", D, seg=10, smooth=False, joint=False)
        b.blob((paw[0], paw[1] + 0.05, 0.14), (0.34, 0.38, 0.13), f"leg{leg}_lo", S, seg=10, rings=6, smooth=False)
        for cx in (-0.17, 0.0, 0.17):
            b.crystal((paw[0] + cx, paw[1] + 0.38, 0.08), (0, 1, -0.1), 0.18, 0.055, f"leg{leg}_lo", CY, sides=4)
        b.crystal((paw[0], paw[1], 0.75), (paw[0], 0.1, 0.5), 0.3, 0.07, f"leg{leg}_lo",
                  ring[LEGS.index(leg) % 3], sides=5)

    def core_pulse(t):
        return {"core": {"s": 1 + 0.07 * math.sin(math.tau * 2 * t)}}

    anims = [
        ("walk", 48, walk_fn(WALK, 18, 32, 0.05, pitch=1, sway=1.5, roll=3.5, head=3, tail=8, extra=core_pulse)),
        ("idle", 96, idle_fn(0.025, look=12, tail=6, extra=core_pulse)),
        ("die", 36, die_fn(0.0, 0.62, extra=lambda t: {"core": {"s": 1 - 0.6 * smooth01((t - 0.3) / 0.7)}})),
    ]
    return finish(kind, b, spec, anims)


# ---- export -----------------------------------------------------------------------------------------------------------------


def export(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
        for c in o.children_recursive:
            c.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    OUT.mkdir(parents=True, exist_ok=True)
    path = str(OUT / "enemies.glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_normals=True,
        export_texcoords=True,
        export_vertex_color="ACTIVE",
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_skins=True,
        export_def_bones=False,
        export_morph=False,
        export_lights=False,
        export_cameras=False,
        export_extras=False,
        export_anim_slide_to_zero=True,
        export_force_sampling=True,
        export_frame_step=1,
    )
    print(f"EXPORTED {path}")


def build_all():
    clear_scene()
    P = palette()
    roots = [build_runner(P), build_skitter(P), build_disruptor(P), build_brute(P), build_colossus(P)]
    bpy.context.scene.frame_set(0)
    export(roots)
    return roots


if __name__ == "__main__":
    build_all()
