import { destroySession, requireSameOrigin } from '../../utils/auth'

export default defineEventHandler(event => {
  requireSameOrigin(event)
  destroySession(event)
  return { ok: true }
})
