import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { introspectActorSchema, readMigrationLedger } from './migration-engine.mjs'

const snapshotPattern = /^snapshot_[a-f0-9-]{36}$/

async function exists(file) {
  try { await access(file); return true } catch { return false }
}

async function fileHash(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function snapshotRoot(root, snapshotId) {
  if (!snapshotPattern.test(snapshotId)) throw new Error('Snapshot ID must match snapshot_<UUID>.')
  return path.join(root, '.lacify', 'backups', snapshotId)
}

export async function createLocalSnapshot({ root, project, lock }) {
  const development = lock.environments?.development
  if (development?.fingerprint !== project.fingerprint) throw new Error('Local Development must match the current project fingerprint before snapshot.')
  const snapshotId = `snapshot_${randomUUID()}`
  const directory = snapshotRoot(root, snapshotId)
  const actorDirectory = path.join(directory, 'actors')
  await mkdir(actorDirectory, { recursive: true, mode: 0o700 })
  const actors = []
  try {
    for (const actor of project.project.actors) {
      const source = path.join(root, '.lacify', 'development', 'development', `${actor.definition.name}.sqlite`)
      if (!await exists(source)) throw new Error(`Development database for Actor "${actor.definition.name}" does not exist.`)
      const destination = path.join(actorDirectory, `${actor.definition.name}.sqlite`)
      const database = new DatabaseSync(source)
      let schema
      let migrations
      try {
        schema = introspectActorSchema(database)
        migrations = readMigrationLedger(database, actor.definition.name).map(({ id, checksum, status }) => ({ id, checksum, status }))
        await backup(database, destination)
      } finally {
        database.close()
      }
      const info = await stat(destination)
      actors.push({
        actor: actor.definition.name,
        file: `actors/${actor.definition.name}.sqlite`,
        bytes: info.size,
        checksum: await fileHash(destination),
        schemaFingerprint: schema.fingerprint,
        migrations,
      })
    }
    const manifest = {
      version: 'lacify.dev/snapshot/v1',
      snapshotId,
      project: project.project.runtime.project,
      projectFingerprint: project.fingerprint,
      environment: 'development',
      revision: development.revision,
      createdAt: new Date().toISOString(),
      actors,
      containsBusinessData: true,
    }
    await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    return manifest
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function readLocalSnapshot(root, snapshotId) {
  const directory = snapshotRoot(root, snapshotId)
  let manifest
  try {
    manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Snapshot "${snapshotId}" does not exist.`)
    throw new Error(`Snapshot "${snapshotId}" has an invalid manifest.`)
  }
  if (manifest.version !== 'lacify.dev/snapshot/v1' || manifest.snapshotId !== snapshotId || !Array.isArray(manifest.actors)) {
    throw new Error(`Snapshot "${snapshotId}" has an invalid manifest contract.`)
  }
  return { directory, manifest }
}

export async function listLocalSnapshots(root) {
  const directory = path.join(root, '.lacify', 'backups')
  let names
  try {
    names = (await readdir(directory)).filter((name) => snapshotPattern.test(name)).sort().reverse().slice(0, 100)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const snapshots = []
  for (const name of names) {
    try {
      const { manifest } = await readLocalSnapshot(root, name)
      snapshots.push({
        snapshotId: manifest.snapshotId,
        project: manifest.project,
        projectFingerprint: manifest.projectFingerprint,
        revision: manifest.revision,
        createdAt: manifest.createdAt,
        actors: manifest.actors.length,
        bytes: manifest.actors.reduce((sum, actor) => sum + actor.bytes, 0),
        containsBusinessData: true,
      })
    } catch {
      snapshots.push({ snapshotId: name, valid: false, containsBusinessData: true })
    }
  }
  return snapshots
}

export async function verifyLocalSnapshot(root, snapshotId) {
  const { directory, manifest } = await readLocalSnapshot(root, snapshotId)
  const actors = []
  for (const actor of manifest.actors) {
    if (!/^[A-Z][A-Za-z0-9]{0,62}$/.test(actor.actor) || actor.file !== `actors/${actor.actor}.sqlite`) throw new Error('Snapshot contains an invalid Actor file reference.')
    const file = path.join(directory, actor.file)
    const checksumMatched = await fileHash(file) === actor.checksum
    const database = new DatabaseSync(file, { readOnly: true })
    let integrity
    let schemaFingerprint
    try {
      integrity = database.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok'
      schemaFingerprint = introspectActorSchema(database).fingerprint
    } finally {
      database.close()
    }
    actors.push({
      actor: actor.actor,
      checksumMatched,
      integrityPassed: integrity,
      schemaMatched: schemaFingerprint === actor.schemaFingerprint,
    })
  }
  return {
    verified: actors.every(({ checksumMatched, integrityPassed, schemaMatched }) => checksumMatched && integrityPassed && schemaMatched),
    snapshotId,
    project: manifest.project,
    projectFingerprint: manifest.projectFingerprint,
    actors,
    businessRowsReturned: false,
  }
}

export async function rehearseLocalRestore(root, snapshotId) {
  const { directory, manifest } = await readLocalSnapshot(root, snapshotId)
  const temporary = await mkdtemp(path.join(tmpdir(), 'lacify-recovery-'))
  const rehearsalId = `rehearsal_${randomUUID()}`
  try {
    for (const actor of manifest.actors) await cp(path.join(directory, actor.file), path.join(temporary, `${actor.actor}.sqlite`))
    const actors = []
    for (const actor of manifest.actors) {
      const restored = path.join(temporary, `${actor.actor}.sqlite`)
      const database = new DatabaseSync(restored)
      let integrityPassed
      let schemaMatched
      try {
        integrityPassed = database.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok'
        schemaMatched = introspectActorSchema(database).fingerprint === actor.schemaFingerprint
      } finally {
        database.close()
      }
      actors.push({ actor: actor.actor, checksumMatched: await fileHash(restored) === actor.checksum, integrityPassed, schemaMatched })
    }
    const evidence = {
      version: 'lacify.dev/rehearsal/v1',
      rehearsalId,
      snapshotId,
      project: manifest.project,
      projectFingerprint: manifest.projectFingerprint,
      rehearsedAt: new Date().toISOString(),
      isolatedTemporaryRestore: true,
      activeDevelopmentOverwritten: false,
      passed: actors.every(({ checksumMatched, integrityPassed, schemaMatched }) => checksumMatched && integrityPassed && schemaMatched),
      actors,
      businessRowsReturned: false,
    }
    await mkdir(path.join(root, '.lacify', 'recovery'), { recursive: true, mode: 0o700 })
    await writeFile(path.join(root, '.lacify', 'recovery', `${rehearsalId}.json`), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
    return evidence
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
