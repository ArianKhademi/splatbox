import { initialTimeline, reduceTimeline, type TimelineEvent, type TimelineState } from './timeline'

/** The part of HTMLMediaElement the clock uses; narrow so tests can supply a fake. */
export interface MediaLike {
  currentTime: number
  playbackRate: number
  readonly paused: boolean
  play(): Promise<void> | void
  pause(): void
}

/** Anything that can be posed at an absolute time. THREE.AnimationMixer already has this shape. */
export interface TimeTarget {
  setTime(seconds: number): unknown
}

/**
 * The one clock of the viewer. It owns the transport state (play, pause, scrub, loop, speed) and
 * one `time`, and pushes that time to every attached target with `setTime`, so a pose is always a
 * pure function of clock time whether the user is playing or dragging the scrubber.
 *
 * With a video attached (pair mode) the video's own media clock is the timebase while playing:
 * the browser decodes and presents video frames on its own schedule and cannot be stepped from
 * outside without seeking, so each tick the clock reads `video.currentTime` and poses the mixer at
 * exactly that time. Whenever the user decides the time instead (seek, scrub, loop wrap), the
 * clock writes it into the video. Without a video the clock free-runs on the frame delta.
 */
export class SyncClock {
  private state: TimelineState = initialTimeline
  private media: MediaLike | null = null
  private readonly targets = new Set<TimeTarget>()
  private readonly listeners = new Set<() => void>()

  // Arrow properties so they can be handed straight to useSyncExternalStore.
  getState = (): TimelineState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  attachMedia(media: MediaLike): () => void {
    this.media = media
    this.applyToMedia(true)
    return () => {
      if (this.media === media) this.media = null
    }
  }

  addTarget(target: TimeTarget): () => void {
    this.targets.add(target)
    target.setTime(this.state.time)
    return () => this.targets.delete(target)
  }

  load(duration: number): void {
    this.dispatch({ type: 'LOAD', duration })
  }
  unload(): void {
    this.dispatch({ type: 'UNLOAD' })
  }
  play(): void {
    this.dispatch({ type: 'PLAY' })
  }
  pause(): void {
    // Settle on the frame the video actually stopped at before leaving the playing state.
    if (this.media && this.state.status === 'playing') this.followMedia()
    this.dispatch({ type: 'PAUSE' })
  }
  toggle(): void {
    if (this.state.status === 'playing') this.pause()
    else this.play()
  }
  seek(time: number): void {
    this.dispatch({ type: 'SEEK', time })
  }
  beginScrub(): void {
    this.dispatch({ type: 'SCRUB_START' })
  }
  scrubTo(time: number): void {
    this.dispatch({ type: 'SCRUB', time })
  }
  endScrub(): void {
    this.dispatch({ type: 'SCRUB_END' })
  }
  setSpeed(speed: number): void {
    this.dispatch({ type: 'SET_SPEED', speed })
  }
  setLoop(loop: boolean): void {
    this.dispatch({ type: 'SET_LOOP', loop })
  }

  /** Called once per rendered frame with the seconds elapsed since the previous frame. */
  tick(dt: number): void {
    if (this.state.status === 'playing') {
      if (this.media) this.followMedia()
      else this.dispatch({ type: 'TICK', dt })
    }
    this.pushTime()
  }

  private followMedia(): void {
    const reported = this.media!.currentTime
    const before = this.state
    this.state = reduceTimeline(before, { type: 'SYNC', time: reported })
    // The reducer only departs from the reported time at the end of the clip (loop wrap or stop);
    // that is the one case during playback where the clock has to move the video.
    this.applyToMedia(this.state.time !== reported)
    if (this.state !== before) this.notify()
  }

  private dispatch(event: TimelineEvent): void {
    const before = this.state
    this.state = reduceTimeline(before, event)
    if (this.state === before) return
    // A newly loaded clip always starts the video from the clock's time, even if both read 0.
    this.applyToMedia(event.type === 'LOAD' || this.state.time !== before.time)
    this.pushTime()
    this.notify()
  }

  /** Makes the video match the transport state. `writeTime` is set when the clock chose the time. */
  private applyToMedia(writeTime: boolean): void {
    const media = this.media
    if (!media) return
    const { status, time, speed } = this.state
    if (media.playbackRate !== speed) media.playbackRate = speed
    if (writeTime && media.currentTime !== time) media.currentTime = time
    if (status === 'playing' && media.paused) {
      // play() rejects when the browser blocks playback; fall back to paused rather than drifting.
      Promise.resolve(media.play()).catch(() => this.dispatch({ type: 'PAUSE' }))
    } else if (status !== 'playing' && !media.paused) {
      media.pause()
    }
  }

  private pushTime(): void {
    for (const target of this.targets) target.setTime(this.state.time)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
