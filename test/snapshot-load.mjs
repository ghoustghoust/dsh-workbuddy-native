// Regression guard: catalog.js runs its snapshot load at import time. A helper
// declared after that loop hit a TDZ ReferenceError, which the host swallows by
// skipping the whole bundle — the plugin silently stopped mounting. This test
// imports the module with real snapshot files present, which is the only shape
// that reaches the sanitize path at load time.
// Run: node test/snapshot-load.mjs

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-native-snap-'))
process.env.DSH_WB_NATIVE_DIR = tmp

fs.writeFileSync(path.join(tmp, 'catalog-cn.json'), JSON.stringify({
  models: {
    'glm-5.3': { id: 'glm-5.3', name: 'GLM\u202e 5.3', baseMultRaw: 'x2', contextWindow: 200000, maxTokens: 8000, supportsImages: true },
    evil: { id: 'evil', name: 'x'.repeat(400), baseMultRaw: 'x1', contextWindow: 1000, maxTokens: 10 },
    'no-id-here': { name: 'dropped, not a valid catalog entry', contextWindow: 0 },
  },
  promos: { 'glm-5.3': [{ id: 'p', enabled: true, priority: 1, modelIds: ['glm-5.3'], discount: { factor: 0.5 } }] },
  picker: ['glm-5.3', 'evil', 'not-in-models'],
  fetchedAt: '2026-01-01T00:00:00.000Z',
}))

let failures = 0
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a !== e) { failures++; console.log(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`) } else console.log(`ok   ${name} = ${a}`)
}

const catalog = await import('../lib/catalog.js')
check('module loads with a snapshot on disk', typeof catalog.getCatalog, 'function')
check('picker entries not backed by a model are dropped', catalog.getCatalog('cn').picker, ['glm-5.3', 'evil'])
check('bidi control characters are stripped from names', catalog.modelMeta('cn', 'glm-5.3').name, 'GLM 5.3')
check('over-long names are capped', catalog.modelMeta('cn', 'evil').name.length <= 60, true)
check('zero-context model is not resurrected from disk', catalog.modelMeta('cn', 'no-id-here'), null)
const price = await import('../lib/price.js')
check('snapshot promos still price correctly', price.effectivePrice('cn', 'glm-5.3', new Set())?.effective, 1)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
