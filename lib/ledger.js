import * as fs from 'fs'
import * as path from 'path'
import { DATA_DIR, LEDGER_DIR, localDay } from './config.js'

// The day's ledger is the source of truth for spending; state-<realm>.json is
// only a cache. A stale or hand-edited counter must never disable the budget
// guard, so the day is always rebuilt from the ledger when available.

try { fs.mkdirSync(LEDGER_DIR, { recursive: true, mode: 0o700 }) } catch { /* exists */ }

export function dayFile(day = localDay()) {
  return path.join(LEDGER_DIR, `${day}.jsonl`)
}

export function appendLedger(entry) {
  try {
    fs.mkdirSync(LEDGER_DIR, { recursive: true })
    fs.appendFileSync(dayFile(), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch { /* logging must never break a request */ }
}

export function readDay(day = localDay()) {
  let raw
  try { raw = fs.readFileSync(dayFile(day), 'utf8') } catch { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* skip damaged line */ }
  }
  return out
}

function stateFile(realmId) {
  return path.join(DATA_DIR, `state-${realmId}.json`)
}

export function readStateCache(realmId) {
  try { return JSON.parse(fs.readFileSync(stateFile(realmId), 'utf8')) } catch { return null }
}

export function writeStateCache(realmId, state) {
  try { fs.writeFileSync(stateFile(realmId), JSON.stringify(state), { mode: 0o600 }) } catch { /* cache only */ }
}

/** @returns {{credits: number, calls: number} | null} null when the ledger holds no data for the day */
export function rebuildToday(realmId, day = localDay()) {
  const entries = readDay(day)
  if (entries.length === 0) return null
  let credits = 0
  let calls = 0
  for (const e of entries) {
    if (e?.event !== 'request') continue
    if ((e.realm ?? 'cn') !== realmId) continue
    calls++
    const c = e.usage?.credit
    if (typeof c === 'number' && c > 0) credits += c
  }
  return { credits, calls }
}

/** Per-model totals for the day, used by the budget UI and the agent tool. */
export function aggregateToday(realmId, day = localDay()) {
  const byModel = new Map()
  let credits = 0
  let last = null
  for (const e of readDay(day)) {
    if (e?.event !== 'request') continue
    if ((e.realm ?? 'cn') !== realmId) continue
    const u = e.usage ?? {}
    const row = byModel.get(e.model) ?? { model: e.model, calls: 0, credit: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheMissTokens: 0, thinkingTokens: 0 }
    row.calls++
    row.credit += u.credit ?? 0
    row.promptTokens += u.prompt_tokens ?? 0
    row.completionTokens += u.completion_tokens ?? 0
    row.cacheReadTokens += u.prompt_cache_hit_tokens ?? 0
    row.cacheMissTokens += u.prompt_cache_miss_tokens ?? 0
    row.thinkingTokens += u.completion_thinking_tokens ?? 0
    credits += u.credit ?? 0
    byModel.set(e.model, row)
    last = { model: e.model, ts: e.ts ?? null }
  }
  return { credits, last, models: [...byModel.values()].sort((a, b) => b.credit - a.credit) }
}

/** Models that were billed credits while priced as free today. */
export function exhaustedFreeModels(realmId, day = localDay()) {
  const out = new Set()
  for (const e of readDay(day)) {
    if (e?.event === 'free_exhausted' && (e.realm ?? 'cn') === realmId) out.add(e.model)
  }
  return out
}

export function cleanOldLogs(retentionDays) {
  if (!(retentionDays > 0)) return
  try {
    const cutoff = Date.now() - retentionDays * 86400_000
    for (const f of fs.readdirSync(LEDGER_DIR)) {
      const p = path.join(LEDGER_DIR, f)
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true }) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}
