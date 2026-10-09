import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { REALMS } from './realms.js'

// Overridable so the offline test harness never writes into the live ledger.
export const DATA_DIR = process.env.DSH_WB_NATIVE_DIR
  ? path.resolve(process.env.DSH_WB_NATIVE_DIR)
  : path.join(os.homedir(), '.dsh', 'plugins', 'workbuddy-native')
export const LEDGER_DIR = path.join(DATA_DIR, 'ledger')
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json')

// The desktop client's own version, read from its config cache when possible:
// the backend gates the model catalog on this UA segment, so a stale hardcoded
// value silently shrinks the exposed model list.
export const FALLBACK_CLIENT_VERSION = '5.7.6'

const DEFAULTS = {
  realm: 'global', // the one exposed site: drives the picker routes and every UI surface
  defaultTransport: 'direct', // 'direct' | 'wbipc'
  dailyCreditBudget: 3000, // per site, 0 = unlimited
  perRequestCreditBudget: 1000, // runaway guard estimate, 0 = off
  contextWarnTokens: 200000, // advisory threshold, does not block
  logRetentionDays: 7,
  allowPaidOverride: false, // keep serving a model after its free quota is exhausted
  clientVersion: 'auto', // 'auto' reads the desktop cache; a string pins the value
  cliVersion: '2.137.1',
}

try { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }) } catch { /* exists */ }

function readDisk() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch { return {} }
}

let current = { ...DEFAULTS, ...readDisk() }

export function config() {
  return current
}

const NUMERIC_KEYS = ['dailyCreditBudget', 'perRequestCreditBudget', 'contextWarnTokens', 'logRetentionDays']
// Credit budgets are fractional (a single call can cost 0.3 credits), so only
// these two are truncated — truncating a budget would turn 0.3 into 0, which
// means "unlimited".
const INTEGER_KEYS = new Set(['contextWarnTokens', 'logRetentionDays'])
const VERSION_RE = /^\d+\.\d+\.\d+$/

/**
 * Config edits arrive from the panel and the agent tool. A string in a numeric
 * field would silently disable the money gate (`"300" > 0` is true but
 * `NaN > 0` is false), and `clientVersion` lands in a User-Agent header, so
 * every field is coerced or refused here rather than trusted downstream.
 */
export function saveConfig(patch) {
  const next = { ...current }
  for (const [key, raw] of Object.entries(patch ?? {})) {
    if (!(key in DEFAULTS)) return { config: current, error: `未知配置项 ${key}` }
    if (NUMERIC_KEYS.includes(key)) {
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0) return { config: current, error: `${key} 必须是不小于 0 的数字` }
      next[key] = INTEGER_KEYS.has(key) ? Math.trunc(n) : n
    } else if (key === 'allowPaidOverride') {
      next[key] = Boolean(raw)
    } else if (key === 'realm') {
      if (raw !== 'cn' && raw !== 'global') return { config: current, error: 'realm 只能是 cn 或 global' }
      next[key] = raw
    } else if (key === 'defaultTransport') {
      if (raw !== 'direct' && raw !== 'wbipc') return { config: current, error: 'defaultTransport 只能是 direct 或 wbipc' }
      next[key] = raw
    } else if (key === 'clientVersion') {
      if (raw !== 'auto' && !VERSION_RE.test(String(raw))) return { config: current, error: 'clientVersion 只能是 auto 或 x.y.z 版本号' }
      next[key] = String(raw)
    } else if (key === 'cliVersion') {
      if (!VERSION_RE.test(String(raw))) return { config: current, error: 'cliVersion 必须是 x.y.z 版本号' }
      next[key] = String(raw)
    } else {
      next[key] = raw
    }
  }
  current = next
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 }) } catch { /* in-memory still applies */ }
  return { config: current, error: null }
}

export function defaults() {
  return { ...DEFAULTS }
}

// Local calendar day, not UTC: budgets, price windows and log files all follow
// the user's clock (a UTC day would roll the budget at 08:00 in China).
export function localDay(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** @returns {{value: string, source: 'config'|'desktop-cache'|'fallback'}} */
export function clientVersionFor(realmId) {
  const cfg = config()
  if (cfg.clientVersion !== 'auto') return { value: String(cfg.clientVersion), source: 'config' }
  try {
    const cache = path.join(os.homedir(), REALMS[realmId]?.configDir ?? REALMS.cn.configDir, 'cache', 'acc-product-config-v3.json')
    const genie = JSON.parse(fs.readFileSync(cache, 'utf8'))?.genieVersion
    if (typeof genie === 'string' && /^\d+\.\d+\.\d+/.test(genie)) return { value: genie, source: 'desktop-cache' }
  } catch { /* desktop app absent */ }
  return { value: FALLBACK_CLIENT_VERSION, source: 'fallback' }
}
