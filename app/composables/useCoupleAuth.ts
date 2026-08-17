export type CoupleStage = 'signed-out' | 'unpaired' | 'paired'

type LocalUser = { id: string; email?: string; user_metadata?: { display_name?: string; username?: string } }
type CoupleProfile = { id: string; displayName: string; email: string; partnerName?: string; coupleId?: string }

const user = ref<LocalUser | null>(null)
const profile = ref<CoupleProfile | null>(null)
const stage = ref<CoupleStage>('signed-out')
const loading = ref(false)
const initialized = ref(false)
const demoMode = ref(false)

export function useCoupleAuth() {
  const { $supabase } = useNuxtApp()
  const configured = computed(() => true)

  async function loadMembership(userId: string, email: string) {
    const { data: member, error } = await $supabase.from('couple_members').select('couple_id, couples(name)').eq('user_id', userId).maybeSingle()
    if (error && !String(error.message || '').includes('未找到数据')) throw error
    const memberData = member as any
    profile.value = { id: userId, email, displayName: user.value?.user_metadata?.display_name || user.value?.user_metadata?.username || '情侣成员', coupleId: memberData?.couple_id }
    stage.value = memberData?.couple_id ? 'paired' : 'unpaired'
  }

  async function applySession(session: any) {
    user.value = session?.user || null
    if (user.value) await loadMembership(user.value.id, user.value.email || '')
    else { profile.value = null; stage.value = 'signed-out' }
  }

  async function initialize() {
    if (initialized.value || !import.meta.client) return
    initialized.value = true
    const { data } = await $supabase.auth.getSession()
    await applySession(data.session)
    $supabase.auth.onAuthStateChange(async (_event: string, session: any) => applySession(session))
  }

  const accountEmail = (username: string) => `account.${username.trim().toLowerCase()}@users.love-home.invalid`

  async function signInWithAccount(username: string, password: string) {
    loading.value = true
    try { const { error } = await $supabase.auth.signInWithPassword({ email: accountEmail(username), password }); if (error) throw error }
    finally { loading.value = false }
  }

  async function accountRequest(body: Record<string, string>) {
    const { data, error } = await $supabase.functions.invoke('account-auth', { body })
    if (error) throw error
    if (data?.error) throw new Error(data.error)
    return data
  }

  async function signUpWithAccount(displayName: string, username: string, password: string) {
    loading.value = true
    try { return await accountRequest({ action: 'register', displayName, username, password }) }
    finally { loading.value = false }
  }

  async function recoverAccount(username: string, recoveryCode: string, newPassword: string) {
    loading.value = true
    try { await accountRequest({ action: 'recover', username, recoveryCode, newPassword }) }
    finally { loading.value = false }
  }

  async function updatePassword(password: string) {
    if (password.length < 8) throw new Error('新密码至少需要 8 位')
    const { error } = await $supabase.auth.updateUser({ password })
    if (error) throw error
  }

  async function createCouple(displayName: string, relationshipStart: string) {
    loading.value = true
    try {
      const { data, error } = await $supabase.rpc('create_couple_with_invitation', { couple_name: displayName, relationship_start: relationshipStart })
      if (error) throw error
      await loadMembership(user.value!.id, user.value!.email || '')
      return data as string
    } finally { loading.value = false }
  }

  async function joinCouple(code: string) {
    loading.value = true
    try {
      const { error } = await $supabase.rpc('accept_couple_invitation', { invitation_code: code.trim().toUpperCase() })
      if (error) throw error
      await loadMembership(user.value!.id, user.value!.email || '')
    } finally { loading.value = false }
  }

  async function signOut() {
    await $supabase.auth.signOut()
    user.value = null; profile.value = null; stage.value = 'signed-out'; demoMode.value = false
  }

  return { configured, demoMode, initialized, loading, profile, stage, initialize, signInWithAccount, signUpWithAccount, recoverAccount, updatePassword, createCouple, joinCouple, signOut }
}
