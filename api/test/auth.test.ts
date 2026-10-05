import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { issueSession, readCookie, SESSION_TTL_MS, verifySession } from '../src/auth'
import { createTestApp, SECRET, TOKEN, type TestApp } from './helpers'

describe('session cookie', () => {
  it('verifies what it issued and rejects tampering and expiry', () => {
    const now = 1_700_000_000_000
    const session = issueSession(SECRET, now)
    expect(verifySession(session, SECRET, now)).toBe(true)
    expect(verifySession(session, 'another-secret-0123456789', now)).toBe(false)
    expect(verifySession(session, SECRET, now + SESSION_TTL_MS + 1)).toBe(false)
    // Pushing the expiry forward without the secret breaks the signature.
    const [expires, mac] = session.split('.')
    expect(verifySession(`${Number(expires) + 1000}.${mac}`, SECRET, now)).toBe(false)
    expect(verifySession(undefined, SECRET, now)).toBe(false)
    expect(verifySession('garbage', SECRET, now)).toBe(false)
  })

  it('reads one cookie out of a Cookie header', () => {
    expect(readCookie('a=1; sb_session=abc.def; b=2', 'sb_session')).toBe('abc.def')
    expect(readCookie('a=1', 'sb_session')).toBeUndefined()
    expect(readCookie(undefined, 'sb_session')).toBeUndefined()
  })
})

describe('api authentication', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await createTestApp()
  })
  afterAll(() => t.close())

  it('leaves the health check open', async () => {
    await t.request.get('/api/health').expect(200, { ok: true })
  })

  it('rejects requests without credentials or with a wrong token', async () => {
    await t.request.get('/api/assets').expect(401)
    await t.request.get('/api/assets').set('Authorization', 'Bearer nope').expect(401)
  })

  it('accepts the bearer token', async () => {
    await t.request.get('/api/assets').set('Authorization', `Bearer ${TOKEN}`).expect(200)
  })

  it('exchanges the token for an http-only session cookie that then authenticates', async () => {
    await t.request.post('/api/session').send({ token: 'wrong' }).expect(401)
    const login = await t.request.post('/api/session').send({ token: TOKEN }).expect(204)
    const cookie = login.headers['set-cookie']![0]!
    expect(cookie).toMatch(/^sb_session=/)
    expect(cookie).toMatch(/HttpOnly/)
    await t.request.get('/api/assets').set('Cookie', cookie.split(';')[0]!).expect(200)
    await t.request.get('/api/assets').set('Cookie', 'sb_session=9999999999999.forged').expect(401)
  })
})
