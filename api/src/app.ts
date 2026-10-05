import {
  allowedExtensions,
  ASSET_KINDS,
  extensionOf,
  keys,
  REQUIRED_ROLES,
  type Asset,
  type AssetQueue,
  type Db,
  type Storage,
} from '@splatbox/shared'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z, ZodError } from 'zod'
import { bearerToken, issueSession, readCookie, SESSION_COOKIE, SESSION_TTL_MS, tokenMatches, verifySession } from './auth'
import { toAssetDto, type AssetDto } from './dto'

export interface AppDeps {
  db: Db
  storage: Storage
  queue: AssetQueue
  apiToken: string
  sessionSecret: string
}

const createAssetBody = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(ASSET_KINDS),
  /** Splat scenes only: the scene is Y-down and should be flipped upright. */
  flipY: z.boolean().optional(),
  files: z
    .array(
      z.object({
        role: z.enum(['source', 'video', 'motion']),
        filename: z.string().min(1).max(255),
        contentType: z.string().min(1).max(100),
      }),
    )
    .min(1)
    .max(2),
})

const listQuery = z.object({
  kind: z.enum(ASSET_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  cursor: z.string().max(200).optional(),
})

const sessionBody = z.object({ token: z.string().min(1).max(500) })
const idParams = z.object({ id: z.string().uuid() })

/** An error that maps to a specific HTTP status. */
class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { db, storage, queue } = deps
  const app = Fastify({ logger: false })

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ZodError) {
      const detail = err.issues.map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ')
      return reply.code(400).send({ error: detail })
    }
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message })
    app.log.error(err)
    return reply.code(500).send({ error: 'internal error' })
  })

  async function dto(asset: Asset): Promise<AssetDto> {
    return toAssetDto(asset, db.listFiles([asset.id]), db.listJobs([asset.id]), storage)
  }

  function mustGetAsset(params: unknown): Asset {
    const { id } = idParams.parse(params)
    const asset = db.getAsset(id)
    if (!asset) throw new HttpError(404, 'asset not found')
    return asset
  }

  /** Queues the jobs an asset still needs and records them, so the grid can show them at once. */
  async function enqueueJobs(asset: Asset): Promise<void> {
    if (asset.kind === 'splat' || db.getFile(asset.id, 'converted')) {
      // Splat scenes are never converted; and on a retry the converted GLB may already exist.
      const id = randomUUID()
      db.createJob({ id, assetId: asset.id, type: 'turntable' })
      await queue.enqueueTurntable(asset.id, id)
    } else {
      const ids = { convert: randomUUID(), turntable: randomUUID() }
      // Rows first: a fast worker may pick the job up before this function returns.
      db.createJob({ id: ids.convert, assetId: asset.id, type: 'convert' })
      db.createJob({ id: ids.turntable, assetId: asset.id, type: 'turntable' })
      await queue.enqueueConvertAndTurntable(asset.id, asset.kind === 'pair' ? 'motion' : 'source', ids)
    }
    db.setAssetStatus(asset.id, 'processing')
  }

  // --- open routes

  app.get('/api/health', async () => ({ ok: true }))

  app.post('/api/session', async (req, reply) => {
    const { token } = sessionBody.parse(req.body)
    if (!tokenMatches(token, deps.apiToken)) throw new HttpError(401, 'invalid token')
    const cookie = `${SESSION_COOKIE}=${issueSession(deps.sessionSecret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`
    return reply.header('set-cookie', cookie).code(204).send()
  })

  app.delete('/api/session', async (_req, reply) => {
    return reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`).code(204).send()
  })

  // --- everything below needs the bearer token or a valid session cookie

  app.register(async (api) => {
    api.addHook('onRequest', async (req) => {
      const byToken = tokenMatches(bearerToken(req.headers.authorization), deps.apiToken)
      const byCookie = verifySession(readCookie(req.headers.cookie, SESSION_COOKIE), deps.sessionSecret)
      if (!byToken && !byCookie) throw new HttpError(401, 'authentication required')
    })

    /** Step 1 of an upload: register the asset and get one presigned PUT URL per file. */
    api.post('/api/assets', async (req, reply: FastifyReply) => {
      const body = createAssetBody.parse(req.body)
      const required = REQUIRED_ROLES[body.kind]
      const roles = body.files.map((file) => file.role)
      if (roles.length !== required.length || !required.every((role) => roles.includes(role))) {
        throw new HttpError(400, `a ${body.kind} asset needs exactly these files: ${required.join(', ')}`)
      }
      for (const file of body.files) {
        const allowed = allowedExtensions(body.kind, file.role)
        if (!allowed.includes(extensionOf(file.filename))) {
          throw new HttpError(400, `${file.filename}: the ${file.role} file of a ${body.kind} asset must be one of ${allowed.join(', ')}`)
        }
      }

      const asset = db.createAsset({ id: randomUUID(), name: body.name, kind: body.kind, meta: body.flipY ? { flipY: true } : {} })
      const uploads = await Promise.all(
        body.files.map(async (file) => {
          const key = keys.upload(asset.id, file.role, extensionOf(file.filename))
          db.putFile({ assetId: asset.id, role: file.role, key, filename: file.filename, contentType: file.contentType, bytes: null })
          return { role: file.role, url: await storage.presignPut(key, file.contentType), contentType: file.contentType }
        }),
      )
      return reply.code(201).send({ asset: await dto(asset), uploads })
    })

    /** Step 2: the browser has PUT the files; verify they arrived and queue the jobs. */
    api.post('/api/assets/:id/complete', async (req) => {
      const asset = mustGetAsset(req.params)
      if (asset.status !== 'uploading') throw new HttpError(409, `asset is already ${asset.status}`)
      for (const role of REQUIRED_ROLES[asset.kind]) {
        const file = db.getFile(asset.id, role)!
        const head = await storage.head(file.key)
        if (!head || head.bytes === 0) throw new HttpError(400, `the ${role} file has not been uploaded`)
        db.putFile({ ...file, bytes: head.bytes })
      }
      await enqueueJobs(asset)
      return { asset: await dto(db.getAsset(asset.id)!) }
    })

    api.get('/api/assets', async (req) => {
      const query = listQuery.parse(req.query)
      const page = db.listAssets(query)
      const ids = page.items.map((asset) => asset.id)
      // Two queries for the whole page instead of two per asset.
      const files = db.listFiles(ids)
      const jobs = db.listJobs(ids)
      const items = await Promise.all(
        page.items.map((asset) =>
          toAssetDto(
            asset,
            files.filter((file) => file.assetId === asset.id),
            jobs.filter((job) => job.assetId === asset.id),
            storage,
          ),
        ),
      )
      return { items, nextCursor: page.nextCursor }
    })

    api.get('/api/assets/:id', async (req) => ({ asset: await dto(mustGetAsset(req.params)) }))

    /** Re-queues the jobs of a failed asset. */
    api.post('/api/assets/:id/retry', async (req) => {
      const asset = mustGetAsset(req.params)
      if (asset.status !== 'failed') throw new HttpError(409, `only failed assets can be retried; this one is ${asset.status}`)
      await queue.removeJobs(db.listJobs([asset.id]).map((job) => job.id))
      db.deleteJobs(asset.id)
      await enqueueJobs(asset)
      return { asset: await dto(db.getAsset(asset.id)!) }
    })

    api.delete('/api/assets/:id', async (req, reply) => {
      const asset = mustGetAsset(req.params)
      await queue.removeJobs(db.listJobs([asset.id]).map((job) => job.id))
      for (const prefix of keys.prefixes(asset.id)) await storage.deletePrefix(prefix)
      db.deleteAsset(asset.id)
      return reply.code(204).send()
    })

    /** Jobs that exhausted their retries, as BullMQ holds them, with the error recorded for each. */
    api.get('/api/jobs/failed', async () => {
      const failed = await queue.failedJobs(100)
      return {
        items: failed.map((job) => ({
          id: job.id,
          type: job.name,
          assetId: (job.data as { assetId?: string }).assetId ?? null,
          attemptsMade: job.attemptsMade,
          failedReason: job.failedReason,
          finishedAt: job.finishedOn,
          error: db.getJob(job.id)?.error ?? null,
        })),
      }
    })

    api.get('/api/queue', async () => ({ name: queue.name, counts: await queue.counts() }))
  })

  return app
}
