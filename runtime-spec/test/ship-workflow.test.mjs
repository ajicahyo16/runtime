import assert from 'node:assert/strict'
import test from 'node:test'
import { credentialCoverage, isTransientShipError, withShipRetry } from '../src/ship-workflow.mjs'

const project = {
  project: {
    actors: [{
      definition: { name: 'Notification' },
      operations: [
        { definition: { name: 'ListNotifications' } },
        { definition: { name: 'GetNotificationPreferences' } },
      ],
    }],
  },
}

test('credential preflight reports operation-level gaps', () => {
  const coverage = credentialCoverage(project, [{
    environment: 'dev',
    expiresAt: Date.now() + 60_000,
    revokedAt: null,
    capabilities: [{ actor: 'Notification', operations: ['ListNotifications'] }],
  }])
  assert.equal(coverage.covered, false)
  assert.deepEqual(coverage.missing, [{
    actor: 'Notification',
    operation: 'GetNotificationPreferences',
  }])
})

test('ship retry recognizes transient D1 CPU failures and remains bounded', async () => {
  let calls = 0
  const result = await withShipRetry(async () => {
    calls += 1
    if (calls < 3) throw new Error('D1 DB exceeded its CPU time limit and was reset.')
    return 'deployed'
  }, { delay: async () => {} })
  assert.equal(result, 'deployed')
  assert.equal(calls, 3)
  assert.equal(isTransientShipError(new Error('validation failed')), false)
})
