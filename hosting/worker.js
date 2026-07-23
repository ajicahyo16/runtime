const defaultControlApiUrl = 'https://lacify-control-plane.ajicayo16.workers.dev'
const defaultUiOrigin = 'https://runtime.getlacify.com'
const securityHeaders = {
  'content-security-policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; upgrade-insecure-requests",
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
}

function secure(response) {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

async function proxyControlApi(request, env) {
  const incomingUrl = new URL(request.url)
  const upstreamUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, env.CONTROL_API_URL || defaultControlApiUrl)
  const headers = new Headers(request.headers)
  headers.delete('host')
  // The browser talks to this Worker on the UI origin. Forward the canonical
  // UI origin so the Control API can retain strict state-change origin checks.
  headers.set('origin', env.CONTROL_UI_ORIGIN || defaultUiOrigin)
  headers.set('x-forwarded-host', incomingUrl.host)

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const upstreamRequest = new Request(upstreamUrl, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: 'manual',
  })
  return fetch(upstreamRequest)
}

async function serveApp(request, env) {
  const response = await env.ASSETS.fetch(request)
  if (response.status !== 404 || request.method !== 'GET') return secure(response)
  const accept = request.headers.get('accept') || ''
  if (!accept.includes('text/html')) return secure(response)
  return secure(await env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request)))
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return secure(await proxyControlApi(request, env))
    return serveApp(request, env)
  },
}
