import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

test('staging qualifier keeps secret values ephemeral and production out of scope', async () => {
  const source = await readFile(path.join(import.meta.dirname, '../../scripts/realtime-staging-qualify.mjs'), 'utf8')
  assert.match(source, /productionMutation: false/)
  assert.match(source, /secretValuesIncluded: false/)
  assert.match(source, /randomBytes\(32\)/)
  assert.doesNotMatch(source, /runtime\\.getlacify\\.com/)
  assert.doesNotMatch(source, /writeFile/)
})
