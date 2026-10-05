import { useEffect, useState } from 'react'
import { Workspace } from '../components/Workspace'
import { navigate } from '../lib/router'
import type { ViewerAsset } from '../viewer/types'

/**
 * The viewer over the small set of assets bundled in /demo. It needs no api, storage, or worker,
 * which is what the end-to-end tests and the README captures run against.
 */
export function DemoPage({ id }: { id: string | null }) {
  const [assets, setAssets] = useState<ViewerAsset[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}demo/manifest.json`)
      .then((res) => (res.ok ? (res.json() as Promise<ViewerAsset[]>) : Promise.reject(new Error(`manifest: ${res.status}`))))
      .then(setAssets)
      .catch((err: Error) => setError(err.message))
  }, [])

  if (error) return <p className="notice">Demo assets are unavailable: {error}</p>
  if (!assets) return <p className="notice">Loading demo assets…</p>
  const current = assets.find((asset) => asset.id === id) ?? assets[0]
  if (!current) return <p className="notice">No demo assets are bundled.</p>

  const clipSources = assets.filter((a) => a.kind === 'clip' && a.modelUrl).map((a) => ({ id: a.id, name: a.name, url: a.modelUrl! }))
  return <Workspace assets={assets} current={current} onSelect={(next) => navigate(`/demo/${next}`)} clipSources={clipSources} />
}
