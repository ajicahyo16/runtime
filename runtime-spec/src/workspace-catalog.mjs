import { access, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { dump, load } from 'js-yaml'
import { loadRuntimeProject } from './index.mjs'
import { moduleStatus } from './module-system.mjs'

const workspaceNamePattern = /^[a-z0-9][a-z0-9-_]{0,62}$/

async function exists(file) {
  try { await access(file); return true } catch { return false }
}

function manifestPath(root) {
  return path.join(root, 'lacify.workspace.yaml')
}

function validateManifest(value) {
  if (!value || value.version !== 'lacify.dev/workspace/v1' || typeof value.name !== 'string' || !workspaceNamePattern.test(value.name) || !Array.isArray(value.projects)) {
    throw new Error('Workspace manifest contract is invalid.')
  }
  if (Object.keys(value).some((key) => !['version', 'name', 'projects'].includes(key))) throw new Error('Workspace manifest contains an unknown field.')
  if (value.projects.length > 128) throw new Error('Workspace supports at most 128 projects.')
  const paths = new Set()
  for (const entry of value.projects) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length < 1 || entry.path.length > 512 || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes('..')) {
      throw new Error('Workspace project paths must be bounded relative paths without traversal.')
    }
    if (Object.keys(entry).some((key) => key !== 'path')) throw new Error('Workspace project entry contains an unknown field.')
    if (paths.has(entry.path)) throw new Error(`Workspace project path "${entry.path}" is duplicated.`)
    paths.add(entry.path)
  }
}

async function saveManifest(root, manifest) {
  validateManifest(manifest)
  const file = manifestPath(root)
  const temporary = `${file}.tmp`
  await writeFile(temporary, dump(manifest, { noRefs: true, lineWidth: -1, sortKeys: false }), { mode: 0o600 })
  await rename(temporary, file)
  return file
}

export async function initializeWorkspace(root, name) {
  if (!workspaceNamePattern.test(name)) throw new Error('Workspace name must use lowercase letters, numbers, hyphens, or underscores.')
  const file = manifestPath(root)
  if (await exists(file)) throw new Error('lacify.workspace.yaml already exists; workspace-init will not overwrite it.')
  await mkdir(root, { recursive: true })
  await saveManifest(root, { version: 'lacify.dev/workspace/v1', name, projects: [] })
  return { initialized: true, name, root, file }
}

export async function loadWorkspace(root) {
  let manifest
  try { manifest = load(await readFile(manifestPath(root), 'utf8')) } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('lacify.workspace.yaml does not exist in the workspace root.')
    throw new Error('Workspace manifest is not valid YAML.')
  }
  validateManifest(manifest)
  return manifest
}

async function resolvedProject(root, relative) {
  const workspaceReal = await realpath(root)
  const absolute = await realpath(path.resolve(root, relative))
  const relation = path.relative(workspaceReal, absolute)
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) throw new Error('Workspace projects must be directories contained inside the workspace root.')
  const project = await loadRuntimeProject(path.join(absolute, 'lacify.runtime.yaml'))
  if (!project.valid) throw Object.assign(new Error(`Workspace project "${relative}" is invalid.`), { diagnostics: project.issues })
  return { absolute, relative: relation.split(path.sep).join('/'), project }
}

export async function addWorkspaceProject(root, projectPath) {
  const manifest = await loadWorkspace(root)
  const candidate = await resolvedProject(root, projectPath)
  const existing = []
  for (const entry of manifest.projects) existing.push(await resolvedProject(root, entry.path))
  const projectId = candidate.project.project.runtime.project
  if (existing.some(({ absolute }) => absolute === candidate.absolute)) throw new Error('Workspace already contains this project path.')
  if (existing.some(({ project }) => project.project.runtime.project === projectId)) throw new Error(`Workspace already contains project ID "${projectId}".`)
  manifest.projects.push({ path: candidate.relative })
  manifest.projects.sort((a, b) => a.path.localeCompare(b.path))
  await saveManifest(root, manifest)
  return {
    added: true,
    workspace: manifest.name,
    project: projectId,
    fingerprint: candidate.project.fingerprint,
    path: candidate.relative,
  }
}

export async function workspaceProjects(root) {
  const manifest = await loadWorkspace(root)
  const projects = []
  const ids = new Set()
  for (const entry of manifest.projects) {
    const candidate = await resolvedProject(root, entry.path)
    const id = candidate.project.project.runtime.project
    if (ids.has(id)) throw new Error(`Workspace contains duplicate project ID "${id}".`)
    ids.add(id)
    projects.push({
      id,
      path: candidate.relative,
      root: candidate.absolute,
      fingerprint: candidate.project.fingerprint,
      actors: candidate.project.project.actors.map(({ definition, operations }) => ({
        name: definition.name,
        partitionBy: definition.partitionBy,
        operations: operations.length,
      })),
      project: candidate.project,
    })
  }
  return { workspace: manifest.name, root: path.resolve(root), projects }
}

export async function workspaceModuleMatrix(root) {
  const catalog = await workspaceProjects(root)
  const rows = []
  for (const entry of catalog.projects) {
    const status = await moduleStatus({ root: entry.root, project: entry.project })
    if (!status.modules.length) rows.push({ project: entry.id, module: null, actor: null, installedVersion: null, latestVersion: null, state: 'none' })
    else for (const module of status.modules) rows.push({
      project: entry.id,
      module: module.module,
      actor: module.actor,
      installedVersion: module.installedVersion,
      latestVersion: module.latestVersion,
      state: module.state,
    })
  }
  return {
    workspace: catalog.workspace,
    projectCount: catalog.projects.length,
    rows,
    remoteMutation: false,
    businessRowsReturned: false,
  }
}

export async function selectWorkspaceProject(root, projectId) {
  const catalog = await workspaceProjects(root)
  const entry = catalog.projects.find(({ id }) => id === projectId)
  if (!entry) throw new Error(`Workspace project "${projectId}" does not exist.`)
  return entry
}
