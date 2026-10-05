import { useEffect } from 'react'
import { PropertyBinding, type AnimationClip, type AnimationMixer, type Object3D } from 'three'
import type { SyncClock, TimeTarget } from './SyncClock'

const END_EPSILON = 1e-4

export interface ClipMatch {
  /** Tracks whose target node exists under the root. */
  bound: number
  total: number
  /** Node names the clip animates that the root does not have. */
  missing: string[]
}

/** Checks a clip against a skeleton. glTF animation tracks address nodes by name, e.g. `Hips.quaternion`. */
export function matchClip(clip: AnimationClip, root: Object3D): ClipMatch {
  const missing = new Set<string>()
  let bound = 0
  for (const track of clip.tracks) {
    const { nodeName } = PropertyBinding.parseTrackName(track.name)
    if (PropertyBinding.findNode(root, nodeName)) bound++
    else missing.add(nodeName)
  }
  return { bound, total: clip.tracks.length, missing: [...missing] }
}

/** An external clip is applied only when (almost) all of its tracks find a bone to drive. */
export function clipFits(match: ClipMatch): boolean {
  return match.total > 0 && match.bound / match.total >= 0.9
}

/**
 * Adapts a mixer to the clock. `mixer.setTime(t)` poses the clip at an absolute time, but a looping
 * action wraps to its first frame at exactly t = duration, so the last instant is held just short.
 */
export function poseTarget(mixer: AnimationMixer, clip: AnimationClip): TimeTarget {
  const last = Math.max(0, clip.duration - END_EPSILON)
  return { setTime: (seconds) => mixer.setTime(Math.min(seconds, last)) }
}

/** Binds `clip` to the mixer and lets the clock pose it; unbinding restores the rest pose. */
export function useClipOnClock(mixer: AnimationMixer, clip: AnimationClip | null, clock: SyncClock): void {
  useEffect(() => {
    if (!clip) return
    const action = mixer.clipAction(clip)
    action.play()
    const detach = clock.addTarget(poseTarget(mixer, clip))
    return () => {
      detach()
      action.stop()
      mixer.uncacheClip(clip)
    }
  }, [mixer, clip, clock])
}
