import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { compileRelease } from '../src/compiler.ts'

const contract = {
  id: 'outlet',
  name: 'Outlet',
  aggregateType: 'Outlet',
  key: 'outletId',
  objects: [{ name: 'Order', fields: 'id,total' }],
  actions: ['PlaceOrder', 'BrokenOrder', 'DeleteOrder'],
  states: [{ obj: 'Order', flow: ['Draft', 'Placed'] }],
  revision: 1,
  migrations: [{
    id: '0001_initial',
    sql: 'CREATE TABLE orders (id TEXT PRIMARY KEY, outlet_id TEXT NOT NULL, total INTEGER NOT NULL);',
  }],
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
      name: 'DeleteOrder',
      kind: 'command',
      sql: './delete-order.sql',
      input: { orderId: { type: 'string', required: true } },
      result: { mode: 'none' },
    },
    sql: 'DELETE FROM orders WHERE outlet_id = :partitionId AND id = :orderId;',
  }, {
    definition: {
      version: 'lacify.dev/operation/v1',
      name: 'BrokenOrder',
      kind: 'command',
      sql: './broken-order.sql',
      input: { orderId: { type: 'string', required: true } },
      result: { mode: 'one', fields: { id: { type: 'string' } } },
    },
    sql: 'INSERT INTO orders (id, outlet_id, total) VALUES (:orderId, :partitionId, 0);',
  }, {
    definition: {
      version: 'lacify.dev/operation/v1',
      name: 'GetOrder',
      kind: 'query',
      sql: './get-order.sql',
      input: { orderId: { type: 'string', required: true } },
      result: { mode: 'optional', fields: { id: { type: 'string' }, total: { type: 'integer' } } },
    },
    sql: 'SELECT id, total, outlet_id FROM orders WHERE outlet_id = :partitionId AND id = :orderId;',
  }, {
    definition: {
      version: 'lacify.dev/operation/v1',
      name: 'BoundedOrders',
      kind: 'query',
      sql: './bounded-orders.sql',
      input: {},
      result: { mode: 'many', maxRows: 1, fields: { id: { type: 'string' }, total: { type: 'integer' } } },
    },
    sql: 'SELECT id, total FROM orders WHERE outlet_id = :partitionId;',
  }, {
    definition: {
      version: 'lacify.dev/operation/v1',
      name: 'ListOrders',
      kind: 'query',
      sql: './list-orders.sql',
      input: {},
      result: {
        mode: 'many',
        maxRows: 100,
        fields: { id: { type: 'string' }, total: { type: 'integer' } },
        pagination: { cursorField: 'id', defaultPageSize: 1, maxPageSize: 2 },
      },
    },
    sql: 'SELECT id, total FROM orders WHERE outlet_id = :partitionId AND (:cursor IS NULL OR id > :cursor) ORDER BY id LIMIT :pageSize;',
  }, {
    definition: {
      version: 'lacify.dev/operation/v1',
      name: 'BadType',
      kind: 'query',
      sql: './bad-type.sql',
      input: {},
      result: { mode: 'one', fields: { id: { type: 'string' } } },
    },
    sql: 'SELECT total AS id FROM orders WHERE outlet_id = :partitionId LIMIT 1;',
  }],
}

function sqliteStorage() {
  const database = new DatabaseSync(':memory:')
  const sql = {
    get databaseSize() { return 0 },
    exec(source, ...bindings) {
      if (!bindings.length && !/^\s*SELECT\b/i.test(source)) {
        database.exec(source)
        return []
      }
      return database.prepare(source).all(...bindings)
    },
  }
  return {
    database,
    storage: {
      sql,
      transactionSync(callback) {
        database.exec('BEGIN IMMEDIATE')
        try {
          const result = callback()
          database.exec('COMMIT')
          return result
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
      },
    },
  }
}

async function runtime() {
  const release = await compileRelease('operation-runtime-execution', [contract])
  const executable = release.artifact['worker.js']
    .replace("import { DurableObject } from 'cloudflare:workers';", '')
    .replace('export default', 'const workerDefault =')
    .replaceAll('export class', 'class')
    .concat('\nreturn { Actor: OutletDO, worker: workerDefault };')
  const DurableObjectBase = class { constructor(ctx, env) { this.ctx = ctx; this.env = env } }
  const { Actor, worker } = new Function('DurableObject', executable)(DurableObjectBase)
  const backing = sqliteStorage()
  return { actor: new Actor({ storage: backing.storage }, {}), database: backing.database, worker }
}

function command(actor, operation, input, key = null, partition = 'outlet-a') {
  return actor.fetch(new Request(`https://runtime.test/v1/outlets/${partition}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lacify-caller-identity': 'a'.repeat(64), 'x-lacify-operation-rate-limit': '1000', ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify({ command: operation, payload: input }),
  }))
}

async function tokenHash(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function workerEnvironment(actor, token, operations, rateLimitPerMinute = 60, maxPayloadBytes = 65_536) {
  return {
    LACIFY_DEPLOYMENT_ID: 'deploy_0123456789abcdef01_dev',
    LACIFY_RELEASE_ID: 'release_0123456789abcdef01234567',
    LACIFY_ENVIRONMENT: 'dev',
    LACIFY_APPLICATION_ACCESS_POLICY: JSON.stringify({
      version: 1,
      workspaceId: 'workspace-test',
      projectId: 'project-test',
      environment: 'dev',
      credentials: [{
        id: 'credential-test',
        tokenHash: await tokenHash(token),
        expiresAt: Date.now() + 60_000,
        capabilities: [{ actor: 'Outlet', operations, rateLimitPerMinute, maxPayloadBytes }],
      }],
    }),
    OUTLET_DO: {
      idFromName: (value) => value,
      get: () => ({ fetch: (request) => actor.fetch(request) }),
    },
  }
}

test('runtime Worker requires scoped application credentials and enforces payload and operation limits', async () => {
  const token = `lacify_runtime_${'x'.repeat(43)}`
  const { actor, worker } = await runtime()
  const env = await workerEnvironment(actor, token, ['GetOrder'], 1, 1024)
  const ctx = { waitUntil() {} }
  const request = (authorization, body = { input: { orderId: 'order-1' } }, operation = 'GetOrder') => new Request(`https://runtime.test/v1/outlets/outlet-a/queries/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(body),
  })

  const missing = await worker.fetch(request(null), env, ctx)
  assert.equal(missing.status, 401)
  assert.equal((await missing.json()).error.code, 'application_authentication_required')

  const forbidden = await worker.fetch(request(`Bearer ${token}`, { input: {} }, 'ListOrders'), env, ctx)
  assert.equal(forbidden.status, 403)
  assert.equal((await forbidden.json()).error.code, 'operation_forbidden')

  const first = await worker.fetch(request(`Bearer ${token}`), env, ctx)
  assert.equal(first.status, 200)
  const limited = await worker.fetch(request(`Bearer ${token}`), env, ctx)
  assert.equal(limited.status, 429)
  assert.equal((await limited.json()).error.code, 'operation_rate_limit')

  const payloadEnv = await workerEnvironment(actor, `lacify_runtime_${'y'.repeat(43)}`, ['GetOrder'], 60, 1024)
  const large = await worker.fetch(request(`Bearer lacify_runtime_${'y'.repeat(43)}`, { input: { orderId: 'z'.repeat(1100) } }), payloadEnv, ctx)
  assert.equal(large.status, 413)
  assert.equal((await large.json()).error.code, 'operation_payload_limit')
})

test('Durable Object operation audit stores identity and outcome without payloads', async () => {
  const { actor, database } = await runtime()
  const response = await actor.fetch(new Request('https://runtime.test/v1/outlets/outlet-a/queries/GetOrder', {
    method: 'POST',
    headers: { 'x-lacify-caller-identity': 'b'.repeat(64), 'x-lacify-operation-rate-limit': '10' },
    body: JSON.stringify({ input: { orderId: 'private-order-value' } }),
  }))
  assert.equal(response.status, 200)
  const audit = database.prepare('SELECT caller_identity_hash, operation, kind, outcome, status_code FROM _lacify_operation_audit').get()
  assert.deepEqual({ ...audit }, {
    caller_identity_hash: 'b'.repeat(64),
    operation: 'GetOrder',
    kind: 'query',
    outcome: 'success',
    status_code: 200,
  })
  const columns = database.prepare('PRAGMA table_info(_lacify_operation_audit)').all().map((column) => column.name)
  assert.equal(columns.includes('payload'), false)
  assert.equal(columns.includes('input'), false)
  assert.equal(JSON.stringify(audit).includes('private-order-value'), false)
})

test('command SQL, lifecycle, summary, and idempotency receipt commit atomically', async () => {
  const { actor, database } = await runtime()
  const first = await command(actor, 'PlaceOrder', { orderId: 'order-1', total: 1250 }, 'request-1')
  assert.equal(first.status, 200)
  assert.equal((await first.json()).version, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 1)
  assert.equal(database.prepare('SELECT version FROM lacify_aggregate_state WHERE partition_id = ?').get('outlet-a').version, 1)
  assert.equal(database.prepare('SELECT command_count AS count FROM lacify_daily_summary').get().count, 1)

  const replay = await command(actor, 'PlaceOrder', { total: 1250, orderId: 'order-1' }, 'request-1')
  assert.equal((await replay.json()).replayed, true)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 1)
  assert.equal(database.prepare('SELECT version FROM lacify_aggregate_state WHERE partition_id = ?').get('outlet-a').version, 1)

  const conflict = await command(actor, 'PlaceOrder', { orderId: 'order-2', total: 900 }, 'request-1')
  assert.equal(conflict.status, 409)
  assert.equal((await conflict.json()).error.code, 'idempotency_conflict')
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 1)

  const constraint = await command(actor, 'PlaceOrder', { orderId: 'order-1', total: 1250 }, 'request-2')
  const constraintBody = await constraint.json()
  assert.equal(constraint.status, 409)
  assert.equal(constraintBody.error.code, 'operation_execution_failed')
  assert.equal(JSON.stringify(constraintBody).includes('UNIQUE'), false)
  assert.equal(database.prepare('SELECT version FROM lacify_aggregate_state WHERE partition_id = ?').get('outlet-a').version, 1)
  const deleted = await command(actor, 'DeleteOrder', { orderId: 'order-1' }, 'delete-1')
  assert.equal((await deleted.json()).data, null)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 0)
  assert.equal(database.prepare('SELECT version FROM lacify_aggregate_state WHERE partition_id = ?').get('outlet-a').version, 2)
  database.close()
})

test('result contract failure rolls back business SQL and lifecycle state', async () => {
  const { actor, database } = await runtime()
  const response = await command(actor, 'BrokenOrder', { orderId: 'rollback-me' }, 'broken-1')
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, 'result_cardinality')
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 0)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM lacify_aggregate_state').get().count, 0)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM _lacify_operation_receipts').get().count, 0)
  database.close()
})

test('concurrent commands serialize and queries remain partition-scoped', async () => {
  const { actor, database } = await runtime()
  const responses = await Promise.all([
    command(actor, 'PlaceOrder', { orderId: 'order-1', total: 100 }, 'concurrent-1'),
    command(actor, 'PlaceOrder', { orderId: 'order-2', total: 200 }, 'concurrent-2'),
  ])
  assert.deepEqual(responses.map(({ status }) => status), [200, 200])
  assert.equal(database.prepare('SELECT version FROM lacify_aggregate_state WHERE partition_id = ?').get('outlet-a').version, 2)
  const found = await actor.fetch(new Request('https://runtime.test/v1/outlets/outlet-a/queries/GetOrder', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lacify-caller-identity': 'a'.repeat(64), 'x-lacify-operation-rate-limit': '1000' },
    body: JSON.stringify({ input: { orderId: 'order-2' } }),
  }))
  const foundBody = await found.json()
  assert.equal(foundBody.data.id, 'order-2')
  assert.equal(Object.hasOwn(foundBody.data, 'outlet_id'), false)
  const isolated = await actor.fetch(new Request('https://runtime.test/v1/outlets/outlet-b/queries/GetOrder', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lacify-caller-identity': 'a'.repeat(64), 'x-lacify-operation-rate-limit': '1000' },
    body: JSON.stringify({ input: { orderId: 'order-2' } }),
  }))
  assert.equal((await isolated.json()).data, null)
  const bounded = await actor.fetch(new Request('https://runtime.test/v1/outlets/outlet-a/queries/BoundedOrders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lacify-caller-identity': 'a'.repeat(64), 'x-lacify-operation-rate-limit': '1000' },
    body: JSON.stringify({ input: {} }),
  }))
  assert.equal(bounded.status, 422)
  assert.equal((await bounded.json()).error.code, 'result_row_limit')
  const firstPage = await actor.fetch(new Request('https://runtime.test/v1/outlets/outlet-a/queries/ListOrders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lacify-caller-identity': 'a'.repeat(64), 'x-lacify-operation-rate-limit': '1000' },
    body: JSON.stringify({ input: {}, page: { pageSize: 1 } }),
  })).then((response) => response.json())
  assert.deepEqual(firstPage.data.items.map(({ id }) => id), ['order-1'])
  assert.equal(firstPage.data.nextCursor, 'order-1')
  const secondPage = await actor.fetch(new Request('https://runtime.test/v1/outlets/outlet-a/queries/ListOrders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lacify-caller-identity': 'a'.repeat(64), 'x-lacify-operation-rate-limit': '1000' },
    body: JSON.stringify({ input: {}, page: { pageSize: 1, cursor: firstPage.data.nextCursor } }),
  })).then((response) => response.json())
  assert.deepEqual(secondPage.data.items.map(({ id }) => id), ['order-2'])
  assert.equal(secondPage.data.nextCursor, null)
  const badType = await actor.fetch(new Request('https://runtime.test/v1/outlets/outlet-a/queries/BadType', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lacify-caller-identity': 'a'.repeat(64), 'x-lacify-operation-rate-limit': '1000' },
    body: JSON.stringify({ input: {} }),
  }))
  assert.equal(badType.status, 500)
  assert.equal((await badType.json()).error.code, 'result_type')
  database.close()
})
