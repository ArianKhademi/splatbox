import { createRedis, Db, loadConfig, QUEUE_NAME, Storage } from '@splatbox/shared'
import { Worker } from 'bullmq'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blenderVersion, findBlender } from './blender/locate'
import { createBlenderTools } from './blender/scripts'
import { createProcessor } from './processor'
import { createSplatRenderer } from './splat'

const config = loadConfig()
const blenderBin = findBlender(config.BLENDER_BIN)
const workRoot = join(tmpdir(), 'splatbox-worker')
mkdirSync(workRoot, { recursive: true })

const db = new Db(config.DATABASE_PATH)
const storage = new Storage({
  bucket: config.S3_BUCKET,
  region: config.S3_REGION,
  endpoint: config.S3_ENDPOINT,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
})
const splat = createSplatRenderer(config.RENDER_PAGE_URL)
const connection = createRedis(config.REDIS_URL)

const worker = new Worker(
  QUEUE_NAME,
  createProcessor({ db, storage, blender: createBlenderTools(blenderBin), splat, workRoot, turntableEngine: config.TURNTABLE_ENGINE }),
  // Each job is one Blender (or Chromium) process, so concurrency is how many run side by side.
  { connection, concurrency: config.WORKER_CONCURRENCY },
)

worker.on('completed', (job) => console.log(`[${job.name}] ${job.id} completed for asset ${job.data.assetId}`))
worker.on('failed', (job, err) => console.error(`[${job?.name}] ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message.split('\n')[0]}`))
worker.on('error', (err) => console.error('worker error:', err.message))

console.log(`worker ready: queue "${QUEUE_NAME}", concurrency ${config.WORKER_CONCURRENCY}, Blender ${blenderVersion(blenderBin)} at ${blenderBin}`)

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, finishing active jobs…`)
  await worker.close() // waits for running jobs; unfinished ones stay in Redis for the next worker
  await splat.close()
  await connection.quit()
  db.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
