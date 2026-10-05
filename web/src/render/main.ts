/**
 * The page behind splat turntables. The worker opens it in a headless Chromium (see
 * worker/src/splat.ts) with the scene in the query string, then calls
 * `window.splatboxTurntable.frame(i)` once per view and saves the PNG each call returns.
 * It uses the same splat helpers as the interactive viewer, so a thumbnail shows what the viewer shows.
 */
import { Group, MathUtils, PerspectiveCamera, Scene, WebGLRenderer } from 'three'
import { createSplatViewer, robustSplatBounds, sortForCurrentView } from '../viewer/splat'
import { splatFormatOf } from '../viewer/types'

interface Turntable {
  ready?: boolean
  error?: string
  splatCount?: number
  /** Renders view `index` of the turn and resolves with the canvas as a PNG data URL. */
  frame(index: number): Promise<string>
}

declare global {
  interface Window {
    splatboxTurntable?: Turntable
  }
}

const FOV = 40
const ELEVATION = MathUtils.degToRad(12)
const START_ANGLE = MathUtils.degToRad(25)

async function main(): Promise<Turntable> {
  const params = new URLSearchParams(window.location.search)
  const sceneUrl = params.get('scene')
  const format = splatFormatOf(`x.${params.get('format')}`)
  const size = Number(params.get('size') ?? 512)
  const frames = Number(params.get('frames') ?? 24)
  if (!sceneUrl || !format) throw new Error('expected ?scene=<url>&format=ply|splat|ksplat')

  // preserveDrawingBuffer keeps the last frame readable by toDataURL; alpha gives a transparent background.
  const renderer = new WebGLRenderer({ alpha: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(1)
  renderer.setSize(size, size)
  renderer.setClearColor(0x000000, 0)
  document.body.appendChild(renderer.domElement)

  const scene = new Scene()
  const group = new Group()
  if (params.get('flipY') === '1') group.rotation.x = Math.PI
  scene.add(group)

  const { viewer, loaded } = createSplatViewer(new URL(sceneUrl, window.location.href).href, format, 1)
  group.add(viewer)
  await loaded

  group.updateMatrixWorld(true)
  const bounds = robustSplatBounds(viewer.splatMesh).applyMatrix4(group.matrixWorld)
  const distance = (bounds.radius / Math.sin(MathUtils.degToRad(FOV) / 2)) * 1.1
  const camera = new PerspectiveCamera(FOV, 1, distance / 100, distance * 100)

  return {
    ready: true,
    splatCount: viewer.splatMesh.getSplatCount(),
    async frame(index) {
      const angle = START_ANGLE + (index / frames) * Math.PI * 2
      camera.position.set(
        bounds.center.x + Math.sin(angle) * Math.cos(ELEVATION) * distance,
        bounds.center.y + Math.sin(ELEVATION) * distance,
        bounds.center.z + Math.cos(angle) * Math.cos(ELEVATION) * distance,
      )
      camera.lookAt(bounds.center)
      camera.updateMatrixWorld()
      // The first render hands this camera to the splat viewer; then sort for it and draw again.
      renderer.render(scene, camera)
      await sortForCurrentView(viewer)
      renderer.render(scene, camera)
      return renderer.domElement.toDataURL('image/png')
    },
  }
}

main()
  .then((turntable) => (window.splatboxTurntable = turntable))
  .catch((err: unknown) => {
    window.splatboxTurntable = { error: err instanceof Error ? err.message : String(err), frame: () => Promise.reject(err) }
  })
