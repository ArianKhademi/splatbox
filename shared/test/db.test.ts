import { beforeEach, describe, expect, it } from 'vitest'
import { Db, decodeCursor, encodeCursor } from '../src/db'

let db: Db
beforeEach(() => {
  db = new Db(':memory:')
})

function seed(count: number, kind: 'character' | 'splat' = 'character'): string[] {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = `${kind}-${String(i).padStart(2, '0')}`
    db.createAsset({ id, name: id, kind })
    ids.push(id)
  }
  return ids
}

describe('assets', () => {
  it('creates an asset in the uploading state with its metadata', () => {
    const asset = db.createAsset({ id: 'a1', name: 'Garden', kind: 'splat', meta: { flipY: true } })
    expect(asset).toMatchObject({ id: 'a1', name: 'Garden', kind: 'splat', status: 'uploading', meta: { flipY: true }, bytesBefore: null })
    expect(db.getAsset('missing')).toBeNull()
  })

  it('pages newest first with a keyset cursor, even when rows share a timestamp', () => {
    // All eleven rows are created within the same millisecond or two, so ties on created_at are the norm here.
    const ids = seed(11)
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = db.listAssets({ limit: 4, cursor })
      seen.push(...page.items.map((a) => a.id))
      cursor = page.nextCursor ?? undefined
      pages++
    } while (cursor)
    expect(pages).toBe(3)
    expect([...seen].sort()).toEqual([...ids].sort())
    expect(new Set(seen).size).toBe(11)
    // Newest first: within one timestamp the larger id comes first.
    const order = db.listAssets({ limit: 100 }).items
    for (let i = 1; i < order.length; i++) {
      const [prev, next] = [order[i - 1]!, order[i]!]
      expect(prev.createdAt > next.createdAt || (prev.createdAt === next.createdAt && prev.id > next.id)).toBe(true)
    }
  })

  it('does not report a next page when the last page is exactly full', () => {
    seed(4)
    expect(db.listAssets({ limit: 4 }).nextCursor).toBeNull()
    expect(db.listAssets({ limit: 3 }).nextCursor).not.toBeNull()
  })

  it('filters by kind', () => {
    seed(3, 'character')
    seed(2, 'splat')
    const splats = db.listAssets({ kind: 'splat', limit: 10 }).items
    expect(splats.map((a) => a.kind)).toEqual(['splat', 'splat'])
  })

  it('round-trips cursors and rejects malformed ones', () => {
    expect(decodeCursor(encodeCursor({ createdAt: 1700000000000, id: 'abc:def' }))).toEqual({ createdAt: 1700000000000, id: 'abc:def' })
    expect(decodeCursor('not-a-cursor')).toBeNull()
  })

  it('deletes an asset together with its files and jobs', () => {
    seed(1)
    db.putFile({ assetId: 'character-00', role: 'source', key: 'k', filename: 'a.glb', contentType: 'model/gltf-binary', bytes: 10 })
    db.createJob({ id: 'j1', assetId: 'character-00', type: 'convert' })
    expect(db.deleteAsset('character-00')).toBe(true)
    expect(db.listFiles(['character-00'])).toEqual([])
    expect(db.getJob('j1')).toBeNull()
    expect(db.deleteAsset('character-00')).toBe(false)
  })
})

describe('files', () => {
  it('upserts by asset and role', () => {
    seed(1)
    const file = { assetId: 'character-00', role: 'source' as const, key: 'uploads/x/source.glb', filename: 'a.glb', contentType: 'model/gltf-binary' }
    db.putFile({ ...file, bytes: null })
    db.putFile({ ...file, bytes: 1234 })
    expect(db.listFiles(['character-00'])).toHaveLength(1)
    expect(db.getFile('character-00', 'source')!.bytes).toBe(1234)
  })
})

describe('jobs and the asset status they roll up to', () => {
  beforeEach(() => {
    seed(1)
    db.createJob({ id: 'c', assetId: 'character-00', type: 'convert' })
    db.createJob({ id: 't', assetId: 'character-00', type: 'turntable' })
  })

  it('is processing until every job has completed, then ready', () => {
    expect(db.refreshAssetStatus('character-00')).toBe('processing')
    db.markJobActive('c', 1)
    expect(db.getJob('c')).toMatchObject({ state: 'active', attempts: 1 })
    db.markJobCompleted('c', { blenderSeconds: 1.2 })
    expect(db.getJob('c')).toMatchObject({ state: 'completed', result: { blenderSeconds: 1.2 } })
    expect(db.refreshAssetStatus('character-00')).toBe('processing')
    db.markJobActive('t', 1)
    db.markJobCompleted('t', {})
    expect(db.refreshAssetStatus('character-00')).toBe('ready')
    expect(db.getAsset('character-00')!.status).toBe('ready')
  })

  it('keeps a retryable failure queued and only fails the asset on the final one', () => {
    db.markJobActive('c', 1)
    db.markJobFailed('c', 'timeout', false)
    expect(db.getJob('c')).toMatchObject({ state: 'queued', error: 'timeout', finishedAt: null })
    expect(db.refreshAssetStatus('character-00')).toBe('processing')

    db.markJobActive('c', 2)
    db.markJobFailed('c', 'timeout again', true)
    expect(db.getJob('c')!.state).toBe('failed')
    expect(db.refreshAssetStatus('character-00')).toBe('failed')
    expect(db.listFailedJobs(10).map((j) => j.id)).toEqual(['c'])
  })

  it('records conversion stats on the asset', () => {
    db.recordConversion('character-00', { bytesBefore: 1000, bytesAfter: 380, trianglesBefore: 12, trianglesAfter: 12, texturesBefore: 2, texturesAfter: 2 })
    expect(db.getAsset('character-00')).toMatchObject({ bytesBefore: 1000, bytesAfter: 380, trianglesAfter: 12, texturesAfter: 2 })
  })
})
