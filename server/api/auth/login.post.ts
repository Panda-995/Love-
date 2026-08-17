import { authenticateLocalAccount, createSession, requireSameOrigin } from '../../utils/auth'
import { nowIso, run } from '../../utils/db'

export default defineEventHandler(async event => {
  requireSameOrigin(event)
  const body = await readBody(event)
  const userId = authenticateLocalAccount(body?.username, body?.password)
  createSession(event, userId)
  run('UPDATE profiles SET last_login_at=?,last_login_user_agent=? WHERE id=?', nowIso(), String(getHeader(event, 'user-agent') || '').slice(0, 500), userId)
  return { ok: true }
})
