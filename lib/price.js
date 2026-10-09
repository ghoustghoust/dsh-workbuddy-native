import { getCatalog, modelMeta, safeText } from './catalog.js'

// Effective pricing for "right now": base multiplier, active promotion, whether
// the free allowance is already spent, and when the next free window opens.
// Promotion windows are Asia/Shanghai wall clock and have no DST.

const SH_OFFSET_MS = 8 * 3600_000

function nowSH() {
  return new Date(Date.now() + SH_OFFSET_MS) // read with UTC getters
}

export function parseMult(credits) {
  const m = /x([\d.]+)/.exec(credits || '')
  return m ? parseFloat(m[1]) : null
}

function inDailyWindow(dSH, daily) {
  if (!daily?.length) return true
  const minutes = dSH.getUTCHours() * 60 + dSH.getUTCMinutes()
  return daily.some((w) => {
    const [sh, sm] = String(w.start ?? '').split(':').map(Number)
    const [eh, em] = String(w.end ?? '').split(':').map(Number)
    if (Number.isNaN(sh) || Number.isNaN(eh)) return true
    const s = sh * 60 + (sm || 0)
    const e = eh * 60 + (em || 0)
    // overnight window (e.g. 23:00 -> 7:50) wraps around midnight
    return s <= e ? minutes >= s && minutes <= e : minutes >= s || minutes <= e
  })
}

export function promoActive(p, atMs = Date.now()) {
  if (!p?.enabled) return false
  if (p.schedule?.validFrom && atMs < Date.parse(p.schedule.validFrom)) return false
  if (p.schedule?.validUntil && atMs > Date.parse(p.schedule.validUntil)) return false
  return inDailyWindow(new Date(atMs + SH_OFFSET_MS), p.schedule?.daily)
}

function windowNote(p) {
  return (p?.schedule?.daily ?? []).map((w) => `${w.start}-${w.end}`).join('/')
}

/** Next daily-window opening after now, as epoch ms; null when not derivable. */
function nextWindowStart(promo) {
  const daily = promo?.schedule?.daily
  if (!daily?.length) return null
  const d = nowSH()
  const minutesNow = d.getUTCHours() * 60 + d.getUTCMinutes()
  let best = null
  for (const w of daily) {
    const [sh, sm] = String(w.start ?? '').split(':').map(Number)
    if (Number.isNaN(sh)) continue
    const start = sh * 60 + (sm || 0)
    const delta = start > minutesNow ? (start - minutesNow) : (1440 - minutesNow + start)
    if (best === null || delta < best) best = delta
  }
  return best === null ? null : Date.now() + best * 60_000
}

/**
 * @param exhaustedSet set of model ids whose free allowance is already spent today
 */
export function effectivePrice(realmId, modelId, exhaustedSet) {
  const m = modelMeta(realmId, modelId)
  const base = parseMult(m?.baseMultRaw)
  if (!m || base === null) return null
  let best = null
  for (const p of getCatalog(realmId).promos[modelId] ?? []) {
    if (!promoActive(p)) continue
    if (!best || (p.priority ?? 0) > (best.priority ?? 0)) best = p
  }
  const exhausted = !!exhaustedSet?.has(modelId)
  // While a 0x promo is live the vendor reports the model's own multiplier as
  // already-discounted (x0.00), so the original price is genuinely unknown
  // until the upstream bills for it. Claiming "原价 x0" would be a lie.
  const baseUnknown = base === 0 && best?.discount?.factor === 0
  const nextFreeAt = best?.discount?.factor === 0 ? nextWindowStart(best) : null
  if (best?.discount && !exhausted) {
    const f = best.discount.factor
    const note = safeText(windowNote(best) || (best.hover?.textZh ?? ''), 140)
    if (f === 0) {
      return { base, baseUnknown, effective: 0, free: true, exhausted: false, label: safeText(best.badge?.label ?? '限时免费', 40), note, nextFreeAt }
    }
    if (typeof f === 'number') {
      return { base, baseUnknown: false, effective: Math.round(base * f * 100) / 100, free: false, exhausted: false, label: safeText(best.badge?.label ?? '', 40), note, nextFreeAt }
    }
  }
  // badge-only promo: price unchanged, surface the vendor's own explanation
  const hover = safeText(best?.hover?.textZh ?? '', 140)
  return {
    base,
    baseUnknown,
    effective: base,
    free: false,
    exhausted,
    label: best?.badge?.label ?? '',
    note: exhausted ? nextFreeHint(nextFreeAt, baseUnknown) : hover || windowNote(best),
    nextFreeAt: exhausted ? nextFreeAt : null,
  }
}

export function nextFreeHint(nextFreeAt, baseUnknown = false) {
  const pricePart = baseUnknown ? '免费已用完，按上游实际价格计费' : '已回原价'
  if (!nextFreeAt) return `${pricePart}（上游未给出下一次免费时间，通常按日重置）`
  const mins = Math.max(1, Math.round((nextFreeAt - Date.now()) / 60_000))
  const h = Math.floor(mins / 60)
  return `${pricePart}，下一次免费在 ${h > 0 ? `${h} 小时 ` : ''}${mins % 60} 分钟后`
}

export function renderName(baseName, modelId, ep) {
  if (!ep) return baseName
  if (ep.free && !ep.exhausted) return `${baseName} (现免费)`
  if (ep.exhausted) return ep.baseUnknown ? `${baseName} (免费已用完)` : `${baseName} (原价x${ep.base}·免费已用完)`
  return ep.effective === ep.base ? `${baseName} (x${ep.base})` : `${baseName} (x${ep.effective}·原价x${ep.base})`
}

/** Picker-shaped model list: exactly the realm's live whitelist. */
export function exposedModels(realmId, exhaustedSet) {
  const catalog = getCatalog(realmId)
  const out = []
  for (const id of catalog.picker) {
    const m = catalog.models[id]
    if (!m) continue
    const ep = effectivePrice(realmId, id, exhaustedSet)
    out.push({
      id,
      name: renderName(m.name, id, ep),
      input: m.supportsImages ? ['text', 'image'] : ['text'],
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      price: ep,
    })
  }
  // Distinct ids can share a display name; only colliding labels get the id appended.
  const count = new Map()
  for (const m of out) count.set(m.name, (count.get(m.name) ?? 0) + 1)
  for (const m of out) if (count.get(m.name) > 1) m.name = `${m.name}·${m.id}`
  return out
}

export function pricingList(realmId, exhaustedSet) {
  const out = []
  for (const e of exposedModels(realmId, exhaustedSet)) {
    const ep = e.price
    if (!ep) continue
    out.push({
      id: e.id,
      name: modelMeta(realmId, e.id)?.name ?? e.id,
      base: ep.base,
      baseUnknown: !!ep.baseUnknown,
      effective: ep.effective,
      free: !!ep.free,
      exhausted: !!ep.exhausted,
      label: ep.label ?? '',
      note: ep.note ?? '',
      nextFreeAt: ep.nextFreeAt ?? null,
    })
  }
  return out.sort((a, b) => (a.effective ?? 9) - (b.effective ?? 9))
}
