import { useState } from 'react'
import { formatBytes, type AssetDto } from '../lib/api'
import { useInView } from '../lib/useInView'

/** One line for the card: the job that is running or failed, else the asset status. */
export function statusLabel(asset: AssetDto): string {
  const failed = asset.jobs.find((job) => job.state === 'failed')
  if (failed) return `${failed.type} failed`
  const active = asset.jobs.find((job) => job.state === 'active') ?? asset.jobs.find((job) => job.state === 'queued')
  if (active) return `${active.type} ${active.state}`
  return asset.status
}

export function AssetCard({ asset }: { asset: AssetDto }) {
  const [ref, inView] = useInView<HTMLAnchorElement>()
  const [hovered, setHovered] = useState(false)
  const stats = asset.stats
  return (
    <a
      ref={ref}
      className="card"
      href={`#/asset/${asset.id}`}
      data-status={asset.status}
      data-testid="asset-card"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="thumb">
        {asset.thumbs && inView ? (
          <>
            <img className="poster" src={asset.thumbs.posterUrl} alt={`${asset.name} poster`} />
            {/* The animated turntable is only requested on first hover, then drawn over the poster. */}
            {hovered && <img className="turntable" src={asset.thumbs.turntableUrl} alt="" />}
          </>
        ) : (
          <div className="thumb-placeholder">{asset.thumbs ? '' : statusLabel(asset)}</div>
        )}
      </div>
      <div className="card-body">
        <div className="card-title" title={asset.name}>
          {asset.name}
        </div>
        <div className="badges">
          <span className="badge kind">{asset.kind}</span>
          <span className="badge status" data-testid="card-status">
            {statusLabel(asset)}
          </span>
        </div>
        <dl className="card-stats">
          <dt>Triangles</dt>
          <dd>{stats ? stats.trianglesAfter.toLocaleString() : '-'}</dd>
          <dt>Size</dt>
          <dd>
            {stats ? (
              <>
                {formatBytes(stats.bytesBefore)} → {formatBytes(stats.bytesAfter)} <b>({-Math.round(stats.reductionPct)}%)</b>
              </>
            ) : (
              formatBytes(asset.files.find((f) => f.role === 'source' || f.role === 'motion')?.bytes)
            )}
          </dd>
        </dl>
      </div>
    </a>
  )
}
