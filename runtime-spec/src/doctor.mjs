import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprint, stableStringify } from './index.mjs'
import { integrationManifest } from './integration-generator.mjs'
import { createReviewReceipt } from './review-receipt.mjs'
import { listLocalSnapshots, verifyLocalSnapshot } from './local-backup.mjs'
import { moduleStatus } from './module-system.mjs'
import { credentialCoverage } from './ship-workflow.mjs'

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

async function runtimeAccessCheck(project, environment, fetchImpl) {
  if (!environment.LACIFY_RUNTIME_URL || !environment.LACIFY_RUNTIME_TOKEN) return null
  try {
    const response = await fetchImpl(
      `${environment.LACIFY_RUNTIME_URL.replace(/\/$/, '')}/__lacify/access`,
      { headers: { authorization: `Bearer ${environment.LACIFY_RUNTIME_TOKEN}` } },
    )
    const body = await response.json().catch(() => null)
    if (!response.ok) {
      const code = body?.error?.code || `http_${response.status}`
      return check('runtime-access-e2e', 'fail', `Runtime credential probe failed with ${code}; no business operation was executed.`)
    }
    const coverage = credentialCoverage(project, [{
      environment: 'dev',
      expiresAt: Number.MAX_SAFE_INTEGER,
      revokedAt: null,
      capabilities: body?.capabilities || [],
    }], 0)
    return coverage.covered
      ? check('runtime-access-e2e', 'pass', 'Configured runtime credential authenticated and covers every declared operation; no business rows were read.')
      : check('runtime-access-e2e', 'fail', `Configured runtime credential is missing ${coverage.missing.length} declared operation(s).`)
  } catch {
    return check('runtime-access-e2e', 'fail', 'Runtime credential probe could not reach the configured runtime.')
  }
}

export async function diagnoseProject({ root, project, plans, tests, lock, environment = process.env, remote = null, fetchImpl = fetch }) {
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
  if (remote) {
    const runtimeAccess = await runtimeAccessCheck(project, environment, fetchImpl)
    if (runtimeAccess) checks.push(runtimeAccess)
  }

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
      const remoteProject = (visible.projects || []).find(({ id }) => id === projectId)
      const found = Boolean(remoteProject)
      checks.push(remoteProject
        ? check('remote-project', 'pass', 'Project is visible through the authenticated Control Plane scope.')
        : check('remote-project', 'fail', 'Project is not visible through the authenticated Control Plane scope.'))
      if (found) {
        const [releases, access] = await Promise.all([
          remote.request(`/api/projects/${encodeURIComponent(projectId)}/releases`),
          remote.request(`/api/projects/${encodeURIComponent(projectId)}/runtime-credentials`),
        ])
        const remoteFingerprint = remoteProject.sourceFingerprint || remoteProject.source_fingerprint || null
        const sourceSynced = remoteFingerprint === project.fingerprint
        checks.push(sourceSynced
          ? check('remote-source', 'pass', `Control Plane source matches fingerprint ${project.fingerprint.slice(0, 12)}.`)
          : check('remote-source', 'fail', 'Control Plane source is stale. Run lacify sync with the approved review.'))
        const matchingRelease = (releases.releases || []).find((release) => release.manifest?.sourceFingerprint === project.fingerprint)
        const deployments = matchingRelease
          ? await remote.request(`/api/projects/${encodeURIComponent(projectId)}/releases/${encodeURIComponent(matchingRelease.id)}/deployments`)
          : { deployments: [] }
        const development = (deployments.deployments || []).find(({ environment: name }) => name === 'dev')
        checks.push(development?.status === 'succeeded'
          ? check('remote-development', 'pass', `Current source is deployed through ${development.id}.`)
          : check('remote-development', 'fail', matchingRelease
            ? 'The release for the current source is not deployed successfully to Development.'
            : 'No immutable release exists for the current source. Run lacify ship development with the approved review.'))
        const active = (access.credentials || []).filter((credential) =>
          credential.environment === 'dev' && !credential.revokedAt && credential.expiresAt > Date.now())
        const coverage = credentialCoverage(project, active)
        checks.push(!active.length
          ? check('runtime-access', 'warning', 'No active Development runtime credential metadata exists. Create one before the backend calls the runtime.')
          : coverage.covered
            ? check('runtime-access', 'pass', `${active.length} active Development runtime credential(s) cover every declared operation; token values were not returned.`)
            : check('runtime-access', 'fail', `Active Development credentials are missing ${coverage.missing.length} declared operation(s). Rotate credentials before shipping.`))
      }
    } catch (error) {
      checks.push(check('control-plane', 'fail', error instanceof Error ? error.message : 'Remote Control Plane diagnostic failed.'))
    }
  } else {
    checks.push(check('remote-readiness', 'warning', 'Remote checks were skipped. Run lacify doctor --remote after lacify login.'))
  }

  return {
    ready: checks.every(({ status }) => status !== 'fail'),
    localReady: checks.filter(({ id }) => !id.startsWith('remote-') && id !== 'control-plane').every(({ status }) => status !== 'fail'),
    remoteReady: remote ? checks.filter(({ id }) => id.startsWith('remote-') || id === 'control-plane').every(({ status }) => status !== 'fail') : null,
    project: project.project.runtime.project,
    projectFingerprint: project.fingerprint,
    checks,
    secretsReturned: false,
    businessRowsReturned: false,
  }
}
