/**
 * Reads the JSON chunk of a binary glTF (.glb) and summarises it. This never decodes mesh data:
 * triangle counts come from accessor counts, which stay in the JSON even for Draco primitives.
 */

const MAGIC = 0x46546c67 // "glTF"
const CHUNK_JSON = 0x4e4f534a // "JSON"

export interface GlbAnimation {
  name: string
  /** Seconds: the largest keyframe time over all samplers. */
  duration: number
  channels: number
}

export interface GlbInfo {
  bytes: number
  triangles: number
  meshes: number
  primitives: number
  /** Primitives stored with KHR_draco_mesh_compression. */
  dracoPrimitives: number
  /** Number of images embedded in (or referenced by) the file. */
  textures: number
  imageMimeTypes: string[]
  skins: number
  joints: number
  animations: GlbAnimation[]
  extensionsUsed: string[]
}

interface Accessor {
  count: number
  max?: number[]
}

interface Primitive {
  mode?: number
  indices?: number
  attributes: Record<string, number>
  extensions?: Record<string, unknown>
}

interface GltfJson {
  accessors?: Accessor[]
  meshes?: { primitives: Primitive[] }[]
  images?: { mimeType?: string; uri?: string }[]
  skins?: { joints: number[] }[]
  animations?: { name?: string; channels: unknown[]; samplers: { input: number }[] }[]
  extensionsUsed?: string[]
}

export function readGlbJson(buf: Uint8Array): GltfJson {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (buf.byteLength < 20 || view.getUint32(0, true) !== MAGIC) throw new Error('not a GLB file (bad magic)')
  const version = view.getUint32(4, true)
  if (version !== 2) throw new Error(`unsupported glTF version ${version}`)
  const chunkLength = view.getUint32(12, true)
  if (view.getUint32(16, true) !== CHUNK_JSON) throw new Error('first GLB chunk is not JSON')
  const json = new TextDecoder().decode(buf.subarray(20, 20 + chunkLength))
  return JSON.parse(json) as GltfJson
}

function primitiveTriangles(prim: Primitive, accessors: Accessor[]): number {
  const accessorIndex = prim.indices ?? prim.attributes.POSITION
  const count = accessorIndex === undefined ? 0 : (accessors[accessorIndex]?.count ?? 0)
  switch (prim.mode ?? 4) {
    case 4: // TRIANGLES
      return Math.floor(count / 3)
    case 5: // TRIANGLE_STRIP
    case 6: // TRIANGLE_FAN
      return Math.max(0, count - 2)
    default: // points and lines
      return 0
  }
}

export function inspectGlb(buf: Uint8Array): GlbInfo {
  const gltf = readGlbJson(buf)
  const accessors = gltf.accessors ?? []
  const meshes = gltf.meshes ?? []
  const prims = meshes.flatMap((m) => m.primitives)
  const images = gltf.images ?? []
  const skins = gltf.skins ?? []

  const animations = (gltf.animations ?? []).map((a, i) => ({
    name: a.name ?? `animation_${i}`,
    duration: Math.max(0, ...a.samplers.map((s) => accessors[s.input]?.max?.[0] ?? 0)),
    channels: a.channels.length,
  }))

  return {
    bytes: buf.byteLength,
    triangles: prims.reduce((sum, p) => sum + primitiveTriangles(p, accessors), 0),
    meshes: meshes.length,
    primitives: prims.length,
    dracoPrimitives: prims.filter((p) => p.extensions?.KHR_draco_mesh_compression).length,
    textures: images.length,
    imageMimeTypes: images.map((img) => img.mimeType ?? 'external'),
    skins: skins.length,
    joints: skins.reduce((sum, s) => sum + s.joints.length, 0),
    animations,
    extensionsUsed: gltf.extensionsUsed ?? [],
  }
}
