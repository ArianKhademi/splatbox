import type { ReactNode } from 'react'
import type { ClipSource, ViewerAsset } from '../viewer/types'
import { Viewer } from '../viewer/Viewer'

interface WorkspaceProps {
  /** Assets offered in the switcher on the left. */
  assets: { id: string; name: string; kind: string }[]
  current: ViewerAsset
  onSelect: (id: string) => void
  clipSources?: ClipSource[]
  aside?: ReactNode
}

/**
 * Asset switcher, viewer, and an optional details column. The Viewer is not keyed by asset, so
 * moving between assets reuses one canvas and one WebGL context and only swaps what is in the scene.
 */
export function Workspace({ assets, current, onSelect, clipSources, aside }: WorkspaceProps) {
  return (
    <div className="workspace" data-aside={Boolean(aside)}>
      <ul className="asset-list">
        {assets.map((asset) => (
          <li key={asset.id}>
            <button type="button" aria-current={asset.id === current.id} data-testid={`asset-${asset.id}`} onClick={() => onSelect(asset.id)}>
              <span>{asset.name}</span>
              <small>{asset.kind}</small>
            </button>
          </li>
        ))}
      </ul>
      <Viewer asset={current} clipSources={clipSources} />
      {aside}
    </div>
  )
}
