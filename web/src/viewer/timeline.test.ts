import { describe, expect, it } from 'vitest'
import { frameAt, initialTimeline, reduceTimeline, type TimelineEvent, type TimelineState } from './timeline'

function run(events: TimelineEvent[], from: TimelineState = initialTimeline): TimelineState {
  return events.reduce(reduceTimeline, from)
}

const loaded = run([{ type: 'LOAD', duration: 2 }])

describe('timeline state machine', () => {
  it('starts empty and ignores transport events until a clip is loaded', () => {
    const state = run([{ type: 'PLAY' }, { type: 'SEEK', time: 1 }, { type: 'TICK', dt: 0.5 }, { type: 'SCRUB_START' }])
    expect(state).toEqual(initialTimeline)
  })

  it('loads paused on the first frame', () => {
    expect(loaded).toMatchObject({ status: 'paused', time: 0, duration: 2 })
  })

  it('treats a zero or invalid duration as nothing loaded', () => {
    expect(run([{ type: 'LOAD', duration: 0 }]).status).toBe('empty')
    expect(run([{ type: 'LOAD', duration: Number.NaN }]).status).toBe('empty')
  })

  it('advances only while playing, scaled by speed', () => {
    expect(run([{ type: 'TICK', dt: 0.5 }], loaded).time).toBe(0)
    const playing = run([{ type: 'PLAY' }, { type: 'SET_SPEED', speed: 2 }, { type: 'TICK', dt: 0.25 }], loaded)
    expect(playing).toMatchObject({ status: 'playing', time: 0.5 })
  })

  it('wraps at the end when looping', () => {
    const state = run([{ type: 'PLAY' }, { type: 'TICK', dt: 1.5 }, { type: 'TICK', dt: 0.75 }], loaded)
    expect(state.status).toBe('playing')
    expect(state.time).toBeCloseTo(0.25)
  })

  it('stops on the last frame when not looping, and play restarts from zero', () => {
    const ended = run([{ type: 'SET_LOOP', loop: false }, { type: 'PLAY' }, { type: 'TICK', dt: 5 }], loaded)
    expect(ended).toMatchObject({ status: 'paused', time: 2 })
    expect(run([{ type: 'PLAY' }], ended)).toMatchObject({ status: 'playing', time: 0 })
  })

  it('clamps seeks into the clip', () => {
    expect(run([{ type: 'SEEK', time: -1 }], loaded).time).toBe(0)
    expect(run([{ type: 'SEEK', time: 99 }], loaded).time).toBe(2)
  })

  it('scrubbing pauses the clock and resumes playback on release', () => {
    const scrubbing = run([{ type: 'PLAY' }, { type: 'SCRUB_START' }, { type: 'SCRUB', time: 1.2 }, { type: 'TICK', dt: 0.5 }], loaded)
    expect(scrubbing).toMatchObject({ status: 'scrubbing', time: 1.2, resumeAfterScrub: true })
    expect(run([{ type: 'SCRUB_END' }], scrubbing)).toMatchObject({ status: 'playing', time: 1.2, resumeAfterScrub: false })
  })

  it('a scrub that started paused ends paused', () => {
    const state = run([{ type: 'SCRUB_START' }, { type: 'SCRUB', time: 0.4 }, { type: 'SCRUB_END' }], loaded)
    expect(state).toMatchObject({ status: 'paused', time: 0.4 })
  })

  it('ignores SCRUB outside a scrub gesture', () => {
    expect(run([{ type: 'SCRUB', time: 1 }], loaded).time).toBe(0)
  })

  it('adopts media time on SYNC and applies the same end-of-clip rule as TICK', () => {
    const playing = run([{ type: 'PLAY' }], loaded)
    expect(run([{ type: 'SYNC', time: 1.234 }], playing).time).toBe(1.234)
    expect(run([{ type: 'SYNC', time: 2 }], playing)).toMatchObject({ status: 'playing', time: 0 })
    const once = run([{ type: 'SET_LOOP', loop: false }, { type: 'SYNC', time: 2.01 }], playing)
    expect(once).toMatchObject({ status: 'paused', time: 2 })
  })

  it('keeps playing when a new clip is loaded mid-playback', () => {
    const state = run([{ type: 'PLAY' }, { type: 'TICK', dt: 1 }, { type: 'LOAD', duration: 5 }], loaded)
    expect(state).toMatchObject({ status: 'playing', time: 0, duration: 5 })
  })

  it('returns the same object when an event changes nothing', () => {
    expect(reduceTimeline(loaded, { type: 'PAUSE' })).toBe(loaded)
    expect(reduceTimeline(loaded, { type: 'SCRUB_END' })).toBe(loaded)
  })
})

describe('frameAt', () => {
  it('maps time to a frame index without float error at frame boundaries', () => {
    expect(frameAt(0, 30)).toBe(0)
    expect(frameAt(2 / 30, 30)).toBe(2)
    expect(frameAt(29 / 30, 30)).toBe(29)
    expect(frameAt(0.999 / 30, 30)).toBe(0)
  })
})
