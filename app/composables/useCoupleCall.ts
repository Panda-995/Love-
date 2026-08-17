type CallStatus = 'idle' | 'calling' | 'ringing' | 'connected'
type CallMode = 'audio' | 'video'

import { notifySystem, requestSystemAlerts } from './useSystemAlerts'
import { hideNativeCallOverlay, showNativeCallOverlay, startNativeCallService, startNativeIncomingAlert, stopNativeCallService, stopNativeIncomingAlert } from './useAndroidCallControls'
import { createUuid } from '~/utils/browserUuid'

const callStatus = ref<CallStatus>('idle')
const callError = ref('')
const muted = ref(false)
const cameraOff = ref(false)
const callMode = ref<CallMode>('audio')
const remoteAudio = ref<HTMLAudioElement | null>(null)
const localVideo = ref<HTMLVideoElement | null>(null)
const remoteVideo = ref<HTMLVideoElement | null>(null)
let signalChannel: any = null
let channelReady: Promise<void> | null = null
let connection: RTCPeerConnection | null = null
let localStream: MediaStream | null = null
let remoteStream: MediaStream | null = null
let pendingOffer: any = null
let pendingIce: RTCIceCandidateInit[] = []
let activeCallId = ''
let pendingInviteId = ''
let offerRetryTimer: ReturnType<typeof setInterval> | null = null
let ringtoneContext: AudioContext | null = null
let ringtoneTimer: ReturnType<typeof setInterval> | null = null
let ringtoneGeneration = 0
let channelReconnectTimer: ReturnType<typeof setTimeout> | null = null
let channelReconnectAttempt = 0
let callListenersReady = false
let callOnlineHandler: (() => void) | null = null

function readableCallError(error: any, fallback: string) {
  const detail = [error?.message, error?.name].find(value => typeof value === 'string' && value.trim())
  if (detail === 'NotAllowedError') return '请允许浏览器使用麦克风和摄像头后重试。'
  if (detail === 'NotFoundError') return '未找到可用的麦克风或摄像头。'
  if (detail === 'NotReadableError') return '麦克风或摄像头正被其他应用占用。'
  return detail ? String(detail) : fallback
}

function stopRingtone() {
  ringtoneGeneration += 1
  if (ringtoneTimer) clearInterval(ringtoneTimer)
  ringtoneTimer = null
  if (ringtoneContext) { void ringtoneContext.close().catch(() => undefined); ringtoneContext = null }
  void stopNativeIncomingAlert(); void hideNativeCallOverlay()
}

function playRingtonePulse() {
  if (!ringtoneContext) return
  const oscillator = ringtoneContext.createOscillator(); const gain = ringtoneContext.createGain()
  oscillator.type = 'sine'; oscillator.frequency.value = 880; gain.gain.setValueAtTime(.0001, ringtoneContext.currentTime); gain.gain.exponentialRampToValueAtTime(.14, ringtoneContext.currentTime + .03); gain.gain.exponentialRampToValueAtTime(.0001, ringtoneContext.currentTime + .42)
  oscillator.connect(gain).connect(ringtoneContext.destination); oscillator.start(); oscillator.stop(ringtoneContext.currentTime + .45)
}

async function startRingtone(name: string, mode: CallMode) {
  if (ringtoneTimer) return
  const generation = ++ringtoneGeneration
  void requestSystemAlerts(); void startNativeCallService(mode); void showNativeCallOverlay(`${name || 'TA'} 正在${mode === 'video' ? '视频' : '语音'}来电`)
  try {
    const { isNativeAndroid } = await import('./useAndroidCallControls')
    if (isNativeAndroid()) { await startNativeIncomingAlert(); if (generation !== ringtoneGeneration) { await stopNativeIncomingAlert(); return }; void notifySystem(`${name || 'TA'} 发来${mode === 'video' ? '视频' : '语音'}来电`, '点击应用内的接听按钮接通通话', 2001); return }
  } catch { /* Use the browser ringtone. */ }
  if ('vibrate' in navigator) navigator.vibrate?.([350, 180, 350, 700])
  const AudioContextCtor = globalThis.AudioContext || (globalThis as any).webkitAudioContext
  if (!AudioContextCtor) return
  try { ringtoneContext = new AudioContextCtor(); await ringtoneContext.resume(); playRingtonePulse(); ringtoneTimer = setInterval(playRingtonePulse, 1100) } catch { stopRingtone() }
}

function stopOfferRetry() { if (offerRetryTimer) clearInterval(offerRetryTimer); offerRetryTimer = null }

async function attachStreams() {
  await nextTick()
  if (localVideo.value) { localVideo.value.srcObject = callMode.value === 'video' ? localStream : null; if (localStream) void localVideo.value.play().catch(() => undefined) }
  if (remoteAudio.value && remoteStream) { remoteAudio.value.srcObject = remoteStream; void remoteAudio.value.play().catch(() => undefined) }
  if (remoteVideo.value) { remoteVideo.value.srcObject = callMode.value === 'video' ? remoteStream : null; if (remoteStream) void remoteVideo.value.play().catch(() => undefined) }
}

export function useCoupleCall() {
  const { $supabase } = useNuxtApp()
  const { profile, demoMode } = useCoupleAuth()

  async function broadcast(event: string, payload: Record<string, unknown> = {}) {
    if (!signalChannel) throw new Error('通话信令尚未连接')
    const status = await signalChannel.send({ type: 'broadcast', event, payload: { ...payload, senderId: profile.value?.id } })
    if (status !== 'ok') throw new Error('通话信令发送失败')
  }

  async function createPeer(mode: CallMode) {
    cleanupPeer()
    callMode.value = mode
    const rtc = await $fetch<{ iceServers: RTCIceServer[] }>('/api/rtc')
    connection = new RTCPeerConnection({ iceServers: rtc.iceServers })
    remoteStream = new MediaStream()
    connection.ontrack = event => { for (const track of event.streams[0]?.getTracks() || [event.track]) if (!remoteStream!.getTracks().some(item => item.id === track.id)) remoteStream!.addTrack(track); stopRingtone(); callStatus.value = 'connected'; void attachStreams() }
    connection.onicecandidate = event => { if (event.candidate) void broadcast('webrtc-ice', { callId: activeCallId || pendingInviteId, candidate: event.candidate.toJSON() }).catch(() => undefined) }
    connection.onconnectionstatechange = () => {
      if (connection?.connectionState === 'connected') { stopRingtone(); callStatus.value = 'connected' }
      if (['failed', 'disconnected'].includes(connection?.connectionState || '')) { callError.value = '通话连接已断开'; cleanup() }
    }
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: mode === 'video' })
    for (const track of localStream.getTracks()) connection.addTrack(track, localStream)
    await attachStreams()
  }

  async function addPendingIce() {
    if (!connection?.remoteDescription) return
    const candidates = pendingIce.splice(0)
    for (const candidate of candidates) await connection.addIceCandidate(candidate).catch(() => undefined)
  }

  function queueCallChannelReconnect(reconnect: () => Promise<void>) {
    if (channelReconnectTimer || !import.meta.client || demoMode.value || !profile.value?.coupleId) return
    const wait = Math.min(15000, Math.max(1000, 1000 * 2 ** channelReconnectAttempt)); channelReconnectAttempt = Math.min(channelReconnectAttempt + 1, 5)
    channelReconnectTimer = setTimeout(() => { channelReconnectTimer = null; void reconnect().catch(() => queueCallChannelReconnect(reconnect)) }, wait)
  }

  async function ensureChannel() {
    if (demoMode.value || !profile.value?.coupleId) throw new Error('通话需要登录并绑定情侣空间')
    if (channelReady) return channelReady
    if (import.meta.client && !callListenersReady) { callOnlineHandler = () => { channelReconnectAttempt = 0; queueCallChannelReconnect(ensureChannel) }; window.addEventListener('online', callOnlineHandler); callListenersReady = true }
    signalChannel = $supabase.channel(`webrtc-call:${profile.value.coupleId}`, { config: { broadcast: { self: false, ack: true } } })
      .on('broadcast', { event: 'offer' }, ({ payload }: any) => {
        if (payload?.senderId === profile.value?.id || (callStatus.value !== 'idle' && payload?.callId !== pendingInviteId)) return
        pendingInviteId = String(payload?.callId || ''); pendingOffer = payload; callMode.value = payload?.callMode === 'video' ? 'video' : 'audio'; callStatus.value = 'ringing'; void startRingtone('TA', callMode.value)
      })
      .on('broadcast', { event: 'answer' }, async ({ payload }: any) => {
        if (payload?.senderId === profile.value?.id || payload?.callId !== activeCallId || !connection) return
        stopOfferRetry()
        try { await connection.setRemoteDescription(payload.description); await addPendingIce() } catch (error: any) { callError.value = readableCallError(error, '通话应答失败'); cleanup() }
      })
      .on('broadcast', { event: 'webrtc-ice' }, async ({ payload }: any) => {
        if (payload?.senderId === profile.value?.id || !payload?.candidate || ![activeCallId, pendingInviteId].includes(String(payload.callId || ''))) return
        if (connection?.remoteDescription) await connection.addIceCandidate(payload.candidate).catch(() => undefined)
        else pendingIce.push(payload.candidate)
      })
      .on('broadcast', { event: 'hang-up' }, ({ payload }: any) => { if (!payload?.callId || [activeCallId, pendingInviteId].includes(String(payload.callId))) cleanup() })
      .on('broadcast', { event: 'reject' }, ({ payload }: any) => { if (!payload?.callId || payload.callId === activeCallId) { callError.value = '对方暂时无法接听'; cleanup() } })
    channelReady = new Promise<void>((resolve, reject) => signalChannel.subscribe((status: string) => { if (status === 'SUBSCRIBED') { channelReconnectAttempt = 0; resolve() }; if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) reject(new Error('通话信令连接失败')) }))
      .catch(async error => { const failed = signalChannel; signalChannel = null; channelReady = null; if (failed) await $supabase.removeChannel(failed); queueCallChannelReconnect(ensureChannel); throw error })
    return channelReady
  }

  async function sendIncomingCallPush(mode: CallMode, callId: string) {
    await $supabase.functions.invoke('send-call-push', { body: { coupleId: profile.value?.coupleId, callId, mode, callerName: profile.value?.displayName || 'TA' } }).catch(() => undefined)
  }

  async function startCall(mode: CallMode = 'audio') {
    if (callStatus.value !== 'idle') return
    callError.value = ''
    try {
      void requestSystemAlerts(); await ensureChannel(); activeCallId = createUuid(); callStatus.value = 'calling'; void startNativeCallService(mode); void showNativeCallOverlay(mode === 'video' ? '视频通话拨号中' : '语音通话拨号中')
      await createPeer(mode)
      const description = await connection!.createOffer(); await connection!.setLocalDescription(description)
      const sendOffer = () => broadcast('offer', { callMode: mode, callId: activeCallId, description: connection!.localDescription })
      await sendOffer(); void sendIncomingCallPush(mode, activeCallId)
      let retries = 0; offerRetryTimer = setInterval(() => { if (callStatus.value !== 'calling' || retries++ >= 4) { stopOfferRetry(); return }; void sendOffer().catch(() => cleanup()) }, 1500)
    } catch (error: any) { callError.value = readableCallError(error, '无法发起通话'); cleanup() }
  }

  async function acceptCall() {
    if (!pendingOffer || callStatus.value !== 'ringing') return
    callError.value = ''; stopRingtone(); activeCallId = pendingInviteId
    try {
      await ensureChannel(); await createPeer(callMode.value); await connection!.setRemoteDescription(pendingOffer.description); await addPendingIce(); const answer = await connection!.createAnswer(); await connection!.setLocalDescription(answer); await broadcast('answer', { callMode: callMode.value, callId: activeCallId, description: connection!.localDescription })
    } catch (error: any) { callError.value = readableCallError(error, '无法接听通话'); cleanup() }
  }

  async function rejectCall() { const callId = pendingInviteId; stopRingtone(); await broadcast('reject', { callId }).catch(() => undefined); cleanup() }
  async function hangUp() { const callId = activeCallId || pendingInviteId; stopRingtone(); await broadcast('hang-up', { callId }).catch(() => undefined); cleanup() }
  function toggleMute() { muted.value = !muted.value; for (const track of localStream?.getAudioTracks() || []) track.enabled = !muted.value }
  function toggleCamera() { if (callMode.value !== 'video') return; cameraOff.value = !cameraOff.value; for (const track of localStream?.getVideoTracks() || []) track.enabled = !cameraOff.value }

  function cleanupPeer() {
    connection?.close(); connection = null
    for (const track of localStream?.getTracks() || []) track.stop()
    for (const track of remoteStream?.getTracks() || []) track.stop()
    localStream = null; remoteStream = null
    if (remoteAudio.value) { remoteAudio.value.pause(); remoteAudio.value.srcObject = null }
    if (localVideo.value) localVideo.value.srcObject = null
    if (remoteVideo.value) { remoteVideo.value.pause(); remoteVideo.value.srcObject = null }
  }

  function cleanup() {
    stopRingtone(); stopOfferRetry(); void stopNativeCallService(); void hideNativeCallOverlay(); cleanupPeer(); pendingOffer = null; pendingIce = []; activeCallId = ''; pendingInviteId = ''; muted.value = false; cameraOff.value = false; callMode.value = 'audio'; callStatus.value = 'idle'
  }

  async function disconnectCall() {
    cleanup(); if (channelReconnectTimer) clearTimeout(channelReconnectTimer); channelReconnectTimer = null
    if (signalChannel) await $supabase.removeChannel(signalChannel); signalChannel = null; channelReady = null
    if (import.meta.client && callListenersReady && callOnlineHandler) { window.removeEventListener('online', callOnlineHandler); callOnlineHandler = null; callListenersReady = false }
  }

  return { callStatus, callError, muted, cameraOff, callMode, remoteAudio, localVideo, remoteVideo, ensureChannel, startCall, acceptCall, rejectCall, hangUp, toggleMute, toggleCamera, disconnectCall }
}
