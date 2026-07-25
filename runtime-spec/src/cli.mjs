import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, access, cp, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { loadRuntimeProject, stableStringify } from './index.mjs'
import { loadRealtimeProject } from './realtime-spec.mjs'
import { applyMigrationPlan, introspectActorSchema, planMigrations, readMigrationLedger } from './migration-engine.mjs'
import { deviceLogin } from './device-auth.mjs'
import { compareAuthoringState, createLock } from './synchronization.mjs'
import { generateTypeScriptClient } from './client-generator.mjs'
import { deleteCliProfile, remoteClient, saveCliProfile } from './remote-client.mjs'
import { visualContractsToFiles } from './visual-export.mjs'
import { deleteCredential } from './credentials.mjs'
import { canonicalProjectToContracts } from './control-plane-contracts.mjs'
import { executeLocalOperation } from './local-runtime.mjs'
import { createLocalDevServer } from './dev-server.mjs'
import { createReviewReceipt, readReviewReceipt, saveReviewReceipt, verifyReviewReceipt } from './review-receipt.mjs'
import { generateIntegration } from './integration-generator.mjs'
import { diagnoseProject } from './doctor.mjs'
import { createLocalSnapshot, listLocalSnapshots, rehearseLocalRestore, verifyLocalSnapshot } from './local-backup.mjs'
import { installModule, listModules, moduleStatus, planModuleInstall, planModuleUpgrade, upgradeModule } from './module-system.mjs'
import { createEncryptedArchive, inspectEncryptedArchive, restoreEncryptedArchive, verifyEncryptedArchive } from './encrypted-archive.mjs'
import { addWorkspaceProject, initializeWorkspace, selectWorkspaceProject, workspaceModuleMatrix, workspaceProjects } from './workspace-catalog.mjs'
import { createBlueprintProject, exportProjectBlueprint, inspectProjectBlueprint, listProjectBlueprints, planBlueprintProject } from './project-blueprint.mjs'

function option(args, name, fallback = null) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] ?? true : fallback
}

function options(args, name) {
  const values = []
  for (let index = 0; index < args.length; index += 1) if (args[index] === `--${name}` && args[index + 1] !== undefined) values.push(String(args[index + 1]))
  return values
}

function mappingOptions(args, name) {
  const result = {}
  for (const value of options(args, name)) {
    const separator = value.indexOf('=')
    if (separator <= 0 || separator === value.length - 1) throw new Error(`--${name} must use Source=Target format.`)
    const source = value.slice(0, separator)
    if (Object.hasOwn(result, source)) throw new Error(`--${name} repeats source "${source}".`)
    result[source] = value.slice(separator + 1)
  }
  return result
}

function blueprintCompositionOptions(args) {
  const selected = option(args, 'modules', null)
  return {
    actorRenames: mappingOptions(args, 'rename-actor'),
    partitionKeys: mappingOptions(args, 'partition-key'),
    modules: selected === null ? null : String(selected).toLowerCase() === 'none' ? [] : String(selected).split(',').map((entry) => entry.trim()).filter(Boolean),
  }
}

function output(io, json, value, human) {
  io.stdout.write(`${json ? JSON.stringify(value, null, 2) : human}\n`)
}

async function exists(file) {
  try { await access(file); return true } catch { return false }
}

async function loadLock(root) {
  const file = path.join(root, '.lacify', 'lock.json')
  if (!await exists(file)) return { version: 1, baseRevision: null, projectFingerprint: null, environments: {} }
  return JSON.parse(await readFile(file, 'utf8'))
}

async function saveLock(root, lock) {
  await mkdir(path.join(root, '.lacify'), { recursive: true })
  await writeFile(path.join(root, '.lacify', 'lock.json'), `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 })
}

function runtimePath(root) {
  return path.join(root, 'lacify.runtime.yaml')
}

function realtimePath(root) {
  return path.join(root, 'lacify.realtime.yaml')
}

function databasePath(root, environment, actor) {
  return path.join(root, '.lacify', 'development', environment, `${actor}.sqlite`)
}

async function copyTemplateDirectory(source, destination) {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) await copyTemplateDirectory(from, to)
    else await cp(from, to, { errorOnExist: true })
  }
}

async function buildPlans(project, root, environment, lock) {
  const plans = []
  for (const actor of project.project.actors) {
    const file = databasePath(root, environment, actor.definition.name)
    const database = new DatabaseSync(await exists(file) ? file : ':memory:')
    const ledger = readMigrationLedger(database, actor.definition.name)
    plans.push(planMigrations({
      actor: actor.definition.name,
      migrations: actor.migrations,
      ledger,
      releaseId: `release_${project.fingerprint.slice(0, 24)}`,
      environmentRevision: lock.environments?.[environment]?.revision || null,
      projectFingerprint: project.fingerprint,
    }))
    database.close()
  }
  return plans
}

async function runOperationTestsForReview(root, dependencies) {
  let stdout = ''
  await runCli(['test', '--json'], { stdout: { write: (chunk) => { stdout += chunk } } }, root, dependencies)
  return JSON.parse(stdout)
}

export async function runCli(argv, io = process, cwd = process.cwd(), dependencies = {}) {
  const args = [...argv]
  const command = args.shift() || 'help'
  const json = args.includes('--json')
  const root = path.resolve(String(option(args, 'cwd', cwd)))

  if (command === 'help') {
    output(io, json, { commands: ['login', 'logout', 'init', 'realtime', 'mcp-config', 'workspace-init', 'workspace-add', 'workspace-list', 'workspace-status', 'workspace-module-matrix', 'workspace-mcp-config', 'blueprint-export', 'blueprints', 'blueprint-info', 'blueprint-plan', 'blueprint-create', 'modules', 'module-plan', 'add', 'module-status', 'module-upgrade-plan', 'upgrade', 'validate', 'plan', 'review', 'apply-review', 'apply', 'pull', 'status', 'migrations', 'health', 'generate', 'integrate', 'doctor', 'snapshot', 'snapshots', 'verify-snapshot', 'rehearse-restore', 'archive-create', 'archive-info', 'archive-verify', 'archive-restore', 'test', 'dev'] }, 'Usage: lacify <login|logout|init|realtime|mcp-config|workspace-init|workspace-add|workspace-list|workspace-status|workspace-module-matrix|workspace-mcp-config|blueprint-export|blueprints|blueprint-info|blueprint-plan|blueprint-create|modules|module-plan|add|module-status|module-upgrade-plan|upgrade|validate|plan|review|apply-review|apply|pull|status|migrations|health|generate|integrate|doctor|snapshot|snapshots|verify-snapshot|rehearse-restore|archive-create|archive-info|archive-verify|archive-restore|test|dev> [--env development] [--json]')
    return 0
  }

  if (command === 'login') {
    const result = await (dependencies.deviceLogin || deviceLogin)({
      baseUrl: String(option(args, 'api', 'https://api.runtime.getlacify.com')),
      notify: (message) => io.stdout.write(`${message}\n`),
    })
    await (dependencies.saveCliProfile || saveCliProfile)({ account: result.account, baseUrl: String(option(args, 'api', 'https://api.runtime.getlacify.com')) })
    output(io, json, { authenticated: true, ...result }, `Authenticated as ${result.account}; credential stored in the protected OS credential store.`)
    return 0
  }

  if (command === 'logout') {
    const client = await (dependencies.remoteClient || remoteClient)()
    await client.request('/api/cli/token', { method: 'DELETE' })
    await (dependencies.deleteCredential || deleteCredential)(client.profile.account)
    await (dependencies.deleteCliProfile || deleteCliProfile)()
    output(io, json, { authenticated: false, revoked: true }, 'CLI credential revoked and removed from the protected OS credential store.')
    return 0
  }

  if (command === 'init') {
    if (await exists(runtimePath(root))) throw new Error('lacify.runtime.yaml already exists; init will not overwrite it.')
    const project = String(option(args, 'project', path.basename(root))).toLowerCase().replace(/[^a-z0-9-_]/g, '-')
    const template = String(option(args, 'template', 'basic'))
    if (template !== 'basic' && template !== 'personal') throw new Error('Template must be basic or personal.')
    if (template === 'personal') {
      const templateRoot = fileURLToPath(new URL('../templates/personal', import.meta.url))
      await copyTemplateDirectory(templateRoot, root)
      const runtimeYaml = await readFile(runtimePath(root), 'utf8')
      await writeFile(runtimePath(root), runtimeYaml.replace('project: personal-project', `project: ${project}`))
    } else {
      await mkdir(path.join(root, 'actors', 'aggregate', 'migrations'), { recursive: true })
      await writeFile(runtimePath(root), `version: lacify.dev/v1\nproject: ${project}\nruntime: request-response\nactors:\n  - ./actors/aggregate/actor.yaml\n`)
      await writeFile(path.join(root, 'actors', 'aggregate', 'actor.yaml'), 'version: lacify.dev/actor/v1\nname: Aggregate\npartitionBy: aggregateId\nstorage: sqlite\ncommands:\n  - Create\n')
      await writeFile(path.join(root, 'actors', 'aggregate', 'migrations', '0001_initial.sql'), 'CREATE TABLE aggregate_state (\n  id TEXT PRIMARY KEY,\n  created_at INTEGER NOT NULL\n);\n')
    }
    await saveLock(root, { version: 1, baseRevision: null, projectFingerprint: null, environments: {} })
    output(io, json, { initialized: true, project, template, root }, `Initialized Lacify project ${project} from the ${template} template.`)
    return 0
  }

  if (command === 'realtime') {
    const action = args.shift() || 'help'
    if (action === 'help') {
      output(io, json, { commands: ['validate', 'plan'] }, 'Usage: lacify realtime <validate|plan> [--json]')
      return 0
    }
    const realtime = await loadRealtimeProject(realtimePath(root))
    if (!realtime.valid) throw Object.assign(new Error('Realtime project validation failed.'), { diagnostics: realtime.issues })
    if (action === 'validate') {
      output(io, json, { valid: true, project: realtime.project.realtime.project, fingerprint: realtime.fingerprint, rooms: realtime.project.rooms.map(({ definition }) => definition.name) }, `Valid realtime project ${realtime.project.realtime.project} (${realtime.fingerprint.slice(0, 12)}), ${realtime.project.rooms.length} Room Actor(s).`)
      return 0
    }
    if (action === 'plan') {
      const plan = {
        valid: true,
        project: realtime.project.realtime.project,
        fingerprint: realtime.fingerprint,
        remoteMutation: false,
        rooms: realtime.project.rooms.map(({ definition }) => ({ name: definition.name, partitionBy: definition.partitionBy, capabilities: definition.capabilities })),
      }
      output(io, json, plan, `Ready: immutable realtime plan ${realtime.fingerprint.slice(0, 12)} with ${plan.rooms.length} Room Actor(s); no remote mutation.`)
      return 0
    }
    throw new Error(`Unknown realtime command "${action}".`)
  }

  if (command === 'mcp-config') {
    const executable = fileURLToPath(new URL('../../bin/lacify-mcp.mjs', import.meta.url))
    const configuration = {
      mcpServers: {
        lacify: {
          command: process.execPath,
          args: [executable],
          cwd: root,
          env: {
            LACIFY_MCP_ROLE: 'developer',
            LACIFY_RUNTIME_APPLICATION_TOKEN: '${LACIFY_RUNTIME_APPLICATION_TOKEN}',
          },
        },
      },
    }
    output(io, json, configuration, JSON.stringify(configuration, null, 2))
    return 0
  }

  if (command === 'workspace-init') {
    const name = String(option(args, 'name', path.basename(root))).toLowerCase().replace(/[^a-z0-9-_]/g, '-')
    const result = await initializeWorkspace(root, name)
    output(io, json, result, `Initialized Lacify workspace ${name}.`)
    return 0
  }

  if (command === 'workspace-add') {
    const projectPath = String(args[0] || '')
    const result = await addWorkspaceProject(root, projectPath)
    output(io, json, result, `Added ${result.project} at ${result.path} to workspace ${result.workspace}.`)
    return 0
  }

  if (command === 'workspace-list') {
    const catalog = await workspaceProjects(root)
    const result = {
      workspace: catalog.workspace,
      projects: catalog.projects.map(({ id, path: projectPath, fingerprint, actors }) => ({ id, path: projectPath, fingerprint, actors })),
      remoteMutation: false,
      businessRowsReturned: false,
    }
    output(io, json, result, `${result.projects.length} project(s) in workspace ${result.workspace}.`)
    return 0
  }

  if (command === 'workspace-status') {
    const catalog = await workspaceProjects(root)
    const projects = []
    for (const entry of catalog.projects) {
      let value = ''
      try {
        const code = await runCli(['doctor', '--json'], { stdout: { write: (chunk) => { value += chunk } } }, entry.root, dependencies)
        const report = JSON.parse(value)
        projects.push({
          id: entry.id,
          path: entry.path,
          fingerprint: entry.fingerprint,
          ready: report.ready,
          exitCode: code,
          passed: report.checks.filter(({ status }) => status === 'pass').length,
          warnings: report.checks.filter(({ status }) => status === 'warning').map(({ id }) => id),
          blockers: report.checks.filter(({ status }) => status === 'fail').map(({ id }) => id),
        })
      } catch (error) {
        projects.push({ id: entry.id, path: entry.path, fingerprint: entry.fingerprint, ready: false, exitCode: 1, passed: 0, warnings: [], blockers: ['diagnostic-error'], message: error instanceof Error ? error.message : 'Project diagnostic failed.' })
      }
    }
    const result = {
      workspace: catalog.workspace,
      ready: projects.length > 0 && projects.every(({ ready }) => ready),
      projects,
      remoteMutation: false,
      businessRowsReturned: false,
    }
    output(io, json, result, `${projects.filter(({ ready }) => ready).length}/${projects.length} workspace project(s) ready.`)
    return result.ready ? 0 : 2
  }

  if (command === 'workspace-module-matrix') {
    const result = await workspaceModuleMatrix(root)
    output(io, json, result, `${result.rows.length} project/module status row(s) across ${result.projectCount} project(s).`)
    return 0
  }

  if (command === 'workspace-mcp-config') {
    const projectId = String(option(args, 'project', ''))
    const selected = await selectWorkspaceProject(root, projectId)
    const executable = fileURLToPath(new URL('../../bin/lacify-mcp.mjs', import.meta.url))
    const configuration = {
      mcpServers: {
        [`lacify-${projectId}`]: {
          command: process.execPath,
          args: [executable],
          cwd: selected.root,
          env: {
            LACIFY_MCP_ROLE: 'developer',
            LACIFY_MCP_PROJECT: projectId,
            LACIFY_WORKSPACE_ROOT: root,
            LACIFY_RUNTIME_APPLICATION_TOKEN: '${LACIFY_RUNTIME_APPLICATION_TOKEN}',
          },
        },
      },
    }
    output(io, json, configuration, JSON.stringify(configuration, null, 2))
    return 0
  }

  if (command === 'blueprint-export') {
    const projectId = String(option(args, 'project', ''))
    const name = String(option(args, 'name', ''))
    const version = String(option(args, 'version', ''))
    const description = String(option(args, 'description', ''))
    const result = await exportProjectBlueprint(root, { projectId, name, version, description })
    output(io, json, result, `Exported immutable blueprint ${name}@${version} from ${projectId}.`)
    return 0
  }

  if (command === 'blueprints') {
    const result = await listProjectBlueprints(root)
    output(io, json, result, `${result.blueprints.length} blueprint version(s) available in workspace ${result.workspace}.`)
    return 0
  }

  if (command === 'blueprint-info') {
    const name = String(args[0] || '')
    const version = String(option(args, 'version', ''))
    const result = await inspectProjectBlueprint(root, { name, version })
    output(io, json, result, `${name}@${version}: ${result.actors.length} Actor(s), ${result.files.length} canonical file(s).`)
    return 0
  }

  if (command === 'blueprint-plan') {
    const name = String(args[0] || '')
    const version = String(option(args, 'version', ''))
    const projectId = String(option(args, 'project', ''))
    const targetPath = String(option(args, 'path', projectId))
    const result = await planBlueprintProject(root, { name, version, projectId, targetPath, ...blueprintCompositionOptions(args) })
    output(io, json, result, `Blueprint plan ${result.planId} would create ${projectId} at ${targetPath}.`)
    return 0
  }

  if (command === 'blueprint-create') {
    if (!args.includes('--approve')) throw new Error('Explicit approval is required before creating a project from a blueprint.')
    const name = String(args[0] || '')
    const version = String(option(args, 'version', ''))
    const projectId = String(option(args, 'project', ''))
    const targetPath = String(option(args, 'path', projectId))
    const planId = String(option(args, 'plan', ''))
    const result = await createBlueprintProject(root, { name, version, projectId, targetPath, planId, ...blueprintCompositionOptions(args) })
    output(io, json, result, `Created independent project ${projectId} from ${name}@${version} and registered it in ${result.workspace}.`)
    return 0
  }

  if (command === 'pull') {
    const source = option(args, 'from')
    if (await exists(runtimePath(root)) && !args.includes('--force')) throw new Error('Local project files exist; pull refuses to overwrite repository work without --force.')
    if (source) {
      const sourceRoot = path.resolve(String(source))
      const loaded = await loadRuntimeProject(runtimePath(sourceRoot))
      if (!loaded.valid) throw Object.assign(new Error('Exported project is invalid.'), { diagnostics: loaded.issues })
      await mkdir(root, { recursive: true })
      await cp(runtimePath(sourceRoot), runtimePath(root), { errorOnExist: true })
      await cp(path.join(sourceRoot, 'actors'), path.join(root, 'actors'), { recursive: true, errorOnExist: true })
    } else {
      const projectId = String(option(args, 'project', ''))
      if (!projectId) throw new Error('Remote pull requires --project <project-id>.')
      const client = await (dependencies.remoteClient || remoteClient)()
      const data = await client.request(`/api/projects/${encodeURIComponent(projectId)}/contracts`)
      const files = visualContractsToFiles(projectId, data.contracts || [])
      await mkdir(root, { recursive: true })
      await writeFile(runtimePath(root), files.runtimeYaml)
      for (const actor of files.actors) {
        const actorRoot = path.join(root, 'actors', actor.actorId)
        await mkdir(path.join(actorRoot, 'migrations'), { recursive: true })
        await writeFile(path.join(actorRoot, 'actor.yaml'), actor.actorYaml)
        await writeFile(path.join(actorRoot, 'migrations', '0001_visual_export.sql'), actor.migrationSql)
      }
    }
    const loaded = await loadRuntimeProject(runtimePath(root))
    if (!loaded.valid) throw Object.assign(new Error('Materialized project is invalid.'), { diagnostics: loaded.issues })
    await saveLock(root, createLock({ projectFingerprint: loaded.fingerprint, baseRevision: `export_${loaded.fingerprint.slice(0, 24)}` }))
    output(io, json, { pulled: true, project: loaded.project.runtime.project, fingerprint: loaded.fingerprint }, `Pulled ${loaded.project.runtime.project} into canonical files.`)
    return 0
  }

  const project = await loadRuntimeProject(runtimePath(root))
  if (!project.valid) throw Object.assign(new Error('Project validation failed.'), { diagnostics: project.issues })

  if (command === 'modules') {
    const modules = await listModules()
    output(io, json, { modules }, `${modules.length} reusable Actor extension module(s).`)
    return 0
  }

  if (command === 'module-plan') {
    const moduleName = String(args[0] || '')
    const actorName = String(option(args, 'actor', ''))
    const moduleVersion = option(args, 'version')
    const plan = await planModuleInstall({ root, project, moduleName, actorName, moduleVersion: moduleVersion ? String(moduleVersion) : null })
    output(io, json, plan, `${plan.valid ? 'Ready' : 'Blocked'}: ${moduleName} would add ${plan.files.length} file(s) to ${actorName}.`)
    return plan.valid ? 0 : 2
  }

  if (command === 'add') {
    if (!args.includes('--approve')) throw new Error('Explicit approval required after reviewing lacify module-plan.')
    const moduleName = String(args[0] || '')
    const actorName = String(option(args, 'actor', ''))
    const planId = String(option(args, 'plan', ''))
    const moduleVersion = option(args, 'version')
    const result = await installModule({ root, project, moduleName, actorName, planId, moduleVersion: moduleVersion ? String(moduleVersion) : null })
    output(io, json, result, `Installed ${moduleName} into ${actorName}. Run lacify test, integrate, and review next.`)
    return 0
  }

  if (command === 'module-status') {
    const result = await moduleStatus({ root, project })
    output(io, json, result, `${result.modules.length} installed module target(s): ${result.modules.filter(({ state }) => state === 'update-available').length} update(s), ${result.modules.filter(({ state }) => state === 'customized').length} customized.`)
    return 0
  }

  if (command === 'module-upgrade-plan') {
    const moduleName = String(args[0] || '')
    const actorName = String(option(args, 'actor', ''))
    const plan = await planModuleUpgrade({ root, project, moduleName, actorName })
    output(io, json, plan, `${plan.valid ? 'Ready' : 'Blocked'}: ${moduleName} ${plan.installedVersion || '?'} → ${plan.latestVersion || '?'}.`)
    return plan.valid ? 0 : 2
  }

  if (command === 'upgrade') {
    if (!args.includes('--approve')) throw new Error('Explicit approval required after reviewing lacify module-upgrade-plan.')
    const moduleName = String(args[0] || '')
    const actorName = String(option(args, 'actor', ''))
    const planId = String(option(args, 'plan', ''))
    const result = await upgradeModule({ root, project, moduleName, actorName, planId })
    output(io, json, result, `Upgraded ${moduleName} from ${result.fromVersion} to ${result.toVersion}. Run lacify test, integrate, and review next.`)
    return 0
  }

  if (command === 'archive-create') {
    if (!args.includes('--approve')) throw new Error('Explicit approval required because the encrypted archive contains business data.')
    const snapshotId = String(option(args, 'snapshot', ''))
    const outputFile = String(option(args, 'output', ''))
    const result = await createEncryptedArchive({ root, project, snapshotId, outputFile, environment: dependencies.environment || process.env })
    output(io, json, result, `Created encrypted archive ${result.archiveId} (${result.bytes} bytes).`)
    return 0
  }

  if (command === 'archive-info') {
    const file = String(option(args, 'file', args[0] || ''))
    const result = await inspectEncryptedArchive(file)
    output(io, json, result, `${result.archiveId}: ${result.format}, ${result.bytes} encrypted bytes.`)
    return 0
  }

  if (command === 'archive-verify') {
    const file = String(option(args, 'file', args[0] || ''))
    const result = await verifyEncryptedArchive(file, dependencies.environment || process.env)
    output(io, json, result, `${result.verified ? 'Verified' : 'Failed'} ${result.archiveId}: ${result.actors.length} Actor database(s).`)
    return result.verified ? 0 : 2
  }

  if (command === 'archive-restore') {
    if (!args.includes('--approve')) throw new Error('Explicit approval required for encrypted archive restore.')
    const file = String(option(args, 'file', args[0] || ''))
    const target = String(option(args, 'target', ''))
    const result = await restoreEncryptedArchive({ file, target, environment: dependencies.environment || process.env })
    output(io, json, result, `Restored ${result.archiveId} into isolated target ${result.target}.`)
    return 0
  }

  if (command === 'validate') {
    output(io, json, { valid: true, project: project.project.runtime.project, fingerprint: project.fingerprint, actors: project.project.actors.map(({ definition }) => definition.name) }, `Valid ${project.project.runtime.project} (${project.fingerprint.slice(0, 12)}), ${project.project.actors.length} Actor(s).`)
    return 0
  }

  if (command === 'generate') {
    const file = await generateTypeScriptClient(project, path.join(root, 'generated', 'lacify'))
    output(io, json, { generated: true, file, fingerprint: project.fingerprint }, `Generated TypeScript client at ${path.relative(root, file)}.`)
    return 0
  }

  if (command === 'integrate') {
    const files = await generateIntegration(project, root)
    output(io, json, { integrated: true, project: project.project.runtime.project, fingerprint: project.fingerprint, files }, 'Generated the typed client, trusted server adapter, and secret-free integration manifest.')
    return 0
  }

  if (command === 'test') {
    const testsDirectory = path.join(root, 'tests')
    if (!await exists(testsDirectory)) throw new Error('No tests directory exists. Add tests/*.operation.json files.')
    const files = (await readdir(testsDirectory)).filter((name) => name.endsWith('.operation.json')).sort()
    if (!files.length) throw new Error('No tests/*.operation.json files exist.')
    const results = []
    for (const file of files) {
      const testCase = JSON.parse(await readFile(path.join(testsDirectory, file), 'utf8'))
      const actor = project.project.actors.find(({ definition }) => definition.name === testCase.actor)
      if (!actor) throw new Error(`${file}: Actor "${testCase.actor}" does not exist.`)
      if (!Array.isArray(testCase.steps) || !testCase.steps.length || testCase.steps.length > 100) throw new Error(`${file}: steps must contain 1–100 operations.`)
      const database = new DatabaseSync(':memory:')
      try {
        for (const migration of actor.migrations) database.exec(migration.sql)
        if (testCase.useSeedData === true) {
          const seed = project.developmentSeeds.find(({ actor: actorName }) => actorName === actor.definition.name)
          if (!seed) throw new Error(`${file}: useSeedData is true but Actor "${actor.definition.name}" has no seeds/development.sql file.`)
          database.exec(seed.sql)
        }
        for (const [index, step] of testCase.steps.entries()) {
          const operation = actor.operations.find(({ definition }) => definition.name === step.operation)
          try {
            const result = executeLocalOperation(database, actor, {
              partition: testCase.partition,
              operation: step.operation,
              input: step.input || {},
              page: step.page ?? null,
              idempotencyKey: step.idempotencyKey || null,
            })
            if (step.expectError) throw new Error(`${file}: step ${index + 1} expected error "${step.expectError.code}" but the operation succeeded.`)
            if (Object.hasOwn(step, 'expectData') && stableStringify(result.data) !== stableStringify(step.expectData)) {
              throw new Error(`${file}: step ${index + 1} returned unexpected data.`)
            }
          } catch (error) {
            if (step.expectError && error?.code === step.expectError.code) continue
            const operationFile = operation?.source || '<unknown operation file>'
            const sqlFile = operation?.definition?.sql || '<unknown SQL file>'
            const code = error?.code || 'test_failure'
            throw new Error(`${file}: Actor ${actor.definition.name}, operation ${step.operation}, step ${index + 1} failed [${code}]: ${error instanceof Error ? error.message : 'Local operation failed.'} Review ${operationFile} and ${sqlFile}; the local transaction was rolled back.`)
          }
        }
        results.push({ file, name: testCase.name || file, passed: true, steps: testCase.steps.length })
      } finally {
        database.close()
      }
    }
    output(io, json, { passed: true, tests: results }, `Passed ${results.length} operation test(s).`)
    return 0
  }

  if (command === 'dev') {
    const port = Number(option(args, 'port', 8788))
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Dev server port must be between 1 and 65535.')
    const server = await (dependencies.createLocalDevServer || createLocalDevServer)(project, {
      port,
      watchRoot: root,
      reloadProject: () => loadRuntimeProject(runtimePath(root)),
    })
    output(io, json, { started: true, url: `http://127.0.0.1:${port}`, hotReload: server.hotReload }, `Lacify local runtime listening at http://127.0.0.1:${port}${server.hotReload ? ' with hot reload' : ''}.`)
    return server
  }

  const environment = String(option(args, 'env', 'development'))
  if (!['development', 'staging', 'production'].includes(environment)) throw new Error('Environment must be development, staging, or production.')
  const lock = await loadLock(root)
  const controlPlaneFingerprint = lock.authoring?.controlPlaneFingerprint || lock.projectFingerprint || project.fingerprint
  const authoring = compareAuthoringState({
    baseFingerprint: lock.authoring?.baseFingerprint || lock.projectFingerprint,
    repositoryFingerprint: project.fingerprint,
    controlPlaneFingerprint,
  })
  const plans = await buildPlans(project, root, environment, lock)

  if (['snapshot', 'snapshots', 'verify-snapshot', 'rehearse-restore'].includes(command) && environment !== 'development') {
    throw new Error('Local snapshots and restore rehearsals are restricted to Development.')
  }

  if (command === 'snapshot') {
    if (!args.includes('--approve')) throw new Error('Explicit approval required because a snapshot contains local business data.')
    const snapshot = await createLocalSnapshot({ root, project, lock })
    output(io, json, { created: true, snapshot, businessRowsReturned: false }, `Created ${snapshot.snapshotId} with ${snapshot.actors.length} Actor database(s).`)
    return 0
  }

  if (command === 'snapshots') {
    const snapshots = await listLocalSnapshots(root)
    output(io, json, { snapshots, businessRowsReturned: false }, `${snapshots.length} local Development snapshot(s).`)
    return 0
  }

  if (command === 'verify-snapshot') {
    const snapshotId = String(option(args, 'snapshot', ''))
    const verification = await verifyLocalSnapshot(root, snapshotId)
    output(io, json, verification, `${verification.verified ? 'Verified' : 'Failed'} ${snapshotId}: ${verification.actors.length} Actor database(s).`)
    return verification.verified ? 0 : 2
  }

  if (command === 'rehearse-restore') {
    if (!args.includes('--approve')) throw new Error('Explicit approval required for an isolated restore rehearsal.')
    const snapshotId = String(option(args, 'snapshot', ''))
    const rehearsal = await rehearseLocalRestore(root, snapshotId)
    output(io, json, rehearsal, `${rehearsal.passed ? 'Passed' : 'Failed'} isolated restore rehearsal ${rehearsal.rehearsalId}; active Development was not overwritten.`)
    return rehearsal.passed ? 0 : 2
  }

  if (command === 'doctor') {
    if (environment !== 'development') throw new Error('Doctor currently evaluates the Development integration workflow.')
    const tests = await runOperationTestsForReview(root, dependencies)
    const remote = args.includes('--remote') ? await (dependencies.remoteClient || remoteClient)() : null
    const result = await diagnoseProject({
      root,
      project,
      plans,
      tests,
      lock,
      environment: dependencies.environment || process.env,
      remote,
    })
    output(io, json, result, `${result.ready ? 'Ready' : 'Not ready'}: ${result.checks.filter(({ status }) => status === 'pass').length} passed, ${result.checks.filter(({ status }) => status === 'warning').length} warning(s), ${result.checks.filter(({ status }) => status === 'fail').length} blocker(s).`)
    return result.ready ? 0 : 2
  }

  if (command === 'review') {
    if (environment !== 'development') throw new Error('Change reviews are restricted to Development.')
    if (!plans.every(({ valid }) => valid) || authoring.status === 'conflict') throw new Error('Migration or authoring plan is blocked; no review receipt was created.')
    const tests = await runOperationTestsForReview(root, dependencies)
    const receipt = await createReviewReceipt({ root, project, plans, tests })
    const file = await saveReviewReceipt(root, receipt)
    output(io, json, { reviewed: true, receipt, file }, `Review ${receipt.reviewId} passed and was saved to ${path.relative(root, file)}.`)
    return 0
  }

  if (command === 'plan') {
    const result = { valid: plans.every(({ valid }) => valid) && authoring.status !== 'conflict', environment, projectFingerprint: project.fingerprint, authoring, plans: plans.map(({ pending, ...plan }) => ({ ...plan, pending: pending.map(({ sql, operations, ...migration }) => ({ ...migration, operations })) })) }
    output(io, json, result, `${result.valid ? 'Ready' : 'Blocked'}: ${plans.reduce((sum, plan) => sum + plan.pending.length, 0)} pending migration(s) for ${environment}.`)
    return result.valid ? 0 : 2
  }

  if (command === 'apply' || command === 'apply-review') {
    if (environment !== 'development') throw new Error('CLI apply is restricted to Development. Promote immutable releases through Control Plane governance.')
    if (!args.includes('--approve')) {
      throw new Error(command === 'apply-review'
        ? 'Explicit approval required: rerun apply-review with --approve after inspecting the saved receipt.'
        : 'Explicit approval required: rerun with --approve after reviewing lacify plan.')
    }
    if (!plans.every(({ valid }) => valid) || authoring.status === 'conflict') throw new Error('Migration or authoring plan is blocked; apply did not mutate Development.')
    let reviewedBy = null
    if (command === 'apply-review') {
      const reviewId = String(option(args, 'review', ''))
      const stored = await readReviewReceipt(root, reviewId)
      const tests = await runOperationTestsForReview(root, dependencies)
      const current = await createReviewReceipt({ root, project, plans, tests })
      verifyReviewReceipt(stored.receipt, current)
      reviewedBy = reviewId
    }
    const results = []
    for (const plan of plans) {
      const file = databasePath(root, environment, plan.actor)
      await mkdir(path.dirname(file), { recursive: true })
      const database = new DatabaseSync(file)
      results.push({ actor: plan.actor, migrations: applyMigrationPlan(database, plan) })
      database.close()
    }
    const revision = `revision_${randomUUID()}`
    await saveLock(root, createLock({
      projectFingerprint: project.fingerprint,
      baseRevision: revision,
      environments: { ...lock.environments, development: { revision, fingerprint: project.fingerprint, appliedAt: new Date().toISOString() } },
    }))
    let remoteResult = null
    if (args.includes('--remote')) {
      const client = await (dependencies.remoteClient || remoteClient)()
      const projectId = project.project.runtime.project
      const existingProjects = await client.request('/api/projects')
      if (!(existingProjects.projects || []).some(({ id }) => id === projectId)) {
        await client.request('/api/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: projectId, name: projectId }),
        })
      }
      const existingContracts = await client.request(`/api/projects/${encodeURIComponent(projectId)}/contracts`)
      const revisionById = new Map((existingContracts.contracts || []).map((contract) => [contract.id, contract.revision]))
      const existingById = new Map((existingContracts.contracts || []).map((contract) => [contract.id, contract]))
      for (const contract of canonicalProjectToContracts(project)) {
        const revision = revisionById.get(contract.id)
        const existing = existingById.get(contract.id)
        const comparableExisting = existing ? Object.fromEntries(Object.keys(contract).map((key) => [key, existing[key]])) : null
        if (comparableExisting && stableStringify(comparableExisting) === stableStringify(contract)) continue
        await client.request(`/api/projects/${encodeURIComponent(projectId)}/contracts/${encodeURIComponent(contract.id)}`, {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            ...(revision ? { 'if-match': String(revision) } : {}),
            ...(lock.authoring?.controlPlaneFingerprint ? { 'x-lacify-base-fingerprint': lock.authoring.controlPlaneFingerprint } : {}),
          },
          body: JSON.stringify(contract),
        })
      }
      await client.request(`/api/projects/${encodeURIComponent(project.project.runtime.project)}/repository-source`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fingerprint: project.fingerprint, baseFingerprint: lock.authoring?.controlPlaneFingerprint || null, revision }),
      })
      const environments = await client.request(`/api/projects/${encodeURIComponent(projectId)}/environments`)
      if (!environments.environments?.dev?.updatedAt) {
        await client.request(`/api/projects/${encodeURIComponent(projectId)}/environments/dev/config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ variables: {} }),
        })
      }
      const compiled = await client.request(`/api/projects/${encodeURIComponent(projectId)}/releases`, { method: 'POST' })
      const verification = await client.request(`/api/projects/${encodeURIComponent(projectId)}/releases/${encodeURIComponent(compiled.release.id)}/verify`, { method: 'POST' })
      const deployment = await client.request(`/api/projects/${encodeURIComponent(projectId)}/releases/${encodeURIComponent(compiled.release.id)}/deployments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ environment: 'dev' }),
      })
      remoteResult = { release: { ...compiled.release, status: verification.releaseStatus }, deployment: deployment.deployment }
    }
    const generatedClient = await generateTypeScriptClient(project, path.join(root, 'generated', 'lacify'))
    output(io, json, { applied: true, environment, revision, reviewedBy, results, remote: remoteResult, generatedClient }, `Applied ${results.flatMap(({ migrations }) => migrations).length} migration(s) to Development${reviewedBy ? ` from ${reviewedBy}` : ''}${remoteResult ? ' and started the immutable remote Development deployment' : ''}; generated the TypeScript client.`)
    return 0
  }

  if (command === 'status') {
    const status = lock.projectFingerprint ? authoring.status : 'untracked'
    output(io, json, { project: project.project.runtime.project, environment, projectFingerprint: project.fingerprint, baseRevision: lock.baseRevision, drift: status, authoring }, `Status: ${status} (${environment}).`)
    return 0
  }

  if (command === 'migrations') {
    const records = []
    for (const actor of project.project.actors) {
      const file = databasePath(root, environment, actor.definition.name)
      const database = new DatabaseSync(await exists(file) ? file : ':memory:')
      records.push({ actor: actor.definition.name, entries: readMigrationLedger(database, actor.definition.name) })
      database.close()
    }
    output(io, json, records, `${records.reduce((sum, actor) => sum + actor.entries.length, 0)} migration ledger record(s).`)
    return 0
  }

  if (command === 'health') {
    const actors = []
    for (const actor of project.project.actors) {
      const file = databasePath(root, environment, actor.definition.name)
      const database = new DatabaseSync(await exists(file) ? file : ':memory:')
      actors.push({ actor: actor.definition.name, schema: introspectActorSchema(database) })
      database.close()
    }
    output(io, json, { healthy: true, environment, actors }, `Healthy: ${actors.length} local Development Actor database(s).`)
    return 0
  }
  throw new Error(`Unknown command "${command}".`)
}
