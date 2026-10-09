import * as fs from 'fs'
import * as path from 'path'
import { DATA_DIR } from './config.js'
import { REALMS, realmOfId } from './realms.js'
import { catalogHeaders } from './headers.js'

// The catalog answers the model picker synchronously: the harness rebuilds the
// catalog on demand with no cache and no timeout, so any network wait here
// would stall the picker. Network happens only in refreshCatalog().

const SAFE_MODEL_ID = /^[\w][\w.@:-]{0,63}$/

// Network strings end up in the model picker, the panel and denial messages, so
// they are length-capped and stripped of control/bidi characters that could
// spoof a label or hide text ("Trojan Source"). Declared next to SAFE_MODEL_ID:
// the snapshot load loop below runs at import time and reaches this first.
const CAPPED_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/g
export function safeText(value, max = 120) {
  if (typeof value !== 'string') return ''
  return value.replace(CAPPED_CHARS, '').slice(0, max)
}

// The vendor's router tiers resolve to a model chosen per request and bill at a
// floating multiplier, so they are not selectable models.
export function isRouterTier(id) {
  return id === 'auto' || id === 'default' || /-model$/.test(id)
}

function snapshotFile(realmId) {
  return path.join(DATA_DIR, `catalog-${realmId}.json`)
}

function emptyCatalog() {
  return { models: {}, promos: {}, picker: [], fetchedAt: null, uaSource: null }
}

const state = new Map()

for (const realmId of Object.keys(REALMS)) {
  let loaded = null
  try { loaded = JSON.parse(fs.readFileSync(snapshotFile(realmId), 'utf8')) } catch { /* first run */ }
  state.set(realmId, sanitizeCatalog(loaded))
}

export function getCatalog(realmId) {
  return state.get(realmId) ?? emptyCatalog()
}

/** Test hook: install a catalog without going through the network path. */
export function setCatalogSnapshotForTest(realmId, next) {
  state.set(realmId, { ...emptyCatalog(), ...next })
}

export function modelMeta(realmId, modelId) {
  return getCatalog(realmId).models[modelId] ?? null
}

export function catalogInfo(realmId) {
  const c = getCatalog(realmId)
  return {
    fetchedAt: c.fetchedAt,
    models: Object.keys(c.models).length,
    picker: c.picker.length,
    uaSource: c.uaSource ?? null,
    dropped: c.dropped ?? null,
    empty: c.picker.length === 0,
  }
}

function positiveInt(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

/** A snapshot on disk can be edited by anything with the user's permissions. */
function sanitizeCatalog(raw) {
  const vault = emptyCatalog()
  if (!raw || typeof raw !== 'object') return vault
  const models = {}
  for (const [id, m] of Object.entries(raw.models ?? {})) {
    if (!SAFE_MODEL_ID.test(id) || !m || typeof m !== 'object') continue
    const contextWindow = positiveInt(m.contextWindow)
    if (contextWindow === 0) continue
    models[id] = {
      ...m,
      id,
      name: safeText(m.name, 60) || id,
      baseMultRaw: safeText(m.baseMultRaw, 32),
      contextWindow,
      maxTokens: positiveInt(m.maxTokens),
    }
  }
  const promos = {}
  for (const [id, list] of Object.entries(raw.promos ?? {})) {
    if (!models[id] || !Array.isArray(list)) continue
    promos[id] = list
  }
  const picker = (Array.isArray(raw.picker) ? raw.picker : []).filter((id) => models[id] && !isRouterTier(id))
  return {
    models,
    promos,
    picker,
    fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : null,
    uaSource: typeof raw.uaSource === 'string' ? safeText(raw.uaSource, 200) : null,
    dropped: raw.dropped && typeof raw.dropped === 'object' ? raw.dropped : null,
  }
}

function fingerprint(c) {
  return JSON.stringify([c.picker, Object.keys(c.models).sort(), Object.keys(c.promos).sort()])
}

/**
 * Fetch `/v3/config` for one realm and replace that realm's cached catalog.
 * The backend gates the response on the client UA, so only the desktop
 * three-segment UA yields the merged product+account list the picker uses.
 * @returns {Promise<{changed: boolean, count: number} | {error: string}>}
 */
export async function refreshCatalog(realmId, account) {
  const realm = realmOfId(realmId)
  if (!account?.accessToken) return { error: 'no credential for this realm' }
  let env
  try {
    const res = await fetch(`${realm.chatBase}/v3/config`, { headers: catalogHeaders(account, realm), signal: AbortSignal.timeout(30_000) })
    env = await res.json().catch(() => null)
    if (!res.ok) return { error: `catalog HTTP ${res.status}` }
  } catch (e) {
    return { error: `catalog fetch failed: ${e?.message ?? e}` }
  }
  const data = env?.data
  if (!data?.models?.length) return { error: 'catalog response carried no models' }

  const models = {}
  for (const m of data.models) {
    if (!m?.id || !SAFE_MODEL_ID.test(m.id)) continue
    const contextWindow = positiveInt(m.maxInputTokens)
    if (contextWindow === 0) continue
    models[m.id] = {
      id: m.id,
      name: safeText(typeof m.name === 'string' && m.name ? m.name : m.id, 60),
      baseMultRaw: safeText(m.credits, 32),
      contextWindow,
      maxTokens: positiveInt(m.maxOutputTokens),
      supportsImages: m.supportsImages !== false,
      supportsToolCall: m.supportsToolCall !== false,
      supportsReasoning: m.supportsReasoning === true,
      onlyReasoning: m.onlyReasoning === true,
      // The vendor's own effort vocabulary; advertising anything else would let
      // the harness offer a level the upstream then rejects.
      reasoningEfforts: Array.isArray(m.reasoning?.supportedEfforts) ? m.reasoning.supportedEfforts.filter((x) => typeof x === 'string') : undefined,
      defaultReasoningEffort: typeof m.reasoning?.defaultEffort === 'string' ? m.reasoning.defaultEffort : undefined,
      canDisableThinking: m.reasoning?.canDisableThinking === true,
    }
  }
  const promos = {}
  for (const p of data.modelPromotions ?? []) {
    if (!p?.enabled) continue
    for (const mid of p.modelIds ?? []) (promos[mid] ??= []).push(p)
  }
  const agent = (data.agents ?? []).find((x) => (x.tags ?? []).includes('default'))
  const whitelist = agent?.models ?? []
  const picker = whitelist.filter((id) => !isRouterTier(id) && models[id] && SAFE_MODEL_ID.test(id))
  // Tier names are matched by pattern, so record what was dropped: a real
  // model that happens to end in `-model` must be findable, not silently gone.
  const dropped = {
    routerTiers: whitelist.filter((id) => isRouterTier(id)),
    notWhitelisted: Object.keys(models).filter((id) => !whitelist.includes(id)),
    noContextInfo: (data.models ?? []).filter((m) => m?.id && !models[m.id] && !isRouterTier(m.id)).map((m) => m.id),
  }

  const before = fingerprint(getCatalog(realmId))
  const next = {
    models,
    promos,
    // An empty whitelist must not blank the provider: keep the previous list.
    picker: picker.length ? picker : getCatalog(realmId).picker,
    dropped: picker.length ? dropped : getCatalog(realmId).dropped ?? null,
    fetchedAt: new Date().toISOString(),
    uaSource: catalogHeaders(account, realm)['user-agent'] ?? null,
  }
  state.set(realmId, next)
  try { fs.writeFileSync(snapshotFile(realmId), JSON.stringify(next)) } catch { /* cache only */ }
  return { changed: fingerprint(next) !== before, count: next.picker.length }
}
