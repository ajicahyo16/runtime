export const applicationSessionLifetimeMs = 8 * 60 * 60 * 1000
export const applicationSessionRefreshWindowMs = 2 * 60 * 60 * 1000
export const authenticationWindowMs = 15 * 60 * 1000
export const authenticationBlockMs = 15 * 60 * 1000
export const authenticationMaxFailures = 5

export function requestCookie(request: Request, name: string) {
  return request.headers.get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

export function originAllowed(request: Request, allowedOrigins: Array<string | undefined>) {
  const origin = request.headers.get('origin')
  return !origin || allowedOrigins.filter(Boolean).includes(origin)
}

export function csrfTokens(request: Request) {
  return {
    header: request.headers.get('x-csrf-token') || '',
    cookie: requestCookie(request, 'lacify_csrf') || '',
  }
}
export function validOpaqueToken(value: string) {
  return /^[A-Za-z0-9_-]{40,100}$/.test(value)
}

export function validCsrfPair(header: string, cookie: string) {
  return validOpaqueToken(header) && header === cookie
}

export function authenticationBlocked(
  record: { window_started_at: number; failure_count: number; blocked_until: number | null } | null,
  timestamp: number,
) {
  return Boolean(record?.blocked_until && record.blocked_until > timestamp)
}

export function nextAuthenticationFailure(
  record: { window_started_at: number; failure_count: number } | null,
  timestamp: number,
) {
  const withinWindow = Boolean(record && record.window_started_at > timestamp - authenticationWindowMs)
  const failureCount = withinWindow ? Number(record?.failure_count || 0) + 1 : 1
  return {
    windowStartedAt: withinWindow ? Number(record?.window_started_at) : timestamp,
    failureCount,
    blockedUntil: failureCount >= authenticationMaxFailures ? timestamp + authenticationBlockMs : null,
  }
}
