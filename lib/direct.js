import { realmOfId } from './realms.js'
import { chatHeaders, msgId } from './headers.js'
import { getFreshAccount, recoverAfter401 } from './login.js'
import { sseEventStream } from './upstream.js'

// Direct transport: real streaming against the WorkBuddy backend with the
// plugin's own device-code credential.

// DSH's stream-idle watchdog aborts from the client side, but nothing else
// would cut a dead upstream if the client walks away mid-stream. 600s of zero
// bytes is far beyond any observed prefill (worst measured: 243s).
const UPSTREAM_IDLE_MS = 600_000

// The harness retries failures whose code is in its retryable set (RATE_LIMIT,
// SERVER, TIMEOUT, TRANSPORT) with exponential backoff. Mapping upstream
// statuses into that vocabulary is what turns a rate-limit burst into a
// self-healing pause instead of a hard turn failure the host hammers against.
export function transportCodeFor(status) {
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  return 'UPSTREAM_HTTP'
}

function send(realm, account, bodyStr, convReqId, signal) {
  return fetch(`${realm.chatBase}/v2/chat/completions`, {
    method: 'POST',
    headers: chatHeaders(account, convReqId, realm),
    body: bodyStr,
    signal,
  })
}

/**
 * @yields normalized upstream events (text / reasoning / toolcall / usage / finish)
 */
export async function* streamDirect(realmId, bodyStr, externalSignal) {
  const realm = realmOfId(realmId)
  const internal = new AbortController()
  const signal = externalSignal ? AbortSignal.any([externalSignal, internal.signal]) : internal.signal
  let account = await getFreshAccount(realmId)
  const convReqId = msgId()

  let upstream
  try {
    upstream = await send(realm, account, bodyStr, convReqId, signal)
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') throw e
    // A connection-level failure (reset, DNS, TLS) is transient by nature.
    throw Object.assign(new Error(`upstream connection failed: ${e?.message ?? e}`), { code: 'TRANSPORT' })
  }
  if (upstream.status === 401) {
    await upstream.text().catch(() => '')
    account = await recoverAfter401(realmId, account)
    try {
      upstream = await send(realm, account, bodyStr, convReqId, signal)
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') throw e
      throw Object.assign(new Error(`upstream connection failed: ${e?.message ?? e}`), { code: 'TRANSPORT' })
    }
  }
  const contentType = upstream.headers.get('content-type') ?? ''
  if (!contentType.includes('event-stream')) {
    const text = await upstream.text().catch(() => '')
    if (!upstream.ok) {
      // The upstream error body can echo part of the conversation (a
      // moderation or context-length message typically quotes the offending
      // fragment), so only a status and a short code leave this function.
      const code = /"code"\s*:\s*(\d+)/.exec(text)?.[1] ?? ''
      const message = upstream.status === 429
        ? `上游限流（HTTP 429${code ? ` code ${code}` : ''}）：任务输入过大触发了每分钟配额，将自动退避重试`
        : `upstream HTTP ${upstream.status}${code ? ` (code ${code})` : ''}`
      throw Object.assign(new Error(message), { code: transportCodeFor(upstream.status), status: upstream.status })
    }
    // A non-SSE 200 still has to answer the call: fold the JSON completion.
    const { eventsFromChunk } = await import('./upstream.js')
    try {
      for (const ev of eventsFromChunk(JSON.parse(text))) yield ev
    } catch {
      throw Object.assign(new Error('upstream returned a body that is neither SSE nor JSON'), { code: 'UPSTREAM_SHAPE' })
    }
    return
  }

  let lastByteAt = Date.now()
  const guard = setInterval(() => {
    if (Date.now() - lastByteAt >= UPSTREAM_IDLE_MS) internal.abort(new Error(`upstream idle ${UPSTREAM_IDLE_MS}ms`))
  }, 15_000)
  try {
    for await (const ev of sseEventStream(upstream.body, { signal })) {
      lastByteAt = Date.now()
      yield ev
    }
  } finally {
    clearInterval(guard)
    try { await upstream.body?.cancel() } catch { /* already consumed or errored */ }
  }
}
