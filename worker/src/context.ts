import type { Db, Storage } from '@splatbox/shared'
import type { BlenderTools, TurntableEngine } from './blender/scripts'
import type { SplatRenderer } from './splat'

/** Everything a job handler touches. Tests build one with an in-memory database and fakes. */
export interface JobContext {
  db: Db
  storage: Pick<Storage, 'downloadToFile' | 'uploadFile'>
  blender: BlenderTools
  splat: SplatRenderer
  /** Directory under which each job creates (and removes) its own scratch folder. */
  workRoot: string
  turntableEngine: TurntableEngine
}
