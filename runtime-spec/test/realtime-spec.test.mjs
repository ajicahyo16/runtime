import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadRealtimeProject, validateRealtimeDocument, validateRoomDocument } from '../src/realtime-spec.mjs'

async function fixture(capabilities = ['events', 'presence', 'history']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lacify-realtime-'))
  await mkdir(path.join(root, 'rooms'))
  await writeFile(path.join(root, 'lacify.realtime.yaml'), 'version: lacify.dev/realtime/v1\nproject: collaboration\nruntime: realtime\nrooms:\n  - ./rooms/chat.room.yaml\n')
  await writeFile(path.join(root, 'rooms', 'chat.room.yaml'), `version: lacify.dev/room/v1\nname: Chat\npartitionBy: roomId\ncapabilities:\n${capabilities.map((value) => `  - ${value}`).join('\n')}\nstorage: sqlite\nretention:\n  historySeconds: 86400\n  maxEvents: 100000\nlimits:\n  maxFrameBytes: 65536\n  maxConnections: 1000\n  maxPresenceBytes: 4096\n  maxDocumentUpdateBytes: 262144\nbudget:\n  maxPersistentEventsPerUtcDay: 50000\nauth:\n  mode: token\n  allowedOrigins:\n    - https://app.example.com\n`)
  return root
}

test('loads and fingerprints a realtime project deterministically', async () => {
  const root = await fixture()
  const first = await loadRealtimeProject(path.join(root, 'lacify.realtime.yaml'))
  assert.equal(first.valid, true, JSON.stringify(first.issues))
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/)
  assert.deepEqual(first.project.rooms[0].definition.capabilities, ['events', 'history', 'presence'])
})

test('rejects websocket mode in request-response shape and unknown realtime fields', () => {
  const issues = validateRealtimeDocument({ version: 'lacify.dev/realtime/v1', project: 'demo', runtime: 'websocket', rooms: ['./rooms/demo.room.yaml'], secret: true })
  assert.ok(issues.some(({ code }) => code === 'runtime_mode'))
  assert.ok(issues.some(({ code }) => code === 'unknown_field'))
})

test('requires bounded limits, budget, explicit HTTPS origins, and event-backed history', () => {
  const issues = validateRoomDocument({ version: 'lacify.dev/room/v1', name: 'Chat', partitionBy: 'roomId', capabilities: ['history'], storage: 'sqlite', retention: { historySeconds: 0, maxEvents: 0 }, limits: { maxFrameBytes: 0, maxConnections: 0, maxPresenceBytes: 0, maxDocumentUpdateBytes: 0 }, budget: { maxPersistentEventsPerUtcDay: 100000 }, auth: { mode: 'public', allowedOrigins: ['*'] } })
  assert.ok(issues.some(({ code }) => code === 'capability_dependency'))
  assert.ok(issues.filter(({ code }) => code === 'range').length >= 6)
  assert.ok(issues.some(({ code }) => code === 'auth_mode'))
  assert.ok(issues.some(({ code }) => code === 'origins'))
  assert.ok(issues.some(({ path }) => path === 'budget.maxPersistentEventsPerUtcDay'))
})

test('validates deterministic cost-aware event durability policies', () => {
  const base = { version: 'lacify.dev/room/v1', name: 'Chat', partitionBy: 'roomId', capabilities: ['events'], storage: 'sqlite', retention: { historySeconds: 60, maxEvents: 1 }, limits: { maxFrameBytes: 256, maxConnections: 1, maxPresenceBytes: 64, maxDocumentUpdateBytes: 256 }, budget: { maxPersistentEventsPerUtcDay: 1 }, auth: { mode: 'token', allowedOrigins: ['https://app.example.com'] } }
  const issues = validateRoomDocument({ ...base, events: [{ name: 'MessageSent', durability: 'segmented', batchSize: 1, retryFlushMs: 10 }, { name: 'MessageSent', durability: 'forever' }] })
  assert.ok(issues.some(({ path }) => path === 'events.0.batchSize'))
  assert.ok(issues.some(({ path }) => path === 'events.0.retryFlushMs'))
  assert.ok(issues.some(({ path }) => path === 'events.1.durability'))
  assert.ok(issues.some(({ code }) => code === 'duplicate'))
})

test('reports missing room files', async () => {
  const root = await fixture()
  await writeFile(path.join(root, 'lacify.realtime.yaml'), 'version: lacify.dev/realtime/v1\nproject: collaboration\nruntime: realtime\nrooms:\n  - ./rooms/missing.room.yaml\n')
  const result = await loadRealtimeProject(path.join(root, 'lacify.realtime.yaml'))
  assert.equal(result.valid, false)
  assert.ok(result.issues.some(({ code }) => code === 'missing_file'))
})
