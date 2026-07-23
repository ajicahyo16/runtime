import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { runCli } from '../src/cli.mjs'
import { loadRuntimeProject } from '../src/index.mjs'

function capture() {
  let value = ''
  return { io: { stdout: { write: (chunk) => { value += chunk } } }, read: () => JSON.parse(value) }
}

async function plan(root, moduleName, version = null) {
  const stream = capture()
  const code = await runCli(['module-plan', moduleName, '--actor', 'Workspace', ...(version ? ['--version', version] : []), '--json'], stream.io, root)
  return { code, result: stream.read() }
}

test('Actor extension modules compose different objects without duplicating the Actor', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-modules-'))
  await runCli(['init', '--project', 'composed-project', '--template', 'personal'], capture().io, root)
  const available = capture()
  assert.equal(await runCli(['modules', '--json'], available.io, root), 0)
  assert.deepEqual(available.read().modules.map(({ name }) => name), ['workspace-projects', 'workspace-tasks'])

  const projects = await plan(root, 'workspace-projects')
  assert.equal(projects.code, 0)
  assert.equal(projects.result.valid, true)
  assert.equal(projects.result.files.length, 8)
  assert.equal(JSON.stringify(projects.result).includes('CREATE TABLE'), false)
  await assert.rejects(() => runCli(['add', 'workspace-projects', '--actor', 'Workspace', '--plan', projects.result.planId], capture().io, root), /Explicit approval/)
  await assert.rejects(() => runCli(['add', 'workspace-projects', '--actor', 'Workspace', '--plan', 'module_plan_stale', '--approve'], capture().io, root), /replay blocked/)
  assert.equal(await runCli(['add', 'workspace-projects', '--actor', 'Workspace', '--plan', projects.result.planId, '--approve'], capture().io, root), 0)

  const tasks = await plan(root, 'workspace-tasks')
  assert.equal(tasks.code, 0)
  assert.equal(await runCli(['add', 'workspace-tasks', '--actor', 'Workspace', '--plan', tasks.result.planId, '--approve'], capture().io, root), 0)
  assert.equal(await runCli(['validate'], capture().io, root), 0)
  assert.equal(await runCli(['test'], capture().io, root), 0)

  const loaded = await loadRuntimeProject(path.join(root, 'lacify.runtime.yaml'))
  assert.equal(loaded.project.actors.length, 1)
  assert.deepEqual(loaded.project.actors[0].operations.map(({ definition }) => definition.name).sort(), [
    'CompleteTask', 'CreateNote', 'CreateProject', 'CreateTask', 'GetNote', 'GetProject', 'ListProjects', 'ListTasks', 'SetTaskPriority',
  ])
  const record = JSON.parse(await readFile(path.join(root, '.lacify', 'modules.json'), 'utf8'))
  assert.deepEqual(record.installations.map(({ module }) => module), ['workspace-projects', 'workspace-tasks'])

  const duplicate = await plan(root, 'workspace-projects')
  assert.equal(duplicate.code, 2)
  assert.ok(duplicate.result.diagnostics.some(({ code }) => ['command_conflict', 'file_conflict'].includes(code)))
})

test('the same Workspace Actor can receive a different object set in another project', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-modules-other-'))
  await runCli(['init', '--project', 'tasks-only', '--template', 'personal'], capture().io, root)
  const tasks = await plan(root, 'workspace-tasks')
  await runCli(['add', 'workspace-tasks', '--actor', 'Workspace', '--plan', tasks.result.planId, '--approve'], capture().io, root)
  const loaded = await loadRuntimeProject(path.join(root, 'lacify.runtime.yaml'))
  const names = loaded.project.actors[0].operations.map(({ definition }) => definition.name)
  assert.equal(names.includes('CreateTask'), true)
  assert.equal(names.includes('CreateProject'), false)
})

test('module upgrades are additive, version-bound, and block customized baselines', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-module-upgrade-'))
  await runCli(['init', '--project', 'upgrade-project', '--template', 'personal'], capture().io, root)
  const old = await plan(root, 'workspace-tasks', '1.0.0')
  assert.equal(old.result.moduleVersion, '1.0.0')
  await runCli(['add', 'workspace-tasks', '--actor', 'Workspace', '--version', '1.0.0', '--plan', old.result.planId, '--approve'], capture().io, root)

  const statusBefore = capture()
  await runCli(['module-status', '--json'], statusBefore.io, root)
  assert.equal(statusBefore.read().modules[0].state, 'update-available')
  const upgrade = capture()
  assert.equal(await runCli(['module-upgrade-plan', 'workspace-tasks', '--actor', 'Workspace', '--json'], upgrade.io, root), 0)
  const upgradePlan = upgrade.read()
  assert.equal(upgradePlan.installedVersion, '1.0.0')
  assert.equal(upgradePlan.latestVersion, '1.1.0')
  assert.equal(upgradePlan.files.length, 4)
  assert.equal(JSON.stringify(upgradePlan).includes('ALTER TABLE'), false)
  await assert.rejects(() => runCli(['upgrade', 'workspace-tasks', '--actor', 'Workspace', '--plan', upgradePlan.planId], capture().io, root), /Explicit approval/)
  assert.equal(await runCli(['upgrade', 'workspace-tasks', '--actor', 'Workspace', '--plan', upgradePlan.planId, '--approve'], capture().io, root), 0)
  assert.equal(await runCli(['test'], capture().io, root), 0)
  const statusAfter = capture()
  await runCli(['module-status', '--json'], statusAfter.io, root)
  assert.equal(statusAfter.read().modules[0].state, 'current')

  const customized = await mkdtemp(path.join(tmpdir(), 'lacify-module-custom-'))
  await runCli(['init', '--project', 'custom-project', '--template', 'personal'], capture().io, customized)
  const customOld = await plan(customized, 'workspace-tasks', '1.0.0')
  await runCli(['add', 'workspace-tasks', '--actor', 'Workspace', '--version', '1.0.0', '--plan', customOld.result.planId, '--approve'], capture().io, customized)
  const operationFile = path.join(customized, 'actors', 'workspace', 'operations', 'create-task.operation.yaml')
  const source = await readFile(operationFile, 'utf8')
  await writeFile(operationFile, `${source}\n`)
  const blocked = capture()
  assert.equal(await runCli(['module-upgrade-plan', 'workspace-tasks', '--actor', 'Workspace', '--json'], blocked.io, customized), 2)
  const blockedPlan = blocked.read()
  assert.ok(blockedPlan.diagnostics.some(({ code }) => code === 'customized_installation'))
  assert.ok(blockedPlan.customizedFiles.includes('actors/workspace/operations/create-task.operation.yaml'))
})
