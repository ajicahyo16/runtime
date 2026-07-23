import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deviceLogin } from '../src/device-auth.mjs'

test('device login opens a browser, polls, and stores only the returned credential', async () => {
  const requests = []
  const opened = []
  const stored = []
  let polls = 0
  const result = await deviceLogin({
    fetchImpl: async (url, init) => {
      requests.push({ url, init })
      if (init?.method === 'POST') return new Response(JSON.stringify({ deviceCode: 'device-secret', userCode: 'ABCD-EFGH', verificationUri: 'https://runtime.getlacify.com/device', intervalSeconds: 1 }))
      polls += 1
      if (polls === 1) return new Response('{}', { status: 202 })
      return new Response(JSON.stringify({ account: 'user@example.com', accessToken: 'opaque-access-token', expiresAt: 123 }))
    },
    openBrowser: async (url) => opened.push(url),
    store: async (account, token) => stored.push({ account, token }),
    wait: async () => {},
  })
  assert.equal(requests.length, 3)
  assert.deepEqual(opened, ['https://runtime.getlacify.com/device'])
  assert.deepEqual(stored, [{ account: 'user@example.com', token: 'opaque-access-token' }])
  assert.deepEqual(result, { account: 'user@example.com', expiresAt: 123 })
})
