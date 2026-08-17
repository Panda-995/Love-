import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import { deleteCookie, getCookie, getHeader, setCookie } from 'h3'
import { newId, nowIso, one, run, transaction } from './db'

const COOKIE_NAME = 'love_session'
const SESSION_DAYS = 30

type UserContext = {
  id: string
  username: string
  displayName: string
  avatarUrl: string | null
  coupleId: string | null
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function deriveSecret(value: string, salt: string) {
  return scryptSync(value, Buffer.from(salt, 'hex'), 64).toString('hex')
}

function secureEqual(left: string, right: string) {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function validateUsername(value: unknown) {
  const username = String(value || '').trim().toLowerCase()
  if (!/^[a-z0-9_]{4,20}$/.test(username)) throw createError({ statusCode: 400, statusMessage: '账号名需要 4-20 位字母、数字或下划线' })
  return username
}

export function validatePassword(value: unknown) {
  const password = String(value || '')
  if (password.length < 8 || password.length > 128) throw createError({ statusCode: 400, statusMessage: '密码需要 8-128 位' })
  return password
}

export function hashSecret(value: string) {
  const salt = randomBytes(16).toString('hex')
  return { salt, hash: deriveSecret(value, salt) }
}

export function verifySecret(value: string, salt: string, expected: string) {
  try { return secureEqual(deriveSecret(value, salt), expected) } catch { return false }
}

function recoveryCode() {
  const raw = randomBytes(8).toString('hex').toUpperCase()
  return raw.match(/.{1,4}/g)!.join('-')
}

function sessionCookieOptions(event: H3Event, expires: Date) {
  const forwarded = String(getHeader(event, 'x-forwarded-proto') || '').split(',')[0]?.trim()
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: forwarded === 'https',
    path: '/',
    expires,
  }
}

export function createSession(event: H3Event, userId: string) {
  const token = randomBytes(32).toString('base64url')
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000)
  run('DELETE FROM sessions WHERE expires_at <= ?', nowIso())
  run('INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES(?,?,?,?)', digest(token), userId, expires.toISOString(), nowIso())
  run(`DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (
    SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 10
  )`, userId, userId)
  setCookie(event, COOKIE_NAME, token, sessionCookieOptions(event, expires))
}

export function revokeOtherSessions(event: H3Event, userId: string) {
  const token = getCookie(event, COOKIE_NAME)
  if (!token) return
  run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', userId, digest(token))
}

export function destroySession(event: H3Event) {
  const token = getCookie(event, COOKIE_NAME)
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', digest(token))
  deleteCookie(event, COOKIE_NAME, { path: '/' })
}

export function userFromSessionToken(token: string | undefined | null): UserContext | null {
  if (!token) return null
  const row = one<any>(`SELECT u.id, u.username, p.display_name, p.avatar_url, cm.couple_id
    FROM sessions s JOIN users u ON u.id=s.user_id JOIN profiles p ON p.id=u.id
    LEFT JOIN couple_members cm ON cm.user_id=u.id
    WHERE s.token_hash=? AND s.expires_at>?`, digest(token), nowIso())
  return row ? { id: row.id, username: row.username, displayName: row.display_name, avatarUrl: row.avatar_url || null, coupleId: row.couple_id || null } : null
}

export function getUser(event: H3Event) {
  return userFromSessionToken(getCookie(event, COOKIE_NAME))
}

export function requireUser(event: H3Event) {
  const user = getUser(event)
  if (!user) throw createError({ statusCode: 401, statusMessage: '请先登录' })
  return user
}

export function requireSameOrigin(event: H3Event) {
  const origin = getHeader(event, 'origin')
  if (!origin) return
  const host = getHeader(event, 'x-forwarded-host') || getHeader(event, 'host')
  if (!host) return
  let originHost = ''
  try { originHost = new URL(origin).host } catch { throw createError({ statusCode: 403, statusMessage: '请求来源无效' }) }
  if (originHost !== host) throw createError({ statusCode: 403, statusMessage: '拒绝跨站请求' })
}

export function registerLocalAccount(displayNameValue: unknown, usernameValue: unknown, passwordValue: unknown) {
  const username = validateUsername(usernameValue)
  const password = validatePassword(passwordValue)
  const displayName = String(displayNameValue || '').trim()
  if (!displayName || displayName.length > 40) throw createError({ statusCode: 400, statusMessage: '称呼需要 1-40 个字符' })
  if (one('SELECT id FROM users WHERE username = ?', username)) throw createError({ statusCode: 409, statusMessage: '这个账号名已经被使用' })
  const id = newId()
  const passwordSecret = hashSecret(password)
  const code = recoveryCode()
  const recoverySecret = hashSecret(code.replaceAll('-', ''))
  transaction(() => {
    run('INSERT INTO users(id,username,password_hash,password_salt,recovery_hash,recovery_salt,created_at) VALUES(?,?,?,?,?,?,?)', id, username, passwordSecret.hash, passwordSecret.salt, recoverySecret.hash, recoverySecret.salt, nowIso())
    run('INSERT INTO profiles(id,display_name,created_at) VALUES(?,?,?)', id, displayName, nowIso())
  })
  return { id, username, recoveryCode: code }
}

export function authenticateLocalAccount(usernameValue: unknown, passwordValue: unknown) {
  const username = validateUsername(usernameValue)
  const password = String(passwordValue || '')
  const row = one<any>('SELECT id,password_hash,password_salt FROM users WHERE username = ?', username)
  if (!row || !verifySecret(password, row.password_salt, row.password_hash)) throw createError({ statusCode: 401, statusMessage: '账号名或密码错误' })
  return String(row.id)
}

export function recoverLocalAccount(usernameValue: unknown, recoveryValue: unknown, passwordValue: unknown) {
  const username = validateUsername(usernameValue)
  const newPassword = validatePassword(passwordValue)
  const recovery = String(recoveryValue || '').replaceAll('-', '').trim().toUpperCase()
  const row = one<any>('SELECT id,recovery_hash,recovery_salt FROM users WHERE username = ?', username)
  if (!row || !verifySecret(recovery, row.recovery_salt, row.recovery_hash)) throw createError({ statusCode: 401, statusMessage: '账号名或恢复码错误' })
  const next = hashSecret(newPassword)
  run('UPDATE users SET password_hash=?,password_salt=? WHERE id=?', next.hash, next.salt, row.id)
  run('DELETE FROM sessions WHERE user_id=?', row.id)
}

export function updateLocalPassword(userId: string, passwordValue: unknown) {
  const password = validatePassword(passwordValue)
  const next = hashSecret(password)
  run('UPDATE users SET password_hash=?,password_salt=? WHERE id=?', next.hash, next.salt, userId)
}

export function cookieFromRequest(request: Request) {
  const cookie = request.headers.get('cookie') || ''
  const item = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`))
  return item ? decodeURIComponent(item.slice(COOKIE_NAME.length + 1)) : ''
}
