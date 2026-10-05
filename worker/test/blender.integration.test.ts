import { inspectGlb } from '@splatbox/shared'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findBlender } from '../src/blender/locate'
import { BlenderError } from '../src/blender/run'
import { createBlenderTools, type BlenderTools } from '../src/blender/scripts'

/**
 * Runs the real Blender on a small rigged sample. Without a Blender install the suite is skipped,
 * unless REQUIRE_BLENDER=1 (set in CI) turns a missing install into a failure.
 */
let blenderBin: string | null = null
try {
  blenderBin = findBlender(process.env.BLENDER_BIN || undefined)
} catch (err) {
  if (process.env.REQUIRE_BLENDER === '1') throw err
}

const FIXTURE = fileURLToPath(new URL('./fixtures/RiggedFigure.glb', import.meta.url))

describe.skipIf(!blenderBin)('headless Blender (real)', () => {
  let blender: BlenderTools
  let dir: string
  beforeAll(async () => {
    blender = createBlenderTools(blenderBin!)
    dir = await mkdtemp(join(tmpdir(), 'splatbox-blender-'))
  })
  afterAll(() => rm(dir, { recursive: true, force: true }))

  it('converts a rigged GLB to a smaller Draco GLB and keeps its skin and animation', async () => {
    const output = join(dir, 'out.glb')
    const report = await blender.convert(FIXTURE, output)
    const before = inspectGlb(await readFile(FIXTURE))
    const after = inspectGlb(await readFile(output))

    expect(report.bytes_before).toBe(before.bytes)
    expect(report.bytes_after).toBe(after.bytes)
    expect(report.before).toMatchObject({ triangles: before.triangles, armatures: 1, animations: 1 })
    expect(report.blender).toMatch(/^4\./)

    expect(after.bytes).toBeLessThan(before.bytes)
    expect(after.extensionsUsed).toContain('KHR_draco_mesh_compression')
    expect(after.dracoPrimitives).toBe(after.primitives)
    expect(after.triangles).toBe(before.triangles)
    expect(after.skins).toBe(1)
    expect(after.joints).toBe(before.joints)
    expect(after.animations).toHaveLength(1)
    expect(after.animations[0]!.duration).toBeCloseTo(before.animations[0]!.duration, 3)
    expect(after.animations[0]!.channels).toBe(before.animations[0]!.channels)
  }, 120_000)

  it('exits non-zero with a script-reported error for a file that is not a model', async () => {
    const bogus = join(dir, 'bogus.glb')
    await writeFile(bogus, 'this is not a glb')
    const run = blender.convert(bogus, join(dir, 'bogus-out.glb'))
    await expect(run).rejects.toBeInstanceOf(BlenderError)
    await expect(run).rejects.toMatchObject({ exitCode: 1, scriptReported: true })
  }, 120_000)

  it('rejects formats the converter does not support', async () => {
    const blend = join(dir, 'scene.blend')
    await writeFile(blend, 'BLENDER')
    await expect(blender.convert(blend, join(dir, 'x.glb'))).rejects.toThrow(/unsupported input format '.blend'/)
  }, 120_000)

  // Rendering needs a GPU or a software GL stack, which plain CI runners lack; opt in locally.
  it.runIf(process.env.SPLATBOX_TEST_RENDER === '1')('renders a 24-frame turntable with EEVEE', async () => {
    const model = join(dir, 'out.glb')
    const report = await blender.turntable(model, join(dir, 'frames'), { frames: 24, size: 256, engine: 'eevee' })
    expect(report.frames).toHaveLength(24)
    const first = await sharp(report.frames[0]).metadata()
    expect(first).toMatchObject({ format: 'png', width: 256, height: 256, channels: 4 })
    // The asset must be in frame: the render is not fully transparent.
    const { channels } = await sharp(report.frames[0]).stats()
    expect(channels[3]!.max).toBe(255)
  }, 300_000)
})
