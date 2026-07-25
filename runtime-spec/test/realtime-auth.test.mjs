import assert from 'node:assert/strict'
import test from 'node:test'
import { mintRealtimeToken, realtimeTokenFromRequest, verifyRealtimeToken } from '../src/realtime-auth.mjs'

const secret = 'development-secret-with-at-least-thirty-two-characters'
const claims = {
  sub: 'user-1',
  aud: 'collaboration',
  env: 'development',
  roomClass: 'chat',
  room: 'general',
  cid: 'client-1',
  jti: 'token-1',
  capabilities: ['events', 'presence', 'history'],
}

test('mints and verifies an audience-bound short-lived realtime token', async () => {
  const token = await mintRealtimeToken({ secret, claims, now: 1_000, ttlSeconds: 120 })
  const verified = await verifyRealtimeToken(token, {
    secret,
    now: 1_060,
    expected: { aud: 'collaboration', env: 'development', roomClass: 'chat', room: 'general' },
  })
  assert.equal(verified.sub, 'user-1')
  assert.deepEqual(verified.capabilities, ['events', 'presence', 'history'])
  await assert.rejects(
    verifyRealtimeToken(token, { secret, now: 1_060, expected: { room: 'other' } }),
    (error) => error.code === 'token_audience',
  )
})

test('rejects expired, tampered, and overlong realtime tokens', async () => {
  const token = await mintRealtimeToken({ secret, claims, now: 2_000, ttlSeconds: 30 })
  await assert.rejects(verifyRealtimeToken(token, { secret, now: 2_031 }), (error) => error.code === 'token_expired')
  await assert.rejects(verifyRealtimeToken(`${token.slice(0, -1)}x`, { secret, now: 2_010 }), (error) => error.code === 'token_signature')
  await assert.rejects(verifyRealtimeToken('x'.repeat(4097), { secret, now: 2_010 }), (error) => error.code === 'token_format')
})

test('reads realtime credentials from bearer or bounded websocket subprotocol headers, never query parameters', () => {
  const bearer = realtimeTokenFromRequest(new Request('https://runtime.test/v1/realtime/chat/general?token=ignored', { headers: { authorization: 'Bearer signed.token.value' } }))
  assert.equal(bearer.token, 'signed.token.value')
  const protocol = realtimeTokenFromRequest(new Request('https://runtime.test/v1/realtime/chat/general?token=ignored', { headers: { 'sec-websocket-protocol': 'lacify.realtime.v1, lacify.token.signed.token.value' } }))
  assert.deepEqual(protocol, { token: 'signed.token.value', protocol: 'lacify.realtime.v1' })
  assert.equal(realtimeTokenFromRequest(new Request('https://runtime.test/?token=secret')).token, '')
})
