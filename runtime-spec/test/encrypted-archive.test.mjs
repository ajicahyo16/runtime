import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { runCli } from '../src/cli.mjs'
import { loadRuntimeProject } from '../src/index.mjs'

function capture() {
  let value = ''
  return { io: { stdout: { write: (chunk) => { value += chunk } } }, read: () => JSON.parse(value), text: () => value }
}

test('encrypted archives reject wrong keys and tampering and restore private data only to a new target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-archive-project-'))
  await runCli(['init', '--project', 'archive-project', '--template', 'personal'], capture().io, root)
  const reviewed = capture()
  await runCli(['review', '--json'], reviewed.io, root)
  await runCli(['apply-review', '--review', reviewed.read().receipt.reviewId, '--approve'], capture().io, root)
  const activeFile = path.join(root, '.lacify', 'development', 'development', 'Workspace.sqlite')
  const database = new DatabaseSync(activeFile)
  database.prepare('INSERT INTO notes (id, workspace_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    'archive-private', 'archive-workspace', 'archive secret title', 'archive secret body', 1, 1,
  )
  database.close()
  const snapshotOutput = capture()
  await runCli(['snapshot', '--approve', '--json'], snapshotOutput.io, root)
  const snapshotId = snapshotOutput.read().snapshot.snapshotId

  const destinationRoot = await mkdtemp(path.join(tmpdir(), 'lacify-archive-output-'))
  const archiveFile = path.join(destinationRoot, 'personal.lacify.enc')
  const environment = { LACIFY_ARCHIVE_PASSPHRASE: 'correct horse battery archive' }
  await assert.rejects(() => runCli(['archive-create', '--snapshot', snapshotId, '--output', archiveFile], capture().io, root, { environment }), /Explicit approval/)
  const created = capture()
  assert.equal(await runCli(['archive-create', '--snapshot', snapshotId, '--output', archiveFile, '--approve', '--json'], created.io, root, { environment }), 0)
  const creation = created.read()
  assert.equal(creation.encrypted, true)
  assert.equal(creation.passphraseReturned, false)
  assert.equal(created.text().includes(environment.LACIFY_ARCHIVE_PASSPHRASE), false)
  const encrypted = await readFile(archiveFile)
  assert.equal(encrypted.toString('utf8').includes('archive secret title'), false)

  const info = capture()
  assert.equal(await runCli(['archive-info', archiveFile, '--json'], info.io, root), 0)
  assert.equal(info.read().encryptedPayloadInspected, false)
  const verified = capture()
  assert.equal(await runCli(['archive-verify', archiveFile, '--json'], verified.io, root, { environment }), 0)
  assert.equal(verified.read().verified, true)
  assert.equal(JSON.stringify(verified.read()).includes('archive secret body'), false)
  await assert.rejects(
    () => runCli(['archive-verify', archiveFile], capture().io, root, { environment: { LACIFY_ARCHIVE_PASSPHRASE: 'wrong archive passphrase value' } }),
    /authentication failed/,
  )

  const tamperedFile = path.join(destinationRoot, 'tampered.lacify.enc')
  const tampered = Buffer.from(encrypted)
  tampered[Math.floor(tampered.length / 2)] ^= 1
  await writeFile(tamperedFile, tampered)
  await assert.rejects(() => runCli(['archive-verify', tamperedFile], capture().io, root, { environment }), /authentication failed/)

  const recovered = path.join(destinationRoot, 'recovered-project')
  await assert.rejects(() => runCli(['archive-restore', archiveFile, '--target', recovered], capture().io, root, { environment }), /Explicit approval/)
  const restored = capture()
  assert.equal(await runCli(['archive-restore', archiveFile, '--target', recovered, '--approve', '--json'], restored.io, root, { environment }), 0)
  assert.equal(restored.read().existingProjectOverwritten, false)
  await assert.rejects(() => runCli(['archive-restore', archiveFile, '--target', recovered, '--approve'], capture().io, root, { environment }), /already exists/)
  const restoredProject = await loadRuntimeProject(path.join(recovered, 'lacify.runtime.yaml'))
  assert.equal(restoredProject.fingerprint, creation.projectFingerprint)
  const restoredDatabase = new DatabaseSync(path.join(recovered, '.lacify', 'development', 'development', 'Workspace.sqlite'), { readOnly: true })
  assert.equal(restoredDatabase.prepare('SELECT title FROM notes WHERE id = ?').get('archive-private').title, 'archive secret title')
  restoredDatabase.close()
  const active = new DatabaseSync(activeFile, { readOnly: true })
  assert.equal(active.prepare('SELECT body FROM notes WHERE id = ?').get('archive-private').body, 'archive secret body')
  active.close()
})
