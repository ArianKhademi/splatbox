import { useCallback, useEffect, useRef, useState } from 'react'
import { AssetCard } from '../components/AssetCard'
import { UploadForm } from '../components/UploadForm'
import { api, type AssetDto } from '../lib/api'
import { useSession } from '../lib/session'
import type { AssetKind } from '../viewer/types'

const PAGE_SIZE = 24
const POLL_MS = 2500
const KINDS: (AssetKind | '')[] = ['', 'character', 'clip', 'splat', 'pair']

function isSettled(asset: AssetDto): boolean {
  return asset.status === 'ready' || asset.status === 'failed'
}

export function BrowsePage() {
  const session = useSession()
  const [kind, setKind] = useState<AssetKind | ''>('')
  const [items, setItems] = useState<AssetDto[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showUpload, setShowUpload] = useState(false)
  const loaded = useRef(0)
  loaded.current = items.length

  /** Reloads from the top, keeping as many rows as are already on screen. */
  const refresh = useCallback(async () => {
    try {
      const page = await api.listAssets({ kind: kind || undefined, limit: Math.min(Math.max(loaded.current, PAGE_SIZE), 100) })
      setItems(page.items)
      setNextCursor(page.nextCursor)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [kind])

  useEffect(() => {
    loaded.current = 0
    setLoading(true)
    void refresh()
  }, [refresh])

  // Poll only while something is still being processed.
  const pending = items.some((asset) => !isSettled(asset))
  useEffect(() => {
    if (!pending) return
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [pending, refresh])

  async function loadMore() {
    if (!nextCursor) return
    const page = await api.listAssets({ kind: kind || undefined, cursor: nextCursor, limit: PAGE_SIZE })
    setItems((current) => [...current, ...page.items])
    setNextCursor(page.nextCursor)
  }

  return (
    <div className="browse">
      <div className="toolbar">
        <div className="filters" role="tablist" aria-label="Filter by kind">
          {KINDS.map((k) => (
            <button key={k || 'all'} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>
              {k || 'all'}
            </button>
          ))}
        </div>
        {session.status === 'signed-in' ? (
          <button type="button" className="primary" onClick={() => setShowUpload((v) => !v)}>
            {showUpload ? 'Close' : 'Upload'}
          </button>
        ) : (
          session.status === 'signed-out' && <span className="hint">Sign in with the API token to upload.</span>
        )}
      </div>
      {showUpload && session.status === 'signed-in' && <UploadForm onUploaded={() => void refresh()} />}
      {error && (
        <p className="notice error">
          The api is not reachable ({error}). The viewer still works on the bundled <a href="#/demo">demo assets</a>.
        </p>
      )}
      {!loading && items.length === 0 && !error && <p className="notice">Nothing here yet. Upload a model, a splat scene, or a video and motion pair.</p>}
      <div className="grid" data-testid="asset-grid">
        {items.map((asset) => (
          <AssetCard key={asset.id} asset={asset} />
        ))}
      </div>
      {nextCursor && (
        <button type="button" className="more" onClick={() => void loadMore()}>
          Load more
        </button>
      )}
    </div>
  )
}
