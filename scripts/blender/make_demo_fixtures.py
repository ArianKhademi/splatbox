"""Build the Blender-made fixtures for the web viewer's bundled demo set.

    blender -b --factory-startup --python make_demo_fixtures.py -- \
        --fox samples/assets/Fox.glb --walker samples/assets/CesiumMan.glb --out web/public/demo

  fox-motion.glb   the Fox's skeleton and its three clips with the mesh removed: a motion-only file
                   to apply to a character, like the motion GLB a mocap pipeline produces
  pair-video.mp4   a 2 second, 30 fps render of the walking character with the frame number burnt
                   in. It plays the role of the "source video" of a pair; the motion GLB shown next
                   to it is the same walk, so any sync error between the two panes is visible.
"""

import argparse
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

FPS = 30


def load(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS
    bpy.ops.import_scene.gltf(filepath=path, disable_bone_shape=True)
    return bpy.context.scene


def make_motion_file(src, dst):
    scene = load(src)
    for obj in list(scene.objects):
        if obj.type == "MESH":
            bpy.data.objects.remove(obj, do_unlink=True)
    bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_force_sampling=False, export_cameras=False, export_lights=False)
    print(f"wrote {os.path.basename(dst)}: {os.path.getsize(dst)} bytes")


def mesh_bounds(scene):
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
    points = np.concatenate(clouds)
    return points.min(axis=0), points.max(axis=0)


def aim(obj, target):
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def make_pair_video(src, dst, size=640, seconds=2):
    scene = load(src)
    scene.frame_set(0)
    low, high = mesh_bounds(scene)
    centre = Vector(((low + high) / 2).tolist())
    radius = float(np.linalg.norm(high - low)) / 2

    # A floor to walk on and a plain backdrop colour, since video has no alpha.
    bpy.ops.mesh.primitive_plane_add(size=radius * 12, location=(centre.x, centre.y, float(low[2])))
    floor_material = bpy.data.materials.new("Floor")
    floor_material.use_nodes = True
    floor_material.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.16, 0.17, 0.2, 1)
    floor_material.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.9
    bpy.context.active_object.data.materials.append(floor_material)

    world = bpy.data.worlds.new("Backdrop")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.09, 0.1, 0.12, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    scene.world = world

    camera_data = bpy.data.cameras.new("Camera")
    camera_data.lens = 50
    distance = radius / math.sin(math.atan(18 / 50)) * 1.15
    camera = bpy.data.objects.new("Camera", camera_data)
    camera.location = centre + Vector((distance * 0.55, -distance * 0.8, distance * 0.22))
    aim(camera, centre)
    scene.collection.objects.link(camera)
    scene.camera = camera

    for name, offset, watts in (("Key", (-0.7, -0.9, 1.0), 60.0), ("Fill", (1.0, -0.5, 0.3), 18.0), ("Rim", (0.2, 1.0, 0.8), 40.0)):
        data = bpy.data.lights.new(name, "AREA")
        data.size = radius * 1.5
        data.energy = watts * distance * distance
        light = bpy.data.objects.new(name, data)
        light.location = centre + Vector(offset) * distance
        aim(light, centre)
        scene.collection.objects.link(light)

    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.eevee.taa_render_samples = 16
    scene.view_settings.view_transform = "Standard"
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100

    # glTF time 0 is frame 0, so frames 0..59 are exactly the first two seconds at 30 fps.
    scene.frame_start = 0
    scene.frame_end = seconds * FPS - 1

    # Burn the frame number into the picture: "Frame 37" in the video must match the viewer's readout.
    scene.render.use_stamp = True
    for flag in ("date", "time", "render_time", "camera", "scene", "filename", "lens", "marker", "memory", "hostname", "note", "frame_range"):
        setattr(scene.render, f"use_stamp_{flag}", False)
    scene.render.use_stamp_frame = True
    scene.render.use_stamp_labels = True
    scene.render.stamp_font_size = 22
    scene.render.stamp_background = (0, 0, 0, 0.6)

    scene.render.image_settings.file_format = "FFMPEG"
    scene.render.ffmpeg.format = "MPEG4"
    scene.render.ffmpeg.codec = "H264"
    scene.render.ffmpeg.constant_rate_factor = "HIGH"
    # Every frame a keyframe: seeking to any frame is exact and instant, which scrubbing depends on.
    scene.render.ffmpeg.gopsize = 1
    scene.render.ffmpeg.audio_codec = "NONE"
    scene.render.filepath = dst
    scene.render.use_file_extension = False
    bpy.ops.render.render(animation=True)
    print(f"wrote {os.path.basename(dst)}: {os.path.getsize(dst)} bytes")


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(prog="make_demo_fixtures.py")
    parser.add_argument("--fox", required=True)
    parser.add_argument("--walker", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    make_motion_file(args.fox, os.path.join(args.out, "fox-motion.glb"))
    make_pair_video(args.walker, os.path.join(args.out, "pair-video.mp4"))


if __name__ == "__main__":
    main()
