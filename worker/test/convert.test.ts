import { inspectGlb } from '@splatbox/shared'
import { UnrecoverableError } from 'bullmq'
import { writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { BlenderError } from '../src/blender/run'
import { handleConvert } from '../src/jobs/convert'
import { fakeBlender, gltfJson, makeContext, makeGlb, seedAsset } from './helpers'

const ASSET = '11111111-1111-4111-8111-111111111111'

describe('convert job (Blender mocked)', () => {
  it('downloads the source, runs Blender on it, uploads the GLB and records before/after stats', async () => {
    const converted = makeGlb(gltfJson(120, 2), 1900)
    const blender = fakeBlender({ writeOutput: (_input, output) => writeFile(output, converted) })
    const { ctx, db, storage, leftovers } = await makeContext({ blender })
    seedAsset(db, storage, { id: ASSET, kind: 'character', filename: 'Hero.FBX', body: Buffer.alloc(5000, 1) })

    const result = await handleConvert({ assetId: ASSET, role: 'source' }, ctx)

    // Blender was handed the downloaded source under its real extension, and asked for a .glb.
    expect(blender.convertCalls).toHaveLength(1)
    expect(blender.convertCalls[0]!.input).toMatch(/input\.fbx$/)
    expect(blender.convertCalls[0]!.output).toMatch(/model\.glb$/)

    const stored = storage.objects.get(`converted/${ASSET}/model.glb`)!
    expect(stored.contentType).toBe('model/gltf-binary')
    expect(stored.body.equals(converted)).toBe(true)
    expect(inspectGlb(stored.body).dracoPrimitives).toBe(1)

    expect(db.getFile(ASSET, 'converted')).toMatchObject({ key: `converted/${ASSET}/model.glb`, bytes: 1900, filename: 'model.glb' })
    expect(db.getAsset(ASSET)).toMatchObject({
      bytesBefore: 5000,
      bytesAfter: 1900,
      trianglesBefore: 120,
      trianglesAfter: 120,
      texturesBefore: 2,
      texturesAfter: 2,
    })
    expect(result).toMatchObject({ resizedTextures: 1, dracoPrimitives: 1, keptOriginal: false })
    expect(await leftovers()).toEqual([]) // the scratch directory is gone
  })

  it('keeps the original when converting a GLB would make it larger', async () => {
    const original = makeGlb(gltfJson(10, 0), 400)
    const blender = fakeBlender({
      writeOutput: (_input, output) => writeFile(output, makeGlb(gltfJson(10, 0), 900)),
      report: { bytes_before: 400 },
    })
    const { ctx, db, storage } = await makeContext({ blender })
    seedAsset(db, storage, { id: ASSET, kind: 'character', filename: 'tiny.glb', body: original })

    const result = await handleConvert({ assetId: ASSET, role: 'source' }, ctx)

    expect(result.keptOriginal).toBe(true)
    expect(storage.objects.get(`converted/${ASSET}/model.glb`)!.body.equals(original)).toBe(true)
    expect(db.getAsset(ASSET)).toMatchObject({ bytesBefore: 400, bytesAfter: 400 })
  })

  it('fails without retrying when the asset was deleted while the job was queued', async () => {
    const { ctx } = await makeContext()
    await expect(handleConvert({ assetId: ASSET, role: 'source' }, ctx)).rejects.toBeInstanceOf(UnrecoverableError)
  })

  it('propagates a Blender failure, uploads nothing, and still cleans up', async () => {
    const blender = fakeBlender({})
    blender.convert = async () => {
      throw new BlenderError('ValueError: the file imported without errors but contains no objects', 1, true, '')
    }
    const { ctx, db, storage, leftovers } = await makeContext({ blender })
    seedAsset(db, storage, { id: ASSET, kind: 'character', filename: 'empty.glb', body: Buffer.from('x') })

    await expect(handleConvert({ assetId: ASSET, role: 'source' }, ctx)).rejects.toThrow(/contains no objects/)
    expect(storage.objects.has(`converted/${ASSET}/model.glb`)).toBe(false)
    expect(db.getFile(ASSET, 'converted')).toBeNull()
    expect(db.getAsset(ASSET)!.bytesAfter).toBeNull()
    expect(await leftovers()).toEqual([])
  })
})
