import * as crypto from 'crypto'
import { realmOfId } from './realms.js'
import { loginHeaders, threeSegmentUA, stableHeaders } from './headers.js'
import { currentAccount, saveAccount, updateAccountTokens } from './authstore.js'
import { hooks } from './hooks.js'

// Device-authorization login (the flow the official CLI uses) plus token
// refresh. Attempts are keyed by realm + attempt id so two panels logging in
// concurrently cannot overwrite each other.

const REFRESH_WINDOW_MS = 10 * 60 * 1000
const ATTEMPT_TTL_MS = 10 * 60 * 1000

const attempts = new Map() // attemptId -> { realmId, state, startedAt }
const inflight = new Map() // `${realm}:${uid}` -> Promise

export class NeedsLoginError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NeedsLoginError'
    this.needsLogin = true
  }
}

export async function startLogin(realmId) {
  const realm = realmOfId(realmId)
  const res = await fetch(`${realm.chatBase}/v2/plugin/auth/state?platform=CLI`, {
    method: 'POST',
    headers: loginHeaders(realm),
    body: '{}',
    signal: AbortSignal.timeout(20_000),
  })
  const env = await res.json().catch(() => null)
  const state = env?.data?.state
  const authUrl = env?.data?.authUrl
  if (!state || !authUrl) throw new Error(`auth/state failed: HTTP ${res.status}`)
  const attemptId = crypto.randomUUID()
  attempts.set(attemptId, { realmId: realm.id, state, startedAt: Date.now() })
  for (const [id, a] of attempts) if (Date.now() - a.startedAt > ATTEMPT_TTL_MS) attempts.delete(id)
  return { attemptId, authUrl, realm: realm.id }
}

/** @returns {{status:'pending'} | {status:'ok', uid, nickname}} */
export async function pollLogin(attemptId) {
  const attempt = attempts.get(attemptId)
  if (!attempt) throw new Error('no pending login for this attempt (or it expired); start a new login')
  if (Date.now() - attempt.startedAt > ATTEMPT_TTL_MS) {
    attempts.delete(attemptId)
    throw new Error('login attempt timed out; start a new login')
  }
  const realm = realmOfId(attempt.realmId)
  const res = await fetch(`${realm.chatBase}/v2/plugin/auth/token?state=${attempt.state}`, {
    headers: loginHeaders(realm),
    signal: AbortSignal.timeout(20_000),
  })
  const env = await res.json().catch(() => null)
  const tok = env?.data
  if (!res.ok) throw new Error(`auth/token answered HTTP ${res.status}`)
  if (!env || !tok?.accessToken) {
    // The vendor answers a not-yet-scanned code the same way it answers a
    // rejected one, so the code is surfaced to the panel instead of being
    // flattened into "still waiting".
    return { status: 'pending', realm: realm.id, vendorCode: env?.code ?? null, vendorMsg: env?.msg ? String(env.msg).slice(0, 120) : null }
  }

  const account = {
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken ?? '',
    expiresAt: tok.expiresIn ? Date.now() + tok.expiresIn * 1000 : 0,
    domain: tok.domain,
  }
  try {
    const ar = await fetch(`${realm.chatBase}/v2/plugin/login/account?state=${attempt.state}`, {
      headers: { ...loginHeaders(realm), authorization: `Bearer ${account.accessToken}` },
    })
    const aenv = await ar.json().catch(() => null)
    if (aenv?.data?.uid) {
      account.uid = aenv.data.uid
      account.enterpriseId = aenv.data.enterpriseId || undefined
      account.nickname = aenv.data.nickname
    }
  } catch { /* account details are optional */ }

  const saved = await saveAccount(realm.id, account)
  attempts.delete(attemptId)
  hooks.onLoggedIn?.(realm.id)
  return { status: 'ok', realm: realm.id, uid: saved?.uid ?? account.uid, nickname: saved?.nickname ?? account.nickname }
}

async function refreshForce(realmId, account) {
  const realm = realmOfId(realmId)
  const key = `${realmId}:${account.uid ?? 'anon'}`
  const existing = inflight.get(key)
  if (existing) return existing
  const run = (async () => {
    const res = await fetch(`${realm.chatBase}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: {
        ...loginHeaders(realm),
        'user-agent': threeSegmentUA(realm),
        'x-refresh-token': account.refreshToken,
        'x-auth-refresh-source': 'plugin',
        ...(account.enterpriseId ? { 'x-enterprise-id': account.enterpriseId } : {}),
        ...(account.uid ? stableHeaders(account.uid) : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(20_000),
    })
    const env = await res.json().catch(() => null)
    if (!res.ok || !env?.data?.accessToken) {
      throw Object.assign(new Error(`token refresh failed (HTTP ${res.status}) — re-login required`), { needsRelogin: true })
    }
    const patch = { accessToken: env.data.accessToken }
    if (env.data.refreshToken) patch.refreshToken = env.data.refreshToken
    if (env.data.expiresIn) patch.expiresAt = Date.now() + env.data.expiresIn * 1000
    if (account.uid) await updateAccountTokens(realmId, account.uid, patch)
    return { ...account, ...patch }
  })().finally(() => inflight.delete(key))
  inflight.set(key, run)
  return run
}

/** Current account for a realm, refreshed when close to expiry. */
export async function getFreshAccount(realmId) {
  const account = await currentAccount(realmId)
  if (!account) throw new NeedsLoginError(`workbuddy ${realmId} is not logged in`)
  if (account.expiresAt && account.expiresAt - Date.now() < REFRESH_WINDOW_MS && account.refreshToken) {
    return await refreshForce(realmId, account)
  }
  return account
}

/** One-shot recovery path for a 401: force refresh and hand back a usable account. */
export async function recoverAfter401(realmId, account) {
  if (!account?.refreshToken) throw Object.assign(new Error('token rejected and no refresh token stored — re-login required'), { needsRelogin: true })
  return await refreshForce(realmId, account)
}

export function hasCredential(realmId) {
  return currentAccount(realmId).then((a) => Boolean(a?.accessToken))
}
