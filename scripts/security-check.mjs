import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => file && !file.endsWith('.woff2') && !file.endsWith('.png') && !file.endsWith('.lock') && !file.endsWith('.sqlite'))

const forbidden = [
  { name: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'hard-coded bearer credential', pattern: /authorization\s*:\s*['"`]Bearer [A-Za-z0-9_-]{40,}/i },
  { name: 'hard-coded session encryption key', pattern: /SESSION_ENCRYPTION_KEY\s*=\s*['"][A-Za-z0-9_-]{40,}/ },
]

const findings = []
for (const file of files) {
  const content = readFileSync(file, 'utf8')
  for (const rule of forbidden) if (rule.pattern.test(content)) findings.push(`${file}: ${rule.name}`)
}

assert.deepEqual(findings, [], `Security scan failed:\n${findings.join('\n')}`)

const hosting = readFileSync('hosting/worker.js', 'utf8')
for (const header of ['content-security-policy', 'strict-transport-security', 'x-content-type-options', 'x-frame-options', 'permissions-policy']) {
  assert.match(hosting, new RegExp(`['"]${header}['"]`), `Missing ${header}`)
}

console.log(`Security scan passed across ${files.length} tracked and untracked workspace text files.`)
