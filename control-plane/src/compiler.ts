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
  const table = `${contract.id}_${objectName}`.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
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
    this.storage = ctx.storage;
    this.sql = ctx.storage.sql;
    this.sql.exec(\`CREATE TABLE IF NOT EXISTS _lacify_migrations (migration_id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL);\`);
${migrations}
${tables}
    this.sql.exec(\`CREATE TABLE IF NOT EXISTS lacify_aggregate_state (partition_id TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL);\`);
    this.sql.exec(\`CREATE TABLE IF NOT EXISTS lacify_lifecycle_events (id TEXT PRIMARY KEY, command TEXT NOT NULL, state TEXT NOT NULL, phases TEXT NOT NULL, payload TEXT NOT NULL, occurred_at INTEGER NOT NULL);\`);
    this.sql.exec(\`CREATE TABLE IF NOT EXISTS lacify_daily_summary (day TEXT PRIMARY KEY, command_count INTEGER NOT NULL, last_state TEXT NOT NULL, updated_at INTEGER NOT NULL);\`);
    this.sql.exec(\`CREATE TABLE IF NOT EXISTS _lacify_operation_receipts (operation TEXT NOT NULL, idempotency_key TEXT NOT NULL, input_hash TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (operation, idempotency_key));\`);
    this.sql.exec(\`CREATE TABLE IF NOT EXISTS _lacify_operation_rate_limits (caller_identity_hash TEXT NOT NULL, operation TEXT NOT NULL, window_started_at INTEGER NOT NULL, request_count INTEGER NOT NULL, PRIMARY KEY (caller_identity_hash, operation, window_started_at));\`);
    this.sql.exec(\`CREATE TABLE IF NOT EXISTS _lacify_operation_audit (id TEXT PRIMARY KEY, caller_identity_hash TEXT NOT NULL, operation TEXT NOT NULL, kind TEXT NOT NULL, outcome TEXT NOT NULL, status_code INTEGER NOT NULL, occurred_at INTEGER NOT NULL);\`);
  }

  async fetch(request) {
    const url = new URL(request.url);
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
        return Response.json({ ok: true, aggregateType: '${contract.aggregateType}', durableObject: true, sqlite: true, storageBytes: this.sql.databaseSize, tables: [${tableStats}] });
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
        if (operation && idempotencyKey) this.sql.exec('INSERT INTO _lacify_operation_receipts (operation, idempotency_key, input_hash, response, created_at) VALUES (?, ?, ?, ?, ?)', operation.name, idempotencyKey, operationContext.inputHash, JSON.stringify(result), now);
      });
    } catch (error) {
      return failure(error.lacifySafe ? error.code : 'operation_execution_failed', error.lacifySafe ? error.message : 'Operation execution failed.', error.lacifySafe ? error.status : 409);
    }
    const response = Response.json(result);
    response.headers.set('x-lacify-storage-bytes', String(this.sql.databaseSize));
    response.headers.set('x-lacify-table-stats', encodeURIComponent(JSON.stringify([${tableStats}])));
    recordAudit('success', 200);
    return response;
  }
}
`
}

function workerSource(contracts: SourceContract[]) {
  const healthProbes = contracts.map((contract) => `      (async () => {
        const aggregateType = '${contract.aggregateType}';
        const startedAt = Date.now();
        try {
          const response = await env.${contract.aggregateType.toUpperCase()}_DO.get(env.${contract.aggregateType.toUpperCase()}_DO.idFromName('__lacify_health__')).fetch('https://lacify.internal/__lacify/health');
          const payload = await response.json().catch(() => null);
          layers.push({ layer: 'durable_object', aggregateType, ok: response.ok && payload?.durableObject === true, durationMs: Date.now() - startedAt });
          layers.push({ layer: 'sqlite', aggregateType, ok: response.ok && payload?.sqlite === true, durationMs: Date.now() - startedAt, storageBytes: payload?.storageBytes, tables: payload?.tables });
        } catch {
          layers.push({ layer: 'durable_object', aggregateType, ok: false, durationMs: Date.now() - startedAt });
          layers.push({ layer: 'sqlite', aggregateType, ok: false, durationMs: Date.now() - startedAt });
        }
      })()`).join(',\n')
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
    if (policy?.version !== 1 || policy.workspaceId === undefined || policy.projectId === undefined || policy.environment !== env.LACIFY_ENVIRONMENT || !Array.isArray(policy.credentials)) return null;
    return policy;
  } catch {
    return null;
  }
}

async function authorizeOperation(request, env, actor, operation) {
  const authorization = request.headers.get('authorization') || '';
  const match = authorization.match(/^Bearer (lacify_runtime_[A-Za-z0-9_-]{40,100})$/);
  if (!match) return { error: Response.json({ success: false, error: { code: 'application_authentication_required', message: 'Application authentication is required.' } }, { status: 401 }) };
  const policy = applicationAccessPolicy(env);
  if (!policy) return { error: Response.json({ success: false, error: { code: 'application_access_unavailable', message: 'Application access policy is unavailable.' } }, { status: 503 }) };
  const tokenHash = await sha256Text(match[1]);
  const credential = policy.credentials.find((candidate) => candidate?.tokenHash === tokenHash);
  if (!credential || !Number.isSafeInteger(credential.expiresAt) || credential.expiresAt <= Date.now()) return { error: Response.json({ success: false, error: { code: 'application_credential_invalid', message: 'Application credential is invalid or expired.' } }, { status: 401 }) };
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
      })),
    })),
    resourcePlan: {
      durableObjects: contracts.map((contract) => `${contract.aggregateType.toUpperCase()}_DO`),
      sqliteTables: contracts.flatMap((contract) => [...contract.objects.map((object) => objectTable(contract, object.name)), ...authoredTables(contract)]),
    },
    lifecycle: lifecycleSteps,
    targets: ['cloudflare-durable-objects', 'kotlin-ktor-starter', 'node-web-backend-starter', 'react-webapp-command-console'],
    webApp: blueprint ? { name: blueprint.name, aggregates: [...blueprint.aggregates].sort() } : null,
  }
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
    }, null, 2)}\n`,
    ...kotlinStarter(contracts),
    ...webBackendStarter(contracts),
    ...reactWebAppStarter(projectId, contracts, blueprint),
  }
  const checksum = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable({ manifest, artifact }))))
  return { checksum, manifest, artifact }
}
