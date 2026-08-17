import { notifySystem } from './useSystemAlerts'
import { hideNativeCallOverlay, showNativeCallOverlay, startNativeCallService, stopNativeCallService } from './useAndroidCallControls'
import { createUuid } from '~/utils/browserUuid'

export type LiveMicStatus = 'idle' | 'broadcasting' | 'listening'
const liveStatus = ref<LiveMicStatus>('idle')
const liveError = ref('')
const liveMuted = ref(false)
const liveRemoteMuted = ref(false)
const liveRemoteName = ref('TA')
const liveNeedsGesture = ref(false)
let signalChannel: any = null
let channelReady: Promise<void> | null = null
let connection: RTCPeerConnection | null = null
let localStream: MediaStream | null = null
let remoteStream: MediaStream | null = null
let audioElement: HTMLAudioElement | null = null
let sessionId = ''
let remoteUserId = ''
let pendingIce: RTCIceCandidateInit[] = []
let ignoreCurrentLive = false
let startInFlight = false
let listenInFlight = false

function readableError(error: any, fallback: string) {
  const name = String(error?.name || '')
  if (name === 'NotAllowedError') return '请允许浏览器使用麦克风后重试。'
  if (name === 'NotFoundError') return '未找到可用的麦克风。'
  if (name === 'NotReadableError') return '麦克风正被其他应用占用。'
  return String(error?.message || fallback)
}

function getAudioElement() {
  if (!import.meta.client) return null
  if (audioElement) return audioElement
  audioElement = document.createElement('audio'); audioElement.autoplay = true; audioElement.setAttribute('playsinline', ''); audioElement.setAttribute('aria-hidden', 'true'); audioElement.style.cssText = 'position:fixed;width:1px;height:1px;opacity:.01;pointer-events:none'; document.body.appendChild(audioElement)
  return audioElement
}

async function playAudio() {
  const audio = getAudioElement()
  if (!audio || !audio.srcObject) return false
  try { await audio.play(); liveNeedsGesture.value = false; return true } catch { liveNeedsGesture.value = true; return false }
}

export function useCoupleLiveMic() {
  const { $supabase } = useNuxtApp()
  const { profile, demoMode } = useCoupleAuth()

  async function broadcast(event: string, payload: Record<string, unknown> = {}) {
    if (!signalChannel) throw new Error('开麦信令尚未连接')
    const status = await signalChannel.send({ type: 'broadcast', event, payload: { ...payload, senderId: profile.value?.id } })
    if (status !== 'ok') throw new Error('开麦信令发送失败')
  }

  async function createPeer(publish: boolean) {
    cleanupPeer()
    const rtc = await $fetch<{ iceServers: RTCIceServer[] }>('/api/rtc')
    connection = new RTCPeerConnection({ iceServers: rtc.iceServers })
    connection.onicecandidate = event => { if (event.candidate) void broadcast('live-ice', { sessionId, targetId: remoteUserId, candidate: event.candidate.toJSON() }).catch(() => undefined) }
    connection.onconnectionstatechange = () => { if (['failed', 'disconnected'].includes(connection?.connectionState || '')) { liveError.value = '开麦连接已断开'; cleanupRoom() } }
    connection.ontrack = event => {
      remoteStream ||= new MediaStream(); for (const track of event.streams[0]?.getTracks() || [event.track]) if (!remoteStream.getTracks().some(item => item.id === track.id)) remoteStream.addTrack(track)
      const audio = getAudioElement(); if (audio) { audio.srcObject = remoteStream; void playAudio() }
    }
    if (publish) {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      for (const track of localStream.getTracks()) connection.addTrack(track, localStream)
    } else connection.addTransceiver('audio', { direction: 'recvonly' })
  }

  async function applyPendingIce() {
    if (!connection?.remoteDescription) return
    for (const candidate of pendingIce.splice(0)) await connection.addIceCandidate(candidate).catch(() => undefined)
  }

  async function beginListening(payload: any) {
    if (ignoreCurrentLive || liveStatus.value !== 'idle' || listenInFlight) return
    liveError.value = ''; liveRemoteName.value = String(payload?.userName || 'TA'); remoteUserId = String(payload?.senderId || ''); sessionId = String(payload?.sessionId || ''); listenInFlight = true
    try { await ensureLiveChannel(); liveStatus.value = 'listening'; await broadcast('live-listen', { sessionId, targetId: remoteUserId }); void notifySystem(`${liveRemoteName.value} 正在开麦`, '正在建立本地音频连接', 2100) }
    catch (error: any) { liveError.value = readableError(error, '无法加入对方的开麦'); cleanupRoom() }
    finally { listenInFlight = false }
  }

  async function ensureLiveChannel() {
    if (demoMode.value || !profile.value?.coupleId) return
    if (channelReady) return channelReady
    signalChannel = $supabase.channel(`webrtc-live:${profile.value.coupleId}`, { config: { broadcast: { self: false, ack: true } } })
      .on('broadcast', { event: 'live-start' }, ({ payload }: any) => { if (payload?.senderId !== profile.value?.id) void beginListening(payload) })
      .on('broadcast', { event: 'live-listen' }, async ({ payload }: any) => {
        if (liveStatus.value !== 'broadcasting' || payload?.targetId !== profile.value?.id || payload?.sessionId !== sessionId) return
        try { remoteUserId = String(payload.senderId || ''); await createPeer(true); const offer = await connection!.createOffer(); await connection!.setLocalDescription(offer); await broadcast('live-offer', { sessionId, targetId: remoteUserId, description: connection!.localDescription }) } catch (error: any) { liveError.value = readableError(error, '无法建立开麦连接') }
      })
      .on('broadcast', { event: 'live-offer' }, async ({ payload }: any) => {
        if (liveStatus.value !== 'listening' || payload?.targetId !== profile.value?.id || payload?.sessionId !== sessionId) return
        try { remoteUserId = String(payload.senderId || ''); await createPeer(false); await connection!.setRemoteDescription(payload.description); await applyPendingIce(); const answer = await connection!.createAnswer(); await connection!.setLocalDescription(answer); await broadcast('live-answer', { sessionId, targetId: remoteUserId, description: connection!.localDescription }) } catch (error: any) { liveError.value = readableError(error, '无法接收开麦音频'); cleanupRoom() }
      })
      .on('broadcast', { event: 'live-answer' }, async ({ payload }: any) => { if (liveStatus.value === 'broadcasting' && payload?.targetId === profile.value?.id && payload?.sessionId === sessionId && connection) { await connection.setRemoteDescription(payload.description).catch(() => undefined); await applyPendingIce() } })
      .on('broadcast', { event: 'live-ice' }, async ({ payload }: any) => {
        if (payload?.targetId !== profile.value?.id || payload?.sessionId !== sessionId || !payload?.candidate) return
        if (connection?.remoteDescription) await connection.addIceCandidate(payload.candidate).catch(() => undefined); else pendingIce.push(payload.candidate)
      })
      .on('broadcast', { event: 'live-stop' }, ({ payload }: any) => { if (payload?.senderId !== profile.value?.id && payload?.sessionId === sessionId) { ignoreCurrentLive = false; cleanupRoom() } })
      .on('broadcast', { event: 'live-mute' }, ({ payload }: any) => { if (payload?.senderId !== profile.value?.id && payload?.sessionId === sessionId) liveRemoteMuted.value = Boolean(payload?.muted) })
    channelReady = new Promise<void>((resolve, reject) => signalChannel.subscribe((status: string) => { if (status === 'SUBSCRIBED') resolve(); if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) reject(new Error('开麦信令连接失败')) }))
      .catch(async error => { const failed = signalChannel; signalChannel = null; channelReady = null; if (failed) await $supabase.removeChannel(failed); throw error })
    return channelReady
  }

  async function startLive() {
    if (liveStatus.value !== 'idle' || startInFlight) return
    if (demoMode.value || !profile.value?.coupleId) { liveError.value = '开麦需要登录并绑定情侣空间'; return }
    liveError.value = ''; ignoreCurrentLive = false; startInFlight = true
    try { await ensureLiveChannel(); sessionId = createUuid(); liveStatus.value = 'broadcasting'; void startNativeCallService('audio'); void showNativeCallOverlay('正在开麦，对方可直接收听'); await broadcast('live-start', { sessionId, userName: profile.value?.displayName || 'TA' }); void notifySystem('已开始开麦', '对方上线后可直接收听', 2102) }
    catch (error: any) { liveError.value = readableError(error, '无法开始开麦'); cleanupRoom() }
    finally { startInFlight = false }
  }

  async function stopLive() { const shouldBroadcast = liveStatus.value === 'broadcasting'; if (shouldBroadcast) await broadcast('live-stop', { sessionId }).catch(() => undefined); ignoreCurrentLive = liveStatus.value === 'listening'; cleanupRoom() }
  function dismissLive() { if (liveStatus.value === 'listening') ignoreCurrentLive = true; cleanupRoom() }
  function toggleLiveMute() { if (liveStatus.value !== 'broadcasting' || !localStream) return; liveMuted.value = !liveMuted.value; for (const track of localStream.getAudioTracks()) track.enabled = !liveMuted.value; void broadcast('live-mute', { sessionId, muted: liveMuted.value }).catch(() => undefined) }
  async function resumeLiveAudio() { await playAudio() }

  function cleanupPeer() { connection?.close(); connection = null; for (const track of localStream?.getTracks() || []) track.stop(); for (const track of remoteStream?.getTracks() || []) track.stop(); localStream = null; remoteStream = null; if (audioElement) { audioElement.pause(); audioElement.srcObject = null }; pendingIce = [] }
  function cleanupRoom() { void stopNativeCallService(); void hideNativeCallOverlay(); cleanupPeer(); liveMuted.value = false; liveRemoteMuted.value = false; liveNeedsGesture.value = false; liveStatus.value = 'idle'; sessionId = ''; remoteUserId = '' }
  async function disconnectLive() { cleanupRoom(); if (signalChannel) await $supabase.removeChannel(signalChannel); signalChannel = null; channelReady = null; ignoreCurrentLive = false; if (audioElement) { audioElement.remove(); audioElement = null }; startInFlight = false; listenInFlight = false }

  return { liveStatus, liveError, liveMuted, liveRemoteMuted, liveRemoteName, liveNeedsGesture, ensureLiveChannel, startLive, stopLive, dismissLive, toggleLiveMute, resumeLiveAudio, disconnectLive }
}
