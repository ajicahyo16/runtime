import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { remoteClient } from '../runtime-spec/src/remote-client.mjs'
import { LacifyClient } from '../examples/personal-project/.lacify/acceptance/client.js'

const projectId = 'personal-project-vault'
const releaseId = process.env.LACIFY_ACCEPTANCE_RELEASE_ID
if (!/^release_[a-f0-9]{24}$/.test(releaseId || '')) throw new Error('LACIFY_ACCEPTANCE_RELEASE_ID is required.')

const remote = await remoteClient()
const syntheticId = `acceptance-${Date.now().toString(36)}`
const primaryPartition = `phase11-${Date.now().toString(36)}`
const isolatedPartition = `${primaryPartition}-isolated`
const idempotencyKey = `phase11-${crypto.randomUUID()}`
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
let credentialId = null
let credentialRevoked = false

async function deployWithCurrentPolicy() {
  const result = await remote.request(`/api/projects/${projectId}/releases/${releaseId}/deployments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ environment: 'dev', redeploy: true }),
  })
  assert.equal(result.deployment?.status, 'succeeded')
  assert.match(result.deployment?.runtimeUrl || '', /^https:\/\/[a-z0-9-]+\.([a-z0-9-]+\.)?workers\.dev$/)
  return result.deployment
}

try {
  const issued = await remote.request(`/api/projects/${projectId}/runtime-credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `Phase 11 acceptance ${Date.now()}`,
      environment: 'dev',
      expiresInDays: 1,
      capabilities: [{
        actor: 'Workspace',
        operations: ['CreateProject', 'GetProject', 'ListProjects'],
        rateLimitPerMinute: 30,
        maxPayloadBytes: 32_768,
      }],
    }),
  })
  credentialId = issued.credential?.id
  const token = issued.credential?.token
  assert.match(credentialId || '', /^credential_/)
  assert.match(token || '', /^lacify_runtime_[A-Za-z0-9_-]{40,100}$/)

  const deployment = await deployWithCurrentPolicy()
  const runtimeUrl = deployment.runtimeUrl
  const unauthenticated = await fetch(`${runtimeUrl}/v1/workspaces/${primaryPartition}/queries/GetProject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { projectId: syntheticId } }),
  })
  assert.equal(unauthenticated.status, 401)

  const client = new LacifyClient(runtimeUrl, token)
  const workspace = client.workspace(primaryPartition)
  const input = {
    projectId: syntheticId,
    name: 'Phase 11 Acceptance',
    description: 'Synthetic live acceptance record',
  }
  const created = await workspace.createProject(input, { idempotencyKey })
  const replayed = await workspace.createProject(input, { idempotencyKey })
  const found = await workspace.getProject({ projectId: syntheticId })
  const isolated = await client.workspace(isolatedPartition).getProject({ projectId: syntheticId })
  const listed = await workspace.listProjects({}, { pageSize: 10 })

  assert.deepEqual(created.data, replayed.data)
  assert.equal(replayed.replayed, true)
  assert.equal(found.data?.id, syntheticId)
  assert.equal(isolated.data, null)
  assert.equal(listed.data.items.some((project) => project.id === syntheticId), true)
  assert.equal(listed.data.items.length <= 10, true)

  let telemetryObserved = false
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const overview = await remote.request(`/api/monitor-overview?project=${encodeURIComponent(projectId)}`)
    const actions = new Set((overview.events || []).map((event) => event.action))
    telemetryObserved = actions.has('CreateProject') && actions.has('GetProject') && actions.has('ListProjects')
    if (telemetryObserved) break
    await wait(1_000)
  }
  assert.equal(telemetryObserved, true)

  const evidence = {
    success: true,
    project: projectId,
    releaseId,
    deploymentId: deployment.id,
    runtimeUrl,
    generatedSdk: true,
    authenticationEnforced: true,
    idempotencyReplay: replayed.replayed === true,
    persistenceVerified: found.data?.id === syntheticId,
    partitionIsolationVerified: isolated.data === null,
    paginationVerified: listed.data.items.length <= 10,
    telemetryObserved,
    syntheticRecordHash: hash(found.data),
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
} finally {
  if (credentialId) {
    await remote.request(`/api/projects/${projectId}/runtime-credentials/${credentialId}`, { method: 'DELETE' })
    credentialRevoked = true
    await deployWithCurrentPolicy()
  }
  if (credentialId && !credentialRevoked) throw new Error('Temporary acceptance credential could not be revoked.')
}
