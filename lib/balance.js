import { REALMS, realmOfId } from './realms.js'
import { config } from './config.js'
import { billingHeaders } from './headers.js'
import { getFreshAccount } from './login.js'
import { wbipc } from './wbipc.js'

// Real remaining credit, per package. The two sites answer different endpoints
// with different shapes, so identity follows the transport: under wbipc the
// desktop app signs the query (its account is the one being charged).

async function post(realmId, path, body) {
  if (config().defaultTransport === 'wbipc') {
    const res = await wbipc.httpFetch(realmId, {
      method: 'POST',
      path,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(body), 'utf8'),
    })
    const text = res.body.toString('utf8')
    if (res.status !== 200) throw new Error(`billing ${path} -> HTTP ${res.status}`)
    const parsed = JSON.parse(text)
    if (parsed == null) throw new Error(`billing ${path}: empty body`)
    return parsed
  }
  const realm = realmOfId(realmId)
  const account = await getFreshAccount(realmId)
  const res = await fetch(`${realm.billingBase}${path}`, {
    method: 'POST',
    headers: billingHeaders(account, realm),
    body: JSON.stringify(body),
  })
  const env = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`billing ${path} -> HTTP ${res.status}`)
  return env
}

function layout(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** @returns {Promise<{remain:number,total:number,packages:Array<{code:string,remain:number,total:number}>}>} */
export async function queryBalance(realmId) {
  const realm = realmOfId(realmId)
  if (realm.id === REALMS.global.id) {
    const env = await post(realmId, '/billing/meter/get-user-resource-summary', {})
    if (env?.code !== 0) throw new Error(`billing summary failed: code=${env?.code ?? '?'} msg=${env?.msg ?? 'unknown'}`)
    const pkgs = env?.data?.Packages ?? []
    const packages = pkgs.map((p) => ({
      code: String(p.PackageCode ?? p.PackageId ?? 'package'),
      remain: Math.max(0, Number(p.CycleRemainCapacity) || 0),
      total: Math.max(Number(p.CycleTotalCapacity) || 0, Number(p.CycleRemainCapacity) || 0),
    }))
    return { remain: packages.reduce((s, p) => s + p.remain, 0), total: packages.reduce((s, p) => s + p.total, 0), packages }
  }
  const env = await post(realmId, '/v2/billing/meter/get-user-resource', {
    PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3],
    PackageEndTimeRangeBegin: layout(new Date()),
    PackageEndTimeRangeEnd: layout(new Date(Date.now() + 365 * 101 * 86400_000)),
  })
  const accounts = env?.Response?.Data?.Accounts ?? env?.response?.data?.accounts ?? env?.data?.Response?.Data?.Accounts ?? []
  const packages = accounts.map((p, i) => {
    const remain = Math.max(0, p.CycleCapacitySize > 0 ? p.CycleCapacityRemain : p.CapacityRemain)
    const total = Math.max(p.CycleCapacitySize > 0 ? p.CycleCapacitySize : p.CapacitySize, remain)
    return { code: String(p.PackageCode ?? p.PackageId ?? `package-${i + 1}`), remain, total }
  })
  return { remain: packages.reduce((s, p) => s + p.remain, 0), total: packages.reduce((s, p) => s + p.total, 0), packages }
}
