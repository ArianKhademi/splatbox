# Sample assets

The conversion benchmark (`npm run bench`) runs on the 13 files below. None of them is committed:
`npm run samples` (which runs `scripts/make_samples.sh`) rebuilds the whole set into
`samples/assets/`. [`manifest.json`](manifest.json) is the source of truth for what is in the set.

## Third-party models

Eleven models come from
[KhronosGroup/glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets), downloaded
from commit `edc7c9e67c639d230715049ee31f9a96a6babbbe` and verified against the SHA-256 pinned in
the manifest. Nine are used as downloaded (uncompressed GLB). Two are first exported to another
format with Blender (`scripts/blender/derive_samples.py`) so the set also covers FBX and OBJ input;
for those two the original GLB is not part of the benchmark, so no model is counted twice.

| Benchmark file | From | License | Credit |
| --- | --- | --- | --- |
| `Fox.glb` | Fox | CC0 1.0 (model); CC BY 4.0 (rig, animation, glTF conversion) | PixelMannen (model); tomkranis (rigging and animation); @AsoboStudio and @scurest (glTF conversion) |
| `RiggedFigure.glb` | Rigged Figure | CC BY 4.0 | © 2017 Cesium |
| `CesiumMan.fbx` | Cesium Man, exported to FBX | CC BY 4.0 | © 2017 Cesium (the Cesium logo on the texture is a Cesium trademark) |
| `CesiumMilkTruck.glb` | Cesium Milk Truck | CC BY 4.0 | © 2017 Cesium (the Cesium logo on the texture is a Cesium trademark) |
| `Avocado.glb` | Avocado | CC0 1.0 | Microsoft |
| `BoomBox.glb` | Boom Box | CC0 1.0 | Microsoft |
| `WaterBottle.glb` | Water Bottle | CC0 1.0 | Microsoft |
| `Lantern.glb` | Lantern | CC0 1.0 | sbtron (Microsoft) |
| `ToyCar.glb` | Toy Car | CC0 1.0 | Guido Odendahl; Eric Chadwick |
| `Corset.glb` | Corset | CC0 1.0 | Microsoft; UX3D |
| `BarramundiFish.obj` | Barramundi Fish, geometry exported to OBJ | CC0 1.0 | Microsoft |

Licenses: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/legalcode),
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode). The CC BY models are modified
only by the format conversions described above.

Why no Mixamo characters: Adobe's terms do not allow redistributing Mixamo files, and a benchmark
other people cannot re-run is not worth much. `CesiumMan.fbx` stands in for that kind of input: a
skinned humanoid with a baked animation and an embedded texture in a single FBX.

## In-house assets

Two assets are authored for this repository by `scripts/blender/make_own_assets.py`, procedurally
and with fixed seeds, and exported the way a DCC tool exports by default (uncompressed geometry,
PNG textures):

| Benchmark file | What it is |
| --- | --- |
| `own_mannequin.glb` | Skinned mannequin: 16 bones, 63,488 triangles, a one-second walk cycle, one 2048 px texture |
| `own_crate.glb` | Static bevelled crate: 37,632 triangles, 4096 px base-colour and roughness textures |

Because they are synthetic, the results table reports the median both with and without them.
