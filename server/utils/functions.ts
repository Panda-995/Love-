import { createSign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { H3Event } from 'h3'
import { destroySession, recoverLocalAccount, registerLocalAccount, requireSameOrigin, requireUser } from './auth'
import { all, nowIso, one, run, transaction } from './db'

const aiBuckets = new Map<string, { startedAt: number; count: number }>()
let googleTokenCache: { value: string; expiresAt: number } | null = null

function bounded(value: unknown, max: number, fallback = '') {
  return String(value ?? fallback).trim().slice(0, max)
}

function allowAi(key: string) {
  const now = Date.now(); const current = aiBuckets.get(key)
  if (!current || now - current.startedAt >= 60_000) { aiBuckets.set(key, { startedAt: now, count: 1 }); return true }
  if (current.count >= 8) return false
  current.count += 1; return true
}

function onlineAiConfig() {
  const config = useRuntimeConfig()
  const apiKey = String(config.aiApiKey || '').trim()
  const model = bounded(config.aiModel, 160)
  const rawBaseUrl = String(config.aiBaseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '')
  if (!apiKey || !model) {
    throw createError({ statusCode: 503, statusMessage: 'AI 服务未配置，请设置 AI_API_KEY 和 AI_MODEL' })
  }
  if (/[\r\n]/.test(apiKey)) throw createError({ statusCode: 503, statusMessage: 'AI_API_KEY 格式无效' })
  let baseUrl: URL
  try {
    baseUrl = new URL(rawBaseUrl)
  } catch {
    throw createError({ statusCode: 503, statusMessage: 'AI_BASE_URL 不是有效地址' })
  }
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw createError({ statusCode: 503, statusMessage: 'AI_BASE_URL 必须是无凭据、查询参数和片段的 HTTPS 地址' })
  }
  return {
    apiKey,
    endpoint: `${baseUrl.toString().replace(/\/+$/, '')}/chat/completions`,
    model,
  }
}

async function heartAi(user: { id: string; coupleId: string | null }, body: Record<string, any>) {
  if (!user.coupleId) throw createError({ statusCode: 400, statusMessage: '请先绑定情侣空间' })
  if (!allowAi(`${user.coupleId}:${user.id}`)) throw createError({ statusCode: 429, statusMessage: 'AI 请求过于频繁，请稍后再试' })
  const feature = String(body.feature || '')
  const writingLength = Math.min(800, Math.max(100, Number(body.length) || 400))
  const prompts: Record<string, { system: string; user: string }> = {
    daily_question: { system: '你是情侣互动问题策划师。只生成一个温柔、有趣、适合双方分别回答的问题。避免评判、控制、隐私逼问、性暗示和心理诊断。只返回问题正文，不要标题和解释。', user: `为一对情侣生成今天的问题。偏好分类：${bounded(body.category, 40, '日常与回忆')}。问题应在40个汉字以内。` },
    date_plan: { system: '你是情侣约会策划师。直接输出精简、具体、可执行的中文方案，不要思考过程，不要长篇解释。', user: `城市：${bounded(body.city, 40, '未指定')}；预算：${bounded(body.budget, 40, '适中')}；时间：${bounded(body.time, 40, '半天')}；偏好：${bounded(body.preferences, 200, '轻松浪漫')}。请在400字以内按时间、地点、费用、备选方案输出。` },
    express: { system: '你帮助用户润色情侣消息。保持原意，不操纵、不道德绑架，不替用户虚构承诺。只返回润色后的消息。', user: `语气：${bounded(body.tone, 40, '温柔真诚')}。原文：${bounded(body.text, 2000)}` },
    diary: { system: '你是共同日记写作者。根据用户主动提供的素材，写一篇温柔真实的中文情侣日记，不虚构未提供的事实。', user: `素材：${bounded(body.material, 3000)}。文风：${bounded(body.style, 40, '自然温柔')}。写约${writingLength}字，只输出日记正文。` },
    love_letter: { system: '你是情书写作者。根据用户提供的真实素材写真诚克制的中文情书，不虚构经历，不道德绑架，只输出正文。', user: `想表达的内容：${bounded(body.material, 3000)}。称呼：${bounded(body.recipient, 40, '亲爱的')}。语气：${bounded(body.style, 40, '自然温柔')}。写约${writingLength}字。` },
  }
  const prompt = prompts[feature]
  if (!prompt) throw createError({ statusCode: 400, statusMessage: '不支持的 AI 功能' })
  const { apiKey, endpoint, model } = onlineAiConfig()
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST', signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }], temperature: 0.7, max_tokens: feature === 'date_plan' ? 650 : Math.min(1800, writingLength * 2) }),
    })
  } catch (error: unknown) {
    const errorName = error instanceof Error ? error.name : ''
    throw createError({ statusCode: 502, statusMessage: errorName === 'TimeoutError' ? 'AI 服务响应超时' : '无法连接 AI 服务' })
  }
  if (!response.ok) throw createError({ statusCode: 502, statusMessage: `AI API 请求失败（HTTP ${response.status}）：${(await response.text()).slice(0, 200)}` })
  const result: any = await response.json()
  const output = String(result?.choices?.[0]?.message?.content || '').trim()
  if (!output) throw createError({ statusCode: 502, statusMessage: 'AI API 未返回内容' })
  return { output, model }
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString('base64url')
}

function loadServiceAccount() {
  const config = useRuntimeConfig()
  const inline = String(config.fcmServiceAccountJson || '')
  const path = String(config.fcmServiceAccountFile || '/data/fcm-service-account.json')
  const raw = inline || (existsSync(path) ? readFileSync(path, 'utf8') : '')
  return raw ? JSON.parse(raw) as { client_email: string; private_key: string; project_id: string } : null
}

async function googleAccessToken(account: { client_email: string; private_key: string }) {
  if (googleTokenCache && googleTokenCache.expiresAt > Date.now() + 60_000) return googleTokenCache.value
  const now = Math.floor(Date.now() / 1000)
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = base64Url(JSON.stringify({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))
  const signer = createSign('RSA-SHA256'); signer.update(`${header}.${claim}`); signer.end()
  const assertion = `${header}.${claim}.${base64Url(signer.sign(account.private_key))}`
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) })
  const data: any = await response.json()
  if (!response.ok || !data.access_token) throw createError({ statusCode: 502, statusMessage: `FCM OAuth 获取失败（HTTP ${response.status}）` })
  googleTokenCache = { value: String(data.access_token), expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 }
  return googleTokenCache.value
}

async function sendCallPush(user: { id: string; coupleId: string | null }, body: Record<string, any>) {
  if (!user.coupleId || (body.coupleId && body.coupleId !== user.coupleId)) throw createError({ statusCode: 403, statusMessage: '情侣空间校验失败' })
  const partnerIds = all<any>('SELECT user_id FROM couple_members WHERE couple_id=? AND user_id<>?', user.coupleId, user.id).map(row => row.user_id)
  if (!partnerIds.length) return { sent: 0, reason: '暂无另一位情侣成员' }
  const tokens = all<any>(`SELECT token FROM push_tokens WHERE couple_id=? AND platform='android' AND user_id IN (${partnerIds.map(() => '?').join(',')})`, user.coupleId, ...partnerIds)
  if (!tokens.length) return { sent: 0, reason: '对方尚未注册推送设备' }
  const account = loadServiceAccount()
  if (!account) return { sent: 0, configured: false, reason: '未找到 /data/fcm-service-account.json' }
  const accessToken = await googleAccessToken(account)
  let sent = 0
  for (const row of tokens) {
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ message: { token: row.token, data: { type: 'incoming_call', callId: String(body.callId || ''), mode: body.mode === 'video' ? 'video' : 'audio', callerName: bounded(body.callerName, 40, 'TA') }, notification: { title: 'Love小家来电', body: `${bounded(body.callerName, 40, 'TA')} 正在呼叫你` }, android: { priority: 'high', notification: { channel_id: 'love-home-incoming-call', sound: 'default', default_vibrate_timings: true } } } }) })
    if (response.ok) sent += 1
  }
  return { sent, configured: true }
}

function deleteAccount(event: H3Event, user: { id: string; coupleId: string | null }) {
  transaction(() => {
    if (user.coupleId) {
      const partner = one<any>('SELECT user_id FROM couple_members WHERE couple_id=? AND user_id<>?', user.coupleId, user.id)
      if (!partner) run('DELETE FROM couples WHERE id=?', user.coupleId)
      else {
        const partnerId = String(partner.user_id)
        for (const [table, column] of [['memories', 'author_id'], ['albums', 'created_by'], ['album_photos', 'uploaded_by'], ['messages', 'sender_id'], ['anniversaries', 'created_by'], ['together_items', 'created_by'], ['ai_saved_works', 'user_id'], ['invitations', 'created_by'], ['call_records', 'caller_id']] as const) run(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`, partnerId, user.id)
        run('UPDATE together_items SET completed_by=? WHERE completed_by=?', partnerId, user.id)
        run('UPDATE couple_letters SET sender_id=? WHERE sender_id=?', partnerId, user.id)
        run('UPDATE couple_letters SET recipient_id=? WHERE recipient_id=?', partnerId, user.id)
        run('UPDATE couples SET created_by=? WHERE id=?', partnerId, user.coupleId)
        run('DELETE FROM couple_members WHERE user_id=?', user.id)
      }
    }
    run('DELETE FROM users WHERE id=?', user.id)
  })
  destroySession(event)
  return { ok: true }
}

export async function handleLocalFunction(event: H3Event, name: string, body: Record<string, any>) {
  requireSameOrigin(event)
  if (name === 'account-auth') {
    if (body.action === 'register') return registerLocalAccount(body.displayName, body.username, body.password)
    if (body.action === 'recover') { recoverLocalAccount(body.username, body.recoveryCode, body.newPassword); return { ok: true } }
    throw createError({ statusCode: 400, statusMessage: '不支持的账号操作' })
  }
  const user = requireUser(event)
  if (name === 'heart-ai') return heartAi(user, body)
  if (name === 'send-call-push') return sendCallPush(user, body)
  if (name === 'account-security') {
    if (body.action === 'login-anomaly') { run('UPDATE profiles SET last_login_user_agent=?,last_login_at=? WHERE id=?', bounded(body.userAgent, 500), nowIso(), user.id); return { ok: true } }
    if (body.action === 'delete-account' && body.confirmation === '删除我的账户') return deleteAccount(event, user)
    throw createError({ statusCode: 400, statusMessage: '不支持的安全操作' })
  }
  throw createError({ statusCode: 404, statusMessage: '本地函数不存在' })
}
