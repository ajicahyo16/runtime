import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { generateTypeScriptClient, renderTypeScriptClient } from '../src/client-generator.mjs'
import { loadRuntimeProject } from '../src/index.mjs'
import { integrationManifest, renderServerAdapter } from '../src/integration-generator.mjs'

test('generates a deterministic typed client from a validated project', async () => {
  const project = await loadRuntimeProject(new URL('../fixtures/pos/lacify.runtime.yaml', import.meta.url))
  const first = renderTypeScriptClient(project)
  const second = renderTypeScriptClient(project)
  assert.equal(first, second)
  assert.match(first, /export type OutletCommand/)
  assert.match(first, /\"PlaceOrder\"/)
  assert.equal(first.includes('/v1/${collection}/${encodeURIComponent(partition)}/commands'), true)
  assert.equal(first.includes('JSON.stringify({ command, payload: input })'), true)
  assert.match(first, /export interface OutletPlaceOrderInput/)
  assert.match(first, /export interface OutletPlaceOrderRow/)
  assert.match(first, /export interface OutletGetOrderRow/)
  assert.match(first, /export interface OutletListOrdersRow/)
  assert.match(first, /orderId: string/)
  assert.match(first, /total: number/)
  assert.match(first, /placeOrder:/)
  assert.match(first, /getOrder:/)
  assert.match(first, /listOrders:/)
  assert.match(first, /commandOperation<OutletPlaceOrderRow>/)
  assert.match(first, /LacifyOperationResponse<T>/)
  assert.match(first, /LacifyPage<OutletListOrdersRow>/)
  assert.match(first, /page: LacifyPageRequest/)
  assert.equal(first.includes('/queries/${encodeURIComponent(operation)}'), true)
  assert.match(first, /idempotency-key/)
  assert.match(first, new RegExp(project.fingerprint))
  const withNone = structuredClone(project)
  withNone.project.actors[0].operations.push({
    definition: {
      version: 'lacify.dev/operation/v1',
      name: 'ResetOutlet',
      kind: 'command',
      sql: './reset-outlet.sql',
      input: {},
      result: { mode: 'none' },
    },
    sql: 'DELETE FROM orders WHERE outlet_id = :partitionId;\n',
  })
  assert.match(renderTypeScriptClient(withNone), /commandOperation<null>/)
  const output = await mkdtemp(path.join(tmpdir(), 'lacify-client-'))
  const file = await generateTypeScriptClient(project, output)
  assert.equal(await readFile(file, 'utf8'), first)
  const adapter = path.join(output, 'server.ts')
  await writeFile(adapter, renderServerAdapter(project))
  const manifest = integrationManifest(project)
  assert.equal(manifest.projectFingerprint, project.fingerprint)
  assert.equal(JSON.stringify(manifest).includes('lacify_runtime_'), false)
  const typecheck = spawnSync(path.resolve('node_modules/.bin/tsc'), [
    '--ignoreConfig',
    '--noEmit',
    '--strict',
    '--target', 'ES2022',
    '--module', 'ESNext',
    '--lib', 'ES2022,DOM',
    '--skipLibCheck',
    file,
    adapter,
  ], { encoding: 'utf8' })
  assert.equal(typecheck.status, 0, typecheck.stdout || typecheck.stderr)
})
