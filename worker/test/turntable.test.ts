import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { handleTurntable } from '../src/jobs/turntable'
import type { SplatRenderRequest } from '../src/splat'
import { fakeBlender, gltfJson, makeContext, makeGlb, seedAsset } from './helpers'

const ASSET = '22222222-2222-4222-8222-222222222222'

/** Writes `count` small solid-colour PNGs, a different shade per frame, like a renderer would. */
async function writeFrames(outDir: string, count: number): Promise<string[]> {
  const paths: string[] = []
  for (let i = 0; i < count; i++) {
    const path = join(outDir, `frame_${String(i).padStart(4, '0')}.png`)
    await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: i * 10, g: 80, b: 200, alpha: 1 } } })
      .png()
      .toFile(path)
    paths.push(path)
  }
  return paths
}

describe('turntable job (Blender mocked)', () => {
  it('renders 24 frames from the converted GLB, uploads the WebP and poster, and updates the asset', async () => {
    const blender = fakeBlender({ writeFrames })
    const { ctx, db, storage, leftovers } = await makeContext({ blender })
    seedAsset(db, storage, { id: ASSET, kind: 'character', filename: 'hero.glb', body: Buffer.from('source') })
    storage.put(`converted/${ASSET}/model.glb`, makeGlb(gltfJson(10, 0)))
    db.putFile({ assetId: ASSET, role: 'converted', key: `converted/${ASSET}/model.glb`, filename: 'model.glb', contentType: 'model/gltf-binary', bytes: 100 })

    const result = await handleTurntable({ assetId: ASSET }, ctx)

    expect(blender.turntableCalls).toHaveLength(1)
    expect(blender.turntableCalls[0]).toMatchObject({ frames: 24, size: 512, engine: 'eevee' })
    expect(blender.turntableCalls[0]!.input).toMatch(/model\.glb$/)
    expect(result).toMatchObject({ frames: 24, renderer: 'blender BLENDER_EEVEE_NEXT' })

    // Outputs are in storage under thumbs/{assetId}/ with the right types.
    const poster = storage.objects.get(`thumbs/${ASSET}/poster.png`)!
    const turntable = storage.objects.get(`thumbs/${ASSET}/turntable.webp`)!
    expect(poster.contentType).toBe('image/png')
    expect(turntable.contentType).toBe('image/webp')

    // The poster is frame 0; the WebP is a 24-page animation that loops forever.
    const posterMeta = await sharp(poster.body).metadata()
    expect(posterMeta).toMatchObject({ format: 'png', width: 64, height: 64 })
    const animation = await sharp(turntable.body, { animated: true }).metadata()
    expect(animation).toMatchObject({ format: 'webp', pages: 24, loop: 0 })
    expect(animation.delay).toEqual(Array(24).fill(100))

    expect(db.getFile(ASSET, 'poster')).toMatchObject({ key: `thumbs/${ASSET}/poster.png`, bytes: poster.body.length })
    expect(db.getFile(ASSET, 'turntable')).toMatchObject({ key: `thumbs/${ASSET}/turntable.webp`, bytes: turntable.body.length })
    expect(await leftovers()).toEqual([])
  })

  it('renders splat scenes with the browser renderer instead of Blender', async () => {
    const blender = fakeBlender({})
    const requests: SplatRenderRequest[] = []
    const splat = {
      render: async (request: SplatRenderRequest) => {
        requests.push(request)
        return writeFrames(request.outDir, request.frames)
      },
      close: async () => undefined,
    }
    const { ctx, db, storage } = await makeContext({ blender, splat })
    seedAsset(db, storage, { id: ASSET, kind: 'splat', filename: 'Garden.PLY', body: Buffer.from('ply') })

    const result = await handleTurntable({ assetId: ASSET }, ctx)

    expect(blender.turntableCalls).toHaveLength(0)
    expect(requests[0]).toMatchObject({ format: 'ply', flipY: false, frames: 24, size: 512 })
    expect(requests[0]!.scenePath).toMatch(/scene\.ply$/)
    expect(result).toMatchObject({ frames: 24, renderer: 'chromium' })
    expect(storage.objects.has(`thumbs/${ASSET}/turntable.webp`)).toBe(true)
  })

  it('fails when the renderer returns the wrong number of frames', async () => {
    const blender = fakeBlender({ writeFrames: (outDir) => writeFrames(outDir, 23) })
    const { ctx, db, storage } = await makeContext({ blender })
    seedAsset(db, storage, { id: ASSET, kind: 'character', filename: 'hero.glb', body: Buffer.from('source') })
    storage.put(`converted/${ASSET}/model.glb`, makeGlb(gltfJson(10, 0)))
    db.putFile({ assetId: ASSET, role: 'converted', key: `converted/${ASSET}/model.glb`, filename: 'model.glb', contentType: 'model/gltf-binary', bytes: 100 })

    await expect(handleTurntable({ assetId: ASSET }, ctx)).rejects.toThrow(/expected 24 frames, the renderer produced 23/)
    expect(storage.objects.has(`thumbs/${ASSET}/poster.png`)).toBe(false)
    expect(db.getFile(ASSET, 'poster')).toBeNull()
  })

  it('refuses to render a model that has not been converted', async () => {
    const { ctx, db, storage } = await makeContext()
    seedAsset(db, storage, { id: ASSET, kind: 'character', filename: 'hero.glb', body: Buffer.from('source') })
    await expect(handleTurntable({ assetId: ASSET }, ctx)).rejects.toThrow(/no converted file/)
  })
})
