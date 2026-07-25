import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { compileRealtimeRelease } from '../src/realtime-compiler.mjs'
import { loadRealtimeProject } from '../src/realtime-spec.mjs'

async function loadedFixture() {
  return loadRealtimeProject(path.join(import.meta.dirname, '../fixtures/realtime/lacify.realtime.yaml'))
}

test('compiles a deterministic standalone hibernating Room Actor artifact', async () => {
  const loaded = await loadedFixture()
  assert.equal(loaded.valid, true, JSON.stringify(loaded.issues))
  const first = await compileRealtimeRelease(loaded)
  const second = await compileRealtimeRelease(loaded)
  assert.equal(first.checksum, second.checksum)
  assert.deepEqual(first.artifact, second.artifact)
  assert.equal(first.manifest.runtime, 'realtime')
  assert.equal(first.manifest.deployment.remoteMutation, false)
  assert.deepEqual(first.manifest.roomClasses.map(({ id }) => id), ['chat'])
  assert.match(first.artifact['worker.js'], /ctx\.acceptWebSocket\(server\)/)
  assert.match(first.artifact['worker.js'], /serializeAttachment/)
  assert.match(first.artifact['worker.js'], /webSocketMessage/)
  assert.match(first.artifact['worker.js'], /transactionSync/)
  assert.match(first.artifact['worker.js'], /client_sequence_gap/)
  assert.match(first.artifact['worker.js'], /resync_required/)
  assert.match(first.artifact['worker.js'], /slow_consumer/)
  assert.match(first.artifact['worker.js'], /setWebSocketAutoResponse/)
  assert.match(first.artifact['worker.js'], /room_daily_write_budget/)
  assert.match(first.artifact['worker.js'], /INSERT INTO _lacify_room_events .* RETURNING room_seq/)
  assert.doesNotMatch(first.artifact['worker.js'], /UPDATE _lacify_room_meta/)
  assert.doesNotMatch(first.artifact['worker.js'], /\.accept\(\)/)
  assert.doesNotMatch(first.artifact['worker.js'], /searchParams\.get\(['"]token/)
  const wrangler = JSON.parse(first.artifact['wrangler.jsonc'])
  assert.deepEqual(wrangler.migrations[0].new_sqlite_classes, ['RoomActor'])
  assert.equal(wrangler.durable_objects.bindings[0].class_name, 'RoomActor')
  assert.equal(wrangler.r2_buckets[0].binding, 'HISTORY')
  const lifecycle = JSON.parse(first.artifact['r2-lifecycle.json'])
  assert.equal(lifecycle.remoteMutation, false)
  assert.equal(lifecycle.bucket, 'lacify-realtime-collaboration-history')
  assert.deepEqual(lifecycle.rules[0], {
    prefix: 'rooms/collaboration/',
    expireAfterDays: 2,
    rationale: 'Safety-net expiry after Room Actor catalog compaction.',
  })
  assert.match(first.artifact['worker.js'], /compactSegments/)
  assert.match(first.artifact['worker.js'], /lacify-realtime-segment\/v1/)
  assert.match(first.artifact['worker.js'], /level: 'accepted'/)
  assert.match(first.artifact['worker.js'], /level: 'durable'/)
  assert.match(first.artifact['worker.js'], /status = 'committed'/)
  assert.match(first.artifact['worker.js'], /CompressionStream\('gzip'\)/)
  assert.match(first.artifact['worker.js'], /DecompressionStream\('gzip'\)/)
  assert.match(first.artifact['worker.js'], /history_checksum_mismatch/)
  assert.match(first.artifact['worker.js'], /const faultInjectionEnabled = false/)
  const faultArtifact = await compileRealtimeRelease(loaded, { testFaultInjection: true })
  assert.match(faultArtifact.artifact['worker.js'], /const faultInjectionEnabled = true/)
})
