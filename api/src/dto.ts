import type { Asset, AssetFile, JobRecord, Storage } from '@splatbox/shared'

/** The asset as the api returns it: the row, its stats, and presigned URLs for everything it has in storage. */
export interface AssetDto {
  id: string
  name: string
  kind: Asset['kind']
  status: Asset['status']
  createdAt: number
  meta: Record<string, unknown>
  stats: {
    bytesBefore: number
    bytesAfter: number
    reductionPct: number
    trianglesBefore: number
    trianglesAfter: number
    texturesBefore: number
    texturesAfter: number
  } | null
  thumbs: { posterUrl: string; turntableUrl: string } | null
  jobs: {
    id: string
    type: JobRecord['type']
    state: JobRecord['state']
    attempts: number
    error: string | null
    durationMs: number | null
    result: Record<string, unknown> | null
  }[]
  files: { role: AssetFile['role']; filename: string; bytes: number | null; url: string }[]
}

export async function toAssetDto(asset: Asset, files: AssetFile[], jobs: JobRecord[], storage: Storage): Promise<AssetDto> {
  // A file row exists from the moment an upload URL is issued; it has bytes once the object is there.
  const stored = files.filter((file) => file.bytes !== null)
  const withUrls = await Promise.all(
    stored.map(async (file) => ({ role: file.role, filename: file.filename, bytes: file.bytes, url: await storage.presignGet(file.key) })),
  )
  const poster = withUrls.find((file) => file.role === 'poster')
  const turntable = withUrls.find((file) => file.role === 'turntable')
  const converted = asset.bytesBefore !== null && asset.bytesAfter !== null

  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    status: asset.status,
    createdAt: asset.createdAt,
    meta: asset.meta,
    stats: converted
      ? {
          bytesBefore: asset.bytesBefore!,
          bytesAfter: asset.bytesAfter!,
          reductionPct: asset.bytesBefore! > 0 ? (1 - asset.bytesAfter! / asset.bytesBefore!) * 100 : 0,
          trianglesBefore: asset.trianglesBefore ?? 0,
          trianglesAfter: asset.trianglesAfter ?? 0,
          texturesBefore: asset.texturesBefore ?? 0,
          texturesAfter: asset.texturesAfter ?? 0,
        }
      : null,
    thumbs: poster && turntable ? { posterUrl: poster.url, turntableUrl: turntable.url } : null,
    jobs: jobs.map((job) => ({
      id: job.id,
      type: job.type,
      state: job.state,
      attempts: job.attempts,
      error: job.error,
      durationMs: job.startedAt !== null && job.finishedAt !== null ? job.finishedAt - job.startedAt : null,
      result: job.result,
    })),
    files: withUrls,
  }
}
