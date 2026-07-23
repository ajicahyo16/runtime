import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  fingerprint,
  loadRuntimeProject,
  parseYaml,
  stableStringify,
  validateActorDocument,
  validateDevelopmentSeedSql,
  validateMigrationSql,
  validateOperationDocument,
  validateOperationSql,
  validateRuntimeDocument,
} from '../src/index.mjs'

const fixture = new URL('../fixtures/pos/lacify.runtime.yaml', import.meta.url)

test('loads and fingerprints the canonical POS fixture', async () => {
  const result = await loadRuntimeProject(fixture)
  assert.equal(result.valid, true, JSON.stringify(result.issues))
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(result.project.runtime.project, 'phase10-pos')
  assert.equal(result.project.actors[0].definition.name, 'Outlet')
  assert.equal(result.project.actors[0].migrations[0].id, '0001_initial')
  assert.deepEqual(result.project.actors[0].operations.map(({ definition }) => definition.name), ['GetOrder', 'ListOrders', 'PlaceOrder'])
})

test('normalization produces a stable fingerprint regardless of object key order', () => {
  const left = { version: 'v1', nested: { beta: 2, alpha: 1 } }
  const right = { nested: { alpha: 1, beta: 2 }, version: 'v1' }
  assert.equal(stableStringify(left), stableStringify(right))
  assert.equal(fingerprint(left), fingerprint(right))
})

test('project fingerprint ignores non-semantic command ordering', async () => {
  const original = await loadRuntimeProject(fixture)
  const root = await mkdtemp(path.join(os.tmpdir(), 'lacify-normalize-'))
  await cp(new URL('../fixtures/pos/', import.meta.url), root, { recursive: true })
  const actorPath = path.join(root, 'actors', 'outlet', 'actor.yaml')
  const actor = await readFile(actorPath, 'utf8')
  await writeFile(actorPath, actor.replace(
    '  - OpenShift\n  - PlaceOrder\n  - CapturePayment\n  - AdjustStock\n  - CloseShift',
    '  - CloseShift\n  - AdjustStock\n  - CapturePayment\n  - PlaceOrder\n  - OpenShift',
  ))
  const reordered = await loadRuntimeProject(path.join(root, 'lacify.runtime.yaml'))
  assert.equal(reordered.valid, true, JSON.stringify(reordered.issues))
  assert.equal(reordered.fingerprint, original.fingerprint)
})

test('operation references normalize deterministically and SQL changes the project fingerprint', async () => {
  const original = await loadRuntimeProject(fixture)
  const root = await mkdtemp(path.join(os.tmpdir(), 'lacify-operation-fingerprint-'))
  await cp(new URL('../fixtures/pos/', import.meta.url), root, { recursive: true })
  const actorPath = path.join(root, 'actors', 'outlet', 'actor.yaml')
  const actor = await readFile(actorPath, 'utf8')
  await writeFile(actorPath, actor.replace(
    '  - ./operations/place-order.operation.yaml\n  - ./operations/get-order.operation.yaml',
    '  - ./operations/get-order.operation.yaml\n  - ./operations/place-order.operation.yaml',
  ))
  const reordered = await loadRuntimeProject(path.join(root, 'lacify.runtime.yaml'))
  assert.equal(reordered.valid, true, JSON.stringify(reordered.issues))
  assert.equal(reordered.fingerprint, original.fingerprint)
  const sqlPath = path.join(root, 'actors', 'outlet', 'operations', 'get-order.sql')
  await writeFile(sqlPath, (await readFile(sqlPath, 'utf8')).replace('SELECT id,', 'SELECT outlet_id, id,'))
  const changed = await loadRuntimeProject(path.join(root, 'lacify.runtime.yaml'))
  assert.equal(changed.valid, true, JSON.stringify(changed.issues))
  assert.notEqual(changed.fingerprint, original.fingerprint)
})

test('Development seed changes do not affect the deployable project fingerprint', async () => {
  const original = await loadRuntimeProject(fixture)
  const root = await mkdtemp(path.join(os.tmpdir(), 'lacify-seed-fingerprint-'))
  await cp(new URL('../fixtures/pos/', import.meta.url), root, { recursive: true })
  const seedPath = path.join(root, 'actors', 'outlet', 'seeds', 'development.sql')
  await writeFile(seedPath, (await readFile(seedPath, 'utf8')).replace('5000', '9000'))
  const changed = await loadRuntimeProject(path.join(root, 'lacify.runtime.yaml'))
  assert.equal(changed.valid, true, JSON.stringify(changed.issues))
  assert.equal(changed.fingerprint, original.fingerprint)
  assert.match(changed.developmentSeeds[0].sql, /9000/)
})

test('rejects unknown fields and non-request-response runtime modes', () => {
  const issues = validateRuntimeDocument({
    version: 'lacify.dev/v1',
    project: 'demo',
    runtime: 'websocket',
    actors: ['./actors/order/actor.yaml'],
    token: 'must-not-exist',
  })
  assert.ok(issues.some((entry) => entry.code === 'unknown_field' && entry.path === 'token'))
  assert.ok(issues.some((entry) => entry.code === 'runtime_mode'))
})

test('rejects invalid state, command, and secret references', () => {
  const issues = validateActorDocument({
    version: 'lacify.dev/actor/v1',
    name: 'Outlet',
    partitionBy: 'outletId',
    storage: 'sqlite',
    commands: ['OpenShift'],
    stateMachines: [{
      name: 'ShiftLifecycle',
      initial: 'Missing',
      states: ['Closed', 'Open'],
      transitions: [{ command: 'UnknownCommand', from: 'Closed', to: 'Missing' }],
    }],
    secretRefs: ['raw-secret-value'],
  })
  assert.ok(issues.some((entry) => entry.code === 'command_reference'))
  assert.ok(issues.filter((entry) => entry.code === 'state_reference').length >= 2)
  assert.ok(issues.some((entry) => entry.code === 'secret_name'))
})

test('validates typed operation contracts and protects runtime-owned parameters', () => {
  const valid = {
    version: 'lacify.dev/operation/v1',
    name: 'PlaceOrder',
    kind: 'command',
    sql: './place-order.sql',
    input: { orderId: { type: 'string', required: true }, total: { type: 'integer' } },
    result: { mode: 'one', fields: { id: { type: 'string' } } },
  }
  assert.deepEqual(validateOperationDocument(valid, ['PlaceOrder']), [])
  const issues = validateOperationDocument({
    ...valid,
    name: 'UnknownCommand',
    input: { partitionId: { type: 'secret', required: 'yes' } },
    result: { mode: 'many', maxRows: 1000 },
  }, ['PlaceOrder'])
  assert.ok(issues.some((entry) => entry.code === 'command_reference'))
  assert.ok(issues.some((entry) => entry.code === 'runtime_parameter'))
  assert.ok(issues.some((entry) => entry.code === 'input_type'))
  assert.ok(issues.some((entry) => entry.code === 'row_limit'))
  assert.ok(validateOperationDocument({ ...valid, hidden: true }, ['PlaceOrder']).some((entry) => entry.code === 'unknown_field'))
})

test('allows bounded parameterized command and query SQL', () => {
  const command = {
    kind: 'command',
    input: { orderId: { type: 'string' }, total: { type: 'integer' } },
  }
  assert.deepEqual(validateOperationSql(
    "INSERT INTO orders (id, outlet_id, total, created_at) VALUES (:orderId, :partitionId, :total, :now) RETURNING id;\n",
    command,
  ), [])
  const query = { kind: 'query', input: { orderId: { type: 'string' } } }
  assert.deepEqual(validateOperationSql(
    'SELECT id, total FROM orders WHERE outlet_id = :partitionId AND id = :orderId;\n',
    query,
  ), [])
})

test('validates typed paginated result contracts and required SQL bindings', () => {
  const definition = {
    version: 'lacify.dev/operation/v1',
    name: 'ListOrders',
    kind: 'query',
    sql: './list-orders.sql',
    input: {},
    result: {
      mode: 'many',
      maxRows: 100,
      fields: { id: { type: 'string' }, total: { type: 'integer' } },
      pagination: { cursorField: 'id', defaultPageSize: 20, maxPageSize: 50 },
    },
  }
  assert.deepEqual(validateOperationDocument(definition, []), [])
  assert.deepEqual(validateOperationSql(
    'SELECT id, total FROM orders WHERE outlet_id = :partitionId AND (:cursor IS NULL OR id > :cursor) ORDER BY id LIMIT :pageSize;\n',
    definition,
  ), [])
  const issues = validateOperationSql(
    'SELECT id, total FROM orders WHERE outlet_id = :partitionId;\n',
    definition,
  )
  assert.ok(issues.some((entry) => entry.code === 'pagination_parameters'))
  assert.ok(issues.some((entry) => entry.code === 'pagination_order'))
})

test('rejects unsafe operation SQL and parameter drift', () => {
  const queryIssues = validateOperationSql(
    'UPDATE orders SET status = :status WHERE outlet_id = :partitionId;\n',
    { kind: 'query', input: { status: { type: 'string' } } },
  )
  assert.ok(queryIssues.some((entry) => entry.code === 'query_read_only'))
  const commandIssues = validateOperationSql(
    'UPDATE _lacify_migrations SET checksum = :unknown;\n',
    { kind: 'command', input: { unused: { type: 'string' } } },
  )
  assert.ok(commandIssues.some((entry) => entry.code === 'unbounded_write'))
  assert.ok(commandIssues.some((entry) => entry.code === 'internal_table'))
  assert.ok(commandIssues.some((entry) => entry.code === 'undeclared_parameter'))
  assert.ok(commandIssues.some((entry) => entry.code === 'unused_input'))
  assert.ok(commandIssues.some((entry) => entry.code === 'partition_scope'))
})

test('allows bounded Development seeds and rejects deployable or internal operations', () => {
  assert.deepEqual(validateDevelopmentSeedSql("INSERT INTO orders (id) VALUES ('seed');\nUPDATE orders SET status = 'ready' WHERE id = 'seed';\n"), [])
  const issues = validateDevelopmentSeedSql('CREATE TABLE unsafe (id TEXT);\nDELETE FROM _lacify_migrations;\nUPDATE orders SET status = "all";\n')
  assert.ok(issues.some((entry) => entry.code === 'unsupported_seed_statement'))
  assert.ok(issues.some((entry) => entry.code === 'internal_table'))
  assert.ok(issues.some((entry) => entry.code === 'unbounded_update'))
})

test('rejects duplicate YAML keys with line context', () => {
  const result = parseYaml('version: lacify.dev/v1\nversion: duplicate\n', 'duplicate.yaml')
  assert.equal(result.value, null)
  assert.equal(result.issues[0].code, 'yaml_syntax')
  assert.equal(result.issues[0].line, 2)
})

test('allows the bounded additive migration dialect', () => {
  const sql = 'CREATE TABLE orders (id TEXT PRIMARY KEY);\nALTER TABLE orders ADD COLUMN status TEXT;\nCREATE INDEX orders_status ON orders(status);\n'
  assert.deepEqual(validateMigrationSql(sql), [])
})

test('rejects destructive and unsupported SQL', () => {
  const issues = validateMigrationSql('DROP TABLE orders;\nPRAGMA foreign_keys = OFF;\n')
  assert.ok(issues.some((entry) => entry.code === 'unsupported_sql'))
  assert.ok(issues.some((entry) => entry.code === 'unsupported_statement'))
})

test('rejects unbounded UPDATE data migrations', () => {
  const issues = validateMigrationSql('UPDATE orders SET status = "archived";\n')
  assert.ok(issues.some((entry) => entry.code === 'unbounded_update'))
  assert.deepEqual(validateMigrationSql('UPDATE orders SET status = "archived" WHERE status = "closed";\n'), [])
})

test('reports missing Actor files without escaping the project root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lacify-spec-'))
  await mkdir(path.join(root, 'actors', 'missing'), { recursive: true })
  await writeFile(path.join(root, 'lacify.runtime.yaml'), 'version: lacify.dev/v1\nproject: missing-actor\nruntime: request-response\nactors:\n  - ./actors/missing/actor.yaml\n')
  const result = await loadRuntimeProject(path.join(root, 'lacify.runtime.yaml'))
  assert.equal(result.valid, false)
  assert.ok(result.issues.some((entry) => entry.code === 'missing_file'))
})

test('reports missing and duplicate operation files with repository context', async () => {
  const missingRoot = await mkdtemp(path.join(os.tmpdir(), 'lacify-missing-operation-'))
  await cp(new URL('../fixtures/pos/', import.meta.url), missingRoot, { recursive: true })
  const missingActorPath = path.join(missingRoot, 'actors', 'outlet', 'actor.yaml')
  await writeFile(missingActorPath, (await readFile(missingActorPath, 'utf8')).replace(
    '  - ./operations/get-order.operation.yaml',
    '  - ./operations/missing.operation.yaml',
  ))
  const missing = await loadRuntimeProject(path.join(missingRoot, 'lacify.runtime.yaml'))
  assert.ok(missing.issues.some((entry) => entry.code === 'missing_file' && /missing\.operation\.yaml$/.test(entry.file)))

  const duplicateRoot = await mkdtemp(path.join(os.tmpdir(), 'lacify-duplicate-operation-'))
  await cp(new URL('../fixtures/pos/', import.meta.url), duplicateRoot, { recursive: true })
  const operationsRoot = path.join(duplicateRoot, 'actors', 'outlet', 'operations')
  await cp(path.join(operationsRoot, 'get-order.operation.yaml'), path.join(operationsRoot, 'get-order-copy.operation.yaml'))
  await cp(path.join(operationsRoot, 'get-order.sql'), path.join(operationsRoot, 'get-order-copy.sql'))
  const copiedDefinition = await readFile(path.join(operationsRoot, 'get-order-copy.operation.yaml'), 'utf8')
  await writeFile(path.join(operationsRoot, 'get-order-copy.operation.yaml'), copiedDefinition.replace('./get-order.sql', './get-order-copy.sql'))
  const duplicateActorPath = path.join(duplicateRoot, 'actors', 'outlet', 'actor.yaml')
  await writeFile(duplicateActorPath, (await readFile(duplicateActorPath, 'utf8')).replace(
    '  - ./operations/get-order.operation.yaml',
    '  - ./operations/get-order.operation.yaml\n  - ./operations/get-order-copy.operation.yaml',
  ))
  const duplicate = await loadRuntimeProject(path.join(duplicateRoot, 'lacify.runtime.yaml'))
  assert.ok(duplicate.issues.some((entry) => entry.code === 'duplicate_operation'))
})

test('reports semantic validation issues with file and line context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lacify-lines-'))
  const actorDirectory = path.join(root, 'actors', 'outlet')
  await mkdir(path.join(actorDirectory, 'migrations'), { recursive: true })
  await writeFile(path.join(root, 'lacify.runtime.yaml'), 'version: lacify.dev/v1\nproject: line-context\nruntime: request-response\nactors:\n  - ./actors/outlet/actor.yaml\n')
  await writeFile(path.join(actorDirectory, 'actor.yaml'), 'version: lacify.dev/actor/v1\nname: Outlet\npartitionBy: INVALID_KEY\nstorage: sqlite\ncommands:\n  - OpenShift\n')
  await writeFile(path.join(actorDirectory, 'migrations', '0001_initial.sql'), 'CREATE TABLE shifts (id TEXT PRIMARY KEY);\n')
  const result = await loadRuntimeProject(path.join(root, 'lacify.runtime.yaml'))
  const partitionIssue = result.issues.find((entry) => entry.path === 'partitionBy')
  assert.equal(partitionIssue.line, 3)
  assert.match(partitionIssue.file, /actor\.yaml$/)
})

test('rejects duplicate Actor names across project files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lacify-actors-'))
  await cp(new URL('../fixtures/pos/', import.meta.url), root, { recursive: true })
  await cp(path.join(root, 'actors', 'outlet'), path.join(root, 'actors', 'outlet-copy'), { recursive: true })
  await writeFile(path.join(root, 'lacify.runtime.yaml'), 'version: lacify.dev/v1\nproject: duplicate-actors\nruntime: request-response\nactors:\n  - ./actors/outlet/actor.yaml\n  - ./actors/outlet-copy/actor.yaml\n')
  const result = await loadRuntimeProject(path.join(root, 'lacify.runtime.yaml'))
  assert.equal(result.valid, false)
  assert.ok(result.issues.some((entry) => entry.code === 'duplicate_actor'))
})

test('loads POS, inventory, booking, and approval fixtures', async () => {
  for (const name of ['pos', 'inventory', 'booking', 'approval']) {
    const result = await loadRuntimeProject(new URL(`../fixtures/${name}/lacify.runtime.yaml`, import.meta.url))
    assert.equal(result.valid, true, `${name}: ${JSON.stringify(result.issues)}`)
  }
})
