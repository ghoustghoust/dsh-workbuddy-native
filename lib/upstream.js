
// Harness request vocabulary -> WorkBuddy Chat Completions body, and the
// upstream SSE stream -> normalized events. Upstream quirks handled here:
// the first message must be a system prompt, non-stream requests are refused,
// some models reject max_tokens, and reasoning arrives as reasoning_content.

/** Models that answer 400 model_param_invalid when max_tokens is present. */
export const MODELS_REJECTING_MAX_TOKENS = new Set(['gpt-5.6-luna'])

function textOf(blocks) {
  const out = []
  for (const b of blocks ?? []) if (b?.type === 'text' && typeof b.text === 'string' && b.text.length) out.push(b.text)
  return out.join('\n')
}

function toolResultText(content) {
  if (typeof content === 'string') return content
  return textOf(content) || '(no output)'
}

/**
 * Turn harness history into OpenAI-shaped chat rows while guaranteeing the
 * tool-call sequence the upstream validates with 400 code 11133: every
 * assistant tool_calls batch must be IMMEDIATELY followed by its tool results,
 * ids must be non-empty and unique per batch, and nothing may interleave.
 * Whatever the harness, the model stream or a previous bug produced
 * (split/duplicate call blocks, interleaved notes, orphan results, missing
 * results), this normalization rebuilds a sequence the model provider accepts.
 */
async function toChatMessages(options, attachments) {
  const messages = []
  const system = typeof options.system === 'string' && options.system.length
    ? options.system
    : (options.messages?.[0]?.role === 'system' ? textOf(options.messages[0].content) : '')
  if (system) messages.push({ role: 'system', content: system })

  // Pass 1: project each harness message into typed units.
  const units = []
  let syntheticCalls = 0
  for (let m = 0; m < (options.messages?.length ?? 0); m++) {
    const message = options.messages[m]
    if (message.role === 'system' || message.role === 'developer') {
      // Only one system slot survives the trip; a mid-history system or
      // developer message is demoted to user text so its content still reaches
      // the model (adjacency pass decides where it may legally sit).
      const text = textOf(message.content)
      if (text && m !== 0) units.push({ kind: 'note', text: `[system] ${text}` })
      continue
    }
    if (message.role === 'assistant') {
      const texts = []
      const calls = []
      for (const b of message.content ?? []) {
        if (b?.type === 'text' && b.text) texts.push(b.text)
        else if (b?.type === 'tool-call') {
          const id = typeof b.id === 'string' && b.id ? b.id : `wb_tc_${syntheticCalls++}`
          const prev = calls.find((c) => c.id === id)
          if (prev) prev.args += typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {})
          else calls.push({ id, name: b.name ?? '', args: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {}) })
        }
      }
      units.push({ kind: 'assistant', text: texts.join('\n'), calls })
      continue
    }
    // user-ish message: tool results ride along as separate tool units.
    const blocks = message.content ?? []
    const results = blocks.filter((b) => b?.type === 'tool-result')
    for (const r of results) units.push({ kind: 'tool', id: typeof r.toolCallId === 'string' ? r.toolCallId : '', text: toolResultText(r.content) })
    const text = textOf(blocks)
    const images = []
    for (const b of blocks) {
      if (b?.type !== 'image') continue
      if (!attachments?.readImage) {
        images.push({ type: 'text', text: '[image omitted: the harness attachment service is unavailable]' })
        continue
      }
      try {
        const stored = await attachments.readImage(b.attachment)
        const data = Buffer.from(stored.data).toString('base64')
        images.push({ type: 'image_url', image_url: { url: `data:${stored.ref?.mediaType ?? 'image/png'};base64,${data}` } })
      } catch (e) {
        images.push({ type: 'text', text: `[image could not be read: ${e?.message ?? e}]` })
      }
    }
    // An image-only message (a screenshot pasted with no caption) must still
    // reach the model: the old condition dropped it entirely.
    if (text || images.length || (results.length === 0 && !images.length)) {
      units.push({ kind: 'user', text, images })
    }
  }

  // Pass 2: emit rows with the adjacency invariant enforced.
  let pending = [] // uncovered tool_call ids of the last assistant batch
  let deferred = [] // rows held back until every pending id has a result
  const flushDeferred = () => {
    for (const row of deferred) messages.push(row)
    deferred = []
  }
  const coverPending = (id) => {
    const at = pending.indexOf(id)
    if (at >= 0) pending.splice(at, 1)
    if (!pending.length) flushDeferred()
  }
  const closePending = () => {
    for (const id of pending) messages.push({ role: 'tool', tool_call_id: id, content: '(no result)' })
    pending = []
    flushDeferred()
  }
  const lastToolRow = (id) => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const row = messages[i]
      if (row.role !== 'tool') continue
      if (row.tool_call_id === id) return row
      break // results for one batch are contiguous
    }
    return null
  }

  for (const u of units) {
    if (u.kind === 'assistant') {
      if (pending.length) closePending()
      const row = { role: 'assistant', content: u.text }
      if (u.calls.length) {
        row.tool_calls = u.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } }))
        pending = u.calls.map((c) => c.id)
      }
      messages.push(row)
      continue
    }
    if (u.kind === 'tool') {
      if (!pending.length) {
        // Orphan result: keep the content but in a shape the sequence allows.
        deferred.push({ role: 'user', content: `[工具结果] ${u.text}` })
        continue
      }
      const id = u.id && pending.includes(u.id) ? u.id : pending[0]
      const existing = lastToolRow(id)
      if (existing) existing.content += `\n${u.text}` // duplicate results merge into one row
      else messages.push({ role: 'tool', tool_call_id: id, content: u.text })
      coverPending(id)
      continue
    }
    const row = u.images?.length
      ? { role: 'user', content: [{ type: 'text', text: u.text || '(no caption)' }, ...u.images] }
      : { role: 'user', content: u.text }
    if (pending.length) deferred.push(row)
    else messages.push(row)
  }
  if (pending.length) closePending()
  flushDeferred()

  // Upstream rejects a request whose first message is not a system prompt
  // (HTTP 400 code 11128), so a minimal one is inserted when none exists.
  if (messages.length === 0 || messages[0].role !== 'system') messages.unshift({ role: 'system', content: 'You are a helpful assistant.' })
  return messages
}

/**
 * @param continuation - assistant text already received; when present the body
 *   becomes a continuation request (used by the wbipc over-limit path).
 */
export async function buildChatBody(options, meta, { attachments, continuation = null, maxTokens } = {}) {
  const messages = await toChatMessages(options, attachments)
  if (continuation) {
    messages.push({ role: 'assistant', content: continuation })
    messages.push({ role: 'user', content: 'Continue exactly where you stopped, without repeating anything already written.' })
  }
  const body = {
    model: options.model,
    messages,
    stream: true, // upstream refuses stream:false (HTTP 400 code 11101)
    stream_options: { include_usage: true },
  }
  if (Array.isArray(options.tools) && options.tools.length) {
    body.tools = options.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  }
  if (!MODELS_REJECTING_MAX_TOKENS.has(options.model)) {
    const cap = meta?.maxTokens ?? 0
    const wanted = maxTokens ?? options.maxTokens ?? cap
    if (wanted > 0) body.max_tokens = cap > 0 ? Math.min(wanted, cap) : wanted
  }
  if (typeof options.temperature === 'number') body.temperature = options.temperature
  // Thinking depth is the one cost lever the user can pull on a reasoning
  // model: the upstream accepts reasoning_effort and bills the extra thinking
  // tokens as output. Only levels the catalog declares are forwarded — an
  // unsupported one answers 400 model_param_invalid.
  const efforts = meta?.reasoningEfforts
  if (meta?.supportsReasoning && options.reasoningEffort && (!efforts?.length || efforts.includes(String(options.reasoningEffort)))) {
    body.reasoning_effort = String(options.reasoningEffort)
  }
  return body
}

function normalizeUsage(u) {
  if (!u) return null
  return {
    prompt_tokens: u.prompt_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? 0,
    completion_thinking_tokens: u.completion_thinking_tokens ?? u.completion_tokens_details?.reasoning_tokens ?? 0,
    prompt_cache_hit_tokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
    prompt_cache_miss_tokens: u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens ?? 0) - (u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0)),
    credit: typeof u.credit === 'number' ? u.credit : 0,
  }
}

/** One SSE `data:` payload -> normalized events (usually one). */
export function eventsFromChunk(obj) {
  const out = []
  const choice = obj?.choices?.[0]
  if (obj?.error) {
    // 流内错误体可能引用对话片段（内容审查类报错常见），与 HTTP 错误路径
    // 一样只保留机器码，不回显 message 原文。
    const code = String(obj.error?.code ?? 'UPSTREAM_ERROR')
    out.push({ type: 'finish', reason: 'error', failure: { message: `upstream stream error (code ${code})`, code } })
    return out
  }
  if (choice?.delta) {
    const d = choice.delta
    if (typeof d.reasoning_content === 'string' && d.reasoning_content.length) out.push({ type: 'reasoning', text: d.reasoning_content })
    if (typeof d.content === 'string' && d.content.length) out.push({ type: 'text', text: d.content })
    if (Array.isArray(d.tool_calls)) {
      for (const t of d.tool_calls) {
        out.push({
          type: 'toolcall',
          slot: Number.isInteger(t.index) ? t.index : 0,
          id: t.id,
          name: t.function?.name,
          argumentsDelta: typeof t.function?.arguments === 'string' ? t.function.arguments : '',
        })
      }
    }
  }
  if (choice?.finish_reason) {
    out.push({ type: 'finish', reason: choice.finish_reason === 'tool_calls' ? 'tool-calls' : choice.finish_reason === 'length' ? 'length' : 'stop' })
  }
  const usage = normalizeUsage(obj?.usage)
  if (usage) out.push({ type: 'usage', usage })
  return out
}

/** Parse a complete SSE body (the wbipc transport receives one buffered text). */
export function sseEventsFromText(text) {
  const out = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try { out.push(...eventsFromChunk(JSON.parse(data))) } catch { /* skip damaged frame */ }
  }
  return out
}

/** Incremental SSE reader for the direct transport. */
export async function* sseEventStream(body, { signal } = {}) {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buf = ''
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('aborted')
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          for (const ev of eventsFromChunk(JSON.parse(data))) yield ev
        } catch { /* partial or damaged frame */ }
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }
}

export { normalizeUsage }
