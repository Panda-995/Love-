type PeerRecord = { peer: any; userId: string; coupleId: string }
type PresenceRecord = Map<string, Record<string, unknown>>

declare global {
  // eslint-disable-next-line no-var
  var __loveRealtimePeers: Map<string, PeerRecord> | undefined
  // eslint-disable-next-line no-var
  var __lovePresence: Map<string, PresenceRecord> | undefined
}

export function realtimePeers() {
  return globalThis.__loveRealtimePeers ||= new Map()
}

export function realtimePresence() {
  return globalThis.__lovePresence ||= new Map()
}

export function publishRealtime(coupleId: string | null | undefined, message: Record<string, unknown>, exceptPeerId = '') {
  if (!coupleId) return
  const encoded = JSON.stringify(message)
  for (const [peerId, record] of realtimePeers()) {
    if (peerId !== exceptPeerId && record.coupleId === coupleId) {
      try { record.peer.send(encoded) } catch { /* The close hook removes stale peers. */ }
    }
  }
}

export function presencePayload(channel: string) {
  const state = realtimePresence().get(channel) || new Map()
  return Object.fromEntries([...state.entries()].map(([key, value]) => [key, [value]]))
}

export function dropPeerPresence(peerId: string, coupleId: string) {
  for (const [channel, state] of realtimePresence()) {
    if (!state.delete(peerId)) continue
    if (!state.size) realtimePresence().delete(channel)
    publishRealtime(coupleId, { type: 'presence', channel, event: 'sync', state: presencePayload(channel) })
  }
}
