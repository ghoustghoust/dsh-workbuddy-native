import * as crypto from 'crypto'
import { REALMS, isRealmId } from './realms.js'
import { config, saveConfig, clientVersionFor } from './config.js'
import { catalogInfo } from './catalog.js'
import { pricingList } from './price.js'
import { freeExhaustedSet, todaySpend } from './guard.js'
import { aggregateToday, readDay } from './ledger.js'
import { ipcStatus } from './wbipc.js'
import { listAccounts, switchAccount, currentAccount, panelToken, isDegraded, credentialStoreMode, credentialStoreError, isUid } from './authstore.js'
import { startLogin, pollLogin } from './login.js'
import { queryBalance } from './balance.js'
import { appendLedger } from './ledger.js'
import { hooks } from './hooks.js'

// Panel API served through the harness web server. The bridge no longer takes
// LLM traffic over HTTP, so this surface exists only for the plugin's own UI.

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
let uiProven = false

function tokenMatches(header, token) {
  const given = Buffer.from(String(header ?? '').replace(/^Bearer /, ''), 'utf8')
  const want = Buffer.from(token, 'utf8')
  return given.length === want.length && crypto.timingSafeEqual(given, want)
}

/**
 * The Host header is not a network control: any local process can send
 * `Host: 127.0.0.1`. The socket peer address is the one that decides whether
 * the caller is actually on this machine.
 */
function localSocket(req) {
  const addr = req.socket?.remoteAddress
  return addr !== undefined && LOOPBACK_IPS.has(addr)
}

function localHost(req) {
  return LOOPBACK_HOSTS.has((req.headers.host ?? '').split(':')[0])
}

function sendJson(res, status, obj, extraHeaders) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, ...extraHeaders })
  res.end(buf)
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  await new Promise((resolve, reject) => {
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', resolve)
    req.on('error', reject)
  })
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} } catch { return {} }
}

// The panel shows a real remaining balance per site, so the summary carries one
// instead of handing the UI a button. The client polls every 30s and the billing
// endpoint is a real upstream call, so results are cached briefly and each
// site's failure is contained: an unreachable billing API must not blank the
// other site's numbers, and must not break /summary itself.
const BALANCE_TTL_MS = 60_000
const balanceCache = new Map() // `${realmId}:${uid}` -> { at, value }

async function cachedBalance(realmId) {
  // The cache key MUST include the account: a balance belongs to one account's
  // token, and after a switch the realm alone would serve the previous
  // account's numbers under the new current account for a full TTL.
  const account = await currentAccount(realmId)
  const key = `${realmId}:${account?.uid ?? 'none'}`
  const hit = balanceCache.get(key)
  if (hit && Date.now() - hit.at < BALANCE_TTL_MS) return hit.value
  let value
  try {
    value = { ok: true, ...(await queryBalance(realmId)) }
  } catch (e) {
    // A failed refresh keeps serving the last good number rather than
    // replacing it with an error: a transient 502 is not a balance of zero.
    value = hit ? { ...hit.value, stale: true } : { ok: false, error: String(e?.message ?? e) }
  }
  balanceCache.set(key, { at: Date.now(), value })
  return value
}

/** Force the next summary read to re-query, so a manual refresh shows the truth. */
export function invalidateBalances() {
  balanceCache.clear()
}

async function summary() {
  const cfg = config()
  const realms = {}
  const realmIds = Object.keys(REALMS)
  // Both sites' billing calls are independent, so they overlap instead of
  // queueing: a slow site must not delay the other site's numbers.
  const balances = await Promise.all(realmIds.map((id) => cachedBalance(id)))
  for (const [i, realmId] of realmIds.entries()) {
    const account = await currentAccount(realmId)
    realms[realmId] = {
      label: REALMS[realmId].label,
      catalog: catalogInfo(realmId),
      pricing: pricingList(realmId, freeExhaustedSet(realmId)),
      spendToday: Math.round(todaySpend(realmId) * 1000) / 1000,
      usage: aggregateToday(realmId),
      account: account ? { uid: account.uid, nickname: account.nickname ?? null, expiresAt: account.expiresAt ?? 0 } : null,
      accounts: await listAccounts(realmId),
      ipc: ipcStatus(realmId),
      clientVersion: clientVersionFor(realmId),
      credentialStore: { mode: credentialStoreMode(realmId), error: credentialStoreError() },
      balance: balances[i],
    }
  }
  const warnings = readDay().filter((e) => e?.event === 'context_warn' || e?.event === 'catalog_error' || e?.event === 'stage_failed').slice(-5)
  return {
    transport: cfg.defaultTransport,
    realms,
    config: cfg,
    credentialsDegraded: isDegraded(),
    panelStore: { mode: credentialStoreMode('panel'), error: credentialStoreError() },
    warnings,
  }
}

export async function createPanelHandler({ refresh } = {}) {  return async function handler(req, res) {
    const full = (req.url ?? '').split('?')[0]
    const query = new URL(req.url ?? '/', 'http://localhost')
    const url = full.startsWith('/workbuddy-native') ? (full.slice('/workbuddy-native'.length) || '/') : full
    const noStore = { 'cache-control': 'no-store' }
    try {
      if (!localSocket(req) || !localHost(req)) return sendJson(res, 403, { error: { message: 'loopback only' } }, noStore)
      const site = req.headers['sec-fetch-site']
      if (site !== undefined && site !== 'same-origin' && site !== 'none') {
        return sendJson(res, 403, { error: { message: 'cross-site requests are not allowed' } }, noStore)
      }

      // The token is resolved per request so it lands in the credential vault
      // once the seam exists instead of being minted into a file at startup.
      const token = await panelToken()

      if (req.method === 'GET' && url === '/bootstrap') {
        // Two legitimate callers exist. A browser page always sends
        // sec-fetch-site and an Origin that must point back at this host.
        // The desktop shell's dsh-app:// proxy forwards panel fetches with
        // sec-fetch-site and Origin stripped and its own session cookie
        // injected — that header shape is what the same UI looks like from the
        // app, and refusing it breaks the panel only in the real client.
        const origin = req.headers.origin
        const originOk = origin === undefined || (() => {
          try { return LOOPBACK_HOSTS.has(new URL(origin).hostname) } catch { return false }
        })()
        const browserPage = site === 'same-origin' && originOk
        // The desktop shell strips sec-fetch headers, so its shape is "no
        // fetch metadata + its session cookie". Requiring the cookie to at
        // least carry a name=value session pair keeps a bare `Cookie:` header
        // from qualifying.
        const cookie = String(req.headers.cookie ?? '')
        const desktopShell = site === undefined && origin === undefined && /[A-Za-z0-9_-]+=\S/.test(cookie)
        if (!browserPage && !desktopShell) {
          // A panel that cannot get its token is otherwise invisible to the
          // user, so record the exact header shape that was refused.
          appendLedger({ event: 'panel_denied', realm: 'cn', stage: 'bootstrap', site: site ?? null, hasCookie: req.headers.cookie !== undefined, origin: origin ?? null })
          return sendJson(res, 403, { error: { message: 'local UI only' } }, noStore)
        }
        // And record once that the real client did get it: without this, a
        // refused and an idle panel look identical from the outside.
        if (!uiProven) {
          uiProven = true
          appendLedger({ event: 'panel_ui_reached', realm: 'cn', via: browserPage ? 'browser' : 'desktop-shell' })
        }
        return sendJson(res, 200, { token }, noStore)
      }

      if (!tokenMatches(req.headers.authorization, token)) {
        return sendJson(res, 401, { error: { message: 'unauthorized' } }, noStore)
      }

      if (req.method === 'GET' && (url === '/summary' || url === '/')) {
        // ?refresh=1 is what a user-initiated reload sends: it must re-query the
        // billing API, while the panel's 30s poll rides the cache.
        if (query.searchParams.get('refresh') === '1') invalidateBalances()
        return sendJson(res, 200, await summary(), noStore)
      }
      if (req.method === 'GET' && url === '/balance') {
        const realmId = query.searchParams.get('realm') ?? 'cn'
        if (!isRealmId(realmId)) return sendJson(res, 400, { error: { message: 'realm must be cn or global' } }, noStore)
        try {
          return sendJson(res, 200, await queryBalance(realmId), noStore)
        } catch (e) {
          return sendJson(res, 502, { error: { message: String(e?.message ?? e) } }, noStore)
        }
      }
      if (req.method === 'POST' && url === '/transport') {
        const body = await readJsonBody(req)
        const mode = String(body.transport ?? '')
        if (mode !== 'direct' && mode !== 'wbipc') return sendJson(res, 400, { error: { message: 'transport must be direct or wbipc' } }, noStore)
        const warnings = []
        if (mode === 'wbipc') {
          for (const id of Object.keys(REALMS)) {
            const status = ipcStatus(id)
            if (!status.online) warnings.push(`${REALMS[id].label} 桌面端未在线：${status.reason ?? '未知原因'}`)
          }
          warnings.push('wbipc 通道有 768KB 请求 / 640KB 响应上限（响应超限会自动分段续写）')
        }
        saveConfig({ defaultTransport: mode })
        appendLedger({ event: 'transport_switch', realm: 'cn', transport: mode })
        return sendJson(res, 200, { ok: true, transport: mode, warnings }, noStore)
      }
      if (req.method === 'POST' && url === '/config') {
        const body = await readJsonBody(req)
        const realmBefore = config().realm
        const result = saveConfig(body)
        if (result.error) return sendJson(res, 400, { error: { message: result.error } }, noStore)
        if (body.realm !== undefined && result.config.realm !== realmBefore) {
          try { hooks.onRealmChanged?.(result.config.realm) } catch { /* refresh loop will still converge */ }
          appendLedger({ event: 'realm_switch', realm: result.config.realm })
        }
        return sendJson(res, 200, { ok: true, config: result.config }, noStore)
      }
      if (req.method === 'POST' && url === '/accounts/switch') {
        const body = await readJsonBody(req)
        if (!isRealmId(body.realm)) return sendJson(res, 400, { error: { message: 'realm must be cn or global' } }, noStore)
        if (!isUid(body.uid)) return sendJson(res, 400, { error: { message: 'uid is not a valid account id' } }, noStore)
        const account = await switchAccount(String(body.realm), String(body.uid))
        if (!account) return sendJson(res, 404, { error: { message: 'no such saved account' } }, noStore)
        // Verify the pointer actually moved: a write that only landed in a
        // degraded local copy while reads resolve elsewhere would otherwise
        // answer "ok" and change nothing the user can see.
        const now = await currentAccount(String(body.realm))
        if (now?.uid !== account.uid) {
          return sendJson(res, 502, { error: { message: '切换未能持久化（凭证存储写入被拒），稍后会自动重试' } }, noStore)
        }
        appendLedger({ event: 'account_switch', realm: account.realm, uid: account.uid })
        invalidateBalances() // the cached balance belongs to the previous account
        refresh?.(`switch:${account.realm}`)?.catch?.(() => {})
        return sendJson(res, 200, { ok: true, uid: account.uid, nickname: account.nickname ?? null }, noStore)
      }
      if (req.method === 'POST' && url === '/login') {
        const body = await readJsonBody(req)
        const realmId = String(body.realm ?? 'cn')
        if (!isRealmId(realmId)) return sendJson(res, 400, { error: { message: 'realm must be cn or global' } }, noStore)
        try {
          return sendJson(res, 200, await startLogin(realmId), noStore)
        } catch (e) {
          return sendJson(res, 502, { error: { message: String(e?.message ?? e) } }, noStore)
        }
      }
      if (req.method === 'GET' && url === '/login/poll') {
        const attemptId = query.searchParams.get('attemptId') ?? ''
        try {
          const result = await pollLogin(attemptId)
          if (result.status === 'ok') {
            invalidateBalances() // the new current account has its own balance
            refresh?.(`login:${result.realm ?? attemptId}`)?.catch?.(() => {})
          }
          return sendJson(res, 200, result, noStore)
        } catch (e) {
          return sendJson(res, 400, { error: { message: String(e?.message ?? e) } }, noStore)
        }
      }
      return sendJson(res, 404, { error: { message: `no route: ${req.method} ${full}` } }, noStore)
    } catch (e) {
      try { sendJson(res, 500, { error: { message: String(e?.message ?? e) } }, noStore) } catch { /* socket gone */ }
    }
  }
}
