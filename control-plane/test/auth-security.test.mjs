import assert from 'node:assert/strict'
import test from 'node:test'
import {
  authenticationBlockMs,
  authenticationBlocked,
  authenticationMaxFailures,
  csrfTokens,
  nextAuthenticationFailure,
  originAllowed,
  requestCookie,
  validCsrfPair,
} from '../src/auth-security.ts'

test('parses opaque application and CSRF cookies without exposing unrelated values', () => {
  const token = 'a'.repeat(43)
  const request = new Request('https://api.runtime.getlacify.com/api/auth/session', {
    headers: { cookie: `unrelated=secret; lacify_app_session=${token}; lacify_csrf=${token}` },
  })
  assert.equal(requestCookie(request, 'lacify_app_session'), token)
  assert.deepEqual(csrfTokens(new Request(request, { headers: { cookie: request.headers.get('cookie'), 'x-csrf-token': token } })), { header: token, cookie: token })
  assert.equal(requestCookie(request, 'missing'), undefined)
})

test('requires an allowed origin and a matching bounded CSRF pair', () => {
  const token = 'b'.repeat(43)
  const allowed = new Request('https://api.runtime.getlacify.com/api/projects', { method: 'POST', headers: { origin: 'https://runtime.getlacify.com' } })
  const denied = new Request('https://api.runtime.getlacify.com/api/projects', { method: 'POST', headers: { origin: 'https://attacker.example' } })
  assert.equal(originAllowed(allowed, ['https://runtime.getlacify.com']), true)
  assert.equal(originAllowed(denied, ['https://runtime.getlacify.com']), false)
  assert.equal(validCsrfPair(token, token), true)
  assert.equal(validCsrfPair(token, 'c'.repeat(43)), false)
  assert.equal(validCsrfPair('short', 'short'), false)
})

test('blocks authentication after a bounded sequence of failures and resets expired windows', () => {
  const timestamp = 1_800_000_000_000
  let record = null
  for (let attempt = 0; attempt < authenticationMaxFailures; attempt += 1) {
    const next = nextAuthenticationFailure(record, timestamp + attempt)
    record = { window_started_at: next.windowStartedAt, failure_count: next.failureCount, blocked_until: next.blockedUntil }
  }
  assert.equal(record.failure_count, authenticationMaxFailures)
  assert.equal(record.blocked_until, timestamp + authenticationMaxFailures - 1 + authenticationBlockMs)
  assert.equal(authenticationBlocked(record, timestamp + authenticationMaxFailures), true)
  const reset = nextAuthenticationFailure(record, timestamp + 60 * 60 * 1000)
  assert.equal(reset.failureCount, 1)
  assert.equal(reset.blockedUntil, null)
})
