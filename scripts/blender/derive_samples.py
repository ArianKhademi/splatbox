"""Derive the non-GLB benchmark inputs from pinned Khronos GLBs.

    blender -b --factory-startup --python derive_samples.py -- --assets samples/assets

  CesiumMan.glb      -> CesiumMan.fbx       rigged, animated, texture embedded
  BarramundiFish.glb -> BarramundiFish.obj  geometry only (positions, normals, UVs)

Redistributable FBX and OBJ characters are hard to come by (Mixamo's terms do not allow
redistributing its files), so these are produced from CC-licensed glTF samples with Blender's own
exporters. The originals of these two are not part of the benchmark set; each model is counted once.
"""

import argparse
import os
import sys

import bpy


def load(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = 30
    bpy.ops.import_scene.gltf(filepath=path, disable_bone_shape=True)


def to_fbx(src, dst):
    load(src)
    bpy.ops.export_scene.fbx(
        filepath=dst,
        path_mode="COPY",
        embed_textures=True,  # one self-contained file, like a Mixamo download
        bake_anim=True,
        add_leaf_bones=False,
    )


def to_obj(src, dst):
    load(src)
    bpy.ops.wm.obj_export(filepath=dst, export_materials=False, export_triangulated_mesh=True)


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(prog="derive_samples.py")
    parser.add_argument("--assets", required=True, help="directory holding the downloaded GLBs")
    args = parser.parse_args(argv)

    to_fbx(os.path.join(args.assets, "CesiumMan.glb"), os.path.join(args.assets, "CesiumMan.fbx"))
    to_obj(os.path.join(args.assets, "BarramundiFish.glb"), os.path.join(args.assets, "BarramundiFish.obj"))
    for name in ("CesiumMan.fbx", "BarramundiFish.obj"):
        path = os.path.join(args.assets, name)
        print(f"derived {name}: {os.path.getsize(path)} bytes")


if __name__ == "__main__":
    main()
