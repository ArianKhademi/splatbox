import { useSyncExternalStore, type PointerEvent } from 'react'
import type { SyncClock } from './SyncClock'
import { frameAt } from './timeline'

const SPEEDS = [0.25, 0.5, 1, 2]

export function useClockState(clock: SyncClock) {
  return useSyncExternalStore(clock.subscribe, clock.getState)
}

/** Transport bar: play/pause, a scrubber, time and frame readouts, loop and speed. */
export function Timeline({ clock, fps }: { clock: SyncClock; fps: number }) {
  const state = useClockState(clock)
  const empty = state.status === 'empty'
  const playing = state.status === 'playing' || (state.status === 'scrubbing' && state.resumeAfterScrub)

  const beginScrub = (e: PointerEvent<HTMLInputElement>) => {
    // Capture the pointer so the release reaches us even if it happens off the slider.
    e.currentTarget.setPointerCapture(e.pointerId)
    clock.beginScrub()
  }
  const setTime = (time: number) => {
    // Dragging arrives as a scrub; keyboard arrows on the slider arrive as plain seeks.
    if (clock.getState().status === 'scrubbing') clock.scrubTo(time)
    else clock.seek(time)
  }

  return (
    <div className="timeline" data-status={state.status}>
      <button type="button" className="play" disabled={empty} onClick={() => clock.toggle()} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <input
        className="scrubber"
        type="range"
        aria-label="Timeline"
        min={0}
        max={state.duration || 1}
        step="any"
        value={state.time}
        disabled={empty}
        onPointerDown={beginScrub}
        onPointerUp={() => clock.endScrub()}
        onPointerCancel={() => clock.endScrub()}
        onChange={(e) => setTime(Number(e.target.value))}
      />
      <output className="readout" data-testid="time-readout">
        {state.time.toFixed(2)}s / {state.duration.toFixed(2)}s
      </output>
      <output className="readout" data-testid="frame-readout">
        frame {frameAt(state.time, fps)} / {frameAt(state.duration, fps)}
      </output>
      <label className="toggle">
        <input type="checkbox" checked={state.loop} onChange={(e) => clock.setLoop(e.target.checked)} /> Loop
      </label>
      <select aria-label="Speed" value={state.speed} onChange={(e) => clock.setSpeed(Number(e.target.value))}>
        {SPEEDS.map((speed) => (
          <option key={speed} value={speed}>
            {speed}×
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * Frame counter for one side of a pair. It re-renders on every clock update but reads its number
 * from the thing it labels (the video element or the mixer), not from the clock, so the two badges
 * agreeing on screen is evidence of sync rather than a tautology.
 */
export function FrameBadge({ clock, label, fps, read }: { clock: SyncClock; label: string; fps: number; read: () => number | null }) {
  useClockState(clock)
  const time = read()
  return (
    <div className="frame-badge" data-testid={`${label}-frame`}>
      {label} frame {time === null ? '-' : frameAt(time, fps)}
    </div>
  )
}
