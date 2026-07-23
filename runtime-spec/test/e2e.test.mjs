import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { runCli } from '../src/cli.mjs'
import { executeLocalCommand, readLocalCommandReceipt } from '../src/local-runtime.mjs'
import { LacifyMcpService } from '../src/mcp-service.mjs'

function capture() {
  let value = ''
  return { io: { stdout: { write: (chunk) => { value += chunk } } }, read: () => JSON.parse(value) }
}

test('end-to-end repository, MCP, Development apply, command, forward migration, and reproducibility workflow', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lacify-e2e-'))
  await runCli(['init', '--project', 'personal-platform'], capture().io, root)
  const mcp = new LacifyMcpService({ root, role: 'owner', user: 'e2e-user' })
  assert.equal((await mcp.callTool('validate_project_files')).valid, true)
  const firstPlan = await mcp.callTool('plan_migration')
  await mcp.callTool('apply_development_plan', {
    approved: true,
    planId: firstPlan.plans[0].planId,
    projectFingerprint: firstPlan.projectFingerprint,
  })

  const actor = (await mcp.callTool('get_project')).actors[0]
  const databaseFile = path.join(root, '.lacify', 'development', 'development', 'Aggregate.sqlite')
  const database = new DatabaseSync(databaseFile)
  const command = executeLocalCommand(database, actor, { partition: 'customer-visible-id', command: 'Create', input: { name: 'private value' } })
  assert.equal(readLocalCommandReceipt(database, command.receipt.id).command, 'Create')
  assert.equal(JSON.stringify(readLocalCommandReceipt(database, command.receipt.id)).includes('private value'), false)
  database.close()

  await writeFile(path.join(root, 'actors', 'aggregate', 'migrations', '0002_add_status.sql'), 'ALTER TABLE aggregate_state ADD COLUMN status TEXT;\n')
  const secondPlan = await mcp.callTool('plan_migration')
  assert.deepEqual(secondPlan.plans[0].pending.map(({ id }) => id), ['0002_add_status'])
  await mcp.callTool('apply_development_plan', {
    approved: true,
    planId: secondPlan.plans[0].planId,
    projectFingerprint: secondPlan.projectFingerprint,
  })
  assert.equal((await mcp.callTool('get_migration_history'))[0].entries.length, 2)
  await assert.rejects(() => runCli(['apply', '--env', 'production', '--approve'], capture().io, root), /restricted to Development/)

  const clean = await mkdtemp(path.join(tmpdir(), 'lacify-clean-'))
  await runCli(['init', '--project', 'personal-platform'], capture().io, clean)
  await writeFile(path.join(clean, 'actors', 'aggregate', 'migrations', '0002_add_status.sql'), 'ALTER TABLE aggregate_state ADD COLUMN status TEXT;\n')
  const originalActor = await readFile(path.join(root, 'actors', 'aggregate', 'actor.yaml'), 'utf8')
  await writeFile(path.join(clean, 'actors', 'aggregate', 'actor.yaml'), originalActor)
  const original = capture()
  const replay = capture()
  await runCli(['validate', '--json'], original.io, root)
  await runCli(['validate', '--json'], replay.io, clean)
  assert.equal(original.read().fingerprint, replay.read().fingerprint)
})
