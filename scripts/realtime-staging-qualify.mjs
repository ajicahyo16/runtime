import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import WebSocket from 'ws'
import { mintRealtimeToken } from '../runtime-spec/src/realtime-auth.mjs'
import { percentile } from '../runtime-spec/src/realtime-capacity.mjs'

const projectId = 'qualification-staging'
const subdomain = process.env.LACIFY_STAGING_WORKERS_SUBDOMAIN || 'ajicayo16'
const root = path.resolve(process.cwd(), '.lacify/staging-qualification')
const configs = {
  runtime: path.join(root, 'runtime/wrangler.jsonc'),
  router: path.join(root, 'runtime/wrangler.event-router.jsonc'),
  reporting: path.join(root, 'runtime/wrangler.reporting.jsonc'),
  realtime: path.join(root, 'realtime/wrangler.jsonc'),
}
const urls = {
  runtime: `https://lacify-${projectId}.${subdomain}.workers.dev`,
  router: `https://lacify-${projectId}-event-router.${subdomain}.workers.dev`,
  reporting: `https://lacify-${projectId}-reporting.${subdomain}.workers.dev`,
  realtime: `https://lacify-realtime-${projectId}.${subdomain}.workers.dev`,
}
const wsUrl = urls.realtime.replace('https://', 'wss://')
const secret = () => randomBytes(32).toString('base64url')
const secrets = {
  eventRouter: secret(),
  reportingSink: secret(),
  realtimeSink: secret(),
  realtimeToken: secret(),
  preflight: secret(),
  reportingRead: secret(),
  reportingRebuild: secret(),
  outboxReplay: secret(),
}

function putSecret(config, name, value) {
  const result = spawnSync('npx', ['wrangler', 'secret', 'put', name, '--config', config], {
    cwd: process.cwd(),
    input: `${value}\n`,
    encoding: 'utf8',
    env: process.env,
  })
  if (result.status !== 0) throw new Error(`secret_configuration_failed:${name}:${String(result.stderr || '').slice(-300)}`)
}

function configureSecrets() {
  const entries = [
    [configs.runtime, 'LACIFY_EVENT_ROUTER_SECRET', secrets.eventRouter],
    [configs.runtime, 'LACIFY_OUTBOX_REPLAY_SECRET', secrets.outboxReplay],
    [configs.router, 'LACIFY_EVENT_ROUTER_SECRET', secrets.eventRouter],
    [configs.router, 'LACIFY_REPORTING_SINK_SECRET', secrets.reportingSink],
    [configs.router, 'LACIFY_REALTIME_SINK_SECRET', secrets.realtimeSink],
    [configs.router, 'LACIFY_PREFLIGHT_SECRET', secrets.preflight],
    [configs.reporting, 'LACIFY_REPORTING_SINK_SECRET', secrets.reportingSink],
    [configs.reporting, 'LACIFY_REPORTING_READ_TOKEN', secrets.reportingRead],
    [configs.reporting, 'LACIFY_REPORTING_REBUILD_SECRET', secrets.reportingRebuild],
    [configs.realtime, 'LACIFY_REALTIME_SINK_SECRET', secrets.realtimeSink],
    [configs.realtime, 'LACIFY_REALTIME_TOKEN_SECRET', secrets.realtimeToken],
  ]
  for (const entry of entries) putSecret(...entry)
  return entries.map(([, name]) => name)
}

function nextFrame(socket, predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', listener)
      reject(new Error('frame_timeout'))
    }, timeoutMs)
    const listener = (data) => {
      let frame
      try { frame = JSON.parse(data.toString()) } catch { return }
      if (!predicate(frame)) return
      clearTimeout(timer)
      socket.off('message', listener)
      resolve(frame)
    }
    socket.on('message', listener)
  })
}

async function token(userId, room, generation = 1) {
  return mintRealtimeToken({
    secret: secrets.realtimeToken,
    claims: {
      sub: userId,
      aud: projectId,
      env: 'staging',
      roomClass: 'store',
      room,
      cid: userId,
      jti: `staging-${userId}-${generation}`,
      capabilities: ['events', 'presence', 'history'],
    },
  })
}

async function connect(user, generation = 1) {
  const startedAt = performance.now()
  const credential = await token(user.id, user.room, generation)
  const socket = new WebSocket(`${wsUrl}/v1/realtime/store/${user.room}`, ['lacify.realtime.v1', `lacify.token.${credential}`], { origin: 'https://app.example.com' })
  const hello = nextFrame(socket, (frame) => frame.type === 'hello')
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  await hello
  return { ...user, socket, connectionMs: performance.now() - startedAt }
}

async function batches(items, size, callback) {
  const values = []
  for (let offset = 0; offset < items.length; offset += size) values.push(...await Promise.all(items.slice(offset, offset + size).map(callback)))
  return values
}

async function measured(client, frame, predicate, timeoutMs = 10_000) {
  const startedAt = performance.now()
  const response = nextFrame(client.socket, predicate, timeoutMs)
  client.socket.send(JSON.stringify(frame))
  await response
  return performance.now() - startedAt
}

async function loadScenario(users) {
  const roomPrefix = `stage-${users}`
  const definitions = Array.from({ length: users }, (_, index) => ({ id: `${roomPrefix}-user-${index}`, room: `${roomPrefix}-room-${Math.floor(index / 10)}` }))
  const errors = []
  let clients = await batches(definitions, 25, async (user) => {
    try { return await connect(user) } catch (error) { errors.push(error.message); return null }
  }).then((items) => items.filter(Boolean))
  const ping = await batches(clients, 50, (client) => measured(client, { type: 'ping', nonce: client.id }, (frame) => frame.type === 'pong' && frame.nonce === client.id).catch((error) => { errors.push(error.message); return 10_000 }))
  const immediate = await batches(clients, 50, (client) => measured(client, { type: 'event', eventId: `pay-${client.id}`, clientSeq: 1, name: 'PaymentConfirmed', payload: { synthetic: true } }, (frame) => frame.type === 'ack' && frame.eventId === `pay-${client.id}` && frame.level === 'durable').catch((error) => { errors.push(error.message); return 10_000 }))
  const segmented = await batches(clients, 50, (client) => measured(client, { type: 'event', eventId: `order-${client.id}`, clientSeq: 1, name: 'OrderPlaced', payload: { synthetic: true } }, (frame) => frame.type === 'ack' && frame.eventId === `order-${client.id}` && frame.level === 'durable', 15_000).catch((error) => { errors.push(error.message); return 15_000 }))
  for (const client of clients) client.socket.send(JSON.stringify({ type: 'presence', state: { synthetic: true } }))
  const reconnectCount = Math.max(1, Math.ceil(users * 0.1))
  const reconnecting = clients.slice(0, reconnectCount)
  for (const client of reconnecting) client.socket.close(1000, 'qualification-reconnect')
  await new Promise((resolve) => setTimeout(resolve, 150))
  const reconnected = await batches(reconnecting, 25, async (client) => {
    try { return await connect({ id: client.id, room: client.room }, 2) } catch (error) { errors.push(error.message); return null }
  }).then((items) => items.filter(Boolean))
  await batches(reconnected, 25, (client) => measured(client, { type: 'event', eventId: `reconnect-${client.id}`, clientSeq: 2, name: 'PaymentConfirmed', payload: { synthetic: true } }, (frame) => frame.type === 'ack' && frame.eventId === `reconnect-${client.id}`).catch((error) => { errors.push(error.message); return 10_000 }))
  clients = [...clients.slice(reconnectCount), ...reconnected]
  const result = {
    users,
    rooms: Math.ceil(users / 10),
    accepted: clients.length,
    reconnected: reconnected.length,
    errors: errors.slice(0, 20),
    latencyMs: {
      connectionP95: percentile(clients.map((client) => client.connectionMs), 95),
      pingP95: percentile(ping, 95),
      immediateP95: percentile(immediate, 95),
      segmentedP95: percentile(segmented, 95),
      reconnectP95: percentile(reconnected.map((client) => client.connectionMs), 95),
    },
  }
  result.passed = result.accepted === users && result.reconnected === reconnectCount && !result.errors.length && result.latencyMs.connectionP95 <= 5_000 && result.latencyMs.immediateP95 <= 5_000 && result.latencyMs.segmentedP95 <= 10_000
  for (const client of clients) client.socket.close(1000, 'qualification-complete')
  if (!result.passed) throw Object.assign(new Error(`staging_load_failed:${users}`), { evidence: result })
  return result
}

async function hmac(value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secrets.eventRouter), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function routerSend(envelope) {
  const body = JSON.stringify(envelope)
  const timestamp = String(Date.now())
  return fetch(`${urls.router}/v1/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-lacify-event-timestamp': timestamp,
      'x-lacify-event-signature': await hmac(`${timestamp}.${body}`),
    },
    body,
  })
}

async function recoveryDrill() {
  const room = 'recovery-drill'
  const listener = await connect({ id: 'recovery-listener', room })
  const received = nextFrame(listener.socket, (frame) => frame.type === 'event' && frame.eventId === 'staging-recovery-1', 20_000)
  putSecret(configs.router, 'LACIFY_REALTIME_SINK_SECRET', secret())
  const envelope = {
    version: 'lacify.dev/event/v1',
    eventId: 'staging-recovery-1',
    operation: 'Qualification',
    partitionKey: room,
    event: 'PaymentConfirmed',
    target: 'realtime',
    durability: 'immediate',
    payload: { synthetic: true },
    routing: { roomClass: 'store', room },
    occurredAt: Date.now(),
  }
  const failed = await routerSend(envelope)
  putSecret(configs.router, 'LACIFY_REALTIME_SINK_SECRET', secrets.realtimeSink)
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  const recovered = await routerSend(envelope)
  await received
  listener.socket.close(1000, 'recovery-complete')
  return { initialStatus: failed.status, recoveryStatus: recovered.status, passed: failed.status === 503 && [202, 409].includes(recovered.status) }
}

async function slowConsumerDrill() {
  const room = 'slow-consumer'
  const slow = await connect({ id: 'slow-reader', room })
  const publisher = await connect({ id: 'slow-publisher', room })
  slow.socket._socket.pause()
  const close = new Promise((resolve) => slow.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  const padding = 'x'.repeat(12_000)
  for (let index = 0; index < 400; index += 1) {
    publisher.socket.send(JSON.stringify({ type: 'event', eventId: `slow-${index}`, clientSeq: 1, name: 'TypingChanged', payload: { padding } }))
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  slow.socket._socket.resume()
  const result = await Promise.race([close, new Promise((resolve) => setTimeout(() => resolve(null), 10_000))])
  publisher.socket.close(1000, 'slow-drill-complete')
  if (!result) slow.socket.close(1000, 'slow-drill-timeout')
  return { ...result, passed: result?.code === 1013 }
}

const startedAt = new Date().toISOString()
const configuredSecrets = configureSecrets()
await new Promise((resolve) => setTimeout(resolve, 2_000))
const health = Object.fromEntries(await Promise.all(Object.entries(urls).map(async ([name, url]) => {
  const endpoint = name === 'router' ? `${url}/__lacify/router/health?deep=1` : name === 'realtime' ? `${url}/__lacify/realtime/health` : name === 'reporting' ? `${url}/__lacify/reporting/health` : `${url}/health?deep=1`
  const response = await fetch(endpoint)
  return [name, { status: response.status, ok: response.ok }]
})))
const preflightResponse = await fetch(`${urls.router}/__lacify/router/preflight`, { method: 'POST', headers: { 'x-lacify-preflight-approval': secrets.preflight } })
const preflight = { status: preflightResponse.status, body: await preflightResponse.json().catch(() => null) }
if (!preflightResponse.ok || Object.values(health).some((item) => !item.ok)) throw new Error(`staging_preflight_failed:${JSON.stringify({ health, preflight })}`)
const scenarios = []
for (const users of [30, 100, 300]) scenarios.push(await loadScenario(users))
const recovery = await recoveryDrill()
const slowConsumer = await slowConsumerDrill()
const report = {
  format: 'lacify-realtime-staging-evidence/v1',
  startedAt,
  completedAt: new Date().toISOString(),
  project: projectId,
  environment: 'staging',
  productionMutation: false,
  secretValuesIncluded: false,
  configuredSecretNames: configuredSecrets,
  urls,
  health,
  preflight: { status: preflight.status, ok: preflight.body?.ok === true, remoteMutation: preflight.body?.remoteMutation },
  scenarios,
  recovery,
  slowConsumer,
}
report.passed = Object.values(health).every((item) => item.ok) && report.preflight.ok && scenarios.every((item) => item.passed) && recovery.passed && slowConsumer.passed
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (!report.passed) process.exitCode = 1
