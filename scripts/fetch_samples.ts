/**
 * Downloads the third-party sample models listed in samples/manifest.json into samples/assets/
 * and verifies each against its pinned SHA-256. Files already present with the right hash are kept.
 *
 *   npx tsx scripts/fetch_samples.ts
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface Manifest {
  khronos: { repository: string; commit: string }
  downloads: { file: string; model: string; sha256: string }[]
}

const SAMPLES = fileURLToPath(new URL('../samples', import.meta.url))
const ASSETS = join(SAMPLES, 'assets')

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(SAMPLES, 'manifest.json'), 'utf8')) as Manifest
  // Files are fetched from the exact commit, so the benchmark inputs cannot drift.
  const base = manifest.khronos.repository.replace('github.com', 'raw.githubusercontent.com') + `/${manifest.khronos.commit}/Models`
  mkdirSync(ASSETS, { recursive: true })

  for (const item of manifest.downloads) {
    const path = join(ASSETS, item.file)
    if (existsSync(path) && sha256(readFileSync(path)) === item.sha256) {
      console.log(`ok       ${item.file}`)
      continue
    }
    const url = `${base}/${item.model}/glTF-Binary/${item.model}.glb`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
    const data = new Uint8Array(await res.arrayBuffer())
    const actual = sha256(data)
    if (actual !== item.sha256) throw new Error(`${item.file}: checksum mismatch (expected ${item.sha256}, got ${actual})`)
    writeFileSync(path, data)
    console.log(`fetched  ${item.file} (${data.byteLength} bytes)`)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
