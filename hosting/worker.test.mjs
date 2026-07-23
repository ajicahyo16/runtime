import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './worker.js'

test('proxies API requests to the Control API with the canonical UI origin', async (context) => {
  const originalFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (request) => {
    assert.equal(request.url, 'https://control.example/api/projects?limit=1')
    assert.equal(request.headers.get('origin'), 'https://runtime.getlacify.com')
    assert.equal(request.headers.get('cookie'), 'lacify_uplink_session=session-test')
    assert.deepEqual(await request.json(), { name: 'Retail' })
    return Response.json({ success: true }, { headers: { 'set-cookie': 'lacify_uplink_session=new-session; Path=/; HttpOnly; Secure; SameSite=Strict' } })
  }

  const response = await worker.fetch(new Request('https://site.example/api/projects?limit=1', {
    method: 'POST',
    headers: { cookie: 'lacify_uplink_session=session-test', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Retail' }),
  }), {
    CONTROL_API_URL: 'https://control.example',
    CONTROL_UI_ORIGIN: 'https://runtime.getlacify.com',
  })

  assert.equal(response.status, 200)
  assert.match(response.headers.get('set-cookie') || '', /SameSite=Strict/)
})

test('serves the SPA entry point for an unknown browser route', async () => {
  const requested = []
  const response = await worker.fetch(new Request('https://site.example/releases', { headers: { accept: 'text/html' } }), {
    ASSETS: {
      fetch: async (request) => {
        requested.push(new URL(request.url).pathname)
        return new URL(request.url).pathname === '/index.html'
          ? new Response('<div id="root"></div>', { headers: { 'content-type': 'text/html' } })
          : new Response('Not found', { status: 404 })
      },
    },
  })

  assert.equal(response.status, 200)
  assert.deepEqual(requested, ['/releases', '/index.html'])
})
