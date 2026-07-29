import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { readCredential } from './credentials.mjs'

export function configPath() {
  return path.join(homedir(), '.config', 'lacify', 'config.json')
}

export async function saveCliProfile(profile, file = configPath()) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 })
}

export async function deleteCliProfile(file = configPath()) {
  await rm(file, { force: true })
}

export async function remoteClient({ fetchImpl = fetch, credentialReader = readCredential, file = configPath() } = {}) {
  const profile = JSON.parse(await readFile(file, 'utf8'))
  const token = await credentialReader(profile.account)
  async function request(pathname, init = {}) {
    const response = await fetchImpl(`${profile.baseUrl}${pathname}`, {
      ...init,
      headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...init.headers },
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      const error = new Error(data?.message || `Control Plane request failed (${response.status}).`)
      error.name = 'LacifyControlPlaneError'
      error.status = response.status
      error.code = data?.error?.code || data?.code || 'control_plane_request_failed'
      error.retryable = response.status === 429 || response.status >= 500
        || /D1 DB exceeded its CPU time limit|temporar|timeout|reset/i.test(error.message)
      throw error
    }
    return data
  }
  return { profile, request }
}
