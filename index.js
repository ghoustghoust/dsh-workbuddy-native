import { isRealmId } from './lib/realms.js'
import { config, localDay } from './lib/config.js'
import { cleanOldLogs, appendLedger } from './lib/ledger.js'
import { attachCredentials, currentAccount, migrateFileVaults } from './lib/authstore.js'
import { importLegacyAccounts } from './lib/legacy-import.js'
import { refreshCatalog } from './lib/catalog.js'
import { createAdapter, setAttachmentsService } from './lib/adapter.js'
import { createPanelHandler } from './lib/panel-api.js'
import { registerWorkbuddyTool } from './lib/tools.js'
import { closeAllWbipc } from './lib/wbipc.js'
import { hooks } from './lib/hooks.js'

export const name = 'workbuddy-native'
export const inject = ['llm']

const REFRESH_MS = 3600_000

export function apply(ctx) {
  // A throw escaping apply would take the whole fiber down with it, and this
  // bundle is hot-mounted into a running desktop app.
  try {
    mount(ctx)
  } catch (e) {
    report(ctx, 'mount', e)
  }
}

function report(ctx, stage, error) {
  const message = String(error?.message ?? error)
  try { ctx?.logger?.error?.(`workbuddy-native: ${stage} failed: ${error?.stack ?? error}`) } catch { /* logger unavailable */ }
  try { appendLedger({ event: 'stage_failed', realm: 'cn', stage, error: message }) } catch { /* nothing else to do */ }
}

/** Each optional seam is contained on its own: a broken tool must not cost the user their models. */
function tryMount(ctx, stage, fn) {
  try {
    fn()
  } catch (e) {
    report(ctx, stage, e)
  }
}

function mount(ctx) {
  cleanOldLogs(config().logRetentionDays)

  // Only the configured site is exposed: the picker, the panel and the capsule
  // all follow this one switch, and a realm change re-commits the routes live.
  const routesFor = () => [isRealmId(config().realm) ? 'workbuddy-' + config().realm : 'workbuddy-global']

  // The chat path is mounted first and alone: everything after it is optional
  // garnish, and none of it may be able to prevent the adapter from registering.
  const adapter = createAdapter({ onWarn: (entry) => appendLedger(entry) })
  let registration = null
  tryMount(ctx, 'adapter', () => {
    ctx.effect(() => {
      try {
        registration = ctx.llm.registerAdapter(routesFor(), adapter)
        appendLedger({ event: 'adapter', realm: config().realm, routes: routesFor().join(',') })
      } catch (e) {
        report(ctx, 'registerAdapter', e)
        registration = null
      }
      return () => {
        try { registration?.() } catch { /* already disposed */ }
        registration = null
      }
    })
  })

  tryMount(ctx, 'credentials', () => {
    ctx.inject(['credentials'], (scope) => {
      scope.effect(() => {
        attachCredentials(scope.credentials, { onLedger: (entry) => appendLedger(entry) })
        migrateFileVaults()
          .then((moved) => {
            if (moved.length) appendLedger({ event: 'credential_migrated', realm: moved[0], moved: moved.join(',') })
            // The startup refresh may have run before this seam existed and
            // skipped every realm; refresh again now that credentials resolve.
            scheduleRefresh('credentials-attached')
          })
          .catch((e) => report(ctx, 'credential-migrate', e))
        return () => attachCredentials(null)
      })
    })
  })

  tryMount(ctx, 'attachments', () => {
    ctx.inject(['attachments'], (scope) => {
      scope.effect(() => {
        setAttachmentsService(scope.attachments)
        return () => setAttachmentsService(null)
      })
    })
  })

  tryMount(ctx, 'tools', () => {
    ctx.inject(['tools'], (scope) => {
      scope.effect(() => {
        let result
        try {
          result = registerWorkbuddyTool(scope.tools)
        } catch (e) {
          report(ctx, 'tools', e)
          return () => {}
        }
        appendLedger({ event: 'tool', realm: 'cn', registered: result.registered, reason: result.reason })
        return () => result.dispose?.()
      })
    })
  })

  let day = localDay()
  let timer = null
  tryMount(ctx, 'refresh-loop', () => {
    ctx.effect(() => {
      timer = setInterval(() => {
        if (localDay() !== day) {
          day = localDay()
          cleanOldLogs(config().logRetentionDays)
        }
        scheduleRefresh('hourly')
      }, REFRESH_MS)
      timer.unref?.()
      importLegacyAccounts()
        .then((r) => r && appendLedger({ event: 'legacy_import', realm: 'cn', imported: r.imported }))
        .catch((e) => report(ctx, 'legacy-import', e))
        .finally(() => scheduleRefresh('startup'))
      return () => {
        if (timer) clearInterval(timer)
        closeAllWbipc()
      }
    })
  })

  // Panel API: the plugin's own UI channel only. LLM traffic never touches HTTP.
  tryMount(ctx, 'panel', () => {
    ctx.inject(['webServer'], (scope) => {
      scope.effect(() => {
        const handler = async (req, res) => {
          try {
            ;(await createPanelHandler({ refresh: scheduleRefresh }))(req, res)
          } catch (e) {
            try {
              res.writeHead(500, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ error: { message: String(e?.message ?? e) } }))
            } catch { /* socket gone */ }
          }
        }
        const dispose = scope.webServer.register({ kind: 'prefix', path: '/workbuddy-native', handler })
        appendLedger({ event: 'panel', realm: 'cn', mounted: true })
        return () => {
          try { dispose?.() } catch { /* already removed */ }
        }
      })
    })
  })

  // Coalescing must not drop a refresh: a request that arrives while one is in
  // flight sets a rerun flag instead of being swallowed. Dropping the post-login
  // refresh would leave the picker empty for up to an hour.
  let running = null
  let rerun = false
  function scheduleRefresh(reason) {
    if (running) {
      rerun = true
      return running
    }
    running = (async () => {
      do {
        rerun = false
        await refreshOnce(reason)
      } while (rerun)
    })().finally(() => { running = null })
    return running
  }

  async function refreshOnce(reason) {
    // Only the exposed site is refreshed: the hidden one's catalog goes stale,
    // which is fine — switching back re-refreshes before the picker needs it.
    const realmId = isRealmId(config().realm) ? config().realm : 'global'
    let changed = false
    let account = null
    try {
      account = await currentAccount(realmId)
    } catch (e) {
      report(ctx, `credential-read:${realmId}`, e)
    }
    if (!account) {
      appendLedger({ event: 'catalog_skipped', realm: realmId, reason: 'no credential for this realm' })
    } else {
      let result = null
      try {
        result = await refreshCatalog(realmId, account)
      } catch (e) {
        report(ctx, `catalog:${realmId}`, e)
      }
      if (result?.changed) changed = true
      if (result?.error) appendLedger({ event: 'catalog_error', realm: realmId, error: result.error, reason })
    }
    if (changed && registration) {
      try {
        registration.replace(routesFor())
      } catch (e) {
        // A failed re-commit means the picker keeps a stale list; say so loudly.
        report(ctx, 'catalog-replace', e)
        appendLedger({ event: 'catalog_replace_failed', realm: realmId, error: String(e?.message ?? e), reason })
      }
    }
    appendLedger({ event: 'catalog', realm: realmId, changed, reason })
  }

  hooks.onLoggedIn = (realmId) => {
    scheduleRefresh(`login:${realmId}`).catch((e) => report(ctx, 'refresh-after-login', e))
  }

  hooks.onRealmChanged = (realmId) => {
    try {
      registration?.replace(routesFor())
      appendLedger({ event: 'adapter', realm: realmId, routes: routesFor().join(','), reason: 'realm-switch' })
    } catch (e) {
      report(ctx, 'realm-replace', e)
    }
    scheduleRefresh(`realm-switch:${realmId}`).catch((e) => report(ctx, 'refresh-after-realm-switch', e))
  }
}
