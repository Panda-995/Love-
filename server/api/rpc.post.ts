import { handleRpc } from '../utils/rpc'

export default defineEventHandler(async event => {
  const body = await readBody(event)
  return { data: await handleRpc(event, String(body?.name || ''), body?.args || {}), error: null }
})
