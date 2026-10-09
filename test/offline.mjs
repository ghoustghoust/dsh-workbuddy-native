// Offline verification for the host-independent layers:
// catalog normalization, price, upstream encode/parse, ledger, guard.
// Run: node test/offline.mjs   (uses a throwaway data directory)

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-native-test-'))
process.env.DSH_WB_NATIVE_DIR = tmp

const { appendLedger, rebuildToday, aggregateToday, exhaustedFreeModels } = await import('../lib/ledger.js')
const { effectivePrice, exposedModels } = await import('../lib/price.js')
const { buildChatBody, sseEventsFromText, eventsFromChunk, MODELS_REJECTING_MAX_TOKENS } = await import('../lib/upstream.js')
const { checkRequest, addSpend, observeFreeUsage, todaySpend } = await import('../lib/guard.js')
const { saveConfig } = await import('../lib/config.js')
const catalog = await import('../lib/catalog.js')

let failures = 0
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failures++
    console.log(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`)
  } else {
    console.log(`ok   ${name} = ${a.length > 110 ? a.slice(0, 107) + '…' : a}`)
  }
}

// ids mirror the vendor's real naming: selectable models never end in
// `-model`, router tiers always do (auto / default / *-model).
const freePromo = {
  id: 'p1', enabled: true, priority: 10, modelIds: ['glm-5.3'],
  discount: { factor: 0 }, badge: { label: '限时免费' },
  schedule: { daily: [{ start: '00:00', end: '23:59' }] },
}
const halfPromo = {
  id: 'p2', enabled: true, priority: 5, modelIds: ['kimi-k3'],
  discount: { factor: 0.5 }, badge: { label: '半价' },
  schedule: { daily: [{ start: '00:00', end: '23:59' }] },
}
const raw = {
  data: {
    models: [
      { id: 'glm-5.3', name: 'GLM 5.3', credits: 'x2', maxInputTokens: 200000, maxOutputTokens: 8000, supportsImages: true },
      { id: 'kimi-k3', name: 'Kimi K3', credits: 'x4', maxInputTokens: 100000, maxOutputTokens: 4000 },
      { id: 'deepseek-v4.1-flash', name: 'Deepseek Flash', credits: 'x1.5', maxInputTokens: 100000, maxOutputTokens: 4000 },
      { id: 'auto', name: 'Auto', credits: 'x1', maxInputTokens: 200000, maxOutputTokens: 8000 },
      { id: 'glm-large-model', name: 'GLM Large Tier', credits: 'x1', maxInputTokens: 200000, maxOutputTokens: 8000 },
      { id: 'no-ctx-1', name: 'No Context', credits: 'x1', maxOutputTokens: 100 },
    ],
    modelPromotions: [freePromo, halfPromo],
    agents: [{ tags: ['default'], models: ['glm-5.3', 'kimi-k3', 'deepseek-v4.1-flash', 'auto', 'glm-large-model', 'no-ctx-1'] }],
  },
}

const originalFetch = globalThis.fetch
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => raw })
const refresh = await catalog.refreshCatalog('cn', { accessToken: 'test-token', uid: 'u1' })
globalThis.fetch = originalFetch

check('picker keeps only whitelisted selectable models', refresh.count, 3)
check('router tiers recorded as dropped', catalog.catalogInfo('cn').dropped.routerTiers, ['auto', 'glm-large-model'])
check('model without context window recorded as dropped', catalog.catalogInfo('cn').dropped.noContextInfo, ['no-ctx-1'])
check('modelMeta contextWindow', catalog.modelMeta('cn', 'glm-5.3').contextWindow, 200000)
check('supportsImages mapped to modalities', catalog.modelMeta('cn', 'kimi-k3').supportsImages, true)

// --- price ------------------------------------------------------------------
const none = new Set()
check('free promo drives effective to 0', [effectivePrice('cn', 'glm-5.3', none).effective, effectivePrice('cn', 'glm-5.3', none).free], [0, true])
check('half promo halves base', effectivePrice('cn', 'kimi-k3', none).effective, 2)
check('no promo keeps base', effectivePrice('cn', 'deepseek-v4.1-flash', none).effective, 1.5)
const exhausted = new Set(['glm-5.3'])
const ex = effectivePrice('cn', 'glm-5.3', exhausted)
check('exhausted free model reverts to base', [ex.effective, ex.exhausted], [2, true])
check('exhaustion note carries next-free countdown', /下一次免费在/.test(ex.note), true)
check('display names carry price state', exposedModels('cn', exhausted).map((m) => m.name), [
  'GLM 5.3 (原价x2·免费已用完)', 'Kimi K3 (x2·原价x4)', 'Deepseek Flash (x1.5)',
])
check('modalities follow catalog', exposedModels('cn', none).map((m) => m.input.join('+')), ['text+image', 'text+image', 'text+image'])

// --- upstream body ----------------------------------------------------------
const options = {
  provider: 'workbuddy-cn',
  model: 'glm-5.3',
  system: 'You are terse.',
  messages: [
    { role: 'system', content: [{ type: 'text', text: 'You are terse.' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'yo' }, { type: 'tool-call', id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'result text' }] }] },
    { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
  ],
  tools: [{ name: 'lookup', description: 'look up', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
}
const meta = catalog.modelMeta('cn', 'glm-5.3')
const body = await buildChatBody(options, meta, {})
check('first message is system', body.messages[0].role, 'system')
check('stream forced on', [body.stream, body.stream_options.include_usage], [true, true])
check('assistant tool_calls preserved', body.messages[2].tool_calls[0].function.name, 'lookup')
check('tool result becomes role=tool', body.messages[3], { role: 'tool', tool_call_id: 'call_1', content: 'result text' })
check('max_tokens capped by model', body.max_tokens, 8000)
check('tools converted to function form', body.tools[0].function.parameters.type, 'object')
check('reasoning effort forwarded when the model supports it',
  (await buildChatBody({ ...options, reasoningEffort: 'low' }, { maxTokens: 8000, supportsReasoning: true }, {})).reasoning_effort, 'low')
check('reasoning effort omitted for non-reasoning models',
  'reasoning_effort' in (await buildChatBody({ ...options, reasoningEffort: 'low' }, { maxTokens: 8000 }, {})), false)
const luna = await buildChatBody({ ...options, model: 'gpt-5.6-luna' }, { maxTokens: 128000 }, {})
check('max_tokens dropped for rejecting model', MODELS_REJECTING_MAX_TOKENS.has('gpt-5.6-luna') && !('max_tokens' in luna), true)
const cont = await buildChatBody(options, meta, { continuation: 'partial answer' })
check('continuation appends assistant prefix + resume ask', cont.messages.slice(-2).map((m) => m.role), ['assistant', 'user'])
check('continuation carries the received text', cont.messages.at(-2).content, 'partial answer')
const noSystem = await buildChatBody({ ...options, system: undefined, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }, {}, {})
check('system inserted when absent', noSystem.messages[0], { role: 'system', content: 'You are a helpful assistant.' })
const midSystem = await buildChatBody({ ...options, messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }, { role: 'system', content: [{ type: 'text', text: 'mid' }] }] }, meta, {})
check('mid-history system folded into leading system', [midSystem.messages[0].role, midSystem.messages.filter((m) => m.role === 'system').length], ['system', 1])

// --- SSE parsing ------------------------------------------------------------
const sse = [
  'data: {"choices":[{"delta":{"reasoning_content":"th"}}]}',
  'data: {"choices":[{"delta":{"reasoning_content":"inking"}}]}',
  'data: {"choices":[{"delta":{"content":"hel"}}]}',
  'data: {"choices":[{"delta":{"content":"lo"}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"f","arguments":"{\\"a\\""}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"g","arguments":"{}"}}]}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":null}',
  'data: {"usage":{"prompt_tokens":100,"completion_tokens":20,"completion_thinking_tokens":5,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20,"credit":1.5}}',
  'data: [DONE]',
  ': heartbeat',
].join('\n') + '\n'
const events = sseEventsFromText(sse)
check('reasoning deltas', events.filter((e) => e.type === 'reasoning').map((e) => e.text), ['th', 'inking'])
check('text deltas', events.filter((e) => e.type === 'text').map((e) => e.text), ['hel', 'lo'])
const toolEvents = events.filter((e) => e.type === 'toolcall')
check('tool call argument fragments', toolEvents.map((e) => e.argumentsDelta), ['{"a"', ':1}', '{}'])
check('tool call slots kept apart', toolEvents.map((e) => e.slot), [0, 0, 1])
check('finish maps tool_calls', events.find((e) => e.type === 'finish').reason, 'tool-calls')
check('usage normalized with cache + thinking', events.find((e) => e.type === 'usage').usage, {
  prompt_tokens: 100, completion_tokens: 20, completion_thinking_tokens: 5,
  prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, credit: 1.5,
})
check('error frame becomes terminal error finish', eventsFromChunk({ error: { message: 'boom', code: 11128 } })[0].reason, 'error')
check('cached_tokens fallback used', eventsFromChunk({ usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 8 } } }).at(-1).usage.prompt_cache_hit_tokens, 8)

// --- ledger + guard ---------------------------------------------------------
appendLedger({ event: 'request', realm: 'cn', model: 'glm-5.3', status: 200, usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10, credit: 0.4 } })
appendLedger({ event: 'request', realm: 'global', model: 'glm-5.3', status: 200, usage: { prompt_tokens: 10, completion_tokens: 2, credit: 9.9 } })
check('rebuildToday is per-realm', rebuildToday('cn').credits, 0.4)
check('aggregateToday per model', aggregateToday('cn').models[0].calls, 1)
const dayFile = path.join(tmp, 'ledger', fs.readdirSync(path.join(tmp, 'ledger'))[0])
const line = JSON.parse(fs.readFileSync(dayFile, 'utf8').split('\n')[0])
check('ledger line carries realm + ts', [typeof line.realm, typeof line.ts], ['string', 'string'])
check('ledger has no conversation body fields', Object.keys(line).some((k) => /body|messages|content|response/i.test(k)), false)

saveConfig({ dailyCreditBudget: 0, perRequestCreditBudget: 0, contextWarnTokens: 0, allowPaidOverride: false })
check('no gates fire on a clean slate', checkRequest('cn', 'deepseek-v4.1-flash', { messages: [{ content: 'x' }] }), { ok: true, warn: null })
observeFreeUsage('cn', 'glm-5.3', { credit: 0.4 })
check('free exhaustion recorded', exhaustedFreeModels('cn').has('glm-5.3'), true)
check('free quota gate blocks after exhaustion', checkRequest('cn', 'glm-5.3', { messages: [{ content: 'x' }] }).code, 'FREE_QUOTA_EXHAUSTED')
saveConfig({ allowPaidOverride: true })
check('override lets an exhausted model bill at base', checkRequest('cn', 'glm-5.3', { messages: [{ content: 'x' }] }).ok, true)
saveConfig({ allowPaidOverride: false, perRequestCreditBudget: 1 })
check('per-request runaway gate', checkRequest('cn', 'deepseek-v4.1-flash', { messages: [{ content: 'x'.repeat(30000) }] }).code, 'REQUEST_TOO_EXPENSIVE')
saveConfig({ perRequestCreditBudget: 0, dailyCreditBudget: 0.3 })
check('daily budget gate', checkRequest('cn', 'deepseek-v4.1-flash', { messages: [{ content: 'x' }] }).code, 'BUDGET_EXHAUSTED')
saveConfig({ dailyCreditBudget: 0 })
addSpend('cn', 0.2)
check('spend accumulates per realm', Math.round(todaySpend('cn') * 1000) / 1000, 0.6)
check('other realm budget untouched', Math.round(todaySpend('global') * 1000) / 1000, 9.9)

// The vendor reports an already-discounted multiplier while a 0x promo is live,
// so the original price must be flagged unknown rather than invented as x0.
catalog.setCatalogSnapshotForTest('cn', {
  models: { 'x0-free': { id: 'x0-free', name: 'Zero Base', baseMultRaw: 'x0.00', contextWindow: 1000, maxTokens: 100, supportsImages: false, supportsReasoning: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' } },
  promos: { 'x0-free': [freePromo] },
  picker: ['x0-free'],
})
const zex = effectivePrice('cn', 'x0-free', new Set(['x0-free']))
check('unknown original price is flagged, not faked', [zex.baseUnknown, zex.effective], [true, 0])
check('exhausted name omits a fabricated base price', exposedModels('cn', new Set(['x0-free'])).map((m) => m.name), ['Zero Base (免费已用完)'])
check('only catalog-declared efforts are forwarded upstream',
  [(await buildChatBody({ ...options, model: 'x0-free', reasoningEffort: 'high' }, catalog.modelMeta('cn', 'x0-free'), {})).reasoning_effort,
    'reasoning_effort' in (await buildChatBody({ ...options, model: 'x0-free', reasoningEffort: 'ultra' }, catalog.modelMeta('cn', 'x0-free'), {}))],
  ['high', false])

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
