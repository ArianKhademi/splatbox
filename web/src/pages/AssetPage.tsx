import { useCallback, useEffect, useRef, useState } from 'react'
import { statusLabel } from '../components/AssetCard'
import { Workspace } from '../components/Workspace'
import { api, formatBytes, toClipSource, toViewerAsset, type AssetDto } from '../lib/api'
import { navigate } from '../lib/router'
import { useSession } from '../lib/session'
import type { ViewerAsset } from '../viewer/types'

const POLL_MS = 2500

/**
 * Presigned URLs change every time the api signs them, and a changed URL would make the viewer
 * reload the model. So the viewer asset is rebuilt only when the asset, or the set of files it has
 * (for example once the converted GLB appears), actually changes.
 */
function useStableViewerAsset(asset: AssetDto | null): ViewerAsset | null {
  const cache = useRef<{ key: string; value: ViewerAsset } | null>(null)
  if (!asset) return null
  const key = `${asset.id}|${asset.files
    .map((f) => f.role)
    .sort()
    .join(',')}`
  if (cache.current?.key !== key) cache.current = { key, value: toViewerAsset(asset) }
  return cache.current.value
}

function Details({ asset, onChanged }: { asset: AssetDto; onChanged: () => void }) {
  const session = useSession()
  const stats = asset.stats
  async function remove() {
    if (!window.confirm(`Delete "${asset.name}" and its files?`)) return
    await api.deleteAsset(asset.id)
    navigate('/')
  }
  return (
    <aside className="details" data-testid="asset-details">
      <h2>{asset.name}</h2>
      <div className="badges">
        <span className="badge kind">{asset.kind}</span>
        <span className="badge status" data-status={asset.status}>
          {statusLabel(asset)}
        </span>
      </div>
      {stats && (
        <dl>
          <dt>Size</dt>
          <dd>
            {formatBytes(stats.bytesBefore)} → {formatBytes(stats.bytesAfter)} <b>({-stats.reductionPct.toFixed(1)}%)</b>
          </dd>
          <dt>Triangles</dt>
          <dd>
            {stats.trianglesBefore.toLocaleString()} → {stats.trianglesAfter.toLocaleString()}
          </dd>
          <dt>Textures</dt>
          <dd>
            {stats.texturesBefore} → {stats.texturesAfter}
          </dd>
        </dl>
      )}
      <h3>Jobs</h3>
      <ul className="jobs">
        {asset.jobs.map((job) => (
          <li key={job.id} data-state={job.state}>
            <span>{job.type}</span>
            <span>
              {job.state}
              {job.attempts > 1 ? ` · attempt ${job.attempts}` : ''}
              {job.durationMs !== null ? ` · ${(job.durationMs / 1000).toFixed(1)}s` : ''}
            </span>
            {job.error && <pre className="job-error">{job.error}</pre>}
          </li>
        ))}
        {asset.jobs.length === 0 && <li>none yet</li>}
      </ul>
      <h3>Files</h3>
      <ul className="files">
        {asset.files.map((file) => (
          <li key={file.role}>
            <a href={file.url} download={file.filename}>
              {file.role}
            </a>
            <span>{formatBytes(file.bytes)}</span>
          </li>
        ))}
      </ul>
      {session.status === 'signed-in' && (
        <div className="actions">
          {asset.status === 'failed' && (
            <button type="button" onClick={() => void api.retry(asset.id).then(onChanged)}>
              Retry jobs
            </button>
          )}
          <button type="button" className="danger" onClick={() => void remove()}>
            Delete
          </button>
        </div>
      )}
    </aside>
  )
}

export function AssetPage({ id }: { id: string }) {
  const [asset, setAsset] = useState<AssetDto | null>(null)
  const [all, setAll] = useState<AssetDto[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api
      .getAsset(id)
      .then((next) => {
        setAsset(next)
        setError(null)
      })
      .catch((err: Error) => setError(err.message))
  }, [id])

  useEffect(load, [load])
  useEffect(() => {
    api
      .listAssets({ limit: 100 })
      .then((page) => setAll(page.items))
      .catch(() => setAll([]))
  }, [])

  const settled = !asset || asset.status === 'ready' || asset.status === 'failed'
  useEffect(() => {
    if (settled) return
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [settled, load])

  // While the next asset is loading keep showing the previous one, so the viewer never unmounts.
  const viewerAsset = useStableViewerAsset(asset)
  if (error) return <p className="notice error">{error}</p>
  if (!asset || !viewerAsset) return <p className="notice">Loading…</p>

  const clipSources = all
    .filter((a) => a.kind === 'clip' && a.id !== asset.id)
    .map(toClipSource)
    .filter((s) => s !== null)
  return (
    <Workspace
      assets={all.length > 0 ? all : [asset]}
      current={viewerAsset}
      onSelect={(next) => navigate(`/asset/${next}`)}
      clipSources={clipSources}
      aside={<Details asset={asset} onChanged={load} />}
    />
  )
}
