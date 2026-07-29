import assert from 'node:assert/strict'
import test from 'node:test'
import { validateContract } from '../src/index.ts'

const base = {
  id: 'outlet',
  name: 'Outlet',
  aggregateType: 'Outlet',
  key: 'outletId',
  objects: [{ name: 'Order', fields: 'id,total' }],
  actions: ['PlaceOrder'],
  states: [{ obj: 'Order', flow: ['Draft', 'Placed'] }],
  migrations: [{ id: '0001_initial', sql: 'CREATE TABLE orders (id TEXT PRIMARY KEY, outlet_id TEXT NOT NULL, total INTEGER NOT NULL);' }],
  operations: [{
    definition: {
      version: 'lacify.dev/operation/v1',
      name: 'PlaceOrder',
      kind: 'command',
      sql: './place-order.sql',
      input: { orderId: { type: 'string', required: true }, total: { type: 'integer', required: true } },
      result: { mode: 'one', fields: { id: { type: 'string' }, total: { type: 'integer' } } },
    },
    sql: 'INSERT INTO orders (id, outlet_id, total) VALUES (:orderId, :partitionId, :total) RETURNING id, total;',
  }],
}

test('Control Plane preserves validated repository operations for immutable compilation', () => {
  const result = validateContract(base)
  assert.equal(result.message, undefined)
  assert.equal(result.document.operations[0].definition.name, 'PlaceOrder')
  assert.match(result.document.operations[0].sql, /:partitionId/)
})

test('Control Plane accepts additive migrations prefixed by SQL comments', () => {
  const result = validateContract({
    ...base,
    migrations: [{
      id: '0002_inbox_preview',
      sql: [
        '-- Projection-only metadata for a room preview.',
        'ALTER TABLE inbox_rooms ADD COLUMN preview_text TEXT;',
        'ALTER TABLE inbox_rooms ADD COLUMN preview_created_at INTEGER NOT NULL DEFAULT 0;'
      ].join('\n')
    }]
  })
  assert.equal(result.message, undefined)
})

test('Control Plane preserves bounded realtime emits during repository sync', () => {
  const operation = structuredClone(base.operations[0])
  operation.definition.emits = [{
    event: 'OrderPlaced',
    target: 'realtime',
    durability: 'immediate',
    fields: ['id', 'total'],
    realtime: { roomClass: 'orders', roomField: 'id' },
  }]
  const result = validateContract({ ...base, operations: [operation] })
  assert.equal(result.message, undefined)
  assert.deepEqual(result.document.operations[0].definition.emits, operation.definition.emits)
})

test('Control Plane rejects realtime emits with undeclared payload or room fields', () => {
  const operation = structuredClone(base.operations[0])
  operation.definition.emits = [{
    event: 'OrderPlaced',
    target: 'realtime',
    durability: 'immediate',
    fields: ['missing'],
    realtime: { roomClass: 'orders', roomField: 'missing' },
  }]
  const result = validateContract({ ...base, operations: [operation] })
  assert.equal(typeof result.message, 'string')
  assert.equal(result.document, undefined)
})

test('Control Plane rejects arbitrary, internal, unbounded, and undeclared operation SQL', () => {
  const sqlCases = [
    'DROP TABLE orders;',
    'UPDATE orders SET total = :total;',
    'SELECT * FROM _lacify_migrations WHERE id = :partitionId;',
    'INSERT INTO orders (id, outlet_id, total) VALUES (:unknown, :partitionId, :total);',
    'INSERT INTO orders (id, outlet_id, total) VALUES (?, :partitionId, :total);',
  ]
  for (const sql of sqlCases) {
    const result = validateContract({ ...base, operations: [{ ...base.operations[0], sql }] })
    assert.equal(typeof result.message, 'string', sql)
    assert.equal(result.document, undefined)
  }
})
