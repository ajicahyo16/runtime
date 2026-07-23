import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { runCli } from '../src/cli.mjs'

function capture() {
  let stdout = ''
  return { io: { stdout: { write: (value) => { stdout += value } } }, value: () => stdout }
}

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
