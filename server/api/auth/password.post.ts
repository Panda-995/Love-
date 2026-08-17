import { requireSameOrigin, requireUser, revokeOtherSessions, updateLocalPassword } from '../../utils/auth'

export default defineEventHandler(async event => {
  requireSameOrigin(event)
  const user = requireUser(event)
  const body = await readBody(event)
  updateLocalPassword(user.id, body?.password)
  revokeOtherSessions(event, user.id)
  return { ok: true }
})
