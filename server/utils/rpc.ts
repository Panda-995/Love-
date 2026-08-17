import type { H3Event } from 'h3'
import { randomBytes } from 'node:crypto'
import { requireSameOrigin, requireUser } from './auth'
import { all, newId, nowIso, one, run, transaction } from './db'
import { publishRealtime } from './realtime'

function todayShanghai() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

function invitationCode() {
  return randomBytes(4).toString('hex').toUpperCase()
}

function requireCouple(user: { coupleId: string | null }) {
  if (!user.coupleId) throw createError({ statusCode: 400, statusMessage: '请先绑定情侣空间' })
  return user.coupleId
}

function ensurePet(coupleId: string) {
  const now = nowIso()
  run(`INSERT INTO couple_pets(id,couple_id,updated_at) VALUES(?,?,?) ON CONFLICT(couple_id) DO NOTHING`, newId(), coupleId, now)
  run(`INSERT INTO couple_streaks(id,couple_id,updated_at) VALUES(?,?,?) ON CONFLICT(couple_id) DO NOTHING`, newId(), coupleId, now)
  return one<any>('SELECT * FROM couple_pets WHERE couple_id=?', coupleId)!
}

function parseJson(value: unknown, fallback: unknown = []) {
  if (typeof value !== 'string') return value ?? fallback
  try { return JSON.parse(value) } catch { return fallback }
}

function mapPet(row: any) {
  return row ? { ...row, accessories: parseJson(row.accessories) } : null
}

function streakStatus(coupleId: string, flags: Record<string, unknown> = {}) {
  ensurePet(coupleId)
  const today = todayShanghai()
  const actions = all<any>('SELECT user_id,activity_type,mood,note,created_at FROM streak_day_actions WHERE couple_id=? AND activity_date=? ORDER BY created_at', coupleId, today)
  const rawStreak = one<any>('SELECT * FROM couple_streaks WHERE couple_id=?', coupleId)!
  const effectiveDays = rawStreak.last_completed_date && rawStreak.last_completed_date >= shiftDate(today, -1) ? rawStreak.current_days : 0
  return {
    today,
    today_action_count: actions.length,
    today_completed: actions.length >= 2,
    today_actor_ids: actions.map(row => row.user_id),
    today_actions: actions,
    streak: { ...rawStreak, current_days: effectiveDays },
    pet: mapPet(one('SELECT * FROM couple_pets WHERE couple_id=?', coupleId)),
    rewards: all('SELECT reward_key,reward_type,unlocked_at FROM couple_pet_rewards WHERE couple_id=? ORDER BY unlocked_at', coupleId),
    milestones: all<any>('SELECT milestone_days AS days,reward_key,achieved_at FROM couple_streak_milestones WHERE couple_id=? ORDER BY milestone_days', coupleId),
    newly_completed: false,
    protection_used: false,
    protection_earned: false,
    milestone_days: null,
    reward_key: null,
    ...flags,
  }
}

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function diffDays(later: string, earlier: string) {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86400_000)
}

function recordActivity(coupleId: string, userId: string, args: Record<string, any>) {
  const today = todayShanghai()
  const date = String(args.p_activity_date || today)
  if (date !== today) throw createError({ statusCode: 400, statusMessage: '只能记录今天的情侣互动' })
  let activityType = String(args.p_activity_type || 'manual').trim() || 'manual'
  if (!['manual', 'message', 'photo', 'video', 'memory', 'checklist', 'letter', 'ai', 'pet', 'other'].includes(activityType)) activityType = 'other'
  const mood = args.p_mood == null ? null : Number(args.p_mood)
  if (mood !== null && (!Number.isInteger(mood) || mood < 1 || mood > 5)) throw createError({ statusCode: 400, statusMessage: '今日心情必须是 1 到 5' })
  const note = String(args.p_note || '').trim().slice(0, 240) || null
  ensurePet(coupleId)
  const now = nowIso()
  const flags: Record<string, unknown> = {}
  transaction(() => {
    run('INSERT INTO streak_activity_events(id,couple_id,activity_date,actor_id,activity_type,mood,note,created_at) VALUES(?,?,?,?,?,?,?,?)', newId(), coupleId, today, userId, activityType, mood, note, now)
    run(`INSERT INTO streak_day_actions(couple_id,activity_date,user_id,activity_type,mood,note,created_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(couple_id,activity_date,user_id) DO UPDATE SET activity_type=excluded.activity_type,mood=COALESCE(excluded.mood,streak_day_actions.mood),note=COALESCE(excluded.note,streak_day_actions.note),created_at=excluded.created_at`, coupleId, today, userId, activityType, mood, note, now)
    const count = Number(one<any>('SELECT COUNT(*) AS count FROM streak_day_actions WHERE couple_id=? AND activity_date=?', coupleId, today)?.count || 0)
    const streak = one<any>('SELECT * FROM couple_streaks WHERE couple_id=?', coupleId)!
    if (count < 2 || streak.last_completed_date === today) return
    const gap = streak.last_completed_date ? diffDays(today, streak.last_completed_date) : 0
    const protectionUsed = gap === 2 && streak.protection_count > 0
    const nextDays = gap === 1 || protectionUsed ? Number(streak.current_days) + 1 : 1
    const protectionEarned = nextDays % 7 === 0
    let protection = Math.max(0, Number(streak.protection_count) - (protectionUsed ? 1 : 0) + (protectionEarned ? 1 : 0))
    protection = Math.min(3, protection)
    const rewards: Record<number, [string, string]> = {
      3: ['pet-accessory-flower', 'accessory'], 7: ['house-furniture-love-lamp', 'furniture'],
      14: ['pet-accessory-crown', 'accessory'], 30: ['house-furniture-moon-sofa', 'furniture'], 100: ['pet-accessory-bow', 'accessory'],
    }
    let milestoneDays: number | null = null
    let rewardKey: string | null = null
    if (rewards[nextDays] && !one('SELECT 1 FROM couple_streak_milestones WHERE couple_id=? AND milestone_days=?', coupleId, nextDays)) {
      milestoneDays = nextDays
      ;[rewardKey] = rewards[nextDays]!
      run('INSERT INTO couple_streak_milestones(couple_id,milestone_days,reward_key,achieved_at) VALUES(?,?,?,?)', coupleId, nextDays, rewardKey, now)
      run('INSERT OR IGNORE INTO couple_pet_rewards(couple_id,reward_key,reward_type,unlocked_at) VALUES(?,?,?,?)', coupleId, rewardKey, rewards[nextDays]![1], now)
    }
    run('UPDATE couple_streaks SET current_days=?,longest_days=?,last_completed_date=?,protection_count=?,level=?,updated_at=? WHERE couple_id=?', nextDays, Math.max(Number(streak.longest_days), nextDays), today, protection, Math.min(100, Math.floor((nextDays - 1) / 7) + 1), now, coupleId)
    const pet = one<any>('SELECT experience FROM couple_pets WHERE couple_id=?', coupleId)!
    const gain = 5 + (milestoneDays ? 10 : 0)
    run('UPDATE couple_pets SET experience=experience+?,level=?,mood=MIN(100,mood+8),hunger=MAX(0,hunger-3),updated_at=? WHERE couple_id=?', gain, Math.min(100, Math.floor((Number(pet.experience) + gain) / 50) + 1), now, coupleId)
    Object.assign(flags, { newly_completed: true, protection_used: protectionUsed, protection_earned: protectionEarned, milestone_days: milestoneDays, reward_key: rewardKey })
  })
  publishRealtime(coupleId, { type: 'postgres_changes', table: 'streak_day_actions', event: 'INSERT', new: { couple_id: coupleId, activity_date: today, user_id: userId, activity_type: activityType, mood, note, created_at: now }, old: null })
  return streakStatus(coupleId, flags)
}

export async function handleRpc(event: H3Event, name: string, args: Record<string, any>) {
  requireSameOrigin(event)
  const user = requireUser(event)
  const coupleId = user.coupleId
  switch (name) {
    case 'create_couple_with_invitation': {
      if (coupleId) throw createError({ statusCode: 409, statusMessage: '你已经加入了一个情侣空间' })
      const nameValue = String(args.couple_name || '').trim()
      const start = String(args.relationship_start || '')
      if (!nameValue || nameValue.length > 40 || !/^\d{4}-\d{2}-\d{2}$/.test(start)) throw createError({ statusCode: 400, statusMessage: '空间名称或日期无效' })
      const nextCouple = newId(); const code = invitationCode(); const now = nowIso()
      transaction(() => {
        run('INSERT INTO couples(id,name,relationship_start,created_by,created_at) VALUES(?,?,?,?,?)', nextCouple, nameValue, start, user.id, now)
        run('INSERT INTO couple_members(couple_id,user_id,joined_at) VALUES(?,?,?)', nextCouple, user.id, now)
        run('INSERT INTO invitations(id,couple_id,code,created_by,expires_at,created_at) VALUES(?,?,?,?,?,?)', newId(), nextCouple, code, user.id, new Date(Date.now() + 7 * 86400_000).toISOString(), now)
      })
      return code
    }
    case 'accept_couple_invitation': {
      if (coupleId) throw createError({ statusCode: 409, statusMessage: '你已经加入了一个情侣空间' })
      const code = String(args.invitation_code || '').trim().toUpperCase()
      transaction(() => {
        const invitation = one<any>('SELECT * FROM invitations WHERE code=? AND accepted_at IS NULL AND expires_at>?', code, nowIso())
        if (!invitation) throw createError({ statusCode: 400, statusMessage: '邀请码无效或已过期' })
        const count = Number(one<any>('SELECT COUNT(*) AS count FROM couple_members WHERE couple_id=?', invitation.couple_id)?.count || 0)
        if (count >= 2) throw createError({ statusCode: 409, statusMessage: '这个空间已经有两位成员' })
        run('INSERT INTO couple_members(couple_id,user_id,joined_at) VALUES(?,?,?)', invitation.couple_id, user.id, nowIso())
        run('UPDATE invitations SET accepted_by=?,accepted_at=? WHERE id=?', user.id, nowIso(), invitation.id)
      })
      return null
    }
    case 'get_couple_profiles': {
      const id = requireCouple(user)
      return all('SELECT p.id AS user_id,p.display_name,p.avatar_url FROM profiles p JOIN couple_members cm ON cm.user_id=p.id WHERE cm.couple_id=? ORDER BY cm.joined_at', id)
    }
    case 'regenerate_couple_invitation': {
      const id = requireCouple(user); const code = invitationCode(); const now = nowIso()
      transaction(() => {
        run('UPDATE invitations SET expires_at=? WHERE couple_id=? AND accepted_at IS NULL', now, id)
        run('INSERT INTO invitations(id,couple_id,code,created_by,expires_at,created_at) VALUES(?,?,?,?,?,?)', newId(), id, code, user.id, new Date(Date.now() + 7 * 86400_000).toISOString(), now)
      })
      return code
    }
    case 'leave_couple_space':
      run('DELETE FROM couple_members WHERE user_id=?', user.id); return null
    case 'ensure_couple_pet':
      return mapPet(ensurePet(requireCouple(user)))
    case 'get_couple_streak_status':
      return streakStatus(requireCouple(user))
    case 'record_couple_activity':
      return recordActivity(requireCouple(user), user.id, { ...args, p_activity_type: 'manual' })
    case 'record_couple_activity_context':
      return recordActivity(requireCouple(user), user.id, args)
    case 'interact_with_couple_pet': {
      const id = requireCouple(user); const action = String(args.p_action || '')
      if (!['feed', 'play', 'pet'].includes(action)) throw createError({ statusCode: 400, statusMessage: '不支持的宠物互动' })
      ensurePet(id); const exp = action === 'play' ? 3 : 1; const now = nowIso()
      run(`UPDATE couple_pets SET hunger=CASE WHEN ?='feed' THEN MIN(100,hunger+16) ELSE hunger END,mood=CASE WHEN ?='play' THEN MIN(100,mood+14) WHEN ?='pet' THEN MIN(100,mood+7) ELSE mood END,experience=experience+?,level=MIN(100,CAST((experience+?)/50 AS INTEGER)+1),updated_at=? WHERE couple_id=?`, action, action, action, exp, exp, now, id)
      const pet = mapPet(one('SELECT * FROM couple_pets WHERE couple_id=?', id)); publishRealtime(id, { type: 'postgres_changes', table: 'couple_pets', event: 'UPDATE', new: pet, old: null }); return pet
    }
    case 'update_couple_pet_style': {
      const id = requireCouple(user); const skin = String(args.p_skin || ''); const species = args.p_species == null ? null : String(args.p_species)
      const accessories = Array.isArray(args.p_accessories) ? args.p_accessories.slice(0, 3) : []
      if (!['lavender', 'pink', 'mint', 'night'].includes(skin)) throw createError({ statusCode: 400, statusMessage: '不支持的宠物外观' })
      if (species && !['bunny', 'cat', 'puppy', 'bear', 'fox', 'panda', 'penguin', 'hamster'].includes(species)) throw createError({ statusCode: 400, statusMessage: '不支持的宠物种类' })
      ensurePet(id); run('UPDATE couple_pets SET skin=?,accessories=?,species=COALESCE(?,species),updated_at=? WHERE couple_id=?', skin, JSON.stringify(accessories), species, nowIso(), id)
      const pet = mapPet(one('SELECT * FROM couple_pets WHERE couple_id=?', id)); publishRealtime(id, { type: 'postgres_changes', table: 'couple_pets', event: 'UPDATE', new: pet, old: null }); return pet
    }
    case 'get_couple_streak_history': {
      const id = requireCouple(user); const month = String(args.p_month || todayShanghai()).slice(0, 7); const start = `${month}-01`; const next = new Date(`${start}T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1); const end = next.toISOString().slice(0, 10)
      const rawDays = all<any>('SELECT activity_date,user_id,activity_type FROM streak_day_actions WHERE couple_id=? AND activity_date>=? AND activity_date<? ORDER BY activity_date', id, start, end)
      const grouped = new Map<string, any>()
      for (const row of rawDays) { const current = grouped.get(row.activity_date) || { date: row.activity_date, count: 0, actor_ids: [], sources: [] }; current.count += 1; if (!current.actor_ids.includes(row.user_id)) current.actor_ids.push(row.user_id); if (!current.sources.includes(row.activity_type)) current.sources.push(row.activity_type); grouped.set(row.activity_date, current) }
      return { month: start, days: [...grouped.values()], events: all('SELECT activity_date AS date,actor_id,activity_type,mood,note,created_at FROM streak_activity_events WHERE couple_id=? AND activity_date>=? AND activity_date<? ORDER BY created_at DESC', id, start, end), milestones: all('SELECT milestone_days AS days,reward_key,achieved_at FROM couple_streak_milestones WHERE couple_id=? ORDER BY milestone_days', id), rewards: all('SELECT reward_key,reward_type,unlocked_at FROM couple_pet_rewards WHERE couple_id=? ORDER BY unlocked_at', id) }
    }
    case 'save_ai_diary': {
      const id = requireCouple(user); const date = String(args.p_work_date || todayShanghai()); const title = String(args.p_title || '').trim().slice(0, 120); const content = String(args.p_content || '').trim().slice(0, 5000)
      if (!title || !content) throw createError({ statusCode: 400, statusMessage: '日记标题和内容不能为空' })
      transaction(() => {
        const existing = one<any>("SELECT * FROM ai_saved_works WHERE couple_id=? AND kind='diary' AND work_date=?", id, date)
        if (existing) {
          run('UPDATE ai_saved_works SET title=?,content=?,updated_at=? WHERE id=?', title, content, nowIso(), existing.id)
          if (existing.memory_id) run('UPDATE memories SET content=?,memory_date=?,updated_at=? WHERE id=?', content, date, nowIso(), existing.memory_id)
        } else {
          const memoryId = newId(); const now = nowIso()
          run('INSERT INTO memories(id,couple_id,author_id,content,memory_date,photos,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', memoryId, id, user.id, content, date, '[]', now, now)
          run('INSERT INTO ai_saved_works(id,couple_id,user_id,kind,work_date,title,content,memory_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', newId(), id, user.id, 'diary', date, title, content, memoryId, now, now)
        }
      })
      return null
    }
    default:
      throw createError({ statusCode: 404, statusMessage: '不支持的本地操作' })
  }
}
