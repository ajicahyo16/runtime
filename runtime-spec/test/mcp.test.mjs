import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { runCli } from '../src/cli.mjs'
import { handleMcpRequest, LacifyMcpService } from '../src/mcp-service.mjs'

const sink = { stdout: { write() {} } }

async function fixture(role = 'owner') {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-mcp-'))
  await runCli(['init', '--project', 'mcp-test'], sink, root)
  return { root, service: new LacifyMcpService({ root, role, user: 'test-user' }) }
}

test('MCP exposes bounded project resources and all planned tools', async () => {
  const { service } = await fixture()
  const initialized = await handleMcpRequest(service, { method: 'initialize' })
  assert.equal(initialized.serverInfo.name, 'lacify-runtime')
  const resources = await service.listResources()
  assert.equal(resources.length, 3)
  assert.equal(service.tools().length, 41)
  const project = await service.callTool('get_project')
  assert.equal(project.project, 'mcp-test')
  assert.equal(JSON.stringify(project).includes('sqlite'), true)
})

test('MCP exposes operation contracts and generates a typed client without business rows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-mcp-operations-'))
  await cp(new URL('../fixtures/pos/', import.meta.url), root, { recursive: true })
  const service = new LacifyMcpService({ root, role: 'owner', user: 'test-user' })
  const operation = await service.callTool('get_operation_schema', { actor: 'Outlet', operation: 'GetOrder' })
  assert.equal(operation.definition.kind, 'query')
  assert.match(operation.sql, /:partitionId/)
  assert.equal(JSON.stringify(operation).includes('order-1'), false)
  const generated = await service.callTool('generate_typed_client')
  assert.equal(generated.generated, true)
  const resources = await service.listResources()
  assert.equal(resources.length, 6)
  const schemaResource = await service.readResource(`lacify://projects/phase10-pos/actors/Outlet/schema`)
  assert.equal(schemaResource.text.includes('seed-order'), false)
  assert.equal(schemaResource.text.includes('5000'), false)
})

test('MCP validates operation proposals, exposes safe data models, and returns bounded release plans', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-mcp-authoring-'))
  await cp(new URL('../fixtures/pos/', import.meta.url), root, { recursive: true })
  let remoteCalls = 0
  const service = new LacifyMcpService({ root, role: 'owner', user: 'test-user', remote: { request: async () => { remoteCalls += 1; return {} } } })
  const model = await service.callTool('get_actor_data_model', { actor: 'Outlet' })
  assert.ok(model.tables.some(({ name }) => name === 'orders'))
  assert.equal(JSON.stringify(model).includes('seed-order'), false)
  assert.equal(JSON.stringify(model).includes('PAYMENT_API_KEY'), false)

  const operationYaml = await readFile(path.join(root, 'actors', 'outlet', 'operations', 'get-order.operation.yaml'), 'utf8')
  const sql = await readFile(path.join(root, 'actors', 'outlet', 'operations', 'get-order.sql'), 'utf8')
  const proposal = await service.callTool('validate_operation_proposal', { actor: 'Outlet', operationYaml, sql })
  assert.equal(proposal.valid, true, JSON.stringify(proposal.diagnostics))
  assert.equal(proposal.schemaCompatible, true)
  assert.equal(proposal.remoteMutation, false)
  assert.equal(remoteCalls, 0)

  const unsafe = await service.callTool('validate_operation_proposal', {
    actor: 'Outlet',
    operationYaml,
    sql: 'SELECT * FROM _lacify_migrations WHERE id = :partitionId;',
  })
  assert.equal(unsafe.valid, false)
  assert.ok(unsafe.diagnostics.some(({ code }) => code === 'internal_table'))
  const plan = await service.callTool('plan_operation_release')
  assert.equal(plan.remoteMutation, false)
  assert.equal(JSON.stringify(plan).includes('SELECT '), false)
  assert.match(plan.actors[0].operations[0].operationFingerprint, /^[a-f0-9]{64}$/)
  const tests = await service.callTool('run_local_operation_tests')
  assert.equal(tests.passed, true)
  assert.equal(tests.tests.length, 3)
})

test('remote Development operation tests require an exact approved plan and return no business rows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-mcp-remote-operation-'))
  await cp(new URL('../fixtures/pos/', import.meta.url), root, { recursive: true })
  const runtimeCalls = []
  const remote = {
    async request(route) {
      assert.match(route, /monitor-overview/)
      return {
        environments: [{
          environment: 'dev',
          deployment: {
            id: 'deploy_dev_1',
            releaseId: 'release_dev_1',
            status: 'succeeded',
            runtimeUrl: 'https://phase11-dev.example.workers.dev',
          },
        }],
      }
    },
  }
  const runtimeFetch = async (url, init) => {
    runtimeCalls.push({ url, init })
    return Response.json({
      success: true,
      command: 'PlaceOrder',
      operation: 'PlaceOrder',
      partitionId: 'private-partition',
      state: 'Placed',
      version: 1,
      lifecycle: [],
      eventId: 'event-private',
      data: { id: 'order-private', total: 1250, status: 'Confirmed' },
    })
  }
  const runtimeToken = `lacify_runtime_${'t'.repeat(43)}`
  const service = new LacifyMcpService({ root, role: 'developer', user: 'test-user', remote, runtimeFetch, runtimeToken })
  const request = {
    actor: 'Outlet',
    operation: 'PlaceOrder',
    partition: 'private-partition',
    input: { orderId: 'order-private', total: 1250 },
    idempotencyKey: 'mcp-test-1',
    expectedData: { id: 'order-private', total: 1250, status: 'Confirmed' },
  }
  const plan = await service.callTool('plan_development_operation_test', request)
  assert.equal(plan.remoteMutation, false)
  assert.equal(JSON.stringify(plan).includes('private-partition'), false)
  assert.equal(JSON.stringify(plan).includes('order-private'), false)
  await assert.rejects(() => service.callTool('execute_development_operation_test', {
    ...request,
    approved: false,
    planId: plan.planId,
    projectFingerprint: plan.projectFingerprint,
  }), /Explicit approval/)
  await assert.rejects(() => service.callTool('execute_development_operation_test', {
    ...request,
    input: { orderId: 'changed', total: 1250 },
    approved: true,
    planId: plan.planId,
    projectFingerprint: plan.projectFingerprint,
  }), /replay blocked/)
  const result = await service.callTool('execute_development_operation_test', {
    ...request,
    approved: true,
    planId: plan.planId,
    projectFingerprint: plan.projectFingerprint,
  })
  assert.equal(result.passed, true)
  assert.equal(result.dataMatched, true)
  assert.equal(result.businessRowsReturned, false)
  assert.equal(JSON.stringify(result).includes('order-private'), false)
  assert.equal(runtimeCalls.length, 1)
  assert.match(runtimeCalls[0].url, /phase11-dev\.example\.workers\.dev\/v1\/outlets\/private-partition\/commands/)
  assert.equal(runtimeCalls[0].init.headers.authorization, `Bearer ${runtimeToken}`)
  const audit = JSON.parse((await readFile(path.join(root, '.lacify', 'audit.jsonl'), 'utf8')).trim())
  assert.equal(audit.action, 'mcp.execute_development_operation_test')
  assert.equal('input' in audit, false)
  assert.equal('partition' in audit, false)
  assert.match(audit.inputHash, /^[a-f0-9]{64}$/)
})

test('Viewer cannot mutate and stale plans cannot be replayed', async () => {
  const { service: viewer } = await fixture('viewer')
  const plan = await viewer.callTool('plan_migration')
  await assert.rejects(() => viewer.callTool('apply_development_plan', {
    approved: true,
    planId: plan.plans[0].planId,
    projectFingerprint: plan.projectFingerprint,
  }), /role cannot apply/)

  const { service } = await fixture()
  const current = await service.callTool('plan_migration')
  await assert.rejects(() => service.callTool('apply_development_plan', {
    approved: true,
    planId: 'stale-plan',
    projectFingerprint: current.projectFingerprint,
  }), /Plan replay blocked/)
})

test('approved MCP Development apply is audited without business payloads', async () => {
  const { root, service } = await fixture()
  const plan = await service.callTool('plan_migration')
  const result = await service.callTool('apply_development_plan', {
    approved: true,
    planId: plan.plans[0].planId,
    projectFingerprint: plan.projectFingerprint,
  })
  assert.equal(result.applied, true)
  const audit = JSON.parse((await readFile(path.join(root, '.lacify', 'audit.jsonl'), 'utf8')).trim())
  assert.equal(audit.user, 'test-user')
  assert.equal(audit.result, 'applied')
  assert.equal('payload' in audit, false)
})

test('MCP prepares and applies an exact metadata-only project review', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-mcp-review-'))
  await runCli(['init', '--project', 'mcp-reviewed', '--template', 'personal'], sink, root)
  const service = new LacifyMcpService({ root, role: 'developer', user: 'review-user' })
  const review = await service.callTool('prepare_project_change_review')
  assert.match(review.reviewId, /^review_[a-f0-9]{40}$/)
  assert.equal(review.tests.passed, true)
  assert.equal(review.remoteMutation, false)
  assert.equal(review.businessRowsReturned, false)
  assert.equal(JSON.stringify(review).includes('A private note'), false)

  await assert.rejects(() => service.callTool('apply_reviewed_development_change', {
    approved: false,
    reviewId: review.reviewId,
    projectFingerprint: review.projectFingerprint,
  }), /Explicit approval/)
  const applied = await service.callTool('apply_reviewed_development_change', {
    approved: true,
    reviewId: review.reviewId,
    projectFingerprint: review.projectFingerprint,
    remote: false,
  })
  assert.equal(applied.reviewedBy, review.reviewId)
  assert.equal(applied.businessRowsReturned, false)
  const entries = (await readFile(path.join(root, '.lacify', 'audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(entries.at(-1).action, 'mcp.apply_reviewed_development_change')
  assert.equal('payload' in entries.at(-1), false)

  await runCli(['integrate'], sink, root)
  const readiness = await service.callTool('get_project_readiness', { remote: false })
  assert.equal(readiness.ready, true)
  assert.equal(readiness.secretsReturned, false)
  assert.equal(readiness.businessRowsReturned, false)

  await assert.rejects(() => service.callTool('create_local_snapshot', { approved: false }), /Explicit approval/)
  const snapshot = await service.callTool('create_local_snapshot', { approved: true })
  assert.equal(snapshot.businessRowsReturned, false)
  const verified = await service.callTool('verify_local_snapshot', { snapshotId: snapshot.snapshot.snapshotId })
  assert.equal(verified.verified, true)
  const rehearsal = await service.callTool('rehearse_local_restore', { approved: true, snapshotId: snapshot.snapshot.snapshotId })
  assert.equal(rehearsal.passed, true)
  assert.equal(rehearsal.activeDevelopmentOverwritten, false)

  const archiveRoot = await mkdtemp(path.join(tmpdir(), 'lacify-mcp-archive-'))
  const archiveFile = path.join(archiveRoot, 'project.lacify.enc')
  const recovered = path.join(archiveRoot, 'recovered')
  service.archiveEnvironment = { LACIFY_ARCHIVE_PASSPHRASE: 'mcp protected archive passphrase' }
  await assert.rejects(() => service.callTool('create_encrypted_archive', {
    approved: false,
    snapshotId: snapshot.snapshot.snapshotId,
    outputFile: archiveFile,
  }), /Explicit approval/)
  const archive = await service.callTool('create_encrypted_archive', {
    approved: true,
    snapshotId: snapshot.snapshot.snapshotId,
    outputFile: archiveFile,
  })
  assert.equal(archive.encrypted, true)
  assert.equal(archive.passphraseReturned, false)
  assert.equal((await service.callTool('inspect_encrypted_archive', { file: archiveFile })).encryptedPayloadInspected, false)
  assert.equal((await service.callTool('verify_encrypted_archive', { file: archiveFile })).verified, true)
  const archiveRestore = await service.callTool('restore_encrypted_archive', {
    approved: true,
    file: archiveFile,
    target: recovered,
  })
  assert.equal(archiveRestore.restored, true)
  assert.equal(archiveRestore.existingProjectOverwritten, false)
})

test('MCP plans and installs an exact Actor extension without exposing SQL', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-mcp-module-'))
  await runCli(['init', '--project', 'mcp-module', '--template', 'personal'], sink, root)
  const service = new LacifyMcpService({ root, role: 'developer', user: 'module-user' })
  const modules = await service.callTool('list_modules')
  assert.equal(modules.modules.length, 2)
  const plan = await service.callTool('plan_module_install', { module: 'workspace-tasks', actor: 'Workspace', version: '1.0.0' })
  assert.equal(plan.valid, true)
  assert.equal(plan.remoteMutation, false)
  assert.equal(JSON.stringify(plan).includes('CREATE TABLE'), false)
  await assert.rejects(() => service.callTool('install_module', {
    approved: false,
    module: 'workspace-tasks',
    actor: 'Workspace',
    version: '1.0.0',
    planId: plan.planId,
    projectFingerprint: plan.projectFingerprint,
  }), /Explicit approval/)
  const installed = await service.callTool('install_module', {
    approved: true,
    module: 'workspace-tasks',
    actor: 'Workspace',
    version: '1.0.0',
    planId: plan.planId,
    projectFingerprint: plan.projectFingerprint,
  })
  assert.equal(installed.installed, true)
  assert.equal(installed.businessRowsReturned, false)
  assert.equal((await service.callTool('run_local_operation_tests')).passed, true)
  const status = await service.callTool('get_module_status')
  assert.equal(status.modules[0].state, 'update-available')
  const upgradePlan = await service.callTool('plan_module_upgrade', { module: 'workspace-tasks', actor: 'Workspace' })
  assert.equal(upgradePlan.valid, true)
  const upgraded = await service.callTool('upgrade_module', {
    approved: true,
    module: 'workspace-tasks',
    actor: 'Workspace',
    planId: upgradePlan.planId,
    projectFingerprint: upgradePlan.projectFingerprint,
  })
  assert.equal(upgraded.fromVersion, '1.0.0')
  assert.equal(upgraded.toVersion, '1.1.0')
  const audit = (await readFile(path.join(root, '.lacify', 'audit.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).at(-1)
  assert.equal(audit.action, 'mcp.upgrade_module')
  assert.equal('sql' in audit, false)
})
