import assert from 'node:assert/strict'
import test from 'node:test'
import { compileRelease } from '../src/compiler.ts'

const sourceContracts = [{
  id: 'outlet',
  name: 'Outlet',
  aggregateType: 'Outlet',
  key: 'outletId',
  objects: [{ name: 'Order', fields: 'id,total' }],
  actions: ['PlaceOrder'],
  states: [{ obj: 'Order', flow: ['Draft', 'Placed'] }],
  revision: 1,
}]

test('compiled Cloudflare Worker contains non-blocking scoped telemetry', async () => {
  const release = await compileRelease('telemetry-smoke', sourceContracts)
  const worker = release.artifact['worker.js']

  assert.match(worker, /ctx\.waitUntil\(queueRuntimeTelemetry/)
  assert.match(worker, /env\.LACIFY_TELEMETRY_CREDENTIAL/)
  assert.match(worker, /env\.LACIFY_DEPLOYMENT_ID/)
  assert.match(worker, /env\.LACIFY_RELEASE_ID/)
  assert.match(worker, /env\.LACIFY_ENVIRONMENT/)
  assert.match(worker, /partitionKeyHash: await hashPartition/)
  assert.match(worker, /lacify\.telemetry_dropped/)
  assert.doesNotMatch(worker, /events:.*commandInput\.payload/s)

  const parseable = worker
    .replace("import { DurableObject } from 'cloudflare:workers';", 'class DurableObject {}')
    .replace('export default', 'const workerDefault =')
    .replaceAll('export class', 'class')
  assert.doesNotThrow(() => new Function(parseable))
})

test('telemetry instrumentation remains deterministic', async () => {
  const first = await compileRelease('telemetry-smoke', sourceContracts)
  const second = await compileRelease('telemetry-smoke', sourceContracts)
  assert.equal(first.checksum, second.checksum)
  assert.equal(first.artifact['worker.js'], second.artifact['worker.js'])
})

test('compiled runtime exposes deep Worker, Durable Object, and SQLite health', async () => {
  const release = await compileRelease('health-smoke', sourceContracts)
  const worker = release.artifact['worker.js']

  assert.match(worker, /searchParams\.get\('deep'\) === '1'/)
  assert.match(worker, /layer: 'durable_object'/)
  assert.match(worker, /layer: 'sqlite'/)
  assert.match(worker, /pathname === '\/__lacify\/health'/)
  assert.match(worker, /SELECT 1 AS ok/)
  assert.match(worker, /deploymentId: env\.LACIFY_DEPLOYMENT_ID/)
  assert.match(worker, /storageBytes: this\.sql\.databaseSize/)
  assert.match(worker, /sqliteReads: event\.sqliteReads/)
  assert.match(worker, /LACIFY_TELEMETRY_SAMPLING_RATE/)
})

test('compiled runtime embeds forward-only authored migrations with immutable checksums', async () => {
  const release = await compileRelease('database-as-code', [{
    ...sourceContracts[0],
    migrations: [{ id: '0001_initial', sql: 'CREATE TABLE orders (id TEXT PRIMARY KEY);' }],
  }])
  const contract = release.manifest.contracts[0]
  assert.match(contract.migrations[0].checksum, /^[a-f0-9]{64}$/)
  assert.match(release.artifact['worker.js'], /CREATE TABLE orders/)
  assert.match(release.artifact['worker.js'], /_lacify_migrations/)
  assert.match(release.artifact['schema.sql'], /0001_initial/)
  assert.match(release.artifact['schema.sql'], new RegExp(contract.migrations[0].checksum))
  assert.ok(release.manifest.resourcePlan.sqliteTables.includes('orders'))
  assert.match(release.artifact['worker.js'], /name: 'orders'/)
})

test('compiled runtime sanitizes kebab-case contract IDs for internal SQLite tables', async () => {
  const release = await compileRelease('identifier-safety', [{
    ...sourceContracts[0],
    id: 'message-inbox',
    name: 'MessageInbox',
    aggregateType: 'MessageInbox',
    objects: [{ name: 'InboxRoom', fields: 'id,updatedAt' }],
    migrations: [{ id: '0001_initial', sql: 'CREATE TABLE inbox_rooms (id TEXT PRIMARY KEY);' }],
  }])
  const worker = release.artifact['worker.js']
  assert.match(worker, /_lacify_runtime_message_inbox_inbox_room/)
  assert.doesNotMatch(worker, /_lacify_runtime_message-inbox/)
  assert.ok(release.manifest.resourcePlan.sqliteTables.includes('_lacify_runtime_message_inbox_inbox_room'))
})

test('compiled runtime embeds bounded typed data operations without arbitrary SQL routes', async () => {
  const release = await compileRelease('operation-runtime', [{
    ...sourceContracts[0],
    migrations: [{ id: '0001_initial', sql: 'CREATE TABLE orders (id TEXT PRIMARY KEY, outlet_id TEXT NOT NULL, total INTEGER NOT NULL);' }],
    operations: [{
      definition: {
        version: 'lacify.dev/operation/v1',
        name: 'PlaceOrder',
        kind: 'command',
        sql: './place-order.sql',
        input: {
          orderId: { type: 'string', required: true },
          total: { type: 'integer', required: true },
        },
        result: { mode: 'one', fields: { id: { type: 'string' }, total: { type: 'integer' } } },
      },
      sql: 'INSERT INTO orders (id, outlet_id, total) VALUES (:orderId, :partitionId, :total) RETURNING id, total;',
    }, {
      definition: {
        version: 'lacify.dev/operation/v1',
        name: 'GetOrder',
        kind: 'query',
        sql: './get-order.sql',
        input: { orderId: { type: 'string', required: true } },
        result: { mode: 'optional', fields: { id: { type: 'string' }, total: { type: 'integer' } } },
      },
      sql: 'SELECT id, total FROM orders WHERE outlet_id = :partitionId AND id = :orderId;',
    }],
  }])
  const worker = release.artifact['worker.js']
  const contract = release.manifest.contracts[0]
  assert.deepEqual(contract.operations.map(({ name }) => name), ['GetOrder', 'PlaceOrder'])
  assert.ok(contract.operations.every(({ checksum }) => /^[a-f0-9]{64}$/.test(checksum)))
  assert.match(worker, /_lacify_operation_receipts/)
  assert.match(worker, /transactionSync/)
  assert.match(worker, /input_hash/)
  assert.match(worker, /idempotency_conflict/)
  assert.match(worker, /operation_execution_failed/)
  assert.match(worker, /idempotency-key/)
  assert.equal(worker.includes('/queries\\/[^/]+$/'), true)
  assert.match(worker, /Operation input exceeds 64 KiB/)
  assert.match(worker, /Operation result exceeds 256 KiB/)
  assert.match(worker, /INSERT INTO orders \(id, outlet_id, total\) VALUES \(\?, \?, \?\)/)
  assert.doesNotMatch(worker, /body\.sql/)
})

test('generated JavaScript response expressions are not mistaken for TypeScript annotations', async () => {
  const release = await compileRelease('response-expression-smoke', sourceContracts)
  assert.match(release.artifact['worker.js'], /error: Response\.json/)
})
