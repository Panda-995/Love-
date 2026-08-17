import type { SQLInputValue } from 'node:sqlite'
import type { H3Event } from 'h3'
import { requireSameOrigin, requireUser } from './auth'
import { all, newId, nowIso, one, run, transaction } from './db'
import { publishRealtime } from './realtime'

type Filter = { op: 'eq' | 'in' | 'lt' | 'gte'; column: string; value: unknown }
type Order = { column: string; ascending?: boolean }
type DataRequest = {
  table: string
  operation: 'select' | 'insert' | 'upsert' | 'update' | 'delete'
  values?: Record<string, unknown> | Array<Record<string, unknown>>
  filters?: Filter[]
  orders?: Order[]
  limit?: number
  head?: boolean
  count?: string
  onConflict?: string
}

const tableColumns: Record<string, string[]> = {
  profiles: ['id', 'display_name', 'avatar_url', 'last_login_user_agent', 'last_login_at', 'created_at'],
  couples: ['id', 'name', 'relationship_start', 'created_by', 'cover_path', 'created_at'],
  couple_members: ['couple_id', 'user_id', 'joined_at'],
  invitations: ['id', 'couple_id', 'code', 'created_by', 'expires_at', 'accepted_by', 'accepted_at', 'created_at'],
  memories: ['id', 'couple_id', 'author_id', 'content', 'memory_date', 'location', 'photos', 'created_at', 'updated_at'],
  albums: ['id', 'couple_id', 'created_by', 'name', 'description', 'cover_path', 'created_at'],
  album_photos: ['id', 'album_id', 'uploaded_by', 'path', 'thumb_path', 'medium_path', 'original_path', 'video_poster_path', 'caption', 'media_type', 'taken_date', 'created_at'],
  messages: ['id', 'couple_id', 'sender_id', 'content', 'image_path', 'media_path', 'media_type', 'read_at', 'created_at'],
  couple_letters: ['id', 'couple_id', 'sender_id', 'recipient_id', 'content', 'created_at'],
  anniversaries: ['id', 'couple_id', 'created_by', 'title', 'event_date', 'kind', 'recurring', 'note', 'created_at'],
  together_items: ['id', 'couple_id', 'created_by', 'title', 'note', 'category', 'priority', 'planned_date', 'completed', 'completed_by', 'completed_at', 'created_at', 'updated_at'],
  ai_saved_works: ['id', 'couple_id', 'user_id', 'kind', 'work_date', 'title', 'content', 'memory_id', 'created_at', 'updated_at'],
  couple_pets: ['id', 'couple_id', 'name', 'species', 'level', 'experience', 'mood', 'hunger', 'skin', 'accessories', 'updated_at'],
  couple_streaks: ['id', 'couple_id', 'current_days', 'longest_days', 'last_completed_date', 'protection_count', 'level', 'updated_at'],
  streak_day_actions: ['couple_id', 'activity_date', 'user_id', 'activity_type', 'mood', 'note', 'created_at'],
  streak_activity_events: ['id', 'couple_id', 'activity_date', 'actor_id', 'activity_type', 'mood', 'note', 'created_at'],
  couple_streak_milestones: ['couple_id', 'milestone_days', 'reward_key', 'achieved_at'],
  couple_pet_rewards: ['couple_id', 'reward_key', 'reward_type', 'unlocked_at'],
  memory_favorites: ['memory_id', 'couple_id', 'user_id', 'created_at'],
  memory_reactions: ['memory_id', 'couple_id', 'user_id', 'emoji', 'created_at'],
  memory_comments: ['id', 'memory_id', 'couple_id', 'user_id', 'content', 'created_at'],
  push_tokens: ['id', 'user_id', 'couple_id', 'platform', 'token', 'device_label', 'last_seen_at', 'created_at', 'updated_at'],
  call_records: ['id', 'call_id', 'couple_id', 'caller_id', 'call_mode', 'status', 'started_at', 'answered_at', 'ended_at', 'duration_seconds'],
}

const jsonColumns = new Set(['memories.photos', 'couple_pets.accessories'])
const booleanColumns = new Set(['anniversaries.recurring', 'together_items.completed'])
const idTables = new Set(Object.entries(tableColumns).filter(([, columns]) => columns.includes('id')).map(([table]) => table))
const directCoupleTables = new Set(['couples', 'couple_members', 'invitations', 'memories', 'albums', 'messages', 'couple_letters', 'anniversaries', 'together_items', 'ai_saved_works', 'couple_pets', 'couple_streaks', 'streak_day_actions', 'streak_activity_events', 'couple_streak_milestones', 'couple_pet_rewards', 'memory_favorites', 'memory_reactions', 'memory_comments', 'push_tokens', 'call_records'])
const writableTables = new Set(['profiles', 'couples', 'memories', 'albums', 'album_photos', 'messages', 'couple_letters', 'anniversaries', 'together_items', 'ai_saved_works', 'memory_favorites', 'memory_reactions', 'memory_comments', 'push_tokens', 'call_records'])
const insertableTables = new Set([...writableTables].filter(table => !['profiles', 'couples'].includes(table)))

function assertTable(table: string) {
  if (!tableColumns[table]) throw createError({ statusCode: 400, statusMessage: '不支持的数据表' })
}

function assertColumn(table: string, column: string) {
  if (!tableColumns[table]?.includes(column)) throw createError({ statusCode: 400, statusMessage: '不支持的数据字段' })
  return column
}

function coupleScope(table: string, user: { id: string; coupleId: string | null }) {
  if (table === 'profiles') {
    if (!user.coupleId) return { sql: 'id = ?', params: [user.id] as SQLInputValue[] }
    return { sql: 'id IN (SELECT user_id FROM couple_members WHERE couple_id = ?)', params: [user.coupleId] as SQLInputValue[] }
  }
  if (table === 'album_photos') return { sql: 'album_id IN (SELECT id FROM albums WHERE couple_id = ?)', params: [user.coupleId || ''] as SQLInputValue[] }
  if (directCoupleTables.has(table)) return { sql: 'couple_id = ?', params: [user.coupleId || ''] as SQLInputValue[] }
  return { sql: '1 = 0', params: [] as SQLInputValue[] }
}

function buildWhere(table: string, user: { id: string; coupleId: string | null }, filters: Filter[] = [], extra = '') {
  const scope = coupleScope(table, user)
  const parts = [`(${scope.sql})`]
  const params = [...scope.params]
  for (const filter of filters) {
    const column = assertColumn(table, String(filter.column || ''))
    if (filter.op === 'in') {
      const values = Array.isArray(filter.value) ? filter.value.slice(0, 200) : []
      if (!values.length) { parts.push('1 = 0'); continue }
      parts.push(`${column} IN (${values.map(() => '?').join(',')})`)
      params.push(...values.map(sqlValue))
    } else {
      const operator = filter.op === 'eq' ? '=' : filter.op === 'lt' ? '<' : '>='
      parts.push(`${column} ${operator} ?`)
      params.push(sqlValue(filter.value))
    }
  }
  if (extra) parts.push(`(${extra})`)
  return { sql: parts.join(' AND '), params }
}

function sqlValue(value: unknown): SQLInputValue {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array) return value
  return JSON.stringify(value)
}

function encodeValue(table: string, column: string, value: unknown) {
  if (jsonColumns.has(`${table}.${column}`)) return JSON.stringify(value ?? (column === 'photos' || column === 'accessories' ? [] : null))
  if (booleanColumns.has(`${table}.${column}`)) return value ? 1 : 0
  return sqlValue(value)
}

function decodeRow(table: string, input: Record<string, unknown>) {
  const row = { ...input }
  for (const column of tableColumns[table] || []) {
    const key = `${table}.${column}`
    if (jsonColumns.has(key) && typeof row[column] === 'string') {
      try { row[column] = JSON.parse(String(row[column])) } catch { row[column] = [] }
    }
    if (booleanColumns.has(key)) row[column] = Boolean(row[column])
  }
  if (table === 'couple_members' && row.couple_id) row.couples = one('SELECT name FROM couples WHERE id=?', String(row.couple_id)) || null
  if (table === 'memories' && row.author_id) row.profiles = one('SELECT display_name FROM profiles WHERE id=?', String(row.author_id)) || null
  if (table === 'album_photos') {
    row.albums = one('SELECT name FROM albums WHERE id=?', String(row.album_id)) || null
    row.profiles = one('SELECT display_name FROM profiles WHERE id=?', String(row.uploaded_by)) || null
  }
  return row
}

function prepareValues(table: string, input: Record<string, unknown>) {
  const result: Record<string, SQLInputValue> = {}
  for (const [column, value] of Object.entries(input)) {
    if (!tableColumns[table]?.includes(column)) continue
    result[column] = encodeValue(table, column, value)
  }
  return result
}

function requireCouple(user: { coupleId: string | null }) {
  if (!user.coupleId) throw createError({ statusCode: 400, statusMessage: '请先绑定情侣空间' })
  return user.coupleId
}

function prepareInsert(table: string, input: Record<string, unknown>, user: { id: string; coupleId: string | null }) {
  if (!insertableTables.has(table)) throw createError({ statusCode: 403, statusMessage: '该数据不可直接创建' })
  const coupleId = requireCouple(user)
  const value = { ...input }
  if (directCoupleTables.has(table)) value.couple_id = coupleId
  if (['memories'].includes(table)) value.author_id = user.id
  if (['albums', 'anniversaries', 'together_items'].includes(table)) value.created_by = user.id
  if (['messages'].includes(table)) value.sender_id = user.id
  if (['ai_saved_works', 'memory_favorites', 'memory_reactions', 'memory_comments', 'push_tokens'].includes(table)) value.user_id = user.id
  if (table === 'couple_letters') value.sender_id = user.id
  if (table === 'call_records') value.caller_id = user.id
  if (table === 'album_photos') {
    const album = one('SELECT id FROM albums WHERE id=? AND couple_id=?', String(value.album_id || ''), coupleId)
    if (!album) throw createError({ statusCode: 403, statusMessage: '相册不属于当前空间' })
    value.uploaded_by = user.id
  }
  if (['memory_favorites', 'memory_reactions', 'memory_comments'].includes(table)) {
    const memory = one('SELECT id FROM memories WHERE id=? AND couple_id=?', String(value.memory_id || ''), coupleId)
    if (!memory) throw createError({ statusCode: 403, statusMessage: '时光记录不属于当前空间' })
  }
  if (table === 'couple_letters') {
    const recipient = one('SELECT user_id FROM couple_members WHERE couple_id=? AND user_id=?', coupleId, String(value.recipient_id || ''))
    if (!recipient || value.recipient_id === user.id) throw createError({ statusCode: 400, statusMessage: '收件人无效' })
  }
  const now = nowIso()
  if (idTables.has(table) && !value.id) value.id = newId()
  if (tableColumns[table]!.includes('created_at') && !value.created_at) value.created_at = now
  if (tableColumns[table]!.includes('updated_at') && !value.updated_at) value.updated_at = now
  if (table === 'album_photos' && !value.taken_date) value.taken_date = now.slice(0, 10)
  if (table === 'push_tokens') {
    const owner = one<{ user_id: string }>('SELECT user_id FROM push_tokens WHERE token=?', String(value.token || ''))
    if (owner && owner.user_id !== user.id) throw createError({ statusCode: 409, statusMessage: '推送令牌已被其他账户使用' })
    value.last_seen_at ||= now
    value.updated_at = now
  }
  if (table === 'call_records') value.started_at ||= now
  return prepareValues(table, value)
}

function mutationGuard(table: string, userId: string) {
  if (table === 'profiles') return 'id = ' + quote(userId)
  if (table === 'couples') return 'created_by = ' + quote(userId)
  if (table === 'memories') return 'author_id = ' + quote(userId)
  if (table === 'albums') return 'created_by = ' + quote(userId)
  if (table === 'album_photos') return 'uploaded_by = ' + quote(userId)
  if (table === 'messages') return 'sender_id = ' + quote(userId)
  if (table === 'couple_letters') return 'sender_id = ' + quote(userId)
  if (table === 'anniversaries' || table === 'together_items') return 'created_by = ' + quote(userId)
  if (table === 'ai_saved_works') return 'user_id = ' + quote(userId)
  if (table === 'memory_favorites' || table === 'memory_reactions' || table === 'memory_comments' || table === 'push_tokens') return 'user_id = ' + quote(userId)
  if (table === 'call_records') return 'caller_id = ' + quote(userId)
  return ''
}

function updateGuard(table: string, userId: string) {
  if (table === 'messages') return 'sender_id <> ' + quote(userId)
  if (table === 'couples' || table === 'together_items') return ''
  return mutationGuard(table, userId)
}

function quote(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

function insertRow(table: string, values: Record<string, SQLInputValue>, upsert = false, conflict = '') {
  const columns = Object.keys(values)
  if (!columns.length) throw createError({ statusCode: 400, statusMessage: '没有可写入的数据' })
  const placeholders = columns.map(() => '?').join(',')
  let sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`
  if (upsert) {
    const target = assertColumn(table, conflict)
    const updates = columns.filter(column => column !== target && column !== 'id' && column !== 'created_at')
    sql += ` ON CONFLICT(${target}) DO UPDATE SET ${updates.map(column => `${column}=excluded.${column}`).join(',')}`
  }
  run(sql, ...columns.map(column => values[column]!))
  const identity = values.id ? { column: 'id', value: values.id } : conflict && values[conflict] !== undefined ? { column: conflict, value: values[conflict] } : null
  return identity ? one<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${identity.column}=?`, identity.value) : values
}

function safeMutationValues(table: string, input: Record<string, unknown>, userId: string) {
  const allowedColumns: Record<string, string[]> = {
    profiles: ['display_name', 'avatar_url', 'last_login_user_agent', 'last_login_at'],
    couples: ['name', 'relationship_start', 'cover_path'],
    memories: ['content', 'memory_date', 'location', 'photos'],
    albums: ['name', 'description', 'cover_path'],
    album_photos: ['thumb_path', 'medium_path', 'original_path', 'video_poster_path', 'caption', 'taken_date'],
    messages: ['read_at'],
    couple_letters: ['content'],
    anniversaries: ['title', 'event_date', 'kind', 'recurring', 'note'],
    together_items: ['title', 'note', 'category', 'priority', 'planned_date', 'completed', 'completed_by', 'completed_at'],
    ai_saved_works: ['kind', 'work_date', 'title', 'content', 'memory_id'],
    memory_comments: ['content'],
    push_tokens: ['platform', 'token', 'device_label', 'last_seen_at'],
    call_records: ['status', 'answered_at', 'ended_at', 'duration_seconds'],
  }
  const allowed = new Set(allowedColumns[table] || [])
  const clean = Object.fromEntries(Object.entries(input).filter(([column]) => allowed.has(column)))
  if (table === 'together_items' && clean.completed_by) clean.completed_by = userId
  if (tableColumns[table]?.includes('updated_at')) clean.updated_at = nowIso()
  return prepareValues(table, clean)
}

export async function handleDataRequest(event: H3Event, request: DataRequest) {
  const user = requireUser(event)
  const table = String(request?.table || '')
  assertTable(table)
  if (request.operation !== 'select') requireSameOrigin(event)

  if (request.operation === 'select') {
    const where = buildWhere(table, user, request.filters)
    const orders = (request.orders || []).slice(0, 4).map(order => `${assertColumn(table, order.column)} ${order.ascending === false ? 'DESC' : 'ASC'}`)
    const limit = Math.max(0, Math.min(500, Number(request.limit || 500)))
    const rows = all<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${where.sql}${orders.length ? ` ORDER BY ${orders.join(',')}` : ''} LIMIT ${limit}`, ...where.params)
    return { data: request.head ? null : rows.map(row => decodeRow(table, row)), count: rows.length, error: null }
  }

  if (!writableTables.has(table)) throw createError({ statusCode: 403, statusMessage: '该数据只读' })
  if (request.operation === 'insert' || request.operation === 'upsert') {
    if (request.operation === 'upsert' && (table !== 'push_tokens' || request.onConflict !== 'token')) throw createError({ statusCode: 403, statusMessage: '该数据不允许覆盖写入' })
    const inputs = Array.isArray(request.values) ? request.values : [request.values || {}]
    const created = transaction(() => inputs.map(input => {
      const values = prepareInsert(table, input, user)
      return insertRow(table, values, request.operation === 'upsert', String(request.onConflict || ''))
    }))
    const decoded = created.map(row => decodeRow(table, row as Record<string, unknown>))
    for (const row of decoded) publishRealtime(user.coupleId, { type: 'postgres_changes', table, event: 'INSERT', new: row, old: null })
    return { data: decoded, count: decoded.length, error: null }
  }

  const guard = request.operation === 'update' ? updateGuard(table, user.id) : mutationGuard(table, user.id)
  const where = buildWhere(table, user, request.filters, guard)
  const before = all<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${where.sql}`, ...where.params)
  if (request.operation === 'update') {
    const values = safeMutationValues(table, request.values as Record<string, unknown> || {}, user.id)
    const columns = Object.keys(values)
    if (!columns.length) throw createError({ statusCode: 400, statusMessage: '没有可更新的数据' })
    run(`UPDATE ${table} SET ${columns.map(column => `${column}=?`).join(',')} WHERE ${where.sql}`, ...columns.map(column => values[column]!), ...where.params)
    for (const oldRow of before) {
      const current = idTables.has(table) ? one<Record<string, unknown>>(`SELECT * FROM ${table} WHERE id=?`, oldRow.id as SQLInputValue) : { ...oldRow, ...values }
      if (current) publishRealtime(user.coupleId, { type: 'postgres_changes', table, event: 'UPDATE', new: decodeRow(table, current), old: decodeRow(table, oldRow) })
    }
    return { data: null, count: before.length, error: null }
  }

  run(`DELETE FROM ${table} WHERE ${where.sql}`, ...where.params)
  for (const oldRow of before) publishRealtime(user.coupleId, { type: 'postgres_changes', table, event: 'DELETE', new: null, old: decodeRow(table, oldRow) })
  return { data: null, count: before.length, error: null }
}
