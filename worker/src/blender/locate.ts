import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAC_CANDIDATES = [
  join(homedir(), 'Applications/Blender-4.5.app/Contents/MacOS/Blender'),
  '/Applications/Blender.app/Contents/MacOS/Blender',
]

/** Resolves the Blender binary: an explicit path, then `blender` on PATH, then the usual macOS locations. */
export function findBlender(configured?: string): string {
  if (configured) {
    if (!existsSync(configured)) throw new Error(`BLENDER_BIN points to "${configured}", which does not exist`)
    return configured
  }
  try {
    return execFileSync('which', ['blender'], { encoding: 'utf8' }).trim()
  } catch {
    // not on PATH
  }
  const found = MAC_CANDIDATES.find((path) => existsSync(path))
  if (found) return found
  throw new Error('Blender not found. Install Blender 4.5 LTS and put it on PATH, or set BLENDER_BIN to the binary.')
}

/** "4.5.14 LTS" from `blender --version`. */
export function blenderVersion(blenderBin: string): string {
  const out = execFileSync(blenderBin, ['--version'], { encoding: 'utf8' })
  return out.match(/^Blender (.+)$/m)?.[1]?.trim() ?? 'unknown'
}
