import { useSyncExternalStore } from 'react'

export type Route =
  | { page: 'browse' }
  | { page: 'asset'; id: string }
  | { page: 'demo'; id: string | null }

export function parseRoute(hash: string): Route {
  const [page, id] = hash.replace(/^#\/?/, '').split('/')
  if (page === 'asset' && id) return { page: 'asset', id }
  if (page === 'demo') return { page: 'demo', id: id || null }
  return { page: 'browse' }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

/** Hash routing: three pages do not need a router dependency, and it works on any static host. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash)
  return parseRoute(hash)
}

export function navigate(path: string): void {
  window.location.hash = path
}
