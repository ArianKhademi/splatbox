import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AssetKind, AssetStatus, FileRole, JobState, JobType } from './types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  bytes_before INTEGER,
  bytes_after INTEGER,
  triangles_before INTEGER,
  triangles_after INTEGER,
  textures_before INTEGER,
  textures_after INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assets_created ON assets (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS files (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER,
  PRIMARY KEY (asset_id, role)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  result TEXT,
  queued_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_asset ON jobs (asset_id);
`

export interface Asset {
  id: string
  name: string
  kind: AssetKind
  status: AssetStatus
  meta: Record<string, unknown>
  bytesBefore: number | null
  bytesAfter: number | null
  trianglesBefore: number | null
  trianglesAfter: number | null
  texturesBefore: number | null
  texturesAfter: number | null
  createdAt: number
  updatedAt: number
}

export interface AssetFile {
  assetId: string
  role: FileRole
  key: string
  filename: string
  contentType: string
  bytes: number | null
}

export interface JobRecord {
  id: string
  assetId: string
  type: JobType
  state: JobState
  attempts: number
  error: string | null
  result: Record<string, unknown> | null
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
}

export interface ConversionStats {
  bytesBefore: number
  bytesAfter: number
  trianglesBefore: number
  trianglesAfter: number
  texturesBefore: number
  texturesAfter: number
}

export interface ListAssetsOptions {
  kind?: AssetKind
  limit: number
  cursor?: string
}

/* eslint-disable @typescript-eslint/no-explicit-any -- rows come back from SQLite untyped and are mapped right here */
function toAsset(r: any): Asset {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    status: r.status,
    meta: JSON.parse(r.meta),
    bytesBefore: r.bytes_before,
    bytesAfter: r.bytes_after,
    trianglesBefore: r.triangles_before,
    trianglesAfter: r.triangles_after,
    texturesBefore: r.textures_before,
    texturesAfter: r.textures_after,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function toFile(r: any): AssetFile {
  return { assetId: r.asset_id, role: r.role, key: r.key, filename: r.filename, contentType: r.content_type, bytes: r.bytes }
}

function toJob(r: any): JobRecord {
  return {
    id: r.id,
    assetId: r.asset_id,
    type: r.type,
    state: r.state,
    attempts: r.attempts,
    error: r.error,
    result: r.result ? JSON.parse(r.result) : null,
    queuedAt: r.queued_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Keyset cursor over (created_at DESC, id DESC): stable under concurrent inserts, unlike OFFSET. */
export function encodeCursor(asset: Pick<Asset, 'createdAt' | 'id'>): string {
  return Buffer.from(`${asset.createdAt}:${asset.id}`).toString('base64url')
}

export function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  const text = Buffer.from(cursor, 'base64url').toString('utf8')
  const sep = text.indexOf(':')
  const createdAt = Number(text.slice(0, sep))
  if (sep < 1 || !Number.isFinite(createdAt)) return null
  return { createdAt, id: text.slice(sep + 1) }
}

/**
 * The asset store. One SQLite file in WAL mode, opened by both the api and the worker process;
 * every method is a single synchronous statement or transaction, so there is no pool to manage.
 */
export class Db {
  private readonly sql: Database.Database

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.sql = new Database(path)
    this.sql.pragma('journal_mode = WAL')
    this.sql.pragma('foreign_keys = ON')
    // The api and the worker write to the same file; wait for the other writer instead of failing.
    this.sql.pragma('busy_timeout = 5000')
    this.sql.exec(SCHEMA)
  }

  close(): void {
    this.sql.close()
  }

  // --- assets

  createAsset(input: { id: string; name: string; kind: AssetKind; meta?: Record<string, unknown> }): Asset {
    const now = Date.now()
    this.sql
      .prepare(`INSERT INTO assets (id, name, kind, status, meta, created_at, updated_at) VALUES (?, ?, ?, 'uploading', ?, ?, ?)`)
      .run(input.id, input.name, input.kind, JSON.stringify(input.meta ?? {}), now, now)
    return this.getAsset(input.id)!
  }

  getAsset(id: string): Asset | null {
    const row = this.sql.prepare(`SELECT * FROM assets WHERE id = ?`).get(id)
    return row ? toAsset(row) : null
  }

  listAssets(opts: ListAssetsOptions): { items: Asset[]; nextCursor: string | null } {
    const where: string[] = []
    const params: unknown[] = []
    if (opts.kind) {
      where.push(`kind = ?`)
      params.push(opts.kind)
    }
    const after = opts.cursor ? decodeCursor(opts.cursor) : null
    if (after) {
      where.push(`(created_at < ? OR (created_at = ? AND id < ?))`)
      params.push(after.createdAt, after.createdAt, after.id)
    }
    // Fetch one extra row to learn whether another page exists.
    const rows = this.sql
      .prepare(`SELECT * FROM assets ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params, opts.limit + 1)
    const items = rows.slice(0, opts.limit).map(toAsset)
    const last = items[items.length - 1]
    return { items, nextCursor: rows.length > opts.limit && last ? encodeCursor(last) : null }
  }

  setAssetStatus(id: string, status: AssetStatus): void {
    this.sql.prepare(`UPDATE assets SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), id)
  }

  recordConversion(id: string, s: ConversionStats): void {
    this.sql
      .prepare(
        `UPDATE assets SET bytes_before = ?, bytes_after = ?, triangles_before = ?, triangles_after = ?,
           textures_before = ?, textures_after = ?, updated_at = ? WHERE id = ?`,
      )
      .run(s.bytesBefore, s.bytesAfter, s.trianglesBefore, s.trianglesAfter, s.texturesBefore, s.texturesAfter, Date.now(), id)
  }

  /** Removes the asset row; files and jobs go with it through ON DELETE CASCADE. */
  deleteAsset(id: string): boolean {
    return this.sql.prepare(`DELETE FROM assets WHERE id = ?`).run(id).changes > 0
  }

  // --- files

  putFile(file: AssetFile): void {
    this.sql
      .prepare(
        `INSERT INTO files (asset_id, role, key, filename, content_type, bytes) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (asset_id, role) DO UPDATE SET key = excluded.key, filename = excluded.filename,
           content_type = excluded.content_type, bytes = excluded.bytes`,
      )
      .run(file.assetId, file.role, file.key, file.filename, file.contentType, file.bytes)
  }

  getFile(assetId: string, role: FileRole): AssetFile | null {
    const row = this.sql.prepare(`SELECT * FROM files WHERE asset_id = ? AND role = ?`).get(assetId, role)
    return row ? toFile(row) : null
  }

  listFiles(assetIds: string[]): AssetFile[] {
    if (assetIds.length === 0) return []
    const marks = assetIds.map(() => '?').join(', ')
    return this.sql.prepare(`SELECT * FROM files WHERE asset_id IN (${marks})`).all(...assetIds).map(toFile)
  }

  // --- jobs

  createJob(input: { id: string; assetId: string; type: JobType }): void {
    this.sql
      .prepare(`INSERT INTO jobs (id, asset_id, type, state, queued_at) VALUES (?, ?, ?, 'queued', ?)`)
      .run(input.id, input.assetId, input.type, Date.now())
  }

  getJob(id: string): JobRecord | null {
    const row = this.sql.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id)
    return row ? toJob(row) : null
  }

  listJobs(assetIds: string[]): JobRecord[] {
    if (assetIds.length === 0) return []
    const marks = assetIds.map(() => '?').join(', ')
    return this.sql.prepare(`SELECT * FROM jobs WHERE asset_id IN (${marks}) ORDER BY queued_at, type`).all(...assetIds).map(toJob)
  }

  listFailedJobs(limit: number): JobRecord[] {
    return this.sql.prepare(`SELECT * FROM jobs WHERE state = 'failed' ORDER BY finished_at DESC LIMIT ?`).all(limit).map(toJob)
  }

  deleteJobs(assetId: string): void {
    this.sql.prepare(`DELETE FROM jobs WHERE asset_id = ?`).run(assetId)
  }

  markJobActive(id: string, attempt: number): void {
    this.sql
      .prepare(`UPDATE jobs SET state = 'active', attempts = ?, started_at = ?, finished_at = NULL WHERE id = ?`)
      .run(attempt, Date.now(), id)
  }

  markJobCompleted(id: string, result: Record<string, unknown>): void {
    this.sql
      .prepare(`UPDATE jobs SET state = 'completed', error = NULL, result = ?, finished_at = ? WHERE id = ?`)
      .run(JSON.stringify(result), Date.now(), id)
  }

  /** A failed attempt goes back to `queued` (BullMQ will retry it) unless it was the last one. */
  markJobFailed(id: string, error: string, final: boolean): void {
    this.sql
      .prepare(`UPDATE jobs SET state = ?, error = ?, finished_at = ? WHERE id = ?`)
      .run(final ? 'failed' : 'queued', error, final ? Date.now() : null, id)
  }

  /**
   * Rolls the asset status up from its jobs: any failed job fails the asset, all completed makes
   * it ready, anything else is still processing.
   */
  refreshAssetStatus(assetId: string): AssetStatus {
    const states = this.sql.prepare(`SELECT state FROM jobs WHERE asset_id = ?`).all(assetId) as { state: JobState }[]
    let status: AssetStatus = 'processing'
    if (states.some((j) => j.state === 'failed')) status = 'failed'
    else if (states.length > 0 && states.every((j) => j.state === 'completed')) status = 'ready'
    this.setAssetStatus(assetId, status)
    return status
  }
}
