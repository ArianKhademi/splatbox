import { FlowProducer, Queue, type JobsOptions } from 'bullmq'
import { Redis } from 'ioredis'
import { randomUUID } from 'node:crypto'

export const QUEUE_NAME = 'assets'
export const MAX_RETRIES = 3

/** A job is tried once and then retried up to MAX_RETRIES times, waiting 2 s, 4 s, 8 s between attempts. */
export const JOB_OPTIONS: JobsOptions = {
  attempts: MAX_RETRIES + 1,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
}

export interface ConvertJobData {
  assetId: string
  /** Which uploaded file to convert: `source` for characters and clips, `motion` for pairs. */
  role: 'source' | 'motion'
}

export interface TurntableJobData {
  assetId: string
}

/** BullMQ's blocking commands need `maxRetriesPerRequest: null`. */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null })
}

export interface FailedJob {
  id: string
  name: string
  data: unknown
  failedReason: string
  attemptsMade: number
  finishedOn: number | null
}

/** The producer side of the `assets` queue, used by the api. */
export class AssetQueue {
  readonly name: string
  private readonly queue: Queue
  private readonly flows: FlowProducer

  constructor(connection: Redis, name = QUEUE_NAME) {
    this.name = name
    this.queue = new Queue(name, { connection })
    this.flows = new FlowProducer({ connection })
  }

  /**
   * Enqueues both jobs as a BullMQ flow with `turntable` as the parent: BullMQ keeps a parent in
   * `waiting-children` until its children complete, so the turntable never renders before the
   * converted GLB exists. If convert exhausts its retries the turntable job is failed with it.
   */
  async enqueueConvertAndTurntable(
    assetId: string,
    role: ConvertJobData['role'],
    ids = { convert: randomUUID(), turntable: randomUUID() },
  ): Promise<{ convert: string; turntable: string }> {
    const convert: ConvertJobData = { assetId, role }
    const turntable: TurntableJobData = { assetId }
    await this.flows.add({
      name: 'turntable',
      queueName: this.name,
      data: turntable,
      opts: { ...JOB_OPTIONS, jobId: ids.turntable },
      children: [
        {
          name: 'convert',
          queueName: this.name,
          data: convert,
          opts: { ...JOB_OPTIONS, jobId: ids.convert, failParentOnFailure: true },
        },
      ],
    })
    return ids
  }

  /** Splat scenes are not converted, so their turntable job stands alone. */
  async enqueueTurntable(assetId: string, id = randomUUID()): Promise<string> {
    const data: TurntableJobData = { assetId }
    await this.queue.add('turntable', data, { ...JOB_OPTIONS, jobId: id })
    return id
  }

  async failedJobs(limit = 50): Promise<FailedJob[]> {
    const jobs = await this.queue.getJobs(['failed'], 0, limit - 1)
    return jobs.map((j) => ({
      id: j.id!,
      name: j.name,
      data: j.data,
      failedReason: j.failedReason,
      attemptsMade: j.attemptsMade,
      finishedOn: j.finishedOn ?? null,
    }))
  }

  async counts(): Promise<Record<string, number>> {
    return this.queue.getJobCounts('waiting', 'waiting-children', 'active', 'delayed', 'completed', 'failed')
  }

  /** Best-effort removal of an asset's jobs (used when the asset is deleted). Active jobs cannot be removed. */
  async removeJobs(jobIds: string[]): Promise<void> {
    for (const id of jobIds) {
      const job = await this.queue.getJob(id)
      await job?.remove({ removeChildren: true }).catch(() => undefined)
    }
  }

  async close(): Promise<void> {
    await this.queue.close()
    await this.flows.close()
  }
}
