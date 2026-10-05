import { DropInViewer, SceneFormat, SceneRevealMode, type SplatMesh } from '@mkkellogg/gaussian-splats-3d'
import { Box3, Sphere, Vector3, type Material } from 'three'
import type { SplatFormat } from './types'

/**
 * Plain three.js helpers around the splat library, with no React in them: the interactive viewer
 * (SplatScene) and the turntable render page both build their scene through these.
 */

const FORMATS: Record<SplatFormat, number> = { ply: SceneFormat.Ply, splat: SceneFormat.Splat, ksplat: SceneFormat.KSplat }

/** Creates the library's drop-in viewer (a THREE.Group) and starts loading a scene into it. */
export function createSplatViewer(url: string, format: SplatFormat, alphaThreshold: number) {
  const viewer = new DropInViewer({
    // Both of these need cross-origin isolation headers (SharedArrayBuffer); the plain worker path works anywhere.
    gpuAcceleratedSort: false,
    sharedMemoryForWorkers: false,
    sceneRevealMode: SceneRevealMode.Instant,
  })
  const loaded = viewer.addSplatScene(url, {
    // The library guesses the format from the end of the URL, which is a query string for presigned URLs.
    format: FORMATS[format],
    showLoadingUI: false,
    progressiveLoad: false,
    splatAlphaRemovalThreshold: alphaThreshold,
  })
  return { viewer, loaded }
}

export function disposeSplatViewer(viewer: DropInViewer): void {
  // dispose() frees the splat mesh, its data textures and the sort worker, but not the invisible
  // helper mesh DropInViewer adds to hook the render loop; without this one geometry leaks per scene.
  viewer.callbackMesh.geometry.dispose()
  ;(viewer.callbackMesh.material as Material).dispose()
  // A scene that is still downloading is aborted by dispose(), which rejects; nothing to handle.
  viewer.dispose().catch(() => undefined)
}

const SAMPLE_LIMIT = 20_000

/**
 * A bounding sphere that ignores stray splats. Captured scenes carry far-away "floaters", and one
 * of them is enough to make a min/max box useless for framing, so this takes the 2nd to 98th
 * percentile of a sample of splat centres on each axis.
 */
export function robustSplatBounds(mesh: SplatMesh): Sphere {
  const count = mesh.getSplatCount()
  const step = Math.max(1, Math.floor(count / SAMPLE_LIMIT))
  const xs: number[] = []
  const ys: number[] = []
  const zs: number[] = []
  const centre = new Vector3()
  for (let i = 0; i < count; i += step) {
    mesh.getSplatCenter(i, centre, true)
    xs.push(centre.x)
    ys.push(centre.y)
    zs.push(centre.z)
  }
  const range = (values: number[]): [number, number] => {
    values.sort((a, b) => a - b)
    return [values[Math.floor(values.length * 0.02)] ?? 0, values[Math.ceil(values.length * 0.98) - 1] ?? 0]
  }
  const [x, y, z] = [range(xs), range(ys), range(zs)]
  return new Box3(new Vector3(x[0], y[0], z[0]), new Vector3(x[1], y[1], z[1])).getBoundingSphere(new Sphere())
}

/**
 * Brings the splat order up to date for the camera that last rendered the scene. Splats are
 * alpha-blended back to front, and the library re-sorts them in a web worker a few frames after
 * the camera moves; a still frame has to wait for that sort instead.
 */
export async function sortForCurrentView(viewer: DropInViewer): Promise<void> {
  const engine = viewer.viewer
  if (engine.sortRunning && engine.sortPromise) await engine.sortPromise
  await engine.runSplatSort(true, true)
  if (engine.sortPromise) await engine.sortPromise
}
