// The library ships without type declarations; this covers the part of its API the viewer uses.
declare module '@mkkellogg/gaussian-splats-3d' {
  import type { Box3, Camera, Group, Mesh, Vector3, WebGLRenderer } from 'three'

  export const SceneFormat: { Splat: 0; KSplat: 1; Ply: 2; Spz: 3 }
  export const SceneRevealMode: { Default: 0; Gradual: 1; Instant: 2 }
  export const LogLevel: { None: 0; Error: 1; Warning: 2; Info: 3; Debug: 4 }

  export interface ViewerOptions {
    gpuAcceleratedSort?: boolean
    sharedMemoryForWorkers?: boolean
    sceneRevealMode?: number
    sphericalHarmonicsDegree?: number
    logLevel?: number
    freeIntermediateSplatData?: boolean
  }

  export interface SplatSceneOptions {
    format?: number
    showLoadingUI?: boolean
    progressiveLoad?: boolean
    splatAlphaRemovalThreshold?: number
    position?: [number, number, number]
    rotation?: [number, number, number, number]
    scale?: [number, number, number]
  }

  export class SplatMesh extends Mesh {
    getSplatCount(): number
    getSplatCenter(index: number, out: Vector3, applySceneTransform?: boolean): void
    setSplatScale(scale: number): void
    getSplatScale(): number
    computeBoundingBox(applySceneTransforms?: boolean, sceneIndex?: number): Box3
  }

  /** The engine behind DropInViewer. Only the members needed to wait for a depth sort are declared. */
  export class Viewer {
    sortRunning: boolean
    sortPromise: Promise<void> | null
    update(renderer: WebGLRenderer, camera: Camera): void
    runSplatSort(force?: boolean, forceSortAll?: boolean): Promise<boolean>
  }

  export class DropInViewer extends Group {
    constructor(options?: ViewerOptions)
    viewer: Viewer
    splatMesh: SplatMesh
    callbackMesh: Mesh
    addSplatScene(path: string, options?: SplatSceneOptions): Promise<void>
    dispose(): Promise<void>
  }
}
