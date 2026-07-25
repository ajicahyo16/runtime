import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load, JSON_SCHEMA } from 'js-yaml'

const projectKeys = new Set(['version', 'project', 'runtime', 'actors'])
const actorKeys = new Set(['version', 'name', 'description', 'partitionBy', 'storage', 'commands', 'operations', 'stateMachines', 'summaries', 'secretRefs'])
const operationKeys = new Set(['version', 'name', 'kind', 'sql', 'input', 'result', 'emits'])
const operationInputKeys = new Set(['type', 'required'])
const operationResultKeys = new Set(['mode', 'maxRows', 'fields', 'pagination'])
const operationResultFieldKeys = new Set(['type', 'nullable'])
const operationPaginationKeys = new Set(['cursorField', 'defaultPageSize', 'maxPageSize'])
const operationEmitKeys = new Set(['event', 'target', 'durability', 'fields', 'reporting', 'realtime'])
const operationReportingKeys = new Set(['keyField', 'sequenceField', 'dimensions', 'measures'])
const operationMeasureKeys = new Set(['field', 'aggregate'])
const operationRealtimeKeys = new Set(['roomClass', 'roomField'])
const stateMachineKeys = new Set(['name', 'initial', 'states', 'transitions'])
const transitionKeys = new Set(['command', 'from', 'to'])
const summaryKeys = new Set(['name', 'period', 'sourceTable'])
const projectIdPattern = /^[a-z0-9][a-z0-9-_]{0,62}$/
const actorNamePattern = /^[A-Z][A-Za-z0-9]{0,62}$/
const fieldNamePattern = /^[a-z][A-Za-z0-9]{0,62}$/
const commandPattern = /^[A-Z][A-Za-z0-9]{0,62}$/
const sqlNamePattern = /^[a-z][a-z0-9_]{0,62}$/
const secretPattern = /^[A-Z][A-Z0-9_]{0,62}$/
const actorPathPattern = /^\.\/actors\/[a-z0-9][a-z0-9-_]{0,62}\/actor\.yaml$/
const operationPathPattern = /^\.\/operations\/[a-z0-9][a-z0-9-]{0,62}\.operation\.yaml$/
const operationSqlPathPattern = /^\.\/[a-z0-9][a-z0-9-]{0,62}\.sql$/
const migrationNamePattern = /^\d{4}_[a-z0-9][a-z0-9_]{0,62}\.sql$/
const maxYamlBytes = 256 * 1024
const maxMigrationBytes = 1024 * 1024
const maxOperationSqlBytes = 64 * 1024
const maxDevelopmentSeedBytes = 1024 * 1024
const runtimeOperationParameters = new Set(['partitionId', 'now', 'commandId', 'cursor', 'pageSize'])

function issue(file, pathName, code, message, line = null) {
  return { file, path: pathName, line, code, message }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unknownKeys(value, allowed, file, pathName, issues) {
  if (!isRecord(value)) return
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(issue(file, pathName ? `${pathName}.${key}` : key, 'unknown_field', `Unknown field "${key}".`))
  }
}

function attachSourceLines(entries, source) {
  const lines = source.split(/\r?\n/)
  return entries.map((entry) => {
    if (entry.line !== null) return entry
    const keys = entry.path.split('.').filter((part) => part && !/^\d+$/.test(part))
    for (const key of keys.reverse()) {
      const line = lines.findIndex((candidate) => new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(candidate))
      if (line >= 0) return { ...entry, line: line + 1 }
    }
    return { ...entry, line: 1 }
  })
}

function duplicateStrings(values) {
  if (!Array.isArray(values)) return []
  const seen = new Set()
  const duplicates = new Set()
  for (const value of values) {
    if (typeof value !== 'string') continue
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates]
}

export function parseYaml(source, file = '<memory>') {
  if (Buffer.byteLength(source, 'utf8') > maxYamlBytes) {
    return { value: null, issues: [issue(file, '', 'file_too_large', `YAML files are limited to ${maxYamlBytes} bytes.`)] }
  }
  try {
    const value = load(source, { schema: JSON_SCHEMA, filename: file })
    if (!isRecord(value)) return { value: null, issues: [issue(file, '', 'document_type', 'Document root must be an object.')] }
    return { value, issues: [] }
  } catch (error) {
    const line = Number.isSafeInteger(error?.mark?.line) ? error.mark.line + 1 : null
    return { value: null, issues: [issue(file, '', 'yaml_syntax', error instanceof Error ? error.message.split('\n')[0] : 'Invalid YAML.', line)] }
  }
}

export function validateRuntimeDocument(value, file = 'lacify.runtime.yaml') {
  const issues = []
  if (!isRecord(value)) return [issue(file, '', 'document_type', 'Runtime document must be an object.')]
  unknownKeys(value, projectKeys, file, '', issues)
  if (value.version !== 'lacify.dev/v1') issues.push(issue(file, 'version', 'version', 'Version must be "lacify.dev/v1".'))
  if (typeof value.project !== 'string' || !projectIdPattern.test(value.project)) issues.push(issue(file, 'project', 'identifier', 'Project must use 1–63 lowercase letters, numbers, hyphens, or underscores.'))
  if (value.runtime !== 'request-response') issues.push(issue(file, 'runtime', 'runtime_mode', 'Runtime v1 supports only "request-response".'))
  if (!Array.isArray(value.actors) || value.actors.length < 1 || value.actors.length > 64) {
    issues.push(issue(file, 'actors', 'array_size', 'Actors must contain between 1 and 64 file references.'))
  } else {
    value.actors.forEach((actorPath, index) => {
      if (typeof actorPath !== 'string' || !actorPathPattern.test(actorPath)) issues.push(issue(file, `actors.${index}`, 'actor_path', 'Actor paths must match ./actors/<actor-id>/actor.yaml.'))
    })
    for (const duplicate of duplicateStrings(value.actors)) issues.push(issue(file, 'actors', 'duplicate', `Actor path "${duplicate}" is duplicated.`))
  }
  return issues
}

export function validateActorDocument(value, file = 'actor.yaml') {
  const issues = []
  if (!isRecord(value)) return [issue(file, '', 'document_type', 'Actor document must be an object.')]
  unknownKeys(value, actorKeys, file, '', issues)
  if (value.version !== 'lacify.dev/actor/v1') issues.push(issue(file, 'version', 'version', 'Version must be "lacify.dev/actor/v1".'))
  if (typeof value.name !== 'string' || !actorNamePattern.test(value.name)) issues.push(issue(file, 'name', 'identifier', 'Actor name must be a PascalCase identifier with at most 63 characters.'))
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length < 1 || value.description.length > 500)) issues.push(issue(file, 'description', 'string_size', 'Description must contain 1–500 characters.'))
  if (typeof value.partitionBy !== 'string' || !fieldNamePattern.test(value.partitionBy)) issues.push(issue(file, 'partitionBy', 'identifier', 'Partition key must be a lower-camel-case identifier.'))
  if (value.storage !== 'sqlite') issues.push(issue(file, 'storage', 'storage', 'Runtime v1 Actor storage must be "sqlite".'))
  if (!Array.isArray(value.commands) || value.commands.length < 1 || value.commands.length > 128) {
    issues.push(issue(file, 'commands', 'array_size', 'Commands must contain between 1 and 128 command names.'))
  } else {
    value.commands.forEach((command, index) => {
      if (typeof command !== 'string' || !commandPattern.test(command)) issues.push(issue(file, `commands.${index}`, 'identifier', 'Command names must be PascalCase identifiers.'))
    })
    for (const duplicate of duplicateStrings(value.commands)) issues.push(issue(file, 'commands', 'duplicate', `Command "${duplicate}" is duplicated.`))
  }

  if (value.operations !== undefined && !Array.isArray(value.operations)) {
    issues.push(issue(file, 'operations', 'array', 'Operations must be an array of operation file references.'))
  } else {
    ;(value.operations || []).forEach((operationPath, index) => {
      if (typeof operationPath !== 'string' || !operationPathPattern.test(operationPath)) issues.push(issue(file, `operations.${index}`, 'operation_path', 'Operation paths must match ./operations/<operation-id>.operation.yaml.'))
    })
    for (const duplicate of duplicateStrings(value.operations)) issues.push(issue(file, 'operations', 'duplicate', `Operation path "${duplicate}" is duplicated.`))
  }

  const commands = new Set(Array.isArray(value.commands) ? value.commands.filter((item) => typeof item === 'string') : [])
  const stateMachineNames = []
  if (value.stateMachines !== undefined && !Array.isArray(value.stateMachines)) {
    issues.push(issue(file, 'stateMachines', 'array', 'State machines must be an array.'))
  } else {
    for (const [index, machine] of (value.stateMachines || []).entries()) {
      const base = `stateMachines.${index}`
      if (!isRecord(machine)) {
        issues.push(issue(file, base, 'object', 'State machine must be an object.'))
        continue
      }
      unknownKeys(machine, stateMachineKeys, file, base, issues)
      if (typeof machine.name !== 'string' || !actorNamePattern.test(machine.name)) issues.push(issue(file, `${base}.name`, 'identifier', 'State machine name must be a PascalCase identifier.'))
      else stateMachineNames.push(machine.name)
      if (!Array.isArray(machine.states) || machine.states.length < 2 || machine.states.length > 64) issues.push(issue(file, `${base}.states`, 'array_size', 'State machine must have 2–64 states.'))
      const states = new Set(Array.isArray(machine.states) ? machine.states.filter((state) => typeof state === 'string') : [])
      for (const duplicate of duplicateStrings(machine.states)) issues.push(issue(file, `${base}.states`, 'duplicate', `State "${duplicate}" is duplicated.`))
      if (typeof machine.initial !== 'string' || !states.has(machine.initial)) issues.push(issue(file, `${base}.initial`, 'state_reference', 'Initial state must reference a declared state.'))
      if (!Array.isArray(machine.transitions) || machine.transitions.length < 1 || machine.transitions.length > 256) {
        issues.push(issue(file, `${base}.transitions`, 'array_size', 'State machine must have 1–256 transitions.'))
      } else {
        machine.transitions.forEach((transition, transitionIndex) => {
          const transitionPath = `${base}.transitions.${transitionIndex}`
          if (!isRecord(transition)) {
            issues.push(issue(file, transitionPath, 'object', 'Transition must be an object.'))
            return
          }
          unknownKeys(transition, transitionKeys, file, transitionPath, issues)
          if (!commands.has(transition.command)) issues.push(issue(file, `${transitionPath}.command`, 'command_reference', 'Transition command must reference a declared Actor command.'))
          if (!states.has(transition.from)) issues.push(issue(file, `${transitionPath}.from`, 'state_reference', 'Transition source must reference a declared state.'))
          if (!states.has(transition.to)) issues.push(issue(file, `${transitionPath}.to`, 'state_reference', 'Transition target must reference a declared state.'))
        })
      }
    }
  }
  for (const duplicate of duplicateStrings(stateMachineNames)) issues.push(issue(file, 'stateMachines', 'duplicate', `State machine "${duplicate}" is duplicated.`))

  const summaryNames = []
  if (value.summaries !== undefined && !Array.isArray(value.summaries)) {
    issues.push(issue(file, 'summaries', 'array', 'Summaries must be an array.'))
  } else {
    for (const [index, summary] of (value.summaries || []).entries()) {
      const base = `summaries.${index}`
      if (!isRecord(summary)) {
        issues.push(issue(file, base, 'object', 'Summary must be an object.'))
        continue
      }
      unknownKeys(summary, summaryKeys, file, base, issues)
      if (typeof summary.name !== 'string' || !sqlNamePattern.test(summary.name)) issues.push(issue(file, `${base}.name`, 'identifier', 'Summary name must be a lowercase SQL identifier.'))
      else summaryNames.push(summary.name)
      if (!['daily', 'monthly', 'yearly'].includes(summary.period)) issues.push(issue(file, `${base}.period`, 'period', 'Summary period must be daily, monthly, or yearly.'))
      if (typeof summary.sourceTable !== 'string' || !sqlNamePattern.test(summary.sourceTable)) issues.push(issue(file, `${base}.sourceTable`, 'identifier', 'Summary source table must be a lowercase SQL identifier.'))
    }
  }
  for (const duplicate of duplicateStrings(summaryNames)) issues.push(issue(file, 'summaries', 'duplicate', `Summary "${duplicate}" is duplicated.`))

  if (value.secretRefs !== undefined && !Array.isArray(value.secretRefs)) {
    issues.push(issue(file, 'secretRefs', 'array', 'Secret references must be an array.'))
  } else {
    ;(value.secretRefs || []).forEach((secret, index) => {
      if (typeof secret !== 'string' || !secretPattern.test(secret)) issues.push(issue(file, `secretRefs.${index}`, 'secret_name', 'Secret references must use uppercase letters, numbers, and underscores.'))
    })
    for (const duplicate of duplicateStrings(value.secretRefs)) issues.push(issue(file, 'secretRefs', 'duplicate', `Secret reference "${duplicate}" is duplicated.`))
  }
  return issues
}

export function validateOperationDocument(value, declaredCommands = [], file = 'operation.yaml') {
  const issues = []
  if (!isRecord(value)) return [issue(file, '', 'document_type', 'Operation document must be an object.')]
  unknownKeys(value, operationKeys, file, '', issues)
  if (value.version !== 'lacify.dev/operation/v1') issues.push(issue(file, 'version', 'version', 'Version must be "lacify.dev/operation/v1".'))
  if (typeof value.name !== 'string' || !commandPattern.test(value.name)) issues.push(issue(file, 'name', 'identifier', 'Operation name must be a PascalCase identifier with at most 63 characters.'))
  if (!['command', 'query'].includes(value.kind)) issues.push(issue(file, 'kind', 'operation_kind', 'Operation kind must be "command" or "query".'))
  if (typeof value.sql !== 'string' || !operationSqlPathPattern.test(value.sql)) issues.push(issue(file, 'sql', 'sql_path', 'SQL path must match ./<operation-id>.sql.'))
  if (value.kind === 'command' && typeof value.name === 'string' && !declaredCommands.includes(value.name)) {
    issues.push(issue(file, 'name', 'command_reference', `Command operation "${value.name}" must reference a command declared by its Actor.`))
  }
  if (value.emits !== undefined) {
    if (value.kind !== 'command') issues.push(issue(file, 'emits', 'operation_kind', 'Only command operations may emit outbox events.'))
    if (!Array.isArray(value.emits) || value.emits.length < 1 || value.emits.length > 16) issues.push(issue(file, 'emits', 'array_size', 'Emits must contain between 1 and 16 event declarations.'))
    else {
      const names = new Set()
      value.emits.forEach((emit, index) => {
        const base = `emits.${index}`
        if (!isRecord(emit)) { issues.push(issue(file, base, 'object', 'Emit declaration must be an object.')); return }
        unknownKeys(emit, operationEmitKeys, file, base, issues)
        if (typeof emit.event !== 'string' || !commandPattern.test(emit.event)) issues.push(issue(file, `${base}.event`, 'identifier', 'Emitted event must be a PascalCase identifier.'))
        if (!['realtime', 'reporting', 'archive'].includes(emit.target)) issues.push(issue(file, `${base}.target`, 'event_target', 'Event target must be realtime, reporting, or archive.'))
        if (!['segmented', 'immediate'].includes(emit.durability)) issues.push(issue(file, `${base}.durability`, 'durability', 'Outbox durability must be segmented or immediate.'))
        if (!Array.isArray(emit.fields) || emit.fields.length < 1 || emit.fields.length > 32 || emit.fields.some((field) => typeof field !== 'string' || !fieldNamePattern.test(field))) issues.push(issue(file, `${base}.fields`, 'event_fields', 'Event fields must contain 1–32 lower-camel-case result field names.'))
        else {
          for (const field of emit.fields) if (!isRecord(value.result?.fields) || !Object.hasOwn(value.result.fields, field)) issues.push(issue(file, `${base}.fields`, 'result_reference', `Emitted field "${field}" must exist in result.fields.`))
          for (const duplicate of duplicateStrings(emit.fields)) issues.push(issue(file, `${base}.fields`, 'duplicate', `Emitted field "${duplicate}" is duplicated.`))
        }
        if (emit.target === 'reporting') {
          if (!isRecord(emit.reporting)) issues.push(issue(file, `${base}.reporting`, 'object', 'Reporting target requires projection metadata.'))
          else {
            unknownKeys(emit.reporting, operationReportingKeys, file, `${base}.reporting`, issues)
            if (emit.reporting.keyField !== '$partitionKey' && (typeof emit.reporting.keyField !== 'string' || !emit.fields?.includes(emit.reporting.keyField))) issues.push(issue(file, `${base}.reporting.keyField`, 'result_reference', 'Reporting keyField must be $partitionKey or an emitted result field.'))
            if (emit.reporting.sequenceField !== undefined && (typeof emit.reporting.sequenceField !== 'string' || !emit.fields?.includes(emit.reporting.sequenceField) || value.result?.fields?.[emit.reporting.sequenceField]?.type !== 'integer')) issues.push(issue(file, `${base}.reporting.sequenceField`, 'result_reference', 'Reporting sequenceField must be an emitted integer result field.'))
            if (!Array.isArray(emit.reporting.dimensions) || emit.reporting.dimensions.length > 8 || emit.reporting.dimensions.some((field) => typeof field !== 'string' || !emit.fields?.includes(field))) issues.push(issue(file, `${base}.reporting.dimensions`, 'result_reference', 'Reporting dimensions must contain at most eight emitted result fields.'))
            if (!Array.isArray(emit.reporting.measures) || emit.reporting.measures.length < 1 || emit.reporting.measures.length > 8) issues.push(issue(file, `${base}.reporting.measures`, 'array_size', 'Reporting measures must contain between one and eight declarations.'))
            else emit.reporting.measures.forEach((measure, measureIndex) => {
              const measureBase = `${base}.reporting.measures.${measureIndex}`
              if (!isRecord(measure)) { issues.push(issue(file, measureBase, 'object', 'Reporting measure must be an object.')); return }
              unknownKeys(measure, operationMeasureKeys, file, measureBase, issues)
              if (typeof measure.field !== 'string' || !emit.fields?.includes(measure.field) || !['integer', 'number'].includes(value.result?.fields?.[measure.field]?.type)) issues.push(issue(file, `${measureBase}.field`, 'result_reference', 'Reporting measure field must be an emitted numeric result field.'))
              if (measure.aggregate !== 'sum') issues.push(issue(file, `${measureBase}.aggregate`, 'aggregate', 'Reporting Runtime v1 supports the sum aggregate.'))
            })
          }
        } else if (emit.reporting !== undefined) issues.push(issue(file, `${base}.reporting`, 'field_dependency', 'Reporting projection metadata is allowed only for the reporting target.'))
        if (emit.target === 'realtime') {
          if (!isRecord(emit.realtime)) issues.push(issue(file, `${base}.realtime`, 'object', 'Realtime target requires room routing metadata.'))
          else {
            unknownKeys(emit.realtime, operationRealtimeKeys, file, `${base}.realtime`, issues)
            if (typeof emit.realtime.roomClass !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(emit.realtime.roomClass)) issues.push(issue(file, `${base}.realtime.roomClass`, 'identifier', 'Realtime roomClass must be a lowercase identifier.'))
            if (emit.realtime.roomField !== '$partitionKey' && (typeof emit.realtime.roomField !== 'string' || !emit.fields?.includes(emit.realtime.roomField))) issues.push(issue(file, `${base}.realtime.roomField`, 'result_reference', 'Realtime roomField must be $partitionKey or an emitted result field.'))
          }
        } else if (emit.realtime !== undefined) issues.push(issue(file, `${base}.realtime`, 'field_dependency', 'Realtime routing metadata is allowed only for the realtime target.'))
        const identity = `${emit.target}:${emit.event}`
        if (names.has(identity)) issues.push(issue(file, 'emits', 'duplicate', `Emit target and event "${identity}" is duplicated.`))
        names.add(identity)
      })
    }
  }
  if (!isRecord(value.input)) {
    issues.push(issue(file, 'input', 'object', 'Operation input must be an object, even when it has no fields.'))
  } else {
    const entries = Object.entries(value.input)
    if (entries.length > 64) issues.push(issue(file, 'input', 'object_size', 'Operation input supports at most 64 fields.'))
    for (const [name, definition] of entries) {
      const base = `input.${name}`
      if (!fieldNamePattern.test(name)) issues.push(issue(file, base, 'identifier', 'Input names must be lower-camel-case identifiers.'))
      if (runtimeOperationParameters.has(name)) issues.push(issue(file, base, 'runtime_parameter', `"${name}" is runtime-owned and cannot be declared as input.`))
      if (!isRecord(definition)) {
        issues.push(issue(file, base, 'object', 'Input field definition must be an object.'))
        continue
      }
      unknownKeys(definition, operationInputKeys, file, base, issues)
      if (!['string', 'integer', 'number', 'boolean'].includes(definition.type)) issues.push(issue(file, `${base}.type`, 'input_type', 'Input type must be string, integer, number, or boolean.'))
      if (definition.required !== undefined && typeof definition.required !== 'boolean') issues.push(issue(file, `${base}.required`, 'boolean', 'Input required must be a boolean.'))
    }
  }
  if (!isRecord(value.result)) {
    issues.push(issue(file, 'result', 'object', 'Operation result must be an object.'))
  } else {
    unknownKeys(value.result, operationResultKeys, file, 'result', issues)
    if (!['none', 'one', 'optional', 'many'].includes(value.result.mode)) issues.push(issue(file, 'result.mode', 'result_mode', 'Result mode must be none, one, optional, or many.'))
    const resultFields = value.result.fields
    if (value.result.mode === 'none') {
      if (resultFields !== undefined && (!isRecord(resultFields) || Object.keys(resultFields).length)) issues.push(issue(file, 'result.fields', 'result_fields', 'A none result cannot declare output fields.'))
    } else if (!isRecord(resultFields) || Object.keys(resultFields).length < 1 || Object.keys(resultFields).length > 128) {
      issues.push(issue(file, 'result.fields', 'result_fields', 'Non-none results must declare between 1 and 128 output fields.'))
    } else {
      for (const [name, definition] of Object.entries(resultFields)) {
        const base = `result.fields.${name}`
        if (!/^[a-z][A-Za-z0-9_]{0,62}$/.test(name)) issues.push(issue(file, base, 'identifier', 'Result field names must be SQL-safe lower-case or lower-camel-case identifiers.'))
        if (!isRecord(definition)) {
          issues.push(issue(file, base, 'object', 'Result field definition must be an object.'))
          continue
        }
        unknownKeys(definition, operationResultFieldKeys, file, base, issues)
        if (!['string', 'integer', 'number', 'boolean'].includes(definition.type)) issues.push(issue(file, `${base}.type`, 'result_type', 'Result type must be string, integer, number, or boolean.'))
        if (definition.nullable !== undefined && typeof definition.nullable !== 'boolean') issues.push(issue(file, `${base}.nullable`, 'boolean', 'Result nullable must be a boolean.'))
      }
    }
    if (value.result.mode === 'many') {
      if (!Number.isSafeInteger(value.result.maxRows) || value.result.maxRows < 1 || value.result.maxRows > 100) issues.push(issue(file, 'result.maxRows', 'row_limit', 'Many results require maxRows between 1 and 100.'))
    } else if (value.result.maxRows !== undefined) {
      issues.push(issue(file, 'result.maxRows', 'row_limit', 'maxRows is supported only when result mode is many.'))
    }
    if (value.result.pagination !== undefined) {
      const pagination = value.result.pagination
      if (value.result.mode !== 'many') issues.push(issue(file, 'result.pagination', 'pagination_mode', 'Pagination is supported only for many results.'))
      if (!isRecord(pagination)) {
        issues.push(issue(file, 'result.pagination', 'object', 'Pagination must be an object.'))
      } else {
        unknownKeys(pagination, operationPaginationKeys, file, 'result.pagination', issues)
        if (typeof pagination.cursorField !== 'string' || !/^[a-z][A-Za-z0-9_]{0,62}$/.test(pagination.cursorField) || !isRecord(resultFields) || !Object.hasOwn(resultFields, pagination.cursorField)) issues.push(issue(file, 'result.pagination.cursorField', 'cursor_field', 'Pagination cursorField must reference a declared result field.'))
        if (!Number.isSafeInteger(pagination.maxPageSize) || pagination.maxPageSize < 1 || pagination.maxPageSize > 100) issues.push(issue(file, 'result.pagination.maxPageSize', 'page_size', 'Pagination maxPageSize must be between 1 and 100.'))
        if (!Number.isSafeInteger(pagination.defaultPageSize) || pagination.defaultPageSize < 1 || pagination.defaultPageSize > (pagination.maxPageSize || 0)) issues.push(issue(file, 'result.pagination.defaultPageSize', 'page_size', 'Pagination defaultPageSize must be between 1 and maxPageSize.'))
      }
    }
  }
  return issues
}

function stripSqlComments(source) {
  return source.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

export function validateMigrationSql(source, file = '<migration>') {
  const issues = []
  if (Buffer.byteLength(source, 'utf8') > maxMigrationBytes) issues.push(issue(file, '', 'file_too_large', `Migration files are limited to ${maxMigrationBytes} bytes.`))
  const withoutComments = stripSqlComments(source).trim()
  if (!withoutComments) return [...issues, issue(file, '', 'empty_migration', 'Migration must contain at least one SQL statement.')]
  if (!withoutComments.endsWith(';')) issues.push(issue(file, '', 'statement_terminator', 'Every migration must end with a semicolon.'))
  const forbidden = /\b(PRAGMA|ATTACH|DETACH|VACUUM|DROP|TRUNCATE|REINDEX|CREATE\s+TRIGGER|CREATE\s+VIRTUAL\s+TABLE)\b/i
  const forbiddenMatch = withoutComments.match(forbidden)
  if (forbiddenMatch) {
    const line = withoutComments.slice(0, forbiddenMatch.index).split('\n').length
    issues.push(issue(file, '', 'unsupported_sql', `"${forbiddenMatch[0]}" is not supported by the Runtime v1 migration dialect.`, line))
  }
  const statements = withoutComments.split(';').map((statement) => statement.trim()).filter(Boolean)
  const allowed = /^(CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE\s+[a-zA-Z_][a-zA-Z0-9_]*\s+ADD\s+COLUMN|INSERT\s+INTO|UPDATE\s+[a-zA-Z_][a-zA-Z0-9_]*)\b/i
  for (const statement of statements) {
    if (!allowed.test(statement)) {
      const offset = withoutComments.indexOf(statement)
      issues.push(issue(file, '', 'unsupported_statement', 'Allowed statements are CREATE TABLE, CREATE INDEX, ALTER TABLE ADD COLUMN, INSERT INTO, and bounded UPDATE.', withoutComments.slice(0, offset).split('\n').length))
    }
    if (/^UPDATE\b/i.test(statement) && !/\bWHERE\b/i.test(statement)) {
      const offset = withoutComments.indexOf(statement)
      issues.push(issue(file, '', 'unbounded_update', 'UPDATE data migrations must include a WHERE clause.', withoutComments.slice(0, offset).split('\n').length))
    }
  }
  return issues
}

export function validateOperationSql(source, definition, file = '<operation-sql>') {
  const issues = []
  if (Buffer.byteLength(source, 'utf8') > maxOperationSqlBytes) issues.push(issue(file, '', 'file_too_large', `Operation SQL files are limited to ${maxOperationSqlBytes} bytes.`))
  const withoutComments = stripSqlComments(source).trim()
  if (!withoutComments) return [...issues, issue(file, '', 'empty_operation', 'Operation SQL must contain exactly one statement.')]
  if (!withoutComments.endsWith(';')) issues.push(issue(file, '', 'statement_terminator', 'Operation SQL must end with a semicolon.'))
  const statements = withoutComments.split(';').map((statement) => statement.trim()).filter(Boolean)
  if (statements.length !== 1) issues.push(issue(file, '', 'statement_count', 'Operation SQL must contain exactly one statement.'))
  const statement = statements[0] || ''
  if (definition?.kind === 'query' && !/^SELECT\b/i.test(statement)) issues.push(issue(file, '', 'query_read_only', 'Query operations support only a single SELECT statement.'))
  if (definition?.kind === 'command' && !/^(INSERT\s+INTO|UPDATE\s+[a-zA-Z_][a-zA-Z0-9_]*|DELETE\s+FROM)\b/i.test(statement)) {
    issues.push(issue(file, '', 'command_statement', 'Command operations support only INSERT, bounded UPDATE, or bounded DELETE.'))
  }
  if (/^(UPDATE|DELETE\s+FROM)\b/i.test(statement) && !/\bWHERE\b/i.test(statement)) issues.push(issue(file, '', 'unbounded_write', 'UPDATE and DELETE operations must include a WHERE clause.'))
  if (/\b(?:_lacify_[a-zA-Z0-9_]*|sqlite_[a-zA-Z0-9_]*)\b/i.test(statement)) issues.push(issue(file, '', 'internal_table', 'Operations cannot access Lacify or SQLite internal tables.'))
  if (/[?@$][a-zA-Z0-9_]*|\?(?:\d+)?/.test(statement)) issues.push(issue(file, '', 'parameter_style', 'Operation SQL must use named :parameter bindings only.'))
  const referenced = new Set([...statement.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]))
  const declared = new Set(isRecord(definition?.input) ? Object.keys(definition.input) : [])
  for (const parameter of referenced) {
    if (!declared.has(parameter) && !runtimeOperationParameters.has(parameter)) issues.push(issue(file, '', 'undeclared_parameter', `SQL parameter ":${parameter}" is not declared by the operation.`))
  }
  for (const parameter of declared) {
    if (!referenced.has(parameter)) issues.push(issue(file, '', 'unused_input', `Declared input "${parameter}" is not referenced by the SQL statement.`))
  }
  if (!referenced.has('partitionId')) issues.push(issue(file, '', 'partition_scope', 'Every operation must bind :partitionId to remain scoped to its Actor partition.'))
  if (definition?.result?.pagination) {
    if (!referenced.has('cursor') || !referenced.has('pageSize')) issues.push(issue(file, '', 'pagination_parameters', 'Paginated SQL must bind both :cursor and :pageSize.'))
    const cursorField = definition.result.pagination.cursorField
    if (cursorField && !new RegExp(`\\bORDER\\s+BY\\s+${cursorField}\\b`, 'i').test(statement)) issues.push(issue(file, '', 'pagination_order', `Paginated SQL must order by cursor field "${cursorField}".`))
  }
  return issues
}

export function validateDevelopmentSeedSql(source, file = '<development-seed>') {
  const issues = []
  if (Buffer.byteLength(source, 'utf8') > maxDevelopmentSeedBytes) issues.push(issue(file, '', 'file_too_large', `Development seed files are limited to ${maxDevelopmentSeedBytes} bytes.`))
  const withoutComments = stripSqlComments(source).trim()
  if (!withoutComments) return [...issues, issue(file, '', 'empty_seed', 'Development seed SQL must contain at least one statement.')]
  if (!withoutComments.endsWith(';')) issues.push(issue(file, '', 'statement_terminator', 'Every Development seed statement must end with a semicolon.'))
  const statements = withoutComments.split(';').map((statement) => statement.trim()).filter(Boolean)
  for (const statement of statements) {
    if (!/^(INSERT\s+INTO|UPDATE\s+[a-zA-Z_][a-zA-Z0-9_]*)\b/i.test(statement)) {
      issues.push(issue(file, '', 'unsupported_seed_statement', 'Development seeds support only INSERT and bounded UPDATE statements.'))
    }
    if (/^UPDATE\b/i.test(statement) && !/\bWHERE\b/i.test(statement)) issues.push(issue(file, '', 'unbounded_update', 'Development seed UPDATE statements must include a WHERE clause.'))
    if (/\b(?:_lacify_[a-zA-Z0-9_]*|sqlite_[a-zA-Z0-9_]*)\b/i.test(statement)) issues.push(issue(file, '', 'internal_table', 'Development seeds cannot access Lacify or SQLite internal tables.'))
  }
  return issues
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]))
}

function normalizedActor(actor) {
  const normalized = normalize(actor)
  normalized.commands = [...(normalized.commands || [])].sort()
  normalized.operations = [...(normalized.operations || [])].sort()
  normalized.secretRefs = [...(normalized.secretRefs || [])].sort()
  normalized.summaries = [...(normalized.summaries || [])].sort((left, right) => left.name.localeCompare(right.name))
  normalized.stateMachines = [...(normalized.stateMachines || [])]
    .map((machine) => ({
      ...machine,
      states: [...machine.states].sort(),
      transitions: [...machine.transitions].sort((left, right) => `${left.command}:${left.from}:${left.to}`.localeCompare(`${right.command}:${right.from}:${right.to}`)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  return normalized
}

function normalizedOperation(operation) {
  return {
    ...normalize(operation),
    input: Object.fromEntries(Object.entries(operation.input || {}).sort(([left], [right]) => left.localeCompare(right))),
  }
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

export function fingerprint(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

export async function loadRuntimeProject(runtimeFilePath) {
  const inputPath = runtimeFilePath instanceof URL ? fileURLToPath(runtimeFilePath) : runtimeFilePath
  const absoluteRuntimePath = path.resolve(inputPath)
  const root = path.dirname(absoluteRuntimePath)
  const runtimeSource = await readFile(absoluteRuntimePath, 'utf8')
  const runtimeParsed = parseYaml(runtimeSource, absoluteRuntimePath)
  const issues = [...runtimeParsed.issues]
  if (!runtimeParsed.value) return { valid: false, issues, project: null, fingerprint: null }
  issues.push(...attachSourceLines(validateRuntimeDocument(runtimeParsed.value, absoluteRuntimePath), runtimeSource))
  const actorEntries = []
  const developmentSeeds = []
  const actorNames = new Set()
  for (const actorReference of Array.isArray(runtimeParsed.value.actors) ? runtimeParsed.value.actors : []) {
    if (typeof actorReference !== 'string' || !actorPathPattern.test(actorReference)) continue
    const actorPath = path.resolve(root, actorReference)
    if (!actorPath.startsWith(`${root}${path.sep}`)) {
      issues.push(issue(absoluteRuntimePath, 'actors', 'path_escape', 'Actor path must remain inside the project directory.'))
      continue
    }
    let actorSource
    try {
      actorSource = await readFile(actorPath, 'utf8')
    } catch {
      issues.push(issue(actorPath, '', 'missing_file', 'Actor file does not exist or cannot be read.'))
      continue
    }
    const actorParsed = parseYaml(actorSource, actorPath)
    issues.push(...actorParsed.issues)
    if (!actorParsed.value) continue
    issues.push(...attachSourceLines(validateActorDocument(actorParsed.value, actorPath), actorSource))
    if (typeof actorParsed.value.name === 'string') {
      if (actorNames.has(actorParsed.value.name)) issues.push(issue(actorPath, 'name', 'duplicate_actor', `Actor "${actorParsed.value.name}" is declared more than once.`))
      actorNames.add(actorParsed.value.name)
    }
    const migrationsDirectory = path.join(path.dirname(actorPath), 'migrations')
    let migrationNames = []
    try {
      migrationNames = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort()
    } catch {
      issues.push(issue(migrationsDirectory, '', 'missing_migrations', 'Actor must contain a migrations directory with at least one SQL migration.'))
    }
    if (!migrationNames.length) issues.push(issue(migrationsDirectory, '', 'missing_migrations', 'Actor must contain at least one SQL migration.'))
    const migrations = []
    for (const migrationName of migrationNames) {
      const migrationPath = path.join(migrationsDirectory, migrationName)
      if (!migrationNamePattern.test(migrationName)) {
        issues.push(issue(migrationPath, '', 'migration_name', 'Migration names must match NNNN_lowercase_name.sql.'))
        continue
      }
      const sql = await readFile(migrationPath, 'utf8')
      issues.push(...validateMigrationSql(sql, migrationPath))
      migrations.push({ id: migrationName.slice(0, -4), sql: sql.replace(/\r\n/g, '\n').trim() + '\n' })
    }
    const operations = []
    const operationNames = new Set()
    for (const operationReference of Array.isArray(actorParsed.value.operations) ? actorParsed.value.operations : []) {
      if (typeof operationReference !== 'string' || !operationPathPattern.test(operationReference)) continue
      const operationPath = path.resolve(path.dirname(actorPath), operationReference)
      if (!operationPath.startsWith(`${path.dirname(actorPath)}${path.sep}`)) {
        issues.push(issue(actorPath, 'operations', 'path_escape', 'Operation path must remain inside its Actor directory.'))
        continue
      }
      let operationSource
      try {
        operationSource = await readFile(operationPath, 'utf8')
      } catch {
        issues.push(issue(operationPath, '', 'missing_file', 'Operation file does not exist or cannot be read.'))
        continue
      }
      const operationParsed = parseYaml(operationSource, operationPath)
      issues.push(...operationParsed.issues)
      if (!operationParsed.value) continue
      issues.push(...attachSourceLines(validateOperationDocument(operationParsed.value, actorParsed.value.commands || [], operationPath), operationSource))
      if (typeof operationParsed.value.name === 'string') {
        if (operationNames.has(operationParsed.value.name)) issues.push(issue(operationPath, 'name', 'duplicate_operation', `Operation "${operationParsed.value.name}" is declared more than once for Actor "${actorParsed.value.name}".`))
        operationNames.add(operationParsed.value.name)
      }
      if (typeof operationParsed.value.sql !== 'string' || !operationSqlPathPattern.test(operationParsed.value.sql)) continue
      const sqlPath = path.resolve(path.dirname(operationPath), operationParsed.value.sql)
      if (!sqlPath.startsWith(`${path.dirname(operationPath)}${path.sep}`)) {
        issues.push(issue(operationPath, 'sql', 'path_escape', 'Operation SQL path must remain inside its operations directory.'))
        continue
      }
      let sql
      try {
        sql = await readFile(sqlPath, 'utf8')
      } catch {
        issues.push(issue(sqlPath, '', 'missing_file', 'Operation SQL file does not exist or cannot be read.'))
        continue
      }
      issues.push(...validateOperationSql(sql, operationParsed.value, sqlPath))
      operations.push({
        source: operationReference,
        definition: normalizedOperation(operationParsed.value),
        sql: sql.replace(/\r\n/g, '\n').trim() + '\n',
      })
    }
    operations.sort((left, right) => left.definition.name.localeCompare(right.definition.name))
    const developmentSeedPath = path.join(path.dirname(actorPath), 'seeds', 'development.sql')
    try {
      const seedSql = await readFile(developmentSeedPath, 'utf8')
      issues.push(...validateDevelopmentSeedSql(seedSql, developmentSeedPath))
      developmentSeeds.push({
        actor: actorParsed.value.name,
        file: developmentSeedPath,
        sql: seedSql.replace(/\r\n/g, '\n').trim() + '\n',
      })
    } catch (error) {
      if (error?.code !== 'ENOENT') issues.push(issue(developmentSeedPath, '', 'seed_read', 'Development seed file cannot be read.'))
    }
    actorEntries.push({ source: actorReference, definition: normalizedActor(actorParsed.value), migrations, operations })
  }
  const normalizedProject = {
    runtime: {
      ...normalize(runtimeParsed.value),
      actors: [...(runtimeParsed.value.actors || [])].sort(),
    },
    actors: actorEntries.sort((left, right) => left.definition.name.localeCompare(right.definition.name)),
  }
  return {
    valid: issues.length === 0,
    issues,
    project: normalizedProject,
    developmentSeeds: developmentSeeds.sort((left, right) => left.actor.localeCompare(right.actor)),
    fingerprint: issues.length ? null : fingerprint(normalizedProject),
  }
}

export const runtimeSpecLimits = Object.freeze({ maxYamlBytes, maxMigrationBytes, maxOperationSqlBytes, maxDevelopmentSeedBytes })
