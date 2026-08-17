import { requireUser } from '../../utils/auth'

export default defineEventHandler(async event => {
  requireUser(event)
  const config = useRuntimeConfig()
  const jscode = String(config.amapSecurityCode || '')
  if (!jscode) throw createError({ statusCode: 503, statusMessage: '高德地图安全密钥尚未配置' })
  const path = String(getRouterParam(event, 'path') || '').replace(/^\/+/, '')
  if (!path || path.includes('..') || !/^[a-zA-Z0-9_./-]+$/.test(path)) throw createError({ statusCode: 400, statusMessage: '高德代理路径无效' })
  const base = path.startsWith('v4/map/styles') ? 'https://webapi.amap.com/' : 'https://restapi.amap.com/'
  const target = new URL(path, base)
  const requestUrl = getRequestURL(event)
  requestUrl.searchParams.forEach((value, key) => { if (key !== 'jscode') target.searchParams.append(key, value) })
  target.searchParams.set('jscode', jscode)
  const response = await fetch(target, { method: getMethod(event), signal: AbortSignal.timeout(15_000) })
  const headers = new Headers()
  for (const key of ['content-type', 'cache-control']) { const value = response.headers.get(key); if (value) headers.set(key, value) }
  return new Response(response.body, { status: response.status, headers })
})
