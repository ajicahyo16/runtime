#!/usr/bin/env node
import { runCli } from '../runtime-spec/src/cli.mjs'

try {
  process.exitCode = await runCli(process.argv.slice(2))
} catch (error) {
  const json = process.argv.includes('--json')
  const diagnostic = {
    error: error instanceof Error ? error.message : 'Unknown CLI error.',
    diagnostics: error?.diagnostics || [],
    recovery: 'Fix the reported repository issue, run lacify validate, then run lacify plan again.',
  }
  process.stderr.write(`${json ? JSON.stringify(diagnostic, null, 2) : `${diagnostic.error}\n${diagnostic.diagnostics.map((item) => `${item.file}:${item.line || 1} ${item.message}`).join('\n')}\nRecovery: ${diagnostic.recovery}`}\n`)
  process.exitCode = 1
}
