// A minimal in-process nostr relay: enough of NIP-01 to exercise the real client
// against real sockets, without publishing test traffic to strangers' servers.

const { WebSocketServer } = require('ws')

function matchesFilter(event, filter) {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false
  if (filter.ids && !filter.ids.includes(event.id)) return false
  if (filter.since && event.created_at < filter.since) return false
  if (filter.until && event.created_at > filter.until) return false

  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#')) continue
    const tagName = key.slice(1)
    const tagValues = (event.tags || []).filter((tag) => tag[0] === tagName).map((tag) => tag[1])
    if (!tagValues.some((value) => values.includes(value))) return false
  }

  return true
}

class MockRelay {
  constructor() {
    this.events = new Map()
    this.subscriptions = new Map()
    this.rejectAll = false
    this.server = null
    this.port = null
  }

  async start() {
    this.server = new WebSocketServer({ port: 0 })
    await new Promise((resolve) => this.server.once('listening', resolve))
    this.port = this.server.address().port

    this.server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        let message
        try {
          message = JSON.parse(raw.toString())
        } catch {
          return
        }
        this.handle(socket, message)
      })
    })

    return this.url
  }

  get url() {
    return `ws://127.0.0.1:${this.port}`
  }

  handle(socket, [type, ...rest]) {
    if (type === 'EVENT') {
      const [event] = rest

      if (this.rejectAll) {
        socket.send(JSON.stringify(['OK', event.id, false, 'blocked: test relay rejects everything']))
        return
      }

      const isNew = !this.events.has(event.id)
      // Replaceable range: keep only the newest per author+kind.
      if (event.kind >= 10000 && event.kind < 20000) {
        for (const [id, stored] of this.events) {
          if (stored.kind === event.kind && stored.pubkey === event.pubkey) this.events.delete(id)
        }
      }
      this.events.set(event.id, event)
      socket.send(JSON.stringify(['OK', event.id, true, '']))

      if (isNew) {
        for (const [subId, { socket: subSocket, filters }] of this.subscriptions) {
          if (subSocket !== socket && filters.some((filter) => matchesFilter(event, filter))) {
            subSocket.send(JSON.stringify(['EVENT', subId, event]))
          }
        }
      }
      return
    }

    if (type === 'REQ') {
      const [subId, ...filters] = rest
      this.subscriptions.set(subId, { socket, filters })

      const matched = [...this.events.values()]
        .filter((event) => filters.some((filter) => matchesFilter(event, filter)))
        .sort((a, b) => a.created_at - b.created_at)

      for (const event of matched) {
        socket.send(JSON.stringify(['EVENT', subId, event]))
      }
      socket.send(JSON.stringify(['EOSE', subId]))
      return
    }

    if (type === 'CLOSE') {
      this.subscriptions.delete(rest[0])
    }
  }

  wipe() {
    this.events.clear()
  }

  storedIds() {
    return new Set(this.events.keys())
  }

  async stop() {
    for (const client of this.server.clients) client.terminate()
    await new Promise((resolve) => this.server.close(resolve))
  }
}

module.exports = { MockRelay }
