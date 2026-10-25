"""
Renders the Garden Sentinels HUD portraits (tower purchase cards, enemy chips) from the real game models.

    blender --background --factory-startup --python render_garden_portraits.py -- <garden-models-dir> [--stand-in] [--contact <png>]

Inputs  (in <garden-models-dir>, normally frontend/public/models/garden):
    towers.glb   roots Tower_<kind>_<lv>   kind = laser | shield | slow | missile | beacon, lv = 1 | 2 | 3
    enemies.glb  roots Enemy_<kind>        kind = runner | skitter | disruptor | brute | colossus

Outputs (256x256, transparent background, 3/4 view, warm key + cool rim + soft contact shadow):
    <garden-models-dir>/portraits/tower_<kind>_<lv>.webp   (15)  e.g. /models/garden/portraits/tower_laser_3.webp
    <garden-models-dir>/portraits/enemy_<kind>.webp        (5)   e.g. /models/garden/portraits/enemy_brute.webp
    Files are WebP (lossy with alpha). If Pillow has no WebP support they are quantised PNGs (.png) instead.

Framing: all 15 towers share one camera scale and stand on the same baseline, so level 3 reads visibly grander than
level 1. Enemies share a damped scale (own size^0.75 x largest size^0.25): the colossus is the biggest chip, but the
runner still fills its chip.

--stand-in renders primitive placeholders with the same root names (for testing without the GLBs).
--contact <png> also writes a contact sheet of every portrait.
Compression runs through Pillow, either inside Blender's Python or via the system `python` if Blender lacks it.
"""

import math
import os
import subprocess
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
STAND_IN = "--stand-in" in ARGS
CONTACT = None
if "--contact" in ARGS:
    CONTACT = ARGS[ARGS.index("--contact") + 1]
POSITIONAL = [a for i, a in enumerate(ARGS) if not a.startswith("--") and (i == 0 or ARGS[i - 1] != "--contact")]
SRC = Path(POSITIONAL[0]) if POSITIONAL else Path(__file__).resolve().parents[2] / "frontend/public/models/garden"
OUT = SRC / "portraits"
RAW = OUT / "_raw"

TOWERS = [f"Tower_{k}_{lv}" for k in ("laser", "shield", "slow", "missile", "beacon") for lv in (1, 2, 3)]
ENEMIES = [f"Enemy_{k}" for k in ("runner", "skitter", "disruptor", "brute", "colossus")]

SIZE = 256
YAW = math.radians(-38)      # camera azimuth from the model's front (+Y), toward its right
PITCH = math.radians(24)     # camera elevation


# ---- scene ---------------------------------------------------------------------------------------------------------

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_models():
    for name in ("towers.glb", "enemies.glb"):
        path = SRC / name
        if path.exists():
            bpy.ops.import_scene.gltf(filepath=str(path))
        else:
            print(f"[portraits] missing {path}")


def stand_ins():
    def mat(name, color, emit=0.0):
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        b = m.node_tree.nodes["Principled BSDF"]
        b.inputs["Base Color"].default_value = (*color, 1)
        b.inputs["Roughness"].default_value = 0.3
        if emit:
            b.inputs["Emission Color"].default_value = (*color, 1)
            b.inputs["Emission Strength"].default_value = emit
        return m

    cream, amber = mat("cream", (0.9, 0.85, 0.75)), mat("amber", (1.0, 0.5, 0.1), 3)
    for i, name in enumerate(TOWERS + ENEMIES):
        lv = int(name[-1]) if name.startswith("Tower") else 1
        bpy.ops.object.empty_add(location=(i * 6, 0, 0))
        root = bpy.context.object
        root.name = name
        h = 1.0 + 0.5 * lv if name.startswith("Tower") else 0.6 + 0.3 * (ENEMIES.index(name) if name in ENEMIES else 0)
        bpy.ops.mesh.primitive_cylinder_add(radius=0.6, depth=h, location=(i * 6, 0, h / 2))
        body = bpy.context.object
        body.data.materials.append(cream)
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.35, location=(i * 6, 0.2, h + 0.2))
        head = bpy.context.object
        head.data.materials.append(amber)
        for o in (body, head):
            o.parent = root
            o.matrix_parent_inverse = root.matrix_world.inverted()


def find_root(name):
    obj = bpy.data.objects.get(name)
    if obj is None:  # importer may suffix duplicates (.001)
        obj = next((o for o in bpy.data.objects if o.name.split(".")[0] == name), None)
    return obj


def descendants(obj):
    out = [obj]
    for c in obj.children:
        out += descendants(c)
    return out


def setup_render():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 96
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 6
    scene.render.resolution_x = scene.render.resolution_y = SIZE
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    vs = scene.view_settings
    try:
        vs.view_transform = "AgX"
        vs.look = "AgX - Medium High Contrast"
    except Exception:
        pass
    vs.exposure = 0.2

    world = bpy.data.worlds.new("PortraitWorld")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.62, 0.70, 0.80, 1)  # cool sky ambient, keeps shadows from going black
    bg.inputs["Strength"].default_value = 0.55


def add_camera():
    cam_data = bpy.data.cameras.new("PortraitCam")
    cam_data.type = "ORTHO"
    cam = bpy.data.objects.new("PortraitCam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    # Looking from the front-right, slightly above: camera sits along +Y rotated by YAW, raised by PITCH.
    rot = Matrix.Rotation(YAW + math.pi, 4, "Z") @ Matrix.Rotation(math.pi / 2 - PITCH, 4, "X")
    cam.matrix_world = rot
    cam_data.clip_start = 0.01
    cam_data.clip_end = 1000
    return cam


def add_lights(rig_size):
    """Lights are parented to a rig empty that we move to each model; sizes scale with the model."""
    rig = bpy.data.objects.new("LightRig", None)
    bpy.context.scene.collection.objects.link(rig)

    def area(name, color, size, loc, shadow=True):
        data = bpy.data.lights.new(name, "AREA")
        data.color = color
        data.size = size
        data.use_shadow = shadow
        obj = bpy.data.objects.new(name, data)
        bpy.context.scene.collection.objects.link(obj)
        obj.location = Vector(loc)
        aim = Vector((0, 0, 0.45)) - obj.location
        obj.rotation_euler = aim.to_track_quat("-Z", "Y").to_euler()
        obj.parent = rig
        return obj

    # Horizontal camera basis: `back` points from the model toward the camera, `right` is screen-right.
    back = Vector((-math.sin(YAW), math.cos(YAW), 0))
    right = Vector((-math.cos(YAW), -math.sin(YAW), 0))
    up = Vector((0, 0, 1))
    lights = [
        # warm key from the upper front-left: the only shadow caster, soft and falling back-right
        (area("Key", (1.0, 0.85, 0.66), 2.2, back * 2.0 - right * 1.9 + up * 3.4), 1.0),
        # cool rim from behind-right, outlines the silhouette
        (area("Rim", (0.55, 0.78, 1.0), 1.0, -back * 2.6 + right * 1.7 + up * 2.0, shadow=False), 1.5),
        # soft neutral fill from the camera side
        (area("Fill", (1.0, 0.97, 0.94), 2.5, back * 3.0 + right * 1.6 + up * 0.9, shadow=False), 0.3),
    ]

    bpy.ops.mesh.primitive_plane_add(size=1)
    floor = bpy.context.object
    floor.name = "ShadowCatcher"
    floor.is_shadow_catcher = True
    floor.parent = rig
    return rig, lights, floor


def scale_rig(rig, lights, floor, size, base):
    rig.scale = (size, size, size)
    for obj, strength in lights:
        obj.data.energy = 150 * strength * size * size
    floor.scale = (60, 60, 1)


# ---- framing -------------------------------------------------------------------------------------------------------

def world_points(objs):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    pts = []
    for o in objs:
        if o.type not in {"MESH", "CURVE", "SURFACE", "META", "FONT"}:
            continue
        ev = o.evaluated_get(depsgraph)
        try:
            mesh = ev.to_mesh()
        except Exception:
            continue
        if mesh is None:
            continue
        mw = ev.matrix_world
        step = max(1, len(mesh.vertices) // 4000)
        verts = mesh.vertices
        pts += [mw @ verts[i].co for i in range(0, len(verts), step)]
        ev.to_mesh_clear()
    return pts


def measure(root, cam):
    objs = descendants(root)
    pts = world_points(objs)
    if not pts:
        return None
    inv = cam.matrix_world.to_3x3().inverted()
    cs = [inv @ p for p in pts]
    xs, ys = [c.x for c in cs], [c.y for c in cs]
    zs = [p.z for p in pts]
    center = sum(pts, Vector()) / len(pts)
    wx = [p.x for p in pts]
    wy = [p.y for p in pts]
    return {
        "objs": objs,
        "w": max(xs) - min(xs),
        "h": max(ys) - min(ys),
        "cx": (max(xs) + min(xs)) / 2,
        "cy": (max(ys) + min(ys)) / 2,
        "ymin": min(ys),
        "zmin": min(zs),
        "foot": Vector(((max(wx) + min(wx)) / 2, (max(wy) + min(wy)) / 2, min(zs))),
        "radius": max(max(wx) - min(wx), max(wy) - min(wy), max(zs) - min(zs)),
        "center": center,
    }


def place_camera(cam, m, ortho, anchor_bottom):
    """Put the camera so the model's camera-space box sits centred (or bottom-anchored) in an ortho view of `ortho`."""
    rot = cam.matrix_world.to_3x3()
    cx = m["cx"]
    if anchor_bottom:
        cy = m["ymin"] + ortho * 0.5 - ortho * 0.08  # model's lowest point 8% above the bottom edge
    else:
        cy = m["cy"] - ortho * 0.02
    back = rot @ Vector((0, 0, 1))
    target = rot @ Vector((cx, cy, 0))
    # Shift along the view axis so the model is well inside the clip range.
    depth = (m["center"]).dot(back)
    cam.location = target - back * (target.dot(back)) + back * (depth + 50)
    cam.data.ortho_scale = ortho


# ---- compression ---------------------------------------------------------------------------------------------------

COMPRESS = r'''
import sys, os
from PIL import Image, features
raw, out = sys.argv[1], sys.argv[2]
contact = sys.argv[3] if len(sys.argv) > 3 else ""
webp = features.check("webp")
names = sorted(f[:-4] for f in os.listdir(raw) if f.endswith(".png"))
total = 0
for n in names:
    im = Image.open(os.path.join(raw, n + ".png")).convert("RGBA")
    for ext in (".webp", ".png"):
        p = os.path.join(out, n + ext)
        if os.path.exists(p):
            os.remove(p)
    if webp:
        p = os.path.join(out, n + ".webp")
        im.save(p, "WEBP", quality=88, method=6, alpha_quality=90)
    else:
        p = os.path.join(out, n + ".png")
        im.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG).save(p, optimize=True)
    total += os.path.getsize(p)
    print(f"[portraits] {os.path.basename(p)} {os.path.getsize(p) / 1024:.1f} KB")
print(f"[portraits] total {total / 1024:.1f} KB")
if contact:
    kinds = ["laser", "shield", "slow", "missile", "beacon", "runner", "skitter", "disruptor", "brute", "colossus"]
    order = sorted(names, key=lambda n: (n[0] != "t", [k in n for k in kinds].index(True) if any(k in n for k in kinds) else 99, n))
    cols, cell = 6, 140
    rows = (len(order) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cell, rows * cell), (40, 46, 52, 255))
    from PIL import ImageDraw
    d = ImageDraw.Draw(sheet)
    for i, n in enumerate(order):
        x, y = (i % cols) * cell, (i // cols) * cell
        d.rounded_rectangle((x + 4, y + 4, x + cell - 4, y + cell - 4), 14, fill=(28, 33, 38, 255))
        im = Image.open(os.path.join(raw, n + ".png")).convert("RGBA").resize((cell - 16, cell - 16), Image.LANCZOS)
        sheet.alpha_composite(im, (x + 8, y + 4))
        d.text((x + 10, y + cell - 16), n, fill=(230, 230, 220, 255))
    sheet.save(contact)
    print(f"[portraits] contact sheet {contact}")
'''


def compress():
    argv = [str(RAW), str(OUT)] + ([CONTACT] if CONTACT else [])
    try:
        import PIL  # noqa: F401
        old = sys.argv
        sys.argv = ["compress"] + argv
        try:
            exec(COMPRESS, {"__name__": "__compress__"})
        finally:
            sys.argv = old
        return
    except ImportError:
        pass
    for py in ("python", "python3", "py"):
        try:
            subprocess.run([py, "-c", COMPRESS] + argv, check=True)
            return
        except (OSError, subprocess.CalledProcessError) as e:
            print(f"[portraits] {py}: {e}")
    print("[portraits] Pillow not found: keeping uncompressed PNGs")
    for f in RAW.iterdir():
        os.replace(f, OUT / f.name)


# ---- main ----------------------------------------------------------------------------------------------------------

def main():
    reset()
    if STAND_IN:
        stand_ins()
    else:
        import_models()
    bpy.context.scene.frame_set(1)
    setup_render()
    cam = add_camera()
    rig, lights, floor = add_lights(1.0)
    OUT.mkdir(parents=True, exist_ok=True)
    RAW.mkdir(parents=True, exist_ok=True)

    names = TOWERS + ENEMIES
    roots = {n: find_root(n) for n in names}
    missing = [n for n, r in roots.items() if r is None]
    if missing:
        print(f"[portraits] roots not found: {missing}")
    roots = {n: r for n, r in roots.items() if r is not None}

    all_render_objs = [o for o in bpy.context.scene.objects if o.type not in {"CAMERA", "LIGHT"} and o is not floor and o is not rig]
    measures = {n: measure(r, cam) for n, r in roots.items()}
    measures = {n: m for n, m in measures.items() if m}

    tower_ext = max([max(m["w"], m["h"]) for n, m in measures.items() if n.startswith("Tower")] or [1])
    enemy_ext = max([max(m["w"], m["h"]) for n, m in measures.items() if n.startswith("Enemy")] or [1])

    for name, m in measures.items():
        keep = set(m["objs"])
        for o in all_render_objs:
            o.hide_render = o not in keep
        # Models are laid out side by side in the GLB; each render only sees its own root.
        if name.startswith("Tower"):
            ortho = tower_ext * 1.1
            place_camera(cam, m, ortho, anchor_bottom=True)
        else:
            own = max(m["w"], m["h"])
            ortho = own ** 0.75 * enemy_ext ** 0.25 * 1.15
            ortho = max(ortho, own * 1.14)
            place_camera(cam, m, ortho, anchor_bottom=False)
        size = ortho * 0.9
        rig.location = m["foot"]
        floor.location = Vector((0, 0, 0))
        scale_rig(rig, lights, floor, size, m["zmin"])
        bpy.context.view_layer.update()
        bpy.context.scene.render.filepath = str(RAW / f"{name.lower()}.png")
        bpy.ops.render.render(write_still=True)
        print(f"[portraits] rendered {name}")

    compress()
    for f in RAW.iterdir():
        f.unlink()
    RAW.rmdir()


main()
