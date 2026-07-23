import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprint, stableStringify } from './index.mjs'
import { integrationManifest } from './integration-generator.mjs'
import { createReviewReceipt } from './review-receipt.mjs'
import { listLocalSnapshots, verifyLocalSnapshot } from './local-backup.mjs'
import { moduleStatus } from './module-system.mjs'

async function exists(file) {
  try { await access(file); return true } catch { return false }
}

function check(id, status, message) {
  return { id, status, message }
}

async function matchingReview(root, current) {
  const directory = path.join(root, '.lacify', 'reviews')
  let names
  try {
    names = (await readdir(directory)).filter((name) => /^review_[a-f0-9]{40}\.json$/.test(name)).slice(0, 1000)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  for (const name of names) {
    try {
      const receipt = JSON.parse(await readFile(path.join(directory, name), 'utf8'))
      if (
        (receipt.version === 'lacify.dev/review/v1' || receipt.version === 'lacify.dev/review/v2')
        && receipt.reviewId === `review_${fingerprint(receipt.binding).slice(0, 40)}`
        && receipt.projectFingerprint === current.projectFingerprint
        && receipt.sourceManifestFingerprint === current.sourceManifestFingerprint
        && receipt.binding?.projectFingerprint === current.projectFingerprint
        && receipt.binding?.sourceManifestFingerprint === current.sourceManifestFingerprint
        && receipt.tests?.passed === true
      ) return receipt.reviewId
    } catch {
      // Invalid receipts are ignored and never made authoritative by doctor.
    }
  }
  return null
}

function environmentCheck(environment) {
  const runtimeUrl = environment.LACIFY_RUNTIME_URL
  const token = environment.LACIFY_RUNTIME_TOKEN
  if (!runtimeUrl && !token) return check('server-environment', 'warning', 'Runtime URL and token are not present in this process; configure them in the application backend secret environment.')
  if (!runtimeUrl || !token) return check('server-environment', 'fail', 'Both LACIFY_RUNTIME_URL and LACIFY_RUNTIME_TOKEN must be configured together.')
  try {
    const parsed = new URL(runtimeUrl)
    const local = parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    if (parsed.protocol !== 'https:' && !local) return check('server-environment', 'fail', 'Runtime URL must use HTTPS except for localhost development.')
  } catch {
    return check('server-environment', 'fail', 'LACIFY_RUNTIME_URL is not a valid URL.')
  }
  if (!/^lacify_runtime_[A-Za-z0-9_-]{40,100}$/.test(token)) return check('server-environment', 'fail', 'LACIFY_RUNTIME_TOKEN is not a valid scoped runtime credential.')
  return check('server-environment', 'pass', 'Server-only runtime environment is configured; values were not read into the report.')
}

export async function diagnoseProject({ root, project, plans, tests, lock, environment = process.env, remote = null }) {
  const checks = [
    check('project-files', 'pass', `Validated ${project.project.actors.length} Actor(s) at fingerprint ${project.fingerprint.slice(0, 12)}.`),
    tests.passed === true
      ? check('operation-tests', 'pass', `${tests.tests.length} deterministic operation test(s) passed.`)
      : check('operation-tests', 'fail', 'Local operation tests did not pass.'),
    plans.every(({ valid }) => valid)
      ? check('migration-plan', 'pass', `${plans.reduce((sum, plan) => sum + plan.pending.length, 0)} pending Development migration(s); all plans are valid.`)
      : check('migration-plan', 'fail', 'At least one Development migration plan is blocked.'),
  ]

  const generatedClient = path.join(root, 'generated', 'lacify', 'client.ts')
  const generatedAdapter = path.join(root, 'generated', 'lacify', 'server.ts')
  const manifestFile = path.join(root, '.lacify', 'integration.json')
  const clientCurrent = await exists(generatedClient) && (await readFile(generatedClient, 'utf8')).includes(`project fingerprint ${project.fingerprint}`)
  const adapterCurrent = await exists(generatedAdapter) && (await readFile(generatedAdapter, 'utf8')).includes(`project fingerprint ${project.fingerprint}`)
  let manifestCurrent = false
  try {
    manifestCurrent = stableStringify(JSON.parse(await readFile(manifestFile, 'utf8'))) === stableStringify(integrationManifest(project))
  } catch {}
  checks.push(clientCurrent && adapterCurrent && manifestCurrent
    ? check('server-integration', 'pass', 'Generated client, trusted server adapter, and integration manifest match the project fingerprint.')
    : check('server-integration', 'fail', 'Run lacify integrate to generate a current client, trusted server adapter, and integration manifest.'))

  const currentReceipt = await createReviewReceipt({ root, project, plans, tests })
  const reviewId = await matchingReview(root, currentReceipt)
  checks.push(reviewId
    ? check('source-review', 'pass', `Canonical source matches saved review ${reviewId}.`)
    : check('source-review', 'fail', 'Run lacify review and inspect the exact repository source before apply.'))

  const applied = lock.environments?.development
  checks.push(applied?.fingerprint === project.fingerprint
    ? check('local-development', 'pass', `Local Development matches revision ${applied.revision}.`)
    : check('local-development', 'fail', 'Local Development does not match the current project fingerprint; apply an approved review.'))

  const mcpExecutable = fileURLToPath(new URL('../../bin/lacify-mcp.mjs', import.meta.url))
  checks.push(await exists(mcpExecutable)
    ? check('mcp-server', 'pass', 'Lacify MCP executable is available for this repository.')
    : check('mcp-server', 'fail', 'Lacify MCP executable is missing.'))
  checks.push(environmentCheck(environment))

  const installedModules = await moduleStatus({ root, project })
  const customizedModules = installedModules.modules.filter(({ state }) => state === 'customized' || state === 'unresolved')
  const moduleUpdates = installedModules.modules.filter(({ state }) => state === 'update-available')
  checks.push(customizedModules.length
    ? check('module-integrity', 'fail', `${customizedModules.length} installed module target(s) require manual baseline recovery or merge.`)
    : moduleUpdates.length
      ? check('module-integrity', 'warning', `${moduleUpdates.length} additive module update(s) are available.`)
      : installedModules.modules.length
        ? check('module-integrity', 'pass', `${installedModules.modules.length} installed module target(s) match their current baselines.`)
        : check('module-integrity', 'warning', 'No reusable modules are installed.'))

  const snapshots = await listLocalSnapshots(root)
  const latestSnapshot = snapshots.find((snapshot) => snapshot.valid !== false && snapshot.projectFingerprint === project.fingerprint)
  if (!latestSnapshot) {
    checks.push(check('local-recovery', 'warning', 'No local snapshot matches the current project fingerprint.'))
  } else {
    const verified = await verifyLocalSnapshot(root, latestSnapshot.snapshotId)
    checks.push(verified.verified
      ? check('local-recovery', 'pass', `Snapshot ${latestSnapshot.snapshotId} passed checksum, SQLite integrity, and schema checks.`)
      : check('local-recovery', 'fail', `Snapshot ${latestSnapshot.snapshotId} failed recovery verification.`))
  }

  if (remote) {
    try {
      const projectId = project.project.runtime.project
      const visible = await remote.request('/api/projects')
      const found = (visible.projects || []).some(({ id }) => id === projectId)
      checks.push(found
        ? check('remote-project', 'pass', 'Project is visible through the authenticated Control Plane scope.')
        : check('remote-project', 'fail', 'Project is not visible through the authenticated Control Plane scope.'))
      if (found) {
        const [overview, access] = await Promise.all([
          remote.request(`/api/monitor-overview?project=${encodeURIComponent(projectId)}`),
          remote.request(`/api/projects/${encodeURIComponent(projectId)}/runtime-credentials`),
        ])
        const development = (overview.environments || []).find(({ environment: name }) => name === 'dev')
        checks.push(development?.deployment?.status === 'succeeded' && typeof development.deployment.runtimeUrl === 'string'
          ? check('remote-development', 'pass', `Remote Development deployment ${development.deployment.id} succeeded.`)
          : check('remote-development', 'fail', 'No succeeded remote Development deployment is available.'))
        const active = (access.credentials || []).filter((credential) =>
          credential.environment === 'dev' && !credential.revokedAt && credential.expiresAt > Date.now())
        checks.push(active.length
          ? check('runtime-access', 'pass', `${active.length} active Development runtime credential(s) exist; token values were not returned.`)
          : check('runtime-access', 'warning', 'No active Development runtime credential metadata exists. Create one before the backend calls the runtime.'))
      }
    } catch (error) {
      checks.push(check('control-plane', 'fail', error instanceof Error ? error.message : 'Remote Control Plane diagnostic failed.'))
    }
  } else {
    checks.push(check('remote-readiness', 'warning', 'Remote checks were skipped. Run lacify doctor --remote after lacify login.'))
  }

  return {
    ready: checks.every(({ status }) => status !== 'fail'),
    project: project.project.runtime.project,
    projectFingerprint: project.fingerprint,
    checks,
    secretsReturned: false,
    businessRowsReturned: false,
  }
}
