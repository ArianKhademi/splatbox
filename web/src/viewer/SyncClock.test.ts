import { AnimationClip, AnimationMixer, Object3D, VectorKeyframeTrack } from 'three'
import { describe, expect, it } from 'vitest'
import { poseTarget } from './clips'
import { SyncClock, type MediaLike } from './SyncClock'

const FRAME = 1 / 30

/** Stands in for a <video>: a media clock that runs on its own, at its own rate, until the end. */
class FakeVideo implements MediaLike {
  currentTime = 0
  playbackRate = 1
  paused = true
  playCalls = 0
  constructor(readonly duration: number) {}
  play(): Promise<void> {
    this.paused = false
    this.playCalls++
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
  /** What the browser does between two animation frames. */
  advance(dt: number): void {
    if (this.paused) return
    this.currentTime = Math.min(this.duration, this.currentTime + dt * this.playbackRate)
    if (this.currentTime >= this.duration) this.paused = true
  }
}

/** A mixer whose pose is easy to read back: the clip moves `root.position.x` from 0 to `duration`. */
function makeRig(duration: number) {
  const root = new Object3D()
  root.name = 'root'
  const clip = new AnimationClip('slide', duration, [new VectorKeyframeTrack('root.position', [0, duration], [0, 0, 0, duration, 0, 0])])
  const mixer = new AnimationMixer(root)
  mixer.clipAction(clip).play()
  return { root, clip, mixer }
}

function makePair(duration = 4) {
  const video = new FakeVideo(duration)
  const rig = makeRig(duration)
  const clock = new SyncClock()
  clock.load(duration)
  clock.attachMedia(video)
  clock.addTarget(poseTarget(rig.mixer, rig.clip))
  return { video, clock, ...rig }
}

/** Deterministic jitter so frame intervals are uneven, like real requestAnimationFrame timing. */
function jitter(i: number): number {
  return 1 / 60 + Math.sin(i * 12.9898) * 0.004
}

describe('SyncClock without media', () => {
  it('free-runs on the frame delta and poses targets from clock time', () => {
    const { mixer, clip, root } = makeRig(2)
    const clock = new SyncClock()
    clock.load(2)
    clock.addTarget(poseTarget(mixer, clip))
    clock.play()
    for (let i = 0; i < 30; i++) clock.tick(1 / 60)
    expect(clock.getState().time).toBeCloseTo(0.5)
    expect(mixer.time).toBeCloseTo(0.5)
    expect(root.position.x).toBeCloseTo(0.5)
  })

  it('poses a newly attached target immediately', () => {
    const { mixer, clip, root } = makeRig(2)
    const clock = new SyncClock()
    clock.load(2)
    clock.seek(1.25)
    clock.addTarget(poseTarget(mixer, clip))
    expect(root.position.x).toBeCloseTo(1.25)
  })

  it('holds the final pose at the end of a non-looping clip instead of wrapping to frame 0', () => {
    const { mixer, clip, root } = makeRig(2)
    const clock = new SyncClock()
    clock.load(2)
    clock.setLoop(false)
    clock.addTarget(poseTarget(mixer, clip))
    clock.play()
    clock.tick(5)
    expect(clock.getState()).toMatchObject({ status: 'paused', time: 2 })
    expect(root.position.x).toBeCloseTo(2, 3)
  })

  it('notifies subscribers only when the state changes', () => {
    const clock = new SyncClock()
    let calls = 0
    clock.subscribe(() => calls++)
    clock.tick(0.1) // empty: nothing to do
    expect(calls).toBe(0)
    clock.load(1)
    clock.play()
    clock.tick(0.1)
    expect(calls).toBe(3)
  })
})

describe('SyncClock with a video (pair mode)', () => {
  it('keeps video.currentTime and mixer.time within one frame at 30 fps while playing', () => {
    const { video, clock, mixer, root } = makePair(4)
    clock.play()
    let worst = 0
    for (let i = 0; i < 200; i++) {
      video.advance(jitter(i)) // the media clock moves on its own schedule...
      clock.tick(jitter(i + 1000)) // ...and the render loop's delta is unrelated to it
      worst = Math.max(worst, Math.abs(video.currentTime - mixer.time))
      expect(root.position.x).toBeCloseTo(video.currentTime, 5)
    }
    expect(video.currentTime).toBeGreaterThan(3)
    expect(worst).toBeLessThanOrEqual(FRAME)
  })

  it('shares play and pause with the video', () => {
    const { video, clock } = makePair()
    clock.play()
    expect(video.paused).toBe(false)
    video.advance(0.5)
    clock.pause()
    expect(video.paused).toBe(true)
    // Pausing settles on the exact time the video stopped at.
    expect(clock.getState()).toMatchObject({ status: 'paused', time: 0.5 })
  })

  it('scrubbing moves the video and the mixer together, frame for frame', () => {
    const { video, clock, mixer } = makePair()
    clock.play()
    video.advance(1)
    clock.tick(1 / 60)
    clock.beginScrub()
    expect(video.paused).toBe(true)
    for (const frame of [45, 46, 47, 12, 0, 119]) {
      clock.scrubTo(frame * FRAME)
      expect(video.currentTime).toBeCloseTo(frame * FRAME, 10)
      expect(mixer.time).toBeCloseTo(frame * FRAME, 10)
      expect(Math.abs(video.currentTime - mixer.time)).toBeLessThanOrEqual(FRAME)
    }
    clock.endScrub()
    expect(video.paused).toBe(false) // it was playing before the scrub, so it resumes
  })

  it('seeking while paused writes the time into the video', () => {
    const { video, clock, mixer } = makePair()
    clock.seek(2.5)
    expect(video.currentTime).toBe(2.5)
    expect(mixer.time).toBe(2.5)
    expect(video.paused).toBe(true)
  })

  it('loops by rewinding the video when it reaches the end', () => {
    const { video, clock, mixer } = makePair(1)
    clock.play()
    video.advance(1.5) // runs to the end and stops, like a real video without the loop attribute
    expect(video.paused).toBe(true)
    clock.tick(1 / 60)
    expect(video.currentTime).toBe(0)
    expect(video.paused).toBe(false)
    expect(mixer.time).toBe(0)
    expect(clock.getState().status).toBe('playing')
  })

  it('stops both at the end when not looping', () => {
    const { video, clock, mixer } = makePair(1)
    clock.setLoop(false)
    clock.play()
    video.advance(1.5)
    clock.tick(1 / 60)
    expect(clock.getState()).toMatchObject({ status: 'paused', time: 1 })
    expect(video.paused).toBe(true)
    expect(mixer.time).toBeCloseTo(1, 3)
  })

  it('applies the speed to the video playback rate', () => {
    const { video, clock, mixer } = makePair()
    clock.setSpeed(0.5)
    expect(video.playbackRate).toBe(0.5)
    clock.play()
    video.advance(1)
    clock.tick(1 / 60)
    expect(mixer.time).toBeCloseTo(0.5)
  })

  it('falls back to paused when the browser refuses to play', async () => {
    const { video, clock } = makePair()
    video.play = () => Promise.reject(new Error('NotAllowedError'))
    clock.play()
    await Promise.resolve()
    await Promise.resolve()
    expect(clock.getState().status).toBe('paused')
  })
})
