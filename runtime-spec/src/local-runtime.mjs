import { createHash, randomUUID } from 'node:crypto'

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

export class LocalOperationError extends Error {
  constructor(code, message, field = null) {
    super(message)
    this.name = 'LocalOperationError'
    this.code = code
    this.field = field
  }
}

function operationError(code, message, field = null) {
  return new LocalOperationError(code, message, field)
}

export function executeLocalCommand(database, actor, { partition, command, input = {}, now = () => new Date().toISOString() }) {
  if (!actor.commands.includes(command)) throw new Error(`Command "${command}" is not declared by Actor ${actor.name}.`)
  if (typeof partition !== 'string' || !partition || partition.length > 256) throw new Error('Partition value must contain 1–256 characters.')
  const encoded = JSON.stringify(input)
  if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024) throw new Error('Command input exceeds 64 KiB.')
  database.exec(`
    CREATE TABLE IF NOT EXISTS _lacify_command_receipts (
      id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      partition_hash TEXT NOT NULL,
      command TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
  `)
  const receipt = {
    id: `command_${randomUUID()}`,
    actor: actor.name,
    partitionHash: hash(partition),
    command,
    inputHash: hash(encoded),
    occurredAt: now(),
  }
  database.prepare(`INSERT INTO _lacify_command_receipts
      (id, actor, partition_hash, command, input_hash, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
    .run(receipt.id, receipt.actor, receipt.partitionHash, receipt.command, receipt.inputHash, receipt.occurredAt)
  return { accepted: true, receipt }
}

export function readLocalCommandReceipt(database, id) {
  return database.prepare(`SELECT id, actor, partition_hash AS partitionHash, command,
    input_hash AS inputHash, occurred_at AS occurredAt
    FROM _lacify_command_receipts WHERE id = ?`).get(id)
}

function operationBindings(sql, input, runtime) {
  const values = []
  const statement = sql.trim().replace(/;$/, '').replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, name) => {
    values.push(Object.hasOwn(runtime, name) ? runtime[name] : input[name] ?? null)
    return '?'
  })
  return { statement, values }
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function validateInput(definition, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw operationError('invalid_input', 'Operation input must be an object.')
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 64 * 1024) throw operationError('input_size_limit', 'Operation input exceeds 64 KiB.')
  for (const name of Object.keys(input)) {
    if (!Object.hasOwn(definition.input, name)) throw operationError('unknown_input', `Unknown operation input "${name}".`, name)
  }
  for (const [name, field] of Object.entries(definition.input)) {
    const value = input[name]
    if (field.required && (value === undefined || value === null)) throw operationError('required_input', `Required operation input "${name}" is missing.`, name)
    if (value === undefined || value === null) continue
    const valid = field.type === 'string' ? typeof value === 'string' && value.length <= 16384
      : field.type === 'integer' ? Number.isSafeInteger(value)
      : field.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : field.type === 'boolean' ? typeof value === 'boolean'
      : false
    if (!valid) throw operationError('invalid_input_type', `Operation input "${name}" must be ${field.type}.`, name)
  }
}

function projectRow(definition, row) {
  const projected = {}
  for (const [name, field] of Object.entries(definition.result.fields || {})) {
    const value = row[name]
    if (value === null && field.nullable) {
      projected[name] = null
      continue
    }
    const valid = field.type === 'string' ? typeof value === 'string'
      : field.type === 'integer' ? Number.isSafeInteger(value)
      : field.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : field.type === 'boolean' ? typeof value === 'boolean' || value === 0 || value === 1
      : false
    if (!valid) throw operationError('result_type', `Operation result field "${name}" does not match its declared type.`, name)
    projected[name] = field.type === 'boolean' ? Boolean(value) : value
  }
  return projected
}

function shapeResult(definition, rows) {
  if (definition.result.mode === 'none') return null
  if (definition.result.mode === 'one') {
    if (rows.length !== 1) throw operationError('result_cardinality', 'Operation expected exactly one result row.')
    return projectRow(definition, rows[0])
  }
  if (definition.result.mode === 'optional') {
    if (rows.length > 1) throw operationError('result_cardinality', 'Operation expected at most one result row.')
    return rows[0] ? projectRow(definition, rows[0]) : null
  }
  if (rows.length > definition.result.maxRows) throw operationError('result_row_limit', 'Operation result exceeded its row limit.')
  return rows.map((row) => projectRow(definition, row))
}

export function executeLocalOperation(database, actor, {
  partition,
  operation,
  input = {},
  page = null,
  idempotencyKey = null,
  now = () => Date.now(),
  commandId = () => `command_${randomUUID()}`,
}) {
  if (typeof partition !== 'string' || !partition || partition.length > 256) throw operationError('invalid_partition', 'Partition value must contain 1–256 characters.')
  const entry = (actor.operations || []).find(({ definition }) => definition.name === operation)
  if (!entry) throw operationError('operation_not_found', `Operation "${operation}" is not declared by Actor ${actor.definition?.name || actor.name}.`)
  validateInput(entry.definition, input)
  if (idempotencyKey !== null && !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) throw operationError('invalid_idempotency_key', 'Invalid idempotency key.')
  database.exec(`CREATE TABLE IF NOT EXISTS _lacify_operation_receipts (
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (operation, idempotency_key)
  );`)
  const inputHash = hash(stableJson(input))
  if (entry.definition.kind === 'command' && idempotencyKey) {
    const existing = database.prepare('SELECT input_hash AS inputHash, response FROM _lacify_operation_receipts WHERE operation = ? AND idempotency_key = ?').get(operation, idempotencyKey)
    if (existing?.inputHash !== undefined && existing.inputHash !== inputHash) throw operationError('idempotency_conflict', 'Idempotency key was already used with different input.')
    if (existing) return { ...JSON.parse(existing.response), replayed: true }
  }
  const runtimeNow = now()
  let requestedPageSize = null
  let pageCursor = null
  if (entry.definition.result.pagination) {
    const options = page || {}
    requestedPageSize = options.pageSize ?? entry.definition.result.pagination.defaultPageSize
    if (!Number.isSafeInteger(requestedPageSize) || requestedPageSize < 1 || requestedPageSize > entry.definition.result.pagination.maxPageSize) throw operationError('invalid_page_size', 'Page size is outside the operation limit.', 'pageSize')
    pageCursor = options.cursor ?? null
    if (pageCursor !== null && (typeof pageCursor !== 'string' || pageCursor.length > 1024)) throw operationError('invalid_cursor', 'Cursor must be a bounded string or null.', 'cursor')
  } else if (page !== null) {
    throw operationError('pagination_not_supported', 'This operation does not support pagination.')
  }
  const { statement, values } = operationBindings(entry.sql, input, {
    partitionId: partition,
    now: runtimeNow,
    commandId: commandId(),
    cursor: pageCursor,
    pageSize: requestedPageSize === null ? null : requestedPageSize + 1,
  })
  database.exec('BEGIN IMMEDIATE')
  try {
    const rows = database.prepare(statement).all(...values)
    const data = entry.definition.result.pagination
      ? {
          items: rows.slice(0, requestedPageSize).map((row) => projectRow(entry.definition, row)),
          nextCursor: rows.length > requestedPageSize && requestedPageSize > 0
            ? String(rows[requestedPageSize - 1][entry.definition.result.pagination.cursorField])
            : null,
        }
      : shapeResult(entry.definition, rows)
    if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 256 * 1024) throw operationError('result_size_limit', 'Operation result exceeds 256 KiB.')
    const result = { success: true, operation, partitionId: partition, data }
    if (entry.definition.kind === 'command' && idempotencyKey) {
      database.prepare('INSERT INTO _lacify_operation_receipts (operation, idempotency_key, input_hash, response, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(operation, idempotencyKey, inputHash, JSON.stringify(result), runtimeNow)
    }
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    if (error instanceof LocalOperationError) throw error
    throw operationError('operation_execution_failed', 'Operation execution failed; local transaction rolled back.')
  }
}
