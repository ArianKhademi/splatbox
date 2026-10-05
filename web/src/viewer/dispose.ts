import type { Material, Mesh, Object3D, SkinnedMesh, Texture } from 'three'

function disposeMaterial(material: Material): void {
  // Textures hang off material properties (map, normalMap, ...); find them by type, not by name.
  for (const value of Object.values(material)) {
    if ((value as Texture | null)?.isTexture) (value as Texture).dispose()
  }
  material.dispose()
}

/**
 * Releases the GPU resources owned by everything under `root`: geometries, materials, the textures
 * those materials reference, and skeleton bone textures. three.js never frees these on its own
 * when an object leaves the scene, so every asset switch has to do it.
 */
export function disposeObject(root: Object3D): void {
  root.traverse((object) => {
    const mesh = object as Partial<Mesh> & Partial<SkinnedMesh>
    mesh.geometry?.dispose()
    mesh.skeleton?.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    materials.forEach(disposeMaterial)
  })
}

export interface ModelStats {
  triangles: number
  meshes: number
  bones: number
}

export function modelStats(root: Object3D): ModelStats {
  const stats: ModelStats = { triangles: 0, meshes: 0, bones: 0 }
  root.traverse((object) => {
    if ((object as { isBone?: boolean }).isBone) stats.bones++
    const geometry = (object as Partial<Mesh>).geometry
    if (!geometry) return
    stats.meshes++
    const vertexCount = geometry.index ? geometry.index.count : (geometry.attributes.position?.count ?? 0)
    stats.triangles += Math.floor(vertexCount / 3)
  })
  return stats
}
