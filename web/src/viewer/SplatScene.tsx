import type { DropInViewer } from '@mkkellogg/gaussian-splats-3d'
import { useEffect, useRef } from 'react'
import type { Group } from 'three'
import { debugHandle } from './debug'
import { createSplatViewer, disposeSplatViewer, robustSplatBounds } from './splat'
import { useFrameSphere } from './Stage'
import type { SplatFormat } from './types'

interface SplatSceneProps {
  url: string
  format: SplatFormat
  flipY: boolean
  /** Multiplier on every splat's footprint; below 1 thins the scene, above 1 fills gaps. */
  splatScale: number
  /** Splats with alpha below this (0-255) are dropped at load time. */
  alphaThreshold: number
  onInfo: (info: { splatCount: number }) => void
  onError: (message: string) => void
}

export function SplatScene({ url, format, flipY, splatScale, alphaThreshold, onInfo, onError }: SplatSceneProps) {
  const groupRef = useRef<Group>(null)
  const viewerRef = useRef<DropInViewer | null>(null)
  const scaleRef = useRef(splatScale)
  scaleRef.current = splatScale
  const frame = useFrameSphere()
  const frameRef = useRef(frame)
  frameRef.current = frame

  useEffect(() => {
    const group = groupRef.current!
    const { viewer, loaded } = createSplatViewer(url, format, alphaThreshold)
    group.add(viewer)
    let cancelled = false
    loaded
      .then(() => {
        if (cancelled) return
        viewerRef.current = viewer
        viewer.splatMesh.setSplatScale(scaleRef.current)
        const count = viewer.splatMesh.getSplatCount()
        onInfo({ splatCount: count })
        group.updateMatrixWorld(true)
        const sphere = robustSplatBounds(viewer.splatMesh).applyMatrix4(group.matrixWorld)
        frameRef.current(sphere.center, sphere.radius)
        const handle = debugHandle()
        handle.splatCount = () => count
        handle.assetReady = url
      })
      .catch((err: unknown) => {
        if (!cancelled) onError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
      viewerRef.current = null
      debugHandle().splatCount = undefined
      group.remove(viewer)
      disposeSplatViewer(viewer)
    }
  }, [url, format, alphaThreshold, onInfo, onError])

  useEffect(() => {
    viewerRef.current?.splatMesh.setSplatScale(splatScale)
  }, [splatScale])

  return <group ref={groupRef} rotation-x={flipY ? Math.PI : 0} />
}
