import { randomUUID } from 'node:crypto'
import { access, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { dump, load } from 'js-yaml'
import { fingerprint, loadRuntimeProject } from './index.mjs'
import { moduleCompositionMetadata } from './module-system.mjs'
import { addWorkspaceProject, selectWorkspaceProject, workspaceProjects } from './workspace-catalog.mjs'

const namePattern = /^[a-z][a-z0-9-]{0,62}$/
const projectPattern = /^[a-z0-9][a-z0-9-_]{0,62}$/
const actorNamePattern = /^[A-Z][A-Za-z0-9]{0,62}$/
const partitionKeyPattern = /^[a-z][A-Za-z0-9]{0,62}$/
const versionPattern = /^\d+\.\d+\.\d+$/
const maxFiles = 512
const maxFileBytes = 1024 * 1024
const maxTotalBytes = 16 * 1024 * 1024
const allowedFilePattern = /^(lacify\.runtime\.yaml|actors\/[a-z0-9][a-z0-9-_]{0,62}\/(actor\.yaml|migrations\/\d{4}_[a-z0-9_]+\.sql|operations\/[a-z0-9-]+\.(operation\.yaml|sql)))$/
const personalAgentsFile = fileURLToPath(new URL('../templates/personal/AGENTS.md', import.meta.url))

async function exists(file) {
  try { await access(file); return true } catch { return false }
}

function blueprintRoot(workspaceRoot) {
  return path.join(workspaceRoot, '.lacify', 'blueprints')
}

function blueprintDirectory(workspaceRoot, name, version) {
  if (!namePattern.test(name)) throw new Error('Blueprint name must use lowercase letters, numbers, and hyphens.')
  if (!versionPattern.test(version)) throw new Error('Blueprint version must use semantic version format.')
  return path.join(blueprintRoot(workspaceRoot), name, version)
}

function safeRelative(file) {
  const normalized = file.split(path.sep).join('/')
  if (!allowedFilePattern.test(normalized) || path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Blueprint contains unsafe source path "${file}".`)
  }
  return normalized
}

function validateComposition(manifest) {
  const parameterNames = manifest.parameters.map(({ name }) => name)
  if (manifest.parameters.length !== 4 || new Set(parameterNames).size !== 4 || !['project', 'actorRenames', 'partitionKeys', 'modules'].every((name) => parameterNames.includes(name))) throw new Error('Blueprint v2 parameter contract is invalid.')
  for (const parameter of manifest.parameters) {
    if (!parameter || Object.keys(parameter).some((key) => !['name', 'type', 'required', 'pattern', 'keyPattern', 'valuePattern', 'selectorPattern'].includes(key))) throw new Error('Blueprint v2 parameter metadata is invalid.')
    if (parameter.name === 'project' && (parameter.type !== 'string' || parameter.required !== true || parameter.pattern !== projectPattern.source)) throw new Error('Blueprint project parameter is invalid.')
    if (parameter.name === 'actorRenames' && (parameter.type !== 'map' || parameter.required !== false || parameter.keyPattern !== actorNamePattern.source || parameter.valuePattern !== actorNamePattern.source)) throw new Error('Blueprint Actor rename parameter is invalid.')
    if (parameter.name === 'partitionKeys' && (parameter.type !== 'map' || parameter.required !== false || parameter.keyPattern !== actorNamePattern.source || parameter.valuePattern !== partitionKeyPattern.source)) throw new Error('Blueprint partition parameter is invalid.')
    if (parameter.name === 'modules' && (parameter.type !== 'set' || parameter.required !== false || parameter.selectorPattern !== 'Actor:module')) throw new Error('Blueprint module-selection parameter is invalid.')
  }
  const composition = manifest.composition
  if (!composition || Object.keys(composition).some((key) => !['actors', 'modules'].includes(key)) || !Array.isArray(composition.actors) || !Array.isArray(composition.modules)) throw new Error('Blueprint composition metadata is invalid.')
  if (composition.actors.length !== manifest.actors.length || composition.modules.length !== manifest.modules.length) throw new Error('Blueprint composition metadata does not match its public Actor or module metadata.')
  const actorNames = new Set()
  const actorFiles = new Set()
  for (const actor of composition.actors) {
    if (!actor || Object.keys(actor).some((key) => !['name', 'file'].includes(key)) || !actorNamePattern.test(actor.name)) throw new Error('Blueprint composable Actor metadata is invalid.')
    const file = safeRelative(actor.file)
    if (!file.endsWith('/actor.yaml') || actorNames.has(actor.name) || actorFiles.has(file)) throw new Error('Blueprint composable Actor metadata is duplicated or invalid.')
    actorNames.add(actor.name)
    actorFiles.add(file)
  }
  if (manifest.actors.some(({ name }) => !actorNames.has(name))) throw new Error('Blueprint public Actor metadata is not composable.')
  const selectors = new Set()
  const ownedFiles = new Set()
  const ownedActorEntries = new Set()
  for (const module of composition.modules) {
    if (!module || Object.keys(module).some((key) => !['selector', 'module', 'actor', 'version', 'fingerprint', 'actorPatch', 'files'].includes(key)) || !namePattern.test(module.module) || !actorNames.has(module.actor) || !versionPattern.test(module.version) || !/^[a-f0-9]{64}$/.test(module.fingerprint) || module.selector !== `${module.actor}:${module.module}` || selectors.has(module.selector)) throw new Error('Blueprint composable module metadata is invalid.')
    selectors.add(module.selector)
    if (!module.actorPatch || Object.keys(module.actorPatch).some((key) => !['commands', 'operations'].includes(key)) || !Array.isArray(module.actorPatch.commands) || !Array.isArray(module.actorPatch.operations) || module.actorPatch.commands.some((entry) => !actorNamePattern.test(entry)) || module.actorPatch.operations.some((entry) => !/^\.\/operations\/[a-z0-9-]+\.operation\.yaml$/.test(entry))) throw new Error('Blueprint module Actor patch is invalid.')
    if (!Array.isArray(module.files) || !module.files.length || module.files.some((file) => !safeRelative(file))) throw new Error('Blueprint module file ownership is invalid.')
    const actorFile = composition.actors.find(({ name }) => name === module.actor).file
    const actorDirectory = path.posix.dirname(actorFile)
    for (const file of module.files) {
      if (!file.startsWith(`${actorDirectory}/`) || ownedFiles.has(file)) throw new Error('Blueprint module files must have one owner inside their Actor directory.')
      ownedFiles.add(file)
    }
    for (const command of module.actorPatch.commands) {
      const key = `${module.actor}:command:${command}`
      if (ownedActorEntries.has(key)) throw new Error('Blueprint module Actor patches overlap.')
      ownedActorEntries.add(key)
    }
    for (const operation of module.actorPatch.operations) {
      const key = `${module.actor}:operation:${operation}`
      if (ownedActorEntries.has(key) || !module.files.includes(path.posix.join(actorDirectory, operation))) throw new Error('Blueprint module operation ownership is invalid or overlapping.')
      ownedActorEntries.add(key)
    }
    const publicModule = manifest.modules.find((entry) => entry.module === module.module && entry.actor === module.actor)
    if (!publicModule || publicModule.version !== module.version || publicModule.fingerprint !== module.fingerprint) throw new Error('Blueprint module composition does not match its public provenance.')
  }
}

function validateManifest(manifest, expectedName = null, expectedVersion = null) {
  const supportedContract = manifest?.contract === 'lacify.dev/blueprint/v1' || manifest?.contract === 'lacify.dev/blueprint/v2'
  if (!manifest || !supportedContract || typeof manifest.name !== 'string' || !namePattern.test(manifest.name) || typeof manifest.blueprintVersion !== 'string' || !versionPattern.test(manifest.blueprintVersion)) {
    throw new Error('Blueprint manifest contract is invalid.')
  }
  if (expectedName && manifest.name !== expectedName) throw new Error('Blueprint manifest name does not match its catalog path.')
  if (expectedVersion && manifest.blueprintVersion !== expectedVersion) throw new Error('Blueprint manifest version does not match its catalog path.')
  if (Object.keys(manifest).some((key) => ![
    'contract', 'name', 'blueprintVersion', 'description', 'createdAt', 'sourceProject',
    'sourceFingerprint', 'blueprintFingerprint', 'actors', 'modules', 'parameters',
    'files', 'exclusions', 'businessRowsIncluded', 'secretsIncluded', 'composition',
  ].includes(key))) throw new Error('Blueprint manifest contains an unknown field.')
  if (typeof manifest.description !== 'string' || manifest.description.length > 500 || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('Blueprint description or creation time is invalid.')
  if (!projectPattern.test(manifest.sourceProject) || !/^[a-f0-9]{64}$/.test(manifest.sourceFingerprint) || !/^[a-f0-9]{64}$/.test(manifest.blueprintFingerprint)) throw new Error('Blueprint source identity is invalid.')
  if (manifest.businessRowsIncluded !== false || manifest.secretsIncluded !== false) throw new Error('Blueprint manifest must explicitly exclude business rows and secrets.')
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > maxFiles) throw new Error(`Blueprint must contain 1–${maxFiles} files.`)
  if (!Array.isArray(manifest.actors) || !Array.isArray(manifest.modules) || !Array.isArray(manifest.parameters) || !Array.isArray(manifest.exclusions)) throw new Error('Blueprint manifest collections are invalid.')
  if (!manifest.actors.length || manifest.actors.length > 128 || manifest.modules.length > 128) throw new Error('Blueprint Actor or module metadata exceeds its bounds.')
  for (const actor of manifest.actors) {
    if (!actor || Object.keys(actor).some((key) => !['name', 'partitionBy', 'storage', 'operations'].includes(key)) || !actorNamePattern.test(actor.name) || !partitionKeyPattern.test(actor.partitionBy) || actor.storage !== 'sqlite' || !Number.isSafeInteger(actor.operations) || actor.operations < 0 || actor.operations > 256) throw new Error('Blueprint Actor metadata is invalid.')
  }
  for (const module of manifest.modules) {
    if (!module || Object.keys(module).some((key) => !['module', 'actor', 'version', 'fingerprint'].includes(key)) || !namePattern.test(module.module) || !actorNamePattern.test(module.actor) || !versionPattern.test(module.version) || !/^[a-f0-9]{64}$/.test(module.fingerprint)) throw new Error('Blueprint module provenance is invalid.')
  }
  if (manifest.contract === 'lacify.dev/blueprint/v1') {
    if (manifest.composition !== undefined || manifest.parameters.length !== 1 || manifest.parameters[0]?.name !== 'project' || manifest.parameters[0]?.required !== true || manifest.parameters[0]?.pattern !== projectPattern.source || Object.keys(manifest.parameters[0]).some((key) => !['name', 'required', 'pattern'].includes(key))) throw new Error('Blueprint v1 parameter contract is invalid.')
  } else {
    validateComposition(manifest)
  }
  if (manifest.exclusions.length < 1 || manifest.exclusions.length > 32 || manifest.exclusions.some((entry) => typeof entry !== 'string' || !entry || entry.length > 100)) throw new Error('Blueprint exclusions are invalid.')
  const paths = new Set()
  let totalBytes = 0
  for (const entry of manifest.files) {
    if (!entry || Object.keys(entry).some((key) => !['path', 'bytes', 'hash'].includes(key))) throw new Error('Blueprint file metadata is invalid.')
    const relative = safeRelative(entry.path)
    if (paths.has(relative)) throw new Error(`Blueprint file "${relative}" is duplicated.`)
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > maxFileBytes || !/^[a-f0-9]{64}$/.test(entry.hash)) throw new Error(`Blueprint file metadata for "${relative}" is invalid.`)
    paths.add(relative)
    totalBytes += entry.bytes
  }
  if (totalBytes > maxTotalBytes) throw new Error('Blueprint source exceeds the 16 MiB total limit.')
  if (!paths.has('lacify.runtime.yaml')) throw new Error('Blueprint is missing lacify.runtime.yaml.')
  if (manifest.contract === 'lacify.dev/blueprint/v2' && manifest.composition.modules.some((module) => module.files.some((file) => !paths.has(file)))) throw new Error('Blueprint module composition references a file outside the canonical bundle.')
  const binding = {
    contract: manifest.contract,
    name: manifest.name,
    blueprintVersion: manifest.blueprintVersion,
    description: manifest.description,
    sourceProject: manifest.sourceProject,
    sourceFingerprint: manifest.sourceFingerprint,
    actors: manifest.actors,
    modules: manifest.modules,
    parameters: manifest.parameters,
    files: manifest.files,
    exclusions: manifest.exclusions,
    businessRowsIncluded: manifest.businessRowsIncluded,
    secretsIncluded: manifest.secretsIncluded,
  }
  if (manifest.contract === 'lacify.dev/blueprint/v2') binding.composition = manifest.composition
  if (manifest.blueprintFingerprint !== fingerprint(binding)) throw new Error('Blueprint manifest fingerprint is invalid.')
}

async function canonicalProjectFiles(projectRoot, project) {
  const files = new Set(['lacify.runtime.yaml'])
  for (const actor of project.project.actors) {
    const actorFile = safeRelative(actor.source.replace(/^\.\//, ''))
    files.add(actorFile)
    const actorDirectory = path.posix.dirname(actorFile)
    for (const migration of actor.migrations) files.add(safeRelative(`${actorDirectory}/migrations/${migration.id}.sql`))
    for (const operation of actor.operations) {
      const operationFile = safeRelative(path.posix.join(actorDirectory, operation.source))
      files.add(operationFile)
      files.add(safeRelative(path.posix.join(path.posix.dirname(operationFile), operation.definition.sql)))
    }
  }
  const contents = []
  let totalBytes = 0
  for (const relative of [...files].sort()) {
    const source = await readFile(path.join(projectRoot, relative), 'utf8')
    const bytes = Buffer.byteLength(source)
    if (!bytes || bytes > maxFileBytes) throw new Error(`Blueprint source file "${relative}" has an invalid size.`)
    const statements = source.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').split(';').map((statement) => statement.trim()).filter(Boolean)
    if (relative.endsWith('.sql') && relative.includes('/migrations/') && statements.some((statement) => /^(?:INSERT\s+INTO|UPDATE\b)/i.test(statement))) {
      throw new Error(`Blueprint export blocks data-changing migration "${relative}"; extract reusable schema into a data-free baseline.`)
    }
    totalBytes += bytes
    if (totalBytes > maxTotalBytes) throw new Error('Blueprint source exceeds the 16 MiB total limit.')
    contents.push({ path: relative, contents: source, bytes, hash: fingerprint(source) })
  }
  return contents
}

async function loadBlueprint(workspaceRoot, name, version) {
  const directory = blueprintDirectory(workspaceRoot, name, version)
  let manifest
  const manifestFile = path.join(directory, 'blueprint.json')
  try {
    if (!(await lstat(manifestFile)).isFile()) throw new Error('Blueprint manifest must be a regular file.')
    manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Blueprint "${name}@${version}" does not exist.`)
    if (error instanceof Error && error.message === 'Blueprint manifest must be a regular file.') throw error
    throw new Error(`Blueprint "${name}@${version}" manifest is not valid JSON.`)
  }
  validateManifest(manifest, name, version)
  const files = []
  for (const entry of manifest.files) {
    const file = path.join(directory, 'files', entry.path)
    if (!(await lstat(file)).isFile()) throw new Error(`Blueprint file "${entry.path}" must be a regular file.`)
    const contents = await readFile(file, 'utf8')
    if (Buffer.byteLength(contents) !== entry.bytes || fingerprint(contents) !== entry.hash) throw new Error(`Blueprint file "${entry.path}" failed integrity verification.`)
    files.push({ ...entry, contents })
  }
  return { directory, manifest, files }
}

export async function exportProjectBlueprint(workspaceRoot, { projectId, name, version, description = '' }) {
  const source = await selectWorkspaceProject(workspaceRoot, projectId)
  const modules = await moduleCompositionMetadata({ root: source.root, project: source.project })
  const unsafeModule = modules.find(({ state }) => state !== 'current')
  if (unsafeModule) throw new Error(`Blueprint export requires module "${unsafeModule.module}" on Actor "${unsafeModule.actor}" to be current and uncustomized.`)
  const files = await canonicalProjectFiles(source.root, source.project)
  const destination = blueprintDirectory(workspaceRoot, name, version)
  if (await exists(destination)) throw new Error(`Blueprint "${name}@${version}" already exists and immutable versions cannot be overwritten.`)
  const manifestBase = {
    contract: 'lacify.dev/blueprint/v2',
    name,
    blueprintVersion: version,
    description: String(description).slice(0, 500),
    sourceProject: source.id,
    sourceFingerprint: source.fingerprint,
    actors: source.project.project.actors.map(({ definition, operations }) => ({
      name: definition.name,
      partitionBy: definition.partitionBy,
      storage: definition.storage,
      operations: operations.length,
    })),
    modules: modules.map(({ module, actor, version: moduleVersion, fingerprint: moduleFingerprint }) => ({
      module,
      actor,
      version: moduleVersion,
      fingerprint: moduleFingerprint,
    })),
    parameters: [
      { name: 'project', type: 'string', required: true, pattern: projectPattern.source },
      { name: 'actorRenames', type: 'map', required: false, keyPattern: actorNamePattern.source, valuePattern: actorNamePattern.source },
      { name: 'partitionKeys', type: 'map', required: false, keyPattern: actorNamePattern.source, valuePattern: partitionKeyPattern.source },
      { name: 'modules', type: 'set', required: false, selectorPattern: 'Actor:module' },
    ],
    files: files.map(({ path: file, bytes, hash }) => ({ path: file, bytes, hash })),
    composition: {
      actors: source.project.project.actors.map(({ source: actorFile, definition }) => ({
        name: definition.name,
        file: safeRelative(actorFile.replace(/^\.\//, '')),
      })),
      modules: modules.map(({ module, actor, version: moduleVersion, fingerprint: moduleFingerprint, actorPatch, files: moduleFiles }) => ({
        selector: `${actor}:${module}`,
        module,
        actor,
        version: moduleVersion,
        fingerprint: moduleFingerprint,
        actorPatch,
        files: moduleFiles.map(safeRelative),
      })),
    },
    exclusions: ['business rows', 'Development seeds', 'operation fixtures', 'SQLite databases', 'credentials', 'environment lock state', 'module installation history', 'review receipts', 'generated clients', 'deployments'],
    businessRowsIncluded: false,
    secretsIncluded: false,
  }
  const manifest = {
    ...manifestBase,
    createdAt: new Date().toISOString(),
    blueprintFingerprint: fingerprint(manifestBase),
  }
  const parent = path.dirname(destination)
  const staging = path.join(parent, `.${version}.tmp-${randomUUID()}`)
  await mkdir(parent, { recursive: true })
  await mkdir(staging)
  try {
    for (const file of files) {
      const target = path.join(staging, 'files', file.path)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, file.contents, { flag: 'wx', mode: 0o600 })
    }
    await writeFile(path.join(staging, 'blueprint.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(staging, destination)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  return {
    exported: true,
    workspace: (await workspaceProjects(workspaceRoot)).workspace,
    contract: manifest.contract,
    composable: true,
    name,
    version,
    sourceProject: source.id,
    sourceFingerprint: source.fingerprint,
    blueprintFingerprint: manifest.blueprintFingerprint,
    files: manifest.files.length,
    actors: manifest.actors,
    modules: manifest.modules,
    businessRowsIncluded: false,
    secretsIncluded: false,
    remoteMutation: false,
  }
}

export async function listProjectBlueprints(workspaceRoot) {
  const root = blueprintRoot(workspaceRoot)
  const blueprints = []
  let names = []
  try { names = await readdir(root, { withFileTypes: true }) } catch (error) {
    if (error?.code === 'ENOENT') return { workspace: (await workspaceProjects(workspaceRoot)).workspace, blueprints: [], businessRowsReturned: false, remoteMutation: false }
    throw error
  }
  for (const name of names.filter((entry) => entry.isDirectory()).map(({ name }) => name).sort()) {
    const versions = (await readdir(path.join(root, name), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && versionPattern.test(entry.name))
      .map(({ name: version }) => version)
      .sort()
    for (const version of versions) {
      const loaded = await loadBlueprint(workspaceRoot, name, version)
      blueprints.push({
        name,
        version,
        contract: loaded.manifest.contract,
        composable: loaded.manifest.contract === 'lacify.dev/blueprint/v2',
        description: loaded.manifest.description,
        blueprintFingerprint: loaded.manifest.blueprintFingerprint,
        sourceProject: loaded.manifest.sourceProject,
        actors: loaded.manifest.actors,
        modules: loaded.manifest.modules,
        files: loaded.manifest.files.length,
      })
    }
  }
  return {
    workspace: (await workspaceProjects(workspaceRoot)).workspace,
    blueprints,
    businessRowsReturned: false,
    remoteMutation: false,
  }
}

export async function inspectProjectBlueprint(workspaceRoot, { name, version }) {
  const loaded = await loadBlueprint(workspaceRoot, name, version)
  return {
    name,
    version,
    contract: loaded.manifest.contract,
    composable: loaded.manifest.contract === 'lacify.dev/blueprint/v2',
    description: loaded.manifest.description,
    sourceProject: loaded.manifest.sourceProject,
    sourceFingerprint: loaded.manifest.sourceFingerprint,
    blueprintFingerprint: loaded.manifest.blueprintFingerprint,
    actors: loaded.manifest.actors,
    modules: loaded.manifest.modules,
    parameters: loaded.manifest.parameters,
    composition: loaded.manifest.contract === 'lacify.dev/blueprint/v2' ? {
      actors: loaded.manifest.composition.actors,
      modules: loaded.manifest.composition.modules.map(({ selector, module, actor, version, fingerprint, files }) => ({ selector, module, actor, version, fingerprint, files })),
    } : null,
    files: loaded.manifest.files,
    exclusions: loaded.manifest.exclusions,
    businessRowsIncluded: false,
    secretsIncluded: false,
    remoteMutation: false,
  }
}

function normalizedCompositionParameters(manifest, { actorRenames = {}, partitionKeys = {}, modules = null } = {}) {
  const records = [
    ['actorRenames', actorRenames],
    ['partitionKeys', partitionKeys],
  ]
  for (const [label, value] of records) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Blueprint ${label} must be an object map.`)
  }
  if (modules !== null && (!Array.isArray(modules) || modules.length > 128 || modules.some((entry) => typeof entry !== 'string'))) throw new Error('Blueprint modules must be a bounded selector array or null for all modules.')
  if (manifest.contract === 'lacify.dev/blueprint/v1') {
    if (Object.keys(actorRenames).length || Object.keys(partitionKeys).length || modules !== null) throw new Error('Blueprint v1 supports only the project parameter; export a v2 blueprint for composition.')
    return {
      customizable: false,
      actorRenames: Object.fromEntries(manifest.actors.map(({ name }) => [name, name])),
      partitionKeys: Object.fromEntries(manifest.actors.map(({ name, partitionBy }) => [name, partitionBy])),
      modules: manifest.modules.map(({ actor, module }) => `${actor}:${module}`).sort(),
    }
  }
  const actorNames = new Set(manifest.composition.actors.map(({ name }) => name))
  for (const [source, target] of Object.entries(actorRenames)) {
    if (!actorNames.has(source)) throw new Error(`Blueprint Actor "${source}" cannot be renamed because it does not exist.`)
    if (!actorNamePattern.test(target)) throw new Error(`Blueprint Actor rename target "${target}" is invalid.`)
  }
  for (const [source, key] of Object.entries(partitionKeys)) {
    if (!actorNames.has(source)) throw new Error(`Blueprint Actor "${source}" cannot receive a partition key because it does not exist.`)
    if (!partitionKeyPattern.test(key)) throw new Error(`Blueprint partition key "${key}" is invalid.`)
  }
  const normalizedRenames = Object.fromEntries([...actorNames].sort().map((source) => [source, actorRenames[source] || source]))
  if (new Set(Object.values(normalizedRenames)).size !== actorNames.size) throw new Error('Blueprint Actor rename targets must remain unique.')
  const sourcePartitions = new Map(manifest.actors.map(({ name, partitionBy }) => [name, partitionBy]))
  const normalizedPartitions = Object.fromEntries([...actorNames].sort().map((source) => [source, partitionKeys[source] || sourcePartitions.get(source)]))
  const available = manifest.composition.modules
  const availableSelectors = new Set(available.map(({ selector }) => selector))
  const selected = new Set()
  const requested = modules === null ? [...availableSelectors] : modules
  for (const request of requested) {
    let selector = request
    if (!availableSelectors.has(selector)) {
      const matches = available.filter(({ module }) => module === request)
      if (matches.length === 1) selector = matches[0].selector
      else if (matches.length > 1) throw new Error(`Blueprint module selector "${request}" is ambiguous; use Actor:module.`)
      else throw new Error(`Blueprint module selector "${request}" does not exist.`)
    }
    if (selected.has(selector)) throw new Error(`Blueprint module selector "${selector}" is duplicated.`)
    selected.add(selector)
  }
  return {
    customizable: true,
    actorRenames: normalizedRenames,
    partitionKeys: normalizedPartitions,
    modules: [...selected].sort(),
  }
}

function materializedBlueprintContent(file, projectId, manifest, parameters, deselectedModules) {
  if (file.path === 'lacify.runtime.yaml') {
    const runtime = load(file.contents)
    runtime.project = projectId
    return dump(runtime, { noRefs: true, lineWidth: -1, sortKeys: false })
  }
  if (manifest.contract !== 'lacify.dev/blueprint/v2') return file.contents
  const actor = manifest.composition.actors.find(({ file: actorFile }) => actorFile === file.path)
  if (!actor) return file.contents
  const definition = load(file.contents)
  for (const module of deselectedModules.filter(({ actor: actorName }) => actorName === actor.name)) {
    const removedCommands = new Set(module.actorPatch.commands)
    const removedOperations = new Set(module.actorPatch.operations)
    definition.commands = (definition.commands || []).filter((entry) => !removedCommands.has(entry))
    definition.operations = (definition.operations || []).filter((entry) => !removedOperations.has(entry))
  }
  definition.name = parameters.actorRenames[actor.name]
  definition.partitionBy = parameters.partitionKeys[actor.name]
  return dump(definition, { noRefs: true, lineWidth: -1, sortKeys: false })
}

function validateMaterializedSchema(project) {
  for (const actor of project.project.actors) {
    const database = new DatabaseSync(':memory:')
    try {
      for (const migration of actor.migrations) database.exec(migration.sql)
      for (const operation of actor.operations) database.prepare(operation.sql.trim().replace(/;$/, ''))
    } catch {
      throw new Error(`Blueprint composition makes Actor "${actor.definition.name}" schema or operation SQL invalid.`)
    } finally {
      database.close()
    }
  }
}

async function materializeBlueprint(staging, loaded, projectId, compositionInput = {}) {
  const parameters = normalizedCompositionParameters(loaded.manifest, compositionInput)
  const selectedModules = new Set(parameters.modules)
  const composableModules = loaded.manifest.contract === 'lacify.dev/blueprint/v2' ? loaded.manifest.composition.modules : []
  const deselectedModules = composableModules.filter(({ selector }) => !selectedModules.has(selector))
  const excludedFiles = new Set(deselectedModules.flatMap(({ files }) => files))
  const materializedFiles = []
  for (const file of loaded.files) {
    if (excludedFiles.has(file.path)) continue
    const target = path.join(staging, file.path)
    await mkdir(path.dirname(target), { recursive: true })
    const contents = materializedBlueprintContent(file, projectId, loaded.manifest, parameters, deselectedModules)
    await writeFile(target, contents, { flag: 'wx', mode: 0o600 })
    materializedFiles.push({ path: file.path, bytes: Buffer.byteLength(contents), hash: fingerprint(contents), sourceHash: file.hash })
  }
  const lockContents = `${JSON.stringify({ version: 1, baseRevision: null, projectFingerprint: null, environments: {} }, null, 2)}\n`
  const agentsContents = await readFile(personalAgentsFile, 'utf8')
  const testsReadme = '# Operation tests\n\nAdd deterministic `*.operation.json` fixtures for this project before Production promotion. No source-project fixtures or business rows were copied by the blueprint.\n'
  await mkdir(path.join(staging, '.lacify'), { recursive: true })
  await writeFile(path.join(staging, '.lacify', 'lock.json'), lockContents, { flag: 'wx', mode: 0o600 })
  await writeFile(path.join(staging, 'AGENTS.md'), agentsContents, { flag: 'wx', mode: 0o600 })
  await mkdir(path.join(staging, 'tests'), { recursive: true })
  await writeFile(path.join(staging, 'tests', 'README.md'), testsReadme, { flag: 'wx', mode: 0o600 })
  materializedFiles.push(
    { path: '.lacify/lock.json', bytes: Buffer.byteLength(lockContents), hash: fingerprint(lockContents), generated: true },
    { path: 'AGENTS.md', bytes: Buffer.byteLength(agentsContents), hash: fingerprint(agentsContents), generated: true },
    { path: 'tests/README.md', bytes: Buffer.byteLength(testsReadme), hash: fingerprint(testsReadme), generated: true },
  )
  materializedFiles.sort((left, right) => left.path.localeCompare(right.path))
  const projected = await loadRuntimeProject(path.join(staging, 'lacify.runtime.yaml'))
  if (!projected.valid) throw Object.assign(new Error('Blueprint materialization failed canonical project validation.'), { diagnostics: projected.issues })
  validateMaterializedSchema(projected)
  const modules = loaded.manifest.modules
    .filter(({ actor, module }) => selectedModules.has(`${actor}:${module}`))
    .map((module) => ({ ...module, sourceActor: module.actor, actor: parameters.actorRenames[module.actor] }))
  const actors = projected.project.actors.map(({ definition, operations }) => ({
    name: definition.name,
    sourceActor: Object.entries(parameters.actorRenames).find(([, target]) => target === definition.name)?.[0] || definition.name,
    partitionBy: definition.partitionBy,
    storage: definition.storage,
    operations: operations.length,
  }))
  return { projected, files: materializedFiles, parameters, actors, modules }
}

export async function planBlueprintProject(workspaceRoot, { name, version, projectId, targetPath = projectId, actorRenames = {}, partitionKeys = {}, modules = null }) {
  if (!projectPattern.test(projectId)) throw new Error('Target project ID must use lowercase letters, numbers, hyphens, or underscores.')
  if (!projectPattern.test(targetPath)) throw new Error('Blueprint target path must be one direct child directory using lowercase letters, numbers, hyphens, or underscores.')
  const workspaceReal = await realpath(workspaceRoot)
  const destination = path.join(workspaceReal, targetPath)
  if (await exists(destination)) throw new Error(`Blueprint target path "${targetPath}" already exists.`)
  const catalog = await workspaceProjects(workspaceRoot)
  if (catalog.projects.some(({ id }) => id === projectId)) throw new Error(`Workspace already contains project ID "${projectId}".`)
  const loaded = await loadBlueprint(workspaceRoot, name, version)
  const staging = path.join(workspaceReal, `.lacify-blueprint-plan-${randomUUID()}`)
  await mkdir(staging)
  let materialized
  try { materialized = await materializeBlueprint(staging, loaded, projectId, { actorRenames, partitionKeys, modules }) } finally {
    await rm(staging, { recursive: true, force: true })
  }
  const files = materialized.files
  const binding = {
    workspace: catalog.workspace,
    blueprint: name,
    version,
    blueprintFingerprint: loaded.manifest.blueprintFingerprint,
    project: projectId,
    targetPath,
    projectedFingerprint: materialized.projected.fingerprint,
    composition: materialized.parameters,
    files,
  }
  return {
    valid: true,
    planId: `blueprint_plan_${fingerprint(binding).slice(0, 40)}`,
    workspace: catalog.workspace,
    blueprint: name,
    version,
    blueprintFingerprint: loaded.manifest.blueprintFingerprint,
    project: projectId,
    targetPath,
    projectedFingerprint: materialized.projected.fingerprint,
    actors: materialized.actors,
    modules: materialized.modules,
    composition: materialized.parameters,
    files,
    exclusions: loaded.manifest.exclusions,
    businessRowsIncluded: false,
    secretsIncluded: false,
    remoteMutation: false,
    binding,
  }
}

export async function createBlueprintProject(workspaceRoot, { name, version, projectId, targetPath = projectId, planId, actorRenames = {}, partitionKeys = {}, modules = null }) {
  const plan = await planBlueprintProject(workspaceRoot, { name, version, projectId, targetPath, actorRenames, partitionKeys, modules })
  if (plan.planId !== planId) throw new Error('Blueprint plan replay blocked because the blueprint, workspace, project ID, target path, or generated files changed.')
  const loaded = await loadBlueprint(workspaceRoot, name, version)
  const workspaceReal = await realpath(workspaceRoot)
  const destination = path.join(workspaceReal, targetPath)
  const staging = path.join(workspaceReal, `.lacify-blueprint-create-${randomUUID()}`)
  await mkdir(staging)
  let materialized
  try {
    materialized = await materializeBlueprint(staging, loaded, projectId, { actorRenames, partitionKeys, modules })
    if (await exists(destination)) throw new Error(`Blueprint target path "${targetPath}" appeared after planning; creation stopped without overwrite.`)
    await rename(staging, destination)
    try { await addWorkspaceProject(workspaceRoot, targetPath) } catch (error) {
      await rm(destination, { recursive: true, force: true })
      throw error
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  return {
    created: true,
    workspace: plan.workspace,
    blueprint: name,
    version,
    blueprintFingerprint: plan.blueprintFingerprint,
    project: projectId,
    path: targetPath,
    projectFingerprint: materialized.projected.fingerprint,
    sourceFingerprint: loaded.manifest.sourceFingerprint,
    actors: materialized.actors,
    modules: materialized.modules,
    composition: materialized.parameters,
    independentStorage: true,
    businessRowsIncluded: false,
    secretsIncluded: false,
    remoteMutation: false,
  }
}
