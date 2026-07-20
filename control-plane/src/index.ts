export interface Env {
  DB: D1Database
  SESSION_ENCRYPTION_KEY: string
  ALLOWED_ORIGIN?: string
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

function withCors(request: Request, response: Response, env: Env) {
  const origin = request.headers.get('origin')
  if (!origin || !env.ALLOWED_ORIGIN || origin !== env.ALLOWED_ORIGIN) return response
  const headers = new Headers(response.headers)
  headers.set('access-control-allow-origin', origin)
  headers.set('access-control-allow-credentials', 'true')
  headers.set('vary', 'origin')
  return new Response(response.body, { status: response.status, headers })
}

function cookie(request: Request, name: string) {
  return request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1)
}

async function sessionFor(request: Request, env: Env) {
  const id = cookie(request, 'lacify_uplink_session')
  if (!id) return null
  return env.DB.prepare('SELECT id, account_id, account_name, expires_at, revoked_at FROM sessions WHERE id = ?').bind(id).first<{ id: string; account_id: string; account_name: string; expires_at: number; revoked_at: number | null }>()
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return withCors(request, new Response(null, { status: 204, headers: { 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type' } }), env)
    const url = new URL(request.url)
    if (url.pathname === '/health') {
      try {
        await env.DB.prepare('SELECT 1').first()
        return withCors(request, json({ ok: true, service: 'lacify-control-plane' }), env)
      } catch {
        return withCors(request, json({ ok: false, service: 'lacify-control-plane' }, 503), env)
      }
    }
    if (url.pathname === '/api/uplink-session' && request.method === 'GET') {
      const session = await sessionFor(request, env)
      if (!session || session.revoked_at || session.expires_at <= Date.now()) return withCors(request, json({ success: false, connected: false }, 401), env)
      return withCors(request, json({ success: true, connected: true, accountName: session.account_name, expiresAt: session.expires_at }), env)
    }
    if (url.pathname === '/api/monitor-overview' && request.method === 'GET') {
      const project = url.searchParams.get('project')
      if (!project) return withCors(request, json({ success: false, message: 'project is required' }, 400), env)
      const [contracts, deployments, events] = await Promise.all([
        env.DB.prepare('SELECT id, document FROM contracts WHERE project_id = ?').bind(project).all<{ id: string; document: string }>(),
        env.DB.prepare('SELECT environment, status, updated_at FROM deployments WHERE project_id = ? ORDER BY updated_at DESC LIMIT 10').bind(project).all(),
        env.DB.prepare('SELECT object_id, action, level, message, occurred_at FROM runtime_events WHERE project_id = ? ORDER BY occurred_at DESC LIMIT 50').bind(project).all(),
      ])
      return withCors(request, json({ success: true, contracts: contracts.results, deployments: deployments.results, events: events.results }), env)
    }
    return withCors(request, json({ success: false, message: 'Not found' }, 404), env)
  },
}
