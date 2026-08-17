import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type { H3Event } from 'h3'
import { requireSameOrigin, requireUser } from './auth'

const bucketRules: Record<string, { max: number; types: RegExp }> = {
  avatars: { max: 5 * 1024 * 1024, types: /^image\/(jpeg|png|webp)$/ },
  'memory-photos': { max: 10 * 1024 * 1024, types: /^image\/(jpeg|png|webp|gif)$/ },
  'album-media': { max: 100 * 1024 * 1024, types: /^(image|video)\// },
  'message-media': { max: 50 * 1024 * 1024, types: /^(image|video|audio)\// },
}

export function mediaRoot() {
  const config = useRuntimeConfig()
  return resolve(String(config.localDataDir || join(process.cwd(), '.data')), 'media')
}

function cleanPath(value: unknown) {
  const path = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '')
  if (!path || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..')) throw createError({ statusCode: 400, statusMessage: '媒体路径无效' })
  return path
}

function validateOwnership(bucket: string, path: string, user: { id: string; coupleId: string | null }) {
  if (!bucketRules[bucket]) throw createError({ statusCode: 400, statusMessage: '媒体目录无效' })
  const first = path.split('/')[0]
  if (bucket === 'avatars') {
    if (first !== user.id) throw createError({ statusCode: 403, statusMessage: '头像路径不属于当前账号' })
  } else if (!user.coupleId || first !== user.coupleId) throw createError({ statusCode: 403, statusMessage: '媒体路径不属于当前情侣空间' })
}

function absoluteMediaPath(bucket: string, unsafePath: unknown) {
  const path = cleanPath(unsafePath)
  const bucketRoot = resolve(mediaRoot(), bucket)
  const absolute = resolve(bucketRoot, ...path.split('/'))
  if (absolute !== bucketRoot && !absolute.startsWith(bucketRoot + sep)) throw createError({ statusCode: 400, statusMessage: '媒体路径无效' })
  return { path, absolute }
}

export function mediaUrl(bucket: string, path: string) {
  return `/media/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`
}

export async function uploadMedia(event: H3Event) {
  requireSameOrigin(event)
  const user = requireUser(event)
  const parts = await readMultipartFormData(event)
  const getText = (name: string) => parts?.find(part => part.name === name)?.data.toString('utf8') || ''
  const bucket = getText('bucket')
  const rawPath = getText('path')
  const file = parts?.find(part => part.name === 'file')
  if (!file?.data) throw createError({ statusCode: 400, statusMessage: '没有收到媒体文件' })
  const target = absoluteMediaPath(bucket, rawPath)
  validateOwnership(bucket, target.path, user)
  const rule = bucketRules[bucket]!
  const type = String(file.type || 'application/octet-stream')
  if (file.data.byteLength > rule.max) throw createError({ statusCode: 413, statusMessage: '媒体文件过大' })
  if (!rule.types.test(type)) throw createError({ statusCode: 415, statusMessage: '不支持的媒体格式' })
  mkdirSync(resolve(target.absolute, '..'), { recursive: true })
  const upsert = getText('upsert') === 'true'
  if (existsSync(target.absolute) && !upsert) throw createError({ statusCode: 409, statusMessage: '媒体文件已存在' })
  writeFileSync(target.absolute, file.data, { flag: upsert ? 'w' : 'wx' })
  return { path: target.path }
}

export async function removeMedia(event: H3Event) {
  requireSameOrigin(event)
  const user = requireUser(event)
  const body = await readBody(event)
  const bucket = String(body?.bucket || '')
  for (const rawPath of Array.isArray(body?.paths) ? body.paths.slice(0, 100) : []) {
    const target = absoluteMediaPath(bucket, rawPath)
    validateOwnership(bucket, target.path, user)
    if (existsSync(target.absolute)) rmSync(target.absolute)
  }
  return { ok: true }
}

export function listMedia(event: H3Event, bucket: string, rawPath: unknown, limitValue: unknown) {
  const user = requireUser(event)
  const path = cleanPath(rawPath || (bucket === 'avatars' ? user.id : user.coupleId || 'missing'))
  validateOwnership(bucket, path, user)
  const target = absoluteMediaPath(bucket, path)
  if (!existsSync(target.absolute)) return []
  return readdirSync(target.absolute, { withFileTypes: true }).slice(0, Math.min(100, Number(limitValue) || 20)).map(entry => ({ name: entry.name, id: null, metadata: { isDirectory: entry.isDirectory() } }))
}

export function serveMedia(event: H3Event, bucket: string, rawPath: unknown) {
  const user = requireUser(event)
  const target = absoluteMediaPath(bucket, rawPath)
  validateOwnership(bucket, target.path, user)
  if (!existsSync(target.absolute)) throw createError({ statusCode: 404, statusMessage: '媒体文件不存在' })
  const types: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4' }
  setHeader(event, 'content-type', types[extname(target.absolute).toLowerCase()] || 'application/octet-stream')
  setHeader(event, 'cache-control', 'private, max-age=3600')
  return sendStream(event, createReadStream(target.absolute))
}
