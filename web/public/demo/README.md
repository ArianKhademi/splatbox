# Bundled demo assets

Small assets the viewer can show without the api, storage, or a worker (`#/demo`). The end-to-end
tests and the README captures run on these. Everything here is produced by scripts in this
repository from the sample set described in [samples/README.md](../../../samples/README.md).

| File | What it is | Made by | Source and license |
| --- | --- | --- | --- |
| `fox.glb` | Rigged fox with three clips | unmodified download | Khronos "Fox": CC0 1.0 (model, PixelMannen); CC BY 4.0 (rig and animation, tomkranis; glTF conversion, @AsoboStudio and @scurest) |
| `fox-motion.glb` | The fox's skeleton and clips without the mesh | `scripts/blender/make_demo_fixtures.py` | derived from `fox.glb`, same licenses |
| `mannequin.glb` | 63k-triangle skinned mannequin, converted (Draco, WebP) | `make_own_assets.py` then `worker/blender/convert.py` | authored for this repository |
| `avocado.splat` | Gaussian splat scene, 60k splats | `scripts/make_splat.ts` | synthesised from Khronos "Avocado", CC0 1.0 (Microsoft) |
| `pair-video.mp4` | 2 s, 30 fps render of a walk with burnt-in frame numbers | `scripts/blender/make_demo_fixtures.py` | rendered from Khronos "Cesium Man", CC BY 4.0, © 2017 Cesium |
| `pair-motion.glb` | The same walk as a converted GLB | `worker/blender/convert.py` | Khronos "Cesium Man", CC BY 4.0, © 2017 Cesium |

`scripts/make_demo.sh` rebuilds all of them.
