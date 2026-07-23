import type { Actor } from '@/components/ActorCard'

const localStorageKey = (project: string) => `lacify-local-contracts:${project}`

export interface ProjectSummary {
  id: string
  name: string
  authoring_source?: 'visual' | 'repository'
  source_fingerprint?: string | null
  source_revision?: string | null
}

function readLocalContracts(project: string): Actor[] {
  try {
    const saved = localStorage.getItem(localStorageKey(project))
    const contracts = saved ? JSON.parse(saved) : []
    return Array.isArray(contracts) ? contracts : []
  } catch {
    return []
  }
}

function writeLocalContracts(project: string, contracts: Actor[]) {
  localStorage.setItem(localStorageKey(project), JSON.stringify(contracts))
}

function apiUnavailable(response: Response) {
  return response.status === 404 || response.status === 405 || response.status >= 500 || !response.headers.get('content-type')?.includes('application/json')
}

/**
 * The static sandbox has no Control API. Keep authoring usable there, while
 * deliberately limiting the fallback to browser-local draft data.
 */
export async function loadContracts(project: string): Promise<{ actors: Actor[]; source: 'api' | 'local' }> {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(project)}/contracts`)
    if (response.ok && !apiUnavailable(response)) {
      const data = await response.json()
      if (data.success && Array.isArray(data.contracts)) return { actors: data.contracts, source: 'api' }
      throw new Error(data.message || 'Could not load business objects.')
    }
    if (!apiUnavailable(response)) throw new Error(`Could not load business objects (${response.status}).`)
  } catch (error) {
    if (error instanceof Error && !/Failed to fetch|NetworkError/i.test(error.message) && !error.message.includes('404') && !error.message.includes('405')) {
      throw error
    }
  }

  // Do not call the legacy filesystem endpoint when the Control API is present.
  // A 404 here means the selected project is not owned by the current workspace,
  // not that the browser should switch API backends silently.
  return { actors: readLocalContracts(project), source: 'local' }
}

export async function saveContract(project: string, actor: Actor): Promise<'api' | 'local'> {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(project)}/contracts/${encodeURIComponent(actor.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(actor),
    })
    if (response.ok && !apiUnavailable(response)) return 'api'
    if (!apiUnavailable(response)) {
      const data = await response.json().catch(() => null)
      throw new Error(data?.message || `Could not save business object (${response.status}).`)
    }
  } catch (error) {
    if (error instanceof Error && !/Failed to fetch|NetworkError/i.test(error.message)) throw error
  }

  const contracts = readLocalContracts(project)
  const index = contracts.findIndex((contract) => contract.id === actor.id)
  if (index >= 0) contracts[index] = actor
  else contracts.push(actor)
  writeLocalContracts(project, contracts)
  return 'local'
}

export async function deleteContract(project: string, id: string): Promise<'api' | 'local'> {
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(project)}/contracts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
    if (response.ok && !apiUnavailable(response)) return 'api'
    if (!apiUnavailable(response)) throw new Error(`Could not delete business object (${response.status}).`)
  } catch (error) {
    if (error instanceof Error && !/Failed to fetch|NetworkError/i.test(error.message)) throw error
  }

  writeLocalContracts(project, readLocalContracts(project).filter((contract) => contract.id !== id))
  return 'local'
}

export async function loadProjects(): Promise<{ projects: ProjectSummary[]; source: 'api' | 'local' }> {
  try {
    const response = await fetch('/api/projects')
    if (response.ok && !apiUnavailable(response)) {
      const data = await response.json()
      if (data.success && Array.isArray(data.projects)) return { projects: data.projects, source: 'api' }
      throw new Error(data.message || 'Could not load projects.')
    }
  } catch (error) {
    if (error instanceof Error && !/Failed to fetch|NetworkError/i.test(error.message)) throw error
  }
  return { projects: [{ id: 'new-runtime', name: 'new-runtime' }], source: 'local' }
}
