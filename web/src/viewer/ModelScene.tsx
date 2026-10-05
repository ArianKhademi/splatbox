import { useGLTF, useHelper } from '@react-three/drei'
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { AnimationMixer, Box3, SkeletonHelper, Sphere, Vector3, type AnimationClip, type Object3D, type SkinnedMesh } from 'three'
import { clipFits, matchClip, useClipOnClock, type ClipMatch } from './clips'
import { debugHandle } from './debug'
import { disposeObject, modelStats, type ModelStats } from './dispose'
import { useFrameSphere } from './Stage'
import type { SyncClock } from './SyncClock'

// Converted GLBs are Draco-compressed; decode with the copy of the decoder served from /draco.
useGLTF.setDecoderPath(`${import.meta.env.BASE_URL}draco/`)

export interface ClipInfo {
  name: string
  duration: number
  external: boolean
}

export interface ModelInfo {
  clips: ClipInfo[]
  stats: ModelStats
  /** How the external clip file matched this skeleton, when one is selected. */
  externalMatch: ClipMatch | null
}

interface Bounds {
  sphere: Sphere
  floorY: number
}

/** World-space bounds of the model in its current pose; bone positions stand in when there is no mesh. */
function measure(root: Object3D): Bounds {
  root.updateMatrixWorld(true)
  const box = new Box3().setFromObject(root)
  if (box.isEmpty()) {
    const point = new Vector3()
    root.traverse((o) => box.expandByPoint(o.getWorldPosition(point)))
  }
  return { sphere: box.getBoundingSphere(new Sphere()), floorY: box.min.y }
}

/** Loads a second GLB only for its animations and reports them; the scene inside it is never shown. */
function ExternalClips({ url, onClips }: { url: string; onClips: (clips: AnimationClip[]) => void }) {
  const gltf = useGLTF(url)
  useEffect(() => {
    onClips(gltf.animations)
    return () => {
      onClips([])
      disposeObject(gltf.scene)
      useGLTF.clear(url)
    }
  }, [gltf, url, onClips])
  return null
}

interface ModelSceneProps {
  url: string
  clock: SyncClock
  clipIndex: number
  showSkeleton: boolean
  /** A GLB whose clips should be offered on this model if its skeleton matches. */
  externalClipUrl?: string | null
  onInfo: (info: ModelInfo) => void
}

export function ModelScene({ url, clock, clipIndex, showSkeleton, externalClipUrl, onInfo }: ModelSceneProps) {
  const gltf = useGLTF(url)
  const root = gltf.scene
  const rootRef = useRef<Object3D>(root)
  rootRef.current = root

  // The asset owns its GPU resources: free them and drop the loader cache entry when it leaves.
  useEffect(
    () => () => {
      disposeObject(root)
      useGLTF.clear(url)
    },
    [root, url],
  )

  useEffect(() => {
    // An animated skinned mesh moves away from the bounds computed at load, so never cull it.
    root.traverse((o) => {
      if ((o as SkinnedMesh).isSkinnedMesh) o.frustumCulled = false
    })
  }, [root])

  const [external, setExternal] = useState<AnimationClip[]>([])
  const stats = useMemo(() => modelStats(root), [root])
  const externalMatch = useMemo(() => (external[0] ? matchClip(external[0], root) : null), [external, root])

  const clips = useMemo(() => {
    const usable = external.filter((clip) => clipFits(matchClip(clip, root)))
    return [...gltf.animations.map((clip) => ({ clip, external: false })), ...usable.map((clip) => ({ clip, external: true }))]
  }, [gltf, external, root])

  useEffect(() => {
    onInfo({
      clips: clips.map(({ clip, external }) => ({ name: clip.name || 'clip', duration: clip.duration, external })),
      stats,
      externalMatch,
    })
  }, [clips, stats, externalMatch, onInfo])

  const mixer = useMemo(() => new AnimationMixer(root), [root])
  useEffect(() => {
    const handle = debugHandle()
    handle.mixerTime = () => mixer.time
    return () => {
      handle.mixerTime = undefined
      mixer.stopAllAction()
      mixer.uncacheRoot(root)
    }
  }, [mixer, root])
  useClipOnClock(mixer, clips[clipIndex]?.clip ?? null, clock)

  // A motion file without a mesh has nothing else to look at, so its skeleton is always drawn.
  useHelper((showSkeleton || stats.meshes === 0) && rootRef, SkeletonHelper)

  const bounds = useMemo(() => measure(root), [root])
  const frame = useFrameSphere()
  useEffect(() => {
    frame(bounds.sphere.center, bounds.sphere.radius)
    debugHandle().assetReady = url
  }, [frame, bounds, url])

  const gridSize = Math.max(bounds.sphere.radius * 6, 1)
  return (
    <>
      <primitive object={root} />
      <gridHelper
        args={[gridSize, 24, '#454b59', '#2a2e37']}
        position={[bounds.sphere.center.x, bounds.floorY, bounds.sphere.center.z]}
      />
      {externalClipUrl && (
        <Suspense fallback={null}>
          <ExternalClips key={externalClipUrl} url={externalClipUrl} onClips={setExternal} />
        </Suspense>
      )}
    </>
  )
}
