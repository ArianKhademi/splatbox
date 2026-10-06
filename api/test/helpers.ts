import { AssetQueue, createRedis, Db, REPO_ROOT, Storage } from '@splatbox/shared'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import supertest from 'supertest'
import { buildApp } from '../src/app'

/**
 * These tests talk to a real S3 API and a real Redis: the MinIO and Redis containers from
 * docker-compose.yml (`docker compose up -d redis minio`). The ports come from the repo's .env
 * when there is one, so a machine that moved MinIO off port 9000 needs no extra setup. The
 * credentials are always the compose MinIO's: a .env that points the app at Amazon S3 must never
 * point the tests there.
 */
const envFile = join(REPO_ROOT, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

export const TEST_ENV = {
  s3Endpoint: process.env.TEST_S3_ENDPOINT ?? `http://localhost:${process.env.MINIO_PORT ?? '9000'}`,
  redisUrl: process.env.TEST_REDIS_URL ?? `redis://localhost:${process.env.REDIS_PORT ?? '6379'}`,
  bucket: 'splatbox-test',
  credentials: { accessKeyId: 'splatbox', secretAccessKey: 'splatbox-secret' },
}

export const TOKEN = 'test-token-0123456789abcdef'
export const SECRET = 'test-secret-0123456789abcdef'

export async function createTestApp() {
  const db = new Db(':memory:')
  const storage = new Storage({
    bucket: TEST_ENV.bucket,
    region: 'us-east-1',
    endpoint: TEST_ENV.s3Endpoint,
    forcePathStyle: true,
    credentials: TEST_ENV.credentials,
  })
  await storage.ensureBucket()
  const redis = createRedis(TEST_ENV.redisUrl)
  // A queue name of its own per test file, so runs never see each other's jobs.
  const queue = new AssetQueue(redis, `assets-test-${randomUUID()}`)
  const app = buildApp({ db, storage, queue, apiToken: TOKEN, sessionSecret: SECRET })
  await app.ready()

  const request = supertest(app.server)
  const auth = { Authorization: `Bearer ${TOKEN}` }

  /** Runs the whole upload flow for a one-file asset and returns its id. */
  async function uploadAsset(name: string, kind: 'character' | 'clip' | 'splat', filename: string, body: Buffer): Promise<string> {
    const created = await request
      .post('/api/assets')
      .set(auth)
      .send({ name, kind, files: [{ role: 'source', filename, contentType: 'application/octet-stream' }] })
      .expect(201)
    const put = await fetch(created.body.uploads[0].url, { method: 'PUT', body, headers: { 'content-type': 'application/octet-stream' } })
    if (!put.ok) throw new Error(`presigned PUT failed: ${put.status} ${await put.text()}`)
    await request.post(`/api/assets/${created.body.asset.id}/complete`).set(auth).expect(200)
    return created.body.asset.id as string
  }

  async function close() {
    await app.close()
    await queue.close()
    await redis.quit()
    storage.destroy()
    db.close()
  }

  return { app, db, storage, queue, redis, request, auth, uploadAsset, close }
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>
