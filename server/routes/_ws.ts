import { cookieFromRequest, userFromSessionToken } from '../utils/auth'
import { dropPeerPresence, presencePayload, publishRealtime, realtimePeers, realtimePresence } from '../utils/realtime'

export default defineWebSocketHandler({
  open(peer: any) {
    const user = userFromSessionToken(cookieFromRequest(peer.request))
    if (!user?.coupleId) {
      peer.close(4401, 'Authentication required')
      return
    }
    realtimePeers().set(peer.id, { peer, userId: user.id, coupleId: user.coupleId })
    peer.send(JSON.stringify({ type: 'ready', userId: user.id }))
  },
  message(peer: any, raw: any) {
    const record = realtimePeers().get(peer.id)
    if (!record) return
    let message: any
    try { message = JSON.parse(raw.text()) } catch { return }
    const channel = String(message?.channel || '').slice(0, 180)
    if (!channel || !channel.endsWith(`:${record.coupleId}`)) return
    if (message.type === 'broadcast') {
      publishRealtime(record.coupleId, { type: 'broadcast', channel, event: String(message.event || ''), payload: message.payload || {} }, message.self ? '' : peer.id)
      return
    }
    if (message.type === 'presence') {
      const state = realtimePresence().get(channel) || new Map()
      state.set(peer.id, { ...(message.payload || {}), user_id: record.userId })
      realtimePresence().set(channel, state)
      publishRealtime(record.coupleId, { type: 'presence', channel, event: 'sync', state: presencePayload(channel) })
    }
  },
  close(peer: any) {
    const record = realtimePeers().get(peer.id)
    if (!record) return
    realtimePeers().delete(peer.id)
    dropPeerPresence(peer.id, record.coupleId)
  },
})
