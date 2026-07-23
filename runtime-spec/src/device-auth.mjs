import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { storeCredential } from './credentials.mjs'

const execFileAsync = promisify(execFile)

async function defaultOpen(url) {
  if (process.platform === 'darwin') return execFileAsync('open', [url])
  if (process.platform === 'win32') return execFileAsync('cmd', ['/c', 'start', '', url])
  return execFileAsync('xdg-open', [url])
}

export async function deviceLogin({
  baseUrl = 'https://api.runtime.getlacify.com',
  fetchImpl = fetch,
  openBrowser = defaultOpen,
  store = storeCredential,
  notify = () => {},
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  maxPolls = 120,
} = {}) {
  const start = await fetchImpl(`${baseUrl}/api/cli/device`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  if (!start.ok) throw new Error(`Unable to start browser authentication (${start.status}).`)
  const challenge = await start.json()
  notify(`Open ${challenge.verificationUri} and enter code ${challenge.userCode}.`)
  await openBrowser(challenge.verificationUri)
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    await wait(Math.max(1, Number(challenge.intervalSeconds || 2)) * 1000)
    const response = await fetchImpl(`${baseUrl}/api/cli/device/${encodeURIComponent(challenge.deviceCode)}`, { headers: { accept: 'application/json' } })
    if (response.status === 202) continue
    if (!response.ok) throw new Error(`Browser authentication failed (${response.status}).`)
    const credential = await response.json()
    await store(credential.account, credential.accessToken)
    return { account: credential.account, expiresAt: credential.expiresAt }
  }
  throw new Error('Browser authentication timed out; start lacify login again.')
}
