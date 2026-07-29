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
      emits: [{ event: 'OrderPlaced', target: 'realtime', durability: 'segmented', fields: ['id', 'total'], realtime: { roomClass: 'store', roomField: '$partitionKey' } }],
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

async function runtime({ sink, replaySecret } = {}) {
  const release = await compileRelease('operation-runtime-execution', [contract])
  const executable = release.artifact['worker.js']
    .replace("import { DurableObject } from 'cloudflare:workers';", '')
    .replace('export default', 'const workerDefault =')
    .replaceAll('export class', 'class')
    .concat('\nreturn { Actor: OutletDO, worker: workerDefault };')
  const DurableObjectBase = class { constructor(ctx, env) { this.ctx = ctx; this.env = env } }
  const { Actor, worker } = new Function('DurableObject', executable)(DurableObjectBase)
  const backing = sqliteStorage()
  const pending = []
  const ctx = { storage: backing.storage, waitUntil(promise) { pending.push(Promise.resolve(promise)) } }
  const env = { ...(sink ? { LACIFY_EVENT_SINK: sink, LACIFY_EVENT_ROUTER_SECRET: 'test-router-secret-with-sufficient-length' } : {}), ...(replaySecret ? { LACIFY_OUTBOX_REPLAY_SECRET: replaySecret } : {}) }
  return {
    actor: new Actor(ctx, env),
    database: backing.database,
    worker,
    drain: async () => Promise.all(pending.splice(0)),
    restart: (nextEnv = env) => new Actor(ctx, nextEnv),
  }
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

  const access = await worker.fetch(new Request('https://runtime.test/__lacify/access', {
    headers: { authorization: `Bearer ${token}` },
  }), env, ctx)
  assert.equal(access.status, 200)
  const accessBody = await access.json()
  assert.deepEqual(accessBody.capabilities, [{
    actor: 'Outlet',
    operations: ['GetOrder'],
  }])
  assert.equal(JSON.stringify(accessBody).includes(token), false)

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
  const outbox = database.prepare('SELECT event_name, target, durability, payload, status FROM _lacify_outbox').get()
  assert.deepEqual({ ...outbox, payload: JSON.parse(outbox.payload) }, { event_name: 'OrderPlaced', target: 'realtime', durability: 'segmented', payload: { id: 'order-1', total: 1250 }, status: 'pending' })

  const replay = await command(actor, 'PlaceOrder', { total: 1250, orderId: 'order-1' }, 'request-1')
  assert.equal((await replay.json()).replayed, true)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM _lacify_outbox').get().count, 1)
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
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM _lacify_outbox').get().count, 0)
  database.close()
})

test('transactional outbox retries bounded delivery and treats sink conflict as idempotent success', async () => {
  const received = []
  const signed = []
  let calls = 0
  const sink = {
    async fetch(_url, init) {
      calls += 1
      received.push(JSON.parse(init.body))
      signed.push({ body: init.body, timestamp: init.headers['x-lacify-event-timestamp'], signature: init.headers['x-lacify-event-signature'] })
      if (calls === 1) throw new Error('network unavailable')
      return new Response(null, { status: 409 })
    },
  }
  const { actor, database, drain } = await runtime({ sink })
  assert.equal((await command(actor, 'PlaceOrder', { orderId: 'retry-order', total: 400 }, 'retry-request')).status, 200)
  await drain()
  let row = database.prepare('SELECT status, attempts, last_error FROM _lacify_outbox').get()
  assert.deepEqual({ ...row }, { status: 'pending', attempts: 1, last_error: 'delivery_failed' })
  database.prepare('UPDATE _lacify_outbox SET available_at = 0').run()
  const dispatched = await actor.fetch(new Request('https://lacify.internal/__lacify/outbox/dispatch', { method: 'POST' }))
  assert.equal((await dispatched.json()).delivered, 1)
  row = database.prepare('SELECT status, attempts, last_error FROM _lacify_outbox').get()
  assert.deepEqual({ ...row }, { status: 'delivered', attempts: 2, last_error: null })
  assert.equal(received.length, 2)
  assert.equal(received[0].eventId, received[1].eventId)
  assert.deepEqual(received[0].payload, { id: 'retry-order', total: 400 })
  assert.deepEqual(received[0].routing, { roomClass: 'store', room: 'outlet-a' })
  for (const request of signed) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-router-secret-with-sufficient-length'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${request.timestamp}.${request.body}`))
    const expected = [...new Uint8Array(signature)].map((value) => value.toString(16).padStart(2, '0')).join('')
    assert.equal(request.signature, expected)
  }
  database.close()
})

test('poison outbox events dead-letter after bounded attempts and require exact replay approval', async () => {
  const sink = { async fetch() { return new Response(null, { status: 503 }) } }
  const { actor, database, drain } = await runtime({ sink, replaySecret: 'approved-replay-secret' })
  await command(actor, 'PlaceOrder', { orderId: 'poison-order', total: 500 }, 'poison-request')
  await drain()
  for (let attempt = 1; attempt < 8; attempt += 1) {
    database.prepare('UPDATE _lacify_outbox SET available_at = 0').run()
    await actor.fetch(new Request('https://lacify.internal/__lacify/outbox/dispatch', { method: 'POST' }))
  }
  const dead = database.prepare('SELECT event_id, status, attempts, last_error FROM _lacify_outbox').get()
  assert.deepEqual({ status: dead.status, attempts: dead.attempts, last_error: dead.last_error }, { status: 'dead_letter', attempts: 8, last_error: 'sink_503' })
  const denied = await actor.fetch(new Request('https://lacify.internal/__lacify/outbox/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lacify-outbox-approval': 'wrong' },
    body: JSON.stringify({ eventId: dead.event_id }),
  }))
  assert.equal(denied.status, 403)
  const approved = await actor.fetch(new Request('https://lacify.internal/__lacify/outbox/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lacify-outbox-approval': 'approved-replay-secret' },
    body: JSON.stringify({ eventId: dead.event_id }),
  }))
  assert.equal((await approved.json()).replayScheduled, true)
  assert.deepEqual({ ...database.prepare('SELECT status, attempts, last_error FROM _lacify_outbox').get() }, { status: 'pending', attempts: 0, last_error: null })
  database.close()
})

test('pending outbox survives Actor restart and dispatches without replaying the business command', async () => {
  const runtimeState = await runtime()
  await command(runtimeState.actor, 'PlaceOrder', { orderId: 'restart-order', total: 700 }, 'restart-request')
  assert.equal(runtimeState.database.prepare("SELECT COUNT(*) AS count FROM _lacify_outbox WHERE status = 'pending'").get().count, 1)
  const received = []
  const restarted = runtimeState.restart({
    LACIFY_EVENT_ROUTER_SECRET: 'test-router-secret-with-sufficient-length',
    LACIFY_EVENT_SINK: {
      async fetch(_url, init) {
        received.push(JSON.parse(init.body))
        return new Response(null, { status: 202 })
      },
    },
  })
  const response = await restarted.fetch(new Request('https://lacify.internal/__lacify/outbox/dispatch', { method: 'POST' }))
  assert.equal((await response.json()).delivered, 1)
  assert.equal(received.length, 1)
  assert.equal(runtimeState.database.prepare('SELECT COUNT(*) AS count FROM orders').get().count, 1)
  assert.equal(runtimeState.database.prepare("SELECT COUNT(*) AS count FROM _lacify_outbox WHERE status = 'delivered'").get().count, 1)
  runtimeState.database.close()
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
