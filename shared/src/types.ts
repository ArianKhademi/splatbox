export const ASSET_KINDS = ['character', 'clip', 'splat', 'pair'] as const
export type AssetKind = (typeof ASSET_KINDS)[number]

/** uploading: presigned PUTs issued; processing: jobs queued or running; ready / failed: terminal. */
export type AssetStatus = 'uploading' | 'processing' | 'ready' | 'failed'

/**
 * source: the uploaded model or splat scene. video + motion: the two halves of a pair.
 * converted / poster / turntable: worker outputs.
 */
export const FILE_ROLES = ['source', 'video', 'motion', 'converted', 'poster', 'turntable'] as const
export type FileRole = (typeof FILE_ROLES)[number]

export type JobType = 'convert' | 'turntable'
export type JobState = 'queued' | 'active' | 'completed' | 'failed'

/** Extensions the pipeline accepts, per upload role. */
export const MODEL_EXTENSIONS = ['.glb', '.gltf', '.fbx', '.obj'] as const
export const SPLAT_EXTENSIONS = ['.ply', '.splat', '.ksplat'] as const
export const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov'] as const

/** The roles a client uploads; the rest are produced by the worker. */
export type UploadRole = Extract<FileRole, 'source' | 'video' | 'motion'>

/** Which upload roles each asset kind needs. */
export const REQUIRED_ROLES: Record<AssetKind, UploadRole[]> = {
  character: ['source'],
  clip: ['source'],
  splat: ['source'],
  pair: ['video', 'motion'],
}

export function allowedExtensions(kind: AssetKind, role: FileRole): readonly string[] {
  if (role === 'video') return VIDEO_EXTENSIONS
  if (kind === 'splat') return SPLAT_EXTENSIONS
  return MODEL_EXTENSIONS
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot < 0 ? '' : filename.slice(dot).toLowerCase()
}
