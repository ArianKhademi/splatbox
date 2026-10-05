"""Convert an FBX, OBJ, glTF or GLB file into a compact GLB with headless Blender.

    blender -b --factory-startup --python convert.py -- \
        --in model.fbx --out model.glb --draco --max-texture 2048

What it does, in order:
  1. imports the file into an empty scene,
  2. removes cameras, lights and empties that carry nothing,
  3. downscales textures whose longer side exceeds --max-texture,
  4. exports a GLB with Draco mesh compression and re-encoded textures,
     keeping skins and animations.

The script reports through two stdout lines the TypeScript worker looks for:
    SPLATBOX_RESULT {json}   on success (always the last line)
    SPLATBOX_ERROR message   on failure, followed by a non-zero exit code
"""

import argparse
import json
import os
import sys
import time
import traceback

import bpy



def import_gltf(path):
    # Without this the importer adds an icosphere mesh to draw bones with, which would be counted
    # (and exported) as part of the asset.
    bpy.ops.import_scene.gltf(filepath=path, disable_bone_shape=True)


IMPORTERS = {
    ".fbx": lambda path: bpy.ops.import_scene.fbx(filepath=path),
    ".obj": lambda path: bpy.ops.wm.obj_import(filepath=path),
    ".glb": import_gltf,
    ".gltf": import_gltf,
}

# Blender's image format names for --texture-format.
TEXTURE_FORMATS = {"webp": "WEBP", "jpeg": "JPEG", "auto": "AUTO"}


def parse_args(argv):
    parser = argparse.ArgumentParser(prog="convert.py", description=__doc__.split("\n")[0])
    parser.add_argument("--in", dest="src", required=True, help="input .fbx, .obj, .glb or .gltf")
    parser.add_argument("--out", dest="dst", required=True, help="output .glb")
    parser.add_argument("--draco", action="store_true", help="compress meshes with KHR_draco_mesh_compression")
    parser.add_argument("--draco-level", type=int, default=6, help="0 (fastest) to 10 (smallest)")
    # Quantization bits per attribute. These are the glTF exporter's defaults: 14 bits of position
    # is 1/16384 of the mesh bounding box per axis.
    parser.add_argument("--quant-position", type=int, default=14)
    parser.add_argument("--quant-normal", type=int, default=10)
    parser.add_argument("--quant-texcoord", type=int, default=12)
    parser.add_argument("--quant-color", type=int, default=10)
    parser.add_argument("--quant-generic", type=int, default=12, help="skin weights and other attributes")
    parser.add_argument("--max-texture", type=int, default=2048, help="longest texture side in pixels, 0 to keep sizes")
    parser.add_argument(
        "--texture-format",
        choices=sorted(TEXTURE_FORMATS),
        default="webp",
        help="webp: every texture, alpha included. jpeg: opaque textures only, ones with alpha stay PNG. auto: keep formats",
    )
    parser.add_argument("--texture-quality", type=int, default=75, help="lossy quality, 0-100")
    parser.add_argument("--fps", type=int, default=30, help="scene frame rate; also the sampling rate with --bake-animations")
    parser.add_argument(
        "--bake-animations",
        action="store_true",
        help="sample every animated channel once per frame instead of exporting the source keyframes",
    )
    return parser.parse_args(argv)


def reset_scene(fps):
    """Start from an empty file so nothing from a default scene can leak into the export."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # glTF stores keyframe times in seconds; Blender converts them to frames at the scene rate on
    # import and back on export.
    bpy.context.scene.render.fps = fps


def import_asset(path):
    ext = os.path.splitext(path)[1].lower()
    if ext not in IMPORTERS:
        raise ValueError(f"unsupported input format '{ext}' (expected one of {', '.join(sorted(IMPORTERS))})")
    if not os.path.isfile(path):
        raise FileNotFoundError(f"input file not found: {path}")
    IMPORTERS[ext](path)
    if not bpy.data.objects:
        raise ValueError("the file imported without errors but contains no objects")


def texture_images():
    """Images that hold real pixels (not render results or images whose file is missing)."""
    return [img for img in bpy.data.images if img.type == "IMAGE" and img.size[0] > 0 and img.size[1] > 0]


def scene_stats():
    depsgraph = bpy.context.evaluated_depsgraph_get()
    triangles = 0
    meshes = 0
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        meshes += 1
        # Count on the evaluated mesh so quads and n-gons are counted as the triangles they export to.
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        triangles += len(mesh.loop_triangles)
        evaluated.to_mesh_clear()
    return {
        "triangles": triangles,
        "meshes": meshes,
        "textures": len(texture_images()),
        "armatures": sum(1 for obj in bpy.context.scene.objects if obj.type == "ARMATURE"),
        "animations": len(bpy.data.actions),
    }


def strip_scene():
    """Remove what a preview does not need: cameras, lights, and empties that hold nothing."""
    removed = {"cameras": 0, "lights": 0, "empties": 0}
    for obj in list(bpy.context.scene.objects):
        if obj.type == "CAMERA":
            removed["cameras"] += 1
            bpy.data.objects.remove(obj, do_unlink=True)
        elif obj.type == "LIGHT":
            removed["lights"] += 1
            bpy.data.objects.remove(obj, do_unlink=True)

    # An empty is only worth keeping as a parent or an animated transform. Removing a leaf can turn
    # its parent into a leaf, so repeat until a pass removes nothing.
    while True:
        leaves = [
            obj
            for obj in bpy.context.scene.objects
            if obj.type == "EMPTY" and not obj.children and obj.animation_data is None and obj.instance_collection is None
        ]
        if not leaves:
            break
        for obj in leaves:
            removed["empties"] += 1
            bpy.data.objects.remove(obj, do_unlink=True)

    # Drop the data blocks (camera data, light data, unused materials and images) left without users.
    bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
    return removed


def resize_textures(max_size):
    """Downscale textures whose longer side exceeds max_size, keeping the aspect ratio."""
    resized = []
    if max_size <= 0:
        return resized
    for img in texture_images():
        width, height = img.size
        longest = max(width, height)
        if longest <= max_size:
            continue
        scale = max_size / longest
        new_size = (max(1, round(width * scale)), max(1, round(height * scale)))
        img.scale(*new_size)
        resized.append({"name": img.name, "from": [width, height], "to": list(new_size)})
    return resized


def export_glb(args):
    os.makedirs(os.path.dirname(os.path.abspath(args.dst)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=args.dst,
        export_format="GLB",
        # geometry
        export_draco_mesh_compression_enable=args.draco,
        export_draco_mesh_compression_level=args.draco_level,
        export_draco_position_quantization=args.quant_position,
        export_draco_normal_quantization=args.quant_normal,
        export_draco_texcoord_quantization=args.quant_texcoord,
        export_draco_color_quantization=args.quant_color,
        export_draco_generic_quantization=args.quant_generic,
        # textures
        export_image_format=TEXTURE_FORMATS[args.texture_format],
        export_image_quality=args.texture_quality,
        export_jpeg_quality=args.texture_quality,
        # rig and motion
        export_skins=True,
        export_animations=True,
        # Sampling writes a key on every frame for every bone channel, which made animated files
        # grow; exporting the keyframes that are there keeps sparse clips sparse and their timing exact.
        export_force_sampling=args.bake_animations,
        export_optimize_animation_size=True,
        # nothing a previewer has use for
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_yup=True,
    )
    if not os.path.isfile(args.dst):
        raise RuntimeError("the glTF exporter finished without writing the output file")


def main():
    # Blender passes its own arguments first; ours follow the "--" separator.
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    args = parse_args(argv)
    started = time.time()

    reset_scene(args.fps)
    import_asset(args.src)
    before = scene_stats()
    removed = strip_scene()
    resized = resize_textures(args.max_texture)
    export_glb(args)

    result = {
        "input": args.src,
        "output": args.dst,
        "bytes_before": os.path.getsize(args.src),
        "bytes_after": os.path.getsize(args.dst),
        "before": before,
        "removed": removed,
        "resized_textures": resized,
        "settings": {
            "draco": args.draco,
            "draco_level": args.draco_level,
            "quantization": {
                "position": args.quant_position,
                "normal": args.quant_normal,
                "texcoord": args.quant_texcoord,
                "color": args.quant_color,
                "generic": args.quant_generic,
            },
            "max_texture": args.max_texture,
            "texture_format": args.texture_format,
            "texture_quality": args.texture_quality,
            "fps": args.fps,
            "bake_animations": args.bake_animations,
        },
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
