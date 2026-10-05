import { UnrecoverableError, type Job } from 'bullmq'
import { writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { BlenderError } from '../src/blender/run'
import { createProcessor } from '../src/processor'
import { fakeBlender, gltfJson, makeContext, makeGlb, seedAsset } from './helpers'

const ASSET = '33333333-3333-4333-8333-333333333333'

/** The parts of a BullMQ job the processor reads. */
function job(name: string, id: string, attemptsMade = 0, parentId?: string): Job {
  return { id, name, data: { assetId: ASSET, role: 'source' }, attemptsMade, opts: { attempts: 4 }, parent: parentId ? { id: parentId } : undefined } as unknown as Job
}

async function setup(blender = fakeBlender({ writeOutput: (_i, output) => writeFile(output, makeGlb(gltfJson(10, 0), 300)) })) {
  const made = await makeContext({ blender })
  seedAsset(made.db, made.storage, { id: ASSET, kind: 'character', filename: 'hero.fbx', body: Buffer.alloc(5000) })
  made.db.createJob({ id: 'c1', assetId: ASSET, type: 'convert' })
  made.db.createJob({ id: 't1', assetId: ASSET, type: 'turntable' })
  made.db.setAssetStatus(ASSET, 'processing')
  return { ...made, process: createProcessor(made.ctx) }
}

describe('job processor', () => {
  it('records a successful job and leaves the asset processing until its last job is done', async () => {
    const { db, process } = await setup()
    await process(job('convert', 'c1'))
    expect(db.getJob('c1')).toMatchObject({ state: 'completed', attempts: 1, error: null })
    expect(db.getJob('c1')!.result).toMatchObject({ keptOriginal: false })
    expect(db.getAsset(ASSET)!.status).toBe('processing')

    db.markJobActive('t1', 1)
    db.markJobCompleted('t1', {})
    expect(db.refreshAssetStatus(ASSET)).toBe('ready')
  })

  it('puts a failed attempt back to queued while retries remain', async () => {
    const blender = fakeBlender({})
    blender.convert = async () => {
      throw new Error('socket hang up')
    }
    const { db, process } = await setup(blender)

    await expect(process(job('convert', 'c1', 0, 't1'))).rejects.toThrow('socket hang up')

    expect(db.getJob('c1')).toMatchObject({ state: 'queued', attempts: 1, error: 'socket hang up' })
    expect(db.getJob('t1')!.state).toBe('queued')
    expect(db.getAsset(ASSET)!.status).toBe('processing')
  })

  it('fails the job, its waiting turntable and the asset once the last attempt fails', async () => {
    const blender = fakeBlender({})
    blender.convert = async () => {
      throw new Error('socket hang up')
    }
    const { db, process } = await setup(blender)

    // attemptsMade 3 means this is the fourth and last attempt.
    await expect(process(job('convert', 'c1', 3, 't1'))).rejects.toThrow('socket hang up')

    expect(db.getJob('c1')).toMatchObject({ state: 'failed', attempts: 4 })
    expect(db.getJob('t1')).toMatchObject({ state: 'failed', error: 'not rendered: the convert job failed' })
    expect(db.getAsset(ASSET)!.status).toBe('failed')
    expect(db.listFailedJobs(10).map((j) => j.id).sort()).toEqual(['c1', 't1'])
  })

  it('does not retry an error the Blender script reported, and keeps Blender\'s output for the record', async () => {
    const blender = fakeBlender({})
    blender.convert = async () => {
      throw new BlenderError('ValueError: unsupported input format', 1, true, 'Traceback (most recent call last):\n  ...')
    }
    const { db, process } = await setup(blender)

    await expect(process(job('convert', 'c1', 0, 't1'))).rejects.toBeInstanceOf(UnrecoverableError)

    const record = db.getJob('c1')!
    expect(record.state).toBe('failed')
    expect(record.error).toContain('ValueError: unsupported input format')
    expect(record.error).toContain('Traceback')
    expect(db.getAsset(ASSET)!.status).toBe('failed')
  })

  it('rejects job types it does not know', async () => {
    const { db, process } = await setup()
    db.createJob({ id: 'x1', assetId: ASSET, type: 'convert' })
    await expect(process(job('transcode', 'x1'))).rejects.toThrow(/unknown job type/)
  })
})
