import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseYaml, validateActorDocument, validateMigrationSql, validateRuntimeDocument } from '../src/index.mjs'
import { visualContractsToFiles } from '../src/visual-export.mjs'

test('visual contracts export to canonical files without hidden state', () => {
  const files = visualContractsToFiles('visual-pos', [{
    id: 'outlet',
    aggregateType: 'Outlet',
    key: 'outletId',
    objects: [{ name: 'Order', fields: 'id, total, status' }],
    actions: ['PlaceOrder', 'CapturePayment'],
    states: [{ obj: 'Order', flow: ['Open', 'Paid'] }],
  }])
  const runtime = parseYaml(files.runtimeYaml).value
  const actor = parseYaml(files.actors[0].actorYaml).value
  assert.deepEqual(validateRuntimeDocument(runtime), [])
  assert.deepEqual(validateActorDocument(actor), [])
  assert.deepEqual(validateMigrationSql(files.actors[0].migrationSql), [])
  assert.equal(JSON.stringify(files).includes('secret'), false)
})
