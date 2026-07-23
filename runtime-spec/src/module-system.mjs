import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { dump, load } from 'js-yaml'
import { fingerprint, loadRuntimeProject } from './index.mjs'

const moduleNamePattern = /^[a-z][a-z0-9-]{0,62}$/
const actorNamePattern = /^[A-Z][A-Za-z0-9]{0,62}$/
const sourcePattern = /^files\/[a-z0-9][a-z0-9._-]{0,127}$/
const targetPattern = /^(actor\/(migrations\/\d{4}_[a-z0-9_]+\.sql|operations\/[a-z0-9-]+\.(operation\.yaml|sql))|project\/tests\/[a-z0-9-]+\.operation\.json)$/
const modulesRoot = fileURLToPath(new URL('../modules', import.meta.url))

async function fileExists(file) {
  try { await readFile(file); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}

function validateManifest(value, expectedName) {
  if (!value || value.version !== 'lacify.dev/module/v1' || value.name !== expectedName || value.kind !== 'actor-extension') throw new Error(`Module "${expectedName}" has an invalid manifest contract.`)
  if (!value.target || typeof value.target.partitionBy !== 'string' || value.target.storage !== 'sqlite') throw new Error(`Module "${expectedName}" has an invalid target contract.`)
  if (!value.actorPatch || !Array.isArray(value.actorPatch.commands) || !Array.isArray(value.actorPatch.operations)) throw new Error(`Module "${expectedName}" has an invalid Actor patch.`)
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > 64) throw new Error(`Module "${expectedName}" must contain 1–64 files.`)
  const targets = new Set()
  for (const file of value.files) {
    if (!sourcePattern.test(file.source) || !targetPattern.test(file.target)) throw new Error(`Module "${expectedName}" contains an unsafe file path.`)
    if (targets.has(file.target)) throw new Error(`Module "${expectedName}" contains duplicate target "${file.target}".`)
    targets.add(file.target)
  }
}

async function loadModule(name, requestedVersion = null) {
  if (!moduleNamePattern.test(name)) throw new Error('Module name must use lowercase letters, numbers, and hyphens.')
  const directory = path.join(modulesRoot, name)
  if (requestedVersion !== null && !/^\d+\.\d+\.\d+$/.test(requestedVersion)) throw new Error('Module version must use semantic version format.')
  let manifestFile = path.join(directory, 'module.json')
  if (requestedVersion) {
    try {
      const latestManifest = JSON.parse(await readFile(manifestFile, 'utf8'))
      if ((latestManifest.moduleVersion || '1.0.0') !== requestedVersion) manifestFile = path.join(directory, 'versions', requestedVersion, 'module.json')
    } catch {
      manifestFile = path.join(directory, 'versions', requestedVersion, 'module.json')
    }
  }
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Unknown Lacify module "${name}"${requestedVersion ? ` version ${requestedVersion}` : ''}.`)
    throw new Error(`Module "${name}" manifest is not valid JSON.`)
  }
  validateManifest(manifest, name)
  const moduleVersion = manifest.moduleVersion || requestedVersion || '1.0.0'
  if (!/^\d+\.\d+\.\d+$/.test(moduleVersion) || (requestedVersion && moduleVersion !== requestedVersion)) throw new Error(`Module "${name}" has an invalid module version.`)
  const files = []
  for (const entry of manifest.files) {
    const contents = await readFile(path.join(directory, entry.source), 'utf8')
    if (Buffer.byteLength(contents, 'utf8') > 1024 * 1024) throw new Error(`Module file "${entry.source}" exceeds 1 MiB.`)
    files.push({ ...entry, contents })
  }
  return { directory, manifest, files, moduleVersion, moduleFingerprint: fingerprint({ manifest, files: files.map(({ source, target, contents }) => ({ source, target, contents })) }) }
}

export async function listModules() {
  const entries = await readdir(modulesRoot, { withFileTypes: true })
  const modules = []
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const loaded = await loadModule(entry.name)
      modules.push({
        name: loaded.manifest.name,
        kind: loaded.manifest.kind,
        description: loaded.manifest.description,
        latestVersion: loaded.moduleVersion,
        target: loaded.manifest.target,
        commands: loaded.manifest.actorPatch.commands,
        operations: loaded.manifest.actorPatch.operations.length,
        files: loaded.files.length,
        moduleFingerprint: loaded.moduleFingerprint,
      })
    } catch {
      // Invalid built-in modules are not advertised.
    }
  }
  return modules
}

function actorTarget(root, actor) {
  const actorFile = path.resolve(root, actor.source)
  const relative = path.relative(root, actorFile)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Actor source escapes the project root.')
  return { actorFile, actorRoot: path.dirname(actorFile) }
}

function destinationFor(root, actorRoot, target) {
  if (target.startsWith('actor/')) return path.join(actorRoot, target.slice('actor/'.length))
  return path.join(root, target.slice('project/'.length))
}

function materializedContents(file, actorName) {
  if (!file.target.startsWith('project/tests/')) return file.contents
  const testCase = JSON.parse(file.contents)
  testCase.actor = actorName
  return `${JSON.stringify(testCase, null, 2)}\n`
}

function patchedActorYaml(source, patch) {
  const value = load(source)
  value.commands = [...value.commands, ...patch.commands]
  value.operations = [...(value.operations || []), ...patch.operations]
  return dump(value, { noRefs: true, lineWidth: -1, sortKeys: false })
}

async function stageAndValidate({ root, actor, loadedModule, contentsByTarget }) {
  const staging = await mkdtemp(path.join(tmpdir(), 'lacify-module-'))
  try {
    await cp(path.join(root, 'lacify.runtime.yaml'), path.join(staging, 'lacify.runtime.yaml'))
    await cp(path.join(root, 'actors'), path.join(staging, 'actors'), { recursive: true })
    try { await cp(path.join(root, 'tests'), path.join(staging, 'tests'), { recursive: true }) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    const stagedActor = actorTarget(staging, actor)
    for (const file of loadedModule.files) {
      const destination = destinationFor(staging, stagedActor.actorRoot, file.target)
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, contentsByTarget.get(file.target), { flag: 'wx' })
    }
    const actorSource = await readFile(stagedActor.actorFile, 'utf8')
    await writeFile(stagedActor.actorFile, patchedActorYaml(actorSource, loadedModule.manifest.actorPatch))
    const projected = await loadRuntimeProject(path.join(staging, 'lacify.runtime.yaml'))
    if (!projected.valid) return { valid: false, diagnostics: projected.issues.slice(0, 100), projectedFingerprint: null }
    const projectedActor = projected.project.actors.find(({ definition }) => definition.name === actor.definition.name)
    const database = new DatabaseSync(':memory:')
    try {
      for (const migration of projectedActor.migrations) database.exec(migration.sql)
    } catch {
      return { valid: false, diagnostics: [{ code: 'schema_conflict', message: 'Module migrations do not compose with the target Actor schema.' }], projectedFingerprint: null }
    } finally {
      database.close()
    }
    return { valid: true, diagnostics: [], projectedFingerprint: projected.fingerprint }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

export async function planModuleInstall({ root, project, moduleName, actorName, moduleVersion = null }) {
  if (!actorNamePattern.test(actorName)) throw new Error('Target Actor name must be PascalCase.')
  const loadedModule = await loadModule(moduleName, moduleVersion)
  const actor = project.project.actors.find(({ definition }) => definition.name === actorName)
  if (!actor) throw new Error(`Actor "${actorName}" does not exist.`)
  const issues = []
  if (actor.definition.partitionBy !== loadedModule.manifest.target.partitionBy) issues.push({ code: 'partition_mismatch', message: `Module requires partitionBy ${loadedModule.manifest.target.partitionBy}.` })
  if (actor.definition.storage !== loadedModule.manifest.target.storage) issues.push({ code: 'storage_mismatch', message: `Module requires ${loadedModule.manifest.target.storage} storage.` })
  for (const command of loadedModule.manifest.actorPatch.commands) if (actor.definition.commands.includes(command)) issues.push({ code: 'command_conflict', message: `Command "${command}" already exists.` })
  for (const operation of loadedModule.manifest.actorPatch.operations) if ((actor.definition.operations || []).includes(operation)) issues.push({ code: 'operation_conflict', message: `Operation reference "${operation}" already exists.` })

  const target = actorTarget(root, actor)
  const contentsByTarget = new Map()
  const files = []
  for (const file of loadedModule.files) {
    const contents = materializedContents(file, actorName)
    contentsByTarget.set(file.target, contents)
    const destination = destinationFor(root, target.actorRoot, file.target)
    if (await fileExists(destination)) issues.push({ code: 'file_conflict', message: `${path.relative(root, destination)} already exists.` })
    files.push({ path: path.relative(root, destination).split(path.sep).join('/'), bytes: Buffer.byteLength(contents), hash: fingerprint(contents) })
  }
  let projectedFingerprint = null
  if (!issues.length) {
    const staged = await stageAndValidate({ root, actor, loadedModule, contentsByTarget })
    issues.push(...staged.diagnostics)
    projectedFingerprint = staged.projectedFingerprint
  }
  const binding = {
    projectFingerprint: project.fingerprint,
    module: moduleName,
    moduleVersion: loadedModule.moduleVersion,
    moduleFingerprint: loadedModule.moduleFingerprint,
    actor: actorName,
    files,
    actorPatch: loadedModule.manifest.actorPatch,
    projectedFingerprint,
  }
  return {
    valid: issues.length === 0,
    planId: `module_plan_${fingerprint(binding).slice(0, 40)}`,
    module: moduleName,
    moduleVersion: loadedModule.moduleVersion,
    kind: loadedModule.manifest.kind,
    description: loadedModule.manifest.description,
    moduleFingerprint: loadedModule.moduleFingerprint,
    projectFingerprint: project.fingerprint,
    projectedFingerprint,
    actor: actorName,
    actorPatch: loadedModule.manifest.actorPatch,
    files,
    diagnostics: issues.slice(0, 100),
    remoteMutation: false,
    businessRowsReturned: false,
    binding,
  }
}

export async function installModule({ root, project, moduleName, actorName, planId, moduleVersion = null }) {
  const plan = await planModuleInstall({ root, project, moduleName, actorName, moduleVersion })
  if (!plan.valid) throw Object.assign(new Error('Module installation is blocked by conflicts or validation errors.'), { diagnostics: plan.diagnostics })
  if (plan.planId !== planId) throw new Error('Module plan replay blocked because the repository, module, target Actor, or projected files changed.')
  const loadedModule = await loadModule(moduleName, moduleVersion)
  const actor = project.project.actors.find(({ definition }) => definition.name === actorName)
  const target = actorTarget(root, actor)
  const created = []
  let originalActorSource = null
  let actorPatched = false
  try {
    for (const file of loadedModule.files) {
      const destination = destinationFor(root, target.actorRoot, file.target)
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, materializedContents(file, actorName), { flag: 'wx' })
      created.push(destination)
    }
    originalActorSource = await readFile(target.actorFile, 'utf8')
    await writeFile(target.actorFile, patchedActorYaml(originalActorSource, loadedModule.manifest.actorPatch))
    actorPatched = true
    const recordFile = path.join(root, '.lacify', 'modules.json')
    let record = { version: 1, installations: [] }
    try { record = JSON.parse(await readFile(recordFile, 'utf8')) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    record.installations.push({
      module: moduleName,
      moduleVersion: loadedModule.moduleVersion,
      moduleFingerprint: loadedModule.moduleFingerprint,
      actor: actorName,
      projectFingerprintBefore: project.fingerprint,
      projectFingerprintAfter: plan.projectedFingerprint,
      installedAt: new Date().toISOString(),
    })
    await mkdir(path.dirname(recordFile), { recursive: true })
    const temporaryRecord = `${recordFile}.tmp`
    await writeFile(temporaryRecord, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    await rename(temporaryRecord, recordFile)
    return {
      installed: true,
      module: moduleName,
      moduleVersion: loadedModule.moduleVersion,
      actor: actorName,
      projectFingerprintBefore: project.fingerprint,
      projectFingerprintAfter: plan.projectedFingerprint,
      files: plan.files.map(({ path: file }) => file),
      remoteMutation: false,
      businessRowsReturned: false,
    }
  } catch (error) {
    if (actorPatched && originalActorSource !== null) await writeFile(target.actorFile, originalActorSource)
    for (const file of created.reverse()) await rm(file, { force: true })
    throw error
  }
}

async function moduleRecords(root) {
  try {
    const record = JSON.parse(await readFile(path.join(root, '.lacify', 'modules.json'), 'utf8'))
    if (record.version !== 1 || !Array.isArray(record.installations)) throw new Error('Installed module record has an invalid contract.')
    return record
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, installations: [] }
    throw error
  }
}

async function moduleVersions(name) {
  const versions = new Set()
  const latest = await loadModule(name)
  versions.add(latest.moduleVersion)
  try {
    for (const entry of await readdir(path.join(modulesRoot, name, 'versions'), { withFileTypes: true })) {
      if (entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name)) versions.add(entry.name)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return [...versions].sort()
}

async function resolveInstalledModule(record) {
  const latest = await loadModule(record.module)
  if (record.moduleVersion) {
    const candidate = record.moduleVersion === latest.moduleVersion ? latest : await loadModule(record.module, record.moduleVersion)
    if (candidate.moduleFingerprint === record.moduleFingerprint) return candidate
  }
  for (const version of await moduleVersions(record.module)) {
    const candidate = version === latest.moduleVersion ? latest : await loadModule(record.module, version)
    if (candidate.moduleFingerprint === record.moduleFingerprint) return candidate
  }
  if (latest.moduleFingerprint === record.moduleFingerprint) return latest
  return null
}

async function inspectInstallation(root, project, record) {
  const actor = project.project.actors.find(({ definition }) => definition.name === record.actor)
  const installed = await resolveInstalledModule(record)
  let latest
  try { latest = await loadModule(record.module) } catch { latest = null }
  if (!actor || !installed || !latest) {
    return {
      module: record.module,
      actor: record.actor,
      installedVersion: installed?.moduleVersion || record.moduleVersion || null,
      latestVersion: latest?.moduleVersion || null,
      state: 'unresolved',
      customizedFiles: [],
      missingActorEntries: [],
    }
  }
  const target = actorTarget(root, actor)
  const customizedFiles = []
  for (const file of installed.files) {
    const destination = destinationFor(root, target.actorRoot, file.target)
    const expected = materializedContents(file, actor.definition.name)
    let current = null
    try { current = await readFile(destination, 'utf8') } catch {}
    if (current === null || fingerprint(current) !== fingerprint(expected)) customizedFiles.push(path.relative(root, destination).split(path.sep).join('/'))
  }
  const missingActorEntries = [
    ...installed.manifest.actorPatch.commands.filter((entry) => !actor.definition.commands.includes(entry)).map((entry) => `command:${entry}`),
    ...installed.manifest.actorPatch.operations.filter((entry) => !(actor.definition.operations || []).includes(entry)).map((entry) => `operation:${entry}`),
  ]
  const updateAvailable = installed.moduleFingerprint !== latest.moduleFingerprint
  return {
    module: record.module,
    actor: record.actor,
    installedVersion: installed.moduleVersion,
    latestVersion: latest.moduleVersion,
    installedFingerprint: installed.moduleFingerprint,
    latestFingerprint: latest.moduleFingerprint,
    state: customizedFiles.length || missingActorEntries.length ? 'customized' : updateAvailable ? 'update-available' : 'current',
    customizedFiles,
    missingActorEntries,
    projectFingerprintAtInstall: record.projectFingerprintAfter,
  }
}

export async function moduleStatus({ root, project }) {
  const records = await moduleRecords(root)
  const latestByTarget = new Map()
  for (const record of records.installations) latestByTarget.set(`${record.module}:${record.actor}`, record)
  const modules = []
  for (const record of latestByTarget.values()) modules.push(await inspectInstallation(root, project, record))
  return {
    project: project.project.runtime.project,
    projectFingerprint: project.fingerprint,
    modules,
    remoteMutation: false,
    businessRowsReturned: false,
  }
}

export async function moduleCompositionMetadata({ root, project }) {
  const records = await moduleRecords(root)
  const latestByTarget = new Map()
  for (const record of records.installations) latestByTarget.set(`${record.module}:${record.actor}`, record)
  const modules = []
  for (const record of latestByTarget.values()) {
    const status = await inspectInstallation(root, project, record)
    const installed = await resolveInstalledModule(record)
    const actor = project.project.actors.find(({ definition }) => definition.name === record.actor)
    if (!installed || !actor) {
      modules.push({
        module: record.module,
        actor: record.actor,
        version: status.installedVersion,
        fingerprint: record.moduleFingerprint,
        state: status.state,
        actorPatch: null,
        files: [],
      })
      continue
    }
    const target = actorTarget(root, actor)
    const files = installed.files
      .filter(({ target: fileTarget }) => !fileTarget.startsWith('project/tests/'))
      .map(({ target: fileTarget }) => path.relative(root, destinationFor(root, target.actorRoot, fileTarget)).split(path.sep).join('/'))
      .sort()
    modules.push({
      module: record.module,
      actor: record.actor,
      version: installed.moduleVersion,
      fingerprint: installed.moduleFingerprint,
      state: status.state,
      actorPatch: installed.manifest.actorPatch,
      files,
    })
  }
  return modules.sort((left, right) => `${left.actor}:${left.module}`.localeCompare(`${right.actor}:${right.module}`))
}

export async function planModuleUpgrade({ root, project, moduleName, actorName }) {
  const records = await moduleRecords(root)
  const record = [...records.installations].reverse().find((entry) => entry.module === moduleName && entry.actor === actorName)
  if (!record) throw new Error(`Module "${moduleName}" is not recorded as installed on Actor "${actorName}".`)
  const status = await inspectInstallation(root, project, record)
  const issues = []
  if (status.state === 'unresolved') issues.push({ code: 'baseline_unresolved', message: 'Installed module baseline cannot be resolved.' })
  if (status.state === 'customized') {
    issues.push({ code: 'customized_installation', message: 'Installed module files or Actor entries were customized; perform an explicit manual merge.' })
  }
  if (status.state === 'current') issues.push({ code: 'already_current', message: 'Installed module already matches the latest version.' })
  if (issues.length) {
    return {
      valid: false,
      module: moduleName,
      actor: actorName,
      installedVersion: status.installedVersion,
      latestVersion: status.latestVersion,
      diagnostics: issues,
      customizedFiles: status.customizedFiles,
      remoteMutation: false,
      businessRowsReturned: false,
    }
  }

  const installed = await resolveInstalledModule(record)
  const latest = await loadModule(moduleName)
  const actor = project.project.actors.find(({ definition }) => definition.name === actorName)
  const installedTargets = new Map(installed.files.map((file) => [file.target, file]))
  const additions = []
  for (const file of latest.files) {
    const previous = installedTargets.get(file.target)
    if (!previous) additions.push(file)
    else if (fingerprint(materializedContents(previous, actorName)) !== fingerprint(materializedContents(file, actorName))) {
      issues.push({ code: 'non_additive_file_change', message: `Latest module changes existing file target "${file.target}"; automatic upgrade is blocked.` })
    }
  }
  for (const previous of installed.files) if (!latest.files.some(({ target }) => target === previous.target)) issues.push({ code: 'removed_file', message: `Latest module removes existing file target "${previous.target}".` })
  const actorPatch = {
    commands: latest.manifest.actorPatch.commands.filter((entry) => !installed.manifest.actorPatch.commands.includes(entry)),
    operations: latest.manifest.actorPatch.operations.filter((entry) => !installed.manifest.actorPatch.operations.includes(entry)),
  }
  for (const command of actorPatch.commands) if (actor.definition.commands.includes(command)) issues.push({ code: 'command_conflict', message: `Command "${command}" already exists outside the installed baseline.` })
  for (const operation of actorPatch.operations) if ((actor.definition.operations || []).includes(operation)) issues.push({ code: 'operation_conflict', message: `Operation "${operation}" already exists outside the installed baseline.` })
  const target = actorTarget(root, actor)
  const contentsByTarget = new Map()
  const files = []
  for (const file of additions) {
    const contents = materializedContents(file, actorName)
    contentsByTarget.set(file.target, contents)
    const destination = destinationFor(root, target.actorRoot, file.target)
    if (await fileExists(destination)) issues.push({ code: 'file_conflict', message: `${path.relative(root, destination)} already exists.` })
    files.push({ path: path.relative(root, destination).split(path.sep).join('/'), bytes: Buffer.byteLength(contents), hash: fingerprint(contents) })
  }
  let projectedFingerprint = null
  if (!issues.length) {
    const staged = await stageAndValidate({
      root,
      actor,
      loadedModule: { files: additions, manifest: { actorPatch } },
      contentsByTarget,
    })
    issues.push(...staged.diagnostics)
    projectedFingerprint = staged.projectedFingerprint
  }
  const binding = {
    projectFingerprint: project.fingerprint,
    module: moduleName,
    actor: actorName,
    installedVersion: installed.moduleVersion,
    installedFingerprint: installed.moduleFingerprint,
    latestVersion: latest.moduleVersion,
    latestFingerprint: latest.moduleFingerprint,
    actorPatch,
    files,
    projectedFingerprint,
  }
  return {
    valid: issues.length === 0,
    planId: `module_upgrade_${fingerprint(binding).slice(0, 40)}`,
    module: moduleName,
    actor: actorName,
    installedVersion: installed.moduleVersion,
    latestVersion: latest.moduleVersion,
    projectFingerprint: project.fingerprint,
    projectedFingerprint,
    actorPatch,
    files,
    diagnostics: issues.slice(0, 100),
    remoteMutation: false,
    businessRowsReturned: false,
    binding,
  }
}

export async function upgradeModule({ root, project, moduleName, actorName, planId }) {
  const plan = await planModuleUpgrade({ root, project, moduleName, actorName })
  if (!plan.valid) throw Object.assign(new Error('Module upgrade is blocked by customization, conflicts, or validation errors.'), { diagnostics: plan.diagnostics })
  if (plan.planId !== planId) throw new Error('Module upgrade replay blocked because the repository, baseline, latest module, or projected files changed.')
  const records = await moduleRecords(root)
  const record = [...records.installations].reverse().find((entry) => entry.module === moduleName && entry.actor === actorName)
  const installed = await resolveInstalledModule(record)
  const latest = await loadModule(moduleName)
  const actor = project.project.actors.find(({ definition }) => definition.name === actorName)
  const installedTargets = new Set(installed.files.map(({ target }) => target))
  const additions = latest.files.filter(({ target }) => !installedTargets.has(target))
  const actorPatch = {
    commands: latest.manifest.actorPatch.commands.filter((entry) => !installed.manifest.actorPatch.commands.includes(entry)),
    operations: latest.manifest.actorPatch.operations.filter((entry) => !installed.manifest.actorPatch.operations.includes(entry)),
  }
  const target = actorTarget(root, actor)
  const created = []
  let originalActorSource = null
  let actorPatched = false
  try {
    for (const file of additions) {
      const destination = destinationFor(root, target.actorRoot, file.target)
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, materializedContents(file, actorName), { flag: 'wx' })
      created.push(destination)
    }
    originalActorSource = await readFile(target.actorFile, 'utf8')
    await writeFile(target.actorFile, patchedActorYaml(originalActorSource, actorPatch))
    actorPatched = true
    records.installations.push({
      module: moduleName,
      moduleVersion: latest.moduleVersion,
      moduleFingerprint: latest.moduleFingerprint,
      actor: actorName,
      upgradedFrom: installed.moduleVersion,
      projectFingerprintBefore: project.fingerprint,
      projectFingerprintAfter: plan.projectedFingerprint,
      installedAt: new Date().toISOString(),
    })
    const recordFile = path.join(root, '.lacify', 'modules.json')
    const temporaryRecord = `${recordFile}.tmp`
    await writeFile(temporaryRecord, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 })
    await rename(temporaryRecord, recordFile)
    return {
      upgraded: true,
      module: moduleName,
      actor: actorName,
      fromVersion: installed.moduleVersion,
      toVersion: latest.moduleVersion,
      projectFingerprintBefore: project.fingerprint,
      projectFingerprintAfter: plan.projectedFingerprint,
      files: plan.files.map(({ path: file }) => file),
      remoteMutation: false,
      businessRowsReturned: false,
    }
  } catch (error) {
    if (actorPatched && originalActorSource !== null) await writeFile(target.actorFile, originalActorSource)
    for (const file of created.reverse()) await rm(file, { force: true })
    throw error
  }
}
