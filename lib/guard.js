import { config, localDay } from './config.js'
import { aggregateToday, exhaustedFreeModels, rebuildToday, readStateCache, writeStateCache, appendLedger } from './ledger.js'
import { effectivePrice } from './price.js'
import { modelMeta } from './catalog.js'

// Four gates in front of every billed request. The daily figure is rebuilt from
// the ledger because a cached counter that reads 0 while credits are gone is
// the exact failure this plugin shipped once with.

// One slot shared by both sites made the rebuild run on every cross-site call;
// the exhausted set was re-read from disk for every model in the picker, which
// stalls the catalog build. Both are cached per site per day now.
const spend = new Map() // realmId -> { date, credits }
const exhaustedCache = new Map() // realmId -> { date, set }

export function todaySpend(realmId) {
  const day = localDay()
  const cached = spend.get(realmId)
  if (cached && cached.date === day) return cached.credits
  const rebuilt = rebuildToday(realmId, day)
  const credits = rebuilt ? rebuilt.credits : (readStateCache(realmId)?.date === day ? readStateCache(realmId).credits ?? 0 : 0)
  spend.set(realmId, { date: day, credits })
  writeStateCache(realmId, { date: day, credits })
  return credits
}

export function addSpend(realmId, credit) {
  if (!(credit > 0)) return
  const day = localDay()
  const current = todaySpend(realmId)
  spend.set(realmId, { date: day, credits: current + credit })
  writeStateCache(realmId, { date: day, credits: spend.get(realmId).credits })
}

export function freeExhaustedSet(realmId) {
  const day = localDay()
  const cached = exhaustedCache.get(realmId)
  if (cached && cached.date === day) return cached.set
  const set = exhaustedFreeModels(realmId, day)
  exhaustedCache.set(realmId, { date: day, set })
  return set
}

/** Record that a "free" model was billed: its allowance is spent for the day. */
export function observeFreeUsage(realmId, modelId, usage) {
  if (!(usage?.credit > 0)) return false
  const ep = effectivePrice(realmId, modelId, freeExhaustedSet(realmId))
  if (!ep?.free) return false
  appendLedger({ event: 'free_exhausted', realm: realmId, model: modelId, credit: usage.credit })
  freeExhaustedSet(realmId).add(modelId)
  return true
}

function estimateCredits(realmId, modelId, body) {
  const ep = effectivePrice(realmId, modelId, freeExhaustedSet(realmId))
  if (!ep || ep.effective === null || ep.effective === undefined) return null
  let chars = 0
  for (const m of body?.messages ?? []) {
    chars += typeof m?.content === 'string' ? m.content.length : JSON.stringify(m?.content ?? '').length
  }
  for (const t of body?.tools ?? []) chars += JSON.stringify(t).length
  // ~3 chars/token holds for Latin text; Chinese is closer to 1.5. The
  // estimate uses the conservative middle so this user's own language does not
  // slip past the runaway gate.
  const inputTokens = Math.ceil(chars / 2)
  const meta = modelMeta(realmId, modelId)
  const outputTokens = Math.min(body?.max_tokens ?? meta?.maxTokens ?? 8192, meta?.maxTokens ?? 8192)
  return Math.round(((inputTokens + outputTokens) / 1000) * ep.effective * 10) / 10
}

function approxTokens(body) {
  let chars = 0
  for (const m of body?.messages ?? []) chars += typeof m?.content === 'string' ? m.content.length : JSON.stringify(m?.content ?? '').length
  return Math.ceil(chars / 2)
}

/**
 * @returns {{ok: true, warn: string|null} | {ok:false, code:string, message:string, hint?:string, nextFreeAt?:number}}
 */
export function checkRequest(realmId, modelId, body) {
  const cfg = config()
  const ep = effectivePrice(realmId, modelId, freeExhaustedSet(realmId))

  if (cfg.dailyCreditBudget > 0 && todaySpend(realmId) >= cfg.dailyCreditBudget) {
    const spent = Math.round(todaySpend(realmId) * 1000) / 1000
    return {
      ok: false,
      code: 'BUDGET_EXHAUSTED',
      message: `今日积分预算已用尽：${spent} / ${cfg.dailyCreditBudget}`,
      hint: '提高配置中的 dailyCreditBudget（0 = 不限制）或明日再试',
    }
  }

  if (ep?.exhausted && !cfg.allowPaidOverride) {
    return {
      ok: false,
      code: 'FREE_QUOTA_EXHAUSTED',
      message: `${modelId} ${ep.note}`,
      hint: '打开 allowPaidOverride 可按原价继续，或等待免费窗口重开',
      nextFreeAt: ep.nextFreeAt ?? null,
    }
  }

  if (cfg.perRequestCreditBudget > 0) {
    const est = estimateCredits(realmId, modelId, body)
    if (est !== null && est > cfg.perRequestCreditBudget) {
      return {
        ok: false,
        code: 'REQUEST_TOO_EXPENSIVE',
        message: `本次请求预估约 ${est} 积分，超过单次上限 ${cfg.perRequestCreditBudget}`,
        hint: '上下文过大（疑似 agent 循环）。提高 perRequestCreditBudget（0 = 不限制）或缩短上下文',
      }
    }
  }

  let warn = null
  if (cfg.contextWarnTokens > 0 && approxTokens(body) > cfg.contextWarnTokens) {
    warn = `上下文约 ${Math.round(approxTokens(body) / 1000)}k token，超过预警阈值 ${Math.round(cfg.contextWarnTokens / 1000)}k`
  }
  return { ok: true, warn }
}

export { aggregateToday }
