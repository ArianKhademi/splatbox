"""Render a turntable of a GLB with headless Blender.

    blender -b --factory-startup --python turntable.py -- \
        --in model.glb --out-dir frames --frames 24 --size 512 --engine eevee

The asset stays still; a camera and a three-point light rig hang off one pivot at the asset's
centre, and the pivot turns 360/frames degrees between renders. That is the same picture as
spinning the asset under fixed studio lights. Frames are RGBA PNGs with a transparent background,
named frame_0000.png onward.

A file with a skeleton but no mesh (a motion clip) is drawn as a stick figure built from its bones.

Reports with SPLATBOX_RESULT {json} / SPLATBOX_ERROR message, like convert.py.
"""

import argparse
import json
import math
import os
import sys
import time
import traceback

import bpy
import numpy as np
from mathutils import Vector

# Render engine ids by preference. EEVEE is "BLENDER_EEVEE_NEXT" in Blender 4.2 to 4.5 and
# "BLENDER_EEVEE" before and after.
ENGINES = {
    "eevee": ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"),
    "workbench": ("BLENDER_WORKBENCH",),
}

CAMERA_ELEVATION = math.radians(12)
# Turn the first frame a little off the front so the poster is a three-quarter view.
START_ANGLE = math.radians(25)


def parse_args(argv):
    parser = argparse.ArgumentParser(prog="turntable.py", description=__doc__.split("\n")[0])
    parser.add_argument("--in", dest="src", required=True, help="input .glb")
    parser.add_argument("--out-dir", required=True, help="directory for the rendered frames")
    parser.add_argument("--frames", type=int, default=24, help="views per full turn")
    parser.add_argument("--size", type=int, default=512, help="frame width and height in pixels")
    parser.add_argument("--engine", choices=sorted(ENGINES), default="eevee")
    parser.add_argument("--samples", type=int, default=16, help="anti-aliasing samples per frame (EEVEE)")
    return parser.parse_args(argv)


def load(path):
    if not os.path.isfile(path):
        raise FileNotFoundError(f"input file not found: {path}")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path, disable_bone_shape=True)
    scene = bpy.context.scene
    # Anything that came with the file would compete with the studio rig.
    for obj in list(scene.objects):
        if obj.type in {"CAMERA", "LIGHT"}:
            bpy.data.objects.remove(obj, do_unlink=True)
    # Pose animated assets on their first frame.
    scene.frame_set(0)
    return scene


def bone_mesh(scene):
    """Build a stick figure so a mesh-less rig can be rendered: one octahedral stick from every
    joint to its parent joint, in world space. (Bone tails are not used: glTF has no bone lengths,
    so the importer invents them.)"""
    joints = []
    for rig in [obj for obj in scene.objects if obj.type == "ARMATURE"]:
        for bone in rig.pose.bones:
            if bone.parent is not None:
                joints.append((rig.matrix_world @ bone.parent.head, rig.matrix_world @ bone.head))
    if not joints:
        return None

    points = [p for pair in joints for p in pair]
    extent = max((max(p[i] for p in points) - min(p[i] for p in points)) for i in range(3))
    vertices, faces = [], []
    for start, end in joints:
        axis = end - start
        length = axis.length
        if length < extent * 1e-4:
            continue
        # Two directions perpendicular to the stick, to give it a square waist.
        helper = Vector((1, 0, 0)) if abs(axis.normalized().z) > 0.9 else Vector((0, 0, 1))
        side = axis.cross(helper).normalized()
        front = axis.cross(side).normalized()
        waist = start.lerp(end, 0.2)
        width = min(max(length * 0.12, extent * 0.006), extent * 0.025)
        base = len(vertices)
        vertices += [start, waist + side * width, waist + front * width, waist - side * width, waist - front * width, end]
        for i in range(4):
            a, b = base + 1 + i, base + 1 + (i + 1) % 4
            faces += [(base, b, a), (base + 5, a, b)]

    mesh = bpy.data.meshes.new("Bones")
    mesh.from_pydata([tuple(v) for v in vertices], [], faces)
    material = bpy.data.materials.new("Bones")
    material.use_nodes = True
    bsdf = material.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.12, 0.38, 0.9, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.6
    mesh.materials.append(material)
    obj = bpy.data.objects.new("Bones", mesh)
    scene.collection.objects.link(obj)
    return obj


def bounding_sphere(scene):
    """Centre and radius of all mesh vertices in world space, in the current pose."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    clouds = []
    for obj in scene.objects:
        if obj.type != "MESH":
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        local = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
        mesh.vertices.foreach_get("co", local)
        evaluated.to_mesh_clear()
        matrix = np.array(evaluated.matrix_world, dtype=np.float32)
        clouds.append(local.reshape(-1, 3) @ matrix[:3, :3].T + matrix[:3, 3])
    points = np.concatenate(clouds) if clouds else np.empty((0, 3), dtype=np.float32)
    if len(points) == 0:
        raise ValueError("the file has no geometry and no skeleton to render")
    centre = (points.min(axis=0) + points.max(axis=0)) / 2
    radius = float(np.linalg.norm(points - centre, axis=1).max())
    return Vector(centre.tolist()), max(radius, 1e-4)


def aim(obj, target):
    """Point the object's -Z axis (the view direction of cameras and lights) at target."""
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def build_rig(scene, centre, radius):
    """Camera and three area lights parented to a pivot at the asset's centre. Returns the pivot."""
    pivot = bpy.data.objects.new("TurntablePivot", None)
    pivot.location = centre
    scene.collection.objects.link(pivot)
    origin = Vector((0, 0, 0))  # children are placed relative to the pivot

    camera_data = bpy.data.cameras.new("TurntableCamera")
    camera_data.lens = 50
    camera_data.sensor_width = 36
    # Distance at which the bounding sphere exactly touches the edges of a square frame, plus 8%.
    half_fov = math.atan(camera_data.sensor_width / 2 / camera_data.lens)
    distance = radius / math.sin(half_fov) * 1.08
    camera_data.clip_start = distance / 100
    camera_data.clip_end = distance * 10
    camera = bpy.data.objects.new("TurntableCamera", camera_data)
    camera.parent = pivot
    # glTF's front (+Z) is -Y in Blender, so the camera starts on the -Y side looking in.
    camera.location = Vector((0, -distance * math.cos(CAMERA_ELEVATION), distance * math.sin(CAMERA_ELEVATION)))
    aim(camera, origin)
    scene.collection.objects.link(camera)
    scene.camera = camera

    # name, position in units of the camera distance, watts for a 1 m camera distance
    lights = [
        ("Key", (-0.75, -0.85, 0.95), 55.0),
        ("Fill", (0.95, -0.60, 0.25), 16.0),
        ("Rim", (0.25, 1.00, 0.80), 40.0),
    ]
    for name, position, watts in lights:
        data = bpy.data.lights.new(name, "AREA")
        data.size = radius * 1.5
        # An area light's effect falls off with distance squared; scale the power the same way so
        # a 20 cm prop and a 20 m scene come out equally bright.
        data.energy = watts * distance * distance
        light = bpy.data.objects.new(name, data)
        light.parent = pivot
        light.location = Vector(position) * distance
        aim(light, origin)
        scene.collection.objects.link(light)
    return pivot


def configure_render(scene, args):
    chosen = None
    for engine in ENGINES[args.engine]:
        try:
            scene.render.engine = engine
            chosen = engine
            break
        except TypeError:  # this Blender version does not have that engine id
            continue
    if chosen is None:
        raise RuntimeError(f"none of the render engines {ENGINES[args.engine]} exist in Blender {bpy.app.version_string}")

    if args.engine == "eevee":
        scene.eevee.taa_render_samples = args.samples
    else:
        scene.display.shading.light = "STUDIO"
        scene.display.shading.color_type = "TEXTURE"

    world = bpy.data.worlds.new("Studio")
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = (0.75, 0.78, 0.85, 1.0)
    background.inputs["Strength"].default_value = 0.3  # soft ambient fill so nothing is fully black
    scene.world = world

    scene.render.resolution_x = args.size
    scene.render.resolution_y = args.size
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    # "Standard" shows base colours as authored; the default filmic-style transforms wash them out.
    scene.view_settings.view_transform = "Standard"
    return chosen


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    args = parse_args(argv)
    started = time.time()

    scene = load(args.src)
    has_mesh = any(obj.type == "MESH" for obj in scene.objects)
    if not has_mesh:
        bone_mesh(scene)
    centre, radius = bounding_sphere(scene)
    pivot = build_rig(scene, centre, radius)
    engine = configure_render(scene, args)

    os.makedirs(args.out_dir, exist_ok=True)
    frames = []
    for index in range(args.frames):
        pivot.rotation_euler = (0, 0, START_ANGLE + index * math.tau / args.frames)
        path = os.path.abspath(os.path.join(args.out_dir, f"frame_{index:04d}.png"))
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        if not os.path.isfile(path):
            raise RuntimeError(f"frame {index} was not written")
        frames.append(path)

    result = {
        "frames": frames,
        "engine": engine,
        "radius": round(radius, 5),
        "drew_skeleton": not has_mesh,
        "blender": bpy.app.version_string,
        "seconds": round(time.time() - started, 3),
    }
    print("SPLATBOX_RESULT " + json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001 - every failure must reach the worker as a non-zero exit
        traceback.print_exc()
        print(f"SPLATBOX_ERROR {type(exc).__name__}: {exc}")
        sys.stdout.flush()
        sys.exit(1)
