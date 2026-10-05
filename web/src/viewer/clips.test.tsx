import ReactThreeTestRenderer from '@react-three/test-renderer'
import { useMemo } from 'react'
import { AnimationClip, AnimationMixer, Bone, Object3D, QuaternionKeyframeTrack, VectorKeyframeTrack } from 'three'
import { describe, expect, it } from 'vitest'
import { ClockDriver } from './ClockDriver'
import { clipFits, matchClip, useClipOnClock } from './clips'
import { SyncClock } from './SyncClock'

function skeleton(names: string[]): Object3D {
  const root = new Object3D()
  let parent: Object3D = root
  for (const name of names) {
    const bone = new Bone()
    bone.name = name
    parent.add(bone)
    parent = bone
  }
  return root
}

function rotationClip(boneNames: string[]): AnimationClip {
  const tracks = boneNames.map((name) => new QuaternionKeyframeTrack(`${name}.quaternion`, [0, 1], [0, 0, 0, 1, 0, 0.7071, 0, 0.7071]))
  return new AnimationClip('motion', 1, tracks)
}

describe('matchClip', () => {
  it('binds every track when the skeleton has all the bones', () => {
    const match = matchClip(rotationClip(['Hips', 'Spine', 'Head']), skeleton(['Hips', 'Spine', 'Head']))
    expect(match).toEqual({ bound: 3, total: 3, missing: [] })
    expect(clipFits(match)).toBe(true)
  })

  it('reports the bones a mismatched skeleton lacks and rejects the clip', () => {
    const match = matchClip(rotationClip(['Hips', 'Spine', 'Head']), skeleton(['pelvis', 'Spine']))
    expect(match.bound).toBe(1)
    expect(match.missing.sort()).toEqual(['Head', 'Hips'])
    expect(clipFits(match)).toBe(false)
  })

  it('rejects an empty clip', () => {
    expect(clipFits(matchClip(new AnimationClip('empty', 0, []), skeleton(['Hips'])))).toBe(false)
  })
})

/** A scene that plays one clip on one object under the clock, the way the model viewer does. */
function Slider({ clock, target, clip }: { clock: SyncClock; target: Object3D; clip: AnimationClip }) {
  const mixer = useMemo(() => new AnimationMixer(target), [target])
  useClipOnClock(mixer, clip, clock)
  return (
    <>
      <ClockDriver clock={clock} />
      <primitive object={target} />
    </>
  )
}

describe('clock-driven playback inside the render loop', () => {
  function setup() {
    const target = new Object3D()
    target.name = 'slider'
    const clip = new AnimationClip('slide', 2, [new VectorKeyframeTrack('slider.position', [0, 2], [0, 0, 0, 2, 0, 0])])
    const clock = new SyncClock()
    clock.load(clip.duration)
    return { target, clip, clock }
  }

  it('advances the pose only while the clock is playing', async () => {
    const { target, clip, clock } = setup()
    const renderer = await ReactThreeTestRenderer.create(<Slider clock={clock} target={target} clip={clip} />)

    await renderer.advanceFrames(10, 1 / 60)
    expect(target.position.x).toBe(0)

    clock.play()
    await renderer.advanceFrames(30, 1 / 60)
    expect(clock.getState().time).toBeCloseTo(0.5)
    expect(target.position.x).toBeCloseTo(0.5)

    clock.pause()
    await renderer.advanceFrames(30, 1 / 60)
    expect(target.position.x).toBeCloseTo(0.5)
    await renderer.unmount()
  })

  it('scrubbing poses the object at the scrubbed time on the next frame', async () => {
    const { target, clip, clock } = setup()
    const renderer = await ReactThreeTestRenderer.create(<Slider clock={clock} target={target} clip={clip} />)
    clock.beginScrub()
    clock.scrubTo(1.5)
    await renderer.advanceFrames(1, 1 / 60)
    expect(target.position.x).toBeCloseTo(1.5)
    clock.scrubTo(0.25)
    await renderer.advanceFrames(1, 1 / 60)
    expect(target.position.x).toBeCloseTo(0.25)
    await renderer.unmount()
  })

  it('returns the object to its rest pose when the clip is unbound', async () => {
    const { target, clip, clock } = setup()
    const renderer = await ReactThreeTestRenderer.create(<Slider clock={clock} target={target} clip={clip} />)
    clock.seek(1)
    await renderer.advanceFrames(1, 1 / 60)
    expect(target.position.x).toBeCloseTo(1)
    await renderer.unmount()
    expect(target.position.x).toBe(0)
  })
})
