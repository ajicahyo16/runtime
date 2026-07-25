const encoder = new TextEncoder()
const frameTypes = new Set(['event', 'resume', 'segment_resume', 'ack', 'presence', 'ping'])
const eventNamePattern = /^[A-Z][A-Za-z0-9]{0,62}$/
const eventIdPattern = /^[A-Za-z0-9._:-]{1,128}$/

export class RealtimeProtocolError extends Error {
  constructor(code, message, closeCode = 1008) {
    super(message)
    this.name = 'RealtimeProtocolError'
    this.code = code
    this.closeCode = closeCode
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unknownFields(value, allowed) {
  return Object.keys(value).find((key) => !allowed.includes(key))
}

function boundedSequence(value, allowZero = false) {
  return Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1)
}

export function decodeRealtimeFrame(message, limits) {
  if (typeof message !== 'string') throw new RealtimeProtocolError('binary_not_supported', 'Binary realtime frames are not enabled for this room.', 1003)
  const size = encoder.encode(message).byteLength
  if (size > limits.maxFrameBytes) throw new RealtimeProtocolError('frame_too_large', 'Realtime frame exceeds the room limit.', 1009)
  let value
  try {
    value = JSON.parse(message)
  } catch {
    throw new RealtimeProtocolError('invalid_json', 'Realtime frame must be valid JSON.')
  }
  if (!isRecord(value) || !frameTypes.has(value.type)) throw new RealtimeProtocolError('frame_type', 'Realtime frame type is unsupported.')
  if (value.type === 'event') {
    if (unknownFields(value, ['type', 'eventId', 'clientSeq', 'name', 'payload'])) throw new RealtimeProtocolError('unknown_field', 'Realtime event contains an unknown field.')
    if (typeof value.eventId !== 'string' || !eventIdPattern.test(value.eventId)) throw new RealtimeProtocolError('event_id', 'Realtime event ID is invalid.')
    if (!boundedSequence(value.clientSeq)) throw new RealtimeProtocolError('client_sequence', 'Client sequence must be a positive safe integer.')
    if (typeof value.name !== 'string' || !eventNamePattern.test(value.name)) throw new RealtimeProtocolError('event_name', 'Realtime event name is invalid.')
    if (!isRecord(value.payload)) throw new RealtimeProtocolError('event_payload', 'Realtime event payload must be an object.')
    return { type: 'event', eventId: value.eventId, clientSeq: value.clientSeq, name: value.name, payload: value.payload }
  }
  if (value.type === 'resume') {
    if (unknownFields(value, ['type', 'lastRoomSeq'])) throw new RealtimeProtocolError('unknown_field', 'Realtime resume contains an unknown field.')
    if (!boundedSequence(value.lastRoomSeq, true)) throw new RealtimeProtocolError('room_sequence', 'Resume sequence must be a non-negative safe integer.')
    return { type: 'resume', lastRoomSeq: value.lastRoomSeq }
  }
  if (value.type === 'segment_resume') {
    if (unknownFields(value, ['type', 'afterSegment'])) throw new RealtimeProtocolError('unknown_field', 'Segment resume contains an unknown field.')
    if (value.afterSegment !== undefined && (typeof value.afterSegment !== 'string' || value.afterSegment.length > 256)) throw new RealtimeProtocolError('segment_cursor', 'Segment cursor is invalid.')
    return { type: 'segment_resume', ...(value.afterSegment === undefined ? {} : { afterSegment: value.afterSegment }) }
  }
  if (value.type === 'ack') {
    if (unknownFields(value, ['type', 'roomSeq'])) throw new RealtimeProtocolError('unknown_field', 'Realtime acknowledgement contains an unknown field.')
    if (!boundedSequence(value.roomSeq, true)) throw new RealtimeProtocolError('room_sequence', 'Acknowledged sequence must be a non-negative safe integer.')
    return { type: 'ack', roomSeq: value.roomSeq }
  }
  if (value.type === 'presence') {
    if (unknownFields(value, ['type', 'state'])) throw new RealtimeProtocolError('unknown_field', 'Presence frame contains an unknown field.')
    if (!isRecord(value.state) || encoder.encode(JSON.stringify(value.state)).byteLength > limits.maxPresenceBytes) throw new RealtimeProtocolError('presence_size', 'Presence state must be an object within the room limit.')
    return { type: 'presence', state: value.state }
  }
  if (unknownFields(value, ['type', 'nonce'])) throw new RealtimeProtocolError('unknown_field', 'Ping frame contains an unknown field.')
  if (value.nonce !== undefined && (typeof value.nonce !== 'string' || value.nonce.length > 128)) throw new RealtimeProtocolError('ping_nonce', 'Ping nonce is invalid.')
  return { type: 'ping', ...(value.nonce === undefined ? {} : { nonce: value.nonce }) }
}

export function encodeRealtimeFrame(value) {
  return JSON.stringify(value)
}

export function realtimeErrorFrame(error) {
  const code = error instanceof RealtimeProtocolError ? error.code : 'internal_error'
  const message = error instanceof RealtimeProtocolError ? error.message : 'Realtime operation failed.'
  return encodeRealtimeFrame({ type: 'error', code, message })
}

export const realtimeProtocolVersion = 'lacify.realtime.protocol/v1'
