export type AssetKind = 'character' | 'clip' | 'splat' | 'pair'
export type SplatFormat = 'ply' | 'splat' | 'ksplat'

/** Everything the viewer needs to show one asset, wherever it came from (the api or the bundled demo set). */
export interface ViewerAsset {
  id: string
  name: string
  kind: AssetKind
  /** GLB for character, clip and pair (the motion). */
  modelUrl?: string
  /** Source video of a pair. */
  videoUrl?: string
  splatUrl?: string
  splatFormat?: SplatFormat
  /** Splat scenes trained from COLMAP poses are Y-down; flip them upright. */
  flipY?: boolean
}

/** A GLB whose animations can be applied to the open character. */
export interface ClipSource {
  id: string
  name: string
  url: string
}

export function splatFormatOf(filename: string): SplatFormat | undefined {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
  return ext === 'ply' || ext === 'splat' || ext === 'ksplat' ? ext : undefined
}
