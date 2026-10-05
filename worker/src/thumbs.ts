import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

/** One full turn is 24 frames at 15 degrees; at 100 ms a frame the loop takes 2.4 seconds. */
export const TURNTABLE_FRAMES = 24
export const TURNTABLE_SIZE = 512
const FRAME_DELAY_MS = 100

export interface EncodedTurntable {
  /** Frame 0 as a still PNG, shown in the grid until the card is hovered. */
  posterPath: string
  /** All frames as one endlessly looping animated WebP. */
  turntablePath: string
}

/** Encodes rendered frames (PNG files, in turn order) into the poster and the animated turntable. */
export async function encodeTurntable(framePaths: string[], outDir: string): Promise<EncodedTurntable> {
  if (framePaths.length === 0) throw new Error('no frames to encode')
  const posterPath = join(outDir, 'poster.png')
  const turntablePath = join(outDir, 'turntable.webp')
  await copyFile(framePaths[0]!, posterPath)
  // `join: { animated: true }` stacks the input images as the pages of one animation.
  await sharp(framePaths, { join: { animated: true } })
    .webp({ quality: 80, effort: 4, loop: 0, delay: FRAME_DELAY_MS })
    .toFile(turntablePath)
  return { posterPath, turntablePath }
}
