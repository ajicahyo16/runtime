export interface RuntimeContract {
  id: string
  name: string
  aggregateType: string
  key: string
  objects: Array<{ name: string; fields?: string }>
  actions: string[]
  states: Array<{ obj: string; flow: string[] }>
  migrations?: Array<{ id: string; sql: string; checksum?: string }>
  operations?: Array<{
    definition: {
      version: 'lacify.dev/operation/v1'
      name: string
      kind: 'command' | 'query'
      sql: string
      input: Record<string, { type: 'string' | 'integer' | 'number' | 'boolean'; required?: boolean }>
      result: {
        mode: 'none' | 'one' | 'optional' | 'many'
        maxRows?: number
        fields?: Record<string, { type: 'string' | 'integer' | 'number' | 'boolean'; nullable?: boolean }>
        pagination?: { cursorField: string; defaultPageSize: number; maxPageSize: number }
      }
      emits?: Array<{
        event: string
        target: 'realtime' | 'reporting' | 'archive'
        durability: 'segmented' | 'immediate'
        fields: string[]
        reporting?: {
          keyField: string
          sequenceField?: string
          dimensions: string[]
          measures: Array<{ field: string; aggregate: 'sum' }>
        }
        realtime?: {
          roomClass: string
          roomField: string
        }
      }>
    }
    sql: string
    checksum?: string
  }>
}

export interface SourceContract extends RuntimeContract {
  revision: number
}

export interface WebAppBlueprint {
  name: string
  aggregates: string[]
}

export interface CompiledRelease {
  checksum: string
  manifest: Record<string, unknown>
  artifact: Record<string, string>
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const lifecycleSteps = ['Wake', 'Validate', 'Execute', 'Persist', 'Update summary', 'Respond', 'Sleep']

function objectTable(contract: SourceContract, objectName: string) {
  const table = `${contract.id}_${objectName}`
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .toLowerCase()
  return contract.migrations?.length ? `_lacify_runtime_${table}` : table
}

function authoredTables(contract: SourceContract) {
  const names = (contract.migrations || []).flatMap((migration) =>
    [...migration.sql.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi)].map((match) => match[1]),
  )
  return [...new Set(names)].sort()
}

function compiledOperations(contract: SourceContract) {
  return (contract.operations || []).map(({ definition, sql }) => {
    const parameters: string[] = []
    let statement = sql.trim().replace(/;$/, '').replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, name: string) => {
      parameters.push(name)
      return '?'
    })
    if (definition.kind === 'query' && definition.result.mode === 'many' && !definition.result.pagination) {
      statement = `SELECT * FROM (${statement}) LIMIT ${Number(definition.result.maxRows || 100) + 1}`
    }
    return {
      name: definition.name,
      kind: definition.kind,
      input: definition.input,
      result: definition.result,
      emits: definition.emits || [],
      sql: statement,
      parameters,
    }
  })
}

function runtimeClass(contract: SourceContract) {
  const primary = contract.objects[0]
  const stateFlow = contract.states.find((state) => state.obj === primary.name)?.flow || ['Draft', 'Completed']
  const tables = contract.objects.map((object) => `    this.sql.exec(\`CREATE TABLE IF NOT EXISTS ${objectTable(contract, object.name)} (id TEXT PRIMARY KEY, ${contract.key} TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);\`);`).join('\n')
  const migrations = (contract.migrations || []).map((migration) => `    {
      const applied = [...this.sql.exec('SELECT checksum FROM _lacify_migrations WHERE migration_id = ?', ${JSON.stringify(migration.id)})][0];
      if (applied && applied.checksum !== ${JSON.stringify(migration.checksum)}) throw new Error('Applied migration checksum mismatch: ${migration.id}');
      if (!applied) {
        this.sql.exec(${JSON.stringify(migration.sql)});
        this.sql.exec('INSERT INTO _lacify_migrations (migration_id, checksum, applied_at) VALUES (?, ?, ?)', ${JSON.stringify(migration.id)}, ${JSON.stringify(migration.checksum)}, Date.now());
      }
    }`).join('\n')
  const tableNames = [...new Set([...contract.objects.map((object) => objectTable(contract, object.name)), ...authoredTables(contract)])]
  const tableStats = tableNames.map((table) => `{ name: '${table}', rows: Number([...this.sql.exec('SELECT COUNT(*) AS count FROM ${table}')][0]?.count || 0) }`).join(', ')
  const operations = compiledOperations(contract)
  return `export class ${contract.aggregateType}DO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
    this.sql = ctx.storage.sql;
    try {
    this.sql.exec(\`CREATE TABLE IF NOT EXISTS _lacify_migrations (migration_id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL);\`);
${migrations}
${tables}
    this.sql.exec(\`CREATE TABLE IF NOT EXISTS lacify_aggregate_state (partition_id TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL);\`);
    this.sql.exec(\`CREATE TABLE IF NOT EXISTS lacify_lifecycle_events (id TEXT PRIMARY KEY, command TEXT NOT NULL, state TEXT NOT NULL, phases TEXT NOT NULL, payload TEXT NOT NULL, occurred_at INTEGER NOT NULL);\`);
    this.sql.exec(\`CREATE TABLE IF NOT EXISTS lacify_daily_summary (day TEXT PRIMARY KEY, command_count INTEGER NOT NULL, last_state TEXT NOT NULL, updated_at INTEGER NOT NULL);\`);
    this.sql.exec(\`CREATE TABLE IF NOT EXISTS _lacify_operation_receipts (operation TEXT NOT NULL, idempotency_key TEXT NOT NULL, input_hash TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (operation, idempotency_key));\`);
    this.sql.exec(\`CREATE TABLE IF NOT EXISTS _lacify_operation_rate_limits (caller_identity_hash TEXT NOT NULL, operation TEXT NOT NULL, window_started_at INTEGER NOT NULL, request_count INTEGER NOT NULL, PRIMARY KEY (caller_identity_hash, operation, window_started_at));\`);
    this.sql.exec(\`CREATE TABLE IF NOT EXISTS _lacify_operation_audit (id TEXT PRIMARY KEY, caller_identity_hash TEXT NOT NULL, operation TEXT NOT NULL, kind TEXT NOT NULL, outcome TEXT NOT NULL, status_code INTEGER NOT NULL, occurred_at INTEGER NOT NULL);\`);
    this.sql.exec(\`CREATE TABLE IF NOT EXISTS _lacify_outbox (event_id TEXT PRIMARY KEY, operation TEXT NOT NULL, partition_key TEXT NOT NULL, event_name TEXT NOT NULL, target TEXT NOT NULL, durability TEXT NOT NULL, payload TEXT NOT NULL, projection TEXT, routing TEXT, status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'dead_letter')), attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER);\`);
    if (this.env.LACIFY_EVENT_SINK && typeof this.ctx.blockConcurrencyWhile === 'function') this.ctx.blockConcurrencyWhile(() => this.scheduleOutbox());
    } catch (error) {
      console.error(JSON.stringify({ event: 'lacify.actor_initialization_failed', aggregateType: '${contract.aggregateType}', code: 'sqlite_initialization_failed', message: String(error?.message || 'unknown').slice(0, 240) }));
      throw error;
    }
  }

  async scheduleOutbox() {
    if (!this.env.LACIFY_EVENT_SINK || !this.env.LACIFY_EVENT_ROUTER_SECRET || typeof this.storage.setAlarm !== 'function') return;
    const pending = [...this.sql.exec("SELECT MIN(available_at) AS available_at FROM _lacify_outbox WHERE status = 'pending'")][0];
    if (pending?.available_at !== null && pending?.available_at !== undefined) await this.storage.setAlarm(Math.max(Date.now(), Number(pending.available_at)));
  }

  async dispatchOutbox() {
    if (!this.env.LACIFY_EVENT_SINK || !this.env.LACIFY_EVENT_ROUTER_SECRET) return { delivered: 0, retried: 0, deadLettered: 0 };
    const rows = [...this.sql.exec("SELECT event_id, operation, partition_key, event_name, target, durability, payload, projection, routing, attempts, created_at FROM _lacify_outbox WHERE status = 'pending' AND available_at <= ? ORDER BY created_at, event_id LIMIT 16", Date.now())];
    let delivered = 0;
    let retried = 0;
    let deadLettered = 0;
    for (const row of rows) {
      try {
        const envelope = JSON.stringify({ version: 'lacify.dev/event/v1', eventId: row.event_id, operation: row.operation, partitionKey: row.partition_key, event: row.event_name, target: row.target, durability: row.durability, occurredAt: Number(row.created_at), payload: JSON.parse(row.payload), ...(row.projection ? { projection: JSON.parse(row.projection) } : {}), ...(row.routing ? { routing: JSON.parse(row.routing) } : {}) });
        const timestamp = String(Date.now());
        const signingKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(this.env.LACIFY_EVENT_ROUTER_SECRET || ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const signatureBytes = await crypto.subtle.sign('HMAC', signingKey, new TextEncoder().encode(timestamp + '.' + envelope));
        const signature = [...new Uint8Array(signatureBytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        const response = await this.env.LACIFY_EVENT_SINK.fetch('https://lacify.internal/v1/events', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-lacify-event-id': row.event_id, 'x-lacify-event-timestamp': timestamp, 'x-lacify-event-signature': signature },
          body: envelope,
        });
        if (!response.ok && response.status !== 409) throw new Error('sink_' + response.status);
        this.sql.exec("UPDATE _lacify_outbox SET status = 'delivered', attempts = attempts + 1, last_error = NULL, delivered_at = ? WHERE event_id = ? AND status = 'pending'", Date.now(), row.event_id);
        delivered += 1;
      } catch (error) {
        const attempts = Number(row.attempts) + 1;
        const code = /^sink_[0-9]{3}$/.test(error?.message || '') ? error.message : 'delivery_failed';
        if (attempts >= 8) {
          this.sql.exec("UPDATE _lacify_outbox SET status = 'dead_letter', attempts = ?, last_error = ? WHERE event_id = ? AND status = 'pending'", attempts, code, row.event_id);
          deadLettered += 1;
        } else {
          const delay = Math.min(300000, 1000 * (2 ** Math.min(attempts - 1, 8)));
          this.sql.exec("UPDATE _lacify_outbox SET attempts = ?, available_at = ?, last_error = ? WHERE event_id = ? AND status = 'pending'", attempts, Date.now() + delay, code, row.event_id);
          retried += 1;
        }
      }
    }
    await this.scheduleOutbox();
    return { delivered, retried, deadLettered };
  }

  async alarm() {
    await this.dispatchOutbox();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__lacify/outbox/dispatch' && request.method === 'POST') return Response.json({ success: true, ...(await this.dispatchOutbox()) });
    if (url.pathname === '/__lacify/outbox/replay' && request.method === 'POST') {
      if (!this.env.LACIFY_OUTBOX_REPLAY_SECRET || request.headers.get('x-lacify-outbox-approval') !== this.env.LACIFY_OUTBOX_REPLAY_SECRET) return Response.json({ success: false, error: { code: 'approval_required', message: 'Exact outbox replay approval is required.' } }, { status: 403 });
      const body = await request.json().catch(() => ({}));
      if (typeof body.eventId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(body.eventId)) return Response.json({ success: false, error: { code: 'invalid_event_id', message: 'A valid dead-letter event ID is required.' } }, { status: 400 });
      const deadLetter = [...this.sql.exec("SELECT event_id FROM _lacify_outbox WHERE event_id = ? AND status = 'dead_letter'", body.eventId)][0];
      if (!deadLetter) return Response.json({ success: false, error: { code: 'dead_letter_not_found', message: 'Dead-letter event was not found.' } }, { status: 404 });
      this.sql.exec("UPDATE _lacify_outbox SET status = 'pending', attempts = 0, available_at = ?, last_error = NULL WHERE event_id = ? AND status = 'dead_letter'", Date.now(), body.eventId);
      await this.scheduleOutbox();
      return Response.json({ success: true, eventId: body.eventId, replayScheduled: true });
    }
    let auditContext = null;
    const recordAudit = (outcome, statusCode) => {
      if (!auditContext) return;
      this.sql.exec('INSERT INTO _lacify_operation_audit (id, caller_identity_hash, operation, kind, outcome, status_code, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)', crypto.randomUUID(), auditContext.callerIdentityHash, auditContext.operation, auditContext.kind, outcome, statusCode, Date.now());
    };
    const failure = (code, message, status = 400, field = null) => {
      recordAudit(status < 500 ? 'rejected' : 'failed', status);
      return Response.json({ success: false, error: { code, message, ...(field ? { field } : {}) } }, { status });
    };
    const operationException = (code, message, status) => {
      const reason = new Error(message);
      reason.code = code;
      reason.status = status;
      reason.lacifySafe = true;
      return reason;
    };
    const projectRow = (operation, row) => {
      const projected = {};
      for (const [name, field] of Object.entries(operation.result.fields || {})) {
        const value = row[name];
        if (value === null && field.nullable) { projected[name] = null; continue; }
        const valid = field.type === 'string' ? typeof value === 'string'
          : field.type === 'integer' ? Number.isSafeInteger(value)
          : field.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
          : field.type === 'boolean' ? typeof value === 'boolean' || value === 0 || value === 1
          : false;
        if (!valid) throw operationException('result_type', \`Operation result field "\${name}" does not match its declared type.\`, 500);
        projected[name] = field.type === 'boolean' ? Boolean(value) : value;
      }
      return projected;
    };
    const shapeRows = (operation, rows) => {
      if (operation.result.mode === 'none') return null;
      if (operation.result.mode === 'one') {
        if (rows.length !== 1) throw operationException('result_cardinality', 'Operation expected exactly one result row.', 409);
        return projectRow(operation, rows[0]);
      }
      if (operation.result.mode === 'optional') {
        if (rows.length > 1) throw operationException('result_cardinality', 'Operation expected at most one result row.', 409);
        return rows[0] ? projectRow(operation, rows[0]) : null;
      }
      if (rows.length > operation.result.maxRows) throw operationException('result_row_limit', 'Operation result exceeded its row limit.', 422);
      return rows.map((row) => projectRow(operation, row));
    };
    if (url.pathname === '/__lacify/health' && request.method === 'GET') {
      try {
        [...this.sql.exec('SELECT 1 AS ok')];
        const outbox = [...this.sql.exec("SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter, MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending_at FROM _lacify_outbox")][0];
        return Response.json({ ok: true, aggregateType: '${contract.aggregateType}', durableObject: true, sqlite: true, storageBytes: this.sql.databaseSize, tables: [${tableStats}], outbox: { pending: Number(outbox?.pending || 0), deadLetter: Number(outbox?.dead_letter || 0), oldestPendingAt: outbox?.oldest_pending_at === null || outbox?.oldest_pending_at === undefined ? null : Number(outbox.oldest_pending_at) } });
      } catch {
        return Response.json({ ok: false, aggregateType: '${contract.aggregateType}', durableObject: true, sqlite: false }, { status: 503 });
      }
    }
    if (request.method !== 'POST') return failure('method_not_allowed', 'Method not allowed.', 405);
    let body;
    try { body = await request.json(); } catch { return failure('invalid_json', 'JSON body is required.', 400); }
    const pathParts = url.pathname.split('/');
    const isQuery = pathParts[4] === 'queries';
    const command = typeof body.command === 'string' ? body.command : '';
    const operationName = isQuery ? pathParts[5] : command;
    const operations = ${JSON.stringify(Object.fromEntries(operations.map((operation) => [operation.name, operation])))};
    const operation = operations[operationName];
    const allowed = ${JSON.stringify([...contract.actions].sort())};
    if (isQuery && (!operation || operation.kind !== 'query')) return failure('unsupported_query', 'Unsupported query.', 404);
    if (!isQuery && !allowed.includes(command)) return failure('unsupported_command', 'Unsupported command.', 400);
    if (!isQuery && operation && operation.kind !== 'command') return failure('operation_kind_mismatch', 'Operation kind mismatch.', 400);
    const partitionId = pathParts[3];
    if (!partitionId) return failure('partition_required', 'Partition key is required.', 400);
    const now = Date.now();
    const callerIdentityHash = request.headers.get('x-lacify-caller-identity');
    const rateLimit = Number(request.headers.get('x-lacify-operation-rate-limit'));
    if (!callerIdentityHash || !/^[a-f0-9]{64}$/.test(callerIdentityHash) || !Number.isSafeInteger(rateLimit) || rateLimit < 1 || rateLimit > 10000) return failure('application_authentication_required', 'Application authentication is required.', 401);
    auditContext = { callerIdentityHash, operation: operationName, kind: isQuery ? 'query' : 'command' };
    const rateWindow = Math.floor(now / 60000) * 60000;
    this.sql.exec('INSERT INTO _lacify_operation_rate_limits (caller_identity_hash, operation, window_started_at, request_count) VALUES (?, ?, ?, 1) ON CONFLICT(caller_identity_hash, operation, window_started_at) DO UPDATE SET request_count = request_count + 1', callerIdentityHash, operationName, rateWindow);
    const rateUsage = [...this.sql.exec('SELECT request_count FROM _lacify_operation_rate_limits WHERE caller_identity_hash = ? AND operation = ? AND window_started_at = ?', callerIdentityHash, operationName, rateWindow)][0];
    if (Number(rateUsage?.request_count || 0) > rateLimit) return failure('operation_rate_limit', 'Operation rate limit exceeded.', 429);
    this.sql.exec('DELETE FROM _lacify_operation_rate_limits WHERE window_started_at < ?', rateWindow - 60000);
    let operationData;
    let idempotencyKey = null;
    let operationContext = null;
    if (operation) {
      const input = isQuery ? (body.input ?? body) : (body.payload ?? {});
      if (!input || typeof input !== 'object' || Array.isArray(input)) return failure('invalid_input', 'Operation input must be a JSON object.', 400);
      const encodedInput = stableJson(input);
      if (new TextEncoder().encode(encodedInput).byteLength > 65536) return failure('input_size_limit', 'Operation input exceeds 64 KiB.', 413);
      const inputNames = Object.keys(operation.input);
      const unknown = Object.keys(input).find((name) => !inputNames.includes(name));
      if (unknown) return failure('unknown_input', 'Unknown operation input.', 400, unknown);
      for (const [name, field] of Object.entries(operation.input)) {
        const value = input[name];
        if (field.required && (value === undefined || value === null)) return failure('required_input', 'Required operation input is missing.', 400, name);
        if (value === undefined || value === null) continue;
        const valid = field.type === 'string' ? typeof value === 'string' && value.length <= 16384
          : field.type === 'integer' ? Number.isSafeInteger(value)
          : field.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
          : field.type === 'boolean' ? typeof value === 'boolean'
          : false;
        if (!valid) return failure('invalid_input_type', \`Operation input must be \${field.type} and within its size bound.\`, 400, name);
      }
      const commandId = crypto.randomUUID();
      const inputHash = await hashPartition(operation.name, encodedInput);
      if (operation.kind === 'command') {
        idempotencyKey = request.headers.get('idempotency-key');
        if (idempotencyKey !== null && !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) return failure('invalid_idempotency_key', 'Invalid idempotency key.', 400);
        if (idempotencyKey) {
          const existing = [...this.sql.exec('SELECT input_hash, response FROM _lacify_operation_receipts WHERE operation = ? AND idempotency_key = ?', operation.name, idempotencyKey)][0];
          if (existing && existing.input_hash !== inputHash) return failure('idempotency_conflict', 'Idempotency key was already used with different input.', 409);
          if (existing) {
            recordAudit('success', 200);
            return Response.json({ ...JSON.parse(existing.response), replayed: true });
          }
        }
      }
      let requestedPageSize = null;
      let pageCursor = null;
      if (operation.result.pagination) {
        const page = body.page ?? {};
        if (!page || typeof page !== 'object' || Array.isArray(page)) return failure('invalid_page', 'Pagination options must be an object.', 400);
        const unknownPageField = Object.keys(page).find((name) => !['cursor', 'pageSize'].includes(name));
        if (unknownPageField) return failure('unknown_page_field', 'Unknown pagination option.', 400, unknownPageField);
        requestedPageSize = page.pageSize ?? operation.result.pagination.defaultPageSize;
        if (!Number.isSafeInteger(requestedPageSize) || requestedPageSize < 1 || requestedPageSize > operation.result.pagination.maxPageSize) return failure('invalid_page_size', 'Page size is outside the operation limit.', 400, 'pageSize');
        pageCursor = page.cursor ?? null;
        if (pageCursor !== null && (typeof pageCursor !== 'string' || pageCursor.length > 1024)) return failure('invalid_cursor', 'Cursor must be a bounded string or null.', 400, 'cursor');
      } else if (body.page !== undefined) {
        return failure('pagination_not_supported', 'This operation does not support pagination.', 400);
      }
      const runtimeValues = { partitionId, now, commandId, cursor: pageCursor, pageSize: requestedPageSize === null ? null : requestedPageSize + 1 };
      const bindings = operation.parameters.map((name) => Object.prototype.hasOwnProperty.call(runtimeValues, name) ? runtimeValues[name] : input[name] ?? null);
      operationContext = { bindings, inputHash };
      if (operation.kind === 'query') {
        try {
          const rows = [...this.sql.exec(operation.sql, ...bindings)];
          if (operation.result.pagination) {
            const hasNextPage = rows.length > requestedPageSize;
            const items = rows.slice(0, requestedPageSize).map((row) => projectRow(operation, row));
            const cursorField = operation.result.pagination.cursorField;
            const cursorValue = hasNextPage && items.length ? items[items.length - 1][cursorField] : null;
            operationData = { items, nextCursor: cursorValue === null ? null : String(cursorValue) };
          } else {
            operationData = shapeRows(operation, rows);
          }
          if (new TextEncoder().encode(JSON.stringify(operationData)).byteLength > 262144) return failure('result_size_limit', 'Operation result exceeds 256 KiB.', 422);
          const queryResponse = Response.json({ success: true, operation: operation.name, partitionId, data: operationData });
          queryResponse.headers.set('x-lacify-storage-bytes', String(this.sql.databaseSize));
          recordAudit('success', 200);
          return queryResponse;
        } catch (error) {
          return failure(error.lacifySafe ? error.code : 'operation_execution_failed', error.lacifySafe ? error.message : 'Operation execution failed.', error.lacifySafe ? error.status : 409);
        }
      }
    }
    const phases = ${JSON.stringify(lifecycleSteps)};
    const flow = ${JSON.stringify(stateFlow)};
    const payload = JSON.stringify(body.payload ?? {});
    const eventId = crypto.randomUUID();
    const recordId = crypto.randomUUID();
    let result;
    try {
      this.storage.transactionSync(() => {
        if (operation) {
          operationData = shapeRows(operation, [...this.sql.exec(operation.sql, ...operationContext.bindings)]);
          if (new TextEncoder().encode(JSON.stringify(operationData)).byteLength > 262144) throw operationException('result_size_limit', 'Operation result exceeds 256 KiB.', 422);
        }
        const stateRow = [...this.sql.exec('SELECT state, version FROM lacify_aggregate_state WHERE partition_id = ?', partitionId)][0];
        const currentIndex = stateRow ? Math.max(0, flow.indexOf(stateRow.state)) : -1;
        const nextState = flow[(currentIndex + 1) % flow.length];
        const version = (stateRow?.version || 0) + 1;
        this.sql.exec('INSERT INTO lacify_aggregate_state (partition_id, state, version, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(partition_id) DO UPDATE SET state = excluded.state, version = excluded.version, updated_at = excluded.updated_at', partitionId, nextState, version, now);
        this.sql.exec('INSERT INTO ${objectTable(contract, primary.name)} (id, ${contract.key}, state, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', recordId, partitionId, nextState, payload, now, now);
        this.sql.exec('INSERT INTO lacify_lifecycle_events (id, command, state, phases, payload, occurred_at) VALUES (?, ?, ?, ?, ?, ?)', eventId, command, nextState, JSON.stringify(phases), payload, now);
        this.sql.exec("INSERT INTO lacify_daily_summary (day, command_count, last_state, updated_at) VALUES (date(?, 'unixepoch'), 1, ?, ?) ON CONFLICT(day) DO UPDATE SET command_count = command_count + 1, last_state = excluded.last_state, updated_at = excluded.updated_at", Math.floor(now / 1000), nextState, now);
        result = { success: true, command, partitionId, state: nextState, version, lifecycle: phases, eventId, ...(operation ? { data: operationData } : {}) };
        if (operation?.emits?.length) {
          operation.emits.forEach((emit, index) => {
            const emittedPayload = {};
            for (const field of emit.fields) emittedPayload[field] = operationData?.[field] ?? null;
            const projection = emit.reporting ? { ...emit.reporting, key: emit.reporting.keyField === '$partitionKey' ? partitionId : emittedPayload[emit.reporting.keyField] } : null;
            const routing = emit.realtime ? { roomClass: emit.realtime.roomClass, room: emit.realtime.roomField === '$partitionKey' ? partitionId : emittedPayload[emit.realtime.roomField] } : null;
            this.sql.exec("INSERT INTO _lacify_outbox (event_id, operation, partition_key, event_name, target, durability, payload, projection, routing, status, attempts, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)", eventId + ':' + index, operation.name, partitionId, emit.event, emit.target, emit.durability, JSON.stringify(emittedPayload), projection ? JSON.stringify(projection) : null, routing ? JSON.stringify(routing) : null, now, now);
          });
        }
        if (operation && idempotencyKey) this.sql.exec('INSERT INTO _lacify_operation_receipts (operation, idempotency_key, input_hash, response, created_at) VALUES (?, ?, ?, ?, ?)', operation.name, idempotencyKey, operationContext.inputHash, JSON.stringify(result), now);
      });
    } catch (error) {
      return failure(error.lacifySafe ? error.code : 'operation_execution_failed', error.lacifySafe ? error.message : 'Operation execution failed.', error.lacifySafe ? error.status : 409);
    }
    const response = Response.json(result);
    if (operation?.emits?.length) {
      if (typeof this.ctx.waitUntil === 'function') this.ctx.waitUntil(this.dispatchOutbox());
      else await this.scheduleOutbox();
    }
    response.headers.set('x-lacify-storage-bytes', String(this.sql.databaseSize));
    response.headers.set('x-lacify-table-stats', encodeURIComponent(JSON.stringify([${tableStats}])));
    recordAudit('success', 200);
    return response;
  }
}
`
}

function workerSource(contracts: SourceContract[]) {
  const hasEventRouter = contracts.some((contract) => (contract.operations || []).some(({ definition }) => (definition.emits || []).length > 0))
  const healthProbes = contracts.map((contract) => `      (async () => {
        const aggregateType = '${contract.aggregateType}';
        const startedAt = Date.now();
        try {
          const response = await env.${contract.aggregateType.toUpperCase()}_DO.get(env.${contract.aggregateType.toUpperCase()}_DO.idFromName('__lacify_health__')).fetch('https://lacify.internal/__lacify/health');
          const payload = await response.json().catch(() => null);
          layers.push({ layer: 'durable_object', aggregateType, ok: response.ok && payload?.durableObject === true, durationMs: Date.now() - startedAt });
          layers.push({ layer: 'sqlite', aggregateType, ok: response.ok && payload?.sqlite === true, durationMs: Date.now() - startedAt, storageBytes: payload?.storageBytes, tables: payload?.tables, outbox: payload?.outbox });
        } catch {
          layers.push({ layer: 'durable_object', aggregateType, ok: false, durationMs: Date.now() - startedAt });
          layers.push({ layer: 'sqlite', aggregateType, ok: false, durationMs: Date.now() - startedAt });
        }
      })()`).concat(hasEventRouter ? [`      (async () => {
        const startedAt = Date.now();
        try {
          const response = await env.LACIFY_EVENT_SINK.fetch('https://lacify.internal/__lacify/router/health?deep=1');
          const payload = await response.json().catch(() => null);
          layers.push({ layer: 'event_router', ok: response.ok && payload?.service === 'lacify-event-router', durationMs: Date.now() - startedAt, targets: payload?.configuredTargets });
        } catch {
          layers.push({ layer: 'event_router', ok: false, durationMs: Date.now() - startedAt });
        }
      })()`] : []).join(',\n')
  const routes = contracts.map((contract) => {
    const path = `${contract.aggregateType.toLowerCase()}s`
    const queryOperations = (contract.operations || []).filter(({ definition }) => definition.kind === 'query').map(({ definition }) => definition.name)
    return `    if (url.pathname.match(/^\\/v1\\/${path}\\/[^/]+\\/commands$/) && request.method === 'POST') {
      const aggregateId = url.pathname.split('/')[3];
      const startedAt = Date.now();
      if (!await payloadWithinLimit(request, 65536)) return Response.json({ success: false, error: { code: 'operation_payload_limit', message: 'Operation payload exceeds its configured limit.' } }, { status: 413 });
      const commandInput = await request.clone().json().catch(() => ({}));
      const action = typeof commandInput.command === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(commandInput.command) ? commandInput.command : 'UnknownCommand';
      const access = await authorizeOperation(request, env, '${contract.aggregateType}', action);
      if (access.error) return access.error;
      if (!await payloadWithinLimit(request, access.maxPayloadBytes)) return Response.json({ success: false, error: { code: 'operation_payload_limit', message: 'Operation payload exceeds its configured limit.' } }, { status: 413 });
      const actorHeaders = new Headers(request.headers);
      actorHeaders.delete('authorization');
      actorHeaders.delete('x-lacify-caller-identity');
      actorHeaders.delete('x-lacify-operation-rate-limit');
      actorHeaders.set('x-lacify-caller-identity', access.callerIdentityHash);
      actorHeaders.set('x-lacify-operation-rate-limit', String(access.rateLimitPerMinute));
      const actorRequest = new Request(request, { headers: actorHeaders });
      try {
        const response = await env.${contract.aggregateType.toUpperCase()}_DO.get(env.${contract.aggregateType.toUpperCase()}_DO.idFromName(aggregateId)).fetch(actorRequest);
        const storageHeader = response.headers.get('x-lacify-storage-bytes');
        const storageBytes = storageHeader === null ? null : Number(storageHeader);
        const tableStats = JSON.parse(decodeURIComponent(response.headers.get('x-lacify-table-stats') || '%5B%5D'));
        ctx.waitUntil(queueRuntimeTelemetry(env, { aggregateType: '${contract.aggregateType}', partitionId: aggregateId, callerIdentityHash: access.callerIdentityHash, action, statusCode: response.status, durationMs: Date.now() - startedAt, sqliteReads: response.ok ? 1 : 0, sqliteWrites: response.ok ? 4 : 0, storageBytes: storageBytes !== null && Number.isSafeInteger(storageBytes) ? storageBytes : null, tableStats }));
        const clientResponse = new Response(response.body, response);
        clientResponse.headers.delete('x-lacify-storage-bytes');
        clientResponse.headers.delete('x-lacify-table-stats');
        return clientResponse;
      } catch (error) {
        ctx.waitUntil(queueRuntimeTelemetry(env, { aggregateType: '${contract.aggregateType}', partitionId: aggregateId, callerIdentityHash: access.callerIdentityHash, action, statusCode: 500, durationMs: Date.now() - startedAt, sqliteReads: 0, sqliteWrites: 0 }));
        throw error;
      }
    }
    if (url.pathname.match(/^\\/v1\\/${path}\\/[^/]+\\/queries\\/[^/]+$/) && request.method === 'POST') {
      const aggregateId = url.pathname.split('/')[3];
      const queryName = url.pathname.split('/')[5];
      if (!${JSON.stringify(queryOperations)}.includes(queryName)) return Response.json({ error: 'Unsupported query' }, { status: 404 });
      const startedAt = Date.now();
      const access = await authorizeOperation(request, env, '${contract.aggregateType}', queryName);
      if (access.error) return access.error;
      if (!await payloadWithinLimit(request, access.maxPayloadBytes)) return Response.json({ success: false, error: { code: 'operation_payload_limit', message: 'Operation payload exceeds its configured limit.' } }, { status: 413 });
      const actorHeaders = new Headers(request.headers);
      actorHeaders.delete('authorization');
      actorHeaders.delete('x-lacify-caller-identity');
      actorHeaders.delete('x-lacify-operation-rate-limit');
      actorHeaders.set('x-lacify-caller-identity', access.callerIdentityHash);
      actorHeaders.set('x-lacify-operation-rate-limit', String(access.rateLimitPerMinute));
      const actorRequest = new Request(request, { headers: actorHeaders });
      try {
        const response = await env.${contract.aggregateType.toUpperCase()}_DO.get(env.${contract.aggregateType.toUpperCase()}_DO.idFromName(aggregateId)).fetch(actorRequest);
        const storageHeader = response.headers.get('x-lacify-storage-bytes');
        const storageBytes = storageHeader === null ? null : Number(storageHeader);
        ctx.waitUntil(queueRuntimeTelemetry(env, { aggregateType: '${contract.aggregateType}', partitionId: aggregateId, callerIdentityHash: access.callerIdentityHash, action: queryName, statusCode: response.status, durationMs: Date.now() - startedAt, sqliteReads: response.ok ? 1 : 0, sqliteWrites: 0, storageBytes: storageBytes !== null && Number.isSafeInteger(storageBytes) ? storageBytes : null }));
        const clientResponse = new Response(response.body, response);
        clientResponse.headers.delete('x-lacify-storage-bytes');
        return clientResponse;
      } catch (error) {
        ctx.waitUntil(queueRuntimeTelemetry(env, { aggregateType: '${contract.aggregateType}', partitionId: aggregateId, callerIdentityHash: access.callerIdentityHash, action: queryName, statusCode: 500, durationMs: Date.now() - startedAt, sqliteReads: 0, sqliteWrites: 0 }));
        throw error;
      }
    }`
  }).join('\n')
  return `// Generated by Lacify Runtime v1. Do not edit this artifact directly.
import { DurableObject } from 'cloudflare:workers';

const telemetryQueue = [];
let telemetryFlushPromise = null;

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}

async function hashPartition(deploymentId, partitionId) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(deploymentId + ':' + partitionId));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Text(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function applicationAccessPolicy(env) {
  try {
    const policy = JSON.parse(env.LACIFY_APPLICATION_ACCESS_POLICY || '');
    if (policy?.version === 1 && policy.workspaceId !== undefined && policy.projectId !== undefined && policy.environment === env.LACIFY_ENVIRONMENT && Array.isArray(policy.credentials)) return policy;
    if (policy?.v !== 2 || policy.e !== env.LACIFY_ENVIRONMENT || !Array.isArray(policy.c)) return null;
    const credentials = policy.c.map((credential) => ({
      id: credential?.i,
      tokenHash: credential?.h,
      expiresAt: credential?.x,
      capabilities: Array.isArray(credential?.a)
        ? credential.a.map((capability) => ({
          actor: capability?.[0],
          operations: capability?.[1],
          rateLimitPerMinute: capability?.[2],
          maxPayloadBytes: capability?.[3],
        }))
        : null,
    }));
    if (credentials.some((credential) => !credential.id || !credential.tokenHash || !Array.isArray(credential.capabilities))) return null;
    return { version: 2, credentials };
  } catch {
    return null;
  }
}

async function authorizeCredential(request, env) {
  const authorization = request.headers.get('authorization') || '';
  const match = authorization.match(/^Bearer (lacify_runtime_[A-Za-z0-9_-]{40,100})$/);
  if (!match) return { error: Response.json({ success: false, error: { code: 'application_authentication_required', message: 'Application authentication is required.' } }, { status: 401 }) };
  const policy = applicationAccessPolicy(env);
  if (!policy) return { error: Response.json({ success: false, error: { code: 'application_access_unavailable', message: 'Application access policy is unavailable.' } }, { status: 503 }) };
  const tokenHash = await sha256Text(match[1]);
  const credential = policy.credentials.find((candidate) => candidate?.tokenHash === tokenHash);
  if (!credential || !Number.isSafeInteger(credential.expiresAt) || credential.expiresAt <= Date.now()) return { error: Response.json({ success: false, error: { code: 'application_credential_invalid', message: 'Application credential is invalid or expired.' } }, { status: 401 }) };
  return { credential };
}

async function authorizeOperation(request, env, actor, operation) {
  const authorized = await authorizeCredential(request, env);
  if (authorized.error) return authorized;
  const credential = authorized.credential;
  const capability = Array.isArray(credential.capabilities) ? credential.capabilities.find((candidate) => candidate?.actor === actor && Array.isArray(candidate.operations) && candidate.operations.includes(operation)) : null;
  if (!capability) return { error: Response.json({ success: false, error: { code: 'operation_forbidden', message: 'Application credential does not allow this operation.' } }, { status: 403 }) };
  const rateLimitPerMinute = Number(capability.rateLimitPerMinute);
  const maxPayloadBytes = Number(capability.maxPayloadBytes);
  if (!Number.isSafeInteger(rateLimitPerMinute) || rateLimitPerMinute < 1 || rateLimitPerMinute > 10000 || !Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1024 || maxPayloadBytes > 65536) {
    return { error: Response.json({ success: false, error: { code: 'application_access_unavailable', message: 'Application access policy is invalid.' } }, { status: 503 }) };
  }
  return {
    callerIdentityHash: await hashPartition(env.LACIFY_DEPLOYMENT_ID, credential.id),
    rateLimitPerMinute,
    maxPayloadBytes,
  };
}

async function payloadWithinLimit(request, maxPayloadBytes) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxPayloadBytes) return false;
  return (await request.clone().arrayBuffer()).byteLength <= maxPayloadBytes;
}

async function flushRuntimeTelemetry(env) {
  if (!env.LACIFY_TELEMETRY_URL || !env.LACIFY_TELEMETRY_CREDENTIAL) return;
  while (telemetryQueue.length) {
    const events = telemetryQueue.splice(0, 50);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(env.LACIFY_TELEMETRY_URL.replace(/\\/$/, '') + '/api/runtime-telemetry/events', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + env.LACIFY_TELEMETRY_CREDENTIAL, 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 'lacify-runtime-telemetry/v1',
          batchId: 'batch_' + crypto.randomUUID(),
          deploymentId: env.LACIFY_DEPLOYMENT_ID,
          releaseId: env.LACIFY_RELEASE_ID,
          environment: env.LACIFY_ENVIRONMENT,
          events: await Promise.all(events.map(async (event) => ({
            id: 'event_' + crypto.randomUUID(),
            occurredAt: event.occurredAt,
            aggregateType: event.aggregateType,
            partitionKeyHash: await hashPartition(env.LACIFY_DEPLOYMENT_ID, event.partitionId),
            callerIdentityHash: event.callerIdentityHash,
            action: event.action,
            outcome: event.statusCode < 400 ? 'success' : event.statusCode < 500 ? 'client_error' : 'runtime_error',
            durationMs: event.durationMs,
            statusCode: event.statusCode,
            sqliteReads: event.sqliteReads,
            sqliteWrites: event.sqliteWrites,
            storageBytes: event.storageBytes,
            tableStats: event.tableStats,
          }))),
        }),
        signal: controller.signal,
      });
      if (!response.ok) console.warn(JSON.stringify({ event: 'lacify.telemetry_dropped', count: events.length, reason: 'ingestion_rejected', statusCode: response.status }));
    } catch (error) {
      console.warn(JSON.stringify({ event: 'lacify.telemetry_dropped', count: events.length, reason: error?.name === 'AbortError' ? 'timeout' : 'network_error' }));
    } finally {
      clearTimeout(timeout);
    }
  }
}

function queueRuntimeTelemetry(env, event) {
  if (!env.LACIFY_TELEMETRY_URL || !env.LACIFY_TELEMETRY_CREDENTIAL) return Promise.resolve();
  const samplingRate = Number(env.LACIFY_TELEMETRY_SAMPLING_RATE || 1);
  if (samplingRate < 1 && Math.random() > samplingRate) return Promise.resolve();
  telemetryQueue.push({ ...event, occurredAt: Date.now() });
  if (!telemetryFlushPromise) {
    telemetryFlushPromise = new Promise((resolve) => setTimeout(resolve, telemetryQueue.length >= 10 ? 0 : 100))
      .then(() => flushRuntimeTelemetry(env))
      .finally(() => { telemetryFlushPromise = null; });
  }
  return telemetryFlushPromise;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/__lacify/access' && request.method === 'GET') {
      const authorized = await authorizeCredential(request, env);
      if (authorized.error) return authorized.error;
      return Response.json({
        success: true,
        environment: env.LACIFY_ENVIRONMENT,
        deploymentId: env.LACIFY_DEPLOYMENT_ID,
        capabilities: authorized.credential.capabilities.map((capability) => ({
          actor: capability.actor,
          operations: capability.operations,
        })),
      });
    }
    if (url.pathname === '/health' && request.method === 'GET') {
      const layers = [{ layer: 'worker', ok: true, durationMs: 0 }];
      if (url.searchParams.get('deep') === '1') await Promise.all([
${healthProbes}
      ]);
      return Response.json({ ok: layers.every((layer) => layer.ok), service: 'lacify-runtime', deploymentId: env.LACIFY_DEPLOYMENT_ID, releaseId: env.LACIFY_RELEASE_ID, environment: env.LACIFY_ENVIRONMENT, layers });
    }
${routes}
    return Response.json({ error: 'Not found' }, { status: 404 });
  },
};

${contracts.map(runtimeClass).join('\n')}
`
}

function eventRouterWorkerSource(projectId: string, configuredTargets: string[]) {
  return `import { DurableObject } from 'cloudflare:workers';

const targets = new Set(['realtime', 'reporting', 'archive']);
const configuredTargets = ${JSON.stringify(configuredTargets)};
const maxEnvelopeBytes = 262144;
const maxPendingPerShard = 256;
const recoveryBatchSize = 16;

function errorResponse(code, message, status) {
  return Response.json({ success: false, error: { code, message } }, { status });
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function equalHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export class EventRouterActor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.inflight = new Map();
    this.sql.exec("CREATE TABLE IF NOT EXISTS _lacify_router_deliveries (event_id TEXT PRIMARY KEY, target TEXT NOT NULL, checksum TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'delivered')), attempts INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER)");
    const columns = new Set([...this.sql.exec("PRAGMA table_info(_lacify_router_deliveries)")].map((row) => row.name));
    if (!columns.has('body')) this.sql.exec("ALTER TABLE _lacify_router_deliveries ADD COLUMN body TEXT");
    if (!columns.has('next_attempt_at')) this.sql.exec("ALTER TABLE _lacify_router_deliveries ADD COLUMN next_attempt_at INTEGER");
    this.sql.exec("CREATE TABLE IF NOT EXISTS _lacify_router_circuits (target TEXT PRIMARY KEY, consecutive_failures INTEGER NOT NULL, open_until INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
    if (typeof this.ctx.blockConcurrencyWhile === 'function') this.ctx.blockConcurrencyWhile(() => this.scheduleRecovery());
  }

  async scheduleRecovery() {
    if (typeof this.ctx.storage.setAlarm !== 'function') return;
    const pending = [...this.sql.exec("SELECT MIN(next_attempt_at) AS next_attempt_at FROM _lacify_router_deliveries WHERE status = 'pending' AND next_attempt_at IS NOT NULL")][0];
    if (pending?.next_attempt_at !== null && pending?.next_attempt_at !== undefined) await this.ctx.storage.setAlarm(Math.max(Date.now(), Number(pending.next_attempt_at)));
  }

  circuit(target) {
    return [...this.sql.exec("SELECT consecutive_failures, open_until FROM _lacify_router_circuits WHERE target = ?", target)][0] || { consecutive_failures: 0, open_until: 0 };
  }

  recordSuccess(target) {
    this.sql.exec("INSERT INTO _lacify_router_circuits (target, consecutive_failures, open_until, updated_at) VALUES (?, 0, 0, ?) ON CONFLICT(target) DO UPDATE SET consecutive_failures = 0, open_until = 0, updated_at = excluded.updated_at", target, Date.now());
  }

  recordFailure(target) {
    const current = this.circuit(target);
    const failures = Number(current.consecutive_failures || 0) + 1;
    const openUntil = failures >= 3 ? Date.now() + Math.min(300000, 10000 * (2 ** Math.min(failures - 3, 5))) : 0;
    this.sql.exec("INSERT INTO _lacify_router_circuits (target, consecutive_failures, open_until, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(target) DO UPDATE SET consecutive_failures = excluded.consecutive_failures, open_until = excluded.open_until, updated_at = excluded.updated_at", target, failures, openUntil, Date.now());
    return openUntil;
  }

  async deliver(envelope, body) {
    const existing = [...this.sql.exec("SELECT checksum, status FROM _lacify_router_deliveries WHERE event_id = ?", envelope.eventId)][0];
    const checksumBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    const checksum = [...new Uint8Array(checksumBytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (existing && existing.checksum !== checksum) return errorResponse('event_conflict', 'Event ID was reused with different content.', 409);
    if (existing?.status === 'delivered') return Response.json({ success: true, eventId: envelope.eventId, target: envelope.target, duplicate: true }, { status: 409 });
    if (!existing) {
      const pressure = Number([...this.sql.exec("SELECT COUNT(*) AS count FROM _lacify_router_deliveries WHERE status = 'pending'")][0]?.count || 0);
      if (pressure >= maxPendingPerShard) return errorResponse('router_backpressure', 'Event router shard reached its bounded pending capacity.', 429);
    }
    const active = this.inflight.get(envelope.eventId);
    if (active) return active;
    const delivery = this.performDelivery(envelope, body, checksum).finally(() => this.inflight.delete(envelope.eventId));
    this.inflight.set(envelope.eventId, delivery);
    return delivery;
  }

  async performDelivery(envelope, body, checksum) {
    this.sql.exec("INSERT OR IGNORE INTO _lacify_router_deliveries (event_id, target, checksum, status, attempts, body, next_attempt_at, created_at) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)", envelope.eventId, envelope.target, checksum, body, Date.now(), Date.now());
    const circuit = this.circuit(envelope.target);
    if (Number(circuit.open_until || 0) > Date.now()) {
      this.sql.exec("UPDATE _lacify_router_deliveries SET next_attempt_at = ?, last_error = 'circuit_open' WHERE event_id = ? AND status = 'pending'", Number(circuit.open_until), envelope.eventId);
      await this.scheduleRecovery();
      return errorResponse('target_circuit_open', 'Event target circuit is temporarily open.', 503);
    }
    try {
      let response;
      if (envelope.target === 'reporting') {
        if (!this.env.REPORTING_SINK || !this.env.LACIFY_REPORTING_SINK_SECRET) throw new Error('reporting_unavailable');
        response = await this.env.REPORTING_SINK.fetch('https://lacify.internal/v1/events', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lacify-event-sink-secret': this.env.LACIFY_REPORTING_SINK_SECRET }, body });
      } else if (envelope.target === 'realtime') {
        if (!this.env.REALTIME_SINK || !this.env.LACIFY_REALTIME_SINK_SECRET) throw new Error('realtime_unavailable');
        response = await this.env.REALTIME_SINK.fetch('https://lacify.internal/v1/internal/events', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lacify-event-sink-secret': this.env.LACIFY_REALTIME_SINK_SECRET }, body });
      } else {
        if (!this.env.ARCHIVE) throw new Error('archive_unavailable');
        const day = new Date(envelope.occurredAt).toISOString().slice(0, 10);
        await this.env.ARCHIVE.put(['events', ${JSON.stringify(projectId)}, this.env.LACIFY_ENVIRONMENT || 'development', day, envelope.eventId + '.json'].join('/'), body, { httpMetadata: { contentType: 'application/json' } });
        response = new Response(null, { status: 202 });
      }
      if (!response.ok && response.status !== 409) throw new Error(envelope.target + '_' + response.status);
      this.sql.exec("UPDATE _lacify_router_deliveries SET status = 'delivered', attempts = attempts + 1, body = NULL, next_attempt_at = NULL, last_error = NULL, delivered_at = ? WHERE event_id = ?", Date.now(), envelope.eventId);
      this.recordSuccess(envelope.target);
      return Response.json({ success: true, eventId: envelope.eventId, target: envelope.target, duplicate: response.status === 409 }, { status: response.status === 409 ? 409 : 202 });
    } catch (error) {
      const code = /^[a-z]+_[0-9]{3}$/.test(error?.message || '') || /^[a-z]+_unavailable$/.test(error?.message || '') ? error.message : 'delivery_failed';
      const row = [...this.sql.exec("SELECT attempts FROM _lacify_router_deliveries WHERE event_id = ?", envelope.eventId)][0];
      const attempts = Number(row?.attempts || 0) + 1;
      const retryAt = Math.max(Date.now() + Math.min(300000, 1000 * (2 ** Math.min(attempts - 1, 8))), this.recordFailure(envelope.target));
      this.sql.exec("UPDATE _lacify_router_deliveries SET attempts = ?, body = ?, next_attempt_at = ?, last_error = ? WHERE event_id = ? AND status = 'pending'", attempts, body, retryAt, code, envelope.eventId);
      await this.scheduleRecovery();
      return errorResponse('target_delivery_failed', 'Event target delivery failed.', 503);
    }
  }

  async alarm() {
    const rows = [...this.sql.exec("SELECT event_id, checksum, body FROM _lacify_router_deliveries WHERE status = 'pending' AND next_attempt_at <= ? AND body IS NOT NULL ORDER BY next_attempt_at, event_id LIMIT ?", Date.now(), recoveryBatchSize)];
    for (const row of rows) {
      let envelope;
      try { envelope = JSON.parse(row.body); } catch {
        this.sql.exec("UPDATE _lacify_router_deliveries SET next_attempt_at = NULL, last_error = 'invalid_recovery_body' WHERE event_id = ?", row.event_id);
        continue;
      }
      await this.performDelivery(envelope, row.body, row.checksum);
    }
    this.sql.exec("DELETE FROM _lacify_router_deliveries WHERE event_id IN (SELECT event_id FROM _lacify_router_deliveries WHERE status = 'delivered' AND delivered_at < ? ORDER BY delivered_at LIMIT 128)", Date.now() - 604800000);
    await this.scheduleRecovery();
  }

  async fetch(request) {
    if (new URL(request.url).pathname === '/health') {
      const row = [...this.sql.exec("SELECT SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered, SUM(attempts) AS attempts, MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending_at FROM _lacify_router_deliveries")][0];
      const circuits = [...this.sql.exec("SELECT target, consecutive_failures, open_until FROM _lacify_router_circuits WHERE consecutive_failures > 0 ORDER BY target LIMIT 3")];
      return Response.json({ ok: Number(row?.pending || 0) < maxPendingPerShard, router: true, pending: Number(row?.pending || 0), delivered: Number(row?.delivered || 0), attempts: Number(row?.attempts || 0), oldestPendingAt: row?.oldest_pending_at === null || row?.oldest_pending_at === undefined ? null : Number(row.oldest_pending_at), capacity: maxPendingPerShard, circuits: circuits.map((item) => ({ target: item.target, failures: Number(item.consecutive_failures), openUntil: Number(item.open_until) })) });
    }
    const body = await request.text();
    const envelope = JSON.parse(body);
    return this.deliver(envelope, body);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/__lacify/router/health') {
      const bindingStatus = Object.fromEntries(configuredTargets.map((target) => [target, target === 'reporting' ? Boolean(env.REPORTING_SINK && env.LACIFY_REPORTING_SINK_SECRET) : target === 'realtime' ? Boolean(env.REALTIME_SINK && env.LACIFY_REALTIME_SINK_SECRET) : Boolean(env.ARCHIVE)]));
      const layers = [{ layer: 'router', ok: Boolean(env.EVENT_ROUTER_DO && env.LACIFY_EVENT_ROUTER_SECRET) }, ...configuredTargets.map((target) => ({ layer: target, ok: bindingStatus[target] }))];
      if (url.searchParams.get('deep') === '1') {
        if (bindingStatus.reporting) {
          const response = await env.REPORTING_SINK.fetch('https://lacify.internal/__lacify/reporting/health').catch(() => null);
          layers.find((layer) => layer.layer === 'reporting').ok = Boolean(response?.ok);
        }
        if (bindingStatus.realtime) {
          const response = await env.REALTIME_SINK.fetch('https://lacify.internal/__lacify/realtime/health').catch(() => null);
          layers.find((layer) => layer.layer === 'realtime').ok = Boolean(response?.ok);
        }
      }
      const eventId = url.searchParams.get('eventId');
      const target = url.searchParams.get('target');
      let shard = null;
      if (eventId && target && targets.has(target) && /^[A-Za-z0-9._:-]{1,160}$/.test(eventId)) {
        const shardBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(eventId));
        const shardName = (new Uint8Array(shardBytes)[0] & 15).toString(16);
        const actor = env.EVENT_ROUTER_DO.get(env.EVENT_ROUTER_DO.idFromName([${JSON.stringify(projectId)}, env.LACIFY_ENVIRONMENT || 'development', target, shardName].join(':')));
        const response = await actor.fetch('https://lacify.internal/health');
        shard = await response.json().catch(() => null);
      }
      return Response.json({ ok: layers.every((layer) => layer.ok) && (!shard || shard.ok), service: 'lacify-event-router', configuredTargets, layers, shard }, { status: layers.every((layer) => layer.ok) && (!shard || shard.ok) ? 200 : 503 });
    }
    if (url.pathname === '/__lacify/router/preflight' && request.method === 'POST') {
      if (!env.LACIFY_PREFLIGHT_SECRET || request.headers.get('x-lacify-preflight-approval') !== env.LACIFY_PREFLIGHT_SECRET) return errorResponse('preflight_approval_required', 'Exact deployment preflight approval is required.', 403);
      const response = await this.fetch(new Request('https://lacify.internal/__lacify/router/health?deep=1'), env);
      const result = await response.json();
      return Response.json({ ...result, preflight: true, remoteMutation: false }, { status: response.status });
    }
    if (url.pathname !== '/v1/events' || request.method !== 'POST') return errorResponse('not_found', 'Event router route not found.', 404);
    if (!env.LACIFY_EVENT_ROUTER_SECRET) return errorResponse('router_unavailable', 'Event router authentication is unavailable.', 503);
    const timestamp = request.headers.get('x-lacify-event-timestamp');
    const signature = request.headers.get('x-lacify-event-signature');
    const timestampValue = Number(timestamp);
    if (!Number.isSafeInteger(timestampValue) || Math.abs(Date.now() - timestampValue) > 60000) return errorResponse('event_replay_window', 'Event timestamp is outside the replay window.', 401);
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > maxEnvelopeBytes) return errorResponse('event_size_limit', 'Event envelope exceeds its size limit.', 413);
    const expected = await hmac(env.LACIFY_EVENT_ROUTER_SECRET, timestamp + '.' + body);
    if (!equalHex(signature, expected)) return errorResponse('event_signature_invalid', 'Event signature is invalid.', 401);
    let envelope;
    try { envelope = JSON.parse(body); } catch { return errorResponse('invalid_json', 'Event envelope must be JSON.', 400); }
    if (envelope?.version !== 'lacify.dev/event/v1' || typeof envelope.eventId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(envelope.eventId) || !targets.has(envelope.target) || typeof envelope.event !== 'string' || !/^[A-Z][A-Za-z0-9]{0,62}$/.test(envelope.event) || !Number.isSafeInteger(envelope.occurredAt)) return errorResponse('invalid_event_envelope', 'Event envelope is invalid.', 422);
    if (envelope.target === 'reporting' && !envelope.projection?.key) return errorResponse('invalid_reporting_route', 'Reporting projection key is required.', 422);
    if (envelope.target === 'realtime' && (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(envelope.routing?.roomClass || '') || typeof envelope.routing?.room !== 'string' || !/^[A-Za-z0-9._~-]{1,128}$/.test(envelope.routing.room))) return errorResponse('invalid_realtime_route', 'Realtime room route is invalid.', 422);
    const shardBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(envelope.eventId));
    const shard = (new Uint8Array(shardBytes)[0] & 15).toString(16);
    const actor = env.EVENT_ROUTER_DO.get(env.EVENT_ROUTER_DO.idFromName([${JSON.stringify(projectId)}, env.LACIFY_ENVIRONMENT || 'development', envelope.target, shard].join(':')));
    return actor.fetch(new Request('https://lacify.internal/deliver', { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
  },
};
`
}

function reportingWorkerSource(projectId: string) {
  return `import { DurableObject } from 'cloudflare:workers';

const maxEventBytes = 262144;
const identifier = /^[A-Z][A-Za-z0-9]{0,62}$/;

function jsonError(code, message, status) {
  return Response.json({ success: false, error: { code, message } }, { status });
}

export class ReportingActor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS _lacify_report_events (event_id TEXT PRIMARY KEY, source_partition TEXT NOT NULL, event_name TEXT NOT NULL, source_sequence INTEGER, payload TEXT NOT NULL, projection TEXT NOT NULL, occurred_at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS _lacify_report_daily (day TEXT NOT NULL, event_name TEXT NOT NULL, dimension_key TEXT NOT NULL, measure TEXT NOT NULL, total REAL NOT NULL, event_count INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (day, event_name, dimension_key, measure))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS _lacify_report_cursors (source_partition TEXT NOT NULL, event_name TEXT NOT NULL, last_sequence INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (source_partition, event_name))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS _lacify_report_gaps (source_partition TEXT NOT NULL, event_name TEXT NOT NULL, expected_sequence INTEGER NOT NULL, received_sequence INTEGER NOT NULL, detected_at INTEGER NOT NULL, resolved_at INTEGER, PRIMARY KEY (source_partition, event_name, expected_sequence))");
  }

  project(event) {
    const projection = event.projection;
    const dimensions = Object.fromEntries(projection.dimensions.map((field) => [field, event.payload[field] ?? null]));
    const dimensionKey = JSON.stringify(dimensions);
    const day = new Date(event.occurredAt).toISOString().slice(0, 10);
    for (const measure of projection.measures) {
      const value = event.payload[measure.field];
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('invalid_measure');
      this.sql.exec("INSERT INTO _lacify_report_daily (day, event_name, dimension_key, measure, total, event_count, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT(day, event_name, dimension_key, measure) DO UPDATE SET total = total + excluded.total, event_count = event_count + 1, updated_at = excluded.updated_at", day, event.event, dimensionKey, measure.field, value, Date.now());
    }
    if (projection.sequenceField) {
      const sequence = event.payload[projection.sequenceField];
      if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('invalid_sequence');
      const cursor = [...this.sql.exec("SELECT last_sequence FROM _lacify_report_cursors WHERE source_partition = ? AND event_name = ?", event.partitionKey, event.event)][0];
      const expected = Number(cursor?.last_sequence || 0) + 1;
      if (sequence > expected) this.sql.exec("INSERT OR IGNORE INTO _lacify_report_gaps (source_partition, event_name, expected_sequence, received_sequence, detected_at) VALUES (?, ?, ?, ?, ?)", event.partitionKey, event.event, expected, sequence, Date.now());
      this.sql.exec("INSERT INTO _lacify_report_cursors (source_partition, event_name, last_sequence, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(source_partition, event_name) DO UPDATE SET last_sequence = MAX(last_sequence, excluded.last_sequence), updated_at = excluded.updated_at", event.partitionKey, event.event, sequence, Date.now());
    }
  }

  consume(event) {
    const existing = [...this.sql.exec("SELECT event_id FROM _lacify_report_events WHERE event_id = ?", event.eventId)][0];
    if (existing) return false;
    this.ctx.storage.transactionSync(() => {
      this.project(event);
      const sourceSequence = event.projection.sequenceField ? event.payload[event.projection.sequenceField] : null;
      this.sql.exec("INSERT INTO _lacify_report_events (event_id, source_partition, event_name, source_sequence, payload, projection, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)", event.eventId, event.partitionKey, event.event, sourceSequence, JSON.stringify(event.payload), JSON.stringify(event.projection), event.occurredAt);
    });
    return true;
  }

  rebuild() {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM _lacify_report_daily");
      this.sql.exec("DELETE FROM _lacify_report_cursors");
      this.sql.exec("DELETE FROM _lacify_report_gaps");
      const rows = [...this.sql.exec("SELECT event_id, source_partition, event_name, source_sequence, payload, projection, occurred_at FROM _lacify_report_events ORDER BY source_partition, event_name, CASE WHEN source_sequence IS NULL THEN occurred_at ELSE source_sequence END, event_id")];
      for (const row of rows) this.project({ eventId: row.event_id, partitionKey: row.source_partition, event: row.event_name, payload: JSON.parse(row.payload), projection: JSON.parse(row.projection), occurredAt: Number(row.occurred_at) });
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/events' && request.method === 'POST') {
      const event = await request.json().catch(() => null);
      if (!event || event.version !== 'lacify.dev/event/v1' || event.target !== 'reporting' || typeof event.eventId !== 'string' || !identifier.test(event.event) || typeof event.partitionKey !== 'string' || !event.partitionKey || typeof event.projection?.key !== 'string' || !event.projection.key || !Array.isArray(event.projection.dimensions) || !Array.isArray(event.projection.measures)) return jsonError('invalid_reporting_event', 'Reporting event contract is invalid.', 422);
      event.occurredAt = Number.isSafeInteger(event.occurredAt) ? event.occurredAt : Date.now();
      try {
        const inserted = this.consume(event);
        return Response.json({ success: true, eventId: event.eventId, duplicate: !inserted }, { status: inserted ? 202 : 409 });
      } catch (error) {
        return jsonError('projection_failed', 'Reporting projection failed safely.', 409);
      }
    }
    if (url.pathname === '/summary' && request.method === 'GET') {
      const eventName = url.searchParams.get('event');
      const fromDay = url.searchParams.get('fromDay') || '0000-01-01';
      const toDay = url.searchParams.get('toDay') || '9999-12-31';
      if (!eventName || !identifier.test(eventName) || !/^\\d{4}-\\d{2}-\\d{2}$/.test(fromDay) || !/^\\d{4}-\\d{2}-\\d{2}$/.test(toDay)) return jsonError('invalid_report_query', 'A bounded report event and date range are required.', 400);
      const rows = [...this.sql.exec("SELECT day, event_name, dimension_key, measure, total, event_count, updated_at FROM _lacify_report_daily WHERE event_name = ? AND day >= ? AND day <= ? ORDER BY day, dimension_key, measure LIMIT 501", eventName, fromDay, toDay)];
      if (rows.length > 500) return jsonError('report_row_limit', 'Report exceeds its 500 row limit.', 422);
      return Response.json({ success: true, items: rows.map((row) => ({ day: row.day, event: row.event_name, dimensions: JSON.parse(row.dimension_key), measure: row.measure, total: Number(row.total), eventCount: Number(row.event_count), updatedAt: Number(row.updated_at) })) });
    }
    if (url.pathname === '/reconciliation' && request.method === 'GET') {
      const gaps = [...this.sql.exec("SELECT source_partition, event_name, expected_sequence, received_sequence, detected_at FROM _lacify_report_gaps WHERE resolved_at IS NULL ORDER BY detected_at LIMIT 101")];
      const eventCount = Number([...this.sql.exec("SELECT COUNT(*) AS count FROM _lacify_report_events")][0]?.count || 0);
      const projectionCells = Number([...this.sql.exec("SELECT COUNT(*) AS count FROM _lacify_report_daily")][0]?.count || 0);
      return Response.json({ success: true, healthy: gaps.length === 0, eventCount, projectionCells, gapCount: gaps.length, gaps: gaps.slice(0, 100).map((row) => ({ sourcePartition: row.source_partition, event: row.event_name, expectedSequence: Number(row.expected_sequence), receivedSequence: Number(row.received_sequence), detectedAt: Number(row.detected_at) })) });
    }
    if (url.pathname === '/rebuild' && request.method === 'POST') {
      if (!this.env.LACIFY_REPORTING_REBUILD_SECRET || request.headers.get('x-lacify-reporting-approval') !== this.env.LACIFY_REPORTING_REBUILD_SECRET) return jsonError('approval_required', 'Exact reporting rebuild approval is required.', 403);
      this.rebuild();
      return Response.json({ success: true, rebuilt: true });
    }
    return jsonError('not_found', 'Reporting route not found.', 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/__lacify/reporting/health' && request.method === 'GET') return Response.json({ ok: Boolean(env.REPORTING_DO && env.LACIFY_REPORTING_SINK_SECRET), service: 'lacify-reporting', sqlite: true });
    if (url.pathname === '/v1/events' && request.method === 'POST') {
      if (!env.LACIFY_REPORTING_SINK_SECRET || request.headers.get('x-lacify-event-sink-secret') !== env.LACIFY_REPORTING_SINK_SECRET) return jsonError('sink_authentication_required', 'Event sink authentication is required.', 401);
      if (Number(request.headers.get('content-length') || 0) > maxEventBytes) return jsonError('event_size_limit', 'Event exceeds its size limit.', 413);
      const event = await request.clone().json().catch(() => null);
      if (!event?.projection?.key) return jsonError('invalid_reporting_key', 'Reporting key is required.', 422);
      return env.REPORTING_DO.get(env.REPORTING_DO.idFromName([${JSON.stringify(projectId)}, env.LACIFY_ENVIRONMENT || 'development', event.projection.key].join(':'))).fetch(new Request('https://lacify.internal/events', request));
    }
    const match = /^\\/v1\\/reports\\/([A-Za-z0-9._~-]{1,128})\\/(summary|reconciliation|rebuild)$/.exec(url.pathname);
    if (!match) return jsonError('not_found', 'Reporting route not found.', 404);
    if (!env.LACIFY_REPORTING_READ_TOKEN || request.headers.get('authorization') !== 'Bearer ' + env.LACIFY_REPORTING_READ_TOKEN) return jsonError('report_authentication_required', 'Reporting authentication is required.', 401);
    const [, key, action] = match;
    const actor = env.REPORTING_DO.get(env.REPORTING_DO.idFromName([${JSON.stringify(projectId)}, env.LACIFY_ENVIRONMENT || 'development', key].join(':')));
    const forwarded = new Request('https://lacify.internal/' + action + url.search, request);
    return actor.fetch(forwarded);
  },
};
`
}

function schemaSource(contracts: SourceContract[]) {
  const generated = contracts.flatMap((contract) => contract.objects.map((object) => {
    const table = objectTable(contract, object.name)
    return `CREATE TABLE IF NOT EXISTS ${table} (\n  id TEXT PRIMARY KEY,\n  ${contract.key} TEXT NOT NULL,\n  state TEXT NOT NULL,\n  payload TEXT NOT NULL,\n  created_at INTEGER NOT NULL,\n  updated_at INTEGER NOT NULL\n);`
  })).join('\n\n')
  const authored = contracts.flatMap((contract) => (contract.migrations || []).map((migration) => `-- ${contract.aggregateType} ${migration.id} (${migration.checksum})\n${migration.sql.trim()}`)).join('\n\n')
  return `${generated}${authored ? `\n\n${authored}` : ''}\n`
}

function kotlinRoute(contract: SourceContract) {
  const primary = contract.objects[0]
  const flow = contract.states.find((state) => state.obj === primary.name)?.flow || ['Draft', 'Completed']
  return `    post("/v1/${contract.aggregateType.toLowerCase()}s/{partitionId}/commands") {
      val partitionId = call.parameters["partitionId"] ?: return@post call.respond(HttpStatusCode.BadRequest)
      val input = call.receive<CommandInput>()
      val result = runtime.execute("${contract.id}", partitionId, input.command, input.payload, setOf(${contract.actions.map((action) => `"${action}"`).join(', ')}), listOf(${flow.map((state) => `"${state}"`).join(', ')}))
      call.respond(result.status, result.body)
    }`
}

function kotlinStarter(contracts: SourceContract[]) {
  const routes = contracts.map(kotlinRoute).join('\n')
  const contractJson = stable(contracts.map(({ revision, ...contract }) => ({ ...contract, revision })))
  return {
    'kotlin-ktor/settings.gradle.kts': `rootProject.name = "lacify-backend"\n`,
    'kotlin-ktor/build.gradle.kts': `plugins {
  kotlin("jvm") version "2.3.21"
  kotlin("plugin.serialization") version "2.3.21"
  application
}
repositories { mavenCentral() }
dependencies {
  implementation("io.ktor:ktor-server-core:3.5.1")
  implementation("io.ktor:ktor-server-netty:3.5.1")
  implementation("io.ktor:ktor-server-content-negotiation:3.5.1")
  implementation("io.ktor:ktor-serialization-kotlinx-json:3.5.1")
}
application { mainClass.set("lacify.ApplicationKt") }
kotlin { jvmToolchain(21) }
`,
    'kotlin-ktor/src/main/kotlin/lacify/Application.kt': `package lacify

import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import java.util.concurrent.ConcurrentHashMap

private val lifecycle = listOf("Wake", "Validate", "Execute", "Persist", "Update summary", "Respond", "Sleep")
@Serializable data class CommandInput(val command: String, val payload: JsonElement? = null)
@Serializable data class CommandResult(val success: Boolean, val aggregate: String, val partitionId: String, val state: String, val version: Int, val lifecycle: List<String>)
data class RuntimeResponse(val status: HttpStatusCode, val body: Any)
data class PartitionState(val state: String, val version: Int)

/** Replace this in-memory adapter with a transactional JDBC/R2DBC store before production use. */
class InMemoryRuntime {
  private val state = ConcurrentHashMap<String, PartitionState>()
  fun execute(aggregate: String, partitionId: String, command: String, payload: JsonElement?, allowed: Set<String>, flow: List<String>): RuntimeResponse {
    if (command !in allowed) return RuntimeResponse(HttpStatusCode.BadRequest, mapOf("error" to "Unsupported command"))
    val key = "$aggregate:$partitionId"
    val next = state.compute(key) { _, current ->
      val index = current?.let { flow.indexOf(it.state).coerceAtLeast(0) } ?: -1
      PartitionState(flow[(index + 1) % flow.size], (current?.version ?: 0) + 1)
    }!!
    return RuntimeResponse(HttpStatusCode.OK, CommandResult(true, aggregate, partitionId, next.state, next.version, lifecycle))
  }
}

fun main() { embeddedServer(Netty, port = System.getenv("PORT")?.toIntOrNull() ?: 8080, module = Application::module).start(wait = true) }
fun Application.module() {
  install(ContentNegotiation) { json() }
  val runtime = InMemoryRuntime()
  routing {
    get("/health") { call.respond(mapOf("ok" to true, "runtime" to "lacify")) }
${routes}
  }
}
`,
    'kotlin-ktor/contracts.json': `${contractJson}\n`,
    'kotlin-ktor/README.md': `# Lacify Kotlin/Ktor starter

This target preserves the generated command routes and lifecycle contract. It intentionally uses an in-memory adapter for local development; replace it with a transactional database adapter before production use. Cloudflare Durable Object isolation is not emulated by this target.\n`,
  }
}

function webBackendStarter(contracts: SourceContract[]) {
  const routes = contracts.map((contract) => {
    const primary = contract.objects[0]
    const flow = contract.states.find((state) => state.obj === primary.name)?.flow || ['Draft', 'Completed']
    return `  if (request.method === 'POST' && pathname.match(/^\\/v1\\/${contract.aggregateType.toLowerCase()}s\\/[^/]+\\/commands$/)) {
    const result = execute('${contract.id}', pathname.split('/')[3], body, ${JSON.stringify([...contract.actions].sort())}, ${JSON.stringify(flow)});
    return send(response, result.status, result.body);
  }`
  }).join('\n')
  return {
    'web-backend/package.json': `${JSON.stringify({ name: 'lacify-web-backend', private: true, type: 'module', scripts: { start: 'node server.mjs' } }, null, 2)}\n`,
    'web-backend/server.mjs': `import { createServer } from 'node:http';

const lifecycle = ['Wake', 'Validate', 'Execute', 'Persist', 'Update summary', 'Respond', 'Sleep'];
const partitions = new Map();
const readJson = (request) => new Promise((resolve, reject) => { let body = ''; request.on('data', (chunk) => body += chunk); request.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('JSON body is required')); } }); });
const send = (response, status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
function execute(aggregate, partitionId, body, allowed, flow) {
  if (!allowed.includes(body.command)) return { status: 400, body: { error: 'Unsupported command' } };
  const key = aggregate + ':' + partitionId;
  const current = partitions.get(key);
  const index = current ? Math.max(0, flow.indexOf(current.state)) : -1;
  const next = { state: flow[(index + 1) % flow.length], version: (current?.version || 0) + 1 };
  partitions.set(key, next);
  return { status: 200, body: { success: true, aggregate, partitionId, state: next.state, version: next.version, lifecycle } };
}
createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/health') return send(response, 200, { ok: true, runtime: 'lacify' });
  let body; try { body = await readJson(request); } catch (error) { return send(response, 400, { error: error.message }); }
${routes}
  return send(response, 404, { error: 'Not found' });
}).listen(process.env.PORT || 8080);
`,
    'web-backend/contracts.json': `${stable(contracts)}\n`,
    'web-backend/README.md': `# Lacify web backend starter

Run with \`npm start\`. The generated server has no dependencies and preserves command routing plus lifecycle transitions for local development. Replace the in-memory partition map with a transactional database adapter before production use.\n`,
  }
}

function reactWebAppStarter(projectId: string, contracts: SourceContract[], blueprint?: WebAppBlueprint) {
  const selected = blueprint?.aggregates?.length ? contracts.filter((contract) => blueprint.aggregates.includes(contract.id)) : contracts
  const appName = blueprint?.name || `${projectId} operations`
  const aggregates = selected.map((contract) => ({ id: contract.id, label: contract.name, path: contract.aggregateType.toLowerCase(), key: contract.key, actions: [...contract.actions].sort() }))
  return {
    'webapp-react/package.json': `${JSON.stringify({ name: `${projectId}-webapp`, private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' }, dependencies: { '@vitejs/plugin-react': '^6.0.3', vite: '^8.1.5', react: '^19.2.7', 'react-dom': '^19.2.7' }, devDependencies: {} }, null, 2)}\n`,
    'webapp-react/index.html': `<div id="root"></div><script type="module" src="/src/main.jsx"></script>\n`,
    'webapp-react/src/main.jsx': `import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const aggregates = ${JSON.stringify(aggregates)};
const apiBase = import.meta.env.VITE_LACIFY_RUNTIME_URL || 'http://localhost:8787';
function App() {
  const [aggregateId, setAggregateId] = useState(aggregates[0]?.id || '');
  const aggregate = useMemo(() => aggregates.find((item) => item.id === aggregateId), [aggregateId]);
  const [partitionId, setPartitionId] = useState('');
  const [command, setCommand] = useState('');
  const [payload, setPayload] = useState('{}');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault(); setError(''); setResult(null);
    try {
      const parsed = JSON.parse(payload || '{}');
      const action = command || aggregate.actions[0];
      const response = await fetch(apiBase + '/v1/' + aggregate.path + 's/' + encodeURIComponent(partitionId) + '/commands', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: action, payload: parsed }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Command failed'); setResult(body);
    } catch (reason) { setError(reason.message || 'Command failed'); }
  }
  if (!aggregate) return <main><h1>${appName}</h1><p>No aggregate has been selected in the Lacify blueprint.</p></main>;
  return <main><header><p>Generated by Lacify Runtime</p><h1>${appName}</h1><span>Command console</span></header><form onSubmit={submit}><label>Aggregate<select value={aggregateId} onChange={(event) => { setAggregateId(event.target.value); setCommand(''); }}>{aggregates.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label>{aggregate.key}<input required value={partitionId} onChange={(event) => setPartitionId(event.target.value)} placeholder="e.g. order-101" /></label><label>Command<select value={command} onChange={(event) => setCommand(event.target.value)}>{aggregate.actions.map((action) => <option key={action} value={action}>{action}</option>)}</select></label><label>Payload JSON<textarea value={payload} onChange={(event) => setPayload(event.target.value)} rows="8" /></label><button>Run command</button></form>{error && <p className="error">{error}</p>}{result && <section><h2>Runtime response</h2><pre>{JSON.stringify(result, null, 2)}</pre></section>}</main>;
}
createRoot(document.getElementById('root')).render(<App />);
`,
    'webapp-react/src/style.css': `:root{font-family:Inter,system-ui,sans-serif;color:#202124;background:#f7f8fa}body{margin:0}main{max-width:760px;margin:0 auto;padding:48px 24px}header{margin-bottom:32px}header p,header span{color:#62666d;font-size:13px}h1{margin:6px 0;font-size:30px}form,section{display:grid;gap:16px;padding:20px;background:#fff;border:1px solid #e1e3e6;border-radius:10px}label{display:grid;gap:7px;font-size:13px;font-weight:600}input,select,textarea{padding:10px;border:1px solid #cdd1d6;border-radius:6px;font:inherit}button{justify-self:start;padding:10px 14px;background:#157347;color:#fff;border:0;border-radius:6px;font-weight:700;cursor:pointer}pre{overflow:auto;padding:12px;background:#f3f4f6;border-radius:6px}.error{color:#b42318}\n`,
    'webapp-react/README.md': `# ${appName}

Generated React command console. Set \`VITE_LACIFY_RUNTIME_URL\` to the deployed Lacify runtime URL, then run \`npm install\` and \`npm run dev\`. This MVP exposes explicitly selected aggregate commands; add business screens to the Blueprint before generating customer-facing UI.\n`,
  }
}

export async function compileRelease(projectId: string, sourceContracts: SourceContract[], blueprint?: WebAppBlueprint): Promise<CompiledRelease> {
  if (!sourceContracts.length) throw new Error('Add at least one contract before compiling a release.')
  const contracts = await Promise.all([...sourceContracts].sort((left, right) => left.id.localeCompare(right.id)).map(async (contract) => ({
    ...contract,
    migrations: await Promise.all((contract.migrations || []).map(async (migration) => ({
      id: migration.id,
      sql: migration.sql.replace(/\r\n/g, '\n').trim() + '\n',
      checksum: hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(migration.sql.replace(/\r\n/g, '\n').trim() + '\n'))),
    }))),
    operations: await Promise.all([...(contract.operations || [])].sort((left, right) => left.definition.name.localeCompare(right.definition.name)).map(async (operation) => {
      const sql = operation.sql.replace(/\r\n/g, '\n').trim() + '\n'
      return {
        definition: operation.definition,
        sql,
        checksum: hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable({ definition: operation.definition, sql })))),
      }
    })),
  })))
  const aggregateTypes = contracts.map((contract) => contract.aggregateType.toLowerCase())
  if (new Set(aggregateTypes).size !== aggregateTypes.length) throw new Error('Aggregate types must be unique within a release.')
  const manifest = {
    format: 'lacify-release-manifest/v1',
    project: projectId,
    contracts: contracts.map((contract) => ({
      id: contract.id,
      revision: contract.revision,
      aggregateType: contract.aggregateType,
      partitionKey: contract.key,
      objectCount: contract.objects.length,
      commands: [...contract.actions].sort(),
      stateMachines: contract.states.map((state) => ({ object: state.obj, states: [...state.flow] })),
      migrations: (contract.migrations || []).map(({ id, checksum }) => ({ id, checksum })),
      operations: (contract.operations || []).map(({ definition, checksum }) => ({
        name: definition.name,
        kind: definition.kind,
        checksum,
        result: definition.result,
        emits: definition.emits || [],
      })),
    })),
    resourcePlan: {
      durableObjects: contracts.map((contract) => `${contract.aggregateType.toUpperCase()}_DO`),
      sqliteTables: [...new Set(contracts.flatMap((contract) => [...contract.objects.map((object) => objectTable(contract, object.name)), ...authoredTables(contract), '_lacify_outbox']))],
      eventRouter: contracts.some((contract) => (contract.operations || []).some(({ definition }) => (definition.emits || []).length > 0)),
      eventTargets: [...new Set(contracts.flatMap((contract) => (contract.operations || []).flatMap(({ definition }) => (definition.emits || []).map((emit) => emit.target))))].sort(),
      reporting: contracts.some((contract) => (contract.operations || []).some(({ definition }) => (definition.emits || []).some((emit) => emit.target === 'reporting'))),
    },
    lifecycle: lifecycleSteps,
    targets: ['cloudflare-durable-objects', 'kotlin-ktor-starter', 'node-web-backend-starter', 'react-webapp-command-console'],
    webApp: blueprint ? { name: blueprint.name, aggregates: [...blueprint.aggregates].sort() } : null,
  }
  const eventTargets = [...new Set(contracts.flatMap((contract) => (contract.operations || []).flatMap(({ definition }) => (definition.emits || []).map((emit) => emit.target))))]
  const hasEvents = eventTargets.length > 0
  const hasReporting = eventTargets.includes('reporting')
  const hasRealtime = eventTargets.includes('realtime')
  const hasArchive = eventTargets.includes('archive')
  const reportingArtifact = hasReporting ? {
    'reporting-worker.js': reportingWorkerSource(projectId),
    'wrangler.reporting.jsonc': `${JSON.stringify({
      name: `lacify-${projectId}-reporting`,
      main: 'reporting-worker.js',
      compatibility_date: '2026-07-20',
      durable_objects: { bindings: [{ name: 'REPORTING_DO', class_name: 'ReportingActor' }] },
      migrations: [{ tag: 'r1', new_sqlite_classes: ['ReportingActor'] }],
      vars: { LACIFY_ENVIRONMENT: 'development' },
    }, null, 2)}\n`,
  } : {}
  const eventRouterArtifact = hasEvents ? {
    'event-router.js': eventRouterWorkerSource(projectId, eventTargets),
    'wrangler.event-router.jsonc': `${JSON.stringify({
      name: `lacify-${projectId}-event-router`,
      main: 'event-router.js',
      compatibility_date: '2026-07-20',
      durable_objects: { bindings: [{ name: 'EVENT_ROUTER_DO', class_name: 'EventRouterActor' }] },
      migrations: [{ tag: 'r1', new_sqlite_classes: ['EventRouterActor'] }],
      ...(hasReporting || hasRealtime ? {
        services: [
          ...(hasReporting ? [{ binding: 'REPORTING_SINK', service: `lacify-${projectId}-reporting` }] : []),
          ...(hasRealtime ? [{ binding: 'REALTIME_SINK', service: `lacify-realtime-${projectId}` }] : []),
        ],
      } : {}),
      ...(hasArchive ? { r2_buckets: [{ binding: 'ARCHIVE', bucket_name: `lacify-${projectId}-event-archive` }] } : {}),
      vars: { LACIFY_ENVIRONMENT: 'development' },
    }, null, 2)}\n`,
    'deployment-secrets.json': `${JSON.stringify({
      format: 'lacify-deployment-secrets/v1',
      valuesIncluded: false,
      secrets: [
        { name: 'LACIFY_EVENT_ROUTER_SECRET', workers: [`lacify-${projectId}`, `lacify-${projectId}-event-router`], requirement: 'same-value' },
        ...(hasReporting ? [
          { name: 'LACIFY_REPORTING_SINK_SECRET', workers: [`lacify-${projectId}-event-router`, `lacify-${projectId}-reporting`], requirement: 'same-value' },
          { name: 'LACIFY_REPORTING_READ_TOKEN', workers: [`lacify-${projectId}-reporting`], requirement: 'independent' },
          { name: 'LACIFY_REPORTING_REBUILD_SECRET', workers: [`lacify-${projectId}-reporting`], requirement: 'independent' },
        ] : []),
        ...(hasRealtime ? [
          { name: 'LACIFY_REALTIME_SINK_SECRET', workers: [`lacify-${projectId}-event-router`, `lacify-realtime-${projectId}`], requirement: 'same-value' },
        ] : []),
        { name: 'LACIFY_PREFLIGHT_SECRET', workers: [`lacify-${projectId}-event-router`], requirement: 'independent' },
      ],
    }, null, 2)}\n`,
    'deployment-preflight.json': `${JSON.stringify({
      format: 'lacify-deployment-preflight/v1',
      remoteMutation: false,
      endpoint: '/__lacify/router/preflight',
      method: 'POST',
      approvalHeader: 'x-lacify-preflight-approval',
      checks: [
        'event-router-durable-object',
        ...eventTargets.map((target) => `${target}-binding-and-secret`),
        ...eventTargets.filter((target) => target !== 'archive').map((target) => `${target}-deep-health`),
      ],
    }, null, 2)}\n`,
    ...(hasArchive ? {
      'r2-lifecycle.json': `${JSON.stringify({
        format: 'lacify-r2-lifecycle/v1',
        bucket: `lacify-${projectId}-event-archive`,
        remoteMutation: false,
        rules: [{ prefix: `events/${projectId}/`, expireAfterDays: 30, rationale: 'Bound event archive growth; change only with reviewed retention requirements.' }],
      }, null, 2)}\n`,
    } : {}),
  } : {}
  const artifact = {
    'manifest.json': `${stable(manifest)}\n`,
    'worker.js': workerSource(contracts),
    'schema.sql': schemaSource(contracts),
    'wrangler.jsonc': `${JSON.stringify({
      name: `lacify-${projectId}`,
      main: 'worker.js',
      compatibility_date: '2026-07-20',
      durable_objects: { bindings: contracts.map((contract) => ({ name: `${contract.aggregateType.toUpperCase()}_DO`, class_name: `${contract.aggregateType}DO` })) },
      migrations: [{ tag: 'v1', new_sqlite_classes: contracts.map((contract) => `${contract.aggregateType}DO`) }],
      ...(hasEvents ? { services: [{ binding: 'LACIFY_EVENT_SINK', service: `lacify-${projectId}-event-router` }] } : {}),
    }, null, 2)}\n`,
    ...eventRouterArtifact,
    ...reportingArtifact,
    ...kotlinStarter(contracts),
    ...webBackendStarter(contracts),
    ...reactWebAppStarter(projectId, contracts, blueprint),
  }
  const checksum = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable({ manifest, artifact }))))
  return { checksum, manifest, artifact }
}
