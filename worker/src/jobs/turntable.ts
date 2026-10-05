import { extensionOf, keys, type TurntableJobData } from '@splatbox/shared'
import { UnrecoverableError } from 'bullmq'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { JobContext } from '../context'
import { encodeTurntable, TURNTABLE_FRAMES, TURNTABLE_SIZE } from '../thumbs'

/**
 * turntable: render 24 views of the asset 15 degrees apart, encode them as a looping WebP plus a
 * poster PNG, and upload both under thumbs/{assetId}/.
 *
 * Models are rendered by Blender from the converted GLB. Blender has no Gaussian splat renderer,
 * so splat scenes are rendered by the web viewer's own code in a headless Chromium instead.
 */
export async function handleTurntable(data: TurntableJobData, ctx: JobContext): Promise<Record<string, unknown>> {
  const asset = ctx.db.getAsset(data.assetId)
  if (!asset) throw new UnrecoverableError(`asset ${data.assetId} no longer exists`)
  const isSplat = asset.kind === 'splat'
  const input = ctx.db.getFile(asset.id, isSplat ? 'source' : 'converted')
  if (!input) throw new UnrecoverableError(`asset ${asset.id} has no ${isSplat ? 'source' : 'converted'} file to render`)

  const dir = await mkdtemp(join(ctx.workRoot, 'turntable-'))
  try {
    const framesDir = join(dir, 'frames')
    await mkdir(framesDir)
    const started = Date.now()
    let frames: string[]
    let renderer: string

    if (isSplat) {
      const ext = extensionOf(input.filename)
      const scene = join(dir, `scene${ext}`)
      await ctx.storage.downloadToFile(input.key, scene)
      frames = await ctx.splat.render({
        scenePath: scene,
        format: ext.slice(1),
        flipY: asset.meta.flipY === true,
        outDir: framesDir,
        frames: TURNTABLE_FRAMES,
        size: TURNTABLE_SIZE,
      })
      renderer = 'chromium'
    } else {
      const model = join(dir, 'model.glb')
      await ctx.storage.downloadToFile(input.key, model)
      const report = await ctx.blender.turntable(model, framesDir, { frames: TURNTABLE_FRAMES, size: TURNTABLE_SIZE, engine: ctx.turntableEngine })
      frames = report.frames
      renderer = `blender ${report.engine}`
    }
    if (frames.length !== TURNTABLE_FRAMES) throw new Error(`expected ${TURNTABLE_FRAMES} frames, the renderer produced ${frames.length}`)
    const renderMs = Date.now() - started

    const { posterPath, turntablePath } = await encodeTurntable(frames, dir)
    const posterKey = keys.poster(asset.id)
    const turntableKey = keys.turntable(asset.id)
    const posterBytes = await ctx.storage.uploadFile(posterKey, posterPath, 'image/png')
    const turntableBytes = await ctx.storage.uploadFile(turntableKey, turntablePath, 'image/webp')
    ctx.db.putFile({ assetId: asset.id, role: 'poster', key: posterKey, filename: 'poster.png', contentType: 'image/png', bytes: posterBytes })
    ctx.db.putFile({
      assetId: asset.id,
      role: 'turntable',
      key: turntableKey,
      filename: 'turntable.webp',
      contentType: 'image/webp',
      bytes: turntableBytes,
    })
    return { frames: frames.length, renderer, renderMs, posterBytes, turntableBytes }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
