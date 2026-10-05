import { fileURLToPath } from 'node:url'
import { runBlender } from './run'

const CONVERT_SCRIPT = fileURLToPath(new URL('../../blender/convert.py', import.meta.url))
const TURNTABLE_SCRIPT = fileURLToPath(new URL('../../blender/turntable.py', import.meta.url))

export interface ConvertOptions {
  draco: boolean
  /** Longest texture side in pixels; larger textures are downscaled. */
  maxTexture: number
  textureFormat: 'webp' | 'jpeg' | 'auto'
  textureQuality: number
}

/** The conversion profile used by the worker and by the benchmark. */
export const DEFAULT_CONVERT_OPTIONS: ConvertOptions = {
  draco: true,
  maxTexture: 2048,
  textureFormat: 'webp',
  textureQuality: 75,
}

/** What convert.py prints as its SPLATBOX_RESULT. */
export interface ConvertReport {
  bytes_before: number
  bytes_after: number
  before: { triangles: number; meshes: number; textures: number; armatures: number; animations: number }
  removed: { cameras: number; lights: number; empties: number }
  /** One entry per texture: left as it was, re-encoded, or resized (and re-encoded). */
  textures: { name: string; size: [number, number]; bytes_before: number | null; action: 'kept' | 're-encoded' | 'resized'; format?: string; to?: [number, number]; bytes_after?: number }[]
  resized_textures: { name: string; size: [number, number]; to?: [number, number] }[]
  settings: Record<string, unknown>
  blender: string
  seconds: number
}

export type TurntableEngine = 'eevee' | 'workbench'

export interface TurntableOptions {
  frames: number
  size: number
  engine: TurntableEngine
}

/** What turntable.py prints as its SPLATBOX_RESULT. */
export interface TurntableReport {
  frames: string[]
  engine: string
  radius: number
  seconds: number
}

/** The two Blender operations the jobs need. An interface so tests can substitute a fake. */
export interface BlenderTools {
  convert(input: string, output: string, options?: ConvertOptions): Promise<ConvertReport>
  turntable(input: string, outDir: string, options: TurntableOptions): Promise<TurntableReport>
}

export function createBlenderTools(blenderBin: string): BlenderTools {
  return {
    convert(input, output, options = DEFAULT_CONVERT_OPTIONS) {
      const args = ['--in', input, '--out', output, '--max-texture', String(options.maxTexture)]
      if (options.draco) args.push('--draco')
      args.push('--texture-format', options.textureFormat, '--texture-quality', String(options.textureQuality))
      return runBlender<ConvertReport>({ blenderBin, script: CONVERT_SCRIPT, args })
    },
    turntable(input, outDir, options) {
      const args = ['--in', input, '--out-dir', outDir, '--frames', String(options.frames), '--size', String(options.size), '--engine', options.engine]
      return runBlender<TurntableReport>({ blenderBin, script: TURNTABLE_SCRIPT, args })
    },
  }
}
