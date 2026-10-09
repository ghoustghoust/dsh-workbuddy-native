// Transport + adapter verification against local stand-ins:
//   · a mock WorkBuddy upstream (direct transport, real SSE streaming)
//   · a mock desktop IPC broker (wbipc handshake, RPC, over-limit continuation)
//   · the adapter's StreamChunk protocol (block lifecycle, usage, finish)
// Run: node test/transports.mjs

import * as fs from 'fs'
import * as http from 'http'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-native-tx-'))
process.env.DSH_WB_NATIVE_DIR = tmp

let failures = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) { failures++; console.log(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`) }
  else console.log(`ok   ${name} = ${a.length > 110 ? a.slice(0, 107) + '…' : a}`)
}

// ---------------------------------------------------------------- mock upstream
const upstreamRequests = []
function sseLines(res, arr) {
  for (const l of arr) res.write(`data: ${JSON.stringify(l)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}
const upstream = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    upstreamRequests.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') })
    if (req.url === '/v2/plugin/auth/token/refresh') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { accessToken: 'fresh-token', refreshToken: 'fresh-refresh', expiresIn: 3600 } }))
      return
    }
    const model = JSON.parse(body || '{}').model
    if (model === 'error-model') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 11128, msg: 'first message is not system prompt' }))
      return
    }
    if (model === 'rate-limited-model') {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 6004, msg: 'rate limited' }))
      return
    }
    if (model === 'server-error-model') {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 500, msg: 'upstream exploded' }))
      return
    }
    if (model === '401-model') {
      if (upstreamRequests.length === 1) { res.writeHead(401).end('{}'); return }
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    sseLines(res, [
      { choices: [{ delta: { reasoning_content: 'think-1' } }] },
      { choices: [{ delta: { reasoning_content: 'think-2' } }] },
      { choices: [{ delta: { content: 'hello' } }] },
      { choices: [{ delta: { content: ' world' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'lookup', arguments: '{"q":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"tok"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { usage: { prompt_tokens: 120, completion_tokens: 30, completion_thinking_tokens: 12, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20, credit: 0.7 } },
    ])
  })
})
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`

// Point the cn realm at the stand-in (test hook, read by realms.js).
process.env.WB_TEST_BASE_CN = upstreamBase
process.env.WB_TEST_BILLING_CN = upstreamBase

const realms = await import('../lib/realms.js')
const authstore = await import('../lib/authstore.js')
const catalog = await import('../lib/catalog.js')
const { saveConfig } = await import('../lib/config.js')
const { streamDirect } = await import('../lib/direct.js')
const { buildChatBody } = await import('../lib/upstream.js')
const adapterMod = await import('../lib/adapter.js')
const wbipcMod = await import('../lib/wbipc.js')

// in-memory credential seam, so the native-store path is the one under test
const records = new Map()
authstore.attachCredentials({
  async readRecord(key) { return records.get(key) ?? null },
  async describeRecord(key) { return { configured: records.has(key) } },
  async modifyRecord(key, mutate) { const next = mutate(records.get(key) ?? null); records.set(key, next); return next },
  async deleteRecord(key) { records.delete(key) },
  async listRecords() { return [...records.keys()] },
})
await authstore.saveAccount('cn', { accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: 0, uid: 'u-test', nickname: '测试账号', domain: 'd' })

// seed a catalog for cn
const realFetch = globalThis.fetch
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/v3/config')) {
    return { ok: true, status: 200, json: async () => ({ data: { models: [{ id: 'glm-5.3', name: 'GLM 5.3', credits: 'x2', maxInputTokens: 200000, maxOutputTokens: 8000, supportsImages: true }], modelPromotions: [], agents: [{ tags: ['default'], models: ['glm-5.3'] }] } }) }
  }
  return realFetch(url, opts)
}
saveConfig({ dailyCreditBudget: 0, perRequestCreditBudget: 0, contextWarnTokens: 0 })
await catalog.refreshCatalog('cn', { accessToken: 'test-access', uid: 'u-test' })

// ---------------------------------------------------------------- direct test
const options = {
  provider: 'workbuddy-cn',
  model: 'glm-5.3',
  system: 'be brief',
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ],
  tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } }],
}
const body = await buildChatBody(options, catalog.modelMeta('cn', 'glm-5.3'), {})
const directEvents = []
for await (const ev of streamDirect('cn', JSON.stringify(body), undefined)) directEvents.push(ev)
check('direct events types in order', directEvents.map((e) => e.type), ['reasoning', 'reasoning', 'text', 'text', 'toolcall', 'toolcall', 'finish', 'usage'])
check('direct sent three-segment UA', /^WorkBuddy\/\d+\.\d+\.\d+ /.test(upstreamRequests[0].headers['user-agent']), true)
check('direct sent bearer', upstreamRequests[0].headers.authorization, 'Bearer test-access')
check('direct forced stream + usage', [upstreamRequests[0].body.stream, upstreamRequests[0].body.stream_options.include_usage], [true, true])

// ---------------------------------------------------------------- adapter chunks
const adapter = adapterMod.createAdapter()

// Mirror the seam's real dispatch path: prepareCall resolves the model under the
// current registration, then the returned handle streams the resolved options.
async function dispatch(target, opts) {
  const call = await target.prepareCall(opts.provider, opts.model, opts.signal)
  const out = []
  for await (const c of call.stream(opts)) out.push(c)
  return out
}

const info = await adapter.listModels('workbuddy-cn')
check('adapter listModels carries provider', [info[0].provider, info[0].id], ['workbuddy-cn', 'glm-5.3'])
const resolved = await adapter.resolveModel('workbuddy-cn', 'glm-5.3')
check('adapter resolveModel context', [resolved.context.contextWindow, resolved.defaultMaxTokens, resolved.name], [200000, 8000, 'GLM 5.3 (x2)'])
const chunks = await dispatch(adapter, options)
check('chunk sequence puts usage before the single finish', chunks.map((c) => c.type), ['block-start', 'reasoning-delta', 'reasoning-delta', 'block-end', 'block-start', 'text-delta', 'text-delta', 'block-end', 'block-start', 'tool-call-delta', 'tool-call-delta', 'block-end', 'usage', 'finish'])
check('exactly one finish chunk', chunks.filter((c) => c.type === 'finish').length, 1)
check('reasoning block closed with full text', chunks[3].block, { type: 'reasoning', text: 'think-1think-2' })
check('text block closed with full text', chunks.find((c) => c.type === 'block-end' && c.block.type === 'text').block, { type: 'text', text: 'hello world' })
const toolEnd = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
check('tool-call arguments reassembled', [toolEnd.block.id, toolEnd.block.name, toolEnd.block.arguments], ['call_9', 'lookup', '{"q":"tok"}'])
check('finish reason kind', chunks.find((c) => c.type === 'finish').reason, { kind: 'tool-calls' })
check('usage mapped to harness fields', chunks.find((c) => c.type === 'usage').usage, { inputTokens: 120, outputTokens: 30, cacheReadTokens: 100, reasoningTokens: 12 })
const ledgerFile = path.join(tmp, 'ledger', fs.readdirSync(path.join(tmp, 'ledger'))[0])
const ledgerLines = fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const billed = ledgerLines.filter((l) => l.event === 'request')
check('adapter billed the call in the ledger', [billed.length, billed[0].usage.credit, billed[0].status], [1, 0.7, 200])
check('ledger carries thinking tokens', billed[0].usage.completion_thinking_tokens, 12)

// unknown model must fail before any network call
const before = upstreamRequests.length
const badChunks = await dispatch(adapter, { ...options, model: 'not-in-catalog' })
check('unknown model yields terminal error finish', badChunks.at(-1).reason.kind, 'error')
check('unknown model made no upstream call', upstreamRequests.length, before)

// upstream HTTP error becomes a terminal error finish
await dispatch(adapter, { ...options, model: 'glm-5.3', messages: options.messages, system: 'x' })
const httpErr = await (async () => {
  const b2 = await buildChatBody({ ...options, model: 'error-model' }, { maxTokens: 100 }, {})
  try { for await (const _ of streamDirect('cn', JSON.stringify(b2), undefined)) { /* drain */ } return 'no-error' } catch (e) { return e.code }
})()
check('non-SSE error surfaces as coded error', httpErr, 'UPSTREAM_HTTP')
// Rate limits and server faults map into the harness's retryable vocabulary, so
// the default policy backs off instead of hammering (the 2026-10-09 429 storm).
const statusOf = async (model) => {
  const b = await buildChatBody({ ...options, model }, { maxTokens: 64 }, {})
  try { for await (const _ of streamDirect('cn', JSON.stringify(b), undefined)) { /* drain */ } return 'no-error' } catch (e) { return e.code }
}
check('429 maps to the retryable RATE_LIMIT code', await statusOf('rate-limited-model'), 'RATE_LIMIT')
check('5xx maps to the retryable SERVER code', await statusOf('server-error-model'), 'SERVER')
// 智能建议：限流耗尽后，错误文案给出同站点未受限的替代模型（路线 3）。
catalog.setCatalogSnapshotForTest('cn', {
  ...catalog.getCatalog('cn'),
  models: { ...catalog.getCatalog('cn').models, 'rate-limited-model': { id: 'rate-limited-model', name: 'Limited', baseMultRaw: 'x1', contextWindow: 100000, maxTokens: 8000, supportsImages: false } },
  picker: [...catalog.getCatalog('cn').picker, 'rate-limited-model'],
})
const limitedChunks = await dispatch(adapter, { ...options, model: 'rate-limited-model' })
const limitedMsg = limitedChunks.find((c) => c.type === 'finish').reason.failure.message
check('rate-limit failure suggests alternatives', [/可切换：/.test(limitedMsg), /GLM 5\.3/.test(limitedMsg), /换回/.test(limitedMsg)], [true, true, true])

// ------------------------------------------------------- mock wbipc + continuation
const pipeName = `\\\\.\\pipe\\wb-native-test-${process.pid}`
const cfgDir = path.join(tmp, 'desktop-config')
fs.mkdirSync(path.join(cfgDir, 'wbipc'), { recursive: true })
fs.writeFileSync(path.join(cfgDir, 'wbipc', 'endpoint.json'), JSON.stringify({ endpoint: pipeName, ticket: 'ticket-for-test' }))
process.env.WORKBUDDY_CONFIG_DIR = cfgDir

const brokerRequests = []
let brokerMode = 'truncate' // 'truncate' | 'inline-limit' | 'plain'
function sseText(parts, finishReason) {
  return parts.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('')
    + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`
    + `data: ${JSON.stringify({ usage: { prompt_tokens: 50, completion_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 50, credit: 0.1 } })}\n\n`
    + 'data: [DONE]\n\n'
}
const broker = net.createServer((sock) => {
  let buf = Buffer.alloc(0)
  sock.on('data', async (d) => {
    buf = Buffer.concat([buf, d])
    let idx
    while ((idx = buf.indexOf(10)) >= 0) {
      const line = buf.subarray(0, idx).toString('utf8')
      buf = buf.subarray(idx + 1)
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.type === 'session_hello') { sock.write(JSON.stringify({ type: 'session_challenge', server_nonce: 'server-nonce-1' }) + '\n'); continue }
      if (msg.type === 'session_prove') { sock.write(JSON.stringify({ type: 'session_hello_ack' }) + '\n'); continue }
      if (msg.method === 'broker/GetPipe') { sock.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { channel: 'wb.request' } }) + '\n'); continue }
      if (msg.method === 'wb.request/http.fetch') {
        const body = JSON.parse(Buffer.from(msg.params.body_b64, 'base64').toString('utf8'))
        brokerRequests.push(body)
        if (brokerMode === 'inline-limit' && brokerRequests.length === 1) {
          sock.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'response exceeds inline limit of 655360 bytes' } }) + '\n')
          continue
        }
        const first = brokerRequests.length === 1
        const text = first
          ? sseText([{ choices: [{ delta: { content: 'part one ' } }] }], 'length')
          : sseText([{ choices: [{ delta: { content: brokerMode === 'inline-limit' ? 'resumed tail' : 'part two' } }] }], 'stop')
        sock.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 200, headers: { 'content-type': 'text/event-stream' }, body_b64: Buffer.from(text, 'utf8').toString('base64') } }) + '\n')
        continue
      }
      sock.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'mock: unknown method ' + msg.method } }) + '\n')
    }
  })
})
await new Promise((r) => broker.listen(pipeName, r))

await dispatch(adapter, options)

async function runWbipc() {
  return dispatch(adapterMod.createAdapter(), { ...options })
}

saveConfig({ defaultTransport: 'wbipc' })
brokerRequests.length = 0
brokerMode = 'truncate'
const trunc = await runWbipc()
check('wbipc caps each segment so the broker never refuses it', brokerRequests[0].max_tokens, 8000)
check('wbipc continuation issued a second request', brokerRequests.length, 2)
check('second request carries the received text as assistant prefix', brokerRequests[1].messages.at(-2), { role: 'assistant', content: 'part one ' })
check('second request asks to continue', /Continue exactly where you stopped/.test(brokerRequests[1].messages.at(-1).content), true)
check('caller sees exactly one finish', trunc.filter((c) => c.type === 'finish').length, 1)
const truncText = trunc.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
check('continued text arrives as one stream', truncText, 'part one part two')

brokerRequests.length = 0
brokerMode = 'inline-limit'
const lim = await runWbipc()
check('inline-limit refusal shrinks the next attempt instead of failing', brokerRequests.length, 2)
check('shrunk segment budget', [brokerRequests[0].max_tokens, brokerRequests[1].max_tokens], [8000, 4000])
check('inline-limit run still delivers the answer', lim.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), 'resumed tail')
check('inline-limit run ends with one finish', lim.filter((c) => c.type === 'finish').length, 1)

// --------------------------------------- tool-sequence normalization (11133)
// The upstream answers 400 code 11133 unless every assistant tool_calls batch is
// immediately followed by its results, with unique non-empty ids. Whatever the
// harness history contains, buildChatBody must emit a legal sequence.
const tc = (id, args) => ({ type: 'tool-call', id, name: 'lookup', arguments: args })
const tr = (id, text) => ({ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text }] })
const shape = (blocks, role = 'user') => ({ role, content: blocks })
const history = {
  provider: 'workbuddy-cn',
  model: 'glm-5.3',
  system: 'sys',
  messages: [
    shape([{ type: 'text', text: 'run two lookups' }]),
    shape([tc('call_1', '{"q":"a"}'), tc('call_1', ' more')], 'assistant'), // duplicate id, split args
    shape([{ type: 'text', text: 'a mid-stream note' }]), // interleaved between call and result
    shape([tr('call_1', 'result-a')]),
    shape([tc('', '{"q":"b"}')], 'assistant'), // empty id
    shape([tr('', 'result-b')]),
    shape([tr('call_ghost', 'orphan output')]), // orphan result
    shape([tc('call_2', '{"q":"c"}')], 'assistant'), // never answered
  ],
}
const norm = await buildChatBody(history, catalog.modelMeta('cn', 'glm-5.3'), {})
function assertToolSequence(body) {
  const problems = []
  const rows = body.messages
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.role === 'assistant' && row.tool_calls?.length) {
      const ids = row.tool_calls.map((t) => t.id)
      if (ids.some((x) => !x)) problems.push('empty tool_call id')
      if (new Set(ids).size !== ids.length) problems.push('duplicate tool_call ids')
      const results = rows.slice(i + 1)
      const covered = new Set()
      for (let j = 0; j < results.length; j++) {
        const next = results[j]
        if (next.role !== 'tool') { problems.push(`non-tool row interleaved at +${j + 1}`); break }
        covered.add(next.tool_call_id)
        if (j + 1 >= results.length || results[j + 1].role !== 'tool') {
          if (covered.size !== ids.length) problems.push('results do not cover the batch')
          break
        }
      }
      i += Math.max(covered.size, 1)
    }
  }
  return problems
}
check('normalized sequence passes the tool adjacency invariant', assertToolSequence(norm), [])
const mergedCall = norm.messages.flatMap((m) => m.tool_calls ?? []).find((t) => t.id === 'call_1')
check('duplicate call blocks merged with their split arguments', mergedCall.function.arguments, '{"q":"a"} more')
const orphanRow = norm.messages.find((m) => m.role === 'user' && String(m.content).startsWith('[工具结果]'))
check('orphan result survives as user text', /orphan output/.test(orphanRow?.content ?? ''), true)
const unanswered = norm.messages.filter((m) => m.role === 'tool' && m.tool_call_id === 'call_2')
check('unanswered call gets a placeholder result', unanswered.map((r) => r.content), ['(no result)'])

// request over the 768KB frame budget must fail before touching the broker
saveConfig({ defaultTransport: 'direct' })
wbipcMod.wbipc.drop()
await new Promise((r) => broker.close(r))
await new Promise((r) => upstream.close(r))
fs.rmSync(tmp, { recursive: true, force: true })

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
