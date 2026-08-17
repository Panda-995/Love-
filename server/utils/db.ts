import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

type LocalDb = DatabaseSync

const schema = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  recovery_salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  last_login_user_agent TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS couples (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  relationship_start TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES profiles(id),
  cover_path TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS couple_members (
  couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (couple_id, user_id)
);
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_by TEXT NOT NULL REFERENCES profiles(id),
  expires_at TEXT NOT NULL,
  accepted_by TEXT REFERENCES profiles(id),
  accepted_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES profiles(id),
  content TEXT NOT NULL,
  memory_date TEXT NOT NULL,
  location TEXT,
  photos TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_couple_date_idx ON memories(couple_id, memory_date DESC);

CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES profiles(id),
  name TEXT NOT NULL,
  description TEXT,
  cover_path TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS album_photos (
  id TEXT PRIMARY KEY,
  album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  uploaded_by TEXT NOT NULL REFERENCES profiles(id),
  path TEXT NOT NULL UNIQUE,
  thumb_path TEXT,
  medium_path TEXT,
  original_path TEXT,
  video_poster_path TEXT,
  caption TEXT,
  media_type TEXT NOT NULL DEFAULT 'image',
  taken_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS album_photos_album_idx ON album_photos(album_id, taken_date DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES profiles(id),
  content TEXT,
  image_path TEXT,
  media_path TEXT,
  media_type TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_couple_created_idx ON messages(couple_id, created_at DESC);
CREATE TABLE IF NOT EXISTS couple_letters (
  id TEXT PRIMARY KEY,
  couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES profiles(id),
  recipient_id TEXT NOT NULL REFERENCES profiles(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS anniversaries (
  id TEXT PRIMARY KEY,
  couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES profiles(id),
  title TEXT NOT NULL,
  event_date TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'custom',
  recurring INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS together_items (
  id TEXT PRIMARY KEY,
  couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES profiles(id),
  title TEXT NOT NULL,
  note TEXT,
  category TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  planned_date TEXT,
  completed INTEGER NOT NULL DEFAULT 0,
  completed_by TEXT REFERENCES profiles(id),
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_saved_works (
  id TEXT PRIMARY KEY,
  couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES profiles(id),
  kind TEXT NOT NULL,
  work_date TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_saved_diary_per_day ON ai_saved_works(couple_id, kind, work_date) WHERE kind = 'diary';

CREATE TABLE IF NOT EXISTS couple_pets (
  id TEXT PRIMARY KEY,
  couple_id TEXT NOT NULL UNIQUE REFERENCES couples(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '小爱',
  species TEXT NOT NULL DEFAULT 'bunny',
  level INTEGER NOT NULL DEFAULT 1,
  experience INTEGER NOT NULL DEFAULT 0,
  mood INTEGER NOT NULL DEFAULT 82,
  hunger INTEGER NOT NULL DEFAULT 78,
  skin TEXT NOT NULL DEFAULT 'lavender',
  accessories TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS couple_streaks (
  id TEXT PRIMARY KEY,
  couple_id TEXT NOT NULL UNIQUE REFERENCES couples(id) ON DELETE CASCADE,
  current_days INTEGER NOT NULL DEFAULT 0,
  longest_days INTEGER NOT NULL DEFAULT 0,
  last_completed_date TEXT,
  protection_count INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS streak_day_actions (
  couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  activity_date TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL DEFAULT 'manual',
  mood INTEGER,
  note TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (couple_id, activity_date, user_id)
);
CREATE TABLE IF NOT EXISTS streak_activity_events (
  id TEXT PRIMARY KEY,
  couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  activity_date TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL,
  mood INTEGER,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS couple_streak_milestones (
  couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  milestone_days INTEGER NOT NULL,
  reward_key TEXT NOT NULL,
  achieved_at TEXT NOT NULL,
  PRIMARY KEY (couple_id, milestone_days)
);
CREATE TABLE IF NOT EXISTS couple_pet_rewards (
  couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  reward_key TEXT NOT NULL,
  reward_type TEXT NOT NULL,
  unlocked_at TEXT NOT NULL,
  PRIMARY KEY (couple_id, reward_key)
);

CREATE TABLE IF NOT EXISTS memory_favorites (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, user_id)
);
CREATE TABLE IF NOT EXISTS memory_reactions (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS memory_comments (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  device_label TEXT,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS call_records (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL UNIQUE,
  couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  caller_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  call_mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'calling',
  started_at TEXT NOT NULL,
  answered_at TEXT,
  ended_at TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0
);
`

declare global {
  // eslint-disable-next-line no-var
  var __loveHomeDb: LocalDb | undefined
}

export function nowIso() {
  return new Date().toISOString()
}

export function newId() {
  return randomUUID()
}

export function useLocalDb() {
  if (globalThis.__loveHomeDb) return globalThis.__loveHomeDb
  const config = useRuntimeConfig()
  const dataDir = String(config.localDataDir || join(process.cwd(), '.data'))
  const dbPath = join(dataDir, 'love.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  mkdirSync(join(dataDir, 'media'), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  db.exec(schema)
  globalThis.__loveHomeDb = db
  return db
}

export function one<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]) {
  return useLocalDb().prepare(sql).get(...params) as T | undefined
}

export function all<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]) {
  return useLocalDb().prepare(sql).all(...params) as T[]
}

export function run(sql: string, ...params: SQLInputValue[]) {
  return useLocalDb().prepare(sql).run(...params)
}

export function transaction<T>(work: () => T) {
  const db = useLocalDb()
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
