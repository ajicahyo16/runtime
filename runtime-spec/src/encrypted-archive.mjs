import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCallback } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { loadRuntimeProject } from './index.mjs'
import { introspectActorSchema } from './migration-engine.mjs'
import { readLocalSnapshot, verifyLocalSnapshot } from './local-backup.mjs'

const scrypt = promisify(scryptCallback)
const magic = Buffer.from('LACIFYARCHIVE1\n', 'utf8')
const maxHeaderBytes = 64 * 1024
const maxSourceBytes = 384 * 1024 * 1024
const maxArchiveBytes = 512 * 1024 * 1024
const allowedProjectFile = /^(lacify\.runtime\.yaml|actors\/[A-Za-z0-9_./-]+\.(yaml|yml|sql)|tests\/[A-Za-z0-9_.-]+\.operation\.json|\.lacify\/(lock|modules|integration)\.json|\.lacify\/reviews\/review_[a-f0-9]{40}\.json)$/

async function exists(file) {
  try { await access(file); return true } catch { return false }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function passphraseFrom(environment) {
  const value = environment?.LACIFY_ARCHIVE_PASSPHRASE
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 16 || Buffer.byteLength(value, 'utf8') > 1024) {
    throw new Error('LACIFY_ARCHIVE_PASSPHRASE must contain 16–1,024 UTF-8 bytes in the protected process environment.')
  }
  return value
}

async function walkFiles(root, relativeDirectory) {
  const start = path.join(root, relativeDirectory)
  let entries
  try { entries = await readdir(start, { withFileTypes: true }) } catch (error) { if (error?.code === 'ENOENT') return []; throw error }
  const files = []
  for (const entry of entries) {
    const relative = path.posix.join(relativeDirectory.split(path.sep).join('/'), entry.name)
    if (entry.isDirectory()) files.push(...await walkFiles(root, relative))
    else if (entry.isFile() && allowedProjectFile.test(relative)) files.push(relative)
  }
  return files
}

async function collectProjectFiles(root) {
  const candidates = ['lacify.runtime.yaml']
  candidates.push(...await walkFiles(root, 'actors'))
  candidates.push(...await walkFiles(root, 'tests'))
  for (const file of ['.lacify/lock.json', '.lacify/modules.json', '.lacify/integration.json']) if (await exists(path.join(root, file))) candidates.push(file)
  candidates.push(...await walkFiles(root, '.lacify/reviews'))
  const files = []
  let totalBytes = 0
  for (const relative of [...new Set(candidates)].sort()) {
    if (!allowedProjectFile.test(relative)) throw new Error(`Archive project path "${relative}" is not allowed.`)
    const data = await readFile(path.join(root, relative))
    totalBytes += data.byteLength
    if (totalBytes > maxSourceBytes) throw new Error('Archive source exceeds the 384 MiB safety bound.')
    files.push({ path: relative, bytes: data.byteLength, checksum: sha256(data), data: data.toString('base64') })
  }
  return { files, totalBytes }
}

function encodeArchive(header, ciphertext, tag) {
  const headerBuffer = Buffer.from(JSON.stringify(header), 'utf8')
  if (headerBuffer.byteLength > maxHeaderBytes) throw new Error('Archive header exceeds its safety bound.')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(headerBuffer.byteLength)
  return Buffer.concat([magic, length, headerBuffer, ciphertext, tag])
}

function parseArchive(buffer) {
  if (buffer.byteLength > maxArchiveBytes) throw new Error('Archive exceeds the 512 MiB safety bound.')
  if (buffer.byteLength < magic.byteLength + 4 + 16 || !buffer.subarray(0, magic.byteLength).equals(magic)) throw new Error('File is not a Lacify encrypted archive.')
  const headerLength = buffer.readUInt32BE(magic.byteLength)
  if (headerLength < 2 || headerLength > maxHeaderBytes) throw new Error('Archive header length is invalid.')
  const headerStart = magic.byteLength + 4
  const ciphertextStart = headerStart + headerLength
  if (ciphertextStart + 16 > buffer.byteLength) throw new Error('Archive is truncated.')
  let header
  try { header = JSON.parse(buffer.subarray(headerStart, ciphertextStart).toString('utf8')) } catch { throw new Error('Archive header is invalid.') }
  if (
    header.version !== 'lacify.archive/v1'
    || header.cipher !== 'aes-256-gcm'
    || header.kdf !== 'scrypt'
    || header.tagBytes !== 16
    || typeof header.salt !== 'string'
    || typeof header.iv !== 'string'
  ) throw new Error('Archive cryptographic contract is unsupported.')
  const headerBuffer = buffer.subarray(headerStart, ciphertextStart)
  return {
    header,
    headerBuffer,
    ciphertext: buffer.subarray(ciphertextStart, buffer.byteLength - 16),
    tag: buffer.subarray(buffer.byteLength - 16),
  }
}

async function decryptBundle(file, environment) {
  const info = await stat(file)
  if (info.size > maxArchiveBytes) throw new Error('Archive exceeds the 512 MiB safety bound.')
  const archive = await readFile(file)
  const parsed = parseArchive(archive)
  const salt = Buffer.from(parsed.header.salt, 'base64')
  const iv = Buffer.from(parsed.header.iv, 'base64')
  if (salt.byteLength !== 16 || iv.byteLength !== 12) throw new Error('Archive cryptographic parameters are invalid.')
  const key = await scrypt(passphraseFrom(environment), salt, 32)
  let plaintext
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.concat([magic, parsed.headerBuffer]))
    decipher.setAuthTag(parsed.tag)
    plaintext = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()])
  } catch {
    throw new Error('Archive authentication failed: the passphrase is incorrect or the archive was modified.')
  } finally {
    key.fill(0)
  }
  let bundle
  try { bundle = JSON.parse(plaintext.toString('utf8')) } catch { throw new Error('Decrypted archive payload is invalid.') }
  return { archive, header: parsed.header, bundle }
}

function validateBundle(bundle) {
  if (
    bundle?.version !== 'lacify.archive-bundle/v1'
    || !bundle.snapshot
    || bundle.snapshot.version !== 'lacify.dev/snapshot/v1'
    || !Array.isArray(bundle.projectFiles)
    || !Array.isArray(bundle.actorDatabases)
  ) throw new Error('Archive bundle contract is invalid.')
  const paths = new Set()
  let totalBytes = 0
  for (const file of bundle.projectFiles) {
    if (!allowedProjectFile.test(file.path) || paths.has(file.path)) throw new Error('Archive contains an invalid or duplicate project path.')
    paths.add(file.path)
    const data = Buffer.from(file.data, 'base64')
    totalBytes += data.byteLength
    if (data.byteLength !== file.bytes || sha256(data) !== file.checksum) throw new Error(`Archive project file "${file.path}" failed checksum verification.`)
  }
  for (const actor of bundle.actorDatabases) {
    if (!/^[A-Z][A-Za-z0-9]{0,62}$/.test(actor.actor)) throw new Error('Archive contains an invalid Actor database identity.')
    const manifestActor = bundle.snapshot.actors.find((entry) => entry.actor === actor.actor)
    if (!manifestActor) throw new Error('Archive Actor database is absent from the snapshot manifest.')
    const data = Buffer.from(actor.data, 'base64')
    totalBytes += data.byteLength
    if (data.byteLength !== actor.bytes || sha256(data) !== actor.checksum || actor.checksum !== manifestActor.checksum) throw new Error(`Archive Actor "${actor.actor}" failed checksum verification.`)
  }
  if (totalBytes > maxSourceBytes) throw new Error('Decrypted archive source exceeds the 384 MiB safety bound.')
  return true
}

async function verifyActorDatabases(bundle) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'lacify-archive-verify-'))
  const actors = []
  try {
    for (const actor of bundle.actorDatabases) {
      const file = path.join(temporary, `${actor.actor}.sqlite`)
      await writeFile(file, Buffer.from(actor.data, 'base64'), { mode: 0o600 })
      const database = new DatabaseSync(file, { readOnly: true })
      let integrityPassed
      let schemaMatched
      try {
        integrityPassed = database.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok'
        schemaMatched = introspectActorSchema(database).fingerprint === actor.schemaFingerprint
      } finally {
        database.close()
      }
      actors.push({ actor: actor.actor, checksumMatched: true, integrityPassed, schemaMatched })
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  return actors
}

export async function createEncryptedArchive({ root, project, snapshotId, outputFile, environment = process.env }) {
  if (!path.isAbsolute(outputFile)) throw new Error('Archive output must be an absolute path.')
  if (await exists(outputFile)) throw new Error('Archive output already exists; encrypted archives are never overwritten.')
  const verification = await verifyLocalSnapshot(root, snapshotId)
  if (!verification.verified) throw new Error('Snapshot verification failed; archive was not created.')
  const { directory, manifest } = await readLocalSnapshot(root, snapshotId)
  if (manifest.projectFingerprint !== project.fingerprint) throw new Error('Snapshot fingerprint does not match the current project.')
  const projectSource = await collectProjectFiles(root)
  const actorDatabases = []
  let totalBytes = projectSource.totalBytes
  for (const actor of manifest.actors) {
    const data = await readFile(path.join(directory, actor.file))
    totalBytes += data.byteLength
    if (totalBytes > maxSourceBytes) throw new Error('Archive source exceeds the 384 MiB safety bound.')
    actorDatabases.push({
      actor: actor.actor,
      bytes: data.byteLength,
      checksum: actor.checksum,
      schemaFingerprint: actor.schemaFingerprint,
      data: data.toString('base64'),
    })
  }
  const bundle = {
    version: 'lacify.archive-bundle/v1',
    project: project.project.runtime.project,
    projectFingerprint: project.fingerprint,
    snapshot: manifest,
    projectFiles: projectSource.files,
    actorDatabases,
  }
  const plaintext = Buffer.from(JSON.stringify(bundle), 'utf8')
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const header = {
    version: 'lacify.archive/v1',
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tagBytes: 16,
    createdAt: new Date().toISOString(),
  }
  const headerBuffer = Buffer.from(JSON.stringify(header), 'utf8')
  const key = await scrypt(passphraseFrom(environment), salt, 32)
  let encoded
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.concat([magic, headerBuffer]))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    encoded = encodeArchive(header, ciphertext, cipher.getAuthTag())
  } finally {
    key.fill(0)
  }
  if (encoded.byteLength > maxArchiveBytes) throw new Error('Encrypted archive exceeds the 512 MiB safety bound.')
  await mkdir(path.dirname(outputFile), { recursive: true, mode: 0o700 })
  await writeFile(outputFile, encoded, { mode: 0o600, flag: 'wx' })
  return {
    created: true,
    archiveId: `archive_${sha256(encoded).slice(0, 40)}`,
    file: outputFile,
    bytes: encoded.byteLength,
    project: bundle.project,
    projectFingerprint: bundle.projectFingerprint,
    snapshotId,
    actors: actorDatabases.length,
    encrypted: true,
    businessRowsReturned: false,
    passphraseReturned: false,
  }
}

export async function inspectEncryptedArchive(file) {
  const absolute = path.resolve(file)
  const info = await stat(absolute)
  if (info.size > maxArchiveBytes) throw new Error('Archive exceeds the 512 MiB safety bound.')
  const data = await readFile(absolute)
  const { header } = parseArchive(data)
  return {
    archiveId: `archive_${sha256(data).slice(0, 40)}`,
    file: absolute,
    bytes: info.size,
    format: header.version,
    cipher: header.cipher,
    kdf: header.kdf,
    createdAt: header.createdAt,
    encryptedPayloadInspected: false,
    businessRowsReturned: false,
  }
}

export async function verifyEncryptedArchive(file, environment = process.env) {
  const absolute = path.resolve(file)
  const { archive, bundle } = await decryptBundle(absolute, environment)
  validateBundle(bundle)
  const actors = await verifyActorDatabases(bundle)
  return {
    verified: actors.every(({ integrityPassed, schemaMatched }) => integrityPassed && schemaMatched),
    archiveId: `archive_${sha256(archive).slice(0, 40)}`,
    file: absolute,
    project: bundle.project,
    projectFingerprint: bundle.projectFingerprint,
    snapshotId: bundle.snapshot.snapshotId,
    actors,
    businessRowsReturned: false,
    passphraseReturned: false,
  }
}

export async function restoreEncryptedArchive({ file, target, environment = process.env }) {
  const absoluteTarget = path.resolve(target)
  if (await exists(absoluteTarget)) throw new Error('Archive restore target already exists; restore never overwrites a directory.')
  const { archive, bundle } = await decryptBundle(path.resolve(file), environment)
  validateBundle(bundle)
  const actors = await verifyActorDatabases(bundle)
  if (!actors.every(({ integrityPassed, schemaMatched }) => integrityPassed && schemaMatched)) throw new Error('Archive Actor database integrity verification failed.')
  await mkdir(path.dirname(absoluteTarget), { recursive: true })
  const staging = await mkdtemp(path.join(path.dirname(absoluteTarget), '.lacify-restore-'))
  try {
    for (const entry of bundle.projectFiles) {
      const destination = path.join(staging, entry.path)
      const relative = path.relative(staging, destination)
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Archive project path escapes the restore target.')
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, Buffer.from(entry.data, 'base64'), { mode: 0o600 })
    }
    await writeFile(path.join(staging, '.gitignore'), '.lacify/development/\n.lacify/backups/\n.lacify/recovery/\n', { mode: 0o600 })
    const snapshotDirectory = path.join(staging, '.lacify', 'backups', bundle.snapshot.snapshotId)
    await mkdir(path.join(snapshotDirectory, 'actors'), { recursive: true, mode: 0o700 })
    await writeFile(path.join(snapshotDirectory, 'manifest.json'), `${JSON.stringify(bundle.snapshot, null, 2)}\n`, { mode: 0o600 })
    const developmentDirectory = path.join(staging, '.lacify', 'development', 'development')
    await mkdir(developmentDirectory, { recursive: true, mode: 0o700 })
    for (const actor of bundle.actorDatabases) {
      const data = Buffer.from(actor.data, 'base64')
      await writeFile(path.join(snapshotDirectory, 'actors', `${actor.actor}.sqlite`), data, { mode: 0o600 })
      await writeFile(path.join(developmentDirectory, `${actor.actor}.sqlite`), data, { mode: 0o600 })
    }
    const loaded = await loadRuntimeProject(path.join(staging, 'lacify.runtime.yaml'))
    if (!loaded.valid || loaded.fingerprint !== bundle.projectFingerprint) throw new Error('Restored canonical project does not match the archived fingerprint.')
    const evidence = {
      version: 'lacify.dev/archive-restore/v1',
      archiveId: `archive_${sha256(archive).slice(0, 40)}`,
      project: bundle.project,
      projectFingerprint: bundle.projectFingerprint,
      snapshotId: bundle.snapshot.snapshotId,
      restoredAt: new Date().toISOString(),
      isolatedTarget: true,
      existingProjectOverwritten: false,
      actors: actors.map(({ actor, integrityPassed, schemaMatched }) => ({ actor, integrityPassed, schemaMatched })),
      businessRowsReturned: false,
      passphraseReturned: false,
    }
    await writeFile(path.join(staging, '.lacify', 'archive-restore.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
    await rename(staging, absoluteTarget)
    return { ...evidence, target: absoluteTarget, restored: true }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}
