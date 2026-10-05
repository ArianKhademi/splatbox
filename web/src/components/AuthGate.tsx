import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { api, ApiError } from '../lib/api'

type AuthState = 'checking' | 'ok' | 'login' | 'offline'

/**
 * Wraps the api-backed pages. The demo api has one shared token; entering it once swaps it for a
 * signed, http-only session cookie so the token itself never has to be stored in the browser.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>('checking')
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .listAssets({ limit: 1 })
      .then(() => setState('ok'))
      .catch((err: unknown) => setState(err instanceof ApiError && err.status === 401 ? 'login' : 'offline'))
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      await api.login(token)
      setState('ok')
    } catch {
      setError('That token was not accepted.')
    }
  }

  if (state === 'ok') return <>{children}</>
  if (state === 'checking') return <p className="notice">Connecting…</p>
  if (state === 'offline') {
    return (
      <p className="notice">
        The api is not reachable. The viewer still works on the bundled <a href="#/demo">demo assets</a>.
      </p>
    )
  }
  return (
    <form className="login" onSubmit={submit}>
      <label>
        API token
        <input type="password" aria-label="API token" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
      </label>
      <button type="submit" disabled={!token}>
        Sign in
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  )
}
