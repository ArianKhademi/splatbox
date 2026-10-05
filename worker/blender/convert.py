"""Convert an FBX, OBJ, glTF or GLB file into a compact GLB with headless Blender.

    blender -b --factory-startup --python convert.py -- \
        --in model.fbx --out model.glb --draco --max-texture 2048

What it does, in order:
  1. imports the file into an empty scene,
  2. removes cameras, lights and empties that carry nothing,
  3. downscales textures whose longer side exceeds --max-texture and re-encodes
     textures as WebP (or JPEG) wherever that is possible and smaller,
  4. exports a GLB with Draco mesh compression, keeping skins and animations.

The script reports through two stdout lines the TypeScript worker looks for:
    SPLATBOX_RESULT {json}   on success (always the last line)
    SPLATBOX_ERROR message   on failure, followed by a non-zero exit code
"""

import argparse
import json
import os
import sys
import tempfile
import time
import traceback

import bpy
import numpy as np



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

# --texture-format value -> (Blender image format, file extension). "auto" keeps source formats.
TEXTURE_FORMATS = {"webp": ("WEBP", "webp"), "jpeg": ("JPEG", "jpg"), "auto": (None, None)}


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
        help="webp: alpha is kept. jpeg: only textures without alpha, the rest stay PNG. auto: keep source formats",
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


def stored_bytes(image):
    """Size of the image as it is encoded in the source file, or None if that cannot be told."""
    if image.packed_file is not None:
        return image.packed_file.size
    path = bpy.path.abspath(image.filepath_raw)
    return os.path.getsize(path) if os.path.isfile(path) else None


def has_alpha(image):
    """True if any pixel is less than fully opaque."""
    if image.channels < 4:
        return False
    pixels = np.empty(image.size[0] * image.size[1] * image.channels, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    return bool((pixels[3::4] < 0.999).any())


def encode(image, size, file_format, quality, path):
    """Write a copy of the image, scaled to size, in file_format. False if Blender cannot do that."""
    copy = image.copy()
    try:
        copy.scale(*size)  # also makes Blender load the pixels from the packed bytes
        copy.filepath_raw = path
        copy.file_format = file_format
        if file_format == "PNG":
            copy.save()
        else:
            copy.save(quality=quality)
        return os.path.isfile(path) and os.path.getsize(path) > 0
    except RuntimeError:
        # Blender refuses some combinations, for example single-channel images as WebP.
        return False
    finally:
        bpy.data.images.remove(copy)


def replace_image(image, path):
    """Point every user of image at the file in path instead."""
    replacement = bpy.data.images.load(path)
    replacement.colorspace_settings.name = image.colorspace_settings.name
    replacement.alpha_mode = image.alpha_mode
    replacement.pack()  # hold the encoded bytes in memory; the file on disk is temporary
    name = image.name
    image.user_remap(replacement)
    bpy.data.images.remove(image)
    replacement.name = name


def process_textures(max_size, texture_format, quality, workdir):
    """Resize and re-encode textures one at a time; returns what happened to each.

    A texture is only replaced when the result is actually better: it had to shrink to fit
    max_size, or the re-encoded file is smaller than the original. Everything else is left exactly
    as it was in the source, and the exporter copies those bytes through unchanged.
    """
    lossy_format, extension = TEXTURE_FORMATS[texture_format]
    report = []
    for index, image in enumerate(texture_images()):
        width, height = image.size
        scale = min(1.0, max_size / max(width, height)) if max_size > 0 else 1.0
        target = (max(1, round(width * scale)), max(1, round(height * scale)))
        resized = target != (width, height)
        before = stored_bytes(image)
        entry = {"name": image.name, "size": [width, height], "bytes_before": before, "action": "kept"}

        candidates = []
        if lossy_format and not (lossy_format == "JPEG" and has_alpha(image)):
            candidates.append((lossy_format, extension))
        if resized:
            candidates.append(("PNG", "png"))  # must shrink even if the lossy encode is not possible

        for file_format, ext in candidates:
            path = os.path.join(workdir, f"texture_{index}.{ext}")
            if not encode(image, target, file_format, quality, path):
                continue
            after = os.path.getsize(path)
            if not resized and before is not None and after >= before:
                continue  # e.g. a small flat-colour PNG that lossy encoding only makes bigger
            replace_image(image, path)
            entry.update(action="resized" if resized else "re-encoded", format=file_format, to=list(target), bytes_after=after)
            break
        report.append(entry)
    return report


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
        # Textures were already resized and re-encoded one by one above; AUTO makes the exporter
        # embed each image's bytes as they are instead of re-encoding everything to one format.
        export_image_format="AUTO",
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
    with tempfile.TemporaryDirectory(prefix="splatbox-textures-") as workdir:
        textures = process_textures(args.max_texture, args.texture_format, args.texture_quality, workdir)
    export_glb(args)

    result = {
        "input": args.src,
        "output": args.dst,
        "bytes_before": os.path.getsize(args.src),
        "bytes_after": os.path.getsize(args.dst),
        "before": before,
        "removed": removed,
        "textures": textures,
        "resized_textures": [t for t in textures if t["action"] == "resized"],
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
