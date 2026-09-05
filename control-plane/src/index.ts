import { compileRelease, type RuntimeContract, type WebAppBlueprint } from './compiler.ts'
import { durationBucket, metricBucketStart, summarizeMetricRows, type MetricBucketRow } from './metrics.ts'
import { generatedWorkerJavaScript } from './worker-artifact.ts'
import {
  applicationSessionLifetimeMs,
  applicationSessionRefreshWindowMs,
  authenticationBlocked,
  csrfTokens,
  nextAuthenticationFailure,
  originAllowed,
  requestCookie,
  validCsrfPair,
} from './auth-security.ts'

export interface Env {
  DB: D1Database
  SESSION_ENCRYPTION_KEY: string
  ALLOWED_ORIGIN?: string
  LOCAL_ORIGIN?: string
  PUBLIC_BASE_URL?: string
  CONTROL_DB_ID?: string
  CONTROL_RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> }
  SENSITIVE_RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> }
}

interface Session {
  id: string
  user_id?: string
  workspace_id?: string
  session_public_id?: string
  csrf_hash?: string
  kind?: 'application' | 'legacy' | 'cli'
  account_id: string
  account_name: string
  expires_at: number
  revoked_at: number | null
}

interface ApplicationUser {
  id: string
  provider: 'cloudflare_account'
  provider_subject: string
  display_name: string
  disabled_at: number | null
}

interface ContractDocument extends RuntimeContract {
  size: string
  queries: number
  status: 'active' | 'dormant' | 'error'
}

const identifier = /^[A-Za-z][A-Za-z0-9]*$/
const resourceId = /^[a-z0-9][a-z0-9-_]{0,62}$/
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  },
})
const now = () => Date.now()
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`
const sessionLifetimeMs = applicationSessionLifetimeMs
const telemetryCredentialLifetimeMs = 365 * 24 * 60 * 60 * 1000
const telemetryMaxBodyBytes = 64 * 1024
const telemetryMaxEventsPerBatch = 50
const telemetryMaxPastAgeMs = 24 * 60 * 60 * 1000
const telemetryMaxFutureSkewMs = 5 * 60 * 1000

function monthBucketStart(value: number) {
  const date = new Date(value)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

interface TelemetryEventInput {
  id?: unknown
  occurredAt?: unknown
  aggregateType?: unknown
  partitionKeyHash?: unknown
  action?: unknown
  outcome?: unknown
  durationMs?: unknown
  statusCode?: unknown
  sqliteReads?: unknown
  sqliteWrites?: unknown
  storageBytes?: unknown
  tableStats?: unknown
  callerIdentityHash?: unknown
}

interface TelemetryBatchInput {
  schemaVersion?: unknown
  batchId?: unknown
  deploymentId?: unknown
  releaseId?: unknown
  environment?: unknown
  events?: unknown
}

interface ValidatedTelemetryEvent {
  id: string
  occurredAt: number
  aggregateType: string
  partitionKeyHash: string
  action: string
  outcome: 'success' | 'client_error' | 'runtime_error'
  level: 'info' | 'warning' | 'error'
  durationMs: number
  statusCode: number
  sqliteReads: number
  sqliteWrites: number
  storageBytes: number | null
  tableStats: Array<{ name: string; rows: number }>
  callerIdentityHash: string | null
  message: string
}

interface RuntimeApplicationCapability {
  actor: string
  operations: string[]
  rateLimitPerMinute: number
  maxPayloadBytes: number
}

function base64url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlBytes(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function sessionKey(env: Env) {
  const bytes = base64urlBytes(env.SESSION_ENCRYPTION_KEY)
  if (bytes.byteLength !== 32) throw new Error('Session encryption key is misconfigured.')
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function encryptedTokenEnvelope(token: string, env: Env) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sessionKey(env), new TextEncoder().encode(JSON.stringify({ token })))
  return JSON.stringify({ version: 1, algorithm: 'AES-256-GCM', iv: base64url(iv), ciphertext: base64url(new Uint8Array(encrypted)) })
}

async function decryptedToken(envelope: string, env: Env) {
  const parsed = JSON.parse(envelope) as { version?: number; algorithm?: string; iv?: string; ciphertext?: string }
  if (parsed.version !== 1 || parsed.algorithm !== 'AES-256-GCM' || !parsed.iv || !parsed.ciphertext) throw new Error('Uplink credential is invalid.')
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64urlBytes(parsed.iv) }, await sessionKey(env), base64urlBytes(parsed.ciphertext))
  const token = JSON.parse(new TextDecoder().decode(plaintext)) as { token?: unknown }
  if (typeof token.token !== 'string' || !token.token) throw new Error('Uplink credential is invalid.')
  return token.token
}

function newSessionId() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

function newTelemetryCredential() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

function newRuntimeApplicationCredential() {
  return `lacify_runtime_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function withCors(request: Request, response: Response, env: Env) {
  const origin = request.headers.get('origin')
  if (!origin || (!env.ALLOWED_ORIGIN && !env.LOCAL_ORIGIN) || (origin !== env.ALLOWED_ORIGIN && origin !== env.LOCAL_ORIGIN)) return response
  const headers = new Headers(response.headers)
  headers.set('access-control-allow-origin', origin)
  headers.set('access-control-allow-credentials', 'true')
  headers.set('vary', 'origin')
  return new Response(response.body, { status: response.status, headers })
}

function cookie(request: Request, name: string) {
  return requestCookie(request, name)
}

async function sessionFor(request: Request, env: Env) {
  const authorization = request.headers.get('authorization')
  if (authorization?.startsWith('Bearer ')) {
    const token = authorization.slice(7)
    if (/^lacify_[A-Za-z0-9_-]{40,100}$/.test(token)) {
      const session = await env.DB.prepare(`SELECT
          cli.id AS session_public_id, cli.user_id, cli.workspace_id, cli.expires_at, cli.revoked_at,
          users.provider_subject AS account_id, users.display_name AS account_name
        FROM cli_access_tokens cli
        JOIN application_users users ON users.id = cli.user_id
        WHERE cli.token_hash = ? AND users.disabled_at IS NULL`)
        .bind(await sha256(token))
        .first<Omit<Session, 'id' | 'kind'>>()
      if (session) {
        await env.DB.prepare('UPDATE cli_access_tokens SET last_used_at = ? WHERE id = ?').bind(now(), session.session_public_id).run()
        return { ...session, id: token, kind: 'cli' as const }
      }
    }
  }
  const applicationToken = cookie(request, 'lacify_app_session')
  if (applicationToken) {
    const tokenHash = await sha256(applicationToken)
    const session = await env.DB.prepare(`SELECT
        app.id AS session_public_id, app.user_id, app.workspace_id, app.csrf_hash, app.expires_at, app.revoked_at,
        COALESCE(uplink.account_id, users.provider_subject) AS account_id,
        COALESCE(uplink.account_name, users.display_name) AS account_name
      FROM application_sessions app
      JOIN application_users users ON users.id = app.user_id
      LEFT JOIN uplink_connections uplink ON uplink.workspace_id = app.workspace_id AND uplink.revoked_at IS NULL
      WHERE app.token_hash = ? AND users.disabled_at IS NULL`)
      .bind(tokenHash)
      .first<Omit<Session, 'id' | 'kind'>>()
    if (session) return { ...session, id: applicationToken, kind: 'application' as const }
  }
  const sessionId = cookie(request, 'lacify_uplink_session')
  if (!sessionId) return null
  const legacy = await env.DB.prepare('SELECT id, account_id, account_name, expires_at, revoked_at FROM sessions WHERE id = ?').bind(sessionId).first<Session>()
  return legacy ? { ...legacy, kind: 'legacy' as const } : null
}

async function authorizedSession(request: Request, env: Env) {
  const session = await sessionFor(request, env)
  if (!session || session.revoked_at || session.expires_at <= now()) return null
  return session
}

async function workspaceFor(session: Session, env: Env) {
  if (session.workspace_id) return session.workspace_id
  const workspaceId = `workspace_${session.account_id}`
  await env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, owner_account_id, name, created_at) VALUES (?, ?, ?, ?)').bind(workspaceId, session.account_id, session.account_name, now()).run()
  return workspaceId
}

function stateChangeAllowed(request: Request, env: Env) {
  return originAllowed(request, [env.ALLOWED_ORIGIN, env.LOCAL_ORIGIN])
}

async function csrfStateChangeAllowed(request: Request, env: Env, session: Session) {
  if (session.kind === 'cli') return true
  if (!stateChangeAllowed(request, env)) return false
  if (session.kind === 'legacy') return true
  const tokens = csrfTokens(request)
  if (!session.csrf_hash || !validCsrfPair(tokens.header, tokens.cookie)) return false
  return await sha256(tokens.header) === session.csrf_hash
}

function appendApplicationCookies(response: Response, sessionToken: string, csrfToken: string, expiresAt: number) {
  const maxAge = Math.max(0, Math.floor((expiresAt - now()) / 1000))
  response.headers.append('set-cookie', `lacify_app_session=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}; Priority=High`)
  response.headers.append('set-cookie', `lacify_csrf=${csrfToken}; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}; Priority=High`)
  return response
}

function clearApplicationCookies(response: Response) {
  response.headers.append('set-cookie', 'lacify_app_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0; Priority=High')
  response.headers.append('set-cookie', 'lacify_csrf=; Secure; SameSite=Strict; Path=/; Max-Age=0; Priority=High')
  return response
}

async function requestFingerprint(request: Request) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown'
  const userAgent = request.headers.get('user-agent') || 'unknown'
  return {
    ipHash: await sha256(ip),
    userAgentHash: await sha256(userAgent),
  }
}

async function createApplicationSession(request: Request, env: Env, userId: string, workspaceId: string) {
  const sessionToken = newSessionId()
  const csrfToken = newSessionId()
  const timestamp = now()
  const expiresAt = timestamp + applicationSessionLifetimeMs
  const fingerprint = await requestFingerprint(request)
  const sessionPublicId = id('appsession')
  await env.DB.prepare(`INSERT INTO application_sessions
      (id, token_hash, csrf_hash, user_id, workspace_id, expires_at, revoked_at, created_at, last_seen_at, user_agent_hash, ip_hash)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`)
    .bind(sessionPublicId, await sha256(sessionToken), await sha256(csrfToken), userId, workspaceId, expiresAt, timestamp, timestamp, fingerprint.userAgentHash, fingerprint.ipHash)
    .run()
  return { sessionToken, csrfToken, sessionPublicId, expiresAt }
}

async function authenticationEvent(
  request: Request,
  env: Env,
  eventType: string,
  outcome: 'success' | 'failure' | 'blocked',
  userId?: string | null,
  providerSubject?: string,
) {
  const fingerprint = await requestFingerprint(request)
  await env.DB.prepare(`INSERT INTO authentication_events
      (id, user_id, provider_subject_hash, event_type, outcome, ip_hash, user_agent_hash, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id('auth'), userId || null, providerSubject ? await sha256(providerSubject) : null, eventType, outcome, fingerprint.ipHash, fingerprint.userAgentHash, now())
    .run()
}

async function authRateFingerprint(request: Request, accountId: string) {
  const fingerprint = await requestFingerprint(request)
  return sha256(`${fingerprint.ipHash}:${accountId.toLowerCase()}`)
}

async function authenticationRateRecord(request: Request, env: Env, accountId: string) {
  const fingerprint = await authRateFingerprint(request, accountId)
  const record = await env.DB.prepare('SELECT window_started_at, failure_count, blocked_until FROM authentication_rate_limits WHERE fingerprint = ?')
    .bind(fingerprint)
    .first<{ window_started_at: number; failure_count: number; blocked_until: number | null }>()
  return { fingerprint, record }
}

async function recordAuthenticationFailure(env: Env, fingerprint: string, record: { window_started_at: number; failure_count: number } | null) {
  const timestamp = now()
  const next = nextAuthenticationFailure(record, timestamp)
  await env.DB.prepare(`INSERT INTO authentication_rate_limits
      (fingerprint, window_started_at, failure_count, blocked_until, last_failure_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET
        window_started_at = excluded.window_started_at,
        failure_count = excluded.failure_count,
        blocked_until = excluded.blocked_until,
        last_failure_at = excluded.last_failure_at`)
    .bind(fingerprint, next.windowStartedAt, next.failureCount, next.blockedUntil, timestamp)
    .run()
}

async function ensureApplicationIdentity(
  request: Request,
  env: Env,
  accountId: string,
  accountName: string,
  tokenEnvelope: string,
) {
  const timestamp = now()
  const userId = `user_${accountId}`
  const workspaceId = `workspace_${accountId}`
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO application_users (id, provider, provider_subject, display_name, created_at, updated_at, disabled_at)
      VALUES (?, 'cloudflare_account', ?, ?, ?, ?, NULL)
      ON CONFLICT(provider, provider_subject) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`)
      .bind(userId, accountId, accountName, timestamp, timestamp),
    env.DB.prepare(`INSERT INTO workspaces (id, owner_account_id, owner_user_id, name, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner_user_id = COALESCE(workspaces.owner_user_id, excluded.owner_user_id), name = excluded.name`)
      .bind(workspaceId, accountId, userId, accountName, timestamp),
    env.DB.prepare(`INSERT INTO uplink_connections
      (workspace_id, account_id, account_name, token_envelope, connected_by_user_id, expires_at, revoked_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        account_id = excluded.account_id,
        account_name = excluded.account_name,
        token_envelope = excluded.token_envelope,
        connected_by_user_id = excluded.connected_by_user_id,
        expires_at = excluded.expires_at,
        revoked_at = NULL,
        updated_at = excluded.updated_at`)
      .bind(workspaceId, accountId, accountName, tokenEnvelope, userId, timestamp + telemetryCredentialLifetimeMs, timestamp, timestamp),
  ])
  const session = await createApplicationSession(request, env, userId, workspaceId)
  return { userId, workspaceId, ...session }
}

async function requestJson<T>(request: Request): Promise<T | null> {
  try { return await request.json<T>() } catch { return null }
}

async function limitedTelemetryJson(request: Request): Promise<{ body?: TelemetryBatchInput; status?: number; message?: string }> {
  const declaredLength = Number(request.headers.get('content-length') || 0)
  if (declaredLength > telemetryMaxBodyBytes) return { status: 413, message: 'Telemetry batch is too large.' }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > telemetryMaxBodyBytes) return { status: 413, message: 'Telemetry batch is too large.' }
  try {
    const body = JSON.parse(text) as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, message: 'Telemetry batch must be an object.' }
    return { body: body as TelemetryBatchInput }
  } catch {
    return { status: 400, message: 'Telemetry batch must contain valid JSON.' }
  }
}

export function validateTelemetryEvent(value: unknown, receivedAt: number): { event?: ValidatedTelemetryEvent; message?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { message: 'Every telemetry event must be an object.' }
  const event = value as TelemetryEventInput
  if (typeof event.id !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(event.id)) return { message: 'Telemetry event ID is invalid.' }
  const occurredAt = Number(event.occurredAt)
  if (!Number.isSafeInteger(occurredAt) || occurredAt < receivedAt - telemetryMaxPastAgeMs || occurredAt > receivedAt + telemetryMaxFutureSkewMs) return { message: 'Telemetry event timestamp is expired or outside the allowed clock skew.' }
  if (typeof event.aggregateType !== 'string' || !identifier.test(event.aggregateType)) return { message: 'Telemetry aggregate type is invalid.' }
  if (typeof event.partitionKeyHash !== 'string' || !/^[a-f0-9]{64}$/.test(event.partitionKeyHash)) return { message: 'Telemetry partition-key hash is invalid.' }
  if (typeof event.action !== 'string' || !identifier.test(event.action)) return { message: 'Telemetry action is invalid.' }
  if (event.outcome !== 'success' && event.outcome !== 'client_error' && event.outcome !== 'runtime_error') return { message: 'Telemetry outcome is invalid.' }
  const durationMs = Number(event.durationMs)
  if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 10 * 60 * 1000) return { message: 'Telemetry duration is invalid.' }
  const statusCode = Number(event.statusCode)
  if (!Number.isSafeInteger(statusCode) || statusCode < 100 || statusCode > 599) return { message: 'Telemetry status code is invalid.' }
  const level = event.outcome === 'success' ? 'info' : event.outcome === 'client_error' ? 'warning' : 'error'
  const message = event.outcome === 'success' ? 'Command completed.' : event.outcome === 'client_error' ? `Command rejected (HTTP ${statusCode}).` : `Command failed (HTTP ${statusCode}).`
  const sqliteReads = Number(event.sqliteReads ?? 0)
  const sqliteWrites = Number(event.sqliteWrites ?? 0)
  if (!Number.isSafeInteger(sqliteReads) || sqliteReads < 0 || sqliteReads > 10_000 || !Number.isSafeInteger(sqliteWrites) || sqliteWrites < 0 || sqliteWrites > 10_000) return { message: 'Telemetry SQLite usage is invalid.' }
  const storageBytes = event.storageBytes === null || event.storageBytes === undefined ? null : Number(event.storageBytes)
  if (storageBytes !== null && (!Number.isSafeInteger(storageBytes) || storageBytes < 0 || storageBytes > 10 * 1024 * 1024 * 1024)) return { message: 'Telemetry storage size is invalid.' }
  const tableStats = Array.isArray(event.tableStats) ? event.tableStats.filter((table): table is { name: string; rows: number } => Boolean(table && typeof table === 'object' && typeof table.name === 'string' && /^[a-z0-9_]{1,63}$/.test(table.name) && Number.isSafeInteger(Number(table.rows)) && Number(table.rows) >= 0)).map((table) => ({ name: table.name, rows: Number(table.rows) })).slice(0, 50) : []
  const callerIdentityHash = event.callerIdentityHash === undefined || event.callerIdentityHash === null ? null : event.callerIdentityHash
  if (callerIdentityHash !== null && (typeof callerIdentityHash !== 'string' || !/^[a-f0-9]{64}$/.test(callerIdentityHash))) return { message: 'Telemetry caller-identity hash is invalid.' }
  return { event: { id: event.id, occurredAt, aggregateType: event.aggregateType, partitionKeyHash: event.partitionKeyHash, action: event.action, outcome: event.outcome, level, durationMs, statusCode, sqliteReads, sqliteWrites, storageBytes, tableStats, callerIdentityHash, message } }
}

export function validateRuntimeApplicationCapabilities(value: unknown, contracts: RuntimeContract[]) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return null
  const actors = new Map(contracts.map((contract) => [contract.aggregateType, new Set((contract.operations || []).map(({ definition }) => definition.name))]))
  const capabilities: RuntimeApplicationCapability[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const raw = entry as Record<string, unknown>
    const actor = typeof raw.actor === 'string' ? raw.actor : ''
    const knownOperations = actors.get(actor)
    const operations = Array.isArray(raw.operations) ? raw.operations : []
    const rateLimitPerMinute = raw.rateLimitPerMinute === undefined ? 60 : Number(raw.rateLimitPerMinute)
    const maxPayloadBytes = raw.maxPayloadBytes === undefined ? 65_536 : Number(raw.maxPayloadBytes)
    if (!knownOperations || seen.has(actor) || operations.length < 1 || operations.length > 256) return null
    if (operations.some((operation) => typeof operation !== 'string' || !knownOperations.has(operation)) || duplicate(operations as string[])) return null
    if (!Number.isSafeInteger(rateLimitPerMinute) || rateLimitPerMinute < 1 || rateLimitPerMinute > 10_000) return null
    if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1_024 || maxPayloadBytes > 65_536) return null
    seen.add(actor)
    capabilities.push({ actor, operations: [...operations as string[]].sort(), rateLimitPerMinute, maxPayloadBytes })
  }
  return capabilities.sort((left, right) => left.actor.localeCompare(right.actor))
}

function duplicate(values: string[]) {
  return new Set(values.map((value) => value.toLowerCase())).size !== values.length
}

function validateContractOperations(value: unknown, actions: string[]): { operations?: NonNullable<RuntimeContract['operations']>; message?: string } {
  if (value === undefined) return { operations: [] }
  if (!Array.isArray(value) || value.length > 256) return { message: 'Operations must be an array with at most 256 entries.' }
  const operations: NonNullable<RuntimeContract['operations']> = []
  const names: string[] = []
  const runtimeParameters = new Set(['partitionId', 'now', 'commandId', 'cursor', 'pageSize'])
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { message: 'Every operation must be an object.' }
    const raw = entry as { definition?: unknown; sql?: unknown }
    if (!raw.definition || typeof raw.definition !== 'object' || Array.isArray(raw.definition) || typeof raw.sql !== 'string') return { message: 'Every operation requires a definition and SQL.' }
    const definition = raw.definition as Record<string, unknown>
    const name = typeof definition.name === 'string' ? definition.name : ''
    const kind = definition.kind
    if (definition.version !== 'lacify.dev/operation/v1' || !identifier.test(name) || (kind !== 'command' && kind !== 'query')) return { message: 'Operation version, name, or kind is invalid.' }
    if (kind === 'command' && !actions.includes(name)) return { message: `Command operation "${name}" is not declared by the Actor.` }
    if (typeof definition.sql !== 'string' || !/^\.\/[a-z0-9][a-z0-9-]{0,62}\.sql$/.test(definition.sql)) return { message: `Operation "${name}" SQL path is invalid.` }
    if (!definition.input || typeof definition.input !== 'object' || Array.isArray(definition.input) || Object.keys(definition.input).length > 64) return { message: `Operation "${name}" input is invalid.` }
    const input: Record<string, { type: 'string' | 'integer' | 'number' | 'boolean'; required?: boolean }> = {}
    for (const [fieldName, rawField] of Object.entries(definition.input as Record<string, unknown>)) {
      if (!/^[a-z][A-Za-z0-9]{0,62}$/.test(fieldName) || runtimeParameters.has(fieldName) || !rawField || typeof rawField !== 'object' || Array.isArray(rawField)) return { message: `Operation "${name}" input field is invalid.` }
      const field = rawField as Record<string, unknown>
      if (!['string', 'integer', 'number', 'boolean'].includes(String(field.type)) || (field.required !== undefined && typeof field.required !== 'boolean')) return { message: `Operation "${name}" input type is invalid.` }
      input[fieldName] = { type: field.type as 'string' | 'integer' | 'number' | 'boolean', ...(field.required === undefined ? {} : { required: field.required }) }
    }
    if (!definition.result || typeof definition.result !== 'object' || Array.isArray(definition.result)) return { message: `Operation "${name}" result is invalid.` }
    const rawResult = definition.result as Record<string, unknown>
    const mode = rawResult.mode
    if (!['none', 'one', 'optional', 'many'].includes(String(mode))) return { message: `Operation "${name}" result mode is invalid.` }
    const fields: Record<string, { type: 'string' | 'integer' | 'number' | 'boolean'; nullable?: boolean }> = {}
    if (mode !== 'none') {
      if (!rawResult.fields || typeof rawResult.fields !== 'object' || Array.isArray(rawResult.fields) || Object.keys(rawResult.fields).length < 1 || Object.keys(rawResult.fields).length > 128) return { message: `Operation "${name}" result fields are invalid.` }
      for (const [fieldName, rawField] of Object.entries(rawResult.fields as Record<string, unknown>)) {
        if (!/^[a-z][A-Za-z0-9_]{0,62}$/.test(fieldName) || !rawField || typeof rawField !== 'object' || Array.isArray(rawField)) return { message: `Operation "${name}" result field is invalid.` }
        const field = rawField as Record<string, unknown>
        if (!['string', 'integer', 'number', 'boolean'].includes(String(field.type)) || (field.nullable !== undefined && typeof field.nullable !== 'boolean')) return { message: `Operation "${name}" result field type is invalid.` }
        fields[fieldName] = { type: field.type as 'string' | 'integer' | 'number' | 'boolean', ...(field.nullable === undefined ? {} : { nullable: field.nullable }) }
      }
    } else if (rawResult.fields !== undefined) return { message: `Operation "${name}" none result cannot declare fields.` }
    const result: NonNullable<RuntimeContract['operations']>[number]['definition']['result'] = {
      mode: mode as 'none' | 'one' | 'optional' | 'many',
      ...(mode === 'none' ? {} : { fields }),
    }
    if (mode === 'many') {
      if (!Number.isSafeInteger(rawResult.maxRows) || Number(rawResult.maxRows) < 1 || Number(rawResult.maxRows) > 100) return { message: `Operation "${name}" row limit is invalid.` }
      result.maxRows = Number(rawResult.maxRows)
    } else if (rawResult.maxRows !== undefined) return { message: `Operation "${name}" row limit is invalid.` }
    if (rawResult.pagination !== undefined) {
      if (mode !== 'many' || !rawResult.pagination || typeof rawResult.pagination !== 'object' || Array.isArray(rawResult.pagination)) return { message: `Operation "${name}" pagination is invalid.` }
      const pagination = rawResult.pagination as Record<string, unknown>
      const cursorField = typeof pagination.cursorField === 'string' ? pagination.cursorField : ''
      const defaultPageSize = Number(pagination.defaultPageSize)
      const maxPageSize = Number(pagination.maxPageSize)
      if (!Object.hasOwn(fields, cursorField) || !Number.isSafeInteger(defaultPageSize) || !Number.isSafeInteger(maxPageSize) || defaultPageSize < 1 || maxPageSize > 100 || defaultPageSize > maxPageSize) return { message: `Operation "${name}" pagination bounds are invalid.` }
      result.pagination = { cursorField, defaultPageSize, maxPageSize }
    }
    const emits: NonNullable<RuntimeContract['operations']>[number]['definition']['emits'] = []
    if (definition.emits !== undefined) {
      if (kind !== 'command' || !Array.isArray(definition.emits) || definition.emits.length < 1 || definition.emits.length > 16) {
        return { message: `Operation "${name}" emits must contain 1–16 command event declarations.` }
      }
      const identities = new Set<string>()
      for (const rawEmit of definition.emits) {
        if (!rawEmit || typeof rawEmit !== 'object' || Array.isArray(rawEmit)) return { message: `Operation "${name}" emit declaration is invalid.` }
        const emit = rawEmit as Record<string, unknown>
        const event = typeof emit.event === 'string' ? emit.event : ''
        const target = emit.target
        const durability = emit.durability
        const rawFields = emit.fields
        if (!identifier.test(event) || !['realtime', 'reporting', 'archive'].includes(String(target)) || !['segmented', 'immediate'].includes(String(durability))) {
          return { message: `Operation "${name}" emit identity, target, or durability is invalid.` }
        }
        if (
          !Array.isArray(rawFields) ||
          rawFields.length < 1 ||
          rawFields.length > 32 ||
          rawFields.some((field) => typeof field !== 'string' || !Object.hasOwn(fields, field)) ||
          new Set(rawFields).size !== rawFields.length
        ) return { message: `Operation "${name}" emit fields must reference unique result fields.` }
        const identity = `${target}:${event}`
        if (identities.has(identity)) return { message: `Operation "${name}" emit "${identity}" is duplicated.` }
        identities.add(identity)

        let realtime: { roomClass: string; roomField: string } | undefined
        if (target === 'realtime') {
          if (!emit.realtime || typeof emit.realtime !== 'object' || Array.isArray(emit.realtime)) return { message: `Operation "${name}" realtime emit routing is required.` }
          const routing = emit.realtime as Record<string, unknown>
          const roomClass = typeof routing.roomClass === 'string' ? routing.roomClass : ''
          const roomField = typeof routing.roomField === 'string' ? routing.roomField : ''
          if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(roomClass) || (roomField !== '$partitionKey' && !rawFields.includes(roomField))) {
            return { message: `Operation "${name}" realtime room routing is invalid.` }
          }
          realtime = { roomClass, roomField }
        } else if (emit.realtime !== undefined) {
          return { message: `Operation "${name}" realtime routing is allowed only for realtime emits.` }
        }

        let reporting: NonNullable<NonNullable<typeof emits>[number]['reporting']> | undefined
        if (target === 'reporting') {
          if (!emit.reporting || typeof emit.reporting !== 'object' || Array.isArray(emit.reporting)) return { message: `Operation "${name}" reporting projection is required.` }
          const projection = emit.reporting as Record<string, unknown>
          const keyField = typeof projection.keyField === 'string' ? projection.keyField : ''
          const sequenceField = typeof projection.sequenceField === 'string' ? projection.sequenceField : undefined
          const dimensions = projection.dimensions
          const measures = projection.measures
          if (
            (keyField !== '$partitionKey' && !rawFields.includes(keyField)) ||
            (sequenceField !== undefined && (!rawFields.includes(sequenceField) || fields[sequenceField]?.type !== 'integer')) ||
            !Array.isArray(dimensions) ||
            dimensions.length > 8 ||
            dimensions.some((field) => typeof field !== 'string' || !rawFields.includes(field)) ||
            !Array.isArray(measures) ||
            measures.length < 1 ||
            measures.length > 8
          ) return { message: `Operation "${name}" reporting projection is invalid.` }
          const normalizedMeasures: Array<{ field: string; aggregate: 'sum' }> = []
          for (const rawMeasure of measures) {
            if (!rawMeasure || typeof rawMeasure !== 'object' || Array.isArray(rawMeasure)) return { message: `Operation "${name}" reporting measure is invalid.` }
            const measure = rawMeasure as Record<string, unknown>
            const field = typeof measure.field === 'string' ? measure.field : ''
            if (!rawFields.includes(field) || !['integer', 'number'].includes(fields[field]?.type) || measure.aggregate !== 'sum') {
              return { message: `Operation "${name}" reporting measure is invalid.` }
            }
            normalizedMeasures.push({ field, aggregate: 'sum' })
          }
          reporting = {
            keyField,
            ...(sequenceField === undefined ? {} : { sequenceField }),
            dimensions: [...dimensions] as string[],
            measures: normalizedMeasures,
          }
        } else if (emit.reporting !== undefined) {
          return { message: `Operation "${name}" reporting metadata is allowed only for reporting emits.` }
        }

        emits.push({
          event,
          target: target as 'realtime' | 'reporting' | 'archive',
          durability: durability as 'segmented' | 'immediate',
          fields: [...rawFields] as string[],
          ...(realtime ? { realtime } : {}),
          ...(reporting ? { reporting } : {}),
        })
      }
    }
    if (new TextEncoder().encode(raw.sql).byteLength > 64 * 1024) return { message: `Operation "${name}" SQL is too large.` }
    const sql = raw.sql.replace(/\r\n/g, '\n').trim() + '\n'
    const statement = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()
    if (!statement.endsWith(';') || statement.split(';').map((part) => part.trim()).filter(Boolean).length !== 1) return { message: `Operation "${name}" must contain exactly one terminated SQL statement.` }
    if (kind === 'query' && !/^SELECT\b/i.test(statement)) return { message: `Query operation "${name}" must be read-only.` }
    if (kind === 'command' && !/^(INSERT\s+INTO|UPDATE\s+[a-zA-Z_][a-zA-Z0-9_]*|DELETE\s+FROM)\b/i.test(statement)) return { message: `Command operation "${name}" SQL is unsupported.` }
    if (/^(UPDATE|DELETE\s+FROM)\b/i.test(statement) && !/\bWHERE\b/i.test(statement)) return { message: `Operation "${name}" contains an unbounded write.` }
    if (/\b(?:_lacify_[a-zA-Z0-9_]*|sqlite_[a-zA-Z0-9_]*)\b/i.test(statement)) return { message: `Operation "${name}" cannot access internal tables.` }
    if (/[?@$][a-zA-Z0-9_]*|\?(?:\d+)?/.test(statement)) return { message: `Operation "${name}" must use named colon parameters only.` }
    const referenced = new Set([...statement.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]))
    if (!referenced.has('partitionId')) return { message: `Operation "${name}" must bind :partitionId.` }
    for (const parameter of referenced) if (!Object.hasOwn(input, parameter) && !runtimeParameters.has(parameter)) return { message: `Operation "${name}" references an undeclared parameter.` }
    for (const parameter of Object.keys(input)) if (!referenced.has(parameter)) return { message: `Operation "${name}" declares an unused input.` }
    if (result.pagination && (!referenced.has('cursor') || !referenced.has('pageSize') || !new RegExp(`\\bORDER\\s+BY\\s+${result.pagination.cursorField}\\b`, 'i').test(statement))) return { message: `Operation "${name}" pagination SQL is invalid.` }
    names.push(name)
    operations.push({
      definition: {
        version: 'lacify.dev/operation/v1',
        name,
        kind,
        sql: definition.sql,
        input,
        result,
        ...(emits.length ? { emits } : {}),
      },
      sql,
    })
  }
  if (duplicate(names)) return { message: 'Operation names must be unique.' }
  return { operations: operations.sort((left, right) => left.definition.name.localeCompare(right.definition.name)) }
}

export function validateContract(value: unknown): { document?: ContractDocument; message?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { message: 'Contract must be an object.' }
  const raw = value as Partial<ContractDocument>
  if (!resourceId.test(raw.id || '')) return { message: 'Contract ID is invalid.' }
  if (typeof raw.name !== 'string' || !raw.name.trim()) return { message: 'Contract name is required.' }
  if (!identifier.test(raw.aggregateType || '') || !identifier.test(raw.key || '')) return { message: 'Aggregate type and partition key must be valid identifiers.' }
  if (!Array.isArray(raw.objects) || !raw.objects.length) return { message: 'A contract needs at least one business object.' }
  const objects = raw.objects.map((object) => ({ name: typeof object?.name === 'string' ? object.name.trim() : '', fields: typeof object?.fields === 'string' ? object.fields.trim() : 'id' }))
  const objectNames = objects.map((object) => object.name)
  if (objectNames.some((name) => !identifier.test(name)) || duplicate(objectNames)) return { message: 'Business object names must be unique valid identifiers.' }
  if (!Array.isArray(raw.actions) || !raw.actions.length || raw.actions.some((action) => typeof action !== 'string' || !identifier.test(action)) || duplicate(raw.actions)) return { message: 'Commands must be unique valid identifiers.' }
  if (!Array.isArray(raw.states)) return { message: 'State machines must be an array.' }
  const states = raw.states.map((state) => ({ obj: typeof state?.obj === 'string' ? state.obj : '', flow: Array.isArray(state?.flow) ? state.flow : [] }))
  if (duplicate(states.map((state) => state.obj))) return { message: 'Each object can have only one state machine.' }
  for (const state of states) {
    if (!objectNames.includes(state.obj) || state.flow.length < 2 || state.flow.some((name) => typeof name !== 'string' || !identifier.test(name)) || duplicate(state.flow)) return { message: `State machine "${state.obj}" is invalid.` }
  }
  const metadata = value as { size?: unknown; queries?: unknown; status?: unknown }
  const migrationInput = (value as { migrations?: unknown }).migrations
  if (migrationInput !== undefined && (!Array.isArray(migrationInput) || migrationInput.length > 128)) return { message: 'Migrations must be an array with at most 128 entries.' }
  const migrations = (Array.isArray(migrationInput) ? migrationInput : []).map((entry) => {
    const migration = entry as { id?: unknown; sql?: unknown }
    return { id: typeof migration?.id === 'string' ? migration.id : '', sql: typeof migration?.sql === 'string' ? migration.sql : '' }
  })
  if (duplicate(migrations.map((migration) => migration.id))) return { message: 'Migration IDs must be unique.' }
  for (const migration of migrations) {
    if (!/^\d{4}_[a-z0-9][a-z0-9_]{0,62}$/.test(migration.id) || !migration.sql || new TextEncoder().encode(migration.sql).byteLength > 1024 * 1024) return { message: 'Migration ID or SQL size is invalid.' }
    if (/\b(PRAGMA|ATTACH|DETACH|VACUUM|DROP|TRUNCATE|REINDEX|CREATE\s+TRIGGER|CREATE\s+VIRTUAL\s+TABLE)\b/i.test(migration.sql)) return { message: `Migration ${migration.id} contains unsupported SQL.` }
    const statements = migration.sql
      .split(';')
      .map((statement) => statement.replace(/^\s*(?:(?:--[^\n]*\n)|(?:\/\*[\s\S]*?\*\/))*/g, '').trim())
      .filter(Boolean)
    if (statements.some((statement) => !/^(CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE\s+[a-zA-Z_][a-zA-Z0-9_]*\s+ADD\s+COLUMN|INSERT\s+INTO|UPDATE\s+[a-zA-Z_][a-zA-Z0-9_]*)\b/i.test(statement))) return { message: `Migration ${migration.id} contains an unsupported statement.` }
    if (statements.some((statement) => /^UPDATE\b/i.test(statement) && !/\bWHERE\b/i.test(statement))) return { message: `Migration ${migration.id} contains an unbounded UPDATE.` }
  }
  const operationValidation = validateContractOperations((value as { operations?: unknown }).operations, raw.actions)
  if (!operationValidation.operations) return { message: operationValidation.message }
  return {
    document: {
      id: raw.id,
      name: raw.name.trim(),
      aggregateType: raw.aggregateType,
      key: raw.key,
      objects,
      actions: raw.actions,
      states,
      migrations,
      operations: operationValidation.operations,
      size: typeof metadata.size === 'string' ? metadata.size : '—',
      queries: Number.isFinite(Number(metadata.queries)) ? Number(metadata.queries) : 0,
      status: metadata.status === 'active' || metadata.status === 'dormant' || metadata.status === 'error' ? metadata.status : 'dormant',
    },
  }
}

function validateBlueprint(value: unknown): { blueprint?: WebAppBlueprint; message?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { message: 'Web app blueprint must be an object.' }
  const raw = value as Partial<WebAppBlueprint>
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const aggregates = Array.isArray(raw.aggregates) ? raw.aggregates : []
  if (!name || name.length > 80) return { message: 'Web app name is required and must be 80 characters or fewer.' }
  if (!aggregates.length || aggregates.some((aggregate) => typeof aggregate !== 'string' || !resourceId.test(aggregate)) || duplicate(aggregates)) return { message: 'Select one or more unique aggregate IDs for the web app.' }
  return { blueprint: { name, aggregates: [...aggregates].sort() } }
}

async function audit(env: Env, workspaceId: string, session: Session, action: string, targetType: string, targetId: string, projectId?: string, metadata?: Record<string, unknown>) {
  await env.DB.prepare('INSERT INTO audit_events (id, workspace_id, project_id, actor_account_id, action, target_type, target_id, metadata, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id('audit'), workspaceId, projectId ?? null, session.user_id || session.account_id, action, targetType, targetId, metadata ? JSON.stringify(metadata) : null, now()).run()
}

async function ownedProject(env: Env, workspaceId: string, projectId: string) {
  return env.DB.prepare('SELECT id, name, updated_at, authoring_source, source_fingerprint, source_revision FROM projects WHERE id = ? AND workspace_id = ?').bind(projectId, workspaceId).first<{ id: string; name: string; updated_at: number; authoring_source: 'visual' | 'repository'; source_fingerprint: string | null; source_revision: string | null }>()
}

type WorkspaceRole = 'owner' | 'admin' | 'developer' | 'operator' | 'viewer'
type Capability =
  | 'workspace.read' | 'workspace.settings' | 'members.manage' | 'build.manage' | 'release.manage'
  | 'deploy.dev' | 'deploy.staging' | 'production.approve' | 'deploy.production'
  | 'incidents.manage' | 'telemetry.export' | 'backup.manage' | 'readiness.manage'

async function membershipFor(env: Env, workspaceId: string, session: Session) {
  if (!session.user_id) {
    const legacyOwner = await env.DB.prepare('SELECT owner_account_id FROM workspaces WHERE id = ?').bind(workspaceId).first<{ owner_account_id: string }>()
    return legacyOwner?.owner_account_id === session.account_id ? { role: 'owner' as WorkspaceRole } : null
  }
  return env.DB.prepare('SELECT role FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?')
    .bind(workspaceId, session.user_id)
    .first<{ role: WorkspaceRole }>()
}

async function hasCapability(env: Env, workspaceId: string, session: Session, capability: Capability) {
  const membership = await membershipFor(env, workspaceId, session)
  if (!membership) return false
  const allowed = await env.DB.prepare('SELECT allowed FROM role_capabilities WHERE role = ? AND capability = ?')
    .bind(membership.role, capability)
    .first<{ allowed: number }>()
  return allowed?.allowed === 1
}

function routeCapability(request: Request, url: URL): Capability {
  if (request.method === 'GET') return 'workspace.read'
  if (url.pathname.includes('/invitations') || url.pathname.includes('/members')) return 'members.manage'
  if (url.pathname.includes('/environment') || url.pathname.includes('/governance')) return 'workspace.settings'
  if (url.pathname.includes('/incidents/')) return 'incidents.manage'
  if (url.pathname.includes('/telemetry-export')) return 'telemetry.export'
  if (url.pathname.includes('/backups') || url.pathname.includes('/restore')) return 'backup.manage'
  if (url.pathname.includes('/readiness') || url.pathname.includes('/service-objectives')) return 'readiness.manage'
  if (url.pathname.includes('/releases')) return 'release.manage'
  return 'build.manage'
}

async function sensitiveActionAllowed(env: Env, workspaceId: string, session: Session, action: string, limit = 20) {
  if (!session.user_id) return true
  const platform = env.SENSITIVE_RATE_LIMITER
    ? await env.SENSITIVE_RATE_LIMITER.limit({ key: `${workspaceId}:${session.user_id}:${action}` })
    : { success: true }
  if (!platform.success) return false
  const windowStartedAt = Math.floor(now() / 60_000) * 60_000
  await env.DB.prepare(`INSERT INTO sensitive_action_usage (workspace_id, user_id, action, window_started_at, request_count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(workspace_id, user_id, action, window_started_at)
    DO UPDATE SET request_count = request_count + 1`)
    .bind(workspaceId, session.user_id, action, windowStartedAt)
    .run()
  const usage = await env.DB.prepare('SELECT request_count FROM sensitive_action_usage WHERE workspace_id = ? AND user_id = ? AND action = ? AND window_started_at = ?')
    .bind(workspaceId, session.user_id, action, windowStartedAt)
    .first<{ request_count: number }>()
  return Number(usage?.request_count || 0) <= limit
}

function safeVariables(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 100) return null
  const output: Record<string, string> = {}
  for (const [key, entry] of entries) {
    if (!/^[A-Z][A-Z0-9_]{0,62}$/.test(key) || typeof entry !== 'string' || entry.length > 2_000) return null
    output[key] = entry
  }
  return output
}

function validEnvironment(value: string): value is DeploymentEnvironment {
  return value === 'dev' || value === 'staging' || value === 'production'
}

type DeploymentStatus = 'planned' | 'provisioning' | 'deploying' | 'succeeded' | 'failed' | 'rolled_back'
type DeploymentEnvironment = 'dev' | 'staging' | 'production'
const retryableDeploymentStatuses: DeploymentStatus[] = ['planned', 'failed', 'rolled_back']
const activeDeploymentStatuses: DeploymentStatus[] = ['provisioning', 'deploying']

function deploymentLog(event: string, message: string, timestamp = now()) {
  return { event, message, at: timestamp }
}

interface HealthDeployment {
  id: string
  workspace_id: string
  project_id: string
  release_id: string
  environment: DeploymentEnvironment
  runtime_url: string
  updated_at: number
}

interface RuntimeHealthLayer {
  layer?: unknown
  aggregateType?: unknown
  ok?: unknown
  durationMs?: unknown
  storageBytes?: unknown
  tables?: unknown
}

interface RuntimeHealthSample {
  layer: 'worker' | 'durable_object' | 'sqlite'
  aggregateType: string | null
  status: 'healthy' | 'unhealthy'
  latencyMs: number
  statusCode: number | null
  message: string
}

const healthSampleIntervalMs = 4 * 60 * 1000
const healthStaleAfterMs = 10 * 60 * 1000

async function persistRuntimeHealth(env: Env, deployment: HealthDeployment) {
  const recent = await env.DB.prepare('SELECT checked_at, status FROM runtime_health_samples WHERE deployment_id = ? ORDER BY checked_at DESC LIMIT 1').bind(deployment.id).first<{ checked_at: number; status: string }>()
  if (recent && recent.status === 'healthy' && recent.checked_at > now() - healthSampleIntervalMs) return
  // Scheduled monitoring must remain worker-only. Deep health wakes every
  // aggregate Durable Object and consumes account-wide DO/SQLite quotas, so it
  // is reserved for explicit deployment, readiness, and rollback checks.
  const endpoint = `${deployment.runtime_url}/health`
  const checkedAt = now()
  const startedAt = performance.now()
  let response: Response | null = null
  let payload: { layers?: RuntimeHealthLayer[]; deploymentId?: unknown; releaseId?: unknown } | null = null
  try {
    response = await fetch(endpoint, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) })
    payload = await response.json<{ layers?: RuntimeHealthLayer[]; deploymentId?: unknown; releaseId?: unknown }>().catch(() => null)
  } catch {
    response = null
  }
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt))
  const identityMatches = !payload?.deploymentId || (payload.deploymentId === deployment.id && payload.releaseId === deployment.release_id)
  const reportedLayers = Array.isArray(payload?.layers) ? payload.layers.filter((layer) => layer?.layer === 'worker' || layer?.layer === 'durable_object' || layer?.layer === 'sqlite') : []
  const layers = reportedLayers.length ? reportedLayers : [{ layer: 'worker', ok: Boolean(response?.ok), durationMs: latencyMs }]
  const samples: RuntimeHealthSample[] = layers.map((layer) => {
    const layerName = layer.layer as 'worker' | 'durable_object' | 'sqlite'
    const aggregateType = typeof layer.aggregateType === 'string' ? layer.aggregateType : null
    const healthy = response?.ok === true && identityMatches && layer.ok === true
    const layerLatency = Number.isSafeInteger(layer.durationMs) && Number(layer.durationMs) >= 0 ? Number(layer.durationMs) : latencyMs
    const message = healthy ? `${layerName.replace('_', ' ')} health check passed.` : !response ? 'Health endpoint was unreachable.' : !identityMatches ? 'Runtime identity did not match its deployment.' : `${layerName.replace('_', ' ')} health check failed.`
    return { layer: layerName, aggregateType, status: healthy ? 'healthy' : 'unhealthy', latencyMs: layerLatency, statusCode: response?.status ?? null, message }
  })
  const statements = samples.map((sample) => env.DB.prepare(`INSERT INTO runtime_health_samples
      (id, workspace_id, project_id, release_id, deployment_id, environment, layer, aggregate_type, status, latency_ms, status_code, endpoint, message, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id('health'), deployment.workspace_id, deployment.project_id, deployment.release_id, deployment.id, deployment.environment, sample.layer, sample.aggregateType, sample.status, sample.latencyMs, sample.statusCode, endpoint, sample.message, checkedAt))
  const latest = samples.find((sample) => sample.status === 'unhealthy') || samples[0]
  if (latest) statements.push(env.DB.prepare(`INSERT INTO runtime_health_latest
      (deployment_id, workspace_id, project_id, release_id, environment, layer, aggregate_type, status, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deployment_id) DO UPDATE SET
        workspace_id=excluded.workspace_id, project_id=excluded.project_id,
        release_id=excluded.release_id, environment=excluded.environment,
        layer=excluded.layer, aggregate_type=excluded.aggregate_type,
        status=excluded.status, checked_at=excluded.checked_at
      WHERE excluded.checked_at >= runtime_health_latest.checked_at`)
      .bind(deployment.id, deployment.workspace_id, deployment.project_id, deployment.release_id, deployment.environment, latest.layer, latest.aggregateType, latest.status, checkedAt))
  if (statements.length) await env.DB.batch(statements)
}

async function sampleRuntimeHealth(env: Env, projectId?: string) {
  const query = `SELECT dj.id, dj.workspace_id, dj.project_id, dj.release_id, dj.environment, dj.runtime_url, dj.updated_at
    FROM deployment_jobs dj
    WHERE dj.status = 'succeeded' AND dj.runtime_url IS NOT NULL ${projectId ? 'AND dj.project_id = ?' : ''}
    ORDER BY dj.updated_at DESC`
  const result = projectId
    ? await env.DB.prepare(query).bind(projectId).all<HealthDeployment>()
    : await env.DB.prepare(query).all<HealthDeployment>()
  const latest = new Map<string, HealthDeployment>()
  for (const deployment of result.results) {
    const key = `${deployment.project_id}:${deployment.environment}`
    if (!latest.has(key)) latest.set(key, deployment)
  }
  await Promise.allSettled([...latest.values()].map((deployment) => persistRuntimeHealth(env, deployment)))
}

async function ensureObservabilityDefaults(env: Env, workspaceId: string, projectId: string) {
  const timestamp = now()
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO observability_policies (workspace_id, updated_at) VALUES (?, ?)').bind(workspaceId, timestamp),
    ...[
      ['health_failure', 'critical', 1, 5], ['error_rate', 'warning', 0.05, 15], ['latency', 'warning', 1000, 15],
      ['missing_telemetry', 'warning', 10, 10], ['storage_growth', 'warning', 1073741824, 60],
    ].map(([kind, severity, threshold, window]) => env.DB.prepare(`INSERT OR IGNORE INTO alert_rules
      (id, workspace_id, project_id, kind, severity, threshold, window_minutes, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .bind(`rule_${projectId}_${kind}`, workspaceId, projectId, kind, severity, threshold, window, timestamp, timestamp)),
  ])
}

async function refreshCostEstimate(env: Env, workspaceId: string, projectId: string) {
  const periodEnd = now()
  const periodStart = monthBucketStart(periodEnd)
  const pricing = await env.DB.prepare('SELECT id, prices FROM pricing_versions WHERE effective_at <= ? ORDER BY effective_at DESC LIMIT 1').bind(periodEnd).first<{ id: string; prices: string }>()
  if (!pricing) return
  const prices = JSON.parse(pricing.prices) as Record<string, number>
  const usage = await env.DB.prepare(`SELECT environment, requests, sqlite_reads, sqlite_writes
    FROM runtime_usage_monthly
    WHERE workspace_id = ? AND project_id = ? AND period_start = ?`).bind(workspaceId, projectId, periodStart).all<{ environment: string; requests: number; sqlite_reads: number; sqlite_writes: number }>()
  for (const row of usage.results) {
    const storage = await env.DB.prepare('SELECT SUM(storage_bytes) AS bytes FROM aggregate_storage_latest WHERE workspace_id = ? AND project_id = ? AND environment = ?').bind(workspaceId, projectId, row.environment).first<{ bytes: number | null }>()
    const requests = Number(row.requests || 0); const reads = Number(row.sqlite_reads || 0); const writes = Number(row.sqlite_writes || 0); const storageGb = Number(storage?.bytes || 0) / 1_073_741_824
    const costs = { workerRequestsUsd: requests / 1_000_000 * prices.workerRequestsPerMillion, durableObjectRequestsUsd: requests / 1_000_000 * prices.doRequestsPerMillion, sqliteReadsUsd: reads / 1_000_000 * prices.sqliteReadsPerMillion, sqliteWritesUsd: writes / 1_000_000 * prices.sqliteWritesPerMillion, sqliteStorageUsd: storageGb * prices.sqliteStorageGbMonth }
    const totalUsd = Object.values(costs).reduce((sum, value) => sum + value, 0)
    await env.DB.prepare(`INSERT INTO usage_cost_estimates (id, workspace_id, project_id, environment, pricing_version_id, period_start, period_end, observed_usage, estimated_cost, caveats, calculated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET period_end=excluded.period_end, observed_usage=excluded.observed_usage, estimated_cost=excluded.estimated_cost, caveats=excluded.caveats, calculated_at=excluded.calculated_at`)
      .bind(`cost_${projectId}_${row.environment}_${periodStart}`, workspaceId, projectId, row.environment, pricing.id, periodStart, periodEnd, JSON.stringify({ requests, sqliteReads: reads, sqliteWrites: writes, storageBytes: Number(storage?.bytes || 0) }), JSON.stringify({ ...costs, totalUsd }), JSON.stringify(['Gross list-rate estimate before account-level included usage.', 'CPU and Durable Object active-duration costs are unavailable and excluded.']), periodEnd).run()
  }
}

async function evaluateAlerts(env: Env) {
  const projects = await env.DB.prepare('SELECT id, workspace_id FROM projects').all<{ id: string; workspace_id: string }>()
  for (const project of projects.results) {
    await ensureObservabilityDefaults(env, project.workspace_id, project.id)
    await refreshCostEstimate(env, project.workspace_id, project.id)
    const rules = await env.DB.prepare('SELECT id, kind, severity, threshold, window_minutes FROM alert_rules WHERE project_id = ? AND enabled = 1').bind(project.id).all<{ id: string; kind: string; severity: string; threshold: number; window_minutes: number }>()
    for (const rule of rules.results) {
      const since = now() - rule.window_minutes * 60_000
      let triggered = false; let summary = ''
      if (rule.kind === 'health_failure') {
        const failed = await env.DB.prepare(`SELECT layer, aggregate_type, deployment_id, release_id, environment
          FROM runtime_health_latest
          WHERE project_id = ? AND status = 'unhealthy' AND checked_at >= ?
          ORDER BY checked_at DESC LIMIT 1`).bind(project.id, since).first<Record<string, string>>()
        triggered = Boolean(failed); summary = failed ? `${failed.layer} health failed${failed.aggregate_type ? ` for ${failed.aggregate_type}` : ''}.` : ''
      } else if (rule.kind === 'missing_telemetry') {
        const latest = await env.DB.prepare('SELECT MAX(occurred_at) AS latest FROM runtime_telemetry_events WHERE project_id = ?').bind(project.id).first<{ latest: number | null }>()
        triggered = Boolean(latest?.latest && latest.latest < since); summary = 'Runtime telemetry has stopped arriving.'
      } else if (rule.kind === 'storage_growth') {
        const storage = await env.DB.prepare('SELECT storage_bytes, aggregate_type FROM aggregate_storage_latest WHERE project_id = ? ORDER BY checked_at DESC LIMIT 1').bind(project.id).first<{ storage_bytes: number; aggregate_type: string }>()
        triggered = Boolean(storage && storage.storage_bytes >= rule.threshold); summary = storage ? `${storage.aggregate_type} storage reached ${storage.storage_bytes} bytes.` : ''
      } else {
        const metric = await env.DB.prepare('SELECT SUM(request_count) AS requests, SUM(error_count) AS errors, SUM(duration_sum_ms) AS duration FROM runtime_metric_buckets WHERE project_id = ? AND bucket_start >= ?').bind(project.id, metricBucketStart(since)).first<{ requests: number; errors: number; duration: number }>()
        const value = rule.kind === 'error_rate' ? (metric?.requests ? metric.errors / metric.requests : 0) : (metric?.requests ? metric.duration / metric.requests : 0)
        triggered = Number(metric?.requests || 0) >= 20 && value >= rule.threshold; summary = `${rule.kind === 'error_rate' ? 'Error rate' : 'Average latency'} crossed the configured threshold (${value.toFixed(2)}) across ${Number(metric?.requests || 0)} requests.`
      }
      const active = await env.DB.prepare("SELECT id FROM incidents WHERE rule_id = ? AND status IN ('open','acknowledged')").bind(rule.id).first<{ id: string }>()
      if (triggered && !active) {
        const incidentId = id('incident'); const timestamp = now()
        await env.DB.batch([env.DB.prepare(`INSERT INTO incidents (id,workspace_id,project_id,rule_id,status,severity,title,summary,opened_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(incidentId, project.workspace_id, project.id, rule.id, 'open', rule.severity, rule.kind.replace('_',' '), summary, timestamp, timestamp), env.DB.prepare('INSERT INTO incident_events (id,incident_id,event_type,message,occurred_at) VALUES (?,?,?,?,?)').bind(id('incident_event'), incidentId, 'opened', summary, timestamp)])
      } else if (!triggered && active) {
        const timestamp = now(); await env.DB.batch([env.DB.prepare("UPDATE incidents SET status='resolved', resolved_at=?, updated_at=? WHERE id=?").bind(timestamp,timestamp,active.id), env.DB.prepare('INSERT INTO incident_events (id,incident_id,event_type,message,occurred_at) VALUES (?,?,?,?,?)').bind(id('incident_event'),active.id,'auto_resolved','Condition returned to normal.',timestamp)])
      }
    }
  }
}

async function enforceRetention(env: Env) {
  const policies = await env.DB.prepare('SELECT * FROM observability_policies').all<Record<string, number | string>>()
  for (const policy of policies.results) {
    const workspaceId = String(policy.workspace_id); const day = 86_400_000; const timestamp = now()
    const incidentCutoff = timestamp - Number(policy.incident_days) * day
    await env.DB.batch([
      env.DB.prepare('DELETE FROM runtime_telemetry_events WHERE workspace_id = ? AND occurred_at < ?').bind(workspaceId, timestamp - Number(policy.raw_event_days) * day),
      env.DB.prepare('DELETE FROM runtime_health_samples WHERE workspace_id = ? AND checked_at < ?').bind(workspaceId, timestamp - Number(policy.health_sample_days) * day),
      env.DB.prepare('DELETE FROM aggregate_storage_samples WHERE workspace_id = ? AND checked_at < ?').bind(workspaceId, timestamp - Number(policy.health_sample_days) * day),
      env.DB.prepare('DELETE FROM runtime_partition_activity WHERE workspace_id = ? AND last_seen_at < ?').bind(workspaceId, timestamp - 7 * day),
      env.DB.prepare('DELETE FROM runtime_metric_buckets WHERE workspace_id = ? AND bucket_start < ?').bind(workspaceId, timestamp - Number(policy.metric_bucket_days) * day),
      env.DB.prepare("DELETE FROM incident_events WHERE incident_id IN (SELECT id FROM incidents WHERE workspace_id = ? AND status = 'resolved' AND resolved_at < ?)").bind(workspaceId, incidentCutoff),
      env.DB.prepare("DELETE FROM incidents WHERE workspace_id = ? AND status = 'resolved' AND resolved_at < ?").bind(workspaceId, incidentCutoff),
      env.DB.prepare('DELETE FROM usage_cost_estimates WHERE workspace_id = ? AND period_end < ?').bind(workspaceId, timestamp - Number(policy.metric_bucket_days) * day),
    ])
  }

  const timestamp = now(); const day = 86_400_000
  await env.DB.batch([
    env.DB.prepare('DELETE FROM runtime_event_batches WHERE received_at < ? AND NOT EXISTS (SELECT 1 FROM runtime_telemetry_events event WHERE event.batch_id = runtime_event_batches.id)').bind(timestamp - 7 * day),
    env.DB.prepare('DELETE FROM telemetry_daily_usage WHERE updated_at < ?').bind(timestamp - 395 * day),
    env.DB.prepare('DELETE FROM cli_device_authorizations WHERE expires_at < ?').bind(timestamp - 7 * day),
    env.DB.prepare('DELETE FROM authentication_rate_limits WHERE last_failure_at < ?').bind(timestamp - day),
    env.DB.prepare('DELETE FROM sensitive_action_usage WHERE window_started_at < ?').bind(timestamp - day),
    env.DB.prepare('DELETE FROM application_sessions WHERE expires_at < ?').bind(timestamp - 7 * day),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(timestamp - 7 * day),
    env.DB.prepare('DELETE FROM cli_access_tokens WHERE expires_at < ?').bind(timestamp - 7 * day),
  ])
}

async function cloudflareErrorMessage(response: Response) {
  const payload = await response.clone().json<{ errors?: Array<{ message?: string }> }>().catch(() => null)
  const detail = payload?.errors?.map((error) => error.message).filter(Boolean).join('; ')
  return detail ? `Cloudflare rejected the request (${response.status}): ${detail}` : `Cloudflare request failed (${response.status}). Check the deployment artifact and required Uplink permissions.`
}

async function verifyCloudflareCredentials(accountId: string, apiToken: string) {
  const tokenCheck = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { authorization: `Bearer ${apiToken}` } })
  const tokenResult = await tokenCheck.json<{ success?: boolean }>().catch(() => null)
  if (!tokenCheck.ok || !tokenResult?.success) return { status: 401, message: 'The API token could not be verified.' }
  const accountCheck = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`, { headers: { authorization: `Bearer ${apiToken}` } })
  const accountResult = await accountCheck.json<{ success?: boolean; result?: { id?: string; name?: string } }>().catch(() => null)
  if (!accountCheck.ok || !accountResult?.success || !accountResult.result?.id || !accountResult.result.name) return { status: 403, message: 'The account could not be accessed with this token.' }
  return { status: 200, accountId: accountResult.result.id, accountName: accountResult.result.name }
}

async function migrateLegacyApplicationSession(request: Request, env: Env, legacy: Session) {
  const stored = await env.DB.prepare('SELECT token_envelope FROM sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?')
    .bind(legacy.id, now())
    .first<{ token_envelope: string }>()
  if (!stored) return null
  const identity = await ensureApplicationIdentity(request, env, legacy.account_id, legacy.account_name, stored.token_envelope)
  await authenticationEvent(request, env, 'session.migrated', 'success', identity.userId, legacy.account_id)
  return identity
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return withCors(request, new Response(null, { status: 204, headers: { 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, if-match, x-csrf-token, x-lacify-base-fingerprint' } }), env)
    const url = new URL(request.url)
    const respond = (value: unknown, status = 200) => withCors(request, json(value, status), env)
    if (env.CONTROL_RATE_LIMITER && url.pathname.startsWith('/api/') && url.pathname !== '/api/runtime-telemetry/events') {
      const key = `${request.headers.get('cf-connecting-ip') || 'unknown'}:${url.pathname.split('/').slice(0, 4).join('/')}`
      const limited = await env.CONTROL_RATE_LIMITER.limit({ key })
      if (!limited.success) return respond({ success: false, message: 'Request rate limit exceeded.' }, 429)
    }

    if (url.pathname === '/health') {
      try { await env.DB.prepare('SELECT 1').first(); return respond({ ok: true, service: 'lacify-control-plane' }) } catch { return respond({ ok: false, service: 'lacify-control-plane' }, 503) }
    }

    if (url.pathname === '/api/public-status' && request.method === 'GET') {
      const [deployments, samples] = await Promise.all([
        env.DB.prepare("SELECT environment, COUNT(*) AS count FROM deployment_jobs WHERE status = 'succeeded' GROUP BY environment").all(),
        env.DB.prepare(`SELECT sample.status, COUNT(*) AS count
          FROM runtime_health_samples sample
          JOIN deployment_jobs job ON job.id = sample.deployment_id
          WHERE sample.checked_at > ?
            AND job.status = 'succeeded'
            AND job.updated_at = (
              SELECT MAX(current_job.updated_at)
              FROM deployment_jobs current_job
              WHERE current_job.project_id = job.project_id
                AND current_job.environment = job.environment
                AND current_job.status = 'succeeded'
            )
            AND sample.checked_at = (
              SELECT MAX(latest.checked_at)
              FROM runtime_health_samples latest
              WHERE latest.deployment_id = sample.deployment_id
            )
          GROUP BY sample.status`).bind(now() - healthStaleAfterMs).all(),
      ])
      const unhealthy = Number((samples.results as any[]).find((item) => item.status === 'unhealthy')?.count || 0)
      return respond({
        ok: unhealthy === 0,
        service: 'lacify',
        console: 'operational',
        runtimes: unhealthy ? 'degraded' : deployments.results.length ? 'operational' : 'unknown',
        checkedAt: now(),
      }, unhealthy ? 503 : 200)
    }

    if (url.pathname === '/api/cli/device' && request.method === 'POST') {
      const deviceCode = newSessionId()
      const userCode = base64url(crypto.getRandomValues(new Uint8Array(6))).toUpperCase().slice(0, 8)
      const timestamp = now()
      await env.DB.prepare(`INSERT INTO cli_device_authorizations
          (id, device_code_hash, user_code_hash, expires_at, interval_seconds, created_at)
          VALUES (?, ?, ?, ?, 2, ?)`)
        .bind(id('device'), await sha256(deviceCode), await sha256(userCode), timestamp + 10 * 60 * 1000, timestamp)
        .run()
      return respond({
        deviceCode,
        userCode,
        verificationUri: `${env.ALLOWED_ORIGIN || 'https://runtime.getlacify.com'}/device?code=${encodeURIComponent(userCode)}`,
        intervalSeconds: 2,
        expiresAt: timestamp + 10 * 60 * 1000,
      }, 201)
    }

    const cliDevicePollMatch = url.pathname.match(/^\/api\/cli\/device\/([A-Za-z0-9_-]{40,100})$/)
    if (cliDevicePollMatch && request.method === 'GET') {
      const challenge = await env.DB.prepare(`SELECT result_token_envelope, expires_at, approved_at, consumed_at, user_id
          FROM cli_device_authorizations WHERE device_code_hash = ?`)
        .bind(await sha256(cliDevicePollMatch[1]))
        .first<{ result_token_envelope: string | null; expires_at: number; approved_at: number | null; consumed_at: number | null; user_id: string | null }>()
      if (!challenge || challenge.expires_at <= now()) return respond({ message: 'Device authorization expired.' }, 410)
      if (!challenge.approved_at || !challenge.result_token_envelope || !challenge.user_id) return respond({ pending: true }, 202)
      if (challenge.consumed_at) return respond({ message: 'Device authorization was already consumed.' }, 410)
      const user = await env.DB.prepare('SELECT display_name FROM application_users WHERE id = ?').bind(challenge.user_id).first<{ display_name: string }>()
      const accessToken = await decryptedToken(challenge.result_token_envelope, env)
      await env.DB.prepare('UPDATE cli_device_authorizations SET consumed_at = ?, result_token_envelope = NULL WHERE device_code_hash = ? AND consumed_at IS NULL')
        .bind(now(), await sha256(cliDevicePollMatch[1]))
        .run()
      return respond({ account: user?.display_name || challenge.user_id, accessToken, expiresAt: challenge.expires_at + 29 * 24 * 60 * 60 * 1000 })
    }

    if (url.pathname === '/api/auth/cloudflare' && request.method === 'POST') {
      if (!stateChangeAllowed(request, env)) return respond({ success: false, message: 'Origin is not allowed.' }, 403)
      const body = await requestJson<{ accountId?: string; apiToken?: string }>(request)
      const accountId = body?.accountId?.trim() || ''
      const apiToken = body?.apiToken?.trim() || ''
      if (!/^[a-f0-9]{32}$/.test(accountId) || !apiToken) return respond({ success: false, message: 'A valid Account ID and API token are required.' }, 400)
      const rate = await authenticationRateRecord(request, env, accountId)
      if (authenticationBlocked(rate.record, now())) {
        await authenticationEvent(request, env, 'sign_in', 'blocked', null, accountId)
        return respond({ success: false, message: 'Too many authentication failures. Try again later.' }, 429)
      }
      try {
        const verified = await verifyCloudflareCredentials(accountId, apiToken)
        if (!verified.accountId || !verified.accountName) {
          await recordAuthenticationFailure(env, rate.fingerprint, rate.record)
          await authenticationEvent(request, env, 'sign_in', 'failure', null, accountId)
          return respond({ success: false, message: verified.message }, verified.status)
        }
        const identity = await ensureApplicationIdentity(request, env, verified.accountId, verified.accountName, await encryptedTokenEnvelope(apiToken, env))
        await env.DB.prepare('DELETE FROM authentication_rate_limits WHERE fingerprint = ?').bind(rate.fingerprint).run()
        await authenticationEvent(request, env, 'sign_in', 'success', identity.userId, verified.accountId)
        const response = json({
          success: true,
          authenticated: true,
          connected: true,
          user: { id: identity.userId, displayName: verified.accountName, provider: 'cloudflare_account' },
          workspaceId: identity.workspaceId,
          accountName: verified.accountName,
          expiresAt: identity.expiresAt,
        })
        appendApplicationCookies(response, identity.sessionToken, identity.csrfToken, identity.expiresAt)
        response.headers.append('set-cookie', 'lacify_uplink_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0; Priority=High')
        return withCors(request, response, env)
      } catch {
        await recordAuthenticationFailure(env, rate.fingerprint, rate.record)
        await authenticationEvent(request, env, 'sign_in', 'failure', null, accountId)
        return respond({ success: false, message: 'Authentication could not be completed.' }, 502)
      }
    }

    if (url.pathname === '/api/auth/session' && request.method === 'GET') {
      const session = await authorizedSession(request, env)
      if (!session) return respond({ success: false, authenticated: false }, 401)
      if (session.kind === 'legacy') {
        const migrated = await migrateLegacyApplicationSession(request, env, session)
        if (!migrated) return respond({ success: false, authenticated: false }, 401)
        const response = json({
          success: true,
          authenticated: true,
          migrated: true,
          user: { id: migrated.userId, displayName: session.account_name, provider: 'cloudflare_account' },
          workspaceId: migrated.workspaceId,
          expiresAt: migrated.expiresAt,
        })
        appendApplicationCookies(response, migrated.sessionToken, migrated.csrfToken, migrated.expiresAt)
        response.headers.append('set-cookie', 'lacify_uplink_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0; Priority=High')
        return withCors(request, response, env)
      }
      await env.DB.prepare('UPDATE application_sessions SET last_seen_at = ? WHERE id = ?').bind(now(), session.session_public_id).run()
      return respond({
        success: true,
        authenticated: true,
        user: { id: session.user_id, displayName: session.account_name, provider: 'cloudflare_account' },
        workspaceId: session.workspace_id,
        sessionId: session.session_public_id,
        expiresAt: session.expires_at,
        refreshRecommended: session.expires_at <= now() + applicationSessionRefreshWindowMs,
      })
    }

    if (url.pathname === '/api/auth/session/refresh' && request.method === 'POST') {
      const session = await authorizedSession(request, env)
      if (!session || session.kind !== 'application' || !session.user_id || !session.workspace_id) return respond({ success: false, message: 'Authentication is required.' }, 401)
      if (!await csrfStateChangeAllowed(request, env, session)) return respond({ success: false, message: 'CSRF validation failed.' }, 403)
      const sessionToken = newSessionId()
      const csrfToken = newSessionId()
      const expiresAt = now() + applicationSessionLifetimeMs
      await env.DB.prepare('UPDATE application_sessions SET token_hash = ?, csrf_hash = ?, expires_at = ?, last_seen_at = ? WHERE id = ?')
        .bind(await sha256(sessionToken), await sha256(csrfToken), expiresAt, now(), session.session_public_id)
        .run()
      await authenticationEvent(request, env, 'session.refreshed', 'success', session.user_id, session.account_id)
      const response = appendApplicationCookies(json({ success: true, expiresAt }), sessionToken, csrfToken, expiresAt)
      return withCors(request, response, env)
    }

    if (url.pathname === '/api/auth/sessions' && request.method === 'GET') {
      const session = await authorizedSession(request, env)
      if (!session || session.kind !== 'application' || !session.user_id) return respond({ success: false, message: 'Authentication is required.' }, 401)
      const sessions = await env.DB.prepare(`SELECT id, expires_at, created_at, last_seen_at, user_agent_hash, ip_hash,
          CASE WHEN id = ? THEN 1 ELSE 0 END AS current
        FROM application_sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY last_seen_at DESC`)
        .bind(session.session_public_id, session.user_id, now())
        .all()
      return respond({ success: true, sessions: sessions.results })
    }

    const revokeSessionMatch = url.pathname.match(/^\/api\/auth\/sessions\/(appsession_[a-f0-9-]{36})$/)
    if (revokeSessionMatch && request.method === 'DELETE') {
      const session = await authorizedSession(request, env)
      if (!session || session.kind !== 'application' || !session.user_id) return respond({ success: false, message: 'Authentication is required.' }, 401)
      if (!await csrfStateChangeAllowed(request, env, session)) return respond({ success: false, message: 'CSRF validation failed.' }, 403)
      const targetId = revokeSessionMatch[1]
      const result = await env.DB.prepare('UPDATE application_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
        .bind(now(), targetId, session.user_id)
        .run()
      if (!result.meta.changes) return respond({ success: false, message: 'Active session not found.' }, 404)
      await authenticationEvent(request, env, 'session.revoked', 'success', session.user_id, session.account_id)
      const response = json({ success: true, currentSessionRevoked: targetId === session.session_public_id })
      if (targetId === session.session_public_id) clearApplicationCookies(response)
      return withCors(request, response, env)
    }

    if (url.pathname === '/api/auth/sessions/revoke-all' && request.method === 'POST') {
      const session = await authorizedSession(request, env)
      if (!session || session.kind !== 'application' || !session.user_id) return respond({ success: false, message: 'Authentication is required.' }, 401)
      if (!await csrfStateChangeAllowed(request, env, session)) return respond({ success: false, message: 'CSRF validation failed.' }, 403)
      await env.DB.prepare('UPDATE application_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(now(), session.user_id).run()
      await authenticationEvent(request, env, 'session.revoked_all', 'success', session.user_id, session.account_id)
      const response = clearApplicationCookies(json({ success: true }))
      return withCors(request, response, env)
    }

    if (url.pathname === '/api/auth/logout' && request.method === 'DELETE') {
      const session = await authorizedSession(request, env)
      if (session?.kind === 'application' && !await csrfStateChangeAllowed(request, env, session)) return respond({ success: false, message: 'CSRF validation failed.' }, 403)
      if (session?.kind === 'application') {
        await env.DB.prepare('UPDATE application_sessions SET revoked_at = ? WHERE id = ?').bind(now(), session.session_public_id).run()
        await authenticationEvent(request, env, 'sign_out', 'success', session.user_id, session.account_id)
      }
      const response = clearApplicationCookies(json({ success: true }))
      response.headers.append('set-cookie', 'lacify_uplink_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0; Priority=High')
      return withCors(request, response, env)
    }

    if (url.pathname === '/api/uplink-session' && request.method === 'GET') {
      const session = await authorizedSession(request, env)
      if (!session) return respond({ success: false, connected: false }, 401)
      const workspaceId = await workspaceFor(session, env)
      const uplink = await env.DB.prepare('SELECT account_name, expires_at FROM uplink_connections WHERE workspace_id = ? AND revoked_at IS NULL AND expires_at > ?')
        .bind(workspaceId, now())
        .first<{ account_name: string; expires_at: number }>()
      if (!uplink && session.kind === 'legacy') return respond({ success: true, connected: true, accountName: session.account_name, expiresAt: session.expires_at })
      if (!uplink) return respond({ success: true, connected: false })
      return respond({ success: true, connected: true, accountName: uplink.account_name, expiresAt: uplink.expires_at })
    }

    if (url.pathname === '/api/verify-uplink' && request.method === 'POST') {
      const session = await authorizedSession(request, env)
      if (!session) return respond({ success: false, message: 'Sign in before connecting Uplink.' }, 401)
      if (!await csrfStateChangeAllowed(request, env, session)) return respond({ success: false, message: 'CSRF validation failed.' }, 403)
      const body = await requestJson<{ accountId?: string; apiToken?: string }>(request)
      const accountId = body?.accountId?.trim() || ''
      const apiToken = body?.apiToken?.trim() || ''
      if (!/^[a-f0-9]{32}$/.test(accountId) || !apiToken) return respond({ success: false, message: 'A valid Account ID and API token are required.' }, 400)
      if (session.kind === 'application' && accountId !== session.account_id) return respond({ success: false, message: 'Uplink must use the Cloudflare account associated with this application identity.' }, 403)
      try {
        const verified = await verifyCloudflareCredentials(accountId, apiToken)
        if (!verified.accountId || !verified.accountName) return respond({ success: false, message: verified.message }, verified.status)
        const workspaceId = await workspaceFor(session, env)
        const userId = session.user_id || `user_${verified.accountId}`
        const timestamp = now()
        await env.DB.prepare(`INSERT INTO uplink_connections
          (workspace_id, account_id, account_name, token_envelope, connected_by_user_id, expires_at, revoked_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
          ON CONFLICT(workspace_id) DO UPDATE SET account_id = excluded.account_id, account_name = excluded.account_name,
            token_envelope = excluded.token_envelope, connected_by_user_id = excluded.connected_by_user_id,
            expires_at = excluded.expires_at, revoked_at = NULL, updated_at = excluded.updated_at`)
          .bind(workspaceId, verified.accountId, verified.accountName, await encryptedTokenEnvelope(apiToken, env), userId, timestamp + telemetryCredentialLifetimeMs, timestamp, timestamp)
          .run()
        await audit(env, workspaceId, session, 'uplink.connected', 'workspace', workspaceId)
        return respond({ success: true, message: `Linked to account: ${verified.accountName}`, accountName: verified.accountName })
      } catch {
        return respond({ success: false, message: 'The Uplink connection could not be completed.' }, 502)
      }
    }

    if (url.pathname === '/api/uplink-session' && request.method === 'DELETE') {
      const session = await authorizedSession(request, env)
      if (!session) return respond({ success: false, message: 'Authentication is required.' }, 401)
      if (!await csrfStateChangeAllowed(request, env, session)) return respond({ success: false, message: 'CSRF validation failed.' }, 403)
      const workspaceId = await workspaceFor(session, env)
      await env.DB.prepare('UPDATE uplink_connections SET revoked_at = ?, updated_at = ? WHERE workspace_id = ?').bind(now(), now(), workspaceId).run()
      await audit(env, workspaceId, session, 'uplink.disconnected', 'workspace', workspaceId)
      return respond({ success: true })
    }

    if (url.pathname === '/api/invitations/accept' && request.method === 'POST') {
      const session = await authorizedSession(request, env)
      if (!session || !session.user_id) return respond({ success: false, message: 'Sign in before accepting an invitation.' }, 401)
      if (!await csrfStateChangeAllowed(request, env, session)) return respond({ success: false, message: 'CSRF validation failed.' }, 403)
      const body = await requestJson<{ token?: string }>(request)
      const token = body?.token?.trim() || ''
      if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) return respond({ success: false, message: 'Invitation token is invalid.' }, 400)
      const invitation = await env.DB.prepare(`SELECT id, workspace_id, role, target_account_id, expires_at, accepted_at, revoked_at
        FROM workspace_invitations WHERE token_hash = ?`)
        .bind(await sha256(token))
        .first<{ id: string; workspace_id: string; role: WorkspaceRole; target_account_id: string | null; expires_at: number; accepted_at: number | null; revoked_at: number | null }>()
      if (!invitation || invitation.revoked_at || invitation.accepted_at || invitation.expires_at <= now()) return respond({ success: false, message: 'Invitation is expired, revoked, or already used.' }, 410)
      if (invitation.target_account_id && invitation.target_account_id !== session.account_id) return respond({ success: false, message: 'Invitation is assigned to another application identity.' }, 403)
      const timestamp = now()
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO workspace_memberships (workspace_id, user_id, role, invited_by_user_id, created_at, updated_at)
          SELECT workspace_id, ?, role, invited_by_user_id, ?, ? FROM workspace_invitations WHERE id = ?`)
          .bind(session.user_id, timestamp, timestamp, invitation.id),
        env.DB.prepare('UPDATE workspace_invitations SET accepted_at = ?, accepted_by_user_id = ? WHERE id = ?').bind(timestamp, session.user_id, invitation.id),
      ])
      await authenticationEvent(request, env, 'workspace.invitation_accepted', 'success', session.user_id, session.account_id)
      return respond({ success: true, workspaceId: invitation.workspace_id, role: invitation.role })
    }

    if (url.pathname === '/api/runtime-telemetry/events' && request.method === 'POST') {
      const authorization = request.headers.get('authorization') || ''
      const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{40,100})$/)
      if (!match) return respond({ success: false, message: 'Telemetry authentication is required.' }, 401)
      const parsed = await limitedTelemetryJson(request)
      if (!parsed.body) return respond({ success: false, message: parsed.message }, parsed.status || 400)
      const body = parsed.body
      if (body.schemaVersion !== 'lacify-runtime-telemetry/v1') return respond({ success: false, message: 'Telemetry schema version is unsupported.' }, 400)
      if (typeof body.batchId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(body.batchId)) return respond({ success: false, message: 'Telemetry batch ID is invalid.' }, 400)
      if (typeof body.deploymentId !== 'string' || !/^deploy_[a-f0-9]{18}_(dev|staging|production)$/.test(body.deploymentId)) return respond({ success: false, message: 'Telemetry deployment ID is invalid.' }, 400)
      if (typeof body.releaseId !== 'string' || !/^release_[a-f0-9]{24}$/.test(body.releaseId)) return respond({ success: false, message: 'Telemetry release ID is invalid.' }, 400)
      if (body.environment !== 'dev' && body.environment !== 'staging' && body.environment !== 'production') return respond({ success: false, message: 'Telemetry environment is invalid.' }, 400)
      if (!Array.isArray(body.events) || !body.events.length || body.events.length > telemetryMaxEventsPerBatch) return respond({ success: false, message: `Telemetry batches must contain 1–${telemetryMaxEventsPerBatch} events.` }, 400)

      const receivedAt = now()
      const events: ValidatedTelemetryEvent[] = []
      for (const value of body.events) {
        const validated = validateTelemetryEvent(value, receivedAt)
        if (!validated.event) return respond({ success: false, message: validated.message }, 400)
        events.push(validated.event)
      }
      if (new Set(events.map((event) => event.id)).size !== events.length) return respond({ success: false, message: 'Telemetry event IDs must be unique within a batch.' }, 400)

      const credentialHash = await sha256(match[1])
      const credential = await env.DB.prepare(`SELECT tc.id AS credential_id, dj.id AS deployment_id, dj.workspace_id, dj.project_id, dj.release_id, dj.environment
        FROM telemetry_credentials tc JOIN deployment_jobs dj ON dj.id = tc.deployment_id
        WHERE tc.credential_hash = ? AND tc.deployment_id = ? AND tc.revoked_at IS NULL AND tc.expires_at > ?`)
        .bind(credentialHash, body.deploymentId, receivedAt)
        .first<{ credential_id: string; deployment_id: string; workspace_id: string; project_id: string; release_id: string; environment: string }>()
      if (!credential) return respond({ success: false, message: 'Telemetry credential is invalid, expired, or revoked.' }, 401)
      if (credential.release_id !== body.releaseId || credential.environment !== body.environment) return respond({ success: false, message: 'Telemetry identity does not match this deployment.' }, 403)
      const policy = await env.DB.prepare('SELECT daily_event_quota FROM observability_policies WHERE workspace_id = ?').bind(credential.workspace_id).first<{ daily_event_quota: number }>()
      const usageDay = new Date(receivedAt).toISOString().slice(0, 10)
      const usage = await env.DB.prepare('SELECT accepted_events FROM telemetry_daily_usage WHERE workspace_id = ? AND day = ?').bind(credential.workspace_id, usageDay).first<{ accepted_events: number }>()
      if ((usage?.accepted_events || 0) + events.length > (policy?.daily_event_quota || 100_000)) {
        await env.DB.prepare(`INSERT INTO telemetry_daily_usage (workspace_id, day, accepted_events, dropped_events, updated_at) VALUES (?, ?, 0, ?, ?)
          ON CONFLICT(workspace_id, day) DO UPDATE SET dropped_events = dropped_events + excluded.dropped_events, updated_at = excluded.updated_at`).bind(credential.workspace_id, usageDay, events.length, receivedAt).run()
        return respond({ success: false, message: 'Workspace telemetry quota has been reached.' }, 429)
      }

      const replayedBatch = await env.DB.prepare('SELECT id FROM runtime_event_batches WHERE deployment_id = ? AND id = ?').bind(credential.deployment_id, body.batchId).first()
      if (replayedBatch) return respond({ success: false, message: 'Telemetry batch has already been accepted.' }, 409)
      const placeholders = events.map(() => '?').join(', ')
      const replayedEvent = await env.DB.prepare(`SELECT id FROM runtime_telemetry_events WHERE id IN (${placeholders}) LIMIT 1`).bind(...events.map((event) => event.id)).first()
      if (replayedEvent) return respond({ success: false, message: 'One or more telemetry events have already been accepted.' }, 409)

      const partitionActivity = new Map<string, { aggregateType: string; partitionKeyHash: string; requests: number; errors: number; durationMs: number; sqliteReads: number; sqliteWrites: number; lastSeenAt: number }>()
      for (const event of events) {
        const key = `${event.aggregateType}:${event.partitionKeyHash}`
        const summary = partitionActivity.get(key) || { aggregateType: event.aggregateType, partitionKeyHash: event.partitionKeyHash, requests: 0, errors: 0, durationMs: 0, sqliteReads: 0, sqliteWrites: 0, lastSeenAt: 0 }
        summary.requests += 1
        summary.errors += event.outcome === 'success' ? 0 : 1
        summary.durationMs += event.durationMs
        summary.sqliteReads += event.sqliteReads
        summary.sqliteWrites += event.sqliteWrites
        summary.lastSeenAt = Math.max(summary.lastSeenAt, event.occurredAt)
        partitionActivity.set(key, summary)
      }
      const monthlyReads = events.reduce((sum, event) => sum + event.sqliteReads, 0)
      const monthlyWrites = events.reduce((sum, event) => sum + event.sqliteWrites, 0)

      try {
        await env.DB.batch([
          env.DB.prepare('INSERT INTO runtime_event_batches (id, credential_id, deployment_id, event_count, received_at) VALUES (?, ?, ?, ?, ?)').bind(body.batchId, credential.credential_id, credential.deployment_id, events.length, receivedAt),
          env.DB.prepare(`INSERT INTO telemetry_daily_usage (workspace_id, day, accepted_events, dropped_events, updated_at) VALUES (?, ?, ?, 0, ?)
            ON CONFLICT(workspace_id, day) DO UPDATE SET accepted_events = accepted_events + excluded.accepted_events, updated_at = excluded.updated_at`).bind(credential.workspace_id, usageDay, events.length, receivedAt),
          env.DB.prepare(`INSERT INTO runtime_usage_monthly
            (workspace_id, project_id, environment, period_start, requests, sqlite_reads, sqlite_writes, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id, project_id, environment, period_start) DO UPDATE SET
              requests = requests + excluded.requests,
              sqlite_reads = sqlite_reads + excluded.sqlite_reads,
              sqlite_writes = sqlite_writes + excluded.sqlite_writes,
              updated_at = excluded.updated_at`)
            .bind(credential.workspace_id, credential.project_id, credential.environment, monthBucketStart(receivedAt), events.length, monthlyReads, monthlyWrites, receivedAt),
          ...[...partitionActivity.values()].map((summary) => env.DB.prepare(`INSERT INTO runtime_partition_activity
            (workspace_id, project_id, environment, aggregate_type, partition_key_hash, requests, errors, duration_sum_ms, sqlite_reads, sqlite_writes, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(workspace_id, project_id, environment, aggregate_type, partition_key_hash) DO UPDATE SET
              requests = requests + excluded.requests,
              errors = errors + excluded.errors,
              duration_sum_ms = duration_sum_ms + excluded.duration_sum_ms,
              sqlite_reads = sqlite_reads + excluded.sqlite_reads,
              sqlite_writes = sqlite_writes + excluded.sqlite_writes,
              last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`)
            .bind(credential.workspace_id, credential.project_id, credential.environment, summary.aggregateType, summary.partitionKeyHash, summary.requests, summary.errors, summary.durationMs, summary.sqliteReads, summary.sqliteWrites, summary.lastSeenAt)),
          ...events.flatMap((event) => {
            const bucketColumn = `duration_b${durationBucket(event.durationMs)}`
            return [
              env.DB.prepare(`INSERT INTO runtime_telemetry_events
                (id, batch_id, workspace_id, project_id, release_id, deployment_id, environment, aggregate_type, partition_key_hash, action, outcome, level, status_code, duration_ms, message, occurred_at, received_at, sqlite_reads, sqlite_writes, caller_identity_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .bind(event.id, body.batchId, credential.workspace_id, credential.project_id, credential.release_id, credential.deployment_id, credential.environment, event.aggregateType, event.partitionKeyHash, event.action, event.outcome, event.level, event.statusCode, event.durationMs, event.message, event.occurredAt, receivedAt, event.sqliteReads, event.sqliteWrites, event.callerIdentityHash),
              env.DB.prepare(`INSERT INTO runtime_metric_buckets
                (workspace_id, project_id, release_id, deployment_id, environment, aggregate_type, action, bucket_start,
                 request_count, success_count, error_count, duration_sum_ms, duration_min_ms, duration_max_ms, ${bucketColumn}, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 1, ?)
                ON CONFLICT(workspace_id, project_id, release_id, deployment_id, environment, aggregate_type, action, bucket_start) DO UPDATE SET
                  request_count = request_count + 1,
                  success_count = success_count + excluded.success_count,
                  error_count = error_count + excluded.error_count,
                  duration_sum_ms = duration_sum_ms + excluded.duration_sum_ms,
                  duration_min_ms = MIN(duration_min_ms, excluded.duration_min_ms),
                  duration_max_ms = MAX(duration_max_ms, excluded.duration_max_ms),
                  ${bucketColumn} = ${bucketColumn} + 1,
                  updated_at = excluded.updated_at`)
                .bind(credential.workspace_id, credential.project_id, credential.release_id, credential.deployment_id, credential.environment, event.aggregateType, event.action, metricBucketStart(event.occurredAt), event.outcome === 'success' ? 1 : 0, event.outcome === 'success' ? 0 : 1, event.durationMs, event.durationMs, event.durationMs, receivedAt),
              ...(event.storageBytes === null ? [] : [
                env.DB.prepare(`INSERT INTO aggregate_storage_samples
                  (id, workspace_id, project_id, release_id, deployment_id, environment, aggregate_type, storage_bytes, table_stats, checked_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                  .bind(id('storage'), credential.workspace_id, credential.project_id, credential.release_id, credential.deployment_id, credential.environment, event.aggregateType, event.storageBytes, JSON.stringify(event.tableStats), event.occurredAt),
                env.DB.prepare(`INSERT INTO aggregate_storage_latest
                  (workspace_id, project_id, release_id, deployment_id, environment, aggregate_type, storage_bytes, previous_storage_bytes, table_stats, checked_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
                  ON CONFLICT(workspace_id, project_id, environment, aggregate_type) DO UPDATE SET
                    release_id = excluded.release_id,
                    deployment_id = excluded.deployment_id,
                    previous_storage_bytes = aggregate_storage_latest.storage_bytes,
                    storage_bytes = excluded.storage_bytes,
                    table_stats = excluded.table_stats,
                    checked_at = excluded.checked_at
                  WHERE excluded.checked_at >= aggregate_storage_latest.checked_at`)
                  .bind(credential.workspace_id, credential.project_id, credential.release_id, credential.deployment_id, credential.environment, event.aggregateType, event.storageBytes, JSON.stringify(event.tableStats), event.occurredAt),
              ]),
            ]
          }),
        ])
      } catch (error) {
        if (error instanceof Error && /unique|constraint/i.test(error.message)) return respond({ success: false, message: 'Telemetry batch conflicts with previously accepted data.' }, 409)
        return respond({ success: false, message: 'Telemetry could not be stored. Retry the batch later.' }, 503)
      }
      return respond({ success: true, accepted: events.length, receivedAt }, 202)
    }

    if (url.pathname === '/api/cli/device/approve' && request.method === 'POST') {
      const browserSession = await authorizedSession(request, env)
      if (!browserSession || browserSession.kind !== 'application' || !browserSession.user_id || !browserSession.workspace_id) return respond({ success: false, message: 'Sign in in the browser before approving CLI access.' }, 401)
      if (!await csrfStateChangeAllowed(request, env, browserSession)) return respond({ success: false, message: 'CSRF validation failed.' }, 403)
      const body = await requestJson<{ userCode?: string }>(request)
      const userCode = body?.userCode?.trim().toUpperCase() || ''
      if (!/^[A-Z0-9_-]{8}$/.test(userCode)) return respond({ success: false, message: 'Device code is invalid.' }, 400)
      const challenge = await env.DB.prepare(`SELECT id, expires_at, approved_at FROM cli_device_authorizations
          WHERE user_code_hash = ?`).bind(await sha256(userCode)).first<{ id: string; expires_at: number; approved_at: number | null }>()
      if (!challenge || challenge.expires_at <= now()) return respond({ success: false, message: 'Device code is expired or invalid.' }, 410)
      if (challenge.approved_at) return respond({ success: false, message: 'Device code was already approved.' }, 409)
      const accessToken = `lacify_${newSessionId()}`
      const tokenId = id('clitoken')
      const timestamp = now()
      const expiresAt = timestamp + 30 * 24 * 60 * 60 * 1000
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO cli_access_tokens
            (id, token_hash, user_id, workspace_id, expires_at, revoked_at, created_at, last_used_at)
            VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`)
          .bind(tokenId, await sha256(accessToken), browserSession.user_id, browserSession.workspace_id, expiresAt, timestamp, timestamp),
        env.DB.prepare(`UPDATE cli_device_authorizations
            SET approved_at = ?, user_id = ?, workspace_id = ?, result_token_envelope = ?
            WHERE id = ? AND approved_at IS NULL`)
          .bind(timestamp, browserSession.user_id, browserSession.workspace_id, await encryptedTokenEnvelope(accessToken, env), challenge.id),
      ])
      await audit(env, browserSession.workspace_id, browserSession, 'cli.device_authorized', 'cli_access_token', tokenId)
      return respond({ success: true, message: 'CLI access approved. You can return to the terminal.' })
    }

    const session = await authorizedSession(request, env)
    if (!session) return respond({ success: false, message: 'Authentication is required.' }, 401)
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && !await csrfStateChangeAllowed(request, env, session)) return respond({ success: false, message: 'CSRF validation failed.' }, 403)

    if (url.pathname === '/api/workspaces' && request.method === 'GET') {
      if (!session.user_id) return respond({ success: true, workspaces: [{ id: await workspaceFor(session, env), name: session.account_name, role: 'owner', current: true }] })
      const memberships = await env.DB.prepare(`SELECT w.id, w.name, m.role, CASE WHEN w.id = ? THEN 1 ELSE 0 END AS current
        FROM workspace_memberships m JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = ? ORDER BY current DESC, w.name`)
        .bind(session.workspace_id, session.user_id)
        .all()
      return respond({ success: true, workspaces: memberships.results })
    }

    const selectWorkspaceMatch = url.pathname.match(/^\/api\/workspaces\/(workspace_[a-zA-Z0-9_-]+)\/select$/)
    if (selectWorkspaceMatch && request.method === 'POST') {
      if (!session.user_id || session.kind !== 'application') return respond({ success: false, message: 'Application authentication is required.' }, 401)
      const selectedWorkspaceId = selectWorkspaceMatch[1]
      const membership = await membershipFor(env, selectedWorkspaceId, session)
      if (!membership) return respond({ success: false, message: 'Workspace access is not granted.' }, 403)
      await env.DB.prepare('UPDATE application_sessions SET workspace_id = ?, last_seen_at = ? WHERE id = ?').bind(selectedWorkspaceId, now(), session.session_public_id).run()
      await authenticationEvent(request, env, 'workspace.selected', 'success', session.user_id, session.account_id)
      return respond({ success: true, workspaceId: selectedWorkspaceId, role: membership.role })
    }

    const workspaceId = await workspaceFor(session, env)
    const requiredCapability = routeCapability(request, url)
    if (!await hasCapability(env, workspaceId, session, requiredCapability)) return respond({ success: false, message: `Permission required: ${requiredCapability}.` }, 403)

    if (url.pathname === '/api/cli/token' && request.method === 'DELETE') {
      if (session.kind !== 'cli' || !session.session_public_id) return respond({ success: false, message: 'CLI authentication is required.' }, 401)
      await env.DB.prepare('UPDATE cli_access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(now(), session.session_public_id).run()
      await audit(env, workspaceId, session, 'cli.token_revoked', 'cli_access_token', session.session_public_id)
      return respond({ success: true })
    }

    if (url.pathname === '/api/workspace/members' && request.method === 'GET') {
      const members = await env.DB.prepare(`SELECT users.id, users.display_name, users.provider, users.provider_subject, memberships.role,
          memberships.created_at, memberships.updated_at
        FROM workspace_memberships memberships JOIN application_users users ON users.id = memberships.user_id
        WHERE memberships.workspace_id = ? ORDER BY CASE memberships.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'developer' THEN 3 WHEN 'operator' THEN 4 ELSE 5 END, users.display_name`)
        .bind(workspaceId)
        .all()
      return respond({ success: true, members: members.results.map((member) => ({ ...member, provider_subject: undefined, accountIdHint: String(member.provider_subject).slice(0, 6) + '…' })) })
    }

    if (url.pathname === '/api/workspace/invitations' && request.method === 'GET') {
      const invitations = await env.DB.prepare(`SELECT id, role, target_account_id, expires_at, accepted_at, revoked_at, created_at
        FROM workspace_invitations WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100`)
        .bind(workspaceId)
        .all()
      return respond({ success: true, invitations: invitations.results.map((invite) => ({ ...invite, target_account_id: invite.target_account_id ? `${String(invite.target_account_id).slice(0, 6)}…` : null })) })
    }

    if (url.pathname === '/api/workspace/governance') {
      if (request.method === 'GET') {
        const policy = await env.DB.prepare(`SELECT require_separate_verifier, require_separate_approver, require_separate_deployer,
          deployment_window_start_hour, deployment_window_end_hour, updated_at
          FROM production_governance_policies WHERE workspace_id = ?`).bind(workspaceId).first()
        return respond({ success: true, policy: policy || { require_separate_verifier: 0, require_separate_approver: 0, require_separate_deployer: 0, deployment_window_start_hour: null, deployment_window_end_hour: null, updated_at: null } })
      }
      if (request.method === 'PUT' && session.user_id) {
        const body = await requestJson<{ requireSeparateVerifier?: boolean; requireSeparateApprover?: boolean; requireSeparateDeployer?: boolean; deploymentWindowStartHour?: number | null; deploymentWindowEndHour?: number | null }>(request)
        const start = body?.deploymentWindowStartHour
        const end = body?.deploymentWindowEndHour
        const validHour = (value: unknown) => value === null || (Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 23)
        if (!validHour(start) || !validHour(end) || (start === null) !== (end === null)) return respond({ success: false, message: 'Deployment window must provide both UTC hours from 0 through 23, or neither.' }, 400)
        const timestamp = now()
        await env.DB.prepare(`INSERT INTO production_governance_policies
          (workspace_id, require_separate_verifier, require_separate_approver, require_separate_deployer,
           deployment_window_start_hour, deployment_window_end_hour, updated_by_user_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id) DO UPDATE SET require_separate_verifier = excluded.require_separate_verifier,
            require_separate_approver = excluded.require_separate_approver, require_separate_deployer = excluded.require_separate_deployer,
            deployment_window_start_hour = excluded.deployment_window_start_hour, deployment_window_end_hour = excluded.deployment_window_end_hour,
            updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at`)
          .bind(workspaceId, body?.requireSeparateVerifier ? 1 : 0, body?.requireSeparateApprover ? 1 : 0, body?.requireSeparateDeployer ? 1 : 0, start ?? null, end ?? null, session.user_id, timestamp)
          .run()
        const policy = { requireSeparateVerifier: Boolean(body?.requireSeparateVerifier), requireSeparateApprover: Boolean(body?.requireSeparateApprover), requireSeparateDeployer: Boolean(body?.requireSeparateDeployer), deploymentWindowStartHour: start ?? null, deploymentWindowEndHour: end ?? null }
        await audit(env, workspaceId, session, 'production.governance.updated', 'workspace', workspaceId, undefined, policy)
        return respond({ success: true, policy })
      }
    }

    if (url.pathname === '/api/workspace/invitations' && request.method === 'POST') {
      if (!session.user_id || !await sensitiveActionAllowed(env, workspaceId, session, 'invitation.create', 10)) return respond({ success: false, message: 'Invitation rate limit exceeded.' }, 429)
      const body = await requestJson<{ role?: string; targetAccountId?: string }>(request)
      const role = body?.role
      const targetAccountId = body?.targetAccountId?.trim() || null
      if (role !== 'admin' && role !== 'developer' && role !== 'operator' && role !== 'viewer') return respond({ success: false, message: 'Invitation role is invalid.' }, 400)
      if (targetAccountId && !/^[a-f0-9]{32}$/.test(targetAccountId)) return respond({ success: false, message: 'Target Cloudflare Account ID is invalid.' }, 400)
      const token = newSessionId()
      const invitationId = id('invite')
      const timestamp = now()
      const expiresAt = timestamp + 7 * 24 * 60 * 60 * 1000
      await env.DB.prepare(`INSERT INTO workspace_invitations
        (id, workspace_id, token_hash, role, target_account_id, invited_by_user_id, expires_at, accepted_at, accepted_by_user_id, revoked_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`)
        .bind(invitationId, workspaceId, await sha256(token), role, targetAccountId, session.user_id, expiresAt, timestamp)
        .run()
      await audit(env, workspaceId, session, 'workspace.invitation.created', 'invitation', invitationId, undefined, { role, targetAccountId: targetAccountId ? 'restricted' : 'unrestricted', expiresAt })
      return respond({ success: true, invitation: { id: invitationId, role, token, expiresAt } }, 201)
    }

    const invitationActionMatch = url.pathname.match(/^\/api\/workspace\/invitations\/(invite_[a-f0-9-]{36})\/(resend|revoke)$/)
    if (invitationActionMatch && request.method === 'POST') {
      if (!session.user_id || !await sensitiveActionAllowed(env, workspaceId, session, `invitation.${invitationActionMatch[2]}`, 10)) return respond({ success: false, message: 'Invitation rate limit exceeded.' }, 429)
      const [, invitationId, action] = invitationActionMatch
      const invitation = await env.DB.prepare('SELECT id, role, accepted_at, revoked_at FROM workspace_invitations WHERE id = ? AND workspace_id = ?').bind(invitationId, workspaceId).first<{ id: string; role: string; accepted_at: number | null; revoked_at: number | null }>()
      if (!invitation || invitation.accepted_at) return respond({ success: false, message: 'Pending invitation not found.' }, 404)
      if (action === 'revoke') {
        await env.DB.prepare('UPDATE workspace_invitations SET revoked_at = ? WHERE id = ?').bind(now(), invitationId).run()
        await audit(env, workspaceId, session, 'workspace.invitation.revoked', 'invitation', invitationId)
        return respond({ success: true, revoked: true })
      }
      const token = newSessionId()
      const expiresAt = now() + 7 * 24 * 60 * 60 * 1000
      await env.DB.prepare('UPDATE workspace_invitations SET token_hash = ?, expires_at = ?, revoked_at = NULL WHERE id = ?').bind(await sha256(token), expiresAt, invitationId).run()
      await audit(env, workspaceId, session, 'workspace.invitation.resent', 'invitation', invitationId)
      return respond({ success: true, invitation: { id: invitationId, role: invitation.role, token, expiresAt } })
    }

    const memberMatch = url.pathname.match(/^\/api\/workspace\/members\/(user_[a-f0-9]{32})$/)
    if (memberMatch && (request.method === 'PATCH' || request.method === 'DELETE')) {
      if (!session.user_id || !await sensitiveActionAllowed(env, workspaceId, session, 'member.change', 20)) return respond({ success: false, message: 'Member-change rate limit exceeded.' }, 429)
      const targetUserId = memberMatch[1]
      const target = await env.DB.prepare('SELECT role FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, targetUserId).first<{ role: WorkspaceRole }>()
      if (!target) return respond({ success: false, message: 'Workspace member not found.' }, 404)
      const ownerCount = target.role === 'owner'
        ? Number((await env.DB.prepare("SELECT COUNT(*) AS count FROM workspace_memberships WHERE workspace_id = ? AND role = 'owner'").bind(workspaceId).first<{ count: number }>())?.count || 0)
        : 0
      if (target.role === 'owner' && ownerCount <= 1) return respond({ success: false, message: 'The final workspace Owner cannot be removed or demoted.' }, 409)
      if (request.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, targetUserId).run()
        await audit(env, workspaceId, session, 'workspace.member.removed', 'application_user', targetUserId)
        return respond({ success: true })
      }
      const body = await requestJson<{ role?: WorkspaceRole }>(request)
      if (!body?.role || !['owner', 'admin', 'developer', 'operator', 'viewer'].includes(body.role)) return respond({ success: false, message: 'Member role is invalid.' }, 400)
      await env.DB.prepare('UPDATE workspace_memberships SET role = ?, updated_at = ? WHERE workspace_id = ? AND user_id = ?').bind(body.role, now(), workspaceId, targetUserId).run()
      await env.DB.prepare('UPDATE application_sessions SET revoked_at = ? WHERE user_id = ? AND workspace_id = ?').bind(now(), targetUserId, workspaceId).run()
      await audit(env, workspaceId, session, 'workspace.member.role_changed', 'application_user', targetUserId, undefined, { from: target.role, to: body.role })
      return respond({ success: true, role: body.role, sessionsRevoked: true })
    }

    if (url.pathname === '/api/backups' && request.method === 'GET') {
      const backups = await env.DB.prepare('SELECT id, project_id, scope, environment, partition_hash, provider, bookmark, retention_until, schema_version, verification_status, created_at, verified_at FROM backup_records WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100').bind(workspaceId).all()
      const restores = await env.DB.prepare('SELECT id, backup_id, target, status, integrity_result, created_at, updated_at FROM restore_jobs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100').bind(workspaceId).all()
      return respond({ success: true, backups: backups.results, restores: restores.results })
    }

    if (url.pathname === '/api/backups' && request.method === 'POST') {
      if (!session.user_id || !await sensitiveActionAllowed(env, workspaceId, session, 'backup.bookmark', 5)) return respond({ success: false, message: 'Backup action rate limit exceeded.' }, 429)
      if (!env.CONTROL_DB_ID) return respond({ success: false, message: 'Control database recovery identifier is not configured.' }, 503)
      const uplink = await env.DB.prepare('SELECT account_id, token_envelope FROM uplink_connections WHERE workspace_id = ? AND revoked_at IS NULL AND expires_at > ?').bind(workspaceId, now()).first<{ account_id: string; token_envelope: string }>()
      if (!uplink) return respond({ success: false, message: 'Reconnect Uplink before creating a recovery bookmark.' }, 409)
      const token = await decryptedToken(uplink.token_envelope, env)
      const bookmarkResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(uplink.account_id)}/d1/database/${encodeURIComponent(env.CONTROL_DB_ID)}/time_travel/bookmark`, { headers: { authorization: `Bearer ${token}` } })
      const bookmarkPayload = await bookmarkResponse.json<{ success?: boolean; result?: { bookmark?: string } }>().catch(() => null)
      const bookmark = bookmarkPayload?.result?.bookmark
      if (!bookmarkResponse.ok || !bookmarkPayload?.success || !bookmark) return respond({ success: false, message: 'Cloudflare D1 Time Travel bookmark could not be created with the current Uplink permissions.' }, 502)
      const backupId = id('backup')
      const timestamp = now()
      await env.DB.prepare(`INSERT INTO backup_records
        (id, workspace_id, project_id, scope, environment, partition_hash, provider, bookmark, retention_until, schema_version,
         verification_status, created_by_user_id, created_at, verified_at)
        VALUES (?, ?, NULL, 'control_plane', NULL, NULL, 'cloudflare-d1-time-travel', ?, ?, '0013', 'verified', ?, ?, ?)`)
        .bind(backupId, workspaceId, bookmark, timestamp + 30 * 24 * 60 * 60 * 1000, session.user_id, timestamp, timestamp)
        .run()
      await audit(env, workspaceId, session, 'backup.bookmark.created', 'backup', backupId, undefined, { provider: 'cloudflare-d1-time-travel', retentionDays: 30 })
      return respond({ success: true, backup: { id: backupId, provider: 'cloudflare-d1-time-travel', bookmark, verified: true, createdAt: timestamp } }, 201)
    }

    const restoreMatch = url.pathname.match(/^\/api\/backups\/(backup_[a-f0-9-]{36})\/restore$/)
    if (restoreMatch && request.method === 'POST') {
      if (!session.user_id || !await sensitiveActionAllowed(env, workspaceId, session, 'backup.restore.validate', 3)) return respond({ success: false, message: 'Restore-validation rate limit exceeded.' }, 429)
      const body = await requestJson<{ target?: string }>(request)
      const target = body?.target?.trim() || ''
      if (!/^recovery_[a-z0-9-]{3,50}$/.test(target)) return respond({ success: false, message: 'Restore target must be an isolated recovery environment.' }, 400)
      const backup = await env.DB.prepare('SELECT id, bookmark, schema_version, verification_status FROM backup_records WHERE id = ? AND workspace_id = ?').bind(restoreMatch[1], workspaceId).first<{ id: string; bookmark: string; schema_version: string; verification_status: string }>()
      if (!backup || backup.verification_status !== 'verified') return respond({ success: false, message: 'Verified backup record not found.' }, 404)
      const tables = await env.DB.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").first<{ count: number }>()
      const restoreId = id('restore')
      const timestamp = now()
      const integrity = { mode: 'isolated-validation', bookmarkPresent: Boolean(backup.bookmark), schemaVersion: backup.schema_version, controlTables: Number(tables?.count || 0), productionOverwritten: false }
      await env.DB.prepare(`INSERT INTO restore_jobs (id, workspace_id, backup_id, target, status, integrity_result, requested_by_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'succeeded', ?, ?, ?, ?)`)
        .bind(restoreId, workspaceId, backup.id, target, JSON.stringify(integrity), session.user_id, timestamp, timestamp)
        .run()
      await audit(env, workspaceId, session, 'backup.restore.validated', 'restore_job', restoreId, undefined, integrity)
      return respond({ success: true, restore: { id: restoreId, target, status: 'succeeded', integrity } }, 201)
    }

    if (url.pathname === '/api/service-objectives') {
      if (request.method === 'GET') {
        const objectives = await env.DB.prepare('SELECT id, indicator, target, window_days, owner_user_id, enabled, created_at, updated_at FROM service_objectives WHERE workspace_id = ? ORDER BY indicator').bind(workspaceId).all()
        return respond({ success: true, objectives: objectives.results })
      }
      if (request.method === 'PUT' && session.user_id) {
        const body = await requestJson<{ indicator?: string; target?: number; windowDays?: number }>(request)
        const indicator = body?.indicator?.trim() || ''
        const target = Number(body?.target)
        const windowDays = Number(body?.windowDays)
        if (!/^[a-z][a-z0-9_.]{2,62}$/.test(indicator) || !(target > 0 && target <= 100) || !Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 365) return respond({ success: false, message: 'Service objective is invalid.' }, 400)
        const timestamp = now()
        const objectiveId = `slo_${await sha256(`${workspaceId}:${indicator}`)}`.slice(0, 63)
        await env.DB.prepare(`INSERT INTO service_objectives (id, workspace_id, indicator, target, window_days, owner_user_id, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(workspace_id, indicator) DO UPDATE SET target = excluded.target, window_days = excluded.window_days,
            owner_user_id = excluded.owner_user_id, enabled = 1, updated_at = excluded.updated_at`)
          .bind(objectiveId, workspaceId, indicator, target, windowDays, session.user_id, timestamp, timestamp)
          .run()
        await audit(env, workspaceId, session, 'service_objective.updated', 'service_objective', objectiveId)
        return respond({ success: true, objective: { id: objectiveId, indicator, target, windowDays } })
      }
    }

    const supportMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-_]{0,62})\/support-diagnostics$/)
    if (supportMatch && request.method === 'GET') {
      const projectId = supportMatch[1]
      if (!await ownedProject(env, workspaceId, projectId)) return respond({ success: false, message: 'Project not found.' }, 404)
      const [releases, deployments, incidents, configs] = await Promise.all([
        env.DB.prepare('SELECT id, checksum, status, created_at FROM releases WHERE project_id = ? ORDER BY created_at DESC LIMIT 10').bind(projectId).all(),
        env.DB.prepare('SELECT id, release_id, environment, status, runtime_url, updated_at FROM deployment_jobs WHERE project_id = ? ORDER BY updated_at DESC LIMIT 20').bind(projectId).all(),
        env.DB.prepare('SELECT id, severity, status, title, opened_at, resolved_at FROM incidents WHERE project_id = ? ORDER BY opened_at DESC LIMIT 20').bind(projectId).all(),
        env.DB.prepare('SELECT environment, revision, updated_at FROM environment_configuration WHERE project_id = ? ORDER BY environment').bind(projectId).all(),
      ])
      return respond({ success: true, generatedAt: now(), projectId, releases: releases.results, deployments: deployments.results, incidents: incidents.results, configurations: configs.results, redaction: 'Secrets, credentials, command payloads, and business records are excluded.' })
    }

    const readinessReviewMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-_]{0,62})\/readiness-review$/)
    if (readinessReviewMatch && request.method === 'POST') {
      const projectId = readinessReviewMatch[1]
      if (!session.user_id) return respond({ success: false, message: 'Application authentication is required.' }, 401)
      const critical = await env.DB.prepare("SELECT COUNT(*) AS count FROM incidents WHERE project_id = ? AND severity = 'critical' AND status IN ('open','acknowledged')").bind(projectId).first<{ count: number }>()
      const evidence = {
        reviewedAt: now(),
        projectId,
        roleAcceptance: ['owner', 'admin', 'developer', 'operator', 'viewer'],
        runbooks: ['onboarding', 'deployment', 'rollback', 'access', 'backup', 'incident', 'security'],
        productionHealth: await env.DB.prepare("SELECT COUNT(*) AS count FROM deployment_jobs WHERE project_id = ? AND environment = 'production' AND status = 'succeeded'").bind(projectId).first<{ count: number }>(),
      }
      const criticalOpenCount = Number(critical?.count || 0)
      const status = criticalOpenCount ? 'blocked' : 'approved'
      const reviewId = id('readiness')
      await env.DB.prepare(`INSERT INTO readiness_reviews (id, workspace_id, project_id, status, evidence, critical_open_count, reviewed_by_user_id, reviewed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(reviewId, workspaceId, projectId, status, JSON.stringify(evidence), criticalOpenCount, session.user_id, now())
        .run()
      await audit(env, workspaceId, session, `readiness.review.${status}`, 'readiness_review', reviewId, projectId)
      return respond({ success: true, review: { id: reviewId, status, criticalOpenCount, evidence } }, status === 'approved' ? 201 : 409)
    }

    if (url.pathname === '/api/projects' && request.method === 'GET') {
      const projects = await env.DB.prepare('SELECT id, name, authoring_source, source_fingerprint, source_revision, created_at, updated_at FROM projects WHERE workspace_id = ? ORDER BY updated_at DESC').bind(workspaceId).all()
      return respond({ success: true, projects: projects.results })
    }

    const repositorySourceMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-_]{0,62})\/repository-source$/)
    if (repositorySourceMatch && request.method === 'PUT') {
      const projectId = repositorySourceMatch[1]
      const project = await ownedProject(env, workspaceId, projectId)
      if (!project) return respond({ success: false, message: 'Project not found.' }, 404)
      const body = await requestJson<{ fingerprint?: string; baseFingerprint?: string | null; revision?: string }>(request)
      const fingerprint = body?.fingerprint || ''
      const revision = body?.revision || ''
      if (!/^[a-f0-9]{64}$/.test(fingerprint) || !/^revision_[a-f0-9-]{36}$/.test(revision)) return respond({ success: false, message: 'Repository source fingerprint or revision is invalid.' }, 400)
      if (project.source_fingerprint && body?.baseFingerprint !== project.source_fingerprint) {
        return respond({ success: false, message: 'Authoring conflict: the Control Plane source changed after the repository base revision.' }, 409)
      }
      await env.DB.prepare(`UPDATE projects SET authoring_source = 'repository', source_fingerprint = ?, source_revision = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`)
        .bind(fingerprint, revision, now(), projectId, workspaceId)
        .run()
      await audit(env, workspaceId, session, 'project.repository_source.updated', 'project', projectId, projectId, { fingerprint, revision })
      return respond({ success: true, project: { id: projectId, authoringSource: 'repository', sourceFingerprint: fingerprint, sourceRevision: revision } })
    }

    if (url.pathname === '/api/projects' && request.method === 'POST') {
      const body = await requestJson<{ id?: string; name?: string }>(request)
      const projectId = body?.id?.trim().toLowerCase() || ''
      const name = body?.name?.trim() || projectId
      if (!resourceId.test(projectId) || !name) return respond({ success: false, message: 'Project ID or name is invalid.' }, 400)
      const timestamp = now()
      try {
        await env.DB.prepare('INSERT INTO projects (id, name, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(projectId, name, workspaceId, timestamp, timestamp).run()
      } catch {
        return respond({ success: false, message: 'A project with this ID already exists in this workspace.' }, 409)
      }
      await audit(env, workspaceId, session, 'project.created', 'project', projectId, projectId)
      return respond({ success: true, project: { id: projectId, name, createdAt: timestamp } }, 201)
    }

    const runtimeCredentialMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-_]{0,62})\/runtime-credentials(?:\/(credential_[A-Za-z0-9-]+))?$/)
    if (runtimeCredentialMatch) {
      const [, projectId, credentialId] = runtimeCredentialMatch
      const project = await ownedProject(env, workspaceId, projectId)
      if (!project) return respond({ success: false, message: 'Project not found.' }, 404)
      if (!await hasCapability(env, workspaceId, session, 'release.manage')) return respond({ success: false, message: 'Permission required: release.manage.' }, 403)
      if (!credentialId && request.method === 'GET') {
        const credentials = await env.DB.prepare(`SELECT id, environment, name, capabilities, expires_at, revoked_at, created_at
          FROM runtime_application_credentials WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 100`)
          .bind(workspaceId, projectId)
          .all<{ id: string; environment: string; name: string; capabilities: string; expires_at: number; revoked_at: number | null; created_at: number }>()
        return respond({
          success: true,
          credentials: credentials.results.map((credential) => ({
            id: credential.id,
            environment: credential.environment,
            name: credential.name,
            capabilities: JSON.parse(credential.capabilities),
            expiresAt: credential.expires_at,
            revokedAt: credential.revoked_at,
            createdAt: credential.created_at,
          })),
        })
      }
      if (!credentialId && request.method === 'POST') {
        const body = await requestJson<{ name?: string; environment?: string; expiresInDays?: number; capabilities?: unknown }>(request)
        const name = body?.name?.trim() || ''
        const environment = body?.environment || ''
        const expiresInDays = Number(body?.expiresInDays ?? 90)
        if (!/^[A-Za-z][A-Za-z0-9 _.-]{0,79}$/.test(name)) return respond({ success: false, message: 'Credential name is invalid.' }, 400)
        if (!validEnvironment(environment)) return respond({ success: false, message: 'Credential environment is invalid.' }, 400)
        if (!Number.isSafeInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) return respond({ success: false, message: 'Credential lifetime must be between 1 and 365 days.' }, 400)
        const contracts = await env.DB.prepare('SELECT document FROM contracts WHERE project_id = ? ORDER BY id').bind(projectId).all<{ document: string }>()
        const parsedContracts = contracts.results.map((contract) => JSON.parse(contract.document) as RuntimeContract)
        const capabilities = validateRuntimeApplicationCapabilities(body?.capabilities, parsedContracts)
        if (!capabilities) return respond({ success: false, message: 'Credential capabilities must reference declared Actors and operations with bounded rate and payload limits.' }, 400)
        const token = newRuntimeApplicationCredential()
        const createdAt = now()
        const expiresAt = createdAt + expiresInDays * 24 * 60 * 60 * 1000
        const createdId = id('credential')
        try {
          await env.DB.prepare(`INSERT INTO runtime_application_credentials
              (id, workspace_id, project_id, environment, name, token_hash, capabilities, expires_at, revoked_at, created_by_user_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
            .bind(createdId, workspaceId, projectId, environment, name, await sha256(token), JSON.stringify(capabilities), expiresAt, session.user_id || null, createdAt)
            .run()
        } catch {
          return respond({ success: false, message: 'A runtime credential with this name already exists for the environment.' }, 409)
        }
        await audit(env, workspaceId, session, 'runtime.credential.created', 'runtime_application_credential', createdId, projectId, {
          environment,
          actors: capabilities.map((capability) => ({ actor: capability.actor, operations: capability.operations })),
          expiresAt,
        })
        return respond({
          success: true,
          credential: { id: createdId, name, environment, capabilities, expiresAt, token },
          warning: 'Copy this token now. It is returned once and becomes active in the next deployment for this environment.',
        }, 201)
      }
      if (credentialId && request.method === 'DELETE') {
        const result = await env.DB.prepare(`UPDATE runtime_application_credentials SET revoked_at = ?
          WHERE id = ? AND workspace_id = ? AND project_id = ? AND revoked_at IS NULL`)
          .bind(now(), credentialId, workspaceId, projectId)
          .run()
        if (!result.meta.changes) return respond({ success: false, message: 'Active runtime credential not found.' }, 404)
        await audit(env, workspaceId, session, 'runtime.credential.revoked', 'runtime_application_credential', credentialId, projectId)
        return respond({ success: true, warning: 'Redeploy each affected environment to remove the credential from its immutable runtime policy.' })
      }
    }

    const environmentConfigMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-_]{0,62})\/environments(?:\/(dev|staging|production)\/(config|secrets))?$/)
    if (environmentConfigMatch) {
      const [, projectId, environment, resource] = environmentConfigMatch
      const project = await ownedProject(env, workspaceId, projectId)
      if (!project) return respond({ success: false, message: 'Project not found.' }, 404)
      if (!environment && request.method === 'GET') {
        const configurations = await env.DB.prepare('SELECT environment, variables, revision, updated_at FROM environment_configuration WHERE workspace_id = ? AND project_id = ? ORDER BY environment')
          .bind(workspaceId, projectId)
          .all<{ environment: string; variables: string; revision: number; updated_at: number }>()
        const secrets = await env.DB.prepare('SELECT environment, name, rotated_at FROM environment_secrets WHERE workspace_id = ? AND project_id = ? ORDER BY environment, name')
          .bind(workspaceId, projectId)
          .all()
        const byEnvironment = Object.fromEntries((['dev', 'staging', 'production'] as const).map((name) => {
          const config = configurations.results.find((item) => item.environment === name)
          return [name, {
            variables: config ? JSON.parse(config.variables) : {},
            revision: config?.revision || 0,
            updatedAt: config?.updated_at || null,
            secrets: secrets.results.filter((item: any) => item.environment === name).map((item: any) => ({ name: item.name, rotatedAt: item.rotated_at })),
          }]
        }))
        const signatures = Object.fromEntries(await Promise.all(Object.entries(byEnvironment).map(async ([name, value]) => [name, await sha256(JSON.stringify({ variables: value.variables, secrets: value.secrets.map((secret) => secret.name) }))])))
        return respond({ success: true, environments: byEnvironment, drift: { devToStaging: signatures.dev !== signatures.staging, stagingToProduction: signatures.staging !== signatures.production } })
      }
      if (!environment || !resource || !validEnvironment(environment)) return respond({ success: false, message: 'Environment route is invalid.' }, 400)
      if (resource === 'config' && request.method === 'PUT') {
        const body = await requestJson<{ variables?: unknown }>(request)
        const variables = safeVariables(body?.variables)
        if (!variables) return respond({ success: false, message: 'Environment variables must use uppercase keys and bounded string values.' }, 400)
        const current = await env.DB.prepare('SELECT revision FROM environment_configuration WHERE workspace_id = ? AND project_id = ? AND environment = ?').bind(workspaceId, projectId, environment).first<{ revision: number }>()
        const revision = (current?.revision || 0) + 1
        const timestamp = now()
        await env.DB.prepare(`INSERT INTO environment_configuration (workspace_id, project_id, environment, variables, revision, updated_by_user_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, project_id, environment) DO UPDATE SET variables = excluded.variables, revision = excluded.revision,
            updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at`)
          .bind(workspaceId, projectId, environment, JSON.stringify(variables), revision, session.user_id, timestamp)
          .run()
        if (environment === 'production') await env.DB.prepare("DELETE FROM release_approvals WHERE release_id IN (SELECT id FROM releases WHERE project_id = ?)").bind(projectId).run()
        await audit(env, workspaceId, session, 'environment.configuration.updated', 'environment', environment, projectId, { revision, keys: Object.keys(variables) })
        return respond({ success: true, environment, revision, variables })
      }
      if (resource === 'secrets' && request.method === 'PUT') {
        const body = await requestJson<{ name?: string; value?: string }>(request)
        const name = body?.name?.trim() || ''
        const value = body?.value || ''
        if (!/^[A-Z][A-Z0-9_]{0,62}$/.test(name) || !value || value.length > 10_000) return respond({ success: false, message: 'Secret name or value is invalid.' }, 400)
        const timestamp = now()
        await env.DB.prepare(`INSERT INTO environment_secrets (workspace_id, project_id, environment, name, value_envelope, rotated_by_user_id, rotated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, project_id, environment, name) DO UPDATE SET value_envelope = excluded.value_envelope,
            rotated_by_user_id = excluded.rotated_by_user_id, rotated_at = excluded.rotated_at`)
          .bind(workspaceId, projectId, environment, name, await encryptedTokenEnvelope(value, env), session.user_id, timestamp)
          .run()
        if (environment === 'production') await env.DB.prepare("DELETE FROM release_approvals WHERE release_id IN (SELECT id FROM releases WHERE project_id = ?)").bind(projectId).run()
        await audit(env, workspaceId, session, 'environment.secret.rotated', 'environment_secret', name, projectId, { environment })
        return respond({ success: true, environment, secret: { name, rotatedAt: timestamp } })
      }
    }

    const onboardingMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-_]{0,62})\/onboarding(?:\/([a-z0-9_]{2,50}))?$/)
    if (onboardingMatch) {
      const [, projectId, step] = onboardingMatch
      if (!await ownedProject(env, workspaceId, projectId)) return respond({ success: false, message: 'Project not found.' }, 404)
      if (request.method === 'GET') {
        const progress = await env.DB.prepare('SELECT step, completed_at FROM onboarding_progress WHERE workspace_id = ? AND project_id = ? ORDER BY completed_at').bind(workspaceId, projectId).all()
        return respond({ success: true, progress: progress.results })
      }
      if (request.method === 'POST' && step && session.user_id) {
        await env.DB.prepare(`INSERT INTO onboarding_progress (workspace_id, project_id, step, completed_at, completed_by_user_id)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, project_id, step) DO UPDATE SET completed_at = excluded.completed_at, completed_by_user_id = excluded.completed_by_user_id`)
          .bind(workspaceId, projectId, step, now(), session.user_id)
          .run()
        return respond({ success: true, step })
      }
    }

    const healthRefreshMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-_]{0,62})\/readiness\/refresh-health$/)
    if (healthRefreshMatch && request.method === 'POST') {
      const projectId = healthRefreshMatch[1]
      if (!await ownedProject(env, workspaceId, projectId)) return respond({ success: false, message: 'Project not found.' }, 404)
      await sampleRuntimeHealth(env, projectId)
      await audit(env, workspaceId, session, 'readiness.health_refreshed', 'project', projectId, projectId)
      return respond({ success: true, projectId, checkedAt: now() })
    }

    const readinessMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-_]{0,62})\/readiness$/)
    if (readinessMatch && request.method === 'GET') {
      const projectId = readinessMatch[1]
      if (!await ownedProject(env, workspaceId, projectId)) return respond({ success: false, message: 'Project not found.' }, 404)
      const [contracts, release, deployments, critical, backup, uplink, configurations, telemetry] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) AS count FROM contracts WHERE project_id = ?').bind(projectId).first<{ count: number }>(),
        env.DB.prepare("SELECT id, checksum FROM releases WHERE project_id = ? AND status = 'verified' ORDER BY created_at DESC LIMIT 1").bind(projectId).first<{ id: string; checksum: string }>(),
        env.DB.prepare(`SELECT job.environment, job.runtime_url
          FROM deployment_jobs job
          WHERE job.project_id = ? AND job.status = 'succeeded'
            AND job.updated_at = (
              SELECT MAX(latest.updated_at) FROM deployment_jobs latest
              WHERE latest.project_id = job.project_id AND latest.environment = job.environment AND latest.status = 'succeeded'
            )`).bind(projectId).all<{ environment: string; runtime_url: string }>(),
        env.DB.prepare("SELECT COUNT(*) AS count FROM incidents WHERE project_id = ? AND severity = 'critical' AND status IN ('open','acknowledged')").bind(projectId).first<{ count: number }>(),
        env.DB.prepare("SELECT id, created_at FROM backup_records WHERE workspace_id = ? AND verification_status = 'verified' ORDER BY created_at DESC LIMIT 1").bind(workspaceId).first<{ id: string; created_at: number }>(),
        env.DB.prepare('SELECT account_name FROM uplink_connections WHERE workspace_id = ? AND revoked_at IS NULL AND expires_at > ?').bind(workspaceId, now()).first<{ account_name: string }>(),
        env.DB.prepare('SELECT environment, revision FROM environment_configuration WHERE workspace_id = ? AND project_id = ?').bind(workspaceId, projectId).all<{ environment: string; revision: number }>(),
        env.DB.prepare(`SELECT MAX(updated_at) AS updated_at FROM runtime_metric_buckets
          WHERE project_id = ? AND deployment_id = (
            SELECT id FROM deployment_jobs WHERE project_id = ? AND environment = 'production' AND status = 'succeeded'
            ORDER BY updated_at DESC LIMIT 1
          )`).bind(projectId, projectId).first<{ updated_at: number | null }>(),
      ])
      const healthResults = await Promise.all(deployments.results.map(async (deployment) => {
        const healthy = await fetch(`${deployment.runtime_url}/health?deep=1`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) })
          .then(async (response) => response.ok && (await response.json<{ ok?: boolean }>().catch(() => null))?.ok === true)
          .catch(() => false)
        return [deployment.environment, healthy] as const
      }))
      const deployed = new Set(healthResults.filter(([, healthy]) => healthy).map(([environment]) => environment))
      const checks = [
        { id: 'contracts', label: 'At least one valid contract', passed: Number(contracts?.count || 0) > 0 },
        { id: 'release', label: 'Verified immutable release', passed: Boolean(release) },
        { id: 'uplink', label: 'Cloudflare Uplink connected', passed: Boolean(uplink) },
        { id: 'development', label: 'Development deployment healthy', passed: deployed.has('dev') },
        { id: 'staging', label: 'Staging deployment healthy', passed: deployed.has('staging') },
        { id: 'production', label: 'Production deployment healthy', passed: deployed.has('production') },
        { id: 'critical_incidents', label: 'No critical active incident', passed: Number(critical?.count || 0) === 0 },
        { id: 'backup', label: 'Verified recovery bookmark', passed: Boolean(backup) },
        { id: 'configuration', label: 'Environment configuration recorded', passed: configurations.results.length === 3 },
        { id: 'telemetry', label: 'Runtime telemetry pipeline verified for current Production deployment', passed: Boolean(telemetry?.updated_at) },
      ]
      return respond({ success: true, projectId, ready: checks.every((check) => check.passed), checks, latestRelease: release || null, latestBackup: backup || null })
    }

    const projectMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-_]{0,62})\/contracts(?:\/([a-z0-9][a-z0-9-_]{0,62}))?$/)
    if (projectMatch) {
      const [, projectId, contractId] = projectMatch
      const project = await ownedProject(env, workspaceId, projectId)
      if (!project) return respond({ success: false, message: 'Project not found.' }, 404)

      if (!contractId && request.method === 'GET') {
        const contracts = await env.DB.prepare('SELECT id, document, revision, updated_at FROM contracts WHERE project_id = ? ORDER BY updated_at DESC').bind(projectId).all<{ id: string; document: string; revision: number; updated_at: number }>()
        return respond({ success: true, contracts: contracts.results.map((contract) => ({ ...JSON.parse(contract.document), revision: contract.revision, updatedAt: contract.updated_at })) })
      }

      if (contractId && request.method === 'PUT') {
        if (project.authoring_source === 'repository' && (session.kind !== 'cli' || request.headers.get('x-lacify-base-fingerprint') !== project.source_fingerprint)) {
          return respond({ success: false, message: 'This project is file-managed or changed after the repository base. Pull before updating it.' }, 409)
        }
        const body = await requestJson<unknown>(request)
        const validated = validateContract(body)
        if (!validated.document || validated.document.id !== contractId) return respond({ success: false, message: validated.message || 'Contract ID does not match the URL.' }, 400)
        const current = await env.DB.prepare('SELECT revision FROM contracts WHERE project_id = ? AND id = ?').bind(projectId, contractId).first<{ revision: number }>()
        const expected = request.headers.get('if-match')
        if (expected && current && Number(expected) !== current.revision) return respond({ success: false, message: 'This contract was changed elsewhere. Reload before saving.' }, 409)
        const revision = (current?.revision ?? 0) + 1
        const timestamp = now()
        await env.DB.batch([
          env.DB.prepare('INSERT INTO contracts (project_id, id, document, revision, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, id) DO UPDATE SET document = excluded.document, revision = excluded.revision, updated_at = excluded.updated_at').bind(projectId, contractId, JSON.stringify(validated.document), revision, timestamp),
          env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(timestamp, projectId),
        ])
        await audit(env, workspaceId, session, current ? 'contract.updated' : 'contract.created', 'contract', contractId, projectId, { revision })
        return respond({ success: true, contract: { ...validated.document, revision, updatedAt: timestamp } })
      }

      if (contractId && request.method === 'DELETE') {
        const result = await env.DB.prepare('DELETE FROM contracts WHERE project_id = ? AND id = ?').bind(projectId, contractId).run()
        if (!result.meta.changes) return respond({ success: false, message: 'Contract not found.' }, 404)
        await audit(env, workspaceId, session, 'contract.deleted', 'contract', contractId, projectId)
        return respond({ success: true })
      }
    }

    const blueprintMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-_]{0,62})\/webapp-blueprint$/)
    if (blueprintMatch) {
      const projectId = blueprintMatch[1]
      const project = await ownedProject(env, workspaceId, projectId)
      if (!project) return respond({ success: false, message: 'Project not found.' }, 404)
      if (request.method === 'GET') {
        const current = await env.DB.prepare('SELECT document, revision, updated_at FROM app_blueprints WHERE project_id = ?').bind(projectId).first<{ document: string; revision: number; updated_at: number }>()
        return respond({ success: true, blueprint: current ? { ...JSON.parse(current.document), revision: current.revision, updatedAt: current.updated_at } : null })
      }
      if (request.method === 'PUT') {
        const validated = validateBlueprint(await requestJson<unknown>(request))
        if (!validated.blueprint) return respond({ success: false, message: validated.message }, 400)
        const contracts = await env.DB.prepare('SELECT id FROM contracts WHERE project_id = ?').bind(projectId).all<{ id: string }>()
        const known = new Set(contracts.results.map((contract) => contract.id))
        if (validated.blueprint.aggregates.some((aggregate) => !known.has(aggregate))) return respond({ success: false, message: 'The blueprint references an aggregate that does not exist in this project.' }, 400)
        const current = await env.DB.prepare('SELECT revision FROM app_blueprints WHERE project_id = ?').bind(projectId).first<{ revision: number }>()
        const expected = request.headers.get('if-match')
        if (expected && current && Number(expected) !== current.revision) return respond({ success: false, message: 'This blueprint was changed elsewhere. Reload before saving.' }, 409)
        const revision = (current?.revision ?? 0) + 1
        const timestamp = now()
        await env.DB.prepare('INSERT INTO app_blueprints (project_id, document, revision, updated_at, updated_by_account_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET document = excluded.document, revision = excluded.revision, updated_at = excluded.updated_at, updated_by_account_id = excluded.updated_by_account_id').bind(projectId, JSON.stringify(validated.blueprint), revision, timestamp, session.account_id).run()
        await audit(env, workspaceId, session, current ? 'webapp.updated' : 'webapp.created', 'webapp_blueprint', projectId, projectId, { revision })
        return respond({ success: true, blueprint: { ...validated.blueprint, revision, updatedAt: timestamp } })
      }
    }

    const releaseMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-_]{0,62})\/releases(?:\/(release_[a-f0-9]{24}))?$/)
    if (releaseMatch) {
      const [, projectId, releaseId] = releaseMatch
      const project = await ownedProject(env, workspaceId, projectId)
      if (!project) return respond({ success: false, message: 'Project not found.' }, 404)

      if (!releaseId && request.method === 'GET') {
        const releases = await env.DB.prepare('SELECT id, checksum, manifest, status, created_at, EXISTS(SELECT 1 FROM release_approvals WHERE release_id = releases.id) AS approved FROM releases WHERE project_id = ? ORDER BY created_at DESC').bind(projectId).all<{ id: string; checksum: string; manifest: string; status: string; created_at: number; approved: number }>()
        return respond({ success: true, releases: releases.results.map((release) => ({ id: release.id, checksum: release.checksum, status: release.status, createdAt: release.created_at, manifest: JSON.parse(release.manifest), approved: Boolean(release.approved) })) })
      }

      if (!releaseId && request.method === 'POST') {
        const stored = await env.DB.prepare('SELECT document, revision FROM contracts WHERE project_id = ? ORDER BY id').bind(projectId).all<{ document: string; revision: number }>()
        try {
          const savedBlueprint = await env.DB.prepare('SELECT document FROM app_blueprints WHERE project_id = ?').bind(projectId).first<{ document: string }>()
          const compiled = await compileRelease(projectId, stored.results.map((contract) => ({ ...JSON.parse(contract.document), revision: contract.revision })), savedBlueprint ? JSON.parse(savedBlueprint.document) : undefined)
          compiled.manifest.sourceFingerprint = project.source_fingerprint
          const existing = await env.DB.prepare('SELECT id, checksum, manifest, status, created_at FROM releases WHERE project_id = ? AND checksum = ?').bind(projectId, compiled.checksum).first<{ id: string; checksum: string; manifest: string; status: string; created_at: number }>()
          if (existing) return respond({ success: true, reused: true, release: { id: existing.id, checksum: existing.checksum, status: existing.status, createdAt: existing.created_at, manifest: JSON.parse(existing.manifest) } })
          const timestamp = now()
          const compiledId = `release_${compiled.checksum.slice(0, 24)}`
          await env.DB.prepare('INSERT INTO releases (id, project_id, workspace_id, checksum, manifest, artifact, status, created_by_account_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(compiledId, projectId, workspaceId, compiled.checksum, JSON.stringify(compiled.manifest), JSON.stringify(compiled.artifact), 'compiled', session.account_id, timestamp).run()
          await audit(env, workspaceId, session, 'release.compiled', 'release', compiledId, projectId, { checksum: compiled.checksum })
          return respond({ success: true, reused: false, release: { id: compiledId, checksum: compiled.checksum, status: 'compiled', createdAt: timestamp, manifest: compiled.manifest } }, 201)
        } catch (error) {
          return respond({ success: false, message: error instanceof Error ? error.message : 'Compilation failed.' }, 422)
        }
      }

      if (releaseId && request.method === 'GET') {
        const release = await env.DB.prepare('SELECT id, checksum, manifest, artifact, status, created_at FROM releases WHERE id = ? AND project_id = ? AND workspace_id = ?').bind(releaseId, projectId, workspaceId).first<{ id: string; checksum: string; manifest: string; artifact: string; status: string; created_at: number }>()
        if (!release) return respond({ success: false, message: 'Release not found.' }, 404)
        const [verification, approvals] = await Promise.all([
          env.DB.prepare('SELECT status, checks, verified_at FROM release_verifications WHERE release_id = ? ORDER BY verified_at DESC LIMIT 1').bind(releaseId).first<{ status: string; checks: string; verified_at: number }>(),
          env.DB.prepare('SELECT account_id, approved_at FROM release_approvals WHERE release_id = ? ORDER BY approved_at DESC').bind(releaseId).all<{ account_id: string; approved_at: number }>(),
        ])
        return respond({ success: true, release: { id: release.id, checksum: release.checksum, status: release.status, createdAt: release.created_at, manifest: JSON.parse(release.manifest), artifact: JSON.parse(release.artifact), verification: verification ? { status: verification.status, checks: JSON.parse(verification.checks), verifiedAt: verification.verified_at } : null, approvals: approvals.results } })
      }
    }

    const changeRequestMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-_]{0,62})\/releases\/(release_[a-f0-9]{24})\/change-request(?:\/(approve|reject))?$/)
    if (changeRequestMatch) {
      const [, projectId, releaseId, action] = changeRequestMatch
      if (!await ownedProject(env, workspaceId, projectId)) return respond({ success: false, message: 'Project not found.' }, 404)
      const release = await env.DB.prepare('SELECT id, status FROM releases WHERE id = ? AND project_id = ?').bind(releaseId, projectId).first<{ id: string; status: string }>()
      if (!release) return respond({ success: false, message: 'Release not found.' }, 404)
      if (request.method === 'GET') {
        const change = await env.DB.prepare('SELECT * FROM production_change_requests WHERE release_id = ? ORDER BY requested_at DESC LIMIT 1').bind(releaseId).first()
        return respond({ success: true, changeRequest: change || null })
      }
      if (!action && request.method === 'POST') {
        if (!session.user_id || !await hasCapability(env, workspaceId, session, 'release.manage')) return respond({ success: false, message: 'Release-management permission is required.' }, 403)
        const body = await requestJson<{ summary?: string; rollbackReleaseId?: string }>(request)
        const summary = body?.summary?.trim() || ''
        const rollbackReleaseId = body?.rollbackReleaseId?.trim() || null
        if (summary.length < 10 || summary.length > 2_000) return respond({ success: false, message: 'A change summary between 10 and 2,000 characters is required.' }, 400)
        if (rollbackReleaseId && !/^release_[a-f0-9]{24}$/.test(rollbackReleaseId)) return respond({ success: false, message: 'Rollback release ID is invalid.' }, 400)
        if (rollbackReleaseId) {
          const rollback = await env.DB.prepare("SELECT id FROM deployment_jobs WHERE project_id = ? AND release_id = ? AND environment = 'production' AND status = 'succeeded'").bind(projectId, rollbackReleaseId).first()
          if (!rollback) return respond({ success: false, message: 'Rollback target must be a previously healthy Production release.' }, 400)
        }
        const priorProduction = await env.DB.prepare("SELECT COUNT(*) AS count FROM deployment_jobs WHERE project_id = ? AND environment = 'production' AND status = 'succeeded'").bind(projectId).first<{ count: number }>()
        if (Number(priorProduction?.count || 0) > 0 && !rollbackReleaseId) return respond({ success: false, message: 'A previously healthy Production rollback target is required.' }, 400)
        const productionConfig = await env.DB.prepare("SELECT revision FROM environment_configuration WHERE workspace_id = ? AND project_id = ? AND environment = 'production'").bind(workspaceId, projectId).first<{ revision: number }>()
        const changeId = id('change')
        const timestamp = now()
        await env.DB.prepare(`INSERT INTO production_change_requests
          (id, workspace_id, project_id, release_id, summary, rollback_release_id, config_revision, status, requested_by_user_id,
           approved_by_user_id, requested_at, approved_at, deployed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, NULL, ?, NULL, NULL, ?)`)
          .bind(changeId, workspaceId, projectId, releaseId, summary, rollbackReleaseId, productionConfig?.revision || 0, session.user_id, timestamp, timestamp)
          .run()
        await audit(env, workspaceId, session, 'production.change_requested', 'change_request', changeId, projectId, { releaseId, rollbackReleaseId })
        return respond({ success: true, changeRequest: { id: changeId, status: 'draft', configRevision: productionConfig?.revision || 0 } }, 201)
      }
      if (action && request.method === 'POST') {
        if (!session.user_id || !await hasCapability(env, workspaceId, session, 'production.approve')) return respond({ success: false, message: 'Production approval permission is required.' }, 403)
        const change = await env.DB.prepare("SELECT id, requested_by_user_id, status FROM production_change_requests WHERE release_id = ? AND status = 'draft' ORDER BY requested_at DESC LIMIT 1").bind(releaseId).first<{ id: string; requested_by_user_id: string; status: string }>()
        if (!change) return respond({ success: false, message: 'Draft change request not found.' }, 404)
        const policy = await env.DB.prepare('SELECT require_separate_approver FROM production_governance_policies WHERE workspace_id = ?').bind(workspaceId).first<{ require_separate_approver: number }>()
        if (action === 'approve' && policy?.require_separate_approver && change.requested_by_user_id === session.user_id) return respond({ success: false, message: 'A different member must approve this Production change.' }, 409)
        const status = action === 'approve' ? 'approved' : 'rejected'
        await env.DB.prepare('UPDATE production_change_requests SET status = ?, approved_by_user_id = ?, approved_at = ?, updated_at = ? WHERE id = ?').bind(status, session.user_id, now(), now(), change.id).run()
        await audit(env, workspaceId, session, `production.change_${status}`, 'change_request', change.id, projectId, { releaseId })
        return respond({ success: true, changeRequest: { id: change.id, status } })
      }
    }

    const productionOverrideMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-_]{0,62})\/releases\/(release_[a-f0-9]{24})\/override$/)
    if (productionOverrideMatch && request.method === 'POST') {
      const [, projectId, releaseId] = productionOverrideMatch
      if (!session.user_id || !await hasCapability(env, workspaceId, session, 'deploy.production')) return respond({ success: false, message: 'Production deployment permission is required.' }, 403)
      if (!await sensitiveActionAllowed(env, workspaceId, session, 'production.override', 3)) return respond({ success: false, message: 'Emergency override rate limit exceeded.' }, 429)
      const body = await requestJson<{ reason?: string }>(request)
      const reason = body?.reason?.trim() || ''
      if (reason.length < 20 || reason.length > 1_000) return respond({ success: false, message: 'A detailed emergency reason is required.' }, 400)
      const overrideId = id('override')
      const timestamp = now()
      const expiresAt = timestamp + 60 * 60 * 1000
      await env.DB.prepare(`INSERT INTO deployment_overrides
        (id, workspace_id, project_id, release_id, reason, created_by_user_id, expires_at, revoked_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
        .bind(overrideId, workspaceId, projectId, releaseId, reason, session.user_id, expiresAt, timestamp)
        .run()
      await audit(env, workspaceId, session, 'production.override.created', 'deployment_override', overrideId, projectId, { releaseId, expiresAt })
      return respond({ success: true, override: { id: overrideId, expiresAt } }, 201)
    }

    const rollbackMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-_]{0,62})\/production\/rollback$/)
    if (rollbackMatch && request.method === 'POST') {
      const projectId = rollbackMatch[1]
      if (!session.user_id || !await hasCapability(env, workspaceId, session, 'deploy.production')) return respond({ success: false, message: 'Production deployment permission is required.' }, 403)
      if (!await sensitiveActionAllowed(env, workspaceId, session, 'production.rollback', 3)) return respond({ success: false, message: 'Rollback rate limit exceeded.' }, 429)
      const body = await requestJson<{ releaseId?: string; reason?: string }>(request)
      const releaseId = body?.releaseId || ''
      const reason = body?.reason?.trim() || ''
      if (!/^release_[a-f0-9]{24}$/.test(releaseId) || reason.length < 10) return respond({ success: false, message: 'A healthy target release and rollback reason are required.' }, 400)
      const target = await env.DB.prepare("SELECT id, runtime_url FROM deployment_jobs WHERE project_id = ? AND release_id = ? AND environment = 'production' AND status = 'succeeded'").bind(projectId, releaseId).first<{ id: string; runtime_url: string }>()
      if (!target) return respond({ success: false, message: 'Healthy Production rollback target not found.' }, 404)
      const health = await fetch(`${target.runtime_url}/health?deep=1`, { signal: AbortSignal.timeout(5_000) }).then((response) => response.ok).catch(() => false)
      if (!health) return respond({ success: false, message: 'Rollback target failed its current health check.' }, 409)
      const timestamp = now()
      await env.DB.prepare('UPDATE deployment_jobs SET updated_at = ?, logs = json_insert(logs, \'$[#]\', json(?)) WHERE id = ?')
        .bind(timestamp, JSON.stringify(deploymentLog('rollback_activated', reason, timestamp)), target.id)
        .run()
      await env.DB.prepare("UPDATE production_change_requests SET status = 'rolled_back', updated_at = ? WHERE project_id = ? AND status = 'deployed'").bind(timestamp, projectId).run()
      await audit(env, workspaceId, session, 'production.rolled_back', 'release', releaseId, projectId, { reason, runtimeUrl: target.runtime_url })
      return respond({ success: true, releaseId, runtimeUrl: target.runtime_url, verifiedHealthy: true })
    }

    const governanceMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-_]{0,62})\/releases\/(release_[a-f0-9]{24})\/(verify|approve)$/)
    if (governanceMatch) {
      const [, projectId, releaseId, operation] = governanceMatch
      const project = await ownedProject(env, workspaceId, projectId)
      if (!project) return respond({ success: false, message: 'Project not found.' }, 404)
      const release = await env.DB.prepare('SELECT id, status, manifest, artifact, created_by_account_id FROM releases WHERE id = ? AND project_id = ? AND workspace_id = ?').bind(releaseId, projectId, workspaceId).first<{ id: string; status: string; manifest: string; artifact: string; created_by_account_id: string }>()
      if (!release) return respond({ success: false, message: 'Release not found.' }, 404)
      if (operation === 'verify' && request.method === 'POST') {
        if (release.status === 'archived') return respond({ success: false, message: 'An archived release cannot be verified.' }, 409)
        const policy = await env.DB.prepare('SELECT require_separate_verifier FROM production_governance_policies WHERE workspace_id = ?').bind(workspaceId).first<{ require_separate_verifier: number }>()
        if (policy?.require_separate_verifier && release.created_by_account_id === session.account_id) return respond({ success: false, message: 'A different member must verify this release.' }, 409)
        const manifest = JSON.parse(release.manifest) as { format?: string; contracts?: unknown[]; targets?: string[] }
        const artifact = JSON.parse(release.artifact) as Record<string, string>
        const checks = [
          { name: 'Manifest format', passed: manifest.format === 'lacify-release-manifest/v1' },
          { name: 'Contracts present', passed: Array.isArray(manifest.contracts) && manifest.contracts.length > 0 },
          { name: 'Cloudflare runtime artifact', passed: Boolean((artifact['worker.js'] || artifact['worker.ts']) && artifact['wrangler.jsonc'] && artifact['schema.sql']) },
          { name: 'Web app artifact', passed: !manifest.targets?.includes('react-webapp-command-console') || Boolean(artifact['webapp-react/src/main.jsx']) },
        ]
        const passed = checks.every((check) => check.passed)
        const timestamp = now()
        await env.DB.batch([
          env.DB.prepare('INSERT INTO release_verifications (id, release_id, status, checks, verified_by_account_id, verified_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id('verify'), releaseId, passed ? 'passed' : 'failed', JSON.stringify(checks), session.account_id, timestamp),
          env.DB.prepare('UPDATE releases SET status = ? WHERE id = ?').bind(passed ? 'verified' : 'blocked', releaseId),
        ])
        await audit(env, workspaceId, session, passed ? 'release.verified' : 'release.blocked', 'release', releaseId, projectId, { checks })
        return respond({ success: true, verification: { status: passed ? 'passed' : 'failed', checks, verifiedAt: timestamp }, releaseStatus: passed ? 'verified' : 'blocked' })
      }
      if (operation === 'approve' && request.method === 'POST') {
        if (release.status !== 'verified') return respond({ success: false, message: 'Only a verified release can be approved.' }, 409)
        if (!await hasCapability(env, workspaceId, session, 'production.approve')) return respond({ success: false, message: 'Production approval permission is required.' }, 403)
        const change = await env.DB.prepare("SELECT id, config_revision FROM production_change_requests WHERE release_id = ? AND status = 'approved' ORDER BY approved_at DESC LIMIT 1").bind(releaseId).first<{ id: string; config_revision: number }>()
        if (!change) return respond({ success: false, message: 'Approve the reviewed Production change request first.' }, 409)
        const productionConfig = await env.DB.prepare("SELECT revision FROM environment_configuration WHERE workspace_id = ? AND project_id = ? AND environment = 'production'").bind(workspaceId, projectId).first<{ revision: number }>()
        if (change.config_revision !== (productionConfig?.revision || 0)) return respond({ success: false, message: 'Production configuration changed after review. Create a new change request.' }, 409)
        const timestamp = now()
        await env.DB.prepare('INSERT OR REPLACE INTO release_approvals (release_id, account_id, approved_at, change_request_id, config_revision) VALUES (?, ?, ?, ?, ?)').bind(releaseId, session.user_id || session.account_id, timestamp, change.id, change.config_revision).run()
        await audit(env, workspaceId, session, 'release.approved', 'release', releaseId, projectId, { changeRequestId: change.id, configRevision: change.config_revision })
        return respond({ success: true, approval: { accountId: session.account_id, approvedAt: timestamp } })
      }
    }

    const deploymentMatch = url.pathname.match(/^\/api\/projects\/([a-z0-9][a-z0-9-_]{0,62})\/releases\/(release_[a-f0-9]{24})\/deployments$/)
    if (deploymentMatch) {
      const [, projectId, releaseId] = deploymentMatch
      const project = await ownedProject(env, workspaceId, projectId)
      if (!project) return respond({ success: false, message: 'Project not found.' }, 404)
      const release = await env.DB.prepare('SELECT id, checksum, manifest, artifact, status FROM releases WHERE id = ? AND project_id = ? AND workspace_id = ?').bind(releaseId, projectId, workspaceId).first<{ id: string; checksum: string; manifest: string; artifact: string; status: string }>()
      if (!release) return respond({ success: false, message: 'Release not found.' }, 404)

      if (request.method === 'GET') {
        const jobs = await env.DB.prepare('SELECT id, environment, status, resource_plan, smoke_check, runtime_url, logs, created_at, updated_at FROM deployment_jobs WHERE project_id = ? AND release_id = ? ORDER BY created_at DESC').bind(projectId, releaseId).all<{ id: string; environment: string; status: DeploymentStatus; resource_plan: string; smoke_check: string | null; runtime_url: string | null; logs: string; created_at: number; updated_at: number }>()
        return respond({ success: true, deployments: jobs.results.map((job) => ({ ...job, resourcePlan: JSON.parse(job.resource_plan), smokeCheck: job.smoke_check ? JSON.parse(job.smoke_check) : null, logs: JSON.parse(job.logs || '[]') })) })
      }

      if (request.method === 'POST') {
        const body = await requestJson<{ environment?: string; redeploy?: boolean }>(request)
        const environment = body?.environment
        const redeploy = body?.redeploy === true
        if (environment !== 'dev' && environment !== 'staging' && environment !== 'production') return respond({ success: false, message: 'Choose development, staging, or production.' }, 400)
        const deploymentCapability: Capability = environment === 'dev' ? 'deploy.dev' : environment === 'staging' ? 'deploy.staging' : 'deploy.production'
        if (!await hasCapability(env, workspaceId, session, deploymentCapability)) return respond({ success: false, message: `Permission required: ${deploymentCapability}.` }, 403)
        if (!await sensitiveActionAllowed(env, workspaceId, session, `deployment.${environment}`, environment === 'production' ? 3 : 10)) return respond({ success: false, message: `${environment} deployment rate limit exceeded.` }, 429)
        if (release.status !== 'verified') return respond({ success: false, message: 'Verify the immutable release before deploying it.' }, 409)
        const environmentConfig = await env.DB.prepare('SELECT revision FROM environment_configuration WHERE workspace_id = ? AND project_id = ? AND environment = ?').bind(workspaceId, projectId, environment).first<{ revision: number }>()
        if (!environmentConfig) return respond({ success: false, message: `Record ${environment} environment configuration before deployment.` }, 409)
        const environmentLabel = environment === 'dev' ? 'Development' : environment === 'staging' ? 'Staging' : 'Production'
        if (environment !== 'dev') {
          const prerequisiteEnvironment: DeploymentEnvironment = environment === 'staging' ? 'dev' : 'staging'
          const prerequisite = await env.DB.prepare('SELECT status FROM deployment_jobs WHERE project_id = ? AND release_id = ? AND environment = ?').bind(projectId, releaseId, prerequisiteEnvironment).first<{ status: DeploymentStatus }>()
          if (prerequisite?.status !== 'succeeded') return respond({ success: false, message: `${environment === 'staging' ? 'Development' : 'Staging'} must succeed before ${environmentLabel}.` }, 409)
        }
        if (environment === 'production') {
          const productionConfig = await env.DB.prepare("SELECT revision FROM environment_configuration WHERE workspace_id = ? AND project_id = ? AND environment = 'production'").bind(workspaceId, projectId).first<{ revision: number }>()
          const approval = await env.DB.prepare('SELECT account_id, change_request_id, config_revision FROM release_approvals WHERE release_id = ? LIMIT 1').bind(releaseId).first<{ account_id: string; change_request_id: string; config_revision: number }>()
          if (!approval) return respond({ success: false, message: 'Approve this verified release before deploying to Production.' }, 409)
          if (!approval.change_request_id || approval.config_revision !== (productionConfig?.revision || 0)) return respond({ success: false, message: 'Production approval is stale because configuration or change context changed.' }, 409)
          const critical = await env.DB.prepare("SELECT COUNT(*) AS count FROM incidents WHERE project_id = ? AND severity = 'critical' AND status IN ('open','acknowledged')").bind(projectId).first<{ count: number }>()
          if (Number(critical?.count || 0) > 0) {
            const override = await env.DB.prepare('SELECT id FROM deployment_overrides WHERE project_id = ? AND release_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1').bind(projectId, releaseId, now()).first()
            if (!override) return respond({ success: false, message: 'Resolve critical readiness incidents or create an audited emergency override.' }, 409)
          }
          const policy = await env.DB.prepare('SELECT require_separate_deployer, deployment_window_start_hour, deployment_window_end_hour FROM production_governance_policies WHERE workspace_id = ?').bind(workspaceId).first<{ require_separate_deployer: number; deployment_window_start_hour: number | null; deployment_window_end_hour: number | null }>()
          if (policy?.require_separate_deployer && approval.account_id === session.user_id) return respond({ success: false, message: 'A different member must deploy this approved Production release.' }, 409)
          if (policy?.deployment_window_start_hour !== null && policy?.deployment_window_end_hour !== null) {
            const hour = new Date().getUTCHours()
            const start = Number(policy.deployment_window_start_hour)
            const end = Number(policy.deployment_window_end_hour)
            const insideWindow = start === end || (start < end ? hour >= start && hour < end : hour >= start || hour < end)
            if (!insideWindow) {
              const override = await env.DB.prepare('SELECT id FROM deployment_overrides WHERE project_id = ? AND release_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1').bind(projectId, releaseId, now()).first()
              if (!override) return respond({ success: false, message: `Production deployment is outside the configured UTC window (${start}:00–${end}:00).` }, 409)
            }
          }
        }
        const manifest = JSON.parse(release.manifest) as { resourcePlan?: { durableObjects?: string[]; sqliteTables?: string[] } }
        // The release artifact is immutable in the Control Plane, while the
        // environment target remains stable so Durable Object namespaces and
        // their private SQLite databases survive forward release promotion.
        const prefix = `${projectId.replace(/_/g, '-').slice(0, 40)}-${environment}`
        const resourcePlan = {
          environment, releaseId, checksum: release.checksum,
          workerName: `${prefix}-runtime`,
          durableObjects: (manifest.resourcePlan?.durableObjects || []).map((binding) => ({ binding, name: `${prefix}-${binding.toLowerCase()}` })),
          sqliteTables: manifest.resourcePlan?.sqliteTables || [],
          requires: ['Cloudflare Workers:Edit', 'Durable Objects:Edit'],
          promotionFrom: environment === 'dev' ? null : environment === 'staging' ? 'dev' : 'staging',
          rollbackTarget: environment === 'production' ? 'staging' : environment === 'staging' ? 'dev' : null,
          risk: environment === 'production' ? 'guarded' : 'safe',
        }
        const timestamp = now()
        const deploymentId = `deploy_${release.checksum.slice(0, 18)}_${environment}`
        const existing = await env.DB.prepare('SELECT id, status, resource_plan, smoke_check, runtime_url, logs, created_at FROM deployment_jobs WHERE project_id = ? AND release_id = ? AND environment = ?').bind(projectId, releaseId, environment).first<{ id: string; status: DeploymentStatus; resource_plan: string; smoke_check: string | null; runtime_url: string | null; logs: string; created_at: number }>()
        if (existing && activeDeploymentStatuses.includes(existing.status)) return respond({ success: true, reused: true, deployment: { id: existing.id, environment, status: existing.status, resourcePlan: JSON.parse(existing.resource_plan), logs: JSON.parse(existing.logs || '[]'), createdAt: existing.created_at } })
        if (existing && existing.status === 'succeeded' && !redeploy) return respond({ success: true, reused: true, deployment: { id: existing.id, environment, status: existing.status, resourcePlan: JSON.parse(existing.resource_plan), logs: JSON.parse(existing.logs || '[]'), createdAt: existing.created_at } })
        if (existing && !retryableDeploymentStatuses.includes(existing.status) && !(existing.status === 'succeeded' && redeploy)) return respond({ success: false, message: `This ${environmentLabel} job cannot be retried from its current state.` }, 409)
        if (existing?.status === 'failed' && existing.runtime_url) {
          let recoveredResponse: Response | null = null
          let recoveredPayload: { ok?: boolean; deploymentId?: string; releaseId?: string } | null = null
          const recoveryDelays = [0, 2_000, 4_000, 8_000, 8_000, 8_000]
          for (const delay of recoveryDelays) {
            if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
            recoveredResponse = await fetch(`${existing.runtime_url}/health?deep=1`, { headers: { accept: 'application/json' } }).catch(() => null)
            recoveredPayload = recoveredResponse ? await recoveredResponse.json<{ ok?: boolean }>().catch(() => null) : null
            if (recoveredResponse?.ok && recoveredPayload?.ok === true && recoveredPayload.deploymentId === existing.id && recoveredPayload.releaseId === releaseId) break
          }
          if (recoveredResponse?.ok && recoveredPayload?.ok === true && recoveredPayload.deploymentId === existing.id && recoveredPayload.releaseId === releaseId) {
            const recoveredAt = now()
            const smokeCheck = { status: 'passed', message: 'Deep runtime health check passed after activation delay.', checkedAt: recoveredAt, url: `${existing.runtime_url}/health?deep=1` }
            const recoveredLogs = [...JSON.parse(existing.logs || '[]') as unknown[], deploymentLog('smoke_recovered', smokeCheck.message, recoveredAt)]
            await env.DB.prepare('UPDATE deployment_jobs SET status = ?, smoke_check = ?, logs = ?, updated_at = ? WHERE id = ?').bind('succeeded', JSON.stringify(smokeCheck), JSON.stringify(recoveredLogs), recoveredAt, existing.id).run()
            await audit(env, workspaceId, session, `deployment.${environment}.succeeded`, 'deployment', existing.id, projectId, { releaseId, runtimeUrl: existing.runtime_url, smokeCheck, recovered: true })
            return respond({ success: true, reused: true, deployment: { id: existing.id, environment, status: 'succeeded', resourcePlan: JSON.parse(existing.resource_plan), runtimeUrl: existing.runtime_url, smokeCheck, logs: recoveredLogs, createdAt: existing.created_at } })
          }
        }
        const logs = [...(existing ? JSON.parse(existing.logs || '[]') as unknown[] : []), deploymentLog(existing ? 'retry_started' : 'planned', existing ? `${environmentLabel} deployment retry started.` : `${environmentLabel} deployment planned.`)]
        if (existing) {
          await env.DB.prepare('UPDATE deployment_jobs SET status = ?, resource_plan = ?, smoke_check = NULL, runtime_url = NULL, logs = ?, updated_at = ? WHERE id = ?').bind('provisioning', JSON.stringify(resourcePlan), JSON.stringify(logs), timestamp, existing.id).run()
        } else {
          await env.DB.prepare('INSERT INTO deployment_jobs (id, project_id, workspace_id, release_id, environment, status, resource_plan, smoke_check, logs, created_by_account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)').bind(deploymentId, projectId, workspaceId, releaseId, environment, 'provisioning', JSON.stringify(resourcePlan), JSON.stringify(logs), session.account_id, timestamp, timestamp).run()
        }
        let telemetryCredentialId: string | null = null
        try {
          const uplink = session.kind === 'application' || session.kind === 'cli'
            ? await env.DB.prepare('SELECT token_envelope FROM uplink_connections WHERE workspace_id = ? AND account_id = ? AND revoked_at IS NULL AND expires_at > ?').bind(workspaceId, session.account_id, now()).first<{ token_envelope: string }>()
            : await env.DB.prepare('SELECT token_envelope FROM sessions WHERE id = ? AND account_id = ? AND revoked_at IS NULL AND expires_at > ?').bind(session.id, session.account_id, now()).first<{ token_envelope: string }>()
          if (!uplink) throw new Error('Reconnect Uplink before deploying.')
          const token = await decryptedToken(uplink.token_envelope, env)
          const check = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(session.account_id)}/workers/scripts`, { headers: { authorization: `Bearer ${token}` } })
          if (!check.ok) throw new Error(await cloudflareErrorMessage(check))
          const artifact = JSON.parse(release.artifact) as Record<string, string>
          const worker = artifact['worker.js'] || artifact['worker.ts']
          if (!worker) throw new Error('The immutable release does not contain a Worker artifact.')
          const eventRouterWorker = artifact['event-router.js']
          const eventRouterConfig = artifact['wrangler.event-router.jsonc']
            ? JSON.parse(artifact['wrangler.event-router.jsonc']) as {
                services?: Array<{ binding: string; service: string }>
                r2_buckets?: Array<{ binding: string; bucket_name: string }>
              }
            : null
          const contracts = (JSON.parse(release.manifest) as { contracts?: Array<{ aggregateType: string }> }).contracts || []
          const scriptEndpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(session.account_id)}/workers/scripts/${encodeURIComponent(resourcePlan.workerName)}`
          const scriptSubdomainEndpoint = `${scriptEndpoint}/subdomain`
          const scriptLookup = await fetch(scriptSubdomainEndpoint, { headers: { authorization: `Bearer ${token}` } })
          const scriptExists = scriptLookup.ok
          if (!scriptExists && scriptLookup.status !== 404) throw new Error(await cloudflareErrorMessage(scriptLookup))
          const telemetryCredential = newTelemetryCredential()
          telemetryCredentialId = id('telemetry')
          const telemetryExpiresAt = now() + telemetryCredentialLifetimeMs
          await env.DB.batch([
            env.DB.prepare('UPDATE telemetry_credentials SET revoked_at = ? WHERE deployment_id = ? AND revoked_at IS NULL').bind(now(), deploymentId),
            env.DB.prepare('INSERT INTO telemetry_credentials (id, deployment_id, credential_hash, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)').bind(telemetryCredentialId, deploymentId, await sha256(telemetryCredential), now(), telemetryExpiresAt),
          ])
          const form = new FormData()
          const classes = contracts.map((contract) => `${contract.aggregateType}DO`)
          const previousDeployment = scriptExists
            ? await env.DB.prepare(`
                SELECT releases.manifest
                FROM deployment_jobs
                JOIN releases ON releases.id = deployment_jobs.release_id
                WHERE deployment_jobs.project_id = ?
                  AND deployment_jobs.environment = ?
                  AND deployment_jobs.status = 'succeeded'
                  AND deployment_jobs.release_id <> ?
                ORDER BY deployment_jobs.updated_at DESC
                LIMIT 1
              `).bind(projectId, environment, releaseId).first<{ manifest: string }>()
            : null
          const currentReleasePreviouslySucceeded = existing?.status === 'succeeded'
            || (existing
              ? (JSON.parse(existing.logs || '[]') as Array<{ event?: string }>)
                  .some((entry) => entry.event === 'smoke_passed' || entry.event === 'smoke_recovered')
              : false)
          const previousContracts = currentReleasePreviouslySucceeded
            ? contracts
            : previousDeployment
              ? ((JSON.parse(previousDeployment.manifest) as { contracts?: Array<{ aggregateType: string }> }).contracts || [])
              : []
          const previousClasses = new Set(
            previousContracts.map((contract) => `${contract.aggregateType}DO`),
          )
          // A prior upload can create a Durable Object class even when the
          // deployment job later fails (for example during smoke checks).
          // Do not attempt to register that class a second time on retry.
          if (scriptExists && existing) {
            for (const className of classes) previousClasses.add(className)
          }
          const newClasses = scriptExists
            ? classes.filter((className) => !previousClasses.has(className))
            : classes
          const telemetryBaseUrl = (env.PUBLIC_BASE_URL || new URL(request.url).origin).replace(/\/$/, '')
          const observabilityPolicy = await env.DB.prepare('SELECT sampling_rate FROM observability_policies WHERE workspace_id = ?').bind(workspaceId).first<{ sampling_rate: number }>()
          const applicationCredentials = await env.DB.prepare(`SELECT id, token_hash, capabilities, expires_at
            FROM runtime_application_credentials
            WHERE workspace_id = ? AND project_id = ? AND environment = ? AND revoked_at IS NULL AND expires_at > ?
            ORDER BY id`)
            .bind(workspaceId, projectId, environment, now())
            .all<{ id: string; token_hash: string; capabilities: string; expires_at: number }>()
          // Cloudflare text bindings are capped at 5 KiB. Keep the deployed
          // credential policy compact so projects can add operations without
          // the repeated JSON property names exhausting that limit.
          const applicationAccessPolicy = {
            v: 2,
            e: environment,
            c: applicationCredentials.results.map((credential) => ({
              i: credential.id,
              h: credential.token_hash,
              x: credential.expires_at,
              a: (JSON.parse(credential.capabilities) as Array<{
                actor: string
                operations: string[]
                rateLimitPerMinute: number
                maxPayloadBytes: number
              }>).map((capability) => [
                capability.actor,
                capability.operations,
                capability.rateLimitPerMinute,
                capability.maxPayloadBytes,
              ]),
            })),
          }
          const eventRouterSecret = eventRouterWorker ? newTelemetryCredential() : null
          const realtimeSinkSecret = eventRouterConfig?.services?.some(({ binding }) => binding === 'REALTIME_SINK')
            ? newTelemetryCredential()
            : null
          if (eventRouterWorker && eventRouterSecret) {
            const eventRouterName = `lacify-${projectId}-${environment}-event-router`
            const eventRouterEndpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(session.account_id)}/workers/scripts/${encodeURIComponent(eventRouterName)}`
            const eventRouterLookup = await fetch(`${eventRouterEndpoint}/subdomain`, { headers: { authorization: `Bearer ${token}` } })
            const eventRouterExists = eventRouterLookup.ok
            if (!eventRouterExists && eventRouterLookup.status !== 404) throw new Error(await cloudflareErrorMessage(eventRouterLookup))
            if (realtimeSinkSecret) {
              const realtimeService = eventRouterConfig?.services?.find(({ binding }) => binding === 'REALTIME_SINK')?.service
              if (!realtimeService) throw new Error('Realtime service binding is missing from the immutable Event Router artifact.')
              const realtimeSecretResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(session.account_id)}/workers/scripts/${encodeURIComponent(realtimeService)}/secrets`, {
                method: 'PUT',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'LACIFY_REALTIME_SINK_SECRET', text: realtimeSinkSecret, type: 'secret_text' }),
              })
              if (!realtimeSecretResponse.ok) throw new Error(await cloudflareErrorMessage(realtimeSecretResponse))
            }
            const eventRouterMetadata = {
              main_module: 'event-router.js',
              compatibility_date: '2026-07-20',
              bindings: [
                { name: 'EVENT_ROUTER_DO', type: 'durable_object_namespace', class_name: 'EventRouterActor' },
                { name: 'LACIFY_ENVIRONMENT', type: 'plain_text', text: environment },
                { name: 'LACIFY_EVENT_ROUTER_SECRET', type: 'secret_text', text: eventRouterSecret },
                { name: 'LACIFY_PREFLIGHT_SECRET', type: 'secret_text', text: newTelemetryCredential() },
                ...(realtimeSinkSecret ? [
                  { name: 'REALTIME_SINK', type: 'service', service: eventRouterConfig!.services!.find(({ binding }) => binding === 'REALTIME_SINK')!.service },
                  { name: 'LACIFY_REALTIME_SINK_SECRET', type: 'secret_text', text: realtimeSinkSecret },
                ] : []),
                ...(eventRouterConfig?.r2_buckets || []).map(({ binding, bucket_name }) => ({ name: binding, type: 'r2_bucket', bucket_name })),
              ],
              ...(!eventRouterExists ? { migrations: { tag: 'r1', new_sqlite_classes: ['EventRouterActor'] } } : {}),
            }
            const eventRouterForm = new FormData()
            eventRouterForm.set('metadata', new Blob([JSON.stringify(eventRouterMetadata)], { type: 'application/json' }))
            eventRouterForm.set('event-router.js', new Blob([eventRouterWorker], { type: 'application/javascript+module' }), 'event-router.js')
            const eventRouterUpload = await fetch(eventRouterEndpoint, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: eventRouterForm })
            if (!eventRouterUpload.ok) throw new Error(await cloudflareErrorMessage(eventRouterUpload))
          }
          const metadata = {
            main_module: 'worker.js', compatibility_date: '2026-07-20',
            bindings: [
              ...contracts.map((contract) => ({ name: `${contract.aggregateType.toUpperCase()}_DO`, type: 'durable_object_namespace', class_name: `${contract.aggregateType}DO` })),
              ...(eventRouterWorker && eventRouterSecret ? [
                { name: 'LACIFY_EVENT_SINK', type: 'service', service: `lacify-${projectId}-${environment}-event-router` },
                { name: 'LACIFY_EVENT_ROUTER_SECRET', type: 'secret_text', text: eventRouterSecret },
              ] : []),
              { name: 'LACIFY_TELEMETRY_CREDENTIAL', type: 'secret_text', text: telemetryCredential },
              { name: 'LACIFY_TELEMETRY_URL', type: 'plain_text', text: telemetryBaseUrl },
              { name: 'LACIFY_DEPLOYMENT_ID', type: 'plain_text', text: deploymentId },
              { name: 'LACIFY_RELEASE_ID', type: 'plain_text', text: releaseId },
              { name: 'LACIFY_ENVIRONMENT', type: 'plain_text', text: environment },
              { name: 'LACIFY_TELEMETRY_SAMPLING_RATE', type: 'plain_text', text: String(observabilityPolicy?.sampling_rate ?? 1) },
              { name: 'LACIFY_APPLICATION_ACCESS_POLICY', type: 'secret_text', text: JSON.stringify(applicationAccessPolicy) },
            ],
            ...(newClasses.length > 0 ? {
              migrations: {
                tag: scriptExists ? `release_${release.checksum.slice(0, 16)}` : 'v1',
                new_sqlite_classes: newClasses,
              },
            } : {}),
          }
          form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
          const moduleWorker = generatedWorkerJavaScript(worker)
          form.set('worker.js', new Blob([moduleWorker], { type: 'application/javascript+module' }), 'worker.js')
          const upload = await fetch(scriptEndpoint, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: form })
          if (!upload.ok) throw new Error(await cloudflareErrorMessage(upload))
          const enableSubdomain = await fetch(scriptSubdomainEndpoint, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: true, previews_enabled: true }),
          })
          if (!enableSubdomain.ok) throw new Error(await cloudflareErrorMessage(enableSubdomain))
          const subdomainResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(session.account_id)}/workers/subdomain`, { headers: { authorization: `Bearer ${token}` } })
          const subdomainPayload = await subdomainResponse.json<{ success?: boolean; result?: { subdomain?: string } }>().catch(() => null)
          const subdomain = subdomainPayload?.result?.subdomain
          if (!subdomainResponse.ok || !subdomainPayload?.success || !subdomain) throw new Error('Worker uploaded, but its workers.dev runtime URL could not be resolved.')
          const runtimeUrl = `https://${resourcePlan.workerName}.${subdomain}.workers.dev`
          const deployingLogs = [...logs, deploymentLog('uploaded', `Immutable Worker promoted to ${environmentLabel}.`), deploymentLog('smoke_started', `Running GET ${runtimeUrl}/health.`)]
          await env.DB.prepare('UPDATE deployment_jobs SET status = ?, runtime_url = ?, logs = ?, updated_at = ? WHERE id = ?').bind('deploying', runtimeUrl, JSON.stringify(deployingLogs), now(), deploymentId).run()
          let smokeResponse: Response | null = null
          let smokePayload: { ok?: boolean; deploymentId?: string; releaseId?: string } | null = null
          // A workers.dev hostname can continue serving the previous version
          // briefly after the upload API succeeds. Probe for up to 60 seconds
          // and require the exact immutable deployment identity, rather than
          // declaring a healthy previous version to be the new release.
          for (let attempt = 0; attempt <= 14; attempt += 1) {
            if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(1_000 * attempt, 5_000)))
            smokeResponse = await fetch(`${runtimeUrl}/health?deep=1`, {
              headers: { accept: 'application/json' },
              signal: AbortSignal.timeout(5_000),
            }).catch(() => null)
            smokePayload = smokeResponse
              ? await smokeResponse.json<{ ok?: boolean; deploymentId?: string; releaseId?: string }>().catch(() => null)
              : null
            if (smokeResponse?.ok && smokePayload?.ok === true && smokePayload.deploymentId === deploymentId && smokePayload.releaseId === releaseId) break
          }
          const smokePassed = smokeResponse?.ok === true && smokePayload?.ok === true && smokePayload.deploymentId === deploymentId && smokePayload.releaseId === releaseId
          const smokeStatus = smokeResponse?.status ?? 0
          const smokeCheck = { status: smokePassed ? 'passed' : 'failed', message: smokePassed ? 'Runtime health check passed.' : `Runtime health check failed (${smokeStatus || 'unreachable'}).`, checkedAt: now(), url: `${runtimeUrl}/health` }
          const finalLogs = [...deployingLogs, deploymentLog(smokePassed ? 'smoke_passed' : 'smoke_failed', smokeCheck.message)]
          await env.DB.prepare('UPDATE deployment_jobs SET status = ?, smoke_check = ?, logs = ?, updated_at = ? WHERE id = ?').bind(smokePassed ? 'succeeded' : 'failed', JSON.stringify(smokeCheck), JSON.stringify(finalLogs), now(), deploymentId).run()
          await audit(env, workspaceId, session, `deployment.${environment}.uploaded`, 'deployment', deploymentId, projectId, { releaseId, workerName: resourcePlan.workerName })
          if (telemetryCredentialId) await audit(env, workspaceId, session, 'telemetry.credential.rotated', 'telemetry_credential', telemetryCredentialId, projectId, { deploymentId, environment })
          await audit(env, workspaceId, session, smokePassed ? `deployment.${environment}.succeeded` : `deployment.${environment}.failed`, 'deployment', deploymentId, projectId, { releaseId, runtimeUrl, smokeCheck })
          if (smokePassed && environment === 'production') {
            await env.DB.prepare("UPDATE production_change_requests SET status = 'deployed', deployed_at = ?, updated_at = ? WHERE id = (SELECT change_request_id FROM release_approvals WHERE release_id = ? LIMIT 1)").bind(now(), now(), releaseId).run()
          }
          return respond({ success: smokePassed, message: smokePassed ? undefined : smokeCheck.message, reused: false, deployment: { id: deploymentId, environment, status: smokePassed ? 'succeeded' : 'failed', resourcePlan, runtimeUrl, smokeCheck, logs: finalLogs, createdAt: timestamp } }, smokePassed ? 201 : 422)
        } catch (error) {
          const message = error instanceof Error ? error.message : `${environmentLabel} deployment preflight failed.`
          if (telemetryCredentialId) {
            await env.DB.prepare('UPDATE telemetry_credentials SET revoked_at = ? WHERE id = ?').bind(now(), telemetryCredentialId).run()
            await audit(env, workspaceId, session, 'telemetry.credential.revoked', 'telemetry_credential', telemetryCredentialId, projectId, { deploymentId, reason: 'deployment_failed' })
          }
          const failedLogs = [...logs, deploymentLog('failed', message)]
          await env.DB.prepare('UPDATE deployment_jobs SET status = ?, smoke_check = ?, logs = ?, updated_at = ? WHERE id = ?').bind('failed', JSON.stringify({ status: 'failed', message, checkedAt: now() }), JSON.stringify(failedLogs), now(), deploymentId).run()
          await audit(env, workspaceId, session, `deployment.${environment}.preflight_failed`, 'deployment', deploymentId, projectId, { releaseId, message })
          return respond({ success: false, message, deploymentId }, 422)
        }
      }
    }

    const incidentActionMatch = url.pathname.match(/^\/api\/incidents\/(incident_[A-Za-z0-9_-]+)\/(acknowledge|resolve|note)$/)
    if (incidentActionMatch && request.method === 'POST') {
      const [, incidentId, action] = incidentActionMatch
      const incident = await env.DB.prepare('SELECT id, project_id, status FROM incidents WHERE id = ? AND workspace_id = ?').bind(incidentId, workspaceId).first<{ id: string; project_id: string; status: string }>()
      if (!incident) return respond({ success: false, message: 'Incident not found.' }, 404)
      const body = await requestJson<{ note?: string }>(request); const timestamp = now()
      const nextStatus = action === 'acknowledge' ? 'acknowledged' : action === 'resolve' ? 'resolved' : incident.status
      const message = action === 'note' ? String(body?.note || '').trim().slice(0, 500) : action === 'acknowledge' ? 'Incident acknowledged.' : 'Incident resolved.'
      if (!message) return respond({ success: false, message: 'A note is required.' }, 400)
      await env.DB.batch([
        env.DB.prepare(`UPDATE incidents SET status=?, acknowledged_at=CASE WHEN ?='acknowledged' THEN ? ELSE acknowledged_at END, acknowledged_by=CASE WHEN ?='acknowledged' THEN ? ELSE acknowledged_by END, resolved_at=CASE WHEN ?='resolved' THEN ? ELSE resolved_at END, resolved_by=CASE WHEN ?='resolved' THEN ? ELSE resolved_by END, updated_at=? WHERE id=?`).bind(nextStatus,nextStatus,timestamp,nextStatus,session.account_id,nextStatus,timestamp,nextStatus,session.account_id,timestamp,incidentId),
        env.DB.prepare('INSERT INTO incident_events (id,incident_id,event_type,message,actor_account_id,occurred_at) VALUES (?,?,?,?,?,?)').bind(id('incident_event'),incidentId,action,message,session.account_id,timestamp),
      ])
      await audit(env,workspaceId,session,`incident.${action}`,'incident',incidentId,incident.project_id)
      return respond({ success: true, status: nextStatus })
    }

    if (url.pathname === '/api/observability-settings') {
      if (request.method === 'GET') {
        await env.DB.prepare('INSERT OR IGNORE INTO observability_policies (workspace_id, updated_at) VALUES (?, ?)').bind(workspaceId,now()).run()
        return respond({ success:true, policy: await env.DB.prepare('SELECT * FROM observability_policies WHERE workspace_id=?').bind(workspaceId).first() })
      }
      if (request.method === 'PUT') {
        const body = await requestJson<Record<string,unknown>>(request); const ints = ['rawEventDays','healthSampleDays','metricBucketDays','incidentDays','dailyEventQuota']
        if (!body || ints.some((key) => !Number.isSafeInteger(Number(body[key])) || Number(body[key]) < 1)) return respond({success:false,message:'Retention and quota values must be positive integers.'},400)
        const samplingRate=Number(body.samplingRate); if (!(samplingRate>0&&samplingRate<=1)) return respond({success:false,message:'Sampling rate must be between 0 and 1.'},400)
        await env.DB.prepare(`INSERT INTO observability_policies (workspace_id,raw_event_days,health_sample_days,metric_bucket_days,incident_days,daily_event_quota,sampling_rate,updated_at) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(workspace_id) DO UPDATE SET raw_event_days=excluded.raw_event_days,health_sample_days=excluded.health_sample_days,metric_bucket_days=excluded.metric_bucket_days,incident_days=excluded.incident_days,daily_event_quota=excluded.daily_event_quota,sampling_rate=excluded.sampling_rate,updated_at=excluded.updated_at`)
          .bind(workspaceId,Number(body.rawEventDays),Number(body.healthSampleDays),Number(body.metricBucketDays),Number(body.incidentDays),Number(body.dailyEventQuota),samplingRate,now()).run()
        await audit(env,workspaceId,session,'observability.policy.updated','workspace',workspaceId)
        return respond({success:true})
      }
    }

    if (url.pathname === '/api/aggregate-operations' && request.method === 'GET') {
      const projectId=url.searchParams.get('project')||''; const project=await ownedProject(env,workspaceId,projectId); if(!project)return respond({success:false,message:'Project not found.'},404)
      await ensureObservabilityDefaults(env,workspaceId,projectId)
      const [storage,partitions,incidents,rules,costs,incidentEvents]=await Promise.all([
        env.DB.prepare(`SELECT aggregate_type, environment, storage_bytes, previous_storage_bytes, table_stats, checked_at
          FROM aggregate_storage_latest WHERE project_id = ? ORDER BY storage_bytes DESC`).bind(projectId).all(),
        env.DB.prepare(`SELECT aggregate_type, substr(partition_key_hash, 1, 12) AS partition_hash,
          requests, errors, ROUND(CAST(duration_sum_ms AS REAL) / MAX(requests, 1), 2) AS average_latency_ms,
          sqlite_reads, sqlite_writes
          FROM runtime_partition_activity
          WHERE project_id = ? AND last_seen_at >= ?
          ORDER BY requests DESC LIMIT 100`).bind(projectId,now()-7*86400000).all(),
        env.DB.prepare('SELECT id,rule_id,environment,status,severity,title,summary,opened_at,acknowledged_at,resolved_at,release_id,deployment_id FROM incidents WHERE project_id=? ORDER BY opened_at DESC LIMIT 50').bind(projectId).all(),
        env.DB.prepare('SELECT id,kind,severity,threshold,window_minutes,enabled FROM alert_rules WHERE project_id=? ORDER BY kind').bind(projectId).all(),
        env.DB.prepare('SELECT environment,pricing_version_id,period_start,period_end,observed_usage,estimated_cost,caveats,calculated_at FROM usage_cost_estimates WHERE project_id=? ORDER BY calculated_at DESC').bind(projectId).all(),
        env.DB.prepare('SELECT event.id,event.incident_id,event.event_type,event.message,event.actor_account_id,event.occurred_at FROM incident_events event JOIN incidents incident ON incident.id=event.incident_id WHERE incident.project_id=? ORDER BY event.occurred_at DESC LIMIT 200').bind(projectId).all(),
      ])
      const storageThresholdBytes=1_073_741_824
      return respond({success:true,storage:storage.results.map((r:any)=>{const previous=Number(r.previous_storage_bytes);const growthBytes=r.previous_storage_bytes===null?null:Number(r.storage_bytes)-previous;return{...r,tableStats:JSON.parse(r.table_stats),growthBytes,growthRate:growthBytes===null||!previous?null:growthBytes/previous,thresholdBytes:storageThresholdBytes,warning:Number(r.storage_bytes)>=storageThresholdBytes}}),partitions:partitions.results,incidents:incidents.results.map((incident:any)=>({...incident,events:incidentEvents.results.filter((event:any)=>event.incident_id===incident.id)})),rules:rules.results,costs:costs.results.map((r:any)=>{const estimatedCost=JSON.parse(r.estimated_cost);const elapsedDays=Math.max(1,(Number(r.period_end)-Number(r.period_start))/86400000);return{...r,observedUsage:JSON.parse(r.observed_usage),estimatedCost:{...estimatedCost,dailyUsd:estimatedCost.totalUsd/elapsedDays,projectedMonthlyUsd:estimatedCost.totalUsd/elapsedDays*30.4375,previousPeriodChange:null},caveats:[...JSON.parse(r.caveats),'Previous-period change is unavailable until a complete prior billing period exists.']}})})
    }

    if (url.pathname === '/api/telemetry-export' && request.method === 'GET') {
      const projectId=url.searchParams.get('project')||''; const project=await ownedProject(env,workspaceId,projectId); if(!project)return respond({success:false,message:'Project not found.'},404)
      const format=url.searchParams.get('format')==='csv'?'csv':'json'; const conditions=['workspace_id=?','project_id=?']; const bindings:Array<string|number>=[workspaceId,projectId]
      const exportRange=url.searchParams.get('range')||'30d'; const rangeMs:Record<string,number>={'1h':3600000,'24h':86400000,'7d':604800000,'30d':2592000000}; if(!rangeMs[exportRange])return respond({success:false,message:'Export range is invalid.'},400);conditions.push('occurred_at>=?');bindings.push(now()-rangeMs[exportRange])
      for(const [column,param] of [['environment','environment'],['release_id','release'],['aggregate_type','aggregate'],['action','action']] as const){const value=url.searchParams.get(param);if(value){conditions.push(`${column}=?`);bindings.push(value)}}
      const rows=await env.DB.prepare(`SELECT release_id,deployment_id,environment,aggregate_type,action,outcome,status_code,duration_ms,sqlite_reads,sqlite_writes,occurred_at FROM runtime_telemetry_events WHERE ${conditions.join(' AND ')} ORDER BY occurred_at DESC LIMIT 10000`).bind(...bindings).all()
      await audit(env,workspaceId,session,'telemetry.exported','project',projectId,projectId,{format,count:rows.results.length})
      if(format==='json')return respond({success:true,events:rows.results})
      const columns=['release_id','deployment_id','environment','aggregate_type','action','outcome','status_code','duration_ms','sqlite_reads','sqlite_writes','occurred_at']; const escape=(v:unknown)=>`"${String(v??'').replace(/"/g,'""')}"`; const csv=[columns.join(','),...rows.results.map((row:any)=>columns.map((column)=>escape(row[column])).join(','))].join('\n')
      return withCors(request,new Response(csv,{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':`attachment; filename="${projectId}-telemetry.csv"`}}),env)
    }

    if (url.pathname === '/api/runtime-metrics' && request.method === 'GET') {
      const projectId = url.searchParams.get('project') || ''
      if (!projectId) return respond({ success: false, message: 'project is required' }, 400)
      const project = await ownedProject(env, workspaceId, projectId)
      if (!project) return respond({ success: false, message: 'Project not found.' }, 404)
      const ranges: Record<string, number> = { '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000, '30d': 30 * 24 * 60 * 60 * 1000 }
      const range = url.searchParams.get('range') || '24h'
      if (!ranges[range]) return respond({ success: false, message: 'Choose a supported metrics time range.' }, 400)
      const environment = url.searchParams.get('environment') || ''
      const releaseId = url.searchParams.get('release') || ''
      const aggregateType = url.searchParams.get('aggregate') || ''
      const action = url.searchParams.get('action') || ''
      if (environment && environment !== 'dev' && environment !== 'staging' && environment !== 'production') return respond({ success: false, message: 'Metrics environment is invalid.' }, 400)
      if (releaseId && !/^release_[a-f0-9]{24}$/.test(releaseId)) return respond({ success: false, message: 'Metrics release is invalid.' }, 400)
      if (aggregateType && !identifier.test(aggregateType)) return respond({ success: false, message: 'Metrics aggregate type is invalid.' }, 400)
      if (action && !identifier.test(action)) return respond({ success: false, message: 'Metrics command is invalid.' }, 400)
      const to = now()
      const from = to - ranges[range]
      const conditions = ['workspace_id = ?', 'project_id = ?', 'bucket_start >= ?', 'bucket_start <= ?']
      const bindings: Array<string | number> = [workspaceId, projectId, metricBucketStart(from), metricBucketStart(to)]
      for (const [column, value] of [['environment', environment], ['release_id', releaseId], ['aggregate_type', aggregateType], ['action', action]] as const) {
        if (value) { conditions.push(`${column} = ?`); bindings.push(value) }
      }
      const rows = await env.DB.prepare(`SELECT bucket_start, release_id, deployment_id, environment, aggregate_type, action,
        request_count, success_count, error_count, duration_sum_ms, duration_min_ms, duration_max_ms,
        duration_b0, duration_b1, duration_b2, duration_b3, duration_b4, duration_b5,
        duration_b6, duration_b7, duration_b8, duration_b9, duration_b10
        FROM runtime_metric_buckets WHERE ${conditions.join(' AND ')} ORDER BY bucket_start`).bind(...bindings).all<MetricBucketRow>()
      const summary = summarizeMetricRows(rows.results)
      const seriesGroups = new Map<number, MetricBucketRow[]>()
      const commandGroups = new Map<string, MetricBucketRow[]>()
      for (const row of rows.results) {
        seriesGroups.set(row.bucket_start, [...(seriesGroups.get(row.bucket_start) || []), row])
        const key = `${row.aggregate_type}:${row.action}`
        commandGroups.set(key, [...(commandGroups.get(key) || []), row])
      }
      const series = [...seriesGroups.entries()].map(([bucketStart, grouped]) => ({ bucketStart, ...summarizeMetricRows(grouped) }))
      const commands = [...commandGroups.entries()].map(([key, grouped]) => {
        const first = grouped[0]
        return { key, aggregateType: first.aggregate_type, action: first.action, ...summarizeMetricRows(grouped) }
      }).sort((left, right) => right.requests - left.requests || right.errors - left.errors || (right.p95LatencyMs || 0) - (left.p95LatencyMs || 0))
      return respond({
        success: true,
        filters: { range, environment: environment || null, releaseId: releaseId || null, aggregateType: aggregateType || null, action: action || null, from, to },
        summary,
        series,
        commands,
        availability: { wallTime: 'observed', cpuTime: 'unavailable', percentiles: 'bounded-histogram-approximation' },
      })
    }

    if (url.pathname === '/api/monitor-overview' && request.method === 'GET') {
      const projectId = url.searchParams.get('project')
      if (!projectId) return respond({ success: false, message: 'project is required' }, 400)
      const project = await ownedProject(env, workspaceId, projectId)
      if (!project) return respond({ success: false, message: 'Project not found.' }, 404)
      await sampleRuntimeHealth(env, projectId)
      const [contracts, deployments, events, healthSamples] = await Promise.all([
        env.DB.prepare('SELECT id, document, revision, updated_at FROM contracts WHERE project_id = ?').bind(projectId).all(),
        env.DB.prepare(`SELECT dj.id, dj.release_id, dj.environment, dj.status, dj.runtime_url, dj.smoke_check, dj.logs, dj.updated_at, r.checksum
          FROM deployment_jobs dj JOIN releases r ON r.id = dj.release_id
          WHERE dj.project_id = ? ORDER BY dj.updated_at DESC LIMIT 20`).bind(projectId).all(),
        env.DB.prepare('SELECT aggregate_type AS object_id, action, level, message, occurred_at FROM runtime_telemetry_events WHERE project_id = ? ORDER BY occurred_at DESC LIMIT 50').bind(projectId).all(),
        env.DB.prepare(`SELECT deployment_id, release_id, environment, layer, aggregate_type, status, latency_ms, status_code, endpoint, message, checked_at
          FROM runtime_health_samples rhs
          WHERE project_id = ? AND checked_at = (SELECT MAX(newest.checked_at) FROM runtime_health_samples newest WHERE newest.deployment_id = rhs.deployment_id)
          ORDER BY checked_at DESC, layer`).bind(projectId).all(),
      ])
      const deploymentRows = deployments.results as Array<Record<string, unknown>>
      const healthRows = healthSamples.results as Array<Record<string, unknown>>
      const environments = (['dev', 'staging', 'production'] as const).map((environment) => {
        const deployment = deploymentRows.find((row) => row.environment === environment)
        if (!deployment) return { environment, status: 'unknown', stale: true, deployment: null, layers: [], lastSuccessAt: null, lastFailure: null }
        const layers = healthRows.filter((row) => row.deployment_id === deployment.id).map((row) => ({
          layer: row.layer,
          aggregateType: row.aggregate_type,
          status: row.status,
          latencyMs: row.latency_ms,
          statusCode: row.status_code,
          endpoint: row.endpoint,
          message: row.message,
          checkedAt: row.checked_at,
        }))
        const newestSampleAt = layers.reduce((latest, layer) => Math.max(latest, Number(layer.checkedAt) || 0), 0)
        const stale = !newestSampleAt || newestSampleAt < now() - healthStaleAfterMs
        const deploymentStatus = String(deployment.status)
        const layerNames = new Set(layers.map((layer) => layer.layer))
        const complete = layerNames.has('worker') && layerNames.has('durable_object') && layerNames.has('sqlite')
        const workerFailed = layers.some((layer) => layer.layer === 'worker' && layer.status === 'unhealthy')
        const componentFailed = layers.some((layer) => layer.status === 'unhealthy')
        const status = deploymentStatus === 'provisioning' || deploymentStatus === 'deploying'
          ? 'deploying'
          : deploymentStatus === 'failed' || workerFailed
            ? 'unhealthy'
            : stale || !complete
              ? 'unknown'
              : componentFailed
                ? 'degraded'
                : 'healthy'
        const failedLayer = layers.find((layer) => layer.status === 'unhealthy')
        const logs = typeof deployment.logs === 'string' ? JSON.parse(deployment.logs) as Array<{ event?: string; message?: string; at?: number }> : []
        const failedLog = [...logs].reverse().find((entry) => entry.event?.includes('failed'))
        return {
          environment,
          status,
          stale,
          deployment: { id: deployment.id, releaseId: deployment.release_id, checksum: deployment.checksum, status: deployment.status, runtimeUrl: deployment.runtime_url, updatedAt: deployment.updated_at },
          layers,
          lastSuccessAt: status === 'healthy' ? newestSampleAt : null,
          lastFailure: failedLayer ? { message: failedLayer.message, layer: failedLayer.layer, aggregateType: failedLayer.aggregateType, occurredAt: failedLayer.checkedAt } : failedLog ? { message: failedLog.message, layer: 'deployment', aggregateType: null, occurredAt: failedLog.at } : null,
        }
      })
      return respond({
        success: true,
        contracts: contracts.results,
        deployments: deploymentRows.map((deployment) => {
          const row = deployment as Record<string, unknown>
          return {
            id: row.id,
            releaseId: row.release_id,
            checksum: row.checksum,
            environment: row.environment,
            status: row.status,
            runtimeUrl: row.runtime_url,
            smokeCheck: typeof row.smoke_check === 'string' ? JSON.parse(row.smoke_check) : null,
            updatedAt: row.updated_at,
          }
        }),
        environments,
        events: events.results.map((event) => {
          const row = event as Record<string, unknown>
          return { objectId: row.object_id, action: row.action, level: row.level, message: row.message, occurredAt: row.occurred_at }
        }),
      })
    }

    return respond({ success: false, message: 'Not found' }, 404)
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const isRetentionRun = controller.cron === '17 3 * * *'
    const tasks: Promise<unknown>[] = isRetentionRun ? [enforceRetention(env)] : [sampleRuntimeHealth(env)]
    if (!isRetentionRun && Math.floor(controller.scheduledTime / 60_000) % 15 === 0) tasks.push(evaluateAlerts(env))
    ctx.waitUntil(Promise.all(tasks).then(() => undefined))
  },
}
