import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { runCli } from '../src/cli.mjs'

function capture() {
  let stdout = ''
  return { io: { stdout: { write: (value) => { stdout += value } } }, value: () => stdout }
}

test('CLI help exposes the golden Development path', async () => {
  const stream = capture()
  assert.equal(await runCli(['--help', '--json'], stream.io), 0)
  const result = JSON.parse(stream.value())
  assert.equal(result.goldenPath, 'lacify ship development --review <review-id> --approve')
  assert.ok(result.commands.includes('sync'))
  assert.ok(result.commands.includes('ship'))

  const commandHelp = capture()
  assert.equal(await runCli(['ship', '--help', '--json'], commandHelp.io), 0)
  assert.match(JSON.parse(commandHelp.value()).usage, /ship development/)
})

test('CLI initializes, validates, plans, applies, reports status, migrations, and health', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-cli-'))
  for (const [command, args = []] of [
    ['init', ['--project', 'personal-test']],
    ['validate'],
    ['plan', ['--env', 'development']],
    ['apply', ['--env', 'development', '--approve']],
    ['status'],
    ['migrations'],
    ['health'],
  ]) {
    const stream = capture()
    assert.equal(await runCli([command, ...args, '--json'], stream.io, root), 0)
    assert.doesNotThrow(() => JSON.parse(stream.value()))
  }
  const lock = JSON.parse(await readFile(path.join(root, '.lacify', 'lock.json'), 'utf8'))
  assert.match(lock.projectFingerprint, /^[a-f0-9]{64}$/)
})

test('realtime validate and plan are deterministic and read-only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-realtime-cli-'))
  await mkdir(path.join(root, 'rooms'))
  await writeFile(path.join(root, 'lacify.realtime.yaml'), 'version: lacify.dev/realtime/v1\nproject: realtime-cli\nruntime: realtime\nrooms:\n  - ./rooms/chat.room.yaml\n')
  await writeFile(path.join(root, 'rooms', 'chat.room.yaml'), 'version: lacify.dev/room/v1\nname: Chat\npartitionBy: roomId\ncapabilities:\n  - events\n  - presence\n  - history\nstorage: sqlite\nretention:\n  historySeconds: 86400\n  maxEvents: 100000\nlimits:\n  maxFrameBytes: 65536\n  maxConnections: 1000\n  maxPresenceBytes: 4096\n  maxDocumentUpdateBytes: 262144\nbudget:\n  maxPersistentEventsPerUtcDay: 50000\nauth:\n  mode: token\n  allowedOrigins:\n    - https://app.example.com\n')
  const validated = capture()
  assert.equal(await runCli(['realtime', 'validate', '--json'], validated.io, root), 0)
  const planned = capture()
  assert.equal(await runCli(['realtime', 'plan', '--json'], planned.io, root), 0)
  assert.equal(JSON.parse(validated.value()).fingerprint, JSON.parse(planned.value()).fingerprint)
  assert.equal(JSON.parse(planned.value()).remoteMutation, false)
})

test('plan is read-only and apply requires explicit approval', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-cli-'))
  await runCli(['init'], capture().io, root)
  await runCli(['plan'], capture().io, root)
  const before = JSON.parse(await readFile(path.join(root, '.lacify', 'lock.json'), 'utf8'))
  assert.equal(before.projectFingerprint, null)
  await assert.rejects(() => runCli(['apply'], capture().io, root), /Explicit approval/)
})

test('status detects repository drift after an applied file changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-cli-'))
  await runCli(['init'], capture().io, root)
  await runCli(['apply', '--approve'], capture().io, root)
  const actorFile = path.join(root, 'actors', 'aggregate', 'actor.yaml')
  await writeFile(actorFile, `${await readFile(actorFile, 'utf8')}description: Changed locally\n`)
  const stream = capture()
  await runCli(['status', '--json'], stream.io, root)
  assert.equal(JSON.parse(stream.value()).drift, 'repository-changed')
})

test('apply rejects Staging and Production', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-cli-'))
  await runCli(['init'], capture().io, root)
  await assert.rejects(() => runCli(['apply', '--env', 'production', '--approve'], capture().io, root), /restricted to Development/)
})

test('personal template initializes an executable project and MCP config without secrets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-personal-'))
  const initialized = capture()
  assert.equal(await runCli(['init', '--project', 'my-private-platform', '--template', 'personal', '--json'], initialized.io, root), 0)
  assert.equal(JSON.parse(initialized.value()).template, 'personal')

  for (const command of ['validate', 'test', 'generate']) {
    const stream = capture()
    assert.equal(await runCli([command, '--json'], stream.io, root), 0)
  }

  const config = capture()
  assert.equal(await runCli(['mcp-config', '--json'], config.io, root), 0)
  const parsed = JSON.parse(config.value())
  assert.equal(parsed.mcpServers.lacify.cwd, root)
  assert.equal(parsed.mcpServers.lacify.env.LACIFY_MCP_ROLE, 'developer')
  assert.equal(parsed.mcpServers.lacify.env.LACIFY_RUNTIME_APPLICATION_TOKEN, '${LACIFY_RUNTIME_APPLICATION_TOKEN}')
  assert.equal(JSON.stringify(parsed).includes('lacify_runtime_'), false)
})

test('review receipt binds source files, tests, and migration plans before Development apply', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-review-'))
  await runCli(['init', '--project', 'reviewed-project', '--template', 'personal'], capture().io, root)
  const reviewed = capture()
  assert.equal(await runCli(['review', '--json'], reviewed.io, root), 0)
  const result = JSON.parse(reviewed.value())
  assert.equal(result.reviewed, true)
  assert.match(result.receipt.reviewId, /^review_[a-f0-9]{40}$/)
  assert.equal(result.receipt.version, 'lacify.dev/review/v2')
  assert.equal(result.receipt.tests.passed, true)
  assert.equal(result.receipt.sourceFiles.some(({ path: file }) => file.endsWith('.sql')), true)
  assert.equal(JSON.stringify(result.receipt).includes('INSERT INTO notes'), false)
  assert.equal(JSON.stringify(result.receipt).includes('CREATE TABLE'), false)

  const applied = capture()
  assert.equal(await runCli(['apply-review', '--review', result.receipt.reviewId, '--approve', '--json'], applied.io, root), 0)
  assert.equal(JSON.parse(applied.value()).reviewedBy, result.receipt.reviewId)
})

test('a no-op reviewed apply preserves the existing Development revision', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-noop-apply-'))
  await runCli(['init', '--project', 'noop-project', '--template', 'personal'], capture().io, root)
  const firstReview = capture()
  await runCli(['review', '--json'], firstReview.io, root)
  await runCli(['apply-review', '--review', JSON.parse(firstReview.value()).receipt.reviewId, '--approve'], capture().io, root)
  const firstLock = JSON.parse(await readFile(path.join(root, '.lacify', 'lock.json'), 'utf8'))

  const secondReview = capture()
  await runCli(['review', '--json'], secondReview.io, root)
  await runCli(['apply-review', '--review', JSON.parse(secondReview.value()).receipt.reviewId, '--approve'], capture().io, root)
  const secondLock = JSON.parse(await readFile(path.join(root, '.lacify', 'lock.json'), 'utf8'))

  assert.equal(secondLock.environments.development.revision, firstLock.environments.development.revision)
})

test('sync publishes an approved source without compiling or deploying a release', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-sync-'))
  await runCli(['init', '--project', 'sync-project', '--template', 'personal'], capture().io, root)
  const reviewed = capture()
  await runCli(['review', '--json'], reviewed.io, root)
  const reviewId = JSON.parse(reviewed.value()).receipt.reviewId
  const calls = []
  const remoteClient = async () => ({
    request: async (route, init = {}) => {
      calls.push([route, init.method || 'GET'])
      if (route === '/api/projects') return { projects: [{ id: 'sync-project', source_fingerprint: 'f'.repeat(64) }] }
      if (route.endsWith('/contracts')) return { contracts: [] }
      if (route.endsWith('/environments')) return { environments: { dev: { updatedAt: 1 } } }
      return { success: true }
    },
  })
  const synced = capture()
  assert.equal(await runCli(['sync', '--review', reviewId, '--approve', '--json'], synced.io, root, { remoteClient }), 0)
  const result = JSON.parse(synced.value())
  assert.equal(result.remote.synced, true)
  assert.equal(result.remote.release, undefined)
  assert.ok(calls.some(([route, method]) => route.endsWith('/repository-source') && method === 'PUT'))
  assert.equal(calls.some(([route, method]) => route.endsWith('/releases') && method === 'POST'), false)
})

test('sync binds updates to the current remote fingerprint instead of a stale local base', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-sync-base-'))
  await runCli(['init', '--project', 'sync-base-project', '--template', 'personal'], capture().io, root)
  const reviewed = capture()
  await runCli(['review', '--json'], reviewed.io, root)
  const reviewId = JSON.parse(reviewed.value()).receipt.reviewId
  const staleRemoteFingerprint = 'a'.repeat(64)
  const requests = []
  const remoteClient = async () => ({
    request: async (route, init = {}) => {
      requests.push([route, init])
      if (route === '/api/projects') return { projects: [{ id: 'sync-base-project', source_fingerprint: staleRemoteFingerprint }] }
      if (route.endsWith('/contracts')) return { contracts: [] }
      if (route.endsWith('/environments')) return { environments: { dev: { updatedAt: 1 } } }
      return { success: true }
    },
  })
  assert.equal(await runCli(['sync', '--review', reviewId, '--approve'], capture().io, root, { remoteClient }), 0)
  const contractUpdates = requests.filter(([route, init]) => route.includes('/contracts/') && init.method === 'PUT')
  assert.ok(contractUpdates.length > 0)
  assert.ok(contractUpdates.every(([, init]) => init.headers['x-lacify-base-fingerprint'] === staleRemoteFingerprint))
  const sourceUpdate = requests.find(([route, init]) => route.endsWith('/repository-source') && init.method === 'PUT')
  assert.equal(JSON.parse(sourceUpdate[1].body).baseFingerprint, staleRemoteFingerprint)
})

test('remote status is not ready when source or Development deployment is stale', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-remote-status-'))
  await runCli(['init', '--project', 'status-project'], capture().io, root)
  await runCli(['apply', '--approve'], capture().io, root)
  const remoteClient = async () => ({
    request: async (route) => {
      if (route === '/api/projects') return { projects: [{ id: 'status-project', source_fingerprint: '0'.repeat(64) }] }
      if (route.endsWith('/releases')) return { releases: [] }
      throw new Error(`Unexpected route ${route}`)
    },
  })
  const stream = capture()
  assert.equal(await runCli(['status', '--remote', '--json'], stream.io, root, { remoteClient }), 2)
  const result = JSON.parse(stream.value())
  assert.equal(result.ready, false)
  assert.equal(result.remote.sourceSynced, false)
  assert.equal(result.remote.deploymentCurrent, false)
})

test('reviewed apply blocks changed repository files and stale receipt replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-review-stale-'))
  await runCli(['init', '--project', 'reviewed-project', '--template', 'personal'], capture().io, root)
  const reviewed = capture()
  await runCli(['review', '--json'], reviewed.io, root)
  const reviewId = JSON.parse(reviewed.value()).receipt.reviewId
  const actorFile = path.join(root, 'actors', 'workspace', 'actor.yaml')
  await writeFile(actorFile, (await readFile(actorFile, 'utf8')).replace('Owns private notes for one personal workspace.', 'Changed after review.'))
  await assert.rejects(
    () => runCli(['apply-review', '--review', reviewId, '--approve'], capture().io, root),
    /Review replay blocked/,
  )
})

test('integrate and doctor produce a secret-free trusted backend readiness workflow', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-integration-'))
  await runCli(['init', '--project', 'integrated-project', '--template', 'personal'], capture().io, root)
  const before = capture()
  assert.equal(await runCli(['doctor', '--json'], before.io, root), 2)
  assert.ok(JSON.parse(before.value()).checks.some(({ id, status }) => id === 'server-integration' && status === 'fail'))

  const integrated = capture()
  assert.equal(await runCli(['integrate', '--json'], integrated.io, root), 0)
  const integration = JSON.parse(integrated.value())
  assert.equal(integration.integrated, true)
  const manifest = JSON.parse(await readFile(path.join(root, '.lacify', 'integration.json'), 'utf8'))
  assert.equal(manifest.requiredEnvironment.find(({ name }) => name === 'LACIFY_RUNTIME_TOKEN').secret, true)
  assert.equal(JSON.stringify(manifest).includes('lacify_runtime_'), false)

  const reviewed = capture()
  await runCli(['review', '--json'], reviewed.io, root)
  const reviewId = JSON.parse(reviewed.value()).receipt.reviewId
  await runCli(['apply-review', '--review', reviewId, '--approve'], capture().io, root)

  const environment = {
    LACIFY_RUNTIME_URL: 'http://127.0.0.1:8788',
    LACIFY_RUNTIME_TOKEN: `lacify_runtime_${'x'.repeat(43)}`,
  }
  const ready = capture()
  assert.equal(await runCli(['doctor', '--json'], ready.io, root, { environment }), 0)
  const report = JSON.parse(ready.value())
  assert.equal(report.ready, true)
  assert.equal(report.secretsReturned, false)
  assert.equal(JSON.stringify(report).includes(environment.LACIFY_RUNTIME_TOKEN), false)
})

test('logout revokes the remote token before deleting protected local authentication', async () => {
  const calls = []
  const stream = capture()
  assert.equal(await runCli(['logout', '--json'], stream.io, process.cwd(), {
    remoteClient: async () => ({ profile: { account: 'user@example.com' }, request: async (...args) => calls.push(['remote', ...args]) }),
    deleteCredential: async (account) => calls.push(['credential', account]),
    deleteCliProfile: async () => calls.push(['profile']),
  }), 0)
  assert.deepEqual(calls, [
    ['remote', '/api/cli/token', { method: 'DELETE' }],
    ['credential', 'user@example.com'],
    ['profile'],
  ])
})
