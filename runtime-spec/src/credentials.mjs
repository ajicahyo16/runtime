import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const service = 'dev.lacify.cli'

export async function storeCredential(account, token, { platform = process.platform, exec = execFileAsync } = {}) {
  if (!account || !token) throw new Error('Account and credential are required.')
  if (platform === 'darwin') {
    await exec('security', ['add-generic-password', '-U', '-a', account, '-s', service, '-w', token])
    return
  }
  if (platform === 'linux') {
    await exec('secret-tool', ['store', '--label=Lacify CLI', 'service', service, 'account', account], { input: token })
    return
  }
  throw new Error('No protected credential store is available on this operating system.')
}

export async function readCredential(account, { platform = process.platform, exec = execFileAsync } = {}) {
  if (platform === 'darwin') return (await exec('security', ['find-generic-password', '-a', account, '-s', service, '-w'])).stdout.trim()
  if (platform === 'linux') return (await exec('secret-tool', ['lookup', 'service', service, 'account', account])).stdout.trim()
  throw new Error('No protected credential store is available on this operating system.')
}

export async function deleteCredential(account, { platform = process.platform, exec = execFileAsync } = {}) {
  if (platform === 'darwin') await exec('security', ['delete-generic-password', '-a', account, '-s', service])
  else if (platform === 'linux') await exec('secret-tool', ['clear', 'service', service, 'account', account])
  else throw new Error('No protected credential store is available on this operating system.')
}
