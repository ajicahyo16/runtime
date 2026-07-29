import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fingerprint, stableStringify } from './index.mjs'

function roomId(source) {
  return path.basename(source, '.room.yaml')
}

function workerSource(project, rooms, { faultInjection = false } = {}) {
  const roomContracts = Object.fromEntries(rooms.map((room) => [room.id, room]))
  return `import { DurableObject } from 'cloudflare:workers'
import { hashRealtimeIdentity, realtimeTokenFromRequest, verifyRealtimeToken } from './realtime-auth.js'
import { decodeRealtimeFrame, encodeRealtimeFrame, realtimeErrorFrame, RealtimeProtocolError, realtimeProtocolVersion } from './realtime-protocol.js'

const projectId = ${JSON.stringify(project)}
const roomContracts = ${JSON.stringify(roomContracts)}
const roomIdPattern = /^[A-Za-z0-9._~-]{1,128}$/
const replayLimit = 500
const maxSegmentBytes = 8388608
const faultInjectionEnabled = ${JSON.stringify(faultInjection)}

function responseError(code, message, status) {
  return Response.json({ success: false, error: { code, message } }, { status })
}

function selectedProtocol(request) {
  return (request.headers.get('sec-websocket-protocol') || '').split(',').map((value) => value.trim()).includes('lacify.realtime.v1')
}

export class RoomActor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.ctx = ctx
    this.env = env
    this.sql = ctx.storage.sql
    this.pendingSegments = new Map()
    this.segmentRecoveries = new Map()
    this.injectedFaults = new Set()
    this.sql.exec('CREATE TABLE IF NOT EXISTS _lacify_room_events (room_seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, client_seq INTEGER NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL)')
    this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS _lacify_room_client_events ON _lacify_room_events (client_id, client_seq)')
    this.sql.exec('CREATE TABLE IF NOT EXISTS _lacify_room_cursors (client_id TEXT PRIMARY KEY, last_client_seq INTEGER NOT NULL, last_room_seq INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
    this.sql.exec("CREATE TABLE IF NOT EXISTS _lacify_room_segments (segment_key TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('pending', 'committed')), event_ids TEXT NOT NULL, event_count INTEGER NOT NULL, first_event_at INTEGER NOT NULL, last_event_at INTEGER NOT NULL, uncompressed_bytes INTEGER NOT NULL, checksum TEXT NOT NULL, pending_body TEXT, created_at INTEGER NOT NULL, committed_at INTEGER)")
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'))
  }

  config(ws) {
    const attachment = ws.deserializeAttachment()
    return attachment && attachment.config ? attachment : null
  }

  send(ws, value) {
    const attachment = this.config(ws)
    if (!attachment) return false
    const maximumQueueBytes = Math.min(1048576, attachment.config.limits.maxFrameBytes * 16)
    if (Number(ws.bufferedAmount || 0) > maximumQueueBytes) {
      try { ws.close(1013, 'slow_consumer') } catch {}
      return false
    }
    try {
      ws.send(encodeRealtimeFrame(value))
      return true
    } catch {
      return false
    }
  }

  broadcast(value, except = null) {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== except) this.send(socket, value)
    }
  }

  dailyUsage(config, now = Date.now()) {
    const utcDay = Math.floor(now / 86400000)
    if (this.usage?.utcDay === utcDay) return this.usage
    const dayStart = utcDay * 86400000
    const persisted = Number([...this.sql.exec('SELECT COUNT(*) AS value FROM _lacify_room_events WHERE created_at >= ?', dayStart)][0]?.value || 0)
    this.usage = { utcDay, persisted, limit: config.budget.maxPersistentEventsPerUtcDay }
    return this.usage
  }

  eventPolicy(config, name) {
    return config.events.find((event) => event.name === name) || { name, durability: 'immediate' }
  }

  fault(point) {
    if (!faultInjectionEnabled || this.env.LACIFY_REALTIME_FAULT_POINT !== point || this.injectedFaults.has(point)) return
    this.injectedFaults.add(point)
    throw new RealtimeProtocolError('injected_' + point, 'Injected realtime recovery fault.')
  }

  async fetch(request) {
    if (request.method === 'POST' && new URL(request.url).pathname === '/internal/events') {
      let envelope
      try { envelope = await request.json() } catch { return responseError('invalid_json', 'Internal event must be JSON.', 400) }
      let internal
      try { internal = JSON.parse(request.headers.get('x-lacify-realtime-internal') || '') } catch { return responseError('internal_auth', 'Validated internal event metadata is required.', 401) }
      if (!internal?.config || !roomContracts[internal.config.id]) return responseError('internal_auth', 'Validated internal event metadata is required.', 401)
      return this.handleServerEvent(envelope, internal)
    }
    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return responseError('upgrade_required', 'WebSocket upgrade required.', 426)
    let connection
    try { connection = JSON.parse(request.headers.get('x-lacify-realtime-connection') || '') } catch { return responseError('internal_auth', 'Validated realtime connection metadata is required.', 401) }
    const config = connection?.config
    if (!config || !roomContracts[config.id] || this.ctx.getWebSockets().length >= config.limits.maxConnections) return responseError('room_capacity', 'Room connection limit reached.', 503)
    await this.recoverPendingSegments()
    await this.compactSegments(connection)
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    const persistedCursor = [...this.sql.exec('SELECT last_client_seq FROM _lacify_room_cursors WHERE client_id = ?', connection.clientId)][0]
    const retainedCursor = [...this.sql.exec('SELECT MAX(client_seq) AS value FROM _lacify_room_events WHERE client_id = ?', connection.clientId)][0]
    const usage = this.dailyUsage(config)
    const attachment = {
      connectionId: crypto.randomUUID(),
      clientId: connection.clientId,
      subjectHash: connection.subjectHash,
      capabilities: connection.capabilities,
      lastAck: 0,
      lastClientSeq: Math.max(Number(persistedCursor?.last_client_seq || 0), Number(retainedCursor?.value || 0)),
      config,
      roomStoragePrefix: connection.roomStoragePrefix,
      joinedAt: Date.now(),
    }
    server.serializeAttachment(attachment)
    this.ctx.acceptWebSocket(server)
    const latest = Number([...this.sql.exec('SELECT MAX(room_seq) AS value FROM _lacify_room_events')][0]?.value || 0)
    this.send(server, { type: 'hello', protocol: realtimeProtocolVersion, connectionId: attachment.connectionId, roomSeq: latest, capabilities: attachment.capabilities, budget: { persistentEventsUsed: usage.persisted, persistentEventsLimit: usage.limit, resetsAt: (usage.utcDay + 1) * 86400000 } })
    if (attachment.capabilities.includes('presence')) this.broadcast({ type: 'presence', action: 'join', connectionId: attachment.connectionId }, server)
    const headers = selectedProtocol(request) ? { 'sec-websocket-protocol': 'lacify.realtime.v1' } : undefined
    return new Response(null, { status: 101, webSocket: client, headers })
  }

  async handleServerEvent(envelope, attachment) {
    const config = attachment.config
    if (!config.capabilities.includes('events')) return responseError('capability_forbidden', 'This room does not accept events.', 403)
    const policy = config.events.find((event) => event.name === envelope.event)
    if (!policy) return responseError('event_not_declared', 'Server event is not declared by this room.', 422)
    const existing = [...this.sql.exec('SELECT room_seq FROM _lacify_room_events WHERE event_id = ?', envelope.eventId)][0]
    if (existing) return Response.json({ success: true, eventId: envelope.eventId, duplicate: true, roomSeq: Number(existing.room_seq) }, { status: 409 })
    const cataloged = [...this.sql.exec("SELECT segment_key, status, pending_body, checksum, uncompressed_bytes FROM _lacify_room_segments WHERE EXISTS (SELECT 1 FROM json_each(event_ids) WHERE json_each.value = ?) ORDER BY created_at DESC LIMIT 1", envelope.eventId)][0]
    if (cataloged) {
      if (cataloged.status === 'pending') await this.recoverSegment(cataloged)
      return Response.json({ success: true, eventId: envelope.eventId, duplicate: true, segment: cataloged.segment_key }, { status: 409 })
    }
    const occurredAt = Number.isSafeInteger(envelope.occurredAt) ? envelope.occurredAt : Date.now()
    if (occurredAt < Date.now() - (config.retention.historySeconds * 1000)) return responseError('event_outside_retention', 'Server event is older than the room retention window.', 422)
    const serverEvent = { type: 'event', eventId: envelope.eventId, name: envelope.event, payload: envelope.payload, createdAt: occurredAt, source: 'runtime' }
    if (policy.durability === 'ephemeral') {
      this.broadcast({ ...serverEvent, durability: 'ephemeral' })
      return Response.json({ success: true, eventId: envelope.eventId, durability: 'ephemeral' }, { status: 202 })
    }
    const usage = this.dailyUsage(config, occurredAt)
    if (usage.persisted >= usage.limit) return responseError('room_daily_write_budget', 'This room reached its persistent event budget for the current UTC day.', 429)
    if (policy.durability === 'segmented') {
      const bucket = this.pendingSegments.get(policy.name) || []
      let pending = bucket.find((entry) => entry.eventId === envelope.eventId)
      if (!pending) {
        pending = { eventId: envelope.eventId, clientId: '__runtime__', clientSeq: 0, name: envelope.event, payload: envelope.payload, acceptedAt: occurredAt, connectionId: null }
        bucket.push(pending)
        this.pendingSegments.set(policy.name, bucket)
      }
      if (bucket.length >= policy.batchSize || Date.now() - pending.acceptedAt >= policy.retryFlushMs) {
        const entries = bucket.splice(0, Math.max(policy.batchSize, bucket.length))
        await this.flushSegment(attachment, policy, entries)
        for (const entry of entries) this.broadcast({ type: 'event', eventId: entry.eventId, name: entry.name, payload: entry.payload, createdAt: entry.acceptedAt, source: entry.clientId === '__runtime__' ? 'runtime' : 'client', durability: 'segmented', durable: true })
      }
      const committed = [...this.sql.exec("SELECT segment_key FROM _lacify_room_segments WHERE status = 'committed' AND EXISTS (SELECT 1 FROM json_each(event_ids) WHERE json_each.value = ?) LIMIT 1", envelope.eventId)][0]
      if (!committed) return responseError('segment_pending', 'Server event is accepted but not durable yet; retry is required.', 503)
      usage.persisted += 1
      return Response.json({ success: true, eventId: envelope.eventId, durability: 'segmented', segment: committed.segment_key }, { status: 202 })
    }
    let roomSeq
    this.ctx.storage.transactionSync(() => {
      const clientSeq = Number([...this.sql.exec("SELECT MAX(client_seq) AS value FROM _lacify_room_events WHERE client_id = '__runtime__'")][0]?.value || 0) + 1
      const inserted = [...this.sql.exec('INSERT INTO _lacify_room_events (event_id, client_id, client_seq, name, payload, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING room_seq', envelope.eventId, '__runtime__', clientSeq, envelope.event, JSON.stringify(envelope.payload), occurredAt)][0]
      roomSeq = Number(inserted.room_seq)
    })
    usage.persisted += 1
    this.broadcast({ ...serverEvent, roomSeq, durability: 'immediate' })
    return Response.json({ success: true, eventId: envelope.eventId, durability: 'immediate', roomSeq }, { status: 202 })
  }

  async handleEvent(ws, attachment, frame) {
    if (!attachment.capabilities.includes('events')) throw new RealtimeProtocolError('capability_forbidden', 'This connection cannot publish events.')
    const policy = this.eventPolicy(attachment.config, frame.name)
    if (policy.durability === 'ephemeral') {
      this.send(ws, { type: 'ack', eventId: frame.eventId, level: 'accepted', durability: 'ephemeral' })
      this.broadcast({ type: 'event', eventId: frame.eventId, name: frame.name, payload: frame.payload, durability: 'ephemeral', createdAt: Date.now() }, ws)
      return
    }
    if (policy.durability === 'segmented') {
      await this.handleSegmentedEvent(ws, attachment, frame, policy)
      return
    }
    const existing = [...this.sql.exec('SELECT room_seq FROM _lacify_room_events WHERE event_id = ?', frame.eventId)][0]
    if (existing) {
      this.send(ws, { type: 'ack', eventId: frame.eventId, roomSeq: Number(existing.room_seq), replayed: true, level: 'durable', durability: 'immediate' })
      return
    }
    let roomSeq
    const now = Date.now()
    const usage = this.dailyUsage(attachment.config, now)
    if (usage.persisted >= usage.limit) throw new RealtimeProtocolError('room_daily_write_budget', 'This room reached its persistent event budget for the current UTC day.')
    this.ctx.storage.transactionSync(() => {
      const expected = Number(attachment.lastClientSeq || 0) + 1
      if (frame.clientSeq !== expected) throw new RealtimeProtocolError('client_sequence_gap', 'Client sequence must be contiguous.')
      const inserted = [...this.sql.exec('INSERT INTO _lacify_room_events (event_id, client_id, client_seq, name, payload, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING room_seq', frame.eventId, attachment.clientId, frame.clientSeq, frame.name, JSON.stringify(frame.payload), now)][0]
      roomSeq = Number(inserted.room_seq)
      if (roomSeq % 128 === 0) {
        this.sql.exec('DELETE FROM _lacify_room_events WHERE room_seq IN (SELECT room_seq FROM _lacify_room_events WHERE room_seq <= ? OR created_at < ? ORDER BY room_seq LIMIT 128)', Math.max(0, roomSeq - attachment.config.retention.maxEvents), now - (attachment.config.retention.historySeconds * 1000))
      }
    })
    usage.persisted += 1
    attachment.lastClientSeq = frame.clientSeq
    ws.serializeAttachment(attachment)
    const event = { type: 'event', roomSeq, eventId: frame.eventId, name: frame.name, payload: frame.payload, createdAt: now }
    this.send(ws, { type: 'ack', eventId: frame.eventId, roomSeq, replayed: false, level: 'durable', durability: 'immediate' })
    this.broadcast({ ...event, durability: 'immediate' })
  }

  async handleSegmentedEvent(ws, attachment, frame, policy) {
    const cataloged = [...this.sql.exec("SELECT segment_key, status, pending_body, checksum, uncompressed_bytes, event_ids FROM _lacify_room_segments WHERE EXISTS (SELECT 1 FROM json_each(event_ids) WHERE json_each.value = ?) ORDER BY created_at DESC LIMIT 1", frame.eventId)][0]
    if (cataloged) {
      if (cataloged.status === 'pending') await this.recoverSegment(cataloged)
      this.send(ws, { type: 'ack', eventId: frame.eventId, level: 'durable', durability: 'segmented', segment: cataloged.segment_key, replayed: true })
      return
    }
    const bucket = this.pendingSegments.get(policy.name) || []
    const pending = bucket.find((entry) => entry.eventId === frame.eventId)
    if (pending) {
      this.send(ws, { type: 'ack', eventId: frame.eventId, level: 'accepted', durability: 'segmented', replayed: true })
      if (Date.now() - pending.acceptedAt >= policy.retryFlushMs) await this.flushSegment(attachment, policy, bucket.splice(0, bucket.length))
      return
    }
    const acceptedAt = Date.now()
    bucket.push({ eventId: frame.eventId, clientId: attachment.clientId, clientSeq: frame.clientSeq, name: frame.name, payload: frame.payload, acceptedAt, connectionId: attachment.connectionId })
    this.pendingSegments.set(policy.name, bucket)
    this.send(ws, { type: 'ack', eventId: frame.eventId, level: 'accepted', durability: 'segmented', retryUntilDurable: true })
    this.broadcast({ type: 'event', eventId: frame.eventId, name: frame.name, payload: frame.payload, durability: 'segmented', durable: false, createdAt: acceptedAt })
    if (bucket.length >= policy.batchSize) await this.flushSegment(attachment, policy, bucket.splice(0, policy.batchSize))
  }

  async flushSegment(attachment, policy, entries) {
    if (!this.env.HISTORY || !entries.length) throw new RealtimeProtocolError('history_storage_unavailable', 'Segmented history storage is unavailable.')
    const identity = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(entries.map((entry) => entry.eventId).join('\\n')))
    const digest = [...new Uint8Array(identity)].map((value) => value.toString(16).padStart(2, '0')).join('').slice(0, 24)
    const segmentKey = attachment.roomStoragePrefix + String(entries[0].acceptedAt).padStart(13, '0') + '-' + digest + '.json.gz'
    const stored = entries.map(({ connectionId, ...event }) => event)
    const body = JSON.stringify({ format: 'lacify-realtime-segment/v1', encoding: 'gzip', eventName: policy.name, events: stored })
    const uncompressedBytes = new TextEncoder().encode(body).byteLength
    if (uncompressedBytes > Math.min(maxSegmentBytes, attachment.config.limits.maxFrameBytes * policy.batchSize)) throw new RealtimeProtocolError('history_segment_too_large', 'Segment exceeds its bounded uncompressed size.')
    const checksumBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
    const checksum = [...new Uint8Array(checksumBytes)].map((value) => value.toString(16).padStart(2, '0')).join('')
    this.sql.exec("INSERT OR IGNORE INTO _lacify_room_segments (segment_key, status, event_ids, event_count, first_event_at, last_event_at, uncompressed_bytes, checksum, pending_body, created_at) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)", segmentKey, JSON.stringify(stored.map((event) => event.eventId)), stored.length, stored[0].acceptedAt, stored[stored.length - 1].acceptedAt, uncompressedBytes, checksum, body, Date.now())
    this.fault('after_intent')
    await this.recoverSegment({ segment_key: segmentKey, status: 'pending', pending_body: body, checksum, uncompressed_bytes: uncompressedBytes })
    this.fault('after_commit')
    for (const entry of entries) {
      const target = this.ctx.getWebSockets().find((socket) => this.config(socket)?.connectionId === entry.connectionId)
      if (target) this.send(target, { type: 'ack', eventId: entry.eventId, level: 'durable', durability: 'segmented', segment: segmentKey })
    }
    this.broadcast({ type: 'segment_committed', segment: segmentKey, eventCount: stored.length })
    await this.compactSegments(attachment)
  }

  async compactSegments(attachment) {
    if (!this.env.HISTORY || !attachment?.config || !attachment.roomStoragePrefix) return
    const cutoff = Date.now() - (attachment.config.retention.historySeconds * 1000)
    const rows = [...this.sql.exec("SELECT segment_key FROM _lacify_room_segments WHERE status = 'committed' AND last_event_at < ? AND segment_key LIKE ? ORDER BY last_event_at LIMIT 16", cutoff, attachment.roomStoragePrefix + '%')]
    for (const row of rows) {
      await this.env.HISTORY.delete(row.segment_key)
      this.sql.exec("DELETE FROM _lacify_room_segments WHERE segment_key = ? AND status = 'committed'", row.segment_key)
    }
  }

  async recoverSegment(row) {
    const existing = this.segmentRecoveries.get(row.segment_key)
    if (existing) return existing
    const recovery = this.performSegmentRecovery(row).finally(() => this.segmentRecoveries.delete(row.segment_key))
    this.segmentRecoveries.set(row.segment_key, recovery)
    return recovery
  }

  async recoverPendingSegments() {
    const rows = [...this.sql.exec("SELECT segment_key, status, pending_body, checksum, uncompressed_bytes FROM _lacify_room_segments WHERE status = 'pending' ORDER BY created_at LIMIT 16")]
    for (const row of rows) await this.recoverSegment(row)
  }

  async performSegmentRecovery(row) {
    if (!this.env.HISTORY) throw new RealtimeProtocolError('history_storage_unavailable', 'Segmented history storage is unavailable.')
    let object = await this.env.HISTORY.head(row.segment_key)
    if (!object) {
      if (!row.pending_body) throw new RealtimeProtocolError('history_recovery_body_missing', 'Pending segment cannot be recovered safely.')
      const compressed = await new Response(new Response(row.pending_body).body.pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
      await this.env.HISTORY.put(row.segment_key, compressed, { httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' }, customMetadata: { checksum: row.checksum, uncompressedBytes: String(row.uncompressed_bytes) } })
      object = await this.env.HISTORY.head(row.segment_key)
    }
    if (object?.customMetadata?.checksum && object.customMetadata.checksum !== row.checksum) throw new RealtimeProtocolError('history_checksum_mismatch', 'Stored segment checksum does not match its catalog intent.')
    this.fault('after_r2')
    this.sql.exec("UPDATE _lacify_room_segments SET status = 'committed', pending_body = NULL, committed_at = ? WHERE segment_key = ? AND status = 'pending'", Date.now(), row.segment_key)
  }

  async handleSegmentResume(ws, attachment, frame) {
    if (!attachment.capabilities.includes('history')) throw new RealtimeProtocolError('capability_forbidden', 'This connection cannot replay history.')
    const rows = frame.afterSegment
      ? [...this.sql.exec("SELECT segment_key, event_count, uncompressed_bytes, checksum FROM _lacify_room_segments WHERE status = 'committed' AND segment_key > ? ORDER BY segment_key LIMIT 11", frame.afterSegment)]
      : [...this.sql.exec("SELECT segment_key, event_count, uncompressed_bytes, checksum FROM _lacify_room_segments WHERE status = 'committed' ORDER BY segment_key LIMIT 11")]
    if (rows.length > 10) {
      this.send(ws, { type: 'resync_required', reason: 'segment_replay_limit', nextSegment: rows[0].segment_key })
      return
    }
    for (const row of rows) {
      const object = await this.env.HISTORY.get(row.segment_key)
      if (!object) throw new RealtimeProtocolError('history_segment_missing', 'A committed history segment is unavailable.')
      const compressed = await object.arrayBuffer()
      if (compressed.byteLength > maxSegmentBytes) throw new RealtimeProtocolError('history_segment_too_large', 'Compressed segment exceeds its read limit.')
      const body = await new Response(compressed).body.pipeThrough(new DecompressionStream('gzip')).getReader()
      const chunks = []
      let total = 0
      while (true) {
        const { done, value } = await body.read()
        if (done) break
        total += value.byteLength
        if (total > Number(row.uncompressed_bytes) || total > maxSegmentBytes) throw new RealtimeProtocolError('history_decompression_limit', 'Segment exceeded its declared decompression limit.')
        chunks.push(value)
      }
      const merged = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
      const text = new TextDecoder().decode(merged)
      const digest = await crypto.subtle.digest('SHA-256', merged)
      const checksum = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
      if (checksum !== row.checksum) throw new RealtimeProtocolError('history_checksum_mismatch', 'History segment failed checksum verification.')
      this.send(ws, { type: 'history_segment', segment: row.segment_key, eventCount: Number(row.event_count), body: JSON.parse(text) })
    }
    this.send(ws, { type: 'segment_replay_complete', afterSegment: frame.afterSegment || null, segmentCount: rows.length, latestSegment: rows.at(-1)?.segment_key || frame.afterSegment || null })
  }

  handleResume(ws, attachment, frame) {
    if (!attachment.capabilities.includes('history')) throw new RealtimeProtocolError('capability_forbidden', 'This connection cannot replay history.')
    const minimum = Number([...this.sql.exec('SELECT MIN(room_seq) AS value FROM _lacify_room_events')][0]?.value || 0)
    const latest = Number([...this.sql.exec('SELECT MAX(room_seq) AS value FROM _lacify_room_events')][0]?.value || 0)
    if (minimum > 0 && frame.lastRoomSeq < minimum - 1) {
      this.send(ws, { type: 'resync_required', reason: 'history_compacted', earliestRoomSeq: minimum, latestRoomSeq: latest })
      return
    }
    const rows = [...this.sql.exec('SELECT room_seq, event_id, name, payload, created_at FROM _lacify_room_events WHERE room_seq > ? ORDER BY room_seq LIMIT ?', frame.lastRoomSeq, replayLimit + 1)]
    if (rows.length > replayLimit) {
      this.send(ws, { type: 'resync_required', reason: 'replay_limit', earliestRoomSeq: minimum, latestRoomSeq: latest })
      return
    }
    for (const row of rows) this.send(ws, { type: 'event', roomSeq: Number(row.room_seq), eventId: row.event_id, name: row.name, payload: JSON.parse(row.payload), createdAt: Number(row.created_at), replayed: true })
    this.send(ws, { type: 'replay_complete', fromRoomSeq: frame.lastRoomSeq, latestRoomSeq: latest, eventCount: rows.length })
  }

  async webSocketMessage(ws, message) {
    const attachment = this.config(ws)
    if (!attachment) {
      try { ws.close(1008, 'connection_state_missing') } catch {}
      return
    }
    try {
      const frame = decodeRealtimeFrame(message, attachment.config.limits)
      if (frame.type === 'event') await this.handleEvent(ws, attachment, frame)
      else if (frame.type === 'resume') this.handleResume(ws, attachment, frame)
      else if (frame.type === 'segment_resume') await this.handleSegmentResume(ws, attachment, frame)
      else if (frame.type === 'ack') {
        const latest = Number([...this.sql.exec('SELECT MAX(room_seq) AS value FROM _lacify_room_events')][0]?.value || 0)
        attachment.lastAck = Math.max(attachment.lastAck, Math.min(frame.roomSeq, latest))
        ws.serializeAttachment(attachment)
      } else if (frame.type === 'presence') {
        if (!attachment.capabilities.includes('presence')) throw new RealtimeProtocolError('capability_forbidden', 'This connection cannot publish presence.')
        this.broadcast({ type: 'presence', action: 'update', connectionId: attachment.connectionId, state: frame.state }, ws)
      } else this.send(ws, { type: 'pong', ...(frame.nonce === undefined ? {} : { nonce: frame.nonce }) })
    } catch (error) {
      this.send(ws, JSON.parse(realtimeErrorFrame(error)))
      if (error instanceof RealtimeProtocolError && [1003, 1009].includes(error.closeCode)) {
        try { ws.close(error.closeCode, error.code) } catch {}
      }
    }
  }

  webSocketClose(ws, code, reason) {
    const attachment = this.config(ws)
    this.checkpoint(attachment)
    if (attachment?.capabilities.includes('presence')) this.broadcast({ type: 'presence', action: 'leave', connectionId: attachment.connectionId }, ws)
    try { ws.close(code, reason) } catch {}
  }

  webSocketError(ws) {
    const attachment = this.config(ws)
    this.checkpoint(attachment)
    if (attachment?.capabilities.includes('presence')) this.broadcast({ type: 'presence', action: 'leave', connectionId: attachment.connectionId }, ws)
    try { ws.close(1011, 'socket_error') } catch {}
  }

  checkpoint(attachment) {
    if (!attachment || !Number.isSafeInteger(attachment.lastClientSeq) || attachment.lastClientSeq < 1) return
    this.sql.exec('INSERT INTO _lacify_room_cursors (client_id, last_client_seq, last_room_seq, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET last_client_seq = MAX(last_client_seq, excluded.last_client_seq), last_room_seq = MAX(last_room_seq, excluded.last_room_seq), updated_at = excluded.updated_at', attachment.clientId, attachment.lastClientSeq, attachment.lastAck, Date.now())
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/__lacify/realtime/health') return Response.json({ ok: true, runtime: 'realtime', project: projectId, roomClasses: Object.keys(roomContracts), hibernation: true, sqlite: true, budgets: Object.values(roomContracts).map((room) => ({ roomClass: room.id, maxConnections: room.limits.maxConnections, maxPersistentEventsPerUtcDay: room.budget.maxPersistentEventsPerUtcDay, maxFrameBytes: room.limits.maxFrameBytes })) })
    if (url.pathname === '/v1/internal/events' && request.method === 'POST') {
      if (!env.LACIFY_REALTIME_SINK_SECRET || request.headers.get('x-lacify-event-sink-secret') !== env.LACIFY_REALTIME_SINK_SECRET) return responseError('sink_authentication_required', 'Realtime event sink authentication is required.', 401)
      const declaredLength = Number(request.headers.get('content-length') || 0)
      if (declaredLength > 262144) return responseError('event_size_limit', 'Realtime event exceeds its size limit.', 413)
      const body = await request.text()
      if (new TextEncoder().encode(body).byteLength > 262144) return responseError('event_size_limit', 'Realtime event exceeds its size limit.', 413)
      let envelope
      try { envelope = JSON.parse(body) } catch { return responseError('invalid_json', 'Realtime event must be JSON.', 400) }
      if (envelope?.version !== 'lacify.dev/event/v1' || envelope.target !== 'realtime' || typeof envelope.eventId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(envelope.eventId) || typeof envelope.event !== 'string' || !/^[A-Z][A-Za-z0-9]{0,62}$/.test(envelope.event) || !roomIdPattern.test(envelope.routing?.room || '')) return responseError('invalid_realtime_event', 'Realtime event contract is invalid.', 422)
      const config = roomContracts[envelope.routing?.roomClass]
      if (!config) return responseError('room_not_found', 'Realtime room class or ID is invalid.', 404)
      const environment = env.LACIFY_ENVIRONMENT || 'development'
      const roomKey = [projectId, environment, config.id, envelope.routing.room].join(':')
      const headers = new Headers({ 'content-type': 'application/json' })
      headers.set('x-lacify-realtime-internal', JSON.stringify({
        config,
        roomStoragePrefix: ['rooms', projectId, environment, config.id, envelope.routing.room, 'segments', ''].join('/'),
      }))
      return env.ROOMS.get(env.ROOMS.idFromName(roomKey)).fetch(new Request('https://lacify.internal/internal/events', { method: 'POST', headers, body }))
    }
    const match = /^\\/v1\\/realtime\\/([a-z0-9][a-z0-9-]{0,62})\\/([A-Za-z0-9._~-]{1,128})$/.exec(url.pathname)
    if (!match) return responseError('not_found', 'Realtime route not found.', 404)
    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return responseError('upgrade_required', 'WebSocket upgrade required.', 426)
    const [, roomClass, roomId] = match
    const config = roomContracts[roomClass]
    if (!config || !roomIdPattern.test(roomId)) return responseError('room_not_found', 'Realtime room class or ID is invalid.', 404)
    const origin = request.headers.get('origin')
    if (origin && !config.auth.allowedOrigins.includes(origin)) return responseError('origin_forbidden', 'Origin is not allowed for this room.', 403)
    const environment = env.LACIFY_ENVIRONMENT || 'development'
    const credential = realtimeTokenFromRequest(request)
    if (!credential.token) return responseError('authentication_required', 'Short-lived realtime authorization is required.', 401)
    let claims
    try {
      claims = await verifyRealtimeToken(credential.token, {
        secret: env.LACIFY_REALTIME_TOKEN_SECRET,
        expected: { aud: projectId, env: environment, roomClass, room: roomId },
      })
    } catch (error) {
      return responseError(error?.code || 'authentication_failed', 'Realtime authorization failed.', 401)
    }
    const allowedCapabilities = config.capabilities.filter((capability) => claims.capabilities.includes(capability))
    if (!allowedCapabilities.length) return responseError('capability_forbidden', 'Realtime token has no capability for this room.', 403)
    const forwardedHeaders = new Headers(request.headers)
    forwardedHeaders.delete('authorization')
    forwardedHeaders.set('x-lacify-realtime-connection', JSON.stringify({
      clientId: claims.cid,
      subjectHash: await hashRealtimeIdentity(claims.sub),
      capabilities: allowedCapabilities,
      config,
      roomStoragePrefix: ['rooms', projectId, environment, roomClass, roomId, 'segments', ''].join('/'),
    }))
    const roomKey = [projectId, environment, roomClass, roomId].join(':')
    return env.ROOMS.get(env.ROOMS.idFromName(roomKey)).fetch(new Request(request, { headers: forwardedHeaders }))
  },
}
`
}

export async function compileRealtimeRelease(loaded, options = {}) {
  if (!loaded?.valid || !loaded.project || !loaded.fingerprint) throw new Error('A valid realtime project is required before compilation.')
  const project = loaded.project.realtime.project
  const rooms = loaded.project.rooms.map(({ source, definition }) => ({
    id: roomId(source),
    name: definition.name,
    partitionBy: definition.partitionBy,
    capabilities: [...definition.capabilities],
    storage: definition.storage,
    retention: definition.retention,
    limits: definition.limits,
    budget: definition.budget,
    events: definition.events,
    auth: definition.auth,
  })).sort((left, right) => left.id.localeCompare(right.id))
  const manifest = {
    format: 'lacify-realtime-release/v1',
    project,
    sourceFingerprint: loaded.fingerprint,
    runtime: 'realtime',
    substrate: 'room-actor',
    roomClasses: rooms,
    protocol: 'lacify.realtime.protocol/v1',
    deployment: { remoteMutation: false },
  }
  const authSource = await readFile(new URL('./realtime-auth.mjs', import.meta.url), 'utf8')
  const protocolSource = await readFile(new URL('./realtime-protocol.mjs', import.meta.url), 'utf8')
  const artifact = {
    'manifest.json': `${stableStringify(manifest)}\n`,
    'worker.js': workerSource(project, rooms, { faultInjection: options.testFaultInjection === true }),
    'realtime-auth.js': authSource,
    'realtime-protocol.js': protocolSource,
    'schema.sql': [
      'CREATE TABLE _lacify_room_events (room_seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, client_seq INTEGER NOT NULL, name TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);',
      'CREATE TABLE _lacify_room_cursors (client_id TEXT PRIMARY KEY, last_client_seq INTEGER NOT NULL, last_room_seq INTEGER NOT NULL, updated_at INTEGER NOT NULL);',
      "CREATE TABLE _lacify_room_segments (segment_key TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('pending', 'committed')), event_ids TEXT NOT NULL, event_count INTEGER NOT NULL, first_event_at INTEGER NOT NULL, last_event_at INTEGER NOT NULL, uncompressed_bytes INTEGER NOT NULL, checksum TEXT NOT NULL, pending_body TEXT, created_at INTEGER NOT NULL, committed_at INTEGER);",
      '',
    ].join('\n'),
    'wrangler.jsonc': `${JSON.stringify({
      name: `lacify-realtime-${project}`,
      main: 'worker.js',
      compatibility_date: '2026-07-24',
      durable_objects: { bindings: [{ name: 'ROOMS', class_name: 'RoomActor' }] },
      r2_buckets: [{ binding: 'HISTORY', bucket_name: `lacify-realtime-${project}-history` }],
      migrations: [{ tag: 'r1', new_sqlite_classes: ['RoomActor'] }],
      vars: { LACIFY_ENVIRONMENT: 'development' },
    }, null, 2)}\n`,
    'r2-lifecycle.json': `${JSON.stringify({
      format: 'lacify-r2-lifecycle/v1',
      bucket: `lacify-realtime-${project}-history`,
      remoteMutation: false,
      rules: [{
        prefix: `rooms/${project}/`,
        expireAfterDays: Math.max(1, Math.ceil(Math.max(...rooms.map((room) => room.retention.historySeconds)) / 86400) + 1),
        rationale: 'Safety-net expiry after Room Actor catalog compaction.',
      }],
    }, null, 2)}\n`,
  }
  const checksum = fingerprint({ manifest, artifact })
  return { checksum, manifest, artifact }
}
