import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { loadRuntimeProject } from '../src/index.mjs'
import { executeLocalOperation } from '../src/local-runtime.mjs'

async function setup() {
  const project = await loadRuntimeProject(new URL('../fixtures/pos/lacify.runtime.yaml', import.meta.url))
  assert.equal(project.valid, true, JSON.stringify(project.issues))
  const actor = project.project.actors[0]
  const database = new DatabaseSync(':memory:')
  for (const migration of actor.migrations) database.exec(migration.sql)
  return { actor, database }
}

test('executes typed commands and partition-scoped queries against local SQLite', async () => {
  const { actor, database } = await setup()
  const created = executeLocalOperation(database, actor, {
    partition: 'outlet-a',
    operation: 'PlaceOrder',
    input: { orderId: 'order-1', total: 1250 },
    idempotencyKey: 'request-1',
    now: () => 1_700_000_000_000,
  })
  assert.deepEqual(JSON.parse(JSON.stringify(created.data)), { id: 'order-1', total: 1250, status: 'Confirmed' })
  const replay = executeLocalOperation(database, actor, {
    partition: 'outlet-a',
    operation: 'PlaceOrder',
    input: { total: 1250, orderId: 'order-1' },
    idempotencyKey: 'request-1',
  })
  assert.equal(replay.replayed, true)
  assert.throws(() => executeLocalOperation(database, actor, {
    partition: 'outlet-a',
    operation: 'PlaceOrder',
    input: { orderId: 'different-input-is-blocked', total: 9999 },
    idempotencyKey: 'request-1',
  }), /different input/)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 1)
  assert.equal(executeLocalOperation(database, actor, {
    partition: 'outlet-a',
    operation: 'GetOrder',
    input: { orderId: 'order-1' },
  }).data.id, 'order-1')
  assert.equal(executeLocalOperation(database, actor, {
    partition: 'outlet-b',
    operation: 'GetOrder',
    input: { orderId: 'order-1' },
  }).data, null)
  executeLocalOperation(database, actor, {
    partition: 'outlet-a',
    operation: 'PlaceOrder',
    input: { orderId: 'order-2', total: 2500 },
    idempotencyKey: 'request-2',
  })
  const firstPage = executeLocalOperation(database, actor, {
    partition: 'outlet-a',
    operation: 'ListOrders',
    input: {},
    page: { pageSize: 1 },
  }).data
  assert.deepEqual(firstPage.items.map(({ id }) => id), ['order-1'])
  assert.equal(firstPage.nextCursor, 'order-1')
  const secondPage = executeLocalOperation(database, actor, {
    partition: 'outlet-a',
    operation: 'ListOrders',
    input: {},
    page: { pageSize: 1, cursor: firstPage.nextCursor },
  }).data
  assert.deepEqual(secondPage.items.map(({ id }) => id), ['order-2'])
  assert.equal(secondPage.nextCursor, null)
  database.close()
})

test('rejects invalid operation input and rolls back result-shape failures', async () => {
  const { actor, database } = await setup()
  assert.throws(() => executeLocalOperation(database, actor, {
    partition: 'outlet-a',
    operation: 'PlaceOrder',
    input: { orderId: 'order-1', total: 'not-an-integer' },
  }), /must be integer/)
  const broken = {
    ...actor,
    operations: [{
      definition: {
        version: 'lacify.dev/operation/v1',
        name: 'BrokenWrite',
        kind: 'command',
        input: { orderId: { type: 'string', required: true } },
        result: { mode: 'one', fields: { id: { type: 'string' } } },
      },
      sql: "INSERT INTO orders (id, outlet_id, total, status, created_at, updated_at) VALUES (:orderId, :partitionId, 0, 'Draft', :now, :now);",
    }],
  }
  assert.throws(() => executeLocalOperation(database, broken, {
    partition: 'outlet-a',
    operation: 'BrokenWrite',
    input: { orderId: 'rolled-back' },
  }), /exactly one/)
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders WHERE id = 'rolled-back'").get().count, 0)
  database.close()
})
