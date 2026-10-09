import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { DATA_DIR } from './config.js'
import { writeVaultDirect, readVaultForImport } from './authstore.js'

// One-time, read-only import of accounts created by the previous proxy plugin.
// The old data directory is never written to; a marker keeps re-imports from
// resurrecting accounts the user has since deleted.

// WB_TEST_LEGACY_DIR points the importer at a fixture directory; it exists for
// test/entry.mjs and is unset in normal use.
const OLD_DIR = process.env.WB_TEST_LEGACY_DIR || path.join(os.homedir(), '.dsh', 'plugins', 'workbuddy-proxy')
const FLAG = path.join(DATA_DIR, '.legacy-import.done')

function legacyRealmOf(a) {
  if (a?.realm === 'cn' || a?.realm === 'global') return a.realm
  const domain = String(a?.domain ?? '')
  if (domain.includes('workbuddy.ai')) return 'global'
  if (domain.includes('codebuddy.cn') || domain.includes('copilot.tencent.com') || domain.includes('codebuddy.qq.com')) return 'cn'
  return null
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function collectRealm(realmId) {
  const dir = path.join(OLD_DIR, 'auths', realmId)
  const out = []
  let entries = []
  try { entries = fs.readdirSync(dir) } catch { return out }
  const current = readJson(path.join(dir, 'current.json'))
  if (current?.accessToken) out.push({ account: current, preferred: true })
  for (const f of entries) {
    if (!f.endsWith('.json') || f === 'current.json') continue
    const a = readJson(path.join(dir, f))
    if (a?.accessToken) out.push({ account: a, preferred: false })
  }
  return out
}

/**
 * @returns {Promise<{imported: number, skipped: string} | null>} null when nothing was imported.
 */
export async function importLegacyAccounts() {
  if (fs.existsSync(FLAG)) return null
  if (!fs.existsSync(OLD_DIR)) {
    try { fs.writeFileSync(FLAG, JSON.stringify({ at: new Date().toISOString(), imported: 0, reason: 'no-legacy-dir' })) } catch { /* best effort */ }
    return null
  }
  let imported = 0
  for (const realmId of ['cn', 'global']) {
    const found = collectRealm(realmId)
    if (found.length === 0) continue
    const vault = await readVaultForImport(realmId)
    let preferredUid = vault.currentUid
    for (const { account, preferred } of found) {
      if (legacyRealmOf(account) !== realmId) continue
      const uid = account.uid
      if (!uid) continue
      if (vault.accounts[uid]) continue
      vault.accounts[uid] = {
        accessToken: account.accessToken,
        refreshToken: account.refreshToken ?? '',
        expiresAt: account.expiresAt ?? 0,
        uid,
        nickname: account.nickname,
        domain: account.domain,
        enterpriseId: account.enterpriseId,
        realm: realmId,
        updatedAt: account.updatedAt ?? new Date().toISOString(),
      }
      if (preferred && !preferredUid) preferredUid = uid
      imported++
    }
    vault.currentUid = preferredUid || (Object.keys(vault.accounts)[0] ?? '')
    if (imported) await writeVaultDirect(realmId, vault)
  }
  try { fs.writeFileSync(FLAG, JSON.stringify({ at: new Date().toISOString(), imported })) } catch { /* best effort */ }
  return imported ? { imported, skipped: 'legacy auths left untouched' } : null
}
