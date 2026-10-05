import { JOB_OPTIONS, keys } from '@splatbox/shared'
import { UnrecoverableError, Worker } from 'bullmq'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, TEST_ENV, type TestApp } from './helpers'

const GLB_BYTES = Buffer.from('not a real model, only bytes to store')

let t: TestApp
beforeAll(async () => {
  t = await createTestApp()
})
afterAll(async () => {
  for (const asset of t.db.listAssets({ limit: 100 }).items) {
    for (const prefix of keys.prefixes(asset.id)) await t.storage.deletePrefix(prefix)
  }
  await t.close()
})

describe('POST /api/assets', () => {
  it('registers the asset and returns a presigned PUT for its file', async () => {
    const res = await t.request
      .post('/api/assets')
      .set(t.auth)
      .send({ name: 'Fox', kind: 'character', files: [{ role: 'source', filename: 'Fox.GLB', contentType: 'model/gltf-binary' }] })
      .expect(201)
    expect(res.body.asset).toMatchObject({ name: 'Fox', kind: 'character', status: 'uploading', stats: null, thumbs: null, jobs: [], files: [] })
    expect(res.body.uploads).toHaveLength(1)
    expect(res.body.uploads[0]).toMatchObject({ role: 'source', contentType: 'model/gltf-binary' })
    const url = new URL(res.body.uploads[0].url)
    expect(url.pathname).toBe(`/${TEST_ENV.bucket}/uploads/${res.body.asset.id}/source.glb`)
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy()
    // No checksum parameters: a browser PUT could not satisfy them.
    expect(res.body.uploads[0].url).not.toMatch(/checksum/i)
  })

  it('requires both files for a pair', async () => {
    const body = { name: 'Dance', kind: 'pair', files: [{ role: 'video', filename: 'dance.mp4', contentType: 'video/mp4' }] }
    const res = await t.request.post('/api/assets').set(t.auth).send(body).expect(400)
    expect(res.body.error).toMatch(/video, motion/)
    const ok = await t.request
      .post('/api/assets')
      .set(t.auth)
      .send({ ...body, files: [...body.files, { role: 'motion', filename: 'motion.glb', contentType: 'model/gltf-binary' }] })
      .expect(201)
    expect(ok.body.uploads.map((u: { role: string }) => u.role).sort()).toEqual(['motion', 'video'])
  })

  it('rejects unknown kinds, wrong extensions and empty names', async () => {
    const file = { role: 'source', filename: 'a.glb', contentType: 'model/gltf-binary' }
    await t.request.post('/api/assets').set(t.auth).send({ name: 'x', kind: 'texture', files: [file] }).expect(400)
    await t.request.post('/api/assets').set(t.auth).send({ name: '  ', kind: 'character', files: [file] }).expect(400)
    const res = await t.request
      .post('/api/assets')
      .set(t.auth)
      .send({ name: 'x', kind: 'splat', files: [{ ...file, filename: 'scene.glb' }] })
      .expect(400)
    expect(res.body.error).toMatch(/\.ply, \.splat, \.ksplat/)
  })
})

describe('upload completion', () => {
  it('refuses to complete before the file is in storage', async () => {
    const created = await t.request
      .post('/api/assets')
      .set(t.auth)
      .send({ name: 'Early', kind: 'character', files: [{ role: 'source', filename: 'a.glb', contentType: 'model/gltf-binary' }] })
    const res = await t.request.post(`/api/assets/${created.body.asset.id}/complete`).set(t.auth).expect(400)
    expect(res.body.error).toMatch(/source file has not been uploaded/)
  })

  it('accepts a presigned PUT, then queues convert with turntable waiting on it', async () => {
    const id = await t.uploadAsset('Robot', 'character', 'robot.glb', GLB_BYTES)
    const { body } = await t.request.get(`/api/assets/${id}`).set(t.auth).expect(200)
    expect(body.asset.status).toBe('processing')
    expect(body.asset.jobs.map((j: { type: string; state: string }) => [j.type, j.state])).toEqual([
      ['convert', 'queued'],
      ['turntable', 'queued'],
    ])
    expect(body.asset.files).toMatchObject([{ role: 'source', filename: 'robot.glb', bytes: GLB_BYTES.length }])

    // The stored object is exactly what was PUT, and the presigned GET serves it.
    const downloaded = await fetch(body.asset.files[0].url)
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(GLB_BYTES)).toBe(true)

    // In BullMQ the convert job is runnable and its turntable parent is parked until it completes.
    const counts = await t.queue.counts()
    expect(counts.waiting).toBeGreaterThanOrEqual(1)
    expect(counts['waiting-children']).toBeGreaterThanOrEqual(1)

    await t.request.post(`/api/assets/${id}/complete`).set(t.auth).expect(409)
  })

  it('queues only a turntable job for splat scenes', async () => {
    const id = await t.uploadAsset('Garden', 'splat', 'garden.ply', Buffer.from('ply'))
    const { body } = await t.request.get(`/api/assets/${id}`).set(t.auth)
    expect(body.asset.jobs.map((j: { type: string }) => j.type)).toEqual(['turntable'])
  })

  it('returns the same presigned GET URL within the hour so browsers can cache it', async () => {
    const id = await t.uploadAsset('Stable', 'character', 'stable.glb', GLB_BYTES)
    const first = await t.request.get(`/api/assets/${id}`).set(t.auth)
    const second = await t.request.get(`/api/assets/${id}`).set(t.auth)
    expect(second.body.asset.files[0].url).toBe(first.body.asset.files[0].url)
  })
})

describe('GET /api/assets', () => {
  it('pages through assets newest first without repeats, and filters by kind', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const res = await t.request.get('/api/assets').query({ limit: 2, ...(cursor ? { cursor } : {}) }).set(t.auth).expect(200)
      expect(res.body.items.length).toBeLessThanOrEqual(2)
      seen.push(...res.body.items.map((a: { id: string }) => a.id))
      cursor = res.body.nextCursor
      pages++
    } while (cursor)
    const total = t.db.listAssets({ limit: 100 }).items.length
    expect(total).toBeGreaterThanOrEqual(5)
    expect(seen).toHaveLength(total)
    expect(new Set(seen).size).toBe(total)
    expect(pages).toBe(Math.ceil(total / 2))

    const splats = await t.request.get('/api/assets').query({ kind: 'splat' }).set(t.auth).expect(200)
    expect(splats.body.items.length).toBeGreaterThanOrEqual(1)
    expect(splats.body.items.every((a: { kind: string }) => a.kind === 'splat')).toBe(true)
  })

  it('validates the query', async () => {
    await t.request.get('/api/assets').query({ limit: 1000 }).set(t.auth).expect(400)
    await t.request.get('/api/assets').query({ kind: 'nope' }).set(t.auth).expect(400)
  })
})

describe('job results and failures', () => {
  it('reports conversion stats and thumbnail URLs once the worker has recorded them', async () => {
    const id = await t.uploadAsset('Converted', 'character', 'c.glb', GLB_BYTES)
    // Stand in for the worker: store outputs and write the same rows it would.
    await t.storage.uploadBuffer(keys.poster(id), Buffer.from('png'), 'image/png')
    await t.storage.uploadBuffer(keys.turntable(id), Buffer.from('webp'), 'image/webp')
    t.db.putFile({ assetId: id, role: 'poster', key: keys.poster(id), filename: 'poster.png', contentType: 'image/png', bytes: 3 })
    t.db.putFile({ assetId: id, role: 'turntable', key: keys.turntable(id), filename: 'turntable.webp', contentType: 'image/webp', bytes: 4 })
    t.db.recordConversion(id, { bytesBefore: 1000, bytesAfter: 380, trianglesBefore: 1200, trianglesAfter: 1200, texturesBefore: 2, texturesAfter: 2 })
    for (const job of t.db.listJobs([id])) {
      t.db.markJobActive(job.id, 1)
      t.db.markJobCompleted(job.id, {})
    }
    t.db.refreshAssetStatus(id)

    const { body } = await t.request.get(`/api/assets/${id}`).set(t.auth).expect(200)
    expect(body.asset.status).toBe('ready')
    expect(body.asset.stats).toMatchObject({ bytesBefore: 1000, bytesAfter: 380, trianglesAfter: 1200, texturesAfter: 2 })
    expect(body.asset.stats.reductionPct).toBeCloseTo(62)
    expect(await (await fetch(body.asset.thumbs.posterUrl)).text()).toBe('png')
    expect(await (await fetch(body.asset.thumbs.turntableUrl)).text()).toBe('webp')
  })

  it('lists jobs that failed for good, and fails the waiting turntable with its convert', async () => {
    const id = await t.uploadAsset('Broken', 'character', 'broken.glb', GLB_BYTES)
    // A worker whose convert always fails permanently, the way the real one does for a corrupt file.
    const worker = new Worker(
      t.queue.name,
      async (job) => {
        if (job.data.assetId === id) throw new UnrecoverableError('SPLATBOX_ERROR ValueError: not a GLB')
        return {}
      },
      { connection: t.redis.duplicate() },
    )
    try {
      await expect
        .poll(async () => (await t.request.get('/api/jobs/failed').set(t.auth)).body.items.filter((j: { assetId: string }) => j.assetId === id).length, {
          timeout: 15_000,
        })
        .toBe(2)
    } finally {
      await worker.close()
    }
    const failed = (await t.request.get('/api/jobs/failed').set(t.auth)).body.items.filter((j: { assetId: string }) => j.assetId === id)
    const convert = failed.find((j: { type: string }) => j.type === 'convert')
    expect(convert.failedReason).toMatch(/not a GLB/)
    expect(failed.some((j: { type: string }) => j.type === 'turntable')).toBe(true)
  })

  it('configures three retries with exponential backoff', () => {
    expect(JOB_OPTIONS.attempts).toBe(4)
    expect(JOB_OPTIONS.backoff).toEqual({ type: 'exponential', delay: 2000 })
  })

  it('retries a failed asset by queueing fresh jobs', async () => {
    const id = await t.uploadAsset('Retry me', 'character', 'r.glb', GLB_BYTES)
    await t.request.post(`/api/assets/${id}/retry`).set(t.auth).expect(409)
    const [convert] = t.db.listJobs([id])
    t.db.markJobFailed(convert!.id, 'boom', true)
    t.db.refreshAssetStatus(id)
    const { body } = await t.request.post(`/api/assets/${id}/retry`).set(t.auth).expect(200)
    expect(body.asset.status).toBe('processing')
    expect(body.asset.jobs).toHaveLength(2)
    expect(body.asset.jobs.every((j: { state: string; id: string }) => j.state === 'queued' && j.id !== convert!.id)).toBe(true)
  })
})

describe('DELETE /api/assets/:id', () => {
  it('removes the row, its jobs and every stored object', async () => {
    const id = await t.uploadAsset('Doomed', 'character', 'doomed.glb', GLB_BYTES)
    await t.storage.uploadBuffer(keys.converted(id), Buffer.from('glb'), 'model/gltf-binary')
    await t.storage.uploadBuffer(keys.poster(id), Buffer.from('png'), 'image/png')

    await t.request.delete(`/api/assets/${id}`).set(t.auth).expect(204)

    await t.request.get(`/api/assets/${id}`).set(t.auth).expect(404)
    expect(await t.storage.head(keys.upload(id, 'source', '.glb'))).toBeNull()
    expect(await t.storage.head(keys.converted(id))).toBeNull()
    expect(await t.storage.head(keys.poster(id))).toBeNull()
    expect(t.db.listJobs([id])).toEqual([])
    await t.request.delete(`/api/assets/${id}`).set(t.auth).expect(404)
  })

  it('rejects ids that are not UUIDs', async () => {
    await t.request.get('/api/assets/not-a-uuid').set(t.auth).expect(400)
  })
})
