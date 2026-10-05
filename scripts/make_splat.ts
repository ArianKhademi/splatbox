/**
 * Synthesises a Gaussian splat scene from a textured GLB: every triangle is covered with flat,
 * surface-aligned Gaussians coloured from the base-colour texture, on top of a splatted ground disc.
 *
 *   npx tsx scripts/make_splat.ts <model.glb> <out.splat|out.ply> [splat count]
 *
 * This is how the bundled demo scene is made. Captured scenes are tens to hundreds of megabytes and
 * come with their own licenses; this one is small, reproducible (seeded), and built from a CC0
 * model. It is a real splat file in the two common layouts, not a mock: `.ply` is the layout the
 * original 3D Gaussian Splatting trainer writes, `.splat` is the compact 32-bytes-per-splat form.
 * What it does not have is view-dependent colour (only the constant spherical-harmonic term is set).
 */
import { readGlbJson } from '@splatbox/shared'
import { readFileSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'

type Vec3 = [number, number, number]

interface Splat {
  position: Vec3
  /** Standard deviations along the splat's own x, y, z axes. z is the surface normal, kept thin. */
  scale: Vec3
  /** Unit quaternion (w, x, y, z) turning the splat's z axis onto the surface normal. */
  rotation: [number, number, number, number]
  /** sRGB, 0..1 */
  color: Vec3
  opacity: number
}

/** Small seeded generator (mulberry32) so the file is identical on every run. */
function random(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const length = (a: Vec3) => Math.hypot(a[0], a[1], a[2])

/** Shortest rotation taking +Z to the unit vector n. */
function quaternionFromZ(n: Vec3): [number, number, number, number] {
  const w = 1 + n[2]
  if (w < 1e-6) return [0, 1, 0, 0] // n is -Z: half a turn about X
  const q: [number, number, number, number] = [w, -n[1], n[0], 0]
  const norm = Math.hypot(...q)
  return [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm]
}

interface Mesh {
  positions: Float32Array
  uvs: Float32Array | null
  indices: Uint32Array
  texture: { data: Buffer; width: number; height: number } | null
}

/** Reads the first mesh primitive of an uncompressed GLB, plus its base-colour texture. */
async function readMesh(path: string): Promise<Mesh> {
  const file = readFileSync(path)
  /* eslint-disable @typescript-eslint/no-explicit-any -- walking raw glTF JSON */
  const gltf = readGlbJson(file) as any
  const jsonLength = file.readUInt32LE(12)
  const bin = file.subarray(20 + jsonLength + 8)

  const view = (index: number): Buffer => {
    const v = gltf.bufferViews[index]
    return bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)
  }
  const floats = (accessorIndex: number, components: number): Float32Array => {
    const accessor = gltf.accessors[accessorIndex]
    const bytes = view(accessor.bufferView).subarray(accessor.byteOffset ?? 0)
    const stride = gltf.bufferViews[accessor.bufferView].byteStride ?? components * 4
    const out = new Float32Array(accessor.count * components)
    for (let i = 0; i < accessor.count; i++) for (let c = 0; c < components; c++) out[i * components + c] = bytes.readFloatLE(i * stride + c * 4)
    return out
  }

  const primitive = gltf.meshes[0].primitives[0]
  const indexAccessor = gltf.accessors[primitive.indices]
  const indexBytes = view(indexAccessor.bufferView).subarray(indexAccessor.byteOffset ?? 0)
  const indices = new Uint32Array(indexAccessor.count)
  for (let i = 0; i < indices.length; i++) {
    indices[i] = indexAccessor.componentType === 5125 ? indexBytes.readUInt32LE(i * 4) : indexBytes.readUInt16LE(i * 2)
  }

  let texture: Mesh['texture'] = null
  const textureIndex = gltf.materials?.[primitive.material]?.pbrMetallicRoughness?.baseColorTexture?.index
  if (textureIndex !== undefined) {
    const image = gltf.images[gltf.textures[textureIndex].source]
    const { data, info } = await sharp(view(image.bufferView)).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    texture = { data, width: info.width, height: info.height }
  }

  // Apply the rotation of the node that holds the mesh, so the model stands the way it does in a viewer.
  const positions = floats(primitive.attributes.POSITION, 3)
  const node = gltf.nodes?.find((n: { mesh?: number }) => n.mesh === 0)
  if (node?.rotation) {
    const [qx, qy, qz, qw] = node.rotation as [number, number, number, number]
    for (let i = 0; i < positions.length; i += 3) {
      const v: Vec3 = [positions[i]!, positions[i + 1]!, positions[i + 2]!]
      // v' = v + 2 q_xyz x (q_xyz x v + w v)
      const q: Vec3 = [qx, qy, qz]
      const t = cross(q, [cross(q, v)[0] + qw * v[0], cross(q, v)[1] + qw * v[1], cross(q, v)[2] + qw * v[2]])
      positions.set([v[0] + 2 * t[0], v[1] + 2 * t[1], v[2] + 2 * t[2]], i)
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return {
    positions,
    uvs: primitive.attributes.TEXCOORD_0 !== undefined ? floats(primitive.attributes.TEXCOORD_0, 2) : null,
    indices,
    texture,
  }
}

const LIGHT: Vec3 = [0.45, 0.8, 0.4]

/** Simple baked shading so the splats read as a lit surface rather than a flat decal. */
function shade(color: Vec3, normal: Vec3): Vec3 {
  const lambert = Math.max(0, dot(normal, LIGHT) / length(LIGHT))
  const k = 0.55 + 0.6 * lambert
  return [Math.min(1, color[0] * k), Math.min(1, color[1] * k), Math.min(1, color[2] * k)]
}

function splatMesh(mesh: Mesh, count: number, rand: () => number): Splat[] {
  // Centre the model and scale it to a unit bounding radius, standing on y = 0.
  const p = mesh.positions
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c]!, p[i + c]!)
      max[c] = Math.max(max[c]!, p[i + c]!)
    }
  }
  const centre: Vec3 = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2]
  const unit = 2 / length(sub(max, min))
  const vertex = (i: number): Vec3 => [(p[i * 3]! - centre[0]) * unit, (p[i * 3 + 1]! - centre[1]) * unit, (p[i * 3 + 2]! - centre[2]) * unit]

  const triangles: { a: Vec3; b: Vec3; c: Vec3; ia: number; ib: number; ic: number; normal: Vec3; area: number }[] = []
  let totalArea = 0
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [ia, ib, ic] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!]
    const [a, b, c] = [vertex(ia), vertex(ib), vertex(ic)]
    const n = cross(sub(b, a), sub(c, a))
    const area = length(n) / 2
    if (area < 1e-12) continue
    triangles.push({ a, b, c, ia, ib, ic, normal: [n[0] / (2 * area), n[1] / (2 * area), n[2] / (2 * area)], area })
    totalArea += area
  }

  // Each splat covers about (area per splat); its radius follows from that, so coverage stays even
  // whatever the triangle sizes are.
  const radius = Math.sqrt(totalArea / count) * 0.75
  const splats: Splat[] = []
  for (const tri of triangles) {
    const expected = (tri.area / totalArea) * count
    const n = Math.floor(expected) + (rand() < expected % 1 ? 1 : 0)
    for (let i = 0; i < n; i++) {
      // Uniform point in the triangle.
      const r1 = Math.sqrt(rand())
      const r2 = rand()
      const [wa, wb, wc] = [1 - r1, r1 * (1 - r2), r1 * r2]
      const position: Vec3 = [
        tri.a[0] * wa + tri.b[0] * wb + tri.c[0] * wc,
        tri.a[1] * wa + tri.b[1] * wb + tri.c[1] * wc,
        tri.a[2] * wa + tri.b[2] * wb + tri.c[2] * wc,
      ]
      let color: Vec3 = [0.7, 0.7, 0.7]
      if (mesh.uvs && mesh.texture) {
        const u = mesh.uvs[tri.ia * 2]! * wa + mesh.uvs[tri.ib * 2]! * wb + mesh.uvs[tri.ic * 2]! * wc
        const v = mesh.uvs[tri.ia * 2 + 1]! * wa + mesh.uvs[tri.ib * 2 + 1]! * wb + mesh.uvs[tri.ic * 2 + 1]! * wc
        const x = Math.min(mesh.texture.width - 1, Math.max(0, Math.floor((u - Math.floor(u)) * mesh.texture.width)))
        const y = Math.min(mesh.texture.height - 1, Math.max(0, Math.floor((v - Math.floor(v)) * mesh.texture.height)))
        const o = (y * mesh.texture.width + x) * 3
        color = [mesh.texture.data[o]! / 255, mesh.texture.data[o + 1]! / 255, mesh.texture.data[o + 2]! / 255]
      }
      splats.push({
        position,
        scale: [radius, radius, radius * 0.15],
        rotation: quaternionFromZ(tri.normal),
        color: shade(color, tri.normal),
        opacity: 0.97,
      })
    }
  }
  return splats
}

/** A soft ground disc under the model: larger, fainter splats that fade out toward the rim. */
function splatGround(count: number, rand: () => number): Splat[] {
  const discRadius = 1.2
  const splats: Splat[] = []
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt(rand()) * discRadius
    const angle = rand() * Math.PI * 2
    const x = Math.cos(angle) * r
    const z = Math.sin(angle) * r
    const checker = (Math.floor(x * 2.5 + 100) + Math.floor(z * 2.5 + 100)) % 2 === 0 ? 0.3 : 0.24
    const fade = 1 - Math.pow(r / discRadius, 3)
    splats.push({
      position: [x, -0.002, z],
      scale: [0.028, 0.028, 0.004],
      rotation: quaternionFromZ([0, 1, 0]),
      color: [checker, checker * 1.03, checker * 1.1],
      opacity: 0.9 * fade,
    })
  }
  return splats
}

/** 32 bytes per splat: position f32x3, scale f32x3, RGBA u8x4, rotation u8x4 (w, x, y, z). */
function encodeSplat(splats: Splat[]): Buffer {
  const out = Buffer.alloc(splats.length * 32)
  splats.forEach((s, i) => {
    const o = i * 32
    for (let c = 0; c < 3; c++) out.writeFloatLE(s.position[c]!, o + c * 4)
    for (let c = 0; c < 3; c++) out.writeFloatLE(s.scale[c]!, o + 12 + c * 4)
    for (let c = 0; c < 3; c++) out.writeUInt8(Math.round(s.color[c]! * 255), o + 24 + c)
    out.writeUInt8(Math.round(s.opacity * 255), o + 27)
    for (let c = 0; c < 4; c++) out.writeUInt8(Math.max(0, Math.min(255, Math.round(s.rotation[c]! * 128 + 128))), o + 28 + c)
  })
  return out
}

const SH_C0 = 0.28209479177387814

/** The trainer's layout: log scales, logit opacity, and colour as the constant SH coefficient. */
function encodePly(splats: Splat[]): Buffer {
  const properties = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
  const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${splats.length}`, ...properties.map((name) => `property float ${name}`), 'end_header', ''].join('\n')
  const body = Buffer.alloc(splats.length * properties.length * 4)
  splats.forEach((s, i) => {
    const values = [
      ...s.position,
      0,
      0,
      0,
      ...s.color.map((c) => (c - 0.5) / SH_C0),
      Math.log(s.opacity / (1 - s.opacity)),
      ...s.scale.map((v) => Math.log(v)),
      ...s.rotation,
    ]
    values.forEach((value, j) => body.writeFloatLE(value, (i * properties.length + j) * 4))
  })
  return Buffer.concat([Buffer.from(header, 'ascii'), body])
}

async function main(): Promise<void> {
  const [input, output, countArg] = process.argv.slice(2)
  if (!input || !output || !/\.(splat|ply)$/.test(output)) {
    console.error('usage: tsx scripts/make_splat.ts <model.glb> <out.splat|out.ply> [splat count]')
    process.exit(1)
  }
  const count = Number(countArg ?? 60_000)
  const rand = random(42)
  const mesh = await readMesh(input)
  const splats = [...splatMesh(mesh, Math.round(count * 0.8), rand), ...splatGround(Math.round(count * 0.2), rand)]
  const data = output.endsWith('.ply') ? encodePly(splats) : encodeSplat(splats)
  writeFileSync(output, data)
  console.log(`wrote ${output}: ${splats.length} splats, ${data.byteLength} bytes`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
