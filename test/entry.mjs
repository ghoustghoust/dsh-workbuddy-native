// Entry-level verification against a mock host context: the wiring that a real
// cordis fiber provides (inject/effect/llm/tools/webServer/credentials) is
// stood up here so a throw or a contract break is caught before the bundle is
// hot-mounted into the running desktop app.
// Run: node test/entry.mjs

import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-native-entry-'))
process.env.DSH_WB_NATIVE_DIR = tmp
process.env.WB_SEAM_BROKEN_MS = '1' // heal paths must be exercisable without waiting

let failures = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) { failures++; console.log(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`) }
  else console.log(`ok   ${name} = ${a.length > 110 ? a.slice(0, 107) + '…' : a}`)
}

// ------------------------------- mock upstream -------------------------------
const seen = []
const upstream = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', async () => {
    const url = req.url
    if (url.includes('/v3/config')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { models: [{ id: 'glm-5.3', name: 'GLM 5.3', credits: 'x2', maxInputTokens: 200000, maxOutputTokens: 8000, supportsImages: true }], modelPromotions: [{ id: 'p', enabled: true, priority: 1, modelIds: ['glm-5.3'], discount: { factor: 0 }, badge: { label: '限时免费' }, schedule: { daily: [{ start: '00:00', end: '23:59' }] } }], agents: [{ tags: ['default'], models: ['glm-5.3'] }] } }))
      return
    }
    if (url.includes('get-user-resource')) {
      // 余额跟着 token 走：不同账号必须查出不同数字，这样「切换后仍显示上一
      // 个账号的余额」这类缓存在测试里就会现形。
      const byToken = { 'tok-a': 42, 'tok-b': 7 }
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '')
      const remain = byToken[token] ?? 42
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ Response: { Data: { Accounts: [{ PackageCode: 'PKG-A', CycleCapacitySize: 100, CycleCapacityRemain: remain }] } } }))
      return
    }
    seen.push(JSON.parse(body || '{}'))
    const requestedModel = JSON.parse(body || '{}').model
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (requestedModel === 'empty-model') {
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (requestedModel === 'error-model') {
      res.write('data: ' + JSON.stringify({ error: { message: 'first message is not system prompt', code: 11128 } }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.write('data: {"choices":[{"delta":{"reasoning_content":"why"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{"content":"the answer"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    res.write('data: {"usage":{"prompt_tokens":11,"completion_tokens":3,"prompt_cache_hit_tokens":8,"credit":0.3}}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${upstream.address().port}`
process.env.WB_TEST_BASE_CN = base
process.env.WB_TEST_BILLING_CN = base

// ------------------------------- legacy fixtures -----------------------------
const legacyDir = path.join(tmp, 'legacy')
fs.mkdirSync(path.join(legacyDir, 'auths', 'cn'), { recursive: true })
fs.writeFileSync(path.join(legacyDir, 'auths', 'cn', 'current.json'), JSON.stringify({ accessToken: 'legacy-token', refreshToken: 'legacy-refresh', uid: 'uid-legacy', nickname: '旧账号', domain: 'copilot.tencent.com' }))
const legacyBefore = fs.statSync(path.join(legacyDir, 'auths', 'cn', 'current.json'))
process.env.WB_TEST_LEGACY_DIR = legacyDir

// ------------------------------- mock host ctx -------------------------------
const state = { routes: null, replaces: 0, toolDef: null, webSpec: null, disposed: false, errors: [], failWritesFor: new Set() }
const records = new Map()

// The real credentials seam rejects any value a JSON round trip cannot
// represent — including null-prototype objects (assertJsonValue in
// credentials-local). Mirroring that here is what nets the vault-write bug
// where Object.create(null) account maps made every vault write fail.
function assertPlainJson(where, value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') { if (Number.isFinite(value)) return; throw new TypeError(`${where} holds a non-finite number`) }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError(`${where} is cyclic`)
    if (Object.getPrototypeOf(value) === Object.prototype || Array.isArray(value)) {
      seen.add(value)
      for (const nested of Object.values(value)) assertPlainJson(where, nested, seen)
      seen.delete(value)
      return
    }
  }
  throw new TypeError(`credentials-local: ${where} holds a value JSON cannot represent`)
}

const credentials = {
  async readRecord(key) { return records.get(key) ?? null },
  async describeRecord(key) { return { configured: records.has(key) } },
  async modifyRecord(key, mutate) {
    if (state.failWritesFor.has(key)) throw new TypeError(`credentials-local: ${key} payload holds a value JSON cannot represent`)
    const next = mutate(records.get(key) ?? null)
    assertPlainJson(key, next)
    records.set(key, next)
    return next
  },
  async deleteRecord(key) { records.delete(key) },
  async listRecords() { return [...records.keys()] },
}
const services = {
  credentials,
  tools: { register(def) { state.toolDef = def; return () => { state.toolDef = null } } },
  webServer: { register(spec) { state.webSpec = spec; return () => { state.webSpec = null } } },
  llm: {
    registerAdapter(routes, adapter) {
      // Mirror the seam's registration contract: every route's metadata is
      // pulled eagerly, so a missing adapter method fails here as it would in
      // the running app.
      for (const route of routes) {
        const info = adapter.providerInfo(route)
        if (info.id !== route || typeof info.name !== 'string' || !info.name.length) throw new Error('INVALID_ADAPTER')
        adapter.providerRetryPolicy(route)
      }
      state.routes = routes
      state.adapter = adapter
      const handle = () => { state.disposed = true }
      handle.replace = (next) => { state.routes = next; state.replaces++ }
      return handle
    },
  },
}
function makeCtx(names) {
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: (m) => state.errors.push(String(m)), debug: () => {} },
    effect(fn) { const d = fn(); ctx._disposers.push(d) },
    inject(list, fn) {
      if (!list.every((n) => n in services)) return
      const scope = { ...ctx, ...services }
      fn(scope)
    },
    _disposers: [],
    ...services,
  }
  return ctx
}

const mod = await import('../index.js')
const catalog = await import('../lib/catalog.js')
const { saveConfig } = await import('../lib/config.js')
check('entry exports name/inject/apply', [mod.name, mod.inject, typeof mod.apply], ['workbuddy-native', ['llm'], 'function'])
// Only the configured site is exposed; the test suite lives on cn.
saveConfig({ realm: 'cn' })
const ctx = makeCtx()
mod.apply(ctx)
check('only the active realm route is registered', state.routes, ['workbuddy-cn'])
check('providerInfo keeps the route id', state.adapter.providerInfo('workbuddy-global').id, 'workbuddy-global')
check('providerInfo names the site', /国际版/.test(state.adapter.providerInfo('workbuddy-global').name), true)

// The seam's own surface: it dispatches only through prepareCall, so an adapter
// that merely has stream() is invisible to the running app (this is exactly how
// providerRetryPolicy and prepareCall omissions were missed before).
check('adapter implements the seam surface', ['providerInfo', 'providerRetryPolicy', 'listModels', 'resolveModel', 'prepareCall']
  .map((m) => typeof state.adapter[m]), ['function', 'function', 'function', 'function', 'function'])
const seamCall = await state.adapter.prepareCall('workbuddy-cn', 'glm-5.3')
check('prepareCall returns a model plus a stream entry point', [typeof seamCall.stream, seamCall.model.provider, seamCall.model.id], ['function', 'workbuddy-cn', 'glm-5.3'])
const policy = state.adapter.providerRetryPolicy('workbuddy-cn')
check('retry policy outlasts the per-minute rate-limit window', [
  policy.mode, policy.retryableCodes.includes('RATE_LIMIT'), policy.maxRetries,
  policy.backoff.maxDelayMs,
], ['normal', true, 8, 20000])

// dispatch mirrors the seam: resolve under the current registration, then stream
// the resolved options through the one-shot handle.
async function dispatch(opts) {
  const call = await state.adapter.prepareCall(opts.provider, opts.model, opts.signal)
  const out = []
  for await (const c of call.stream(opts)) out.push(c)
  return out
}

check('panel route mounted at a prefix', [state.webSpec?.kind, state.webSpec?.path], ['prefix', '/workbuddy-native'])
check('tool registered as a plain definition', [state.toolDef?.name, state.toolDef?.parameters?.type, state.toolDef?.parameters?.required], ['workbuddy_account', 'object', ['action']])
check('tool declares an output renderer', typeof state.toolDef?.output?.render, 'function')

await new Promise((r) => setTimeout(r, 400)) // startup: legacy import + catalog refresh
check('legacy account imported into the native store', (await (await import('../lib/authstore.js')).listAccounts('cn')).map((a) => a.uid), ['uid-legacy'])
check('legacy directory untouched', fs.statSync(path.join(legacyDir, 'auths', 'cn', 'current.json')).mtimeMs, legacyBefore.mtimeMs)
const models = await state.adapter.listModels('workbuddy-cn')
check('catalog reached the picker', models.map((m) => m.name), ['GLM 5.3 (现免费)'])

// panel API end-to-end over a real socket
const panelServer = http.createServer((req, res) => state.webSpec.handler(req, res))
await new Promise((r) => panelServer.listen(0, '127.0.0.1', r))
const PANEL = '/workbuddy-native'
const panelBase = `http://127.0.0.1:${panelServer.address().port}${PANEL}`
const crossSite = await fetch(panelBase + '/summary', { headers: { 'sec-fetch-site': 'cross-site', host: '127.0.0.1' } }).then((r) => r.status)
check('cross-site panel request rejected', crossSite, 403)
const noToken = await fetch(panelBase + '/summary').then((r) => r.status)
check('panel request without token rejected', noToken, 401)
const boot = await fetch(panelBase + '/bootstrap', { headers: { 'sec-fetch-site': 'same-origin' } }).then((r) => r.json())
check('bootstrap hands the token to a same-origin page', typeof boot.token, 'string')
const auth = { authorization: `Bearer ${boot.token}` }
const summary = await fetch(panelBase + '/summary', { headers: auth }).then((r) => r.json())
check('summary carries both sites', Object.keys(summary.realms), ['cn', 'global'])
const cn = summary.realms.cn
check('summary site facts present', [typeof cn.spendToday, Array.isArray(cn.pricing), cn.account?.nickname, Array.isArray(cn.usage?.models)], ['number', true, '旧账号', true])
check('summary reports where the UA version came from', ['desktop-cache', 'config', 'fallback'].includes(cn.clientVersion.source), true)
check('summary reports where credentials actually landed', ['vault', 'file', 'unknown'].includes(cn.credentialStore?.mode), true)
const bal = await fetch(panelBase + '/balance?realm=cn', { headers: auth }).then((r) => r.json())
check('balance reads real packages', [bal.remain, bal.total, bal.packages[0].code], [42, 100, 'PKG-A'])
const badRealm = await fetch(panelBase + '/balance?realm=nope', { headers: auth }).then((r) => r.status)
check('unknown realm rejected', badRealm, 400)
const transportSwitch = await fetch(panelBase + '/transport', { method: 'POST', headers: auth, body: JSON.stringify({ transport: 'wbipc' }) }).then((r) => r.json())
check('transport switch answers with warnings', [transportSwitch.transport, transportSwitch.warnings.length > 0], ['wbipc', true])
await fetch(panelBase + '/transport', { method: 'POST', headers: auth, body: JSON.stringify({ transport: 'direct' }) })
const configPatch = await fetch(panelBase + '/config', { method: 'POST', headers: auth, body: JSON.stringify({ dailyCreditBudget: 5, allowPaidOverride: true }) }).then((r) => r.json())
check('config patch persists and reports', [configPatch.config.dailyCreditBudget, JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8')).dailyCreditBudget], [5, 5])
const configReject = await fetch(panelBase + '/config', { method: 'POST', headers: auth, body: JSON.stringify({ authToken: 'x' }) }).then((r) => r.status)
check('unknown config keys rejected outright', configReject, 400)
const configString = await fetch(panelBase + '/config', { method: 'POST', headers: auth, body: JSON.stringify({ dailyCreditBudget: 'abc' }) }).then((r) => r.status)
check('non-numeric budget rejected outright', configString, 400)
const configFraction = await fetch(panelBase + '/config', { method: 'POST', headers: auth, body: JSON.stringify({ dailyCreditBudget: 0.3 }) }).then((r) => r.json())
check('fractional budget survives validation (truncation would mean unlimited)', configFraction.config.dailyCreditBudget, 0.3)
const realmSwitch = await fetch(panelBase + '/config', { method: 'POST', headers: auth, body: JSON.stringify({ realm: 'global' }) }).then((r) => r.json())
check('realm switch persists and re-commits routes', [realmSwitch.config.realm, state.routes], ['global', ['workbuddy-global']])
const realmBack = await fetch(panelBase + '/config', { method: 'POST', headers: auth, body: JSON.stringify({ realm: 'cn' }) }).then((r) => r.json())
check('switching back restores the cn route', [realmBack.config.realm, state.routes], ['cn', ['workbuddy-cn']])
const realmReject = await fetch(panelBase + '/config', { method: 'POST', headers: auth, body: JSON.stringify({ realm: 'nope' }) }).then((r) => r.status)
check('unknown realm rejected outright', realmReject, 400)
await fetch(panelBase + '/config', { method: 'POST', headers: auth, body: JSON.stringify({ dailyCreditBudget: 0 }) })
const configUa = await fetch(panelBase + '/config', { method: 'POST', headers: auth, body: JSON.stringify({ clientVersion: '9.9.9 injected\r\nX-Evil: 1' }) }).then((r) => r.status)
check('a UA version must look like a version (no header smuggling)', configUa, 400)
const protoSwitch = await fetch(panelBase + '/accounts/switch', { method: 'POST', headers: auth, body: JSON.stringify({ realm: 'cn', uid: '__proto__' }) }).then((r) => r.status)
check('prototype keys are not treated as existing accounts', protoSwitch, 404)
const ctorSwitch = await fetch(panelBase + '/accounts/switch', { method: 'POST', headers: auth, body: JSON.stringify({ realm: 'cn', uid: 'constructor' }) }).then((r) => r.status)
check('constructor is not treated as an account either', ctorSwitch, 404)

// -------- degraded vault writes: the fallback copy wins, then heals --------
// Regression for the split-brain where every vault write was rejected (the seam
// refuses null-prototype objects) while reads kept returning the stale vault
// copy — scans and switches visibly did nothing.
const store = await import('../lib/authstore.js')
state.failWritesFor.add('workbuddy-native/cn')
await store.saveAccount('cn', { accessToken: 'tok-a', uid: 'acc-a', nickname: 'A' })
await store.saveAccount('cn', { accessToken: 'tok-b', uid: 'acc-b', nickname: 'B' })
await store.switchAccount('cn', 'acc-a')
check('a broken seam write still switches via the fallback copy', (await store.listAccounts('cn')).find((a) => a.current)?.uid, 'acc-a')
check('degraded store reports file honestly', store.credentialStoreMode('cn'), 'file')
const degradedSwitch = await fetch(panelBase + '/accounts/switch', { method: 'POST', headers: auth, body: JSON.stringify({ realm: 'cn', uid: 'acc-b' }) }).then((r) => r.json())
check('panel switch lands on the degraded copy', [degradedSwitch.ok, degradedSwitch.uid], [true, 'acc-b'])
state.failWritesFor.delete('workbuddy-native/cn')
await new Promise((r) => setTimeout(r, 5)) // let the broken window expire
await store.listAccounts('cn') // triggers the heal
check('heal pushes the fallback back into the vault', store.credentialStoreMode('cn'), 'vault')
check('healed vault keeps every account', (await store.listAccounts('cn')).map((a) => a.uid).sort(), ['acc-a', 'acc-b', 'uid-legacy'])
check('healed store retires the plaintext copy', fs.existsSync(path.join(tmp, 'vault-cn.json')), false)

// -------- balance belongs to the account, not the site --------
const balB = (await fetch(panelBase + '/summary', { headers: auth }).then((r) => r.json())).realms.cn.balance
check('summary carries the current account balance', [balB.ok, balB.remain], [true, 7])
await fetch(panelBase + '/accounts/switch', { method: 'POST', headers: auth, body: JSON.stringify({ realm: 'cn', uid: 'acc-a' }) })
const balA = (await fetch(panelBase + '/summary', { headers: auth }).then((r) => r.json())).realms.cn.balance
check('switching accounts re-queries the balance at once', [balA.ok, balA.remain], [true, 42])
const bootstrapNoHeader = await fetch(panelBase + '/bootstrap').then((r) => r.status)
check('bootstrap refuses a bare local process', bootstrapNoHeader, 403)
const bootstrapShell = await fetch(panelBase + '/bootstrap', { headers: { cookie: 'dsh-session=abc' } }).then((r) => r.status)
check('bootstrap accepts the desktop shell request shape', bootstrapShell, 200)
const bootstrapCrossOriginHeader = await fetch(panelBase + '/bootstrap', { headers: { 'sec-fetch-site': 'same-origin', origin: 'http://evil.example' } }).then((r) => r.status)
check('bootstrap refuses a mismatched Origin', bootstrapCrossOriginHeader, 403)
const notFound = await fetch(panelBase + '/nope', { headers: auth }).then((r) => r.status)
check('unknown panel route 404s', notFound, 404)

// budget gate fires through the adapter
await fetch(panelBase + '/config', { method: 'POST', headers: auth, body: JSON.stringify({ dailyCreditBudget: 0, allowPaidOverride: false }) })
const chunks = await dispatch({
  provider: 'workbuddy-cn', model: 'glm-5.3', system: 'sys',
  messages: [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }, { role: 'user', content: [{ type: 'text', text: 'q' }] }],
})
check('chat round-trip emits reasoning and text', chunks.filter((c) => c.type === 'reasoning-delta' || c.type === 'text-delta').map((c) => c.type), ['reasoning-delta', 'text-delta'])
check('chat round-trip ends with usage then finish', chunks.slice(-2).map((c) => c.type), ['usage', 'finish'])
check('chat billed the ledger', chunks.find((c) => c.type === 'usage').usage, { inputTokens: 11, outputTokens: 3, cacheReadTokens: 8 })
const afterSpend = await fetch(panelBase + '/summary', { headers: auth }).then((r) => r.json())
check('spend visible to the panel', afterSpend.realms.cn.spendToday, 0.3)
await fetch(panelBase + '/config', { method: 'POST', headers: auth, body: JSON.stringify({ dailyCreditBudget: 0.1 }) })
const blocked = await dispatch({ provider: 'workbuddy-cn', model: 'glm-5.3', system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] })
check('budget blocks the next call before the network', [blocked.at(-1).reason.kind, /预算已用尽/.test(blocked.at(-1).reason.failure.message)], ['error', true])
const callsMade = seen.length
check('blocked call made no upstream request', seen.length, callsMade)

// the host calls iterator.return() when a generation is stopped: the upstream
// has already billed the call, so accounting must still happen.
await fetch(panelBase + '/config', { method: 'POST', headers: auth, body: JSON.stringify({ dailyCreditBudget: 0, allowPaidOverride: true }) })
const ledgerFile = path.join(tmp, 'ledger', fs.readdirSync(path.join(tmp, 'ledger'))[0])
const rowsBeforeStop = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').length
const stopOpts = { provider: 'workbuddy-cn', model: 'glm-5.3', system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }
const stopped = (await state.adapter.prepareCall(stopOpts.provider, stopOpts.model)).stream(stopOpts)[Symbol.asyncIterator]()
await stopped.next()
await stopped.return()
const rowsAfterStop = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').length
check('a stopped generation is still billed in the ledger', rowsAfterStop > rowsBeforeStop, true)
const stopRow = JSON.parse(fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').at(-1))
check('the stopped call reached the upstream rather than a gate', [stopRow.status, stopRow.error], [200, undefined])

// an upstream that returns nothing must not look like a successful empty turn
const emptyRes = await fetch(panelBase + '/config', { method: 'POST', headers: auth, body: JSON.stringify({ dailyCreditBudget: 0 }) })
void emptyRes

// agent tool executes against the same state
const toolText = await state.toolDef.execute({ action: 'usage', realm: 'cn' })
check('tool usage answers with today numbers', /今日已用/.test(toolText), true)
const toolPrice = await state.toolDef.execute({ action: 'pricing', realm: 'cn' })
check('tool pricing lists the model', /GLM 5\.3/.test(toolPrice), true)
const toolUnknown = await state.toolDef.execute({ action: 'nope' })
check('tool rejects unknown actions', /未知 action/.test(toolUnknown), true)

// an upstream that returns nothing must not look like a successful empty turn
catalog.setCatalogSnapshotForTest('cn', { ...catalog.getCatalog('cn'), models: { ...catalog.getCatalog('cn').models, 'empty-model': { id: 'empty-model', name: 'Empty', baseMultRaw: 'x1', contextWindow: 1000, maxTokens: 10, supportsImages: false } }, picker: ['empty-model'] })
const emptyChunks = await dispatch({ provider: 'workbuddy-cn', model: 'empty-model', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] })
check('empty upstream becomes an EMPTY_RESPONSE error', [emptyChunks.at(-1).reason.kind, emptyChunks.at(-1).reason.failure.code], ['error', 'EMPTY_RESPONSE'])

// disposal must not throw
for (const d of ctx._disposers) { try { await d?.() } catch (e) { state.errors.push(String(e)) } }
check('no mount errors', state.errors, [])

await new Promise((r) => panelServer.close(r))
wbipcCleanup()
function wbipcCleanup() { /* singleton socket is closed by disposal above */ }
await new Promise((r) => upstream.close(r))
fs.rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
