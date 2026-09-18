// The one place the app talks to the network.
//
// Replaces both of the old Supabase clients - content.js and sidepanel.js each
// built their own and kept separate copies of the room, which is where most of the
// old flakiness lived. Now the panel owns the connection and the content script
// just reports which market is on screen.

import { KIND_MESSAGE, MODERATOR_PUBKEYS, SPAM_POLICY, SYNC, resolveRelays, roomTag } from './config.js'
import { buildMessageEvent, isWellFormedMessage, toChatMessage } from './event.js'
import { RelayPool } from './pool.js'
import { defaultStore } from './store.js'
import {
  applyRateLimit,
  checkTradingActivity,
  fetchBlocklist,
  fetchBindings,
  passesLocalChecks,
} from './moderation.js'

const EMIT_DEBOUNCE_MS = 150

export class HyperchatClient {
  constructor({
    relays = resolveRelays(),
    policy = SPAM_POLICY,
    moderators = MODERATOR_PUBKEYS,
    store = defaultStore,
  } = {}) {
    this.pool = new RelayPool(relays)
    this.store = store
    this.policy = policy
    this.moderators = moderators

    this.identity = null
    this.room = null
    this.subId = null

    // pubkey -> { address, allowed }. Decided once, reused every paint.
    this.authorStatus = new Map()
    this.blocked = new Set()

    this.events = new Map()
    this.messages = []

    this.messageListeners = new Set()
    this.statusListeners = new Set()

    this.emitTimer = null
    this.repairTimer = null

    this.pool.onStatusChange((status) => this.emitStatus(status))
  }

  start() {
    this.pool.connect()
    fetchBlocklist(this.pool, this.moderators)
      .then((blocked) => {
        this.blocked = blocked
        if (blocked.size > 0) this.rebuild()
      })
      .catch(() => {
        /* no block list is not an error */
      })
  }

  setIdentity(identity) {
    this.identity = identity
  }

  publishBinding(bindingEvent) {
    if (!bindingEvent) return Promise.resolve(null)
    return this.pool.publish(bindingEvent)
  }

  onMessages(listener) {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onStatus(listener) {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  emitStatus(status) {
    const payload = status || { connected: this.pool.connectedRelays(), total: this.pool.urls.length }
    for (const listener of this.statusListeners) {
      try {
        listener(payload)
      } catch {
        /* a broken listener must not take the client down */
      }
    }
  }

  async joinRoom(pair, market) {
    const tag = roomTag(pair, market)
    if (this.room?.tag === tag) return

    if (this.subId) {
      this.pool.unsubscribe(this.subId)
      this.subId = null
    }
    if (this.repairTimer) {
      clearTimeout(this.repairTimer)
      this.repairTimer = null
    }

    const since = Math.floor(Date.now() / 1000) - SYNC.historyWindowSec
    this.room = { tag, pair, market, since }
    this.events = new Map()
    this.messages = []

    // Paint from the local copy first, so switching markets is instant and a
    // reopened room is readable before a single relay has answered.
    const cached = await this.store.getEvents(tag, { limit: SYNC.historyLimit, since })
    for (const event of cached) this.events.set(event.id, event)
    await this.rebuild()

    this.subId = `room:${tag}`
    const subscription = this.pool.subscribe(
      this.subId,
      [{ kinds: [KIND_MESSAGE], '#d': [tag], limit: SYNC.historyLimit, since }],
      {
        onEvent: (event) => this.ingest(event),
        onEose: (_url, done, total) => {
          if (total > 0 && done >= total) this.scheduleRepair(subscription)
        },
      },
    )

    // Relays that never send EOSE should not block the repair pass forever.
    this.repairTimer = setTimeout(() => this.scheduleRepair(subscription), SYNC.repairDelayMs * 4)
  }

  async ingest(event) {
    if (!this.room) return
    if (this.events.has(event.id)) return
    if (!isWellFormedMessage(event, this.room.tag)) return

    const local = passesLocalChecks(event, { policy: this.policy, blocked: this.blocked })
    if (!local.ok) return

    this.events.set(event.id, event)

    // Store what survived signature and proof-of-work checks. This is the copy we
    // hand back to relays that have lost it - so it must be verified, not merely
    // received.
    await this.store.putEvents(this.room.tag, [event])

    this.scheduleEmit()
  }

  scheduleEmit() {
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.rebuild().catch(() => {
        /* a failed rebuild leaves the previous render in place */
      })
    }, EMIT_DEBOUNCE_MS)
  }

  // Resolve who everyone is, drop whoever does not qualify, and hand the panel a
  // plain sorted list. Author decisions are cached, so this is cheap after the
  // first pass over a room.
  async rebuild() {
    if (!this.room) return

    const events = [...this.events.values()].sort((a, b) => a.created_at - b.created_at)
    const unknownAuthors = events
      .map((event) => event.pubkey)
      .filter((pubkey) => !this.authorStatus.has(pubkey))

    if (unknownAuthors.length > 0) {
      const bindings = await fetchBindings(this.pool, unknownAuthors, { store: this.store })

      await Promise.all(
        [...new Set(unknownAuthors)].map(async (pubkey) => {
          const address = bindings.get(pubkey) || null
          if (!address) {
            this.authorStatus.set(pubkey, { address: null, allowed: false })
            return
          }
          const activity = await checkTradingActivity(address, { policy: this.policy })
          this.authorStatus.set(pubkey, { address, allowed: activity.ok })
        }),
      )
    }

    const visible = []
    for (const event of events) {
      const status = this.authorStatus.get(event.pubkey)
      if (!status?.allowed) continue
      visible.push(toChatMessage(event, status.address, this.room.pair, this.room.market))
    }

    this.messages = applyRateLimit(visible, this.policy.maxMessagesPerMinute)

    for (const listener of this.messageListeners) {
      try {
        listener(this.messages)
      } catch {
        /* a broken listener must not take the client down */
      }
    }
  }

  // The repair pass: give every relay back the part of the room it is missing.
  // This is how a pruned or wiped room heals from whoever walks in next, and it is
  // the only thing a browser can meaningfully contribute to the network.
  scheduleRepair(subscription) {
    if (!SYNC.repairEnabled || !this.room) return
    if (this.repairTimer) {
      clearTimeout(this.repairTimer)
      this.repairTimer = null
    }

    this.repairTimer = setTimeout(() => {
      this.repairTimer = null
      this.repair(subscription).catch(() => {
        /* repair is best effort by definition */
      })
    }, SYNC.repairDelayMs)
  }

  async repair(subscription) {
    if (!this.room || !subscription) return

    const room = this.room
    const held = await this.store.getEvents(room.tag, { limit: SYNC.localCapPerRoom, since: room.since })
    if (held.length === 0) return

    for (const url of this.pool.connectedRelays()) {
      const theirs = subscription.receivedByRelay.get(url) || new Set()
      const missing = held.filter((event) => !theirs.has(event.id))
      if (missing.length === 0) continue

      const batch = missing.slice(-SYNC.repairMaxEventsPerRelay)
      for (const event of batch) {
        if (this.room?.tag !== room.tag) return
        this.pool.publishTo(url, event)
        await new Promise((resolve) => setTimeout(resolve, 1000 / SYNC.repairRatePerSec))
      }
    }
  }

  async send(content, name) {
    if (!this.identity) throw new Error('Sign in to send messages')
    if (!this.room) throw new Error('No room selected')

    const { event, minedDifficulty, requestedDifficulty } = await buildMessageEvent({
      secretKey: this.identity.secretKey,
      pair: this.room.pair,
      market: this.room.market,
      content,
      name,
      difficulty: this.policy.powDifficulty,
    })

    // Our own author status is known without asking the network.
    this.authorStatus.set(event.pubkey, { address: this.identity.address, allowed: true })

    this.events.set(event.id, event)
    await this.store.putEvents(this.room.tag, [event])
    await this.rebuild()

    const result = await this.pool.publish(event)

    return {
      event,
      ...result,
      underpowered: requestedDifficulty > 0 && minedDifficulty < requestedDifficulty,
    }
  }

  close() {
    if (this.emitTimer) clearTimeout(this.emitTimer)
    if (this.repairTimer) clearTimeout(this.repairTimer)
    this.pool.close()
    this.messageListeners.clear()
    this.statusListeners.clear()
  }
}
