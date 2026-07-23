import { createHash, randomUUID } from 'node:crypto'

const migrationIdPattern = /^(\d{4})_[a-z0-9][a-z0-9_]{0,62}$/

function checksum(sql) {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n').trim() + '\n').digest('hex')
}

function splitStatements(source) {
  const statements = []
  let current = ''
  let quote = null
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    const next = source[index + 1]
    if (lineComment) {
      current += character
      if (character === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      current += character
      if (character === '*' && next === '/') {
        current += next
        index += 1
        blockComment = false
      }
      continue
    }
    if (!quote && character === '-' && next === '-') {
      current += `${character}${next}`
      index += 1
      lineComment = true
      continue
    }
    if (!quote && character === '/' && next === '*') {
      current += `${character}${next}`
      index += 1
      blockComment = true
      continue
    }
    if (quote) {
      current += character
      if (character === quote) {
        if (next === quote) {
          current += next
          index += 1
        } else {
          quote = null
        }
      }
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      current += character
      continue
    }
    if (character === ';') {
      if (current.trim()) statements.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  if (current.trim()) statements.push(current.trim())
  return statements
}

function executableSql(statement) {
  return statement
    .replace(/^\s*(?:(?:--[^\n]*\n)|(?:\/\*[\s\S]*?\*\/))*/g, '')
    .trim()
}

export function classifyMigrationSql(sql) {
  const operations = splitStatements(sql).map((raw) => {
    const statement = executableSql(raw)
    let classification = 'unsupported'
    if (/^(CREATE\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX|ALTER\s+TABLE\s+\S+\s+ADD\s+COLUMN)\b/i.test(statement)) classification = 'additive'
    else if (/^(INSERT\s+INTO|UPDATE\s+)\b/i.test(statement)) classification = 'data-changing'
    else if (/^(DROP|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE.+\b(?:DROP|RENAME)\b)\b/i.test(statement)) classification = 'destructive'
    return { classification, statement: statement.replace(/\s+/g, ' ').slice(0, 240) }
  })
  const classes = new Set(operations.map((operation) => operation.classification))
  const classification = ['unsupported', 'destructive', 'data-changing', 'additive'].find((candidate) => classes.has(candidate)) || 'unsupported'
  return { classification, operations }
}

export function createMigrationLedger(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _lacify_migrations (
      actor TEXT NOT NULL,
      migration_id TEXT NOT NULL,
      checksum TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('applying', 'applied', 'failed')),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      release_id TEXT NOT NULL,
      recovery_bookmark TEXT NOT NULL,
      error TEXT,
      PRIMARY KEY (actor, migration_id)
    );
  `)
}

export function readMigrationLedger(database, actor) {
  createMigrationLedger(database)
  return database.prepare(`
    SELECT actor, migration_id AS id, checksum, status, started_at AS startedAt,
      finished_at AS finishedAt, release_id AS releaseId,
      recovery_bookmark AS recoveryBookmark, error
    FROM _lacify_migrations
    WHERE actor = ?
    ORDER BY migration_id
  `).all(actor)
}

function validateMigrationSequence(migrations) {
  const issues = []
  const seenIds = new Set()
  let previousNumber = 0
  for (const migration of migrations) {
    const match = migrationIdPattern.exec(migration.id)
    if (!match) {
      issues.push({ code: 'migration_id', migrationId: migration.id, message: 'Migration ID must match NNNN_lowercase_name.' })
      continue
    }
    if (seenIds.has(migration.id)) issues.push({ code: 'duplicate_migration', migrationId: migration.id, message: 'Migration ID is duplicated.' })
    seenIds.add(migration.id)
    const number = Number(match[1])
    if (number <= previousNumber) issues.push({ code: 'out_of_order', migrationId: migration.id, message: 'Migration IDs must be strictly increasing.' })
    previousNumber = number
  }
  return issues
}

export function planMigrations({ actor, migrations, ledger = [], releaseId, environmentRevision = null, projectFingerprint = null }) {
  const sorted = [...migrations]
  const issues = validateMigrationSequence(sorted)
  const repositoryById = new Map(sorted.map((migration) => [migration.id, migration]))
  const ledgerById = new Map(ledger.map((migration) => [migration.id, migration]))

  for (const applied of ledger) {
    const local = repositoryById.get(applied.id)
    if (!local) issues.push({ code: 'missing_applied_migration', migrationId: applied.id, message: 'An applied migration is missing from the repository.' })
    else if (checksum(local.sql) !== applied.checksum) issues.push({ code: 'edited_applied_migration', migrationId: applied.id, message: 'An applied migration checksum differs from the repository file.' })
    if (applied.status === 'failed') issues.push({ code: 'failed_migration', migrationId: applied.id, message: 'A previous migration failed and requires recovery before another apply.' })
    if (applied.status === 'applying') issues.push({ code: 'incomplete_migration', migrationId: applied.id, message: 'A previous migration has an ambiguous applying state and requires recovery.' })
  }

  const highestApplied = ledger
    .filter((entry) => entry.status === 'applied')
    .map((entry) => Number(migrationIdPattern.exec(entry.id)?.[1] || 0))
    .reduce((maximum, value) => Math.max(maximum, value), 0)

  const pending = sorted
    .filter((migration) => !ledgerById.has(migration.id))
    .map((migration) => {
      const analysis = classifyMigrationSql(migration.sql)
      const number = Number(migrationIdPattern.exec(migration.id)?.[1] || 0)
      if (number <= highestApplied) issues.push({ code: 'out_of_order', migrationId: migration.id, message: 'New migration sorts before an applied migration.' })
      if (analysis.classification === 'destructive' || analysis.classification === 'unsupported') {
        issues.push({ code: `${analysis.classification}_migration`, migrationId: migration.id, message: `Default apply blocks ${analysis.classification} SQL.` })
      }
      return { id: migration.id, checksum: checksum(migration.sql), sql: migration.sql, ...analysis }
    })

  const planInput = {
    actor,
    environmentRevision,
    projectFingerprint,
    releaseId,
    migrations: pending.map(({ id, checksum: value, classification }) => ({ id, checksum: value, classification })),
  }
  return {
    actor,
    valid: issues.length === 0,
    issues,
    pending,
    alreadyApplied: ledger.filter((entry) => entry.status === 'applied').map((entry) => entry.id),
    environmentRevision,
    projectFingerprint,
    releaseId,
    planId: createHash('sha256').update(JSON.stringify(planInput)).digest('hex'),
  }
}

export function applyMigrationPlan(database, plan, { now = () => new Date().toISOString(), createRecoveryBookmark = () => randomUUID() } = {}) {
  if (!plan.valid) throw new Error('Cannot apply an invalid migration plan.')
  createMigrationLedger(database)
  const results = []
  const applicable = []
  for (const migration of plan.pending) {
    const existing = database.prepare('SELECT checksum, status FROM _lacify_migrations WHERE actor = ? AND migration_id = ?').get(plan.actor, migration.id)
    if (existing?.status === 'applied' && existing.checksum === migration.checksum) {
      results.push({ id: migration.id, status: 'already-applied' })
      continue
    }
    if (existing) throw new Error(`Migration ${migration.id} has an existing ${existing.status} ledger entry.`)
    applicable.push(migration)
  }
  preflightMigrationPlan(database, { ...plan, pending: applicable })

  for (const migration of applicable) {
    const startedAt = now()
    const recoveryBookmark = createRecoveryBookmark({ actor: plan.actor, migrationId: migration.id, planId: plan.planId })
    database.prepare(`
      INSERT INTO _lacify_migrations
        (actor, migration_id, checksum, status, started_at, release_id, recovery_bookmark)
      VALUES (?, ?, ?, 'applying', ?, ?, ?)
    `).run(plan.actor, migration.id, migration.checksum, startedAt, plan.releaseId, recoveryBookmark)

    try {
      database.exec('BEGIN IMMEDIATE')
      for (const operation of migration.operations) database.exec(`${operation.statement};`)
      database.prepare(`
        UPDATE _lacify_migrations SET status = 'applied', finished_at = ?, error = NULL
        WHERE actor = ? AND migration_id = ?
      `).run(now(), plan.actor, migration.id)
      database.exec('COMMIT')
      results.push({ id: migration.id, status: 'applied', recoveryBookmark })
    } catch (error) {
      try { database.exec('ROLLBACK') } catch {}
      database.prepare(`
        UPDATE _lacify_migrations SET status = 'failed', finished_at = ?, error = ?
        WHERE actor = ? AND migration_id = ?
      `).run(now(), error instanceof Error ? error.message.slice(0, 1000) : 'Unknown migration error', plan.actor, migration.id)
      const failure = new Error(`Migration ${migration.id} failed. Restore recovery bookmark ${recoveryBookmark} before retrying.`)
      failure.cause = error
      failure.recoveryBookmark = recoveryBookmark
      throw failure
    }
  }
  return results
}

export function preflightMigrationPlan(database, plan) {
  if (!plan.valid) return { compatible: false, error: 'Migration plan is invalid.' }
  try {
    database.exec('SAVEPOINT lacify_preflight')
    for (const migration of plan.pending) {
      for (const operation of migration.operations) database.exec(`${operation.statement};`)
    }
    database.exec('ROLLBACK TO lacify_preflight')
    database.exec('RELEASE lacify_preflight')
    return { compatible: true, error: null }
  } catch (error) {
    try { database.exec('ROLLBACK TO lacify_preflight'); database.exec('RELEASE lacify_preflight') } catch {}
    const message = error instanceof Error ? error.message : 'Unknown schema compatibility failure.'
    const failure = new Error(`Migration preflight failed without mutation: ${message}`)
    failure.cause = error
    throw failure
  }
}

export function introspectActorSchema(database) {
  const objects = database.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND name <> '_lacify_migrations'
    ORDER BY type, name
  `).all()
  const tables = objects
    .filter((object) => object.type === 'table')
    .map((table) => ({
      name: table.name,
      columns: database.prepare(`PRAGMA table_info("${table.name.replaceAll('"', '""')}")`).all()
        .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notNull: Boolean(notnull), defaultValue: dflt_value, primaryKey: Boolean(pk) })),
    }))
  return { objects, tables, fingerprint: checksum(JSON.stringify({ objects, tables })) }
}

export const migrationEngine = Object.freeze({ checksum, splitStatements })
