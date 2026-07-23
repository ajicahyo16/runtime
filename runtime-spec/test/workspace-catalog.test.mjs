import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { runCli } from '../src/cli.mjs'
import { LacifyMcpService } from '../src/mcp-service.mjs'

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

async function createReadyProject(root, project, moduleName = null) {
  assert.equal((await jsonCommand(root, 'init', ['--project', project, '--template', 'personal'])).code, 0)
  if (moduleName) {
    const planned = await jsonCommand(root, 'module-plan', [moduleName, '--actor', 'Workspace'])
    assert.equal(planned.code, 0)
    assert.equal((await jsonCommand(root, 'add', [
      moduleName,
      '--actor', 'Workspace',
      '--plan', planned.result.planId,
      '--approve',
    ])).code, 0)
  }
  assert.equal((await jsonCommand(root, 'integrate')).code, 0)
  const reviewed = await jsonCommand(root, 'review')
  assert.equal(reviewed.code, 0)
  assert.equal((await jsonCommand(root, 'apply-review', [
    '--review', reviewed.result.receipt.reviewId,
    '--approve',
  ])).code, 0)
}

test('workspace catalog isolates three contained projects and exposes metadata-only status', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'lacify-workspace-'))
  assert.equal((await jsonCommand(workspace, 'workspace-init', ['--name', 'personal-platform'])).code, 0)
  assert.equal((await jsonCommand(workspace, 'workspace-status')).code, 2)
  const manifestFile = path.join(workspace, 'lacify.workspace.yaml')
  const manifest = await readFile(manifestFile, 'utf8')
  await writeFile(manifestFile, `${manifest}unexpected: true\n`)
  await assert.rejects(
    () => runCli(['workspace-list'], capture().io, workspace),
    /unknown field/,
  )
  await writeFile(manifestFile, manifest)

  const crm = path.join(workspace, 'crm-personal')
  const manager = path.join(workspace, 'project-manager')
  const knowledge = path.join(workspace, 'knowledge-base')
  await createReadyProject(crm, 'crm-personal', 'workspace-projects')
  await createReadyProject(manager, 'project-manager', 'workspace-tasks')
  await createReadyProject(knowledge, 'knowledge-base')

  for (const relative of ['crm-personal', 'project-manager', 'knowledge-base']) {
    assert.equal((await jsonCommand(workspace, 'workspace-add', [relative])).code, 0)
  }

  const listed = await jsonCommand(workspace, 'workspace-list')
  assert.equal(listed.code, 0)
  assert.deepEqual(listed.result.projects.map(({ id }) => id).sort(), ['crm-personal', 'knowledge-base', 'project-manager'])
  assert.equal(listed.result.projects.every(({ actors }) => actors.length === 1 && actors[0].name === 'Workspace'), true)
  assert.equal(listed.result.businessRowsReturned, false)
  assert.equal(JSON.stringify(listed.result).includes('Private note'), false)

  const matrix = await jsonCommand(workspace, 'workspace-module-matrix')
  assert.equal(matrix.code, 0)
  assert.equal(matrix.result.rows.find(({ project }) => project === 'crm-personal').module, 'workspace-projects')
  assert.equal(matrix.result.rows.find(({ project }) => project === 'project-manager').module, 'workspace-tasks')
  assert.equal(matrix.result.rows.find(({ project }) => project === 'knowledge-base').state, 'none')
  assert.equal(matrix.result.remoteMutation, false)

  const status = await jsonCommand(workspace, 'workspace-status')
  assert.equal(status.code, 0)
  assert.equal(status.result.ready, true)
  assert.equal(status.result.projects.every(({ ready }) => ready), true)

  const config = await jsonCommand(workspace, 'workspace-mcp-config', ['--project', 'project-manager'])
  const server = config.result.mcpServers['lacify-project-manager']
  assert.equal(server.cwd, await realpath(manager))
  assert.equal(server.env.LACIFY_MCP_PROJECT, 'project-manager')
  assert.equal(server.env.LACIFY_WORKSPACE_ROOT, workspace)
  assert.equal(JSON.stringify(config.result).includes('lacify_runtime_'), false)

  await assert.rejects(
    () => runCli(['workspace-add', 'project-manager'], capture().io, workspace),
    /already contains this project path/,
  )
  const duplicate = path.join(workspace, 'duplicate-id')
  await createReadyProject(duplicate, 'project-manager')
  await assert.rejects(
    () => runCli(['workspace-add', 'duplicate-id'], capture().io, workspace),
    /already contains project ID/,
  )
  const external = await mkdtemp(path.join(tmpdir(), 'lacify-external-project-'))
  await createReadyProject(external, 'outside-project')
  await assert.rejects(
    () => runCli(['workspace-add', external], capture().io, workspace),
    /contained inside the workspace root/,
  )
})

test('workspace-aware MCP discovers peers but keeps mutation context bound to one project', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'lacify-workspace-mcp-'))
  await jsonCommand(workspace, 'workspace-init', ['--name', 'ai-workspace'])
  const selectedRoot = path.join(workspace, 'selected')
  const peerRoot = path.join(workspace, 'peer')
  await jsonCommand(selectedRoot, 'init', ['--project', 'selected-project', '--template', 'personal'])
  await jsonCommand(peerRoot, 'init', ['--project', 'peer-project', '--template', 'personal'])
  await jsonCommand(workspace, 'workspace-add', ['selected'])
  await jsonCommand(workspace, 'workspace-add', ['peer'])

  const service = new LacifyMcpService({
    root: selectedRoot,
    workspaceRoot: workspace,
    mcpProject: 'selected-project',
    role: 'developer',
  })
  assert.equal(service.tools().length, 41)
  const projects = await service.callTool('list_workspace_projects')
  assert.equal(projects.projects.length, 2)
  assert.equal(projects.businessRowsReturned, false)
  assert.equal((await service.callTool('get_workspace_project', { project: 'selected-project' })).selectedForMutation, true)
  assert.equal((await service.callTool('get_workspace_project', { project: 'peer-project' })).selectedForMutation, false)
  assert.equal((await service.callTool('get_workspace_module_matrix')).remoteMutation, false)

  const resources = await service.listResources()
  const workspaceResource = resources.find(({ uri }) => uri === 'lacify://workspaces/ai-workspace')
  assert.ok(workspaceResource)
  const resource = await service.readResource(workspaceResource.uri)
  assert.equal(JSON.parse(resource.text).businessRowsReturned, false)

  const mismatched = new LacifyMcpService({
    root: selectedRoot,
    workspaceRoot: workspace,
    mcpProject: 'peer-project',
  })
  await assert.rejects(() => mismatched.callTool('get_project'), /does not match/)
})
