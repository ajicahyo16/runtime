import { createLacifyServerClient, type LacifyServerEnvironment } from '../generated/lacify/server.js'

export interface CreatePersonalProject {
  projectId: string
  name: string
  description: string
}

export function createProjectStore(environment: LacifyServerEnvironment, fetchImpl: typeof fetch = fetch) {
  const lacify = createLacifyServerClient(environment, fetchImpl)
  return {
    create(workspaceId: string, input: CreatePersonalProject, idempotencyKey: string) {
      return lacify.workspace(workspaceId).createProject(input, { idempotencyKey })
    },
    get(workspaceId: string, projectId: string) {
      return lacify.workspace(workspaceId).getProject({ projectId })
    },
    list(workspaceId: string, pageSize = 25, cursor: string | null = null) {
      return lacify.workspace(workspaceId).listProjects({}, { pageSize, cursor })
    },
  }
}
