import { useFrame } from '@react-three/fiber'
import type { SyncClock } from './SyncClock'

/** Ticks the clock once per rendered frame, before the scene is drawn. */
export function ClockDriver({ clock }: { clock: SyncClock }) {
  useFrame((_, delta) => clock.tick(delta))
  return null
}
