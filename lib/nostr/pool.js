// Talking to several relays at once.
//
// Every relay in the list is used simultaneously - this is not a failover chain.
// A room stays alive as long as any single one of them answers, and because event
// ids are content hashes, the same message arriving from four relays is trivially
// deduplicated instead of being four messages.

import { SYNC } from './config.js'

const OPEN = 1

class RelayConnection {
  constructor(url, handlers) {
    this.url = url
    this.handlers = handlers
    this.socket = null
    this.status = 'closed'
    this.attempts = 0
    this.closedByUs = false
    this.reconnectTimer = null
    this.idleTimer = null
    this.probeTimer = null
    this.probeId = null
  }

  get connected() {
    return this.socket && this.socket.readyState === OPEN
  }

  connect() {
    if (this.connected || this.status === 'connecting') return
    this.closedByUs = false
    this.status = 'connecting'

    let socket
    try {
      socket = new WebSocket(this.url)
    } catch (error) {
      this.status = 'closed'
      this.scheduleReconnect()
      return
    }

    this.socket = socket

    socket.onopen = () => {
      this.status = 'open'
      this.attempts = 0
      this.touch()
      this.handlers.onOpen?.(this.url)
    }

    socket.onmessage = (raw) => {
      this.touch()
      let message
      try {
        message = JSON.parse(raw.data)
      } catch {
        return
      }
      if (Array.isArray(message)) this.handlers.onMessage?.(this.url, message)
    }

    socket.onerror = () => {
      // onclose always follows; reconnect is handled there.
    }

    socket.onclose = () => {
      this.status = 'closed'
      this.clearIdle()
      if (this.probeTimer) clearTimeout(this.probeTimer)
      this.probeTimer = null
      this.probeId = null
      this.handlers.onClose?.(this.url)
      if (!this.closedByUs) this.scheduleReconnect()
    }
  }

  // Any inbound frame proves the socket is alive and resets the clock.
  touch() {
    this.clearIdle()
    this.clearProbe()
    this.idleTimer = setTimeout(() => this.probeLiveness(), SYNC.idleTimeoutMs)
  }

  // Silence is not death: a relay with nothing new to say in a quiet room is
  // behaving correctly. Closing on silence alone reaped healthy connections every
  // couple of minutes and made the relay count flap. So ask a question the relay
  // must answer, and only hang up if it does not.
  probeLiveness() {
    if (!this.connected) return

    this.probeId = `ping:${Math.random().toString(36).slice(2, 10)}`
    // Matches nothing, so the relay replies EOSE immediately and sends no events.
    this.send(['REQ', this.probeId, { kinds: [0], authors: ['0'.repeat(64)], limit: 0 }])

    this.probeTimer = setTimeout(() => {
      // No answer to a question every relay answers: the socket is half open.
      try {
        this.socket?.close()
      } catch {
        /* already gone */
      }
    }, SYNC.livenessTimeoutMs)
  }

  clearIdle() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  clearProbe() {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer)
      this.probeTimer = null
    }
    if (this.probeId) {
      this.send(['CLOSE', this.probeId])
      this.probeId = null
    }
  }

  scheduleReconnect() {
    if (this.closedByUs || this.reconnectTimer) return

    this.attempts++
    const backoff = Math.min(SYNC.reconnectBaseMs * 2 ** (this.attempts - 1), SYNC.reconnectMaxMs)
    // Jitter, so four relays dropped by one flaky wifi moment do not all come
    // back in lockstep.
    const delay = backoff * (0.5 + Math.random() * 0.5)

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  send(message) {
    if (!this.connected) return false
    try {
      this.socket.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  close() {
    this.closedByUs = true
    this.clearIdle()
    if (this.probeTimer) clearTimeout(this.probeTimer)
    this.probeTimer = null
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try {
      this.socket?.close()
    } catch {
      /* already gone */
    }
    this.status = 'closed'
  }
}

export class RelayPool {
  constructor(urls) {
    this.urls = [...urls]
    this.connections = new Map()
    this.subscriptions = new Map()
    this.pendingPublishes = new Map()
    this.outbox = []
    this.statusListeners = new Set()
  }

  connect() {
    for (const url of this.urls) {
      if (this.connections.has(url)) continue

      const connection = new RelayConnection(url, {
        onOpen: (relayUrl) => {
          // Replay every live subscription onto a relay that just arrived, and
          // push anything that was written while we had nowhere to send it.
          for (const [id, sub] of this.subscriptions) {
            this.connections.get(relayUrl)?.send(['REQ', id, ...sub.filters])
          }
          this.flushOutbox()
          this.emitStatus()
        },
        onClose: () => this.emitStatus(),
        onMessage: (relayUrl, message) => this.handleMessage(relayUrl, message),
      })

      this.connections.set(url, connection)
      connection.connect()
    }
  }

  handleMessage(url, message) {
    const [type] = message

    if (type === 'EVENT') {
      const [, subId, event] = message
      const sub = this.subscriptions.get(subId)
      if (!sub || !event?.id) return

      let seen = sub.receivedByRelay.get(url)
      if (!seen) {
        seen = new Set()
        sub.receivedByRelay.set(url, seen)
      }
      seen.add(event.id)

      sub.onEvent?.(event, url)
      return
    }

    if (type === 'EOSE') {
      const [, subId] = message
      const sub = this.subscriptions.get(subId)
      if (!sub) return

      sub.eosed.add(url)
      sub.onEose?.(url, sub.eosed.size, this.connectedCount())
      return
    }

    if (type === 'OK') {
      const [, eventId, accepted, detail] = message
      const pending = this.pendingPublishes.get(eventId)
      if (!pending) return

      if (accepted) pending.accepted.add(url)
      else pending.rejected.set(url, detail || 'rejected')

      pending.settle()
      return
    }

    if (type === 'CLOSED') {
      const [, subId, detail] = message
      const sub = this.subscriptions.get(subId)
      // Treat a relay refusing a subscription as end-of-stream for that relay
      // rather than hanging the room waiting on an EOSE that will never come.
      if (sub) {
        sub.eosed.add(url)
        sub.onEose?.(url, sub.eosed.size, this.connectedCount())
        sub.onClosed?.(url, detail)
      }
    }
  }

  subscribe(id, filters, { onEvent, onEose, onClosed } = {}) {
    const sub = {
      filters,
      onEvent,
      onEose,
      onClosed,
      eosed: new Set(),
      receivedByRelay: new Map(),
    }
    this.subscriptions.set(id, sub)

    for (const connection of this.connections.values()) {
      connection.send(['REQ', id, ...filters])
    }

    return sub
  }

  unsubscribe(id) {
    if (!this.subscriptions.has(id)) return
    this.subscriptions.delete(id)
    for (const connection of this.connections.values()) {
      connection.send(['CLOSE', id])
    }
  }

  // Resolves once every connected relay has answered, or on a timeout. One
  // acceptance anywhere is a successful send: the repair pass gets the message to
  // the rest later.
  publish(event, { timeoutMs = 8000 } = {}) {
    const targets = [...this.connections.values()].filter((connection) => connection.connected)

    if (targets.length === 0) {
      this.outbox.push(event)
      return Promise.resolve({ accepted: [], rejected: [], queued: true })
    }

    return new Promise((resolve) => {
      const pending = {
        accepted: new Set(),
        rejected: new Map(),
        expected: targets.length,
        done: false,
        settle: () => {
          if (pending.done) return
          if (pending.accepted.size + pending.rejected.size < pending.expected) return
          finish()
        },
      }

      const finish = () => {
        if (pending.done) return
        pending.done = true
        clearTimeout(timer)
        this.pendingPublishes.delete(event.id)
        resolve({
          accepted: [...pending.accepted],
          rejected: [...pending.rejected.entries()].map(([url, reason]) => ({ url, reason })),
          queued: false,
        })
      }

      const timer = setTimeout(finish, timeoutMs)
      this.pendingPublishes.set(event.id, pending)

      for (const connection of targets) {
        connection.send(['EVENT', event])
      }
    })
  }

  // Fire-and-forget, used by the repair pass where we do not care about the reply.
  publishTo(url, event) {
    return this.connections.get(url)?.send(['EVENT', event]) || false
  }

  flushOutbox() {
    if (this.outbox.length === 0) return
    const queued = this.outbox.splice(0, this.outbox.length)
    for (const event of queued) this.publish(event)
  }

  connectedRelays() {
    return [...this.connections.entries()]
      .filter(([, connection]) => connection.connected)
      .map(([url]) => url)
  }

  connectedCount() {
    return this.connectedRelays().length
  }

  onStatusChange(listener) {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  emitStatus() {
    const status = { connected: this.connectedRelays(), total: this.urls.length }
    for (const listener of this.statusListeners) {
      try {
        listener(status)
      } catch {
        /* a broken listener must not take the pool down */
      }
    }
  }

  close() {
    for (const connection of this.connections.values()) connection.close()
    this.connections.clear()
    this.subscriptions.clear()
    this.pendingPublishes.clear()
  }
}
