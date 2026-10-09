// F13 cost experiments — these spend REAL credits. Gated behind WB_LIVE=1 so it
// never runs by accident. Budget guard: stops at 20 credits of cumulative spend.
// Run: WB_LIVE=1 node test/live.mjs

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

if (process.env.WB_LIVE !== '1') {
  console.log('skipped: set WB_LIVE=1 to run the credit-billing experiments')
  process.exit(0)
}

const CREDIT_BUDGET = 20

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-native-live-'))
process.env.DSH_WB_NATIVE_DIR = tmp

// Borrow a working credential from the previous plugin's store, read-only.
const legacy = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'plugins', 'workbuddy-proxy', 'auths', 'global', 'current.json'), 'utf8'))
fs.writeFileSync(path.join(tmp, 'vault-global.json'), JSON.stringify({ currentUid: legacy.uid, accounts: { [legacy.uid]: { ...legacy, realm: 'global' } } }))

const { config, saveConfig } = await import('../lib/config.js')
const catalog = await import('../lib/catalog.js')
const { streamDirect } = await import('../lib/direct.js')
const { buildChatBody } = await import('../lib/upstream.js')
saveConfig({ dailyCreditBudget: 0, perRequestCreditBudget: 0, contextWarnTokens: 0 })

const REFRESH = await catalog.refreshCatalog('global', legacy)
if (REFRESH.error) { console.log('catalog refresh failed:', REFRESH.error); process.exit(1) }
console.log(`catalog: ${REFRESH.count} selectable models\n`)

let spent = 0
async function call(model, messages, extra = {}) {
  if (spent >= CREDIT_BUDGET) throw new Error(`experiment budget ${CREDIT_BUDGET} credits reached`)
  const meta = catalog.modelMeta('global', model)
  const body = await buildChatBody({ provider: 'workbuddy-global', model, messages, ...extra }, meta, {})
  let usage = null
  let text = ''
  for await (const ev of streamDirect('global', JSON.stringify(body))) {
    if (ev.type === 'usage') usage = ev.usage
    if (ev.type === 'text') text += ev.text
  }
  spent += usage?.credit ?? 0
  console.log(`  ${model} → prompt ${usage?.prompt_tokens} | completion ${usage?.completion_tokens} | thinking ${usage?.completion_thinking_tokens} | cacheHit ${usage?.prompt_cache_hit_tokens} | cacheMiss ${usage?.prompt_cache_miss_tokens} | credit ${usage?.credit}  (running total ${spent.toFixed(2)})`)
  return { usage, text }
}

function pick(prefix) {
  return catalog.getCatalog('global').picker.find((id) => id.startsWith(prefix))
}

const filler = '项目背景资料：DeepSeek Harness 是一个基于 cordis 的插件化 agent 宿主。' + 'WorkBuddy 上游按积分计费，命中前缀缓存时输入侧大幅折价。'.repeat(60)
const question = '只用一句话回答：上文提到宿主插件体系基于哪个框架？'

console.log('E3 — 上游前缀缓存是否命中（同一前缀连打两次）')
const cheap = pick('deepseek-v4.1-flash')
const msgs = (q) => [
  { role: 'system', content: [{ type: 'text', text: '你是严谨的助理。' }] },
  { role: 'user', content: [{ type: 'text', text: filler + '\n\n' + q }] },
]
const first = await call(cheap, msgs(question))
const second = await call(cheap, msgs(question))

console.log('\nE1 — 长推理是否额外计费（同一输入，思考档位 low vs high）')
const reasonModel = catalog.getCatalog('global').picker.find((id) => catalog.modelMeta('global', id)?.supportsReasoning)
if (!reasonModel) console.log('  (该站点目录里没有声明支持推理的模型)')
else {
  const hard = [{ role: 'system', content: [{ type: 'text', text: '你是严谨的助理。' }] }, { role: 'user', content: [{ type: 'text', text: '一个水池有进水管和出水管，单开进水管 6 小时注满，单开出水管 8 小时放空，两管同开注满需多久？请给出完整推导。' }] }]
  await call(reasonModel, hard, { reasoningEffort: 'low' })
  await call(reasonModel, hard, { reasoningEffort: 'high' })
}

console.log('\nE2 — 免费额度耗尽后是否回原价（当前免费模型与历史计费证据）')
const { pricingList } = await import('../lib/price.js')
const freeNow = pricingList('global', new Set()).filter((x) => x.free)
console.log('  现在标免费的模型:', freeNow.map((x) => `${x.id}(原x${x.base})`).join(', ') || '(无)')
const oldLog = path.join(os.homedir(), '.dsh', 'plugins', 'workbuddy-proxy', 'logs', '2026-10-08.jsonl')
if (fs.existsSync(oldLog)) {
  const billed = new Map()
  for (const line of fs.readFileSync(oldLog, 'utf8').split('\n')) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e?.event !== 'request' || !(e.usage?.credit > 0)) continue
    billed.set(e.model, (billed.get(e.model) ?? 0) + e.usage.credit)
  }
  const overlap = [...billed].filter(([m]) => freeNow.some((f) => f.id === m))
  console.log('  昨天实际扣过积分的模型:', JSON.stringify(Object.fromEntries(billed)))
  console.log('  其中今天仍标免费的:', overlap.map(([m, c]) => `${m}=${c.toFixed(2)}`).join(', ') || '(无)')
}

console.log(`\n实验累计消耗 ${spent.toFixed(2)} 积分（预算 ${CREDIT_BUDGET}）`)
fs.rmSync(tmp, { recursive: true, force: true })
