import { realmOf } from './realms.js'
import { config } from './config.js'
import { modelMeta } from './catalog.js'
import { exposedModels } from './price.js'
import { checkRequest, freeExhaustedSet, addSpend, observeFreeUsage } from './guard.js'
import { buildChatBody } from './upstream.js'
import { streamDirect } from './direct.js'
import { streamWbipc } from './wbipc.js'
import { appendLedger } from './ledger.js'

// The adapter is the whole point of this plugin: it answers the harness LLM
// seam in-process, so no local HTTP hop, no provider YAML and no shared token
// sit between a conversation and the WorkBuddy backend.

let attachmentsService = null

// Which model hit the upstream rate limit, and when: candidates for the
// "switch to…" suggestion must not include a model that is itself throttled.
const rateLimitedAt = new Map()
const RATE_LIMIT_MEMORY_MS = 10 * 60_000

function suggestAlternatives(realmId, model) {
  const now = Date.now()
  const throttled = (id) => now - (rateLimitedAt.get(`${realmId}:${id}`) ?? 0) < RATE_LIMIT_MEMORY_MS
  return exposedModels(realmId, freeExhaustedSet(realmId))
    .filter((m) => m.id !== model && !throttled(m.id))
    .sort((a, b) => (a.price?.effective ?? Infinity) - (b.price?.effective ?? Infinity))
    .slice(0, 3)
    .map((m) => m.name)
    .join(' / ')
}

const EFFORT_LABELS = { minimal: '最少思考', low: '少想（更省）', medium: '中等', high: '多想（更准更贵）', max: '最大' }

export function setAttachmentsService(service) {
  attachmentsService = service ?? null
}

function toTokenUsage(u) {
  if (!u) return null
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    ...(u.prompt_cache_hit_tokens ? { cacheReadTokens: u.prompt_cache_hit_tokens } : {}),
    ...(u.completion_thinking_tokens ? { reasoningTokens: u.completion_thinking_tokens } : {}),
  }
}

function finishReasonOf(reason, failure) {
  if (reason === 'error') return { kind: 'error', failure: failure ?? { message: 'upstream error' } }
  if (reason === 'tool-calls') return { kind: 'tool-calls' }
  if (reason === 'length') return { kind: 'max-tokens' }
  if (reason === 'aborted') return { kind: 'aborted', failure: failure ?? { message: 'aborted', code: 'ABORTED' } }
  return { kind: 'stop' }
}

/** Turns normalized upstream events into harness StreamChunks with open blocks. */
class ChunkWriter {
  constructor() {
    this.nextIndex = 0
    this.open = null
    this.chunks = []
    this.sawContent = false
    this.callIds = new Map() // tool-call slot -> last seen id, so a reopened block keeps it
    this.callNames = new Map()
  }

  push(chunk) {
    this.chunks.push(chunk)
  }

  closeOpen() {
    if (!this.open) return
    const b = this.open
    this.open = null
    if (b.kind === 'text') this.push({ type: 'block-end', index: b.index, block: { type: 'text', text: b.text } })
    else if (b.kind === 'reasoning') this.push({ type: 'block-end', index: b.index, block: { type: 'reasoning', text: b.text } })
    else this.push({ type: 'block-end', index: b.index, block: { type: 'tool-call', id: b.id, name: b.name, arguments: b.arguments } })
  }

  ensure(kind, extra) {
    if (this.open && (this.open.kind !== kind || (kind === 'tool-call' && this.open.slot !== extra?.slot))) this.closeOpen()
    if (this.open) return
    this.open = { kind, index: this.nextIndex++, text: '', arguments: '', ...extra }
    this.push({ type: 'block-start', index: this.open.index, blockType: kind })
  }

  event(ev) {
    switch (ev.type) {
      case 'text':
        this.sawContent = true
        this.ensure('text')
        this.open.text += ev.text
        this.push({ type: 'text-delta', index: this.open.index, text: ev.text })
        break
      case 'reasoning':
        this.sawContent = true
        this.ensure('reasoning')
        this.open.text += ev.text
        this.push({ type: 'reasoning-delta', index: this.open.index, text: ev.text })
        break
      case 'toolcall': {
        this.sawContent = true
        const slot = ev.slot ?? 0
        // Remember the id per slot: if reasoning/text interleaves and splits the
        // call into several blocks, each reopened block keeps the same id (the
        // replay-side merge in upstream.js then reunites them).
        if (ev.id) this.callIds.set(slot, ev.id)
        const rememberedId = ev.id ?? this.callIds.get(slot) ?? ''
        const rememberedName = ev.name ?? this.callNames.get(slot) ?? ''
        this.ensure('tool-call', { slot, id: rememberedId, name: rememberedName })
        if (ev.id) this.open.id = ev.id
        if (ev.name) {
          this.open.name = ev.name
          this.callNames.set(slot, ev.name)
        }
        this.open.arguments += ev.argumentsDelta ?? ''
        this.push({
          type: 'tool-call-delta',
          index: this.open.index,
          id: this.open.id,
          ...(this.open.name ? { name: this.open.name } : {}),
          argumentsDelta: ev.argumentsDelta ?? '',
        })
        break
      }
      default:
        break
    }
  }

  /** Close any open block and push the single terminal finish chunk. */
  finish(reason) {
    this.closeOpen()
    this.push({ type: 'finish', reason })
  }
}

export function createAdapter({ onWarn } = {}) {
  const warnSink = onWarn ?? (() => {})

  const adapter = {
    providerInfo(provider) {
      // 分组名必须与旧中转链路的「WorkBuddy 国际版 (预积分计费)」可区分，
      // 否则选择器里两个同名分组无法归因一次请求走了哪条链路。
      return { id: provider, name: `${realmOf(provider).label} · 原生` }
    },

    // The seam calls this for every route at registration time. The default
    // policy (5 tries, ≤10s apart) gives up in ~9s — shorter than the upstream's
    // per-minute rate-limit window, so a 429 storm failed every retry. This
    // window spans ~2 minutes instead: a per-minute quota unlocks inside it.
    providerRetryPolicy() {
      return {
        mode: 'normal',
        maxRetries: 8,
        retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'],
        backoff: { initialDelayMs: 3000, maxDelayMs: 20000, jitterRatio: 0.1 },
      }
    },

    async listModels(provider) {
      const realmId = realmOf(provider).id
      return exposedModels(realmId, freeExhaustedSet(realmId)).map((m) => ({
        provider,
        id: m.id,
        name: m.name,
        inputModalities: m.input,
      }))
    },

    resolveModel(provider, model) {
      return resolveModelInfo(provider, model)
    },

    /**
     * Per-call entry point the seam uses for both logging and dispatch. The
     * returned handle is one-shot from the seam's side and its `stream` receives
     * the seam-resolved options, so nothing here may cache the call config.
     */
    async prepareCall(provider, model) {
      return { model: await resolveModelInfo(provider, model), stream: openStream }
    },
  }

  return adapter

  async function resolveModelInfo(provider, model) {
    const realmId = realmOf(provider).id
    const meta = modelMeta(realmId, model)
    const name = exposedModels(realmId, freeExhaustedSet(realmId)).find((m) => m.id === model)?.name ?? model
    return {
      provider,
      id: model,
      name,
      ...(meta ? { context: { contextWindow: meta.contextWindow }, defaultMaxTokens: meta.maxTokens || undefined } : {}),
      ...(meta ? { inputModalities: meta.supportsImages ? ['text', 'image'] : ['text'] } : {}),
      ...(meta?.supportsReasoning && meta.reasoningEfforts?.length
        ? {
            reasoning: {
              efforts: meta.reasoningEfforts.map((id) => ({ id, name: EFFORT_LABELS[id] ?? id })),
              ...(meta.defaultReasoningEffort ? { defaultEffort: meta.defaultReasoningEffort } : {}),
            },
          }
        : {}),
    }
  }

  async function* openStream(options) {
    const realm = realmOf(options.provider)
    const t0 = Date.now()
    const meta = modelMeta(realm.id, options.model)
    const writer = new ChunkWriter()
    const transport = config().defaultTransport

    let usage = null
    let heldFinish = null
    let firstByteMs = null
    let outcome = null // { status, error, code, aborted }
    let booked = false

    // The host calls iterator.return() when a generation is stopped; the
    // upstream has still been billed, so accounting happens exactly once in
    // the finally block no matter how the loop ends.
    const book = () => {
      if (booked) return
      booked = true
      if (usage?.credit) {
        addSpend(realm.id, usage.credit)
        observeFreeUsage(realm.id, options.model, usage)
      }
      appendLedger({
        event: 'request',
        realm: realm.id,
        mode: transport,
        model: options.model,
        status: outcome?.status ?? (outcome ? 0 : 200),
        durationMs: Date.now() - t0,
        firstByteMs,
        ...(outcome?.aborted ? { aborted: outcome.aborted } : {}),
        ...(outcome?.error ? { error: outcome.error, code: outcome.code } : {}),
        usage: usage ? {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          completion_thinking_tokens: usage.completion_thinking_tokens,
          prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens,
          prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens,
          credit: usage.credit,
        } : null,
      })
    }

    // Error paths emit their own terminal chunk immediately: there is no
    // usage left to order it after.
    const terminal = (kind, message, code) => {
      writer.finish({ kind, failure: { message, code } })
      return writer.chunks.splice(0)
    }
    try {
      if (!meta) {
        outcome = { status: 0, error: `model ${options.model} is not in the ${realm.label} catalog`, code: 'UNKNOWN_MODEL' }
        yield* terminal('error', outcome.error, outcome.code)
        return
      }

      let body
      try {
        body = await buildChatBody(options, meta, { attachments: attachmentsService, maxTokens: options.maxTokens })
      } catch (e) {
        outcome = { status: 0, error: `request build failed: ${e?.message ?? e}`, code: 'REQUEST_BUILD' }
        yield* terminal('error', outcome.error, outcome.code)
        return
      }

      const verdict = checkRequest(realm.id, options.model, body)
      if (!verdict.ok) {
        outcome = { status: 0, error: verdict.message, code: verdict.code }
        yield* terminal('error', `${verdict.message}${verdict.hint ? `（${verdict.hint}）` : ''}`, verdict.code)
        return
      }
      if (verdict.warn) {
        warnSink({ event: 'context_warn', realm: realm.id, model: options.model, warn: verdict.warn })
      }

      // Each wbipc segment is its own billed upstream call, so the gates run
      // again per segment instead of once for the whole request.
      let segments = 0
      const beforeSegment = async () => {
        segments++
        if (segments === 1) return
        const again = checkRequest(realm.id, options.model, body)
        if (!again.ok) throw Object.assign(new Error(again.message), { code: again.code })
      }

      const events = transport === 'wbipc'
        ? streamWbipc(realm.id, { options, meta, attachments: attachmentsService, maxTokens: options.maxTokens, beforeSegment })
        : streamDirect(realm.id, JSON.stringify(body), options.signal)

      for await (const ev of events) {
        firstByteMs ??= Date.now() - t0
        if (ev.type === 'usage') {
          usage = ev.usage
          continue
        }
        if (ev.type === 'finish') {
          if (ev.reason === 'error') outcome = { status: 0, error: String(ev.failure?.message ?? 'upstream error'), code: String(ev.failure?.code ?? 'UPSTREAM_ERROR') }
          writer.finish(finishReasonOf(ev.reason, ev.failure))
          const emitted = writer.chunks.splice(0)
          heldFinish = emitted.pop() ?? null
          for (const c of emitted) yield c
          continue
        }
        writer.event(ev)
        for (const c of writer.chunks.splice(0)) yield c
      }

      if (!heldFinish) {
        // A stream that closed with no content and no finish is an empty
        // response the retry layer should be allowed to repeat, not a
        // successful turn.
        if (writer.sawContent) {
          writer.finish({ kind: 'stop' })
          const emitted = writer.chunks.splice(0)
          heldFinish = emitted.pop() ?? null
          for (const c of emitted) yield c
        } else {
          outcome = { status: 0, error: 'upstream returned no content', code: 'EMPTY_RESPONSE' }
          yield* terminal('error', outcome.error, outcome.code)
          return
        }
      }
    } catch (e) {
      const aborted = Boolean(options.signal?.aborted)
      let message = String(e?.message ?? e)
      if (e?.code === 'RATE_LIMIT') {
        // Remember the throttled model so the suggestion never recommends it.
        rateLimitedAt.set(`${realm.id}:${options.model}`, Date.now())
        const alternatives = suggestAlternatives(realm.id, options.model)
        if (alternatives) message += `\n可切换：${alternatives}（解锁后随时可在模型选择器换回，约 1 分钟）`
      }
      outcome = { status: 0, error: message, code: e?.code ?? (aborted ? 'ABORTED' : 'UPSTREAM'), aborted: aborted ? message : null }
      for (const c of writer.chunks.splice(0)) yield c
      heldFinish = null
      yield* terminal(aborted ? 'aborted' : 'error', message, outcome.code)
    } finally {
      book()
    }

    if (usage) yield { type: 'usage', usage: toTokenUsage(usage) }
    if (heldFinish) yield heldFinish
}
  }
