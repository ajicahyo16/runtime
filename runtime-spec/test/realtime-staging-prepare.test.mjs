import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

test('staging qualification preparation is isolated and contains no secret values', async () => {
  const source = await readFile(path.join(import.meta.dirname, '../../scripts/realtime-staging-prepare.mjs'), 'utf8')
  assert.match(source, /qualification-staging/)
  assert.match(source, /productionResourcesReferenced: false/)
  assert.match(source, /secretValuesIncluded: false/)
  assert.match(source, /workers_dev = true/)
  assert.doesNotMatch(source, /runtime\.getlacify\.com/)
  assert.doesNotMatch(source, /LACIFY_[A-Z_]+\\s*[:=]\\s*['"][^'"]+['"]/)
})
