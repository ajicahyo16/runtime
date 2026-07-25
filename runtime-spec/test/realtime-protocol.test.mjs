import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeRealtimeFrame, RealtimeProtocolError } from '../src/realtime-protocol.mjs'

const limits = { maxFrameBytes: 1024, maxPresenceBytes: 128 }

test('normalizes bounded event, resume, acknowledgement, presence, and ping frames', () => {
  assert.deepEqual(decodeRealtimeFrame('{"type":"event","eventId":"event-1","clientSeq":1,"name":"SendMessage","payload":{"text":"hello"}}', limits), {
    type: 'event',
    eventId: 'event-1',
    clientSeq: 1,
    name: 'SendMessage',
    payload: { text: 'hello' },
  })
  assert.deepEqual(decodeRealtimeFrame('{"type":"resume","lastRoomSeq":10}', limits), { type: 'resume', lastRoomSeq: 10 })
  assert.deepEqual(decodeRealtimeFrame('{"type":"segment_resume","afterSegment":"rooms/a/1.json"}', limits), { type: 'segment_resume', afterSegment: 'rooms/a/1.json' })
  assert.deepEqual(decodeRealtimeFrame('{"type":"ack","roomSeq":10}', limits), { type: 'ack', roomSeq: 10 })
  assert.deepEqual(decodeRealtimeFrame('{"type":"presence","state":{"typing":true}}', limits), { type: 'presence', state: { typing: true } })
  assert.deepEqual(decodeRealtimeFrame('{"type":"ping","nonce":"a"}', limits), { type: 'ping', nonce: 'a' })
})

test('fails closed for oversized, binary, malformed, unknown, and sequence-invalid frames', () => {
  const code = (callback, expected) => assert.throws(callback, (error) => error instanceof RealtimeProtocolError && error.code === expected)
  code(() => decodeRealtimeFrame(new Uint8Array([1]).buffer, limits), 'binary_not_supported')
  code(() => decodeRealtimeFrame('x'.repeat(1025), limits), 'frame_too_large')
  code(() => decodeRealtimeFrame('{', limits), 'invalid_json')
  code(() => decodeRealtimeFrame('{"type":"other"}', limits), 'frame_type')
  code(() => decodeRealtimeFrame('{"type":"resume","lastRoomSeq":-1}', limits), 'room_sequence')
  code(() => decodeRealtimeFrame('{"type":"presence","state":{"text":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}', limits), 'presence_size')
  code(() => decodeRealtimeFrame('{"type":"ping","secret":true}', limits), 'unknown_field')
})
