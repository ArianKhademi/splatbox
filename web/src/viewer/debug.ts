import type { SyncClock } from './SyncClock'

/**
 * A small read-only window onto viewer internals, published as `window.__splatbox`. The end-to-end
 * tests and the perf script use it to read renderer memory counters and the two sides of the sync.
 */
export interface DebugHandle {
  clock?: SyncClock
  rendererMemory?: () => { geometries: number; textures: number }
  mixerTime?: () => number | null
  videoTime?: () => number | null
  splatCount?: () => number | null
  /** Resolves once the open asset has loaded and been framed. */
  assetReady?: string | null
}

declare global {
  interface Window {
    __splatbox?: DebugHandle
  }
}

export function debugHandle(): DebugHandle {
  return (window.__splatbox ??= {})
}
