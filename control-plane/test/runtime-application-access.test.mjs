import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { validateRuntimeApplicationCapabilities } from '../src/index.ts'

const contracts = [{
  id: 'outlet',
  name: 'Outlet',
  aggregateType: 'Outlet',
  key: 'outletId',
  objects: [{ name: 'Order' }],
  actions: ['PlaceOrder'],
  states: [],
  operations: [
    { definition: { name: 'PlaceOrder' } },
    { definition: { name: 'GetOrder' } },
  ],
}]

test('normalizes bounded application operation capabilities', () => {
  const capabilities = validateRuntimeApplicationCapabilities([{
    actor: 'Outlet',
    operations: ['PlaceOrder', 'GetOrder'],
    rateLimitPerMinute: 120,
    maxPayloadBytes: 32_768,
  }], contracts)
  assert.deepEqual(capabilities, [{
    actor: 'Outlet',
    operations: ['GetOrder', 'PlaceOrder'],
    rateLimitPerMinute: 120,
    maxPayloadBytes: 32_768,
  }])
})

test('rejects unknown operations, duplicate actors, and unsafe limits', () => {
  assert.equal(validateRuntimeApplicationCapabilities([{ actor: 'Outlet', operations: ['Unknown'] }], contracts), null)
  assert.equal(validateRuntimeApplicationCapabilities([
    { actor: 'Outlet', operations: ['GetOrder'] },
    { actor: 'Outlet', operations: ['PlaceOrder'] },
  ], contracts), null)
  assert.equal(validateRuntimeApplicationCapabilities([{
    actor: 'Outlet',
    operations: ['GetOrder'],
    rateLimitPerMinute: 0,
  }], contracts), null)
  assert.equal(validateRuntimeApplicationCapabilities([{
    actor: 'Outlet',
    operations: ['GetOrder'],
    maxPayloadBytes: 1_000_000,
  }], contracts), null)
})

test('credential storage and deployment policy never persist plaintext tokens', async () => {
  const migration = await readFile(new URL('../migrations/0016_runtime_application_access.sql', import.meta.url), 'utf8')
  const controlPlane = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(migration, /token_hash TEXT NOT NULL UNIQUE/)
  assert.doesNotMatch(migration, /token_value|plaintext_token/)
  assert.match(controlPlane, /LACIFY_APPLICATION_ACCESS_POLICY/)
  assert.match(controlPlane, /It is returned once/)
  assert.match(controlPlane, /runtime\.credential\.revoked/)
})
