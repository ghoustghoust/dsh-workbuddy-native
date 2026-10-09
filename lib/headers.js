import * as crypto from 'crypto'
import { config, clientVersionFor } from './config.js'

// Header families mirroring the official desktop/CLI clients. The backend
// selects the catalog, promotions and billing behaviour from these, so each
// family is reproduced verbatim rather than approximated.

export function msgId() {
  return crypto.randomUUID().replace(/-/g, '')
}

export function hex36(seed) {
  return crypto.createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 36)
}

export function threeSegmentUA(realm) {
  const { value } = clientVersionFor(realm.id)
  return `WorkBuddy/${value} ${realm.uaPlatform}/${value} CLI/${config().cliVersion}`
}

export function loginHeaders(realm) {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/plain, */*',
    'x-requested-with': 'XMLHttpRequest',
    origin: realm.origin,
    referer: realm.origin + '/',
    'user-agent': `CLI/${config().cliVersion} CodeBuddy/${config().cliVersion}`,
    'x-codebuddy-request': '1',
    'accept-language': realm.acceptLanguage,
  }
}

export function stableHeaders(uid) {
  return {
    'x-machine-id': hex36(`wb2a:machine:${uid}`),
    'x-session-id': hex36(`wb2a:session:${uid}`),
  }
}

export function chatHeaders(account, convReqId, realm) {
  const messageId = msgId()
  const { value: clientVersion } = clientVersionFor(realm.id)
  const h = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-requested-with': 'XMLHttpRequest',
    origin: realm.origin,
    referer: realm.origin + '/',
    'user-agent': threeSegmentUA(realm),
    'x-codebuddy-request': '1',
    'accept-language': realm.acceptLanguage,
    authorization: `Bearer ${account.accessToken}`,
    'x-agent-purpose': 'conversation',
    'x-ide-name': 'WorkBuddy',
    'x-ide-type': 'WorkBuddy',
    'x-ide-version': clientVersion,
    'x-product': 'WorkBuddy',
    'x-conversation-request-id': convReqId,
    'x-conversation-message-id': messageId,
    'x-request-id': messageId,
    'x-root-request-id': convReqId,
    'x-trace-id': convReqId,
    'x-b3-traceid': convReqId,
    'x-b3-spanid': messageId.slice(0, 16),
    'x-b3-sampled': '1',
  }
  if (account.uid) h['x-user-id'] = account.uid
  else h['x-no-user-id'] = '1'
  if (account.enterpriseId) h['x-enterprise-id'] = account.enterpriseId
  else h['x-no-enterprise-id'] = '1'
  if (account.domain) h['x-domain'] = account.domain
  else h['x-no-department-info'] = '1'
  if (account.uid) Object.assign(h, stableHeaders(account.uid))
  return h
}

export function catalogHeaders(account, realm) {
  const { value: clientVersion } = clientVersionFor(realm.id)
  return {
    accept: 'application/json, text/plain, */*',
    'x-requested-with': 'XMLHttpRequest',
    authorization: `Bearer ${account.accessToken}`,
    'x-user-id': account.uid ?? '',
    'x-domain': new URL(realm.chatBase).host,
    'x-product': 'SaaS',
    'user-agent': threeSegmentUA(realm),
    'x-codebuddy-request': '1',
    'accept-language': realm.acceptLanguage,
    'x-ide-version': clientVersion,
  }
}

export function billingHeaders(account, realm) {
  const { value: clientVersion } = clientVersionFor(realm.id)
  const h = {
    authorization: `Bearer ${account.accessToken}`,
    accept: 'application/json',
    'content-type': 'application/json',
    'x-codebuddy-request': '1',
    'accept-language': realm.acceptLanguage,
    'user-agent': `WorkBuddy/${clientVersion}`,
  }
  if (account.uid) h['x-user-id'] = account.uid
  if (account.enterpriseId) { h['x-enterprise-id'] = account.enterpriseId; h['x-tenant-id'] = account.enterpriseId }
  if (account.domain) h['x-domain'] = account.domain
  return h
}
