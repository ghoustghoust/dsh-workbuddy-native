import { REALMS, isRealmId } from './realms.js'
import { config, saveConfig } from './config.js'
import { catalogInfo } from './catalog.js'
import { pricingList } from './price.js'
import { freeExhaustedSet, todaySpend } from './guard.js'
import { aggregateToday } from './ledger.js'
import { listAccounts, switchAccount, currentAccount, isUid } from './authstore.js'
import { queryBalance } from './balance.js'
import { ipcStatus } from './wbipc.js'

// The agent-facing tool. Registered as a plain definition object: the harness
// tools service accepts one, so no host package is imported at runtime — the
// missing-import fallback that killed the previous plugin's tool never exists.

function defaultRealm() {
  const fetched = Object.keys(REALMS)
    .map((id) => ({ id, at: catalogInfo(id).fetchedAt ?? '' }))
    .sort((a, b) => (a.at < b.at ? 1 : -1))
  return fetched[0]?.at ? fetched[0].id : 'cn'
}

function fmtPrice(x) {
  if (x.free && !x.exhausted) return `现在免费${x.note ? `（${x.note}）` : ''}`
  let t = `x${x.effective}`
  const detail = [
    ...(x.effective !== x.base ? [`原价 x${x.base}`] : []),
    ...(x.label ? [x.label] : []),
    ...(x.note ? [x.note] : []),
  ]
  return detail.length ? `${t}（${detail.join(' · ')}）` : t
}

export function registerWorkbuddyTool(tools) {
  if (!tools || typeof tools.register !== 'function') {
    return { registered: false, reason: `tools service unavailable (typeof=${typeof tools?.register})` }
  }
  const dispose = tools.register({
    name: 'workbuddy_account',
    description: 'Manage the WorkBuddy credit-billed model bridge on this machine: check remaining credits and today\'s spend, list or switch saved accounts, read live model prices, or switch the transport. Use when the user asks about WorkBuddy 积分/余额/账号/价格/传输模式.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['balance', 'usage', 'list', 'switch', 'pricing', 'transport', 'login'], description: 'what to do' },
        realm: { type: 'string', enum: ['cn', 'global'], description: 'site; defaults to the most recently refreshed site' },
        uid: { type: 'string', description: 'account uid, required for action=switch' },
        transport: { type: 'string', enum: ['direct', 'wbipc'], description: 'transport, required for action=transport' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const realmId = isRealmId(args?.realm) ? args.realm : defaultRealm()
      const label = REALMS[realmId].label
      switch (args?.action) {
        case 'balance': {
          try {
            const b = await queryBalance(realmId)
            const lines = b.packages.map((p) => `- ${p.code}: ${p.remain} / ${p.total}`)
            return `${label} 剩余积分 ${Math.round(b.remain * 100) / 100} / ${Math.round(b.total * 100) / 100}（${b.packages.length} 个套餐）\n${lines.join('\n')}`
          } catch (e) {
            return `余额查询失败：${e?.message ?? e}。未登录时请先在设置 → WorkBuddy 桥接 扫码登录。`
          }
        }
        case 'usage': {
          const day = aggregateToday(realmId)
          const budget = config().dailyCreditBudget
          const lines = day.models.map((m) => `- ${m.model}: ${Math.round(m.credit * 100) / 100} 积分 / ${m.calls} 次（缓存命中 ${m.promptTokens ? Math.round((m.cacheReadTokens / m.promptTokens) * 100) : 0}%）`)
          return `${label} 今日已用 ${Math.round(todaySpend(realmId) * 1000) / 1000} / ${budget > 0 ? budget : '∞'} 积分\n${lines.join('\n') || '（今天还没有请求）'}`
        }
        case 'list': {
          const accounts = await listAccounts(realmId)
          if (!accounts.length) return `${label} 还没有保存的账号。用 action=login 获取扫码链接。`
          return `${label} 已保存账号：\n${accounts.map((a) => `- ${a.nickname || a.uid}${a.current ? ' [当前]' : ''}（到期 ${a.expiresAt ? new Date(a.expiresAt).toLocaleDateString() : '未知'}）`).join('\n')}`
        }
        case 'switch': {
          if (!isUid(args?.uid)) return 'switch 需要合法的 uid（字母数字与 -_，≤64 字符），先用 action=list 查看已保存账号。'
          const account = await switchAccount(realmId, args.uid)
          return account ? `已切换到 ${account.nickname || account.uid}，下一个请求即生效，无需重启。` : `${label} 没有 uid=${args.uid} 的账号。`
        }
        case 'pricing': {
          const list = pricingList(realmId, freeExhaustedSet(realmId))
          if (!list.length) return `${label} 暂无价格数据（该站点登录后会自动拉取目录）。`
          return `${label} 当前有效价格：\n${list.map((x) => `- ${x.name} [${x.id}]: ${fmtPrice(x)}`).join('\n')}`
        }
        case 'transport': {
          if (!args?.transport) return `当前传输：${config().defaultTransport}。传 transport="direct" 或 "wbipc" 切换。`
          if (args.transport !== 'direct' && args.transport !== 'wbipc') return `未知传输 ${args.transport}；可选 direct 或 wbipc。`
          const notes = []
          if (args.transport === 'wbipc') {
            const status = ipcStatus(realmId)
            if (!status.online) notes.push('桌面端未在线，切过去会失败')
            notes.push('响应 640KB 上限会自动续写，请求 768KB 超限会明确报错')
          }
          const saved = saveConfig({ defaultTransport: args.transport })
          if (saved.error) return `切换失败：${saved.error}`
          return `已切换到 ${args.transport} 模式${notes.length ? `（${notes.join('；')}）` : ''}，下一个请求即生效。`
        }
        case 'login': {
          const account = await currentAccount(realmId)
          if (account) return `${label} 已登录为 ${account.nickname || account.uid}。要换账号请在设置 → WorkBuddy 桥接 点「扫码登录」。`
          return `请在 设置 → WorkBuddy 桥接 点「扫码登录」（${label}），扫码后自动检测，无需重启。`
        }
        default:
          return `未知 action：${args?.action}`
      }
    },
  })
  return { registered: true, reason: 'ok', dispose }
}
