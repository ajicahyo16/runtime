import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { compileRelease } from '../control-plane/src/compiler.ts'
import { canonicalProjectToContracts } from '../runtime-spec/src/control-plane-contracts.mjs'
import { fingerprint, loadRuntimeProject } from '../runtime-spec/src/index.mjs'
import { compileRealtimeRelease } from '../runtime-spec/src/realtime-compiler.mjs'
import { loadRealtimeProject } from '../runtime-spec/src/realtime-spec.mjs'

const projectId = 'qualification-staging'
const outputRoot = path.resolve(process.cwd(), '.lacify/staging-qualification')

function stagingWrangler(source) {
  const config = JSON.parse(source)
  config.workers_dev = true
  config.vars = { ...(config.vars || {}), LACIFY_ENVIRONMENT: 'staging' }
  delete config.limits
  return `${JSON.stringify(config, null, 2)}\n`
}

async function writeArtifacts(directory, artifact) {
  await mkdir(directory, { recursive: true })
  for (const [name, source] of Object.entries(artifact)) {
    const output = name.startsWith('wrangler') ? stagingWrangler(source) : source
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true })
    await writeFile(path.join(directory, name), output)
  }
}

const requestResponse = await loadRuntimeProject(new URL('../runtime-spec/fixtures/pos/lacify.runtime.yaml', import.meta.url))
if (!requestResponse.valid) throw new Error(`Request-response qualification fixture is invalid: ${JSON.stringify(requestResponse.issues)}`)
const contracts = canonicalProjectToContracts(requestResponse)
const runtimeRelease = await compileRelease(projectId, contracts)

const realtime = await loadRealtimeProject(new URL('../runtime-spec/fixtures/realtime/lacify.realtime.yaml', import.meta.url))
if (!realtime.valid) throw new Error(`Realtime qualification fixture is invalid: ${JSON.stringify(realtime.issues)}`)
realtime.project.realtime.project = projectId
realtime.project.rooms[0].source = '/qualification/store.room.yaml'
realtime.project.rooms[0].definition = {
  ...realtime.project.rooms[0].definition,
  name: 'Store',
  events: [
    { name: 'OrderPlaced', durability: 'segmented', batchSize: 10, retryFlushMs: 1000 },
    { name: 'PaymentConfirmed', durability: 'immediate' },
    { name: 'TypingChanged', durability: 'ephemeral' },
  ],
}
realtime.fingerprint = fingerprint(realtime.project)
const realtimeRelease = await compileRealtimeRelease(realtime)

const runtimeDirectory = path.join(outputRoot, 'runtime')
const realtimeDirectory = path.join(outputRoot, 'realtime')
await writeArtifacts(runtimeDirectory, runtimeRelease.artifact)
await writeArtifacts(realtimeDirectory, realtimeRelease.artifact)

const manifest = {
  format: 'lacify-staging-qualification/v1',
  project: projectId,
  environment: 'staging',
  remoteMutation: false,
  runtimeChecksum: runtimeRelease.checksum,
  realtimeChecksum: realtimeRelease.checksum,
  deploymentOrder: [
    { component: 'realtime', config: 'realtime/wrangler.jsonc', service: `lacify-realtime-${projectId}` },
    { component: 'reporting', config: 'runtime/wrangler.reporting.jsonc', service: `lacify-${projectId}-reporting` },
    { component: 'event-router', config: 'runtime/wrangler.event-router.jsonc', service: `lacify-${projectId}-event-router` },
    { component: 'runtime', config: 'runtime/wrangler.jsonc', service: `lacify-${projectId}` },
  ],
  buckets: [`lacify-realtime-${projectId}-history`],
  secretValuesIncluded: false,
  productionResourcesReferenced: false,
}
await writeFile(path.join(outputRoot, 'qualification.json'), `${JSON.stringify(manifest, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ success: true, outputRoot, manifest }, null, 2)}\n`)
