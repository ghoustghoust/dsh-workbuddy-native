// Two account sites with different endpoints, headers and billing APIs.
// Each site is one permanent LLM provider route, so a request can never be
// sent to the other site's backend by a mid-flight site switch.
//
// WB_TEST_BASE_* / WB_TEST_BILLING_* redirect a site at a local stand-in; they
// exist for test/transports.mjs and are ignored in normal use.
const base = (realmId, kind, fallback) => process.env[`WB_TEST_${kind}_${realmId.toUpperCase()}`] || fallback

export const REALMS = {
  cn: {
    id: 'cn',
    route: 'workbuddy-cn',
    label: 'WorkBuddy 国内版',
    chatBase: base('cn', 'BASE', 'https://copilot.tencent.com'),
    billingBase: base('cn', 'BILLING', 'https://www.codebuddy.cn'),
    origin: 'https://www.codebuddy.cn',
    acceptLanguage: 'zh-CN',
    uaPlatform: 'WorkBuddy',
    configDir: '.workbuddy',
  },
  global: {
    id: 'global',
    route: 'workbuddy-global',
    label: 'WorkBuddy 国际版',
    chatBase: base('global', 'BASE', 'https://www.workbuddy.ai'),
    billingBase: base('global', 'BILLING', 'https://www.workbuddy.ai'),
    origin: 'https://www.workbuddy.ai',
    acceptLanguage: 'en-US',
    uaPlatform: 'WorkBuddy AI',
    configDir: '.workbuddy-ai',
  },
}

export const ROUTES = [REALMS.cn.route, REALMS.global.route]

export function realmOf(route) {
  return Object.values(REALMS).find((r) => r.route === route) ?? REALMS.cn
}

export function realmOfId(id) {
  return REALMS[id] ?? REALMS.cn
}

export function isRealmId(id) {
  return id === 'cn' || id === 'global'
}
