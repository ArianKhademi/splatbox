import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/** The repository root (this file lives in shared/src). */
export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1')

const optionalUrl = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined))

const schema = z.object({
  API_PORT: z.coerce.number().int().default(4000),
  API_TOKEN: z.string().min(16, 'API_TOKEN must be at least 16 characters'),
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 characters'),
  DATABASE_PATH: z.string().default('./data/splatbox.sqlite'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: optionalUrl,
  S3_PUBLIC_ENDPOINT: optionalUrl,
  S3_FORCE_PATH_STYLE: bool,
  S3_CREATE_BUCKET: bool,
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(2),
  BLENDER_BIN: optionalUrl,
  TURNTABLE_ENGINE: z.enum(['eevee', 'workbench']).default('eevee'),
  /** A Blender run that takes longer than this is killed and the job attempt fails. */
  BLENDER_TIMEOUT_SECONDS: z.coerce.number().int().min(10).default(600),
  RENDER_PAGE_URL: z.string().default('http://localhost:5173/render.html'),
})

export type Config = z.infer<typeof schema>

/**
 * Reads configuration from the environment, after loading the repo-root `.env` if there is one
 * (values already present in the environment win, as with `node --env-file`).
 * AWS credentials are deliberately not parsed here: the AWS SDK reads them itself.
 */
export function loadConfig(envFile = resolve(REPO_ROOT, '.env')): Config {
  if (existsSync(envFile)) process.loadEnvFile(envFile)
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid configuration:\n${problems}`)
  }
  const config = parsed.data
  // The api and the worker start in different directories but must open the same database file.
  if (!isAbsolute(config.DATABASE_PATH)) config.DATABASE_PATH = resolve(REPO_ROOT, config.DATABASE_PATH)
  return config
}
