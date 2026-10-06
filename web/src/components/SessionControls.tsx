import { useState, type FormEvent } from 'react'
import { useSession } from '../lib/session'

/** The sign-in / sign-out corner of the top bar. Browsing never needs it; uploading does. */
export function SessionControls() {
  const session = useSession()
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (session.status === 'checking' || session.status === 'offline') return null
  if (session.status === 'signed-in') {
    return (
      <button type="button" className="session" onClick={() => void session.signOut()}>
        Sign out
      </button>
    )
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      await session.signIn(token)
      setToken('')
      setOpen(false)
      setError(null)
    } catch {
      setError('That token was not accepted.')
    }
  }

  return (
    <div className="session">
      {open ? (
        <form className="login" onSubmit={submit}>
          <input type="password" aria-label="API token" placeholder="API token" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
          <button type="submit" disabled={!token}>
            Use token
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
          {error && <span className="error">{error}</span>}
        </form>
      ) : (
        <button type="button" onClick={() => setOpen(true)}>
          Sign in
        </button>
      )}
    </div>
  )
}
