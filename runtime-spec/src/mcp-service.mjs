import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runCli } from './cli.mjs'
import {
  fingerprint,
  loadRuntimeProject,
  parseYaml,
  stableStringify,
  validateOperationDocument,
  validateOperationSql,
} from './index.mjs'
import { introspectActorSchema } from './migration-engine.mjs'
import { loadRealtimeProject } from './realtime-spec.mjs'
import { selectWorkspaceProject, workspaceModuleMatrix, workspaceProjects } from './workspace-catalog.mjs'
import { createBlueprintProject, inspectProjectBlueprint, listProjectBlueprints, planBlueprintProject } from './project-blueprint.mjs'

function capture() {
  let value = ''
  return { io: { stdout: { write: (chunk) => { value += chunk } } }, read: () => JSON.parse(value) }
}

async function cliJson(root, command, args = [], dependencies = {}) {
  const stream = capture()
  const code = await runCli([command, ...args, '--json'], stream.io, root, dependencies)
  return { code, result: stream.read() }
}

function publicProject(project) {
  return {
    project: project.project.runtime.project,
    runtime: project.project.runtime.runtime,
    fingerprint: project.fingerprint,
    actors: project.project.actors.map(({ definition, migrations, operations }) => ({
      name: definition.name,
      partitionBy: definition.partitionBy,
      storage: definition.storage,
      commands: definition.commands,
      stateMachines: definition.stateMachines,
      summaries: definition.summaries,
      secretRefs: definition.secretRefs,
      migrations: migrations.map(({ id }) => id),
      operations: (operations || []).map(({ definition: operation }) => ({
        name: operation.name,
        kind: operation.kind,
        input: operation.input,
        result: operation.result,
      })),
    })),
  }
}

function actorEntry(project, actorName) {
  const actor = project.project.actors.find(({ definition }) => definition.name === actorName)
  if (!actor) throw new Error(`Actor "${actorName}" does not exist.`)
  return actor
}

function safeActorDataModel(project, actorName) {
  const actor = actorEntry(project, actorName)
  const database = new DatabaseSync(':memory:')
  try {
    for (const migration of actor.migrations) database.exec(migration.sql)
    const schema = introspectActorSchema(database)
    return {
      actor: actor.definition.name,
      partitionBy: actor.definition.partitionBy,
      schemaFingerprint: schema.fingerprint,
      tables: schema.tables.filter(({ name }) => !name.startsWith('_lacify_')),
      indexes: schema.objects.filter(({ type, name }) => type === 'index' && !name.startsWith('sqlite_')).map(({ name, tableName }) => ({ name, tableName })),
      operations: actor.operations.map(({ definition }) => ({ name: definition.name, kind: definition.kind, input: definition.input, result: definition.result })),
    }
  } finally {
    database.close()
  }
}

function validateTestInput(definition, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Operation test input must be an object.')
  if (Buffer.byteLength(stableStringify(input), 'utf8') > 64 * 1024) throw new Error('Operation test input exceeds 64 KiB.')
  for (const name of Object.keys(input)) if (!Object.hasOwn(definition.input, name)) throw new Error(`Unknown operation test input "${name}".`)
  for (const [name, field] of Object.entries(definition.input)) {
    const value = input[name]
    if (field.required && (value === undefined || value === null)) throw new Error(`Required operation test input "${name}" is missing.`)
    if (value === undefined || value === null) continue
    const valid = field.type === 'string' ? typeof value === 'string' && value.length <= 16384
      : field.type === 'integer' ? Number.isSafeInteger(value)
      : field.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : field.type === 'boolean' ? typeof value === 'boolean'
      : false
    if (!valid) throw new Error(`Operation test input "${name}" is invalid.`)
  }
}

function developmentOperationTestPlan(project, args) {
  const actor = actorEntry(project, args.actor)
  const operation = actor.operations.find(({ definition }) => definition.name === args.operation)
  if (!operation) throw new Error(`Operation "${args.operation}" does not exist on Actor "${args.actor}".`)
  if (typeof args.partition !== 'string' || !args.partition || args.partition.length > 256) throw new Error('Development operation test partition must contain 1–256 characters.')
  validateTestInput(operation.definition, args.input)
  if (operation.definition.kind === 'command' && (typeof args.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(args.idempotencyKey))) throw new Error('Command tests require a valid idempotencyKey.')
  if (operation.definition.result.pagination) {
    const page = args.page || {}
    const size = page.pageSize ?? operation.definition.result.pagination.defaultPageSize
    if (!Number.isSafeInteger(size) || size < 1 || size > operation.definition.result.pagination.maxPageSize) throw new Error('Development operation test page size is invalid.')
    if (page.cursor !== undefined && page.cursor !== null && (typeof page.cursor !== 'string' || page.cursor.length > 1024)) throw new Error('Development operation test cursor is invalid.')
  } else if (args.page !== undefined) throw new Error('Operation does not support pagination.')
  const binding = {
    projectFingerprint: project.fingerprint,
    actor: args.actor,
    operation: args.operation,
    operationFingerprint: fingerprint({ definition: operation.definition, sql: operation.sql }),
    partitionHash: fingerprint(args.partition),
    inputHash: fingerprint(args.input),
    pageHash: args.page === undefined ? null : fingerprint(args.page),
    expectedDataHash: args.expectedData === undefined ? null : fingerprint(args.expectedData),
    idempotencyKeyHash: args.idempotencyKey === undefined ? null : fingerprint(args.idempotencyKey),
  }
  return {
    planId: `operation_test_${fingerprint(binding).slice(0, 32)}`,
    binding,
    actor,
    operation,
    route: operation.definition.kind === 'command'
      ? `/v1/${actor.definition.name.toLowerCase()}s/{partition}/commands`
      : `/v1/${actor.definition.name.toLowerCase()}s/{partition}/queries/${operation.definition.name}`,
  }
}

export class LacifyMcpService {
  constructor({ root = process.cwd(), role = process.env.LACIFY_MCP_ROLE || 'owner', user = process.env.LACIFY_MCP_USER || 'local-user', remote = null, runtimeFetch = fetch, runtimeToken = process.env.LACIFY_RUNTIME_APPLICATION_TOKEN || '', archiveEnvironment = process.env, workspaceRoot = process.env.LACIFY_WORKSPACE_ROOT || null, mcpProject = process.env.LACIFY_MCP_PROJECT || null } = {}) {
    this.root = path.resolve(root)
    this.role = role
    this.user = user
    this.remote = remote
    this.runtimeFetch = runtimeFetch
    this.runtimeToken = runtimeToken
    this.archiveEnvironment = archiveEnvironment
    this.workspaceRoot = workspaceRoot ? path.resolve(workspaceRoot) : null
    this.mcpProject = mcpProject
  }

  async project() {
    const loaded = await loadRuntimeProject(path.join(this.root, 'lacify.runtime.yaml'))
    if (!loaded.valid) throw Object.assign(new Error('Project validation failed.'), { data: { diagnostics: loaded.issues } })
    if (this.mcpProject && loaded.project.runtime.project !== this.mcpProject) throw new Error('MCP project context does not match the repository project ID.')
    return loaded
  }

  async listResources() {
    const project = await this.project()
    const id = project.project.runtime.project
    const resources = [
      { uri: `lacify://projects/${id}`, name: `${id} project`, mimeType: 'application/json' },
      { uri: 'lacify://docs/runtime-v1', name: 'Lacify Runtime v1 file and migration reference', mimeType: 'text/markdown' },
    ]
    if (this.workspaceRoot) {
      const workspace = await workspaceProjects(this.workspaceRoot)
      resources.push({ uri: `lacify://workspaces/${workspace.workspace}`, name: `${workspace.workspace} workspace project catalog`, mimeType: 'application/json' })
    }
    for (const actor of project.project.actors) {
      resources.push({ uri: `lacify://projects/${id}/actors/${actor.definition.name}/schema`, name: `${actor.definition.name} safe schema metadata`, mimeType: 'application/json' })
      for (const operation of actor.operations) resources.push({ uri: `lacify://projects/${id}/actors/${actor.definition.name}/operations/${operation.definition.name}`, name: `${actor.definition.name}.${operation.definition.name} operation`, mimeType: 'application/json' })
    }
    if (this.remote) {
      const visible = await this.remote.request('/api/projects')
      for (const item of visible.projects || []) {
        if (item.id !== id) resources.push({ uri: `lacify://control-plane/projects/${item.id}`, name: `${item.name} Control Plane project`, mimeType: 'application/json' })
      }
    }
    return resources
  }

  async readResource(uri) {
    if (uri === 'lacify://docs/runtime-v1') {
      const text = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../REFERENCE.md', import.meta.url), 'utf8'))
      return { uri, mimeType: 'text/markdown', text: text.slice(0, 200_000) }
    }
    const project = await this.project()
    if (uri === `lacify://projects/${project.project.runtime.project}`) return { uri, mimeType: 'application/json', text: JSON.stringify(publicProject(project)) }
    if (this.workspaceRoot) {
      const workspace = await workspaceProjects(this.workspaceRoot)
      if (uri === `lacify://workspaces/${workspace.workspace}`) {
        return {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({
            workspace: workspace.workspace,
            selectedProject: project.project.runtime.project,
            projects: workspace.projects.map(({ id, path: projectPath, fingerprint, actors }) => ({ id, path: projectPath, fingerprint, actors })),
            businessRowsReturned: false,
          }),
        }
      }
    }
    const actorSchemaMatch = uri.match(/^lacify:\/\/projects\/([a-z0-9][a-z0-9-_]{0,62})\/actors\/([A-Z][A-Za-z0-9]{0,62})\/schema$/)
    if (actorSchemaMatch && actorSchemaMatch[1] === project.project.runtime.project) return { uri, mimeType: 'application/json', text: JSON.stringify(safeActorDataModel(project, actorSchemaMatch[2])) }
    const operationMatch = uri.match(/^lacify:\/\/projects\/([a-z0-9][a-z0-9-_]{0,62})\/actors\/([A-Z][A-Za-z0-9]{0,62})\/operations\/([A-Z][A-Za-z0-9]{0,62})$/)
    if (operationMatch && operationMatch[1] === project.project.runtime.project) {
      const actor = actorEntry(project, operationMatch[2])
      const operation = actor.operations.find(({ definition }) => definition.name === operationMatch[3])
      if (!operation) throw new Error('Unknown or unauthorized MCP resource.')
      return { uri, mimeType: 'application/json', text: JSON.stringify({ actor: actor.definition.name, definition: operation.definition, sql: operation.sql }) }
    }
    const remoteMatch = uri.match(/^lacify:\/\/control-plane\/projects\/([a-z0-9][a-z0-9-_]{0,62})$/)
    if (remoteMatch && this.remote) {
      const projects = await this.remote.request('/api/projects')
      const visible = (projects.projects || []).find(({ id }) => id === remoteMatch[1])
      if (!visible) throw new Error('Unknown or unauthorized MCP resource.')
      const [contracts, environments] = await Promise.all([
        this.remote.request(`/api/projects/${encodeURIComponent(visible.id)}/contracts`),
        this.remote.request(`/api/projects/${encodeURIComponent(visible.id)}/environments`),
      ])
      return { uri, mimeType: 'application/json', text: JSON.stringify({
        project: visible,
        actors: (contracts.contracts || []).map(({ id, aggregateType, key, actions, states, revision, updatedAt }) => ({ id, aggregateType, key, commands: actions, states, revision, updatedAt })),
        environments: Object.fromEntries(Object.entries(environments.environments || {}).map(([name, value]) => [name, { revision: value.revision, updatedAt: value.updatedAt, secretNames: (value.secrets || []).map(({ name: secretName }) => secretName) }])),
      }) }
    }
    throw new Error('Unknown or unauthorized MCP resource.')
  }

  tools() {
    const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
    return [
      ['get_realtime_project', 'Read validated realtime Room Actor metadata without room payloads or remote mutation.', object()],
      ['plan_realtime_release', 'Return a deterministic metadata-only realtime release plan without remote mutation.', object()],
      ['list_projects', 'List repository projects visible in this authenticated scope.', object()],
      ['get_project', 'Read bounded project and Actor metadata without business rows.', object()],
      ['get_actor_schema', 'Read Actor definition and migration IDs.', object({ actor: { type: 'string' } }, ['actor'])],
      ['get_operation_schema', 'Read one reviewable typed operation contract and SQL source without business rows.', object({
        actor: { type: 'string' },
        operation: { type: 'string' },
      }, ['actor', 'operation'])],
      ['get_actor_data_model', 'Read bounded table, column, index, and operation metadata without business rows.', object({ actor: { type: 'string' } }, ['actor'])],
      ['validate_operation_proposal', 'Validate proposed operation YAML and SQL in memory without writing files or mutating remote state.', object({
        actor: { type: 'string' },
        operationYaml: { type: 'string', maxLength: 262144 },
        sql: { type: 'string', maxLength: 65536 },
      }, ['actor', 'operationYaml', 'sql'])],
      ['plan_operation_release', 'Return a bounded immutable operation release plan without SQL source or business rows.', object()],
      ['run_local_operation_tests', 'Run deterministic repository operation fixtures against isolated local SQLite only.', object()],
      ['prepare_project_change_review', 'Validate the repository, run local operation tests, and save a deterministic metadata-only Development review receipt.', object()],
      ['get_project_readiness', 'Run bounded local integration diagnostics and optionally include authenticated remote Development metadata.', object({
        remote: { type: 'boolean' },
      })],
      ['list_local_snapshots', 'List metadata for bounded local Development snapshots without returning business rows.', object()],
      ['create_local_snapshot', 'Create a consistent local Development SQLite snapshot after explicit approval; returns metadata only.', object({
        approved: { type: 'boolean' },
      }, ['approved'])],
      ['verify_local_snapshot', 'Verify snapshot checksums, SQLite integrity, and schema fingerprints without mutation or business rows.', object({
        snapshotId: { type: 'string' },
      }, ['snapshotId'])],
      ['rehearse_local_restore', 'Restore a snapshot into isolated temporary databases, verify it, delete the copies, and save metadata-only evidence after explicit approval.', object({
        approved: { type: 'boolean' },
        snapshotId: { type: 'string' },
      }, ['approved', 'snapshotId'])],
      ['list_modules', 'List reusable built-in Actor extension modules and their bounded metadata.', object()],
      ['plan_module_install', 'Plan a conflict-checked Actor extension installation without changing repository files.', object({
        module: { type: 'string' },
        actor: { type: 'string' },
        version: { type: 'string' },
      }, ['module', 'actor'])],
      ['install_module', 'Install the exact unchanged Actor extension plan into repository files after explicit approval.', object({
        approved: { type: 'boolean' },
        module: { type: 'string' },
        actor: { type: 'string' },
        version: { type: 'string' },
        planId: { type: 'string' },
        projectFingerprint: { type: 'string' },
      }, ['approved', 'module', 'actor', 'planId', 'projectFingerprint'])],
      ['get_module_status', 'Compare installed module baselines with repository files and latest built-in versions without mutation.', object()],
      ['plan_module_upgrade', 'Plan an additive module upgrade and block customized, changed, removed, or conflicting files.', object({
        module: { type: 'string' },
        actor: { type: 'string' },
      }, ['module', 'actor'])],
      ['upgrade_module', 'Apply the exact unchanged additive module upgrade plan after explicit approval.', object({
        approved: { type: 'boolean' },
        module: { type: 'string' },
        actor: { type: 'string' },
        planId: { type: 'string' },
        projectFingerprint: { type: 'string' },
      }, ['approved', 'module', 'actor', 'planId', 'projectFingerprint'])],
      ['inspect_encrypted_archive', 'Inspect bounded unencrypted archive format metadata without decrypting payload data.', object({
        file: { type: 'string' },
      }, ['file'])],
      ['create_encrypted_archive', 'Encrypt a verified local snapshot and project recovery bundle after explicit approval; passphrase comes only from the protected MCP process environment.', object({
        approved: { type: 'boolean' },
        snapshotId: { type: 'string' },
        outputFile: { type: 'string' },
      }, ['approved', 'snapshotId', 'outputFile'])],
      ['verify_encrypted_archive', 'Authenticate, decrypt, checksum, and integrity-check an archive without returning rows or the passphrase.', object({
        file: { type: 'string' },
      }, ['file'])],
      ['restore_encrypted_archive', 'Restore an authenticated archive into a new isolated directory after explicit approval; existing paths are never overwritten.', object({
        approved: { type: 'boolean' },
        file: { type: 'string' },
        target: { type: 'string' },
      }, ['approved', 'file', 'target'])],
      ['list_workspace_projects', 'List bounded metadata for every project in the configured personal workspace.', object()],
      ['get_workspace_project', 'Read one workspace project context by explicit project ID without changing the selected mutation context.', object({
        project: { type: 'string' },
      }, ['project'])],
      ['get_workspace_module_matrix', 'Compare installed module versions and states across workspace projects without mutation.', object()],
      ['list_project_blueprints', 'List immutable metadata-only project blueprint versions in the configured workspace.', object()],
      ['get_project_blueprint', 'Inspect one blueprint contract, provenance, exclusions, and canonical file hashes without file contents.', object({
        name: { type: 'string' },
        version: { type: 'string' },
      }, ['name', 'version'])],
      ['plan_project_from_blueprint', 'Preview an independent project generated from an immutable blueprint without writing files.', object({
        name: { type: 'string' },
        version: { type: 'string' },
        project: { type: 'string' },
        path: { type: 'string' },
        actorRenames: { type: 'object', additionalProperties: { type: 'string' } },
        partitionKeys: { type: 'object', additionalProperties: { type: 'string' } },
        modules: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 128 },
      }, ['name', 'version', 'project'])],
      ['create_project_from_blueprint', 'Create and register the exact planned independent project after explicit approval; the MCP-selected project must be the blueprint source.', object({
        approved: { type: 'boolean' },
        name: { type: 'string' },
        version: { type: 'string' },
        project: { type: 'string' },
        path: { type: 'string' },
        planId: { type: 'string' },
        blueprintFingerprint: { type: 'string' },
        actorRenames: { type: 'object', additionalProperties: { type: 'string' } },
        partitionKeys: { type: 'object', additionalProperties: { type: 'string' } },
        modules: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 128 },
      }, ['approved', 'name', 'version', 'project', 'planId', 'blueprintFingerprint'])],
      ['get_migration_history', 'Read local Development migration ledger metadata.', object()],
      ['validate_project_files', 'Validate canonical repository files without mutation.', object()],
      ['plan_migration', 'Create a deterministic read-only Development migration plan.', object()],
      ['get_environment_drift', 'Compare repository and locked environment state.', object()],
      ['get_runtime_health', 'Read metadata-only local Development health.', object()],
      ['generate_typed_client', 'Generate the deterministic TypeScript client from validated repository files.', object()],
      ['plan_development_operation_test', 'Plan a remote Development operation test and return only hashes and bounded metadata.', object({
        actor: { type: 'string' },
        operation: { type: 'string' },
        partition: { type: 'string' },
        input: { type: 'object', additionalProperties: true },
        page: { type: 'object', additionalProperties: false, properties: { cursor: { type: ['string', 'null'] }, pageSize: { type: 'integer' } } },
        idempotencyKey: { type: 'string' },
        expectedData: {},
      }, ['actor', 'operation', 'partition', 'input'])],
      ['execute_development_operation_test', 'Execute the exact planned remote Development operation test after explicit approval; returns no business rows.', object({
        approved: { type: 'boolean' },
        planId: { type: 'string' },
        projectFingerprint: { type: 'string' },
        actor: { type: 'string' },
        operation: { type: 'string' },
        partition: { type: 'string' },
        input: { type: 'object', additionalProperties: true },
        page: { type: 'object', additionalProperties: false, properties: { cursor: { type: ['string', 'null'] }, pageSize: { type: 'integer' } } },
        idempotencyKey: { type: 'string' },
        expectedData: {},
      }, ['approved', 'planId', 'projectFingerprint', 'actor', 'operation', 'partition', 'input'])],
      ['apply_development_plan', 'Apply an unchanged Development plan after explicit approval.', object({
        approved: { type: 'boolean' },
        planId: { type: 'string' },
        projectFingerprint: { type: 'string' },
      }, ['approved', 'planId', 'projectFingerprint'])],
      ['apply_reviewed_development_change', 'Apply an unchanged saved review receipt to Development after explicit approval, optionally including the governed remote Development deployment.', object({
        approved: { type: 'boolean' },
        reviewId: { type: 'string' },
        projectFingerprint: { type: 'string' },
        remote: { type: 'boolean' },
      }, ['approved', 'reviewId', 'projectFingerprint'])],
    ].map(([name, description, inputSchema]) => ({ name, description, inputSchema }))
  }

  async callTool(name, args = {}) {
    if (name === 'get_realtime_project' || name === 'plan_realtime_release') {
      const realtime = await loadRealtimeProject(path.join(this.root, 'lacify.realtime.yaml'))
      if (!realtime.valid) throw Object.assign(new Error('Realtime project validation failed.'), { data: { diagnostics: realtime.issues } })
      const result = {
        project: realtime.project.realtime.project,
        fingerprint: realtime.fingerprint,
        rooms: realtime.project.rooms.map(({ definition }) => ({
          name: definition.name,
          partitionBy: definition.partitionBy,
          capabilities: definition.capabilities,
          storage: definition.storage,
          retention: definition.retention,
          limits: definition.limits,
          auth: { mode: definition.auth.mode, allowedOrigins: definition.auth.allowedOrigins },
        })),
        remoteMutation: false,
        roomPayloadsReturned: false,
      }
      return name === 'plan_realtime_release' ? { ...result, planId: `realtime_${realtime.fingerprint.slice(0, 40)}` } : result
    }
    if (name === 'list_projects') {
      const project = await this.project()
      const local = [{ id: project.project.runtime.project, fingerprint: project.fingerprint, source: 'repository' }]
      if (!this.remote) return local
      const visible = await this.remote.request('/api/projects')
      return [...local, ...(visible.projects || []).filter(({ id }) => id !== local[0].id).map((item) => ({ ...item, source: 'control-plane' }))]
    }
    if (name === 'get_project') return publicProject(await this.project())
    if (name === 'get_actor_schema') {
      const project = await this.project()
      const actor = publicProject(project).actors.find(({ name: actorName }) => actorName === args.actor)
      if (!actor) throw new Error(`Actor "${args.actor}" does not exist.`)
      return actor
    }
    if (name === 'get_operation_schema') {
      const project = await this.project()
      const actor = project.project.actors.find(({ definition }) => definition.name === args.actor)
      if (!actor) throw new Error(`Actor "${args.actor}" does not exist.`)
      const operation = (actor.operations || []).find(({ definition }) => definition.name === args.operation)
      if (!operation) throw new Error(`Operation "${args.operation}" does not exist on Actor "${args.actor}".`)
      return { actor: args.actor, definition: operation.definition, sql: operation.sql }
    }
    if (name === 'get_actor_data_model') return safeActorDataModel(await this.project(), args.actor)
    if (name === 'validate_operation_proposal') {
      const project = await this.project()
      const actor = actorEntry(project, args.actor)
      if (typeof args.operationYaml !== 'string' || typeof args.sql !== 'string') throw new Error('Operation proposal requires YAML and SQL strings.')
      const parsed = parseYaml(args.operationYaml, '<operation-proposal.yaml>')
      const issues = [...parsed.issues]
      if (parsed.value) {
        issues.push(...validateOperationDocument(parsed.value, actor.definition.commands, '<operation-proposal.yaml>'))
        issues.push(...validateOperationSql(args.sql, parsed.value, '<operation-proposal.sql>'))
      }
      let schemaCompatible = false
      if (!issues.length) {
        const database = new DatabaseSync(':memory:')
        try {
          for (const migration of actor.migrations) database.exec(migration.sql)
          database.prepare(args.sql.trim().replace(/;$/, ''))
          schemaCompatible = true
        } catch {
          issues.push({ file: '<operation-proposal.sql>', path: '', line: null, code: 'schema_incompatible', message: 'Operation SQL does not compile against the Actor schema.' })
        } finally {
          database.close()
        }
      }
      const operationName = parsed.value?.name && typeof parsed.value.name === 'string' ? parsed.value.name : 'operation'
      const slug = operationName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
      return {
        valid: issues.length === 0,
        actor: args.actor,
        proposalFingerprint: fingerprint({ operationYaml: args.operationYaml.replace(/\r\n/g, '\n').trim(), sql: args.sql.replace(/\r\n/g, '\n').trim() }),
        schemaCompatible,
        suggestedFiles: [`actors/${actor.source.split('/')[2]}/operations/${slug}.operation.yaml`, `actors/${actor.source.split('/')[2]}/operations/${slug}.sql`],
        diagnostics: issues.slice(0, 100),
        remoteMutation: false,
      }
    }
    if (name === 'plan_operation_release') {
      const project = await this.project()
      return {
        project: project.project.runtime.project,
        projectFingerprint: project.fingerprint,
        actors: project.project.actors.map((actor) => ({
          actor: actor.definition.name,
          partitionBy: actor.definition.partitionBy,
          operations: actor.operations.map(({ definition, sql }) => ({
            name: definition.name,
            kind: definition.kind,
            operationFingerprint: fingerprint({ definition, sql }),
            inputFields: Object.keys(definition.input),
            result: definition.result,
            route: definition.kind === 'command'
              ? `/v1/${actor.definition.name.toLowerCase()}s/{partition}/commands`
              : `/v1/${actor.definition.name.toLowerCase()}s/{partition}/queries/${definition.name}`,
          })),
        })),
        remoteMutation: false,
      }
    }
    if (name === 'run_local_operation_tests') return (await cliJson(this.root, 'test')).result
    if (name === 'prepare_project_change_review') {
      const reviewed = (await cliJson(this.root, 'review', ['--env', 'development'])).result
      return {
        ...reviewed.receipt,
        receiptFile: path.relative(this.root, reviewed.file),
        remoteMutation: false,
        businessRowsReturned: false,
      }
    }
    if (name === 'get_project_readiness') {
      if (args.remote === true && !this.remote) throw new Error('Remote Control Plane authentication is required for remote readiness checks.')
      const cliArgs = ['--env', 'development', ...(args.remote === true ? ['--remote'] : [])]
      return (await cliJson(this.root, 'doctor', cliArgs, args.remote === true ? { remoteClient: async () => this.remote } : {})).result
    }
    if (name === 'list_local_snapshots') return (await cliJson(this.root, 'snapshots', ['--env', 'development'])).result
    if (name === 'create_local_snapshot') {
      if (!['owner', 'admin', 'developer'].includes(this.role)) throw new Error('Workspace role cannot create local snapshots.')
      if (args.approved !== true) throw new Error('Explicit approval is required because a snapshot contains local business data.')
      const result = (await cliJson(this.root, 'snapshot', ['--env', 'development', '--approve'])).result
      await mkdir(path.join(this.root, '.lacify'), { recursive: true })
      await appendFile(path.join(this.root, '.lacify', 'audit.jsonl'), `${JSON.stringify({
        occurredAt: new Date().toISOString(),
        action: 'mcp.create_local_snapshot',
        user: this.user,
        role: this.role,
        project: result.snapshot.project,
        projectFingerprint: result.snapshot.projectFingerprint,
        snapshotId: result.snapshot.snapshotId,
        result: 'created',
      })}\n`, { mode: 0o600 })
      return result
    }
    if (name === 'verify_local_snapshot') return (await cliJson(this.root, 'verify-snapshot', ['--env', 'development', '--snapshot', String(args.snapshotId)])).result
    if (name === 'rehearse_local_restore') {
      if (!['owner', 'admin', 'developer'].includes(this.role)) throw new Error('Workspace role cannot rehearse local restores.')
      if (args.approved !== true) throw new Error('Explicit approval is required for an isolated restore rehearsal.')
      const result = (await cliJson(this.root, 'rehearse-restore', ['--env', 'development', '--snapshot', String(args.snapshotId), '--approve'])).result
      await mkdir(path.join(this.root, '.lacify'), { recursive: true })
      await appendFile(path.join(this.root, '.lacify', 'audit.jsonl'), `${JSON.stringify({
        occurredAt: new Date().toISOString(),
        action: 'mcp.rehearse_local_restore',
        user: this.user,
        role: this.role,
        project: result.project,
        projectFingerprint: result.projectFingerprint,
        snapshotId: result.snapshotId,
        rehearsalId: result.rehearsalId,
        result: result.passed ? 'passed' : 'failed',
      })}\n`, { mode: 0o600 })
      return result
    }
    if (name === 'list_modules') return (await cliJson(this.root, 'modules')).result
    if (name === 'plan_module_install') return (await cliJson(this.root, 'module-plan', [String(args.module), '--actor', String(args.actor), ...(args.version ? ['--version', String(args.version)] : [])])).result
    if (name === 'install_module') {
      if (!['owner', 'admin', 'developer'].includes(this.role)) throw new Error('Workspace role cannot install repository modules.')
      if (args.approved !== true) throw new Error('Explicit approval is required for repository module installation.')
      const project = await this.project()
      if (args.projectFingerprint !== project.fingerprint) throw new Error('Module plan replay blocked because the project fingerprint changed.')
      const result = (await cliJson(this.root, 'add', [
        String(args.module),
        '--actor', String(args.actor),
        ...(args.version ? ['--version', String(args.version)] : []),
        '--plan', String(args.planId),
        '--approve',
      ])).result
      await mkdir(path.join(this.root, '.lacify'), { recursive: true })
      await appendFile(path.join(this.root, '.lacify', 'audit.jsonl'), `${JSON.stringify({
        occurredAt: new Date().toISOString(),
        action: 'mcp.install_module',
        user: this.user,
        role: this.role,
        project: project.project.runtime.project,
        projectFingerprintBefore: result.projectFingerprintBefore,
        projectFingerprintAfter: result.projectFingerprintAfter,
        module: result.module,
        actor: result.actor,
        result: 'installed',
      })}\n`, { mode: 0o600 })
      return result
    }
    if (name === 'get_module_status') return (await cliJson(this.root, 'module-status')).result
    if (name === 'plan_module_upgrade') return (await cliJson(this.root, 'module-upgrade-plan', [String(args.module), '--actor', String(args.actor)])).result
    if (name === 'upgrade_module') {
      if (!['owner', 'admin', 'developer'].includes(this.role)) throw new Error('Workspace role cannot upgrade repository modules.')
      if (args.approved !== true) throw new Error('Explicit approval is required for repository module upgrade.')
      const project = await this.project()
      if (args.projectFingerprint !== project.fingerprint) throw new Error('Module upgrade replay blocked because the project fingerprint changed.')
      const result = (await cliJson(this.root, 'upgrade', [
        String(args.module),
        '--actor', String(args.actor),
        '--plan', String(args.planId),
        '--approve',
      ])).result
      await mkdir(path.join(this.root, '.lacify'), { recursive: true })
      await appendFile(path.join(this.root, '.lacify', 'audit.jsonl'), `${JSON.stringify({
        occurredAt: new Date().toISOString(),
        action: 'mcp.upgrade_module',
        user: this.user,
        role: this.role,
        project: project.project.runtime.project,
        projectFingerprintBefore: result.projectFingerprintBefore,
        projectFingerprintAfter: result.projectFingerprintAfter,
        module: result.module,
        actor: result.actor,
        fromVersion: result.fromVersion,
        toVersion: result.toVersion,
        result: 'upgraded',
      })}\n`, { mode: 0o600 })
      return result
    }
    if (name === 'inspect_encrypted_archive') return (await cliJson(this.root, 'archive-info', ['--file', String(args.file)])).result
    if (name === 'create_encrypted_archive') {
      if (!['owner', 'admin', 'developer'].includes(this.role)) throw new Error('Workspace role cannot create encrypted archives.')
      if (args.approved !== true) throw new Error('Explicit approval is required because the archive contains business data.')
      const result = (await cliJson(this.root, 'archive-create', [
        '--snapshot', String(args.snapshotId),
        '--output', String(args.outputFile),
        '--approve',
      ], { environment: this.archiveEnvironment })).result
      await mkdir(path.join(this.root, '.lacify'), { recursive: true })
      await appendFile(path.join(this.root, '.lacify', 'audit.jsonl'), `${JSON.stringify({
        occurredAt: new Date().toISOString(),
        action: 'mcp.create_encrypted_archive',
        user: this.user,
        role: this.role,
        project: result.project,
        projectFingerprint: result.projectFingerprint,
        snapshotId: result.snapshotId,
        archiveId: result.archiveId,
        result: 'created',
      })}\n`, { mode: 0o600 })
      return result
    }
    if (name === 'verify_encrypted_archive') return (await cliJson(this.root, 'archive-verify', ['--file', String(args.file)], { environment: this.archiveEnvironment })).result
    if (name === 'restore_encrypted_archive') {
      if (!['owner', 'admin', 'developer'].includes(this.role)) throw new Error('Workspace role cannot restore encrypted archives.')
      if (args.approved !== true) throw new Error('Explicit approval is required for encrypted archive restore.')
      const result = (await cliJson(this.root, 'archive-restore', [
        '--file', String(args.file),
        '--target', String(args.target),
        '--approve',
      ], { environment: this.archiveEnvironment })).result
      await mkdir(path.join(this.root, '.lacify'), { recursive: true })
      await appendFile(path.join(this.root, '.lacify', 'audit.jsonl'), `${JSON.stringify({
        occurredAt: new Date().toISOString(),
        action: 'mcp.restore_encrypted_archive',
        user: this.user,
        role: this.role,
        project: result.project,
        projectFingerprint: result.projectFingerprint,
        snapshotId: result.snapshotId,
        archiveId: result.archiveId,
        result: 'restored-isolated',
      })}\n`, { mode: 0o600 })
      return result
    }
    if (name === 'list_workspace_projects') {
      if (!this.workspaceRoot) throw new Error('LACIFY_WORKSPACE_ROOT is required for workspace discovery.')
      const catalog = await workspaceProjects(this.workspaceRoot)
      return {
        workspace: catalog.workspace,
        selectedProject: (await this.project()).project.runtime.project,
        projects: catalog.projects.map(({ id, path: projectPath, fingerprint, actors }) => ({ id, path: projectPath, fingerprint, actors })),
        remoteMutation: false,
        businessRowsReturned: false,
      }
    }
    if (name === 'get_workspace_project') {
      if (!this.workspaceRoot) throw new Error('LACIFY_WORKSPACE_ROOT is required for workspace discovery.')
      const selected = await selectWorkspaceProject(this.workspaceRoot, String(args.project))
      return {
        id: selected.id,
        path: selected.path,
        fingerprint: selected.fingerprint,
        actors: selected.actors,
        selectedForMutation: selected.id === (await this.project()).project.runtime.project,
        remoteMutation: false,
        businessRowsReturned: false,
      }
    }
    if (name === 'get_workspace_module_matrix') {
      if (!this.workspaceRoot) throw new Error('LACIFY_WORKSPACE_ROOT is required for workspace discovery.')
      return workspaceModuleMatrix(this.workspaceRoot)
    }
    if (name === 'list_project_blueprints') {
      if (!this.workspaceRoot) throw new Error('LACIFY_WORKSPACE_ROOT is required for blueprint discovery.')
      return listProjectBlueprints(this.workspaceRoot)
    }
    if (name === 'get_project_blueprint') {
      if (!this.workspaceRoot) throw new Error('LACIFY_WORKSPACE_ROOT is required for blueprint discovery.')
      return inspectProjectBlueprint(this.workspaceRoot, { name: String(args.name), version: String(args.version) })
    }
    if (name === 'plan_project_from_blueprint') {
      if (!this.workspaceRoot) throw new Error('LACIFY_WORKSPACE_ROOT is required for blueprint planning.')
      return planBlueprintProject(this.workspaceRoot, {
        name: String(args.name),
        version: String(args.version),
        projectId: String(args.project),
        targetPath: args.path === undefined ? String(args.project) : String(args.path),
        actorRenames: args.actorRenames || {},
        partitionKeys: args.partitionKeys || {},
        modules: args.modules === undefined ? null : args.modules,
      })
    }
    if (name === 'create_project_from_blueprint') {
      if (!this.workspaceRoot) throw new Error('LACIFY_WORKSPACE_ROOT is required for blueprint creation.')
      if (!['owner', 'admin', 'developer'].includes(this.role)) throw new Error('Workspace role cannot create projects from blueprints.')
      if (args.approved !== true) throw new Error('Explicit approval is required before creating a project from a blueprint.')
      const blueprint = await inspectProjectBlueprint(this.workspaceRoot, { name: String(args.name), version: String(args.version) })
      const selectedProject = (await this.project()).project.runtime.project
      if (blueprint.sourceProject !== selectedProject) throw new Error('MCP blueprint creation requires the explicitly selected source project context.')
      if (args.blueprintFingerprint !== blueprint.blueprintFingerprint) throw new Error('Blueprint creation replay blocked because the blueprint fingerprint changed.')
      const result = await createBlueprintProject(this.workspaceRoot, {
        name: String(args.name),
        version: String(args.version),
        projectId: String(args.project),
        targetPath: args.path === undefined ? String(args.project) : String(args.path),
        planId: String(args.planId),
        actorRenames: args.actorRenames || {},
        partitionKeys: args.partitionKeys || {},
        modules: args.modules === undefined ? null : args.modules,
      })
      await mkdir(path.join(this.root, '.lacify'), { recursive: true })
      await appendFile(path.join(this.root, '.lacify', 'audit.jsonl'), `${JSON.stringify({
        occurredAt: new Date().toISOString(),
        action: 'mcp.create_project_from_blueprint',
        user: this.user,
        role: this.role,
        sourceProject: selectedProject,
        blueprint: result.blueprint,
        blueprintVersion: result.version,
        blueprintFingerprint: result.blueprintFingerprint,
        project: result.project,
        projectFingerprint: result.projectFingerprint,
        compositionFingerprint: fingerprint(result.composition),
        result: 'created-independent-project',
      })}\n`, { mode: 0o600 })
      return result
    }
    if (name === 'validate_project_files') return (await cliJson(this.root, 'validate')).result
    if (name === 'plan_migration') return (await cliJson(this.root, 'plan', ['--env', 'development'])).result
    if (name === 'get_environment_drift') return (await cliJson(this.root, 'status', ['--env', 'development'])).result
    if (name === 'get_migration_history') return (await cliJson(this.root, 'migrations', ['--env', 'development'])).result
    if (name === 'get_runtime_health') {
      const local = (await cliJson(this.root, 'health', ['--env', 'development'])).result
      if (!this.remote) return local
      const project = await this.project()
      const remote = await this.remote.request(`/api/monitor-overview?project=${encodeURIComponent(project.project.runtime.project)}`)
      return { local, controlPlane: { environments: remote.environments, deployments: remote.deployments } }
    }
    if (name === 'generate_typed_client') return (await cliJson(this.root, 'generate')).result
    if (name === 'plan_development_operation_test') {
      const project = await this.project()
      const planned = developmentOperationTestPlan(project, args)
      return {
        planId: planned.planId,
        project: project.project.runtime.project,
        projectFingerprint: project.fingerprint,
        actor: args.actor,
        operation: args.operation,
        kind: planned.operation.definition.kind,
        route: planned.route,
        partitionHash: planned.binding.partitionHash,
        inputHash: planned.binding.inputHash,
        expectedDataHash: planned.binding.expectedDataHash,
        result: planned.operation.definition.result,
        environment: 'dev',
        remoteMutation: false,
      }
    }
    if (name === 'execute_development_operation_test') {
      if (!['owner', 'admin', 'developer'].includes(this.role)) throw new Error('Workspace role cannot execute remote Development operation tests.')
      if (args.approved !== true) throw new Error('Explicit approval is required for a remote Development operation test.')
      if (!this.remote) throw new Error('Remote Control Plane authentication is required.')
      if (!/^lacify_runtime_[A-Za-z0-9_-]{40,100}$/.test(this.runtimeToken)) throw new Error('LACIFY_RUNTIME_APPLICATION_TOKEN must contain a scoped Development runtime credential.')
      const project = await this.project()
      const planned = developmentOperationTestPlan(project, args)
      if (args.projectFingerprint !== project.fingerprint || args.planId !== planned.planId) throw new Error('Operation test replay blocked because source fingerprint, input, or plan identity changed.')
      const overview = await this.remote.request(`/api/monitor-overview?project=${encodeURIComponent(project.project.runtime.project)}`)
      const development = (overview.environments || []).find(({ environment }) => environment === 'dev')
      const runtimeUrl = development?.deployment?.runtimeUrl
      if (development?.deployment?.status !== 'succeeded' || typeof runtimeUrl !== 'string') throw new Error('A succeeded remote Development deployment is required.')
      const trusted = new URL(runtimeUrl)
      if (trusted.protocol !== 'https:' || !(trusted.hostname.endsWith('.workers.dev') || trusted.hostname.endsWith('.getlacify.com'))) throw new Error('Control Plane returned an untrusted Development runtime URL.')
      const route = planned.operation.definition.kind === 'command'
        ? `/v1/${planned.actor.definition.name.toLowerCase()}s/${encodeURIComponent(args.partition)}/commands`
        : `/v1/${planned.actor.definition.name.toLowerCase()}s/${encodeURIComponent(args.partition)}/queries/${encodeURIComponent(args.operation)}`
      const response = await this.runtimeFetch(`${runtimeUrl.replace(/\/$/, '')}${route}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.runtimeToken}`,
          ...(planned.operation.definition.kind === 'command' ? { 'idempotency-key': args.idempotencyKey } : {}),
        },
        body: JSON.stringify(planned.operation.definition.kind === 'command'
          ? { command: args.operation, payload: args.input }
          : { input: args.input, ...(args.page === undefined ? {} : { page: args.page }) }),
        signal: AbortSignal.timeout(10_000),
      })
      const declaredLength = Number(response.headers.get('content-length') || 0)
      if (declaredLength > 300 * 1024) throw new Error('Development operation test response exceeded its safe bound.')
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > 300 * 1024) throw new Error('Development operation test response exceeded its safe bound.')
      let payload
      try { payload = JSON.parse(text) } catch { payload = null }
      const responseHash = fingerprint(payload)
      const actualDataHash = payload && Object.hasOwn(payload, 'data') ? fingerprint(payload.data) : null
      const dataMatched = planned.binding.expectedDataHash === null ? null : actualDataHash === planned.binding.expectedDataHash
      const passed = response.ok && (dataMatched === null || dataMatched)
      await mkdir(path.join(this.root, '.lacify'), { recursive: true })
      await appendFile(path.join(this.root, '.lacify', 'audit.jsonl'), `${JSON.stringify({
        occurredAt: new Date().toISOString(),
        action: 'mcp.execute_development_operation_test',
        user: this.user,
        role: this.role,
        project: project.project.runtime.project,
        projectFingerprint: project.fingerprint,
        planId: planned.planId,
        actor: args.actor,
        operation: args.operation,
        environment: 'dev',
        deploymentId: development.deployment.id,
        partitionHash: planned.binding.partitionHash,
        inputHash: planned.binding.inputHash,
        expectedDataHash: planned.binding.expectedDataHash,
        responseHash,
        statusCode: response.status,
        result: passed ? 'passed' : 'failed',
      })}\n`, { mode: 0o600 })
      return {
        passed,
        environment: 'dev',
        actor: args.actor,
        operation: args.operation,
        deploymentId: development.deployment.id,
        releaseId: development.deployment.releaseId,
        statusCode: response.status,
        responseHash,
        dataMatched,
        businessRowsReturned: false,
      }
    }
    if (name === 'apply_development_plan') {
      if (!['owner', 'admin', 'developer'].includes(this.role)) throw new Error('Workspace role cannot apply Development migrations.')
      if (args.approved !== true) throw new Error('Explicit approval is required.')
      const planned = (await cliJson(this.root, 'plan', ['--env', 'development'])).result
      const planIds = planned.plans.map(({ planId }) => planId).sort()
      const boundPlanId = planIds.length === 1 ? planIds[0] : await crypto.subtle.digest('SHA-256', new TextEncoder().encode(planIds.join(':'))).then((bytes) => Buffer.from(bytes).toString('hex'))
      if (planned.projectFingerprint !== args.projectFingerprint || boundPlanId !== args.planId) throw new Error('Plan replay blocked because source fingerprint or plan identity changed.')
      const applied = (await cliJson(this.root, 'apply', ['--env', 'development', '--approve'])).result
      await mkdir(path.join(this.root, '.lacify'), { recursive: true })
      await appendFile(path.join(this.root, '.lacify', 'audit.jsonl'), `${JSON.stringify({
        occurredAt: new Date().toISOString(),
        action: 'mcp.apply_development_plan',
        user: this.user,
        role: this.role,
        project: (await this.project()).project.runtime.project,
        projectFingerprint: args.projectFingerprint,
        planId: args.planId,
        result: 'applied',
      })}\n`, { mode: 0o600 })
      return applied
    }
    if (name === 'apply_reviewed_development_change') {
      if (!['owner', 'admin', 'developer'].includes(this.role)) throw new Error('Workspace role cannot apply reviewed Development changes.')
      if (args.approved !== true) throw new Error('Explicit approval is required.')
      const project = await this.project()
      if (args.projectFingerprint !== project.fingerprint) throw new Error('Review replay blocked because the source fingerprint changed.')
      if (args.remote === true && !this.remote) throw new Error('Remote Control Plane authentication is required for remote Development apply.')
      const cliArgs = ['--env', 'development', '--review', String(args.reviewId), '--approve', ...(args.remote === true ? ['--remote'] : [])]
      const applied = (await cliJson(this.root, 'apply-review', cliArgs, args.remote === true ? { remoteClient: async () => this.remote } : {})).result
      await mkdir(path.join(this.root, '.lacify'), { recursive: true })
      await appendFile(path.join(this.root, '.lacify', 'audit.jsonl'), `${JSON.stringify({
        occurredAt: new Date().toISOString(),
        action: 'mcp.apply_reviewed_development_change',
        user: this.user,
        role: this.role,
        project: project.project.runtime.project,
        projectFingerprint: project.fingerprint,
        reviewId: args.reviewId,
        remote: args.remote === true,
        result: 'applied',
      })}\n`, { mode: 0o600 })
      return { ...applied, businessRowsReturned: false }
    }
    throw new Error(`Unknown MCP tool "${name}".`)
  }
}

export async function handleMcpRequest(service, request) {
  if (request.method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: { resources: {}, tools: {} }, serverInfo: { name: 'lacify-runtime', version: '1.0.0' } }
  if (request.method === 'resources/list') return { resources: await service.listResources() }
  if (request.method === 'resources/read') return { contents: [await service.readResource(request.params?.uri)] }
  if (request.method === 'tools/list') return { tools: service.tools() }
  if (request.method === 'tools/call') {
    try {
      const result = await service.callTool(request.params?.name, request.params?.arguments || {})
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Unknown MCP error.' }] }
    }
  }
  if (request.method === 'notifications/initialized') return null
  throw new Error(`Unsupported MCP method "${request.method}".`)
}
