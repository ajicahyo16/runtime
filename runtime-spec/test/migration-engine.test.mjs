import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  applyMigrationPlan,
  classifyMigrationSql,
  introspectActorSchema,
  planMigrations,
  preflightMigrationPlan,
  readMigrationLedger,
} from '../src/migration-engine.mjs'

const migrations = [
  { id: '0001_initial', sql: "CREATE TABLE orders (id TEXT PRIMARY KEY, note TEXT); INSERT INTO orders VALUES ('1', 'semi;colon');" },
  { id: '0002_status', sql: 'ALTER TABLE orders ADD COLUMN status TEXT;' },
]

test('classifies additive, data-changing, destructive, and unsupported SQL', () => {
  assert.equal(classifyMigrationSql('CREATE TABLE things (id TEXT);').classification, 'additive')
  assert.equal(classifyMigrationSql('UPDATE things SET id = 2 WHERE id = 1;').classification, 'data-changing')
  assert.equal(classifyMigrationSql('DROP TABLE things;').classification, 'destructive')
  assert.equal(classifyMigrationSql('PRAGMA journal_mode;').classification, 'unsupported')
})

test('creates a deterministic ordered plan and safely reapplies it', () => {
  const database = new DatabaseSync(':memory:')
  const plan = planMigrations({ actor: 'Outlet', migrations, ledger: [], releaseId: 'release-1', environmentRevision: 'revision-1', projectFingerprint: 'fingerprint-1' })
  assert.equal(plan.valid, true)
  assert.deepEqual(plan.pending.map(({ id }) => id), ['0001_initial', '0002_status'])
  const first = applyMigrationPlan(database, plan, { now: () => '2026-07-23T00:00:00.000Z', createRecoveryBookmark: ({ migrationId }) => `bookmark-${migrationId}` })
  assert.deepEqual(first.map(({ status }) => status), ['applied', 'applied'])
  assert.equal(readMigrationLedger(database, 'Outlet').length, 2)
  const second = applyMigrationPlan(database, plan)
  assert.deepEqual(second.map(({ status }) => status), ['already-applied', 'already-applied'])
})

test('rejects edited, missing, duplicated, and out-of-order migrations', () => {
  const database = new DatabaseSync(':memory:')
  const initial = planMigrations({ actor: 'Outlet', migrations: migrations.slice(0, 1), ledger: [], releaseId: 'release-1' })
  applyMigrationPlan(database, initial)
  const ledger = readMigrationLedger(database, 'Outlet')
  assert.equal(planMigrations({ actor: 'Outlet', migrations: [], ledger, releaseId: 'release-2' }).issues[0].code, 'missing_applied_migration')
  assert.equal(planMigrations({ actor: 'Outlet', migrations: [{ ...migrations[0], sql: 'CREATE TABLE changed (id TEXT);' }], ledger, releaseId: 'release-2' }).issues[0].code, 'edited_applied_migration')
  assert.ok(planMigrations({ actor: 'Outlet', migrations: [migrations[0], migrations[0]], ledger: [], releaseId: 'release-1' }).issues.some(({ code }) => code === 'duplicate_migration'))
  assert.ok(planMigrations({ actor: 'Outlet', migrations: [migrations[1], migrations[0]], ledger: [], releaseId: 'release-1' }).issues.some(({ code }) => code === 'out_of_order'))
})

test('blocks destructive and unsupported migrations from default apply', () => {
  const destructive = planMigrations({ actor: 'Outlet', migrations: [{ id: '0001_drop', sql: 'DROP TABLE orders;' }], ledger: [], releaseId: 'release-1' })
  assert.equal(destructive.valid, false)
  assert.throws(() => applyMigrationPlan(new DatabaseSync(':memory:'), destructive), /invalid migration plan/)
})

test('records a failed migration and recovery instructions outside the rolled-back transaction', () => {
  const database = new DatabaseSync(':memory:')
  const plan = planMigrations({
    actor: 'Outlet',
    migrations: [{ id: '0001_broken', sql: 'CREATE TABLE orders (id TEXT);' }],
    ledger: [],
    releaseId: 'release-1',
  })
  assert.throws(
    () => applyMigrationPlan(database, plan, { createRecoveryBookmark: () => {
      database.exec('CREATE TABLE orders (existing TEXT);')
      return 'bookmark-before-broken'
    } }),
    /Restore recovery bookmark bookmark-before-broken/,
  )
  const [entry] = readMigrationLedger(database, 'Outlet')
  assert.equal(entry.status, 'failed')
  assert.equal(entry.recoveryBookmark, 'bookmark-before-broken')
  assert.equal(database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'orders'").get().count, 1)
})

test('introspects schema metadata without returning business rows', () => {
  const database = new DatabaseSync(':memory:')
  database.exec("CREATE TABLE orders (id TEXT PRIMARY KEY, secret_note TEXT); INSERT INTO orders VALUES ('1', 'never expose me');")
  const schema = introspectActorSchema(database)
  assert.equal(schema.tables[0].name, 'orders')
  assert.deepEqual(schema.tables[0].columns.map(({ name }) => name), ['id', 'secret_note'])
  assert.equal(JSON.stringify(schema).includes('never expose me'), false)
})

test('preflight detects schema incompatibility and rolls back every attempted change', () => {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE orders (id TEXT PRIMARY KEY);')
  const plan = planMigrations({
    actor: 'Outlet',
    migrations: [{ id: '0001_conflict', sql: 'CREATE TABLE customers (id TEXT); CREATE TABLE orders (id TEXT);' }],
    ledger: [],
    releaseId: 'release-1',
  })
  assert.throws(() => preflightMigrationPlan(database, plan), /preflight failed without mutation/)
  assert.equal(database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'customers'").get().count, 0)
})
