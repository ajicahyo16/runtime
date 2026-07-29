import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export function requiredCapabilities(project) {
  return project.project.actors.map((actor) => ({
    actor: actor.definition.name,
    operations: actor.operations.map(({ definition }) => definition.name).sort(),
  }))
}

export function credentialCoverage(project, credentials, timestamp = Date.now()) {
  const active = (credentials || []).filter((credential) =>
    credential.environment === 'dev'
    && !credential.revokedAt
    && credential.expiresAt > timestamp)
  const granted = new Map()
  for (const credential of active) {
    for (const capability of credential.capabilities || []) {
      const operations = granted.get(capability.actor) || new Set()
      for (const operation of capability.operations || []) operations.add(operation)
      granted.set(capability.actor, operations)
    }
  }
  const missing = requiredCapabilities(project).flatMap(({ actor, operations }) =>
    operations
      .filter((operation) => !granted.get(actor)?.has(operation))
      .map((operation) => ({ actor, operation })))
  return { activeCredentialCount: active.length, covered: missing.length === 0, missing }
}

export function isTransientShipError(error) {
  return error?.retryable === true
    || error?.status === 429
    || error?.status >= 500
    || /D1 DB exceeded its CPU time limit|temporar|timeout|reset|network/i.test(error?.message || '')
}

export async function withShipRetry(action, {
  attempts = 3,
  delay = async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  onRetry = () => {},
} = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action(attempt)
    } catch (error) {
      lastError = error
      if (attempt >= attempts || !isTransientShipError(error)) throw error
      onRetry({ attempt, nextAttempt: attempt + 1, error })
      await delay(Math.min(4_000, 250 * (2 ** (attempt - 1))))
    }
  }
  throw lastError
}

export function shipStateFile(root) {
  return path.join(root, '.lacify', 'ship-state.json')
}

export async function readShipState(root, binding) {
  try {
    const state = JSON.parse(await readFile(shipStateFile(root), 'utf8'))
    return state.projectFingerprint === binding.projectFingerprint
      && state.reviewId === binding.reviewId
      ? state
      : null
  } catch {
    return null
  }
}

export async function saveShipState(root, state) {
  const file = shipStateFile(root)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({
    version: 1,
    ...state,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 })
  return file
}
