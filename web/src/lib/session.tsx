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

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('checking')

  useEffect(() => {
    api
      .session()
      .then((s) => setStatus(s.authenticated ? 'signed-in' : 'signed-out'))
      .catch(() => setStatus('offline'))
  }, [])

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
