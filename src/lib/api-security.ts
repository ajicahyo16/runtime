function cookieValue(name: string) {
  return document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

export function installApiSecurity() {
  const nativeFetch = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null
    const url = new URL(request?.url || String(input), window.location.origin)
    const method = (init?.method || request?.method || 'GET').toUpperCase()
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/') || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return nativeFetch(input, init)
    }
    const csrf = cookieValue('lacify_csrf')
    const headers = new Headers(request?.headers || init?.headers)
    if (csrf) headers.set('x-csrf-token', csrf)
    if (request) return nativeFetch(new Request(request, { ...init, headers }))
    return nativeFetch(input, { ...init, headers })
  }
}
