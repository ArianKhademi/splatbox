/**
 * Pushes the whole sample set through a running Splatbox (api + worker + storage) the way the
 * browser does: create asset, PUT the files to their presigned URLs, complete, then poll until the
 * convert and turntable jobs are done. Writes the measured job times to docs/pipeline_times.md and
 * saves a few of the produced thumbnails to docs/thumbnails/.
 *
 *   npx tsx scripts/run_pipeline.ts            (api on http://localhost:4000, token from .env)
 *   npx tsx scripts/run_pipeline.ts --reset    delete every existing asset first
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { basename, extname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'))
const API = process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`
const HEADERS = { authorization: `Bearer ${process.env.API_TOKEN}` }
const ASSETS = join(ROOT, 'samples/assets')
const DEMO = join(ROOT, 'web/public/demo')
const DOCS = join(ROOT, 'docs')

type Kind = 'character' | 'clip' | 'splat' | 'pair'
interface Upload {
  name: string
  kind: Kind
  files: { role: 'source' | 'video' | 'motion'; path: string }[]
}

interface Job {
  type: string
  state: string
  attempts: number
  error: string | null
  durationMs: number | null
  result: Record<string, unknown> | null
}
interface Asset {
  id: string
  name: string
  kind: Kind
  status: string
  stats: { bytesBefore: number; bytesAfter: number; reductionPct: number; trianglesAfter: number } | null
  thumbs: { posterUrl: string; turntableUrl: string } | null
  jobs: Job[]
}

const CONTENT_TYPES: Record<string, string> = { '.glb': 'model/gltf-binary', '.mp4': 'video/mp4' }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...HEADERS, ...(init?.body ? { 'content-type': 'application/json' } : {}) } })
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

async function upload(item: Upload): Promise<string> {
  const files = item.files.map((f) => ({
    role: f.role,
    filename: basename(f.path),
    contentType: CONTENT_TYPES[extname(f.path)] ?? 'application/octet-stream',
  }))
  const created = await call<{ asset: Asset; uploads: { role: string; url: string; contentType: string }[] }>('/api/assets', {
    method: 'POST',
    body: JSON.stringify({ name: item.name, kind: item.kind, files }),
  })
  for (const file of item.files) {
    const target = created.uploads.find((u) => u.role === file.role)!
    const put = await fetch(target.url, { method: 'PUT', body: readFileSync(file.path), headers: { 'content-type': target.contentType } })
    if (!put.ok) throw new Error(`PUT ${basename(file.path)}: ${put.status}`)
  }
  await call(`/api/assets/${created.asset.id}/complete`, { method: 'POST' })
  return created.asset.id
}

const seconds = (job: Job | undefined) => (job?.durationMs != null ? (job.durationMs / 1000).toFixed(1) : '-')

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'samples/manifest.json'), 'utf8')) as { benchmark: { file: string }[] }
  const uploads: Upload[] = [
    ...manifest.benchmark.map(({ file }) => ({
      name: basename(file, extname(file)),
      kind: 'character' as const,
      files: [{ role: 'source' as const, path: join(ASSETS, file) }],
    })),
    { name: 'Fox motion', kind: 'clip', files: [{ role: 'source', path: join(DEMO, 'fox-motion.glb') }] },
    { name: 'Avocado scene', kind: 'splat', files: [{ role: 'source', path: join(ASSETS, 'avocado_scene.ply') }] },
    {
      name: 'Walk (video + motion)',
      kind: 'pair',
      files: [
        { role: 'video', path: join(DEMO, 'pair-video.mp4') },
        { role: 'motion', path: join(ASSETS, 'CesiumMan.glb') },
      ],
    },
  ]

  if (process.argv.includes('--reset')) {
    const existing = await call<{ items: Asset[] }>('/api/assets?limit=100')
    for (const asset of existing.items) {
      const res = await fetch(`${API}/api/assets/${asset.id}`, { method: 'DELETE', headers: HEADERS })
      if (!res.ok) throw new Error(`DELETE ${asset.id}: ${res.status}`)
    }
    console.log(`deleted ${existing.items.length} existing assets`)
  }

  const started = Date.now()
  const ids: string[] = []
  for (const item of uploads) {
    ids.push(await upload(item))
    console.log(`uploaded ${item.name}`)
  }

  // Poll until every asset has settled.
  const fetchAll = () => Promise.all(ids.map((id) => call<{ asset: Asset }>(`/api/assets/${id}`).then((r) => r.asset)))
  const isPending = (a: Asset) => a.status !== 'ready' && a.status !== 'failed'
  let assets = await fetchAll()
  while (assets.some(isPending)) {
    if (Date.now() - started > 15 * 60_000) throw new Error(`timed out waiting for: ${assets.filter(isPending).map((a) => a.name).join(', ')}`)
    await sleep(1000)
    assets = await fetchAll()
  }
  const wall = (Date.now() - started) / 1000

  const failed = assets.filter((a) => a.status === 'failed')
  for (const asset of failed) console.error(`FAILED ${asset.name}: ${asset.jobs.find((j) => j.error)?.error?.split('\n')[0]}`)

  const rows = assets.map((asset) => {
    const convert = asset.jobs.find((j) => j.type === 'convert')
    const turntable = asset.jobs.find((j) => j.type === 'turntable')
    const size = asset.stats ? `${(asset.stats.bytesBefore / 1024).toFixed(0)} → ${(asset.stats.bytesAfter / 1024).toFixed(0)} KB (-${asset.stats.reductionPct.toFixed(1)}%)` : '-'
    return `| ${asset.name} | ${asset.kind} | ${asset.status} | ${seconds(convert)} | ${seconds(turntable)} | ${turntable?.result?.renderer ?? '-'} | ${size} |`
  })
  const turntableTimes = assets.map((a) => a.jobs.find((j) => j.type === 'turntable')?.durationMs).filter((ms): ms is number => ms != null)
  const convertTimes = assets.map((a) => a.jobs.find((j) => j.type === 'convert')?.durationMs).filter((ms): ms is number => ms != null)
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length / 1000

  mkdirSync(join(DOCS, 'thumbnails'), { recursive: true })
  writeFileSync(
    join(DOCS, 'pipeline_times.md'),
    [
      '# Pipeline times',
      '',
      '<!-- Generated by scripts/run_pipeline.ts. Do not edit by hand. -->',
      '',
      `${assets.length} assets uploaded through the api and processed by one worker (concurrency 2): ` +
        `${assets.length - failed.length} ready, ${failed.length} failed, ${wall.toFixed(0)} s wall-clock from first upload to last thumbnail.`,
      '',
      'Times are job durations as recorded by the worker: download from storage, the Blender (or Chromium) run, encoding, and upload.',
      '',
      '| Asset | Kind | Status | Convert (s) | Turntable (s) | Turntable renderer | Size |',
      '| --- | --- | --- | ---: | ---: | --- | --- |',
      ...rows,
      '',
      `Mean convert job ${mean(convertTimes).toFixed(1)} s; mean turntable job ${mean(turntableTimes).toFixed(1)} s (24 frames at 512×512).`,
      '',
      `Hardware: ${cpus()[0]?.model}, ${cpus().length} cores, ${process.platform} ${process.arch}. Storage: local MinIO. ` +
        'Blender renders with EEVEE on the GPU; splat scenes render in headless Chromium.',
      '',
    ].join('\n'),
  )
  console.log('wrote docs/pipeline_times.md')

  // Keep the thumbnails of a few assets as committed evidence of what the jobs produce.
  for (const name of ['Lantern', 'Fox', 'own_mannequin', 'Avocado scene', 'Fox motion']) {
    const asset = assets.find((a) => a.name === name)
    if (!asset?.thumbs) continue
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    writeFileSync(join(DOCS, 'thumbnails', `${slug}-poster.png`), Buffer.from(await (await fetch(asset.thumbs.posterUrl)).arrayBuffer()))
    writeFileSync(join(DOCS, 'thumbnails', `${slug}-turntable.webp`), Buffer.from(await (await fetch(asset.thumbs.turntableUrl)).arrayBuffer()))
  }
  console.log('saved thumbnails to docs/thumbnails/')
  if (failed.length > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
