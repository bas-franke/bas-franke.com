"""
Builds props_arch.glb: the hotel's architectural brass-and-glass fittings for Last Light.

    blender --background --factory-startup --python arch.py -- <output-dir> [preview-dir]

  * revolvingDoor        brass drum canopy, curved glass enclosure on the sides, brass floor ring, and a child
                         `revolvingDoor_wings` (4 glass wings in brass frames on a brass post) that spins around y.
                         4.08 m across, 3.12 m tall, origin at the floor centre, openings towards glTF -Z / +Z.
  * glassRailing         one 2 m mezzanine balustrade segment along X: dark marble edge, brass base shoe, two frameless
                         glass panes with green-tinted edges, brass cap channel and round handrail. Origin at the floor
                         centre of the segment, the glass in the plane z = 0.
  * brassReveal          a 1 m tall brass corner angle for the travertine columns; the corner sits at the origin and the
                         legs run along glTF -X and -Z (so it wraps the column corner facing +X / +Z).
  * deskTrim             1 m of reception-desk / bar front trim along X: brass plinth with a warm LED underglow at the
                         floor and an LED line with a brass reveal under the marble top (material `DeskGlow`). Origin at
                         the floor on the counter face, the trim stands proud towards glTF -Z (the front).

Same conventions as build_props.py: Blender +Y is the front (glTF -Z), real-world metres, plain Principled materials
(no textures, so the pack stays tiny).
"""

import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = Path(ARGS[0]) if ARGS else Path("models/zombies")
PREVIEW = Path(ARGS[1]) if len(ARGS) > 1 else None


# ---- helpers ---------------------------------------------------------------------------------------------------------

def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)


_mats = {}


def mat(name, color, metal=0.0, rough=0.5, alpha=1.0, emit=None, strength=0.0):
    if name in _mats:
        return _mats[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*color, 1.0)
    b.inputs["Metallic"].default_value = metal
    b.inputs["Roughness"].default_value = rough
    if alpha < 1.0:
        b.inputs["Alpha"].default_value = alpha
        try:
            m.surface_render_method = "BLENDED"
        except Exception:
            m.blend_method = "BLEND"
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1.0)
        b.inputs["Emission Strength"].default_value = strength
    _mats[name] = m
    return m


def brass():
    # Polished, slightly warm brass like the sheet's: bright highlights, golden body.
    return mat("Brass", (0.80, 0.52, 0.19), metal=1.0, rough=0.2)


def glass():
    # Dark base colour: alpha-blended in three, a light base would read milky instead of clear.
    return mat("ArchGlass", (0.05, 0.065, 0.062), rough=0.02, alpha=0.18)


def glass_edge():
    # Float-glass edges read green.
    return mat("GlassEdge", (0.10, 0.32, 0.24), rough=0.05, alpha=0.9)


def dark():
    return mat("DarkMetal", (0.025, 0.022, 0.02), metal=0.6, rough=0.45)


def marble_edge():
    return mat("MarbleEdge", (0.03, 0.028, 0.026), rough=0.12)


def glow():
    return mat("DeskGlow", (0.0, 0.0, 0.0), emit=(1.0, 0.6, 0.26), strength=8.0)


def obj_from_bm(bm, name, material):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    o.data.materials.append(material)
    return o


def box(name, size, loc, material, bevel=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    o = obj_from_bm(bm, name, material)
    if bevel > 0:
        md = o.modifiers.new("b", "BEVEL")
        md.width = bevel
        md.segments = 2
        md.limit_method = "ANGLE"
    return o


def cyl(name, r, h, loc, material, seg=48, axis="Z"):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r, depth=h)
    if axis == "X":
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, "Y"))
    elif axis == "Y":
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, "X"))
    bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    o = obj_from_bm(bm, name, material)
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def ring(name, r0, r1, z0, z1, material, seg=96, a0=0.0, a1=math.tau):
    """A thick ring (or arc of one when a0..a1 is not the full circle) between radii r0 < r1, heights z0 < z1."""
    full = abs((a1 - a0) - math.tau) < 1e-6
    n = seg if full else max(4, int(seg * (a1 - a0) / math.tau))
    bm = bmesh.new()
    rows = []
    for k in range(n + (0 if full else 1)):
        a = a0 + (a1 - a0) * k / n
        c, s = math.cos(a), math.sin(a)
        rows.append([bm.verts.new((r * c, r * s, z)) for (r, z) in ((r0, z0), (r1, z0), (r1, z1), (r0, z1))])
    count = len(rows)
    for k in range(count if full else count - 1):
        a, b = rows[k], rows[(k + 1) % count]
        for i in range(4):
            j = (i + 1) % 4
            bm.faces.new((a[i], b[i], b[j], a[j]))
    if not full:
        bm.faces.new(list(reversed(rows[0])))
        bm.faces.new(rows[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = obj_from_bm(bm, name, material)
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        for md in list(o.modifiers):
            bpy.ops.object.modifier_apply(modifier=md.name)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = name
    o.data.name = name
    return o


def glass_pane(name, w, h, t, loc, rot_z=0.0):
    """A pane whose broad faces get ArchGlass and whose edges get GlassEdge (the green float-glass edge)."""
    o = box(name, (w, t, h), (0, 0, 0), glass())
    o.data.materials.append(glass_edge())
    for p in o.data.polygons:
        if abs(p.normal.y) < 0.5:
            p.material_index = 1
    o.rotation_euler.z = rot_z
    o.location = loc
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return o


# ---- revolving door ---------------------------------------------------------------------------------------------------

R = 2.04
H = 3.12
CANOPY = 0.42


def build_revolving_door():
    parts = []
    # Floor: brass outer ring with a dark threshold disc inside.
    parts.append(ring("ringOuter", R - 0.12, R + 0.02, 0.0, 0.018, brass()))
    parts.append(cyl("floorDisc", R - 0.12, 0.012, (0, 0, 0.006), marble_edge(), seg=96))
    # Canopy drum: brass band, bottom lip, dark ceiling with a ring of downlights, top cap.
    zc = H - CANOPY
    parts.append(ring("drum", R - 0.03, R + 0.04, zc, H, brass()))
    parts.append(ring("lip", R - 0.10, R + 0.06, zc - 0.03, zc + 0.02, brass()))
    parts.append(ring("capRim", R - 0.02, R + 0.06, H - 0.03, H + 0.01, brass()))
    parts.append(cyl("ceiling", R - 0.03, 0.02, (0, 0, zc + 0.01), dark(), seg=96))
    parts.append(cyl("cap", R + 0.02, 0.02, (0, 0, H - 0.005), dark(), seg=96))
    for k in range(10):
        a = k / 10 * math.tau
        parts.append(cyl(f"dl{k}", 0.045, 0.006, (math.cos(a) * 1.35, math.sin(a) * 1.35, zc - 0.001), glow(), seg=16))
    # Curved glass enclosures on the X sides (openings face +-Y, the front and back).
    span = math.radians(104)
    for side in (0.0, math.pi):
        a0, a1 = side - span / 2, side + span / 2
        parts.append(ring(f"glassArc{side:.0f}", R - 0.012, R, 0.03, zc - 0.03, glass(), seg=96, a0=a0, a1=a1))
        # Brass mullions every ~13 degrees, heavier posts at the ends, rails at the foot and at the top.
        steps = 8
        for k in range(steps + 1):
            a = a0 + (a1 - a0) * k / steps
            end = k in (0, steps)
            w = 0.055 if end else 0.026
            post = box(f"mul{side:.0f}_{k}", (w, w, zc), (0, 0, zc / 2), brass(), bevel=0.004)
            post.location = (math.cos(a) * (R - 0.006), math.sin(a) * (R - 0.006), 0)
            post.rotation_euler.z = a
            bpy.context.view_layer.objects.active = post
            post.select_set(True)
            bpy.ops.object.transform_apply(location=True, rotation=True)
            parts.append(post)
        parts.append(ring(f"foot{side:.0f}", R - 0.03, R + 0.015, 0.0, 0.12, brass(), seg=96, a0=a0, a1=a1))
        parts.append(ring(f"mid{side:.0f}", R - 0.025, R + 0.01, 1.02, 1.06, brass(), seg=96, a0=a0, a1=a1))
    door = join(parts, "revolvingDoor")

    # Wings: four glass leaves in brass frames on a brass post, with push bars.
    w = []
    w.append(cyl("post", 0.09, zc - 0.02, (0, 0, (zc - 0.02) / 2), brass(), seg=32))
    leaf_in, leaf_out = 0.1, R - 0.07
    lw = leaf_out - leaf_in
    lc = (leaf_in + leaf_out) / 2
    lh = zc - 0.06
    for k in range(4):
        a = k * math.pi / 2 + math.pi / 4
        pieces = [
            glass_pane(f"leafGlass{k}", lw - 0.08, lh - 0.12, 0.012, (lc, 0, 0.06 + lh / 2)),
            box(f"leafTop{k}", (lw, 0.05, 0.05), (lc, 0, 0.035 + lh), brass(), bevel=0.006),
            box(f"leafBot{k}", (lw, 0.05, 0.1), (lc, 0, 0.06), brass(), bevel=0.006),
            box(f"leafOut{k}", (0.045, 0.05, lh), (leaf_out - 0.0225, 0, 0.04 + lh / 2), brass(), bevel=0.006),
            cyl(f"push{k}a", 0.016, lw - 0.3, (lc, 0.06, 1.05), brass(), seg=16, axis="X"),
            cyl(f"push{k}b", 0.016, lw - 0.3, (lc, -0.06, 1.05), brass(), seg=16, axis="X"),
        ]
        for ky, yy in enumerate((0.06, -0.06)):
            for kx, xx in enumerate((leaf_in + 0.25, leaf_out - 0.25)):
                pieces.append(cyl(f"stand{k}{ky}{kx}", 0.01, 0.06, (xx, yy / 2, 1.05), brass(), seg=10, axis="Y"))
        for p in pieces:
            p.rotation_euler.z = a
            bpy.context.view_layer.objects.active = p
            p.select_set(True)
            bpy.ops.object.transform_apply(rotation=True)
        w.extend(pieces)
    wings = join(w, "revolvingDoor_wings")
    wings.parent = door
    return [door, wings]


# ---- glass railing ----------------------------------------------------------------------------------------------------

def build_glass_railing():
    L = 2.0
    parts = [
        box("edge", (L, 0.17, 0.13), (0, 0, 0.065), marble_edge(), bevel=0.004),
        # Base shoe: a brass U channel the glass sits in.
        box("shoeA", (L, 0.022, 0.08), (0, 0.025, 0.13 + 0.04), brass(), bevel=0.003),
        box("shoeB", (L, 0.022, 0.08), (0, -0.025, 0.13 + 0.04), brass(), bevel=0.003),
        box("shoeBase", (L, 0.072, 0.02), (0, 0, 0.14), brass()),
    ]
    gh = 0.92
    for k, x in enumerate((-L / 4, L / 4)):
        parts.append(glass_pane(f"pane{k}", L / 2 - 0.012, gh, 0.014, (x, 0, 0.15 + gh / 2)))
    top = 0.15 + gh
    parts.append(box("cap", (L, 0.032, 0.03), (0, 0, top), brass(), bevel=0.004))
    parts.append(cyl("rail", 0.026, L, (0, 0, top + 0.05), brass(), seg=24, axis="X"))
    return [join(parts, "glassRailing")]


# ---- brass reveal -----------------------------------------------------------------------------------------------------

def build_brass_reveal():
    # Corner at the origin; legs along Blender -X and +Y (glTF -X and -Z).
    leg, t, h = 0.05, 0.007, 1.0
    a = box("legX", (leg, t, h), (-leg / 2 + t, t / 2, h / 2), brass(), bevel=0.0015)
    b = box("legY", (t, leg, h), (t / 2, leg / 2 - t + t, h / 2), brass(), bevel=0.0015)
    # Shift so the inside corner meets the column corner exactly.
    o = join([a, b], "brassReveal")
    o.data.transform(Matrix.Translation((0, -t, 0)))
    return [o]


# ---- desk trim --------------------------------------------------------------------------------------------------------

def build_desk_trim():
    L = 1.0
    d = 0.016  # how far it stands proud of the counter face (towards +Y = front)
    parts = [
        # Floor: the LED glow tucked under a brass plinth, so the floor in front lights up.
        box("ledLow", (L, 0.012, 0.012), (0, 0.006, 0.006), glow()),
        box("plinth", (L, d + 0.004, 0.075), (0, (d + 0.004) / 2, 0.016 + 0.0375), brass(), bevel=0.002),
        # Under the marble top: a brass reveal line and an LED strip washing down the walnut.
        box("ledTop", (L, 0.01, 0.014), (0, 0.005, 0.958), glow()),
        box("reveal", (L, d, 0.022), (0, d / 2, 0.982), brass(), bevel=0.002),
    ]
    return [join(parts, "deskTrim")]


# ---- export / preview ---------------------------------------------------------------------------------------------------

def export(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    OUT.mkdir(parents=True, exist_ok=True)
    path = str(OUT / "props_arch.glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_normals=True,
        export_texcoords=True,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_lights=False,
        export_cameras=False,
        export_extras=True,
    )
    print(f"EXPORTED {path}")


def studio(target, dist, elev, azim, lens=50, res=(900, 900), floor_mat=None):
    """Dark grey studio like the reference sheet: warm key from the front left, cool-neutral fill, rim from behind."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "GPU"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "OPTIX"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
    except Exception:
        pass
    scene.cycles.samples = 96
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    world = bpy.data.worlds.new("w")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.03, 0.03, 0.032, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.35
    scene.world = world
    # Backdrop: a curved dark grey sweep.
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    floor = bpy.context.active_object
    floor.data.materials.append(floor_mat or mat("Studio", (0.018, 0.018, 0.02), rough=0.3))
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 12, 10), rotation=(math.pi / 2, 0, 0))
    bpy.context.active_object.data.materials.append(mat("Backdrop", (0.02, 0.02, 0.022), rough=0.6))
    tx, ty, tz = target

    def area(name, loc, energy, color, size):
        bpy.ops.object.light_add(type="AREA", location=loc)
        L = bpy.context.active_object
        L.data.energy = energy
        L.data.color = color
        L.data.size = size
        d = Vector(target) - Vector(loc)
        L.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        return L

    area("key", (tx - dist * 0.5, ty - dist * 0.7, tz + dist * 1.1), 520 * dist * dist / 9, (1.0, 0.8, 0.56), dist * 0.5)
    area("fill", (tx + dist * 1.0, ty - dist * 0.5, tz + dist * 0.3), 70 * dist * dist / 9, (0.9, 0.92, 1.0), dist)
    area("rim", (tx, ty + dist, tz + dist * 0.8), 380 * dist * dist / 9, (1.0, 0.82, 0.6), dist * 0.6)
    a, e = math.radians(azim), math.radians(elev)
    cam_loc = (tx + dist * math.sin(a) * math.cos(e), ty - dist * math.cos(a) * math.cos(e), tz + dist * math.sin(e))
    bpy.ops.object.camera_add(location=cam_loc)
    cam = bpy.context.active_object
    cam.data.lens = lens
    cam.rotation_euler = (Vector(target) - Vector(cam_loc)).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam


def render(path):
    bpy.context.scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def preview_all():
    """One render per prop, each in its own studio, compared later with the sheet's panels."""
    PREVIEW.mkdir(parents=True, exist_ok=True)
    jobs = [
        ("revolvingDoor", build_revolving_door, (0, 0, 1.55), 7.5, 10, 25, 50),
        ("glassRailing", build_glass_railing, (0, 0, 0.55), 2.8, 18, 35, 50),
        ("brassReveal", None, None, None, None, None, None),
        ("deskTrim", None, None, None, None, None, None),
    ]
    for name, fn, target, dist, elev, azim, lens in jobs:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        _mats.clear()
        if name == "brassReveal":
            # A travertine column with reveals on its corners, like panel 8.
            trav = mat("Trav", (0.55, 0.45, 0.34), rough=0.5)
            box("col", (1.2, 1.2, 2.4), (0, 0, 1.2), trav)
            for k, (sx, sy) in enumerate(((1, 1), (-1, 1), (-1, -1), (1, -1))):
                for row in range(3):
                    o = build_brass_reveal()[0]
                    o.scale.z = 0.8
                    o.location = (sx * 0.6, sy * 0.6, row * 0.8)
                    # glTF (-X, -Z) legs = Blender (-X, +Y); the corner faces +X / -Y in Blender here.
                    o.rotation_euler.z = math.atan2(sy, sx) - math.atan2(-1, 1)
            box("seam", (0.02, 0.008, 2.4), (0, -0.604, 1.2), brass())
            box("base", (1.24, 1.24, 0.08), (0, 0, 0.04), brass())
            studio((0, 0, 1.1), 4.2, 12, 30)
        elif name == "deskTrim":
            # A 3 m counter: walnut body, black marble top, three trims along the front, like panel 7.
            walnut = mat("Walnut", (0.13, 0.055, 0.025), rough=0.4)
            marble = mat("Marble", (0.02, 0.02, 0.022), rough=0.08)
            box("body", (3.0, 0.9, 1.0), (0, 0.45, 0.5), walnut)
            box("top", (3.1, 1.0, 0.1), (0, 0.45, 1.05), marble)
            for k in range(3):
                o = build_desk_trim()[0]
                # The trim's front is Blender +Y; the counter face here is at y = 0 facing -Y.
                o.rotation_euler.z = math.pi
                o.location = (-1 + k, 0, 0)
            studio((0, 0, 0.6), 4.2, 14, 25, floor_mat=mat("Floor", (0.02, 0.02, 0.022), rough=0.12))
        else:
            fn()
            studio(target, dist, elev, azim, lens)
        render(PREVIEW / f"{name}.png")


def main():
    clear_scene()
    objs = build_revolving_door() + build_glass_railing() + build_brass_reveal() + build_desk_trim()
    roots = [o for o in objs if o.parent is None]
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    export(objs)
    if PREVIEW:
        preview_all()


main()
