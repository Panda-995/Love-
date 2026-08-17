import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { requireUser } from './auth'
import type { H3Event } from 'h3'
import { getHeader } from 'h3'

function dataDir() {
  return String(useRuntimeConfig().localDataDir || join(process.cwd(), '.data'))
}

export function ensureTurnSecret() {
  const directory = dataDir()
  const path = join(directory, 'turn-secret')
  mkdirSync(directory, { recursive: true })
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' })
  return readFileSync(path, 'utf8').trim()
}

export function rtcConfiguration(event: H3Event) {
  const user = requireUser(event)
  if (!user.coupleId) throw createError({ statusCode: 400, statusMessage: '请先绑定情侣空间' })
  const forwardedHost = String(getHeader(event, 'x-forwarded-host') || getHeader(event, 'host') || '').split(',')[0]!.trim()
  const host = forwardedHost.startsWith('[') ? forwardedHost.replace(/\]:\d+$/, ']') : forwardedHost.replace(/:\d+$/, '')
  const urlsFile = join(dataDir(), 'turn-urls')
  const configuredUrls = existsSync(urlsFile) ? readFileSync(urlsFile, 'utf8').trim() : ''
  const defaultUrls = host ? `turn:${host}:3478?transport=udp,turn:${host}:3478?transport=tcp` : ''
  const urls = (configuredUrls || defaultUrls).split(',').map(value => value.trim()).filter(value => /^turns?:[^\s]+$/i.test(value))
  const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = []
  if (urls.length) {
    const username = `${Math.floor(Date.now() / 1000) + 86400}:${user.id}`
    const credential = createHmac('sha1', ensureTurnSecret()).update(username).digest('base64')
    iceServers.push({ urls, username, credential })
  }
  return { iceServers, turnConfigured: urls.length > 0 }
}
