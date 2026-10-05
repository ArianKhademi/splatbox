import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Demo-grade auth, deliberately minimal: one shared API token from the environment.
 * Scripts send it as `Authorization: Bearer <token>`. The web app exchanges it once for a session
 * cookie (an expiry timestamp plus an HMAC of it), so the token is never kept in browser storage.
 * There are no users, roles, or per-asset permissions.
 */

export const SESSION_COOKIE = 'sb_session'
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000

function safeEqual(a: string, b: string): boolean {
  // Hash both sides first: timingSafeEqual needs equal lengths, and this hides the length too.
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

export function tokenMatches(given: string | undefined, expected: string): boolean {
  return given !== undefined && safeEqual(given, expected)
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

/** `<expiry ms>.<hmac of expiry>`: nothing to store server-side, and it cannot be forged or extended. */
export function issueSession(secret: string, now = Date.now()): string {
  const expires = String(now + SESSION_TTL_MS)
  return `${expires}.${sign(expires, secret)}`
}

export function verifySession(value: string | undefined, secret: string, now = Date.now()): boolean {
  if (!value) return false
  const dot = value.indexOf('.')
  if (dot < 1) return false
  const expires = value.slice(0, dot)
  if (!safeEqual(value.slice(dot + 1), sign(expires, secret))) return false
  return Number(expires) > now
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

export function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
}
