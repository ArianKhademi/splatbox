import { splatFormatOf, type AssetKind, type ClipSource, type ViewerAsset } from '../viewer/types'

export type FileRole = 'source' | 'video' | 'motion' | 'converted' | 'poster' | 'turntable'

export interface JobDto {
  id: string
  type: 'convert' | 'turntable'
  state: 'queued' | 'active' | 'completed' | 'failed'
  attempts: number
  error: string | null
  durationMs: number | null
}

export interface FileDto {
  role: FileRole
  filename: string
  bytes: number | null
  /** Presigned GET URL, valid for an hour. */
  url: string
}

export interface AssetDto {
  id: string
  name: string
  kind: AssetKind
  status: 'uploading' | 'processing' | 'ready' | 'failed'
  createdAt: number
  meta: { flipY?: boolean }
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
  jobs: JobDto[]
  files: FileDto[]
}

export interface UploadTarget {
  role: FileRole
  url: string
  contentType: string
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(res.status, body?.error ?? res.statusText)
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

export const api = {
  login: (token: string) => request<void>('/session', { method: 'POST', body: JSON.stringify({ token }) }),
  listAssets: (opts: { kind?: AssetKind; cursor?: string; limit?: number } = {}) => {
    const query = new URLSearchParams()
    if (opts.kind) query.set('kind', opts.kind)
    if (opts.cursor) query.set('cursor', opts.cursor)
    if (opts.limit) query.set('limit', String(opts.limit))
    return request<{ items: AssetDto[]; nextCursor: string | null }>(`/assets?${query}`)
  },
  getAsset: (id: string) => request<{ asset: AssetDto }>(`/assets/${id}`).then((r) => r.asset),
  createAsset: (body: { name: string; kind: AssetKind; flipY?: boolean; files: { role: FileRole; filename: string; contentType: string }[] }) =>
    request<{ asset: AssetDto; uploads: UploadTarget[] }>('/assets', { method: 'POST', body: JSON.stringify(body) }),
  completeUpload: (id: string) => request<{ asset: AssetDto }>(`/assets/${id}/complete`, { method: 'POST' }).then((r) => r.asset),
  retry: (id: string) => request<{ asset: AssetDto }>(`/assets/${id}/retry`, { method: 'POST' }).then((r) => r.asset),
  deleteAsset: (id: string) => request<void>(`/assets/${id}`, { method: 'DELETE' }),
}

function fileOf(asset: AssetDto, role: FileRole): FileDto | undefined {
  return asset.files.find((f) => f.role === role)
}

/** The GLB the browser can open: the converted one when it exists, else an uploaded GLB as-is. */
function modelUrlOf(asset: AssetDto, uploadRole: FileRole): string | undefined {
  const converted = fileOf(asset, 'converted')
  if (converted) return converted.url
  const upload = fileOf(asset, uploadRole)
  return upload && /\.(glb|gltf)$/i.test(upload.filename) ? upload.url : undefined
}

export function toViewerAsset(asset: AssetDto): ViewerAsset {
  const base = { id: asset.id, name: asset.name, kind: asset.kind }
  if (asset.kind === 'splat') {
    const source = fileOf(asset, 'source')
    return { ...base, splatUrl: source?.url, splatFormat: source ? splatFormatOf(source.filename) : undefined, flipY: asset.meta.flipY }
  }
  if (asset.kind === 'pair') return { ...base, videoUrl: fileOf(asset, 'video')?.url, modelUrl: modelUrlOf(asset, 'motion') }
  return { ...base, modelUrl: modelUrlOf(asset, 'source') }
}

export function toClipSource(asset: AssetDto): ClipSource | null {
  const url = modelUrlOf(asset, 'source')
  return url ? { id: asset.id, name: asset.name, url } : null
}

/** Uploads one file straight to object storage through its presigned URL. */
export async function putFile(target: UploadTarget, file: File): Promise<void> {
  // The Content-Type is part of the signature, so it must match what the api signed.
  const res = await fetch(target.url, { method: 'PUT', body: file, headers: { 'content-type': target.contentType } })
  if (!res.ok) throw new Error(`upload of ${file.name} failed with ${res.status}`)
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}
