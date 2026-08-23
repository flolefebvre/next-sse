// PROTOTYPE. The framework-free client core of ADR-0004, cut down to what the hooks need:
// one shared EventSource for all hooks, Channel-set changes coalesced on one tick, `lastEventId` owned here,
// `ready` / `caught-up` / `reset` / `reconnect` / `heartbeat` handled here, non-200 backoff, watchdog.
//
// The one rule this prototype adds: a hook that subscribes WITH a Cursor makes the Connection (re)open from that
// Cursor. The server replays strictly after it, so the hook's initial data + replay is gap-free; other hooks on the
// same Connection may see a few duplicates, which the App's reducers must absorb anyway (ADR-0001).
export type Status = 'connecting' | 'replaying' | 'live' | 'reconnecting' | 'refused'
export type Phase = 'replay' | 'live'

export interface Subscription {
  channel: string
  cursor?: string
  onMessage(event: string, payload: unknown, phase: Phase): void
  onStatus(status: Status): void
  onReset(): void
}

interface Sub extends Subscription {
  liveOnly: boolean
  status?: Status
}

export class Core {
  private subs = new Set<Sub>()
  private es?: EventSource
  private lastEventId?: string
  private pendingCursor?: string
  private scheduled = false
  private attempt = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  private watchdog?: ReturnType<typeof setTimeout>
  private heartbeat = 15_000
  private phase: Phase = 'replay'
  private openChannels = new Set<string>()
  readonly events: { at: number; line: string }[] = []
  private listeners = new Set<() => void>()

  constructor(private url: string) {}

  subscribe(subscription: Subscription): () => void {
    const sub: Sub = { ...subscription, liveOnly: !subscription.cursor }
    this.subs.add(sub)
    if (subscription.cursor) this.pendingCursor = subscription.cursor
    this.setStatus(sub, this.es && this.openChannels.has(sub.channel) && !subscription.cursor ? (this.phase === 'live' ? 'live' : 'replaying') : 'connecting')
    this.schedule()
    return () => {
      this.subs.delete(sub)
      this.schedule()
    }
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  get snapshot() {
    return { lastEventId: this.lastEventId, phase: this.phase, channels: [...this.openChannels], attempt: this.attempt, events: this.events }
  }

  private trace(line: string) {
    this.events.unshift({ at: Date.now(), line })
    if (this.events.length > 40) this.events.pop()
    for (const l of this.listeners) l()
  }

  private schedule() {
    if (this.scheduled) return
    this.scheduled = true
    setTimeout(() => {
      this.scheduled = false
      this.reconnect()
    }, 0)
  }

  private wanted() {
    return new Set([...this.subs].map((s) => s.channel))
  }

  private reconnect() {
    const wanted = this.wanted()
    const same = wanted.size === this.openChannels.size && [...wanted].every((c) => this.openChannels.has(c))
    if (this.es && same && !this.pendingCursor) return
    this.closeSource()
    if (wanted.size === 0) {
      this.openChannels = new Set()
      this.trace('idle: no subscriptions')
      return
    }
    const cursor = this.pendingCursor ?? this.lastEventId
    this.pendingCursor = undefined
    this.open(wanted, cursor)
  }

  private closeSource() {
    clearTimeout(this.retryTimer)
    clearTimeout(this.watchdog)
    this.es?.close()
    this.es = undefined
  }

  private open(channels: Set<string>, cursor: string | undefined) {
    this.openChannels = channels
    this.phase = 'replay'
    const params = new URLSearchParams()
    for (const c of channels) params.append('channel', c)
    if (cursor) params.set('cursor', cursor)
    this.trace(`open ${[...channels].join(',')} ${cursor ? `from ${cursor}` : 'live-only'}`)
    for (const s of this.subs) this.setStatus(s, s.status === 'refused' ? 'refused' : this.attempt ? 'reconnecting' : 'connecting')
    const es = (this.es = new EventSource(`${this.url}?${params}`))

    es.addEventListener('ready', (e) => {
      const ready = JSON.parse(e.data) as { cursor: string | null; heartbeat: number; refused: string[] }
      this.attempt = 0
      this.phase = 'replay'
      this.heartbeat = ready.heartbeat
      if (ready.cursor) this.lastEventId = ready.cursor
      this.trace(`ready cursor=${ready.cursor} refused=[${ready.refused.join(',')}]`)
      const refused = new Set(ready.refused)
      for (const s of this.subs) this.setStatus(s, refused.has(s.channel) ? 'refused' : 'replaying')
      if (ready.cursor === null) { this.closeSource(); return }
      this.touch()
    })
    es.onmessage = (e) => {
      this.lastEventId = e.lastEventId
      const { channel, event, payload } = JSON.parse(e.data) as { channel: string; event: string; payload: unknown }
      this.trace(`${this.phase} ${channel} ${event} id=${e.lastEventId}`)
      for (const s of this.subs) {
        if (s.channel !== channel) continue
        if (this.phase === 'replay' && s.liveOnly) continue
        s.onMessage(event, payload, this.phase)
      }
      this.touch()
    }
    es.addEventListener('caught-up', () => {
      this.phase = 'live'
      this.trace('caught-up')
      for (const s of this.subs) {
        s.liveOnly = false
        if (s.status !== 'refused') this.setStatus(s, 'live')
      }
      this.touch()
    })
    es.addEventListener('reset', () => {
      this.trace('reset: Cursor gone, App must refetch')
      for (const s of this.subs) if (!s.liveOnly) s.onReset()
    })
    es.addEventListener('reconnect', () => {
      this.trace('reconnect requested by server')
      this.closeSource()
      this.open(this.wanted(), this.lastEventId)
    })
    es.addEventListener('heartbeat', () => this.touch())
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        // non-200 or the server ended the stream without `reconnect`: the core owns this retry
        this.closeSource()
        const delay = Math.random() * Math.min(30_000, 1000 * 2 ** this.attempt++)
        this.trace(`error: closed, retry in ${Math.round(delay)}ms`)
        for (const s of this.subs) if (s.status !== 'refused') this.setStatus(s, 'reconnecting')
        this.retryTimer = setTimeout(() => this.open(this.wanted(), this.lastEventId), delay)
      } else {
        this.trace('error: dropped, native reconnect with Last-Event-ID')
        for (const s of this.subs) if (s.status !== 'refused') this.setStatus(s, 'reconnecting')
      }
    }
  }

  private touch() {
    clearTimeout(this.watchdog)
    this.watchdog = setTimeout(() => {
      this.trace('watchdog: no bytes for 3 heartbeats, reconnecting')
      this.closeSource()
      this.open(this.wanted(), this.lastEventId)
    }, this.heartbeat * 3)
  }

  private setStatus(sub: Sub, status: Status) {
    if (sub.status === status) return
    sub.status = status
    sub.onStatus(status)
  }
}
