type ApiResult<T = any> = { data: T | null; error: any; count?: number | null }
type ChannelHandler = { type: string; filter: Record<string, any>; callback: (payload: any) => void }

function errorMessage(response: Response, body: any) {
  return String(body?.statusMessage || body?.message || body?.error || response.statusText || `HTTP ${response.status}`)
}

async function api<T = any>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init, headers: { ...(init?.body instanceof FormData ? {} : { 'content-type': 'application/json' }), ...(init?.headers || {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error: any = new Error(errorMessage(response, body))
    error.context = response
    error.status = response.status
    throw error
  }
  return body as T
}

class LocalQueryBuilder implements PromiseLike<ApiResult> {
  private operation: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select'
  private values: any = undefined
  private filters: Array<{ op: string; column: string; value: unknown }> = []
  private orders: Array<{ column: string; ascending?: boolean }> = []
  private rowLimit = 0
  private head = false
  private countMode = ''
  private returnRows = false
  private singleMode: 'single' | 'maybeSingle' | '' = ''
  private conflict = ''

  constructor(private table: string) {}

  select(_columns = '*', options: { count?: string; head?: boolean } = {}) {
    if (this.operation !== 'select') this.returnRows = true
    this.countMode = options.count || this.countMode
    this.head = Boolean(options.head)
    return this
  }

  insert(values: any) { this.operation = 'insert'; this.values = values; return this }
  upsert(values: any, options: { onConflict?: string } = {}) { this.operation = 'upsert'; this.values = values; this.conflict = options.onConflict || ''; return this }
  update(values: any) { this.operation = 'update'; this.values = values; return this }
  delete() { this.operation = 'delete'; return this }
  eq(column: string, value: unknown) { this.filters.push({ op: 'eq', column, value }); return this }
  in(column: string, value: unknown[]) { this.filters.push({ op: 'in', column, value }); return this }
  lt(column: string, value: unknown) { this.filters.push({ op: 'lt', column, value }); return this }
  gte(column: string, value: unknown) { this.filters.push({ op: 'gte', column, value }); return this }
  order(column: string, options: { ascending?: boolean } = {}) { this.orders.push({ column, ascending: options.ascending !== false }); return this }
  limit(value: number) { this.rowLimit = value; return this }
  single() { this.singleMode = 'single'; return this }
  maybeSingle() { this.singleMode = 'maybeSingle'; return this }

  private async execute(): Promise<ApiResult> {
    try {
      const result = await api<ApiResult>('/api/data', { method: 'POST', body: JSON.stringify({ table: this.table, operation: this.operation, values: this.values, filters: this.filters, orders: this.orders, limit: this.rowLimit || undefined, head: this.head, count: this.countMode || undefined, onConflict: this.conflict || undefined, returning: this.returnRows }) })
      if (this.singleMode) {
        const rows = Array.isArray(result.data) ? result.data : []
        if (rows.length > 1 || (this.singleMode === 'single' && rows.length !== 1)) return { data: null, count: result.count, error: new Error(rows.length ? '查询返回多条数据' : '未找到数据') }
        return { ...result, data: rows[0] || null }
      }
      return result
    } catch (error) { return { data: null, error, count: null } }
  }

  then<TResult1 = ApiResult, TResult2 = never>(onfulfilled?: ((value: ApiResult) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null) {
    return this.execute().then(onfulfilled, onrejected)
  }
}

class LocalRealtime {
  private socket: WebSocket | null = null
  private channels = new Set<LocalChannel>()
  private connecting: Promise<void> | null = null

  add(channel: LocalChannel) {
    this.channels.add(channel)
    return this.connect().then(() => channel.status('SUBSCRIBED')).catch(() => channel.status('CHANNEL_ERROR'))
  }

  remove(channel: LocalChannel) {
    this.channels.delete(channel)
    if (!this.channels.size && this.socket) { this.socket.close(1000, 'No active channels'); this.socket = null }
  }

  send(message: Record<string, unknown>) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(message)); return true
  }

  private connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve()
    if (this.connecting) return this.connecting
    this.connecting = new Promise<void>((resolve, reject) => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(`${protocol}//${location.host}/_ws`)
      this.socket = socket
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('本地实时服务连接失败')), { once: true })
      socket.addEventListener('message', event => {
        let message: any
        try { message = JSON.parse(String(event.data || '')) } catch { return }
        if (message.type === 'ready') return
        for (const channel of this.channels) channel.dispatch(message)
      })
      socket.addEventListener('close', () => {
        if (this.socket === socket) this.socket = null
        this.connecting = null
        for (const channel of this.channels) channel.status('CLOSED')
      })
    }).finally(() => { this.connecting = null })
    return this.connecting
  }
}

class LocalChannel {
  private handlers: ChannelHandler[] = []
  private statusCallback: ((status: string) => void) | null = null
  private presence: Record<string, any[]> = {}

  constructor(public name: string, private realtime: LocalRealtime, private options: Record<string, any> = {}) {}

  on(type: string, filter: Record<string, any>, callback: (payload: any) => void) { this.handlers.push({ type, filter, callback }); return this }
  subscribe(callback?: (status: string) => void) { this.statusCallback = callback || null; void this.realtime.add(this); return this }
  status(value: string) { this.statusCallback?.(value) }
  async send(message: Record<string, any>) { return this.realtime.send({ type: 'broadcast', channel: this.name, event: message.event, payload: message.payload, self: Boolean(this.options?.config?.broadcast?.self) }) ? 'ok' : 'error' }
  async track(payload: Record<string, unknown>) { return this.realtime.send({ type: 'presence', channel: this.name, payload }) ? 'ok' : 'error' }
  presenceState() { return this.presence }

  dispatch(message: any) {
    if (message.channel && message.channel !== this.name) return
    if (message.type === 'presence') {
      this.presence = message.state || {}
      for (const handler of this.handlers.filter(item => item.type === 'presence' && (!item.filter.event || item.filter.event === message.event))) handler.callback({})
      return
    }
    if (message.type === 'broadcast') {
      for (const handler of this.handlers.filter(item => item.type === 'broadcast' && (!item.filter.event || item.filter.event === message.event))) handler.callback({ payload: message.payload })
      return
    }
    if (message.type === 'postgres_changes') {
      for (const handler of this.handlers.filter(item => item.type === 'postgres_changes' && (!item.filter.table || item.filter.table === message.table) && (!item.filter.event || item.filter.event === '*' || item.filter.event === message.event))) {
        if (!matchesFilter(handler.filter.filter, message.new || message.old)) continue
        handler.callback({ new: message.new || {}, old: message.old || {}, eventType: message.event })
      }
    }
  }
}

function matchesFilter(filter: unknown, row: any) {
  if (!filter) return true
  const match = String(filter).match(/^([a-zA-Z0-9_]+)=eq\.(.+)$/)
  return !match || String(row?.[match[1]!]) === match[2]
}

export function createLocalClient() {
  const realtime = import.meta.client ? new LocalRealtime() : null
  const authListeners = new Set<(event: string, session: any) => void>()
  const session = async () => {
    const result = await api<any>('/api/auth/session')
    return result.user ? { user: result.user, access_token: 'local-cookie' } : null
  }
  const notify = async (event: string) => { const value = await session(); for (const listener of authListeners) void listener(event, value) }
  const requestAuth = async (url: string, body?: Record<string, unknown>) => {
    try { await api(url, { method: 'POST', body: JSON.stringify(body || {}) }); await notify('SIGNED_IN'); return { data: { session: await session() }, error: null } }
    catch (error) { return { data: { session: null }, error } }
  }
  const client = {
    from: (table: string) => new LocalQueryBuilder(table),
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      try { return await api<ApiResult>('/api/rpc', { method: 'POST', body: JSON.stringify({ name, args }) }) } catch (error) { return { data: null, error } }
    },
    functions: {
      invoke: async (name: string, options: { body?: Record<string, unknown> } = {}) => {
        try { return { data: await api(`/api/functions/${encodeURIComponent(name)}`, { method: 'POST', body: JSON.stringify(options.body || {}) }), error: null } }
        catch (error) { return { data: null, error } }
      },
    },
    auth: {
      getSession: async () => ({ data: { session: await session() }, error: null }),
      onAuthStateChange: (callback: (event: string, session: any) => void) => { authListeners.add(callback); return { data: { subscription: { unsubscribe: () => authListeners.delete(callback) } } } },
      signInWithPassword: ({ email, password }: { email: string; password: string }) => {
        const local = String(email || '').match(/^account\.([^@]+)@users\.love-home\.invalid$/)
        const username = local?.[1] || String(email || '').split('@')[0]
        return requestAuth('/api/auth/login', { username, password })
      },
      signOut: async () => { try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); await notify('SIGNED_OUT'); return { error: null } } catch (error) { return { error } } },
      updateUser: async ({ password }: { password: string }) => requestAuth('/api/auth/password', { password }),
      signInWithOAuth: async () => ({ data: null, error: new Error('本地部署不支持第三方登录') }),
      signUp: async () => ({ data: null, error: new Error('请使用本地账号注册') }),
      resend: async () => ({ data: null, error: new Error('本地账号不需要邮件确认') }),
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, file: File, options: { upsert?: boolean; contentType?: string; cacheControl?: string } = {}) => {
          try { const form = new FormData(); form.append('bucket', bucket); form.append('path', path); form.append('upsert', String(Boolean(options.upsert))); form.append('file', file); await api('/api/storage/upload', { method: 'POST', body: form }); return { data: { path }, error: null } } catch (error) { return { data: null, error } }
        },
        remove: async (paths: string[]) => { try { await api('/api/storage/remove', { method: 'POST', body: JSON.stringify({ bucket, paths }) }); return { data: paths.map(name => ({ name })), error: null } } catch (error) { return { data: null, error } } },
        list: async (path: string, options: { limit?: number } = {}) => { try { return { data: await api(`/api/storage/list?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}&limit=${options.limit || 20}`), error: null } } catch (error) { return { data: null, error } } },
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `/media/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}` }, error: null }),
        createSignedUrls: async (paths: string[]) => ({ data: paths.map(path => ({ path, signedUrl: `/media/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}` })), error: null }),
      }),
    },
    channel: (name: string, options?: Record<string, any>) => {
      if (!realtime) throw new Error('实时服务只能在浏览器中使用')
      return new LocalChannel(name, realtime, options)
    },
    removeChannel: async (channel: LocalChannel) => { realtime?.remove(channel); return 'ok' },
  }
  return client
}

export type LocalClient = ReturnType<typeof createLocalClient>
