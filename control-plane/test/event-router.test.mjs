import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { compileRelease } from '../src/compiler.ts'

const contract = {
  id: 'outlet',
  name: 'Outlet',
  aggregateType: 'Outlet',
  key: 'outletId',
  objects: [{ name: 'Order' }],
  actions: ['PlaceOrder'],
  states: [{ obj: 'Order', flow: ['Placed'] }],
  revision: 1,
  operations: [{
    definition: {
      version: 'lacify.dev/operation/v1',
      name: 'PlaceOrder',
      kind: 'command',
      sql: './place-order.sql',
      input: {},
      result: { mode: 'one', fields: { id: { type: 'string' }, total: { type: 'integer' }, status: { type: 'string' }, sequence: { type: 'integer' } } },
      emits: [
        { event: 'OrderPlaced', target: 'realtime', durability: 'immediate', fields: ['id', 'total', 'status', 'sequence'], realtime: { roomClass: 'store', roomField: '$partitionKey' } },
        { event: 'OrderPlaced', target: 'reporting', durability: 'immediate', fields: ['id', 'total', 'status', 'sequence'], reporting: { keyField: '$partitionKey', sequenceField: 'sequence', dimensions: ['status'], measures: [{ field: 'total', aggregate: 'sum' }] } },
        { event: 'OrderPlaced', target: 'archive', durability: 'segmented', fields: ['id'] },
      ],
    },
    sql: "SELECT 'order-1' AS id, 100 AS total, 'placed' AS status, 1 AS sequence;",
  }],
}

function actorStorage() {
  const database = new DatabaseSync(':memory:')
  const alarms = []
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
    alarms,
    ctx: {
      storage: {
        sql,
        transactionSync: (callback) => callback(),
        async setAlarm(value) { alarms.push(value) },
      },
      blockConcurrencyWhile(callback) { return callback() },
    },
  }
}

async function compiled() {
  const release = await compileRelease('router-runtime', [contract])
  const source = release.artifact['event-router.js']
    .replace("import { DurableObject } from 'cloudflare:workers';", '')
    .replace('export default', 'const workerDefault =')
    .replaceAll('export class', 'class')
    .concat('\nreturn { EventRouterActor, worker: workerDefault };')
  const DurableObjectBase = class { constructor(ctx, env) { this.ctx = ctx; this.env = env } }
  const router = new Function('DurableObject', source)(DurableObjectBase)
  const reportingSource = release.artifact['reporting-worker.js']
    .replace("import { DurableObject } from 'cloudflare:workers';", '')
    .replace('export default', 'const workerDefault =')
    .replaceAll('export class', 'class')
    .concat('\nreturn { ReportingActor, worker: workerDefault };')
  const reporting = new Function('DurableObject', reportingSource)(DurableObjectBase)
  return { release, ...router, reporting }
}

async function signature(secret, timestamp, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`))
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function realtimeEvent(eventId = 'event-1') {
  return {
    version: 'lacify.dev/event/v1',
    eventId,
    operation: 'PlaceOrder',
    partitionKey: 'store-a',
    event: 'OrderPlaced',
    target: 'realtime',
    durability: 'immediate',
    payload: { id: 'order-1' },
    routing: { roomClass: 'store', room: 'store-a' },
    occurredAt: Date.now(),
  }
}

test('compiler wires an isolated Event Router without embedding secret values', async () => {
  const { release } = await compiled()
  assert.equal(release.manifest.resourcePlan.eventRouter, true)
  assert.deepEqual(release.manifest.resourcePlan.eventTargets, ['archive', 'realtime', 'reporting'])
  assert.equal(JSON.parse(release.artifact['wrangler.jsonc']).services[0].binding, 'LACIFY_EVENT_SINK')
  const router = JSON.parse(release.artifact['wrangler.event-router.jsonc'])
  assert.equal(router.durable_objects.bindings[0].class_name, 'EventRouterActor')
  assert.deepEqual(router.services.map(({ binding }) => binding), ['REPORTING_SINK', 'REALTIME_SINK'])
  assert.equal(router.r2_buckets[0].binding, 'ARCHIVE')
  const secrets = JSON.parse(release.artifact['deployment-secrets.json'])
  assert.equal(secrets.valuesIncluded, false)
  assert.ok(secrets.secrets.every((item) => !('value' in item)))
  assert.ok(secrets.secrets.some((item) => item.name === 'LACIFY_PREFLIGHT_SECRET'))
  assert.equal(JSON.parse(release.artifact['deployment-preflight.json']).remoteMutation, false)
  assert.equal(JSON.parse(release.artifact['r2-lifecycle.json']).rules[0].expireAfterDays, 30)
})

test('Event Router delivers a reporting envelope into a rebuildable Reporting Actor', async () => {
  const { EventRouterActor, reporting } = await compiled()
  const routerBacking = actorStorage()
  const reportBacking = actorStorage()
  const reportActor = new reporting.ReportingActor(reportBacking.ctx, {})
  const routerActor = new EventRouterActor(routerBacking.ctx, {
    LACIFY_REPORTING_SINK_SECRET: 'reporting-secret',
    REPORTING_SINK: {
      async fetch(_url, init) {
        assert.equal(init.headers['x-lacify-event-sink-secret'], 'reporting-secret')
        return reportActor.fetch(new Request('https://lacify.internal/events', init))
      },
    },
  })
  const envelope = {
    version: 'lacify.dev/event/v1',
    eventId: 'report-1',
    operation: 'PlaceOrder',
    partitionKey: 'store-a',
    event: 'OrderPlaced',
    target: 'reporting',
    durability: 'immediate',
    payload: { id: 'order-1', total: 100, status: 'placed', sequence: 1 },
    projection: { keyField: '$partitionKey', key: 'store-a', sequenceField: 'sequence', dimensions: ['status'], measures: [{ field: 'total', aggregate: 'sum' }] },
    occurredAt: Date.now(),
  }
  const response = await routerActor.fetch(new Request('https://lacify.internal/deliver', { method: 'POST', body: JSON.stringify(envelope) }))
  assert.equal(response.status, 202)
  const projection = reportBacking.database.prepare('SELECT total, event_count FROM _lacify_report_daily').get()
  assert.deepEqual({ ...projection }, { total: 100, event_count: 1 })
  routerBacking.database.close()
  reportBacking.database.close()
})

test('Event Router authenticates, deduplicates, detects conflicts, and retries targets', async () => {
  const { EventRouterActor, worker } = await compiled()
  const backing = actorStorage()
  let downstreamCalls = 0
  let fail = true
  const actor = new EventRouterActor(backing.ctx, {
    LACIFY_REALTIME_SINK_SECRET: 'realtime-secret',
    REALTIME_SINK: {
      async fetch(_url, init) {
        downstreamCalls += 1
        assert.equal(init.headers['x-lacify-event-sink-secret'], 'realtime-secret')
        if (fail) return new Response(null, { status: 503 })
        return new Response(null, { status: 202 })
      },
    },
  })
  const env = {
    LACIFY_EVENT_ROUTER_SECRET: 'router-secret',
    LACIFY_ENVIRONMENT: 'development',
    EVENT_ROUTER_DO: {
      idFromName: (value) => value,
      get: () => ({ fetch: (request) => actor.fetch(request) }),
    },
  }
  const send = async (value, { timestamp = Date.now(), secret = 'router-secret' } = {}) => {
    const body = JSON.stringify(value)
    return worker.fetch(new Request('https://runtime.test/v1/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lacify-event-timestamp': String(timestamp),
        'x-lacify-event-signature': await signature(secret, timestamp, body),
      },
      body,
    }), env)
  }
  const value = realtimeEvent()
  assert.equal((await send(value, { secret: 'wrong' })).status, 401)
  assert.equal((await send(value, { timestamp: Date.now() - 61_000 })).status, 401)
  assert.equal((await send(value)).status, 503)
  fail = false
  assert.equal((await send(value)).status, 202)
  assert.equal((await send(value)).status, 409)
  assert.equal(downstreamCalls, 2)
  const conflicting = realtimeEvent()
  conflicting.payload.id = 'changed'
  assert.equal((await send(conflicting)).status, 409)
  assert.equal(downstreamCalls, 2)
  backing.database.close()
})

test('Event Router alarm recovers pending delivery without replaying the source operation', async () => {
  const { EventRouterActor } = await compiled()
  const backing = actorStorage()
  let available = false
  let calls = 0
  const actor = new EventRouterActor(backing.ctx, {
    LACIFY_REALTIME_SINK_SECRET: 'realtime-secret',
    REALTIME_SINK: {
      async fetch() {
        calls += 1
        return new Response(null, { status: available ? 202 : 503 })
      },
    },
  })
  const envelope = realtimeEvent('recover-1')
  const body = JSON.stringify(envelope)
  assert.equal((await actor.fetch(new Request('https://lacify.internal/deliver', { method: 'POST', body }))).status, 503)
  assert.ok(backing.alarms.length > 0)
  backing.database.prepare('UPDATE _lacify_router_deliveries SET next_attempt_at = 0').run()
  available = true
  await actor.alarm()
  assert.equal(backing.database.prepare('SELECT status FROM _lacify_router_deliveries WHERE event_id = ?').get('recover-1').status, 'delivered')
  assert.equal(calls, 2)
  backing.database.close()
})

test('Event Router opens a bounded per-target circuit and exposes no payload in health', async () => {
  const { EventRouterActor } = await compiled()
  const backing = actorStorage()
  let calls = 0
  const actor = new EventRouterActor(backing.ctx, {
    LACIFY_REALTIME_SINK_SECRET: 'realtime-secret',
    REALTIME_SINK: { async fetch() { calls += 1; return new Response(null, { status: 503 }) } },
  })
  for (let index = 1; index <= 3; index += 1) {
    const envelope = realtimeEvent(`circuit-${index}`)
    assert.equal((await actor.fetch(new Request('https://lacify.internal/deliver', { method: 'POST', body: JSON.stringify(envelope) }))).status, 503)
  }
  const blocked = realtimeEvent('circuit-4')
  assert.equal((await actor.fetch(new Request('https://lacify.internal/deliver', { method: 'POST', body: JSON.stringify(blocked) }))).status, 503)
  assert.equal(calls, 3)
  const health = await actor.fetch(new Request('https://lacify.internal/health'))
  const payload = await health.json()
  assert.equal(payload.circuits[0].target, 'realtime')
  assert.ok(payload.circuits[0].openUntil > Date.now())
  assert.equal(JSON.stringify(payload).includes('order-1'), false)
  backing.database.close()
})

test('Event Router rejects new work when a shard reaches bounded pending capacity', async () => {
  const { EventRouterActor } = await compiled()
  const backing = actorStorage()
  let calls = 0
  const actor = new EventRouterActor(backing.ctx, {
    LACIFY_REALTIME_SINK_SECRET: 'realtime-secret',
    REALTIME_SINK: { async fetch() { calls += 1; return new Response(null, { status: 202 }) } },
  })
  const insert = backing.database.prepare("INSERT INTO _lacify_router_deliveries (event_id, target, checksum, status, attempts, body, next_attempt_at, created_at) VALUES (?, 'realtime', 'checksum', 'pending', 1, '{}', 0, 0)")
  for (let index = 0; index < 256; index += 1) insert.run(`pending-${index}`)
  const envelope = realtimeEvent('over-capacity')
  const response = await actor.fetch(new Request('https://lacify.internal/deliver', { method: 'POST', body: JSON.stringify(envelope) }))
  assert.equal(response.status, 429)
  assert.equal((await response.json()).error.code, 'router_backpressure')
  assert.equal(calls, 0)
  backing.database.close()
})

test('Event Router deployment preflight checks exact approval and target health without mutation', async () => {
  const { worker } = await compiled()
  const env = {
    LACIFY_EVENT_ROUTER_SECRET: 'router-secret',
    LACIFY_PREFLIGHT_SECRET: 'preflight-secret',
    LACIFY_REPORTING_SINK_SECRET: 'reporting-secret',
    LACIFY_REALTIME_SINK_SECRET: 'realtime-secret',
    EVENT_ROUTER_DO: {},
    ARCHIVE: {},
    REPORTING_SINK: { fetch: async () => Response.json({ ok: true }) },
    REALTIME_SINK: { fetch: async () => Response.json({ ok: true }) },
  }
  const denied = await worker.fetch(new Request('https://runtime.test/__lacify/router/preflight', { method: 'POST' }), env)
  assert.equal(denied.status, 403)
  const response = await worker.fetch(new Request('https://runtime.test/__lacify/router/preflight', {
    method: 'POST',
    headers: { 'x-lacify-preflight-approval': 'preflight-secret' },
  }), env)
  const result = await response.json()
  assert.equal(response.status, 200)
  assert.equal(result.preflight, true)
  assert.equal(result.remoteMutation, false)
  assert.ok(result.layers.every((layer) => layer.ok))
})

test('Event Router archives an immutable event under a deterministic bounded key', async () => {
  const { EventRouterActor } = await compiled()
  const backing = actorStorage()
  const writes = []
  const actor = new EventRouterActor(backing.ctx, {
    LACIFY_ENVIRONMENT: 'staging',
    ARCHIVE: { put: async (...args) => writes.push(args) },
  })
  const envelope = { ...realtimeEvent('archive-1'), target: 'archive', routing: undefined }
  const body = JSON.stringify(envelope)
  assert.equal((await actor.fetch(new Request('https://lacify.internal/deliver', { method: 'POST', body }))).status, 202)
  assert.match(writes[0][0], /^events\/router-runtime\/staging\/\d{4}-\d{2}-\d{2}\/archive-1\.json$/)
  assert.equal(writes[0][1], body)
  backing.database.close()
})
