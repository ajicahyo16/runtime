import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { runCli } from '../src/cli.mjs'
import { loadRuntimeProject } from '../src/index.mjs'
import { LacifyMcpService } from '../src/mcp-service.mjs'
import { moduleStatus } from '../src/module-system.mjs'
import { workspaceProjects } from '../src/workspace-catalog.mjs'

function capture() {
  let value = ''
  return {
    io: { stdout: { write: (chunk) => { value += chunk } } },
    read: () => JSON.parse(value),
  }
}

async function jsonCommand(root, command, args = []) {
  const stream = capture()
  const code = await runCli([command, ...args, '--json'], stream.io, root)
  return { code, result: stream.read() }
}

async function fileExists(file) {
  try { await access(file); return true } catch { return false }
}

async function installModule(root, moduleName) {
  const planned = await jsonCommand(root, 'module-plan', [moduleName, '--actor', 'Workspace'])
  assert.equal(planned.code, 0)
  assert.equal((await jsonCommand(root, 'add', [
    moduleName,
    '--actor', 'Workspace',
    '--plan', planned.result.planId,
    '--approve',
  ])).code, 0)
}

async function installProjectsModule(root) {
  return installModule(root, 'workspace-projects')
}

test('immutable blueprint exports canonical structure and creates an independent project', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'lacify-blueprint-'))
  await jsonCommand(workspace, 'workspace-init', ['--name', 'blueprint-lab'])
  const sourceRoot = path.join(workspace, 'source-crm')
  await jsonCommand(sourceRoot, 'init', ['--project', 'source-crm', '--template', 'personal'])
  await installProjectsModule(sourceRoot)
  await jsonCommand(workspace, 'workspace-add', ['source-crm'])

  const exported = await jsonCommand(workspace, 'blueprint-export', [
    '--project', 'source-crm',
    '--name', 'crm-starter',
    '--version', '1.0.0',
    '--description', 'Reusable CRM structure',
  ])
  assert.equal(exported.code, 0)
  assert.equal(exported.result.businessRowsIncluded, false)
  assert.equal(exported.result.secretsIncluded, false)
  assert.equal(exported.result.modules[0].module, 'workspace-projects')
  await assert.rejects(
    () => runCli(['blueprint-export', '--project', 'source-crm', '--name', 'crm-starter', '--version', '1.0.0'], capture().io, workspace),
    /immutable versions cannot be overwritten/,
  )

  const listed = await jsonCommand(workspace, 'blueprints')
  assert.equal(listed.result.blueprints.length, 1)
  assert.equal(listed.result.businessRowsReturned, false)
  const inspected = await jsonCommand(workspace, 'blueprint-info', ['crm-starter', '--version', '1.0.0'])
  assert.equal(inspected.result.files.some(({ path: file }) => file.includes('seeds/')), false)
  assert.equal(inspected.result.files.some(({ path: file }) => file.startsWith('tests/')), false)
  assert.equal(inspected.result.files.some(({ path: file }) => file.startsWith('.lacify/')), false)

  const planned = await jsonCommand(workspace, 'blueprint-plan', [
    'crm-starter',
    '--version', '1.0.0',
    '--project', 'second-crm',
    '--path', 'second-crm',
  ])
  assert.equal(planned.code, 0)
  assert.notEqual(planned.result.projectedFingerprint, exported.result.sourceFingerprint)
  assert.equal(planned.result.businessRowsIncluded, false)
  await assert.rejects(
    () => runCli([
      'blueprint-create', 'crm-starter',
      '--version', '1.0.0',
      '--project', 'second-crm',
      '--path', 'second-crm',
      '--plan', planned.result.planId,
    ], capture().io, workspace),
    /Explicit approval/,
  )
  const created = await jsonCommand(workspace, 'blueprint-create', [
    'crm-starter',
    '--version', '1.0.0',
    '--project', 'second-crm',
    '--path', 'second-crm',
    '--plan', planned.result.planId,
    '--approve',
  ])
  assert.equal(created.code, 0)
  assert.equal(created.result.independentStorage, true)
  assert.equal(created.result.projectFingerprint, planned.result.projectedFingerprint)

  const newRoot = path.join(workspace, 'second-crm')
  const project = await loadRuntimeProject(path.join(newRoot, 'lacify.runtime.yaml'))
  assert.equal(project.valid, true, JSON.stringify(project.issues))
  assert.equal(project.project.runtime.project, 'second-crm')
  assert.equal(project.developmentSeeds.length, 0)
  assert.equal(await fileExists(path.join(newRoot, 'tests', 'README.md')), true)
  assert.equal(await fileExists(path.join(newRoot, 'tests', 'create-and-read.operation.json')), false)
  assert.equal(await fileExists(path.join(newRoot, '.lacify', 'development')), false)
  assert.equal(await fileExists(path.join(newRoot, '.lacify', 'reviews')), false)
  assert.equal(await fileExists(path.join(newRoot, '.lacify', 'modules.json')), false)
  assert.equal(await fileExists(path.join(newRoot, 'generated')), false)
  const modules = await moduleStatus({ root: newRoot, project })
  assert.equal(modules.modules.length, 0)
  assert.equal((await workspaceProjects(workspace)).projects.length, 2)

  await assert.rejects(
    () => runCli(['blueprint-plan', 'crm-starter', '--version', '1.0.0', '--project', 'source-crm'], capture().io, workspace),
    /already exists/,
  )
  await assert.rejects(
    () => runCli(['blueprint-plan', 'crm-starter', '--version', '1.0.0', '--project', 'third-crm', '--path', 'nested\\/third'], capture().io, workspace),
    /direct child directory/,
  )

  const blueprintFile = path.join(workspace, '.lacify', 'blueprints', 'crm-starter', '1.0.0', 'files', 'lacify.runtime.yaml')
  await writeFile(blueprintFile, `${await readFile(blueprintFile, 'utf8')}\n`)
  await assert.rejects(
    () => runCli(['blueprint-info', 'crm-starter', '--version', '1.0.0'], capture().io, workspace),
    /integrity verification/,
  )
})

test('blueprint export rejects migrations that can carry business rows', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'lacify-blueprint-data-'))
  await jsonCommand(workspace, 'workspace-init', ['--name', 'data-safety'])
  const sourceRoot = path.join(workspace, 'source')
  await jsonCommand(sourceRoot, 'init', ['--project', 'data-source', '--template', 'personal'])
  await writeFile(
    path.join(sourceRoot, 'actors', 'workspace', 'migrations', '0002_private_row.sql'),
    "INSERT INTO notes (id, body, created_at, updated_at) VALUES ('private', 'must-not-copy', 1, 1);\n",
  )
  await jsonCommand(workspace, 'workspace-add', ['source'])
  await assert.rejects(
    () => runCli(['blueprint-export', '--project', 'data-source', '--name', 'unsafe', '--version', '1.0.0'], capture().io, workspace),
    /blocks data-changing migration/,
  )
})

test('MCP previews blueprint projects and requires exact approved source context to create', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'lacify-blueprint-mcp-'))
  await jsonCommand(workspace, 'workspace-init', ['--name', 'blueprint-mcp'])
  const sourceRoot = path.join(workspace, 'source')
  const peerRoot = path.join(workspace, 'peer')
  await jsonCommand(sourceRoot, 'init', ['--project', 'blueprint-source', '--template', 'personal'])
  await jsonCommand(peerRoot, 'init', ['--project', 'blueprint-peer', '--template', 'personal'])
  await jsonCommand(workspace, 'workspace-add', ['source'])
  await jsonCommand(workspace, 'workspace-add', ['peer'])
  await jsonCommand(workspace, 'blueprint-export', [
    '--project', 'blueprint-source',
    '--name', 'personal-starter',
    '--version', '1.0.0',
  ])

  const service = new LacifyMcpService({
    root: sourceRoot,
    workspaceRoot: workspace,
    mcpProject: 'blueprint-source',
    role: 'developer',
    user: 'blueprint-test',
  })
  assert.equal(service.tools().length, 41)
  const listed = await service.callTool('list_project_blueprints')
  assert.equal(listed.blueprints.length, 1)
  assert.equal(listed.businessRowsReturned, false)
  const inspected = await service.callTool('get_project_blueprint', { name: 'personal-starter', version: '1.0.0' })
  assert.equal(inspected.businessRowsIncluded, false)
  assert.equal(JSON.stringify(inspected).includes('CREATE TABLE'), false)
  const planned = await service.callTool('plan_project_from_blueprint', {
    name: 'personal-starter',
    version: '1.0.0',
    project: 'mcp-created',
    actorRenames: { Workspace: 'McpWorkspace' },
    partitionKeys: { Workspace: 'mcpWorkspaceId' },
    modules: [],
  })
  assert.equal(planned.actors[0].name, 'McpWorkspace')
  assert.equal(planned.actors[0].partitionBy, 'mcpWorkspaceId')
  await assert.rejects(
    () => service.callTool('create_project_from_blueprint', {
      name: 'personal-starter',
      version: '1.0.0',
      project: 'mcp-created',
      planId: planned.planId,
      blueprintFingerprint: planned.blueprintFingerprint,
      approved: false,
    }),
    /Explicit approval/,
  )
  await assert.rejects(
    () => service.callTool('create_project_from_blueprint', {
      name: 'personal-starter',
      version: '1.0.0',
      project: 'mcp-created',
      planId: planned.planId,
      blueprintFingerprint: '0'.repeat(64),
      approved: true,
    }),
    /fingerprint changed/,
  )

  const peerService = new LacifyMcpService({
    root: peerRoot,
    workspaceRoot: workspace,
    mcpProject: 'blueprint-peer',
    role: 'developer',
  })
  await assert.rejects(
    () => peerService.callTool('create_project_from_blueprint', {
      name: 'personal-starter',
      version: '1.0.0',
      project: 'mcp-created',
      planId: planned.planId,
      blueprintFingerprint: planned.blueprintFingerprint,
      approved: true,
    }),
    /selected source project context/,
  )

  const created = await service.callTool('create_project_from_blueprint', {
    name: 'personal-starter',
    version: '1.0.0',
    project: 'mcp-created',
    planId: planned.planId,
    blueprintFingerprint: planned.blueprintFingerprint,
    actorRenames: { Workspace: 'McpWorkspace' },
    partitionKeys: { Workspace: 'mcpWorkspaceId' },
    modules: [],
    approved: true,
  })
  assert.equal(created.created, true)
  assert.equal(created.independentStorage, true)
  assert.equal(created.actors[0].name, 'McpWorkspace')
  const audit = await readFile(path.join(sourceRoot, '.lacify', 'audit.jsonl'), 'utf8')
  assert.equal(audit.includes('mcp.create_project_from_blueprint'), true)
  assert.equal(audit.includes('CREATE TABLE'), false)
  assert.equal(audit.includes('must-not-copy'), false)
})

test('one composable blueprint creates independent Actor and module configurations', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'lacify-blueprint-compose-'))
  await jsonCommand(workspace, 'workspace-init', ['--name', 'composition-lab'])
  const sourceRoot = path.join(workspace, 'source')
  await jsonCommand(sourceRoot, 'init', ['--project', 'composition-source', '--template', 'personal'])
  await installModule(sourceRoot, 'workspace-projects')
  await installModule(sourceRoot, 'workspace-tasks')
  await jsonCommand(workspace, 'workspace-add', ['source'])
  const exported = await jsonCommand(workspace, 'blueprint-export', [
    '--project', 'composition-source',
    '--name', 'workspace-starter',
    '--version', '2.0.0',
  ])
  assert.equal(exported.result.contract, 'lacify.dev/blueprint/v2')
  assert.equal(exported.result.composable, true)

  const salesPlan = await jsonCommand(workspace, 'blueprint-plan', [
    'workspace-starter',
    '--version', '2.0.0',
    '--project', 'sales-workspace',
    '--rename-actor', 'Workspace=SalesWorkspace',
    '--partition-key', 'Workspace=salesWorkspaceId',
    '--modules', 'workspace-projects',
  ])
  assert.equal(salesPlan.result.actors[0].name, 'SalesWorkspace')
  assert.equal(salesPlan.result.actors[0].partitionBy, 'salesWorkspaceId')
  assert.equal(salesPlan.result.actors[0].operations, 5)
  assert.deepEqual(salesPlan.result.composition.modules, ['Workspace:workspace-projects'])
  assert.equal(salesPlan.result.modules[0].actor, 'SalesWorkspace')
  assert.equal(salesPlan.result.files.some(({ path: file }) => file.includes('workspace_tasks')), false)

  await assert.rejects(
    () => runCli([
      'blueprint-create', 'workspace-starter',
      '--version', '2.0.0',
      '--project', 'sales-workspace',
      '--rename-actor', 'Workspace=SalesWorkspace',
      '--partition-key', 'Workspace=changedId',
      '--modules', 'workspace-projects',
      '--plan', salesPlan.result.planId,
      '--approve',
    ], capture().io, workspace),
    /plan replay blocked/,
  )
  const sales = await jsonCommand(workspace, 'blueprint-create', [
    'workspace-starter',
    '--version', '2.0.0',
    '--project', 'sales-workspace',
    '--rename-actor', 'Workspace=SalesWorkspace',
    '--partition-key', 'Workspace=salesWorkspaceId',
    '--modules', 'workspace-projects',
    '--plan', salesPlan.result.planId,
    '--approve',
  ])
  assert.equal(sales.result.created, true)

  const supportPlan = await jsonCommand(workspace, 'blueprint-plan', [
    'workspace-starter',
    '--version', '2.0.0',
    '--project', 'support-workspace',
    '--rename-actor', 'Workspace=SupportWorkspace',
    '--partition-key', 'Workspace=supportWorkspaceId',
    '--modules', 'none',
  ])
  assert.equal(supportPlan.result.actors[0].operations, 2)
  assert.deepEqual(supportPlan.result.modules, [])
  assert.equal(supportPlan.result.files.some(({ path: file }) => file.includes('workspace_projects')), false)
  assert.equal(supportPlan.result.files.some(({ path: file }) => file.includes('workspace_tasks')), false)
  const support = await jsonCommand(workspace, 'blueprint-create', [
    'workspace-starter',
    '--version', '2.0.0',
    '--project', 'support-workspace',
    '--rename-actor', 'Workspace=SupportWorkspace',
    '--partition-key', 'Workspace=supportWorkspaceId',
    '--modules', 'none',
    '--plan', supportPlan.result.planId,
    '--approve',
  ])
  assert.notEqual(sales.result.projectFingerprint, support.result.projectFingerprint)

  const salesProject = await loadRuntimeProject(path.join(workspace, 'sales-workspace', 'lacify.runtime.yaml'))
  const supportProject = await loadRuntimeProject(path.join(workspace, 'support-workspace', 'lacify.runtime.yaml'))
  assert.equal(salesProject.project.actors[0].definition.name, 'SalesWorkspace')
  assert.equal(supportProject.project.actors[0].definition.name, 'SupportWorkspace')
  assert.equal(salesProject.project.actors[0].operations.some(({ definition }) => definition.name === 'CreateProject'), true)
  assert.equal(salesProject.project.actors[0].operations.some(({ definition }) => definition.name === 'CreateTask'), false)
  assert.deepEqual(supportProject.project.actors[0].operations.map(({ definition }) => definition.name), ['CreateNote', 'GetNote'])
  assert.equal((await workspaceProjects(workspace)).projects.length, 3)

  await assert.rejects(
    () => runCli([
      'blueprint-plan', 'workspace-starter',
      '--version', '2.0.0',
      '--project', 'unknown-actor-project',
      '--rename-actor', 'Missing=Other',
    ], capture().io, workspace),
    /does not exist/,
  )
  await assert.rejects(
    () => runCli([
      'blueprint-plan', 'workspace-starter',
      '--version', '2.0.0',
      '--project', 'unknown-module-project',
      '--modules', 'not-installed',
    ], capture().io, workspace),
    /does not exist/,
  )
})
