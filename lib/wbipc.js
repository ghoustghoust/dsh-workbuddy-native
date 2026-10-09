import * as fs from 'fs'
import * as net from 'net'
import * as crypto from 'crypto'
import * as os from 'os'
import * as path from 'path'
import { REALMS, realmOfId } from './realms.js'

// Transport through the locally running WorkBuddy desktop app: the app signs
// the request with its own session, so this plugin stores no credential for it.
// The broker caps one JSON-RPC frame at 1 MiB with a base64 body (4/3
// expansion), hence the request/response ceilings below.

export const WBIPC_REQUEST_LIMIT = 768 * 1024
export const WBIPC_RESPONSE_LIMIT = 640 * 1024
const RPC_TIMEOUT_MS = 300_000
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

function pinnedDir() {
  return process.env.WORKBUDDY_CONFIG_DIR || process.env.CODEBUDDY_CONFIG_DIR || null
}

/**
 * A pinned directory that clearly belongs to the *other* site would answer a
 * global request from the cn account while the ledger recorded it as global,
 * so that combination is refused. Any other pinned path is honoured but stays
 * visible in the panel, because it applies to both sites at once.
 */
export function ipcStatus(realmId) {
  const realm = realmOfId(realmId)
  const other = realm.id === 'cn' ? REALMS.global : REALMS.cn
  const pinned = pinnedDir()
  if (pinned && pinned.endsWith(other.configDir)) {
    return { online: false, pinned: true, dir: pinned, reason: `WORKBUDDY_CONFIG_DIR 指向${other.label}，${realm.label} 不能共用它` }
  }
  const dir = pinned ?? path.join(os.homedir(), realm.configDir)
  const file = path.join(dir, 'wbipc', 'endpoint.json')
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!info?.endpoint || !info?.ticket) return { online: false, reason: 'endpoint.json missing endpoint/ticket', dir, pinned: pinned !== null }
    if (typeof info.endpoint !== 'string' || !(info.endpoint.startsWith('\\\\.\\pipe\\') || info.endpoint.startsWith('/'))) {
      return { online: false, reason: 'endpoint.json carries an unexpected endpoint shape', dir, pinned: pinned !== null }
    }
    return { online: true, dir, pinned: pinned !== null }
  } catch (e) {
    return { online: false, reason: e?.message ?? String(e), dir, pinned: pinned !== null }
  }
}

function transcriptBuffer(side, t) {
  const parts = [side, String(t.protocol), t.endpoint, t.clientNonce, t.serverNonce]
  const chunks = []
  for (const p of parts) {
    const b = Buffer.from(p, 'utf8')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(b.length, 0)
    chunks.push(len, b)
  }
  return Buffer.concat(chunks)
}

function hmacProof(key, side, t) {
  return crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(transcriptBuffer(side, t)).digest('base64url')
}

class WbipcClient {
  constructor(realmId) {
    this.realmId = realmId
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.rpcId = 0
    this.pending = new Map()
    this.connectPromise = null
    this.ready = false
    this.channel = ''
    this.clientNonce = ''
    this.helloDone = null
    this.helloFail = null
  }

  async ensure() {
    if (this.ready && this.socket && !this.socket.destroyed) return
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this.connect().finally(() => { this.connectPromise = null })
    return this.connectPromise
  }

  async connect() {
    const status = ipcStatus(this.realmId)
    if (!status.online) throw new Error(status.reason ?? 'WorkBuddy desktop app is not reachable')
    const info = JSON.parse(fs.readFileSync(path.join(status.dir, 'wbipc', 'endpoint.json'), 'utf8'))
    this.drop()
    await new Promise((resolve, reject) => {
      const sock = net.connect({ path: info.endpoint })
      sock.once('error', (e) => { sock.destroy(); reject(new Error(`wbipc connect failed: ${e.message}`)) })
      sock.once('connect', () => resolve())
      this.attach(sock, info)
    })
    await this.handshake(info)
    const res = await this.call('broker/GetPipe', { pipe: 'wb.request' })
    this.channel = res.channel
    this.ready = true
  }

  attach(sock, info) {
    this.socket = sock
    this.buffer = Buffer.alloc(0)
    sock.setNoDelay(true)
    sock.on('data', (d) => {
      this.buffer = this.buffer.length === 0 ? d : Buffer.concat([this.buffer, d])
      if (this.buffer.length > MAX_BUFFERED_BYTES) {
        this.drop() // a peer that never terminates a line is not worth buffering for
        return
      }
      for (;;) {
        const idx = this.buffer.indexOf(10)
        if (idx < 0) return
        const line = this.buffer.subarray(0, idx)
        this.buffer = this.buffer.subarray(idx + 1)
        if (line.length === 0) continue
        let frame
        try { frame = JSON.parse(line.toString('utf8')) } catch { this.drop(); return }
        this.onFrame(frame, info)
      }
    })
    // Only the socket that is still current may tear the client down: a
    // superseded connection's close event must not kill the live one.
    sock.on('error', () => { if (this.socket === sock) this.drop() })
    sock.on('close', () => { if (this.socket === sock) this.drop() })
  }

  drop() {
    this.ready = false
    this.channel = ''
    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.destroy()
      this.socket = null
    }
    const err = new Error('wbipc connection closed')
    this.helloFail?.(err)
    this.helloDone = null
    this.helloFail = null
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  send(obj) {
    if (!this.socket || this.socket.destroyed) throw new Error('wbipc not connected')
    this.socket.write(JSON.stringify(obj) + '\n')
  }

  onFrame(frame, info) {
    if (frame.type === 'session_challenge') {
      const t = { protocol: 1, endpoint: info.endpoint, clientNonce: this.clientNonce, serverNonce: frame.server_nonce }
      this.send({ type: 'session_prove', client_proof: hmacProof(info.ticket, 'wbipc-c', t) })
      return
    }
    if (frame.type === 'session_hello_error') {
      this.helloFail?.(new Error(`wbipc hello rejected: ${frame.code}`))
      this.helloDone = null
      this.helloFail = null
      this.drop()
      return
    }
    if (frame.type === 'session_hello_ack') {
      this.helloDone?.()
      this.helloDone = null
      this.helloFail = null
      return
    }
    if (frame.jsonrpc === '2.0' && frame.id !== undefined) {
      const p = this.pending.get(frame.id)
      if (!p) return
      if (frame.error) p.reject(Object.assign(new Error(frame.error.message || 'wbipc rpc error'), { code: frame.error.code }))
      else p.resolve(frame.result)
    }
  }

  handshake(info) {
    this.clientNonce = crypto.randomBytes(32).toString('base64url')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.helloDone = null
        this.helloFail = null
        this.drop() // never leave an unacknowledged socket attached
        reject(new Error('wbipc handshake timeout'))
      }, 5000)
      this.helloDone = () => { clearTimeout(timer); resolve() }
      this.helloFail = (e) => { clearTimeout(timer); reject(e) }
      try {
        this.send({
          type: 'session_hello',
          protocol_min: 1,
          protocol_max: 1,
          client_nonce: this.clientNonce,
          ticket_id: crypto.createHash('sha256').update(info.ticket, 'utf8').digest('hex').slice(0, 16),
          client: { kind: 'dsh-plugin', id: 'workbuddy-native', version: '0.1.0' },
        })
      } catch (e) {
        clearTimeout(timer)
        this.helloDone = null
        this.helloFail = null
        reject(e)
      }
    })
  }

  /** An RPC that cannot hang: it settles on reply, on abort, on timeout, or on drop. */
  call(method, params, { signal, timeoutMs = RPC_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.rpcId
      const entry = { resolve, reject }
      this.pending.set(id, entry)
      const settle = (fn) => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        fn()
      }
      const onAbort = () => settle(() => reject(Object.assign(new Error('wbipc call aborted'), { code: 'ABORTED' })))
      const timer = setTimeout(() => settle(() => reject(Object.assign(new Error(`wbipc call timed out after ${timeoutMs}ms`), { code: 'WBIPC_TIMEOUT' }))), timeoutMs)
      signal?.addEventListener?.('abort', onAbort, { once: true })
      entry.resolve = (value) => settle(() => resolve(value))
      entry.reject = (err) => settle(() => reject(err))
      try {
        this.send({ jsonrpc: '2.0', id, method, params, mode: 'call' })
      } catch (e) {
        settle(() => reject(e))
      }
    })
  }

  async httpFetch(opts) {
    await this.ensure()
    const params = { method: opts.method, path: opts.path }
    if (opts.headers) params.headers = opts.headers
    if (opts.body) params.body_b64 = opts.body.toString('base64')
    const res = await this.call(`${this.channel}/http.fetch`, params, { signal: opts.signal })
    return { status: res.status, headers: res.headers, body: Buffer.from(res.body_b64, 'base64') }
  }
}

// One client per site: a shared singleton would let a cn connection answer a
// global request (and vice versa) whenever the two overlapped.
const clients = new Map()

function clientFor(realmId) {
  const key = realmOfId(realmId).id
  let client = clients.get(key)
  if (!client) {
    client = new WbipcClient(key)
    clients.set(key, client)
  }
  return client
}

export const wbipc = {
  httpFetch: (realmId, opts) => clientFor(realmId).httpFetch(opts),
  drop: () => { for (const c of clients.values()) c.drop() },
}

export function closeAllWbipc() {
  for (const c of clients.values()) c.drop()
  clients.clear()
}

export const MAX_CONTINUATIONS = 3
// The broker refuses an inline response above its cap without handing back any
// partial text, so there is nothing to resume from in that case. The fix is to
// never ask for a response that big: each segment is capped, a `length` finish
// resumes from what arrived, and a refusal shrinks the next attempt.
export const WBIPC_SEGMENT_TOKENS = 8000
export const WBIPC_MIN_SEGMENT_TOKENS = 500

function sumUsage(total, next) {
  if (!next) return total
  if (!total) return { ...next }
  return {
    prompt_tokens: (total.prompt_tokens ?? 0) + (next.prompt_tokens ?? 0),
    completion_tokens: (total.completion_tokens ?? 0) + (next.completion_tokens ?? 0),
    completion_thinking_tokens: (total.completion_thinking_tokens ?? 0) + (next.completion_thinking_tokens ?? 0),
    prompt_cache_hit_tokens: (total.prompt_cache_hit_tokens ?? 0) + (next.prompt_cache_hit_tokens ?? 0),
    prompt_cache_miss_tokens: (total.prompt_cache_miss_tokens ?? 0) + (next.prompt_cache_miss_tokens ?? 0),
    credit: (total.credit ?? 0) + (next.credit ?? 0),
  }
}

/**
 * One chat call relayed by the desktop app, with over-limit continuation.
 * Every segment is a real billed call, so `beforeSegment` re-runs the budget
 * gates and usage is summed across segments. The caller sees one uninterrupted
 * event stream with a single terminal finish.
 */
export async function* streamWbipc(realmId, { options, meta, attachments, maxTokens, beforeSegment }) {
  const { buildChatBody, sseEventsFromText } = await import('./upstream.js')
  const client = clientFor(realmId)
  let collectedText = ''
  let capTokens = Math.min(maxTokens ?? meta?.maxTokens ?? WBIPC_SEGMENT_TOKENS, meta?.maxTokens || WBIPC_SEGMENT_TOKENS, WBIPC_SEGMENT_TOKENS)
  let pendingFinish = null
  let usage = null
  let attempts = 0
  let continuations = 0

  while (attempts < MAX_CONTINUATIONS + 4) {
    attempts++
    const body = await buildChatBody(options, meta, {
      attachments,
      maxTokens: capTokens,
      continuation: collectedText || null,
    })
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    if (payload.length > WBIPC_REQUEST_LIMIT) {
      throw Object.assign(new Error(`request ${payload.length} B exceeds the WorkBuddy IPC limit (${WBIPC_REQUEST_LIMIT} B)`), {
        code: 'PAYLOAD_TOO_LARGE',
        hint: 'shrink or remove images, shorten the context, or switch the transport to direct',
      })
    }
    if (attempts > 1) await beforeSegment?.()
    let result
    try {
      result = await client.httpFetch({
        method: 'POST',
        path: '/v2/chat/completions',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: payload,
        signal: options.signal,
      })
    } catch (e) {
      const msg = String(e?.message ?? e)
      if (!msg.includes('response exceeds inline limit')) throw e
      if (collectedText && continuations < MAX_CONTINUATIONS) {
        continuations++
        continue // resume from the text that did arrive
      }
      if (capTokens > WBIPC_MIN_SEGMENT_TOKENS) {
        capTokens = Math.max(WBIPC_MIN_SEGMENT_TOKENS, Math.floor(capTokens / 2))
        continue // ask for a smaller answer instead of a refused one
      }
      throw Object.assign(new Error(`model output exceeded the ${WBIPC_RESPONSE_LIMIT} B single-response IPC limit after ${continuations} continuation(s)`), {
        code: 'RESPONSE_TOO_LARGE',
        hint: 'retry, switch to a lighter model, split the task, or switch the transport to direct',
      })
    }

    if (result.status !== 200) {
      // Same vocabulary as the direct transport so the harness's backoff
      // treats a rate-limited broker path identically.
      const { transportCodeFor } = await import('./direct.js')
      throw Object.assign(new Error(`workbuddy upstream answered HTTP ${result.status}`), { code: transportCodeFor(result.status), status: result.status })
    }
    for (const ev of sseEventsFromText(result.body.toString('utf8'))) {
      if (ev.type === 'text') collectedText += ev.text
      else if (ev.type === 'usage') { usage = sumUsage(usage, ev.usage); continue }
      else if (ev.type === 'finish') { pendingFinish = ev; continue } // emitted once, at the end
      yield ev
    }
    if (pendingFinish?.reason === 'length' && collectedText && continuations < MAX_CONTINUATIONS) {
      continuations++
      pendingFinish = null
      continue // the answer was cut by our segment budget: keep going from here
    }
    if (usage) yield { type: 'usage', usage }
    yield pendingFinish ?? { type: 'finish', reason: 'stop' }
    return
  }

  // The attempt bound ran out. Report what we have rather than ending the
  // stream with no finish, which the harness would read as an empty turn.
  if (usage) yield { type: 'usage', usage }
  yield pendingFinish?.reason === 'length' ? { type: 'finish', reason: 'length' } : { type: 'finish', reason: 'stop' }
}
