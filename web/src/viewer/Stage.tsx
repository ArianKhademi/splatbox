import { OrbitControls } from '@react-three/drei'
import { Canvas, useThree } from '@react-three/fiber'
import { useCallback, useEffect, type ReactNode } from 'react'
import { MathUtils, PMREMGenerator, Vector3, type PerspectiveCamera } from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { ClockDriver } from './ClockDriver'
import { debugHandle } from './debug'
import type { SyncClock } from './SyncClock'

/** Image-based lighting from three's procedural studio room: no HDRI download, same look everywhere. */
function StudioEnvironment() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  useEffect(() => {
    const pmrem = new PMREMGenerator(gl)
    const room = new RoomEnvironment()
    const target = pmrem.fromScene(room, 0.04)
    scene.environment = target.texture
    room.dispose()
    pmrem.dispose()
    return () => {
      scene.environment = null
      target.dispose()
    }
  }, [gl, scene])
  return null
}

function DebugProbe() {
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    const handle = debugHandle()
    handle.rendererMemory = () => ({ geometries: gl.info.memory.geometries, textures: gl.info.memory.textures })
    return () => {
      handle.rendererMemory = undefined
    }
  }, [gl])
  return null
}

const VIEW_DIRECTION = new Vector3(0.55, 0.32, 1).normalize()

/**
 * Returns a function that frames a bounding sphere: it places the camera along a fixed three-quarter
 * direction at the distance where the sphere just fits the narrower of the two fields of view, and
 * points the orbit controls at the sphere's centre.
 */
export function useFrameSphere(): (center: Vector3, radius: number) => void {
  const camera = useThree((s) => s.camera) as PerspectiveCamera
  const controls = useThree((s) => s.controls) as unknown as { target: Vector3; update(): void } | null
  const aspect = useThree((s) => s.size.width / s.size.height)
  return useCallback(
    (center: Vector3, radius: number) => {
      const halfV = MathUtils.degToRad(camera.fov) / 2
      const halfH = Math.atan(Math.tan(halfV) * aspect)
      const distance = (Math.max(radius, 1e-3) / Math.sin(Math.min(halfV, halfH))) * 1.1
      camera.position.copy(center).addScaledVector(VIEW_DIRECTION, distance)
      camera.near = distance / 100
      camera.far = distance * 100
      camera.updateProjectionMatrix()
      controls?.target.copy(center)
      controls?.update()
    },
    [camera, controls, aspect],
  )
}

/** The one persistent canvas of the viewer. Assets come and go as children; the renderer stays. */
export function Stage({ clock, children }: { clock: SyncClock; children: ReactNode }) {
  return (
    <Canvas camera={{ fov: 40, near: 0.05, far: 500, position: [2, 1.5, 4] }} dpr={[1, 2]}>
      <color attach="background" args={['#14161b']} />
      <StudioEnvironment />
      <OrbitControls makeDefault enableDamping dampingFactor={0.12} />
      <ClockDriver clock={clock} />
      <DebugProbe />
      {children}
    </Canvas>
  )
}
