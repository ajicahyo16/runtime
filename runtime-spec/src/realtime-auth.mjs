const encoder = new TextEncoder()
const decoder = new TextDecoder()
const tokenPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const identifierPattern = /^[A-Za-z0-9._:-]{1,128}$/
const roomPattern = /^[A-Za-z0-9._~-]{1,128}$/

export class RealtimeAuthError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RealtimeAuthError'
    this.code = code
  }
}

function bytesToBase64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function base64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new RealtimeAuthError('token_format', 'Realtime token is malformed.')
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  try {
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
  } catch {
    throw new RealtimeAuthError('token_format', 'Realtime token is malformed.')
  }
}

function encodeJson(value) {
  return bytesToBase64Url(encoder.encode(JSON.stringify(value)))
}

function decodeJson(value) {
  try {
    return JSON.parse(decoder.decode(base64UrlToBytes(value)))
  } catch (error) {
    if (error instanceof RealtimeAuthError) throw error
    throw new RealtimeAuthError('token_format', 'Realtime token is malformed.')
  }
}

async function hmacKey(secret, usage) {
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 4096) throw new RealtimeAuthError('token_secret', 'Realtime token secret is unavailable.')
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

function validateClaims(claims) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new RealtimeAuthError('token_claims', 'Realtime token claims are invalid.')
  if (claims.v !== 1) throw new RealtimeAuthError('token_version', 'Realtime token version is unsupported.')
  for (const field of ['sub', 'aud', 'env', 'roomClass', 'cid', 'jti']) {
    if (typeof claims[field] !== 'string' || !identifierPattern.test(claims[field])) throw new RealtimeAuthError('token_claims', `Realtime token claim "${field}" is invalid.`)
  }
  if (typeof claims.room !== 'string' || !roomPattern.test(claims.room)) throw new RealtimeAuthError('token_claims', 'Realtime token room is invalid.')
  if (!Array.isArray(claims.capabilities) || claims.capabilities.length < 1 || claims.capabilities.length > 8 || claims.capabilities.some((value) => typeof value !== 'string' || !identifierPattern.test(value))) {
    throw new RealtimeAuthError('token_claims', 'Realtime token capabilities are invalid.')
  }
  if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) throw new RealtimeAuthError('token_claims', 'Realtime token timestamps are invalid.')
  return claims
}

export async function mintRealtimeToken({ secret, claims, now = Math.floor(Date.now() / 1000), ttlSeconds = 300 }) {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 10 || ttlSeconds > 300) throw new RealtimeAuthError('token_ttl', 'Realtime tokens must live for 10–300 seconds.')
  const normalized = validateClaims({ ...claims, v: 1, iat: now, exp: now + ttlSeconds })
  const header = encodeJson({ alg: 'HS256', typ: 'LRT' })
  const payload = encodeJson(normalized)
  const signingInput = `${header}.${payload}`
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(signingInput))
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`
}

export async function verifyRealtimeToken(token, { secret, expected, now = Math.floor(Date.now() / 1000) }) {
  if (typeof token !== 'string' || token.length > 4096 || !tokenPattern.test(token)) throw new RealtimeAuthError('token_format', 'Realtime token is malformed.')
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.')
  const header = decodeJson(encodedHeader)
  if (header?.alg !== 'HS256' || header?.typ !== 'LRT') throw new RealtimeAuthError('token_header', 'Realtime token header is invalid.')
  const validSignature = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret, 'verify'),
    base64UrlToBytes(encodedSignature),
    encoder.encode(`${encodedHeader}.${encodedPayload}`),
  )
  if (!validSignature) throw new RealtimeAuthError('token_signature', 'Realtime token signature is invalid.')
  const claims = validateClaims(decodeJson(encodedPayload))
  if (claims.iat > now + 30 || claims.exp <= now || claims.exp - claims.iat > 300) throw new RealtimeAuthError('token_expired', 'Realtime token is expired or outside its lifetime bound.')
  for (const [field, value] of Object.entries(expected || {})) {
    if (value !== undefined && claims[field] !== value) throw new RealtimeAuthError('token_audience', 'Realtime token audience does not match this room.')
  }
  return claims
}

export function realtimeTokenFromRequest(request) {
  const authorization = request.headers.get('authorization') || ''
  if (authorization.startsWith('Bearer ')) return { token: authorization.slice(7), protocol: null }
  const protocols = (request.headers.get('sec-websocket-protocol') || '').split(',').map((value) => value.trim()).filter(Boolean)
  const credential = protocols.find((value) => value.startsWith('lacify.token.'))
  return { token: credential ? credential.slice('lacify.token.'.length) : '', protocol: protocols.includes('lacify.realtime.v1') ? 'lacify.realtime.v1' : null }
}

export async function hashRealtimeIdentity(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
