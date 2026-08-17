import { handleLocalFunction } from '../../utils/functions'

export default defineEventHandler(async event => {
  const name = getRouterParam(event, 'name') || ''
  return await handleLocalFunction(event, name, await readBody(event) || {})
})
