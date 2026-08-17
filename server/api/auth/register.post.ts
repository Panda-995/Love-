import { registerLocalAccount, requireSameOrigin } from '../../utils/auth'

export default defineEventHandler(async event => {
  requireSameOrigin(event)
  const body = await readBody(event)
  const result = registerLocalAccount(body?.displayName, body?.username, body?.password)
  return { recoveryCode: result.recoveryCode }
})
