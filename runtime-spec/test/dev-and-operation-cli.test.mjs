import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runCli } from '../src/cli.mjs'
import { createLocalDevServer } from '../src/dev-server.mjs'
import { loadRuntimeProject } from '../src/index.mjs'

function capture() {
  let value = ''
  return { io: { stdout: { write: (chunk) => { value += chunk } } }, read: () => JSON.parse(value) }
}

test('lacify test runs deterministic repository operation fixtures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lacify-operation-test-'))
  await cp(new URL('../fixtures/pos/', import.meta.url), root, { recursive: true })
  const stream = capture()
  assert.equal(await runCli(['test', '--json'], stream.io, root), 0)
  const result = stream.read()
  assert.equal(result.tests.length, 3)
  assert.equal(result.tests.find(({ file }) => file === 'place-and-read.operation.json').steps, 2)
})

test('local dev runtime executes command and query routes with partition isolation', async () => {
  const project = await loadRuntimeProject(new URL('../fixtures/pos/lacify.runtime.yaml', import.meta.url))
  const server = await createLocalDevServer(project, { port: 0 })
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  try {
    const command = await fetch(`${base}/v1/outlets/outlet-a/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'dev-order-1' },
      body: JSON.stringify({ command: 'PlaceOrder', payload: { orderId: 'order-1', total: 1250 } }),
    })
    assert.equal(command.status, 200)
    assert.equal((await command.json()).data.id, 'order-1')
    const query = await fetch(`${base}/v1/outlets/outlet-a/queries/GetOrder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { orderId: 'order-1' } }),
    })
    assert.equal((await query.json()).data.id, 'order-1')
    const isolated = await fetch(`${base}/v1/outlets/outlet-b/queries/GetOrder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { orderId: 'order-1' } }),
    })
    assert.equal((await isolated.json()).data, null)
    const invalid = await fetch(`${base}/v1/outlets/outlet-a/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'PlaceOrder', payload: { orderId: 'bad-order', total: 'invalid' } }),
    })
    const invalidBody = await invalid.json()
    assert.equal(invalidBody.error.code, 'invalid_input_type')
    assert.equal(JSON.stringify(invalidBody).includes('INSERT INTO'), false)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('local runtime reload resets in-memory state, reapplies seeds, and surfaces validation diagnostics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lacify-dev-reload-'))
  await cp(new URL('../fixtures/pos/', import.meta.url), root, { recursive: true })
  const runtimeFile = path.join(root, 'lacify.runtime.yaml')
  const load = () => loadRuntimeProject(runtimeFile)
  const project = await load()
  const server = await createLocalDevServer(project, { port: 0, watchRoot: root, reloadProject: load })
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  const seededOrder = async () => fetch(`${base}/v1/outlets/seed-outlet/queries/GetOrder`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { orderId: 'seed-order' } }),
  }).then((response) => response.json())
  try {
    assert.equal((await seededOrder()).data.total, 5000)
    const seedPath = path.join(root, 'actors', 'outlet', 'seeds', 'development.sql')
    await writeFile(seedPath, (await readFile(seedPath, 'utf8')).replace('5000', '6000'))
    if (server.hotReload) {
      let generation = 1
      for (let attempt = 0; attempt < 40 && generation < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        generation = await fetch(`${base}/health`).then((response) => response.json()).then((body) => body.generation)
      }
      assert.equal(generation >= 2, true)
    } else {
      assert.equal((await server.reload()).reloaded, true)
    }
    assert.equal((await seededOrder()).data.total, 6000)

    const operationPath = path.join(root, 'actors', 'outlet', 'operations', 'get-order.operation.yaml')
    const original = await readFile(operationPath, 'utf8')
    await writeFile(operationPath, `${original}unknownField: true\n`)
    assert.equal((await server.reload()).reloaded, false)
    const unhealthy = await fetch(`${base}/health`)
    assert.equal(unhealthy.status, 503)
    assert.equal((await unhealthy.json()).diagnostics[0].code, 'unknown_field')
    await writeFile(operationPath, original)
    assert.equal((await server.reload()).reloaded, true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('lacify test failures include bounded file, Actor, operation, and recovery context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lacify-operation-diagnostic-'))
  await cp(new URL('../fixtures/pos/', import.meta.url), root, { recursive: true })
  const fixturePath = path.join(root, 'tests', 'invalid-input.operation.json')
  const source = await readFile(fixturePath, 'utf8')
  await writeFile(fixturePath, source.replace('invalid_input_type', 'wrong_expected_code'))
  await assert.rejects(
    () => runCli(['test', '--json'], capture().io, root),
    (error) => {
      assert.match(error.message, /invalid-input\.operation\.json: Actor Outlet, operation PlaceOrder, step 1 failed \[invalid_input_type\]/)
      assert.match(error.message, /place-order\.operation\.yaml/)
      assert.match(error.message, /place-order\.sql/)
      assert.match(error.message, /transaction was rolled back/)
      assert.equal(error.message.includes('INSERT INTO'), false)
      return true
    },
  )
})
