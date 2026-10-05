import { inspectGlb, keys, type ConvertJobData } from '@splatbox/shared'
import { UnrecoverableError } from 'bullmq'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { JobContext } from '../context'

const GLB_MIME = 'model/gltf-binary'

/**
 * convert: download the uploaded model, run it through Blender, upload the compact GLB, and record
 * the before/after numbers on the asset.
 */
export async function handleConvert(data: ConvertJobData, ctx: JobContext): Promise<Record<string, unknown>> {
  const asset = ctx.db.getAsset(data.assetId)
  const source = asset && ctx.db.getFile(asset.id, data.role)
  // Nothing a retry could fix: the asset was deleted while the job waited in the queue.
  if (!asset || !source) throw new UnrecoverableError(`asset ${data.assetId} or its ${data.role} file no longer exists`)

  const dir = await mkdtemp(join(ctx.workRoot, 'convert-'))
  try {
    const ext = extname(source.filename).toLowerCase()
    const input = join(dir, `input${ext}`)
    const output = join(dir, 'model.glb')
    await ctx.storage.downloadToFile(source.key, input)

    const report = await ctx.blender.convert(input, output)

    // Blender knows the source (which may be FBX or OBJ); the output is measured from the file itself.
    let delivered = output
    let after = inspectGlb(await readFile(output))
    let keptOriginal = false
    if (ext === '.glb' && after.bytes >= report.bytes_before) {
      // Tiny or already-compressed GLBs can come out larger. Never hand back a bigger file.
      delivered = input
      after = inspectGlb(await readFile(input))
      keptOriginal = true
    }

    const key = keys.converted(asset.id)
    const bytes = await ctx.storage.uploadFile(key, delivered, GLB_MIME)
    ctx.db.putFile({ assetId: asset.id, role: 'converted', key, filename: 'model.glb', contentType: GLB_MIME, bytes })
    ctx.db.recordConversion(asset.id, {
      bytesBefore: report.bytes_before,
      bytesAfter: bytes,
      trianglesBefore: report.before.triangles,
      trianglesAfter: after.triangles,
      texturesBefore: report.before.textures,
      texturesAfter: after.textures,
    })
    return {
      blenderSeconds: report.seconds,
      blender: report.blender,
      resizedTextures: report.resized_textures.length,
      dracoPrimitives: after.dracoPrimitives,
      keptOriginal,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
