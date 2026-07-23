import { createServer } from 'node:http'
import { watch as watchFiles } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { executeLocalCommand, executeLocalOperation } from './local-runtime.mjs'

async function readJson(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (Buffer.byteLength(body, 'utf8') > 70 * 1024) throw new Error('Request body exceeds 70 KiB.')
  }
  return JSON.parse(body || '{}')
}

function send(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

export async function createLocalDevServer(project, { port = 8788, hostname = '127.0.0.1', watchRoot = null, reloadProject = null } = {}) {
  let activeProject = project
  let reloadDiagnostics = null
  let generation = 1
  let watcher = null
  let reloadTimer = null
  const databases = new Map()
  function closeDatabases() {
    for (const database of databases.values()) database.close()
    databases.clear()
  }
  function databaseFor(actor, partition) {
    const key = `${actor.definition.name}:${partition}`
    if (!databases.has(key)) {
      const database = new DatabaseSync(':memory:')
      for (const migration of actor.migrations) database.exec(migration.sql)
      const seed = activeProject.developmentSeeds?.find(({ actor: actorName }) => actorName === actor.definition.name)
      if (seed) database.exec(seed.sql)
      databases.set(key, database)
    }
    return databases.get(key)
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${hostname}:${port}`)
    if (request.method === 'GET' && url.pathname === '/health') return send(response, reloadDiagnostics ? 503 : 200, {
      ok: !reloadDiagnostics,
      service: 'lacify-local-runtime',
      generation,
      fingerprint: activeProject.fingerprint,
      diagnostics: reloadDiagnostics,
    })
    if (reloadDiagnostics) return send(response, 503, { error: 'Project reload validation failed', diagnostics: reloadDiagnostics })
    if (request.method !== 'POST') return send(response, 405, { error: 'Method not allowed' })
    const parts = url.pathname.split('/')
    if (parts[1] !== 'v1' || !parts[2] || !parts[3]) return send(response, 404, { error: 'Not found' })
    const actor = activeProject.project.actors.find(({ definition }) => `${definition.name.toLowerCase()}s` === parts[2])
    if (!actor) return send(response, 404, { error: 'Unknown Actor' })
    const partition = decodeURIComponent(parts[3])
    try {
      const body = await readJson(request)
      const database = databaseFor(actor, partition)
      if (parts[4] === 'commands' && typeof body.command === 'string') {
        const operation = actor.operations.find(({ definition }) => definition.name === body.command && definition.kind === 'command')
        const result = operation
          ? executeLocalOperation(database, actor, { partition, operation: body.command, input: body.payload || {}, idempotencyKey: request.headers['idempotency-key'] || null })
          : executeLocalCommand(database, actor.definition, { partition, command: body.command, input: body.payload || {} })
        return send(response, 200, result)
      }
      if (parts[4] === 'queries' && parts[5]) {
        const result = executeLocalOperation(database, actor, { partition, operation: decodeURIComponent(parts[5]), input: body.input || {}, page: body.page ?? null })
        return send(response, 200, result)
      }
      return send(response, 404, { error: 'Not found' })
    } catch (error) {
      const code = error?.code || (error instanceof SyntaxError ? 'invalid_json' : 'local_runtime_error')
      const message = error?.code || error instanceof SyntaxError ? error.message : 'Local runtime request failed.'
      return send(response, 400, { success: false, error: { code, message, ...(error?.field ? { field: error.field } : {}) } })
    }
  })
  server.reload = async () => {
    if (!reloadProject) return { reloaded: false, reason: 'reload_not_configured' }
    const next = await reloadProject()
    if (!next.valid) {
      reloadDiagnostics = next.issues.slice(0, 50)
      return { reloaded: false, diagnostics: reloadDiagnostics }
    }
    activeProject = next
    reloadDiagnostics = null
    generation += 1
    closeDatabases()
    return { reloaded: true, generation, fingerprint: next.fingerprint }
  }
  if (watchRoot && reloadProject) {
    try {
      watcher = watchFiles(watchRoot, { recursive: true }, (_event, filename) => {
        if (!filename || /(?:^|\/)(?:\.lacify|generated|node_modules)(?:\/|$)/.test(filename)) return
        clearTimeout(reloadTimer)
        reloadTimer = setTimeout(() => { server.reload().catch(() => {}) }, 80)
      })
      server.hotReload = true
    } catch {
      server.hotReload = false
    }
  } else {
    server.hotReload = false
  }
  server.on('close', () => {
    clearTimeout(reloadTimer)
    watcher?.close()
    closeDatabases()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, hostname, resolve)
  })
  return server
}
