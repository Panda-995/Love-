import { reactive, ref } from 'vue'

export type SpaceServiceKey = 'supabase' | 'media' | 'push' | 'call'
export type SpaceServiceState = 'checking' | 'ok' | 'warning' | 'error' | 'offline'
export type SpaceService = { state: SpaceServiceState; detail: string }

const services = reactive<Record<SpaceServiceKey, SpaceService>>({
  supabase: { state: 'checking', detail: '等待检查' },
  media: { state: 'checking', detail: '等待检查' },
  push: { state: 'checking', detail: '等待检查' },
  call: { state: 'checking', detail: '等待检查' },
})
const networkOnline = ref(true)
const lastSyncAt = ref('')
let listenersReady = false

function withTimeout<T>(promise: PromiseLike<T>, timeout = 8000) {
  return Promise.race([Promise.resolve(promise), new Promise<T | null>(resolve => globalThis.setTimeout(() => resolve(null), timeout))])
}

function saveLastSync() {
  if (typeof window === 'undefined') return
  lastSyncAt.value = new Date().toISOString()
  try { window.localStorage.setItem('couple-space-last-sync-at', lastSyncAt.value) } catch {}
}

function setupNetworkListeners() {
  if (!import.meta.client || listenersReady) return
  listenersReady = true
  networkOnline.value = navigator.onLine
  window.addEventListener('online', () => { networkOnline.value = true })
  window.addEventListener('offline', () => { networkOnline.value = false })
  try { lastSyncAt.value = window.localStorage.getItem('couple-space-last-sync-at') || '' } catch {}
}

async function checkPushPermission() {
  if (!import.meta.client) return { state: 'checking' as const, detail: '等待浏览器加载' }
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      const { PushNotifications } = await import('@capacitor/push-notifications')
      const permission = await PushNotifications.checkPermissions()
      if (permission.receive === 'granted') return { state: 'ok' as const, detail: 'Android 推送权限已开启' }
      if (permission.receive === 'denied') return { state: 'error' as const, detail: '系统已拒绝推送权限' }
      return { state: 'warning' as const, detail: '尚未允许 Android 推送' }
    }
  } catch {}
  if (typeof Notification === 'undefined') return { state: 'warning' as const, detail: '当前环境不支持系统通知' }
  if (Notification.permission === 'granted') return { state: 'ok' as const, detail: '浏览器通知权限已开启' }
  if (Notification.permission === 'denied') return { state: 'error' as const, detail: '浏览器已拒绝通知权限' }
  return { state: 'warning' as const, detail: '尚未允许浏览器通知' }
}

export function useSpaceStatus() {
  const { $supabase } = useNuxtApp()
  const { profile, demoMode } = useCoupleAuth()

  async function refresh() {
    setupNetworkListeners()
    if (!networkOnline.value) {
      services.supabase = { state: 'offline', detail: '设备当前处于离线状态' }
      services.media = { state: 'offline', detail: '等待网络恢复' }
      services.call = { state: 'offline', detail: '等待网络恢复' }
      services.push = await checkPushPermission()
      return
    }
    services.supabase = { state: 'checking', detail: '正在检查本地 SQLite' }
    services.media = { state: 'checking', detail: '正在检查 NAS 媒体目录' }
    services.call = { state: 'checking', detail: '正在检查 WebRTC 与 coturn' }
    services.push = await checkPushPermission()
    if (!$supabase || demoMode.value) {
      services.supabase = { state: 'warning', detail: '本地服务尚未连接' }
      services.media = { state: 'warning', detail: 'NAS 媒体目录尚未连接' }
      services.call = { state: 'warning', detail: '登录并绑定情侣空间后可用' }
      saveLastSync()
      return
    }
    const memberCheck: any = await withTimeout($supabase.from('couple_members').select('user_id', { count: 'exact', head: true }).eq('user_id', profile.value?.id || ''))
    if (!memberCheck) services.supabase = { state: 'error', detail: '数据库请求超时' }
    else if (memberCheck.error) services.supabase = { state: 'error', detail: '本地数据库连接失败，请重试' }
    else services.supabase = { state: 'ok', detail: 'SQLite 数据库连接正常' }
    const coupleId = profile.value?.coupleId
    const mediaCheck: any = coupleId ? await withTimeout($supabase.storage.from('album-media').list(coupleId, { limit: 1 })) : null
    if (!coupleId) services.media = { state: 'warning', detail: '绑定情侣空间后检查媒体服务' }
    else if (!mediaCheck) services.media = { state: 'error', detail: '图片服务请求超时' }
    else if (mediaCheck.error) services.media = { state: 'error', detail: '私有图片服务不可用' }
    else services.media = { state: 'ok', detail: 'NAS 媒体目录读写正常' }
    if (!coupleId) services.call = { state: 'warning', detail: '绑定情侣空间后检查通话服务' }
    else {
      const rtc = await withTimeout($fetch<{ turnConfigured: boolean }>('/api/rtc').catch(() => null))
      if (!rtc) services.call = { state: 'error', detail: 'WebRTC 配置请求失败' }
      else services.call = rtc.turnConfigured ? { state: 'ok', detail: 'WebRTC 与本地 coturn 已配置' } : { state: 'warning', detail: 'WebRTC 可用于局域网；请配置 TURN_HOST 供外网通话' }
    }
    saveLastSync()
  }

  async function testCallService() {
    if (!$supabase || !profile.value?.coupleId) {
      services.call = { state: 'warning', detail: '请先登录并绑定情侣空间' }
      return false
    }
    services.call = { state: 'checking', detail: '正在检查 WebRTC 与 coturn' }
    const response = await withTimeout($fetch<{ iceServers: RTCIceServer[]; turnConfigured: boolean }>('/api/rtc').catch(() => null))
    if (!response) { services.call = { state: 'error', detail: '本地通话配置请求超时' }; return false }
    services.call = response.turnConfigured ? { state: 'ok', detail: '本地 coturn 临时凭据生成正常' } : { state: 'warning', detail: '局域网通话可用；外网通话需要配置 TURN_HOST' }
    return true
  }

  return { services, networkOnline, lastSyncAt, refresh, testCallService }
}
