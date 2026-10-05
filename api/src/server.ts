import { AssetQueue, createRedis, Db, loadConfig, Storage } from '@splatbox/shared'
import { setTimeout as sleep } from 'node:timers/promises'
import { buildApp } from './app'

const config = loadConfig()
const db = new Db(config.DATABASE_PATH)
const storage = new Storage({
  bucket: config.S3_BUCKET,
  region: config.S3_REGION,
  endpoint: config.S3_ENDPOINT,
  publicEndpoint: config.S3_PUBLIC_ENDPOINT,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
})

if (config.S3_CREATE_BUCKET) {
  // Under docker compose MinIO may still be starting; give it a few seconds.
  for (let attempt = 1; ; attempt++) {
    try {
      await storage.ensureBucket()
      break
    } catch (err) {
      if (attempt === 15) throw err
      await sleep(1000)
    }
  }
}

const redis = createRedis(config.REDIS_URL)
const queue = new AssetQueue(redis)
const app = buildApp({ db, storage, queue, apiToken: config.API_TOKEN, sessionSecret: config.SESSION_SECRET })

await app.listen({ host: '0.0.0.0', port: config.API_PORT })
console.log(`api listening on :${config.API_PORT}, bucket "${config.S3_BUCKET}", database ${config.DATABASE_PATH}`)

async function shutdown(): Promise<void> {
  await app.close()
  await queue.close()
  await redis.quit()
  db.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
