import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from './api'

/**
 * Reading is open to anyone; the api token (exchanged for a cookie) is only needed to upload,
 * retry or delete. The web app asks the api once whether its cookie is good and keeps the answer here.
 */
export type SessionStatus = 'checking' | 'signed-out' | 'signed-in' | 'offline'

export interface Session {
  status: SessionStatus
  signIn: (token: string) => Promise<void>
  signOut: () => Promise<void>
}

const SessionContext = createContext<Session>({ status: 'checking', signIn: async () => undefined, signOut: async () => undefined })

/** `enabled` is false on pages that never talk to the api (the demo page), so no request is made there. */
export function SessionProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('checking')

  useEffect(() => {
    if (!enabled) {
      setStatus('offline')
      return
    }
    let cancelled = false
    api
      .session()
      .then((s) => !cancelled && setStatus(s.authenticated ? 'signed-in' : 'signed-out'))
      .catch(() => !cancelled && setStatus('offline'))
    return () => {
      cancelled = true
    }
  }, [enabled])

  const signIn = useCallback(async (token: string) => {
    await api.login(token)
    setStatus('signed-in')
  }, [])
  const signOut = useCallback(async () => {
    await api.logout()
    setStatus('signed-out')
  }, [])

  const value = useMemo(() => ({ status, signIn, signOut }), [status, signIn, signOut])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): Session {
  return useContext(SessionContext)
}
