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
      emits: [{
        event: 'OrderPlaced',
        target: 'reporting',
        durability: 'immediate',
        fields: ['id', 'total', 'status', 'sequence'],
        reporting: {
          keyField: '$partitionKey',
          sequenceField: 'sequence',
          dimensions: ['status'],
          measures: [{ field: 'total', aggregate: 'sum' }],
        },
      }],
    },
    sql: "SELECT 'order' AS id, 1 AS total, 'placed' AS status, 1 AS sequence;",
  }],
}

function storage() {
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
    ctx: {
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
    },
  }
}

async function compiled() {
  const release = await compileRelease('reporting-runtime', [contract])
  const source = release.artifact['reporting-worker.js']
    .replace("import { DurableObject } from 'cloudflare:workers';", '')
    .replace('export default', 'const workerDefault =')
    .replaceAll('export class', 'class')
    .concat('\nreturn { ReportingActor, worker: workerDefault };')
  const DurableObjectBase = class { constructor(ctx, env) { this.ctx = ctx; this.env = env } }
  return { release, ...new Function('DurableObject', source)(DurableObjectBase) }
}

function event(eventId, sequence, total, key = 'outlet-a', status = 'placed') {
  return {
    version: 'lacify.dev/event/v1',
    eventId,
    operation: 'PlaceOrder',
    partitionKey: 'source-store',
    event: 'OrderPlaced',
    target: 'reporting',
    durability: 'immediate',
    payload: { id: eventId, total, status, sequence },
    projection: {
      keyField: '$partitionKey',
      key,
      sequenceField: 'sequence',
      dimensions: ['status'],
      measures: [{ field: 'total', aggregate: 'sum' }],
    },
    occurredAt: sequence,
  }
}

function send(actor, value) {
  return actor.fetch(new Request('https://lacify.internal/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  }))
}

test('compiler emits a deterministic isolated Reporting Actor artifact', async () => {
  const first = await compiled()
  const second = await compiled()
  assert.equal(first.release.checksum, second.release.checksum)
  assert.equal(first.release.manifest.resourcePlan.reporting, true)
  assert.match(first.release.artifact['reporting-worker.js'], /class ReportingActor/)
  const wrangler = JSON.parse(first.release.artifact['wrangler.reporting.jsonc'])
  assert.equal(wrangler.durable_objects.bindings[0].class_name, 'ReportingActor')
})

test('Reporting Actor deduplicates, detects gaps, rebuilds, and keeps projections isolated', async () => {
  const { ReportingActor } = await compiled()
  const firstStorage = storage()
  const first = new ReportingActor(firstStorage.ctx, { LACIFY_REPORTING_REBUILD_SECRET: 'rebuild-secret' })
  assert.equal((await send(first, event('event-1', 1, 100))).status, 202)
  assert.equal((await send(first, event('event-1', 1, 100))).status, 409)
  assert.equal((await send(first, event('event-3', 3, 300))).status, 202)
  assert.equal((await send(first, event('event-2', 2, 200))).status, 202)

  const summary = await first.fetch(new Request('https://lacify.internal/summary?event=OrderPlaced&fromDay=1970-01-01&toDay=1970-01-01'))
  const summaryBody = await summary.json()
  assert.equal(summaryBody.items[0].total, 600)
  assert.equal(summaryBody.items[0].eventCount, 3)
  const unhealthy = await first.fetch(new Request('https://lacify.internal/reconciliation'))
  assert.equal((await unhealthy.json()).healthy, false)

  const denied = await first.fetch(new Request('https://lacify.internal/rebuild', { method: 'POST' }))
  assert.equal(denied.status, 403)
  const rebuilt = await first.fetch(new Request('https://lacify.internal/rebuild', { method: 'POST', headers: { 'x-lacify-reporting-approval': 'rebuild-secret' } }))
  assert.equal((await rebuilt.json()).rebuilt, true)
  const healthy = await first.fetch(new Request('https://lacify.internal/reconciliation'))
  assert.equal((await healthy.json()).healthy, true)

  const secondStorage = storage()
  const second = new ReportingActor(secondStorage.ctx, {})
  await send(second, event('other-1', 1, 50, 'outlet-b'))
  assert.equal(firstStorage.database.prepare('SELECT COUNT(*) AS count FROM _lacify_report_events').get().count, 3)
  assert.equal(secondStorage.database.prepare('SELECT COUNT(*) AS count FROM _lacify_report_events').get().count, 1)
  firstStorage.database.close()
  secondStorage.database.close()
})

test('invalid projection rolls back its event ledger atomically', async () => {
  const { ReportingActor } = await compiled()
  const backing = storage()
  const actor = new ReportingActor(backing.ctx, {})
  const invalid = event('invalid-measure', 1, 100)
  invalid.payload.total = 'private-invalid-number'
  assert.equal((await send(actor, invalid)).status, 409)
  assert.equal(backing.database.prepare('SELECT COUNT(*) AS count FROM _lacify_report_events').get().count, 0)
  assert.equal(backing.database.prepare('SELECT COUNT(*) AS count FROM _lacify_report_daily').get().count, 0)
  backing.database.close()
})
