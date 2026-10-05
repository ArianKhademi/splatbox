import { describe, expect, it } from 'vitest'
import { inspectGlb, readGlbJson } from '../src/glb'

function glb(json: object): Uint8Array {
  let text = JSON.stringify(json)
  text += ' '.repeat((4 - (text.length % 4)) % 4)
  const chunk = new TextEncoder().encode(text)
  const out = new Uint8Array(20 + chunk.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, out.length, true)
  view.setUint32(12, chunk.length, true)
  view.setUint32(16, 0x4e4f534a, true)
  out.set(chunk, 20)
  return out
}

describe('inspectGlb', () => {
  it('counts triangles per node instance, across indexed, non-indexed and strip primitives', () => {
    const info = inspectGlb(
      glb({
        accessors: [{ count: 300 }, { count: 90 }, { count: 12 }, { count: 50 }],
        nodes: [{ mesh: 0 }, { mesh: 0 }, { mesh: 1 }, {}],
        meshes: [
          { primitives: [{ attributes: { POSITION: 3 }, indices: 0 }] }, // 100 triangles, used by two nodes
          {
            primitives: [
              { attributes: { POSITION: 1 } }, // not indexed: 90 vertices = 30 triangles
              { attributes: { POSITION: 2 }, mode: 5 }, // strip of 12 vertices = 10 triangles
              { attributes: { POSITION: 2 }, mode: 1 }, // lines: no triangles
            ],
          },
        ],
      }),
    )
    expect(info.triangles).toBe(100 * 2 + 30 + 10)
    expect(info.meshes).toBe(2)
    expect(info.primitives).toBe(4)
  })

  it('reports Draco primitives, textures, skins and animation durations', () => {
    const info = inspectGlb(
      glb({
        extensionsUsed: ['KHR_draco_mesh_compression', 'EXT_texture_webp'],
        accessors: [{ count: 30 }, { count: 30 }, { count: 4, max: [1.25] }, { count: 4 }, { count: 2, max: [0.5] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, extensions: { KHR_draco_mesh_compression: {} } }] }],
        images: [{ mimeType: 'image/webp' }, { mimeType: 'image/png' }, { uri: 'external.jpg' }],
        skins: [{ joints: [1, 2, 3] }],
        animations: [
          { name: 'Walk', channels: [{}, {}], samplers: [{ input: 2 }, { input: 4 }] },
          { channels: [{}], samplers: [{ input: 4 }] },
        ],
      }),
    )
    expect(info.dracoPrimitives).toBe(1)
    expect(info.textures).toBe(3)
    expect(info.imageMimeTypes).toEqual(['image/webp', 'image/png', 'external'])
    expect(info).toMatchObject({ skins: 1, joints: 3 })
    expect(info.animations).toEqual([
      { name: 'Walk', duration: 1.25, channels: 2 },
      { name: 'animation_1', duration: 0.5, channels: 1 },
    ])
    expect(info.extensionsUsed).toContain('EXT_texture_webp')
  })

  it('handles an empty scene', () => {
    expect(inspectGlb(glb({ asset: { version: '2.0' } }))).toMatchObject({ triangles: 0, textures: 0, skins: 0, animations: [] })
  })

  it('rejects files that are not GLB', () => {
    expect(() => readGlbJson(new TextEncoder().encode('this is definitely not a glb file'))).toThrow(/bad magic/)
    expect(() => readGlbJson(new Uint8Array(4))).toThrow(/bad magic/)
  })
})
