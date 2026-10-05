import { Db } from '@splatbox/shared'
import { copyFile, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BlenderTools, ConvertReport, TurntableReport } from '../src/blender/scripts'
import type { JobContext } from '../src/context'
import type { SplatRenderer } from '../src/splat'

/** Builds a structurally valid GLB whose JSON chunk is `json`, padded to `totalBytes` if given. */
export function makeGlb(json: object, totalBytes = 0): Buffer {
  let text = JSON.stringify(json)
  text += ' '.repeat((4 - (text.length % 4)) % 4)
  const chunk = Buffer.from(text)
  const padding = Buffer.alloc(Math.max(0, totalBytes - 20 - chunk.length))
  const header = Buffer.alloc(20)
  header.writeUInt32LE(0x46546c67, 0) // "glTF"
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(20 + chunk.length + padding.length, 8)
  header.writeUInt32LE(chunk.length, 12)
  header.writeUInt32LE(0x4e4f534a, 16) // "JSON"
  return Buffer.concat([header, chunk, padding])
}

/** A GLB JSON with one Draco triangle mesh of `triangles` triangles and `textures` images. */
export function gltfJson(triangles: number, textures: number): object {
  return {
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_draco_mesh_compression'],
    accessors: [{ count: triangles * 3 }, { count: triangles * 3 }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, extensions: { KHR_draco_mesh_compression: {} } }] }],
    images: Array.from({ length: textures }, () => ({ mimeType: 'image/webp', bufferView: 0 })),
  }
}

/** Object storage as a map of key to bytes, with the two methods job handlers use. */
export class FakeStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>()

  put(key: string, body: Buffer, contentType = 'application/octet-stream'): void {
    this.objects.set(key, { body, contentType })
  }

  async downloadToFile(key: string, path: string): Promise<void> {
    const object = this.objects.get(key)
    if (!object) throw new Error(`NoSuchKey: ${key}`)
    await writeFile(path, object.body)
  }

  async uploadFile(key: string, path: string, contentType: string): Promise<number> {
    const body = await readFile(path)
    this.objects.set(key, { body, contentType })
    return body.byteLength
  }
}

export const CONVERT_REPORT: ConvertReport = {
  bytes_before: 5000,
  bytes_after: 0,
  before: { triangles: 120, meshes: 1, textures: 2, armatures: 1, animations: 1 },
  removed: { cameras: 1, lights: 2, empties: 0 },
  textures: [{ name: 'albedo', size: [4096, 4096], bytes_before: 4000, action: 'resized', format: 'WEBP', to: [2048, 2048], bytes_after: 900 }],
  resized_textures: [{ name: 'albedo', size: [4096, 4096], to: [2048, 2048] }],
  settings: {},
  blender: '4.5.14 LTS',
  seconds: 0.5,
}

export interface FakeBlender extends BlenderTools {
  convertCalls: { input: string; output: string }[]
  turntableCalls: { input: string; outDir: string; frames: number; size: number; engine: string }[]
}

/**
 * Blender, mocked at the boundary the handlers use. `writeOutput` plays the part of convert.py
 * (it must create the output file); `writeFrames` plays turntable.py (returns the frame paths).
 */
export function fakeBlender(opts: {
  writeOutput?: (input: string, output: string) => Promise<void>
  writeFrames?: (outDir: string, frames: number) => Promise<string[]>
  report?: Partial<ConvertReport>
}): FakeBlender {
  const fake: FakeBlender = {
    convertCalls: [],
    turntableCalls: [],
    async convert(input, output) {
      fake.convertCalls.push({ input, output })
      await opts.writeOutput?.(input, output)
      return { ...CONVERT_REPORT, ...opts.report }
    },
    async turntable(input, outDir, options): Promise<TurntableReport> {
      fake.turntableCalls.push({ input, outDir, ...options })
      const frames = (await opts.writeFrames?.(outDir, options.frames)) ?? []
      return { frames, engine: 'BLENDER_EEVEE_NEXT', radius: 1, seconds: 1 }
    },
  }
  return fake
}

export async function makeContext(overrides: Partial<JobContext> = {}) {
  const db = new Db(':memory:')
  const storage = new FakeStorage()
  const workRoot = await mkdtemp(join(tmpdir(), 'splatbox-test-'))
  const splat: SplatRenderer = { render: async () => [], close: async () => undefined }
  const ctx: JobContext = { db, storage, blender: fakeBlender({}), splat, workRoot, turntableEngine: 'eevee', ...overrides }
  return { ctx, db, storage, workRoot, leftovers: () => readdir(workRoot) }
}

/** Registers an uploaded one-file asset the way the api does, with `body` as its stored source. */
export function seedAsset(db: Db, storage: FakeStorage, opts: { id: string; kind: 'character' | 'clip' | 'splat'; filename: string; body: Buffer }) {
  const ext = opts.filename.slice(opts.filename.lastIndexOf('.'))
  const key = `uploads/${opts.id}/source${ext}`
  db.createAsset({ id: opts.id, name: opts.filename, kind: opts.kind })
  db.putFile({ assetId: opts.id, role: 'source', key, filename: opts.filename, contentType: 'application/octet-stream', bytes: opts.body.length })
  storage.put(key, opts.body)
  return key
}

export { copyFile }
