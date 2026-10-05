/**
 * The transport state machine behind the timeline: a pure reducer with no timers, DOM, or three.js
 * in it. SyncClock feeds it events and applies the resulting state to the video and the mixer.
 */

export type TimelineStatus = 'empty' | 'paused' | 'playing' | 'scrubbing'

export interface TimelineState {
  status: TimelineStatus
  /** Seconds into the clip, always within [0, duration]. */
  time: number
  /** Seconds. 0 while nothing is loaded. */
  duration: number
  speed: number
  loop: boolean
  /** Set when a scrub interrupts playback, so releasing the scrubber resumes it. */
  resumeAfterScrub: boolean
}

export type TimelineEvent =
  | { type: 'LOAD'; duration: number }
  | { type: 'UNLOAD' }
  | { type: 'PLAY' }
  | { type: 'PAUSE' }
  | { type: 'TOGGLE' }
  | { type: 'SEEK'; time: number }
  | { type: 'SCRUB_START' }
  | { type: 'SCRUB'; time: number }
  | { type: 'SCRUB_END' }
  /** Free-running playback: advance by `dt` seconds of wall time. */
  | { type: 'TICK'; dt: number }
  /** Media-driven playback: adopt the time reported by the video element. */
  | { type: 'SYNC'; time: number }
  | { type: 'SET_SPEED'; speed: number }
  | { type: 'SET_LOOP'; loop: boolean }

export const initialTimeline: TimelineState = {
  status: 'empty',
  time: 0,
  duration: 0,
  speed: 1,
  loop: true,
  resumeAfterScrub: false,
}

function clamp(time: number, duration: number): number {
  return Math.min(Math.max(time, 0), duration)
}

/** Where playback lands when it reaches `time` while playing: wrap if looping, else stop at the end. */
function advanceTo(state: TimelineState, time: number): TimelineState {
  if (time < state.duration) return { ...state, time: Math.max(time, 0) }
  if (state.loop) return { ...state, time: time % state.duration }
  return { ...state, time: state.duration, status: 'paused' }
}

export function reduceTimeline(state: TimelineState, event: TimelineEvent): TimelineState {
  // Speed and loop are preferences: they apply in every state, including empty.
  if (event.type === 'SET_SPEED') return event.speed > 0 ? { ...state, speed: event.speed } : state
  if (event.type === 'SET_LOOP') return { ...state, loop: event.loop }

  if (event.type === 'LOAD') {
    if (!(event.duration > 0)) return { ...state, status: 'empty', time: 0, duration: 0, resumeAfterScrub: false }
    // Switching clips mid-playback keeps playing; anything else starts paused on the first frame.
    const status = state.status === 'playing' ? 'playing' : 'paused'
    return { ...state, status, time: 0, duration: event.duration, resumeAfterScrub: false }
  }
  if (event.type === 'UNLOAD') return { ...state, status: 'empty', time: 0, duration: 0, resumeAfterScrub: false }

  if (state.status === 'empty') return state

  switch (event.type) {
    case 'PLAY':
      if (state.status !== 'paused') return state
      // Pressing play at the end of a non-looping clip restarts it.
      return { ...state, status: 'playing', time: state.time >= state.duration ? 0 : state.time }
    case 'PAUSE':
      return state.status === 'playing' ? { ...state, status: 'paused' } : state
    case 'TOGGLE':
      if (state.status === 'playing') return reduceTimeline(state, { type: 'PAUSE' })
      if (state.status === 'paused') return reduceTimeline(state, { type: 'PLAY' })
      return state
    case 'SEEK':
      return { ...state, time: clamp(event.time, state.duration) }
    case 'SCRUB_START':
      if (state.status === 'scrubbing') return state
      return { ...state, status: 'scrubbing', resumeAfterScrub: state.status === 'playing' }
    case 'SCRUB':
      return state.status === 'scrubbing' ? { ...state, time: clamp(event.time, state.duration) } : state
    case 'SCRUB_END':
      if (state.status !== 'scrubbing') return state
      return { ...state, status: state.resumeAfterScrub ? 'playing' : 'paused', resumeAfterScrub: false }
    case 'TICK':
      return state.status === 'playing' ? advanceTo(state, state.time + event.dt * state.speed) : state
    case 'SYNC':
      return state.status === 'playing' ? advanceTo(state, event.time) : state
  }
}

/**
 * Frame index shown in the readouts. A time that should sit exactly on a frame boundary rarely
 * does: 2/30 is not representable in binary, and a video element reports its time truncated to
 * the microsecond (1.233333 for frame 37 at 30 fps). A thousandth of a frame of slack absorbs both.
 */
export function frameAt(time: number, fps: number): number {
  return Math.floor(time * fps + 1e-3)
}
