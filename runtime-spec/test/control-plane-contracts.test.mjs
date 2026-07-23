import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalProjectToContracts } from '../src/control-plane-contracts.mjs'
import { loadRuntimeProject } from '../src/index.mjs'

test('canonical project compiles into deterministic Control Plane contracts', async () => {
  const project = await loadRuntimeProject(new URL('../fixtures/pos/lacify.runtime.yaml', import.meta.url))
  const contracts = canonicalProjectToContracts(project)
  assert.equal(contracts[0].aggregateType, 'Outlet')
  assert.equal(contracts[0].key, 'outletId')
  assert.ok(contracts[0].objects.some(({ name }) => name === 'Orders'))
  assert.ok(contracts[0].actions.includes('PlaceOrder'))
  assert.deepEqual(contracts[0].operations.map(({ definition }) => definition.name), ['GetOrder', 'ListOrders', 'PlaceOrder'])
  assert.equal(JSON.stringify(contracts).includes('seed-order'), false)
})
