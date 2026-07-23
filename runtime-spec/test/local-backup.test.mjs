import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { runCli } from '../src/cli.mjs'

function capture() {
  let value = ''
  return { io: { stdout: { write: (chunk) => { value += chunk } } }, read: () => JSON.parse(value) }
}

test('local snapshots preserve private SQLite data while returning metadata only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-backup-'))
  await runCli(['init', '--project', 'backup-project', '--template', 'personal'], capture().io, root)
  const reviewed = capture()
  await runCli(['review', '--json'], reviewed.io, root)
  const reviewId = reviewed.read().receipt.reviewId
  await runCli(['apply-review', '--review', reviewId, '--approve'], capture().io, root)

  const activeFile = path.join(root, '.lacify', 'development', 'development', 'Workspace.sqlite')
  const database = new DatabaseSync(activeFile)
  database.prepare('INSERT INTO notes (id, workspace_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    'private-note', 'private-workspace', 'private title', 'private body', 1, 1,
  )
  database.close()

  await assert.rejects(() => runCli(['snapshot'], capture().io, root), /Explicit approval/)
  const created = capture()
  assert.equal(await runCli(['snapshot', '--approve', '--json'], created.io, root), 0)
  const snapshot = created.read().snapshot
  assert.match(snapshot.snapshotId, /^snapshot_[a-f0-9-]{36}$/)
  assert.equal(snapshot.containsBusinessData, true)
  assert.equal(JSON.stringify(snapshot).includes('private title'), false)

  const listed = capture()
  assert.equal(await runCli(['snapshots', '--json'], listed.io, root), 0)
  assert.equal(listed.read().snapshots[0].snapshotId, snapshot.snapshotId)

  const verified = capture()
  assert.equal(await runCli(['verify-snapshot', '--snapshot', snapshot.snapshotId, '--json'], verified.io, root), 0)
  assert.equal(verified.read().verified, true)
  assert.equal(JSON.stringify(verified.read()).includes('private body'), false)

  await assert.rejects(() => runCli(['rehearse-restore', '--snapshot', snapshot.snapshotId], capture().io, root), /Explicit approval/)
  const rehearsal = capture()
  assert.equal(await runCli(['rehearse-restore', '--snapshot', snapshot.snapshotId, '--approve', '--json'], rehearsal.io, root), 0)
  assert.equal(rehearsal.read().activeDevelopmentOverwritten, false)
  const unchanged = new DatabaseSync(activeFile, { readOnly: true })
  assert.equal(unchanged.prepare('SELECT title FROM notes WHERE id = ?').get('private-note').title, 'private title')
  unchanged.close()

  const snapshotFile = path.join(root, '.lacify', 'backups', snapshot.snapshotId, 'actors', 'Workspace.sqlite')
  await appendFile(snapshotFile, 'tampered')
  const invalid = capture()
  assert.equal(await runCli(['verify-snapshot', '--snapshot', snapshot.snapshotId, '--json'], invalid.io, root), 2)
  assert.equal(invalid.read().verified, false)
})
