import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { mintRealtimeToken } from '../src/realtime-auth.mjs'
import { compileRealtimeRelease } from '../src/realtime-compiler.mjs'
import { loadRealtimeProject } from '../src/realtime-spec.mjs'

const secret = 'development-secret-with-at-least-thirty-two-characters'

function nextFrame(socket, predicate = () => true, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', listener)
      reject(new Error('Timed out waiting for realtime frame.'))
    }, timeoutMs)
    const listener = (event) => {
      const frame = JSON.parse(event.data)
      if (!predicate(frame)) return
      clearTimeout(timeout)
      socket.removeEventListener('message', listener)
      resolve(frame)
    }
    socket.addEventListener('message', listener)
  })
}

async function token(
  clientId,
  subject = clientId,
  room = 'general',
  roomClass = 'chat',
  capabilities = ['events', 'presence', 'history'],
) {
  return mintRealtimeToken({
    secret,
    claims: {
      sub: subject,
      aud: 'collaboration',
      env: 'development',
      roomClass,
      room,
      cid: clientId,
      jti: `token-${clientId}`,
      capabilities,
    },
  })
}

async function runtime({ dailyBudget, segmentBatchSize, retryFlushMs, persistenceRoot, testFaultInjection = false, faultPoint } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lacify-realtime-runtime-'))
  const loaded = await loadRealtimeProject(path.join(import.meta.dirname, '../fixtures/realtime/lacify.realtime.yaml'))
  if (dailyBudget !== undefined) loaded.project.rooms[0].definition.budget.maxPersistentEventsPerUtcDay = dailyBudget
  if (segmentBatchSize !== undefined) loaded.project.rooms[0].definition.events.find(({ name }) => name === 'SendMessage').batchSize = segmentBatchSize
  if (retryFlushMs !== undefined) loaded.project.rooms[0].definition.events.find(({ name }) => name === 'SendMessage').retryFlushMs = retryFlushMs
  const release = await compileRealtimeRelease(loaded, { testFaultInjection })
  for (const [name, source] of Object.entries(release.artifact)) await writeFile(path.join(root, name), source)
  const mf = new Miniflare({
    modules: true,
    modulesRoot: root,
    scriptPath: path.join(root, 'worker.js'),
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'], fallthrough: true }],
    durableObjects: { ROOMS: { className: 'RoomActor', useSQLite: true } },
    r2Buckets: ['HISTORY'],
    ...(persistenceRoot ? { durableObjectsPersist: path.join(persistenceRoot, 'durable-objects'), r2Persist: path.join(persistenceRoot, 'r2') } : {}),
    bindings: {
      LACIFY_ENVIRONMENT: 'development',
      LACIFY_REALTIME_TOKEN_SECRET: secret,
      LACIFY_REALTIME_SINK_SECRET: 'realtime-sink-secret',
      ...(faultPoint ? { LACIFY_REALTIME_FAULT_POINT: faultPoint } : {}),
    },
    cf: false,
  })
  return { mf, release }
}

test('authenticated server events enter the same Room Actor and deduplicate durably', async (t) => {
  const { mf } = await runtime()
  t.after(() => mf.dispose())
  const connection = await connect(mf, 'server-event-listener')
  const received = nextFrame(connection.socket, (frame) => frame.type === 'event' && frame.eventId === 'server-1')
  const envelope = {
    version: 'lacify.dev/event/v1',
    eventId: 'server-1',
    operation: 'ConfirmPayment',
    partitionKey: 'general',
    event: 'PaymentConfirmed',
    target: 'realtime',
    durability: 'immediate',
    payload: { orderId: 'order-1' },
    routing: { roomClass: 'chat', room: 'general' },
    occurredAt: Date.now(),
  }
  const denied = await mf.dispatchFetch('https://runtime.test/v1/internal/events', { method: 'POST', body: JSON.stringify(envelope) })
  assert.equal(denied.status, 401)
  const first = await mf.dispatchFetch('https://runtime.test/v1/internal/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lacify-event-sink-secret': 'realtime-sink-secret' },
    body: JSON.stringify(envelope),
  })
  assert.equal(first.status, 202)
  assert.equal((await received).source, 'runtime')
  const duplicate = await mf.dispatchFetch('https://runtime.test/v1/internal/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lacify-event-sink-secret': 'realtime-sink-secret' },
    body: JSON.stringify(envelope),
  })
  assert.equal(duplicate.status, 409)
  const expired = await mf.dispatchFetch('https://runtime.test/v1/internal/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lacify-event-sink-secret': 'realtime-sink-secret' },
    body: JSON.stringify({ ...envelope, eventId: 'server-expired', occurredAt: Date.now() - 86_400_001 }),
  })
  assert.equal(expired.status, 422)
  assert.equal((await expired.json()).error.code, 'event_outside_retention')
  connection.socket.close(1000, 'done')
})

async function connect(mf, clientId, options = {}) {
  const roomClass = options.roomClass || 'chat'
  const room = options.room || 'general'
  const capabilities = options.capabilities || ['events', 'presence', 'history']
  const response = await mf.dispatchFetch(`https://runtime.test/v1/realtime/${roomClass}/${room}`, {
    headers: {
      upgrade: 'websocket',
      origin: options.origin || 'https://app.example.com',
      authorization: `Bearer ${options.token || await token(clientId, options.subject, room, roomClass, capabilities)}`,
    },
  })
  assert.equal(response.status, 101)
  const socket = response.webSocket
  socket.accept()
  const hello = await nextFrame(socket, (frame) => frame.type === 'hello')
  return { socket, hello }
}

test('user-scoped notification sockets receive ephemeral server fanout without persistent writes', async (t) => {
  const { mf } = await runtime()
  t.after(() => mf.dispose())
  const userId = 'user-notification-recipient'
  const connection = await connect(mf, 'notification-client', {
    subject: userId,
    room: userId,
    roomClass: 'notifications',
    capabilities: ['events'],
  })
  assert.deepEqual(connection.hello.capabilities, ['events'])
  assert.equal(connection.hello.budget.persistentEventsUsed, 0)

  const received = nextFrame(
    connection.socket,
    (frame) => frame.type === 'event' && frame.eventId === 'notification-event-1',
  )
  const response = await mf.dispatchFetch('https://runtime.test/v1/internal/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-lacify-event-sink-secret': 'realtime-sink-secret',
    },
    body: JSON.stringify({
      version: 'lacify.dev/event/v1',
      eventId: 'notification-event-1',
      operation: 'IngestNotificationEvent',
      partitionKey: userId,
      event: 'NotificationCreated',
      target: 'realtime',
      durability: 'ephemeral',
      payload: { notificationId: 'notification-1', type: 'FOLLOW' },
      routing: { roomClass: 'notifications', room: userId },
      occurredAt: Date.now(),
    }),
  })

  assert.equal(response.status, 202)
  const frame = await received
  assert.equal(frame.durability, 'ephemeral')
  assert.equal(frame.payload.notificationId, 'notification-1')
  assert.equal(frame.roomSeq, undefined)
  connection.socket.close(1000, 'done')
})

test('workerd accepts authenticated hibernatable sockets and enforces origin and audience', async (t) => {
  const { mf } = await runtime()
  t.after(() => mf.dispose())
  const missing = await mf.dispatchFetch('https://runtime.test/v1/realtime/chat/general', { headers: { upgrade: 'websocket', origin: 'https://app.example.com' } })
  assert.equal(missing.status, 401)
  const origin = await mf.dispatchFetch('https://runtime.test/v1/realtime/chat/general', { headers: { upgrade: 'websocket', origin: 'https://evil.example.com', authorization: `Bearer ${await token('client-a')}` } })
  assert.equal(origin.status, 403)
  const audience = await mf.dispatchFetch('https://runtime.test/v1/realtime/chat/other', { headers: { upgrade: 'websocket', origin: 'https://app.example.com', authorization: `Bearer ${await token('client-a')}` } })
  assert.equal(audience.status, 401)
  const connection = await connect(mf, 'client-a')
  assert.equal(connection.hello.protocol, 'lacify.realtime.protocol/v1')
  assert.deepEqual(connection.hello.capabilities, ['events', 'history', 'presence'])
  assert.deepEqual(connection.hello.budget.persistentEventsUsed, 0)
  assert.equal(connection.hello.budget.persistentEventsLimit, 50000)
  connection.socket.close(1000, 'done')
})

test('Room Actor fails closed at its declared daily persistent-event budget', async (t) => {
  const { mf } = await runtime({ dailyBudget: 1 })
  t.after(() => mf.dispose())
  const connection = await connect(mf, 'budget-client')
  const firstAck = nextFrame(connection.socket, (frame) => frame.type === 'ack' && frame.eventId === 'budget-1')
  connection.socket.send(JSON.stringify({ type: 'event', eventId: 'budget-1', clientSeq: 1, name: 'StoreEvent', payload: {} }))
  await firstAck
  const exhausted = nextFrame(connection.socket, (frame) => frame.type === 'error')
  connection.socket.send(JSON.stringify({ type: 'event', eventId: 'budget-2', clientSeq: 2, name: 'StoreEvent', payload: {} }))
  assert.equal((await exhausted).code, 'room_daily_write_budget')
  connection.socket.close(1000, 'done')
})

test('Room Actor orders, acknowledges, deduplicates, replays, and broadcasts ephemeral presence', async (t) => {
  const { mf } = await runtime()
  t.after(() => mf.dispose())
  const first = await connect(mf, 'client-a')
  const firstJoin = nextFrame(first.socket, (frame) => frame.type === 'presence' && frame.action === 'join')
  const second = await connect(mf, 'client-b')
  await firstJoin

  const firstEvent = nextFrame(first.socket, (frame) => frame.type === 'event' && frame.eventId === 'event-1')
  const secondEvent = nextFrame(second.socket, (frame) => frame.type === 'event' && frame.eventId === 'event-1')
  const acknowledgement = nextFrame(first.socket, (frame) => frame.type === 'ack' && frame.eventId === 'event-1')
  first.socket.send(JSON.stringify({ type: 'event', eventId: 'event-1', clientSeq: 1, name: 'PaymentConfirmed', payload: { text: 'hello' } }))
  assert.deepEqual(await acknowledgement, { type: 'ack', eventId: 'event-1', roomSeq: 1, replayed: false, level: 'durable', durability: 'immediate' })
  assert.equal((await firstEvent).roomSeq, 1)
  assert.equal((await secondEvent).roomSeq, 1)

  const duplicate = nextFrame(first.socket, (frame) => frame.type === 'ack' && frame.eventId === 'event-1')
  first.socket.send(JSON.stringify({ type: 'event', eventId: 'event-1', clientSeq: 1, name: 'PaymentConfirmed', payload: { text: 'hello' } }))
  assert.equal((await duplicate).replayed, true)

  const gap = nextFrame(first.socket, (frame) => frame.type === 'error' && frame.code === 'client_sequence_gap')
  first.socket.send(JSON.stringify({ type: 'event', eventId: 'event-3', clientSeq: 3, name: 'PaymentConfirmed', payload: {} }))
  await gap

  const replay = nextFrame(second.socket, (frame) => frame.type === 'event' && frame.replayed === true)
  const replayComplete = nextFrame(second.socket, (frame) => frame.type === 'replay_complete')
  second.socket.send(JSON.stringify({ type: 'resume', lastRoomSeq: 0 }))
  assert.equal((await replay).roomSeq, 1)
  assert.equal((await replayComplete).eventCount, 1)

  const presence = nextFrame(second.socket, (frame) => frame.type === 'presence' && frame.action === 'update')
  first.socket.send(JSON.stringify({ type: 'presence', state: { typing: true } }))
  assert.deepEqual((await presence).state, { typing: true })

  first.socket.close(1000, 'done')
  second.socket.close(1000, 'done')
})

test('segmented events receive accepted then durable acknowledgements and replay from R2', async (t) => {
  const { mf } = await runtime({ segmentBatchSize: 2 })
  t.after(() => mf.dispose())
  const connection = await connect(mf, 'segment-client')
  const acceptedOne = nextFrame(connection.socket, (frame) => frame.type === 'ack' && frame.eventId === 'segment-1' && frame.level === 'accepted')
  connection.socket.send(JSON.stringify({ type: 'event', eventId: 'segment-1', clientSeq: 1, name: 'SendMessage', payload: { text: 'one' } }))
  assert.equal((await acceptedOne).retryUntilDurable, true)
  const durableOne = nextFrame(connection.socket, (frame) => frame.type === 'ack' && frame.eventId === 'segment-1' && frame.level === 'durable')
  const durableTwo = nextFrame(connection.socket, (frame) => frame.type === 'ack' && frame.eventId === 'segment-2' && frame.level === 'durable')
  connection.socket.send(JSON.stringify({ type: 'event', eventId: 'segment-2', clientSeq: 2, name: 'SendMessage', payload: { text: 'two' } }))
  const first = await durableOne
  assert.equal((await durableTwo).segment, first.segment)
  const history = nextFrame(connection.socket, (frame) => frame.type === 'history_segment')
  const completed = nextFrame(connection.socket, (frame) => frame.type === 'segment_replay_complete')
  connection.socket.send(JSON.stringify({ type: 'segment_resume' }))
  assert.equal((await history).body.events.length, 2)
  assert.equal((await completed).segmentCount, 1)
  connection.socket.close(1000, 'done')

  const reconnected = await connect(mf, 'segment-client')
  const replayed = nextFrame(reconnected.socket, (frame) => frame.type === 'ack' && frame.eventId === 'segment-1' && frame.level === 'durable')
  reconnected.socket.send(JSON.stringify({ type: 'event', eventId: 'segment-1', clientSeq: 1, name: 'SendMessage', payload: { text: 'one' } }))
  assert.equal((await replayed).replayed, true)
  const bucket = await mf.getR2Bucket('HISTORY')
  const objects = await bucket.list({ include: ['httpMetadata'] })
  assert.equal(objects.objects.length, 1)
  assert.equal(objects.objects[0].httpMetadata.contentEncoding, 'gzip')
  reconnected.socket.close(1000, 'done')
})

test('ephemeral and segmented traffic does not consume immediate command sequence', async (t) => {
  const { mf } = await runtime()
  t.after(() => mf.dispose())
  const connection = await connect(mf, 'mixed-client')
  const ephemeral = nextFrame(connection.socket, (frame) => frame.type === 'ack' && frame.eventId === 'mixed-ephemeral')
  connection.socket.send(JSON.stringify({ type: 'event', eventId: 'mixed-ephemeral', clientSeq: 99, name: 'TypingChanged', payload: { typing: true } }))
  assert.equal((await ephemeral).durability, 'ephemeral')
  const segmented = nextFrame(connection.socket, (frame) => frame.type === 'ack' && frame.eventId === 'mixed-segmented')
  connection.socket.send(JSON.stringify({ type: 'event', eventId: 'mixed-segmented', clientSeq: 100, name: 'SendMessage', payload: { text: 'pending' } }))
  assert.equal((await segmented).durability, 'segmented')
  const immediate = nextFrame(connection.socket, (frame) => frame.type === 'ack' && frame.eventId === 'mixed-immediate')
  connection.socket.send(JSON.stringify({ type: 'event', eventId: 'mixed-immediate', clientSeq: 1, name: 'PaymentConfirmed', payload: {} }))
  assert.equal((await immediate).durability, 'immediate')
  connection.socket.close(1000, 'done')
})

test('client retry reaches durable storage after a persisted workerd restart evicts accepted memory', async (t) => {
  const persistenceRoot = await mkdtemp(path.join(os.tmpdir(), 'lacify-realtime-persist-'))
  const firstRuntime = await runtime({ persistenceRoot, retryFlushMs: 100 })
  const first = await connect(firstRuntime.mf, 'evicted-client')
  const accepted = nextFrame(first.socket, (frame) => frame.type === 'ack' && frame.eventId === 'evicted-1')
  first.socket.send(JSON.stringify({ type: 'event', eventId: 'evicted-1', clientSeq: 7, name: 'SendMessage', payload: { text: 'retain until durable' } }))
  assert.equal((await accepted).level, 'accepted')
  await firstRuntime.mf.dispose()

  const secondRuntime = await runtime({ persistenceRoot, retryFlushMs: 100 })
  t.after(() => secondRuntime.mf.dispose())
  const second = await connect(secondRuntime.mf, 'evicted-client')
  const acceptedAgain = nextFrame(second.socket, (frame) => frame.type === 'ack' && frame.eventId === 'evicted-1' && frame.level === 'accepted')
  second.socket.send(JSON.stringify({ type: 'event', eventId: 'evicted-1', clientSeq: 7, name: 'SendMessage', payload: { text: 'retain until durable' } }))
  await acceptedAgain
  await new Promise((resolve) => setTimeout(resolve, 120))
  const durable = nextFrame(second.socket, (frame) => frame.type === 'ack' && frame.eventId === 'evicted-1' && frame.level === 'durable')
  second.socket.send(JSON.stringify({ type: 'event', eventId: 'evicted-1', clientSeq: 7, name: 'SendMessage', payload: { text: 'retain until durable' } }))
  assert.equal((await durable).durability, 'segmented')
  const bucket = await secondRuntime.mf.getR2Bucket('HISTORY')
  assert.equal((await bucket.list()).objects.length, 1)
  second.socket.close(1000, 'done')
})

for (const faultPoint of ['after_intent', 'after_r2', 'after_commit']) {
  test(`segmented retry recovers exactly once from injected ${faultPoint} failure`, async (t) => {
    const { mf } = await runtime({ segmentBatchSize: 2, testFaultInjection: true, faultPoint })
    t.after(() => mf.dispose())
    const first = await connect(mf, `fault-${faultPoint}-a`)
    const second = await connect(mf, `fault-${faultPoint}-b`)
    const accepted = nextFrame(first.socket, (frame) => frame.type === 'ack' && frame.eventId === `${faultPoint}-1`)
    first.socket.send(JSON.stringify({ type: 'event', eventId: `${faultPoint}-1`, clientSeq: 1, name: 'SendMessage', payload: { value: 1 } }))
    await accepted
    const injected = nextFrame(second.socket, (frame) => frame.type === 'error' && frame.code === `injected_${faultPoint}`)
    second.socket.send(JSON.stringify({ type: 'event', eventId: `${faultPoint}-2`, clientSeq: 1, name: 'SendMessage', payload: { value: 2 } }))
    await injected
    const durableOne = nextFrame(first.socket, (frame) => frame.type === 'ack' && frame.eventId === `${faultPoint}-1` && frame.level === 'durable')
    const durableTwo = nextFrame(second.socket, (frame) => frame.type === 'ack' && frame.eventId === `${faultPoint}-2` && frame.level === 'durable')
    first.socket.send(JSON.stringify({ type: 'event', eventId: `${faultPoint}-1`, clientSeq: 1, name: 'SendMessage', payload: { value: 1 } }))
    second.socket.send(JSON.stringify({ type: 'event', eventId: `${faultPoint}-2`, clientSeq: 1, name: 'SendMessage', payload: { value: 2 } }))
    assert.equal((await durableOne).replayed, true)
    assert.equal((await durableTwo).replayed, true)
    const bucket = await mf.getR2Bucket('HISTORY')
    assert.equal((await bucket.list()).objects.length, 1)
    first.socket.close(1000, 'done')
    second.socket.close(1000, 'done')
  })
}
