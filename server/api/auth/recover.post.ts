import { recoverLocalAccount, requireSameOrigin } from '../../utils/auth'

export default defineEventHandler(async event => {
  requireSameOrigin(event)
  const body = await readBody(event)
  recoverLocalAccount(body?.username, body?.recoveryCode, body?.newPassword)
  return { ok: true }
})
