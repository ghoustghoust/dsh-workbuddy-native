import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { DATA_DIR } from './config.js'
import { isRealmId } from './realms.js'

// Credential storage prefers the harness credential seam (the same store the
// first-party account platform writes into). When the seam is unavailable the
// store degrades to files in the plugin data directory — and the UI reports
// which one is actually holding the tokens, because a badge that claims
// "in the vault" while a plaintext file holds them is worse than no badge.

const SCOPE = 'workbuddy-native'
const UID_RE = /^[\w-]{1,64}$/

let seam = null
let ledgerSink = null
const storeMode = new Map() // 'cn' | 'global' | 'panel' -> 'vault' | 'file' | 'unknown'
// When a seam write fails, reads must prefer the (fresher) fallback copy until
// a heal succeeds — otherwise the stale vault copy wins and switches "do not
// happen". Expired broken state triggers one heal attempt per read.
const seamBrokenUntil = new Map()
const SEAM_BROKEN_MS = Number(process.env.WB_SEAM_BROKEN_MS ?? 5 * 60_000)
let lastError = null

export function attachCredentials(credentials, { onLedger } = {}) {
  seam = credentials ?? null
  ledgerSink = onLedger ?? null
  storeMode.clear()
  lastError = null
}

export function credentialStoreMode(key) {
  return storeMode.get(key) ?? 'unknown'
}

export function credentialStoreError() {
  return lastError
}

export function isDegraded() {
  return seam === null
}

function recordKey(realmId) {
  return `${SCOPE}/${realmId}`
}

function fallbackFile(name) {
  return path.join(DATA_DIR, `${name}.json`)
}

function readFallback(name) {
  try { return JSON.parse(fs.readFileSync(fallbackFile(name), 'utf8')) } catch { return null }
}

function writeFallback(name, value) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    fs.writeFileSync(fallbackFile(name), JSON.stringify(value, null, 2), { mode: 0o600 })
    try { fs.chmodSync(fallbackFile(name), 0o600) } catch { /* best effort on win32 */ }
  } catch { /* caller keeps the in-memory state */ }
}

function emptyVault() {
  const accounts = Object.create(null)
  return { currentUid: '', accounts }
}

/**
 * Account maps are keyed by values that arrive from the network and from the
 * agent tool, so they must not inherit Object.prototype: `accounts.__proto__`
 * used to read as "exists" and let a switch to a bogus uid silently disable
 * the real account while sending `Bearer undefined` upstream.
 */
function normalizeVault(raw) {
  const vault = emptyVault()
  const source = raw && typeof raw === 'object' ? raw : {}
  if (typeof source.currentUid === 'string' && UID_RE.test(source.currentUid)) vault.currentUid = source.currentUid
  const accounts = source.accounts && typeof source.accounts === 'object' ? source.accounts : {}
  for (const [uid, a] of Object.entries(accounts)) {
    if (!UID_RE.test(uid)) continue
    if (!a || typeof a !== 'object' || typeof a.accessToken !== 'string' || !a.accessToken) continue
    vault.accounts[uid] = { ...a, uid }
  }
  if (vault.currentUid && !vault.accounts[vault.currentUid]) vault.currentUid = Object.keys(vault.accounts)[0] ?? ''
  return vault
}

function sameVault(a, b) {
  return JSON.stringify({ current: a.currentUid, accounts: a.accounts }) === JSON.stringify({ current: b.currentUid, accounts: b.accounts })
}

function noteStore(key, op, mode, error) {
  lastError = error ? `${key} ${op}: ${error?.message ?? error}` : null
  storeMode.set(key, mode)
  if (ledgerSink) ledgerSink({ event: 'credential_store', realm: isRealmId(key) ? key : 'cn', key, op, mode, error: error ? String(error?.message ?? error).slice(0, 200) : null })
}

/**
 * Invariant: a successful vault write deletes the fallback file and a degraded
 * write updates it — so a fallback file that EXISTS is always newer than the
 * vault record, even across restarts. Reads therefore prefer it and heal the
 * vault from it; migrateFileVaults relies on the same rule.
 */
function fallbackExists(realmId) {
  try { fs.accessSync(fallbackFile(`vault-${realmId}`)); return true } catch { return false }
}

async function readVault(realmId) {
  const broken = (seamBrokenUntil.get(realmId) ?? 0) > Date.now()
  const haveFallback = fallbackExists(realmId)
  if (seam && !broken && !haveFallback) {
    try {
      const record = await seam.readRecord(recordKey(realmId))
      const vault = normalizeVault(record?.payload?.vault)
      if (vault.currentUid || Object.keys(vault.accounts).length) {
        storeMode.set(realmId, 'vault')
        return vault
      }
    } catch (e) {
      noteStore(realmId, 'read', 'file', e) // a seam hiccup must not log the user out
    }
  }
  const fallback = normalizeVault(readFallback(`vault-${realmId}`))
  if (fallback.currentUid || Object.keys(fallback.accounts).length) {
    // The fallback copy is what the user actually did most recently; while the
    // seam write path is broken it wins outright, otherwise heal the vault.
    if (broken) {
      storeMode.set(realmId, 'file')
      return fallback
    }
    if (await healSeamVault(realmId, fallback)) {
      storeMode.set(realmId, 'vault')
      return fallback
    }
    storeMode.set(realmId, 'file')
    return fallback
  }
  return fallback
}

/**
 * Push the fallback copy back into the vault. Returns true when the vault
 * verifies; false leaves the fallback in place and re-arms the broken window.
 */
async function healSeamVault(realmId, vault) {
  try {
    await writeVaultToSeam(realmId, vault)
  } catch (e) {
    seamBrokenUntil.set(realmId, Date.now() + SEAM_BROKEN_MS)
    noteStore(realmId, 'heal', 'file', e)
    return false
  }
  noteStore(realmId, 'write', 'vault', null)
  seamBrokenUntil.delete(realmId)
  try { fs.rmSync(fallbackFile(`vault-${realmId}`), { force: true }) } catch { /* nothing to retire */ }
  return true
}

/** Plain-prototype deep clone: the seam rejects null-prototype objects, and the
 * account map is deliberately null-prototyped against prototype pollution. */
function toPlainJson(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

async function writeVaultToSeam(realmId, vault) {
  await seam.modifyRecord(recordKey(realmId), (existing) => {
    const payload = existing?.payload && typeof existing.payload === 'object' ? existing.payload : {}
    return {
      kind: existing?.kind ?? 'grant',
      payload: JSON.parse(JSON.stringify({ ...payload, version: 1, vault })),
    }
  })
  const back = normalizeVault((await seam.readRecord(recordKey(realmId)))?.payload?.vault)
  if (!sameVault(back, vault)) throw new Error('credential record read-back did not match')
}

/**
 * Write through the seam when present, then read back and compare in full: a
 * partial or ignored write must never retire the only good copy.
 */
async function writeVault(realmId, vault) {
  if (seam) {
    try {
      await writeVaultToSeam(realmId, vault)
      noteStore(realmId, 'write', 'vault', null)
      seamBrokenUntil.delete(realmId)
      try { fs.rmSync(fallbackFile(`vault-${realmId}`), { force: true }) } catch { /* nothing to retire */ }
      return
    } catch (e) {
      seamBrokenUntil.set(realmId, Date.now() + SEAM_BROKEN_MS)
      noteStore(realmId, 'write', 'file', e)
    }
  }
  storeMode.set(realmId, 'file')
  writeFallback(`vault-${realmId}`, vault)
}

export function isUid(value) {
  return typeof value === 'string' && UID_RE.test(value)
}

export async function listAccounts(realmId) {
  if (!isRealmId(realmId)) return []
  const vault = await readVault(realmId)
  return Object.entries(vault.accounts).map(([uid, a]) => ({
    uid,
    nickname: a.nickname,
    expiresAt: a.expiresAt ?? 0,
    updatedAt: a.updatedAt,
    current: uid === vault.currentUid,
  }))
}

export async function currentAccount(realmId) {
  if (!isRealmId(realmId)) return null
  const vault = await readVault(realmId)
  if (!vault.currentUid) return null
  const account = vault.accounts[vault.currentUid]
  if (!account) return null
  return { ...account, realm: realmId, uid: vault.currentUid }
}

/** Merge one account into the realm vault and make it current. */
export async function saveAccount(realmId, account) {
  if (!isRealmId(realmId) || !account?.accessToken) return null
  const uid = account.uid && isUid(account.uid) ? account.uid : crypto.randomUUID()
  const merged = { ...account, uid, updatedAt: new Date().toISOString(), realm: realmId }
  const vault = await readVault(realmId)
  vault.accounts[uid] = { ...vault.accounts[uid], ...merged }
  vault.currentUid = uid
  await writeVault(realmId, vault)
  return { ...vault.accounts[uid], realm: realmId }
}

/** A refresh must not move the current pointer if the user switched mid-flight. */
export async function updateAccountTokens(realmId, uid, patch) {
  if (!isUid(uid)) return null
  const vault = await readVault(realmId)
  if (!vault.accounts[uid]) return null
  vault.accounts[uid] = { ...vault.accounts[uid], ...patch, updatedAt: new Date().toISOString() }
  await writeVault(realmId, vault)
  return vault.accounts[uid]
}

export async function switchAccount(realmId, uid) {
  if (!isRealmId(realmId) || !isUid(uid)) return null
  const vault = await readVault(realmId)
  if (!vault.accounts[uid]) return null
  vault.currentUid = uid
  await writeVault(realmId, vault)
  return { ...vault.accounts[uid], realm: realmId, uid }
}

export async function removeAccount(realmId, uid) {
  if (!isUid(uid)) return false
  const vault = await readVault(realmId)
  if (!vault.accounts[uid]) return false
  delete vault.accounts[uid]
  if (vault.currentUid === uid) vault.currentUid = Object.keys(vault.accounts)[0] ?? ''
  await writeVault(realmId, vault)
  return true
}

/**
 * The credentials seam can mount after startup work has already written the
 * fallback files, which would strand tokens in plaintext forever. Move any
 * file-only vault into the vault once the seam exists.
 */
export async function migrateFileVaults() {
  if (!seam) return []
  const moved = []
  for (const realmId of ['cn', 'global']) {
    const file = normalizeVault(readFallback(`vault-${realmId}`))
    if (!file.currentUid && !Object.keys(file.accounts).length) continue
    // A fallback file only exists when a degraded write happened after the last
    // successful vault write, so its copy is newer — heal even if the vault
    // record is non-empty (that record is the stale side of the split).
    await writeVault(realmId, file)
    if (storeMode.get(realmId) === 'vault') moved.push(realmId)
  }
  return moved
}

/**
 * Shared secret for the panel API. Resolved lazily (per request) so it lands
 * in the vault once the credentials seam exists rather than being minted into
 * a plaintext file during startup.
 */
export async function panelToken() {
  const key = `${SCOPE}/panel`
  if (seam) {
    try {
      const record = await seam.readRecord(key)
      const token = record?.payload?.token
      if (typeof token === 'string' && token.length >= 16) {
        storeMode.set('panel', 'vault')
        try { fs.rmSync(fallbackFile('panel'), { force: true }) } catch { /* nothing to retire */ }
        return token
      }
    } catch (e) {
      noteStore('panel', 'read', 'file', e)
    }
  }
  const existing = readFallback('panel')?.token
  const token = typeof existing === 'string' && existing.length >= 16 ? existing : crypto.randomBytes(24).toString('base64url')
  if (seam) {
    try {
      await seam.modifyRecord(key, () => ({ kind: 'grant', payload: { version: 1, token } }))
      const back = await seam.readRecord(key)
      if (back?.payload?.token === token) {
        noteStore('panel', 'write', 'vault', null)
        try { fs.rmSync(fallbackFile('panel'), { force: true }) } catch { /* nothing to retire */ }
        return token
      }
      noteStore('panel', 'verify', 'file', new Error('panel token read-back did not match'))
    } catch (e) {
      noteStore('panel', 'write', 'file', e)
    }
  }
  storeMode.set('panel', 'file')
  writeFallback('panel', { token })
  return token
}

export async function writeVaultDirect(realmId, vault) {
  await writeVault(realmId, normalizeVault(vault))
}

/** Snapshot used by the one-time legacy import; never mutates anything. */
export async function readVaultForImport(realmId) {
  return readVault(realmId)
}

export { SCOPE }
