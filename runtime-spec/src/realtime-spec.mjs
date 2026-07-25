import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprint, parseYaml } from './index.mjs'

const projectKeys = new Set(['version', 'project', 'runtime', 'rooms'])
const roomKeys = new Set(['version', 'name', 'partitionBy', 'capabilities', 'storage', 'retention', 'limits', 'budget', 'events', 'auth'])
const retentionKeys = new Set(['historySeconds', 'maxEvents'])
const limitKeys = new Set(['maxFrameBytes', 'maxConnections', 'maxPresenceBytes', 'maxDocumentUpdateBytes'])
const budgetKeys = new Set(['maxPersistentEventsPerUtcDay'])
const eventKeys = new Set(['name', 'durability', 'batchSize', 'retryFlushMs'])
const authKeys = new Set(['mode', 'allowedOrigins'])
const projectIdPattern = /^[a-z0-9][a-z0-9-_]{0,62}$/
const roomNamePattern = /^[A-Z][A-Za-z0-9]{0,62}$/
const fieldNamePattern = /^[a-z][A-Za-z0-9]{0,62}$/
const roomPathPattern = /^\.\/rooms\/[a-z0-9][a-z0-9-]{0,62}\.room\.yaml$/
const capabilities = new Set(['events', 'presence', 'history', 'document'])
const maxYamlBytes = 256 * 1024

function issue(file, pathName, code, message) {
  return { file, path: pathName, line: 1, code, message }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unknownKeys(value, allowed, file, base, issues) {
  if (!isRecord(value)) return
  for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(issue(file, base ? `${base}.${key}` : key, 'unknown_field', `Unknown field "${key}".`))
}

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

export function validateRealtimeDocument(value, file = 'lacify.realtime.yaml') {
  const issues = []
  if (!isRecord(value)) return [issue(file, '', 'document_type', 'Realtime document must be an object.')]
  unknownKeys(value, projectKeys, file, '', issues)
  if (value.version !== 'lacify.dev/realtime/v1') issues.push(issue(file, 'version', 'version', 'Version must be "lacify.dev/realtime/v1".'))
  if (typeof value.project !== 'string' || !projectIdPattern.test(value.project)) issues.push(issue(file, 'project', 'identifier', 'Project must use 1–63 lowercase letters, numbers, hyphens, or underscores.'))
  if (value.runtime !== 'realtime') issues.push(issue(file, 'runtime', 'runtime_mode', 'Realtime Runtime v1 requires "realtime".'))
  if (!Array.isArray(value.rooms) || value.rooms.length < 1 || value.rooms.length > 64) issues.push(issue(file, 'rooms', 'array_size', 'Rooms must contain between 1 and 64 file references.'))
  else {
    const seen = new Set()
    value.rooms.forEach((entry, index) => {
      if (typeof entry !== 'string' || !roomPathPattern.test(entry)) issues.push(issue(file, `rooms.${index}`, 'room_path', 'Room paths must match ./rooms/<room-id>.room.yaml.'))
      if (seen.has(entry)) issues.push(issue(file, 'rooms', 'duplicate', `Room path "${entry}" is duplicated.`))
      seen.add(entry)
    })
  }
  return issues
}

export function validateRoomDocument(value, file = 'room.yaml') {
  const issues = []
  if (!isRecord(value)) return [issue(file, '', 'document_type', 'Room document must be an object.')]
  unknownKeys(value, roomKeys, file, '', issues)
  if (value.version !== 'lacify.dev/room/v1') issues.push(issue(file, 'version', 'version', 'Version must be "lacify.dev/room/v1".'))
  if (typeof value.name !== 'string' || !roomNamePattern.test(value.name)) issues.push(issue(file, 'name', 'identifier', 'Room name must be a PascalCase identifier.'))
  if (typeof value.partitionBy !== 'string' || !fieldNamePattern.test(value.partitionBy)) issues.push(issue(file, 'partitionBy', 'identifier', 'Partition key must be a lower-camel-case identifier.'))
  if (!Array.isArray(value.capabilities) || value.capabilities.length < 1) issues.push(issue(file, 'capabilities', 'array_size', 'Capabilities must not be empty.'))
  else {
    const seen = new Set()
    value.capabilities.forEach((entry, index) => {
      if (!capabilities.has(entry)) issues.push(issue(file, `capabilities.${index}`, 'capability', `Unsupported capability "${entry}".`))
      if (seen.has(entry)) issues.push(issue(file, 'capabilities', 'duplicate', `Capability "${entry}" is duplicated.`))
      seen.add(entry)
    })
    if (seen.has('history') && !seen.has('events')) issues.push(issue(file, 'capabilities', 'capability_dependency', 'History requires events.'))
  }
  if (value.storage !== 'sqlite') issues.push(issue(file, 'storage', 'storage', 'Room storage must be "sqlite".'))
  if (!isRecord(value.retention)) issues.push(issue(file, 'retention', 'object', 'Retention must be an object.'))
  else {
    unknownKeys(value.retention, retentionKeys, file, 'retention', issues)
    if (!boundedInteger(value.retention.historySeconds, 60, 2_592_000)) issues.push(issue(file, 'retention.historySeconds', 'range', 'historySeconds must be between 60 and 2592000.'))
    if (!boundedInteger(value.retention.maxEvents, 1, 1_000_000)) issues.push(issue(file, 'retention.maxEvents', 'range', 'maxEvents must be between 1 and 1000000.'))
  }
  if (!isRecord(value.limits)) issues.push(issue(file, 'limits', 'object', 'Limits must be an object.'))
  else {
    unknownKeys(value.limits, limitKeys, file, 'limits', issues)
    for (const [key, minimum, maximum] of [['maxFrameBytes', 256, 1_048_576], ['maxConnections', 1, 100_000], ['maxPresenceBytes', 64, 65_536], ['maxDocumentUpdateBytes', 256, 1_048_576]]) {
      if (!boundedInteger(value.limits[key], minimum, maximum)) issues.push(issue(file, `limits.${key}`, 'range', `${key} must be between ${minimum} and ${maximum}.`))
    }
  }
  if (!isRecord(value.budget)) issues.push(issue(file, 'budget', 'object', 'A per-room free-tier budget must be declared.'))
  else {
    unknownKeys(value.budget, budgetKeys, file, 'budget', issues)
    if (!boundedInteger(value.budget.maxPersistentEventsPerUtcDay, 1, 90_000)) issues.push(issue(file, 'budget.maxPersistentEventsPerUtcDay', 'range', 'maxPersistentEventsPerUtcDay must be between 1 and 90000, leaving headroom below Cloudflare account limits.'))
  }
  if (value.events !== undefined) {
    if (!Array.isArray(value.events) || value.events.length < 1 || value.events.length > 128) issues.push(issue(file, 'events', 'array_size', 'Events must contain between 1 and 128 durability policies.'))
    else {
      const names = new Set()
      value.events.forEach((event, index) => {
        if (!isRecord(event)) { issues.push(issue(file, `events.${index}`, 'object', 'Event policy must be an object.')); return }
        unknownKeys(event, eventKeys, file, `events.${index}`, issues)
        if (typeof event.name !== 'string' || !roomNamePattern.test(event.name)) issues.push(issue(file, `events.${index}.name`, 'identifier', 'Event name must be a PascalCase identifier.'))
        if (!['ephemeral', 'segmented', 'immediate'].includes(event.durability)) issues.push(issue(file, `events.${index}.durability`, 'durability', 'Durability must be ephemeral, segmented, or immediate.'))
        if (event.durability === 'segmented' && !boundedInteger(event.batchSize, 2, 500)) issues.push(issue(file, `events.${index}.batchSize`, 'range', 'Segmented events require batchSize between 2 and 500.'))
        if (event.durability === 'segmented' && !boundedInteger(event.retryFlushMs, 100, 60_000)) issues.push(issue(file, `events.${index}.retryFlushMs`, 'range', 'Segmented events require retryFlushMs between 100 and 60000.'))
        if (event.durability !== 'segmented' && event.batchSize !== undefined) issues.push(issue(file, `events.${index}.batchSize`, 'field_dependency', 'batchSize is allowed only for segmented events.'))
        if (event.durability !== 'segmented' && event.retryFlushMs !== undefined) issues.push(issue(file, `events.${index}.retryFlushMs`, 'field_dependency', 'retryFlushMs is allowed only for segmented events.'))
        if (names.has(event.name)) issues.push(issue(file, 'events', 'duplicate', `Event policy "${event.name}" is duplicated.`))
        names.add(event.name)
      })
    }
  }
  if (!isRecord(value.auth)) issues.push(issue(file, 'auth', 'object', 'Auth must be an object.'))
  else {
    unknownKeys(value.auth, authKeys, file, 'auth', issues)
    if (value.auth.mode !== 'token') issues.push(issue(file, 'auth.mode', 'auth_mode', 'Realtime Runtime v1 supports only short-lived token authorization.'))
    if (!Array.isArray(value.auth.allowedOrigins) || value.auth.allowedOrigins.length < 1 || value.auth.allowedOrigins.some((origin) => typeof origin !== 'string' || !/^https:\/\//.test(origin))) issues.push(issue(file, 'auth.allowedOrigins', 'origins', 'allowedOrigins must contain explicit HTTPS origins.'))
  }
  return issues
}

export async function loadRealtimeProject(realtimeFilePath) {
  const input = realtimeFilePath instanceof URL ? fileURLToPath(realtimeFilePath) : realtimeFilePath
  const absolutePath = path.resolve(input)
  const root = path.dirname(absolutePath)
  const source = await readFile(absolutePath, 'utf8')
  if (Buffer.byteLength(source, 'utf8') > maxYamlBytes) return { valid: false, issues: [issue(absolutePath, '', 'file_too_large', `YAML files are limited to ${maxYamlBytes} bytes.`)], project: null, fingerprint: null }
  const parsed = parseYaml(source, absolutePath)
  const issues = [...parsed.issues]
  if (!parsed.value) return { valid: false, issues, project: null, fingerprint: null }
  issues.push(...validateRealtimeDocument(parsed.value, absolutePath))
  const rooms = []
  const names = new Set()
  for (const reference of Array.isArray(parsed.value.rooms) ? parsed.value.rooms : []) {
    if (typeof reference !== 'string' || !roomPathPattern.test(reference)) continue
    const roomPath = path.resolve(root, reference)
    if (!roomPath.startsWith(`${root}${path.sep}`)) { issues.push(issue(absolutePath, 'rooms', 'path_escape', 'Room path must remain inside project directory.')); continue }
    try {
      const roomSource = await readFile(roomPath, 'utf8')
      if (Buffer.byteLength(roomSource, 'utf8') > maxYamlBytes) { issues.push(issue(roomPath, '', 'file_too_large', `YAML files are limited to ${maxYamlBytes} bytes.`)); continue }
      const roomParsed = parseYaml(roomSource, roomPath)
      issues.push(...roomParsed.issues)
      if (!roomParsed.value) continue
      issues.push(...validateRoomDocument(roomParsed.value, roomPath))
      if (names.has(roomParsed.value.name)) issues.push(issue(roomPath, 'name', 'duplicate_room', `Room "${roomParsed.value.name}" is declared more than once.`))
      names.add(roomParsed.value.name)
      rooms.push({ source: reference, definition: { ...roomParsed.value, capabilities: [...(roomParsed.value.capabilities || [])].sort(), events: [...(roomParsed.value.events || [])].sort((left, right) => String(left.name).localeCompare(String(right.name))), auth: { ...roomParsed.value.auth, allowedOrigins: [...(roomParsed.value.auth?.allowedOrigins || [])].sort() } } })
    } catch (error) {
      if (error?.code === 'ENOENT') issues.push(issue(roomPath, '', 'missing_file', 'Room file does not exist or cannot be read.'))
      else throw error
    }
  }
  const project = { realtime: { ...parsed.value, rooms: [...(parsed.value.rooms || [])].sort() }, rooms: rooms.sort((left, right) => left.definition.name.localeCompare(right.definition.name)) }
  return { valid: issues.length === 0, issues, project, fingerprint: issues.length ? null : fingerprint(project) }
}

export const realtimeSpecLimits = Object.freeze({ maxYamlBytes })
