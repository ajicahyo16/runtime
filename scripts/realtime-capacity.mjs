import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { Miniflare } from 'miniflare'
import { mintRealtimeToken } from '../runtime-spec/src/realtime-auth.mjs'
import { estimateCapacityBudget, evaluateCapacityScenario, percentile } from '../runtime-spec/src/realtime-capacity.mjs'
import { compileRealtimeRelease } from '../runtime-spec/src/realtime-compiler.mjs'
import { loadRealtimeProject } from '../runtime-spec/src/realtime-spec.mjs'

const tokenSecret = 'capacity-secret-with-at-least-thirty-two-characters'

function numericArgument(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = Number(process.argv[index + 1])
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} requires a positive integer.`)
  return value
}

function userScenarios() {
  const index = process.argv.indexOf('--users')
  if (index < 0) return [30, 100, 300]
  const values = process.argv[index + 1].split(',').map(Number)
  if (!values.length || values.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 500)) throw new Error('--users must contain comma-separated integers from 1 to 500.')
  return values
}

function nextFrame(socket, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', listener)
      reject(new Error('frame_timeout'))
    }, timeoutMs)
    const listener = (event) => {
      let frame
      try { frame = JSON.parse(event.data) } catch { return }
      if (!predicate(frame)) return
      clearTimeout(timeout)
      socket.removeEventListener('message', listener)
      resolve(frame)
    }
    socket.addEventListener('message', listener)
  })
}

async function mapBatches(items, batchSize, callback) {
  const results = []
  for (let offset = 0; offset < items.length; offset += batchSize) {
    results.push(...await Promise.all(items.slice(offset, offset + batchSize).map(callback)))
  }
  return results
}

async function credential(userId, room, generation = 1) {
  return mintRealtimeToken({
    secret: tokenSecret,
    claims: {
      sub: userId,
      aud: 'collaboration',
      env: 'development',
      roomClass: 'chat',
      room,
      cid: userId,
      jti: `capacity-${userId}-${generation}`,
      capabilities: ['events', 'presence', 'history'],
    },
  })
}

async function connect(mf, user, generation = 1) {
  const startedAt = performance.now()
  const response = await mf.dispatchFetch(`https://capacity.test/v1/realtime/chat/${user.room}`, {
    headers: {
      upgrade: 'websocket',
      origin: 'https://app.example.com',
      authorization: `Bearer ${await credential(user.id, user.room, generation)}`,
    },
  })
  if (response.status !== 101) throw new Error(`connect_${response.status}`)
  const socket = response.webSocket
  socket.accept()
  await nextFrame(socket, (frame) => frame.type === 'hello')
  return { ...user, socket, connectionMs: performance.now() - startedAt }
}

async function measuredFrame(client, frame, predicate) {
  const startedAt = performance.now()
  const pending = nextFrame(client.socket, predicate)
  client.socket.send(JSON.stringify(frame))
  await pending
  return performance.now() - startedAt
}

async function createRuntime(usersPerRoom) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lacify-capacity-'))
  const loaded = await loadRealtimeProject(path.join(import.meta.dirname, '../runtime-spec/fixtures/realtime/lacify.realtime.yaml'))
  const room = loaded.project.rooms[0].definition
  room.events.find((event) => event.name === 'SendMessage').batchSize = usersPerRoom
  room.events.find((event) => event.name === 'SendMessage').retryFlushMs = 250
  const release = await compileRealtimeRelease(loaded)
  for (const [name, source] of Object.entries(release.artifact)) await writeFile(path.join(root, name), source)
  const mf = new Miniflare({
    modules: true,
    modulesRoot: root,
    scriptPath: path.join(root, 'worker.js'),
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'], fallthrough: true }],
    durableObjects: { ROOMS: { className: 'RoomActor', useSQLite: true } },
    r2Buckets: ['HISTORY'],
    bindings: {
      LACIFY_ENVIRONMENT: 'development',
      LACIFY_REALTIME_TOKEN_SECRET: tokenSecret,
      LACIFY_REALTIME_SINK_SECRET: 'capacity-internal-secret',
    },
    cf: false,
  })
  return mf
}

async function scenario(users, options) {
  const usersPerRoom = options.usersPerRoom
  const roomCount = Math.ceil(users / usersPerRoom)
  const definitions = Array.from({ length: users }, (_, index) => ({ id: `user-${index}`, room: `room-${Math.floor(index / usersPerRoom)}` }))
  const mf = await createRuntime(usersPerRoom)
  const errors = []
  const memoryBefore = process.memoryUsage().heapUsed
  let clients = []
  try {
    clients = await mapBatches(definitions, options.connectionBatchSize, async (user) => {
      try { return await connect(mf, user) } catch (error) { errors.push(error.message); return null }
    }).then((items) => items.filter(Boolean))

    const pingLatency = await mapBatches(clients, options.operationBatchSize, (client) => measuredFrame(client, { type: 'ping', nonce: client.id }, (frame) => frame.type === 'pong' && frame.nonce === client.id).catch((error) => { errors.push(error.message); return options.timeoutMs }))
    const immediateLatency = await mapBatches(clients, options.operationBatchSize, (client) => measuredFrame(client, { type: 'event', eventId: `immediate-${client.id}`, clientSeq: 1, name: 'PaymentConfirmed', payload: { synthetic: true } }, (frame) => frame.type === 'ack' && frame.eventId === `immediate-${client.id}` && frame.level === 'durable').catch((error) => { errors.push(error.message); return options.timeoutMs }))
    const segmentedLatency = await mapBatches(clients, options.operationBatchSize, (client) => measuredFrame(client, { type: 'event', eventId: `segment-${client.id}`, clientSeq: 1, name: 'SendMessage', payload: { synthetic: true } }, (frame) => frame.type === 'ack' && frame.eventId === `segment-${client.id}` && frame.level === 'durable').catch((error) => { errors.push(error.message); return options.timeoutMs }))
    for (const client of clients) client.socket.send(JSON.stringify({ type: 'presence', state: { synthetic: true } }))

    const reconnectCount = Math.max(1, Math.ceil(users * options.reconnectRatio))
    const reconnecting = clients.slice(0, reconnectCount)
    for (const client of reconnecting) client.socket.close(1000, 'capacity-reconnect')
    await new Promise((resolve) => setTimeout(resolve, 25))
    const reconnected = await mapBatches(reconnecting, options.connectionBatchSize, async (client) => {
      try { return await connect(mf, { id: client.id, room: client.room }, 2) } catch (error) { errors.push(error.message); return null }
    }).then((items) => items.filter(Boolean))
    const reconnectLatency = reconnected.map((client) => client.connectionMs)
    await mapBatches(reconnected, options.operationBatchSize, (client) => measuredFrame(client, { type: 'event', eventId: `reconnect-${client.id}`, clientSeq: 2, name: 'PaymentConfirmed', payload: { synthetic: true } }, (frame) => frame.type === 'ack' && frame.eventId === `reconnect-${client.id}` && frame.level === 'durable').catch((error) => { errors.push(error.message); return options.timeoutMs }))
    clients = [...clients.slice(reconnectCount), ...reconnected]

    const bucket = await mf.getR2Bucket('HISTORY')
    const objects = await bucket.list()
    const result = {
      environment: 'local-miniflare',
      users,
      rooms: roomCount,
      usersPerRoom,
      connections: { attempted: users, accepted: clients.length, reconnected: reconnected.length },
      inboundWebSocketMessages: users * 4 + reconnected.length,
      reconnects: reconnected.length,
      sqliteWritesPerCycle: (users * 2) + (reconnected.length * 2) + (roomCount * 2),
      r2ClassAOperationsPerCycle: objects.objects.length,
      latencyMs: {
        connectionP50: percentile(clients.map((client) => client.connectionMs), 50),
        connectionP95: percentile(clients.map((client) => client.connectionMs), 95),
        pingP95: percentile(pingLatency, 95),
        immediateAckP95: percentile(immediateLatency, 95),
        segmentedDurableP95: percentile(segmentedLatency, 95),
        reconnectP95: percentile(reconnectLatency, 95),
      },
      storage: { r2Segments: objects.objects.length },
      process: { heapDeltaBytes: process.memoryUsage().heapUsed - memoryBefore },
      errors: errors.slice(0, 20),
    }
    result.acceptance = evaluateCapacityScenario(result)
    result.budget = estimateCapacityBudget(result, { cyclesPerDay: options.cyclesPerDay })
    return result
  } finally {
    for (const client of clients) {
      try { client.socket.close(1000, 'capacity-complete') } catch {}
    }
    await mf.dispose()
  }
}

const options = {
  usersPerRoom: numericArgument('--users-per-room', 10),
  connectionBatchSize: numericArgument('--connection-batch', 25),
  operationBatchSize: numericArgument('--operation-batch', 50),
  cyclesPerDay: numericArgument('--cycles-per-day', 60),
  timeoutMs: numericArgument('--timeout-ms', 5_000),
  reconnectRatio: 0.1,
}
const startedAt = new Date().toISOString()
const scenarios = []
for (const users of userScenarios()) scenarios.push(await scenario(users, options))
const report = {
  format: 'lacify-realtime-capacity-evidence/v1',
  startedAt,
  completedAt: new Date().toISOString(),
  remoteMutation: false,
  providerQuotaConsumed: false,
  options,
  scenarios,
  passed: scenarios.every((item) => item.acceptance.passed),
  limitations: [
    'Miniflare latency is local evidence, not Cloudflare edge latency.',
    'Durable Object duration and account-wide quota require staging telemetry.',
    'Slow-consumer network behavior requires a controlled staging client.',
  ],
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (!report.passed) process.exitCode = 1
