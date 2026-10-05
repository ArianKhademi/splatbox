"""Author the two in-house benchmark assets procedurally.

    blender -b --factory-startup --python make_own_assets.py -- --out samples/assets

  own_mannequin.glb  a rigged, skinned mannequin (16 bones, about 63k triangles) with a one-second
                     walk cycle and a 2048 px base-colour texture
  own_crate.glb      a static bevelled crate with 4096 px base-colour and roughness textures

Both are exported the way a DCC tool exports by default: uncompressed geometry, PNG textures.
Everything is seeded, so every run gives the same textures, the same file sizes and equivalent
geometry. The files are not byte-identical between runs: Blender does not write vertices and
indices in a stable order.
"""

import argparse
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

FPS = 30

# name, parent, head, tail (metres, Z up, character faces -Y)
BONES = [
    ("Hips", None, (0, 0, 0.95), (0, 0, 1.10)),
    ("Spine", "Hips", (0, 0, 1.10), (0, 0, 1.30)),
    ("Chest", "Spine", (0, 0, 1.30), (0, 0, 1.52)),
    ("Head", "Chest", (0, 0, 1.58), (0, 0, 1.82)),
    ("UpperArm.L", "Chest", (0.25, 0, 1.47), (0.27, 0, 1.19)),
    ("LowerArm.L", "UpperArm.L", (0.27, 0, 1.19), (0.28, 0, 0.93)),
    ("Hand.L", "LowerArm.L", (0.28, 0, 0.93), (0.28, 0, 0.80)),
    ("UpperArm.R", "Chest", (-0.25, 0, 1.47), (-0.27, 0, 1.19)),
    ("LowerArm.R", "UpperArm.R", (-0.27, 0, 1.19), (-0.28, 0, 0.93)),
    ("Hand.R", "LowerArm.R", (-0.28, 0, 0.93), (-0.28, 0, 0.80)),
    ("UpperLeg.L", "Hips", (0.10, 0, 0.95), (0.10, 0, 0.52)),
    ("LowerLeg.L", "UpperLeg.L", (0.10, 0, 0.52), (0.10, 0, 0.10)),
    ("Foot.L", "LowerLeg.L", (0.10, 0, 0.10), (0.10, -0.20, 0.03)),
    ("UpperLeg.R", "Hips", (-0.10, 0, 0.95), (-0.10, 0, 0.52)),
    ("LowerLeg.R", "UpperLeg.R", (-0.10, 0, 0.52), (-0.10, 0, 0.10)),
    ("Foot.R", "LowerLeg.R", (-0.10, 0, 0.10), (-0.10, -0.20, 0.03)),
]

# Radii (x, y, z) of the ellipsoid drawn around each bone, in metres.
PART_RADII = {
    "Hips": (0.17, 0.12, 0.12),
    "Spine": (0.15, 0.11, 0.13),
    "Chest": (0.19, 0.13, 0.15),
    "Head": (0.11, 0.12, 0.14),
    "UpperArm": (0.055, 0.055, 0.15),
    "LowerArm": (0.045, 0.045, 0.14),
    "Hand": (0.03, 0.05, 0.07),
    "UpperLeg": (0.08, 0.08, 0.23),
    "LowerLeg": (0.06, 0.06, 0.22),
    "Foot": (0.055, 0.12, 0.045),
}


def smooth_noise(rng, size, cells):
    """Value noise: a coarse random grid upsampled with bilinear interpolation."""
    grid = rng.random((cells + 1, cells + 1), dtype=np.float32)
    t = np.linspace(0, cells, size, endpoint=False, dtype=np.float32)
    i = t.astype(np.int32)
    f = t - i
    top = grid[i][:, i] * (1 - f)[None, :] + grid[i][:, i + 1] * f[None, :]
    bottom = grid[i + 1][:, i] * (1 - f)[None, :] + grid[i + 1][:, i + 1] * f[None, :]
    return top * (1 - f)[:, None] + bottom * f[:, None]


def fractal_noise(rng, size, octaves=(4, 16, 64, 256)):
    total = np.zeros((size, size), dtype=np.float32)
    weight = 1.0
    norm = 0.0
    for cells in octaves:
        total += smooth_noise(rng, size, cells) * weight
        norm += weight
        weight *= 0.5
    return total / norm


def make_image(name, rgb):
    """Wrap an (h, w, 3) float array as a packed Blender image, which the exporter writes as PNG."""
    height, width, _ = rgb.shape
    image = bpy.data.images.new(name, width=width, height=height, alpha=False)
    rgba = np.concatenate([rgb, np.ones((height, width, 1), dtype=np.float32)], axis=2)
    image.pixels.foreach_set(rgba.ravel())
    image.pack()
    return image


def panel_texture(rng, size):
    """Painted-metal panels: flat colour blocks, dark seams, and soft wear."""
    blocks = 8
    palette = np.array([[0.82, 0.83, 0.85], [0.20, 0.45, 0.80], [0.90, 0.55, 0.15], [0.25, 0.27, 0.30]], dtype=np.float32)
    choice = rng.integers(0, len(palette), (blocks, blocks))
    cell = size // blocks
    rgb = np.repeat(np.repeat(palette[choice], cell, axis=0), cell, axis=1)
    wear = fractal_noise(rng, size)[..., None]
    rgb = rgb * (0.82 + 0.3 * wear)
    seam = (np.arange(size) % cell) < max(2, size // 512)
    rgb[seam, :, :] *= 0.35
    rgb[:, seam, :] *= 0.35
    return np.clip(rgb, 0, 1).astype(np.float32)


def wood_textures(rng, size):
    """Plank base colour and a matching roughness map."""
    planks = 6
    y = np.linspace(0, 1, size, endpoint=False, dtype=np.float32)
    grain = fractal_noise(rng, size, octaves=(2, 8, 32, 128, 512))
    # Stretch the noise along the plank so it reads as grain.
    grain = (grain + np.roll(grain, size // 97, axis=1) + np.roll(grain, size // 53, axis=1)) / 3
    rings = 0.5 + 0.5 * np.sin((y[:, None] * planks * 9 + grain * 6) * math.tau)
    tone = 0.75 + 0.25 * rng.random(planks, dtype=np.float32)[np.minimum((y * planks).astype(np.int32), planks - 1)]
    shade = (0.55 + 0.25 * rings + 0.3 * grain) * tone[:, None]
    base = np.stack([shade * 0.62, shade * 0.42, shade * 0.24], axis=2)
    gap = ((y * planks) % 1.0) < 0.02
    base[gap, :, :] *= 0.25
    rough = np.clip(0.55 + 0.35 * grain - 0.15 * rings, 0, 1)
    return np.clip(base, 0, 1).astype(np.float32), np.repeat(rough[..., None], 3, axis=2).astype(np.float32)


def textured_material(name, base_image, roughness_image=None, metallic=0.0, roughness=0.5):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    bsdf = nodes["Principled BSDF"]
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    base = nodes.new("ShaderNodeTexImage")
    base.image = base_image
    links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
    if roughness_image is not None:
        rough = nodes.new("ShaderNodeTexImage")
        rough.image = roughness_image
        rough.image.colorspace_settings.name = "Non-Color"
        links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])
    return material


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.render.fps = FPS


def export(path):
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_cameras=False, export_lights=False)
    print(f"wrote {os.path.basename(path)}: {os.path.getsize(path)} bytes")


def build_armature():
    data = bpy.data.armatures.new("Rig")
    rig = bpy.data.objects.new("Rig", data)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    for name, parent, head, tail in BONES:
        bone = data.edit_bones.new(name)
        bone.head, bone.tail = head, tail
        if parent:
            bone.parent = data.edit_bones[parent]
    bpy.ops.object.mode_set(mode="OBJECT")
    return rig


def build_body(rig, material):
    """One ellipsoid per bone, joined into a single mesh that is rigidly skinned to the rig."""
    parts = []
    for name, _parent, head, tail in BONES:
        centre = (Vector(head) + Vector(tail)) / 2
        bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=1.0, location=centre)
        part = bpy.context.active_object
        part.scale = PART_RADII[name.split(".")[0]]
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        bpy.ops.object.shade_smooth()
        group = part.vertex_groups.new(name=name)
        group.add(range(len(part.data.vertices)), 1.0, "REPLACE")
        parts.append(part)

    bpy.ops.object.select_all(action="DESELECT")
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    body = bpy.context.active_object
    body.name = "Mannequin"
    body.data.materials.append(material)

    body.parent = rig
    modifier = body.modifiers.new("Armature", "ARMATURE")
    modifier.object = rig
    return body


def animate_walk(rig):
    """A one-second walk cycle keyed every 3 frames from sines, so it loops cleanly."""
    rig.animation_data_create()
    action = bpy.data.actions.new("Walk")
    rig.animation_data.action = action
    swing = {  # bone -> (axis index, amplitude in radians, phase in cycles)
        "UpperLeg.L": (0, 0.55, 0.0),
        "UpperLeg.R": (0, 0.55, 0.5),
        "LowerLeg.L": (0, 0.45, 0.2),
        "LowerLeg.R": (0, 0.45, 0.7),
        "UpperArm.L": (0, 0.50, 0.5),
        "UpperArm.R": (0, 0.50, 0.0),
        "LowerArm.L": (0, 0.30, 0.5),
        "LowerArm.R": (0, 0.30, 0.0),
        "Spine": (2, 0.08, 0.0),
        "Chest": (2, 0.10, 0.5),
        "Head": (2, 0.05, 0.0),
    }
    for frame in range(0, FPS + 1, 3):
        phase = frame / FPS
        for name, (axis, amplitude, offset) in swing.items():
            bone = rig.pose.bones[name]
            bone.rotation_mode = "XYZ"
            angle = amplitude * math.sin((phase + offset) * math.tau)
            if name.startswith("LowerLeg"):
                angle = abs(angle)  # knees only bend backwards
            elif name.startswith("LowerArm"):
                angle = -abs(angle)  # and elbows only forwards
            bone.rotation_euler[axis] = angle
            bone.keyframe_insert("rotation_euler", frame=frame)
        hips = rig.pose.bones["Hips"]
        hips.location[1] = 0.025 * math.sin(phase * 2 * math.tau)
        hips.keyframe_insert("location", frame=frame)
    bpy.context.scene.frame_start = 0
    bpy.context.scene.frame_end = FPS


def make_mannequin(path):
    reset()
    rng = np.random.default_rng(7)
    material = textured_material("Panels", make_image("mannequin_base", panel_texture(rng, 2048)), metallic=0.4, roughness=0.45)
    rig = build_armature()
    build_body(rig, material)
    animate_walk(rig)
    export(path)


def make_crate(path):
    reset()
    rng = np.random.default_rng(11)
    base, rough = wood_textures(rng, 4096)
    material = textured_material("Wood", make_image("crate_base", base), make_image("crate_roughness", rough))
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.5))
    crate = bpy.context.active_object
    crate.name = "Crate"
    bevel = crate.modifiers.new("Bevel", "BEVEL")
    bevel.width = 0.04
    bevel.segments = 6
    subdivide = crate.modifiers.new("Subdivide", "SUBSURF")
    subdivide.levels = 3
    subdivide.subdivision_type = "SIMPLE"
    for modifier in list(crate.modifiers):
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.ops.object.shade_smooth()
    crate.data.materials.append(material)
    export(path)


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(prog="make_own_assets.py")
    parser.add_argument("--out", required=True, help="directory to write the two GLBs into")
    args = parser.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    make_mannequin(os.path.join(args.out, "own_mannequin.glb"))
    make_crate(os.path.join(args.out, "own_crate.glb"))


if __name__ == "__main__":
    main()
