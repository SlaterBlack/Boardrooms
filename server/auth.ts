import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const COOKIE_NAME = 'boardmeetings_session'
const SESSION_SECONDS = 7 * 24 * 60 * 60

function signature(password: string, expiresAt: number): string {
  return createHmac('sha256', password).update(String(expiresAt)).digest('base64url')
}

function equalText(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest()
  const rightHash = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftHash, rightHash)
}

export function matchesAccessPassword(candidate: string, password: string): boolean {
  return equalText(candidate, password)
}

export function hasValidSession(
  cookieHeader: string | undefined,
  password: string,
  now = Date.now(),
): boolean {
  const cookie = cookieHeader
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
  if (!cookie) return false

  const token = cookie.slice(COOKIE_NAME.length + 1)
  const separator = token.indexOf('.')
  if (separator < 1) return false

  const expiresAt = Number(token.slice(0, separator))
  const providedSignature = token.slice(separator + 1)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)) {
    return false
  }

  return equalText(providedSignature, signature(password, expiresAt))
}

export function createSessionCookie(
  password: string,
  now = Date.now(),
  secure = false,
): string {
  const expiresAt = Math.floor(now / 1000) + SESSION_SECONDS
  const secureAttribute = secure ? '; Secure' : ''
  return `${COOKIE_NAME}=${expiresAt}.${signature(password, expiresAt)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secureAttribute}`
}

export function clearSessionCookie(secure = false): string {
  const secureAttribute = secure ? '; Secure' : ''
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureAttribute}`
}
