import type { ConvertJobData, TurntableJobData } from '@splatbox/shared'
import { UnrecoverableError, type Job } from 'bullmq'
import { BlenderError } from './blender/run'
import type { JobContext } from './context'
import { handleConvert } from './jobs/convert'
import { handleTurntable } from './jobs/turntable'

function describe(err: unknown): string {
  if (err instanceof BlenderError && err.outputTail) return `${err.message}\n${err.outputTail}`
  return err instanceof Error ? err.message : String(err)
}

/**
 * Builds the function BullMQ calls for every job on the `assets` queue. It routes by job name and
 * mirrors each state change into the jobs table, which is what the api and the grid read.
 */
export function createProcessor(ctx: JobContext) {
  return async function process(job: Job): Promise<Record<string, unknown>> {
    const jobId = job.id!
    const assetId = (job.data as { assetId: string }).assetId
    // attemptsMade counts finished attempts, so the one starting now is attemptsMade + 1.
    const attempt = job.attemptsMade + 1
    ctx.db.markJobActive(jobId, attempt)
    ctx.db.refreshAssetStatus(assetId)
    try {
      let result: Record<string, unknown>
      if (job.name === 'convert') result = await handleConvert(job.data as ConvertJobData, ctx)
      else if (job.name === 'turntable') result = await handleTurntable(job.data as TurntableJobData, ctx)
      else throw new UnrecoverableError(`unknown job type "${job.name}"`)
      ctx.db.markJobCompleted(jobId, result)
      ctx.db.refreshAssetStatus(assetId)
      return result
    } catch (err) {
      // A failure the Blender script reported itself (bad file, unsupported format) is deterministic:
      // rethrow it as unrecoverable so BullMQ skips the remaining retries.
      const permanent = err instanceof UnrecoverableError || (err instanceof BlenderError && err.scriptReported)
      const final = permanent || attempt >= (job.opts.attempts ?? 1)
      ctx.db.markJobFailed(jobId, describe(err), final)
      if (final && job.name === 'convert' && job.parent?.id) {
        // BullMQ fails the waiting turntable parent too (failParentOnFailure); it never reaches this
        // processor, so record that here.
        ctx.db.markJobFailed(job.parent.id, 'not rendered: the convert job failed', true)
      }
      ctx.db.refreshAssetStatus(assetId)
      if (permanent && !(err instanceof UnrecoverableError)) throw new UnrecoverableError(describe(err))
      throw err
    }
  }
}
